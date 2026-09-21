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
