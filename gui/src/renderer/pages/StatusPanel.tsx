/**
 * gui/src/renderer/pages/StatusPanel.tsx — 状态面板骨架。
 * - sidecar 状态 / 当前模型 / VRAM
 * - Agent 统计
 * - 全链路耗时 + 告警
 * - 3s 轮询 → slime:stats:update 推送
 * - 自动更新状态（发现新版本/已下载/手动检查）
 */
import React, { type JSX } from "react";
import type { StatsSnapshot, SidecarStatus } from "../../shared/ipc.js";

interface UpdateStatus {
  status: string;
  version?: string;
  releaseNotes?: string;
  error?: string;
}

export default function StatusPanel(): JSX.Element {
  const [stats, setStats] = React.useState<StatsSnapshot | null>(null);
  const [sidecar, setSidecar] = React.useState<SidecarStatus | null>(null);
  const [updateStatus, setUpdateStatus] = React.useState<UpdateStatus | null>(null);
  const api = React.useRef<any>(null);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (!api.current) {
      return;
    }
    void api.current.stats.snapshot().then(setStats);
    void api.current.sidecar.status().then(setSidecar);
    // 初始检查更新状态
    void api.current.update.check().then(setUpdateStatus);
    const offPoll = api.current.stats.onPoll((snap: StatsSnapshot) => setStats(snap));
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
  const alarms = stats?.alarms ?? [];
  const isAvailable = updateStatus?.status === "available";
  const isDownloaded = updateStatus?.status === "downloaded";

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>运行状态</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section>
          <h3 style={{ fontSize: 14, color: "#94a388" }}>Sidecar / 模型</h3>
          <p>运行中: {sidecar?.running ? "✅" : "❌"}</p>
          <p>端口: {sidecar?.port ?? "—"}</p>
          <p>模型: {sidecar?.model ?? "—"}</p>
          <p>VRAM: {sidecar?.vram !== undefined ? `${sidecar.vram} GB` : "—"}</p>
          <p>PID: {sidecar?.pid ?? "—"}</p>
        </section>
        <section>
          <h3 style={{ fontSize: 14, color: "#94a388" }}>Agent 统计</h3>
          <p>总数: {agents.total}</p>
          <p>根: {agents.roots} / 叶: {agents.leaves} / 最大深度: {agents.maxDepth}</p>
          <p>生命周期: {JSON.stringify(agents.byLifecycle)}</p>
        </section>
        <section>
          <h3 style={{ fontSize: 14, color: "#94a388" }}>会话</h3>
          <p>总记录: {stats?.sessions.totalRecords ?? 0}</p>
          <p>24h 活跃: {stats?.sessions.recent ?? 0}</p>
        </section>
        <section>
          <h3 style={{ fontSize: 14, color: "#94a388" }}>服务器实例</h3>
          {servers.length === 0 ? (
            <p style={{ color: "#64748a" }}>无实例</p>
          ) : (
            servers.map((s) => (
              <p key={s.role}>
                {s.role}: {s.state} @ {s.port}
              </p>
            ))
          )}
        </section>
      </div>
      {alarms.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 14, color: "#f87171" }}>告警 ({alarms.length})</h3>
          <ul style={{ fontSize: 13, color: "#fca5a5" }}>
            {alarms.slice(-10).map((a) => (
              <li key={a.seq}>
                [{a.severity}] {a.source}: {a.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 自动更新状态 */}
      <section style={{ marginTop: 16, padding: 12, background: "#1e293b", borderRadius: 6 }}>
        <h3 style={{ fontSize: 14, color: "#94a388" }}>自动更新</h3>
        {updateStatus?.error && (
          <p style={{ color: "#f87171", fontSize: 13 }}>检查失败: {updateStatus.error}</p>
        )}
        {isAvailable && (
          <div>
            <p style={{ color: "#34d399", fontSize: 13 }}>
              发现新版本: {updateStatus.version}
            </p>
            {updateStatus.releaseNotes && (
              <p style={{ fontSize: 12, color: "#94a388", whiteSpace: "pre-wrap" }}>
                {updateStatus.releaseNotes}
              </p>
            )}
            <button
              onClick={handleInstallUpdate}
              style={{
                marginTop: 8,
                padding: "6px 16px",
                background: "#0ea5e9",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              安装并重启
            </button>
          </div>
        )}
        {isDownloaded && (
          <p style={{ color: "#34d399", fontSize: 13 }}>
            新版本已下载 ({updateStatus.version})，重启后安装
          </p>
        )}
        {updateStatus?.status === "up-to-date" && (
          <p style={{ color: "#64748a", fontSize: 13 }}>当前已是最新版本</p>
        )}
        {updateStatus?.status === "checking" && (
          <p style={{ color: "#64748a", fontSize: 13 }}>正在检查更新...</p>
        )}
        <button
          onClick={handleCheckUpdate}
          style={{
            marginTop: 8,
            padding: "4px 12px",
            background: "#334155",
            color: "#e2e8f0",
            border: "1px solid #475569",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          手动检查
        </button>
      </section>
    </div>
  );
}
