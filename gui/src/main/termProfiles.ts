/**
 * gui/src/main/termProfiles.ts — 内置终端的 **shell 探测**（唯一 IO 产地）。
 *
 * 判据（"这个 shell 各自怎么调"）在 `core-ts/src/terminal/profiles.ts`（纯函数、可单测）；
 * 本文件只做**本机 IO**：文件在不在、PATH 里有没有、WSL 里装了哪些发行版。
 *
 * ## 两条纪律
 *  1. **缓存 Promise，不缓存结果**：`wsl -l -q` 要起一个进程，而渲染层每次打开终端页都会问一次。
 *     缓存 Promise ⇒ 并发两次请求也只会起一个探测进程（缓存结果则会漏掉并发那一路）。
 *  2. **绝不阻塞主进程**：所有探测都是异步的（`execFile` 而不是 `execFileSync`）。
 *     VS 的 `vswhere` 最坏要几秒 —— 同步跑会把整个界面冻住，而用户只是"打开了终端页"。
 *
 * ⚠️ 探测**不做任何假设**：文件不存在就不列出。宁可少一条，也不要列出一条点了报错的
 * （用户对"终端"这个功能的容忍度很低 —— 它是救急用的）。
 */
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

import { orderProfiles, type TermProfile } from "../../../core-ts/src/terminal/profiles.js";

/** 在 PATH 里找一个可执行文件，返回绝对路径（找不到 ⇒ `null`）。 */
export function whichInPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const dirs = (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, name + ext);
      try { if (existsSync(p)) { return p; } } catch { /* 忽略不可读目录 */ }
    }
  }
  return null;
}

/** 跑一个进程并取 stdout 文本（失败 ⇒ `null`，**不抛**：探测的失败是常态）。 */
function execText(file: string, args: string[], timeout = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: "buffer", timeout, windowsHide: true }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
        resolve(raw.toString("utf8"));
      });
    } catch { resolve(null); }
  });
}

/** Windows 上所有候选 shell（只返回**真实存在**的那些）。 */
export async function detectWindows(env: NodeJS.ProcessEnv = process.env): Promise<TermProfile[]> {
  const out: TermProfile[] = [];
  const root = env.SystemRoot ?? "C:\\Windows";
  const has = (p: string | undefined): p is string => !!p && existsSync(p);

  const pwsh = whichInPath("pwsh", env)
    ?? ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe"].find(has)
    ?? null;
  if (pwsh) { out.push({ id: "pwsh", label: "PowerShell 7", kind: "pwsh", file: pwsh, detail: "pwsh" }); }

  const ps5 = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (has(ps5)) { out.push({ id: "powershell", label: "Windows PowerShell", kind: "powershell", file: ps5, detail: "系统自带" }); }

  const cmd = has(env.ComSpec) ? env.ComSpec : join(root, "System32", "cmd.exe");
  if (has(cmd)) { out.push({ id: "cmd", label: "命令提示符", kind: "cmd", file: cmd, detail: "系统自带" }); }

  const wsl = join(root, "System32", "wsl.exe");
  if (has(wsl)) { out.push({ id: "wsl", label: "WSL", kind: "wsl", file: wsl, detail: "默认发行版" }); }

  /* Visual Studio 开发者提示符：用 vswhere 找到安装路径再拼脚本路径。
     写死 `C:\Program Files\...` 会在改安装盘符 / 多个 VS 版本共存时**静默失效**
     （条目直接不出现在下拉里，用户以为"slime 不支持 VS 终端"）。 */
  const vswhere = join(
    env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio", "Installer", "vswhere.exe",
  );
  let vsRoot: string | null = null;
  if (has(vswhere)) {
    const r = await execText(vswhere, ["-latest", "-property", "installationPath"], 8000);
    const p = (r ?? "").trim();
    if (p) { vsRoot = p; }
  }
  if (vsRoot) {
    const devCmd = join(vsRoot, "Common7", "Tools", "VsDevCmd.bat");
    if (has(devCmd)) {
      out.push({ id: "vsdevcmd", label: "Developer Command Prompt for VS", kind: "vsdevcmd", file: cmd, detail: "Visual Studio", setup: devCmd });
    }
    const devPs = join(vsRoot, "Common7", "Tools", "Launch-VsDevShell.ps1");
    if (has(devPs)) {
      const host = has(ps5) ? ps5 : pwsh;
      if (host) { out.push({ id: "vspwsh", label: "Developer PowerShell for VS", kind: "vspwsh", file: host, detail: "Visual Studio", setup: devPs }); }
    }
  }

  const localGit = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe") : "";
  const gitBash = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    localGit,
    whichInPath("bash", env) ?? "",
  ].find(has);
  if (gitBash) { out.push({ id: "gitbash", label: "Git Bash", kind: "bash", file: gitBash, detail: "Git for Windows" }); }

  return out;
}

/** POSIX 上的候选 shell。 */
export function detectPosix(): TermProfile[] {
  const out: TermProfile[] = [];
  const has = (p: string | undefined): p is string => !!p && existsSync(p);
  const bash = ["/bin/bash", "/usr/bin/bash", whichInPath("bash") ?? ""].find(has);
  if (bash) { out.push({ id: "bash", label: "bash", kind: "bash", file: bash }); }
  const sh = ["/bin/sh", "/usr/bin/sh"].find(has);
  if (sh) { out.push({ id: "sh", label: "sh", kind: "sh", file: sh }); }
  return out;
}

/**
 * `wsl -l -q` 的原始字节 → 文本（**纯函数**，可被守卫直接断言 —— 不必真装 WSL）。
 *
 * ⚠️⚠️ 这条命令的输出是 **UTF-16LE**（Windows 上的已知怪癖）。按 utf8 解会得到
 * `U\0b\0u\0n\0t\0u\0` 这种夹空字节的串 —— 而它**看起来像**一个合法的发行版名
 * （不报错、不抛异常），于是下拉里会多一条**永远连不上**的假条目。
 * BOM（`FF FE`）优先；没有 BOM 时看第 2 个字节是不是 0（ASCII 发行版名的 UTF-16LE 特征）。
 */
export function decodeWslListOutput(raw: Uint8Array): string {
  const b = raw ?? new Uint8Array(0);
  const isUtf16 = (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe)
    || (b.length >= 2 && b[1] === 0);
  return isUtf16 ? new TextDecoder("utf-16le").decode(b) : new TextDecoder("utf-8").decode(b);
}

/** 文本 → 发行版名数组（纯函数）。去掉空行与 `*`（默认发行版前缀）。 */
export function parseWslList(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.replace(/\u0000/g, "").replace(/^\*/, "").trim())
    .filter(Boolean);
}

/** 起一次 `wsl -l -q` 拿发行版名（失败 ⇒ 空数组，**不抛**：没装发行版是正常情况）。 */
export async function listWslDistros(wslExe: string): Promise<string[]> {
  const text = await new Promise<string | null>((resolve) => {
    try {
      execFile(wslExe, ["-l", "-q"], { encoding: "buffer", timeout: 6000, windowsHide: true }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
        resolve(decodeWslListOutput(raw));
      });
    } catch { resolve(null); }
  });
  return text === null ? [] : parseWslList(text);
}

/** 探测全部可用 shell（**有序**）。 */
export async function detectTermProfiles(): Promise<TermProfile[]> {
  if (process.platform !== "win32") { return orderProfiles(detectPosix()); }

  const base = await detectWindows();
  const wslEntry = base.find((p) => p.kind === "wsl");
  if (!wslEntry) { return orderProfiles(base); }

  const distros = await listWslDistros(wslEntry.file);
  const withoutWsl = base.filter((p) => p.kind !== "wsl");
  if (distros.length === 0) {
    /* 有 wsl.exe 但一个发行版都没装 ⇒ 仍保留条目，但 `detail` 要说清楚 ——
       否则它看起来像"这儿能开一个 Ubuntu"，点了却报错。 */
    return orderProfiles([...withoutWsl, { ...wslEntry, detail: "未安装发行版" }]);
  }
  const expanded: TermProfile[] = distros.map((d) => ({
    id: `wsl:${d}`, label: d, kind: "wsl", file: wslEntry.file, distro: d, detail: "WSL",
  }));
  return orderProfiles([...withoutWsl, ...expanded]);
}

/** 探测缓存（缓存 **Promise**：并发两次也只起一个探测进程）。 */
let cache: Promise<TermProfile[]> | null = null;

export function getTermProfiles(): Promise<TermProfile[]> {
  if (!cache) { cache = detectTermProfiles().catch(() => [] as TermProfile[]); }
  return cache;
}

/** 仅供测试：清掉缓存。 */
export function __resetTermProfileCache(): void { cache = null; }
