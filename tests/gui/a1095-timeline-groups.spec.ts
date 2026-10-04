













import { describe, it, expect } from "vitest";
import { groupTimeline, type TimelineStep } from "../../gui/src/renderer/pages/todoPanorama.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");

const think = (text: string): TimelineStep => ({ kind: "think", text });
const tool = (name: string): TimelineStep => ({ kind: "tool", name, label: name });










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
    




    expect(PANEL, "流式实时区没走 groupTimeline（或 liveTimeline 没交进去）")
      .toMatch(/groupTimeline\([^\n]*liveTimeline[^\n]*\)/);
    
    expect(PANEL).not.toMatch(/timeline\.map\(\(step, i\)/);
    expect(PANEL).not.toMatch(/liveTimeline\.map\(\(step, i\)/);
  });

  it("工具行照旧**实时**（用户澄清：工具不推迟）—— TimelineNode 仍在组内逐个渲染", () => {
    expect(PANEL).toMatch(/<TimelineGroupBlock\b/);
    
    const at = PANEL.indexOf("TimelineGroupBlock = React.memo");
    expect(at).toBeGreaterThan(-1);
    expect(topLevelBlock(PANEL, at)).toMatch(/<TimelineNode\b/);
  });

  it("活跃组恒展开、历史组可折叠（对齐 ChatGPT / Claude Code 的既有形态）", () => {
    const at = PANEL.indexOf("TimelineGroupBlock = React.memo");
    const body = topLevelBlock(PANEL, at);
    












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
    
    expect(body).not.toMatch(/const foldable = /);
    expect(body).not.toMatch(/if \(!foldable\) \{ return body; \}/);
  });
});
