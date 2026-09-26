/**
 * tests/gui/a1095-timeline-groups.spec.ts — A-1095 #9：思考历程「工作阶段归组」守卫。
 *
 * 用户原话：「修改工具调用出现的位置，围绕时间线设计进行规划，把每次的工具调用放在对应的
 * 工作阶段内……每个时间线阶段为一组，每一组涵盖对应内容。」
 * **澄清（关键）**：「我说的是**实时显示的调用工具的文本挪位置**，别给我理解成最后调用工具。」
 *   ⇒ 展示归属重构，**不是**执行时机重构 —— 工具照旧实时执行。
 *
 * 实现 = `groupTimeline` **投影**（纯函数，不改 TimelineStep 结构 / 持久化格式）。
 * 本 spec 锁不变量（投影最怕"丢节点 / 重排"）：
 *   · 所有组的 steps 顺次拼接 === 原数组（一个不丢、不重排）；
 *   · from/to 覆盖 [0, n-1] 且连续；
 *   · 恰好最后一组 isLast。
 */
import { describe, it, expect } from "vitest";
import { groupTimeline, type TimelineStep } from "../../gui/src/renderer/pages/todoPanorama.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");

const think = (text: string): TimelineStep => ({ kind: "think", text });
const tool = (name: string): TimelineStep => ({ kind: "tool", name, label: name });

/**
 * 取某个顶层声明从 `from` 起的**完整**文本（右界 = **下一个顶层声明**）。
 *
 * ⚠️ 不许用硬编码窗口 `PANEL.slice(at, at + 1400)` 那种写法：注释一膨胀，窗口就会把真正的
 *    断言目标挤出切片 —— `toMatch` 会红（还算好），而 `not.toMatch` 会**静默变绿**，
 *    于是守卫看着在跑、其实什么都没守（本仓 §24「判据被兜住」家族）。
 *    本轮实测：给 `TimelineGroupBlock` 补上 A-1124 的长注释后，`<TimelineNode` 被推出
 *    原来的 `+1400` 窗口，第 115 行那条 `toMatch` 当场变红 —— 正是这个坑的活样本。
 */
function topLevelBlock(src: string, from: number): string {
  const next = src.slice(from + 10).search(/\n(?:function |const |export )/);
  return next > 0 ? src.slice(from, from + 10 + next) : src.slice(from);
}

describe("A-1095 #9 groupTimeline 投影", () => {
  it("空时间线 → 空数组", () => {
    expect(groupTimeline([])).toEqual([]);
  });

  it("单个 think 段 → 一组，isLast=true", () => {
    const g = groupTimeline([think("想一下")]);
    expect(g.length).toBe(1);
    expect(g[0].from).toBe(0);
    expect(g[0].to).toBe(0);
    expect(g[0].isLast).toBe(true);
  });

  it("★ 不变量：所有组 steps 顺次拼接 === 原数组（一个节点不丢、不重排）", () => {
    const steps = [think("A"), tool("read"), tool("write"), think("B"), tool("bash"), think("C")];
    const groups = groupTimeline(steps);
    const flat = groups.flatMap((g) => g.steps);
    expect(flat).toEqual(steps);
  });

  it("★ 不变量：from/to 连续覆盖 [0, n-1]，下一组 from === 上一组 to + 1", () => {
    const steps = [think("A"), tool("x"), think("B"), tool("y"), think("C")];
    const groups = groupTimeline(steps);
    expect(groups[0].from).toBe(0);
    expect(groups[groups.length - 1].to).toBe(steps.length - 1);
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i].from).toBe(groups[i - 1].to + 1);
    }
  });

  it("组边界 = 新 think 段开始（think 段与其后工具 = 一阶段）", () => {
    // 两个阶段：〔think A + read〕〔think B + bash〕
    const groups = groupTimeline([think("A"), tool("read"), think("B"), tool("bash")]);
    expect(groups.length).toBe(2);
    expect(groups[0].steps.map((s) => s.kind)).toEqual(["think", "tool"]);
    expect(groups[1].steps.map((s) => s.kind)).toEqual(["think", "tool"]);
  });

  it("开头就是非 think 节点 → 归入首个「无思考」组", () => {
    const groups = groupTimeline([tool("read"), think("A")]);
    expect(groups.length).toBe(2);
    expect(groups[0].steps).toEqual([tool("read")]);
    expect(groups[1].steps).toEqual([think("A")]);
  });

  it("toolCount 只数工具节点（plan/todo/steer 不计入「N 步」）", () => {
    const steps: TimelineStep[] = [
      think("A"), tool("read"), tool("write"),
      { kind: "todo", text: "做完", state: "done" },
      { kind: "steer", text: "用户插话" },
    ];
    const groups = groupTimeline(steps);
    expect(groups.length).toBe(1);
    expect(groups[0].toolCount).toBe(2);
  });

  it("恰好最后一组 isLast=true，其余 false", () => {
    const groups = groupTimeline([think("A"), think("B"), think("C")]);
    expect(groups.map((g) => g.isLast)).toEqual([false, false, true]);
  });

  it("headline 取该组首个 think 段首行（剥 markdown 标记 / 截断）", () => {
    const groups = groupTimeline([think("## 分析问题\n第二行"), tool("read")]);
    expect(groups[0].headline).toBe("分析问题");
  });

  it("无思考组（首节点即工具）→ headline 用工具 label 兜底，绝不空串", () => {
    const groups = groupTimeline([tool("read")]);
    expect(groups[0].headline).toBe("read");
    expect(groups[0].headline.length).toBeGreaterThan(0);
  });

  it("超长首行截断到 42 字 + 省略号", () => {
    const long = "甲".repeat(80);
    const groups = groupTimeline([think(long)]);
    expect(groups[0].headline.endsWith("…")).toBe(true);
    expect(groups[0].headline.length).toBe(43);
  });
});

describe("A-1095 #9 接线守卫", () => {
  it("ThinkingPanel 与流式实时区都走 groupTimeline（不再裸 map 时间线）", () => {
    expect(PANEL).toMatch(/groupTimeline\(timeline\)/);
    expect(PANEL).toMatch(/groupTimeline\(liveTimeline\)/);
    // 旧的裸 map 必须绝迹（否则归组形同虚设）
    expect(PANEL).not.toMatch(/timeline\.map\(\(step, i\)/);
    expect(PANEL).not.toMatch(/liveTimeline\.map\(\(step, i\)/);
  });

  it("工具行照旧**实时**（用户澄清：工具不推迟）—— TimelineNode 仍在组内逐个渲染", () => {
    expect(PANEL).toMatch(/<TimelineGroupBlock\b/);
    // TimelineGroupBlock 内部仍逐节点渲染 TimelineNode
    const at = PANEL.indexOf("TimelineGroupBlock = React.memo");
    expect(at).toBeGreaterThan(-1);
    expect(topLevelBlock(PANEL, at)).toMatch(/<TimelineNode\b/);
  });

  it("活跃组恒展开、历史组可折叠（对齐 ChatGPT / Claude Code 的既有形态）", () => {
    const at = PANEL.indexOf("TimelineGroupBlock = React.memo");
    const body = topLevelBlock(PANEL, at);
    /* ⚠️ A-1115 **迁移**（不是删）：原来断言的是 `useState(group.isLast)` +
       `const foldable = !group.isLast && group.steps.length > 1`，而本轮修了一个真缺陷 ——
       末组**也必须画阶段容器与组头**（否则「模型先把思考一次吐完、再连续调一串工具」这种常见形态
       只有一组、`isLast` 为真 ⇒ 组头被整个跳过 ⇒ 所有动作平铺成一列，用户的时间线设计失效）。
       意图不变：**活跃组恒展开、只有历史组能折叠**。

       ⚠️ A-1124 **迁移**（用户实测问题 d）：判据从「末组恒展开」扩成
       「末组 **或** 正在流的那条时间线 ⇒ 恒展开」。旧写法只认 `group.isLast`，
       而**新阶段一出现，上一组的 `isLast` 当场翻假** ⇒ 它立刻折叠成一行 ——
       一轮跑 18 个工作阶段就攒出 18 行「1 步」折叠壳，正是用户截图里的形态。
       用户原话：「怎么每个阶段做完直接就收起了？没必要，等所有思考历程结束输出正文时，
       再直接收起思考历程就行了。」意图（活跃者恒展开、只有历史组能折叠）逐字保留，
       只是"活跃"的判据从**位置**（isLast）改成**时间**（本轮还在跑）。 */
    expect(body, "holdOpen 判据消失 —— 阶段做完又会自己收起").toMatch(/const holdOpen = Boolean\(liveStream\);/);
    expect(body).toMatch(/const effectiveOpen = group\.isLast \|\| holdOpen \? true : open;/);
    expect(body, "canCollapse 少了 !holdOpen —— 流式期仍会给出会自己弹回去的折叠按钮")
      .toMatch(/const canCollapse = hasShell && !group\.isLast && !holdOpen;/);
  });

  it("A-1115：**末组也要画阶段容器**（唯一允许不套壳的情形是「单节点」，不再按 isLast 跳过）", () => {
    const at = PANEL.indexOf("TimelineGroupBlock = React.memo");
    const body = topLevelBlock(PANEL, at);
    expect(body).toMatch(/const hasShell = group\.steps\.length > 1/);
    expect(body).toMatch(/if \(!hasShell\) \{ return body; \}/);
    // 旧写法（按 isLast 判 foldable、再据此跳过壳）必须绝迹 —— 它就是"动作平铺"的根因
    expect(body).not.toMatch(/const foldable = /);
    expect(body).not.toMatch(/if \(!foldable\) \{ return body; \}/);
  });
});
