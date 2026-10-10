/**
 * vip.mjs —— 粉钻贵族 / 贴心宝贝（qqpet `pet/vip.ts` + 界面上的价目）
 *
 * 粉钻：首次 666 元宝（原价 888）开通 5 天，之后按等级 ×888 续费；开通当天给当天的池塘加速，
 *       续费不给。粉钻期间：成长 +10/小时、抽奖池更好、签到能多抽一次成长值、买东西八折。
 * 贴心宝贝：300 元宝/天（原版一次最多买 30 天）；开启后宠物会自己动手满足最缺的那项
 *       （engine.selfCare）、成长 +10%。
 * 每档的判定（成长、等级、到期）在 engine.newDay 里，与原版 settle() 一段段对过。
 */
import { pay, moneyText } from './items.mjs';

/** 粉钻标价：头一次是 666（原价 888），之后按粉钻等级 ×888 */
export const pinkDiamondPrice = (st) => (st.info.PDgrowth === 0 ? 666 : st.info.PDiamondLevel * 888);

const DAY = 86400;
const LEVELS = [0, 100, 300, 800, 1200, 2800, 5800, 99999999];

/** 开通/续费粉钻 `days` 天（从今天 06:00 起算；接着开通的往后顺延） */
export function openPinkDiamond(st, days = 5) {
  const today = st.dayStart();
  const extend = st.info.pinkDiamond;
  if (extend) st.setInfo('PDiamondExpirationDate', st.info.PDiamondExpirationDate + days * DAY);
  else {
    st.setInfo('PDiamondExpirationDate', today + days * DAY);
    st.setInfo('PDiamondBeginDate', today);
  }
  st.setInfo('PDgrowthValue', 20);
  settle(st, today);
  // 开通送当天的池塘加速（续费不送）；池塘玩法挂上来之后由它的钩子处理
  if (!extend) for (const fn of st.hooks.reopen ?? []) fn(st);
}

/** 到期、等级与下一级所需成长（原版 settle） */
function settle(st, today) {
  const active = st.info.PDiamondExpirationDate > today;
  st.setInfo('pinkDiamond', active);
  if (!active) {
    st.setInfo('PDiamondBeginDate', 0);
    st.setInfo('PDiamondExpirationDate', 0);
  }
  const level = Math.max(LEVELS.filter((g) => st.info.PDgrowth >= g).length, 1);
  st.setInfo('PDiamondLevel', level);
  st.setInfo('PDgrowthValue_next', LEVELS[level]);
}

/** 买粉钻：先扣钱再开通；钱不够就什么都不做 */
export function buyPinkDiamond(st, days = 5) {
  if (st.info.pinkDiamond) {
    const left = Math.ceil((st.info.PDiamondExpirationDate - Date.now() / 1000) / DAY);
    st.say(`[host],我们粉钻还有 ${left} 天到期哦~`, 'happy', { kind: 'act' });
    return false;
  }
  const price = pinkDiamondPrice(st);
  const yb0 = st.info.yb;
  if (!pay(st, price)) return false;
  openPinkDiamond(st, days);
  const until = new Date(st.info.PDiamondExpirationDate * 1000).toLocaleDateString('zh-CN');
  st.say(`[host],我们粉钻到${until}过期哦~
开通 ${days} 天` + moneyText(yb0, st.info.yb), 'gift', { kind: 'act' });
  return true;
}

/** 贴心宝贝：续 `days` 天并开启 */
export function addSweetHeart(st, days) {
  st.setInfo('sweetHeartOverTime', (st.info.sweetHeartOverTime || st.dayStart()) + days * DAY);
  st.setInfo('sweetHeart', true);
}

/** 买贴心宝贝：300 元宝/天；已经有天数时只切换开关 */
export function buySweetHeart(st, days = 1) {
  if (!st.info.sweetHeartOverTime) {
    const cost = 300 * days;
    const yb0 = st.info.yb;
    if (!pay(st, cost)) return false;
    addSweetHeart(st, days);
    const until = new Date(st.info.sweetHeartOverTime * 1000).toLocaleDateString('zh-CN');
    st.say(`[host],贴心宝贝${until}过期，我真是太爱你了！~
${days} 天 × 300` + moneyText(yb0, st.info.yb), 'gift', { kind: 'act' });
    return true;
  }
  const on = !st.info.sweetHeart;
  st.setInfo('sweetHeart', on);
  st.say(on ? '[host],开启了贴心宝贝，我真是太爱你了！~' : '[host],我依然还是爱你的，天地可鉴！~', 'happy', { kind: 'act' });
  return true;
}

/** 粉钻还有几天到期 */
export const pinkDiamondDays = (st) => Math.max(0, Math.ceil((st.info.PDiamondExpirationDate - st.dayStart()) / DAY));

/** 贴心宝贝还有几天到期 */
export const sweetHeartDays = (st) => Math.max(0, Math.ceil((st.info.sweetHeartOverTime - st.dayStart()) / DAY));

/** 粉钻到底给了什么（界面上要说人话，别只写"已开通"） */
export const PINK_DIAMOND_HELP = [
  '成长 ×1.125（原版是"成长 +10/小时"，折算到 token 换算里）',
  '商店买东西八折',
  '签到能多抽一次成长值',
  '池塘每天多几次加速（等级 ×2 次）',
  '抽奖池更好（签到/在线奖励更容易出好东西）',
];

/** 贴心宝贝到底给了什么 */
export const SWEET_HEART_HELP = [
  '它会自己照顾自己：饿了吃、脏了洗、闷了玩（用背包里的东西）',
  '成长 ×1.1',
];
