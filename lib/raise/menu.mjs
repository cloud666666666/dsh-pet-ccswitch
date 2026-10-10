/**
 * menu.mjs —— 右键菜单树（宿主下发给桌宠，宠物端不硬编码养成内容）
 *
 * 为什么菜单在宿主这边生成：桌宠那边的补丁越薄越好 —— 它只认「点击 → 把 leaf.raise 发回宿主」，
 * 至于菜单里有啥（背包里剩几口饭、商店卖什么、有没有生病）全由宿主决定。
 * 这样加玩法不用再动 dsh-pet 的产物，也不会因为它升级而失效。
 *
 * 树形：分支 { label, children: [...] }，叶子 { label, raise: '动作串' }。
 * 动作串用冒号分隔，形如 `use:food:100010032`、`buy:medicine:10003` —— 见 index.mjs 的 act()。
 *
 * 菜单是「一屏能看完」优先：每层最多十几个，不搞 560 条食物的大长列表。
 */
import { allGoods, countOf, listGoods, summary, TYPE_NAMES } from './goods.mjs';
import { illOf } from './text.mjs';
import { allLessons, lessons, photoCount, PROVINCES, shots, workGoods } from './jobs.mjs';
import { monthCount, signedToday, canDrawGrowth, giftCost, onlineGiftWait } from './signin.mjs';
import { unread } from './mail.mjs';
import { pinkDiamondPrice, sweetHeartDays } from './vip.mjs';
import { tasks } from './tasks.mjs';
import { fishLine, pondState, shop } from './fishing.mjs';

/** 每层最多几个（原版是分页的 4 个/页，菜单这边放宽到 12） */
const MAX = 12;
/** 背包为空时给商店留的推荐位（shop.json 的 shopTj 是原版「推荐」页） */
const SHOP_TJ = [
  ['food', ['102010001', '102010074', '102010075', '102010003', '102010012', '102010004', '102010016', '102010010']],
  ['clean', ['102020003', '102020052', '102020053', '102020012', '102020001', '102020005', '102020006', '102020002']],
  ['medicine', ['10001', '40002', '60001']],
  ['toy', ['t0002', 't0003', 't0004', 't0005', 't0006', 't0008', 't0010', 't0012']],
];

/** 数字紧凑显示（元宝价格） */
const num = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(n));

/**
 * 菜单标签里的效果摘要：只留最主要的那一项。
 * 菜单一行放不下太多字（超了会被 dsh-pet 截成「饥饿+360 魅力+…」），
 * 完整的属性加成在物品说明里，不在菜单里堆。
 */
const menuSummary = (g) => summary(g).split(' ')[0] ?? '';

/** 背包里某类型的子菜单：点一下就用一件 */
function bagMenu(st, type, icon) {
  const list = listGoods(st, type).slice(0, MAX);
  if (!list.length) return [];
  return list.map((g) => {
    const s = menuSummary(g);
    return { label: `${icon}${g.name} ×${g.num}${s ? `（${s}）` : ''}`, raise: `use:${type}:${g.id}` };
  });
}

/** 商店：推荐在前、便宜的垫后，按类型分组 */
function shopMenu(st) {
  const types = ['food', 'clean', 'medicine', 'toy', 'nums'];
  const groups = [];
  for (const type of types) {
    const tj = SHOP_TJ.find(([t]) => t === type)?.[1] ?? [];
    const all = allGoods(type).filter((g) => g.price > 0 && !g.outOfPrint);
    const seen = new Set();
    const picked = [];
    for (const id of tj) {
      const g = all.find((x) => x.id === id);
      if (g && !seen.has(g.id)) {
        seen.add(g.id);
        picked.push(g);
      }
    }
    // 补位的：便宜的优先（新手买得起），再不行就贵的
    const cheap = all.filter((g) => !seen.has(g.id)).sort((a, b) => a.price - b.price);
    for (const g of cheap) {
      if (picked.length >= MAX) break;
      picked.push(g);
    }
    const kids = picked.slice(0, MAX).map((g) => {
      const s = menuSummary(g);
      return {
        label: `${g.name} ${num(Math.round(g.price * (st.info.pinkDiamond ? 0.8 : 1)))}元宝${s ? `（${s}）` : ''}${g.needLevel ? ` ${g.needLevel}级` : ''}`,
        raise: `buy:${type}:${g.id}`,
      };
    });
    if (kids.length) groups.push({ label: TYPE_NAMES[type], children: kids });
  }
  return groups;
}

/** 心情档位的中文名（引擎里那四个英文键是照 qqpet 的 TALK.mood 来的，只在台词表里用） */
const MOOD_NAMES = { happy: '开心', peaceful: '平静', upset: '郁闷', sad: '难过' };

/** 状态面板：气泡里那几行。每行都短——气泡宽度只有宠物的一半多一点，长了会被折成两行（丑） */
export function statusLines(st) {
  const i = st.info;
  const c = st.meta;
  // 8 格的进度条：10 格加上后面的百分比就超宽了
  const bar = (v, max) => {
    const pct = Math.max(0, Math.min(100, Math.round((v / max) * 100)));
    const on = Math.round(pct / (100 / 8));
    return `${'█'.repeat(on)}${'░'.repeat(8 - on)} ${pct}%`;
  };
  const ill = st.activity('ill') ? illOf(`${st.activity('ill')}${i.health}`).name : null;
  const doing = st.busy() ? ` · ${st.activity('work') ? '打工中' : st.activity('study') ? '上课中' : '旅游中'}` : '';
  return [
    `${i.name} · ${st.stageName()} Lv.${c.level}${doing}`,
    `成长 ${Math.round(i.growth)} / ${c.nextGrowth}`,
    `饥饿 ${bar(i.hunger, c.hungerMax)}`,
    `清洁 ${bar(i.clean, c.cleanMax)}`,
    `心情 ${bar(i.mood, c.moodMax)} ${MOOD_NAMES[st.mood()] ?? st.mood()}`,
    `健康 ${i.health}/5${ill ? ` · ${ill}` : ''}${i.health === 0 ? ' · 已死亡' : ''}`,
    `元宝 ${i.yb}${i.pinkDiamond ? ' · 粉钻' : ''}${i.sweetHeart ? ' · 甜蜜情侣' : ''}`,
  ];
}

/**
 * 造整棵菜单。核心那一段（养成）永远在最前面；
 * 后面几段由各玩法模块自己挂到 st.menuSections 上（stage 2 起：打工/上学/旅游/任务/…）。
 */
export function buildMenu(st) {
  const i = st.info;
  const core = [];
  const buried = !st.save.havePet || st.save.isBury;

  if (buried) {
    // 埋了 / 还没领养：菜单就只剩「选蛋」这件事（qqpet 的选蛋领养页）
    core.push({ label: '🥚 领养一只新的', children: ADOPT });
  } else {
    core.push({ label: '📋 宝宝状态', raise: 'status' });
  }

  const dead = !buried && i.health === 0;
  const paused = st.save.settings.paused;

  if (dead) {
    core.push({ label: '💫 用还魂丹复活', raise: 'revive' });
    core.push({ label: '⚰️ 安葬它，重新领养', raise: 'bury' });
  } else if (!buried) {
    const feed = bagMenu(st, 'food', '🍚 ');
    const wash = bagMenu(st, 'clean', '🛁 ');
    const play = bagMenu(st, 'toy', '🧸 ');
    const med = bagMenu(st, 'medicine', '💊 ');
    if (feed.length) core.push({ label: '🍚 喂食', children: feed });
    else core.push({ label: '🍚 喂食（背包空了，去商店看看）', raise: 'shop:food' });
    if (wash.length) core.push({ label: '🛁 洗澡', children: wash });
    else core.push({ label: '🛁 洗澡（背包空了，去商店看看）', raise: 'shop:clean' });
    if (play.length) core.push({ label: '🧸 陪它玩', children: play });
    if (med.length) core.push({ label: '💊 吃药', children: med });
    core.push({ label: '🩺 看病', raise: 'doctor' });
    core.push({ label: '🏪 商店', children: shopMenu(st) });
    core.push({
      label: st.activity('ill') ? '💤 休息一下' : '💤 让它撒个欢',
      raise: 'play',
    });
  }

  const misc = [
    { label: '💬 说句话给我听', raise: 'talk' },
    { label: paused ? '▶️ 继续长大' : '⏸ 暂停成长', raise: paused ? 'resume' : 'pause' },
    { label: st.save.settings.quiet ? '🔔 允许它主动说话' : '🔕 免打扰（不主动说话）', raise: 'quiet:toggle' },
    ...(buried ? [] : [{ label: '🔄 重新领养一只', children: ADOPT }]),
  ];
  core.push({ label: '⚙️ 设置', children: misc });

  const sections = [{ label: '🐾 养成', children: core }];
  if (!buried && !dead) {
    // 考试进行中就把它顶到最前面（正在答题的人不该去找菜单）
    const exam = examSection(st);
    if (exam) sections.unshift(exam);
    sections.push(workSection(st), studySection(st), travelSection(st), pondSection(st));
    sections.push(taskSection(st), signinSection(st), mailSection(st), albumSection(st), vipSection(st));
  }
  for (const fn of st.menuSections ?? []) {
    const s = fn(st);
    if (s) sections.push(s);
  }
  return sections;
}

/** 选蛋领养：男孩子 / 女孩子（qqpet 的选蛋页） */
const ADOPT = [
  { label: '🥚 男孩子（GG）', raise: 'adopt:GG' },
  { label: '🥚 女孩子（MM）', raise: 'adopt:MM' },
];

export { ADOPT as adoptMenu };

// ---------------------------------------------------------------------------
// 打工 / 上学 / 旅游 / 升学考试（jobs.mjs 的玩法，菜单长相在这里）
// ---------------------------------------------------------------------------
/** 打工：24 份工作全列出来（门槛够不够由宿主判，跟原版一样"点一下才知道"） */
export function workSection(st) {
  const kids = workGoods().map((g) => {
    const bits = [`${g.yb}元宝`, `${g.useTime}分钟`];
    if (g.needLevel) bits.push(`${g.needLevel}级`);
    return { label: `${g.tolkName ?? g.name}（${bits.join(' · ')}）`, raise: `work:${g.id}` };
  });
  return { label: '💼 去打工', children: kids };
}

/** 上学：九个科目，各自按学籍进度上对应的课；课时修满则变成升学考试 */
export function studySection(st) {
  const kids = allLessons(st).map((g) => {
    const done = lessons(st, g) >= g.classNum;
    return {
      label: `${g.tolkName ?? g.object}（${done ? '课时修满，可升学考试' : `${lessons(st, g)}/${g.classNum} 课时`}）`,
      raise: `study:${g.id}`,
    };
  });
  return { label: '📚 去上学', children: kids };
}

/** 旅游：原版就是随机挑一个省份，这边保持一致；顺带把相簿放进来 */
export function travelSection(st) {
  const n = PROVINCES.length;
  const shotCount = shots(st).length;
  return {
    label: '✈️ 出门旅游',
    children: [
      { label: `🎲 去旅游（随机地点，约 1 小时，共 ${n} 个去处）`, raise: 'trip' },
      { label: `📷 相簿（${shotCount}/${photoCount()} 张明信片）`, raise: 'album' },
    ],
  };
}

/** 升学考试：菜单里答题（原版是个答题窗口，这边一题一个菜单项） */
export function examSection(st) {
  const ex = st.exam;
  if (!ex) return null;
  const at = ex.picked.length;
  const q = ex.questions[at];
  if (!q) return null;
  return {
    label: `🎓 升学考试（第 ${at + 1}/${ex.questions.length} 题）`,
    children: [
      {
        label: `📖 ${q.title}`,
        children: q.options.map((o, i) => ({ label: `${'ABCD'[i]}. ${o}`, raise: `exam:${i}` })),
      },
      { label: '🚪 不考了（作废这次考试）', raise: 'exam:quit' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 任务 / 签到 / 邮件 / 图鉴 / 贵族（stage 3）
// ---------------------------------------------------------------------------
/** 一个页签的任务列表：做完了就变成「可领」，没做完点一下让它把任务要求说一遍 */
function taskMenu(st, tab) {
  return tasks(st, tab).map((t, i) => {
    const ready = !t.take && t.done >= t.num;
    const mark = t.take ? '✅' : ready ? '🎁' : '⬜';
    const got = t.take ? '已领' : `${Math.min(t.done, t.num)}/${t.num}`;
    return { label: `${mark} ${t.label}（${got}）`, raise: ready ? `claim:${tab}:${i}` : `taskmsg:${tab}:${i}` };
  });
}

export function taskSection(st) {
  const ready = ['daily', 'ddw', 'growth', 'travel'].reduce(
    (n, tab) => n + tasks(st, tab).filter((t) => !t.take && t.done >= t.num).length,
    0,
  );
  return {
    label: `📋 任务${ready ? `（${ready} 个可领）` : ''}`,
    children: [
      { label: `📋 今日任务（${tasks(st, 'daily').length} 条）`, children: taskMenu(st, 'daily') },
      { label: '🤗 逗逗我', children: taskMenu(st, 'ddw') },
      { label: '📚 学习打工', children: taskMenu(st, 'growth') },
      { label: '✈️ 旅游任务', children: taskMenu(st, 'travel') },
    ],
  };
}

export function signinSection(st) {
  const kids = [];
  kids.push(signedToday(st) ? { label: '✅ 今天已经签过到了', raise: 'sign:done' } : { label: '📅 今日签到', raise: 'sign:in' });
  kids.push(
    canDrawGrowth(st)
      ? { label: '🎰 抽成长值', raise: 'sign:growth' }
      : { label: '✅ 今天的成长值抽过了', raise: 'sign:done' },
  );
  const cost = giftCost(st);
  const left = onlineGiftWait(st);
  kids.push({
    label: `🎁 领在线奖励（${cost ? `${cost} 元宝` : '免费'}）${left > 0 ? ` · 还差 ${left} 分钟` : ''}`,
    raise: 'sign:gift',
  });
  kids.push({ label: `📆 本月签到 ${monthCount(st)} 天`, raise: 'sign:month' });
  return { label: '🎁 签到', children: kids };
}

export function mailSection(st) {
  const list = unread(st);
  if (!list.length) return { label: '📮 邮件（空）', raise: 'mail:empty' };
  return {
    label: `📮 邮件（${list.length} 封未领）`,
    children: list.slice(0, MAX).map((m) => ({
      label: `${m.glb?.length ? '📦 ' : '✉️ '}${m.l}`,
      raise: `mail:${m.d}`,
    })),
  };
}

export function albumSection(st) {
  const list = shots(st);
  return {
    label: '📷 旅游相簿',
    children: [
      { label: `🖼 相簿（${list.length}/${photoCount()} 张明信片）`, raise: 'album' },
      { label: `📖 图鉴（已收集 ${st.save.illustrated.length} 件物品）`, raise: 'illustrated' },
    ],
  };
}

export function vipSection(st) {
  const i = st.info;
  const pd = i.pinkDiamond
    ? `粉钻 Lv.${i.PDiamondLevel}（${daysLeft(i.PDiamondExpirationDate)} 天到期）`
    : `开通粉钻（${pinkDiamondPrice(st)} 元宝 / 5 天）`;
  const heart = i.sweetHeartOverTime
    ? `贴心宝贝（${sweetHeartDays(st)} 天，现${i.sweetHeart ? '已开' : '已关'}）`
    : '贴心宝贝（300 元宝 / 1 天）';
  return {
    label: '💎 贵族',
    children: [
      { label: `💠 ${pd}`, raise: i.pinkDiamond ? 'pd:info' : 'pd:buy' },
      { label: `🧸 ${heart}`, raise: i.sweetHeartOverTime ? 'heart:toggle' : 'heart:buy1' },
      { label: '🧸 贴心宝贝 7 天（2100 元宝）', raise: 'heart:buy7' },
    ],
  };
}

const daysLeft = (ts) => Math.max(0, Math.ceil((ts - Date.now() / 1000) / 86400));

/** 池塘养鱼（fishing.mjs）：鱼一条一个菜单项 */
export function pondSection(st) {
  const p = pondState(st);
  const kids = [{ label: `🐟 看看鱼塘（${p.fishes.length} 条鱼）`, raise: 'fish:state' }];
  if (p.fishes.length) {
    kids.push({
      label: '🍤 喂鱼（10 元宝 = 长一小时）',
      children: p.fishes.map((f) => ({ label: fishLine(f), raise: `fish:feed:${f.id}` })),
    });
    kids.push({
      label: '🎣 捞鱼（熟的卖钱，没熟的退一半）',
      children: p.fishes.map((f) => ({ label: fishLine(f), raise: `fish:harvest:${f.id}` })),
    });
    kids.push({ label: '🧺 全部收成', raise: 'fish:harvestall' });
    if (p.PD.canusecnt) kids.push({ label: `⚡ 粉钻加速（今天还剩 ${p.PD.canusecnt} 次）`, raise: 'fish:speed' });
  }
  const fries = shop(st);
  kids.push({
    label: `🛒 买鱼苗（${fries.length} 种可养${p.fishes.length >= (st.info.pinkDiamond ? 5 : 3) ? '，鱼塘已满' : ''}）`,
    children: fries.map((f) => ({
      label: `${f.name}（${f.price_yb}元宝 · ${f.level}级 · 收成 ${f.sell_price * f.quantity}）`,
      raise: `fish:buy:${f.fryid}`,
    })),
  });
  return { label: '🐟 池塘养鱼', children: kids };
}
