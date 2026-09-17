/**
 * brainstorm-panel.spec.ts — 群聊右栏供应商/模型解析纯函数回归（A-951）。
 * parseProviderModel：从 model_choice（api:<provider>[:<model>] / local:<id> / inherit）拆出供应商与模型两段。
 */
import { describe, it, expect } from "vitest";
import { parseProviderModel, modelWindowCap } from "../../gui/src/renderer/pages/BrainstormPanel.js";

describe("parseProviderModel（供应商/模型拆分）", () => {
  it("api:provider:model → 供应商+模型", () => {
    expect(parseProviderModel("api:openai:gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(parseProviderModel("api:deepseek:deepseek-chat")).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });
  it("api:provider（无模型段）→ 仅供应商；空模型不占位", () => {
    expect(parseProviderModel("api:minmax:")).toEqual({ provider: "minmax", model: undefined });
  });
  it("local:<id> → 供应商=本地", () => {
    expect(parseProviderModel("local:qwen3b")).toEqual({ provider: "本地", model: "qwen3b" });
    expect(parseProviderModel("local:  ")).toEqual({ provider: "本地", model: undefined });
  });
  it("inherit → 继承（无模型段）", () => {
    expect(parseProviderModel("inherit")).toEqual({ provider: "继承", model: undefined });
  });
  it("未知格式 → 自定义；空串 → 空对象", () => {
    expect(parseProviderModel("some-custom-model")).toEqual({ provider: "自定义", model: "some-custom-model" });
    expect(parseProviderModel("")).toEqual({});
    expect(parseProviderModel("  ")).toEqual({});
  });
});

describe("modelWindowCap（A-954 入群模型 → 池容量 context_window）", () => {
  const specs = [
    { key: "openai", models: [{ id: "gpt-4o", context_window: 128000 }, { id: "gpt-4o-mini", context_window: 32768 }] },
    { key: "deepseek", models: [{ id: "deepseek-chat", context_window: 64000 }] },
  ];
  it("api:key:model 命中供应商规格 → 返回 context_window", () => {
    expect(modelWindowCap("api:openai:gpt-4o", specs)).toBe(128000);
    expect(modelWindowCap("api:deepseek:deepseek-chat", specs)).toBe(64000);
  });
  it("未命中（供应商无此模型/无规格）→ undefined", () => {
    expect(modelWindowCap("api:openai:gpt-5", specs)).toBeUndefined();
    expect(modelWindowCap("api:no-such:model", specs)).toBeUndefined();
    expect(modelWindowCap("local:qwen3b", specs)).toBeUndefined(); // 本地模型不走 providerModels
    expect(modelWindowCap("silam", specs)).toBeUndefined();
  });
  it("空串/缺规格 → undefined，不抛", () => {
    expect(modelWindowCap("", specs)).toBeUndefined();
    expect(modelWindowCap("api:openai:gpt-4o", undefined)).toBeUndefined();
  });
});