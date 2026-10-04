/**
 * core-ts/src/sidebarOpen.ts — A-1121（②）：**「右栏打开请求」的契约与归一（唯一出处）**。
 *
 * 背景：右栏原本只能被"打开一个网址"驱动（`setSidebarOpener(url, name?)`，唯一调用者是
 * `http_create_app`）。而右栏其实是 **Agent 的工具栏** —— 终端页、文件树页都该能被 Agent 打开。
 * 于是把 opener 从"一个 url 字符串"升级为**结构化请求**，同时**保持字符串入参可用**
 * （旧签名 = 旧语义 = 按 url 处理），这样任何未同步更新的调用点都不会静默失效。
 *
 * 为什么要单独一个模块（而不是留在 `tools/builtin.ts` 里）：
 *   · 这个契约的**生产者**是工具层（core-ts）、**转发者**是主进程（gui/main）、
 *     **消费者**是渲染层（gui/renderer）。它跨三个进程，塞在"工具实现文件"里会让
 *     gui 侧不得不 import 一个 4000 行的工具文件只为拿一个类型；
 *   · `normalizeSidebarOpenRequest` 是纯函数 ⇒ 可被守卫直接断言（含"未知 kind 怎么办"这类边界）。
 *
 * ⚠️ **不要**在这里做"该开哪个页签"的判断（复用同址页 / 空白页 / 新建）：那属于渲染层的
 * tabs 现状，core-ts 看不到也不该猜。本模块只回答"这个请求是否成立、字段归一成什么"。
 */

/** 右栏能承载的三类目标（`file` 由渲染层按扩展名再分流，见 gui 侧 `webPreview.ts`） */
export type SidebarOpenKind = "url" | "terminal" | "files";

export interface SidebarOpenRequest {
  kind: SidebarOpenKind;
  /** kind=url：要打开的网址 */
  url?: string;
  /** 页签标题（可省，渲染层会用域名 / 目录名兜底） */
  name?: string;
  /** kind=terminal：**预填**到终端输入框的命令（渲染层不自动执行 —— 执行与否是用户的决定） */
  cmd?: string;
  /** kind=files：目录浏览根（绝对路径优先；相对路径由渲染层按会话工作目录解析） */
  root?: string;
  /** kind=files：要在该根下定位到的条目（可省） */
  rel?: string;
  /** 来源：`site` = 站点弹窗/新窗口（会被渲染层的弹窗风暴保护限流） */
  from?: "site" | "user";
  /**
   * A-1142：**发起这次请求的会话**（工具循环注入的那个 `sessionId`）。
   *
   * ## 为什么必须有它
   * 右栏视图是**全局单例**（一个 `RightSidebar` 组件、一份 `tabs`），而 Agent 是**异步**的：
   * 用户在会话 A 派了任务、切到会话 B，此刻 A 的 Agent 才跑完工具 ⇒ 打开请求在 B 的界面上落地，
   * 用户看到的就是「上一个 Agent 的页开到了这个会话里」（实测复现）。
   * ⇒ 请求必须**自带归属**，渲染层才能判断"这条归不归当前显示的会话"。
   *
   * ⚠️ 它是**可选**的：站点弹窗 / 旧调用点拿不到会话号（→ 按"无法归属"处理，行为与以前一致）。
   * ⚠️ 判据只有 `sidebarOpenMatchesSession` 一处 —— 别在渲染层再内联一个"要不要收"的判断。
   */
  sessionId?: string;
}

/** 注入的打开器签名。**字符串入参仍可用**（= `{kind:"url"}`），旧调用点无需改动。 */
export type SidebarOpener = (req: string | SidebarOpenRequest, name?: string) => void;

let sidebarOpenerRef: SidebarOpener | null = null;

export function setSidebarOpener(fn: SidebarOpener | null): void { sidebarOpenerRef = fn; }

/** 是否已装配界面（未装配时工具回执必须**如实说明"界面未就绪"**，不能假装已打开） */
export function hasSidebarOpener(): boolean { return sidebarOpenerRef !== null; }

const trimOrUndef = (v: unknown): string | undefined => {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length > 0 ? t : undefined;
};

/**
 * 归一：把各种入参形态收敛成一个**字段干净**的请求；返回 `null` = 这个请求不成立。
 *
 * 不成立的唯一情形是 **url 类但 url 为空** —— 让调用方（工具回执）能如实报告"没打开"，
 * 而不是发一个空请求出去、被渲染层静默忽略（那就是"点了没反应"的经典成因）。
 * `terminal` / `files` 即使不带任何字段也成立：打开一个终端页 / 工作目录树本身就是有意义的动作。
 */
export function normalizeSidebarOpenRequest(
  req: string | SidebarOpenRequest,
  name?: string,
): SidebarOpenRequest | null {
  if (typeof req === "string") {
    const url = trimOrUndef(req);
    return url ? { kind: "url", url, name: trimOrUndef(name) } : null;
  }
  if (!req || typeof req !== "object") { return null; }
  const kind: SidebarOpenKind =
    req.kind === "terminal" || req.kind === "files" ? req.kind : "url";
  const nm = trimOrUndef(req.name) ?? trimOrUndef(name);
  /* ⚠️ 三个分支**都必须带上** `sessionId`：漏一个 kind = 那一类请求永远无法归属
     （表现是"只有终端页会串台"，最难查的那一种）。 */
  const sid = trimOrUndef(req.sessionId);
  if (kind === "terminal") {
    return { kind, cmd: trimOrUndef(req.cmd), name: nm, sessionId: sid };
  }
  if (kind === "files") {
    return { kind, root: trimOrUndef(req.root), rel: trimOrUndef(req.rel), name: nm, sessionId: sid };
  }
  const url = trimOrUndef(req.url);
  return url ? { kind: "url", url, name: nm, from: req.from, sessionId: sid } : null;
}

/**
 * A-1142：从工具参数里取「发起这次请求的会话号」（**唯一产地**）。
 *
 * 为什么单独一个函数：四个会开右栏的工具（`sidebar_open_terminal` / `sidebar_open_files` /
 * `http_create_app` / 未来的）都要取它，写四遍就会漏改一处 —— 而漏掉的那一个 kind
 * 表现为"只有这一类页会串台"，是最难查的一种回归。
 *
 * 口径与 `todo_write` 完全一致（`String(args.sessionId ?? "").trim()`）：
 * 会话号由工具循环注入，缺失 = 会话上下文没就绪（CLI / 测试），如实返回 `undefined`
 * （按"无法归属"处理），绝不许编一个。
 */
export function sessionIdFromArgs(args: Record<string, unknown>): string | undefined {
  const s = String(args.sessionId ?? "").trim();
  return s.length > 0 ? s : undefined;
}

/**
 * A-1142：这条右栏请求**属不属于当前显示的会话**（唯一判据）。
 *
 * ## 口径（三种情形，逐条都是刻意的）
 *   ① 请求没带 `sessionId`（站点弹窗 / 旧调用点）⇒ `true`：无法归属，保持旧行为交给当前会话。
 *   ② 带了、但当前没有会话号 ⇒ `false`：宁可让它不落地，也不许"无归属地串进"任何界面。
 *   ③ 两边都有 ⇒ 严格相等。
 *
 * ## ⚠️ 反面写法（本仓已付过账）
 * 「`if (reqSid && curSid && reqSid !== curSid) { return false; } return true;`」看着等价，
 * 实则两条边界都错：请求没带 ⇒ 放行（对）；当前没会话 ⇒ 也放行（错 —— 正是串台的口子）。
 * 收紧成"先判请求、再判当前"的两段式，才不会写出一个看起来更短、实际漏守的守卫。
 */
export function sidebarOpenMatchesSession(reqSid?: string, curSid?: string): boolean {
  const r = typeof reqSid === "string" ? reqSid.trim() : "";
  if (!r) { return true; }              // ① 无法归属
  const c = typeof curSid === "string" ? curSid.trim() : "";
  if (!c) { return false; }             // ② 当前无会话 ⇒ 不收带归属的请求
  return r === c;                        // ③
}

/**
 * 触发打开。返回 `false` 的两种情形都是**调用方必须出声**的：
 *   ① opener 未注入（没有界面 / 非 GUI 运行）→ 工具回执写"界面未就绪"；
 *   ② 请求归一后不成立（如 url 为空）→ 写"缺少可打开的地址"。
 * 吞掉异常同样返回 false：宁可让模型知道"这次没打开"，也不要让它以为打开了而继续往下走。
 */
export function fireSidebarOpen(req: string | SidebarOpenRequest, name?: string): boolean {
  if (!sidebarOpenerRef) { return false; }
  const normalized = normalizeSidebarOpenRequest(req, name);
  if (!normalized) { return false; }
  try {
    sidebarOpenerRef(normalized);
    return true;
  } catch {
    return false;
  }
}
