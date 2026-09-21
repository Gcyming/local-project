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
  /** 调用前分类依据：让工具自述「这个动作本质是什么类型」。
   *  分类器不再靠工具名子串猜（adb_install 猜不出 write、http_list 被误判 network）；
   *  缺省由 permissions[0] 推导，保持向后兼容。 */
  riskKind?: ToolPermission;
  /** 是否允许分类器免审批自动放行。缺省 false —— 非只读工具一律走用户审批（fail-closed）。
   *  只有明确无副作用的动作（纯检索 / 纯读取型网络请求）才应声明 true。 */
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

  /** 分类器用：显式声明优先，否则取 permissions 里风险最高的一类 */
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
  /** A-968：schema 缓存（tool 的 name/description/parameters 固定；register/unregister 时失效）。
   *  避免每次请求遍历全量工具重建 schema（多模型池 + MCP 工具 40+ 时每次请求省 40 次 dict 构建） */
  private schemaCache: Record<string, unknown>[] | null = null;

  register(tool: Tool, force = false): boolean {
    if (this.tools.has(tool.name) && !force) {
      return false; // 同名拒绝覆盖
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
    // 返回拷贝——防止调用方 push/filter 原地修改污染缓存
    return this.schemaCache.map((s) => ({ ...s, function: { ...s.function as Record<string, unknown> } }));
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
    // 类别闸门 + 硬规则闸门（设置·权限 的 读/写/终端 开关真正生效点）——
    // 关闭的类别直接拒绝；命中硬规则（黑名单/敏感文件/受保护目录/越权）在**任何**审批档位下都拒绝。
    // 两者都在每次调用时实时判定，模型无法绕过。
    if (toolCategoryGate) {
      try {
        const gate = toolCategoryGate(tool, args);
        if (!gate.allowed) {
          const why = gate.reason ? `（${gate.reason}）` : "";
          return gate.kind === "safety"
            ? `[安全拦截] 工具 '${name}' 被硬规则拒绝${why}。这是不可绕过安全边界，请改用不触碰该边界的做法。`
            : `[权限已关闭] 工具 '${name}' 所属类别已被用户在「设置 → 权限」中禁用${why}。如需使用请先到设置中开启。`;
        }
      } catch { /* 闸门异常不阻断调用（fail-open 仅在闸门自身故障时，调用方沙箱与工具内护栏仍会兜底） */ }
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

/** 工具类别闸门：由装配层（GUI 主进程）注入，读取设置·权限的实时开关。
 *  返回 allowed=false 时 callTool 拒绝执行并回传原因给模型。
 *  `kind` 让拒绝文案如实区分来源（类别开关否决 / 硬规则安全拦截），二者对模型的后续动作指引不同。 */
export interface ToolGateDecision {
  allowed: boolean;
  reason?: string;
  /** category=类别开关关闭（可提示用户去设置开启）；safety=硬规则命中（不可绕过，只能换做法） */
  kind?: "category" | "safety";
}

/** `args` 让闸门能做**内容级**硬规则判定（写入路径 / 终端命令 / 目标 URL）；
 *  未声明该参数的老实现（只读 tool）仍然类型兼容。 */
export type ToolCategoryGate = (tool: Tool, args: Record<string, unknown>) => ToolGateDecision;

let toolCategoryGate: ToolCategoryGate | null = null;

/** 注入 / 清除工具类别闸门（rerun 时实时读取最新权限配置，不需要重启引擎） */
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