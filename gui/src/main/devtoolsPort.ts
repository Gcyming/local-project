











































import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";


export const DEVTOOLS_PORT_ENV = "SLIME_DEVTOOLS_PORT";

export const DEVTOOLS_PORT_DEFAULT = 9222;

export const DEVTOOLS_PORT_SCAN = 20;

export const DEVTOOLS_PORT_FILE = "devtools-port.json";











export function parseListeningPorts(stdout: string, platform: NodeJS.Platform): Set<number> {
  const listening = platform === "win32" ? /\bLISTENING\b/i : /\bLISTEN\b/i;
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!listening.test(line)) { continue; }
    for (const m of line.matchAll(/:(\d{1,5})(?=\s|$|\))/g)) {
      const p = Number(m[1]);
      if (p >= 1 && p <= 65535) { ports.add(p); }
    }
  }
  return ports;
}






export function pickDevtoolsPort(
  preferred: number,
  listening: ReadonlySet<number>,
  scan: number = DEVTOOLS_PORT_SCAN,
): number {
  if (preferred === 0) { return 0; }
  if (!listening.has(preferred)) { return preferred; }
  for (let i = 1; i <= scan; i++) {
    const candidate = preferred + i;
    if (candidate > 65535) { break; }
    if (!listening.has(candidate)) { return candidate; }
  }
  return 0;
}

export interface DevtoolsPortDecision {
  
  port: number;
  
  preferred: number;
  
  explicit: boolean;
  
  reason: "free" | "shifted" | "ephemeral";
}






export function resolveDevtoolsPort(
  rawEnv: string | undefined,
  listening: ReadonlySet<number>,
  scan: number = DEVTOOLS_PORT_SCAN,
): DevtoolsPortDecision {
  let preferred = DEVTOOLS_PORT_DEFAULT;
  let explicit = false;
  if (typeof rawEnv === "string" && rawEnv.trim() !== "") {
    const n = Number(rawEnv.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 65535) {
      preferred = n;
      explicit = true;
    }
  }
  const port = pickDevtoolsPort(preferred, listening, scan);
  const reason: DevtoolsPortDecision["reason"] =
    port === 0 ? "ephemeral" : (port === preferred ? "free" : "shifted");
  return { port, preferred, explicit, reason };
}


export function listeningPortsCommand(platform: NodeJS.Platform): string {
  if (platform === "win32") { return "netstat -ano -p tcp"; }
  if (platform === "darwin") { return "lsof -nP -iTCP -sTCP:LISTEN"; }
  return "ss -ltn";
}





export function listeningPortsSync(platform: NodeJS.Platform = process.platform): Set<number> {
  try {
    const stdout = execSync(listeningPortsCommand(platform), {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseListeningPorts(stdout, platform);
  } catch {
    return new Set<number>();
  }
}





export function parseDevToolsActivePort(text: string): number | null {
  const first = text.split(/\r?\n/)[0]?.trim() ?? "";
  const n = Number(first);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}





export function writeDevtoolsPortFile(
  userDataDir: string,
  decision: DevtoolsPortDecision,
  actualPort: number | null = null,
): string | null {
  try {
    mkdirSync(userDataDir, { recursive: true });
    const file = join(userDataDir, DEVTOOLS_PORT_FILE);
    writeFileSync(file, JSON.stringify({
      port: actualPort ?? decision.port,
      requested: decision.port,
      preferred: decision.preferred,
      reason: decision.reason,
      explicit: decision.explicit,
      pid: process.pid,
      at: new Date().toISOString(),
    }, null, 2), "utf8");
    return file;
  } catch {
    return null;
  }
}


export function readDevtoolsPortFile(userDataDir: string): number | null {
  try {
    const raw = readFileSync(join(userDataDir, DEVTOOLS_PORT_FILE), "utf8");
    const parsed = JSON.parse(raw) as { port?: unknown };
    const n = Number(parsed.port);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}
