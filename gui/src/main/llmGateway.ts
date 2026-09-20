/**
 * gui/src/main/llmGateway.ts — LLM 网关管理器（GUI 主进程侧）。
 * - 读写 config/llm_gateway.json（enabled / port / apiKey / tokens）
 * - 启动/停止 gateway-ts 的 buildGateway（Fastify 实例，绑定 127.0.0.1）
 * - 状态查询（是否运行 / 端口 / 错误）
 * - 令牌 CRUD（B 档：每令牌独立速率/日配额/模型白名单）
 *
 * 边界：LLM 网关是 slime 自身能力（不依赖外部程序），复用 gateway-ts 的 buildGateway。
 * 令牌表改动后若网关在运行会自动重启以生效（v1 定案：不做热更新）。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildGateway } from "../../../gateway-ts/src/index.js";
import { TokenDef, TokenStore } from "../../../gateway-ts/src/tokenStore.js";
import { decryptRaw } from "../../../core-ts/src/encryption.js";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { getSharedLiveProbe } from "../../../core-ts/src/probe-live.js";
import { hydrateLiveProbeCache, persistLiveProbeCache } from "../../../core-ts/src/probe-persist.js";

/** LLM 网关配置（持久化到 config/llm_gateway.json） */
export interface LlmGatewayConfig {
  /** 是否开启（false 时不启动网关） */
  enabled: boolean;
  /** 监听端口（默认 19110） */
  port: number;
  /** 客户端访问网关所需的独立 API Key（空 = 沿用 slime 全局 auth token） */
  apiKey: string;
  /** 令牌列表（B 档：每令牌独立速率/日配额/模型白名单；空 = 仅走 apiKey/全局 token） */
  tokens: TokenDef[];
}

export interface LlmGatewayStatus {
  ok: boolean;
  running: boolean;
  port: number;
  enabled: boolean;
  apiKeyConfigured: boolean;
  error?: string;
  /** 当前配置里的令牌数 */
  tokenCount?: number;
}

/** 新增令牌输入（key 由系统生成，不接收外部传入的 key） */
export interface NewTokenInput {
  label?: string;
  ratePerMin?: number;
  dailyQuota?: number;
  models?: string[];
  note?: string;
}

/** 修改令牌输入（按现有 key 定位；key 本身不可改，仅改其它字段） */
export interface UpdateTokenInput {
  key: string;
  label?: string;
  active?: boolean;
  ratePerMin?: number;
  dailyQuota?: number;
  models?: string[];
  note?: string;
}

const CONFIG_PATH = join(PROJECT_ROOT, "config", "llm_gateway.json");
const DEFAULT_CONFIG: LlmGatewayConfig = { enabled: true, port: 19110, apiKey: "", tokens: [] };

function sanitizeTokens(raw: unknown): TokenDef[] {
  if (!Array.isArray(raw)) { return []; }
  const out: TokenDef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") { continue; }
    const t = item as Partial<TokenDef>;
    if (typeof t.key !== "string" || t.key.length < 8) { continue; } // 与 TokenStore 下限一致
    const def: TokenDef = { key: t.key };
    if (typeof t.label === "string") { def.label = t.label; }
    if (typeof t.active === "boolean") { def.active = t.active; }
    if (typeof t.ratePerMin === "number" && t.ratePerMin > 0) { def.ratePerMin = Math.floor(t.ratePerMin); }
    if (typeof t.dailyQuota === "number" && t.dailyQuota > 0) { def.dailyQuota = Math.floor(t.dailyQuota); }
    if (Array.isArray(t.models)) { def.models = t.models.filter((m): m is string => typeof m === "string"); }
    if (typeof t.note === "string") { def.note = t.note; }
    out.push(def);
  }
  return out;
}

/** 读配置（文件缺失/损坏回退默认值） */
export function readLlmGatewayConfig(): LlmGatewayConfig {
  try {
    if (!existsSync(CONFIG_PATH)) { return { ...DEFAULT_CONFIG, tokens: [] }; }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<LlmGatewayConfig>;
    const port = typeof raw.port === "number" && raw.port > 0 && raw.port < 65536 ? Math.floor(raw.port) : DEFAULT_CONFIG.port;
    return {
      enabled: Boolean(raw.enabled),
      port,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
      tokens: sanitizeTokens(raw.tokens),
    };
  } catch {
    return { ...DEFAULT_CONFIG, tokens: [] };
  }
}

/** 写配置（原子写：tmp + rename） */
export function writeLlmGatewayConfig(cfg: LlmGatewayConfig): { ok: boolean; error?: string } {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    const tmp = `${CONFIG_PATH}.${Date.now()}.tmp`;
    const payload: LlmGatewayConfig = { ...cfg, tokens: sanitizeTokens(cfg.tokens) };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, CONFIG_PATH);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 网关运行时状态管理器（GUI 主进程单例） */
export class LlmGatewayManager {
  private app: ReturnType<typeof buildGateway> | null = null;
  private lastError: string | null = null;
  /** 探针层第 2 层快照的定时落盘定时器（30s 一次；网关运行期才有） */
  private probeFlushTimer: ReturnType<typeof setInterval> | null = null;

  /** 启动前把上次落盘的实时能力快照恢复进共享缓存（跨重启保留） */
  private hydrateLiveProbe(): void {
    try {
      const restored = hydrateLiveProbeCache(getSharedLiveProbe({ ttlMs: 5 * 60_000 }));
      if (restored > 0) {
        this.loggerInfo(`[llmgw] 已恢复 ${restored} 条实时能力快照（未过期）`);
      }
    } catch {
      // 恢复失败不影响网关启动（冷启动走重探）
    }
  }

  /** 启动期定时把实时能力快照落盘（网关停止/进程退出前会停表 + 最后一次保存） */
  private startProbeFlush(): void {
    this.stopProbeFlush();
    const flush = (): void => {
      try {
        persistLiveProbeCache(getSharedLiveProbe());
      } catch {
        // 落盘失败静默（不阻断主流程；下个周期再试）
      }
    };
    this.probeFlushTimer = setInterval(flush, 30_000);
    (this.probeFlushTimer as { unref?: () => void }).unref?.(); // 不阻塞进程退出
    // 启动即存一次（恢复的旧快照先固化，避免进程意外退出丢数据）
    flush();
  }

  /** 停止定时落盘 + 把最新快照落盘一次（网关停止/进程退出前调用） */
  private stopProbeFlush(): void {
    if (this.probeFlushTimer) {
      clearInterval(this.probeFlushTimer);
      this.probeFlushTimer = null;
    }
    try {
      persistLiveProbeCache(getSharedLiveProbe());
    } catch {
      // 忽略
    }
  }

  private loggerInfo(msg: string): void {
    // 与网关其余日志保持轻量：写 console（主进程），不依赖注入 logger
    console.info(msg);
  }

  /** 读取当前运行状态（供渲染层轮询） */
  status(): LlmGatewayStatus {
    const cfg = readLlmGatewayConfig();
    return {
      ok: true,
      running: this.app !== null,
      port: cfg.port,
      enabled: cfg.enabled,
      apiKeyConfigured: cfg.apiKey.length > 0,
      error: this.lastError ?? undefined,
      tokenCount: cfg.tokens.length,
    };
  }

  /** 根据配置启动或停止网关（配置变更后调用） */
  async apply(cfg: LlmGatewayConfig): Promise<{ ok: boolean; error?: string }> {
    const write = writeLlmGatewayConfig(cfg);
    if (!write.ok) { return write; }
    if (!cfg.enabled) {
      await this.stop();
      return { ok: true };
    }
    return this.start();
  }

  /** 启动网关（若已在运行则先停再启，保证端口/配置/令牌生效） */
  async start(): Promise<{ ok: boolean; error?: string }> {
    await this.stop();
    const cfg = readLlmGatewayConfig();
    try {
      // 探针层第 2 层：先恢复上次落盘的实时能力快照（跨重启保留，避免冷启动重探）
      this.hydrateLiveProbe();
      // 网关需要 slime 全局 auth token（agent 端点认证）+ sidecar 推理地址
      const authToken = this.resolveAuthToken();
      const sidecarBaseUrl = `http://127.0.0.1:${process.env.INFER_PORT || "19100"}`;
      const app = buildGateway({
        port: cfg.port,
        authToken,
        sidecarBaseUrl,
        llmGateway: {
          enabled: true,
          projectRoot: PROJECT_ROOT,
          apiKey: cfg.apiKey || undefined, // 空则沿用全局 authToken
          tokens: cfg.tokens,
        },
      });
      await app.listen({ port: cfg.port, host: "127.0.0.1" });
      this.app = app;
      this.lastError = null;
      // 网关运行期开始定时落盘实时能力快照（stop/退出前停表 + 最后保存）
      this.startProbeFlush();
      return { ok: true };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.stopProbeFlush(); // 启动失败也要停表，避免悬挂定时器
      return { ok: false, error: this.lastError };
    }
  }

  /** 停止网关 */
  async stop(): Promise<void> {
    if (!this.app) { return; }
    const app = this.app;
    this.app = null;
    // 停止前把最新实时能力快照落盘一次（跨重启保留）
    this.stopProbeFlush();
    try {
      await app.close();
    } catch {
      // 关闭失败也视为已停（进程退出时兜底）
    }
  }

  /**
   * 令牌 CRUD 内部辅助：改 config 后若网关在运行，重启以让新令牌生效。
   * 返回重启结果（未运行则 { restarted: false }）。
   */
  private async persistTokens(mutator: (cfg: LlmGatewayConfig) => LlmGatewayConfig): Promise<{ ok: boolean; restarted: boolean; error?: string }> {
    const cfg = readLlmGatewayConfig();
    const next = mutator(cfg);
    const write = writeLlmGatewayConfig(next);
    if (!write.ok) { return { ok: false, restarted: false, error: write.error }; }
    if (this.app) {
      const r = await this.start();
      return { ok: r.ok, restarted: true, error: r.error };
    }
    return { ok: true, restarted: false };
  }

  /** 生成一个新令牌（key 随机生成，返回明文供展示/复制） */
  async addToken(input: NewTokenInput): Promise<{ ok: boolean; token?: TokenDef; restarted: boolean; error?: string }> {
    const key = TokenStore.generateKey();
    const def: TokenDef = {
      key,
      label: input.label?.trim() || undefined,
      ratePerMin: input.ratePerMin && input.ratePerMin > 0 ? Math.floor(input.ratePerMin) : undefined,
      dailyQuota: input.dailyQuota && input.dailyQuota > 0 ? Math.floor(input.dailyQuota) : undefined,
      models: input.models && input.models.length > 0 ? input.models : undefined,
      note: input.note?.trim() || undefined,
      active: true,
    };
    const res = await this.persistTokens((cfg) => {
      const tokens = this.ensureWritable([...cfg.tokens, def]);
      return { ...cfg, tokens };
    });
    if (!res.ok) { return { ok: false, restarted: res.restarted, error: res.error }; }
    return { ok: true, token: def, restarted: res.restarted };
  }

  /** 修改令牌字段（按 key 定位） */
  async updateToken(input: UpdateTokenInput): Promise<{ ok: boolean; token?: TokenDef; restarted: boolean; error?: string }> {
    const cfg = readLlmGatewayConfig();
    const idx = cfg.tokens.findIndex((t) => t.key === input.key);
    if (idx < 0) { return { ok: false, restarted: false, error: "令牌不存在" }; }
    const prev = cfg.tokens[idx];
    const nextDef: TokenDef = { ...prev };
    if (input.label !== undefined) { nextDef.label = input.label.trim() || undefined; }
    if (input.active !== undefined) { nextDef.active = input.active; }
    if (input.ratePerMin !== undefined) { nextDef.ratePerMin = input.ratePerMin > 0 ? Math.floor(input.ratePerMin) : undefined; }
    if (input.dailyQuota !== undefined) { nextDef.dailyQuota = input.dailyQuota > 0 ? Math.floor(input.dailyQuota) : undefined; }
    if (input.models !== undefined) { nextDef.models = input.models.length > 0 ? input.models : undefined; }
    if (input.note !== undefined) { nextDef.note = input.note.trim() || undefined; }
    const res = await this.persistTokens((c) => {
      const tokens = this.ensureWritable(c.tokens.map((t) => (t.key === input.key ? nextDef : t)));
      return { ...c, tokens };
    });
    if (!res.ok) { return { ok: false, restarted: res.restarted, error: res.error }; }
    return { ok: true, token: nextDef, restarted: res.restarted };
  }

  /** 删除令牌 */
  async removeToken(key: string): Promise<{ ok: boolean; restarted: boolean; error?: string }> {
    const cfg = readLlmGatewayConfig();
    if (!cfg.tokens.some((t) => t.key === key)) { return { ok: false, restarted: false, error: "令牌不存在" }; }
    const res = await this.persistTokens((c) => {
      const tokens = this.ensureWritable(c.tokens.filter((t) => t.key !== key));
      return { ...c, tokens };
    });
    return { ok: res.ok, restarted: res.restarted, error: res.error };
  }

  /** 启用/停用令牌 */
  async toggleToken(key: string, active: boolean): Promise<{ ok: boolean; token?: TokenDef; restarted: boolean; error?: string }> {
    const res = await this.updateToken({ key, active });
    if (!res.ok) { return res; }
    const token = readLlmGatewayConfig().tokens.find((t) => t.key === key);
    return { ok: true, token, restarted: res.restarted };
  }

  /** 列出全部令牌（脱敏 key：保留前 4 后 4） */
  listTokens(): TokenDef[] {
    return readLlmGatewayConfig().tokens;
  }

  // ── 内部：写入前的令牌表一致性校验（去重 key，防御手工编辑 json 导致重复）──
  private ensureWritable(tokens: TokenDef[]): TokenDef[] {
    const seen = new Set<string>();
    const dedup: TokenDef[] = [];
    for (const t of tokens) {
      if (seen.has(t.key)) { continue; }
      seen.add(t.key);
      dedup.push(t);
    }
    return dedup;
  }

  /** 解密 slime 全局 auth token（auth_token.enc；失败回退空串） */
  private resolveAuthToken(): string {
    try {
      return decryptRaw("config/auth_token.enc") ?? "";
    } catch {
      return "";
    }
  }
}

/** 进程级单例 */
let managerSingleton: LlmGatewayManager | null = null;
export function getLlmGatewayManager(): LlmGatewayManager {
  if (!managerSingleton) { managerSingleton = new LlmGatewayManager(); }
  return managerSingleton;
}
