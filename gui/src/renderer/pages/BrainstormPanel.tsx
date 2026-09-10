/**
 * gui/src/renderer/pages/BrainstormPanel.tsx — 群聊专属右侧栏（A-950/A-951）。
 * - 上方：群聊全部成员索引卡（头像/名字/角色/供应商/模型/状态/上下文进度条），紧凑排版不拥挤
 * - 分隔线
 * - 下方：思考碰撞流——实时滚动显示各成员思考过程（state=thinking 事件），
 *   完成后显示「观点」摘要；成员间观点在此"碰撞"
 * 数据源：slime:brainstorm:event（main 在每次成员状态变化时广播）+ agents.list（成员元数据）。
 */
import React, { type JSX } from "react";

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

export default function BrainstormPanel({
  sessionId,
  memberIds = [],
  memberModels = {},
  leaderModel,
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
  leaderId?: string;
  /** A-954：供应商模型规格（解析成员模型 context_window 作池 cap 用） */
  providerModels?: Array<{ key?: string; models?: Array<{ id: string; context_window?: number }> }>;
}): JSX.Element {
  const [members, setMembers] = React.useState<MemberView[]>([]);
  const [flow, setFlow] = React.useState<Array<{ id: number; name: string; text: string; kind: "thinking" | "idea" }>>([]);
  const [agentMeta, setAgentMeta] = React.useState<Record<string, { role?: string; provider?: string; model?: string; maxContext?: number }>>({});
  /** A-968：thinking/idea 事件高频节流——每 100ms 最多 flush 一次，避免 50-100Hz 的逐 chunk setState 把 renderer 压爆 */
  const flowBatchRef = React.useRef<Array<{ id: number; name: string; text: string; kind: "thinking" | "idea" }>>([]);
  const flowRafRef = React.useRef<number | null>(null);
  const flushFlow = React.useCallback((next: Array<{ id: number; name: string; text: string; kind: "thinking" | "idea" }>): void => {
    flowBatchRef.current.push(...next);
    if (flowBatchRef.current.length > 240) { flowBatchRef.current = flowBatchRef.current.slice(-120); }
    if (flowRafRef.current !== null) { return; }
    flowRafRef.current = window.requestAnimationFrame(() => {
      flowRafRef.current = null;
      const snap = flowBatchRef.current.slice(-120);
      flowBatchRef.current = [];
      setFlow(snap);
    });
  }, []);
  /** A-954：建群即预填成员卡所需的 agent 名字/角色（一次拉取缓存） */
  const [agentNames, setAgentNames] = React.useState<Record<string, string>>({});

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
        const t = chunk.trim();
        if (!t) { return; } // A-956：空/纯空白 chunk 不进流，杜绝「想」空行噪音
        // A-956：同一成员连续思考 chunk 追加到当前行（流式滚动的句子自然成行），单行 ≤600 字封顶后另起新行
        setFlow((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "thinking" && last.name === ev.name && last.text.length < 600) {
            return prev.map((x, i) => (i === prev.length - 1 ? { ...x, text: (x.text + chunk).slice(0, 600) } : x));
          }
          return [...prev.slice(-120), { id: Date.now() + Math.random(), name: ev.name, text: t.slice(0, 200), kind: "thinking" }];
        });
      } else if (ev.state === "done") {
        flushFlow([{ id: Date.now() + Math.random(), name: ev.name, text: (ev.content ?? "").slice(0, 160), kind: "idea" }]);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const byId = new Map(prev.map((m) => [m.id, m]));
      const next = [...prev];
      let changed = false;
      for (const r of roster) {
        if (byId.has(r.id)) { continue; }
        const meta = agentMeta[r.id] ?? {};
        const pm = r.model ? parseProviderModel(r.model) : undefined;
        const cap = (r.model && providerModels ? modelWindowCap(r.model, providerModels) : undefined) ?? meta.maxContext;
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
        byId.set(r.id, { id: r.id } as MemberView);
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
            {members.map((m) => (
              <div key={m.id} style={{
                display: "flex", alignItems: "center", gap: 7, padding: "6px 8px",
                borderRadius: 8, background: "var(--bg-input)", border: "1px solid var(--border)",
              }}>
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
                <span style={{ fontSize: 10.5, color: stateColor[m.state], fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
                  {stateText[m.state]}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }} />

      {/* 思考碰撞流 */}
      <div style={{ flex: 1, overflowY: "auto", padding: 10, minHeight: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>思考碰撞</div>
        {flow.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
            成员思考过程将实时流式显示在这里：观点如何提出、如何互相反驳、如何收敛统一。
          </div>
        ) : (
          flow.map((f) => (
            <div key={f.id} style={{ fontSize: 11, lineHeight: 1.55, marginBottom: 6, color: f.kind === "idea" ? "var(--text)" : "var(--text-muted)" }}>
              <span style={{ fontWeight: 700, color: f.kind === "idea" ? "var(--success)" : "var(--warning)" }}>{f.name}</span>
              <span style={{ color: "var(--text-dim)" }}>{f.kind === "idea" ? " · " : " · 想 "}</span>
              {f.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}