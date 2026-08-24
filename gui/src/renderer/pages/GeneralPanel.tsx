/**
 * gui/src/renderer/pages/GeneralPanel.tsx — 设置「通用」专栏。
 * - 主题选择：Alpha（既有 slate 深色）/ Beta（毛玻璃黑里透蓝，史莱姆品牌配色）
 * - 开机自启开关：与安装器 HKCU Run 项语义一致（app.setLoginItemSettings）
 * - 卸载 Slime：启动 NSIS 卸载器（找不到时提示去控制面板/安装目录）
 */
import React, { type JSX } from "react";
import type { ThemeName } from "../theme.js";

interface Props {
  theme?: ThemeName;
  onThemeChange?: (t: ThemeName) => void;
}

const THEMES: Array<{ id: ThemeName; name: string; desc: string; swatch: string[] }> = [
  {
    id: "alpha",
    name: "Alpha",
    desc: "既有配色：slate 深色 + 天蓝 accent，沉稳清晰",
    swatch: ["#0f172a", "#1e293b", "#3b82f6"],
  },
  {
    id: "beta",
    name: "Beta",
    desc: "毛玻璃质感、黑里透蓝（史莱姆品牌配色：天蓝 / 紫 / 深蓝）",
    swatch: ["#0a0e1c", "#38bdf8", "#8cf6fb"],
  },
];

export default function GeneralPanel({ theme = "alpha", onThemeChange }: Props): JSX.Element {
  const [autostart, setAutostart] = React.useState<boolean | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  const api = React.useRef<any>(null);

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 4000);
  };

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (api.current?.settings?.autostartGet) {
      void api.current.settings.autostartGet().then((r: { ok: boolean; enabled: boolean }) => {
        setAutostart(Boolean(r.enabled));
      }).catch(console.error);
    }
  }, []);

  async function toggleAutostart(next: boolean): Promise<void> {
    if (!api.current?.settings?.autostartSet || busy) { return; }
    setBusy(true);
    try {
      const r = await api.current.settings.autostartSet(next);
      setAutostart(Boolean(r.enabled));
      showNotice(r.ok, r.ok ? (r.enabled ? "已开启开机自启" : "已关闭开机自启") : (r.error ?? "设置失败"));
    } catch (e) {
      showNotice(false, `设置失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleUninstall(): Promise<void> {
    if (!api.current?.settings?.uninstall) { return; }
    const sure = window.confirm(
      "确定要卸载 Slime 吗？\n\n将启动卸载程序，应用会立即退出。\n卸载过程中可另行选择是否保留用户数据（API 密钥、Agent、会话历史）。",
    );
    if (!sure) { return; }
    setBusy(true);
    try {
      const r = await api.current.settings.uninstall();
      if (!r.ok) {
        showNotice(false, r.error ?? "启动卸载程序失败");
        setBusy(false);
      }
      // 成功时应用即将退出，无需复位 busy
    } catch (e) {
      showNotice(false, `启动卸载程序失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>通用设置</h2>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 14 }}>
        应用级行为：界面主题、开机自启与卸载。主题切换即时生效并持久化保存。
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

      {/* 主题选择 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>界面主题</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {THEMES.map((t) => {
            const active = theme === t.id;
            return (
              <button key={t.id}
                onClick={() => onThemeChange?.(t.id)}
                title={t.desc}
                style={{
                  flex: "1 1 220px", maxWidth: 300, textAlign: "left", cursor: "pointer",
                  padding: "12px 14px", borderRadius: 12,
                  border: `1.5px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  background: active ? "var(--accent-soft)" : "var(--bg-input)",
                  transition: "border-color 0.12s, transform 0.08s, box-shadow 0.12s",
                }}
                onMouseEnter={(e) => { if (!active) { e.currentTarget.style.borderColor = "var(--border-hover)"; } }}
                onMouseLeave={(e) => { if (!active) { e.currentTarget.style.borderColor = "var(--border)"; } }}
                onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.98)"; }}
                onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ display: "inline-flex", gap: 4 }}>
                    {t.swatch.map((c) => (
                      <span key={c} style={{ width: 18, height: 18, borderRadius: "50%", background: c, border: "1px solid rgba(255,255,255,0.15)" }} />
                    ))}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: active ? "var(--accent-hover)" : "var(--text)" }}>
                    {t.name}
                  </span>
                  {active && <span style={{ fontSize: 11, color: "var(--accent-hover)", marginLeft: "auto" }}>使用中</span>}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{t.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 开机自启 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>开机自动启动</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
              登录 Windows 后自动运行 Slime（写入 HKCU Run 注册表，与安装器选项一致）。
            </div>
          </div>
          <button
            onClick={() => void toggleAutostart(autostart !== true)}
            disabled={autostart === null || busy}
            title={autostart ? "点击关闭开机自启" : "点击开启开机自启"}
            style={{
              height: 26, padding: "0 14px", borderRadius: 13, cursor: "pointer",
              border: `1px solid ${autostart ? "var(--accent)" : "var(--border)"}`,
              background: autostart ? "var(--accent-soft)" : "transparent",
              color: autostart ? "var(--accent-hover)" : "var(--text-muted)",
              fontSize: 12, fontWeight: 700,
            }}>
            {autostart === null ? "…" : (autostart ? "已开启" : "已关闭")}
          </button>
        </div>
      </div>

      {/* 卸载 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>卸载 Slime</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
              启动系统卸载程序，移除应用本体。卸载时可选择是否保留用户数据（API 密钥、Agent、会话历史）。
            </div>
          </div>
          <button
            onClick={() => void handleUninstall()}
            disabled={busy}
            style={{
              height: 26, padding: "0 14px", borderRadius: 13, cursor: "pointer",
              border: "1px solid var(--danger)", background: "var(--danger-soft)",
              color: "#f87171", fontSize: 12, fontWeight: 700,
            }}>
            卸载
          </button>
        </div>
      </div>
    </div>
  );
}
