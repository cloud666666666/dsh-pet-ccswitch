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
  const r = createRaise({ animations: ANIMS, log: () => {} });
  r.st.tokens = () => meter.take(); // 换成假表（真表要连 CC Switch 的库）
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
section('每分钟结算（属性衰减 / 成长）');
const before = { hunger: st1.info.hunger, clean: st1.info.clean, growth: st1.info.growth };
st1.lastTick = Math.floor(Date.now() / 1000) - 600; // 假装过了 10 分钟
st1.tick();
check('饥饿会掉', st1.info.hunger < before.hunger);
check('清洁会掉', st1.info.clean < before.clean);
check('成长值会涨（10 分钟 ≈ 13 上下）', st1.info.growth > before.growth + 5, `+${(st1.info.growth - before.growth).toFixed(2)}`);
check('在线时长记了 10 分钟', Math.abs(st1.info.onLineTime) >= 10);

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
check('100 万 token 换 500 成长值', Math.abs(r2.st.info.growth - gr0 - 500) < 5, `+${(r2.st.info.growth - gr0).toFixed(1)}（含挂机基础成长）`);

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
st4.addGood?.call;
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
r7.act('pause') === false;
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
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
