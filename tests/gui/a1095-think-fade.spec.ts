












import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");

describe("A-1095 #5 吐字渐入推广到思考", () => {
  it("① 唯一产地：`StreamFadeText` 存在，且全文件只此处用 visibleTailUnits(fade.units)", () => {
    expect(PANEL).toMatch(/function StreamFadeText\(/);
    const hits = (PANEL.match(/visibleTailUnits\(fade\.units\)/g) ?? []).length;
    expect(hits, "切分渲染有多个产地 —— A-1080 的同行内流约束迟早失守").toBe(1);
    
    const at = PANEL.indexOf("function StreamFadeText");
    const nextDecl = PANEL.slice(at + 10).search(/\n(?:function |const |export )/);
    const body = nextDecl > 0 ? PANEL.slice(at, at + 10 + nextDecl) : PANEL.slice(at, at + 3000);
    expect(body).toContain("visibleTailUnits(fade.units)");
  });

  it("② 正文与思考**都**调 StreamFadeText（推广真的接上了）", () => {
    const calls = PANEL.match(/<StreamFadeText\b/g) ?? [];
    expect(calls.length, "少于 2 处 —— 思考内容没接上吐字渐入").toBeGreaterThanOrEqual(2);
  });

  it("③ TimelineNode 的 think 分支按 streamingTail 二选一（真则渐入、假则普通 Markdown）", () => {
    const at = PANEL.indexOf("function TimelineNode");
    expect(at, "找不到 TimelineNode").toBeGreaterThan(-1);
    const body = PANEL.slice(at, at + 3800);
    expect(body, "think 分支没有按 streamingTail 分流").toMatch(/streamingTail \? <StreamFadeText text=\{cleanThink\} \/> : <Markdown text=\{cleanThink\} \/>/);
    
    expect(PANEL).toMatch(/streamingTail\?: boolean/);
  });

  it("④ streamingTail 只在**活跃组的最后一个文本段（think / body）**为真", () => {
    const at = PANEL.indexOf("TimelineGroupBlock = React.memo");
    expect(at).toBeGreaterThan(-1);
    const body = PANEL.slice(at, at + 1600);
    




    expect(body).toMatch(/liveStream && group\.isLast && isLastOfGroup && \(step\.kind === "think" \|\| step\.kind === "body"\)/);
  });

  it("⑤ 历史区（ThinkingPanel）不渐入、不恒展开 —— liveStream 必须**默认假**并透传给组", () => {
    const at = PANEL.indexOf("const ThinkingPanel = React.memo");
    expect(at, "找不到 ThinkingPanel").toBeGreaterThan(-1);
    
    const nextTop = PANEL.indexOf("const TimelineGroupBlock", at);
    expect(nextTop, "找不到 ThinkingPanel 之后的下一个顶层组件").toBeGreaterThan(at);
    const body = PANEL.slice(at, nextTop);
    expect(body, "ThinkingPanel 里没有 groups.map —— 结构变了").toContain("groups.map");
    





    expect(body, "liveStream 没有默认假 —— 历史消息会被当成活的（整段重播 / 阶段全都摊开）")
      .toMatch(/liveStream = false/);
    expect(body, "liveStream 没有透传给 TimelineGroupBlock")
      .toMatch(/<TimelineGroupBlock key=\{`g\$\{g\.from\}`\} group=\{g\} liveStream=\{liveStream\} \/>/);
    
    expect(PANEL, "ReasoningSection 没有把 liveStream 透传给 ThinkingPanel")
      .toMatch(/<ThinkingPanel timeline=\{timeline\} liveStream=\{liveStream\} \/>/);
    expect(PANEL, "ReasoningSection 的 liveStream 没有默认假")
      .toMatch(/collapsed, liveStream = false \}/);
  });
});
