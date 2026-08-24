/**
 * gui/src/main/config_files.ts — 参数文件调试（折叠栏后端）。
 * - 白名单配置文件：slime.toml / global_config.json 可读写；agents.json / providers.enc.json 只读
 *   （agents.json 权威源是 server/AgentRegistry 内存，GUI 直写会互相覆盖，故只读）
 * - 技能库扫描：config/skills 下各技能目录的 manifest.yaml 与 SKILL.md
 * - MCP 服务器清单：从 slime.toml 提取 [[mcp_servers]] 块（不引入 TOML 依赖，行级正则）
 * - 写入：备份 + 原子写（tmp + rename），上限 512KB
 */
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { existsSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync, copyFileSync, readdirSync, openSync, readSync, closeSync, rmSync } from "node:fs";
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
  /** 是否启用（禁用 = 技能目录被移至 config/skills/.disabled/ 下） */
  enabled: boolean;
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

/** 扫描某个技能根目录（enabled=config/skills；disabled=config/skills/.disabled） */
function scanSkillRoot(base: string, enabled: boolean): SkillInfo[] {
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
    out.push({ name: entry, description, hasManifest, hasSkillMd, enabled });
  }
  return out;
}

/** 扫描技能库：config/skills/<name>{manifest.yaml,SKILL.md}（启用）+ .disabled/<name>（禁用） */
export function listSkills(): SkillInfo[] {
  const base = join(projectRoot(), "config", "skills");
  if (!existsSync(base)) { return []; }
  const out = [...scanSkillRoot(base, true), ...scanSkillRoot(join(base, ".disabled"), false)];
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 启用/禁用技能（物理移动目录至 .disabled/ 下，引擎不再加载） */
export function setSkillEnabled(name: string, enabled: boolean): { ok: boolean; error?: string } {
  const base = join(projectRoot(), "config", "skills");
  const enabledDir = join(base, name);
  const disabledDir = join(base, ".disabled", name);
  const exists = (p: string): boolean => Boolean(statSyncSafe(p)?.isDirectory());
  if (enabled) {
    if (!exists(disabledDir)) {
      return { ok: false, error: `未找到已禁用的技能「${name}」` };
    }
    mkdirSync(base, { recursive: true });
    try {
      renameSync(disabledDir, enabledDir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `启用失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (!exists(enabledDir)) {
    return { ok: false, error: `未找到技能「${name}」` };
  }
  try {
    mkdirSync(join(base, ".disabled"), { recursive: true });
    renameSync(enabledDir, disabledDir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `禁用失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 技能目录路径（启用=config/skills/<name>；禁用=config/skills/.disabled/<name>） */
export function skillDirPath(name: string): string {
  const base = join(projectRoot(), "config", "skills");
  const enabledDir = join(base, name);
  if (statSyncSafe(enabledDir)?.isDirectory()) {
    return enabledDir;
  }
  return join(base, ".disabled", name);
}

/** 删除技能（递归删除其目录，含 .disabled 下的停用副本） */
export function deleteSkill(name: string): { ok: boolean; error?: string } {
  const base = join(projectRoot(), "config", "skills");
  const targets = [join(base, name), join(base, ".disabled", name)];
  let found = false;
  for (const p of targets) {
    if (statSyncSafe(p)?.isDirectory()) {
      found = true;
      try {
        rmSync(p, { recursive: true, force: true });
      } catch (e) {
        return { ok: false, error: `删除失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }
  if (!found) {
    return { ok: false, error: `未找到技能「${name}」` };
  }
  return { ok: true };
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
      // 禁用块内的键也读取（剥单层 #），便于 UI 呈现被禁用的服务器并可恢复
      const dataLine = line.startsWith("#") ? line.slice(1).trim() : line;
      if (dataLine === "") { continue; }
      const kv = /^([a-zA-Z0-9_]+)\s*=\s*(.+)$/.exec(dataLine);
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

interface BlockRef {
  start: number;
  end: number;
}

/** 判断某行是否为 TOML 表头 `[[...]]` 或 `[section]`（忽略行首单层 # 注释前缀） */
function isTableStart(line: string): boolean {
  const t = line.trimStart().replace(/^#/, "").trimStart();
  return /^\[/.test(t);
}

/** 从 [[mcp_servers]] 表头收集该 server 块（遇下一个表头或 EOF 结束） */
function collectTomlBlock(lines: string[], header: number): BlockRef {
  let end = header + 1;
  while (end < lines.length) {
    const candidate = lines[end];
    if (isTableStart(candidate)) { break; }
    end++;
  }
  return { start: header, end };
}

/** 解析 MCP server 块中的 name（读取时剥离单层 # 注释） */
function parseBlockName(body: string[]): string {
  for (const line of body) {
    const t = line.trim().replace(/^#/, "").trim();
    const m = /^name\s*=\s*"([^"]+)"/.exec(t);
    if (m) { return m[1]; }
  }
  return "";
}

/** 重建一个 MCP server 块（enabled=false 时逐行加 #；true 时剥去单层 #） */
function rebuildBlock(lines: string[], block: BlockRef, enabled: boolean): string[] {
  const out: string[] = [];
  for (let i = block.start; i < block.end; i++) {
    const raw = lines[i];
    if (raw.trim() === "") {
      out.push(raw);
      continue;
    }
    if (enabled) {
      out.push(raw.replace(/^((\s*)#)/, "$2"));
    } else {
      out.push(raw.startsWith("#") ? raw : `#${raw}`);
    }
  }
  return out;
}

/** 启用/禁用指定 MCP 服务器（注释/取消注释 [[mcp_servers]] 块；备份 + 原子写） */
export function setMcpEnabled(name: string, enabled: boolean): { ok: boolean; error?: string } {
  const tomlPath = join(projectRoot(), "slime.toml");
  if (!existsSync(tomlPath)) {
    return { ok: false, error: "slime.toml 不存在" };
  }
  let text = "";
  try { text = readFileSync(tomlPath, "utf8"); } catch (e) {
    return { ok: false, error: `读取 slime.toml 失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const lines = text.split(/\r?\n/);
  let found = false;
  const outLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimHint = raw.trimStart().replace(/^#/, "").trimStart();
    if (/^\[\[mcp_servers\]\]\s*$/.test(trimHint)) {
      const block = collectTomlBlock(lines, i);
      const blockName = parseBlockName(lines.slice(block.start, block.end));
      if (blockName === name) {
        found = true;
        outLines.push(...rebuildBlock(lines, block, enabled));
        i = block.end - 1;
        continue;
      }
    }
    outLines.push(raw);
  }
  if (!found) {
    return { ok: false, error: `未找到 MCP 服务器「${name}」` };
  }
  try {
    const bak = `${tomlPath}.bak`;
    copyFileSync(tomlPath, bak);
    const tmp = `${tomlPath}.${Date.now()}.tmp`;
    writeFileSync(tmp, outLines.join("\n"), "utf8");
    renameSync(tmp, tomlPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 删除指定 MCP 服务器（从 slime.toml 移除整个 [[mcp_servers]] 块；备份 + 原子写） */
export function deleteMcp(name: string): { ok: boolean; error?: string } {
  const tomlPath = join(projectRoot(), "slime.toml");
  if (!existsSync(tomlPath)) {
    return { ok: false, error: "slime.toml 不存在" };
  }
  let text = "";
  try { text = readFileSync(tomlPath, "utf8"); } catch (e) {
    return { ok: false, error: `读取 slime.toml 失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const lines = text.split(/\r?\n/);
  let found = false;
  const outLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimHint = raw.trimStart().replace(/^#/, "").trimStart();
    if (/^\[\[mcp_servers\]\]\s*$/.test(trimHint)) {
      const block = collectTomlBlock(lines, i);
      const blockName = parseBlockName(lines.slice(block.start, block.end));
      if (blockName === name) {
        found = true;
        i = block.end - 1;
        continue;
      }
    }
    outLines.push(raw);
  }
  if (!found) {
    return { ok: false, error: `未找到 MCP 服务器「${name}」` };
  }
  try {
    const bak = `${tomlPath}.bak`;
    copyFileSync(tomlPath, bak);
    const tmp = `${tomlPath}.${Date.now()}.tmp`;
    writeFileSync(tmp, outLines.join("\n"), "utf8");
    renameSync(tmp, tomlPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
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