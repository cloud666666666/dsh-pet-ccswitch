/**
 * tokens.mjs —— token 计量表：把 CC Switch 里的真实用量喂给养成引擎
 *
 * 为什么单独一个模块：引擎的每分钟结算是**同步**的，而读库是异步的（node:sqlite 的
 * 动态 import）。所以这里后台每 15 秒拉一次，把新发生的用量攒进累加器；
 * 引擎到点 `take()` 一次，拿走并清零。宿主没跑的那段时间没人拉，也就不会被补算 ——
 * 跟「关掉就不算」的口径一致（qqpet 也是关掉不算在线时长）。
 *
 * 水位与去重：按 request_id 去重（同一条日志只算一次），水位取见过的最大 created_at。
 * 只按 `created_at > 水位` 会漏掉与水位同一秒内后到的行，所以查的是 `>= 水位`，靠 id 集合兜住。
 */
import { withDb } from '../ccswitch.mjs';

/** 记住多少条 request_id 用于去重（够覆盖同一秒的并发了） */
const SEEN_MAX = 500;

export function createTokenMeter({ since = 0, platform = '', intervalMs = 15_000, onError = null } = {}) {
  let watermark = Number(since) || 0;
  let acc = { tokens: 0, requests: 0 };
  let seen = new Set();
  let timer = null;
  let stopped = false;

  const sql = (where) =>
    `SELECT request_id, created_at,
            COALESCE(input_tokens,0)+COALESCE(output_tokens,0)
            +COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0) AS tok
       FROM proxy_request_logs WHERE ${where}`;

  async function pull() {
    try {
      const rows = await withDb((db) => {
        const where = platform ? 'created_at >= ? AND app_type = ?' : 'created_at >= ?';
        const args = platform ? [watermark, platform] : [watermark];
        return db.prepare(sql(where) + ' ORDER BY created_at').all(...args);
      });
      for (const r of rows) {
        const ts = Number(r.created_at) || 0;
        const secs = ts > 1e11 ? Math.floor(ts / 1000) : ts;
        if (seen.has(r.request_id)) continue;
        seen.add(r.request_id);
        acc.tokens += Number(r.tok) || 0;
        acc.requests += 1;
        if (secs > watermark) watermark = secs;
      }
      if (seen.size > SEEN_MAX) seen = new Set([...seen].slice(-SEEN_MAX));
    } catch (e) {
      onError?.(e);
    }
  }

  return {
    /** 拿走这段时间攒下的用量并清零（引擎每分钟叫一次） */
    take() {
      const t = { ...acc };
      acc = { tokens: 0, requests: 0 };
      return t;
    },
    /** 看一眼还没被取走的量（status 命令用） */
    peek: () => ({ ...acc }),
    /** 当前水位（存档里记住它，重启后不会把历史流量重算一遍） */
    get ts() {
      return watermark;
    },
    /** 把水位往回拨（导入旧存档/换库时用） */
    set ts(v) {
      watermark = Number(v) || 0;
      seen = new Set();
    },
    pull,
    start() {
      if (timer) return;
      stopped = false;
      void pull();
      timer = setInterval(() => void pull(), intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
