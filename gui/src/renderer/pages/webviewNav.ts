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

/* ══════════════════════════════════════════════════════════════════════════════
   A-1133：**导航失败锁存** —— 「无休止报错」的结构性闸门。

   事故（用户原话：「我无休止的报错，除非我主动关闭」）：拖入 `.docx` 后控制台无限刷
     `GUEST_VIEW_MANAGER_CALL: Error: ERR_FAILED (-2) loading 'file:///…docx'`
   伴随界面疯狂闪烁、目标文件夹被半成品文件塞满。

   为什么会"无休止"：自动重发有**两条**通路，而它们都不知道"这个地址已经被判死"——
     · 300ms 导航安全网（本意：guest 还没 attach 时兜底）；
     · 地址写回 + `forceNav`（本意：props.url 与 guest 当前地址不一致时对齐）。
   一次注定失败的加载（例如把 `.docx` 交给 Chromium）会让 `getURL()` 永远不等于目标 ⇒
   两条通路每 300ms 各重发一次 ⇒ **永远失败、永远重发**。

   ⚠️ 判据要分开两件事，混在一起就是这次的错：
     · "还没 attach" 是**时序**问题 ⇒ 只在 attach 前兜底（`trigger === "net" && attached` 即停）；
     · "加载失败过" 是**终态**问题 ⇒ 一旦失败，自动通路一律不再重发，只留用户手动「重试」。
   为什么 1 次就算终态：这些重发**不是用户意图**，而是内部兜底；对"类型根本不支持"的地址，
   第 2 次到第 1 万次的结果完全一样。用户手动「重试」= 清账本 + 显式再来一次（保留逃生口）。
   ══════════════════════════════════════════════════════════════════════════════ */

/** 失败账本：目标地址 → 已失败次数。key 用**原始目标地址**（不是 guest 的 `getURL()`）。 */
export type NavFailureBook = Map<string, number>;

/** 自动重发的触发者（用于区分"时序兜底"与"用户意图"） */
export type NavTrigger = "attach" | "url-change" | "net" | "manual";

/** 真失败才算数：`-3`（被后续导航顶掉/主动 abort）是正常噪声，不该进账本。 */
export function isTerminalNavFailure(errno: number): boolean {
  return !isBenignAbort(errno);
}

/** 记一次失败。返回账本是否有变化（无变化 = 这条失败本身已被忽略，例如 -3）。 */
export function noteNavFailure(book: NavFailureBook, url: string, errno: number): boolean {
  if (!url || !isTerminalNavFailure(errno)) { return false; }
  book.set(url, (book.get(url) ?? 0) + 1);
  return true;
}

/** 该地址是否已被判死（自动通路一律不许再发）。 */
export function isNavLatchBlocked(book: ReadonlyMap<string, number>, url: string): boolean {
  return Boolean(url) && (book.get(url) ?? 0) > 0;
}

/** 用户手动「重试」时的逃生口：清掉该地址（不传 = 全清）的失败记录。 */
export function clearNavFailure(book: NavFailureBook, url?: string): void {
  if (url === undefined) { book.clear(); return; }
  book.delete(url);
}

/**
 * **自动**加载是否允许（唯一判据）。所有自动通路（attach 兜底 / 地址写回 / 300ms 安全网）
 * 都必须先问它 —— 少问一处，那处就是下一个"无休止刷屏"。
 *
 * 拒绝的三种理由（都要能被单独解释，否则以后没人敢动）：
 *   ① 没有目标地址（空/undefined）；
 *   ② 该地址已在失败账本里 ⇒ **终态**，自动通路不再重发；
 *   ③ 安全网（`net`）在 guest 已 attach 后仍然发 ⇒ 它已经越过了自己的职责窗口（时序兜底），
 *      此时的重复加载只可能是"力竭式重试"。
 */
export function navAutoLoadAllowed(
  book: ReadonlyMap<string, number>,
  url: string,
  trigger: NavTrigger,
  attached: boolean,
): boolean {
  if (!url) { return false; }
  if (trigger === "manual") { return true; }
  if (isNavLatchBlocked(book, url)) { return false; }
  if (trigger === "net" && attached) { return false; }
  return true;
}
