/**
 * goods.mjs —— 物品表 + 背包（qqpet `pet/data/goods.ts` 与 `pet/goods.ts` 的移植）
 *
 * 表本身是 `scripts/import-qqpet-data.mjs` 从 qqpet 导出的 goods.json（990 件，剥掉了美术 url）。
 * 背包条目沿用原版的编码 `_<id>*<数量>`，存进存档的 selfGoodDatas 里。
 *
 * 与原版的差异：少了 onGoodsChange 监听（那是给它的界面刷新用的，宿主这边没有要刷的 DOM）。
 * 所有函数第一个参数是 Raise 实例（`st`），存档挂在 st.save 上 —— 不搞模块级单例，方便测试。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TABLE = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'goods.json'), 'utf8'));

/** 按 id 反查类型（id 全局唯一，原版也是这么找的） */
const typeOf = (id) => Object.keys(TABLE).find((t) => TABLE[t][`_${id}`]);

export const goodOf = (type, id, num = 1) => ({ ...TABLE[type][`_${id}`], num });

/** 某类型全部物品，按表内顺序（工作/学习菜单用） */
export const allGoods = (type) => Object.values(TABLE[type]).map((g) => ({ ...g, num: 1 }));

/** 只按 id 找 */
export function findGood(id) {
  const type = typeOf(id);
  return type ? goodOf(type, id) : null;
}

/** 背包里的 `_<id>*<数量>` 编码 → Good */
export function parseGood(code) {
  const [id, n] = String(code).slice(1).split('*');
  const g = findGood(id);
  return g ? { ...g, num: +(n ?? 1) } : null;
}

export const TYPE_NAMES = {
  food: '食物',
  clean: '日用品',
  medicine: '药品',
  toy: '玩具',
  nums: '功能',
  background: '背景',
  service: '服务',
  work: '工作',
  study: '学习',
  trip: '旅游',
};

/** " 魅力+1 智力+2" 这样的属性串，没有就空串 */
export const attrs = (g) =>
  [
    ['魅力', g.charm],
    ['智力', g.intel],
    ['武力', g.strong],
    ['心情', g.mood],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => ` ${k}${v > 0 ? '+' : ''}${v}`)
    .join('');

/** 物品说明，照原版提示框的行序 */
export function describe(g) {
  if (g.type === 'nums') return [`获得${g.name}*${g.value}`, g.desc ?? ''];
  const a = attrs(g);
  return [
    g.desc,
    g.hunger && `饥饿：${g.hunger}`,
    g.clean && `清洁：${g.clean}`,
    a && `属性：${a}`,
    g.group && `成长值：${g.group}`,
    g.useTimeing && `持续时间：${g.useTimeing}分钟`,
  ].filter((l) => Boolean(l));
}

/** 一句话摘要（菜单里当提示用，比 describe 短） */
export function summary(g) {
  const bits = [];
  if (g.hunger) bits.push(`饥饿+${g.hunger}`);
  if (g.clean) bits.push(`清洁+${g.clean}`);
  if (g.mood) bits.push(`心情+${g.mood}`);
  if (g.group) bits.push(`成长+${g.group}/时`);
  if (g.useTimeing) bits.push(`${g.useTimeing}分钟`);
  if (g.intel) bits.push(`智力+${g.intel}`);
  if (g.charm) bits.push(`魅力+${g.charm}`);
  if (g.strong) bits.push(`武力+${g.strong}`);
  return bits.join(' ');
}

// ---------------------------------------------------------------------------
// 背包：条目是 `_<id>*<数量>`，与存档字段 selfGoodDatas 一一对应
// ---------------------------------------------------------------------------
const indexOf = (st, type, id) => st.save.selfGoodDatas[type].findIndex((e) => e.startsWith(`_${id}*`));

/** 某类型背包里的全部物品（原版分页，我们直接全给，菜单自己截断） */
export const listGoods = (st, type) => st.save.selfGoodDatas[type].map((e) => parseGood(e)).filter(Boolean);

export const hasGood = (st, type, id) => indexOf(st, type, id) >= 0;

/** 数量；没这件就是 0 */
export function countOf(st, type, id) {
  const i = indexOf(st, type, id);
  return i < 0 ? 0 : +st.save.selfGoodDatas[type][i].split('*')[1];
}

/** 增减 n 件；顺手记进图鉴（illustrated）—— 与原版一致 */
export function addGood(st, type, id, n) {
  if (!st.save.illustrated.includes(id)) st.save.illustrated.push(id);
  const list = [...st.save.selfGoodDatas[type]];
  const i = indexOf(st, type, id);
  const count = (i >= 0 ? +list[i].split('*')[1] : 0) + n;
  if (i < 0 && count > 0) list.push(`_${id}*${count}`);
  else if (count > 0) list[i] = `_${id}*${count}`;
  else if (i >= 0) list.splice(i, 1);
  st.save.selfGoodDatas[type] = list;
  st.markDirty();
}

/** 从背包里拿走 n 件；没有则返回 false */
export function takeGood(st, good, n = 1) {
  if (!hasGood(st, good.type, good.id)) return false;
  addGood(st, good.type, good.id, -n);
  return true;
}

/** 限时物品生效（同类型后一个顶掉前一个） */
export function startTimed(st, good) {
  st.save.selfGoodUseOption[good.type] = { id: good.id, left: good.useTimeing };
  st.markDirty();
}

/** 限时物品倒计时；返回这一分钟里到期的类型 */
export function tickTimed(st, minutes) {
  const over = [];
  for (const [type, t] of Object.entries(st.save.selfGoodUseOption)) {
    if (!t) continue;
    const left = t.left - minutes;
    st.save.selfGoodUseOption[type] = left > 0 ? { id: t.id, left } : null;
    if (left <= 0) over.push(type);
  }
  if (over.length) st.markDirty();
  return over;
}

// ---------------------------------------------------------------------------
// 抽奖池（签到 / 在线奖励 / 任务奖励）
// ---------------------------------------------------------------------------
const POOLS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'pool.json'), 'utf8'));
/** 抽到 epic（池 0）/ heirloom（1）/ rare（2）的概率 —— 原版 Pt() 的权重 */
const WEIGHTS = [0.02, 0.25, 0.75];

/** 抽 n 件物品；pool 给了就从那个池抽，没给就按权重先定池 */
export function loot(n, pool = null) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let p = pool;
    if (p === null) {
      let r = Math.random();
      p = WEIGHTS.findIndex((w) => (r -= w) <= 0);
      if (p < 0) p = 2;
    }
    const list = POOLS[p];
    out.push(parseGood(list[Math.floor(Math.random() * list.length)]));
  }
  return out.filter(Boolean);
}
