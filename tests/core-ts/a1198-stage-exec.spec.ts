/**
 * A-1197 · B3（L4c 阶段机）：**执行侧**的形状与纯逻辑守卫。
 *
 * 锁死三类事实：
 *   ① 阶段消息构造与裁剪（纯度可测——目标/上阶段结论/本阶段 prompt 三段、超长截断）；
 *   ② main 侧 `streamStageFlow` 的硬约束（history 置空=裁剪、stageOverride 透传、abort/离线边界）；
 *   ③ 分派接线（resolveRunnerKind 用在 main、回落原因写进对话、stageOverride 在 chat.ts 透传）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { buildStageMessage, clipCarry, stageProgressText, STAGE_CARRY_MAX } from "../../core-ts/src/services/stageRunner.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");

describe("A-1198-E ① 阶段消息构造与裁剪（纯逻辑）", () => {
  const stage = { id: "plan", title: "方案", prompt: "产出方案…", tools: ["file_write"], maxRounds: 1 };

  it("三段齐全且顺序固定：目标 → 上一阶段结论 → 本阶段 prompt", () => {
    const msg = buildStageMessage({ goal: "把 X 做完", carried: "调研完成：结论 A", stage, index: 2, total: 3 });
    const iGoal = msg.indexOf("【任务目标】");
    const iCarry = msg.indexOf("【上一阶段结论】");
    const iStage = msg.indexOf("【当前阶段（第 2/3 步）：方案】");
    expect(iGoal).toBeGreaterThanOrEqual(0);
    expect(iCarry).toBeGreaterThan(iGoal);
    expect(iStage).toBeGreaterThan(iCarry);
    expect(msg).toContain("调研完成：结论 A");
    expect(msg).toContain("产出方案…");
  });

  it("没有「上一阶段结论」时该段整段不出现（第一阶段不出现空标题）", () => {
    const msg = buildStageMessage({ goal: "G", stage, index: 1, total: 1 });
    expect(msg).not.toContain("【上一阶段结论】");
    expect(msg).toContain("【当前阶段（第 1/1 步）");
  });

  it("`clipCarry` 超长截断并如实标注（不静默吞）", () => {
    const long = "x".repeat(STAGE_CARRY_MAX + 500);
    const clipped = clipCarry(long);
    expect(clipped.length).toBeLessThan(long.length);
    expect(clipped).toContain("已截断");
    expect(clipCarry("short")).toBe("short");
  });

  it("阶段进度文案含「第 n/N 步」形态（UI 靠它显示进度）", () => {
    expect(stageProgressText("调研", 1, 3)).toBe("▶ 阶段 1/3：调研");
  });
});

describe("A-1198-E ② main 侧执行器：硬约束", () => {
  const main = read("gui/src/main/index.ts");

  it("`history: []`（阶段间裁剪的另一半——不带完整会话历史）", () => {
    const seg = /async function\* streamStageFlow[\s\S]*?\n\}\n/.exec(main);
    expect(seg).not.toBeNull();
    const body = seg![0];
    expect(body).toMatch(/history: \[\],\s*\/\/[^\n]*阶段间裁剪/);
  });

  it("`stageOverride` 透传（阶段级 toolsOnly/maxRounds——只换跑什么）", () => {
    const body = /async function\* streamStageFlow[\s\S]*?\n\}\n/.exec(main)![0];
    expect(body).toMatch(/stageOverride: \{/);
    expect(body).toMatch(/toolsOnly: \[\.\.\.stage\.tools\]/);
    expect(body).toMatch(/maxRounds: stage\.maxRounds/);
  });

  it("边界：abort ⇒ 后续阶段不再开始；插件离线 ⇒ 收束并如实说明（不静默）", () => {
    const body = /async function\* streamStageFlow[\s\S]*?\n\}\n/.exec(main)![0];
    expect(body).toMatch(/opts\.signal\?\.aborted/);
    expect(body).toMatch(/canContinue/);
    expect(body).toContain("后续阶段不再执行");
    expect(body).toContain("所属扩展已停用");
  });

  it("收束段必须经 `clipCarry` 裁剪（不留完整工具输出——4 阶段 = 4 倍 token 的防线）", () => {
    const body = /async function\* streamStageFlow[\s\S]*?\n\}\n/.exec(main)![0];
    expect(body).toMatch(/carried = clipCarry\(doneReply \|\| stageText\)/);
  });

  it("分派接线：resolveRunnerKind 用于 main，mode 不可用 ⇒ 回落且原因写进对话", () => {
    expect(main).toMatch(/resolveRunnerKind\(\{/);
    expect(main).toMatch(/sessionMode/);
    expect(main).toMatch(/runnerKind\.fellBack/);
    expect(main).toContain("回落到默认模式");
    /* 三分支都在：mode → brainstorm → agent-loop。 */
    expect(main).toMatch(/modeRec\s*\n?\s*\? streamStageFlow\(/);
    expect(main).toMatch(/isBrainstorm/);
    expect(main).toMatch(/chatService!\.stream\(agentId, req/);
  });
});

describe("A-1198-E ③ chat.ts 的 stageOverride 透传（两处，默认口径不变）", () => {
  it("toolsOnly 与 maxRounds 都优先取 stageOverride、缺省回落到既有口径", () => {
    const chat = read("core-ts/src/services/chat.ts");
    expect(chat).toMatch(/toolsOnly: req\.stageOverride\?\.toolsOnly \?\? this\.agentToolsFor\(agent\)/);
    expect(chat).toMatch(/maxRounds: req\.stageOverride\?\.maxRounds \?\? loopBudget\.maxRounds/);
  });

  it("SessionMeta 有可选 mode 字段（会话级选定；请求组装时读）", () => {
    const sessions = read("core-ts/src/services/sessions.ts");
    expect(sessions).toMatch(/mode\?: string;/);
  });
});

describe("A-1198-E ④ 选定入口：setMode 三层 + UI（会话级、二次确认、下一轮生效）", () => {
  it("core：`setSessionMode` 落 meta（withWriteLock + atomicWrite；空串 ⇒ 清除回默认）", () => {
    const sessions = read("core-ts/src/services/sessions.ts");
    const seg = /export async function setSessionMode[\s\S]*?\n\}/.exec(sessions);
    expect(seg).not.toBeNull();
    expect(seg![0]).toMatch(/withWriteLock/);
    expect(seg![0]).toMatch(/atomicWrite\(all\)/);
    expect(seg![0]).toMatch(/delete meta\.mode/);
  });

  it("IPC 两层：main handler 走 setSessionMode；preload 有 setMode", () => {
    const main = read("gui/src/main/index.ts");
    expect(main).toMatch(/IPC_CHANNELS\.sessions_set_mode/);
    expect(main).toMatch(/await setSessionMode\(payload\.sessionId/);
    const preload = read("gui/src/preload/index.ts");
    expect(preload).toMatch(/setMode: \(sessionId: string, mode: string\)/);
    expect(preload).toMatch(/slime:sessions:setMode/);
  });

  it("会话列表带 mode（当前值懒拉的数据源）", () => {
    const main = read("gui/src/main/index.ts");
    expect(main).toMatch(/mode: meta\.mode,/);
    const ipc = read("gui/src/shared/ipc.ts");
    expect(ipc).toMatch(/mode\?: string;/);
  });

  it("UI：下拉只列 loaded 且 hasMode 的插件；切换要二次确认；空值=默认", () => {
    const chat = read("gui/src/renderer/pages/ChatPanel.tsx");
    expect(chat).toMatch(/p\?\.hasMode === true && p\?\.status === "loaded"/);
    expect(chat).toMatch(/confirmAsync\(`切换运行模式为/);
    expect(chat).toContain("默认（模型 + 工具）");
    expect(chat).toMatch(/api\.sessions\.setMode\(sessionId, next\)/);
    /* 已停用的选中项要如实标注（不假装还能跑）。 */
    expect(chat).toContain("（已停用）");
  });
});
