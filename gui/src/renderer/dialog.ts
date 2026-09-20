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

/** A-1018：主题弹窗宿主的请求形态（键名与主进程 IPC 的 payload 无关，纯渲染层） */
export interface DialogRequest {
  kind: "confirm" | "alert";
  message: string;
  detail?: string;
}

/** 主题弹窗宿主（React 组件挂载时注册）。返回 true = 用户点了「确定」。 */
type DialogHost = (req: DialogRequest) => Promise<boolean>;

let dialogHost: DialogHost | null = null;

/** 由 ThemeDialogHost 在挂载时注册自己；卸载时传 null 摘除。 */
export function registerDialogHost(host: DialogHost | null): void {
  dialogHost = host;
}

/** 异步确认框 → Promise<boolean>（true=确定）
 *
 *  A-1018：优先走**渲染层主题弹窗**（slime 配色 + 左确认右取消）。宿主未挂载时才退回
 *  主进程原生 dialog（那时页面还没渲染完，用户也看不到；再退一步是 window.confirm 兜底）。 */
export async function confirmAsync(message: string, detail?: string): Promise<boolean> {
  if (dialogHost) {
    try {
      return await dialogHost({ kind: "confirm", message, detail });
    } catch { /* 宿主异常 → 继续走原生回退，保证功能不丢 */ }
  }
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

/** 异步提示框（同上：主题弹窗优先） */
export async function alertAsync(message: string, detail?: string): Promise<void> {
  if (dialogHost) {
    try {
      await dialogHost({ kind: "alert", message, detail });
      return;
    } catch { /* 回退见下 */ }
  }
  const dlg = api().dialog;
  if (dlg?.alert) {
    try {
      await dlg.alert(message, detail);
      return;
    } catch { /* 回退见下 */ }
  }
  window.alert(detail ? `${message}\n\n${detail}` : message);
}