











export function readCssDurationMs(varName: string, fallbackMs: number): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallbackMs;
  }
  let raw = "";
  try {
    raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  } catch {
    return fallbackMs;
  }
  
  const m = /^([\d.]+)\s*(ms|s)?$/.exec(raw);
  if (!m) {
    return fallbackMs;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) {
    return fallbackMs;
  }
  return m[2] === "s" ? n * 1000 : n;
}


export function readCollapseDurMs(): number {
  return readCssDurationMs("--collapse-dur", 450);
}
