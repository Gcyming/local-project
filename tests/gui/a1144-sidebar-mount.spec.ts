/**
 * tests/gui/a1144-sidebar-mount.spec.ts — 「右栏**挂载**」的守卫（A-1144）。
 *
 * ## 用户原话（三件事）
 * 「我想要的是跟**挂载文件夹**一样，直接实时监测挂载右侧边栏的内容，对话的时候，对应会话的
 *  Agent 可以监测到右侧边栏内容，用户直接提要求的时候 Agent 不需要用户额外说一大段提示词，
 *  直接联想到右侧边栏挂载的内容。同时把「交给 slime」按钮**直接去掉**。」
 * 另外两条实测吐槽：「怎么**待办任务列表**都会出现这个？」（状态条对内部面板也播报）。
 *
 * ## 依据（MCP Apps 规范的两条硬原则）
 * · 「Anything displayed to the user must also be available to the model」；
 * · 「User interactions must be sent back to the model」。
 * 上一版的「交给 slime」把第②条做成了**手动**的，于是第①条在"用户没点"时就不成立。
 *
 * ## 三个必须锁住的点
 *  ① **按会话隔离**：右栏是 per-session 的（A-1142），挂载不能变成"上下文层的串台"；
 *  ② **只挂载内容类页签**（浏览器 / 文件 / 终端），内部面板（任务 / Git）不挂；
 *  ③ **两条系统提示路径都要注入**（`ChatService.chat` 与 `chatStream`）—— 漏一条 = "只有打字机模式
 *     才看得见右栏"这种最难复现的症状（A-1106 已经在委派规范上为同一件事付过账）。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  setSidebarMount,
  getSidebarMount,
  sidebarMountSection,
  __resetSidebarMountForTest,
} from "../../core-ts/src/sidebarMount.js";
import {
  describeSidebarSnapshot,
  type SidebarSnapshot,
  type SidebarTabView,
} from "../../gui/src/renderer/pages/sidebarSearch.js";
import { registerBuiltinTools, setHttpServer } from "../../core-ts/src/tools/builtin.js";
import { getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const snapshotOf = (tab: SidebarTabView): SidebarSnapshot => ({ tab, search: null, seq: 1, at: 0 });

/* ══════════════ ① 挂载段：按会话隔离 ══════════════ */

describe("A-1144 ① `sidebarMountSection`：挂载必须按会话隔离", () => {
  beforeEach(() => { __resetSidebarMountForTest(); });

  it("该会话的挂载才注入；**别的会话一律不注入**（否则就是把串台从显示层搬到上下文层）", () => {
    setSidebarMount({ sessionId: "sess-A", text: "【右栏 · 浏览器】cloud 云原生" });
    expect(sidebarMountSection("sess-A")).toContain("右侧边栏 · 实时挂载");
    expect(sidebarMountSection("sess-A")).toContain("cloud 云原生");
    expect(sidebarMountSection("sess-B"), "会话 B 读到了会话 A 的右栏").toBe("");
  });

  it("⚠️ 没给会话号 ⇒ **不注入**（不许退化成「全局挂载」）", () => {
    setSidebarMount({ sessionId: "sess-A", text: "x" });
    expect(sidebarMountSection(undefined)).toBe("");
    expect(sidebarMountSection("")).toBe("");
    expect(sidebarMountSection("   ")).toBe("");
  });

  it("没有挂载 / 文本为空 ⇒ 空串（右栏空了就该撤下，不能报旧内容）", () => {
    expect(sidebarMountSection("sess-A")).toBe("");
    setSidebarMount({ sessionId: "sess-A", text: "   " });
    expect(sidebarMountSection("sess-A")).toBe("");
    setSidebarMount({ sessionId: "sess-A", text: "有内容" });
    setSidebarMount(null);
    expect(getSidebarMount()).toBeNull();
    expect(sidebarMountSection("sess-A")).toBe("");
  });

  it("注入的那段要**教模型怎么用**（否则它只会复述状态、不会去读正文）", () => {
    setSidebarMount({ sessionId: "s", text: "【右栏 · 文件】D:/a/b.ts" });
    const t = sidebarMountSection("s");
    expect(t).toContain("web_fetch");
    expect(t).toContain("不要反问");
  });
});

/* ══════════════ ② 只挂"用户在看的内容"，不挂内部面板 ══════════════ */

describe("A-1144 ② 状态条/挂载只对**内容类**页签生效", () => {
  it("浏览器 / 文件 / 终端 ⇒ 有文案（这三类是「打开了一个东西在看」）", () => {
    for (const kind of ["browser", "file", "terminal"] as const) {
      const r = describeSidebarSnapshot(snapshotOf({ kind, url: "https://x", title: "T" }));
      expect(r, `${kind} 应当挂载`).not.toBeNull();
      expect(r!.inject).toContain("【右栏");
    }
  });

  it("**任务 / Git / 空** ⇒ `null`（用户实测吐槽：待办任务列表怎么会冒出来）", () => {
    for (const kind of ["tasks", "git", "none"] as const) {
      expect(describeSidebarSnapshot(snapshotOf({ kind, url: "", title: "待办任务" })), `${kind} 不该挂载`).toBeNull();
    }
    expect(describeSidebarSnapshot(null)).toBeNull();
    expect(describeSidebarSnapshot(undefined)).toBeNull();
  });
});

/* ══════════════ ③ 两条系统提示路径都要注入 ══════════════ */

describe("A-1144 ③ `ChatService` 两条路径都注入（漏一条 = 只有打字的那个模式看得见右栏）", () => {
  it("`chat` 与 `chatStream` 各注入一次", () => {
    const chat = read("core-ts/src/services/chat.ts");
    const hits = chat.match(/sidebarMountSection\(req\.sessionId\)/g) ?? [];
    expect(hits.length, "系统提示的注入点少了一处").toBe(2);
    /* 拼装口径统一（三个来源 filter+join）：`teamCtx ? a+"\n\n"+b : a` 那种每加一个来源就要再写一遍分支 */
    expect((chat.match(/\[systemPrompt, teamCtx, mount\]\.filter\(Boolean\)\.join/g) ?? []).length, "两处拼装口径不一致").toBe(2);
  });

  it("挂载段取自**唯一产地**（不是就地拼一段字符串）", () => {
    expect(read("core-ts/src/services/chat.ts")).toContain('from "../sidebarMount.js"');
  });
});

/* ══════════════ ④ 链路：上报 → 主进程 → 工具 ══════════════ */

describe("A-1144 ④ 上报链路与工具", () => {
  it("preload 有上报口、通道名两边对得上", () => {
    const pre = read("gui/src/preload/index.ts");
    expect(pre).toContain("publishSidebarMount");
    /* ⚠️ 断言带参数（`, payload)`）：只锚通道名前缀的话，`slime:sidebar:mounts` 也算「包含」⇒ 假绿。 */
    expect(pre).toContain('ipcRenderer.send("slime:sidebar:mount", payload)');
    expect(read("gui/src/main/index.ts")).toContain('ipcMain.on("slime:sidebar:mount", ');
  });

  it("主进程**只存不做判据**（判据在渲染层，这里再写一份就是第二产地）", () => {
    const main = read("gui/src/main/index.ts");
    expect(main).toContain("setSidebarMount(");
    /* 反面：主进程不许自己按 kind 过滤（那是 `describeSidebarSnapshot` 的活） */
    expect(main, "主进程又写了一份「哪类页签值得挂载」").not.toMatch(/slime:sidebar:mount"[\s\S]{0,400}?kind === "tasks"/);
  });

  it("渲染层上报的是**本会话**的摘要，且空内容上报 `null`（清空）", () => {
    const panel = read("gui/src/renderer/pages/ChatPanel.tsx");
    expect(panel).toMatch(/publishSidebarMount\?\.\(sideStatus && sid \? \{ sessionId: sid, text: sideStatus\.inject \} : null\)/);
  });

  it("「交给 slime」按钮已被**删除**（含样式类，免得留下死样式又被人接回去）", () => {
    /* ⚠️ 判据锚**按钮元素本身**（`>交给 slime</button>`），不是锚那四个字 ——
       注释里提一句"已删掉某按钮"是正常的，锚文本会让这条守卫变成"注释也不许提"。 */
    expect(read("gui/src/renderer/pages/ChatPanel.tsx")).not.toContain(">交给 slime</button>");
    expect(read("gui/src/renderer/pages/ChatPanel.tsx")).not.toContain("side-status-hand");
    expect(read("gui/src/renderer/index.css")).not.toMatch(/\.side-status-hand\s*\{/);
  });

  it("`sidebar_mount` 工具注册为 read + autoApprovable（读状态不该逐次弹审批）", () => {
    resetRegistry();
    setHttpServer(null);
    registerBuiltinTools();
    const t = getRegistry().get("sidebar_mount")!;
    expect(t).toBeTruthy();
    expect(t.permissions).toEqual(["read"]);
    expect(t.effectiveRiskKind()).toBe("read");
    expect(t.autoApprovable).toBe(true);
  });

  it("工具读的是**本会话**的挂载；没有时如实说「无挂载」，不许编", async () => {
    resetRegistry();
    setHttpServer(null);
    registerBuiltinTools();
    __resetSidebarMountForTest();
    const fn = getRegistry().get("sidebar_mount")!.executeFn;
    const none = await fn({ sessionId: "sess-A" });
    expect(none).toContain("[无挂载]");
    expect(none).toContain("别的会话");
    setSidebarMount({ sessionId: "sess-A", text: "【右栏 · 浏览器】example.com" });
    expect(await fn({ sessionId: "sess-A" })).toContain("example.com");
    /* 会话不匹配 ⇒ 仍然说"无挂载"（隔离在工具层同样成立） */
    expect(await fn({ sessionId: "sess-B" })).toContain("[无挂载]");
    __resetSidebarMountForTest();
  });
});
