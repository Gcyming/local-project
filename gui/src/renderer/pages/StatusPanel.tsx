/**
 * gui/src/renderer/pages/StatusPanel.tsx — 状态面板（图表化）。
 * - 数字卡：Agent 树 / 会话 / 服务器概览
 * - 生命周期分布柱状图 + 轮询趋势折线图（SVG 自绘，无第三方库）
 * - 表格：模型服务器实例 / 告警
 * - 3s 轮询 → slime:stats:update 推送；自动更新状态
 */
import React, { type JSX } from "react";
import type { StatsSnapshot, SidecarStatus } from "../../shared/ipc.js";

interface UpdateStatus {
  status: string;
  version?: string;
  releaseNotes?: string;
  error?: string;
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

/** 迷你折线图（SVG polyline） */
function TrendLine({ data, color, height = 110 }: { data: number[]; color: string; height?: number }): JSX.Element {
  if (data.length < 2) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "20px 0" }}>等待数据（轮询积累中）…</div>;
  }
  const w = 400;
  const h = height;
  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 14) - 4).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height }} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {data.map((v, i) => (
        <circle key={i} cx={i * step} cy={h - (v / max) * (h - 14) - 4} r={2.6} fill={color} />
      ))}
    </svg>
  );
}

/** 柱状图（div 条，竖向） */
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
  const [sidecar, setSidecar] = React.useState<SidecarStatus | null>(null);
  const [updateStatus, setUpdateStatus] = React.useState<UpdateStatus | null>(null);
  const [trend, setTrend] = React.useState<TrendPoint[]>([]);
  const api = React.useRef<any>(null);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (!api.current) {
      return;
    }
    void api.current.stats.snapshot().then(setStats);
    void api.current.sidecar.status().then(setSidecar);
    void api.current.update.check().then(setUpdateStatus);
    const offPoll = api.current.stats.onPoll((snap: StatsSnapshot) => {
      setStats(snap);
      setTrend((prev) => {
        const next = [...prev, {
          t: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          agents: snap.agents.total,
          records: snap.sessions.totalRecords,
          servers: snap.servers.length,
        }];
        return next.slice(-30);
      });
    });
    const offSidecar = api.current.sidecar.onStatus((s: SidecarStatus) => setSidecar(s));
    const offUpdate = api.current.update.onStatus((s: UpdateStatus) => setUpdateStatus(s));
    void api.current.stats.poll(true);
    return () => {
      offPoll();
      offSidecar();
      offUpdate();
      void api.current?.stats?.poll?.(false);
    };
  }, []);

  async function handleCheckUpdate() {
    const res = await api.current?.update?.check();
    if (res) setUpdateStatus(res);
  }

  async function handleInstallUpdate() {
    await api.current?.update?.install();
  }

  const servers = stats?.servers ?? [];
  const agents = stats?.agents ?? { total: 0, roots: 0, leaves: 0, byLifecycle: {}, maxDepth: 0 };
  const sessions = stats?.sessions ?? { totalRecords: 0, recent: 0 };
  const alarms = stats?.alarms ?? [];
  const isAvailable = updateStatus?.status === "available";
  const isDownloaded = updateStatus?.status === "downloaded";

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
    { label: "告警", value: alarms.length, color: alarms.length > 0 ? DANGER : undefined },
  ];

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>运行状态</h2>

      {/* 数字卡 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 10, marginBottom: 14 }}>
        {numCards.map((c) => (
          <div key={c.label} className="card" style={{ padding: "10px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: c.color ?? "var(--text)" }}>{c.value}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{c.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        {/* 生命周期分布柱状图 */}
        <section className="card">
          <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 14 }}>Agent 生命周期分布</h3>
          {lifecycleBars.length === 0 ? (
            <p style={{ color: "var(--text-dim)", fontSize: 12 }}>无数据</p>
          ) : (
            <Bars data={lifecycleBars} color={ACCENT} />
          )}
        </section>

        {/* 趋势折线图 */}
        <section className="card">
          <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 14 }}>实时趋势（最近 {trend.length}/30 采样）</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Agent 数</div>
              <TrendLine data={trendAgents} color={ACCENT} height={80} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>会话记录</div>
              <TrendLine data={trendRecords} color="#a78bfa" height={80} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>模型实例</div>
              <TrendLine data={trendServers} color={WARN} height={80} />
            </div>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 6, display: "flex", gap: 10 }}>
            <span>🕐 {trend[0]?.t ?? "—"}</span>
            <span>→</span>
            <span>{trend[trend.length - 1]?.t ?? "—"}</span>
          </div>
        </section>
      </div>

      {/* Sidecar 表 */}
      <section className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0, fontSize: 14 }}>本地模型服务器（Sidecar）</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              <th style={{ padding: "4px 8px" }}>状态</th>
              <th style={{ padding: "4px 8px" }}>端口</th>
              <th style={{ padding: "4px 8px" }}>模型</th>
              <th style={{ padding: "4px 8px" }}>VRAM</th>
              <th style={{ padding: "4px 8px" }}>PID</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "6px 8px" }}>
                <span style={{ color: sidecar?.running ? "var(--success)" : DANGER, fontWeight: 700 }}>
                  {sidecar?.running ? "● 运行中" : "○ 未运行"}
                </span>
              </td>
              <td style={{ padding: "6px 8px" }}>{sidecar?.port ?? "—"}</td>
              <td style={{ padding: "6px 8px" }}>{sidecar?.model ?? "—"}</td>
              <td style={{ padding: "6px 8px" }}>{sidecar?.vram !== undefined ? `${sidecar.vram} GB` : "—"}</td>
              <td style={{ padding: "6px 8px" }}>{sidecar?.pid ?? "—"}</td>
            </tr>
          </tbody>
        </table>
        {servers.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, marginTop: 8 }}>
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
                  <td style={{ padding: "6px 8px", fontWeight: 600 }}>{s.role}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <span style={{ color: s.state === "ready" ? "var(--success)" : WARN }}>{s.state}</span>
                  </td>
                  <td style={{ padding: "6px 8px" }}>{s.port}</td>
                  <td style={{ padding: "6px 8px" }}>{s.model ?? "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{s.vram ? `${s.vram} GB` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 告警表 */}
      <section className="card" style={{ marginBottom: 14, borderColor: alarms.length > 0 ? "var(--danger-soft)" : undefined }}>
        <h3 style={{ marginTop: 0, fontSize: 14, color: alarms.length > 0 ? DANGER : undefined }}>
          告警（{alarms.length}）
        </h3>
        {alarms.length === 0 ? (
          <p style={{ color: "var(--text-dim)", fontSize: 12 }}>暂无告警</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
                <th style={{ padding: "4px 8px" }}>级别</th>
                <th style={{ padding: "4px 8px" }}>来源</th>
                <th style={{ padding: "4px 8px" }}>消息</th>
                <th style={{ padding: "4px 8px" }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {alarms.slice(-12).reverse().map((a) => (
                <tr key={a.seq} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 8px" }}>
                    <span style={{
                      color: a.severity === "critical" ? DANGER : a.severity === "warning" ? WARN : "var(--text-muted)",
                      fontWeight: 700,
                    }}>
                      {a.severity}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px" }}>{a.source}</td>
                  <td style={{ padding: "6px 8px", color: "var(--text)" }}>{a.message}</td>
                  <td style={{ padding: "6px 8px", color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                    {new Date(a.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 自动更新 */}
      <section className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0, fontSize: 14 }}>自动更新</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {updateStatus?.error && (
            <span style={{ color: DANGER, fontSize: 13 }}>检查失败: {updateStatus.error}</span>
          )}
          {isAvailable && (
            <span style={{ color: "var(--success)", fontSize: 13 }}>
              发现新版本: {updateStatus.version}（正在后台下载…）
            </span>
          )}
          {isDownloaded && (
            <span style={{ color: "var(--success)", fontSize: 13 }}>
              新版本已下载 ({updateStatus.version})
              <button onClick={handleInstallUpdate} className="btn sky" style={{ marginLeft: 10, fontSize: 12.5 }}>
                安装并重启
              </button>
            </span>
          )}
          {updateStatus?.status === "up-to-date" && (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>当前已是最新版本</span>
          )}
          {updateStatus?.status === "checking" && (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>正在检查更新...</span>
          )}
          {updateStatus?.status === "available" && updateStatus.releaseNotes && (
            <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>
              {updateStatus.releaseNotes}
            </span>
          )}
          <button onClick={handleCheckUpdate} className="btn" style={{ fontSize: 12.5 }}>
            手动检查
          </button>
        </div>
      </section>
    </div>
  );
}