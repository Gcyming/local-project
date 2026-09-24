/**
 * tests/core-ts/a1021b-guards.spec.ts — 「思考历程时间线丢失」这一整条链的**结构守卫**。
 *
 * 用户症状（截图）：思考过程折叠卡里只剩**一个**节点，展开是一大坨可滚动的字，
 * 时间线形态（圆点 + 竖轨 + 一行摘要 + 可展开正文）整体消失。原话：
 *   "我发现上一次的思考历程的时间线设计怎么没了？"
 *
 * ⚠️ 先说清楚它**不是**什么：不是近期把设计改坏了。CSS（`.think-timeline` / `.think-step-mark` /
 *   `.timeline.is-live` 呼吸）与 `TimelineNode` 的多节点渲染都完好；与 HEAD 对比，出问题的兜底逻辑
 *   **逐字节未变**。真正的原因是两个独立缺陷叠加：
 *
 *   缺陷 A（数据丢）：`onDone` 里"done 的会话不是当前会话"时**早退**，只写 partial 就 return ——
 *     整条时间线不落 localStorage、也不落 history.jsonl。用户习惯边等边切会话，必然命中。
 *     取证（config/history.jsonl）：第 97 行 elapsed_ms=349872（= 截图里的"回复耗时 349.9s"）
 *     timeline **缺失**；几乎同一时刻在当前会话结束的第 96/98 行都带 timeline。唯一差别就是这个早退。
 *
 *   缺陷 B（形态丢）：A-966 往 history.jsonl 写的时间线**只写不读** —— 加载侧
 *     `attachTimelineToHistory` 只认 localStorage，从不看 `ConversationMessage.timeline`。
 *     于是缺陷 A 一旦命中就无法自愈；而且两条"只剩推理文本"的兜底都只建**一个** think 节点，
 *     叠加 `normalizeThinkingText` 把段内单换行并成空格 → 整段推理变成一个巨型段落。
 *
 * ⚠️ 每条守卫都必须过**变异测试**（改坏被锁的结构 → 红）。本文件一律用**结构锚点**（`return;`、
 *    属性名、具名符号）而不是"起点 + N 字符"的取样窗口 —— A-1019 被这类错位坑过两次。
 */
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

/**
 * 剥掉行注释与块注释后再断言。
 *
 * 为什么必须这样：本轮的修复代码里**刻意写了注释解释"为什么不能用 timelineStepsRef.current"**，
 * 于是 `not.toContain("timelineStepsRef.current")` 被自己的注释判红 —— 守卫一旦对注释敏感，
 * 后续任何人补一句说明性注释都会造成假红，最后被"顺手删掉守卫"收场。
 * 断言对象只能是**真实代码**。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("A-1021b ①：兜底渲染必须是**多节点**，不许退回单节点", () => {
  it("历史兜底：整段推理经 splitThinkingIntoSteps 切分后再建节点", () => {
    expect(chatSrc, "历史兜底没有切分函数 → 整段推理会塌成一个节点").toContain("splitThinkingIntoSteps(cleanReasoning)");
    // 旧写法（单节点）必须彻底消失：`{ kind: "think" as const, text: cleanReasoning }`
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
  /** 取 onDone 里"done 的会话不是当前会话"那一整个分支体（到它的 `return; }` 为止）。 */
  const branch = (): string => {
    const m = /if \(m\.sessionId !== sessionRef\.current\) \{([\s\S]*?)return;\s*\n\s*\}/.exec(chatSrc);
    expect(m, "取不到'非当前会话'分支 → 这条守卫自己失效了（分支写法变了就更新这里）").toBeTruthy();
    return m![1];
  };

  it("该分支把 snap.timeline 写回 history.jsonl（缺陷 A 的止损点）", () => {
    const code = stripComments(branch());
    // ⚠️ 不能只断言"出现过 attachTimeline 这个词"：类型注解 `attachTimeline?:` 与 `const attachApi`
    //    声明行里都含这个词，把真正的调用删掉也能绿（变异测试第 ⑥ 条专门验这一点）。
    //    必须锁**调用实参**：agentId + 该会话 sid + snap.timeline。
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
    // 兜底顺序必须是 `fromMeta ?? 记录`（localStorage 优先，不改变已工作路径的行为）
    /* A-1068 迁移：外面又包了一层 `settleRunning(...)`（清掉落盘时粘住的 `running: true`，
       否则中途崩过的工具卡回看时永久显示「执行中」）。**兜底顺序本身没变**，
       所以锚点必须容忍这层外壳 —— 否则"给同一处加一层修复"会被误判成回归，
       下一个人就会去删那层修复。settleRunning 自己有没有被接线，由 a1068-B 独立锁住。 */
    expect(ctxSrc).toMatch(/timeline:\s*(?:settleRunning\()?fromMeta\s*\?\?\s*adoptRecordTimeline\(m\.timeline\)\)?/);
  });

  it("磁盘 kind 是 string → 边界只收窄一次（不许把断言散到每个调用点）", () => {
    expect(ctxSrc, "边界收窄函数不见了 → 调用方会被迫各自断言").toContain("function adoptRecordTimeline");
    expect(ctxSrc).toMatch(/export interface LooseTimelineStep\s*\{[^}]*kind:\s*string/);
  });
});
