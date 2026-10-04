


































import { resolveDeclaredRpm } from "shared/model-capabilities";


export const RPM_WINDOW_MS = 60_000;


export const DEFAULT_429_COOLDOWN_S = 20;






export const WINDOW_EPSILON_MS = 250;


export type RpmSource = "observed" | "manual" | "declared" | "unknown";

export interface RpmResolution {
  
  rpm: number | null;
  source: RpmSource;
}


function usableRpm(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1;
}











export interface RpmSources {
  
  observed?: number | null;
  
  manual?: number | null;
  
  declared?: number | null;
}














export function resolveRpm(sources: RpmSources): RpmResolution {
  const { observed, manual, declared } = sources ?? {};
  if (usableRpm(observed)) { return { rpm: observed, source: "observed" }; }
  if (usableRpm(manual)) { return { rpm: manual, source: "manual" }; }
  if (usableRpm(declared)) { return { rpm: declared, source: "declared" }; }
  return { rpm: null, source: "unknown" };
}

export interface RateLimitHeaders {
  limitRequests?: number;
  remainingRequests?: number;
  
  retryAfterS?: number;
  



  windowS?: number;
}













export function parseRateLimitHeaders(
  get: (name: string) => string | null | undefined,
  nowMs: number = Date.now(),
): RateLimitHeaders {
  const out: RateLimitHeaders = {};
  const num = (name: string): number | undefined => {
    const raw = get(name);
    if (raw === null || raw === undefined) { return undefined; }
    const n = Number(String(raw).trim());
    return Number.isFinite(n) ? n : undefined;
  };

  
  const direct = num("x-ratelimit-limit-requests") ?? num("x-ratelimit-limit");
  const draftRaw = get("ratelimit-limit");
  if (direct !== undefined && direct >= 0) {
    out.limitRequests = direct;
  } else if (draftRaw) {
    
    const m = /^\s*(\d+)\s*(?:;\s*w\s*=\s*(\d+))?\s*$/i.exec(String(draftRaw));
    if (m) {
      out.limitRequests = Number(m[1]);
      if (m[2] !== undefined) { out.windowS = Number(m[2]); }
    }
  } else {
    const w = /(?:^|;)\s*w\s*=\s*(\d+)/i.exec(String(get("ratelimit-limit") ?? ""));
    if (w) { out.windowS = Number(w[1]); }
  }

  
  const rem = num("x-ratelimit-remaining-requests") ?? num("ratelimit-remaining");
  if (rem !== undefined && rem >= 0) { out.remainingRequests = rem; }

  
  const ra = get("retry-after");
  if (ra !== null && ra !== undefined && String(ra).trim() !== "") {
    const s = String(ra).trim();
    const secs = Number(s);
    if (Number.isFinite(secs) && secs >= 0) {
      out.retryAfterS = Math.ceil(secs);
    } else {
      const t = Date.parse(s);
      if (Number.isFinite(t)) { out.retryAfterS = Math.max(0, Math.ceil((t - nowMs) / 1000)); }
    }
  }
  return out;
}


export function rpmFromHeaders(h: RateLimitHeaders): number | undefined {
  if (h.limitRequests === undefined) { return undefined; }
  if (h.windowS !== undefined && h.windowS !== 60) { return undefined; }
  return usableRpm(h.limitRequests) ? h.limitRequests : undefined;
}

export interface AcquirePlan {
  
  waitMs: number;
  
  keep: number[];
}











export function planAcquire(
  now: number,
  hits: readonly number[],
  rpm: number,
  windowMs: number = RPM_WINDOW_MS,
): AcquirePlan {
  const fresh = hits.filter((t) => Number.isFinite(t) && now - t < windowMs);
  if (!usableRpm(rpm)) { return { waitMs: 0, keep: fresh }; }
  if (fresh.length < rpm) { return { waitMs: 0, keep: [...fresh, now] }; }
  const earliest = fresh[0];
  const waitMs = earliest + windowMs + WINDOW_EPSILON_MS - now;
  return { waitMs: waitMs > 0 ? waitMs : 0, keep: fresh };
}


export interface LimiterClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface KeyState {
  
  hits: number[];
  
  observedRpm: number | null;
  
  cooldownUntil?: number;
}


const MAX_HITS_PER_KEY = 512;








export class RpmLimiter {
  private readonly clock: LimiterClock;
  private readonly windowMs: number;
  private readonly states = new Map<string, KeyState>();
  
  private readonly declaredOf: (model: string | undefined) => number | null | undefined;
  
  private manualOf: (key: string, model: string | undefined) => number | null | undefined;

  constructor(opts: {
    clock?: LimiterClock;
    windowMs?: number;
    declaredOf?: (model: string | undefined) => number | null | undefined;
    
    manualOf?: (key: string, model: string | undefined) => number | null | undefined;
  } = {}) {
    this.clock = opts.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    this.windowMs = opts.windowMs ?? RPM_WINDOW_MS;
    
    
    this.declaredOf = opts.declaredOf ?? ((model) => (model ? resolveDeclaredRpm(model)?.rpm ?? null : null));
    
    
    this.manualOf = opts.manualOf ?? (() => null);
  }

  






  setManualRpmOf(fn: (key: string, model: string | undefined) => number | null | undefined): void {
    this.manualOf = fn;
  }

  private state(key: string): KeyState {
    let s = this.states.get(key);
    if (!s) { s = { hits: [], observedRpm: null }; this.states.set(key, s); }
    return s;
  }

  
  resolve(key: string, model?: string): RpmResolution {
    let manual: number | null | undefined;
    try {
      manual = this.manualOf(key, model);
    } catch {
      
      manual = null;
    }
    
    
    return resolveRpm({
      observed: this.state(key).observedRpm,
      manual,
      declared: this.declaredOf(model),
    });
  }

  








  async acquire(
    key: string,
    model?: string,
    onWait?: (waitMs: number, totalMs: number) => void,
  ): Promise<{ waitedMs: number; source: RpmSource }> {
    const s = this.state(key);
    let waited = 0;
    const notify = (ms: number): void => {
      if (!onWait) { return; }
      try { onWait(ms, waited + ms); } catch {  }
    };
    for (;;) {
      const now = this.clock.now();
      
      if (s.cooldownUntil !== undefined && now < s.cooldownUntil) {
        const ms = s.cooldownUntil - now;
        notify(ms);                       
        await this.clock.sleep(ms);
        waited += ms;
        continue;
      }
      if (s.cooldownUntil !== undefined && now >= s.cooldownUntil) { s.cooldownUntil = undefined; }
      const { rpm, source } = this.resolve(key, model);
      if (rpm === null) { return { waitedMs: waited, source }; }   
      const plan = planAcquire(now, s.hits, rpm, this.windowMs);
      if (plan.waitMs <= 0) {
        s.hits = plan.keep.length > MAX_HITS_PER_KEY ? plan.keep.slice(-MAX_HITS_PER_KEY) : plan.keep;
        return { waitedMs: waited, source };
      }
      notify(plan.waitMs);                
      await this.clock.sleep(plan.waitMs);
      waited += plan.waitMs;
    }
  }

  




  observe(key: string, headers: RateLimitHeaders, status?: number, nowMs?: number): void {
    const s = this.state(key);
    const at = nowMs ?? this.clock.now();
    const rpm = rpmFromHeaders(headers);
    if (rpm !== undefined) { s.observedRpm = rpm; }
    if (status === 429) {
      const secs = headers.retryAfterS !== undefined && headers.retryAfterS >= 0
        ? headers.retryAfterS
        : DEFAULT_429_COOLDOWN_S;
      const until = at + secs * 1000;
      
      s.cooldownUntil = s.cooldownUntil === undefined ? until : Math.max(s.cooldownUntil, until);
    }
  }

  
  reset(key?: string): void {
    if (key === undefined) { this.states.clear(); } else { this.states.delete(key); }
  }

  
  snapshot(): Array<{ key: string; observedRpm: number | null; windowUsed: number; cooling: boolean }> {
    const now = this.clock.now();
    return [...this.states.entries()].map(([key, s]) => ({
      key,
      observedRpm: s.observedRpm,
      windowUsed: s.hits.filter((t) => now - t < this.windowMs).length,
      cooling: s.cooldownUntil !== undefined && now < s.cooldownUntil,
    }));
  }
}

let shared: RpmLimiter | null = null;


export function getSharedRpmLimiter(): RpmLimiter {
  if (!shared) { shared = new RpmLimiter(); }
  return shared;
}

export function setSharedRpmLimiter(l: RpmLimiter | null): void {
  shared = l;
}
