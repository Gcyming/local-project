

























import { spawn } from "node:child_process";


export function taskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}





export function needsTreeKill(platform: string): boolean {
  return platform === "win32";
}








export function killProcessTree(
  pid: number | undefined,
  opts: { platform?: string; onDone?: () => void } = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (!needsTreeKill(platform) || typeof pid !== "number") { opts.onDone?.(); return; }
  try {
    const killer = spawn("taskkill", taskkillArgs(pid), { windowsHide: true, stdio: "ignore" });
    
    killer.on("error", () => { opts.onDone?.(); });
    killer.on("close", () => { opts.onDone?.(); });
  } catch {
    opts.onDone?.();
  }
}
