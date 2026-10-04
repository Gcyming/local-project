




















import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LO_PATH_ENV, looksLikeSoffice, parseVersion, probeSearchList, notFound, consoleVariantOf,
  type LibreOfficeProbe,
} from "../../../core-ts/src/office/libreoffice.js";
import { killProcessTree } from "../../../core-ts/src/procKill.js";


const CONVERT_TIMEOUT_MS = 120_000;

const VERSION_TIMEOUT_MS = 8_000;


export type ConvertResult =
  | { ok: true; pdfPath: string; dir: string; }
  | { ok: false; reason: "no-libreoffice"; error: string; hint: string; }
  | { ok: false; reason: "failed"; error: string; hint: string; };


let cachedProbe: LibreOfficeProbe | null = null;







export async function probeLibreOffice(force = false): Promise<LibreOfficeProbe> {
  if (cachedProbe && !force) { return cachedProbe; }
  const list = probeSearchList(process.platform, process.env);
  for (const cand of list) {
    if (!existsSync(cand)) { continue; }
    const bin = resolveConsoleVariant(cand);
    const v = await runVersion(bin);
    if (v !== null) {
      cachedProbe = { found: true, path: bin, version: v, hint: "" };
      return cachedProbe;
    }
  }
  


  for (const bin of ["soffice", "libreoffice"]) {
    if (!looksLikeSoffice(bin)) { continue; }
    const v = await runVersion(bin);
    if (v !== null) {
      cachedProbe = { found: true, path: bin, version: v, hint: "" };
      return cachedProbe;
    }
  }
  cachedProbe = notFound();
  return cachedProbe;
}

















export function resolveConsoleVariant(p: string): string {
  const com = consoleVariantOf(p);
  if (com && existsSync(com)) { return com; }
  return p;
}








export function shouldSkipVersionProbe(bin: string, platform: string): boolean {
  return platform === "win32" && /\.exe$/i.test(bin);
}


function runVersion(bin: string): Promise<string | null> {
  



  if (activeRunner) {
    return activeRunner(bin, ["--version"], VERSION_TIMEOUT_MS).then((r) => {
      if (!r.ok) { return null; }
      
      return parseVersion(r.stdout) || parseVersion(r.stderr) || null;
    });
  }
  

  if (shouldSkipVersionProbe(bin, process.platform)) { return Promise.resolve(null); }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = execFile(bin, ["--version"], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 256 },
        (err, stdout) => {
          if (err) { finish(null); return; }
          


          const v = parseVersion(String(stdout ?? ""));
          finish(v || null);
        });
    } catch { finish(null); return; }
    


    let errBuf = "";
    child.stderr?.on("data", (d: Buffer) => { errBuf += String(d); });
    child.on("exit", () => {
      setTimeout(() => {
        if (errBuf) {
          const v = parseVersion(errBuf);
          if (v) { finish(v); }
        }
      }, 0);
    });
  });
}














export type ConvertRunner = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string; stderr: string; error: string }>;


let activeRunner: ConvertRunner | null = null;


export function setConvertRunner(r: ConvertRunner | null): void {
  activeRunner = r;
}












export function buildConvertArgs(profileDir: string, outDir: string, srcAbs: string): string[] {
  return [
    "--headless",
    "--norestore",       
    "--nologo",          
    "--nodefault",       
    "--nolockcheck",     
    "--nofirststartwizard",
    "-env:UserInstallation=" + pathToFileURL(profileDir).href,
    "--convert-to", "pdf",
    "--outdir", outDir,
    srcAbs,
  ];
}










async function convertToPdfInner(srcAbs: string): Promise<ConvertResult> {
  if (!existsSync(srcAbs)) {
    return { ok: false, reason: "failed", error: `文件不存在：${srcAbs}`, hint: "" };
  }
  const probe = await probeLibreOffice();
  if (!probe.found) {
    return { ok: false, reason: "no-libreoffice", error: probe.hint, hint: probe.hint };
  }

  

  let dir: string;
  try {
    dir = mkdtempSyncCompat();
  } catch (e) {
    return { ok: false, reason: "failed", error: `创建临时目录失败：${String((e as Error)?.message ?? e)}`, hint: "" };
  }
  








  const profileDir = sharedProfileDir();
  try { mkdirSync(profileDir, { recursive: true }); } catch {  }

  const args = buildConvertArgs(profileDir, dir, srcAbs);

  const run = await (activeRunner ?? spawnCapture)(probe.path, args, CONVERT_TIMEOUT_MS);
  if (!run.ok) {
    cleanupConvertDir(dir);
    return { ok: false, reason: "failed", error: run.error, hint: "" };
  }

  


  const pdf = findProducedPdf(dir, srcAbs);
  if (!pdf) {
    const detail = (run.stdout + run.stderr).trim().slice(0, 400);
    cleanupConvertDir(dir);
    return {
      ok: false, reason: "failed",
      error: `转换没有产出 PDF。${detail ? "\n" + detail : ""}`,
      hint: "",
    };
  }
  return { ok: true, pdfPath: pdf, dir };
}


export async function convertToPdf(srcAbs: string): Promise<ConvertResult> {
  return serializeConvert(() => convertToPdfInner(srcAbs));
}


function findProducedPdf(dir: string, srcAbs: string): string | null {
  const want = basename(srcAbs).replace(/\.[^.]+$/, "").toLowerCase() + ".pdf";
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return null; }
  
  for (const n of names) {
    if (n.toLowerCase() === want) {
      const p = join(dir, n);
      try { if (statSync(p).isFile() && statSync(p).size > 0) { return p; } } catch {  }
    }
  }
  
  for (const n of names) {
    if (n.toLowerCase().endsWith(".pdf")) {
      const p = join(dir, n);
      try { if (statSync(p).isFile() && statSync(p).size > 0) { return p; } } catch {  }
    }
  }
  return null;
}


export function cleanupConvertDir(dir: string): void {
  if (!dir) { return; }
  try { rmSync(dir, { recursive: true, force: true }); } catch {  }
}


function mkdtempSyncCompat(): string {
  


  return mkdtempSync(join(tmpdir(), "slime-lo-"));
}








function sharedProfileDir(): string {
  return join(tmpdir(), "slime-lo-profile");
}









let convertChain: Promise<unknown> = Promise.resolve();
function serializeConvert<T>(job: () => Promise<T>): Promise<T> {
  const run = convertChain.then(job, job);
  convertChain = run.then(() => undefined, () => undefined);
  return run;
}


export const LIBREOFFICE_ENV_KEYS = LO_PATH_ENV;


function spawnCapture(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; error: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (r: { ok: boolean; stdout: string; stderr: string; error: string }): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, stdout: "", stderr: "", error: `无法启动 ${bin}：${String((e as Error)?.message ?? e)}` });
      return;
    }
    





    const killTree = (): void => {
      killProcessTree(child.pid, { onDone: () => {  } });
      try { child.kill("SIGTERM"); } catch {  }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {  } }, 1500);
    };
    const timer = setTimeout(() => {
      killTree();
      finish({ ok: false, stdout: out, stderr: err, error: `转换超时（${Math.round(timeoutMs / 1000)} 秒未完成），已终止。` });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { out += String(d); });
    child.stderr?.on("data", (d: Buffer) => { err += String(d); });
    child.on("error", (e: Error) => {
      finish({ ok: false, stdout: out, stderr: err, error: `调用 ${bin} 失败：${e.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) { finish({ ok: true, stdout: out, stderr: err, error: "" }); return; }
      finish({ ok: false, stdout: out, stderr: err, error: `LibreOffice 退出码 ${code}。${(err || out).trim().slice(0, 300)}` });
    });
  });
}
