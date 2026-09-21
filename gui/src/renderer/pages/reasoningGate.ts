/**
 * gui/src/renderer/pages/reasoningGate.ts — 思考面板的**懒挂载闸门**与两帧推进（A-1054①）。
 *
 * **为什么独立成模块**：这是「会话加载慢」的真根，判定必须能被单独测、被单独变异。
 * 放在 `ChatPanel.tsx` 里就只能靠读源码断言（"锁表达式不锁行为"），而这几行恰好是
 * 全项目最贵的一段逻辑 —— 它决定 141 条消息要不要在**默认收起态**下把 1090 个
 * TimelineNode 建出来。纯逻辑不许住 `.tsx`（见铁律）。
 *
 * ── 病：收起 ≠ 不挂载 ──
 * A-1015 为了给展开/收起做高度插值（`grid-template-rows: 0fr → 1fr`），把思考区改成
 * **常驻挂载 + 切类名**。代价是：`.collapse` 里的子节点**照常 mount**。
 * 于是默认 `collapsedReasoning[m.id] ?? true`（一条都没展开）的情况下，
 * 每一条历史消息都要跑一遍 `splitToolTrace` + `splitThinkingIntoSteps` + `sanitizeThinking`。
 *
 * 实测（config/history.jsonl 11.3MB / 最大会话 71 条记录 / 单条 reasoning 751KB）：
 *   - 该会话 IPC 载荷 8.76MB，其中 `content` 仅 150KB、`reasoning` 占 **4226KB（28 倍）**；
 *   - `splitThinkingIntoSteps` 单次 37.5ms → 1090 个节点；`sanitizeThinking` 66ms；
 *   - 这 88ms+ 与 1090 次挂载 **100% 是看不见的白工**（面板是收起的，用户一个字也看不到）。
 *
 * ── 药：把「正文」推迟到第一次展开 ──
 * 便宜的存在性守卫先跑（只看长度，不碰正则）→ 未展开过就**一个子节点都不挂**。
 * 展开过的此后保持挂载（`everMounted` 只增不减），收起仍靠 `0fr` 裁切，
 * 所以 A-1015 的动画完全不受影响 —— 这是本模块要同时守住的两件事。
 *
 * ⚠️ 两帧提交是**必需**的（`advanceReasoningFrame` 存在的唯一理由）：
 *   CSS 过渡需要"先有一帧旧值"。若把正文**首次挂载**与 `is-open` 放在同一次提交里，
 *   浏览器看到的是一个"新插入且已是终态"的元素 → 没有旧值 → 过渡不播（生硬跳变）。
 *   故拆成：第 1 帧只挂正文（类名仍收起，`0fr`，不可见）→ 第 2 帧再切 `is-open`。
 *   ⚠️ 这条极易被"顺手简化"成一个 setState 而**静默**丢掉动画（功能看起来正常）。
 *
 * 回归守卫见 `tests/core-ts/a1054-guards.spec.ts`（含变异验证）。
 */

/** 思考区所需的最小数据形状（结构化输入，避免与 `Message` 类型耦合）。 */
export interface ReasoningDataShape {
  /** A-1021b：模型流式返回的推理原文（历史消息里常常是唯一来源） */
  reasoning?: string;
  stages?: {
    /** 流式记录的真实交错顺序（历史消息通常缺失，需回退到文本切分） */
    timeline?: unknown[];
    /** 结构化工具留痕 */
    tools?: unknown[];
    /** 参考内容（工作目录文件） */
    reads?: unknown[];
    /** 访问来源（网页访问 / 搜索网址） */
    urls?: unknown[];
  };
}

/**
 * 数据存在性守卫：**只看长度，不跑正则、不做切分**。
 *
 * ⚠️ 这一步必须便宜：它会在**每一条**消息上运行（含收起态）。把切分逻辑放进来的话，
 *    "前置判断"本身就变成了那份开销，懒挂载等于没做。
 * 语义与 A-1015 一致：无思考数据 → 不渲染空壳（不出现"按钮在、点了没反应"）。
 */
export function hasReasoningData(m: ReasoningDataShape): boolean {
  return (m.reasoning ?? "").length > 0
    || (m.stages?.timeline?.length ?? 0) > 0
    || (m.stages?.tools?.length ?? 0) > 0
    || (m.stages?.reads?.length ?? 0) > 0
    || (m.stages?.urls?.length ?? 0) > 0;
}

/**
 * 正文是否该挂进 DOM。
 *
 * - 收起 **且从未展开过** → `false`：这才是省下来的那 88ms / 1090 次挂载；
 * - 展开 → `true`；
 * - 收起但展开过 → `true`（A-1015：收起只切类名，**不卸载**，否则收起瞬间没有可插值的元素）。
 */
export function shouldMountBody(open: boolean, everMounted: boolean): boolean {
  return open || everMounted;
}

/**
 * `.collapse` 是否该带 `is-open`（即 `1fr`）。
 *
 * ⚠️ `readyToOpen` 是**必需**的第二个条件，不是冗余：
 *   首次展开那一帧必须让类名**保持收起**（`0fr`），否则新挂上来的节点直接是终态 → 过渡不播。
 * ⚠️ 收起时**必须**返回 `false`，哪怕 `readyToOpen` 还是 `true`
 *   —— 否则收起动画会被 `1fr` 顶住（高度不塌）。
 */
export function isOpenClass(open: boolean, readyToOpen: boolean): boolean {
  return open && readyToOpen;
}

/** 两帧推进的状态（`everMounted` 只增不减；`readyToOpen` 跟随展开）。 */
export interface ReasoningFrame {
  everMounted: boolean;
  readyToOpen: boolean;
}

/**
 * 推进一帧。由 effect 在 `[open, everMounted, readyToOpen]` 变化时调用。
 *
 * 返回的 `{everMounted: true, readyToOpen: false}` 就是**第 1 帧**（只挂正文、类名仍收起）——
 * 调用方必须**只**应用"与当前不同的那一个字段"并立刻 return，让 React 再提交一帧，
 * 第 2 帧才轮到 `readyToOpen: true`。见文件头"两帧提交"。
 *
 * 收起（`open === false`）时**两个字段都不回退**：`everMounted` 保持 `true`（不卸载），
 * `readyToOpen` 保持原值（下次展开时它已经是 `true`，于是收起→展开只有**一帧**，
 * 这是对的：正文早就在 DOM 里，切类名即可插值）。
 */
export function advanceReasoningFrame(open: boolean, everMounted: boolean, readyToOpen: boolean): ReasoningFrame {
  if (!open) { return { everMounted, readyToOpen }; }
  if (!everMounted) { return { everMounted: true, readyToOpen: false }; } // 第 1 帧：挂正文，不展开
  if (!readyToOpen) { return { everMounted: true, readyToOpen: true }; }  // 第 2 帧：切 is-open
  return { everMounted: true, readyToOpen: true };                        // 幂等
}
