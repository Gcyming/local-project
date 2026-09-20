/**
 * gui/src/main/browserBridge.ts — 主进程 → 渲染层「右侧栏浏览器控制」请求/响应桥（A-976）。
 *
 * 背景：Agent 工具在主进程执行，而右侧栏浏览器是 renderer 里的 <webview>。
 * main 不能直接调用 renderer 的函数，所以采用 IPC 请求/响应：
 *   main 发 `slime:browser:command` {id, ...cmd} → renderer 在 webview 上执行
 *   → renderer 回 `slime:browser:result` {id, ok, data|error} → 这里按 id 兑现 Promise。
 */
import { ipcMain, type BrowserWindow } from "electron";

interface Pending {
  resolve: (r: { ok: boolean; data?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserBridge {
  private pending = new Map<string, Pending>();
  private seq = 0;
  private getWin: () => BrowserWindow | null;

  constructor(getWin: () => BrowserWindow | null) {
    this.getWin = getWin;
    ipcMain.on("slime:browser:result", (_e, payload: { id?: string; ok?: boolean; data?: unknown; error?: string }) => {
      const id = String(payload?.id ?? "");
      const p = this.pending.get(id);
      if (!p) { return; }
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ ok: Boolean(payload?.ok), data: payload?.data, error: payload?.error });
    });
  }

  /** 下发一条浏览器指令并等待 renderer 回传结果 */
  async exec(
    cmd: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const win = this.getWin();
    if (!win || win.isDestroyed()) {
      return { ok: false, error: "应用窗口不可用（无法下发浏览器指令）" };
    }
    const id = `browser_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `浏览器指令超时（${String(cmd.kind ?? "")}，${timeoutMs}ms）——页面可能仍在加载或未响应` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        win.webContents.send("slime:browser:command", { id, ...cmd });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }
}
