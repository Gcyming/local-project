/**
 * gui/src/renderer/pages/ResidentPanel.tsx — 设置「后台任务」面板（A-913 迭代）。
 * - Agent 选择：下拉「已有 Agent（默认选中首项）」，不再手填 ID；无 Agent 时提供「自动创建默认 Agent」兜底；
 * - 子代理：预设模板卡片（点选即填，可改）；
 * - 定时任务：cron 常用预设下拉（点选即填，可改）；
 * - 布局：卡片分区 + 按钮恒横排 + 内容可滚动（A-911/A-912 保留）。
 * 数据经主进程（core-ts SchedulerService / SubAgentManager），4s 轻轮询刷新。
 */
import React from "react";

type ResJob = { id: string; name: string; cron: string; prompt: string; agentId?: string; nextRun?: number; lastRun?: number; lastResult?: string; paused?: boolean; running?: boolean };
type SubRun = { id: string; name: string; status: string; result?: string; error?: string; startedAt?: number; finishedAt?: number };
type AgentBrief = { id: string; name: string; role?: string };

const fmtTime = (ts?: number): string => (ts ? new Date(ts).toLocaleString() : "—");

/** 子代理预设模板（点选填充表单，仍可修改） */
const SUBAGENT_PRESETS = [
  { id: "research", label: "深度研究", desc: "多源检索 + 归纳报告", task: "对主题进行多源检索与交叉验证，输出结构化研究报告（含来源、要点、结论）", systemPrompt: "你是资深研究员：先查证再下结论，明确区分事实与推断，引用真实来源。", tag: "带检索" },
  { id: "code-review", label: "代码审查", desc: "只读审查近期改动", task: "审查本次改动：按严重度（严重/警告/建议）分类输出问题，并给出修复示例", systemPrompt: "你是资深代码审查员，只标记正确性与需求符合度缺陷，避免过度工程化建议。", tag: "只读" },
  { id: "daily-report", label: "每日摘要", desc: "汇总生成工作简报", task: "汇总当前工作区相关状态与待办，生成今日简报", systemPrompt: undefined, tag: "快捷" },
  { id: "data-parse", label: "数据处理", desc: "解析/整理数据文件", task: "解析指定数据文件并整理成结构化摘要", systemPrompt: "你是数据分析师：先看清数据，再给结论，不编造数值。", tag: "文件" },
] as const;

/** cron 常用预设（点选即填，可继续手改） */
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

/**
 * Agent 选择下拉（**模块级**组件——A-915：此前定义在面板函数体内，每次渲染生成新组件类型，
 * 导致 select 被卸载重挂载，打开的下拉总被收起；提升到模块级后稳定）。
 * 只显示 Agent 名称（去掉 id 前缀，观感更干净）。
 */
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

  // ── 定时任务表单 ──
  const [jName, setJName] = React.useState("");
  const [jCron, setJCron] = React.useState<string>(CRON_PRESETS[0].cron);
  const [jPrompt, setJPrompt] = React.useState("");
  const [jAgentId, setJAgentId] = React.useState("");

  // ── 子代理表单（预设点选填充，仍可改）──
  const [saName, setSaName] = React.useState("");
  const [saTask, setSaTask] = React.useState("");
  const [saSystem, setSaSystem] = React.useState("");
  const [saAgentId, setSaAgentId] = React.useState("");
  const [presetId, setPresetId] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    api.resident?.state?.().then((s: any) => {
      if (!s) { return; }
      setJobs(Array.isArray(s.scheduler) ? s.scheduler : []);
      setRuns(Array.isArray(s.subagents) ? s.subagents : []);
    }).catch(() => { /* 服务未就绪 */ });
    api.agents?.list?.().then((list: AgentBrief[]) => {
      if (Array.isArray(list)) {
        setAgents(list);
        if (list.length === 0) { setJAgentId(""); setSaAgentId(""); }
      }
    }).catch(() => { /* 忽略 */ });
  }, [api]);

  React.useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>, msg: string): Promise<void> => {
    const r: any = await fn();
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

  /** 自动创建默认 Agent 兜底（用户无需预先建 Agent） */
  const ensureAgent = async (): Promise<void> => {
    const a: any = await api.agents?.create?.("助手", "通用助理").catch(() => null);
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
    await act(() => api.resident?.subagentSpawn({ name: saName.trim(), task: saTask.trim(), systemPrompt: saSystem.trim() || undefined, agentId: saAgentId || undefined }), "子代理已派发（后台执行）");
    setSaName(""); setSaTask(""); setSaSystem("");
  };

  // 首次加载后默认选中第一个 Agent
  React.useEffect(() => {
    if (agents.length > 0 && !jAgentId && !saAgentId) {
      setJAgentId(agents[0].id);
      setSaAgentId(agents[0].id);
    }
  }, [agents, jAgentId, saAgentId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "6px 4px 16px", maxWidth: 860 }}>
      {notice && <div style={{ fontSize: 12.5, color: "var(--accent-hover)", padding: "8px 12px", background: "var(--bg-input)", borderRadius: 8 }}>{notice}</div>}

      {/* ── 定时任务 ── */}
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
          {/* A-914：按钮收进首行行尾，避免 12 列已满被 grid 落到次行形成孤立竖排 */}
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

      {/* ── 子代理 ── */}
      <section style={card}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
          子代理
          <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: 12, marginLeft: 8 }}>独立上下文并行执行（最多 3 个并发），结果落盘 data/generated/subagent-*.md</span>
        </div>

        {/* 预设模板：点选即填，仍可自定义调整 */}
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
          {/* A-914：派发按钮收进首行行尾，避免落到次行孤立竖排 */}
          <button style={{ ...btn, gridColumn: "span 1", whiteSpace: "nowrap" }} onClick={() => void spawnSub()}>派发</button>
          <input style={{ ...input, gridColumn: "span 12" }} placeholder="专用系统提示（可选，专家角色/约束；留空用默认身份）" value={saSystem} onChange={(e) => setSaSystem(e.target.value)} />
        </div>

        {runs.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: 10, padding: "12px", background: "var(--bg)", borderRadius: 8 }}>暂无子代理运行记录。选一个预设（或自己填）直接派发。</div>
        ) : (
          <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", maxHeight: 240, overflowY: "auto", background: "var(--bg)" }}>
            {[...runs].reverse().map((r) => (
              <div key={r.id} style={{ padding: "9px 12px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>{r.name}</span>
                  <span style={{ fontSize: 11.5, padding: "1px 8px", borderRadius: 8,
                    background: r.status === "done" ? "rgba(0,200,120,.15)" : r.status === "fail" ? "rgba(255,80,80,.15)" : "var(--bg-hover)",
                    color: r.status === "done" ? "#22c55e" : r.status === "fail" ? "#f87171" : "var(--text-muted)" }}>
                    {r.status === "done" ? "完成" : r.status === "fail" ? "失败" : r.status === "running" ? "执行中" : "排队"}
                  </span>
                  <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{fmtTime(r.startedAt)}</span>
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 3 }}>
                  {r.status === "fail" ? `✗ ${r.error ?? ""}` : r.result?.slice(0, 300)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}