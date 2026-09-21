/**
 * discover.mjs —— 找 CC Switch 本体与它的进程
 *
 * 刻意**不写死安装路径**：CC Switch 升级/重装换目录、换盘符都能自己跟上。
 * 发现顺序（前面的更可靠）：
 *   1. 正在运行的进程的 ExecutablePath      ← 最准，且天然跟版本无关
 *   2. 上次发现并缓存的路径（runtime.json）
 *   3. 注册表卸载项（DisplayIcon / InstallLocation）
 *   4. 常见安装路径
 *   5. 开始菜单 / 桌面快捷方式（解析 .lnk 目标）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRuntime, writeRuntime } from './paths.mjs';

const pExecFile = promisify(execFile);

async function ps(script, timeout = 20_000) {
  const { stdout } = await pExecFile(
    'powershell.exe',
    ['-NoProfile', '-Command', script],
    { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
  );
  return String(stdout || '').trim();
}

const isWin = process.platform === 'win32';

/**
 * 进程名匹配式。默认按名字前缀 + 可执行文件路径匹配（容忍版本改名/换目录）。
 * PET_CC_PROCESS 可**完全接管**匹配条件 —— 主要给测试用：填一个不存在的名字即可模拟
 * 「CC Switch 没在运行」，不必真去关用户的 CC Switch（那会切断它代理的模型请求）。
 */
const procPattern = process.env.PET_CC_PROCESS;

/** 正在运行的 CC Switch 进程；没有则 null。 */
export async function findCcSwitchProcess() {
  if (!isWin) return null;
  const where = procPattern
    ? `$_.Name -like '${procPattern}'`
    : "$_.Name -like 'cc-switch*' -or $_.ExecutablePath -like '*cc-switch*'";
  try {
    const out = await ps(
      `Get-CimInstance Win32_Process | Where-Object { ${where} } | ` +
        'Select-Object -First 1 -Property ProcessId,ExecutablePath | ConvertTo-Json -Compress',
    );
    if (!out) return null;
    const j = JSON.parse(out);
    if (!j || !j.ProcessId) return null;
    return { pid: Number(j.ProcessId), exe: j.ExecutablePath || null };
  } catch {
    return null;
  }
}

const exists = (p) => !!p && fs.existsSync(p);

/** 找到 cc-switch.exe 的绝对路径；找不到返回 null */
export async function findCcSwitchExe({ force = false } = {}) {
  // 1) 运行中
  const proc = await findCcSwitchProcess();
  if (exists(proc?.exe)) {
    writeRuntime({ ccSwitchExe: proc.exe });
    return proc.exe;
  }
  // 2) 缓存
  const cached = readRuntime().ccSwitchExe;
  if (!force && exists(cached)) return cached;

  if (!isWin) return null;

  // 3) 注册表卸载项
  try {
    const out = await ps(
      "$k=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');" +
        "Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'cc.?switch' } | " +
        'Select-Object -First 3 -Property DisplayIcon,InstallLocation,DisplayName | ConvertTo-Json -Compress',
    );
    if (out) {
      for (const e of [].concat(JSON.parse(out))) {
        const icon = String(e.DisplayIcon || '').replace(/,\d+$/, '').replace(/^"|"$/g, '');
        if (exists(icon) && /\.exe$/i.test(icon)) { writeRuntime({ ccSwitchExe: icon }); return icon; }
        const loc = String(e.InstallLocation || '');
        for (const name of ['cc-switch.exe', 'CC Switch.exe']) {
          const p = path.join(loc, name);
          if (exists(p)) { writeRuntime({ ccSwitchExe: p }); return p; }
        }
      }
    }
  } catch { /* 继续 */ }

  // 4) 常见路径
  const guesses = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cc-switch', 'cc-switch.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'cc-switch', 'cc-switch.exe'),
    path.join(process.env.PROGRAMFILES || '', 'CC Switch', 'cc-switch.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'CC Switch', 'cc-switch.exe'),
    'D:\\CC Switch\\cc-switch.exe',
    'C:\\CC Switch\\cc-switch.exe',
  ];
  for (const p of guesses) if (exists(p)) { writeRuntime({ ccSwitchExe: p }); return p; }

  // 5) 快捷方式（覆盖任意安装目录）
  try {
    const out = await ps(
      "$sh=New-Object -ComObject WScript.Shell;" +
        "$dirs=@([Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'));" +
        "$r=@(); foreach($d in $dirs){ Get-ChildItem -Path $d -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'cc.?switch' } | ForEach-Object { $t=$sh.CreateShortcut($_.FullName).TargetPath; if($t){$r+=$t} } };" +
        '$r | Select-Object -First 3 | ConvertTo-Json -Compress',
    );
    if (out) {
      for (const t of [].concat(JSON.parse(out))) {
        if (exists(t) && /\.exe$/i.test(t)) { writeRuntime({ ccSwitchExe: t }); return t; }
      }
    }
  } catch { /* 继续 */ }

  return null;
}
