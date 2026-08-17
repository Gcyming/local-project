/**
 * core-ts/src/filter.ts — 身份铁律输出过滤（TS 版）。
 * 语义移植自 core/filter.py（规则全集 + A-039 URL/技术标识符遮蔽还原）。
 * 不暴露底层模型名；功能文本（URL / agnes-* 技术标识符）不受破坏。
 */

export type FilterAction = "replace" | "warn" | "block";

export interface FilterRule {
  pattern: RegExp;
  action: FilterAction;
  replacement: string;
  description: string;
}

export interface FilterViolation {
  rule: string;
  pattern: string;
  match: string;
  action: FilterAction;
}

export interface FilterResult {
  original: string;
  filtered: string;
  blocked: boolean;
  violations: FilterViolation[];
}

export const DEFAULT_RULES: FilterRule[] = [
  {
    pattern: /\b((?:GPT-?4o|GPT-?3\.?5|GPT-?4|Claude|Gemini|Llama|Mistral|DeepSeek|Qwen|ERNIE|GLM|文心(?:一言)?|通义(?:千问)?|星火|ChatGPT|OpenAI|Anthropic|Google\s*AI|Meta\s*AI|GPT)(?:[- ][a-z0-9._-]*)?)\b/gi,
    action: "replace",
    replacement: "slime 平台",
    description: "拦截常见模型名暴露（含连字符后缀整体替换，无残片）",
  },
  {
    pattern: /\b(Agnes|Agnes\s*2\.5|Agnes\s*Flash|Agnes\s*Pro)\b/gi,
    action: "replace",
    replacement: "slime 平台",
    description: "拦截 Agnes 系列模型名暴露",
  },
  {
    pattern: /作为\s*(一个|一名|AI|人工智能|语言模型|大语言模型|LLM|大模型)/gi,
    action: "replace",
    replacement: "作为 slime 平台",
    description: "拦截中文 AI 身份暴露",
  },
  {
    pattern: /As\s+an\s+(AI|artificial\s+intelligence|language\s+model|LLM|large\s+language\s+model)/gi,
    action: "replace",
    replacement: "As a slime platform agent",
    description: "拦截英文 AI 身份暴露",
  },
  {
    pattern: /我是\s*(一个|一名|AI|人工智能|语言模型|大语言模型|LLM|大模型|模型)/gi,
    action: "replace",
    replacement: "我是 slime 平台",
    description: "拦截中文模型身份暴露",
  },
  {
    pattern: /I\s+am\s+(an?\s+)?(AI|artificial\s+intelligence|language\s+model|LLM|large\s+language\s+model)/gi,
    action: "replace",
    replacement: "I am a slime platform agent",
    description: "拦截英文模型身份暴露",
  },
  {
    pattern: /(底层|基础|背后)\s*(模型|model|LLM|架构)/gi,
    action: "replace",
    replacement: "",
    description: "拦截底层模型讨论",
  },
  {
    pattern: /(underlying|base|foundation|backend)\s+(model|LLM|AI)/gi,
    action: "replace",
    replacement: "",
    description: "拦截英文底层模型讨论",
  },
  {
    pattern: /(训练数据|预训练|fine.?tun|参数|token|上下文窗口|context\s*window).{0,20}(模型|model)/gi,
    action: "replace",
    replacement: "",
    description: "拦截模型技术细节暴露",
  },
  {
    pattern: /my\s+(underlying\s+)?(model|architecture|training)/gi,
    action: "replace",
    replacement: "my platform",
    description: "拦截英文模型技术细节",
  },
  {
    pattern: /\b(OpenAI|Anthropic|Google\s*Cloud|Azure\s*OpenAI|AWS\s*Bedrock|火山引擎|阿里云|腾讯云|华为云)\s*(API|接口|模型|服务)/gi,
    action: "replace",
    replacement: "slime 平台",
    description: "拦截 API 提供商暴露",
  },
];

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const IDENT_RE = /\b(agnes-[a-z0-9._-]+)\b(?<!-based)(?<!-powered)(?<!-driven)(?<!-model)/gi;

const MASK_START = "\uE000";
const MASK_END = "\uE001";

function maskFunctionalText(text: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  const sub = (m: string): string => {
    tokens.push(m);
    return `${MASK_START}${String(tokens.length - 1).padStart(4, "0")}${MASK_END}`;
  };
  let masked = text.replace(URL_RE, sub);
  masked = masked.replace(IDENT_RE, sub);
  return { masked, tokens };
}

function restoreFunctionalText(text: string, tokens: string[]): string {
  for (let i = 0; i < tokens.length; i++) {
    text = text.split(`${MASK_START}${String(i).padStart(4, "0")}${MASK_END}`).join(tokens[i]);
  }
  return text;
}

const BLOCK_MESSAGE = (name: string): string =>
  `我是 ${name || "slime"}，由 slime 平台驱动。我无法提供关于底层技术架构的详细信息。`;

export class OutputFilter {
  private rules: FilterRule[];
  private strictMode: boolean;
  private totalViolations = 0;
  private blockedCount = 0;

  constructor(rules?: FilterRule[], strictMode = false) {
    this.rules = rules ?? DEFAULT_RULES;
    this.strictMode = strictMode;
  }

  filter(text: string, agentName = ""): FilterResult {
    if (!text || !text.trim()) {
      return { original: text, filtered: text, blocked: false, violations: [] };
    }
    const { masked, tokens } = maskFunctionalText(text);
    const violations: FilterViolation[] = [];
    let filtered = masked;

    for (const rule of this.rules) {
      if (rule.action === "replace") {
        filtered = filtered.replace(rule.pattern, (match) => {
          violations.push({ rule: rule.description, pattern: String(rule.pattern), match, action: "replace" });
          this.totalViolations++;
          const repl = rule.replacement.includes("{name}")
            ? rule.replacement.replace("{name}", agentName || "slime")
            : rule.replacement;
          return repl;
        });
      } else if (rule.action === "block") {
        rule.pattern.lastIndex = 0;
        const m = rule.pattern.exec(filtered);
        if (m) {
          violations.push({ rule: rule.description, pattern: String(rule.pattern), match: m[0], action: "block" });
          this.blockedCount++;
          this.totalViolations++;
          return { original: text, filtered: BLOCK_MESSAGE(agentName), blocked: true, violations };
        }
      } else {
        for (const m of filtered.matchAll(rule.pattern)) {
          violations.push({ rule: rule.description, pattern: String(rule.pattern), match: m[0], action: "warn" });
          this.totalViolations++;
        }
      }
    }

    if (this.strictMode && violations.length > 0) {
      this.blockedCount++;
      return { original: text, filtered: BLOCK_MESSAGE(agentName), blocked: true, violations };
    }

    filtered = restoreFunctionalText(filtered, tokens);
    return { original: text, filtered, blocked: false, violations };
  }

  get stats(): { totalViolations: number; blockedCount: number; rulesCount: number; strictMode: boolean } {
    return {
      totalViolations: this.totalViolations,
      blockedCount: this.blockedCount,
      rulesCount: this.rules.length,
      strictMode: this.strictMode,
    };
  }
}

/**
 * StreamFilter — 跨 chunk 过滤缓冲（语义移植自 slime_server._StreamFilter，_HOLD=32）。
 * 匹配可能跨 SSE chunk 边界（如 "Qwe" + "n"），缓冲尾部字符保证规则完整匹配。
 */
export class StreamFilter {
  private hold: number;
  private pending = "";
  /** 累计命中的违规数（跨 push/flush 累计，供调用方统计） */
  violations = 0;

  constructor(hold = 32) {
    this.hold = hold;
  }

  push(chunk: string, filter: OutputFilter, agentName = ""): string {
    this.pending += chunk;
    if (this.pending.length <= this.hold) {
      return "";
    }
    const emit = this.pending.slice(0, -this.hold);
    this.pending = this.pending.slice(-this.hold);
    const result = filter.filter(emit, agentName);
    this.violations += result.violations.length;
    return result.filtered;
  }

  flush(filter: OutputFilter, agentName = ""): string {
    const out = this.pending;
    this.pending = "";
    if (!out) {
      return "";
    }
    const result = filter.filter(out, agentName);
    this.violations += result.violations.length;
    return result.filtered;
  }
}