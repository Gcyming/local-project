/**
 * gui/src/renderer/pages/GeneralPanel.tsx — 设置「通用」专栏。
 * - 主题选择：Alpha（既有 slate 深色）/ Beta（毛玻璃黑里透蓝，史莱姆品牌配色）
 * - 开机自启开关：与安装器 HKCU Run 项语义一致（app.setLoginItemSettings）
 * - 卸载 Slime：启动 NSIS 卸载器（找不到时提示去控制面板/安装目录）
 */
import React, { type JSX } from "react";
import type { ThemeName } from "../theme.js";
import { confirmAsync } from "../dialog.js";

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
  const [exitMode, setExitModeState] = React.useState<"quit" | "background">("quit");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  // A-916：请求频率（并发上限 / 断流重连基间隔）
  const [reqCfg, setReqCfg] = React.useState<{ concurrency: number; reconnectBaseMs: number }>({ concurrency: 2, reconnectBaseMs: 3000 });
  const [reqBusy, setReqBusy] = React.useState(false);
  // A-969：上下文自动压缩（发送前触发；开启 + 触发占比 + 动画/静默）
  const [acCfg, setAcCfg] = React.useState<{ enabled: boolean; ratio: number; mode: "animated" | "silent" }>(() => {
    try {
      const raw = localStorage.getItem("slime_auto_compress");
      if (raw) {
        const p = JSON.parse(raw) as Partial<{ enabled: boolean; ratio: number; mode: "animated" | "silent" }>;
        const ratio = typeof p.ratio === "number" && p.ratio >= 0.5 && p.ratio <= 0.97 ? p.ratio : 0.85;
        return { enabled: p.enabled !== false, ratio, mode: p.mode === "silent" ? "silent" : "animated" };
      }
    } catch { /* ignore */ }
    return { enabled: true, ratio: 0.85, mode: "animated" };
  });
  const api = React.useRef<any>(null);

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 4000);
  };

  /** A-969：保存自动压缩配置（localStorage 内存态；ChatPanel 每次发送前实时读取） */
  const saveAutoCompress = (next: { enabled?: boolean; ratio?: number; mode?: "animated" | "silent" }): void => {
    setAcCfg((prev) => {
      const merged = { ...prev, ...next };
      try {
        localStorage.setItem("slime_auto_compress", JSON.stringify(merged));
      } catch { /* ignore */ }
      return merged;
    });
    showNotice(true, "上下文自动压缩配置已保存（聊天发送前自动生效）");
  };

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (api.current?.settings?.autostartGet) {
      void api.current.settings.autostartGet().then((r: { ok: boolean; enabled: boolean }) => {
        setAutostart(r.enabled);
      });
    }
    if (api.current?.window?.getExitMode) {
      void api.current.window.getExitMode().then((r: { mode: "quit" | "background" }) => setExitModeState(r.mode));
    }
    if (api.current?.requests?.get) {
      void api.current.requests.get().then((r: { concurrency?: number; reconnectBaseMs?: number }) => {
        setReqCfg({
          concurrency: typeof r?.concurrency === "number" ? r.concurrency : 2,
          reconnectBaseMs: typeof r?.reconnectBaseMs === "number" ? r.reconnectBaseMs : 3000,
        });
      }).catch(() => {});
    }
  }, []);

  async function saveRequests(): Promise<void> {
    if (!api.current?.requests?.set || reqBusy) { return; }
    setReqBusy(true);
    try {
      const r = await api.current.requests.set(reqCfg);
      showNotice(Boolean(r.ok), r.ok ? "请求频率已保存（新增任务/下次重连生效）" : (r.error ?? "保存失败"));
    } catch (e) {
      showNotice(false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReqBusy(false);
    }
  }

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
    const sure = await confirmAsync(
      "确定要卸载 Slime 吗？",
      "将启动卸载程序，应用会立即退出。卸载过程中可另行选择是否保留用户数据（API 密钥、Agent、会话历史）。",
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

      {/* A-916：请求频率调节（并发上限 / 断流重连基间隔） */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>请求频率</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 12 }}>
          用于匹配不同供应商的限流档位（RPM/并发）。若经常「生成到一半标红报错/被中断」，通常是上游节流——把并发调低、把重连间隔调大即可缓解。
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
            并发上限（同时发起的请求数）
            <select className="input-field" value={reqCfg.concurrency}
              onChange={(e) => setReqCfg((p) => ({ ...p, concurrency: Number(e.target.value) }))}>
              <option value={1}>1（最保守）</option>
              <option value={2}>2（默认，推荐）</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
              <option value={8}>8（高吞吐，需高 Tier）</option>
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
            断流自动重连基间隔
            <select className="input-field" value={reqCfg.reconnectBaseMs}
              onChange={(e) => setReqCfg((p) => ({ ...p, reconnectBaseMs: Number(e.target.value) }))}>
              <option value={1000}>1 秒（激进）</option>
              <option value={2000}>2 秒</option>
              <option value={3000}>3 秒（默认，推荐）</option>
              <option value={5000}>5 秒（温柔）</option>
            </select>
          </label>
          <button
            style={{
              borderRadius: 8,
              height: 34,
              padding: "0 18px",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              color: "var(--accent-hover)",
            }}
            disabled={reqBusy} onClick={() => void saveRequests()}>
            {reqBusy ? "保存中…" : "保存"}
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8 }}>
          每次重连按「基间隔 × 已尝试次数」指数递增并加抖动（避免惊群）；并发上限同时约束 Swarm 并行。
        </div>
      </div>

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

      {/* A-969：上下文自动压缩阈值设定 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>上下文自动压缩</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
              对话接近窗口上限时，发送前自动把早期对话压缩为摘要（摘要头 + 最近 N 轮），避免上下文被撑爆后模型遗忘或报错。
            </div>
          </div>
          <button
            onClick={() => saveAutoCompress({ enabled: !acCfg.enabled })}
            style={{
              height: 26, padding: "0 14px", borderRadius: 13, cursor: "pointer",
              border: `1px solid ${acCfg.enabled ? "var(--accent)" : "var(--border)"}`,
              background: acCfg.enabled ? "var(--accent-soft)" : "transparent",
              color: acCfg.enabled ? "var(--accent-hover)" : "var(--text-muted)",
              fontSize: 12, fontWeight: 700,
            }}>
            {acCfg.enabled ? "已开启" : "已关闭"}
          </button>
        </div>
        {acCfg.enabled && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
              触发占比（占用达到窗口上限的多少时压缩）
              <select className="input-field" value={acCfg.ratio}
                onChange={(e) => saveAutoCompress({ ratio: Math.min(0.97, Math.max(0.5, Number(e.target.value))) })}>
                <option value={0.6}>60%（提前压缩，最保守）</option>
                <option value={0.7}>70%</option>
                <option value={0.8}>80%（推荐）</option>
                <option value={0.85}>85%（默认）</option>
                <option value={0.9}>90%</option>
                <option value={0.95}>95%（窗口快满才压）</option>
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
              压缩过程展示
              <select className="input-field" value={acCfg.mode}
                onChange={(e) => saveAutoCompress({ mode: e.target.value === "silent" ? "silent" : "animated" })}>
                <option value="animated">过渡动画（整理→摘要→完成）</option>
                <option value="silent">静默压缩（后台完成，无界面打扰）</option>
              </select>
            </label>
          </div>
        )}
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
            disabled={busy}
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

      {/* A-937：退出行为——直接退出 / 最小化到后台保留 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>关闭应用时的行为</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, marginBottom: 10, lineHeight: 1.5 }}>
          选择直接退出，或最小化到系统托盘在后台保留（后台可继续执行定时任务 / 子代理，随时点击托盘图标恢复）。
        </div>
        {(["quit", "background"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              if (exitMode === m || busy) { return; }
              // A-967：preload 必须暴露 setExitMode，缺失时兜底报错复位，绝不卡死按钮
              if (!api.current?.window?.setExitMode) {
                showNotice(false, "当前版本不支持该设置，请升级应用");
                return;
              }
              setBusy(true);
              void api.current.window.setExitMode(m).then((r: { ok: boolean; mode: "quit" | "background" }) => {
                setExitModeState(r.mode ?? m);
                showNotice(true, r.mode === "background" ? "已启用：关闭时最小化到后台托盘" : "已启用：关闭时直接退出");
              }).catch((e: unknown) => {
                showNotice(false, `设置失败：${e instanceof Error ? e.message : String(e)}`);
              }).finally(() => setBusy(false));
            }}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8, marginRight: 18, marginBottom: 4,
              background: "none", border: "none", cursor: "pointer", padding: "4px 0", fontSize: 12.5,
              color: exitMode === m ? "var(--accent-hover)" : "var(--text-muted)",
            }}
          >
            <span style={{ width: 14, height: 14, borderRadius: 999, border: `2px solid ${exitMode === m ? "var(--accent)" : "var(--border)"}`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              {exitMode === m && <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }} />}
            </span>
            {m === "quit" ? "直接退出" : "最小化到后台保留（托盘常驻）"}
          </button>
        ))}
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
