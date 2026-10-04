




















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
