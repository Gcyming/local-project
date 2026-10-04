














import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

import { orderProfiles, type TermProfile } from "../../../core-ts/src/terminal/profiles.js";


export function whichInPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const dirs = (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, name + ext);
      try { if (existsSync(p)) { return p; } } catch {  }
    }
  }
  return null;
}


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


export function detectPosix(): TermProfile[] {
  const out: TermProfile[] = [];
  const has = (p: string | undefined): p is string => !!p && existsSync(p);
  const bash = ["/bin/bash", "/usr/bin/bash", whichInPath("bash") ?? ""].find(has);
  if (bash) { out.push({ id: "bash", label: "bash", kind: "bash", file: bash }); }
  const sh = ["/bin/sh", "/usr/bin/sh"].find(has);
  if (sh) { out.push({ id: "sh", label: "sh", kind: "sh", file: sh }); }
  return out;
}









export function decodeWslListOutput(raw: Uint8Array): string {
  const b = raw ?? new Uint8Array(0);
  const isUtf16 = (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe)
    || (b.length >= 2 && b[1] === 0);
  return isUtf16 ? new TextDecoder("utf-16le").decode(b) : new TextDecoder("utf-8").decode(b);
}


export function parseWslList(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.replace(/\u0000/g, "").replace(/^\*/, "").trim())
    .filter(Boolean);
}


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


export async function detectTermProfiles(): Promise<TermProfile[]> {
  if (process.platform !== "win32") { return orderProfiles(detectPosix()); }

  const base = await detectWindows();
  const wslEntry = base.find((p) => p.kind === "wsl");
  if (!wslEntry) { return orderProfiles(base); }

  const distros = await listWslDistros(wslEntry.file);
  const withoutWsl = base.filter((p) => p.kind !== "wsl");
  if (distros.length === 0) {
    

    return orderProfiles([...withoutWsl, { ...wslEntry, detail: "未安装发行版" }]);
  }
  const expanded: TermProfile[] = distros.map((d) => ({
    id: `wsl:${d}`, label: d, kind: "wsl", file: wslEntry.file, distro: d, detail: "WSL",
  }));
  return orderProfiles([...withoutWsl, ...expanded]);
}


let cache: Promise<TermProfile[]> | null = null;

export function getTermProfiles(): Promise<TermProfile[]> {
  if (!cache) { cache = detectTermProfiles().catch(() => [] as TermProfile[]); }
  return cache;
}


export function __resetTermProfileCache(): void { cache = null; }
