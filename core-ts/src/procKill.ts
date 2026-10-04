/**
 * core-ts/src/procKill.ts — 「杀掉一个**进程树**」的**唯一产地**（Windows 需要 `taskkill /T`）。
 *
 * ## 为什么必须住在 core-ts，而不是 `gui/src/main`
 * 仓库既有的架构规则（守卫 `tests/core-ts/a1023-guards.spec.ts`）：
 * **GUI 主进程不得出现 `taskkill`** —— 进程树回收属于**运行时内部事务**。
 * 这条规则不是形式主义：GUI 主进程是 Electron 的 UI 宿主，进程管理一旦散进去，
 * 「谁负责回收」就会有 N 个产地（铁律 11）—— llama-server 的回收此前正是踩过这个坑。
 * ⇒ 2026-09-30 给 LibreOffice 转换加超时杀树时，**没有**在 `libreofficeConvert.ts` 里就地写
 *    `taskkill`（那样会被上面那条守卫正确地拦下），而是把能力收到这里。
 *
 * ## 为什么需要"杀树"这件事本身
 * Windows 上 `child.kill()` **只终止那一个进程**。而不少外部工具会再拉起真正干活的子进程：
 *   · LibreOffice：`soffice.com` → `soffice.bin`
 *   · uvx/npx：包装器 → 孙进程
 * ⇒ 只杀启动器会留下**孤儿进程**（实测：挂死的 `.exe` 探测会在任务管理器里越积越多）。
 * 正解 = `taskkill /PID <pid> /T /F`（`/T` = 含子进程，`/F` = 强制）。
 *
 * ## 与 `mcp.ts` / `model_server.ts` 里那两处的关系（**别急着合并**）
 * 它们各自**多一道安全前置**，与本模块的取舍不同：
 *   · `model_server.ts`：taskkill 前**校验命令行含 llama-server**（防 PID 复用误杀）；
 *   · `mcp.ts`：同样的树杀，但混在它自己的子进程生命周期里。
 * 本模块服务的是「**我刚 spawn、且持有 ChildProcess 句柄**」的场景 —— PID 一定是我自己的，
 * 不存在 PID 复用风险，所以不做命令行校验。**把它们合并是后续的事**（需要先确认那道校验
 * 在新调用方里仍成立，否则会削弱 model_server 的保护）。
 */
import { spawn } from "node:child_process";

/** `taskkill` 的参数（**纯函数**，便于守卫核对"该带的都在"，不用真起进程）。 */
export function taskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

/**
 * 这个平台是否**必须**走 `taskkill` 才能杀掉整棵树（**纯函数**）。
 * Unix 上 `child.kill()` 配合进程组即可，不需要也不该调 `taskkill`。
 */
export function needsTreeKill(platform: string): boolean {
  return platform === "win32";
}

/**
 * 异步杀掉进程树 —— **绝不阻塞事件循环**（铁律 26：`spawnSync` 会把 Electron 主进程卡死）。
 *
 * ⚠️ **尽最大努力、不抛异常**：`taskkill` 不存在或调用失败都只是尽力而为 ——
 *    调用方通常还有 `child.kill()` 兜底，不该因为清理失败把主流程打挂。
 * ⚠️ 非 Windows 平台**直接返回**（`onDone` 仍会回调，调用方逻辑不必分平台）。
 */
export function killProcessTree(
  pid: number | undefined,
  opts: { platform?: string; onDone?: () => void } = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (!needsTreeKill(platform) || typeof pid !== "number") { opts.onDone?.(); return; }
  try {
    const killer = spawn("taskkill", taskkillArgs(pid), { windowsHide: true, stdio: "ignore" });
    /* ⚠️ 必须挂 `error` 监听：没有它，spawn 失败会抛成**未捕获异常**（把主进程带崩）。 */
    killer.on("error", () => { opts.onDone?.(); });
    killer.on("close", () => { opts.onDone?.(); });
  } catch {
    opts.onDone?.();
  }
}
