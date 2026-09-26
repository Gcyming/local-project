/**
 * gui/src/renderer/pages/webviewNav.ts — webview 导航的**唯一安全出口**（A-1106b）。
 *
 * 为什么单独成文件：这是纯逻辑（只依赖 `browserErrors` 的口径常量），
 * 按项目铁律不许住在 `.tsx` 里，也不该被 `browserBridge` 的 UI 依赖（Markdown/React）
 * 拖累 —— 单独成模块才能被 node 环境下的测试**直接驱动**（静态文本守卫证明不了
 * 「reject 真的被接住了」，只能证明「那行字还在」）。
 */

import { isBenignAbort } from "./browserErrors.js";

/** webview 的最小结构契约（`Electron.WebviewTag` 结构上兼容；不引 Electron 类型进来） */
export type WebviewLike = { loadURL(url: string): unknown };

/**
 * **webview 导航的唯一安全出口** —— `wv.loadURL()` 的 reject 必须被接住。
 *
 * 症状（用户实测）：调试面板**反复**刷
 *   `Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL': Error: ERR_ABORTED (-3) loading 'data:image/png;base64,…'`
 *
 * 根因：`loadURL()` **返回 Promise**，导航失败、或被**下一次导航顶掉**时它会 **reject**；
 * 而 Electron 内部 `navigationListener → rejectAndCleanup`（`browser_init`）把这个 reject
 * 当作 IPC 处理器的**未捕获异常**打印出来 —— 于是红字进调试面板。
 *
 * ⚠️ 旧代码写的是 `try { wv.loadURL(u); } catch {…}` —— **接不住**：
 * 同步 `try/catch` 管不了异步 reject。更要紧的是那两个信道是**两回事**：
 *   · attach 前调用 → **同步抛**（"must be attached to the DOM"）；
 *   · 加载失败 / 被顶掉 → **异步 reject**。
 * 旧代码只堵了前者，注释却写着「在 attach 前调用会被拒」 —— 抓错了信道，后者一直漏。
 *
 * 分类处理（**不许把真失败吞成静默**）：
 *   · `-3` ERR_ABORTED（被后续导航顶掉 / 主动 abort）= **正常噪声** → 丢弃。
 *     300ms 导航安全网会重发，不过滤就是「反复刷屏」的主产地。
 *   · 真失败 → 这里**不重复出声**：`did-fail-load` 已经是它的**唯一可见通道**
 *     （错误页 + `browserErrors` 的可操作归因）。同一件事两个产地只会更吵。
 *   · 同步抛（未 attach）→ 交给 `did-attach` / 安全网重试。
 */
export function safeLoadURL(wv: WebviewLike | null | undefined, url: string): void {
  if (!wv || !url || typeof wv.loadURL !== "function") { return; }
  let p: unknown;
  try {
    p = wv.loadURL(url);
  } catch {
    return; // 未 attach 的**同步**抛：由 did-attach / 安全网兜底重试
  }
  /* 真 Promise（或 thenable）才需要接 reject；返回 undefined 的实现（假对象/旧版）不必。
     ⚠️ 必须真挂 `.catch` —— 只 `void p` 不接，reject 仍然逃逸（本模块存在的全部意义）。 */
  if (p && typeof (p as Promise<void>).catch === "function") {
    void (p as Promise<void>).catch((e: unknown) => {
      /* -3 = 被下一次导航顶掉，属正常；其余真失败由 did-fail-load 上错误页（唯一可见通道）。 */
      if (isBenignAbort(Number((e as { errno?: number } | null | undefined)?.errno))) { return; }
    });
  }
}
