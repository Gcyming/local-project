/**
 * todoPanorama.ts — A-980-R32：把 Agent 的「任务规划」折进思考历程的纯函数层。
 *
 * 为什么单独成模块：这一层是 `todo_write` 回执 → 时间线节点的**全部**解析/折叠规则，
 * 出错的表现全是"看着对、实际串行"（少一条、重复播报、旧卡不刷新）。放在 ChatPanel.tsx 里
 * 没法单测——那个文件有 vite 专属的 `*.svg` 导入，node 环境跑不起来
 * （同 `sessionCtxMeta.ts` / `streamMonitor.ts` 的既有做法：纯逻辑独立模块，vitest 直测）。
 *
 * 数据流（单一真源仍是待办存储，本模块只做"投影"）：
 *   tool_loop 调 todo_write → todoStore 落盘 → renderTodos 复述整表 →
 *   流事件 `type:"tool"` 携带该文本 → 本模块解析成全景 → 折进 TimelineStep[]
 *
 * 两条独立动作（foldTodoWriteIntoSteps）：
 *   ① 计划卡（kind=plan）：首份规划插卡，之后**就地刷新**同一张卡 → 永远显示"现在整体到哪"；
 *   ② 推进播报（kind=todo）：与上一份全景对比，新完成/新开始的项各补一行 → 带时间序的推进日志。
 */

/** 时间线节点（思考段落 / 正文片段 / 工具调用 / 任务规划卡 / 推进播报行 / 用户中途插入的引导，按执行顺序交错） */
export interface TimelineStep {
  kind: "think" | "body" | "tool" | "plan" | "todo" | "steer";
  /**
   * kind=think：该阶段思考内容（Markdown）；kind=steer：用户插入的引导原文；
   * kind=body：该阶段的**正文片段**（Markdown）—— 见 `appendTimelineStep` 的 body 支。
   */
  text?: string;
  /** kind=tool：工具名 */
  name?: string;
  /** kind=tool：展示标签 */
  label?: string;
  /** kind=tool：具体抓手（网址/文件路径/查询词） */
  detail?: string;
  /** kind=tool：执行结果（成功=内容 / 失败=失败原因） */
  result?: string;
  /**
   * A-1061②′：kind=tool —— 这一调用**正在执行**（tool-start 已到、结果还没到）。
   * 思考历程的工具卡要显示「执行中」实时态，成功/失败到了再原地翻状态。
   * 持久化时它必然已翻成完成态（或缺省），不影响历史回看。
   */
  running?: boolean;
  /**
   * A-1034：该次调用**有过改动、但详情没随记录保存**（超过落盘上限被摘掉）。
   * 由 `### 工具调用记录` 里的 `[__slime_diff_trimmed__]` 占位还原而来 ——
   * 界面据此如实说明，而不是让用户点开一片空白（A-1029 的整条教训）。
   */
  diffTrimmed?: boolean;
  /**
   * kind=plan —— 任务规划的**当前快照**（不是历史快照）。
   * 每次 `todo_write` 都会就地刷新同一张卡，用户看到的始终是最新进度，
   * 而不是"规划那一刻的样子 + 后面一串完成播报"。两处职责分开：
   * 卡片负责「现在整体到哪」，下面的 todo 行负责「这一项什么时候完成的」。
   */
  items?: TodoPanoramaItem[];
  /** kind=todo：该项是「开始做」还是「做完了」 */
  state?: "start" | "done";
}

/** 任务规划里的单项（从 todo_write 的复述文本解析；status 与右栏面板同一套枚举） */
export interface TodoPanoramaItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * 解析 `todo_write` 工具回执里的「待办全景」。
 *
 * 为什么不另开 IPC 订阅待办状态：工具回执本身就是**信息最全且按时间序**的那一份
 * （见 core-ts todoStore.renderTodos：`进度 d/t` 头行 + `- [x] 内容   ← 进行中` 列表）。
 * 从流事件里就地解析有三个好处：
 * ① 天然按发生顺序插进时间线（不需要额外的时序对齐）；
 * ② 随消息一起持久化（重启后思考历程里仍有规划与进度）；
 * ③ 不需要跨会话过滤——事件本身就带 sessionId，由既有的流过滤兜住。
 *
 * 返回 null 表示"这不是一份可解析的待办清单"（空列表 / clear / 报错），调用方应原样跳过。
 */
export function parseTodoPanorama(raw: string): { items: TodoPanoramaItem[] } | null {
  const text = (raw ?? "").replace(/\r\n/g, "\n");
  if (!text) { return null; }
  // 只认带勾选框的行，避免把回执里的其他 "- " 说明当成任务
  const lines = text.split("\n").filter((l) => /^\s*-\s*\[[ xX]\]\s+/.test(l));
  if (lines.length === 0) { return null; }
  const items: TodoPanoramaItem[] = lines.map((l, i) => {
    const done = /^\s*-\s*\[[xX]\]/.test(l);
    // 去掉勾选框；"← 进行中" 是 renderTodos 追加的进行中标记（全角/半角箭头都兼容）
    const body = l.replace(/^\s*-\s*\[[ xX]\]\s*/, "").replace(/\s*←\s*进行中\s*$/, "").trim();
    const inProgress = /←\s*进行中\s*$/.test(l);
    return {
      id: String(i + 1),
      content: body,
      status: done ? "completed" : inProgress ? "in_progress" : "pending",
    };
  });
  return { items };
}

/** 规划项内容签名：用来判断"这是一张新计划"还是"同一张计划的进度更新" */
export function planSignature(items: TodoPanoramaItem[]): string {
  return items.map((i) => i.content).join("\u0001");
}

/**
 * 业界标准（对齐 LangChain/AI SDK parts 数组）：流式中按事件到达顺序增量构建交错时间线。
 * think 内容追加到当前 think 段；tool 事件追加独立 tool 段——工具与思考按真实顺序自然穿插，
 * 无需依赖「工具发生时 reasoning 长度」字符锚点回溯切分（锚点对中文/换行偏移脆弱，易错位粘连）。
 */
export function appendTimelineStep(
  steps: TimelineStep[],
  ev:
    | { kind: "think"; text: string }
    | { kind: "body"; text: string }
    | { kind: "tool"; name?: string; label?: string; detail?: string; result?: string; running?: boolean }
    | { kind: "plan"; items: TodoPanoramaItem[] }
    | { kind: "todo"; text: string; state: "start" | "done" }
    | { kind: "steer"; text: string },
): TimelineStep[] {
  if (ev.kind === "think") {
    if (!ev.text) { return steps; }
    const last = steps[steps.length - 1];
    // 末尾已是 think 段 → 追加；否则新开 think 段
    if (last && last.kind === "think") {
      return [...steps.slice(0, -1), { kind: "think", text: (last.text ?? "") + ev.text }];
    }
    return [...steps, { kind: "think", text: ev.text }];
  }
  /* A-1095 #8′（返工）：**正文片段进时间线** —— 用户第一轮诉求里被整条漏掉的那一项。
   *
   * 用户原话（A-1095 初始需求，见 docs/A-1095-chat-orchestration-plan.md §0）：
   *   「首先修改正文输出逻辑，改在**所有思考结束后再统一输出**，当然，我们的思考历程是时间线制的，
   *     **也可以在思考历程中穿插正文输出**，然后再在**所有思考工作做完后，整理思考历程中的正文部分**。」
   * ⇒ 这是**三件事**，此前只落地了第一件（底部正文区的后置闸门 `gateOpen = !loading`）：
   *   ① 底部正文区在所有思考结束后统一输出 —— 渲染层闸门（已有，勿动）；
   *   ② **思考历程里穿插正文输出** —— 本条分支（此前 `chunk` 只写 `partialRef`，**根本不进时间线**，
   *      所以思考历程里永远看不到正文；用户驳回原话：「我要的思考期间穿插的正文总结呢？」）；
   *   ③ 收尾整理 —— 正文片段按它所属的**工作阶段组**归位（`groupTimeline` 的组边界仍是 think，
   *      body 不作边界 ⇒ 一段思考 + 其间工具 + **该阶段正文** = 一组，正是 §5.3 的目标图）。
   *
   * 合并规则与 `think` 同构（末尾已是 body 段 → 追加；否则新开一段），于是：
   *   · 连续 chunk → **一段**正文（不该被切成几十个节点，否则时间线被刷屏）；
   *   · `body → tool → body` → **两段**正文，各自留在自己那一步里 —— 归属判据（③）才不会丢。
   * ⚠️ 绝不许跨非 body 节点合并：那会把工具前后的两段正文糊成一坨，连带把"这段正文属于哪个
   *    工作阶段"一起抹掉，③ 的整理就无从谈起。
   * ⚠️ 与 `partialRef` 是**并存**关系，不是二选一：partialRef 管"底部正文区的统一输出"
   *    （token 统计 / 断流兜底 / 持久化都靠它），body 节点管"思考历程里读得到正文"。
   */
  if (ev.kind === "body") {
    if (!ev.text) { return steps; }
    const last = steps[steps.length - 1];
    if (last && last.kind === "body") {
      return [...steps.slice(0, -1), { kind: "body", text: (last.text ?? "") + ev.text }];
    }
    return [...steps, { kind: "body", text: ev.text }];
  }
  /* A-1064：用户中途插入的「引导」是**独立节点**，绝不折进 think 段。
     此前它被塞成 `{kind:"think", text:"引导：…"}`，两个后果都是用户实测报上来的：
       ① 因为 kind=think 会**合并进相邻思考段**（见上面那支）→ 引导文字跟模型思考糊成一坨，
          用户要的"能看见我插入的卡片"根本无从谈起；
       ② 更要命的是它污染了「这段历程里有没有 think 节点」这个判据 ——
          `ChatPanel.onDone` 用 `!finalTimeline.some(s => s.kind === "think")` 决定要不要用
          `m.reasoning` 兜底补思考节点（A-918++ / A-1028）。只有引导、没有真思考段时，
          这个 some 为 true → **兜底的思考节点不再补** → 思考历程缺一段。
          这正是用户说的"由于我这个引导，思考历程也出现了一点问题——完整性"。
      ⇒ 新增一等 kind（而不是复用 think）是**语义正确性**要求，不是美化。 */
  if (ev.kind === "steer") {
    if (!ev.text) { return steps; }
    return [...steps, { kind: "steer", text: ev.text }];
  }
  if (ev.kind === "plan") { return [...steps, { kind: "plan", items: ev.items }]; }
  if (ev.kind === "todo") { return [...steps, { kind: "todo", text: ev.text, state: ev.state }]; }
  // A-1061②′：`running` 透传 —— 思考历程的工具卡要有「执行中」实时态（结果到了再翻成成功/失败）
  return [...steps, { kind: "tool", name: ev.name, label: ev.label, detail: ev.detail, result: ev.result, running: ev.running }];
}

/**
 * 从时间线里取**最后一张计划卡**的全景，作为下次 `todo_write` 的对比基线。
 *
 * 为什么不另立一个 `prevPanoramaRef`：计划卡的 `items` 本来就是"最近一次全景"的副本
 * （foldTodoWriteIntoSteps 每次都把它刷成最新），而时间线在每条流收尾/切会话时会被整体清空
 * ——让基线跟时间线同生共死，就不会出现"时间线清了、ref 还留着上一轮的清单"这种错配
 * （那种错配的表现是：新任务的第一条被误判成"完成"，一开场先播报一条莫名其妙的 ✓）。
 */
export function lastPlanItems(steps: TimelineStep[]): TodoPanoramaItem[] | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "plan") { return steps[i].items ?? null; }
  }
  return null;
}

/**
 * 把一次 `todo_write` 回执折进思考时间线。
 *
 * 两条独立动作，缺一不可：
 * ① **计划卡**（kind=plan）：首次规划时插入一张卡；同一张计划（条目内容签名相同）之后只在**原地**刷新它的
 *    `items` —— 卡片永远显示当前进度，不会在时间线里堆出一串"旧快照"。
 * ② **完成播报**（kind=todo）：与上一份全景对比，**新变成 completed** 的项各追加一行"✓ 完成：…"；
 *    新变成 in_progress 的项追加一行"▶ 开始：…"。这样时间线读起来是一份带时间戳的推进日志。
 *
 * 为什么"同一张计划"要按**内容**判签名而不是条数：模型用 add 增量更新时只会回传变化项，
 * 但 renderTodos 复述的是**整表**，所以内容序列才是稳定身份；条数相同内容换了是另一张计划。
 */
export function foldTodoWriteIntoSteps(
  steps: TimelineStep[],
  items: TodoPanoramaItem[],
  prevItems: TodoPanoramaItem[] | null,
): { steps: TimelineStep[]; items: TodoPanoramaItem[] } {
  if (items.length === 0) { return { steps, items: prevItems ?? [] }; }
  let next = steps;
  const prevSig = prevItems ? planSignature(prevItems) : "";
  const sig = planSignature(items);
  if (prevItems === null || prevSig !== sig) {
    // 新计划（含"重规划"）：插一张新卡。旧卡留在时间线里作为历史——用户回看时能看到计划变过
    next = appendTimelineStep(next, { kind: "plan", items });
  } else {
    // 同一张计划：就地刷新最后一张同类卡（从后往前找，避免插了新计划后又刷到旧卡）
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].kind === "plan") {
        next = [...next.slice(0, i), { ...next[i], items }, ...next.slice(i + 1)];
        break;
      }
    }
  }
  if (prevItems === null) { return { steps: next, items }; }
  // ⚠️ 对齐必须按**内容**，不能按 id：解析出来的全景用的是序号 id（1/2/3…），
  // 而 `loadTodos`/广播给的是 uuid —— 两套 id 空间不同，按 id 比会把每项都当成"新项"刷屏。
  // 内容的稳定性由 todo_write 的语义保证（只翻状态时不覆盖正文，见 core-ts builtin.todoWrite）。
  const prevStatus = new Map(prevItems.map((it) => [it.content, it.status]));
  for (const it of items) {
    const before = prevStatus.get(it.content);
    const wasCompleted = before === "completed";
    const wasInProgress = before === "in_progress";
    if (it.status === "completed" && !wasCompleted) {
      next = appendTimelineStep(next, { kind: "todo", text: it.content, state: "done" });
    } else if (it.status === "in_progress" && !wasInProgress && !wasCompleted) {
      next = appendTimelineStep(next, { kind: "todo", text: it.content, state: "start" });
    }
  }
  return { steps: next, items };
}

/* ── A-1095 #9：思考历程按「工作阶段」归组（**投影**，不改数据结构）──────────────
 *
 * 用户诉求：「修改工具调用出现的位置，围绕时间线设计进行规划，把每次的工具调用放在对应的
 * 工作阶段内，如图，可以借鉴你的设计 image#4，每个时间线阶段为一组，每一组涵盖对应内容。」
 *
 * ⚠️ 用户随后**明确澄清**：「我说的是**实时显示的调用工具的文本挪位置**，别给我理解成最后调用工具」
 *   ⇒ 这是**展示归属**重构（把已经实时出现的工具行**挂进它所属的阶段组**），
 *     **不是执行时机**重构 —— 工具照旧实时执行、结果照旧实时回流，变的只是界面挂靠位置。
 *
 * 为什么做成**投影**而不是改 `appendTimelineStep`：时间线结构（扁平交错数组）承担着
 * 持久化格式 + 12 条已有 `todo-panorama.spec` 用例 + 恢复路径；改结构等于全线迁移，
 * 而用户要的只是"显示上分组"。投影零风险，且分组规则可以单独单测。
 *
 * 组边界 = **新的 think 段开始**（一段思考 + 它之后触发的工具/计划/播报 = 一个工作阶段）。
 * 若时间线开头就是非 think 节点（首个事件是工具调用），归入一个"无思考"的首组。
 *
 * ⚠️ A-1095 #8′：`kind: "body"`（该阶段正文片段）**不作组边界** —— 这是有意的。
 *   §5.3 的目标图里，一轮/一阶段的形状就是「思考 → 工具组 → **该阶段正文**」；
 *   若把 body 也当边界，每段正文都会自成一组（还会套上组头折叠壳，把正文藏起来），
 *   阶段归属当场丢失。用户说的「整理思考历程中的正文部分」= 把正文归回**它所属的那个阶段**。
 */

export interface TimelineGroup {
  /** 该组在 steps 数组里的闭区间下标（用于 React key / 折叠状态定位） */
  from: number;
  to: number;
  /** 该组属于的节点（原样切片，渲染层照旧逐节点画，不复制内容） */
  steps: TimelineStep[];
  /** 组标题：取该组**首个 think 段**的第一行（截断），无思考则给工具名/兜底文案 */
  headline: string;
  /** 该组里工具调用节点数（用于「N 步」徽标） */
  toolCount: number;
  /** 该组是不是"最后一段"（渲染层据此决定默认展开/折叠） */
  isLast: boolean;
}

/** 组标题用的文本截断（第一行 + 上限 42 字，超出加省略号）。 */
function headlineOf(step: TimelineStep): string {
  const raw = (step.kind === "think" ? step.text : "")
    || step.text
    || step.label
    || step.name
    || "";
  const firstLine = String(raw).split("\n").find((l) => l.trim() !== "") ?? "";
  const t = firstLine.replace(/[#*`>]/g, "").trim();
  if (!t) { return "工作阶段"; }
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}

/**
 * 把扁平时间线**投影**成阶段组（纯函数，不改入参）。
 *
 * 不变量：
 *   · 所有组的 `steps` 顺次拼接 === 原数组（一个节点不丢、不重排）；
 *   · `from`/`to` 覆盖 [0, steps.length-1] 且连续不重叠；
 *   · 恰好最后一组 `isLast === true`（空数组 → 返回空数组）。
 */
export function groupTimeline(steps: TimelineStep[]): TimelineGroup[] {
  if (steps.length === 0) { return []; }
  const groups: TimelineGroup[] = [];
  let start = 0;
  for (let i = 1; i <= steps.length; i++) {
    // 到了下一个 think 段（或数组末尾）→ 收掉当前组。
    // ⚠️ 判据只有 `think` 一种：`body`（该阶段正文）必须**留在本组内**，见上方模块注释。
    const boundary = i === steps.length || steps[i].kind === "think";
    if (!boundary) { continue; }
    const slice = steps.slice(start, i);
    const thinkStep = slice.find((s) => s.kind === "think");
    groups.push({
      from: start,
      to: i - 1,
      steps: slice,
      headline: headlineOf(thinkStep ?? slice[0]),
      toolCount: slice.filter((s) => s.kind === "tool").length,
      isLast: false,
    });
    start = i;
  }
  if (groups.length > 0) { groups[groups.length - 1] = { ...groups[groups.length - 1], isLast: true }; }
  return groups;
}
