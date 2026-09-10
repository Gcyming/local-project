/**
 * gui/src/renderer/pages/AdbPanel.tsx — ADB 设备管理面板（A-918++）。
 * 设备列表（serial/型号/状态，点击选中）、无线连接、shell 命令、安装 APK、截图预览、reboot；
 * adb 缺失时显示「下载 platform-tools」按钮并实时展示进度。深色主题（CSS 变量 --bg/--border/--text/--accent）。
 */
import React, { type JSX } from "react";

interface AdbDeviceItem {
  serial: string;
  state: string;
  model?: string;
  product?: string;
}

interface AdbDetectInfo {
  ok: boolean;
  path?: string;
  version?: string;
  source?: string;
  error?: string;
}

interface AdbDownloadProgress {
  state: "downloading" | "extracting" | "done" | "error";
  percent: number;
  receivedMB: number;
  totalMB: number;
  error?: string;
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

export default function AdbPanel(_props: { workspace: string }): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const [detect, setDetect] = React.useState<AdbDetectInfo | null>(null);
  const [devices, setDevices] = React.useState<AdbDeviceItem[]>([]);
  const [selectedSerial, setSelectedSerial] = React.useState<string>("");
  const [connectHost, setConnectHost] = React.useState<string>("");
  const [shellCmd, setShellCmd] = React.useState<string>("");
  const [shellOut, setShellOut] = React.useState<string>("");
  const [installPath, setInstallPath] = React.useState<string>("");
  const [screenshot, setScreenshot] = React.useState<string>("");
  const [error, setError] = React.useState<string>("");
  const [busy, setBusy] = React.useState<boolean>(false);
  const [downloading, setDownloading] = React.useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = React.useState<AdbDownloadProgress | null>(null);

  const doDetect = React.useCallback(async (): Promise<void> => {
    if (!api?.adb?.detect) { return; }
    try {
      const d = await api.adb.detect();
      setDetect(d);
      if (d?.ok) { void refreshDevices(); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  const refreshDevices = React.useCallback(async (): Promise<void> => {
    if (!api?.adb?.devices) { return; }
    setBusy(true);
    setError("");
    try {
      const r = await api.adb.devices();
      if (r?.ok) {
        setDevices(r.devices ?? []);
        if (!selectedSerial && (r.devices ?? []).length > 0) {
          setSelectedSerial((r.devices as AdbDeviceItem[])[0].serial);
        }
      } else {
        setError(r?.error ?? "读取设备列表失败");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, selectedSerial]);

  React.useEffect(() => {
    void doDetect();
  }, [doDetect]);

  // A-918++：下载进度监听（主进程 → 渲染层）
  React.useEffect(() => {
    const cleanup = api?.adb?.onDownloadProgress?.((p: AdbDownloadProgress) => {
      setDownloadProgress(p);
      if (p.state === "done" || p.state === "error") {
        setDownloading(false);
        if (p.state === "done") { void doDetect(); }
        else { setError(p.error ?? "下载失败"); }
      }
    });
    return () => { cleanup?.(); };
  }, [api, doDetect]);

  const doConnect = React.useCallback(async (): Promise<void> => {
    const h = connectHost.trim();
    if (!h) { setError("请填写连接地址（IP:端口）"); return; }
    setBusy(true);
    setError("");
    try {
      const r = await api.adb.connect(h);
      if (r?.ok) { setConnectHost(""); void refreshDevices(); }
      else { setError(r?.error ?? "连接失败"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, connectHost, refreshDevices]);

  const doDisconnect = React.useCallback(async (): Promise<void> => {
    const h = connectHost.trim();
    if (!h) { setError("请填写要断开的地址"); return; }
    setBusy(true);
    try {
      const r = await api.adb.disconnect(h);
      if (r?.ok) { void refreshDevices(); }
      else { setError(r?.error ?? "断开失败"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, connectHost, refreshDevices]);

  const doShell = React.useCallback(async (): Promise<void> => {
    if (!selectedSerial) { setError("请先选中一个设备"); return; }
    const c = shellCmd.trim();
    if (!c) { setError("请输入 shell 命令"); return; }
    setBusy(true);
    setShellOut("");
    try {
      const r = await api.adb.shell(selectedSerial, c);
      if (r?.ok) { setShellOut((r.stdout ?? "") + (r.stderr ?? "")); }
      else { setShellOut(""); setError(r?.error ?? "执行失败"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, selectedSerial, shellCmd]);

  const pickApk = React.useCallback(async (): Promise<void> => {
    try {
      const r = await api?.files?.pick?.();
      if (r?.ok && r.path) { setInstallPath(r.path); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  const doInstall = React.useCallback(async (): Promise<void> => {
    if (!selectedSerial) { setError("请先选中一个设备"); return; }
    if (!installPath) { setError("请先选择 APK 文件"); return; }
    setBusy(true);
    setError("");
    try {
      const r = await api.adb.install(selectedSerial, installPath);
      if (!r?.ok) { setError(r?.error ?? "安装失败"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, selectedSerial, installPath]);

  const doScreencap = React.useCallback(async (): Promise<void> => {
    if (!selectedSerial) { setError("请先选中一个设备"); return; }
    setBusy(true);
    setScreenshot("");
    setError("");
    try {
      const r = await api.adb.screencap(selectedSerial);
      if (r?.ok && r.pngBase64) { setScreenshot(`data:image/png;base64,${r.pngBase64}`); }
      else { setError(r?.error ?? "截图失败"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, selectedSerial]);

  const doReboot = React.useCallback(async (): Promise<void> => {
    if (!selectedSerial) { setError("请先选中一个设备"); return; }
    setBusy(true);
    setError("");
    try {
      const r = await api.adb.reboot(selectedSerial);
      if (!r?.ok) { setError(r?.error ?? "重启失败"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, selectedSerial]);

  const doDownload = React.useCallback(async (): Promise<void> => {
    if (!api?.adb?.download) { return; }
    setDownloading(true);
    setDownloadProgress({ state: "downloading", percent: 0, receivedMB: 0, totalMB: 0 });
    setError("");
    try {
      const r = await api.adb.download();
      if (!r?.ok) { setDownloading(false); setError(r?.error ?? "下载失败"); }
    } catch (e) {
      setDownloading(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  return (
    <div style={{ padding: 12, height: "100%", overflowY: "auto", color: "var(--text)", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>ADB 设备管理</strong>
        <button style={btnGhostStyle} disabled={busy} onClick={() => { void doDetect(); void refreshDevices(); }}>
          {busy ? "···" : "刷新"}
        </button>
      </div>

      {/* 检测状态 / 缺失引导 */}
      {detect && !detect.ok && (
        <div style={{ ...sectionStyle, borderColor: "var(--accent)" }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>未检测到 adb（{detect.error ?? "缺失 platform-tools"}）</div>
          <button style={btnStyle} disabled={downloading} onClick={() => { void doDownload(); }}>
            {downloading ? "下载中…" : "下载 platform-tools"}
          </button>
          {downloadProgress && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
                {downloadProgress.state === "extracting" ? "解压中…" : downloadProgress.state === "done" ? "完成" : `${downloadProgress.percent}%  (${downloadProgress.receivedMB} / ${downloadProgress.totalMB} MB)`}
              </div>
              <div style={{ height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${downloadProgress.percent}%`, height: "100%", background: "var(--accent)" }} />
              </div>
            </div>
          )}
        </div>
      )}
      {detect && detect.ok && (
        <div style={{ ...sectionStyle, fontSize: 12, opacity: 0.85 }}>
          adb 就绪：v{detect.version ?? "?"}（{detect.source ?? "unknown"}）
        </div>
      )}

      {/* 无线连接 */}
      <div style={sectionStyle}>
        <label style={labelStyle}>无线连接（IP:端口，如 192.168.1.10:5555）</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input style={inputStyle} placeholder="192.168.1.10:5555" value={connectHost} onChange={(e) => setConnectHost(e.target.value)} />
          <button style={btnStyle} disabled={busy} onClick={() => { void doConnect(); }}>连接</button>
          <button style={btnGhostStyle} disabled={busy} onClick={() => { void doDisconnect(); }}>断开</button>
        </div>
      </div>

      {/* 设备列表 */}
      <div style={sectionStyle}>
        <label style={labelStyle}>设备列表</label>
        {devices.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>暂无设备（插上 USB / 无线连接后点刷新）</div>}
        {devices.map((d) => (
          <div
            key={d.serial}
            onClick={() => setSelectedSerial(d.serial)}
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "6px 8px", borderRadius: 6, cursor: "pointer", marginBottom: 4,
              background: selectedSerial === d.serial ? "var(--accent-soft)" : "transparent",
              border: `1px solid ${selectedSerial === d.serial ? "var(--accent)" : "var(--border)"}`,
            }}
          >
            <span style={{ fontSize: 13 }}>
              <strong>{d.serial}</strong>
              {d.model ? ` · ${d.model}` : ""}
            </span>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{d.state}</span>
          </div>
        ))}
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          当前选中：{selectedSerial || "（未选中）"}
        </div>
      </div>

      {/* shell */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Shell 命令（作用于选中设备）</label>
        <input style={inputStyle} placeholder="如 pm list packages" value={shellCmd} onChange={(e) => setShellCmd(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { void doShell(); } }} />
        <button style={btnStyle} disabled={busy} onClick={() => { void doShell(); }}>执行</button>
        <pre style={{ marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12, maxHeight: 160, overflowY: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 8, marginBottom: 0 }}>
          {shellOut || "（输出区）"}
        </pre>
      </div>

      {/* 安装 / 截图 / 重启 */}
      <div style={sectionStyle}>
        <label style={labelStyle}>安装 APK</label>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input style={inputStyle} placeholder="APK 路径" value={installPath} onChange={(e) => setInstallPath(e.target.value)} readOnly />
          <button style={btnGhostStyle} onClick={() => { void pickApk(); }}>选择</button>
          <button style={btnStyle} disabled={busy} onClick={() => { void doInstall(); }}>安装</button>
        </div>
        <div style={{ marginTop: 8 }}>
          <button style={btnStyle} disabled={busy} onClick={() => { void doScreencap(); }}>截图</button>
          <button style={btnGhostStyle} disabled={busy} onClick={() => { void doReboot(); }}>重启</button>
        </div>
        {screenshot && (
          <img src={screenshot} alt="screenshot" style={{ marginTop: 8, maxWidth: "100%", borderRadius: 6, border: "1px solid var(--border)" }} />
        )}
      </div>

      {error && (
        <div style={{ color: "#ff6b6b", fontSize: 12, marginTop: 4, whiteSpace: "pre-wrap" }}>{error}</div>
      )}
    </div>
  );
}
