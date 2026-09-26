/**
 * tests/gui/a1095-body-steps.spec.ts — A-1095 #8′：思考历程里「穿插的正文」全链路守卫。
 *
 * 用户诉求（原话）：「我要的思考期间穿插的正文总结呢？……还可以在思考历程中穿插正文输出，
 * 然后再在**所有思考工作做完后，整理思考历程中的正文部分**。」
 * 调研文档 `docs/slime-agent-ui-research.md` §5.3 的目标图也是同一形态：
 *   「思考折叠块 + 工具组 + **该轮的正文片段**」。
 *
 * 病灶（结构性，不是"样式没写"）：**正文根本没进时间线** —— `ChatPanel` 的两个 `chunk` 分支
 * 只往 `partialRef` / `snap.partial` 累积（那是"整轮结束后在底部统一输出"的那条通道）。
 * ⇒ 于是活动组里永远只有「思考」与「工具」，用户看不到任何穿插正文；而门禁全绿。
 *
 * 本 spec 锁四件事（全属**静默失效**类：过 tsc / 过构建 / 过所有逻辑测试，只在用户眼里翻车）：
 *   ① 数据层：`appendTimelineStep` 有 body 支，且**连续 chunk 合一段、绝不跨非 body 节点合并**；
 *   ② 归组：`body` **不作组边界**（否则每段正文自成一组、还会套上组头折叠壳把正文藏起来）；
 *   ③ 接线：**两个产地**（前台 onChunk + 后台镜像）都必须写 body —— 只修一个等于没修
 *      （「流式期间切走会话」那条路会把穿插的正文整段丢掉）；
 *   ④ 渲染与持久化：`TimelineNode` 有 body 支（**不折叠**、排在工具卡兜底之前）；
 *      `sessionCtxMeta` 的 kind 联合含 body（否则重启 / 切会话后穿插正文整段丢失）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendTimelineStep, groupTimeline, type TimelineStep } from "../../gui/src/renderer/pages/todoPanorama.js";

const ROOT = resolve(__dirname, "../..");

/** 剥注释：注释里写着"曾经是什么" / 用户原话，不该被当成当前代码断言（同 a1095-body-gate）。 */
function codeOf(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PANEL = codeOf("gui/src/renderer/pages/ChatPanel.tsx");
const META = readFileSync(resolve(ROOT, "gui/src/renderer/pages/sessionCtxMeta.ts"), "utf8");

const think = (text: string): TimelineStep => ({ kind: "think", text });
const body = (text: string): TimelineStep => ({ kind: "body", text });
const tool = (name: string): TimelineStep => ({ kind: "tool", name, label: name });

describe("A-1095 #8′ ① 数据层：body 节点的合并规则", () => {
  it("空时间线 + 首个 chunk → 新开一段 body（正文真的进了时间线）", () => {
    const out = appendTimelineStep([], { kind: "body", text: "第一段正文" });
    expect(out).toEqual([{ kind: "body", text: "第一段正文" }]);
  });

  it("连续 chunk → **合一段**（否则时间线被几十个节点刷屏）", () => {
    let s = appendTimelineStep([], { kind: "body", text: "甲" });
    s = appendTimelineStep(s, { kind: "body", text: "乙" });
    s = appendTimelineStep(s, { kind: "body", text: "丙" });
    expect(s.length).toBe(1);
    expect(s[0]).toEqual({ kind: "body", text: "甲乙丙" });
  });

  it("★ body → tool → body = **两段**：绝不跨非 body 节点合并（阶段归属的判据）", () => {
    /* 这是"穿插"的核心语义，也是 `docs/A-1095-chat-orchestration-plan.md` §2.2③
       「在所有思考工作做完后，整理思考历程中的正文部分」得以成立的前提：
       工具前后的两段正文必须各自留痕，才能分别归回它所属的那一步。
       一旦放宽成"末尾不是 think 就合并"，两段正文会糊成一坨、后一段吃掉前一个工具节点。 */
    let s = appendTimelineStep([], { kind: "body", text: "工具前" });
    s = appendTimelineStep(s, { kind: "tool", name: "read", label: "read" });
    s = appendTimelineStep(s, { kind: "body", text: "工具后" });
    expect(s.map((x) => x.kind)).toEqual(["body", "tool", "body"]);
    expect(s[0].text).toBe("工具前");
    expect(s[2].text).toBe("工具后");
  });

  it("空文本 → 不产生空节点（占位/心跳 chunk 不许在时间线里留痕）", () => {
    const s = appendTimelineStep([], { kind: "body", text: "" });
    expect(s).toEqual([]);
  });

  it("body 与 think 互不吞并（两套合并规则各自独立）", () => {
    let s = appendTimelineStep([], { kind: "think", text: "想" });
    s = appendTimelineStep(s, { kind: "body", text: "说" });
    s = appendTimelineStep(s, { kind: "think", text: "再想" });
    expect(s.map((x) => x.kind)).toEqual(["think", "body", "think"]);
  });
});

describe("A-1095 #8′ ② 归组：body 不作组边界", () => {
  it("think + body + tool → **同一组**（正文归回它所属的工作阶段）", () => {
    const groups = groupTimeline([think("阶段一"), body("该阶段正文"), tool("read")]);
    expect(groups.length).toBe(1);
    expect(groups[0].steps.map((s) => s.kind)).toEqual(["think", "body", "tool"]);
  });

  it("★ 两阶段各带自己的正文 → 恰好两组，正文不跨阶段串台", () => {
    const groups = groupTimeline([
      think("A"), tool("read"), body("A 的正文"),
      think("B"), tool("write"), body("B 的正文"),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0].steps.map((s) => s.kind)).toEqual(["think", "tool", "body"]);
    expect(groups[1].steps.map((s) => s.kind)).toEqual(["think", "tool", "body"]);
    expect(groups[0].steps[2].text).toBe("A 的正文");
    expect(groups[1].steps[2].text).toBe("B 的正文");
  });

  it("不变量仍成立：带 body 时「所有组拼回 === 原数组」", () => {
    const steps = [think("A"), body("正文1"), tool("read"), think("B"), body("正文2")];
    const flat = groupTimeline(steps).flatMap((g) => g.steps);
    expect(flat).toEqual(steps);
  });

  it("正文开头的「无思考组」标题非空（回落到正文首行，而不是空串）", () => {
    const groups = groupTimeline([body("开场就产出正文"), think("事后思考")]);
    expect(groups.length).toBe(2);
    expect(groups[0].headline).toBe("开场就产出正文");
  });
});

describe("A-1095 #8′ ③ 接线：两个产地都必须写 body", () => {
  it("★ body 写入点恰好 **2 处**（前台 onChunk + 后台镜像）—— 只修一个等于没修", () => {
    /* 「两个产地」是本仓反复踩的形态（同 A-1062 的"回车恒 queue"、群聊"总结复读"）：
       新增的实现点只补了主路径，镜像路径漏了 ⇒ 用户体感是"时有时无"，而门禁全绿。 */
    const writes = PANEL.match(/kind: "body"/g) ?? [];
    expect(writes.length, "body 写入点数量不对（应为前台 + 后台镜像两处）").toBe(2);
  });

  it("前台：chunk 分支在累积 partialRef 之外，另写一个 body 节点（并存，不是二选一）", () => {
    expect(PANEL).toMatch(/timelineStepsRef\.current = appendTimelineStep\(timelineStepsRef\.current, \{ kind: "body", text: bodyChunk \}\)/);
    // 与 partialRef 并存：把累积删掉会连带丢掉 token 统计 / 断流兜底（见 a1095-body-gate ①）
    expect(PANEL).toMatch(/partialRef\.current \+=/);
  });

  it("后台镜像：会话快照的时间线也要收 body（否则流式期间切走会话即丢正文）", () => {
    expect(PANEL).toMatch(/snap\.timeline = appendTimelineStep\(snap\.timeline, \{ kind: "body", text: content \}\)/);
  });
});

describe("A-1095 #8′ ④ 渲染与持久化", () => {
  it("TimelineNode 有 body 支：**不折叠**、直接 Markdown，流式尾走同一个渐入实现", () => {
    expect(PANEL).toContain('if (step.kind === "body")');
    expect(PANEL).toContain('data-body-step="1"');
    expect(PANEL).toContain("<StreamFadeText text={bodyText} />");
    expect(PANEL).toContain("<Markdown text={bodyText} />");
    /* 正文是结论性内容 —— 用户要的是"在思考历程里直接读到"，套折叠壳就等于没输出。 */
    const start = PANEL.indexOf('if (step.kind === "body")');
    const slice = PANEL.slice(start, PANEL.indexOf("if (step.kind === \"plan\")", start));
    expect(slice).not.toContain("collapse");
  });

  it("★ body 支必须排在**工具卡兜底之前**（否则正文被渲染成一个叫 undefined 的工具）", () => {
    const bodyAt = PANEL.indexOf('if (step.kind === "body")');
    const fallbackAt = PANEL.indexOf("const tool = step as TimelineStep & { kind: \"tool\" }");
    expect(bodyAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(bodyAt).toBeLessThan(fallbackAt);
  });

  it("持久化：TimelineStepLite 的 kind 联合含 body（否则重启/切会话后穿插正文全丢）", () => {
    expect(META).toMatch(/kind:\s*"think"\s*\|\s*"body"/);
  });
});
