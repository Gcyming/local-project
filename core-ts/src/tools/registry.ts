/**
 * core-ts/src/tools/registry.ts — 统一工具注册表。
 * 语义移植自 tools/registry.py：
 * - 运行时注册/注销，同名拒绝覆盖（force 才覆盖）
 * - toLLMSchema 输出给 LLM 的统一格式
 * - 权限集合 {read, write, terminal, network}，默认 read（最小权限）
 */

export type ToolPermission = "read" | "write" | "terminal" | "network";

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

export class Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  executeFn: ToolExecutor;
  permissions: ToolPermission[];

  constructor(opts: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    executeFn: ToolExecutor;
    permissions?: ToolPermission[];
  }) {
    this.name = opts.name;
    this.description = opts.description;
    this.parameters = opts.parameters;
    this.executeFn = opts.executeFn;
    this.permissions = opts.permissions ?? ["read"];
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

  register(tool: Tool, force = false): boolean {
    if (this.tools.has(tool.name) && !force) {
      return false; // 同名拒绝覆盖
    }
    this.tools.set(tool.name, tool);
    return true;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listTools(): Record<string, unknown>[] {
    return [...this.tools.values()].map((t) => t.toLLMSchema());
  }

  listToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** 调用工具；未注册/异常统一返回 [错误] 前缀文本（对齐 registry.py 语义） */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[错误] 工具 '${name}' 未注册`;
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