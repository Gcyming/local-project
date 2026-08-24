/**
 * gui/src/renderer/pages/McpPanel.tsx — 设置「MCP 接入」专栏。
 * 从供应商界面剥离，独立管理：查看 MCP 服务器（来自 slime.toml [[mcp_servers]]）、
 * 启用/停用（注释/取消注释该块）。工具的开放与关闭受全局「权限」开关约束。
 */
import React, { type JSX } from "react";
import type { McpServerInfo } from "../../shared/ipc.js";

export default function McpPanel(): JSX.Element {
  const api = React.useRef<any>(null);
  const [servers, setServers] = React.useState<McpServerInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 3500);
  };

  const load = React.useCallback(async (): Promise<void> => {
    if (!api.current?.extras?.mcpList) { return; }
    try {
      const list = await api.current.extras.mcpList();
      setServers(list);
    } catch (e) {
      console.error("[mcp] list failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    void load();
  }, [load]);

  async function toggle(m: McpServerInfo): Promise<void> {
    if (!api.current?.extras?.mcpToggle) { return; }
    setBusy(m.name);
    try {
      const res = await api.current.extras.mcpToggle(m.name, !m.enabled);
      if (res?.ok) {
        showNotice(true, `MCP 服务器「${m.name}」已${m.enabled ? "停用" : "启用"}`);
        await load();
      } else {
        showNotice(false, res?.error ?? "操作失败");
      }
    } catch (e) {
      showNotice(false, `操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  /** 打开 MCP 配置所在目录（slime.toml 项目根） */
  async function openFolder(): Promise<void> {
    if (!api.current?.extras?.mcpOpen) { return; }
    const res = await api.current.extras.mcpOpen().catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!res?.ok) {
      showNotice(false, res?.error ?? "打开失败");
    }
  }

  /** 删除 MCP 服务器（从 slime.toml 移除块） */
  async function remove(m: McpServerInfo): Promise<void> {
    if (!api.current?.extras?.mcpDelete) { return; }
    if (!window.confirm(`确定删除 MCP 服务器「${m.name}」？其 [[mcp_servers]] 配置块将从 slime.toml 移除（自动备份 .bak）。`)) { return; }
    setBusy(m.name);
    try {
      const res = await api.current.extras.mcpDelete(m.name);
      if (res?.ok) {
        showNotice(true, `MCP 服务器「${m.name}」已删除`);
        await load();
      } else {
        showNotice(false, res?.error ?? "删除失败");
      }
    } catch (e) {
      showNotice(false, `删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ fontSize: 18, margin: 0, flex: 1 }}>MCP 接入</h2>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          启用 {servers.filter((s) => s.enabled).length} / {servers.length}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 14 }}>
        配置位于 slime.toml 的 [[mcp_servers]] 中。停用即注释掉对应配置块（自动备份 .bak）；
        本专栏负责接入/开关，协议的详细调试仍在供应商弹窗的「参数文件调试」里。
      </div>

      {notice && (
        <div style={{
          padding: "8px 12px", marginBottom: 12, fontSize: 12.5,
          borderRadius: 8, border: "1px solid var(--border)",
          background: notice.ok ? "var(--success-soft)" : "var(--danger-soft)",
          color: notice.ok ? "var(--success)" : "#f87171",
        }}>
          {notice.text}
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--text-dim)", fontSize: 13, padding: 12 }}>加载中…</div>
      ) : servers.length === 0 ? (
        <div className="card" style={{ padding: "18px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 12 }}>
            未发现 MCP 服务器。
            <br />
            MCP 服务器配置在 <code style={{ color: "var(--accent-hover)" }}>slime.toml</code> 的
            <code> [[mcp_servers]]</code> 中。
            <br />
            点击下方按钮打开配置文件所在目录，参照注释示例添加服务器后保存，刷新即可识别。
          </div>
          <button className="btn primary" style={{ padding: "7px 16px", fontSize: 13 }} onClick={() => void openFolder()}>
            打开配置文件添加
          </button>
        </div>
      ) : (
        servers.map((m) => (
          <div key={m.name} className="card" style={{
            display: "flex", alignItems: "center", gap: 12, marginBottom: 8,
            padding: "10px 12px",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: m.enabled ? "var(--text)" : "var(--text-dim)" }}>
                {m.name}
                {!m.enabled && <span style={{ fontSize: 11, color: "var(--warning)", marginLeft: 6 }}>已停用</span>}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, wordBreak: "break-all" }}>
                {m.kind === "http" ? `HTTP · ${m.url ?? ""}` : `stdio · ${m.command ?? ""}`}
              </div>
            </div>
            <span style={{ fontSize: 11, color: "var(--text-dim)", padding: "1px 8px", borderRadius: 8, background: "var(--bg-input)", flexShrink: 0 }}>
              {m.kind === "http" ? "HTTP" : "stdio"}
            </span>
            <button className={`btn${m.enabled ? "" : " primary"}`} style={{ padding: "4px 12px", fontSize: 12.5, flexShrink: 0 }}
              disabled={busy === m.name}
              onClick={() => void toggle(m)}>
              {busy === m.name ? "处理中…" : (m.enabled ? "停用" : "启用")}
            </button>
            <button className="btn" title="在文件管理器中打开 MCP 配置所在目录（slime.toml）" style={{ padding: "4px 10px", fontSize: 12, flexShrink: 0 }}
              onClick={() => void openFolder()}>
              打开
            </button>
            <button className="btn" title="从 slime.toml 删除该 MCP 服务器配置块（自动备份 .bak）" style={{ padding: "4px 10px", fontSize: 12, flexShrink: 0, color: "#f87171" }}
              disabled={busy === m.name}
              onClick={() => void remove(m)}>
              删除
            </button>
          </div>
        ))
      )}
    </div>
  );
}