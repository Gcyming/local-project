

















import React, { type JSX } from "react";

interface SkillRow {
  name: string;
  description: string;
  hasSkillMd: boolean;
  hasManifest: boolean;
  enabled: boolean;
  
  origin?: string;
}

interface McpRow {
  name: string;
  kind: "stdio" | "http";
  command?: string;
  url?: string;
  enabled: boolean;
}

const ORIGIN_META: Record<string, { label: string; hint: string }> = {
  agent: { label: "Agent 自建", hint: "由 Agent 在创造模式下自行创建（依据 frontmatter 的 origin 声明）" },
  market: { label: "官方市场", hint: "从官方技能仓库安装" },
  user: { label: "用户自备", hint: "用户自行放入" },
};

function originOf(s: SkillRow): { label: string; hint: string; key: string } {
  const key = (s.origin ?? "").trim().toLowerCase();
  const meta = ORIGIN_META[key];
  if (meta) { return { ...meta, key }; }
  return { label: "未声明", hint: "该技能的 SKILL.md frontmatter 未声明 origin", key: "" };
}

function Badge(props: { text: string; title?: string; tone?: "accent" | "dim" }): JSX.Element {
  const accent = props.tone !== "dim";
  return (
    <span title={props.title}
      style={{
        fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 999,
        whiteSpace: "nowrap", flexShrink: 0,
        border: `1px solid ${accent ? "var(--accent)" : "var(--border-hover)"}`,
        background: accent ? "var(--accent-soft)" : "transparent",
        color: accent ? "var(--accent-hover)" : "var(--text-dim)",
      }}>
      {props.text}
    </span>
  );
}

export default function PluginsPanel(): JSX.Element {
  const api = React.useRef<any>(null);
  const [skills, setSkills] = React.useState<SkillRow[]>([]);
  const [mcp, setMcp] = React.useState<McpRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = React.useState("");
  const [originFilter, setOriginFilter] = React.useState<string>("all");

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 4000);
  };

  const refresh = React.useCallback(async (): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.skillList) { setLoading(false); return; }
    try {
      const [sk, mc] = await Promise.all([
        a.extras.skillList() as Promise<SkillRow[]>,
        a.extras.mcpList ? (a.extras.mcpList() as Promise<McpRow[]>) : Promise.resolve([] as McpRow[]),
      ]);
      setSkills(Array.isArray(sk) ? sk : []);
      setMcp(Array.isArray(mc) ? mc : []);
    } catch (e) {
      showNotice(false, `读取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    api.current = (window as any).slimeAPI ?? null;
    void refresh();
  }, [refresh]);

  
  const stats = React.useMemo(() => {
    const byOrigin: Record<string, number> = { agent: 0, market: 0, user: 0, "": 0 };
    for (const s of skills) { byOrigin[originOf(s).key] = (byOrigin[originOf(s).key] ?? 0) + 1; }
    return {
      total: skills.length,
      enabled: skills.filter((s) => s.enabled).length,
      mcpTotal: mcp.length,
      mcpEnabled: mcp.filter((m) => m.enabled).length,
      byOrigin,
    };
  }, [skills, mcp]);

  
  const q = query.trim().toLowerCase();
  const shown = React.useMemo(() => {
    return skills.filter((s) => {
      if (originFilter !== "all" && originOf(s).key !== originFilter) { return false; }
      if (!q) { return true; }
      return s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q);
    });
  }, [skills, q, originFilter]);

  
  async function toggleSkill(s: SkillRow): Promise<void> {
    if (!api.current?.extras?.skillToggle) { return; }
    setBusy(`skill:${s.name}`);
    try {
      const res = await api.current.extras.skillToggle(s.name, !s.enabled);
      if (res?.ok) { setSkills((prev) => prev.map((x) => x.name === s.name ? { ...x, enabled: !s.enabled } : x)); }
      else { showNotice(false, res?.error ?? "操作失败"); }
    } catch (e) {
      showNotice(false, `操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(null); }
  }

  async function openSkill(s: SkillRow): Promise<void> {
    const res = await api.current?.extras?.skillOpen?.(s.name).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (res && !res.ok) { showNotice(false, res.error ?? "打开失败"); }
  }

  async function removeSkill(s: SkillRow): Promise<void> {
    if (!api.current?.extras?.skillDelete) { return; }
    if (!window.confirm(`删除技能「${s.name}」？该目录会被移除，此操作不可撤销。`)) { return; }
    setBusy(`skill:${s.name}`);
    try {
      const res = await api.current.extras.skillDelete(s.name);
      if (res?.ok) { setSkills((prev) => prev.filter((x) => x.name !== s.name)); showNotice(true, `已删除「${s.name}」`); }
      else { showNotice(false, res?.error ?? "删除失败"); }
    } catch (e) {
      showNotice(false, `删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(null); }
  }

  async function toggleMcp(m: McpRow): Promise<void> {
    if (!api.current?.extras?.mcpToggle) { return; }
    setBusy(`mcp:${m.name}`);
    try {
      const res = await api.current.extras.mcpToggle(m.name, !m.enabled);
      if (res?.ok) { setMcp((prev) => prev.map((x) => x.name === m.name ? { ...x, enabled: !m.enabled } : x)); }
      else { showNotice(false, res?.error ?? "操作失败"); }
    } catch (e) {
      showNotice(false, `操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(null); }
  }

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, padding: "8px 11px",
    borderBottom: "1px solid var(--border)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 20 }}>
      {}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 800 }}>插件</span>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          共 {stats.total} 个技能（启用 {stats.enabled}）· {stats.mcpTotal} 个 MCP（启用 {stats.mcpEnabled}）
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ fontSize: 11.5, padding: "4px 10px" }}
          onClick={() => { void api.current?.extras?.skillsRootOpen?.(); }}>打开技能目录</button>
        <button className="btn" style={{ fontSize: 11.5, padding: "4px 10px" }}
          onClick={() => { setLoading(true); void refresh(); }}>刷新</button>
      </div>

      {notice && (
        <div style={{
          padding: "8px 12px", borderRadius: 9, fontSize: 12.5,
          border: `1px solid ${notice.ok ? "var(--success)" : "var(--warning)"}`,
          color: notice.ok ? "var(--success)" : "var(--warning)",
        }}>{notice.text}</div>
      )}

      {}
      <div style={{
        padding: "9px 12px", borderRadius: 9, fontSize: 12,
        border: "1px dashed var(--border-hover)", color: "var(--text-muted)",
      }}>
        来源取自技能 <code>SKILL.md</code> frontmatter 的 <code>origin</code> 声明，仅用于分类展示。
        <b>它是技能自己声明的，不能作为安全依据</b> —— 权限判定始终走沙箱与权限配置，不看这里。
      </div>

      {}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input className="input-field" value={query} spellCheck={false}
          placeholder="搜索技能名或描述…" style={{ flex: 1, minWidth: 180, fontSize: 12.5 }}
          onChange={(e) => setQuery(e.target.value)} />
        {[
          { k: "all", label: `全部 ${stats.total}` },
          { k: "agent", label: `Agent 自建 ${stats.byOrigin.agent ?? 0}` },
          { k: "market", label: `官方市场 ${stats.byOrigin.market ?? 0}` },
          { k: "user", label: `用户自备 ${stats.byOrigin.user ?? 0}` },
          { k: "", label: `未声明 ${stats.byOrigin[""] ?? 0}` },
        ].map((t) => (
          <button key={t.k || "none"} className="btn"
            style={{
              fontSize: 11.5, padding: "3px 9px",
              ...(originFilter === t.k
                ? { background: "var(--accent-soft)", borderColor: "var(--accent)", color: "var(--accent-hover)", fontWeight: 700 }
                : {}),
            }}
            onClick={() => setOriginFilter(t.k)}>{t.label}</button>
        ))}
      </div>

      {}
      <div style={{ border: "1px solid var(--card-border)", borderRadius: 10, background: "var(--card-surface)", overflow: "hidden" }}>
        <div style={{ padding: "7px 11px", borderBottom: "1px solid var(--border)", fontSize: 12.5, fontWeight: 700 }}>
          技能（{shown.length}{shown.length !== skills.length ? ` / ${skills.length}` : ""}）
        </div>
        {loading && <div style={{ padding: "14px 11px", fontSize: 12.5, color: "var(--text-dim)" }}>读取中…</div>}
        {!loading && shown.length === 0 && (
          <div style={{ padding: "14px 11px", fontSize: 12.5, color: "var(--text-dim)" }}>
            {skills.length === 0 ? "技能库为空 — 可在「技能库」页安装，或让 Agent 在创造模式下自建。" : `没有匹配「${query.trim()}」的技能`}
          </div>
        )}
        {shown.map((s, i) => {
          const o = originOf(s);
          const isBusy = busy === `skill:${s.name}`;
          return (
            <div key={s.name} style={{ ...rowStyle, ...(i === shown.length - 1 ? { borderBottom: "none" } : {}) }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.name}
                  </span>
                  <Badge text={o.label} title={o.hint} tone={o.key === "agent" ? "accent" : "dim"} />
                  {!s.hasSkillMd && <Badge text="缺 SKILL.md" tone="dim" title="该技能目录下没有 SKILL.md，引擎无法加载" />}
                  {!s.enabled && <Badge text="已停用" tone="dim" />}
                </div>
                {s.description && (
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.description}
                  </span>
                )}
              </div>
              <button className="btn" disabled={isBusy} style={{ fontSize: 11.5, padding: "3px 9px", flexShrink: 0 }}
                onClick={() => { void toggleSkill(s); }}>{s.enabled ? "停用" : "启用"}</button>
              <button className="btn" style={{ fontSize: 11.5, padding: "3px 9px", flexShrink: 0 }}
                onClick={() => { void openSkill(s); }}>目录</button>
              <button className="btn" disabled={isBusy} style={{ fontSize: 11.5, padding: "3px 9px", flexShrink: 0 }}
                onClick={() => { void removeSkill(s); }}>删除</button>
            </div>
          );
        })}
      </div>

      {}
      <div style={{ border: "1px solid var(--card-border)", borderRadius: 10, background: "var(--card-surface)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 11px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>MCP 服务器（{mcp.length}）</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>增删改在「MCP 接入」页</span>
        </div>
        {mcp.length === 0 && (
          <div style={{ padding: "14px 11px", fontSize: 12.5, color: "var(--text-dim)" }}>未配置 MCP 服务器</div>
        )}
        {mcp.map((m, i) => (
          <div key={m.name} style={{ ...rowStyle, ...(i === mcp.length - 1 ? { borderBottom: "none" } : {}) }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{m.name}</span>
                <Badge text={m.kind} tone="dim" />
                {!m.enabled && <Badge text="已停用" tone="dim" />}
              </div>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.kind === "stdio" ? (m.command ?? "") : (m.url ?? "")}
              </span>
            </div>
            <button className="btn" disabled={busy === `mcp:${m.name}`}
              style={{ fontSize: 11.5, padding: "3px 9px", flexShrink: 0 }}
              onClick={() => { void toggleMcp(m); }}>{m.enabled ? "停用" : "启用"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
