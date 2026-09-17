/**
 * context-math.spec.ts — 上下文 UI 纯计算回归（F：ContextRing/ContextWindowBar 计算层单测）。
 * 覆盖：环占比 clamp / 百分比 / 三档色阶阈值 / 构成四段占比 / 8 源分桶归一与排序。
 */
import { describe, it, expect } from "vitest";
import { contextRatio, contextPct, ringLevel, composeSegments, bucketsSegments } from "../../gui/src/renderer/pages/contextMath.js";

describe("contextRatio / contextPct（环基础）", () => {
  it("cap=0 → 0；常规占比 clamp 0..1", () => {
    expect(contextRatio(100, 0)).toBe(0);
    expect(contextRatio(500, 1000)).toBe(0.5);
    expect(contextRatio(-5, 1000)).toBe(0);
    expect(contextRatio(9999, 1000)).toBe(1);
  });
  it("百分比整数化", () => {
    expect(contextPct(0.5)).toBe(50);
    expect(contextPct(0.856)).toBe(86);
  });
});

describe("ringLevel 色阶阈值（绿<60% / 黄 60-85% / 红 >85%）", () => {
  it("三档边界", () => {
    expect(ringLevel(0.59).color).toBe("var(--success)");
    expect(ringLevel(0.6).color).toBe("var(--warning)");
    expect(ringLevel(0.8499).color).toBe("var(--warning)");
    expect(ringLevel(0.85).color).toBe("var(--danger)");
    expect(ringLevel(1).color).toBe("var(--danger)");
  });
  it("语义标签同步", () => {
    expect(ringLevel(0.1).label).toBe("充足");
    expect(ringLevel(0.7).label).toBe("接近上限");
    expect(ringLevel(0.9).label).toBe("逼近硬阈值");
  });
});

describe("composeSegments 四项构成", () => {
  it("4:2:3:1 归一为 40% / 20% / 30% / 10%", () => {
    const { segments, any } = composeSegments({ promptTokens: 40, cacheReadTokens: 20, completionTokens: 30, reasoningTokens: 10 });
    expect(any).toBe(true);
    expect(segments.find((s) => s.label === "输入")!.pct).toBeCloseTo(40, 5);
    expect(segments.find((s) => s.label === "缓存")!.pct).toBeCloseTo(20, 5);
    expect(segments.find((s) => s.label === "输出")!.pct).toBeCloseTo(30, 5);
    expect(segments.find((s) => s.label === "思考")!.pct).toBeCloseTo(10, 5);
  });
  it("全零 → any=false、段 pct 为 0（不渲染微条）", () => {
    const { any, segments } = composeSegments({ promptTokens: 0, cacheReadTokens: 0, completionTokens: 0, reasoningTokens: 0 });
    expect(any).toBe(false);
    expect(segments.every((s) => s.pct === 0)).toBe(true);
  });
});

describe("bucketsSegments 8 源分桶", () => {
  it("归一占比并按 pct 降序", () => {
    const { segments, any } = bucketsSegments([
      { key: "history", tokens: 6000 },
      { key: "tools", tokens: 2000 },
      { key: "system", tokens: 2000 },
    ]);
    expect(any).toBe(true);
    expect(segments[0].key).toBe("history");
    expect(segments[0].pct).toBe(60);
    expect(segments[1].pct).toBe(20);
    expect(segments[2].pct).toBe(20);
  });
  it("空/全零 → any=false", () => {
    expect(bucketsSegments([]).any).toBe(false);
    expect(bucketsSegments([{ key: "x", tokens: 0 }]).any).toBe(false);
  });
});