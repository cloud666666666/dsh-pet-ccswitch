/**
 * calendar.mjs —— 今天的农历/节气/节假日
 *
 * 两个数据源，用 `PET_RAISE_CALENDAR` 选：
 *   off（默认）   不联网：放假只按周末算（qqpet 离线时也是这么兜底的）
 *   holiday-cn    **推荐**：节假日（含调休）取自 jsDelivr 上的
 *                 NateScarlet/holiday-cn（每年国务院放假通知的整理版，纯 JSON，国内可直连）；
 *                 节气用天文公式在本机算，不联网
 *   ankio         qqpet 原本用的 api.ankio.net（还能多给农历），实测国内连不上，
 *                 留给网络到得了的人
 *
 * 隐私：holiday-cn 那一档只下载"当年放假安排"这一个公开文件（不带任何你的信息），
 * 所以它比 ankio 干净得多 —— 后者要按日期逐个查。
 */
const ANKIO_API = 'https://api.ankio.net/day?ymd=';
const HOLIDAY_CN = 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/';
const DAYS = 31; // 今天 + 未来 30 天（qqpet 也是拉这么多，好找"下一个放假的日子"）

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// 节气：太阳视黄经每走 15° 就是一个节气，本机算（Meeus 低精度公式 + 二分，误差 < 1 分钟）
// ---------------------------------------------------------------------------
const TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
];

/** 太阳视黄经（度）；jde 是儒略日（这里当力学时用，ΔT 一分多钟，对"哪天"没影响） */
function sunLongitude(jde) {
  const T = (jde - 2451545.0) / 36525;
  const rad = Math.PI / 180;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * rad;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M) +
    0.000289 * Math.sin(3 * M);
  const omega = (125.04 - 1934.136 * T) * rad;
  return (((L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) % 360) + 360) % 360;
}

/** 某年第 index 个节气（0 = 小寒）落在哪一天（按东八区），返回 'YYYY-MM-DD' */
function termDate(year, index) {
  const target = (285 + index * 15) % 360; // 小寒在黄经 285°
  const jdOf = (t) => t / 86400000 + 2440587.5; // 毫秒时间戳 → 儒略日
  // 二分：[lo, hi] 取在该节气附近 ±20 天，函数在该窗口内单调过零
  let lo = Date.UTC(year, 0, 1) + (index / 24) * 365.2422 * 86400000 - 25 * 86400000;
  let hi = lo + 50 * 86400000;
  const f = (t) => (((sunLongitude(jdOf(t)) - target + 180) % 360) + 360) % 360 - 180;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  // 关键：这里已经手动加了 8 小时（换算成东八区挂钟），**必须用 UTC 读数**——
  // 用本机时区读（getFullYear 等）会在 UTC+8 的机器上再加一遍，节气整体晚一天
  const t = new Date((lo + hi) / 2 + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** 某年的 24 个节气 → { 'YYYY-MM-DD': '霜降' }（算一次缓存着） */
const termCache = new Map();
function termsOf(year) {
  if (!termCache.has(year)) {
    const map = {};
    for (let i = 0; i < 24; i++) map[termDate(year, i)] = TERM_NAMES[i];
    termCache.set(year, map);
  }
  return termCache.get(year);
}

/** 这一天是什么节气（没有就 null） */
export const termOf = (date) => termsOf(date.getFullYear())[ymd(date)] ?? null;

/** 当年（以及跨年时下一年）的放假安排：{ 'YYYY-MM-DD': {name, off} } */
async function holidayCn(year) {
  const r = await fetch(`${HOLIDAY_CN}${year}.json`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`holiday-cn HTTP ${r.status}`);
  const j = await r.json();
  const map = {};
  for (const d of j.days ?? []) map[d.date] = { name: d.name, off: Boolean(d.isOffDay) };
  return map;
}

export function createCalendar({ mode = 'off', log = console.log } = {}) {
  const src = String(mode || 'off').trim();
  const on = src === 'ankio' || src === 'holiday-cn';
  let cache = { date: '', days: [] };
  let inflight = null;
  let warned = false;

  async function fetchDay(date) {
    const r = await fetch(ANKIO_API + date, { signal: AbortSignal.timeout(10_000) });
    const { data: d } = await r.json();
    const h = Array.isArray(d.holidays) ? null : d.holidays;
    return {
      date,
      lunar: `${d.lunar_month_chinese}${d.lunar_day_chinese}`,
      term: d.term,
      holiday: h ? { name: h.name, off: h.isOffDay } : null,
    };
  }

  /** holiday-cn 源：节假日查表 + 节气本机算（农历这一档没有，空着） */
  async function loadHolidayCn(n) {
    const year = n.getFullYear();
    const maps = [await holidayCn(year)];
    // 窗口跨年的话，下一年的安排也要
    if (n.getMonth() === 11) maps.push(await holidayCn(year + 1));
    const all = Object.assign({}, ...maps);
    const days = [];
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + i);
      const date = ymd(d);
      days.push({ date, lunar: '', term: termOf(d), holiday: all[date] ?? null });
    }
    return days;
  }

  /** 拉一次今天的（以及未来 30 天）；失败就静默退回"没日历"，下次再试 */
  async function load() {
    if (!on) return null;
    const n = new Date();
    const date = ymd(n);
    if (cache.date === date && cache.days.length) return cache.days[0];
    if (inflight) return inflight;
    const fetchAll =
      src === 'holiday-cn'
        ? loadHolidayCn(n)
        : Promise.all(Array.from({ length: DAYS }, (_, i) => fetchDay(ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate() + i)))));
    inflight = fetchAll
      .then((days) => {
        cache = { date, days };
        return days[0];
      })
      .catch((e) => {
        if (!warned) {
          warned = true;
          log(`[raise] 日历拿不到（今日任务将按周末算放假）：${e.message}`);
        }
        return null;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    enabled: on,
    source: src,
    load,
    /** 今天那条（没拉到就是 undefined） */
    today: () => (cache.date === ymd(new Date()) ? cache.days[0] : undefined),
    days: () => (cache.date === ymd(new Date()) ? cache.days : []),
    /** 还有几天到下一个放假的日子（qqpet 的 dateTalk 用） */
    nextHoliday() {
      const [today, ...rest] = cache.days;
      const i = rest.findIndex((d) => d.holiday?.off && d.holiday.name !== today?.holiday?.name);
      return i < 0 ? null : { days: i + 1, name: rest[i].holiday.name };
    },
  };
}

/** 「星期三，农历八月十八，国庆节放假，寒露」这样一句（qqpet 的 dayText） */
export function dayText(cal) {
  const WEEK = '日一二三四五六';
  const week = `星期${WEEK[new Date().getDay()]}`;
  const d = cal?.today?.();
  if (!d) return week;
  return [
    week,
    d.lunar && `农历${d.lunar}`,
    d.holiday && (d.holiday.off ? `${d.holiday.name}放假` : `${d.holiday.name}调休上班`),
    d.term,
  ]
    .filter(Boolean)
    .join('，');
}

/** 节日/节气那一句（qqpet 的 festival） */
export function festival(d) {
  if (!d) return null;
  if (d.holiday?.off) return `[host]，今天是${d.holiday.name}，放假啦！祝你${d.holiday.name}快乐，今天要好好玩哦~`;
  if (d.holiday) return `[host]，今天${d.holiday.name}调休要上班，辛苦啦，我给你加油！`;
  if (d.term) return `[host]，今天是${d.term}，换季了要注意身体哦~`;
  return null;
}
