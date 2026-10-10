/**
 * mail.mjs —— 邮箱（qqpet `pet/mail.ts` 移植）
 *
 * 邮件的 keys/形状照搬：存 saveJsonData.email，键是发出时的 unix 秒，`k` 是"这类邮件只发一次"的标记，
 * `glb` 是附件物品，`r` 是已领取，`p` 是明信片（相簿里的照片 id）。
 * 触发条件也照搬：第一封欢迎信、生日当天、法定节假日；旅游回来寄明信片。
 *
 * 差异：原版是邮箱窗口，这边是「邮件」菜单 —— 一封一个菜单项，点一下就领（附件进背包）。
 */
import { allGoods, goodOf } from './goods.mjs';
import { give } from './items.mjs';
import { rand } from './state.mjs';

export const readMails = (st) => JSON.parse(st.save.saveJsonData.email || '{}');
export const writeMails = (st, mails) => {
  st.save.saveJsonData.email = JSON.stringify(mails);
  st.markDirty();
};

/** n 件不同的同类物品，每件 1~3 个 */
function some(type, n) {
  const all = allGoods(type);
  return Array.from({ length: n }, () => ({ ...all.splice(rand(0, all.length - 1), 1)[0], num: rand(1, 3) }));
}

/** 从此刻起找一个没被占用的邮件键（邮件以时间为键） */
function slot(mails) {
  let d = Math.floor(Date.now() / 1000);
  while (mails[d]) d++;
  return d;
}

/** 一封随机食物 + 玩具 + `yb` 元宝的信；标记 `k` 的这类信只发一次 */
function send(mails, k, l, yb, m) {
  if (Object.values(mails).some((x) => x.k === k)) return false;
  const d = slot(mails);
  mails[d] = { d, k, l, m, glb: [...some('food', 3), ...some('toy', 2), goodOf('nums', 'yb', yb)] };
  return true;
}

/** 旅游带回的明信片：一封没有附件的信 */
export function sendPhoto(st, shot, title, body) {
  const mails = readMails(st);
  const d = slot(mails);
  mails[d] = { d, l: title, p: shot.id, m: body, glb: [] };
  writeMails(st, mails);
}

/** 该发的那几封：欢迎信、生日、节假日；返回是否真的发了 */
export function deliverMails(st, today) {
  const mails = readMails(st);
  const now = new Date();
  const born = new Date(st.info.birthDay * 1000);
  const years = now.getFullYear() - born.getFullYear();
  const due = [];
  if (!Object.values(mails).some((m) => !m.e)) {
    due.push(['welcome', '欢迎来到QQ宠物~', 100, '[host]，欢迎回家！右键（手机上长按）我或者点我脚下的标签，有好多好玩的哦~']);
  }
  if (years > 0 && now.getMonth() === born.getMonth() && now.getDate() === born.getDate()) {
    due.push([`birthday-${now.getFullYear()}`, `${st.info.name}的${years}周岁生日快乐！`, 300, '[host]，今天是我的生日，谢谢你一直陪着我！']);
  }
  const h = today?.holiday;
  if (h?.off) due.push([`${now.getFullYear()}-${h.name}`, `${h.name}快乐！`, 200, `[host]，${h.name}快乐！收到节日礼物啦~`]);
  const sent = due.filter((m) => send(mails, ...m)).length > 0;
  if (sent) writeMails(st, mails);
  return sent;
}

/** 未领取的邮件（菜单里列这些） */
export function unread(st) {
  return Object.entries(readMails(st))
    .filter(([, m]) => !m.e && !m.r)
    .map(([d, m]) => ({ ...m, d: +d }))
    .sort((a, b) => a.d - b.d);
}

/** 领一封邮件：附件进背包，标记已领 */
export function claim(st, d) {
  const mails = readMails(st);
  const m = mails[d];
  if (!m || m.r) return false;
  m.r = true;
  writeMails(st, mails);
  const text = m.glb?.length ? m.m ?? '邮件里有点东西~' : m.l;
  if (m.glb?.length) give(st, m.glb, text);
  else st.say(text, 'gift', { kind: 'act' });
  return true;
}

/** 清掉已领取的旧邮件（原版是"删除已读"，这边自动做，别让菜单越堆越长） */
export function prune(st, keep = 20) {
  const mails = readMails(st);
  const done = Object.entries(mails)
    .filter(([, m]) => m.r)
    .sort((a, b) => +a[0] - +b[0]);
  if (done.length <= keep) return 0;
  for (const [d] of done.slice(0, done.length - keep)) delete mails[d];
  writeMails(st, mails);
  return done.length - keep;
}
