/**
 * gui/src/renderer/dialog.ts — 渲染层统一异步对话框（A-151）。
 *
 * 替代 window.confirm / window.alert：Electron 中这两个 API 是**同步阻塞渲染进程 JS**
 * 的原生对话框——一旦显示异常（窗口失焦/多屏/被遮挡）整个 UI 冻结，所有输入框失灵
 * （实测「删除供应商后 URL/Key/名称全部无法输入」「切会话后输入框卡死」同源）。
 * 改走主进程 dialog.showMessageBox（异步、原生、永不阻塞渲染层）。
 *
 * 退路：IPC 失败（preload 未注入等）时回退原生 confirm/alert 兜底，保证功能不丢。
 */

type SlimeAPI = { dialog?: { confirm: (m: string, d?: string) => Promise<{ ok: boolean; confirmed: boolean }>; alert: (m: string, d?: string) => Promise<{ ok: boolean }> } };

function api(): SlimeAPI {
  return (window as unknown as { slimeAPI?: SlimeAPI }).slimeAPI ?? {};
}

/** 异步确认框 → Promise<boolean>（true=确定） */
export async function confirmAsync(message: string, detail?: string): Promise<boolean> {
  const dlg = api().dialog;
  if (dlg?.confirm) {
    try {
      const r = await dlg.confirm(message, detail);
      if (r.ok) { return r.confirmed; }
    } catch { /* 回退见下 */ }
  }
  // preload 缺失/IPC 故障兜底
  return window.confirm(detail ? `${message}\n\n${detail}` : message);
}

/** 异步提示框 */
export async function alertAsync(message: string, detail?: string): Promise<void> {
  const dlg = api().dialog;
  if (dlg?.alert) {
    try {
      await dlg.alert(message, detail);
      return;
    } catch { /* 回退见下 */ }
  }
  window.alert(detail ? `${message}\n\n${detail}` : message);
}