/**
 * gui/src/renderer/pages/ResidentPanel.tsx — 设置「后台任务」面板（A-913 迭代）。
 * - Agent 选择：下拉「已有 Agent（默认选中首项）」，不再手填 ID；无 Agent 时提供「自动创建默认 Agent」兜底；
 * - 子代理：预设模板卡片（点选即填，可改）；
 * - 定时任务：cron 常用预设下拉（点选即填，可改）；
 * - 布局：卡片分区 + 按钮恒横排 + 内容可滚动（A-911/A-912 保留）。
 * 数据经主进程（core-ts SchedulerService / SubAgentManager），4s 轻轮询刷新。
 */
import React, { type JSX } from "react";

type ResJob = { id: string; name: string; cron: string; prompt: string; agentId?: string; nextRun?: number; lastRun?: number; lastResult?: string; paused?: boolean; running?: boolean };
type SubRun = { id: string; name: string; status: string; result?: string; error?: string; startedAt?: number; finishedAt?: number };
type AgentBrief = { id: string; name: string; role?: string };

const fmtTime = (ts?: number): string => (ts ? new Date(ts).toLocaleString() : "—");

/** A-918++：子代理字母头像（名字 hash → 颜色 + 首字母；用户准备好的 D:\pilot project\gui\icon\icon_1cdszr8as42
 *  系列 SVG 下一轮集成到 SubagentAvatar 形成"有自定义用自定义，无则字母兜底"的分级渲染） */
const AVATAR_COLORS = ["#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6", "#94a3b8", "#fb7185", "#facc15", "#4ade80", "#38bdf8", "#818cf8", "#c084fc", "#e879f9", "#fda4af", "#fcd34d", "#86efac"];
const AVATAR_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T"]; // 21 个，对应 icon_1cdszr8as42 的 A-T 系列
function SubagentAvatar({ name, size = 24, running = false }: { name: string; size?: number; running?: boolean }): JSX.Element {
  const sum = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const color = AVATAR_COLORS[Math.abs(sum) % AVATAR_COLORS.length];
  const initial = AVATAR_LETTERS[Math.abs(sum) % AVATAR_LETTERS.length] || (name[0] ?? "?").toUpperCase();
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <div style={{
        width: size, height: size, borderRadius: Math.max(4, size * 0.22),
        background: color, color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: size * 0.42, fontWeight: 800, lineHeight: 1,
        boxShadow: running ? `0 0 0 2px rgba(34,197,94,0.4), 0 0 10px ${color}80` : "none",
        transition: "box-shadow 0.4s",
      }}>{initial}</div>
      {running && (
        <span style={{
          position: "absolute", right: -2, bottom: -2, width: 10, height: 10, borderRadius: "50%",
          background: "#22c55e", border: "2px solid var(--bg)",
          animation: "liveDot 1.2s ease-in-out infinite", willChange: "opacity, box-shadow, transform" as const,
        }} />
      )}
    </div>
  );
}

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

  // ── A-942：全局子代理默认模型（贵模型统筹、廉价/免费模型执行档位）──
  const [defaultModel, setDefaultModel] = React.useState("");
  const [modelOptions, setModelOptions] = React.useState<Array<{ value: string; label: string }>>([
    { value: "inherit", label: "继承（沿用目标 Agent 模型）" },
  ]);
  // ── A-918+：用户选定的子代理（自建 agent id 列表；派发优先级 = 用户选定 > 内置专家）──
  const [selectedAgentIds, setSelectedAgentIds] = React.useState<string[]>([]);

  // 加载可选的子代理执行模型：全部供应商的启用模型 + 本地模型
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
    }).catch(() => { /* 未配置供应商时仅保留继承 */ });
  }, []);

  const refresh = React.useCallback(() => {
    api.resident?.state?.().then((s: any) => {
      if (!s) { return; }
      setJobs(Array.isArray(s.scheduler) ? s.scheduler : []);
      setRuns(Array.isArray(s.subagents) ? s.subagents : []);
      if (typeof s.defaultModel === "string") { setDefaultModel(s.defaultModel); }
    }).catch(() => { /* 服务未就绪 */ });
    api.agents?.list?.().then((list: AgentBrief[]) => {
      if (Array.isArray(list)) {
        setAgents(list);
        if (list.length === 0) { setJAgentId(""); setSaAgentId(""); }
      }
    }).catch(() => { /* 忽略 */ });
    // A-918+：回显用户选定子代理
    api.resident?.subagentGetSelection?.().then((r: any) => {
      if (r?.ok && Array.isArray(r.selectedAgentIds)) { setSelectedAgentIds(r.selectedAgentIds); }
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

        {/* A-942：全局子代理默认模型档位（贵模型统筹、廉价/免费模型执行） */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10,
          padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap" }}>子代理默认模型</span>
          <select style={{ ...input, width: "auto", flex: 1, minWidth: 220 }} value={defaultModel}
            onChange={(e) => void (async () => {
              const r: any = await api.resident?.subagentSetDefaultModel?.(e.target.value);
              if (r?.ok && typeof r.defaultModel === "string") {
                setDefaultModel(r.defaultModel);
                setNotice(`子代理默认模型已设为 ${r.defaultModel || "继承"}`);
              } else {
                setNotice(`设置失败：${r?.error ?? "未知"}`);
              }
            })()}
            title="主 Agent 负责统筹规划（沿用其自身模型）；此处指定子代理执行模型。对话中也可直接说「用 XX 执行子任务」临时覆盖">
            {modelOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.7 }}>
          优先级：对话中临时指定（如「用 XX 执行」）&gt; 专家子代理自身定义 &gt; 此处全局默认 &gt; 继承（沿用目标 Agent 模型）。
          建议用便宜的/免费模型执行机械子任务，贵的模型专司统筹规划与评审。
        </div>

        {/* A-918+：用户选定子代理——勾选自建 agent 作为子代理；任务自动派发时优先于内置专家，不足才自动创建补充 */}
        <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 2 }}>用户选定子代理（优先派发）</div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8, lineHeight: 1.6 }}>
            勾选的自建 Agent 将在任务自动派发时优先被选用；未勾选或无匹配时回退内置专家（代码审查/调研/数据分析），仍不足才自动创建通用子代理。
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
                        const r: any = await api.resident?.subagentSetSelection?.(next);
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
            {[...runs].reverse().map((r) => {
              const isRunning = r.status === "running";
              const isDone = r.status === "done";
              const isFail = r.status === "fail";
              return (
                <div key={r.id} style={{ padding: "9px 12px", borderBottom: "1px solid var(--border)", background: isRunning ? "rgba(34,197,94,0.04)" : "transparent" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <SubagentAvatar name={r.name} size={26} running={isRunning} />
                    <span style={{ fontWeight: 600, fontSize: 12.5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    <span style={{ fontSize: 11.5, padding: "2px 9px", borderRadius: 8, flexShrink: 0,
                      background: isDone ? "rgba(0,200,120,.15)" : isFail ? "rgba(255,80,80,.15)" : isRunning ? "rgba(34,197,94,.15)" : "var(--bg-hover)",
                      color: isDone ? "#22c55e" : isFail ? "#f87171" : isRunning ? "#22c55e" : "var(--text-muted)",
                      fontWeight: isRunning ? 700 : 500 }}>
                      {isDone ? "✓ 完成" : isFail ? "✗ 失败" : isRunning ? "● 执行中" : "排队"}
                    </span>
                    <span style={{ color: "var(--text-dim)", fontSize: 11, flexShrink: 0 }}>{fmtTime(r.startedAt)}</span>
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 3, paddingLeft: 34 }}>
                    {isFail ? `✗ ${r.error ?? ""}` : isRunning ? "（运行中…）" : (r.result?.slice(0, 300) || "—")}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}