
















import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimeStateDir } from "./dataRoot.js";
import type { SubAgentRunView } from "../shared/ipc.js";


export interface PersistedSubAgentRun {
  id: string;
  name: string;
  status: string;
  task?: string;
  timeoutMs?: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  model?: string;
  definitionName?: string;
  structured?: { status: string; summary: string; artifacts: string[]; confidence: number };
}


const TERMINAL = new Set(["done", "fail", "timeout", "cancelled"]);







const VIEW_STATUS = new Set(["pending", "running", "done", "fail", "timeout", "cancelled"]);
function viewStatus(s: unknown): "pending" | "running" | "done" | "fail" | "timeout" | "cancelled" {
  return typeof s === "string" && VIEW_STATUS.has(s)
    ? (s as "pending" | "running" | "done" | "fail" | "timeout" | "cancelled")
    : "fail";
}


export const SUBAGENT_RUN_CAP = 100;

const RESULT_CAP = 8000;

const TASK_CAP = 2000;

function runsPath(): string {
  return join(runtimeStateDir(), "subagent-runs.json");
}


export function loadSubagentRuns(): PersistedSubAgentRun[] {
  try {
    const p = runsPath();
    if (!existsSync(p)) { return []; }
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(raw)) { return []; }
    return raw.filter((r): r is PersistedSubAgentRun =>
      !!r && typeof r === "object" && typeof (r as PersistedSubAgentRun).id === "string");
  } catch {
    return [];
  }
}


function writeAtomic(list: PersistedSubAgentRun[]): void {
  try {
    const p = runsPath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
    renameSync(tmp, p);
  } catch {
    
  }
}

function snapshot(r: PersistedSubAgentRun): PersistedSubAgentRun {
  const out: PersistedSubAgentRun = { id: r.id, name: r.name, status: r.status };
  if (typeof r.task === "string" && r.task) { out.task = r.task.slice(0, TASK_CAP); }
  if (typeof r.timeoutMs === "number" && r.timeoutMs > 0) { out.timeoutMs = r.timeoutMs; }
  if (typeof r.startedAt === "number") { out.startedAt = r.startedAt; }
  if (typeof r.finishedAt === "number") { out.finishedAt = r.finishedAt; }
  if (typeof r.result === "string" && r.result) { out.result = r.result.slice(0, RESULT_CAP); }
  if (typeof r.error === "string" && r.error) { out.error = r.error; }
  if (typeof r.model === "string" && r.model) { out.model = r.model; }
  if (typeof r.definitionName === "string" && r.definitionName) { out.definitionName = r.definitionName; }
  if (r.structured) { out.structured = r.structured; }
  return out;
}





export function syncSubagentRuns(live: readonly PersistedSubAgentRun[]): number {
  const persisted = loadSubagentRuns();
  const have = new Set(persisted.map((p) => `${p.id}:${p.status}`));
  let added = 0;
  for (const r of live) {
    if (!r || typeof r.id !== "string" || !TERMINAL.has(r.status)) { continue; }
    const key = `${r.id}:${r.status}`;
    if (have.has(key)) { continue; }
    have.add(key);
    persisted.push(snapshot(r));
    added++;
  }
  if (added > 0) { writeAtomic(persisted.slice(-SUBAGENT_RUN_CAP)); }
  return added;
}





export function mergedSubagentRuns(live: readonly PersistedSubAgentRun[]): SubAgentRunView[] {
  const byId = new Map<string, PersistedSubAgentRun>();
  for (const p of loadSubagentRuns()) { byId.set(p.id, p); }
  for (const r of live) {
    if (!r || typeof r.id !== "string") { continue; }
    byId.set(r.id, { ...byId.get(r.id), ...snapshot(r) });
  }
  const all = [...byId.values()];
  all.sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER));
  
  return all.slice(-SUBAGENT_RUN_CAP).map((r) => ({ ...r, status: viewStatus(r.status) }));
}


export function clearSubagentRuns(): number {
  const n = loadSubagentRuns().length;
  writeAtomic([]);
  return n;
}
