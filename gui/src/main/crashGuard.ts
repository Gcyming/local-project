





















import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_ROOT } from "./boot.js";

const DATA_DIR = join(INSTALL_ROOT, "data");
const LOCK_PATH = join(DATA_DIR, "run.lock");
const REPORT_PATH = join(DATA_DIR, "crash-report.log");
const WATCHDOG_PATH = join(DATA_DIR, "watchdog.log");

const STALE_TMP_MS = 60_000;

const FORENSIC_KEEP_MS = 30 * 24 * 3600 * 1000;












const DEAD_FILE_MS = 24 * 3600 * 1000;

export interface CrashSweepResult {
  
  abnormalExit: boolean;
  
  previous?: { pid?: number; startedAt?: string; version?: string };
  
  removedTmp: number;
  
  removedForensics: number;
  
  removedDead: number;
}

function appendReport(lines: string[]): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(REPORT_PATH, `${lines.join("\n")}\n`, "utf8");
  } catch {  }
}


function readPreviousLock(): { pid?: number; startedAt?: string; version?: string } | undefined {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as { pid?: number; startedAt?: string; version?: string };
  } catch {
    return undefined;
  }
}


function watchdogTail(maxLines = 6): string[] {
  try {
    const all = readFileSync(WATCHDOG_PATH, "utf8").trim().split("\n");
    return all.slice(-maxLines);
  } catch {
    return [];
  }
}





export function sweepAfterCrash(): CrashSweepResult {
  const result: CrashSweepResult = { abnormalExit: false, removedTmp: 0, removedForensics: 0, removedDead: 0 };
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch {  }

  
  if (existsSync(LOCK_PATH)) {
    result.abnormalExit = true;
    result.previous = readPreviousLock();
  }

  
  try {
    const now = Date.now();
    for (const name of readdirSync(DATA_DIR)) {
      const p = join(DATA_DIR, name);
      let size = -1;
      let age = 0;
      try { const st = statSync(p); size = st.size; age = now - st.mtimeMs; } catch { continue; }
      if (name.endsWith(".tmp") && age > STALE_TMP_MS) {
        try { unlinkSync(p); result.removedTmp += 1; } catch {  }
      } else if ((name.endsWith(".bak") || name.endsWith(".corrupt")) && age > FORENSIC_KEEP_MS) {
        try { unlinkSync(p); result.removedForensics += 1; } catch {  }
      } else if (size === 0 && age > DEAD_FILE_MS) {
        
        if (name === "run.lock") { continue; }
        try { unlinkSync(p); result.removedDead += 1; } catch {  }
      }
    }
  } catch {  }

  
  if (result.abnormalExit) {
    const prev = result.previous;
    appendReport([
      "",
      `[crashGuard] ${new Date().toISOString()} 检测到**上次异常退出**（data/run.lock 未被清理）`,
      `  上次进程：pid=${prev?.pid ?? "?"} 启动于 ${prev?.startedAt ?? "?"} 版本 ${prev?.version ?? "?"}`,
      `  本次清障：残留临时文件 ${result.removedTmp} 个、陈旧留证 ${result.removedForensics} 个、0 字节死文件 ${result.removedDead} 个`,
      `  ⚠️ 若上方 watchdog 日志非空，说明崩溃前先发生过主进程卡死（看门狗抓到了）`,
      ...watchdogTail().map((l) => `  | ${l}`),
    ]);
  }
  return result;
}


export function markRunning(version: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LOCK_PATH, JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), version,
    }, null, 2), "utf8");
  } catch {  }
}


export function markCleanExit(): void {
  try { rmSync(LOCK_PATH, { force: true }); } catch {  }
}
