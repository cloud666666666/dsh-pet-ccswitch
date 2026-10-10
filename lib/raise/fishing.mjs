/**
 * fishing.mjs —— 池塘养鱼（qqpet `pet/fishing.ts` 移植）
 *
 * 原版的池塘是个 SWF，但它**所有规则都在这个 ts 里**（鱼苗/成长/喂食/收成/粉钻加速），
 * SWF 只是界面 —— 所以这部分是完整搬过来的，不是"仿一个"：
 *   鱼苗表 16 种（等级门槛 0~45、每种 5 条、2~3 小时长一档）、
 *   喂一次 10 元宝 = 一小时成长、熟鱼按售价收、没熟就捞只退一半钱、
 *   粉钻每天给等级×2 次加速、收满 1000 条算「养鱼大师」。
 * 表现换成菜单：鱼塘状态/买苗/喂鱼/收成/加速各一项，鱼一条一个菜单项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rand } from './state.mjs';
import { bump } from './achv.mjs';

const FRIES = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'fries.json'), 'utf8'));

const HOUR = 3600;
const FEED_PRICE = 10;
/** 收这么多条算「养鱼大师」 */
const MASTER = 1000;

const now = () => Math.floor(Date.now() / 1000);
const load = (st) => {
  const p = JSON.parse(st.save.saveJsonData.fishs || '{}');
  return { PD: p.PD ?? { allvipcnt: 0, canusecnt: 0 }, fishs: (p.fishs ?? []).filter((f) => f.id) };
};
const P = (st) => (st.pond ??= load(st));
const store = (st) => {
  st.save.saveJsonData.fishs = JSON.stringify(P(st));
  st.markDirty();
};

const ripe = (f) => f.stage >= 3;
/** 一档之后到成长期，两档之后熟（喂食等于给它加了一小时的年龄） */
function grow(f, t) {
  if (ripe(f)) return;
  const age = t - f.born + HOUR * f.siLiao;
  const n = Math.min(Math.floor(age / f.interval), 2);
  f.stage = n + 1;
  f.time = n === 2 ? 0 : age - n * f.interval;
}

/** 把鱼养到现在；系统时钟被往回调过就清塘（原版就是这个处理） */
function settle(st) {
  const t = now();
  const p = P(st);
  if (t < (st.pondLast ?? 0)) {
    p.fishs = [];
    p.PD.canusecnt = 0;
    st.pondLast = t;
    store(st);
    return;
  }
  st.pondLast = t;
  // 只在鱼真的长了一档时才落盘：菜单每秒都会读一次鱼塘状态，
  // 每次都 markDirty 会让菜单缓存永远失效、存档也被无谓地改写
  let changed = false;
  for (const f of p.fishs) {
    const before = `${f.stage}:${f.time}`;
    grow(f, t);
    if (`${f.stage}:${f.time}` !== before) changed = true;
  }
  if (changed) store(st);
}

/** 有几条可以收了（宿主定期问它，好提醒主人） */
export function ripeFish(st) {
  const t = now();
  for (const f of P(st).fishs) grow(f, t);
  return P(st).fishs.filter(ripe).length;
}

/** 收获计数；攒够 1000 条就是养鱼大师（原版给的是一个「逗逗我」成就） */
function harvested(st, n) {
  bump(st, 'fish', n); // 累计收成（成就用；下面这个是原版的计数器，会在 1000 处回绕）
  const total = (st.save.gameSaveDatas.fishing_harvestfish ?? 0) + n;
  if (total < MASTER) {
    st.save.gameSaveDatas.fishing_harvestfish = total;
  } else {
    st.save.gameSaveDatas.fishing_harvestfish = total - MASTER;
    st.save.gameSaveDatas.yyds = (st.save.gameSaveDatas.yyds ?? 0) + 1;
    st.say('逗逗我~~ 养鱼大师成就达成~~', 'happy', { kind: 'act' });
  }
  st.markDirty();
}

/** 鱼塘现状（菜单与气泡用） */
export function pondState(st) {
  settle(st);
  const p = P(st);
  return { PD: p.PD, fishes: p.fishs, harvestfish: st.save.gameSaveDatas.fishing_harvestfish, yb: st.info.yb };
}

/** 一档还要多久（秒） */
function leftSec(f, t = now()) {
  if (ripe(f)) return 0;
  const age = t - f.born + HOUR * f.siLiao;
  const need = f.stage === 1 ? f.interval : f.interval * 2;
  return Math.max(0, need - age);
}

export const STAGE_NAMES = { 1: '鱼苗', 2: '成长中', 3: '可以收了' };

export const fishLine = (f) => `${f.name}（${STAGE_NAMES[f.stage]}${ripe(f) ? '' : `，还需 ${human2(leftSec(f))}`}）`;

function human2(sec) {
  if (sec <= 0) return '好了';
  const m = Math.ceil(sec / 60);
  return m >= 60 ? `${(m / 60).toFixed(1)} 小时` : `${m} 分钟`;
}

/** 鱼苗店（粉钻八折是 SWF 自己算的，实收按标价） */
export const shop = (st) => FRIES.filter((f) => st.meta.level >= f.level);

/** 买一条鱼苗：池子上限 3 条（粉钻 5 条），钱从元宝里出 */
export function buy(st, fryid) {
  const p = P(st);
  if (p.fishs.length >= (st.info.pinkDiamond ? 5 : 3)) {
    st.say('鱼塘已经满了，先收几条吧~', 'sad', { kind: 'act' });
    return false;
  }
  const fry = FRIES.find((f) => f.fryid === +fryid);
  if (!fry) return false;
  if (st.meta.level < fry.level) {
    st.say(`[host]，我 ${fry.level} 级才能养${fry.name}哦~`, '', { kind: 'act' });
    return false;
  }
  if (st.info.yb < fry.price_yb) {
    st.say('元宝不够啦~~', 'sad', { kind: 'act' });
    return false;
  }
  st.setInfo('yb', st.info.yb - fry.price_yb);
  const t = now();
  // id 用"现在"的秒数，但同一秒里买两条会撞号（喂鱼/捞鱼都是按 id 找第一条），
  // 所以撞了就往后再挪一秒
  let id = t;
  while (p.fishs.some((f) => f.id === id)) id++;
  p.fishs.push({
    id,
    fryid: fry.fryid,
    name: fry.name,
    stage: 1,
    time: 0,
    interval: fry.interval,
    costyb: fry.price_yb,
    YB: fry.sell_price,
    quantity: fry.quantity,
    basequantity: fry.quantity,
    avatar: fry.avator,
    AIXIN: 0,
    growth: 0,
    strong: 0,
    iq: 0,
    charm: 0,
    born: t,
    siLiao: 0,
  });
  store(st);
  st.say(`[host]，我放了一条${fry.name}的鱼苗下塘~`, 'fish', { kind: 'act' });
  return true;
}

/** 喂鱼：10 元宝换一小时成长 */
export function feed(st, id) {
  const f = P(st).fishs.find((x) => x.id === +id);
  if (!f) return false;
  if (ripe(f)) {
    st.say('当前🐟儿已成熟~', '', { kind: 'act' });
    return false;
  }
  if (st.info.yb < FEED_PRICE) {
    st.say('元宝不够啦~~', 'sad', { kind: 'act' });
    return false;
  }
  st.setInfo('yb', st.info.yb - FEED_PRICE);
  f.siLiao++;
  grow(f, now());
  store(st);
  st.say(`喂了${f.name}一口，它长得更快了~`, 'fish', { kind: 'act' });
  return true;
}

/** 收一条：熟鱼按售价×数量给元宝，没熟就是捞出来只退一半 */
export function harvest(st, id) {
  const p = P(st);
  const i = p.fishs.findIndex((x) => x.id === +id);
  if (i < 0) return false;
  const f = p.fishs[i];
  const yb = ripe(f) ? f.YB * f.quantity : Math.floor(f.costyb / 2);
  p.fishs.splice(i, 1);
  st.addInfo('yb', yb);
  if (ripe(f)) harvested(st, 1);
  store(st);
  st.say(ripe(f) ? `收获成功！${f.name}卖了 ${yb} 元宝~` : `${f.name}还没长大，只捞回 ${yb} 元宝~`, 'gift', { kind: 'act' });
  return true;
}

/** 全部收成：只收熟的 */
export function harvestAll(st) {
  const p = P(st);
  const sold = p.fishs.filter(ripe);
  if (!p.fishs.length) {
    st.say('收获失败，当前没有🐟~', '', { kind: 'act' });
    return false;
  }
  const yb = sold.reduce((s, f) => s + f.YB * f.quantity, 0);
  if (!yb) {
    st.say('收获失败，当前没有成熟的🐟~', '', { kind: 'act' });
    return false;
  }
  p.fishs = p.fishs.filter((f) => !ripe(f));
  st.addInfo('yb', yb);
  harvested(st, sold.length);
  store(st);
  st.say(`收获成功！${sold.length} 条鱼卖了 ${yb} 元宝~`, 'gift', { kind: 'act' });
  return true;
}

/** 粉钻加速：所有鱼各加一小时成长，每天次数有限 */
export function speedUp(st) {
  const p = P(st);
  if (!p.PD.canusecnt) {
    st.say('使用失败，当前没有次数~', '', { kind: 'act' });
    return false;
  }
  if (!p.fishs.length) {
    st.say('使用失败，当前没有🐟~', '', { kind: 'act' });
    return false;
  }
  const t = now();
  for (const f of p.fishs) {
    f.siLiao++;
    grow(f, t);
  }
  p.PD.canusecnt--;
  store(st);
  st.say('粉钻加速成功，鱼儿们一下长了一小时~', 'fish', { kind: 'act' });
  return true;
}

/** 06:00、以及开通粉钻时：当天的加速次数 = 粉钻等级 × 2 */
export function resetFish(st) {
  const p = P(st);
  p.PD.allvipcnt = (st.info.PDiamondLevel || 1) * 2;
  p.PD.canusecnt = st.info.pinkDiamond ? p.PD.allvipcnt : 0;
  store(st);
}

/** 鱼塘概览（气泡） */
export function pondText(st) {
  const s = pondState(st);
  if (!s.fishes.length) return '鱼塘是空的，去「买鱼苗」放两条吧~';
  const lines = s.fishes.map((f) => fishLine(f));
  return [`🐟 鱼塘里有 ${s.fishes.length} 条鱼`, ...lines, `累计收成 ${s.harvestfish} 条`].join('\n');
}

export { FRIES, FEED_PRICE };
