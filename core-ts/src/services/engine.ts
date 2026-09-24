/**
 * core-ts/src/services/engine.ts — SlimeEngine：ChatEngine 真实现（5A.4 遗留接线点闭环）。
 * 语义对照 core/llm.py：
 * - model_choice 三选一：api:<key> → providers.enc.json 解密后按 key 取 {api_base, api_key, model}；
 *   local:<path> → ModelServerManager 的 chat 实例端口（registry state=ready，缺省 127.0.0.1:19100）；
 *   inherit → 沿 parent 链向上追溯 api:<key>（visited 防环，对照 _resolve_provider_key）。
 * - 无可用路由 → _default_reply 文案（如实告知未配置，不虚报）。
 * - A-090：replyRaw = 模型原文（过滤前），reply = 身份铁律过滤后展示文本。
 * - 工具：chat() 走 ToolLoop 非流式（单结果接口，正确）；stream() 走 ToolLoop.runStream 真流式
 *   工具循环（增量 tool_calls 累积 + liveQueue 轮询，思考/正文边到边实时）。
 */
import { ModelRouter, RouteEntry, type ClientFactory, type ApiFormat } from "../router.js";
import { ChatClient } from "../llm/client.js";
import { getSharedRpmLimiter } from "../llm/rpmLimiter.js";
import { ChatMessage, ChatRequest } from "shared/schemas";
import { inferModelCapabilities, resolveEffectivePricing, isAggregatorGateway } from "shared/model-capabilities";
import { getSharedCapabilityGraph } from "../probe-graph.js";
import { OutputFilter, StreamFilter } from "../filter.js";
import { ToolLoop, sandboxGateFrom, type AskUserHook } from "../tool_loop.js";
import { ToolRegistry, getRegistry } from "../tools/registry.js";
import { registerBuiltinTools } from "../tools/builtin.js";
import { SandboxManager } from "../sandbox.js";
// A-1061①：把未完成的计划在每轮开头复述回上下文（见 buildMessages 的注释）
import { readTodos, planReminderText } from "./todoStore.js";
// A-1061①：复述必须折进**最后一条 user 消息**（不许新增非首位 system —— 见该模块头注释）
import { foldUserReminder } from "../llm/userReminder.js";
// A-1061④：上游重试 / 切模型的瞬时通知（见 upstreamNotice.ts）
import { takeUpstreamNotice } from "../llm/upstreamNotice.js";
import { AgentRegistry, AgentState } from "./agents.js";
import {
  ChatEngine,
  ChatEngineCall,
  ChatEngineResult,
  EngineChunk,
  ContextBuckets,
} from "./chat.js";
import { IDENTITY_CONSTRAINT, HONESTY_PROTOCOL, InjectionHooks, NOOP_HOOKS } from "../session.js";
import { decrypt } from "../encryption.js";
import { getModelServer } from "../model_server.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import { loadSlimeMemories, type SilamAffectState, type SilamBrain, type SilamReplyResult } from "./silam_brain.js";
// S3：本地模型清单的键名与条目形状来自唯一来源（见 core-ts/src/local_models.ts）。
// 此前本文件自定义了一份 interface（实测已漂移：缺 `vision`）并硬编码键名 2 次 ——
// 键改名时这两处会静默失效，症状是"UI 里明明有这个模型，一发消息就报『未注册』"。
import { LOCAL_MODELS_KEY, findLocalModelSpec, type LocalModelSpec } from "../local_models.js";
import { appendUsage, computeRecordCost, defaultCacheReadInPrompt } from "./usage.js";
import { buildCompressSummaryPrompt, buildSummaryInput, estimateHistoryTokens, estimateTokensLocal, SUMMARIZE_INPUT_CAP } from "./context_compress.js";
// A-1084：引擎侧**保险门**（发送前判"装不装得下"）。它与主进程压缩编排共用同一函数
// （planEngineSend = planSend(canShrink:false) 的薄包装）⇒ 两处口径不可能漂移。
import { buildResumeBlock, parseComprehend, planEngineSend, LOCAL_PREFLIGHT_MARKER, type EngineSendGuard } from "./context_loop.js";

export interface ProviderConfig {
  api_base: string;
  api_key: string;
  model: string;
  /** API 端点格式（GUI 保存时写入；openai=/v1/chat/completions, anthropic=/v1/messages, auto=按 baseUrl 推断） */
  api_format?: ApiFormat;
  /** 供应商模型列表（GUI 保存时写入；engine 只读 id/selected/api_format 构建模型池降级链） */
  models?: Array<{ id?: unknown; selected?: unknown; api_format?: unknown; rpm?: unknown; [k: string]: unknown }>;
  /**
   * A-1092：供应商级**手填 RPM**（用户兜底）。探针实测与能力表声明都失效时，用户凭官方文档/
   * 合同/经验自己定一个额度。取值链：实测 > 手填（模型级 > 供应商级）> 能力表声明 > 未知。
   * ⚠️ 模型级的 `models[].rpm` 优先于本字段（与能力表「模型级 > 供应商级」同一口径）。
   */
  rpm?: number;
  [key: string]: unknown;
}

/** 模型池注入上限：同一供应商一次最多注入 N 个候选模型（防止 200 模型全量注入导致每次失败全池试一遍、整体超时爆炸） */
const MODEL_POOL_MAX = 8;

/** 本地模型条目的类型与键名来自唯一来源（S3）：
 *  见文件顶部 import 的 `../local_models.js` —— 这里不再自定义 interface，
 *  否则会与 providers.ts / shared/ipc.ts 各写一份并悄悄漂移（engine 那份实测缺 `vision`）。 */

export interface SlimeEngineOptions {
  registry: AgentRegistry;
  /** 解密后的 providers 表（缺省读 config/providers.enc.json；测试注入） */
  providers?: Record<string, ProviderConfig>;
  hooks?: InjectionHooks;
  tools?: ToolRegistry;
  sandbox?: SandboxManager;
  /** 路由客户端工厂（测试注入 fake fetch；缺省 ChatClient） */
  clientFactory?: ClientFactory;
  /** 无可用路由时的默认回复（缺省对齐 _default_reply 文案） */
  defaultReply?: (agent: AgentState) => string;
  logger?: Pick<Console, "warn" | "info" | "debug">;
  /** ask_user 工具钩子：模型向用户提问（方向分歧/关键决策）时调用（GUI 输入框选择题 UI）；缺省回退工具内置提示 */
  onAskUser?: AskUserHook;
  /** SILAM 绝对大脑兑底（A-121）：无可用路由时把对话兜给离线大脑；缺省 null 不兑底 */
  silamBrain?: SilamBrain | null;
  /** A-963 前向桥：slime 长期记忆装载器（缺省读 Knowledge/Agent Memory/<agent>；测试注入 fake） */
  silamMemoryLoader?: (agentId: string) => Promise<string[]>;
  /** A-963b 演化回灌：SILAM 成长态写盘根目录（缺省 PROJECT_ROOT；测试隔离注入 tmp） */
  silamPersistRoot?: string;
  /** A-965 core-ts↔server 通报钩子：SILAM 状态刷新后同步触发（GUI 注入实现：
   *  把 buildSilamTraitSignals 结果 POST 到 slime_server /agents/{id}/evolve 驱动人格演化）。
   *  fire-and-forget——实现方异常由调用方容错，绝不阻塞对话。 */
  onSilamEvolve?: (agentId: string, state: SilamAffectState) => void;
}

function defaultReplyText(agent: AgentState): string {
  return (
    `你好，我是 ${agent.name}，${agent.role}。\n\n` +
    `当前未配置 API Provider，请先通过 CLI 向导或 API 配置模型服务。\n` +
    `使用 \`py slime_cli.py wizard\` 或 \`POST /providers\` 添加 Provider。`
  );
}

/** 估计 token 数（对齐 Python _estimate_tokens 的量级语义：~0.6×字符数） */
export function estimateTokens(text: string): number {
  return Math.round(text.length * 0.6);
}

/** 单桶累加（对齐 estimateTokens 量级；ContextBuckets 类型在 chat.ts 契约层） */
function tok(text: string): number {
  return text ? estimateTokens(text) : 0;
}

/** 由已拆分好的来源文本计算分桶；missing/undefined 段按 0 计。返回新对象，不改入参。 */
export function computeContextBuckets(parts: Partial<Record<keyof ContextBuckets, string | null | undefined>>): ContextBuckets {
  return {
    system: tok(parts.system ?? ""),
    rules: tok(parts.rules ?? ""),
    memory: tok(parts.memory ?? ""),
    workspace: tok(parts.workspace ?? ""),
    planning: tok(parts.planning ?? ""),
    tools: tok(parts.tools ?? ""),
    history: tok(parts.history ?? ""),
    message: tok(parts.message ?? ""),
  };
}

/** 思考输出预算下限（A-925，对齐 Python A-091 教训）：思考模型（reasoning_effort 开启或
 *  reason/thinking/r1/qwen3/deepseek 系）的「思考 + 正文」共用同一 max_tokens 预算——
 *  Python 端早已修复（默认 2048 被思考预算截断，至少抬到 4096），core-ts 此前未同步，
 *  导致 GUI 主链路长思考后正文必然截断（用户实测：186s 长思考 + 正文总是无法完整输出）。
 *  此处思考模型一律抬到 ≥16384（A-980：8192 → 16384——R1/o 系长思考可达数万 token，
 *  8192 预算下思考占满后正文仍被截断，用户实测"模型长时间无输出后直接截断"；
 *  16384 覆盖「长思考 + 完整正文」，主流思考模型 max_tokens 均支持 ≥16384），
 *  非思考模型保持原样（undefined 走上游默认）。 */
function effectiveMaxTokens(agent: AgentState, requested?: number): number | undefined {
  const isThinking =
    !!(agent.reasoning_effort && agent.reasoning_effort !== "none") ||
    /reason|thinking|r1|qwen3|deepseek/i.test(`${agent.model_choice ?? ""}`);
  const model = `${agent.model_choice ?? ""}`.toLowerCase();
  // A-918++：Agnes 2.5 max_output 上限 65536（等于上限会被上游判 "exceeds the limit of 65536"），
  // 留 buffer 卡到 65000，避免 500；思考模型同时保证 ≥ 16384
  const cap = model.includes("agnes") ? 65000 : undefined;
  let value = requested;
  if (isThinking) { value = Math.max(requested ?? 0, 16384); }
  if (cap !== undefined && value !== undefined) { value = Math.min(value, cap); }
  return value;
}

/** 路由注入 model（请求未显式指定时；对齐 router.withModel 语义） */
function withModel(payload: ChatRequest, route: RouteEntry): ChatRequest {
  if (payload.model || !route.model) {
    return payload;
  }
  return { ...payload, model: route.model };
}

// ── 识图（对齐 core/llm.py _sanitize_image_data_url）──
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 单张 ≤ 8MB（base64 后约 10.7MB）
const MAX_IMAGES_PER_REQUEST = 4;          // 单请求 ≤ 4 张

/**
 * 模型 id 是否可用于**对话**（chat/completions）。
 *
 * 为什么需要：供应商的模型列表常混入图片/视频/语音/嵌入模型。例如 AGNES 返回 10 个模型，
 * 其中 `agnes-image-*` / `agnes-video-*` 共 5 个——把它们放进对话降级池后，一旦主模型限流，
 * 降级链会落到这些模型上并收到 `400 Model xxx is an image model. Use /v1/images/...`，
 * 表现为「模型突然不会调工具/胡言乱语」。这里按 id 特征剔除明显非对话的模型。
 *
 * 只在**自动组池**（供应商启用模型列表）时过滤；Agent 显式指定的模型不做过滤（尊重用户选择）。
 */
export function isChatCapableModel(id: string): boolean {
  const s = (id ?? "").toLowerCase();
  if (!s) { return false; }
  // 明确的非对话模态特征（词边界匹配，避免误伤 chat-vision 这类多模态对话模型）
  const NON_CHAT = /(^|[-_/])(image|img|video|tts|speech|audio|whisper|asr|voice|rerank(?:er)?|embed(?:ding)?|ocr|moderation|dall-e|dalle|stable-diffusion|flux|sora|midjourney|mj|bge|gte|m3e|e5|voyage)([-_/]|$)/;
  if (NON_CHAT.test(s)) { return false; }
  // 生成式媒体模型的常见命名（xxx-image-2.5 / xxx-video-2.5）
  if (/-(image|video|audio|tts|embedding)s?-\d/.test(s)) { return false; }
  return true;
}

/** 校验并过滤 images 入参：仅保留合法 data:image/* 前缀、大小在限内的条目（best-effort） */
export function sanitizeImages(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.startsWith("data:image/")) {
      continue;
    }
    const comma = item.indexOf(",");
    if (comma < 0) {
      continue;
    }
    const payload = item.slice(comma + 1);
    if (!payload) {
      continue;
    }
    const approxBytes = Math.floor((payload.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      continue;
    }
    out.push(item);
    if (out.length >= MAX_IMAGES_PER_REQUEST) {
      break;
    }
  }
  return out;
}

/** A-963b 演化回灌-持久化选项（测试可注入 root/now/阈值） */
export interface SilamPersistOptions {
  /** 记忆根目录（缺省 PROJECT_ROOT → Knowledge/Agent Memory/<agentId>/silam.json） */
  root?: string;
  /** fear/desire 显著变化阈值（缺省 0.2，低于则视为无明显情绪漂移） */
  minChange?: number;
  /** 最短写盘间隔 ms（缺省 5 分钟，防高频写盘） */
  minIntervalMs?: number;
  /** 当前时间戳（测试注入） */
  now?: number;
}

/** A-963b 演化回灌：把 SILAM 情感/成长态沉淀为 slime 长期记忆
 * （Knowledge/Agent Memory/<agentId>/silam.json，含 content 文本）。
 * 意义：① silam 的情绪/成长进入 slime Mind 数据层，知识/演化引擎可消费；
 * ② 前向桥（loadSlimeMemories）读知识漏斗时自然回读该快照 → SILAM 下次
 * 决策自启发，形成"情绪→记忆→决策"闭环。容错：任何异常返回 false，绝不抛错。
 * 节流：fear/desire 无显著变化且距上次写盘 <minIntervalMs 时跳过。
 * 注意：不用 statSync 等 node:fs 体积类命名导入（vitest 变换会树摇未显式调用者）。 */
export function persistSilamAffect(
  agentId: string,
  state: SilamAffectState,
  opts: SilamPersistOptions = {},
): boolean {
  try {
    const root = opts.root ?? PROJECT_ROOT;
    const dir = resolve(root, "Knowledge", "Agent Memory", agentId);
    const p = resolve(dir, "silam.json");
    const now = opts.now ?? Date.now();
    if (existsSync(p)) {
      try {
        const prev = JSON.parse(readFileSync(p, "utf8")) as {
          fear?: number; desire?: number; n_nodes?: number; step?: number; updated_at?: number;
        };
        const minChange = opts.minChange ?? 0.2;
        const changed =
          Math.abs((prev.fear ?? 0) - state.fear) >= minChange ||
          Math.abs((prev.desire ?? 0) - state.desire) >= minChange ||
          (prev.n_nodes ?? -1) !== state.n_nodes ||
          (prev.step ?? -1) !== state.step;
        const fresh = now - (prev.updated_at ?? 0) < (opts.minIntervalMs ?? 5 * 60 * 1000);
        if (fresh && !changed) {
          return false; // 无显著情绪漂移且未到节流周期 → 跳过
        }
      } catch {
        /* 既有文件损坏 → 覆盖重建 */
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(
        {
          fear: state.fear,
          desire: state.desire,
          n_nodes: state.n_nodes,
          step: state.step,
          lang_loaded: state.langLoaded,
          updated_at: now,
          content: `SILAM 成长快照：恐惧 ${state.fear.toFixed(2)}，渴望 ${state.desire.toFixed(2)}，成长树节点 ${state.n_nodes}，步数 ${state.step}。`,
        },
        null,
        2,
      ),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/** A-965 core-ts↔server 通报：把 SILAM 情绪/成长态转成可驱动人格演化的 trait 信号。
 *  规则确定性（非 LLM）：fear≥0.6×强化「谨慎」、fear≤0.2 弱化；desire≥0.6 强化「进取」、
 *  desire≤0.2 弱化。成长计数（n_nodes/step）不直接改 trait —— 由 persistSilamAffect
 *  沉淀的记忆兜底（前向桥回读）。返回空数组 = 无显著信号（调用方可不通报）。 */
export function buildSilamTraitSignals(state: SilamAffectState): Array<{ name: string; signal: number }> {
  const out: Array<{ name: string; signal: number }> = [];
  const { fear, desire } = state;
  if (fear >= 0.6) {
    out.push({ name: "谨慎", signal: 1 });
  } else if (fear <= 0.2) {
    out.push({ name: "谨慎", signal: -1 });
  }
  if (desire >= 0.6) {
    out.push({ name: "进取", signal: 1 });
  } else if (desire <= 0.2) {
    out.push({ name: "进取", signal: -1 });
  }
  return out;
}

export class SlimeEngine implements ChatEngine {
  private registry: AgentRegistry;
  private providers: Record<string, ProviderConfig>;
  private hooks: InjectionHooks;
  private tools: ToolRegistry;
  private sandbox: SandboxManager | null;
  private clientFactory: ClientFactory;
  private defaultReply: (agent: AgentState) => string;
  private logger: Pick<Console, "warn" | "info" | "debug">;
  private onAskUser: AskUserHook | undefined;
  private silamBrain: SilamBrain | null;
  /** A-963 前向桥：slime 长期记忆装载器（缺省读 Knowledge/Agent Memory/<agent>；测试可注入 fake） */
  private silamMemoryLoader: ((agentId: string) => Promise<string[]>) | undefined;
  /** A-963b 演化回灌：SILAM 成长态写盘根目录（缺省 PROJECT_ROOT；测试隔离注入 tmp） */
  private silamPersistRoot: string | undefined;
  /** A-965 core-ts↔server 通报钩子（GUI main 注入实现） */
  private onSilamEvolve: ((agentId: string, state: SilamAffectState) => void) | undefined;

  /** 已配置 Provider 数（Swarm 并发上限参考，对齐 Python max_workers 语义） */
  get providersCount(): number {
    return Object.keys(this.providers).length;
  }

  /** 已配置 Provider 的 key 列表（只读；GUI/测试排障用） */
  get providerKeys(): string[] {
    return Object.keys(this.providers);
  }

  /** 重载 providers（GUI 保存 Provider 后热更新，无需重启进程；测试可注入 projectRoot/passFile） */
  public refreshProviders(opts: { projectRoot?: string; passFile?: string } = {}): void {
    this.providers = (decrypt("config/providers.enc.json", { projectRoot: opts.projectRoot, passFile: opts.passFile }) ?? {}) as Record<string, ProviderConfig>;
  }

  /**
   * A-1092：把 providers 表里的**手填 RPM** 接到共享限流器上。
   *
   * 为什么住在 engine 而不是 GUI 主进程：**providers 表的解密读取唯一实现就在本类**
   * （`this.providers`，见构造函数与 `refreshProviders`）。让 GUI 再解一份密去喂限流器，
   * 就是"同一件事两个产地"——迟早漂移出"面板里显示 10、限流器读的是旧的 20"。
   *
   * 查表口径（必须与 `rateLimit.key` 一致，否则手填永不命中）：
   *   `rateLimit.key` = `providerKeyOfRoute(route)` = `route.baseUrl || route.name`。
   *   这里按**归一化后的 baseUrl** 反查 provider 记录 —— 归一化规则与 `resolveRouteInternal`
   *   里剥 `/v1` 的那一处**保持一致**（本函数内联复制该规则，改一处务必改两处，
   *   已有 `a1092-guards.spec.ts` 静态守卫锁住这两个字面量）。
   *
   * 值是 undefined / null / 非正数 ⇒ 解析为 null（= 没有手填），让链条继续落到声明值。
   */
  private bindManualRpm(): void {
    const norm = (u: string | undefined): string => {
      const s = (u ?? "").trim().replace(/\/+$/, "");
      return s.endsWith("/v1") ? s.slice(0, -3) : s;
    };
    /** baseUrl(归一) → { providerKey, manualByModel }（每次调用重建：providers 会热更新） */
    const byBase = new Map<string, { key: string; cfg: ProviderConfig }>();
    for (const [k, c] of Object.entries(this.providers)) {
      const b = norm(c?.api_base);
      if (b) { byBase.set(b, { key: k, cfg: c }); }
    }
    getSharedRpmLimiter().setManualRpmOf((key, model) => {
      const hit = byBase.get(norm(key));
      if (!hit) { return null; }
      // 模型级手填 > 供应商级手填（与能力表「模型级 > 供应商级」同一口径）
      const models = Array.isArray(hit.cfg.models) ? hit.cfg.models : [];
      const m = model ? models.find((x) => x && typeof x === "object" && (x as { id?: unknown }).id === model) : undefined;
      const fromModel = m && typeof m === "object" ? (m as { rpm?: unknown }).rpm : undefined;
      const fromVendor = (hit.cfg as { rpm?: unknown }).rpm;
      const raw = fromModel ?? fromVendor;
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    });
  }

  /** 工具注册表（SwarmExecutor 注入用） */
  get toolRegistry(): ToolRegistry {
    return this.tools;
  }

  /** 沙箱（未配置返回 null） */
  get sandboxManager(): SandboxManager | null {
    return this.sandbox;
  }

  constructor(opts: SlimeEngineOptions) {
    this.registry = opts.registry;
    this.providers = opts.providers ?? ((decrypt() ?? {}) as Record<string, ProviderConfig>);
    this.hooks = opts.hooks ?? NOOP_HOOKS;
    this.tools = opts.tools ?? getRegistry();
    this.sandbox = opts.sandbox ?? null;
    this.clientFactory =
      opts.clientFactory ?? ((route) => new ChatClient({ baseUrl: route.baseUrl, apiKey: route.apiKey, timeoutMs: route.timeoutMs }));    this.defaultReply = opts.defaultReply ?? defaultReplyText;
    this.logger = opts.logger ?? console;
    this.onAskUser = opts.onAskUser;
    this.silamBrain = opts.silamBrain ?? null;
    /** A-963 前向桥：注入的记忆装载器（测试可注入 fake；缺省引擎内 loadSlimeMemories） */
    this.silamMemoryLoader = opts.silamMemoryLoader;
    /** A-963b 演化回灌：SILAM 成长态写盘根目录（缺省 PROJECT_ROOT；测试隔离注入 tmp） */
    this.silamPersistRoot = opts.silamPersistRoot;
    /** A-965 core-ts↔server 通报钩子（GUI main 注入实现 → /agents/{id}/evolve） */
    this.onSilamEvolve = opts.onSilamEvolve;
    registerBuiltinTools(this.tools);
  }

  /** A-963 双向桥-后向缓存：agentId → SILAM 情感/成长态（reply/observe 后异步刷新，失败静默） */
  private readonly silamAffect = new Map<string, SilamAffectState>();

  /** 读取某 Agent 的 SILAM 情感/成长态（无缓存返回 undefined，不抛错） */
  getSilamAffect(agentId: string): SilamAffectState | undefined {
    return this.silamAffect.get(agentId);
  }

  /**
   * 使用统计记录（fire-and-forget）：把 done 事件的 token / 费用 / 时长追加到 config/usage.jsonl。
   * - 不阻塞主流程（catch 静默吞错误，避免 JSONL 写盘异常污染引擎调用栈）
   * - cost_usd 由 providers.enc.json 中对应 model 的 price_in_usd / price_out_usd / cache_* 推算
   * - provider_key 取 route.name split(":")[0]（nameKey 由 pushGroup 用 providers key 注入）
   *
   * ⚠️ 定价兜底（A-970 定价事故）：`reloadProviders` 是**直接解密 providers.enc.json**，
   * 拿到的是用户上次保存时的价格快照。老配置里躺着 `undefined`（尤其 deepseek-flash 这类
   * 价目表正则漏匹配的 ID）→ 每条记录都记 0，实测 1621 条记录 100% 成本为 0。
   * 因此取值一律走共享的 `resolveEffectivePricing`（存值缺价时回退内置家族价目表），
   * 让成本统计**不依赖**用户是否手动刷过供应商面板。
   *
   * 语义严格区分（**不可合并**）：`0` = 免费（官方限时免费 / 本地推理），是有效价，优先采用；
   * 只有"来源为 none"（未定价）才允许按 0 记账（并在面板上标出来让用户填）。
   *
   * ⚠️ 分时（峰谷）定价：单价随**请求时刻**变化（DeepSeek 等）。取值优先级为
   * **手填/上游结算价 > 本地端点 0 > 分时档 > 表平铺价 > 存值 > 未定价**（明细在共享函数里），
   * 并把命中的档位写进记录的 `price_tier`，供事后对账。
   */
  private recordUsage(opts: ChatEngineCall, route: RouteEntry | undefined, payload: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** A-971：prompt_tokens 是否已含 cache_read（上游归一化层给出的精确值；缺省按供应商家族推断） */
    cacheReadInPrompt?: boolean;
    elapsedMs: number;
    success: boolean;
    error?: string;
  }): void {
    const modelId = route?.model;
    // 跳过离线大脑（SILAM/silam-brain）、无模型路径、"none" 占位
    if (!modelId || modelId === "none" || modelId === "silam" || modelId === "silam-brain") { return; }
    const providerKey = route?.name?.split(":")[0] ?? "unknown";
    const cfg = this.providers[providerKey];
    const rawSpec = cfg?.models?.find((m) => m?.id === modelId);
    const spec = rawSpec as {
      price_in_usd?: number; price_out_usd?: number;
      price_cache_read_usd?: number; price_cache_write_usd?: number;
      price_source?: string;
      /**
       * A-988c：用户自定义的分时档**必须在这里透传**。
       *
       * 漏了它会出现最恶劣的一类分裂：供应商面板（读的是 ModelSpec 全量字段）显示
       * 「自定义分时」，而这里因为看不到 `price_tiers` 而按平铺价记账 ——
       * 用户按界面上的峰谷价核对账单，怎么都对不上，且没有任何报错。
       * 结构类型断言不会报错（少写一个字段编译器不管），所以改 ModelSpec 时
       * 必须回来同步这一处 —— 与 `windowCap` 那条"每一条 done 载荷都要带"是同一类教训。
       */
      price_tiers?: import("shared/model-capabilities").ModelPriceTiers;
    } | undefined;
    // 请求时刻：既是记录的 `ts`，也是分时定价的取档依据。
    // **两者必须是同一个值**，否则会写出"记录落在高峰、成本却按空闲价算"的自相矛盾数据。
    const at = new Date();
    const ts = at.toISOString();
    // 生效价：走**全平台唯一入口** `resolveEffectivePricing`，与供应商面板、历史回填共用
    // 同一套优先级 —— 三处各写一遍已经分裂出真实事故（面板显示「未定价」而这里按 0.3 计费；
    // 本地端点存值缺价时仍套官方刊例价 → 跑本地模型凭空产生账单）。改优先级只需改那一个函数。
    //
    // 优先级（详见 shared/gen/model-capabilities.ts `resolveEffectivePricing` 的注释）：
    //   **自定义分时档 > 手填 / 上游结算价 > 本地端点 0 > 内置分时档 > 表平铺价 > 存值 > 未定价**
    //   - **自定义分时最先**：用户填了一整张时段表，意图比"填一个数"更强（A-988c）。
    //   - **手填 / 上游次之**：用户填的可能是议价/合同价，网关回传的是本网关真实结算价，
    //     机器不该覆盖（想让内置分时接管 → 清空面板里的单价输入框即可）。
    //   - **本地端点恒 0**：本地常二次托管"有官方价"的模型 ID（llama.cpp 跑 deepseek-flash），
    //     官方价与它毫无关系；面板对这类端点写的也是 0，两处必须给同一个答案（共用 isLocalEndpoint）。
    //   - **分时规格 / 表压过存值**：存值是机器从**同一张表**平铺写下的快照（如 deepseek 的高峰
    //     标准价），让它赢就等于把时段信息吞掉、整套分时定价形同虚设 —— 与 context_window 的
    //     "错值自杀锁"同款教训：人工核对的表必须压过历史落库值。
    //     （`price_source: undefined` 的存值属"历史残留值"，按既有优先级本就垫底于内置表。）
    const eff = resolveEffectivePricing(modelId, route?.baseUrl ?? "", spec, at);
    const priceIn = eff.priceIn;
    const priceOut = eff.priceOut;
    const priceCacheRead = eff.priceCacheRead;
    const priceCacheWrite = eff.priceCacheWrite;
    // A-971：prompt_tokens 含不含缓存命中，决定命中部分是否要从输入里剔除 —— 传错会重复计费
    const cacheReadInPrompt = payload.cacheReadInPrompt
      ?? defaultCacheReadInPrompt(providerKey, modelId);
    const cost = computeRecordCost(
      payload.promptTokens, payload.completionTokens, payload.reasoningTokens,
      payload.cacheReadTokens, payload.cacheCreationTokens,
      priceIn, priceOut, priceCacheRead, priceCacheWrite,
      cacheReadInPrompt,
    );
    void appendUsage({
      ts,
      agent_id: opts.agent.id,
      session_id: opts.sessionId ?? "default",
      model: modelId,
      provider_key: providerKey,
      prompt_tokens: payload.promptTokens,
      completion_tokens: payload.completionTokens,
      reasoning_tokens: payload.reasoningTokens,
      cache_read_tokens: payload.cacheReadTokens,
      cache_creation_tokens: payload.cacheCreationTokens,
      cache_read_in_prompt: cacheReadInPrompt,
      // 命中的分时档位（无分时规格 / 走了手填价或本地端点 → 不写，JSON.stringify 会自动省略 undefined）
      price_tier: eff.tiered ? eff.tierId : undefined,
      elapsed_ms: payload.elapsedMs,
      cost_usd: cost,
      success: payload.success,
      error: payload.error,
    }).catch(() => { /* fire-and-forget: JSONL 异常不污染主流程 */ });
  }

  /** 拉取 sidecar 最新状态并缓存（容错；不阻塞主流程） */
  private async refreshSilamAffect(agentId: string): Promise<void> {
    try {
      const st = await this.silamBrain?.getState?.();
      if (st) {
        this.silamAffect.set(agentId, st);
        // A-963b 演化回灌：成长态沉淀到 slime 长期记忆（前向桥自动回读 → 自闭环）
        persistSilamAffect(agentId, st, this.silamPersistRoot ? { root: this.silamPersistRoot } : {});
        // A-965 core-ts↔server 通报：hook 同步触发（GUI 注入实现 → /agents/{id}/evolve）
        try {
          this.onSilamEvolve?.(agentId, st);
        } catch {
          /* 通报失败静默：不影响对话 */
        }
      }
    } catch {
      /* 状态刷新失败不中断对话 */
    }
  }

  /** A-1018：**兜底必须报因**。
   *
   *  此前 SILAM 兜底成功时把 `resolveRouteInternal` 的失败原因直接丢掉，用户只看到一条"正常回复"，
   *  完全不知道选中的模型（如 `local:qwen3`）根本没跑起来 —— 实测症状就是用户拿着截图来问
   *  "为什么用不了选中的本地模型？"（而真正原因 `--reasoning-format qwen` 非法 / 模型文件损坏
   *  已经躺在 `error` 里被扔了）。静默兜底 = 精度杀手。
   *  现在把原因并进**思考段**（界面就在那儿展示"（离线应答 · SILAM 大脑）"，用户不用展开新区域）。 */
  private fallbackNotice(agent: AgentState, error: string | null): string {
    return `⚠️ 选中的模型「${agent.model_choice || "(空)"}」不可用，本轮由 SILAM 离线大脑兜底应答。\n原因：${error ?? "无可用路由"}`;
  }

  /** SILAM 绝对大脑兑底（A-121/A-124）：调用方注入的离线大脑无可用时返回 null，
   *  不虚构；成功时返回 {reply(正文), reasoning(思考)} 供上层分离展示。 */
  private async silamReply(opts: ChatEngineCall): Promise<SilamReplyResult | null> {
    if (!this.silamBrain?.enabled) {
      return null;
    }
    const history = (opts.history ?? [])
      .slice(-8)
      .map((m) => ({
        role: String(m.role ?? ""),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      }));
    let slimeMemory: string[] | undefined;
    try {
      // A-963 前向桥：优先用注入的装载器（测试可注入 fake），缺省读 Knowledge/Agent Memory/<agent>
      const mem = this.silamMemoryLoader
        ? await this.silamMemoryLoader(opts.agent.id)
        : await loadSlimeMemories(opts.agent.id, 6);
      if (mem.length > 0) {
        slimeMemory = mem;
      }
    } catch {
      /* 记忆加载失败静默：无记忆注入 */
    }
    try {
      const result = await this.silamBrain.reply({
        agentName: opts.agent.name,
        agentRole: opts.agent.role,
        userMessage: opts.message,
        history,
        slimeMemory,
      });
      // A-963 后向桥：异步刷新该 Agent 的情感觉/成长态（不阻塞返回）
      void this.refreshSilamAffect(opts.agent.id);
      return result;
    } catch (e) {
      this.logger.warn(`[engine] SILAM 大脑兑底异常（降级默认提示）: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** 显式选择 SILAM 大脑（对齐 core/llm.py：model_choice == "silam" 或 "silam:<任意描述>"） */
  private wantsSilam(agent: AgentState): boolean {
    return agent.model_choice === "silam" || agent.model_choice.startsWith("silam:");
  }

  /** SILAM 大脑不可用时的明确提示（显式选择场景，不虚构应答） */
  private silamUnavailableText(agent: AgentState): string {
    return (
      `你好，我是 ${agent.name}，${agent.role}。\n\n` +
      `已选择 SILAM 离线大脑，但它当前不可用。请检查：\n` +
      `- slime.toml [silam] 需 enabled=true 且 as_brain=true\n` +
      `- 兑底 sidecar 是否存在（sidecar/silam_brain_sidecar.py，自动发现情感脑 80M 与语言脑 d16）`
    );
  }

  /** A-122 观战式观摩学习：辅导员（API/llama）的一次成功示范 → SILAM 沉淀。
   *  语义对齐 Python 端 core/llm.py `_observe_tutor_demo`：文本进记忆环、
   *  向量进树突（sidecar 内相似去重）。fire-and-forget——绝不阻塞对话，
   *  调用方必须位于「非 SILAM」的辅导员成功路径上。 */
  private observeTutorDemo(opts: ChatEngineCall, reply: string): void {
    try {
      if (reply && reply.trim()) {
        this.silamBrain?.observe?.(opts.message, reply);
      }
    } catch (e) {
      this.logger.warn(
        `[engine] 观战辅导员示范失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** inherit 沿 parent 链向上追溯 api:<key>（visited 防环；对照 _resolve_provider_key） */
  public async resolveProviderKey(agent: AgentState): Promise<string | null> {
    let current = agent;
    const visited = new Set<string>([agent.id]);
    while (current) {
      if (current.model_choice.startsWith("api:")) {
        // 支持 api:<key> 与 api:<key>:<model> 两种形态，只取 provider 名
        const rest = current.model_choice.slice(4);
        const sep = rest.indexOf(":");
        return sep >= 0 ? rest.slice(0, sep) : rest;
      }
      if (current.parent_id && !visited.has(current.parent_id)) {
        visited.add(current.parent_id);
        const parent = await this.registry.findAgent(current.parent_id);
        if (!parent) {
          break;
        }
        current = parent;
      } else {
        break;
      }
    }
    return null;
  }

  /** 按 id 查找本地模型注册条目（providers 表内含清单键；未注册 → undefined）。
   *  S3：解析逻辑收口到 `findLocalModelSpec`（唯一实现），此处不再自己摸私有键。 */
  private findLocalModel(id: string): LocalModelSpec | undefined {
    return findLocalModelSpec(this.providers as unknown as Record<string, unknown>, id);
  }

  /** local:<id> → 确保对应模型的 llama-server 已就绪并返回其端口；失败返回 {ok:false,error}（具体原因透给用户，不塌缩为"未配置 API"） */
  private async ensureLocalModel(id: string, signal?: AbortSignal): Promise<
    { ok: true; port: number; state: string } | { ok: false; error: string }
  > {
    const spec = this.findLocalModel(id);
    if (!spec) {
      return { ok: false, error: `本地模型「${id}」未注册。请在 设置 → 模型供应商 → 本地模型 中添加一个有效的 .gguf 模型。` };
    }
    if (!spec.path || !existsSync(spec.path)) {
      return { ok: false, error: `本地模型「${id}」的模型文件不存在（${spec.path ?? "路径为空"}）。请重新添加该模型或检查文件是否被移动/删除。` };
    }
    const mgr = getModelServer();
    if (!mgr) {
      return { ok: false, error: `本地模型启动器（llama-server）未初始化。请在 设置 → 心智中枢 → 依赖 中配置并定位 llama-server.exe。` };
    }
    const result = await mgr.ensure("chat", spec.path, id, {
      gpuLayers: spec.gpu_layers,
      ctxLen: spec.ctx_len,
      signal,
    });
    if (!result.ok || !result.port) {
      return { ok: false, error: `本地模型「${id}」加载失败：${result.error ?? "未知原因（llama-server 未在超时内就绪）"}。若为新下载的模型，请确认 .gguf 文件完整未损坏。` };
    }
    return { ok: true, port: result.port, state: result.state ?? "ready" };
  }

  /** 组装 ModelRouter：api:key → 云端多供应商降级链；local → 本地路由（失败透出具体原因）；inherit → 沿父链追溯。 */
  private async resolveRouteInternal(agent: AgentState, signal?: AbortSignal): Promise<{ router: ModelRouter | null; error: string | null }> {
    const header = `你好，我是 ${agent.name}，${agent.role}。\n\n`;

    // A-1092：把**用户手填的 RPM** 注入共享限流器（探针与本地表全失效时的最后兜底）。
    // 放在这里（所有路由分支的**唯一入口**）而不是各分支里：任何一条路径（云 / 本地 / inherit）
    // 漏绑一次，那条路径上的手填值就静默失效 —— 而症状只是"我明明填了怎么还被限流"。
    // 取值链：实测 > 手填 > 能力表声明 > 未知。手填优先于声明（用户比内置表更懂自己的档位）。
    // resolver 按「baseUrl + 模型」查，与 rateLimit.key（= providerKeyOfRoute = baseUrl）同源。
    this.bindManualRpm();

    if (agent.model_choice.startsWith("api:")) {
      // 支持两种形态：api:<key>（用供应商默认模型）/ api:<key>:<model>（精确指定模型）
      const rest = agent.model_choice.slice(4);
      const sep = rest.indexOf(":");
      const key = sep >= 0 ? rest.slice(0, sep) : rest;
      const explicitModel = sep >= 0 ? rest.slice(sep + 1).trim() : "";
      const cfg = this.providers[key];
      if (!cfg) {
        return { router: null, error: `${header}未找到已配置的 Provider「${key}」。请到 设置 → 模型供应商 添加/核对该 API（Agent 的模型字段须为 api:<与配置一致的名称>）。` };
      }

      // ── 跨供应商全局降级池（A-158）——「用不了」真根因修复：
      // 上一版（A-157）只把「同一供应商」的启用模型注入降级链。但免费池/网关会整体限流
      // （opencode-zen 免费池实测全 429/超时），同池换模型仍是同一上游 → 依然失败。
      // 正确做法 = 行业成熟客户端（Cherry Studio/Chatbox）逻辑：首选供应商全挂 →
      // 自动转移到「其他已配置供应商」的启用模型（如 agnes 实测完全可用）。
      // 路由排序：首选供应商显式/默认模型优先 → 首选供应商其余启用模型 → 其他供应商模型。
      const base = (cfg.api_base ?? "").replace(/\/+$/, "");
      // ⚠️ A-1008：这里只剥 `/v1`，**故意不同步**到 joinApiEndpoint —— 别"顺手统一"。
      // 本行做的是「剥版本段」，与「拼端点」是两种操作。若照抄通配规则把**厂商自带**的
      // 版本段（智谱 `…/api/paas/v4`）也剥掉，下游 joinApiEndpoint 就看不到版本段 →
      // 补回 `/v1` → `/api/paas/v1/chat/completions` → **404 回归**（就是本次要修的那个病）。
      // 端点拼接的唯一实现在 `core-ts/src/llm/client.ts` 的 joinApiEndpoint（幂等 + 版本段通配）。
      const primaryBase = base.endsWith("/v1") ? base.slice(0, -3) : base;

      const enabledOf = (c: ProviderConfig): string[] => {
        const out: string[] = [];
        const raw = Array.isArray(c.models) ? c.models : [];
        for (const m of raw) {
          const id = m?.id;
          if (typeof id === "string" && id && m.selected !== false && isChatCapableModel(id)) out.push(id);
        }
        return out;
      };

      const primaryEnabled = enabledOf(cfg);
      const primaryModel = explicitModel || cfg.model || primaryEnabled[0] || undefined;

      const router = new ModelRouter(undefined, this.clientFactory);
      // 按「本条路由实际使用的模型」重算思考参数——降级换模型后思考开关仍与模型协议一致
      // （关键：工具循环路径此前完全不带思考参数，agnes 因此永远拿不到 reasoning_content）
      router.setReasoningParamsResolver((modelId, kind, baseUrl) =>
        this.reasoningParamsForModel(modelId, kind, agent.reasoning_effort, baseUrl));
      // 探针层第 2/3 层收口：降级链前置剔除「实时探测已判定模型级失效」的模型（404/下线/区域），
      // 经共享能力图谱查 liveDead（内部委托共享 LiveProbeCache——网关探明的失效模型，引擎直接跳过）。
      router.setDeadModelCheck((providerKey, modelId) => getSharedCapabilityGraph().liveDead(providerKey, modelId));
      let order: string[] = [];

      /** 注入一组路由，返回实际候选数；bias：优先级偏移（越大越靠前） */
      /** 从 provider 的 models 列表提取 per-model 端点格式覆盖（聚合网关多端点用） */
      const modelFormatsOf = (c: ProviderConfig): Map<string, ApiFormat> | undefined => {
        const arr = c.models;
        if (!Array.isArray(arr)) { return undefined; }
        const m = new Map<string, ApiFormat>();
        for (const entry of arr) {
          if (!entry || typeof entry !== "object") { continue; }
          const id = typeof entry.id === "string" ? entry.id : undefined;
          const f = entry.api_format;
          if (id && (f === "openai" || f === "anthropic" || f === "auto")) { m.set(id, f as ApiFormat); }
        }
        return m.size > 0 ? m : undefined;
      };
      const pushGroup = (baseUrl: string, apiKey: string | undefined, models: Array<string | undefined>, nameKey: string, bias: number, apiFormat?: ApiFormat, modelFormats?: Map<string, ApiFormat>): void => {
        const list = models.length > 0 ? models : [undefined]; // 无模型列表也允许单路由（上游任模型）
        list.forEach((model, i) => {
          // 端点格式：per-model 覆盖 > 供应商级 > undefined（createClient 按 baseUrl 推断）
          const fmt: ApiFormat | undefined = model ? (modelFormats?.get(model) ?? apiFormat) : apiFormat;
          router.add({
            name: model ? `${nameKey}:${model}` : nameKey,
            baseUrl,
            apiKey,
            model,
            kind: "cloud",
            priority: bias - i,
            roles: ["chat", "embedding"],
            api_format: fmt,
          });
        });
      };

      // ① 首选供应商：显式/默认 + 其余启用（同一 baseUrl 多模型）
      order = [...new Set([primaryModel, ...primaryEnabled].filter((x): x is string => typeof x === "string" && Boolean(x)))].slice(0, MODEL_POOL_MAX);
      pushGroup(primaryBase, cfg.api_key || undefined, order, key, 1000, cfg.api_format, modelFormatsOf(cfg));

      // ② 跨供应商后备：其余已配置 provider 的启用模型（按 provider 键名稳定排序，避免顺序抖动）
      const others = Object.entries(this.providers)
        .filter(([k, p]) => k !== key && k !== LOCAL_MODELS_KEY && !p?.api_base?.startsWith("http://127.0.0.1") && !p?.api_base?.startsWith("http://localhost"))
        .sort(([a], [b]) => a.localeCompare(b));
      let bias = 900;
      for (const [otherKey, otherCfg] of others) {
        const oBase = (otherCfg.api_base ?? "").trim().replace(/\/+$/, "");
        if (!oBase || !/^https?:\/\//i.test(oBase)) { continue; }
        // ⚠️ A-1008：同上面首选供应商那处 —— 只剥 `/v1`，**不要**扩成版本段通配（会把智谱
        // `/api/paas/v4` 剥掉 → 下游补 `/v1` → 404 回归）。拼接唯一实现在 joinApiEndpoint。
        const ob = oBase.endsWith("/v1") ? oBase.slice(0, -3) : oBase;
        const oModels = enabledOf(otherCfg);
        if (oModels.length === 0) {
          // 无模型列表也注入单路由（上游可用则救场）
          pushGroup(ob, otherCfg.api_key || undefined, [undefined], otherKey, bias, otherCfg.api_format);
          bias -= 1;
          continue;
        }
        const cap = oModels.slice(0, MODEL_POOL_MAX / 2); // 跨供应商候选收敛，避免总候选爆炸
        pushGroup(ob, otherCfg.api_key || undefined, cap, otherKey, bias, otherCfg.api_format, modelFormatsOf(otherCfg));
        bias -= cap.length;
      }

      if (router.list().length === 0) {
        return { router: null, error: `${header}Provider「${key}」没有可用的模型（未配置模型列表或全部未启用）。请到 设置 → 模型供应商 编辑启用至少一个模型。` };
      }
      this.logger.info?.(
        `[engine] 注入全局降级池（${router.list().length} 个候选）：${router.list().slice(0, 12).map((r) => r.name).join(" → ")}${router.list().length > 12 ? " …" : ""}`,
      );
      if (!cfg.api_key) {
        this.logger.warn(`[engine] Provider「${key}」未配置 API Key，上游可能返回 401（模型 ${primaryModel ?? "默认"}）。`);
      }
      return { router, error: null };
    }

    if (agent.model_choice.startsWith("local:")) {
      const id = agent.model_choice.slice("local:".length).trim();
      const local = await this.ensureLocalModel(id, signal);
      if (!local.ok) {
        return { router: null, error: header + local.error };
      }
      const router = new ModelRouter(undefined, this.clientFactory);
      // 按「本条路由实际使用的模型」重算思考参数——降级换模型后思考开关仍与模型协议一致
      // （关键：工具循环路径此前完全不带思考参数，agnes 因此永远拿不到 reasoning_content）
      router.setReasoningParamsResolver((modelId, kind, baseUrl) =>
        this.reasoningParamsForModel(modelId, kind, agent.reasoning_effort, baseUrl));
      // 探针层第 2/3 层收口：降级链前置剔除「实时探测已判定模型级失效」的模型（404/下线/区域），
      // 经共享能力图谱查 liveDead（内部委托共享 LiveProbeCache——网关探明的失效模型，引擎直接跳过）。
      router.setDeadModelCheck((providerKey, modelId) => getSharedCapabilityGraph().liveDead(providerKey, modelId));
      router.add({
        name: id,
        baseUrl: `http://127.0.0.1:${local.port}`,
        kind: "local",
        priority: 100,
        roles: ["chat", "embedding"],
      });
      return { router, error: null };
    }

    if (agent.model_choice === "inherit") {
      const key = await this.resolveProviderKey(agent);
      if (key) {
        const inherit = { ...agent, model_choice: `api:${key}` };
        return this.resolveRouteInternal(inherit, signal);
      }
      return { router: null, error: `${header}「${agent.name}」当前采用「继承」模型，但其父链上未配置任何 API Provider（` + "`py slime_cli.py wizard` 或 `POST /providers` 可添加）。" };
    }

    return { router: null, error: `${header}未知的模型选择：「${agent.model_choice}」。请在设置中为该 Agent 显式选择 API 或本地模型。` };
  }

  /** 兼容形式：仅返回路由或 null（swarm / 测试使用，不区分失败原因）；详细原因走 resolveRouteInternal */
  public async routerFor(agent: AgentState): Promise<ModelRouter | null> {
    return (await this.resolveRouteInternal(agent)).router;
  }

  /** 组装 system prompt：身份铁律区 + 诚实协议 + 人格段（custom 覆盖 identity_prompt）+ 心智/检索注入段 */
  async buildSystem(agent: AgentState, customSystemPrompt?: string, workspaceOverride?: string): Promise<string> {
    const parts: string[] = [
      IDENTITY_CONSTRAINT(agent.name, agent.role),
      HONESTY_PROTOCOL,
      (customSystemPrompt?.trim() ? customSystemPrompt : agent.identity_prompt).trim() ||
        `你是 ${agent.name}，你的角色是：${agent.role}。`,
    ];
    // 思考格式约束：要求模型把内部思考放进 <thinking> 标签，标签外才是最终回答。
    // 配合 server 层 --reasoning-format（qwen/deepseek）或云端 return_reasoning 提取到
    // reasoning_content（协议层分离），避免思考裸写进正文（Qwen3 等思考模型已知泄漏路径）。
    const effort = agent.reasoning_effort;
    if (effort && effort !== "none") {
      parts.push(
        "输出规范（必须严格遵守）：如果需要进行内部思考/推理，请把全部思考过程完整放在 " +
          "`<thinking>...</thinking>` 标签内，标签之外的内容才是最终回答。思考标签内的内容不会展示给用户。" +
          "严禁把思考过程直接写进正文——正文中不得出现「用户说…」「我需要…」「我应该…」「根据我的角色设定…」" +
          "等思考性文字。直接输出最终回答。",
      );
    }
    parts.push(...this.hooks.fixedSegments(agent));
    parts.push(...(await this.hooks.retrieveSegments(agent.id, "用户最近的需求")));
    // A-162 / A-980-R27：自主规划引导（对齐 Claude Code TodoWrite、OpenAI Codex update_plan、
    // LangChain write_todos 与 Manus todo.md 的共识）。原提示词只有一句"复杂任务先拆解"，
    // 触发条件与状态纪律都不明确 → 模型随缘调用、随缘更新。这里把四条硬规则写死：
    // 何时规划 / 单一进行中 / 完成即刻标记 / 不删完成项（复述锚定）。
    parts.push(
      "任务执行规范（务必遵守）：\n" +
        "1) **何时规划**：当任务需要 3 步以上、涉及多个文件、或需要多轮工具协作时，" +
        "**动手前先调用一次 `todo_write`**，把任务拆成 3-6 个明确阶段（祈使句、可验证），全部先标 pending。" +
        "单步任务（一句话问答、单次查询、只改一个已知位置）不要规划，直接做。\n" +
        "2) **单一进行中**：任何时刻**最多一项** in_progress。开始某个阶段前把它置为 in_progress，" +
        "不要一次把好几项都置为 in_progress。\n" +
        "3) **完成即刻标记**：一个阶段真正做完（已改完、已验证）就**立刻**再调一次 `todo_write` " +
        "把该项改成 completed、并把下一项改成 in_progress；**不要攒着一起改**，" +
        "也不要在没做完、报错未解决、验证没过时谎报 completed。\n" +
        "4) **已完成项留在列表里**：不要删掉，保留才能体现进度（用户正是靠这张表看你还剩多少）。" +
        "计划整体改版时才用 action=replace 重写。\n" +
        "分阶段执行能显著提高结果的可靠性与可追踪性，也让用户随时看得见进度。",
    );
    // 工作目录注入：会话级 workspace 优先，回退 Agent sandbox_override（旧模型）；让 Agent 感知其被指定的工作区，文件工具据此访问
    const ws = workspaceOverride ?? (agent.sandbox_override && typeof agent.sandbox_override === "object" ? String(agent.sandbox_override.workspace ?? "") : "");
    if (ws) {
      let inventory = "";
      try {
        const listing = await this.tools.callTool("file_list", { path: ".", _workspace: ws });
        if (listing && !listing.startsWith("[错误]") && listing !== "[空目录]") {
          const lines = listing.split("\n");
          inventory = lines.length > 80 ? `${lines.slice(0, 80).join("\n")}\n…（共 ${lines.length} 项）` : listing;
        } else if (listing !== "[空目录]") {
          inventory = `（目录清单获取失败：${listing}）`;
        }
      } catch {
        inventory = "（目录清单获取失败）";
      }
      parts.push(
        `📦 你的工作目录（workspace）已设置为：\`${ws}\`\n` +
          `以下是该目录当前的内容清单（预加载，无需再调用 file_list 即可了解概貌）：\n${inventory || "（空目录）"}\n` +
          `所有文件操作（file_list/file_read/file_write/code_check）默认以该目录为工作区，文件路径可使用该目录内的相对路径或绝对路径。\n` +
          `如需深入查看子目录/文件内容，请调用 file_list/file_read 继续探查。`,
      );
    }
    return parts.join("\n\n");
  }

  /** A-980-R22：工具目录列举（ChatEngine 可选契约，ChatService 据此生成 Agent 白名单 toolsOnly） */
  listTools(): Array<{ function?: { name?: string } }> {
    return this.tools.listTools() as Array<{ function?: { name?: string } }>;
  }

  /** 工具 schema（toolsOnly 过滤；显式 [] 或过滤后为空 → undefined 不注入） */
  private toolSchemas(toolsOnly?: string[]): ChatRequest["tools"] {
    // 未传 toolsOnly → 全部已注册工具；显式传（含空数组）→ 按名过滤
    const names = toolsOnly === undefined
      ? this.tools.listToolNames()
      : toolsOnly.filter((n) => this.tools.listToolNames().includes(n));
    if (names.length === 0) {
      return undefined;
    }
    return this.tools.listTools().filter((t) =>
      (t as { function?: { name?: string } }).function?.name &&
      names.includes((t as { function: { name: string } }).function.name),
    ) as ChatRequest["tools"];
  }

  private buildMessages(call: ChatEngineCall, system: string): ChatMessage[] {
    const images = sanitizeImages(call.images);
    /* A-1061①：每轮开头复述**未完成的计划**（Manus「目标复述 / recitation」，与 Claude Code 的
       system-reminder 注入同意图）。这是"中断后不接续"的结构性修法 —— 详见
       `todoStore.planReminderText` 的注释。无待办 / 全部完成 → 返回 null → **零行为变化**。 */
    const reminder = planReminderText(call.sessionId ? readTodos(call.sessionId) : []);
    let out: ChatMessage[];
    if (images.length === 0) {
      // 无图：保持纯字符串（全部旧路径行为不变，零回归）
      out = [
        { role: "system", content: system },
        ...call.history,
        { role: "user", content: call.message },
      ];
    } else {
      // 有图：OpenAI 兼容 content-blocks 数组（心性注入已并入 call.message）
      const blocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: "text", text: call.message },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ];
      const userMsg = { role: "user", content: blocks } as unknown as ChatMessage;
      out = [
        { role: "system", content: system },
        ...call.history,
        userMsg,
      ];
    }
    // 放在**最后**：靠 recency 让目标回到高注意力区（放最前等于沉进中段，复述就白做了）。
    // ⚠️ 但**不能**用 `out.push({ role: "system", ... })` —— 那会产生"非首位的 system"：
    //    OpenAI 兼容上游（agnes）多半直接 400；Anthropic 路径会把它静默改写成 assistant
    //    （提醒变成"模型自己说过的话"）。折进**最后一条 user 消息**（Claude Code 的
    //    system-reminder 形态）既保住 recency 又保持角色合法 —— 详见 userReminder.ts。
    if (reminder) { out = foldUserReminder(out, reminder); }
    return out;
  }

  /* ══════════ A-1084：engine 侧保险门（发送前的最后一道闸） ══════════
     为什么闸门要长在这里：主进程的 `planSend` 只跑在 `slime:chat:compress` 那条编排里，
     而群聊头脑风暴 / 子代理 / 强制工具轮 / 未来的非 GUI 调用**都绕过它**。
     「只有一条路径记得安检」正是 A-1082 的教训（`force` 漏接一处 ⇒ 反应式压缩一次没发生）。
     ⇒ 判据挂到**必经之路**（engine 的发送前），由 `planEngineSend` 唯一说了算。 */

  /**
   * 算本次**实需输入**（tokens）并交给判据。
   *
   * ⚠️ 口径必须与主进程压缩判据**同源**（`estimateHistoryTokens`，CJK 1 字 = 1 token）：
   *    估算偏高 ⇒ 误拦本可发出的请求（用户看到"莫名其妙发不出去"）；
   *    估算偏低 ⇒ 拦不住 ⇒ 下一轮照样撞墙。两处不同口径就会漂移出这两种症状。
   * `messages` 首条即 system（见 buildMessages），故 system 已计入；工具定义单独加。
   */
  private guardSend(opts: ChatEngineCall, messages: ChatMessage[], tools?: unknown): EngineSendGuard {
    const estimated =
      estimateHistoryTokens(messages as Array<{ role: string; content: unknown }>) +
      estimateTokensLocal(tools ? JSON.stringify(tools) : "");
    return planEngineSend({ estimatedInput: estimated, windowCap: opts.windowCap });
  }

  /** Agent 工作目录（sandbox_override.workspace 归一化；无 → ""） */
  private agentWorkspace(agent: AgentState): string {
    const ov = agent.sandbox_override;
    if (!ov || typeof ov !== "object") { return ""; }
    return typeof ov.workspace === "string" ? ov.workspace : "";
  }

  /** 有效工作目录：会话级 workspace 优先（"以文件夹为主"模型），回退 Agent 级（旧数据/CLI 路径） */
  private effectiveWorkspace(opts: ChatEngineCall): string {
    return (opts.workspace ?? "").trim() || this.agentWorkspace(opts.agent);
  }

  /** 思考参数：
   * - none → 发送默认参数（让支持思考的模型产生思考，而非空对象导致无思考）
   * - 本地仅 enable_thinking（llama.cpp 不解析顶层 reasoning_effort，思考标签由 server 层 --reasoning-format deepseek 提取到 reasoning_content）
   * - 云端 Qwen3 需 enable_thinking + return_reasoning 双开，否则思考会混进 content
   * - 其他云模型使用传入的 effort 等级
   * A-918++ 修复 400 Bad Request：此前对【所有】云端模型无条件传 reasoning_effort，
   *   但 opencode-zen 等中转站模型不支持该参数 → 上游 400（用户实测全部返回 400，非 429）。
   *   现在仅当模型 ID 推断支持 thinking（MODEL_CAPABILITIES 命中，与推理强度 dropdown 同源）才传。 */
  /** 按「实际模型」解析思考/推理参数（纯函数式，供路由层按每条候选模型复用）。
   *
   *  **关键区分：「支持思考」≠「怎么开思考」**。开关协议由能力表 `thinkingParam` 数据驱动：
   *   - `reasoning_effort`（缺省）：OpenAI GPT-5/o 系、Grok、Gemini、Claude、Kimi…
   *   - `chat_template_kwargs`：llama.cpp 本地与 **Agnes/Nemotron/Llama/混元**（`enable_thinking`）
   *   - `enable_thinking`：通义千问 DashScope 兼容模式
   *   - `thinking`：豆包/GLM 等 OpenAI 兼容的 `thinking.type`（`{type:"enabled"}`）
   *  早期实现对所有家族统一发 `reasoning_effort`——不认该参数的家族要么静默忽略
   *  （→ 永远没有思考文本），要么直接 400（→ 整请求失败）。 */
  private reasoningParamsForModel(modelIdRaw: string, kind: string, effortRaw: string | undefined, baseUrl: string = ""): Record<string, unknown> {
    // 本地 llama.cpp：固定 chat_template_kwargs（与 Agnes 同族协议）
    if (kind === "local") {
      return { chat_template_kwargs: { enable_thinking: true } };
    }
    const caps = inferModelCapabilities(modelIdRaw ?? "");
    // 不支持思考的云端模型：不传任何思考参数（空对象 → 路由层清掉残留键），避免 400
    if (!caps.supported) {
      return {};
    }
    const familyProto = caps.thinkingParam ?? "reasoning_effort";
    // 关键区分（来源感知）：中转站/聚合网关是 OpenAI 兼容端点，只认 reasoning_effort（转发时
    // 再转成各家原生协议）。同一模型名（如 qwen）在 DashScope 官方用 enable_thinking、在
    // OpenRouter 等中转站必须用 reasoning_effort——不能因模型名相同而混淆协议。
    const proto = isAggregatorGateway(baseUrl) ? "reasoning_effort" : familyProto;
    if (proto === "chat_template_kwargs") {
      return { chat_template_kwargs: { enable_thinking: true } };
    }
    if (proto === "enable_thinking") {
      return { enable_thinking: true, return_reasoning: true };
    }
    if (proto === "thinking") {
      // 豆包/GLM 等 OpenAI 兼容的 thinking.type 协议：{type:"enabled"} 即强制开启思考。
      // 注意：Anthropic 的 budget_tokens 由 AnthropicClient.toAnthropicThinking 在 Messages 层
      // 补齐（把 reasoning_effort 归一为 thinking.budget_tokens），此处不重复生成。
      return { thinking: { type: "enabled" } };
    }
    // A-918+：白名单兜底——per-agent 字段可能残留旧硬编码值 "auto"/"upstream" 等，
    // 这些非法值发给 OpenAI 系上游会报错或无思考；统一归一为 medium（合法值仅 low/medium/high/xhigh/max/minimal）
    const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max", "minimal"];
    const safeEffort = effortRaw && VALID_EFFORTS.includes(effortRaw) ? effortRaw : "medium";
    return { reasoning_effort: safeEffort };
  }

  /** 兼容旧签名：按 agent + 首选 route 先算一次（路由层随后会按每条实际模型再校正） */
  private reasoningParams(agent: AgentState, route: RouteEntry | undefined): Record<string, unknown> {
    return this.reasoningParamsForModel(
      route?.model ?? route?.name ?? "",
      route?.kind ?? "cloud",
      agent.reasoning_effort,
      route?.baseUrl ?? "",
    );
  }

  async chat(opts: ChatEngineCall): Promise<ChatEngineResult> {
    const started = Date.now();
    // A-121: 显式 silam 模型选择（model_choice = "silam" / "silam:..."）→ 直接走离线大脑
    if (this.wantsSilam(opts.agent)) {
      const brain = await this.silamReply(opts);
      if (brain?.reply) {
        return {
          reply: brain.reply,
          replyRaw: brain.reply,
          reasoning: brain.reasoning ?? null,
          model: "silam",
          promptTokens: estimateTokens(opts.message),
          completionTokens: estimateTokens(brain.reply),
          elapsedMs: Date.now() - started,
        };
      }
      const reply = this.silamUnavailableText(opts.agent);
      return { reply, replyRaw: reply, model: "none", promptTokens: 0, completionTokens: 0, elapsedMs: Date.now() - started };
    }
    const { router, error } = await this.resolveRouteInternal(opts.agent);
    if (!router) {
      this.logger.warn(`[engine] 无可路由模型（${opts.agent.model_choice}）：${error ?? "无可用路由"}`);
      // A-121: SILAM 绝对大脑兑底——无 API/本地模型时用离线大脑应答
      const brain = await this.silamReply(opts);
      if (brain?.reply) {
        // A-1018：兜底报因（见 fallbackNotice）
        const notice = this.fallbackNotice(opts.agent, error);
        return {
          reply: brain.reply,
          replyRaw: brain.reply,
          reasoning: brain.reasoning ? `${notice}\n\n${brain.reasoning}` : notice,
          model: "silam-brain",
          promptTokens: estimateTokens(opts.message),
          completionTokens: estimateTokens(brain.reply),
          elapsedMs: Date.now() - started,
        };
      }
      return {
        reply: error ?? this.defaultReply(opts.agent),
        model: "none",
        promptTokens: 0,
        completionTokens: 0,
        elapsedMs: Date.now() - started,
      };
    }
    const system = await this.buildSystem(opts.agent, opts.systemPrompt, opts.workspace);
    const messages = this.buildMessages(opts, system);
    const tools = this.toolSchemas(opts.toolsOnly);

    // A-1084 保险门：装不下的请求**不出网** —— 发了只会被上游拒（400）或长时间挂住
    // （客户端再把它当"可重试"熬 9 次 ⇒ 用户看到的「连接半天还是重连」）。
    const guard = this.guardSend(opts, messages, tools);
    if (!guard.allow) {
      this.logger.warn(`[engine] 上下文保险门拦截（未发送）: ${guard.reason}`);
      // ⚠️ 前缀必须带 LOCAL_PREFLIGHT_MARKER：这是**我们**判定的，上游没说过话 ——
      //   渲染层靠它把本地判定与上游超限归到**同一条**处置（压缩一次 + 重试一次），
      //   否则会落进 9 次重连，而每一次都被这道门原样拦回（比不做还糟）。
      const blocked = `${LOCAL_PREFLIGHT_MARKER}\n⚠️ 本次请求**未发送** —— 上下文装不下该模型的窗口。\n\n${guard.reason}`;
      return {
        reply: blocked,
        replyRaw: blocked,
        model: "none",
        promptTokens: 0,
        completionTokens: 0,
        elapsedMs: Date.now() - started,
      };
    }

    if (tools && tools.length > 0) {
      // 工具场景：chat() 是非流式单结果接口，用非流式工具循环（流式走下方 stream() 的 runStream）
      const route = router.select("chat");
      const loop = new ToolLoop(router, this.tools, {
        sandbox: this.sandbox ? sandboxGateFrom(this.sandbox) : undefined,
        workspace: this.effectiveWorkspace(opts),
        onAskUser: this.onAskUser,
        networkEnabled: opts.networkEnabled,
      });
      const result = await loop.run({ agentId: opts.agent.id, agentName: opts.agent.name, messages, initialToolCalls: [], tools, maxTokens: effectiveMaxTokens(opts.agent, opts.maxTokens), sessionId: opts.sessionId, maxToolCalls: opts.maxToolCalls, maxTotalTokens: opts.maxTotalTokens, maxWallClockMs: opts.maxWallClockMs });
      const filtered = new OutputFilter().filter(result.raw, opts.agent.name);
      // A-122: 辅导员（API/llama）工具轮成功 → SILAM 观战学习
      this.observeTutorDemo(opts, result.raw);
      this.recordUsage(opts, route, {
        promptTokens: result.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
        completionTokens: result.usage?.completion_tokens ?? estimateTokens(result.raw),
        reasoningTokens: 0,
        cacheReadTokens: result.usage?.cache_read_tokens ?? 0,
        cacheCreationTokens: result.usage?.cache_creation_tokens ?? 0,
        ...(typeof result.usage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: result.usage.cache_read_in_prompt } : {}),
        elapsedMs: Date.now() - started,
        success: true,
      });
      return {
        reply: filtered.filtered || result.raw,
        replyRaw: result.raw,
        model: route?.model ?? route?.name ?? "none",
        promptTokens: result.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
        completionTokens: result.usage?.completion_tokens ?? estimateTokens(result.raw),
        ...(typeof result.usage?.cache_read_tokens === "number" ? { cacheReadTokens: result.usage.cache_read_tokens } : {}),
        ...(typeof result.usage?.cache_creation_tokens === "number" ? { cacheCreationTokens: result.usage.cache_creation_tokens } : {}),
        ...(typeof result.usage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: result.usage.cache_read_in_prompt } : {}),
        elapsedMs: Date.now() - started,
      };
    }

    const payload: ChatRequest = { messages, max_tokens: effectiveMaxTokens(opts.agent, opts.maxTokens) };
    const route = router.select("chat");
    Object.assign(payload, this.reasoningParams(opts.agent, route));
    const { response, routeName } = await router.chat(withModel(payload, route!));
    const raw = response.choices[0]?.message?.content ?? "";
    const filtered = new OutputFilter().filter(raw, opts.agent.name);
    const usage = response.usage as { prompt_tokens?: number; completion_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number; reasoning_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; cache_read_in_prompt?: boolean } | undefined;
    // 非流式不可用归一化层（normalizeUsage 只服务流式）——推理 token 手工掏一遍嵌套取值保持一致
    const rt = typeof usage?.reasoning_tokens === "number"
      ? usage.reasoning_tokens
      : typeof usage?.completion_tokens_details?.reasoning_tokens === "number"
        ? usage.completion_tokens_details.reasoning_tokens
        : undefined;
    // A-122: 辅导员（API/llama）非流式成功 → SILAM 观战学习
    this.observeTutorDemo(opts, raw);
    this.recordUsage(opts, route, {
      promptTokens: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
      completionTokens: usage?.completion_tokens ?? estimateTokens(raw),
      reasoningTokens: rt ?? 0,
      cacheReadTokens: usage?.cache_read_tokens ?? 0,
      cacheCreationTokens: usage?.cache_creation_tokens ?? 0,
      ...(typeof usage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: usage.cache_read_in_prompt } : {}),
      elapsedMs: Date.now() - started,
      success: true,
    });
    return {
      reply: filtered.filtered || raw,
      replyRaw: raw,
      model: response.model ?? routeName,
      promptTokens: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
      completionTokens: usage?.completion_tokens ?? estimateTokens(raw),
      ...(typeof rt === "number" ? { reasoningTokens: rt } : {}),
      ...(typeof usage?.cache_read_tokens === "number" ? { cacheReadTokens: usage.cache_read_tokens } : {}),
      ...(typeof usage?.cache_creation_tokens === "number" ? { cacheCreationTokens: usage.cache_creation_tokens } : {}),
      ...(typeof usage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: usage.cache_read_in_prompt } : {}),
      elapsedMs: Date.now() - started,
    };
  }

  /** A-969 上下文自动压缩·摘要轮：用 Agent 的路由模型把长历史浓缩为结构化摘要。
   *
   *  A-1082 修正：旧实现「输入超硬上限 → `return null`」是「压缩并非真压缩」的根因之一 ——
   *  调用方拿到 null 就降级硬裁剪，而那条降级路径当时**什么都没裁**（界面却报「已压缩」）。
   *  现改为 `buildSummaryInput` 在**预算内取头 30% + 尾 70% 摘录** ⇒ 摘要轮**永不放弃**。
   *
   *  @param opts.maxInputTokens 摘要轮输入预算（调用方按该模型窗口解析，缺省 `SUMMARIZE_INPUT_CAP`）
   *  @param opts.priorSummary   既有摘要 ⇒ 走**递进式**（不倒退，I5）
   *  返回 { summary, inputTokens, elided }（无路由/模型失败时 null）。 */
  async summarizeContext(
    agent: AgentState,
    messages: Array<{ role: string; content: unknown }>,
    opts?: { maxInputTokens?: number; priorSummary?: string },
  ): Promise<{ summary: string; inputTokens: number; elided: number } | null> {
    try {
      const { router, error } = await this.resolveRouteInternal(agent);
      if (!router) {
        this.logger.warn(`[engine] 摘要轮无可路由模型（${agent.model_choice}）：${error ?? "无可用路由"}`);
        return null;
      }
      const budget = opts?.maxInputTokens ?? SUMMARIZE_INPUT_CAP;
      const { text, elided } = buildSummaryInput(messages, budget);
      const inputTokens = estimateTokensLocal(text);
      const sys = (
        "你是一个专业的会话上下文压缩器。只做一件事：把用户提供的对话历史压缩成结构化中文摘要，保留接续任务所需的关键信息。" +
        "不要回答摘要之外的内容、不要自我介绍。"
      );
      const payload: ChatRequest = {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: buildCompressSummaryPrompt(text, opts?.priorSummary) },
        ],
        max_tokens: 1024,
      };
      const route = router.select("chat");
      Object.assign(payload, this.reasoningParams(agent, route));
      const { response } = await router.chat(withModel(payload, route!));
      const raw = response.choices[0]?.message?.content ?? "";
      const trimmed = raw.trim();
      if (!trimmed) { return null; }
      return { summary: trimmed, inputTokens, elided };
    } catch (e) {
      this.logger.warn(`[engine] 摘要轮失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** A-1082「理解总结」环（设计定稿 ⑤ AWAIT_COMPREHEND）—— 压缩后**恰好一次**的只读回读。
   *
   *  让模型回读摘要并**自述当前状态**（固定 5 字段），产出「续接认知」作为下一轮的锚。
   *  **有界**（§8.7 ReSum 教训）：单次调用、固定 schema、`max_tokens` 收紧、无工具、无历史。
   *  任何失败都返回 null，由调用方**非阻塞降级**（继续对话并留痕），绝不卡住用户。 */
  async comprehendContext(
    agent: AgentState,
    summary: string,
    opts?: { archivePath?: string },
  ): Promise<{ comprehend: string; raw: string } | null> {
    try {
      const { router, error } = await this.resolveRouteInternal(agent);
      if (!router) {
        this.logger.warn(`[engine] 理解环无可路由模型（${agent.model_choice}）：${error ?? "无可用路由"}`);
        return null;
      }
      const payload: ChatRequest = {
        messages: [
          {
            role: "system",
            content: "你只做一件事：回读给定的工作摘要，用被动陈述语气自述当前状态。不要执行任何动作、不要调用工具、不要给出指令。",
          },
          { role: "user", content: buildResumeBlock(summary, opts?.archivePath) },
        ],
        max_tokens: 800,
      };
      const route = router.select("chat");
      Object.assign(payload, this.reasoningParams(agent, route));
      const { response } = await router.chat(withModel(payload, route!));
      const raw = (response.choices[0]?.message?.content ?? "").trim();
      if (!raw) { return null; }
      const parsed = parseComprehend(raw);
      if (!parsed.ok) {
        // 5 字段不齐 / 夹带指令式语句 ⇒ 视为**理解失败**（不是压缩成功）
        this.logger.warn(
          `[engine] 理解环输出不合格：missing=[${parsed.missing.join(",")}] injected=${parsed.injected}${parsed.injectionSample ? ` sample=${parsed.injectionSample}` : ""}`,
        );
        return null;
      }
      return { comprehend: raw, raw };
    } catch (e) {
      this.logger.warn(`[engine] 理解环失败（非阻塞降级）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async *stream(opts: ChatEngineCall): AsyncGenerator<EngineChunk> {
    const started = Date.now();
    /* A-1061④：**开流先清掉上游通知槽**。
       槽是进程级单例（瞬时状态，见 upstreamNotice.ts）。若不在这里清，上一次请求
       （尤其是失败重试过的、或非流式 chat() 路径留下的）那条通知会在本次流的第一个
       轮询 tick 被当成"本次的上游状态"吐给界面 —— 用户会看到一句与当前请求无关的
       "正在重试"。（实测：engine.spec 的"无工具流式"用例就因此被打成 ['notice','chunk','done']。） */
    takeUpstreamNotice();
    // 局部累积展示文本：中断后立刻发新消息时，两个并发流互不污染（此前类级字段会串文本）
    let displayText = "";
    // A-121: 显式 silam 模型选择 → 直接走离线大脑（流式场景一次性 done）
    if (this.wantsSilam(opts.agent)) {
      const brain = await this.silamReply(opts);
      if (brain?.reply) {
        // A-124 正文/思考分离：先吐思考过程（GUI 折叠展示），再吐正文
        if (brain.reasoning) {
          yield { type: "reasoning", content: brain.reasoning };
        }
        yield {
          type: "done",
          reply: brain.reply,
          reply_raw: brain.reply,
          reasoning: brain.reasoning ?? null,
          model: "silam",
          prompt_tokens: estimateTokens(opts.message),
          completion_tokens: estimateTokens(brain.reply),
          elapsed_ms: Date.now() - started,
        };
        return;
      }
      const reply = this.silamUnavailableText(opts.agent);
      yield { type: "done", reply, reply_raw: reply, model: "none", prompt_tokens: 0, completion_tokens: 0, elapsed_ms: Date.now() - started };
      return;
    }
    const { router, error } = await this.resolveRouteInternal(opts.agent, opts.signal);
    if (!router) {
      this.logger.warn(`[engine] 无可路由模型（${opts.agent.model_choice}）：${error ?? "无可用路由"}`);
      // A-121: SILAM 绝对大脑兑底——无 API/本地模型时用离线大脑应答（流式场景直接 done）
      const brain = await this.silamReply(opts);
      if (brain?.reply) {
        // A-124 正文/思考分离：先吐思考过程（GUI 折叠展示），再吐正文。
        // A-1018：思考段**前置兜底原因**（即使没有思考也要吐出去，否则用户看不出这轮不是他选的模型答的）。
        const notice = this.fallbackNotice(opts.agent, error);
        yield { type: "reasoning", content: brain.reasoning ? `${notice}\n\n${brain.reasoning}` : notice };
        yield {
          type: "done",
          reply: brain.reply,
          reply_raw: brain.reply,
          reasoning: brain.reasoning ?? null,
          model: "silam-brain",
          prompt_tokens: estimateTokens(opts.message),
          completion_tokens: estimateTokens(brain.reply),
          elapsed_ms: Date.now() - started,
        };
        return;
      }
      const reply = error ?? this.defaultReply(opts.agent);
      yield { type: "done", reply, reply_raw: reply, model: "none", prompt_tokens: 0, completion_tokens: 0, elapsed_ms: Date.now() - started };
      return;
    }
    const system = await this.buildSystem(opts.agent, opts.systemPrompt, opts.workspace);
    const messages = this.buildMessages(opts, system);
    const tools = this.toolSchemas(opts.toolsOnly);
    // A-939 上下文分桶（粗粒度：system/tools/history/message 四来源；细粒度系统内部拆分后续迭代）
    const buckets = computeContextBuckets({
      system,
      tools: tools ? JSON.stringify(tools) : "",
      history: JSON.stringify(opts.history),
      message: opts.message,
    });
    // A-1084 保险门（同上文 chat()）：装不下就**不出网**。
    // ⚠️ 必须**先于** tool_loop / 路由发起 —— 这道门的意义就是"不发"，晚一步就等于没做。
    // 出声走 `error` 事件（渲染层已有 `isContextOverflowError` 分支，会走压缩一次 + 重试一次）。
    const guard = this.guardSend(opts, messages, tools);
    if (!guard.allow) {
      this.logger.warn(`[engine] 上下文保险门拦截（未发送）: ${guard.reason}`);
      // 标记的用途见 chat() 处同名注释（本地判定必须自报身份，才能走同一条处置路径）
      yield { type: "error", message: `${LOCAL_PREFLIGHT_MARKER}\n⚠️ 本次请求**未发送** —— 上下文装不下该模型的窗口。\n\n${guard.reason}` };
      return;
    }

    if (tools && tools.length > 0) {
      // 工具场景：真流式工具循环（5B.3）——每轮 chatStream，思考/正文边到边实时可见。
      // async generator 无法在 await 回调内 yield，用「后台任务 + 队列轮询」桥接（同无工具路径）。
      const route = router.select("chat");
      const loop = new ToolLoop(router, this.tools, {
        sandbox: this.sandbox ? sandboxGateFrom(this.sandbox) : undefined,
        workspace: this.effectiveWorkspace(opts),
        onAskUser: this.onAskUser,
        networkEnabled: opts.networkEnabled,
      });
      const liveQueue: EngineChunk[] = [];
      let loopDone = false;
      let loopError: Error | null = null;
      const loopPromise = loop
        .runStream({
          agentId: opts.agent.id,
          agentName: opts.agent.name,
          messages,
          initialToolCalls: [],
          tools,
          maxTokens: effectiveMaxTokens(opts.agent, opts.maxTokens),
          sessionId: opts.sessionId,
          signal: opts.signal,
          maxToolCalls: opts.maxToolCalls,
          maxTotalTokens: opts.maxTotalTokens,
          maxWallClockMs: opts.maxWallClockMs,
          onEvent: (ev) => {
            if (ev.type === "reasoning") {
              liveQueue.push({ type: "reasoning", content: ev.content });
            } else if (ev.type === "chunk") {
              liveQueue.push({ type: "chunk", content: ev.content });
            } else if (ev.type === "steer") {
              // A-1060：引导已进本轮上下文 → 透传给渲染层（撤掉待发卡片 + 折进思考历程）。
              // ⚠️ 必须显式成一支：下面的 else 是「tool 兜底」，把 steer 落进去会变成一条
              //    name/args 全空的假工具事件（界面会多出一张空工具卡，且用户看不懂）。
              liveQueue.push({ type: "steer", content: ev.text, steerId: ev.id });
            } else if (ev.type === "tool-start") {
              // A-1061②：工具开始执行 → 界面立刻显示「执行中…」（toolId 用于与完成事件配对）
              liveQueue.push({ type: "tool-start", name: ev.name, args: ev.args, toolId: ev.id });
            } else {
              liveQueue.push({ type: "tool", name: ev.name, args: ev.args, result: ev.result, toolId: ev.id });
            }
          },
        })
        .then((r) => {
          loopDone = true;
          return r;
        })
        .catch((e: unknown) => {
          loopDone = true;
          loopError = e instanceof Error ? e : new Error(String(e));
          throw e;
        });

      // A-980-R24：**必须给 loopPromise 挂一个 rejection handler**。
      // 上面的 `.catch` 会 `throw`（保留原始错误类型给调用方语义），于是 loopPromise 变成
      // 「已拒绝」的 Promise；而正常的失败分支在 `if (loopError)` 里直接 `return` / `throw loopError`
      // —— 都在 `await loopPromise` **之前**，那个 rejected promise 从此无人 await
      // → Node 判定为 **unhandledRejection**，被主进程兜底 handler 落盘。
      // 结果就是 `data/logs/main-errors.log` 被「请求已取消 / 流式已取消 / ERR_CONNECTION_RESET」
      // 刷满（真实日志 100% 都是这一条），既淹没了真错误，也拖慢每次中断/断网的收尾。
      // 这里挂一个空 handler 把它标记为"已被处理"：错误本身仍由下面的 loopError 分支统一抛出。
      void loopPromise.catch(() => { /* 由下方 loopError 分支统一处理 */ });

      // 轮询队列：边到边 yield（30ms 粒度，思考/正文实时跟进模型输出）
      while (!loopDone) {
        // A-1061④：上游重试 / 切换备用模型的瞬时通知也要吐出去 —— 这段等待期界面本来
        // 只有一句"等待上游返回…"，用户以为卡死（原话："加载半天才输出"）。
        const notice = takeUpstreamNotice();
        if (notice) { liveQueue.push({ type: "notice", content: notice.text }); }
        while (liveQueue.length > 0) {
          yield liveQueue.shift()!;
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      while (liveQueue.length > 0) {
        yield liveQueue.shift()!;
      }
      if (loopError) {
        if (opts.signal?.aborted) {
          this.recordUsage(opts, route, {
            promptTokens: estimateTokens(JSON.stringify(messages)),
            completionTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            elapsedMs: Date.now() - started,
            success: false,
            error: "user-aborted",
          });
          yield {
            type: "done",
            reply: "（生成已被中断）",
            reply_raw: "",
            model: route?.model ?? route?.name ?? "none",
            prompt_tokens: estimateTokens(JSON.stringify(messages)),
            completion_tokens: 0,
            elapsed_ms: Date.now() - started,
          };
          return;
        }
        throw loopError;
      }
      const result = await loopPromise;
      const filtered = new OutputFilter().filter(result.raw, opts.agent.name);
      const display = filtered.filtered || result.raw;
      // A-122: 辅导员（API/llama）流式·工具轮成功 → SILAM 观战学习
      this.observeTutorDemo(opts, result.raw);
      // 缓存命中透传：上游 usage 优先（真实值），无则回退 token 估算（不虚构命中）
      const loopUsage = result.usage;
      this.recordUsage(opts, route, {
        promptTokens: loopUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
        completionTokens: loopUsage?.completion_tokens ?? estimateTokens(result.raw),
        reasoningTokens: loopUsage?.reasoning_tokens ?? 0,
        cacheReadTokens: loopUsage?.cache_read_tokens ?? 0,
        cacheCreationTokens: loopUsage?.cache_creation_tokens ?? 0,
        ...(typeof loopUsage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: loopUsage.cache_read_in_prompt } : {}),
        elapsedMs: Date.now() - started,
        success: true,
      });
      yield {
        type: "done",
        reply: display,
        reply_raw: result.raw,
        model: route?.model ?? route?.name ?? "none",
        ctxBuckets: buckets,
        prompt_tokens: loopUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
        completion_tokens: loopUsage?.completion_tokens ?? estimateTokens(result.raw),
        ...(typeof loopUsage?.reasoning_tokens === "number" ? { reasoning_tokens: loopUsage.reasoning_tokens } : {}),
        ...(typeof loopUsage?.cache_read_tokens === "number" ? { cache_read_tokens: loopUsage.cache_read_tokens } : {}),
        ...(typeof loopUsage?.cache_creation_tokens === "number" ? { cache_creation_tokens: loopUsage.cache_creation_tokens } : {}),
        // A-974-R7：**窗口占用口径**——工具循环每轮全量重发历史，`prompt_tokens` 是跨轮累计（计费用），
        // 直接当窗口占用会 N 轮叠加爆表。这里额外下发「最近一轮」的输入侧 token，供 GUI 上下文环/右栏使用。
        ...(typeof result.lastUsage?.prompt_tokens === "number" ? { window_prompt_tokens: result.lastUsage.prompt_tokens } : {}),
        ...(typeof result.lastUsage?.cache_read_tokens === "number" ? { window_cache_read_tokens: result.lastUsage.cache_read_tokens } : {}),
        ...(typeof result.lastUsage?.cache_creation_tokens === "number" ? { window_cache_creation_tokens: result.lastUsage.cache_creation_tokens } : {}),
        // A-974-R8：窗口口径一并下发"prompt 是否已含缓存"（OpenAI 兼容=true / Anthropic=false）
        ...(typeof result.lastUsage?.cache_read_in_prompt === "boolean" ? { cache_read_in_prompt: result.lastUsage.cache_read_in_prompt } : {}),
        elapsed_ms: Date.now() - started,
      };
      return;
    }

    // 无工具：真流式 + StreamFilter 跨 chunk 身份铁律过滤
    const filter = new OutputFilter();
    const streamFilter = new StreamFilter();
    const payload = { messages, max_tokens: effectiveMaxTokens(opts.agent, opts.maxTokens) } as ChatRequest;
    const route = router.select("chat");
    Object.assign(payload, this.reasoningParams(opts.agent, route));

    // 实时流式：async generator 无法在 await 回调内 yield，用「后台任务 + 队列轮询」桥接，
    // 使 chunk/reasoning 边到边吐（思考过程实时可见），而非等整段流结束才统一回放。
    const liveQueue: EngineChunk[] = [];
    let streamDone = false;
    let streamError: Error | null = null;
    const streamPromise = router.chatStream(
      withModel(payload, route!),
      (delta) => {
        const emitted = streamFilter.push(delta, filter, opts.agent.name);
        if (emitted) {
          liveQueue.push({ type: "chunk", content: emitted });
          displayText += emitted;
        }
      },
      opts.signal,
      (reasoning) => {
        liveQueue.push({ type: "reasoning", content: reasoning });
      },
    ).then((r) => {
      streamDone = true;
      return r;
    }).catch((e: unknown) => {
      streamDone = true;
      streamError = e instanceof Error ? e : new Error(String(e));
      throw e;
    });

    // A-980-R24：同工具路径——`.catch` 内 `throw` 会让 streamPromise 成为无人 await 的
    // rejected Promise（失败分支在 `if (streamError)` 里就 return/throw 了，永远走不到
    // `await streamPromise`）→ unhandledRejection 刷屏。挂空 handler 标记为已处理。
    void streamPromise.catch(() => { /* 由下方 streamError 分支统一处理 */ });

    // 轮询队列：边到边 yield（30ms 粒度，兼顾实时性与 CPU 占用）
    while (!streamDone) {
      // A-1061④：同上 —— 纯流式（无工具）路径的首包等待期也要能报出"在上游重试"
      const notice = takeUpstreamNotice();
      if (notice) { liveQueue.push({ type: "notice", content: notice.text }); }
      while (liveQueue.length > 0) {
        yield liveQueue.shift()!;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    while (liveQueue.length > 0) {
      yield liveQueue.shift()!;
    }
    // 尾部内容（StreamFilter 持有的 32 字符窗口）
    const tail = streamFilter.flush(filter, opts.agent.name);
    if (tail) {
      yield { type: "chunk", content: tail };
      displayText += tail;
    }
    if (streamError) {
      if (opts.signal?.aborted) {
        // 用户主动中断：保留已生成部分，正常收尾（不虚报完成）
        const partial = displayText;
        this.recordUsage(opts, route, {
          promptTokens: estimateTokens(JSON.stringify(messages)),
          completionTokens: estimateTokens(partial),
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          elapsedMs: Date.now() - started,
          success: false,
          error: "user-aborted",
        });
        yield {
          type: "done",
          reply: partial || "（生成已被中断）",
          reply_raw: partial,
          model: (route as { model?: string; name?: string } | undefined)?.model ?? (route as { name?: string } | undefined)?.name ?? "unknown",
          prompt_tokens: estimateTokens(JSON.stringify(messages)),
          completion_tokens: estimateTokens(partial),
          elapsed_ms: Date.now() - started,
        };
        return;
      }
      throw streamError;
    }
    const raw = await streamPromise;
    // A-122: 辅导员（API/llama）流式·无工具成功 → SILAM 观战学习
    this.observeTutorDemo(opts, raw.text);
    // 缓存命中透传：上游 usage 优先（真实值），无则回退 token 估算（不虚构命中）。
    // 对齐 tool-loop 路径 :1036-1039 写法；否则 cache_read_tokens 永远 0 → 右栏命中率 0%。
    const streamUsage = raw.usage;
    this.recordUsage(opts, route, {
      promptTokens: streamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
      completionTokens: streamUsage?.completion_tokens ?? estimateTokens(raw.text),
      reasoningTokens: streamUsage?.reasoning_tokens ?? 0,
      cacheReadTokens: streamUsage?.cache_read_tokens ?? 0,
      cacheCreationTokens: streamUsage?.cache_creation_tokens ?? 0,
      ...(typeof streamUsage?.cache_read_in_prompt === "boolean" ? { cacheReadInPrompt: streamUsage.cache_read_in_prompt } : {}),
      elapsedMs: Date.now() - started,
      success: true,
    });
    yield {
      type: "done",
      reply: displayText,
      reply_raw: raw.text,
      model: raw.model,
      ctxBuckets: buckets,
      prompt_tokens: streamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
      completion_tokens: streamUsage?.completion_tokens ?? estimateTokens(raw.text),
      ...(typeof streamUsage?.reasoning_tokens === "number" ? { reasoning_tokens: streamUsage.reasoning_tokens } : {}),
      ...(typeof streamUsage?.cache_read_tokens === "number" ? { cache_read_tokens: streamUsage.cache_read_tokens } : {}),
      ...(typeof streamUsage?.cache_creation_tokens === "number" ? { cache_creation_tokens: streamUsage.cache_creation_tokens } : {}),
      // A-974-R8：单请求路径同样下发"prompt 是否已含缓存"（OpenAI 兼容=true / Anthropic=false）——
      // GUI 窗口占用公式据此决定是否 +cache_read（AGNES/OpenAI 系重复计缓存正是此前虚高的另一半来源）
      ...(typeof streamUsage?.cache_read_in_prompt === "boolean" ? { cache_read_in_prompt: streamUsage.cache_read_in_prompt } : {}),
      // 截断可见性：上游 finish_reason=length 表示触达输出上限被截断——上浮给 UI 提示，
      // 不再让"写半句话就静默结束"（用户反馈的"莫名截断"）。
      ...(raw.finishReason ? { finish_reason: raw.finishReason } : {}),
      elapsed_ms: Date.now() - started,
    };
  }
}

/** 组装完整 SlimeEngine（Electron 主进程 / CLI 注入点） */
export function createEngine(opts: SlimeEngineOptions): SlimeEngine {
  return new SlimeEngine(opts);
}