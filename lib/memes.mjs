/**
 * memes.mjs —— 表情包配图：从配置里挑一张，并把模型挑图的结果从回复里摘出来。
 *
 * 开关在包内配置里（`whisperImageEnabled` / `chatImageEnabled`），
 * 名字来自 `assets/memes/<名字>.png` —— loadConfig 已经把"图不在磁盘上"的条目滤掉了，
 * 所以这里只用它给的键，**不自己拼路径**（桌宠会去 `<base>/pic/memes/<名字>.png` 取图）。
 *
 * 挑图的两条路，跟原版一致：
 *   碎碎念：随口一句，没有上下文可选 → 从池子里**随机**抽一张；
 *   对话：把整张表（名字 + 描述）交给模型，让它按语境挑，**挑不中就不配图**。
 */

/** 可用的表情包名字（配置里的键；不是对象就是没有） */
export const memeNames = (cfg) => {
  const m = cfg && cfg.memes;
  return m && typeof m === 'object' ? Object.keys(m) : [];
};

/** 随机抽一张（尽量避开上一张：连着弹同一张看着像卡住了） */
export function pickMeme(cfg, except = '') {
  const all = memeNames(cfg);
  if (!all.length) return '';
  const pool = all.length > 1 ? all.filter((k) => k !== except) : all;
  return pool[Math.floor(Math.random() * pool.length)] || '';
}

/** 给模型看的清单（名字：描述） */
export const memeCatalog = (cfg) =>
  Object.entries((cfg && cfg.memes) || {})
    .map(([k, v]) => `- ${k}：${v}`)
    .join('\n');

/** 摘 `[图]名字` 用的提示词（没开开关就别塞进去，省 token） */
export const MEME_PICK_PROMPT = (catalog) =>
  `如果你觉得下面某张表情包特别贴合你这句话，就在回复的**最后单独加一行**：\n[图]表情包名字\n` +
  `只能从这份清单里挑，名字要一字不差；没有合适的就**不要**加这一行，不要解释。\n清单：\n${catalog}`;

/** 回复最后单独一行 `[图]名字` */
const PICK_LINE = /^[ \t]*\[图\][ \t]*(.+?)[ \t]*$/mu;
/** 模型爱加的装饰：反引号/引号/句号 —— 名字对不上就白挑了一张 */
const trim = (s) => String(s).trim().replace(/^[`"'“”‘’]+/, '').replace(/[`"'“”‘’。．.,，!！?？~～]+$/, '').trim();

/**
 * 把挑图那一行从回复里摘掉。
 * 返回 `{ reply, image }`：image 为空串表示没配图（名字不在清单里 / 没写这一行都算没选），
 * 但**标记行无论如何都摘掉** —— 不能让 `[图]xxx` 出现在气泡里。
 * 摘完啥也不剩就把原文还回去（极端情况：模型只回了这一行）。
 */
export function parsePick(raw, names = []) {
  const text = String(raw ?? '');
  const hit = PICK_LINE.exec(text);
  if (!hit) return { reply: text.trim(), image: '' };
  const reply = text.replace(hit[0], '').trim();
  const name = trim(hit[1]);
  const image = names.includes(name) ? name : '';
  return { reply: reply || text.trim(), image };
}
