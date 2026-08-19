/**
 * core-ts/src/services/agents.ts — Agent 状态注册表 + 人格画像（core/agent.py + core/persona.py 语义移植）。
 * - AgentRegistry：读 config/agents.json（list），findAgent / childrenOf / names / atomicSave
 * - PersonaModel：addInteraction（保留最近 200 条）、clone、toDict
 * 注意：本注册表是 core-ts 侧权威读取器；5C 前双轨并行期不改写 Python server 内存态，
 * 写入仅用于 core-ts 自身服务流程（对齐 promote 铁律：经服务 API 变更，不经文件直写绕过）。
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export { PROJECT_ROOT };
export const AGENTS_PATH = join(PROJECT_ROOT, "config", "agents.json");

export interface PersonaData {
  traits: Array<Record<string, unknown>>;
  preferences: unknown[];
  skill_ownership: unknown[];
  interactions: Array<{
    user: string;
    ai: string;
    success: boolean;
    timestamp: string;
  }>;
  created_at: string | null;
  updated_at: string | null;
}

export function emptyPersona(): PersonaData {
  return {
    traits: [],
    preferences: [],
    skill_ownership: [],
    interactions: [],
    created_at: null,
    updated_at: null,
  };
}

function normalizeTraits(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({ name: item, weight: 0.5, last_used: null });
    } else if (item && typeof item === "object") {
      const d = item as Record<string, unknown>;
      out.push({
        name: d.name ?? d.trait ?? "unknown",
        weight: typeof d.weight === "number" ? d.weight : 0.5,
        last_used: d.last_used ?? null,
      });
    }
  }
  return out;
}

/** 人格画像（对齐 core/persona.py Persona 核心语义） */
export class PersonaModel {
  data: PersonaData;

  constructor(data?: Partial<PersonaData> | null) {
    this.data = { ...emptyPersona() };
    if (data) {
      if (Array.isArray(data.traits)) {
        this.data.traits = normalizeTraits(data.traits);
      }
      if (Array.isArray(data.preferences)) {
        this.data.preferences = data.preferences;
      }
      if (Array.isArray(data.skill_ownership)) {
        this.data.skill_ownership = data.skill_ownership;
      }
      if (Array.isArray(data.interactions)) {
        this.data.interactions = data.interactions as PersonaData["interactions"];
      }
      this.data.created_at = data.created_at ?? null;
    }
    if (this.data.created_at === null) {
      this.data.created_at = new Date().toISOString();
    }
    this.data.updated_at = new Date().toISOString();
  }

  get traits(): Array<Record<string, unknown>> {
    return this.data.traits;
  }

  set traits(value: unknown) {
    this.data.traits = normalizeTraits(value);
    this.data.updated_at = new Date().toISOString();
  }

  get interactions(): PersonaData["interactions"] {
    return this.data.interactions;
  }

  addInteraction(userMsg: string, aiReply: string, success = true): void {
    this.data.interactions.push({
      user: userMsg,
      ai: aiReply,
      success,
      timestamp: new Date().toISOString(),
    });
    if (this.data.interactions.length > 200) {
      this.data.interactions = this.data.interactions.slice(-200);
    }
    this.data.updated_at = new Date().toISOString();
  }

  clone(): PersonaModel {
    return new PersonaModel(JSON.parse(JSON.stringify(this.data)));
  }

  toDict(): PersonaData {
    return JSON.parse(JSON.stringify(this.data)) as PersonaData;
  }
}

/** agents.json 单条 Agent 状态（字段对齐 Python Agent 序列化） */
export interface AgentState {
  id: string;
  name: string;
  role: string;
  identity_prompt: string;
  model_choice: string;
  parent_id: string | null;
  persona: PersonaData;
  emotion: Record<string, unknown>;
  behavior: Record<string, unknown>;
  children: string[];
  created_at: string;
  max_context?: number;
  max_output?: number;
  reasoning_effort?: string;
  show_thinking?: string;
  mode?: string;
  fork_depth?: number;
  lifecycle?: string;
  context_config?: Record<string, unknown>;
  evolution?: Record<string, unknown>;
  sandbox_override?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentBrief {
  name: string;
  role: string;
}

/** Agent 注册表：config/agents.json 权威读取 + 原子保存 */
export class AgentRegistry {
  private agents: AgentState[] = [];
  private path: string;
  private loaded = false;

  constructor(path = AGENTS_PATH) {
    this.path = path;
  }

  async load(): Promise<AgentState[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      this.agents = Array.isArray(parsed) ? (parsed as AgentState[]) : [];
      this.loaded = true;
    } catch {
      this.agents = [];
      this.loaded = true;
    }
    return this.agents;
  }

  get loadedAgents(): AgentState[] {
    return this.agents;
  }

  async findAgent(agentId: string): Promise<AgentState | undefined> {
    if (!this.loaded) {
      await this.load();
    }
    return this.agents.find((a) => a.id === agentId);
  }

  async refresh(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  async names(): Promise<string[]> {
    if (!this.loaded) {
      await this.load();
    }
    return this.agents.map((a) => a.name);
  }

  async childrenOf(agent: AgentState): Promise<AgentBrief[]> {
    if (!this.loaded) {
      await this.load();
    }
    const out: AgentBrief[] = [];
    for (const childId of agent.children ?? []) {
      const child = this.agents.find((a) => a.id === childId);
      if (child) {
        out.push({ name: child.name, role: child.role });
      }
    }
    return out;
  }

  /** 原子写回（tmp + rename）；调用方负责并发语义（core-ts 单进程内串行即可） */
  async save(): Promise<void> {
    const { mkdir, rm } = await import("node:fs/promises");
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `${randomUUID().slice(0, 8)}.tmp`);
    await writeFile(tmp, JSON.stringify(this.agents, null, 2), "utf8");
    try {
      await rename(tmp, this.path);
    } catch (e) {
      // Windows 上 rename 覆盖目标偶发独占窗口失败（EBUSY/EPERM）→ 短重试后清理残留
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 30));
        try {
          await rename(tmp, this.path);
          return;
        } catch {
          // 继续重试
        }
      }
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  /** 更新单个 Agent 的若干字段并落盘（返回新状态） */
  async updateAgent(agentId: string, patch: Partial<AgentState>): Promise<AgentState | undefined> {
    const agent = await this.findAgent(agentId);
    if (!agent) {
      return undefined;
    }
    Object.assign(agent, patch);
    await this.save();
    return agent;
  }

  /**
   * 删除 Agent 及其全部子 Agent（对齐 Python delete_agent 语义）：
   * 递归收集 + 清理其余 Agent 悬空 children 引用 + 原子落盘。
   * 返回被删除的 id 集合（调用方可清理 history/data 等孤立数据）。
   */
  async removeAgent(agentId: string): Promise<string[]> {
    await this.load();
    const target = this.agents.find((a) => a.id === agentId);
    if (!target) {
      return [];
    }
    const toDelete = new Set<string>();
    const collect = (a: AgentState, visited: Set<string>): void => {
      if (visited.has(a.id)) { return; }
      visited.add(a.id);
      toDelete.add(a.id);
      for (const childId of a.children ?? []) {
        const child = this.agents.find((x) => x.id === childId);
        if (child) { collect(child, visited); }
      }
    };
    collect(target, new Set());
    this.agents = this.agents.filter((a) => !toDelete.has(a.id));
    // A-034 对齐：清理悬空 children 引用，防幽灵子 Agent
    for (const a of this.agents) {
      a.children = (a.children ?? []).filter((c) => !toDelete.has(c));
    }
    await this.save();
    return [...toDelete];
  }
}

/** 进程级单例（对齐 Python load_agents 全局态；服务层默认注入点） */
let registrySingleton: AgentRegistry | null = null;

export function getAgentRegistry(path = AGENTS_PATH): AgentRegistry {
  if (!registrySingleton) {
    registrySingleton = new AgentRegistry(path);
  }
  return registrySingleton;
}

export function resetAgentRegistry(): void {
  registrySingleton = null;
}