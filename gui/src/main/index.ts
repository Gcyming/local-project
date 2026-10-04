/**
 * gui/src/main/index.ts �?Electron 主进程（Phase 5 MVP + P0 缺口补齐）�??
 * - 窗口/生命周期管理
 * - slime:// �?��义协�?��载渲染页�?��v2.5 安全基线；Electron 25+ protocol.handle�?
 * - 直接加载 core-ts 调度核心（函数调�?���?HTTP 回环�?
 * - sidecar spawn/terminate 管理
 * - IPC 通道注册（sender 白名单验�?+ contextBridge 封�?回传�?
 * - P0: chat:new / chat:retry / agents:select / agents:update
 * - �?��移民协�? v1.2: agents:export / agents:import
 *
 * 非破坏�?�：仅新增于 gui/，不�?�� core-ts/gateway-ts/sidecar/legacy�?
 */
import "./boot.js"; // 数据根引导：必须�?先执行（�?core-ts 模块级常量求值前设置 SLIME_ROOT�?
import { INSTALL_ROOT, BUNDLE_ROOT } from "./boot.js";
// A-980-R31：子代理运�?记录落盘（内存�??+ 历史合并、终态快照持久化�?
import { clearSubagentRuns, mergedSubagentRuns, syncSubagentRuns } from "./subagentStore.js";
// A-984：主进程事件�?��卡�?看门狗（埋点 + 掉拍�?�?�?data/watchdog.log�?
import { startMainWatchdog, markMainActivity } from "./watchdog.js";
// A-986：意外�??出保底（脏标记判定异常�??�?+ 清障 + 留证 �?data/crash-report.log�?
import { sweepAfterCrash, markRunning, markCleanExit } from "./crashGuard.js";
// A-1110：开发期 CDP �?��的�?�择与发布（**�?��出�?**：env 覆盖 / 占用顺延 / 临时�?�� / 落盘�?
import {
  DEVTOOLS_PORT_ENV, DEVTOOLS_PORT_SCAN,
  listeningPortsSync, resolveDevtoolsPort, writeDevtoolsPortFile, parseDevToolsActivePort,
} from "./devtoolsPort.js";

// A-937：�??出�?为（模块级，IPC handlers 与窗�?close 拦截共用�?
let exitModeStore: "quit" | "background" = "quit";
let tray: Electron.Tray | null = null;
let appIsQuitting = false;
const exitModePath = () => join(app.getPath("userData"), "exit-mode.json");

/** B：�?批前�?��类�?��?�把 sandbox 权限请求映射为分类器输入做调用前复核�?
 *
 * 【�?计原则�?�分类器不再靠�?�工具名子串」猜风险，�?�是**服从工具�?�� + slime �?��审批策略**�?
 *   1. 从注册表取工具，读它声明�?`riskKind`（缺省由 permissions 推�?）；
 *   2. �?��册工�?�?**fail-closed**（需�??），绝不默�?放�?�?
 *   3. read �?�?直接放�?�?
 *   4. write/terminal/network �?�?先跑�??则（`..` 越权、敏感文件�?�受保护源码�?���?
 *      rm -rf / curl|sh �?block 特征始终生效），再按工具�?��声明 `autoApprovable` 决定�?
 *        声明�?�?允�? auto；未声明 �?�?律收敛为「需用户�??」�??
 *   这样�?��杜绝 adb_install / adb_connect / http_create_app 这类新工具因名字不匹�?
 *   三档正则而�?静默放�?，也让�?��?�?�?权限」成为唯�?权威�?
 *
 * 【A-1057 收敛】上述顺序与判据已抽�?`core-ts/src/tools/policy.ts`（纯函数、可单测、过变异），
 *   �?��件只剩�?�查注册�?+ 组�?�?关�?��?�同�?批判�?��由工具闸门在**每�?调用**时执行，
 *   因�?不再存在"免�?批档位把�??则一起免�?的路径�??*/
/** 设置面板的六�?��关（结构对齐 GrantSwitches，供放�?判据使用�?*/
function permSwitches(p: GuiPermissions): GrantSwitches {
  return {
    toolRead: p.toolRead,
    toolWrite: p.toolWrite,
    toolTerminal: p.toolTerminal,
    screenEnabled: p.screenEnabled,
    mcpEnabled: p.mcpEnabled,
    skillsEnabled: p.skillsEnabled,
  };
}

function classifyPermissions(actions: Array<{ action: string; target: string }>): {
  hasBlocked: boolean;
  allAuto: boolean;
  reasons: string[];
} {
  let hasBlocked = false;
  let allAuto = true;
  const reasons: string[] = [];
  const registry = getRegistry();
  const sw = permSwitches(getPermissions());
  for (const a of actions) {
    const name = (a.action ?? "").toLowerCase();
    const target = (a.target ?? "").trim();
    const tool = registry.get(name);

    // �?�?��册工具：不猜、不放�?，交给用户�?批（fail-closed�?
    if (!tool) {
      allAuto = false;
      reasons.push(`${name}: �?��册工具，�?用户�??（fail-closed）`);
      continue;
    }

    // �?判据全部住在 core-ts/src/tools/policy.ts（纯函数，可单测）�?��?�顺序在那里固定�?
    //    �??则（越权�?��/敏感文件/受保护源码目�?终�?黑名�?内网地址�?*�?关与档位都不能解�?*�?
    //    �?�?关放行（�?�?��免�?��?审批）→ 内�?分级 �?�?��明无�?��用则�?�??�?
    //    同一批硬规则也在工具闸门里�?�调用执行，免�?批档位下同样不会漏�??
    const r = classifyToolCall({
      name,
      permissions: tool.permissions,
      riskKind: tool.effectiveRiskKind(),
      autoApprovable: tool.autoApprovable,
      target,
      switches: sw,
    });

    if (r.level !== "auto") { allAuto = false; }
    if (r.level === "block") { hasBlocked = true; }
    reasons.push(`${name}: ${r.reason}`);
  }
  return { hasBlocked, allAuto, reasons };
}
try {
  const raw = readFileSync(exitModePath(), "utf8");
  exitModeStore = raw.trim() === "background" ? "background" : "quit";
} catch { exitModeStore = "quit"; }
const saveExitMode = (mode: "quit" | "background"): void => {
  try { writeFileSync(exitModePath(), mode, "utf8"); } catch { /* ignore */ }
};

// 全局子代�?*执�?模型�?*（A-942 的单值默认模�?�?A-1097 �??选）�?
// 持久�?userData/subagent-models.json = { models: string[] }�?*池�? = 执�?兜底�?*（不�?model 时用它）�?
// ⚠️ 空池 �?"继承"：空池表�?*不指�?*，由 SubAgentManager.spawn 回�??到目�?Agent 模型（inherit �?��位不�?��位）�?
const subagentModelsPath = () => join(app.getPath("userData"), "subagent-models.json");
/** 旧版单�?�文件（A-942~A-1096）：**�??�?次做兼�?迁移**，�?后不再写它�??*/
const legacySubagentModelPath = () => join(app.getPath("userData"), "subagent-model.json");
let subagentDefaultModels: string[] = (() => {
  try {
    const raw = JSON.parse(readFileSync(subagentModelsPath(), "utf8")) as { models?: unknown };
    if (Array.isArray(raw?.models)) { return normalizeModelPool(raw.models); }
  } catch { /* 无新文件 �?走旧单�?�兼�?*/ }
  try {
    return normalizeModelPool([readFileSync(legacySubagentModelPath(), "utf8")]);
  } catch { return []; }
})();
const saveSubagentDefaultModels = (models: unknown): void => {
  subagentDefaultModels = normalizeModelPool(models);
  try { writeFileSync(subagentModelsPath(), JSON.stringify({ models: subagentDefaultModels }), "utf8"); } catch { /* 落盘失败不阻�?*/ }
};

/* A-1100：子代理执�?模型池的**写入链路** —�??必须住在**模块�?*，不许再埋进惰�?�的 `ensureServicesOnce()`�?
 *
 * 病灶（用户可见）：�?�界�?��存按�?��法实现功能�?�（点了�?点反应都没有）�?�三条证�?��洽：
 *   �?通道此前�?��惰�?�块�?`ipcMain.handle` 注册，�?��?块�?等技能扫�?/ scheduler / SILAM �?�?
 *      重活跑完（实测好几�?）⇒ 冷启动窗口内点保�?= **通道�?���?*�?
 *   �?渲染层是**�?`await`** �?`ipcRenderer.invoke` reject（`No handler registered for
 *      'slime:resident:subagent:setModels'`）后 `setModelModal(false)` 不执�?�?弹层卡住不关�?
 *   �?`userData/subagent-models.json` **磁盘上根�?��存在** �?保存从未真�?到达主进程�??
 *   这与 A-1048 �?�� `slime:resident:state` �?*同一�?��**（同�?块惰性初始化）�??
 *
 * �?���?*让写链路不依赖�?理器**。真值落在模块级 `subagentDefaultModels`�? �?��持久化真相源），
 *   管理器就�?��`subagentsRef`）时同�?推一份；管理器尚�?��建时，它在创建时会�?�?��量播�?
 *   （�? `ensureServicesOnce` 里的 `subagents.setDefaultModels(subagentDefaultModels)`）�??
 *   �?任何时刻点保存都**真的生效**，不存在「注册了但写不进去�?�的半吊子�?��??
 *   通道�?���?`registerIpcHandlers()` �?��期注册（见�?函数内的 A-1100 注释）�??
 */

/** 子代理执行模型取值的**�?��**归一化实现（单�??/ 多�?�两条�?�道共用）�??
 *  顺手治好两�?历史坑：�?`api:<key>.<model>`（点号）�?��纠�?为冒号分隔；
 *  �?供应�?key 允�?�?�� —�??此前 `[A-Za-z0-9_-]+` 把�?�小�?��」这类中�?key 判为非法�?*/
const normalizeSubagentModelValue = (raw: string): { ok: true; value: string } | { ok: false; error: string } => {
  const s = (raw ?? "").trim();
  const normalized = s && s.startsWith("api:") && !s.includes(":")
    ? (() => {
        const rest = s.slice(4);
        const dotIdx = rest.lastIndexOf(".");
        if (dotIdx > 0 && /[A-Za-z0-9_.\-\u4e00-\u9fa5]+$/.test(rest)) {
          return `api:${rest.slice(0, dotIdx)}:${rest.slice(dotIdx + 1)}`;
        }
        return s;
      })()
    : s;
  if (!/^(api:[A-Za-z0-9_.\-\u4e00-\u9fa5]+(:[^\s:]+)?|local:[A-Za-z0-9_.\-\u4e00-\u9fa5]+|inherit|)$/.test(normalized)) {
    return {
      ok: false,
      error: `非法模型格式：${raw}\n\n正确格式示例：\n  api:供应商名:模型名（如 api:openai:gpt-5）\n  api:供应商名（用该供应商默认模型）\n  api:小红书:dots3-note-prev（中文 key + 模型名）\n  local:本地模型名\n  inherit（沿用父 Agent 模型）\n  留空（不设置）`,
    };
  }
  return { ok: true, value: normalized };
};

/** 应用�?�?��的执行模型池：落盘（模块级真值）�?管理器就�?��同�? �?广播刷新�?
 *  ⚠️ 顺序有意�?*先落真�?�再推�?理器**（�?理器�?���?��由创建期�??兜住），
 *  这样"保存成功"�?真的生效"才是同一件事�?*/
const applySubagentModels = (models: unknown): void => {
  saveSubagentDefaultModels(models);                      // 模块级真�?+ 磁盘（唯�?真相源）
  subagentsRef?.setDefaultModels(subagentDefaultModels);  // 管理器就�?���?���?���?��创建时播�?
  mainWindow?.webContents.send("slime:resident:update", null);
};

/** A-1097：�?选执行模型池�?*池�? = 执�?兜底�?*）�??
 *  逐项归一化，**任一项非法即整体拒绝并指名是�?���?* —�??不做「静默丢弃非法项」：
 *  静默丢弃 = 用户以为选上了�?�实际没生效（本项目的静默失效�?族）�?*/
const setSubagentModels = (models: unknown): { ok: true; defaultModels: string[] } | { ok: false; error: string } => {
  const list = Array.isArray(models) ? models : [];
  const out: string[] = [];
  for (const [i, item] of list.entries()) {
    const r = normalizeSubagentModelValue(typeof item === "string" ? item : "");
    if (!r.ok) { return { ok: false, error: `�?${i + 1} 项：${r.error}` }; }
    // "inherit" �?不�?�?的占位，不是档位 �?不进池（�?normalizeModelPool 同口径）�?
    if (r.value && r.value !== "inherit") { out.push(r.value); }
  }
  applySubagentModels(out);
  return { ok: true, defaultModels: [...subagentDefaultModels] };
};

/** 旧�?�道（单值）：�?�?= **把池子整体换�?�?���?�?���?的池**�?
 *  ⚠️ 刻意不做�?�?��池�?"：那会�?�出"面板显示池�?新�?��?�池里其余档位还�?的两套真相源�?
 *  �?UI 调它时，用户意图�?��就是"执�?档就这一�?�?*/
const setSubagentDefaultModel = (model: unknown): { ok: true; defaultModel: string; defaultModels: string[] } | { ok: false; error: string } => {
  const r = normalizeSubagentModelValue(typeof model === "string" ? model : "");
  if (!r.ok) { return { ok: false, error: r.error }; }
  applySubagentModels(r.value ? [r.value] : []);
  return { ok: true, defaultModel: r.value, defaultModels: [...subagentDefaultModels] };
};

// A-1096：`userData/subagent-selection.json` **已�??�?*（原 A-918+ �?用户勾�?�子代理"�?��文件）�??
// �?役原因：它是**�?��套真相源** —�??Agent 设置里没有�?应开关，用户在这�?��件里勾了�?么�??
// �?Agent 详情里完全看不出来；且默认为�?�?�?�� Agent �?�?��派不出去�?配好了也派不�?）�??
// 现在授权判据�?��收敛�?`config/agents.json` �?`subagent_dispatch` 字�?�?
// ⚠️ 不做静默迁移也不删旧文件：新�?���?缺省即允�?，比旧清�?*更�?**，不会�?任何 Agent 失去能力�?
//    用户若想收回授权，在 Agent 设置里关掉即�?���?关的初�?�按字�?缺省 = 允�?回显）�??
/** 托盘图标提示�?��随主窗口�??性变化（用户�?眼能看出"它还在后�?）�??*/
const syncTrayTooltip = (): void => {
  try {
    const visible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
    tray?.setToolTip(visible ? "Slime — 运行中" : "Slime — 已最小化到托盘（点击恢复）");
  } catch { /* 托盘已销�?�?无事�?�� */ }
};

/** 托盘点击/菜单：显示↔隐藏主界�?��窗口不可见时恢�?并聚焦）�?*/
const toggleMainWindow = (): void => {
  const w = mainWindow;
  if (!w || w.isDestroyed()) { return; }
  try {
    if (w.isVisible() && !w.isMinimized() && w.isFocused()) { w.hide(); }
    else {
      if (w.isMinimized()) { w.restore(); }
      w.show();
      w.focus();
    }
  } catch { /* 窗口状�?�瞬�?�?忽略 */ }
  syncTrayTooltip();
};

/**
 * A-1075（Issue 5）：应用图标�?*�?��出�?** —�??托盘 / 任务栏窗�?/ 任何�?要图标的地方都调它�??
 *
 * 为什么不各�?各写�?�?`join(INSTALL_ROOT, "build", "icon.png")`：写错一处就�?某个地方图标不�?"�?
 * 而这�?*静默失效**�?tsc、过构建、过全部逻辑测试 —�??�?��用户桌面上看得�?（本�?§21 同类）�??
 *
 * 【为�?�?Windows �?`.ico` 而不�?���?1024×1024 �?PNG�?
 * 用户报告的是「任务栏/托盘图标异常」�?�实测资产：`build/icon.png` = **1024×1024 / 951.7 KB**�?
 * 而这两�?�?*实际渲染尺�?**�?��托盘 16 px�?00% DPI �?32 px）�?�任务栏 24/32/48 px�?
 * �?等于每�?都�?系统把一�?1024² 位图**现场�?*到十几像素：观感糊，而且每�?都�?读近 1 MB�?
 * `build/icon.ico`（由 `gui/scripts/make-notify-icon.mjs` 生成）里**逐尺寸�?�?*�?
 * 16/24/32/48/64/128/256 七张位图�?6×16 那张�?�� 0.75 KB），系统按需取用 �?**全程零缩�?*�?
 * 这与 #228「�?�知图标」是同一类问题的同一�?��法（渲染处需要�?大就给它多大）�??
 *
 * ⚠️ �?Windows **必须**回落 PNG：Electron �?Linux / macOS 上�?不了 `.ico`�?
 * ⚠️ �?�?���?���?�?��也可能失败（资产缺失 / 解码不出）�?��??�?以这�?*先探�?�?*�?
 *   读不出来就回�?PNG **并出�?*，绝不把托盘图标变成静默空白�?*/
const resolveAppIcon = (): string => {
  const preferred = join(INSTALL_ROOT, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
  try {
    if (!nativeImage.createFromPath(preferred).isEmpty()) { return preferred; }
  } catch { /* 解码抛错 �?走回�?*/ }
  const fallback = join(INSTALL_ROOT, "build", "icon.png");
  console.warn(`[gui:main] 应用图标 ${preferred} 读不出来，回�?${fallback}`);
  return fallback;
};

/**
 * A-1092：窗口图标�?交给**已解码的 `nativeImage`**，�?�不�?��径字符串�?
 *
 * 为什么：`BrowserWindow({ icon: "xxx.ico" })` 传字符串时，Electron �?Windows 上把�?��交给
 * 系统按默认方式加�?—�??**多尺�?ICO 里挑�?��张由系统决定**，且不同 DPI 下可能重新采样，
 * 小尺寸（16/24/32）偶发糊成白块�?�传 `nativeImage` �?Electron 直接�?*�?有内嵌尺�?*
 * �?起交给系统（`GetIconSizes` 能拿�?16/24/32/48/64/128/256 全�?），任务栏按当前 DPI
 * 精确取用�?*不做二�?缩放**�?
 *
 * ⚠️ 解码失败必须**回落**且出声，不能把窗口图标变成静默空白（�?`resolveAppIcon` 同一�?��）�??
 *   这里**不缓�?*：本函数�?��建窗口时调用�?次，缓存�?�?nativeImage 反�?�会�?
 *   "换台机器资产不同"这类场景读到旧�?象�??
 */
const resolveAppIconImage = (): Electron.NativeImage | undefined => {
  const p = resolveAppIcon();
  try {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) { return img; }
  } catch { /* 解码抛错 �?回落 undefined（Electron �?exe 内嵌图标兜底�?*/ }
  console.warn(`[gui:main] 窗口图标 nativeImage 解码失败（${p}），交由 Electron 兜底`);
  return undefined;
};

/**
 * 建立托盘图标（幂等）�?
 *
 * A-1055�?*改为"应用�?�?��就有"**�?
 * 以前�?�� `exitModeStore === "background"` 且用户关�?��口时才建（�? close 处理）�?��??
 * 于是用户看到的是反过来的现象：�?�不要的时�?�一直显示着（�??出后残留/后台模式才出现）�?
 * 要的时�?�没了（窗口�?�?时托盘栏里根�?���?slime）�?��?�托盘是**应用存在�?*的载体，
 * 应当�?`whenReady` 建完窗口后就常驻，�?�不�?���?要藏起来"才出现�??
 */
const ensureTray = (): void => {
  if (tray) { return; }
  try {
    const iconPath = resolveAppIcon();
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip("Slime — 运行中");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示 / 隐藏主界面", click: toggleMainWindow },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          appIsQuitting = true;
          tray?.destroy(); tray = null;
          app.quit();
        },
      },
    ]));
    tray.on("click", toggleMainWindow);
    syncTrayTooltip();
  } catch (e) {
    tray = null;
    console.warn("[gui:main] 托盘图标创建失败（不影响主流程）:", e instanceof Error ? e.message : String(e));
  }
};
import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, session, shell, Tray, Menu, nativeImage } from "electron";
import { join, resolve, sep, dirname, basename, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
/* A-1139：终�?��再用 `exec`（它永远�?��台默�?shell，且�?UTF-8 解输�?�?�?��乱码）�??
   现在�?�� `spawn` 选定�?shell，输出按 `decodeBytes` 解码 —�??详�? `runShellCommand`�?*/
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
/* A-1133：本地文�?能不能交�?Chromium 渲染"�?*�?��判据**（与渲染层共用同�?份）�?*/
import { classifyFile, isNavigableLocalFile, nonNavigableReason } from "../../../core-ts/src/office/fileKinds.js";
/* A-1133：工作文档抽文本 / 生成（纯模块，判�?���?core-ts，主进程�?��运）�?*/
/* ⚠️ A-1133 收口：Office 抽文�?*仓库里早就有**（`core-ts/src/doc_text.ts`，连 .doc/.xls/.ppt �?
   OLE 都能抽，`file_read` �?直在�?��。不要为文档通道再养�?��份实现（铁律 11）�??*/
import { extractDocText, extractOleText, docKindFromExt, oleKindFromExt } from "../../../core-ts/src/doc_text.js";
import { writeDocument, type DocFormat } from "../../../core-ts/src/office/docWrite.js";
/* ⚠️ A-1133：渲染页落盘�?*命名�?��产地**（`path` �?`name` 必须同源，否则右栏按 name �?URL �?404
   �?整页空白，用户实测过）�?�别在这里自己拼文件�?—�??两个产地必然漂�??*/
import { previewHtmlPath } from "../../../core-ts/src/previewPage.js";
/* ⚠️ A-1136�?*保真渲染�?*（人看）的唯�?产地 —�??与上�?`docs:htmlPreview`（抽文本重排版）�?��条路线�??
   �?��件只负责"�?IPC + 给目�?文件�?，渲染库与页面模板都�?`docRenderPage.ts` 里（�?��这里再写�?份）�?*/
import { writeRenderPage, writePdfViewerPage, pdfViewerPaths } from "./docRenderPage.js";
import { planRender, fallbackRender } from "../../../core-ts/src/office/renderPlan.js";
/* ⚠️ 阶�? C：�?�版 Office�?doc/.xls/.ppt）→ PDF �?*�?��产地**。两条硬约束写在它自己的文件头：
   绝不 `spawnSync`（阻塞主进程事件�?��）�?�不留文件（用户�?每�?�?��"）�?�本文件�?��责接 IPC�?*/
import { convertToPdf, cleanupConvertDir, probeLibreOffice } from "./libreofficeConvert.js";
import { installAdBlocker } from "./adblock.js";
import { basePortFor, getModelServer, ModelServerManager, setModelServer } from "../../../core-ts/src/model_server.js";
// S1：本地服务能�?*�??**（`/props` + `/v1/models`）�?�纯逻辑�?core-ts/src/model_introspect.ts�?
// 这里�?��"发�?�?+ 缓存"的部分；resolveSessionWindowCap �?���?���?��的�?取�?��??
import { capabilityMatchesModel, clearLocalCapabilityCache, getLocalCapability, isLoopbackBaseUrl, probeManagedChatCapability } from "./localServerProbe.js";
import { resolveWindowCap } from "../../../core-ts/src/model_introspect.js";
import { ChatService } from "../../../core-ts/src/services/chat.js";
import { SchedulerService } from "../../../core-ts/src/services/scheduler.js";
import { SubAgentManager, DEFAULT_EXEC_BUDGET_MS, normalizeModelPool, sanitizeSubagentRunName } from "../../../core-ts/src/services/subagent.js";
import {
  dispatchableAgentIds,
  dispatchableSubagentDefinitions,
  groupSubagentCatalog,
  isSubagentDispatchAllowed,
  renderSubagentCatalogLines,
  renderSubagentModelSegments,
} from "../../../core-ts/src/services/subagentCatalog.js";
import { setSubagentManager, setMemoryStoreProvider, setAdbService, setHttpServer, setScreenController, setTrashService } from "../../../core-ts/src/tools/builtin.js";
// A-1121（②）：右栏打开请求的归�?�?*�?��数�?�唯�?出�?**（core-ts），主进程只做转�?
import { setSidebarOpener, normalizeSidebarOpenRequest } from "../../../core-ts/src/sidebarOpen.js";
/* A-1144：右栏�?�挂载�?�的收件口（渲染层上�?�?core-ts �?`ChatService` 每轮注入系统提示）�??*/
import { setSidebarMount } from "../../../core-ts/src/sidebarMount.js";
// A-1122（③）：子代理会话前�?的唯�?出�?（�?�?gui/main �?todoStore 各有�?份字面量�?
import { SUBAGENT_SESSION_PREFIX } from "../../../core-ts/src/services/subagent.js";
import { setBrowserAdapter } from "../../../core-ts/src/tools/browser.js";
import { BrowserBridge } from "./browserBridge.js";
import { StreamChunkBatcher } from "./streamBatch.js";
import { adbService, type AdbDetect, type AdbDevice, type AdbCmdResult, type AdbScreencapResult, type AdbDownloadProgress } from "./adb.js";
import { annotateBitmap } from "../shared/imageAnnotate.js";
// A-1012：群聊席位上限与参与名单判据�?*�?��实现**（引擎与建群弹窗共用，杜�?上限�?��引擎知道"�?
import { groupParticipantIds } from "../../../shared/gen/groupRoster.js";
import { httpServer } from "./httpServer.js";
// A-1137：搜索页宿主桥（guest preload �?main �?对话侧）�?
// ⚠️ �?��基于 frame URL 的白名单 —�??它的 sender �?���?webview �?guest�?
// 不是主窗口，走不�?`handleTrusted` �?`isTrustedSender`�?
import { registerSearchBridge, pushSearchTheme, ensureSearchPage } from "./searchBridge.js";
// A-1138：自建全网索引服务（�?�� / 索引 / 服务都在 slime 进程内，不再 spawn Python 三件套）
import { registerSearchIndexIpc, startSearchIndexService } from "./searchIndexService.js";
// A-1137：�?�主程序主�? �?搜索页主题�?�的**�?��产地**（两边各有一套真名，�?��必须有一处翻译）
import { searchThemeOf } from "../shared/searchTheme.js";
import { createServer } from "node:http";
import { ServerA2ABus } from "../../../core-ts/src/a2a.js";
import { StatsService } from "../../../core-ts/src/services/stats.js";
// A-980-R29：待办存储唯�?真源（工具与主进程共�?���?��各自手搓�?��/解析�?
import { readTodos, removeTodos, writeTodos, todosToPlanStatus, demoteStaleInProgress } from "../../../core-ts/src/services/todoStore.js";
// A-1066：本�?���?�?清空待办�?*判据**（纯模块；口径与竞�?�防护都在里�?���?�� finally 里另写一份）
import { shouldClearTodosOnTurnEnd } from "../../../core-ts/src/services/todoLifecycle.js";
/* A-1069�?226）：Agent �?��的后台资源面�?—�??判据全在�?��块（`buildAgentProcView` /
   `planAgentProcStop`），主进程只做两件事：从活真�?*取数**、按动作**执�?**�?*/
import {
  buildAgentProcView,
  planAgentProcStop,
  type AgentProcSources,
} from "../../../core-ts/src/services/agentProcs.js";
// A-1060：中途�?�引导�?�（steer）缓�?—�??装配层只负责推进�?/ 流结束时清干�?�?
// **消费�?*�?core-ts 的工具循�?��次边界（�?core-ts/src/tool_loop.ts �?injectSteers）�??
import { pushSteer, clearSteers, dropSteer } from "../../../core-ts/src/services/steerBus.js";
import { loadUsage, clearUsage, rewriteUsageCosts } from "../../../core-ts/src/services/usage.js";
import { getLlmGatewayManager, readLlmGatewayConfig, type LlmGatewayConfig } from "./llmGateway.js";
/* A-1139：内�?���??�配主机�?��终�?组件�?
   判据（�?�每�?shell 各自怎么调�?�）�?`core-ts/src/terminal/profiles.ts`（纯函数、可单测）；
   探测（�?�这台机器上有哪�?shell」）�?IO �?��产地�?`./termProfiles.js`（异步�?�带缓存）；
   解码（中文不再乱码）收归 `core-ts/src/text/encoding.ts`。主进程这里�?��"装配"�?*/
import { getTermProfiles } from "./termProfiles.js";
import { resolveProfile, pickDefaultProfile, shellInvocation, resolveCd, type TermProfile, type TermProfileKind, type ShellInvocation } from "../../../core-ts/src/terminal/profiles.js";
import { decodeBytes } from "../../../core-ts/src/text/encoding.js";
/* �?**进程�?*的唯�?产地（Windows 必须 `taskkill /T`）�?��??⚠️ GUI 主进�?*禁�?**出现
   `taskkill` 字面量（守卫 `tests/core-ts/a1023-guards.spec.ts`），�?以走这个导入�?*/
import { killProcessTree } from "../../../core-ts/src/procKill.js";
import { AgentRegistry, type AgentState } from "../../../core-ts/src/services/agents.js";
import { createEngine, buildSilamTraitSignals } from "../../../core-ts/src/services/engine.js";
import { createRouteClient, type RouteEntry } from "../../../core-ts/src/router.js";
import { chromiumFetch } from "./providers.js";
import type { ChatRequest } from "../../../core-ts/src/services/chat.js";
import type { StreamChunk, ChatInput, AgentInfo, StatsSnapshot, UsageSnapshot, UsageRecomputeResult, SidecarStatus, PermissionDecision, PermissionRequestUI, PermissionOption, AskUserRequestUI, AskUserDecision, WorkspaceEntry, WorkspaceListResult, WorkspaceReadFileResult, TermResult, GitDetect, GitInfo, GitAction, GitCloneResult, GitDiffResult, CompressResult, ResidentState, AgentProcsListResult, AgentProcsStopRequest, AgentProcsStopResult, TermProfilesResult } from "../shared/ipc.js";
import { isBrowserSchemeUrl } from "../shared/ipc.js";
import { parseUnifiedDiff } from "./git_diff.js";
import { initUpdater, registerUpdaterHandlers, setStatusSink } from "./updater.js";
import {
  listProviders, enrichModels, saveProvider, removeProvider, clearAllProviders, refreshProviderModels,
  listLocalModels, saveLocalModel, removeLocalModel, scanLocalModels,
  buildPriceResolver,
  type ProviderSummary, type LocalModelSpec,
} from "./providers.js";
import { overview as configOverview, readConfigFile, writeConfigFile, setMcpEnabled, setSkillEnabled, deleteSkill, deleteMcp, skillDirPath } from "./config_files.js";
// A-980-R26：系统�?�知 + �?��制提示音（�?�?�?通用�?
import { initNotify, notifyUser, readNotifyConfig, writeNotifyConfig, importSound, clearSound, readSoundData, customSoundPath } from "./notify.js";
// A-1108：全�?降级池（设置 �?通用）�?�判�?���?出�?�?core-ts �?fallbackPool 模块
// —�??主进程只做�?��?�?+ 消毒」，**不�?**在这里再写一份�?�哪些条�?���?��」的规则
// （引擎每次解析路由时读同�?�?��件，两边的口径因此不�?��漂移）�??
import { readFallbackPool, writeFallbackPool } from "../../../core-ts/src/services/fallbackPool.js";
// A-1092：任务栏图标归属 —�??AUMID �?*进程�?*�?��，必须在 `whenReady` 之前、且早于任何
// 窗口/托盘创建就�?好（`initNotify` 里那次是窗口创建前调�?��仍晚�?Electron 的初始身份绑定）�?
import { APP_AUMID } from "./notifyIdentity.js";
import { getPermissions, setPermissions, type GuiPermissions } from "./permissions.js";
import { SlimeEngine } from "../../../core-ts/src/services/engine.js";
import { SilamBrainClient, readSilamConfig, type SilamBrain, type SilamAffectState } from "../../../core-ts/src/services/silam_brain.js";
import { decryptRaw } from "../../../core-ts/src/encryption.js";
import { removeAgentHistory, loadHistory, appendHistory, attachTimelineToRecord, type HistoryRecord } from "../../../core-ts/src/services/history.js";
import { SkillRegistry, loadAllSkills } from "../../../core-ts/src/skills.js";
import { getKnowledgeEngine } from "../../../core-ts/src/memory/knowledge.js";
import { getRegistry, setToolCategoryGate } from "../../../core-ts/src/tools/registry.js";
import type { GrantSwitches } from "../../../core-ts/src/tools/grant.js";
import { targetFromArgs } from "../../../core-ts/src/tools/hard_rules.js";
import { gateToolCall, classifyToolCall } from "../../../core-ts/src/tools/policy.js";
import {
  getScreenController,
  DesktopScreenBackend,
  AndroidScreenBackend,
  setImageOptimizer,
  setImageDiffer,
} from "../../../core-ts/src/screen/index.js";
import { MemoryStore, resolveMemoryPaths, setLancedbModuleLoader } from "../../../core-ts/src/memory/store.js";
import { requireLancedb, lancedbComponentStatus, type LancedbComponentStatus } from "./__stubs/lancedb-stub.js";

/**
 * A-1041：�?面�?注入 LanceDB 的模块加载器 —�??按�?�内嵌组件目录�?�加载真实包�?
 *
 * 为什么不直接�?core-ts `import("@lancedb/lancedb")` �?vite alias�?
 * 实测顶层 alias �?main target �?alias 都写了，rollup 仍把真实包内联进产物
 * （`out/main/chunks/lancedb.win32-x64-msvc-*.node`�?97MB）�?�改成注入后�?
 * bundle 里不再出现这�?�� specifier，native 无从进入 —�??安�?包瘦�?��此成立�??
 */
setLancedbModuleLoader(async () => requireLancedb() as { connect: (uri: string) => Promise<unknown> });
import { createTrace, beginSpan, endSpan, emitEvent, attachEval, type Trace, type TraceEventKind } from "../../../core-ts/src/observability/trace.js";
import { parsePlan, type Plan, type PlanStageStatus } from "../../../core-ts/src/planning/plan.js";
import { runGroupTalk, parseMentions, type GroupTalkParticipant, type StreamEmit, type TranscriptLine } from "../../../core-ts/src/services/grouptalk.js";

// 全局兜底：任何未捕获�?Promise rejection 不得终�?主进程�?��?�Node 默�? throw 模式会�?
// 整个应用直接�?出（用户感知�?�?���?��关了"）�?��?录后继续运�?；具体�?�辑错�?仍由各调用点 try/catch 处理�?
process.on("unhandledRejection", (reason) => {
  console.error("[gui:main] �?��获的 Promise rejection（已拦截，主进程继续运�?�?", reason);
});

// �?�? D：全链路�??测（引擎 stream 真实事件�?�?trace spans �?渲染�?TraceViewer�?�?�?
// sessionId �?�?近一次�?求的 Trace �?��（内存驻留；流结束经 slime:trace:update 广播�?
//
// A-980-R24�?*加上�?*。�?前是�?`Map` 且全仓无 `delete`—�?�每�?�?�?��会话就永久�?留一�?Trace
// （含 40 �?span + 字�?串快照），长时间使用（尤其群�?�?Agent 会不�?��生新 sessionId）主进程
// 内存�??不减，是"用久了越来越卡�?�最后崩"的慢性根因之�?�?
// 现在用�?�Map 保序 = 插入序�?�做 LRU：超上限时删�?早插入的�?��并�? TTL 拒绝过期�?���?
const traceStore = new Map<string, Trace>();
const TRACE_STORE_MAX = 60;
const TRACE_STORE_TTL_MS = 30 * 60 * 1000;
function traceStoreSet(key: string, trace: Trace): void {
  // 重新插入以刷�?LRU 位置（Map �?set 对已存在�?��改顺序，故先删再插）
  traceStore.delete(key);
  traceStore.set(key, trace);
  while (traceStore.size > TRACE_STORE_MAX) {
    const oldest = traceStore.keys().next();
    if (oldest.done) { break; }
    traceStore.delete(oldest.value);
  }
}
/** 读取前的过期清理（TraceViewer 拉取旧会话时�?��过期直接当没有） */
function traceStoreGet(key: string): Trace | undefined {
  const t = traceStore.get(key);
  if (!t) { return undefined; }
  const at = t.endedAt ?? t.startedAt;
  if (Number.isFinite(at) && Date.now() - at > TRACE_STORE_TTL_MS) {
    traceStore.delete(key);
    return undefined;
  }
  return t;
}
/** chunk/reasoning �?token 级事件采样上限，防�? spans 爆炸 */
const TRACE_SAMPLE_CAP = 40;
function capStr(s: string, n: number): string {
  return typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s;
}

/** 单�?请求�?trace 记录�?��把引擎事件映射为带时间的 span，�?求结束收敛（success/eval）�??*/
class TraceRecorder {
  private trace: Trace;
  private counts = new Map<string, number>();
  constructor(sessionId?: string) {
    const t = createTrace({ sessionId });
    this.trace = beginSpan(t, { name: "turn:start", kind: "route_select" }).trace;
  }
  /** 事件推进（tool �?call+result 双联 span；chunk/reasoning 采样；error �?eval 失败）�??*/
  push(ev: { type: string; data?: unknown }): void {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === "tool") {
      const name = String(d.name ?? "");
      const { trace, spanId } = beginSpan(this.trace, {
        name: `tool:${name}`,
        kind: "tool_call",
        data: { args: capStr(String(d.args ?? ""), 200) },
      });
      this.trace = endSpan(trace, spanId, { result: capStr(String(d.result ?? ""), 240) });
      return;
    }
    const kindOf: Record<string, TraceEventKind> = { chunk: "reply_chunk", reasoning: "reasoning_chunk" };
    const kind = kindOf[ev.type];
    if (!kind) { return; }
    const n = (this.counts.get(kind) ?? 0) + 1;
    if (n > TRACE_SAMPLE_CAP) { return; }
    this.counts.set(kind, n);
    this.trace = emitEvent(this.trace, kind, kind === "reply_chunk" ? "chunk" : "reasoning", {
      idx: n,
      content: capStr(String(d.content ?? ""), 160),
    });
  }
  /** 收敛：失败时�?completion eval=false + 错�?，成功挂 eval=true；统�? done 收尾�?*/
  finish(ok: boolean, notes?: string): Trace {
    this.trace = attachEval(this.trace, "completion", ok, ok ? undefined : capStr(notes ?? "", 200));
    return emitEvent(this.trace, "done", "turn:done");
  }
  get(): Trace { return this.trace; }
}

/** D IPC：�?取某会话�?近一�?trace；渲染层 TraceViewer �?*/
function registerTraceHandlers(): void {
  ipcMain.handle("slime:trace:get", (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== "string") { return null; }
    const t = traceStoreGet(sessionId);
    return t ? { sessionId, ...t } : null;
  });
}

// �?�? E：Plan �?等�?象（plan_create/plan_update/todo_write 工具返回 �?会话�?planStore �?PlanPanel�?�?�?
// sessionId �?当前 Plan（内存驻留；工具结果流经 slime:plan:update 广播；重�?���?��工具输出重建�?
const planStore = new Map<string, Plan>();
/** planStore 上限：只用于展示的派生数�?��没必要无限驻留（超限�?updatedAt 淘汰�?旧） */
const PLAN_STORE_MAX = 64;
const PLAN_TOOLS = new Set(["plan_create", "plan_update", "todo_write"]);

/**
 * A-980-R30：子代理管理器引�?���?fixedSegments 注入「可用子代理」清单）�?
 *
 * 为什么需要这�?���?��此前�?��子代理只活在管理器内�?��**模型完全不知道能�?��** —�??
 * 工具描述里硬编码三个方向，用户勾选的�?�� Agent 名字从不进提示词，于�?配好了也派不�?�?
 * Claude Code 的做法是�?name + description 清单写进上下文，模型才能按描述自动�?�人或显式点名�??
 */
let subagentsRef: SubAgentManager | null = null;

/** 把子代理�?��渲染成系统提示�?（无任何子代理时返回空数组，不占上下文） */
function subagentCatalogSegment(): string[] {
  const cat = subagentsRef?.catalog?.() ?? [];
  if (cat.length === 0) { return []; }
  // A-1096：分组与标�?改走 `services/subagentCatalog.ts` �?*�?��出�?**�?
  // 此前这里�?`tools/builtin.ts::subagentCatalogHint` 各写�?遍分�?+ 标�? �?�?处改了另�?处没改，
  // 模型/用户会看到两套互相矛盾的说法（同�?�?��两个渲染产地必须同源）�??
  const lines = [
    "## 可用子代理（delegate_subagent）",
    "你可以把**独立、自包含**的子任务交给下列子代理并行执行（各自独立上下文与工具面，产出会作为工具结果交回给你验收）：",
    ...renderSubagentCatalogLines(groupSubagentCatalog(cat)),
  ];
  lines.push('用法：`delegate_subagent({ agent: "<上面的名字>", task: "目标 + 期望输出格式 + 边界" })`；不点名则由系统按任务语义自动选。');
  lines.push("派发后**必须验收**产出：对照目标核对是否真的完成、产物是否落地；存疑就点名同一子代理追问，或自己补齐——不要把子代理的结论不加核对地当事实转述给用户。");
  // A-1097：执行模型池也必须进上下文，否则用户在�?�?��多�?�了�?堆档位�?�模型却�?�?��不知�?
  // �?"能�?�?��没人�?（�?�?关）。池首是兜底档，其余供按子任务难度点名�?�作�?*�?���?*追加（自己带 ## 标�?）�??
  return [lines.join("\n"), ...renderSubagentModelSegments(subagentsRef?.getDefaultModels?.() ?? subagentDefaultModels)];
}

/**
 * A-1106：把「当前允许�?派发�?Agent」重新登记进子代理�?理器�?
 *
 * ⚠️ **为什么必须是�?��入的**（�?�不�?��动时算一次就完）：Agent �?*增删�?*都会改变
 * 「谁�?���?��发�?��?��??新建 / fork / 删除 / 改�?�?/ 导入�?��包�?��?前本函数�?��在启动期
 * 那一段惰性�?配里（�?加�?��?�?��勾�?��?�一�?��口），于�?*新建出来�?Agent 永远进不了清�?*�?
 * 用户配好了子代理、主 Agent 却在系统提示里看不到它�?�也就永远调不动
 * （症状是「整�?��务全�?�� Agent �?�?��能体做�?�，而日志与门�?全绿）�??
 *
 * ⚠️ 参数**显式传入管理�?*而不�?���?`subagentsRef`：启动期那�?调用发生�?
 * `subagentsRef = subagents` **之前**，只读模块级引用会静默拿�?`null`
 * �?「改了但没生效�?��?��?��?�?��项目�?忌�?的一类缺陷（�?ref-engineering §23）�??
 *
 * 返回�?��真的登�?成功，便于调用方（与测试）断�?�?
 */
function syncDispatchableSubagents(mgr: SubAgentManager | null = subagentsRef): boolean {
  if (!mgr) {
    // 不静默：管理器未装配时�?实出声�?�否则�?�清单没刷新」会�??读成「没有可派发�?Agent」�??
    console.warn("[subagent] 管理器尚未装配，本次「可派发清单」刷新被跳过（装配时会统一登记一次）");
    return false;
  }
  const defs = dispatchableSubagentDefinitions(agentRegistry?.loadedAgents ?? []);
  mgr.setUserSelected(defs);
  if (defs.length > 0) {
    console.log(`[subagent] 已登记 ${defs.length} 个可派发 Agent 子代理：${defs.map((d) => d.name).join("、")}`);
  } else {
    console.log("[subagent] 当前没有被授权派发的自建 Agent（均已在 Agent 设置里关闭）—— 仅内置专家可用");
  }
  return true;
}


/** 会话�?��除时清掉�?Plan 与待办文件（此前两�?�都�??不减：内存常�?+ data/ 堆垃圾） */
function purgeSessionPlanning(sessionId: string): void {
  if (!sessionId) { return; }
  planStore.delete(sessionId);
  removeTodos(sessionId);
}

/**
 * 解析工具返回：plan_create/plan_update 从结�?JSON 还原；todo_write �?`todos_<session>` 落盘文件还原�?
 *
 * ⚠️ 这是�?�?*有损的单向派�?*（真源仍�?��办文件本�?��：`todo_write` 没有�?���?Plan 对象�?
 * PlanPanel 要显示就得在这里把清单映射成「阶段�?��?�因此必须：
 * �?�?`todoStore.readTodos` 读同�?份文件（�?��手搓�?��/解析）；
 * �?打上 `source: "todo"` —�??�?Plan（plan_create）优先级更高，不允�?�?��生数�?��掉（�?interceptPlanTool）；
 * �?`status` 由进度推导，**不能恒定 "planning"**（否则全做完了还显示"规划�?）�??
 */
function planFromToolResult(name: string, result: string, sessionId: string): Plan | null {
  if (name === "plan_create" || name === "plan_update") {
    const idx = result.indexOf("\n"); // 工具返回形�? "[Plan 已创建] id（�?�）\n{json}"
    const json = idx >= 0 ? result.slice(idx + 1) : result;
    const p = parsePlan(json);
    return p ? { ...p, source: "plan" } : null;
  }
  if (name === "todo_write" && sessionId) {
    const items = readTodos(sessionId); // �?sessionId / 文件缺失 / 损坏 �?[]（store 内已兜底�?
    if (items.length === 0) { return null; }
    const statusMap: Record<string, PlanStageStatus> = { pending: "pending", in_progress: "in_progress", completed: "done", done: "done" };
    return {
      id: `todo-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "s"}`,
      sessionId,
      description: items[0]!.content.slice(0, 60),
      stages: items.map((it, i) => ({
        id: it.id || String(i + 1),
        label: it.content.slice(0, 120),
        status: statusMap[it.status] ?? "pending",
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: todosToPlanStatus(items),
      source: "todo",
    };
  }
  return null;
}

/** planStore 落盘 + 淘汰超限项（�?��留最近的 N �?��话） */
function putPlan(sessionId: string, plan: Plan): void {
  planStore.set(sessionId, plan);
  if (planStore.size <= PLAN_STORE_MAX) { return; }
  const sorted = [...planStore.entries()].sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
  for (const [sid] of sorted.slice(0, planStore.size - PLAN_STORE_MAX)) { planStore.delete(sid); }
}

/**
 * A-980-R27：todo_write 落盘�?*立刻**把列表推给渲染层�?
 *
 * 此前全仓库只有�?�切会话」时�?`slime:sessions:loadTodos` 主动拉一次，
 * Agent 在会话中途写待办没有任何广播 �?右侧栏停在旧�?��上，
 * 用户体感就是"待办面板不动/像摆�?。这里在工具拦截点补上推送�??
 *
 * A-980-R29：�?取改�?`todoStore.readTodos`（与工具同一份实现）�?
 * �?*总是**广播（含空列�?��—�??否则模型 `clear` 掉待办后界面会一直留�?旧项�?
 */
function broadcastTodos(sessionId: string): void {
  if (!sessionId) { return; }
  const todos = readTodos(sessionId).map((t) => ({
    id: t.id,
    content: t.content,
    status: t.status,
    // completedAt 必须带上：界面完成标记的时间戳来源（缺了会�??化成"没有时间"的旧样式�?
    ...(t.completedAt ? { completedAt: t.completedAt } : {}),
  }));
  mainWindow?.webContents.send("slime:tasks:todos", { sessionId, todos });
  // A-980-R32：推送之后再�?�?��已全部完�? �?排一次自动清空（见�?函数注释�?
  scheduleTodoAutoClear(sessionId, todos);
}

/**
 * A-980-R32：全部完�?�?**�?��清空**待办（用户明�??求，同时移除了手动的 �?与�?�清完成」）�?
 *
 * 为什么清空必须落在主进程，�?�不�?��染层"看不见就算了"�?
 * 待办的唯�?真源�?`data/todos_<sid>.json`。渲染层 setTodos([]) �?��清掉内存镜像�?
 * 文件还在 �?下�? `slime:sessions:loadTodos`（切会话、重�??�重挂载）原样�?回来�?
 * 症状就是"界面明明清空了，重启后旧清单又�?�?�?
 *
 * 为什么�?延迟而不�?��即清：留给�?�划过�?�动画（--todo-sweep 0.36s + 沉降 0.9s）播完的时间�?
 * 否则�?后一项刚变勾就�?删掉，用户根�?��不到完成反�?�?
 * 1.5s 内若又有新的 `todo_write`（模型连�?��两�?很常见），�?时器**重置**并重新判定，
 * 避免"�?��次的定时器把�?��次刚写的、还没做完的清单清掉"�?
 */
const TODO_AUTO_CLEAR_MS = 1500;
const todoAutoClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A-985�?*�?��程已做过"僵尸 in_progress 收敛"的会�?*�?
 *
 * �?��**首�?**读某会话的待办时收敛�?次（进程刚起时一定没有活跃流，所以这�?次是安全的）�?
 * 之后不再重�?：若每�?�?次都降级，会把用�?模型刚标记的"进�?�?立刻打回待办 —�??那才�?�� bug�?
 */
const staleChecked = new Set<string>();

/** 全部完成判定�?*必须有项**（空列表不算"全部完成"，否则会�?clear �?��打架�?*/
function allTodosCompleted(todos: Array<{ status?: string }>): boolean {
  return todos.length > 0 && todos.every((t) => t.status === "completed");
}

function scheduleTodoAutoClear(sessionId: string, todos: Array<{ status?: string }>): void {
  const pending = todoAutoClearTimers.get(sessionId);
  if (!allTodosCompleted(todos)) {
    // 不再�?全完�?（模型又加了�?�?/ 用户手动取消勾�?�）�?撤销已排队的清空
    if (pending) { clearTimeout(pending); todoAutoClearTimers.delete(sessionId); }
    return;
  }
  if (pending) { clearTimeout(pending); }
  const timer = setTimeout(() => {
    todoAutoClearTimers.delete(sessionId);
    removeTodos(sessionId);
    // 清空后必须再广播�?次（空列�?��—�?�渲染层�??把面板收干净，并重置它的"刚刚完成"基线
    broadcastTodos(sessionId);
  }, TODO_AUTO_CLEAR_MS);
  todoAutoClearTimers.set(sessionId, timer);
}

/**
 * A-1066�?*�?��跑完 �?清空该会话的全部待办**（用户明�??求）�?
 *
 * 与上面的 `scheduleTodoAutoClear` 分工�?
 *   · `scheduleTodoAutoClear` —�??�?*全部完成**�?*�?1.5s 让划过动画播�?*」的收尾�?
 *   · �?���?—�??�?*�?��已经跑完**」就清，**不看完成�?*�?
 * 用户上一�?��馈的正是后�?�没做：没做完就�?��弃的清单（模型改�?/ �?求变了）
 * 会在面板上无限期挂着 —�??原话「当会话结束，待办任务直接自动清除�?��??
 *
 * ⚠️ 三件必须做�?的事�?
 *   �?**�?�� sessionId**，不�?cancelKey。待办文件名�?`data/todos_<sessionId>.json`�?
 *      cancelKey �?�� `sessionId ?? agentId` 的兜底，拿它去删会删错文�?/ 删不掉�??
 *   �?�?��就空 �?**不广�?*。否则每�?�?��束都推一次空列表，白白重�?��染层的完成基线�??
 *   �?判据（含"已�?新一�?���?这条竞�?�防护�?�以�?出错/�?��不清"的口径）�?
 *      `shouldClearTodosOnTurnEnd`，调用方�?��责把 `reason` / `stillActive` 如实报上来�??
 */
function clearTodosOnTurnEnd(sessionId: string | undefined): void {
  if (!sessionId) { return; }
  if (readTodos(sessionId).length === 0) { return; }
  removeTodos(sessionId);
  // 清空后必须广�?��空列�?��—�?�否则界面留�?旧项，用户看到的�?没清�?（同�?�?��默失败）
  broadcastTodos(sessionId);
}

/**
 * 工具�?���?��Plan 类工具结�?�?planStore 更新 + 广播渲染层�??
 *
 * A-980-R29：两条�?划链�?��`plan_create` �?Plan / `todo_write` 派生 Plan）共用同�?�?sessionId key�?
 * 原先后到的会**顶掉**先到�?�?模型�??顺手调一�?todo_write，就能把用户正在看的�?Plan 冲掉�?
 * 现在�?`source` 定优先级：真 Plan 不�?派生 Plan 覆盖（派�?Plan �?���?�� Plan 覆盖）�??
 */
function interceptPlanTool(ev: { type: string; data?: unknown }, sessionId: string): void {
  if (ev.type !== "tool" || !sessionId) { return; }
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const name = String(d.name ?? "");
  if (!PLAN_TOOLS.has(name)) { return; }
  // 待办列表走独立�?�道（右侧栏「待办任务�?�面板�?�?slime:tasks:todos），
  // �?PlanPanel �?slime:plan:update 并�?�?��两个面板各自即时刷新
  if (name === "todo_write") { broadcastTodos(sessionId); }
  const result = String(d.result ?? "");
  const plan = planFromToolResult(name, result, sessionId);
  if (!plan) { return; }
  const prev = planStore.get(sessionId);
  if (plan.source === "todo" && prev?.source === "plan") {
    // 会话已有�?Plan：派生数�?��做兜底，不顶掉真 Plan
    return;
  }
  putPlan(sessionId, plan);
  mainWindow?.webContents.send("slime:plan:update", { sessionId, plan });
}

/** E IPC：�?取某会话的当�?Plan；渲染层 PlanPanel/StatusPanel �?*/
function registerPlanHandlers(): void {
  ipcMain.handle("slime:plan:get", (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== "string") { return null; }
    return planStore.get(sessionId) ?? null;
  });
}

// �?�? A-950：群聊发�?调度主线（@ �?�� + 抢答/顺序 + 全程流式 + 思�?�事件） �?�?

/** A-955：流式拆分�?文中�?<thinking>�?/thinking>—�??
 *  思�?��?重定向给 onThink（进右栏碰撞流），�?文只输出标�?外文�?��
 *  �?��标�?�?chunk 与未�?��结尾兜底（未�?��尾巴 �?视为思�?�，正文不回显）�?*/
function makeThinkingStripper(onText: (s: string) => void, onThink: (s: string) => void): { push: (chunk: string) => void; finish: () => void } {
  const OPEN = /<thinking(?:\s[^>]*)?>/i;
  const CLOSE = /<\/thinking\s*>/i;
  const OPEN_PREFIX = "<thinking";
  const CLOSE_PREFIX = "</thinking";
  // 判断 s �?��为标签的前缀（区分大小写不敏感�?�且不含已闭合的 >�?
  const isPrefixOf = (full: string) => (s: string): boolean => {
    const up = s.toLowerCase();
    return !up.includes(">") && up.length > 0 && up.length <= full.length && full.startsWith(up);
  };
  const isOpenPfx = isPrefixOf(OPEN_PREFIX);
  const isClosePfx = isPrefixOf(CLOSE_PREFIX);
  /** buf �?��若挂�?�?���?���?��标�?的前�?（从�?后一�?'<' 起），返回�?尾巴；否�?null */
  const prefixTail = (pred: (s: string) => boolean): string | null => {
    const idx = buf.lastIndexOf("<");
    if (idx < 0) { return null; }
    const s = buf.slice(idx);
    return pred(s) ? s : null;
  };
  let buf = "";
  let inThink = false;
  const scan = (): void => {
    while (true) {
      if (inThink) {
        const m = CLOSE.exec(buf);
        if (m) {
          if (m.index > 0) { onThink(buf.slice(0, m.index)); }
          buf = buf.slice(m.index + m[0].length);
          inThink = false;
          continue;
        }
        const t = prefixTail(isClosePfx);
        if (t) { buf = buf.slice(0, buf.length - t.length); }
        if (buf) { onThink(buf); buf = ""; }
        if (t) { buf = t; }
        return;
      }
      const o = OPEN.exec(buf);
      if (o) {
        if (o.index > 0) { onText(buf.slice(0, o.index)); }
        buf = buf.slice(o.index + o[0].length);
        inThink = true;
        continue;
      }
      const t = prefixTail(isOpenPfx);
      if (t) { buf = buf.slice(0, buf.length - t.length); }
      if (buf) { onText(buf); buf = ""; }
      if (t) { buf = t; }
      return;
    }
  };
  return {
    push: (chunk: string) => { buf += chunk; scan(); },
    finish: () => { if (buf) { onThink(buf); buf = ""; } inThink = false; },
  };
}
// 组�?�?ServiceEvent 风格 {seq,type,data} 事件流（member/done�? 状�?�事件（slime:brainstorm:event）�??
async function* streamGroupTalkFlow(opts: {
  engine: SlimeEngine;
  members: AgentState[];
  topic: string;
  sessionId?: string;
  networkEnabled?: boolean;
}): AsyncGenerator<{ seq: number; type: string; data: Record<string, unknown> }> {
  const started = Date.now();
  let seq = 0;
  const broadcastStatus = (payload: Record<string, unknown>): void => {
    if (!opts.sessionId) { return; }
    mainWindow?.webContents.send("slime:brainstorm:event", { sessionId: opts.sessionId, ...payload });
  };
  // A-951：每成员�?��上下文池—�?��?账（prompt 字�?估算 �?.6 token/字）�?右栏进度�?& 超阈值压�?
  const estTok = (s: string): number => Math.round(((s ?? "").length || 0) * 0.6);
  const usage = new Map<string, { used: number; cap: number }>();
  const QUOTA = 0.8; // 80% 触发压缩
  const capOf = (agent: AgentState): number => {
    const raw = (agent as { max_context?: unknown }).max_context;
    return typeof raw === "number" && raw > 0 ? raw : 32000;
  };
  const noteUsage = (agent: AgentState, prompt: string): void => {
    const cur = usage.get(agent.id) ?? { used: 0, cap: capOf(agent) };
    cur.used += estTok(prompt);
    usage.set(agent.id, cur);
  };
  const quotaOf = (id: string): { used: number; cap: number } => usage.get(id) ?? { used: 0, cap: 32000 };
  // 压缩：超 80% �?讨�?记录每�?�?�� 60 字（保�?�?+ 观点要点），标注已压缩；
  // 压缩后按压缩视图重新记账—�?�进度条反映该成员池�?当前足迹"而非�??投入
  const compressTranscript = (memberId: string, transcript: TranscriptLine[]): TranscriptLine[] | undefined => {
    const u = quotaOf(memberId);
    if (u.used < u.cap * QUOTA) { return undefined; }
    const packed = transcript.map((l, i) => (i === 0 ? l : { ...l, content: l.content.slice(0, 60) + "…" }));
    const packedTokens = estTok(transcript.map((l) => l.content).join("\n"));
    if (u.used > packedTokens) { usage.set(memberId, { used: packedTokens, cap: u.cap }); }
    return packed;
  };
  // 成员流式发言（engine.stream：�?��??正文边到边；思�?�摘要另发状态事件）
  const toParticipant = (agent: AgentState): GroupTalkParticipant => {
    // A-1011：推理强度不再写�?high —�??由成员组装�?按会话成员卡设置注入（readEffort ?? "high"），
    // 这里�?��兜底（万�?调用方没注入，保持改前的 high 行为）�??
    const thinking = { ...agent, reasoning_effort: agent.reasoning_effort || "high" };
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      speakStream: async (prompt: string, e: StreamEmit): Promise<string> => {
        let rep = "";
        noteUsage(agent, prompt); // �?��记账
        const quota = quotaOf(agent.id);
        broadcastStatus({ memberId: agent.id, name: agent.name, state: "thinking", used: quota.used, cap: quota.cap });
        // A-955：�?文中�?<thinking>�?/thinking> 全部拆出→�?��?�流；�?文干�?、�?��?�进右栏碰撞�?
        const split = makeThinkingStripper(
          (t) => { e.chunk(t); rep += t; },
          (t) => {
            e.reasoning(t);
            broadcastStatus({ memberId: agent.id, name: agent.name, state: "thinking", chunk: t, ...quotaOf(agent.id) });
          },
        );
        try {
          for await (const ev of opts.engine.stream({
            agent: thinking,
            message: prompt,
            history: [],
            systemPrompt: `${agent.identity_prompt || `你是 ${agent.name}，你的角色是：${agent.role}`}\n\n输出规范：�?文只输出你的观点（≤200 字�?�一段�?�直接可读），严禁在正文�?���?<thinking> 标�?、�?��?�过程�?�草稿�?�自我�?查或任何元叙述；思�?�只能作为你的内部过程�?��?�?�?新信�?��调用 web_search / web_fetch（仅联网工具），并注明来源�?�\n\n�??�输出约束：必须直接围绕�??输出有信�?��的实质内容；严�?输出「我在听/请�?得更明确/你想�?���?先给�?���?我�?在衡量�?�这类空泛确认�?�反�?��等待或仅�?��介绍（身份声明最多一句话前缀，�?文须立即进入实质回答）；若�?题看似不完整，按�?�?��的意图直接作答并顺带询问�?��的待�??点�?�`,
            toolsOnly: opts.networkEnabled ? ["web_search", "web_fetch"] : [],
            maxTokens: 2048,
            networkEnabled: opts.networkEnabled,
          })) {
            if (ev.type === "reasoning" && ev.content && ev.content.trim()) {
              e.reasoning(ev.content);
              broadcastStatus({ memberId: agent.id, name: agent.name, state: "thinking", chunk: ev.content, ...quotaOf(agent.id) });
            } else if (ev.type === "chunk" && ev.content) {
              split.push(ev.content);
            } else if (ev.type === "done") {
              // A-958：SILAM 等一次�??done 模型的�?文只�?done.reply（不�?chunk）�??
              // 仅当全程�?��出任何�?文时才兜底注入，避免与已流式吐出�?chunk 重�?�?
              const d = ev as { reply?: unknown };
              if (!rep && typeof d.reply === "string" && d.reply.trim()) {
                split.push(d.reply);
              }
            }
          }
        } catch (err) {
          rep = `（${agent.name} 本次发言失败：${err instanceof Error ? err.message : String(err)}）`;
          e.chunk(rep);
        }
        split.finish();
        return rep;
      },
    };
  };

  // @ �?��（A-950）：点名 1 �?�?single；点名�?�?@全体 �?seq（�?�个非并发，后�?前文）；�?���?�?contest 抢答
  const names = opts.members.map((a) => a.name);
  const { all, mentions } = parseMentions(opts.topic, names);
  const byId = new Map(opts.members.map((a) => [a.name, a.id]));
  const targets = mentions.map((n) => byId.get(n)).filter((x): x is string => Boolean(x));
  let mode: "single" | "seq" | "contest" = "contest";
  if (targets.length === 1) { mode = "single"; }
  else if (targets.length > 1 || all) { mode = "seq"; }

  const memberEvents: Array<{ seq: number; type: string; data: Record<string, unknown> }> = [];
  const emitMember = (m: { name: string; memberId: string }, payload: Record<string, unknown>): void => {
    memberEvents.push({ seq: ++seq, type: "member", data: { name: m.name, agentId: m.memberId, ...payload } });
  };
  void broadcastStatus; // 状�?�经 slime:brainstorm:event 广播（thinking 实时�?
  let flowDone = false;
  let runErr: Error | null = null;
  const flow = runGroupTalk({
    members: opts.members.map(toParticipant),
    topic: opts.topic,
    mode,
    targets: mode !== "contest" ? targets : undefined,
    compressTranscript,
    onSpeechStart: (m) => {
      broadcastStatus({ memberId: m.memberId, name: m.name, state: "speaking", ...quotaOf(m.memberId) });
    },
    onChunk: (m, text) => emitMember(m, { content: text }),
    onSpeechEnd: (m, full) => {
      broadcastStatus({ memberId: m.memberId, name: m.name, state: "done", content: full, ...quotaOf(m.memberId) });
      // A-1008：本次发�?失败 �?追加�?�?结束通知"，�?渲染层把该成员刚生成的气泡降级为错�?样式�?
      // 判据�?��"整�?正文"上成立（chunk 逐�?到达时判不出），�?以不能�?进上面的 onChunk�?
      // 顺序安全：memberEvents �?���?�?FIFO 队列，本事件必然排在该成员最后一�?chunk 之后
      // （contest 回放�?��同样成立—�?�onSpeechEnd 在每�?slot 回放�?��结束处触发）�?
      if (isSpeechFailure(full)) { emitMember(m, { speechEnd: true, failed: true }); }
    },
    onDone: () => { /* 落库在下�?*/ },
  }).then((r) => ({ r })).catch((e: unknown) => {
    runErr = e instanceof Error ? e : new Error(String(e));
    return null;
  });
  // 事件不经缓冲直接流式（runGroupTalk 已保证同�?时刻�?���?�?��员在输出�?
  while (!flowDone) {
    while (memberEvents.length > 0) { yield memberEvents.shift()!; }
    const done = await Promise.race([flow.then(() => true as const), new Promise<false>((r) => setTimeout(() => r(false as const), 30))]);
    flowDone = done;
  }
  while (memberEvents.length > 0) { yield memberEvents.shift()!; }
  if (runErr) { throw runErr; }
  const res = (await flow)!;
  // A-948：群聊发�?落库（带名字聚合）�?��?�重�?��恢�?
  // A-1008�?*同时**落结构化 turns —�??�?��那个拼好的大字�?串会�?GUI 侧�?回来变成
  // "�?条署名会话归�?Agent、内容把�?有人揉在�?�?的巨长气泡：这�?�?��户历时很久的
  // 「�?�有�?�?Agent 出来把所有内容�?�结复述�?遍�??「重�?���?��那个总结�?Agent」的同一根因�?
  // `ai` 仍是拼好的文�?��模型侧历史照旧），`turns` �??存一份给界面按成员展�?�?
  if (opts.sessionId && res.r.transcript.length > 1) {
    try {
      const idByName = new Map(opts.members.map((m) => [m.name, m.id]));
      const turns = res.r.transcript.slice(1).map((l) => ({
        name: l.speaker,
        agentId: idByName.get(l.speaker),
        content: l.content,
        ...(l.failed ? { failed: true } : {}),
      }));
      const body = formatSpeakerBlob(turns);
      await appendHistory(opts.members[0].id, (opts.topic ?? "").trim() || "（群聊�?题）", body, true, opts.sessionId, undefined, Date.now() - started, turns);
    } catch (e) {
      console.warn(`[grouptalk] 群聊历史落库失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A-946：不追加"结�?/组长"消息—�?�收束由用户
  yield {
    seq: ++seq,
    type: "done",
    data: { reply: "", reply_raw: "", model: "grouptalk", prompt_tokens: 0, completion_tokens: 0, elapsed_ms: Date.now() - started },
  };
}
import { retrieveFromStore, formatMemoryItems } from "../../../core-ts/src/memory/retrieve.js";
import { EmotionalState, topKForMood } from "../../../core-ts/src/mind/emotion.js";
import { BehaviorStore } from "../../../core-ts/src/mind/behavior.js";
import { buildMindSegments } from "../../../core-ts/src/mind/hooks.js";
import { loadMindConfig, saveMindConfig, readDepStatus, detectLocalDeps, updateTomlKey, readModelServerConfig, type VectorTool } from "./mind_config.js";
import {
  startDownload, controlDownload, downloadSnapshot, setDownloadListener, setBgeReadyCallback, tryRelocateDownloads,
  type DownloadTarget, type DownloadProgress,
} from "./downloader.js";
import {
  listSessions, getSession, createSession, renameSession, removeSession,
  ensureDefaultSession, setSessionMembers, setSessionType, removeSessionsForAgent, removeSessionsForWorkspace,
  setSessionAgent, setSessionWorkspace, setSessionSummary, touchSessionWithMessage, SESSIONS_PATH,
  memberIdsOf, memberModelsOf, memberEffortsOf, setSessionMemberEffort, type MemberEntry,
  /* A-1131：会话级模型选择（�?�?Agent 默�?值）+ 「取�?��」的�?��判据（纯函数�?*/
  setSessionModelChoice, effectiveModelChoice,
} from "../../../core-ts/src/services/sessions.js";
import { loadHistoryForSession, loadHistoryForSessionBefore, clearSessionHistory, clearLegacySessionHistory } from "../../../core-ts/src/services/history.js";
import { formatSpeakerBlob, isSpeechFailure, expandHistoryRecord, type ExpandedMessage } from "../../../core-ts/src/services/grouptalkTranscript.js";
import { needsCompress, estimateHistoryTokens, DEFAULT_TAIL_KEEP, DEFAULT_COMPRESS_RATIO, SUMMARIZE_INPUT_CAP, HISTORY_LOAD_LIMIT, buildCompactedHistory, truncateTurnAligned } from "../../../core-ts/src/services/context_compress.js";
import { acceptSummary, countTurns, formatCannotFit, formatRescueHint, pickRescueModel, INITIAL_BREAKER, isRealShrink, nextBreakerState, planSend, validateHistory, type BreakerState, type CapCandidate, type LoopMessage, type RescuableModel } from "../../../core-ts/src/services/context_loop.js";
import { SandboxManager, defaultSandboxConfig, type SandboxConfig } from "../../../core-ts/src/sandbox.js";
// A-980-R32：点击路径的多基准�?��?�解析（�??�辑，vitest 直测�?
import { buildTargetCandidates, normalizeTargetPath } from "./targetPath.js";
// A-1043：初始化单�?（并发调用只真�?跑一次；�?��实现见�?模块头注释）
import { singleFlight } from "./singleFlight.js";

let mainWindow: BrowserWindow | null = null;
let chatService: ChatService | null = null;
let a2aBus: ServerA2ABus | null = null;
let statsService: StatsService | null = null;
let agentRegistry: AgentRegistry | null = null;
let engine: SlimeEngine | null = null;
/** SILAM 绝�?大脑兑底客户�?��A-121；无 API/�?��模型时兜底应答） */
let silamBrain: SilamBrain | null = null;
/** 进�?�?��流式对话 �?取消控制�?��key=sessionId ?? agentId�?*/
const activeChats = new Map<string, AbortController>();
/** agentId �?�?Agent 当前流的会话 key（perm/ask 请求�??打会话标签；供渲染层切会话时丢弃旧会话残留�?求） */
const agentStreamSessionMap = new Map<string, string>();
/** A-1017：最近一次本地模型�?求的取消�?—�??「�?在加载本地模型�?�面板上的�?�取消加载�?�按它中�?��载�??
 *  面板�?��改由 ModelServerManager 的状态广�?���?��不再由本文件预判），广播那一刻拿不到�??流的 key�?
 *  �?��在这里�?�?笔�?�用"�?近一�?�?��理的：加载必然由某�?请求触发，且 chat 实例同时�?���?�???*/
let lastChatCancelKey: string | null = null;
let sandbox: SandboxManager | null = null;
/** 权限请求 �?渲染层等待用户抉择的挂起解析�?��requestId �?resolver�?*/
const pendingPerms = new Map<string, (decision: PermissionDecision) => void>();
/**
 * 后台子代理的会话 ID 前缀（配�?core-ts 子代理流）�??
 * A-980-R31�?*这里也是�?�?���?��静默失败�?*—�?�子代理会话与用户当前会话永远不相等�?
 * 渲染层的会话过滤会把这些交互请求静默丢弃，于�?���?��不展示�?�也不立即失败，
 * 而是挂满 5 分钟超时（PERM_TIMEOUT_MS / ASK_TIMEOUT_MS）才�?��/跳过�?
 * 实测后果：子代理在等�?�?��远不会出现的用户点击，直到自己的执�?预算耗尽 �?�??�?超时�?��"�?
 * �?以这两类请求必须�?*主进�?*就按"后台无人�?���?处理掉�??
 */
/* A-1122：子代理会话前缀**改从 core-ts �?*（`subagent.ts` �?���?出�?，import 见文件顶�?���?
   此前这里�?��地字面量、`todoStore.ts` 里另有一份推�?—�??前缀�?改，�?��改动过的那一�?
   继续生效，其余照�?看着�?，�??*文件回滚会因此静默地漏掉子代理改过的文件**�?*/
/** 权限请求超时（渲染层无响应时�?��拒绝，避免工具调用卡死） */
const PERM_TIMEOUT_MS = 300_000;
/** ask_user 提问 �?渲染层等待用户回答的挂起解析�?��requestId �?resolver�?*/
const pendingAsks = new Map<string, (decision: AskUserDecision) => void>();
/** ask_user 提问超时（渲染层无响应时按�?�跳过�?��?理，避免工具调用卡�?�?*/
const ASK_TIMEOUT_MS = 300_000;
let statsPoll: NodeJS.Timeout | null = null;
/** P0: 当前选中 Agent ID（渲染层通过 agents:select 设置�?*/
let selectedAgentId: string | null = null;

function isTrustedSender(sender: Electron.WebContents): boolean {
  if (!mainWindow) {
    return false;
  }
  try {
    return sender.id === mainWindow.webContents.id;
  } catch {
    return false;
  }
}

/** 已注册的 IPC channel（A-1020 去重防护�?���?`handleTrusted`�?*/
const REGISTERED_CHANNELS = new Set<string>();

/**
 * 安全基线（官方清�?#17）：�?�?IPC handler 统一�?sender 白名单校验�??
 * 校验失败直接 reject，渲染层收到 rejected promise�?
 *
 * ⚠️ A-1020：�?同一 channel 调两�?`ipcMain.handle` �?*直接 throw**
 *   （`Attempted to register a second handler for 'xxx'`）�?��??`registerIpcHandlers`
 *   �?*线�?�注�?*的大函数 —�??任何�?�?throw 都会�?*它之后的�?�?handler 全部失去注册**�?
 *   并且�?�� `app.whenReady` 阶�?抛的，表现为**整个应用打不�?**�?
 *   实测踩坑：A-1019 �?`slime:theme:set` 补持久化�?*加了�?handler 却忘删旧�?*�?
 *   于是 `dev` 直接起不来（用户原话�?打都打不�?�?）�??
 *
 *   两层防护（缺�?不可）：
 *     �?这里：重复注册时**先摘掉旧的再注册**，把失败模式�?app 打不�?"降级�?
 *        "app 能开 + �?行醒�?�� console.error"�?*不静�?* —�??静默失败同样致命�?
 *     �?CI：`tests/core-ts/a1020-guards.spec.ts` �?��码，重�? channel 直接�???
 */
function handleTrusted<T>(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, payload: T) => unknown,
): void {
  if (REGISTERED_CHANNELS.has(channel)) {
    console.error(
      `[gui:main] ⚠️ IPC channel 重�?注册: "${channel}" —�??旧的 handler 已�?覆盖。` +
      `多半�?加了�?handler 却忘删旧�?，�?�?gui/src/main/index.ts 里删掉其�?��处�?�`,
    );
    try {
      ipcMain.removeHandler(channel);
    } catch (e) {
      console.error(`[gui:main] removeHandler("${channel}") 失败:`, e);
    }
  }
  REGISTERED_CHANNELS.add(channel);
  ipcMain.handle(channel, (event, payload: T) => {
    if (!isTrustedSender(event.sender)) {
      throw new Error("sender 校验失败");
    }
    return fn(event, payload);
  });
}

/** 安全执�? git（execFile �?shell，杜绝注入；返回 code/stdout/stderr�?*/
function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    execFile("git", args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    }, (err, stdout, stderr) => {
      const code = err
        ? (typeof (err as { code?: number }).code === "number" ? (err as { code?: number }).code as number : 1)
        : 0;
      resolveResult({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/* ══ A-1139：内�?���?��进程执�?�?*�?��产地**）═════════════════════════════════�?
 *
 * ## 为什么不再用 `exec(cmd)`
 *  · `exec` 永远�?*平台默�? shell**（Windows 上就�?cmd.exe）⇒ 用户装的�?PowerShell 7�?
 *    跑的却是 cmd；WSL �?`/home/x/proj` 这类�?��根本传不进去；Git Bash �?`$VAR`/`&&`
 *    �?���?cmd 不同，同�?条命令两边结果不�?样�??
 *  · `exec` 把输出当 **UTF-8** 解，而中�?Windows 的控制台代码页是 CP936(GBK)
 *    �?�?��变成 `������`（用户实测截图里的红色乱码�?�?��）�??
 *
 * "用哪�?shell / 怎么起它"�?*�?���?*（`core-ts/src/terminal/profiles.ts`，可单测）；
 * �?��数只做三件事�?*起进�?�?收字�?�?�?`decodeBytes` 解码**�?
 *
 * ## 两个必须让用户看见的降级（铁�?31�?
 *  · **超时**：旧实现超时返回 `ok: true` + 部分输出 �?用户以为命令"跑完�?，只�?��输出�?
 *    现在超时**明确写进 `notice`**，并且用 `killProcessTree` �?**进程�?*（只�?�?��器会�?
 *    Windows 上留下孙进程持有管道 �?`close` 事件永远不来 �?终�?整条命令挂�?到永远）�?
 *  · **�?�� / 编码兜底**：同样写�?`notice`，不静默吞掉�?
 */
const TERM_TIMEOUT_MS = 30_000;
const TERM_MAX_BYTES = 8 * 1024 * 1024;

/** 起不了进程时的结果（`error` �?`stderr` 分开：这�?没跑起来"，不�?跑了但报�?）�??*/
function termSpawnError(file: string, profileId: string, e: unknown): TermResult {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    stdout: "",
    stderr: "",
    code: null,
    profileId,
    /* 探测与执行之间有窗口期（卸载 / �?PATH）⇒ 必须说清"怎么�?，�?�不�?���?ENOENT�?*/
    error: `无法�?�� ${file}�?{msg}。�?终�?配置�?��已�?卸载或路径已变，�?��终�?标�?栏切换到其它 shell。`,
  };
}

/**
 * 校验"渲染层提�?�� cwd"�?
 *
 * ⚠️ 这是「渲染层�?���??�主进程定事实�?�的落点。渲染层�?`cd xxx` 推�?出下�?�?cwd
 * （`resolveCd`，纯函数），但那�?��**提�?**：一旦推导算错，命令就会静默跑在用户没�?期的
 * �?��里（`spawn` 对不存在的目录会�?ENOENT，�?�错�?���?��"spawn cmd ENOENT"�?
 * 用户根本看不出是�?��的问题）。所以这里必须验�?*存在 + �?���?* 才采�?��
 * 否则�?回默认目�?*并�?出来**（`rejected`）�??
 *
 * ⚠️ WSL 例�?：它�?cwd �?*发�?版内部的 Linux �?��**，在 Windows �?`statSync` 必然失败�?
 * 而校验它�?��就是 WSL �?��的事（`--cd`）⇒ 原样透传，不做本地校验�??
 */
function resolveTermCwd(
  proposed: string | undefined,
  kind: TermProfileKind,
): { dir?: string; rejected?: string } {
  const p = (proposed ?? "").trim();
  if (!p) { return {}; }
  if (kind === "wsl") { return { dir: p }; }
  try {
    const dir = resolve(p);
    if (statSync(dir).isDirectory()) { return { dir }; }
    return { rejected: `工作�?�� ${dir} 不存在或不是�?��，本条命令已改用默�?�?��` };
  } catch {
    return { rejected: `工作�?�� ${p} 不可�?���?��命令已改用默认目录` };
  }
}

/** 把一�?非致命�?�?追加到结果上（�?条之间用 `；`）�?��??不�?盖已有�?明�??*/
function pushTermNotice(res: TermResult, note: string): void {
  res.notice = res.notice ? `${res.notice}；${note}` : note;
}

/**
 * cwd 延续：从**这一�?*命令推�?"下一条命令�?在哪�?���?�?
 *
 * ⚠️ 判据全在主进程（渲染层零推�?）：`resolveCd` �?��函数，但**它算出来的只�?���??��??* —�??
 * 必须再过�?�?存在且是�?��"才算数�?�理由：�?�?��错的 cwd 会�?后续命令静默跑在用户
 * 没�?期的�?��里（�?cd 不延�?糟糕得�?，且更难发现）�??
 * `cd` 到一�?��存在的目录时，真�?shell �?cwd 也没�?�?这里保持原目录�?�?*正确**行为�?
 *
 * ⚠️ WSL 例�?：路径在发�?版内�?��宿主校验不了（也不�?校验）⇒ 直接采用�?
 */
function nextTermCwd(cmd: string, cwd: string | undefined, kind: TermProfileKind): string | undefined {
  const r = resolveCd(cmd, cwd, kind, homedir());
  if (!r) { return cwd; }
  if (kind === "wsl") { return r.next; }
  try { return statSync(r.next).isDirectory() ? r.next : cwd; } catch { return cwd; }
}

function runShellCommand(inv: ShellInvocation, prof: TermProfile, spawnCwd: string | undefined): Promise<TermResult> {
  const profileId = prof.id;
  return new Promise((resolveResult) => {
    let child: ChildProcess;
    try {
      child = spawn(inv.file, inv.args, {
        /* ⚠️ WSL 例�?：它的目录在**发�?版内�?*（`--cd` 已经�?argv 里了），
           �?`spawn` �?`cwd` 必须�?*宿主 Windows** 上真实存在的�?�� �?�?undefined
           让子进程继承主进程目录，否则 spawn 会直�?ENOENT�?*/
        cwd: prof.kind === "wsl" ? undefined : spawnCwd,
        windowsHide: true,
        // 与旧行为�?致：让子进程知道�?��跑在 slime 里（脚本�?��此换行为�?
        env: { ...process.env, SLIME_TERM: "1" },
      });
    } catch (e) {
      resolveResult(termSpawnError(inv.file, profileId, e));
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    let spawnErr: Error | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let fallbackTimer: NodeJS.Timeout | null = null;

    /* 逐块�?���?*就地封顶**：`exec` �?maxBuffer �?��进程，这里改成截�?—�??
       宁可给用户前 8MB（�?数时候�?的就�?��头），也不�?因为�?�?��控的 `dir /s` 把结果全丢掉�?*/
    const collect = (isOut: boolean, buf: Buffer): void => {
      const used = isOut ? outLen : errLen;
      if (used >= TERM_MAX_BYTES) { truncated = true; return; }
      const room = TERM_MAX_BYTES - used;
      const slice = buf.length > room ? buf.subarray(0, room) : buf;
      if (buf.length > room) { truncated = true; }
      (isOut ? outChunks : errChunks).push(slice);
      if (isOut) { outLen += slice.length; } else { errLen += slice.length; }
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) { return; }
      settled = true;
      if (timer) { clearTimeout(timer); }
      if (fallbackTimer) { clearTimeout(fallbackTimer); }

      /* 起了但立刻�?了（ENOENT / EACCES / EPERM）⇒ 归到"没跑起来"，别�??�?命令失败"�?*/
      if (spawnErr && outLen === 0 && errLen === 0) {
        resolveResult(termSpawnError(inv.file, profileId, spawnErr));
        return;
      }

      const so = decodeBytes(Buffer.concat(outChunks));
      const se = decodeBytes(Buffer.concat(errChunks));
      /* 两个流同源（同一�?��制台代码页）�?优先回带**�?utf-8** 的那�?�?��
         它才�?我们�?��做了编码判断"的证�?���?utf-8 时回�?stdout 的�??*/
      const encoding = so.encoding === "utf-8" ? se.encoding : so.encoding;
      const looseEncoding = so.loose || se.loose;

      const notes: string[] = [];
      if (timedOut) { notes.push(`命令超过 ${TERM_TIMEOUT_MS / 1000} 秒未结束，已终�?进程树`); }
      if (truncated) { notes.push(`输出超过 ${TERM_MAX_BYTES / 1024 / 1024} MB，已�?��`); }
      if (looseEncoding) { notes.push(`输出编码�?���??，已�?${encoding} 兜底解码`); }
      if (spawnErr) { notes.push(`进程异常：${spawnErr.message}`); }
      else if (signal && !timedOut) { notes.push(`进程�?���?${signal} 终�?`); }

      resolveResult({
        ok: !timedOut && !spawnErr && code === 0,
        stdout: so.text,
        stderr: se.text,
        code,
        encoding,
        looseEncoding,
        profileId,
        notice: notes.length > 0 ? notes.join("、") : undefined,
      });
    };

    child.stdout?.on("data", (b: Buffer) => collect(true, b));
    child.stderr?.on("data", (b: Buffer) => collect(false, b));
    child.on("error", (e: Error) => { spawnErr = e; });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));

    timer = setTimeout(() => {
      timedOut = true;
      /* �?**�?*：只�?`child.kill()` 会在 Windows 上留下孙进程持有管道（�? `TERM_TIMEOUT_MS` 注释）�??*/
      killProcessTree(child.pid, { onDone: () => { try { child.kill(); } catch { /* 已�??�?*/ } } });
      /* 兜底：杀�?3 �?`close` 仍不来（管道�?��进程攥着）⇒ 用已收到的内容收尾�??
         宁可少一段输出，也不能把终�?挂�?到永远�??*/
      fallbackTimer = setTimeout(() => finish(null, "SIGKILL"), 3000);
    }, TERM_TIMEOUT_MS);
  });
}

/** 归一�?git �?��：绝对化 + strip 引号/空白（用户手动粘贴常带�?余引号） */
function normalizeInputPath(p?: string): string {
  if (!p) { return ""; }
  return p.trim().replace(/^['"\s]+|['"\s]+$/g, "").trim();
}

/** 归一�?git �?��：绝对化 + 存在性校验；不存在时告知上层（可�?�� mkdir�?*/
function gitPathOf(p?: string): { path: string; exists: true } | { path: string; exists: false } | { error: string } {
  const clean = normalizeInputPath(p);
  if (!clean) { return { error: "仓库�?��为空" }; }
  try {
    const root = resolve(clean);
    if (!existsSync(root)) { return { path: root, exists: false }; }
    return { path: root, exists: true };
  } catch {
    return { error: "�?��非法" };
  }
}

/**
 * A-1035：�? Agent **真�?能调用技�?*（含知识引擎�?��生成的那些）�?
 *
 * 病灶：GUI 此前�?��"加号菜单"里用�?次�??`new SkillRegistry()` 列了�?��单，
 * **从未调用 `loadAllSkills`** —�??于是 `skill_search` / `skill_lookup` 这两�?���?
 * 从来没有注册进工具表，Agent �?�?��根据�?能模块调�?skill"�?��句空�?
 * （界面里看得到技能名，模型却既搜不到也�?不到）�??
 *
 * 这里�?次做两件事：
 *   �?注册�?能�?索工具（注册表是全局单例，重复调用安�?��
 *   �?把各 Agent 由知识引擎自动生成的�?能目录作�?*额�?�?���?*
 *      （`Knowledge/Agent Memory/<agentId>/generated_skills`�?
 *      �?打�?��?�知�?�?�?�?�?�?? Agent 调用」的�?后一�?
 *
 * 会在会话�?始前调用（�? `slime:chat:stream`）：上一�?��生成的技能，下一�?��能�?搜到�?
 */
async function refreshAgentSkills(): Promise<void> {
  try {
    const extraDirs: string[] = [];
    for (const a of agentRegistry?.loadedAgents ?? []) {
      try {
        extraDirs.push(getKnowledgeEngine(a.id).generatedSkillsDir);
      } catch { /* 单个 Agent 算不出目录不影响其它 */ }
    }
    const loaded = await loadAllSkills({ registry: getRegistry(), extraDirs });
    console.info(`[gui:skills] 技能工具已就绪，可见技能 ${loaded.length} 个（额外目录 ${extraDirs.length} 个）`);
  } catch (e) {
    console.warn("[gui:skills] �?能加载失败（不影响�?话，�?Agent 将无法�?索技能）:", e);
  }
}

/**
 * A-1043�?*轻量**初�?�?—�??�?���?AgentRegistry（一�?`agents.json` 读取 + `JSON.parse`）�??
 *
 * 首屏的�?�会话列表�?�与「Agent 列表」只�?�?Agent 名字�?��**根本不需�?*
 * engine / sandbox / ChatService / SILAM 这些重�?伙�?�以前两者都 `await ensureServices()`�?
 * 于是左栏�?��条初始化链挡住（用户报的"�?��后左栏空白�?�跟刚下载一�?）�??
 *
 * 同样单�?：启动瞬�?agents / sessions 两个 list �?起打进来也只读一次文件�??
 */
const ensureRegistryOnce = singleFlight<AgentRegistry>(async () => {
  const reg = new AgentRegistry();
  await reg.load();
  agentRegistry = reg;
  return reg;
});

/** �?���?AgentRegistry 就绪（�?屏只读列表用这个，不要用 `ensureServices()`）�??
 *  ⚠️ **返回�?*而不�?��返回 void：`agentRegistry` �?���?��里�?赋�?�的，TS 的控制流收窄�?
 *  任何函数调用之后都会失效 —�??若返�?void，链�?5 处用法就得靠 `!` 强�?�?���?
 *  那�?�?静默 TypeError �?空列�?的�?族�?�返回�??binding 到局部常量是零断�?的写法�??*/
async function ensureRegistry(): Promise<AgentRegistry> {
  return ensureRegistryOnce();
}

/**
 * A-1043：重初�?�?*单�?** —�??下面这一整条链（A2A 总线 / 沙�? / SILAM python sidecar /
 * engine / ChatService / �?能注�?/ 调度�?/ StatsService）在并发调用�?*�?��跑一�?*�?
 *
 * 以前这里既没有在飞去重�?�`chatService` 又只�?*链尾**赋�??�?�?���?��四个首屏 list 各自
 * 跑完整条链：初�?化成�?��倍，还会�?IPC 二�?注册（`Attempted to register a second handler`�?
 * 与�?口抢占（`EADDRINUSE 127.0.0.1:19011`），并且�?左侧会话列表"拖到�?慢的那条链之后�??
 */
const ensureServicesOnce = singleFlight<void>(async () => {
  if (chatService) {
    return;
  }
  const registry = await ensureRegistry();
  // A2A 通信总线（传�?广播/委托回传；ChatService 依赖它完成跨 Agent 协作�?
  a2aBus = new ServerA2ABus();
  for (const a of registry.loadedAgents) {
    a2aBus.register(a.name);
  }
  sandbox = new SandboxManager();
  // 权限审批：不再用系统弹窗，改为�?�输入�?内嵌选择题�?��?��?�主进程把�?求推给渲染层�?
  // 渲染层在输入框位�?��示�?�择题（列出各�?�项的结果），用户点选后回传决策�?
  sandbox.setApprovalCallback((req) => {
    return new Promise((resolve) => {
      // B：调用前分类器�?�?—�?�block 直拒（防社工，不进弹窗）、全�?auto 直放、其余走弹窗
      const cls = classifyPermissions(req.actions);
      if (cls.hasBlocked) {
        resolve({
          requestId: req.requestId,
          approved: false,
          approvedActions: [],
          deniedActions: req.actions.map((a) => a.action),
          reason: `[分类器预检拦截] ${cls.reasons.join("；")}`,
          autoApproved: false,
        });
        return;
      }
      if (cls.allAuto) {
        resolve({
          requestId: req.requestId,
          approved: true,
          approvedActions: req.actions.map((a) => a.action),
          deniedActions: [],
          reason: `[分类器自动放行] ${cls.reasons.join("；")}`,
          autoApproved: true,
        });
        return;
      }
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) {
        resolve({ requestId: req.requestId, approved: false, approvedActions: [], deniedActions: [req.actions[0].action], reason: "无窗口", autoApproved: false });
        return;
      }
      // A-980-R31：后台子代理的授权�?�?�?**立即拒绝并�?清原�?*，不要推给渲染层�?
      // 理由：① 子代理跑�?`__subagent__:*` 会话，渲染层会话过滤必然丢弃它（无人�??）；
      //      �?于是它会挂满 PERM_TIMEOUT_MS�? 分钟）才�?�� —�??这�?时间子代理什么都没做�?
      //         �?后往�?�?��己的执�?预算判成"超时�?��"（用户看到的"子代理超时率 100%"有它�?份）�?
      //      �?后台任务�?��就不该静默替用户�?允�?"，fail-closed 才是正确姿势�?
      // 立即拒绝 + �?��作原因，能�?子代�?*当场�?��条不�?要授权的�?*把任务做完�??
      const reqSid = req.sessionId ?? agentStreamSessionMap.get(req.agentId);
      if (typeof reqSid === "string" && reqSid.startsWith(SUBAGENT_SESSION_PREFIX)) {
        resolve({
          requestId: req.requestId,
          approved: false,
          approvedActions: [],
          deniedActions: req.actions.map((a) => a.action),
          reason:
            "该操作需要用户授权，但这�?��台子代理（无人可交互确认）→ 已直接拒绝。"
            + "请改用不需要授权的做法完成任务（例如只读分析、基于已有信息给结论），"
            + "并在最终产出里如实说明哪一步因权限被跳过。",
          autoApproved: false,
        });
        return;
      }
      const ui: PermissionRequestUI = {
        requestId: req.requestId,
        agentId: req.agentId,
        agentName: req.agentName,
        taskDescription: req.taskDescription,
        actions: req.actions,
        options: buildPermOptions(req),
        sessionId: req.sessionId ?? agentStreamSessionMap.get(req.agentId), // 精确流上下文会话标�?（切会话后旧流�?求可�?��染层丢弃）；无则回�??当前流映�?
      };
      // 渲染层可能尚�?���?��挂载前）：丢弃�?求前先尝试，超时兜底拒绝
      const resolver = (d: PermissionDecision) => {
        clearTimeout(timer);
        resolve({
          requestId: req.requestId,
          approved: d.approved,
          approvedActions: d.approved ? req.actions.map((a) => a.action) : [],
          deniedActions: d.approved ? [] : req.actions.map((a) => a.action),
          reason: d.reason || "",
          autoApproved: false,
        });
        // 「本次会话�?�是允�?」→ 会话级白名单（同 Agent 同工具不再�?�?��
        if (d.alwaysAllow && d.approved && req.actions.length > 0) {
          sandbox?.approveToolForSession(req.agentId, req.actions[0].action);
        }
      };
      pendingPerms.set(ui.requestId, resolver);
      // 超时兜底：渲染层无响�?�?�?��拒绝，避免工具调用永久挂�?
      const timer = setTimeout(() => {
        if (pendingPerms.delete(ui.requestId)) {
          win.webContents.send("slime:perm:timeout", { requestId: ui.requestId });
          resolve({ requestId: req.requestId, approved: false, approvedActions: [], deniedActions: req.actions.map((a) => a.action), reason: "权限请求超时（未收到用户决策）", autoApproved: false });
        }
      }, PERM_TIMEOUT_MS);
      try {
        win.webContents.send("slime:perm:request", ui);
      } catch {
        // 渲染层异常：立即拒绝
        clearTimeout(timer);
        pendingPerms.delete(ui.requestId);
        resolve({ requestId: req.requestId, approved: false, approvedActions: [], deniedActions: req.actions.map((a) => a.action), reason: "渲染层不�?��", autoApproved: false });
      }
    });
  });
  // 恢�?每个 Agent 的沙箱配�?���?override �?override�?*没有 override 也�?按全�?默�?下发**
  // （�?前无 override �?Agent �?���?�?�?sandbox 内置默�? �?�?终�?/网络全部逐�?询问�?
  //   设置里的「全�?默�?审批模式」�?绝大多数会话根本不起作用）�??
  applyGlobalSandboxDefaults();
  // A-121: SILAM 绝�?大脑兑底—�?�slime.toml [silam] enabled + as_brain �?�?��
  // 拉起 python sidecar；起不来（缺 python/脚本/依赖）静默降级，不阻�?GUI 主流程�??
  try {
    const silamCfg = readSilamConfig();
    if (silamCfg.enabled && silamCfg.asBrain) {
      silamBrain = await SilamBrainClient.start(silamCfg);
      console.info(`[gui:silam] 绝对大脑兑底 ${silamBrain.enabled ? "已就绪（无模型时由 SILAM 应答）" : "不可用（回落默认提示）"}`);
    } else {
      console.info(`[gui:silam] 兑底�?���?��enabled=${silamCfg.enabled} as_brain=${silamCfg.asBrain}）`);
    }
  } catch (e) {
    console.warn(`[gui:silam] 大脑�?��跳过: ${e instanceof Error ? e.message : String(e)}`);
  }
  engine = createEngine({
    registry,
    sandbox,
    silamBrain,
    // A-965 core-ts↔server 通报：SILAM 情绪/成长�?�?server 人格演化（fire-and-forget�?
    onSilamEvolve: notifySilamEvolve,
    // 聊天请求�?Chromium 网络栈（�?providers 探测）：绕过 Cloudflare �?
    // Electron 内置 Node(BoringSSL) fetch 指纹的�?控拦�?��opencode.ai 实测�?
    // A-1106�?*不再手抄�?�?client 工厂** —�??此前那份漏了 `rateLimit`，�?�?RPM 限流器在
    // **生产链路里一次都没�?调用**（`fetchWithRetry` �?`if (rateLimit)` 恒假），而测试走的是
    // `router.createRouteClient`，所�?`a1091-rpm.spec` 全绿也发现不了�?�它同时还只覆盖
    // anthropic/openai 两个分支（responses/google 会�??化成 ChatClient）�??
    // 现在统一�?`createRouteClient`，只注入「Chromium fetch」这�?项差异�??
    clientFactory: (route: RouteEntry) => createRouteClient(route, chromiumFetch as typeof fetch),
    hooks: {
      fixedSegments: (agent) => {
        const segs: string[] = [];
        try {
          const a = agentRegistry!.loadedAgents.find((x) => x.name === agent.name);
          const emotion = new EmotionalState((a?.emotion as Record<string, unknown>) ?? undefined);
          const behavior = BehaviorStore.fromDict(a?.behavior ?? {});
          segs.push(...buildMindSegments(emotion, behavior));
        } catch (e) {
          console.warn(`[gui:mind] 心智固定段注入失�? ${e}`);
        }
        // A-980-R30：可用子代理清单（模型据此决定�?派给�?/ 点名谁）
        try {
          segs.push(...subagentCatalogSegment());
        } catch (e) {
          console.warn(`[gui:subagent] 子代理清单注入失�? ${e}`);
        }
        return segs;
      },
      retrieveSegments: async (agentId: string, query: string) => {
        try {
          const agent = await agentRegistry!.findAgent(agentId);
          const emotion = new EmotionalState((agent?.emotion as Record<string, unknown>) ?? undefined);
          const res = await retrieveFromStore(memoryStoreFor(agentId), {
            query,
            topK: topKForMood(emotion.mood),
            maxHops: 2,
          });
          const seg = formatMemoryItems(res.items);
          return seg ? [seg] : [];
        } catch (e) {
          console.warn(`[gui:mind] 记忆�?索失败（静默降级为空�? ${e}`);
          return [];
        }
      },
    },
    onAskUser: (req) => {
      // ask_user 工具：模型向用户提问（方向分�?/ 关键决策）→ 输入框位�??�择�?UI�?
      // 与权限�?求同�?交互形�?�；无窗�?超时按�?�跳过�?��?理，不编造用户回答�??
      return new Promise((resolve) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) {
          resolve({ answer: "", skipped: true });
          return;
        }
        // A-980-R31：后台子代理不能向用户提�?��同权限�?求的道理：渲染层会按会话丢弃 �?白挂 5 分钟）�??
        // 按�?�跳过�?�立即返回，子代理据此基于合理默认继�?��并在产出里写明这�?��设�??
        const askSid = req.sessionId ?? agentStreamSessionMap.get(req.agentId);
        if (typeof askSid === "string" && askSid.startsWith(SUBAGENT_SESSION_PREFIX)) {
          resolve({ answer: "", skipped: true });
          return;
        }
        const ui: AskUserRequestUI = {
          requestId: randomUUID(),
          agentId: req.agentId,
          agentName: req.agentName ?? "",
          question: req.question,
          header: req.header,
          options: req.options,
          consequences: req.consequences,
          recommendation: req.recommendation,
          sessionId: req.sessionId ?? agentStreamSessionMap.get(req.agentId), // 精确流上下文会话标�?（切会话后旧流提�?���?��染层丢弃）；无则回�??当前流映�?
        };
        const timer = setTimeout(() => {
          if (pendingAsks.delete(ui.requestId)) {
            win.webContents.send("slime:ask:timeout", { requestId: ui.requestId });
            resolve({ answer: "", skipped: true });
          }
        }, ASK_TIMEOUT_MS);
        pendingAsks.set(ui.requestId, resolve);
        // A-980-R26：�?�需要用户做选择」→ 系统通知（模型在等回答，用户�?��没盯�?这个窗口�?
        // 弹�?�知不出现在渲染层，故不受渲染层切会话过滤影响）
        notifyUser({
          kind: "choice",
          title: `${ui.agentName || "Agent"} �?要你选择`,
          body: (ui.question || ui.header || "有一个待确认的选择").slice(0, 160),
        });
        try {
          win.webContents.send("slime:ask:request", ui);
        } catch {
          clearTimeout(timer);
          pendingAsks.delete(ui.requestId);
          resolve({ answer: "", skipped: true });
        }
      });
    },
  });
  chatService = new ChatService({ registry, engine, bus: a2aBus ?? undefined });
  // A-1035：技能�?索工具（skill_search / skill_lookup�? �?��生成�?能目录，必须�?
  // 服务就绪后立刻注�?—�??否则�?���??话时 Agent 手里根本没有这两�?��具�??
  await refreshAgentSkills();
  // �?�? 后台常驻定时唤醒（SchedulerService 装配，Phase 1 骨架）─�?
  // 对标 nanobot CronService：从 data/schedules.json 读取 cron 任务，到点用现有引擎跑一�?AgentLoop
  // （�?用模型路�?工具�?��/记忆/沙�?），结果落盘 data/generated/schedule-*.md 供�?计�??
  // 无文�?/ 空表 �?空闲（零�?���?��；单�?��务解析失败仅告�?跳过，不影响其余任务与主流程�?
  try {
    const schedPath = join(INSTALL_ROOT, "data", "schedules.json");
    const schedDefs = existsSync(schedPath) ? JSON.parse(readFileSync(schedPath, "utf8")) : [];
    const statePath = join(INSTALL_ROOT, "data", "scheduler-state.json");
    if (Array.isArray(schedDefs) || existsSync(statePath)) {
      const scheduler = new SchedulerService();
      // Phase 3 �?���?��：优先从运�?态快照恢复（�?paused/lastRun/lastResult），再叠�?schedules.json 新�?定义
      const persistState = (): void => {
        try { writeFileSync(statePath, scheduler.exportState(), "utf8"); } catch { /* 状�?�落盘失败不阻断主流�?*/ }
      };
      if (existsSync(statePath)) {
        try { scheduler.importState(readFileSync(statePath, "utf8")); } catch { /* �?��损坏忽略，回�? schedules.json */ }
      }
      scheduler.setHandler(async (job) => {
        const byId = job.agentId ? await agentRegistry?.findAgent(job.agentId) : undefined;
        const agent = byId ?? agentRegistry?.loadedAgents[0];
        if (!agent) {
          throw new Error(`定时任务「${job.name}」找不到可执行 Agent（agentId=${job.agentId ?? "<default>"}）`);
        }
        let reply = "";
        if (!engine) { throw new Error("引擎未就绪"); }
        const system = await engine.buildSystem(agent, undefined, undefined);
        for await (const ev of engine.stream({
          agent,
          message: `${job.prompt}\n\n（本条为后台定时任务触发，触发时间：${new Date().toLocaleString()}）`,
          history: [],
          systemPrompt: system,
        })) {
          if (ev.type === "done") { reply = ev.reply ?? ""; }
        }
        const dir = join(INSTALL_ROOT, "data", "generated");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(dir, `schedule-${job.name}-${stamp}.md`), reply, "utf8");
        persistState(); // Phase 3：运行�?�落盘，进程重启后从�?���?��恢�?
      });
      for (const d of schedDefs as Array<{ id?: string; name?: string; cron?: string; prompt?: string; agentId?: string }>) {
        if (!d.cron || !d.prompt) { continue; }
        if (d.id && scheduler.get(d.id)) { continue; } // 已从�?��恢�?的定义不重�?注册
        try {
          scheduler.add({ id: d.id, name: d.name ?? d.id ?? "task", cron: d.cron, prompt: d.prompt, agentId: d.agentId });
        } catch (e) {
          console.warn(`[scheduler] 忽略非法定时任务「${d.name ?? d.id}」：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      scheduler.start();
      console.log(`[scheduler] 后台常驻定时唤醒已就绪（${scheduler.list().length} 个任务）`);

      // Phase 3 子代理�?理器：后台独立上下文并�?执�?（Claude Code subagent 对标），结果落盘 subagent-*.md
      // A-918++：注册生命周期钩�?�?实时推�??subagent start/complete/error 事件�?renderer（修�?用户从没见过 subagent 活动"�?
      const subagents = new SubAgentManager(async (def, ctx) => {
        const ag = def.agentId
          ? (await agentRegistry?.findAgent(def.agentId))
          : undefined;
        let target = ag ?? agentRegistry?.loadedAgents[0];
        // v2 模型�?��：def.model 为显式路由（api:<key>[:<model>] / local:<id>）时覆盖�?��模型；inherit/缺省 = 沿用�?�� agent 默�?模型
        if (def.model && /^(api:|local:)/.test(def.model.trim()) && target) {
          target = { ...target, model_choice: def.model.trim() };
        }
        if (!target) { throw new Error(`子代理「${def.name}」找不到可执行 Agent`); }
        if (!engine) { throw new Error("引擎未就绪"); }
        const system = def.systemPrompt ?? (await engine.buildSystem(target, undefined, undefined));
        // A-978：子代理流必须带专属 sessionId（`__subagent__:<runId>`），否则 chunk �?sessionId �?undefined�?
        // 渲染器过滤�?�辑（cSid == null 时回�? streamSessionRef 判定）会把子代理 chunk �?��为主 Agent 流，
        // 导致�?Agent 监测栏（tokens/耗时/tokens/s）�?子代理数�?��染（用户实测"指定 subagent 模型后主 Agent 动作也�?认定"）�??
        const subagentSessionId = `${SUBAGENT_SESSION_PREFIX}${def.id ?? def.name}`;
        // A-980-R30 **深度守卫**：子代理不再获得派发/收取子代理的能力�?
        // 理由：本管理器没有深度�?数（不像 Claude Code �?MAX_SUBAGENT_SPAWN_DEPTH），
        // 子代理若能再 delegate，每�?3 并发 �?指数级�?娃；Anthropic 也明�??智能体的
        // 协调成本�?��超过收益。需要�?级时走�?�链式�?�：�?Agent 依�?派发并把上下文转交下�?�???
        const dispatchTools = new Set(["delegate_subagent", "subagent_result"]);
        const allToolNames = engine.listTools?.().map((t) => t?.function?.name).filter((n): n is string => !!n) ?? [];
        // A-1114�?*深度守卫不能�??�自带工具白名单」绕�?*�?
        // 此前 `def.toolsOnly` �?*原样**交给引擎的（`??` 左边直接透传），而内�?spec（`tools`�?
        // 让调用方能自己指定工具面 �?�??�?["delegate_subagent"]，这�?子代理不能再派子代理"
        // 的守�?���?���?（每�?3 并发 �?指数级�?娃，正是 A-980-R30 要防的形态）�?
        // 现在无�?工具面来�?��明式定义还是内联 spec，都先剔掉派�?收取工具（判�?��有一�?��地）�?
        const subToolsOnly = def.toolsOnly
          ? def.toolsOnly.filter((n) => !dispatchTools.has(n))
          : (allToolNames.length > 0 ? allToolNames.filter((n) => !dispatchTools.has(n)) : undefined);
        // A-980-R31 **超时�?100% 的根�?*：�?前这里没有把 `ctx.signal` 交给 engine.stream�?
        // 于是 SubAgentManager.execute() 里那�?`setTimeout(() => controller.abort(), timeoutMs)`
        // �?��让一�?*没人监听**的信号变�?aborted—�?�模型流照旧跑到�?��结束
        // （实测：120s 预算实跑 332.3s），�?后收尾时再按 signal.aborted 把它**归因**�?超时�?��"�?
        // 即：不是模型�?���?���?��来没生效过�?�现在把 signal 透传进去（引�?abort �?底层请求�?�� �?携部分�?文收尾）�?
        // �?�� C �??：继承父请求的联网开关（ctx.networkEnabled �?SubAgentManager.execute 透传）�??
        // 用户关掉联网后，�?Agent 派出的子代理也必须关（否则�?�关了还偷偷联网」）�?
        // 父未传时 ctx.networkEnabled �?undefined �?引擎缺省�?true（保�?A-918+「缺省即�?」）�?
        let reply = "";
        const acc: string[] = [];
        for await (const ev of engine.stream({
          agent: target,
          message: def.task,
          history: [],
          systemPrompt: system,
          sessionId: subagentSessionId,
          signal: ctx?.signal,
          networkEnabled: ctx?.networkEnabled,
          ...(subToolsOnly ? { toolsOnly: subToolsOnly } : {}),
        })) {
          // 注意顺序：先消费事件、再判中�??�引擎在 abort 之后�?yield �?�?*携带部分正文**�?done�?
          // 旧写法在读取前就 `break`，这份部分产出�?直接丢掉 �?落盘 0 字节�?
          // �?Agent �?��到一�?超时�?��"（用户："失败了，但�?�么�?�??录都没有"）�??
          if (ev.type === "chunk" && typeof ev.content === "string") {
            acc.push(ev.content);
          } else if (ev.type === "done" && typeof ev.reply === "string") {
            reply = ev.reply;
          }
          if (ctx?.signal.aborted) { break; }
        }
        // done �?��达（异常/提前跳出）时用累�??量兜底；引擎的中�?��位文案不算产�?
        const aborted = ctx?.signal.aborted === true;
        if (!reply || reply.trim() === "（生成已�?���?��") { reply = acc.join(""); }
        const dir = join(INSTALL_ROOT, "data", "generated");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        // �?��也落盘（带归因头），不再�?0 字节空文件�?��??没有记录"�?��就是�?坏的结果
        const body = reply.trim()
          ? `${aborted ? "> ⚠️ 本次执行被中断，以下为中断前已产出的部分内容。\n\n" : ""}${reply}`
          : `> 本次执行${aborted ? "被中断" : "结束"}，子代理未产出任何正文。\n`;
        // A-1114：落盘名必须�?`sanitizeSubagentRunName` —�??内联 spec �?`def.name` �?���?
        // 由模型决定，`a/b` / `..` / `报告:1` 这类名字会�? writeFileSync �?ENOENT（�?�?层目录）
        // 或写�?data/generated 之�?（路径�?��?�），�?�报错只指向�?��、看不出�?��字的�??�?
        // ⚠️ �?��文件名；`run.name`（界�?审�?）保留原文�??
        writeFileSync(join(dir, `subagent-${sanitizeSubagentRunName(def.name)}-${stamp}.md`), body, "utf8");
        return reply;
      }, {
        // A-1091�?*接线** —�??子代理并行度取自「�?�?�?通用 �?请求频率 · 并发上限」�??
        // 此前这里�?��编码 3，�?��?�?��的�?�并发上限�??*全仓没有任何读取�?*（�?�?关）—�??
        // 用户把它调低以为能避�?上游限流，实际�?无作�?��UI 却写�?"并发上限同时约束 Swarm 并�?"）�??
        // 现在它真的生效：�?1 即串行派发，�?3 即最�?3 �?��行�?求�??
        // ⚠️ 每�?读取（不缓存）⇒ 改�?�?��即生效，无需重启（与权限�?关同口径）�??
        concurrency: readRequests().concurrency,
        hooks: {
          // A-1106/5b�?*派发即推�?*（run 刚登记�?�状态还�?pending）�??
          // 为什么不能只�?onStart：并发槽位�?占满时，新派发的子代理会�?直停�?pending�?
          // �?onStart 要等**拿到槽位**才触�?�?那�?时间面板�?�?��件都收不到，
          // 用户看到「我派了 3 �?���?���?1 �??�（�?���?3 秒轮询兜底）�?
          onSpawn: (run) => {
            console.log(`[subagent] 派发 ${run.name} (${run.id})`);
            mainWindow?.webContents.send("slime:resident:update", null);
          },
          // A-980-R31：每次广�?��行�?�时顺手�?*新到达终�?*的�?录落盘�??
          // 为什么放在广�?��而不�?���?onComplete/onError：取消�?�排队中」的任务�?��
          // SubAgentManager.cancel() 里直接改状�?��??*不触发任何钩�?*（onError �??�?
          // 已进�?execute 的任务）—�??�?以取消入口自己补�?次广�?��见下�?cancel 通道�?
          onStart: (run) => {
            console.log(`[subagent] �?�?${run.name} (${run.id})`);
            syncSubagentRuns(subagents.list());
            // A-918+：派发即推�?�，让右侧栏「子代理」区立即看到（不�?4s �??�?
            mainWindow?.webContents.send("slime:resident:update", null);
          },
          onComplete: (run) => {
            console.log(`[subagent] 完成 ${run.name}${run.structured ? "（含结构化结果）" : ""}`);
            syncSubagentRuns(subagents.list());
            mainWindow?.webContents.send("slime:resident:update", null);
          },
          onError: (run) => {
            console.warn(`[subagent] ${run.status} ${run.name}: ${run.error ?? ""}`);
            syncSubagentRuns(subagents.list());
            mainWindow?.webContents.send("slime:resident:update", null);
          },
        },
      });

      // v2 �?��委派：注册专家子代理定义（description �?��动路由键），�?delegate() 依描述自动�?�人
      subagents.register({
        name: "代码审查员",
        description: "审查代码质量、发现潜在 bug、静态分析、给出改进建议",
        systemPrompt: "你是资深代码审查专家，输出问题清单与修复建议。",
        model: "inherit",
        // A-1096：�?算改�?`DEFAULT_EXEC_BUDGET_MS`�?*�?��真源**�?5 分钟）�??
        // 历史：�?处硬编码 300s —�??A-983 审�?日志实录它把"已做到�? 4/4 �?的工作掐�?
        //（用户体�?子代理全部超时�?�从没成功过"）�?��?算只�?*防挂�?*，不该是常�?�失败源�?
        // 工具�?wait 上限（SUBAGENT_WAIT_DEFAULT）严格大于它，两处现在同源�??
        timeoutMs: DEFAULT_EXEC_BUDGET_MS,
        outputSchema: true,
      });
      subagents.register({
        name: "调研员",
        description: "联网搜索资料、汇总信息、多来源调研与引用整理",
        systemPrompt: "你是多来源调研专家，输出带引用的结构化调研摘要。",
        model: "inherit",
        timeoutMs: DEFAULT_EXEC_BUDGET_MS,
        outputSchema: true,
      });
      subagents.register({
        name: "数据分析员",
        description: "数据清洗、统计、表格/指标计算与分析",
        systemPrompt: "你是数据分析专家，输出可核验的统计与结论。",
        model: "inherit",
        timeoutMs: DEFAULT_EXEC_BUDGET_MS,
        outputSchema: true,
      });

      // A-1096：注�?*全部同意�?���?*的自�?Agent 作为子代理（派发优先�?= �?�� Agent > 内置专�?）�??
      //
      // 为什么改成�?�全�?+ �?Agent �?关�?�（用户原话：�?�不能所有项�?��让主Agent做，效率�?��了�?�）�?
      //   旧实现�? `subagent-selection.json` �?*勾�?�清�?*，�?��?文件默�?不存在�?�勾选默认为�?
      //   �?�?�?���?Agent 都登记不进来 �?清单里只�?3 �?���?��家，用户�?��配的 Agent 永远派不到�??
      //   "配好了也派不�?/ �?Agent �?���?��工作"的根因就在这条数�?��上，不在模型�?���?
      //   现在授权判据收敛�?Agent �?���?`subagent_dispatch` 字�?（缺省即允�?，�?�?���?��），
      //   不再依赖�?��勾�?�文�?—�??判据�?��出�? `services/subagentCatalog.ts`（与设置页同源）�?
      // A-1106：这里是**模块级可重入**�?`syncDispatchableSubagents`（Agent 增删改后也会调它�?
      // 见各 `slime:agents:*` 通道）�?�⚠�?必须**显式�?`subagents`** —�??此�? `subagentsRef`
      // 还没赋�?�（它在下面�?`setSubagentManager` 之后才写），�??那个模块级引用会静默拿到
      // `null` �?�?��时一�?���?Agent 都登记不进来，�?�日志只会�?"没有�?��发的 Agent"�?
      syncDispatchableSubagents(subagents);

      // �?��委派注入：把管理器挂�?delegate_subagent 工具（模型�?话中�?��行�?派）
      setSubagentManager(subagents);
      // A-980-R30：同时挂�?fixedSegments 的清单注入（让模型知�?能问�?�?
      subagentsRef = subagents;
      /* A-1095�?��返工②）�?*成功也出�?*（一次�?�日志）�?
       * 此前整块装配�?条成功日志都没有 ⇒�?�子代理派发还在不在 Agent-Loop �?��里�?�这�?���?
       * �?��靠�?感去猜（用户原话：�?�好久没看�?了�?�）。有了这条，看一眼主进程日志即可回答�?
       * 失败�?��也各�?��立出声（见本块下方的 else �?catch —�??都写明后果，不再�?不影响主流程"）�??
       * ⚠️ 计数必须�?`catalog()`（定义清单），不�?`list()`（运行�?录）—�?�后者�?刻恒�?0�?*/
      console.log(`[subagent] 装配完成：SubAgentManager 已接线 delegate_subagent（可用定义 ${subagents.catalog().length} 个 = 内置 3 + 被授权派发的自建 Agent）`);
      // 全局子代理默认模型：恢�?上�?设置（无显式 def/委派模型时生效；继承优先级最低）
      if (subagentDefaultModels.length > 0) {
        subagents.setDefaultModels(subagentDefaultModels);
        console.log(`[subagent] 执行模型池已应用（${subagentDefaultModels.length} 档，兜底档 ${subagentDefaultModels[0]}）：${subagentDefaultModels.join(" / ")}`);
      }

      // Phase 2 事件触发源：�?�� HTTP �?���?27.0.0.1:19011�?
      // POST /agent/trigger/:id �?立即执�?�?次（webhook/外部事件统一入口）；GET /agent/status �?�?��
      createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET" && url.pathname === "/agent/status") {
          res.end(JSON.stringify({ ok: true, scheduler: scheduler.list(), subagents: subagents.list() }));
          return;
        }
        const m = /^\/agent\/trigger\/([\w-]+)$/.exec(url.pathname ?? "");
        if (req.method === "POST" && m) {
          const ok = scheduler.trigger(m[1]);
          res.end(JSON.stringify({ ok, id: m[1] }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "not found" }));
      }).listen(19011, "127.0.0.1").on("error", (e) => {
        console.warn(`[agent-http] 事件�?��监听失败: ${e instanceof Error ? e.message : String(e)}`);
      });

      // A-910：�?�?��「后台任务�?�IPC —�??定时任务增删/暂停恢�?/立即触发、子代理派发、整体快�?
      // ⚠️ A-1048：这�?*�?��换提供�??*，不再注册�?�道（�?�道已在�?��时注册，�?registerIpcHandlers）�??
      //    此前 `ipcMain.handle` 写在惰�?�初始化�?�?冷启动到首�? ensureServices 之前�?
      //    渲染层的每�?�??都会�?"No handler registered for 'slime:resident:state'"�?
      residentStateProvider = () => ({
        scheduler: scheduler.list(),
        // A-980-R31：内存运行�??+ 落盘历史合并（重�?��不再�?��白面�?/ 消失的下拉按�?��
        subagents: mergedSubagentRuns(subagents.list()),
        defaultModel: subagents.getDefaultModel(),
        defaultModels: subagents.getDefaultModels(),
      });
      ipcMain.handle("slime:resident:scheduler:add", (_e, p: { name?: string; cron?: string; prompt?: string; agentId?: string }) => {
        if (!p?.name || !p?.cron || !p?.prompt) { return { ok: false, error: "name/cron/prompt 必填" }; }
        try {
          const id = randomUUID();
          scheduler.add({ id, name: p.name, cron: p.cron, prompt: p.prompt, agentId: p.agentId });
          const list = existsSync(schedPath) ? JSON.parse(readFileSync(schedPath, "utf8")) : [];
          const arr = Array.isArray(list) ? list : [];
          arr.push({ id, name: p.name, cron: p.cron, prompt: p.prompt, agentId: p.agentId });
          writeFileSync(schedPath, JSON.stringify(arr, null, 2), "utf8");
          persistState();
          return { ok: true, id };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      });
      ipcMain.handle("slime:resident:scheduler:remove", (_e, p: { id?: string }) => {
        if (!p?.id) { return { ok: false }; }
        scheduler.remove(p.id);
        try {
          const list = existsSync(schedPath) ? JSON.parse(readFileSync(schedPath, "utf8")) : [];
          if (Array.isArray(list)) {
            writeFileSync(schedPath, JSON.stringify(list.filter((x: { id?: string }) => x?.id !== p.id), null, 2), "utf8");
          }
        } catch { /* 宽松 */ }
        persistState();
        return { ok: true };
      });
      ipcMain.handle("slime:resident:scheduler:pause", (_e, p: { id?: string }) => ({ ok: !!p?.id && scheduler.pause(p.id!) }));
      ipcMain.handle("slime:resident:scheduler:resume", (_e, p: { id?: string }) => ({ ok: !!p?.id && scheduler.resume(p.id!) }));
      ipcMain.handle("slime:resident:scheduler:trigger", (_e, p: { id?: string }) => ({ ok: !!p?.id && scheduler.trigger(p.id!) }));
      ipcMain.handle("slime:resident:subagent:spawn", (_e, p: { name?: string; task?: string; systemPrompt?: string; agentId?: string; model?: string; timeoutMs?: number; outputSchema?: boolean }) => {
        if (!p?.name || !p?.task) { return { ok: false, error: "name/task 必填" }; }
        const run = subagents.spawn({ name: p.name, task: p.task, systemPrompt: p.systemPrompt, agentId: p.agentId, model: p.model, timeoutMs: p.timeoutMs, outputSchema: p.outputSchema });
        return { ok: true, run };
      });
      // v2 取消运�?�?排队�?��子代�?
      ipcMain.handle("slime:resident:subagent:cancel", (_e, p: { id?: string }) => {
        const ok = !!p?.id && subagents.cancel(p.id!);
        // A-1106/5b�?*「排队中」�?取消�?���?不触发任何钩子的状�?�变�?*（onError �??�?
        // 已进�?execute 的任务）�?这条记录�?��落盘（重�?��消失）�?�面板也�?���?3 秒轮�???
        // 这里补齐�?onComplete/onError 同口径的�?步：落盘终�??+ 广播�?
        if (ok) {
          syncSubagentRuns(subagents.list());
          mainWindow?.webContents.send("slime:resident:update", null);
        }
        return { ok };
      });
      // A-980-R31：清�?*历史记录**（落�?+ 内存�?��终�?�的痕迹）�??
      // 运�?�?排队�?��**保留**—�?�用户�?清的�?跑完的痕�?，不能顺手把在�?�任务也干掉�?
      // 必须同时 `forgetTerminal()`：只清文件的话，下一次广�?�� `syncSubagentRuns(list())`
      // 会发现内存里那些终�?��?�?不在文件�?，又把它�?��回去（清空变僵尸）�??
      ipcMain.handle("slime:resident:subagent:clear", () => {
        const cleared = clearSubagentRuns();
        const dropped = subagents.forgetTerminal();
        mainWindow?.webContents.send("slime:resident:update", null);
        return { ok: true, cleared, dropped };
      });
      // v2 �?��委派：依任务与已注册定义�?description �?��匹配，自动�?�人派发；无匹配�?delegate �?
      // �?��合成通用子代理兜底（故这里几乎不会失败）。A-980-R30：支�?agent 点名（�?�?��/外部调用）�??
      ipcMain.handle("slime:resident:subagent:delegate", (_e, p: { task?: string; agentId?: string; agent?: string; model?: string }) => {
        if (!p?.task) { return { ok: false, error: "task 必填" }; }
        const overrides: { agentId?: string; agent?: string; model?: string } = {};
        if (p.agentId) { overrides.agentId = p.agentId; }
        if (p.agent) { overrides.agent = p.agent; }
        if (p.model) { overrides.model = p.model; }
        const run = subagents.delegate(p.task, overrides);
        if (!run) { return { ok: false, error: p.agent ? `没有名为「${p.agent}」的子代理` : "无可派发的子代理定义" }; }
        return { ok: true, run };
      });
      /* A-1100：⚠�?两条「执行模型池」�?�道（`setDefaultModel` / `setModels`）的**实现与注册都已上移到
       * 模块�?+ �?���?*（实现�?文件上方 `normalizeSubagentModelValue` / `applySubagentModels` /
       * `setSubagentModels` / `setSubagentDefaultModel`，注册�? `registerIpcHandlers()` 内的 A-1100 段）�?
       *
       * 此前它们住在**这个惰�?�块**�?—�??�?A-1048 �?���?`slime:resident:state` �?���?�?���?
       * 冷启动到服务就绪之前点�?�保存�?? 通道**�?���?* �?`ipcRenderer.invoke` reject �?
       * 渲染层那�?`await` 抛出、弹层卡住不关（用户实测「界�?��存按�?��法实现功能�?�）�?
       *
       * ⚠️ 这里**不�?**再把它们 `ipcMain.handle` 回来：同�?通道两�?注册 = �?���?��相源�?
       * 且惰性块�?���?��两�?（singleFlight �?��证并发不保证�?���?次）�?
       * 管理器仍在这里�?�??（�?下方 `subagents.setDefaultModels(subagentDefaultModels)`）�??*/
      /* A-1096：子代理「可派发」�?�?—�??**�?Agent 设置里的�?关同�?�?��相源**
       * （`config/agents.json` �?`subagent_dispatch` 字�?），`subagent-selection.json` 已�??役�??
       *
       * 为什么必须同源：此前这里�?勾�?�清�?（独立文件），�??Agent 设置�?*根本没有对应�?�?*
       * �?面板上勾了�?�Agent 详情里看不出来；刷新/换机后清单还在但用户不知道它管的�?��么�??
       * 现在：get 返回**由开关推�?*的允许清单（与�?配层 `dispatchableSubagentDefinitions` 同一判据），
       * set 直接把每�?Agent 的开关写�?true/false（显式落盘，三�?��?义不�?���?
       */
      ipcMain.handle("slime:resident:subagent:getSelection", () => ({
        ok: true,
        selectedAgentIds: dispatchableAgentIds(agentRegistry?.loadedAgents ?? []),
      }));
      ipcMain.handle("slime:resident:subagent:setSelection", async (_e, p: { selectedAgentIds?: unknown }) => {
        const ids = new Set(
          Array.isArray(p?.selectedAgentIds)
            ? (p!.selectedAgentIds as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
        );
        for (const a of agentRegistry?.loadedAgents ?? []) {
          const want = ids.has(a.id);
          // 无变化不落盘：`isSubagentDispatchAllowed` �?undefined 视作"允�?"�?
          // �?�?勾�??在字段缺省时�?*零写�?*（不会把整份 agents.json 无谓重写�?遍）�?
          if (isSubagentDispatchAllowed(a) === want) { continue; }
          await agentRegistry!.updateAgent(a.id, { subagent_dispatch: want });
        }
        syncDispatchableSubagents();
        mainWindow?.webContents.send("slime:resident:update", null);
        return { ok: true, selectedAgentIds: dispatchableAgentIds(agentRegistry?.loadedAgents ?? []) };
      });

      // A-916（slime:requests:get / :set）已移到模块�?+ �?��时注�?—�??见文件上�?readRequests 的注释�??
    } else {
      /* A-1095�?��返工②）：这�?else �?*�?���?��**，不�??代码 —�??data/schedules.json 存在�?
       * 能�? JSON.parse，但**不是数组**（例如�?手改�?`{}`），且还没有运�?态快照�??
       * 历史形�?�下这里�?*完全静默**的：整块（含子代理�?配）�?��过�?�一�?��志都不打�?
       * �?现在如实出声，并点明�?��带跳过的范围，便于一眼归因�??*/
      console.warn(
        "[scheduler] data/schedules.json 不是数组且无运行态快照 —— 跳过定时唤醒装配"
        + "（⚠️ 同块内的子代理装配 / 事件 HTTP 端点 / 后台任务 IPC 也一并被跳过；"
        + "delegate_subagent 将不可用。请把该文件写成 JSON 数组）",
      );
    }
  } catch (e) {
    /* ⚠️ A-1095�?��返工②）「诚实归因�?�：这个 catch 兜住�?*不只�?��时唤�?*。同�?块里还�?�?
     * 子代理�?配（`setSubagentManager` �?`delegate_subagent` �?*�?��**接线点）�?
     * 事件 HTTP �?��、�?�后台任务�?�IPC —�??它们会�?�?起跳过�??
     * 原文案把这个失败报成「不影响主流程�?�，�?*假安�?*：它�?Agent-Loop 少一条腿"
     * 说成"定时任务没起�?，于�?��户只看到"派发不�?�?，日志里却没有任何线�???
     * �?文�?必须点明后果与归属（�?��能力�?��起带走），不许再�?��其辞�?*/
    console.warn(
      "[scheduler] 定时唤醒装配失败 —�??⚠️ 同块内的子代理�?�?/ 事件�?�� / 后台任务 IPC �?并�?跳过"
      + `（delegate_subagent 将不�?���? ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  statsService = new StatsService(registry);
  // 依赖下载进度 �?渲染层（下载�?UI�?
  setDownloadListener((p: DownloadProgress) => {
    mainWindow?.webContents.send("slime:mind:downloadProgress", p);
  });
  // bge 嵌入模型下载完成 �?�?��拉起 embedding 服务（免手动重试），并推送状态刷�?
  setBgeReadyCallback(() => {
    const mgr = getModelServer();
    if (!mgr) return;
    void mgr.startEmbedding().then((r) => {
      console.log(`[gui:main] bge 下载完成，自动拉�?embedding: ${r.ok ? "成功" : r.error}`);
      if (r.ok) {
        void statsService?.snapshot().then((snap) => {
          mainWindow?.webContents.send("slime:stats:update", snap);
        }).catch(() => {});
      }
    }).catch((e) => {
      console.warn("[gui:main] �?��拉起 embedding 失败（不阻断，可在状态面板手动重试）:", e);
    });
  });
  console.info("[gui:main] core-ts 服务已加载（ChatService/StatsService + SandboxManager）");
});

// �?�? A-1048：启动时就必须可应答的两�??�道（�?前�?埋在惰�?�初始化里）�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
//
// 病灶（用户可见）：冷�?��后控制台反�?�?
//   `Error occurred in handler for 'slime:resident:state': No handler registered`
// 因为这两�?`ipcMain.handle` 写在�?`ensureServicesOnce()` 内部 —�??渲染层从 `createWindow()`
// 就开始轮�?��而服务初始化要等�?能扫�?/ scheduler / SILAM 等一串重活跑完（实测好几秒）�?
// �?通道**在启动时注册**，�?�由"提供�?惰�?�给出：初�?化完成前返回空�?�，完成后换成真实现�?
//   顺带消掉 `ipcMain.handle` 重�?注册的�?险（singleFlight.ts 注释里那�?×2 报错的同类）�?
let residentStateProvider: () => ResidentState = () => ({ scheduler: [], subagents: [], defaultModel: undefined, defaultModels: [] });

/** A-916：�?求�?率调节（config/requests.json）�?��?�并发上�?+ �?��重连基间隔，双�?（TS/Python）均�??�?
 *  ⚠️ 它只读一�?���?json，与 scheduler / subagent 初�?�?*�?��关系**，不该�?惰�?�初始化牵连�?*/
const REQUESTS_FILE = join(INSTALL_ROOT, "config", "requests.json");
const DEFAULT_REQUESTS = { concurrency: 2, reconnectBaseMs: 3000 };
function readRequests(): typeof DEFAULT_REQUESTS {
  try {
    if (existsSync(REQUESTS_FILE)) {
      const p = JSON.parse(readFileSync(REQUESTS_FILE, "utf8")) as Partial<typeof DEFAULT_REQUESTS>;
      return {
        concurrency: typeof p.concurrency === "number" && p.concurrency >= 1 && p.concurrency <= 20 ? p.concurrency : DEFAULT_REQUESTS.concurrency,
        reconnectBaseMs: typeof p.reconnectBaseMs === "number" && p.reconnectBaseMs >= 500 && p.reconnectBaseMs <= 15000 ? p.reconnectBaseMs : DEFAULT_REQUESTS.reconnectBaseMs,
      };
    }
  } catch { /* 损坏回�??默�? */ }
  return { ...DEFAULT_REQUESTS };
}

/**
 * A-1043：�?外入�?*签名与�?义保持不�?* —�??全仓 40 �?`await ensureServices()` 无需改动�?
 * �?���?并发调用共享同一份初始化"，�?�不再是各跑�?遍�??
 */
async function ensureServices(): Promise<void> {
  await ensureServicesOnce();
}

// �?�? 心智�?��：�?忆存�?+ BGE 嵌入（向量工具开关接线） �?�?�?�?�?�?�?

/** 嵌入�?���?��（S2：�?口只有一�?��值来源）�?
 *
 *  ⚠️ 这里**不�?**写�? `8999`。原�?`bgeEmbed` 直连字面�?`http://127.0.0.1:8999`�?
 *  绕过�?`basePortFor()` —�??用户�?旦在 `slime.toml [model_server.embedding].port` 改了�?���?
 *  管理器会�?*�?*�?���?BGE，�?�这里仍�?*�?*�?�� �?嵌入永远失败 �?`MemoryStore`
 *  **静默降级成哈�?*（用户无感，�?��记忆�?索质量悄悄变�?��。原�?恰好�?�?�?��配置没改过的巧合�?
 *
 *  两级取�?�，都不新�?判据：① 服务已就�?�?�?��由�?理器**�?��**（唯�?真�?�）�?
 *  �?�?���?�?用与管理器启动时**同一�?* `basePortFor` 按配�?��导（不可能漂移）�?*/
function embeddingBaseUrl(): string {
  const live = getModelServer()?.getPort("embedding");
  if (live && live > 0) { return `http://127.0.0.1:${live}`; }
  const cfg = readModelServerConfig();
  const port = basePortFor("embedding", cfg.embedding ?? {}, cfg.chat ?? {});
  return `http://127.0.0.1:${port}`;
}

/** BGE-M3 真实嵌入（llama-server `/v1/embeddings`，OpenAI 兼�?；失败由 MemoryStore 降级哈希�?*/
function bgeEmbed(): { embed: (text: string) => Promise<number[]> } {
  return {
    embed: async (text: string): Promise<number[]> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const resp = await fetch(`${embeddingBaseUrl()}/v1/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "bge-m3", input: text }),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          throw new Error(`embeddings HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
        const vec = data.data?.[0]?.embedding;
        if (!vec || vec.length === 0) {
          throw new Error("embeddings 空响应");
        }
        return vec;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** �?Agent 记忆存储缓存（LanceDB 初�?化失败自动降�?JSON；嵌入失败自动降级哈希） */
const memoryStores = new Map<string, MemoryStore>();

/**
 * LanceDB **运�?时组�?*的就位状态（A-1041）�??
 *
 * ⚠️ 这里曾经�?���?`lancedbEnabled: true`，与「组件是否真的在磁盘上�?�完全脱钩：
 * 组件不在时每次都要经历一�?加载失败 �?降级"，�?�且失败原因�?���?MemoryStore 内部
 * （用户只看到向量�?索没结果，不知道�?��装组件）�?
 *
 * 现在�?*先看组件在不�?*再决定开不开：不�?�?直接不开 + 把原因交给界�?��不静默）�?
 * 状�?�做缓存（只�?3 �?stat，不必每次都走�?盘），组件下�?就位后调
 * `refreshLancedbComponent()` 刷新并�?已缓存的 store 重建�?
 */
let lancedbComponentCache: LancedbComponentStatus | null = null;

export function lancedbComponent(): LancedbComponentStatus {
  if (!lancedbComponentCache) { lancedbComponentCache = lancedbComponentStatus(); }
  return lancedbComponentCache;
}

export function refreshLancedbComponent(): LancedbComponentStatus {
  lancedbComponentCache = lancedbComponentStatus();
  // 已缓存的 store �?��旧结论下构�?�的（可能已�?��级）�?全部作废重建
  memoryStores.clear();
  console.log(
    lancedbComponentCache.ok
      ? `[gui:lancedb] 组件已就位：${lancedbComponentCache.dir}`
      : `[gui:lancedb] 组件�?��位：${lancedbComponentCache.error}`,
  );
  return lancedbComponentCache;
}

function memoryStoreFor(agentId: string): MemoryStore {
  let s = memoryStores.get(agentId);
  if (!s) {
    const cfg = loadMindConfig();
    s = new MemoryStore(agentId, {
      // 组件�?���?�?不开向量层（避免每�?都走�?次失败的加载），原因由界面�?实展�?
      lancedbEnabled: lancedbComponent().ok,
      dataDir: cfg.memoryRoot || undefined,
      embed: cfg.vectorTool === "bge" ? bgeEmbed() : undefined,
    });
    memoryStores.set(agentId, s);
    if (memoryStores.size > 40) {
      memoryStores.clear();
    }
  }
  return s;
}

// 记忆�??理注入：�?per-Agent 记忆存储缓存挂到 memory_insert/search/forget 工具
// （�?�?setSubagentManager 模式；工具循�?��注入�?_agent_id 定位对应 MemoryStore）�??
setMemoryStoreProvider(memoryStoreFor);

/** 审批档位 �?SandboxConfig（会话级持久化格式：sandbox_override �?approval 档位 + workspace�?
 *  四档：manual 手动 / auto �?�� / none 无需 / custom �?��义�??
 *  旧档位兼容：strict、confirm �?manual�?*/
const APPROVAL_MODES = ["manual", "auto", "none", "custom"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** A-939 上下文分桶（引擎 done 事件携带，随 slime:chat:done 透传渲染层；各字段为 token 估算�?*/
export interface CtxBuckets {
  system: number;
  rules: number;
  memory: number;
  workspace: number;
  planning: number;
  tools: number;
  history: number;
  message: number;
}
const LEGACY_APPROVAL_MAP: Record<string, ApprovalMode> = { strict: "manual", confirm: "manual" };

function sandboxConfigFromOverride(ov: Record<string, unknown>): SandboxConfig {
  const cfg = defaultSandboxConfig();
  // 会话�?���?���??批档位时，回�?**设置里的全局默�?**（�?前硬编码 "auto"�?
  // 于是「�?�?�?权限 �?全局默�?审批模式」�?没有 override �?Agent 形同虚�?�?
  // 它们拿的�?sandbox 内置默�?（write/terminal/network 全部逐�?询问），
  // 用户在�?�?��选�?�无�?」也不会生效）�??
  const raw = (ov.approval as string) ?? getPermissions().globalApproval;
  const mode = LEGACY_APPROVAL_MAP[raw] ?? (APPROVAL_MODES.includes(raw as ApprovalMode) ? (raw as ApprovalMode) : "auto");
  if (mode === "manual") {
    cfg.auto_approve_levels = [];
    cfg.require_approval_levels = [0, 1, 2, 3, 4, 5];
    cfg.deny_levels = [];
    cfg.askOnDeny = true;
    cfg.allowOutsideWorkspace = false;
    cfg.allowDeny = false;
  } else if (mode === "auto") {
    cfg.auto_approve_levels = [0, 1, 2, 3, 4, 5];
    cfg.require_approval_levels = [];
    cfg.deny_levels = [5];
    cfg.askOnDeny = true;
    cfg.allowOutsideWorkspace = true;
    cfg.allowDeny = false;
  } else if (mode === "none") {
    cfg.auto_approve_levels = [0, 1, 2, 3, 4, 5];
    cfg.require_approval_levels = [];
    cfg.deny_levels = [5];
    cfg.askOnDeny = false;
    cfg.allowOutsideWorkspace = true;
    cfg.allowDeny = true;
  } else {
    cfg.auto_approve_levels = [];
    cfg.require_approval_levels = [0, 1, 2, 3, 4, 5];
    cfg.deny_levels = [];
    cfg.askOnDeny = true;
    cfg.allowOutsideWorkspace = false;
    cfg.allowDeny = false;
    cfg.allowPaths = getPermissions().approvalAllowPaths;
  }
  cfg.workspace = typeof ov.workspace === "string" ? ov.workspace : "";
  return cfg;
}

/** 把�?��?�?�?权限」的全局审批默�?下发�?*�?�?* Agent 的沙箱配�?���?���?+ 设置变更时）�?
 *
 *  此前�?�� `a.sandbox_override` 存在时才下发，无 override �?Agent �?直吃 sandbox 内置默�?
 *  （`auto_approve_levels=[0,1]`、`require_approval_levels=[2,3,4]`）�?��??
 *  结果「全�?默�?审批模式」只对少数会话生效，用户在�?�?��选�?�无�?」也照样�?���?*/
function applyGlobalSandboxDefaults(): void {
  if (!sandbox || !agentRegistry) { return; }
  for (const a of agentRegistry.loadedAgents) {
    try {
      const ov = (a.sandbox_override && typeof a.sandbox_override === "object")
        ? (a.sandbox_override as Record<string, unknown>)
        : {};
      sandbox.setAgentConfig(a.id, sandboxConfigFromOverride(ov));
    } catch (e) {
      console.warn(`[gui:main] 下发全局沙�?默�?失败 ${a.id}:`, e);
    }
  }
}

/**
 * 权限请求 �?选择题�?�项（渲染层输入�?UI 列出「每�??�项的结果�?�，参�??Claude Code /
 * Cursor / Cline 的授权交互：允�?�?�?/ 会话内�?�是允�? / 拒绝 / �?��义）�?
 * 按动作的权限级别与目标路径给出�?应措辞与后果说明�?
 */
function buildPermOptions(req: {
  agentId: string;
  agentName: string;
  taskDescription: string;
  actions: Array<{ action: string; target: string; level: number }>;
}): PermissionOption[] {
  const first = req.actions[0];
  const maxLevel = Math.max(...req.actions.map((a) => a.level), 0);
  const targets = [...new Set(req.actions.map((a) => a.target).filter(Boolean))];
  const targetText = targets.length > 0
    ? targets.map((t) => `\`${t}\``).join("、")
    : (first?.action ?? "此操作");

  // 级别 �?风险�?��（�?�?L0-L5 �?���?
  const riskHint =
    maxLevel <= 1 ? "只读，风险较低"
    : maxLevel === 2 ? "将写�?�?��文件，可能有改动"
    : maxLevel === 3 ? "将执行终�?��令，�?��影响系统"
    : maxLevel >= 4 ? "将�?�?��络或执�?高权限操作，风险较高"
    : "有一定风险";

  const actionLabel = first ? `${first.action} → ${first.target || "…"}` : "此操作";

  return [
    {
      id: "allow-once",
      label: "允�?通过",
      hint: `放�? ${actionLabel}�?{riskHint}）�?�下次同类操作仍会再次�?�??��?�把「�?�?�?权限」里对应类别（�? / �?/ 终�?）的�?关打�?即可免�?询问。`,
    },
    {
      id: "allow-session",
      label: "本次会话全部允许",
      hint: `放�? ${actionLabel}�?{riskHint}），且本次会话内�?Agent 的同类操作不再�?�??�`,
    },
    {
      id: "deny",
      label: "拒绝通过",
      hint: `阻�?该操作，Agent 会收到拒绝原因并尝试其他方�?。`,
    },
    {
      id: "custom",
      label: "其他需求",
      hint: `�?��你的具体指示（例如：�?��许�?�?${targetText}、改用指定目录�?�暂停操作等临时�?求）。`,
      customPlaceholder: "输入你的指示…",
    },
  ];
}

function buildAgentState(
  name: string,
  role: string,
  parentId: string | null = null,
  toolProfile?: { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] },
): AgentState {
  return {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    name,
    role,
    identity_prompt: `I am ${name}, ${role}.`,
    model_choice: "inherit",
    parent_id: parentId,
    persona: { traits: [], preferences: [], skill_ownership: [], interactions: [], created_at: null, updated_at: null },
    emotion: { mood: "neutral" },
    behavior: { active: [] },
    children: [],
    created_at: new Date().toISOString(),
    lifecycle: "growth",
    // A-980-R22：工具面白名单（缺省 �?运�?时回�?内置推荐集）
    ...(toolProfile ? { tool_profile: toolProfile } : {}),
  } as AgentState;
}

/** 边界校验：渲染层传入�?name/role 必须�?��空字符串（防�?��对象/恶意输入污染 agents.json�?*/
function assertAgentNameRole(name: unknown, role: unknown): asserts name is string {
  if (typeof name !== "string" || !name.trim() || typeof role !== "string" || !role.trim()) {
    throw new Error("name/role 必须为非空字符串");
  }
}

async function createAgent(
  name: string,
  role: string,
  toolProfile?: { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] },
): Promise<AgentState> {
  assertAgentNameRole(name, role);
  const agents = agentRegistry!.loadedAgents;
  const a = buildAgentState(name.trim(), role.trim(), null, toolProfile);
  agents.push(a);
  await agentRegistry!.save();
  return a;
}

/** A-1049：�?次启动时若没�?Agent，自动创建一�?��认�?�助手�?��?色，避免欢迎页输入�?/�?��按钮因无 Agent 而无法发送�??*/
async function ensureDefaultAgent(): Promise<void> {
  try {
    const reg = await ensureRegistry();
    if (reg.loadedAgents.length > 0) { return; }
    const a = buildAgentState(
      "助手",
      "通用 AI 助手，负责回答问题�?�编写代码�?�整理信�?��日常协作",
      null,
      { mode: "default", skills: [], mcp: [] },
    );
    reg.loadedAgents.push(a);
    await reg.save();
    console.info(`[gui:main] 首�?�?��：已创建默�? Agent ${a.id}`);
  } catch (e) {
    console.warn("[gui:main] 创建默�? Agent 失败（不影响�?���?", e instanceof Error ? e.message : String(e));
  }
}

async function forkAgent(parent: AgentState, name: string, role: string): Promise<AgentState> {
  assertAgentNameRole(name, role);
  if ((parent.fork_depth ?? 0) + 1 > 2) {
    throw new Error("分裂深度已达上限（MAX_FORK_DEPTH=2）");
  }
  const child = buildAgentState(name.trim(), role.trim(), parent.id, parent.tool_profile as { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] } | undefined);
  child.model_choice = parent.model_choice;
  child.fork_depth = (parent.fork_depth ?? 0) + 1;
  parent.children.push(child.id);
  const agents = agentRegistry!.loadedAgents;
  agents.push(child);
  await agentRegistry!.save();
  return child;
}

/**
 * �?次流式�?求的�?���?��正文 / 模型 / 耗时 / timings）�??
 *
 * ⚠️ A-1008：`fullReply` **�?���?��会话 Agent �?��的�?�?*（`type === "chunk"`）�??
 *
 * 事故：这里原�?��条件 `fullReply += chunk.data.content`，把**�?�?*�?content 的事件都算进�?—�??
 * 包括群聊�?`member` 事件（成员发�?）�?��?�群聊的 done 事件 `reply` 恒为 `""`（收束由用户），
 * `cleanReply ?? session.fullReply` 于是回�??到这�??污染�?`fullReply`，�??= **全体成员发言首尾相接�?
 * 不带任何 `【名字�?�` 归属标�?的一大坨**�?
 *
 * 渲染�?onDone 见到非空 `reply` 就追加一�?assistant 气泡（没�?agentName/agentId）→ 头部�?�?
 * **会话归属 Agent** 的名字�?�也没有「成员�?�徽标�??*这就�?��户历时很久的**
 * 「在它们说完话，总是有一�?Agent 出来总结重�?�?遍所有内容�?��?��?�它不是引擎多跑了一�?��
 * 而是这条 done 回�??污染的假回�?。同�?根因的另�?半（重启后成员气泡全�?��在落库形状，
 * �?core-ts/src/services/grouptalkTranscript.ts 的文件头�?
 *
 * `reasoning` 事件同样不�?入（思�?�不�??文，界面上另有折叠卡）；`member` 事件�?*�?���?*发言�?
 * 更不属于�?���?Agent 的回复�??
 */
function createStreamSession() {
  let fullReply = "";
  let model = "";
  let elapsedMs = 0;
  const timings: Record<string, number> = {};
  return {
    pushChunk(chunk: StreamChunk) {
      if (chunk.type === "chunk" && chunk.data.content) { fullReply += chunk.data.content; }
      if (chunk.data.model) { model = chunk.data.model; }
      if (chunk.data.elapsedMs) { elapsedMs = chunk.data.elapsedMs; }
      if (chunk.data.timings) { Object.assign(timings, chunk.data.timings); }
    },
    get fullReply() { return fullReply; },
    get model() { return model; },
    get elapsedMs() { return elapsedMs; },
    get timings() { return timings; },
  };
}

/** A-933 上下文窗口上限（单一事实源，�?done 事件下发，环与右栏共用同�?值）�?
 *
 *  �?�? S1 重写�?026-09-19）：从�?�层层推�??�改成�?�显式�?�?+ **�?��务器**」─�?�?�?�?�?�?�?�?�?�?�?�?
 *  原实现是�?�?6 级级联：agent.max_context �?�?��模型条目 ctx_len �?slime.toml chat.ctx_len
 *  �?provider 规格 �?undefined（然后渲染层再回落�?族能力表）�??
 *  �??不在某一级写错了，�?�在**真�?�来源�?�错�?*：级联里没有任何�?级知�?
 *  "llama-server 这�?到底分配了�?�?KV"。�?族能力表写的�?���?*�?���?*的窗�?
 *  （qwen3 = 524K），而服务实际按 `-c 8192` 分配 —�??于是界面显示"还剩 480K"�?
 *  请求却�?上游 400 顶回：`exceeds the available context size (8192 tokens)`（A-1018 �?���?
 *
 *  现在的优先级（决策函数唯�?出�?：`core-ts/src/model_introspect.ts` �?resolveWindowCap）：
 *    �?`agent.max_context`            —�??用户显式配置，最高优先（允�?故意设小�?
 *    �?**�?��机服务器**（`/props.n_ctx`）�?��??权威。�?�?配置里写�?�?文件里推�?
 *    �?`slime.toml` �?ctx_len        —�??**同域**兜底：它就是�?��时下发的 `-c`，仅服务器问不到时用
 *    �?provider 规格 `context_window` —�??远�?模型
 *  任何�?步都不再回落到�?族能力表�?
 *
 *  ⚠️ 两类"�?��模型"都�?覆盖（配�?��看不出区�?���?
 *    (a) slime 托�?�?llama-server —�??�?���?ModelServerManager 拿，�?*校验在服务的模型�?��**
 *        （一次只服务�?�?��型；�?A 的窗口回�?B 就是�?��位置重演同一�?bug）；
 *    (b) 指向�?��的普�?provider（�? `api_base = http://127.0.0.1:8800/v1`）�?��??用户�?��拉的进程�?
 *        slime 的启动�?录里没有它，�?��判据就是发�?求�??
 *  详�? `gui/src/main/localServerProbe.ts`�?
 *
 *  解析失败仍返�?undefined（渲染层有自己的兜底�?��，不阻断 done 下发）�??*/
async function resolveSessionWindowCap(agentId: string, modelId: string): Promise<number | undefined> {
  try {
    if (agentId && agentRegistry) {
      const agent = await agentRegistry.findAgent(agentId).catch(() => null);
      if (agent?.max_context && agent.max_context > 0) { return agent.max_context; }
    }
  } catch { /* ignore */ }
  if (!modelId) { return undefined; }
  try {
    const candidates = Array.from(new Set([
      modelId,
      modelId.replace(/^api:[^:]*:/, "").replace(/^local:/, ""),
      modelId.split(":").pop() ?? modelId,
    ])).filter(Boolean);

    const localSpec = listLocalModels().find(
      // label �??�（历史条目�?��没有）→ 显式判非空再比�?，别�?undefined 塞进 includes
      (m) => candidates.includes(m.id) || (typeof m.label === "string" && candidates.includes(m.label)),
    );
    let serverCtx: number | undefined;
    let plannedCtx: number | undefined;

    /* �? slime 托�?的本地模�?—�??�?��务器，并�??它服务的就是这个模型 */
    if (localSpec || modelId.startsWith("local:")) {
      const cap = await probeManagedChatCapability({ path: localSpec?.path, ids: candidates }).catch(() => null);
      if (cap?.effectiveCtx != null && capabilityMatchesModel(cap, { path: localSpec?.path, ids: candidates })) {
        serverCtx = cap.effectiveCtx;
      }
      /* �?同域兜底：`-c` 的真实取�?=
         模型条目�?���?ctx_len（ModelServerManager.ensure �?opts.ctxLen 优先级更高）
         ?? slime.toml chat.ctx_len。这两�?�是**同一�???*的输入侧，不�?���?份真相�??*/
      const chatCfgCtx = Number((readModelServerConfig()?.chat as { ctx_len?: number } | undefined)?.ctx_len ?? 0);
      plannedCtx = localSpec?.ctx_len && localSpec.ctx_len > 0
        ? localSpec.ctx_len
        : (chatCfgCtx > 0 ? chatCfgCtx : undefined);
      logLocalCapGap(cap?.state ?? "down", serverCtx);
    }

    /* �? 指向�?��的普�?provider（用户自己拉起的 llama-server）�?��??同样�?��务器 */
    if (serverCtx === undefined) {
      for (const p of listProviders()) {
        const base = typeof p.api_base === "string" ? p.api_base : "";
        if (!isLoopbackBaseUrl(base)) { continue; }
        const owns = (p.models ?? []).some((m) => candidates.includes(m.id))
          || (typeof p.model === "string" && candidates.includes(p.model));
        if (!owns) { continue; }
        const cap = await getLocalCapability(base).catch(() => null);
        /* 这个 baseUrl 就是该模型的地址 —�??provider 配置�?��即身份证�?��trustedEndpoint）�??*/
        if (cap?.effectiveCtx != null && capabilityMatchesModel(cap, { trustedEndpoint: true })) {
          serverCtx = cap.effectiveCtx;
          break;
        }
      }
    }

    /* �?远�? provider 的模型�?�?*/
    let providerCtx: number | undefined;
    for (const id of candidates) {
      for (const p of listProviders()) {
        const m = (p.models ?? []).find((x) => x.id === id);
        if (m?.context_window && m.context_window > 0) { providerCtx = m.context_window; break; }
      }
      if (providerCtx !== undefined) { break; }
    }

    return resolveWindowCap({ serverCtx, plannedCtx, providerSpecCtx: providerCtx }).ctx;
  } catch { /* ignore */ }
  return undefined;
}

/**
 * A-1086：把「压无可压�?�时**�?��的出�?*落到具体模型名上�?
 *
 * ## 为什么必须有这个函数
 *
 * 「固定开�?（系统提�?记忆/�?�?工具定义/工作区注入）�?��就�?�近窗口」这类超限，
 * **压缩救不回来**（压无可压）。�?时我�?��能�?用户�?换窗口更大的模型"—�??
 * �?*换哪�?*，�?前全靠用户自己一�?��试（�?��已有 `resolveSessionWindowCap` �?
 * A-158 降级链，却从�?��两�?�接起来）�?�用户在"�?么都发不出去"的�?境里�?要的�?*出路**�?
 * 不是原则。这里就把出�?��出来（判�?���?���?`pickRescueModel`）�??
 *
 * ## ⚠️ 性能约束：这函数跑在"用户刚点发�??的路径上
 *
 * 候�?�可能上百个（供应商模型清单上限 200），逐个 `resolveSessionWindowCap` �?*�?��务器**�?
 * 每�?几十~上百 ms �?用户会�?�?点发送卡住了"。所以：
 *   · **供应商模型只读静态�?�?*（`models[].context_window`）�?��??�?I/O�?
 *   · �?���?��模型（数量少）在 spec �?`ctx_len` 时才去问�?次（有缓存）�?
 *   · 拿不到窗口的�?�?*跳过**（不�?—�??猜出来的建�?会把用户带到另一�?��里）�?
 *
 * 拿不到任何�?��?�时返回 null，调用方�??**如实�?没有"**（`formatRescueHint`）�??
 *
 * ## A-1090：返回�??*三�??*，且候�?�自带�?�可直接写入的�?�择串�??
 *
 *   · `undefined` —�??**没查�?*（入参本�?��知道要�?�?/ 解析过程抛了异常）�??
 *     �?���?我们不知�?，与"查过�?��没有"**必须分开**：把"没查"说成"查过没有"
 *     �?*假陈�?* —�??用户会因此放弃一条本�?��走得通的出路（`formatRescueHint` 三�?�）�?
 *   · `null` —�??查过�?�?���?��没有能�?下的更大窗口模型�?
 *   · 对象 —�??查到了，且带 `choice`�?*�?��接写�?`model_choice` 的�?�择�?*
 *     （`api:<供应商key>:<模型id>` / `local:<模型id>`，与渲染层模型�?�择器同源）�?
 *     ⚠️ �?���?��数知道这条�?��?�来�?���?��应商 —�??�?model id **拼不�?*�?��选择�?
 *     （同�?�?id �?��同时挂在多个供应商下），�?以由这里算好回带，渲染层�??原样写入�?
 */
async function suggestWiderChatModel(requiredTokens: number, currentCap: number): Promise<RescuableModel | null | undefined> {
  // �?求量�?��就是�?��/非�? �?我们**没有资格**�?没有候�??：`pickRescueModel` 也会�?null�?
  // 但那�?null 的�?义是"不知道�?多大、不�?，不�?查过没有" �?如实归入「没查成」�??
  if (!Number.isFinite(requiredTokens) || requiredTokens <= 0) { return undefined; }
  try {
    /* ⚠️ 去重�?= `choice`（A-1090），**不是�?id**：同�?�?model id �?��同时挂在多个供应商下�?
       �?id 去重会把后面那个供应商的候�?�整�?��掉（少给�?条出�?���?
       �?能不能切过去"�?`choice` 决定，按它去重才与�?义一致�??
       �?��同族教�?：去重键要与排序�?��源（�?`pickRescueModel` 的平手判�?���?*/
    const seen = new Set<string>();
    const candidates: CapCandidate[] = [];
    const add = (id: unknown, label: string, cap: unknown, choice: string): void => {
      const mid = typeof id === "string" ? id.trim() : "";
      const c = typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : 0;
      const ch = choice.trim();
      if (!mid || !ch || c <= 0 || seen.has(ch)) { return; }
      seen.add(ch);
      candidates.push({ id: mid, label: label && label.trim() ? label.trim() : mid, cap: c, choice: ch });
    };
    // �?�?��模型：spec �?ctx_len 直接�?��缺了才问�?次服务（数量少�?�有缓存�?
    for (const m of listLocalModels()) {
      const label = String(m.label ?? "").trim() || m.id;
      const choice = `local:${m.id}`; // 与渲染层模型选择器同源（`ChatPanel` 用的就是 local:<id>�?
      if (typeof m.ctx_len === "number" && m.ctx_len > 0) {
        add(m.id, label, m.ctx_len, choice);
      } else {
        add(m.id, label, await resolveSessionWindowCap("", m.id).catch(() => undefined), choice);
      }
    }
    // �?供应商模型：**�??静�?��?�?*（�?上面的�?�能约束�?
    for (const p of listProviders()) {
      const key = String(p.key ?? "").trim();
      for (const m of p.models ?? []) {
        const id = typeof m.id === "string" ? m.id : "";
        // 没有供应�?key 就拼不出 api:<key>:<id> �?传空串�? `add` 剔除（宁�?���?条�?��?�，
        // 也不给一�?点了切不过去"的假出路 —�??那�?�?��仓最忌�?的静默失败）�?
        add(id, key ? `${key} · ${id}` : id, (m as { context_window?: number }).context_window, key ? `api:${key}:${id}` : "");
      }
    }
    const picked = pickRescueModel(requiredTokens, currentCap, candidates);
    if (picked) {
      console.info(`[gui:main] 上下文救回建议（${picked.label ?? picked.id}，${picked.cap} tokens，本次需 ${Math.round(requiredTokens)}）→ ${picked.choice ?? picked.id}`);
    } else {
      console.info(`[gui:main] 上下文救回：已查 ${candidates.length} �??��?�，没有能�?�?�?{Math.round(requiredTokens)} 的更大窗口模型`);
    }
    return picked;
  } catch (e) {
    // A-1090：解析失�?�?**没查�?*（返�?undefined），不�?说成「查过没有�?��?��?��??
    console.warn("[gui:main] �?��模型解析失败 —�??按�?�没查成」�?实告知（不�?成�?�查过没有�?�）:", e);
    return undefined;
  }
}

/** �?��服务"�?��到窗�?时的状�?�迁移日志（**去重**：只在状态变化时打一次）�?
 *
 *  它是"就绪但拿不到 n_ctx"这个**回归信号**的唯�?读取�?—�??没有它，llama.cpp 改字段名�?
 *  界面�?��静默地�??回兜底�?�，我们看不到任何异常�??
 *  S4 会把 `state` 提升成下发字段（那时这里降级为纯日志）�??*/
let lastLocalCapWarn: string | null = null;
function logLocalCapGap(state: string, serverCtx: number | undefined): void {
  const key = `${state}|${serverCtx ?? "-"}`;
  if (key === lastLocalCapWarn) { return; }
  lastLocalCapWarn = key;
  if (state === "ready" && serverCtx === undefined) {
    console.warn(
      "[gui:cap] 本地服务已就绪但解析不出 n_ctx —— 端点半结构可能变了；" +
      "已回落到 slime.toml 的 ctx_len。请检查 /props.default_generation_settings.n_ctx " +
      "/v1/models.data[].meta.n_ctx 的字段名（见 core-ts/src/model_introspect.ts 的文件头实测记录）。",
    );
  } else if (state === "loading") {
    console.info("[gui:cap] 本地模型加载中（/props 503 unavailable_error），窗口上限本次取兜底值");
  }
}

/** A-980-R26：�?�知标�?用的 Agent 显示名（查不到就回落�?Agent id / 通用文�?，绝不抛�?*/
function agentNameForNotify(agentId: string | undefined): string {
  try {
    if (agentId && agentRegistry) {
      const a = agentRegistry.loadedAgents.find((x) => x.id === agentId || x.name === agentId);
      if (a?.name) { return a.name; }
    }
  } catch { /* ignore */ }
  return agentId || "Agent";
}

/** A-980-R24：为�?条流创建「chunk 发�?�合批器」�??
 *
 *  上游每吐�?�?token 就回调一�?�?此前主进�?*逐条** `webContents.send("slime:chat:chunk")`�?
 *  高�?�率模型下变成每秒数百条 IPC。Electron �?send 没有背压，渲染进程（同时还在�?Markdown
 *  全量重解析）�?旦跟不上，消�?��列只增不�?�?渲染进程 OOM（`data/logs/renderer-crash.log`
 *  已�?录过 `oom`，用户侧表现就是"用着用着 slime 直接崩了、任务中�?）�??
 *
 *  这里把�?�同�?条流 + 同类型�?�的�?���??量按 40ms 窗口合并成一条再发（�?5 �?秒，观感无损），
 *  IPC 消息数下�?1~2 �?��量级�?*�?��发�?�侧**：`session.pushChunk()` 仍按原�? chunk 记录�?
 *  �?��重放与轨迹数�?��受影响�?��?�?`gui/src/main/streamBatch.ts`�?
 *
 *  ⚠️ `done` / `error` 之前必须 `flush()`，否则最后一段�?文会晚于 done 到达（尾部丢字）�?*/
function createChunkSender(): StreamChunkBatcher {
  return new StreamChunkBatcher((chunk) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("slime:chat:chunk", chunk);
    }
  });
}

/** 引擎事件 �?IPC StreamChunk：统�? snake_case→camelCase 字�?映射（elapsed_ms→elapsedMs 等）
 *
 *  关键兼�?：后�?`done` 事件会把 `prompt_tokens` / `completion_tokens` 放在 chunk **�?外层**�?
 *  `timings` 对象�?���?A-098 全链�??�时（不�?���?token 字�?）�??
 *  渲染�?`ChatPanel.ContextRing` �??�?`m.timings.promptTokens`�?
 *  �?以这里必须把 token 统�? **同�?注入 timings**，才能�?右上�?上下文占�?真�?跳动�?
 *  也�?任务页�?�用量分析�?�有 prompt/completion/cache-read 等累计数�?���?
 */
function toStreamChunk(ev: { seq: number; type: string; data: unknown }, sessionId?: string): StreamChunk {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const pt = typeof d.promptTokens === "number" ? d.promptTokens : typeof d.prompt_tokens === "number" ? d.prompt_tokens : undefined;
  const ct = typeof d.completionTokens === "number" ? d.completionTokens : typeof d.completion_tokens === "number" ? d.completion_tokens : undefined;
  const em = typeof d.elapsedMs === "number" ? d.elapsedMs : typeof d.elapsed_ms === "number" ? d.elapsed_ms : undefined;
  const mergedTimings: Record<string, number> = {};
  if (typeof d.timings === "object" && d.timings !== null) {
    // 先�?制原�?timings，再�?promptTokens / completionTokens / elapsedMs 覆盖注入（统�? camelCase�?
    for (const [k, v] of Object.entries(d.timings as Record<string, number>)) {
      if (typeof v === "number") { mergedTimings[k] = v; }
    }
  }
  if (typeof pt === "number") { mergedTimings.promptTokens = pt; }
  if (typeof ct === "number") { mergedTimings.completionTokens = ct; }
  if (typeof em === "number") { mergedTimings.elapsedMs = em; }
  // A-098 预留：后�?���?cache read 时给�?0（避免�?览面板的「缓存命�??��?终是 -�?
  if (typeof mergedTimings.cacheReadTokens !== "number") {
    if (typeof (d as any).cache_read_tokens === "number") {
      mergedTimings.cacheReadTokens = (d as any).cache_read_tokens;
    } else if (typeof (d as any).cacheReadTokens === "number") {
      mergedTimings.cacheReadTokens = (d as any).cacheReadTokens;
    } else {
      mergedTimings.cacheReadTokens = 0;
    }
  }
  // 缓存写入 token（prompt caching �?cache_creation；可选�?�传，供用量分析展示�?
  if (typeof mergedTimings.cacheCreationTokens !== "number") {
    if (typeof (d as any).cache_creation_tokens === "number") {
      mergedTimings.cacheCreationTokens = (d as any).cache_creation_tokens;
    } else if (typeof (d as any).cacheCreationTokens === "number") {
      mergedTimings.cacheCreationTokens = (d as any).cacheCreationTokens;
    }
  }
  // reasoning tokens：按 timings �?��见键兜底 0（DeepSeek / o1 系列引擎会回�?��
  if (typeof mergedTimings.reasoningTokens !== "number") {
    if (typeof (d as any).reasoning_tokens === "number") {
      mergedTimings.reasoningTokens = (d as any).reasoning_tokens;
    } else {
      mergedTimings.reasoningTokens = 0;
    }
  }
  // A-974-R7：窗口占用口径（「最近一�??�输入侧 token；仅工具�?���?��下发）�?��??
  // 工具�?��每轮全量重发历史，�?�?prompt_tokens �?���?��计（计费口径）；
  // 直接拿它当窗口占用会 N �?���?�?GUI 上下文环/右栏爆表（用户实测�?文输出后爆到 1.1M）�??
  {
    const wpt = (d as any).window_prompt_tokens ?? (d as any).windowPromptTokens;
    const wcr = (d as any).window_cache_read_tokens ?? (d as any).windowCacheReadTokens;
    if (typeof wpt === "number") { mergedTimings.windowPromptTokens = wpt; }
    if (typeof wcr === "number") { mergedTimings.windowCacheReadTokens = wcr; }
  }
  // A-974-R8：协�??义标记（OpenAI 兼�?=true=prompt 已含缓存命中 / Anthropic=false）�?��??
  // 渲染层窗口占用公式据此决定是�?+cacheRead，避�?OpenAI 兼�?系重复�?缓存导致窗口虚高�?
  // timings �?number �?��布尔编码�?1/0，渲染层�?`=== 1` 判定�?
  {
    const cri = (d as any).cache_read_in_prompt ?? (d as any).cacheReadInPrompt;
    if (typeof cri === "boolean") { mergedTimings.cacheReadInPrompt = cri ? 1 : 0; }
  }
  return {
    seq: ev.seq,
    type: ev.type as StreamChunk["type"],
    data: {
      content: typeof d.content === "string" ? d.content : undefined,
      name: typeof d.name === "string" ? d.name : undefined,
      // A-1061②：工具调用 id 必须显式透传 —�??白名单构造漏�?行就会�?静默丢掉�?
      // 界面于是无法把�?�执行中…�?�翻成�?�成�?失败」（那一行会永远停在执�?�?���?
      toolId: typeof d.toolId === "string" ? d.toolId : undefined,
      // A-1060：steer 事件的卡�?id 必须**显式透传** —�??这个 data �?��名单构�?�，
      // 漏一行就会�?静默丢掉：界�?���?��知道那张待发卡片已经生效，会再排队发�?遍（重�?发�?�）�?
      steerId: typeof d.steerId === "string" ? d.steerId : undefined,
      /** A-957：member 事件归属 Agent id 必须透传—�?��?前�?白名单滤�?�?群聊成员消息 agentId=undefined �?多人发言全�?并进�?��条（名字全显�?���?��员） */
      agentId: typeof d.agentId === "string" ? d.agentId : undefined,
      // A-162: 工具参数与结果�?�传（tool 事件前�?提取网址/文件�?��展示细节行）
      args: typeof d.args === "string" ? d.args : undefined,
      result: typeof d.result === "string" ? d.result : undefined,
      model: typeof d.model === "string" ? d.model : undefined,
      reasoning: typeof d.reasoning === "string" ? d.reasoning : undefined,
      promptTokens: pt,
      completionTokens: ct,
      elapsedMs: em,
      timings: Object.keys(mergedTimings).length > 0 ? mergedTimings : undefined,
      message: typeof d.message === "string" ? d.message : undefined,
      sessionId,
    },
  };
}

/* A-1017：`isLocalModelReady(agent)` 已删除�??
 * 它做的事�?调用方自己再查一次就�?���?—�?�先另�?�?�?providers 表拿�?spec.path，再拿路径去
 * `mgr.isChatReady(path)` �?*裸字符串比较**；只要这�?��径与"管理器里实际加载�?model_path"有出�?
 * （引擎用的是它构造时�?providers �?��，本文件读的�?��时盘上文件），就**永久判否** �?
 * 模型已就�?��每轮对话都弹全屏「�?在加载本地模型�?��?�判�?��该由调用方重新推导，它只有一�?��值来源：
 * ModelServerManager �?��的实例状态�?�现在由管理器的状�?�广�?��动面板（�?initModelServerManager）�??*/

/** A-980-R24：窗口启动尺�?*固定按屏幕工作区比例**（不再沿用上次�??出尺寸）�?
 *
 *  用户实测诉状：每次重�?��恢�?上�?拖过的大�?�?同一程序在不同时�?长相不一"，且拖小过之�?
 *  再启动就�?��小窗。现�?��每�?�?��都用主屏工作区比例算出尺寸并**居中**，只有位�?��选�?忆�??
 *  比例取自用户给定的目标版式截图实测：窗口占工作区�?77.8%、高 89.9%�?
 *  （另�?�?��带好处：窗口渲染尺�?稳定 �?首帧布局/动画节拍也稳定，不再随上次窗口大小漂移�?�） */
interface WindowState { width: number; height: number; x?: number; y?: number; }
const WIN_STATE_PATH = resolveExtra("../config/winstate.json");
/** 窗口�?小尺�?—�??**由布�?�?��的硬下限推�?，不�?��脑�?定的**（A-1018）�??
 *
 *  三栏（都展开时）各自�?再也不能�?的�?度：
 *    · 左栏 `.sidebar`      min-width 240px�? App �?SIDEBAR_MIN_W�?
 *    · 聊天主区 `.main`     min-width 380px�? App �?CHAT_MIN_W，保底可读）
 *    · 右栏 `.right-sidebar` min-width 260px
 *  合�? 880px。窗口再窄时：右�?wrapper 会�? flex 压缩，�?�内�?`.right-sidebar` �?
 *  min-width 260 顶着不�?，于�?��**超出 wrapper 并�? `overflow:hidden` 裁掉** —�??
 *  右栏**右上角的展开/折叠按钮正好�??到�?野�?**（用户原话："右侧边栏的展�?折叠按钮消失�?
 *  同时聊天栏目的内容跑到屏幕�?"）�?�所以最小�?度必�?�?三栏下限之和�?
 *  880 + 边�?/滚动条余�?�?**900**�?
 *
 *  ⚠️ 改这三个 min-width �?��意一�?��这里必须同�?重算（否则又会挤出上面那两个症状）�??
 *     高度 560 保持原�?�：纵向没有这类"三栏并列"的硬约束�?*/
const WIN_MIN = { width: 900, height: 560 };

/* �?�? 主�?持久化（A-1019）─�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
 * 为什么主进程要自己存�?份主题：
 *   渲染层的主�?存在 localStorage 里，**主进程�?不到**；�??`titleBarOverlay.color`
 *   必须�?*创建窗口�?*就已经�?�?��否则会先显示�?帧错�?���?—�??alpha 主�?�?
 *   那三�?��统按�?���?小化/还原/关闭）背后会�?��块比标�?栏更深的色块
 *   （用户原话：「这三个按钮有个明显的色块背�?��给我去了」）�?
 *   A-1018 �?��了�?�切�?��题�?�这条路径，�?���?��仍是写�? beta �?�?残留�?
 *   现在：窗口创建时读本文件；渲染层挂载后调 `slime:theme:set` 会把它写回来�?
 * 文件位置沿用既有约定（每�?��能一�?config/*.json：notifications / winstate / mind …）�?*/
const THEME_CFG_PATH = join(PROJECT_ROOT, "config", "theme.json");

/** 读取持久化主题；缺省 = beta（与渲染�?theme.ts �?getTheme() 默�?值保持一致） */
function readPersistedTheme(): "alpha" | "beta" {
  try {
    const p = JSON.parse(readFileSync(THEME_CFG_PATH, "utf8")) as { theme?: string };
    return p.theme === "alpha" ? "alpha" : "beta";
  } catch {
    return "beta";
  }
}

function writePersistedTheme(theme: string): void {
  try {
    mkdirSync(join(PROJECT_ROOT, "config"), { recursive: true });
    writeFileSync(THEME_CFG_PATH, JSON.stringify({ theme: theme === "alpha" ? "alpha" : "beta" }, null, 2), "utf8");
  } catch (e) {
    /* 持久化失败不影响�??运�?，只�?��次启�?overlay 初�?�可能不�?*/
    console.warn("[gui:main] 写入主�?配置失败:", e instanceof Error ? e.message : String(e));
  }
}

/** 标�?栏系统按�?overlay 配色：`color` 必须等于标�?栏的**实际合成�?*，否则按�?��面就�?��块色块�??
 *  · alpha：`.titlebar { background: var(--bg-secondary) }` = `#1e293b`（不透明�?
 *  · beta ：`--bg-secondary: rgba(15,22,40,.6)` 叠在 `--bg: #05070e` �?
 *           = 0.6×(15,22,40) + 0.4×(5,7,14) = (11,16,30) = `#0b101e`
 *  改主题配色时�?-bg-secondary / --bg �?�?��这里必须同�?重算�?*/
function titleBarColors(theme: string): { color: string; symbolColor: string } {
  return theme === "alpha"
    ? { color: "#1e293b", symbolColor: "#e2e8f0" }
    : { color: "#0b101e", symbolColor: "#e6f1ff" };
}
/** 默�?尺�?比例（�?主屏工作区�?/高，用户指定版式�?*/
const WIN_DEFAULT_RATIO = { width: 0.78, height: 0.90 };
/** 默�?尺�?下限（�?�?超小屏时保证�?��工作面的�?小�?�辑窗口�?*/
const WIN_DEFAULT_FLOOR = { width: 1040, height: 700 };

function defaultWindowState(): WindowState {
  const wa = screen.getPrimaryDisplay().workArea;
  const wantW = Math.round(wa.width * WIN_DEFAULT_RATIO.width);
  const wantH = Math.round(wa.height * WIN_DEFAULT_RATIO.height);
  // 下限保证小屏不缩得过小，上限受工作区与全�?极�?�双重约束，杜绝越界
  const w = Math.max(WIN_MIN.width, Math.min(Math.max(wantW, WIN_DEFAULT_FLOOR.width), wa.width, 2560));
  const h = Math.max(WIN_MIN.height, Math.min(Math.max(wantH, WIN_DEFAULT_FLOOR.height), wa.height, 1600));
  return { width: w, height: h };
}

/** A-980-R24：只读回**位置**（尺寸一律由上方�?defaultWindowState 按比例重算）�?
 *  并按新尺寸重新钳制进工作区�?��?�否�?旧坐�?+ 新尺�?会�?窗口探出屏幕外�??*/
function loadWindowPos(size: { width: number; height: number }): { x?: number; y?: number } {
  try {
    const s = JSON.parse(readFileSync(WIN_STATE_PATH, "utf8")) as Partial<WindowState>;
    if (typeof s.x !== "number" || typeof s.y !== "number") { return {}; }
    const wa = screen.getPrimaryDisplay().workArea;
    const x = Math.round(s.x), y = Math.round(s.y);
    if (x + 200 > wa.x + wa.width || y + 120 > wa.y + wa.height || x < wa.x - 400 || y < wa.y - 400) {
      return {}; // 位置越界（换显示�?分辨率变了）�?不给坐标，走默�?居中
    }
    return {
      x: Math.max(wa.x, Math.min(x, wa.x + wa.width - size.width)),
      y: Math.max(wa.y, Math.min(y, wa.y + wa.height - size.height)),
    };
  } catch {
    return {};
  }
}

function persistWindowState(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) { return; }
  try {
    // A-980-R24：只存位�?��尺�?下�?�?���?律按比例重算，不存也不�?�?
    const [x, y] = win.getPosition();
    writeFileSync(WIN_STATE_PATH, JSON.stringify({ x, y }), "utf8");
  } catch { /* 首�?无目录时忽略（下次写�?*/ }
}
let winStateTimer: NodeJS.Timeout | null = null;
function schedulePersistWindowState(): void {
  if (winStateTimer) { clearTimeout(winStateTimer); }
  winStateTimer = setTimeout(() => { winStateTimer = null; persistWindowState(); }, 400);
}

function createWindow(): void {
  // A-980-R26：�?�知模块注入主窗口获取器 + 设置 Windows AppUserModelID（�?�知归属，须早于任何弹窗�?
  initNotify({ getWindow: () => mainWindow });
  // A-980-R24：每次启动都按屏幕比例定尺�? + 居中（位�?��选�?忆，�?loadWindowPos�?
  const st = defaultWindowState();
  const pos = loadWindowPos(st);
  mainWindow = new BrowserWindow({
    width: st.width, height: st.height, x: pos.x, y: pos.y,
    minWidth: WIN_MIN.width, minHeight: WIN_MIN.height, show: false,
    // A-1092：传 nativeImage（�?尺�?�?次交给系统）而非�?��字�?串，任务栏按 DPI 精确取尺寸�??
    icon: resolveAppIconImage(),
    // Campanula 式自绘标题栏：隐藏系统标题栏，Windows overlay 渲染窗口按钮
    titleBarStyle: "hidden",
    // A-1018/A-1019：初值必须等�?*当前持久化主�?*的标题栏合成色，否则�?���?��那三�?
    // 系统按钮背后会闪�?块比标�?栏更�?��更暗的色块�?��?处�? config/theme.json（�? titleBarColors）�??
    titleBarOverlay: { ...titleBarColors(readPersistedTheme()), height: 40 },
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      // 聊天/IDE 场景不需要拼写�?查，关掉�?��下拼写词典加载与内存（Electron 官方性能清单�?
      spellcheck: false,
      // 右侧栏�?�浏览器」标签页使用 <webview> 内嵌网页（仅加载用户指定�?URL�?
      webviewTag: true,
      preload: join(__dirname, "../preload/index.js"), webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // A-980-R23：拖�?缩放/关闭时持久化窗口状�?�（下一�?��恢�?同尺寸同位置�?
  mainWindow.on("resize", () => schedulePersistWindowState());
  mainWindow.on("move", () => schedulePersistWindowState());
  mainWindow.on("close", () => persistWindowState());
  // GPU 崩溃保护：ready-to-show �?��发时（�? GPU exit_code=-1），兜底主动 show
  setTimeout(() => { if (mainWindow && !mainWindow.isVisible()) mainWindow.show(); }, 3000);
  // A-975：渲染进程崩溃自愈（DeepSeek 长时间生成实测白�?+ 终�?无限 error 的根因一半在此）—�??
  // 渲染进程�?旦崩溃（OOM/长任�?�?��），主进程仍在持�?send �?每条对已�?�?webContents 报错 �?"无限 error"�?
  // 窗口则停在纯白�?��?处：崩溃原因落盘 + �?�� reload 恢�?（在途流现场�?per-session �?��/后台镜像兜底）�??
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    try {
      const dir = resolveExtra("../data/logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "renderer-crash.log"), `${new Date().toISOString()}\t${details.reason} (exit=${details.exitCode})\n`, { flag: "a" });
      console.error("[gui:main] 渲染进程已崩溃，原因:", details.reason, "(将自动重载恢�?");
    } catch { /* ignore */ }
    // A-980-R26：意外终�?�?系统通知（用户可能�?在别的窗口，页面白屏他看不到�?
    notifyUser({
      kind: "aborted",
      title: "slime 意�?终�?",
      body: `界面进程异常退出（${details.reason}），已自动重载恢复；进行中的生成可能已中断。`,
    });
    try { mainWindow?.webContents.reload(); } catch { /* ignore */ }
  });
  // 渲染进程无响应（主线程�?�?��/巨大长任务）�?记录后尝试重载恢�?
  mainWindow.webContents.on("unresponsive", () => {
    try {
      const dir = resolveExtra("../data/logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "renderer-unresponsive.log"), `${new Date().toISOString()}\n`, { flag: "a" });
    } catch { /* ignore */ }
    // A-980-R26：界面卡死（主线程�?�?��/巨长任务）也�?意�?终�?"体验—�?��?�知提醒用户
    notifyUser({
      kind: "aborted",
      title: "slime 界面无响应",
      body: "界面进程长时间未响应，可能正在执行超长任务；若无恢复请重启应用。",
    });
  });
  // A-937：�??出�?为�?��?�后台模式拦�?close �?隐藏窗口 + 托盘常驻（真正�??出走托盘菜单�?app.quit�?
  mainWindow.on("close", (e) => {
    if (exitModeStore === "background" && !appIsQuitting) {
      e.preventDefault();
      mainWindow?.hide();
      ensureTray();
      syncTrayTooltip();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  // A-1055：托盘提示�?跟随窗口�??性（show/hide/minimize 三条�?��要能同�?，否则托盘上写着
  // "已最小化到托�?而窗口其实开�? —�??又是�?处会�??人的静默失配�?
  mainWindow.on("show", syncTrayTooltip);
  mainWindow.on("hide", syncTrayTooltip);
  mainWindow.on("minimize", syncTrayTooltip);
  mainWindow.on("restore", syncTrayTooltip);
}

/**
 * 二进制度嗅探：�?�?buffer �?N 字节�?��否含 NUL 字节�?x00），
 * 命中即�?为二进制。文�?��件几乎不�?NUL；压缩包/�?���?媒体等二进制必然�?���?NUL�?
 * 用于在把文件内�?作为文本/预�?返回前拦下二进制，防�?��码与渲染崩溃�?
 */
function binarySniff(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

function registerIpcHandlers(): void {
  // �?��状�?�查�?��渲染层启动加载面板：错过 push 事件时拉取当前状态）
  ipcMain.handle("slime:boot:status", () => bootQuery ?? { phase: "starting", backendReady: false, message: "正在初始化…" });
  // A-1039：应用版�?��（启动面板副标�?）�?�用 app.getVersion() 而非读文�?—�??打包�?
  // package.json �?asar 内，�?electron-builder 会把 version 注入 app 元数�?��这是权威来源�?
  ipcMain.handle("slime:app:version", () => app.getVersion());

  // A-1048：这两个通道**必须在启动时就在**。渲染层�?createWindow() 就开始轮询它�?��
  // 而�?前它�??注册在惰性的 `ensureServicesOnce()` 里（要等�?能扫�?SILAM 等重活跑完）�?
  // 于是每�?冷启动都会刷�?�?"No handler registered"。�?�本�?���?��性：
  // resident �?`residentStateProvider`（就�?��返回空�?�），requests 直接读本�?json�?
  ipcMain.handle("slime:resident:state", () => residentStateProvider());
  ipcMain.handle("slime:requests:get", () => readRequests());
  ipcMain.handle("slime:requests:set", (_e, p: { concurrency?: number; reconnectBaseMs?: number }) => {
    const cur = readRequests();
    const next = {
      concurrency: typeof p?.concurrency === "number" && p.concurrency >= 1 && p.concurrency <= 20 ? Math.floor(p.concurrency) : cur.concurrency,
      reconnectBaseMs: typeof p?.reconnectBaseMs === "number" && p.reconnectBaseMs >= 500 && p.reconnectBaseMs <= 15000 ? Math.floor(p.reconnectBaseMs) : cur.reconnectBaseMs,
    };
    try {
      writeFileSync(REQUESTS_FILE, JSON.stringify(next, null, 2), "utf8");
      return { ok: true, ...next };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // A-1100：子代理「执行模型池」的两条写�?�道也必须在�?��时就�?��与上�?A-1048 同因）�??
  // 病灶：�?前只有惰�?`ensureServicesOnce()` 里那�?份注�?�?冷启动窗口内点�?�保存�?�时
  // `invoke` reject（No handler registered），渲染层裸 await 抛出 �?弹层卡住�?
  // 按钮「点了没反应」（用户实测「界�?��存按�?��法实现功能�?�）�?
  // ⚠️ 这两�?*不依�?* `ensureServicesOnce`：实现是模块级纯函数（真�?= `subagentDefaultModels`
  //    + 磁盘，�?理器就绪时顺带同步）。所以这里可以放心直连，不需�?provider 间接层�??
  ipcMain.handle("slime:resident:subagent:setModels", (_e, p: { models?: unknown }) => setSubagentModels(p?.models));
  ipcMain.handle("slime:resident:subagent:setDefaultModel", (_e, p: { model?: unknown }) => setSubagentDefaultModel(p?.model));

  /** 获取当前选中 Agent ID（优先渲染层传入，回�?到�?�?�?root Agent�?*/
  function resolveAgentId(inputAgentId: string | undefined): string {
    if (inputAgentId) { return inputAgentId; }
    if (selectedAgentId) { return selectedAgentId; }
    // 回�??：取�?���?root Agent
    const roots = agentRegistry!.loadedAgents.filter((a) => !a.parent_id);
    return roots[0]?.id ?? "primary";
  }

  /** 会话上下文加载（注入聊天请求；会话隔离，旧�?录归首个会话）�??
   *
   *  A-969 首�?落地压缩注入�?*A-1082 重写**（把内联拼�?收回�?��块，�?��「假压缩」）�?
   *
   *  旧实现在这里内联�?`if (meta.contextSummary && �? { 摘�?�?+ �?�� + lines.slice(-K) }`�?
   *  于是产生两个真实缺陷�?
   *   �?**条件绑�?�?`contextSummary` �?* —�??摘�?不可用时（trim 档）`setSessionSummary(sid, null, K)`
   *      �?`contextSummary` �?并删�?�?这里判假 �?**返回完整�??�?���?*：界面报「已压缩 N �??�，
   *      实际�?�?��符都没少，原样重发再次超限（用户症状「压缩并非真压缩」的直接来源）�??
   *   �?切口�?`lines.slice(-K)` �?*条数**�?��，可能落在半�?�� �?`user, user` 连续同�?色（I3 违反）�??
   *
   *  现在：只�?`summaryCount` 存在�?*与摘要是否成功无�?*）就真的裁；切口�?律走 turn 对齐�?��数�??*/
  /** 持久化历史的�?行（`HistoryRecord` �?�� user/ai 两个字�?串字�?�?恒为 user/assistant 成�?�?*/
  type SessionHistoryLine = { role: "user" | "assistant"; content: string };
  type LoadedHistory = { raw: SessionHistoryLine[]; meta: Awaited<ReturnType<typeof getSession>> };

  /**
   * �?*原�?全量历史**（未按压缩状态折叠）+ 会话元数�?—�??压缩判据与摘要素材的**�?��**入口�?
   *
   * A-1085：`opts.full` —�??**摘�?�?��须传 true**�?
   * 常�?发�?�只读最�?`HISTORY_LOAD_LIMIT` 条（保护发�?�体�?��，但那条上限�?*摘�?**�?��难：
   * 摘�?�??盖最�?~25 �?��更早的�?�?*从未进入摘�?**，�?�它�?��时也不在保留尾巴�?�?
   * **静默丢失**（界面报"已压�?N �?，早期上下文却蒸发了）�?�摘要轮的职责恰恰是
   * "把早期内容收进摘�?，所以它必须�?*全部**历史（`limit <= 0` = 不限）�??
   * ⚠️ `readLines` �?��就是全量读盘 + 逐�? parse，`limit` �?���?�?slice �?�?�?
   *    `full` **不�?加任�?I/O 成本**�?
   */
  async function loadRawHistoryWithMeta(sessionId: string | undefined, opts?: { full?: boolean }): Promise<LoadedHistory> {
    if (!sessionId) { return { raw: [], meta: null }; }
    try {
      const meta = await getSession(sessionId);
      if (!meta) { return { raw: [], meta: null }; }
      const agentSessions = (await listSessions()).filter((m) => m.agentId === meta.agentId);
      const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
      // `0` = 不限（�? core-ts �?loadHistoryForSession / tailLimit�?
      const records = await loadHistoryForSession(meta.agentId, meta.id, opts?.full ? 0 : HISTORY_LOAD_LIMIT, firstSession);
      const raw: SessionHistoryLine[] = records.flatMap((r) => [
        { role: "user" as const, content: r.user },
        { role: "assistant" as const, content: r.ai },
      ]);
      return { raw, meta };
    } catch (e) {
      console.warn("[gui:main] 会话原�?历史加载失败:", e);
      return { raw: [], meta: null };
    }
  }

  /**
   * 把原始历史折叠成**实际会发出去**的消�?���?
   * （摘要头 + �?�� + �?�?K 整轮；摘要不�?��时只�?turn 对齐裁剪）�??
   *
   * ⚠️ A-1106：这里是**�?*函数（只依赖入参），刻意与�?��?盘�?�分�?—�??
   *    因为压缩判据必须**同时**拿到「原始全量�?�（�??�?/ 摘�?素材）与「折叠�?图�?�（真实发�?�体�?���?
   *    而旧实现把两者揉在一�?��数里，压�?handler �?��得到折叠视图 �?两个 P0（�?见压�?handler）�??
   */
  function foldSessionHistory(raw: SessionHistoryLine[], meta: LoadedHistory["meta"]): SessionHistoryLine[] {
    const keep = meta?.summaryCount ?? DEFAULT_TAIL_KEEP;
    // 至少两轮以上才�?�得裁（裁到不足�?�?��把当前话题一起丢掉）
    if (meta?.summaryCount !== undefined && raw.length > keep * 2) {
      if (meta.contextSummary) {
        // 摘�?档：摘�?�?+ �?�� + �?�?K 整轮（含「理解�?�结」环的续接�?知）�?
        // buildCompactedHistory �?LoopMessage 泛化签名，生产数�?���?user/assistant + string�?
        // 此�?按�?约收窄（ChatMessage �?role �?enum、content �?string|null，不许放宽�?约）�?
        return buildCompactedHistory(meta.contextSummary, raw, keep, { comprehend: meta.contextComprehend }) as SessionHistoryLine[];
      }
      // trim 档：摘�?不可�?�?**�??不摘�?*（诚实降级，但�?求必须真的变小）
      return truncateTurnAligned(raw, keep);
    }
    return raw;
  }

  /** 加载**折叠�?*的会话历史（摘�?�?+ �?�� + �?�?K 整轮）�?��??请求�?��与�?�压缩后体积校验」用�?*/
  async function loadSessionHistory(sessionId: string | undefined, opts?: { full?: boolean }): Promise<SessionHistoryLine[]> {
    const { raw, meta } = await loadRawHistoryWithMeta(sessionId, opts);
    return foldSessionHistory(raw, meta);
  }

  /* �?�? 异�?对话框（A-151）：渲染层不再用 window.confirm/alert（Electron 同�?阻�?渲染进程 JS�?
   *  对话框显示异常时整个 UI 冻结、所有输入�?失灵）�?�改走主进程原生异�?对话框，永不阻�?渲染层�??�?�? */
  handleTrusted<{ message: string; detail?: string }>("slime:dialog:confirm", async (_event, payload) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      return { ok: false, confirmed: false, error: "无窗口" };
    }
    const r = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["取消", "�?��"],
      defaultId: 1,
      cancelId: 0,
      title: "确认操作",
      message: payload.message,
      detail: payload.detail ?? "",
      noLink: true,
    });
    return { ok: true, confirmed: r.response === 1, error: null };
  });

  handleTrusted<{ message: string; detail?: string }>("slime:dialog:alert", async (_event, payload) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      return { ok: false, error: "无窗口" };
    }
    await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["知道了"],
      defaultId: 0,
      title: payload.detail ? "提示" : "提示",
      message: payload.message,
      detail: payload.detail ?? "",
      noLink: true,
    });
    return { ok: true, error: null };
  });

  handleTrusted<ChatInput>("slime:chat:stream", async (_event, input: ChatInput) => {
    try {
    await ensureServices();
    // A-1035：每�?��始前刷新�?次技能可见集 —�??上一�?��知识引擎�?��生成的技能，
    // 下一�?��能�? skill_search �?索到（不必重�?���?���?
    await refreshAgentSkills();
    const agentId = resolveAgentId(input.agentId);
    // A-1017：�?��?在加载本地模型�?�面�?*不再在这里�?�?*�?
    // 此前�?`needLoadingPanel = isLocalModel && !isLocalModelReady(agent)` —�??判断依据由调用方
    // �?��重新推�?（另读一�?providers �?+ 裸字符串比路径），与"管理器里实际加载了哪�?���?
    // �?旦有出入�?*永久判否**：模型明明已就绪，每�??话仍弹一次全屏加载面板（用户报的"每�?都加�?）�??
    // 现在�?��真�?�来�?= ModelServerManager 的状态广�?���?initModelServerManager �?onChatState）：
    // 真的�?始加载才弹�?�就�?失败/取消即关。这里只登�?取消�?��供面板上的�?�取消加载�?�按�?��用�??
    const loadingAgent = await agentRegistry!.findAgent(agentId).catch(() => undefined);
    const cancelKey = input.sessionId ?? agentId;
    const controller = new AbortController();
    activeChats.set(cancelKey, controller);
    agentStreamSessionMap.set(input.agentId, cancelKey); // 授权/提问请求按当前流打会话标�?
    lastChatCancelKey = cancelKey;
    let history = input.history ? (input.history as any) : [];
    // 会话上下文注入：无显�?history 时按 session_id 加载
    if (history.length === 0) {
      history = await loadSessionHistory(input.sessionId);
    }
    /* A-1131：会�?meta 必须**�?*读到 —�??`req` �?要它给出的会话级模型选择�?
       （�?前它�?`req` 之后才加载，�?�?�?��话用�?��模型"根本来不及进请求。） */
    const brainMeta = input.sessionId && typeof input.sessionId === "string" ? await getSession(input.sessionId).catch(() => null) : null;
    const isBrainstorm = brainMeta?.type === "brainstorm" && memberIdsOf(brainMeta.members).length > 0;
    /* 「本会话该用�?��模型」的**�?��判据**（纯函数，与渲染层显示同源）�?
       会话显式选过就用它，否则跟随 Agent 的默认�?��??*/
    const runModelChoice = effectiveModelChoice(brainMeta?.modelChoice, loadingAgent?.model_choice);
    const req: ChatRequest = {
      message: input.message,
      history,
      retry: false,
      maxTokens: input.maxTokens,
      sessionId: input.sessionId,
      networkEnabled: input.networkEnabled,
      // A-966 �??：�?�?images �??�传—�?�粘�?拖拽图片�?GUI �?��见�?�但引擎从未收到（模型回"没看到图�?�?
      images: input.images,
      resumeHint: (input as { resumeHint?: string }).resumeHint,
      /* A-1084：本条�?求的模型窗口上限 —�??引擎侧保险门（`planEngineSend`）靠它判�?发不�?�?
         ⚠️ 必须�?*�??要用的模�?*（`agent.model_choice`），不能�?`session.model` —�??
            后�?�是上一�?done 时才报上来的：�?�?��空，且用户中途换模型后会**滞后�?�?*�?
            那样保险门就会拿旧窗口判新�?求（要么�?��，�?么拦不住）�??*/
      windowCap: await resolveSessionWindowCap(agentId, runModelChoice).catch(() => undefined),
      /* A-1131：会话级模型选择（引擎侧 `runAgentFor` 会用它�?�?Agent 的默认�?�） */
      modelChoice: brainMeta?.modelChoice,
    };
    const session = createStreamSession();
    // A-980-R24：chunk 下发合批（�? createChunkSender 注释�?
    const chunkSender = createChunkSender();
    // 干净正文：优先取 chatService done 事件里全�?extractThinkingFromReply 清洗后的 reply
    // （流式�??chunk 剥�?对细粒度 chunk �?��漏掉裸�?��?�，�?���?fullReply 不代表最终�?文）
    let cleanReply: string | undefined;
    /* A-1066：本�?���?*出错收场** —�??供流结束时的待办清除判据如实报因（done / error）�??
       用独立标志�?�不�?看有没有 errorMsg"：错�?���?��多条�?��上写法不同，容易漏判�?*/
    let hadError = false;
    // A-939 上下文分桶（�?done 事件透传给渲染层分桶托盘�?
    let ctxBuckets: CtxBuckets | undefined;
    // D: �??请求链路 trace 记录（事件点 �?spans；收尾广�?TraceViewer�?
    const recorder = new TraceRecorder(cancelKey);
    // E: 工具�?Plan 拦截（plan_create/plan_update/todo_write �?planStore �?广播�?
    const planSessionId = cancelKey;
    // A-943：群聊头脑�?暴分�?��会话 type=brainstorm 且已选成员）—�?�发�?? �?全员并�?发言 �?组长收束
    // （A-1131：`brainMeta` / `isBrainstorm` 的加载已上移�?`req` 之前，�?处不再重复�?盘）
    void (async () => {
      try {
        const evSource = isBrainstorm
          ? streamGroupTalkFlow({
              engine: engine!, // �?handler 顶部�?await ensureServices()，引擎必就绪
              // 群聊 = 会话归属 Agent + 全部成员（无组长 Agent，组长即用户）；@ �?���?flow 内解�?
              // A-954：成员入群时指定了模�?�?覆盖 model_choice；池 cap 按所选模�?context_window（agent.max_context 不优先）
              members: await (async () => {
                const modelMap = memberModelsOf(brainMeta!.members);
                const modelEntries: Array<[string, string]> = [...Object.entries(modelMap)];
                if (typeof brainMeta!.leaderModel === "string" && brainMeta!.leaderModel) { modelEntries.push([loadingAgent!.id, brainMeta!.leaderModel]); }
                const modelCaps = await Promise.all(modelEntries.map(async ([id, model]) => [id, await resolveSessionWindowCap("", model)] as const));
                const capBy = new Map(modelCaps);
                // A-1012：参与名单（**组长 + 成员、按 id 去重、取�?GROUP_MAX_PARTICIPANTS �?*）由共享�?���?
                // �?��决定 —�??建群弹窗用同�?�?��数拦人，两头不可能再漂移�?
                // ⚠️ 此前这里�?���?`.slice(0, 5)` 字面量，而界面�?不知�?�?用户能邀�?7 �?Agent�?
                //    �?6 位起卡片照常显示、照样可点�?��?��?�·X」，引擎却从不�?（静默丢�?= 假旋�?���?
                // �?��仍保留作兜底：上限引入之前建的旧会话、以及脏数据仍可能超员�??
                const participantIds = groupParticipantIds(loadingAgent?.id, memberIdsOf(brainMeta!.members));
                // 组长**无条件在�?*（他�?��话归�?Agent，原来就不经 findAgent 过滤，这里保持原�?��）；
                // 其余按名单顺序解析，解析不到的（Agent 已�?删除）直接跳过�??*不拉后续成员补位** —�??
                // 否则"界面按名单算出的参会�?�?引擎实际参会�?会错位，界面就会标错人�??
                const otherMembers = await Promise.all(
                  participantIds
                    .filter((id) => id !== loadingAgent?.id)
                    .map((id) => agentRegistry!.findAgent(id).catch(() => null)),
                );
                const roster: AgentState[] = [
                  ...(loadingAgent ? [loadingAgent] : []),
                  ...otherMembers.filter((a): a is AgentState => a !== null),
                ];
                const effortMap = memberEffortsOf(brainMeta!.members);
                return roster.map((a) => {
                  const model = a.id === loadingAgent!.id ? brainMeta!.leaderModel : modelMap[a.id];
                  // A-1011：必须�?�是显式�?reasoning_effort（缺�?"high"），否则会回落�? Agent 的全�?设置（�?为回归）
                  const effort = a.id === loadingAgent!.id ? brainMeta!.leaderEffort : effortMap[a.id];
                  const cap = capBy.get(a.id);
                  return { ...a, ...(model ? { model_choice: model } : {}), ...(cap && cap > 0 ? { max_context: cap } : {}), reasoning_effort: effort || "high" };
                });
              })(),
              topic: req.message,
              sessionId: input.sessionId,
              networkEnabled: input.networkEnabled,
            })
          : chatService!.stream(agentId, req, input.resumeSeq ?? 0, controller.signal);
        for await (const ev of evSource) {
          recorder.push(ev);
          // A-984：给看门狗留现场 —�??卡顿时能直接看出"当时在跑�?��工具"
          if (ev.type === "tool") {
            const t = (ev.data ?? {}) as Record<string, unknown>;
            markMainActivity(`tool ${String(t.name ?? "?")}`);
          }
          if (planSessionId) { interceptPlanTool(ev, planSessionId); }
          if (ev.type === "done") {
            const d = (ev.data ?? {}) as Record<string, unknown>;
            if (typeof d.reply === "string" && d.reply) { cleanReply = d.reply; }
            // A-939 上下文分桶�?�传（渲染层分桶托盘显示；引�?done 事件携带各来�?token 估算�?
            if (d && typeof d === "object" && "ctxBuckets" in d) { ctxBuckets = d.ctxBuckets as CtxBuckets; }
          }
          const chunk = toStreamChunk(ev, cancelKey);
          session.pushChunk(chunk);
          // A-980-R24：原�?chunk 已�?�条�?session 缓冲（重�?轨迹完整），IPC 侧走合批
          chunkSender.push(chunk);
        }
        if (input.sessionId) {
          await touchSessionWithMessage(input.sessionId, input.message).catch(() => undefined);
        }
        try {
          // A-980-R24�?*done 之前必须 flush**，否则尾部�?文会晚于 done 到达（末尾丢字）
          chunkSender.flush();
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("slime:chat:done", {
              reply: cleanReply ?? session.fullReply, model: session.model,
              elapsedMs: session.elapsedMs, timings: session.timings,
              interrupted: controller.signal.aborted,
              sessionId: cancelKey,
              // A-933：权威窗口上限（Agent.max_context 或本次模�?context_window）�?��?�右栏进度条/圆环/
              // 压缩阈�?�三者同源�?�⚠�?此前**�?*�?retry �?��下发，�?常发送的 done 里没�?�?
              // 渲染层只能�??回本地�?设（曾把 512K 模型显示�?128K），且压缩阈值判定跟�?错�??
              windowCap: await resolveSessionWindowCap(agentId, session.model).catch(() => undefined),
              ctxBuckets,
            });
            // A-918：流终�?�广�??��?�渲染层�??�?per-session �?�� hasActive 校准�?false�?
            // 根治「切走再切回仍显示生成中/仍重连�?�的假活跃状�?
            mainWindow.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
            // A-980-R26：任务完�?�?系统通知�?*用户主动�?��（aborted）不通知**—�??
            // 那是用户�?��按的停�?，再弹一�?完成"�?��打扰�?
            if (!controller.signal.aborted) {
              notifyUser({
                kind: "done",
                title: `${agentNameForNotify(agentId)} 已完成`,
                body: (cleanReply ?? session.fullReply ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || "任务已结束",
              });
            }
          }
        } catch { /* ignore */ }
        // D：收�?trace 并广�?��成功�?
        const traced = recorder.finish(true);
        traceStoreSet(cancelKey, traced);
        try {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("slime:trace:update", { sessionId: cancelKey, trace: traced });
          }
        } catch { /* ignore */ }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        hadError = true; // A-1066：本�?��出错收场（判�?��流结束�?如实报因�?
        console.error("[gui:main] chat stream error:", msg);
        // A-980-R24：错�?��把已生成的待发文�?��出去（用户应看到�?��前已产出的内容）
        chunkSender.flush();
        // A-918++：中�?��错�?落盘（data/logs/chat-errors.log），便于事后归因"刚�?�?始就�?��"
        try {
          const logDir = resolveExtra("../data/logs");
          mkdirSync(logDir, { recursive: true });
          writeFileSync(join(logDir, "chat-errors.log"), `${new Date().toISOString()}\t${cancelKey}\t${msg}\n`, { flag: "a" });
        } catch { /* 落盘失败不影响主流程 */ }
        mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: cancelKey });
        mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
        // A-980-R26：出�?�?系统通知（用户常在生成中切走做别的事，回来才发现整轮标红�?
        notifyUser({
          kind: "error",
          title: `${agentNameForNotify(input.agentId)} 出错`,
          body: msg.replace(/\s+/g, " ").trim().slice(0, 160) || "生成过程中发生错误",
        });
        // D：失败轨迹也收敛广播（TraceViewer 见失败归�?eval=false + 错�?摘�?�?
        const failedTrace = recorder.finish(false, msg);
        traceStoreSet(cancelKey, failedTrace);
        mainWindow?.webContents.send("slime:trace:update", { sessionId: cancelKey, trace: failedTrace });
      } finally {
        // A-980-R24：合批器收尾（flush 幂等；�?后新帧一律丢弃，避免流结束后仍向渲染层发僵尸帧）
        chunkSender.dispose();
        /* A-1060�?*流一结束就清掉未消费的引�?*（成�?/ 出错 / 用户取消三条�?��都走这里）�??
           为什么必须清：没�?��费的残留若留到下�?次运行，会在那一�?���??边界�?���?
           �?同一条引导发两遍。渲染层那份待发卡片不受影响（仍在队列里），
           它会�?onDone 之后按普通排队发�?—�??�?以既不丢也不重�?�?*/
        clearSteers(cancelKey);
        /* A-1066�?*�?��跑完 �?清空该会话待�?*（用户明�??求：「当会话结束，待办任务直接自动清除�?�）�?
           放在 finally 的收尾�? = 正常完成 / 出错 / 用户�?��**三条�?��共用同一�?���?*�?
           口径统一（判�?? `shouldClearTodosOnTurnEnd`，含"已�?新一�?��管就不清"的竞态防护）�?

           ⚠️ `superseded` 必须�?`activeChats.delete(cancelKey)` **之前**算：
              新一�?��已把这条 key 下的 controller 顶掉，旧流的这份清单就不属于�?���?—�??
              此时清空会把用户刚�?划好的新�?�?��单抹掉（"刚�?划好就没�?）�??*/
        const superseded = activeChats.get(cancelKey) !== controller;
        activeChats.delete(cancelKey);
        // 会话标�?竞�?�防护（A-151）：仅当映射�?��值仍�?��流注册的 cancelKey 时才删除—�??
        // �?Agent 多会话并发时，本�?finally �?��晚于「新会话流已 set」执行，
        // 无条�?delete 会把新流的会话标签一并删�?�?新流 perm/ask 请求�?sessionId
        // �?渲染层无条件弹�?�择题替换输入�?（切会话后输入�?卡�?的根因链）�??
        if (agentStreamSessionMap.get(input.agentId) === cancelKey) {
          agentStreamSessionMap.delete(input.agentId);
        }
        // A-1017：面板显隐由管理器状态广�?���?��这里�?*兜底**—�?�取消发生在 ensure 之前�?
        // 不会产生任何状�?�迁移，广播也就不来，必须在流结束时无条件收口（渲染层置 false �?��等的）�??
        mainWindow?.webContents.send("slime:model:loading", { loading: false });
        /* A-1066：本�?��结束 �?清空该会话待办（判据�?��出�? `shouldClearTodosOnTurnEnd`）�??
           �?�� `input.sessionId`（待办文件名�?sessionId 命名），不是 cancelKey�?*/
        if (shouldClearTodosOnTurnEnd({
          reason: controller.signal.aborted ? "cancelled" : hadError ? "error" : "done",
          stillActive: superseded,
        })) {
          clearTodosOnTurnEnd(input.sessionId);
        }
        /* A-1069�?226）：回合结束（含�?��户停下）�?刷新「后台进程�?�面板�??
           这�?�?��户�?的�?�Agent 停下时�?�：此刻他�?看的�?还有�?��它起的东西活�?"�?
           放在 finally 里�?�不�?done 分支：�?�?出错同样要刷新（那些恰恰�?��常�?的场�?���?*/
        broadcastAgentProcs();
      }
    })();
    return { ok: true };
    } catch (e: unknown) {
      // �?���?入参阶�?失败（服务未就绪、Agent 解析失败等）：同样走 error 通道�?
      // 渲染层自动重连机制才能接管（否则 invoke 直接 reject，未处理回调会把重连链路切断�?
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] chat stream setup error:", msg);
      mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: input.sessionId });
      mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: input.sessionId });
      // A-980-R26：发送阶段就失败（服务未就绪 / Agent 解析失败）同样�?�知
      notifyUser({
        kind: "error",
        title: "请求未能开始",
        body: msg.replace(/\s+/g, " ").trim().slice(0, 160) || "发送阶段发生错误",
      });
      return { ok: false, error: msg };
    }
  });

  /** 主动�?��进�?�?��流式对话 */
  handleTrusted<{ key?: string }>("slime:chat:cancel", async (_event, payload) => {
    const active = activeChats.get(payload.key ?? "");
    if (!active) {
      return { ok: false, error: "无进行中的�?话可取消", active: activeChats.size };
    }
    active.abort();
    // A-985：用户主动中�?= 没人在干活了 �?把�?会话停在"进�?�?的项降级为待办�??
    // 否则�?��后那�?项会�?直转圈高�?��看起来像"任务还在�?（与强杀重启后的僵尸态同�?�?��）�??
    try {
      const key = payload.key ?? "";
      if (key && demoteStaleInProgress(key) > 0) { broadcastTodos(key); }
    } catch { /* 收敛失败不影响中�?���?*/ }
    return { ok: true, active: activeChats.size };
  });

  /**
   * A-1060：投入一条中途�?�引导�?�（steer）�?��??**不取消当前流**�?
   *
   * 这是「直接插入�?�的�?��种�?义（对齐 Cursor 2026-08-19 �?steering 改进�?Claude Code 的排队消�?���?
   * 消息不掐�??在跑的活，�?�是排队等到**下一�?��具调用之后的�??边界**�?��入本�?��下文
   * （消费点�?`core-ts/src/tool_loop.ts` �?`injectSteers`）�??
   *
   * 调用方（渲染层）仍保留那张待发卡片：
   * - 若本�?��引�?�?���?�?工具�?���?`steer` 事件 �?界面撤掉卡片（不重�?发）�?
   * - 若本�?��根没有工具调�?���?���?��答，永远到不了轮次边界）�?流结束时主进程清掉缓冲，
   *   卡片留在队列里，由界面按**�??�排�?*在下�?�?��出�??*�?���?��不重复�??*
   */
  handleTrusted<{ sessionId?: string; id?: string; text?: string }>("slime:chat:steer", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const pending = pushSteer(sid, { id: String(payload?.id ?? ""), text: String(payload?.text ?? "") });
    if (pending === 0) {
      // 空文�?/ 无会�?�?如实拒绝，别让界�?���?已经插进去了"
      return { ok: false, error: "引导内容为空或会话无效" };
    }
    return { ok: true, pending };
  });

  /**
   * A-1151�?*撤销�?条已投入的引�?* —�??用户在待发卡片上点�?�✕」时调�??
   *
   * 用户实测 bug：�?�两�?��导都�?��点了**取消�?*后的情况，结果后面都传上去了」�??
   * 缺口：`slime:chat:steer` 把这条推进了 `steerBus`，�?�渲染层�?`✕` �?��了自己那份卡�?
   * �?缓冲里的残留会在�?��的轮次边界�?�或下一次运行时�?���?�?**取消了却照样发出**�?
   * `clearSteers` �?��流结束时全清，�?盖不�?流还在跑时用户取�?�?
   *
   * ⚠️ 返回 `dropped: false` 有两种含义，界面不必区分但日志�?能看出：
   * �?缓冲里本来就没有（从�?`steer` 过，�?��待发卡片）�?��??正常�?
   * �?已�?工具�?��消费掉（真进上下文了）�?��??那时撤销已无意义�?
   */
  handleTrusted<{ sessionId?: string; id?: string }>("slime:chat:steer:dismiss", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const dropped = dropSteer(sid, String(payload?.id ?? ""));
    return { ok: true, dropped };
  });

  /** A-973：查询指定会话是否仍有进行中的流（渲染层恢�?会话时判�?进�?�?已结�?的唯�?真相源）�?
   *  activeChats �?key 与流归属同口径（sessionId ?? agentId）：先按传入 key 精确查，�?���?��
   *  遍历值匹�?agentStreamSessionMap 兜底—�?�主进程 activeChats 才有资格回答"这条流�?没�?"�?
   *  杜绝渲染层靠 6s 超时猜测导致"恢�?�?冻结/�?��整条重发�?*/
  handleTrusted<{ key?: string }>("slime:chat:isActive", async (_event, payload): Promise<{ active: boolean }> => {
    const key = payload.key ?? "";
    // 流归属口径：activeChats �?cancelKey = sessionId ?? agentId。渲染层恢�?时传�?key �?���?
    // 当前 sessionId �?agentId，故遍历比�?（精�?��配或�?agentStreamSessionMap 反查）�??
    if (activeChats.has(key)) { return { active: true }; }
    for (const mapKey of activeChats.keys()) {
      if (mapKey === key) { return { active: true }; }
    }
    for (const [, boundKey] of agentStreamSessionMap) {
      if (boundKey === key) { return { active: true }; }
    }
    return { active: false };
  });

  /** A-1082：压缩熔�?��（I7 / 设�?定�? §8.6）�?�进程级单例—�?�连�?���?�? 次即停，
   *  不再无脑调用摘�?模型（否则�?�压缩→失败→再压缩」�?�?��）�??
   *  计数维度�???*同一段历�?*�?��已�?处理过�?�：历史指纹�?变（用户发了新消�?��就重新给满�?机会�?*/
  let compressBreaker: BreakerState = INITIAL_BREAKER;

  /** 历史指纹（熔�??数维度）：条�?+ 总字符数。变化即代表「换了一段历史�?��??*/
  function historyFingerprint(messages: LoopMessage[]): string {
    let chars = 0;
    for (const m of messages) { chars += typeof m.content === "string" ? m.content.length : 0; }
    return `${messages.length}:${chars}`;
  }

  /** A-969 上下文自动压缩：把指定会话历史压缩为摘�?并写回会�?meta（后�?loadSessionHistory �?��注入摘�?�?+
   *  �?�?K �?��不再全量重发）�??
   *
   *  �?�? A-1082 重写要点（�?应�?�压缩并非真压缩」的四条根因）─�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
   *
   *  �?`force`（反应式触发）：上游已报「上下文超限」时**越过阈�?�判�?*直接压�??
   *     旧实现只有渲染层 `force` 越过**渲染�?*那条 `used < cap*ratio`，主进程这里仍会
   *     用同�?�?`used` 再判�?�?`needsCompress` �?判假 �?`skipped` �?**压缩�?次也没发�?*�?
   *     重试发的还是同一�?��限�?�?�?用户看到「压缩了还是不�?」�?�这才是 P0「少的那�?�??�没接上的地方�??
   *  �?**降级�?��必须真的�?*：摘要不�?��时写 `summaryCount`（只裁不摘�?），不再出现
   *     「界面报已压缩�?��?求一字未减�?�的空操作�??
   *  �?**实测回填**：返�?`tokensAfter`（重新加载后**实测估算**）与 `stillOverflow`�?
   *     彻底取代渲染层那�?`cap × 0.5` 构�?��?��??
   *  �?**理解总结�?*（用户点名）：摘要成功后再跑**�?�?*�??回�?，产出续接�?知一并注入�??*/
  handleTrusted<{ sessionId?: string; ratio?: number; used?: number; force?: boolean }>("slime:chat:compress", async (_event, p): Promise<CompressResult> => {
    try {
      const sessionId = (p?.sessionId ?? "").trim();
      if (!sessionId) { return { ok: false, error: "缺少会话 ID" }; }
      const meta = await getSession(sessionId);
      if (!meta) { return { ok: false, error: "会话不存在" }; }
      const force = p?.force === true;
      const agent = await agentRegistry!.findAgent(meta.agentId).catch(() => null);
      /* A-1131：压缩判定必须用**�?��话实际�?用的模型**（会话�?盖优先）—�??
         否则用户在本会话选了小窗口模型，压缩却按 Agent 默�?的大窗口�?�?贴着旧阈值照发�?��?上游拒�??*/
      const capRaw = await resolveSessionWindowCap(meta.agentId, effectiveModelChoice(meta.modelChoice, agent?.model_choice)).catch(() => undefined);
      const cap = capRaw ?? (agent?.max_context ?? 0);
      /* ══ A-1106：压缩必须基�?*原�?全量历史**，不能基于折叠�?�?══
         旧实现只�?`loadSessionHistory(sessionId, { full: true })`，�?�它在�?�已压缩过�?�时返回的是
         **折叠视图**（摘要头 + �?�?6 �?�?14 行）。由此产生两�?P0�?
           �?**压缩�?辈子�?��发生�?�?*：`noRoomToCut` 拿折叠后的长度判「还有没有可裁素材�?�，
              而它�?�?4 �?`DEFAULT_TAIL_KEEP*2+2` �?恒真 �?`canShrink` 恒假 �?此后再不压缩�?
              要么贴着阈�?�照发�?��?么直�?`cannot-fit` 拒发（用户只能换模型或开新会话）�?
           �?**静默�?��下文记忆**：摘要素材同样来�?��叠�?�?�?两�?压缩之间�?��的那批轮�?
              （既不在上�?摘�?里�?�又�?��出保留尾巴）**从未进入任何摘�?**，永久消失�??
         现在：`historyAll` = 原�?全量（判�?+ 摘�?素材 + 指纹）；`historyView` = 折叠视图（真实发送体�?���?*/
      const { raw: historyAll, meta: histMeta } = await loadRawHistoryWithMeta(sessionId, { full: true });
      const historyView = foldSessionHistory(historyAll, histMeta);
      /* ⚠️ 下面两条 `skipped` �?`force`（上游已报超限）下必�?*如实回带 `stillOverflow: true`**�?
         它们意味�?「我�?��点也没压下去」⇒ 反应式调用方�??**放弃那�?注定失败的重复�?�?*�?
         而不�?��等一�?��报错（这正是「连接半天还�?��连�?�的残留形�?�）�?
         `stale` 那条**�?*回带 —�??期间已有�?��压缩落地，重试是有意义的�?*/
      if (historyAll.length < 6) {
        return { ok: true, skipped: true, reason: "历史过短（不�?6 条），压缩无意义", used: 0, cap, ...(force ? { stillOverflow: true } : {}) };
      }
      // A-974-R3：占用口径取「历史轮次估算�?�与「渲染层实测输入侧占用�?�的**较大�?*�?
      // 实测�?= 上游 prompt_tokens + cache_read（含系统提示/记忆/�?�?工具定义/工作区注入）�?
      // 比只看可见轮次的估算更贴近真实窗口压力；此前�?��估算 �?实测已超阈�?�却�?skipped�?
      // 压缩永不执�?（用户实�?逼近�?��值却�?��动作/压缩失效"的根因）�?
      // ⚠️ A-1106：估算用**折叠视图**（那才是真实发出去的历史），否则�?`hint` / `tokensAfter` 口径不一致�??
      const histUsed = estimateHistoryTokens(historyView);
      const hint = typeof p?.used === "number" && Number.isFinite(p.used) && p.used > 0 ? Math.round(p.used) : 0;
      const used = Math.max(histUsed, hint);
      const ratio = typeof p?.ratio === "number" && p.ratio > 0 ? p.ratio : DEFAULT_COMPRESS_RATIO;
      // A-974-R3 护栏：由「实测占�?��hint）抬高�?�触发的场景，必须确�?*多余�??�??**才动手�?��??
      // 若固定开�?（系统提�?记忆/�?�?工具定义/工作区注入）�?��就�?�近上限，�?历史降不下来 �?
      // 每轮都会空跑�?次摘要模型调用并刷一条�?�已压缩上下文�?��?��?处显式拦掉这种空�???
      // ⚠️ A-1106：判�?��须用**原�?全量**长度 —�??折叠视图�?≈K*2+2，用它判等于恒真（�?上，P0①）�?
      // ⚠️ `force`（上游已报超限）�?*必须越过**这条：否则就�??�上游�?�?�� �?我们�?么都不做 �?原样重发」�??
      const noRoomToCut = historyAll.length <= DEFAULT_TAIL_KEEP * 2 + 2;
      /* ══ A-1083：判�?��口到**�?��出�?** `planSend`（发送前预算�?�� ══
         旧实现把三档散成两条 `!force &&` 判断（阈值档 + 空转护栏），于是�?
           �?「发出去才知道超」�?��??输入�?��已超窗口时也照发，然后靠 300s 超时 + N 次重连来"发现"
              （用户原话：「连接半天还�?��连�?�）�?
           �?`force` 必须记得�?*每一�?*都越�?—�??A-1082 就是漏了这条，�?反应式压缩一次都没发生�??
         �?现在�?���?�?��数�?了算：上游报超限 / 预算不足 / 用户阈�??三档触发 �?compact�?
             压无�?��**且真的�?不下**（`used > cap`）→ cannot-fit�?*拒发**）；
             压无�?��但�?算仍够（�?��用户阈�?�调低了）→ 照常发（不�?�?��）�??
         `reason` �?planSend 给出，两�?skipped �?*如实显示**（�?�?A-1082 §3.2）�??*/
      const plan = planSend({
        estimatedInput: used,
        cap,
        afterOverflow: force,
        // ⚠️ A-1106：�? 4 �?��数是**�?��**，不�?���?���?—�??曾直接传 `historyAll.length`
        //（消�?�� �?�?�� × 2 以上）⇒ 6 �?���?小门槛实际在 2-3 �?��放�?，压缩触发早�?倍�??
        // 「轮」的�?��口径 = `context_loop.countTurns`（与 planCut �?turn 边界同源）�??
        ratioTriggered: needsCompress(used, cap, ratio, countTurns(historyAll)),
        canShrink: !noRoomToCut,
      });
      if (plan.action === "cannot-fit") {
        // A-1086：把**�?��的出�?*算出�?—�??用户此刻�?么都发不出去，需要的�?切哪�?���?�?
        // 而不�?请换窗口更大的模�?这句原则（�?�?suggestWiderChatModel 的注释）�?
        const rescue = await suggestWiderChatModel(used, cap);
        console.warn(`[gui:main] 上下文估算门拦截（拒发）：${plan.reason}`);
        return {
          ok: true, skipped: true, used, cap, stillOverflow: true, cannotFit: true,
          rescueHint: formatRescueHint(rescue),
          // A-1090：有候�?�时**额�?**回带结构化�?录（渲染层据此渲�?�?�?���?按钮）�??
          // `undefined`/`null` 都不回带 —�??没有�?��的东西，回带空�?象只会�?渲染层�?�?堆判空�??
          ...(rescue ? { rescueModel: rescue } : {}),
          reason: formatCannotFit(plan, rescue),
        };
      }
      if (plan.action === "ok") {
        return { ok: true, skipped: true, used, cap, reason: plan.reason };
      }
      // 熔断：同�?段历史连�?���?�? �?�?不再调用摘�?模型（�?实告�?+ 给可操作项）
      const key = historyFingerprint(historyAll);
      if (compressBreaker.open && compressBreaker.lastKey === key) {
        return {
          ok: true, skipped: true, used, cap, breakerOpen: true,
          ...(force ? { stillOverflow: true } : {}),
          reason: `压缩已熔�?��同一段历史连�?${compressBreaker.failures} 次压缩失败）：本段历史无法靠压缩救回，�?换窗口更大的模型，或�?�?�?��会话`,
        };
      }
      const startGen = meta.summaryGeneration ?? 0;
      const keep = DEFAULT_TAIL_KEEP;
      // 摘�?�??算按**该模型窗�?*解析（旧实现�?��死的 9000，CJK 下只�?~9k 汉字 �?真实会话必然放弃摘�?）�??
      // 窗口�?��（cap=0）时取保守�?�：`buildSummaryInput` �?��**摘录**、永不放弃，�?以保守�?�不会�?摘�?缺失�?
      const budget = cap > 0 ? Math.max(2048, Math.min(SUMMARIZE_INPUT_CAP, Math.floor(cap * 0.5))) : 8000;
      let summaryText: string | null = null;
      let comprehend: string | null = null;
      let summaryElided = 0;
      let summaryTruncated = false;
      if (agent && engine) {
        const s = await engine.summarizeContext(agent, historyAll, { maxInputTokens: budget, priorSummary: meta.contextSummary });
        if (s) {
          summaryText = s.summary;
          summaryElided = s.elided;
          summaryTruncated = s.truncated;
          // A-1106：摘要素材不完整必须**出声** —�??此前 elided 与截�?��静默通过�?
          // 两条�?��的�?�丢记忆」路径：`elided>0` = 受输入�?算所限�?丢弃的中段消�?
          // �?*从未进入摘�?**，�?�它�?��时也不在保留尾巴�?�?真的没了）；
          // `truncated` = 触达输出上限�?��斩�?�二者都意味�?"压缩�?Agent 看到的不�?��部历�?�?
          // 摘�?仍然写入（半�?��强于全无），�?*必须留痕**，不许安静地�???
          if (s.elided > 0 || s.truncated) {
            console.warn(
              `[gui:main] 摘�?不完整（丢�?忆�?险）：elided=${s.elided} 条中段消�?��进摘要�?�` +
              `truncated=${s.truncated}（输出�?腰斩）�?�摘要仍会写入，但早期细节可能缺失�?�`,
            );
          }
          // ⑤�?�理解�?�结」环：压缩后**恰好�?�?*�??回�?（有界）。失败重�?1 次，再失�?�?非阻塞降级�??
          let c = await engine.comprehendContext(agent, s.summary);
          if (!c) { c = await engine.comprehendContext(agent, s.summary); }
          comprehend = c?.comprehend ?? null;
        }
      }
      // §8.4 skip-stale：压缩是异�?的，期间�?��已有�?��压缩落地 �?过期结果直接丢弃，不覆盖更新的摘�?
      const fresh = await getSession(sessionId);
      if (fresh && !acceptSummary(startGen, fresh.summaryGeneration ?? 0)) {
        return { ok: true, skipped: true, used, cap, stale: true, reason: "本次压缩结果已过期（期间已有更新的压缩落地），已丢弃以避免覆盖" };
      }
      await setSessionSummary(sessionId, summaryText, keep, { comprehend });
      // �?实测回填：重新加载并估算**真实**压缩后体�?��不�?再出�?cap×0.5 这类构�?��?�）
      // A-1085：与压缩�?*同口�?*（都�?full）�?��??否则 tokensAfter �?50 条以�?的估算�??
      // �?used �?全量"的估算，`isRealShrink` 的降幅判定会失真（假�?降幅不足"）�??
      const after = await loadSessionHistory(sessionId, { full: true });
      // �?校验�?��设�?定�?不变�?I1/I3）：压缩产物必须仍是**合法�?��**的序列�??
      // �?��数构造已保证（turn 对齐切口 + 摘�?�?�?��），此�?�?*防线** —�??
      // �?旦哪天构造�?�辑回归（�?切口改回按条数硬切），这里会立刻留下�?��的证�???
      const validation = validateHistory(after);
      if (!validation.ok) {
        console.error("[gui:main] 压缩产物�?���?��变量校验（I1/I3�?", validation.violations);
      }
      // 固定�?�? = 实测输入侧占�?�?历史估算（系统提�?记忆/�?�?工具定义/工作区注入）�?
      // tokensAfter �?`used` **同口�?*（历�?+ 固定�?�?），渲染层可直接用它替换占用镜像�?
      const fixedOverhead = Math.max(0, hint - histUsed);
      const tokensAfter = estimateHistoryTokens(after) + fixedOverhead;
      // A-1106：熔�?���?��须含 `realShrink` —�??否则「压�?��了�?�体�?��乎没降�?�的**假压�?*
      // 每一次都�??�?*成功**，熔�?��永不�?�?�?同一段历史反复触发�?�反复白花一次摘�?
      // 加一次理解调�?��而用户看到的永远�??�已压缩 N �??�却怎么都发不出去�??
      // 判据：`!realShrink` 与�?�摘要失败�?��?�产物非法�?�同�?这�?压缩没解决问�?，一起�?入失败�??
      const realShrink = isRealShrink(used, tokensAfter);
      compressBreaker = nextBreakerState(compressBreaker, {
        ok: summaryText !== null && validation.ok && realShrink,
        historyKey: key,
      });
      const stillOverflow = cap > 0 && tokensAfter >= cap;
      /* A-1086：压完仍超限 �?换更大窗口的模型�?*�?��**出路，顺手把"换哪�?算出来�??
         ⚠️ �?��**真超�?*时才查（罕�?�?��）；正常压缩不�?为一次�?��?�扫描买单�??
         ⚠️ `stillOverflow` 为真�?*无条�?*回带 rescueHint（包�?没有候�??那条）�?��??
            沉默会�?用户以为工具没查过，于是继续在同�?�??�?里点重试�?*/
      const rescue = stillOverflow ? await suggestWiderChatModel(tokensAfter, cap) : null;
      const dropped = Math.max(0, historyAll.length - after.length);
      return {
        ok: true,
        summary: summaryText ?? undefined,
        truncated: summaryText === null,
        comprehend: comprehend ?? undefined,
        dropped,
        used,
        cap,
        tokensAfter,
        stillOverflow,
        ...(stillOverflow ? { rescueHint: formatRescueHint(rescue) } : {}),
        // A-1090：同�?—�??有�?��?�才回带结构化�?录（渲染层据此给「一�?���??�按�?��
        ...(stillOverflow && rescue ? { rescueModel: rescue } : {}),
        realShrink,
        elided: summaryElided,
        summaryTruncated,
      };
    } catch (e) {
      console.error("[gui:main] chat:compress crashed:", e);
      compressBreaker = nextBreakerState(compressBreaker, { ok: false });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** P0: 新�?�?�?清空历史文件并重�?��地状�?*/
  handleTrusted<{ agentId: string }>("slime:chat:new", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId || resolveAgentId(undefined);
    const { clearHistoryForAgentExport } = await import("../../../core-ts/src/services/history.js");
    await clearHistoryForAgentExport(agentId);
    console.info(`[gui:main] 新�?�? agent=${agentId}`);
    return { ok: true };
  });

  /** A-161：回滚持久化 —�??�?��该会话历史到�?��用户消息之前（回滚后重启不再复现旧消�?�� */
  handleTrusted<{ agentId: string; sessionId?: string; userMsg: string }>("slime:history:truncateFrom", async (_event, payload) => {
    if (!payload || typeof payload.userMsg !== "string" || !payload.agentId) {
      return { ok: false, error: "参数不完整" };
    }
    const { truncateHistoryFromExport } = await import("../../../core-ts/src/services/history.js");
    const removed = await truncateHistoryFromExport(payload.agentId, payload.sessionId, payload.userMsg);
    console.info(`[gui:main] 回滚截断历史：agent=${payload.agentId} 会话=${payload.sessionId ?? "-"} 删除 ${removed} 条`);
    return { ok: true, removed };
  });

  /**
   * A-1122（③）：**文件回滚** —�??回滚�?条消�?��把�?盘上的改动也还原�?
   *
   * 为什么必须有这条通路：`rollbackTo` 此前�?��前�? `messages` + �?�� `history.jsonl`�?
   * **磁盘上的文件�?�?��没动** �?用户以为回滚干净了，实际 Agent 改过的文件还�?��过的�?
   *
   * `mode` 两个值走**同一份�?�择实现**（`selectUndo`）：
   *  · `plan`  �?�??，供渲染层先给�?�将还原 N �?��件�?�确认；
   *  · `apply` �?真�?还原。两处各写一�?�?��算数"必然分�?（界面�? 3 �??�实际动 2 �?���?
   *
   * ⚠️ 调用方（渲染�?`rollbackTo`）必�?*�?undo �?truncateFrom**�?
   * 切分线靠 `history.jsonl` 里那条用户消�?��位，先截�?���?�?`findRollbackCut` 找不�?
   * �?文件还原直接失效（�?�且�?��默失效）�?
   */
  handleTrusted<{ agentId: string; sessionId?: string; userMsg: string; mode?: "plan" | "apply" }>(
    "slime:file:undo", async (_event, payload) => {
      if (!payload || typeof payload.userMsg !== "string" || !payload.agentId) {
        return { ok: false, error: "参数不完整" };
      }
      const svc = await import("../../../core-ts/src/services/file_undo.js");
      if (payload.mode === "plan") {
        const plan = await svc.planFileUndo(payload.agentId, payload.sessionId, payload.userMsg);
        if (plan.count || plan.dirs || plan.blocked.length) {
          console.info(`[gui:main] 回滚预演：还�?${plan.count} �?���?/ 重建 ${plan.dirs} �?���?/ ${plan.blocked.length} 处不�?��原`);
        }
        return plan;
      }
      const res = await svc.applyFileUndo(payload.agentId, payload.sessionId, payload.userMsg);
      console.info(`[gui:main] 回滚文件：还�?${res.restored} / 删除 ${res.deleted} / 重建�?�� ${res.dirs} / 失败 ${res.failed.length} / 不可还原 ${res.blocked.length}`);
      return res;
    });

  /** P0: 重试上条 �?重发�?后一�?user 消息 */
  handleTrusted<{ agentId: string; sessionId?: string }>("slime:chat:retry", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId || resolveAgentId(undefined);
    // A-1017：同 slime:chat:stream —�??加载面板不再由这里�?判，改由管理器状态广�?��动�??
    const { popLastRecordForAgentExport } = await import("../../../core-ts/src/services/history.js");
    const last = await popLastRecordForAgentExport(agentId, payload.sessionId);
    if (!last || !last.user) {
      return { ok: false, error: "无历史可重试" };
    }
    /* A-1131：重试路径同样�?读会�?meta —�??会话级模型�?�择住在那儿（缺�?= 跟随 Agent 默�?值）�?*/
    const retryMeta = payload.sessionId ? await getSession(payload.sessionId).catch(() => null) : null;
    const req: ChatRequest = {
      message: last.user,
      history: await loadSessionHistory(payload.sessionId),
      retry: true,
      sessionId: payload.sessionId,
      /* A-1084：重试路径同样�?�传窗口上限 —�??否则「重试�?�这条入口就成了绕过保险门的后门
         （A-1082 的教�?��判据漏接�?�?= 那条�?��完全没有保护）�??*/
      /* A-1131：重试路径也要带会话级模�?—�??否则它会**�?�?Agent 默�?�?*
         （用户在�?��话�?�的模型在重试时�?��悄换掉），且窗口上限按错的模型算�?*/
      windowCap: await resolveSessionWindowCap(
        agentId,
        effectiveModelChoice(retryMeta?.modelChoice, (await agentRegistry!.findAgent(agentId).catch(() => null))?.model_choice),
      ).catch(() => undefined),
      modelChoice: retryMeta?.modelChoice,
    };
    const session = createStreamSession();
    // A-980-R24：重试流同样�?chunk 合批（�?前与正常发�?�路径一样是�?token �?�?IPC�?
    const chunkSender = createChunkSender();
    // 授权/提问请求按当前流打会话标签（retry 流的会话 = payload.sessionId�?
    const retryCancelKey = payload.sessionId ?? agentId;
    agentStreamSessionMap.set(agentId, retryCancelKey);
    lastChatCancelKey = retryCancelKey; // A-1017：供加载面板的�?�取消加载�?�中�?��次加�?
    // 干净正文：优先取 chatService done 事件全量清洗后的 reply（同 slime:chat:stream�?
    let cleanReply: string | undefined;
    // A-939 上下文分桶（�?done 事件透传给渲染层分桶托盘�?
    let ctxBuckets: CtxBuckets | undefined;
    // D/E：重试流同样记录 trace �?Plan 工具拦截
    const recorder = new TraceRecorder(retryCancelKey);
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      void (async () => {
        try {
          for await (const ev of chatService!.stream(agentId, req, 0)) {
            recorder.push(ev);
            interceptPlanTool(ev, retryCancelKey);
            if (ev.type === "done") {
              const d = (ev.data ?? {}) as Record<string, unknown>;
              if (typeof d.reply === "string" && d.reply) { cleanReply = d.reply; }
            }
            const chunk = toStreamChunk(ev, payload.sessionId);
            session.pushChunk(chunk);
            // A-980-R24：合批下发（原�? chunk 仍�?�条�?session 缓冲�?
            chunkSender.push(chunk);
          }
          // A-980-R24：done 之前必须 flush（否则尾部�?文晚�?done 到达�?
          chunkSender.flush();
          mainWindow?.webContents.send("slime:chat:done", {
            reply: cleanReply ?? session.fullReply, model: session.model,
            elapsedMs: session.elapsedMs, timings: session.timings,
            sessionId: payload.sessionId,
            // A-933：权威窗口上限（Agent.max_context 或本次模�?context_window），右栏与环同源
            windowCap: await resolveSessionWindowCap(agentId, session.model).catch(() => undefined),
            // A-939：上下文分桶（引�?done 事件 �?渲染层分桶托盘）
            ctxBuckets,
          });
          mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: payload.sessionId }); // A-918
          // A-980-R26：重新生成完�?�?系统通知
          notifyUser({
            kind: "done",
            title: `${agentNameForNotify(agentId)} 已完成`,
            body: (cleanReply ?? session.fullReply ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || "任务已结束",
          });
          const traced = recorder.finish(true);
          traceStoreSet(retryCancelKey, traced);
          mainWindow?.webContents.send("slime:trace:update", { sessionId: retryCancelKey, trace: traced });
          resolve({ ok: true });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[gui:main] chat retry error:", msg);
          chunkSender.flush(); // A-980-R24：中�?��已产出的内�?照常放出�?
          mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: payload.sessionId });
          mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: payload.sessionId }); // A-918
          // A-980-R26：重新生成出错同样�?�知
          notifyUser({
            kind: "error",
            title: `${agentNameForNotify(agentId)} 出错`,
            body: msg.replace(/\s+/g, " ").trim().slice(0, 160) || "重新生成时发生错误",
          });
          const failedTrace = recorder.finish(false, msg);
          traceStoreSet(retryCancelKey, failedTrace);
          mainWindow?.webContents.send("slime:trace:update", { sessionId: retryCancelKey, trace: failedTrace });
          resolve({ ok: false, error: msg });
        } finally {
          chunkSender.dispose(); // A-980-R24：合批器收尾（flush 幂等�?
          // 值匹配才删（A-151 竞�?�防护，�?slime:chat:stream�?
          if (agentStreamSessionMap.get(agentId) === retryCancelKey) {
            agentStreamSessionMap.delete(agentId);
          }
          // A-1017：兜底收口（�?slime:chat:stream —�??面板由�?理器状�?�广�?���?��
          mainWindow?.webContents.send("slime:model:loading", { loading: false });
        }
      })();
    });
  });

  /* �?�? 会话管理（侧栏�?话列�?��项目 = Agent，项�?���?��会话�?�?�? */

  /** 会话列表：sessions.json 元数�?�?history 记录（按 session_id 聚合�?*/
  handleTrusted<void>("slime:sessions:list", async () => {
    // A-1043�?*这里就是"�?��后左栏空�?的病�?*。原�?�� `await ensureServices()`�?
    // �?�?��读操作（列元数据 + 历史聚合）�?整条重初始化链（SILAM python sidecar / engine /
    // sandbox / ChatService / 调度�?��挡住，启动成�?��因为无去重�?并发跑两遍；
    // 渲染�?8s 兜底门一放�?，用户看到的就是"暂无会话、跟刚下载一�?�?
    // 会话列表真�?�?要的�?��两样：Agent 名字�?+ 落盘元数�?历史�?
    await ensureRegistry();
    const [metas, records] = await Promise.all([
      listSessions(),
      loadHistory(null, 100000),
    ]);
    const names = new Map((agentRegistry?.loadedAgents ?? []).map((a) => [a.id, a.name]));
    // 历史�?(agent_id, session_id ?? 默�?会话) 聚合
    const byKey = new Map<string, { agentId: string; count: number; firstUser: string; lastTime: string }>();
    for (const r of records) {
      const key = `${r.agent_id}::${r.session_id ?? "default"}`;
      const agg = byKey.get(key) ?? { agentId: r.agent_id, count: 0, firstUser: "", lastTime: "" };
      agg.count += 1;
      if (!agg.firstUser) { agg.firstUser = r.user; }
      if (r.timestamp > agg.lastTime) { agg.lastTime = r.timestamp; }
      byKey.set(key, agg);
    }
    const items: Array<{ sessionId: string; agentId: string; agentName: string; workspace?: string; title: string; count: number; lastTime: string; memberIds?: string[]; memberNames?: string[]; memberModels?: Record<string, string>; leaderModel?: string; memberEfforts?: Record<string, string>; leaderEffort?: string; type?: "normal" | "brainstorm"; modelChoice?: string }> = [];
    for (const meta of metas) {
      // 旧�?录（�?session_id）按 "default" 聚合，归入�? Agent 首个会话
      const agg = byKey.get(`${meta.agentId}::${meta.id}`) ?? byKey.get(`${meta.agentId}::default`);
      const memberIds = memberIdsOf(meta.members);
      const memberNames = memberIds.map((id) => names.get(id) ?? id);
      items.push({
        sessionId: meta.id,
        agentId: meta.agentId,
        agentName: names.get(meta.agentId) ?? meta.agentId,
        workspace: meta.workspace,
        title: meta.title,
        count: agg?.count ?? 0,
        lastTime: agg?.lastTime ?? meta.updatedAt,
        memberIds,
        memberNames,
        memberModels: memberModelsOf(meta.members),
        leaderModel: meta.leaderModel,
        /* A-1131：本会话的模型�?�择（渲染层�??显示/回填；缺�?= 跟随 Agent 默�?值） */
        modelChoice: meta.modelChoice,
        memberEfforts: memberEffortsOf(meta.members),
        leaderEffort: meta.leaderEffort,
        type: meta.type,
      });
    }
    // 无会话元数据的旧历史（惰性迁移：为�? Agent 建默认会话）
    for (const [key, agg] of byKey) {
      const agentId = key.split("::")[0];
      if (!metas.some((m) => m.agentId === agentId)) {
        // A-1017�?*�?�� Agent 仍然存在才迁�?*�?
        // 此前无条�?`ensureDefaultSession(agentId)` �?历史里任何�?�?agent_id 都会�?���?
        // �?�?��定不存在 Agent �?*幽灵会话**：模型一�?��选不了（引擎 findAgent 返回 undefined
        // �?404「Agent 不存在�?�），�?�且删掉之后下一次列表刷新又照原样建回来�?
        // 孤儿 agent_id 的现实来源：测试漏注�?history store 把夹具写进了真实 history.jsonl
        // （测试侧已修 + 有守�?��，以及历史上�?��除的 Agent�?
        if (!names.has(agentId)) {
          console.warn(
            `[gui:main] 跳过孤儿历史的会话迁移：Agent「${agentId}」不存在（${agg.count} 条记录，跳过会话）`,
          );
          continue;
        }
        const meta = await ensureDefaultSession(agentId);
        const memberIds = memberIdsOf(meta.members);
        items.push({
          sessionId: meta.id,
          agentId,
          agentName: names.get(agentId) ?? agentId,
          workspace: meta.workspace,
          title: meta.title === "新会话" ? (agg.firstUser || "新会话").slice(0, 60) : meta.title,
          count: agg.count,
          lastTime: agg.lastTime,
          memberIds,
          memberNames: memberIds.map((id) => names.get(id) ?? id),
        });
      }
    }
    return items.sort((a, b) => (a.lastTime < b.lastTime ? 1 : -1));
  });

  /** 新建会话（以�?��工作文件夹为主；会话内指定调�?Agent�?
   *  - payload.workspace �??�：�?��工作文件夹（工具操作锚定到�?�?��）；缺省为空 �?归入「未绑定文件夹�?�组
   *  - payload.agentId �??�：缺省时自动�?�根 Agent（无 parent_id，优先）或�?�?���?Agent
   *  - 若当前没有任�?Agent，兜底创建一�?��认�?�助手�?�Agent，实�?打开直接�?的懒会话
   */
  handleTrusted<{ agentId?: string; title?: string; workspace?: string | null; memberIds?: MemberEntry[]; leaderModel?: string; type?: "normal" | "brainstorm" }>("slime:sessions:create", async (_event, payload) => {
    await ensureServices();
    let aid = payload.agentId;
    // 1) �?�� agentId：优先�?�一�?�� Agent（无 parent_id），否则选列表�?�?�?
    if (!aid) {
      const roots = agentRegistry!.loadedAgents.filter((a) => !a.parent_id);
      const fallback = roots[0] ?? agentRegistry!.loadedAgents[0];
      if (fallback) {
        aid = fallback.id;
      } else {
        // 2) 无任�?Agent：创建默认�?�助手�?�Agent（�?�用 AI 助手角色�?
        const def = await createAgent("助手", "通用 AI 助手，负责回答问题�?�编写代码�?�整理信�?��日常协作");
        aid = def.id;
        console.info(`[gui:main] 兜底创建默�? Agent: ${def.id} name=${def.name}`);
      }
    }
    const agent = await agentRegistry!.findAgent(aid);
    if (!agent) { throw new Error("Agent 不存在"); }
    const meta = await createSession(aid, {
      title: payload.title,
      workspace: payload.workspace ?? undefined,
      memberIds: payload.memberIds,
      leaderModel: payload.leaderModel,
      type: payload.type === "brainstorm" ? "brainstorm" : undefined,
    });
    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));
    const memberIds = memberIdsOf(meta.members);
    console.info(`[gui:main] 新建会话: agent=${aid} session=${meta.id} workspace=${meta.workspace ?? "(�?���?"} members=${memberIds.length}${meta.type === "brainstorm" ? "（头脑�?暴）" : ""}`);
    return {
      ok: true,
      session: {
        sessionId: meta.id,
        agentId: meta.agentId,
        agentName: names.get(meta.agentId) ?? meta.agentId,
        workspace: meta.workspace,
        title: meta.title,
        count: 0,
        lastTime: meta.updatedAt,
        memberIds,
        memberNames: memberIds.map((id) => names.get(id) ?? id),
        memberModels: memberModelsOf(meta.members),
        leaderModel: meta.leaderModel,
        /* A-1131：本会话的模型�?�择（渲染层�??显示/回填；缺�?= 跟随 Agent 默�?值） */
        modelChoice: meta.modelChoice,
        memberEfforts: memberEffortsOf(meta.members),
        leaderEffort: meta.leaderEffort,
        type: meta.type,
      },
    };
  });

  /** A-943：切�?��话模式（�???/ 群聊头脑风暴�?*/
  handleTrusted<{ sessionId: string; type?: "normal" | "brainstorm" }>("slime:sessions:setType", async (_event, payload) => {
    if (!payload?.sessionId) { return { ok: false, error: "sessionId 必填" }; }
    const meta = await setSessionType(payload.sessionId, payload.type === "brainstorm" ? "brainstorm" : null);
    return { ok: !!meta, sessionId: payload.sessionId, type: meta?.type ?? "normal" };
  });

  /** 重命名会�?*/
  handleTrusted<{ sessionId: string; title: string }>("slime:sessions:rename", async (_event, payload) => {
    await ensureServices();
    const meta = await renameSession(payload.sessionId, payload.title);
    return { ok: !!meta };
  });

  /** 删除会话（清元数�?+ 清�?会话历史�?*/
  handleTrusted<{ sessionId: string }>("slime:sessions:remove", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    const removed = await removeSession(payload.sessionId);
    if (meta) {
      await clearSessionHistory(meta.agentId, meta.id);
      // A-1017：�? Agent �?*�?后一�?*会话�?��掉时，连**没有 session_id 的遗留历�?*�?起清�?
      // 不清的后果：遗留记录留在盘上 �?下一�?`sessions:list` 的�?儿迁移又把它建成新会�?
      // �?用户体感"这个会话删不�?，且每�?复活都换�?�?�� sessionId�?
      const rest = (await listSessions()).filter((s) => s.agentId === meta.agentId);
      if (rest.length === 0) {
        const purged = await clearLegacySessionHistory(meta.agentId);
        if (purged > 0) {
          console.info(`[gui:main] 会话删除时清理遗留历史（�?session_id�? agent=${meta.agentId} 条数=${purged}`);
        }
      }
    }
    // A-980-R29：会话删了，它的 Plan（内�?Map）与待办文件（data/todos_<sid>.json）也要一起走�?
    // 此前两条都只增不�?�?内存常驻 + data/ �?��无限堆积�?
    purgeSessionPlanning(payload.sessionId);
    console.info(`[gui:main] 会话已删�? session=${payload.sessionId}`);
    return { ok: removed };
  });

  /** A-1008：历史�?�?�?GUI 消息�?
   *
   *  群聊记录（type=brainstorm 且有逐成员发�?）必�?*按成员展�?成�?�?*，每条带�?���?
   *  agentName/agentId。�?前一律只产出�?条不带归属的 assistant 消息 �?渲染层回�?到会话归�?
   *  Agent 的名字，于是"把所有人发言揉在�?起的�?条巨长气�?看起来就像某�?Agent 出来总结复述�?
   *  且重�?��成员气泡全丢（它�?���?��库）。这�?���?根因的两�?��状，�?ref-grouptalk.md�?
   *
   *  旧�?录（�?��拼好的大字�?串�?�没�?turns）走 `parseSpeakerBlob` 还原，用户历史里已有�?
   *  记录也能直接恢�?成�?�成员气泡，不必等重�?�?�???
   *
   *  实现已搬�?`core-ts/src/services/grouptalkTranscript.ts` �?`expandHistoryRecord`
   *  （纯函数）�?��??内联�?IPC handler 里等于测不到，�??�?条�?录展�?成几条气�?正是这个
   *  历时很久的故障的�?后一�?��必须�?��归�?�这里只保留�?�?��签名包�?，调用点不用改�??
   */
  const historyRecordToMessages = (
    r: HistoryRecord,
    groupNames?: ReadonlySet<string>,
  ): ExpandedMessage[] => expandHistoryRecord(r, groupNames);

  /** 群聊会话的成员名集合（用于判�?��条�?录�?不�?按发�?块展�?；undefined = 非群聊会话） */
  const groupNamesOf = async (meta: { id?: string; type?: string; members?: unknown }): Promise<ReadonlySet<string> | undefined> => {
    if (meta.type !== "brainstorm") { return undefined; }
    try {
      const ids = memberIdsOf(meta.members as MemberEntry[] | undefined);
      const agents = await Promise.all(ids.map((id) => agentRegistry!.findAgent(id).catch(() => null)));
      const names = agents.filter((a): a is AgentState => a !== null).map((a) => a.name);
      // 会话归属 Agent 也可能发�?（roster �?loadingAgent）→ �?并纳�?
      if (meta.id) {
        const owner = await getSession(meta.id).catch(() => null);
        if (owner?.agentId) {
          const a = await agentRegistry!.findAgent(owner.agentId).catch(() => null);
          if (a) { names.push(a.name); }
        }
      }
      return new Set(names);
    } catch {
      return undefined;
    }
  };

  /** 加载某会话的完整消息（聊天面板显示历史） */
  handleTrusted<{ sessionId: string }>("slime:sessions:load", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { return []; }
    const metas = await listSessions();
    const agentSessions = metas.filter((m) => m.agentId === meta.agentId);
    // 旧�?录（�?session_id）归入创建最早的会话
    const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
    const records = await loadHistoryForSession(meta.agentId, meta.id, 500, firstSession);
    const groupNames = await groupNamesOf(meta);
    return records.flatMap((r) => historyRecordToMessages(r, groupNames));
  });

  /** A-980-R18：分页加载更早历史（聊天顶部「加载更早的消息」分段胶囊点击再载；首屏�?���?�?500 条） */
  handleTrusted<{ sessionId: string; beforeTs: string; limit?: number }>("slime:sessions:loadEarlier", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { return { messages: [], hasMore: false }; }
    const metas = await listSessions();
    const agentSessions = metas.filter((m) => m.agentId === meta.agentId);
    // 旧�?录（�?session_id）归入创建最早的会话
    const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
    const { records, hasMore } = await loadHistoryForSessionBefore(
      meta.agentId, meta.id, payload.limit ?? 200, firstSession, payload.beforeTs,
    );
    const groupNames = await groupNamesOf(meta);
    return { messages: records.flatMap((r) => historyRecordToMessages(r, groupNames)), hasMore };
  });

  /** A-966：渲染层 done 后把该条回�?的交错时间线回填�?history.jsonl（重�?��复时间线，不依赖 localStorage�?*/
  handleTrusted<{ agentId: string; sessionId: string; timeline: unknown[] }>("slime:chat:attachTimeline", async (_event, p) => {
    try {
      await attachTimelineToRecord(p.agentId, p.sessionId, (p.timeline as HistoryRecord["timeline"]) ?? []);
      return { ok: true };
    } catch (e) {
      console.warn("[gui:main] attachTimeline 失败:", e instanceof Error ? e.message : String(e));
      return { ok: false };
    }
  });

  /** 清空会话历史（保留会话条�?��标�?�?*/
  handleTrusted<{ sessionId: string }>("slime:sessions:clear", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { return { ok: false }; }
    await clearSessionHistory(meta.agentId, meta.id);
    console.info(`[gui:main] 会话已清�? session=${payload.sessionId}`);
    return { ok: true };
  });

  /** 会话级配�?��审批模式（Agent 级）+ 工作�?��（会话级优先�?
   *  - approval：写 Agent sandbox_override.approval（�?批属�?Agent 能力，跨会话生效�?
   *  - workspace：有 sessionId �?写会�?meta.workspace�?以文件夹为主"）；�?sessionId �?回�??�?Agent sandbox_override（旧�?��兼�?�?
   */
  handleTrusted<{ agentId: string; sessionId?: string; approval?: ApprovalMode; workspace?: string | null }>(
    "slime:sessions:config",
    async (_event, payload) => {
      await ensureServices();
      const agent = await agentRegistry!.findAgent(payload.agentId);
      if (!agent) { throw new Error("Agent 不存在"); }
      const prev = (agent.sandbox_override && typeof agent.sandbox_override === "object")
        ? { ...agent.sandbox_override }
        : { approval: "auto" as ApprovalMode };
      const next: Record<string, unknown> = { ...prev };
      if (payload.approval) { next.approval = payload.approval; }
      let workspace = next.workspace as string | undefined;
      if (payload.workspace !== undefined) {
        if (payload.sessionId) {
          const updated = await setSessionWorkspace(payload.sessionId, payload.workspace ?? null);
          workspace = updated?.workspace ?? "";
        } else {
          next.workspace = payload.workspace ?? "";
          workspace = payload.workspace ?? "";
        }
      }
      if (payload.approval || payload.workspace === undefined) {
        await agentRegistry!.updateAgent(payload.agentId, { sandbox_override: next });
        sandbox!.setAgentConfig(payload.agentId, sandboxConfigFromOverride(next));
      }
      return { ok: true, approval: next.approval as ApprovalMode, workspace: workspace ?? "" };
    },
  );

  /** 会话级配�??取（审批模式 + 工作�?��）；�?���?���?��回�??到全�?权限默�?审批 */
  handleTrusted<{ agentId: string; sessionId?: string }>("slime:sessions:configGet", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    const ov = agent?.sandbox_override;
    const globalDefault = getPermissions().globalApproval;
    const agentWorkspace = (ov && typeof ov === "object" && typeof ov.workspace === "string") ? ov.workspace : "";
    // 会话级工作目录优先（"以文件夹为主"模型）；无会�?无配�?���? Agent 级（旧数�?��
    let workspace = agentWorkspace;
    let agentId = payload.agentId;
    if (payload.sessionId) {
      const meta = await getSession(payload.sessionId);
      agentId = meta?.agentId ?? payload.agentId;
      const ws = meta?.workspace?.trim();
      if (ws) { workspace = ws; }
    }
    return {
      approval: (ov && typeof ov === "object" && (ov.approval as ApprovalMode)) ?? globalDefault,
      workspace,
      agentId,
    };
  });

  /** 会话内切换调用的 Agent（保留工作文件夹/标�?/历史�?以文件夹为主"模型�?Agent 协作�?*/
  handleTrusted<{ sessionId: string; agentId: string }>("slime:sessions:setAgent", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { throw new Error("会话不存在"); }
    const agent = await agentRegistry!.findAgent(payload.agentId);
    if (!agent) { throw new Error("Agent 不存在"); }
    const updated = await setSessionAgent(payload.sessionId, payload.agentId);
    if (!updated) { throw new Error("会话不存在"); }
    console.info(`[gui:main] 会话切换 Agent: session=${payload.sessionId} ${meta.agentId} �?${payload.agentId}`);
    return { ok: true };
  });

  /** 团队会话成员更新（组�?会话当前 agentId；空数组 = �?回单人会话）
   *  - 成员名单持久化到会话元数�?��引擎层将成员注入组长系统提示（团队协作�?则）
   *  - 成员发言�?member"流事件冒泡到渲染层（群聊展示），并并入组长整合回复持久化 */
  handleTrusted<{ sessionId: string; memberIds: string[] }>("slime:sessions:setMembers", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionMembers(payload.sessionId, payload.memberIds);
    if (!updated) { throw new Error("会话不存在"); }
    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));
    const memberIds = memberIdsOf(updated.members);
    console.info(`[gui:main] 会话团队成员更新: session=${payload.sessionId} members=${memberIds.join(",") || "(单人会话)"}`);
    return {
      ok: true,
      session: {
        sessionId: updated.id,
        agentId: updated.agentId,
        agentName: names.get(updated.agentId) ?? updated.agentId,
        workspace: updated.workspace,
        title: updated.title,
        count: 0,
        lastTime: updated.updatedAt,
        memberIds,
        memberNames: memberIds.map((id) => names.get(id) ?? id),
        memberModels: memberModelsOf(updated.members),
        leaderModel: updated.leaderModel,
        memberEfforts: memberEffortsOf(updated.members),
        leaderEffort: updated.leaderEffort,
      },
    };
  });

  /** A-1011 群聊成员思�?�推理强度（会话级�?盖；仅影响�?群聊，不�?Agent 全局配置�?
   *  - effort=null 清除覆盖 �?回落群聊默�? high
   *  - 组长（meta.agentId）写 leaderEffort，其余成员写 members 条目 */
  handleTrusted<{ sessionId: string; memberId: string; effort: string | null }>("slime:sessions:setMemberEffort", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionMemberEffort(payload.sessionId, payload.memberId, payload.effort ?? null);
    if (!updated) { throw new Error("会话不存在或该成员不在群聊中"); }
    const eff = payload.effort ? payload.effort : "(默�? high)";
    console.info(`[gui:main] 群聊成员推理强度: session=${payload.sessionId} member=${payload.memberId} �?${eff}`);
    return { ok: true, memberEfforts: memberEffortsOf(updated.members), leaderEffort: updated.leaderEffort };
  });

  /** 会话级工作目录更新（"以文件夹为主"：会话切�?新建时绑定文件夹�?*/
  handleTrusted<{ sessionId: string; workspace: string | null }>("slime:sessions:setWorkspace", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionWorkspace(payload.sessionId, payload.workspace);
    if (!updated) { throw new Error("会话不存在"); }
    console.info(`[gui:main] 会话工作�?��更新: session=${payload.sessionId} �?${updated.workspace ?? "(�?���?"}`);
    return { ok: true, workspace: updated.workspace };
  });

  /**
   * A-1131：把**�?���?*的模型�?�择落盘（不�?Agent 记录 �?�?Agent 的其他会话不受影响）�?
   *
   * 用户原话：�?�同�?�?Agent 似乎不能在不同会话使用不同模型�?��?�之前那�?��话里面的 agent
   * 模型直接变成 deepseek 模型了�?��?��?前这条�?�路不存�?��下拉�?���?Agent（全会话共用）�??
   *
   * ⚠️ �?��会话 meta�?*�?*顺带�?Agent —�??Agent 上的 `model_choice` 由渲染层在切换时
   *    另�?更新为�?�最近�?�择」（供新建会话继承），两条�?义分�?、各写各的�??
   */
  handleTrusted<{ sessionId: string; modelChoice: string | null }>("slime:sessions:setModelChoice", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionModelChoice(payload.sessionId, payload.modelChoice);
    if (!updated) { throw new Error("会话不存在"); }
    console.info(`[gui:main] 会话模型更新: session=${payload.sessionId} → ${updated.modelChoice ?? "(跟随 Agent 默认)"}`);
    return { ok: true, modelChoice: updated.modelChoice ?? null };
  });

  /** 加载会话级待办任务（�?todo_write 工具写入 data/todos_<sessionId>.json�?*/
  handleTrusted<{ sessionId: string }>("slime:sessions:loadTodos", async (_event, payload) => {
    // A-980-R28�?*�?sessionId 直接拒绝**。渲染层在会话未就绪时传的是 `?? ""`�?
    // �?`todos_` + "" + `.json` = `data/todos_.json` —�??那�?好是�??前遗留�?儿文件的文件名，
    // 于是"会话加载途中就把上一次的旧待办显示出来了"（用户实测）�?
    // 这类兜底必须放在主进程：渲染层任何一处忘了守�?��不�?能把孤儿文件读出来�??
    // （A-980-R29：`todoStore.todoPath` 对空 sessionId 返回 null，双重保险�?�）
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sid) {
      console.warn("[gui:main] loadTodos 收到空 sessionId，已拒绝（避免读到 todos_.json 这类孤儿文件）");
      return { ok: true, todos: [] };
    }
    // A-985�?*首�?**读某会话的待办时收敛"僵尸 in_progress" —�??
    // App 卡�?�?���? / 进程重启后，落盘�?in_progress 项会永远显示�?进�?�?（转�?+ 高亮），
    // 但根�?��有流在跑（用户实测："我并�?��入任何命令，列表却显示一�?��务在进�?�?）�??
    // 判定依据�?`activeChats`（主进程�?��有资格回�?这条流�?没�?"的地方，key = sessionId ?? agentId）：
    // �?���?��没有活跃流才降级，绝不会�?��正在跑的任务�?
    if (!staleChecked.has(sid)) {
      staleChecked.add(sid);
      if (!activeChats.has(sid)) {
        const n = demoteStaleInProgress(sid);
        if (n > 0) {
          console.warn(`[gui:main] 待办收敛：会�?${sid} �?${n} 项停�?进�?�?但没有活跃流，已降级为待办（A-985）`);
        }
      }
    }
    // 读取统一�?todoStore（�?�?+ 归一化口径与工具�?致）
    const todos = readTodos(sid);
    // A-985：�?盘路径�?到一�?*已全部完�?*的清�?�?**立即**清干�?，不再走 1.5s 延迟�?
    // 那个延迟的唯�?�?���?让刚完成时的划过动画�?��"；�?��?盘路径没有任何动画�?�?��
    // 延迟�?��让用户看�?打开会话后列表自己消失一�? —�??用户实测把它当成了显示异�?
    // （原话："我�??疑是列表判断为任务全部完成后全部�?��清除"）�??
    // 顺带解决�?�?��糟的边界：若在这 1.5s �?App �?���?，清空永远不会发�?�?那张全完成清�?
    // 会一直躺在盘上，每�?打开会话都重新排�?次清空（反�?"�?��消失"）�??
    if (allTodosCompleted(todos)) {
      removeTodos(sid);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("slime:tasks:todos", { sessionId: sid, todos: [] });
      }
      return { ok: true, todos: [] };
    }
    // 广播到所有渲染进程（�?��多窗口场�?��
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("slime:tasks:todos", { sessionId: sid, todos });
    }
    return { ok: true, todos };
  });

  /**
   * A-986：渲染层手改待办 �?**落盘**�?
   *
   * 事故：�?�?*根本没有这条通道**（只�?load + 订阅），渲染层的 `toggleTodo/advanceTodo/addTodo`
   * �?�� `setTodos()` 改内存�?��?�待办的真源�?`data/todos_<sid>.json` —�??
   * 下一次任何来源的 `slime:tasks:todos` 广播（模�?todo_write / 切会�?/ 重启读盘�?
   * 都用盘上的旧内�?把它覆盖回去。后果有两个，用户都撞上了：
   *   �?手动勾�??没反�?（勾完过�?会儿又变回未完成）；
   *   �?主进程的「全部完�?�?�?��清空」挂�?`broadcastTodos` �?—�??手改不落盘就永不广播�?
   *      于是把全部任务勾完也**不会**触发�?��清空�?
   * 现在手改同样�?写盘 �?广播"（与模型�?todo_write 完全同一条链�?��，�?义才�?致�??
   */
  handleTrusted<{ sessionId?: string; todos?: unknown[] }>("slime:tasks:saveTodos", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sid) { return { ok: false, error: "会话�?���?��无法保存待办" }; }
    if (!Array.isArray(payload?.todos)) { return { ok: false, error: "todos 必须是数组" }; }
    // 归一�?+ 落盘统一�?todoStore（与工具同一份实现，规则�?���?处）
    const saved = writeTodos(sid, payload.todos as Parameters<typeof writeTodos>[1]);
    if (!saved) { return { ok: false, error: "写入失败（路径不�?��或会话无效）" }; }
    // 写盘后立刻广�?��界面与�?盘�?齐，并顺带触�?全部完成 �?�?��清空"判定
    broadcastTodos(sid);
    return { ok: true, todos: saved };
  });

  /**
   * A-986：整张清空（删文�?+ 广播空列�?���?
   *
   * A-980-R32 曾以"�?��清空已�?�?为由删掉手动清空入口。实践证�?���?��清空�??�?
   * **全部 completed** 这一种终态；清单里混�?�?��有的任务"（模型写�??�旧会话串味�?
   * 手滑加错）时，用户既删不掉（行尾 �?也�?删了）也清不�?—�??�?��看着它一直挂在那儿�??
   * 用户的诉求很直接�?你给我彻底优化这�?��办任务的清除逻辑"。故恢�?该入口�??
   */
  handleTrusted<{ sessionId?: string }>("slime:tasks:clearTodos", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sid) { return { ok: false }; }
    removeTodos(sid);
    staleChecked.add(sid); // 刚清�?�?没有�?��敛的东西，避免下�?次�?盘又走一遍收�?
    broadcastTodos(sid);
    return { ok: true };
  });

  /** 选择工作�?��（项�?��件夹�?*/
  handleTrusted<void>("slime:sessions:pickFolder", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const openOpts: Electron.OpenDialogOptions = {
      title: "选择项目工作�?��（Agent 的�?写将限制在�?�?��内）",
      properties: ["openDirectory", "createDirectory"],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消�?�择" }; }
    return { ok: true, path: open.filePaths[0] };
  });

  /** 删除 Agent 时清理其全部会话元数�?*/
  handleTrusted<{ agentId: string }>("slime:sessions:removeAgent", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId;
    // A-980-R29�?*先�?�?*�?Agent 的会�?id —�??`removeSessionsForAgent` �?��回数量，
    // 删完就再也查不到这些 sessionId，待办文件（data/todos_<sid>.json）会永远留在磁盘上�??
    const doomed = (await listSessions()).filter((s) => s.agentId === agentId).map((s) => s.id);
    await removeSessionsForAgent(agentId);
    await removeAgentHistory(agentId);
    for (const sid of doomed) { purgeSessionPlanning(sid); }
    console.info(`[gui:main] 项目已删除（会话+历史+待办清理�? agent=${agentId} sessions=${doomed.length}`);
    return { ok: true };
  });

  /** 删除工作文件夹分组：清除�?workspace 下全部会话元数据 + 各会话历史（文件夹本�?�� Agent 保留�?*/
  handleTrusted<{ workspace: string }>("slime:sessions:removeWorkspace", async (_event, payload) => {
    await ensureServices();
    const workspace = payload.workspace;
    const removed = await removeSessionsForWorkspace(workspace);
    for (const s of removed) {
      try { await clearSessionHistory(s.agentId, s.sessionId); } catch { /* 忽略单条历史清理失败 */ }
      // A-980-R29：待办文件与 Plan �?并清理（与上�?���?��除入口口径一致）
      purgeSessionPlanning(s.sessionId);
    }
    // A-1017：涉及到�?Agent 若已**再无任何会话**，连它没�?session_id 的遗留历史一起清 —�??
    // 否则下一�?`sessions:list` 的�?儿迁移会把它�?��新建成幽灵会话（�?sessions:remove）�??
    const rest = await listSessions();
    for (const aid of new Set(removed.map((s) => s.agentId))) {
      if (rest.some((s) => s.agentId === aid)) { continue; }
      try {
        const purged = await clearLegacySessionHistory(aid);
        if (purged > 0) {
          console.info(`[gui:main] 工作文件夹删除时清理遗留历史（无 session_id�? agent=${aid} 条数=${purged}`);
        }
      } catch { /* 忽略单条历史清理失败 */ }
    }
    console.info(`[gui:main] 工作文件夹会话已删除: workspace=${workspace} count=${removed.length}`);
    return { ok: true, count: removed.length };
  });

  /** 加号/命令面板：技�?+ MCP 工具列表 */
  handleTrusted<void>("slime:extras:list", async () => {
    await ensureServices();
    const skills: Array<{ name: string; description: string }> = [];
    try {
      const skillReg = new SkillRegistry();
      await skillReg.loadSkills();
      for (const schema of skillReg.listSkills() as Array<{ function?: { name?: string; description?: string } }>) {
        skills.push({
          name: schema.function?.name ?? "?",
          description: schema.function?.description ?? "",
        });
      }
    } catch (e) {
      console.warn("[gui:main] �?能列表加载失�?", e);
    }
    const mcpTools: Array<{ name: string; description: string }> = [];
    try {
      for (const schema of getRegistry().listTools() as Array<{ function?: { name?: string; description?: string } }>) {
        const name = schema.function?.name ?? "";
        if (name.startsWith("mcp_")) {
          mcpTools.push({ name, description: schema.function?.description ?? "" });
        }
      }
    } catch (e) {
      console.warn("[gui:main] MCP 工具列表加载失败:", e);
    }
    return { skills, mcpTools };
  });

  /** 全局权限：�?取（设置「权限�?�专栏） */
  handleTrusted<void>("slime:permissions:get", async () => getPermissions());

  /** 全局权限：写入（部分更新，返回合并后结果）；globalApproval 变更时同步所�?Agent �?sandbox_override.approval，避免局部�?盖失�?*/
  handleTrusted<Record<string, unknown>>("slime:permissions:set", async (_event, patch) => {
    const { ok, permissions, error } = setPermissions(patch);
    if (!ok) { return { ok: false, permissions, error }; }
    if (patch.globalApproval !== undefined || patch.approvalAllowPaths !== undefined) {
      try {
        // 设置即权威：全局审批档位写回每个 Agent �?override（跨会话生效），
        // 覆盖会话级遗留�??—�??否则用户改了设置却发现某些会话仍然按老档位问�?
        const agents = agentRegistry!.loadedAgents;
        for (const a of agents) {
          const ov = (a.sandbox_override && typeof a.sandbox_override === "object")
            ? { ...(a.sandbox_override as Record<string, unknown>) }
            : {};
          const next: Record<string, unknown> = { ...ov, approval: permissions.globalApproval };
          await agentRegistry!.updateAgent(a.id, { sandbox_override: next });
        }
      } catch (e) {
        console.error("[gui:main] sync global approval to agents failed:", e);
      }
      // 沙�?配置统一下发（含没有 override �?Agent）�?��??单一实现，避免两套下发�?�辑漂移
      applyGlobalSandboxDefaults();
    }
    return { ok: true, permissions };
  });

  /** 权限请求：渲染层输入框�?�择�?�?用户决策回传（未匹配挂起请求视为陈旧丢弃�?*/
  handleTrusted<PermissionDecision>("slime:perm:resolve", async (_event, decision: PermissionDecision) => {
    const resolver = pendingPerms.get(decision.requestId);
    if (!resolver) {
      return { ok: false, error: "请求不存在或已超时" };
    }
    pendingPerms.delete(decision.requestId);
    resolver(decision);
    return { ok: true };
  });

  /** ask_user 提问：渲染层输入框�?�择�?�?用户回答回传（未匹配挂起请求视为陈旧丢弃�?*/
  handleTrusted<AskUserDecision>("slime:ask:resolve", async (_event, decision: AskUserDecision) => {
    const resolver = pendingAsks.get(decision.requestId);
    if (!resolver) {
      return { ok: false, error: "请求不存在或已超时" };
    }
    pendingAsks.delete(decision.requestId);
    resolver(decision);
    return { ok: true };
  });

  /** MCP 服务器状态列�?���??禁用的，供�?�MCP 接入」专栏恢复） */
  handleTrusted<void>("slime:extras:mcpList", async () => {
    await ensureServices();
    const { listMcpServers } = await import("./config_files.js");
    return listMcpServers();
  });

  /** �?��/禁用 MCP 服务�?��注释/取消注释 [[mcp_servers]] 块） */
  handleTrusted<{ name: string; enabled: boolean }>("slime:extras:mcpToggle", async (_event, p) => {
    const res = setMcpEnabled(p.name, p.enabled);
    return res;
  });

  /** �?能库状�?�列�?���?��禁用的，供�?�技能库」专栏恢复） */
  handleTrusted<void>("slime:extras:skillList", async () => {
    await ensureServices();
    const { listSkills } = await import("./config_files.js");
    return listSkills();
  });

  /** �?��/禁用�?能（物理移动�?���?.disabled/ 下） */
  handleTrusted<{ name: string; enabled: boolean }>("slime:extras:skillToggle", async (_event, p) => {
    const res = setSkillEnabled(p.name, p.enabled);
    return res;
  });

  /** 打开�?能目录（系统文件管理�?�� */
  handleTrusted<{ name: string }>("slime:extras:skillOpen", async (_event, p) => {
    const dir = skillDirPath(p.name);
    if (!existsSync(dir)) {
      return { ok: false, error: `技能目录不存在：${dir}` };
    }
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || undefined };
  });

  /** 删除�?能（递归删除�?���?*/
  handleTrusted<{ name: string }>("slime:extras:skillDelete", async (_event, p) => {
    return deleteSkill(p.name);
  });

  /** 打开�?能根�?��（config/skills，系统文件�?理器）�?��?�空列表时引导用户把�?能放进来 */
  handleTrusted<void>("slime:extras:skillsRootOpen", async () => {
    const dir = resolve(PROJECT_ROOT, "config", "skills");
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (e) {
        return { ok: false, error: `�?能目录创建失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || undefined };
  });

  /** 打开 MCP 配置�?在目录（slime.toml �?在项�?���?*/
  handleTrusted<void>("slime:extras:mcpOpen", async () => {
    const root = PROJECT_ROOT;
    if (!existsSync(root)) {
      return { ok: false, error: `项目�?��不存�?��${root}` };
    }
    const err = await shell.openPath(root);
    return { ok: !err, error: err || undefined };
  });

  /** 删除 MCP 服务�?���?slime.toml 移除块） */
  handleTrusted<{ name: string }>("slime:extras:mcpDelete", async (_event, p) => {
    return deleteMcp(p.name);
  });

  /** A-918++：GUI 表单新�? MCP 服务�?��追加 [[mcp_servers]] 块，不再要求手动编辑 slime.toml�?*/
  handleTrusted<{ name: string; kind: "stdio" | "http"; command?: string; args?: string[]; url?: string; env?: Record<string, string> }>(
    "slime:extras:mcpAdd",
    async (_event, p) => {
      const { addMcp } = await import("./config_files.js");
      return addMcp(p);
    },
  );

  /** A-918++：GUI 表单新建�?能（生成 config/skills/<name>/SKILL.md�?*/
  handleTrusted<{ name: string; description: string; content?: string }>(
    "slime:extras:skillAdd",
    async (_event, p) => {
      const { addSkill } = await import("./config_files.js");
      return addSkill(p);
    },
  );

  /** A-918++：联网搜索技能市场（anthropics/skills 官方仓库�?*/
  handleTrusted<{ query?: string }>("slime:extras:skillMarketSearch", async (_event, p) => {
    const { searchSkillMarket } = await import("./config_files.js");
    return searchSkillMarket(p?.query ?? "");
  });

  /** A-918++：从官方仓库安�?�?能（下载 SKILL.md 写入 config/skills/�?*/
  handleTrusted<{ name: string }>("slime:extras:skillMarketInstall", async (_event, p) => {
    const { installSkillFromMarket } = await import("./config_files.js");
    return installSkillFromMarket(p?.name ?? "");
  });

  /** A-918++：�?取数�?��认证（GitHub Token，加密） */
  handleTrusted<void>("slime:extras:registryAuthGet", async () => {
    const { getRegistryAuth } = await import("./config_files.js");
    return getRegistryAuth();
  });

  /** A-918++：保存数�?��认证（GitHub Token，加密） */
  handleTrusted<{ githubToken?: string }>("slime:extras:registryAuthSet", async (_event, p) => {
    const { setRegistryAuth } = await import("./config_files.js");
    return setRegistryAuth({ githubToken: p?.githubToken });
  });

  /** A-918++：内�?BrowserWindow 打开 GitHub Token 生成页（利用 Electron Chromium 内核，用户应用内登录生成 token�?*/
  handleTrusted<void>("slime:extras:openGithubAuth", async () => {
    try {
      const win = new BrowserWindow({
        width: 920, height: 720, minWidth: 640, minHeight: 480,
        title: "GitHub 授权 �?登录后生�?Token 并�?制，回到 slime 粘贴保存",
        autoHideMenuBar: true,
        backgroundColor: "#0d1117",
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
      });
      void win.loadURL("https://github.com/settings/tokens/new?scopes=repo&description=slime-agent");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `打开授权窗口失败：${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /** A-918++：运行环境一览（node/python/git/llama/models 的路径·版�?�大小·就�?��态，�?RuntimePanel�?*/  handleTrusted<void>("slime:runtime:list", async (): Promise<{
    ok: boolean; items?: Array<{
      kind: string; label: string; path?: string; version?: string; sizeText?: string; ok: boolean; note?: string; source: string;
      action?: { label: string; kind: string; url?: string; path?: string; target?: string };
    }>; error?: string;
  }> => {
    const fmtBytes = (n: number): string => {
      if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
      if (n >= 1048576) return `${(n / 1048576).toFixed(0)} MB`;
      if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${n} B`;
    };
    const fileSize = (p: string): string | undefined => {
      try { if (!existsSync(p)) { return undefined; } return fmtBytes(statSync(p).size); } catch { return undefined; }
    };
    const items: Array<{ kind: string; label: string; path?: string; version?: string; sizeText?: string; ok: boolean; note?: string; source: string; action?: { label: string; kind: string; url?: string; path?: string; target?: string } }> = [];
    try {
      // Node（Electron 内嵌�?
      items.push({ kind: "node", label: "Node.js", version: `v${process.versions.node}`, ok: true, source: "bundled", note: "GUI �?Electron 内嵌 Node 驱动" });
      // Python venv（随包）—�??随包依赖，必须走 resolveBundled（开发模式在项目根，不在 gui/�?
      const pyExe = process.platform === "win32"
        ? resolveBundled("runtime/venv/Scripts/python.exe")
        : resolveBundled("runtime/venv/bin/python");
      const pyOk = existsSync(pyExe);
      items.push({ kind: "python", label: "Python（随包 venv）", path: pyExe, sizeText: fileSize(pyExe), ok: pyOk, source: pyOk ? "bundled" : "missing", ...(pyOk ? {} : { note: "缺少随包 venv——请重新运行 prepare-runtime 或重装" }) });
      // Git（系统）
      await new Promise<void>((resolveP) => {
        execFile("git", ["--version"], { timeout: 4000 }, (err, stdout) => {
          if (err || !stdout) {
            items.push({ kind: "git", label: "Git", ok: false, source: "missing", note: "未检测到 git——请安装 Git for Windows（https://git-scm.com）后重开" });
          } else {
            const ver = stdout.trim().replace(/^git version\s*/i, "");
            items.push({ kind: "git", label: "Git", version: ver, ok: true, source: "system" });
          }
          resolveP();
        });
      });
      // llama.cpp（随包二进制�?
      const llamaExe = process.platform === "win32"
        ? resolveBundled("llama.cpp/build/bin/llama-server.exe")
        : resolveBundled("llama.cpp/build/bin/llama-server");
      const llamaOk = existsSync(llamaExe);
      items.push({
        kind: "llama", label: "llama.cpp（本地推理）", path: llamaExe, sizeText: fileSize(llamaExe), ok: llamaOk,
        source: llamaOk ? "bundled" : "missing",
        ...(llamaOk ? {} : { note: "缺失—�?�重新运�?prepare-runtime 下载或到 设置→供应商→本地模�?配置" }),
      });
      // 模型�?��（随�?npz + 按需 GGUF�?
      const modelRoot = resolveBundled("models");
      const ggufFiles: Array<{ p: string; n: string }> = [];
      try {
        const scan = (dir: string, depth: number): void => {
          if (depth > 2 || !existsSync(dir)) { return; }
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, e.name);
            if (e.isDirectory()) { scan(full, depth + 1); }
            else if (e.name.endsWith(".gguf") || e.name.endsWith(".npz")) { ggufFiles.push({ p: full, n: e.name }); }
          }
        };
        scan(modelRoot, 0);
      } catch { /* 忽略 */ }
      if (ggufFiles.length > 0) {
        items.push({
          kind: "models", label: "�?��模型", path: modelRoot,
          version: `${ggufFiles.length} �?��件`, sizeText: ggufFiles[0] ? fileSize(ggufFiles[0].p) : undefined,
          ok: true, source: ggufFiles[0]?.n.includes("bge") ? "bundled" : "download",
          note: ggufFiles.map((f) => f.n).join("、").slice(0, 120),
        });
      } else {
        items.push({ kind: "models", label: "�?��模型", path: modelRoot, ok: false, source: "download", note: "暂无模型文件—�?��?次使用本地推理时�?��下载" });
      }
      // A-918++：ADB（Android 调试桥）—�??�?测安装情况（缺失给下载动作，就绪给启动服务动作）
      try {
        const ad = await adbService.detect();
        if (ad.ok) {
          items.push({ kind: "adb", label: "ADB（Android 调试桥）", path: ad.path, version: ad.version, ok: true, source: ad.source || "system", note: "已就绪——可连接模拟器/安卓设备；服务未启动时可点右侧按钮" });
        } else {
          items.push({ kind: "adb", label: "ADB（Android 调试桥）", ok: false, source: "missing", note: "未检测到 adb——下载 platform-tools 后即可连接安卓设备/模拟器" });
        }
      } catch { /* 忽略 */ }
      // 缺失项补动作：llama/bge 走内�?��载器；python 缺失走官网（要求用户�?Python 后重�?venv，避免打�?Python 解释�?���?
      // git 缺失走官网；action.kind = "download" �?renderer �?mind.download�?openExternal"/"openPath" �?slime:runtime:open
      for (const it of items) {
        if (it.ok) { continue; }
        if (it.kind === "llama") { it.action = { label: "下载 llama.cpp", kind: "download", target: "llama" }; }
        else if (it.kind === "models") { it.action = { label: "下载 BGE 模型", kind: "download", target: "bge" }; }
        else if (it.kind === "git") { it.action = { label: "下载 Git", kind: "openExternal", url: "https://git-scm.com/downloads" }; }
        // python 缺失：官网�? Python 后点"重建 venv"（vbox 真实�?��在项�?�� runtime/venv，不�?gui/runtime�?
        else if (it.kind === "python") { it.action = { label: "下载 Python（装后再重建）", kind: "openExternal", url: "https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe" }; }
      }
      // A-918++：ADB —�??缺失给�?�下�?platform-tools」，就绪给�?�启�?ADB 服务�?
      for (const it of items) {
        if (it.kind !== "adb") { continue; }
        if (!it.ok) { it.action = { label: "下载 platform-tools", kind: "adbDownload" }; }
        else { it.action = { label: "�?�� ADB 服务", kind: "adbStart" }; }
      }
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: `读取运行环境失败：${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /** A-918++：重�?Python venv（系�?Python �?BUNDLE_ROOT/runtime/venv �?pip install -r requirements.txt）�??
   *  �?spawn 系统 Python（PATH �?python.exe）�?�完成后 renderer �?load() 刷新�?*/
  handleTrusted<void>("slime:runtime:installPython", async (): Promise<{ ok: boolean; log?: string; error?: string }> => {
    const venvDir = resolveBundled("runtime/venv");
    const reqFile = resolveBundled("requirements.txt");
    /*
     * 这两行原先是 `resolveExtra("../runtime/venv")` 的字符串绕�? —�??注释�?��"gui/runtime/venv 错�?"�?
     * 它只�?*�?发模�?*蒙�?（`gui/../` 恰好�?���?��），打包模式�?`../` 会指到安装根�?*上一�?*�?
     * 于是"重建 venv"在�?式安装包里必然失败�?�改�?resolveBundled 后两�?��式同时�?�???
     */
    const isWin = process.platform === "win32";
    const venvPip = isWin ? join(venvDir, "Scripts", "pip.exe") : join(venvDir, "bin", "pip");
    const sysPy = isWin ? "python.exe" : "python3";
    const log: string[] = [];
    try {
      log.push(`创建 venv：${venvDir}`);
      await new Promise<void>((resolveP, rejectP) => {
        execFile(sysPy, ["-m", "venv", "--copies", venvDir], { timeout: 120_000 }, (err, stdout, stderr) => {
          log.push(stdout || ""); log.push(stderr || "");
          err ? rejectP(err) : resolveP();
        });
      });
      log.push(`pip install：${reqFile}`);
      await new Promise<void>((resolveP, rejectP) => {
        execFile(venvPip, ["install", "-r", reqFile], { timeout: 600_000 }, (err, stdout, stderr) => {
          log.push(stdout || ""); log.push(stderr || "");
          err ? rejectP(err) : resolveP();
        });
      });
      log.push("�?venv 重建完成");
      return { ok: true, log: log.join("\n").slice(-4000) };
    } catch (e) {
      log.push(`安装失败：${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, log: log.join("\n").slice(-4000), error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** A-918++：运行环境缺失项的动作（打开官网下载 / 打开�?���?���?*/
  handleTrusted<{ action?: { label?: string; kind?: string; url?: string; path?: string } }>(
    "slime:runtime:open",
    async (_event, p): Promise<{ ok: boolean; error?: string }> => {
      const a = p?.action;
      if (!a) { return { ok: false, error: "缺少动作参数" }; }
      try {
        if (a.kind === "openExternal" && a.url) {
          await shell.openExternal(a.url);
          return { ok: true };
        }
        if (a.kind === "openPath" && a.path) {
          const err = await shell.openPath(a.path);
          return err ? { ok: false, error: err } : { ok: true };
        }
        return { ok: false, error: "�?��动作" };
      } catch (e) {
        return { ok: false, error: `执行动作失败：${e instanceof Error ? e.message : String(e)}` };
      }
    },
  );

  /** A-918++：git show <ref>:<rel>（FileTab diff 模式对比 Git HEAD �?��rel 相�?仓库根） */
  handleTrusted<{ rel: string; workspace: string; ref?: string }>(
    "slime:git:showFile",
    async (_event, p): Promise<{ ok: boolean; content?: string; error?: string; code?: "not-repo" | "no-head" | "not-found" }> => {
      const rel = (p?.rel ?? "").trim();
      const ws = (p?.workspace ?? "").trim();
      const ref = p?.ref || "HEAD";
      if (!rel || !ws) { return { ok: false, error: "缺少参数" }; }
      /**
       * A-1029�?*先探测仓库，再�?�?*�?
       *
       * 原先直接�?`git show` �?stderr �?300 字回给界�?��于是�?Git 工作区（用户实测
       * `D:\试验场` 下没�?`.git`）会抛出原�?英文�?
       *   `fatal: not a git repository (or any of the parent directories): .git`
       * 用户看到这句�?��认为"功能坏了"，既不知�?*原因**（这�?��录本来就不是仓库），
       * 也不知道**还能怎么�?*（其实本次改动的 before/after 就内嵌在聊天区的工具卡里）�??
       *
       * 现有的三�??错分�?��exists on disk / did not match any file / unknown revision�?
       * 漏掉的�?�?��常�?的那�?类�?�故这里显式探测，并�?下一步去�?��"写进文�?�?
       */
      const inside = await runGit(["rev-parse", "--is-inside-work-tree"], ws);
      if (inside.code !== 0 || inside.stdout.trim() !== "true") {
        return {
          ok: false,
          code: "not-repo",
          error: `「${ws}」不在 Git 仓库内（该目录及其上层都找不到 .git），因此没有可对比的 Git 历史版本。` +
            `要查看本次改动的前后差异，请用聊天区「写入文件」工具卡里的「变更详情」（那份对比是随消息一起记录的，不依赖 Git）。`,
        };
      }
      const r = await runGit(["show", `${ref}:${rel}`], ws);
      if (r.code !== 0) {
        // 若文件在 HEAD 不存�?��新�?文件）→ 空内�?diff 全新�?
        if (/exists on disk, but not in|did not match any file|path .* unknown revision/i.test(r.stderr)) {
          return { ok: true, content: "" };
        }
        // A-1029：仓库存在但没有提交（空仓库）→ 同样给可读解释，而不�?���?porcelain 提示
        if (/does not have any commits yet|unknown revision or path not in the working tree/i.test(r.stderr)) {
          return {
            ok: false,
            code: "no-head",
            error: `「${ws}」是 Git 仓库但还没有任何提交，没有可对比的 HEAD 版本。先提交一次再对比。`,
          };
        }
        return { ok: false, error: r.stderr.slice(0, 300) || `git show 失败（${r.code}）` };
      }
      return { ok: true, content: r.stdout };
    },
  );

  /* ══════════════�?ADB 设�?管理（A-918++�?══════════════�?*/
  /** 注入 AdbService �?core-ts 工具层（对齐 setSubagentManager 注入模式�?*/
  setAdbService(adbService);

  /* ══════════════�?删除进回收站（A-1072 / #231 收口�?══════════════�?*/
  /** core-ts 不�? import electron，所�?`file_delete` 的回收站能力由主进程注入（同 setAdbService 模式）�??
   *  ⚠️ 不注入的后果�?*静默�?�?*：`trashServiceRef` �?null �?`file_delete` 每�?都走「永久删�?+ 回执
   *     如实标注�?��回收站�?��?�工�?能用"、测试全绿�?�用户却在不�?��原地丢文�?—�??�?以这条注入必须落地�??*/
  setTrashService({
    trash: async (absPath: string) => {
      try {
        await shell.trashItem(absPath);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  /* ══════════════�?HTTP 静�?�服务搭建（A-918++�?══════════════�?*/
  /** 注入 HttpStaticServer �?core-ts 工具层（对齐 setAdbService 注入模式�?*/
  setHttpServer(httpServer);
  /** A-977：静态服务清单持久化—�?��?�?userData，启动时按�?录�?口重建（重启后旧链接仍可�?���?*/
  try {
    const persistPath = join(app.getPath("userData"), "http_servers.json");
    httpServer.setPersistPath(persistPath);
    void httpServer.restore().then((r) => {
      if (r.restored > 0 || r.failed > 0) {
        console.log(`[slime] HTTP 静态服务恢复：成功 ${r.restored}，失败 ${r.failed}`);
      }
    }).catch(() => { /* 恢�?失败不影响启�?*/ });
  } catch { /* userData 不可用时�?化为不持久化 */ }

  /** A-918++ / A-1121（②）：右栏打开器的装配点�??
   *  opener �?**payload �?*（`{kind:"url"|"terminal"|"files"}`），字�?串入参仍�?url 处理
   *  �?任何�?��步更新的调用点都不会静默失效；归�?�?core-ts 的纯函数（判�?��有一份）�?
   *  ⚠️ 归一返回 null = **这�?请求不成�?*（�? url 为空）→ 主进程不发事件，
   *     由调用方（工具）在回执里如实说明"没打�?"（`fireSidebarOpen` 返回 false）�??*/
  setSidebarOpener((req, name): void => {
    const payload = normalizeSidebarOpenRequest(req, name);
    if (!payload) { return; }
    mainWindow?.webContents.send("slime:sidebar:open", payload);
  });

  /** A-1144：右栏�?�挂载�?�上报（渲染�?�?主进程，方向与上面那条相反）�?
   *  收下后按 `sessionId` 存住，`ChatService` 每轮把它拼进系统提示
   *  （依�?MCP Apps 的两条硬原则：界�?��给用户看的东西必须同时�?模型�??、用户交互�?回�?�上下文）�??
   *  ⚠️ 这里**�?��不做判据**：�?�哪�?类页签�?�得挂载」的�?��判据在渲染层
   *     （`describeSidebarSnapshot`），在这里再写一份就�??二个产地（必然与界面漂）�?
   *  ⚠️ 空载�?= **清空**（右栏空了就撤下），否则模型会一直拿�?�?份过期的右栏�?*/
  ipcMain.on("slime:sidebar:mount", (_e, payload: { sessionId?: string; text?: string } | null) => {
    setSidebarMount(payload && payload.sessionId
      ? { sessionId: String(payload.sessionId), text: String(payload.text ?? "") }
      : null);
  });

  /* ══════════════�?图形控制能力（screen_*）：slime 全程序级 ══════════════�?*/
  /** �?�?��瘦身钩子：electron.nativeImage 缩放 + PNG→JPEG（防原图吃掉巨量 token），
   *     并叠�?*刻度网格 + 元素编号�?*标注（A-975：�?模型有刻度可读�?�有编号�?��）�??*/
  setImageOptimizer((pngBase64: string, maxWidth: number, quality: number, annotate?: { grid?: boolean; marks?: Array<{ index: number; label?: string; x1: number; y1: number; x2: number; y2: number }>; marksSpace?: { width: number; height: number } }) => {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
      if (img.isEmpty()) { return null; }
      const size = img.getSize();
      const out = maxWidth > 0 && size.width > maxWidth
        ? img.resize({ width: maxWidth, quality: "good" })
        : img;
      let finalImg = out;
      // A-975：在缩放后的位图上叠加标�?��BGRA 逐像素绘制，零新依赖�?
      if (annotate && (annotate.grid || (annotate.marks && annotate.marks.length > 0))) {
        try {
          const fs = out.getSize();
          const bmp = out.toBitmap();
          annotateBitmap(
            { buf: bmp, width: fs.width, height: fs.height },
            { grid: annotate.grid, marks: annotate.marks, marksSpace: annotate.marksSpace },
          );
          finalImg = nativeImage.createFromBitmap(bmp, { width: fs.width, height: fs.height });
        } catch { /* 标注失败 �?用无标注图（不阻�?��图） */ }
      }
      const jpg = finalImg.toJPEG(quality);
      if (!jpg || jpg.length === 0) { return null; }
      const finalSize = finalImg.getSize();
      return {
        dataUrl: `data:image/jpeg;base64,${jpg.toString("base64")}`,
        width: finalSize.width,
        height: finalSize.height,
        bytes: jpg.length,
      };
    } catch {
      return null; // 优化失败 �?上层回�??�?PNG
    }
  });

  /** ①�??A-1123�?*画面�?��度量** —�??命中校验的判�?��源（nativeImage 逐像素比，零新依赖）�?
   *
   * 为什么需要：动作回执里的 detail �?��述�?�输入已注入」（"已在 (x,y) 左键单击"），
   * 而点�?/ �?���?���?/ 窗口没聚�?/ 元素还没渲染 —�??四�?情形与成�?*逐字同形**�?
   * controller 现在会在动作前后各取�?张图，用这里算出的差异率判定"画面有没有可见变�?�?
   * �?���?��会自动重试一次�?�core-ts 不�? import electron，所以这里与 setImageOptimizer 同�?注入�?
   *
   * 判据�?��（三态，缺一不可）：
   *  · 尺�?不一�?�?返回 **1**（画面整体变了，显然�?有变�?），**不是** null�?
   *  · 解码失败 / 空图 / 长度对不�?�?返回 **null**�? **没有判据**，controller 会�?实�?
   *    "�?���?并且**不重�?* —�??�?没判�?�?�?���?会把�?次其实成功的点击再点�?遍）�?
   *  · 逐像素带颜色容差（BGRA 三�?�道曼哈顿距�?> 24 才算变），避免抗�?��与亚像素渲染
   *    �?画面没变"读成"变了"（那会�?校验彻底失效 —�??永远报命�?���?
   */
  setImageDiffer((pngA: string, pngB: string): number | null => {
    try {
      const ia = nativeImage.createFromBuffer(Buffer.from(pngA, "base64"));
      const ib = nativeImage.createFromBuffer(Buffer.from(pngB, "base64"));
      if (ia.isEmpty() || ib.isEmpty()) { return null; }
      const sa = ia.getSize();
      const sb = ib.getSize();
      if (sa.width !== sb.width || sa.height !== sb.height) { return 1; }
      const ba = ia.toBitmap();
      const bb = ib.toBitmap();
      if (ba.length !== bb.length || ba.length === 0) { return null; }
      let changed = 0;
      for (let i = 0; i + 3 < ba.length; i += 4) {
        const d = Math.abs(ba[i] - bb[i]) + Math.abs(ba[i + 1] - bb[i + 1]) + Math.abs(ba[i + 2] - bb[i + 2]);
        if (d > 24) { changed += 1; }
      }
      const pixels = ba.length / 4;
      return pixels > 0 ? changed / pixels : null;
    } catch { return null; }
  });

  /** �?注册图形控制后�?：�?�?��Windows PowerShell+user32.dll 常驻宿主）与 Android（adb shell input）�??
   *     两后�?��用同�?套动作�?义与归一化坐�?�?这就�??�属�?slime 整个程序的图形控制能力�?�，不限 ADB�?*/
  const screenCtl = getScreenController();
  /* A-1069�?226）：**留住桌面后�?的引�?* —�??它的常驻 PowerShell 宿主�??�Agent �?��的后台进程�??
     面板里的�?��类条�?��而停止按�??调它�?`dispose()`。�?前是 `register(new DesktopScreenBackend())`
     的匿名写法，外面拿不到实例（于是"能看到�?�停不掉"）�??*/
  const desktopBackend = new DesktopScreenBackend();
  screenCtl.register(desktopBackend);
  screenCtl.register(new AndroidScreenBackend(adbService));
  setScreenController(screenCtl);

  /** A-1044：图形动作的「开�?/ 结束」转发给渲染�?�?呼吸�?���?+ �?��提示�?
   *  订阅点�?�在 controller：它�?��有图形动作的�?��咽喉（串行链 + 坐标换算 + 能力校验都在那）�?
   *  �?处�?阅即覆盖「操作我的主机�?�（desktop）与「操作安卓�?备�?�（android）两条路径�??
   *  fire-and-forget：窗口未就绪／渲染层没�?�??化时静默降级，绝不影响动作本�?
   *  （`emitFocus` 内已吞异常，这里再兜�?层是因为 webContents.send �?��撞上窗口�?毁中）�??*/
  screenCtl.onOperationFocus = (e): void => {
    try { mainWindow?.webContents.send("slime:screen:opFocus", e); } catch { /* 无窗�?�?无可视化 */ }
  };

  /** A-976：右侧栏浏�?器控制桥 —�??Agent �?browser_* 工具经它把指令下发到 renderer �?<webview> 执�?�?
   *  �?screen_* 并列�?�?��块操控面"：ADB/桌面�?��幕级，这里是应用内嵌浏�?器级�?*/
  setBrowserAdapter(new BrowserBridge(() => mainWindow));

  /** �?工具类别闸门 + �??则闸�?—�??每�?调用实时读取配置，改设置后无�?重启引擎�?
   *
   *  【两层职责，顺序不可�???
   *  �?1 层�?�类�?��决�?�：�?关关�?= 该类工具直接拒绝，模型无法绕过（原有�?��，判�?��变）�?
   *  �?2 层�?�硬规则拦截」：越权�?�� / 敏感文件 / 受保护源码目�?/ 终�?黑名�?/ 内网地址�?
   *      这一层以�?*�?��在�?批回调里**，�?�回调仅在沙箱决定�?�?��户时才执行；
   *      于是 `�?�� / 无需` 档（sandbox 直接放�?）会把安全边界一起免�?—�??
   *      Agent 能写�?��的护栏目录�?�能�?`rm -rf /`，全程无人过�???
   *      挂到闸门后：**任何审批档位下，�??则都逐调用生�?*�?
   *
   *  注意两层都不�?放�?"：放行（免�?��?审批）由审批回调按开关判�?+ 沙�?档位完成�?
   *  �?`classifyPermissions`。这�?该给就给"�?边界不松"�?��件独立的事�??*/
  setToolCategoryGate((tool, args) => gateToolCall({
    tool,
    riskKind: tool.effectiveRiskKind(),
    // �?��取�?�口径与沙�?/分类器共用同�?实现（含终�?类的 command/cmd 字�?�?
    target: targetFromArgs(args),
    switches: permSwitches(getPermissions()),
  }));

  /** A-918++：HTTP —�??把本地目录作为静态服务启�?��默�? 0.0.0.0，�?口自动�?�） */
  handleTrusted<{ dir: string; port?: number; host?: string; spa?: boolean }>("slime:http:serve", async (_event, p): Promise<{ ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string }> => {
    const r = await httpServer.serve({ dir: p?.dir ?? "", port: p?.port, host: p?.host, spa: p?.spa });
    // A-1069：新起的服务要立刻出现在「后台进程�?�面板里（不等下�?次开面板�?
    if (r?.ok) { broadcastAgentProcs(); }
    return r;
  });

  /** A-918++：HTTP —�??停�?指定服务 */
  handleTrusted<{ id: string }>("slime:http:stop", async (_event, p): Promise<{ ok: boolean; error?: string }> => {
    const r = await httpServer.stop(p?.id ?? "");
    if (r?.ok) { broadcastAgentProcs(); }
    return r;
  });

  /** A-918++：HTTP —�??停�?全部服务 */
  handleTrusted<void>("slime:http:stopAll", async (): Promise<{ ok: boolean; stopped: number }> => {
    const r = await httpServer.stopAll();
    broadcastAgentProcs();
    return r;
  });

  /** A-918++：HTTP —�??列出运�?�?��服务 */
  handleTrusted<void>("slime:http:list", async (): Promise<Array<{ id: string; dir: string; port: number; host: string; urls: string[]; startedAt: number; requests: number }>> => {
    return httpServer.list();
  });

  /* ══════════════ A-1137：搜索页宿主�?══════════════
   *
   * 用户�?��了一�?��文件搜索引擎，�?求�?�以后点击新建浏览器页就直接�?���???
   * 「左侧浏览器搜索后，对应的�?话栏能实时监测到右侧边栏打开的内容�?��??
   *
   * ⚠️ 实测结�?（`gui/scripts/probe-search-host.mjs`�?2/12）：右栏浏�?器页�?`<webview>`
   *   （独立顶�?frame）⇒ 页面里的 `window.parent === window` �?它原设�?�?
   *   `postMessage` 通道**�?���?���?��发的消息**，�?主永远收不到�?
   *   �?接入必须�?guest preload + `contextBridge` + IPC（`gui/src/preload/searchHost.cjs`）�??
   *
   * ⚠️ 这一�?*不走 `handleTrusted`**：sender �?guest，不�?��窗口。白名单�?
   *   `searchBridge.ts::isTrustedSearchUrl()`（只认我�?��的搜索页 origin / file: / about:blank）�??
   *
   * 搜索页的交付形�?�：构建�?`?raw` 把页面�?文内联进主进程产�?�?运�?时幂等落盘到
   * `userData/slime-search/page` �?**复用既有�?`slime:http:serve`** 起本地服务（带同�?��复用）�??
   * 这样"搜索页�?�么给到右栏"�?���?处实现，且不依赖源码�?��（安装�??`PROJECT_ROOT` �?��户数�?��录）�?
   *
   * ⚠️ 这是 **slime �?��功能托�?的页�?*，`serve` 必须显式�?`origin: "builtin"`�?
   *   早先没传 �?缺省落成 `"agent"` �?搜索页�?当成「Agent �?��的后台资源�?�挂在面板上
   *   （用户实测截图：127.0.0.1:8081 · slime-search\page · 监听�?��。用户明�??求它�??当成后台进程�?*/
  const searchBridgeDeps = {
    // 主程序主题存的是 alpha/beta，搜索页懂的�?dark/light/auto �?翻译�?���?处（shared/searchTheme.ts�?
    getTheme: (): string => searchThemeOf(readPersistedTheme()),
    getWindow: (): Electron.BrowserWindow | null => mainWindow,
    // 「是不是主窗口发来的」只有一处定义（就是上面那个 isTrustedSender），不在这里再抄�?�?
    isMainSender: (sender: Electron.WebContents): boolean => isTrustedSender(sender),
    serve: (opts: { dir: string; port?: number; host?: string; spa?: boolean; origin?: "agent" | "restored" | "builtin" }) => httpServer.serve(opts),
  };
  registerSearchBridge(searchBridgeDeps);
  // 预热：把页面先落�?+ 把本地服务先起来，这样用户�?�点新建浏�?器页」时不必等那�?次往返�??
  // ⚠️ 失败**不影响启�?*（真正需要时 `hostInfo` 会再试一次并把错�??实交给渲染层）�??
  void ensureSearchPage(searchBridgeDeps).catch(() => { /* 见上 */ });

  /* ══════════════ A-1138：自建全网索引服务（**已写�?slime**，不�?spawn Python）═══════════�?
   *
   * 用户原话：�?�你直接把这些进程写�?slime，�?�非接线」�?��?�爬�?/ 索引 / 服务现在都在�?��程内
   * （引擎在 `core-ts/src/websearch/`），�?�?��停�?�状态可见�?�崩溃有归因�?
   * 对搜索页**零改�?*：仍监听 `127.0.0.1:8600`，路由与回包形状逐字对齐�?`server.py`�?
   *
   * ⚠️ �?��失败**不影响启�?*（�?口�?�?��占了 / userData 不可写）�?
   *   �?��搜索页少�?块�?�自建索�?· 补充命中」，内核�?索照常工作；
   *   但状态里要留 `error`，�?设置页能如实显示 —�??这类失败静默掉就永远查不到�??*/
  registerSearchIndexIpc({
    userData: app.getPath("userData"),
    isMainSender: (sender: Electron.WebContents): boolean => isTrustedSender(sender),
  });
  void startSearchIndexService({ userData: app.getPath("userData") })
    .then((r) => {
      if (!r.ok) { console.warn("[gui:search-index] �?��索引服务�?���?��" + String(r.error)); }
      else { console.info("[gui:search-index] 搜索索引服务已就绪（127.0.0.1:" + String(r.port) + "）"); }
    })
    .catch(() => { /* 见上：不影响�?�� */ });

  /* ══════════════ A-1069�?226）：Agent �?��的后台资源面�?══════════════
   *
   * 用户原话：�?��?�?Agent 停下时的后台进程做一�??��?�在输入栏上方的按钮，点击后�?��展开」，
   * 且明�?��定范�?**�?Agent �?��的进�?*�?
   *
   * ⚠️ 范围收窄（用�?2026-09-26）：「为�?么这�?��台任务监视的�?��代理？不符合要求�?
   *   **�?���?Agent 运�?的脚�??��?�?*」⇒ �?��板只�?`screen-host`（Agent 起的常驻脚本宿主�?
   *   �?`http-server`（Agent 起的监听�?���?*两类**�?*后台子代理已从本面板移出** —�??
   *   它是"�?�?Agent"，有�?��的坞（`SubAgentExpandButton`）与详情弹窗�?
   *   在两�?��方都列等于同�?件事两个产地。判�?�� `agentProcs.ts`，守�?��住它�?
   *
   * ⚠️ 这一组是**取数 + 执�?**，不�?��何判�?��
   *   · 取什么？两类真源（图形控制常驻�?�?/ http_serve 的服务）�?
   *     **应用�?��服务不取** —�??Python 后�?、llama-server、MCP、情感脑 sidecar 都由应用
   *     生命周期管理，不�?Agent 的工具起的；把它�?��进这�?��板，用户会以�?关掉�?��停个任务"�?
   *     实际�?��应用拆了。这条范围决策在 `isAgentStartedKind()` 里落成可�?���?��住的事实�?
   *   · 怎么显示？`buildAgentProcView()` —�??�?��数，**每�?现算**而不�?��护注册表�?
   *     注册表有�?整类"某出口忘了注�? �?阴魂条目永驻"的结构�?��?险（�?��已为此付过代价）�?
   *     现算从结构上消除它（真源里没有了，面板里就没有了）�??
   *   · 能不能停？`planAgentProcStop()` —�??�?��类别/�?id �?�?*拒绝并给原因**�?
   *     不�?静默�?么都不做（界面若乐�?划掉，就与真实状态分家了）�??*/

  /** 从活真源取当前的后台资源�?�� */
  async function collectAgentProcSources(): Promise<AgentProcSources> {
    const servers = await httpServer.list().catch(() => []);
    return {
      screenHost: desktopBackend.residentHost?.() ?? null,
      httpServers: servers.map((s) => ({
        id: s.id, port: s.port, host: s.host, dir: s.dir, startedAt: s.startedAt, requests: s.requests,
        /* #230：把"谁起�?如实带上�?—�??�??图据此把「启动时重建的�?�排除在面板之�?
           （用户�?求只显示 Agent 运�?途中打开的�?口）�?*/
        origin: s.origin,
      })),
    };
  }

  /** 广播：后台资源集合变�?�?渲染层立刻刷新（不靠�??�?*/
  function broadcastAgentProcs(): void {
    try { mainWindow?.webContents.send("slime:agentprocs:changed", {}); } catch { /* 无窗�?�?忽略 */ }
  }

  handleTrusted<void>("slime:agentprocs:list", async (): Promise<AgentProcsListResult> => {
    try {
      const view = buildAgentProcView(await collectAgentProcSources(), Date.now());
      return { ok: true, view };
    } catch (e) {
      /* ⚠️ 失败必须�?�?分开：空列表的含义是"没有后台资源"�?
         查�?失败却给空列表会让用户以为没东西在跑（这�?��仓反复强调的静默失败）�??*/
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  handleTrusted<AgentProcsStopRequest>("slime:agentprocs:stop", async (_event, p): Promise<AgentProcsStopResult> => {
    const plan = planAgentProcStop({ kind: p?.kind ?? "", id: p?.id });
    if (!plan.ok) { return { ok: false, error: plan.reason }; }
    try {
      switch (plan.action) {
        case "dispose-screen-host":
          desktopBackend.dispose?.();
          break;
        case "stop-http-server": {
          const r = await httpServer.stop(plan.id);
          if (!r?.ok) { return { ok: false, error: r?.error ?? `停�?服务 ${plan.id} 失败（未知原因）` }; }
          break;
        }
        default:
          /* 结构上不�?��（纯判据�?��出上�?��种动作）。留这个出口�?���?�?��加了新类�?��忘了
             在这里接�?不会变成**静默�?么都不做** —�??那�?�?��仓反复强调的那类失效�?*/
          return { ok: false, error: `暂不�?��停�?该类�?��${String((plan as { action?: string }).action ?? "")}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    /* 停完**立刻**把新视图回给调用方：界面�??重画，�?�不�?��己猜�?��没了�?
       再广�?��次给其它窗口�?*/
    const view = buildAgentProcView(await collectAgentProcSources(), Date.now()).entries;
    broadcastAgentProcs();
    return { ok: true, detail: `已停�?���?${view.length} 项）` };
  });

  /* ══════════════�?图形控制能力（screen_*）：GUI 面板与紧急停�?══════════════�?*/

  /** 列出�?��图形控制后�?与目标（渲染层�?�图形控制�?�卡片展示） */
  handleTrusted<void>("slime:screen:info", async (): Promise<{
    enabled: boolean;
    halted: boolean;
    backends: string[];
    targets: Array<{ backend: string; target: string; width: number; height: number; label: string }>;
  }> => {
    const enabled = getPermissions().screenEnabled;
    const ctl = getScreenController();
    const backends = ctl.listBackends();
    let targets: Array<{ backend: string; target: string; width: number; height: number; label: string }> = [];
    // A-1123：`listTargetsReport` �?��**不抛**（每�?���?��失败已�?归集�?failures），
    // 这里�?�� targets；失败原因由工具�?`screen_info` 逐条展示（面板不做二次加工）�?
    targets = (await ctl.listTargetsReport()).targets;
    return { enabled, halted: ctl.isHalted(), backends, targets };
  });

  /** 紧�?�停�?���?��后续�?有图形动作（用户�?GUI 上一�?��车） */
  handleTrusted<void>("slime:screen:halt", async (): Promise<{ ok: boolean }> => {
    getScreenController().halt();
    return { ok: true };
  });

  /** 恢�?图形控制（新�?�?��务开始） */
  handleTrusted<void>("slime:screen:resume", async (): Promise<{ ok: boolean }> => {
    getScreenController().resume();
    return { ok: true };
  });

  /** �?��（GUI 手动预�?�?��工具侧走 screen_capture 工具�?*/
  handleTrusted<{ backend?: string; target?: string }>("slime:screen:capture", async (_event, p): Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }> => {
    const backend = p?.backend === "android" ? "android" : "desktop";
    const r = await getScreenController().capture(backend, p?.target || undefined);
    return { ok: r.ok, dataUrl: r.dataUrl, width: r.width, height: r.height, error: r.error };
  });

  /** A-918++：HTTP —�??用系统默认浏览器打开某个访问地址�?
   *  A-980-R3：加协�?安全门�?��?�web 链接直接�?；非 web（bitbrowser:// 等）�?openExternalSafe
   *  （探测�?理器，已注册才开；未注册返回诊断�?*绝不**直接 openExternal 触发系统报错框）�?*/
  handleTrusted<{ url: string }>("slime:http:open", async (_event, p): Promise<{ ok: boolean; error?: string }> => {
    const url = (p?.url ?? "").trim();
    if (!url) { return { ok: false, error: "url 不能为空" }; }
    try {
      if (isWebSafeUrl(url)) {
        await shell.openExternal(url);
        return { ok: true };
      }
      const r = await openExternalSafe(url);
      if (r.ok) { return { ok: true }; }
      // A-980-R4：浏览器唤起类协�?�?明确告知已拦�?��不�?求�?客户�?��
      if (r.reason === "browser-scheme") {
        return { ok: false, error: `已拦�?��览器唤起链接 ${(url.split(":")[0] || "").toLowerCase()}:// —�?�不唤醒外部浏�?器` };
      }
      return { ok: false, error: `链接 ${(url.split(":")[0] || "").toLowerCase()}:// �?要安装�?应�?户�?才能打开（系统未注册该协�?��` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });


  /** A-918++：ADB —�??�?�?adb �?��就绪（含版本/来源�?*/
  handleTrusted<void>("slime:adb:detect", async (): Promise<AdbDetect> => {
    return adbService.detect();
  });

  /** A-918++：ADB —�??下载官方 platform-tools 便携包（进度�?webContents 推渲染层�?*/
  handleTrusted<void>("slime:adb:download", async (): Promise<AdbCmdResult & { progress?: AdbDownloadProgress }> => {
    return adbService.downloadPlatformTools((p) => {
      mainWindow?.webContents.send("slime:adb:downloadProgress", p);
    });
  });

  /** A-918++：ADB —�??列出已连接�?�?*/
  handleTrusted<void>("slime:adb:devices", async (): Promise<{ ok: boolean; devices?: AdbDevice[]; error?: string }> => {
    return adbService.devices();
  });

  /** A-918++：ADB —�??无线连接设�?（host 形�? 192.168.1.10:5555�?*/
  handleTrusted<{ host: string }>("slime:adb:connect", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.connect(p?.host ?? "");
  });

  /** A-918++：ADB —�??�?��无线连接 */
  handleTrusted<{ host: string }>("slime:adb:disconnect", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.disconnect(p?.host ?? "");
  });

  /** A-918++：ADB —�??在指定�?备执�?shell 命令 */
  handleTrusted<{ serial: string; command: string }>("slime:adb:shell", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.shell(p?.serial ?? "", p?.command ?? "");
  });

  /** A-918++：ADB —�??安�? APK（serial + �?�� apk �?���?*/
  handleTrusted<{ serial: string; apkPath: string }>("slime:adb:install", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.install(p?.serial ?? "", p?.apkPath ?? "");
  });

  /** A-918++：ADB —�??卸载应用（serial + 包名�?*/
  handleTrusted<{ serial: string; pkg: string }>("slime:adb:uninstall", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.uninstall(p?.serial ?? "", p?.pkg ?? "");
  });

  /** A-918++：ADB —�??�?��（返�?PNG base64�?*/
  handleTrusted<{ serial: string }>("slime:adb:screencap", async (_event, p): Promise<AdbScreencapResult> => {
    return adbService.screencap(p?.serial ?? "");
  });

  /** A-918++：ADB —�??从�?备拉取文件到�?�� */
  handleTrusted<{ serial: string; remote: string; local: string }>("slime:adb:pull", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.pull(p?.serial ?? "", p?.remote ?? "", p?.local ?? "");
  });

  /** A-918++：ADB —�??推�?�本地文件到设�? */
  handleTrusted<{ serial: string; local: string; remote: string }>("slime:adb:push", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.push(p?.serial ?? "", p?.local ?? "", p?.remote ?? "");
  });

  /** A-918++：ADB —�??重启设�? */
  handleTrusted<{ serial: string }>("slime:adb:reboot", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.reboot(p?.serial ?? "");
  });

  /** A-918++：ADB —�??�?��服务（连模拟器前�?在跑�? 停�?服务 */
  handleTrusted<void>("slime:adb:startServer", async () => {
    return adbService.startServer();
  });
  handleTrusted<void>("slime:adb:killServer", async () => {
    return adbService.killServer();
  });

  /** A-918++：MCP 官方 registry 联网搜索（registry.modelcontextprotocol.io�?*/
  handleTrusted<{ query?: string }>("slime:mcpRegistrySearch", async (_event, p) => {
    const { searchMcpRegistry } = await import("./config_files.js");
    return searchMcpRegistry(p?.query ?? "");
  });

  /** A-918++：从官方 registry 安�? MCP（写 slime.toml�?*/
  handleTrusted<{ card: import("./config_files.js").RegistryServerCard }>("slime:mcpRegistryInstall", async (_event, p) => {
    const { installFromMcpRegistry } = await import("./config_files.js");
    return installFromMcpRegistry(p?.card);
  });

  /** 导入文件（�?话�?）：返回�?���?��，供聊天输入区引用为附件 */
  handleTrusted<void>("slime:files:pick", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const openOpts: Electron.OpenDialogOptions = {
      title: "选择要加入�?话的文件（图�?/ 文档等）",
      properties: ["openFile"],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消�?�择" }; }
    return { ok: true, path: open.filePaths[0] };
  });

  /** 识图：�?�择图片（�?选，�?�?4 张）�?主进程编码为 data URL（图片内容不落盘、不�?IPC 放大�?*/
  handleTrusted<void>("slime:images:pick", async (): Promise<{
    ok: boolean;
    images?: Array<{ name: string; mime: string; dataUrl: string }>;
    error?: string;
  }> => {
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const openOpts: Electron.OpenDialogOptions = {
      title: "选择图片发送给模型识别（可多选，最多 4 张，单张 ≤ 8MB）",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
      ],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消�?�择" }; }
    const MIME: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    };
    const images: Array<{ name: string; mime: string; dataUrl: string }> = [];
    const rejected: string[] = [];
    for (const p of open.filePaths.slice(0, 4)) {
      try {
        const st = statSync(p);
        if (st.size > MAX_IMAGE_BYTES) {
          rejected.push(`${(p.split(/[\\/]/).pop() ?? p)}（${(st.size / 1024 / 1024).toFixed(1)}MB，超 8MB）`);
          continue;
        }
        const ext = "." + p.split(".").pop()!.toLowerCase();
        const mime = MIME[ext] ?? "image/png";
        const buf = readFileSync(p);
        images.push({
          name: p.split(/[\\/]/).pop() ?? p,
          mime,
          dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
        });
      } catch (e) {
        rejected.push((p.split(/[\\/]/).pop() ?? p));
      }
    }
    if (images.length === 0) {
      return { ok: false, error: `图片读取失败${rejected.length ? `：${rejected.join("、")}` : ""}` };
    }
    return {
      ok: true,
      images,
      ...(rejected.length ? { error: `已跳过 ${rejected.join("、")}` } : {}),
    };
  });

  /** 输入联想：�?索历史会话中相似的用户消�?*/
  handleTrusted<{ text: string }>("slime:chat:suggest", async (_event, payload) => {
    await ensureServices();
    const text = (payload.text ?? "").trim();
    if (!text) {
      return [];
    }
    const records = await loadHistory(null, 1000);
    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));
    const hits = records
      .filter((r) => r.user && r.user.includes(text) && r.user !== text)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, 6)
      .map((r) => ({
        content: r.user.slice(0, 140),
        agentName: names.get(r.agent_id) ?? r.agent_id,
        time: r.timestamp,
      }));
    return hits;
  });

  handleTrusted<void>("slime:stats:snapshot", async () => {
    await ensureServices();
    return (await statsService!.snapshot()) as unknown as StatsSnapshot;
  });

  // �?�? 使用统�?（Settings「使用统计�?�面板） �?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
  handleTrusted<{ sinceIso?: string; untilIso?: string; limit?: number }>("slime:usage:snapshot", async (_e, payload) => {
    // �?��时区偏移（分钟；东八�?+480）�?��??�?Date.getTimezoneOffset 的反�?
    const tzOffsetMin = -new Date().getTimezoneOffset();
    const records = await loadUsage({
      sinceIso: payload?.sinceIso,
      untilIso: payload?.untilIso,
      limit: payload?.limit ?? 5000,
    });
    /*
     * A-990-B：把"用户手�?�的计价币�?"与账�?��起下发（�?UsageSnapshot.modelCurrencies 注释）�??
     * �?���?*用户真的手�?�过**的条�?���?��选的留空，渲染层会按模型归属地推�???
     * �?�� `供应商key::模型id`：同�?�?���?id 在不同中�?���?���?��笔不同的�?
     * （价�?币�?都可能不同），只�?model 归并会�?两�?显示成同�?�?��种�??
     */
    const modelCurrencies: Record<string, string> = {};
    for (const p of listProviders()) {
      for (const mo of (p.models ?? [])) {
        if (mo.price_currency) { modelCurrencies[`${p.key}::${mo.id}`] = mo.price_currency; }
      }
    }
    return {
      records,
      tzOffsetMin,
      totalRecords: records.length,
      modelCurrencies,
    } as unknown as UsageSnapshot;
  });

  handleTrusted<void>("slime:usage:clear", async () => {
    await clearUsage();
    return { ok: true };
  });

  // �?*当前生效价格**重算历史成本：usage.jsonl �?cost_usd �?��入时固化的，
  // 之前价格表全线失守�?�?1606 条�?�?100% �?0；价格表�??后需要一次�?�回�???
  // �?��"0 �?有价"的�?录改写（�??不减），免费模型（价�?��显式 0）保�?0 不产�?diff�?
  handleTrusted<void>("slime:usage:recompute", async () => {
    await ensureServices();
    const res = await rewriteUsageCosts(buildPriceResolver());
    return { ok: true, ...res } as UsageRecomputeResult;
  });

  // �?�? D/E：可观测 trace + Plan �?等�?�?IPC �?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
  registerTraceHandlers();
  registerPlanHandlers();

  // �?�? 心智�?�� IPC �?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?

  /** 配置读取：向量工�?/ 记忆位置 / 依赖状�?�（模型文件不在 git 仓库，换设�?�?手动就位�?*/
  handleTrusted<{ agentId?: string } | undefined>("slime:mind:configGet", async (_event, payload) => {
    // 收尾归位：downloads/ 下已完成的文件自动放到配�?��径（�?llama_bin �?��改写�?
    // A-1038：tryRelocateDownloads 改为 async（内部解压走 async �?��）→ 必须 await�?
    // 否则这个 IPC 会在解压还没跑完时就返回，紧接着读到的依赖状态仍�?缺失"�?
    try {
      await tryRelocateDownloads();
    } catch (e) {
      console.warn(`[gui:mind] 归位收尾异常: ${e}`);
    }
    const cfg = loadMindConfig();
    // 记忆存储位置：按�?�� Agent 推�?**真实绝�?�?��**（唯�?实现 resolveMemoryPaths）�??
    // 此前返回的是字�?串模�?`data/<agentId>/lancedb`（字�?`<agentId>`）�?��??�?���?���?���?
    // 也永不随"存储位置"变化，于�?��面出�?改了根目录只�?memory.json 那�?�?的�?感�??
    const agentId = typeof payload?.agentId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(payload.agentId)
      ? payload.agentId
      : null;
    return {
      vectorTool: cfg.vectorTool,
      memoryRoot: cfg.memoryRoot,
      // A-1041：组件就位状态随配置�?起回�?—�??界面�??如实显示"向量库能不能�?
      lancedb: lancedbComponent(),
      memoryPaths: agentId
        ? resolveMemoryPaths(agentId, { dataDir: cfg.memoryRoot || undefined })
        : null,
      deps: readDepStatus(),
    };
  });

  /** 配置保存：向量工具（bge=真实 BGE-M3 嵌入 / basic=哈希占位�? 记忆根路径（重启生效�?
   *
   *  ⚠️ �?��**显式给出**的字段放�?patch：`saveMindConfig` �?`{...旧�?? ...patch}`�?
   *  若这里传 `memoryRoot: undefined`（渲染层�?��改向量工具时就是这个形状），
   *  JSON.stringify 会把该键整个丢掉 �?下一次�?�?`""` �?**用户设的�?��义根�?���?��默清�?*�?
   *  �?以改�?给了才写"（`""` �?��法�?�，表示"恢�?默�?位置"）�??*/
  handleTrusted<{ vectorTool?: string; memoryRoot?: string }>("slime:mind:configSet", async (_event, payload) => {
    const patch: { vectorTool?: VectorTool; memoryRoot?: string } = {};
    if (payload.vectorTool === "basic" || payload.vectorTool === "bge") {
      patch.vectorTool = payload.vectorTool;
    }
    if (typeof payload.memoryRoot === "string") {
      patch.memoryRoot = payload.memoryRoot;
    }
    const cfg = saveMindConfig(patch);
    memoryStores.clear();
    return { ok: true, vectorTool: cfg.vectorTool, memoryRoot: cfg.memoryRoot };
  });

  /** 依赖定位：auto=项目文件夹内�?���?�?��pick=手动选择文件/�?��。命�?��写入 slime.toml */
  handleTrusted<{ mode: "auto" | "pick"; key: "llama_bin" | "model_path" | "models_dir" }>(
    "slime:mind:locateDep",
    async (_event, payload) => {
      let picked: string | null = null;
      if (payload.mode === "pick") {
        const isDir = payload.key === "models_dir";
        const opts: Electron.OpenDialogOptions = isDir
          ? { title: "选择�?��聊天模型�?��", properties: ["openDirectory"] }
          : {
              title: payload.key === "llama_bin" ? "选择 llama-server.exe" : "选择嵌入模型 GGUF 文件",
              properties: ["openFile"],
              filters: payload.key === "llama_bin"
                ? [{ name: "llama-server", extensions: ["exe"] }]
                : [{ name: "GGUF 模型", extensions: ["gguf"] }],
            };
        const r = await dialog.showOpenDialog(mainWindow!, opts);
        picked = r.canceled ? null : (r.filePaths[0] ?? null);
      } else {
        const found = detectLocalDeps();
        picked = payload.key === "llama_bin" ? found.llamaBin : payload.key === "model_path" ? found.bgeModel : found.chatDir;
      }
      if (!picked) {
        return { found: false, deps: readDepStatus() };
      }
      const written = updateTomlKey(payload.key, picked);
      memoryStores.clear();
      return { found: true, written, deps: readDepStatus() };
    },
  );

  /** 情绪读取：Agent 当前 PAD/mood + 事件时间�?*/
  handleTrusted<{ agentId: string }>("slime:mind:emotionGet", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    const emotion = new EmotionalState((agent?.emotion as Record<string, unknown>) ?? undefined);
    return { ...emotion.toDict(), agentName: agent?.name ?? payload.agentId };
  });

  /** 进化读取：生命周�?+ 人格特质权重 + 行为沉淀/交互�?��（心智中枢进化板块） */
  handleTrusted<{ agentId: string }>("slime:mind:evolutionGet", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    if (!agent) {
      return { ok: false, error: "Agent 不存在" };
    }
    const persona = (agent.persona as unknown as Record<string, unknown>) ?? {};
    const rawTraits = Array.isArray(persona.traits) ? (persona.traits as Array<Record<string, unknown>>) : [];
    const traits = rawTraits.map((t) => ({
      name: String(t.name ?? t.trait ?? "unknown"),
      weight: typeof t.weight === "number" ? t.weight : 0.5,
      last_used: typeof t.last_used === "string" ? t.last_used : null,
    }));
    const behavior = (agent.behavior ?? {}) as Record<string, unknown>;
    const patterns = Array.isArray(behavior.patterns) ? (behavior.patterns as unknown[]) : [];
    const interactions = Array.isArray(persona.interactions) ? (persona.interactions as unknown[]) : [];
    return {
      ok: true,
      agentName: agent.name,
      lifecycle: agent.lifecycle ?? "unknown",
      created_at: agent.created_at ?? null,
      traits,
      behaviorCount: patterns.length,
      interactionCount: interactions.length,
      evolution: (agent.evolution as Record<string, unknown>) ?? null,
    };
  });

  /** 情绪手动调节：写 PAD 基线并重�?mood（不影响�?��演化与事件时间线�?*/
  handleTrusted<{ agentId: string; valence: number; arousal: number; dominance: number }>(
    "slime:mind:emotionSet",
    async (_event, payload) => {
      await ensureServices();
      const agent = await agentRegistry!.findAgent(payload.agentId);
      if (!agent) {
        return { ok: false, error: "Agent 不存在" };
      }
      const emotion = new EmotionalState((agent.emotion as Record<string, unknown>) ?? undefined);
      emotion.setBaseline(payload.valence, payload.arousal, payload.dominance);
      agent.emotion = emotion.toDict() as unknown as typeof agent.emotion;
      await agentRegistry!.save();
      return { ok: true, emotion: emotion.toDict() };
    },
  );

  /** book-to-skill：�?部文�?�?config/skills/<name>/SKILL.md（技能即装即�?��不影响既有�?习�?线） */
  handleTrusted<{ name: string; content: string }>("slime:mind:bookToSkill", async (_event, payload) => {
    const name = (payload.name ?? "").trim().replace(/[^\w\u4e00-\u9fa5-]/g, "").slice(0, 60);
    if (!name) {
      return { ok: false, error: "�?能名称无效（仅支持中�?字母/数字/�?��线）" };
    }
    const content = (payload.content ?? "").trim();
    if (!content) {
      return { ok: false, error: "文档内�?为空" };
    }
    const dir = resolve(PROJECT_ROOT, "config", "skills", name);
    mkdirSync(dir, { recursive: true });
    const desc = content.replace(/\s+/g, " ").slice(0, 120);
    const md =
      `---\nname: ${name}\ndescription: ${desc}\n---\n\n` +
      `# ${name}\n\n> �?book-to-skill 从�?部文档转换生成�?�\n\n${content.slice(0, 12000)}\n`;
    writeFileSync(resolve(dir, "SKILL.md"), md, "utf8");
    return { ok: true, path: resolve(dir, "SKILL.md") };
  });

  /** 依赖下载链路（国内镜像：hf-mirror / gh-proxy 系列；应用内下载，断点续传） */
  handleTrusted<{ target: string }>("slime:mind:download", async (_event, payload) => {
    const target = payload.target as DownloadTarget;
    if (target !== "llama" && target !== "bge") {
      return { ok: false, error: "�?��下载�?��" };
    }
    await ensureServices(); // �?��进度 listener 已注册（否则下载进度事件丢失，进度条不实时）
    return startDownload(target);
  });

  handleTrusted<{ target: string; action: "pause" | "cancel" | "resume" }>(
    "slime:mind:downloadControl",
    async (_event, payload) => {
      const target = payload.target as DownloadTarget;
      if (target !== "llama" && target !== "bge") {
        return { ok: false };
      }
      return controlDownload(target, payload.action);
    },
  );

  handleTrusted<{ target: string }>("slime:mind:downloadSnapshot", async (_event, payload) => {
    const target = payload.target as DownloadTarget;
    if (target !== "llama" && target !== "bge") {
      return { ok: false };
    }
    return downloadSnapshot(target);
  });

  handleTrusted<boolean>("slime:stats:poll", async (_event, start: boolean) => {
    if (start) {
      if (statsPoll) clearInterval(statsPoll);
      statsPoll = setInterval(() => {
        void (async () => {
          try {
            const svc = statsService;
            if (!svc) return; // ensureServices 尚未完成，本�?��过（�?statsService! 非空�?��会同�?TypeError�?
            const snap = await svc.snapshot();
            mainWindow?.webContents.send("slime:stats:update", snap);
          } catch (e) {
            console.warn("[gui:main] statsPoll snapshot 失败（本�?��过）:", e);
          }
        })();
      }, 3000);
    } else if (statsPoll) {
      clearInterval(statsPoll);
      statsPoll = null;
    }
    return { ok: true };
  });

  /** �?��/重试嵌入模型（下载完成后在状态面板手动触发） */
  handleTrusted<void>("slime:model:startEmbedding", async (): Promise<{ ok: boolean; error?: string; state?: string }> => {
    const mgr = getModelServer();
    if (!mgr) {
      return { ok: false, error: "模型服务器未初始化" };
    }
    const result = await mgr.startEmbedding();
    return { ok: result.ok, error: result.error, state: result.state };
  });

  handleTrusted<void>("slime:agents:list", async () => {
    // A-1043：�?屏只等轻量注册表 —�??名字表就�?AgentRegistry 里，不需要重初�?化�??
    await ensureRegistry();
    return (agentRegistry?.loadedAgents ?? []).map((a): AgentInfo => ({
      id: a.id, name: a.name, role: a.role,
      children: a.children ?? [], parent_id: a.parent_id ?? null,
      lifecycle: a.lifecycle ?? "unknown",
    }));
  });

  handleTrusted<{ name: string; role: string; toolProfile?: { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] } }>("slime:agents:create", async (_event, params) => {
    await ensureServices();
    const a = await createAgent(params.name, params.role, params.toolProfile);
    selectedAgentId = a.id;
    a2aBus?.register(a.name);
    // A-1106：新建的 Agent **立刻**进可派发清单。�?前这里没有刷�?—�??清单�?��动期算一次，
    // 于是「刚建的子代理主 Agent 看不到�?�也调不动�?�，而所有日志与门�?都是绿的�?
    syncDispatchableSubagents();
    mainWindow?.webContents.send("slime:agents:selected", a.id);
    return { id: a.id, name: a.name, role: a.role, children: [], parent_id: null, lifecycle: a.lifecycle ?? "unknown" } as AgentInfo;
  });

  handleTrusted<{ parentId: string; name: string; role: string }>("slime:agents:fork", async (_event, params) => {
    await ensureServices();
    const parent = await agentRegistry!.findAgent(params.parentId);
    if (!parent) { throw new Error("父 Agent 不存在"); }
    const child = await forkAgent(parent, params.name, params.role);
    selectedAgentId = child.id;
    a2aBus?.register(child.name);
    // A-1106：分裂出来的�?Agent 同样立刻进清单（§7 分�?场景�?先隔离再派活"的同�?判据）�??
    syncDispatchableSubagents();
    mainWindow?.webContents.send("slime:agents:selected", child.id);
    return { id: child.id, name: child.name, role: child.role, children: [], parent_id: parent.id, lifecycle: child.lifecycle ?? "unknown" } as AgentInfo;
  });

  /** P0: 选中 Agent */
  handleTrusted<{ agentId: string }>("slime:agents:select", async (_event, payload) => {
    selectedAgentId = payload.agentId;
    console.info(`[gui:main] 选中 Agent: ${payload.agentId}`);
    return { ok: true };
  });

  /** 删除 Agent（�?�归子树 + �?�� children 清理 + 历史清理�?*/
  handleTrusted<{ agentId: string }>("slime:agents:remove", async (_event, payload) => {
    await ensureServices();
    const deleted = await agentRegistry!.removeAgent(payload.agentId);
    if (deleted.length === 0) {
      return { ok: false, error: "Agent 不存在" };
    }
    for (const aid of deleted) {
      try {
        const aa = await agentRegistry!.findAgent(aid);
        if (aa) { a2aBus?.unregister(aa.name); }
      } catch (e) {
        console.warn(`[gui:main] A2A 注销失败 ${aid}:`, e);
      }
      try {
        await removeAgentHistory(aid);
      } catch (e) {
        console.warn(`[gui:main] 历史清理失败 ${aid}:`, e);
      }
      try {
        await removeSessionsForAgent(aid);
      } catch (e) {
        console.warn(`[gui:main] 会话清理失败 ${aid}:`, e);
      }
    }
    if (selectedAgentId && deleted.includes(selectedAgentId)) {
      selectedAgentId = null;
    }
    console.info(`[gui:main] 已删�?Agent 子树: ${deleted.join(", ")}`);
    // A-1106：删除后**必须**把�?删的 Agent 从可派发清单里摘掉�?�否则清单里会留�?�?�?
    // 已经不存在的名字：模型点名派�?�?`delegate()` 找不到可执�? Agent �?每�?派发都失败�??
    syncDispatchableSubagents();
    return { ok: true, deleted };
  });

  /** 属�?�面板：返回 Agent 完整状�?�（model_choice/role/reasoning_effort 等） */
  handleTrusted<{ agentId: string }>("slime:agents:detail", async (_event, payload) => {
    await ensureServices();
    const a = await agentRegistry!.findAgent(payload.agentId);
    if (!a) { return null; }
    return {
      id: a.id, name: a.name, role: a.role,
      model_choice: a.model_choice ?? "inherit",
      mode: a.mode ?? "build",
      reasoning_effort: a.reasoning_effort ?? "none",
      show_thinking: a.show_thinking ?? "1",
      max_context: a.max_context ?? undefined,
      max_output: a.max_output ?? undefined,
      lifecycle: a.lifecycle ?? "unknown",
      tool_profile: a.tool_profile as { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] } | undefined,
      // A-1096：�?�传「同意�?派发为子代理」开关�?�⚠�?必须原样透传 `undefined`（�?�不�?`?? true`）�?��??
      // 渲染层�?区分三�?�（�??�?/ 显式允�? / 显式拒绝）才能�?�?��显与落盘；在这里合并就等于丢信息�?
      subagent_dispatch: a.subagent_dispatch as boolean | undefined,
    };
  });

  /** P0: 更新 Agent 配置 */
  handleTrusted<{ agentId: string; patch: Record<string, unknown> }>("slime:agents:update", async (_event, payload) => {
    await ensureServices();
    const updated = await agentRegistry!.updateAgent(payload.agentId, payload.patch as Partial<AgentState>);
    if (!updated) { throw new Error(`Agent ${payload.agentId} 不存在`); }
    // A-1106：改设置后立刻重算清�?—�??两个方向都�?：① 把�?�同意�?派发」�?关掉�?Agent 摘出去；
    // �?名字/角色�? �?���?���?description）改了，清单里的描述必须同�?更新�?
    // 否则模型仍在�?*旧描�?*�?��选人，派给一�?��力已经变了的执�?者�??
    syncDispatchableSubagents();
    return { ok: true };
  });

  /** �?��移民协�? v1.2 §4：�?�?Agent �?.slimeagent �?���?*/
  handleTrusted<{ agentId: string }>("slime:agents:export", async (_event, payload) => {
    await ensureServices();
    const agent = agentRegistry!.loadedAgents.find((a) => a.id === payload.agentId);
    if (!agent) { return { ok: false, error: `Agent ${payload.agentId} 不存在` }; }
    const saveOpts = {
      title: "导出 Agent 身份包",
      defaultPath: `${agent.name}.slimeagent`,
      filters: [{ name: "slime Agent 身份包", extensions: ["slimeagent"] }],
    };
    const save = mainWindow
      ? await dialog.showSaveDialog(mainWindow, saveOpts)
      : await dialog.showSaveDialog(saveOpts);
    if (save.canceled || !save.filePath) { return { ok: false, error: "已取消选择" }; }
    const { exportAgent } = await import("../../../core-ts/src/services/export.js");
    const res = await exportAgent({ agentId: payload.agentId, output: save.filePath });
    if (!res.ok) { console.error(`[gui:main] 导出失败: ${res.error}`); }
    return res.ok ? { ok: true, path: res.path } : { ok: false, error: res.error };
  });

  /** �?��移民协�? v1.2 §5：�?�?.slimeagent �?��包（冲突策略 §5.2，默�?abort�?*/
  handleTrusted<{ conflictStrategy?: "abort" | "overwrite" | "keep-old" }>("slime:agents:import", async (_event, payload) => {
    await ensureServices();
    const openOpts: Electron.OpenDialogOptions = {
      title: "导入 Agent 身份包",
      properties: ["openFile"],
      filters: [{ name: "slime Agent 身份包", extensions: ["slimeagent"] }],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消选择" }; }
    const { importAgent, PROJECT_ROOT } = await import("../../../core-ts/src/services/import.js");
    const res = await importAgent({
      input: open.filePaths[0],
      targetRoot: PROJECT_ROOT,
      conflictStrategy: payload.conflictStrategy ?? "abort",
    });
    if (res.ok) {
      // 注册表已�?importAgent 落盘改动，重载内存�?�并通知渲染层刷�?
      await agentRegistry!.load();
      // A-1106：�?入进来的 Agent 也�?立刻进清单（否则"导入成功"却在派发侧不�??）�??
      syncDispatchableSubagents();
      mainWindow?.webContents.send("slime:agents:selected", res.agentId ?? null);
      console.info(`[gui:main] 导入成功: agent=${res.agentId} (${res.agentName})`);
    } else {
      console.error(`[gui:main] 导入失败: ${res.error}`);
    }
    return res;
  });

  handleTrusted<void>("slime:sidecar:status", async () => {
    const mgr = getModelServer();
    if (!mgr) { return { running: false } as SidecarStatus; }
    const items = mgr.status();
    // �?��真�? ready 的�?色当"运�?�?，避�?embedding �?��动合成�?(state=idle)�?��"运�?�?
    const ready = items.filter((i) => (i as unknown as { state: string }).state === "ready");
    const primary =
      ready.find((i) => (i as unknown as { role: string }).role === "inference") ??
      ready[0] ??
      null;
    if (!primary) { return { running: false } as SidecarStatus; }
    const vram = (primary as unknown as { vram_gb?: { used_gb?: number } | null }).vram_gb;
    return {
      running: true,
      port: (primary as unknown as { port: number }).port,
      model: (primary as unknown as { model?: string }).model,
      vram: vram?.used_gb,
      pid: (primary as unknown as { pid?: number | null }).pid ?? undefined,
    } as SidecarStatus;
  });

  handleTrusted<void>("slime:sidecar:spawn", async () => {
    const mgr = getModelServer();
    if (!mgr) { return; }
    await mgr.startup();
  });

  handleTrusted<void>("slime:sidecar:terminate", async () => {
    const mgr = getModelServer();
    if (!mgr) { return; }
    await mgr.shutdown();
  });

  /** Provider 管理（加密存�?��渲染层只接触脱敏摘�?，明�?key 不出主进程） */
  handleTrusted<void>("slime:providers:list", async (): Promise<ProviderSummary[]> => listProviders());

  handleTrusted<{ baseUrl: string; apiKey: string; api_format?: "openai" | "anthropic" | "responses" | "google" | "auto" }>("slime:providers:fetchModels", async (_event, p) =>
    // A-918+：探测即 enrich �?��元数�?��context_window/max_output/vision/think/pricing），
    // 让�?�探测成功�?�一步到位，渲染层拿到完�?model spec 而非�?ID�?
    // api_format 穿�?�：用户显式指定 anthropic 时用 x-api-key 探测，auto 时双鉴权兜底�?
    enrichModels(p.baseUrl, p.apiKey, p.api_format ?? "auto"),
  );

  handleTrusted<{ key: string; api_base: string; api_key?: string; model?: string | null; models?: unknown[] }>(
    "slime:providers:save",
    async (_event, p) => {
      const res = await saveProvider(p);
      if (res.ok) {
        engine?.refreshProviders();
        console.info(`[gui:main] Provider 已保存并�?���? ${p.key}`);
      }
      return res;
    },
  );

  /** �?�?��新（上游模型更新同�?）：用已保存密钥重新探测并合并，无需用户重新�?�� */
  handleTrusted<{ key: string }>("slime:providers:refresh", async (_event, p) => {
    const res = await refreshProviderModels(p.key);
    if (res.ok) {
      engine?.refreshProviders();
      console.info(`[gui:main] Provider 模型列表已刷�? ${p.key}（�?�共 ${res.total ?? 0}，新�?${res.added ?? 0}，移�?${res.removed ?? 0}）`);
    }
    return res;
  });

  handleTrusted<{ key: string }>("slime:providers:remove", async (_event, p) => {
    const res = removeProvider(p.key);
    if (res.ok) {
      engine?.refreshProviders();
      console.info(`[gui:main] Provider 已删除并�?���? ${p.key}`);
    }
    return res;
  });

  /** �?��模型：列�?/ 保存 / 删除 / �?���?�� / 文件选择 */
  handleTrusted<void>("slime:providers:localList", async (): Promise<LocalModelSpec[]> => listLocalModels());

  /** A-954：自�?SILAM 脑可用�?�（sidecar 拉起成功�?enabled）�?��?�群聊成员�?进�?�择的供应商之一�?
   *  必须�?await ensureServices()：silamBrain 在引擎启动时拉起，App �?��即探活会读到 null �?false */
  handleTrusted<void>("slime:silam:status", async (): Promise<{ enabled: boolean }> => {
    await ensureServices();
    return { enabled: silamBrain?.enabled === true };
  });

  /** A-963 双向�?后向：�?取某 Agent �?SILAM 情感/成长态（engine �?reply/observe 后缓存） */
  handleTrusted<{ agentId: string }>("slime:silam:state", async (_event, p): Promise<{
    fear?: number; desire?: number; n_nodes?: number; step?: number; langLoaded?: boolean;
  } | null> => {
    await ensureServices();
    const st = engine!.getSilamAffect(p.agentId);
    if (!st) { return null; }
    return { fear: st.fear, desire: st.desire, n_nodes: st.n_nodes, step: st.step, langLoaded: st.langLoaded };
  });

  handleTrusted<{ id: string; path: string; label?: string; ctx_len?: number; gpu_layers?: number; max_output?: number; vision?: boolean }>(
    "slime:providers:localSave",
    async (_event, p) => {
      const res = saveLocalModel(p);
      if (res.ok) {
        engine?.refreshProviders();
        console.info(`[gui:main] �?��模型已保存并�?���? ${p.id}`);
      }
      return res;
    },
  );

  handleTrusted<{ id: string }>("slime:providers:localRemove", async (_event, p) => {
    const res = removeLocalModel(p.id);
    if (res.ok) {
      engine?.refreshProviders();
      console.info(`[gui:main] �?��模型已删除并�?���? ${p.id}`);
    }
    return res;
  });

  handleTrusted<{ dir: string }>("slime:providers:localScan", async (_event, p) => scanLocalModels(p.dir));

  /** 弹出文件选择框挑选本地模型（.gguf�?*/
  handleTrusted<void>("slime:providers:localPick", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const openOpts: Electron.OpenDialogOptions = {
      title: "选择本地模型文件（GGUF）",
      properties: ["openFile"],
      filters: [{ name: "GGUF 模型", extensions: ["gguf", "ggml"] }, { name: "全部文件", extensions: ["*"] }],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消�?�择" }; }
    return { ok: true, path: open.filePaths[0] };
  });

  /** 参数文件调试（折叠栏）：清单 / 读取 / 写入（白名单 + 备份原子写） */
  handleTrusted<void>("slime:config:overview", async () => configOverview());

  handleTrusted<{ name: string }>("slime:config:read", async (_event, p) => readConfigFile(p.name));

  handleTrusted<{ name: string; content: string }>("slime:config:write", async (_event, p) =>
    writeConfigFile(p.name, p.content),
  );

  handleTrusted<void>("slime:window:minimize", () => mainWindow?.minimize());
  handleTrusted<void>("slime:window:maximize", () => {
    if (mainWindow?.isMaximized()) { mainWindow.unmaximize(); } else { mainWindow?.maximize(); }
  });
  handleTrusted<void>("slime:window:quit", () => app.quit());
  handleTrusted<"quit" | "background">("slime:window:setExitMode", (_e, mode: "quit" | "background") => {
    exitModeStore = mode === "background" ? "background" : "quit";
    saveExitMode(exitModeStore);
    return { ok: true, mode: exitModeStore };
  });
  handleTrusted<void>("slime:window:getExitMode", () => ({ mode: exitModeStore }));

  /** 右侧栏�?�工作树」：列目录�?�path 必须锚定�?root 内（�?��穿越保护�?*/
  /** 文件资源管理�?��调系统�?话�?选择任意文件夹作为浏览根（与系统资源管理器互通） */
  handleTrusted<void>("slime:workspace:pickBrowseRoot", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    try {
      const openOpts: Electron.OpenDialogOptions = {
        title: "选择要打开的文件夹（可浏览任意位置）",
        properties: ["openDirectory", "createDirectory"],
      };
      const r = mainWindow
        ? await dialog.showOpenDialog(mainWindow, openOpts)
        : await dialog.showOpenDialog(openOpts);
      if (r.canceled || r.filePaths.length === 0) { return { ok: false, error: "已取消" }; }
      return { ok: true, path: r.filePaths[0] };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 文件资源管理�?��返回某目录的父级（供"上级"逐级向上浏�?到�?盘根�?*/
  handleTrusted<{ path: string }>("slime:workspace:getParent", (_event, p): { ok: boolean; parent?: string | null; diskRoot?: boolean; error?: string } => {
    try {
      const cur = resolve(p.path || "");
      if (!cur) { return { ok: false, error: "�?��为空" }; }
      const parent = dirname(cur);
      if (parent === cur) { return { ok: true, parent: null, diskRoot: true }; }
      return { ok: true, parent };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  handleTrusted<{ root: string; rel: string }>("slime:workspace:list", (_event, p): WorkspaceListResult => {
    try {
      const root = resolve(p.root || "");
      if (!root) {
        return { ok: false, error: `工作根异常（${root}），已拒绝�?取` };
      }
      if (!existsSync(root)) {
        return { ok: false, error: `工作�?��不存�?��${root}` };
      }
      // 相�?�?��规范化后拼接，校验仍�?root 内（root 为盘符根时其�?��已带尾分隔�?�?
      const rel = (p.rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
      const dir = rel ? resolve(root, ...rel.split("/")) : root;
      const rootNorm = root.endsWith(sep) ? root : root + sep;
      if (dir !== root && !dir.startsWith(rootNorm)) {
        return { ok: false, error: "�?��越界：仅允�?访问当前�?��内部" };
      }
      const st = statSync(dir);
      if (!st.isDirectory()) {
        return { ok: false, error: "�?��不是�?��" };
      }
      const entries: WorkspaceEntry[] = readdirSync(dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith("."))
        .map((d) => {
          let size = 0;
          let isDir = d.isDirectory();
          if (!isDir) {
            try { size = statSync(join(dir, d.name)).size; } catch { size = 0; }
          }
          return {
            name: d.name,
            rel: rel ? `${rel}/${d.name}` : d.name,
            isDir,
            size,
          };
        });
      // �?��在前，按名称排序
      entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      return { ok: true, entries };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** A-980-R32：把「聊�?产物里点到的�?��」解析成真实存在的绝对路径�??
   *
   *  背景（用户实测）：�?��?�历程与产物卡里点的**很�?**文件都报「文件不存在」，但自己按同样�?���?
   *  右侧栏翻却能打开。根因不�?��件不�?��而是**解析基准不�?**：点击来源五花八门�?��??
   *  工具回传�?path �?���??�相对会话工作目录�?��?�相对项�?��」�?�带项目名前�?」�?�带 `:�?列` 后缀」，
   *  甚至�??备内�?��（adb �?/sdcard/...）；而渲染层手里那个 workspace �?��还没加载完或压根没绑定�??
   *  旧实现只试两种（workspace 相�? + 当绝对），于�?��量明明存在的文件�?��"不存�?�?
   *
   *  这里把所�?*合理候�??*按优先级列出来�?�个试，并且把试过的�?��原样回给界面�?
   *  找不到时用户/�?发�?�看到的�?我按这些�?��找过"，�?�不�?��句黑箱错�???
   *  额�?返回�?`isDir`：目录也�?��法的点击�?��（渲染层�??打开�?�?��览�?�?��的文件页），
   *  而不�?���?readFile 那�?"�?���?�?报错"（这正是用户说的"文件夹也点不�?"）�??
   */
  handleTrusted<{ rel: string; root?: string; sessionId?: string }>(
    "slime:workspace:openTarget",
    async (_event, p): Promise<{ ok: boolean; path?: string; isDir?: boolean; tried?: string[]; error?: string }> => {
      const sessionWorkspace = p.sessionId
        ? (await getSession(p.sessionId).catch(() => null))?.workspace
        : null;
      // 候�?�生成是�??�辑（可单测）：�?./targetPath.ts
      const { candidates } = buildTargetCandidates(
        typeof p?.rel === "string" ? p.rel : "",
        { root: p.root, sessionWorkspace, projectRoot: PROJECT_ROOT },
        resolve, basename, dirname,
      );
      if (candidates.length === 0) {
        return { ok: false, error: `缺少文件�?��（原始�?�："${typeof p?.rel === "string" ? p.rel : ""}"）`, tried: [] };
      }
      for (const c of candidates) {
        try {
          if (existsSync(c)) {
            return { ok: true, path: c, isDir: statSync(c).isDirectory(), tried: candidates };
          }
        } catch { /* 权限等异常跳到下�?�??��??*/ }
      }
      return {
        ok: false,
        error: `文件不存�?��${normalizeTargetPath(typeof p?.rel === "string" ? p.rel : "")}`,
        tried: candidates,
      };
    },
  );

  /** 右侧栏�?�工作树」：读取文件内�?（文�?图片/二进制，主进程校验锚定） */
  handleTrusted<{ root: string; rel: string }>("slime:workspace:readFile", (_event, p): WorkspaceReadFileResult => {
    try {
      const root = resolve(p.root || "");
      if (!root) {
        return { ok: false, error: `工作根异常（${root}），已拒绝�?取` };
      }
      if (!existsSync(root)) {
        return { ok: false, error: `工作�?��不存�?��${root}` };
      }
      const rel = (p.rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!rel) { return { ok: false, error: "缺少文件�?��" }; }
      const filePath = resolve(root, ...rel.split("/"));
      const fileRootNorm = root.endsWith(sep) ? root : root + sep;
      if (!filePath.startsWith(fileRootNorm)) {
        return { ok: false, error: "�?��越界：仅允�?访问当前�?��内部" };
      }
      if (!existsSync(filePath)) { return { ok: false, error: `文件不存�?��${filePath}` }; }
      const st = statSync(filePath);
      if (st.isDirectory()) { return { ok: false, error: `不是文件（是�?��）：${filePath}` }; }
      // 图片优先：常�?PNG/JPG/GIF/WebP/BMP/SVG
      const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
      const ext = "." + filePath.split(".").pop()!.toLowerCase();
      if (IMG_EXT.has(ext)) {
        const buf = readFileSync(filePath);
        return { ok: true, path: filePath, name: rel, mime: "image", content: buf.toString("base64") };
      }
      // A-980-R8：PDF / Office（word/excel/ppt）专�?mime—�?�pdf 由右侧栏内嵌预�?�?
      // office 右侧栏只读二进制（�?杂格式不外挂解析库），交给系统默认应用打�?�?
      // 注意要在 ARCHIVE_BINARY_EXT 判定**之前**�?pdf 原在该集合里�?binary）�??
      const OFFICE_EXT = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
      if (ext === ".pdf") {
        const buf = readFileSync(filePath);
        return { ok: true, path: filePath, name: rel, mime: "pdf", content: buf.toString("base64") };
      }
      if (OFFICE_EXT.has(ext)) {
        const buf = readFileSync(filePath);
        return { ok: true, path: filePath, name: rel, mime: "office", content: buf.toString("base64") };
      }
      // 先�?原�?字节，再判定二进制：readFileSync(path, "utf-8") 在二进制上不会抛错（会静默按替换符解码）�?
      // 若直接当文本返回会得到乱�?超长字�?串，渲染时拖�?��至崩溃整�?��用�??
      const buf = readFileSync(filePath);
      const hasNul = binarySniff(buf);
      // 常�?压缩�?归档/二进制扩展名直接判为 binary（阻止�?当文�??览）
      const ARCHIVE_BINARY_EXT = new Set([
        ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz", ".zst",
        ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".deb", ".rpm", ".apk", ".msi",
        ".woff", ".woff2", ".ttf", ".eot", ".ico", ".db", ".sqlite", ".pdf", ".wasm",
        ".mat", ".npy", ".pkl", ".pyc", ".class", ".o", ".a", ".node",
      ]);
      if (ARCHIVE_BINARY_EXT.has(ext) || hasNul) {
        return { ok: true, path: filePath, name: rel, mime: "binary", content: buf.toString("base64") };
      }
      // 文本：安全解�?+ 体积上限（避免超大字符串打爆 IPC / 渲染线程�?
      const MAX_TEXT = 512 * 1024;
      let text = buf.toString("utf-8");
      let truncated = false;
      if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
      return { ok: true, path: filePath, name: rel, mime: "text", content: text, truncated };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** A-173：按绝�?�?��直接读取文件（聊天消�?��点击文件链接打开到右侧栏；无工作�?��越界限制�?*/
  handleTrusted<{ path: string }>("slime:workspace:readFileAbs", (_event, p): WorkspaceReadFileResult => {
    try {
      const abs = typeof p.path === "string" ? p.path.trim().replace(/^["']|["']$/g, "") : "";
      if (!abs) { return { ok: false, error: "缺少文件�?��" }; }
      if (!existsSync(abs)) { return { ok: false, error: `文件不存�?��${abs}` }; }
      const st = statSync(abs);
      if (st.isDirectory()) { return { ok: false, error: `不是文件（是�?��）：${abs}` }; }
      const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
      const ext = "." + abs.split(".").pop()!.toLowerCase();
      const name = abs.split(/[\\/]/).pop() ?? abs;
      if (IMG_EXT.has(ext)) {
        const buf = readFileSync(abs);
        return { ok: true, path: abs, name, mime: "image", content: buf.toString("base64") };
      }
      // A-980-R8：PDF / Office 专用 mime（与 readFile 同�?，先�?ARCHIVE 判定�?
      const OFFICE_EXT = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
      if (ext === ".pdf") {
        const buf = readFileSync(abs);
        return { ok: true, path: abs, name, mime: "pdf", content: buf.toString("base64") };
      }
      if (OFFICE_EXT.has(ext)) {
        const buf = readFileSync(abs);
        return { ok: true, path: abs, name, mime: "office", content: buf.toString("base64") };
      }
      const buf = readFileSync(abs);
      const hasNul = binarySniff(buf);
      const ARCHIVE_BINARY_EXT = new Set([
        ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz", ".zst",
        ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".deb", ".rpm", ".apk", ".msi",
        ".woff", ".woff2", ".ttf", ".eot", ".ico", ".db", ".sqlite", ".pdf", ".wasm",
        ".mat", ".npy", ".pkl", ".pyc", ".class", ".o", ".a", ".node",
      ]);
      if (ARCHIVE_BINARY_EXT.has(ext) || hasNul) {
        return { ok: true, path: abs, name, mime: "binary", content: buf.toString("base64") };
      }
      const MAX_TEXT = 512 * 1024;
      let text = buf.toString("utf-8");
      let truncated = false;
      if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
      return { ok: true, path: abs, name, mime: "text", content: text, truncated };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** A-980-R8：用系统默�?应用（关联程序）打开文件—�?�word/pdf/ppt/excel 等右侧栏�??的格�?*/
  handleTrusted<{ path: string }>("slime:shell:openPath", async (_event, p): Promise<{ ok: boolean; error?: string }> => {
    const abs = (typeof p?.path === "string" ? p.path : "").trim().replace(/^["']|["']$/g, "");
    if (!abs) { return { ok: false, error: "缺少文件�?��" }; }
    if (!existsSync(abs)) { return { ok: false, error: `文件不存�?��${abs}` }; }
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /* ══ A-1133：工作文档�?�道（�?�?/ 生成�?══════════════════════════════════════════════
     为什么必须有它：`.docx/.xlsx/.pptx` **不是** Chromium 能渲染的类型（交给浏览器页只�?
     `ERR_FAILED`，就�?��次事故），�??`file_read` 把它�?�� utf-8 读出来的�?��码�??
     �?统一�?`core-ts/src/office/*` 抽文�?/ 生成文件；主进程�?��「路径校�?+ �?��」�??
     ⚠️ �?��允�?�?���??的（用户拖进来的文件常在 Downloads/桌面）�?��??这是**用户显式意图**
        （他刚把文件拖到界面上），与 `file_read` 工具�?默�?锁项�?��"�?���?���???
        但只接受**绝�?�?��**：相对路径的�?��取决于工作目录，静默解析会变成�?二个产地�?*/
  handleTrusted<{ path: string }>("slime:docs:read", async (_event, p) => {
    const abs = (typeof p?.path === "string" ? p.path : "").trim().replace(/^["']|["']$/g, "");
    if (!abs) { return { ok: false, error: "缺少文件�?��" }; }
    if (!isAbsolutePath(abs)) { return { ok: false, error: `�?要绝对路径：${abs}` }; }
    if (!existsSync(abs)) { return { ok: false, error: `文件不存�?��${abs}` }; }
    try {
      const ext = (abs.slice(abs.lastIndexOf(".")) || "").toLowerCase();
      // �?Office 2007+（docx/xlsx/pptx）：既有 READ 实现（带段落/表格/按页轻结构）
      const kind = docKindFromExt(ext);
      if (kind) {
        const r = extractDocText(await readFile(abs), kind);
        return { ok: true, kind, text: r.text, truncated: r.truncated, info: r.info };
      }
      // �?旧版二进制（.doc/.xls/.ppt）：既有 OLE 解析�?*能真�?*，不�?��报错�?
      const ole = oleKindFromExt(ext);
      if (ole) {
        const r = extractOleText(await readFile(abs), ole);
        return { ok: true, kind: `ole-${ole}`, text: r.text, truncated: r.truncated, info: r.info };
      }
      // �?�?���?��：直�?utf-8（这就是该格式的�?��，没有转�?��说）
      if (classifyFile(abs).parser === "text") {
        return { ok: true, kind: "text", text: (await readFile(abs, "utf8")).slice(0, 200_000), truncated: false };
      }
      /* �?其余�?*明确说清**而不�?��读成乱码。判�?`classifyFile` 单一产地�?
         ⚠️ PDF 已由 `extractPdfText` �?��（`docKindFromExt(".pdf") === "pdf"`），�?以走到这�?
            的不�?PDF；真的落到这里（�?��类型）就如实报错 + 给可操作出路�?*/
      return { ok: false, error: nonNavigableReason(abs) };
    } catch (e) {
      return { ok: false, error: `读取失败：${String((e as Error)?.message ?? e)}` };
    }
  });

  /**
   * A-1133：把**渲染用的 HTML** 落到磁盘，供应用内静态服务在右栏浏�?器页里打�?�?
   *
   * 为什么必须落盘再�?页（而不�?data: URL 或直接�? webview）：
   *   · Chromium **禁�?顶层导航�?`data:` URL**�?Not allowed to navigate top frame to data URL"）⇒ 不可行；
   *   · 直接�? webview �?HTML 会绕�?应用统一的�?览�?�道（下�?�?��面又得重造一遍）�?
   * 落盘 + 既有 `http.serve` + 右栏浏�?器页 = 复用**已经存在**的网页�?览链�?���?处产地）�?
   *
   * ⚠️ 文件名用**内�?哈希**，�?止时间戳/�??序号（否则每看一次就多一�?��件�?�目录无限膨�?）�??
   *    同一份内容重复�?览会命中同一�?��件，天然幂等�?
   * ⚠️ �?���?*�?��程生成的**内�?（渲染层传入），不�?任意磁盘�?�� —�??这里不是通用文件写入口�??
   */
  handleTrusted<{ name?: string; html?: string }>("slime:docs:htmlPreview", async (_event, p) => {
    const html = typeof p?.html === "string" ? p.html : "";
    if (!html.trim()) { return { ok: false, error: "没有�?��染的内�?" }; }
    try {
      const dir = join(app.getPath("userData"), "doc-preview");
      mkdirSync(dir, { recursive: true });
      /* ⚠️ `path` �?`name` **必须来自同一�?���?*：上�?版分�?��，结果写的是 `<名字>-<hash>.html`�?
         返回的却�?`<名字>.html` �?渲染层拼出的 URL **404 �?整页空白**
         （用户实测：「现在网页上�?么都出现不了」）。命名�?则�? `previewPage.ts`（唯�?产地）�??*/
      const written = previewHtmlPath(dir, p?.name, html);
      writeFileSync(written.path, html, "utf8");
      return { ok: true, path: written.path, dir, name: written.name };
    } catch (e) {
      return { ok: false, error: `写入预�?页失败：${String((e as Error)?.message ?? e)}` };
    }
  });

  /**
   * A-1136 阶�? C�?*�?��有没�?LibreOffice**（�?�版 `.doc/.xls/.ppt` 保真预�?的前�?��件）�?
   *
   * 为什么单�?���?�?IPC（�?�不�?? `renderPage` �?��内部探测）：
   * �?渲染层�?�?*用户点击�?*就把"这台机器能不能看老文�?讲清楚（例�?按钮文�?/提示），
   *    那时还没有具体文件，`renderPage` 无从调用�?
   * �?探测结果要能�??�?��/�?��页�?�?��「缺依赖」不�?���?��件的属�?�，�?*机器**的属性）�?
   * ⚠️ 判据�?���?处（`core-ts/src/office/libreoffice.ts` + `libreofficeConvert.ts`），
   *    渲染�?*不�?**�?��拼路径判�?—�??「同�?事实写在两�?必然漂�?�（�?��铁律 11）�??
   */
  handleTrusted<{ force?: boolean }>("slime:office:libreofficeProbe", async (_event, p) => {
    try {
      const r = await probeLibreOffice(Boolean(p?.force));
      return { ok: true, found: r.found, path: r.path, version: r.version, hint: r.hint };
    } catch (e) {
      return { ok: false, found: false, path: "", version: "", hint: "", error: String((e as Error)?.message ?? e) };
    }
  });

  /**
   * A-1136�?*保真渲染�?*（人看）—�??�?*原�?文件字节**交给真渲染库，�?浏�?器按原版式画出来�?
   *
   * 用户原话：�?�我要的�?���?*类似以图片的形式**直接�?HTML �?Web 预�?的功能，**而非�?�� md 文件阅�?**」�??
   * �?�?`docs:htmlPreview`（抽文本 �?结构化重排）**�?��不同**：这条�?的是**保真**（字�?字号/颜色/位置/图片）�??
   *
   * 落点：`userData/doc-render/`（库文件写一�?+ 每文件一�?���?��：index.html + 源文件副�?���?
   * 返回 `{ dir, name }`，调用方�?URL 交给**既有** `http.serve` + 右栏浏�?器页 —�??不另造链�???
   *
   * ## 阶�? C：�?�格式（.ppt/.doc/.xls）走**另一条实�?*�?*同一条出�?*
   * 老格式是 OLE2 二进制，�?JS 渲染不可�?�?先用�?�� LibreOffice **�?�� PDF**，再�?PDF 交给
   * Chromium 内置查看�?—�??出口仍是「右栏浏览器�?+ 静�?�服务�?�，�?��页面里嵌的是 PDF 而不�?��染库�?
   * ⚠️ �?LibreOffice �?*如实返回 `needs`**，由渲染层给出可操作提示�?*不�?静默降级**�?打不�?"�?
   * ⚠️ PDF �?*临时�?��**（用户�?��?�每次转�?��不留文件」）�?返回值里�?`transient: true`�?
   *    调用�?*不得**把它当成�?��期引用的�?��（它随时�?���?��理）�?
   */
  handleTrusted<{ path?: string; name?: string; open?: boolean }>("slime:docs:renderPage", async (_event, p) => {
    const abs = (typeof p?.path === "string" ? p.path : "").trim();
    if (!abs) { return { ok: false, error: "缺少文件�?��" }; }
    if (!isAbsolutePath(abs)) { return { ok: false, error: `�?要绝对路径：${abs}` }; }
    const plan = planRender(abs);
    /* ⚠️⚠️ **HTML 文件：服务它�?在目录�?�直接打�?它本�?*�?026-09-30 用户实测「HTML 反�?�无法显示�?�）�?
       它本来就�?���?�?拷进 `doc-render` 再服务会**丢掉同目录的兄弟资源**（css/js/图片）⇒ 页面残缺�?
       �?直接把它�?在目录交�?`http.serve`，`name` 用原始文件名。这�?*任何入口**进来都是原样�?
       ⚠️ �?���?127.0.0.1（本地），且服务的是用户**主动打开的那�?��件所在的�?��**�?*/
    if (plan.render === "html-native") {
      return { ok: true, dir: dirname(abs), name: basename(abs) };
    }
    if (!plan.faithful) {
      return { ok: false, error: `该类型不�?��保真渲染�?${abs.split(".").pop() ?? "?"}）`, degrade: true };
    }
    /* �?�? 老格式分�?��必须经过 LibreOffice �?��（阶�?C�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�? */
    if (plan.needs === "libreoffice") {
      /* ⚡⚡ **缓存命中 �?直接返回，跳�?LibreOffice**�?026-09-30 用户反�?「�?�版每�?都�?加载半天」）�?
         实测单�?�?�� **10~16 �?*，�?�其�?*绝大部分�?LibreOffice 的冷�?��**（不�?��换本�?���?
         而页�?�� PDF �?���?��就已�?*持久**落在 `doc-render/<sub>/`（�?下方 `pageRoot`）⇒
         同一份文件重复打�?**没有任何理由再转�?�?*�?
         ⚠️ 为什�?*不会服务旧内�?*：目录名 `renderDirName(abs)` 里含**内�?指纹**
            （路�?+ 大小 + mtime �?hash）⇒ 源文件一改，�?��名就变，�?��会重新转�???
         ⚠️ 判据必须�?PDF �?起看（`size > 0`）：�?�� html 没有 pdf �?上�?�?��写到�?半失败，
            那�?情况�?*必须重转**，否则会稳定地给用户�?�?��壳页�?*/
      const pageRoot = join(app.getPath("userData"), "doc-render");
      mkdirSync(pageRoot, { recursive: true });
      const cachedPage = pdfViewerPaths(pageRoot, abs);
      if (existsSync(cachedPage.html) && existsSync(cachedPage.pdf) && statSync(cachedPage.pdf).size > 0) {
        return { ok: true, dir: pageRoot, name: cachedPage.name, transient: true, cached: true };
      }
      const conv = await convertToPdf(abs);
      if (!conv.ok) {
        /* ⚠️ **兜底�?��**（用户口�?2026-09-30：�?�LibreOffice 优先 + SheetJS 兜底」）�?
           �?��型注册了 `fallback`（`.xls` �?`sheetjs` 直�? BIFF8）⇒ 没�? / �?��动时
           **仍然把它画出�?*（一张真表格），而不�?���?���?去下�?�?
           ⚠️ 页面上必须留�?�?*�??**提示（`notice`）�?��??A-1133 的教�?��
              静默降级 = 用户以为"这文件就长这�?、以为功能没做�??
           ⚠️ `useFallback` �?���?*已登记的**兜底�?��，调用方不能任意指定渲染�?���?`writeRenderPage`）�??*/
        if (fallbackRender(abs)) {
          const fbDir = join(app.getPath("userData"), "doc-render");
          mkdirSync(fbDir, { recursive: true });
          const fbBuilt = writeRenderPage(fbDir, abs, p?.name, {
            useFallback: true,
            notice: (conv.hint || conv.error || "本机没有 LibreOffice。")
              + "（当前按表格方式显示，不是原版式）",
          });
          if (fbBuilt.ok) {
            return { ok: true, dir: fbBuilt.dir, name: fbBuilt.name, transient: true, fallback: true, hint: conv.hint };
          }
        }
        /* ⚠️ 两�?失败**必须分开**：缺依赖�?装一�?���?（可操作），�?��失败�?这个文件有问�?�?
           混成�?句话会�?用户去�?�?�?��其实已经装好的东西（或反过来白等）�??*/
        return {
          ok: false, degrade: true,
          needs: "libreoffice",
          error: conv.error,
          hint: conv.hint,
          reason: conv.reason,
        };
      }
      const title = (p?.name ?? "").trim() || basename(abs);
      /* ⚠️⚠️ **`rootDir` 必须�?持久�?��"，绝不能�?`conv.dir`（临时目录）**
         �?026-09-30 由用户截图里那条提示条定位：「目录不存在：�??Temp\slime-lo-5pytap」）�?
         页面（`index.html` + PDF �?��）落�?`rootDir/<sub>/`，�?�返回�?�里�?`dir` **就是 `rootDir`**
         �?若传 `conv.dir`，渲染层要去**临时�?��**取页�?��而我�?��面紧接着就把临时�?��删了
         �?`http.serve` 报�?�目录不存在」⇒ 用户看到「保真渲染页已生成，但本地服务没起来」，�?��重排�?
         ⚠️ **旧代码一直传的就�?`conv.dir`，它"能用"仅仅因为那个临时�?��从来没人�?* —�??
            换句话�?它是**靠泄漏在�?��**；把泄漏�?��就等于把它抽空了（本 bug 的来历）�?
         �?与另�?�?���?��`writeRenderPage`）保持一致：都写�?`userData/doc-render`�?*/
      const built = writePdfViewerPage(pageRoot, conv.pdfPath, abs, title);
      /* ⚠️⚠️ 临时�?���?��（含影子 profile�?*在这里删干净**�?
         `writePdfViewerPage` 内部�?`copyFileSync` �?PDF �?*复制**进持久的 `doc-render/<sub>/`�?
         �?以�?刻删临时�?��不影响页�?��上面那条 `rootDir` 的约束�?�?��成立的前提）�?
         ⚠️ 之前的写法把�?`return` 给渲染层"让渲染层�?�?*但渲染层的类型里根本没声�?`convertDir`**
            �?从不消费 �?每转�?次在 `%TEMP%` 留一�?`slime-lo-XXXX`�?*违反用户定的「每次转�?��不留文件�?*�?
            教�?：把生命周期责任「交出去」时，必须确�?*真的有人接住**（否则就�?��手即漏）�?
         ⚠️ 顺序不能反：**必须在�?制之�?*删；早删会把�?PDF �?起删�?�?页面�?404 空白页�??*/
      cleanupConvertDir(conv.dir);
      if (!built.ok) {
        return { ok: false, error: built.error };
      }
      /* ⚠️ 交给 `http.serve` 的必须是**持久**�?��（`doc-render`）：
         临时�?���?��机名，每�?��次�?�?�?�?��态服务，而且�?��就�?删了�?*/
      return { ok: true, dir: built.dir, name: built.name, transient: true };
    }
    try {
      const dir = join(app.getPath("userData"), "doc-render");
      mkdirSync(dir, { recursive: true });
      const written = writeRenderPage(dir, abs, p?.name);
      return written;
    } catch (e) {
      return { ok: false, error: `生成渲染页失败：${String((e as Error)?.message ?? e)}` };
    }
  });

  handleTrusted<{ spec: { path: string; format: string; title?: string; body: string } }>("slime:docs:create", async (_event, p) => {
    const spec = p?.spec;
    const abs = (typeof spec?.path === "string" ? spec.path : "").trim();
    if (!abs) { return { ok: false, error: "缺少输出�?��" }; }
    if (!isAbsolutePath(abs)) { return { ok: false, error: `�?要绝对路径：${abs}` }; }
    return await writeDocument({ path: abs, format: spec.format as DocFormat, title: spec.title, body: spec.body ?? "" });
  });

  /** 工作树右�?��单：在主进程构建菜单模板，渲染层触发 popup */
  handleTrusted<{ root: string; params: import("../shared/ipc.js").WorkspaceContextMenuParams }>(
    "slime:workspace:contextmenu",
    (_event, p) => {
      const root = resolve(p.root || "");
      if (!root || !existsSync(root)) { return { ok: false, error: "工作目录不存在" }; }
      const params = p.params;
      const items: Array<{ label?: string; action?: string; accelerator?: string; enabled?: boolean; type?: "separator" }> = [];
      if (params.isDir) {
        items.push({ label: "在新标�?打开", action: "open_in_tab", enabled: true });
        items.push({ label: "复制�?��", action: "copy_path" });
        items.push({ type: "separator" as const });
        items.push({ label: "新建文件…", action: "new_file" });
        items.push({ label: "新建文件夹…", action: "new_folder" });
        items.push({ type: "separator" as const });
        items.push({ label: "重命名…", action: "rename" });
        items.push({ label: "删除", action: "delete" });
      } else {
        items.push({ label: "在新标�?打开", action: "open_in_tab", accelerator: "Enter" });
        items.push({ label: "复制�?��", action: "copy_path", accelerator: "Ctrl+C" });
        items.push({ type: "separator" as const });
        items.push({ label: "重命名…", action: "rename" });
        items.push({ label: "删除", action: "delete" });
      }
      return { ok: true, items };
    },
  );

  /** 工作树新建文�?文件�?*/
  handleTrusted<import("../shared/ipc.js").WorkspaceCreateItemParams>(
    "slime:workspace:create",
    (_event, p): import("../shared/ipc.js").WorkspaceCreateResult => {
      try {
        const root = resolve(p.root || "");
        if (!root || !existsSync(root)) { return { ok: false, error: "工作目录不存在" }; }
        const parentRel = (p.parentRel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
        const parentDir = parentRel ? resolve(root, ...parentRel.split("/")) : root;
        if (parentDir !== root && !parentDir.startsWith(root + sep)) {
          return { ok: false, error: "�?��越界" };
        }
        const name = (p.name ?? "").trim();
        if (!name) { return { ok: false, error: "名称不能为空" }; }
        const fullPath = join(parentDir, name);
        if (fullPath !== root && !fullPath.startsWith(root + sep)) {
          return { ok: false, error: "�?��越界" };
        }
        if (existsSync(fullPath)) { return { ok: false, error: `已存在同名项：${name}` }; }
        if (p.isDir) {
          mkdirSync(fullPath, { recursive: true });
        } else {
          writeFileSync(fullPath, "");
        }
        const rel = parentRel ? `${parentRel}/${name}` : name;
        return { ok: true, rel };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  /** 右侧栏�?�终�??�：�?���?shell 清单（探测主机本地终�?��件；主进程侧缓存 Promise�?*/
  handleTrusted<undefined>("slime:term:profiles", async (): Promise<TermProfilesResult> => {
    try {
      const profiles = await getTermProfiles();
      const def = pickDefaultProfile(profiles);
      return { ok: true, profiles, defaultId: def ? def.id : null };
    } catch (e) {
      /* 探测失败必须**说出�?*（判�?��合的 ok:false 分支）�?��??
         静默返回空列表会让用户以�?这台机器没有终�?"�?*/
      return { ok: false, error: `终端配置探测失败：${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /** 右侧栏�?�终�??�：命令运�?�?���?PTY；限时执行，cwd 默�?工作�?���?
   *
   * A-1139 重写。两�?���?��不在这里�?
   *   · **用哪�?shell** �?`resolveProfile`（`profileId` 失配时�??默�?，不报错 —�??
   *     用户�?��机器 / 卸了 PowerShell 7 之后那个 id 就不存在了，此时正确的�?为是
   *     "用默�?shell 照常工作"，但渲染层会显示当前 profile �?�?�?到了�?���?��得�?的）�?
   *   · **怎么起它** �?`shellInvocation`（cmd �?`/d /s /c`、VS �?`call ... &&`�?
   *     WSL �?`--cd` 等都在那儿，�?��数可单测）�??
   * 这里�?��装配：探�?�?解析 profile �?起进�?�?解码�?*/
  handleTrusted<{ cmd: string; cwd?: string; profileId?: string }>("slime:term:exec", async (_event, p): Promise<TermResult> => {
    const cmd = (p.cmd ?? "").trim();
    if (!cmd) {
      return { ok: false, stdout: "", stderr: "命令为空", code: null };
    }

    const profiles = await getTermProfiles();
    const prof = resolveProfile(profiles, p.profileId);
    if (!prof) {
      return {
        ok: false, stdout: "", stderr: "", code: null,
        error: "没有探测到任何可用的 shell（内置终端需要 cmd / PowerShell / bash 之一）"
      };
    }

    /* cwd 由渲染层**提�?**、这�?*定事�?*（�? `resolveTermCwd` 的注释）�?*/
    const cw = resolveTermCwd(p.cwd, prof.kind);
    const res = await runShellCommand(shellInvocation(prof, cmd, cw.dir), prof, cw.dir);
    if (cw.rejected) { pushTermNotice(res, cw.rejected); }
    /* 回带**下一条命�?*该用�?cwd（可能因 `cd` 而变、也�?���?��面拒�?�?渲染层据此同步缓存）�?*/
    res.cwd = nextTermCwd(cmd, cw.dir, prof.kind);
    return res;
  });

  /** 右侧栏�?�Git 仓库」：�?测路径是否为 Git 仓库（rev-parse + 顶层�?+ 当前分支�?*/
  handleTrusted<{ path?: string }>("slime:git:detect", async (_event, p): Promise<GitDetect> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, isRepo: false, error: norm.error }; }
    const dir = norm.path;
    if (!norm.exists) {
      return { ok: true, isRepo: false, root: dir, notExists: true, error: "目录不存在，可初始化 Git 仓库时自动创建" };
    }
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return { ok: true, isRepo: false, root: dir, error: "该目录还不是 Git 仓库" };
    }
    const toplevel = await runGit(["rev-parse", "--show-toplevel"], dir);
    const br = await runGit(["branch", "--show-current"], dir);
    return {
      ok: true,
      isRepo: true,
      root: toplevel.stdout.trim() || dir,
      branch: br.stdout.trim() || "",
    };
  });

  /** 右侧栏�?�Git 仓库」：初�?化仓库（�?��不存在可�?�� mkdir；已�?��库直接成功） */
  handleTrusted<{ path?: string }>("slime:git:init", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const dir = norm.path;
    if (!norm.exists) {
      try { mkdirSync(dir, { recursive: true }); } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `创建目录失败：${msg}` };
      }
    }
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
    if (inside.code === 0 && inside.stdout.trim() === "true") {
      return { ok: true };
    }
    const init = await runGit(["init"], dir);
    if (init.code !== 0) { return { ok: false, error: init.stderr.trim() || "git init 失败" }; }
    return { ok: true };
  });

  /** 右侧栏�?�Git 仓库」：读取分支 / 提交 / 状�??/ 分支列表 */
  handleTrusted<{ path?: string }>("slime:git:info", async (_event, p): Promise<GitInfo> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const dir = norm.path;
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return { ok: false, error: "不是 Git 仓库" };
    }
    const [br, log, st, bs] = await Promise.all([
      runGit(["branch", "--show-current"], dir),
      runGit(["log", "-20", "--pretty=format:%H%x1f%s%x1f%cI"], dir),
      runGit(["status", "--porcelain"], dir),
      runGit(["branch", "-a", "--format=%(refname:short)"], dir),
    ]);
    const commits = log.stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, message, iso] = line.split("\x1f");
      return { hash: hash ?? "", message: message ?? "", time: iso ? iso.replace("T", " ").slice(0, 16) : "" };
    });
    // porcelain 首字�?index(暂存)，�?字�?=工作区；按暂存状态分�?
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    const deleted: string[] = [];
    for (const line of st.stdout.split("\n").filter(Boolean)) {
      if (line.startsWith("??")) { untracked.push(line.slice(3)); continue; }
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      let f = line.slice(3).trim();
      const arrow = f.indexOf(" -> "); // 重命�?复制：old -> new
      if (arrow >= 0) { f = f.slice(arrow + 4); }
      if (x === "D" || y === "D") { deleted.push(f); }
      else if (x !== " " && x !== "?" && x !== "U") { staged.push(f); }
      else if (y !== " " && y !== "?" && y !== "U") { modified.push(f); }
    }
    const branches = bs.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    // 领先/落后远�?（无上游�?= 0�?
    let ahead = 0;
    let behind = 0;
    const upstream = await runGit(["rev-parse", "--abbrev-ref", "@{u}"], dir);
    if (upstream.code === 0 && upstream.stdout.trim()) {
      const [a, b] = await Promise.all([
        runGit(["rev-list", "--count", "@{u}..HEAD"], dir),
        runGit(["rev-list", "--count", "HEAD..@{u}"], dir),
      ]);
      ahead = parseInt(a.stdout.trim(), 10) || 0;
      behind = parseInt(b.stdout.trim(), 10) || 0;
    }
    return {
      ok: true,
      branch: br.stdout.trim() || "main",
      commits,
      status: { staged, modified, untracked, deleted },
      branches,
      ahead,
      behind,
    };
  });

  /** 提交：全量暂�?+ commit */
  handleTrusted<{ path?: string; message?: string }>("slime:git:commit", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const msg = (p?.message ?? "").trim();
    if (!msg) { return { ok: false, error: "提交信息为空" }; }
    const dir = norm.path;
    const add = await runGit(["add", "-A"], dir);
    if (add.code !== 0) { return { ok: false, error: add.stderr.trim() || "git add 失败" }; }
    const cm = await runGit(["commit", "-m", msg], dir);
    if (cm.code !== 0) {
      const err = cm.stderr.trim();
      if (err.includes("nothing to commit") || err.includes("no changes added")) {
        return { ok: false, error: "没有�?��交的更改" };
      }
      return { ok: false, error: err || "git commit 失败" };
    }
    return { ok: true };
  });

  /** 推�?�（首�?推�?�无上游时自动带 -u origin HEAD�?*/
  handleTrusted<{ path?: string }>("slime:git:push", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const push = await runGit(["push"], norm.path);
    if (push.code !== 0) {
      const err = push.stderr.trim();
      if (err.includes("No configured push destination") || err.includes("upstream")) {
        const up = await runGit(["push", "-u", "origin", "HEAD"], norm.path);
        if (up.code === 0) { return { ok: true }; }
        return { ok: false, error: up.stderr.trim() || "git push 失败" };
      }
      return { ok: false, error: err || "git push 失败" };
    }
    return { ok: true };
  });

  /** 拉取 */
  handleTrusted<{ path?: string }>("slime:git:pull", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const pull = await runGit(["pull"], norm.path);
    if (pull.code !== 0) { return { ok: false, error: pull.stderr.trim() || "git pull 失败" }; }
    return { ok: true };
  });

  /** 切换分支（本地无此分�?��远�?有时�?��建跟�?���?�� */
  handleTrusted<{ path?: string; branch?: string }>("slime:git:checkout", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const name = (p?.branch ?? "").trim();
    if (!name) { return { ok: false, error: "分支名为空" }; }
    const co = await runGit(["checkout", name], norm.path);
    if (co.code !== 0) {
      const track = await runGit(["checkout", "-b", name, `origin/${name}`], norm.path);
      if (track.code === 0) { return { ok: true }; }
      return { ok: false, error: co.stderr.trim() || "切换分支失败" };
    }
    return { ok: true };
  });

  /** 克隆远程仓库（�?�择�?��父目录，克隆�?<父目�?/<仓库�?�?*/
  handleTrusted<{ url?: string }>("slime:git:clone", async (_event, p): Promise<GitCloneResult> => {
    try {
      const url = (p?.url ?? "").trim();
      if (!url) { return { ok: false, error: "仓库地址为空" }; }
      const openOpts: Electron.OpenDialogOptions = {
        title: "选择克隆目标父目录",
        properties: ["openDirectory", "createDirectory"],
      };
      const open = mainWindow
        ? await dialog.showOpenDialog(mainWindow, openOpts)
        : await dialog.showOpenDialog(openOpts);
      if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消�?�择" }; }
      const parent = open.filePaths[0];
      const name = url.split("/").pop()?.replace(/\.git$/i, "") || "repo";
      const target = join(parent, name);
      if (existsSync(target)) { return { ok: false, error: `�?��已存�?��${target}` }; }
      const cl = await runGit(["clone", url, target], parent);
      if (cl.code !== 0) { return { ok: false, error: cl.stderr.trim() || "git clone 失败" }; }
      return { ok: true, path: target };
    } catch (e) {
      console.error("[gui:main] git:clone crashed:", e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** A-968：�?取指定文件的变更 diff（红绿标注渲染；�?���?��件整体�?为新增；已删除文件输出纯删除�?*/
  handleTrusted<{ path?: string; file?: string }>("slime:git:diff", async (_event, p): Promise<GitDiffResult> => {
    try {
      const norm = gitPathOf(p?.path);
      if ("error" in norm) { return { ok: false, error: norm.error }; }
      const dir = norm.path;
      const relFile = (p?.file ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
      if (!relFile) { return { ok: false, error: "缺少文件�?��" }; }
      const inside = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
      if (inside.code !== 0 || inside.stdout.trim() !== "true") {
        return { ok: false, error: "不是 Git 仓库" };
      }
      // �?已跟�?��件：git diff HEAD -- <file>（工作区相�? HEAD 完整变更 = 暂存 + �?��存）
      // 显式 --no-color：防用户全局 color.diff=always �?ANSI �?��码带进解�?
      const headOk = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], dir);
      const raw = headOk.code === 0
        ? await runGit(["diff", "--no-color", "HEAD", "--", relFile], dir)
        : await runGit(["diff", "--no-color", "--cached", "--", relFile], dir); // 无提交仓库：走暂存区
      let out = (raw.code === 0 ? raw.stdout : "") || "";
      const absFile = join(dir, ...relFile.split("/"));
      const fileExists = existsSync(absFile) && statSync(absFile).isFile();
      // �?�?���?��件（git diff 默�?不出）：整体视为新�?
      if (!out && fileExists) {
        const ls = await runGit(["ls-files", "--error-unmatch", "--", relFile], dir);
        if (ls.code !== 0) {
          const buf = readFileSync(absFile);
          if (binarySniff(buf)) {
            return { ok: true, files: [{ file: relFile, status: "untracked", additions: 0, deletions: 0, hunks: [] }] };
          }
          const lines = buf.toString("utf-8").split(/\r?\n/);
          if (lines.length > 0 && lines[lines.length - 1] === "") { lines.pop(); }
          return {
            ok: true,
            files: [{
              file: relFile,
              status: "untracked",
              additions: lines.length,
              deletions: 0,
              hunks: [{ header: `@@ -0,0 +1,${lines.length} @@（未跟踪 · 全部为新增）`, lines: lines.map((t) => ({ type: "add", text: t })) }],
            }],
          };
        }
      }
      if (!out) { return { ok: true, files: [] }; }
      // �?解析 unified diff：@@ �?+ +/-/空格 前缀�?
      const parsed = parseUnifiedDiff(out);
      return {
        ok: true,
        files: [{ file: relFile, status: fileExists ? "modified" : "deleted", additions: parsed.additions, deletions: parsed.deletions, hunks: parsed.hunks }],
      };
    } catch (e) {
      console.error("[gui:main] git:diff crashed:", e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 主�?切换：持久化 + 同�?标�?栏系统按�?overlay 配色（配色表见上�?`titleBarColors`�?
   *
   *  ⚠️ A-1018：overlay �?`color` 必须等于标�?栏的**实际合成�?*，否则那三个系统按钮后面会出�?
   *  �?块明显的色块（用户原话："�?小化/还原/关闭这三�?���?���?��显的色块背景，给我去�?）�??
   *  ⚠️ A-1019：光�?*切换�?*纠�?还不�?—�??窗口创建的那�?刻就�?要�?（`titleBarOverlay` 的初值）�?
   *  否则 alpha 主�?用户每�?�?��都会先闪�?�?beta 色的色块。故这里同时**持久�?*�?
   *  由窗口创建�? `titleBarColors(readPersistedTheme())` 读出�?*/
  handleTrusted<{ theme: string }>("slime:theme:set", (_event, p) => {
    writePersistedTheme(p.theme);
    mainWindow?.setTitleBarOverlay({ ...titleBarColors(p.theme), height: 40 });
    // A-1137：搜索页�?webview �?*收不�?* postMessage（页面的主�?联动通道天然失效）⇒
    // 主�?必须由这里经 IPC 推给 guest，否则浅�?深色切换时右栏那�?页会留在旧配色（静默失效）�??
    pushSearchTheme(searchThemeOf(p.theme));
  });
  handleTrusted<void>("slime:settings:autostart:get", async (): Promise<{ ok: boolean; enabled: boolean }> => {
    try {
      // A-967：显�?path=execPath（部分形�?setLoginItemSettings �?path 时生效�?象与读取不一致）
      const s = app.getLoginItemSettings({ path: process.execPath });
      return { ok: true, enabled: s.openAtLogin };
    } catch (e) {
      console.warn("[gui:main] 读取�?机自�?���?", e);
      return { ok: false, enabled: false };
    }
  });

  /** �?机自�?��设置�?关（设置 �?通用�?*/
  handleTrusted<{ enabled: boolean }>("slime:settings:autostart:set", async (_event, p): Promise<{ ok: boolean; enabled: boolean; error?: string }> => {
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(p.enabled), path: process.execPath });
      const s = app.getLoginItemSettings({ path: process.execPath });
      return { ok: true, enabled: s.openAtLogin };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] 设置�?机自�?���?", e);
      return { ok: false, enabled: Boolean(p.enabled), error: msg };
    }
  });

  /** 卸载 Slime（�?�?�?通用）：�?�� NSIS 卸载器并�?出应�?*/
  handleTrusted<void>("slime:settings:uninstall", async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const exePath = app.getPath("exe");
      const uninstaller = join(dirname(exePath), "Uninstall Slime.exe");
      if (!existsSync(uninstaller)) {
        return { ok: false, error: `�?��到卸载程序（${uninstaller}）�?��?到�?�控制面�?�?程序」或安�?�?���?��行卸载器。` };
      }
      spawn(uninstaller, [], { detached: true, stdio: "ignore" }).unref();
      app.quit();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] �?��卸载器失�?", e);
      return { ok: false, error: msg };
    }
  });

  /* �?�? A-980-R26：系统�?�知 + �?��制提示音（�?�?�?通用�?�?�? */

  /** 读取通知配置（含�?��义音频是否存在�?��?�文件�?用户删掉时界面�?能提示） */
  handleTrusted<void>("slime:notify:get", async () => {
    const cfg = readNotifyConfig();
    const soundOk = cfg.soundFile ? Boolean(customSoundPath()) : false;
    return { ok: true, config: cfg, soundReady: soundOk };
  });

  /** 保存通知配置（局部合并：界面�?��改动的字段） */
  handleTrusted<Partial<{ enabled: boolean; soundEnabled: boolean }>>("slime:notify:set", async (_event, patch) => {
    try {
      const cfg = writeNotifyConfig({
        ...(typeof patch?.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(typeof patch?.soundEnabled === "boolean" ? { soundEnabled: patch.soundEnabled } : {}),
      });
      return { ok: true, config: cfg, soundReady: cfg.soundFile ? Boolean(customSoundPath()) : false };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 选择并�?入自定义提示音（拷进应用配置�?��；原文件之后删掉也不影响�?*/
  handleTrusted<void>("slime:notify:sound:pick", async () => {
    try {
      const soundOpts = {
        title: "选择提示音音频",
        properties: ["openFile"] as Array<"openFile">,
        filters: [{ name: "音�?文件", extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm", "opus"] }],
      };
      const r = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, soundOpts)
        : await dialog.showOpenDialog(soundOpts);
      if (r.canceled || !r.filePaths?.[0]) { return { ok: false, canceled: true }; }
      const res = importSound(r.filePaths[0]);
      return res.ok ? { ...res, config: readNotifyConfig() } : res;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 移除�?��义提示音（回落系统默认音�?*/
  handleTrusted<void>("slime:notify:sound:clear", async () => {
    const res = clearSound();
    return res.ok ? { ...res, config: readNotifyConfig() } : res;
  });

  /** 读出�?��义音频（data URL）�?��?�渲染层 new Audio() �?��/试听�?*/
  handleTrusted<void>("slime:notify:sound:data", async () => readSoundData());

  /** 发�?�一条测试�?�知（无视�?�开关，便于用户�??系统层�?�不通） */
  handleTrusted<void>("slime:notify:test", async () => {
    notifyUser({
      kind: "test",
      // A-1021：标题是**事件文�?**（�? notifyIdentity.ts 的分工�?明）�?
      // 用户要核对的「头部那行应用名」由 ensureNotificationIdentity() 注册�?DisplayName 决定�?
      // 不是这个字�? —�??�?以�?文里把�?看的地方点名说出来�??
      title: "通知测试",
      body: "请核对通知**头部那行应用名**是不是本程序的名字（不是 com.slime.gui）；提示音按你的设置播放。",
    });
    return { ok: true, config: readNotifyConfig() };
  });

  /* �?�? A-1108：全�?降级池（设置 �?通用�?�?�?
     背景：用户点名�?�我都没设置，哪来的全局降级池？」�?��??那份池是 engine 里硬编码�?
     「自动把其他�?有已配置供应商的�?��模型塞进降级链�?�，**不是**任何配置文件写的�?
     现在改为用户�?��义，默�?空（= 不跨供应商降级）�?
     ⚠️ 这里**不做**任何「补�?�?��认池」的事：空就�?��。任何贴心的默�?值都会�?同一句话
        �?���?��遍，而且会把用户的�?话悄悄发到他没同意过的供应商去�??
     ⚠️ 引擎侧每次解析路由都会重读这�?���?�?保存�?*下一条消�?��生效**，不�?要重�???*/

  /** 读取降级�?+ �??�供应商摘�?（界面�?「供应商 �?模型」两�?��拉，省一次往返） */
  handleTrusted<void>("slime:fallback:get", async () => {
    return { ok: true, entries: readFallbackPool().entries, providers: listProviders() };
  });

  /** 保存降级池（**整体替换**；形状在主进程侧再消毒一�?—�??不信任渲染层传来的数组） */
  handleTrusted<{ entries?: unknown }>("slime:fallback:set", async (_event, p) => {
    try {
      const next = writeFallbackPool({ entries: p?.entries });
      console.info(
        `[gui:main] 全局降级池已更新：${next.entries.length} 条`
        + (next.entries.length > 0 ? `（${next.entries.map((e) => `${e.provider}:${e.model}`).join(" → ")}）` : "（空 = 不跨供应商降级）"),
      );
      return { ok: true, entries: next.entries };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // �?�? LLM 网关（�?�?�?LLM 网关�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
  handleTrusted<void>("slime:llmgw:get", async () => {
    const cfg = readLlmGatewayConfig();
    const mgr = getLlmGatewayManager();
    const st = mgr.status();
    return { ok: true, config: cfg, status: st };
  });

  handleTrusted<LlmGatewayConfig>("slime:llmgw:set", async (_event, cfg) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.apply({
        enabled: Boolean(cfg?.enabled),
        port: typeof cfg?.port === "number" && cfg.port > 0 && cfg.port < 65536 ? Math.floor(cfg.port) : 19110,
        apiKey: typeof cfg?.apiKey === "string" ? cfg.apiKey : "",
        tokens: cfg?.tokens ?? mgr.listTokens(),
      });
      return { ...r, status: mgr.status() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  handleTrusted<void>("slime:llmgw:status", async () => {
    return getLlmGatewayManager().status();
  });

  handleTrusted<void>("slime:llmgw:restart", async () => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.start();
      return { ...r, status: mgr.status() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  // �?�? 令牌 CRUD（B 档：每令牌独立�?�率/日配�?模型白名单）�?�?�?�?
  handleTrusted<import("./llmGateway.js").NewTokenInput>("slime:llmgw:token:add", async (_event, input) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.addToken(input ?? {});
      return { ...r, status: mgr.status(), tokens: mgr.listTokens() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  handleTrusted<import("./llmGateway.js").UpdateTokenInput>("slime:llmgw:token:update", async (_event, input) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.updateToken(input ?? { key: "" });
      return { ...r, status: mgr.status(), tokens: mgr.listTokens() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  handleTrusted<{ key: string }>("slime:llmgw:token:remove", async (_event, input) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.removeToken(input?.key ?? "");
      return { ...r, status: mgr.status(), tokens: mgr.listTokens() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  handleTrusted<{ key: string; active: boolean }>("slime:llmgw:token:toggle", async (_event, input) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.toggleToken(input?.key ?? "", input?.active ?? false);
      return { ...r, status: mgr.status(), tokens: mgr.listTokens() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  /** 重置�?��数据：清�?Provider / Agent / 会话与历史（记忆文件保留）�?�渲染层�?先确�?*/
  handleTrusted<void>("slime:data:reset", async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      // 安全护栏：只允�?清空 PROJECT_ROOT/config/ 下的应用数据文件，绝不触碰其他目�?
      const cfgDir = resolve(PROJECT_ROOT, "config");
      const root = resolve(PROJECT_ROOT);
      if (!root || root === resolve(sep) || root === process.env.USERPROFILE || root === process.env.HOME) {
        return { ok: false, error: `数据根异常（${root}），已中止重�?��保护文件` };
      }
      // �?发仓库保护：PROJECT_ROOT 若为源码仓库（含 .git �?package.json+src/），
      // 说明运�?的是�?发版而非安�?版，重置会�?删开发机真实配置 �?直接拒绝
      const isDevRepo =
        existsSync(join(root, ".git")) ||
        (existsSync(join(root, "package.json")) && existsSync(join(root, "src")));
      if (isDevRepo) {
        return { ok: false, error: `检测到当前数据根是开发仓库（${root}），为保护开发配置已中止重置。请使用安装版（数据在 %APPDATA%\\slime-gui\\slime-data）执行重置。` };
      }
      const underConfig = (p: string): boolean => {
        const rp = resolve(p);
        return rp.startsWith(cfgDir + sep) || rp === cfgDir;
      };
      if (!underConfig(SESSIONS_PATH)) {
        return { ok: false, error: `会话文件�?��不在应用数据�?��内（${SESSIONS_PATH}），已中止重置` };
      }
      // 1) Agent：清历史 + 注销 A2A + 清空注册表并落盘
      const oldAgents = [...agentRegistry!.loadedAgents];
      for (const a of oldAgents) {
        try { await removeAgentHistory(a.id); } catch { /* 忽略单条失败 */ }
        try { a2aBus?.unregister(a.name); } catch { /* 忽略 */ }
      }
      agentRegistry!.loadedAgents.length = 0;
      await agentRegistry!.save();
      selectedAgentId = null;
      // 2) Provider 与本地模型注册：写空�?
      const pr = clearAllProviders();
      if (!pr.ok && pr.error) { return { ok: false, error: pr.error }; }
      engine?.refreshProviders();
      // 3) 会话（仅删除 config/sessions.json 单文件，�?��已校验在 config/ 内）
      try { if (existsSync(SESSIONS_PATH)) { rmSync(SESSIONS_PATH, { force: true }); } } catch { /* 忽略 */ }
      console.info(`[gui:main] �?��数据已重�?��仅限 ${cfgDir} 下：providers.enc.json / agents.json / history.jsonl / sessions.json）`);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] 数据重置失败:", e);
      return { ok: false, error: msg };
    }
  });
}

/**
 * 安全基线（官方清�?#18）：slime:// �?��义协�?���?file://�?
 * - registerSchemesAsPrivileged 必须�?app ready 之前调用（standard/secure 才能正确解析相�? URL�?
 * - protocol.handle �?Electron 25+ 正式 API（registerFileProtocol 已废弃）
 * - 解析后校验路径仍落在 rendererDir 内，防目录�?��??
 */
function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "slime", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** A-980：主进程协�?安全白名单�?��?�非 Web 协�?（bitbrowser://、mailto:…）�?律拦�?��
 *  防�? Chromium 把未�?scheme 交给系统协�?分发触发 Windows「获取打�?此链接的应用」弹窗�??
 *  slime:// 仅主窗口使用，单�?��行�??*/
function isWebSafeUrl(url: string): boolean {
  try {
    if (!url) { return true; }
    if (url === "about:blank" || url.startsWith("slime://")) { return true; }
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
    if (!m) { return true; } // �?scheme（相对地�?等）
    return ["http", "https", "about", "file", "data", "blob", "chrome", "chrome-extension"].includes(m[1].toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Chromium **内部**协�?：只�?��由内�?内置扩展�?��发起，操作系�?*永远没有**对应处理器�??
 *
 * ⚠️⚠️ 为什么必须有这条判据�?026-09-30 用户实测）：
 *  Chromium �?**PDF 查看器就�?���?���?���?*，它住在
 *  `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/�?，渲�?`<embed type="application/pdf">`
 *  时会�?*frame �?*导航到�?扩展地址。若把它当成"站点深链"处理�?
 *    �?`will-frame-navigate` �?`preventDefault()` �?**掐断查看器自�?��导航 �?PDF �?片空�?*�?
 *    �?�?`openExternalSafe()` 甩给系统 �?弹�?�无法打�? chrome-extension:// 链接—�?�系统未注册该协�??��??
 *  �?**必须放�?**（既不拦、也绝不交给系统）�??
 */
function isChromiumInternalScheme(url: string): boolean {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url ?? "");
  if (!m) { return false; }
  return ["chrome", "chrome-extension", "devtools", "view-source"].includes(m[1].toLowerCase());
}

/**
 * A-1133：`file:` URL �?�?��绝�?�?��（只认本机绝对路径；其余�?�?null）�??
 *
 * ⚠️ 必须�?`fileURLToPath` 而不�?���?`slice(7)`：中�?空格文件名在 URL 里是**百分号编�?*�?
 * （实测事故日志里那条就是 `�?0244222026-%E5%BC%A0%E8%8B%B4%E6%96%87�?ocx`）�??
 * 手写切片会把编码当成�?��的一部分 �?扩展名判定失�?�?下面那条"不�?把画不出来的�?��文件
 * 交给 Chromium"的判�?*静默失效**（判�?��己坏掉，比没有判�?��坏）�?
 */
/** A-1133：绝对路径判�?��文档通道拒绝相�?�?�� —�??它的�?��取决于工作目录，静默解析=�?��产地）�??*/
function isAbsolutePath(p: string): boolean {
  try { return isAbsolute(p); } catch { return false; }
}

function localPathOfFileUrl(url: string): string | null {
  try {
    if (!url || !url.toLowerCase().startsWith("file:")) { return null; }
    const p = fileURLToPath(url);
    if (!p) { return null; }
    // �?��受绝对路径（Windows `D:\�? / UNC / POSIX `/�?）�?��?�相对路径不该出现在 file: URL �?
    return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/") ? p : null;
  } catch { return null; }
}

/**
 * A-1133�?*下载闸门**（唯�?产地）�?��??绝不�?Chromium �?�?��文件"默默写进用户磁盘�?
 *
 * 事故里那半句「�?应文件夹�?��生成无效文件」就�?��里漏出来的：**slime 全仓没有任何
 * `will-download` 处理�?* �?�?Electron 默�?行为 �?把文�?*直接写进下载�?��**�?
 * 重名�?��加序号�?�不询问。�??把不能渲染的�?��文件当下�?恰恰�?Chromium �?`.docx`
 * 这类类型的默认�?�?�?每�?重试都落�?�?��成品文件�?
 *
 * ⚠️ 判据�?���?*�?��文件**这条�?��`http(s)` 的�?常下载不受影响（右栏浏�?器点下载链接仍照旧）�?
 *    �?�?切�?掉全部下载会顺手弄坏"网页里下载文�?这个正当功能�?
 * ⚠️ 取消之后必须**出声**（�?�知渲染层），否则用户只会看�?点了没反�?�?
 */
function guardLocalFileDownloads(sess: Electron.Session): void {
  sess.on("will-download", (_event, item) => {
    const localPath = localPathOfFileUrl(item.getURL());
    if (!localPath) { return; }
    item.cancel();
    try {
      mainWindow?.webContents.send("slime:docs:local-file", {
        path: localPath,
        reason: "本地文件不会被当成「下载」写进磁盘（那会把文件夹塞满重复的半成品文件）。",
      });
    } catch { /* 忽略 */ }
  });
}

/** A-980-R3�?*�?���?*打开外部链接通道—�?�先探测系统�?��注册了�?协�?处理�?��
 *  已注册（装了对应客户�?���?`shell.openExternal` 交给系统应用**真�?打开**�?
 *  �?���?�?返回诊断（绝�?openExternal，避�?Windows「获取打�?此链接的应用」系统�?）�??
 *  A-980-R4：浏览器类协�?��bitbrowser:// 等）**永远返回失败**—�?�即使系统注册了对应浏�?器也
 *  不唤起：这类链接的目的是把另�?款浏览器拉起来加载页�?云控指令，BitBrowser 收到
 *  `bitbrowser://cc` 这类指令�?��打不�?，会在界面顶部弹黄色�?��报错（用户痛批的丑弹窗）�?
 *  �?有�?部打�?（webview 深链�?�� / slime:http:open IPC / iframe 深链）都必须走这里�??*/
async function openExternalSafe(url: string): Promise<{ ok: boolean; handler?: string; reason?: string }> {
  /* ⚠️⚠️ **Chromium 内部协�?�?律拒�?*，绝不去�?��统�?�更�?`openExternal`�?
     `chrome-extension://`（PDF 查看器等内置扩展）�?�`devtools://`、`view-source:` 在操作系统里
     **永远没有处理�?*；调�?`openExternal` �?���?Electron �?
     「无法打�? �?链接—�?�系统未注册该协�??�的系统框（2026-09-30 用户实测�?��）�??
     ⚠️ 这条�?`isWebSafeUrl` 放�? `chrome-extension` �?*�?�?*：那边�?它别�?���?
        这边保证即使有别的路径把它�?�到这儿，也�?��**安静地拒�?*，不会弹系统框�??*/
  if (isChromiumInternalScheme(url)) {
    return { ok: false, reason: "internal-scheme" };
  }
  if (isBrowserSchemeUrl(url)) {
    return { ok: false, reason: "browser-scheme" };
  }
  try {
    const info = await app.getApplicationInfoForProtocol(url);
    const handler = info && typeof info === "object" ? (info as { name?: string }).name : undefined;
    if (handler) {
      await shell.openExternal(url);
      return { ok: true, handler };
    }
  } catch { /* 探测失败按未注册处理 */ }
  return { ok: false, reason: "空链接" };
}

function registerProtocolHandler(): void {
  const rendererDir = resolve(__dirname, "../renderer");
  protocol.handle("slime", (request) => {
    const urlPath = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
    const safePath = resolve(join(rendererDir, urlPath || "index.html"));
    if (!safePath.startsWith(rendererDir + sep)) {
      return new Response(null, { status: 403 });
    }
    return net.fetch(pathToFileURL(safePath).toString());
  });

  app.on("web-contents-created", (_event, webContents) => {
    // A-980：任�?webContents（含 <webview> 客页、授权子窗口）�?�?重定向到**�?Web 协�?**
    // （bitbrowser://、mailto: 等）�?�?preventDefault—�?�这�?renderer �?will-navigate 守卫
    // �?*�?���?*：renderer 脚本�?旦漏拦，Chromium 会把�?�� scheme 交给系统协�?分发 �?
    // Windows 弹�?�获取打�?�?xxx'链接的应用�?��?�主进程兜底保证弹窗绝不�?��出现�?
    webContents.on("will-navigate", (e, url) => {
      // A-980-R12：slime://open?u=�?�?��染层"新建页跳�?桥（站点按钮 window.open/target=_blank �?
      // 注入钩子�?��），**必须放�?**�?renderer �?will-navigate 守卫拦截并新建右栏页；�?�?preventDefault
      // 会连 renderer 事件�?起取�?�?新建页跳�?��次失效（用户实测"还是无法新建浏�?器页跳转"的根因之�?）�??
      if (url.startsWith("slime://open?u=")) { return; }
      /* ══ A-1133：本地文件只�?能渲染的类型"才允许�?�?��**类级兜底**�?══════════════════
         事故：把 .docx 拖到页面�?= Chromium **原生**导航�?`file:///�?ocx`（浏览器默�?行为�?
         代码里没有这�?URL 字�?串），�??.docx 不是它能渲染的类�?�?`ERR_FAILED (-2)`
         �?重试通道（安全网/地址写回）反复重�?�?无休止刷�?+ 界面�?�� + 文件垃圾�?
         这里�?��外层兜底：即使某条入口漏了（右栏地址栏�?�Agent 工具、拖放落�?guest 上）�?
         也不允�?�?Chromium 画不出来的本地文�?交给它加载�??
         ⚠️ 拦下之后**必须给用户交�?*（�?�知渲染层走文档通道），不�?静默 preventDefault —�??
         静默的表现就�?拖进来没反应"，�?�?��户最初报的症状�??*/
      const localPath = localPathOfFileUrl(url);
      if (localPath && !isNavigableLocalFile(localPath)) {
        e.preventDefault();
        mainWindow?.webContents.send("slime:docs:local-file", { path: localPath, reason: nonNavigableReason(localPath) });
        return;
      }
      if (!isWebSafeUrl(url)) {
        e.preventDefault();
        return;
      }
      // A-918++ �??「GitHub 登录输入密码后无响应」：此前对所�?webContents 无条�?preventDefault�?
      // �?GitHub 授权窗口/内嵌 webview 的登录成功重定向也拦死了（停在原地看似无响应）�??
      // 现在仅阻�??�主窗口】�?�?���?slime:// 的�?部地�?；webview / 授权子窗口放行�??
      if (webContents === mainWindow?.webContents && !url.startsWith("slime://")) {
        e.preventDefault();
      }
    });
    // 服务�?302/301 跳转到未知协�?��样拦�?��will-navigate 不�?盖重定向�?���?
    webContents.on("will-redirect", (e, url) => {
      if (!isWebSafeUrl(url)) {
        e.preventDefault();
      }
    });
    // A-980-R3�?*frame �?*深链拦截—�?�will-navigate/will-redirect �??盖顶层�?�?��站点�?
    // "打开客户�?逻辑常放�?iframe 或脚�?��态创建的链接内（�?frame 导航到�?部协�?��会触�?
    // will-navigate �?Chromium 直接交系统分�?�?�?��册就弹系统�?）�?�will-frame-navigate 覆盖
    // 任意 frame：非 Web 协�? preventDefault 后经 openExternalSafe 真实打开（确认是否�?了�?户�?）�??
    webContents.on("will-frame-navigate", (details) => {
      const url = details?.url ?? "";
      if (isWebSafeUrl(url)) { return; }
      try { details.preventDefault(); } catch { /* 忽略 */ }
      void openExternalSafe(url).then((r) => {
        if (!r.ok) {
          try {
            // �?���?�?通知渲染层�?�需安�?对应客户�??�（banner），绝不让系统�?出现
            mainWindow?.webContents.send("slime:browser:popup-notice", { url, ts: Date.now(), kind: "need-install", scheme: (url.split(":")[0] || "").toLowerCase() });
          } catch { /* 忽略 */ }
        }
      });
    });
    webContents.setWindowOpenHandler(({ url }) => {
      // A-980-R11：站�?新建页跳�?（window.open / target=_blank）不再静默失败�?��??
      // webview 已加 allowpopups，guest 的开窗�?求会到达�?handler。web URL �?律在
      // slime 右栏**新浏览器�?*打开（send slime:sidebar:open �?renderer 新建/复用 tab）；
      // �?Web 协�?保持拒绝 + 通知（renderer 协�?�??�?/ 缺应用诊�?��。窗口本�?*绝不
      // 真实创建**（return deny）�?��?�防站点弹系统新窗抢焦点、阻�?Agent 工具�?��
      // （A-980-R 用户实测「中途弹出的登录弹窗，不关就得卡死�?�）�?
      try {
        if (url.startsWith("slime://open?u=")) {
          // 旧注入钩子（slime://open 桥）的兼容分�?��解析出真实网�?再开页�??
          // A-975-R3 起钩子已整体撤除，这里只作历史兜底保留�??
          try {
            const u = new URL(url).searchParams.get("u");
            if (u && /^https?:\/\//i.test(u)) {
              mainWindow?.webContents.send("slime:sidebar:open", { kind: "url", url: u, name: "", from: "site" });
            }
          } catch { /* 忽略 */ }
          return { action: "deny" };
        }
        if (isWebSafeUrl(url)) {
          // ⚠️ A-975-R4：站点弹窗必须带 from:"site" —�??渲染层据此做**弹窗风暴限流**�?
          // 站点广告会在计时器里连续 window.open，�?�右栏浏览器页是常驻挂载（webview 不卸载）�?
          // 每弹�?�?��多一�?��驻重页面 �?内存暴涨、渲染进程卡死（用户实测"浏�?器什么都点不�?）�??
          mainWindow?.webContents.send("slime:sidebar:open", { kind: "url", url, name: "", from: "site" });
        } else {
          mainWindow?.webContents.send("slime:browser:popup-notice", { url, ts: Date.now(), kind: "need-install", scheme: (url.split(":")[0] || "").toLowerCase() });
        }
      } catch { /* 忽略 */ }
      return { action: "deny" };
    });
  });

  // A-980-R2：深度链接�?�真实打�?」�?��?�拦�?�� bitbrowser:// 等非 Web 协�?时，**不再屏蔽**�?
  // 而是先探测系统是否注册了该协�??理器：已注册（用户安�?BitBrowser 等�?户�?后自动注册）�?
  // 调系统协�?���?*真�?打开链接**（弹窗报错消失�?�链接意图达成）；未注册 �?返回明确诊断
  // 「需要安�?xxx 客户�??�，由渲染层提示用户，绝不弹系统对话框�?�绝不静默卡住�??
  ipcMain.handle("slime:protocol:open", async (_ev, raw: unknown) => {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url) { return { ok: false, reason: "空链接" }; }
    const scheme = (url.split(":")[0] || "").toLowerCase();
    // Web 链接不走系统协�?分发（应由浏览器页�?�?��，防止�?滥用为�?部打�?
    if (isWebSafeUrl(url)) { return { ok: false, reason: "web" }; }
    const r = await openExternalSafe(url); // A-980-R3：统�?走�?�探测→已注册才打开」�?�道
    return r.ok ? { ok: true, url, scheme, handler: r.handler } : { ok: false, url, scheme, reason: r.reason ?? "空链接" };
  });
}

function main(): void {
  registerSchemePrivileges(); // 必须先于 app ready

  // A-918++：去�?User-Agent 里的 Electron/slime 标识（伪装标�?Chrome），
  // 避免 GitHub 等站点�?测到非标准浏览器而阻�?���?授权
  app.userAgentFallback = (app.userAgentFallback || "")
    .replace(/\sElectron\/[\d.]+/g, "")
    .replace(/\sslime\/[\d.]+/g, "")
    .trim();

  // V8 字节码缓存（VS Code 同�?策略）：把�?次编译的渲染�?bundle 结果落盘复用�?
  // 跳过重�?�?��时的重新编译，明显缩�?��次启动时�?
  app.commandLine.appendSwitch("v8-cache-options", "code");

  // A-980-R：�?�?Chromium �?ExternalProtocolDialog 特�?��?��??*系统级绝�?**�?
  // 即便�?��某条导航绕过全部 will-navigate/will-redirect 守卫抵达系统协�?分发�?
  // �?��协�?（bitbrowser:// 等）�?*不会再弹** Windows「获取打�?此链接的应用」�?话�?
  // （无注册应用则静默失败不打扰）�?�与既有守卫构成双脚架：守卫�?导航到达 OS 层之�?
  // 拦掉，�?�?关保�?即使漏网�?OS 层也绝不弹窗"�?
  app.commandLine.appendSwitch("disable-features", "ExternalProtocolDialog");

  // A-980-R4（修�?R3 反�?义）�?*不再显式设置 proxy-bypass-list �?<-loopback>**�?
  // 实测核验（Microsoft Docs + Chromium net/docs/proxy.md + 多源复证）：Chromium �?Chrome 72 �?
  // �?loopback�?27.0.0.1/8、localhost、[::1]�?69.254/16）有**隐式绕过代理直连**规则�?
  // 且�?隐式规则无法�?��统代�?PAC 覆盖；�??`<-loopback>` 的�?义恰恰是**禁用这个隐式绕过�?
  // 强制 loopback 走代�?*（Dev Proxy 等工具用它来�?�� localhost）�?�上�?版把它当"强制直连"�?
  // 方向写反了�?��?�用户一旦开 Clash 全局代理，�?行会�?127.0.0.1:8081 的�?求强行丢进代�?�?白屏�?
  // 正确做法 = �?么都不做（默认即直连）�?�若�?���?显式兜底，应写普通条�?127.0.0.1;localhost，不要用尖括号�?法�??

  // A-980-R5（GPU 白屏根治）：**默�?不再禁用 GPU**。实弹�?照验证（同机 Electron 35 webview 加载
  // 127.0.0.1:8081）：disable-gpu + disable-gpu-sandbox �?capturePage 返回 **0 字节、整窗无像素**
  // （webview 网络导航全部成功但内容完全不绘制 �?白屏无错�?��；克 GPU 时页面�?常绘制�??
  // 此前"部分机器 GPU 崩溃 exit_code=-1"的�?避本�?��部分�??制�?�了持续白屏（含 Agent 打开
  // �?�� HTTP 服务"其他浏�?器能�?、slime 白屏"的经典症状）。改为默认启�?GPU，保留�?�生�?��
  // �??变量 SLIME_DISABLE_GPU=1 时仍回�??�?��染（仅个�?��溃机器需要）�?
  if (process.env.SLIME_DISABLE_GPU === "1") {
    app.commandLine.appendSwitch("disable-gpu");
    app.commandLine.appendSwitch("disable-gpu-sandbox");
  }

  // 统一应用名：安�?器写 HKCU Run 值名 "Slime"，�??setLoginItemSettings �?app.getName()
  // 作�?�名（默认取 package.json name = "slime-gui"）�?��?�不同名会�?致�?�?��关与安�?勾�?�不同�?�?
  // 注意：boot.ts 已在模块加载时用 app.getPath("userData") 解析数据根（%APPDATA%\slime-gui），
  // 此�? setName 不会改变已解析的 userData �?���?
  app.setName("Slime");

  /**
   * A-1092：任务栏图标异常的真实根�?—�??**AUMID 与安装版不一�?*�?
   *
   * 症状（用户截图）：任务栏�?slime 的图标是「一�?��色的空�? / 默�?兜底图标」，而托盘里那张�??的�??
   *
   * 判据链：
   *   �?Windows 任务栏按 **AppUserModelID** 把窗口归组并取图标；
   *   �?安�?版（NSIS）建立的�?��方式�?`System.AppUserModel.ID = com.slime.gui`�?
   *      �?*进程�?��**�?`whenReady` 之前从未声明过身份，Electron 用的�?���?AUMID
   *      （等�?exe �?�� `/path/to/Slime.exe`）�?��?�两者不匹配�?
   *   �?不匹�?�?任务栏不套用安�?版快捷方式的图标，只能拿窗口�?`icon` 兜底�?
   *      而窗�?`icon` �?`resolveAppIcon()` �?Windows 上是 `build/icon.ico`�?
   *      它由 `make-notify-icon.mjs` �?1024² 大图**降采�?*而来。小尺�?�?6/24/32）降采样�?
   *      细节全糊成一片白，�?觉上就是「异常图标�?��??
   *   �?托盘那张看起来�?常，�?��为托盘走的是 Windows �?��的缩放�?线（对同�?张源图在不同尺�?�?
   *      的�?理与任务栏不同）—�??*同一份资产�?�两种渲染路�?*，这正是"�?处好�?处坏"的根源�??
   *
   * �?��：把�?��**提前且显�?*声明（`app.setAppUserModelId` �?��等的，`initNotify` 里那次保留，
   * 保证通知�?��即使将来早于�??执�?也不会丢�?��）�?�窗口图标显式�?�?`nativeImage` 而非�?���?
   */
  app.setAppUserModelId(APP_AUMID);

  // 单实例锁：重复启�?残留实例时聚焦已有窗口�?�非再开�?�?��窗进程�??
  // 否则�?���?��例会�?SLIME_PORT(19000) �?��竞争 + Electron cache �?`拒绝访问`)
  // 而不显示窗口，表现为"安�?后打不开"。拿到锁失败即�??出，交由已有实例接�?�?
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    console.warn("[gui:main] 已存�?Slime 实例，�??出本进程（聚焦已有窗口）");
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) { mainWindow.restore(); }
      mainWindow.focus();
      mainWindow.show();
    }
  });

  // CDP 远程调试�?��（仅�?发环境开�?��便于 agent-browser �?��化接入）�?
  // 安全：以 app.isPackaged 判定—�?�构建产物中 process.env.NODE_ENV 不做静�?�替�?��运�?时未设置�?
  // 旧判定会让�?式包默�?�?�?9222，本机任意进程可附到渲染层执行任�?JS、�?取全�?IPC 流量�?
  // ⚠️ A-1110：�?�?*不再�?���?9222**。Chromium �?devtools http server **不会�?��换�?�?*�?
  //   9222 �?��（上�?�?dev 实例没�??干净 / 另一�?userData �?��的实�?/ agent-browser 之类�?
  //   工具�?���?�? 9222）时�?�� bind 失败，在调试面板刷出那两�?
  //   `�?ind() returned an error�?0x2740)` + `Cannot start http server for devtools`�?
  //   并�?整�? CDP 能力**静默消失**（verify-packaged / agent-browser 全哑）�??
  // 选择逻辑（env 覆盖 �?占用顺延 �?临时�?�� �?落盘发布）全�?`devtoolsPort.ts`（唯�?出�?）�??
  // ⚠️ 必须在这里（`ready` 之前）appendSwitch —�??ready 之后再调�?*不生�?*�?
  //   而那正是「探针必须同步�?�的原因（�?该模块文件头）�??
  const devtoolsDecision = app.isPackaged
    ? null
    : resolveDevtoolsPort(process.env[DEVTOOLS_PORT_ENV], listeningPortsSync());
  if (devtoolsDecision) {
    app.commandLine.appendSwitch("remote-debugging-port", String(devtoolsDecision.port));
    // 出声：�?口会�?�?默�?值不再可信，变了必须能�?看�?（�?�文�?老习�?��的都�?9222�?
    if (devtoolsDecision.reason === "shifted") {
      console.warn(`[gui:devtools] ${devtoolsDecision.preferred} 已�?占用 �?CDP �?��顺延�?${devtoolsDecision.port}`);
    } else if (devtoolsDecision.reason === "ephemeral") {
      console.warn(`[gui:devtools] ${devtoolsDecision.preferred} 及其�?${DEVTOOLS_PORT_SCAN} �??口均�?���?�?交系统分配临时�?口（真实�?���?DevToolsActivePort）`);
    } else if (devtoolsDecision.explicit) {
      console.log(`[gui:devtools] CDP �?�� ${devtoolsDecision.port}（来�?${DEVTOOLS_PORT_ENV}）`);
    }
  }

  app.whenReady()
    .then(async () => {
      // 先建窗口立即出�?屏，后�? sidecar 并�?�?��（渲染层�?��加载面板展示进度�?
      registerProtocolHandler();
      // A-980-R13：给 webview �?�� session（persist:slime-browser）注�?slime:// 处理器�?��??
      // app �?protocol.handle 对独�?partition **不生�?*，用户实�?webview 导航 slime:// 仍弹
      // Windows「获取打�?�?slime'链接的应用�?��?�会话级注册后�?导航�?Electron 接�?�?04 空响应）�?
      // 不再落到系统协�?分发 �?系统弹窗根除；�?常路径仍�?renderer will-navigate 拦截新建右栏页�??
      try {
        session.fromPartition("persist:slime-browser").protocol.handle("slime", () => new Response(null, { status: 204 }));
      } catch { /* 忽略 */ }
      /* A-1133：下载闸门�?�?*两个** session 上（右栏 webview 用的�?���?partition�?
         �?? defaultSession 会漏掉真正出�??的那条路 —�??"同物异形"）�??*/
      try { guardLocalFileDownloads(session.defaultSession); } catch { /* 忽略 */ }
      try { guardLocalFileDownloads(session.fromPartition("persist:slime-browser")); } catch { /* 忽略 */ }
      createWindow();
      // A-1110�?*发布实际 CDP �?��**。�?口现在会变（占用顺延），而�?部工具（verify-packaged /
      // agent-browser）历史上都写�?9222 �?不发布就等于把它�?��悄弄坏�??
      // `port === 0` 时真值由 Chromium 写在 `<userData>/DevToolsActivePort`，所以轮询几帧再落盘�?
      // ⚠️ 落盘与上面的日志�?*两条�?��的发现路�?*（日志给坐在终�?前的人，文件给脚�?���?
      if (devtoolsDecision) {
        void (async () => {
          let actual: number | null = null;
          if (devtoolsDecision.port === 0) {
            const activePath = join(app.getPath("userData"), "DevToolsActivePort");
            for (let i = 0; i < 25 && actual === null; i++) {
              try { actual = parseDevToolsActivePort(readFileSync(activePath, "utf8")); } catch { /* 还没写出�?*/ }
              if (actual === null) { await new Promise((r) => setTimeout(r, 100)); }
            }
          }
          const file = writeDevtoolsPortFile(app.getPath("userData"), devtoolsDecision, actual);
          if (file) {
            console.log(`[gui:devtools] CDP 端口 ${actual ?? devtoolsDecision.port} 已发布到 ${file}`);
          }
        })();
      }
      // A-1055：托盘常�?—�??应用�?起来就出现在系统托盘栏（用户要求"�?? slime 打开就直接出现图�?）�??
      // 不再依赖"关闭窗口时是否后台模�?这个条件（那正是"要的时�?�没�?的根因）�?
      ensureTray();
      // A-984：主进程卡�?看门狗（用户实测过一�?界面点按�?��反应"，当时只能从
      // audit.jsonl 停�?写入反推主进程�?�?�� —�??没有日志就无法归因，故补这个探针�?
      startMainWatchdog();
      markMainActivity("app ready");
      // A-986：意外�??出保�?—�??判定上�?�?��异常�?出（run.lock 残留�? 清掉残留临时文件 + 留证�?
      // 然后写下�??的运行标记（强杀时它不会�?��，下次启动即�?��此判定）
      {
        const sweep = sweepAfterCrash();
        if (sweep.abnormalExit) {
          console.warn(`[gui:main] �?测到上�?异常�?出（清障：临时文�?${sweep.removedTmp} �?��；�?�?data/crash-report.log`);
        }
        markRunning(app.getVersion());
      }
      app.on("will-quit", () => { markCleanExit(); });
      // �?��模型生命周期管理�?��llama-server：BGE 嵌入 / 对话 GGUF），解析�?slime.toml [model_server]
      initModelServerManager();
      /* A-1018：内嵌浏览器（右侧栏 <webview>，分�?persist:slime-browser）的广告/跟踪器拦�???
         装在该分区上而不�?defaultSession —�??�?��用于我们的内嵌浏览器，不影响主进程自�?��网络请求�?
         默�?�?�?��`config/adblock/settings.json` �?`enabled:false` �?���?
         更�?规则�?`config/adblock/*.txt`（EasyList 派生的域名形态即�?��。�?�?adblock.ts 头注释�??*/
      installAdBlocker(session.fromPartition("persist:slime-browser"), PROJECT_ROOT);
      registerIpcHandlers();
      // A-1049：�?�?�� Agent 时�?�?��认�?�助手�?�，让�?迎页输入框�?�快捷按�??�Agent 选择器全部可�?
      void ensureDefaultAgent();
      registerUpdaterHandlers(); // 注册�?��更新 IPC handler
      // 更新状�?�推送到渲染进程（StatusPanel 监听 slime:update:status�?
      setStatusSink((s) => mainWindow?.webContents.send("slime:update:status", s));
      initUpdater();             // 延迟�?查更新（不阻塞�?屏）
      // �?��状�?�推送到渲染进程（启动加载面�?slime:boot:event�?
      setBootSink((s) => mainWindow?.webContents.send("slime:boot:event", s));
      // A-1043：重初�?化改�?*�?��期后台�?�?*�?
      // 以前它的�?��触发点是渲染�?IPC（agents/sessions 两个 list）→ 首屏数据�?��条初始化�?
      // 挡住�?s 兜底门一放�?就是"左栏空白、跟刚下载一�?。现在�?屏只等轻量注册表
      // （`slime:agents:list` / `slime:sessions:list` �?`ensureRegistry()`），重活在这里并行跑�?
      // 单�?保证�?���?遍�?��?�?��败不影响首屏（�?话时会按�?重试）�??
      void ensureServices().catch((e) => {
        console.warn("[gui:main] 后台预热失败（�?屏不受影响，对话时会按需重试�?", e);
      });
      void startPythonBackend(); // 并�?�?��，不阻�?窗口
      // LLM 网关�?���?��：配�?enabled 时随应用�?��（auth token �?���?�� fallback，网关�?点用�?�� key�?
      void (async () => {
        try {
          const cfg = readLlmGatewayConfig();
          if (cfg.enabled) {
            const r = await getLlmGatewayManager().start();
            if (!r.ok) { console.warn("[gui:main] LLM 网关�?��失败:", r.error); }
          }
        } catch (e) {
          console.warn("[gui:main] LLM 网关�?���?��异常:", e);
        }
      })();
      // dev 模式优先�?electron-vite dev server（渲染层�?��新实时生效）�?
      // �?dev server 时（生产/直接 electron .）回�? slime:// 协�?读�?盘产�?
      const devUrl = process.env.ELECTRON_RENDERER_URL;
      if (devUrl) {
        await mainWindow?.loadURL(devUrl);
        mainWindow?.webContents.on("did-finish-load", () => {
          console.info(`[gui:main] 渲染层已加载 (dev server: ${devUrl})`);
        });
      } else {
        mainWindow?.loadURL("slime://./index.html");
        mainWindow?.webContents.on("did-finish-load", () => {
          console.info("[gui:main] 渲染层已加载 (slime://)");
        });
      }
    })
       .catch((e) => { console.error("[gui:main] �?��失败:", e); process.exit(1); });

  // A-975：主进程兜底—�?�渲染进程崩�?主进程未知异常全部落盘（不�??出�?�静默�?错）�?
  // 便于用户�?data/logs/main-errors.log 里�?�?�?error 贴出来精�?��位（DeepSeek 白屏调查�?��）�??
  const logMainError = (tag: string, err: unknown): void => {
    try {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      const dir = resolveExtra("../data/logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "main-errors.log"), `${new Date().toISOString()}\t[${tag}]\t${msg}\n`, { flag: "a" });
      console.error(`[gui:main] ${tag}:`, msg);
    } catch { /* 兜底失败的兜�?*/ }
  };
  process.on("uncaughtException", (err) => { logMainError("uncaughtException", err); });
  process.on("unhandledRejection", (reason) => { logMainError("unhandledRejection", reason); });

  app.on("window-all-closed", () => {
    terminatePythonBackend();
    silamBrain?.close();
    silamBrain = null;
    void terminateModelServer();
    if (process.platform !== "darwin") { app.quit(); }
  });
  app.on("before-quit", () => {
    appIsQuitting = true;
    tray?.destroy(); tray = null;
    terminatePythonBackend();
    silamBrain?.close();
    silamBrain = null;
    void terminateModelServer();
    void getLlmGatewayManager().stop(); // 停�? LLM 网关，释放�?�?
    // A-918++：�??出前清理�?�?HTTP 静�?�服务，释放�?��
    try { httpServer.stopAll(); } catch { /* 忽略清理异常 */ }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
  });
}

void main();

// —�??Python backend sidecar —�??
let pythonBackend: ChildProcess | null = null;
const SLIME_PORT = process.env.SLIME_PORT || "19000";

/** A-965 core-ts↔server 通报：SILAM 情绪/成长�?�?slime_server /agents/{id}/evolve 驱动人格演化�?
 *  fire-and-forget：token 缺失 / 请求失败�?律静默（server �?��、鉴权失败均不阻塞�?话）�?
 *  节流：同 agent 5 分钟内至多�?�报�?次（�?engine persistSilamAffect 节流对齐）�??*/
const silamEvolveThrottle = new Map<string, number>();
function notifySilamEvolve(agentId: string, state: SilamAffectState): void {
  void (async () => {
    try {
      const signals = buildSilamTraitSignals(state);
      if (signals.length === 0) {
        return;
      }
      const now = Date.now();
      if (now - (silamEvolveThrottle.get(agentId) ?? 0) < 5 * 60 * 1000) {
        return;
      }
      silamEvolveThrottle.set(agentId, now);
      let token: string | null = null;
      try {
        // �?Python 同源：decryptRaw 内部�?ensurePassphrase �?~/.slime_pass 解密 auth_token.enc
        token = decryptRaw("config/auth_token.enc");
      } catch {
        token = null;
      }
      if (!token) {
        return; // 无�?�?token（server 尚未生成 auth_token.enc）→ 静默跳过
      }
      const port = process.env.SLIME_PORT || "19000";
      const res = await fetch(
        `http://127.0.0.1:${port}/agents/${encodeURIComponent(agentId)}/evolve`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ success: true, trait_signals: signals }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) {
        console.warn(`[gui:silam-evolve] 通报失败 HTTP ${res.status}（agent=${agentId}）`);
      }
    } catch {
      /* 通报失败静默：不影响对话 */
    }
  })();
}

/** �?��状�?�回调（渲染层启动加载面板消费） */
type BootStatusSink = (s: { phase: string; backendReady: boolean; message?: string }) => void;
let bootSink: BootStatusSink | null = null;
/** �?近一次启动状态（渲染�?invoke 查�?�?��错过 push 事件时兜底） */
let bootQuery: { phase: string; backendReady: boolean; message?: string } | null = null;
export function setBootSink(fn: BootStatusSink | null): void {
  bootSink = fn;
}
function emitBoot(s: { phase: string; backendReady: boolean; message?: string }): void {
  bootQuery = s;
  bootSink?.(s);
}

/** 安�?根：**应用�?��资源**（build/icon.png、data/、config/、Knowledge/�?*/
function resolveExtra(subpath: string): string {
  return join(INSTALL_ROOT, subpath);
}

/**
 * 随包资源根：`llama.cpp/`、`runtime/venv/`、`models/`、`slime_server.py`、`requirements.txt`�?
 *
 * ⚠️ �?`resolveExtra` �?*两个不同的根**，混用就�?运�?�??怎么都�?测不�?的根因：
 * 打包模式下两者相等（extraFiles 都落到安装根），但开发模式下随包依赖留在**项目�?*
 * （prepare-runtime 的落点�?�也�?core-ts PROJECT_ROOT / mind_config / downloader 用的那个），
 * 而应用自�?��源在 `gui/`。过去随包资源走 `resolveExtra` �?全部落在 `gui/�? �?齐报缺失�?
 *
 * 判断"该用�?��"�?���?件事�?*这个文件�?electron-builder `extraFiles.from: "../�?` �?��的吗**�?
 * �?�?�?��数；`build/icon.png`、`data/`、`config/` 这类应用�?��资源 �?`resolveExtra`�?
 */
function resolveBundled(subpath: string): string {
  return join(BUNDLE_ROOT, subpath);
}

async function startPythonBackend(): Promise<void> {
  emitBoot({ phase: "backend", backendReady: false, message: "正在启动本地后端服务…" });
  // 定位 Python venv（Windows: Scripts/python.exe，Linux/macOS: bin/python�?
  const venvSub = process.platform === "win32" ? "Scripts" : "bin";
  const venvPyName = process.platform === "win32" ? "python.exe" : "python";
  const venvPython = resolveBundled(join("runtime", "venv", venvSub, venvPyName));

  const serverScript = resolveBundled("slime_server.py");
  if (!existsSync(venvPython) || !existsSync(serverScript)) {
    console.warn("[gui:backend] Python backend not found, running without server");
    emitBoot({ phase: "degraded", backendReady: false, message: "后端组件缺失，将以受限模式运行" });
    return;
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    SLIME_PORT,
    /* A-1101：把 python 管道编码**显式钉成 UTF-8**，与下面 `data.toString()` 的解码口�?*成�?**�?
     * ⚠️ 诚实记录（本机实测）：这台机器的系统已启用�?�Beta: UTF-8」⇒ venv 解释�?3.12.9)�?管道
     * 写的**�?��就是 utf-8**（`sys.stdout.encoding = utf-8`）⇒ �?�� cmd 里看到的乱码**不是**这一层，
     * 而是**终�?渲染�?*（控制台代码�?CP936 收到 UTF-8 字节）�?��??那一层归
     * `gui/scripts/dev-utf8.mjs` �?`chcp 65001` 管�??
     * 那这两个变量还�?不�?？�? —�??这是**部署面加�?*：默认编码跟解释器版�?��系统设置�?
     * （未�? UTF-8 模式�?Windows �?`locale.getpreferredencoding(False)` = cp936），
     * �?旦写解两侧口径错�?就是**双重乱码**且极难归因�?�显式钉�?= 两层口径从�?不随�??漂�??
     * ⚠️ �?���?�?= 更彻底的乱码 —�??改这里必须同时核�?`data.toString()` 的解码参数�??*/
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  if (process.platform !== "win32") {
    // Linux/macOS：llama-server 动�?�库加载（随包布�?：资源根/llama.cpp/build/bin�?
    const libDir = resolveBundled(join("llama.cpp", "build", "bin"));
    env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
  }
  // �?detached：�? python sidecar 随主进程生命周期结束（否则主程序�?�?崩溃后其
  // 僵尸进程仍占�?SLIME_PORT(19000)，下次启动报 [Errno 10048] 绑定失败，且就绪
  // �?测会�??旧僵尸服务的 /health 而假�?已就�?）�??
  pythonBackend = spawn(venvPython, [serverScript], {
    env,
    windowsHide: true,
  });

  pythonBackend.stdout?.on("data", (data) => {
    console.info(`[slime-server] ${data.toString().trim()}`);
  });
  pythonBackend.stderr?.on("data", (data) => {
    console.error(`[slime-server:err] ${data.toString().trim()}`);
  });

  // 等待服务就绪（最�?10 秒；超时不再阻�?主窗口�?��?�渲染层加载面板展示�?��
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://localhost:${SLIME_PORT}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.info("[gui:backend] slime_server.py 已就绪");
        emitBoot({ phase: "ready", backendReady: true, message: "后端服务已就绪" });
        return;
      }
    } catch {}
  }
  // A-1048�?0 秒没就绪**不等�?*起不�?—�??Windows �?Python 首�?导入（tools/skills/a2a
  // �?�?import + �?能扫描）经常超过 10 秒�?�旧实现在这里直接判 degraded **且不再重�?*�?
  // 于是 12 秒才就绪的后�??永久标�?�?�?��性受�?（用户看到降级提示，后�?其实好着�?���?
  // 现在：先�?仍在�?��"，后台继�?���?�?50 秒，就绪即把状�?�升�?ready；真起不来才�?degraded�?
  console.warn("[gui:backend] slime_server.py 启动较慢（>10秒），后台继续等待就绪…");
  emitBoot({ phase: "backend", backendReady: false, message: "后端服务仍在启动（首次导入较慢）…" });
  void (async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`http://localhost:${SLIME_PORT}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          console.info(`[gui:backend] slime_server.py 已就�?���?��耗时�?${10 + (i + 1) * 0.5} 秒）`);
          emitBoot({ phase: "ready", backendReady: true, message: "后端服务已就绪" });
          return;
        }
      } catch { /* 继续重试 */ }
    }
    console.error("[gui:backend] slime_server.py �?��超时�?0秒）");
    emitBoot({ phase: "degraded", backendReady: false, message: "后�?服务�?��超时（可用�?�受限）" });
  })().catch(() => { /* 后台探测失败不影响主流程 */ });
}

function terminatePythonBackend(): void {
  if (pythonBackend) {
    pythonBackend.kill();
    pythonBackend = null;
  }
}

/** 初�?化本地模型生命周期�?理器（幂等；解析 slime.toml [model_server] 配置�?*/
let modelServerInit = false;
function initModelServerManager(): void {
  if (modelServerInit) { return; }
  modelServerInit = true;
  try {
    const cfg = readModelServerConfig();
    const mgr = new ModelServerManager({
      llama_bin: cfg.llama_bin ?? "",
      startup_timeout: cfg.startup_timeout,
      vram_budget_gb: cfg.vram_budget_gb,
      chat_est_gb: cfg.chat_est_gb,
      embedding: cfg.embedding,
      chat: cfg.chat,
    }, {
      // A-1017：�?��?在加载本地模型�?�面板的�?��驱动源�??
      // 此前�?��条�?话开始前由本文件预判"这�?要加载吗"（另读一�?providers �?+ 裸路径比较）—�??
      // 与引擎实际加载的 model_path �?旦不�?致就永久判否，于�?��型已就绪也每�?���?次全屏面板�??
      // 现在�?��管理�?*真的**进入 loading 时才弹，进入 ready/idle 即刻收（不再等整�?��答结束）�?
      onChatState: (ev) => {
        /* S4-D：状态一有迁移就作废能力缓存�?
           为什么不能只�?2s TTL：`probeManagedChatCapability()` �?`getLocalCapability()`
           �?*不传 alias**，于�?���?key �?���?�� —�??而模型切�?重载**恰好发生在同�?�??口上**�?
           不清缓存，切换后�?�?2s 内会�?*上一�?���?*�?n_ctx 去回答，
           正是 A-1018 �?的形状（界面按旧模型显示窗口）�??
           失效点放在这里�?�不�?���?��用方：状态广�?��"这个�?��上发生了�?�?的唯�?真�?�来源�??
           ⚠️ 必须在下面的窗口判空**之前** —�??无窗口时同样要作废�??*/
        clearLocalCapabilityCache();
        const w = mainWindow;
        if (!w || w.isDestroyed()) { return; }
        if (ev.state === "loading") {
          w.webContents.send("slime:model:loading", {
            loading: true,
            message: `正在加载本地模型「${ev.modelName || basename(ev.modelPath)}」——首次加载可能需要数十秒`,
            key: lastChatCancelKey ?? undefined,
          });
          console.info(`[gui:main] �?��模型�?始加�? ${ev.modelName} (${ev.modelPath})`);
        } else {
          w.webContents.send("slime:model:loading", { loading: false });
          if (ev.state === "ready") { console.info(`[gui:main] �?��模型已就�? ${ev.modelName}`); }
          else if (ev.error) { console.warn(`[gui:main] �?��模型�?���?${ev.state}): ${ev.modelName} �?${ev.error}`); }
        }
      },
    });
    setModelServer(mgr);
    void mgr.startup(); // 后台预加载常�?BGE 嵌入实例（不阻�?主窗口）
    console.info("[gui:main] ModelServerManager 已初始化", { llama_bin: cfg.llama_bin ?? "(�?���?" });
  } catch (e) {
    console.error("[gui:main] 初�?�?ModelServerManager 失败:", e);
  }
}

async function terminateModelServer(): Promise<void> {
  const mgr = getModelServer();
  if (mgr) {
    await mgr.shutdown().catch((e) => console.warn("[gui:main] 模型服务器关�?���?", e));
  }
  setModelServer(new ModelServerManager({})); // 重置单例引用（防重�? shutdown�?
}
