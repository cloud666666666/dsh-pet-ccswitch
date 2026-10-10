/**
 * level.mjs —— 等级与成长阶段（qqpet `src/renderer/pet/level.ts` 原样移植）
 *
 * 成长值 → 等级的两条公式（`need`、阶段切分点 5/16）都按原版逐字抄，
 * 改了就跟 qqpet 的存档对不上号了。
 */

/**
 * 从 n 级升到 n+1 级所需的成长值（原版的 getLevelRequirement）。
 * 展开后是 100n + 25n(n+1)(2n+1)/6 —— 立方项，所以高级越来越慢。
 */
const need = (n) => 100 * n + (25 * n * (n + 1) * (2 * n + 1)) / 6;

/** 成长值 → { 等级, 本级起点, 下级门槛 } */
export function levelOf(growth) {
  let level = 1;
  while (growth >= need(level)) level++;
  return { level, upGrowth: need(level - 1), nextGrowth: need(level) };
}

/** 等级 → 阶段：1~4 蛋、5~15 幼年、16+ 成年 */
export const stageOf = (level) => (level >= 16 ? 'Adult' : level >= 5 ? 'Kid' : 'Egg');

/** 阶段的显示名（原版界面上的字） */
export const STAGE_NAMES = { Egg: '宠物蛋', Kid: '幼年期', Adult: '成年期' };
