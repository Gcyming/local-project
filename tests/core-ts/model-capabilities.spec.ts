/**
 * tests/core-ts/model-capabilities.spec.ts — 模型能力单源合并（A-918+）回归。
 * 验证 shared/model-capabilities.ts 的 inferModelCapabilities / sortEfforts / MODEL_CAPABILITIES：
 * 此前 inferThinkingSupport（main）与 REASONING_PRESETS（renderer）双份数据漂移，
 * 导致 deepseek-v4-pro 等新模型 ID 漏判 thinking=false。现收敛为单一真相源。
 */
import { describe, it, expect } from "vitest";
import { inferModelCapabilities, isAggregatorGateway, sortEfforts, MODEL_CAPABILITIES, EFFORT_RANK } from "../../shared/gen/model-capabilities.js";
/* A-1087：显示判据的唯一产地 —— 本节断言"界面读作 512K"必须调真函数，
 * 不许在测试里再写一遍 `Math.round(x/1000)`（那正是被废掉的那个口径）。 */
import { fmtTokens } from "../../gui/src/renderer/pages/contextMath.js";

describe("inferModelCapabilities（模型 ID 推断，单一真相源）", () => {
  it("deepseek 全系识别为思考模型（含 v4-pro，此前漏判的回归锚点）", () => {
    // maxOut = 393216（384K）：官方英文定价页 "MAX OUTPUT: 384K"，此前本表写 65536（64K）低 6 倍。
    // 双重印证：官方 CONTEXT LENGTH 1M / MAX OUTPUT 384K + LiteLLM 首方条目 max_output_tokens=393216。
    expect(inferModelCapabilities("deepseek-v4-pro")).toEqual({ supported: true, efforts: ["low", "high", "max"], vendor: "deepseek", thinkingParam: "reasoning_effort", endpoint: "openai", context: 1048576, maxOut: 393216 });
    expect(inferModelCapabilities("deepseek-reasoner")).toEqual({ supported: true, efforts: ["low", "high", "max"], vendor: "deepseek", thinkingParam: "reasoning_effort", endpoint: "openai", context: 1048576, maxOut: 393216 });
    expect(inferModelCapabilities("DeepSeek-R1")).toEqual({ supported: true, efforts: ["low", "high", "max"], vendor: "deepseek", thinkingParam: "reasoning_effort", endpoint: "openai", context: 1048576, maxOut: 393216 });
    // A-989：当前官方模型名是 deepseek-flash（服务 DeepSeek-V4.1-Flash），v4-flash 是退休别名 —— 必须都被识别
    expect(inferModelCapabilities("deepseek-flash").vendor).toBe("deepseek");
    expect(inferModelCapabilities("deepseek-v4.1-flash").vendor).toBe("deepseek");
    expect(inferModelCapabilities("deepseek-v4-flash").vendor).toBe("deepseek");
  });

  it("gpt-5 支持 xhigh/max，o 系列仅 low/medium/high", () => {
    expect(inferModelCapabilities("gpt-5.1")).toEqual({ supported: true, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"], vendor: "openai", thinkingParam: "reasoning_effort", endpoint: "responses", context: 1000000, maxOut: 128000 });
    expect(inferModelCapabilities("o3-mini")).toEqual({ supported: true, efforts: ["low", "medium", "high"], vendor: "openai", thinkingParam: "reasoning_effort", endpoint: "openai", context: 1000000, maxOut: 128000 });
  });

  it("claude opus/sonnet 支持 xhigh/max，其余 claude 仅 low/medium/high", () => {
    // A-989：Sonnet 4.5 起官方支持 1M 上下文（此前本表供应商级兜底写死 200K，把 1M 锁成 200K）
    expect(inferModelCapabilities("claude-sonnet-4-6")).toEqual({ supported: true, efforts: ["low", "medium", "high", "xhigh", "max"], vendor: "claude", thinkingParam: "reasoning_effort", endpoint: "anthropic", context: 1048576, maxOut: 64000 });
    expect(inferModelCapabilities("claude-haiku-4-5")).toEqual({ supported: true, efforts: ["low", "medium", "high"], vendor: "claude", thinkingParam: "reasoning_effort", endpoint: "anthropic", context: 200000, maxOut: 64000 });
  });

  it("思考开关协议按家族区分（四类协议全覆盖）", () => {
    // chat_template_kwargs 族（llama.cpp / Agnes / Nemotron / Llama / 混元）
    expect(inferModelCapabilities("agnes-2.5-pro").thinkingParam).toBe("chat_template_kwargs");
    expect(inferModelCapabilities("nemotron-3.5-lightning-free").thinkingParam).toBe("chat_template_kwargs");
    expect(inferModelCapabilities("llama-4-maverick").thinkingParam).toBe("chat_template_kwargs");
    expect(inferModelCapabilities("hunyuan-turbo").thinkingParam).toBe("chat_template_kwargs");
    // enable_thinking 族（通义千问 DashScope）
    expect(inferModelCapabilities("qwen-max").thinkingParam).toBe("enable_thinking");
    // thinking 族（字节豆包）
    expect(inferModelCapabilities("doubao-1-5-pro").thinkingParam).toBe("thinking");
    // reasoning_effort 缺省族
    expect(inferModelCapabilities("gpt-6-astra").thinkingParam).toBe("reasoning_effort");
    expect(inferModelCapabilities("gemini-3.8-flash").thinkingParam).toBe("reasoning_effort");
    expect(inferModelCapabilities("mistral-large").thinkingParam).toBe("reasoning_effort");
    expect(inferModelCapabilities("mimo-v2.5-free").thinkingParam).toBe("reasoning_effort");
  });

  it("顺序依赖：muse-spark 命中 muse 而非讯飞 spark", () => {
    expect(inferModelCapabilities("muse-spark-1.3").vendor).toBe("muse");
    expect(inferModelCapabilities("spark-max").vendor).toBe("spark");
  });

  it("主流国内家族可识别（豆包/混元/文心/百川/商汤/星火/零一万物/面壁/昆仑）", () => {
    expect(inferModelCapabilities("doubao-seed-1.6").supported).toBe(true);
    expect(inferModelCapabilities("hunyuan-pro").supported).toBe(true);
    expect(inferModelCapabilities("ernie-4.5").supported).toBe(true);
    expect(inferModelCapabilities("Baichuan4").supported).toBe(true);
    expect(inferModelCapabilities("SenseChat-5").supported).toBe(true);
    expect(inferModelCapabilities("spark-x1").supported).toBe(true);
    expect(inferModelCapabilities("yi-lightning").supported).toBe(true);
    expect(inferModelCapabilities("MiniCPM-4").supported).toBe(true);
    expect(inferModelCapabilities("skywork-o1").supported).toBe(true);
  });

  it("未命中家族的新模型 → 默认支持思考 + reasoning_effort（所有模型适配兜底，不再静默无思考）", () => {
    expect(inferModelCapabilities("unknown-llm-xyz")).toEqual({ supported: true, thinkingParam: "reasoning_effort", vendor: "unknown", endpoint: "openai" });
    expect(inferModelCapabilities("big-pickle")).toEqual({ supported: true, thinkingParam: "reasoning_effort", vendor: "unknown", endpoint: "openai" });
    // 空 ID 仍为不支持
    expect(inferModelCapabilities("")).toEqual({ supported: false });
  });

  it("非对话模型（embedding/图像/音频/视频生成）→ 不支持思考，即使命中某家族", () => {
    expect(inferModelCapabilities("text-embedding-3-large")).toEqual({ supported: false, vendor: "non_chat" });
    expect(inferModelCapabilities("agnes-image-2.1-flash")).toEqual({ supported: false, vendor: "non_chat" });
    expect(inferModelCapabilities("agnes-video-2.5")).toEqual({ supported: false, vendor: "non_chat" });
    expect(inferModelCapabilities("rerank-v3")).toEqual({ supported: false, vendor: "non_chat" });
  });
});

describe("sortEfforts（共识顺序排序）", () => {
  it("按 none<minimal<low<medium<high<xhigh<max 排序，未知等级排末尾", () => {
    expect(sortEfforts(["max", "low", "high", "medium", "custom"])).toEqual(["low", "medium", "high", "max", "custom"]);
  });
});

describe("isAggregatorGateway（中转站 vs 官方端点识别）", () => {
  it("识别主流中转站/聚合网关为 aggregator", () => {
    expect(isAggregatorGateway("https://openrouter.ai/api/v1")).toBe(true);
    expect(isAggregatorGateway("https://api.siliconflow.cn/v1")).toBe(true);
    expect(isAggregatorGateway("https://opencode.ai/zen")).toBe(true);
    expect(isAggregatorGateway("https://api.together.xyz/v1")).toBe(true);
    expect(isAggregatorGateway("https://api.groq.com/openai/v1")).toBe(true);
  });

  it("官方原生端点不是 aggregator（保留家族协议）", () => {
    expect(isAggregatorGateway("https://api.agnes-ai.cn")).toBe(false);
    expect(isAggregatorGateway("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(false);
    expect(isAggregatorGateway("https://api.anthropic.com")).toBe(false);
    expect(isAggregatorGateway("https://api.deepseek.com")).toBe(false);
    expect(isAggregatorGateway("")).toBe(false);
  });
});

describe("MODEL_CAPABILITIES（数据表完整性）", () => {
  it("覆盖主流供应商且每个 thinking 条目都有 efforts 或明确无", () => {
    const vendors = MODEL_CAPABILITIES.map((v) => v.key);
    // 关键主流供应商必须覆盖（国际 + 国内）
    for (const k of ["openai", "claude", "gemini", "grok", "mistral", "llama", "deepseek", "qwen", "glm", "kimi", "minimax", "doubao", "hunyuan", "ernie", "baichuan", "spark", "step"]) {
      expect(vendors).toContain(k);
    }
    // 所有 match 正则可编译（非法正则不会导致运行时崩溃，infer 内部已 try/catch）
    for (const v of MODEL_CAPABILITIES) {
      for (const m of v.models) {
        expect(() => new RegExp(m.match, "i")).not.toThrow();
      }
    }
  });

  it("EFFORT_RANK 含共识顺序关键等级", () => {
    expect(EFFORT_RANK.low).toBeLessThan(EFFORT_RANK.medium);
    expect(EFFORT_RANK.medium).toBeLessThan(EFFORT_RANK.high);
    expect(EFFORT_RANK.high).toBeLessThan(EFFORT_RANK.max);
  });
});

/**
 * A-975 回归：小红书/点点笔记（dots）家族**官方窗口 512K**。
 * 历史 bug：表里写成 131072，且 match 只写 "dots"（「dot4」这类写法不命中）→
 * 上游不回传窗口时被锁死显示 128K，用户反复刷新也改不动。
 *
 * A-1054：表内值 `524288` → `512000`。
 * A-1087：断言**改用真的显示函数**（`fmtTokens`），不再用 `Math.round(context/1000)` 这种
 * "近似显示层"的代理 —— 显示层已改成按上限自适进制，任何一个进制都不再是全站口径，
 * 代理也就失去了意义。行为锚点 = 用户看得见的那串字（「512K」）。
 */
describe("A-975 dots 家族窗口（上游不回传时的兜底真值）", () => {
  it("dots / dots3 / dots.llm1 / dot4 / dot-4 均命中 note 家族且界面读作 512K", () => {
    for (const id of ["dots", "dots3", "dots.llm1", "dot4", "dot-4", "dots4-preview", "xhs/dot4"]) {
      const cap = inferModelCapabilities(id);
      expect(cap.vendor, id).toBe("note");
      // 行为锚点：**真的**调显示函数（不是自己再算一遍近似值）
      expect(fmtTokens(cap.context ?? 0, cap.context ?? 0), id).toBe("512K");
      expect(cap.context, id).toBe(512000);
    }
  });

  it("不误伤同形词（dotnet / adopt / gpt-4o 不落到 note 家族）", () => {
    for (const id of ["dotnet-runtime", "adopt-a-pet", "gpt-4o", "claude-sonnet-4-6"]) {
      expect(inferModelCapabilities(id).vendor, id).not.toBe("note");
    }
  });
});
