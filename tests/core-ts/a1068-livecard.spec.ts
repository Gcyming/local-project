



























import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { settleRunning, attachTimelineToHistory, type TimelineStepLite } from "../../gui/src/renderer/pages/sessionCtxMeta.js";
import { toolStatusLabel } from "../../gui/src/renderer/pages/thinkingText.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
const META = read("gui/src/renderer/pages/sessionCtxMeta.ts");



function branchBody(src: string, sig: string, nextSig: string): string {
  const at = src.indexOf(sig);
  expect(at, `锚点漂移：找不到分支 ${sig}`).toBeGreaterThan(-1);
  const end = src.indexOf(nextSig, at + sig.length);
  expect(end, `锚点漂移：找不到 ${sig} 的下一个兄弟（右界）`).toBeGreaterThan(at);
  return src.slice(at, end);
}





function toolNodeBody(): string {
  const at = PANEL.indexOf('const tool = step as TimelineStep & { kind: "tool" };');
  expect(at, "锚点漂移：找不到工具卡的渲染分支").toBeGreaterThan(-1);
  const end = PANEL.indexOf("const ThinkingPanel = React.memo(", at);
  expect(end, "锚点漂移：找不到工具卡分支的右界（ThinkingPanel）").toBeGreaterThan(at);
  return PANEL.slice(at, end);
}

describe("A-1068-A 思考历程的工具卡：tool-start 建卡、结果到了原地翻（不追加第二张）", () => {
  const startBody = branchBody(
    strip(PANEL),
    'if (c.type === "tool-start" && c.data?.name) {',
    'if (c.type === "tool" && c.data?.name) {',
  );
  const doneBody = branchBody(
    strip(PANEL),
    'if (c.type === "tool" && c.data?.name) {',
    'if (c.type === "reasoning") {',
  );

  it("tool-start 在思考历程里**建**一张 running 卡（这是用户盯着看的那块区域）", () => {
    expect(startBody, "tool-start 没有往时间线里建卡 → 用户又只剩最下方的事后成败").toContain("appendTimelineStep(");
    expect(startBody).toContain("timelineStepsRef.current = steps;");
    expect(startBody).toContain("setLiveTimeline(steps);");
  });

  it("建卡时**明确**带 running: true（不带就永远只是事后成败）", () => {
    expect(startBody, "建卡没带 running → 卡片一出现就是「未记录」的哑行").toContain("running: true");
  });

  it("建卡记下 toolId → 索引（结果到了靠它原地翻，而不是追加一张新卡）", () => {
    expect(startBody, "没有记 toolId → 结果到了配不上，必然出两张卡").toContain("toolStepIndexRef.current.set(toolId,");
    expect(startBody).toContain("if (toolId)");
  });

  it("结果到了**原地**翻状态：改那一格 + 收掉索引（不 push）", () => {
    expect(doneBody, "没有取配对索引").toContain("toolStepIndexRef.current.get(toolIdHere)");
    expect(doneBody, "没有判断它确实还处于 running（否则会把历史卡误翻）").toContain('pendingStep.running === true');
    expect(doneBody, "没有原地写回那一格").toContain("patched[stepIdx!] = { ...pendingStep, result: ev.result, running: false };");
    expect(doneBody, "原地翻完没有销掉索引 → 下一次调用会翻错卡").toContain("toolStepIndexRef.current.delete(toolIdHere);");
  });

  it("配对失败才追加（历史回退路径 / toolId 缺失），两条路互斥", () => {
    
    const atElse = doneBody.indexOf("} else {");
    expect(atElse, "没有 else 兜底 → 配不上的结果事件静默消失").toBeGreaterThan(-1);
    const elseBody = doneBody.slice(atElse);
    expect(elseBody, "else 分支没有兜底建卡").toContain("appendTimelineStep(");
    expect(elseBody, "兜底建的是**已完成**卡（不带 running）").not.toContain("running: true");
  });

  it("卡片可展开（用户要的是「可展开栏目」，不是一行摘要）", () => {
    
    const node = toolNodeBody();
    expect(node).toContain("const hasBody = !!tool.detail || !!r;");
    expect(node).toContain('className={`collapse${expanded ? " is-open" : ""}`}');
  });

  it("组件层：running 必须**优先于**「未记录」拿到状态词（否则正在跑是一行哑行）", () => {
    expect(toolStatusLabel(undefined, false, true)).toBe("执行中");
    const node = toolNodeBody();
    expect(node, "组件没有把 running 传进唯一出处").toContain("toolStatusLabel(tool.result, isFail, isRunning)");
    expect(node, "running 态没有可见的运动感（用户要「实时」看得见）").toContain("text-scan-light");
  });
});

describe("A-1068-B 回看历史时不许留下假的「执行中」（粘住的 running 必须在收编处清掉）", () => {
  it("settleRunning：把 running 清成 false，其余字段一字不动", () => {
    const steps: TimelineStepLite[] = [
      { kind: "think", text: "想了想" },
      { kind: "tool", name: "bash", label: "运行命令", detail: "npm test", running: true },
      { kind: "tool", name: "file_read", label: "读取文件", result: "ok", running: false },
    ];
    const out = settleRunning(steps)!;
    expect(out[1].running).toBe(false);
    expect(out[1].name).toBe("bash");
    expect(out[1].detail).toBe("npm test");
    expect(out[2]).toEqual({ kind: "tool", name: "file_read", label: "读取文件", result: "ok", running: false });
    expect(out[0]).toEqual({ kind: "think", text: "想了想" });
  });

  it("没有任何 running 时原样返回（不白拷一份数组）", () => {
    const steps: TimelineStepLite[] = [{ kind: "tool", name: "bash", result: "ok" }];
    expect(settleRunning(steps)).toBe(steps);
  });

  it("空/未定义输入安全（历史里没有时间线是常态）", () => {
    expect(settleRunning(undefined)).toBeUndefined();
    expect(settleRunning([])).toEqual([]);
  });

  it("🔌 接线：收编**两个来源之外**（localStorage 与消息记录都会带粘住的 running）", () => {
    const code = strip(META);
    const at = code.indexOf("const stored = meta?.timelineByAssistantIdx?.[aiOrd];");
    expect(at, "锚点漂移：找不到 attachTimelineToHistory 的取源处").toBeGreaterThan(-1);
    const body = code.slice(at, at + 700);
    expect(body, "settleRunning 没有包在两个来源之外 → 只清了一路，另一路照旧假「执行中」").toContain("settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline))");
  });

  it("行为：从 localStorage 与从消息记录两条路读回，running 都被清掉", () => {
    const live: TimelineStepLite[] = [{ kind: "tool", name: "bash", label: "运行命令", running: true }];
    
    const viaMeta = attachTimelineToHistory(
      [{ role: "assistant", content: "x" }],
      { used: 0, cap: 0, timelineByAssistantIdx: { 1: live } },
    );
    expect(viaMeta[0].timeline?.[0].running).toBe(false);
    
    const viaMsg = attachTimelineToHistory(
      [{ role: "assistant", content: "x", timeline: [{ kind: "tool", name: "bash", running: true }] }],
      null,
    );
    expect(viaMsg[0].timeline?.[0].running).toBe(false);
  });

  it("运行期的实时卡**不受影响**：settleRunning 只用在收编处，不在渲染层", () => {
    
    expect(strip(PANEL), "渲染层不许调用 settleRunning（那会把真正在执行中的卡也抹平）").not.toContain("settleRunning");
    expect(strip(META)).toContain("export function settleRunning(");
  });

  it("接口注释不再声称「持久化时必然是 false」（那句假设正是这个 bug 的温床）", () => {
    



    expect(META, "陈旧断言还在 → 下一个人会照着它继续相信 running 不会落盘")
      .not.toContain("持久化时它必然已是 false/缺省（结果到了才会落库）");
    expect(META).toContain("A-1068 更正");
  });
});
