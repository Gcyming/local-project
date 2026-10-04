







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
  
  tool_profile?: import("./agentTools.js").ToolProfile;
  




  subagent_dispatch?: boolean;
  [key: string]: unknown;
}

export interface AgentBrief {
  name: string;
  role: string;
}


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

  
  async save(): Promise<void> {
    const { mkdir, rm } = await import("node:fs/promises");
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `${randomUUID().slice(0, 8)}.tmp`);
    await writeFile(tmp, JSON.stringify(this.agents, null, 2), "utf8");
    try {
      await rename(tmp, this.path);
    } catch (e) {
      
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 30));
        try {
          await rename(tmp, this.path);
          return;
        } catch {
          
        }
      }
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  
  async updateAgent(agentId: string, patch: Partial<AgentState>): Promise<AgentState | undefined> {
    const agent = await this.findAgent(agentId);
    if (!agent) {
      return undefined;
    }
    Object.assign(agent, patch);
    await this.save();
    return agent;
  }

  




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
    
    for (const a of this.agents) {
      a.children = (a.children ?? []).filter((c) => !toDelete.has(c));
    }
    await this.save();
    return [...toDelete];
  }
}


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