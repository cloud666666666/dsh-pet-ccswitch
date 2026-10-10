/**
 * tasks.mjs —— 今日任务 / 逗逗我 / 学习打工 / 旅游任务（qqpet `pet/tasks.ts` 移植）
 *
 * 任务定义、奖励、每日 4 条的抽取规则（按宠物当前需求加权、"没空做的排不进去"、
 * 节假日加一条）全部照搬。进度存存档的 saveJsonData.task，字段形状也与原版一致。
 *
 * 两处必须说明的差异（都是"没有那块玩法"导致，不是漏抄）：
 *   - 小游戏那两条（玩 N 局 / 玩 N 分钟）**不进池子** —— qqpet 的小游戏是 98 个 SWF，
 *     桌宠这边没有；留着它们只会生成做不完的任务。
 *   - 「逗逗我」在原版是点宠物身上的逗乐点位，这边改成**点宠物**就算一次
 *     （宿主收到点击事件后 addCount('Amusing')，见 index.mjs 的 pet:click）。
 *   - 节假日判定要日历（stage 4 的 calendar.mjs）；日历没拿到时按原版离线兜底：周末算放假。
 */
import { goodOf, parseGood, loot } from './goods.mjs';
import { give, pay, moneyText } from './items.mjs';
import { rand } from './state.mjs';

export const DDW = '点击逗乐点位';

export const TABS = { daily: '今日任务', ddw: '逗逗我', growth: '学习打工', travel: '旅游任务' };

/** 除「今日任务」外三个页签的任务表（原样搬） */
const TASKS = {
  ddw: [
    { label: '逗逗我~~', msg: DDW, obj: 'Amusing', num: 5, good: ['_102010001*1'] },
    { label: '逗逗我2~~', msg: DDW, obj: 'Amusing', num: 10, good: ['_10012002*1'] },
    { label: '逗逗我3~~', msg: DDW, obj: 'Amusing', num: 15, good: ['_10013004*1'] },
    { label: '逗逗我4~~', msg: DDW, obj: 'Amusing', num: 20, reroll: 1 },
    { label: '逗逗我5~~', msg: DDW, obj: 'Amusing', num: 25, reroll: 2 },
  ],
  growth: [
    { label: '好好学习~~', msg: '去上一节课吧~', obj: 'Study', num: 1, good: ['_102010001*1'] },
    { label: '勤学苦读~~', msg: '今天上3节课，学霸就是你~', obj: 'Study', num: 3, reroll: 1 },
    { label: '勤劳致富~~', msg: '去打一次工吧~', obj: 'Work', num: 1, good: ['_yb*50'] },
    { label: '打工达人~~', msg: '今天打工3次，元宝多多~', obj: 'Work', num: 3, reroll: 1 },
  ],
  travel: [
    { label: '每日1游~~', msg: '去旅游一次吧~', obj: 'Travel1', num: 1, good: ['_102010001*1'] },
    { label: '每日5游~~', msg: '见多识广哦~', obj: 'Travel1', num: 5, reroll: 2 },
    {
      label: '去5个不同的城市~~',
      msg: '初行记​​ 烟霞初逢，人间烟火的温度，是你与世界交换的第一张明信片，游览5座不同的城市',
      obj: 'Travel2',
      num: 5,
      keep: true,
      good: ['_100010490*1'],
    },
    {
      label: '去10个不同的城市~~',
      msg: '漫游帖 山河漫笔，江南的桥，塞北的雪，像散落的诗笺，都是岁月等你签收的小确幸，游览10座不同的城市',
      obj: 'Travel2',
      num: 10,
      keep: true,
      good: ['_100010127*1'],
    },
    {
      label: '去15个不同的城市~~',
      msg: '寻踪录​ 故迹寻光，有些故事藏在门环后，有些传说埋在树影里，游览15座不同的城市',
      obj: 'Travel2',
      num: 15,
      keep: true,
      good: ['_100010239*1', '_100010497*1'],
    },
    {
      label: '去20个不同的城市~~',
      msg: '探微志​ 风物志异，从茶碗的釉色看一方水土，从方言的尾音听千年变迁，游览20座不同的城市',
      obj: 'Travel2',
      num: 20,
      keep: true,
      good: ['_100010417*1', '_100010499*1', '_100020155*1'],
    },
    {
      label: '去25个不同的城市~~',
      msg: '越障行 云程越嶂，那些被汗水浸透的脚印，终会连成独属于你的地图，游览25座不同的城市',
      obj: 'Travel2',
      num: 25,
      keep: true,
      good: ['_yb*1024', '_100020195*1', '_100020198*1', '_100020217*1'],
    },
    {
      label: '去30个不同的城市~~',
      msg: '奇旅帖​ 星野奇遇，旅行最妙的，是计划外的相遇，游览30座不同的城市',
      obj: 'Travel2',
      num: 30,
      keep: true,
      good: ['_100010485*1', '_100020221*1', '_100010353*1', '_b0000006*1', '_b0000015*1'],
    },
    {
      label: '去35个不同的城市~~',
      msg: '最好的风景，从来不在终点，而在你与它相遇时，眼里的光，游览35座不同的城市',
      obj: 'Travel2',
      num: 35,
      keep: true,
      good: ['_100010486*1', '_yb*2048', '_100020205*1', '_100020240*1', '_b0000016*1', '_60001*1'],
    },
  ],
};

/** 今日任务的种类表；`needs` 为真（宠物现在正缺）的种类权重 ×3，并说那句"求你了"的话 */
const KINDS = [
  { obj: 'Eat', label: '喂我吃东西{n}次', num: [2, 4], needs: (st) => st.info.hunger < st.meta.hungerMax / 2, msg: ['肚子咕咕叫啦，快给我吃点东西吧~', '吃饱饱才能长高高~'] },
  { obj: 'Clean', label: '帮我洗香香{n}次', num: [1, 3], needs: (st) => st.info.clean < st.meta.cleanMax / 2, msg: ['身上脏脏的，好难受呀~', '香香的才招人喜欢~'] },
  { obj: 'Toy', label: '陪我玩玩具{n}次', num: [2, 4], needs: (st) => st.info.mood < 500, msg: ['人家不开心，陪我玩一会儿嘛~', '一起玩最开心啦~'] },
  { obj: 'Amusing', label: '逗逗我{n}次', num: [10, 20], needs: (st) => st.info.mood < 500, msg: ['心情不好，逗我笑一笑吧~', DDW] },
  {
    obj: 'Work',
    label: '去打工{n}次',
    num: [1, 3],
    needs: (st) => st.info.yb < 500,
    can: (st) => st.meta.level >= 2,
    msg: ['家里没钱啦，我去打工赚元宝吧~', '勤劳致富，打工去咯~'],
  },
  { obj: 'Study', label: '去上学{n}次', num: [1, 2], needs: (st, off) => !off, msg: ['上学日要好好学习哦~', '书山有路勤为径~'] },
  { obj: 'Travel1', label: '带我去旅游{n}次', num: [1, 2], needs: (st, off) => off, msg: ['放假啦，出去走走吧~', '读万卷书，行万里路~'] },
  // 原版还有两条小游戏任务（GameRound / Game），桌宠没有小游戏，故不放进池子
];

const rewards = (t) => [...(t.reroll ? loot(t.reroll) : []), ...(t.good ?? []).map(parseGood)];

/** 存档形状：doNums 计数 + 每页签的领取状态 + 今日任务定义 */
function load(st) {
  const p = JSON.parse(st.save.saveJsonData.task || '{}');
  const entry = (t, e) => (e ? { take: e.take === true, good: e.good } : { take: false, good: rewards(t) });
  const list = (tab) => TASKS[tab].map((t, i) => entry(t, p.taskList?.[tab]?.[i]));
  return {
    doNums: p.doNums ?? {},
    taskList: { daily: p.taskList?.daily ?? [], ddw: list('ddw'), growth: list('growth'), travel: list('travel') },
    daily: p.daily ?? [],
    dailyDay: p.dailyDay ?? 0,
  };
}

/** 进度挂在实例上（不是在模块级做单例）：测试里会同时造好几只宠物，别互相串味 */
const P = (st) => (st.tasks ??= load(st));
const store = (st) => {
  st.save.saveJsonData.task = JSON.stringify(P(st));
  st.markDirty();
};

/** 测试用：丢掉内存里的进度，下次访问重新从存档读 */
export const forget = (st) => {
  st.tasks = null;
};

const defs = (st, tab) => (tab === 'daily' ? P(st).daily : TASKS[tab]);

/** 某计数当前的值（Travel2 = 去过的省份数） */
export const count = (st, obj) => (obj === 'Travel2' ? st.save.gameSaveDatas.travel_china.length : P(st).doNums[obj] ?? 0);

/** 计数 +n（吃东西、洗澡、打工、旅游、逗它 各算各的） */
export function addCount(st, obj, n = 1) {
  const p = P(st);
  p.doNums[obj] = count(st, obj) + n;
  store(st);
  // 顺便看看有没有任务刚好做完，做完就说一声（原版是任务页上打个勾，这边只能说话）
  // 用的是环境级节流（默认 10 分钟一条），所以不会连珠炮
  for (const [tab, list] of Object.entries(p.taskList)) {
    list.forEach((entry, i) => {
      const t = defs(st, tab)[i];
      if (t && !entry.take && count(st, t.obj) >= t.num) st.say(`[host]，${t.label} 做完啦，记得去「今日任务」里领奖励~`, 'happy');
    });
  }
}

/** 某页签的任务（带进度与领取状态） */
export const tasks = (st, tab) => defs(st, tab).map((t, i) => ({ ...t, ...P(st).taskList[tab][i], done: count(st, t.obj) }));

/** 交任务：做完了才能领，领了就给东西 */
export function claim(st, tab, i) {
  const t = defs(st, tab)[i];
  const p = P(st).taskList[tab]?.[i];
  if (!t || !p) return false;
  if (p.take || count(st, t.obj) < t.num) return false;
  p.take = true;
  store(st);
  give(st, p.good, `[host],我们完成${t.label}任务啦！~~`);
  return true;
}

/** 06:00：每日任务重抽、计数清零；`keep: true` 的（旅游城市）保留领取状态 */
export function resetTasks(st) {
  for (const tab of Object.keys(TASKS)) {
    TASKS[tab].forEach((t, i) => {
      const p = P(st).taskList[tab][i];
      if (!t.keep) p.take = false;
      if (t.reroll) p.good = rewards(t);
    });
  }
  P(st).doNums = {};
  store(st);
}

/**
 * 抽今天的 4 条任务（节假日多一条）。
 * `off` 是"今天放假吗"：有日历就听日历的，没有就按原版离线兜底 —— 周末算放假。
 */
export function rollDaily(st, today) {
  const p = P(st);
  const day = st.dayStart();
  if (p.dailyDay === day) return;
  const off = today?.holiday ? today.holiday.off : [0, 6].includes(new Date().getDay());
  const pool = KINDS.filter((k) => (k.can ? k.can(st) : true)).flatMap((k) => Array(k.needs(st, off) ? 3 : 1).fill(k));
  const daily = [];
  let guard = 0;
  while (daily.length < 4 && guard++ < 200) {
    const k = pool[rand(0, pool.length - 1)];
    if (daily.some((t) => t.obj === k.obj)) continue;
    const num = rand(k.num[0], k.num[1]);
    daily.push({
      label: k.label.replace('{n}', String(num)),
      msg: k.msg[k.needs(st, off) ? 0 : 1],
      obj: k.obj,
      num,
      reroll: 1,
      good: [`_yb*${rand(2, 5) * 10}`],
    });
  }
  const h = today?.holiday;
  if (h?.off) daily.push({ label: `${h.name}快乐`, msg: '过节啦，陪我玩5次玩具一起庆祝吧~', obj: 'Toy', num: 5, reroll: 2, good: ['_yb*100'] });
  p.daily = daily;
  p.dailyDay = day;
  p.taskList.daily = daily.map((t) => ({ take: false, good: rewards(t) }));
  store(st);
  return daily;
}

/** 全国游完一圈后，城市任务可以重新做 */
export function resetTour(st) {
  for (const p of P(st).taskList.travel.slice(2)) p.take = false;
  store(st);
}

/**
 * 「完成旅游成就」（qqpet ui/travel.ts 的 finishTour）：花 8888 元宝清空到访记录，
 * 于是「去 N 个不同的城市」那些任务又能重做一遍 —— 这是原版唯一会重置旅游任务的入口，
 * 没有它，旅游任务一辈子只能领一次。
 */
export function finishTour(st) {
  const list = st.save.gameSaveDatas.travel_china;
  if (!list.length) {
    st.say('[host]，我还没出去旅游过呢，先去玩几趟吧~', 'sad', { kind: 'act' });
    return false;
  }
  const yb0 = st.info.yb;
  if (!pay(st, 8888)) return false;
  const times = (st.save.gameSaveDatas.travel_china_num ?? 0) + 1;
  st.save.gameSaveDatas.travel_china = [];
  st.save.gameSaveDatas.travel_china_num = times;
  st.markDirty();
  resetTour(st);
  st.say(`[host]，第 ${times} 次走遍全国啦！旅游记录清空了，城市任务可以重做咯~` + moneyText(yb0, st.info.yb), 'levelup', { kind: 'act' });
  return true;
}

export { KINDS, TASKS };
