







export type ToolPermission = "read" | "write" | "terminal" | "network";

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

export class Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  executeFn: ToolExecutor;
  permissions: ToolPermission[];
  


  riskKind?: ToolPermission;
  

  autoApprovable: boolean;

  constructor(opts: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    executeFn: ToolExecutor;
    permissions?: ToolPermission[];
    riskKind?: ToolPermission;
    autoApprovable?: boolean;
  }) {
    this.name = opts.name;
    this.description = opts.description;
    this.parameters = opts.parameters;
    this.executeFn = opts.executeFn;
    this.permissions = opts.permissions ?? ["read"];
    this.riskKind = opts.riskKind;
    this.autoApprovable = opts.autoApprovable ?? false;
  }

  
  effectiveRiskKind(): ToolPermission {
    if (this.riskKind) { return this.riskKind; }
    const order: ToolPermission[] = ["read", "write", "terminal", "network"];
    let best: ToolPermission = "read";
    for (const p of this.permissions) {
      if (order.indexOf(p) > order.indexOf(best)) { best = p; }
    }
    return best;
  }

  toLLMSchema(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  

  private schemaCache: Record<string, unknown>[] | null = null;

  register(tool: Tool, force = false): boolean {
    if (this.tools.has(tool.name) && !force) {
      return false; 
    }
    this.tools.set(tool.name, tool);
    this.schemaCache = null;
    return true;
  }

  unregister(name: string): boolean {
    const ok = this.tools.delete(name);
    if (ok) { this.schemaCache = null; }
    return ok;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listTools(): Record<string, unknown>[] {
    if (!this.schemaCache) {
      this.schemaCache = [...this.tools.values()].map((t) => t.toLLMSchema());
    }
    
    return this.schemaCache.map((s) => ({ ...s, function: { ...s.function as Record<string, unknown> } }));
  }

  listToolNames(): string[] {
    return [...this.tools.keys()];
  }

  
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[错误] 工具 '${name}' 未注册`;
    }
    
    
    
    if (toolCategoryGate) {
      try {
        const gate = toolCategoryGate(tool, args);
        if (!gate.allowed) {
          const why = gate.reason ? `（${gate.reason}）` : "";
          return gate.kind === "safety"
            ? `[安全拦截] 工具 '${name}' 被硬规则拒绝${why}。这是不可绕过安全边界，请改用不触碰该边界的做法。`
            : `[权限已关闭] 工具 '${name}' 所属类别已被用户在「设置 → 权限」中禁用${why}。如需使用请先到设置中开启。`;
        }
      } catch {  }
    }
    try {
      const result = await tool.executeFn(args);
      return String(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `[错误] 工具 '${name}' 执行失败: ${msg}`;
    }
  }
}




export interface ToolGateDecision {
  allowed: boolean;
  reason?: string;
  
  kind?: "category" | "safety";
}



export type ToolCategoryGate = (tool: Tool, args: Record<string, unknown>) => ToolGateDecision;

let toolCategoryGate: ToolCategoryGate | null = null;


export function setToolCategoryGate(gate: ToolCategoryGate | null): void {
  toolCategoryGate = gate;
}

let globalRegistry: ToolRegistry | null = null;

export function getRegistry(): ToolRegistry {
  if (!globalRegistry) {
    globalRegistry = new ToolRegistry();
  }
  return globalRegistry;
}

export function resetRegistry(): void {
  globalRegistry = new ToolRegistry();
}