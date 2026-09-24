/**
 * A-1061③ 守卫：工具**阶段命名**（状态行说"在做什么类型的事"）。
 *
 * 用户原话：「优化最下方的阶段监测返回，增加阶段描述，涵盖生成脚本中，执行命令中，调取工具中，
 * 等等等等，总之……记得**同步命好每个阶段的标题名字**，为现在这个做好铺垫」。
 *
 * 这条的验收点有两个，缺一不可：
 *   ① **阶段真的分类对了**（真模块真值表，不是搜字符串）—— 拿仓内**真实工具名**逐个过；
 *   ② **标题只有一个出处**（`TOOL_STAGE_TITLES`）—— 组件不许自己再写一份中文（否则必然漂移）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyToolStage, toolStageTitle, TOOL_STAGE_TITLES,
  deriveLiveStatus, type ToolStage,
} from "../../gui/src/renderer/pages/liveStatus.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";

/** 仓内**真实**工具名（来自 core-ts/src/tools/*.ts 的注册清单；改了工具集要同步这里） */
const REAL_TOOLS = [
  "adb_connect", "adb_devices", "adb_install", "adb_pull", "adb_push", "adb_reboot",
  "adb_screencap", "adb_setup", "adb_shell", "adb_uninstall", "ask_user",
  "browser_click", "browser_close_tab", "browser_drag", "browser_navigate", "browser_open_tab",
  "browser_press", "browser_read", "browser_screenshot", "browser_scroll", "browser_snapshot",
  "browser_tabs", "browser_type", "browser_wait",
  "code_check", "file_list", "file_read", "file_write",
  "http_create_app", "http_list", "http_serve", "http_stop",
  "memory_forget", "memory_insert", "memory_search",
  "plan_create", "plan_update", "screen_action", "screen_capture", "screen_focus",
  "screen_info", "screen_ui_dump", "screen_windows", "todo_write", "web_fetch", "web_search",
];

describe("A-1061③ 阶段分类：拿真实工具名逐个过", () => {
  const cases: Array<[string, ToolStage]> = [
    ["http_create_app", "generate-script"],
    ["adb_shell", "run-command"],
    ["adb_push", "run-command"],
    ["http_serve", "run-command"],
    ["http_stop", "run-command"],
    ["file_read", "read-file"],
    ["file_list", "read-file"],
    ["code_check", "read-file"],
    ["file_write", "write-file"],
    ["web_search", "search-web"],
    ["web_fetch", "search-web"],
    ["memory_search", "search-web"],
    ["screen_capture", "screen-control"],
    ["screen_ui_dump", "screen-control"],
    ["adb_screencap", "screen-control"],
    ["adb_devices", "screen-control"],
    ["browser_click", "browser"],
    ["browser_navigate", "browser"],
    ["plan_create", "plan"],
    ["plan_update", "plan"],
    ["todo_write", "plan"],
    ["memory_insert", "memory"],
    ["memory_forget", "memory"],
    ["delegate:ui", "delegate"],
    ["subagent_result", "delegate"],
  ];

  for (const [name, stage] of cases) {
    it(`${name} → ${stage}`, () => {
      expect(classifyToolStage(name)).toBe(stage);
    });
  }

  it("未登记的工具（MCP / 技能 / 生成类）一律落兜底 tool，而不是抛错或空阶段", () => {
    for (const n of ["mcp_something", "skill_search", "agnes_generate_image", "完全没见过的工具"]) {
      expect(classifyToolStage(n)).toBe("tool");
    }
    expect(classifyToolStage("")).toBe("tool");
    expect(classifyToolStage("   ")).toBe("tool");
  });

  it("**每个真实工具名都能取到非空标题**（工具集新增后不会静默变成空白状态行）", () => {
    for (const n of REAL_TOOLS) {
      const title = toolStageTitle(n);
      expect(title.length, `${n} 取不到阶段标题`).toBeGreaterThan(0);
      expect(title.endsWith("…"), `${n} 的标题不该带省略号（组件会接「工具名」）`).toBe(false);
    }
  });

  it("标题表覆盖**全部**阶段键，且互不相同（不许两个阶段共用一句文案）", () => {
    const titles = Object.values(TOOL_STAGE_TITLES);
    expect(Object.keys(TOOL_STAGE_TITLES).length).toBeGreaterThanOrEqual(11);
    for (const t of titles) { expect(t.length).toBeGreaterThan(0); }
    expect(new Set(titles).size, "有两个阶段共用同一句标题 → 用户分不出在做什么").toBe(titles.length);
  });

  it("prefix 规则的**顺序**：adb_screencap 必须落「操作屏幕」而不是「执行命令」", () => {
    // 这是顺序敏感性的代表：`adb_` 是更宽的前缀，screen 规则必须排在它前面
    expect(classifyToolStage("adb_screencap")).toBe("screen-control");
    expect(classifyToolStage("adb_shell")).toBe("run-command");
  });
});

describe("A-1061③ 状态行：阶段化标题接进 deriveLiveStatus（且向后兼容）", () => {
  it("给了原始工具名 → 用阶段标题（不是干巴巴的「正在调用」）", () => {
    const s = deriveLiveStatus({ loading: true, lastToolLabel: "终端", lastToolName: "adb_shell", toolCount: 1 });
    expect(s?.kind).toBe("tool");
    expect(s?.text).toContain("正在执行命令");
    expect(s?.text).not.toContain("正在调用工具");
  });

  it("生成脚本 / 检索信息 也各自有自己的标题", () => {
    expect(deriveLiveStatus({ loading: true, lastToolLabel: "创建应用", lastToolName: "http_create_app" })?.text)
      .toContain("正在生成脚本");
    expect(deriveLiveStatus({ loading: true, lastToolLabel: "网络搜索", lastToolName: "web_search" })?.text)
      .toContain("正在检索信息");
  });

  it("🐛 不传原始工具名时**保留旧文案**（旧调用方零行为变化，不制造回归）", () => {
    const s = deriveLiveStatus({ loading: true, lastToolLabel: "写入文件", toolCount: 2 });
    expect(s?.text).toBe("正在调用「写入文件」");
  });

  it("接线：ChatPanel 真的把原始工具名传进去了", () => {
    const src = code(PANEL);
    expect(src).toContain("lastToolName: toolEvents.length > 0 ? toolEvents[toolEvents.length - 1]!.name : \"\",");
    // 标题只许来自 liveStatus（组件里不许再写一份中文阶段名）
    for (const t of Object.values(TOOL_STAGE_TITLES)) {
      if (t === "正在调用工具") { continue; }
      expect(src, `组件里出现硬编码阶段标题「${t}」，应改用 toolStageTitle()`).not.toContain(t);
    }
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // 顺序颠倒的实现（adb_ 规则在先）会把 adb_screencap 判成执行命令
    const wrong = (n: string): ToolStage => (n.startsWith("adb_") ? "run-command" : n.startsWith("screen_") ? "screen-control" : "tool");
    expect(wrong("adb_screencap")).toBe("run-command");
    expect(classifyToolStage("adb_screencap")).toBe("screen-control");
  });
});
