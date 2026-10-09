







import { readdir, readFile, lstat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Tool, ToolRegistry, getRegistry } from "./tools/registry.js";
import { PROJECT_ROOT } from "./paths.js";
import {
  isSkillNameVisible,
  UNRESTRICTED_SKILL_VISIBILITY,
  type SkillVisibilityScope,
} from "./services/agentTools.js";

const SKILL_BODY_LIMIT = 12000;
const MAX_SKILL_DESCRIPTION_LENGTH = 500;
const DEFAULT_SKILL_DIR = join(PROJECT_ROOT, "config", "skills");

const PERMISSION_LEVELS: Record<string, number> = {
  read: 0,
  write: 2,
  terminal: 3,
  network: 4,
  system: 5,
};
const SANDBOX_REQUIRE = new Set([2, 3, 4]);
const SANDBOX_DENY = new Set([5]);


const MISSING_SKILL_DIR_REPORTED = new Set<string>();

export const SKILL_VISIBILITY_DENIED_PREFIX = "[技能白名单拒绝]";

export const SKILL_SOURCE_PROTECTED_PREFIX = "[技能来源受保护]";

export const SKILL_SOURCE_SUBDIR = "skills";

function normalizePathKey(p: string): string {
  const abs = resolve(String(p ?? ""));
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function skillBelongsToSource(skillPath: string, sourceRoot: string): boolean {
  const root = normalizePathKey(sourceRoot);
  if (root === "") {
    return false;
  }
  const dir = normalizePathKey(dirname(String(skillPath ?? "")));
  return dir === root || dir.startsWith(root + sep);
}

export function skillSourceRoot(skill: Skill): string {
  const parent = dirname(skill.path);
  return dirname(parent).split(sep).pop() === SKILL_SOURCE_SUBDIR ? dirname(parent) : parent;
}

export function skillVisibilityDenial(name: string, scope: SkillVisibilityScope): string {
  const who = String(name ?? "").trim() || "(空名)";
  if (scope.allowed.length === 0) {
    return `${SKILL_VISIBILITY_DENIED_PREFIX} 技能「${who}」不在你当前的白名单内，且当前白名单为空 —— 本 Agent 未启用任何技能，skill_search 也不会返回任何技能。请改用内置核心工具完成任务；确需该技能，请让用户在「Agent 管理 → 工具能力」中为该 Agent 勾选后再重试。`;
  }
  return `${SKILL_VISIBILITY_DENIED_PREFIX} 技能「${who}」不在你当前的白名单内，无法加载其正文。你当前可用的技能仅限：${scope.allowed.join("、")}。请改用上述白名单内的技能；确需「${who}」，请让用户在「Agent 管理 → 工具能力」中为该 Agent 勾选后再重试。`;
}




function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((x) => parseScalar(x.trim())).filter((x) => x !== "");
  }
  let s = v;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}


function isOpenQuote(v: string): boolean {
  return (v.startsWith("'") && !v.endsWith("'")) || (v.startsWith('"') && !v.endsWith('"'));
}










function parseBlockScalarHeader(rest: string): { style: ">" | "|"; chomp: "-" | "+" | null } | null {
  const m = /^([|>])([+-]?)(\d*)$/.exec(rest.trim());
  if (!m) { return null; }
  return { style: m[1] as ">" | "|", chomp: (m[2] || null) as "-" | "+" | null };
}


function foldBlockScalar(blockLines: string[]): string {
  const out: string[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) { out.push(buf.join(" ")); buf = []; }
  };
  for (const l of blockLines) {
    if (l.trim() === "") { flush(); out.push(""); } else { buf.push(l.trim()); }
  }
  flush();
  while (out.length > 0 && out[out.length - 1] === "") { out.pop(); }
  return out.join("\n");
}


export function parseMiniYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split("\n");
  const stack: Array<Record<string, unknown>> = [out];
  const stackIndent = [0];
  let i = 0;
  let pendingKey: string | null = null;
  let pendingRaw: string | null = null;
  let lastEmptyChildKey: string | null = null;
  const rootList: unknown[] = [];

  const flushPending = (): void => {
    if (pendingKey === null) return;
    const target = stack[stack.length - 1];
    target[pendingKey] = parseScalar(pendingRaw ?? "");
    pendingKey = null;
    pendingRaw = null;
  };

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.replace(/^\s+/, "");
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = raw.length - stripped.length;
    const isList = stripped.startsWith("- ");
    if (!isList && !stripped.includes(":")) {
      
      if (pendingKey !== null) {
        pendingRaw = (pendingRaw ?? "") + " " + stripped;
      }
      continue;
    }
    
    while (stack.length > 1 && indent <= stackIndent[stack.length - 1]) {
      flushPending();
      stack.pop();
      stackIndent.pop();
    }
    flushPending();
    const target = stack[stack.length - 1];
    if (isList) {
      const item = parseScalar(stripped.slice(2));
      
      if (lastEmptyChildKey !== null && stack.length > 1) {
        const parent = stack[stack.length - 2];
        const slot = parent[lastEmptyChildKey];
        if (Array.isArray(slot)) {
          slot.push(item);
        } else if (slot && typeof slot === "object" && Object.keys(slot).length === 0) {
          parent[lastEmptyChildKey] = [item];
        } else {
          rootList.push(item);
        }
      } else {
        rootList.push(item);
      }
    } else {
      const idx = stripped.indexOf(":");
      const key = stripped.slice(0, idx).trim();
      const rest = stripped.slice(idx + 1).trim();
      const bsHead = parseBlockScalarHeader(rest);
      if (rest === "") {
        
        const child: Record<string, unknown> = {};
        target[key] = child;
        stack.push(child);
        stackIndent.push(indent);
        lastEmptyChildKey = key;
      } else if (bsHead !== null) {
        

        const blockLines: string[] = [];
        const pendingBlanks: string[] = [];
        let contentIndent: number | null = null;
        let j = i + 1;
        for (; j < lines.length; j++) {
          const l = lines[j];
          const s = l.replace(/^\s+/, "");
          if (s === "") { pendingBlanks.push(""); continue; }
          const ind = l.length - s.length;
          if (ind <= indent) { break; }
          if (contentIndent === null) { contentIndent = ind; }
          if (ind < contentIndent) { break; }
          if (pendingBlanks.length > 0) { blockLines.push(...pendingBlanks); pendingBlanks.length = 0; }
          blockLines.push(l.slice(contentIndent));
        }
        i = j - 1; 
        let text = bsHead.style === ">" ? foldBlockScalar(blockLines) : blockLines.join("\n");
        
        while (text.endsWith("\n")) { text = text.slice(0, -1); }
        target[key] = text;
        lastEmptyChildKey = null;
      } else if (isOpenQuote(rest)) {
        
        pendingKey = key;
        pendingRaw = rest;
        lastEmptyChildKey = null;
      } else {
        target[key] = parseScalar(rest);
        lastEmptyChildKey = null;
      }
    }
  }
  flushPending();
  return out;
}










export function frontmatterField(text: string, key: string, limit = 200): string {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)(?:\r?\n---|\r?\n?$)/.exec(text);
  if (!m) { return ""; }
  let v: unknown;
  try {
    v = parseMiniYaml(m[1])[key];
  } catch {
    return "";
  }
  if (typeof v !== "string") { return ""; }
  return v.replace(/\s+/g, " ").trim().slice(0, limit);
}











export function frontmatterDescription(text: string, limit = 200): string {
  return frontmatterField(text, "description", limit);
}



export interface SkillManifestData {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  origin?: string;
  tags?: string[];
  permissions?: Record<string, boolean>;
  args_schema?: Record<string, unknown>;
  trigger_patterns?: string[];
}

export class SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  origin: string;
  tags: string[];
  permissions: Record<string, boolean>;
  argsSchema: Record<string, unknown>;
  triggerPatterns: string[];

  constructor(data: SkillManifestData = {}) {
    this.name = data.name ?? "";
    this.version = data.version ?? "1.0";
    this.description = data.description ?? "";
    this.author = data.author ?? "";
    this.origin = data.origin ?? "";
    this.tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
    this.permissions = (data.permissions as Record<string, boolean>) ?? { read: true };
    this.argsSchema = (data.args_schema as Record<string, unknown>) ?? {};
    this.triggerPatterns = Array.isArray(data.trigger_patterns) ? data.trigger_patterns.map(String) : [];
  }

  static fromDict(data: Record<string, unknown>): SkillManifest {
    return new SkillManifest({
      name: data.name !== undefined ? String(data.name) : undefined,
      version: data.version !== undefined ? String(data.version) : undefined,
      description: data.description !== undefined ? String(data.description) : undefined,
      author: data.author !== undefined ? String(data.author) : undefined,
      origin: data.origin !== undefined ? String(data.origin) : undefined,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
      permissions: (data.permissions as Record<string, boolean>) ?? undefined,
      args_schema: data.args_schema as Record<string, unknown> | undefined,
      trigger_patterns: Array.isArray(data.trigger_patterns) ? data.trigger_patterns.map(String) : undefined,
    });
  }
}

export interface SkillOptions {
  name: string;
  description: string;
  manifest: SkillManifest;
  body?: string;
  path?: string;
  executeFn?: (args: Record<string, unknown>) => string | Promise<string>;
}

export class Skill {
  name: string;
  description: string;
  manifest: SkillManifest;
  body: string;
  path: string;
  executeFn?: (args: Record<string, unknown>) => string | Promise<string>;

  constructor(opts: SkillOptions) {
    this.name = opts.name;
    this.description = opts.description;
    this.manifest = opts.manifest;
    this.body = opts.body ?? "";
    this.path = opts.path ?? "";
    this.executeFn = opts.executeFn;
  }

  isAgentAuthored(): boolean {
    return String(this.manifest.origin ?? "").trim().toLowerCase() === "agent";
  }

  toLLMSchema(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: `skill_${this.name}`,
        description: this.description.slice(0, MAX_SKILL_DESCRIPTION_LENGTH),
        parameters:
          (Object.keys(this.manifest.argsSchema).length > 0
            ? this.manifest.argsSchema
            : {
                type: "object",
                properties: {
                  path: { type: "string", description: "目标文件/目录路径" },
                },
                required: ["path"],
              }),
      },
    };
  }
}



export interface SkillRegistryOptions {
  skillDir?: string;
  
  approvalCallback?: (permission: string, level: number) => boolean;
  







  extraDirs?: string[];
}

export class SkillRegistry {
  skillDir: string;
  extraDirs: string[];
  approvalCallback?: (permission: string, level: number) => boolean;
  private skills = new Map<string, Skill>();
  private loaded = false;
  private unloadedSources = new Set<string>();
  /**
   * A-1198 · 续（审计修复）：**按来源装配过的插件技能根**（`loadFromSource` 登记）。
   *
   * ⚠️ 修的是一个真 bug（审计实证）：`loadSkills()` 会 `skills.clear()` 后只重扫
   * `scanRoots()`（= skillDir + extraDirs）—— 插件技能根**从来不在**这个列表里，
   * 所以任何一次全量重载都会把插件技能**抹掉且再也不扫回来**。
   * 而 `refreshAgentSkills()`（内部就是 `loadAllSkills` → `loadSkills()`）在
   * **每次发消息**（`chat:stream` 开头）与每次「保存并生效」后都会跑 ⇒
   * 用户装的扩展一旦发过一条消息，它的技能就从 `skill_search` 里消失了
   * （"Agent 检测不到用户加的扩展"的真实根因之一）。
   *
   * 修法：装配过的来源根记在这里，`scanRoots()` 一并纳入（仍受 `unloadedSources` 拦截）。
   * 语义边界：**只**记 `loadFromSource` 显式装配的（不猜、不扫磁盘），
   * 撤销过的（`unloadedSources`）照旧挡住 ⇒ 「卸载不复活」的既有语义不变。
   */
  private assembledSources = new Set<string>();

  constructor(opts: SkillRegistryOptions = {}) {
    this.skillDir = opts.skillDir ?? DEFAULT_SKILL_DIR;
    this.extraDirs = opts.extraDirs ?? [];
    this.approvalCallback = opts.approvalCallback;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  
  async loadSkills(): Promise<string[]> {
    this.skills.clear();
    return this.loadSkillsFromDirs(this.scanRoots());
  }

  private scanRoots(): string[] {
    return [this.skillDir, ...this.extraDirs, ...this.assembledSources].filter(
      (root) => root && !this.unloadedSources.has(normalizePathKey(root)),
    );
  }

  listUnloadedSources(): string[] {
    return [...this.unloadedSources];
  }

  /**
   * A-1198 · 续（审计修复②）：该技能是否由**已装配的插件**贡献。
   *
   * ⚠️ 修的是第二个真 bug（审计实证，非推测）：插件技能对 Agent **两种模式都不可见**。
   *   · 默认模式：`resolveSkillVisibilityScope` 的 allowed 只有内置推荐集（6 个名字），
   *     插件技能不在其中 ⇒ skill_search 搜不到；
   *   · 创造模式：`allowAgentAuthored` 放行 `origin=agent`，但 `origin` **只从
   *     manifest.yaml/manifest.json 读**，SKILL.md frontmatter 里的 origin **根本不解析**
   *     ⇒ 照《创造模式导引》写的插件技能（只写 SKILL.md）照样搜不到。
   *   ⇒ 《导引》「四、落位后必须自验」第 2 步（skill_search 复核技能能被检索到）**永远过不了**。
   *
   * 判据（与项目既有口径一致）：设计文档 §「判断标准」写明
   *   「**能写但看不见**（写了技能但白名单不认）… 都不算自由度，算陷阱」。
   * 所以插件贡献的技能**应当可见** —— 它的开关由**插件本身的启停**承担（用户可控），
   * 而不是由 per-agent 技能白名单二次拦截（那会让"装好的插件"对 Agent 静默失效）。
   */
  private isPluginContributed(skill: Skill): boolean {
    for (const root of this.assembledSources) {
      if (skillBelongsToSource(skill.path, root)) { return true; }
    }
    return false;
  }

  async loadSkillsFromDirs(roots: string[]): Promise<string[]> {
    const loaded: string[] = [];
    for (const root of roots) {
      if (!root) {
        continue;
      }
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        
        
        if (!MISSING_SKILL_DIR_REPORTED.has(root)) {
          MISSING_SKILL_DIR_REPORTED.add(root);
          console.info(`[skills] 技能目录不存在（跳过，只报一次）: ${root}`);
        }
        continue;
      }
      for (const name of entries.sort()) {
        const dir = join(root, name);
        try {
          const st = await lstat(dir);
          if (st.isSymbolicLink()) {
            console.warn(`[skills] 拒绝符号链接: ${name}`);
            continue;
          }
          if (!st.isDirectory() || name.startsWith("__")) {
            continue;
          }
        } catch {
          continue;
        }
        const skill = await this.loadSingleSkill(dir, name);
        if (skill && !this.skills.has(skill.name)) {
          this.skills.set(skill.name, skill);
          loaded.push(skill.name);
          console.info(`[skills] 加载技能: ${skill.name}（${root}）`);
        }
      }
    }
    this.loaded = true;
    return loaded;
  }

  
  private async loadSingleSkill(dir: string, dirName: string): Promise<Skill | null> {
    let manifest: SkillManifest | null = null;
    for (const mf of ["manifest.yaml", "manifest.json"]) {
      try {
        const text = await readFile(join(dir, mf), "utf8");
        const data = mf.endsWith(".json")
          ? (JSON.parse(text) as Record<string, unknown>)
          : parseMiniYaml(text);
        manifest = SkillManifest.fromDict(data ?? {});
        break;
      } catch {
        
      }
    }
    if (manifest === null) {
      manifest = new SkillManifest({ name: dirName });
    }
    if (!manifest.name) {
      manifest.name = dirName;
    }

    let description = manifest.description;
    let body = "";
    try {
      const content = await readFile(join(dir, "SKILL.md"), "utf8");
      
      const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
      if (fmMatch) {
        body = (fmMatch[2] ?? "").trim();
        try {
          const fm = parseMiniYaml(fmMatch[1]);
          const fmName = fm.name !== undefined ? String(fm.name) : "";
          if (!manifest.name || manifest.name === dirName) {
            manifest.name = fmName || dirName;
          }
          if (!description && fm.description) {
            description = String(fm.description);
          }
          if (manifest.tags.length === 0 && fm.tags) {
            manifest.tags = Array.isArray(fm.tags) ? fm.tags.map(String) : String(fm.tags).split(",");
          }
        } catch {
          
        }
      } else {
        body = content.trim();
      }
      if (!description) {
        description = body ? this.extractDescription(body) : body.slice(0, 200);
      }
    } catch {
      return null;
    }

    
    try {
      await readFile(join(dir, "skill.py"), "utf8");
      console.warn(`[skills] 技能 ${manifest.name} 含 skill.py，自定义执行函数已禁用（安全），仅使用 SKILL.md 指导模式`);
    } catch {
      
    }

    return new Skill({
      name: manifest.name,
      description,
      manifest,
      body,
      path: dir,
    });
  }

  
  private extractDescription(body: string): string {
    const sectionMatch = /^##\s+功能\s*\n+([\s\S]*?)(?=\n##|\Z)/m.exec(body);
    const headMatch = /^#\s+([\s\S]*?)(?=\n\n)/m.exec(body);
    const m = sectionMatch ?? headMatch;
    if (m) {
      let desc = m[1].trim();
      desc = desc.replace(/\*\*(.*?)\*\*/g, "$1");
      desc = desc.replace(/`(.*?)`/g, "$1");
      return desc.slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
    }
    return body.slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  listSkills(): Record<string, unknown>[] {
    return [...this.skills.values()].map((s) => s.toLLMSchema());
  }

  listSkillNames(): string[] {
    return [...this.skills.keys()];
  }

  listSkillDescriptions(): string[] {
    return [...this.skills.values()].map((s) => s.description);
  }

  
  async callSkill(name: string, _args: Record<string, unknown>, scope?: SkillVisibilityScope): Promise<string> {
    const skill = this.skills.get(name);
    if (!skill) {
      if (scope && scope.constrained) {
        return skillVisibilityDenial(name, scope);
      }
      return `[错误] 技能 '${name}' 未找到`;
    }
    if (scope && !isSkillNameVisible(skill.name, scope, skill.isAgentAuthored()) && !this.isPluginContributed(skill)) {
      return skillVisibilityDenial(skill.name, scope);
    }
    if (skill.executeFn && !this.checkPermissions(skill.manifest.permissions)) {
      return `[错误] 技能 '${name}' 权限不足（需要写/终端/网络权限）`;
    }
    if (skill.executeFn) {
      try {
        const result = await skill.executeFn(_args);
        return String(result);
      } catch (e) {
        console.error(`[skills] 技能 '${name}' 执行失败: ${e instanceof Error ? e.message : String(e)}`);
        return `[错误] 技能执行失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (skill.body) {
      return `[技能 ${name} 指导]\n${skill.body.slice(0, SKILL_BODY_LIMIT)}`;
    }
    return `[技能 ${name}] 无执行函数，请查看 SKILL.md 获取指导。`;
  }

  
  private checkPermissions(permissions: Record<string, boolean>): boolean {
    for (const [perm, required] of Object.entries(permissions)) {
      if (!required) {
        continue;
      }
      const level = PERMISSION_LEVELS[perm] ?? Math.max(...Object.values(PERMISSION_LEVELS));
      if (SANDBOX_DENY.has(level)) {
        return false;
      }
      if (SANDBOX_REQUIRE.has(level)) {
        if (!this.approvalCallback || !this.approvalCallback(perm, level)) {
          console.warn(`[skills] 技能权限 '${perm}' (L${level}) 需要审批，但未配置审批回调，默认拒绝`);
          return false;
        }
      }
    }
    return true;
  }

  
  search(
    query: string,
    limit = 10,
    scope?: SkillVisibilityScope,
  ): Array<{ name: string; description: string }> {
    const q = (query ?? "").trim().toLowerCase();
    const n = Math.max(1, Math.min(limit ? parseInt(String(limit), 10) : 10, 50));
    const scored: Array<[number, string, Skill]> = [];
    for (const s of this.skills.values()) {
      /* 插件贡献的技能不受 per-agent 技能白名单约束（见 isPluginContributed 的长注释：
         「能写但看不见」被本项目明确定为陷阱；插件技能的开关是插件启停本身）。 */
      if (scope && !isSkillNameVisible(s.name, scope, s.isAgentAuthored()) && !this.isPluginContributed(s)) {
        continue;
      }
      if (!q) {
        scored.push([0, s.name, s]);
        continue;
      }
      const nameL = s.name.toLowerCase();
      const descL = (s.description ?? "").toLowerCase();
      const tagsL = (s.manifest.tags ?? []).join(" ").toLowerCase();
      let score = 0;
      if (nameL.includes(q)) score += 3;
      if (descL.includes(q)) score += 1;
      if (tagsL.includes(q)) score += 1;
      if (score > 0) {
        scored.push([score, s.name, s]);
      }
    }
    scored.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return scored.slice(0, n).map(([, , s]) => ({
      name: s.name,
      description: (s.description ?? "").slice(0, 200),
    }));
  }

  clear(): void {
    this.skills.clear();
    this.loaded = false;
  }

  /**
   * 系统来源根（skillDir + extraDirs）：这些是应用自身装配的技能，
   * 不属于任何插件，因此不提供按来源卸载能力。
   */
  private isSystemRoot(sourceRoot: string): boolean {
    const root = normalizePathKey(sourceRoot);
    if (root === "") {
      return true;
    }
    return [this.skillDir, ...this.extraDirs].some((r) => r && normalizePathKey(r) === root);
  }

  /**
   * 按来源目录卸载技能：只移除归属命中的那些，其余原样留下，不做全量重载。
   * 归属判定走 Skill.path 与来源根的前缀关系（见 skillBelongsToSource）——
   * 调用方不需要（也不允许）把插件名写进技能里，映射关系由路径结构本身承担。
   * 幂等：同一来源重复卸载第二次返回空数组。
   * fail-closed：传入系统来源根（应用自身装配的技能）一律拒绝并抛错。
   */
  async unloadBySource(sourceRoot: string): Promise<string[]> {
    const root = String(sourceRoot ?? "").trim();
    if (root === "") {
      return [];
    }
    if (this.isSystemRoot(root)) {
      throw new Error(`${SKILL_SOURCE_PROTECTED_PREFIX} 系统来源的技能不可按来源卸载：${root}`);
    }
    const key = normalizePathKey(root);
    this.assembledSources.delete(root);
    const removed: string[] = [];
    for (const [name, skill] of [...this.skills]) {
      if (!skillBelongsToSource(skill.path, root)) {
        continue;
      }
      this.skills.delete(name);
      removed.push(name);
    }
    this.unloadedSources.add(key);
    this.loaded = true;
    if (removed.length > 0) {
      console.info(`[skills] 按来源卸载技能 ${removed.length} 个（${root}）`);
    }
    return removed;
  }

  /**
   * 载入单个来源目录下的技能并返回该来源的撤销句柄。
   * 撤销只摘掉「本次真正新增」的技能名（按名精确撤销），因此：
   * 同批次里被其它来源占用的同名技能不会被误摘，重复撤销安全。
   */
  async loadFromSource(sourceRoot: string, pluginName: string): Promise<{ name: string; dispose: () => void }> {
    const root = String(sourceRoot ?? "").trim();
    const key = normalizePathKey(root);
    this.unloadedSources.delete(key);
    /* 登记为「已装配来源」⇒ 之后的任何全量重载（refreshAgentSkills）都会把它扫回来。 */
    this.assembledSources.add(root);
    const before = new Set(this.skills.keys());
    await this.loadSkillsFromDirs([root]);
    const added: string[] = [];
    for (const [name, skill] of this.skills) {
      if (!before.has(name) && skillBelongsToSource(skill.path, root)) {
        added.push(name);
      }
    }
    let disposeRan = false;
    return {
      name: pluginName,
      dispose: () => {
        if (disposeRan) {
          return;
        }
        disposeRan = true;
        for (const n of added) {
          this.skills.delete(n);
        }
        this.unloadedSources.add(key);
        /* 撤销后不再是「已装配来源」（unloadedSources 会挡住它，这里同步清掉避免集合无限增长）。 */
        this.assembledSources.delete(root);
        if (added.length > 0) {
          this.loaded = true;
          console.info(`[skills] 撤销来源 ${pluginName} 的技能 ${added.length} 个（${root}）`);
        }
      },
    };
  }
}



let skillRegistry: SkillRegistry | null = null;

const SKILL_SCOPE_ENVELOPE = "_skill_scope";

export function skillScopeFromArgs(args: Record<string, unknown> | undefined): SkillVisibilityScope | undefined {
  if (!args || typeof args !== "object") { return undefined; }
  const raw = args[SKILL_SCOPE_ENVELOPE];
  if (raw === undefined || raw === null) { return undefined; }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) { return undefined; }
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      return normalizeSkillScopeEnvelope(parsed);
    } catch {
      return undefined;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return normalizeSkillScopeEnvelope(raw as Record<string, unknown>);
  }
  return undefined;
}

function normalizeSkillScopeEnvelope(raw: Record<string, unknown>): SkillVisibilityScope | undefined {
  if (raw.constrained !== true) {
    return raw.constrained === false ? { ...UNRESTRICTED_SKILL_VISIBILITY } : undefined;
  }
  const allowed = Array.isArray(raw.allowed) ? raw.allowed.map((s) => String(s ?? "").trim()).filter((s) => s.length > 0) : [];
  return { constrained: true, allowed, allowAgentAuthored: raw.allowAgentAuthored === true };
}

export function getSkillRegistry(): SkillRegistry {
  if (skillRegistry === null) {
    skillRegistry = new SkillRegistry();
  }
  return skillRegistry;
}

export function resetSkillRegistry(): void {
  skillRegistry = new SkillRegistry();
}


export async function loadAllSkills(opts: {
  skillDir?: string;
  
  extraDirs?: string[];
  registry?: ToolRegistry;
  approvalCallback?: (permission: string, level: number) => boolean;
} = {}): Promise<string[]> {
  const skillReg = opts.skillDir ? new SkillRegistry({ skillDir: opts.skillDir, approvalCallback: opts.approvalCallback }) : getSkillRegistry();
  if (opts.skillDir) {
    skillReg.skillDir = opts.skillDir;
  }
  if (opts.extraDirs && opts.extraDirs.length > 0) {
    skillReg.extraDirs = [...opts.extraDirs];
  }
  if (opts.approvalCallback) {
    skillReg.approvalCallback = opts.approvalCallback;
  }
  const loaded = await skillReg.loadSkills();
  const toolReg = opts.registry ?? getRegistry();
  toolReg.unregister("skill_search");
  toolReg.unregister("skill_lookup");

  toolReg.register(new Tool({
    name: "skill_search",
    description:
      "检索可用技能：按关键词在技能名/描述/标签中匹配（名称命中优先），返回技能名与简介。找到目标技能后用 skill_lookup 读取完整指导。不带关键词可列出全部技能。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词（如 '浏览器'、'amazon'）；留空列出全部" },
        limit: { type: "integer", description: "最多返回条数，默认 10，上限 50", default: 10 },
      },
      required: ["query"],
    },
    executeFn: async (args) => {
      const q = String(args.query ?? "").trim();
      let n = 10;
      try {
        n = Math.max(1, Math.min(parseInt(String(args.limit), 10), 50));
      } catch {
        n = 10;
      }
      const scope = skillScopeFromArgs(args);
      const items = skillReg.search(q, n, scope);
      if (items.length === 0) {
        if (scope && scope.constrained) {
          return skillVisibilityDenial(q || "(全部)", scope);
        }
        return "未找到匹配的技能。可不带关键词调用 skill_search 查看全部可用技能。";
      }
      const lines = items.map((it) => `- ${it.name}: ${it.description}`);
      const head = q ? `匹配 '${q}' 的技能（${items.length} 个）` : `可用技能（前 ${items.length} 个）`;
      return `${head}：\n${lines.join("\n")}`;
    },
    permissions: ["read"],
  }));
  toolReg.register(new Tool({
    name: "skill_lookup",
    description: "读取指定技能的完整指导正文（SKILL.md）。技能名来自 skill_search 的返回结果。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（skill_search 返回的 name 字段）" },
      },
      required: ["name"],
    },
    executeFn: async (args) => {
      const name = String(args.name ?? "").trim();
      if (!name) {
        return "[错误] 缺少 name 参数（先用 skill_search 查询技能名）";
      }
      return skillReg.callSkill(name, {}, skillScopeFromArgs(args));
    },
    permissions: ["read"],
  }));

  console.info(`[skills] 已加载 ${loaded.length} 个技能，注册 skill_search/skill_lookup 工具`);
  return loaded;
}