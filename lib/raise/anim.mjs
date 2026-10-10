/**
 * anim.mjs —— 养成动作 → dsh-pet 动画名
 *
 * qqpet 那边的动作是腾讯的 SWF（吃/洗澡/生病/死亡各有自己的动画），我们没有也不该有，
 * 所以改成从 **dsh-pet 配置里现有的动画池**挑：粗活戏「吃什么」那一类正好就是吃饭，
 * 「玩耍」类就是玩玩具，生病/死亡用它的事件档位。
 *
 * 挑选规则：
 *   1. 候选表（下面 SFX）按优先级列名字
 *   2. 只挑**配置里真的存在**的（配置是事实来源 —— 名字写错会 404，宠物卡住不动）
 *   3. 一个都没有 → 退到 events.whisper 池（说话动画）→ 再没有就返回 null，
 *      由桌宠自己随机抽说话动画（原版行为）
 *
 * 注意：不带移动类动画（螃蟹走路等）。那些动画是「一边走一边播」，得走真实的移动逻辑
 * （边界检查/距离/朝向）；说话通道里播它只会原地抽搐。想点播移动动画，走右键菜单的「动作」。
 */
import { rand } from './state.mjs';

/** 语义 → 候选动画名（按喜好排序） */
const SFX = {
  // 吃：直接用「吃什么」那一类
  eat: ['吃大餐', '大口吃零食', '吃午餐', '吃晚餐', '吃早餐', '吃白饭', '涮火锅', '吃西瓜', '吃糖葫芦', '吃Token'],
  // 洗澡/清洁：素材里没有淋浴动画，用「水」与「洗漱」系顶上
  clean: ['玩水枪', '鲸鱼吐泡泡特效', '晨间刷牙', '照镜子', '整体换装试色'],
  // 玩玩具
  toy: ['原地专心玩魔方', '原地蹲下玩玩具汽车', '荡秋千', '踢毽子', '三球抛接', '下五子棋', '抽陀螺', '吹气球', '放风筝'],
  // 生病：蔫一点的姿势
  sick: ['打瞌睡被惊醒', '哈欠连天', '被吓一跳', '原地重力下蹲压缩'],
  // 吃药/看病好了
  cure: ['超大伸懒腰', '照镜子', '女仆屈膝礼仪', '轻快记录'],
  // 死亡：倒地、叹气
  die: ['原地重力下蹲压缩', '打瞌睡被惊醒'],
  // 复活
  revive: ['凭空生花', '小幅度原地360度旋转展示', '轻快记录'],
  // 升级
  levelup: ['凭空生花', '收红包', '放烟花', '小幅度原地360度旋转展示'],
  // 打工
  work: ['写代码', '轻快记录', '原地敲击桌面互动', '摇扇纳凉'],
  // 学习/考试
  study: ['原地敲击桌面互动', '轻快记录', '照镜子'],
  exam: ['深度思考碎碎念', '是啊，吃什么', '原地敲击桌面互动'],
  // 旅游（不含移动动画，见文件头说明）
  travel: ['轻快记录', '悠闲哼歌', '摇扇纳凉'],
  // 钓鱼
  fish: ['玩水枪', '鲸鱼吐泡泡特效', '荡秋千'],
  // 农场
  farm: ['蝴蝶蜜蜂环绕头顶开花', '凭空生花', '撸猫'],
  // 签到 / 收礼物
  gift: ['拆礼物', '收红包', '抽陀螺'],
  // 弹琴说爱（心情好）
  happy: ['可爱宅舞', '优雅女仆舞', '轻快摇摆舞', '悠闲哼歌'],
  sad: ['哈欠连天', '打瞌睡被惊醒', '原地小憩沉眠'],
  sleep: ['原地小憩沉眠', '哈欠连天', '打瞌睡被惊醒'],
  greet: ['点击回应-元气挥手', '女仆屈膝礼仪', '轻快记录'],
};

/** 收集配置里所有可用的动画名（含分类、事件档位、待机/点击池；不含移动） */
export function collectAnimations(animations) {
  const names = new Set();
  const add = (x) => {
    if (typeof x === 'string' && x) names.add(x);
    else if (Array.isArray(x)) x.forEach(add);
  };
  for (const key of ['idle', 'turn', 'drag', 'clicks']) add(animations?.[key]);
  add(animations?.moves?.actions?.map((m) => m?.name));
  for (const cat of animations?.categories ?? []) add(cat.actions);
  for (const pool of Object.values(animations?.events ?? {})) add(pool);
  return names;
}

/**
 * 按成长阶段解锁动画：小的时候会的不多，长大了才学新本事。
 *
 * 规则（**只动 `categories`** —— 待机/转向/拖拽/点击/移动/事件这几池一律保留，
 * 少了它们桌宠会瘫）：
 *   - 该阶段允许的分类 → 留
 *   - 分类 id 不在任何阶段的白名单里（用户自己加的分类）→ 也留（**fail-open**，
 *     不能因为用户改了分类名就把他的动画全锁死）
 *   - 其余 → 这一阶段不给用
 *
 * 默认分法：蛋期只会「小动作」和「吃什么」；幼年期加上「玩耍」和「文字」；成年全开。
 * 分类 id 是 dsh-pet 配置里的中文名（小动作/玩耍/吃什么/时节/文字…），
 * 用户改过名字的话会走 fail-open 那一支，等于不锁。
 */
export const DEFAULT_STAGE_UNLOCK = {
  Egg: ['小动作', '吃什么'],
  Kid: ['小动作', '吃什么', '玩耍', '文字'],
  Adult: 'all',
};

/**
 * dsh-pet 默认配置里的分类名（"认识的名字"）—— 只作兜底。
 * 真正用的是宿主读上游 config.jsonc 得到的那份（见 host.mjs 的 knownCategories()），
 * 免得上游改分类名之后这里漂移：那时所有分类都会被判成"用户自定义"而 fail-open，阶段锁静默失效。
 */
export const KNOWN_CATEGORIES = ['小动作', '玩耍', '吃什么', '时节', '文字'];

/** 一条规则只写一遍：哪些分类留、哪些分类锁（filterAnimations 与 lockedNames 共用） */
function splitCategories(animations, stage, unlock, known) {
  const allow = unlock?.[stage];
  const keep = [];
  const lock = [];
  if (!allow || allow === 'all') return { keep: animations?.categories ?? [], lock };
  const knownSet = new Set(known?.length ? known : KNOWN_CATEGORIES);
  for (const cat of animations?.categories ?? []) {
    // 认识的分类没进白名单 = 这一阶段不给用；不认识的名字 = 用户自己加的 → fail-open 放行
    if (allow.includes(cat.id) || !knownSet.has(cat.id)) keep.push(cat);
    else lock.push(cat);
  }
  return { keep, lock };
}

/** 这一阶段被锁住的动画名（给 picker 用：别去点播它播不了的动画） */
export function lockedNames(animations, stage, unlock = DEFAULT_STAGE_UNLOCK, known) {
  const locked = new Set();
  for (const cat of splitCategories(animations, stage, unlock, known).lock) {
    for (const a of cat.actions ?? []) locked.add(a);
  }
  return locked;
}

/** 过滤出一份"这个阶段能用"的配置（只改 categories） */
export function filterAnimations(animations, stage, unlock = DEFAULT_STAGE_UNLOCK, known) {
  const allow = unlock?.[stage];
  if (!allow || allow === 'all' || !Array.isArray(animations?.categories)) return animations;
  const { keep } = splitCategories(animations, stage, unlock, known);
  if (keep.length === animations.categories.length) return animations;
  return { ...animations, categories: keep };
}

/**
 * 造一个挑动画的函数。`animations` 就是 dsh-pet 的 config.animations（宿主本来就要读它来发 /config）。
 * `stageOf` 给当前阶段（默认当成年，不做阶段过滤）—— 锁住的动画不会被点播，
 * 免得桌宠那边因为播不了而退化成随便抽一段。
 */
export function makeAnimPicker(animations, stageOf = () => 'Adult', unlock = DEFAULT_STAGE_UNLOCK, known) {
  const names = collectAnimations(animations);
  const whisperPool = []
    .concat(animations?.events?.whisper ?? [])
    .filter((x) => typeof x === 'string' && x);
  const lockedCache = new Map();
  const lockedFor = (stage) => {
    if (!lockedCache.has(stage)) lockedCache.set(stage, lockedNames(animations, stage, unlock, known));
    return lockedCache.get(stage);
  };

  const pick = (key, avoid = '') => {
    const locked = lockedFor(stageOf());
    const usable = (n) => names.has(n) && !locked.has(n);
    const cands = (SFX[key] ?? []).filter(usable);
    // 先挑「存在且不是刚播过的」，都播过就退而求其次随便挑一个存在的
    const fresh = cands.filter((n) => n !== avoid);
    const list = fresh.length ? fresh : cands;
    if (list.length) return list[rand(0, list.length - 1)];
    // 语义动画一个都没有（配置被改残了 / 这一阶段还没解锁）：退到说话池
    const freshWhisper = whisperPool.filter((n) => usable(n) && n !== avoid);
    const w = freshWhisper.length ? freshWhisper : whisperPool.filter(usable);
    return w.length ? w[rand(0, w.length - 1)] : null;
  };

  return { pick, has: (n) => names.has(n), size: names.size };
}
