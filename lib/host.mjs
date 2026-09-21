#!/usr/bin/env node
/**
 * dsh-pet 独立宿主 + 启动器
 * ---------------------------------------------------------------------------
 * 作用：顶替 DeepSeek Harness 的 Web 服务，只服务桌宠 dsh-pet 需要的那几个接口，
 *       并把「今日 token 用量」从 CC Switch 的数据库喂给桌宠的余额气泡。
 *
 * 用法：
 *   node host.mjs              # 起宿主 + 拉起桌宠桌面窗口（前台，Ctrl+C 退出）
 *   node host.mjs --no-pet     # 只起宿主（调试用）
 *   node host.mjs --port 3080  # 换端口
 *
 * 环境变量：
 *   PET_HOST_PORT     宿主端口（默认 3080）
 *   CCS_DB            cc-switch.db 路径（默认 ~/.cc-switch/cc-switch.db）
 *   PET_TIER_MAX      档位刻度上限（默认 1000）：账户余额到顶 = 第 0 档「钱袋满溢」，
 *                     归零 = 第 5 档「分文不剩」
 *   PET_PLATFORM      统计哪个客户端：claude / codex / gemini，空 = 全部（默认空）
 *   DSH_PET_PETS      桌宠列表（不设则读配置里的 pets）
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 用量与余额一律以 CC Switch 为准（读它的数据库、执行它配的 usage_script）
import { todayUsage, providerBalances, balanceLine } from './ccswitch.mjs';
// 代码/数据分离；跟随 CC Switch 生命周期；发现 cc-switch.exe 位置（都不写死路径）
import {
  HOME, PLUGIN_DIR as PLUGIN, USER_DIR as USERDIR, LOG_DIR as LOGDIR,
  HELPER_ENTRY as HELPER, electronBinary, ensureDirs, readRuntime, writeRuntime,
} from './paths.mjs';
import { findCcSwitchProcess } from './discover.mjs';

ensureDirs();
const ASSETS = path.join(PLUGIN, 'assets');
const ELECTRON = electronBinary();

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', process.env.PET_HOST_PORT || 3080));
const NO_PET = argv.includes('--no-pet');
/** 跟随 CC Switch 生命周期（它起 → 桌宠起；它退 → 桌宠退）。默认开，--no-follow / PET_FOLLOW=0 关。 */
const FOLLOW = !argv.includes('--no-follow') && process.env.PET_FOLLOW !== '0';
/** 跟随轮询间隔（ms） */
const FOLLOW_INTERVAL_MS = Math.max(500, Number(process.env.PET_FOLLOW_INTERVAL || 2000));
const CCS_DB_PATH = process.env.CCS_DB || path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
/** 档位刻度上限：账户余额 ≥ 这个数 = 第 0 档「钱袋满溢」，归零 = 第 5 档「分文不剩」。
 *  默认 1000（即 ¥0~1000 分 6 档），改 start-pet.cmd 里的 PET_TIER_MAX 即可。 */
const TIER_MAX = Number(process.env.PET_TIER_MAX || 1000);
const PLATFORM = process.env.PET_PLATFORM || '';

fs.mkdirSync(LOGDIR, { recursive: true });
const logFile = path.join(LOGDIR, 'host.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  if (process.env.PET_QUIET !== '1') console.log(line);
}

// ---------------------------------------------------------------------------
// JSONC → JSON（去注释与尾逗号；用状态机，避免误伤字符串里的 // 和 URL）
// ---------------------------------------------------------------------------
function parseJsonc(text) {
  let out = '';
  let inStr = false, inLine = false, inBlock = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // 去掉对象/数组里的尾逗号
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// 配置：包内默认 ← user/main-config.json 覆盖；memes 只保留图片真实存在的条目
// ---------------------------------------------------------------------------
function loadConfig() {
  const defaults = parseJsonc(fs.readFileSync(path.join(ASSETS, 'config.jsonc'), 'utf8'));
  let user = {};
  const userFile = path.join(USERDIR, 'main-config.json');
  if (fs.existsSync(userFile)) {
    try { user = JSON.parse(fs.readFileSync(userFile, 'utf8')); }
    catch (e) { log('user/main-config.json 解析失败，忽略：' + e.message); }
  }
  const cfg = { ...defaults, ...user };

  // memes：只保留 assets/memes/<key>.png 存在的条目
  if (cfg.memes && typeof cfg.memes === 'object') {
    const kept = {};
    for (const [k, v] of Object.entries(cfg.memes)) {
      const f = path.join(ASSETS, 'memes', k + '.png');
      if (fs.existsSync(f)) kept[k] = v;
      else log(`memes 条目「${k}」缺少图片，已剔除`);
    }
    cfg.memes = kept;
  }
  return cfg;
}

/** 宿主 /config 响应：按 pet id 分片（DSH 的原样约定） */
function configResponse() {
  const cfg = loadConfig();
  const out = {};
  const pets = Array.isArray(cfg.pets) && cfg.pets.length ? cfg.pets : [{ id: 'main', size: 462 }];
  for (const p of pets) out[String(p.id ?? 'main')] = cfg;
  return out;
}

/** 桌宠实例列表 → DSH_PET_PETS */
function petsEnv() {
  const cfg = loadConfig();
  const pets = Array.isArray(cfg.pets) ? cfg.pets : [];
  return JSON.stringify(
    pets
      .filter((p) => p && String(p.display ?? '').includes('desktop'))
      .map((p) => ({ id: String(p.id), size: Number(p.size) || 462 })),
  );
}

// ---------------------------------------------------------------------------
// 今日 token + 各服务商余额 —— 全部以 CC Switch 为准（实现见 ccswitch.mjs）
// ---------------------------------------------------------------------------
function human(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + ' 万';
  return String(n);
}

/** 当前在用的那家服务商的余额（气泡只用这一家） */
async function currentBalance() {
  const list = await providerBalances({ onlyCurrent: true });
  return list.find((x) => x.ok) || list[0] || null;
}

/** 余额行：只显示 CC Switch 当前在用的那一家（用户指定：用的哪个就显示哪个） */
async function balanceLines() {
  const b = await currentBalance();
  return b ? [balanceLine(b)] : [];
}

/** /balance 响应
 *  - total / granted / toppedUp → 气泡上的「今日 token / 花费 / 请求数」
 *  - balanceValue / tierMax     → 档位动画用：余额 ÷ 刻度（用户定的 ¥0~1000）
 *  - balances                   → 余额文案行
 */
async function balanceResponse() {
  try {
    const u = await todayUsage(PLATFORM);
    let cur = null;
    try { cur = await currentBalance(); } catch (e) { log('余额查询失败：' + e.message); }
    const balNum = cur && cur.ok ? (Number.isFinite(Number(cur.remaining)) ? Number(cur.remaining) : null) : null;
    return {
      ok: true,
      provider: 'cc-switch',
      kind: 'deepseek',
      data: {
        total: String(u.tokens),
        granted: u.cost.toFixed(4),
        toppedUp: String(u.requests),
        balances: cur ? [balanceLine(cur)] : [],
        balanceValue: balNum === null ? null : String(balNum),
        tierMax: String(TIER_MAX),
        _human: human(u.tokens),
      },
    };
  } catch (e) {
    log('今日用量查询失败：' + e.message);
    return { ok: false, provider: 'cc-switch', reason: 'fetch-error', message: e.message };
  }
}

// ---------------------------------------------------------------------------
// 碎碎念：菜单点了要真的说话 —— 走 CC Switch 的本地代理（Anthropic 兼容）
// ---------------------------------------------------------------------------
/** CC Switch 代理地址（它把请求转发到当前在用的服务商） */
const LLM_PROXY = process.env.PET_LLM_PROXY || 'http://127.0.0.1:15721';
const LLM_MODEL = process.env.PET_LLM_MODEL || 'claude-haiku-4-5';
/** 最近一句碎碎念；ts 变化桌宠才会弹气泡 */
let whisperCache = { ts: 0, text: '', image: '' };

/** 调一次模型（走 CC Switch 代理；它会把请求转发给当前在用的服务商） */
async function callModel(system, messages, maxTokens = 200) {
  const res = await fetch(`${LLM_PROXY}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'PROXY_MANAGED',
    },
    body: JSON.stringify({ model: LLM_MODEL, max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) throw new Error(`模型通道 HTTP ${res.status}`);
  if (j.error) throw new Error(j.error.message || '模型通道报错');
  const text = (Array.isArray(j.content) ? j.content : [])
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
    .trim();
  if (!text) throw new Error('模型没有返回文本');
  return { text, usage: j.usage || {} };
}

/** 人设 + 宠物名（碎碎念与对话共用） */
function persona() {
  const cfg = loadConfig();
  const petName = (cfg.pets && cfg.pets[0] && cfg.pets[0].name) || '桌宠';
  const p = cfg.whisperPrompt || '你是主人桌面上的小宠物。20 字以内，说人话，不要提你是 AI。';
  return { system: `${p}\n你的名字是「${petName}」。`, petName };
}

/** 生一句碎碎念 */
async function generateWhisper() {
  const { system } = persona();
  const { text, usage } = await callModel(system, [{ role: 'user', content: '说一句碎碎念' }]);
  log(`碎碎念生成成功（in ${usage.input_tokens ?? '?'} / out ${usage.output_tokens ?? '?'} token）：${text}`);
  return text;
}

// ---------------------------------------------------------------------------
// 对话：带记忆（user/memory.json，与 dsh-pet 原本的存法一致：全存不删）
// ---------------------------------------------------------------------------
const MEMORY_FILE = path.join(USERDIR, 'memory.json');

function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch { return {}; }
}
function saveMemory(m) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2)); }
  catch (e) { log('对话记忆写入失败：' + e.message); }
}
/** 记忆结构：mem[petId][petId].messages（与 dsh-pet 原格式一致） */
function memoryList(mem, petId) {
  mem[petId] = mem[petId] || {};
  mem[petId][petId] = mem[petId][petId] || { messages: [] };
  if (!Array.isArray(mem[petId][petId].messages)) mem[petId][petId].messages = [];
  return mem[petId][petId].messages;
}

async function chatResponse(petId, text) {
  if (!text) return { ok: false, reason: 'bad-request', message: '空消息' };
  const { system } = persona();
  const cfg = loadConfig();
  const rounds = Math.max(1, Number(cfg.chatMemoryRounds) || 5);
  const mem = loadMemory();
  const list = memoryList(mem, petId);
  const history = list
    .slice(-rounds * 2)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
  try {
    const { text: reply, usage } = await callModel(system, [...history, { role: 'user', content: text }]);
    const ts = Date.now();
    list.push({ role: 'user', content: text, ts });
    list.push({ role: 'assistant', content: reply, ts });
    saveMemory(mem);
    log(`对话回复（in ${usage.input_tokens ?? '?'} / out ${usage.output_tokens ?? '?'} token）：${reply}`);
    return { ok: true, reply };
  } catch (e) {
    log('对话生成失败：' + e.message);
    return { ok: false, reason: 'generate-error', message: e.message };
  }
}

/** 统一的 /whisper 响应；force=true 时强制重新生成 */
async function whisperResponse(force) {
  if (!force && whisperCache.text) return { ...whisperCache, ok: true };
  try {
    const text = await generateWhisper();
    whisperCache = { ts: Date.now(), text, image: '' };
    return { ok: true, ...whisperCache };
  } catch (e) {
    log('碎碎念生成失败：' + e.message);
    return { ok: false, reason: 'generate-error', message: e.message };
  }
}

// ---------------------------------------------------------------------------
// 素材：/thumb/<素材根>/<file>
//   素材根 = main（或某只宠物的 id）→ 先查用户目录 user/main-animation/，再查包内 assets/
//   其它 → 包内 assets/（pet pack 场景留了扩展位）
// ---------------------------------------------------------------------------
const MIME = { '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.cur': 'image/x-icon' };

function resolveAsset(root, file) {
  const name = path.basename(decodeURIComponent(file));
  const candidates = [];
  if (root === 'main' || root === '') {
    candidates.push(path.join(USERDIR, 'main-animation', name));
  } else {
    candidates.push(path.join(USERDIR, 'pet', `${root}-animation`, name));
  }
  candidates.push(path.join(ASSETS, name));
  candidates.push(path.join(ASSETS, 'webm', name));
  candidates.push(path.join(ASSETS, 'pic', name));
  candidates.push(path.join(ASSETS, 'memes', name));
  candidates.push(path.join(ASSETS, 'fonts', name));
  candidates.push(path.join(USERDIR, 'main-animation', 'webm', name));
  candidates.push(path.join(USERDIR, 'main-animation', 'mov', name));
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
const PREFIX = '/dsh-pet-7340';
/** 手动展示计数：桌宠每秒轮询它，变了就弹一次气泡 */
let balanceTriggerCount = 0;

/** 读 JSON 请求体（对话用；上限 1MB 足够） */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/** 把磁盘文件直接吐给响应；不存在回 404 */
function serveFile(abs, res, send) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return send(404, 'not found: ' + path.basename(abs), 'text/plain; charset=utf-8');
  }
  const st = fs.statSync(abs);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  log(`${req.method} ${p}`);

  const send = (code, body, type = 'application/json; charset=utf-8') => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  };

  try {
    if (p === `${PREFIX}/config` || p === `${PREFIX}/config.jsonc`) {
      return send(200, configResponse());
    }
    if (p === `${PREFIX}/balance`) {
      return send(200, await balanceResponse());
    }
    if (p === `${PREFIX}/balances`) {
      // 全量余额明细（不去重），供命令行 / 调试查看
      return send(200, await providerBalances({ force: new URL(req.url, 'http://x').searchParams.has('force') }));
    }
    if (p === `${PREFIX}/balance/trigger`) {
      // 桌宠每秒轮询这个计数，值一变就立刻重拉 /balance 并弹气泡。
      // 计数只在「手动要求展示」时 +1（见下方 /ctl/show），所以不会自己乱弹。
      return send(200, { count: balanceTriggerCount });
    }
    if (p === `${PREFIX}/work-status`) {
      return send(200, { state: null, task: null, ts: Date.now() });
    }
    if (p === `${PREFIX}/broadcast`) {
      // 斜杠命令广播通道：脱离 DSH 后没有会话可广播，恒定回「无广播」
      return send(200, { ts: 0 });
    }
    if (p === `${PREFIX}/whisper`) {
      return send(200, await whisperResponse(false));
    }
    if (p === `${PREFIX}/whisper/trigger`) {
      return send(200, await whisperResponse(true)); // 右键「碎碎念」点了要立刻说一句
    }
    if (p === `${PREFIX}/chat` && req.method === 'POST') {
      const body = await readJsonBody(req);
      const firstPet = (loadConfig().pets || [{ id: 'main' }])[0];
      return send(200, await chatResponse(String(firstPet.id ?? 'main'), String(body.text || '').trim()));
    }
    if (p.startsWith(`${PREFIX}/chat`)) {
      return send(400, { ok: false, reason: 'bad-request', message: '请用 POST' });
    }
    if (p.startsWith(`${PREFIX}/pic/`)) {
      const rel = p.slice(`${PREFIX}/pic/`.length);
      // /pic/memes/<名>.png 走表情包目录，其余（光标等）走 assets/pic
      const abs = rel.startsWith('memes/')
        ? path.join(ASSETS, 'memes', path.basename(rel))
        : path.join(ASSETS, 'pic', path.basename(rel));
      return serveFile(abs, res, send);
    }
    if (p.startsWith(`${PREFIX}/font/`)) {
      return serveFile(path.join(ASSETS, 'fonts', path.basename(p.slice(`${PREFIX}/font/`.length))), res, send);
    }
    if (p === '/ctl/show') {
      // 手动催一次今日用量气泡（快捷方式/命令行调用）
      balanceTriggerCount += 1;
      log('手动触发用量展示，count=' + balanceTriggerCount);
      return send(200, { ok: true, count: balanceTriggerCount });
    }
    if (p.startsWith(`${PREFIX}/thumb/`)) {
      const rest = p.slice(`${PREFIX}/thumb/`.length);
      const slash = rest.indexOf('/');
      if (slash < 0) return send(400, 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>', 'text/plain; charset=utf-8');
      const root = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      const abs = resolveAsset(root, file);
      if (!abs) return send(404, 'not found', 'text/plain; charset=utf-8');
      const st = fs.statSync(abs);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=86400',
      });
      return fs.createReadStream(abs).pipe(res);
    }
    return send(404, 'dsh-pet: unknown route ' + p, 'text/plain; charset=utf-8');
  } catch (e) {
    log('handler error: ' + (e && e.stack ? e.stack : e));
    return send(500, { ok: false, message: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
// 重复启动保护：端口被占说明宿主已经在跑，本次安静退出（避免开机自启与手动启动打架）
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 被占用 —— 宿主已在运行，本次退出`);
    process.exit(0);
  }
  log('宿主错误：' + e.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// 桌宠窗口：启动 / 跟随 CC Switch 生命周期
// ---------------------------------------------------------------------------
let petChild = null;

/** 拉起桌宠窗口（已在运行则复用） */
function startPet() {
  if (petChild && petChild.exitCode === null) return petChild;
  if (!fs.existsSync(ELECTRON)) { log('找不到 electron：' + ELECTRON); return null; }
  if (!fs.existsSync(HELPER)) { log('找不到桌宠程序：' + HELPER); return null; }
  const ccExe = readRuntime().ccSwitchExe || ''; // 菜单「打开 CC Switch」用发现到的路径，不写死
  petChild = spawn(ELECTRON, [HELPER], {
    cwd: path.join(PLUGIN, 'runtime', 'electron-helper'),
    env: {
      ...process.env,
      DSH_PET_CONFIG_URL: `http://127.0.0.1:${PORT}${PREFIX}/config`,
      DSH_PET_PETS: petsEnv(),
      DSH_PET_ELECTRON_PATH: ELECTRON,
      ...(ccExe ? { CC_SWITCH_EXE: ccExe } : {}),
    },
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mine = petChild;
  mine.stdout.on('data', (d) => log('[pet] ' + String(d).trim()));
  mine.stderr.on('data', (d) => log('[pet:err] ' + String(d).trim()));
  mine.on('exit', (code, signal) => {
    if (petChild === mine) petChild = null;
    log(`桌宠窗口退出（code=${code}${signal ? ' signal=' + signal : ''}）`);
  });
  log('桌宠窗口已拉起');
  return mine;
}

function stopPet(reason) {
  if (!petChild || petChild.exitCode !== null) { petChild = null; return; }
  log('关闭桌宠窗口' + (reason ? `（${reason}）` : ''));
  try { petChild.kill(); } catch (e) { log('关闭桌宠失败：' + e.message); }
  petChild = null;
}

/**
 * 跟随模式：以「CC Switch 进程在不在」为唯一判据 ——
 * 跟它的版本、安装路径、界面实现都无关，所以它怎么升级都适配。
 */
function startFollow() {
  const MISS_LIMIT = 3; // 连续探不到几次才算真退出（容忍它自己重启/卡顿抖动）
  let misses = 0;
  let announced = false;
  const tick = async () => {
    const cc = await findCcSwitchProcess();
    if (cc) {
      misses = 0;
      if (cc.exe) writeRuntime({ ccSwitchExe: cc.exe }); // 顺手更新 exe 路径（升级换目录也能跟上）
      if (!petChild || petChild.exitCode !== null) {
        if (!announced) { log('检测到 CC Switch 在运行 → 拉起桌宠'); announced = true; }
        startPet();
      }
    } else {
      if (announced) log('CC Switch 不在运行，等待…');
      announced = false;
      misses++;
      if (misses === MISS_LIMIT) stopPet('CC Switch 已退出');
    }
    setTimeout(tick, FOLLOW_INTERVAL_MS);
  };
  log(`跟随模式已开启（每 ${FOLLOW_INTERVAL_MS / 1000}s 检查一次 CC Switch）`);
  tick();
}

server.listen(PORT, '127.0.0.1', async () => {
  log(`宿主已启动  http://127.0.0.1:${PORT}${PREFIX}/config`);
  const cfg = loadConfig();
  const pets = (cfg.pets || []).map((x) => `${x.name || x.id}(${x.display})`).join(', ');
  log(`宠物：${pets}   档位刻度：账户余额 0 ~ ${TIER_MAX}`);
  try {
    const c = await currentBalance();
    log(`当前服务商：${c ? c.name : '未知'}   余额：${c && c.ok ? c.display || c.remaining : (c ? c.message : '查询失败')}`);
  } catch (e) {
    log('当前服务商余额查询失败：' + e.message);
  }
  try {
    const u = await todayUsage();
    log(`今日用量：${human(u.tokens)} token / ${u.requests} 次请求 / $${u.cost.toFixed(4)}`);
  } catch (e) {
    log('今日用量查询失败：' + e.message);
  }

  if (NO_PET) return;
  if (FOLLOW) startFollow();
  else startPet();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到 ' + sig + '，退出');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
