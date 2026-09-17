/**
 * tests/core-ts/probe-persist.spec.ts — 实时能力快照落盘（第 2 层探针跨重启保留）测试。
 * 用 os.tmpdir() 临时文件做 IO 隔离（不碰真实 config/），验证：
 * - save/load 往返（原子写 + 字段保留）
 * - 缺失文件 / 损坏 JSON / 版本不符 → 空快照（冷启动重探，不抛）
 * - hydrate 进 LiveProbeCache（只保留未过期条目）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProbeSnapshots,
  saveProbeSnapshots,
  persistLiveProbeCache,
  hydrateLiveProbeCache,
  ProbeSnapshotStore,
} from "../../core-ts/src/probe-persist.js";
import { LiveProbeCache } from "../../core-ts/src/probe-live.js";

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "probe-persist-"));
  file = join(tmp, "live_probe.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("saveProbeSnapshots / loadProbeSnapshots 往返", () => {
  it("写后读回（字段保留 + version=1）", () => {
    const snaps: ProbeSnapshotStore["snapshots"] = [
      { provider: "openai", model: "gpt-4o", ts: 123, contextWindow: 2000, toolCalls: true, streaming: false, latencyMs: 42 },
      { provider: "opencode", model: "ling-3.0", ts: 124, lastErrorType: "upstream" },
    ];
    expect(saveProbeSnapshots(snaps, file)).toBe(true);
    expect(existsSync(file)).toBe(true);
    const loaded = loadProbeSnapshots(file);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ provider: "openai", model: "gpt-4o", ts: 123, contextWindow: 2000, toolCalls: true, latencyMs: 42 });
    expect(loaded[1]).toMatchObject({ provider: "opencode", model: "ling-3.0", lastErrorType: "upstream" });
  });

  it("空快照也能写读", () => {
    expect(saveProbeSnapshots([], file)).toBe(true);
    expect(loadProbeSnapshots(file)).toEqual([]);
  });
});

describe("损坏 / 缺失 / 版本不符的容错", () => {
  it("文件缺失 → 空快照", () => {
    expect(loadProbeSnapshots(join(tmp, "nope.json"))).toEqual([]);
  });

  it("非法 JSON → 空快照（不抛）", () => {
    writeFileSync(file, "{ not json ", "utf8");
    expect(loadProbeSnapshots(file)).toEqual([]);
  });

  it("版本不符（旧 schema）→ 空快照", () => {
    writeFileSync(file, JSON.stringify({ version: 0, snapshots: [{ provider: "p", model: "m", ts: 0 }] }), "utf8");
    expect(loadProbeSnapshots(file)).toEqual([]);
  });

  it("缺必要字段的条目被跳过（provider/model/ts 非字符串/数字）", () => {
    const bad = { version: 1, snapshots: [
      { provider: "p", model: "m", ts: 5 },                // 合法
      { provider: "x", model: 42, ts: 5 },                  // model 非字符串 → 丢弃
      { provider: "y", model: "m" },                         // 缺 ts → 丢弃
      "garbage",                                              // 非对象 → 丢弃
    ] };
    writeFileSync(file, JSON.stringify(bad), "utf8");
    const loaded = loadProbeSnapshots(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.provider).toBe("p");
  });
});

describe("LiveProbeCache ↔ 持久化 联动", () => {
  it("persist 后 hydrate 恢复（同 TTL 语义，未过期条目保留）", () => {
    const t = 1_000_000;
    const writer = new LiveProbeCache({ ttlMs: 60_000, now: () => t });
    writer.put({ provider: "p", model: "m", ts: t, toolCalls: true });
    expect(persistLiveProbeCache(writer, file)).toBe(true);

    // 模拟"重启"：新建 cache（TTL 相同），从盘恢复
    const reader = new LiveProbeCache({ ttlMs: 60_000, now: () => t + 10_000 }); // 10s 后，仍在 TTL 内
    const restored = hydrateLiveProbeCache(reader, file);
    expect(restored).toBe(1);
    expect(reader.get("p", "m")?.toolCalls).toBe(true);
  });

  it("hydrate 丢弃已过期条目（重启时 ts 太旧）", () => {
    const t = 1_000_000;
    const writer = new LiveProbeCache({ ttlMs: 60_000, now: () => t });
    writer.put({ provider: "p", model: "old", ts: t });
    expect(persistLiveProbeCache(writer, file)).toBe(true);

    // 重启时 now 已远超 TTL（旧快照在盘上就过期了）
    const reader = new LiveProbeCache({ ttlMs: 60_000, now: () => t + 1_000_000 });
    const restored = hydrateLiveProbeCache(reader, file);
    expect(restored).toBe(0);
    expect(reader.isStale("p", "old")).toBe(true);
  });
});
