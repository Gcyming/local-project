/**
 * gui/src/renderer/pages/PermissionsPanel.tsx — 设置「权限」专栏（全局权限控制台）。
 * - 全局默认审批模式：作为会话未单独配置时的兜底
 * - 工具权限类别开关 / MCP / 技能 全局开关：统一持久化到 gui_permissions.json
 */
import React, { type JSX } from "react";
import type { GuiPermissions, ApprovalMode } from "../../shared/ipc.js";

const TOOL_ROWS: Array<{ key: "toolRead" | "toolWrite" | "toolTerminal" | "toolNetwork"; label: string; desc: string; warn: boolean }> = [
  { key: "toolRead", label: "读（read）", desc: "检索本地文件 / 内存 / 知识库", warn: false },
  { key: "toolWrite", label: "写（write）", desc: "创建 / 修改本地文件与配置", warn: false },
  { key: "toolTerminal", label: "终端（terminal）", desc: "执行 shell / 命令，风险较高", warn: true },
  { key: "toolNetwork", label: "网络（network）", desc: "访问外部 API / 互联网", warn: true },
];

export default function PermissionsPanel(): JSX.Element {
  const [perms, setPerms] = React.useState<GuiPermissions | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  const api = React.useRef<any>(null);

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 3500);
  };

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (api.current?.permissions) {
      void api.current.permissions.get().then(setPerms).catch(console.error);
    }
  }, []);

  async function save(patch: Partial<Record<keyof GuiPermissions, unknown>>): Promise<void> {
    if (!api.current?.permissions) { return; }
    setSaving(true);
    try {
      const res = await api.current.permissions.set(patch);
      if (res?.ok) {
        setPerms(res.permissions);
        showNotice(true, "全局权限已保存");
      } else {
        showNotice(false, res?.error ?? "保存失败");
      }
    } catch (e) {
      showNotice(false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>全局权限控制</h2>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 14 }}>
        面向所有 Agent 的全局权限默认值。会话/项目级的单独配置优先于这里的默认值；
        MCP 与技能可在对应专栏单独启用/停用，此处开关统一起作用。
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

      {!perms ? (
        <div style={{ color: "var(--text-dim)", fontSize: 13, padding: 12 }}>加载中…</div>
      ) : (
        <>
          {/* 全局默认审批 */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>全局默认审批模式</div>
            <select
              className="tool-select" style={{ width: "100%", maxWidth: 320 }}
              value={perms.globalApproval}
              onChange={(e) => void save({ globalApproval: e.target.value as ApprovalMode })}
            >
              <option value="auto">自动批准（沙箱 L0-L1 直过，风险操作自动放行于低档）</option>
              <option value="confirm">需确认（L2-L4 操作弹窗审批）</option>
              <option value="strict">严格（高风险操作一律拒绝）</option>
            </select>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 6 }}>
              该模式作为会话配置的兜底：某会话若未单独设置审批模式，即采用它。
            </div>
          </div>

          {/* 工具权限类别 */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>工具权限类别</div>
            {TOOL_ROWS.map((r) => (
              <label key={r.key} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 2px",
                borderBottom: "1px solid var(--border)", cursor: "pointer",
              }}>
                <input
                  type="checkbox"
                  checked={perms[r.key]}
                  onChange={(e) => void save({ [r.key]: e.target.checked })}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, minWidth: 108, color: r.warn ? "var(--warning)" : "var(--text)" }}>
                  {r.label}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.desc}</span>
              </label>
            ))}
          </div>

          {/* 全局功能开关 */}
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>全局功能开关</div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8 }}>
              此处统一开关；如需单独管理请到「技能库」「MCP 接入」专栏。
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={perms.skillsEnabled}
                onChange={(e) => void save({ skillsEnabled: e.target.checked })}
                style={{ accentColor: "var(--accent)" }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>技能（skills）</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>允许 Agent 调用技能库中的技能</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={perms.mcpEnabled}
                onChange={(e) => void save({ mcpEnabled: e.target.checked })}
                style={{ accentColor: "var(--accent)" }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>MCP 接入</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>允许使用 MCP 服务器提供的工具</span>
            </label>
          </div>

          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 10 }}>
            {saving ? "保存中…" : "切换即保存（写入 config/gui_permissions.json，备份 .bak）"}
          </div>
        </>
      )}
    </div>
  );
}