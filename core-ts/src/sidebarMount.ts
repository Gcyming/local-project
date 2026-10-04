/**
 * core-ts/src/sidebarMount.ts — A-1144：右栏「**挂载**」（把用户此刻在看的东西自动带进对话上下文）。
 *
 * ## 为什么要有它（用户原话）
 * 「我想要的是跟**挂载文件夹**一样，直接实时监测挂载右侧边栏的内容，对话的时候，对应会话的 Agent
 *  可以监测到右侧边栏内容，用户直接提要求的时候 Agent 不需要用户额外说一大段提示词，
 *  直接联想到右侧边栏挂载的内容。」
 *
 * 上一版是「交给 slime」按钮：用户得**手动**点一下，把一段文本塞进输入框。三个问题：
 *   ① 用户不点，Agent 就不知道右栏有什么（"它明明在屏幕上"）；
 *   ② 它把**所有**页签都播报（连"待办任务"这种内部列表也冒出来，用户截图吐槽"怎么待办任务列表都会出现这个"）；
 *   ③ 手动注入的那一段是**一次性**的，之后右栏变了、Agent 拿到的还是旧的那份。
 *
 * ## 权威依据（MCP Apps 规范，两条硬原则）
 * · 「**Anything displayed to the user must also be available to the model**」
 *   —— 界面上给用户看的东西必须同时对模型可见，否则那就是个 black box：
 *      用户说「这个/这一页」时模型无从指认，只能反问，体验直接崩。
 * · 「**User interactions must be sent back to the model**」
 *   —— 用户点开哪一条、切到哪一页，必须回送到模型上下文，否则模型下一句就是说错的。
 *
 * ## 为什么是「每轮自动附摘要 + 详情按需读」（用户选定的口径）
 * 全文注入太贵（一个长网页能把上下文吃掉一大半，与本项目的"上下文压缩"目标直接冲突）；
 * 只做按需读取则"用户不额外说一句，Agent 根本想不到去读"。
 * ⇒ 摘要常驻（几行，说清"现在挂着什么、地址是什么"），要点开正文时用 `sidebar_mount` 工具或直接 fetch。
 *
 * ## ⚠️ 必须按会话隔离
 * 右栏是 **per-session** 的（A-1142：上一轮刚修完"上一个会话的页开到当前会话"）。
 * 挂载是同一条链路的延伸 —— 若不带 sessionId，会话 B 的提问会读到会话 A 的右栏内容，
 * 那就是把刚修好的串台从"显示层"搬到"上下文层"重演一遍。
 */

/** 渲染层上报的一份挂载快照。 */
export interface SidebarMountPayload {
  /** 这条挂载属于哪个会话（**隔离的唯一依据**）。 */
  sessionId: string;
  /** 给模型看的那段文本（由渲染层的 `describeSidebarSnapshot().inject` 产出，唯一产地）。 */
  text: string;
  /** 上报时刻（调试/排序用；不参与判据）。 */
  at?: number;
}

let current: SidebarMountPayload | null = null;

/** 渲染层上报（经主进程 IPC 到达这里）。空/无内容的挂载必须传 `null`（清空）——否则会一直报旧内容。 */
export function setSidebarMount(p: SidebarMountPayload | null): void {
  if (!p || !p.sessionId || !String(p.text ?? "").trim()) {
    current = null;
    return;
  }
  current = { sessionId: p.sessionId, text: String(p.text), at: p.at ?? Date.now() };
}

/** 当前挂载（**仅供主进程/工具层读取**；返回的是原始载荷，未做会话判断）。 */
export function getSidebarMount(): SidebarMountPayload | null {
  return current;
}

/**
 * 把挂载渲染成可以拼进系统提示的一段。**纯函数**（喂同样输入给同样输出，可被守卫直接断言）。
 *
 * @returns `""` = 这段不该注入（三种情形都归零：没有挂载 / 没给会话号 / 会话不匹配）
 *
 * ⚠️ **会话不匹配一律返回空**：右栏是 per-session 的，别让 B 会话读到 A 的右栏。
 * ⚠️ 也**不许**"没给 sessionId 就退化成全局注入"—— 那正是上面这条隔离被绕开的口子。
 */
export function sidebarMountSection(sessionId?: string): string {
  const cur = current;
  if (!cur) { return ""; }
  const sid = String(sessionId ?? "").trim();
  if (!sid || sid !== cur.sessionId) { return ""; }
  const text = String(cur.text ?? "").trim();
  if (!text) { return ""; }
  return `【右侧边栏 · 实时挂载】\n${text}\n`
    + `（这是用户此刻在右栏看的东西，**不是**用户刚说的话。用户在对话里说「这个 / 这一页 / 它 / 帮我看看」`
    + `而上下文里没有别的指代对象时，优先理解成右栏这一项；需要正文就用 web_fetch 打开上面的地址，`
    + `不要反问用户「你指的是什么」。右栏换了内容这里会跟着变。）`;
}

/** 仅供测试复位。 */
export function __resetSidebarMountForTest(): void {
  current = null;
}
