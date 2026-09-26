/**
 * gui/src/renderer/pages/LlmGatewayPanel.tsx — 设置「LLM 网关」专栏。
 * - 开关：启用/停用 slime 专属 LLM 转发网关（OpenAI 兼容入口）
 * - 端口 + 独立 API Key 配置
 * - 运行状态（运行中/已停止/错误）+ 调用示例
 * - 令牌管理（B 档：每令牌独立速率/日配额/模型白名单，映射 new-api 的"我的令牌"）
 */
import React, { type JSX } from "react";

/** 令牌（渲染层视图）：与 shared/ipc 的 LlmGatewayTokenDTO 同构 */
interface TokenRow {
  key: string;
  label?: string;
  active?: boolean;
  ratePerMin?: number;
  dailyQuota?: number;
  models?: string[];
  note?: string;
}
interface GatewayConfig {
  enabled: boolean;
  port: number;
  apiKey: string;
  tokens?: TokenRow[];
}
interface GatewayStatus {
  ok: boolean;
  running: boolean;
  port: number;
  enabled: boolean;
  apiKeyConfigured: boolean;
  error?: string;
  tokenCount?: number;
}

const LlmGatewayPanel = React.memo(function LlmGatewayPanel(): JSX.Element {
  const [cfg, setCfg] = React.useState<GatewayConfig>({ enabled: true, port: 19110, apiKey: "" });
  const [status, setStatus] = React.useState<GatewayStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null); // 正在编辑的令牌 key（null=新增）
  const [showForm, setShowForm] = React.useState(false);            // 是否显示令牌表单（新增/编辑共用）
  const [copied, setCopied] = React.useState<string | null>(null); // 刚复制的令牌 key
  const api = React.useRef<any>(null);

  /** 新增/编辑令牌表单（编辑时预填现有值） */
  const emptyForm = React.useCallback(() => ({
    label: "",
    ratePerMin: 0,
    dailyQuota: 0,
    models: "" as string, // 渲染层用逗号分隔文本，提交时拆分
    note: "",
  }), []);
  const [form, setForm] = React.useState(emptyForm);

  const startAdd = React.useCallback(() => {
    setEditing(null);
    setForm(emptyForm());
    setShowForm(true);
  }, [emptyForm]);

  const startEdit = React.useCallback((t: TokenRow) => {
    setEditing(t.key);
    setForm({
      label: t.label ?? "",
      ratePerMin: t.ratePerMin ?? 0,
      dailyQuota: t.dailyQuota ?? 0,
      models: (t.models ?? []).join(","),
      note: t.note ?? "",
    });
    setShowForm(true);
  }, []);

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 5000);
  };

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    void refresh();
    // 状态轮询（3s）
    const t = window.setInterval(() => {
      if (api.current?.llmGateway?.status) {
        void api.current.llmGateway.status().then((s: GatewayStatus) => setStatus(s));
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, []);

  async function refresh(): Promise<void> {
    if (!api.current?.llmGateway?.get) { return; }
    try {
      const r = await api.current.llmGateway.get();
      if (r?.config) { setCfg(r.config); }
      if (r?.status) { setStatus(r.status); }
    } catch (e) {
      showNotice(false, `读取网关配置失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 复制令牌到剪贴板（脱敏回显） */
  async function copyToken(key: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(key);
      } else {
        // 降级：临时 textarea
        const ta = document.createElement("textarea");
        ta.value = key;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(key);
      window.setTimeout(() => setCopied((p) => (p === key ? null : p)), 2000);
    } catch {
      showNotice(false, "复制失败（请手动复制）");
    }
  }

  /** 脱敏 key：前 6 位 + … + 后 4 位 */
  function maskKey(key: string): string {
    if (key.length <= 12) { return key.slice(0, 2) + "…" + key.slice(-2); }
    return key.slice(0, 6) + "…" + key.slice(-4);
  }

  async function save(next: Partial<GatewayConfig>): Promise<void> {
    if (!api.current?.llmGateway?.set || busy) { return; }
    setBusy(true);
    try {
      const merged = { ...cfg, ...next };
      const r = await api.current.llmGateway.set(merged);
      if (r?.status) { setStatus(r.status); }
      if (r?.ok) {
        setCfg(merged);
        showNotice(true, merged.enabled ? "网关已启用（重启/保存即时生效）" : "网关已停用");
      } else {
        showNotice(false, r?.error ?? "保存失败");
      }
    } catch (e) {
      showNotice(false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function restart(): Promise<void> {
    if (!api.current?.llmGateway?.restart || busy) { return; }
    setBusy(true);
    try {
      const r = await api.current.llmGateway.restart();
      if (r?.status) { setStatus(r.status); }
      showNotice(Boolean(r?.ok), r?.ok ? "网关已重启" : (r?.error ?? "重启失败"));
    } catch (e) {
      showNotice(false, `重启失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // ── 令牌 CRUD（B 档）────────────────────
  function modelsFromForm(): string[] {
    return form.models
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function submitToken(): Promise<void> {
    const add = api.current?.llmGateway?.tokenAdd;
    const upd = api.current?.llmGateway?.tokenUpdate;
    if (!add || !upd || busy) { return; }
    setBusy(true);
    const payload = {
      label: form.label.trim() || undefined,
      ratePerMin: form.ratePerMin > 0 ? form.ratePerMin : undefined,
      dailyQuota: form.dailyQuota > 0 ? form.dailyQuota : undefined,
      models: modelsFromForm(),
      note: form.note.trim() || undefined,
    };
    try {
      let r;
      if (editing === null) {
        r = await add(payload);
      } else {
        r = await upd({ key: editing, ...payload });
      }
      if (r?.status) { setStatus(r.status); }
      if (r?.tokens) { setCfg((p) => ({ ...p, tokens: r.tokens })); }
      if (r?.ok) {
        showNotice(true, editing === null ? "令牌已创建" : "令牌已更新");
        setEditing(null);
        setShowForm(false);
      } else {
        showNotice(false, r?.error ?? "保存令牌失败");
      }
    } catch (e) {
      showNotice(false, `保存令牌失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleToken(t: TokenRow): Promise<void> {
    const fn = api.current?.llmGateway?.tokenToggle;
    if (!fn || busy) { return; }
    setBusy(true);
    try {
      const active = t.active === false; // 切换
      const r = await fn(t.key, active);
      if (r?.status) { setStatus(r.status); }
      if (r?.tokens) { setCfg((p) => ({ ...p, tokens: r.tokens })); }
      if (!r?.ok) { showNotice(false, r?.error ?? "切换失败"); }
    } catch (e) {
      showNotice(false, `切换失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteToken(t: TokenRow): Promise<void> {
    const fn = api.current?.llmGateway?.tokenRemove;
    if (!fn || busy) { return; }
    if (!window.confirm(`确定删除令牌「${t.label ?? maskKey(t.key)}」？删除后该令牌立即失效。`)) { return; }
    setBusy(true);
    try {
      const r = await fn(t.key);
      if (r?.status) { setStatus(r.status); }
      if (r?.tokens) { setCfg((p) => ({ ...p, tokens: r.tokens })); }
      if (editing === t.key) { setEditing(null); setShowForm(false); }
      if (r?.ok) { showNotice(true, "令牌已删除"); } else { showNotice(false, r?.error ?? "删除失败"); }
    } catch (e) {
      showNotice(false, `删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const running = status?.running ?? false;

  // 令牌管理表格的复用样式
  const gridCols = "1.1fr 1.5fr 0.6fr 1.6fr 1fr 1.5fr";
  const gridHead: React.CSSProperties = {
    padding: "9px 12px", background: "var(--bg-hover)", fontSize: 11.5, fontWeight: 600,
    color: "var(--text-muted)", borderTop: "1px solid var(--border)",
  };
  const gridRow: React.CSSProperties = {
    padding: "10px 12px", borderTop: "1px solid var(--border)", fontSize: 12.5,
    alignItems: "center",
  };
  const linkBtn: React.CSSProperties = {
    height: 24, padding: "0 10px", borderRadius: 6, fontSize: 11.5, cursor: "pointer",
    border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)",
  };
  const dangerLinkBtn: React.CSSProperties = {
    height: 24, padding: "0 10px", borderRadius: 6, fontSize: 11.5, cursor: "pointer",
    border: "1px solid var(--border)", background: "transparent", color: "#f87171",
  };
  const toggleBtn: React.CSSProperties = {
    height: 22, padding: "0 8px", borderRadius: 11, fontSize: 10.5, cursor: "pointer",
    border: "none", background: "var(--bg-hover)", color: "var(--text-muted)",
  };
  const activeBadge: React.CSSProperties = {
    fontSize: 10.5, padding: "2px 8px", borderRadius: 10,
    background: "var(--success-soft)", color: "var(--success)",
  };
  const inactiveBadge: React.CSSProperties = {
    fontSize: 10.5, padding: "2px 8px", borderRadius: 10,
    background: "var(--bg-hover)", color: "var(--text-dim)",
  };

  const tokens: TokenRow[] = cfg.tokens ?? [];

  return (
    /* A-1119：左地板归 `SettingsDialog` 内容区（16px），此处 paddingLeft 必须为 0（否则叠加成 32）。 */
    <div className="settings-pane" style={{ padding: "16px 0", overflowY: "auto", height: "100%" }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>LLM 网关（slime 内置）</h2>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 14 }}>
        slime 默认内置的 OpenAI 兼容转发网关：把第三方工具（Cherry Studio / 脚本 / 其它前端）的请求转发到你在「供应商」里配置的多个上游模型，自动完成 OpenAI↔Anthropic↔Gemini 格式互转。本机监听，不依赖任何外部程序。默认为「开」，此页只需按需关闭。
      </div>

      {notice && (
        <div style={{
          padding: "8px 12px", marginBottom: 12, fontSize: 12.5, lineHeight: 1.5,
          borderRadius: 8, border: "1px solid var(--border)",
          background: notice.ok ? "var(--success-soft)" : "var(--danger-soft)",
          color: notice.ok ? "var(--success)" : "#f87171",
        }}>
          {notice.text}
        </div>
      )}

      {/* 开关 + 状态 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>启用 LLM 网关</div>
              <span style={{
                fontSize: 10.5, padding: "1px 8px", borderRadius: 10,
                background: running ? "var(--success-soft)" : "var(--bg-hover)",
                color: running ? "var(--success)" : "var(--text-muted)",
              }}>
                {running ? "运行中" : "已停止"}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
              开启后，本机 {status?.port ?? cfg.port} 端口将提供 OpenAI 兼容端点（POST /v1/chat/completions、GET /v1/models）。
            </div>
          </div>
          <button
            onClick={() => void save({ enabled: !cfg.enabled })}
            disabled={busy}
            style={{
              height: 26, padding: "0 14px", borderRadius: 13, cursor: "pointer",
              border: `1px solid ${cfg.enabled ? "var(--accent)" : "var(--border)"}`,
              background: cfg.enabled ? "var(--accent-soft)" : "transparent",
              color: cfg.enabled ? "var(--accent-hover)" : "var(--text-muted)",
              fontSize: 12, fontWeight: 700,
            }}>
            {cfg.enabled ? "已开启" : "已关闭"}
          </button>
        </div>
      </div>

      {/* 端口 + API Key */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>监听配置</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
            端口
            <input
              className="input-field"
              type="number"
              min={1024}
              max={65535}
              value={cfg.port}
              onChange={(e) => setCfg((p) => ({ ...p, port: Number(e.target.value) || 19110 }))}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
            独立 API Key（可选；留空则沿用 slime 全局认证 token）
            <input
              className="input-field"
              type="text"
              placeholder="gw-sk-xxxxxxxx"
              value={cfg.apiKey}
              onChange={(e) => setCfg((p) => ({ ...p, apiKey: e.target.value }))}
            />
          </label>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button
            onClick={() => void save({})}
            disabled={busy}
            style={{
              height: 34, padding: "0 18px", borderRadius: 8, fontSize: 12.5, fontWeight: 600,
              cursor: "pointer", background: "var(--accent-soft)", border: "1px solid var(--accent)",
              color: "var(--accent-hover)",
            }}>
            {busy ? "保存中…" : "保存并应用"}
          </button>
          {running && (
            <button
              onClick={() => void restart()}
              disabled={busy}
              style={{
                height: 34, padding: "0 18px", borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                cursor: "pointer", background: "var(--bg-hover)", border: "1px solid var(--border)",
                color: "var(--text)",
              }}>
              重启网关
            </button>
          )}
        </div>
        {status?.error && (
          <div style={{ fontSize: 11.5, color: "#f87171", marginTop: 10, lineHeight: 1.5 }}>
            启动错误：{status.error}
          </div>
        )}
      </div>

      {/* 调用示例 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>调用示例</div>
        <pre style={{
          margin: 0, padding: 12, borderRadius: 8, fontSize: 11.5, lineHeight: 1.6,
          background: "var(--bg-input)", color: "var(--text)", overflowX: "auto",
        }}>{`# 列出可用模型
curl -H "Authorization: Bearer ${cfg.apiKey || "slime-token"}" \\
  http://127.0.0.1:${cfg.port}/v1/models

# 对话（自动路由到「供应商」里已配置的 gpt-4o）
curl -X POST http://127.0.0.1:${cfg.port}/v1/chat/completions \\
  -H "Authorization: Bearer ${cfg.apiKey || "slime-token"}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'

# 强制指定供应商（provider:model 语法）
  -d '{"model":"anthropic:claude-sonnet-4-20250514", ...}'`}</pre>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
          在 Cherry Studio 等第三方客户端里，把 API 地址填 <code>http://127.0.0.1:{cfg.port}/v1</code>、Key 填上方的独立 Key（或 slime 全局 token），即可复用 slime 已配置的全部上游模型。
        </div>
      </div>

      {/* 令牌管理（B 档：映射 new-api 的"我的令牌"）*/}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>令牌管理</div>
          <button
            onClick={() => startAdd()}
            style={{
              height: 26, padding: "0 12px", borderRadius: 13, cursor: "pointer",
              border: "1px solid var(--accent)", background: "var(--accent-soft)",
              color: "var(--accent-hover)", fontSize: 11.5, fontWeight: 700,
            }}>
            + 创建令牌
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 10 }}>
          每个令牌可独立配置「模型白名单 + 每分钟速率 + 日配额」，映射 new-api 的"我的令牌"。第三方工具在 Cherry Studio 里把 Key 填成下表任意一个令牌即可使用。
        </div>

        {/* 新增 / 编辑表单 */}
        {showForm && (
          <div style={{
            padding: 12, borderRadius: 8, border: "1px solid var(--accent)",
            background: "var(--accent-soft)", marginBottom: 10,
          }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>
              {editing === null ? "创建新令牌" : "编辑令牌"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11.5 }}>
                名称（备注）
                <input className="input-field" value={form.label} placeholder="如：Cherry Studio"
                  onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11.5 }}>
                每分钟速率上限（0 = 不限）
                <input className="input-field" type="number" min={0} value={form.ratePerMin}
                  onChange={(e) => setForm((p) => ({ ...p, ratePerMin: Number(e.target.value) || 0 }))} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11.5 }}>
                日配额（0 = 不限；映射 new-api 的"额度"）
                <input className="input-field" type="number" min={0} value={form.dailyQuota}
                  onChange={(e) => setForm((p) => ({ ...p, dailyQuota: Number(e.target.value) || 0 }))} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11.5 }}>
                允许模型（逗号分隔；空 = 全部）
                <input className="input-field" value={form.models} placeholder="gpt-4o,claude,deepseek"
                  onChange={(e) => setForm((p) => ({ ...p, models: e.target.value }))} />
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button
                onClick={() => void submitToken()}
                disabled={busy}
                style={{
                  height: 28, padding: "0 14px", borderRadius: 7, fontSize: 11.5, fontWeight: 600,
                  cursor: "pointer", background: "var(--accent-soft)", border: "1px solid var(--accent)",
                  color: "var(--accent-hover)",
                }}>
                {busy ? "保存中…" : "保存令牌"}
              </button>
              <button
                onClick={() => setShowForm(false)}
                style={linkBtn}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {/* 令牌表格 */}
        {tokens.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: gridCols, minWidth: 700 }}>
              <div style={gridHead}>名称</div>
              <div style={gridHead}>令牌（点击复制）</div>
              <div style={gridHead}>状态</div>
              <div style={gridHead}>允许模型</div>
              <div style={gridHead}>速率/配额</div>
              <div style={gridHead}>操作</div>

              {tokens.map((t) => {
                const active = t.active !== false;
                const modelsTxt = t.models && t.models.length > 0
                  ? t.models.join("、")
                  : <span style={{ color: "var(--text-dim)" }}>全部</span>;
                const rateTxt = t.ratePerMin ? `${t.ratePerMin}/min` : "不限";
                const quotaTxt = t.dailyQuota ? `/${t.dailyQuota}/日` : "/不限";
                const isEditing = editing === t.key;
                return (
                  <React.Fragment key={t.key}>
                    {/* 名称 */}
                    <div style={{ ...gridRow, display: "grid" }}>
                      <span style={{ color: active ? "var(--text)" : "var(--text-dim)" }}>
                        {t.label || maskKey(t.key)}
                      </span>
                    </div>
                    {/* 令牌 */}
                    <div style={{ ...gridRow, display: "grid" }}>
                      <button
                        onClick={() => void copyToken(t.key)}
                        style={{
                          ...linkBtn, width: "100%", textAlign: "left", fontFamily: "ui-monospace, monospace",
                          background: "var(--bg-input)",
                        }}
                        title="点击复制完整令牌">
                        {copied === t.key ? "已复制 ✓" : maskKey(t.key)}
                      </button>
                    </div>
                    {/* 状态 */}
                    <div style={{ ...gridRow, display: "grid" }}>
                      {active ? <span style={activeBadge}>有效</span> : <span style={inactiveBadge}>停用</span>}
                    </div>
                    {/* 允许模型 */}
                    <div style={{ ...gridRow, display: "grid", color: "var(--text-muted)" }}>
                      {modelsTxt}
                    </div>
                    {/* 速率/配额 */}
                    <div style={{ ...gridRow, display: "grid", color: "var(--text-muted)" }}>
                      {rateTxt}{quotaTxt}
                    </div>
                    {/* 操作 */}
                    <div style={{ ...gridRow, display: "grid" }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button onClick={() => void toggleToken(t)} style={toggleBtn} title={active ? "停用该令牌" : "启用该令牌"}>
                          {active ? "停用" : "启用"}
                        </button>
                        <button
                          onClick={() => (isEditing ? setShowForm(false) : startEdit(t))}
                          style={{ ...linkBtn, border: isEditing ? "1px solid var(--accent)" : linkBtn.border, color: isEditing ? "var(--accent-hover)" : "var(--text-muted)" }}>
                          编辑
                        </button>
                        <button onClick={() => void deleteToken(t)} style={dangerLinkBtn}>
                          删除
                        </button>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        ) : (
          !showForm && (
            <div style={{ padding: 16, textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}>
              还没有令牌。点「+ 创建令牌」生成第一个；或直接用上方「独立 API Key / 全局 token」访问网关。
            </div>
          )
        )}
      </div>
    </div>
  );
});

export default LlmGatewayPanel;
