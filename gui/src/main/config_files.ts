/**
 * gui/src/main/config_files.ts — 参数文件调试（折叠栏后端）。
 * - 白名单配置文件：slime.toml / global_config.json 可读写；agents.json / providers.enc.json 只读
 *   （agents.json 权威源是 server/AgentRegistry 内存，GUI 直写会互相覆盖，故只读）
 * - 技能库扫描：config/skills 下各技能目录的 manifest.yaml 与 SKILL.md
 * - MCP 服务器清单：从 slime.toml 提取 [[mcp_servers]] 块（不引入 TOML 依赖，行级正则）
 * - 写入：备份 + 原子写（tmp + rename），上限 512KB
 */
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { existsSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync, copyFileSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";

export interface ConfigFileInfo {
  name: string;
  path: string;
  exists: boolean;
  writable: boolean;
  size: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  hasManifest: boolean;
  hasSkillMd: boolean;
}

export interface McpServerInfo {
  name: string;
  kind: "stdio" | "http";
  command?: string;
  url?: string;
  enabled: boolean;
}

export interface ConfigOverview {
  files: ConfigFileInfo[];
  skills: SkillInfo[];
  mcpServers: McpServerInfo[];
}

const WRITABLE = new Set(["slime.toml", "global_config.json"]);
const ALLOWED = new Set(["slime.toml", "global_config.json", "agents.json", "providers.enc.json"]);
const MAX_SIZE = 512 * 1024;

/** 测试专用根覆盖（vitest 隔离；生产路径不受影响） */
let rootOverride: string | null = null;
export function setRootOverrideForTest(root: string | null): void {
  rootOverride = root;
}
function projectRoot(): string {
  return rootOverride ?? PROJECT_ROOT;
}

function candidateFiles(): ConfigFileInfo[] {
  const root = projectRoot();
  return [
    { name: "slime.toml", path: join(root, "slime.toml"), exists: false, writable: true, size: 0 },
    { name: "global_config.json", path: join(root, "config", "global_config.json"), exists: false, writable: true, size: 0 },
    { name: "agents.json", path: join(root, "config", "agents.json"), exists: false, writable: false, size: 0 },
    { name: "providers.enc.json", path: join(root, "config", "providers.enc.json"), exists: false, writable: false, size: 0 },
  ];
}

export function listConfigFiles(): ConfigFileInfo[] {
  return candidateFiles().map((f) => {
    const st = existsSync(f.path) ? statSync(f.path) : null;
    return { ...f, exists: st !== null, size: st?.size ?? 0 };
  });
}

export function readConfigFile(name: string): { ok: boolean; content?: string; error?: string } {
  if (!ALLOWED.has(name)) {
    return { ok: false, error: `文件不在白名单：${name}` };
  }
  const f = candidateFiles().find((c) => c.name === name);
  if (!f || !existsSync(f.path)) {
    return { ok: false, error: `文件不存在：${name}` };
  }
  const size = statSync(f.path).size;
  if (size > MAX_SIZE) {
    return { ok: false, error: `文件过大（${size} 字节 > ${MAX_SIZE}），拒绝读取` };
  }
  try {
    return { ok: true, content: readFileSync(f.path, "utf8") };
  } catch (e) {
    return { ok: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

export function writeConfigFile(name: string, content: unknown): { ok: boolean; error?: string } {
  if (!WRITABLE.has(name)) {
    return { ok: false, error: `文件只读：${name}（agents.json/providers.enc.json 请使用对应管理功能）` };
  }
  if (typeof content !== "string") {
    return { ok: false, error: "内容必须为文本" };
  }
  if (content.length > MAX_SIZE) {
    return { ok: false, error: `内容过大（${content.length} 字节 > ${MAX_SIZE}）` };
  }
  const f = candidateFiles().find((c) => c.name === name);
  if (!f || !existsSync(f.path)) {
    return { ok: false, error: `文件不存在：${name}` };
  }
  try {
    const bak = `${f.path}.bak`;
    copyFileSync(f.path, bak);
    const tmp = `${f.path}.${Date.now()}.tmp`;
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, f.path);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 扫描技能库：config/skills/<name>/{manifest.yaml, SKILL.md} */
export function listSkills(): SkillInfo[] {
  const base = join(projectRoot(), "config", "skills");
  if (!existsSync(base)) { return []; }
  const out: SkillInfo[] = [];
  for (const entry of readDirSafe(base)) {
    const dir = join(base, entry);
    if (!statSyncSafe(dir)?.isDirectory()) { continue; }
    const manifestPath = join(dir, "manifest.yaml");
    const skillPath = join(dir, "SKILL.md");
    const hasManifest = existsSync(manifestPath);
    const hasSkillMd = existsSync(skillPath);
    let description = "";
    if (hasManifest) {
      description = extractManifestDescription(readHeadSafe(manifestPath, 4096));
    }
    if (!description && hasSkillMd) {
      description = firstLineSafe(skillPath);
    }
    out.push({ name: entry, description, hasManifest, hasSkillMd });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function extractManifestDescription(head: string): string {
  for (const line of head.split(/\r?\n/)) {
    const m = /^\s*description\s*:\s*(.+?)\s*$/.exec(line);
    if (m) { return m[1].slice(0, 200); }
  }
  return "";
}

/** 提取 slime.toml 中的 [[mcp_servers]] 块（支持行首 # 注释的块=禁用） */
export function listMcpServers(): McpServerInfo[] {
  const tomlPath = join(projectRoot(), "slime.toml");
  if (!existsSync(tomlPath)) { return []; }
  let text = "";
  try { text = readFileSync(tomlPath, "utf8"); } catch { return []; }

  const out: McpServerInfo[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!/^#?\s*\[\[mcp_servers\]\]\s*$/.test(trimmed)) { continue; }
    const enabled = !raw.trimStart().startsWith("#");
    let name = "";
    let kind: "stdio" | "http" = "stdio";
    let command = "";
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (/^\[\[/.test(line) || (/^\[/.test(line) && !line.startsWith("[[") && !line.startsWith("[["))) { break; }
      if (line.startsWith("#") || line === "") { continue; }
      const kv = /^([a-zA-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
      if (!kv) { continue; }
      const [, k, v] = kv;
      const value = v.replace(/^"|"$/g, "").trim();
      if (k === "name") { name = value; }
      else if (k === "command") { command = value; }
      else if (k === "url") { url = value; kind = "http"; }
    }
    if (name) {
      out.push({ name, kind, command: command || undefined, url: url || undefined, enabled });
    }
  }
  return out;
}

export function overview(): ConfigOverview {
  return { files: listConfigFiles(), skills: listSkills(), mcpServers: listMcpServers() };
}

function readDirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function statSyncSafe(p: string): { isDirectory(): boolean } | null {
  try { return statSync(p); } catch { return null; }
}

function readHeadSafe(p: string, max: number): string {
  try {
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    closeSync(fd);
    return buf.subarray(0, n).toString("utf8");
  } catch { return ""; }
}

function firstLineSafe(p: string): string {
  try {
    const first = readFileSync(p, "utf8").split(/\r?\n/)[0] ?? "";
    return first.replace(/^#+\s*/, "").slice(0, 200);
  } catch { return ""; }
}