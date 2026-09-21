/**
 * ccswitch.mjs —— 一切以 CC Switch 为准
 * ---------------------------------------------------------------------------
 * 这里不自己发明任何"怎么查余额"的规则，而是：
 *   1. 读取 CC Switch 自己的数据库 ~/.cc-switch/cc-switch.db
 *   2. 取出每个服务商 meta 里配好的 usage_script（CC Switch 界面上配的就是它）
 *   3. 按它声明的 request 发请求，再把响应交给它自己的 extractor 解析
 * 这样 CC Switch 里改了配置/加了解析规则，桌宠这边自动跟着变。
 *
 * 用量（今日 token）同样来自它的 proxy_request_logs（所有 Claude Code 流量都过它的本地代理）。
 *
 * usage_script 契约（与 CC Switch 一致）：
 *   ({ request: { url, method, headers, body? },
 *      extractor: function (response) -> {planName, remaining, used, total, unit, extra}
 *                                     | {isValid:false, invalidMessage} })
 *   模板变量：{{baseUrl}} {{accessToken}} {{apiKey}} {{userId}}
 *   templateType === 'balance' 且 code 为空 = CC Switch 内置的余额查询（如 DeepSeek）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CCS_DB = process.env.CCS_DB || path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

let sqliteMod = null;
async function loadSqlite() {
  if (!sqliteMod) sqliteMod = await import('node:sqlite');
  return sqliteMod;
}

/** 打开数据库；直读失败（被 CC Switch 独占）就复制一份再读 */
export async function withDb(fn) {
  const { DatabaseSync } = await loadSqlite();
  let db, tmp = null;
  try {
    try {
      db = new DatabaseSync(CCS_DB, { readOnly: true });
    } catch {
      tmp = path.join(os.tmpdir(), `ccs-${Date.now()}.db`);
      await fsp.copyFile(CCS_DB, tmp);
      db = new DatabaseSync(tmp, { readOnly: true });
    }
    return await fn(db);
  } finally {
    try { db?.close(); } catch {}
    if (tmp) fsp.unlink(tmp).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 今日 token 用量
// ---------------------------------------------------------------------------
export async function todayUsage(platformFilter = '') {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const lo = Math.floor(midnight.getTime() / 1000); // created_at 单位是「秒」
  const where = platformFilter ? 'created_at >= ? AND app_type = ?' : 'created_at >= ?';
  const args = platformFilter ? [lo, platformFilter] : [lo];
  const sql = `SELECT COUNT(*) n,
      COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,
      COALESCE(SUM(cache_read_tokens),0) cr, COALESCE(SUM(cache_creation_tokens),0) cw,
      COALESCE(SUM(CAST(input_cost_usd AS REAL)+CAST(output_cost_usd AS REAL)
                 + CAST(cache_read_cost_usd AS REAL)+CAST(cache_creation_cost_usd AS REAL)),0) cost
     FROM proxy_request_logs WHERE ${where}`;
  return withDb((db) => {
    const row = db.prepare(sql).get(...args);
    return {
      tokens: Number(row.i) + Number(row.o) + Number(row.cr) + Number(row.cw),
      requests: Number(row.n),
      cost: Number(row.cost),
    };
  });
}

// ---------------------------------------------------------------------------
// 服务商余额 / 额度
// ---------------------------------------------------------------------------

/** 把 settings_config 里的 base_url / 凭证抽出来，供 usage_script 的模板变量用 */
function extractVars(settingsConfig) {
  let j = {};
  try { j = JSON.parse(settingsConfig || '{}'); } catch {}
  const env = j.env || {};
  const auth = j.auth || {};
  const conf = typeof j.config === 'string' ? j.config : '';

  let base = env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL || env.GOOGLE_GEMINI_BASE_URL || '';
  if (!base && conf) {
    const m = conf.match(/base_url\s*=\s*"([^"]+)"/);
    if (m) base = m[1];
  }
  // 去掉 API 路径后缀，还原成站点根（CC Switch 的模板也是这么用的）
  base = String(base).replace(/\/+$/, '').replace(/\/(anthropic|openai|v1|v3|api)$/i, '');

  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
    || auth.OPENAI_API_KEY || env.OPENAI_API_KEY
    || env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';

  return { baseUrl: base, accessToken: token, apiKey: token, userId: '' };
}

/** 模板替换：{{baseUrl}} / {{accessToken}} / {{apiKey}} / {{userId}} */
function fill(tpl, vars) {
  return String(tpl ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ''));
}

/** templateType === 'balance' 且没写脚本时，CC Switch 内置的余额查询（带一次重试，抗网络抖动） */
async function builtinBalance(vars) {
  const url = `${vars.baseUrl}/user/balance`;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800));
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${vars.accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) { lastErr = `HTTP ${res.status}`; continue; }
      const info = Array.isArray(body.balance_infos) ? body.balance_infos[0] : null;
      if (!info) { lastErr = body.message || '余额结构不认识'; continue; }
      const sym = info.currency === 'CNY' ? '¥' : (info.currency === 'USD' ? '$' : info.currency + ' ');
      return {
        planName: '余额',
        remaining: Number(info.total_balance),
        total: Number(info.total_balance),
        used: 0,
        unit: '',
        extra: '',
        display: sym + info.total_balance,
        isAvailable: body.is_available !== false,
      };
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? '查询超时' : e.message;
    }
  }
  return { isValid: false, invalidMessage: lastErr || '查询失败' };
}

/** 执行一个服务商的 usage_script */
async function runUsageScript(script, vars) {
  // templateType 'balance' + 空 code = 内置
  if ((!script.code || !script.code.trim()) && script.templateType === 'balance') {
    return builtinBalance(vars);
  }
  if (!script.code || !script.code.trim()) {
    return { isValid: false, invalidMessage: '该服务商没有可用的用量脚本' };
  }

  let spec;
  try {
    // CC Switch 的脚本就是一段返回 {request, extractor} 的 JS 表达式，直接求值
    spec = new Function(`"use strict";return (${script.code});`)();
  } catch (e) {
    return { isValid: false, invalidMessage: '脚本解析失败: ' + e.message };
  }
  const req = spec.request || {};
  const url = fill(req.url, vars);
  if (!url) return { isValid: false, invalidMessage: '脚本没给出 URL' };

  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) headers[k] = fill(v, vars);

  let body = null;
  if (req.body != null) body = typeof req.body === 'string' ? fill(req.body, vars) : JSON.stringify(req.body);

  const res = await fetch(url, {
    method: (req.method || 'GET').toUpperCase(),
    headers,
    body,
    signal: AbortSignal.timeout((script.timeout || 10) * 1000),
  });
  const json = await res.json().catch(() => null);
  const responded = json ?? { _httpStatus: res.status };
  if (typeof spec.extractor === 'function') {
    return spec.extractor(responded);
  }
  return { isValid: false, invalidMessage: '脚本没有 extractor' };
}

/** CC Switch 当前实际在用的服务商 —— 取它代理日志里最近一条请求走的是谁（最准） */
export async function currentProviderRef() {
  return withDb((db) => {
    const r = db
      .prepare('SELECT provider_id, app_type FROM proxy_request_logs ORDER BY created_at DESC LIMIT 1')
      .get();
    if (!r || !r.provider_id) return null;
    const p = db
      .prepare('SELECT id, app_type, name FROM providers WHERE id = ? AND app_type = ?')
      .get(r.provider_id, r.app_type);
    if (p) return p;
    return (
      db.prepare('SELECT id, app_type, name FROM providers WHERE id = ? LIMIT 1').get(r.provider_id) || null
    );
  });
}

/** 汇总：把所有「启用了用量脚本」的服务商查一遍（成功结果缓存 3 分钟，失败只缓存 30 秒） */
let balanceCache = { at: 0, data: null, current: null, ttl: 0 };
const BALANCE_TTL_MS = 3 * 60 * 1000;
const BALANCE_TTL_FAIL_MS = 30 * 1000;

/** onlyCurrent = true 时只查 CC Switch 当前在用的那一家 */
export async function providerBalances({ force = false, onlyCurrent = false } = {}) {
  if (!force && balanceCache.data && Date.now() - balanceCache.at < balanceCache.ttl) {
    return onlyCurrent ? onlyOf(balanceCache.data, balanceCache.current) : balanceCache.data;
  }

  const rows = await withDb((db) =>
    db.prepare('SELECT id, app_type, name, meta, settings_config, is_current FROM providers').all(),
  );

  // 同名服务商在多个客户端里重复登记（claude / claude-desktop / codex 共用一个 id）→ 按 id 去重
  const seen = new Map();
  for (const r of rows) {
    let meta = {};
    try { meta = JSON.parse(r.meta || '{}'); } catch {}
    const script = meta.usage_script;
    if (!script || !script.enabled) continue;
    const key = r.id;
    // 优先保留当前在用的那个客户端登记
    if (seen.has(key) && !(r.is_current && !seen.get(key).isCurrent)) continue;
    seen.set(key, { row: r, script, isCurrent: !!r.is_current });
  }

  const out = [];
  for (const { row, script, isCurrent } of seen.values()) {
    const vars = extractVars(row.settings_config);
    if (!vars.baseUrl || !vars.accessToken) {
      out.push({ id: row.id, name: row.name, app: row.app_type, isCurrent, ok: false, message: '缺 base_url 或凭证' });
      continue;
    }
    try {
      const r = await runUsageScript(script, vars);
      out.push({ id: row.id, name: row.name, app: row.app_type, isCurrent, template: script.templateType, ...r,
                 ok: r && r.isValid !== false });
    } catch (e) {
      out.push({ id: row.id, name: row.name, app: row.app_type, isCurrent, ok: false,
                 message: e.name === 'TimeoutError' ? '查询超时' : e.message });
    }
  }

  const cur = await currentProviderRef();
  const allOk = out.length > 0 && out.every((b) => b.ok);
  balanceCache = {
    at: Date.now(),
    data: out,
    current: cur,
    // 全成功 → 正常缓存；有失败 → 短缓存，30 秒后自动重试（避免一次网络抖动显示三分钟"失败"）
    ttl: allOk ? BALANCE_TTL_MS : BALANCE_TTL_FAIL_MS,
  };
  return onlyCurrent ? onlyOf(out, cur) : out;
}

/** 从全量结果里挑出「当前在用」的那一条 */
function onlyOf(list, cur) {
  if (cur) {
    const hit = list.filter((b) => b.id === cur.id);
    if (hit.length) return hit;
  }
  const byFlag = list.filter((b) => b.isCurrent);
  if (byFlag.length) return byFlag;
  return list.slice(0, 1);
}

/** 把一个服务商查出来的结果压成一行短文案，给桌宠气泡用 */
export function balanceLine(b) {
  if (!b.ok) return `${b.name} 余额查询失败`;
  if (b.display) return `${b.name} ${b.display}`;                       // 内置余额（DeepSeek）
  const unit = b.unit === 'credits' || b.unit === 'USD' || b.unit === 'CNY' ? b.unit : (b.unit || '');
  const num = (x) => (typeof x === 'number' ? (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100) : x);
  if (b.remaining != null) {
    if (b.unit === 'credits') return `${b.planName || b.name} 剩 ${num(b.remaining)}/${num(b.total)} ${unit}`.trim();
    return `${b.name} 剩 ${num(b.remaining)} ${unit}`.trim();
  }
  return `${b.name} ${b.planName || '已查询'}`;
}
