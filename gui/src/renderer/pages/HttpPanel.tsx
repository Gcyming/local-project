/**
 * gui/src/renderer/pages/HttpPanel.tsx — HTTP 静态服务搭建面板（A-918++）。
 * 选择本地目录 → 一键变成可访问的 HTTP 静态服务（默认 0.0.0.0，端口留空自动选）；
 * 支持 SPA fallback、运行中服务列表（地址复制 / 浏览器打开 / 请求计数 / 停止）、启动日志与错误显示。
 * 深色主题（CSS 变量 --bg/--border/--text/--accent）。
 */
import React, { type JSX } from "react";

interface HttpServerItem {
  id: string;
  dir: string;
  port: number;
  host: string;
  urls: string[];
  startedAt: number;
  requests: number;
}

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 10,
  marginBottom: 10,
  background: "var(--bg)",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text)",
  opacity: 0.7,
  marginBottom: 6,
  display: "block",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
  outline: "none",
};

const btnStyle: React.CSSProperties = {
  background: "var(--accent)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
  marginRight: 6,
  marginTop: 6,
};

const btnGhostStyle: React.CSSProperties = {
  ...btnStyle,
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border)",
};

export default function HttpPanel(_props: { workspace: string }): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const [dir, setDir] = React.useState<string>("");
  const [port, setPort] = React.useState<string>("");
  const [spa, setSpa] = React.useState<boolean>(false);
  const [servers, setServers] = React.useState<HttpServerItem[]>([]);
  const [error, setError] = React.useState<string>("");
  const [busy, setBusy] = React.useState<boolean>(false);
  const [log, setLog] = React.useState<string>("");

  const appendLog = React.useCallback((line: string): void => {
    setLog((prev) => `${prev ? prev + "\n" : ""}[${new Date().toLocaleTimeString()}] ${line}`);
  }, []);

  const refreshList = React.useCallback(async (): Promise<void> => {
    if (!api?.http?.list) { return; }
    try {
      const list = await api.http.list();
      setServers(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  React.useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const doServe = React.useCallback(async (): Promise<void> => {
    const d = dir.trim();
    if (!d) { setError("请填写要提供服务的目录路径"); return; }
    const p = port.trim();
    const portNum = p ? Number(p) : undefined;
    if (p && (!Number.isFinite(portNum) || (portNum as number) <= 0 || (portNum as number) > 65535)) {
      setError("端口需为 1-65535 之间的数字"); return;
    }
    setBusy(true);
    setError("");
    appendLog(`启动静态服务：目录=${d}${portNum ? ` 端口=${portNum}` : " 端口=自动"}${spa ? " SPA=true" : ""}`);
    try {
      const r = await api.http.serve({ dir: d, port: portNum, spa });
      if (r?.ok && r.urls) {
        appendLog(`已启动：id=${r.id} port=${r.port}`);
        r.urls.forEach((u: string) => appendLog(`  ↳ ${u}`));
        void refreshList();
      } else {
        const msg = r?.error ?? "启动失败";
        setError(msg);
        appendLog(`失败：${msg}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      appendLog(`异常：${msg}`);
    } finally {
      setBusy(false);
    }
  }, [api, dir, port, spa, appendLog, refreshList]);

  const doStop = React.useCallback(async (id: string): Promise<void> => {
    if (!api?.http?.stop) { return; }
    try {
      const r = await api.http.stop(id);
      if (!r?.ok) { setError(r?.error ?? "停止失败"); }
      else { appendLog(`已停止：${id}`); }
      void refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, appendLog, refreshList]);

  const doOpen = React.useCallback(async (url: string): Promise<void> => {
    if (!api?.http?.open) { return; }
    try {
      const r = await api.http.open(url);
      if (!r?.ok) { setError(r?.error ?? "打开失败"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  const doCopy = React.useCallback(async (url: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(url);
      appendLog(`已复制：${url}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [appendLog]);

  return (
    <div style={{ padding: 12, height: "100%", overflowY: "auto", color: "var(--text)", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>HTTP 静态服务搭建</strong>
        <button style={btnGhostStyle} disabled={busy} onClick={() => { void refreshList(); }}>
          {busy ? "···" : "刷新"}
        </button>
      </div>

      {/* 启动配置 */}
      <div style={sectionStyle}>
        <label style={labelStyle}>目录（要对外提供服务的本地文件夹路径）</label>
        <input style={inputStyle} placeholder="如 D:/pilot project/dist 或 /home/user/site" value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { void doServe(); } }} />

        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>端口（留空=自动从 8080 起选空闲端口）</label>
            <input style={inputStyle} placeholder="8080" value={port}
              onChange={(e) => setPort(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { void doServe(); } }} />
          </div>
          <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, marginTop: 18, cursor: "pointer" }}>
            <input type="checkbox" checked={spa} onChange={(e) => setSpa(e.target.checked)} />
            SPA 回退
          </label>
        </div>

        <button style={btnStyle} disabled={busy || !dir.trim()} onClick={() => { void doServe(); }}>
          {busy ? "启动中…" : "启动服务"}
        </button>
      </div>

      {/* 运行中服务列表 */}
      <div style={sectionStyle}>
        <label style={labelStyle}>运行中的服务（{servers.length}）</label>
        {servers.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>暂无运行中的服务（填好目录后点「启动服务」）</div>}
        {servers.map((s) => (
          <div key={s.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.8, wordBreak: "break-all", marginBottom: 4 }}>
              <strong>{s.dir}</strong>
            </div>
            <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 6 }}>id={s.id} · 端口 {s.port} · 请求 {s.requests}</div>
            {s.urls.map((u) => (
              <div key={u} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <a href={u} onClick={(e) => { e.preventDefault(); void doOpen(u); }}
                  style={{ color: "var(--accent)", fontSize: 13, textDecoration: "none", wordBreak: "break-all", flex: 1 }}>
                  {u}
                </a>
                <button style={{ ...btnGhostStyle, margin: 0, padding: "2px 8px", fontSize: 12 }} onClick={() => { void doCopy(u); }}>复制</button>
                <button style={{ ...btnGhostStyle, margin: 0, padding: "2px 8px", fontSize: 12 }} onClick={() => { void doOpen(u); }}>打开</button>
              </div>
            ))}
            <button style={{ ...btnGhostStyle, marginTop: 4, padding: "3px 10px", fontSize: 12 }} onClick={() => { void doStop(s.id); }}>停止</button>
          </div>
        ))}
      </div>

      {/* 启动日志 */}
      {log && (
        <div style={sectionStyle}>
          <label style={labelStyle}>启动日志</label>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12, maxHeight: 180, overflowY: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 8, margin: 0, color: "var(--text)", opacity: 0.9 }}>
            {log}
          </pre>
        </div>
      )}

      {error && (
        <div style={{ color: "#ff6b6b", fontSize: 12, marginTop: 4, whiteSpace: "pre-wrap" }}>{error}</div>
      )}
    </div>
  );
}
