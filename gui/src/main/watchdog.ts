











import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_ROOT } from "./boot.js";


const LAG_WARN_MS = 2000;
const TICK_MS = 1000;

const ACTIVITY_KEEP = 24;

let timer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
let lagTick = 0;
const activity: string[] = [];


export function markMainActivity(label: string): void {
  activity.push(`${new Date().toISOString()} ${label}`);
  if (activity.length > ACTIVITY_KEEP) { activity.shift(); }
}


function persist(line: string): void {
  try {
    appendFileSync(join(INSTALL_ROOT, "data", "watchdog.log"), `${line}\n`, "utf8");
  } catch {  }
}

export function startMainWatchdog(): void {
  if (timer) { return; }
  lastTick = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - TICK_MS;
    lastTick = now;
    if (lag < LAG_WARN_MS) { return; }
    
    if (now - lagTick < LAG_WARN_MS * 2) { return; }
    lagTick = now;
    const secs = Math.round(lag / 1000);
    const line = `[watchdog] ${new Date(now).toISOString()} 主进程事件循环被独占约 ${secs}s`
      + ` —— 期间渲染层 IPC 全部排队（用户观感：界面点按钮没反应）。最近活动：\n`
      + activity.map((a) => `    ${a}`).join("\n");
    console.warn(line);
    persist(line);
  }, TICK_MS);
  timer.unref?.(); 
}

export function stopMainWatchdog(): void {
  if (!timer) { return; }
  clearInterval(timer);
  timer = null;
}
