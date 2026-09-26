/**
 * tests/gui/a1095-body-gate.spec.ts — A-1095 #8：正文后置闸门守卫（**返工版**）。
 *
 * 用户诉求（原话）：「首先修改正文输出逻辑，改在**所有思考结束后**再统一输出」。
 *
 * ⚠️ 上一版判据「首个 chunk = 思考结束」**从根上就是错的**，所以用户看到"和改动前没区别"
 * （他驳回的原话：「工具调用和正文怎么还是这个布局？你改了什么？」）。事实是 agentic 轮内的
 * 事件序列为
 *     `reasoning → tool-start → tool → chunk → tool-start → tool → chunk → done`
 * —— 正文与工具调用在**同一轮内反复交错**。首个 chunk 只说明"这一段正文写完了"，
 * 后面完全可能继续思考、继续调工具。于是旧闸门在第一个 chunk 就**永久敞开**（是个单向闩）。
 *
 * 现判据 = `!loading`（本轮**全部**工作收尾）。
 *
 * 本 spec 锁五件事（全属**静默失效**类：过 tsc / 过构建 / 过所有逻辑测试，只在用户眼里翻车）：
 *   ① 闸门只管**显示**：`partialRef` 必须继续累积（否则 token 统计/兜底/持久化全线丢数据）；
 *   ② 判据 = 本轮结束（`!loading` ⇒ `!gated`）；旧单向闩 `contentPhaseRef` 必须**绝迹**；
 *   ③ 正文**常驻挂载**、关闸期只 `display:none` —— 否则开闸那刻组件才挂载、渐入水位从 -1 起，
 *      整篇正文一起套渐入类 = 一次**大闪烁**（正是用户投诉过的家族）；
 *   ④ 关闸期占位文案区分「思考」与「思考 + 工具调用」；
 *   ⑤ **A-1124**：闸门/渐入/占位收在唯一产地 `GatedBody` 里，且**恰好两处**调用它
 *      （流式现场块 + 切会话恢复的占位气泡）—— 少一处就是"切回来观感回退"复发。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");
/** 剥注释：注释里写着"曾经是什么" / 用户原话，不该被当成当前代码断言。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CODE = stripComments(PANEL);

describe("A-1095 #8 正文后置闸门", () => {
  it("① 闸门是**显示层**的：partialRef 在 chunk 分支继续累积（与闸门无关）", () => {
    /* ⚠️ 不能用 `indexOf('if (c.type === "chunk") {')` —— 后台镜像那个回调里也有一个**同名**
       chunk 分支，indexOf 会命中先出现的那个，于是守卫盯错了地方（本次返工实测踩到）。
       锚点必须是"**紧跟着累积 partialRef** 的那个 chunk 分支"。 */
    const m = /if \(c\.type === "chunk"\) \{\r?\n\s*partialRef\.current \+=/.exec(CODE);
    expect(m?.[0], "找不到「chunk 分支里累积 partialRef」这一处 —— 闸门可能把累积吃掉了").toBeTruthy();
  });

  it("② 判据 = 本轮结束（!loading）；旧单向闩 contentPhaseRef 必须绝迹", () => {
    /* ⚠️ A-1124 **迁移**：闸门与它的显示层判据搬进唯一产地 `GatedBody`
       （原来那句内联在流式现场块里，而恢复路径另有一份**不带闸门**的裸 Markdown）。
       形式从 `!loading` 变成 `!gated`（`gated` 由调用方按 `loading` 传入）——
       意图逐字保留：**判据 = 本轮结束**，不是「首个 chunk」。 */
    expect(CODE, "闸门判据不是「本轮结束」").toMatch(/const gateOpen = !gated;/);
    /* 两个判据并存 = 下一个维护者必然只改一个 → 又回到"改了但没生效"。 */
    expect(CODE, "contentPhaseRef 已废弃，必须绝迹（否则两个判据并存）").not.toMatch(/contentPhaseRef/);
  });

  it("③ 正文常驻挂载、关闸期只隐藏 —— 否则开闸是一次大闪烁", () => {
    // StreamFadeText 的渐入水位活在 ref 里；关闸期不挂载 ⇒ 开闸时水位从 -1 起 ⇒ 整篇重播渐入
    expect(CODE, "正文必须**始终**挂载 StreamFadeText（关闸期也不例外）").toMatch(/<StreamFadeText text=\{shown\} \/>/);
    /* ⚠️ 锚点必须精确到**包裹正文的那个 div**。写成裸 `/display: "none"/` 会被本文件里
       `TimelineNode` 的两处空节点（`return <span style={{ display: "none" }} />`）**兜住** ——
       删掉闸门的隐藏、守卫照样绿（本仓 §24「判据被兜住」家族）。 */
    expect(CODE, "关闸期必须用 display:none 隐藏正文容器（而不是卸载它）")
      .toMatch(/style=\{gateOpen && shown \? undefined : \{ display: "none" \}\}/);
  });

  it("④ 关闸期占位区分「正在思考」与「思考 + 工具调用进行中」", () => {
    expect(CODE).toContain("正在思考");
    expect(CODE).toContain("思考与工具调用进行中");
    expect(CODE).toMatch(/runningTool \? "思考与工具调用进行中" : "正在思考"/);
  });

  it("⑤ A-1124：恢复占位气泡与流式现场块**共用** GatedBody（切会话再切回不再换一套渲染）", () => {
    /* 用户实测问题（a）：「出现了我之前让你调过的问题，即所有思考历程输出完后再出正文……
       那就是我切换会话后，再回来这个会话，这个设定便会被我让你修改前的老设定覆盖。」
       结构根因：切会话恢复时 `resumeMsgId` 非空 ⇒ 流式现场块**整块让位**，
       改由 `messages` 里那条占位气泡渲染 —— 而那条路径当时是**另一份更旧的实现**
       （裸 `<Markdown>`，无闸门、无渐入）。所以这里必须锁死"只有一份实现"。 */
    expect(CODE, "找不到 GatedBody（正文闸门 + 渐入的唯一产地）").toMatch(/const GatedBody = React\.memo\(/);
    const calls = CODE.match(/<GatedBody\b/g) ?? [];
    /* 两处：① 流式现场块（从未切过会话）；② 切会话恢复的占位气泡（AssistantMessage 的 liveText 支）。
       ⚠️ 少于 2 = 又出现了"第二条更旧的渲染路径" ⇒ 用户实测症状（切回来观感回退）必然复发。
       ⚠️ 多于 2 = 有人又开了第三份产地，同样要拦。 */
    expect(calls.length, `GatedBody 被调用 ${calls.length} 次 —— 应为 2（流式现场块 + 恢复占位气泡）`).toBe(2);
    // 恢复路径必须真的把**显示层缓冲**交给它（拿 `m.content` 会绕过逐字渐入）
    expect(CODE, "恢复气泡没有把显示层缓冲交给 GatedBody").toMatch(/<GatedBody shown=\{liveText\} gated=\{gated\} runningTool=\{runningTool\} \/>/);
    expect(CODE, "流式现场块的 GatedBody 接线形态变了")
      .toMatch(/<GatedBody shown=\{deferredPartial \|\| partial\} gated=\{loading\} runningTool=\{Boolean\(runningTool\)\} \/>/);
  });
});
