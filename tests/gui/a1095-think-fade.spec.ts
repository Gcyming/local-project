/**
 * tests/gui/a1095-think-fade.spec.ts — A-1095 #5：吐字渐入推广到思考内容守卫。
 *
 * 用户诉求：「顺便推广吐字动画到思考内容」。
 * 依赖 #8（正文后置后思考才是主视觉）。
 *
 * 实现要点（属于**静默失效**类：过 tsc / 过构建 / 过所有逻辑测试，只在用户眼里翻车）：
 *   ① **唯一产地**：切分+渲染收进 `StreamFadeText`，正文与思考共用 ——
 *      若各写一份，A-1080「三段同处一个行内流」的约束迟早在一处失守；
 *   ② 只有**活跃组的最后一个文本段**（`think` 或 `body`）带 `streamingTail`（否则历史思考
 *      也在逐字重播，打开旧消息会看到"整段重新打一遍"）；
 *   ③ 非流式（历史消息）走普通 Markdown（零行为变化）。
 */
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
    // 且那句落在 StreamFadeText 体内（右界取下一个顶层声明，见 a1061 的同款说明）
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
    // prop 声明
    expect(PANEL).toMatch(/streamingTail\?: boolean/);
  });

  it("④ streamingTail 只在**活跃组的最后一个文本段（think / body）**为真", () => {
    const at = PANEL.indexOf("TimelineGroupBlock = React.memo");
    expect(at).toBeGreaterThan(-1);
    const body = PANEL.slice(at, at + 1600);
    /* A-1095 #8′ 迁移（原判据写的是 `… && step.kind === "think"`）：
       时间线新增 `body`（该轮正文片段）后，"正在写的那个节点"有两个可能种类。
       判据扩展为 `kind ∈ {think, body}`，**但另外三条一个都不放松**：
       `liveStream` / `group.isLast` / `isLastOfGroup` 仍必须同时成立
       （工具卡、计划卡、历史组都不许套渐入）—— 这正是原意图。 */
    expect(body).toMatch(/liveStream && group\.isLast && isLastOfGroup && \(step\.kind === "think" \|\| step\.kind === "body"\)/);
  });

  it("⑤ 历史区（ThinkingPanel）不渐入、不恒展开 —— liveStream 必须**默认假**并透传给组", () => {
    const at = PANEL.indexOf("const ThinkingPanel = React.memo");
    expect(at, "找不到 ThinkingPanel").toBeGreaterThan(-1);
    // 取到 ThinkingPanel 定义结束（下一个顶层 `});` 之后紧邻的注释/声明）——用它的渲染块做判据
    const nextTop = PANEL.indexOf("const TimelineGroupBlock", at);
    expect(nextTop, "找不到 ThinkingPanel 之后的下一个顶层组件").toBeGreaterThan(at);
    const body = PANEL.slice(at, nextTop);
    expect(body, "ThinkingPanel 里没有 groups.map —— 结构变了").toContain("groups.map");
    /* ⚠️ A-1124 **迁移**（原断言：ThinkingPanel 体内不得出现 `liveStream` 字样）。
       现在 `liveStream` 必须**穿过** ThinkingPanel 到达 TimelineGroupBlock ——
       切会话恢复的占位气泡（`AssistantMessage` 的 `liveText` 支）与流式现场块都必须是"活"的，
       否则用户实测的那条「切回来设定被改动前的老设定覆盖」就又会复发。
       ⇒ 判据从「不许出现」改成「**必须是参数透传 + 默认假**」。意图（历史消息不会整段重播）
       由"默认假"承载：历史消息的调用点不传它 ⇒ 恒假 ⇒ 不渐入、不恒展开。 */
    expect(body, "liveStream 没有默认假 —— 历史消息会被当成活的（整段重播 / 阶段全都摊开）")
      .toMatch(/liveStream = false/);
    expect(body, "liveStream 没有透传给 TimelineGroupBlock")
      .toMatch(/<TimelineGroupBlock key=\{`g\$\{g\.from\}`\} group=\{g\} liveStream=\{liveStream\} \/>/);
    // 历史消息那条链路（ReasoningSection）也必须是默认假 + 透传
    expect(PANEL, "ReasoningSection 没有把 liveStream 透传给 ThinkingPanel")
      .toMatch(/<ThinkingPanel timeline=\{timeline\} liveStream=\{liveStream\} \/>/);
    expect(PANEL, "ReasoningSection 的 liveStream 没有默认假")
      .toMatch(/collapsed, liveStream = false \}/);
  });
});
