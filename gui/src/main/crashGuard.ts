/**
 * gui/src/main/crashGuard.ts — 意外退出的保底应急（A-986）。
 *
 * 起因：用户实测 App 卡死 → 任务管理器强杀 → 重启后（a）待办里那一项永远停在「进行中」、
 * （b）列表出现"莫须有的任务"、勾选也没反应。根子都在"没做意外情况防护"：
 * `in_progress` 落盘后没人收回、写入不是原子操作（崩溃可能留半个 JSON）、
 * 崩溃现场没有任何记录可供事后归因。
 *
 * 本模块只做**与业务无关的通用保底**，三件事：
 *   ① **运行标记**：启动时写 `data/run.lock`（含 pid / 启动时间 / 版本），正常退出时删除。
 *      下次启动若发现它还在 → **上次是异常退出**，据此写一份崩溃报告并触发清障。
 *   ② **清障**：删掉残留的 `*.tmp`（原子写留下的半成品）、以及过期太久的 `.bak`/`.corrupt` 留证文件。
 *   ③ **留证**：把"上次异常退出 + 看门狗尾巴 + 清障做了什么"追加进 `data/crash-report.log`。
 *
 * 为什么用"脏标记"而不是等崩溃处理器：Electron 里 `process.on('exit')` 在强杀（SIGKILL /
 * 任务管理器结束进程）时**根本不会被调用**，app 级 crashReporter 也只覆盖渲染进程崩溃。
 * "正常退出时主动删标记"是唯一在强杀下仍然成立的判据 —— 这也是业界通行做法
 * （SQLite 的 hot journal、Chrome 的 `exited_cleanly` 属性、systemd 的 service 状态文件同理）。
 *
 * 与 `watchdog.ts` 的分工：watchdog 负责**卡顿当下**（事件循环被独占多久、当时在跑什么），
 * crashGuard 负责**重启之后**（上次是不是异常退出、要清什么、留下什么证据）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_ROOT } from "./boot.js";

const DATA_DIR = join(INSTALL_ROOT, "data");
const LOCK_PATH = join(DATA_DIR, "run.lock");
const REPORT_PATH = join(DATA_DIR, "crash-report.log");
const WATCHDOG_PATH = join(DATA_DIR, "watchdog.log");
/** 残留临时文件的存活上限：超过这个年龄的 *.tmp 一定是上次崩溃留下的（正常写入生命周期是毫秒级） */
const STALE_TMP_MS = 60_000;
/** 留证文件（.bak / .corrupt）保留时长，避免 data/ 无限堆积 */
const FORENSIC_KEEP_MS = 30 * 24 * 3600 * 1000;
/**
 * **死文件**：0 字节且 24h 没动过的残留物（A-987）。
 *
 * 判据为什么是"0 字节 + 够老"而不是看文件名：0 字节文件承载不了任何可恢复信息，
 * 而 24h 的静默期把"刚落盘、还没写内容"的瞬时窗口排除在外 —— 用户能看到的所有
 * 操作痕迹（会话记录、待办、产物）都可能涉及它，所以只删**确证无用**的那一类。
 *
 * 现实来源：NTFS 把 `xxx:yyy` 当**备用数据流**（见 todoStore.encodeSessionId 的长注释）——
 * `fs.writeFileSync("data/todos___subagent__:run123.json", …)` 不报错，却在 data/ 里
 * 留下一个 0 字节的 `todos___subagent__`，而任何代码路径都读不到它（用户截图上看到的
 * "不存在的任务"残留物就是它）。会话 id 侧已从源头修掉，这里再兜一层，兼容历史遗留。
 */
const DEAD_FILE_MS = 24 * 3600 * 1000;

export interface CrashSweepResult {
  /** 上次是否异常退出（run.lock 残留） */
  abnormalExit: boolean;
  /** 上次运行的元信息（能读到多少算多少） */
  previous?: { pid?: number; startedAt?: string; version?: string };
  /** 清掉的临时文件数 */
  removedTmp: number;
  /** 清掉的陈旧留证文件数 */
  removedForensics: number;
  /** 清掉的 0 字节死文件数 */
  removedDead: number;
}

function appendReport(lines: string[]): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(REPORT_PATH, `${lines.join("\n")}\n`, "utf8");
  } catch { /* 留证失败不影响主流程 */ }
}

/** 读上一次的 run.lock（尽力而为，读不出来就当只有"存在"这一条信息） */
function readPreviousLock(): { pid?: number; startedAt?: string; version?: string } | undefined {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as { pid?: number; startedAt?: string; version?: string };
  } catch {
    return undefined;
  }
}

/** 看门狗日志尾巴（有的话）——崩溃前是不是先卡死过，一眼可见 */
function watchdogTail(maxLines = 6): string[] {
  try {
    const all = readFileSync(WATCHDOG_PATH, "utf8").trim().split("\n");
    return all.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * 启动时调用（**必须在写新的 run.lock 之前**）：判定上次是否异常退出 + 清障。
 * 幂等、绝不抛：任何一步失败都不应阻止 App 起来。
 */
export function sweepAfterCrash(): CrashSweepResult {
  const result: CrashSweepResult = { abnormalExit: false, removedTmp: 0, removedForensics: 0, removedDead: 0 };
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 忽略 */ }

  // ① 上次异常退出的判定：run.lock 还在 = 没走到"正常退出删标记"那一步
  if (existsSync(LOCK_PATH)) {
    result.abnormalExit = true;
    result.previous = readPreviousLock();
  }

  // ② 清障：残留 *.tmp（原子写的半成品）+ 过期的 .bak/.corrupt 留证 + 0 字节死文件
  try {
    const now = Date.now();
    for (const name of readdirSync(DATA_DIR)) {
      const p = join(DATA_DIR, name);
      let size = -1;
      let age = 0;
      try { const st = statSync(p); size = st.size; age = now - st.mtimeMs; } catch { continue; }
      if (name.endsWith(".tmp") && age > STALE_TMP_MS) {
        try { unlinkSync(p); result.removedTmp += 1; } catch { /* 占用中则下次再说 */ }
      } else if ((name.endsWith(".bak") || name.endsWith(".corrupt")) && age > FORENSIC_KEEP_MS) {
        try { unlinkSync(p); result.removedForensics += 1; } catch { /* 忽略 */ }
      } else if (size === 0 && age > DEAD_FILE_MS) {
        // run.lock 是"上次跑着"的活判据，正被本进程复查 → 不碰（崩溃报告也要读它）
        if (name === "run.lock") { continue; }
        try { unlinkSync(p); result.removedDead += 1; } catch { /* 忽略 */ }
      }
    }
  } catch { /* 清理失败不影响启动 */ }

  // ③ 留证：这次判定 + 看门狗尾巴 + 清障结果
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

/** 启动完成、确认可用之后调用：写下本次的运行标记（下次启动靠残留与否判定异常退出） */
export function markRunning(version: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LOCK_PATH, JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), version,
    }, null, 2), "utf8");
  } catch { /* 写不进标记不致命，只是失去了这次的崩溃判定 */ }
}

/** 正常退出时调用（`will-quit`）：删掉运行标记。强杀时不会被调用 —— 这正是判据本身 */
export function markCleanExit(): void {
  try { rmSync(LOCK_PATH, { force: true }); } catch { /* 忽略 */ }
}
