/**
 * core-ts/src/skills.ts — 技能引擎（语义移植自 core/skill_engine.py，逐行对照）。
 * - 加载 config/skills 下各技能目录（SKILL.md + 可选 manifest.yaml/json；frontmatter 回填）
 * - 权限检查（A-038：仅约束自定义执行；指导模式纯读不拦截；fail-closed）
 * - 注册精简工具面（A-004）：skill_search / skill_lookup
 * - N11-P0-2：禁用 skill.py 自定义执行（RCE 风险），仅 SKILL.md 指导模式
 */

import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Tool, ToolRegistry, getRegistry } from "./tools/registry.js";

const SKILL_BODY_LIMIT = 12000;
const MAX_SKILL_DESCRIPTION_LENGTH = 500;
const DEFAULT_SKILL_DIR = join(process.cwd(), "config", "skills");

const PERMISSION_LEVELS: Record<string, number> = {
  read: 0,
  write: 2,
  terminal: 3,
  network: 4,
  system: 5,
};
const SANDBOX_REQUIRE = new Set([2, 3, 4]);
const SANDBOX_DENY = new Set([5]);

// ── 极简 YAML 子集解析（manifest.yaml / SKILL.md frontmatter 够用）─────

/** 解析标量：内联列表 / 引号剥离 / null/true/false/数字 原样转 */
function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  // 内联列表 `[a, b]`
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

/** 判断值是否以未闭合引号开头（YAML 折叠多行字符串） */
function isOpenQuote(v: string): boolean {
  return (v.startsWith("'") && !v.endsWith("'")) || (v.startsWith('"') && !v.endsWith('"'));
}

/** YAML 子集：标量 / 嵌套 map / 列表（- item）/ 折叠续行（缩进对齐） */
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
      // 折叠续行：附到上一个值（引号串跨行/plain 多行均折叠为空格连接）
      if (pendingKey !== null) {
        pendingRaw = (pendingRaw ?? "") + " " + stripped;
      }
      continue;
    }
    // 缩进回退：弹栈直到父级
    while (stack.length > 1 && indent <= stackIndent[stack.length - 1]) {
      flushPending();
      stack.pop();
      stackIndent.pop();
    }
    flushPending();
    const target = stack[stack.length - 1];
    if (isList) {
      const item = parseScalar(stripped.slice(2));
      // `key:` 后紧跟的块状列表 → 数组直接挂父 key（tags: 场景）
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
      if (rest === "") {
        // 嵌套 map
        const child: Record<string, unknown> = {};
        target[key] = child;
        stack.push(child);
        stackIndent.push(indent);
        lastEmptyChildKey = key;
      } else if (isOpenQuote(rest)) {
        // 引号折叠串：跨行累积到闭合
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

// ── 模型 ─────────────────────────────────────────────────

export interface SkillManifestData {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
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
  tags: string[];
  permissions: Record<string, boolean>;
  argsSchema: Record<string, unknown>;
  triggerPatterns: string[];

  constructor(data: SkillManifestData = {}) {
    this.name = data.name ?? "";
    this.version = data.version ?? "1.0";
    this.description = data.description ?? "";
    this.author = data.author ?? "";
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

// ── 注册表 ─────────────────────────────────────────────────

export interface SkillRegistryOptions {
  skillDir?: string;
  /** 沙箱审批回调（REQUIRE 级权限时询问）；缺省 fail-closed 拒绝 */
  approvalCallback?: (permission: string, level: number) => boolean;
}

export class SkillRegistry {
  skillDir: string;
  approvalCallback?: (permission: string, level: number) => boolean;
  private skills = new Map<string, Skill>();
  private loaded = false;

  constructor(opts: SkillRegistryOptions = {}) {
    this.skillDir = opts.skillDir ?? DEFAULT_SKILL_DIR;
    this.approvalCallback = opts.approvalCallback;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** 扫描并加载所有技能，返回加载的技能名列表 */
  async loadSkills(): Promise<string[]> {
    this.skills.clear();
    let entries: string[];
    try {
      entries = await readdir(this.skillDir);
    } catch {
      console.info(`[skills] 技能目录不存在: ${this.skillDir}`);
      return [];
    }
    const loaded: string[] = [];
    for (const name of entries.sort()) {
      const dir = join(this.skillDir, name);
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
      if (skill) {
        this.skills.set(skill.name, skill);
        loaded.push(skill.name);
        console.info(`[skills] 加载技能: ${skill.name}`);
      }
    }
    this.loaded = true;
    return loaded;
  }

  /** 加载单个技能目录（N11-P0-3：拒绝 symlink 已在 loadSkills 处理） */
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
        // 缺失或解析失败 → 继续（frontmatter 兜底）
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
      // frontmatter：`---\n...\n---\n正文`
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
          // frontmatter 解析失败不影响加载
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

    // N11-P0-2：skill.py 自定义执行禁用（RCE 风险），仅指导模式
    try {
      await readFile(join(dir, "skill.py"), "utf8");
      console.warn(`[skills] 技能 ${manifest.name} 含 skill.py，自定义执行函数已禁用（安全），仅使用 SKILL.md 指导模式`);
    } catch {
      // 无 skill.py
    }

    return new Skill({
      name: manifest.name,
      description,
      manifest,
      body,
      path: dir,
    });
  }

  /** 从 SKILL.md 正文提取描述（## 功能 或 首个 # 标题后段落） */
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

  /** 调用技能（A-038：指导模式纯读不拦截；自定义执行需权限） */
  async callSkill(name: string, _args: Record<string, unknown>): Promise<string> {
    const skill = this.skills.get(name);
    if (!skill) {
      return `[错误] 技能 '${name}' 未找到`;
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

  /** 权限检查（fail-closed：REQUIRE 级无审批回调 → 拒绝；未知权限默认最高级） */
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

  /** 关键词检索（A-004）：名称 3 分 > 描述 1 分 = tags 1 分；空查询返回全部 */
  search(query: string, limit = 10): Array<{ name: string; description: string }> {
    const q = (query ?? "").trim().toLowerCase();
    const n = Math.max(1, Math.min(limit ? parseInt(String(limit), 10) : 10, 50));
    const scored: Array<[number, string, Skill]> = [];
    for (const s of this.skills.values()) {
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
}

// ── 全局注册表 ────────────────────────────────────────────

let skillRegistry: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (skillRegistry === null) {
    skillRegistry = new SkillRegistry();
  }
  return skillRegistry;
}

export function resetSkillRegistry(): void {
  skillRegistry = new SkillRegistry();
}

/** 加载技能并注册精简工具面（A-004）：skill_search / skill_lookup */
export async function loadAllSkills(opts: {
  skillDir?: string;
  registry?: ToolRegistry;
  approvalCallback?: (permission: string, level: number) => boolean;
} = {}): Promise<string[]> {
  const skillReg = opts.skillDir ? new SkillRegistry({ skillDir: opts.skillDir, approvalCallback: opts.approvalCallback }) : getSkillRegistry();
  if (opts.skillDir) {
    skillReg.skillDir = opts.skillDir;
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
      const items = skillReg.search(q, n);
      if (items.length === 0) {
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
      return skillReg.callSkill(name, {});
    },
    permissions: ["read"],
  }));

  console.info(`[skills] 已加载 ${loaded.length} 个技能，注册 skill_search/skill_lookup 工具`);
  return loaded;
}