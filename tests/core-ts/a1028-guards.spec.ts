/**
 * tests/core-ts/a1028-guards.spec.ts — A-1028 的结构/行为守卫。
 *
 * 用户实测两诉状（2026-09-20 00:20 截图）：
 *  ① 活动记录里 done 那行"图标后面还跟着一个勾"，且那个图标（实心绿底白勾）与上面一排
 *     单色小图标不是一套语言 → 去掉多余的勾、图标改单色、与工具图标共用同一个槽位。
 *  ② "Agent 输出结束后，思考历程全变成『调研中』、『已执行』之类的卡片了"。
 *
 * ② 的根因有两条，独立存在、必须分别钉死：
 *   (a) **状态词在说谎**：历史回退路径解析出的 tool 节点只有名字、没有结果（磁盘上没有
 *       timeline），旧实现把"结果未记录"和"结果为空"合并成 `!r`，落进
 *       `isWrite ? "已执行" : "调用中"` —— 一条早已结束的回复里每张卡都标"调用中"。
 *       实测取证：`config/history.jsonl` 第 100 行（ts=2026-09-19T16:24:49，正是用户截图那条）
 *       reasoning 里有 11 条 `### 工具调用记录`，`timeline` 字段缺失 → 重载后 11 张卡全无内容。
 *   (b) **时间线被门挡在门外**：`stages` 的开关是 `finalReasoning || doneTools.length > 0`，
 *       只要 done 载荷既没带思考也没带工具，那条**带结果**的真实交错时间线就被整个丢掉，
 *       连 history.jsonl 也写不进去（落盘写在同一个门之下）→ 回看历史只能永远走兜底。
 *
 * ⚠️ 每条守卫都必须过变异测试（见 gui/scripts/mut-a1028-timeline.mjs）：改坏被锁的结构 → 红。
 * ⚠️ 断言"某段代码不存在"时**不能用裸字面量**：本文件被锁的那两处旧写法都原样躺在
 *    注释里（"此前这里是 `…`"），裸 `toContain('"调用中"')` 会被注释骗过 → 一律盯
 *    只可能出现在**代码**里的形态（`const statusLabel = !r ?` …）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitToolTrace,
  traceEntriesToToolSteps,
  resolveToolEntry,
  toolStatusLabel,
} from "../../gui/src/renderer/pages/thinkingText.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHAT_PANEL = join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx");
const read = (p: string): string => readFileSync(p, "utf8");

/* ── ① 状态词：纯逻辑，直接行为断言 ─────────────────────────────────────── */

describe("A-1028 ①：工具卡状态词 —— 「结果未记录」不等于「结果为空」", () => {
  it("result 不是字符串（未记录）= 不给任何状态断言", () => {
    expect(toolStatusLabel(undefined, false)).toBe("");
    expect(toolStatusLabel(undefined, true)).toBe("");
    expect(toolStatusLabel(null, false)).toBe("");
    expect(toolStatusLabel(123, false)).toBe("");
  });

  it("result 是字符串才给状态；空串算「有结果」（工具确实返回了空）", () => {
    expect(toolStatusLabel("", false)).toBe("成功");
    expect(toolStatusLabel("[错误] 未找到", true)).toBe("失败");
    expect(toolStatusLabel("ok", false)).toBe("成功");
    expect(toolStatusLabel("\n  \n", false)).toBe("成功");
  });

  it("永不产出「调用中 / 已执行」这类占位状态", () => {
    for (const r of [undefined, null, "", "x", "[失败]"]) {
      const s = toolStatusLabel(r, false);
      expect(s).not.toBe("调用中");
      expect(s).not.toBe("已执行");
    }
  });
});

/* ── ② 渲染层：状态词必须走唯一实现，且空态不渲染空列 ──────────────────── */

describe("A-1028 ②：ChatPanel 不得再自己拼状态词", () => {
  const src = read(CHAT_PANEL);

  it("状态词取自纯模块 toolStatusLabel(…)", () => {
    expect(src).toContain("const statusLabel = toolStatusLabel(tool.result, isFail);");
    // 旧写法只可能作为**代码**出现成这个形状（注释里那份带反引号，不匹配）
    expect(src).not.toContain("const statusLabel = !r ?");
    expect(src).not.toContain('const statusLabel = !r ? (isWrite ? "已执行"');
  });

  it("状态列为空时整列省略（不留一条空白对齐位）", () => {
    expect(src).toContain("{statusLabel && (");
    expect(src).toContain('className="think-tool-status"');
  });

  it("结果未记录时 title 要讲清「为什么没有状态」（不然像坏掉了）", () => {
    expect(src).toMatch(/const statusTitle = !hasResult \? [^;]*未随记录保存[^;]*;/);
  });
});

/* ── ③ done 路径：有时间线就不许丢、就要落盘 ───────────────────────────── */

describe("A-1028 ③：onDone 的时间线不许被门丢掉、也不许挂在 stages 之下落盘", () => {
  const src = read(CHAT_PANEL);

  it("stages 的门把 finalTimeline 算在内（否则带结果的真时间线被整个丢掉）", () => {
    expect(src).toMatch(/const stages = finalReasoning \|\| doneTools\.length > 0 \|\| finalTimeline\.length > 0\s*\r?\n\s*\? \{ reads, urls, tools: doneTools/);
    // 旧门（不放 finalTimeline）不许回来
    expect(src).not.toMatch(/const stages = finalReasoning \|\| doneTools\.length > 0\s*\r?\n\s*\? \{ reads/);
  });

  it("落盘判据直接用 finalTimeline（不再借道 stages）", () => {
    expect(src).toMatch(/if \(finalTimeline\.length > 0\) \{\s*\r?\n\s*const attachApi = [\s\S]{0,400}?attachTimeline\?\.\(agentId, sessionRef\.current, finalTimeline as unknown\[\]\)/);
  });

  it("空数组落盘分支已删（attachTimelineToRecord 对空数组直接 return false，那是个假承诺）", () => {
    expect(src).not.toMatch(/attachTimeline\?\.\(agentId, sessionRef\.current, \[\]\)/);
    expect(src).not.toMatch(/if \(stages\?\.timeline\?\.length\) \{\s*\r?\n\s*const attachApi/);
  });

  it("流式时间线为空时有兜底重建（用 done 载荷文本重解析，不另造第二份解析）", () => {
    expect(src).toMatch(/if \(finalTimeline\.length === 0\) \{\s*\r?\n\s*const seedTrace = splitToolTrace\(finalReasoning \?\? ""\);/);
    expect(src).toMatch(/traceEntriesToToolSteps\(seedTrace\.traces, matchToolLabel, doneTools\)/);
  });
});

/* ── ④ 端到端形态：真实 "只有工具块、没有 timeline" 的历史记录 → 零假状态 ── */

describe("A-1028 ④：只有 `### 工具调用记录` 的历史记录，渲染出的工具卡不带任何状态词", () => {
  /** 与 `config/history.jsonl` 第 100 行同形（贴的是结构，不是用户数据） */
  const REASONING = [
    "用户说「存在部分镜像无法连接」。我得逐个实测。",
    "",
    "实测结果：z-lib.li 连不上，z-lib.ac / z-lib.cc 能开。",
    "",
    "### 工具调用记录",
    "- ⟳ 网页抓取",
    "- ⟳ 网页抓取",
    "- ⟳ 写入文件",
    "- ⟳ http_serve",
    "- ⟳ screen_capture",
  ].join("\n");

  const LOOKUP: Record<string, { label: string }> = {
    web_fetch: { label: "网页抓取" },
    file_write: { label: "写入文件" },
    screen_capture: { label: "屏幕截图" },
  };

  it("工具块解析成 tool 节点，且这些节点一律没有 result（所以不该有状态词）", () => {
    const trace = splitToolTrace(REASONING);
    // ⚠️ 反查必须走**真实实现**（`resolveToolEntry`）而不是"只比 label"的替身：
    //    真实语料里 screen_capture 这类落盘的是**裸工具名**（core-ts 展示名表没覆盖它），
    //    替身一比就会漏掉这条路径（A-1027 变异⑥ 的同一条教训）。
    const steps = traceEntriesToToolSteps(trace.traces, (e) => resolveToolEntry(e, LOOKUP), []);
    expect(steps.map((s) => s.label)).toEqual(["网页抓取", "网页抓取", "写入文件", "http_serve", "屏幕截图"]);
    // 关键闭环：这些节点**没有 result** → 状态词必须为空 → 界面上不会冒出"调用中/已执行"
    for (const s of steps) {
      expect(Object.prototype.hasOwnProperty.call(s, "result"), "回退节点不许带 result（带了才是说谎）").toBe(false);
      expect(toolStatusLabel(undefined, false)).toBe("");
    }
  });

  it("正文没被工具块的解析吃掉（A-1027 的无损约束仍然成立）", () => {
    const trace = splitToolTrace(REASONING);
    expect(trace.text).toContain("z-lib.ac / z-lib.cc 能开");
    expect(trace.text).not.toContain("工具调用记录");
  });
});
