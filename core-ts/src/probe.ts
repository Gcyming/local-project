/**
 * core-ts/src/probe.ts — 探针层（厂商指纹识别器，第 1 层）。
 *
 * 定位：最大化 slime 对全平台 LLM 供应商的适配性。
 * 输入「一次握手探测结果」（命中哪套鉴权头 + 哪个端点 + 响应体关键信息），
 * 输出「协议族 + 鉴权方式 + 厂商类别 + 能力字段方言 + 置信度」。
 *
 * 与 router.ts 的 inferApiFormat（只按 baseUrl 域名猜）互补：
 *   - inferApiFormat 是"先验"（看 URL 猜），命中率高但覆盖面窄
 *   - 本探针是"后验"（看真实响应定），覆盖官方/中转/newapi 系/自建 OpenAI 兼容网关
 *
 * 纯函数、无 IO、可单测。上层（providers.ts / 网关）负责发请求 + 调用本模块。
 */

import type { ApiFormat } from "./router.js";

/** 一次握手探测的原始结果（上层发请求后填） */
export interface ProbeObservation {
  /** 最终命中的端点 URL */
  endpoint: string;
  /** 命中的鉴权方式 */
  auth: "bearer" | "x-api-key" | "x-goog-api-key" | "none";
  /** 上游厂商类别指纹（识别器输出，默认 unknown） */
  vendor?: VendorKind;
  /** 模型列表原始条目（含各厂家能力字段的响应体） */
  modelItems?: Array<Record<string, unknown>>;
  /** 该端点返回的模型数 */
  modelCount?: number;
  /** 握手实测延迟（ms） */
  latencyMs?: number;
  /** 厂商是否公开 pricing 元数据 */
  hasPricing?: boolean;
}

/** 厂商类别指纹（识别器输出） */
export type VendorKind =
  | "openai-official"
  | "anthropic-official"
  | "google-official"
  | "openrouter"
  | "newapi"          // new-api / one-api 系聚合网关
  | "agnes"
  | "opencode"
  | "generic-openai-compat"
  | "unknown";

/** 识别结果（探针输出） */
export interface ProbeResult {
  /** 应使用的端点格式 */
  apiFormat: ApiFormat;
  /** 命中的鉴权方式 */
  auth: ProbeObservation["auth"];
  /** 厂商类别 */
  vendor: VendorKind;
  /** 置信度（0~1；0.9+ 高，0.6+ 中，<0.4 低需人工确认） */
  confidence: number;
  /** 识别依据（人类可读，供 UI 展示/诊断） */
  signals: string[];
  /** 从模型条目解析出的能力方言（字段名映射） */
  capabilities?: {
    visionField?: string;
    reasoningField?: string;
    contextField?: string;
    pricingField?: string;
  };
}

/** 解析响应体里的"能力字段方言"——不同供应商字段名不同 */
export function detectCapabilityFields(items: Array<Record<string, unknown>> | undefined): ProbeResult["capabilities"] | undefined {
  if (!items || items.length === 0) { return undefined; }
  const sample = items.slice(0, 5);
  const out: NonNullable<ProbeResult["capabilities"]> = {};
  for (const it of sample) {
    const rec = it as Record<string, unknown>;
    // 视觉：vision / supports_vision / multimodal / architecture.type
    if (out.visionField === undefined &&
      (rec.vision === true || rec.supports_vision === true ||
        rec.multimodal === true ||
        (rec.architecture && typeof rec.architecture === "object" && (rec.architecture as any).modality === "image+text"))) {
      out.visionField = "vision";
    }
    // 推理：reasoning / supports_reasoning / thinking
    if (out.reasoningField === undefined &&
      (rec.reasoning !== undefined || rec.supports_reasoning === true || rec.thinking === true ||
        (rec.supported_reasoning_efforts !== undefined))) {
      out.reasoningField = "reasoning";
    }
    // 上下文：context_length / context_window / max_input_tokens
    if (out.contextField === undefined &&
      (typeof rec.context_length === "number" || typeof rec.context_window === "number" ||
        typeof rec.max_input_tokens === "number" || typeof rec.max_context_tokens === "number")) {
      out.contextField = "context_length";
    }
    // 定价：pricing / cost / price
    if (out.pricingField === undefined &&
      (rec.pricing !== undefined || rec.cost !== undefined ||
        (rec.model_price !== undefined) || rec.price_in_usd !== undefined)) {
      out.pricingField = "pricing";
    }
  }
  const filled = Object.values(out).some(Boolean);
  return filled ? out : undefined;
}

/** 按 baseUrl + 鉴权方式 + 响应特征识别厂商指纹 */
export function identifyVendor(baseUrl: string, obs: ProbeObservation): { vendor: VendorKind; confidence: number; signals: string[] } {
  const url = (baseUrl ?? "").toLowerCase();
  const endpoint = (obs.endpoint ?? "").toLowerCase();
  const auth = obs.auth;
  const signals: string[] = [];

  // 官方域名指纹
  if (url.includes("api.openai.com") || endpoint.includes("api.openai.com")) {
    signals.push("官方域名 api.openai.com");
    return { vendor: "openai-official", confidence: 0.98, signals };
  }
  if (url.includes("anthropic.com") || endpoint.includes("anthropic.com")) {
    signals.push("官方域名 anthropic.com");
    return { vendor: "anthropic-official", confidence: 0.98, signals };
  }
  if (url.includes("googleapis.com") || url.includes("generativelanguage")) {
    signals.push("官方域名 googleapis.com");
    return { vendor: "google-official", confidence: 0.98, signals };
  }
  // 已知聚合 / 网关
  if (url.includes("openrouter.ai") || endpoint.includes("openrouter")) {
    signals.push("网关 openrouter.ai");
    return { vendor: "openrouter", confidence: 0.95, signals };
  }
  if (url.includes("agnes-ai.cn") || endpoint.includes("agnes-ai")) {
    signals.push("网关 agnes-ai.cn");
    return { vendor: "agnes", confidence: 0.9, signals };
  }
  if (url.includes("opencode.ai") || endpoint.includes("opencode")) {
    signals.push("网关 opencode.ai");
    return { vendor: "opencode", confidence: 0.9, signals };
  }

  // 泛化识别（按鉴权 + 端点 + 响应特征打分）
  let score = 0;
  // new-api / one-api 系特征：/api/pricing 或 model_ratio 端点
  if (endpoint.includes("/api/pricing") || endpoint.includes("/api/ratio_config")) {
    signals.push("端点 /api/pricing 或 /api/ratio_config");
    return { vendor: "newapi", confidence: 0.9, signals };
  }
  if (obs.hasPricing === true) {
    // 有公开 pricing 元数据 → 大概率聚合网关（new-api/openrouter 系）
    score += 0.4;
    signals.push("上游公开 pricing 元数据");
  }
  // 鉴权方式
  if (auth === "x-api-key") {
    score += 0.2;
    signals.push("鉴权 x-api-key（Anthropic 风格）");
  } else if (auth === "x-goog-api-key") {
    score += 0.2;
    signals.push("鉴权 x-goog-api-key（Google 风格）");
  } else if (auth === "bearer") {
    score += 0.1;
    signals.push("鉴权 Bearer（OpenAI 风格，最通用）");
  }
  // 模型数（>0 说明端点真实可用）
  if ((obs.modelCount ?? 0) > 0) {
    score += 0.2;
    signals.push(`端点返回 ${obs.modelCount} 个模型`);
  }
  // 厂商类别：Bearer + OpenAI 兼容端点 → generic-openai-compat
  const vendor: VendorKind = (obs.vendor === "newapi" || obs.vendor === "openrouter")
    ? obs.vendor
    : "generic-openai-compat";
  const confidence = Math.min(1, score);
  if (confidence < 0.4 && obs.vendor === undefined) {
    // 证据不足，降为 unknown 让人工确认
    return { vendor: "unknown", confidence: Math.max(0.1, confidence - 0.1), signals: [...signals, "证据不足，建议人工确认"] };
  }
  return { vendor, confidence, signals };
}

/** 把厂商类别映射到 slime 的 ApiFormat（协议族） */
export function vendorToApiFormat(vendor: VendorKind): ApiFormat {
  switch (vendor) {
    case "openai-official":
    case "openrouter":
    case "agnes":
    case "opencode":
    case "newapi":
    case "generic-openai-compat":
      return "openai";
    case "anthropic-official":
      return "anthropic";
    case "google-official":
      return "google";
    default:
      return "openai"; // unknown 默认走 OpenAI 兼容（命中面最广）
  }
}

/** 探针主入口：识别 + 协议族 + 能力方言 一次性输出 */
export function probe(obs: ProbeObservation, baseUrl: string): ProbeResult {
  const { vendor, confidence, signals } = identifyVendor(baseUrl, obs);
  const apiFormat = obs.auth === "x-api-key" ? "anthropic"
    : obs.auth === "x-goog-api-key" ? "google"
    : vendorToApiFormat(vendor);
  const caps = detectCapabilityFields(obs.modelItems);
  if (caps) { signals.push(`能力字段：${Object.values(caps).filter(Boolean).join(", ")}`); }
  return { apiFormat, auth: obs.auth, vendor, confidence, signals, capabilities: caps };
}
