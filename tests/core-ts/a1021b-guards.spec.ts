























import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { THINK_STEP_MAX } from "../../gui/src/renderer/pages/thinkingText.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHAT_PANEL = join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx");
const SESSION_CTX = join(ROOT, "gui/src/renderer/pages/sessionCtxMeta.ts");

const chatSrc = readFileSync(CHAT_PANEL, "utf8");
const ctxSrc = readFileSync(SESSION_CTX, "utf8");









function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("A-1021b ①：兜底渲染必须是**多节点**，不许退回单节点", () => {
  it("历史兜底：整段推理经 splitThinkingIntoSteps 切分后再建节点", () => {
    expect(chatSrc, "历史兜底没有切分函数 → 整段推理会塌成一个节点").toContain("splitThinkingIntoSteps(cleanReasoning)");
    
    expect(chatSrc, "单节点旧写法复活 → 时间线形态当场消失")
      .not.toMatch(/\{\s*kind:\s*"think"\s*as const,\s*text:\s*cleanReasoning\s*\}/);
  });

  it("onDone 兜底：同样切分（否则流式期漏节点时仍是一大坨）", () => {
    expect(chatSrc).toContain("splitThinkingIntoSteps(finalReasoning)");
    expect(chatSrc, "单节点旧写法复活").not.toMatch(/\{\s*kind:\s*"think"\s*as const,\s*text:\s*finalReasoning\s*\}/);
  });

  it("切分函数已导入（漏导入 → tsc 会红，但这条守着'别把调用改成内联拼接'）", () => {
    expect(chatSrc).toMatch(/import\s*\{[^}]*splitThinkingIntoSteps[^}]*\}\s*from\s*"\.\/thinkingText\.js"/);
  });

  it("节点数上限在合理区间（太小=又变成一大坨；太大=渲染上千节点）", () => {
    expect(THINK_STEP_MAX).toBeGreaterThanOrEqual(8);
    expect(THINK_STEP_MAX).toBeLessThanOrEqual(64);
  });
});

describe("A-1021b ②：切走会话时结束的流，时间线**必须落盘**", () => {
  
  const branch = (): string => {
    const m = /if \(m\.sessionId !== sessionRef\.current\) \{([\s\S]*?)return;\s*\n\s*\}/.exec(chatSrc);
    expect(m, "取不到'非当前会话'分支 → 这条守卫自己失效了（分支写法变了就更新这里）").toBeTruthy();
    return m![1];
  };

  it("该分支把 snap.timeline 写回 history.jsonl（缺陷 A 的止损点）", () => {
    const code = stripComments(branch());
    
    
    
    expect(code, "早退分支又开始只写 partial 就 return —— 这正是'时间线凭空消失'的根因")
      .toMatch(/attachTimeline\?\.\(\s*agentId\s*,\s*sid\s*,\s*snap\.timeline/);
  });

  it("落盘用的是 snap.timeline 而不是 timelineStepsRef（切走后那支 ref 已被目标会话覆盖）", () => {
    const code = stripComments(branch());
    expect(code, "切走时 timelineStepsRef 已被目标会话覆盖，读它只会写错数据")
      .not.toContain("timelineStepsRef.current");
    expect(code, "落盘的第三个实参必须是该会话自己的快照时间线")
      .toMatch(/attachTimeline\?\.\(\s*agentId\s*,\s*sid\s*,\s*snap\.timeline/);
  });

  it("空时间线不触发写盘（无意义的整文件重写要避免）", () => {
    expect(stripComments(branch())).toMatch(/snap\.timeline\s*&&\s*snap\.timeline\.length\s*>\s*0/);
  });
});

describe("A-1021b ③：A-966 的 history.jsonl 时间线必须**可读**（此前只写不读）", () => {
  it("入参接受消息自带的 timeline", () => {
    expect(ctxSrc, "入参不再接受记录自带 timeline → 兜底通道又断了")
      .toMatch(/msgs:\s*Array<\{[^}]*timeline\?:[^}]*\}>/);
  });

  it("localStorage 缺该序数时回退到记录自带的时间线", () => {
    expect(ctxSrc).toContain("adoptRecordTimeline(m.timeline)");
    
    



    expect(ctxSrc).toMatch(/timeline:\s*(?:settleRunning\()?fromMeta\s*\?\?\s*adoptRecordTimeline\(m\.timeline\)\)?/);
  });

  it("磁盘 kind 是 string → 边界只收窄一次（不许把断言散到每个调用点）", () => {
    expect(ctxSrc, "边界收窄函数不见了 → 调用方会被迫各自断言").toContain("function adoptRecordTimeline");
    expect(ctxSrc).toMatch(/export interface LooseTimelineStep\s*\{[^}]*kind:\s*string/);
  });
});
