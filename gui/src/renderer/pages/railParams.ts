













export interface RailParams {
  
  lam0: number;
  lam1: number;
  
  amp: number;
  
  k: number;
  
  a: number;
  
  bulge: number;
  
  dip: number;
  
  grow: number;
  
  sig: number;
  
  tap: number;
  
  efloor: number;
  
  spd: number;
  
  damp: number;
  
  w: number;
  
  pause: boolean;
  
  read: boolean;
  
  flip: boolean;
}


export const DEFAULT_WAVE_PARAMS: RailParams = {
  lam0: 46, lam1: 53, amp: 55, k: 1, a: 4,
  bulge: 280, dip: 110, grow: 55, sig: 13,
  tap: 90, efloor: 0.12,
  spd: 1, damp: 0.22, w: 12,
  pause: true, read: true, flip: false,
};


export const DEFAULT_TICKS_PARAMS: RailParams = {
  ...DEFAULT_WAVE_PARAMS,
  dip: 0,          
  grow: 55,
};

export type RailMode = "wave" | "ticks";

const KEY: Record<RailMode, string> = {
  wave: "slime_rail_params_chat",
  ticks: "slime_rail_params_md",
};

export const RAIL_PARAMS_EVENT = "slime:rail-params";

const NUM_RANGES: Record<string, [number, number]> = {
  lam0: [8, 400], lam1: [8, 400], amp: [0, 100], k: [0, 3], a: [1, 8],
  bulge: [0, 400], dip: [0, 200], grow: [0, 200], sig: [4, 120],
  tap: [0, 400], efloor: [0, 0.9], spd: [0, 4], damp: [0.02, 1], w: [6, 32],
};


export function normalizeRailParams(input: unknown, base: RailParams): RailParams {
  const out: RailParams = { ...base };
  if (!input || typeof input !== "object") { return out; }
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(base) as Array<keyof RailParams>) {
    const v = src[key];
    if (typeof v === "boolean") {
      if (typeof base[key] === "boolean") { (out as unknown as Record<string, unknown>)[key] = v; }
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      const r = NUM_RANGES[key as string];
      (out as unknown as Record<string, unknown>)[key] = r ? Math.min(r[1], Math.max(r[0], v)) : v;
    }
  }
  return out;
}

export function defaultRailParams(mode: RailMode): RailParams {
  return mode === "ticks" ? { ...DEFAULT_TICKS_PARAMS } : { ...DEFAULT_WAVE_PARAMS };
}


export function loadRailParams(mode: RailMode): RailParams {
  const base = defaultRailParams(mode);
  try {
    const raw = localStorage.getItem(KEY[mode]);
    if (!raw) { return base; }
    return normalizeRailParams(JSON.parse(raw), base);
  } catch {
    return base;
  }
}


export function saveRailParams(mode: RailMode, patch: Partial<RailParams>): RailParams {
  const next = normalizeRailParams({ ...loadRailParams(mode), ...patch }, defaultRailParams(mode));
  try { localStorage.setItem(KEY[mode], JSON.stringify(next)); } catch {  }
  try { window.dispatchEvent(new CustomEvent(RAIL_PARAMS_EVENT, { detail: { mode, params: next } })); } catch {  }
  return next;
}


export function onRailParams(cb: (mode: RailMode, params: RailParams) => void): () => void {
  const h = (e: Event): void => {
    const d = (e as CustomEvent<{ mode?: RailMode }>).detail;
    if (!d || !d.mode) { return; }
    cb(d.mode, loadRailParams(d.mode));
  };
  window.addEventListener(RAIL_PARAMS_EVENT, h);
  return () => { window.removeEventListener(RAIL_PARAMS_EVENT, h); };
}










export function tickPositions(n: number, top: number, bot: number): number[] {
  if (n <= 0) { return []; }
  if (n === 1) { return [(top + bot) / 2]; }
  const out: number[] = [];
  for (let i = 0; i < n; i++) { out.push(top + ((bot - top) * i) / (n - 1)); }
  return out;
}
