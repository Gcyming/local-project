/**
 * core-ts/src/probe-persist.ts — 实时能力快照落盘（第 2 层探针跨重启保留）。
 *
 * 背景：LiveProbeCache 默认进程内内存态，GUI 重启即失。本模块把「provider:model → 实时能力
 * 快照」持久化到 config/live_probe.json（与 providers.enc.json 同目录），启动时 hydrate、
 * 运行期定期 flush、退出前保存——重启后未过期的快照继续生效，避免"刚学到的模型能力冷启动重探"。
 *
 * 边界（与 llmGateway/providers 一致）：
 * - 全 slime 自研，不涉及 new-api；快照是"上游响应的可观测能力位 + 延迟 + 错误类"，
 *   不含 key/鉴权串（隐私安全），只存能力位与时间戳。
 * - 原子写（tmp + rename），失败静默——快照丢失不影响转发主链路（fire-and-forget）。
 * - 路径经 PROJECT_ROOT 解析（GUI 打包时 boot.ts 设 SLIME_ROOT，自动落到用户数据目录）。
 * - 读盘做「版本 + 字段校验」：旧版/损坏/缺字段的条目直接丢弃（不抛、不污染新数据）。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { LiveProbeCache } from "./probe-live.js";

/** 落盘 JSON 结构（单一 source of truth，未来加字段往这里加） */
export interface ProbeSnapshotStore {
  /** 快照数据 schema 版本（不匹配时整盘丢弃，避免旧字段污染） */
  version: 1;
  /** 最近一次落盘时间（诊断/审计用，不参与逻辑） */
  savedAt: number;
  /** provider:model → 快照 */
  snapshots: Array<{
    provider: string;
    model: string;
    ts: number;
    contextWindow?: number;
    streaming?: boolean;
    toolCalls?: boolean;
    reasoning?: boolean;
    latencyMs?: number;
    lastErrorType?: string;
    /** 模型级失效标志（跨重启保留：重启后仍剔除已知下线/404 模型，直到 TTL 过期重探） */
    modelDead?: boolean;
  }>;
}

const DEFAULT_PATH = join(PROJECT_ROOT, "config", "live_probe.json");
const SCHEMA_VERSION: ProbeSnapshotStore["version"] = 1;

/** 读盘 → 只保留结构合法的条目（坏条目跳过，不抛） */
function sanitizeSnapshots(raw: unknown): ProbeSnapshotStore["snapshots"] {
  if (!Array.isArray(raw)) { return []; }
  const out: ProbeSnapshotStore["snapshots"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") { continue; }
    const r = item as Record<string, unknown>;
    if (typeof r.provider !== "string" || typeof r.model !== "string" || typeof r.ts !== "number") {
      continue;
    }
    const snap: ProbeSnapshotStore["snapshots"][number] = {
      provider: r.provider,
      model: r.model,
      ts: r.ts,
    };
    if (typeof r.contextWindow === "number" && Number.isFinite(r.contextWindow)) { snap.contextWindow = r.contextWindow; }
    if (typeof r.streaming === "boolean") { snap.streaming = r.streaming; }
    if (typeof r.toolCalls === "boolean") { snap.toolCalls = r.toolCalls; }
    if (typeof r.reasoning === "boolean") { snap.reasoning = r.reasoning; }
    if (typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs)) { snap.latencyMs = r.latencyMs; }
    if (typeof r.lastErrorType === "string") { snap.lastErrorType = r.lastErrorType; }
    if (typeof r.modelDead === "boolean") { snap.modelDead = r.modelDead; }
    out.push(snap);
  }
  return out;
}

/** 读盘加载（缺失/损坏/版本不符 → 空快照数组，不抛——冷启动走重探） */
export function loadProbeSnapshots(path: string = DEFAULT_PATH): ProbeSnapshotStore["snapshots"] {
  try {
    if (!existsSync(path)) { return []; }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProbeSnapshotStore>;
    if (parsed.version !== SCHEMA_VERSION) { return []; } // 版本不符整盘丢弃（防止旧结构污染）
    return sanitizeSnapshots(parsed.snapshots);
  } catch {
    return []; // 文件损坏/非 JSON → 冷启动重探
  }
}

/** 原子写盘（tmp + rename），返回是否成功。失败静默（不影响转发链路）。 */
export function saveProbeSnapshots(snapshots: ProbeSnapshotStore["snapshots"], path: string = DEFAULT_PATH): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload: ProbeSnapshotStore = { version: SCHEMA_VERSION, savedAt: Date.now(), snapshots };
    const tmp = `${path}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** 便捷：把 LiveProbeCache 实例落盘（调用 saveProbeSnapshots） */
export function persistLiveProbeCache(cache: LiveProbeCache, path?: string): boolean {
  return saveProbeSnapshots(cache.toJSON(), path);
}

/** 便捷：从盘加载并 hydrate 进 LiveProbeCache（调用 cache.hydrate） */
export function hydrateLiveProbeCache(cache: LiveProbeCache, path?: string): number {
  const snaps = loadProbeSnapshots(path);
  cache.hydrate(snaps);
  return cache.size();
}

/** 默认落盘路径（测试/诊断用） */
export function defaultProbeSnapshotPath(): string {
  return DEFAULT_PATH;
}
