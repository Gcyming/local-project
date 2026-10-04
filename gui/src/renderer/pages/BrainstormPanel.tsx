







import React, { type JSX } from "react";
import { EFFORT_LABEL } from "../reasoning.js";
import { ChevronIcon } from "../components/Icon.js";
import { inferModelCapabilities } from "../../../../shared/gen/model-capabilities.js";







import { appendFlowEvents, emptyFlowState, readFlowState, writeFlowState, type FlowEvent, type FlowState } from "./brainstormFlow.js";

interface MemberView {
  id: string;
  name: string;
  state: "thinking" | "speaking" | "done" | "idle";
  role?: string;
  
  provider?: string;
  model?: string;
  lastIdea?: string;
  used?: number;
  cap?: number;
  
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
  
  affect?: { fear?: number; desire?: number; n_nodes?: number; step?: number };
}


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







export const GROUP_DEFAULT_EFFORT = "high";







export function memberEffortCap(choice: string): { levels: string[]; effective: boolean; note: string } {
  const c = (choice ?? "").trim();
  
  
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


export function effortLabel(effort?: string): string {
  const e = (effort ?? "").trim();
  if (!e) { return EFFORT_LABEL[GROUP_DEFAULT_EFFORT] ?? GROUP_DEFAULT_EFFORT; }
  return EFFORT_LABEL[e] ?? e;
}





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
  
  memberIds?: string[];
  
  memberModels?: Record<string, string>;
  
  leaderModel?: string;
  
  memberEfforts?: Record<string, string>;
  
  leaderEffort?: string;
  leaderId?: string;
  
  providerModels?: Array<{ key?: string; models?: Array<{ id: string; context_window?: number }> }>;
}): JSX.Element {
  const [members, setMembers] = React.useState<MemberView[]>([]);
  
  const [flow, setFlow] = React.useState<FlowState>(() => emptyFlowState());
  

  const flowRef = React.useRef<FlowState>(emptyFlowState());
  
  const flowSessionRef = React.useRef<string>("");
  
  const flowBatchRef = React.useRef<FlowEvent[]>([]);
  const flowRafRef = React.useRef<number | null>(null);
  
  const flowSaveRef = React.useRef<number | null>(null);
  
  const flowScrollRef = React.useRef<HTMLDivElement | null>(null);
  const flowStickRef = React.useRef(true);

  
  const scheduleFlowSave = React.useCallback((): void => {
    const sid = flowSessionRef.current;
    if (!sid || flowSaveRef.current !== null) { return; }
    flowSaveRef.current = window.setTimeout(() => {
      flowSaveRef.current = null;
      writeFlowState(sid, flowRef.current);
    }, 800);
  }, []);

  






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

  


  React.useEffect(() => {
    const prevSid = flowSessionRef.current;
    if (prevSid && prevSid !== sessionId) {
      
      if (flowRafRef.current !== null) { window.cancelAnimationFrame(flowRafRef.current); flowRafRef.current = null; }
      flowBatchRef.current = [];
      
      writeFlowState(prevSid, flowRef.current);
    }
    if (flowSaveRef.current !== null) { window.clearTimeout(flowSaveRef.current); flowSaveRef.current = null; }
    flowSessionRef.current = sessionId;
    const restored = readFlowState(sessionId) ?? emptyFlowState();
    flowRef.current = restored;
    setFlow(restored);
    flowStickRef.current = true; 
  }, [sessionId]);
  


  React.useEffect(() => () => {
    if (flowSaveRef.current !== null) { window.clearTimeout(flowSaveRef.current); flowSaveRef.current = null; }
    const sid = flowSessionRef.current;
    if (sid && flowRef.current.entries.length > 0) { writeFlowState(sid, flowRef.current); }
  }, []);

  


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
  
  const [agentNames, setAgentNames] = React.useState<Record<string, string>>({});

  
  
  const localEffortRef = React.useRef<Record<string, string | null>>({});
  
  const [effortMap, setEffortMap] = React.useState<Record<string, string>>({});
  
  const [openEffortId, setOpenEffortId] = React.useState<string | null>(null);

  
  
  
  
  React.useEffect(() => {
    localEffortRef.current = {};
    setOpenEffortId(null);
  }, [sessionId]);

  React.useEffect(() => {
    const merged = mergeEffortOverrides(memberEfforts, leaderId, leaderEffort, localEffortRef.current);
    
    setEffortMap((prev) => (sameStrMap(prev, merged) ? prev : merged));
  }, [memberEfforts, leaderEffort, leaderId]);

  

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

  
  const choiceOf = React.useCallback((id: string): string =>
    (id === leaderId ? leaderModel : memberModels?.[id]) ?? "", [leaderId, leaderModel, memberModels]);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    const api = w.slimeAPI;
    
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
    }).catch(() => {  });
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
          
          return idx >= 0
            ? prev.map((x, i) => (i === idx ? { ...x, ...view, used: ev.used ?? x.used, cap: ev.cap ?? x.cap } : x))
            : [...prev, view];
        });
      }
      const chunk = ev.chunk;
      if (ev.state === "thinking" && typeof chunk === "string") {
        
        
        
        pushFlow([{ kind: "thinking", name: ev.name, text: chunk }]);
      } else if (ev.state === "done") {
        pushFlow([{ kind: "idea", name: ev.name, text: (ev.content ?? "").slice(0, 160) }]);
      }
    });
    return off;
    
  }, [sessionId]);

  




  const membersSessionRef = React.useRef<string>(sessionId);
  React.useEffect(() => {
    if (membersSessionRef.current === sessionId) { return; }
    membersSessionRef.current = sessionId;
    setMembers([]);
    setOpenEffortId(null);
  }, [sessionId]);

  
  
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
    
  }, [memberIds, memberModels, leaderModel, leaderId, agentNames, agentMeta, providerModels]);

  
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
    
  }, [memberIds, memberModels, leaderId, leaderModel]);

  const stateText: Record<MemberView["state"], string> = { thinking: "思考中", speaking: "发言中", done: "已完成", idle: "待命" };
  const stateColor: Record<MemberView["state"], string> = { thinking: "var(--warning)", speaking: "var(--accent)", done: "var(--success)", idle: "var(--text-dim)" };
  
  const effortChipStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 6, cursor: "pointer",
    lineHeight: 1.5, whiteSpace: "nowrap", flexShrink: 0,
    border: `1px solid ${active ? "var(--accent)" : "var(--border-hover)"}`,
    background: active ? "var(--accent-soft)" : "transparent",
    color: active ? "var(--accent-hover)" : "var(--text-muted)",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {}
      <div style={{ padding: 10, overflowY: "auto", maxHeight: "46%" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>群聊成员（{members.length}）</div>
        {members.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
            暂无群聊成员。<br />从新建会话弹窗选成员、配模型后可在此看到成员卡与上下文进度。
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {members.map((m) => {
              
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
                  {}
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

                  {}
                  {m.affect && (
                    <span style={{ display: "block", marginTop: 3, fontSize: 10, color: "var(--warning)", fontWeight: 600 }}>
                      情绪 F{((m.affect.fear ?? 0) as number).toFixed(2)} · 渴望 {((m.affect.desire ?? 0) as number).toFixed(2)} · 成长树 ×{m.affect.n_nodes ?? 0}
                    </span>
                  )}
                </span>
                {
}
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
                  {
}
                  <ChevronIcon size={10} rotate={expanded ? 90 : 0} style={{ marginLeft: 3, flexShrink: 0 }} />
                </button>
                <span style={{ fontSize: 10.5, color: stateColor[m.state], fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
                  {stateText[m.state]}
                </span>
                </div>

                {

}
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

      {








}
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