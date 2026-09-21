/**
 * paths.mjs —— 代码 / 运行数据 分离
 *
 * 代码可以在任何地方（npx 临时目录、npm 全局 node_modules、本地目录），
 * 运行数据（插件、Electron、配置、记忆、日志）固定放在一个地方：
 *   %LOCALAPPDATA%\dsh-pet         （可用 DSH_PET_HOME 覆盖）
 * 这样 npx 跑完临时目录被删也无所谓，重装/升级也不会丢配置和记忆。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** 包根目录（本文件在 <pkg>/lib/ 下） */
export const CODE_DIR = path.resolve(import.meta.dirname, '..');

export const HOME =
  process.env.DSH_PET_HOME ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-pet');

export const PLUGIN_DIR = path.join(HOME, 'plugin');
export const ELECTRON_DIR = path.join(HOME, 'electron');
export const USER_DIR = path.join(HOME, 'user');
export const LOG_DIR = path.join(HOME, 'logs');
export const HOST_LOG = path.join(LOG_DIR, 'host.log');
/** 记住发现到的 cc-switch.exe 路径 / 端口等（CC Switch 升级换目录后会自动更新） */
export const RUNTIME_JSON = path.join(HOME, 'runtime.json');

export const HELPER_ENTRY = path.join(PLUGIN_DIR, 'runtime', 'electron-helper', 'main.js');

export function ensureDirs() {
  for (const d of [HOME, USER_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function readRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME_JSON, 'utf8')); } catch { return {}; }
}

export function writeRuntime(patch) {
  const next = { ...readRuntime(), ...patch };
  try {
    ensureDirs();
    fs.writeFileSync(RUNTIME_JSON, JSON.stringify(next, null, 2));
  } catch { /* 写不进去也不影响运行 */ }
  return next;
}

/** electron 可执行文件路径（Windows 下是 electron.exe） */
export function electronBinary() {
  return process.platform === 'win32'
    ? path.join(ELECTRON_DIR, 'electron.exe')
    : path.join(ELECTRON_DIR, 'electron');
}
