/**
 * calendar.mjs —— 今天的农历/节气/节假日（qqpet `src/shared/calendar.ts` 的移植）
 *
 * 为什么默认关闭：这份数据来自 qqpet 作者自己搭的接口（api.ankio.net），
 * 桌宠照搬就等于**把你的日期发给第三方**。所以默认 `off` —— 那几处（今日任务算不算放假、
 * 节日问候、节假日邮件）退化成"按周末算"，这也是 qqpet 在离线时的兜底行为。
 *
 * 想要真实节假日（含调休）就设 `PET_RAISE_CALENDAR=ankio`，
 * 走的就是 qqpet 那一条：`api.ankio.net/day?ymd=YYYY-MM-DD`。
 */
const API = 'https://api.ankio.net/day?ymd=';
const DAYS = 31; // 今天 + 未来 30 天（qqpet 也是拉这么多，好找"下一个放假的日子"）

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function createCalendar({ mode = 'off', log = console.log } = {}) {
  const on = mode === 'ankio';
  let cache = { date: '', days: [] };
  let inflight = null;
  let warned = false;

  async function fetchDay(date) {
    const r = await fetch(API + date, { signal: AbortSignal.timeout(10_000) });
    const { data: d } = await r.json();
    const h = Array.isArray(d.holidays) ? null : d.holidays;
    return {
      date,
      lunar: `${d.lunar_month_chinese}${d.lunar_day_chinese}`,
      term: d.term,
      holiday: h ? { name: h.name, off: h.isOffDay } : null,
    };
  }

  /** 拉一次今天的（以及未来 30 天）；失败就静默退回"没日历"，下次再试 */
  async function load() {
    if (!on) return null;
    const n = new Date();
    const date = ymd(n);
    if (cache.date === date && cache.days.length) return cache.days[0];
    if (inflight) return inflight;
    inflight = Promise.all(Array.from({ length: DAYS }, (_, i) => fetchDay(ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate() + i)))))
      .then((days) => {
        cache = { date, days };
        return days[0];
      })
      .catch((e) => {
        if (!warned) {
          warned = true;
          log('[raise] 日历拿不到（今日任务将按周末算放假）：' + e.message);
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
