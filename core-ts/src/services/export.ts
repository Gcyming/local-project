











import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, relative, dirname, sep } from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import JSZip from "jszip";
import type { AgentState } from "./agents.js";

export { PROJECT_ROOT };


export const SCHEMA_VERSION = "v1";
export const LAYOUT_VERSION = 1;
export const PROTOCOL_VERSION = "1.2.0";

export const DEFAULT_REBUILD_HINTS = ["lancedb"];


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
  
  output: string;
  
  projectRoot?: string;
  slimeVersion?: string;
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  error?: string;
  manifest?: Manifest;
}


export function isExcluded(relPath: string): boolean {  const segs = relPath.split("/");
  const name = segs[segs.length - 1] ?? "";
  if (/\.slime_pass/.test(name)) return true;
  if (name === "providers.enc.json") return true;
  if (name.startsWith("auth_token")) return true;
  if (name.endsWith(".enc")) return true;
  
  if (segs.some((s) => s === ".obsidian" || s === ".trash")) return true;
  if (relPath === "config/history.jsonl") return true;
  if (relPath.startsWith("config/skills/")) return true;
  if (relPath.startsWith("data/")) return true;
  return false;
}


const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateAgentIdForExport(agentId: string): void {
  if (!agentId || !AGENT_ID_RE.test(agentId)) {
    throw new Error(`[export] 非法 agent_id: ${JSON.stringify(agentId)}`);
  }
}


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

    
    const knowledgeRoot = join(root, "Knowledge", "Agent Memory");
    const scanRoots = [
      join(knowledgeRoot, options.agentId), 
      join(knowledgeRoot, "rules"), 
      join(knowledgeRoot, "global"), 
      join(knowledgeRoot, "generated_skills"), 
      join(knowledgeRoot, "reviews"), 
    ];
    const fileSet = new Map<string, string>(); 
    for (const scanRoot of scanRoots) {
      for (const rel of await walkFiles(scanRoot, root)) {
        if (isExcluded(rel)) continue; 
        fileSet.set(rel, join(root, rel));
      }
    }

    
    const agentsJsonContent = JSON.stringify([agent], null, 2);

    
    const sha256: Record<string, string> = {};
    for (const [rel, abs] of fileSet) {
      sha256[rel] = createHash("sha256").update(await readFile(abs)).digest("hex");
    }
    sha256["config/agents.json"] = createHash("sha256").update(agentsJsonContent, "utf8").digest("hex");

    
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
