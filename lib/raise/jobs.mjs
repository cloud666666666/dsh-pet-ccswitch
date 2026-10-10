/**
 * jobs.mjs —— 打工 / 上学（含升学考试）/ 全国旅游（qqpet `pet/jobs.ts` 移植）
 *
 * 照搬的东西：学历与属性门槛、每份工作时长与元宝、课时与升学、考试题库（3 题全对才过）、
 * 旅游点的奇遇文案、纪念品掉落（去新省份掉更好的池）、明信片相簿。
 *
 * 换了表现的地方（原版都有对应的界面，桌宠这边只有气泡 + 菜单）：
 *   - 升学考试：原版是一个答题窗口（上一题/下一题/提交）。这边把题目做进右键菜单 ——
 *     菜单里显示当前这道题和四个选项，点一个就答一题，三题答完立刻出结果。
 *   - 旅游奇遇的「带回物品~~」弹窗 → 改成气泡里报一句带回了什么。
 *   - 原版会让模型把奇遇台词改写得更应景（ai.ts 的 tripBack），这边不调模型 ——
 *     养成不该偷偷花你的 token（要调模型得你点碎碎念/对话才行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allGoods, goodOf, loot, addGood, attrs } from './goods.mjs';
import { apply } from './items.mjs';
import { line } from './text.mjs';
import { rand } from './state.mjs';
import * as activity from './activity.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

/** 35 个旅游点（省份 + 奇遇文案） */
const PROVINCES = read('travel.json');
/** 升学考试的题库：`<学校>-<科目>` → 题目 */
const EXAM = read('exam.json');
/** 旅游相簿（能拍到哪些照片、哪张有旅游搭子） */
const PHOTOS = read('album.json');

export { PROVINCES, EXAM, PHOTOS };

const SUBJECTS = ['chinese', 'mathematics', 'politics', 'music', 'art', 'manner', 'pe', 'labouring', 'wushu'];

/** 学校按 studyInfo 的值分档：`name` 是该值以内拿到的文凭，`key` 是在读学校 */
const SCHOOLS = [
  { max: 9, key: 'xx', name: '' },
  { max: 30, key: 'zx', name: '小学' },
  { max: 71, key: 'dx', name: '中学' },
  { max: 167, key: 'yjs', name: '大学' },
  { max: Infinity, key: 'xwzj', name: '研究生' },
];
const school = (v) => SCHOOLS.find((s) => v <= s.max);

/** 学习类物品的 id 是 `<学校>-<科目>` */
const subjectOf = (g) => g.id.split('-')[1];
/** 当前学校已上的课时 */
const lessons = (st, g) => st.save.studyInfo[subjectOf(g)] - g.classNumUp;
/** studyInfo 是对象，上一个课时就 +1（学籍进度就是它） */
function learn(st, k) {
  st.save.studyInfo[k] += 1;
  st.markDirty();
}

const BUSY = {
  work: '[host]，我正在打工呢，等下班再说吧~',
  study: '[host]，我正在上课呢，等下课再说吧~',
  trip: '[host]，我出门旅游啦，等我回来再说吧~',
};

/** 干活前的检查；返回 true 表示「去不了」（并且已经说了为什么） */
function cannot(st, what, sad = what) {
  const doing = ['work', 'study', 'trip'].find((k) => st.activity(k));
  if (st.info.health === 0) st.say(line('state', 'die'), 'die', { kind: 'act' });
  else if (st.info.health !== 5) st.say(`[host],我生病了无法${what}~~`, 'sick', { kind: 'act' });
  else if (st.save.settings.paused) st.say(`[host],我暂停成长拉！无法${what}~~`, '', { kind: 'act' });
  else if (st.info.mood <= 0) st.say(`[host],没有心情哦！无法${sad}~~`, 'sad', { kind: 'act' });
  else if (doing) st.say(BUSY[doing], '', { kind: 'act' });
  else return false;
  return true;
}

/** 文凭，例如「中学语文」；小学没念完是空串 */
export const diploma = (k, v) => (school(v).name && school(v).name + goodOf('study', `xx-${k}`).object) || '';

export const workGoods = () => allGoods('work');

/** 工作说明（菜单里当提示用） */
export function describeWork(g) {
  const edu = Object.entries(g.education ?? {})
    .map(([k, v]) => diploma(k, v))
    .filter(Boolean)
    .join('、');
  const req = ['charm', 'intel', 'strong']
    .filter((k) => g.useArtt?.[k])
    .map((k) => ` ${{ charm: '魅力', intel: '智力', strong: '武力' }[k]}：${g.useArtt[k]}`)
    .join('');
  return [
    g.desc,
    g.yb && `元宝：${g.yb}`,
    g.needLevel ? `需要大于${g.needLevel}级` : '无等级要求',
    edu && `学历要求：${edu}`,
    req && `属性要求：${req}`,
    `工作时长：${g.useTime}分钟`,
    attrs(g) && `属性：${attrs(g)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// 打工
// ---------------------------------------------------------------------------
/** 去打工；返回是否真的去了 */
export function work(st, g) {
  if (cannot(st, '工作')) return false;
  let no = '';
  if (g.needLevel > st.meta.level) no = '[host]，我等级不够哦~';
  else if (Object.entries(g.useArtt ?? {}).some(([k, v]) => v > st.info[k])) no = '[host]，我还需要多吃，才能胜任这个工作哦！~';
  else if (Object.entries(g.education ?? {}).some(([k, v]) => v > st.save.studyInfo[k])) no = '[host]，书到用时方恨少啊，我一定要好好念书！~';
  if (no) {
    st.say(no, '', { kind: 'act' });
    return false;
  }
  st.say('[host]，我开始工作了哦~', 'work', { kind: 'act' });
  activity.startTask(st, workTask(st, g), g.id);
  return true;
}

const workTask = (st, g) => ({
  key: 'work',
  minutes: g.useTime,
  end: () => {
    st.addInfo('yb', g.yb);
    apply(st, g);
    st.count('Work');
    st.say(line('state', 'overWork') ?? '[host]，我下班啦，好累哦~', 'work', { kind: 'act' });
  },
});

// ---------------------------------------------------------------------------
// 上学
// ---------------------------------------------------------------------------
/** 某科目当前该上的课（按它自己的进度挑学校） */
export const lessonOf = (st, k) => {
  const g = goodOf('study', `${school(st.save.studyInfo[k]).key}-${k}`);
  return { ...g, name: g.tolkName ?? g.name };
};

/** 全部科目当前的课（菜单用） */
export const allLessons = (st) => SUBJECTS.map((k) => lessonOf(st, k)).filter((g) => g.classNum);

export const describeStudy = (st, g) =>
  [g.desc, `课时：${g.classNum}`, `已学课时：${lessons(st, g)}`, attrs(g) && `属性：${attrs(g)}`, `学习时长：${g.useTime}分钟`]
    .filter(Boolean)
    .join(' · ');

/**
 * 上完一个学校的全部课时就安排升学考试。
 * 原版在这里弹窗问「我要考试」，桌宠这边直接把考试挂进菜单（见 menu.mjs 的考试那一段）。
 */
export function startExam(st, g) {
  const bank = EXAM[g.id];
  if (!bank) return false;
  st.exam = {
    id: g.id,
    subject: g.object,
    questions: shuffle(bank)
      .slice(0, 3)
      .map((q) => ({ ...q, options: shuffle(q.options) })),
    picked: [],
  };
  st.markDirty();
  st.say('[host]，我要升学啦，我一定好好考试！点右键菜单里的「升学考试」帮我答题吧~', 'exam', { kind: 'act' });
  return true;
}

/** 答题；返回是否还有下一题 */
export function answer(st, optionIndex) {
  const ex = st.exam;
  if (!ex) return false;
  ex.picked.push(optionIndex);
  const q = ex.questions[ex.picked.length - 1];
  const right = q.options[optionIndex] === q.answer;
  const done = ex.picked.length === ex.questions.length;
  if (!done) {
    st.say(`${right ? '这题我会！' : '唔……这题拿不准……'}（第 ${ex.picked.length}/${ex.questions.length} 题已答）`, 'exam', { kind: 'act' });
    return true;
  }
  const passed = ex.questions.every((qq, i) => qq.options[ex.picked[i]] === qq.answer);
  const g = goodOf('study', ex.id);
  st.exam = null;
  if (passed) {
    learn(st, subjectOf(g));
    st.say(line('state', 'overStudyUp') ?? '[host],好开心啊，我终于升学了！~', 'levelup', { kind: 'act' });
  } else {
    st.say('抱歉未通过！下次再来考吧~', 'sad', { kind: 'act' });
  }
  return false;
}

export function study(st, g) {
  if (cannot(st, '学习')) return false;
  if (lessons(st, g) === g.classNum) return startExam(st, g);
  st.say(`[host]，我被分配到${rand(1e6, 9999999)}班学习${g.object},我放学就回来，不要太想念我哦~~~`, 'study', { kind: 'act' });
  activity.startTask(st, studyTask(st, g), g.id);
  return true;
}

function studyTask(st, g) {
  const minutes = g.useTime;
  return {
    key: 'study',
    minutes,
    // 聪明的孩子可能被提前五分钟放学
    early: (done) => done > minutes - 5 && rand(0, Math.max(200, 3000 - st.info.intel / 10)) <= 10,
    end: (early) => {
      learn(st, subjectOf(g));
      apply(st, g);
      st.count('Study');
      if (lessons(st, g) === g.classNum) startExam(st, g);
      else st.say(line('state', early ? 'cententStudy' : 'overStudy') ?? '[host]，我放学啦~', 'study', { kind: 'act' });
    },
  };
}

// ---------------------------------------------------------------------------
// 旅游
// ---------------------------------------------------------------------------
/** 记一次到访；返回是不是头一回去 */
function visit(st, name) {
  const list = st.save.gameSaveDatas.travel_china;
  const old = list.find((t) => t.name === name);
  st.save.gameSaveDatas.travel_china = old
    ? list.map((t) => (t === old ? { name, value: t.value + 1 } : t))
    : [...list, { name, value: 1 }];
  st.markDirty();
  return !old;
}

/** 奇遇带回一件物品：新省份走更好的池子 */
function souvenir(st, isNew) {
  const [g] = loot(1, isNew ? 2 : 1);
  if (!g) return null;
  addGood(st, g.type, g.id, 1);
  return g;
}

function back(st, p, early) {
  const isNew = visit(st, p.name);
  st.count('Travel1');
  st.setInfo('mood', Math.min(st.info.mood + 20, st.meta.moodMax));
  const e = p.extraordinaryEncounter[rand(0, p.extraordinaryEncounter.length - 1)];
  st.say(e.tolk, 'greet', { kind: 'act' });
  if (early) {
    const g = souvenir(st, isNew);
    // 同一趟回来有好几句话要说，排开点，别挤在同一口气泡里
    if (g) st.say(`旅游奇遇~~ 带回物品~~ 是${g.name}！`, 'gift', { kind: 'act', after: 11_000 });
  }
  const shot = takePhoto(st, p.name);
  if (!shot) return;
  const s = isBuddy(shot.id)
    ? '[host]，我在路上遇到了旅游搭子，一起拍了张合照，寄到邮箱啦~'
    : `[host]，我在${p.name}拍了张明信片寄给你，快去邮箱看看吧~`;
  st.say(s, 'gift', { kind: 'act', after: 22_000 });
  st.pendingPhoto = shot; // 邮件模块（stage 3）会把它放进取件箱
}

export function travel(st) {
  if (cannot(st, '旅行了', '去旅游哦')) return false;
  const p = PROVINCES[rand(0, PROVINCES.length - 1)];
  st.say(`[host]，我开始去${p.name}了哦~`, 'travel', { kind: 'act' });
  activity.startTask(st, tripTask(st, p), p.name);
  return true;
}

const tripTask = (st, p) => ({
  key: 'trip',
  minutes: 60,
  // 运气好的话，路上遇到点事就提前回来了
  early: (done) => done > 55 && rand(0, 1000 - st.luck() * 10) <= 10,
  end: (e) => back(st, p, e),
});

// ---------------------------------------------------------------------------
// 重启后接着做没做完的事（原版 jobs.ts 的 resumeTask）
//   注意：**关掉应用的那段时间也算进度**（这是 qqpet 的既定行为，
//   与"属性衰减不补算"并不矛盾：活儿在那边继续干着，人却没在饿）
// ---------------------------------------------------------------------------
const REBUILD = {
  work: (st, v) => (goodOf('work', v)?.useTime ? workTask(st, goodOf('work', v)) : null),
  study: (st, v) => (goodOf('study', v)?.useTime ? studyTask(st, goodOf('study', v)) : null),
  trip: (st, v) => {
    const p = PROVINCES.find((x) => x.name === v);
    return p ? tripTask(st, p) : null;
  },
};

export function resumeTask(st) {
  const key = ['work', 'study', 'trip'].find((k) => st.activity(k));
  const value = key ? st.activity(key) : '';
  st.save.activeOption.work = st.save.activeOption.study = st.save.activeOption.trip = null;
  const t = key && st.info.health > 0 ? REBUILD[key](st, value) : null;
  if (!t) return;
  const offline = Math.max(Date.now() / 1000 - st.save.nowTimeLine, 0) / 60;
  const done = Math.min(Number(st.save.saveJsonData.activity ?? 0) + offline, t.minutes);
  activity.restore(st, t, value, done);
  st.log?.(`[raise] 接着做没做完的事：${key} ${value} 已做 ${done.toFixed(0)}/${t.minutes} 分钟`);
}

// ---------------------------------------------------------------------------
// 图鉴相簿（qqpet `pet/album.ts` 的 takePhoto）
// ---------------------------------------------------------------------------
/** 相簿：id / 省份 / 什么时候拍的 */
export const shots = (st) => JSON.parse(st.save.saveJsonData.album || '[]');
export const isBuddy = (id) => PHOTOS.some((x) => x.id === id && x.b);
export const photoCount = () => PHOTOS.length;

/** 从没拍过的照片里挑一张（本省的优先，其次不限地点的）；没得拍了返回 null */
export function takePhoto(st, city) {
  const taken = new Set(shots(st).map((s) => s.id));
  const left = PHOTOS.filter((x) => !taken.has(x.id));
  const b = Math.random() < 0.4; // 有没有旅游搭子入镜
  const pool = [b, !b].flatMap((kind) => [city, ''].map((p) => left.filter((x) => x.b === kind && x.p === p))).find((l) => l.length);
  if (!pool) return null;
  const shot = { id: pool[rand(0, pool.length - 1)].id, city, d: Math.floor(Date.now() / 1000) };
  st.save.saveJsonData.album = JSON.stringify([...shots(st), shot]);
  st.markDirty();
  return shot;
}

/** 明信片文案（stage 3 的邮件模块会用） */
export const photoMail = (shot) => ({
  l: isBuddy(shot.id) ? `在${shot.city}遇到了旅游搭子！` : `来自${shot.city}的明信片`,
  m: '[host]，照片我收进「旅游-相簿」啦，随时可以翻看哦~',
  id: shot.id,
});

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

export { SUBJECTS, school, subjectOf, lessons };
