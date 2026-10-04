








import React from "react";
import { PlusIcon } from "../components/Icon.js";








import { GROUP_MAX_PARTICIPANTS, isGroupRosterFull } from "../../../../shared/gen/groupRoster.js";


import { fmtTokens } from "./contextMath.js";

export interface DraftProvider {
  key: string;
  label: string;
  kind: "api" | "local" | "silam";
  models: Array<{ id: string; label: string; ctx?: number }>;
}

export interface NewProjectDialogProps {
  open: boolean;
  
  prefillWorkspace: string | null;
  agents: Array<{ id: string; name: string; role?: string }>;
  agentConfig: Record<string, { model_choice?: string }>;
  draftProviders: DraftProvider[];
  silamOk: boolean;
  currentSessionSvg: string;
  teamSvg: string;
  onClose(): void;
  
  onCreated(sessionId: string): Promise<void>;
  
  onManageAgents(): void;
  
  onOpen(): void;
}

type DraftType = "normal" | "brainstorm";

const EMPTY_CFG: Record<string, { model_choice?: string }> = {};

export default function NewProjectDialog(props: NewProjectDialogProps): React.ReactElement | null {
  const { open, prefillWorkspace } = props;

  
  const [workspace, setWorkspace] = React.useState<string | null>(null);
  const [leader, setLeader] = React.useState<string | null>(null);
  const [memberIds, setMemberIds] = React.useState<string[]>([]);
  const [type, setType] = React.useState<DraftType>("normal");
  const [members, setMembers] = React.useState<Array<{ id: string; name: string; model: string }>>([]);
  const [cfgAgent, setCfgAgent] = React.useState<string | null>(null);
  const [cfgProvider, setCfgProvider] = React.useState<string | null>(null);

  const prevOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !prevOpen.current) {
      
      setWorkspace(prefillWorkspace === undefined ? null : prefillWorkspace);
      setLeader(null);
      setMemberIds([]);
      setType("normal");
      setMembers([]);
      setCfgAgent(null);
      setCfgProvider(null);
      props.onOpen();
    }
    prevOpen.current = open;
    
    
  }, [open, prefillWorkspace]);

  const agents = props.agents ?? [];
  const agentConfig = props.agentConfig ?? EMPTY_CFG;
  const draftProviders = props.draftProviders ?? [];

  
  



  const groupFull = isGroupRosterFull(members.length);
  




  const cfgBlocked = groupFull && Boolean(cfgAgent) && !members.some((m) => m.id === cfgAgent);

  const joinDraftMember = React.useCallback((a: { id: string; name: string }, model: string): void => {
    setMembers((prev) => {
      const idx = prev.findIndex((m) => m.id === a.id);
      const entry = { id: a.id, name: a.name, model };
      
      if (idx >= 0) { return prev.map((m, i) => (i === idx ? entry : m)); }
      
      
      if (isGroupRosterFull(prev.length)) { return prev; }
      return [...prev, entry];
    });
  }, []);
  const leaveDraftMember = React.useCallback((id: string): void => {
    setMembers((prev) => prev.filter((m) => m.id !== id));
    if (cfgAgent === id) { setCfgAgent(null); setCfgProvider(null); }
  }, [cfgAgent]);

  
  const resolveSavedModel = React.useCallback((agentId: string): string | null => {
    const choice = agentConfig[agentId]?.model_choice;
    if (!choice) { return null; }
    if (choice === "silam" || choice.startsWith("silam:")) { return props.silamOk ? "silam" : null; }
    if (choice.startsWith("local:")) {
      const id = choice.slice(6);
      const local = draftProviders.find((p) => p.kind === "local")?.models.find((m) => m.id === `local:${id}`);
      return local ? local.id : null;
    }
    if (choice.startsWith("api:")) {
      const rest = choice.slice(4);
      const sep = rest.indexOf(":");
      const key = sep >= 0 ? rest.slice(0, sep) : rest;
      const modelId = sep >= 0 ? rest.slice(sep + 1) : "";
      const prov = draftProviders.find((p) => p.kind === "api" && p.key === key);
      if (!prov || prov.models.length === 0) { return null; }
      if (!modelId) { return `api:${key}:${prov.models[0].id}`; }
      const m = prov.models.find((x) => x.id === modelId);
      return m ? `api:${key}:${modelId}` : null;
    }
    return null;
  }, [agentConfig, draftProviders, props.silamOk]);

  
  async function pickNewFolder(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.conversations?.pickFolder) { return; }
    const res = await api.conversations.pickFolder().catch((e: unknown) => {
      console.error("[app] pick folder failed:", e);
      return null;
    });
    if (res?.ok && res.path) { setWorkspace(res.path); }
  }

  
  async function handleCreate(
    agentId: string,
    memberIdsArg: Array<string | { id: string; model?: string }> = [],
    typeArg: DraftType = "normal",
    leaderModel?: string,
  ): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.create({
      agentId,
      workspace: workspace === null ? null : (workspace || null),
      memberIds: memberIdsArg,
      leaderModel,
      type: typeArg,
    }).catch((e: unknown) => {
      console.error("[app] create session failed:", e);
      return null;
    });
    if (res?.ok && res.session) {
      await props.onCreated(res.session.sessionId);
    }
  }

  const openManage = (): void => props.onManageAgents();

  
  
  if (!open) { return null; }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      
      
      background: "rgba(2, 6, 23, 0.74)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}
      onClick={(e) => { if (e.target === e.currentTarget) { props.onClose(); } }}>
      <div className="modal-card" style={{
        width: 480, maxWidth: "92vw", maxHeight: "76vh",
        display: "flex", flexDirection: "column",
        animation: "fadeIn 0.18s ease",
        
        
        
        
      }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <PlusIcon size={16} style={{ color: "var(--accent)", marginRight: 8, flexShrink: 0 }} />
          <h3 style={{ margin: 0, flex: 1 }}>新建会话</h3>
          <button className="titlebar-btn" onClick={() => props.onClose()}></button>
        </div>
        {}
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6, fontWeight: 700 }}>
          ① 目标工作文件夹（Agent 的读写将限定在此目录内）
        </div>
        {workspace ? (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            border: "1px solid var(--border)", borderRadius: 8,
            background: "var(--bg-input)", padding: "8px 10px", marginBottom: 8,
          }}>
            <span style={{
              flex: 1, fontSize: 12.5, color: "var(--accent-hover)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl",
            }} title={workspace}>{workspace}</span>
            <button className="btn" style={{ fontSize: 12, padding: "3px 10px", whiteSpace: "nowrap" }}
              onClick={() => void pickNewFolder()}>更换</button>
            <button className="btn" style={{ fontSize: 12, padding: "3px 10px", whiteSpace: "nowrap" }}
              onClick={() => setWorkspace("")}>清除</button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button className="btn primary" style={{ flex: 1, fontSize: 12.5 }}
              onClick={() => void pickNewFolder()}>
              📁 选择文件夹…
            </button>
            <button className="btn" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}
              onClick={() => setWorkspace("")}>
              跳过（不绑定文件夹）
            </button>
          </div>
        )}
        {}
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6, fontWeight: 700, marginTop: 10 }}>
          聊天形式
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <button
            onClick={() => setType("normal")}
            style={{
              display: "flex", alignItems: "center", gap: 8, textAlign: "left",
              padding: "9px 11px", borderRadius: 10, cursor: "pointer",
              border: type === "normal" ? "1.5px solid var(--accent)" : "1px solid var(--border)",
              background: type === "normal" ? "var(--accent-soft)" : "var(--bg-input)",
            }}>
            <img src={props.currentSessionSvg} alt="普通对话" style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: type === "normal" ? "var(--accent-hover)" : "var(--text)" }}>普通对话</span>
              <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>一对一；子任务自动委派子代理</span>
            </span>
          </button>
          <button
            onClick={() => setType("brainstorm")}
            style={{
              display: "flex", alignItems: "center", gap: 8, textAlign: "left",
              padding: "9px 11px", borderRadius: 10, cursor: "pointer",
              border: type === "brainstorm" ? "1.5px solid var(--accent)" : "1px solid var(--border)",
              background: type === "brainstorm" ? "var(--accent-soft)" : "var(--bg-input)",
            }}>
            <img src={props.teamSvg} alt="群聊" style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              background: type === "brainstorm" ? "var(--bg-hover)" : "transparent",
            }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: type === "brainstorm" ? "var(--accent-hover)" : "var(--text)" }}>群聊头脑风暴</span>
              <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>全员并行发言、互相纠错</span>
            </span>
          </button>
        </div>
        {}
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6, fontWeight: 700 }}>
          {type === "brainstorm"
            ? `② 群成员三步入群（点成员 → 选供应商 → 选模型即入群，第一个入群者为组长；已入群 ≥2 可创建，最多 ${GROUP_MAX_PARTICIPANTS} 人）`
            : "② 选择对话的 Agent（单击选中；子任务会自动委派子代理）"}
        </div>
        {type === "brainstorm" ? (
          <div style={{ display: "flex", gap: 10 }}>
            {}
            <div style={{ flex: 1, minWidth: 0, maxHeight: 214, overflowY: "auto" }}>
              {agents.map((a) => {
                const joined = members.find((m) => m.id === a.id);
                const cfg = cfgAgent === a.id;
                
                
                const blocked = groupFull && !joined;
                return (
                  <button key={a.id}
                    disabled={blocked}
                    title={blocked
                      ? `已达群聊上限 ${GROUP_MAX_PARTICIPANTS} 人（含组长）。请先让某位成员「退出群聊」后腾出席位。`
                      : undefined}
                    onClick={() => {
                      if (blocked) { return; }
                      if (cfg) { setCfgAgent(null); setCfgProvider(null); return; }
                      const saved = resolveSavedModel(a.id);
                      if (saved) {
                        joinDraftMember(a, saved);
                        const key = saved.startsWith("api:")
                          ? saved.split(":")[1]
                          : saved.startsWith("local:")
                            ? "local"
                            : saved === "silam"
                              ? "silam"
                              : undefined;
                        if (key) { setCfgProvider(key); }
                      }
                      setCfgAgent(a.id);
                      if (!saved) { setCfgProvider(null); }
                    }}
                    style={{
                      display: "block", width: "100%", textAlign: "left",
                      padding: "6px 10px", marginBottom: 4, borderRadius: 8,
                      cursor: blocked ? "not-allowed" : "pointer",
                      opacity: blocked ? 0.45 : 1,
                      border: joined || cfg ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                      background: cfg ? "var(--bg-hover)" : joined ? "var(--accent-soft)" : "var(--bg-input)",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: joined || cfg ? "var(--accent-hover)" : "var(--text)", whiteSpace: "nowrap" }}>{a.name}</span>
                      {joined ? (
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: "var(--success)",
                          background: "var(--success-soft)", borderRadius: 8, padding: "0 6px",
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120,
                          flexShrink: 1,
                        }}>
                          已入群 · {joined.model}
                        </span>
                      ) : blocked ? (
                        <span style={{ fontSize: 10, color: "var(--warning)", whiteSpace: "nowrap" }}>已满员</span>
                      ) : cfg ? (
                        <span style={{ fontSize: 10, color: "var(--warning)", whiteSpace: "nowrap" }}>待选模型</span>
                      ) : null}
                    </div>
                    {a.role && (
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {a.role}
                      </div>
                    )}
                  </button>
                );
              })}
              {agents.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", padding: "20px 14px" }}>
                  暂无可调用的 Agent，请先创建
                </div>
              )}
            </div>
            {}
            <div style={{
              flex: 1, minWidth: 0, maxHeight: 214, overflowY: "auto",
              border: "1px solid var(--border)", borderRadius: 8, padding: 8, background: "var(--bg-input)",
            }}>
              {cfgBlocked ? (
                <div style={{ fontSize: 11.5, color: "var(--warning)", lineHeight: 1.7 }}>
                  已达群聊上限 {GROUP_MAX_PARTICIPANTS} 人（含组长），无法再邀请新成员入群。<br />
                  请先在上方让某位成员「退出群聊」腾出席位，或直接创建群聊。
                </div>
              ) : !cfgAgent ? (
                <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
                  点击左侧成员，为其选择入群模型：<br />① 供应商 → ② 模型（选定即入群）。<br />
                  <span style={{ color: "var(--accent-hover)" }}>已配置过供应商/模型的角色会直接沿用自动入群</span>。
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                    配置「{agents.find((a) => a.id === cfgAgent)?.name ?? ""}」· 供应商
                  </div>
                  {draftProviders.length === 0 ? (
                    <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
                      暂无可用供应商/模型。<br />请到「管理 Agent →」的供应商设置中添加并启用模型。
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                        {draftProviders.map((p) => {
                          const sel = cfgProvider === p.key;
                          const kindStyle = p.kind === "silam" ? { color: "var(--success)", background: "var(--success-soft)" } : p.kind === "local" ? { color: "var(--warning)", background: "var(--bg-hover)" } : { color: "var(--accent-hover)", background: "var(--accent-soft)" };
                          return (
                            <button key={p.key}
                              onClick={() => setCfgProvider(p.key)}
                              style={{
                                fontSize: 11, padding: "3px 9px", borderRadius: 8, cursor: "pointer",
                                border: sel ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                                ...(sel ? { color: "var(--accent-hover)", background: "var(--accent-soft)" } : kindStyle),
                              }}>
                              {p.label}
                            </button>
                          );
                        })}
                      </div>
                      {(() => {
                        const prov = cfgProvider ? draftProviders.find((p) => p.key === cfgProvider) : null;
                        if (!prov) {
                          return <div style={{ fontSize: 11, color: "var(--text-dim)" }}>选择供应商后展示其可选模型</div>;
                        }
                        return (
                          <>
                            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                              模型（点击即入群）
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              {prov.models.map((m) => {
                                const modelVal = prov.kind === "api" ? `api:${prov.key}:${m.id}` : m.id;
                                const joined = members.find((x) => x.id === cfgAgent);
                                const active = joined?.model === modelVal;
                                const target = agents.find((a) => a.id === cfgAgent);
                                return (
                                  <button key={m.id}
                                    onClick={() => target && joinDraftMember(target, modelVal)}
                                    style={{
                                      display: "flex", alignItems: "center", gap: 6, textAlign: "left",
                                      fontSize: 11.5, padding: "5px 9px", borderRadius: 7, cursor: "pointer",
                                      border: active ? "1.5px solid var(--success)" : "1px solid var(--border)",
                                      background: active ? "var(--success-soft)" : "transparent",
                                      color: "var(--text)",
                                    }}>
                                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.label}</span>
                                    {typeof m.ctx === "number" && m.ctx > 0 && (
                                      <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{fmtTokens(m.ctx, m.ctx)} ctx</span>
                                    )}
                                    {active && <span style={{ fontSize: 10.5, color: "var(--success)", marginLeft: "auto" }}>✓ 已选</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </>
                        );
                      })()}
                    </>
                  )}
                  {(() => {
                    const joined = members.find((x) => x.id === cfgAgent);
                    if (!joined) { return null; }
                    return (
                      <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontSize: 11, color: "var(--success)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          已入群：{joined.model}
                        </span>
                        <button className="btn" style={{ fontSize: 11, padding: "2px 10px", whiteSpace: "nowrap", flexShrink: 0 }}
                          onClick={() => leaveDraftMember(joined.id)}>
                          退出群聊
                        </button>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        ) : (
          <div style={{ maxHeight: 168, overflowY: "auto" }}>
            {agents.map((a) => {
              const selected = leader === a.id;
              return (
                <button key={a.id}
                  onClick={() => {
                    setLeader(a.id);
                    setMemberIds((prev) => prev.filter((id) => id !== a.id));
                  }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "7px 12px", marginBottom: 4,
                    borderRadius: 8, cursor: "pointer",
                    border: selected ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                    background: selected ? "var(--accent-soft)" : "var(--bg-input)",
                    boxShadow: selected ? "0 0 0 1px var(--accent-soft)" : "none",
                  }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: selected ? "var(--accent-hover)" : "var(--text)", whiteSpace: "nowrap" }}>{a.name}</span>
                    {selected && (
                      <span style={{
                        fontSize: 10.5, fontWeight: 700,
                        color: "var(--accent-hover)",
                        background: "var(--bg-input)", borderRadius: 8, padding: "0 6px",
                      }}>
                        已选
                      </span>
                    )}
                  </div>
                  {a.role && (
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {a.role}
                    </div>
                  )}
                </button>
              );
            })}
            {agents.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", padding: "20px 14px" }}>
                暂无可调用的 Agent，请先创建
              </div>
            )}
          </div>
        )}
        {}
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <button className="btn" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}
            onClick={openManage}>
            管理 Agent →
          </button>
          {(type === "brainstorm" ? members.length >= 2 : Boolean(leader)) && (
            <button
              className="btn primary"
              disabled={agents.length === 0 || (type === "brainstorm" && members.length < 2)}
              style={{ fontSize: 13, padding: "6px 20px", whiteSpace: "nowrap" }}
              onClick={() => void (type === "brainstorm"
                ? handleCreate(members[0].id, members.slice(1).map((m) => ({ id: m.id, model: m.model })), "brainstorm", members[0].model)
                : handleCreate(leader!, [], "normal"))}
              title={type === "brainstorm"
                ? `创建群聊（${members.length} 人已选模型入群，第一位为组长）`
                : (memberIds.length > 0
                  ? `创建团队会话：组长 ${agents.find((a) => a.id === leader)?.name} + ${memberIds.length} 名成员`
                  : "创建单人会话")}
            >
              {type === "brainstorm"
                ? `创建群聊（${members.length} 人 · 已选模型）`
                : (memberIds.length > 0
                  ? `创建团队（组长 1 · 成员 ${memberIds.length}）`
                  : "创建会话")}
            </button>
          )}
          {type === "normal" && !leader && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
              选择组长后创建（同一文件夹可建多个团队/群聊/会话）
            </span>
          )}
          {type === "brainstorm" && members.length < 2 && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
              {members.length === 0 ? "请先为至少 2 名成员选好模型入群" : "再入群 1 名成员即满 2 人，可创建"}
            </span>
          )}
          {type === "brainstorm" && groupFull && (
            <span style={{ fontSize: 11, color: "var(--warning)", whiteSpace: "nowrap" }}>
              已达群聊上限 {GROUP_MAX_PARTICIPANTS} 人（含组长）
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
