/**
 * items.mjs —— 用物品 / 买东西 / 看病（qqpet `pet/items.ts` 移植）
 *
 * 数值、判定顺序、台词全部照搬。**改动都在"确认"这一步**：原版是弹窗（"确定使用还魂丹？"
 * 这类），桌宠的气泡没有按钮，所以：
 *   - 菜单里点一下 = 原版弹窗点「确定」；选择数量的物品（元宝/成长值）一次用 1 个
 *   - 原版「右药在动画开始时生效、错药在动画结束时才发作」——这边没有动画回调，一律立即生效
 * 其余（价格、粉钻八折、余额不足的提示、医生的诊费与加价 20%）一字未改。
 */
import { DEAD, illOf, line } from './text.mjs';
import { goodOf, hasGood, takeGood, startTimed, addGood, listGoods, TYPE_NAMES } from './goods.mjs';

/** 扣元宝；不够就按原版那句提示拒绝 */
export function pay(st, price) {
  if (st.info.yb < price) {
    st.say('抱歉您的余额不足', 'sad', { kind: 'act' });
    return false;
  }
  st.setInfo('yb', st.info.yb - price);
  return true;
}

/** 属性名的中文（回显用） */
const STAT_CN = { hunger: '饥饿', clean: '清洁', mood: '心情', health: '健康', yb: '元宝', growth: '成长值' };

/**
 * 把"用完之后的变化"拼成气泡上的一行（前面加换行，桌宠那边会渲染成独立一行小字）。
 * 物品加的是**固定值**（饥饿+100、清洁+720），只看百分比对不上账 ——
 * 所以用完必须把「之前 → 之后」摆出来，喂到满溢也一眼看得出来（比如 3400→3400）。
 */
export const effectText = (rows) =>
  rows.length ? '\n' + rows.map((r) => `${STAT_CN[r.key] ?? r.key} ${Math.round(r.before)}→${Math.round(r.after)}`).join('　') : '';

/**
 * 物品的属性效果；吃与洗额外送心情（`extra`）。
 * 返回每一栏的 { key, before, after } —— 调用方拿去回显。
 */
export function apply(st, g, extra = 0) {
  const c = st.meta;
  const out = [];
  const bump = (key, delta, max) => {
    if (!delta) return;
    const before = st.info[key];
    const after = Math.min(before + delta, max); // 封顶：跟原版一样，喂到满就不再涨
    if (after !== before) st.setInfo(key, after);
    out.push({ key, before, after });
  };
  bump('hunger', g.hunger, c.hungerMax);
  bump('clean', g.clean, c.cleanMax);
  bump('mood', (g.mood ?? 0) + extra, c.moodMax);
  if (g.intel) st.addInfo('intel', g.intel);
  if (g.charm) st.addInfo('charm', g.charm);
  if (g.strong) st.addInfo('strong', g.strong);
  return out;
}

/** 日常物品：台词分类 / 动画键 / 额外心情 / 暂停时拒做什么 / 任务计数 */
const DAILY = {
  food: { c: 'eat', anim: 'eat', extra: 20, paused: '吃食物', task: 'Eat' },
  clean: { c: 'clean', anim: 'clean', extra: 20, paused: '清洁', task: 'Clean' },
  toy: { c: 'toy', anim: 'toy', extra: 0, paused: '玩玩具', task: 'Toy' },
  background: { c: 'pay', anim: '', extra: 0 },
};

/**
 * 用掉一件物品。`free` = 跳过背包（医生已经收过钱了）。
 * `text` 覆盖日常物品的常规台词（甜蜜情侣自己动手时用）。
 */
export function useItem(st, g, { free = false, text = '' } = {}) {
  if (g.type !== 'medicine' && st.info.health === 0) {
    st.say(line('state', 'die'), 'die', { kind: 'act' });
    return false;
  }
  if (g.type === 'nums') return useNums(st, g, free);
  if (g.type === 'medicine') return medicine(st, g, free);
  if (g.type === 'background') return background(st, g, free, text);

  const d = DAILY[g.type];
  if (!d) return false;
  if (st.save.settings.paused && d.paused) {
    st.say(`[host],我暂停成长拉！无法${d.paused}~~`, '', { kind: 'act' });
    return false;
  }
  if (!free && !hasGood(st, g.type, g.id)) return false;
  if (!free) takeGood(st, g);
  if (g.useTimeing) startTimed(st, g);
  const rows = apply(st, g, d.extra);
  st.say((text || line(d.c, g.type) || `真不错~`) + effectText(rows), d.anim, { kind: 'act' });
  if (d.task) st.count(d.task); // 今日任务计数（走 engine.count，钩子签名是 fn(st, counter)）
  return true;
}

/** 功能类（元宝/成长值/缴税/驻颜丹/T病毒）：原版弹出「选择使用数量」，这边一次用 1 个 */
function useNums(st, g, free) {
  if (!free && !hasGood(st, 'nums', g.id)) return false;
  if (!free) takeGood(st, g, 1);
  const key = g.useId ?? g.id;
  let rows = [];
  if (key in st.info && Number.isFinite(g.value)) {
    const before = st.info[key];
    st.setInfo(key, Math.max(before + g.value, 0));
    rows = [{ key, before, after: st.info[key] }];
  }
  const verb = g.value >= 0 ? '使用' : '服用';
  st.say(`[host]，${verb}${g.name}成功~` + effectText(rows), 'gift', { kind: 'act' });
  return true;
}

/** 背景：换不了真背景（桌宠没有场景层），只当"换个心情"，其余数值照原版 */
function background(st, g, free, text) {
  if (!free && !hasGood(st, 'background', g.id)) return false;
  if (!free) takeGood(st, g);
  if (g.useTimeing) startTimed(st, g);
  const rows = apply(st, g);
  st.say((text || line('pay', 'background') || '换个背景，心情不错~') + effectText(rows), '', { kind: 'act' });
  return true;
}

/** 吃药：吃对药治好，吃错药更严重（原版 items.ts 的 medicine） */
function medicine(st, g, free) {
  const take = () => (free ? true : takeGood(st, g));
  if (g.id === DEAD.cure.id) {
    // 还魂丹
    if (st.info.health === 0) return reviveWith(st, g, take);
    st.say('[host],向天再借100年！~', 'cure', { kind: 'act' });
    return reviveWith(st, g, take);
  }
  if (st.info.health === 5) {
    st.say('[host],我不需要吃药哦~', '', { kind: 'act' });
    return false;
  }
  if (st.info.health === 0) {
    st.say('[host]，这个不能让我复活哦~', 'die', { kind: 'act' });
    return false;
  }
  const ill = illOf(`${st.activity('ill')}${st.info.health}`);
  const right = g.id === ill.cure.id;
  if (!take()) return false;
  const health0 = st.info.health;
  st.setInfo('health', right ? 5 : health0 - 1);
  const rows = apply(st, g);
  rows.unshift({ key: 'health', before: health0, after: st.info.health });
  st.say((right ? ill.successTolk : ill.errTolk) + effectText(rows), 'cure', { kind: 'act' });
  return true;
}

function reviveWith(st, g, take) {
  if (!take()) return false;
  const before = st.info.health;
  const rows = apply(st, g);
  st.setInfo('health', 5);
  if (before !== 5) st.say(`[host]，我又活过来啦！` + effectText([{ key: 'health', before, after: 5 }, ...rows]), 'revive', { kind: 'act' });
  return true;
}

/**
 * 把奖励列表拼成气泡上的一行（前面加换行，桌宠那边渲染成独立一行小字）。
 * 「领取奖励」这类动作最要紧的就是"领到了什么"，光说一句"领取成功"等于没说。
 * 数量为 1 时不写 ×1（省地方），多个之间用全角空格隔开。
 */
export const rewardText = (goods) =>
  goods?.length
    ? '\n' +
      goods
        .filter(Boolean)
        .map((g) => `${g.name}${(g.num ?? 1) > 1 ? ` ×${g.num}` : ''}`)
        .join('　')
    : '';

/** 把奖励物品塞进背包并说一句（签到/任务/邮件都走这里）——**并列出领到了什么** */
export function give(st, goods, text) {
  const list = (goods ?? []).filter(Boolean);
  for (const g of list) addGood(st, g.type, g.id, g.num ?? 1);
  st.say(text + rewardText(list), 'gift', { kind: 'act' });
}

/** 元宝变化那一行（买东西、收工资、扣费都报这句，跟属性变化同一个格式） */
export const moneyText = (before, after) => effectText([{ key: 'yb', before, after }]);

/** 单价：粉钻贵族八折 */
export const price = (g, st) => g.price * (st.info.pinkDiamond ? 0.8 : 1);

/** 买 n 件；`quiet` 时不道谢（购物车场景，菜单里用不到） */
export function buy(st, g, n = 1, quiet = false) {
  // price = -1 是原版表里"非卖品"的标记（990 件里有 765 件），别让它们倒找钱
  if (!g || !(g.price > 0)) return false;
  if (g.needLevel && st.meta.level < g.needLevel) {
    st.say('[host],我现在没到购买年龄哦~~', '', { kind: 'act' });
    return false;
  }
  if (g.PD && !st.info.pinkDiamond) {
    st.say('[host],你要帮我开通粉钻贵族才能购买哦~~', '', { kind: 'act' });
    return false;
  }
  const cost = Math.round(price(g, st) * n);
  const yb0 = st.info.yb;
  if (!pay(st, cost)) return false;
  addGood(st, g.type, g.id, n);
  // 原版这里只有一句"工资都不够用了"式的台词，连买了什么都没说 —— 补上物品与账目
  const head = quiet ? '' : (line('pay', g.type) ?? `买到了${g.name}~`);
  const detail = `${g.name} ×${n}　元宝 ${yb0}→${st.info.yb}`;
  st.say(head ? `${head}\n${detail}` : detail, '', { kind: 'act' });
  return true;
}

/**
 * 看病：按健康度收诊费，然后开药（背包里有就吃掉，没有就现买，加价 20%）。
 * 原版这里连着两个确认弹窗（"花费 N 元宝看病？" → "诊断结果：需要 XX"），
 * 菜单里点「看病」这一下就当确认了，所以合成一步。
 */
export function doctor(st) {
  const code = st.activity('ill');
  if (!code) {
    st.say('[host],我不需要看病的~', '', { kind: 'act' });
    return false;
  }
  if (st.info.health === 0) return prescribe(st, DEAD.cure, '您的宠物已经死亡，需要使用');
  const fee = (5 - st.info.health) * 10;
  if (!pay(st, fee)) return false;
  const ill = illOf(`${code}${st.info.health}`);
  return prescribe(st, ill.cure, `您的宠物患上了${ill.name}， 需要使用`);
}

/** 开药：从背包拿，或按原价 120% 现买 */
function prescribe(st, cure, diagnosis) {
  const g = goodOf('medicine', cure.id);
  if (!g) return false;
  const owned = hasGood(st, 'medicine', g.id);
  const cost = Math.round((g.price || 50) * 1.2);
  if (!owned) {
    const yb0 = st.info.yb;
    if (!pay(st, cost)) return false;
    st.say(`${diagnosis}${g.name}，花 ${cost} 元宝买来啦~` + moneyText(yb0, st.info.yb), 'cure', { kind: 'act' });
    return medicine(st, g, true);
  }
  st.say(`${diagnosis}${g.name}，我这就吃~`, 'cure', { kind: 'act' });
  return medicine(st, g, false);
}

/** 背包里某类型第一件（甜蜜情侣自己动手用） */
export const firstOf = (st, type) => listGoods(st, type)[0] ?? null;

export { TYPE_NAMES };
