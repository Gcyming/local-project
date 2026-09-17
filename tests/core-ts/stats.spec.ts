/**
 * tests/core-ts/stats.spec.ts — AlarmBus + StatsService 测试（面板数据 /stats 语义对照）。
 * 注意：sessions() 读真实 config/history.jsonl，本文件不测该路径（避免污染），
 * 只测 AlarmBus（内存）与 agentsStats（纯内存计算）+ servers 空态。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AlarmBus, StatsService } from "../../core-ts/src/services/stats.js";
import { AgentRegistry, AgentState, emptyPersona } from "../../core-ts/src/services/agents.js";

function makeAgent(partial: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent_stats1",
    name: "RootAgent",
    role: "根",
    identity_prompt: "你是{name}，{role}。",
    model_choice: "api:test",
    parent_id: null,
    persona: emptyPersona(),
    emotion: {},
    behavior: { patterns: [] },
    children: [],
    created_at: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

async function makeRegistry(dir: string, agents: AgentState[]): Promise<AgentRegistry> {
  await writeFile(join(dir, "agents.json"), JSON.stringify(agents), "utf8");
  const reg = new AgentRegistry(join(dir, "agents.json"));
  await reg.load();
  return reg;
}

describe("AlarmBus", () => {
  it("record 生成序号递增 + 时间戳 + 通知钩子", () => {
    const notify = vi.fn();
    const bus = new AlarmBus({ notify });
    const a1 = bus.record("chat_stream", "流式异常", "critical");
    const a2 = bus.record("swarm", "OOM", "warning");
    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(a1.severity).toBe("critical");
    expect(a2.severity).toBe("warning");
    expect(a1.source).toBe("chat_stream");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(bus.list()).toHaveLength(2);
  });

  it("默认 warning 级别 + 缺省 source 过滤", () => {
    const bus = new AlarmBus();
    const a = bus.record("stats", "sidecar 崩溃");
    expect(a.severity).toBe("warning");
  });

  it("超过 maxRecords 只保留最近 N 条", () => {
    const bus = new AlarmBus({ maxRecords: 3 });
    for (let i = 1; i <= 5; i++) {
      bus.record("src", `msg${i}`);
    }
    expect(bus.list()).toHaveLength(3);
    expect(bus.list()[0].message).toBe("msg3");
  });

  it("notify 抛错不影响 record", () => {
    const bus = new AlarmBus({ notify: () => { throw new Error("hook fail"); } });
    expect(() => bus.record("src", "m")).not.toThrow();
    expect(bus.list()).toHaveLength(1);
  });

  it("clear 清空", () => {
    const bus = new AlarmBus();
    bus.record("src", "m");
    bus.clear();
    expect(bus.list()).toHaveLength(0);
  });
});

describe("StatsService", () => {
  let dir: string;
  let reg: AgentRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-stats-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("agentsStats：根/叶/深度/lifecycle 口径", async () => {
    const root = makeAgent();
    const child = makeAgent({ id: "child1", name: "Child1", parent_id: "agent_stats1", lifecycle: "growth" });
    const grand = makeAgent({ id: "grand1", name: "Grand1", parent_id: "child1", lifecycle: "stable" });
    const orphan = makeAgent({ id: "orphan1", name: "Orphan", parent_id: null, lifecycle: "dormant" });
    root.children = ["child1"];
    child.children = ["grand1"];
    reg = await makeRegistry(dir, [root, child, grand, orphan]);

    const svc = new StatsService(reg, new AlarmBus());
    const s = await svc.agentsStats();
    expect(s.total).toBe(4);
    expect(s.roots).toBe(2); // root + orphan（parent_id=null）
    expect(s.leaves).toBe(2); // grand + orphan
    expect(s.maxDepth).toBe(2); // root→child→grand
    expect(s.byLifecycle).toEqual({ growth: 1, stable: 1, dormant: 1, unknown: 1 }); // root 无 lifecycle 字段
  });

  it("lifecycle 缺省计 unknown", async () => {
    reg = await makeRegistry(dir, [makeAgent({ lifecycle: undefined })]);
    const svc = new StatsService(reg, new AlarmBus());
    const s = await svc.agentsStats();
    expect(s.byLifecycle).toEqual({ unknown: 1 });
  });

  it("servers：model server 未接线 → 空数组", async () => {
    reg = await makeRegistry(dir, [makeAgent()]);
    const svc = new StatsService(reg, new AlarmBus());
    const servers = await svc.servers();
    expect(servers).toEqual([]);
  });

  it("snapshot 结构：alarms 来自注入总线 + timestamp", async () => {
    reg = await makeRegistry(dir, [makeAgent()]);
    const alarms = new AlarmBus();
    alarms.record("chat_stream", "超时", "warning");
    const svc = new StatsService(reg, alarms);
    const snap = await svc.snapshot();
    expect(snap.servers).toEqual([]);
    expect(snap.agents.total).toBe(1);
    expect(snap.alarms).toHaveLength(1);
    expect(snap.alarms[0].source).toBe("chat_stream");
    expect(typeof snap.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(snap.timestamp))).toBe(false);
  });
});
