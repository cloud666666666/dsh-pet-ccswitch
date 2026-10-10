/**
 * signin.mjs —— 签到 / 成长值抽取 / 在线时长奖励 / 生日礼物（qqpet `pet/signin.ts` 移植）
 *
 * 数值与判定照搬：签到给 1 件抽奖物品（功能类给 20 个）、成长值抽取是三位数老虎机
 * （先 rand(0,5) 再两级收敛，0 不算数）、在线奖励每 20 分钟一次且第二次起每次 100 元宝、
 * 生日当天（按月的同一天）一件随机生日食物。
 */
import { goodOf, parseGood, loot } from './goods.mjs';
import { give } from './items.mjs';
import { rand } from './state.mjs';

const GIFT_MINUTES = 20;
const BIRTHDAY_FOODS =
  '100010496 100010497 10011014 100010033 100010100 100010106 100010109 100010110 100010123 100010197 100010241 100010298 100010305 100010337 100010338 100010461 100010489 100010491 100010494'.split(' ');

/** 存档形状（saveJsonData.signin），与原版一致 */
function load(st) {
  const s = JSON.parse(st.save.saveJsonData.signin || '{}');
  return {
    collectionList: s.collectionList ?? {},
    getGrowth: s.getGrowth ?? null,
    onlineGiftNum: s.onlineGiftNum ?? 0,
    isOnlineLastTime: s.isOnlineLastTime ?? GIFT_MINUTES,
    getBirthDayGift: s.getBirthDayGift ?? true,
  };
}

const S = (st) => (st.signin ??= load(st));
const store = (st) => {
  st.save.saveJsonData.signin = JSON.stringify(S(st));
  st.markDirty();
};

/** 某年某月签到过的那几天（06:00 为界的时间戳） */
export const monthSigns = (st, y, m) => S(st).collectionList[y]?.[m] ?? [];

export function signedToday(st) {
  const today = st.dayStart();
  const d = new Date(today * 1000);
  return monthSigns(st, d.getFullYear(), d.getMonth() + 1).includes(today);
}

/** 今天签到：给一件抽奖物品，功能类的给 20 个 */
export function signToday(st) {
  const today = st.dayStart();
  const d = new Date(today * 1000);
  const s = S(st);
  const year = (s.collectionList[d.getFullYear()] ??= {});
  (year[d.getMonth() + 1] ??= []).push(today);
  store(st);
  const goods = loot(1).map((g) => (g.type === 'nums' ? { ...g, num: 20 } : g));
  give(st, goods, '今日签到成功哦！~');
  return goods;
}

/** 成长值抽了没（粉钻可以再抽一次） */
export const canDrawGrowth = (st) => !S(st).getGrowth || (st.info.pinkDiamond && !S(st).getGrowth[1]);

/** 抽今天的成长值；抽到 0 不算数也不给东西 */
export function drawGrowth(st) {
  const s = S(st);
  let e0 = rand(0, 5);
  e0 = rand(0, e0);
  e0 = rand(0, e0);
  const digits = [e0, rand(0, rand(0, 9)), rand(0, 9)];
  const value = +digits.join('');
  if (!value) return { digits, goods: [] };
  if (s.getGrowth) s.getGrowth[1] = digits;
  else s.getGrowth = [digits, null];
  store(st);
  const goods = [parseGood(`_growth*${value}`)];
  give(st, goods, '[host],抽取成长值成功哦~~');
  return { digits, goods };
}

/** 下一次在线奖励要花多少元宝（第一次免费） */
export const giftCost = (st) => S(st).onlineGiftNum * 100;

/** 领在线奖励：倒计时得到点，钱也付过了才会走到这 */
export function takeOnlineGift(st) {
  const s = S(st);
  const tier = rand(0, st.info.pinkDiamond ? 1000 : 10000) < 2 ? 0 : s.onlineGiftNum % 10 === 0 ? 1 : 2;
  const goods = loot(st.info.pinkDiamond ? 2 : 1, tier);
  s.onlineGiftNum++;
  s.isOnlineLastTime = GIFT_MINUTES;
  store(st);
  give(st, goods, '[host],成功领取在线时长奖励哦~~');
  return goods;
}

/** 在线奖励的倒计时（每分钟走一格） */
export function tickGift(st, minutes) {
  const s = S(st);
  if (!s.isOnlineLastTime) return;
  s.isOnlineLastTime = Math.max(s.isOnlineLastTime - minutes, 0);
  store(st);
}

/** 生日当天（按月的同一天）领一件随机生日食物；一天一次 */
export function birthdayGift(st) {
  const s = S(st);
  if (s.getBirthDayGift) return [];
  s.getBirthDayGift = true;
  store(st);
  if (new Date().getDate() !== new Date(st.info.birthDay * 1000).getDate()) return [];
  const g = goodOf('food', BIRTHDAY_FOODS[rand(0, BIRTHDAY_FOODS.length - 1)]);
  give(st, [g], '我领取了我的生日礼物哦~'); // 是什么由 give() 列在下面那行
  return [g];
}

/** 06:00：抽奖次数与在线奖励重置；在线超过 10 分钟才算"今天来过"，才有生日礼物 */
export function resetSignIn(st) {
  const s = S(st);
  s.getGrowth = null;
  if (st.info.onLineTime > 10) s.getBirthDayGift = false;
  s.isOnlineLastTime = GIFT_MINUTES;
  s.onlineGiftNum = 0;
  store(st);
}

/** 今天签到几天了（连着签的那串，UI/气泡里报数用） */
export function monthCount(st) {
  const d = new Date(st.dayStart() * 1000);
  return monthSigns(st, d.getFullYear(), d.getMonth() + 1).length;
}

/** 在线奖励还要等几分钟（0 = 已经可以领了） */
export const onlineGiftWait = (st) => Math.ceil(S(st).isOnlineLastTime || 0);

export { GIFT_MINUTES, forget };
const forget = (st) => {
  st.signin = null;
};
