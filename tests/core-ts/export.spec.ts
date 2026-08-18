/**
 * tests/core-ts/export.spec.ts — Agent 导出（身份移民协议 §4）。
 * 策略：临时项目根 + 真实 fs；断言 manifest / 包结构 / 单条提取 / 排除清单 / 懒创建语义。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { exportAgent, isExcluded, SCHEMA_VERSION, LAYOUT_VERSION } from "../../core-ts/src/services/export.js";

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

async function makeRoot(agentId: string, opts: { knowledgeFile?: boolean; rulesFile?: boolean; sensitiveFile?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "exp-"));
  const agents = [makeAgent(agentId, "Slime", "编程助手"), makeAgent("agent_other", "Other", "另一个 Agent")];
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "agents.json"), JSON.stringify(agents, null, 2), "utf8");
  await mkdir(join(root, ...KB, agentId), { recursive: true });
  await writeFile(
    join(root, ...KB, agentId, "memory.json"),
    JSON.stringify({ facts: [{ id: "f1", content: "用户喜欢批处理脚本", category: "preference", tags: ["tooling"] }] }, null, 2),
    "utf8",
  );
  if (opts.knowledgeFile) {
    await writeFile(join(root, ...KB, agentId, "knowledge.json"), JSON.stringify({ patterns: {}, rules: [] }), "utf8");
  }
  if (opts.rulesFile) {
    await mkdir(join(root, ...KB, "rules"), { recursive: true });
    await writeFile(join(root, ...KB, "rules", "rule_1.md"), "# 共享规则", "utf8");
    await writeFile(join(root, ...KB, "rules", "rule_2.md"), "# 共享规则二", "utf8");
  }
  if (opts.sensitiveFile) {
    await writeFile(join(root, ...KB, agentId, "providers.enc.json"), "secret", "utf8");
    await writeFile(join(root, ...KB, agentId, ".slime_pass"), "pass", "utf8");
  }
  return root;
}

async function readZip(pack: string): Promise<JSZip> {
  return JSZip.loadAsync(await readFile(pack));
}

async function rmDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe("exportAgent（§4）", () => {
  it("基础导出：manifest 正确（schema/layout/export_version/rebuild_hints/agent）", async () => {
    const root = await makeRoot("agent_a1");
    const pack = join(root, "out", "a1.slimeagent");
    const res = await exportAgent({ agentId: "agent_a1", output: pack, projectRoot: root });
    expect(res.ok).toBe(true);
    expect(res.manifest?.schema_version).toBe(SCHEMA_VERSION);
    expect(res.manifest?.layout_version).toBe(LAYOUT_VERSION);
    expect(res.manifest?.export_version).toBe("1.2.0");
    expect(res.manifest?.rebuild_hints).toEqual(["lancedb"]);
    expect(res.manifest?.agent).toEqual({ id: "agent_a1", name: "Slime", role: "编程助手" });
    expect(res.manifest?.exporter.runtime).toBe("typescript");
    expect(res.path).toBe(pack);
    await rmDir(root);
  });

  it("checksums 覆盖包内所有文件（除 manifest），且值正确", async () => {
    const root = await makeRoot("agent_a2", { knowledgeFile: true });
    const pack = join(root, "a2.slimeagent");
    const res = await exportAgent({ agentId: "agent_a2", output: pack, projectRoot: root });
    expect(res.ok).toBe(true);
    const zip = await readZip(pack);
    const sha256 = res.manifest!.checksums.sha256;
    const entries = Object.keys(zip.files).filter((p) => !zip.files[p].dir && p !== "manifest.json");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const p of entries) {
      expect(sha256[p]).toBeDefined();
      const { createHash } = await import("node:crypto");
      const actual = createHash("sha256").update(await zip.file(p)!.async("nodebuffer")).digest("hex");
      expect(actual).toBe(sha256[p]);
    }
    expect(sha256["config/agents.json"]).toBeDefined();
    expect(sha256["Knowledge/Agent Memory/agent_a2/memory.json"]).toBeDefined();
    expect(sha256["Knowledge/Agent Memory/agent_a2/knowledge.json"]).toBeDefined();
    await rmDir(root);
  });

  it("config/agents.json 单条提取（§4.2）：只含目标 Agent，不含整库其他条目", async () => {
    const root = await makeRoot("agent_a3");
    const pack = join(root, "a3.slimeagent");
    const res = await exportAgent({ agentId: "agent_a3", output: pack, projectRoot: root });
    expect(res.ok).toBe(true);
    const zip = await readZip(pack);
    const agentArr = JSON.parse(await zip.file("config/agents.json")!.async("string")) as Array<Record<string, unknown>>;
    expect(agentArr).toHaveLength(1);
    expect(agentArr[0].id).toBe("agent_a3");
    expect(agentArr[0].identity_prompt).toBe("我是 Slime");
    expect(agentArr.some((a) => a.id === "agent_other")).toBe(false);
    await rmDir(root);
  });

  it("懒创建语义：无 knowledge.json 时包内不含该文件（§2.1）", async () => {
    const root = await makeRoot("agent_a4");
    const pack = join(root, "a4.slimeagent");
    const res = await exportAgent({ agentId: "agent_a4", output: pack, projectRoot: root });
    expect(res.ok).toBe(true);
    const zip = await readZip(pack);
    expect(zip.file("Knowledge/Agent Memory/agent_a4/knowledge.json")).toBeNull();
    expect(zip.file("Knowledge/Agent Memory/agent_a4/memory.json")).not.toBeNull();
    await rmDir(root);
  });

  it("共享目录入包：rules/** 全量（v1 保守全量）", async () => {
    const root = await makeRoot("agent_a5", { rulesFile: true });
    const pack = join(root, "a5.slimeagent");
    const res = await exportAgent({ agentId: "agent_a5", output: pack, projectRoot: root });
    expect(res.ok).toBe(true);
    const zip = await readZip(pack);
    expect(zip.file("Knowledge/Agent Memory/rules/rule_1.md")).not.toBeNull();
    expect(zip.file("Knowledge/Agent Memory/rules/rule_2.md")).not.toBeNull();
    await rmDir(root);
  });

  it("敏感排除（§6）：providers.enc.json / *.slime_pass 永不入包", async () => {
    const root = await makeRoot("agent_a6", { sensitiveFile: true });
    const pack = join(root, "a6.slimeagent");
    const res = await exportAgent({ agentId: "agent_a6", output: pack, projectRoot: root });
    expect(res.ok).toBe(true);
    const zip = await readZip(pack);
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.endsWith("providers.enc.json"))).toBe(false);
    expect(names.some((n) => n.endsWith(".slime_pass"))).toBe(false);
    await rmDir(root);
  });

  it("目标 Agent 不存在 → 报错（§4 步骤 1）", async () => {
    const root = await makeRoot("agent_a7");
    const pack = join(root, "a7.slimeagent");
    const res = await exportAgent({ agentId: "agent_nope", output: pack, projectRoot: root });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("不存在");
    await rmDir(root);
  });

  it("config/agents.json 缺失 → 报错", async () => {
    const root = await mkdtemp(join(tmpdir(), "exp-"));
    const pack = join(root, "a8.slimeagent");
    const res = await exportAgent({ agentId: "agent_a8", output: pack, projectRoot: root });
    expect(res.ok).toBe(false);
    await rmDir(root);
  });

  it("非法 agent_id（路径逃逸防御）→ 报错", async () => {
    const root = await makeRoot("agent_a10");
    const pack = join(root, "a10.slimeagent");
    const res = await exportAgent({ agentId: "../../etc", output: pack, projectRoot: root });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("非法 agent_id");
    await rmDir(root);
  });
});

describe("isExcluded（§6 单元）", () => {
  it("敏感文件/凭证/obsidian/非白名单路径全部排除", () => {
    expect(isExcluded("config/history.jsonl")).toBe(true);
    expect(isExcluded("config/skills/foo/SKILL.md")).toBe(true);
    expect(isExcluded("data/model_servers.json")).toBe(true);
    expect(isExcluded("Knowledge/Agent Memory/agent_a/.obsidian/app.json")).toBe(true);
    expect(isExcluded("Knowledge/Agent Memory/agent_a/.trash/deleted.md")).toBe(true);
    expect(isExcluded("Knowledge/Agent Memory/agent_a/providers.enc.json")).toBe(true);
    expect(isExcluded("Knowledge/Agent Memory/agent_a/secret.slime_pass")).toBe(true);
    expect(isExcluded("Knowledge/Agent Memory/agent_a/token.txt")).toBe(false); // 非敏感，保留
    expect(isExcluded("Knowledge/Agent Memory/agent_a/memory.json")).toBe(false);
  });
});

describe("导出产物持久可读", () => {
  it("输出目录自动创建 + 文件可读（deflate 6）", async () => {
    const root = await makeRoot("agent_a9");
    const pack = join(root, "deep", "nested", "a9.slimeagent");
    const res = await exportAgent({ agentId: "agent_a9", output: pack, projectRoot: root });
    expect(res.ok).toBe(true);
    const stat = await readdir(join(root, "deep", "nested"));
    expect(stat).toContain("a9.slimeagent");
    await rmDir(root);
  });
});
