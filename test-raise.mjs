/**
 * test-raise.mjs —— 养成内核自测（不需要开桌宠，纯逻辑跑一遍）
 *
 *   node test-raise.mjs
 *
 * 覆盖：等级公式 / 属性衰减 / token 折算 / 离线不补算 / 生病与死亡 / 复活 /
 *       买卖与元宝 / 菜单生成 / 存档落盘与重载。
 * 全程用临时 DSH_PET_HOME，不动你的正式存档。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = path.join(os.tmpdir(), 'dsh-pet-raise-test-' + process.pid);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'user'), { recursive: true });
process.env.DSH_PET_HOME = HOME;
// 顺手把汇率钉死，好断言（也顺带验证这两个环境变量真的生效）
process.env.PET_RAISE_GROWTH_PER_MTOK = '500';
process.env.PET_RAISE_YB_PER_MTOK = '100';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const url = (rel) => pathToFileURL(path.join(HERE, rel)).href;

const { createRaise } = await import(url('lib/raise/index.mjs'));
const { levelOf, stageOf } = await import(url('lib/raise/level.mjs'));
const { goodOf, countOf } = await import(url('lib/raise/goods.mjs'));
const { createTokenMeter } = await import(url('lib/raise/tokens.mjs'));

// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
}
const section = (t) => console.log(`\n== ${t} ==`);

/** 一份够用的动画池（名字与 dsh-pet 默认配置一致） */
const ANIMS = {
  idle: ['待机呼吸休闲'],
  clicks: ['点击回应-元气挥手'],
  categories: [
    { id: '吃什么', actions: ['吃大餐', '吃Token', '吃白饭'] },
    { id: '玩耍', actions: ['荡秋千', '三球抛接'] },
    { id: '小动作', actions: ['晨间刷牙', '玩水枪', '原地小憩沉眠', '凭空生花'] },
  ],
  events: { whisper: ['碎碎念-发呆碎碎念'], balance: ['余额-钱袋满溢'], workStatus: ['工作状态-雀跃庆祝'] },
};

/** 假计量表：想给多少 token 就给多少，不碰真库 */
function fakeMeter() {
  let acc = { tokens: 0, requests: 0 };
  return {
    feed(tokens, requests = 1) {
      acc.tokens += tokens;
      acc.requests += requests;
    },
    take() {
      const t = { ...acc };
      acc = { tokens: 0, requests: 0 };
      return t;
    },
    peek: () => ({ ...acc }),
    ts: 0,
    start() {},
    stop() {},
    pull() {},
  };
}

function newRaise(meter = fakeMeter()) {
  // achievements:false —— 成就奖励会改元宝/心情，会让"精确到个位"的那些断言飘（成就自己有专门用例）
  const r = createRaise({ animations: ANIMS, log: () => {}, achievements: false });
  r.st.tokens = () => meter.take(); // 换成假表（真表要连 CC Switch 的库）
  r.fake = meter;
  return r;
}

/** 一只干净宠物：先删存档再建实例（同一个 HOME 下，前面的用例会往存档里留东西） */
function freshRaise() {
  fs.rmSync(path.join(HOME, 'user', 'raise.json'), { force: true });
  return newRaise();
}

/** 成就开着的实例（专门给成就那几条用例） */
function achvRaise() {
  fs.rmSync(path.join(HOME, 'user', 'raise.json'), { force: true });
  const meter = fakeMeter();
  const r = createRaise({ animations: ANIMS, log: () => {}, achievements: true });
  r.st.tokens = () => meter.take();
  r.fake = meter;
  return r;
}

// ---------------------------------------------------------------------------
section('等级与阶段（原版公式）');
check('成长 0 → 1 级，升 2 级要 125', levelOf(0).level === 1 && levelOf(0).nextGrowth === 125);
check('成长 125 → 2 级', levelOf(125).level === 2);
check('成长 124.9 → 还是 1 级', levelOf(124.9).level === 1);
check('阶段切分：4→蛋 / 5→幼年 / 16→成年', stageOf(4) === 'Egg' && stageOf(5) === 'Kid' && stageOf(16) === 'Adult');

// ---------------------------------------------------------------------------
section('新宠物与喂食');
const r1 = newRaise();
const st1 = r1.st;
check('名字/元宝/健康度是原版默认值', st1.info.name === '宠宝~' && st1.info.yb === 5000 && st1.info.health === 5);
check('背包里有初始的 2 份冰淇淋', countOf(st1, 'food', '10013006') === 2);

st1.info.hunger = 100; // 饿了
r1.act('use:food:10013006');
check('喂食后饥饿涨上去（封顶不溢出）', st1.info.hunger > 100 && st1.info.hunger <= st1.meta.hungerMax, `hunger=${st1.info.hunger}`);
check('背包少了一份', countOf(st1, 'food', '10013006') === 1);
check('吃东西会弹一条「吃东西」动画的事件', r1.poll()?.anim === '吃大餐' || r1.poll()?.anim === '吃Token' || r1.poll()?.anim === '吃白饭');

// ---------------------------------------------------------------------------
section('每分钟结算（属性衰减 / 不吃 token 就不长）');
const before = { hunger: st1.info.hunger, clean: st1.info.clean, growth: st1.info.growth };
st1.lastTick = Math.floor(Date.now() / 1000) - 600; // 假装过了 10 分钟
st1.tick();
check('饥饿会掉', st1.info.hunger < before.hunger);
check('清洁会掉', st1.info.clean < before.clean);
check('成长值一分不涨（自然成长已关，只吃 token）', st1.info.growth === before.growth, `+${(st1.info.growth - before.growth).toFixed(2)}`);
check('在线时长记了 10 分钟', Math.abs(st1.info.onLineTime) >= 10);

section('自然成长可以开关（PET_RAISE_NATURAL=on 恢复 qqpet 那条）');
process.env.PET_RAISE_NATURAL = 'on';
const rn = newRaise();
const stn = rn.st;
const g0n = stn.info.growth;
stn.lastTick = Math.floor(Date.now() / 1000) - 600;
stn.tick();
check('打开后挂机 10 分钟确实会长（约 13）', stn.info.growth > g0n + 5, `+${(stn.info.growth - g0n).toFixed(2)}`);
delete process.env.PET_RAISE_NATURAL;

section('离线不补算（宿主/CC Switch 关掉的那段不算）');
const g0 = st1.info.growth;
const h0 = st1.info.hunger;
st1.lastTick = null; // 相当于刚启动
st1.tick();
check('刚启动那一 tick 不结算属性', st1.info.hunger === h0);
check('刚启动那一 tick 不涨成长值', st1.info.growth === g0);

// ---------------------------------------------------------------------------
section('token 折算（两者结合里的「token 加成」）');
const r2 = newRaise();
r2.fake.feed(1_000_000); // 100 万 token
const yb0 = r2.st.info.yb;
const gr0 = r2.st.info.growth;
r2.st.lastTick = Math.floor(Date.now() / 1000) - 60;
r2.st.tick();
check('100 万 token 换 100 元宝（默认汇率）', r2.st.info.yb === yb0 + 100, `+${r2.st.info.yb - yb0}`);
check('100 万 token 换 500 成长值（心情好，系数 1）', Math.abs(r2.st.info.growth - gr0 - 500) < 0.01, `+${(r2.st.info.growth - gr0).toFixed(2)}`);

section('心情差 → token 换算打折');
const r2b = newRaise();
r2b.st.setInfo('mood', 100); // 难过档：系数 0.5
r2b.fake.feed(1_000_000);
const gr2 = r2b.st.info.growth;
r2b.st.lastTick = Math.floor(Date.now() / 1000) - 60;
r2b.st.tick();
check('难过时 100 万 token 只换 250 成长值', Math.abs(r2b.st.info.growth - gr2 - 250) < 0.01, `+${(r2b.st.info.growth - gr2).toFixed(2)}`);
check('但元宝不打折（还是 100）', r2b.st.info.yb === 5000 + 100, String(r2b.st.info.yb));
check('换算系数报得出来（0.5）', Math.abs(r2b.st.growthFactor().total - 0.5) < 1e-9, String(r2b.st.growthFactor().total));

const r2c = newRaise();
// 真开通粉钻要连到期时间一起给（06:00 的 newDay() 会按到期时间重新判定 pinkDiamond）
r2c.st.setInfo('pinkDiamond', true);
r2c.st.setInfo('PDiamondExpirationDate', Math.floor(Date.now() / 1000) + 86400 * 5);
r2c.fake.feed(1_000_000);
const gr3 = r2c.st.info.growth;
r2c.st.lastTick = Math.floor(Date.now() / 1000) - 60;
r2c.st.tick();
check('粉钻让 token 换算 +12.5%', Math.abs(r2c.st.info.growth - gr3 - 562.5) < 0.01, `+${(r2c.st.info.growth - gr3).toFixed(2)}`);

const r3 = newRaise();
r3.fake.feed(50_000_000_000); // 500 亿：异常值
const yb1 = r3.st.info.yb;
r3.st.lastTick = Math.floor(Date.now() / 1000) - 60;
r3.st.tick();
check('异常大的单次用量被兜底（不会一夜满级）', r3.st.info.yb - yb1 <= 2000, `+${r3.st.info.yb - yb1}`);

// ---------------------------------------------------------------------------
section('生病 → 死亡 → 复活');
const r4 = newRaise();
const st4 = r4.st;
st4.setActivity('ill', '0-');
st4.setInfo('health', 4);
const sick = r4.poll();
check('生病会弹一句病症台词', Boolean(sick && sick.text), JSON.stringify(sick));
check('生病时 ill 标记在位', Boolean(st4.activity('ill')));
st4.setInfo('health', 0);
const died = r4.poll();
check('健康归零 → 死亡台词', Boolean(died && died.text), JSON.stringify(died));
check('死亡后 grow() 不再记账', (() => {
  st4.lastTick = Math.floor(Date.now() / 1000) - 600;
  st4.grow();
  return st4.lastTick === null;
})());

// 还魂丹（60001）复活
const { addGood } = await import(url('lib/raise/goods.mjs'));
addGood(st4, 'medicine', '60001', 1);
r4.act('use:medicine:60001');
check('用还魂丹后健康回到 5', st4.info.health === 5);
check('复活后病标记清掉', st4.activity('ill') === null);

// ---------------------------------------------------------------------------
section('元宝 / 买卖 / 等级门槛');
const r5 = newRaise();
const st5 = r5.st;
st5.setInfo('yb', 0);
r5.act('buy:food:100010032'); // 小笼包 2000 元宝
check('没元宝买不动', countOf(st5, 'food', '100010032') === 0);
st5.setInfo('yb', 100000);
r5.act('buy:food:100010032');
check('买到了小笼包', countOf(st5, 'food', '100010032') === 1);
check('扣了 2000 元宝', st5.info.yb === 98000, `yb=${st5.info.yb}`);

const toy = goodOf('toy', 't0002'); // needLevel 5（新宠物背包里本来就有 1 个）
st5.setInfo('yb', 100000);
r5.act(`buy:toy:${toy.id}`);
check('等级不够买不了（原版 needLevel 判定）', countOf(st5, 'toy', toy.id) === 1, `level=${st5.meta.level} need=${toy.needLevel} 数量=${countOf(st5, 'toy', toy.id)}`);
st5.info.growth = 100000; // 拉高等级
st5.syncLevel();
r5.act(`buy:toy:${toy.id}`);
check('等级够了就能买', countOf(st5, 'toy', toy.id) === 2, `level=${st5.meta.level}`);

// ---------------------------------------------------------------------------
section('看病（诊费 + 开药）');
const r6 = newRaise();
const st6 = r6.st;
const { illOf } = await import(url('lib/raise/text.mjs'));
st6.setActivity('ill', '0-');
st6.setInfo('health', 3);
st6.setInfo('yb', 10000);
// 病线 0 + 健康 3 → 支气管炎，对症的是甘草剂：没存货时按原价 120% 现买
const cure = goodOf('medicine', illOf('0-3').cure.id);
const expectCost = 20 + Math.round((cure.price || 50) * 1.2);
const yb6 = st6.info.yb;
r6.act('doctor');
check(`看病收诊费 20 + 药钱 ${Math.round((cure.price || 50) * 1.2)}（${cure.name}）`, st6.info.yb === yb6 - expectCost, `yb=${st6.info.yb} 期望=${yb6 - expectCost}`);
check('看完病健康回到 5', st6.info.health === 5);

// ---------------------------------------------------------------------------
section('暂停成长 / 免打扰');
const r7 = newRaise();
r7.act('pause');
check('暂停后 settings.paused = true', r7.st.save.settings.paused === true);
r7.st.lastTick = Math.floor(Date.now() / 1000) - 600;
const h7 = r7.st.info.hunger;
r7.st.grow();
check('暂停时不吃不喝（不衰减）', r7.st.info.hunger === h7);
r7.act('pause');
check('已经是暂停状态时再点一次仍然保持暂停（幂等）', r7.st.save.settings.paused === true);
r7.act('resume');
check('恢复后 paused = false', r7.st.save.settings.paused === false);
r7.act('quiet:toggle');
check('免打扰开关能翻', r7.st.save.settings.quiet === true);

// ---------------------------------------------------------------------------
section('菜单');
const r8 = newRaise();
const menu = r8.menu();
check('菜单根是「养成」', menu[0].label.includes('养成'));
const kids = menu[0].children.map((x) => x.label).join('|');
check('有状态/喂食/洗澡/陪玩/看病/商店', ['宝宝状态', '喂食', '洗澡', '陪它玩', '看病', '商店'].every((k) => kids.includes(k)), kids);
const shop = menu[0].children.find((x) => x.label.includes('商店'));
check('商店按类型分组', shop.children.length >= 4, shop.children.map((x) => x.label).join(','));
check('商店里的价格带元宝单位', shop.children[0].children[0].label.includes('元宝'), shop.children[0].children[0].label);
check('每个叶子都有可执行的 raise 串', (function walk(nodes) {
  return nodes.every((n) => (Array.isArray(n.children) ? walk(n.children) : typeof n.raise === 'string' && n.raise.length > 0));
})(menu));
check('不认识的动作不会崩', r8.act('这不是动作') === false && r8.act('') === false && r8.act(null) === false);

// ---------------------------------------------------------------------------
section('存档落盘 / 重载');
const r9 = newRaise();
r9.st.setInfo('yb', 12345);
r9.st.info.name = '测试喵';
r9.st.flush(true);
const r10 = createRaise({ animations: ANIMS, log: () => {} });
check('重载后元宝/名字还在', r10.st.info.yb === 12345 && r10.st.info.name === '测试喵');
const raw = JSON.parse(fs.readFileSync(path.join(HOME, 'user', 'raise.json'), 'utf8'));
check('存档字段名与 qqpet 一致（含拼错的 petComputedlInfo）', 'petInfo' in raw && 'petComputedlInfo' in raw && 'selfGoodDatas' in raw);
check('存档里带水位（不会重算历史流量）', raw.lastTokenTs > 0, String(raw.lastTokenTs));

section('脏存档修复（照着 qqpet 的兜底值）');
const bad = JSON.parse(fs.readFileSync(path.join(HOME, 'user', 'raise.json'), 'utf8'));
bad.petInfo.health = 99;
bad.petInfo.mood = -5;
bad.petInfo.sex = 'XX';
bad.petInfo.yb = 'abc';
bad.selfGoodDatas.toy = ['_t0002__old*1', '_t0002*1'];
fs.writeFileSync(path.join(HOME, 'user', 'raise.json'), JSON.stringify(bad));
const r11 = createRaise({ animations: ANIMS, log: () => {} });
// 注意：health 的兜底值原版就是 0（不是 5）—— 非法健康度按"死亡"处理，这点照抄 qqpet
check('健康度超界 → 0（原版兜底就是 0）', r11.st.info.health === 0, String(r11.st.info.health));
check('心情负数 → 0', r11.st.info.mood === 0);
check('性别非法 → GG', r11.st.info.sex === 'GG');
check('元宝非数字 → 5000', r11.st.info.yb === 5000);
check('带 __ 的旧玩具被丢掉', r11.st.info && !r11.st.save.selfGoodDatas.toy.some((x) => x.includes('__')));
// 上面那份存档是故意弄坏的（健康度被判成 0 = 死亡），后面的用例要一只健康的宠物
fs.rmSync(path.join(HOME, 'user', 'raise.json'), { force: true });

// ---------------------------------------------------------------------------
section('token 计量表（去重与水位）');
const m = createTokenMeter({ since: Math.floor(Date.now() / 1000) - 1 });
const t1 = m.take();
check('刚建的计量表是空的', t1.tokens === 0 && t1.requests === 0);
check('水位可以往回拨', (() => {
  m.ts = 0;
  return m.ts === 0;
})());

// ---------------------------------------------------------------------------
section('打工（门槛 / 进行中 / 收工）');
const rj = newRaise();
const stj = rj.st;
rj.act('work:bz'); // 搬砖：2 级起，10 元宝 / 30 分钟
check('等级不够时去不了（原版判定）', stj.activity('work') === null && rj.poll()?.text.includes('等级'), JSON.stringify(rj.poll()?.text));
stj.info.growth = 100000; // 拉高等级
stj.syncLevel();
rj.act('work:bz');
check('等级够了就去上班了', stj.activity('work') === 'bz', String(stj.activity('work')));
check('上班时 busy() 为真（状态气泡会显示"打工中"）', stj.busy());
const ybWork = stj.info.yb;
const { advanceTask } = await import(url('lib/raise/activity.mjs'));
advanceTask(stj, 30); // 干满 30 分钟
check('收工后拿到元宝（搬砖 10）', stj.info.yb === ybWork + goodOf('work', 'bz').yb, `+${stj.info.yb - ybWork}`);
check('收工后工作位清空', stj.activity('work') === null);

section('上学 / 升学考试');
const rs = newRaise();
const sts = rs.st;
sts.info.growth = 100000;
sts.syncLevel();
rs.act('study:xx-chinese');
check('去上课了', sts.activity('study') === 'xx-chinese', String(sts.activity('study')));
const intel0 = sts.info.intel;
advanceTask(sts, 45); // 一节课 45 分钟
check('上完一节课学籍 +1', sts.save.studyInfo.chinese === 1, String(sts.save.studyInfo.chinese));
check('上课长了智力', sts.info.intel > intel0);

// 课时修满 → 自动安排升学考试
sts.save.studyInfo.chinese = 9;
rs.act('study:xx-chinese');
check('课时修满后点击就开考', Boolean(rs.st.exam) && rs.st.exam.questions.length === 3, String(rs.st.exam?.questions.length));
const examMenu = rs.menu()[0];
check('考试顶到菜单最前面，且带着题目与选项', examMenu.label.includes('升学考试') && examMenu.children[0].children.length === 4, examMenu.label);
for (let i = 0; i < 3; i++) {
  const q = rs.st.exam.questions[rs.st.exam.picked.length];
  rs.act('exam:' + q.options.indexOf(q.answer));
}
check('三题全对 → 升学（学籍 +1）', sts.save.studyInfo.chinese === 10, String(sts.save.studyInfo.chinese));
check('考完就收摊（不会重复考）', rs.st.exam === null);

// 答错不给过（先确认考试真的开起来了，否则这段断言会静默跳过）
const zg = goodOf('study', 'zx-chinese');
sts.save.studyInfo.chinese = zg.classNumUp + zg.classNum; // 课时正好修满
rs.st.exam = null;
rs.act('study:zx-chinese');
check('课时修满的科目点一下就开考', Boolean(rs.st.exam), String(rs.st.exam));
for (let i = 0; i < 3 && rs.st.exam; i++) {
  const q = rs.st.exam.questions[rs.st.exam.picked.length];
  rs.act('exam:' + q.options.findIndex((o) => o !== q.answer)); // 每一题都故意答错
}
check('答错就不给升学（学籍不动）', sts.save.studyInfo.chinese === zg.classNumUp + zg.classNum, String(sts.save.studyInfo.chinese));

section('旅游（奇遇 / 相簿 / 到访记录）');
const rt = newRaise();
const stt = rt.st;
stt.setInfo('mood', 500);
rt.act('trip');
check('出门旅游了', Boolean(stt.activity('trip')), String(stt.activity('trip')));
advanceTask(stt, 60);
check('回来后心情 +20（原版固定值）', stt.info.mood === 520, String(stt.info.mood));
check('到访过的省份记进了存档', stt.save.gameSaveDatas.travel_china.length === 1, JSON.stringify(stt.save.gameSaveDatas.travel_china));
check('拍了一张明信片进相簿', JSON.parse(stt.save.saveJsonData.album || '[]').length === 1);
rt.act('album');
// 上一条还在交给桌宠的 3 秒宽限里，所以看队列尾巴而不是 poll()
const queued = rt.st.events.at(-1)?.text ?? '';
check('相簿能报数', queued.includes('明信片'), queued);

section('重启后接着做没做完的活（离线时间也算进度）');
const r5b = newRaise();
r5b.st.info.growth = 100000;
r5b.st.syncLevel();
r5b.act('work:bz');
r5b.st.save.saveJsonData.activity = '10'; // 已经做了 10 分钟
r5b.st.save.nowTimeLine = Math.floor(Date.now() / 1000) - 600; // 上次记账在 10 分钟前
r5b.st.flush(true);
const r5c = createRaise({ animations: ANIMS, log: () => {} });
r5c.start(); // start() 里会跑 hooks.resume
const { running } = await import(url('lib/raise/activity.mjs'));
const back2 = running();
check('重启后活还在，且把关掉的 10 分钟也算上了', Boolean(back2) && back2.done >= 19, JSON.stringify(back2));
r5c.stop();

section('任务（今日任务 / 逗逗我 / 领奖）');
const rk = newRaise();
const stk = rk.st;
const { tasks: taskList, count: countOf2, addCount } = await import(url('lib/raise/tasks.mjs'));
check('今天抽了 4 条任务', taskList(stk, 'daily').length === 4, String(taskList(stk, 'daily').length));
check('任务带进度与领取标记', taskList(stk, 'daily').every((t) => typeof t.done === 'number' && t.take === false));
// 逗逗我：点宠物算一次
for (let i = 0; i < 5; i++) rk.act('pet:click');
check('点宠物 5 次 = 逗它 5 次', countOf2(stk, 'Amusing') === 5, String(countOf2(stk, 'Amusing')));
check('逗逗我第一条任务可以领了', taskList(stk, 'ddw')[0].done >= taskList(stk, 'ddw')[0].num);
// 逗逗我第一条的奖励是圈圈冰激凌（新手背包里本来就有 3 个，所以看数量而不是"种类 +1"）
const num0 = countOf(stk, 'food', '102010001');
rk.act('claim:ddw:0');
check('领奖后标记已领', taskList(stk, 'ddw')[0].take === true);
check('领奖拿到东西（同款物品 +1）', countOf(stk, 'food', '102010001') === num0 + 1, `${num0} → ${countOf(stk, 'food', '102010001')}`);
rk.act('claim:ddw:1');
check('没做完的领不了', taskList(stk, 'ddw')[1].take === false);

section('签到 / 抽成长值 / 在线奖励');
const rc = newRaise();
const stc = rc.st;
const signin = await import(url('lib/raise/signin.mjs'));
check('一开始没签到', signin.signedToday(stc) === false);
rc.act('sign:in');
check('签到成功', signin.signedToday(stc) === true);
check('同一天不会签两次', (() => {
  const n = signin.monthCount(stc);
  rc.act('sign:in');
  return signin.monthCount(stc) === n;
})());
// 原版规则：抽到 000 不算数（不给东西、也不消耗当天那次机会），抽到有数才算用掉
check('抽成长值：抽到 000 还能再抽，抽到数就不能再抽了', (() => {
  const got = signin.drawGrowth(stc);
  const value = +got.digits.join('');
  return value === 0 ? signin.canDrawGrowth(stc) === true : signin.canDrawGrowth(stc) === false;
})());
check('在线奖励要等够 20 分钟', signin.onlineGiftWait(stc) > 0 && rc.act('sign:gift') === false);
signin.tickGift(stc, 20); // 等够
const ybC = stc.info.yb;
rc.act('sign:gift');
check('第一次在线奖励免费', stc.info.yb === ybC, `${stc.info.yb} vs ${ybC}`);
check('第二次就要 100 元宝（原版价）', signin.giftCost(stc) === 100, String(signin.giftCost(stc)));

section('邮件（欢迎信 / 领附件）');
const rm = newRaise();
const stm = rm.st;
const mail = await import(url('lib/raise/mail.mjs'));
mail.deliverMails(stm); // 每日首封：欢迎信（跨天钩子里也是调它）
check('收到欢迎信', mail.unread(stm).some((m) => m.l.includes('欢迎来到QQ宠物')), JSON.stringify(mail.unread(stm).map((m) => m.l)));
check('同一封不会重复发', (() => {
  mail.deliverMails(stm);
  return mail.unread(stm).filter((m) => m.l.includes('欢迎来到')).length === 1;
})());
const d0 = mail.unread(stm)[0].d;
rm.act(`mail:${d0}`);
check('领了信，附件进背包', mail.unread(stm).every((m) => m.d !== d0));
check('领过的信不能再领', rm.act(`mail:${d0}`) === false);

section('贵族（粉钻 / 贴心宝贝）');
const rv = newRaise();
const stv = rv.st;
const vip = await import(url('lib/raise/vip.mjs'));
const base = stv.growthPerMinute();
stv.setInfo('yb', 10000);
rv.act('pd:buy');
check('首次开粉钻 666 元宝', stv.info.yb === 10000 - 666, String(stv.info.yb));
check('粉钻生效', stv.info.pinkDiamond === true && stv.info.PDiamondLevel >= 1);
check('粉钻让成长 +10/小时', Math.abs(stv.growthPerMinute() - base - 10 / 60) < 1e-6, `${base} → ${stv.growthPerMinute()}`);
const ybHeart = stv.info.yb;
rv.act('heart:buy1');
check('贴心宝贝 300 元宝/天', stv.info.yb === ybHeart - 300, String(stv.info.yb));
check('贴心宝贝开启', stv.info.sweetHeart === true && vip.sweetHeartDays(stv) === 1);
rv.act('heart:toggle');
check('再点一下可以关掉（天数还在）', stv.info.sweetHeart === false && vip.sweetHeartDays(stv) === 1);
rv.act('heart:toggle');
check('还能再开回来', stv.info.sweetHeart === true);

section('池塘养鱼（买苗 / 喂食 / 收成 / 加速）');
const rf = newRaise();
const stf = rf.st;
const fish = await import(url('lib/raise/fishing.mjs'));
stf.setInfo('yb', 1000);
rf.act('fish:buy:2'); // 金鱼：2 元宝、0 级可养、售价 2×5
let pond = fish.pondState(stf);
check('买了一条金鱼苗', pond.fishes.length === 1 && pond.fishes[0].name === '金鱼', JSON.stringify(pond.fishes.map((f) => f.name)));
check('扣了 2 元宝', stf.info.yb === 998, String(stf.info.yb));
check('刚买来是鱼苗（stage 1）', pond.fishes[0].stage === 1);
rf.act('fish:buy:16'); // 石斑鱼：42 级
check('等级不够养不了石斑鱼', fish.pondState(stf).fishes.length === 1);
const ybFeed = stf.info.yb;
rf.act(`fish:feed:${pond.fishes[0].id}`);
check('喂一次 10 元宝', stf.info.yb === ybFeed - 10, String(stf.info.yb));
// 金鱼 interval = 7200 秒（两小时长一档），喂一次算一小时年龄 → 熟（stage 3）要 4 次
for (let i = 0; i < 3; i++) rf.act(`fish:feed:${fish.pondState(stf).fishes[0].id}`);
check('喂够 4 次就成熟了（两档各两小时）', fish.pondState(stf).fishes[0].stage === 3, String(fish.pondState(stf).fishes[0].stage));
const ybHarvest = stf.info.yb;
rf.act(`fish:harvest:${fish.pondState(stf).fishes[0].id}`);
check('收成按售价×数量（金鱼 2×5=10）', stf.info.yb === ybHarvest + 10, `+${stf.info.yb - ybHarvest}`);
check('收完鱼塘空了', fish.pondState(stf).fishes.length === 0);
// 没熟就捞：只退一半
rf.act('fish:buy:2');
const id = fish.pondState(stf).fishes[0].id;
const ybHalf = stf.info.yb;
rf.act(`fish:harvest:${id}`);
check('没熟就捞只退一半（2/2=1）', stf.info.yb === ybHalf + 1, `+${stf.info.yb - ybHalf}`);
// 鱼塘上限：3 条（非粉钻）
for (let i = 0; i < 3; i++) rf.act('fish:buy:2');
rf.act('fish:buy:2');
check('鱼塘最多 3 条（非粉钻，原版上限）', fish.pondState(stf).fishes.length === 3, String(fish.pondState(stf).fishes.length));
stf.setInfo('pinkDiamond', true);
stf.setInfo('PDiamondLevel', 3);
fish.resetFish(stf);
check('粉钻每天给等级×2 次加速', fish.pondState(stf).PD.canusecnt === 6, String(fish.pondState(stf).PD.canusecnt));
const fed0 = fish.pondState(stf).fishes.map((f) => f.siLiao);
rf.act('fish:speed');
check('加速消耗一次', fish.pondState(stf).PD.canusecnt === 5);
check('加速给每条鱼多喂了一口（=一小时年龄）', fish.pondState(stf).fishes.every((f, i) => f.siLiao === fed0[i] + 1));

section('日历（默认关闭时的兜底）');
const cal = await import(url('lib/raise/calendar.mjs'));
const c0 = cal.createCalendar({ mode: 'off', log: () => {} });
check('默认不联网', c0.enabled === false && (await c0.load()) === null);
check('没日历时节日那句中空', cal.festival(undefined) === null);
check('没日历时日期那句退回星期', cal.dayText(c0).startsWith('星期'), cal.dayText(c0));
check('节假日放假那句是对的', cal.festival({ holiday: { name: '国庆节', off: true } }).includes('放假啦'));
check('调休那句是对的', cal.festival({ holiday: { name: '国庆节', off: false } }).includes('调休'));

// ---------------------------------------------------------------------------
section('回归：code review 找出来的那些坑');
const { countOf: cnt, addGood: addG } = await import(url('lib/raise/goods.mjs'));

// 1) 喂食时任务计数钩子的签名错过 → 每次喂东西都抛异常，任务计数永远是 0
const rg = freshRaise();
const eat0 = countOf2(rg.st, 'Eat');
check('喂食动作本身返回成功（钩子签名错时会抛异常 → false）', rg.act('use:food:10013006') === true);
check('吃东西计数 +1（今日任务「喂我吃东西N次」要用）', countOf2(rg.st, 'Eat') === eat0 + 1, String(countOf2(rg.st, 'Eat')));

// 2) 跨天判定写错字段 → 每分钟都当成新的一天（签到/在线奖励/鱼塘加速每分钟重置）
const rd = freshRaise();
rd.act('sign:in');
for (let i = 0; i < 5; i++) rd.act('pet:click');
rd.act('claim:ddw:0');
const today = rd.st.dayStart();
rd.st.save.nowTimeLine = Math.floor(Date.now() / 1000); // 今天已经结过账（比 06:00 大）
rd.st.lastTick = Math.floor(Date.now() / 1000) - 120;
rd.st.tick();
check('同一天里反复结算不会把签到重置', signin.signedToday(rd.st) === true);
check('同一天里反复结算不会把领过的任务重置', taskList(rd.st, 'ddw')[0].take === true);
rd.st.save.nowTimeLine = today - 86400; // 假装跨天了
rd.st.lastTick = Math.floor(Date.now() / 1000) - 60;
rd.st.tick();
check('真跨天才重置：成长值抽奖又能抽了', signin.canDrawGrowth(rd.st) === true);
check('真跨天才重置：任务领取标记清掉（计数也清零）', taskList(rd.st, 'ddw')[0].take === false && countOf2(rd.st, 'Amusing') === 0);

// 3) stop() 写上了记账水位 → 重启后把关掉的那几个小时补算成饿/脏
const rs3 = freshRaise();
rs3.act('use:food:10013006');
rs3.start();
rs3.stop();
const savedRaw = JSON.parse(fs.readFileSync(path.join(HOME, 'user', 'raise.json'), 'utf8'));
check('stop() 之后水位是清的（重启不会补算关掉那段）', savedRaw.lastTick === null, JSON.stringify(savedRaw.lastTick));

// 4) 非卖品（price = -1）能被买 → 元宝倒着涨
const rb2 = freshRaise();
rb2.st.setInfo('yb', 5000);
rb2.act('buy:food:100010031'); // 雪泥爽：表里 price = -1
check('非卖品买不了，元宝不会被倒加', rb2.st.info.yb === 5000 && cnt(rb2.st, 'food', '100010031') === 0, `yb=${rb2.st.info.yb}`);

// 5) 限时物品到期调 st.dirty()（不是函数）→ 那一分钟的结算整个中断
const rt2 = freshRaise();
addG(rt2.st, 'food', '102010074', 1); // 香辣大对虾：useTimeing
rt2.st.save.selfGoodUseOption.food = { id: '102010074', left: 0.5 };
let threw = null;
try {
  rt2.st.lastTick = Math.floor(Date.now() / 1000) - 60;
  rt2.st.tick();
} catch (e) {
  threw = e;
}
check('限时物品到期不再抛异常', threw === null, String(threw));
check('到期后该类型的生效物品清掉了', rt2.st.save.selfGoodUseOption.food === null);

// 6) 表里没有的工作 id → 元宝变 NaN（之后买卖永远"成功"）
const rw3 = freshRaise();
rw3.st.info.growth = 100000;
rw3.st.syncLevel();
rw3.act('work:并不存在的工作');
check('不认识的工作 id：不接活、元宝也不会变 NaN', rw3.st.activity('work') === null && Number.isFinite(rw3.st.info.yb));

// 7) 换宠物时实例上的缓存没清 → 新宠物继承旧鱼的鱼塘/签到/任务
const rn2 = freshRaise();
rn2.act('sign:in');
rn2.st.setInfo('yb', 1000);
rn2.act('fish:buy:2');
check('换之前：有签到、有鱼', signin.signedToday(rn2.st) === true && fish.pondState(rn2.st).fishes.length === 1);
rn2.st.save.havePet = false;
rn2.st.save.isBury = true;
rn2.act('adopt:MM');
check('换宠物后签到状态不跟着走', signin.signedToday(rn2.st) === false);
check('换宠物后鱼塘是空的', fish.pondState(rn2.st).fishes.length === 0);

// 8) 同一毫秒说两句 → ts 相同，桌宠只弹第一句（看病就是这样丢半句的）
const rts2 = freshRaise();
rts2.st.events.length = 0;
rts2.st.say('第一句', '', { kind: 'act' });
rts2.st.say('第二句', '', { kind: 'act' });
check('同一毫秒里说两句，ts 也必须不同', rts2.st.events[0].ts !== rts2.st.events[1].ts, JSON.stringify(rts2.st.events.map((e) => e.ts)));

// 9) 免打扰开关那句被自己的免打扰挡掉 → 点了没反应
const rq2 = freshRaise();
rq2.st.events.length = 0;
rq2.act('quiet:toggle');
check('开免打扰会有反馈气泡（force 这一句）', rq2.st.events.length === 1, String(rq2.st.events.length));

// 10) 同一秒买两条鱼 → id 撞号，喂/捞永远作用在第一条
const rf4 = freshRaise();
rf4.st.setInfo('yb', 1000);
rf4.act('fish:buy:2');
rf4.act('fish:buy:2');
const ids = fish.pondState(rf4.st).fishes.map((f) => f.id);
check('同一秒买两条鱼，id 不撞号', new Set(ids).size === ids.length, JSON.stringify(ids));

// 11) 读一次鱼塘状态就把存档标脏 → 菜单缓存永远失效
const rf5 = freshRaise();
rf5.st.flush(true);
fish.pondState(rf5.st);
check('读鱼塘状态不会把存档标脏（菜单缓存才有意义）', rf5.st.dirty === false);

// 12) 没有题库的科目（艺术 / 研究生各科）课时修满后卡死
const rex = freshRaise();
rex.st.info.growth = 100000;
rex.st.syncLevel();
rex.st.save.studyInfo.art = 9;
rex.act('study:xx-art');
check('没有题库的科目按免考升学处理（不会卡在课时修满）', rex.st.save.studyInfo.art === 10 && rex.st.exam === null, `art=${rex.st.save.studyInfo.art}`);

// 13) 在线奖励倒计时跟着 grown 走 → 心情见底时那 20 分钟永远走不完
const rgift = freshRaise();
rgift.st.setInfo('mood', 0);
rgift.st.lastTick = Math.floor(Date.now() / 1000) - 1200; // 过了 20 分钟
rgift.st.tick();
check('心情为 0 时，在线奖励的 20 分钟倒计时照样走完', signin.onlineGiftWait(rgift.st) === 0, String(signin.onlineGiftWait(rgift.st)));

// 14) 背包超过 12 种时，后拿到的那些在菜单里没有入口
const rbag = freshRaise();
const { allGoods, countOf: cnt2 } = await import(url('lib/raise/goods.mjs'));
const foods15 = allGoods('food').filter((g) => g.price > 0).slice(0, 15);
for (const g of foods15) addG(rbag.st, 'food', g.id, 1);
const feedKids = rbag.menu()[0].children.find((c) => c.label.includes('喂食')).children;
const feedIds = feedKids.map((c) => c.raise.split(':')[2]);
check('背包里 15 种食物都能在菜单里点到', foods15.every((g) => feedIds.includes(g.id)), `菜单里 ${feedIds.length} 项`);

// 15) 功能道具 / 背景没有菜单入口（商店卖它们、任务也发它们）
const rfx = freshRaise();
addG(rfx.st, 'nums', 'yb', 5); // 背包里有功能道具才该出现那一栏
const coreLabels = rfx.menu()[0].children.map((c) => c.label);
check('功能道具（元宝/成长值…）有菜单入口', coreLabels.some((l) => l.includes('功能道具')), coreLabels.join('|'));
check('背景有菜单入口', coreLabels.some((l) => l.includes('换个背景')), coreLabels.join('|'));
const ybFx0 = rfx.st.info.yb;
rfx.act('use:nums:yb');
check('用「元宝」道具真的能加到元宝上', rfx.st.info.yb === ybFx0 + 1, `+${rfx.st.info.yb - ybFx0}`);

// 16) 日历开着时，任务在日历到手前就被抽掉了 → 节假日算成普通工作日
let calLoaded = false;
const holiday = { holiday: { name: '国庆节', off: true } };
const fakeCal = {
  enabled: true,
  load: async () => {
    calLoaded = true;
    return holiday;
  },
  today: () => (calLoaded ? holiday : undefined),
  days: () => (calLoaded ? [holiday] : []),
  nextHoliday: () => null,
};
const rh = createRaise({ animations: ANIMS, log: () => {}, calendar: fakeCal });
rh.st.tokens = () => ({ tokens: 0, requests: 0 });
check('日历还没到手时先不抽任务（免得把节假日当工作日）', taskList(rh.st, 'daily').length === 0, String(taskList(rh.st, 'daily').length));
rh.start();
await new Promise((r) => setTimeout(r, 80)); // 等日历回来
const rolled = taskList(rh.st, 'daily').map((t) => t.label);
check('日历到手后按节假日抽（多一条节日任务）', rolled.some((l) => l.includes('国庆节快乐')), rolled.join(' / '));
rh.stop();

// 17) 联网那两块（日历 / 天气）：数据源解析 + 本机算的节气
const settings = await import(url('lib/raise/settings.mjs'));
const realFetch = globalThis.fetch;
const stubFetch = (handler) => {
  globalThis.fetch = async (u, o) => handler(String(u), o);
};
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

// 日历：holiday-cn 源（节假日查表 + 节气本机算）
const holidayJson = {
  year: 2026,
  days: [
    { name: '国庆节', date: '2026-10-01', isOffDay: true },
    { name: '国庆节', date: '2026-10-10', isOffDay: false },
  ],
};
stubFetch((u) => {
  if (u.includes('holiday-cn')) return jsonRes(holidayJson);
  return jsonRes({});
});
const cal2 = cal.createCalendar({ mode: 'holiday-cn', log: () => {} });
const todayEntry = await cal2.load();
globalThis.fetch = realFetch;
check('holiday-cn 源：今天（2026-10-10 是调休班）被认成「国庆节，要上班」', todayEntry?.holiday?.name === '国庆节' && todayEntry.holiday.off === false, JSON.stringify(todayEntry));
check('日历那句写成「国庆节调休上班」', cal.dayText(cal2).includes('国庆节调休上班'), cal.dayText(cal2));
check('调休那天不会算成放假（任务/邮件都看这个）', cal.festival(cal2.today()).includes('调休'));

// 节气：本机算，拿公开历法对几条
const termOf2026 = (y, m, d) => cal.termOf(new Date(y, m - 1, d));
check('节气（本机算）：立春 2026-02-04', termOf2026(2026, 2, 4) === '立春', String(termOf2026(2026, 2, 4)));
check('节气：清明 2026-04-05', termOf2026(2026, 4, 5) === '清明', String(termOf2026(2026, 4, 5)));
check('节气：霜降 2026-10-23', termOf2026(2026, 10, 23) === '霜降', String(termOf2026(2026, 10, 23)));
check('节气：冬至 2026-12-22', termOf2026(2026, 12, 22) === '冬至', String(termOf2026(2026, 12, 22)));
check('没有节气的日子返回 null', termOf2026(2026, 10, 10) === null, String(termOf2026(2026, 10, 10)));

// 天气：恶劣天气的提醒文案（stub 掉 wttr.in）
const weather = await import(url('lib/raise/weather.mjs'));
const wttr = (code, opts = {}) => ({
  current_condition: [{ weatherCode: String(code) }],
  weather: [
    {
      maxtempC: String(opts.max ?? 25),
      mintempC: String(opts.min ?? 15),
      hourly: [{ time: String((new Date().getHours() + 1) * 100), weatherCode: String(code), windspeedKmph: String(opts.wind ?? 5) }],
    },
    { maxtempC: String(opts.tomorrowMax ?? 24), mintempC: '14', hourly: [] },
  ],
});
// 天气：预警与播报的文案（纯函数，不用碰"今天说过了"那层）
const wSunny = { code: 113, max: 25, min: 15, tomorrowMax: 24, hours: [{ hour: new Date().getHours() + 1, code: 113, wind: 5 }] };
check('好天气按「当地」播报，不会写成「今天Beijing晴」', weather.forecast(wSunny, 'Beijing').includes('今天当地晴'), weather.forecast(wSunny, 'Beijing'));
check('填了中文城市就用城市名', weather.forecast(wSunny, '北京').includes('今天北京晴'), weather.forecast(wSunny, '北京'));
check('下雨会提醒带伞', weather.forecast({ ...wSunny, code: 296, hours: [{ hour: 9, code: 296, wind: 5 }] }, '北京').includes('带伞'));
check('明天降温 8 度以上会提醒加衣服', weather.warning({ ...wSunny, max: 20, tomorrowMax: 10 })?.includes('降温'), weather.warning({ ...wSunny, max: 20, tomorrowMax: 10 }));
check('刮大风会提醒', weather.warning({ ...wSunny, hours: [{ hour: 9, code: 113, wind: 45 }] })?.includes('风很大'));
check('好天气没有预警', weather.warning(wSunny) === null);

// 恶劣天气必定提醒 + 每天只说一次
const rw4 = freshRaise();
stubFetch(() => jsonRes(wttr(200))); // 雷阵雨
const warnLine = await weather.weatherNews(rw4.st, { enabled: true, city: '北京', launch: false });
check('恶劣天气必定提醒（雷阵雨）', warnLine?.includes('雷阵雨') && warnLine.includes('别待在外面'), warnLine);
check('同一天不会重复播报', (await weather.weatherNews(rw4.st, { enabled: true, city: '北京', launch: true })) === null);
check('关掉的时候一句话都不说', (await weather.weatherNews(freshRaise().st, { enabled: false, city: '', launch: true })) === null);
globalThis.fetch = realFetch;

// 18) 配置来源：配置文件 > 环境变量 > 默认
const cfgFile = settings.CONFIG_FILE;
fs.rmSync(cfgFile, { force: true });
delete process.env.PET_RAISE_CALENDAR;
check('默认：日历关着', settings.resolve('calendar').value === 'off' && settings.resolve('calendar').from === 'default');
process.env.PET_RAISE_CALENDAR = 'ankio';
check('环境变量能改', settings.resolve('calendar').value === 'ankio' && settings.resolve('calendar').from === 'env');
settings.writeConfig({ calendar: 'holiday-cn', weather: true, growthPerMTok: 50 });
check('配置文件优先级更高', settings.resolve('calendar').value === 'holiday-cn' && settings.resolve('calendar').from === 'config');
check('开关类认 on/off 与布尔', settings.resolve('weather').value === true && settings.coerce('onoff', 'off') === false);
check('数字类认数字，乱填就当没填', settings.resolve('growthPerMTok').value === 50 && settings.coerce('number', 'abc') === undefined);
check('不认识的配置项直接报错', (() => {
  try {
    settings.resolve('并不存在的项');
    return false;
  } catch {
    return true;
  }
})());
delete process.env.PET_RAISE_CALENDAR;
fs.rmSync(cfgFile, { force: true });

// 19) 旅游成就（qqpet 里唯一能重做旅游任务的入口）没接线 → 城市任务一辈子只能领一次
const rtour = freshRaise();
rtour.st.save.gameSaveDatas.travel_china = [{ name: '北京市', value: 1 }];
rtour.st.save.gameSaveDatas.travel_china_num = 0;
const tourTasks = taskList(rtour.st, 'travel');
tourTasks[2].take = true; // 假装「去5个不同的城市」领过了
rtour.st.setInfo('yb', 20000);
rtour.act('trip:finish');
check('完成旅游成就：扣 8888 元宝', rtour.st.info.yb === 20000 - 8888, String(rtour.st.info.yb));
check('完成后到访记录清空（能重新去城市）', rtour.st.save.gameSaveDatas.travel_china.length === 0);
check('成就次数 +1', rtour.st.save.gameSaveDatas.travel_china_num === 1);
check('旅游任务的领取标记清掉（可以重做）', taskList(rtour.st, 'travel')[2].take === false);
check('没旅游过就不让点（不白扣钱）', (() => {
  const r0 = freshRaise();
  r0.st.setInfo('yb', 20000);
  const ok0 = r0.act('trip:finish');
  return ok0 === false && r0.st.info.yb === 20000;
})());

// 20) 存档坏了不能默默当新宠物养（那是把养了几个月的一只丢了）
const badFile = path.join(HOME, 'user', 'raise.json');
fs.writeFileSync(badFile, '{ 这不是合法 JSON');
const rbad = createRaise({ animations: ANIMS, log: () => {} });
check('存档损坏时会备份成 .bad-* 再新建', fs.readdirSync(path.join(HOME, 'user')).some((f) => f.includes('raise.json.bad-')), fs.readdirSync(path.join(HOME, 'user')).join(','));
check('新建的宠物是能用的', rbad.st.info.health === 5 && rbad.st.info.yb === 5000);

// 21) 死掉的宠物点它不该继续攒「逗逗我」
const rdead = freshRaise();
rdead.st.setInfo('health', 0);
const ddw0 = countOf2(rdead.st, 'Amusing');
rdead.act('pet:click');
check('死了以后点它不计「逗逗我」', countOf2(rdead.st, 'Amusing') === ddw0, `${ddw0} → ${countOf2(rdead.st, 'Amusing')}`);

// 22) 与 qqpet 的存档互通（导入 / 导出）
const port = await import(url('lib/raise/port.mjs'));
const qqpetSave = {
  havePet: true,
  isBury: false,
  saveNum: 12,
  nowTimeLine: Math.floor(Date.now() / 1000) - 86400,
  petInfo: { name: '老宠物', host: '主人~', sex: 'MM', growth: 4500, hunger: 900, clean: 800, health: 5, mood: 700, birthDay: 1700000000, intel: 30, charm: 20, strong: 40, yb: 7777, onLineTime: 100, lastX: -1, lastY: -1, lastLoginTime: 0, onlineDataTime: 0, pinkDiamond: false, sweetHeart: false },
  petComputedlInfo: { level: 7, upGrowth: 3000, nextGrowth: 5000, hungerMax: 2000, cleanMax: 2000, healthMax: 5, moodMax: 1000 },
  studyInfo: { chinese: 3, mathematics: 0, politics: 0, music: 0, art: 0, manner: 0, pe: 0, labouring: 0, wushu: 0 },
  activeOption: { work: 'bz', study: null, trip: null, ill: null, die: null },
  selfGoodDatas: { food: ['_10013006*2'], clean: [], medicine: [], background: [], service: [], work: [], study: [], trip: [], toy: [], nums: [] },
  selfGoodUseOption: { background: null, food: null, clean: null, toy: null },
  gameSaveDatas: { fishing_harvestfish: 12, travel_china: [{ name: '北京市', value: 2 }], travel_china_num: 1, ddw: 3, yyds: 0 },
  illustrated: ['10013006'],
  saveJsonData: { email: '{}', task: '{}', signin: '{}', fishs: '{}' },
  settings: { opacity: 1, music: 0.5, faceClick: 2, quiet: true, autoStart: true, paused: false, hidden: false, hd: true, clip: false, watchApp: false, aiUrl: 'http://x', aiKey: 'k', aiModel: 'm', weatherCity: '北京' },
};
const imported = port.fromQqpet(qqpetSave);
check('导入：宠物本体照搬（名字/性别/等级/元宝）', imported.save.petInfo.name === '老宠物' && imported.save.petInfo.sex === 'MM' && imported.save.petInfo.yb === 7777);
check('导入：丢掉了这边没有的界面设置', !('opacity' in imported.save.settings) && !('aiKey' in imported.save.settings) && imported.save.settings.quiet === true);
check('导入：清掉进行中的打工（免得一启动就瞬间算完）', imported.save.activeOption.work === null && imported.notes.some((n) => n.includes('正在进行的事')));
check('导入：水位重置（不算饿/脏，也不把已有 token 一次算成收益）', imported.save.lastTick === null && imported.save.lastTokenTs > 0);

const qqPath = path.join(HOME, 'user', '来自qqpet.json');
fs.writeFileSync(qqPath, JSON.stringify(qqpetSave));
freshRaise().st.flush(true); // 先有一只存过档的宠物，才谈得上"导入前备份"
const roundIn = port.importInto(qqPath);
check('导入到存档：宠物与到访记录都在', (() => {
  const s = JSON.parse(fs.readFileSync(path.join(HOME, 'user', 'raise.json'), 'utf8'));
  return s.petInfo.name === '老宠物' && s.gameSaveDatas.travel_china.length === 1 && s.saveJsonData.signin === '{}';
})(), JSON.stringify(roundIn.summary));
check('导入前会备份原存档', Boolean(roundIn.backup) && fs.existsSync(roundIn.backup));

const expPath = path.join(HOME, 'user', '导出.json');
const exp = port.exportTo(expPath);
check('导出：文件里没有我们自己的字段', (() => {
  const j = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  return !('lastTick' in j) && !('lastTokenTs' in j) && j.petInfo.name === '老宠物';
})());
check('导出→再导入：宠物原样回来（往返不丢东西）', (() => {
  const back = port.fromQqpet(JSON.parse(fs.readFileSync(expPath, 'utf8')));
  return back.save.petInfo.name === '老宠物' && back.save.petComputedlInfo.level === 7 && back.save.petInfo.yb === 7777 && back.save.gameSaveDatas.travel_china.length === 1;
})());
check('不认的文件会明确报错（不会把存档写成垃圾）', (() => {
  const badFile = path.join(HOME, 'user', '这不是存档.json');
  fs.writeFileSync(badFile, JSON.stringify({ hello: 'world' }));
  try {
    port.readImport(badFile);
    return false;
  } catch (e) {
    return e.message.includes('没有宠物数据');
  }
})());

// 23) 工作联动（工作仪表盘）：工作区脏 → 它变脏；提交 → 洗澡；请求报错 → 心情差
const link = await import(url('lib/raise/link.mjs'));
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const sh = promisify(execFile);
const repo = path.join(HOME, 'repo');
fs.mkdirSync(repo, { recursive: true });
const gitRun = (args) => sh('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { windowsHide: true });

await gitRun(['init', '-q']);
fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
const rows1 = await link.gitSample([repo]);
check('采样：新文件算未提交改动', rows1[0].dirty === 1 && rows1[0].name === 'repo', JSON.stringify(rows1[0]));
const eff1 = link.gitEffect(rows1, {});
check('工作区脏 → 清洁往下掉', eff1.clean < 0 && eff1.say.includes('改动没提交'), JSON.stringify(eff1));
check('脏得越多掉得越多（有上限）', link.gitEffect([{ repo, dirty: 100, head: 'x' }], {}).clean === -20);

await gitRun(['add', '.']);
await gitRun(['commit', '-q', '-m', 'first']);
const rows2 = await link.gitSample([repo]);
check('提交之后工作区干净了', rows2[0].dirty === 0 && rows2[0].head.length >= 7, JSON.stringify(rows2[0]));
check('干净时清洁慢慢回一点', link.gitEffect(rows2, {}).clean > 0);

fs.writeFileSync(path.join(repo, 'b.txt'), 'world');
await gitRun(['add', '.']);
await gitRun(['commit', '-q', '-m', 'second']);
const rows3 = await link.gitSample([repo]);
const eff3 = link.gitEffect(rows3, { [repo]: rows2[0].head });
check('认出「刚提交了」→ 清洁 +15、心情 +5，并说一句', eff3.clean === 15 && eff3.mood === 5 && eff3.say.includes('提交了'), JSON.stringify(eff3));

check('findRepos：给仓库本身就用它', link.findRepos(repo).length === 1);
check('findRepos：给"装着项目的目录"会扫一层子目录', link.findRepos(HOME).includes(repo), JSON.stringify(link.findRepos(HOME)));
check('findRepos：路径不存在就当没配', link.findRepos(path.join(HOME, '没有这个目录')).length === 0);

check('错误率：样本太少不折腾', link.errorEffect({ n: 2, bad: 2 }).skip === true);
check('错误率：全成功 → 心情回一点', link.errorEffect({ n: 100, bad: 0 }).mood === 3);
check('错误率：一半失败 → 掉满 20 并值得说一句', (() => {
  const e = link.errorEffect({ n: 100, bad: 50 });
  return e.mood === -20 && e.worry === true;
})());
check('错误率：偶尔几个错 → 掉一点但不唠叨', (() => {
  const e = link.errorEffect({ n: 100, bad: 6 });
  return e.mood === -4 && e.worry === false;
})());

// 端到端：脏工作区真能把宠物弄脏
const rlink = freshRaise();
fs.writeFileSync(path.join(repo, 'c.txt'), 'dirty');
const lk = link.createLink({ st: rlink.st, repo, everyMs: 60_000, log: () => {} });
if (typeof lk.start === 'function') await lk.sample({ apply: false });
const clean0 = rlink.st.info.clean;
await lk.sample();
check('端到端：工作区脏 → 宠物清洁真的掉了', rlink.st.info.clean < clean0, `${clean0} → ${rlink.st.info.clean}`);
check('气泡上会多一行「工作区 … 处未提交」', (rlink.st.linkState.git.length > 0 ? lk.line() || '' : '').includes('未提交'), String(lk.line()));
check('「工作区状态」那句话能念出来', lk.text().includes('repo'), lk.text());

// 24) 动画池按成长阶段解锁
const { filterAnimations, lockedNames, makeAnimPicker, DEFAULT_STAGE_UNLOCK } = await import(url('lib/raise/anim.mjs'));
const animsStage = {
  idle: ['待机呼吸休闲'],
  categories: [
    { id: '小动作', actions: ['悠闲哼歌', '照镜子'] },
    { id: '玩耍', actions: ['荡秋千', '骑木马'] },
    { id: '吃什么', actions: ['吃大餐', '吃白饭'] },
    { id: '时节', actions: ['堆雪人'] },
    { id: '我自己加的', actions: ['自定义动画'] },
  ],
  events: { whisper: ['碎碎念-发呆碎碎念'] },
};
const eggCfg = filterAnimations(animsStage, 'Egg');
const eggCats = eggCfg.categories.map((c) => c.id);
check('蛋期只留下「小动作」和「吃什么」', eggCats.includes('小动作') && eggCats.includes('吃什么') && !eggCats.includes('玩耍') && !eggCats.includes('时节'), eggCats.join(','));
check('用户自己加的分类不会被锁死（fail-open）', eggCats.includes('我自己加的'), eggCats.join(','));
check('幼年期多一些（玩耍）', filterAnimations(animsStage, 'Kid').categories.map((c) => c.id).includes('玩耍'));
check('成年期全开', filterAnimations(animsStage, 'Adult').categories.length === animsStage.categories.length);
check('待机/点击这些池子一个字都不动', eggCfg.idle[0] === '待机呼吸休闲' && eggCfg.events.whisper[0] === '碎碎念-发呆碎碎念');
check('锁住的动画名认得出来（但自定义的不算锁）', (() => {
  const l = lockedNames(animsStage, 'Egg');
  return l.has('荡秋千') && !l.has('吃大餐') && !l.has('自定义动画');
})());
check('点播时不会去点被锁住的动画（会退到说话池）', (() => {
  const p = makeAnimPicker(animsStage, () => 'Egg', DEFAULT_STAGE_UNLOCK);
  return p.pick('toy') === '碎碎念-发呆碎碎念';
})());
check('成年后能点播玩耍类动画了', (() => {
  const p = makeAnimPicker(animsStage, () => 'Adult', DEFAULT_STAGE_UNLOCK);
  return ['荡秋千', '骑木马'].includes(p.pick('toy'));
})());

// 引擎里的阶段切换：通知 + 请桌宠重载
const rstage = freshRaise();
let stageMsg = null;
rstage.st.onStageChange = (from, to) => {
  stageMsg = `${from}→${to}`;
};
rstage.st.info.growth = 200; // 1 级 → 5 级要 125+325+650+1150 = 2250…先给够
rstage.st.syncLevel();
rstage.st.info.growth = 20000;
rstage.st.syncLevel();
check('跨阶段会通知（蛋 → 幼年）', stageMsg === 'Egg→Kid', String(stageMsg));
// 重载不靠"通知"，靠宿主一直报的阶段（桌宠比对 sessionStorage）——
// 这里就断言宿主用来下发的那份状态确实变了
check('跨阶段后 stage() 跟着变（宿主按它下发，桌宠据此决定重载）', rstage.st.stage() === 'Kid', rstage.st.stage());

// 25) 成就墙
const achv = await import(url('lib/raise/achv.mjs'));
const ra = achvRaise();
const ybA = ra.st.info.yb;
const got1 = achv.check(ra.st);
check('新宠物第一轮就拿到「破壳而出」并发了奖励', got1.some((a) => a.id === 'hatch') && ra.st.info.yb === ybA + 100, `${ybA} → ${ra.st.info.yb}`);
check('同一成就不会重复解锁', achv.check(ra.st).length === 0);
ra.st.info.growth = 20000;
ra.st.syncLevel();
check('升到幼年期解锁「上学啦」', achv.check(ra.st).some((a) => a.id === 'kid'));
ra.st.setInfo('yb', 20000);
ra.st.setInfo('mood', 100); // 先把心情压低，否则 +100 会被天花板吃掉、断言等于没测
check('攒到一万解锁「万元户」（奖励 100 心情，得真的加上）', (() => {
  const got = achv.check(ra.st);
  return got.some((a) => a.id === 'rich') && ra.st.info.mood === 200;
})(), `mood ${ra.st.info.mood}`);

check('累计用量计数：喂 100 万 token 会记进成就统计', (() => {
  const r2 = achvRaise();
  r2.fake.feed(1_000_000);
  r2.st.lastTick = Math.floor(Date.now() / 1000) - 60;
  r2.st.tick();
  return achv.statOf(r2.st, 'tokens') === 1_000_000 && achv.statOf(r2.st, 'dayTokens') === 1_000_000;
})());
check('同一 tick 里就把「一百万 token」解锁了', (() => {
  const r2 = achvRaise();
  r2.fake.feed(1_000_000);
  r2.st.lastTick = Math.floor(Date.now() / 1000) - 60;
  r2.st.tick();
  return achv.isUnlocked(r2.st, 'tok1m');
})());

check('连续天数：昨天写过就 +1，断了从头数，昨天没写就归零', (() => {
  const rd = freshRaise();
  const st = rd.st;
  achv.list(st); // 先把进度对象建出来
  const today = st.dayStart();
  // 昨天有流量 + 时间连续 → 链条 +1
  achv.bump(st, 'dayTokens', 1234); // 这是"刚结束那天"的流量
  st.achv.stats.lastDay = today - 86400;
  st.achv.stats.streak = 3;
  achv.newDay(st);
  const ok1 = achv.statOf(st, 'streak') === 4 && achv.statOf(st, 'dayTokens') === 0;
  // 昨天没流量 → 归零（"连写"看的是写没写，不是开没开机）
  achv.bump(st, 'dayTokens', 0);
  st.achv.stats.lastDay = today - 86400;
  achv.newDay(st);
  const ok2 = achv.statOf(st, 'streak') === 0;
  // 隔了五天再写 → 从 1 重新数
  achv.bump(st, 'dayTokens', 999);
  st.achv.stats.lastDay = today - 86400 * 5;
  achv.newDay(st);
  return ok1 && ok2 && achv.statOf(st, 'streak') === 1;
})());
check('跨天会把"单日 token"清零（累计值留着）', (() => {
  const rd = freshRaise();
  achv.bump(rd.st, 'dayTokens', 123);
  achv.bump(rd.st, 'tokens', 999);
  achv.list(rd.st);
  rd.st.achv.stats.lastDay = rd.st.dayStart() - 86400;
  achv.newDay(rd.st);
  return achv.statOf(rd.st, 'dayTokens') === 0 && achv.statOf(rd.st, 'tokens') === 999;
})());
check('关掉成就时统计照样记，但不会解锁', (() => {
  const r3 = freshRaise(); // newRaise 里 achievements:false
  r3.fake.feed(2_000_000);
  r3.st.lastTick = Math.floor(Date.now() / 1000) - 60;
  r3.st.tick();
  return achv.statOf(r3.st, 'tokens') === 2_000_000 && achv.list(r3.st).every((a) => !a.unlocked);
})());

check('成就进度能报出来（未达成显示 n/N）', (() => {
  const txt = achv.describe(ra.st, 'tok1b');
  return txt.includes('进度') && txt.includes('十亿');
})());
check('已达成的成就说的是"已达成"', achv.describe(ra.st, 'hatch').includes('已达成'));
check('成就在菜单里有一栏，条目数与表一致', (() => {
  const sec = ra.menu().find((s) => s.label.includes('成就'));
  return Boolean(sec) && sec.children.length === achv.ACHIEVEMENTS.length + 2; // +「看看成就」+「图鉴」
})(), String(ra.menu().find((s) => s.label.includes('成就'))?.children.length));
check('成就关掉时不摆那面永远 0/17 的墙（只留图鉴）', (() => {
  const sec = freshRaise().menu().find((s) => s.label.includes('图鉴') || s.label.includes('成就'));
  return sec.label.includes('图鉴') && !sec.label.includes('成就') && sec.children.length === 1;
})(), JSON.stringify(freshRaise().menu().map((s) => s.label)));
check('生产默认是开着成就的（测试里为了确定性才关）', settings.resolve('achievements').value === true);
check('成就数据坏了也不会把整分钟结算带崩（语法坏 + 形状坏都算）', (() => {
  // 成就**开着**才有意义：check 挂在 tick 钩子里，会跟着每分钟结算跑
  for (const blob of ['{ 这不是 JSON', '{"unlocked":"x","stats":42}']) {
    const r4 = achvRaise();
    r4.st.save.saveJsonData.achv = blob;
    r4.st.achv = null; // 丢掉缓存，逼它重新解析
    try {
      achv.list(r4.st);
      r4.st.lastTick = Math.floor(Date.now() / 1000) - 60;
      r4.st.tick(); // 走的是真的结算路径（含 achv.check）
    } catch (e) {
      return false;
    }
  }
  return true;
})());
check('「走遍全国」看的是累计去过多少地方（清空记录也不会倒退）', (() => {
  const r6 = achvRaise();
  r6.st.save.gameSaveDatas.travel_china = [{ name: '北京市', value: 1 }, { name: '湖北省', value: 1 }];
  r6.st.achv = null;
  achv.list(r6.st); // 首次读会按当前记录回填累计值
  const seeded = achv.statOf(r6.st, 'cities');
  r6.st.setInfo('yb', 20000);
  r6.act('trip:finish'); // 清空到访记录
  const after = achv.list(r6.st).find((a) => a.id === 'travel35');
  return seeded === 2 && r6.st.save.gameSaveDatas.travel_china.length === 0 && after.done === 2;
})(), `cities=${achv.statOf(achvRaise().st, 'cities')}`);
check('换宠物时成就缓存会被清掉（新蛋不该继承旧宠物的成就墙）', (() => {
  const r5 = achvRaise();
  achv.check(r5.st);
  const hadBefore = achv.isUnlocked(r5.st, 'hatch');
  r5.st.save.havePet = false;
  r5.st.save.isBury = true;
  r5.act('adopt:MM');
  return hadBefore && !achv.isUnlocked(r5.st, 'hatch') && achv.statOf(r5.st, 'tokens') === 0;
})());

// 26) 状态要看得到实际数值（物品加的是固定值，只给百分比没法算会不会溢出）
const { statusLines } = await import(url('lib/raise/menu.mjs'));
const { effectText } = await import(url('lib/raise/items.mjs'));
const rv2 = freshRaise();
rv2.st.info.hunger = 1234;
rv2.st.info.clean = 56;
const statusRows = statusLines(rv2.st).join('\n');
check('状态里的饥饿给的是「当前/上限」而不是百分比', /饥饿 .*1234\/\d+/.test(statusRows), statusRows.split('\n')[2]);
check('清洁同理（数值小的时候也对）', /清洁 .*56\/\d+/.test(statusRows), statusRows.split('\n')[3]);
check('不再出现"%"（百分比交给进度条表达）', !statusRows.includes('%'), statusRows.split('\n').slice(2, 5).join(' | '));

check('用完物品回显「之前 → 之后」', effectText([{ key: 'hunger', before: 1000, after: 1123 }]) === '\n饥饿 1000→1123', JSON.stringify(effectText([{ key: 'hunger', before: 1000, after: 1123 }])));
check('多栏一起变就都报出来', effectText([{ key: 'hunger', before: 1, after: 2 }, { key: 'mood', before: 3, after: 4 }]).includes('心情 3→4'));
check('喂食会把变化量接到气泡那句后面', (() => {
  const rf2 = freshRaise();
  rf2.st.info.hunger = 100;
  rf2.st.events.length = 0;
  rf2.act('use:food:10013006'); // 冰淇淋：饥饿 +360
  const txt = rf2.st.events.at(-1)?.text ?? '';
  return txt.includes('饥饿 100→') && Number(rf2.st.info.hunger) === 460;
})(), JSON.stringify(freshRaise().st.events));
check('喂到饱会如实显示"没涨"（封顶了）', (() => {
  const rf3 = freshRaise();
  rf3.st.info.hunger = rf3.st.meta.hungerMax; // 已经满了
  rf3.st.events.length = 0;
  rf3.act('use:food:10013006');
  const txt = rf3.st.events.at(-1)?.text ?? '';
  const m = txt.match(/饥饿 (\d+)→(\d+)/);
  return Boolean(m) && m[1] === m[2]; // 前=后，一眼看出这一口白吃了
})(), JSON.stringify((() => {
  const rf4 = freshRaise();
  rf4.st.info.hunger = rf4.st.meta.hungerMax;
  rf4.st.events.length = 0;
  rf4.act('use:food:10013006');
  return rf4.st.events.at(-1)?.text;
})()));

check('换算系数要能自解释（说清它是怎么来的）', (() => {
  const rf5 = freshRaise();
  rf5.st.setInfo('mood', 300); // 郁闷档 → 系数 0.7
  rf5.st.setInfo('pinkDiamond', true);
  rf5.st.setInfo('PDiamondExpirationDate', Math.floor(Date.now() / 1000) + 86400); // 真开通才算数
  const txt = rf5.text();
  return (
    txt.includes('token 换算 ×') &&
    txt.includes('心情 0.7') &&
    txt.includes('粉钻 +10/时') &&
    txt.includes('加成') &&
    txt.includes('成长值 = token ÷ 100 万')
  );
})(), freshRaise().text());
check('换算系数是 1 的时候不啰嗦（不占行）', (() => {
  const rf6 = freshRaise();
  rf6.st.setInfo('mood', 1000); // 开心档 + 没有加成 = 1.0
  return !rf6.text().includes('token 换算');
})());

// 27) 领奖要说清领到了什么
const { rewardText } = await import(url('lib/raise/items.mjs'));
check('奖励清单：数量为 1 不写 ×1，多个用空格隔开', rewardText([{ name: '小笼包', num: 1 }, { name: '元宝', num: 50 }]) === '\n小笼包　元宝 ×50', JSON.stringify(rewardText([{ name: '小笼包', num: 1 }, { name: '元宝', num: 50 }])));
check('奖励清单：空的就不占行', rewardText([]) === '' && rewardText(undefined) === '');
check('交任务时气泡里列出了领到的东西', (() => {
  const rtask = achvRaise();
  for (let i = 0; i < 5; i++) rtask.act('pet:click'); // 逗逗我第一条：5 次
  rtask.st.events.length = 0;
  rtask.act('claim:ddw:0');
  const txt = rtask.st.events.at(-1)?.text ?? '';
  return txt.includes('完成') && /\n.+\S/.test(txt) && txt.includes('×') === false; // 奖励是 ×1 的，所以不带 ×
})(), JSON.stringify((() => {
  const r7 = achvRaise();
  for (let i = 0; i < 5; i++) r7.act('pet:click');
  r7.st.events.length = 0;
  r7.act('claim:ddw:0');
  return r7.st.events.at(-1)?.text;
})()));
check('签到 / 在线奖励 / 抽成长值的气泡也会列东西', (() => {
  const r8 = achvRaise();
  r8.st.events.length = 0;
  r8.act('sign:growth');
  const txt = r8.st.events.at(-1)?.text ?? '';
  return txt.includes('\n') && (txt.includes('成长值') || txt.includes('×'));
})(), JSON.stringify((() => {
  const r9 = achvRaise();
  r9.st.events.length = 0;
  r9.act('sign:growth');
  return r9.st.events.at(-1)?.text;
})()));
check('菜单里"可领"的任务会把奖励名字摆出来', (() => {
  const r10 = achvRaise();
  for (let i = 0; i < 5; i++) r10.act('pet:click');
  const row = r10.menu().find((s) => s.label.includes('任务')).children[1].children[0];
  return row.label.includes('🎁') && row.label.includes('→'), row.label;
})());
check('邮件菜单里也看得见附件是什么', (() => {
  const r11 = achvRaise();
  mail.deliverMails(r11.st); // 欢迎信（带附件）
  const sec = r11.menu().find((s) => s.label.includes('邮件'));
  return sec.children.some((c) => c.label.startsWith('📦') && c.label.includes('（') && c.label.includes('）')), JSON.stringify(sec.children.map((c) => c.label));
})());

// 28) 花钱/挣钱的地方都要报账（跟属性变化同一套格式）
const lastText = (r) => r.st.events.at(-1)?.text ?? '';
check('打工收工报工资', (() => {
  const rw = freshRaise();
  rw.st.info.growth = 20000;
  rw.st.syncLevel();
  rw.act('work:bz'); // 搬砖 10 元宝
  rw.st.events.length = 0;
  advanceTask(rw.st, 30);
  return /元宝 \d+→\d+/.test(lastText(rw));
})(), JSON.stringify(lastText(freshRaise())));
check('买东西报账并说清买的什么', (() => {
  const rb = freshRaise();
  rb.st.setInfo('yb', 5000);
  rb.st.events.length = 0;
  rb.act('buy:food:100010032');
  const t = lastText(rb);
  return t.includes('小笼包') && t.includes('元宝 5000→3000');
})(), JSON.stringify(lastText(freshRaise())));
check('喂鱼报扣费与鱼的进度', (() => {
  const rf = freshRaise();
  rf.st.setInfo('yb', 1000);
  rf.act('fish:buy:2');
  rf.st.events.length = 0;
  rf.act('fish:feed:' + rf.st.pond.fishs[0].id);
  const t = lastText(rf);
  return t.includes('元宝 998→988') && t.includes('还需') && t.includes('金鱼');
})(), JSON.stringify(lastText(freshRaise())));
check('买鱼苗报扣费与它的成长时间', (() => {
  const rf = freshRaise();
  rf.st.setInfo('yb', 1000);
  rf.st.events.length = 0;
  rf.act('fish:buy:2');
  const t = lastText(rf);
  return t.includes('金鱼') && t.includes('元宝 1000→998') && t.includes('还需');
})(), JSON.stringify(lastText(freshRaise())));
check('在线奖励第二次起报扣了多少', (() => {
  const ra2 = achvRaise();
  ra2.st.setInfo('yb', 5000);
  signin.tickGift(ra2.st, 20); // 倒计时走完
  ra2.st.events.length = 0;
  ra2.act('sign:gift'); // 第一次免费
  signin.tickGift(ra2.st, 20);
  ra2.st.events.length = 0;
  ra2.act('sign:gift'); // 第二次 100 元宝
  const t = lastText(ra2);
  return t.includes('花了 100 元宝') && /元宝 \d+→\d+/.test(t);
})(), JSON.stringify(lastText(achvRaise())));
check('完成旅游成就报扣费', (() => {
  const rt = freshRaise();
  rt.st.save.gameSaveDatas.travel_china = [{ name: '北京市', value: 1 }];
  rt.st.setInfo('yb', 20000);
  rt.st.events.length = 0;
  rt.act('trip:finish');
  return lastText(rt).includes('元宝 20000→11112');
})(), JSON.stringify(lastText(freshRaise())));
check('开学/上课报属性与课时进度', (() => {
  const rs = freshRaise();
  rs.st.info.growth = 20000;
  rs.st.syncLevel();
  rs.act('study:xx-chinese');
  rs.st.events.length = 0;
  advanceTask(rs.st, 45);
  const t = lastText(rs);
  return t.includes('课时') && (t.includes('智力') === false) && /语文 \d+\/9 课时/.test(t);
})(), JSON.stringify(lastText(freshRaise())));

// 29) 「用户不知道的东西」总清查：属性、贵族作用、门槛缺口、对症药、首启提示
check('详细属性里能看到智力/魅力/武力/幸运/疲劳（原来界面上一个字都没有）', (() => {
  const rd2 = freshRaise();
  rd2.st.info.intel = 33;
  rd2.st.info.charm = 44;
  rd2.st.info.strong = 55;
  rd2.st.events.length = 0;
  rd2.act('detail');
  const t = rd2.st.events.at(-1)?.text ?? '';
  return t.includes('智33') && t.includes('魅44') && t.includes('武55') && t.includes('幸运') && t.includes('疲劳');
})(), JSON.stringify((() => {
  const r = freshRaise();
  r.st.events.length = 0;
  r.act('detail');
  return r.st.events.at(-1)?.text;
})()));
check('详细属性里也会报贵族到期与生效中的限时物品', (() => {
  const rd3 = freshRaise();
  rd3.st.setInfo('pinkDiamond', true);
  rd3.st.setInfo('PDiamondExpirationDate', Math.floor(Date.now() / 1000) + 86400 * 3);
  rd3.st.save.selfGoodUseOption.clean = { id: '102020055', left: 42 };
  rd3.st.events.length = 0;
  rd3.act('detail');
  const t = rd3.st.events.at(-1)?.text ?? '';
  return t.includes('粉钻') && t.includes('天') && t.includes('柔爽洗发液') && t.includes('42分');
})(), JSON.stringify((() => {
  const r = freshRaise();
  r.st.events.length = 0;
  r.act('detail');
  return r.st.events.at(-1)?.text;
})()));
check('「粉钻有什么用」点开就念好处', (() => {
  const rp = freshRaise();
  rp.st.events.length = 0;
  rp.act('pd:help');
  const t = rp.st.events.at(-1)?.text ?? '';
  return t.includes('八折') && t.includes('成长') && t.includes('池塘');
})(), JSON.stringify((() => {
  const r = freshRaise();
  r.st.events.length = 0;
  r.act('pd:help');
  return r.st.events.at(-1)?.text;
})()));
check('「贴心宝贝有什么用」点开就念好处', (() => {
  const rh2 = freshRaise();
  rh2.st.events.length = 0;
  rh2.act('heart:help');
  const t = rh2.st.events.at(-1)?.text ?? '';
  return t.includes('吃饭洗澡') && t.includes('1.1');
})());
check('贵族那一栏里有「有什么用」两条', (() => {
  const sec = freshRaise().menu().find((s) => s.label.includes('贵族'));
  return sec.children.filter((c) => c.label.startsWith('❓')).length === 2;
})());
check('状态里贵族带剩余天数（不然不知道还剩几天）', (() => {
  const rs2 = freshRaise();
  rs2.st.setInfo('pinkDiamond', true);
  rs2.st.setInfo('PDiamondExpirationDate', Math.floor(Date.now() / 1000) + 86400 * 3);
  rs2.st.info.sweetHeart = true;
  rs2.st.info.sweetHeartOverTime = Math.floor(Date.now() / 1000) + 86400 * 2;
  const row = statusLines(rs2.st).find((l) => l.includes('元宝')) ?? '';
  // 天数按 06:00 换日算，所以"现在 +3 天"会显示成 4 天 —— 断言只要形如「粉钻 N天」
  return /粉钻\d+天/.test(row) && /贴心\d+天/.test(row);
})(), (() => {
  const r = freshRaise();
  r.st.setInfo('pinkDiamond', true);
  r.st.setInfo('PDiamondExpirationDate', Math.floor(Date.now() / 1000) + 86400 * 3);
  return statusLines(r.st).find((l) => l.includes('元宝'));
})());
check('打工菜单标出"够不够格"（标签放不下门槛细节，细节在点下去那句话里）', (() => {
  // 新宠物：搬砖（2 级）不够格要带 ✗，而且一个够格的都不该有 ✗
  const fresh = freshRaise().menu().find((s) => s.label.includes('打工')).children;
  const bz = fresh.find((c) => c.raise === 'work:bz');
  // 练到 20 级：至少有一份不再带 ✗
  const strong = freshRaise();
  strong.st.info.growth = 500000;
  strong.st.syncLevel();
  const later = strong.menu().find((s) => s.label.includes('打工')).children;
  return bz.label.startsWith('✗') && later.some((c) => !c.label.startsWith('✗'));
})(), (() => {
  const f = freshRaise().menu().find((s) => s.label.includes('打工')).children;
  return f.slice(0, 3).map((c) => c.label).join(' | ');
})());
check('属性门槛没过时说清缺哪个、差多少', (() => {
  const rw3 = freshRaise();
  rw3.st.info.growth = 200000; // 等级拉高，绕开等级门槛
  rw3.st.syncLevel();
  rw3.st.info.intel = 5;
  rw3.st.info.strong = 7;
  rw3.st.info.charm = 9;
  rw3.st.events.length = 0;
  rw3.act('work:yy'); // 演员：智力≥800 武力≥1000 魅力≥800
  const t = rw3.st.events.at(-1)?.text ?? '';
  return t.includes('智力 ≥ 800') && t.includes('我现在 5') && t.includes('武力 ≥ 1000') && t.includes('魅力 ≥ 800');
})(), JSON.stringify((() => {
  const r = freshRaise();
  r.st.info.growth = 200000;
  r.st.syncLevel();
  r.st.events.length = 0;
  r.act('work:yy');
  return r.st.events.at(-1)?.text;
})()));
check('学历门槛没过时说要什么学历', (() => {
  const rw4 = freshRaise();
  rw4.st.info.growth = 200000;
  rw4.st.syncLevel();
  rw4.st.events.length = 0;
  rw4.act('work:nwg'); // 泥瓦工：要「小学劳技」学历
  const t = rw4.st.events.at(-1)?.text ?? '';
  return t.includes('要学历') && t.includes('劳技');
})(), JSON.stringify((() => {
  const r = freshRaise();
  r.st.info.growth = 200000;
  r.st.syncLevel();
  r.st.events.length = 0;
  r.act('work:nwg');
  return r.st.events.at(-1)?.text;
})()));
check('等级不够时报"要几级、我现在几级"', (() => {
  const rw5 = freshRaise(); // 1 级
  rw5.st.events.length = 0;
  rw5.act('work:bz'); // 要 2 级
  return (rw5.st.events.at(-1)?.text ?? '').includes('要 2 级，我现在 1 级');
})());
check('生病时吃药那栏标出哪个对症', (() => {
  const ril = achvRaise();
  ril.st.setActivity('ill', '0-');
  ril.st.setInfo('health', 3); // 病线 0 + 健康 3 → 支气管炎，对症的是甘草剂（20003）
  addG(ril.st, 'medicine', '20003', 1);
  const kids = ril.menu()[0].children.find((c) => c.label.includes('吃药')).children;
  const right = kids.find((k) => k.label.includes('对症 ✓'));
  const wrong = kids.find((k) => k.label.includes('不对症'));
  return Boolean(right) && right.raise.endsWith('20003') && Boolean(wrong);
})(), (() => {
  const r = achvRaise();
  r.st.setActivity('ill', '0-');
  r.st.setInfo('health', 3);
  addG(r.st, 'medicine', '20003', 1);
  const kids = r.menu()[0].children.find((c) => c.label.includes('吃药')).children;
  return kids.map((k) => k.label).join(' | ');
})());
check('头一回开机提一句"右键有玩法"（只提一次）', (() => {
  const ron = freshRaise();
  ron.st.events.length = 0;
  ron.st.daily();
  const first = ron.st.events.some((e) => e.text.includes('右键'));
  ron.st.events.length = 0;
  ron.st.daily(); // 第二次不该再说
  return first && !ron.st.events.some((e) => e.text.includes('右键'));
})());

// 30) 气泡容量：放不下的部分会被窗口顶上裁掉（用户看到的"显示不全"就是这个）
const { bubbleRows, BUBBLE_ROWS, BUBBLE_UNITS, fitBubble, textUnits } = await import(url('lib/raise/engine.mjs'));
const TRIM_MARK = '…（更多见命令行';
/** 我们自己的气泡都必须在容量内（既不能超行，也不能触发兜底截断） */
const fits = (text) => bubbleRows(text) <= BUBBLE_ROWS && !String(text).includes(TRIM_MARK);
const bubbleOf = (r, action) => {
  r.st.events.length = 0;
  r.act(action);
  return r.st.events.at(-1)?.text ?? '';
};
check('「详细属性」在气泡容量内（简单宠物不该被截，满配宠物允许截但必须标明）', (() => {
  const simple = bubbleOf(freshRaise(), 'detail');
  if (!fits(simple)) return false;
  const r = freshRaise();
  r.st.setInfo('pinkDiamond', true);
  r.st.setInfo('PDiamondExpirationDate', Math.floor(Date.now() / 1000) + 86400 * 5);
  r.st.info.sweetHeart = true;
  r.st.info.sweetHeartOverTime = Math.floor(Date.now() / 1000) + 86400 * 7;
  r.st.save.selfGoodUseOption.clean = { id: '102020055', left: 42 };
  const rich = bubbleOf(r, 'detail');
  // 满配（贵族 + 贴心 + 限时）确实超过 8 行 → 兜底截断并标明也算合格，只要没超出容量
  return bubbleRows(rich) <= BUBBLE_ROWS && (rich.includes(TRIM_MARK) || fits(rich));
})(), (() => {
  const r = freshRaise();
  r.st.setInfo('pinkDiamond', true);
  r.st.setInfo('PDiamondExpirationDate', Math.floor(Date.now() / 1000) + 86400 * 5);
  r.st.info.sweetHeart = true;
  r.st.info.sweetHeartOverTime = Math.floor(Date.now() / 1000) + 86400 * 7;
  r.st.save.selfGoodUseOption.clean = { id: '102020055', left: 42 };
  const t = bubbleOf(r, 'detail');
  return `${bubbleRows(t)} 行: ` + t.split('\n').join(' / ');
})());
check('状态气泡在容量内（含工作区那一行）', (() => {
  const r = freshRaise();
  r.linkState = { git: [{ repo: 'x', name: 'dsh-pet-ccswitch', dirty: 27, head: 'h', files: [] }], at: Date.now() };
  const t = statusLines(r.st).join('\n');
  return fits(t);
})(), statusLines(freshRaise().st).join(' / '));
check('「粉钻/贴心宝贝有什么用」在容量内', (() => {
  const r = freshRaise();
  return fits(bubbleOf(r, 'pd:help')) && fits(bubbleOf(r, 'heart:help'));
})(), (() => {
  const r = freshRaise();
  return bubbleOf(r, 'pd:help').split('\n').join(' / ');
})());
check('成就栏 / 池塘 / 工作区 的气泡也在容量内', (() => {
  const r = achvRaise();
  r.st.setInfo('yb', 2000);
  r.act('fish:buy:2');
  r.act('fish:buy:3');
  return fits(bubbleOf(r, 'achv:list')) && fits(bubbleOf(r, 'fish:state')) && fits(bubbleOf(r, 'album'));
})(), (() => {
  const r = achvRaise();
  r.act('fish:buy:2');
  return bubbleOf(r, 'fish:state').split('\n').join(' / ');
})());
check('超长内容会被兜底截断并标明（绝不静默裁掉）', (() => {
  const long = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行内容`).join('\n');
  const out = fitBubble(long);
  return bubbleRows(out) <= BUBBLE_ROWS && out.includes(TRIM_MARK);
})());
check('菜单里的长标签也有限度（菜单面板能滚，但一行太长会顶出面板宽度）', (() => {
  const r = achvRaise();
  const labels = [];
  const walk = (nodes) => nodes.forEach((n) => (Array.isArray(n.children) ? walk(n.children) : labels.push(n.label)));
  walk(r.menu());
  // 菜单项是 nowrap：一行放得下约 18 个单位（240px / 13px），超了会把面板撑破/被截断
  return labels.every((l) => textUnits(l) <= 20);
})(), (() => {
  const r = achvRaise();
  const labels = [];
  const walk = (nodes) => nodes.forEach((n) => (Array.isArray(n.children) ? walk(n.children) : labels.push(n.label)));
  walk(r.menu());
  return labels.filter((l) => textUnits(l) > 20).slice(0, 4).map((l) => `${textUnits(l).toFixed(1)} 单位: ${l}`).join(' | ');
})());

// 31) 把菜单里每一项都点一遍，看产出的气泡放不放得下（用户看到的"截断"就是这么来的）
/** 最难的宠物状态：等级高（数字长）、开着贵族、有生效中的限时物品 */
const richPet = () => {
  const r = achvRaise();
  r.st.setInfo('yb', 99999);
  r.st.info.growth = 200000;
  r.st.syncLevel();
  r.st.setInfo('pinkDiamond', true);
  r.st.setInfo('PDiamondExpirationDate', Math.floor(Date.now() / 1000) + 86400 * 5);
  r.st.info.sweetHeart = true;
  r.st.info.sweetHeartOverTime = Math.floor(Date.now() / 1000) + 86400 * 7;
  r.st.save.selfGoodUseOption.clean = { id: '102020055', left: 42 };
  return r;
};
const SWEEP = [
  'status', 'detail', 'talk', 'play', 'album', 'illustrated', 'achv:list', 'today', 'doctor',
  'pd:help', 'heart:help', 'pd:info', 'link:state', 'fish:state', 'sign:done', 'mail:empty',
  'taskmsg:daily:0', 'taskmsg:ddw:0', 'trip:finish', 'exam:quit',
];
/**
 * 返回超标的说明（空数组 = 全都在容量内）。
 * 判据是**渲染后的总行数**：台词那种长句折行是正常的（一句 3 行也没事），
 * 只要整个气泡放得下就行 —— 放不下时窗口会把顶上直接裁掉，那才是 bug。
 */
function sweepBubbles() {
  const bad = [];
  for (const action of SWEEP) {
    for (const [tag, make] of [['满配', richPet], ['新宠', freshRaise]]) {
      const r = make();
      r.st.events.length = 0;
      r.act(action);
      const t = r.st.events.at(-1)?.text;
      if (!t) continue;
      const rendered = bubbleRows(t);
      if (rendered > BUBBLE_ROWS) {
        const worst = t.split('\n').sort((a, b) => textUnits(b) - textUnits(a))[0];
        bad.push(`${action}(${tag}): 渲染 ${rendered} 行（上限 ${BUBBLE_ROWS}）· 最长一行「${worst.slice(0, 22)}」${textUnits(worst).toFixed(1)} 单位`);
      }
    }
  }
  return bad;
}
check('菜单里每个动作产出的气泡都在容量内（挨个点一遍）', sweepBubbles().length === 0, '\n  ' + sweepBubbles().join('\n  '));

// ---------------------------------------------------------------------------
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
