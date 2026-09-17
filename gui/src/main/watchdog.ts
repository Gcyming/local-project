/**
 * gui/src/main/watchdog.ts — 主进程事件循环卡死看门狗（A-984）。
 *
 * 为什么需要它：用户实测过一次「slime 卡住、点按钮没反应」，事后**无法归因** ——
 * 唯一留下的线索是 `data/audit.jsonl` 在那一刻**停止写入**，反推出"主进程事件循环被长时间独占、
 * 渲染层的 IPC 全部排队"。但那是"我们猜出来的"，不是"日志告诉我们的"：
 * 没有堆栈、没有时间点、没有当时在跑什么。
 *
 * 这个探针只做一件事：每秒打一次拍，发现两拍间隔异常就报**卡了多久 + 最近的活动标记**。
 * 它不试图修复卡顿（那得先知道卡在哪），只负责把"下一次卡顿"变成一条可查的日志。
 * 开销：一次 `Date.now()` + 一次减法，可忽略；`unref()` 保证它不会阻止进程退出。
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_ROOT } from "./boot.js";

/** 掉拍超过这个值才算"被独占"（正常 GC/大渲染会有百毫秒级抖动，别误报） */
const LAG_WARN_MS = 2000;
const TICK_MS = 1000;
/** 活动标记环形缓冲：卡顿时用它还原"当时在干什么" */
const ACTIVITY_KEEP = 24;

let timer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
let lagTick = 0;
const activity: string[] = [];

/** 供各处埋点：记录"此刻在做什么"（纯内存 push，开销可忽略） */
export function markMainActivity(label: string): void {
  activity.push(`${new Date().toISOString()} ${label}`);
  if (activity.length > ACTIVITY_KEEP) { activity.shift(); }
}

/** 落一份到磁盘：终端日志在打包后看不到，而卡死现场必须能事后回看 */
function persist(line: string): void {
  try {
    appendFileSync(join(INSTALL_ROOT, "data", "watchdog.log"), `${line}\n`, "utf8");
  } catch { /* 落盘失败不影响主流程 */ }
}

export function startMainWatchdog(): void {
  if (timer) { return; }
  lastTick = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - TICK_MS;
    lastTick = now;
    if (lag < LAG_WARN_MS) { return; }
    // 二次确认：连续两拍都掉，排除"单次调度抖动"
    if (now - lagTick < LAG_WARN_MS * 2) { return; }
    lagTick = now;
    const secs = Math.round(lag / 1000);
    const line = `[watchdog] ${new Date(now).toISOString()} 主进程事件循环被独占约 ${secs}s`
      + ` —— 期间渲染层 IPC 全部排队（用户观感：界面点按钮没反应）。最近活动：\n`
      + activity.map((a) => `    ${a}`).join("\n");
    console.warn(line);
    persist(line);
  }, TICK_MS);
  timer.unref?.(); // 不阻止进程退出
}

export function stopMainWatchdog(): void {
  if (!timer) { return; }
  clearInterval(timer);
  timer = null;
}
