/**
 * A-1197 · B3（L4c）：`resolveRunnerKind` 的**优先级与回落**（设计 §4.3 的硬口径）。
 * 「显式 mode 会话 > brainstorm > agent-loop」；扩展被禁用 ⇒ 回落 + **带回原因**（不静默）。
 */
import { describe, it, expect } from "vitest";
import { resolveRunnerKind, runnerLabel, RUNNER_LABELS } from "../../core-ts/src/services/chatRunner.js";

describe("A-1198-R ① 优先级：显式 mode > brainstorm > agent-loop", () => {
  it("显式 mode 优先于 brainstorm（两者同时成立时按 mode）", () => {
    const r = resolveRunnerKind({ sessionMode: "my-pipeline", isBrainstorm: true });
    expect(r.kind).toBe("mode:my-pipeline");
    expect(r.fellBack).toBe(false);
  });

  it("无显式 mode + brainstorm ⇒ brainstorm（既有第二范式，行为不变）", () => {
    const r = resolveRunnerKind({ isBrainstorm: true });
    expect(r.kind).toBe("brainstorm");
  });

  it("都没有 ⇒ agent-loop（默认）", () => {
    const r = resolveRunnerKind({});
    expect(r.kind).toBe("agent-loop");
    expect(r.fellBack).toBe(false);
  });
});

describe("A-1198-R ② 回落：扩展被禁用/卸载 ⇒ agent-loop + 原因（不静默换模式）", () => {
  it("显式 mode 不可用 ⇒ 回落且 `fellBack: true`、reason 里点名原因", () => {
    const r = resolveRunnerKind({
      sessionMode: "my-pipeline",
      isModeAvailable: () => false,
    });
    expect(r.kind).toBe("agent-loop");
    expect(r.fellBack).toBe(true);
    expect(r.reason).toContain("my-pipeline");
    expect(r.reason).toContain("回落");
  });

  it("可用 ⇒ 不回落", () => {
    const r = resolveRunnerKind({ sessionMode: "my-pipeline", isModeAvailable: () => true });
    expect(r.kind).toBe("mode:my-pipeline");
    expect(r.fellBack).toBe(false);
  });

  it("空串 sessionMode（未选模式）不算显式模式", () => {
    const r = resolveRunnerKind({ sessionMode: "   " });
    expect(r.kind).toBe("agent-loop");
    expect(r.fellBack).toBe(false);
  });
});

describe("A-1198-R ③ 展示名", () => {
  it("内置两种有展示名；mode 用声明的 title（缺省用 key）；未知 kind 如实回原串", () => {
    expect(runnerLabel("agent-loop")).toBe(RUNNER_LABELS["agent-loop"]);
    expect(runnerLabel("brainstorm")).toBe(RUNNER_LABELS.brainstorm);
    expect(runnerLabel("mode:my-pipeline", "我的流水线")).toBe("我的流水线");
    expect(runnerLabel("mode:my-pipeline")).toBe("my-pipeline");
    expect(runnerLabel("ghost-kind")).toBe("ghost-kind");
  });
});
