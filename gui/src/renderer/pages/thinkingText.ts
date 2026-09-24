/**
 * gui/src/renderer/pages/thinkingText.ts — 思考文本净化纯函数（无 React 依赖，vitest 可直测）。
 *
 * 为什么独立成模块：思考内容来自各上游的 reasoning_content，形态极脏——逐 token 换行、
 * 词内被空格切开、模型把预训练 XML 工具格式泄进思考、中文 token 级空格（`好 的 ， 我`）。
 * 这些净化规则必须有回归测试兜住，否则一次"顺手优化正则"就会像本轮这样把整段英文粘成一坨。
 *
 * 三条规则的分工：
 *   normalizeThinkingText —— 只处理**换行**：单换行（逐 token 断行）→ 空格；空行 → 段落分隔。
 *   stripMarkdown         —— 摘要行用：抹掉 markdown 符号，避免折叠标题暴露 * # |。
 *   sanitizeThinking      —— 展开正文用：剥 XML 残留 + 归一空白 + 拼合被切开的英文词。
 */

/** 摘要用：把 markdown 符号剥离成纯文本（时间线思考步的折叠标题，避免暴露 * # | 等底层符号） */
export function stripMarkdown(text: string): string {
  return text
    .replace(/`{1,4}/g, "")
    .replace(/[#*_>|~]{1,3}/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 规范化思考文本：单换行合并为空格（模型逐 token 输出带单换行），双换行保留为段落分隔。
 * 避免 white-space: pre-wrap 把逐词换行全部保留导致"每个字独占一行"。
 */
export function normalizeThinkingText(text: string): string {
  // 先按 \n\n 分段 → 段内单 \n 合并为空格 → 段间保留 \n\n
  return text
    .split(/\n\s*\n/)
    .map(seg => seg.replace(/[ \t]*\n[ \t]*/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter(seg => seg.length > 0)
    .join("\n\n");
}

/**
 * A-923：思考过程整体净化——
 *   ① 剥离 XML 风格工具调用残留（`<parameter>`/`<function>`/`<tool_call>`/`<result>` 等半成品标签，
 *      模型把预训练 XML 工具格式泄进 reasoning，样例：`</parameter name="test_file.txt">` 直接露出）；
 *   ② 归一空白（逐词断行 / 多余空格合并）；
 *   ③ 拼合被 token 断行切开的英文词。
 * 输出为可读纯文本，供思考卡与最终 reasoning 折叠卡。
 */
export function sanitizeThinking(text: string): string {
  const stripped = (text ?? "")
    .replace(/<\/?(?:parameter|function|tool_call|result|safety|safety_check|ban_message|reasoning|system)\b[^>]*>/gi, "");
  return normalizeThinkingText(stripped)
    // A-924：收敛词间空格观感——中文标点前不得留空格、开括号后不得留空格（上游 token 级空格常见 `好 的 ， 我`）
    .replace(/\s+([，。；：！？、）》】）])/g, "$1")
    .replace(/([（《【])\s+/g, "$1")
    // A-928：思考区英文 token 断词收敛（`B ing`→`Bing`、`S tudio`→`Studio`）——上游逐 token 换行会把
    // 单词内部切成两半，normalizeThinkingText 已把该换行转成空格，故此处只在「单词首字母 + 小写词尾」时拼合。
    // ⚠️ 历史上的 /([A-Za-z0-9])\s+([A-Za-z0-9])/g 会删掉**任意**两个字母数字之间的空格，
    // 把 "The user is asking" 变成 "Theuserisasking"（本轮 bug 根因）——已收窄为：
    //   ① 单字母开头（排除冠词 a/A/i/I，避免吃掉 "a cat" / "I think" 的空格）
    //   ② 2 个以上小写字母结尾，两端都要有词边界（`\b`）
    //   ③ 负向断言排除撇号后紧跟的字母——否则 "DeepSeek's web" 会被误判为
    //      「s + web」两个 token 而粘成 "DeepSeek'sweb"（所有格、缩写的 's 必须原样保留）。
    .replace(/(?<!['\u2018\u2019])\b([b-hj-zB-HJ-Z])\s+([a-z]{2,})\b/g, "$1$2");
}

/** 重建节点数上限。只在「真值时间线已丢失、只能拿 reasoning 文本兜底」时生效。 */
export const THINK_STEP_MAX = 24;

/* ── A-1027：「### 工具调用记录」块的解析 ───────────────────────────────────
 *
 * 病灶（用户裁定的待修项）：无思考模型下 `composeToolCallBlock()`（core-ts/services/chat.ts:94）
 * 把工具块写成**整段 reasoning**（marker 落在偏移 0）。渲染层原先用
 * `/\n?### 工具调用记录\n[\s\S]*$/` 从 marker **砍到文本结尾** → reasoning 变空；
 * 而此时历史记录里 `stages` 整体缺失（实测 6 条命中记录全部如此）→ 时间线长度为 0 →
 * `return null` → **整个思考面板不渲染**（按钮在、点了没反应）。
 *
 * 正解不是"换个正则"，而是**把工具块解析成 tool 节点**：留痕本来就是工具信息，
 * 丢掉它才是错的。三条设计约束：
 *   ① **无损**：只有能确定的列表行才被消费，任何"看起来不属于块"的行一律留在正文里
 *      （宁可少解析，不可吞内容 —— 吞内容是这个 bug 的原始形态）；
 *   ② **块可出现在任意位置**：以"首个非列表行"（典型是下一个行首同级 `###` 标题）为块终点，
 *      不再假定它在末尾；
 *      ⚠️ 这里**只有一条**终止规则。曾额外写过一条显式的 `^###\s` 提前分支，但它与下面的通用兜底
 *      **行为完全同构**（`### 结论` 既不是列表行也不是空行，两条路都在此处复位 `inBlock` 并保留原行），
 *      属于无法被任何变异测试区分的死分支 —— 已删除，避免"看起来多一层保护、其实永远不会单独生效"
 *      的假防线（A-1027 变异 ⑤ 最初就是打在这条死分支上，所以"未红"）。
 *   ③ **顺带修掉"原始工具名"**：core-ts 的展示名表没覆盖 A-975/A-976 系列工具（screen_* /
 *      adb_* / browser_* / http_*），落盘时原样写了 `- ⟳ screen_capture`。渲染层有完整表，
 *      故在**渲染侧做一次归一**（lookup 由调用方注入，避免把图标表搬进纯模块）。
 *
 * ⚠️ 这是**形态重建**：块内的顺序是"记录顺序"，不代表工具在思考中的真实交错位置
 * （与 splitThinkingIntoSteps 的同一条诚实边界）。*/

/** 「工具调用记录」块的标题行。
 *  ⚠️ 与 `core-ts/src/services/chat.ts` 的 `composeToolCallBlock()` 是**同一格式的两份字面量**：
 *  渲染层不 import core-ts（避免浏览器构建把主进程图谱打进来），故无法共用常量 ——
 *  一致性由 `tests/core-ts/a1027-guards.spec.ts` 钉死（改一边不改另一边即变红）。 */
export const TOOL_TRACE_HEADING = "### 工具调用记录";

export interface ToolTraceSplit {
  /** 去掉工具块之后的推理正文（可能为空串） */
  text: string;
  /** 工具块内的条目（已剥掉 `- ` 与 `⟳ ` 前缀），保持原顺序 */
  traces: string[];
}

/**
 * 从推理/正文文本中**摘出**工具调用记录块。
 * @returns `text` = 剥块后的正文；`traces` = 各条目文本（无块时为空数组）。
 */
export function splitToolTrace(text: string): ToolTraceSplit {
  const src = text ?? "";
  if (!src.includes(TOOL_TRACE_HEADING)) { return { text: src, traces: [] }; }
  const kept: string[] = [];
  const traces: string[] = [];
  let inBlock = false;
  for (const line of src.split("\n")) {
    if (line.trim() === TOOL_TRACE_HEADING) { inBlock = true; continue; }
    if (inBlock) {
      const m = /^\s*[-*]\s+(.*)$/.exec(line);
      if (m) {
        const entry = m[1].replace(/^⟳\s*/, "").trim();
        if (entry) { traces.push(entry); }
        continue;
      }
      if (line.trim() === "") { continue; }  // 块内空行丢弃
      // 非列表行（含下一个行首同级 `###` 标题）→ 块到此结束，**本行保留在正文里**
      // （宁可少解析，不可吞内容）
      inBlock = false;
      kept.push(line);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), traces };
}

/** 工具节点（只保留渲染 `TimelineNode` 真正用到的字段：`label` 必填、`name` 可缺） */
export interface TracedToolStep {
  name?: string;
  label: string;
  /**
   * A-1034：从留痕里还原出来的工具结果（**只含 diff 标记**）。
   *
   * 为什么需要：历史消息落盘的只有 `reasoning`，工具结果本身只存在于本轮内存。
   * core-ts 现在把 diff 标记一并写进 `### 工具调用记录` 的行尾，这里把它拆回 `result`，
   * 产物卡与思考历程在**重新打开会话后**才展得开改动对比（此前是空白）。
   */
  result?: string;
  /** A-1034：改动详情因超限**未随记录保存**（界面要如实说明，不能点开一片空白） */
  diffTrimmed?: boolean;
}

/** 留痕行尾的"改动详情未保存"占位（与 core-ts `chat.ts` 的 `DIFF_TRIMMED_TAG` 同字面量） */
export const TRACE_DIFF_TRIMMED_MARKER = "[__slime_diff_trimmed__]";

/** 行尾机器标记：完整 diff 标记 或「详情未保存」占位
 *  ⚠️ A-1093：diff 标记两侧用 `*`（允许空 base64）—— 新建文件时左半边是空的，
 *  用 `+` 会漏剥 ⇒ 整段 base64 原样漏进界面（用户看到一屏乱码）。与 `chatProducts.ts` 同源。 */
const TRACE_MARKER_RE = /\[__slime_diff__\][A-Za-z0-9+/=]*\|[A-Za-z0-9+/=]*\[\/__slime_diff__\]|\[__slime_diff_trimmed__\]/;

/**
 * 把留痕行拆成「人读的部分」与「机器标记」。
 *
 * ⚠️ 拆分**必须在 lookup 之前**做：`existing`（真实时间线上的展示标签）里不含标记，
 * 若拿带标记的原文去比对，历史回退路径永远匹配不上 → 同一次调用会重复出一个节点。
 */
export function splitTraceDiff(raw: string): { text: string; result?: string; diffTrimmed?: boolean } {
  const src = raw ?? "";
  const m = TRACE_MARKER_RE.exec(src);
  if (!m) { return { text: src.trim() }; }
  const text = src.replace(m[0], "").replace(/\s+/g, " ").trim();
  if (m[0] === TRACE_DIFF_TRIMMED_MARKER) { return { text, diffTrimmed: true }; }
  return { text, result: m[0] };
}

/**
 * 组装工具记录块（渲染层的**唯一**产地）。
 *
 * 之前这个格式在渲染层被手写了两遍（错误收尾的 A-147 留痕），在 core-ts 里还有一份
 * ——三处各写各的，改一处就漂。现在渲染层收敛到这一个函数。
 * @param entries 条目文本（调用方负责前缀，如 `⟳ label`）；空数组返回空串（不产出空块）
 */
export function composeToolTrace(entries: string[]): string {
  const rows = (entries ?? []).map((e) => (e ?? "").trim()).filter((e) => e.length > 0);
  if (rows.length === 0) { return ""; }
  return `${TOOL_TRACE_HEADING}\n${rows.map((e) => `- ${e}`).join("\n")}`;
}

/** 工具栏表的最小契约：`工具名 → { label }`。真实表（`TOOL_LABELS`）还挂着 React 图标组件，
 *  纯模块不持有它 —— 表由调用方注入，这里只做反查。 */
export interface ToolLabelTable {
  [name: string]: { label: string };
}

/**
 * 把工具记录里的一行**反查**回工具身份。
 *
 * 为什么需要：core-ts 的展示名表（`TOOL_DISPLAY_LABELS`）只覆盖 13 个工具，
 * A-975/A-976 那一批（screen_* / adb_* / browser_* / http_*）**原样把工具名写进了记录**
 * （真实语料里就有 `- ⟳ screen_capture`）。渲染层那张表是完整的，所以在这里做一次归一：
 *   ① 先按**展示名**反查（core-ts 写的是展示名）→ 拿回 name（图标才对）与规范 label；
 *   ② 再按**工具名**直查（上面那批落盘的是原始名）→ 顺手把裸名升级成人类可读名；
 *   ③ 都不命中 → 返回 null，由调用方原样展示（不猜、不吞）。
 *
 * ⚠️ 它是**纯逻辑**，故住在本模块而不是 `ChatPanel.tsx`：住在 `.tsx` 里时只能被
 *    "结构断言"钉住，短路成 `return null` 守卫照样绿（A-1027 变异 ③ 实测漏网）；
 *    搬到纯模块后，行为测试直接把它钉死。
 */
export function resolveToolEntry(
  entry: string,
  labels: ToolLabelTable,
): { name: string; label: string } | null {
  const t = (entry ?? "").trim();
  if (!t) { return null; }
  const table = labels ?? {};
  for (const [name, v] of Object.entries(table)) {
    if (v.label === t) { return { name, label: v.label }; }
  }
  // ⚠️ 必须 `hasOwnProperty`：`TOOL_LABELS["__proto__"]` / `["constructor"]` 会命中原型链，
  //    把一条垃圾条目反查成"合法工具"。
  const byKey = Object.prototype.hasOwnProperty.call(table, t) ? table[t] : undefined;
  if (byKey) { return { name: t, label: byKey.label }; }
  return null;
}

/**
 * 把工具记录条目折成时间线 tool 节点。
 *
 * @param entries `splitToolTrace().traces`
 * @param lookup  条目文本 → `{name,label}`（渲染层注入，做展示名/原始名的归一）；返回 null = 不认识
 * @param existing 已有的结构化工具（`stages.tools`）——**结构性来源优先**：
 *                 若某条目已被结构化工具覆盖，则不重复出节点（否则同一工具会显示两遍）
 */
export function traceEntriesToToolSteps(
  entries: string[],
  lookup: (entry: string) => { name: string; label: string } | null,
  existing: Array<{ name?: string; label?: string }> = [],
): TracedToolStep[] {
  // 已有的展示标签多重集：条目命中一次消费一个（同名工具多次调用不会被一次性消化）
  const pool = existing.map((t) => (t.label ?? t.name ?? "").replace(/^⟳\s*/, "").trim()).filter((s) => s.length > 0);
  const out: TracedToolStep[] = [];
  for (const raw of entries) {
    // A-1034：先把行尾的机器标记拆出来，再参与比对与查表
    const { text: entry, result, diffTrimmed } = splitTraceDiff(raw ?? "");
    if (!entry) { continue; }
    const hit = pool.indexOf(entry);
    if (hit >= 0) { pool.splice(hit, 1); continue; }
    const mapped = lookup(entry);
    const base = mapped ? { name: mapped.name, label: mapped.label } : { label: entry };
    out.push(result || diffTrimmed ? { ...base, result, diffTrimmed } : base);
  }
  return out;
}

/**
 * A-1028：工具卡右侧的**状态词**。
 *
 * ⚠️ 关键区分：`result === undefined`（**结果从未被记录**）≠ `result === ""`（结果就是空的）。
 *   历史回退路径（消息只有 `### 工具调用记录` 块 + 文本推理，磁盘上没有 timeline）解析出的
 *   tool 节点**只有名字**，没有结果 —— 旧实现把这种情况和"结果为空"合并成 `!r`，落进
 *   `isWrite ? "已执行" : "调用中"`，于是**一条早已结束的回复**里，11 张工具卡齐刷刷标着
 *   「调用中」/「已执行」（用户实测截图原话："Agent 输出结束后…全变成这种『调研中』、
 *   『已执行』之类的卡片了"）。已结束的回复里不存在"调用中"，而我们**无从知道**成功还是失败
 *   —— 唯一诚实的做法是不给状态断言，把版面留给真实的工具名与分类标签。
 *
 * 这是**纯函数**（住本模块而不是 `ChatPanel.tsx`）：住 `.tsx` 里只能被结构断言钉住，
 * 把 `!hasResult` 短路掉守卫照样绿（A-1027 变异 ③ 的同一条教训）。
 *
 * @param result 该工具事件的 result；`undefined` = 未记录（≠ 空结果）
 * @param isFail 由调用方按结果文本判定的失败标志（未记录结果时无意义）
 * @param running A-1061②：这一条**当前正在执行**（`tool-start` 已到、结果还没到）。
 *   它必须**优先于**"未记录"判定 —— 否则正在跑的调用会落到"不给状态断言"那一支，
 *   界面上就是一行**没有状态词**的哑行（用户看不到"在跑"，这正是本次要修的）。
 *   与"未记录"的区别是本质的：前者是**此刻确实在跑**，后者是**结果没被保存下来**。
 * @returns 状态词；空串 = 不渲染状态（调用方据此省略该列）
 */
export function toolStatusLabel(result: unknown, isFail: boolean, running?: boolean): string {
  if (running === true) { return "执行中"; }
  if (typeof result !== "string") { return ""; }
  return isFail ? "失败" : "成功";
}

/** 工具卡状态区的**阶段**（A-1094）：驱动 CSS 动画，也是"该不该显示状态列"的唯一判据。 */
export type ToolStatusPhase =
  /** 结果未记录（`result === undefined`，且不在进行中）→ **不渲染状态列**（诚实：无从断言） */
  | "none"
  /** 此刻正在执行（`tool-start` 已到、结果未到）→ 呼吸动画 + 「执行中」 */
  | "running"
  /** 已有结果 → 终态（成功/失败），播一次「落位」衔接动画 */
  | "settled";

/**
 * A-1094：状态阶段判定。**唯一出处** —— `.tsx` 只管把返回值映射成 `data-*` 与文案。
 *
 * 为什么把它从 JSX 里抽出来：这段判据此前是 `className={isRunning ? "… text-scan-light" : "…"}`
 * 这种内联三元，**两个**信息（要不要渲染、用哪套动画）都藏在 JSX 表达式里，
 * 于是"运行中的状态词被扫光类吞成空白"这个缺陷没有任何守卫抓得住
 * （结构断言只看得到那串类名，看不出它把字变透明了）。
 *
 * ⚠️ 优先级：`running` > "未记录" —— 正在跑的调用必须报「执行中」，
 *    绝不能因为"结果还没来"而落进 `none`（那就是用户说的"框格是空白的"）。
 */
export function toolStatusPhase(result: unknown, running?: boolean): ToolStatusPhase {
  if (running === true) { return "running"; }
  if (typeof result !== "string") { return "none"; }
  return "settled";
}

/**
 * A-1091：剥掉工具标签里的 **`⟳ ` 落盘标记**（唯一实现）。
 *
 * `⟳` **不是 UI 元素**，是**推理留痕文本的格式标记**：写进 `reasoning` 时工具行形如
 * `- ⟳ screen_capture`（见 `composeToolTrace`）。它只应该出现在那段文本里。
 *
 * ⚠️ 用户实测：「卡片的左侧怎么还有个圆圈箭头？有什么用，有点丑啊」——
 *    三个产地里的两个剥了、一个没剥，于是**跑过的卡片**（先收到 `tool-start`、
 *    后在原地翻状态）带着 `⟳ `，而**直接完成的卡片**没有。同一屏两种形态。
 *    ⇒ 判据：**渲染边界必须剥**（不只依赖产地剥）。理由是历史数据已经存进去了，
 *      只修产地只能让"以后新产生的"干净，旧会话照样带标记。
 */
export function stripToolTraceMark(label: string | undefined): string {
  return (label ?? "").replace(/^⟳\s*/, "");
}

/**
 * A-1021b：把一整段推理文本切回**多个**时间线节点。
 *
 * 为什么需要它：思考历程的正常形态是「思考段 ↔ 工具卡」按真实到达顺序交错的**多节点时间线**。
 * 但有两条路径只剩推理文本、没有交错顺序：
 *   ① 上游/中转站把 `reasoning_content` 混进普通 chunk → 不触发 `reasoning` 事件 → 流式期没建节点；
 *   ② 历史消息没有 timeline（A-966 通道未写成功时）。
 * 这两条路径此前都退化成 **单个** 节点 + 整段文本（`normalizeThinkingText` 又把段内单换行并成空格），
 * 于是在 `.think-step-text` 里呈现为"一大坨可滚动的字"，用户看到的就是**时间线设计消失**
 * （实测原话："上一次的思考历程的时间线设计怎么没了"）。
 *
 * 切法：按**空行**取模型的自然段落（这是模型自己给的结构，不是我们编的），段数超上限时再按
 * **前缀和均衡合并**相邻段。刻意不做 1 段 = 1 节点的直切 —— 实测 `config/history.jsonl` 最长一条
 * 推理 751,489 字符 / 2,993 段，直切会渲染近三千个节点；有界合并后稳定 ≤ `maxSteps`。
 *
 * ⚠️ **这是形态重建，不是真相还原**：切出来的节点不携带真实的工具交错位置，不得据此宣称
 * "模型在这段之后调用了工具"。恢复真实交错只能靠把时间线完整落盘（见 attachTimelineToHistory）。
 *
 * @returns 按原顺序切好的文本段；空输入返回 `[]`（调用方据此不建节点）。
 */
export function splitThinkingIntoSteps(text: string, maxSteps = THINK_STEP_MAX): string[] {
  const normalized = normalizeThinkingText(text ?? "");
  if (!normalized) { return []; }
  // normalizeThinkingText 已把段内单换行并成空格、再以 \n\n 连接，所以这里按 \n\n 切回段落是安全的
  const segs = normalized.split("\n\n").filter(seg => seg.length > 0);
  // maxSteps<=1 = 明确要求"只给一个节点" → 必须回整体，**不能**回 segs（那是"按段落切"，与要求相反）
  if (maxSteps <= 1) { return [normalized]; }
  if (segs.length <= maxSteps) { return segs; }
  // 前缀和均衡合并：第 k 个切点落在「累计字符数 ≥ total·k/maxSteps」的第一段之后。
  // `made + 1 < maxSteps` 保证至少留一组给余量 → 组数上界恰为 maxSteps（且永不产出空组）。
  const total = segs.reduce((n, seg) => n + seg.length, 0);
  const groups: string[] = [];
  let buf: string[] = [];
  let taken = 0;
  let made = 0;
  for (const seg of segs) {
    buf.push(seg);
    taken += seg.length;
    if (made + 1 < maxSteps && taken >= (total * (made + 1)) / maxSteps) {
      groups.push(buf.join("\n\n"));
      buf = [];
      made += 1;
    }
  }
  if (buf.length > 0) { groups.push(buf.join("\n\n")); }
  return groups;
}
