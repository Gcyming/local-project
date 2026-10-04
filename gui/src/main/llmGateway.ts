










import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildGateway } from "../../../gateway-ts/src/index.js";
import { TokenDef, TokenStore } from "../../../gateway-ts/src/tokenStore.js";
import { decryptRaw } from "../../../core-ts/src/encryption.js";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { getSharedLiveProbe } from "../../../core-ts/src/probe-live.js";
import { hydrateLiveProbeCache, persistLiveProbeCache } from "../../../core-ts/src/probe-persist.js";
import { SEARCH_INDEX_PORT } from "./searchIndexService.js";


export interface LlmGatewayConfig {
  
  enabled: boolean;
  
  port: number;
  
  apiKey: string;
  
  tokens: TokenDef[];
}

export interface LlmGatewayStatus {
  ok: boolean;
  running: boolean;
  port: number;
  enabled: boolean;
  apiKeyConfigured: boolean;
  error?: string;
  
  tokenCount?: number;
}


export interface NewTokenInput {
  label?: string;
  ratePerMin?: number;
  dailyQuota?: number;
  models?: string[];
  note?: string;
}


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
    if (typeof t.key !== "string" || t.key.length < 8) { continue; } 
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


export class LlmGatewayManager {
  private app: ReturnType<typeof buildGateway> | null = null;
  private lastError: string | null = null;
  
  private probeFlushTimer: ReturnType<typeof setInterval> | null = null;

  
  private hydrateLiveProbe(): void {
    try {
      const restored = hydrateLiveProbeCache(getSharedLiveProbe({ ttlMs: 5 * 60_000 }));
      if (restored > 0) {
        this.loggerInfo(`[llmgw] 已恢复 ${restored} 条实时能力快照（未过期）`);
      }
    } catch {
      
    }
  }

  
  private startProbeFlush(): void {
    this.stopProbeFlush();
    const flush = (): void => {
      try {
        persistLiveProbeCache(getSharedLiveProbe());
      } catch {
        
      }
    };
    this.probeFlushTimer = setInterval(flush, 30_000);
    (this.probeFlushTimer as { unref?: () => void }).unref?.(); 
    
    flush();
  }

  
  private stopProbeFlush(): void {
    if (this.probeFlushTimer) {
      clearInterval(this.probeFlushTimer);
      this.probeFlushTimer = null;
    }
    try {
      persistLiveProbeCache(getSharedLiveProbe());
    } catch {
      
    }
  }

  private loggerInfo(msg: string): void {
    
    console.info(msg);
  }

  
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

  
  async apply(cfg: LlmGatewayConfig): Promise<{ ok: boolean; error?: string }> {
    const write = writeLlmGatewayConfig(cfg);
    if (!write.ok) { return write; }
    if (!cfg.enabled) {
      await this.stop();
      return { ok: true };
    }
    return this.start();
  }

  
  async start(): Promise<{ ok: boolean; error?: string }> {
    await this.stop();
    const cfg = readLlmGatewayConfig();
    try {
      
      this.hydrateLiveProbe();
      
      const authToken = this.resolveAuthToken();
      const sidecarBaseUrl = `http://127.0.0.1:${process.env.INFER_PORT || "19100"}`;
      const app = buildGateway({
        port: cfg.port,
        authToken,
        sidecarBaseUrl,
        



        searchBaseUrl: `http://127.0.0.1:${SEARCH_INDEX_PORT}`,
        llmGateway: {
          enabled: true,
          projectRoot: PROJECT_ROOT,
          apiKey: cfg.apiKey || undefined, 
          tokens: cfg.tokens,
        },
      });
      await app.listen({ port: cfg.port, host: "127.0.0.1" });
      this.app = app;
      this.lastError = null;
      
      this.startProbeFlush();
      return { ok: true };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.stopProbeFlush(); 
      return { ok: false, error: this.lastError };
    }
  }

  
  async stop(): Promise<void> {
    if (!this.app) { return; }
    const app = this.app;
    this.app = null;
    
    this.stopProbeFlush();
    try {
      await app.close();
    } catch {
      
    }
  }

  



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

  
  async removeToken(key: string): Promise<{ ok: boolean; restarted: boolean; error?: string }> {
    const cfg = readLlmGatewayConfig();
    if (!cfg.tokens.some((t) => t.key === key)) { return { ok: false, restarted: false, error: "令牌不存在" }; }
    const res = await this.persistTokens((c) => {
      const tokens = this.ensureWritable(c.tokens.filter((t) => t.key !== key));
      return { ...c, tokens };
    });
    return { ok: res.ok, restarted: res.restarted, error: res.error };
  }

  
  async toggleToken(key: string, active: boolean): Promise<{ ok: boolean; token?: TokenDef; restarted: boolean; error?: string }> {
    const res = await this.updateToken({ key, active });
    if (!res.ok) { return res; }
    const token = readLlmGatewayConfig().tokens.find((t) => t.key === key);
    return { ok: true, token, restarted: res.restarted };
  }

  
  listTokens(): TokenDef[] {
    return readLlmGatewayConfig().tokens;
  }

  
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

  
  private resolveAuthToken(): string {
    try {
      return decryptRaw("config/auth_token.enc") ?? "";
    } catch {
      return "";
    }
  }
}


let managerSingleton: LlmGatewayManager | null = null;
export function getLlmGatewayManager(): LlmGatewayManager {
  if (!managerSingleton) { managerSingleton = new LlmGatewayManager(); }
  return managerSingleton;
}
