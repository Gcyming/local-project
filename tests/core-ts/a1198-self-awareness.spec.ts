/**
 * tests/core-ts/a1198-self-awareness.spec.ts — 「所有 Agent 都知道 B2–B6 的新能力」的守卫
 *
 * ## 要防的缺陷（A-1196 / A-1197④ 的复发点，2026-10-08 审计实锤）
 * A-1196 修的是「Agent 不知道 slime 怎么扩展能力」；A-1197④/⑤ 修的是「导引教它瞎承诺」。
 * 本轮 B2–B6 五包落地后审计发现：两个能力自述段**停留在 B1 时代** ——
 * UI 槽位 / 脚本工具 / 自有页面 / 运行模式四项新能力在自述与导引里全都没写，
 * `provides` 的合法值还写着「三个」、工具能力还写着「插件目前只能贡献指令」。
 * ⇒ 用户不问，Agent 就永远不知道自己多了一整套能力（A-1196 截图场景的直接复发）。
 *
 * ## 断言分五组
 *   A. selfAwarenessGuide：**两种模式**都必须看到七项能力清单 ——
 *      用户口径：「默认的以及未创建的所有 Agent」都要知道自己的能力。
 *   B. creatorGuide：四类 contributes 的声明示例与规则（ui / scripts / page / mode）。
 *   C. 关键数字与实现**同源**（8 阶段 / 4000 字 / 1–500 / 30s / 256KB / 四槽位）——
 *      导引写一个数、实现改另一个数 = 教 Agent 写出必被拒的清单。
 *   D. 第二层校验（装载时查一次 / 运行前重查）必须**真的接上线** ——
 *      纯函数 `validateModeTools` 存在但零调用 = 假接线（本轮审计的实锤之二）。
 *   E. 回归保护：A-1196 / A-1197 的核心口径不许被这轮改动挤掉。
 *
 * ⚠️ 数字同源断言的写法：从实现源码里**提取**常量再比对导引文本 ——
 *    不许两边各写死一份（那就成了「第三份真相」，改实现时守卫照样绿）。
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  creatorGuide,
  DEFAULT_TOOL_PROFILE,
  selfAwarenessGuide,
  skillsRootDir,
} from "../../core-ts/src/services/agentTools.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string =>
  readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const GUIDE = creatorGuide(skillsRootDir());
const DEF = { ...DEFAULT_TOOL_PROFILE };
const CREATOR = { mode: "creator" as const, skills: [], mcp: [] };
const CUSTOM = { mode: "custom" as const, skills: [], mcp: [] };

const MODE_SRC = read("core-ts/src/plugin/mode.ts");
const CONTRIBUTES_SRC = read("core-ts/src/plugin/contributes.ts");
const HOST_SRC = read("core-ts/src/plugin/host.ts");
const CHAT_SRC = read("core-ts/src/services/chat.ts");
const MAIN_SRC = read("gui/src/main/index.ts");
/* 2026-10-09 反回归（用户口径）：扩展 = 外部武装（可开可关），不开「改程序本身」的通路。
   下面这些源文件是「D1 开发者模式」曾经落过的全部触点 —— 必须一个都不残留。 */
const SANDBOX_SRC = read("core-ts/src/sandbox.ts");
const PRELOAD_SRC = read("gui/src/preload/index.ts");
const PANEL_SRC = read("gui/src/renderer/pages/PluginsPanel.tsx");
const IPC_SRC = read("gui/src/shared/ipc.ts");

describe("A-1198-S ① 两种模式的自述都必须涵盖七项能力", () => {
  const six: Array<[string, string]> = [
    ["技能", "· 技能"],
    ["设置项", "· 设置项"],
    ["UI 槽位", "· UI 槽位"],
    ["脚本工具", "· 脚本工具"],
    ["自有页面", "· 自有页面"],
    ["运行模式", "· 运行模式"],
    ["主题皮肤", "· 主题皮肤"],
  ];
  for (const [label, needle] of six) {
    it(`默认模式也知道「${label}」（否则用户不问就永远不知道）`, () => {
      expect(selfAwarenessGuide(DEF)).toContain(needle);
    });
    it(`创造模式也知道「${label}」`, () => {
      expect(selfAwarenessGuide(CREATOR)).toContain(needle);
    });
  }

  it("脚本工具的信任门必须写进两种模式的自述（默认拒绝；否则 Agent 以为写完就有工具）", () => {
    for (const g of [selfAwarenessGuide(DEF), selfAwarenessGuide(CREATOR)]) {
      expect(g).toContain("信任脚本");
      expect(g).toContain("默认拒绝");
    }
  });

  it("自定义模式（custom）也拿到七项清单，且标签不许说成「默认模式」（它是另一个可选模式）", () => {
    const c = selfAwarenessGuide(CUSTOM);
    expect(c).toContain("· 运行模式");
    expect(c).toContain("自定义模式");
    expect(c).not.toContain("你当前处于**默认模式**");
    // 边界与升级路径同款（自定义模式同样不能自建）
    expect(c).toContain("不能为自己新建插件");
    expect(c).toContain("不要含糊承诺");
    expect(c).toContain("也不要假装已具备");
  });

  it("扩展是「外部武装」不是改程序：三模式自述都不许出现改源码/开发者模式的承诺（用户 2026-10-09 口径）", () => {
    /* 口径（用户原话）：「高自由度扩展本质是外部插件，可开可关的，而非对程序本身进行修改 ——
       更像『精装』或者说『武装』」。⇒ 自述里既不许复活 D1 表述，必须正面讲「外部 / 可开可关」。
       注：只锚「复活的 D1 表述」这组词（开发者模式 / worktree / 改主干）——
       正文里「不存在『改源码』这条路」是**否定句**，不在此列（文本层守卫不做语法分析）。 */
    for (const [label, g] of [["默认", DEF], ["创造", CREATOR], ["自定义", CUSTOM]] as const) {
      const text = selfAwarenessGuide(g);
      expect(text, `${label}模式出现 D1 表述（改程序本身）`).not.toMatch(/开发者模式|worktree|改主干/);
      expect(text, `${label}模式缺「外部」口径`).toContain("外部");
      expect(text, `${label}模式缺「可开可关」口径`).toContain("可开可关");
    }
  });

  it("反回归：仓库里不存在「改程序本身」的通路（D1 已按用户口径撤除）", () => {
    /* 这条锁的是**设计决定**：D1 撤除后，源码/守卫/脚本里都不许再长出该通路。
       将来若有人（含未来的我）想把「改主干」加回来，必须先显式改这条守卫 ——
       决定被锁住，回归必须是一次可见的动作，而不是悄悄长回来。
       ⚠️ 判据剥注释再匹配（与 a1197-silam-off 同口径）：沙箱里那条**解释撤除原因**的历史
       注释是应该留的（后人要知道为什么没有这条路），但代码/字符串里**真出现**即违规。 */
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(existsSync(join(ROOT, "core-ts/src/plugin/dev-mode.ts")), "dev-mode.ts 又出现了（D1 不许复活）").toBe(false);
    const surfaces: Array<[string, string]> = [
      ["core-ts/src/sandbox.ts", SANDBOX_SRC],
      ["gui/src/main/index.ts", MAIN_SRC],
      ["gui/src/preload/index.ts", PRELOAD_SRC],
      ["gui/src/shared/ipc.ts", IPC_SRC],
      ["gui/src/renderer/pages/PluginsPanel.tsx", PANEL_SRC],
    ];
    for (const [name, src] of surfaces) {
      expect(stripComments(src), `${name} 残留 dev-mode 触点`).not.toMatch(/dev-mode|devMode|DevMode|开发者模式/);
    }
  });

  it("创造模式自述把五个字段名指到导引（「能做什么」与「怎么写」的分工不变）", () => {
    const c = selfAwarenessGuide(CREATOR);
    for (const field of ["contributes.settings", "contributes.ui", "contributes.scripts", "contributes.page"]) {
      expect(c, `创造模式自述漏了 ${field}`).toContain(field);
    }
    expect(c).toContain('provides: ["mode"]');
    expect(c).toContain("完整步骤见下节「创造模式」");
  });
});

describe("A-1198-S ② creatorGuide 必须涵盖五类 contributes（B2–B6 + 主题皮肤全落地）", () => {
  it("① UI 槽位：字段名 + 四个槽位名 + toolbar_item⇔page 交叉约束", () => {
    expect(GUIDE).toContain("contributes.ui");
    for (const slot of ["settings_panel", "status_item", "chat_action", "toolbar_item"]) {
      expect(GUIDE, `UI 槽位漏了 ${slot}`).toContain(slot);
    }
    expect(GUIDE).toMatch(/\*\*`toolbar_item` 必须同时声明 `contributes\.page`\*\*/);
  });

  it("② 脚本工具：声明形状 + 信任门 + 执行边界三要素（stdin/stdout/cwd）", () => {
    expect(GUIDE).toContain("contributes.scripts");
    expect(GUIDE).toContain('"entry": "tools/hello.mjs"');
    expect(GUIDE).toContain("纯相对路径");
    expect(GUIDE).toContain("信任脚本");
    expect(GUIDE).toContain("trust.json");
    expect(GUIDE).toContain("stdin");
    expect(GUIDE).toContain("stdout");
    expect(GUIDE).toContain("cwd");
  });

  it("③ 自有页面：kind 只认 html + 127.0.0.1（不是 file://）+ 沙箱 iframe", () => {
    expect(GUIDE).toContain("contributes.page");
    expect(GUIDE).toContain('{ "kind": "html", "entry": "panel.html" }');
    expect(GUIDE).toContain("127.0.0.1");
    expect(GUIDE).toContain("**不是** file://");
    expect(GUIDE).toContain("沙箱 iframe");
  });

  it("④ 运行模式：声明形状 + 第二层校验的两种时机都写清", () => {
    expect(GUIDE).toContain('provides: ["mode"]');
    expect(GUIDE).toContain("stages");
    expect(GUIDE).toContain("requirePrevious");
    expect(GUIDE).toContain("装载时查一次");
    expect(GUIDE).toContain("运行前每阶段还会重查");
    expect(GUIDE).toContain("不静默跳过");
  });
});

describe("A-1198-S ③ 关键数字与实现同源（不同源 = 教 Agent 写必被拒的清单）", () => {
  it("阶段数上限与导引同源（mode.ts 的 MAX_STAGES）", () => {
    const m = /export const MAX_STAGES = (\d+);/.exec(MODE_SRC);
    expect(m, "mode.ts 里找不到 MAX_STAGES").not.toBeNull();
    expect(GUIDE).toContain(`阶段 1–${m![1]} 个`);
  });

  it("prompt 上限与导引同源（MAX_STAGE_PROMPT ⇒「≤4000 字」）", () => {
    const m = /export const MAX_STAGE_PROMPT = (\d+);/.exec(MODE_SRC);
    expect(m, "mode.ts 里找不到 MAX_STAGE_PROMPT").not.toBeNull();
    expect(GUIDE).toContain(`≤${m![1]} 字`);
  });

  it("maxRounds 上限与导引同源（MAX_STAGE_ROUNDS ⇒「1–500」）", () => {
    const m = /export const MAX_STAGE_ROUNDS = (\d+);/.exec(MODE_SRC);
    expect(m, "mode.ts 里找不到 MAX_STAGE_ROUNDS").not.toBeNull();
    expect(GUIDE).toContain(`maxRounds\` 1–${m![1]}`);
  });

  it("四个 UI 槽位名与 contributes.ts 的白名单同源（少一个 = 那个槽位写了也白写）", () => {
    const m = /export const PLUGIN_UI_SLOTS = \[([^\]]+)\] as const;/.exec(CONTRIBUTES_SRC);
    expect(m, "contributes.ts 里找不到 PLUGIN_UI_SLOTS").not.toBeNull();
    const slots = [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    expect(slots.length, "槽位白名单实测条数（若为 0 说明正则没匹配上，断言会假绿）").toBe(4);
    for (const s of slots) {
      expect(GUIDE, `导引漏了槽位 ${s}`).toContain(s);
    }
  });

  it("脚本执行边界与主进程常量同源（30s / 256KB）", () => {
    expect(MAIN_SRC).toContain("const PLUGIN_SCRIPT_TIMEOUT_MS = 30_000;");
    expect(MAIN_SRC).toContain("const PLUGIN_SCRIPT_OUTPUT_CAP = 256 * 1024;");
    expect(GUIDE).toContain("30s 超时");
    expect(GUIDE).toContain("256KB");
  });
});

describe("A-1198-S ④ 第二层校验真的接线（纯函数存在 ≠ 有人调用）", () => {
  it("装载时查一次：host 有 checkModeTools 钩子，查不到 ⇒ failed（拒绝装载）", () => {
    expect(HOST_SRC).toContain("checkModeTools");
    expect(HOST_SRC).toContain("mode 声明的工具不存在于当前工具表");
    expect(HOST_SRC).toContain("拒绝装载");
  });

  it("装载检查的「判不了 ≠ 不存在」：工具表为空时不得据此拒绝（装配顺序不是清单错误）", () => {
    expect(MAIN_SRC).toMatch(/names\.size === 0[\s\S]{0,80}return \[\];/);
  });

  it("主进程确实注入了 checkModeTools（validateModeTools 有真实调用点）", () => {
    expect(MAIN_SRC).toContain("checkModeTools:");
    expect(MAIN_SRC).toContain("validateModeTools(manifest.mode");
  });

  it("运行前每阶段重查：availableTools 重查 + 跳过并如实说明（不静默）", () => {
    expect(MAIN_SRC).toContain("availableTools");
    expect(MAIN_SRC).toContain("因工具不可用被跳过");
    expect(MAIN_SRC).toContain("该阶段未执行");
    // 收束语必须区分「全部完成」与「有跳过」——不许把跳过 K 步说成全部完成
    expect(MAIN_SRC).toContain("步因工具不可用被跳过");
  });

  it("重查的产地与执行侧同源：chat 暴露 availableToolsFor（profile ∩ 引擎工具表）", () => {
    expect(CHAT_SRC).toContain("async availableToolsFor(agentId: string)");
    expect(CHAT_SRC).toMatch(/return this\.agentToolsFor\(agent\);/);
  });

  it("mode 贡献不得假报「尚未接线」（它已接线，只是接线在会话侧）", () => {
    expect(HOST_SRC).toContain('else if (kind === "mode")');
    expect(HOST_SRC).toContain("contributions.push(`mode:${describeMode(manifest.mode)}`)");
  });
});

describe("A-1198-S ⑤ 回归：A-1196 / A-1197 的核心口径不许被挤掉", () => {
  it("默认模式仍明确「不能自建 + 升级路径」，不给瞎承诺", () => {
    const d = selfAwarenessGuide(DEF);
    expect(d).toContain("不能为自己新建插件");
    expect(d).toContain("Agent 管理");
    expect(d).toContain("不要含糊承诺");
    expect(d).toContain("也不要假装已具备");
  });

  it("导引仍不许出现承诺词（与 A-1197 同调）", () => {
    for (const bad of ["无缝", "即将支持", "即将上线", "很快就能"]) {
      expect(GUIDE, `导引出现了承诺词 ${bad}`).not.toContain(bad);
    }
  });

  it("provides: tools 的旧误导仍在导引侧被纠偏，且指到真路径（自述不再重复空实现细节）", () => {
    expect(GUIDE).toContain("不会真的多出任何工具");
    expect(GUIDE).toContain("contributes.scripts");
    // 自述（两种模式）不重复「空实现」细节：那是导引的职责（分工口径）
    for (const g of [selfAwarenessGuide(DEF), selfAwarenessGuide(CREATOR)]) {
      expect(g).not.toContain("尚未接线");
    }
  });
});

describe("A-1198-S ⑥ 注入面覆盖：不止主对话 —— 群聊成员与定时任务也要带自述", () => {
  /* ## 这一组在防什么
   * 同一个 Agent 换个发言位就「失忆」：主对话里它知道自己能做什么，
   * 到了群聊发言 / 定时任务里又变成瞎猜（用户口径：**所有 Agent** 都要知道自己的功能）。
   * 三条路径必须用**同一份产地**（agentTools 的导引函数），不许各写一份文案。 */
  it("主对话路径（chat.systemPromptFor）把自述拼进系统提示", () => {
    expect(CHAT_SRC).toContain("sys += agentSkillGuide(resolveAgentToolProfile(agent.tool_profile));");
  });

  it("群聊成员发言提示带能力自述（同一产地；用 selfAwarenessGuide 而非白名单版）", () => {
    const gt = /async function\* streamGroupTalkFlow[\s\S]*?\n\}\n/.exec(MAIN_SRC);
    expect(gt, "找不到 streamGroupTalkFlow 函数体").not.toBeNull();
    expect(gt![0]).toContain("+ selfAwarenessGuide(resolveAgentToolProfile(agent.tool_profile))");
  });

  it("定时任务路径也带上完整能力指引（engine.buildSystem 之后拼接）", () => {
    expect(MAIN_SRC).toContain("+ agentSkillGuide(resolveAgentToolProfile(agent.tool_profile));");
  });
});
