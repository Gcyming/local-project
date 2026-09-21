#!/usr/bin/env node
/**
 * gui/scripts/mut-a1055.mjs — A-1055 守卫的变异验证。
 *
 * 这一族断言全是**源码静态形态**（+ notifyIdentity 的纯逻辑），它们不会让任何类型检查失败 ——
 * 而一个不跑变异的静态守卫，最常见的失败是"锁错对象"：文件里还留着那行字符串，行为早变了。
 * 所以每条变异都对应一个**用户真的会在自己机器上遇到的现象**，改坏它守卫必须变红：
 *
 *  ① 更新又自己偷偷下（autoDownload / autoInstallOnAppQuit 被打开、两条入口漏关一条）
 *  ② 进度条又变成"转圈等它好"（不监听 download-progress、不夹 percent、文案谎称在下）
 *  ③ 通知又没图标（图标口径退回数据根、算出来不传下去、IconUri 不写、幂等判据退回只比 DisplayName）
 *  ④ 托盘又变成"要的时候没有"（main 里不建 / 提示语不同步 / 点击只会 show / 建失败静默）
 *  ⑤ 主进程与渲染层的 UpdateStatus 契约漂移
 *
 * ⚠️ 纪律（同 mut-a1054 / mut-a1056）：
 *   - 快照 / 还原一律走**字节**（Buffer），不做文本往返；
 *   - 每条变异都要求"文本确实变了"，否则是**未命中** —— 那种情况下"守卫仍绿"毫无意义；
 *   - 全程结束做字节级还原复核。
 *
 * ⚠️ main() 里 `      ensureTray();` 在文件里有**两处**（关窗处理器 + main），
 *    所以那条变异用**正则锚定在 createWindow() 之后**，而不是 sub() 的"第一处"。
 *
 * 用法：node gui/scripts/mut-a1055.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { subLines, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = [
  "tests/core-ts/a1055-guards.spec.ts",
  "tests/core-ts/a1021-guards.spec.ts",
];

const UPDATER = "gui/src/main/updater.ts";
const NOTIFY = "gui/src/main/notify.ts";
const IDENTITY = "gui/src/main/notifyIdentity.ts";
const MAIN = "gui/src/main/index.ts";
const PANEL = "gui/src/renderer/pages/StatusPanel.tsx";
const PRELOAD = "gui/src/preload/index.ts";
const IPC = "gui/src/shared/ipc.ts";
const FILES = [UPDATER, NOTIFY, IDENTITY, MAIN, PANEL, PRELOAD, IPC];

/** 单次替换：命中即返回，未命中返回原串（调用方用"必须变过"挡下来）。 */
const sub = (text, from, to) => (text.includes(from) ? text.replace(from, to) : text);
/** 正则替换：用于锚点里含中文引号 / 出现次数不唯一的场合 */
const subRe = (text, re, to) => (re.test(text) ? text.replace(re, to) : text);

/* 多行锚点的行尾自适应（`subLines`）+ 行尾自检（`eolProblems`）来自**共享模块**
   `./_mut-eol.mjs` —— 不要在本脚本里另写一份：A-1055 首轮就是因为"从别的脚本抄模板、
   而那份模板没带 helper"导致 4 条多行锚点在 CRLF 文件上静默未命中。见该模块文件头。 */

const MUTATIONS = [
  /* ── ① 自动更新改回"自己偷偷下" ──────────────────────────────────── */
  {
    name: "A-1055① autoDownload 被打开（检查到新版本就静默下 500MB）",
    file: UPDATER,
    mutate: (t) => sub(t, "autoUpdater.autoDownload = false;", "autoUpdater.autoDownload = true;"),
  },
  {
    name: "A-1055① autoInstallOnAppQuit 被打开（关窗就偷偷装上）",
    file: UPDATER,
    mutate: (t) => sub(t, "autoUpdater.autoInstallOnAppQuit = false;", "autoUpdater.autoInstallOnAppQuit = true;"),
  },
  {
    name: "A-1055① configureFeed 漏关自动下载（手动检查路径裸奔）",
    file: UPDATER,
    mutate: (t) => subLines(t,
      ["  disableAutoDownload();", "  const cfg = readUpdateConfig();"],
      ["  const cfg = readUpdateConfig();"]),
  },
  {
    name: "A-1055① initUpdater 漏关自动下载（启动自检路径裸奔）",
    file: UPDATER,
    mutate: (t) => subLines(t,
      ["  disableAutoDownload();", '  if (process.env.NODE_ENV === "development") {'],
      ['  if (process.env.NODE_ENV === "development") {']),
  },
  {
    name: "A-1055① downloadUpdate 不再先置 0%（点下去到首个进度事件之间一片死寂）",
    file: UPDATER,
    mutate: (t) => sub(t, "      percent: 0,", "      percent: undefined,"),
  },
  {
    name: "A-1055① 下载 IPC 通道改名（渲染层那个按钮点了没反应）",
    file: UPDATER,
    mutate: (t) => sub(t, 'ipcMain.handle("slime:update:download"', 'ipcMain.handle("slime:update:fetch"'),
  },
  {
    name: "A-1055① preload 不再暴露 download（渲染层根本调不到）",
    file: PRELOAD,
    mutate: (t) => sub(t, 'download: () => ipcRenderer.invoke("slime:update:download")', 'download: undefined'),
  },

  /* ── ② 进度条退回"转圈等它好" ────────────────────────────────────── */
  {
    name: "A-1055② 不再监听 download-progress（界面永远只能显示静态文案）",
    file: UPDATER,
    mutate: (t) => sub(t, 'autoUpdater.on("download-progress", (p) => {', 'autoUpdater.on("download-nothing", (p) => {'),
  },
  {
    name: "A-1055② 进度事件不以 downloading 态广播（进度条整块不会渲染）",
    file: UPDATER,
    mutate: (t) => subLines(t, [
      '      status: "downloading",',
      "      version: currentStatus.version,",
      "      releaseNotes: currentStatus.releaseNotes,",
      "      percent:",
    ], [
      '      status: "checking",',
      "      version: currentStatus.version,",
      "      releaseNotes: currentStatus.releaseNotes,",
      "      percent:",
    ]),
  },
  {
    name: "A-1055② percent 不夹取（上游给 >100 时进度条溢出容器）",
    file: UPDATER,
    mutate: (t) => sub(t, "Number.isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) : undefined", "p.percent"),
  },
  {
    name: "A-1055② 进度事件算完不广播（算了不播 = 没算）",
    file: UPDATER,
    mutate: (t) => subLines(t,
      ["      bytesPerSecond: p.bytesPerSecond,", "    };", "    broadcastStatus();"],
      ["      bytesPerSecond: p.bytesPerSecond,", "    };"]),
  },
  {
    name: "A-1055② 进度条宽度不再跟随 percent（又变回一根不动的装饰条）",
    file: PANEL,
    mutate: (t) => sub(t, "width: `${Math.max(0, Math.min(100, updateStatusSafe.percent ?? 0))}%`", 'width: "100%"'),
  },
  {
    name: "A-1055② 下载态不再是判定条件（进度条整块消失）",
    file: PANEL,
    mutate: (t) => sub(t, 'const isDownloading = updateStatus?.status === "downloading";', "const isDownloading = false;"),
  },
  {
    name: "A-1055② 文案又说谎「正在后台下载…」（用户以为它自己偷偷在下）",
    file: PANEL,
    mutate: (t) => sub(t, "（尚未下载，点击右侧按钮开始）", "（正在后台下载…）"),
  },
  {
    name: "A-1055② 面板挂载时又自动 check（翻到状态页就自动更新）",
    file: PANEL,
    mutate: (t) => subLines(t,
      ["    void api.current.stats.snapshot().then(setStats);"],
      ["    void api.current.stats.snapshot().then(setStats);",
       "    void api.current.update.check().then(setUpdateStatus);"]),
  },
  {
    name: "A-1055② 手动检查被一起删掉（从一个极端改到另一个极端：用户再没有主动检查入口）",
    file: PANEL,
    mutate: (t) => sub(t, "    const res = await api.current?.update?.check();", "    const res = null;"),
  },

  /* ── ③ 通知又没图标 ─────────────────────────────────────────────── */
  {
    name: "A-1055③ 图标口径退回数据根（打包版那里没有 build/icon.png → 静默用 Electron 默认图标）",
    file: NOTIFY,
    mutate: (t) => sub(t, 'join(INSTALL_ROOT, "build", "icon.png")', 'join(PROJECT_ROOT, "build", "icon.png")'),
  },
  {
    name: "A-1055③ 图标路径算出来不传下去（只算不用 = 没接线）",
    file: NOTIFY,
    mutate: (t) => sub(t, "applyWindowsNotificationIdentity(notificationIconPath())", "applyWindowsNotificationIdentity()"),
  },
  {
    name: "A-1055③ toast 正文图标不再同源（头部有别、正文还是默认小图）",
    file: NOTIFY,
    mutate: (t) => sub(t, "      icon: notificationIconPath(),", "      icon: undefined,"),
  },
  {
    name: "A-1055③ 文件不存在时塞一个坏路径（而不是返回 undefined 让 Electron 兜底）",
    file: NOTIFY,
    mutate: (t) => sub(t, "return existsSync(p) ? p : undefined;", "return p;"),
  },
  {
    name: "A-1055③ 幂等判据退回只比对 DisplayName（IconUri 永远补不上，日志还报「已注册，跳过」）",
    file: IDENTITY,
    mutate: (t) => sub(
      t,
      "const stale = values.filter((v) => cur[v.name] !== v.value);",
      'const stale = values.filter((v) => v.name === "DisplayName" && cur[v.name] !== v.value);',
    ),
  },
  {
    name: "A-1055③ IconUri 不再写入（toast 头部那张图永远没有）",
    file: IDENTITY,
    mutate: (t) => sub(t, 'if (uri) { values.push({ name: "IconUri", value: uri }); }', 'if (false) { values.push({ name: "IconUri", value: uri }); }'),
  },
  {
    name: "A-1055③ 跳过 pngFileUri 校验（把不合法的 URI 直接写进注册表）",
    file: IDENTITY,
    mutate: (t) => sub(t, "const uri = pngFileUri(iconPath);", "const uri = iconPath ?? null;"),
  },

  /* ── ④ 托盘退回"要的时候没有" ───────────────────────────────────── */
  {
    name: "A-1055④ main() 里不再建托盘（只在关窗时才出现 → 用户看到的是「要的时候没有」）",
    file: MAIN,
    mutate: (t) => subRe(t, /(      createWindow\(\);\r?\n(?:[^\n]*\r?\n){0,4}?)      ensureTray\(\);\r?\n/, "$1"),
  },
  {
    name: "A-1055④ 窗口 minimize 时托盘提示语不同步（托盘写着「已最小化到托盘」而窗口其实开着）",
    file: MAIN,
    /* 删掉整行（连它的换行）—— 锚点含行尾就跨行了，必须走 subLines；
       单行锚点 `...;\n` 会把文件行尾写死成 LF，index.ts 哪天转成 CRLF 就静默失效。 */
    mutate: (t) => subLines(t,
      ['  mainWindow.on("hide", syncTrayTooltip);', '  mainWindow.on("minimize", syncTrayTooltip);'],
      ['  mainWindow.on("hide", syncTrayTooltip);']),
  },
  {
    name: "A-1055④ 托盘点击不再是显隐切换（藏起来就回不去）",
    file: MAIN,
    mutate: (t) => sub(t, 'tray.on("click", toggleMainWindow)', "tray.on(\"click\", () => {})"),
  },
  {
    name: "A-1055④ 切换只会 show 不会 hide（托盘点一下「没反应」）",
    file: MAIN,
    mutate: (t) => sub(t, "{ w.hide(); }", "{ w.show(); }"),
  },
  {
    name: "A-1055④ 托盘建失败又静默（下一个人只能靠用户截图才发现）",
    file: MAIN,
    mutate: (t) => sub(t, 'console.warn("[gui:main] 托盘图标创建失败', 'console.info("[gui:main] 托盘图标创建失败'),
  },

  /* ── ⑤ 两份契约漂移 ─────────────────────────────────────────────── */
  {
    name: "A-1055⑤ 渲染层 DTO 少了 downloading（主进程推了它按不到，静默少一块 UI）",
    file: IPC,
    mutate: (t) => sub(t, 'status: "checking" | "downloading" | "downloaded"', 'status: "checking" | "downloaded"'),
  },
  {
    name: "A-1055⑤ 主进程 UpdateStatus 少了 downloading（同上，方向反过来）",
    file: UPDATER,
    mutate: (t) => sub(t, 'status: "checking" | "downloading" | "downloaded"', 'status: "checking" | "downloaded"'),
  },
];

function runGuards() {
  const r = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...GUARDS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const snapshot = () => {
  const m = new Map();
  for (const rel of FILES) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { m.set(p, readFileSync(p)); }
  }
  return m;
};
const restore = (snap) => { for (const [p, buf] of snap) { writeFileSync(p, buf); } };
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);
const treeHash = (snap) => [...snap.entries()].map(([p, b]) => `${p}:${sha(b)}`).join("|");

function main() {
  const snap = snapshot();
  const before = treeHash(snap);
  const missing = FILES.filter((f) => !snap.has(resolve(ROOT, f)));
  if (missing.length) {
    console.error(`[mut-a1055] 快照缺少文件：${missing.join("、")}`);
    process.exit(1);
  }
  const base = runGuards();
  if (!base.ok) {
    console.error("[mut-a1055] 基线守卫未通过\n" + base.out.slice(-2000));
    process.exit(1);
  }
  console.info(`[mut-a1055] 基线守卫通过（${FILES.length} 个源文件）\n`);

  /* 行尾自检（在跑变异**之前**）：本仓行尾是混的，多行锚点稍不留神就会在另一种行尾下
     静默失效。这里逐条把 mutate() 在两种行尾下各跑一遍 —— 与其等文件行尾哪天变了再
     "守卫仍绿"地骗人，不如现在就把对行尾敏感的锚点挡在门外。
     ⚠️ 先跑**检测器自身的反空转探针**：第一版 eolProblems 因为默认读函数取错 +
     `catch { continue; }`，对任何输入都返回空数组（"全部通过"），比没有自检更危险。 */
  const probe = selfTestEolDetector(ROOT);
  if (probe.length) {
    console.error("[mut-a1055] 行尾检测器自检失败（检测能力本身坏了）：");
    for (const b of probe) { console.error(`  - ${b}`); }
    process.exit(1);
  }
  if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1055")) { process.exit(1); }
  console.info("[mut-a1055] 行尾检测器自检 + 锚点自检均通过（LF / CRLF 下命中一致、不污染行尾）\n");

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const original = readFileSync(path, "utf8");   // 每轮从**磁盘现值**出发（上轮已字节还原）
    const next = m.mutate(original);
    if (next === original) {
      console.error(`[mut-a1055] ${m.name}\n  ✗ 变异未命中（文本没变）—— 守卫"仍绿"不能说明任何事`);
      survivors.push(`${m.name}（未命中）`);
      restore(snap);
      continue;
    }
    writeFileSync(path, next, "utf8");
    if (runGuards().ok) {
      console.error(`[mut-a1055] ${m.name}\n  ✗ 守卫仍绿 —— 没锁住`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1055] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }
  restore(snap);

  const restored = treeHash(snapshot()) === before;
  console.info("");
  if (survivors.length) {
    console.error(`[mut-a1055] ${survivors.length}/${MUTATIONS.length} 条未被捕获：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  if (!restored) {
    console.error("[mut-a1055] 还原失败 ✗（源文件指纹与快照不一致）");
    process.exit(1);
  }
  console.info(`[mut-a1055] 全部 ${MUTATIONS.length} 条变异均让守卫变红（${red} 红），源文件字节级已还原 ✓`);
  process.exit(0);
}

main();
