/**
 * patch.mjs —— 给 dsh-pet 的构建产物打补丁（幂等、可测）
 *
 * 为什么要打补丁：dsh-pet 原版是给 DSH 用的 —— 余额气泡只有一行短文案、右键菜单指向 DSH 网站。
 * 我们要它显示「今日 token + 服务商余额」并把菜单指向 CC Switch，只能改它的产物。
 *
 * 幂等策略：每条规则有唯一 id，新文本里带标记 `[cc-switch 改造:<id>]`。
 *   有标记         → 跳过（打过了）
 *   无标记但认得出原文 → 替换
 *   无标记也认不出   → **告警但继续**（上游改了代码；功能退化成原版，不崩）
 * 换 dsh-pet 版本重装后跑一遍 install 即可重新打上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR } from './paths.mjs';

const H = (dir) => path.join(dir, 'runtime', 'electron-helper');
const tag = (id) => `[cc-switch 改造:${id}]`;

/** 所有规则。old 按 dsh-pet 0.2.11 的 npm 产物逐字校对过。 */
function rules(pluginDir) {
  const h = H(pluginDir);
  const S = path.join(h, 'shared-core.js');
  return [
    // ---- 解析层：带上余额行 / 余额数值 / 刻度上限 ----
    {
      id: 'parse-balance',
      file: S,
      old: `			toppedUp: typeof d.toppedUp === "string" ? d.toppedUp : void 0
		};`,
      new: `			toppedUp: typeof d.toppedUp === "string" ? d.toppedUp : void 0,
			// ${tag('parse-balance')} 各服务商余额行（宿主 /balance 下发，逐行显示在气泡里）
			balances: Array.isArray(d.balances) ? d.balances.filter((x) => typeof x === "string") : void 0,
			// ${tag('parse-balance')} 档位动画用：当前服务商的余额数值 + 刻度上限
			// 注意 null/空串必须显式排除：Number(null) === 0，会被误判成「余额归零 = 分文不剩」
			balance:
				d.balanceValue === null || d.balanceValue === void 0 || d.balanceValue === ""
					? void 0
					: (Number.isFinite(Number(d.balanceValue)) ? Number(d.balanceValue) : void 0),
			tierMax: Number(d.tierMax) > 0 ? Number(d.tierMax) : void 0
		};`,
    },
    // ---- 档位百分比：改跟账户余额走 ----
    {
      id: 'balance-percent',
      file: S,
      old: `	if (v.kind === "deepseek") {
		const total = Number(v.total);
		if (!Number.isFinite(total)) return void 0;
		const remaining = Math.max(0, total) / DEEPSEEK_FULL_BALANCE_CNY * 100;
		return Math.max(0, Math.min(100, 100 - remaining));
	}`,
      new: `	if (v.kind === "deepseek") {
		// ${tag('balance-percent')} 档位跟「账户余额」走：余额满刻度 = 没怎么花钱 = 0%，归零 = 花光 = 100%
		const bal = Number(v.balance);
		if (!Number.isFinite(bal)) return void 0;
		const max = Number(v.tierMax) > 0 ? Number(v.tierMax) : 1000;
		return Math.max(0, Math.min(100, 100 - (bal / max) * 100));
	}`,
    },
    // ---- 气泡内容：今日 token + 余额 + 请求数 ----
    {
      id: 'bubble-rows',
      file: S,
      old: `		const tier = deepseekPricingTier();
		return [
			{
				role: "label",
				text: "余额（"
			},
			{
				role: "tier",
				tier,
				text: tier === "peak" ? "峰" : "谷"
			},
			{
				role: "label",
				text: "）¥" + (state.total ?? "-")
			}
		];`,
      new: `		// ${tag('bubble-rows')} 气泡改为「今日 token / 当前服务商余额 / 请求数·花费」
		const fmtTok = (n) => {
			const x = Number(n) || 0;
			if (x >= 1e8) return (x / 1e8).toFixed(2).replace(/\\.?0+$/, "") + " 亿";
			if (x >= 1e4) return (x / 1e4).toFixed(1).replace(/\\.0$/, "") + " 万";
			return String(x);
		};
		const rows = [
			{
				role: "label",
				text: "今日 " + fmtTok(state.total) + " token"
			}
		];
		const balances = Array.isArray(state.balances) ? state.balances : [];
		for (const line of balances.slice(0, 4)) rows.push({ role: "sub", text: line });
		rows.push({
			role: "sub",
			text: (state.toppedUp ?? "-") + " 次请求 · $" + (state.granted ?? "-")
		});
		return rows;`,
    },
    // ---- 右键菜单文案 ----
    {
      id: 'menu-labels',
      file: path.join(h, 'sprite.js'),
      old: `    const tools = [{ label: '打开网站', action: 'open-site' }];
    if (this.pet.balanceEnabled) tools.push({ label: '查看余额', action: 'show-balance' });`,
      new: `    // ${tag('menu-labels')} 菜单指向 CC Switch；余额项改名（现在显示用量+余额）
    const tools = [{ label: '打开 CC Switch', action: 'open-site' }];
    if (this.pet.balanceEnabled) tools.push({ label: '查看用量与余额', action: 'show-balance' });`,
    },
    // ---- 多行气泡用宽框 ----
    {
      id: 'bubble-wide',
      file: path.join(h, 'sprite.js'),
      old: `    this.bubble.classList.toggle(
      'is-whisper',
      // 余额「文字说明」（不可用状态）同样要换行变体：默认 nowrap 会把长文案顶出宠物宽度
      this.workOn || (this.whisperOn && !!this.whisperView) || (this.bubbleOn && this.balanceWrap),
    );`,
      new: `    this.bubble.classList.toggle(
      'is-whisper',
      // 余额「文字说明」（不可用状态）同样要换行变体：默认 nowrap 会把长文案顶出宠物宽度
      this.workOn || (this.whisperOn && !!this.whisperView) || (this.bubbleOn && this.balanceWrap),
    );
    // ${tag('bubble-wide')} 多行用量气泡（≥3 行）强制用更宽的框，否则首行会被挤断
    this.bubble.classList.toggle(
      'is-wide',
      this.bubbleOn && !this.workOn && !this.whisperOn
        && Array.isArray(this.balanceView) && this.balanceView.length >= 3,
    );`,
    },
    // ---- 「打开 CC Switch」 ----
    {
      id: 'open-site',
      file: path.join(h, 'main.js'),
      old: `  ipcMain.on('pet:open-site', (event, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    if (!/^https?:[/][/]/.test(url)) return;
    shell.openExternal(url).catch((error) => {
      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  });`,
      new: `  // ${tag('open-site')} 菜单「打开 CC Switch」：拉起本体（路径由宿主发现后经 CC_SWITCH_EXE 注入）
  const CC_SWITCH_EXE = process.env.CC_SWITCH_EXE || '';
  ipcMain.on('pet:open-site', (event, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    try {
      const { spawn, execFile } = require('node:child_process');
      const { existsSync } = require('node:fs');
      if (CC_SWITCH_EXE && existsSync(CC_SWITCH_EXE)) {
        spawn(CC_SWITCH_EXE, [], { detached: true, stdio: 'ignore' }).unref();
        // CC Switch 是单实例：已在运行时新实例会被吃掉、窗口不一定置前 → 随后主动置前一次
        setTimeout(() => {
          try {
            execFile('powershell.exe', ['-NoProfile', '-Command',
              "$p = Get-Process cc-switch -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; " +
                "if ($p) { Add-Type -Namespace PetX -Name W -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(IntPtr h, int n);'; " +
                '[PetX.W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [PetX.W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }',
            ], { windowsHide: true }, () => {});
          } catch { /* 置前失败无所谓 */ }
        }, 1200);
        return;
      }
    } catch (error) {
      console.error('[dsh-pet-desktop-helper] launch CC Switch failed:', error);
    }
    if (!/^https?:[/][/]/.test(url)) return;
    shell.openExternal(url).catch((error) => {
      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  });`,
    },
    // ---- 气泡 CSS：允许换行 ----
    {
      id: 'css-wrap',
      file: path.join(h, 'index.html'),
      old: `        opacity: 0;
        transition: opacity 0.25s ease;
        white-space: nowrap;
      }`,
      new: `        opacity: 0;
        transition: opacity 0.25s ease;
        /* ${tag('css-wrap')} 原为 nowrap：单行短文案没问题，三行且首行偏长会顶出白框 */
        white-space: normal;
        overflow-wrap: anywhere;
      }`,
    },
    // ---- 气泡 CSS：加宽 ----
    {
      id: 'css-width',
      file: path.join(h, 'index.html'),
      old: `        min-width: calc(var(--pet-size, 462px) * 0.26);
        max-width: calc(var(--pet-size, 462px) * 0.5);`,
      new: `        min-width: calc(var(--pet-size, 462px) * 0.26);
        /* ${tag('css-width')} 原为 0.5：会把「今日 N 亿 token」挤断，放宽 */
        max-width: calc(var(--pet-size, 462px) * 0.62);`,
    },
    // ---- 气泡 CSS：多行宽框规则 ----
    {
      id: 'css-iswide',
      file: path.join(h, 'index.html'),
      old: `      .pet-bub-row {`,
      new: `      /* ${tag('css-iswide')} 多行用量气泡（≥3 行）强制一个够宽的框 */
      .pet-bubble.is-wide {
        min-width: calc(var(--pet-size, 462px) * 0.62);
      }
      .pet-bub-row {`,
    },
    // =========================================================================
    // 养成系统（lib/raise/）：桌宠这边只加"发消息 / 收菜单 / 播指定动画"三件事，
    // 内容全在宿主 —— 菜单里有啥、说什么话、播什么动画都是宿主每秒下发的。
    // =========================================================================
    // ---- 右键菜单：把宿主下发的「养成」整段接在动画树前面 ----
    {
      id: 'raise-menu',
      file: path.join(h, 'sprite.js'),
      old: `    const tree = tools.concat(S.buildMenuTree(this.animations));`,
      new: `    // ${tag('raise-menu')} 养成那一段由宿主下发（内容随宠物状态/背包实时变化）
    const tree = tools.concat(this.raiseMenu || [], S.buildMenuTree(this.animations));`,
    },
    // ---- 菜单点击：raise 开头的叶子交给宿主执行 ----
    {
      id: 'raise-action',
      file: path.join(h, 'sprite.js'),
      old: `  onMenuAction(leaf) {
    this.closeMenu();
    if (!leaf || typeof leaf !== 'object') return;
    if (leaf.action === 'open-site') {`,
      new: `  onMenuAction(leaf) {
    this.closeMenu();
    if (!leaf || typeof leaf !== 'object') return;
    // ${tag('raise-action')} 养成动作：整串发给宿主（use:food:xxx / buy:… / doctor / adopt:GG …）
    if (leaf.raise) {
      this.raiseAct(leaf.raise);
      return;
    }
    if (leaf.action === 'open-site') {`,
    },
    // ---- 养成动作：POST 回宿主；宿主算完经 /broadcast 把结果弹回来 ----
    {
      id: 'raise-act',
      file: path.join(h, 'events.js'),
      old: `PetSprite.prototype.startBroadcastLoop = function startBroadcastLoop() {`,
      new: `// ${tag('raise-act')} 养成菜单点击：把动作串发给宿主，宿主执行完经 /broadcast 回来弹气泡+播动画
PetSprite.prototype.raiseAct = function raiseAct(key) {
  fetch(BASE + '/raise/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: String(key || ''), pet: this.pet.id }),
  }).catch((e) => console.warn('[dsh-pet] 养成动作发送失败', key, e));
};

PetSprite.prototype.startBroadcastLoop = function startBroadcastLoop() {`,
    },
    // ---- 广播通道：顺带接收菜单 + 指定动画（原来只认文本） ----
    {
      id: 'raise-broadcast',
      file: path.join(h, 'events.js'),
      old: `      const d = (await res.json().catch(() => null)) || {};`,
      new: `      const d = (await res.json().catch(() => null)) || {};
      // ${tag('raise-broadcast')} 养成菜单：每秒随广播一起下发（内容变了菜单就跟着变）
      if (Array.isArray(d.menu)) this.raiseMenu = d.menu;`,
    },
    {
      id: 'raise-broadcast-anim',
      file: path.join(h, 'events.js'),
      old: `      this.prevBroadcastTs = ts;
      if (typeof d.text === 'string' && d.text) {
        // image：host 侧抽定/模型选定的配图名（未开配图则 undefined）——与 /whisper 同契约
        this.showWhisper(d.text, typeof d.image === 'string' ? d.image : '');
      }`,
      new: `      this.prevBroadcastTs = ts;
      if (typeof d.text === 'string' && d.text) {
        // image：host 侧抽定/模型选定的配图名（未开配图则 undefined）——与 /whisper 同契约
        // ${tag('raise-broadcast-anim')} anim：养成指定的动画（吃东西/洗澡/生病…），没给就随机抽说话动画
        this.showWhisper(d.text, typeof d.image === 'string' ? d.image : '', typeof d.anim === 'string' ? d.anim : '');
      }`,
    },
    // ---- 成长阶段变化 → 换上新解锁的动画池 ----
    // 不整页重载：重载会把宠物挪回配置的角落（拖到哪儿都白搭）、还会吞掉同一口气泡。
    // 只是重新拉一次配置、把动画池换到 sprite 上 —— 正在播的那段不受影响，位置也不动。
    // 锚点只认上游原文那一行，不依赖别的补丁插了什么
    {
      id: 'raise-reload',
      file: path.join(h, 'events.js'),
      old: `      const ts = typeof d.ts === 'number' ? d.ts : 0;`,
      new: `      // ${tag('raise-reload')} 宿主一直报当前阶段；阶段变了就把新解锁的动画池换上来
      if (typeof d.stage === 'string' && d.stage) {
        const stageChanged = this.raiseStage !== undefined && this.raiseStage !== d.stage;
        this.raiseStage = d.stage;
        if (stageChanged) {
          const cfgUrl = new URLSearchParams(location.search).get('configUrl') || BASE + '/config';
          fetch(cfgUrl)
            .then((r) => (r.ok ? r.json() : null))
            .then((cfg) => {
              const mine = (cfg && (cfg[this.pet.id] || cfg.main)) || (cfg && Object.values(cfg)[0]);
              const anims = (mine && (this.pet.animations || mine.animations)) || null;
              if (anims) {
                this.animations = anims;
                console.info('[dsh-pet] 成长阶段变为「' + d.stage + '」，动画池已更新');
                window.__dshPetDebug.stage = d.stage;
              }
            })
            .catch((e) => console.warn('[dsh-pet] 换动画池失败（下次阶段变化再试）', e));
        }
      }
      const ts = typeof d.ts === 'number' ? d.ts : 0;`,
    },
    // ---- 说话动画可以被指定（原来只能从 events.whisper 池随机抽） ----
    {
      id: 'raise-whisper-anim',
      file: path.join(h, 'events.js'),
      old: `PetSprite.prototype.showWhisper = function showWhisper(text, image) {`,
      new: `// ${tag('raise-whisper-anim')} 多一个 wantAnim：养成可以指定播哪段动画
PetSprite.prototype.showWhisper = function showWhisper(text, image, wantAnim) {`,
    },
    {
      id: 'raise-whisper-pick',
      file: path.join(h, 'events.js'),
      old: `  // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机（与浏览器一致）
  const name = S.pickSlot(S.pick(pool, this.anim), this.anim);`,
      new: `  // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机（与浏览器一致）
  // ${tag('raise-whisper-pick')} 养成指定了动画就用它（先在这一端核对确实存在，避免 404 卡住）
  const known = new Set();
  (function walk(x) {
    if (typeof x === 'string') known.add(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  })(this.animations);
  const name =
    typeof wantAnim === 'string' && wantAnim && known.has(wantAnim)
      ? wantAnim
      : S.pickSlot(S.pick(pool, this.anim), this.anim);`,
    },
    // ---- 多行气泡：养成状态这类带换行的文本逐行渲染（原来只取第一行） ----
    {
      id: 'raise-multiline',
      file: path.join(h, 'sprite.js'),
      old: `      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.whisperView[0]?.text ?? '';
      this.bubble.appendChild(line);
      this.bubble.classList.add('is-on');
      window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
      return;`,
      new: `      // ${tag('raise-multiline')} 养成状态是多行文本（用换行符分行）：逐行渲染，首行正常、其余用小字
      const lines = String(this.whisperView[0]?.text ?? '').split('\\n');
      for (let i = 0; i < lines.length; i++) {
        const line = document.createElement('div');
        line.className = i === 0 ? 'pet-bub-row' : 'pet-bub-row pet-bub-sub';
        line.textContent = lines[i];
        this.bubble.appendChild(line);
      }
      // 行多了用宽框，否则状态条会被挤断
      this.bubble.classList.toggle('is-wide', lines.length >= 3);
      // ${tag('bubble-tall')} 行数超出标准排版的容量就切小一号（CSS 见 index.html 的 .pet-bubble.is-tall）；
      // 有配图时图本身要占六七行，所以门槛降到 4 行
      this.bubble.classList.toggle('is-tall', lines.length >= (whisperImg ? 4 : 9));
      this.bubble.classList.add('is-on');
      window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
      return;`,
    },
    // ---- 气泡 CSS：内容多时切小一号排版（标准字号只装 10 行，小一号能装 13 行） ----
    // 锚在上游原文的 .pet-bubble.is-whisper 规则上，跟别的 CSS 补丁互不依赖
    {
      id: 'css-tall',
      file: path.join(h, 'index.html'),
      old: `      .pet-bubble.is-whisper {
        font-size: calc(var(--pet-size, 462px) * 0.034);
        min-width: calc(var(--pet-size, 462px) * 0.1);
        max-width: calc(var(--pet-size, 462px) * 0.5);
        white-space: normal;
        overflow-wrap: anywhere;
      }`,
      new: `      .pet-bubble.is-whisper {
        font-size: calc(var(--pet-size, 462px) * 0.034);
        min-width: calc(var(--pet-size, 462px) * 0.1);
        max-width: calc(var(--pet-size, 462px) * 0.5);
        white-space: normal;
        overflow-wrap: anywhere;
      }
      /* ${tag('css-tall')} 行多的时候切小一号排版：字号 ×0.85、行高 1.5、内边距收紧。
         与其把内容截掉，不如缩一点 —— 实测标准排版 10 行、这一档 13 行。 */
      .pet-bubble.is-tall {
        font-size: calc(var(--pet-size, 462px) * 0.029);
        line-height: 1.5;
        padding: calc(var(--pet-size, 462px) * 0.015) calc(var(--pet-size, 462px) * 0.024);
      }
      .pet-bubble.is-tall .pet-bub-sub {
        font-size: calc(var(--pet-size, 462px) * 0.029);
      }
      /* ${tag('css-tall')} 配图按**原尺寸**显示，不放大：
         原版的配图是表情包（大图，拉满宽度没问题），但物品图标只有几十像素，
         拉到 157px 又糊又吃掉六七行高度（实测因此把气泡顶出窗口 38px）。
         选择器比上游注入的 .pet-bub-img 多一层，优先级更高，不依赖注入顺序。 */
      .pet-bubble .pet-bub-img {
        width: auto;
        height: auto;
        max-width: calc(var(--pet-size, 462px) * 0.34);
        max-height: calc(var(--pet-size, 462px) * 0.34);
        margin: 0 auto calc(var(--pet-size, 462px) * 0.017);
      }`,
    },
    // ---- 点宠物也算"逗它"（qqpet 的「逗逗我」任务计数）----
    {
      id: 'raise-click',
      file: path.join(h, 'sprite.js'),
      old: `    if (!this.animations.clicks.length) return;
    this.pendingSquash = true; // 等新点击动画切到前台后 Q 弹（压新首帧，与浏览器一致）
    this.playOnce(S.pick(this.animations.clicks));`,
      new: `    if (!this.animations.clicks.length) return;
    // ${tag('raise-click')} 点一下 = 逗它一次（qqpet 的「逗逗我」任务；那边点的是身上的逗乐点位）
    this.raiseAct('pet:click');
    this.pendingSquash = true; // 等新点击动画切到前台后 Q 弹（压新首帧，与浏览器一致）
    this.playOnce(S.pick(this.animations.clicks));`,
    },
  ];
}

/** 对 plugin 目录打补丁；返回统计 */
export function applyPatches({ quiet = false, pluginDir = PLUGIN_DIR } = {}) {
  const say = (...a) => { if (!quiet) console.log(...a); };
  const stat = { applied: 0, skipped: 0, failed: 0, details: [] };
  const byFile = new Map();
  for (const r of rules(pluginDir)) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }

  for (const [file, list] of byFile) {
    const rel = path.relative(pluginDir, file);
    if (!fs.existsSync(file)) {
      say(`  ! 缺文件：${rel}`);
      stat.failed += list.length;
      continue;
    }
    let src = fs.readFileSync(file, 'utf8');
    const before = src;
    const msgs = [];
    for (const r of list) {
      if (src.includes(tag(r.id))) { stat.skipped++; continue; }      // 已打过
      if (!src.includes(r.old)) {
        msgs.push(`跳过 ${r.id}（认不出原文，上游可能改过）`);
        stat.failed++;
        continue;
      }
      src = src.replace(r.old, r.new);
      stat.applied++;
      msgs.push(`已打 ${r.id}`);
    }
    if (src !== before) fs.writeFileSync(file, src);
    say(`  ${rel}${src === before ? '  (无改动)' : '  (已更新)'}`);
    for (const m of msgs) say(`      ${m}`);
    stat.details.push(...msgs);
  }
  return stat;
}

/** 检查补丁是否都在位（只读） */
export function patchesInPlace({ pluginDir = PLUGIN_DIR } = {}) {
  const list = rules(pluginDir);
  const missing = [];
  for (const r of list) {
    if (!fs.existsSync(r.file) || !fs.readFileSync(r.file, 'utf8').includes(tag(r.id))) {
      missing.push(r.id);
    }
  }
  return { ok: list.length - missing.length, total: list.length, missing };
}
