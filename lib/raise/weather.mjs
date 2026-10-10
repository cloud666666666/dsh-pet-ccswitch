/**
 * weather.mjs —— 天气播报与恶劣天气提醒（qqpet `pet/weather.ts` 移植）
 *
 * 默认关闭（`PET_RAISE_WEATHER=on` 才开）：这是**联网**功能，而且等于把城市名发给对方。
 * 开着的时候走 wttr.in 的公开 JSON（qqpet 用的是它作者自己搭的转发，这里直接用原始接口，
 * 少一层第三方）。天气码表、恶劣天气的提醒文案、每天最多说一次，都是照搬的。
 */
const CODES = {
  113: '晴', 116: '多云', 119: '阴', 122: '阴', 143: '薄雾', 146: '霾', 149: '霾',
  176: '零星小雨', 179: '零星小雪', 182: '雨夹雪', 185: '冻毛毛雨', 200: '雷阵雨',
  227: '吹雪', 230: '暴风雪', 248: '浓雾', 260: '冻雾', 263: '毛毛雨', 266: '毛毛雨',
  281: '冻毛毛雨', 284: '冻毛毛雨', 293: '小雨', 296: '小雨', 299: '中雨', 302: '中雨',
  305: '大雨', 308: '暴雨', 311: '冻雨', 314: '冻雨', 317: '雨夹雪', 320: '雨夹雪',
  323: '小雪', 326: '小雪', 329: '中雪', 332: '中雪', 335: '大雪', 338: '暴雪',
  350: '冰粒', 353: '阵雨', 356: '大阵雨', 359: '暴雨', 362: '阵雨夹雪', 365: '雨夹雪',
  368: '阵雪', 371: '大阵雪', 374: '冰粒', 377: '冰粒', 386: '雷阵雨', 389: '雷阵雨',
  392: '雷阵雪', 395: '雷阵雪',
};
/** 值得提醒的天气（按名字里的关键字认） */
const SEVERE = /雷|暴|大|冻|冰|浓雾/;
/** 恶劣天气的第一个关键字决定提醒什么 */
const TIPS = [
  ['雷', '打雷的时候别待在外面，记得关好窗户~'],
  ['冻', '路面会结冰，走路慢一点别摔倒~'],
  ['冰', '路面会结冰，走路慢一点别摔倒~'],
  ['雾', '外面雾蒙蒙的，过马路要看清楚哦~'],
  ['雪', '记得穿厚一点，路上小心滑~'],
  ['雨', '出门一定要带伞，别淋湿啦~'],
];
const WINDY = 39;
const HOT = 35;
const FREEZING = -5;
const CHILL = 8;

const name = (code) => CODES[code] ?? '';
const when = (hour) => (hour <= new Date().getHours() ? '现在' : `${hour}点左右`);

/** wttr.in 的 JSON（字段都是字符串，`time` 是 "0"…"2100"） */
async function fetchWeather(city) {
  const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 100)}`);
  const j = await r.json();
  const [now] = j.current_condition;
  const [today, tomorrow] = j.weather;
  const hour = new Date().getHours();
  return {
    code: +now.weatherCode,
    max: +today.maxtempC,
    min: +today.mintempC,
    tomorrowMax: +tomorrow.maxtempC,
    hours: today.hourly
      .map((h) => ({ hour: +h.time / 100, code: +h.weatherCode, wind: +h.windspeedKmph }))
      .filter((h) => h.hour + 3 > hour),
  };
}

function warning(w) {
  const bad = w.hours.find((h) => SEVERE.test(name(h.code)));
  if (bad) return `[host]，${when(bad.hour)}有${name(bad.code)}，${TIPS.find(([k]) => name(bad.code).includes(k))[1]}`;
  const windy = w.hours.find((h) => h.wind >= WINDY);
  if (windy) return `[host]，${when(windy.hour)}风很大，出门抓紧帽子，别被吹跑啦~`;
  if (w.max >= HOT) return `[host]，今天最高${w.max}℃，好热呀，多喝水别中暑~`;
  if (w.min <= FREEZING) return `[host]，今天最低${w.min}℃，出门把自己裹严实哦~`;
  if (w.max - w.tomorrowMax >= CHILL) return `[host]，明天要降温${w.max - w.tomorrowMax}℃，记得加衣服哦~`;
  return null;
}

function forecast(w, city) {
  const rain = w.hours.some((h) => name(h.code).includes('雨'));
  // 城市名是拼音/英文（Beijing）或者没填（按 IP 定位）时，插进中文句子里读着别扭 → 说「当地」
  const where = /[一-龥]/.test(city) ? city : '当地';
  return `[host]，今天${where}${name(w.code)}，${w.min}~${w.max}℃${rain ? '，出门记得带伞哦~' : '~'}`;
}

export { warning, forecast };

/**
 * 每天最多一句：恶劣天气必定说一句，平常的话开机时有一半概率报一次天气。
 * `launch` = 开机那一次；之后每小时问一次，只为了等恶劣天气出现。
 */
export async function weatherNews(st, { enabled, city, launch }) {
  if (!enabled) return null;
  const today = String(st.dayStart());
  if (st.save.saveJsonData.weather === today) return null;
  const w = await fetchWeather(city).catch(() => null); // 网断了或城市名不认识就闭嘴，下次再试
  const line = w && (warning(w) ?? (launch && Math.random() < 0.5 ? forecast(w, city) : null));
  if (line) {
    st.save.saveJsonData.weather = today;
    st.markDirty();
  }
  return line;
}
