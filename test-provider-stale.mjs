/**
 * 验证 currentProviderRef 的「没流量 → 信 CC Switch 选中项」这条新逻辑。
 * 用一份 cc-switch.db 的副本，把 15:41 之后的请求全删掉 —— 复刻用户 16:17~16:19
 * 「cc-switch 已切到 DeepSeek，但还没有任何新流量」的状态。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MOD = pathToFileURL(path.join(HERE, 'lib', 'ccswitch.mjs')).href;

const REAL = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const TMP = path.join(os.tmpdir(), 'ccs-stale-test.db');
fs.copyFileSync(REAL, TMP);

const CUTOFF = 1790754069; // 2026-09-30 15:41:09 本地 —— 最后一条走 "DeepSeek copy" 的请求
const db = new DatabaseSync(TMP);
const n = db.prepare('DELETE FROM proxy_request_logs WHERE created_at > ?').run(CUTOFF).changes;
const newest = db.prepare(
  "SELECT p.name, datetime(l.created_at,'unixepoch','localtime') t " +
  'FROM proxy_request_logs l JOIN providers p ON p.id = l.provider_id ORDER BY l.created_at DESC LIMIT 1'
).get();
db.close();
console.log(`[场景] 删掉 15:41 之后的 ${n} 条请求；此刻最新一条流量是：${newest.name} @ ${newest.t}\n`);

let i = 0;
async function probe(label, { db: dbPath, freshMin }) {
  process.env.CCS_DB = dbPath;
  if (freshMin === undefined) delete process.env.PET_PROVIDER_FRESH_MIN;
  else process.env.PET_PROVIDER_FRESH_MIN = String(freshMin);
  const m = await import(`${MOD}?n=${i++}`); // 加 query 破缓存，让模块级常量重新求值
  const p = await m.currentProviderRef();
  console.log(`${label.padEnd(44)} → ${p ? `${p.name}  (app=${p.app_type})` : 'null'}`);
}

await probe('旧行为：只认流量 (FRESH_MIN=100000)', { db: TMP, freshMin: 100000 });
await probe('新行为：默认 10 分钟窗口', { db: TMP, freshMin: undefined });
await probe('强制听 cc-switch 选中项 (FRESH_MIN=0)', { db: TMP, freshMin: 0 });
await probe('真实库（16:19 后有新流量）', { db: REAL, freshMin: undefined });

fs.unlinkSync(TMP);
