







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
