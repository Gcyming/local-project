/**
 * tests/core-ts/swarm_service.spec.ts — SwarmService 测试（slime_server.py /swarm/report 语义对照）。
 * 覆盖：输入清洗（state 白名单/字段截断）/ 校验 400（task/summary 空、results>16）/
 * report 成功与失败的后处理管线（knowledge task.swarm.* / behavior / emotion / 保存）/ dispatch。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SwarmService, cleanSwarmResults } from "../../core-ts/src/services/swarm.js";
import { AgentRegistry, AgentState, emptyPersona } from "../../core-ts/src/services/agents.js";
import { RunResult } from "../../core-ts/src/executor.js";

function makeAgent(partial: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent_swarm1",
    name: "SwarmHost",
    role: "宿主",
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

function quietLogger(): Pick<Console, "warn" | "info" | "debug"> {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe("cleanSwarmResults", () => {
  it("state 白名单：非法归一 failed；字段截断", () => {
    const r = cleanSwarmResults([
      { name: "a", state: "done", result: "ok", error: "" },
      { name: "b", state: "explode", result: "x", error: "e" },
      { name: "n".repeat(100), state: "done", result: "r".repeat(3000), error: "e".repeat(1000) },
      "junk",
    ]);
    expect(r).toHaveLength(3);
    expect(r[0].state).toBe("done");
    expect(r[1].state).toBe("failed");
    expect(r[2].name).toHaveLength(64);
    expect(r[2].result).toHaveLength(2000);
    expect(r[2].error).toHaveLength(500);
  });
});

describe("SwarmService.report", () => {
  let dir: string;
  let reg: AgentRegistry;
  let dataDir: string;
  let service: SwarmService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-swarm-"));
    dataDir = await mkdtemp(join(tmpdir(), "slime-swarm-ke-"));
    reg = await makeRegistry(dir, [makeAgent()]);
    service = new SwarmService({ registry: reg, dataDir, logger: quietLogger() });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("Agent 不存在 → 404", async () => {
    await expect(
      service.report("nope", { task: "t", summary: "s", results: [] }),
    ).rejects.toThrow("Agent 不存在");
  });

  it("task/summary 为空 → 400", async () => {
    await expect(
      service.report("agent_swarm1", { task: "", summary: "s", results: [] }),
    ).rejects.toThrow("task 与 summary 不能为空");
    await expect(
      service.report("agent_swarm1", { task: "t", summary: "  ", results: [] }),
    ).rejects.toThrow("task 与 summary 不能为空");
  });

  it("results 超过 16 项 → 400", async () => {
    await expect(
      service.report("agent_swarm1", { task: "t", summary: "s", results: new Array(17).fill({}) }),
    ).rejects.toThrow("results 必须是不超过 16 项的列表");
  });

  it("全部 done → 成功：knowledge task.swarm.success + 返回 success=true", async () => {
    const r = await service.report("agent_swarm1", {
      task: "写一份文档",
      summary: "完成",
      results: [{ name: "w1", state: "done", result: "ok" }],
    });
    expect(r.ok).toBe(true);
    expect(r.success).toBe(true);
    expect(r.lifecycle).toBe("growth");
    const { getKnowledgeEngine } = await import("../../core-ts/src/memory/knowledge.js");
    const ke = getKnowledgeEngine("agent_swarm1", { dataDir });
    expect(ke.getStats().total_patterns).toBeGreaterThan(0);
  });

  it("存在失败子任务 → success=false：knowledge task.swarm.fail 记录失败数", async () => {
    const r = await service.report("agent_swarm1", {
      task: "复杂任务",
      summary: "部分完成",
      results: [
        { name: "w1", state: "done", result: "ok" },
        { name: "w2", state: "failed", result: "", error: "崩了" },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("后处理管线：提取的行为模式沉淀 + 情绪更新 + 落盘", async () => {
    const svc = new SwarmService({
      registry: reg,
      dataDir,
      memoryEnabled: true,
      logger: quietLogger(),
      postProcess: {
        extractMemory: async () => ({
          traitSignals: [{ name: "高效" }],
          userSentiment: 0.6,
          behaviorPatterns: [{ scenario: "多任务", steps: ["拆", "并行", "合"] }],
        }),
      },
    });
    const r = await svc.report("agent_swarm1", {
      task: "三件事并行",
      summary: "都完成了",
      results: [{ name: "w1", state: "done", result: "ok" }],
    });
    expect(r.memory_count.traits).toBe(1);
    const agent = reg.loadedAgents[0];
    const behavior = agent.behavior as { patterns?: Array<{ scenario: string; source: string }> };
    expect(behavior.patterns).toHaveLength(1);
    expect(behavior.patterns![0].source).toBe("swarm_extracted");
    expect(agent.emotion).toHaveProperty("mood");
    // 落盘核验
    const reloaded = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "agents.json"), "utf8"));
    expect(reloaded[0].behavior.patterns).toHaveLength(1);
  });

  it("evolution 未接线 → 跳过不抛错", async () => {
    await expect(
      service.report("agent_swarm1", { task: "t", summary: "s", results: [] }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("SwarmService.dispatch", () => {
  let dir: string;
  let reg: AgentRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-swarm-dispatch-"));
    reg = await makeRegistry(dir, [makeAgent()]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("Agent 不存在 → 404；task 为空 → 400", async () => {
    const svc = new SwarmService({ registry: reg });
    await expect(svc.dispatch("nope", "t")).rejects.toThrow("Agent 不存在");
    await expect(svc.dispatch("agent_swarm1", "  ")).rejects.toThrow("task 不能为空");
  });

  it("runner 未接线 → 501", async () => {
    const svc = new SwarmService({ registry: reg });
    await expect(svc.dispatch("agent_swarm1", "任务")).rejects.toThrow("未接线");
  });

  it("runner 注入 → 透传 RunResult", async () => {
    const runner = vi.fn(async (): Promise<RunResult> => ({
      merge_result: { summary: "合" } as unknown as RunResult["merge_result"],
      agent_snapshots: [],
      task_id: "t1",
      warnings: [],
    }));
    const svc = new SwarmService({ registry: reg, dispatchRunner: runner });
    const r = await svc.dispatch("agent_swarm1", "任务", { maxWorkers: 3 });
    expect(r.task_id).toBe("t1");
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ id: "agent_swarm1" }), expect.objectContaining({ task: "任务", maxWorkers: 3 }));
  });
});
