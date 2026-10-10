/**
 * index.mjs —— 养成系统的对外接口（宿主只跟这个文件打交道）
 *
 *   createRaise({ animations, ... })  →  实例
 *     实例.menu()      右键菜单树（宿主下发给桌宠）
 *     实例.act(key)    执行一个菜单动作（key 见下面的 ACTIONS）
 *     实例.poll()      取一条待弹事件（宿主 /broadcast 每秒调一次）
 *     实例.start()/stop()  每分钟结算 + token 计量
 *     实例.status()    纯文本状态（命令行 status/doctor 用）
 *
 * 后续阶段的玩法（打工/上学/旅游/任务/签到/邮件/钓鱼/农场）挂两处：
 *   st.menuSections  自己往菜单里加一段
 *   st.hooks.*       每分钟 / 跨天 / 任务计数 / 重启恢复
 * 引擎不认识这些玩法，玩法模块也只在 index.mjs 里被装配一次。
 */
import { Raise, human } from './engine.mjs';
import { buildMenu, statusLines, STAGE_SHORT, MOOD_NAMES as MOOD_CN } from './menu.mjs';
import { useItem, doctor, buy, give } from './items.mjs';
import { goodOf, findGood, listGoods } from './goods.mjs';
import { createTokenMeter } from './tokens.mjs';
import * as settings from './settings.mjs';
import { line, smallTalk, fillHost, illOf, DEAD } from './text.mjs';
import { rand } from './state.mjs';
import { pay } from './items.mjs';
import * as jobs from './jobs.mjs';
import * as tasks from './tasks.mjs';
import * as signin from './signin.mjs';
import * as mail from './mail.mjs';
import * as vip from './vip.mjs';
import * as achv from './achv.mjs';
import * as fish from './fishing.mjs';
import * as activity from './activity.mjs';
import { createLink } from './link.mjs';
import { DEFAULT_STAGE_UNLOCK } from './anim.mjs';
import { createCalendar, festival, dayText } from './calendar.mjs';
import { weatherNews } from './weather.mjs';

/** 原版用托盘图标提示「饿了/脏了」，桌宠没有托盘，只能弹一句 —— 这两句是本项目新增的文案 */
const NEED_LINES = {
  hunger: '[host]，我肚子饿扁啦，给我点吃的嘛~~',
  clean: '[host]，我身上脏兮兮的，想洗个澡~~',
};
/** 两次"喊饿"之间至少隔这么久 */
const NEED_GAP_MS = 25 * 60_000;

/**
 * 可调项的来源：配置文件 > 环境变量 > 默认值（见 settings.mjs）。
 * 默认汇率按「重度使用者一天几千万 token」校准 —— 一天下来大概长几千成长值、赚几百到几千元宝，
 * 十来天能从宠物蛋长到成年。想要原版那种几个月才成年的节奏，把汇率调小即可。
 */
export function createRaise({ animations, platform = '', log = console.log, tokenEnabled = true, calendar = null, achievements = null, knownCategories = null } = {}) {
  const meter = createTokenMeter({
    platform,
    onError: (e) => log('[raise] 读用量失败：' + e.message),
  });
  const cfg = settings.resolveAll();
  const st = new Raise({
    animations,
    tokens: tokenEnabled ? () => meter.take() : null,
    config: {
      growthPerMTok: cfg.growthPerMTok.value,
      ybPerMTok: cfg.ybPerMTok.value,
      naturalGrowth: cfg.natural.value, // 默认关：只吃 token 长个
      ambientGapMs: cfg.ambientGapSec.value * 1000,
      // 动画池按阶段解锁（stageUnlock=off 时传 null = 不锁，用 dsh-pet 原配置）
      stageUnlock: cfg.stageUnlock.value === true || cfg.stageUnlock.value === 'on' ? DEFAULT_STAGE_UNLOCK : null,
      // 「认识的名字」由宿主从上游 config.jsonc 现读后传进来（跟 /config 过滤用的是同一份）——
      // 不传就会退回 anim.mjs 里那份写死的兜底清单，两边万一漂移，
      // 会出现"筛选器锁了、挑动画的却以为没锁"的错位
      stageUnlockKnown: knownCategories ?? undefined,
    },
  });
  // 水位起点：存档里有就接着上次算；**没有就从"现在"起算**，绝不从 0 起算 ——
  // 从 0 起算会把 CC Switch 库里攒了一个月的历史流量一次性算成成长值和元宝（实测 46 亿 token）。
  if (st.save.lastTokenTs) {
    meter.ts = st.save.lastTokenTs;
  } else {
    meter.ts = Math.floor(Date.now() / 1000);
    st.save.lastTokenTs = meter.ts;
    st.markDirty();
  }
  /** 各玩法模块自己往这里加菜单段（stage 2 起） */
  st.menuSections = [];
  st.lastNeedAt = 0;
  st.log = log;
  /** 日历（默认关，见 calendar.mjs 的说明）与天气（默认关）；calendar 可以注入，测试用 */
  const cal = calendar ?? createCalendar({ mode: cfg.calendar.value, log });
  const weatherOn = cfg.weather.value === true || cfg.weather.value === 'on';
  const weatherCity = cfg.weatherCity.value;
  st.calendar = cal;
  st.settings = cfg; // `raise config` 显示当前生效值用
  // 跨阶段时的说法（引擎只负责通知，话由这边说）
  const STAGE_CN = { Egg: '宠物蛋', Kid: '幼年期', Adult: '成年期' };
  st.onStageChange = (from, to) => {
    st.say(`[host]，我长成${STAGE_CN[to] ?? to}啦，还学会新本事了！~`, 'levelup', { kind: 'act' });
    log(`[raise] 阶段变化：${from} → ${to}（已请桌宠重载配置，解锁新的动画池）`);
  };

  /** 工作联动：工作区脏 → 它变脏；提交 → 洗澡；请求报错多 → 心情差（见 link.mjs） */
  const link = createLink({
    st,
    log,
    repo: cfg.linkRepo.value,
    git: cfg.linkGit.value === true || cfg.linkGit.value === 'on',
    errors: cfg.linkErrors.value === true || cfg.linkErrors.value === 'on',
    everyMs: cfg.linkEverySec.value * 1000,
  });
  st.link = link;
  /** 重启后接着做没做完的活（打工/上课/旅游） */
  st.hooks.resume.push(jobs.resumeTask);
  /**
   * 抽今天的任务。日历开着的时候要**等它拉到再抽** —— 否则启动那一下 cal.today() 还是空的，
   * 节假日会被当成普通工作日算（少一条「XX快乐」任务、放假日权重也不对），
   * 而 rollDaily 一旦盖了当天的戳，当天就不会再抽了。
   */
  function rollDaily() {
    if (!cal.enabled || cal.today()) return tasks.rollDaily(st, cal.today());
    void cal.load().then(() => tasks.rollDaily(st, cal.today()));
    return undefined;
  }

  /** 跨天：重置任务与签到、重抽今日任务、鱼塘加速到账、发该发的邮件；日历与天气顺手刷新 */
  st.hooks.daily.push(
    (s) => tasks.resetTasks(s),
    () => rollDaily(),
    (s) => signin.resetSignIn(s),
    (s) => fish.resetFish(s),
    (s, today) => {
      if (mail.deliverMails(s, cal.today())) s.say('[host]，邮箱里来了新邮件，快去看看吧~', 'gift');
    },
    (s) => mail.prune(s),
    (s, today) => {
      const f = festival(cal.today());
      if (f) s.say(f, 'greet', { kind: 'act' });
      void calendarRefresh();
    },
  );
  /** 每分钟：在线奖励倒计时 + 生日礼物 */
  st.hooks.tick.push(
    (s, minutes) => signin.tickGift(s, minutes),
    (s) => signin.birthdayGift(s),
  );
  /** 计数：吃东西/洗澡/玩玩具（items 里调的）、打工/上学/旅游（jobs 里调的）都汇到这里 */
  st.hooks.count.push((s, counter) => tasks.addCount(s, counter));
  /** 用量记账（成就里的累计 token / 单日 token）—— 统计一直记，跟成就有没有开无关 */
  st.hooks.tokens.push((s, tok) => {
    achv.bump(s, 'tokens', tok);
    achv.bump(s, 'dayTokens', tok);
  });
  /** 成就：每分钟检查一遍（十几条比较，很便宜）。achievements=false 时只记统计不解锁
   *  ——但**跨天统计永远要跑**（dayTokens 全靠它清零，落了会让"单日 token"变成累计值） */
  const achvOn = achievements ?? (cfg.achievements.value === true || cfg.achievements.value === 'on');
  st.achvOn = achvOn;
  st.hooks.daily.push((s) => achv.newDay(s));
  if (achvOn) st.hooks.tick.push((s) => achv.check(s));
  /** 开通粉钻的那一下：池塘当天加速次数到账（原版 vip.ts 里也是开通时 resetFish） */
  st.hooks.reopen.push((s) => fish.resetFish(s));
  /** 换新宠物：把各模块挂在实例上的缓存清掉（鱼塘/任务进度/签到/成就都别跟着新宠物走） */
  st.hooks.adopt.push(
    (s) => tasks.forget(s),
    (s) => signin.forget(s),
    (s) => achv.forget(s),
    (s) => {
      s.pond = null;
      s.pondLast = 0;
    },
  );
  // 启动时也把今天的任务备好（原版是启动即 daily()）——
  // 日历开着时这一步是异步的，见 rollDaily()
  rollDaily();

  // ---- 状态变化时该说的话（原版 pet.ts 的 onInfoChange 那几支）----
  let lastMood = st.mood();
  st.onInfoChange((key, prev) => {
    if (key === 'growth') {
      const before = st.syncLevel();
      const now = st.meta.level;
      if (now === before) return;
      const first = (now === 5 && before === 4) || (now === 10 && before === 9);
      st.say(line(first ? `first${now === 5 ? 1 : 2}` : 'levUp') ?? '我升级啦~', 'levelup', { kind: 'act' });
    } else if (key === 'health') {
      st.healthChanged(prev);
    } else if (key === 'mood' && st.mood() !== lastMood) {
      lastMood = st.mood();
      // 原版只在成年后才对心情变化说话
      if (st.stage() === 'Adult') st.sayLine('mood', lastMood, 'sad');
    }
  });

  // -------------------------------------------------------------------------
  // 动作分发：菜单叶子上的 raise 串就是这里认识的 key
  // -------------------------------------------------------------------------
  const ACTIONS = {
    /** 状态：多行文本，桌宠那边会逐行渲染 */
    status: (s) => s.say(statusLines(s).join('\n'), 'happy', { kind: 'act' }),

    /** 随便说一句（102 句闲聊里抽） */
    talk: (s) => s.say(smallTalk() ?? '今天也要加油哦~', 'greet', { kind: 'act' }),

    /** 撒个欢：就是让它玩一下自己的玩具，没玩具就自己乐呵 */
    play: (s) => {
      const toy = listGoods(s, 'toy')[0];
      if (toy) return useItem(s, toy);
      s.setInfo('mood', Math.min(s.info.mood + 30, s.meta.moodMax));
      s.say(line('toy', 'toy') ?? '我自己也能玩得很开心~', 'toy', { kind: 'act' });
      return true;
    },

    /** 看病（诊费 + 开药，见 items.mjs 的说明） */
    doctor: (s) => doctor(s),

    /** 复活：背包里有还魂丹就直接用，没有就按原价 120% 买一颗（与医生开药同一规则） */
    revive: (s) => {
      if (s.info.health !== 0) return s.say('[host],我活得好好的呀~', 'happy', { kind: 'act' });
      const g = goodOf('medicine', DEAD.cure.id);
      const owned = listGoods(s, 'medicine').some((x) => x.id === g.id);
      if (!owned) {
        const cost = Math.round((g.price || 50) * 1.2);
        if (!s.ybEnough(cost)) return s.say(`抱歉您的余额不足，还魂丹要${cost}元宝`, 'sad', { kind: 'act' });
        s.setInfo('yb', s.info.yb - cost);
      }
      return useItem(s, g, { free: !owned });
    },

    /** 安葬（埋了就能重新领养）：把 havePet 记成假，菜单随即变成「领养」） */
    bury: (s) => {
      if (s.info.health !== 0) return s.say('[host],我还活着呢，别埋我！~', 'sad', { kind: 'act' });
      s.save.havePet = false;
      s.save.isBury = true;
      s.setActivity('die', 'buried');
      s.setActivity('ill', null);
      s.markDirty();
      s.say(line('state', 'bury') ?? '[host]，再见了，谢谢你养过我~~', 'die', { kind: 'act' });
      return true;
    },

    /** 领养（菜单里是分支，这两个是叶子） */
    'adopt:GG': (s) => adopt(s, 'GG'),
    'adopt:MM': (s) => adopt(s, 'MM'),

    // ---- 打工 / 上学 / 旅游 / 升学考试（jobs.mjs）----
    'exam:quit': (s) => {
      s.exam = null;
      s.say('好吧，那下次再考~', 'sad', { kind: 'act' });
    },

    /** 相簿：原版是一墙明信片照片，这边把拍到的地点列出来 */
    album: (s) => {
      const list = jobs.shots(s);
      if (!list.length) return s.say('[host]，我还没出去旅游过呢，相簿是空的~', 'sad', { kind: 'act' });
      const wen = list.slice(-6).map((x) => x.city.replace(/[市省]$/, '')).join('、');
      s.say(`相簿里有 ${list.length}/${jobs.photoCount()} 张明信片，最近去过：${wen}`, 'greet', { kind: 'act' });
    },

    /** 图鉴：原版是一面收藏墙，这边报个数（收藏 = 见过/用过/买过的物品 id） */
    illustrated: (s) => {
      const n = s.save.illustrated.length;
      s.say(`图鉴已经收集了 ${n} 件物品啦~`, 'happy', { kind: 'act' });
    },

    /**
     * 详细属性：智力/魅力/武力、幸运、疲劳、生日、贵族到期、生效中的限时物品……
     * 这些原来在界面上一个字都没有，可它们决定了"能不能打工""多久会生病"（原版是宠物资料页）。
     * **每行都短**：气泡竖向只放得下 8 行、每行 16 个汉字（长了会被窗口顶上裁掉），
     * 所以这里只报数值，作用说明放在「❓」那两条里。
     */
    detail: (s) => {
      const i = s.info;
      const c = s.meta;
      const days = (ts) => Math.max(0, Math.ceil((ts - s.dayStart()) / 86400));
      const rows = [
        `${i.name} ${STAGE_SHORT[s.stage()] ?? s.stageName()} Lv.${c.level}`,
        // 属性名用单字简称：全称一行放不下（实测一行 10.5 个汉字）
        `智${Math.round(i.intel)} 魅${Math.round(i.charm)} 武${Math.round(i.strong)}`,
        `幸运${s.luck()} 疲劳${s.fatigue()} ${MOOD_CN[s.mood()] ?? s.mood()}${s.fatigue() >= 4 ? '易病' : ''}`,
        // 这一行原来是状态里的，太宽被挤掉了 —— 放这儿（8 行是硬上限，能塞就塞）
        `成长换算×${s.growthFactor().total.toFixed(2)}`,
        `上限${c.hungerMax} 在线${Math.round(i.onLineTime / 60)}小时`,
        `生日 ${new Date(i.birthDay * 1000).toLocaleDateString('zh-CN')}`,
      ];
      // 排序有讲究：气泡只放得下 8 行，放不下时兜底会截尾 ——
      // 限时物品最有时效性（快过期了），贵族天数最不着急，所以按这个顺序排
      const timed = Object.entries(s.save.selfGoodUseOption).filter(([, t]) => t);
      if (timed.length) {
        rows.push(`⏳ ${timed.map(([type, t]) => `${goodOf(type, t.id)?.name ?? t.id}${Math.round(t.left)}分`).join('、')}`);
      }
      if (i.pinkDiamond) rows.push(`💠粉钻Lv.${i.PDiamondLevel} 还剩${days(i.PDiamondExpirationDate)}天`);
      if (i.sweetHeartOverTime) rows.push(`🧸贴心宝贝 还剩${vip.sweetHeartDays(s)}天${i.sweetHeart ? '' : '(已关)'}`);
      s.say(rows.join('\n'), 'happy', { kind: 'act' });
    },

    /** 「这东西有什么用」——买了才知道作用是最气人的（每条都压在一行内） */
    'pd:help': (s) => {
      const head = s.info.pinkDiamond ? `💠 粉钻 Lv.${s.info.PDiamondLevel} · 还剩 ${vip.pinkDiamondDays(s)} 天` : '💠 粉钻（666 元宝开 5 天）';
      s.say([head, ...vip.PINK_DIAMOND_HELP.map((x) => `· ${x}`)].join('\n'), 'happy', { kind: 'act' });
    },
    'heart:help': (s) =>
      s.say(['🧸 贴心宝贝（300 元宝 / 天）', ...vip.SWEET_HEART_HELP.map((x) => `· ${x}`)].join('\n'), 'happy', { kind: 'act' }),

    /** 成就墙的点开看：说进度 */
    'achv:list': (s) => {
      const rows = achv.list(s);
      const got = rows.filter((a) => a.unlocked).length;
      const next = rows.filter((a) => !a.unlocked).sort((a, b) => b.done / b.need - a.done / a.need).slice(0, 3);
      s.say(
        [`🏆 成就 ${got}/${rows.length}`, ...next.map((a) => `· ${a.name} ${achv.human(a.done)}/${achv.human(a.need)}`)].join('\n'),
        'levelup',
        { kind: 'act' },
      );
    },

    // ---- 签到（signin.mjs）----
    'sign:in': (s) => (signin.signedToday(s) ? s.say('[host]，今天已经签过啦~', '', { kind: 'act' }) : signin.signToday(s)),
    'sign:growth': (s) =>
      signin.canDrawGrowth(s)
        ? signin.drawGrowth(s)
        : s.say('[host]，今天的成长值已经抽过啦，明天再来~', '', { kind: 'act' }),
    'sign:gift': (s) => {
      if (signin.onlineGiftWait(s) > 0) {
        s.say(`[host]，还得再陪我 ${signin.onlineGiftWait(s)} 分钟才能领哦~`, '', { kind: 'act' });
        return false; // 没到点就是没领到，别让命令行报"已执行"
      }
      // 收钱与报账都在 takeOnlineGift 里（那边才知道给了什么、扣了多少）
      return signin.takeOnlineGift(s);
    },
    'sign:month': (s) => s.say(`本月已经签了 ${signin.monthCount(s)} 天啦~`, 'happy', { kind: 'act' }),
    'sign:done': (s) => s.say('[host]，这个今天已经做过了，明天再来吧~', '', { kind: 'act' }),
    'mail:empty': (s) => s.say('[host]，邮箱是空的，没有新邮件~', '', { kind: 'act' }),

    // ---- 贵族（vip.mjs）----
    'pd:buy': (s) => vip.buyPinkDiamond(s, 5),
    'pd:info': (s) => s.say(`[host]，粉钻 Lv.${s.info.PDiamondLevel}，还能用 ${Math.ceil((s.info.PDiamondExpirationDate - Date.now() / 1000) / 86400)} 天~`, 'happy', { kind: 'act' }),
    'heart:buy1': (s) => vip.buySweetHeart(s, 1),
    'heart:buy7': (s) => vip.buySweetHeart(s, 7),
    'heart:toggle': (s) => vip.buySweetHeart(s, 1),

    /** 点宠物 = 逗它（原版是点身上的逗乐点位，这边整只都算） */
    'pet:click': (s) => {
      if (s.info.health <= 0) return false; // 死了就别逗了，也不该给「逗逗我」计数
      tasks.addCount(s, 'Amusing');
      achv.bump(s, 'amuse'); // 累计逗它次数（成就用；和每日任务的计数各算各的）
      if (Math.random() < 0.25) {
        s.setInfo('mood', Math.min(s.info.mood + 5, s.meta.moodMax)); // 原版逗乐点位会加心情
        s.say(line('smallTalk') ?? '嘿嘿~', 'happy', { kind: 'act' });
      }
      return true;
    },

    // ---- 池塘养鱼（fishing.mjs）----
    'fish:state': (s) => s.say(fish.pondText(s), 'fish', { kind: 'act' }),
    'fish:harvestall': (s) => fish.harvestAll(s),
    'fish:speed': (s) => fish.speedUp(s),

    /** 今天几号、什么日子（原版状态页上的日期那一行） */
    today: (s) => s.say(dayText(cal) + (s.calendar.enabled ? '' : '（日历未启用，按周末算放假）'), 'greet', { kind: 'act' }),

    /** 工作区状态（工作联动）：点一下就把当前脏没脏念一遍 */
    'link:state': (s) => {
      if (!s.link?.on) return s.say('[host]，还没接工作区呢（`raise config linkRepo=<仓库路径>` 就能接上）', '', { kind: 'act' });
      void s.link.sample().then(() => s.say(s.link.text(), 'clean', { kind: 'act' }));
    },

    pause: (s) => {
      s.save.settings.paused = true;
      s.markDirty();
      s.say(line('state', 'stopGrowth') ?? '[host]，我暂停成长啦~', '', { kind: 'act' });
    },
    resume: (s) => {
      s.save.settings.paused = false;
      s.markDirty();
      s.lastTick = null; // 暂停期间不补算
      s.save.lastTick = null;
      s.say(line('state', 'startGrowth') ?? '[host]，我继续长大啦~', 'happy', { kind: 'act' });
    },
    'quiet:toggle': (s) => {
      const on = !s.save.settings.quiet;
      s.save.settings.quiet = on;
      s.markDirty();
      // 开免打扰的那一下也得让它说完再闭嘴，所以这句 force 硬发
      s.say(line('sys', on ? 'doNotDisturbNO' : 'doNotDisturbOFF') ?? (on ? '免打扰开啦~' : '我又可以说话啦~'), '', {
        kind: 'act',
        force: true,
      });
    },
  };

  /** 领养一只新蛋 */
  function adopt(st2, sex) {
    const oldName = st2.info.name;
    st2.adopt(sex);
    st2.info.name = oldName;
    st2.markDirty();
    st2.say('[host]，我出生啦~~ 以后请多多关照！', 'greet', { kind: 'act' });
    return true;
  }

  /** 元宝够不够（revive 里先问一句，避免扣不动还往下走） */
  st.ybEnough = (n) => st.info.yb >= n;

  /** 背包里那件东西用掉 */
  function use(st2, type, id) {
    const g = listGoods(st2, type).find((x) => x.id === id) ?? goodOf(type, id);
    return useItem(st2, g);
  }

  /** 买一件（菜单里点一下 = 买一个） */
  function buyOne(st2, type, id) {
    const g = goodOf(type, id);
    return g?.price ? buy(st2, g, 1) : false;
  }

  /** 「背包空了去商店」的捷径：直接把该类型的推荐商品摆出来（菜单由 menu.mjs 重建时已经展开了） */
  const shopHint = (s, type) =>
    s.say(`[host]，${type === 'food' ? '没吃的了' : type === 'clean' ? '没有洗浴用品了' : '背包里没有'}，去商店那一栏看看~`, 'sad', {
      kind: 'act',
    });

  /**
   * 执行一个菜单动作。返回 true/false（命令行与 HTTP 用得到）。
   * key 形如 `use:food:100010032`；冒号后面都是参数。
   */
  function act(key) {
    const raw = String(key ?? '');
    const [head, a, b] = raw.split(':');
    const two = `${head}:${a}`; // 带一个参数的动作（adopt:GG / quiet:toggle）
    menuCache = null; // 动作会改状态（背包/任务/元宝），菜单必须重建，别等那 10 秒缓存过期
    try {
      if (ACTIONS[raw]) return ACTIONS[raw](st) !== false;
      if (ACTIONS[two]) return ACTIONS[two](st) !== false;
      if (head === 'use') return use(st, a, b) !== false;
      if (head === 'buy') return buyOne(st, a, b) !== false;
      if (head === 'shop') return shopHint(st, a) !== false;
      if (head === 'work') return jobs.work(st, goodOf('work', a)) !== false;
      if (head === 'study') return jobs.study(st, jobs.lessonOf(st, a.split('-')[1])) !== false;
      if (head === 'trip') {
        if (a === 'finish') return tasks.finishTour(st) !== false;
        return jobs.travel(st) !== false;
      }
      if (head === 'exam') return jobs.answer(st, +a) !== false;
      if (head === 'claim') return tasks.claim(st, a, +b) !== false;
      if (head === 'mail') return mail.claim(st, +a) !== false;
      if (head === 'achv') {
        st.say(achv.describe(st, a), 'happy', { kind: 'act' });
        return true;
      }
      if (head === 'fish') {
        if (a === 'buy') return fish.buy(st, b) !== false;
        if (a === 'feed') return fish.feed(st, b) !== false;
        if (a === 'harvest') return fish.harvest(st, b) !== false;
      }
      if (head === 'taskmsg') {
        // 任务没做完时点它：让它把这条任务的要求说一遍（原版任务页上的说明文字）
        const t = tasks.tasks(st, a)[+b];
        if (t) st.say(t.msg, 'happy', { kind: 'act' });
        return Boolean(t);
      }
      st.log('[raise] 不认识的动作：' + raw);
      return false;
    } catch (e) {
      st.log('[raise] 动作 ' + raw + ' 出错：' + (e?.stack ?? e));
      st.say('[host]，我这会儿有点难受……', 'sad', { kind: 'act' });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 每分钟：结算 + 环境提醒
  // -------------------------------------------------------------------------
  let timer = null;
  let flushTimer = null;
  let menuCache = null;
  let menuAt = 0;
  let lastWeather = 0;

  /** 日历：拿今天的（失败就静默退回"按周末算"） */
  const calendarRefresh = () => cal.load();

  /** 天气：每天最多说一句（见 weather.mjs） */
  async function weatherCheck(launch) {
    if (!weatherOn) return;
    try {
      const line = await weatherNews(st, { enabled: true, city: weatherCity, launch });
      if (line) st.say(line, 'greet', { kind: 'act' });
    } catch (e) {
      st.log('[raise] 天气拿不到：' + e.message);
    }
  }

  /** 环境提醒：饿了、脏了喊一嗓子（原版靠托盘图标，这边只能弹气泡）；鱼熟了也说一声 */
  function nudge() {
    if (st.info.health <= 0 || st.save.settings.paused) return;
    const now = Date.now();
    if (now - st.lastNeedAt < NEED_GAP_MS) return;
    for (const key of ['hunger', 'clean']) {
      const c = st.meta[`${key}Max`];
      if (st.info[key] / c < 0.25) {
        st.lastNeedAt = now;
        st.say(fillHost(NEED_LINES[key], st.info.host), key === 'hunger' ? 'sad' : 'clean');
        return;
      }
    }
    // 原版会提醒"鱼塘里有几条可以收了"（harvest.ts 的 harvestNews）
    if (fish.ripeFish(st) > 0) {
      st.lastNeedAt = now;
      st.say(`[host]，鱼塘里有 ${fish.ripeFish(st)} 条鱼可以收了~`, 'fish');
    }
  }

  function beat() {
    try {
      st.grow();
      nudge();
      if (weatherOn && Date.now() - lastWeather > 3600_000) {
        lastWeather = Date.now();
        void weatherCheck(false); // 每小时问一次，只为等恶劣天气出现
      }
    } catch (e) {
      st.log('[raise] 结算出错：' + (e?.stack ?? e));
    }
  }

  return {
    st,
    meter,
    /**
     * 菜单树。桌宠每秒来拉一次，但菜单内容（背包剩几口饭、有没有生病）变化没那么快，
     * 所以缓存 10 秒、或者存档一脏就重建 —— 别每秒把 990 件物品重新铺一遍。
     */
    menu: () => {
      const now = Date.now();
      if (menuCache && !st.dirty && now - menuAt < 10_000) return menuCache;
      menuCache = buildMenu(st);
      menuAt = now;
      return menuCache;
    },
    act,
    poll: () => st.poll(),
    /** 命令行的纯文本状态 */
    text: () => {
      const s = st.status();
      const f = st.growthFactor();
      const lines = [
        `${s.name}（${s.sex === 'GG' ? '男' : '女'}） ${s.stage} Lv.${s.level}  成长 ${s.growth}/${s.nextGrowth}${s.busy.length ? `  在做：${s.busy.join('/')}` : ''}`,
        `饥饿 ${s.hunger}   清洁 ${s.clean}   心情 ${s.mood}   健康 ${s.health}/5${s.ill ? `（${s.ill}）` : ''}`,
        `元宝 ${s.yb}${s.pinkDiamond ? ' · 粉钻' : ''}${s.sweetHeart ? ' · 甜蜜情侣' : ''}${st.cfg.naturalGrowth ? '' : '　成长只吃 token'}`,
      ];
      // 换算系数不是 1 时，**要连它怎么来的都写清楚**：
      // 光甩一个「×1.38」没人知道那是什么（这行就是被人这么问过之后加的）
      if (Math.abs(f.total - 1) > 0.01) {
        lines.push(`token 换算 ×${f.total.toFixed(2)}：成长值 = token ÷ 100 万 × ${st.cfg.growthPerMTok} × ${f.total.toFixed(2)}`);
        const parts = [
          `心情 ${f.mood}（${Math.round(st.info.mood)}/1000 ${{ 1: '开心', 0.9: '平静', 0.7: '郁闷', 0.5: '难过' }[f.mood] ?? ''}）`,
          `加成 ${f.bonus.toFixed(3)}${f.bonusPerHour || f.sweet !== 1 ? `（${f.sources.join('、')}）` : ''}`,
        ];
        lines.push(`　　= ${parts.join(' × ')}`);
      }
      return lines.join('\n');
    },
    /** 最近的 token 收益（status 里显示） */
    tokens: () => meter.peek(),
    start() {
      if (timer) return;
      meter.start();
      timer = setInterval(beat, 60_000);
      timer.unref?.();
      flushTimer = setInterval(() => {
        st.save.lastTokenTs = meter.ts;
        st.flush();
      }, 30_000);
      flushTimer.unref?.();
      // 先把存档里没做完的事续上，**再**结第一次账：
      // resumeTask 要读存档里的 nowTimeLine 算"关掉这段时间做了多少"，
      // 而 tick() 会把 nowTimeLine 改写成"现在"，顺序反了那段时间就白丢了
      for (const fn of st.hooks.resume) {
        try {
          fn(st);
        } catch (e) {
          st.log('[raise] 恢复现场失败：' + (e?.stack ?? e));
        }
      }
      beat(); // 补上从上次记账到现在的差额（属性衰减不补算，见 engine.grow）
      st.save.lastLoginTime = Math.floor(Date.now() / 1000);
      st.markDirty();
      // 开机问候 / 节日问候 / 天气（qqpet 的 startPet 也是开机就说两句）
      void calendarRefresh().then(() => {
        if (Date.now() - (st.lastGreet ?? 0) > 10 * 60_000) st.daily(); // 换日时已经问候过就别重复
        const f = festival(cal.today());
        if (f) st.say(f, 'greet', { kind: 'act' });
        void weatherCheck(true);
      });
      link.start(); // 工作联动的采样（第一次只记基线，不立刻扣属性）
    },
    stop() {
      clearInterval(timer);
      clearInterval(flushTimer);
      timer = flushTimer = null;
      link.stop();
      // 关掉桌宠就等于"这段时间不算数"：清掉记账水位，下次启动不会把中间几小时补算成饿/脏
      st.lastTick = null;
      st.save.lastTick = null;
      st.save.lastTokenTs = meter.ts;
      activity.reset(); // 内存里那件事也放掉，别留给下一个实例
      st.flush(true);
      meter.stop();
    },
  };
}

export { human };
