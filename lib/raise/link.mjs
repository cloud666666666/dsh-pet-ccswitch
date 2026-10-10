/**
 * link.mjs —— 工作联动：把「你实际的开发状态」接进宠物的属性
 *
 * 让桌宠从"会掉属性的挂件"变成一块**工作状态的可视化**。两个传感器，各自独立开关：
 *
 *   git  → 清洁：工作区有未提交改动 = 脏（改动越多越脏）；提交了 = 洗干净了（还涨心情）
 *   错误 → 心情：CC Switch 日志里最近这段时间的请求错误率（4xx/5xx 越多心情越差）
 *
 * 为什么是这两个：
 *   - 它们都不用额外配置就能拿到真实信号（git 到处都有；错误率就在 CC Switch 的库里）
 *   - 隐喻也对得上：**提交 = 洗澡**，**请求报错 = 心情不好**，看一眼宠物就知道状态
 *
 * 采样是异步的、按间隔跑的（默认 5 分钟），属性变化走 st.setInfo（也就是正常落盘），
 * 说话走同一条气泡通道（有环境级节流，不会刷屏）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withDb } from '../ccswitch.mjs';

const pExec = promisify(execFile);
const gitOf = async (repo, args) =>
  (await pExec('git', ['-C', repo, ...args], { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 })).stdout.trim();

/**
 * 把一个路径解析成仓库列表：
 *   - 它的子目录里有仓库 → 用那些子仓库（父目录往往只是个"壳"：比如 D:\Project 自己也是
 *     一个 git 仓库，但 status 里全是子项目目录，那是噪声不是信号）
 *   - 子目录里没有、它自己是仓库 → 用它自己
 *   - 都没有 → 空（当没配）
 */
export function findRepos(root) {
  if (!root || !fs.existsSync(root)) return [];
  const isRepo = (p) => fs.existsSync(path.join(p, '.git'));
  const subs = [];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(root, e.name);
      if (isRepo(p)) subs.push(p);
      if (subs.length >= 20) break;
    }
  } catch {
    /* 目录读不动就当没有子仓库 */
  }
  if (subs.length) return subs;
  return isRepo(root) ? [root] : [];
}

/** 每个仓库：有多少个未提交改动、HEAD 是哪个提交 */
export async function gitSample(repos) {
  const rows = [];
  for (const repo of repos) {
    const name = path.basename(repo);
    try {
      const porcelain = await gitOf(repo, ['status', '--porcelain']);
      const lines = porcelain ? porcelain.split('\n').filter(Boolean) : [];
      const head = await gitOf(repo, ['rev-parse', 'HEAD']).catch(() => '');
      rows.push({ repo, name, dirty: lines.length, files: lines.slice(0, 5).map((l) => l.slice(3)), head });
    } catch (e) {
      rows.push({ repo, name, error: e.message.split('\n')[0] });
    }
  }
  return rows;
}

/** CC Switch 库里最近 windowMin 分钟的请求数与错误数 */
export async function errorSample(windowMin) {
  const lo = Math.floor(Date.now() / 1000) - windowMin * 60;
  return withDb((db) =>
    db
      .prepare(
        'SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) bad FROM proxy_request_logs WHERE created_at >= ?',
      )
      .get(lo),
  );
}

/**
 * git 那一路的纯计算：给定"这次采样"和"上次的 HEAD"，算出该加/减多少、要不要说话。
 * 抽成纯函数是为了能单测（applyGit 只负责把它写进属性里）。
 */
export function gitEffect(rows, heads) {
  const dirtyTotal = rows.reduce((n, r) => n + (r.dirty || 0), 0);
  const committed = rows.filter((r) => r.head && heads[r.repo] && heads[r.repo] !== r.head).map((r) => r.name);
  if (committed.length) return { clean: +15, mood: +5, committed, dirtyTotal, say: `${committed.join('、')} 提交了，一身轻松~` };
  if (dirtyTotal > 0) {
    const drop = Math.min(dirtyTotal, 10) * 2; // 每 5 分钟最多掉 20 点：比自然衰减快，但不会一瞬间掉光
    const which = rows.filter((r) => r.dirty).map((r) => `${r.name} ${r.dirty} 处`).join('、');
    return { clean: -drop, mood: 0, committed: [], dirtyTotal, say: `工作区还有改动没提交（${which}），我身上也跟着脏兮兮的…` };
  }
  // 干净：每 5 分钟回 10 点（约 2/分钟）—— 刚好抵掉一半的自然变脏速度。
  // 故意不设成"完全不掉"：不然洗澡/清洁用品这套就白做了；现在工作区干净能让它脏得慢一半
  return { clean: +10, mood: 0, committed: [], dirtyTotal: 0, say: '' };
}

/**
 * 错误率那一路的纯计算：4xx/5xx 占比越高心情掉得越多；样本太少就不折腾。
 * `worry` 为真时值得说一句（占比 ≥ 15%）。
 */
export function errorEffect({ n, bad }) {
  const total = Number(n) || 0;
  const errs = Number(bad) || 0;
  if (total < 5) return { mood: 0, worry: false, p: 0, skip: true };
  if (errs === 0) return { mood: +3, worry: false, p: 0 };
  const p = errs / total;
  return {
    mood: -Math.min(Math.round(p * 60), 20),
    worry: p >= 0.15,
    p,
    say: `刚才有 ${errs} 次请求出错了（一共 ${total} 次），我有点担心…`,
  };
}

/**
 * @param {object} o
 * @param {object} o.st        Raise 实例
 * @param {string} o.repo      仓库路径或"放着项目的目录"
 * @param {boolean} o.git      开不开 git 传感器
 * @param {boolean} o.errors   开不开错误率传感器
 * @param {number} o.everyMs   采样间隔（默认 5 分钟）
 */
export function createLink({ st, log = console.log, repo = '', git = true, errors = true, everyMs = 300_000 } = {}) {
  const repos = git && repo ? findRepos(repo) : [];
  const on = repos.length > 0 || errors;
  /** 采样结果挂在实例上，菜单/状态里要显示 */
  st.linkState = { repos: repos.map((r) => path.basename(r)), git: null, errors: null, at: 0 };
  /** 上一次的 HEAD，用来认"刚提交了" */
  let heads = {};
  let timer = null;

  function applyGit(rows) {
    const eff = gitEffect(rows, heads);
    heads = Object.fromEntries(rows.map((r) => [r.repo, r.head]));
    if (eff.clean) st.setInfo('clean', Math.min(Math.max(st.info.clean + eff.clean, 0), st.meta.cleanMax));
    if (eff.mood) st.setInfo('mood', Math.min(Math.max(st.info.mood + eff.mood, 0), st.meta.moodMax));
    if (eff.say) st.say(eff.say, eff.clean > 0 ? 'clean' : 'sad');
  }

  function applyErrors(sample) {
    const eff = errorEffect(sample);
    if (eff.skip) return;
    if (eff.mood) st.setInfo('mood', Math.min(Math.max(st.info.mood + eff.mood, 0), st.meta.moodMax));
    if (eff.worry) st.say(eff.say, 'sad');
  }

  /** 采一次；`quiet` 时只更新状态不改变属性（启动那一次用） */
  async function sample({ apply = true } = {}) {
    const state = { repos: repos.map((r) => path.basename(r)), git: null, errors: null, at: Date.now() };
    if (repos.length) {
      try {
        state.git = await gitSample(repos);
        if (apply) applyGit(state.git);
      } catch (e) {
        log('[raise] 看工作区失败：' + e.message);
      }
    }
    if (errors) {
      try {
        state.errors = await errorSample(60);
        if (apply) applyErrors(state.errors);
      } catch (e) {
        log('[raise] 看请求错误率失败：' + e.message);
      }
    }
    // 第一次采样只记基线（不因为"当前的脏/错"立刻扣属性、也不报"提交了"）
    if (!apply && state.git) heads = Object.fromEntries(state.git.map((r) => [r.repo, r.head]));
    st.linkState = state;
    return state;
  }

  return {
    on,
    repoCount: repos.length,
    sample,
    start() {
      if (!on || timer) return;
      void sample({ apply: false });
      timer = setInterval(() => void sample(), Math.max(30_000, everyMs));
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 「工作区状态」那一项要说的话：多行（桌宠那边会逐行渲染成气泡） */
    text() {
      const s = st.linkState;
      if (!s?.git?.length) {
        const err = s?.git?.find((r) => r.error);
        return err ? `看工作区失败了：${err.error}` : '还没接工作区（`raise config linkRepo=<仓库路径>` 就能接上）';
      }
      const rows = s.git.filter((r) => !r.error);
      const dirty = rows.filter((r) => r.dirty).sort((a, b) => b.dirty - a.dirty);
      const total = dirty.reduce((n, r) => n + r.dirty, 0);
      if (!dirty.length) return `工作区全干净（${rows.length} 个仓库），跟刚洗过澡一样~`;
      const lines = [`工作区 ${total} 处未提交（${dirty.length}/${rows.length} 个仓库脏着）`];
      for (const r of dirty.slice(0, 4)) lines.push(`· ${r.name} ${r.dirty} 处`);
      if (dirty.length > 4) lines.push(`· 还有 ${dirty.length - 4} 个仓库也有改动`);
      lines.push('把改动提交了，我就干干净净啦');
      return lines.join('\n');
    },
    /** 状态气泡上加的那一行（短，能塞进一行就行） */
    line() {
      const s = st.linkState?.git;
      if (!s?.length) return null;
      const dirty = s.filter((r) => r.dirty);
      if (!dirty.length) return null;
      const total = dirty.reduce((n, r) => n + r.dirty, 0);
      return dirty.length === 1
        ? `工作区 ${dirty[0].name} ${dirty[0].dirty} 处未提交`
        : `工作区 ${total} 处未提交（${dirty.length} 个仓库）`;
    },
  };
}
