




















import { readLocalCapability, type LocalServerCapability } from "./model_introspect.js";





export const PROBE_TIMEOUT_MS = 600;


export function stripApiSuffix(base: string): string {
  return (base ?? "").trim().replace(/\/+$/, "").replace(/\/(api\/)?v\d+$/, "");
}


export function propsUrlFor(base: string): string {
  return `${stripApiSuffix(base)}/props`;
}

export function modelsUrlFor(base: string): string {
  return `${stripApiSuffix(base)}/v1/models`;
}



export async function getJson(url: string, timeoutMs: number): Promise<{ status: number | null; body: unknown }> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    let body: unknown;
    try { body = await resp.json(); } catch { body = undefined; }
    return { status: resp.status, body };
  } catch {
    
    return { status: null, body: undefined };
  }
}












export async function probeLocalProps(base: string, opts: { timeoutMs?: number } = {}): Promise<LocalServerCapability> {
  const r = await getJson(propsUrlFor(base), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  return readLocalCapability({ props: r.body, propsStatus: r.status });
}


export async function probeLocalEndpoint(base: string, opts: { timeoutMs?: number; alias?: string } = {}): Promise<LocalServerCapability> {
  const timeout = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const [props, models] = await Promise.all([
    getJson(propsUrlFor(base), timeout),
    getJson(modelsUrlFor(base), timeout),
  ]);
  return readLocalCapability({
    props: props.body,
    propsStatus: props.status,
    models: models.body,
    modelsStatus: models.status,
    alias: opts.alias,
  });
}
