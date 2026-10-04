







import React from "react";

import SubagentAvatar from "../components/SubagentAvatar.js";

import { INHERIT_MODEL, toggleModelInPool } from "./modelPool.js";

import { asReply, tryInvoke } from "./ipcSafe.js";

type ResJob = { id: string; name: string; cron: string; prompt: string; agentId?: string; nextRun?: number; lastRun?: number; lastResult?: string; paused?: boolean; running?: boolean };
type SubRun = {
  id: string;
  name: string;
  status: string;
  
  task?: string;
  
  timeoutMs?: number;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  
  model?: string;
  
  structured?: { status: string; summary: string; artifacts: string[]; confidence: number };
};
type AgentBrief = { id: string; name: string; role?: string };

const fmtTime = (ts?: number): string => (ts ? new Date(ts).toLocaleString() : "—");







const SUBS_STATUS_UI: Record<string, { text: string; bg: string; fg: string }> = {
  pending: { text: "排队", bg: "var(--bg-hover)", fg: "var(--text-muted)" },
  running: { text: "● 执行中", bg: "rgba(34,197,94,.15)", fg: "#22c55e" },
  done: { text: "✓ 完成", bg: "rgba(0,200,120,.15)", fg: "#22c55e" },
  fail: { text: "✗ 失败", bg: "rgba(255,80,80,.15)", fg: "#f87171" },
  timeout: { text: "⏱ 超时中断", bg: "rgba(251,191,36,.15)", fg: "#fbbf24" },
  cancelled: { text: "⃠ 已取消", bg: "var(--bg-hover)", fg: "var(--text-muted)" },
};








const SUBAGENT_PRESETS = [
  { id: "research", label: "深度研究", desc: "多源检索 + 归纳报告", task: "对主题进行多源检索与交叉验证，输出结构化研究报告（含来源、要点、结论）", systemPrompt: "你是资深研究员：先查证再下结论，明确区分事实与推断，引用真实来源。", tag: "带检索" },
  { id: "code-review", label: "代码审查", desc: "只读审查近期改动", task: "审查本次改动：按严重度（严重/警告/建议）分类输出问题，并给出修复示例", systemPrompt: "你是资深代码审查员，只标记正确性与需求符合度缺陷，避免过度工程化建议。", tag: "只读" },
  { id: "daily-report", label: "每日摘要", desc: "汇总生成工作简报", task: "汇总当前工作区相关状态与待办，生成今日简报", systemPrompt: undefined, tag: "快捷" },
  { id: "data-parse", label: "数据处理", desc: "解析/整理数据文件", task: "解析指定数据文件并整理成结构化摘要", systemPrompt: "你是数据分析师：先看清数据，再给结论，不编造数值。", tag: "文件" },
] as const;


const CRON_PRESETS = [
  { label: "每天 09:00", cron: "0 9 * * *" },
  { label: "每小时整点", cron: "0 * * * *" },
  { label: "每 15 分钟", cron: "*/15 * * * *" },
  { label: "每周一 09:00", cron: "0 9 * * 1" },
  { label: "每月 1 日 09:00", cron: "0 9 1 * *" },
] as const;

const card: React.CSSProperties = { background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px" };
const input: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 11px", color: "var(--text)", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box" };
const btn: React.CSSProperties = { background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 14px", color: "var(--accent-hover)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" };
const miniBtn: React.CSSProperties = { ...btn, padding: "3px 9px", fontSize: 12 };






function AgentSelect({ agents, value, onChange, span = 3, onEnsure }: {
  agents: AgentBrief[];
  value: string;
  onChange: (id: string) => void;
  span?: number;
  onEnsure: () => void;
}): React.JSX.Element {
  if (agents.length === 0) {
    return (
      <div style={{ gridColumn: `span ${span}`, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>暂无 Agent</span>
        <button style={{ ...miniBtn, whiteSpace: "nowrap" }} onClick={onEnsure}>自动创建默认</button>
      </div>
    );
  }
  return (
    <select style={{ ...input, gridColumn: `span ${span}` }} value={value}
      onChange={(e) => onChange(e.target.value)} title="执行该任务的 Agent">
      <option value="" disabled>选择执行 Agent…</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>{a.name}</option>
      ))}
    </select>
  );
}

export default function ResidentPanel(): React.JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI ?? {};
  const [jobs, setJobs] = React.useState<ResJob[]>([]);
  const [runs, setRuns] = React.useState<SubRun[]>([]);
  const [agents, setAgents] = React.useState<AgentBrief[]>([]);
  const [notice, setNotice] = React.useState("");

  
  const [jName, setJName] = React.useState("");
  const [jCron, setJCron] = React.useState<string>(CRON_PRESETS[0].cron);
  const [jPrompt, setJPrompt] = React.useState("");
  const [jAgentId, setJAgentId] = React.useState("");

  
  const [saName, setSaName] = React.useState("");
  const [saTask, setSaTask] = React.useState("");
  const [saSystem, setSaSystem] = React.useState("");
  const [saAgentId, setSaAgentId] = React.useState("");
  const [presetId, setPresetId] = React.useState<string | null>(null);

  
  
  const [defaultModels, setDefaultModels] = React.useState<string[]>([]);
  










  const [draftModels, setDraftModels] = React.useState<string[]>([]);
  const [modelModal, setModelModal] = React.useState(false);
  
  const [saveError, setSaveError] = React.useState("");
  const [modelOptions, setModelOptions] = React.useState<Array<{ value: string; label: string }>>([
    { value: "inherit", label: "继承（沿用目标 Agent 模型）" },
  ]);
  

  const modelPoolOptions = React.useMemo(() => modelOptions.filter((o) => o.value !== INHERIT_MODEL), [modelOptions]);
  
  const [selectedAgentIds, setSelectedAgentIds] = React.useState<string[]>([]);
  


  const [maxParallel, setMaxParallel] = React.useState<number | null>(null);

  
  React.useEffect(() => {
    const w = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!w?.providers?.list) { return; }
    void w.providers.list().then((list: Array<{ key?: string; models?: Array<{ id?: string; selected?: boolean }> }>) => {
      const opts: Array<{ value: string; label: string }> = [{ value: "inherit", label: "继承（沿用目标 Agent 模型）" }];
      for (const p of Array.isArray(list) ? list : []) {
        if (!p?.key) { continue; }
        const enabled = Array.isArray(p.models) ? p.models.filter((m) => m?.selected !== false) : [];
        if (enabled.length === 0) {
          opts.push({ value: `api:${p.key}`, label: `${p.key}（默认模型）` });
        }
        for (const m of enabled) {
          if (m?.id) { opts.push({ value: `api:${p.key}:${m.id}`, label: `${p.key} · ${m.id}` }); }
        }
      }
      void w.providers.localList?.().then((locals: Array<{ id?: string; label?: string }>) => {
        for (const lm of Array.isArray(locals) ? locals : []) {
          if (lm?.id) { opts.push({ value: `local:${lm.id}`, label: `本地 · ${lm.label ?? lm.id}` }); }
        }
        setModelOptions(opts);
      }).catch(() => setModelOptions(opts));
    }).catch(() => {  });
  }, []);

  
  
  React.useEffect(() => {
    api.requests?.get?.().then((r: { concurrency?: number }) => {
      if (typeof r?.concurrency === "number" && r.concurrency >= 1) { setMaxParallel(r.concurrency); }
    }).catch(() => {  });
  }, [api]);

  const refresh = React.useCallback(() => {
    api.resident?.state?.().then((s: any) => {
      if (!s) { return; }
      setJobs(Array.isArray(s.scheduler) ? s.scheduler : []);
      setRuns(Array.isArray(s.subagents) ? s.subagents : []);
      
      
      if (Array.isArray(s.defaultModels)) { setDefaultModels(s.defaultModels); }
    }).catch(() => {  });
    api.agents?.list?.().then((list: AgentBrief[]) => {
      if (Array.isArray(list)) {
        setAgents(list);
        if (list.length === 0) { setJAgentId(""); setSaAgentId(""); }
      }
    }).catch(() => {  });
    
    api.resident?.subagentGetSelection?.().then((r: any) => {
      if (r?.ok && Array.isArray(r.selectedAgentIds)) { setSelectedAgentIds(r.selectedAgentIds); }
    }).catch(() => {  });
  }, [api]);

  React.useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>, msg: string): Promise<void> => {
    


    const r: any = asReply(await tryInvoke(fn));
    if (r?.ok ?? r?.id) { setNotice(msg); refresh(); } else { setNotice(`操作失败：${r?.error ?? "未知"}`); }
  };

  const pickPreset = (id: string): void => {
    const p = SUBAGENT_PRESETS.find((x) => x.id === id);
    if (!p) { return; }
    setPresetId(id);
    setSaName(p.label);
    setSaTask(p.task);
    setSaSystem(p.systemPrompt ?? "");
    setNotice(`已载入「${p.label}」预设——以下字段均可自行修改后派发`);
  };

  
  const ensureAgent = async (): Promise<void> => {
    




    const r = await tryInvoke(() => api.agents?.create?.("助手", "通用助理"));
    const a: any = r.ok ? r.value : null;
    if (a?.id) {
      setAgents((prev) => [{ id: a.id, name: a.name ?? "助手", role: a.role }, ...prev]);
      setJAgentId(a.id);
      setSaAgentId(a.id);
      setNotice(`已自动创建默认 Agent「${a.name ?? "助手"}」并选用`);
    } else {
      setNotice("自动创建失败，请到「Agent 管理」页创建后再试");
    }
  };

  const addJob = async (): Promise<void> => {
    if (!jName.trim() || !jCron.trim() || !jPrompt.trim()) { setNotice("名称 / cron / 任务文本 必填"); return; }
    await act(() => api.resident?.schedulerAdd({ name: jName.trim(), cron: jCron.trim(), prompt: jPrompt.trim(), agentId: jAgentId || undefined }), "定时任务已添加");
    setJName(""); setJPrompt("");
  };
  const spawnSub = async (): Promise<void> => {
    if (!saName.trim() || !saTask.trim()) { setNotice("子代理名称 / 任务指令 必填"); return; }
    
    
    await act(() => api.resident?.subagentSpawn({ name: saName.trim(), task: saTask.trim(), systemPrompt: saSystem.trim() || undefined, agentId: saAgentId || undefined, outputSchema: true }), "子代理已派发（后台执行）");
    setSaName(""); setSaTask(""); setSaSystem("");
  };

  




  const clearRuns = async (): Promise<void> => {
    
    const r: any = asReply(await tryInvoke(() => api.resident?.subagentClear?.()));
    if (r?.ok) {
      setNotice(`已清空 ${r.cleared ?? 0} 条历史记录（在途任务保留）`);
      refresh();
    } else {
      setNotice(`清空失败：${r?.error ?? "未知"}`);
    }
  };

  
  React.useEffect(() => {
    if (agents.length > 0 && !jAgentId && !saAgentId) {
      setJAgentId(agents[0].id);
      setSaAgentId(agents[0].id);
    }
  }, [agents, jAgentId, saAgentId]);

  return (
    
    <div className="settings-pane" style={{ display: "flex", flexDirection: "column", gap: 16, padding: "6px 0 16px", maxWidth: 860 }}>
      {notice && <div style={{ fontSize: 12.5, color: "var(--accent-hover)", padding: "8px 12px", background: "var(--bg-input)", borderRadius: 8 }}>{notice}</div>}

      {}
      <section style={card}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
          定时任务
          <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: 12, marginLeft: 8 }}>到点自动唤醒 Agent，结果落盘 data/generated/</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 10, marginTop: 10 }}>
          <input style={{ ...input, gridColumn: "span 3" }} placeholder="任务名称" value={jName} onChange={(e) => setJName(e.target.value)} />
          <div style={{ gridColumn: "span 3", display: "flex", gap: 6 }}>
            <select style={{ ...input, width: "auto", flex: 1 }} value={CRON_PRESETS.some((c) => c.cron === jCron) ? jCron : ""}
              onChange={(e) => { if (e.target.value) { setJCron(e.target.value); } }}>
              <option value="" disabled>选择频率…</option>
              {CRON_PRESETS.map((c) => <option key={c.label} value={c.cron}>{c.label}</option>)}
            </select>
          </div>
          <input style={{ ...input, gridColumn: "span 3", fontFamily: "Consolas, monospace" }} placeholder="或直接填 cron（如 0 9 * * *）" value={jCron} onChange={(e) => setJCron(e.target.value)} />
          <AgentSelect agents={agents} value={jAgentId} onChange={setJAgentId} span={2} onEnsure={() => void ensureAgent()} />
          {}
          <button style={{ ...btn, gridColumn: "span 1", whiteSpace: "nowrap" }} onClick={() => void addJob()}>添加</button>
          <input style={{ ...input, gridColumn: "span 12" }} placeholder="任务文本：到点交给 Agent 做什么（例：生成今日工作简报并汇总待办）" value={jPrompt} onChange={(e) => setJPrompt(e.target.value)} />
        </div>

        {jobs.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: 10, padding: "12px", background: "var(--bg)", borderRadius: 8 }}>暂无定时任务。用上方表单添加，或编辑 data/schedules.json。</div>
        ) : (
          <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 10, overflowX: "auto", background: "var(--bg)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead>
                <tr style={{ background: "var(--bg-hover)", color: "var(--text-muted)", fontSize: 11.5 }}>
                  <th style={{ padding: "6px 10px", textAlign: "left", whiteSpace: "nowrap" }}>名称</th>
                  <th style={{ padding: "6px 10px", textAlign: "left", whiteSpace: "nowrap" }}>频率</th>
                  <th style={{ padding: "6px 10px", textAlign: "left", whiteSpace: "nowrap" }}>下次执行</th>
                  <th style={{ padding: "6px 10px", textAlign: "left" }}>状态 / 上次结果</th>
                  <th style={{ padding: "6px 10px", textAlign: "left", whiteSpace: "nowrap" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td style={{ padding: "7px 10px", fontSize: 12.5, whiteSpace: "nowrap" }}>{j.name}</td>
                    <td style={{ padding: "7px 10px", fontSize: 12, whiteSpace: "nowrap" }}><code>{j.cron}</code></td>
                    <td style={{ padding: "7px 10px", fontSize: 12.5, whiteSpace: "nowrap" }}>{j.paused ? "（已暂停）" : fmtTime(j.nextRun)}</td>
                    <td style={{ padding: "7px 10px", fontSize: 12 }}>
                      <span style={{ color: j.running ? "var(--accent-hover)" : j.paused ? "var(--text-dim)" : "var(--text-muted)" }}>
                        {j.running ? "执行中" : j.paused ? "已暂停" : "待机"}
                      </span>
                      {j.lastResult && <div style={{ color: "var(--text-dim)", fontSize: 11.5, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.lastResult}</div>}
                    </td>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                        <button style={miniBtn} onClick={() => void act(() => api.resident?.schedulerTrigger(j.id), "已触发")}>触发</button>
                        {j.paused
                          ? <button style={miniBtn} onClick={() => void act(() => api.resident?.schedulerResume(j.id), "已恢复")}>恢复</button>
                          : <button style={miniBtn} onClick={() => void act(() => api.resident?.schedulerPause(j.id), "已暂停")}>暂停</button>}
                        <button style={{ ...miniBtn, color: "var(--text-dim)" }} onClick={() => void act(() => api.resident?.schedulerRemove(j.id), "已删除")}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {}
      <section style={card}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>
            子代理
            <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: 12, marginLeft: 8 }}>独立上下文并行执行（{maxParallel !== null ? `最多 ${maxParallel} 个并发` : "并行度见「设置 → 通用 → 请求频率」"}，受上游 RPM 限速保护）· 这里手动派发的产出落盘 data/generated/subagent-*.md；<b>对话里由 Agent 委派的，产出会作为工具结果交回主对话并由主 Agent 验收</b></span>
          </div>
          {



}
          {runs.length > 0 && (
            <button style={{ ...miniBtn, flexShrink: 0, color: "var(--text-dim)" }} onClick={() => void clearRuns()}
              title={`清空子代理历史记录（共 ${runs.length} 条：落盘 data/subagent-runs.json + 已结束的内存记录，不可恢复）；运行中/排队中的任务不受影响。悬浮面板只看最近 5 条，完整历史只在这里`}>
              清空历史
            </button>
          )}
        </div>

        {}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10,
          padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap" }}>子代理执行模型</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1, minWidth: 180 }}>
            {defaultModels.length === 0
              ? "未指定 —— 子代理跟随目标 Agent 的模型"
              : `兜底档 ${defaultModels[0]}${defaultModels.length > 1 ? `　（另 ${defaultModels.length - 1} 档可点名）` : ""}`}
          </span>
          {
}
          <button style={{ ...miniBtn, flexShrink: 0 }}
            onClick={() => { setDraftModels(defaultModels); setModelModal(true); setSaveError(""); }}
            title="多选子代理可用的执行模型档位：第 1 个是默认兜底档，其余档位主 Agent 可按子任务难度点名">
            选择模型（可多选）
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.7 }}>
          所选档位会写进系统提示，主 Agent 可以「按子任务难度为不同子代理点名不同模型」（机械活用便宜档、推理活用强档）；
          不点名则用第 1 档（兜底档）。
          优先级：对话中临时指定（如「用 XX 执行」）&gt; 专家子代理自身定义 &gt; 兜底档 &gt; 继承（沿用目标 Agent 模型）。
          建议用便宜的/免费模型执行机械子任务，贵的模型专司统筹规划与评审。
        </div>

        {}
        {modelModal && (
          <div onClick={() => setModelModal(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 2000,
              display: "flex", alignItems: "center", justifyContent: "center" }}>
            {
}
            <div className="modal-card" onClick={(e) => e.stopPropagation()}
              style={{ width: 560, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>子代理执行模型（可多选）</div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.7 }}>
                勾选多个档位后，主 Agent 可按子任务难度点名换用；<b>第 1 个</b>是默认兜底档（它不点名时用的就是这一档）。
                一个都不勾 = 不指定，子代理跟随目标 Agent 的模型。
              </div>
              <div style={{ overflow: "auto", flex: 1, border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                {modelPoolOptions.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)", padding: 6 }}>
                    没有可选的模型 —— 请先在「供应商」页启用模型，或添加本地模型。
                  </div>
                ) : modelPoolOptions.map((o) => {
                  const idx = draftModels.indexOf(o.value);
                  const checked = idx >= 0;
                  return (
                    <label key={o.value}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6,
                        cursor: "pointer", background: checked ? "var(--bg-hover)" : "transparent" }}>
                      <input type="checkbox" checked={checked} style={{ cursor: "pointer" }}
                        onChange={(e) => setDraftModels((prev) => toggleModelInPool(prev, o.value, e.target.checked))} />
                      <span style={{ fontSize: 12.5, flex: 1 }}>{o.label}</span>
                      {checked && (
                        <span style={{ fontSize: 11, padding: "0 6px", borderRadius: 6, whiteSpace: "nowrap",
                          background: "var(--accent-soft)", color: "var(--accent-hover)" }}>
                          {idx === 0 ? "兜底档" : `第 ${idx + 1} 档`}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
              {saveError && (
                <div style={{ marginTop: 10, padding: "7px 10px", borderRadius: 8, fontSize: 12, lineHeight: 1.6,
                  background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid var(--danger)" }}>
                  {saveError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <button className="btn" style={{ fontSize: 12.5 }} onClick={() => setModelModal(false)}>取消</button>
                <button className="btn primary" style={{ fontSize: 12.5 }}
                  onClick={() => void (async () => {
                    
                    







                    setSaveError("");
                    const r: any = asReply(await tryInvoke(() => api.resident?.subagentSetModels?.(draftModels)));
                    if (r?.ok && Array.isArray(r.defaultModels)) {
                      setDefaultModels(r.defaultModels); 
                      

                      setNotice(r.defaultModels.length === 0 ? "子代理执行模型已清空（跟随目标 Agent）" : "子代理执行模型已保存");
                      setModelModal(false);
                    } else {
                      setSaveError(`保存失败：${r?.error ?? "主进程未返回结果"}`);
                    }
                  })()}>保存</button>
              </div>
            </div>
          </div>
        )}

        {}
        <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 2 }}>可派发的 Agent（快捷开关）</div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8, lineHeight: 1.6 }}>
            勾选的 Agent 会被主 Agent 优先派发；未勾选则回退内置专家（代码审查/调研/数据分析），仍不足才自动创建通用子代理。
            <b>与每个 Agent 设置里的「子代理派发」开关是同一份数据</b>（config/agents.json 的 subagent_dispatch）——在哪边改都即时生效、两边同步。
          </div>
          {agents.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>暂无自建 Agent，可到「Agent 管理」页创建后回来勾选。</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {agents.map((a) => {
                const checked = selectedAgentIds.includes(a.id);
                return (
                  <label key={a.id}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
                      padding: "4px 10px", borderRadius: 16, fontSize: 12,
                      border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                      background: checked ? "var(--accent-soft)" : "var(--bg-hover)",
                      color: checked ? "var(--accent-hover)" : "var(--text-muted)",
                    }}>
                    <input type="checkbox" checked={checked}
                      onChange={() => void (async () => {
                        const next = checked
                          ? selectedAgentIds.filter((id) => id !== a.id)
                          : [...selectedAgentIds, a.id];
                        setSelectedAgentIds(next);
                        
                        const r: any = asReply(await tryInvoke(() => api.resident?.subagentSetSelection?.(next)));
                        setNotice(r?.ok ? "子代理选定已保存" : `保存失败：${r?.error ?? "未知"}`);
                      })()}
                      style={{ cursor: "pointer" }} />
                    <span>{a.name}</span>
                    {a.role ? <span style={{ fontSize: 11, opacity: 0.7 }}>{a.role}</span> : null}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginTop: 10 }}>
          {SUBAGENT_PRESETS.map((p) => (
            <button key={p.id} onClick={() => pickPreset(p.id)}
              style={{
                textAlign: "left", padding: "10px 12px", borderRadius: 10, cursor: "pointer",
                border: presetId === p.id ? "1px solid var(--accent-hover)" : "1px solid var(--border)",
                background: presetId === p.id ? "var(--bg-hover)" : "var(--bg)",
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 12.5, color: "var(--text)" }}>{p.label}</span>
                <span style={{ fontSize: 11, padding: "0 6px", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)" }}>{p.tag}</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 3 }}>{p.desc}</div>
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 10, marginTop: 10 }}>
          <input style={{ ...input, gridColumn: "span 3" }} placeholder="子代理名称" value={saName} onChange={(e) => setSaName(e.target.value)} />
          <input style={{ ...input, gridColumn: "span 6" }} placeholder="任务指令（做什么）" value={saTask} onChange={(e) => setSaTask(e.target.value)} />
          <AgentSelect agents={agents} value={saAgentId} onChange={setSaAgentId} span={2} onEnsure={() => void ensureAgent()} />
          {}
          <button style={{ ...btn, gridColumn: "span 1", whiteSpace: "nowrap" }} onClick={() => void spawnSub()}>派发</button>
          <input style={{ ...input, gridColumn: "span 12" }} placeholder="专用系统提示（可选，专家角色/约束；留空用默认身份）" value={saSystem} onChange={(e) => setSaSystem(e.target.value)} />
        </div>

        {runs.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: 10, padding: "12px", background: "var(--bg)", borderRadius: 8 }}>暂无子代理运行记录。选一个预设（或自己填）直接派发；运行记录会落盘到 data/subagent-runs.json，重启后依然可查。</div>
        ) : (
          <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", maxHeight: 240, overflowY: "auto", background: "var(--bg)" }}>
            {[...runs].reverse().map((r) => {
              const ui = SUBS_STATUS_UI[r.status] ?? { text: r.status, bg: "var(--bg-hover)", fg: "var(--text-muted)" };
              const isRunning = r.status === "running";
              const isOk = r.status === "done";
              const elapsed = r.startedAt && r.finishedAt ? `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s` : null;
              
              const meta = [
                elapsed ? `耗时 ${elapsed}` : null,
                
                
                r.timeoutMs ? `限时 ${(r.timeoutMs / 1000).toFixed(0)}s` : null,
                r.model ? `模型 ${r.model}` : null,
                r.structured ? `置信度 ${r.structured.confidence.toFixed(2)}` : null,
                r.structured?.artifacts?.length ? `产物 ${r.structured.artifacts.length} 项` : null,
              ].filter(Boolean).join(" · ");
              const partial = isOk && r.structured?.status === "partial";
              
              const interruptedPartial = !isOk && !isRunning && (r.result ?? "").trim();
              return (
                <div key={r.id} style={{ padding: "9px 12px", borderBottom: "1px solid var(--border)", background: isRunning ? "rgba(34,197,94,0.04)" : "transparent" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <SubagentAvatar name={r.name} size={26} running={isRunning} />
                    <span style={{ fontWeight: 600, fontSize: 12.5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    {partial && (
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, flexShrink: 0, background: "rgba(251,191,36,.15)", color: "#fbbf24", fontWeight: 700 }} title="子代理自评：只完成了一部分">部分</span>
                    )}
                    <span style={{ fontSize: 11.5, padding: "2px 9px", borderRadius: 8, flexShrink: 0,
                      background: ui.bg, color: ui.fg, fontWeight: isRunning ? 700 : 500 }}>
                      {ui.text}
                    </span>
                    <span style={{ color: "var(--text-dim)", fontSize: 11, flexShrink: 0 }}>{fmtTime(r.startedAt)}</span>
                  </div>
                  {meta && (
                    <div style={{ color: "var(--text-dim)", fontSize: 10.5, marginTop: 3, paddingLeft: 34 }}>{meta}</div>
                  )}
                  {r.task && (
                    <div style={{ color: "var(--text-dim)", fontSize: 10.5, marginTop: 2, paddingLeft: 34, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.task}>
                      任务：{r.task}
                    </div>
                  )}
                  <div style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 3, paddingLeft: 34 }}>
                    {r.status === "fail" || r.status === "timeout" || r.status === "cancelled"
                      ? `${ui.text} ${r.error ?? ""}`
                      : isRunning ? "（运行中…）" : (r.structured?.summary?.slice(0, 300) || r.result?.slice(0, 300) || "—")}
                  </div>
                  {interruptedPartial && (
                    <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 4, paddingLeft: 34, maxHeight: 60, overflow: "hidden" }}>
                      <span style={{ color: "#fbbf24" }}>中断前已产出（{r.result!.trim().length} 字）：</span>
                      {r.result!.trim().slice(0, 200)}
                      {r.result!.trim().length > 200 ? "…" : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}