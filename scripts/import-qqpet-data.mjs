/**
 * import-qqpet-data.mjs —— 从 qqpet 源码树导入养成数据表（可复现、带出处）
 * ---------------------------------------------------------------------------
 * 用法：node scripts/import-qqpet-data.mjs [qqpet 仓库路径]
 *   默认 ../qqpet（与本仓库同级）；也可用环境变量 QQPET_DIR。
 *
 * 只搬「数据」，不搬「表现」：
 *   - 保留   ：物品 id / 名称 / 类型 / 价格 / 属性效果 / 时长 / 学历与属性要求 / 描述
 *   - 剥掉   ：url、rectype —— 那是 QQ 原版美术（gif/png/svg），版权归腾讯，
 *              也不适合塞进 npm 包。表现改用 dsh-pet 自己的动画池（见 lib/raise/anim.mjs）。
 *   - 空串/0/false 字段一并删掉，纯粹为了文件小、diff 好看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(process.argv[2] || process.env.QQPET_DIR || path.join(HERE, '..', '..', 'qqpet'));
const DATA_SRC = path.join(SRC_ROOT, 'src', 'renderer', 'pet', 'data');
const OUT = path.join(HERE, '..', 'lib', 'raise', 'data');

/**
 * 空值剔除：'' / null / undefined / 空对象 / 空数组 不写进产物。
 * **0 和 false 要留着** —— 这两个是有含义的值：`classNumUp: 0`（从第 0 课时起）、
 * `school: 0`（小学）、`PD: false`，删了会让「已学课时」算成 NaN。
 */
const empty = (v) =>
  v === '' || v === null || v === undefined ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

const compact = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'url' || k === 'rectype') continue;
    if (empty(v)) continue;
    out[k] = v;
  }
  return out;
};

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_SRC, name), 'utf8'));
}

/**
 * 从 `start` 处的括号起，扫到配对的那个收尾括号（跳过字符串与注释）。
 * 不能用 lastIndexOf：文件里字面量后面还有函数（`illOf` 里就有 `ILLS[+line]`），
 * 会一路吞到函数体里去。
 */
function matchBracket(src, start) {
  const open = src[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let str = null;
  let esc = false;
  let line = false;
  let block = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (str) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === str) str = null;
      continue;
    }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('括号不配对');
}

/**
 * 从 .ts 里抠出一个「纯 JS 字面量」常量：
 *   const DECL = / 匹配到 `=` 后的第一个 { 或 [ 起，扫到配对收尾为止，再当表达式求值。
 * qqpet 的表都是 `export const X: SomeType = {…}`，字面量内部没有 TS 语法，
 * 所以这样抠出来是原样数据，不用手抄、也不会抄错。
 */
function readTsLiteral(file, decl) {
  const src = fs.readFileSync(path.join(DATA_SRC, file), 'utf8');
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`${file} 里找不到 ${decl}`);
  // 从声明后的第一个 `=` 开始找 —— 类型标注里也有 `[`（`Line[]`），不能直接搜第一个括号
  const eq = src.indexOf('=', at + decl.length);
  if (eq < 0) throw new Error(`${file} 的 ${decl} 后面没有 =`);
  const start = src.slice(eq).search(/[{[]/) + eq;
  return (0, eval)(`(${matchBracket(src, start)})`); // eslint-disable-line no-eval
}

function goods() {
  const src = readJson('goods.json');
  const out = {};
  const counts = {};
  for (const [type, items] of Object.entries(src)) {
    out[type] = {};
    for (const [key, g] of Object.entries(items)) out[type][key] = compact(g);
    counts[type] = Object.keys(items).length;
  }
  return { out, counts };
}

fs.mkdirSync(OUT, { recursive: true });
const rel = (p) => path.relative(path.join(HERE, '..'), p).replace(/\\/g, '/');

// ---- 物品表（本体）----
const { out: table, counts } = goods();
fs.writeFileSync(path.join(OUT, 'goods.json'), JSON.stringify(table));
console.log(
  `goods.json    ${Object.values(counts).reduce((a, b) => a + b, 0)} 件 ` +
    `(${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(' / ')}) ` +
    `→ ${rel(path.join(OUT, 'goods.json'))}`,
);

// ---- 抽奖池（签到 / 在线奖励 / 任务奖励用）----
fs.copyFileSync(path.join(DATA_SRC, 'pool.json'), path.join(OUT, 'pool.json'));
console.log(`pool.json     ${readJson('pool.json').map((p) => p.length).join(' / ')} 条 → ${rel(path.join(OUT, 'pool.json'))}`);

// ---- 商店分组（原版「推荐 / 喂养 / 功能 / 装扮」的页码分页）----
fs.copyFileSync(path.join(DATA_SRC, 'shop.json'), path.join(OUT, 'shop.json'));
console.log(`shop.json     4 个分区 → ${rel(path.join(OUT, 'shop.json'))}`);

// ---- 旅游点（省份 + 奇遇文案）----
fs.copyFileSync(path.join(DATA_SRC, 'travel.json'), path.join(OUT, 'travel.json'));
console.log(`travel.json   ${readJson('travel.json').length} 个旅游点 → ${rel(path.join(OUT, 'travel.json'))}`);

// ---- 升学考试题库 ----
fs.copyFileSync(path.join(DATA_SRC, 'exam.json'), path.join(OUT, 'exam.json'));
console.log(`exam.json     题库 → ${rel(path.join(OUT, 'exam.json'))}`);

// ---- 图鉴（收集进度用）----
fs.copyFileSync(path.join(DATA_SRC, 'album.json'), path.join(OUT, 'album.json'));
console.log(`album.json    图鉴 → ${rel(path.join(OUT, 'album.json'))}`);

// ---- 台词表（.ts 字面量 → JSON，原样搬运）----
const talk = readTsLiteral('talk.ts', 'export const TALK');
fs.writeFileSync(path.join(OUT, 'talk.json'), JSON.stringify(talk));
console.log(`talk.json     ${Object.keys(talk).length} 个分类 → ${rel(path.join(OUT, 'talk.json'))}`);

// ---- 按时段的开机问候 ----
const greet = readTsLiteral('greet.ts', 'export const GREET');
fs.writeFileSync(path.join(OUT, 'greet.json'), JSON.stringify(greet));
console.log(`greet.json    ${greet.length} 个时段 → ${rel(path.join(OUT, 'greet.json'))}`);

// ---- 疾病表（含死亡与还魂丹）----
const dead = readTsLiteral('ills.ts', 'export const DEAD');
const ills = readTsLiteral('ills.ts', 'export const ILLS');
fs.writeFileSync(path.join(OUT, 'ills.json'), JSON.stringify({ DEAD: dead, ILLS: ills }));
console.log(`ills.json     3 条病线 + 死亡 → ${rel(path.join(OUT, 'ills.json'))}`);
