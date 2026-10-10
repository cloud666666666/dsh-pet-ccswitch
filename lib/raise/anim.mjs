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
 * 造一个挑动画的函数。`animations` 就是 dsh-pet 的 config.animations（宿主本来就要读它来发 /config）。
 * 返回的 picker：
 *   pick('eat')        → 一个动画名 / null
 *   pick('eat', 'xxx') → 尽量别挑 xxx（避免连着两次同一个）
 *   has(name)          → 这个名字配置里有没有
 */
export function makeAnimPicker(animations) {
  const names = collectAnimations(animations);
  const whisperPool = []
    .concat(animations?.events?.whisper ?? [])
    .filter((x) => typeof x === 'string' && x);

  const pick = (key, avoid = '') => {
    const cands = (SFX[key] ?? []).filter((n) => names.has(n));
    // 先挑「存在且不是刚播过的」，都播过就退而求其次随便挑一个存在的
    const fresh = cands.filter((n) => n !== avoid);
    const list = fresh.length ? fresh : cands;
    if (list.length) return list[rand(0, list.length - 1)];
    // 语义动画一个都没有（配置被改残了）：退到说话池
    const freshWhisper = whisperPool.filter((n) => n !== avoid);
    const w = freshWhisper.length ? freshWhisper : whisperPool;
    return w.length ? w[rand(0, w.length - 1)] : null;
  };

  return { pick, has: (n) => names.has(n), size: names.size };
}
