/**
 * core-ts/src/services/subagentCatalog.ts — 「哪些 Agent 可被派发为子代理」的**唯一出处**（A-1096）。
 *
 * 为什么必须单独成模块：
 *  ① 判据此前只活在 `gui/src/main/index.ts`（5000+ 行装配文件）里，**只能起 electron 才能验证**；
 *     抽成**纯模块**（无副作用；只从 `subagent.ts` 取常量与规范化函数，不碰 electron / node 内置）
 *     后可单测、可变异，也让"改坏了"能在测试里立刻显形；
 *  ② 同一语义有**两个渲染产地**（系统提示的「可用子代理」清单段 / 工具报错时的可操作提示），
 *     两处各写一遍分组与标签 ⇒ 迟早一处改了另一处没改，用户看到自相矛盾的两套说法。
 *     现在标签只有 `SUBAGENT_CATALOG_LABELS` 一处，分组只有 `groupSubagentCatalog` 一处。
 *
 * 业界依据（Anthropic《How we built our multi-agent research system》+《Building Effective Agents》）：
 *   - 协调器必须**知道能派给谁**（清单要进上下文），否则"配好了也派不到"；
 *   - description 是路由键，清单要短、要具体（占用上下文，且直接影响路由准确率）。
 */
import type { AgentState } from "./agents.js";
import { DEFAULT_EXEC_BUDGET_MS, normalizeModelPool, type SubagentDefinition } from "./subagent.js";

/**
 * 是否允许把该 Agent 派发为子代理（Agent 设置里的「同意被派发为子代理」开关）。
 *
 * 三态语义（**不许把 undefined 与 false 合并**——那会让"没设置过"被当成"明确拒绝"，
 * 新装的用户一个子代理都派不出去，症状是"功能好像没实现"）：
 *   - `undefined`（缺省，也是历史配置的样子）⇒ **允许**：开箱即可被派发；
 *   - `true`  ⇒ 允许（显式同意，语义与缺省一致）；
 *   - `false` ⇒ **拒绝**：不进候选清单、也不能被点名。
 */
export function isSubagentDispatchAllowed(agent: Pick<AgentState, "subagent_dispatch">): boolean {
  return agent.subagent_dispatch !== false;
}

/**
 * 把持久 Agent 映射成子代理定义。
 * - `description` 用 `名字：角色` 作自动委派的路由键（对齐 Claude Code「description 决定何时委派」）；
 * - `systemPrompt` 用身份提示（与主对话提示解耦）；
 * - `agentId` 绑定具体持久 Agent（子代理执行时据此解析模型/工具面）；
 * - 执行预算取 `DEFAULT_EXEC_BUDGET_MS`（**唯一真源**；历史上这里的 300s 正是 A-983 记录的
 *   "把做到 4/4 步的工作掐掉"的那个值，见 subagent.ts 的常量注释——不许再散落字面量）。
 */
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

/** 全部**允许派发**的 Agent → 子代理定义清单（装配层注册用）。顺序保持 registry 顺序，便于对照。 */
export function dispatchableSubagentDefinitions(agents: readonly AgentState[]): SubagentDefinition[] {
  return agents.filter(isSubagentDispatchAllowed).map(agentToSubagentDefinition);
}

/** 允许派发的 Agent id 清单（设置页回显勾选态用；与注册用的是**同一个判据**）。 */
export function dispatchableAgentIds(agents: readonly AgentState[]): string[] {
  return agents.filter(isSubagentDispatchAllowed).map((a) => a.id);
}

/** 子代理目录条目（与 `SubAgentManager.catalog()` 同构）。 */
export interface SubagentCatalogEntry {
  name: string;
  description: string;
  source: "user" | "builtin";
  model?: string;
}

/**
 * 清单分组标签的**唯一出处**。
 *
 * ⚠️ 措辞必须与"实际语义"一致：`source === "user"` 代表"用户自己的 Agent（已同意被派发）"，
 * 不再是"用户勾选的少数几个"——历史文案「用户选定的子代理」在默认全允许之后会变成**假描述**。
 */
export const SUBAGENT_CATALOG_LABELS = {
  agents: "可派发的 Agent（优先用）",
  builtin: "内置专家子代理",
} as const;

export interface GroupedSubagentCatalog {
  agents: SubagentCatalogEntry[];
  builtin: SubagentCatalogEntry[];
}

/** 按来源分组：自建 Agent（优先） / 内置专家。两个渲染产地共用本函数，杜绝分组口径漂移。 */
export function groupSubagentCatalog(catalog: readonly SubagentCatalogEntry[]): GroupedSubagentCatalog {
  return {
    agents: catalog.filter((c) => c.source === "user"),
    builtin: catalog.filter((c) => c.source !== "user"),
  };
}

/**
 * 渲染「可用子代理」清单行（**两个产地共用**：系统提示段 + 工具报错提示）。
 * 只渲染条目本身，标题/前后缀由调用方按场景补；这样措辞差异只留在场景相关的那一层。
 */
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

/**
 * 渲染「子代理执行模型池」段（A-1097）。
 *
 * 为什么必须进上下文：只让用户在设置页多选模型、却不告诉模型池子里有什么，
 * 模型就只能用兜底档那一个 —— **"能设置却没人用"= 死开关**（本项目已归档的静默失效家族就此一类）。
 * 所以池子必须可被模型看见，才能在 `delegate_subagent({model})` 里点名。
 *
 * 措辞要点：① 池首是**兜底档**（不传 model 时生效，语义与旧单值配置一致）；
 * ② 其余档位是"按子任务难度分工"的候选（对齐 Anthropic 的"按复杂度伸缩"）；
 * ③ 取值必须**原样**（路由字符串由调用方逐字透传，模型自己编一个不存在的会解析失败）。
 */
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

/**
 * 「子任务委派规范」的**唯一出处**（A-1106）。
 *
 * 为什么必须单独成常量：同一段规范此前**只有一个产地**（`ChatService.systemPromptFor`），
 * 于是另一条系统提示词产地 `Engine.buildSystem`（定时任务 / 非 ChatService 的引擎路径）
 * **完全拿不到委派引导** ⇒ 那些任务 100% 由主 Agent 单干，用户症状是
 * 「整个任务全是主 Agent 一个智能体做」。两处各写一遍同样会漂移，
 * 所以与清单标签、分组一样收成单一出处，两条产地共用。
 *
 * 措辞设计（A-1106 重平衡，依据 Anthropic《How we built our multi-agent research system》/
 * 《Building Effective Agents》的协调器范式，并用 Cognition《Don't Build Multi-Agents》
 * 的反方约束限定「不该拆」的场合）：
 *  ① 原版把「何时不委派」写成主句、把"自己做"当默认 ⇒ **实测效果就是模型全自己做完**。
 *     现在改成**默认派发**：先问"有没有能独立出去的部分"，有就派；把"自己做"收缩为
 *     四类**结构性例外**（规划 / 主干整合与门禁 / 强耦合对话 / 一次工具调用即可的活）。
 *     这也正是用户的明确要求：主 Agent 负责规划与主干，其余尽量派出去。
 *  ② 「任务分隔」是 Anthropic 实测的第一失效模式（只写一句"研究 X"⇒ 多个子代理重复劳动），
 *     所以 `task` 的 ①目标 ②输出格式 ③边界 写成硬要求。
 *  ③ 多智能体最大的失效模式是"不加核对地转述子代理结论"，所以验收要求必须留。
 *  ④ **力度预算分档**（A-1106/5b）：只有"默认派发"没有"派多少"，就是 Anthropic 记录的
 *     早期失效形态（"简单问题派 50 个子代理"）。故补上按复杂度分档的 effort budget
 *     （简单事实查找 1 个 / 直接对比 2–4 个 / 复杂研究 10+ 个）。
 *     ⚠️ 措辞必须写成**启发式上下限**而不是"预计超过 N 步才可派"那种**硬门槛** ——
 *     Anthropic 官方原话："instilling good heuristics rather than rigid rules"。
 */
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
