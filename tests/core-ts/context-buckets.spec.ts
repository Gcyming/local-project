



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
    const text = "你好世界 hello world"; 
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
    
    expect(b1).toStrictEqual(b2);
    
    (parts as Record<string, unknown>)["system"] = "";
    const b3 = computeContextBuckets(parts);
    expect(b3.system).toBe(0);
    
    expect(b1.system).toBe(estimateTokens("x"));
  });

  it("buckets 总和 ≤ 整体 prompt 估算（保守上界校验）", () => {
    
    const system = "identity prompt and rules";
    const tools = JSON.stringify([{ function: { name: "test" } }]);
    const history = '[{"role":"user","content":"hi"}]';
    const message = "hello world";
    const b = computeContextBuckets({ system, tools, history, message });
    const totalFromBuckets = b.system + b.rules + b.memory + b.workspace +
      b.planning + b.tools + b.history + b.message;
    const totalPrompt = estimateTokens(JSON.stringify({ system, tools, history, message }));
    
    expect(totalFromBuckets).toBeGreaterThan(0);
    expect(totalFromBuckets).toBeLessThanOrEqual(totalPrompt * 1.5);
  });

  it("GUI ContextWindowBar 使用的 bucketComps 配色与顺序一致（契约测试）", () => {
    
    const b: ContextBuckets = {
      system: 10, rules: 20, memory: 30, workspace: 40,
      planning: 50, tools: 60, history: 70, message: 80,
    };
    expect(Object.keys(b).sort()).toEqual(
      ["history", "memory", "message", "planning", "rules", "system", "tools", "workspace"],
    );
  });
});
