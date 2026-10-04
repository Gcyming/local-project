































import { randomUUID } from "node:crypto";









export interface SubAgentResult {
  status: "completed" | "partial" | "failed";
  summary: string;
  artifacts: string[];
  confidence: number;
}


export interface SubAgentDef {
  id?: string;
  
  name: string;
  
  task: string;
  
  systemPrompt?: string;
  
  agentId?: string;
  
  toolsOnly?: string[];
  




  model?: string;
  

  networkEnabled?: boolean;
  
  maxTurns?: number;
  
  timeoutMs?: number;
  
  outputSchema?: boolean;
  













  adhoc?: boolean;
}





export interface SubagentDefinition {
  
  name: string;
  
  description: string;
  
  systemPrompt?: string;
  
  agentId?: string;
  
  model?: string;
  
  toolsOnly?: string[];
  
  maxTurns?: number;
  
  timeoutMs?: number;
  
  outputSchema?: boolean;
  



  userSelected?: boolean;
}

export type SubAgentStatus =
  | "pending"
  | "running"
  | "done"
  | "fail"
  | "timeout"
  | "cancelled";

export interface SubAgentRun {
  id: string;
  name: string;
  status: SubAgentStatus;
  startedAt?: number;
  finishedAt?: number;
  






  task?: string;
  



  timeoutMs?: number;
  



  result?: string;
  
  structured?: SubAgentResult;
  error?: string;
  
  definitionName?: string;
  
  model?: string;
}


export interface SubAgentRunContext {
  signal: AbortSignal;
  
  networkEnabled?: boolean;
}





export type SubAgentRunner = (
  def: SubAgentDef,
  ctx?: SubAgentRunContext,
) => Promise<string>;





export interface SubAgentHooks {
  








  onSpawn?: (run: SubAgentRun, def: SubAgentDef) => void | Promise<void>;
  
  onStart?: (run: SubAgentRun, def: SubAgentDef) => void | Promise<void>;
  
  onComplete?: (run: SubAgentRun, def: SubAgentDef) => void | Promise<void>;
  
  onError?: (run: SubAgentRun, def: SubAgentDef) => void | Promise<void>;
}


















export const DEFAULT_EXEC_BUDGET_MS = 900_000;










export const SUBAGENT_MODEL_POOL_MAX = 12;













export const SUBAGENT_SESSION_PREFIX = "__subagent__:";


export function isSubagentSessionId(sid: unknown): boolean {
  return typeof sid === "string" && sid.startsWith(SUBAGENT_SESSION_PREFIX);
}


export function normalizeModelPool(input: unknown): string[] {
  if (!Array.isArray(input)) { return []; }
  const out: string[] = [];
  for (const x of input) {
    const v = typeof x === "string" ? x.trim() : "";
    if (!v || v === "inherit") { continue; }
    if (out.includes(v)) { continue; }
    out.push(v);
    if (out.length >= SUBAGENT_MODEL_POOL_MAX) { break; }
  }
  return out;
}
















export function sanitizeSubagentRunName(raw: string): string {
  const cleaned = (raw ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\.\.+/g, "_")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned.slice(0, 64) || "unnamed";
}

const STRUCTURED_INSTRUCTION =
  "请在最终回复末尾输出一个 JSON 代码块，形如 ```json {\"status\":\"completed|partial|failed\",\"summary\":\"...\",\"artifacts\":[\"...\"],\"confidence\":0.0} ```";


export function parseStructuredResult(text: string): SubAgentResult | null {
  if (!text) { return null; }
  
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fence?.[1]) { candidates.push(fence[1]); }
  
  const lastBrace = text.lastIndexOf("{");
  const lastClose = text.lastIndexOf("}");
  if (lastBrace >= 0 && lastClose > lastBrace) {
    candidates.push(text.slice(lastBrace, lastClose + 1));
  }
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Partial<SubAgentResult>;
      if (obj && typeof obj === "object" && (obj.summary || obj.status)) {
        return normalizeStructured(obj);
      }
    } catch {
      
    }
  }
  return null;
}

function normalizeStructured(obj: Partial<SubAgentResult>): SubAgentResult {
  const statusRaw = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  const status: SubAgentResult["status"] =
    statusRaw === "completed" || statusRaw === "partial" || statusRaw === "failed"
      ? (statusRaw as SubAgentResult["status"])
      : "completed";
  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.min(1, Math.max(0, obj.confidence))
      : 0.5;
  return {
    status,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    artifacts: Array.isArray(obj.artifacts)
      ? obj.artifacts.filter((a): a is string => typeof a === "string")
      : [],
    confidence,
  };
}





function isTerminal(s: SubAgentStatus): boolean {
  return s === "done" || s === "fail" || s === "timeout" || s === "cancelled";
}

export class SubAgentManager {
  private runner: SubAgentRunner;
  private hooks: SubAgentHooks;
  private runs = new Map<string, SubAgentRun>();
  private controllers = new Map<string, AbortController>();
  private defs = new Map<string, SubagentDefinition>();
  
  private cancelRequested = new Set<string>();
  
  private active = 0;
  
  private inflight = 0;
  private readonly maxConcurrency: number;
  











  private defaultModels: string[];
  
  private slotWaiters: Array<() => void> = [];
  
  private idleWaiters: Array<() => void> = [];
  
  private completionWaiters = new Map<string, Array<() => void>>();

  constructor(
    runner: SubAgentRunner,
    opts: { concurrency?: number; hooks?: SubAgentHooks; defaultModel?: string; defaultModels?: string[] } = {},
  ) {
    this.runner = runner;
    this.hooks = opts.hooks ?? {};
    this.maxConcurrency = Math.max(1, opts.concurrency ?? 3);
    
    this.defaultModels = normalizeModelPool(opts.defaultModels ?? (opts.defaultModel ? [opts.defaultModel] : []));
  }

  
  get activeCount(): number {
    return this.active;
  }

  
  
  

  
  register(def: SubagentDefinition): void {
    this.defs.set(def.name, def);
  }

  
  unregister(name: string): boolean {
    return this.defs.delete(name);
  }

  









  setUserSelected(defs: SubagentDefinition[]): void {
    for (const [name, def] of this.defs.entries()) {
      if (def.userSelected) { this.defs.delete(name); }
    }
    for (const d of defs) {
      this.defs.set(d.name, { ...d, userSelected: true });
    }
  }

  
  listUserSelected(): SubagentDefinition[] {
    return [...this.defs.values()].filter((d) => d.userSelected).map((d) => ({ ...d }));
  }

  




  setDefaultModels(models: unknown): void {
    this.defaultModels = normalizeModelPool(models);
  }

  
  setDefaultModel(model: string): void {
    this.setDefaultModels(model ? [model] : []);
  }

  
  getDefaultModels(): string[] {
    return [...this.defaultModels];
  }

  
  getDefaultModel(): string {
    return this.defaultModels[0] ?? "";
  }

  
  listDefinitions(): SubagentDefinition[] {
    return [...this.defs.values()].map((d) => ({ ...d }));
  }

  








  catalog(): Array<{ name: string; description: string; source: "user" | "builtin"; model?: string }> {
    return [...this.defs.values()].map((d) => ({
      name: d.name,
      description: d.description,
      source: d.userSelected ? ("user" as const) : ("builtin" as const),
      ...(d.model && d.model !== "inherit" ? { model: d.model } : {}),
    }));
  }

  




  findByName(name: string): SubagentDefinition | null {
    const q = (name ?? "").trim().toLowerCase();
    if (!q) { return null; }
    const all = [...this.defs.values()];
    const exact = all.find((d) => d.name.toLowerCase() === q);
    if (exact) { return { ...exact }; }
    const loose = all.find((d) => {
      const n = d.name.toLowerCase();
      return n.includes(q) || q.includes(n);
    });
    return loose ? { ...loose } : null;
  }

  






  matchDefinition(task: string): SubagentDefinition | null {
    let bestUser: { def: SubagentDefinition; score: number } | null = null;
    let bestBuiltin: { def: SubagentDefinition; score: number } | null = null;
    for (const def of this.defs.values()) {
      const score = overlapScore(task, def.description);
      if (score <= 0) { continue; }
      if (def.userSelected) {
        if (!bestUser || score > bestUser.score) { bestUser = { def, score }; }
      } else if (!bestBuiltin || score > bestBuiltin.score) {
        bestBuiltin = { def, score };
      }
    }
    
    const best = bestUser ?? bestBuiltin;
    return best ? { ...best.def } : null;
  }

  









  delegate(task: string, overrides: Partial<SubAgentDef> & { agent?: string } = {}): SubAgentRun | null {
    
    
    
    
    const adhoc = overrides.adhoc === true
      && (!!overrides.systemPrompt?.trim() || (overrides.toolsOnly?.length ?? 0) > 0);
    if (!adhoc) {
      const wanted = (overrides.agent ?? "").trim();
      if (wanted) {
        const named = this.findByName(wanted);
        if (!named) { return null; } 
        return this.spawnFromDef(named, task, overrides);
      }
      const def = this.matchDefinition(task);
      if (def) { return this.spawnFromDef(def, task, overrides); }
    }
    
    
    
    const autoName = `${adhoc ? "临时代理" : "通用助手"}（${task.slice(0, 12).replace(/\s+/g, " ").trim()}）`;
    return this.spawn({
      name: overrides.name ?? autoName,
      task,
      systemPrompt: overrides.systemPrompt ?? "你是通用任务执行助手，独立完成指派任务并返回简洁摘要。",
      
      ...(adhoc ? { adhoc: true } : {}),
      agentId: overrides.agentId,
      toolsOnly: overrides.toolsOnly,
      model: overrides.model,
      maxTurns: overrides.maxTurns,
      
      
      
      
      
      
      
      timeoutMs: overrides.timeoutMs ?? DEFAULT_EXEC_BUDGET_MS,
      outputSchema: overrides.outputSchema,
      
      networkEnabled: overrides.networkEnabled,
    });
  }

  
  private spawnFromDef(def: SubagentDefinition, task: string, overrides: Partial<SubAgentDef>): SubAgentRun {
    return this.spawn({
      name: overrides.name ?? def.name,
      task,
      systemPrompt: overrides.systemPrompt ?? def.systemPrompt,
      agentId: overrides.agentId ?? def.agentId,
      toolsOnly: overrides.toolsOnly ?? def.toolsOnly,
      model: overrides.model ?? def.model,
      maxTurns: overrides.maxTurns ?? def.maxTurns,
      timeoutMs: overrides.timeoutMs ?? def.timeoutMs,
      outputSchema: overrides.outputSchema ?? def.outputSchema,
      
      
      
      
      networkEnabled: overrides.networkEnabled,
    });
  }

  
  
  

  

  spawn(def: SubAgentDef): SubAgentRun {
    
    
    
    
    
    const raw = (def.model ?? "").trim();
    const fallbackTier = this.defaultModels[0] ?? "";
    const effectiveModel = (!raw || raw === "inherit") ? fallbackTier : raw;
    const run: SubAgentRun = {
      id: def.id ?? randomUUID(),
      name: def.name,
      status: "pending",
      task: def.task,
      ...(def.timeoutMs && def.timeoutMs > 0 ? { timeoutMs: def.timeoutMs } : {}),
    };
    run.model = effectiveModel;
    
    
    if (!def.adhoc && this.defs.has(def.name)) {
      run.definitionName = def.name;
    }
    this.runs.set(run.id, run);
    
    
    
    void this.fireHook(this.hooks.onSpawn, run, def);
    void this.execute(run, effectiveModel ? { ...def, model: effectiveModel } : def);
    return run;
  }

  status(id: string): SubAgentRun | undefined {
    const r = this.runs.get(id);
    return r
      ? { ...r, structured: r.structured ? { ...r.structured } : undefined }
      : undefined;
  }

  
  list(): SubAgentRun[] {
    return [...this.runs.values()].map((r) => ({
      ...r,
      structured: r.structured ? { ...r.structured } : undefined,
    }));
  }

  






  forgetTerminal(): number {
    let n = 0;
    for (const [id, run] of this.runs) {
      if (isTerminal(run.status)) {
        this.runs.delete(id);
        n++;
      }
    }
    return n;
  }

  











  async wait(id: string, timeoutMs = 300_000, signal?: AbortSignal): Promise<SubAgentRun | undefined> {
    const existing = this.runs.get(id);
    if (!existing) { return undefined; }
    if (isTerminal(existing.status)) { return this.status(id); }
    
    if (signal?.aborted) { return this.status(id); }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (settled) { return; }
        settled = true;
        if (timer !== undefined) { clearTimeout(timer); }
        
        signal?.removeEventListener("abort", done);
        resolve();
      };
      timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      const waiters = this.completionWaiters.get(id) ?? [];
      waiters.push(done);
      this.completionWaiters.set(id, waiters);
    });
    return this.status(id);
  }

  





  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || isTerminal(run.status)) { return false; }
    this.cancelRequested.add(id);
    this.controllers.get(id)?.abort();
    if (run.status === "pending") {
      run.status = "cancelled";
      run.error = "已被取消（未开始执行）";
      run.finishedAt = Date.now();
      this.notifyCompletion(id);
    }
    return true;
  }

  
  async awaitIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const remaining = Math.max(1, deadline - Date.now());
        const timer = setTimeout(() => resolve(), Math.min(50, remaining));
        this.idleWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  
  
  

  private acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrency) { return Promise.resolve(); }
    return new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
    });
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) { next(); }
  }

  
  private notifyCompletion(id: string): void {
    const waiters = this.completionWaiters.get(id);
    if (waiters) {
      this.completionWaiters.delete(id);
      for (const w of waiters) { w(); }
    }
  }

  
  private async fireHook(
    fn: ((run: SubAgentRun, def: SubAgentDef) => void | Promise<void>) | undefined,
    run: SubAgentRun,
    def: SubAgentDef,
  ): Promise<void> {
    if (!fn) { return; }
    try {
      await fn(run, def);
    } catch {
      
    }
  }

  






  






  private timeoutMessage(timeoutMs: number, run: SubAgentRun, reason: unknown): string {
    const elapsed = run.startedAt ? Math.round((Date.now() - run.startedAt) / 1000) : 0;
    const kept = (run.result ?? "").length;
    const why = typeof reason === "string" && reason ? `（${reason}）` : "";
    return `执行超时：预算 ${Math.round(timeoutMs / 1000)}s 用尽，实跑 ${elapsed}s${why}；`
      + (kept > 0
        ? `已保住中断前产出 ${kept} 字（见 run.result）`
        : `中断前无完整产出 —— 该任务需要更长预算，或应拆成更小的子任务`);
  }

  private keepPartial(run: SubAgentRun, reply: string | undefined, def: SubAgentDef): void {
    const text = (reply ?? "").trim();
    if (!text) { return; }
    if (!run.result) { run.result = text; }
    if (def.outputSchema && !run.structured) {
      run.structured = parseStructuredResult(text) ?? undefined;
    }
  }

  private async execute(run: SubAgentRun, def: SubAgentDef): Promise<void> {
    this.inflight++;
    try {
      
      if (run.status === "cancelled") { this.notifyCompletion(run.id); return; }
      
      while (this.active >= this.maxConcurrency) {
        await this.acquireSlot();
        if (run.status === ("cancelled" as SubAgentStatus)) {
          
          this.releaseSlot();
          this.notifyCompletion(run.id);
          return;
        }
      }
      
      if (run.status === ("cancelled" as SubAgentStatus)) {
        this.releaseSlot();
        this.notifyCompletion(run.id);
        return;
      }

      this.active++;
      run.status = "running";
      run.startedAt = Date.now();

      
      const controller = new AbortController();
      this.controllers.set(run.id, controller);
      const timeoutMs = def.timeoutMs ?? 0;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : null;
      const wasCancelled = (): boolean => this.cancelRequested.has(run.id);
      
      const classifyAbort = (): "cancelled" | "timeout" =>
        wasCancelled() || timeoutMs === 0 ? "cancelled" : "timeout";

      
      const effectiveDef: SubAgentDef =
        def.outputSchema && !def.task.includes(STRUCTURED_INSTRUCTION)
          ? { ...def, id: run.id, task: `${def.task}\n\n${STRUCTURED_INSTRUCTION}` }
          : { ...def, id: run.id };

      let terminal: "done" | "fail" | "timeout" | "cancelled" = "done";
      try {
        await this.fireHook(this.hooks.onStart, run, effectiveDef);
        
        
        const reply = await this.runner(effectiveDef, { signal: controller.signal, networkEnabled: effectiveDef.networkEnabled });
        if (controller.signal.aborted) {
          terminal = classifyAbort();
          run.error =
            terminal === "timeout"
              ? this.timeoutMessage(timeoutMs, run, controller.signal.reason)
              : "已被取消";
          
          
          
          this.keepPartial(run, reply, effectiveDef);
        } else {
          run.result = reply;
          if (effectiveDef.outputSchema) {
            run.structured = parseStructuredResult(reply) ?? undefined;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (controller.signal.aborted) {
          terminal = classifyAbort();
          run.error =
            terminal === "timeout"
              ? this.timeoutMessage(timeoutMs, run, msg)
              : msg || "已被取消";
        } else {
          terminal = "fail";
          run.error = msg;
        }
      } finally {
        run.status = terminal;
        run.finishedAt = Date.now();
        if (timer) { clearTimeout(timer); }
        this.controllers.delete(run.id);
        this.cancelRequested.delete(run.id);
        this.active--;
        this.releaseSlot();
        if (terminal === "done") {
          await this.fireHook(this.hooks.onComplete, run, effectiveDef);
        } else {
          await this.fireHook(this.hooks.onError, run, effectiveDef);
        }
        this.notifyCompletion(run.id);
      }
    } finally {
      
      this.inflight--;
      if (this.inflight === 0 && this.idleWaiters.length > 0) {
        const all = this.idleWaiters.splice(0);
        for (const w of all) { w(); }
      }
    }
  }
}





function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length > 1) { tokens.add(m[0]); }
  }
  
  const cjk = lower.match(/[一-鿿]+/g) ?? [];
  for (const seg of cjk) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      tokens.add(seg.slice(i, i + 2));
    }
  }
  return tokens;
}


export function overlapScore(task: string, description: string): number {
  const a = tokenize(task);
  const b = tokenize(description);
  if (a.size === 0 || b.size === 0) { return 0; }
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) { inter++; }
  }
  if (inter === 0) { return 0; }
  const union = a.size + b.size - inter;
  return inter / union;
}
