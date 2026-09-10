/**
 * gui/src/main/config_files.ts — 参数文件调试（折叠栏后端）。
 * - 白名单配置文件：slime.toml / global_config.json 可读写；agents.json / providers.enc.json 只读
 *   （agents.json 权威源是 server/AgentRegistry 内存，GUI 直写会互相覆盖，故只读）
 * - 技能库扫描：config/skills 下各技能目录的 manifest.yaml 与 SKILL.md
 * - MCP 服务器清单：从 slime.toml 提取 [[mcp_servers]] 块（不引入 TOML 依赖，行级正则）
 * - 写入：备份 + 原子写（tmp + rename），上限 512KB
 */
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { encrypt, decrypt } from "../../../core-ts/src/encryption.js";
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

/** 新增 MCP 服务器（追加 [[mcp_servers]] 块到 slime.toml；备份 + 原子写）。
 *  A-918++：此前 MCP 面板只支持「打开配置文件手动编辑」，小白用户无从下手；现提供 GUI 表单直达。 */
export function addMcp(input: {
  name: string;
  kind: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** A-918++：用户已确认风险时 force=true 放行 */
  force?: boolean;
}): { ok: boolean; error?: string; riskWarning?: string[] } {
  const name = (input.name ?? "").trim();
  if (!name) { return { ok: false, error: "名称不能为空" }; }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) { return { ok: false, error: "名称仅限字母/数字/_/-（1-64 字符）" }; }
  if (listMcpServers().some((s) => s.name === name)) {
    return { ok: false, error: `已存在同名 MCP 服务器「${name}」` };
  }
  // A-918++：危险命令检测（用户自填 command/args/url/env）——命中先返回 riskWarning，renderer 二次确认后 force 重发
  if (!input.force) {
    const riskTexts = [input.command, ...(input.args ?? []), input.url, ...Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`)];
    const risks = detectRiskPatterns(riskTexts);
    if (risks.length > 0) {
      return { ok: false, error: `命令含可疑特征：${risks.join("、")}`, riskWarning: risks };
    }
  }
  const kind = input.kind === "http" ? "http" : "stdio";

  // 构建新块
  const block: string[] = ["[[mcp_servers]]", `name = "${name}"`];
  if (kind === "http") {
    const url = (input.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) { return { ok: false, error: "HTTP 类型的 url 必须以 http(s):// 开头" }; }
    block.push(`url = "${url}"`);
  } else {
    const command = (input.command ?? "").trim();
    if (!command) { return { ok: false, error: "stdio 类型的 command 不能为空（如 npx / node / uvx 等可执行文件）" }; }
    block.push(`command = "${command}"`);
    if (Array.isArray(input.args) && input.args.length > 0) {
      const argsStr = input.args.filter((a) => String(a ?? "").trim()).map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(", ");
      if (argsStr) { block.push(`args = [${argsStr}]`); }
    }
  }
  if (input.env && Object.keys(input.env).length > 0) {
    const envStr = Object.entries(input.env).map(([k, v]) => `"${k}" = "${String(v).replace(/"/g, '\\"')}"`).join(", ");
    block.push(`env = { ${envStr} }`);
  }
  block.push("");

  // 读取现有内容，追加块
  const tomlPath = join(projectRoot(), "slime.toml");
  let text = "";
  if (existsSync(tomlPath)) {
    try { text = readFileSync(tomlPath, "utf8"); } catch (e) {
      return { ok: false, error: `读取 slime.toml 失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const sep = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  const next = text + sep + block.join("\n") + "\n";
  try {
    if (existsSync(tomlPath)) { copyFileSync(tomlPath, `${tomlPath}.bak`); }
    const tmp = `${tomlPath}.${Date.now()}.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, tomlPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 新增技能（生成 config/skills/<name>/SKILL.md，含 frontmatter；GUI 表单直达，小白无需手动建目录）。
 *  A-918++：此前技能只能手动放文件夹；现提供表单创建。 */
export function addSkill(input: { name: string; description: string; content?: string }): { ok: boolean; error?: string; name?: string } {  const name = (input.name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) { return { ok: false, error: "名称不能为空（将规范化为小写连字符形式）" }; }
  const desc = (input.description ?? "").trim();
  if (!desc) { return { ok: false, error: "描述必填（一句话说明该技能做什么）" }; }
  const base = join(projectRoot(), "config", "skills");
  const dir = join(base, name);
  if (existsSync(dir)) { return { ok: false, error: `已存在同名技能「${name}」` }; }
  const body = (input.content ?? "").trim() || `# ${name}\n\n${desc}\n`;
  const md = `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), md, "utf8");
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error: `创建失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ── A-918++：联网技能市场（接入 Anthropic 官方 anthropics/skills 仓库，GitHub API 可编程访问） ── */

const SKILL_MARKET_REPO = "anthropics/skills";
/** 模块级缓存：GitHub 匿名 API 仅 60 req/h，避免反复拉取列表 */
let skillMarketCache: Array<{ name: string; description: string }> | null = null;

/* ── A-918++：数据源认证（GitHub Personal Access Token，加密存储 config/registry_auth.json） ──
   用户可内嵌配置 GitHub Token，把匿名 60 req/h 提升到 5000 req/h；token 加密落盘不泄露。 */

const REGISTRY_AUTH_PATH = "config/registry_auth.json";

/** 读取数据源认证（加密解密；失败返回空，不影响匿名访问） */
export function getRegistryAuth(): { githubToken?: string } {
  try {
    const data = decrypt(REGISTRY_AUTH_PATH, rootOverride ? { projectRoot: rootOverride } : {}) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") { return {}; }
    return { githubToken: typeof data.github_token === "string" && data.github_token ? data.github_token : undefined };
  } catch {
    return {};
  }
}

/** 保存数据源认证（加密写盘） */
export function setRegistryAuth(auth: { githubToken?: string }): { ok: boolean; error?: string } {
  try {
    const prev = getRegistryAuth();
    const githubToken = (auth.githubToken ?? prev.githubToken ?? "").trim();
    const next: Record<string, unknown> = { github_token: githubToken };
    encrypt(next, REGISTRY_AUTH_PATH, rootOverride ? { projectRoot: rootOverride } : {});
    skillMarketCache = null; // token 变化 → 清缓存，下次用新 token 重新拉取
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `保存认证失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 构造 GitHub 请求头（有 token 则带 Authorization 提升限流） */
function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "slime-agent" };
  const token = getRegistryAuth().githubToken;
  if (token) { h.Authorization = `Bearer ${token}`; }
  return h;
}

/** 从 SKILL.md frontmatter 提取 description（兼容单行 / 多行折叠 / 引号包裹 / 末尾 --- 残留） */
function extractFrontmatterDescription(md: string): string {
  const m = /description:\s*(.+?)(?:\n\w+:|$)/s.exec(md);
  if (!m) { return ""; }
  return m[1]
    .replace(/^["'|>]\s*/, "")
    .replace(/\s*["']\s*$/, "")
    .replace(/\s*---\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 联网搜索技能市场（搜索/浏览 anthropics/skills 官方技能） */
export async function searchSkillMarket(query: string): Promise<{ ok: boolean; skills?: Array<{ name: string; description: string }>; error?: string }> {
  try {
    if (!skillMarketCache) {
      const listRes = await fetch(`https://api.github.com/repos/${SKILL_MARKET_REPO}/contents/skills`, {
        headers: githubHeaders(),
      });
      if (!listRes.ok) { return { ok: false, error: `拉取技能列表失败（HTTP ${listRes.status}）` }; }
      const list = (await listRes.json()) as Array<{ name: string; type: string }>;
      const names = list.filter((e) => e.type === "dir").map((e) => e.name);
      // 并发拉取各技能 SKILL.md 的 frontmatter 提取 description（限流 6 并发）
      const entries: Array<{ name: string; description: string }> = [];
      const pool = [...names];
      const worker = async (): Promise<void> => {
        while (pool.length > 0) {
          const n = pool.shift()!;
          try {
            const rawRes = await fetch(`https://raw.githubusercontent.com/${SKILL_MARKET_REPO}/main/skills/${n}/SKILL.md`, { headers: githubHeaders() });
            if (rawRes.ok) {
              entries.push({ name: n, description: extractFrontmatterDescription(await rawRes.text()) });
            } else {
              entries.push({ name: n, description: "" });
            }
          } catch {
            entries.push({ name: n, description: "" });
          }
        }
      };
      await Promise.all(Array.from({ length: 6 }, () => worker()));
      entries.sort((a, b) => a.name.localeCompare(b.name));
      skillMarketCache = entries;
    }
    const q = (query ?? "").trim().toLowerCase();
    const filtered = q
      ? skillMarketCache.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
      : skillMarketCache;
    return { ok: true, skills: filtered };
  } catch (e) {
    return { ok: false, error: `联网拉取技能市场失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 从官方仓库安装单个技能（下载 SKILL.md 写入 config/skills/<name>/） */
export async function installSkillFromMarket(name: string): Promise<{ ok: boolean; error?: string; name?: string }> {
  const safeName = (name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safeName) { return { ok: false, error: "技能名无效" }; }
  const base = join(projectRoot(), "config", "skills");
  const dir = join(base, safeName);
  if (existsSync(dir)) { return { ok: false, error: `已存在同名技能「${safeName}」` }; }
  try {
    const rawRes = await fetch(`https://raw.githubusercontent.com/${SKILL_MARKET_REPO}/main/skills/${safeName}/SKILL.md`, { headers: githubHeaders() });
    if (!rawRes.ok) { return { ok: false, error: `下载 SKILL.md 失败（HTTP ${rawRes.status}）` }; }
    const text = await rawRes.text();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), text, "utf8");
    return { ok: true, name: safeName };
  } catch (e) {
    return { ok: false, error: `安装失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A-918++：危险特征检测——对用户自填的 command/args/url/env/SKILL 内容做扫描。
 *  命中返回特征清单（如 ["递归删除 rm -rf", "管道执行 curl|sh"]）；官方仓库下载内容豁免（调用方不扫）。 */
export function detectRiskPatterns(texts: Array<string | undefined>): string[] {
  const hits: string[] = [];
  const rules: Array<{ re: RegExp; label: string }> = [
    { re: /\brm\s+-(?:rf|fr|r\s*f)\b/i, label: "递归强制删除 rm -rf" },
    { re: /(?:curl|wget)\s+[^\n;|]*\s*\|?\s*(?:sh|bash)\b/i, label: "管道下载后直接执行 curl/wget|sh" },
    { re: /\b(?:base64|echo)\s+[^\n]*\|\s*(?:base64\s+)?-d/i, label: "base64 解码执行" },
    { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:&\s*\}/i, label: "fork 炸弹" },
    { re: /\bchmod\s+\+x\b[^\n]*&&/, label: "下载后 chmod +x 并执行" },
    { re: /\bLD_PRELOAD\b/, label: "LD_PRELOAD 劫持" },
    { re: /\b(?:nc|ncat)\s+[^\n]*-e\b/i, label: "nc -e 反弹 shell" },
    { re: /\/dev\/tcp\//, label: "/dev/tcp 网络回连" },
    { re: />\s*(?:\/etc\/|\/boot\/|\/root\/|\$HOME\/\.bashrc|\$HOME\/\.zshrc)/i, label: "写敏感路径（/etc/、~/.bashrc 等）" },
    { re: /\b(?:bash|sh)\s+[^\n|;&]*\/dev\/tcp\b/i, label: "bash /dev/tcp 回连执行" },
    { re: /\bcurl\s+[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/i, label: "curl 提权管道执行" },
    { re: /\bwget\s+[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/i, label: "wget 提权管道执行" },
  ];
  for (const t of texts) {
    if (!t) { continue; }
    for (const r of rules) {
      if (r.re.test(t)) { hits.push(r.label); }
    }
  }
  return [...new Set(hits)];
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

/* ── A-918++：MCP 官方 registry 联网搜索/安装（registry.modelcontextprotocol.io，Linux Foundation 维护）
   实测单 server 内联完整 server.json：packages[]（stdio，含 npm 包名+npx runtime）或 remotes[]（http url）→ 可直接拼装 */

export interface RegistryServerCard {
  name: string;            // 规范化安装名（namespace/name → namespace-name）
  displayName: string;     // 原始名（如 ac.tandem/docs-mcp）
  description: string;
  source: string;
  install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string };
}

/** 联网搜索 MCP 官方 registry（按 name/description 关键词） */
export async function searchMcpRegistry(query: string): Promise<{ ok: boolean; servers?: RegistryServerCard[]; error?: string }> {
  try {
    const q = (query ?? "").trim();
    const url = `https://registry.modelcontextprotocol.io/v0.1/servers?limit=60${q ? `&search=${encodeURIComponent(q)}` : ""}`;
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "slime-agent" } });
    if (!res.ok) { return { ok: false, error: `registry 请求失败（HTTP ${res.status}）` }; }
    const data = (await res.json()) as { servers?: Array<{ server?: { name?: string; description?: string; packages?: unknown[]; remotes?: unknown[] } }> };
    const raw = data.servers ?? [];
    const seen = new Set<string>();
    const cards: RegistryServerCard[] = [];
    for (const s of raw) {
      const name = s.server?.name ?? "";
      const desc = s.server?.description ?? "";
      if (!name || seen.has(name)) { continue; }
      seen.add(name);
      const displayName = name;
      const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "mcp-server";
      const pkgs = (s.server?.packages ?? []) as Array<{
        registryType?: string; identifier?: string; runtimeHint?: string;
        runtimeArguments?: Array<{ value?: string }>;
        environmentVariables?: Array<{ name?: string }>;
      }>;
      const remotes = (s.server?.remotes ?? []) as Array<{ type?: string; url?: string }>;
      // 优先 stdio 包（可 npx 一键装）；其次 remote http
      if (pkgs.length > 0 && pkgs[0]?.identifier) {
        const p0 = pkgs[0];
        const command = p0.runtimeHint && /^(npx|uvx|node|python|docker)$/i.test(p0.runtimeHint) ? p0.runtimeHint : "npx";
        const positional = (p0.runtimeArguments ?? []).map((a) => a.value ?? "").filter(Boolean);
        const envHints = (p0.environmentVariables ?? []).map((v) => v.name ?? "").filter(Boolean);
        const pkgId = p0.identifier ?? "";
        cards.push({ name: safeName, displayName, description: desc, source: "registry", install: { kind: "stdio", command, args: ["-y", pkgId, ...positional], envHints } });
      } else if (remotes.length > 0 && remotes[0]?.url) {
        cards.push({ name: safeName, displayName, description: desc, source: "registry", install: { kind: "http", url: remotes[0].url } });
      } else {
        cards.push({ name: safeName, displayName, description: desc, source: "registry" });
      }
    }
    return { ok: true, servers: cards };
  } catch (e) {
    return { ok: false, error: `联网搜索 MCP registry 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 从官方 registry 卡片安装（stdio → npx 命令写 slime.toml；http → url）。registry 为可信源，跳过危险检测 */
export async function installFromMcpRegistry(card: RegistryServerCard): Promise<{ ok: boolean; error?: string }> {
  if (!card?.install) { return { ok: false, error: "该服务器无可用安装配置（可能是纯元数据条目）" }; }
  if (card.install.kind === "stdio") {
    return addMcp({
      name: card.name,
      kind: "stdio",
      command: card.install.command,
      args: card.install.args,
      force: true,
    });
  }
  return addMcp({ name: card.name, kind: "http", url: card.install.url, force: true });
}