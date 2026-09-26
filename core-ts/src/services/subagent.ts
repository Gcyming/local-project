/**
 * core-ts/src/services/subagent.ts — 后台子代理管理器（Claude Code Subagents / nanobot Sub-Agent Manager 对标）。
 *
 * 语义对齐业界核心：
 * - 独立上下文：每个子代理 = 全新会话（fresh history），不继承主会话上下文 → 只回摘要，防上下文污染；
 * - 专用指令：def.systemPrompt 定制专家角色（与主 Agent 提示解耦）；
 * - 并行执行：并发上限 maxConcurrency（默认 3），用完即走；
 * - 后台运行：spawn 立即返回（fire-and-forget），结果/状态可查询，长任务不与主链路互抢；
 * - 上限收敛：并发槽位排队，绝不无限叠加（防 Claude Code 文档提示的"子代理管理成本>收益"）。
 *
 * v2 业界标准差距补齐（对照 Claude Code subagent frontmatter）：
 * - 模型路由：def.model 按子任务指定模型（简单子任务降级到便宜模型，压缩多智能体 token 成本）；
 * - 预算与生命周期：def.maxTurns 轮次预算 + def.timeoutMs 超时 + cancel(id) 取消（AbortSignal 端到端传播）；
 * - 结构化结果契约：def.outputSchema → run.structured {status/summary/artifacts/confidence}（文本 result 始终保留，向后兼容）；
 * - 声明式定义 + 自动委派：register() 注册 SubagentDefinition（含 description），delegate(task) 依 description 语义路由；
 * - 生命周期钩子：hooks.onStart / onComplete / onError（观测、改写、审计注入点）；
 * - 事件驱动：并发槽位 FIFO 唤醒队列 + wait(id) Promise 等待 + awaitIdle 独立队列，取代 busy-wait 轮询。
 *
 * v2.1 边缘缺陷修正：
 * - 取消意图登记（cancelRequested）：运行中任务被用户取消时正确标记 cancelled，不误判为 timeout；
 * - 槽位/空闲/完成三条等待队列分离，取消的排队任务被唤醒后把令牌传给下一个排队者，防丢令牌死锁。
 *
 * v2.2 语义修正：
 * - awaitIdle 改以 inflight（运行中+排队中总数）为等待条件，修复「排队任务被取消后 awaitIdle 可能提前返回」；
 * - 空闲唤醒统一移至 execute 收尾（inflight→0 时），notifyCompletion 只负责按 id 唤醒 wait()。
 *
 * 向后兼容：公开 API（spawn/status/list/awaitIdle/activeCount/构造签名）保持不变，
 * GUI 装配层（gui/src/main/index.ts）与既有调用无需修改即可编译；新能力全部为可选叠加。
 *
 * 引擎解耦：本模块不直接依赖 SlimeEngine——runner 由装配方注入（GUI main 用 engine.stream 实现），
 * 便于单测（注入 fake runner）与多端复用。持久化由装配方负责（状态 record 可序列化）。
 */
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// 声明式定义（业界 subagent frontmatter 对齐）
// ---------------------------------------------------------------------------

/**
 * 结构化子代理结果契约（业界 structured output 对齐）。
 * status：子代理自报完成度；summary：压缩摘要；artifacts：产物清单；confidence：0-1 置信度。
 */
export interface SubAgentResult {
  status: "completed" | "partial" | "failed";
  summary: string;
  artifacts: string[];
  confidence: number;
}

/** 派发一个子代理所需的完整声明（Claude Code subagent frontmatter 语义子集）。 */
export interface SubAgentDef {
  id?: string;
  /** 子代理名（展示/落盘/审计） */
  name: string;
  /** 交给子代理的任务指令（Claude Task 工具的 prompt 语义） */
  task: string;
  /** 专用系统提示（专家角色/约束/工作流；缺省由装配方用默认身份构建） */
  systemPrompt?: string;
  /** 执行模型所用 Agent id；缺省 = 装配方默认 Agent */
  agentId?: string;
  /** 工具白名单（缺省 = 引擎默认全部工具；对标子代理工具限制） */
  toolsOnly?: string[];
  /**
   * 模型路由：按子任务指定模型（对齐业界 `model` frontmatter）。
   * 简单/机械子任务可路由到更便宜的模型，压缩多智能体 token 成本（Anthropic 实测约 15×）。
   * 具体映射（别名 → 模型/Agent）由装配方负责，本模块只做透传。
   */
  model?: string;
  /** 联网搜索开关（断链 C 修复）：从父请求透传，子代理继承主 Agent 的联网策略；
   *  缺省 undefined → 引擎侧缺省即 true（保住 A-918+「缺省即开」语义，不传即开）。 */
  networkEnabled?: boolean;
  /** 轮次预算上限（对齐业界 `maxTurns`），由装配方在 runner 内执行 */
  maxTurns?: number;
  /** 墙钟超时（毫秒）；超时即中断并标记 timeout */
  timeoutMs?: number;
  /** 请求结构化结果契约；runner 被要求按 SubAgentResult 产出（见 parseStructuredResult） */
  outputSchema?: boolean;
  /**
   * A-1114：**临时子代理**标记 —— 由主 Agent 现场定义（inline spec）、只跑这一次的执行者。
   *
   * 与「声明式定义（SubagentDefinition）」的边界，四条都要成立：
   *   ① **不落盘**：绝不写 `config/agents.json`，不产生持久 Agent；
   *   ② **不进清单**：`catalog()` 只遍历 `this.defs`，带此标记的 def 从不注册进去，
   *      所以主 Agent 的「可用子代理」段里**不会**出现它（下次也别指望点名点得到）；
   *   ③ **不参与路由**：`delegate()` 见到它**直接合成派发**，跳过 `findByName` / `matchDefinition`
   *      —— 现场定义比清单里任何人都更贴合本次任务，再拿去做语义打分只会选错人；
   *   ④ **跑完即弃**：除 `runs` 里的那条记录外不留任何痕迹，进程重启即无痕。
   *
   * 为什么不做成"注册一个临时定义再删掉"：那会出现在 `catalog()` 里、被并发派发看到的清单污染，
   * 还要处理"何时删"（跑完？进程退出？）—— 那不叫临时，那叫**持久但难清理**。
   */
  adhoc?: boolean;
}

/**
 * 声明式子代理定义（自动委派用）。description 是路由键：
 * 主 Agent / 调度器依任务与 description 的语义匹配决定委派给哪个子代理（业界 description-based 委派）。
 */
export interface SubagentDefinition {
  /** 定义名（唯一） */
  name: string;
  /** 何时使用本子代理的自然语言描述（自动委派的路由依据；写得越清晰，路由越准） */
  description: string;
  /** 专用系统提示（专家角色） */
  systemPrompt?: string;
  /** 绑定执行此定义的具体持久 Agent（agentId）；缺省 = 装配方默认 Agent */
  agentId?: string;
  /** 默认模型路由 */
  model?: string;
  /** 默认工具白名单 */
  toolsOnly?: string[];
  /** 默认轮次预算 */
  maxTurns?: number;
  /** 默认超时（毫秒） */
  timeoutMs?: number;
  /** 默认结构化输出开关 */
  outputSchema?: boolean;
  /**
   * 是否由用户显式选定（设置→子代理菜单勾选的自建 agent）。
   * 自动委派优先级：userSelected 定义 > 内置专家定义（对齐 Claude Code「用户自定义 subagent 优先于内置」）。
   */
  userSelected?: boolean;
}

export type SubAgentStatus =
  | "pending"
  | "running"
  | "done"
  | "fail"
  | "timeout"
  | "cancelled";

export interface SubAgentRun {
  id: string;
  name: string;
  status: SubAgentStatus;
  startedAt?: number;
  finishedAt?: number;
  /**
   * A-980-R31：派发时的任务指令。
   *
   * 为什么必须进记录：运行记录此前只有 name/时间/结果，用户点开详情**看不到这次到底让它做什么**，
   * 也无从判断"超时是因为任务太大还是模型太慢"。落盘持久化后，这是唯一的任务溯源字段
   * （用户反馈"明明已经有子代理出现过了，虽然失败了，但是怎么一个记录都没有"）。
   */
  task?: string;
  /**
   * A-980-R31：本次运行实际生效的墙钟预算（毫秒；undefined/0 = 不限时）。
   * 面板据此显示"限时 120s"并解释超时归因，避免"为什么被判超时"无从追问。
   */
  timeoutMs?: number;
  /**
   * 结果**摘要**（完整产物由装配方落盘 data/generated/subagent-*.md）。
   * A-980-R31：中断（timeout/cancelled）时**保留中断前已产出的部分正文**，不再置空。
   */
  result?: string;
  /** 结构化结果（仅当 def.outputSchema=true 且子代理产出可解析时填充） */
  structured?: SubAgentResult;
  error?: string;
  /** 命中的声明式定义名（delegate 自动委派时记录，便于审计） */
  definitionName?: string;
  /** 实际路由的模型（def.model/委派覆盖合成，全局默认档回填；inherit 语义不写） */
  model?: string;
}

/** 派发上下文：透传 AbortSignal，runner 可据此实现端到端取消/超时中断。 */
export interface SubAgentRunContext {
  signal: AbortSignal;
  /** 联网搜索开关（断链 C 修复）：父请求透传，runner 据此决定子代理能否联网；缺省 undefined = 引擎缺省即开。 */
  networkEnabled?: boolean;
}

/**
 * 装配注入的执行器：跑一轮独立上下文 AgentLoop，返回最终正文（摘要）。
 * 可选第二参 ctx.signal 用于取消/超时传播；旧单参 runner 依然兼容。
 */
export type SubAgentRunner = (
  def: SubAgentDef,
  ctx?: SubAgentRunContext,
) => Promise<string>;

// ---------------------------------------------------------------------------
// 生命周期钩子（业界 hooks 对齐）
// ---------------------------------------------------------------------------

export interface SubAgentHooks {
  /**
   * A-1106/5b：**派发即触发** —— `spawn()` 里 run 刚进 `runs`、状态还是 `pending` 时。
   *
   * 为什么必须补这一条：`onStart` 只在**拿到并发槽位、即将调用 runner** 时触发。
   * 并发槽位被占满时，新派发的子代理会**长时间停在 pending**，这期间一个事件都不发
   * ⇒ 悬浮面板只能靠轮询兜底，用户看到的是「我派了 3 个，面板上只显示 1 个」。
   * 本钩子把「派发（queued）」这一状态变化也补进事件流，让面板**事件驱动**而不是靠 3 秒轮询
   * （对齐 A2A 的 TaskStatusUpdateEvent：queued 与 working 都是应当发出的状态）。
   */
  onSpawn?: (run: SubAgentRun, def: SubAgentDef) => void | Promise<void>;
  /** 进入执行（拿到并发槽位、即将调用 runner）时触发 */
  onStart?: (run: SubAgentRun, def: SubAgentDef) => void | Promise<void>;
  /** 成功完成时触发（result/structured 已就绪） */
  onComplete?: (run: SubAgentRun, def: SubAgentDef) => void | Promise<void>;
  /** 失败/超时/取消时触发（run.error 已就绪；status 区分原因） */
  onError?: (run: SubAgentRun, def: SubAgentDef) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// 结构化结果解析（宽松契约：优先 JSON 块，回退最后 JSON 对象；解析不到不阻塞文本结果）
// ---------------------------------------------------------------------------

/**
 * 子代理**默认执行预算**（ms）= 一个子代理最多能跑多久。
 *
 * ⚠️ 与「主 Agent 愿意等多久」（工具参数 `timeoutMs`，见 builtin.ts 的 `SUBAGENT_WAIT_DEFAULT`）
 * 是**两个不同的量**，且**等待必须 ≥ 预算** —— 否则预算还没到期，主 Agent 就先撤了，
 * 表现成"每次都超时"却根本没用满预算。
 *
 * 取值依据（2026-09-17 实测复盘）：审计日志记录了一次真实派发——
 *   05:32:31 派发 → 05:34:00 完成 1/4 → 05:35:14 完成 3/4（第 4 步 in_progress）
 *   → **05:37:31 撞 300s 被杀**。即"不是功能坏了，是预算把 95% 完成的工作掐掉了"。
 * 数据统计/全量扫描这类任务（8M 行、多文件）本就以分钟计，300s 必然常态失败；
 * 预算只应作为**防挂死**的下限保障，不该成为常态失败源。故放宽到 15 分钟。
 */
export const DEFAULT_EXEC_BUDGET_MS = 900_000;

/**
 * A-1097：子代理执行模型池的**规范化唯一出处**（装配层 / IPC / 单元测试共用同一判据）。
 *
 * 为什么必须有这个函数，而不是各处 `filter(...)` 完事：
 *  ① 池子是用户多选出来的，输入可能带空串/重复/`inherit`（"继承"是**不覆盖**的占位，
 *     不是档位——若放进池首，会退化成 A-975 修过的那个 bug："能设置却不生效"）；
 *  ② 池首是**执行兜底档**，所以顺序有意义（去重要保序，不能排序）；
 *  ③ 上限只防手滑（多选窗口一次全选上百个模型没有意义），取 12 个足够覆盖"便宜/中/强/本地"分工。
 */
export const SUBAGENT_MODEL_POOL_MAX = 12;

/**
 * A-1122：**子代理会话 id 前缀的唯一出处**。
 *
 * 子代理的流必须带专属 sessionId，否则 chunk 的 sessionId 为 undefined，渲染层会把子代理
 * chunk 误判成主 Agent 流（主 Agent 监测栏被污染，A-978 的用户实测）。
 *
 * ⚠️ 这个字面量此前**存在于三处**（`gui/src/main/index.ts` 的 `SUBAGENT_SESSION_PREFIX`、
 * `todoStore.ts` 的注释与推导、以及这里新增的消费者）。分成多份的症状是**静默的**：
 * 前缀一改，只有改动过的那一处继续生效，其余几处照旧"看着对"——
 * 对文件回滚来说，那意味着**子代理改过的文件再也无法被回滚**，且没有任何报错。
 * ⇒ 现在只有这一份；`gui/src/main/index.ts` 从这里 import。
 */
export const SUBAGENT_SESSION_PREFIX = "__subagent__:";

/** 这个会话 id 是不是子代理的（文件回滚据此把子代理的改动算到「当时那一轮」头上） */
export function isSubagentSessionId(sid: unknown): boolean {
  return typeof sid === "string" && sid.startsWith(SUBAGENT_SESSION_PREFIX);
}


export function normalizeModelPool(input: unknown): string[] {
  if (!Array.isArray(input)) { return []; }
  const out: string[] = [];
  for (const x of input) {
    const v = typeof x === "string" ? x.trim() : "";
    if (!v || v === "inherit") { continue; }
    if (out.includes(v)) { continue; }
    out.push(v);
    if (out.length >= SUBAGENT_MODEL_POOL_MAX) { break; }
  }
  return out;
}

/**
 * A-1114：把子代理名收敛成**可安全落盘**的一段文件名（唯一出处，落盘前必经）。
 *
 * 为什么必须有：`delegate_subagent` 新增 `name` 入参后，**产物文件名第一次由模型决定**。
 * 模型写出 `a/b`、`..`、`报告:1`、`x*y` 这类名字时，`join(dir, `subagent-${name}-${stamp}.md`)` 会：
 *   - `a/b` → 多出一层不存在的目录 ⇒ `writeFileSync` 抛 ENOENT ⇒ **整个子代理被判失败**，
 *     而错误信息指向路径，谁也看不出是"名字里有个斜杠"；
 *   - `..` → 写出 `data/generated` 之外（路径逃逸）；
 *   - `:` `*` `?` `"` `<` `>` `|` → Windows 非法字符，同样抛异常。
 * 三条都是"模型一换措辞就翻车"的形态，且**修在调用点会漏**（落盘点不止一处时会漂移），
 * 故收敛为纯函数，由落盘方与单测共用。
 *
 * ⚠️ 只作用于**文件名**：`run.name`（界面展示 / 审计 / 清单）保留原文，**不做改写** ——
 * 用户看到的必须是他/模型给的那个名字，被替换过就成了假陈述。
 */
export function sanitizeSubagentRunName(raw: string): string {
  const cleaned = (raw ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\.\.+/g, "_")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned.slice(0, 64) || "unnamed";
}

const STRUCTURED_INSTRUCTION =
  "请在最终回复末尾输出一个 JSON 代码块，形如 ```json {\"status\":\"completed|partial|failed\",\"summary\":\"...\",\"artifacts\":[\"...\"],\"confidence\":0.0} ```";

/** 从子代理自由文本中尽力解析结构化结果；解析失败返回 null（不影响文本 result）。 */
export function parseStructuredResult(text: string): SubAgentResult | null {
  if (!text) { return null; }
  // 1) 优先：```json ...``` 代码块
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fence?.[1]) { candidates.push(fence[1]); }
  // 2) 回退：文本中最后一个 {...} JSON 对象
  const lastBrace = text.lastIndexOf("{");
  const lastClose = text.lastIndexOf("}");
  if (lastBrace >= 0 && lastClose > lastBrace) {
    candidates.push(text.slice(lastBrace, lastClose + 1));
  }
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Partial<SubAgentResult>;
      if (obj && typeof obj === "object" && (obj.summary || obj.status)) {
        return normalizeStructured(obj);
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

function normalizeStructured(obj: Partial<SubAgentResult>): SubAgentResult {
  const statusRaw = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  const status: SubAgentResult["status"] =
    statusRaw === "completed" || statusRaw === "partial" || statusRaw === "failed"
      ? (statusRaw as SubAgentResult["status"])
      : "completed";
  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.min(1, Math.max(0, obj.confidence))
      : 0.5;
  return {
    status,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    artifacts: Array.isArray(obj.artifacts)
      ? obj.artifacts.filter((a): a is string => typeof a === "string")
      : [],
    confidence,
  };
}

// ---------------------------------------------------------------------------
// 子代理管理器
// ---------------------------------------------------------------------------

function isTerminal(s: SubAgentStatus): boolean {
  return s === "done" || s === "fail" || s === "timeout" || s === "cancelled";
}

export class SubAgentManager {
  private runner: SubAgentRunner;
  private hooks: SubAgentHooks;
  private runs = new Map<string, SubAgentRun>();
  private controllers = new Map<string, AbortController>();
  private defs = new Map<string, SubagentDefinition>();
  /** 取消意图登记表（区分「用户取消」与「超时中断」；运行中任务状态由 execute 统一收尾） */
  private cancelRequested = new Set<string>();
  /** 运行中（占用槽位）的子代理数 */
  private active = 0;
  /** 在途（已派发、含排队中）的子代理数 —— awaitIdle 的等待条件 */
  private inflight = 0;
  private readonly maxConcurrency: number;
  /**
   * 全局子代理**执行模型池**（A-1097：由「单个默认模型」升级为可多选的池）。
   *
   * 为什么从单值升级：只允许指定一个执行模型时，主 Agent 面对"便宜的做机械活 / 强的做难活"
   * 这种天然分工**无从选择**——它只有一个档位可用（用户原话：「只能指定一个，还是太少了」）。
   * 现在可多选，且：
   *   - `models[0]` = **执行兜底档**（未显式指定 model 时用），保持 A-975/A-942 的"贵模型统筹、
   *     廉价模型执行"语义不变（旧单值配置读进来就是只有一个元素的池子）；
   *   - 整个池子会写进系统提示，主 Agent 可按子任务难度**为不同子代理点名不同档位**。
   * 路由优先级仍是：委派/调用显式 model > 声明式定义 def.model > 池首（兜底档）> inherit。
   * 格式：`api:<key>[:<model>]` / `local:<id>`；`inherit` 不是池内档位（它是"不覆盖"的占位）。
   */
  private defaultModels: string[];
  /** 并发槽位排队 FIFO（execute 专用）：每次槽位释放恰好唤醒一个（取代 busy-wait 轮询） */
  private slotWaiters: Array<() => void> = [];
  /** awaitIdle 专用等待队列（与槽位队列隔离，inflight→0 时整体唤醒） */
  private idleWaiters: Array<() => void> = [];
  /** wait(id) 的完成通知器（按 run id 精确唤醒，取代轮询 status） */
  private completionWaiters = new Map<string, Array<() => void>>();

  constructor(
    runner: SubAgentRunner,
    opts: { concurrency?: number; hooks?: SubAgentHooks; defaultModel?: string; defaultModels?: string[] } = {},
  ) {
    this.runner = runner;
    this.hooks = opts.hooks ?? {};
    this.maxConcurrency = Math.max(1, opts.concurrency ?? 3);
    // 兼容：旧调用点传单值 defaultModel ⇒ 视为只有一个元素的池；新调用点传 defaultModels。
    this.defaultModels = normalizeModelPool(opts.defaultModels ?? (opts.defaultModel ? [opts.defaultModel] : []));
  }

  /** 当前并发进行中的子代理数 */
  get activeCount(): number {
    return this.active;
  }

  // -------------------------------------------------------------------------
  // 声明式定义注册 + description 自动委派
  // -------------------------------------------------------------------------

  /** 注册/覆盖一个声明式子代理定义（description 作为自动委派的路由键）。 */
  register(def: SubagentDefinition): void {
    this.defs.set(def.name, def);
  }

  /** 注销一个声明式定义。 */
  unregister(name: string): boolean {
    return this.defs.delete(name);
  }

  /**
   * 同步「自定义 Agent 子代理定义」（A-1096 起 = 全部**同意被派发**的持久 Agent，见
   * `services/subagentCatalog.ts::dispatchableSubagentDefinitions`）。
   * 先清除上一批 userSelected 定义，再注册新的一批（打 userSelected:true），
   * 保证派发优先级「自建 Agent > 内置专家」始终反映最新授权状态。
   *
   * ⚠️ 历史语义（A-918+）：这里只登记用户在设置页**勾选**的少数几个 agent，默认勾选为空
   * ⇒ 一个自建 Agent 都派不出去（"配好了也派不到"）。A-1096 起授权改为**每个 Agent 自己的
   * `subagent_dispatch` 开关**（缺省即允许），不再依赖独立的勾选文件。
   */
  setUserSelected(defs: SubagentDefinition[]): void {
    for (const [name, def] of this.defs.entries()) {
      if (def.userSelected) { this.defs.delete(name); }
    }
    for (const d of defs) {
      this.defs.set(d.name, { ...d, userSelected: true });
    }
  }

  /** 当前用户选定的子代理定义清单（GUI 回显用）。 */
  listUserSelected(): SubagentDefinition[] {
    return [...this.defs.values()].filter((d) => d.userSelected).map((d) => ({ ...d }));
  }

  /**
   * 设置全局子代理**执行模型池**（A-1097）。`models[0]` 即执行兜底档。
   * 设置后新派发的子代理在无显式 model 与 def.model 时应用；运行中的不受影响。
   * 传入值一律过 `normalizeModelPool`（去空/去重/剔 `inherit`/限长）。
   */
  setDefaultModels(models: unknown): void {
    this.defaultModels = normalizeModelPool(models);
  }

  /** 兼容旧调用点：单值即"只有一个档位的池"。 */
  setDefaultModel(model: string): void {
    this.setDefaultModels(model ? [model] : []);
  }

  /** 当前执行模型池（设置页回显用；顺序即优先级，[0] 为兜底档）。 */
  getDefaultModels(): string[] {
    return [...this.defaultModels];
  }

  /** 当前兜底档（= 池首；空串 = 不覆盖，回退 inherit）。兼容旧调用点。 */
  getDefaultModel(): string {
    return this.defaultModels[0] ?? "";
  }

  /** 已注册的声明式定义清单。 */
  listDefinitions(): SubagentDefinition[] {
    return [...this.defs.values()].map((d) => ({ ...d }));
  }

  /**
   * A-980-R30：子代理**目录**（注入系统提示用）。
   *
   * 为什么必须有：此前可用子代理只存在于管理器内部，模型**完全不知道**能问谁——
   * 工具描述里硬编码了"代码审查 / 联网调研 / 数据分析"三个方向，用户勾选的自建 Agent
   * 名字从不进入提示词 → 用户配好了也永远派不到，这正是"设置像摆设"的根因。
   * 对标 Claude Code：`description` 就是自动路由键，且**清单要写进上下文**，
   * 模型才能做「按描述自动选人」或「显式点名」两种委派。
   */
  catalog(): Array<{ name: string; description: string; source: "user" | "builtin"; model?: string }> {
    return [...this.defs.values()].map((d) => ({
      name: d.name,
      description: d.description,
      source: d.userSelected ? ("user" as const) : ("builtin" as const),
      ...(d.model && d.model !== "inherit" ? { model: d.model } : {}),
    }));
  }

  /**
   * A-980-R30：按名字定位定义（主 Agent **点名委派**用）。
   * 匹配顺序：精确（忽略大小写）→ 包含（双向），保证「用代码审查员审查这段」这类自然说法能命中。
   * 与 matchDefinition 的语义打分互补：点名优先于打分（对齐 Claude Code「显式点名绕过自动匹配」）。
   */
  findByName(name: string): SubagentDefinition | null {
    const q = (name ?? "").trim().toLowerCase();
    if (!q) { return null; }
    const all = [...this.defs.values()];
    const exact = all.find((d) => d.name.toLowerCase() === q);
    if (exact) { return { ...exact }; }
    const loose = all.find((d) => {
      const n = d.name.toLowerCase();
      return n.includes(q) || q.includes(n);
    });
    return loose ? { ...loose } : null;
  }

  /**
   * description 自动委派：依据任务文本与各定义 description 的语义匹配选出最合适的子代理。
   * 采用可解释的关键词重叠打分（中英文均按字符/词元归一），零外部依赖、可单测。
   * A-918+：两段式优先级——先在「用户选定（userSelected）」定义里打分取最优；
   * 无命中再在「内置专家（非 userSelected）」里打分取最优。用户选定子代理 > slime 自建。
   * 返回命中的定义；无任何正分匹配时返回 null（调用方 delegate() 会走「自动创建补充」兜底）。
   */
  matchDefinition(task: string): SubagentDefinition | null {
    let bestUser: { def: SubagentDefinition; score: number } | null = null;
    let bestBuiltin: { def: SubagentDefinition; score: number } | null = null;
    for (const def of this.defs.values()) {
      const score = overlapScore(task, def.description);
      if (score <= 0) { continue; }
      if (def.userSelected) {
        if (!bestUser || score > bestUser.score) { bestUser = { def, score }; }
      } else if (!bestBuiltin || score > bestBuiltin.score) {
        bestBuiltin = { def, score };
      }
    }
    // 优先级：用户选定 > 内置专家
    const best = bestUser ?? bestBuiltin;
    return best ? { ...best.def } : null;
  }

  /**
   * 自动委派派发：先按 description 匹配定义（用户选定优先），再用定义默认值 + 任务合成 SubAgentDef 派发。
   * A-918+：无任何匹配定义时【不再返回 null】，而是自动 synthesize 一个通用子代理兜底
   * （对齐 Claude Code「主对话可创建任意子代理」——选定/内置都不足时自动创建补充）。
   *
   * A-980-R30：新增 `overrides.agent`——**点名优先于语义打分**（对齐 Claude Code「显式点名绕过自动匹配」）。
   * 点名没命中时**不静默回落到打分结果**，而是返回 null 让工具层如实告诉模型"没这个子代理 + 现有清单"，
   * 否则模型会以为点名生效、把结果归因到错误的执行者。
   * 返回派发的 run 记录。
   */
  delegate(task: string, overrides: Partial<SubAgentDef> & { agent?: string } = {}): SubAgentRun | null {
    // A-1114 临时子代理（inline spec）：现场给了**定义内容**（systemPrompt / toolsOnly）就
    // **不再去清单里找人**——现场定义比清单里任何人都更贴合本次任务，再拿去做语义打分只会选错。
    // 判据只看这两个字段：`name` 单独出现**不构成定义**（那只是改个展示名），
    // 否则模型随手填个 name 就会意外绕过点名 / 自动路由，变成一个说不清的第三种行为。
    const adhoc = overrides.adhoc === true
      && (!!overrides.systemPrompt?.trim() || (overrides.toolsOnly?.length ?? 0) > 0);
    if (!adhoc) {
      const wanted = (overrides.agent ?? "").trim();
      if (wanted) {
        const named = this.findByName(wanted);
        if (!named) { return null; } // 点名失败必须如实上报，交由工具层列出可用清单
        return this.spawnFromDef(named, task, overrides);
      }
      const def = this.matchDefinition(task);
      if (def) { return this.spawnFromDef(def, task, overrides); }
    }
    // 不足自动创建 / 临时代理：合成一个只跑这一次的执行者（不中断主链路，只回摘要）。
    // ⚠️ 两条路**共用同一处合成逻辑**：临时代理不是「另一条派发路径」，
    // 它只是**不做路由**的那条 —— 拆成两段各写一遍就是下一个漂移源（改一处漏一处）。
    const autoName = `${adhoc ? "临时代理" : "通用助手"}（${task.slice(0, 12).replace(/\s+/g, " ").trim()}）`;
    return this.spawn({
      name: overrides.name ?? autoName,
      task,
      systemPrompt: overrides.systemPrompt ?? "你是通用任务执行助手，独立完成指派任务并返回简洁摘要。",
      // A-1114：带上 adhoc 标记（spawn 据此不把名字误记成「命中的声明式定义名」）。
      ...(adhoc ? { adhoc: true } : {}),
      agentId: overrides.agentId,
      toolsOnly: overrides.toolsOnly,
      model: overrides.model,
      maxTurns: overrides.maxTurns,
      // A-980-R31：兜底预算从 120s 放宽到 300s。真实 agentic 子任务（多轮检索/审查/计算）
      // 在 120s 内跑完本就少见，配上此前"abort 不生效"的实现，结果是**必然被判超时**。
      // A-983：300s 仍然不够 —— 审计日志实录一次真实派发（2026-09-17 05:32:31）：
      //   05:35:14 子代理已经做到第 4/4 步（probe-4 in_progress），**05:37:31 撞 300s 被杀**。
      //   即"不是功能坏了，是预算把 95% 完成的工作掐掉了"，用户体感就是"全部超时、从没成功过"。
      //   数据统计/全量扫描这类任务（8M 行、多文件）本就以分钟计，故放宽到 15 分钟。
      //   预算只是**防挂死**的下限保障，不该成为常态失败源；wait 上限严格大于它。
      timeoutMs: overrides.timeoutMs ?? DEFAULT_EXEC_BUDGET_MS,
      outputSchema: overrides.outputSchema,
      // 断链 C 修复：兜底合成子代理同样继承父请求的联网开关（未传 = undefined → 引擎缺省即开）。
      networkEnabled: overrides.networkEnabled,
    });
  }

  /** 由声明式定义 + 委派覆盖合成 SubAgentDef 并派发（点名与打分两条路径共用） */
  private spawnFromDef(def: SubagentDefinition, task: string, overrides: Partial<SubAgentDef>): SubAgentRun {
    return this.spawn({
      name: overrides.name ?? def.name,
      task,
      systemPrompt: overrides.systemPrompt ?? def.systemPrompt,
      agentId: overrides.agentId ?? def.agentId,
      toolsOnly: overrides.toolsOnly ?? def.toolsOnly,
      model: overrides.model ?? def.model,
      maxTurns: overrides.maxTurns ?? def.maxTurns,
      timeoutMs: overrides.timeoutMs ?? def.timeoutMs,
      outputSchema: overrides.outputSchema ?? def.outputSchema,
      // A-1096 修复（静默缺陷）：**这条路径此前漏传联网开关**——delegate() 的两条主路
      // （点名 spawnFromDef / 打分 spawnFromDef）全部经由这里，而只有"无匹配时的兜底合成"
      // 走了 spawn（那里有 networkEnabled）。即：用户关掉联网后，**只要子代理是命中定义的**
      // 就照样偷偷联网（与"关了还联网"的旧缺陷同形，只是漏在了另一条分支上）。
      networkEnabled: overrides.networkEnabled,
    });
  }

  // -------------------------------------------------------------------------
  // 派发 / 查询 / 取消 / 等待
  // -------------------------------------------------------------------------

  /** 派发一个后台子代理：立即返回 run 记录（fire-and-forget），执行走并发槽位。
   *  模型路由：def.model 缺省时应用全局默认模型（无显式定义时即"全局子代理模型档"）。 */
  spawn(def: SubAgentDef): SubAgentRun {
    // A-975：`inherit` 语义 = 「跟随主对话（目标 Agent）模型」——它是**继承占位**而非显式档位，
    // **不应遮挡**用户配置的执行模型池。优先级：显式 api:/local: 具体模型
    // > 执行模型池首（兜底档）> inherit(继承目标 Agent)。此前 `|| this.defaultModel` 因 inherit 非空导致
    // 内置专家（model:"inherit"）永远继承主对话模型，用户设的"执行档"模型对它们无效（"能设置却不生效"根因）。
    // A-1097：兜底档从"唯一的那个模型"变成"池首"——池子里其余档位供主 Agent 按子任务难度点名（见系统提示）。
    const raw = (def.model ?? "").trim();
    const fallbackTier = this.defaultModels[0] ?? "";
    const effectiveModel = (!raw || raw === "inherit") ? fallbackTier : raw;
    const run: SubAgentRun = {
      id: def.id ?? randomUUID(),
      name: def.name,
      status: "pending",
      task: def.task,
      ...(def.timeoutMs && def.timeoutMs > 0 ? { timeoutMs: def.timeoutMs } : {}),
    };
    run.model = effectiveModel;
    // A-1114：临时子代理**没有**命中的声明式定义 —— 名字撞上清单里的同名定义也不能记成它，
    // 否则审计里会出现「临时代理被记成用了「代码审查员」定义」这种假归因（比没有字段更坏）。
    if (!def.adhoc && this.defs.has(def.name)) {
      run.definitionName = def.name;
    }
    this.runs.set(run.id, run);
    // A-1106/5b：**派发即出声**（status 仍是 pending）—— 只靠 onStart 的话，并发槽位被占满时
    // 新派发的子代理会一直停在 pending 且不发事件，面板要等下一次轮询才看得到它。
    // fire-and-forget（spawn 是同步 API，必须立刻返回 run）；钩子异常由 fireHook 吞掉，不影响派发。
    void this.fireHook(this.hooks.onSpawn, run, def);
    void this.execute(run, effectiveModel ? { ...def, model: effectiveModel } : def);
    return run;
  }

  status(id: string): SubAgentRun | undefined {
    const r = this.runs.get(id);
    return r
      ? { ...r, structured: r.structured ? { ...r.structured } : undefined }
      : undefined;
  }

  /** 全部记录快照（观察/持久化用） */
  list(): SubAgentRun[] {
    return [...this.runs.values()].map((r) => ({
      ...r,
      structured: r.structured ? { ...r.structured } : undefined,
    }));
  }

  /**
   * A-980-R31：丢弃**已终态**的运行记录（"清空历史"用）。
   *
   * 为什么不顺手清全部：运行中/排队中的任务是**在途工作**，用户点"清空记录"要清的是
   * 跑完的痕迹，不是把正在干活的子代理一起干掉（那会变成静默的数据丢失）。
   * 返回被丢弃的条数；单测与设置页按钮据此给回执。
   */
  forgetTerminal(): number {
    let n = 0;
    for (const [id, run] of this.runs) {
      if (isTerminal(run.status)) {
        this.runs.delete(id);
        n++;
      }
    }
    return n;
  }

  /**
   * 事件驱动等待某个子代理到达终态（done/fail/timeout/cancelled）。
   * 取代「轮询 status」；超时兜底防挂死。返回终态快照，未知 id 立即返回 undefined。
   *
   * ⚠️ A-1106：`signal` 是**中断通路**（此前没有）。前台委派默认会 `await` 到子代理终态，
   *    等待上限 960s（= 执行预算 900s + 60s 收尾余量，必须 > 预算，见 tools/builtin 的常量注释）。
   *    在没有中断通路时，用户点「停止生成」只能停住主 Agent 的模型流 —— 卡在这个 await 里的
   *    工具调用**照旧等满全程**（最长约 16 分钟），界面上表现为「停止按钮没反应」。
   *
   *    abort 时**只结束等待、不取消子代理**（保守取舍：子代理可能已跑了几分钟、只差最后一步，
   *    回杀会白白丢掉它的产出）。上层据此如实回执，并告知可用 `subagent_result` 取回结果。
   */
  async wait(id: string, timeoutMs = 300_000, signal?: AbortSignal): Promise<SubAgentRun | undefined> {
    const existing = this.runs.get(id);
    if (!existing) { return undefined; }
    if (isTerminal(existing.status)) { return this.status(id); }
    // 已经中断：不进等待，立刻把当前快照如实交回（状态多半还是 running，由调用方归因）
    if (signal?.aborted) { return this.status(id); }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (settled) { return; }
        settled = true;
        if (timer !== undefined) { clearTimeout(timer); }
        // `{ once: true }` 只在 abort 路径自动摘除；超时/终态路径必须手动摘，否则监听器会残留
        signal?.removeEventListener("abort", done);
        resolve();
      };
      timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      const waiters = this.completionWaiters.get(id) ?? [];
      waiters.push(done);
      this.completionWaiters.set(id, waiters);
    });
    return this.status(id);
  }

  /**
   * 取消一个子代理（业界生命周期控制对齐）。
   * - pending（排队中）：直接标记 cancelled，不再占用槽位；
   * - running：登记取消意图并触发 AbortSignal，由 runner 端中断执行（状态由 execute 统一收尾）。
   * 返回是否成功受理。
   */
  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || isTerminal(run.status)) { return false; }
    this.cancelRequested.add(id);
    this.controllers.get(id)?.abort();
    if (run.status === "pending") {
      run.status = "cancelled";
      run.error = "已被取消（未开始执行）";
      run.finishedAt = Date.now();
      this.notifyCompletion(id);
    }
    return true;
  }

  /** 等待所有在途任务（运行中 + 排队中）到达终态；带超时防挂死；事件驱动。 */
  async awaitIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const remaining = Math.max(1, deadline - Date.now());
        const timer = setTimeout(() => resolve(), Math.min(50, remaining));
        this.idleWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // -------------------------------------------------------------------------
  // 内部执行
  // -------------------------------------------------------------------------

  private acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrency) { return Promise.resolve(); }
    return new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
    });
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) { next(); }
  }

  /** 唤醒等待某个 run 终态的 wait() 调用者（空闲唤醒在 execute 收尾统一处理）。 */
  private notifyCompletion(id: string): void {
    const waiters = this.completionWaiters.get(id);
    if (waiters) {
      this.completionWaiters.delete(id);
      for (const w of waiters) { w(); }
    }
  }

  /** 钩子防御性执行：钩子异常不阻断主流程（观测/审计逻辑不应影响任务本身）。 */
  private async fireHook(
    fn: ((run: SubAgentRun, def: SubAgentDef) => void | Promise<void>) | undefined,
    run: SubAgentRun,
    def: SubAgentDef,
  ): Promise<void> {
    if (!fn) { return; }
    try {
      await fn(run, def);
    } catch {
      /* 钩子异常静默吞掉，避免污染子代理终态 */
    }
  }

  /**
   * A-980-R31：中断（timeout/cancelled）收尾时保留**部分产出**。
   *
   * 只在 result 尚空、且部分文本非空时写入；同时按 outputSchema 尽力解析自评
   * （部分产出里的 json 代码块同样有意义——子代理常先给结论再补正文）。
   * 不改动 run.status / run.error：状态仍如实是"超时中断"，只是不再丢掉已经做出来的东西。
   */
  /**
   * 超时归因文案（A-983）。
   *
   * 为什么要带"实跑时长 + 已保住产出"：此前只回一句 `执行超时（>300000ms），已中断`，
   * 用户无法判断这是"卡死了"还是"差一点就完成"。实测那一次审计日志显示子代理已做到
   * 第 4/4 步才被杀 —— 一模一样的文案，含义完全不同，归因必须写出来。
   */
  private timeoutMessage(timeoutMs: number, run: SubAgentRun, reason: unknown): string {
    const elapsed = run.startedAt ? Math.round((Date.now() - run.startedAt) / 1000) : 0;
    const kept = (run.result ?? "").length;
    const why = typeof reason === "string" && reason ? `（${reason}）` : "";
    return `执行超时：预算 ${Math.round(timeoutMs / 1000)}s 用尽，实跑 ${elapsed}s${why}；`
      + (kept > 0
        ? `已保住中断前产出 ${kept} 字（见 run.result）`
        : `中断前无完整产出 —— 该任务需要更长预算，或应拆成更小的子任务`);
  }

  private keepPartial(run: SubAgentRun, reply: string | undefined, def: SubAgentDef): void {
    const text = (reply ?? "").trim();
    if (!text) { return; }
    if (!run.result) { run.result = text; }
    if (def.outputSchema && !run.structured) {
      run.structured = parseStructuredResult(text) ?? undefined;
    }
  }

  private async execute(run: SubAgentRun, def: SubAgentDef): Promise<void> {
    this.inflight++;
    try {
      // spawn 后、排队前即被取消：不占用任何槽位
      if (run.status === "cancelled") { this.notifyCompletion(run.id); return; }
      // 并发槽位排队（FIFO，每次释放恰好唤醒一个）
      while (this.active >= this.maxConcurrency) {
        await this.acquireSlot();
        if (run.status === ("cancelled" as SubAgentStatus)) {
          // 排队中被取消：把刚到手的唤醒令牌传给下一个排队者，防丢令牌死锁
          this.releaseSlot();
          this.notifyCompletion(run.id);
          return;
        }
      }
      // 取得槽位（或本就无需排队）后才发现已取消：同样把令牌传给下一个排队者
      if (run.status === ("cancelled" as SubAgentStatus)) {
        this.releaseSlot();
        this.notifyCompletion(run.id);
        return;
      }

      this.active++;
      run.status = "running";
      run.startedAt = Date.now();

      // 取消/超时控制器：def.timeoutMs 到期即 abort
      const controller = new AbortController();
      this.controllers.set(run.id, controller);
      const timeoutMs = def.timeoutMs ?? 0;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : null;
      const wasCancelled = (): boolean => this.cancelRequested.has(run.id);
      /** abort 归因：用户取消优先；无取消登记且有超时预算 → timeout；否则按取消处理 */
      const classifyAbort = (): "cancelled" | "timeout" =>
        wasCancelled() || timeoutMs === 0 ? "cancelled" : "timeout";

      // 结构化输出：在任务指令中注入契约说明（runner 透传给子代理）
      const effectiveDef: SubAgentDef =
        def.outputSchema && !def.task.includes(STRUCTURED_INSTRUCTION)
          ? { ...def, id: run.id, task: `${def.task}\n\n${STRUCTURED_INSTRUCTION}` }
          : { ...def, id: run.id };

      let terminal: "done" | "fail" | "timeout" | "cancelled" = "done";
      try {
        await this.fireHook(this.hooks.onStart, run, effectiveDef);
        // 断链 C 修复：把父请求透传下来的联网开关交给 runner（runner 再传给 engine.stream）。
        // 这里用 effectiveDef.networkEnabled（委派出发时已写入 def），缺省 undefined = 引擎缺省即开。
        const reply = await this.runner(effectiveDef, { signal: controller.signal, networkEnabled: effectiveDef.networkEnabled });
        if (controller.signal.aborted) {
          terminal = classifyAbort();
          run.error =
            terminal === "timeout"
              ? this.timeoutMessage(timeoutMs, run, controller.signal.reason)
              : "已被取消";
          // A-980-R31：中断前已产出的部分正文**必须保留**。
          // 此前 abort 路径直接丢弃 reply → run.result 恒空、装配方落盘 0 字节，
          // 用户看到的是"跑过一次但一个记录都没有"，连"做到哪一步了"都无从判断。
          this.keepPartial(run, reply, effectiveDef);
        } else {
          run.result = reply;
          if (effectiveDef.outputSchema) {
            run.structured = parseStructuredResult(reply) ?? undefined;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (controller.signal.aborted) {
          terminal = classifyAbort();
          run.error =
            terminal === "timeout"
              ? this.timeoutMessage(timeoutMs, run, msg)
              : msg || "已被取消";
        } else {
          terminal = "fail";
          run.error = msg;
        }
      } finally {
        run.status = terminal;
        run.finishedAt = Date.now();
        if (timer) { clearTimeout(timer); }
        this.controllers.delete(run.id);
        this.cancelRequested.delete(run.id);
        this.active--;
        this.releaseSlot();
        if (terminal === "done") {
          await this.fireHook(this.hooks.onComplete, run, effectiveDef);
        } else {
          await this.fireHook(this.hooks.onError, run, effectiveDef);
        }
        this.notifyCompletion(run.id);
      }
    } finally {
      // 在途计数收尾：最后一个任务结束时唤醒所有 awaitIdle 等待者
      this.inflight--;
      if (this.inflight === 0 && this.idleWaiters.length > 0) {
        const all = this.idleWaiters.splice(0);
        for (const w of all) { w(); }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 工具：任务-描述语义重叠打分（自动委派路由）
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  // 拉丁词元
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length > 1) { tokens.add(m[0]); }
  }
  // 中文双字滑窗（简单子串匹配，零分词依赖）
  const cjk = lower.match(/[一-鿿]+/g) ?? [];
  for (const seg of cjk) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      tokens.add(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 任务与 description 的词元重叠得分（Jaccard 风格，越大越相关；无重叠为 0）。 */
export function overlapScore(task: string, description: string): number {
  const a = tokenize(task);
  const b = tokenize(description);
  if (a.size === 0 || b.size === 0) { return 0; }
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) { inter++; }
  }
  if (inter === 0) { return 0; }
  const union = a.size + b.size - inter;
  return inter / union;
}
