/**
 * gui/src/renderer/pages/RuntimePanel.tsx — 设置「运行环境」专栏（A-918++）。
 * 列出随包配套工具：Node / Python / Git / llama.cpp / 本地模型 的路径·版本·大小·就绪状态；
 * 图标用 gui/icon/icon_fpbc119q3rk 官方 SVG（非 emoji）；缺失项提供「下载/修复」动作。
 */
import React, { type JSX } from "react";
import nodeIcon from "../../../icon/icon_fpbc119q3rk/Nodejs.svg";
import pythonIcon from "../../../icon/icon_fpbc119q3rk/python.svg";
import gitIcon from "../../../icon/icon_fpbc119q3rk/git.svg";
import cpuIcon from "../../../icon/icon_fpbc119q3rk/cpu.svg";
import foldersIcon from "../../../icon/icon_fpbc119q3rk/folders.svg";

interface RuntimeItem {
  kind: "node" | "python" | "git" | "llama" | "models";
  label: string;
  path?: string;
  version?: string;
  sizeText?: string;
  ok: boolean;
  note?: string;
  source: string;
  action?: { label: string; kind: string; url?: string; path?: string; target?: string };
}

const KIND_META: Record<RuntimeItem["kind"], { icon: string; brief: string }> = {
  node: { icon: nodeIcon, brief: "Node.js 运行时" },
  python: { icon: pythonIcon, brief: "Python venv" },
  git: { icon: gitIcon, brief: "Git" },
  llama: { icon: cpuIcon, brief: "llama.cpp 本地推理" },
  models: { icon: foldersIcon, brief: "本地模型" },
};

/** SVG 单色图标 → 主题亮灰（配合深色 UI） */
const imgFilter: React.CSSProperties = { filter: "brightness(0) invert(0.72)", opacity: 0.95 };

export default function RuntimePanel(): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const [items, setItems] = React.useState<RuntimeItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  /** 成功/失败小提示（复用 error 区，加 ok 标记） */
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 4000);
  };
  // 下载中的 target（llama/bge）→ 按钮显示进度文案
  const [downloading, setDownloading] = React.useState<Record<string, number>>({});
  // A-918++：重建 venv 状态（长时间异步）
  const [rebuildingVenv, setRebuildingVenv] = React.useState(false);

  const load = React.useCallback(async (): Promise<void> => {
    if (!api?.runtime?.list) { setError("运行时 API 未就绪"); setLoading(false); return; }
    setLoading(true);
    setError("");
    try {
      const res = await api.runtime.list();
      if (res?.ok && Array.isArray(res.items)) { setItems(res.items); }
      else { setError(res?.error ?? "读取失败"); }
    } catch (e) {
      setError(`读取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    void (async () => {
      if (!(window as unknown as { slimeAPI?: any }).slimeAPI?.runtime?.list) { setTimeout(() => load(), 300); return; }
      await load();
    })();
  }, [load]);

  async function runAction(it: RuntimeItem): Promise<void> {
    if (!it.action) { return; }
    const a = it.action;
    // llama/bge → 内置下载器直接下载（复用 MindHubPanel 的 mind.download 链路）
    if (a.kind === "download" && a.target && api?.mind?.download) {
      const t = a.target;
      setDownloading((p) => ({ ...p, [t]: 0 }));
      const res = await api.mind.download(t).catch((e: unknown) => ({ ok: false, error: String(e) }));
      if (!res?.ok) { setError(res?.error ?? "下载启动失败"); }
      // 定时拉下载进度（2s 后停止轮询；完成由用户手动刷新）
      const t0 = Date.now();
      const poll = window.setInterval(() => {
        void (api.mind.downloadSnapshot?.(t) as Promise<{ percent?: number; done?: boolean }> | undefined)
          ?.then((s) => {
            setDownloading((p) => ({ ...p, [t]: s?.percent ?? p[t] }));
            if (Date.now() - t0 > 30000 || s?.done) { window.clearInterval(poll); }
          })
          .catch(() => window.clearInterval(poll));
      }, 1500);
      return;
    }
    // 其他动作（打开官网/目录）
    if (!api?.runtime?.open) { return; }
    const res = await api.runtime.open(a).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!res?.ok) { setError(res?.error ?? "动作失败"); }
  }

  /** A-918++：重建 Python venv（用户已装 Python 后一键重建） */
  async function rebuildVenv(): Promise<void> {
    if (!api?.runtime?.installPython) { setError("安装 Python API 未就绪"); return; }
    setRebuildingVenv(true);
    try {
      const res = await api.runtime.installPython().catch((e: unknown) => ({ ok: false, error: String(e), log: String(e) }));
      if (res?.ok) {
        showNotice(true, "Python venv 重建完成（已写入 requirements.txt 依赖）");
        await load();
      } else {
        setError(`venv 重建失败：${res?.error ?? "未知"}${res?.log ? `\n${res.log.slice(-600)}` : ""}`);
      }
    } finally {
      setRebuildingVenv(false);
    }
  }

  const renderAction = (it: RuntimeItem): JSX.Element | null => {
    if (it.ok || !it.action) { return null; }
    const a = it.action;
    const d = a.kind === "download" && a.target ? downloading[a.target] : undefined;
    const mainBtn = (
      <button className="btn primary" style={{ padding: "5px 14px", fontSize: 12, flexShrink: 0, whiteSpace: "nowrap" }}
        disabled={d !== undefined}
        onClick={() => void runAction(it)}>
        {d !== undefined ? (d > 0 ? `下载中 ${d}%` : "开始下载…") : a.label}
      </button>
    );
    // python 缺失额外加"重建 venv"次按钮（用户装好 Python 后用）
    if (it.kind === "python") {
      return (
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {mainBtn}
          <button className="btn" style={{ padding: "5px 14px", fontSize: 12, whiteSpace: "nowrap" }}
            disabled={rebuildingVenv}
            onClick={() => void rebuildVenv()}>
            {rebuildingVenv ? "重建中…" : "重建 venv"}
          </button>
        </div>
      );
    }
    return mainBtn;
  };

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ fontSize: 18, margin: 0, flex: 1 }}>运行环境</h2>
        <button className="btn" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => void load()}>
          刷新
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 14 }}>
        slime 依赖的配套工具一览。就绪状态、路径、大小与缺失时的下载入口。
      </div>

      {loading && <div style={{ color: "var(--text-dim)", fontSize: 13, padding: 12 }}>扫描运行环境中…</div>}
      {notice && !loading && (
        <div style={{ padding: "8px 12px", marginBottom: 12, fontSize: 12.5, borderRadius: 8, border: "1px solid var(--border)",
          background: notice.ok ? "var(--success-soft)" : "var(--danger-soft)", color: notice.ok ? "#22c55e" : "#f87171" }}>
          {notice.text}
        </div>
      )}
      {error && !loading && (
        <div style={{ padding: "8px 12px", marginBottom: 12, fontSize: 12.5, borderRadius: 8, border: "1px solid var(--border)", background: "var(--danger-soft)", color: "#f87171" }}>
          {error}
        </div>
      )}
      {!loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((it) => {
            const meta = KIND_META[it.kind];
            return (
              <div key={it.kind} className="card" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px" }}>
                <img src={meta.icon} alt={meta.brief} width={24} height={24} style={imgFilter} draggable={false} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>{it.label}</span>
                    {it.version && <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "Consolas, monospace" }}>{it.version}</span>}
                    <span style={{
                      fontSize: 11, padding: "1px 8px", borderRadius: 7, flexShrink: 0,
                      background: it.ok ? "rgba(0,200,120,.15)" : "var(--danger-soft)",
                      color: it.ok ? "#22c55e" : "#f87171", fontWeight: 600,
                    }}>
                      {it.ok ? "就绪" : "缺失"}
                    </span>
                    {!it.ok && it.source !== "missing" && (
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)" }}>{it.source}</span>
                    )}
                  </div>
                  {it.note && (
                    <div style={{ fontSize: 11, color: it.ok ? "var(--text-dim)" : "var(--warning)", marginTop: 3, lineHeight: 1.5 }}>{it.note}</div>
                  )}
                  {it.path && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3, fontFamily: "Consolas, monospace", wordBreak: "break-all", opacity: it.ok ? 1 : 0.75 }}>
                      {it.path}
                      {it.sizeText ? ` · ${it.sizeText}` : ""}
                    </div>
                  )}
                </div>
                {renderAction(it)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
