







import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { frontmatterDescription, frontmatterField } from "../../../core-ts/src/skills.js";
import { encrypt, decrypt } from "../../../core-ts/src/encryption.js";
import { expandMarketQuery } from "../../../core-ts/src/services/marketLocalize.js";
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
  
  enabled: boolean;
  



  origin: string;
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
    let origin = "";
    if (hasManifest) {
      description = extractManifestDescription(readHeadSafe(manifestPath, 4096));
    }
    if (hasSkillMd) {
      const head = readHeadSafe(skillPath, 4096);
      if (!description) {
        



        description = frontmatterDescription(head) || firstLineSafe(skillPath);
      }
      
      origin = frontmatterField(head, "origin", 32).toLowerCase();
    }
    out.push({ name: entry, description, hasManifest, hasSkillMd, enabled, origin });
  }
  return out;
}


export function listSkills(): SkillInfo[] {
  const base = join(projectRoot(), "config", "skills");
  if (!existsSync(base)) { return []; }
  const out = [...scanSkillRoot(base, true), ...scanSkillRoot(join(base, ".disabled"), false)];
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


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


export function skillDirPath(name: string): string {
  const base = join(projectRoot(), "config", "skills");
  const enabledDir = join(base, name);
  if (statSyncSafe(enabledDir)?.isDirectory()) {
    return enabledDir;
  }
  return join(base, ".disabled", name);
}


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


function isTableStart(line: string): boolean {
  const t = line.trimStart().replace(/^#/, "").trimStart();
  return /^\[/.test(t);
}




function isKeyValueLine(line: string): boolean {
  const t = line.trimStart().replace(/^#/, "").trimStart();
  return /^[A-Za-z_][A-Za-z0-9_.-]*\s*=/.test(t);
}











function collectTomlBlock(lines: string[], header: number): BlockRef {
  let end = header + 1;
  while (end < lines.length) {
    const candidate = lines[end];
    if (isTableStart(candidate)) { break; }
    if (candidate.trim() === "") {
      
      let probe = end + 1;
      while (probe < lines.length && lines[probe].trim() === "") { probe++; }
      if (probe >= lines.length || !isKeyValueLine(lines[probe])) { break; }
    }
    end++;
  }
  return { start: header, end };
}


function parseBlockName(body: string[]): string {
  for (const line of body) {
    const t = line.trim().replace(/^#/, "").trim();
    const m = /^name\s*=\s*"([^"]+)"/.exec(t);
    if (m) { return m[1]; }
  }
  return "";
}








function rebuildBlock(lines: string[], block: BlockRef, enabled: boolean): string[] {
  const out: string[] = [];
  for (let i = block.start; i < block.end; i++) {
    const raw = lines[i];
    if (raw.trim() === "") {
      out.push(raw);
      continue;
    }
    if (enabled) {
      out.push(raw.replace(/^(\s*)#[ \t]?/, "$1"));
    } else {
      out.push(/^\s*#/.test(raw) ? raw : raw.replace(/^(\s*)/, "$1# "));
    }
  }
  return out;
}


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



export function addMcp(input: {
  name: string;
  kind: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  
  force?: boolean;
}): { ok: boolean; error?: string; riskWarning?: string[] } {
  const name = (input.name ?? "").trim();
  if (!name) { return { ok: false, error: "名称不能为空" }; }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) { return { ok: false, error: "名称仅限字母/数字/_/-（1-64 字符）" }; }
  if (listMcpServers().some((s) => s.name === name)) {
    return { ok: false, error: `已存在同名 MCP 服务器「${name}」` };
  }
  
  if (!input.force) {
    const riskTexts = [input.command, ...(input.args ?? []), input.url, ...Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`)];
    const risks = detectRiskPatterns(riskTexts);
    if (risks.length > 0) {
      return { ok: false, error: `命令含可疑特征：${risks.join("、")}`, riskWarning: risks };
    }
  }
  const kind = input.kind === "http" ? "http" : "stdio";

  
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









function injectFrontmatterField(text: string, key: string, value: string): string {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)(?:\r?\n---)/.exec(text);
  if (!m) {
    return `---\n${key}: ${value}\n---\n\n${text}`;
  }
  if (new RegExp(`^\\s*${key}\\s*:`, "m").test(m[1])) {
    return text;                       
  }
  return `---\n${m[1]}\n${key}: ${value}` + text.slice(m.index + m[0].length);
}



export function addSkill(input: { name: string; description: string; content?: string }): { ok: boolean; error?: string; name?: string } {
  const name = (input.name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) { return { ok: false, error: "名称不能为空（将规范化为小写连字符形式）" }; }
  const desc = (input.description ?? "").trim();
  if (!desc) { return { ok: false, error: "描述必填（一句话说明该技能做什么）" }; }
  const base = join(projectRoot(), "config", "skills");
  const dir = join(base, name);
  if (existsSync(dir)) { return { ok: false, error: `已存在同名技能「${name}」` }; }
  const body = (input.content ?? "").trim() || `# ${name}\n\n${desc}\n`;
  
  const md = `---\nname: ${name}\ndescription: ${desc}\norigin: user\n---\n\n${body}\n`;
  const manifest = `name: ${name}\nversion: "1.0"\ndescription: ${desc}\n`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), md, "utf8");
    writeFileSync(join(dir, "manifest.yaml"), manifest, "utf8");
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error: `创建失败：${e instanceof Error ? e.message : String(e)}` };
  }
}



const SKILL_MARKET_REPO = "anthropics/skills";

let skillMarketCache: Array<{ name: string; description: string }> | null = null;




const REGISTRY_AUTH_PATH = "config/registry_auth.json";


export function getRegistryAuth(): { githubToken?: string } {
  try {
    const data = decrypt(REGISTRY_AUTH_PATH, rootOverride ? { projectRoot: rootOverride } : {}) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") { return {}; }
    return { githubToken: typeof data.github_token === "string" && data.github_token ? data.github_token : undefined };
  } catch {
    return {};
  }
}


export function setRegistryAuth(auth: { githubToken?: string }): { ok: boolean; error?: string } {
  try {
    const prev = getRegistryAuth();
    const githubToken = (auth.githubToken ?? prev.githubToken ?? "").trim();
    const next: Record<string, unknown> = { github_token: githubToken };
    encrypt(next, REGISTRY_AUTH_PATH, rootOverride ? { projectRoot: rootOverride } : {});
    skillMarketCache = null; 
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `保存认证失败：${e instanceof Error ? e.message : String(e)}` };
  }
}


function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "slime-agent" };
  const token = getRegistryAuth().githubToken;
  if (token) { h.Authorization = `Bearer ${token}`; }
  return h;
}


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


export async function searchSkillMarket(query: string): Promise<{ ok: boolean; skills?: Array<{ name: string; description: string }>; error?: string }> {
  try {
    if (!skillMarketCache) {
      const listRes = await fetch(`https://api.github.com/repos/${SKILL_MARKET_REPO}/contents/skills`, {
        headers: githubHeaders(),
      });
      if (!listRes.ok) { return { ok: false, error: `拉取技能列表失败（HTTP ${listRes.status}）` }; }
      const list = (await listRes.json()) as Array<{ name: string; type: string }>;
      const names = list.filter((e) => e.type === "dir").map((e) => e.name);
      
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
    
    writeFileSync(join(dir, "SKILL.md"), injectFrontmatterField(text, "origin", "market"), "utf8");
    const desc = extractFrontmatterDescription(text) || safeName;
    writeFileSync(join(dir, "manifest.yaml"), `name: ${safeName}\nversion: "1.0"\ndescription: ${desc}\n`, "utf8");
    return { ok: true, name: safeName };
  } catch (e) {
    return { ok: false, error: `安装失败：${e instanceof Error ? e.message : String(e)}` };
  }
}



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
    const src = readFileSync(p, "utf8").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    for (const line of src.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) { continue; }
      return t.replace(/^#+\s*/, "").slice(0, 200);
    }
    return "";
  } catch { return ""; }
}




export interface RegistryServerCard {
  name: string;            
  displayName: string;     
  description: string;
  source: string;
  install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string };
}










export async function searchMcpRegistry(query: string): Promise<{
  ok: boolean; servers?: RegistryServerCard[]; error?: string;
  
  appliedQuery?: string;
  
  unrecognized?: boolean;
}> {
  try {
    const expanded = expandMarketQuery(query ?? "");
    const q = expanded.query;
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
    
    
    return {
      ok: true, servers: cards, appliedQuery: q,
      ...(expanded.unrecognized ? { unrecognized: true } : {}),
    };
  } catch (e) {
    return { ok: false, error: `联网搜索 MCP registry 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}


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