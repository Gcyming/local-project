












import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import JSZip from "jszip";
import { AgentRegistry } from "./agents.js";
import type { AgentState } from "./agents.js";
import { SCHEMA_VERSION, LAYOUT_VERSION, DEFAULT_REBUILD_HINTS } from "./export.js";
import type { Manifest } from "./export.js";
import type { MemoryStoreOptions } from "../memory/store.js";

export { PROJECT_ROOT };

export type ConflictStrategy = "abort" | "overwrite" | "keep-old";


export interface RebuildDeps {
  lance?: MemoryStoreOptions["lance"];
  embed?: MemoryStoreOptions["embed"];
}

export type RebuildFn = (
  agentId: string,
  targetRoot: string,
  hints: string[],
  deps?: RebuildDeps,
) => Promise<void>;

export interface ImportOptions {
  
  input: string;
  
  targetRoot: string;
  
  conflictStrategy?: ConflictStrategy;
  
  rebuild?: RebuildFn;
  rebuildDeps?: RebuildDeps;
}

export interface ImportResult {
  ok: boolean;
  agentId?: string;
  agentName?: string;
  error?: string;
  warnings?: string[];
}



function verifyManifestBasics(manifest: Manifest): string[] {
  const errors: string[] = [];
  if (manifest.schema_version !== SCHEMA_VERSION) {
    errors.push(`协议版本不兼容：需要 ${SCHEMA_VERSION}，包为 ${manifest.schema_version ?? "(缺失)"}`);
  }
  if (typeof manifest.layout_version === "number" && manifest.layout_version > LAYOUT_VERSION) {
    errors.push(`资产布局过新（${manifest.layout_version} > ${LAYOUT_VERSION}），需升级 slime 版本`);
  }
  const major = parseInt(manifest.export_version?.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major)) {
    errors.push("export_version 格式非法");
  } else if (major > 1) {
    errors.push("包格式不兼容，请升级 slime 版本");
  }
  return errors;
}

async function verifyChecksums(zip: JSZip, manifest: Manifest): Promise<string[]> {
  const errors: string[] = [];
  const checksums = manifest.checksums?.sha256 ?? {};
  const entries = Object.keys(zip.files).filter((p) => !zip.files[p].dir && p !== "manifest.json");
  const checked = new Set<string>();
  for (const [path, hex] of Object.entries(checksums)) {
    const entry = zip.file(path);
    if (!entry) {
      errors.push(`缺少文件: ${path}`);
      continue;
    }
    const actual = createHash("sha256").update(await entry.async("nodebuffer")).digest("hex");
    if (actual !== hex) {
      errors.push(`SHA-256 不匹配: ${path}`);
    }
    checked.add(path);
  }
  for (const p of entries) {
    if (!checked.has(p)) {
      errors.push(`包内存在未声明文件: ${p}`);
    }
  }
  return errors;
}




function isSafeRel(p: string): boolean {
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  const segs = p.split("/");
  if (segs.some((s) => s === "..")) return false;
  if (segs[0] !== "Knowledge") return false;
  return true;
}




export async function defaultRebuildIndexes(
  agentId: string,
  targetRoot: string,
  hints: string[],
  deps?: RebuildDeps,
): Promise<void> {
  if (!hints.includes("lancedb")) return;
  const { MemoryStore } = await import("../memory/store.js");
  const memoryPath = join(targetRoot, "Knowledge", "Agent Memory", agentId, "memory.json");
  let raw: string;
  try {
    raw = await readFile(memoryPath, "utf8");
  } catch {
    return; 
  }
  const data = JSON.parse(raw) as { facts?: Array<{ content?: string; category?: string; tags?: string[] }> };
  const facts = data.facts ?? [];
  if (facts.length === 0) return;

  const store = new MemoryStore(agentId, {
    projectRoot: targetRoot,
    dataDir: "Knowledge/Agent Memory",
    lancedbEnabled: true,
    lancedbUri: resolve(targetRoot, "data", agentId, "lancedb"),
    embed: deps?.embed,
    lance: deps?.lance,
  });
  await store.initLancedb();
  for (const f of facts) {
    if (!f.content) continue;
    await store.store(f.category ?? "fact", f.content, (f.tags ?? []).join(","));
  }
}



export async function verifyAgentPack(path: string): Promise<{ ok: boolean; errors: string[] }> {
  let zipData: Buffer;
  try {
    zipData = await readFile(path);
  } catch {
    return { ok: false, errors: [`无法读取包文件: ${path}`] };
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipData);
  } catch {
    return { ok: false, errors: ["非合法 ZIP 包"] };
  }
  const mf = zip.file("manifest.json");
  if (!mf) {
    return { ok: false, errors: ["非合法包：缺少 manifest.json"] };
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await mf.async("string")) as Manifest;
  } catch {
    return { ok: false, errors: ["manifest.json 解析失败"] };
  }
  const errors = [...verifyManifestBasics(manifest), ...(await verifyChecksums(zip, manifest))];
  return { ok: errors.length === 0, errors };
}



export async function importAgent(options: ImportOptions): Promise<ImportResult> {
  const strategy = options.conflictStrategy ?? "abort";
  const warnings: string[] = [];
  let zipData: Buffer;
  try {
    zipData = await readFile(options.input);
  } catch {
    return { ok: false, error: `无法读取包文件: ${options.input}` };
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipData);
  } catch {
    return { ok: false, error: "非合法 ZIP 包" };
  }

  
  const mf = zip.file("manifest.json");
  if (!mf) return { ok: false, error: "非合法包：缺少 manifest.json" };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await mf.async("string")) as Manifest;
  } catch {
    return { ok: false, error: "manifest.json 解析失败" };
  }
  const baseErrors = verifyManifestBasics(manifest);
  if (baseErrors.length) return { ok: false, error: baseErrors.join("; ") };

  
  const checksumErrors = await verifyChecksums(zip, manifest);
  if (checksumErrors.length) {
    return { ok: false, error: `校验失败（${checksumErrors.length}）: ${checksumErrors.slice(0, 5).join("; ")}` };
  }

  
  const agentEntry = zip.file("config/agents.json");
  if (!agentEntry) return { ok: false, error: "包内缺少 config/agents.json" };
  let agentArr: AgentState[];
  try {
    agentArr = JSON.parse(await agentEntry.async("string")) as AgentState[];
  } catch {
    return { ok: false, error: "config/agents.json 解析失败" };
  }
  const agent = agentArr[0];
  if (!agent || !agent.id) return { ok: false, error: "config/agents.json 无有效 Agent 条目" };

  
  const registry = new AgentRegistry(join(options.targetRoot, "config", "agents.json"));
  await registry.load();
  const idx = registry.loadedAgents.findIndex((a) => a.id === agent.id);
  const existed = idx >= 0;
  if (existed && strategy === "abort") {
    return {
      ok: false,
      error: `Agent ${agent.id} 已存在，导入中止（conflictStrategy=abort）`,
      agentId: agent.id,
      agentName: agent.name,
      warnings,
    };
  }
  if (existed && strategy === "keep-old") {
    return {
      ok: true,
      agentId: agent.id,
      agentName: agent.name,
      warnings: [...warnings, `Agent ${agent.id} 已存在，按 keep-old 跳过（未导入）`],
    };
  }

  
  const entries = Object.keys(zip.files).filter((p) => !zip.files[p].dir && p !== "manifest.json" && p !== "config/agents.json");
  const written: string[] = [];
  try {
    for (const p of entries) {
      if (!isSafeRel(p)) {
        throw new Error(`包内含不安全路径: ${p}（应为规范 manifest 外的异常文件）`);
      }
      const entry = zip.file(p);
      if (!entry) continue;
      const abs = resolve(options.targetRoot, p);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, await entry.async("nodebuffer"));
      written.push(abs);
    }
  } catch (e) {
    for (const w of written) await rm(w, { force: true }).catch(() => undefined);
    return { ok: false, error: `导入中断，已回滚: ${e instanceof Error ? e.message : String(e)}` };
  }

  
  try {
    if (existed) {
      registry.loadedAgents[idx] = agent; 
    } else {
      registry.loadedAgents.push(agent);
    }
    await registry.save();
  } catch (e) {
    for (const w of written) await rm(w, { force: true }).catch(() => undefined);
    return { ok: false, error: `注册表写入失败，已回滚: ${e instanceof Error ? e.message : String(e)}` };
  }

  
  const hints = Array.isArray(manifest.rebuild_hints) && manifest.rebuild_hints.length ? manifest.rebuild_hints : [...DEFAULT_REBUILD_HINTS];
  if (hints.length) {
    const rebuild = options.rebuild ?? defaultRebuildIndexes;
    try {
      await rebuild(agent.id, options.targetRoot, hints, options.rebuildDeps);
    } catch (e) {
      warnings.push(`重建派生索引失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ok: true, agentId: agent.id, agentName: agent.name, warnings };
}
