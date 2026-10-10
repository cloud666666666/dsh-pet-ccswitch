/**
 * text.mjs —— 台词与疾病表
 *
 * 数据来自 qqpet（`pet/data/talk.ts`、`greet.ts`、`ills.ts`，由
 * `scripts/import-qqpet-data.mjs` 原样导出成 JSON）。这里只做取用：
 *   - line(cat, sub)  —— 按分类（可带子键）随机抽一句，抽不到返回 null
 *   - greeting()      —— 按当前时段抽开机问候
 *   - illOf(code)     —— activeOption.ill + 当前健康度 → 具体病症
 *
 * 原版每句话还带一个 `submitText` 按钮文案（弹窗上的「好的」）。桌宠的气泡没有按钮，
 * 用不上，所以这里只取 `tolk`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rand } from './state.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

const TALK = read('talk.json');
const GREET = read('greet.json');
const { DEAD, ILLS } = read('ills.json');

export { TALK, GREET, DEAD, ILLS };

/**
 * 抽一句台词。`cat` 是 TALK 的分类；给了 `sub` 就走子键（子键那一层还是数组）。
 * 分类不存在、子键不存在、抽到空数组 —— 一律返回 null，由调用方决定退化成什么。
 */
export function line(cat, sub) {
  let lines = TALK[cat] ?? [];
  if (sub && !Array.isArray(lines)) lines = lines[sub] ?? [];
  return Array.isArray(lines) && lines.length ? lines[rand(0, lines.length - 1)].tolk : null;
}

/** 某分类有多少句（菜单里给「随机说一句」这类功能判断有没有料） */
export const hasLine = (cat, sub) => line(cat, sub) !== null;

/** 按当前时段抽一句开机问候（GREET 是「[起始小时, 句子[]]」数组，取最后一个已到的时段） */
export function greeting() {
  const h = new Date().getHours();
  const slot = GREET.findLast(([from]) => h >= from);
  return slot ? line0(slot[1]) : null;
}

/** 从 [{tolk, submitText}] 里抽一句的 tolk */
function line0(list) {
  return list.length ? list[rand(0, list.length - 1)].tolk : null;
}

/** 随机一句闲聊（smallTalk 有 102 句） */
export const smallTalk = () => line('smallTalk');

/** 把台词里的 [host] 换成主人名 */
export const fillHost = (text, host) => String(text ?? '').replace(/\[host\]/g, host ?? '主人~');

// ---------------------------------------------------------------------------
// 疾病：`activeOption.ill` + 当前健康度 → 具体病症
// ---------------------------------------------------------------------------
const DEPTH = { 4: 0, 3: 1, 2: 2, 1: 3 };

/** `code` 形如 "1-" + 3（病线 1、健康度 3）→ 对应的病症；空或 "0-0" = 死亡 */
export function illOf(code) {
  if (!code || code === '0-0') return DEAD;
  const [ln, health] = String(code).split('-');
  let ill = ILLS[+ln];
  if (!ill) return DEAD;
  for (let i = DEPTH[health] ?? 0; i > 0 && ill.children; i--) ill = ill.children;
  return ill;
}

/** 这条病线治好了吗：id 对得上就是对的药 */
export const cureIdOf = (code) => illOf(code).cure.id;
