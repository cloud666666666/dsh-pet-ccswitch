/**
 * state.mjs —— 养成存档：结构 / 默认值 / 脏数据修复 / 读写
 *
 * 存档结构与字段名**照抄 qqpet**（`src/shared/save.ts`，连它把 computed 拼错的
 * `petComputedlInfo` 都保留）—— 这样两边存档能互相认，也方便对着源码排查。
 * 修复规则同样是 `src/shared/save-logic.ts` 里那套：哪个字段坏了就用原版的同一个兜底值。
 *
 * 与 qqpet 的差异（都是"没有那块界面"导致的，不是漏抄）：
 *   - settings 只留 paused（暂停成长）和 quiet（免打扰：不主动弹气泡）；
 *     opacity/music/faceClick/hd/clip/watchApp 以及 AI、天气那几项，是 qqpet 界面自己的设置，
 *     桌宠这边的窗口、语音、AI 通道都由 dsh-pet 与宿主管，不重复存一份。
 *   - 存档落在 %LOCALAPPDATA%\dsh-pet\user\raise.json（沿用本项目的"代码/数据分离"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { USER_DIR } from '../paths.mjs';

export const SAVE_FILE = path.join(USER_DIR, 'raise.json');

const now = () => Math.floor(Date.now() / 1000);
/** 原版的 rand：闭区间取整，两端概率是中间的一半（Math.random 端点几乎取不到） */
export const rand = (min, max) => Math.round(Math.random() * (max - min) + min);

// ---------------------------------------------------------------------------
// 修复规则：坏值 → 原版用的那个兜底值
// ---------------------------------------------------------------------------
const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
const num = (min, max, fallback) => (v) =>
  isNum(v) && v >= min && v <= max ? v : typeof fallback === 'function' ? fallback() : fallback;
const bool = (v) => (typeof v === 'boolean' ? v : false);
const list = (v) => (Array.isArray(v) ? v : []);
const nullable = (v) => (v === undefined ? null : v);
const ANY = Infinity;

const RULES = {
  petInfo: {
    name: (v) => v || '宠宝~',
    host: (v) => v || '主人~',
    sex: (v) => (v === 'GG' || v === 'MM' ? v : 'GG'),
    growth: num(-ANY, ANY, 0),
    hunger: num(0, ANY, 0),
    clean: num(0, ANY, 0),
    health: num(0, 5, 0),
    mood: num(0, 1000, 0),
    birthDay: num(1, ANY, now),
    intel: num(-ANY, ANY, () => rand(5, 50)),
    charm: num(-ANY, ANY, () => rand(5, 50)),
    strong: num(-ANY, ANY, () => rand(5, 50)),
    // 原版这里会把字符串 "0" 也当合法值收下
    onLineTime: (v) => (isNum(v) ? v : Number(v) || 0),
    lastX: num(0, ANY, -1),
    lastY: num(0, ANY, -1),
    yb: (v) => (isNum(v) ? v | 0 : 5000),
    lastLoginTime: num(0, ANY, 0),
    onlineDataTime: num(0, ANY, 0),
    pinkDiamond: bool,
    PDgrowth: num(0, ANY, 0),
    PDgrowthValue: num(0, ANY, 0),
    PDgrowthValue_next: num(0, ANY, 0),
    PDiamondLevel: num(0, ANY, 0),
    PDiamondBeginDate: num(0, ANY, 0),
    PDiamondExpirationDate: num(0, ANY, 0),
    sweetHeart: bool,
    sweetHeartOverTime: num(0, ANY, 0),
  },
  petComputedlInfo: {
    level: num(1, ANY, 1),
    upGrowth: num(0, ANY, 0),
    nextGrowth: num(125, ANY, 125),
    hungerMax: num(1000, ANY, 1000),
    cleanMax: num(1000, ANY, 1000),
    healthMax: num(5, 5, 5),
    moodMax: num(1000, 1000, 1000),
  },
  studyInfo: Object.fromEntries(
    ['chinese', 'mathematics', 'politics', 'music', 'art', 'manner', 'pe', 'labouring', 'wushu'].map((k) => [k, num(0, ANY, 0)]),
  ),
  activeOption: { work: nullable, study: nullable, trip: nullable, ill: nullable, die: nullable },
  selfGoodDatas: {
    ...Object.fromEntries(['food', 'clean', 'medicine', 'background', 'nums', 'service', 'work', 'study', 'trip'].map((k) => [k, list])),
    // id 里带 "__" 的玩具已从游戏里删掉，原版就地丢掉
    toy: (v) => {
      if (!Array.isArray(v)) return [];
      for (let i = v.length - 1; i >= 0; i--) if (String(v[i]).includes('__')) v.splice(i, 1);
      return v;
    },
  },
  selfGoodUseOption: { background: nullable, food: nullable, clean: nullable, toy: nullable },
  gameSaveDatas: {
    fishing_harvestfish: num(0, ANY, 0),
    travel_china: list,
    travel_china_num: num(0, ANY, 0),
    ddw: num(0, ANY, 0),
    yyds: num(0, ANY, 0),
  },
  settings: { paused: bool, quiet: bool },
};

/** 一只全新的宠物（原版 fresh()，默认名字/初始物品一字不差） */
export function fresh() {
  return {
    havePet: false,
    isBury: false,
    saveNum: 0,
    nowTimeLine: 0,
    /** 上一轮记账的时间戳（秒）；null = 下一 tick 只对表、不补算 —— 关掉宿主的那段时间不算数，和 qqpet 一致 */
    lastTick: null,
    /** token 驱动用的水位：上次记账时 CC Switch 日志里最后一条请求的 created_at */
    lastTokenTs: 0,
    petInfo: {
      name: '宠宝~',
      host: '主人~',
      sex: 'GG',
      growth: 0,
      hunger: 1100,
      clean: 1100,
      health: 5,
      mood: 1000,
      birthDay: now(),
      intel: rand(5, 50),
      charm: rand(5, 50),
      strong: rand(5, 50),
      onLineTime: 0,
      lastX: -1,
      lastY: -1,
      yb: 5000,
      lastLoginTime: 0,
      onlineDataTime: 0,
      pinkDiamond: false,
      PDgrowth: 0,
      PDgrowthValue: 0,
      PDgrowthValue_next: 0,
      PDiamondLevel: 0,
      PDiamondBeginDate: 0,
      PDiamondExpirationDate: 0,
      sweetHeart: false,
      sweetHeartOverTime: 0,
    },
    petComputedlInfo: { level: 1, upGrowth: 0, nextGrowth: 125, hungerMax: 1100, cleanMax: 1100, healthMax: 5, moodMax: 1000 },
    studyInfo: { chinese: 0, mathematics: 0, politics: 0, music: 0, art: 0, manner: 0, pe: 0, labouring: 0, wushu: 0 },
    activeOption: { work: null, study: null, trip: null, ill: null, die: null },
    selfGoodDatas: {
      food: ['_10013006*2', '_102010001*3'],
      clean: ['_10021008*2', '_10021005*2'],
      medicine: ['_60001*2', '_50001*1'],
      background: ['_b0000000*1', '_b0000001*1'],
      service: [],
      work: [],
      study: [],
      trip: [],
      toy: ['_t0002*1'],
      nums: [],
    },
    selfGoodUseOption: { background: null, food: null, clean: null, toy: null },
    gameSaveDatas: { fishing_harvestfish: 0, travel_china: [], travel_china_num: 0, ddw: 0, yyds: 0 },
    illustrated: [],
    /** 各玩法自己的 JSON 块（邮件/任务/签到/鱼塘/相簿），原样存字符串 */
    saveJsonData: { email: '{}', task: '{}', signin: '{}', fishs: '{}' },
    settings: { paused: false, quiet: false },
  };
}

/** 逐字段修复脏数据；返回被修过的字段名（与原版一致，便于报日志） */
function repair(data) {
  const fixed = [];
  for (const [group, rules] of Object.entries(RULES)) {
    data[group] ??= {};
    for (const [field, rule] of Object.entries(rules)) {
      const v = rule(data[group][field]);
      if (v === data[group][field]) continue;
      data[group][field] = v;
      fixed.push(`${group}.${field}`);
    }
  }
  data.illustrated ??= [];
  data.saveJsonData ??= {};
  return fixed;
}

/** qqpet 存档（或它兼容的原版 config.json）里那段 petInfoData */
export function petOf(data) {
  const pet = data.petInfoData ?? data;
  delete pet.machineId;
  delete pet.oId;
  return pet;
}

/**
 * 拿到能直接跑的存档：有的就修一修用，没有的就新建一只。
 * `stored.havePet` 为假 = 还没领养（或者刚埋了），此时新建 —— 但保留主人的设置。
 *
 * 与 qqpet 的一处差异：新建时直接把 havePet 记成 true。
 * qqpet 是「进游戏先选蛋领养」，桌宠这边没有那道门（打开就该有宠物），
 * 所以第一次运行就算已领养；「重新领养」走菜单，埋掉之后菜单里也会重新出现领养。
 */
export function startSave(stored) {
  if (stored?.havePet) {
    const fixed = repair(stored);
    if (fixed.length) console.warn('[raise] 修复存档字段：' + fixed.join(', '));
    // 老存档没有的水位字段，补上（否则第一次记账会把历史流量全算进来）
    stored.lastTick ??= null;
    stored.lastTokenTs ??= 0;
    return stored;
  }
  const save = fresh();
  save.havePet = true;
  if (stored?.settings) Object.assign(save.settings, stored.settings, { paused: false });
  return save;
}

/** 埋掉这只宠物：下次启动重新选蛋，或直接按给定性别新生一只 */
export function buried(save, sex) {
  save.havePet = false;
  save.isBury = false;
  if (!sex) return save;
  const born = startSave(save);
  born.petInfo.sex = sex;
  born.havePet = true;
  return born;
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------
export function load() {
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[raise] 存档读不动，按新宠物处理：' + e.message);
  }
  return startSave(stored);
}

/** 原子写：先写临时文件再改名，崩在写一半也不会把存档毁掉 */
export function save(save) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    const tmp = SAVE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(save, null, 1));
    fs.renameSync(tmp, SAVE_FILE);
  } catch (e) {
    console.warn('[raise] 存档写入失败：' + e.message);
  }
}
