/**
 * port.mjs —— 与 qqpet 的存档互通（导入 / 导出）
 *
 * 能这么便宜地做，是因为当初移植时**存档字段名是照抄的**（连 qqpet 把 computed 拼错的
 * `petComputedlInfo` 都留着），两边的 SaveData 结构一模一样。所以"导入"基本就是：
 * 拿它的文件 → 清掉我们这边没有的键 → 补两个我们自己的水位字段 → 交给 state.mjs 的 repair()。
 *
 * 认两种来源：
 *   - qqpet 的存档：`%APPDATA%\QQPet\save.json`（就是它的 SaveData）
 *   - 原版 QQ 宠物的 config.json：宠物数据在 `petInfoData` 底下（qqpet 的 petOf() 也认这个）
 */
import fs from 'node:fs';
import path from 'node:path';
import { SAVE_FILE, startSave, save as writeSave, fresh } from './state.mjs';

/** 我们这边 settings 认的键（qqpet 的界面设置在这边没有对应物，导入时丢掉） */
const OUR_SETTINGS = ['paused', 'quiet'];
/** 我们这边自己加的、qqpet 没有的字段 */
const OUR_ONLY = ['lastTick', 'lastTokenTs'];

/** 拿来当存档的文件长这样才算数 */
function looksLikeSave(j) {
  const pet = j?.petInfoData ?? j;
  return Boolean(pet && typeof pet === 'object' && pet.petInfo && typeof pet.petInfo === 'object');
}

/**
 * 把一份 qqpet 存档转成我们的存档对象。
 * 返回 { save, notes }：notes 是"动了哪些地方"，交给命令行原样打出来 —— 导入这种事要让用户看得见。
 */
export function fromQqpet(raw) {
  const pet = raw?.petInfoData ?? raw; // 原版 config.json 的宠物数据在 petInfoData 底下
  const notes = [];
  const out = JSON.parse(JSON.stringify(pet));

  if ('petInfoData' in out) {
    delete out.petInfoData;
    notes.push('从 petInfoData 里取出宠物数据（原版 config.json 格式）');
  }
  for (const k of ['machineId', 'oId']) if (k in out) delete out[k];

  // settings：只留我们认的两个键
  const dropped = Object.keys(out.settings ?? {}).filter((k) => !OUR_SETTINGS.includes(k) && !OUR_ONLY.includes(k));
  if (dropped.length) {
    out.settings = Object.fromEntries(Object.entries(out.settings).filter(([k]) => OUR_SETTINGS.includes(k)));
    notes.push(`丢掉 ${dropped.length} 个这边没有的界面设置（${dropped.slice(0, 4).join('、')}${dropped.length > 4 ? '…' : ''}）`);
  }

  // 进行中的打工/上课/旅游：不清掉的话，一启动就会按"关掉很久"把它瞬间算完
  const doing = ['work', 'study', 'trip'].filter((k) => out.activeOption?.[k]);
  if (doing.length) {
    for (const k of doing) out.activeOption[k] = null;
    notes.push(`清掉导入时正在进行的事（${doing.join('、')}）—— 免得一启动就按"关掉很久"瞬间算完`);
  }

  // 我们自己的两个水位：lastTick 清掉（关掉那段时间不算），
  // lastTokenTs 定在"现在"（否则会把今天已经发生的 token 一次性算成收益）
  out.lastTick = null;
  out.lastTokenTs = Math.floor(Date.now() / 1000);
  notes.push('记账水位重置（导入这段时间不算饿/脏，也不会把已有 token 一次性算成成长值）');

  return { save: out, notes };
}

/** 读一个文件并转成我们的存档；不像存档就抛错（由命令行报给用户） */
export function readImport(file) {
  const text = fs.readFileSync(file, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`不是合法 JSON：${e.message}`);
  }
  if (!looksLikeSave(raw)) throw new Error('这文件里没有宠物数据（既不是 qqpet 的 save.json，也不是原版的 config.json）');
  const { save, notes } = fromQqpet(raw);
  // 交给 repair() 过一遍：坏字段按原版兜底值修，顺便补齐缺的键
  const fixed = startSave(save);
  const summary = {
    name: fixed.petInfo.name,
    sex: fixed.petInfo.sex,
    level: fixed.petComputedlInfo.level,
    yb: fixed.petInfo.yb,
    growth: Math.round(fixed.petInfo.growth),
    items: Object.values(fixed.selfGoodDatas).reduce((n, list) => n + list.length, 0),
    mails: Number(Object.keys(JSON.parse(fixed.saveJsonData.email || '{}')).length),
    fish: Number((JSON.parse(fixed.saveJsonData.fishs || '{}').fishs ?? []).length),
  };
  return { save: fixed, notes, summary };
}

/**
 * 导入：先备份现有存档（raise.json.bak），再写新的。
 * 返回 { backup, summary, notes }
 */
export function importInto(file, { saveFile = SAVE_FILE } = {}) {
  const { save, notes, summary } = readImport(file);
  let backup = null;
  if (fs.existsSync(saveFile)) {
    backup = saveFile + '.bak';
    fs.copyFileSync(saveFile, backup);
  }
  writeSave(save);
  return { backup, summary, notes };
}

/** 导出：把当前存档拷一份出去（原样，字段与 qqpet 一致，可以直接丢回 qqpet 的 userData） */
export function exportTo(file, { saveFile = SAVE_FILE } = {}) {
  if (!fs.existsSync(saveFile)) throw new Error('还没有存档可导出（宠物还没开始养？）');
  const raw = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  // 把我们的水位字段摘掉，导出的就是一份干净的 qqpet 存档
  for (const k of ['lastTick', 'lastTokenTs']) delete raw[k];
  raw.settings = Object.fromEntries(Object.entries(raw.settings ?? {}).filter(([k]) => OUR_SETTINGS.includes(k)));
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  return { file: path.resolve(file), pet: raw.petInfo?.name, level: raw.petComputedlInfo?.level };
}

/** 一只全新的宠物（给"清档重来"用） */
export const blank = () => fresh();
