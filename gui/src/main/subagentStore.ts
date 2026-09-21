/**
 * gui/src/main/subagentStore.ts — 子代理运行记录落盘（A-980-R31）。
 *
 * 为什么必须落盘：`SubAgentManager.runs` 是**纯内存 Map**，进程一退全没。于是用户看到两件怪事：
 *   ① 明明跑过（而且失败过）子代理，重启后「后台任务」面板一片空白 → "怎么一个记录都没有"；
 *   ② 输入框上方监测栏的子代理按钮是 `runs.length === 0 → return null` → 按钮跟着消失 → "上拉列表呢？"
 * 两者同一个根因。记录必须持久化：**终态即写盘**（运行中不写，避免半截状态被当历史），启动时回灌。
 *
 * 设计取舍：
 * - 单文件 `data/subagent-runs.json`，数组、**旧在前新在后**（面板 reversed 展示 → 最近的在最上面）；
 * - 只落终态（done / fail / timeout / cancelled）+ 上限 100 条，防无限增长；
 * - **原子写**（tmp + rename）：写到一半崩溃/断电不会让文件变成非法 JSON 从而丢掉全部历史；
 * - result 截断到 RESULT_CAP 字符，完整产出仍在 `data/generated/subagent-*.md`。
 *
 * 与 core-ts 的分工：core-ts 的 `SubAgentRun` 是运行态真源；本模块只做「终态快照的持久化投影」，
 * 不反向驱动运行逻辑（避免装配层与核心服务互相依赖）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INSTALL_ROOT } from "./boot.js";
import type { SubAgentRunView } from "../shared/ipc.js";

/** 落盘快照：字段与 core-ts `SubAgentRun` 对齐（structured 一并存，面板要显示自评置信度/产物数） */
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

/** 终态集合（与 core-ts isTerminal 同口径；本模块不 import 以免装配层反向依赖核心内部实现） */
const TERMINAL = new Set(["done", "fail", "timeout", "cancelled"]);

/**
 * 落盘 `status` 是**自由字符串**（磁盘可能被手改 / 跨版本残留），而展示用的
 * `SubAgentRunView.status` 是 6 态字面量联合 —— 直接透传会让类型在骗人，
 * 渲染层就只能各自兜底（A-980-R31 的前科：「超时中断」被显示成原始英文 `timeout`）。
 * 收敛规则：认得出的原样用；认不出的按 **fail** 处理（不是 pending —— 那会假装它还在跑）。
 */
const VIEW_STATUS = new Set(["pending", "running", "done", "fail", "timeout", "cancelled"]);
function viewStatus(s: unknown): "pending" | "running" | "done" | "fail" | "timeout" | "cancelled" {
  return typeof s === "string" && VIEW_STATUS.has(s)
    ? (s as "pending" | "running" | "done" | "fail" | "timeout" | "cancelled")
    : "fail";
}

/** 保留条数上限 */
export const SUBAGENT_RUN_CAP = 100;
/** 单条 result 落盘长度上限（完整产出在 data/generated/subagent-*.md） */
const RESULT_CAP = 8000;
/** 单条 task 落盘长度上限（任务可能很长，只留够识别"这次让它干什么"） */
const TASK_CAP = 2000;

function runsPath(): string {
  return join(INSTALL_ROOT, "data", "subagent-runs.json");
}

/** 读取历史记录；文件缺失/损坏一律回落空数组（**绝不因为读不到历史而阻断功能**） */
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

/** 原子写：先写 .tmp 再 rename，避免半截文件把整个历史变成非法 JSON */
function writeAtomic(list: PersistedSubAgentRun[]): void {
  try {
    const p = runsPath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
    renameSync(tmp, p);
  } catch {
    /* 落盘失败不阻断子代理执行（记录丢失是遗憾，任务失败是事故） */
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

/**
 * 把**新到达终态**的运行写进历史（幂等：同 id + 同 status 只写一次，重复广播不会产生重复记录）。
 * 返回本次新增条数（0 = 无变化，不触发写盘）。
 */
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

/**
 * 合并「历史记录 + 当前内存运行态」为一份展示清单（按 startedAt 升序，未开始的排在最后）。
 * 同 id 以**内存态优先**——运行中的字段比落盘快照新（例如进行中的 pending→running）。
 */
export function mergedSubagentRuns(live: readonly PersistedSubAgentRun[]): SubAgentRunView[] {
  const byId = new Map<string, PersistedSubAgentRun>();
  for (const p of loadSubagentRuns()) { byId.set(p.id, p); }
  for (const r of live) {
    if (!r || typeof r.id !== "string") { continue; }
    byId.set(r.id, { ...byId.get(r.id), ...snapshot(r) });
  }
  const all = [...byId.values()];
  all.sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER));
  // 出口处统一收敛：磁盘自由字符串 → 展示用 6 态联合（见 viewStatus 注释）
  return all.slice(-SUBAGENT_RUN_CAP).map((r) => ({ ...r, status: viewStatus(r.status) }));
}

/** 清空历史记录（内存中运行中的不受影响），返回被清掉的条数 */
export function clearSubagentRuns(): number {
  const n = loadSubagentRuns().length;
  writeAtomic([]);
  return n;
}
