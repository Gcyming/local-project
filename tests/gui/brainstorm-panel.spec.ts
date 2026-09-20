/**
 * brainstorm-panel.spec.ts — 群聊右栏纯函数回归（A-951 / A-1011）。
 * parseProviderModel：从 model_choice（api:<provider>[:<model>] / local:<id> / inherit）拆出供应商与模型两段。
 * modelWindowCap（A-954）：入群模型 → 该成员上下文池 cap。
 * memberEffortCap / effortLabel / mergeEffortOverrides（A-1011）：成员思考推理强度的可选等级与覆盖合并。
 */
import { describe, it, expect } from "vitest";
import {
  parseProviderModel,
  modelWindowCap,
  memberEffortCap,
  effortLabel,
  mergeEffortOverrides,
} from "../../gui/src/renderer/pages/BrainstormPanel.js";

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

/* ── A-1011：群聊成员「思考推理强度」纯逻辑 ───────────────────────
 * 这三条锁死的是「不许给假旋钮」这个语义：模型不接收等级时不给可点的等级胶囊，
 * 只给说明；否则用户调了没反应，会误以为程序坏了。 */
describe("memberEffortCap（成员模型 → 可选等级 + 是否真会生效）", () => {
  it("本地模型：不给等级（引擎对 kind=local 一律回 chat_template_kwargs，等级不生效）", () => {
    for (const c of ["local:qwen3b", "local:agnes"]) {
      const cap = memberEffortCap(c);
      expect(cap.effective).toBe(false);
      expect(cap.levels).toEqual([]);
      expect(cap.note).toContain("llama.cpp");
    }
  });
  it("已知家族命中且用 reasoning_effort 协议 → 有等级，且说明「只作用于本群聊这位成员」", () => {
    const cap = memberEffortCap("api:openai:gpt-5.1");
    expect(cap.effective).toBe(true);
    expect(cap.levels.length).toBeGreaterThan(0);
    expect(cap.note).toContain("仅作用于本群聊");
  });
  it("非 reasoning_effort 协议（Qwen enable_thinking）→ 给等级也把协议说明白，不冒充纯等级协议", () => {
    const cap = memberEffortCap("api:dashscope:qwen3.8-max-0902");
    expect(cap.levels.length).toBeGreaterThan(0);
    expect(cap.note).toContain("enable_thinking");
  });
  it("未命中/未解析到模型 → 不低于 low/medium/high 通用兜底（保证总是可选，与 ChatPanel 推理配置同源）", () => {
    for (const c of ["api:relay:some-unknown-model-2099", "api:relay:", ""]) {
      const cap = memberEffortCap(c);
      expect(cap.levels).toEqual(expect.arrayContaining(["low", "medium", "high"]));
      expect(cap.effective).toBe(true);
    }
  });
  it("空串不抛", () => {
    expect(() => memberEffortCap("")).not.toThrow();
    expect(() => memberEffortCap(undefined as unknown as string)).not.toThrow();
  });
});

describe("effortLabel（等级 → 展示名）", () => {
  it("已知等级取中文名；未设置/空串回落群聊默认（high）的展示名", () => {
    expect(effortLabel("low")).toBe("低");
    expect(effortLabel("xhigh")).toBe("极高");
    expect(effortLabel(undefined)).toBe("高");
    expect(effortLabel("")).toBe("高");
  });
  it("未收录等级原样显示（不硬翻）", () => {
    expect(effortLabel("super-mega")).toBe("super-mega");
  });
});

describe("mergeEffortOverrides（props 持久化值 × 本地刚写入值）", () => {
  it("无本地写入 → 取 props，并把 leaderEffort 归到 leaderId 名下", () => {
    expect(mergeEffortOverrides({ a: "low" }, "L", "high", {})).toEqual({ a: "low", L: "high" });
  });
  it("本地写入压过 props（会话列表刷新落后于写入，不能把刚设的值盖回旧的）", () => {
    expect(mergeEffortOverrides({ a: "low" }, "", undefined, { a: "xhigh" })).toEqual({ a: "xhigh" });
  });
  it("本地 null 是墓碑：必须能清掉 props 里的旧值（否则「恢复默认」下次刷新会长回来）", () => {
    expect(mergeEffortOverrides({ a: "low", b: "high" }, "", undefined, { a: null })).toEqual({ b: "high" });
  });
  it("leaderId 为空或缺省 leaderEffort → 不产生多余键", () => {
    expect(mergeEffortOverrides(undefined, "", undefined, {})).toEqual({});
    expect(mergeEffortOverrides({}, "L", undefined, {})).toEqual({});
  });
});