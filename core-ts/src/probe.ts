













import type { ApiFormat } from "./router.js";


export interface ProbeObservation {
  
  endpoint: string;
  
  auth: "bearer" | "x-api-key" | "x-goog-api-key" | "none";
  
  vendor?: VendorKind;
  
  modelItems?: Array<Record<string, unknown>>;
  
  modelCount?: number;
  
  latencyMs?: number;
  
  hasPricing?: boolean;
}


export type VendorKind =
  | "openai-official"
  | "anthropic-official"
  | "google-official"
  | "openrouter"
  | "newapi"          
  | "agnes"
  | "opencode"
  | "generic-openai-compat"
  | "unknown";


export interface ProbeResult {
  
  apiFormat: ApiFormat;
  
  auth: ProbeObservation["auth"];
  
  vendor: VendorKind;
  
  confidence: number;
  
  signals: string[];
  
  capabilities?: {
    visionField?: string;
    reasoningField?: string;
    contextField?: string;
    pricingField?: string;
  };
}


export function detectCapabilityFields(items: Array<Record<string, unknown>> | undefined): ProbeResult["capabilities"] | undefined {
  if (!items || items.length === 0) { return undefined; }
  const sample = items.slice(0, 5);
  const out: NonNullable<ProbeResult["capabilities"]> = {};
  for (const it of sample) {
    const rec = it as Record<string, unknown>;
    
    if (out.visionField === undefined &&
      (rec.vision === true || rec.supports_vision === true ||
        rec.multimodal === true ||
        (rec.architecture && typeof rec.architecture === "object" && (rec.architecture as any).modality === "image+text"))) {
      out.visionField = "vision";
    }
    
    if (out.reasoningField === undefined &&
      (rec.reasoning !== undefined || rec.supports_reasoning === true || rec.thinking === true ||
        (rec.supported_reasoning_efforts !== undefined))) {
      out.reasoningField = "reasoning";
    }
    
    if (out.contextField === undefined &&
      (typeof rec.context_length === "number" || typeof rec.context_window === "number" ||
        typeof rec.max_input_tokens === "number" || typeof rec.max_context_tokens === "number")) {
      out.contextField = "context_length";
    }
    
    if (out.pricingField === undefined &&
      (rec.pricing !== undefined || rec.cost !== undefined ||
        (rec.model_price !== undefined) || rec.price_in_usd !== undefined)) {
      out.pricingField = "pricing";
    }
  }
  const filled = Object.values(out).some(Boolean);
  return filled ? out : undefined;
}


export function identifyVendor(baseUrl: string, obs: ProbeObservation): { vendor: VendorKind; confidence: number; signals: string[] } {
  const url = (baseUrl ?? "").toLowerCase();
  const endpoint = (obs.endpoint ?? "").toLowerCase();
  const auth = obs.auth;
  const signals: string[] = [];

  
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

  
  let score = 0;
  
  if (endpoint.includes("/api/pricing") || endpoint.includes("/api/ratio_config")) {
    signals.push("端点 /api/pricing 或 /api/ratio_config");
    return { vendor: "newapi", confidence: 0.9, signals };
  }
  if (obs.hasPricing === true) {
    
    score += 0.4;
    signals.push("上游公开 pricing 元数据");
  }
  
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
  
  if ((obs.modelCount ?? 0) > 0) {
    score += 0.2;
    signals.push(`端点返回 ${obs.modelCount} 个模型`);
  }
  
  const vendor: VendorKind = (obs.vendor === "newapi" || obs.vendor === "openrouter")
    ? obs.vendor
    : "generic-openai-compat";
  const confidence = Math.min(1, score);
  if (confidence < 0.4 && obs.vendor === undefined) {
    
    return { vendor: "unknown", confidence: Math.max(0.1, confidence - 0.1), signals: [...signals, "证据不足，建议人工确认"] };
  }
  return { vendor, confidence, signals };
}


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
      return "openai"; 
  }
}


export function probe(obs: ProbeObservation, baseUrl: string): ProbeResult {
  const { vendor, confidence, signals } = identifyVendor(baseUrl, obs);
  const apiFormat = obs.auth === "x-api-key" ? "anthropic"
    : obs.auth === "x-goog-api-key" ? "google"
    : vendorToApiFormat(vendor);
  const caps = detectCapabilityFields(obs.modelItems);
  if (caps) { signals.push(`能力字段：${Object.values(caps).filter(Boolean).join(", ")}`); }
  return { apiFormat, auth: obs.auth, vendor, confidence, signals, capabilities: caps };
}
