






import React, { type JSX } from "react";
import type { StatsSnapshot, UpdateStatusDTO } from "../../shared/ipc.js";
import { alertAsync } from "../dialog.js";
import PlanPanel from "./PlanPanel.js";
import TraceViewer from "./TraceViewer.js";
import ReleaseNotesView from "./ReleaseNotesView.js";
import { PluginStatusBarItems, PluginStatusItems } from "../components/UiSlotHost.js";


function fmtBytes(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) { return "—"; }
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  if (n < 1024 * 1024 * 1024) { return `${(n / 1024 / 1024).toFixed(1)} MB`; }
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface TrendPoint {
  t: string;
  agents: number;
  records: number;
  servers: number;
}

const ACCENT = "#38bdf8";
const WARN = "#fbbf24";
const DANGER = "#f87171";



function LoadingClock({ since }: { since: number }): JSX.Element {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.round((now - since) / 1000));
  return <span style={{ fontSize: 11, color: WARN, marginLeft: 6 }}>已等待 {sec}s</span>;
}


function TrendLine({ data, color, height = 110 }: { data: number[]; color: string; height?: number }): JSX.Element {
  if (data.length < 2) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "20px 0" }}>等待数据（轮询积累中）…</div>;
  }
  const w = 400;
  const h = height;
  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 14) - 4).toFixed(1)}`).join(" ");
  const grid = [0.25, 0.5, 0.75].map((f) => (
    <line key={f} x1={0} x2={w} y1={h - f * (h - 14)} y2={h - f * (h - 14)} stroke="var(--border)" strokeWidth={0.6} strokeDasharray="3 3" />
  ));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height }} preserveAspectRatio="none">
      {grid}
      <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {data.map((v, i) => (
        <circle key={i} cx={i * step} cy={h - (v / max) * (h - 14) - 4} r={2.6} fill={color} />
      ))}
    </svg>
  );
}


function Bars({ data, color }: { data: Array<{ label: string; value: number }>; color: string }): JSX.Element {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 120, padding: "8px 4px 0" }}>
      {data.map((d) => (
        <div key={d.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text)" }}>{d.value}</span>
          <div style={{
            width: "100%", maxWidth: 44, height: Math.max((d.value / max) * 84, d.value > 0 ? 4 : 2),
            background: d.value > 0 ? color : "var(--bg-hover)",
            borderRadius: "6px 6px 0 0", transition: "height 0.3s",
          }} />
          <span style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function StatusPanel(): JSX.Element {
  const [stats, setStats] = React.useState<StatsSnapshot | null>(null);
  const [updateStatus, setUpdateStatus] = React.useState<UpdateStatusDTO | null>(null);
  
  const [notesOpen, setNotesOpen] = React.useState(true);
  const [trend, setTrend] = React.useState<TrendPoint[]>([]);
  
  const [loadingSince, setLoadingSince] = React.useState<Record<string, number>>({});
  const api = React.useRef<any>(null);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (!api.current) {
      return;
    }
    void api.current.stats.snapshot().then(setStats);
    




    const offPoll = api.current.stats.onPoll((snap: StatsSnapshot) => {
      setStats(snap);
      setLoadingSince((prev) => {
        const next = { ...prev };
        const loading = new Set(snap.servers.filter((s) => s.state === "loading").map((s) => s.role));
        for (const role of Object.keys(next)) {
          if (!loading.has(role)) delete next[role];
        }
        for (const role of loading) {
          if (!(role in next)) next[role] = Date.now();
        }
        return next;
      });
      setTrend((prev) => {
        const next = [...prev, {
          t: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          agents: snap.agents.total,
          records: snap.sessions.recent,
          servers: snap.servers.length,
        }];
        return next.slice(-30);
      });
    });
    const offUpdate = api.current.update.onStatus((s: UpdateStatusDTO) => setUpdateStatus(s));
    void api.current.stats.poll(true);
    return () => {
      offPoll();
      offUpdate();
      void api.current?.stats?.poll?.(false);
    };
  }, []);

  

  async function handleCheckUpdate() {
    const res = await api.current?.update?.check();
    if (res) setUpdateStatus(res);
  }

  
  async function handleDownloadUpdate() {
    const res = await api.current?.update?.download();
    if (res) setUpdateStatus(res);
  }

  async function handleInstallUpdate() {
    await api.current?.update?.install();
  }

  
  async function handleRetryEmbedding() {
    const res = await api.current?.model?.startEmbedding?.();
    if (res?.error) {
      void alertAsync(`向量模型启动失败：${res.error}`);
    }
    void api.current?.stats?.snapshot?.().then(setStats);
  }

  const servers = stats?.servers ?? [];
  const agents = stats?.agents ?? { total: 0, roots: 0, leaves: 0, byLifecycle: {}, maxDepth: 0 };
  const sessions = stats?.sessions ?? { totalRecords: 0, recent: 0 };

  
  const updateStatusSafe = updateStatus ?? { status: "disabled" };
  const isAvailable = updateStatus?.status === "available";
  const isDownloading = updateStatus?.status === "downloading";
  const isDownloaded = updateStatus?.status === "downloaded";
  
  const notesAvailable = Boolean((updateStatusSafe.releaseNotes ?? "").trim());

  const lifecycleBars = Object.entries(agents.byLifecycle).map(([label, value]) => ({ label, value }));
  const trendAgents = trend.map((p) => p.agents);
  const trendRecords = trend.map((p) => p.records);
  const trendServers = trend.map((p) => p.servers);

  const numCards: Array<{ label: string; value: number | string; color?: string }> = [
    { label: "Agent 总数", value: agents.total, color: ACCENT },
    { label: "根节点", value: agents.roots },
    { label: "叶节点", value: agents.leaves },
    { label: "最大深度", value: agents.maxDepth },
    { label: "会话记录", value: sessions.totalRecords, color: "#a78bfa" },
    { label: "24h 活跃", value: sessions.recent, color: WARN },
    { label: "模型实例", value: servers.length },
  ];

  return (
    
    <div className="settings-pane" style={{ padding: "16px 0", overflowY: "auto", height: "100%" }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>运行状态</h2>

      {}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 10, marginBottom: 14 }}>
        {numCards.map((c) => (
          <div key={c.label} className="card" style={{ padding: "10px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: c.color ?? "var(--text)" }}>{c.value}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{c.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        {}
        <section className="card">
          <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 14 }}>Agent 生命周期分布</h3>
          {lifecycleBars.length === 0 ? (
            <p style={{ color: "var(--text-dim)", fontSize: 12 }}>无数据</p>
          ) : (
            <Bars data={lifecycleBars} color={ACCENT} />
          )}
        </section>

        {}
        <section className="card">
          <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 14 }}>实时趋势（最近 {trend.length}/30 采样）</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: ACCENT, marginRight: 5, verticalAlign: "middle" }} />
                Agent 总数
              </div>
              <TrendLine data={trendAgents} color={ACCENT} height={80} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#a78bfa", marginRight: 5, verticalAlign: "middle" }} />
                24h 活跃会话
              </div>
              <TrendLine data={trendRecords} color="#a78bfa" height={80} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: WARN, marginRight: 5, verticalAlign: "middle" }} />
                模型实例数
              </div>
              <TrendLine data={trendServers} color={WARN} height={80} />
            </div>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span>{trend[0]?.t ?? "—"} → {trend[trend.length - 1]?.t ?? "—"}</span>
          </div>
          <div style={{
            fontSize: 11, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.6,
            padding: "8px 10px", borderRadius: 8, background: "var(--bg-input)",
          }}>
            说明：每 3 秒对系统状态自动采样一次，保留最近 30 次，反映 Agent 数 / 24h 内活跃的会话数 / 已启动的本地模型实例数的实时变化，属于监控采样而非交互次数统计。
          </div>
        </section>
      </div>

      {}
      <section className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0, fontSize: 14 }}>本地模型服务器（Sidecar）</h3>
        {servers.length === 0 ? (
          
          <div style={{ padding: "18px 0", textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.5 }}>🖥</div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4, fontWeight: 500 }}>未安装本地模型服务</div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
              在「设置 → 心智中枢」中配置并下载依赖（llama.cpp 与 bge 嵌入模型）后，<br />
              本地模型实例状态将在此实时显示。
            </div>
          </div>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
                  <th style={{ padding: "4px 8px" }}>角色</th>
                  <th style={{ padding: "4px 8px" }}>状态</th>
                  <th style={{ padding: "4px 8px" }}>端口</th>
                  <th style={{ padding: "4px 8px" }}>模型</th>
                  <th style={{ padding: "4px 8px" }}>VRAM</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.role} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{s.role === "embedding" ? "向量模型" : s.role}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <span style={{
                        color: s.state === "ready" ? "var(--success)"
                          : s.state === "loading" ? WARN
                          : s.state === "idle" ? "var(--text-muted)"
                          : DANGER,
                        fontWeight: 600,
                      }}>
                        {s.state === "ready" ? "● 就绪"
                          : s.state === "loading" ? "◐ 加载中"
                          : s.state === "idle" ? "○ 未运行"
                          : s.state}
                      </span>
                      {s.state === "loading" && loadingSince[s.role] && (
                        <LoadingClock since={loadingSince[s.role]} />
                      )}
                      {typeof s.error === "string" && s.error && (
                        <div style={{
                          fontSize: 11,
                          color: s.error.includes("不存在") || s.error.includes("未下载") ? "var(--text-muted)" : DANGER,
                          marginTop: 3, maxWidth: 320, lineHeight: 1.5, wordBreak: "break-all",
                        }}>
                          {s.error}
                        </div>
                      )}
                      {s.role === "embedding" && s.state !== "ready" && (
                        <button
                          className="btn"
                          style={{ fontSize: 11, padding: "2px 10px", marginTop: 4 }}
                          onClick={() => void handleRetryEmbedding()}
                        >
                          重试启动
                        </button>
                      )}
                    </td>
                    <td style={{ padding: "6px 8px" }}>{s.port ?? "—"}</td>
                    <td style={{ padding: "6px 8px" }}>{s.model ?? "—"}</td>
                    <td style={{ padding: "6px 8px" }}>{s.vram ? `${s.vram} GB` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {servers.some((s) => s.role === "embedding" && s.state !== "ready") && (
              <p style={{ color: "var(--text-muted)", fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
                向量模型未就绪：嵌入服务未启动或上次启动失败。常见原因：嵌入模型文件未下载/不完整、llama.cpp 未就位、或显存不足。可点击「重试启动」；若仍未成功，请到「设置 → 心智中枢 → 依赖」确认 bge 模型已下载。
              </p>
            )}
          </>
        )}
      </section>

      {

}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14, alignItems: "start" }}>
        <section className="card">
          <PlanPanel />
        </section>
        <section className="card">
          <TraceViewer />
        </section>
      </div>

      {}
      <section className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0, fontSize: 14 }}>自动更新</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {updateStatusSafe.error && (
            <span style={{ color: DANGER, fontSize: 13 }}>检查失败: {updateStatusSafe.error}</span>
          )}
          {
}
          {isAvailable && (
            <>
              <span style={{ color: "var(--success)", fontSize: 13 }}>
                发现新版本: {updateStatusSafe.version}（尚未下载，点击右侧按钮开始）
              </span>
              <button onClick={handleDownloadUpdate} className="btn sky" style={{ fontSize: 12.5 }}>
                下载更新
              </button>
            </>
          )}
          {isDownloading && (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
              正在下载 {updateStatusSafe.version}…
            </span>
          )}
          {isDownloaded && (
            <span style={{ color: "var(--success)", fontSize: 13 }}>
              新版本已下载 ({updateStatusSafe.version})
              <button onClick={handleInstallUpdate} className="btn sky" style={{ marginLeft: 10, fontSize: 12.5 }}>
                安装并重启
              </button>
            </span>
          )}
          {


}
          {updateStatusSafe.status === "disabled" && !updateStatusSafe.error && (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
              未开启启动时自动检查（可在 slime.toml 的 [update] 段设 auto_check = true）。
              点「手动检查」随时可查 —— 下载与安装都必须由你点击，不会自动发生。
            </span>
          )}
          {updateStatusSafe.status === "up-to-date" && (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>当前已是最新版本</span>
          )}
          {updateStatusSafe.status === "checking" && (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>正在检查更新...</span>
          )}
          {updateStatusSafe.status === "skipped" && (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>已跳过该版本</span>
          )}
          <button onClick={handleCheckUpdate} className="btn" style={{ fontSize: 12.5 }}>
            手动检查
          </button>
        </div>

        {



}
        {isDownloading && (
          <div style={{ marginTop: 10 }}>
            <div style={{ height: 6, borderRadius: 3, background: "var(--bg-hover)", overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${Math.max(0, Math.min(100, updateStatusSafe.percent ?? 0))}%`,
                background: "var(--accent)",
                borderRadius: 3,
                transition: "width 0.25s ease",
              }} />
            </div>
            <div style={{
              marginTop: 6, fontSize: 11.5, color: "var(--text-muted)",
              display: "flex", gap: 10, flexWrap: "wrap",
            }}>
              <span style={{ fontWeight: 600, color: "var(--text)" }}>
                {(updateStatusSafe.percent ?? 0).toFixed(1)}%
              </span>
              <span>
                {fmtBytes(updateStatusSafe.transferred)} / {fmtBytes(updateStatusSafe.total)}
              </span>
              {typeof updateStatusSafe.bytesPerSecond === "number" && updateStatusSafe.bytesPerSecond > 0 && (
                <span>{fmtBytes(updateStatusSafe.bytesPerSecond)}/s</span>
              )}
            </div>
          </div>
        )}
        {
}
        {(isAvailable || isDownloaded) && notesAvailable && (
          <div style={{ marginTop: 8 }}>
            <button
              onClick={() => setNotesOpen((o) => !o)}
              className="btn"
              style={{ fontSize: 12.5 }}
              aria-expanded={notesOpen}
            >
              {notesOpen ? "收起更新说明" : `查看更新说明（${updateStatusSafe.version}）`}
            </button>
            {notesOpen && <ReleaseNotesView notes={updateStatusSafe.releaseNotes ?? ""} />}
          </div>
        )}
      </section>
      {/* A-1197 · B2（L4a）：扩展声明的 status_item（无声明时不渲染任何东西） */}
      <PluginStatusItems />
      {/* A-1200 · B1：`status_bar` 区域（扩展声明的底部状态条一行）。
          ⚠️ 与上面 `status_item` **是两个区域**：那是右栏状态行，这是贴在面板最底下的一条。 */}
      <PluginStatusBarItems />
    </div>
  );
}