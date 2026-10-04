














import type { AgentState } from "./agents.js";
import { DEFAULT_EXEC_BUDGET_MS, normalizeModelPool, type SubagentDefinition } from "./subagent.js";










export function isSubagentDispatchAllowed(agent: Pick<AgentState, "subagent_dispatch">): boolean {
  return agent.subagent_dispatch !== false;
}









export function agentToSubagentDefinition(agent: AgentState): SubagentDefinition {
  const name = agent.name;
  const role = agent.role ?? "";
  return {
    name,
    description: `${name}：${role}`,
    systemPrompt: agent.identity_prompt?.trim() || `你是「${name}」，负责：${role}。`,
    agentId: agent.id,
    model: "inherit",
    timeoutMs: DEFAULT_EXEC_BUDGET_MS,
    outputSchema: true,
  };
}


export function dispatchableSubagentDefinitions(agents: readonly AgentState[]): SubagentDefinition[] {
  return agents.filter(isSubagentDispatchAllowed).map(agentToSubagentDefinition);
}


export function dispatchableAgentIds(agents: readonly AgentState[]): string[] {
  return agents.filter(isSubagentDispatchAllowed).map((a) => a.id);
}


export interface SubagentCatalogEntry {
  name: string;
  description: string;
  source: "user" | "builtin";
  model?: string;
}







export const SUBAGENT_CATALOG_LABELS = {
  agents: "可派发的 Agent（优先用）",
  builtin: "内置专家子代理",
} as const;

export interface GroupedSubagentCatalog {
  agents: SubagentCatalogEntry[];
  builtin: SubagentCatalogEntry[];
}


export function groupSubagentCatalog(catalog: readonly SubagentCatalogEntry[]): GroupedSubagentCatalog {
  return {
    agents: catalog.filter((c) => c.source === "user"),
    builtin: catalog.filter((c) => c.source !== "user"),
  };
}





export function renderSubagentCatalogLines(grouped: GroupedSubagentCatalog): string[] {
  const lines: string[] = [];
  if (grouped.agents.length > 0) {
    lines.push(`${SUBAGENT_CATALOG_LABELS.agents}：`);
    for (const c of grouped.agents) { lines.push(`- ${c.name}：${c.description}`); }
  }
  if (grouped.builtin.length > 0) {
    lines.push(`${SUBAGENT_CATALOG_LABELS.builtin}：`);
    for (const c of grouped.builtin) { lines.push(`- ${c.name}：${c.description}`); }
  }
  return lines;
}












export function renderSubagentModelSegments(models: readonly string[]): string[] {
  const pool = normalizeModelPool(models);
  if (pool.length === 0) { return []; }
  const lines = [
    "## 子代理执行模型（delegate_subagent 的 model 参数）",
    `默认执行档：${pool[0]}（不传 model 时，所有子代理都用它）`,
  ];
  if (pool.length > 1) {
    lines.push(`可点名换用：${pool.slice(1).join(" / ")}`);
    lines.push("可以按子任务难度分配档位：机械/批量活给便宜档，需要推理的给强档——同一轮里不同子代理允许用不同 model。");
  }
  lines.push('model 的取值必须是上面列出的**原样字符串**（`api:<key>[:<model>]` / `local:<id>`）；也可以传 "inherit" 让它跟随目标 Agent 的模型。');
  return [lines.join("\n")];
}


























export const DELEGATION_GUIDANCE =
  "子任务委派（delegate_subagent / subagent_result）——**默认派发，不要默认自己全做完**：" +
  "\n- **第一步先问自己**：这件事里有没有可以**独立出去**的部分（不需要跟我来回确认、不需要跟我共享同一份推理）？**有就派。**" +
  "不要用「我自己做也不难」当不派的理由——把冗长的中间过程放进子代理自己的上下文，你的上下文只留结论，这才是拆分的目的。" +
  "\n- **必须自己做的四类**（别硬拆，拆了更慢更贵）：" +
  "① **规划与拆解本身**（看清任务、定阶段、分派谁做什么）；" +
  "② **主干上的整合与门禁**（改主干代码、合并子代理产物、跑 tsc / 测试 / 构建这类必须串行且要看全局的活）；" +
  "③ **要跟用户来回确认的对话**（追问需求、澄清取舍、修改方案）；" +
  "④ **一次工具调用就能拿到答案的**（单文件读取、单文件精确查找、单次查询）。" +
  "\n- **尤其该派出去的**：联网调研 / 大范围代码搜索与审查 / 数据分析 / 批量处理 / 多方案比对 / 写独立的小模块 —— 这类**产出冗长**又**不需要跟用户来回确认**的活，" +
  "留在主上下文里只会把窗口撑爆，然后触发压缩、丢掉真正重要的主线信息。" +
  "\n- **怎么派（重要）**：`task` 必须写清 **①目标 ②期望的输出格式 ③边界**。只写一句「研究一下 X」会让子代理跑偏、或与另一个子代理重复劳动。" +
  "\n- **力度预算按复杂度伸缩**（决定「派多少」，不是「派不派」）：简单事实查找 / 单个小改动 → 1 个子代理（3–10 次工具调用）；直接对比 / 多文件同类修改 → 2–4 个；复杂研究 / 大范围重构 → 10+ 个，职责明确划分。" +
  "这是**启发式的上下限**，不是「预计超过 N 步才可派」那种硬门槛——拿不准就按上一档多派一个，宁可多派也别自己串行全做完。" +
  "\n- **一轮里一次性派出**：**有多个互不依赖的子任务时，就在同一轮里把它们全部派出**——同一轮的工具调用本来就并发执行，不必串着来（每个调用各自等自己的结果）。只有当你需要「派出去之后自己接着做别的、稍后再收」时才用 `background=true`，之后逐个 `subagent_result` 收口。" +
  "\n- **点名优先**：能在系统提示里看到「可用子代理」清单（名字 + 能力描述）时，**优先用清单里的名字**填 `agent` 点名——那才是为本项目配好的执行者；看不到清单、或清单里没有合适的，就留空交给系统按任务语义自动选。" +
  "\n- **临时子代理（现场定义，不必先建）**：清单里没有合适的人时，**不要退回自己全做**——直接在 `delegate_subagent` 里现场给出 `systemPrompt`（角色 + 约束），" +
  "并按需给 `tools`（工具白名单）/ `name`（展示名）/ `model`（档位），系统会据此**临时**造一个只跑这一次的执行者：**不写盘、不进清单、跑完即弃**。" +
  "适合一次性的专用活（例：只读某个 CSV 做统计的清洗工、只核对某类 API 的核对员）。" +
  "⚠️ 给了 `systemPrompt` / `tools` 时**不要再填 `agent`** —— 此时以现场定义为准，点名的那个不会生效。" +
  "\n- **必须验收**：子代理的产出会作为工具结果交回给你。先对照你下发的目标核对它是否真的完成、产物是否落地，再据其推进主线；产出不完整或结论存疑时，点名同一个子代理追问（`agent` 参数），或自己补齐。" +
  "**绝不要把子代理的结论不加核对地当作事实转述给用户。**";
