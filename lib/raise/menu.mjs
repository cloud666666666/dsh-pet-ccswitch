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
import { allLessons, ATTR_CN, diploma, hasExam, lessons, photoCount, PROVINCES, shots, workGoods } from './jobs.mjs';
import { monthCount, signedToday, canDrawGrowth, giftCost, onlineGiftWait } from './signin.mjs';
import { unread } from './mail.mjs';
import { pinkDiamondPrice, pinkDiamondDays, sweetHeartDays } from './vip.mjs';
import { tasks } from './tasks.mjs';
import { fishLine, pondState, shop } from './fishing.mjs';
import { list as achvList, human as achvHuman } from './achv.mjs';

/** 商店每种类型最多摆几个（菜单面板本身能滚，见 shared-core 的 .dsh-pet-menu-column） */
const MAX = 24;
/** 背包是自己有的东西，摆全 —— 上限只是防呆（真到 40 种以上再考虑分页） */
const BAG_MAX = 60;
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

/** 背包里某类型的子菜单：点一下就用一件（自己有的东西要都能点到，所以按 BAG_MAX 摆全） */
function bagMenu(st, type, icon) {
  return listGoods(st, type)
    .slice(0, BAG_MAX)
    .map((g) => {
      const s = menuSummary(g);
      return { label: `${icon}${g.name} ×${g.num}${s ? `（${s}）` : ''}`, raise: `use:${type}:${g.id}` };
    });
}

/**
 * 生病时把对症的那盒药标出来 —— 原版是"随便吃，吃错了更严重"（还只回一句"你给我吃什么了？"），
 * 桌宠这边没有药盒抽屉可以试，所以至少把「哪个是对的」摆在明面上。
 */
function markCure(st, kids) {
  const code = st.activity('ill');
  if (!code || !st.info.health || st.info.health >= 5) return kids;
  const right = illOf(`${code}${st.info.health}`).cure.id;
  return kids.map((k) => (k.raise.endsWith(right) ? { ...k, label: `${k.label} · 对症 ✓` } : { ...k, label: `${k.label} · 不对症` }));
}

/** 商店：推荐在前、便宜的垫后，按类型分组 */
function shopMenu(st) {
  const types = ['food', 'clean', 'medicine', 'toy', 'background', 'nums'];
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
    // 补位的按「等级门槛 → 价格」升序：摆得下的永远是它这个阶段买得到的那些，
    // 免得高价高级的东西把新手款挤没了（列表长了自己滚，面板是带滚动的）
    const rest = all
      .filter((g) => !seen.has(g.id))
      .sort((a, b) => (a.needLevel ?? 0) - (b.needLevel ?? 0) || a.price - b.price);
    for (const g of rest) {
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
  /**
   * 8 格进度条 + **实际数值**（当前/上限）。
   * 物品加的是固定值（饥饿+100、清洁+720…），只给百分比没法算"这一口会不会溢出"，
   * 所以数值必须摆出来；百分比交给进度条本身表达，不再重复占地方。
   */
  const bar = (v, max) => {
    const pct = Math.max(0, Math.min(100, (v / max) * 100));
    const on = Math.round(pct / (100 / 8));
    return `${'█'.repeat(on)}${'░'.repeat(8 - on)} ${Math.round(v)}/${max}`;
  };
  const ill = st.activity('ill') ? illOf(`${st.activity('ill')}${i.health}`).name : null;
  const doing = st.busy() ? ` · ${st.activity('work') ? '打工中' : st.activity('study') ? '上课中' : '旅游中'}` : '';
  // 成长只吃 token：换算系数不是 1（心情差 / 有加成）时标出来
  const f = st.growthFactor();
  const factor = Math.abs(f.total - 1) > 0.01 ? ` ×${f.total.toFixed(2)}` : '';
  const rows = [
    `${i.name} · ${st.stageName()} Lv.${c.level}${doing}`,
    `成长 ${Math.round(i.growth)} / ${c.nextGrowth}${factor}`,
    `饥饿 ${bar(i.hunger, c.hungerMax)}`,
    `清洁 ${bar(i.clean, c.cleanMax)}`,
    `心情 ${bar(i.mood, c.moodMax)} ${MOOD_NAMES[st.mood()] ?? st.mood()}`,
    `健康 ${i.health}/5${ill ? ` · ${ill}` : ''}${i.health === 0 ? ' · 已死亡' : ''}`,
    // 贵族状态连天数一起显示：只写「粉钻」谁也不知道还剩几天、什么时候会失效
    `元宝 ${i.yb}${i.pinkDiamond ? ` · 粉钻 ${pinkDiamondDays(st)}天` : ''}${
      i.sweetHeart ? ` · 贴心 ${sweetHeartDays(st)}天` : i.sweetHeartOverTime ? ` · 贴心已关(${sweetHeartDays(st)}天)` : ''
    }`,
  ];
  // 工作联动：工作区还脏着的话多一行（没接工作区、或者已经全提交了就不占地方）
  const linkLine = st.link?.line?.();
  if (linkLine) rows.push(linkLine);
  return rows;
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
    // 智力/魅力/武力、幸运、疲劳、到期天数、生效中的限时物品…… 这些原来界面上一个字都没有，
    // 可它们决定了"能不能打工""多久会生病"，所以给一个能一次看全的地方（原版是宠物资料页）
    core.push({ label: '📊 详细属性（智力/魅力/武力…）', raise: 'detail' });
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
    if (med.length) core.push({ label: '💊 吃药', children: markCure(st, bagMenu(st, 'medicine', '💊 ')) });
    // 功能道具（元宝/成长值/缴税…）与背景：商店卖它们、任务和邮件也发它们，
    // 所以背包里得有个能点的地方，不然只能命令行用
    const fx = bagMenu(st, 'nums', '🧪 ');
    if (fx.length) core.push({ label: '🧪 用功能道具', children: fx });
    const bg = bagMenu(st, 'background', '🖼 ');
    if (bg.length) core.push({ label: '🖼 换个背景', children: bg });
    core.push({ label: '🩺 看病', raise: 'doctor' });
    core.push({ label: '🏪 商店', children: shopMenu(st) });
    // 工作联动开着时，把"工作区干净没干净"也摆进来（这是个看一眼就知道自己该干嘛的入口）
    if (st.link?.on) core.push({ label: '🧹 工作区状态（提交 = 洗澡）', raise: 'link:state' });
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
    sections.push(taskSection(st), signinSection(st), mailSection(st), achvSection(st), vipSection(st));
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
    // 菜单一项只放得下三四十个字（超了会被 dsh-pet 截成「…」），所以这里用紧凑写法：
    // 「智800/武1000」而不是「智力 ≥ 800、武力 ≥ 1000」；学科也缩成两字
    const bits = [`${g.yb}元宝`, `${g.useTime}分`];
    if (g.needLevel) bits.push(`${g.needLevel}级`);
    const attrs = Object.entries(g.useArtt ?? {}).map(([k, v]) => `${(ATTR_CN[k] ?? k).slice(0, 1)}${v}`);
    if (attrs.length) bits.push(attrs.join('/'));
    const edu = Object.entries(g.education ?? {})
      .map(([k, v]) => diploma(k, v)?.replace(/^(小学|中学|大学|研究生)/, (m) => m.slice(0, 1)))
      .filter(Boolean);
    if (edu.length) bits.push(edu.length > 2 ? `${edu.slice(0, 2).join('/')}…` : edu.join('/'));
    return { label: `${g.tolkName ?? g.name}（${bits.join('·')}）`, raise: `work:${g.id}` };
  });
  return { label: '💼 去打工', children: kids };
}

/** 上学：九个科目，各自按学籍进度上对应的课；课时修满则变成升学考试 */
export function studySection(st) {
  const kids = allLessons(st).map((g) => {
    const done = lessons(st, g) >= g.classNum;
    const state = done ? (hasExam(g.id) ? '课时修满，可升学考试' : '课时修满，免考升学') : `${lessons(st, g)}/${g.classNum} 课时`;
    return { label: `${g.tolkName ?? g.object}（${state}）`, raise: `study:${g.id}` };
  });
  return { label: '📚 去上学', children: kids };
}

/** 旅游：原版就是随机挑一个省份，这边保持一致；顺带把相簿与「完成旅游成就」放进来 */
export function travelSection(st) {
  const n = PROVINCES.length;
  const list = shots(st);
  const visited = st.save.gameSaveDatas.travel_china.length;
  const times = st.save.gameSaveDatas.travel_china_num ?? 0;
  const kids = [
    { label: `🎲 去旅游（随机地点，约 1 小时，共 ${n} 个去处）`, raise: 'trip' },
    { label: `📷 相簿（${list.length}/${photoCount()} 张明信片${visited ? ` · 去过 ${visited} 个地方` : ''}${times ? ` · 走遍全国 ${times} 次` : ''}）`, raise: 'album' },
  ];
  // 原版这个入口在旅游窗口里：8888 元宝清空到访记录，让「去 N 个城市」的任务能重做
  if (visited) kids.push({ label: '🏆 完成旅游成就（8888 元宝清空记录，旅游任务可重做）', raise: 'trip:finish' });
  return { label: '✈️ 出门旅游', children: kids };
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
    // 能领的时候把奖励摆出来（"领到的是什么"要在点之前就看得见）
    const prize = ready && t.good?.length ? ` → ${t.good.map((g) => `${g.name}${(g.num ?? 1) > 1 ? `×${g.num}` : ''}`).join('+')}` : '';
    return { label: `${mark} ${t.label}（${got}）${prize}`, raise: ready ? `claim:${tab}:${i}` : `taskmsg:${tab}:${i}` };
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
    children: list.slice(0, MAX).map((m) => {
      // 附件是什么也摆出来（"领了什么"点之前就该看得见）
      const names = (m.glb ?? []).slice(0, 2).map((g) => `${g.name}${(g.num ?? 1) > 1 ? `×${g.num}` : ''}`);
      const more = (m.glb?.length ?? 0) > 2 ? ' 等' : '';
      return { label: `${(m.glb?.length ? '📦 ' : '✉️ ') + m.l}${names.length ? `（${names.join('+')}${more}）` : ''}`, raise: `mail:${m.d}` };
    }),
  };
}

/** 成就墙（相簿留在「出门旅游」那一段，别两处都有入口） */
export function achvSection(st) {
  // 成就关着的时候别摆一面永远 0/17 的墙 —— 只留图鉴
  if (st.achvOn === false) {
    return { label: '📖 图鉴', children: [{ label: `📖 图鉴（已收集 ${st.save.illustrated.length} 件物品）`, raise: 'illustrated' }] };
  }
  const rows = achvList(st);
  const got = rows.filter((a) => a.unlocked).length;
  return {
    label: `🏆 成就（${got}/${rows.length}）`,
    children: [
      { label: `🏆 看看成就（${got}/${rows.length} 已达成）`, raise: 'achv:list' },
      ...rows.map((a) => ({
        label: `${a.unlocked ? '🏅' : '⬜'} ${a.name}${a.unlocked ? '' : `（${achvHuman(a.done)}/${achvHuman(a.need)}）`}`,
        raise: `achv:${a.id}`,
      })),
      { label: `📖 图鉴（已收集 ${st.save.illustrated.length} 件物品）`, raise: 'illustrated' },
    ],
  };
}

export function vipSection(st) {
  const i = st.info;
  const pd = i.pinkDiamond
    ? `粉钻 Lv.${i.PDiamondLevel} · 还有 ${pinkDiamondDays(st)} 天`
    : `开通粉钻（${pinkDiamondPrice(st)} 元宝 / 5 天）`;
  const heart = i.sweetHeartOverTime
    ? `贴心宝贝 · 还有 ${sweetHeartDays(st)} 天（现${i.sweetHeart ? '已开' : '已关'}）`
    : '贴心宝贝（300 元宝 / 1 天）';
  return {
    label: '💎 贵族',
    children: [
      { label: `💠 ${pd}`, raise: i.pinkDiamond ? 'pd:info' : 'pd:buy' },
      // 买了不知道有什么用是最气人的 —— 作用单独一条，点开就念
      { label: `❓ 粉钻有什么用${i.pinkDiamond ? '' : '（买之前先看看）'}`, raise: 'pd:help' },
      { label: `🧸 ${heart}`, raise: i.sweetHeartOverTime ? 'heart:toggle' : 'heart:buy1' },
      { label: '❓ 贴心宝贝有什么用', raise: 'heart:help' },
      { label: '🧸 贴心宝贝 7 天（2100 元宝）', raise: 'heart:buy7' },
    ],
  };
}

/** 粉钻/贴心宝贝的剩余天数改用 vip.mjs 里那份（按 06:00 换日算，跟到期判定同一个口径） */

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
