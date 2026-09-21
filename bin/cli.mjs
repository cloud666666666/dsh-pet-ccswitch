#!/usr/bin/env node
/**
 * dsh-pet-ccswitch —— 桌宠 × CC Switch
 *
 * 把 dsh-pet 从 DeepSeek Harness 里摘出来独立跑，数据全部取自 CC Switch 的本地库，
 * 并让桌宠跟着 CC Switch 的生命周期起落。
 *
 * 用法：
 *   npx dsh-pet-ccswitch install     一次性准备（打补丁 / 备好 Electron / 注册开机自启）并启动
 *   npx dsh-pet-ccswitch start|stop|status|restart
 *   npx dsh-pet-ccswitch patch       升级 dsh-pet 后重新打补丁
 *   npx dsh-pet-ccswitch doctor      自检：CC Switch 在哪、库能不能读、缺什么
 *   npx dsh-pet-ccswitch uninstall   移除开机自启（--purge 连运行数据一起删）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CODE_DIR, HOME, PLUGIN_DIR, ELECTRON_DIR, USER_DIR, LOG_DIR, HOST_LOG,
  HELPER_ENTRY, electronBinary, ensureDirs,
} from '../lib/paths.mjs';
import { applyPatches, patchesInPlace } from '../lib/patch.mjs';
import { findCcSwitchExe, findCcSwitchProcess } from '../lib/discover.mjs';

const pExecFile = promisify(execFile);
const APP_DIR = path.join(HOME, 'app');           // install 时把代码拷这里，npx 临时目录没了也能跑
const DEFAULT_PORT = 3080;
const isWin = process.platform === 'win32';
const say = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const ok = (s) => `✓ ${s}`;
const bad = (s) => `✗ ${s}`;

async function ps(script, timeout = 20000) {
  const { stdout } = await pExecFile('powershell.exe', ['-NoProfile', '-Command', script],
    { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
  return String(stdout || '').trim();
}

function startupDir() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
const STARTUP_VBS = () => path.join(startupDir(), 'dsh-pet-ccswitch.vbs');

/** 宿主进程（靠命令行里的 host.mjs 认） */
async function hostPid() {
  try {
    const out = await ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'host\\.mjs' } | Select-Object -First 1 -ExpandProperty ProcessId");
    return out ? Number(out) : null;
  } catch { return null; }
}

async function hostAlive(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/dsh-pet-7340/config`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

/** 把代码同步到 HOME/app（install 后自启指向这里，与 npx 临时目录解耦） */
function syncApp() {
  ensureDirs();
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const d of ['lib', 'bin']) {
    fs.cpSync(path.join(CODE_DIR, d), path.join(APP_DIR, d), { recursive: true });
  }
  fs.copyFileSync(path.join(CODE_DIR, 'package.json'), path.join(APP_DIR, 'package.json'));
  return APP_DIR;
}

function writeStartupVbs(appDir) {
  const dir = startupDir();
  fs.mkdirSync(dir, { recursive: true });
  const host = path.join(appDir, 'lib', 'host.mjs');
  // 内容必须是纯 ASCII：wscript 按 ANSI 读 .vbs，非 ASCII 会解析失败。
  // 引号规则：VBScript 里 "" 表示一个字面引号，所以 """C:\p\node.exe"" ""C:\p\host.mjs"""
  // 求值后是字符串 "C:\p\node.exe" "C:\p\host.mjs"，正是 Run 需要的命令行。
  const vbs = [
    "' dsh-pet-ccswitch - silent autostart",
    "' Starts the pet host. The host follows CC Switch: pet appears when CC Switch runs,",
    "' disappears when it exits.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${process.execPath}"" ""${host}""", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(STARTUP_VBS(), vbs, 'ascii');
  return STARTUP_VBS();
}

function removeStartupVbs() {
  try { fs.unlinkSync(STARTUP_VBS()); return true; } catch { return false; }
}

/** 后台起宿主（优先用 install 同步到运行目录的那份，保证与开机自启跑的是同一份代码） */
function startDetached(extraArgs = []) {
  const inApp = path.join(APP_DIR, 'lib', 'host.mjs');
  const host = fs.existsSync(inApp) ? inApp : path.join(CODE_DIR, 'lib', 'host.mjs');
  const out = fs.openSync(HOST_LOG.replace(/host\.log$/, 'host-stdout.log'), 'a');
  const child = spawn(process.execPath, [host, ...extraArgs], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function waitHost(port = DEFAULT_PORT, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await hostAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 备好 Electron：已有就用，没有就按 dsh-pet 同款方式下载 */
async function ensureElectron() {
  const bin = electronBinary();
  if (fs.existsSync(bin)) return { ok: true, bin, note: '已存在' };
  let get;
  try { ({ downloadArtifact: get } = await import('@electron/get')); }
  catch { return { ok: false, note: '缺少 @electron/get，无法自动下载 Electron' }; }
  const version = process.env.PET_ELECTRON_VERSION || '38.0.0';
  say(`  正在下载 Electron ${version}（约 100MB，仅首次）…`);
  try {
    const zip = await get({ artifactName: 'electron', version, platform: process.platform, arch: process.arch });
    fs.mkdirSync(ELECTRON_DIR, { recursive: true });
    // 用系统自带的 Expand-Archive 解压，省掉一个依赖
    await ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${ELECTRON_DIR}' -Force`, 300000);
    return { ok: fs.existsSync(bin), bin, note: fs.existsSync(bin) ? '下载完成' : '解压后没找到可执行文件' };
  } catch (e) {
    return { ok: false, note: '下载失败：' + e.message };
  }
}

/** 备好 plugin：没有就从已安装的 dsh-pet 拷一份（npm 依赖里就带着） */
async function ensurePlugin() {
  if (fs.existsSync(HELPER_ENTRY)) return { ok: true, note: '已存在' };
  let src = null;
  try {
    const req = (await import('node:module')).createRequire(path.join(CODE_DIR, 'package.json'));
    src = path.dirname(req.resolve('dsh-pet/package.json'));
  } catch { /* 没装依赖 */ }
  if (!src) return { ok: false, note: '找不到 dsh-pet（请先 npm install，或把 dsh-pet 放到 ' + PLUGIN_DIR + '）' };
  say(`  从 ${src} 复制 dsh-pet（约 65MB，仅首次）…`);
  fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
  fs.cpSync(src, PLUGIN_DIR, { recursive: true });
  return { ok: fs.existsSync(HELPER_ENTRY), note: fs.existsSync(HELPER_ENTRY) ? '复制完成' : '复制后仍缺入口文件' };
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------
async function cmdDoctor() {
  say('\n== 环境自检 ==\n');

  const cc = await findCcSwitchProcess();
  say(cc ? ok(`CC Switch 正在运行（PID ${cc.pid}）`) : `- CC Switch 未运行（不影响安装，桌宠会在它启动时出现）`);
  const exe = await findCcSwitchExe();
  say(exe ? ok(`找到 CC Switch：${exe}`) : bad('没找到 cc-switch.exe（「打开 CC Switch」菜单会退化成打开网页）'));

  const db = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  if (fs.existsSync(db)) {
    say(ok(`CC Switch 数据库：${db}`));
    try {
      const { todayUsage } = await import('../lib/ccswitch.mjs');
      const u = await todayUsage();
      say(ok(`读库成功：今日 ${(u.tokens / 1e4).toFixed(0)} 万 token / ${u.requests} 次请求`));
    } catch (e) {
      say(bad(`读库失败：${e.message}（CC Switch 若升级改了表结构，请提 issue）`));
    }
  } else {
    say(bad(`找不到 ${db}`));
  }

  const p = patchesInPlace({ pluginDir: PLUGIN_DIR });
  if (p.total && p.ok === p.total) say(ok(`dsh-pet 补丁齐全（${p.ok}/${p.total}）`));
  else if (!fs.existsSync(PLUGIN_DIR)) say(bad('还没装 dsh-pet（跑 install）'));
  else say(bad(`补丁不全：${p.ok}/${p.total}，缺 ${p.missing.join(', ')}（跑 patch 重打）`));

  say(fs.existsSync(electronBinary()) ? ok(`Electron：${electronBinary()}`) : bad('缺 Electron（跑 install 自动下载，或设 PET_ELECTRON_PATH）'));

  const alive = await hostAlive();
  say(alive ? ok('宿主正在运行') : '- 宿主未运行');
  say(fs.existsSync(STARTUP_VBS()) ? ok(`开机自启已注册：${STARTUP_VBS()}`) : '- 未注册开机自启');
  say('');
}

async function cmdInstall(argv) {
  say('\n== 安装 dsh-pet-ccswitch ==\n');
  ensureDirs();

  say('[1/5] 准备 dsh-pet 插件');
  const pl = await ensurePlugin();
  say(pl.ok ? '  ' + ok(pl.note) : '  ' + bad(pl.note));

  say('[2/5] 打补丁');
  const st = applyPatches({ pluginDir: PLUGIN_DIR, quiet: true });
  say(`  applied=${st.applied} skipped=${st.skipped} failed=${st.failed}`);
  if (st.failed) say('  ! 有补丁没打上（上游可能改过），相关功能会退化成原版行为');

  say('[3/5] 准备 Electron');
  const el = await ensureElectron();
  say('  ' + (el.ok ? ok(el.note) : bad(el.note)));

  say('[4/5] 同步代码到运行目录');
  const app = syncApp();
  say('  ' + ok(app));

  say('[5/5] 注册开机自启');
  say('  ' + ok(writeStartupVbs(app)));

  say('\n启动…');
  if (await hostAlive()) say('  ' + ok('宿主已在运行'));
  else { startDetached(); say((await waitHost()) ? '  ' + ok('已启动') : '  ' + bad('启动超时，看日志：' + HOST_LOG)); }
  say('\n完成。桌宠会在 CC Switch 启动时出现、退出时消失。\n');
}

async function cmdStart() {
  if (await hostAlive()) return say(ok('宿主已在运行'));
  startDetached();
  say((await waitHost()) ? ok('已启动') : bad('启动超时，看日志：' + HOST_LOG));
}

async function cmdStop() {
  const pid = await hostPid();
  if (!pid) return say('- 宿主没在运行');
  try {
    // 必须限定 node.exe：否则命令行里恰好含 "host.mjs" 的其它进程（比如正在跑本命令的 shell）会被误杀
    await ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'host\\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }");
  } catch {}
  say(ok('已停止（桌宠窗口一并关闭）'));
}

async function cmdStatus() {
  const alive = await hostAlive();
  const pid = await hostPid();
  const cc = await findCcSwitchProcess();
  say(`宿主：${alive ? '运行中' : '未运行'}${pid ? ` (PID ${pid})` : ''}`);
  say(`CC Switch：${cc ? `运行中 (PID ${cc.pid})` : '未运行'}`);
  if (alive) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/dsh-pet-7340/balance`, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      const d = j.data || {};
      say(`今日：${((Number(d.total) || 0) / 1e4).toFixed(0)} 万 token / ${d.toppedUp} 次请求 / $${d.granted}`);
      if (d.balances && d.balances.length) say(`余额：${d.balances.join('  ')}`);
    } catch (e) { say('取用量失败：' + e.message); }
  }
}

function cmdPatch() {
  say('重新打补丁…');
  const st = applyPatches({ pluginDir: PLUGIN_DIR });
  say(`  applied=${st.applied} skipped=${st.skipped} failed=${st.failed}`);
  const p = patchesInPlace({ pluginDir: PLUGIN_DIR });
  say(p.ok === p.total ? ok(`补丁齐全 ${p.ok}/${p.total}`) : bad(`仍缺：${p.missing.join(', ')}`));
}

async function cmdUninstall(argv) {
  await cmdStop();
  say(removeStartupVbs() ? ok('已移除开机自启') : '- 没有开机自启项');
  if (argv.includes('--purge')) {
    const keep = [path.join(USER_DIR, 'main-config.json'), path.join(USER_DIR, 'memory.json')];
    for (const f of keep) if (fs.existsSync(f)) {
      const b = f + '.bak';
      try { fs.copyFileSync(f, b); say(`  配置已备份到 ${b}`); } catch {}
    }
    fs.rmSync(HOME, { recursive: true, force: true });
    say(ok(`已删除运行数据 ${HOME}`));
  } else {
    say(`运行数据保留在 ${HOME}（配置/记忆都在；要删加 --purge）`);
  }
}

// ---------------------------------------------------------------------------
const [, , cmd = 'status', ...rest] = process.argv;
const table = {
  install: cmdInstall, start: cmdStart, stop: cmdStop, status: cmdStatus,
  restart: async () => { await cmdStop(); await new Promise(r => setTimeout(r, 1200)); return cmdStart(); },
  patch: cmdPatch, doctor: cmdDoctor, uninstall: cmdUninstall,
};

if (!table[cmd]) {
  say('dsh-pet-ccswitch <install|start|stop|restart|status|patch|doctor|uninstall>');
  process.exit(1);
}
try { await table[cmd](rest); }
catch (e) { console.error('出错了：' + (e && e.stack ? e.stack : e)); process.exit(1); }
