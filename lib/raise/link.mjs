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
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withDb } from '../ccswitch.mjs';
import { bump } from './achv.mjs';

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
 *
 * 注意 `committed` 是**仓库名**（一个采样窗口里 HEAD 变了就算），提交条数另外用
 * `commitCounts` 给（见 countCommits：用 rev-list 数真实提交，checkout/reset 那种不算）。
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
 * 数"这两个 HEAD 之间真的产生了几个提交"。
 * 光看 HEAD 变了不够：checkout / reset / rebase 也会动 HEAD，而那些不该算"提交"。
 * `git rev-list --count old..new` 在"新 HEAD 能追到旧 HEAD"时给出真实条数；
 * 追不到（rebase/reset 这种）就退回 1 —— 反正你确实动过一次仓库。
 */
export async function countCommits(repo, oldHead, newHead) {
  if (!oldHead || !newHead || oldHead === newHead) return 0;
  try {
    const n = Number(await gitOf(repo, ['rev-list', '--count', `${oldHead}..${newHead}`]));
    return Number.isFinite(n) ? n : 1;
  } catch {
    return 1;
  }
}

/**
 * 「我的项目在哪」——**不问用户，自己找**。三条线索，按可信度排：
 *   1. 当前目录（在仓库里敲命令时最准）
 *   2. Claude Code 最近开过的项目（`~/.claude.json` 的 projects[].lastStartTime）
 *   3. Claude Code 的会话目录（`~/.claude/projects/<把路径里的 / 换成 ->` 的 mtime）
 * 每条都要求目标**是仓库、或者里面装着仓库**（findRepos 能扫出东西），否则跳过。
 * 返回 [{ dir, from, at }]，最可信的在前。
 */
/**
 * 会话目录名把路径里的 `/` 写成了 `-`，可目录名自己也可能带横杠（dsh-pet-ccswitch），
 * 光靠替换猜不回来。逐段贪心：这一段接上去存在就当分隔符，不存在就留着当名字的一部分。
 */
function resolveEncoded(head, rest) {
  const parts = rest.split('-');
  let acc = head;
  let buf = '';
  for (const seg of parts) {
    const next = buf ? `${buf}-${seg}` : seg;
    if (fs.existsSync(acc + next)) {
      acc = `${acc}${next}/`;
      buf = '';
    } else {
      buf = next;
    }
  }
  const full = (acc + buf).replace(/[\/]+$/, '');
  return fs.existsSync(full) ? full : null;
}

export function detectWorkspace({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const isRepo = (p) => fs.existsSync(path.join(p, '.git'));
  /** 它里面装着几个仓库（只数一层） */
  const countRepos = (p) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && isRepo(path.join(p, e.name))).length;
    } catch {
      return 0;
    }
  };
  /** 家目录与盘根不算工作区（有些人家目录本身就是个 dotfiles 仓库，盯着它跑 git status 又慢又没意义） */
  const norm = (p) => path.resolve(p).replace(/[\/]+$/, '').toLowerCase();
  const tooBroad = (p) => {
    const n = norm(p);
    return n === norm(home) || n === norm(path.parse(path.resolve(p)).root);
  };
  /**
   * 能不能当"工作区"：自己是仓库，**或者**里面装着两个以上仓库（像 D:\Project 那样）。
   * 要求两个是为了排掉误判：家目录里恰好有一个仓库子目录时不该被当成"我的项目目录"。
   */
  const usable = (p) => Boolean(p) && !tooBroad(p) && fs.existsSync(p) && (isRepo(p) || countRepos(p) >= 2);
  const out = [];

  // 1) 当前目录（往上找几层，命令常常敲在子目录里）
  let d = path.resolve(cwd);
  for (let i = 0; i < 6; i++) {
    if (isRepo(d) && !tooBroad(d)) {
      out.push({ dir: d, from: '当前目录' });
      break;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }

  // 2) Claude Code 最近开过的项目
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    const rows = Object.entries(j.projects ?? {})
      .map(([dir, v]) => ({ dir, at: Number(v?.lastStartTime) || 0 }))
      .filter((r) => r.at > 0)
      .sort((a, b) => b.at - a.at);
    for (const r of rows) if (usable(r.dir)) out.push({ dir: r.dir, from: 'Claude Code 最近的项目', at: r.at });
  } catch {
    /* 没有这个文件就算了 */
  }

  // 3) 会话目录的修改时间（路径编码在目录名里：d--Project-x → D:/Project/x）
  try {
    const root = path.join(home, '.claude', 'projects');
    const rows = fs
      .readdirSync(root)
      .map((n) => {
        const dir = path.join(root, n);
        // 目录本身的 mtime 只在"新建过会话"时才动，所以看里面最新那个会话文件
        let t = 0;
        try {
          for (const f of fs.readdirSync(dir)) t = Math.max(t, fs.statSync(path.join(dir, f)).mtimeMs);
        } catch {
          /* 读不动就用 0 */
        }
        return { n, t: t || fs.statSync(dir).mtimeMs };
      })
      .sort((a, b) => b.t - a.t);
    for (const r of rows) {
      const m = /^([a-zA-Z])--(.*)$/.exec(r.n);
      if (!m) continue;
      const hit = resolveEncoded(m[1].toUpperCase() + ':/', m[2]);
      if (hit && usable(hit)) out.push({ dir: hit.replace(/\//g, path.sep), from: 'Claude Code 会话目录', at: r.t });
    }
  } catch {
    /* 没有就算 */
  }

  // 去重（同一个目录可能被两条线索都找到，保留更可信的那条）
  const seen = new Set();
  return out.filter((c) => {
    const k = c.dir.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
  /** "全干净"这件事每次干净期间只记一次 */
  let tidyCounted = false;
  let timer = null;

  async function applyGit(rows) {
    const prevHeads = heads;
    const eff = gitEffect(rows, prevHeads);
    heads = Object.fromEntries(rows.map((r) => [r.repo, r.head]));
    if (eff.clean) st.setInfo('clean', Math.min(Math.max(st.info.clean + eff.clean, 0), st.meta.cleanMax));
    if (eff.mood) st.setInfo('mood', Math.min(Math.max(st.info.mood + eff.mood, 0), st.meta.moodMax));
    if (eff.say) st.say(eff.say, eff.clean > 0 ? 'clean' : 'sad');
    // 提交条数按**真实提交**数（HEAD 变了也可能是 checkout/reset，那些不算）
    let commits = 0;
    for (const r of rows) {
      if (!eff.committed.includes(r.name)) continue;
      commits += await countCommits(r.repo, prevHeads[r.repo], r.head);
    }
    if (commits) bump(st, 'commits', commits);
    // 「一尘不染」要求**每个**仓库都读成功且干净：有仓库读失败时它可能正脏着，不能算
    if (rows.length && rows.every((r) => !r.error) && !eff.dirtyTotal) {
      if (!tidyCounted) {
        tidyCounted = true;
        bump(st, 'tidy', 1);
      }
    } else {
      tidyCounted = false;
    }
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
        if (apply) await applyGit(state.git);
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
    /** 状态气泡上加的那一行（**必须短**：气泡一行只放得下 16 个汉字，长了会被窗口裁掉） */
    line() {
      const s = st.linkState?.git;
      if (!s?.length) return null;
      const dirty = s.filter((r) => r.dirty);
      if (!dirty.length) return null;
      const total = dirty.reduce((n, r) => n + r.dirty, 0);
      return dirty.length === 1 ? `工作区 ${dirty[0].name} ${dirty[0].dirty} 处未提交` : `工作区 ${total} 处未提交`;
    },
  };
}
