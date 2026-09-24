/**
 * core-ts/src/services/agentProcs.ts — 「Agent 启动的后台资源」面板的**纯判据**（唯一出处）。
 *
 * ══ 用户需求（#226）════════════════════════════════════════════════════════
 * 「请把 Agent 停下时的后台进程做一个……在输入栏上方的按钮，而且点击后可以展开」。
 * 用户并明确划定了范围：**仅 Agent 启动的进程** —— 应用自身的服务（Python 后端、
 * llama-server、MCP 常驻、情感脑 sidecar）**不算**（它们不是 Agent 干的，也不该由用户
 * 在这里随手关掉：关掉等于把应用打瘸）。
 *
 * ══ 为什么做成"纯函数派生视图"而不是"注册表对象"────────────────────────────
 * 一个 `register/unregister` 的注册表有一整类**结构性风险**：某个出口忘了 `unregister`
 * （进程崩了 / 走异常分支 / 被外部 kill）→ 面板上永远挂着一个阴魂条目，而代码、类型检查
 * 全绿。本项目已经为同族问题付出过代价（见 `ref-engineering` 关于 "mark-flag 要问所有出口
 * 都复位了吗"）。⇒ 这里改成 **每次请求时从活的真源现算**：
 *
 *     真源：屏幕控制器的常驻宿主 / httpServer.list() / subagents.list()
 *        └─→ buildAgentProcView(sources, now)   ← 纯函数，无状态、可单测
 *
 * 「忘了解注册」这一整类 bug 因此在结构上不存在 —— 真源里没有了，视图里就没有了。
 *
 * ══ 范围内的三类（就是 Agent 的工具能起、且在 Agent 停下后**仍然活着**的东西）════
 *   ① `screen-host`  桌面图形控制的**常驻 PowerShell 宿主**（`screen/backends/desktop.ts`
 *      首次 `screen_*` 时 spawn，之后一直挂着等命令 —— 用户任务都结束了它还活着）
 *   ② `http-server`  `http_serve` 起的静态服务（在进程内监听端口，跨轮次存活）
 *   ③ `subagent`     `delegate_subagent(background=true)` 派出的后台子代理（跨轮次继续跑）
 *
 * ⚠️ 明确**不在**范围内的（用户已划定；也写进守卫，防止将来被"顺手加进来"）：
 *   `llama-server` / 应用 Python 后端 / MCP server / 情感脑 sidecar / Electron 自身。
 *   它们由**应用生命周期**管理，不是 Agent 的工具起的；把它们混进来会让用户以为
 *   "关掉就只是停个任务"，实际是把应用的能力拆了。
 *
 * 本模块**不 import electron / child_process**，因此守卫可以直接 import 断言行为
 * （而不是只能锁源码形态）。
 */

/** Agent 启动的后台资源类别（唯一出处；新增一类必须同时改 `STOP_ACTIONS` 与守卫） */
export type AgentProcKind = "screen-host" | "http-server" | "subagent";

/** 全部类别（顺序 = 面板里的分组顺序：宿主 → 服务 → 子代理） */
export const AGENT_PROC_KINDS: readonly AgentProcKind[] = ["screen-host", "http-server", "subagent"];

/** 类别 → 面板上的中文名（唯一出处；组件不许自己拼） */
export const AGENT_PROC_KIND_LABELS: Record<AgentProcKind, string> = {
  "screen-host": "图形控制宿主",
  "http-server": "本地服务",
  "subagent": "后台子代理",
};

/**
 * 该类资源**是不是"仅 Agent 启动的"**（用户划定的范围，唯一出处）。
 *
 * ⚠️ 这个函数存在的意义不是"判断"，而是把**范围决策**变成一个可被守卫锁住的事实：
 *   否则哪天有人顺手把应用服务塞进视图，改动看起来只是"多了一类"，
 *   而用户会以为关掉它只是停个任务。返回 false 的类别**根本不该产生 source**。
 */
export function isAgentStartedKind(kind: string): kind is AgentProcKind {
  return (AGENT_PROC_KINDS as readonly string[]).includes(kind);
}

// ── 真源（由装配方从活对象上读取；本模块不碰它们）─────────────────────────
export interface ScreenHostSource {
  /** 常驻宿主进程 pid（拿不到时省略 —— 不影响展示） */
  pid?: number;
  /** 启动时刻（ms） */
  startedAt: number;
}
export interface HttpServerSource {
  id: string;
  port: number;
  host?: string;
  dir: string;
  startedAt: number;
  /** 累计请求数（有则展示，作为"确实在被访问"的证据） */
  requests?: number;
  /**
   * 谁起的（#230 的范围修正）：
   *   `agent`（缺省）= 本次应用运行期间由 Agent 的工具起的 → 进面板；
   *   `restored`     = 应用**启动时**按上一次运行的持久化清单重建的（A-977）。
   *
   * 用户原话：「我昨天你这个项目刚落地，我第一次打开，它直接显示一个后台端口运行，
   * 这没必要啊，我要的是 **Agent 运行途中打开的工具、脚本、端口**，其他的就没必要了啊。」
   * ⇒ 启动时重建的服务是**应用自己**建的，不属于"Agent 运行途中打开的"，不进面板。
   *   （A-977「重启后旧链接仍可用」的目的不受影响：服务照常运行、照常可访问。）
   */
  origin?: "agent" | "restored";
}
export interface SubagentSource {
  id: string;
  name: string;
  task?: string;
  startedAt?: number;
  /** 真源里的状态词（`running` / `done` / …）；本模块只做展示映射 */
  status?: string;
}

export interface AgentProcSources {
  /** 图形控制常驻宿主；null/undefined = 没起（绝大多数时候都没起） */
  screenHost?: ScreenHostSource | null;
  httpServers?: readonly HttpServerSource[];
  subagents?: readonly SubagentSource[];
}

// ── 视图 ────────────────────────────────────────────────────────────────────
export interface AgentProcEntry {
  kind: AgentProcKind;
  /** 停止时要用的句柄（http 是服务 id；subagent 是 run id；screen-host 为空串） */
  id: string;
  /** 面板上的类别名 */
  kindLabel: string;
  /** 主标签（进程名 / 端口 / 子代理名） */
  label: string;
  /** 次要说明（目录 / 任务 / pid） */
  detail: string;
  /** 启动时刻（ms；未知则省略） */
  startedAt?: number;
  /** 已运行时长（人类可读；`startedAt` 未知则为空串） */
  elapsed: string;
  /** 展示用状态词 */
  status: string;
}

export interface AgentProcView {
  /** 条目总数（= 按钮上的徽标数字） */
  count: number;
  /** 有没有东西可展示（false → 整个按钮不渲染，不留空壳） */
  any: boolean;
  entries: AgentProcEntry[];
}

/** 毫秒 → 人类可读时长（「刚刚」/「3 秒」/「2 分 10 秒」/「1 小时 5 分」）。
 *  ⚠️ 负数（时钟回拨 / startedAt 在未来）一律按「刚刚」，绝不显示负时长。 */
export function formatElapsed(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(now)) { return ""; }
  const ms = now - startedAt;
  if (ms < 1000) { return "刚刚"; }
  const sec = Math.floor(ms / 1000);
  if (sec < 60) { return `${sec} 秒`; }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const rest = sec % 60;
    return rest === 0 ? `${min} 分` : `${min} 分 ${rest} 秒`;
  }
  const hr = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin === 0 ? `${hr} 小时` : `${hr} 小时 ${restMin} 分`;
}

/** 子代理状态词 → 展示词（`running` 之外的终态也照实说，不假装还在跑） */
export function subagentStatusLabel(status: string | undefined): string {
  switch (status) {
    case "running": return "运行中";
    case "pending": return "排队中";
    case "done": return "已完成";
    case "fail": return "失败";
    case "timeout": return "超时";
    case "cancelled": return "已取消";
    default: return status ? status : "已派出";
  }
}

/** 子代理还在跑吗（只有这一种才算"后台进程"，终态条目不该再出现在面板里） */
export function isSubagentLive(status: string | undefined): boolean {
  return status === "running" || status === "pending";
}

/** 路径过长时中间省略（面板只有一行位置，尾部信息更有用） */
function shortenPath(p: string, max = 46): string {
  if (p.length <= max) { return p; }
  const keep = max - 1;
  const head = Math.ceil(keep / 3);
  const tail = keep - head;
  return `${p.slice(0, head)}…${p.slice(p.length - tail)}`;
}

/**
 * 由**活真源**派生面板视图。纯函数：不读时钟（`now` 传入）、不碰 IO。
 *
 * 两条取舍：
 *   · 子代理只收 `pending/running` —— 终态条目留在面板里会变成"点停止却什么都没发生"的坏体验；
 *     终态的历史记录属于右侧栏的运行记录，不属于"后台进程"面板。
 *   · 排序：先按类别（`AGENT_PROC_KINDS` 的顺序），同类内按启动时间**早→晚**（先起的在上面）。
 */
export function buildAgentProcView(src: AgentProcSources, now: number): AgentProcView {
  const entries: AgentProcEntry[] = [];

  const host = src.screenHost;
  if (host) {
    entries.push({
      kind: "screen-host",
      id: "",
      kindLabel: AGENT_PROC_KIND_LABELS["screen-host"],
      label: "PowerShell 图形控制宿主",
      detail: host.pid !== undefined ? `pid ${host.pid}` : "常驻进程中",
      startedAt: host.startedAt,
      elapsed: formatElapsed(host.startedAt, now),
      status: "常驻",
    });
  }

  for (const s of src.httpServers ?? []) {
    /* #230：启动时由 `restore()` 重建的服务不进面板 —— 它不是"Agent 运行途中打开的"。
       判据放在**纯视图**里（而不是只放在装配层过滤），是为了让守卫能直接锁住这条范围决策：
       否则哪天有人把过滤从 index.ts 挪走/删掉，改动看起来"只是少一行"，而用户又会
       在刚打开应用时看到一个自己从没起过的端口。 */
    if (s.origin === "restored") { continue; }
    entries.push({
      kind: "http-server",
      id: s.id,
      kindLabel: AGENT_PROC_KIND_LABELS["http-server"],
      label: `127.0.0.1:${s.port}${s.host && s.host !== "127.0.0.1" ? `（${s.host}）` : ""}`,
      detail: shortenPath(s.dir) + (typeof s.requests === "number" ? `  ·  ${s.requests} 次请求` : ""),
      startedAt: s.startedAt,
      elapsed: formatElapsed(s.startedAt, now),
      status: "监听中",
    });
  }

  for (const a of src.subagents ?? []) {
    if (!isSubagentLive(a.status)) { continue; }
    const task = (a.task ?? "").replace(/\s+/g, " ").trim();
    entries.push({
      kind: "subagent",
      id: a.id,
      kindLabel: AGENT_PROC_KIND_LABELS["subagent"],
      label: a.name,
      detail: task ? shortenPath(task, 60) : "（无任务描述）",
      startedAt: a.startedAt,
      elapsed: formatElapsed(a.startedAt, now),
      status: subagentStatusLabel(a.status),
    });
  }

  const rank = (k: AgentProcKind): number => AGENT_PROC_KINDS.indexOf(k);
  entries.sort((x, y) => {
    const d = rank(x.kind) - rank(y.kind);
    if (d !== 0) { return d; }
    return (x.startedAt ?? 0) - (y.startedAt ?? 0);
  });

  return { count: entries.length, any: entries.length > 0, entries };
}

// ── 停止动作（纯判据 → 装配方执行）─────────────────────────────────────────
export type AgentProcStopAction = "dispose-screen-host" | "stop-http-server" | "cancel-subagent";

/** 停止某类资源要用哪个动作（唯一出处；组件与主进程都不许自己 switch） */
export const AGENT_PROC_STOP_ACTIONS: Record<AgentProcKind, AgentProcStopAction> = {
  "screen-host": "dispose-screen-host",
  "http-server": "stop-http-server",
  "subagent": "cancel-subagent",
};

export interface AgentProcStopRequest { kind: string; id?: string }
export type AgentProcStopPlan =
  | { ok: true; action: AgentProcStopAction; id: string }
  | { ok: false; reason: string };

/**
 * 校验一次停止请求 → 给出可执行的动作。**纯函数**，把"什么样的请求是合法的"从主进程里
 * 抽出来单测（主进程要 import electron，测不了）。
 *
 * ⚠️ 未知 kind **必须拒绝**：否则一个手改的 IPC 参数会让主进程去调不存在的分支
 *   （静默什么都不做，而界面已经乐观地把那一条划掉了 —— 面板与真实状态就此分家）。
 * ⚠️ `http-server`/`subagent` 必须带 id：不带就"停哪个"无从谈起。`screen-host` 反之：
 *   全局只有一个宿主，**不接受** id（带了说明调用方搞错了对象，宁可拒绝）。
 */
export function planAgentProcStop(req: AgentProcStopRequest): AgentProcStopPlan {
  const kind = req?.kind;
  if (!isAgentStartedKind(kind)) {
    return { ok: false, reason: `未知的后台资源类别：${String(kind ?? "(空)")}` };
  }
  if (kind === "screen-host") {
    return { ok: true, action: AGENT_PROC_STOP_ACTIONS[kind], id: "" };
  }
  const id = typeof req.id === "string" ? req.id.trim() : "";
  if (!id) {
    return { ok: false, reason: `${AGENT_PROC_KIND_LABELS[kind]}缺少 id（无法确定要停哪一个）` };
  }
  return { ok: true, action: AGENT_PROC_STOP_ACTIONS[kind], id };
}
