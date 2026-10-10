/**
 * achv.mjs —— 成就墙
 *
 * 一部分是 qqpet 本来就有的计数器（养鱼大师 yyds、逗逗我 ddw、旅游成就 travel_china_num），
 * 一部分是这个项目自己的玩法长出来的（token 累计、连续天数、提交次数、工作区全干净）。
 *
 * 奖励是元宝与心情（qqpet 的成就也是给东西）。解锁时会弹一句气泡 + 记进存档。
 * 进度计数存在 `saveJsonData.achv` 里：{ unlocked: {id: 时间戳}, stats: {…} }。
 *
 * 检查很便宜（十几条比较），跟着每分钟结算跑一遍就够；跨天时再走一次连续天数统计。
 */
import { monthCount } from './signin.mjs';
import { human } from './engine.mjs';

/** 存档形状。解析失败不能让整分钟结算跟着崩（那块是每分钟都会走到的路径）；
 *  形状不对（比如 unlocked 是个字符串）也要挡下来 —— 后面会往它身上写字段 */
function load(st) {
  let j = {};
  try {
    j = JSON.parse(st.save.saveJsonData.achv || '{}');
  } catch (e) {
    console.warn('[raise] 成就数据坏了，这次当空的处理：' + e.message);
  }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const out = { unlocked: obj(j.unlocked), stats: obj(j.stats) };
  // 「走遍全国」看的是**累计去过多少个不同的地方**，不是当前记录里剩几个
  // （菜单里那个「完成旅游成就」会把 travel_china 清空，读数组长度的话进度会倒退回去）
  if (out.stats.cities === undefined) {
    const seen = Array.isArray(st.save.gameSaveDatas?.travel_china) ? st.save.gameSaveDatas.travel_china.length : 0;
    if (seen) out.stats.cities = seen;
  }
  return out;
}
const A = (st) => (st.achv ??= load(st));
const store = (st) => {
  st.save.saveJsonData.achv = JSON.stringify(A(st));
  st.markDirty();
};

/** 换新宠物时要把缓存丢掉（否则新蛋一出生成就墙就全亮了） */
export const forget = (st) => {
  st.achv = null;
};

export const statOf = (st, key) => Number(A(st).stats[key]) || 0;

/** 累加一个统计量（token、逗它次数、提交次数、收鱼条数…） */
export function bump(st, key, n = 1) {
  const a = A(st);
  a.stats[key] = (Number(a.stats[key]) || 0) + n;
  store(st);
}

/** 数字口语化就用引擎那一份（原来这里又抄了一份，两处小数位已经不一致了） */

/**
 * 成就表。`of` 是当前进度，`need` 是目标；`yb`/`mood` 是解锁奖励。
 * （`of` 里读的都是真状态，所以不会出现"改了存档进度倒退"这种事。）
 */
/** 原版只有 3 张徽章（resources/pet/achievement/*.svg），其余成就没有图 */
const BADGE = { fish1000: 'yyds', travel35: 'travel', amuse200: 'ddw' };

export const ACHIEVEMENTS = [
  { id: 'hatch', name: '破壳而出', desc: '领养一只宠物', need: 1, of: () => 1, yb: 100 },
  { id: 'kid', name: '上学啦', desc: '养到幼年期（5 级）', need: 5, of: (st) => st.meta.level, yb: 300 },
  { id: 'adult', name: '长大成人', desc: '养到成年期（16 级）', need: 16, of: (st) => st.meta.level, yb: 1000 },
  { id: 'rich', name: '万元户', desc: '攒到 10000 元宝', need: 10000, of: (st) => st.info.yb, mood: 100 },
  { id: 'tok1m', name: '一百万 token', desc: '累计消耗 100 万 token', need: 1e6, of: (st) => statOf(st, 'tokens'), yb: 100 },
  { id: 'tok100m', name: '一亿 token', desc: '累计消耗 1 亿 token', need: 1e8, of: (st) => statOf(st, 'tokens'), yb: 500 },
  { id: 'tok1b', name: '十亿 token', desc: '累计消耗 10 亿 token', need: 1e9, of: (st) => statOf(st, 'tokens'), yb: 2000 },
  { id: 'day1e8', name: '今天真能写', desc: '单日消耗 1 亿 token', need: 1e8, of: (st) => statOf(st, 'dayTokens'), yb: 800 },
  { id: 'streak7', name: '连写七天', desc: '连续 7 天有流量', need: 7, of: (st) => statOf(st, 'streak'), yb: 500 },
  { id: 'streak30', name: '铁人三十天', desc: '连续 30 天有流量', need: 30, of: (st) => statOf(st, 'streak'), yb: 3000 },
  { id: 'travel35', name: '走遍全国', desc: '累计去过 35 个不同的地方', need: 35, of: (st) => statOf(st, 'cities'), yb: 1500 },
  { id: 'fish1000', name: '养鱼大师', desc: '累计收成 1000 条鱼', need: 1000, of: (st) => statOf(st, 'fish'), yb: 1000 },
  { id: 'amuse200', name: '逗我两百下', desc: '累计逗它 200 次', need: 200, of: (st) => statOf(st, 'amuse'), yb: 300 },
  { id: 'commit100', name: '提交百次', desc: '工作联动里累计提交 100 次', need: 100, of: (st) => statOf(st, 'commits'), yb: 800 },
  { id: 'tidy', name: '一尘不染', desc: '所有仓库都干净的那一刻', need: 1, of: (st) => statOf(st, 'tidy'), yb: 200 },
  { id: 'signin20', name: '全勤签到', desc: '本月签到 20 天', need: 20, of: (st) => monthCount(st), yb: 500 },
  {
    id: 'school',
    name: '学有所成',
    desc: '某科目念到研究生',
    need: 168,
    of: (st) => Math.max(0, ...Object.values(st.save.studyInfo)),
    yb: 1200,
  },
];

export const isUnlocked = (st, id) => Boolean(A(st).unlocked[id]);

/** 全表带进度（菜单用） */
export const list = (st) =>
  ACHIEVEMENTS.map((a) => ({
    id: a.id,
    name: a.name,
    desc: a.desc,
    need: a.need,
    done: Math.min(a.of(st), a.need),
    unlocked: isUnlocked(st, a.id),
    yb: a.yb ?? 0,
    mood: a.mood ?? 0,
  }));

/**
 * 检查一遍；返回这次新解锁的。解锁会发奖励 + 弹一句。
 * 一次解锁好几个时会排队说（气泡有节流，但 act 类型不节流，所以会一条条弹出来）。
 */
export function check(st) {
  const a = A(st);
  const fresh = [];
  for (const def of ACHIEVEMENTS) {
    if (a.unlocked[def.id]) continue;
    let now = 0;
    try {
      now = def.of(st);
    } catch {
      continue; // 某条读不到状态就跳过，别让一条坏成就卡住整轮检查
    }
    if (!(now >= def.need)) continue;
    a.unlocked[def.id] = Math.floor(Date.now() / 1000);
    fresh.push(def);
  }
  if (!fresh.length) return [];
  store(st);
  for (const def of fresh) {
    if (def.yb) st.setInfo('yb', st.info.yb + def.yb);
    if (def.mood) st.setInfo('mood', Math.min(st.info.mood + def.mood, st.meta.moodMax));
    // 奖励是什么就说清楚（心情类的奖励在心满意足时会被封顶，别让人以为没发）
    const reward = [def.yb ? `${def.yb} 元宝` : '', def.mood ? `心情 +${def.mood}` : ''].filter(Boolean).join('、');
    const badge = BADGE[def.id] && st.imageOf ? st.imageOf('achv', BADGE[def.id]) : '';
    st.say(`🏆 成就达成：${def.name}（${def.desc}）${reward ? ` 奖励 ${reward}` : ''}`, 'levelup', { kind: 'act', image: badge });
  }
  return fresh;
}

/** 06:00：连续天数统计 + 今日 token 清零。
 *  **"连续"看的是那一天的流量**：昨天一次都没写（dayTokens 为 0）就断链，
 *  否则「连写七天」会变成"连着开机七天"，跟成就上写的那句话不符。 */
export function newDay(st) {
  const a = A(st);
  const today = st.dayStart();
  const last = Number(a.stats.lastDay) || 0;
  if (last === today) return;
  const hadTraffic = (Number(a.stats.dayTokens) || 0) > 0; // 刚结束那天有没有流量
  const contiguous = last > 0 && today - last <= 86400 * 1.5;
  a.stats.streak = hadTraffic ? (contiguous ? (Number(a.stats.streak) || 0) + 1 : 1) : 0;
  a.stats.lastDay = today;
  a.stats.dayTokens = 0;
  store(st);
}

/** 一条成就的说明（点菜单项时说的话） */
export function describe(st, id) {
  const row = list(st).find((x) => x.id === id);
  if (!row) return '没有这条成就';
  if (row.unlocked) return `🏅 ${row.name}：${row.desc}（已达成）`;
  const pct = Math.round((row.done / row.need) * 100);
  return `⬜ ${row.name}：${row.desc}\n进度 ${human(row.done)} / ${human(row.need)}（${pct}%）`;
}

export { human };
