/**
 * gui/src/renderer/pages/insertCopy.ts — 中途插入的**文案与闸门**唯一出处。
 *
 * ## 三态语义的权威在 `instructionQueue.ts`（这里只负责说话）
 *
 *   ① **排队（queue）**：Enter（流活跃时）→ 入队，**不直接发送**，等本轮自然收尾后按序发出；
 *   ② **引导（steer）**：待发卡片上的「现在插入」→ **直接发送**，在下一个工具调用之后的
 *      **轮次边界**注入当前这一轮（消费点 `core-ts/src/tool_loop.ts` 的 `injectSteers`）；
 *   ③ **中断（interrupt）**：只有「停止」按钮（Esc 语义）。
 *
 * ## 为什么必须有这个模块（本项目反复踩的"说反话"）
 *
 * 界面文案描述某个动作的**结果**，代码走的却是另一个口径 —— 过 tsc、过全部行为测试，
 * 只在用户眼里翻车（A-1052/§21 的同族，见 MEMORY 铁律 §5）。
 * 这里的具体翻车史：
 *   · textarea placeholder 曾写"输入消息（Enter 发送…）"（**新消息**口径），
 *     而回车在流活跃时实际入队/注入 —— 用户按"新消息"的心智操作，得到相反行为；
 *   · 发送按钮 title 曾写"加入待发：本轮结束后自动按顺序发出"（**排队**口径），
 *     却挂在一个会走 steer 的按钮上。
 * ⇒ 判据：**凡是"文案描述动作结果"的地方，文案必须与判据同源**。
 *   所以文案一律从这里导出，组件只调用、不拼字符串。
 *
 * ## A-1062 的方向选择器已被撤销（用户原话）
 *
 * 「这个选项也没必要，原本的就够了，**排队不直接发送，不排队直接发送**，你还专门划分一下，很多余」。
 * 撤销的是：输入框上方那行 ◉引导 / ○排队 单选 + 后果行 + `steerIntent` 方向状态 + 方向类型/
 * 选项表/`effectiveSteerIntent`。理由是**它把"两件不同的事"混成了一个可调开关**：
 * 在中途插入里，"排队"与"直接发送"本来就由**两个不同的动作**表达（回车 vs 卡片上的「现在插入」），
 * 再叠一个方向单选，等于给同一个选择造了第二个产地 —— 而且它只作用于"回车"这一个动作，
 * 用户选了「排队」再按卡片箭头仍是插入，自相矛盾。
 *
 * 回归守卫见 `tests/gui/insert-copy.spec.ts`；变异见 `gui/scripts/mut-a1062-insertcopy.mjs`。
 */

/**
 * 压缩窗口的阶段口径（与 ChatPanel 的 `compressUi.stage` 同形）。
 * `done` / `undefined` 都**不算**窗口内 —— 那时压缩已经结束，工具循环恢复消费引导。
 *
 * A-1082 新增 `skip`（未压并如实说明原因）与 `overflow`（压完仍超限）：两者**同样算窗口内**。
 * ⚠️ 别以为"只是通知态"就放行 —— 它们出现在**发送前**的压缩阶段（`maybeAutoCompress` 还没返回、
 * 流还没起），此刻把 steer 直接投出去同样会落到一个没人消费的循环上（空头支票）；
 * 且反应式路径下还会与随后的重试流撞成两条并发流。与 `trunc` 同处理：登记为可取消的预输入。
 */
export type CompressStage = "prep" | "summarize" | "done" | "trunc" | "skip" | "overflow" | null | undefined;

/**
 * 是否处于**压缩窗口**（工具循环正被压缩体检占用，**没人消费引导缓冲**）。
 *
 * ⚠️ 唯一出处：ChatPanel 里此前是内联的三段 `||`（`stage === "prep" || "summarize" || "trunc"`），
 *    而且被抄了两份（send() 一份、压缩补投 effect 一份）—— 散落即漂移。加阶段必须改这里。
 */
export function isCompressWindow(stage: CompressStage): boolean {
  return stage === "prep" || stage === "summarize" || stage === "trunc" || stage === "skip" || stage === "overflow";
}

/**
 * 运行中输入框的 placeholder —— **Enter 这条路的真实结果**。
 *
 * ⚠️ 两个都不许退回去：
 *   ① 不许退回"输入消息（Enter 发送…）"—— 那是**新消息**口径，而流活跃时回车并不发新消息；
 *   ② 不许说成"直接插入/立即注入"—— 回车不是立刻注入（立刻注入是卡片上那个动作）。
 *     A-1061⑦ 曾把回车改成"即投递"，A-1062 又用方向单选去补，两轮都没解决问题：
 *     用户要的是**两条路各自说清楚**，不是给回车加一个方向开关。
 */
export function steerPlaceholder(): string {
  return "输入要补充的话（回车加入待发，本轮结束后发出；要立刻插进正在跑的这轮，点待发卡片上的「现在插入」）";
}

/** 运行中发送按钮的 `title` —— 与 placeholder **同源**（同一个动作，不许两种口径）。 */
export function steerSubmitTitle(): string {
  return "加入待发：本条排在本轮之后发出。要立刻插进正在跑的这轮，点待发卡片上的「现在插入」";
}

/**
 * 待发卡片「现在插入」按钮的 `title` —— 说清**什么时候生效**（用户最容易误解的一点：
 * 以为点了就立刻在正文里插入一句话）。
 *
 * ⚠️ 这也是"点了没反应"的防线：诚实说明"本轮没有工具调用就顺延到下一轮"，
 *    比让用户以为坏掉了要好（对齐 Cursor 2026-08-19 的 "follow-ups wait for the next tool call"）。
 */
export function insertNowTitle(): string {
  return "引导（现在插入）：把这条注进正在跑的这轮（不打断它）——在下一个工具调用之后的轮次边界生效；"
    + "本轮没有工具调用就顺延到下一轮发出。想立刻停掉请用「停止」";
}

/**
 * 可提交性（对齐 ask_user 的 `canSubmitAsk`）：**有文字或有图**才可提交。
 *
 * 为什么要有这个闸门：空提交会往队列里塞一条既无文字又无图的幽灵卡片
 * （渲染回落成"（仅图片）"却又没有图），用户看得见却投不出去。
 * 传入 `images` 是**数量**而非数组 —— 调用方直接给 `pendingImages.length`，无需构造临时数组。
 */
export function canSubmitSteer(text: string, images: number): boolean {
  if (images > 0) { return true; }
  return text.trim().length > 0;
}
