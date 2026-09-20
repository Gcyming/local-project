import { describe, it, expect } from "vitest";
import {
  probe,
  identifyVendor,
  detectCapabilityFields,
  vendorToApiFormat,
  type ProbeObservation,
} from "../../core-ts/src/probe.js";

describe("probe 厂商指纹识别器", () => {
  describe("官方域名优先（最高置信）", () => {
    it("OpenAI 官方", () => {
      const r = probe({ endpoint: "https://api.openai.com/v1/models", auth: "bearer", modelCount: 50 }, "https://api.openai.com/v1");
      expect(r.vendor).toBe("openai-official");
      expect(r.apiFormat).toBe("openai");
      expect(r.confidence).toBeGreaterThanOrEqual(0.95);
    });
    it("Anthropic 官方（x-api-key）", () => {
      const r = probe({ endpoint: "https://api.anthropic.com/v1/models", auth: "x-api-key", modelCount: 10 }, "https://api.anthropic.com/v1");
      expect(r.vendor).toBe("anthropic-official");
      expect(r.apiFormat).toBe("anthropic");
    });
    it("Google 官方（x-goog-api-key）", () => {
      const r = probe({ endpoint: "https://generativelanguage.googleapis.com/v1beta/models", auth: "x-goog-api-key", modelCount: 20 }, "https://generativelanguage.googleapis.com/v1beta");
      expect(r.vendor).toBe("google-official");
      expect(r.apiFormat).toBe("google");
    });
  });

  describe("已知网关识别", () => {
    it("OpenRouter", () => {
      const r = probe({ endpoint: "https://openrouter.ai/api/v1/models", auth: "bearer", modelCount: 100 }, "https://openrouter.ai/api/v1");
      expect(r.vendor).toBe("openrouter");
      expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    });
    it("new-api 系（/api/pricing 端点）", () => {
      const r = probe({ endpoint: "http://127.0.0.1:3000/api/pricing", auth: "bearer", modelCount: 60 }, "http://127.0.0.1:3000");
      expect(r.vendor).toBe("newapi");
      expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    });
    it("opencode", () => {
      const r = probe({ endpoint: "https://opencode.ai/zen/v1/models", auth: "bearer", modelCount: 6 }, "https://opencode.ai/zen");
      expect(r.vendor).toBe("opencode");
    });
    it("agnes", () => {
      const r = probe({ endpoint: "https://api.agnes-ai.cn/v1/models", auth: "bearer", modelCount: 12 }, "https://api.agnes-ai.cn/v1");
      expect(r.vendor).toBe("agnes");
    });
  });

  describe("泛化识别（generic-openai-compat）", () => {
    it("有公开 pricing → 倾向聚合网关，但无官方域名 → generic/newapi", () => {
      const r = probe({ endpoint: "https://some-gateway.example.com/v1/models", auth: "bearer", modelCount: 30, hasPricing: true }, "https://some-gateway.example.com/v1");
      // 无新-api 端点特征、无官方域名 → generic-openai-compat
      expect(["generic-openai-compat", "newapi"]).toContain(r.vendor);
      expect(r.apiFormat).toBe("openai");
    });
    it("端点返回 0 模型 + 无 pricing + 无域名特征 → 证据不足降为 unknown", () => {
      const r = probe({ endpoint: "https://x.example.com/foo", auth: "none", modelCount: 0 }, "https://x.example.com");
      expect(r.confidence).toBeLessThan(0.4);
      expect(r.vendor).toBe("unknown");
    });
    it("未知域名但 Bearer + 返回模型 → 仍走 OpenAI 兼容（命中面最广）", () => {
      const r = probe({ endpoint: "https://random-cdn.example.net/api/models", auth: "bearer", modelCount: 40 }, "https://random-cdn.example.net/api");
      expect(r.apiFormat).toBe("openai");
    });
  });

  describe("能力字段方言", () => {
    it("识别 vision / reasoning / context / pricing 字段", () => {
      const caps = detectCapabilityFields([
        { id: "m1", vision: true, reasoning: { supported_efforts: ["low", "high"] }, context_length: 128000, pricing: { prompt: "0.005" } },
      ]);
      expect(caps?.visionField).toBeDefined();
      expect(caps?.reasoningField).toBeDefined();
      expect(caps?.contextField).toBeDefined();
      expect(caps?.pricingField).toBeDefined();
    });
    it("空 items → undefined", () => {
      expect(detectCapabilityFields(undefined)).toBeUndefined();
      expect(detectCapabilityFields([])).toBeUndefined();
    });
    it("只认 architecture.modality=image+text 的视觉", () => {
      const caps = detectCapabilityFields([{ id: "m", architecture: { modality: "image+text" } }]);
      expect(caps?.visionField).toBe("vision");
    });
  });

  describe("vendorToApiFormat", () => {
    it("OpenAI 系 → openai", () => {
      expect(vendorToApiFormat("generic-openai-compat")).toBe("openai");
      expect(vendorToApiFormat("openrouter")).toBe("openai");
      expect(vendorToApiFormat("newapi")).toBe("openai");
    });
    it("Anthropic/Google 官方 → 对应格式", () => {
      expect(vendorToApiFormat("anthropic-official")).toBe("anthropic");
      expect(vendorToApiFormat("google-official")).toBe("google");
    });
    it("unknown → openai（默认）", () => {
      expect(vendorToApiFormat("unknown")).toBe("openai");
    });
  });

  describe("identifyVendor 直接调用", () => {
    it("x-api-key 鉴权 + Anthropic 风格", () => {
      const obs: ProbeObservation = { endpoint: "https://gw.example.com/v1/models", auth: "x-api-key", modelCount: 8 };
      const r = identifyVendor("https://gw.example.com/v1", obs);
      expect(r.signals.join(" ")).toMatch(/x-api-key/);
    });
  });
});
