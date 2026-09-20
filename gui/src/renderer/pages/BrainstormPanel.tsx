/**
 * gui/src/renderer/pages/BrainstormPanel.tsx — 群聊专属右侧栏（A-950/A-951）。
 * - 上方：群聊全部成员索引卡（头像/名字/角色/供应商/模型/状态/上下文进度条），紧凑排版不拥挤
 * - 分隔线
 * - 下方：思考碰撞流——实时滚动显示各成员思考过程（state=thinking 事件），
 *   完成后显示「观点」摘要；成员间观点在此"碰撞"
 * 数据源：slime:brainstorm:event（main 在每次成员状态变化时广播）+ agents.list（成员元数据）。
 */
import React, { type JSX } from "react";
import { EFFORT_LABEL } from "../reasoning.js";
import { ChevronIcon } from "../components/Icon.js";
import { inferModelCapabilities } from "../../../../shared/gen/model-capabilities.js";
/*
 * A-1013：「思考碰撞」流的状态机与持久化（零依赖纯模块，vitest 直测）。
 * 修的是三个叠加缺陷：① thinking 与 idea 走了两条语义不同的写入路径（后者整批覆盖 →
 * 每个成员说完就把累积思考全抹掉，用户："消失得七七八八，只有总结"）；
 * ② flow 只活在 React state（重启即空）；③ `slice(-120)` 静默丢弃更早条目。
 * 现在两种事件共用 `appendFlowEvents` 一条路，并按 `sessionId` 读写 localStorage。
 */
import { appendFlowEvents, emptyFlowState, readFlowState, writeFlowState, type FlowEvent, type FlowState } from "./brainstormFlow.js";

interface MemberView {
  id: string;
  name: string;
  state: "thinking" | "speaking" | "done" | "idle";
  role?: string;
  /** 供应商（api:openai:gpt-4o → openai；local:xxx → 本地；inherit → 继承） */
  provider?: string;
  model?: string;
  lastIdea?: string;
  used?: number;
  cap?: number;
  /** A-963 双向桥-后向：SILAM 情感/成长态缓存（仅 silam 成员有，主面板轮询 6s 刷新） */
  affect?: { fear?: number; desire?: number; n_nodes?: number; step?: number };
}

interface BrainstormEvent {
  sessionId: string;
  memberId: string;
  name: string;
  state?: "thinking" | "speaking" | "done" | "idle";
  chunk?: string;
  content?: string;
  used?: number;
  cap?: number;
  /** A-963 双向桥-后向：SILAM 情感/成长态（轮询刷新，仅 silam 成员有） */
  affect?: { fear?: number; desire?: number; n_nodes?: number; step?: number };
}

/** A-951：从 model_choice 解析 供应商/模型 两段（api:<provider>[:<model>] / local:<id> / inherit） */
export function parseProviderModel(choice: string): { provider?: string; model?: string } {
  const c = (choice ?? "").trim();
  if (!c) { return {}; }
  if (c === "inherit") { return { provider: "继承", model: undefined }; }
  if (c.startsWith("local:")) {
    const id = c.slice(6).trim();
    return { provider: "本地", model: id || undefined };
  }
  if (c.startsWith("api:")) {
    const rest = c.slice(4);
    const sep = rest.indexOf(":");
    if (sep > 0) {
      return { provider: rest.slice(0, sep), model: rest.slice(sep + 1) || undefined };
    }
    return { provider: rest || undefined, model: undefined };
  }
  return { provider: "自定义", model: c || undefined };
}

/** A-954：按入群模型匹配供应商规格，返回 context_window（api:<key>:<model> → providerModels 查 id） */
export function modelWindowCap(
  model: string,
  providerModels?: Array<{ key?: string; models?: Array<{ id: string; context_window?: number }> }>,
): number | undefined {
  const m = (model ?? "").trim();
  if (!m || !Array.isArray(providerModels)) { return undefined; }
  const rest = m.startsWith("api:") ? m.slice(4) : m;
  const sep = rest.indexOf(":");
  const key = sep > 0 ? rest.slice(0, sep) : rest;
  const id = sep > 0 ? rest.slice(sep + 1) : undefined;
  for (const p of providerModels) {
    if (p.key !== key || !Array.isArray(p.models)) { continue; }
    const hit = id ? p.models.find((x) => x.id === id) : p.models[0];
    if (hit?.context_window && hit.context_window > 0) { return hit.context_window; }
  }
  return undefined;
}

/* ── A-1011 群聊成员「思考推理强度」───────────────────────────────
 * 需求：右栏每张成员卡一个可展开按钮，单独调这位成员的推理强度（只作用于本群聊，
 * 不写 Agent 全局配置）。下面是可单测的纯逻辑（与 parseProviderModel 同处一文件，
 * 沿用本文件既有约定）。 */

/** A-1011：群聊默认推理强度——与引擎 `toParticipant` 的兜底一字不差（成员未设置时用它） */
export const GROUP_DEFAULT_EFFORT = "high";

/** A-1011：某成员可选的推理等级 + 它「是否真会被上游采纳」。
 *  - levels：可选等级。优先取能力表命中的 efforts；未命中用 low/medium/high 通用兜底
 *    ——与 ChatPanel「推理配置」同一个 inferModelCapabilities 数据源，杜绝双份漂移。
 *  - effective=false：该模型**不接收强度等级**（引擎改用别的协议开思考）。
 *    此时不给"调了没反应"的假旋钮，只给说明 —— 假旋钮比没有旋钮更坏。
 *  - note：展开面板里的一行说明，讲清为什么可选 / 为什么不可选。 */
export function memberEffortCap(choice: string): { levels: string[]; effective: boolean; note: string } {
  const c = (choice ?? "").trim();
  // 本地模型：引擎 reasoningParamsForModel 对 kind==="local" 在推断之前就返回
  // chat_template_kwargs（core-ts/src/services/engine.ts），effort 一律不生效。
  if (c.startsWith("local:")) {
    return {
      levels: [], effective: false,
      note: "本地模型（llama.cpp）的思考由模板参数 chat_template_kwargs 开启，不接收推理强度等级。",
    };
  }
  const modelId = parseProviderModel(c).model ?? "";
  if (!modelId) {
    return { levels: ["low", "medium", "high"], effective: true, note: "未解析到具体模型，按通用等级兜底。" };
  }
  const caps = inferModelCapabilities(modelId);
  if (!caps.supported) {
    return {
      levels: [], effective: false,
      note: `能力表标注「${modelId}」不支持思考，推理强度对它无意义。`,
    };
  }
  const levels = caps.efforts && caps.efforts.length > 0 ? [...caps.efforts] : ["low", "medium", "high"];
  const proto = caps.thinkingParam ?? "reasoning_effort";
  if (proto !== "reasoning_effort") {
    return {
      levels, effective: true,
      note: `该模型家族默认按「${proto}」开启思考（不接收等级）；经聚合网关/中转站按 reasoning_effort 转发时本设置生效。`,
    };
  }
  return { levels, effective: true, note: "仅作用于本群聊的这位成员，不改动该 Agent 的全局推理强度；下次发言生效。" };
}

/** A-1011：推理强度等级 → 展示名（复用 reasoning.ts 的 EFFORT_LABEL；未收录的原样显示） */
export function effortLabel(effort?: string): string {
  const e = (effort ?? "").trim();
  if (!e) { return EFFORT_LABEL[GROUP_DEFAULT_EFFORT] ?? GROUP_DEFAULT_EFFORT; }
  return EFFORT_LABEL[e] ?? e;
}

/** A-1011：合并「props 里的持久化覆盖」与「本地刚写入的覆盖」→ 当前生效覆盖。
 *  `local` 的值可以是 null —— 那是**墓碑**，表示该成员刚被清除覆盖。
 *  墓碑必须能压掉 props 的旧值：会话列表刷新晚于写入，没有墓碑的话
 *  「清除」会在下一次 props 刷新时自己长回来（用户会看到"删不掉"）。 */
export function mergeEffortOverrides(
  fromProps: Record<string, string> | undefined,
  leaderId: string,
  leaderEffort: string | undefined,
  local: Record<string, string | null>,
): Record<string, string> {
  const base: Record<string, string> = { ...(fromProps ?? {}) };
  if (leaderId && leaderEffort) { base[leaderId] = leaderEffort; }
  for (const [k, v] of Object.entries(local)) {
    if (v === null) { delete base[k]; } else { base[k] = v; }
  }
  return base;
}

/** 字符串映射浅比较。props 每次渲染都是新对象，effect 里不做这个守卫就会变成
 *  「setState → 重渲染 → 新对象 → setState」的无限环（本项目踩过的反馈环老坑）。 */
function sameStrMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) { return false; }
  for (const k of ak) { if (a[k] !== b[k]) { return false; } }
  return true;
}

export default function BrainstormPanel({
  sessionId,
  memberIds = [],
  memberModels = {},
  leaderModel,
  memberEfforts = {},
  leaderEffort,
  leaderId = "",
  providerModels,
}: {
  sessionId: string;
  /** A-954：群聊成员 id（含组长=leaderId 外的全体）——建群即预填成员卡，不再等首条广播 */
  memberIds?: string[];
  /** A-954：成员入群模型（memberId → model_choice 串） */
  memberModels?: Record<string, string>;
  /** A-954：组长（会话归属 Agent）入群模型 */
  leaderModel?: string;
  /** A-1011：成员思考推理强度覆盖（memberId → effort；缺省 = 群聊默认 high） */
  memberEfforts?: Record<string, string>;
  /** A-1011：组长思考推理强度覆盖（缺省 = 群聊默认 high） */
  leaderEffort?: string;
  leaderId?: string;
  /** A-954：供应商模型规格（解析成员模型 context_window 作池 cap 用） */
  providerModels?: Array<{ key?: string; models?: Array<{ id: string; context_window?: number }> }>;
}): JSX.Element {
  const [members, setMembers] = React.useState<MemberView[]>([]);
  /** 上：群聊成员索引卡。下：思考碰撞流（A-1013 起改为「状态机 + 持久化」，见 brainstormFlow.ts） */
  const [flow, setFlow] = React.useState<FlowState>(() => emptyFlowState());
  /** A-1013：流的**权威真值**放 ref —— 流式期每帧都来 chunk，用 state 作真值会踩闭包/批处理；
   *  setFlow 只负责把 ref 的当前快照推给渲染。 */
  const flowRef = React.useRef<FlowState>(emptyFlowState());
  /** 当前 flow 属于哪个会话（切会话时据此把上一份存好、并读回新会话的那份） */
  const flowSessionRef = React.useRef<string>("");
  /** 待并入的原始事件（A-968：rAF 合批，避免 50-100Hz 的逐 chunk setState 把渲染层压爆） */
  const flowBatchRef = React.useRef<FlowEvent[]>([]);
  const flowRafRef = React.useRef<number | null>(null);
  /** 落盘防抖句柄 */
  const flowSaveRef = React.useRef<number | null>(null);
  /** 滚动容器 + 是否"跟随底部"（用户上滚看历史时不抢滚动） */
  const flowScrollRef = React.useRef<HTMLDivElement | null>(null);
  const flowStickRef = React.useRef(true);

  /** A-1013：落盘（防抖 800ms）。流式期每帧写 localStorage 只会拖慢渲染；切会话/卸载时会同步补写。 */
  const scheduleFlowSave = React.useCallback((): void => {
    const sid = flowSessionRef.current;
    if (!sid || flowSaveRef.current !== null) { return; }
    flowSaveRef.current = window.setTimeout(() => {
      flowSaveRef.current = null;
      writeFlowState(sid, flowRef.current);
    }, 800);
  }, []);

  /** A-1013：**唯一的入流入口**（thinking 与 idea 共用同一个 reducer）。
   *
   *  为什么必须收敛成一条：原实现 thinking 走 `setFlow(prev => …)`（追加），
   *  而 idea（成员说完）走 `flushFlow` → `setFlow(snap)`（**用本批数据整体覆盖**）。
   *  两条路径语义不一致 → 每个成员一说完，累积的思考行被整批抹掉、只剩刚 push 的那条观点，
   *  正是用户报的「思考碰撞消失得七七八八，只有类似总结的部分」。
   *  收敛后结构上不可能再出现"两种写法"。 */
  const pushFlow = React.useCallback((evs: FlowEvent[]): void => {
    if (evs.length === 0) { return; }
    flowBatchRef.current.push(...evs);
    if (flowRafRef.current !== null) { return; }
    flowRafRef.current = window.requestAnimationFrame(() => {
      flowRafRef.current = null;
      const batch = flowBatchRef.current;
      flowBatchRef.current = [];
      flowRef.current = appendFlowEvents(flowRef.current, batch);
      setFlow(flowRef.current);
      scheduleFlowSave();
    });
  }, [scheduleFlowSave]);

  /** A-1013：切会话 —— **先存旧的，再读新的**。
   *  不做这一步会有两个后果：右栏组件没有 key、切群聊不卸载 → 旧 flow 留在新群聊里（串味）；
   *  而 flow 只活在内存 → 重启后整个栏位空白（用户报的「内容一直都是消失的」）。 */
  React.useEffect(() => {
    const prevSid = flowSessionRef.current;
    if (prevSid && prevSid !== sessionId) {
      // 挂起的 rAF 属于**上一个**会话，必须取消：它会把这批事件算进新会话（串味）
      if (flowRafRef.current !== null) { window.cancelAnimationFrame(flowRafRef.current); flowRafRef.current = null; }
      flowBatchRef.current = [];
      // 切走时**同步**落盘，不依赖防抖定时器（否则"刚聊完就切走"会丢最后几秒）
      writeFlowState(prevSid, flowRef.current);
    }
    if (flowSaveRef.current !== null) { window.clearTimeout(flowSaveRef.current); flowSaveRef.current = null; }
    flowSessionRef.current = sessionId;
    const restored = readFlowState(sessionId) ?? emptyFlowState();
    flowRef.current = restored;
    setFlow(restored);
    flowStickRef.current = true; // 换会话后先贴底（否则沿用上一会话的滚动位置）
  }, [sessionId]);
  /** 卸载（切到普通会话 / 收起右栏）时补写一次 —— 组件随 `sessionType` 分支卸载，最后一段必须落地。
   *  ⚠️ 依赖数组**必须为空**：若将来有人给本组件加 `key={sessionId}`，切会话=卸载+重挂载，
   *  挂在 `[sessionId]` 上的"切走时保存"会变成死代码；卸载清理不受 key 影响，仍然生效。 */
  React.useEffect(() => () => {
    if (flowSaveRef.current !== null) { window.clearTimeout(flowSaveRef.current); flowSaveRef.current = null; }
    const sid = flowSessionRef.current;
    if (sid && flowRef.current.entries.length > 0) { writeFlowState(sid, flowRef.current); }
  }, []);

  /** A-1013：粘底滚动 —— 只在"用户本来就在底部附近"时才自动跟随。
   *  无条件 `scrollTop = scrollHeight` 会让用户一上滚就被拽回底部（看不了历史），
   *  那是同类面板最常见的体验缺陷。 */
  const onFlowScroll = React.useCallback((): void => {
    const el = flowScrollRef.current;
    if (!el) { return; }
    flowStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);
  React.useEffect(() => {
    const el = flowScrollRef.current;
    if (el && flowStickRef.current) { el.scrollTop = el.scrollHeight; }
  }, [flow]);
  const [agentMeta, setAgentMeta] = React.useState<Record<string, { role?: string; provider?: string; model?: string; maxContext?: number }>>({});
  /** A-954：建群即预填成员卡所需的 agent 名字/角色（一次拉取缓存） */
  const [agentNames, setAgentNames] = React.useState<Record<string, string>>({});

  /* ── A-1011 成员思考推理强度（会话级覆盖，只作用于本群聊） ── */
  /** 本地刚写入的覆盖：null = 刚清除的墓碑（压掉 props 的旧值），见 mergeEffortOverrides */
  const localEffortRef = React.useRef<Record<string, string | null>>({});
  /** 当前生效覆盖 memberId → effort（缺省不在此表 = 群聊默认 high） */
  const [effortMap, setEffortMap] = React.useState<Record<string, string>>({});
  /** 展开「思考推理强度」的成员（同时只展开一个，避免右栏被撑高） */
  const [openEffortId, setOpenEffortId] = React.useState<string | null>(null);

  // ⚠️ 切会话必须清掉本地写入缓存：localEffortRef 的语义是「**本会话**刚写入的值」。
  // 右栏切群聊时本组件并不卸载（没有 key），残留的值会让两个群聊里同 id 的成员互相串味
  // （B 群聊显示 A 群聊设的强度）。必须声明在下面的合并 effect **之前** —— effect 按声明顺序
  // 执行，先清缓存再合并，切换会话当帧就正确。
  React.useEffect(() => {
    localEffortRef.current = {};
    setOpenEffortId(null);
  }, [sessionId]);

  React.useEffect(() => {
    const merged = mergeEffortOverrides(memberEfforts, leaderId, leaderEffort, localEffortRef.current);
    // 等价则返回原引用 → React 跳过重渲染（无此守卫即为无限 setState 环）
    setEffortMap((prev) => (sameStrMap(prev, merged) ? prev : merged));
  }, [memberEfforts, leaderEffort, leaderId]);

  /** A-1011：写入某成员的推理强度（effort=null 清除覆盖 → 回落群聊默认 high）。
   *  乐观更新 + 失败回滚：落盘失败绝不留下"看似生效、实则没存"的假状态。 */
  const applyEffort = React.useCallback((memberId: string, effort: string | null): void => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    localEffortRef.current[memberId] = effort;
    setEffortMap(mergeEffortOverrides(memberEfforts, leaderId, leaderEffort, localEffortRef.current));
    if (!api?.sessions?.setMemberEffort) { return; }
    void api.sessions.setMemberEffort(sessionId, memberId, effort)
      .then((res: { ok?: boolean } | null) => {
        if (!res?.ok) { throw new Error("主进程未确认写入"); }
      })
      .catch((e: unknown) => {
        delete localEffortRef.current[memberId];
        setEffortMap(mergeEffortOverrides(memberEfforts, leaderId, leaderEffort, localEffortRef.current));
        console.error("[brainstorm] 设置成员推理强度失败，已回滚:", e);
      });
  }, [sessionId, memberEfforts, leaderEffort, leaderId]);

  /** A-1011：该成员的入群模型串（组长取 leaderModel，其余取 memberModels） */
  const choiceOf = React.useCallback((id: string): string =>
    (id === leaderId ? leaderModel : memberModels?.[id]) ?? "", [leaderId, leaderModel, memberModels]);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    const api = w.slimeAPI;
    // 成员元数据（角色/供应商/模型/max_context）——一次拉取，按 id 缓存
    api?.agents?.list?.().then((list: Array<{ id: string; name?: string; role?: string; model_choice?: string; max_context?: number }>) => {
      const m: Record<string, { role?: string; provider?: string; model?: string; maxContext?: number }> = {};
      const names: Record<string, string> = {};
      for (const a of Array.isArray(list) ? list : []) {
        const pm = parseProviderModel(a.model_choice ?? "");
        m[a.id] = { role: a.role, provider: pm.provider, model: pm.model, maxContext: a.max_context };
        if (a.name) { names[a.id] = a.name; }
      }
      setAgentMeta(m);
      setAgentNames(names);
    }).catch(() => { /* 忽略 */ });
    if (!api?.brainstorm?.onEvent) { return; }
    const off = api.brainstorm.onEvent((ev: BrainstormEvent) => {
      if (ev.sessionId !== sessionId) { return; }
      if (ev.state) {
        setMembers((prev) => {
          const idx = prev.findIndex((x) => x.id === ev.memberId);
          const view: MemberView = {
            id: ev.memberId, name: ev.name, state: ev.state as MemberView["state"],
            role: agentMeta[ev.memberId]?.role, provider: agentMeta[ev.memberId]?.provider, model: agentMeta[ev.memberId]?.model,
            lastIdea: ev.state === "done" ? (ev.content ?? "") : undefined,
            used: ev.used, cap: ev.cap,
          };
          // 保护既有 used/cap：thinking 增量广播可能不携带用量，覆盖为 undefined 会让进度条闪没
          return idx >= 0
            ? prev.map((x, i) => (i === idx ? { ...x, ...view, used: ev.used ?? x.used, cap: ev.cap ?? x.cap } : x))
            : [...prev, view];
        });
      }
      const chunk = ev.chunk;
      if (ev.state === "thinking" && typeof chunk === "string") {
        // A-1013：走**唯一**入流入口（与下面的 idea 共用同一 reducer）。
        // 空/纯空白 chunk 由 reducer 内部兜底丢弃（A-956 同款语义），这里不再自行 trim ——
        // 逐 chunk trim 会吃掉流式边界上的真实空格（中英混排时尤其明显）。
        pushFlow([{ kind: "thinking", name: ev.name, text: chunk }]);
      } else if (ev.state === "done") {
        pushFlow([{ kind: "idea", name: ev.name, text: (ev.content ?? "").slice(0, 160) }]);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /* A-1013：切会话把成员卡一并复位。
   * 本组件没有 key，切群聊不卸载；而下面的预填逻辑刻意是「只追加不删除」（防 broadcast 与
   * props 先后到达时闪卡），两者叠加 → A 群聊的成员卡整批留在 B 群聊里（与 flow 串味同源）。
   * ⚠️ 必须声明在预填 effect **之前**：effect 按声明顺序入队，先清空再重建才正确。
   * ref 初值取当前 sessionId → 首次挂载不触发多余的重渲染。 */
  const membersSessionRef = React.useRef<string>(sessionId);
  React.useEffect(() => {
    if (membersSessionRef.current === sessionId) { return; }
    membersSessionRef.current = sessionId;
    setMembers([]);
    setOpenEffortId(null);
  }, [sessionId]);

  // A-954：建群即预填成员卡（idle 待命，含组长）——不再等首条广播才有成员；
  // 状态后续由 broadcast 事件接管；cap 优先入群模型 context_window，兜底 agent.max_context
  React.useEffect(() => {
    const roster: Array<{ id: string; model?: string }> = [];
    if (leaderId) { roster.push({ id: leaderId, model: leaderModel }); }
    for (const id of memberIds ?? []) {
      if (!id) { continue; }
      roster.push({ id, model: memberModels?.[id] });
    }
    if (roster.length === 0) { return; }
    setMembers((prev) => {
      const byId = new Map(prev.map((m, i) => [m.id, i]));
      const next = [...prev];
      let changed = false;
      for (const r of roster) {
        const meta = agentMeta[r.id] ?? {};
        const pm = r.model ? parseProviderModel(r.model) : undefined;
        const cap = (r.model && providerModels ? modelWindowCap(r.model, providerModels) : undefined) ?? meta.maxContext;
        const idx = byId.get(r.id);
        if (idx !== undefined) {
          /* A-1013：✅ 补齐「异步到达」的元数据。agentNames / agentMeta 是 await 回来的，
           * 首帧恒为空；原实现此处直接 `continue` → 以空值建出的卡永远补不上名字/角色/供应商
           * （成员卡长期无名字，只有等 broadcast 才可能修好）。只填空值、不覆盖已有值：
           * broadcast 带来的真实姓名 / 实时 used-cap 优先级更高。 */
          const cur = next[idx];
          const patch: MemberView = { ...cur };
          let dirty = false;
          const name = agentNames[r.id] ?? "";
          if (!cur.name && name) { patch.name = name; dirty = true; }
          if (!cur.role && meta.role) { patch.role = meta.role; dirty = true; }
          const provider = pm?.provider ?? meta.provider;
          if (!cur.provider && provider) { patch.provider = provider; dirty = true; }
          const model = pm?.model ?? meta.model;
          if (!cur.model && model) { patch.model = model; dirty = true; }
          if (!cur.cap && cap && cap > 0) { patch.cap = cap; dirty = true; }
          if (!dirty) { continue; }
          next[idx] = patch;
          changed = true;
          continue;
        }
        next.push({
          id: r.id,
          name: agentNames[r.id] ?? "",
          state: "idle",
          role: meta.role,
          provider: pm?.provider ?? meta.provider,
          model: pm?.model ?? meta.model,
          used: 0,
          cap: cap && cap > 0 ? cap : undefined,
        });
        byId.set(r.id, next.length - 1);
        changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberIds, memberModels, leaderModel, leaderId, agentNames, agentMeta, providerModels]);

  // A-963 双向桥-后向：silam 成员情感/成长态轮询（6s；仅当群聊含 silam 成员时启用）
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const isSilam = (id: string): boolean =>
      `${memberModels?.[id] ?? ""} ${leaderId === id ? leaderModel ?? "" : ""}`.toLowerCase().includes("silam");
    const targets = [...new Set([...(memberIds ?? []), leaderId].filter(Boolean))].filter(isSilam);
    if (!api?.silam?.getState || targets.length === 0) { return; }
    const timer = window.setInterval(() => {
      for (const id of targets) {
        api.silam.getState(id)
          .then((st: { fear?: number; desire?: number; n_nodes?: number; step?: number } | null) => {
            if (!st || typeof st.n_nodes !== "number") { return; }
            setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, affect: st } : m)));
          })
          .catch(() => undefined);
      }
    }, 6_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberIds, memberModels, leaderId, leaderModel]);

  const stateText: Record<MemberView["state"], string> = { thinking: "思考中", speaking: "发言中", done: "已完成", idle: "待命" };
  const stateColor: Record<MemberView["state"], string> = { thinking: "var(--warning)", speaking: "var(--accent)", done: "var(--success)", idle: "var(--text-dim)" };
  /** A-1011：推理等级胶囊样式（选中 = accent 实心感；未选中 = 细边框）。 */
  const effortChipStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 6, cursor: "pointer",
    lineHeight: 1.5, whiteSpace: "nowrap", flexShrink: 0,
    border: `1px solid ${active ? "var(--accent)" : "var(--border-hover)"}`,
    background: active ? "var(--accent-soft)" : "transparent",
    color: active ? "var(--accent-hover)" : "var(--text-muted)",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* 成员索引卡 */}
      <div style={{ padding: 10, overflowY: "auto", maxHeight: "46%" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>群聊成员（{members.length}）</div>
        {members.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
            暂无群聊成员。<br />从新建会话弹窗选成员、配模型后可在此看到成员卡与上下文进度。
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {members.map((m) => {
              // A-1011：该成员的推理强度可选等级 + 是否真会被上游采纳（纯函数，见 memberEffortCap）
              const cap = memberEffortCap(choiceOf(m.id));
              const curEffort = effortMap[m.id];
              const expanded = openEffortId === m.id;
              return (
              <div key={m.id} style={{
                borderRadius: 8, background: "var(--bg-input)", border: "1px solid var(--border)",
                overflow: "hidden",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 8px" }}>
                <span style={{
                  width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--accent-soft)", color: "var(--accent-hover)",
                  fontSize: 12, fontWeight: 800,
                }}>{m.name.slice(0, 1)}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {m.name}
                    <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-muted)", fontWeight: 400 }}>
                      {m.role && <span style={{ marginRight: 6 }}>{m.role}</span>}
                      {m.provider && (
                        <span style={{
                          padding: "0 5px", borderRadius: 8, fontWeight: 600,
                          background: m.provider === "本地" ? "var(--success-soft)" : "var(--accent-soft)",
                          color: m.provider === "本地" ? "var(--success)" : "var(--accent-hover)",
                        }}>
                          {m.provider}
                        </span>
                      )}
                      {m.model && <span style={{ marginLeft: 6 }}>{m.model}</span>}
                    </span>
                  </span>
                  {m.lastIdea && (
                    <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      观点：{m.lastIdea}
                    </span>
                  )}
                  {/* A-951：每成员独立上下文池进度条（used/cap 由 main 每次状态广播携带） */}
                  {typeof m.used === "number" && typeof m.cap === "number" && m.cap > 0 && (
                    <span style={{ display: "block", marginTop: 4, height: 4, borderRadius: 2, overflow: "hidden", background: "var(--bg-hover)" }}>
                      <span style={{
                        display: "block", height: "100%", borderRadius: 2,
                        width: `${Math.min(100, (m.used / m.cap) * 100)}%`,
                        background: m.used > m.cap * 0.8 ? "var(--warning)" : "var(--accent)",
                        transition: "width 0.3s",
                      }} />
                    </span>
                  )}

                  {/* A-963 双向桥-后向：SILAM 情感/成长态（fear/desire/成长树节点） */}
                  {m.affect && (
                    <span style={{ display: "block", marginTop: 3, fontSize: 10, color: "var(--warning)", fontWeight: 600 }}>
                      情绪 F{((m.affect.fear ?? 0) as number).toFixed(2)} · 渴望 {((m.affect.desire ?? 0) as number).toFixed(2)} · 成长树 ×{m.affect.n_nodes ?? 0}
                    </span>
                  )}
                </span>
                {/* A-1011：思考推理强度可展开按钮——收起点显示当前等级（灰字=群聊默认 high，
                    accent=本群聊已为这位成员单独设置），展开点在同一张卡下方展开等级胶囊 */}
                <button onClick={() => setOpenEffortId(expanded ? null : m.id)}
                  title={curEffort
                    ? `本群聊已单独设为「${effortLabel(curEffort)}」：只作用于这位成员，不改动该 Agent 的全局推理强度；展开可修改或恢复默认`
                    : `群聊默认「${effortLabel()}」：只作用于本群聊；展开可为这位成员单独设置推理强度`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 1, flexShrink: 0, whiteSpace: "nowrap",
                    fontSize: 10.5, fontWeight: 700, padding: "2px 6px", borderRadius: 6, cursor: "pointer",
                    border: `1px solid ${expanded ? "var(--accent)" : "var(--border-hover)"}`,
                    background: expanded ? "var(--accent-soft)" : "transparent",
                    color: curEffort ? "var(--accent-hover)" : "var(--text-muted)",
                  }}>
                  思考·{effortLabel(curEffort)}
                  {/* A-1015：字符箭头 ▲/▼ 换成图标库 ChevronIcon（= chevron-right.svg 原样），
                      旋转由组件自带（走全局 --collapse-dur），与下方内容伸展同一节拍。 */}
                  <ChevronIcon size={10} rotate={expanded ? 90 : 0} style={{ marginLeft: 3, flexShrink: 0 }} />
                </button>
                <span style={{ fontSize: 10.5, color: stateColor[m.state], fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
                  {stateText[m.state]}
                </span>
                </div>

                {/* A-1015：常驻 + 高度插值。此前 `{expanded && …}` —— 展开时这张成员卡**当场变高**
                    （用户："产物展开后，卡片还会伸长，这不能在同一个地方控制"），收起时又瞬间塌陷。
                    wrapper 两层：.collapse(grid 容器) > 纯 div(grid 行，负责 overflow 裁切) → 原内容。 */}
                <div className={`collapse${expanded ? " is-open" : ""}`}>
                  <div>
                    <div style={{ padding: "6px 8px 7px", borderTop: "1px solid var(--border)", background: "var(--bg-secondary)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                        <button onClick={() => applyEffort(m.id, null)}
                          title="清除本群聊的单独设置，回落群聊默认"
                          style={effortChipStyle(!curEffort)}>
                          默认·{effortLabel()}
                        </button>
                        {cap.levels.map((lv) => (
                          <button key={lv} onClick={() => applyEffort(m.id, lv)}
                            title={`设为「${lv}」（只作用于本群聊的这位成员）`}
                            style={effortChipStyle(curEffort === lv)}>
                            {EFFORT_LABEL[lv] ?? lv}
                          </button>
                        ))}
                      </div>
                      <div style={{ marginTop: 5, fontSize: 10, color: "var(--text-dim)", lineHeight: 1.55 }}>
                        {m.id === leaderId ? "组长 · " : ""}{cap.note}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }} />

      {/* 思考碰撞流（A-1013 重排构成）
       *
       * 构成原则（对齐项目「思考必须视觉降级」规范：思考 ≠ 答案，渲染上一眼可辨）：
       *  - **观点（idea）**：成员说完的结论，是栏目的"答案"→ 左侧 success 竖线 +
       *    两行结构（发言人 / 正文），字号与正文同级、用 `--text`（最亮）。
       *  - **思考（thinking）**：过程流，必须退到背景 → 左侧弱竖线 + `--text-secondary` +
       *    字重 400、字号比观点小 0.5px。⚠️ 右栏窄（≈330px），故这里的绝对字号比正文小，
       *    但"思考 < 观点"的**相对关系**必须保持 —— 别为了"颗粒感"把两者调成一样大（A-918++ 的错误方向）。
       *  - **折叠提示**：超出上限时显式写"更早 N 条已折叠"，不静默丢内容（用户最恨这一点）。
       *  - **粘底滚动**：只在用户本来贴着底部时自动跟随，上滚查历史不抢滚动。 */}
      <div ref={flowScrollRef} onScroll={onFlowScroll}
        style={{ flex: 1, overflowY: "auto", padding: 10, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>思考碰撞</span>
          {flow.entries.length > 0 && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400 }}>
              {flow.entries.length} 条
            </span>
          )}
        </div>
        {flow.dropped > 0 && (
          <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 8, paddingBottom: 6, borderBottom: "1px dashed var(--border)" }}>
            更早 {flow.dropped} 条已折叠（避免右栏被无限撑长，下方为最近记录）
          </div>
        )}
        {flow.entries.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
            成员思考过程将实时流式显示在这里：观点如何提出、如何互相反驳、如何收敛统一。
            <br />
            <span style={{ color: "var(--text-dim)" }}>本栏随群聊保存，重启后仍可回看。</span>
          </div>
        ) : (
          flow.entries.map((f) => (
            f.kind === "idea" ? (
              <div key={f.id} style={{ marginBottom: 8, paddingLeft: 8, borderLeft: "2px solid var(--success)" }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--success)", marginBottom: 2 }}>{f.name} · 观点</div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text)" }}>{f.text}</div>
              </div>
            ) : (
              <div key={f.id} style={{ marginBottom: 6, paddingLeft: 8, borderLeft: "2px solid var(--border-hover)" }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)" }}>{f.name}</span>
                <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}> · 想 </span>
                <span style={{ fontSize: 11.5, fontWeight: 400, color: "var(--text-secondary)", lineHeight: 1.6 }}>{f.text}</span>
              </div>
            )
          ))
        )}
      </div>
    </div>
  );
}