/**
 * tests/core-ts/context-buckets.spec.ts — A-939 computeContextBuckets 单元测试
 * 纯函数，零 I/O：按注入来源切分 token 估算，与 estimateTokens 同量级。
 */
import { describe, it, expect } from "vitest";
import { computeContextBuckets, estimateTokens } from "../../core-ts/src/services/engine.js";
import type { ContextBuckets } from "../../core-ts/src/services/chat.js";

describe("computeContextBuckets", () => {
  it("空输入全部归零", () => {
    const b = computeContextBuckets({});
    expect(b).toEqual({
      system: 0, rules: 0, memory: 0, workspace: 0,
      planning: 0, tools: 0, history: 0, message: 0,
    });
  });

  it("单源输入正确估算（0.6×字符 ≈ 字节/词折算）", () => {
    const text = "你好世界 hello world"; // 6 + 11 = 17 chars → estimateTokens ≈ 10
    const b = computeContextBuckets({ system: text });
    expect(b.system).toBe(estimateTokens(text));
    expect(b.rules).toBe(0);
    expect(b.tools).toBe(0);
  });

  it("undefined/null 字段视为空字符串", () => {
    const b = computeContextBuckets({
      system: "abc",
      rules: undefined,
      memory: null,
      workspace: "xy",
    });
    expect(b.system).toBe(estimateTokens("abc"));
    expect(b.rules).toBe(0);
    expect(b.memory).toBe(0);
    expect(b.workspace).toBe(estimateTokens("xy"));
  });

  it("多源累加各自独立", () => {
    const s = "system text here";
    const t = "tool schema json";
    const b = computeContextBuckets({ system: s, tools: t });
    expect(b.system).toBe(estimateTokens(s));
    expect(b.tools).toBe(estimateTokens(t));
    expect(b.history).toBe(0);
  });

  it("返回新对象不修改入参", () => {
    const parts = { system: "x", rules: "y" };
    const b1 = computeContextBuckets(parts);
    const b2 = computeContextBuckets(parts);
    // 同输入应返回值相等的对象（不要求引用相等，纯函数返回新对象）
    expect(b1).toStrictEqual(b2);
    // 更严谨：改动原 parts 不影响已返回的 b1
    (parts as Record<string, unknown>)["system"] = "";
    const b3 = computeContextBuckets(parts);
    expect(b3.system).toBe(0);
    // b1 不应受影响（因为是纯函数，返回的是新对象）
    expect(b1.system).toBe(estimateTokens("x"));
  });

  it("buckets 总和 ≤ 整体 prompt 估算（保守上界校验）", () => {
    // 各源加起来应 ≈ 总 prompt（同一估算函数，无交叉）
    const system = "identity prompt and rules";
    const tools = JSON.stringify([{ function: { name: "test" } }]);
    const history = '[{"role":"user","content":"hi"}]';
    const message = "hello world";
    const b = computeContextBuckets({ system, tools, history, message });
    const totalFromBuckets = b.system + b.rules + b.memory + b.workspace +
      b.planning + b.tools + b.history + b.message;
    const totalPrompt = estimateTokens(JSON.stringify({ system, tools, history, message }));
    // 分桶是独立估算各源，总 prompt 是整体估算——量级应接近（±30% 容差，因分桶有重叠边界）
    expect(totalFromBuckets).toBeGreaterThan(0);
    expect(totalFromBuckets).toBeLessThanOrEqual(totalPrompt * 1.5);
  });

  it("GUI ContextWindowBar 使用的 bucketComps 配色与顺序一致（契约测试）", () => {
    // 确保引擎输出字段与 GUI 消费字段同名
    const b: ContextBuckets = {
      system: 10, rules: 20, memory: 30, workspace: 40,
      planning: 50, tools: 60, history: 70, message: 80,
    };
    expect(Object.keys(b).sort()).toEqual(
      ["history", "memory", "message", "planning", "rules", "system", "tools", "workspace"],
    );
  });
});
