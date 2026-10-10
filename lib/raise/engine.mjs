/**
 * engine.mjs —— 养成状态机
 *
 * 移植自 qqpet 的 `pet/store.ts`（属性、推导值）与 `pet/pet.ts`（每分钟结算、生病、死亡、复活），
 * 数字与判定条件逐条对照过。**表现层换掉了**：
 *   原版是「说说 + 弹窗 + SWF 动画」，这里变成「往事件队列里塞一条 {文字, 动画}」，
 *   宿主每秒经 /broadcast 交给桌宠，桌宠弹气泡 + 播指定的 dsh-pet 动画。
 *   （原版弹窗上的确认按钮没有了 —— 右键菜单点下去本身就是确认，见 items.mjs 的说明。）
 *
 * 每分钟结算 tick() 一次，但**按时钟补算**：宿主睡了一会儿再醒来，会把缺的分钟数一次算清；
 * 而宿主没跑的那段时间不算数（原版同理：关掉应用，宠物不会变饿）。所以「出差回来宠物还在」，
 * 但一直开着却不管它，是会饿死/病死的 —— 这点跟 qqpet 一致。
 */
import { load, save as writeSave, rand, fresh, buried } from './state.mjs';
import { levelOf, stageOf, STAGE_NAMES } from './level.mjs';
import { line, greeting, smallTalk, fillHost, illOf, DEAD } from './text.mjs';
import { goodOf, tickTimed, listGoods } from './goods.mjs';
import { useItem } from './items.mjs';
import { makeAnimPicker } from './anim.mjs';
import * as activity from './activity.mjs';

/** 心情档位：[下限, 名字, 成长系数] —— 原版 store.ts 的 MOODS */
const MOODS = [
  [800, 'happy', 1],
  [500, 'peaceful', 0.9],
  [200, 'upset', 0.7],
  [-Infinity, 'sad', 0.5],
];

/** 饿/脏/闷的顺序：先喂、再洗、再陪玩（原版 pet.ts 的 NEEDS） */
const NEEDS = [
  { stat: 'hunger', type: 'food', act: '吃东西' },
  { stat: 'clean', type: 'clean', act: '洗白白' },
  { stat: 'mood', type: 'toy', act: '玩玩具' },
];

/** 环境提醒的默认最小间隔（ms）：没人管它的时候，别把气泡刷屏（可用 ambientGapSec 调） */
const AMBIENT_GAP_MS = 600 * 1000;

/** 心情见底时，各类活动的收场台词（原版 pet.ts 的 MOOD_OUT） */
const MOOD_OUT = { work: 'stopWorkFoMood0', study: 'stopStudyFoMood0', trip: 'overTripUpFoMood0' };

/** 单次记账最多认这么多 token（异常兜底，见 creditTokens） */
const MAX_CREDIT_TOKENS = 20_000_000;

/** 原版自然成长的基准：80 成长值/小时 —— 粉钻与限时物品的加成都是相对它的，折算比例时也用它当分母 */
const BASE_GROWTH_PER_HOUR = 80;

export class Raise {
  /**
   * @param {object}   o
   * @param {object}   o.animations dsh-pet 的 config.animations（决定能播哪些动画）
   * @param {Function} o.tokens     () => {tokens, requests} | null —— 自上次调用以来 CC Switch 里新增的用量
   * @param {object}   o.config     节奏参数（见 index.mjs 的环境变量表）
   */
  constructor({ animations, tokens = null, config = {} } = {}) {
    this.save = load();
    this.cfg = {
      // token → 成长值/元宝的汇率（默认：100 万 token = 500 成长值 + 100 元宝）
      growthPerMTok: 500,
      ybPerMTok: 100,
      /** 自然成长（原版那条"陪着就长大"）：默认关，只吃 token；PET_RAISE_NATURAL=on 可恢复 */
      naturalGrowth: false,
      /** 主动说话的最小间隔 */
      ambientGapMs: AMBIENT_GAP_MS,
      ...config,
    };
    this.tokens = tokens;
    // 动画池按阶段解锁：小的时候会的不多（见 anim.mjs 的 DEFAULT_STAGE_UNLOCK），
    // stageUnlock 传 null 就等于不锁（配置项 stageUnlock=off）；
    // stageUnlockKnown 是宿主从上游配置读来的"认识的名字"，跟 /config 过滤共用一份
    this.anim = makeAnimPicker(animations, () => stageOf(this.meta.level), this.cfg.stageUnlock ?? null, this.cfg.stageUnlockKnown);
    /** 待弹事件：[{ts, text, anim, kind}]，一次只交给桌宠一条 */
    this.events = [];
    /** 已经交出去、还在等桌宠来取的那条（3 秒宽限，防止某次轮询失败就丢了） */
    this.served = null;
    this.servedAt = 0;
    this.lastAmbient = 0;
    this.lastTs = 0;
    this.dirty = false;
    this.lastAnim = '';
    /** 进行中的升学考试（内存态，重启就作废 —— 考试本来就得一次考完） */
    this.exam = null;
    /** 各玩法挂进来的钩子：每分钟 / 跨天 / 任务计数 / 重启后续上没做完的事 / 粉钻开通时的一次性动作 / 换新宠物时清缓存
     *  （第 3 阶段起：tasks/signin/mail/fishing 挂这里，引擎本身不认这些玩法）
     *  调用签名统一是 fn(st, 参数) */
    this.hooks = { tick: [], daily: [], count: [], resume: [], reopen: [], adopt: [], tokens: [] };
    this.listeners = [];
    /** 上次记账的时间戳（秒）；null = 下一 tick 只对表不补算 */
    this.lastTick = this.save.lastTick ?? null;
    this.syncLevel();
  }

  // -------------------------------------------------------------------------
  // 状态读写
  // -------------------------------------------------------------------------
  get info() {
    return this.save.petInfo;
  }
  get meta() {
    return this.save.petComputedlInfo;
  }
  /** 标记「存档有变化」；真正落盘由 index.mjs 批量做 */
  markDirty() {
    this.dirty = true;
  }
  activity(k) {
    return this.save.activeOption[k];
  }
  setActivity(k, v) {
    this.save.activeOption[k] = v;
    this.markDirty();
  }
  busy() {
    return Boolean(this.activity('work') || this.activity('study') || this.activity('trip'));
  }

  onInfoChange(cb) {
    this.listeners.push(cb);
  }

  setInfo(key, value) {
    const prev = this.info[key];
    if (prev === value) return;
    this.info[key] = value;
    this.markDirty();
    for (const cb of this.listeners) cb(key, prev);
  }

  addInfo(key, delta) {
    this.setInfo(key, this.info[key] + delta);
  }

  /** 心情档位名：happy / peaceful / upset / sad */
  mood() {
    return MOODS.find(([min]) => this.info.mood >= min)[1];
  }
  stage() {
    return stageOf(this.meta.level);
  }
  stageName() {
    return STAGE_NAMES[this.stage()];
  }
  /** 0 = 精神，越大越累；越大越容易生病（原版 store.ts 的 fatigue） */
  fatigue() {
    const c = this.meta;
    const m = this.info.mood / c.moodMax;
    const cl = this.info.clean / c.cleanMax;
    const h = this.info.hunger / c.hungerMax;
    let f =
      (this.info.health !== 5 ? 2 : 0) +
      (m < 0.2 ? 3 : m < 0.5 ? 2 : 0) +
      (cl < 0.2 ? 2 : cl < 0.5 ? 1 : 0) +
      (h < 0.2 ? 2 : h < 0.5 ? 1 : 0);
    if (!f) return 0;
    if (this.busy()) f += 2;
    const strong = this.info.strong;
    const relief = c.level < 10 ? (strong > 500 ? 2 : 0) : strong > 50000 ? 4 : strong > 5000 ? 2 : 0;
    return Math.max(0, f - relief);
  }
  /** 0..20：粉钻/情侣/魅力/智力加成，疲劳扣分（原版 store.ts 的 luck） */
  luck() {
    let l = 1 + (this.info.pinkDiamond ? this.info.PDiamondLevel * 2 : 0) + (this.info.sweetHeart ? 2 : 0);
    l += [500, 5000, 50000].filter((v) => this.info.charm > v).length;
    l += [800, 8000, 80000].filter((v) => this.info.intel > v).length;
    return Math.min(Math.max(0, l - (this.fatigue() >> 1)), 20);
  }

  /**
   * 原版的「自然成长」速率：每分钟长多少成长值（80/小时 × 心情系数，粉钻与限时物品再加）。
   * 默认不参与结算（见 account()）—— 它现在只用来算加成比例，见 growthFactor()。
   */
  growthPerMinute() {
    if (this.info.mood <= 0) return 10 / 60;
    const rate = MOODS.find(([min]) => this.info.mood >= min)[2];
    let perHour = 80 * rate + (this.info.pinkDiamond ? 10 : 0);
    for (const [type, t] of Object.entries(this.save.selfGoodUseOption)) {
      if (!t) continue;
      const g = goodOf(type, t.id);
      perHour += g?.group ?? 0;
    }
    return (perHour * (this.info.sweetHeartOverTime ? 1.1 : 1)) / 60;
  }

  /**
   * token → 成长值 的换算系数（1 = 按汇率原价换算）。三部分：
   *   - 心情系数：原版四档（开心 1 / 平静 0.9 / 郁闷 0.7 / 难过 0.5）—— 心情不好，token 也长得慢
   *   - 贴心宝贝：1.1 倍（原版就是这个乘数）
   *   - 粉钻 +10/小时、限时物品的「成长值/小时」：原版是往 80/小时 的基准上**加**点数，
   *     这边没有自然成长可加了，就按同一个基准折成比例（+10/小时 = +12.5%）
   * `sources` 是给用户看的来源明细（光给一个 ×1.38 没人知道它哪来的）
   */
  growthFactor() {
    const mood = MOODS.find(([min]) => this.info.mood >= min)[2];
    let bonusPerHour = 0;
    const sources = [];
    if (this.info.pinkDiamond) {
      bonusPerHour += 10;
      sources.push('粉钻 +10/时');
    }
    for (const [type, t] of Object.entries(this.save.selfGoodUseOption)) {
      if (!t) continue;
      const g = goodOf(type, t.id);
      if (!g?.group) continue;
      bonusPerHour += g.group;
      sources.push(`${g.name} +${g.group}/时`);
    }
    if (bonusPerHour) sources.push(`÷ 基准 80 = ×${(1 + bonusPerHour / 80).toFixed(3)}`);
    const sweet = this.info.sweetHeartOverTime ? 1.1 : 1;
    if (sweet !== 1) sources.push('贴心宝贝 ×1.1');
    const bonus = (1 + bonusPerHour / BASE_GROWTH_PER_HOUR) * sweet;
    return { mood, bonus, total: mood * bonus, bonusPerHour, sweet, sources };
  }

  /** 按成长值重算等级与容量上限；返回变化前的等级 */
  syncLevel() {
    const c = this.meta;
    const prev = c.level;
    const l = levelOf(this.info.growth);
    const max = 1000 + Math.min(l.level, 70) * 100;
    if (l.level !== prev || max !== c.hungerMax) {
      Object.assign(c, l, { hungerMax: max, cleanMax: max });
      this.markDirty();
      // 跨阶段（蛋 → 幼年 → 成年）：动画池是按阶段解锁的，得让桌宠重载一次配置才生效。
      // 宿主会把当前阶段一直放在广播里，桌宠自己比对（见 lib/host.mjs 与 patch.mjs 的 raise-reload），
      // 所以这里**不需要**留什么"请重载"的标记 —— 那种一次性的信号很容易被别的轮询者消费掉，
      // 或者反过来变成一个窗口期里反复触发重载。
      if (stageOf(l.level) !== stageOf(prev)) {
        try {
          this.onStageChange?.(stageOf(prev), stageOf(l.level));
        } catch (e) {
          this.log?.('[raise] 阶段变化回调出错：' + e.message);
        }
      }
    }
    return prev;
  }

  // -------------------------------------------------------------------------
  // 说话：进事件队列，宿主每秒一条交给桌宠
  // -------------------------------------------------------------------------
  /**
   * @param {string} text  要说的话（里面的 [host] 会被换成主人名）
   * @param {string} key   语义动画键（anim.mjs 的 SFX），空 = 让桌宠随机抽说话动画
   * @param {object} o     kind: 'ambient'（默认，会节流）/ 'act'（用户点的，立刻说）
   *                       force: 免打扰时也照说（"免打扰开啦"这句本身就得说）
   *                       after: 毫秒，推迟这么久再说（一句话拆成几条时用，别抢同一口气泡）
   */
  say(text, key = '', { kind = 'ambient', force = false, after = 0 } = {}) {
    if (!text) return null;
    if (this.save.settings.quiet && !force) return null; // 免打扰：不主动说话
    const now = Date.now();
    if (kind === 'ambient') {
      const gap = this.cfg.ambientGapMs ?? AMBIENT_GAP_MS;
      if (now - this.lastAmbient < gap) return null;
      if (this.events.some((e) => e.kind === 'ambient')) return null;
      this.lastAmbient = now;
    }
    const anim = key ? this.anim.pick(key, this.lastAnim) : '';
    if (anim) this.lastAnim = anim;
    // ts 必须严格递增：桌宠靠"ts 变了"决定弹不弹气泡，
    // 同一毫秒里说两句（看病先是诊断、再是吃药）会挤成同一个 ts，第二句就永远不弹
    const ts = Math.max(now + after, (this.lastTs ?? 0) + 1);
    this.lastTs = ts;
    const ev = { ts, at: now + after, text: fillHost(text, this.info.host), anim, kind };
    this.events.push(ev);
    return ev;
  }

  /** 抽一句现成台词说出来（抽不到就返回 null，不弹空气泡） */
  sayLine(cat, sub, key = '', opts) {
    return this.say(line(cat, sub), key, opts);
  }

  /** 任务计数（今日任务模块挂的钩子；没挂就是空转） */
  count(counter) {
    for (const fn of this.hooks.count) fn(this, counter);
  }

  /** 宿主每秒调用：取出当前该交给桌宠的那一条（同一条 3 秒内不重复给） */
  poll(now = Date.now()) {
    if (this.served && now - this.servedAt < 3000) return this.served;
    this.served = null;
    const i = this.events.findIndex((e) => e.at <= now); // at 还没到的先不说（见 say 的 after）
    if (i >= 0) this.served = this.events.splice(i, 1)[0];
    this.servedAt = now;
    return this.served;
  }

  /** 当前排队的事件数（诊断用） */
  get pending() {
    return this.events.length;
  }

  // -------------------------------------------------------------------------
  // 时间：06:00 换日（原版 vip.ts 的 dayStart）
  // -------------------------------------------------------------------------
  dayStart(now = Date.now() / 1000) {
    const d = new Date(now * 1000);
    d.setHours(6, 0, 0, 0);
    if (d.getTime() > now * 1000) d.setDate(d.getDate() - 1);
    return d.getTime() / 1000;
  }

  /** 每次记账的入口：宿主每 60 秒叫一次；内部按时钟差补算 */
  grow() {
    // 死了或暂停成长：只对表，不补算（原版 grow() 里 lastTick = null 的语义）
    if (this.info.health <= 0 || this.save.settings.paused) {
      this.lastTick = null;
      this.save.lastTick = null;
      return;
    }
    this.tick();
    this.healthRoll();
  }

  /** 按墙上时钟结算经过的分钟数 */
  tick() {
    const now = Math.floor(Date.now() / 1000);
    const today = this.dayStart(now);
    if (this.save.nowTimeLine <= today) {
      this.setInfo('onlineDataTime', 0);
      this.newDay(today);
      for (const fn of this.hooks.daily) fn(this, today);
      this.daily(today);
    }
    if (this.lastTick !== null) {
      const minutes = +((now - this.lastTick) / 60).toFixed(5);
      // 宿主睡了很久（合盖/挂起）再醒来，一次补算太多分钟会很难看：
      // 最多按 6 小时算，剩下的当「它自己睡了」，与"关掉不算"同一口径
      const accounted = Math.min(minutes, 360);
      this.account(accounted, minutes);
    }
    this.lastTick = now;
    this.save.lastTick = now;
    // 换日判定读的是存档根上的 nowTimeLine（原版就是 update('nowTimeLine', now)），
    // 别写进 petInfo —— 写错了会让"今天"每分钟都算一次跨天
    this.save.nowTimeLine = now;
    this.markDirty();
  }

  /** 一分钟一分钟的账：在线时长、状态衰减、成长、限时物品、任务推进 */
  account(minutes, realMinutes = minutes) {
    if (minutes <= 0) return;
    this.addInfo('onlineDataTime', minutes);
    this.addInfo('onLineTime', minutes);
    const extra = this.busy() ? 1 : 0;
    const moodRate = rand(1, 2) + extra;
    // 成长只算「心情还撑得住」的那部分时间；心情见底则当前活动立刻停手
    const grown = Math.min(minutes, this.info.mood / moodRate);
    if (grown < minutes) {
      const stopped = activity.stopTask(this);
      const out = MOOD_OUT[stopped];
      if (out) this.sayLine('state', out, 'sad', { kind: 'act' });
    }
    this.setInfo('mood', Math.max(this.info.mood - moodRate * minutes, 0));
    this.setInfo('hunger', Math.max(this.info.hunger - (rand(2, 3) + extra) * minutes, 0));
    this.setInfo('clean', Math.max(this.info.clean - (rand(2, 3) + extra) * minutes, 0));
    // 自然成长（原版那条：挂机每分钟长 80/小时 × 心情系数）：**默认关掉了**。
    // 现在成长值只从 token 来 —— 不写代码的日子它不长个，但照样会饿会脏会生病。
    // 想要原来那种"陪着就长大"的节奏，设 PET_RAISE_NATURAL=on。
    if (this.cfg.naturalGrowth) {
      const natural = this.growthPerMinute() * grown;
      if (natural) this.addInfo('growth', +natural.toFixed(8));
    }

    // ---- token 驱动：这段时间 CC Switch 里新发生的用量，折算成成长值与元宝 ----
    const gain = this.tokens ? this.tokens() : null;
    if (gain && gain.tokens > 0) this.creditTokens(gain, minutes);

    if (this.info.sweetHeart) this.selfCare();
    for (const type of tickTimed(this, grown)) this.sayLine('state', `${type}Over`, '', { kind: 'act' });
    activity.advanceTask(this, grown);
    // 钩子给的是**真实经过的分钟数**，不是 grown：在线奖励的 20 分钟倒计时得按真实时间走
    // （原版 pet.ts 里 tickGift(minutes) 也是传 minutes）—— 心情见底时它照样在计时
    for (const fn of this.hooks.tick) fn(this, minutes);
    // 跳过的那段（超过 6 小时）按"它自己睡觉"处理，不惩罚、也不长个
    if (realMinutes > minutes) this.markDirty();
  }

  /** 把一段 token 用量换成成长值 + 元宝，并（有节制地）说一声 */
  creditTokens({ tokens, requests = 0 }, minutes) {
    // 兜底：单次记账认下这么多就算离谱了（正常人一天也就几千万），
    // 多半是库被换过/水位丢了 —— 宁可少给，也不让宠物一夜满级
    let tok = tokens;
    if (tok > MAX_CREDIT_TOKENS) {
      this.log?.(`[raise] 单次用量异常（${tok} token），按 ${MAX_CREDIT_TOKENS} 计`);
      tok = MAX_CREDIT_TOKENS;
    }
    const factor = this.growthFactor();
    const growth = (tok / 1e6) * this.cfg.growthPerMTok * factor.total; // 元宝不打折，成长值按系数
    const yb = Math.floor((tok / 1e6) * this.cfg.ybPerMTok);
    if (growth) this.addInfo('growth', +growth.toFixed(6));
    if (yb) this.setInfo('yb', this.info.yb + yb);
    this.markDirty();
    // 记一笔用量（成就里的"累计 token""单日 token"要）
    for (const fn of this.hooks.tokens) fn(this, tok, minutes);
    // 报账：最多半小时一次，且别跟别的环境提醒抢
    const now = Date.now();
    if (now - (this.lastTokenNews ?? 0) > 30 * 60_000) {
      this.lastTokenNews = now;
      const h = human(tok);
      const bits = [`主人这段时间写了 ${h} token`, yb ? `我赚了 ${yb} 元宝` : '', growth ? '长了成长值' : ''];
      // 心情不好时换算会打折，说清楚，免得"我明明写了这么多 token"却对不上账
      if (factor.total < 0.95) bits.push('（心情不太好，长得慢一点）');
      this.say(`${bits.filter(Boolean).join('，')}~`, 'happy');
    }
  }

  /** 06:00 换日：粉钻成长结算与到期、情侣到期（原版 vip.ts 的 newDay） */
  newDay(today) {
    const DAY = 86400;
    const LEVELS = [0, 100, 300, 800, 1200, 2800, 5800, 99999999];
    if (this.info.pinkDiamond) {
      this.setInfo('PDgrowth', this.info.PDgrowth + (this.info.PDgrowthValue * (today - this.info.PDiamondBeginDate)) / DAY);
      this.setInfo('PDiamondBeginDate', today);
    }
    const active = this.info.PDiamondExpirationDate > today;
    this.setInfo('pinkDiamond', active);
    if (!active) {
      this.setInfo('PDiamondBeginDate', 0);
      this.setInfo('PDiamondExpirationDate', 0);
    }
    const level = Math.max(LEVELS.filter((g) => this.info.PDgrowth >= g).length, 1);
    this.setInfo('PDiamondLevel', level);
    this.setInfo('PDgrowthValue_next', LEVELS[level]);
    if (this.info.sweetHeartOverTime <= today) {
      this.setInfo('sweetHeartOverTime', 0);
      this.setInfo('sweetHeart', false);
    }
  }

  /** 开机/换日的那几句：时段问候 + 日期闲话（第一次还会提一句"右键有玩法"） */
  daily(today) {
    if (this.info.health <= 0) return;
    this.save.lastLoginTime = Math.floor(Date.now() / 1000);
    this.lastGreet = Date.now();
    const g = greeting();
    if (g) this.say(g, 'greet');
    else this.say(smallTalk(), 'greet');
    // 头一回：得让用户知道"能右键"这件事，否则桌面上就是一只会说话的挂件
    if (!this.save.onboarded) {
      this.save.onboarded = true;
      this.markDirty();
      this.say('[host]，右键点我可以喂饭、洗澡、打工、上学、出门旅游，还有一整套养成~', 'greet', { kind: 'act', after: 6000 });
    }
  }

  // -------------------------------------------------------------------------
  // 生病 / 死亡 / 复活
  // -------------------------------------------------------------------------
  /** 累了就随机生病；已经病了则继续掉健康（原版 pet.ts 的 healthRoll） */
  healthRoll() {
    const f = this.fatigue();
    if (!f) return;
    if (this.info.health !== 5) {
      if (rand(0, 700 - f * 50) < 5) this.setInfo('health', this.info.health - 1);
      return;
    }
    const r = rand(0, 1300 - f * 100);
    if (r < 10) {
      this.setActivity('ill', `${r % 3}-`);
      this.setInfo('health', 4);
    }
  }

  /** 健康度变化时该说的话（由 setInfo 的监听触发） */
  healthChanged(prev) {
    const h = this.info.health;
    if (h < 0 || Number.isNaN(h)) return this.setInfo('health', 0);
    if (h > 5) return this.setInfo('health', 5);
    if (h === 5) {
      if (prev === 0) this.revive();
      this.setActivity('ill', null);
      return;
    }
    if (h === 0) {
      this.say(DEAD.tolk, 'die', { kind: 'act' });
      return;
    }
    if (!this.activity('ill')) this.setActivity('ill', `${rand(0, 2)}-`);
    this.say(illOf(`${this.activity('ill')}${h}`).tolk, 'sick', { kind: 'act' });
  }

  /** 复活（还魂丹或健康度回到 5） */
  revive(quiet = false) {
    this.setActivity('ill', null);
    this.setInfo('health', 5);
    if (!quiet) this.say('[host]，再次见到你很高兴~~ ', 'revive', { kind: 'act' });
  }

  /** 领养一只新的（sex: 'GG' 男 / 'MM' 女）：埋掉旧的、按性别新生一只，名字沿用 */
  adopt(sex, name) {
    const next = buried(this.save, sex);
    if (name) next.petInfo.name = name;
    next.havePet = true;
    next.lastTick = null;
    this.save = next;
    this.lastTick = null;
    this.exam = null;
    activity.reset(); // 新宠物不接着上一条命的班/课/旅游
    // 新宠物：各玩法挂在实例上的缓存（鱼塘/任务/签到…）都要作废，
    // 否则会把上一条命的鱼、任务进度带过来，还会写回新存档里
    for (const fn of this.hooks.adopt) fn(this);
    this.markDirty();
    this.syncLevel();
    return this;
  }

  /** 甜蜜情侣：自己动手满足最紧要的那项需求（原版 pet.ts 的 selfCare） */
  selfCare() {
    const need = NEEDS.find((n) => this.info[n.stat] / this.meta[`${n.stat}Max`] < 0.6);
    if (!need) return;
    const g = listGoods(this, need.type)[0];
    if (g) useItem(this, g, { free: false, text: `[host]，我可以自己${need.act}哦！~~使用了：${g.name}` });
  }

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  flush(force = false) {
    if (!this.dirty && !force) return false;
    this.save.saveNum = (this.save.saveNum ?? 0) + 1;
    writeSave(this.save);
    this.dirty = false;
    return true;
  }

  /** 诊断用摘要 */
  status() {
    const i = this.info;
    return {
      name: i.name,
      sex: i.sex,
      stage: this.stageName(),
      level: this.meta.level,
      growth: +i.growth.toFixed(2),
      nextGrowth: this.meta.nextGrowth,
      hunger: `${Math.round(i.hunger)}/${this.meta.hungerMax}`,
      clean: `${Math.round(i.clean)}/${this.meta.cleanMax}`,
      mood: `${Math.round(i.mood)}/${this.meta.moodMax}（${this.mood()}）`,
      health: i.health,
      yb: i.yb,
      ill: this.activity('ill') ? illOf(`${this.activity('ill')}${i.health}`).name : null,
      busy: ['work', 'study', 'trip'].filter((k) => this.activity(k)),
      pinkDiamond: i.pinkDiamond,
      sweetHeart: i.sweetHeart,
      saturated: NEEDS.filter((n) => i[n.stat] / this.meta[`${n.stat}Max`] < 0.3).map((n) => n.stat),
    };
  }
}

/** 大数字口语化（1.2 万 / 3.4 亿） */
function human(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + ' 万';
  return String(n);
}

export { fresh, MOODS, NEEDS, human };
