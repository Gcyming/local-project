/**
 * tests/core-ts/import.spec.ts — Agent 导入（身份移民协议 §5）+ 端到端 roundtrip。
 * 策略：临时项目根 + 真实 fs；exportAgent 生成标准包，手工构造特殊包（旧版/篡改）。
 * 覆盖：冲突策略（abort/overwrite/keep-old）、SHA-256 篡改、rebuild 注入、旧包向前兼容、unsafe 路径防御、roundtrip 一致性。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { exportAgent } from "../../core-ts/src/services/export.js";
import { importAgent, verifyAgentPack } from "../../core-ts/src/services/import.js";
import { DEFAULT_REBUILD_HINTS } from "../../core-ts/src/services/export.js";

const KB = ["Knowledge", "Agent Memory"];

function makeAgent(id: string, name: string, role: string) {
  return {
    id,
    name,
    role,
    identity_prompt: `我是 ${name}`,
    model_choice: "inherit",
    parent_id: null,
    persona: { traits: [], preferences: [], skill_ownership: [], interactions: [], created_at: null, updated_at: null },
    emotion: { mood: "neutral" },
    behavior: {},
    children: [],
    created_at: "2026-08-18T00:00:00.000Z",
  };
}

const MEMORY_CONTENT = JSON.stringify(
  { facts: [{ id: "f1", content: "用户喜欢批处理脚本", category: "preference", tags: ["tooling"] }] },
  null,
  2,
);

async function makeSrcRoot(agentId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "src-"));
  const agents = [makeAgent(agentId, "Slime", "编程助手"), makeAgent("agent_other", "Other", "另一个 Agent")];
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "agents.json"), JSON.stringify(agents, null, 2), "utf8");
  await mkdir(join(root, ...KB, agentId), { recursive: true });
  await writeFile(join(root, ...KB, agentId, "memory.json"), MEMORY_CONTENT, "utf8");
  await writeFile(join(root, ...KB, agentId, "knowledge.json"), JSON.stringify({ patterns: {}, rules: [] }), "utf8");
  await mkdir(join(root, ...KB, "rules"), { recursive: true });
  await writeFile(join(root, ...KB, "rules", "rule_1.md"), "# 共享规则", "utf8");
  return root;
}

async function makePack(srcRoot: string, agentId: string, pack: string): Promise<string> {
  const res = await exportAgent({ agentId, output: pack, projectRoot: srcRoot });
  if (!res.ok) throw new Error(`导出失败: ${res.error}`);
  return pack;
}

async function makeTargetRoot(agents?: Array<Record<string, unknown>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "imp-"));
  await mkdir(join(root, "config"), { recursive: true });
  if (agents) {
    await writeFile(join(root, "config", "agents.json"), JSON.stringify(agents, null, 2), "utf8");
  }
  return root;
}

async function readTargetAgents(root: string): Promise<Array<Record<string, unknown>>> {
  try {
    return JSON.parse(await readFile(join(root, "config", "agents.json"), "utf8")) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

async function rmDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** 重打包：读 zip → 修改入口 → 写回新包（用于构造篡改/旧版包） */
async function repack(srcPack: string, outPack: string, mutate: (zip: JSZip) => unknown): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(srcPack));
  await mutate(zip);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await writeFile(outPack, buf);
}

describe("verifyAgentPack（§8.3）", () => {
  it("合法包 → ok", async () => {
    const src = await makeSrcRoot("agent_v1");
    const pack = await makePack(src, "agent_v1", join(src, "v1.slimeagent"));
    const res = await verifyAgentPack(pack);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    await rmDir(src);
  });

  it("非 ZIP 文件 → 报错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imp-"));
    const f = join(dir, "bad.slimeagent");
    await writeFile(f, "not a zip", "utf8");
    const res = await verifyAgentPack(f);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    await rmDir(dir);
  });

  it("缺 manifest.json → 报错", async () => {
    const src = await makeSrcRoot("agent_v2");
    const pack = await makePack(src, "agent_v2", join(src, "v2.slimeagent"));
    const bad = join(src, "bad2.slimeagent");
    await repack(pack, bad, (zip) => zip.remove("manifest.json"));
    const res = await verifyAgentPack(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.join()).toContain("manifest");
    await rmDir(src);
  });
});

describe("importAgent（§5）", () => {
  it("正常导入（无冲突）：注册表新增 + 资产落盘，其他 Agent 不受影响", async () => {
    const src = await makeSrcRoot("agent_b1");
    const pack = await makePack(src, "agent_b1", join(src, "b1.slimeagent"));
    const target = await makeTargetRoot([makeAgent("agent_exist", "Exist", "存量")]);
    const res = await importAgent({ input: pack, targetRoot: target });
    expect(res.ok).toBe(true);
    expect(res.agentId).toBe("agent_b1");
    const agents = await readTargetAgents(target);
    expect(agents.find((a) => a.id === "agent_exist")).toBeDefined(); // 存量保留
    expect(agents.find((a) => a.id === "agent_b1")?.identity_prompt).toBe("我是 Slime");
    const memory = JSON.parse(await readFile(join(target, ...KB, "agent_b1", "memory.json"), "utf8")) as { facts: unknown[] };
    expect(memory.facts).toHaveLength(1);
    await rmDir(src);
    await rmDir(target);
  });

  it("abort 冲突（默认）：报错 + 零写入", async () => {
    const src = await makeSrcRoot("agent_b2");
    const pack = await makePack(src, "agent_b2", join(src, "b2.slimeagent"));
    const target = await makeTargetRoot([makeAgent("agent_b2", "Old", "旧身份")]);
    const res = await importAgent({ input: pack, targetRoot: target });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("已存在");
    const agents = await readTargetAgents(target);
    expect(agents.find((a) => a.id === "agent_b2")?.name).toBe("Old"); // 未被覆盖
    // Knowledge 零写入
    await expect(readFile(join(target, ...KB, "agent_b2", "memory.json"), "utf8")).rejects.toThrow();
    await rmDir(src);
    await rmDir(target);
  });

  it("overwrite 冲突：替换该 Agent 条目 + 资产覆盖，其他 Agent 不受影响", async () => {
    const src = await makeSrcRoot("agent_b3");
    const pack = await makePack(src, "agent_b3", join(src, "b3.slimeagent"));
    const target = await makeTargetRoot([makeAgent("agent_b3", "Old", "旧身份"), makeAgent("agent_k", "Keep", "保留")]);
    const res = await importAgent({ input: pack, targetRoot: target, conflictStrategy: "overwrite" });
    expect(res.ok).toBe(true);
    const agents = await readTargetAgents(target);
    expect(agents).toHaveLength(2); // 不新增数量（同 id 替换）
    expect(agents.find((a) => a.id === "agent_b3")?.name).toBe("Slime"); // 已覆盖
    expect(agents.find((a) => a.id === "agent_k")).toBeDefined(); // 其他保留
    const memory = JSON.parse(await readFile(join(target, ...KB, "agent_b3", "memory.json"), "utf8")) as { facts: unknown[] };
    expect(memory.facts).toHaveLength(1);
    await rmDir(src);
    await rmDir(target);
  });

  it("keep-old 冲突：ok + warning + 跳过（目标原样）", async () => {
    const src = await makeSrcRoot("agent_b4");
    const pack = await makePack(src, "agent_b4", join(src, "b4.slimeagent"));
    const target = await makeTargetRoot([makeAgent("agent_b4", "Old", "旧身份")]);
    const res = await importAgent({ input: pack, targetRoot: target, conflictStrategy: "keep-old" });
    expect(res.ok).toBe(true);
    expect(res.warnings?.some((w) => w.includes("keep-old"))).toBe(true);
    const agents = await readTargetAgents(target);
    expect(agents.find((a) => a.id === "agent_b4")?.name).toBe("Old");
    await rmDir(src);
    await rmDir(target);
  });

  it("SHA-256 篡改：校验失败 + 零写入", async () => {
    const src = await makeSrcRoot("agent_b5");
    const pack = await makePack(src, "agent_b5", join(src, "b5.slimeagent"));
    const tampered = join(src, "b5_tampered.slimeagent");
    await repack(pack, tampered, async (zip) => {
      zip.file("Knowledge/Agent Memory/agent_b5/memory.json", JSON.stringify({ facts: [{ id: "evil", content: "篡改" }] }));
    });
    const target = await makeTargetRoot();
    const res = await importAgent({ input: tampered, targetRoot: target });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("SHA-256");
    expect(await readTargetAgents(target)).toHaveLength(0); // 零写入
    await rmDir(src);
    await rmDir(target);
  });

  it("包内不安全路径（../ 逃逸）→ import 中止 + 报错（防御 zip slip）", async () => {
    const src = await makeSrcRoot("agent_s1");
    const pack = await makePack(src, "agent_s1", join(src, "s1.slimeagent"));
    // 注入 ../ 逃逸路径；注：JSZip 的 generateAsync 会规范化路径为 Knowledge/bad.txt
    // 导致 manifest 声明了但实际内容被改写 → SHA-256 必然不匹配，import 在解压前中止
    const bad = join(src, "s1_bad.slimeagent");
    await repack(pack, bad, async (zip) => {
      zip.file("Knowledge/../bad.txt", "evil"); // → 规范化为 Knowledge/bad.txt，与 manifest 不一致
    });
    const target = await makeTargetRoot();
    const res = await importAgent({ input: bad, targetRoot: target });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("校验失败");
    expect(await readTargetAgents(target)).toHaveLength(0); // 零写入
    await rmDir(src);
    await rmDir(target);
  });

  it("rebuild 回调注入：按 manifest.rebuild_hints 调用", async () => {
    const src = await makeSrcRoot("agent_b6");
    const pack = await makePack(src, "agent_b6", join(src, "b6.slimeagent"));
    const target = await makeTargetRoot();
    const calls: Array<{ agentId: string; targetRoot: string; hints: string[] }> = [];
    const res = await importAgent({
      input: pack,
      targetRoot: target,
      rebuild: async (agentId, targetRoot, hints) => {
        calls.push({ agentId, targetRoot, hints });
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe("agent_b6");
    expect(calls[0].targetRoot).toBe(target);
    expect(calls[0].hints).toEqual(["lancedb"]);
    await rmDir(src);
    await rmDir(target);
  });

  it("旧包无 rebuild_hints → 默认 [lancedb]（向前兼容 v1.0）", async () => {
    const src = await makeSrcRoot("agent_b7");
    const pack = await makePack(src, "agent_b7", join(src, "b7.slimeagent"));
    const legacy = join(src, "b7_legacy.slimeagent");
    await repack(pack, legacy, async (zip) => {
      const mf = JSON.parse(await zip.file("manifest.json")!.async("string")) as Record<string, unknown>;
      delete mf.rebuild_hints;
      mf.export_version = "1.0.0";
      zip.file("manifest.json", JSON.stringify(mf, null, 2));
    });
    const target = await makeTargetRoot();
    const calls: Array<{ hints: string[] }> = [];
    const res = await importAgent({
      input: legacy,
      targetRoot: target,
      rebuild: async (_agentId, _targetRoot, hints) => {
        calls.push({ hints });
      },
    });
    expect(res.ok).toBe(true);
    expect(calls[0].hints).toEqual(DEFAULT_REBUILD_HINTS);
    await rmDir(src);
    await rmDir(target);
  });

  it("包内 config/agents.json 缺失 → 报错", async () => {
    const src = await makeSrcRoot("agent_b8");
    const pack = await makePack(src, "agent_b8", join(src, "b8.slimeagent"));
    const bad = join(src, "b8_bad.slimeagent");
    await repack(pack, bad, (zip) => zip.remove("config/agents.json"));
    const target = await makeTargetRoot();
    const res = await importAgent({ input: bad, targetRoot: target });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("config/agents.json");
    await rmDir(src);
    await rmDir(target);
  });
});

describe("端到端 roundtrip（§9 v1.0 验收：人格/记忆一致）", () => {
  it("导出 → 导入新环境：Agent 字段 + 记忆 + 共享规则全部一致", async () => {
    const src = await makeSrcRoot("agent_r1");
    const pack = await makePack(src, "agent_r1", join(src, "r1.slimeagent"));

    const srcMemory = await readFile(join(src, ...KB, "agent_r1", "memory.json"), "utf8");
    const srcKnowledge = await readFile(join(src, ...KB, "agent_r1", "knowledge.json"), "utf8");
    const srcRule = await readFile(join(src, ...KB, "rules", "rule_1.md"), "utf8");

    const target = await makeTargetRoot();
    const res = await importAgent({ input: pack, targetRoot: target });
    expect(res.ok).toBe(true);

    const agents = await readTargetAgents(target);
    const imported = agents.find((a) => a.id === "agent_r1");
    expect(imported).toBeDefined();
    expect(imported?.identity_prompt).toBe("我是 Slime");
    expect(imported?.role).toBe("编程助手");

    const tgtMemory = await readFile(join(target, ...KB, "agent_r1", "memory.json"), "utf8");
    const tgtKnowledge = await readFile(join(target, ...KB, "agent_r1", "knowledge.json"), "utf8");
    const tgtRule = await readFile(join(target, ...KB, "rules", "rule_1.md"), "utf8");
    expect(tgtMemory).toBe(srcMemory);
    expect(tgtKnowledge).toBe(srcKnowledge);
    expect(tgtRule).toBe(srcRule);

    await rmDir(src);
    await rmDir(target);
  });
});
