/**
 * tests/_stubs/electron.ts — 测试环境里的 `electron` 替身。
 *
 * ## 为什么需要它（不是"为了好看"，是 mock 会**静默失效**）
 * `electron` 的 CJS 入口只导出一个**可执行文件路径字符串**，在 vitest（node 环境）里
 * `import { ipcMain } from "electron"` 拿到的是 `undefined` —— `gui/src/main/notifyIdentity.ts`
 * 早留档过这一点（"能跑不能跑全看 bundler interop"，属定时炸弹）。
 *
 * 更要命的是**解析路径不一致**：本仓根目录**没有** `node_modules/electron`，而 `gui/` 有。
 * 于是 `tests/**` 里的 `vi.mock("electron")` 因为 specifier 不可解析而被注册成"虚拟模块"，
 * 而 `gui/src/main/searchBridge.ts` 内部解析到的是**真**的 `gui/node_modules/electron`
 * ⇒ 两条 id 不同 ⇒ **mock 不生效**，且不报任何错（本仓铁律 5 的典型）。
 *
 * ⇒ 在 `vitest.config.ts` 里把 `electron` 一律 alias 到本文件：spec 与源码解析到同一个 id，
 *   `vi.mock("electron", ...)` 才能真正接管。
 *
 * ## ⚠️ 本文件故意"一碰就炸"
 * 谁要是忘了在 spec 里 `vi.mock("electron", ...)`，就会拿到这里**抛异常**的桩，
 * 而不是一个静默的 `undefined` —— 失败要出声（铁律 28）。
 */

function unavailable(what: string): never {
  throw new Error(
    `测试环境里不能直接用 electron 的 ${what}：请在 spec 里用 vi.mock("electron", ...) 提供替身` +
    "（见 tests/gui/a1137-search-bridge.spec.ts）。",
  );
}

export const app = {
  getPath: (): never => unavailable("app.getPath"),
  getAppPath: (): never => unavailable("app.getAppPath"),
  getName: (): never => unavailable("app.getName"),
  setName: (): never => unavailable("app.setName"),
  getVersion: (): never => unavailable("app.getVersion"),
};

export const ipcMain = {
  handle: (): never => unavailable("ipcMain.handle"),
  handleOnce: (): never => unavailable("ipcMain.handleOnce"),
  on: (): never => unavailable("ipcMain.on"),
  removeHandler: (): never => unavailable("ipcMain.removeHandler"),
};

export const webContents = {
  getAllWebContents: (): never => unavailable("webContents.getAllWebContents"),
  fromId: (): never => unavailable("webContents.fromId"),
};
