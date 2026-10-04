






















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CODE = stripComments(PANEL);

describe("A-1095 #8 正文后置闸门", () => {
  it("① 闸门是**显示层**的：partialRef 在 chunk 分支继续累积（与闸门无关）", () => {
    


    const m = /if \(c\.type === "chunk"\) \{\r?\n\s*partialRef\.current \+=/.exec(CODE);
    expect(m?.[0], "找不到「chunk 分支里累积 partialRef」这一处 —— 闸门可能把累积吃掉了").toBeTruthy();
  });

  it("② 判据 = 本轮结束（!loading）；旧单向闩 contentPhaseRef 必须绝迹", () => {
    



    expect(CODE, "闸门判据不是「本轮结束」").toMatch(/const gateOpen = !gated;/);
    
    expect(CODE, "contentPhaseRef 已废弃，必须绝迹（否则两个判据并存）").not.toMatch(/contentPhaseRef/);
  });

  it("③ 正文常驻挂载、关闸期只隐藏 —— 否则开闸是一次大闪烁", () => {
    
    expect(CODE, "正文必须**始终**挂载 StreamFadeText（关闸期也不例外）").toMatch(/<StreamFadeText text=\{shown\} \/>/);
    


    expect(CODE, "关闸期必须用 display:none 隐藏正文容器（而不是卸载它）")
      .toMatch(/style=\{gateOpen && shown \? undefined : \{ display: "none" \}\}/);
  });

  it("④ 关闸期占位区分「正在思考」与「思考 + 工具调用进行中」", () => {
    expect(CODE).toContain("正在思考");
    expect(CODE).toContain("思考与工具调用进行中");
    expect(CODE).toMatch(/runningTool \? "思考与工具调用进行中" : "正在思考"/);
  });

  it("⑤ A-1124：恢复占位气泡与流式现场块**共用** GatedBody（切会话再切回不再换一套渲染）", () => {
    




    expect(CODE, "找不到 GatedBody（正文闸门 + 渐入的唯一产地）").toMatch(/const GatedBody = React\.memo\(/);
    const calls = CODE.match(/<GatedBody\b/g) ?? [];
    


    expect(calls.length, `GatedBody 被调用 ${calls.length} 次 —— 应为 2（流式现场块 + 恢复占位气泡）`).toBe(2);
    
    expect(CODE, "恢复气泡没有把显示层缓冲交给 GatedBody").toMatch(/<GatedBody shown=\{liveText\} gated=\{gated\} runningTool=\{runningTool\} \/>/);
    expect(CODE, "流式现场块的 GatedBody 接线形态变了")
      .toMatch(/<GatedBody shown=\{deferredPartial \|\| partial\} gated=\{loading\} runningTool=\{Boolean\(runningTool\)\} \/>/);
  });
});
