/**
 * core-ts/src/services/export.ts — Agent 导出（身份移民协议 §4）。
 *
 * - 白名单扫描根（§4.1）：Knowledge/Agent Memory/agent_<id>、rules、global、generated_skills、reviews
 * - config/agents.json 单条提取（§4.2）：读全量注册表 → 按 id 过滤 → 包内写 [单条]（绝不整库拷贝）
 * - SHA-256 逐文件（§3.2）+ manifest 组装（§3）+ ZIP deflate level 6（§2）
 * - 向量索引 lancedb 为派生数据永不入包，由导入方按 rebuild_hints 重建（§2.2/§5）
 * - 排除清单双保险（§6）：敏感文件 + Obsidian 自有目录 (.obsidian/.trash) 永不入包
 *
 * 包内路径统一以项目根为基准（含 Knowledge/Agent Memory/ 前缀），与规格 §2.1/§3 示例严格一致。
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { AgentState } from "./agents.js";

export const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** 协议常量（§3 schema / 当前落盘布局 / 包版本） */
export const SCHEMA_VERSION = "v1";
export const LAYOUT_VERSION = 1;
export const PROTOCOL_VERSION = "1.2.0";
/** rebuild_hints 缺席时的默认值（§3.1：向量索引为恒需派生物，一律重建保证检索完整） */
export const DEFAULT_REBUILD_HINTS = ["lancedb"];

/** manifest.json Schema（§3） */
export interface Manifest {
  schema_version: string;
  layout_version: number;
  export_version: string;
  exported_at: string;
  exporter: {
    slime_version: string;
    runtime: string;
    platform: string;
  };
  agent: {
    id: string;
    name: string;
    role: string;
  };
  rebuild_hints?: string[];
  checksums: {
    sha256: Record<string, string>;
  };
  migration_hooks: unknown[];
}

export interface ExportOptions {
  agentId: string;
  /** .slimeagent 输出文件路径 */
  output: string;
  /** 项目根（config/ 与 Knowledge/ 所在；测试可注入临时目录） */
  projectRoot?: string;
  slimeVersion?: string;
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  error?: string;
  manifest?: Manifest;
}

/** §6 敏感文件排除清单（双保险层；白名单扫描根本身已排除绝大多数） */
export function isExcluded(relPath: string): boolean {  const segs = relPath.split("/");
  const name = segs[segs.length - 1] ?? "";
  if (/\.slime_pass/.test(name)) return true;
  if (name === "providers.enc.json") return true;
  if (name.startsWith("auth_token")) return true;
  if (name.endsWith(".enc")) return true;
  // Obsidian 自有目录（vault 设置 / 回收站），任意层级命中即排除
  if (segs.some((s) => s === ".obsidian" || s === ".trash")) return true;
  if (relPath === "config/history.jsonl") return true;
  if (relPath.startsWith("config/skills/")) return true;
  if (relPath.startsWith("data/")) return true;
  return false;
}

// A-112: agent_id 仅允许安全字符（防御路径遍历；导出场景不允许空串 = 必须具体 Agent）
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateAgentIdForExport(agentId: string): void {
  if (!agentId || !AGENT_ID_RE.test(agentId)) {
    throw new Error(`[export] 非法 agent_id: ${JSON.stringify(agentId)}`);
  }
}

/** 递归收集 base 下所有文件，返回相对 base 的路径（正斜杠，防 Windows 分隔符进 ZIP） */
async function walkFiles(dir: string, base: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = relative(base, abs).split(sep).join("/");
    if (e.isDirectory()) {
      out.push(...(await walkFiles(abs, base)));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

export async function exportAgent(options: ExportOptions): Promise<ExportResult> {
  try {
    const root = options.projectRoot ?? PROJECT_ROOT;
    validateAgentIdForExport(options.agentId);
    const agentsPath = join(root, "config", "agents.json");

    // 1. 校验目标 Agent 存在于注册表（§4 步骤 1）
    let registry: AgentState[];
    try {
      registry = JSON.parse(await readFile(agentsPath, "utf8")) as AgentState[];
    } catch {
      return { ok: false, error: "config/agents.json 不存在或不可读" };
    }
    const agent = registry.find((a) => a.id === options.agentId);
    if (!agent) {
      return { ok: false, error: `Agent ${options.agentId} 不存在` };
    }

    // 2. 白名单扫描根（§4.1）；base=项目根 → 包内路径含 Knowledge/Agent Memory/ 前缀
    const knowledgeRoot = join(root, "Knowledge", "Agent Memory");
    const scanRoots = [
      join(knowledgeRoot, options.agentId), // agent_<id>/**
      join(knowledgeRoot, "rules"), // 共享规则，v1 保守全量
      join(knowledgeRoot, "global"), // global/knowledge.json（若存在）
      join(knowledgeRoot, "generated_skills"), // 生成技能（若存在）
      join(knowledgeRoot, "reviews"), // 审查报告（若存在）
    ];
    const fileSet = new Map<string, string>(); // 包内相对路径 → 磁盘绝对路径
    for (const scanRoot of scanRoots) {
      for (const rel of await walkFiles(scanRoot, root)) {
        if (isExcluded(rel)) continue; // §6 双保险
        fileSet.set(rel, join(root, rel));
      }
    }

    // 3. config/agents.json 单条提取（§4.2，绝不整库拷贝）
    const agentsJsonContent = JSON.stringify([agent], null, 2);

    // 4. SHA-256（§3.2）：作用于文件原始字节
    const sha256: Record<string, string> = {};
    for (const [rel, abs] of fileSet) {
      sha256[rel] = createHash("sha256").update(await readFile(abs)).digest("hex");
    }
    sha256["config/agents.json"] = createHash("sha256").update(agentsJsonContent, "utf8").digest("hex");

    // 5. 组装 manifest（§3）
    const manifest: Manifest = {
      schema_version: SCHEMA_VERSION,
      layout_version: LAYOUT_VERSION,
      export_version: PROTOCOL_VERSION,
      exported_at: new Date().toISOString(),
      exporter: {
        slime_version: options.slimeVersion ?? "0.1.0",
        runtime: "typescript",
        platform: process.platform,
      },
      agent: { id: agent.id, name: agent.name, role: agent.role },
      rebuild_hints: [...DEFAULT_REBUILD_HINTS],
      checksums: { sha256 },
      migration_hooks: [],
    };

    // 6. 打包 ZIP（§2：deflate level 6）
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    zip.file("config/agents.json", agentsJsonContent);
    for (const [rel, abs] of fileSet) {
      zip.file(rel, await readFile(abs));
    }
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, buffer);
    return { ok: true, path: options.output, manifest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
