/**
 * A-1064 守卫（二）：中途「引导」在界面上的**可见性与完整性**，以及它不许干扰待办。
 *
 * 用户原话（同一段里报了三件事）：
 *   · "思考历程看不到我插入引导的卡片"               → 引导必须是时间线上的一等节点
 *   · "而且似乎由于我这个引导，思考历程也出现了一点问题——完整性"
 *                                                    → 折进 think 会污染"要不要补思考节点"的判据
 *   · "我的中间插入引导不要影响待办任务的执行啊，可以重组、加入我的插入的引导请求啊"
 *                                                    → 编排指令必须禁止"只带新增项的 replace"
 *
 * ⚠️ 为什么这三件事写在一个 spec 里：它们是**同一次插入**的三个可见后果，共用一条链路
 *    （`injectSteers` → `steer` 事件 → 界面折时间线 + 撤卡片）。分开写会让人以为可以只修一半。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendTimelineStep, lastPlanItems } from "../../gui/src/renderer/pages/todoPanorama.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const PANORAMA = "gui/src/renderer/pages/todoPanorama.ts";
const CTX_META = "gui/src/renderer/pages/sessionCtxMeta.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const LOOP = "core-ts/src/tool_loop.ts";

describe("A-1064-A 引导是时间线上的一等节点（不是折进思考段的一段文字）", () => {
  it("🐛 引导**绝不**合并进相邻的思考段（此前会与模型思考糊成一坨）", () => {
    // 先来一段思考，再插入引导
    let steps = appendTimelineStep([], { kind: "think", text: "模型在想办法。" });
    steps = appendTimelineStep(steps, { kind: "steer", text: "把颜色改成红色" });
    expect(steps).toHaveLength(2);
    expect(steps[0]!.kind).toBe("think");
    expect(steps[0]!.text).toBe("模型在想办法。");
    expect(steps[1]!.kind).toBe("steer");
    expect(steps[1]!.text).toBe("把颜色改成红色");
    // 再来一段思考：**不许**跟上面的引导粘在一起
    steps = appendTimelineStep(steps, { kind: "think", text: "好的我改。" });
    expect(steps).toHaveLength(3);
    expect(steps[2]!.kind).toBe("think");
    expect(steps[2]!.text).toBe("好的我改。");
  });

  it("连续两条引导各自成节点（不合并、不丢）", () => {
    let steps = appendTimelineStep([], { kind: "steer", text: "第一条" });
    steps = appendTimelineStep(steps, { kind: "steer", text: "第二条" });
    expect(steps.map((s) => s.kind)).toEqual(["steer", "steer"]);
    expect(steps.map((s) => s.text)).toEqual(["第一条", "第二条"]);
  });

  it("空文本不建节点（零宽度的空卡片比不显示更难懂）", () => {
    const steps = appendTimelineStep([], { kind: "steer", text: "" });
    expect(steps).toHaveLength(0);
  });

  it("🐛 引导节点**不**冒充 think —— 否则 onDone 的「要不要补思考节点」判据被它顶掉", () => {
    /* `ChatPanel.onDone` 用 `!timeline.some(s => s.kind === "think")` 决定要不要用 m.reasoning
       兜底补思考节点（A-918++ / A-1028）。若引导以 kind=think 落进时间线，
       "只有引导、没有真思考"时这个 some 为 true → 兜底不再补 → 思考历程缺一段（用户报的"完整性"）。 */
    const steps = appendTimelineStep([], { kind: "steer", text: "插入的引导" });
    const hasThink = steps.some((s) => s.kind === "think");
    expect(hasThink, "引导被当成 think 了 → 思考节点兜底会被它顶掉").toBe(false);
  });

  it("引导节点不干扰计划卡的基线（lastPlanItems 只看 plan）", () => {
    let steps = appendTimelineStep([], {
      kind: "plan",
      items: [{ id: "1", content: "原有任务", status: "in_progress" }],
    });
    steps = appendTimelineStep(steps, { kind: "steer", text: "顺便把日志也加上" });
    const baseline = lastPlanItems(steps);
    expect(baseline?.map((i) => i.content)).toEqual(["原有任务"]);
  });
});

describe("A-1064-B 接线：三处产地同源，缺一处症状就回来", () => {
  it("契约类型认 steer（时间线节点 + 持久化镜像两处都要认，否则回看历史时静默丢节点）", () => {
    expect(code(PANORAMA), "TimelineStep.kind 不认 steer").toMatch(/kind:\s*"think"\s*\|\s*"tool"\s*\|\s*"plan"\s*\|\s*"todo"\s*\|\s*"steer"/);
    expect(code(CTX_META), "持久化镜像 TimelineStepLite.kind 不认 steer（重启后引导卡消失）")
      .toMatch(/kind:\s*"think"\s*\|\s*"tool"\s*\|\s*"plan"\s*\|\s*"todo"\s*\|\s*"steer"/);
  });

  it("🐛 界面折进时间线的是 steer 节点，旧的「折成 think 文本」写法必须绝迹", () => {
    const src = code(PANEL);
    expect(src, "onChunk 的 steer 分支没有折成 steer 节点").toContain('{ kind: "steer", text: steerText },');
    expect(src, "旧写法（折成 think + 引导：前缀）又回来了").not.toContain('{ kind: "think", text: `引导：${steerText}` }');
  });

  it("🐛 渲染分支必须排在**工具卡兜底之前**（否则引导被渲染成一张 name 为 undefined 的工具卡）", () => {
    const src = code(PANEL);
    const atSteer = src.indexOf('if (step.kind === "steer") {');
    const atToolFallback = src.indexOf('const tool = step as TimelineStep & { kind: "tool" };');
    expect(atSteer, "TimelineNode 没有 steer 分支").toBeGreaterThan(-1);
    expect(atToolFallback, "找不到工具卡兜底").toBeGreaterThan(-1);
    expect(atSteer, "steer 分支排在工具卡兜底之后 → 引导会掉进兜底被当成工具渲染").toBeLessThan(atToolFallback);
  });

  it("引导的展开/收起复用既有 collapse 机制（不许另造第二种动画）", () => {
    const src = code(PANEL);
    const at = src.indexOf('if (step.kind === "steer") {');
    const body = src.slice(at, at + 1600);
    expect(body).toContain('className={`collapse${expanded ? " is-open" : ""}`}');
  });
});

describe("A-1064-C 引导不许干扰待办（编排指令钉死 action=add）", () => {
  it("🐛 编排指令必须要求 add（按 id 合并），并明确警告只用新增项 replace 会抹掉计划", () => {
    const src = read(LOOP);
    const at = src.indexOf("[用户中途插入 · Agent-Loop 编排指令]");
    expect(at, "找不到引导的 Agent-Loop 编排指令").toBeGreaterThan(-1);
    // 取到该条 push 的结束（用户原文那一行）为止
    const end = src.indexOf("—— 用户插入的原文 ——", at);
    expect(end).toBeGreaterThan(at);
    const body = src.slice(at, end);
    expect(body, "没要求用 action=add").toContain('action=\\"add\\"');
    expect(body, "没有警告 replace 的代价").toContain("replace");
    expect(body, "没说清 replace 必须带完整清单").toMatch(/完整清单/);
  });

  it("默认 action 仍是 add（这条兜底必须在工具实现里成立，指令只是第二道保险）", () => {
    const src = code("core-ts/src/tools/builtin.ts");
    expect(src).toMatch(/const actionRaw = String\(args\.action \?\? "add"\)\.toLowerCase\(\);/);
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // 旧指令（只说"列入当前任务清单"，不给 action）在模型手里会落到 replace 上 → 计划被抹掉
    const oldOk = (instruction: string): boolean => instruction.includes('action=\\"add\\"');
    expect(oldOk("2. 调用 todo_write 把它列入当前任务清单（放在合适的位置，已完成的部分保持不变）；")).toBe(false);
  });
});
