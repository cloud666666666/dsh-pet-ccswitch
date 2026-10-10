/**
 * settings.mjs —— 养成系统的可调项（配置文件 + 环境变量）
 *
 * 为什么要有配置文件：宿主是**开机自启脚本**拉起来的，让用户去设 Windows 环境变量再重启，
 * 门槛太高了。所以这些开关也能写进 `%LOCALAPPDATA%\dsh-pet\user\raise-config.json`，
 * 用 `npx dsh-pet-ccswitch raise config calendar=holiday-cn` 就能改。
 *
 * 优先级：配置文件 > 环境变量 > 默认值。
 * （环境变量留给"临时试一下"和自动化，配置文件留给"就这么用"。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { USER_DIR } from '../paths.mjs';

export const CONFIG_FILE = path.join(USER_DIR, 'raise-config.json');

/** 认得的键、默认值、以及怎么把字符串转成该有的类型（命令行 `key=value` 用得上） */
export const KEYS = {
  /** off | holiday-cn | ankio —— 见 calendar.mjs（联网取节假日/节气） */
  calendar: { env: 'PET_RAISE_CALENDAR', dflt: 'off', kind: 'string' },
  /** 天气播报（联网，走 wttr.in） */
  weather: { env: 'PET_RAISE_WEATHER', dflt: 'off', kind: 'onoff' },
  /** 天气城市；空 = 按 IP 定位 */
  weatherCity: { env: 'PET_RAISE_WEATHER_CITY', dflt: '', kind: 'string' },
  /** 每 100 万 token 换多少成长值 / 元宝 */
  growthPerMTok: { env: 'PET_RAISE_GROWTH_PER_MTOK', dflt: 300, kind: 'number' },
  ybPerMTok: { env: 'PET_RAISE_YB_PER_MTOK', dflt: 100, kind: 'number' },
  /** 挂机也长个（原版行为）；默认只吃 token */
  natural: { env: 'PET_RAISE_NATURAL', dflt: false, kind: 'onoff' },
  /** 它主动说话的最小间隔（秒） */
  ambientGapSec: { env: 'PET_RAISE_AMBIENT_GAP', dflt: 600, kind: 'number' },
  /** 工作联动：仓库路径（也可以给一个"放着多个项目的目录"，会扫一层子目录） */
  linkRepo: { env: 'PET_RAISE_LINK_REPO', dflt: '', kind: 'string' },
  /** 工作联动：工作区脏了就让宠物变脏（提交 = 洗澡） */
  linkGit: { env: 'PET_RAISE_LINK_GIT', dflt: true, kind: 'onoff' },
  /** 工作联动：请求错误率影响心情 */
  linkErrors: { env: 'PET_RAISE_LINK_ERRORS', dflt: true, kind: 'onoff' },
  /** 工作联动的采样间隔（秒） */
  linkEverySec: { env: 'PET_RAISE_LINK_EVERY', dflt: 300, kind: 'number' },
};

const isOn = (v) => ['on', '1', 'true', 'yes'].includes(String(v).trim().toLowerCase());

/** 把各种来源的值归一化成该有的类型；认不出来就返回 undefined（落回下一级来源） */
export function coerce(kind, v) {
  if (v === undefined || v === null) return undefined;
  if (kind === 'onoff') return typeof v === 'boolean' ? v : isOn(v) || (String(v).trim() === 'off' ? false : undefined);
  if (kind === 'number') {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return String(v);
}

export function readConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 合并写入（只改给到的键） */
export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/**
 * 定下一个键最终生效的值：配置文件 > 环境变量 > 默认值。
 * 返回 { value, from }（from 是 'config' | 'env' | 'default'，`raise config` 里会显示出来）
 */
export function resolve(key, cfg = readConfig(), env = process.env) {
  const spec = KEYS[key];
  if (!spec) throw new Error('不认识的配置项：' + key);
  const fromFile = coerce(spec.kind, cfg[key]);
  if (fromFile !== undefined) return { value: fromFile, from: 'config' };
  const fromEnv = coerce(spec.kind, env[spec.env]);
  if (fromEnv !== undefined) return { value: fromEnv, from: 'env' };
  return { value: spec.dflt, from: 'default' };
}

/** 一次把全部键解出来 */
export function resolveAll(env = process.env) {
  const cfg = readConfig();
  const out = {};
  for (const key of Object.keys(KEYS)) out[key] = resolve(key, cfg, env);
  return out;
}
