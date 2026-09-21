/**
 * tests/core-ts/a1055-guards.spec.ts — A-1055 回归守卫
 *
 * 这一轮四件事，共同点是"改回去**既不报错、类型检查也全绿**，只有用户在自己机器上试才看得见"：
 *  ① 自动更新改**用户主动**。根因：`electron-updater` 的 `autoDownload` **默认为 true**，而本
 *     项目发行版走的是 `[update].enabled = false` 分支 → 那条分支**从来没有人**把它设成 false。
 *     于是用户只是在设置里翻到「状态」页（面板挂载即 check），500MB 安装包就开始在后台下。
 *  ② 下载**实时进度**。此前主进程**压根没有** `download-progress` 监听 —— 界面拿不到任何数字，
 *     只能显示一句静态的「正在后台下载…」。用户读到的就是"它自己偷偷在下"。
 *  ③ 通知图标口径 = **安装根**。旧口径 `PROJECT_ROOT` 是**数据根**（打包版 = userData/slime-data），
 *     那里根本没有 `build/icon.png` → Electron 回落到默认图标，且**全程静默**。
 *     同时恢复写 `IconUri`（toast **头部**应用身份行的那张图）—— 只有 `Notification({icon})`
 *     只能影响正文区小图，头部永远是空的。
 *  ④ 托盘**应用一启动就常驻**。旧实现只在 `exitModeStore === "background"` 且用户关窗时才建，
 *     于是现象是反的：不要的时候（后台模式）一直显示，要的时候（窗口开着）根本没有。
 *
 * ⚠️ 为什么全是**静态源码形态**断言，而不是行为断言：
 *    `updater.ts` / `notify.ts` / `index.ts` 顶层都 `import electron`（或经 `electron-updater`
 *    转手 import），在 vitest 里拿到的是 undefined —— a1021 的文件头已经写过这是"今天绿明天红"
 *    的定时炸弹。所以**行为断言只放在不依赖 electron 的纯模块**（`notifyIdentity.ts`、
 *    `cheerPhrases.ts`），其余一律锁源码形态 + 靠变异测试兜住"锁错对象"。
 *
 * ⚠️ 断言"代码里没有 X"之前必须先**剥注释**：本轮多处"追述性注释"会合法地提到被删掉的旧写法
 *    （实测 `join(PROJECT_ROOT, "build", "icon.png")` 与「正在后台下载…」**只**存在于注释里）。
 *    把注释当实现，守卫就变成了"注释不许写历史"这种伪命题（a1054/a1056 同做法）。
 *
 * ⚠️ 每条守卫都**必须过变异测试**（见 `gui/scripts/mut-a1055.mjs`），否则"通过但锁错对象"。
 *
 * ⚠️ 中文文案里嵌套引用一律用 `「」`：ASCII 双引号会当场把 TS 字符串截断（a1054/a1056 都踩过）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释：**只在断言"代码里没有 X"时用**（追述性注释会合法地提到旧写法） */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const UPDATER = read("gui/src/main/updater.ts");
const NOTIFY = read("gui/src/main/notify.ts");
const IDENTITY = read("gui/src/main/notifyIdentity.ts");
const MAIN = read("gui/src/main/index.ts");
const STATUS_PANEL = read("gui/src/renderer/pages/StatusPanel.tsx");
const PRELOAD = read("gui/src/preload/index.ts");
const IPC = read("gui/src/shared/ipc.ts");

/** 取函数/箭头函数的体：从签名到**下一个列 0 的 `}`**。
 *  这几个目标函数内部的收尾全是缩进的（`  });` / `  } catch {`），所以不会提前截断。 */
function bodyOf(src: string, sig: string): string {
  const at = src.indexOf(sig);
  if (at < 0) { return ""; }
  const end = src.indexOf("\n}", at);
  return src.slice(at, end < 0 ? undefined : end);
}

/** 取某个 `autoUpdater.on("x", …)` 的处理体：从它自己到**下一个 `autoUpdater.on(` 之前**。
 *
 *  ⚠️ 这些 handler 不能走 bodyOf()：它们的收尾是**缩进的** `  });`，不是列 0 的 `}`，
 *  于是 bodyOf 会一路吃到 `initUpdater()` 的末尾，把**后面几个 handler** 的语句也算进来。
 *  首轮变异实锤了这种假绿：把进度事件里的 `broadcastStatus();` 删掉，守卫照样通过 ——
 *  因为它 `toContain` 到的是邻居（`checking-for-update` 等）那一行。
 *  断言"某段代码里有 X"时，**段的边界必须比 X 的粒度更细**，否则等于没锁。 */
function handlerBody(src: string, sig: string): string {
  const at = src.indexOf(sig);
  if (at < 0) { return ""; }
  const next = src.indexOf("autoUpdater.on(", at + sig.length);
  return src.slice(at, next < 0 ? undefined : next);
}

/** 取 `main()` 的体。main 是文件里**倒数第二个**顶层函数，故用文件最后一个 `\n}` 作右界
 *  （多带上后面的 terminateModelServer 无害：它既不含 createWindow() 也不含 ensureTray()）。
 *  ⚠️ 不能直接 `indexOf("\n}", mainAt)` —— 需要先确认 main 体内没有列 0 的 `}`；用右界兜住更稳。 */
function mainBody(): string {
  return MAIN.slice(MAIN.indexOf("function main(): void {"), MAIN.lastIndexOf("\n}"));
}

/** 从某个 interface 体里取出 `status` 字段的联合类型文本（已归一化空白） */
function statusUnion(src: string, iface: string): string {
  const at = src.indexOf(`export interface ${iface} {`);
  if (at < 0) { return ""; }
  const body = src.slice(at, src.indexOf("\n}", at));
  const m = /status:\s*((?:"[a-z-]+"\s*\|\s*)*"[a-z-]+");/.exec(body);
  return m ? m[1].replace(/\s+/g, " ") : "";
}

describe("A-1055① 自动更新 = 用户主动（autoDownload 必须被显式关掉）", () => {
  it("disableAutoDownload 把两个开关都置 false（autoDownload 默认 true 就是这轮 bug 的根因）", () => {
    const b = bodyOf(UPDATER, "function disableAutoDownload(): void {");
    expect(b.length, "取不到 disableAutoDownload → 这条守卫自己失效了").toBeGreaterThan(0);
    expect(b, "autoDownload 不置 false → 检查到新版本就自己下 500MB").toContain("autoUpdater.autoDownload = false;");
    expect(b, "autoInstallOnAppQuit 同样是「替用户做主」：安装必须等用户点").toContain("autoUpdater.autoInstallOnAppQuit = false;");
  });

  it("全模块再没有任何地方把这两个开关设成 true（含「临时调试」）", () => {
    const code = strip(UPDATER);
    expect(code, "有人把 autoDownload 打开了 → 用户会再次遇到「翻过去就自己下」").not.toMatch(/autoUpdater\.autoDownload\s*=\s*true/);
    expect(code, "有人把 autoInstallOnAppQuit 打开了 → 关窗就偷偷装").not.toMatch(/autoUpdater\.autoInstallOnAppQuit\s*=\s*true/);
  });

  it("**两条入口**都先关自动下载：configureFeed 与 initUpdater 都必须在配源/检查之前调用它", () => {
    // 顺序就是这条修复的全部 —— checkForUpdates() 一旦发出，再关 autoDownload 就来不及了。
    const feed = bodyOf(UPDATER, "function configureFeed(): void {");
    expect(feed.length, "取不到 configureFeed → 守卫失效").toBeGreaterThan(0);
    const atFeed = feed.indexOf("disableAutoDownload();");
    expect(atFeed, "configureFeed 没关自动下载 → checkForUpdate() 路径裸奔（手动检查不受 enabled 限制）")
      .toBeGreaterThanOrEqual(0);
    expect(atFeed, "关自动下载必须**早于** setFeedURL").toBeLessThan(feed.indexOf("autoUpdater.setFeedURL("));

    const init = bodyOf(UPDATER, "export function initUpdater(): void {");
    expect(init.length, "取不到 initUpdater → 守卫失效").toBeGreaterThan(0);
    const atInit = init.indexOf("disableAutoDownload();");
    expect(atInit, "initUpdater 没关自动下载 → 启动自动检查路径裸奔").toBeGreaterThanOrEqual(0);
    expect(atInit, "关自动下载必须**早于**任何 checkForUpdate()").toBeLessThan(init.indexOf("checkForUpdate()"));
  });

  it("下载有独立入口：downloadUpdate() 导出 + 注册 IPC + preload 暴露", () => {
    expect(UPDATER).toContain("export async function downloadUpdate(): Promise<UpdateStatus> {");
    expect(UPDATER, "没注册 IPC → 界面上那个「下载更新」按钮点了没反应").toContain('ipcMain.handle("slime:update:download"');
    expect(PRELOAD, "preload 没暴露 download → 渲染层根本调不到").toContain('download: () => ipcRenderer.invoke("slime:update:download")');
    // 起点先置 0%：否则在首个 download-progress 到达前界面毫无反馈，用户以为点击没生效
    const dl = bodyOf(UPDATER, "export async function downloadUpdate(): Promise<UpdateStatus> {");
    expect(dl.length, "取不到 downloadUpdate → 守卫失效").toBeGreaterThan(0);
    expect(dl, "下载起点不先置 0% → 点下去到第一个进度事件之间是一片死寂").toContain("percent: 0");
  });
});

describe("A-1055② 下载进度真的被上报（此前主进程完全没有 download-progress 监听）", () => {
  it("监听 download-progress，四个数字全带上，且 percent 夹到 0–100", () => {
    expect(UPDATER, "没有 download-progress 监听 → 界面永远只能显示静态文案")
      .toContain('autoUpdater.on("download-progress"');
    const h = handlerBody(UPDATER, 'autoUpdater.on("download-progress", (p) => {');
    expect(h.length, "取不到 download-progress 处理体 → 守卫失效").toBeGreaterThan(0);
    expect(h, "进度事件不以 downloading 态广播 → 进度条那块根本不会渲染").toContain('status: "downloading"');
    for (const f of ["percent", "transferred", "total", "bytesPerSecond"]) {
      expect(h, `进度事件少了字段 ${f} → 界面上那一项永远是「—」`).toContain(f);
    }
    // 夹取：上游给过 >100 / NaN 时，进度条会溢出容器或渲染成「NaN%」
    expect(h).toContain("Number.isFinite(p.percent)");
    expect(h).toContain("Math.max(0, Math.min(100, p.percent))");
    expect(h, "算了不广播 = 没算").toContain("broadcastStatus();");
  });

  it("状态页渲染**真实**进度条：宽度取自 percent，并给出「已下载/总量」与速率", () => {
    expect(STATUS_PANEL).toContain("function fmtBytes(n: number | undefined): string {");
    expect(STATUS_PANEL, "进度条不随 percent 变化 → 又变回一根不动的装饰条")
      .toContain("width: `${Math.max(0, Math.min(100, updateStatusSafe.percent ?? 0))}%`");
    expect(STATUS_PANEL).toContain("{fmtBytes(updateStatusSafe.transferred)} / {fmtBytes(updateStatusSafe.total)}");
    expect(STATUS_PANEL).toContain("{fmtBytes(updateStatusSafe.bytesPerSecond)}/s");
    // 下载态是一等状态（没有它，进度条整块都不会渲染出来）
    expect(STATUS_PANEL).toContain('const isDownloading = updateStatus?.status === "downloading";');
    expect(STATUS_PANEL, "「下载更新」按钮的处理器没了 → autoDownload 已关，就永远不会下载").toContain("handleDownloadUpdate");
  });

  it("「发现新版本」不再谎称正在下载 —— 那正是用户以为「它自己偷偷在下」的由来", () => {
    const code = strip(STATUS_PANEL);
    expect(code, "又把「正在后台下载…」写回来了").not.toContain("正在后台下载");
    expect(code, "文案必须如实说「尚未下载」，否则用户分不清它到底下没下").toContain("尚未下载，点击右侧按钮开始");
  });

  it("挂载即检查那条路已断：**翻到状态页**不许再自动查 GitHub", () => {
    const at = STATUS_PANEL.indexOf("void api.current.stats.snapshot().then(setStats);");
    expect(at, "取不到挂载副作用的位置 → 守卫失效").toBeGreaterThanOrEqual(0);
    const seg = STATUS_PANEL.slice(at, STATUS_PANEL.indexOf("const offUpdate = api.current.update.onStatus("));
    expect(seg.length, "取不到挂载副作用片段 → 守卫失效").toBeGreaterThan(0);
    expect(strip(seg), "面板一挂载就去查 GitHub → 又变成「翻到状态页就自动更新」")
      .not.toContain("update.check()");
    // 但用户**主动**点「手动检查」必须还在（否则就是从一个极端改到另一个极端）
    expect(STATUS_PANEL, "手动检查被一起删掉了 → 用户再也没有主动检查的入口")
      .toContain("await api.current?.update?.check();");
  });
});

describe("A-1055③ 通知图标口径 = 安装根（不是数据根），且真的接进身份注册", () => {
  it("notificationIconPath 走 INSTALL_ROOT；旧口径（数据根）只许留在追述性注释里", () => {
    expect(NOTIFY).toContain('join(INSTALL_ROOT, "build", "icon.png")');
    // ⚠️ 必须先剥注释：本函数的注释会合法地提到旧写法（「此前是 join(PROJECT_ROOT, …)」）
    expect(strip(NOTIFY), "PROJECT_ROOT 是数据根，打包版那里没有 build/icon.png → 通知静默退回 Electron 默认图标")
      .not.toContain('join(PROJECT_ROOT, "build", "icon.png")');
    const b = bodyOf(NOTIFY, "export function notificationIconPath(): string | undefined {");
    expect(b.length, "取不到 notificationIconPath → 守卫失效").toBeGreaterThan(0);
    expect(b, "文件不存在时必须返回 undefined（让 Electron 用应用图标兜底），不许塞坏路径")
      .toContain("existsSync(p) ? p : undefined");
  });

  it("图标路径**真的被传进**身份注册，并且 toast 正文图标同源（只算出来不用 = 没接线）", () => {
    // A-1054 W1 的教训：「定义了组件」不等于「挂上去了」。这里同理 —— 只算出路径不传下去，
    // toast 头部还是没图标，而所有静态断言看起来都"有那段代码"。
    expect(NOTIFY).toContain("applyWindowsNotificationIdentity(notificationIconPath())");
    expect(NOTIFY).toContain("icon: notificationIconPath(),");
  });

  it("身份注册的幂等判据覆盖**全部**值（此前只比对 DisplayName → 补 IconUri 那版被短路，静默失效）", () => {
    // v0.0.6 已把 DisplayName 写成 "slime"，于是"只比 DisplayName 就跳过"会让 IconUri 永远补不上，
    // 而日志还报「已注册，跳过」—— 典型的"能跑但错"，没有任何测试拦得住。
    expect(IDENTITY).toContain("const stale = values.filter((v) => cur[v.name] !== v.value);");
    expect(IDENTITY, "退回只比对 DisplayName → IconUri 永远补不上").not.toContain('cur["DisplayName"]');
    expect(IDENTITY, "写完不回读复核 = 静默失败（注册表写没写进去只有天知道）")
      .toContain("const bad = values.filter((v) => got[v.name] !== v.value);");
  });

  it("IconUri 经 pngFileUri 严格校验后才写（不合格就不写，宁缺勿坏）", () => {
    const b = bodyOf(IDENTITY, "export function aumidRegistryValues(");
    expect(b.length, "取不到 aumidRegistryValues → 守卫失效").toBeGreaterThan(0);
    expect(b).toContain("const uri = pngFileUri(iconPath);");
    expect(b, "校验通过就必须写（算了不写 = 头部图标永远没有）")
      .toContain('if (uri) { values.push({ name: "IconUri", value: uri }); }');
  });
});

describe("A-1055④ 托盘 = 应用一启动就常驻", () => {
  const mb = mainBody();

  it("main() 里 createWindow() 之后**立即**建托盘（旧实现要等「关窗 + 后台模式」→ 要的时候没有）", () => {
    expect(mb.length, "取不到 main() 体 → 守卫失效").toBeGreaterThan(0);
    const at = mb.indexOf("createWindow();");
    expect(at, "main() 里没调 createWindow() → 守卫失效").toBeGreaterThanOrEqual(0);
    const trayAt = mb.indexOf("ensureTray();");
    expect(trayAt, "main() 里没有 ensureTray() → 托盘只在关窗时才出现（用户看到的是「要的时候没有」）")
      .toBeGreaterThan(at);
  });

  it("托盘提示语跟随窗口可见性（show / hide / minimize / restore 四条路都要同步）", () => {
    expect(MAIN).toContain("const syncTrayTooltip = (): void => {");
    for (const ev of ["show", "hide", "minimize", "restore"]) {
      expect(MAIN, `窗口 ${ev} 时托盘提示语不同步 → 托盘写着「已最小化到托盘」而窗口其实开着（会误导人）`)
        .toContain(`mainWindow.on("${ev}", syncTrayTooltip);`);
    }
    expect(MAIN).toContain('"Slime — 已最小化到托盘（点击恢复）"');
  });

  it("托盘点击 = 显示/隐藏切换（旧实现只会 show，藏起来就回不去）", () => {
    expect(MAIN).toContain('tray.on("click", toggleMainWindow)');
    expect(MAIN).toContain('{ label: "显示 / 隐藏主界面", click: toggleMainWindow }');
    const b = bodyOf(MAIN, "const toggleMainWindow = (): void => {");
    expect(b.length, "取不到 toggleMainWindow → 守卫失效").toBeGreaterThan(0);
    expect(b, "只会 show 不会 hide → 托盘点一下「没反应」").toContain("w.hide();");
    expect(b).toContain("w.show();");
  });

  it("托盘建不起来不许静默（静默失败 = 下一个人只能靠用户截图才发现）", () => {
    const b = bodyOf(MAIN, "const ensureTray = (): void => {");
    expect(b.length, "取不到 ensureTray → 守卫失效").toBeGreaterThan(0);
    expect(b, "catch 里只写 `tray = null`（旧实现）→ 托盘没了却没有任何线索")
      .toMatch(/catch \(e\) \{[\s\S]*?console\.warn/);
  });
});

describe("A-1055⑤ 主进程 UpdateStatus 与渲染层 UpdateStatusDTO 不许漂移", () => {
  it("两份声明是同一份契约：status 联合类型必须逐字相同，且都含新增的 downloading", () => {
    const main = statusUnion(UPDATER, "UpdateStatus");
    const dto = statusUnion(IPC, "UpdateStatusDTO");
    expect(main, "取不到 updater 的 status 联合 → 守卫失效").not.toBe("");
    expect(dto, "取不到 DTO 的 status 联合 → 守卫失效").not.toBe("");
    expect(main, "主进程多/少一个状态 → 渲染层按不到那个分支（静默少一块 UI）").toContain('"downloading"');
    expect(dto, "两份契约漂移了：字段增删必须同步（这正是 A-1055 加下载进度时最易漏的一步）").toBe(main);
  });
});
