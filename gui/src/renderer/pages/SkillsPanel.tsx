/**
 * gui/src/renderer/pages/SkillsPanel.tsx — 设置「技能库」专栏。
 * 从供应商界面剥离，独立管理：查看已装的技能、启用/停用（停用 = 目录移至 .disabled/ 下）。
 */
import React, { type JSX } from "react";
import type { SkillInfo } from "../../shared/ipc.js";

export default function SkillsPanel(): JSX.Element {
  const api = React.useRef<any>(null);
  const [skills, setSkills] = React.useState<SkillInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 3500);
  };

  const load = React.useCallback(async (): Promise<void> => {
    if (!api.current?.extras?.skillList) { return; }
    try {
      const list = await api.current.extras.skillList();
      setSkills(list);
    } catch (e) {
      console.error("[skills] list failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    void load();
  }, [load]);

  async function toggle(s: SkillInfo): Promise<void> {
    if (!api.current?.extras?.skillToggle) { return; }
    setBusy(s.name);
    try {
      const res = await api.current.extras.skillToggle(s.name, !s.enabled);
      if (res?.ok) {
        showNotice(true, `技能「${s.name}」已${s.enabled ? "停用" : "启用"}`);
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

  /** 打开技能目录（系统文件管理器） */
  async function openFolder(s: SkillInfo): Promise<void> {
    if (!api.current?.extras?.skillOpen) { return; }
    const res = await api.current.extras.skillOpen(s.name).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!res?.ok) {
      showNotice(false, res?.error ?? "打开失败");
    }
  }

  /** 打开技能根目录 config/skills（空列表时引导用户把技能放进来） */
  async function openSkillsRoot(): Promise<void> {
    if (!api.current?.extras?.skillsRootOpen) { return; }
    const res = await api.current.extras.skillsRootOpen().catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!res?.ok) {
      showNotice(false, res?.error ?? "打开失败");
    }
  }

  /** 删除技能（递归删除目录） */
  async function remove(s: SkillInfo): Promise<void> {
    if (!api.current?.extras?.skillDelete) { return; }
    if (!window.confirm(`确定删除技能「${s.name}」？其目录（含 manifest/SKILL.md）将被永久删除，不可恢复。`)) { return; }
    setBusy(s.name);
    try {
      const res = await api.current.extras.skillDelete(s.name);
      if (res?.ok) {
        showNotice(true, `技能「${s.name}」已删除`);
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

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ fontSize: 18, margin: 0, flex: 1 }}>技能库</h2>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          已启用 {enabledCount} / {skills.length}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 14 }}>
        技能位于 config/skills/ 目录（各技能含 manifest.yaml 与 SKILL.md）。停用会将技能目录移入
        .disabled/ 子目录，引擎不再加载；恢复后重新载入。
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
      ) : skills.length === 0 ? (
        <div className="card" style={{ padding: "18px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 12 }}>
            未发现技能。
            <br />
            技能目录位于 <code style={{ color: "var(--accent-hover)" }}>config/skills/</code>，
            每个技能含 <code>manifest.yaml</code> 与 <code>SKILL.md</code>。
            <br />
            点击下方按钮打开该文件夹，把技能复制进去即可自动识别。
          </div>
          <button className="btn primary" style={{ padding: "7px 16px", fontSize: 13 }} onClick={() => void openSkillsRoot()}>
            打开技能文件夹
          </button>
        </div>
      ) : (
        skills.map((s) => (
          <div key={s.name} className="card" style={{
            display: "flex", alignItems: "center", gap: 12, marginBottom: 8,
            padding: "10px 12px",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: s.enabled ? "var(--text)" : "var(--text-dim)" }}>
                {s.name}
                {!s.enabled && <span style={{ fontSize: 11, color: "var(--warning)", marginLeft: 6 }}>已停用</span>}
              </div>
              {s.description && (
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, wordBreak: "break-word" }}>
                  {s.description}
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                {s.hasManifest ? "manifest.yaml ✓" : "manifest 缺失"}
                {s.hasSkillMd ? " · SKILL.md ✓" : " · SKILL.md 缺失"}
              </div>
            </div>
            <button className={`btn${s.enabled ? "" : " primary"}`} style={{ padding: "4px 12px", fontSize: 12.5, flexShrink: 0 }}
              disabled={busy === s.name}
              onClick={() => void toggle(s)}>
              {busy === s.name ? "处理中…" : (s.enabled ? "停用" : "启用")}
            </button>
            <button className="btn" title="在文件管理器中打开该技能目录" style={{ padding: "4px 10px", fontSize: 12, flexShrink: 0 }}
              onClick={() => void openFolder(s)}>
              打开
            </button>
            <button className="btn" title="永久删除该技能（不可恢复）" style={{ padding: "4px 10px", fontSize: 12, flexShrink: 0, color: "#f87171" }}
              disabled={busy === s.name}
              onClick={() => void remove(s)}>
              删除
            </button>
          </div>
        ))
      )}
    </div>
  );
}