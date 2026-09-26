/**
 * gui/src/renderer/pages/streamFade.ts — 流式正文「逐单元渐入」的切分（纯逻辑，A-1061⑬）。
 *
 * 用户原话：「你优化一下文本出现的过渡衔接，现在的 Agent 流式吐字都是一整个一整个的蹦出来，
 * 不美观，你也加一个渐入的过渡动画，即吐字的时候由左到右，由浅到深，平滑的吐出。」
 * ⚠️ A-1065：用户随后**更正了方向** —— 「还是我之前说错了……出现的部分，从右到左的动画，
 * 现在老是从左到右的渐入」。位移方向（CSS 里）按更正翻转为从右侧滑入，见 `index.css`
 * `@keyframes streamUnitIn`。本模块只负责切分，与方向无关。
 *
 * 为什么需要**切分**，而不是给整块加一个 CSS 动画：
 *   流式正文每帧都会被 Markdown 重新解析 → 整块 DOM 被替换。给整块挂 `animation` 只会
 *   在挂载那一刻播一次（后面每帧都是"替换"，不是"新挂载"），动画根本不会跟字走。
 *   要让**刚吐出来的那几个字**各自渐入，就必须让它们成为**带稳定 key 的独立元素**：
 *   React 只在 key 首次出现时挂载 → 动画恰好播一次 → 老字符不重播、新字符才渐入。
 *
 * 因此这里把 `shown` 切成三段（A-1080 起；此前是两段，接缝切在行中间 —— 那正是
 * 「倒数第二行尾端留空白 + 整段往上挤着重排」的根因，见 `StreamFadeSplit.settled`）：
 *   · `settled`     —— 已定型前缀，**止于最后一个换行**，照旧交回 `<Markdown streaming>` 渲染
 *                      （保留语法高亮/列表/粗体）；
 *   · `linePrefix`  —— 最后一行的前半段（窗口之外的纯文本，**静态**），紧接 settled；
 *   · `tail`        —— 正在吐出的尾巴，切成若干**单元**，每个单元一个 span，各自动画。
 *
 * 三段**拼接即 `shown`**（不插任何东西），不变量：`settled.length + linePrefix.length === units[0].at`。
 *
 * ⚠️ 三条"静默翻车"的边界，每条都必须在切分里显式挡住（不是靠调用方小心）：
 *   ① **未闭合的代码围栏**（``` 计数为奇数）→ 整段交回 Markdown（`tail = ""`）。
 *      否则尾巴那一行会被渲染在 `</pre>` **外面** —— 观感是"代码从黑框里跑出来了"。
 *      这类问题过 tsc、过构建、过所有逻辑测试，只在用户眼里翻车。
 *   ② **同一行里反引号不成对**（行内 code 未闭合）→ 同样整段交回 Markdown。
 *   ③ 拉丁单词必须**连成一段**（不能按单字符切）—— 否则浏览器会在任意字符间断行，
 *      出现 "configu ration" 这种观感事故。CJK 没有词边界问题，逐字切才有"逐字吐出"的效果。
 */

/** 尾巴的最大长度（字符）。超过就只对最后这一段做渐入。
 *  取值是**观感与正确性的折中**：越小 → 行内 Markdown（如 `**粗体**`）定型越快、
 *  每帧挂的 span 越少；越大 → 渐入覆盖的字更多，但那段文字会**暂时**以纯文本显示。
 *  48 ≈ 打字机限速（28ms/字）下 1.3 秒的输出量，正是"刚吐出来"的视觉区域。 */
export const STREAM_FADE_TAIL_MAX = 48;

/** 一个渐入单元。`at` 是它在 `shown` 里的**绝对索引** —— 调用方用它当 React key。
 *
 *  ⚠️ **这个"稳定"是必须被 `splitStreamFade` 主动保证的不变量，不是天然成立的**：
 *  只要切分方式让 `at` 随窗口滑动而整体平移，全部 span 的 key 就会每帧变化 →
 *  React 全量重挂 → 动画每帧重播 → 用户看到的就是"闪烁"（A-1070 的真实根因，见 splitStreamFade）。
 *  ⇒ 任何"换个切法"的改动，都必须先过 `tests/gui/a1065-fade-text.spec.ts` 里那条
 *    「追加字符后，已有单元的 at 必须原地不动」的守卫（配了变异）。 */
export interface StreamFadeUnit { text: string; at: number }

export interface StreamFadeSplit {
  /**
   * 已定型前缀 —— **止于最后一个换行**（交回 Markdown 渲染成块）。
   *
   * ⚠️ A-1080：这里**不能**切在行中间。`settled` 会被 Markdown 渲染成**块级**段落，
   * 尾巴是它后面的行内 span —— 若 settled 以半行结尾，尾巴就只能从**下一行**开始：
   * 观感是"倒数第二行尾端留一片空白（那空白本该由尾巴填上）"，等窗口滑过去、那半行被并回
   * settled 时整段又重排一次（就是用户说的「往上挤着排」）。
   */
  settled: string;
  /** 最后一行的**前半段**：不参与渐入的纯文本，紧接 `settled`，与尾巴同处一个行内流 */
  linePrefix: string;
  /** 正在吐出的尾巴；空串 = 本轮不做渐入（整段落回 Markdown） */
  tail: string;
  /** 尾巴切成的单元（tail 为空时也是空数组） */
  units: StreamFadeUnit[];
}

/** 代码围栏是否**未闭合**（``` 出现奇数次 = 还停在代码块里） */
function inUnclosedFence(s: string): boolean {
  return ((s.match(/```/g) ?? []).length % 2) === 1;
}

/** 同一行内反引号是否不成对（行内 code 未闭合） */
function inUnclosedInlineCode(line: string): boolean {
  return ((line.match(/`/g) ?? []).length % 2) === 1;
}

/**
 * 单元切分：拉丁/数字/常见标点连成长段，空白各自成段，其余（CJK、emoji、其它符号）**逐字**成段。
 *
 * `base` 是首单元在 `shown` 里的绝对索引（= tailStart），用于给 `at` 定位。
 */
export function unitize(tail: string, base = 0): StreamFadeUnit[] {
  /* ① 拉丁/数字/ASCII 标点 → 连成一段（避免单词被断行）
     ② 空白 → 连成一段（保留多空格的宽度）
     ③ 其余任意单字符 → 逐字（CJK 逐字才有"逐字吐出"的观感） */
  const re = /[A-Za-z0-9_.,;:!?'"()[\]{}<>/\\+\-*=@#$%^&|~`]+|\s+|[\s\S]/g;
  const out: StreamFadeUnit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) {
    if (m[0] === "") { break; } // 理论上不会发生；防死循环
    out.push({ text: m[0], at: base + m.index });
  }
  return out;
}

/**
 * 把已显示的流式正文切成 `settled` + `tail`。
 *
 * 判据（顺序即优先级）：
 *   1. 空串 → 两边都空（调用方会渲染"正在思考"，零行为变化）
 *   2. 未闭合代码围栏 → 全部落回 Markdown（见文件头 ①）
 *   3. 最后一行有未闭合行内 code → 全部落回 Markdown（见文件头 ②）
 *   4. 尾巴只取**最后一行**（`最后一个换行之后`）：保证 tail 不含换行，
 *      从而不会因为尾巴里夹了换行而破坏调用方的排版假设。
 *   5. 最后一行超过 `maxTail` 时，从**尾部**回着取到 `maxTail` 为止 ——
 *      但边界必须落在**单元边界**上（见下）。
 *
 * ── A-1070（用户 #230）：为什么必须"在整行上左锚定切分 + 边界对齐到单元" ─────────────
 * 用户原话：「渐入吐字时，经常出现字体动画闪烁的情况，你稳定一下」。
 *
 * 真实根因（不是"动画时长没调好"）：旧实现先按 `末尾 − maxTail` 截出尾巴，
 * **再**对这段尾巴切单元。于是尾巴起点每帧 +1（正文每多一个字就滑一格），
 * 而 `unitize(tail, tailStart)` 给出的单元起点 = `tailStart + 段内偏移` —— **整体平移 1**。
 * 单元起点正是 React 的 key（见 `StreamFadeUnit.at`）⇒ **48 个 span 的 key 全部变化**
 * ⇒ React 把整条尾巴全部卸载重挂 ⇒ 每帧重播一次 260ms 渐入动画 ⇒ 用户看到的就是"闪烁"。
 *
 * 修法（一处改、两个症状一起消失）：
 *   · 单元在**整行**上从行首左锚定切分（`unitize(line, 行首绝对索引)`）——
 *     追加字符只会在末尾**新增**单元或延长最后一个单元，**已有单元的起点永不变**
 *     ⇒ key 稳定 ⇒ 已出现的字不重挂、不重播，只有真正新吐出的字播一次。
 *   · 窗口边界改为**从尾部回着累计到 maxTail**，且**不截断单元**（边界=单元起点）
 *     ⇒ 不会出现"首单元被切成半截"这种也会导致 key 变化的情形。
 *
 * 代价与取舍：单元起点必须整行扫一遍（O(行长度)，不是 O(全文)）—— 一行通常几十字符，
 * 与"每帧重挂 48 个 span"相比可以忽略。窗口至少保留一个单元：
 * 单个超长单元（如一条长 URL）会整块渐入，不会被切碎（切碎会让 key 抖动，反而回退）。
 */
export function splitStreamFade(shown: string, maxTail = STREAM_FADE_TAIL_MAX): StreamFadeSplit {
  const noFade: StreamFadeSplit = { settled: shown, linePrefix: "", tail: "", units: [] };
  if (!shown) { return { settled: "", linePrefix: "", tail: "", units: [] }; }
  if (inUnclosedFence(shown)) { return noFade; }
  const nl = shown.lastIndexOf("\n");
  const line = shown.slice(nl + 1);
  if (inUnclosedInlineCode(line)) { return noFade; }
  if (!line) { return noFade; }
  const lineUnits = unitize(line, nl + 1);
  // 从尾部回着累计到 maxTail：至少留一个单元（超长单元整块渐入）
  let start = lineUnits.length;
  let acc = 0;
  for (let i = lineUnits.length - 1; i >= 0; i -= 1) {
    const len = lineUnits[i].text.length;
    if (acc + len > maxTail && start < lineUnits.length) { break; }
    acc += len;
    start = i;
    if (acc >= maxTail) { break; }
  }
  const units = lineUnits.slice(start);
  const tailStart = units.length > 0 ? units[0].at : shown.length;
  const tail = shown.slice(tailStart);
  if (!tail) { return noFade; }
  /* A-1080：接缝必须落在**真实的换行**上（原话与原因见 `StreamFadeSplit.settled` 的注释）。
     不变量：`settled.length + linePrefix.length === units[0].at`
     —— 三段拼起来逐字等于 shown，中间**不插任何东西**。 */
  const lineStart = nl + 1;
  return {
    settled: shown.slice(0, lineStart),
    linePrefix: shown.slice(lineStart, tailStart),
    tail,
    units,
  };
}

/** 尾巴单元里"整块只由 markdown 标记字符组成"的形态（`**` / `#` / `>` / `` ` `` / `-` …）。
 *  ⚠️ **刻意不含 `|`**：纯管道单元（`|` / `||`）由下面那条 `TABLE_SEP_MARKER` 之前的
 *  兜底 `replace(/[*#|`]/g, "")` 抹成空串 —— 往里加 `|` 是**等价变异体**（删掉它行为不变），
 *  按项目铁律「冗余条件 = 等价变异体，删掉而不是留着」，这里就不列。 */
const PURE_MARKER = /^[-+*>#`~_]+$/;
/** 有序列表标记（`1.` / `12.`）；单元的 ASCII 连字符集把数字和点连在一起，故单独一判 */
const ORDERED_MARKER = /^\d{1,2}\.$/;
/** 表格分隔单元（`---` / `:--` / `|---|` 等，只由 `-` `:` `|` 空格组成且含 `-`）——
 *  整块隐藏；否则用户在吐字期会看到一排 `-----`（A-1094）。 */
const TABLE_SEP_MARKER = /^[|\-:\s]+$/;

/**
 * 尾巴单元的**显示文本**（渲染时用；切分时不用）。
 *
 * 为什么必须有这一层：尾巴是**纯文本**渲染的（见文件头——它要切成独立 span 才能各自渐入），
 * 于是 `**` / `#` / `~~` / `|` 这些 markdown 控制符号会**裸露**给用户。用户 A-1065 原话：
 * 「而且还出现了很多 markdown 渲染不全的 *、# 等符号」；A-1094 追加 `|`（表格语法）。
 * 修法不是"把尾巴也交给 Markdown"，而是**在尾巴上把控制符号抹掉**：
 *   ① 尾巴只存在几十毫秒到一秒多，随后整段落进 `settled` 由 Markdown 正式渲染
 *      （`**粗体**` 那时才变粗）——所以这里抹掉符号不会让用户"少看到内容"，
 *      只是把"控制符号裸露期"变成"朴素纯文本期"，而那正是用户要的。
 *   ② 若把尾巴也丢给 Markdown，尾巴就成了**第二个 Markdown 实例**（每帧重复解析），
 *      且行内语法在索引处被切断时会渲染出更奇怪的半成品 —— 反而更"渲染不全"。
 *
 * 规则（**保守**：只动明确是 markdown 语法的形态，宁可少抹不可乱抹）：
 *   · 空白单元**原样保留** —— 抹掉它会让相邻词粘在一起（`foo bar` → `foobar`）；
 *   · 整块只有标记字符（`**` / `#` / `>` / `` ` `` / `-` / `|`）→ 整块隐藏（返回空串）；
 *   · 表格分隔符单元（`---` / `|---|---|`）→ 整块隐藏；
 *   · 有序列表标记（`1.`）→ 隐藏；
 *   · 其余：抹掉 `**` `~~` 与残余的 `*` `#` `` ` `` `|`，行首标题标记被吃掉后的前导空格 trim。
 *
 * ⚠️ 单单元净化**无法**处理跨单元的空白（`| 序号 |` 会切成 `"|"`,`" "`,`"序"`…）：
 *   `|` 单元变空后，它旁边的 `" "` 单元就成了多余的前导/重复空格。所以**边界处的空格收敛
 *   必须整体做** —— 见 `visibleTailText`；本函数只管单单元。
 */
export function fadeUnitText(raw: string): string {
  if (!raw) { return raw; }
  if (/^\s+$/.test(raw)) { return raw; }
  if (PURE_MARKER.test(raw)) { return ""; }
  if (ORDERED_MARKER.test(raw)) { return ""; }
  // 表格分隔单元（如 `---`、`|---|---|`）——`PURE_MARKER` 已挡纯 `-`，这里挡带 `:`/`|` 的变体
  if (TABLE_SEP_MARKER.test(raw) && /-/.test(raw)) { return ""; }
  // `**粗体**`→`粗体`；残余 `*#`|`` 抹掉；行首标题标记被吃掉后遗留的前导空格 trim 掉
  return raw
    .replace(/\*\*|~~/g, "")
    .replace(/[*#|`]/g, "")
    .replace(/^[ \t]+(?=\S)/, "");
}

/**
 * 尾巴整段的**可见文本**（把所有单元的显示文本拼起来后做跨单元收尾）。
 *
 * 存在的理由：净化单位是**单元**，但空白是**跨单元**的（`| 序号 |` → `"|"`,`" "`,`"序"`…）——
 * `|` 单元变空后，它旁边的空格单元就变成多余的前导空格或重复空格。收尾放在**拼好之后**做，
 * 才是唯一能看全上下文的位置。
 *
 * ⚠️ 只做**收尾**（去首尾空格 + 收敛内部连续空格），**不改变文字内容**：
 *   保留 `const a = 1;` 里的单空格，也保留中文之间原本没有空格的事实。
 */
export function visibleTailText(units: readonly StreamFadeUnit[]): string {
  return units
    .map((u) => fadeUnitText(u.text))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+/, "")
    .replace(/[ \t]+$/, "");
}

/**
 * 与 `visibleTailText` 同源，但**保留单元结构**（供渲染层逐 span 挂动画）。
 *
 * 做法：先在整段上算出**收尾后的可见串**，再按原单元边界把结果切回各单元。
 * 收尾只会削掉整段的首/尾空白与内部连续空格 —— 映射回单元时，最多把某个单元的前缀/后缀
 * 削短或整块清空，**中间文字一个字符都不会动**。`at` 原样保留（React key 稳定 ⇒ 不重播动画）。
 *
 * ⚠️ 不许在这里**丢弃**空单元（要 push `text: ""` 占位）：单元数量/顺序若变，
 * 下游按 `at` 对齐的动画节拍会跟着变。是否渲染空 span 由渲染层决定。
 */
/**
 * 与 `visibleTailText` 同源，但**保留单元结构**（供渲染层逐 span 挂动画）。
 *
 * 做法：把整段先净化成"可见串"，再按各单元的**净化后长度**把可见串切回单元；长度不足的单元
 * 分到空串。收尾/收敛都发生在可见串上，所以跨单元的空格问题一次解决，而 `at` 原样保留
 * （React key 稳定 ⇒ 不重播动画）。空单元保留占位（`text: ""`），是否渲染由渲染层决定。
 */
export function visibleTailUnits(units: readonly StreamFadeUnit[]): StreamFadeUnit[] {
  const perUnit = units.map((u) => fadeUnitText(u.text));
  const joined = perUnit.join("");
  // 收尾后的**可见串**（唯一真源）：收敛连续空格 + 去首尾空格
  const visible = joined.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  /* 逐单元把可见串切回去。⚠️ 不能简单地"从头按各单元长度顺次取"——那会在跨单元被收敛掉
     空格时把后面单元的字**错位**到前面的 key 上。改为按**锚点对齐**：每个单元取其净化后文本
     在可见串中**原样出现**的那一段（找不到则空），保证字符归属不漂移。 */
  const out: StreamFadeUnit[] = [];
  let vi = 0;
  for (let i = 0; i < perUnit.length; i++) {
    const t = perUnit[i];
    if (!t) { out.push({ text: "", at: units[i].at }); continue; }
    // 空白单元：从当前位置吞一个空格（若可见串此处正是空格）
    if (/^\s+$/.test(t)) {
      if (visible[vi] === " ") { out.push({ text: " ", at: units[i].at }); vi += 1; }
      else { out.push({ text: "", at: units[i].at }); }
      continue;
    }
    if (visible.startsWith(t, vi)) {
      out.push({ text: t, at: units[i].at });
      vi += t.length;
    } else {
      // 兜底：逐字符对齐（正常不会走到；保证不丢字、不越界）
      const chunk = visible.slice(vi, vi + t.length);
      out.push({ text: chunk, at: units[i].at });
      vi += chunk.length;
    }
  }
  return out;
}

