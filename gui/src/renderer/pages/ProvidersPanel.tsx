/**
 * gui/src/renderer/pages/ProvidersPanel.tsx — 模型供应商管理。
 * - Provider/本地模型卡片：简洁摘要；全部编辑/调试参数收敛在弹窗内
 * - 添加/编辑弹窗（向导式）：
 *   ① 接入协议选择（OpenAI 兼容自动探测 / 手动指定模型）
 *   ② 填 Base URL + API Key → 自动探测模型列表并预选默认选项
 *   ③ 每模型调上下文/最大输出/视觉 + 默认模型
 *   ④ 折叠区：参数文件调试（slime.toml / 全局配置 / MCP / 技能库）内嵌于弹窗
 */
import React, { type JSX } from "react";
import type { ProviderSummary, ModelSpec, ConfigOverview, ConfigFileInfo, SkillInfo, McpServerInfo, LocalModelSpec } from "../../shared/ipc.js";

interface DraftModel extends ModelSpec { selected: boolean; }

type EditMode = "api-add" | "api-edit" | "local-add" | "local-edit";
type Proto = "openai" | "manual";

interface EditState {
  mode: EditMode;
  key: string;
  name: string;
  api_base: string;
  api_key: string;
  model: string;
  models: DraftModel[];
  proto: Proto;
  manualIds: string;
  localPath: string;
  localLabel: string;
  ctx_len: string;
  gpu_layers: string;
  max_output: string;
  vision: boolean;
}

function emptyEdit(): EditState {
  return {
    mode: "api-add", key: "", name: "", api_base: "", api_key: "", model: "",
    models: [], proto: "openai", manualIds: "",
    localPath: "", localLabel: "", ctx_len: "", gpu_layers: "", max_output: "", vision: false,
  };
}

export default function ProvidersPanel(): JSX.Element {
  const api = React.useRef<any>(null);
  const [providers, setProviders] = React.useState<ProviderSummary[]>([]);
  const [localModels, setLocalModels] = React.useState<LocalModelSpec[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  /* 编辑弹窗 */
  const [edit, setEdit] = React.useState<EditState | null>(null);
  const [fetching, setFetching] = React.useState(false);
  const [scanDir, setScanDir] = React.useState("");
  const [scanned, setScanned] = React.useState<Array<{ path: string; label: string }> | null>(null);

  /* 弹窗内：参数文件调试折叠区 */
  const [debugOpen, setDebugOpen] = React.useState(false);
  const [overview, setOverview] = React.useState<ConfigOverview | null>(null);
  const [activeFile, setActiveFile] = React.useState<string>("slime.toml");
  const [fileContent, setFileContent] = React.useState("");
  const [fileDirty, setFileDirty] = React.useState(false);

  function showNotice(ok: boolean, text: string): void {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 5000);
  }

  const refreshAll = React.useCallback(async (): Promise<void> => {
    if (!api.current) { return; }
    try {
      const [ps, ls] = await Promise.all([
        api.current.providers.list(),
        api.current.providers.localList(),
      ]);
      setProviders(ps);
      setLocalModels(ls);
    } catch (e) {
      console.error("[providers] list failed:", e);
    }
  }, []);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (api.current) {
      void refreshAll();
    }
  }, [refreshAll]);

  /** 弹窗打开时预载配置文件概览（供内嵌调试区） */
  React.useEffect(() => {
    if (edit && api.current && !overview) {
      void api.current.config.overview().then(setOverview).catch(console.error);
    }
  }, [edit, overview]);

  const loadFile = React.useCallback(async (name: string): Promise<void> => {
    if (!api.current) { return; }
    const res = await api.current.config.read(name);
    if (res.ok) {
      setFileContent(res.content ?? "");
      setFileDirty(false);
    } else {
      setFileContent("");
      showNotice(false, res.error ?? "读取失败");
    }
  }, []);

  React.useEffect(() => {
    if (edit && debugOpen && overview) {
      void loadFile(activeFile);
    }
  }, [edit, debugOpen, activeFile, overview, loadFile]);

  /* ── 弹窗操作 ── */

  function openApiAdd(): void {
    setEdit({ ...emptyEdit(), mode: "api-add" });
  }

  function openApiEdit(p: ProviderSummary): void {
    setEdit({
      mode: "api-edit", key: p.key, name: p.key,
      api_base: p.api_base, api_key: "", model: p.model ?? "",
      models: p.models.map((m) => ({ ...m, selected: true })),
      proto: "openai", manualIds: p.models.map((m) => m.id).join("\n"),
      localPath: "", localLabel: "", ctx_len: "", gpu_layers: "", max_output: "", vision: false,
    });
  }

  function openLocalAdd(): void {
    setEdit({ ...emptyEdit(), mode: "local-add" });
  }

  function openLocalEdit(m: LocalModelSpec): void {
    setEdit({
      mode: "local-edit", key: m.id, name: m.id,
      api_base: "", api_key: "", model: "",
      models: [], proto: "openai", manualIds: "",
      localPath: m.path, localLabel: m.label,
      ctx_len: m.ctx_len ? String(m.ctx_len) : "",
      gpu_layers: m.gpu_layers !== undefined ? String(m.gpu_layers) : "",
      max_output: m.max_output ? String(m.max_output) : "",
      vision: m.vision === true,
    });
  }

  async function handleFetchModels(): Promise<void> {
    if (!api.current || !edit || !edit.api_base.trim() || !edit.api_key.trim()) {
      showNotice(false, "请先填写 Base URL 与 API Key");
      return;
    }
    setFetching(true);
    try {
      const res = await api.current.providers.fetchModels(edit.api_base.trim(), edit.api_key.trim());
      if (res.ok && res.models) {
        const models = res.models.map((m: ModelSpec) => ({ ...m, selected: true }));
        setEdit({ ...edit, models, proto: "openai", model: edit.model || res.models[0]?.id || "" });
        showNotice(true, `探测成功：发现 ${res.models.length} 个模型，已自动勾选，默认使用第一个「${res.models[0]?.id ?? ""}」（可改）`);
      } else {
        setEdit({ ...edit, models: [] });
        showNotice(false, res.error ?? "获取失败");
      }
    } catch (e) {
      showNotice(false, `获取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetching(false);
    }
  }

  /** 手动模式：文本行 → 模型草稿（每行一个模型 ID） */
  function applyManualIds(): void {
    if (!edit) { return; }
    const ids = edit.manualIds.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const merged: DraftModel[] = ids.map((id) => {
      const prev = edit.models.find((m) => m.id === id);
      return prev ?? { id, selected: true };
    });
    setEdit({ ...edit, models: merged, model: edit.model || merged[0]?.id || "" });
  }

  function updateDraftModel(index: number, patch: Partial<DraftModel>): void {
    if (!edit) { return; }
    setEdit({
      ...edit,
      models: edit.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    });
  }

  async function handlePickLocal(): Promise<void> {
    if (!api.current) { return; }
    const res = await api.current.providers.localPick();
    if (res.ok && res.path) {
      setEdit((prev) => prev ? { ...prev, localPath: res.path, localLabel: prev.localLabel || (res.path.split(/[\\/]/).pop() ?? res.path) } : prev);
      setScanned(null);
    } else if (res.error && res.error !== "已取消选择") {
      showNotice(false, res.error);
    }
  }

  async function handleScanDir(): Promise<void> {
    if (!api.current || !scanDir.trim()) { return; }
    setFetching(true);
    try {
      const res = await api.current.providers.localScan(scanDir.trim());
      if (res.ok && res.models) {
        setScanned(res.models);
        showNotice(true, `目录中发现 ${res.models.length} 个 GGUF 模型`);
      } else {
        setScanned([]);
        showNotice(false, res.error ?? "扫描失败");
      }
    } finally {
      setFetching(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!api.current || !edit) { return; }
    if (edit.proto === "manual") {
      applyManualIds();
    }
    setLoading(true);
    try {
      const isLocal = edit.mode === "local-add" || edit.mode === "local-edit";
      if (isLocal) {
        const res = await api.current.providers.localSave({
          id: edit.name.trim(),
          path: edit.localPath.trim(),
          label: edit.localLabel.trim() || undefined,
          ctx_len: edit.ctx_len ? Number(edit.ctx_len) : undefined,
          gpu_layers: edit.gpu_layers !== "" ? Number(edit.gpu_layers) : undefined,
          max_output: edit.max_output ? Number(edit.max_output) : undefined,
          vision: edit.vision,
        });
        if (res.ok) {
          showNotice(true, `已保存本地模型「${edit.name}」`);
          setEdit(null);
          await refreshAll();
        } else {
          showNotice(false, res.error ?? "保存失败");
        }
        return;
      }
      const models = edit.models.filter((m) => m.selected).map((m) => ({
        id: m.id,
        context_window: m.context_window || undefined,
        max_output: m.max_output || undefined,
        vision: m.vision === true,
      }));
      const res = await api.current.providers.save({
        key: edit.name.trim(),
        api_base: edit.api_base.trim(),
        api_key: edit.api_key.trim() || undefined,
        model: edit.model || null,
        models,
      });
      if (res.ok) {
        showNotice(true, `已保存供应商「${edit.name}」并热更新 → ${res.path ?? ""}`);
        setEdit(null);
        await refreshAll();
      } else {
        showNotice(false, res.error ?? "保存失败");
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveApi(key: string): Promise<void> {
    if (!api.current) { return; }
    if (!window.confirm(`删除供应商「${key}」？\n（Agent 的 model_choice 若引用该 key 将失效）`)) { return; }
    setLoading(true);
    try {
      const res = await api.current.providers.remove(key);
      showNotice(res.ok, res.ok ? `已删除「${key}」` : (res.error ?? "删除失败"));
      await refreshAll();
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveLocal(id: string): Promise<void> {
    if (!api.current) { return; }
    if (!window.confirm(`删除本地模型「${id}」？`)) { return; }
    setLoading(true);
    try {
      const res = await api.current.providers.localRemove(id);
      showNotice(res.ok, res.ok ? `已删除「${id}」` : (res.error ?? "删除失败"));
      await refreshAll();
    } finally {
      setLoading(false);
    }
  }

  /* ── 弹窗内调试区操作 ── */

  async function handleSaveFile(): Promise<void> {
    if (!api.current) { return; }
    const res = await api.current.config.write(activeFile, fileContent);
    showNotice(res.ok, res.ok ? `已保存 ${activeFile}（备份 .bak）` : (res.error ?? "保存失败"));
    if (res.ok) {
      setFileDirty(false);
      const ov = await api.current.config.overview();
      setOverview(ov);
    }
  }

  const writableFiles = (overview?.files ?? []).filter((f) => f.writable);
  const readonlyFiles = (overview?.files ?? []).filter((f) => !f.writable);

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, margin: 0, flex: 1 }}>模型供应商</h2>
        <button className="btn sky" onClick={openLocalAdd} style={{ fontSize: 13 }}>＋ 本地模型</button>
        <button className="btn primary" onClick={openApiAdd} style={{ fontSize: 13 }}>＋ API 供应商</button>
      </div>

      {notice && (
        <div style={{
          padding: "8px 12px", marginBottom: 12, fontSize: 12, lineHeight: 1.5, wordBreak: "break-all",
          borderRadius: 8, border: "1px solid var(--border)",
          background: notice.ok ? "var(--success-soft)" : "var(--danger-soft)",
          color: notice.ok ? "var(--success)" : "#f87171",
        }}>
          {notice.text}
        </div>
      )}

      {/* ── 编辑弹窗（向导式：协议 → 连接信息 → 模型 → 参数文件调试） ── */}
      {edit && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(2, 6, 23, 0.66)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { setEdit(null); } }}>
          <div className="card" style={{ width: 680, maxWidth: "94vw", maxHeight: "88vh", overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0, flex: 1 }}>
                {edit.mode === "api-add" && "添加 API 供应商"}
                {edit.mode === "api-edit" && `编辑供应商「${edit.key}」`}
                {edit.mode === "local-add" && "添加本地模型"}
                {edit.mode === "local-edit" && `编辑本地模型「${edit.key}」`}
              </h3>
              <button className="titlebar-btn" onClick={() => setEdit(null)} title="关闭">✕</button>
            </div>

            {edit.mode === "api-add" || edit.mode === "api-edit" ? (
              <>
                {/* ① 接入协议 */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>接入协议</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {([
                      { v: "openai" as Proto, label: "OpenAI 兼容（自动探测模型）", hint: "填写后点「获取模型列表」自动拉取并预选默认" },
                      { v: "manual" as Proto, label: "手动指定（不探测）", hint: "网关/代理等无 /models 接口时手动填模型 ID" },
                    ]).map((o) => (
                      <button key={o.v}
                        className={`btn${edit.proto === o.v ? " primary" : ""}`}
                        style={{ fontSize: 12, padding: "4px 12px" }}
                        title={o.hint}
                        onClick={() => setEdit({ ...edit, proto: o.v })}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ② 连接信息 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, marginBottom: 10 }}>
                  <input className="input-field" placeholder="名称（如 deepseek，将作为 api:<名称>）" value={edit.name}
                    disabled={edit.mode === "api-edit"}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                  <input className="input-field" placeholder="Base URL（https://api.example.com）" value={edit.api_base}
                    onChange={(e) => setEdit({ ...edit, api_base: e.target.value })} />
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <input className="input-field" type="password"
                    placeholder={edit.mode === "api-edit" ? "API Key（留空则保留已配置密钥）" : "API Key（加密存储，不回显）"}
                    value={edit.api_key}
                    onChange={(e) => setEdit({ ...edit, api_key: e.target.value })} />
                  {edit.proto === "openai" && (
                    <button className="btn" onClick={handleFetchModels} disabled={fetching} style={{ whiteSpace: "nowrap" }}>
                      {fetching ? "获取中…" : "获取模型列表"}
                    </button>
                  )}
                </div>

                {/* ③ 模型调试 */}
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
                    模型调试（勾选可用 · 调上下文/输出/视觉 · 选中默认模型）
                  </div>
                  {edit.proto === "manual" ? (
                    <>
                      <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 4 }}>
                        每行一个模型 ID（如 gpt-4o / deepseek-chat），切换为手动后生效
                      </div>
                      <textarea value={edit.manualIds} spellCheck={false}
                        onChange={(e) => setEdit({ ...edit, manualIds: e.target.value })}
                        onBlur={() => applyManualIds()}
                        placeholder={"deepseek-chat\ndeepseek-reasoner"}
                        style={{
                          width: "100%", height: 64, padding: 8, boxSizing: "border-box",
                          borderRadius: 8, border: "1px solid var(--border-hover)",
                          background: "var(--bg-input)", color: "var(--text)",
                          fontSize: 12.5, fontFamily: "Consolas, monospace", outline: "none", resize: "vertical",
                        }} />
                    </>
                  ) : edit.models.length === 0 ? (
                    <div style={{ color: "var(--text-dim)", fontSize: 12.5, padding: "6px 0 10px" }}>
                      未获取模型列表 — 填写 Base URL 与 API Key 后点击"获取模型列表"，自动探测并预选默认选项
                    </div>
                  ) : (
                    <div style={{ maxHeight: 240, overflowY: "auto", marginBottom: 10 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
                            <th style={{ padding: "4px 8px" }}>启用</th>
                            <th style={{ padding: "4px 8px" }}>模型 ID</th>
                            <th style={{ padding: "4px 8px", width: 110 }}>上下文</th>
                            <th style={{ padding: "4px 8px", width: 110 }}>最大输出</th>
                            <th style={{ padding: "4px 8px", width: 80 }}>图片</th>
                            <th style={{ padding: "4px 8px", width: 70 }}>默认</th>
                          </tr>
                        </thead>
                        <tbody>
                          {edit.models.map((m, i) => (
                            <tr key={m.id} style={{ borderTop: "1px solid var(--border)" }}>
                              <td style={{ padding: "4px 8px" }}>
                                <input type="checkbox" checked={m.selected} onChange={(e) => updateDraftModel(i, { selected: e.target.checked })} />
                              </td>
                              <td style={{ padding: "4px 8px", wordBreak: "break-all" }}>{m.id}</td>
                              <td style={{ padding: "4px 8px" }}>
                                <input type="number" min={0} placeholder="auto" title="上下文窗口 (token)"
                                  value={m.context_window ?? ""}
                                  onChange={(e) => updateDraftModel(i, { context_window: e.target.value ? Number(e.target.value) : undefined })}
                                  style={cellInputStyle()} />
                              </td>
                              <td style={{ padding: "4px 8px" }}>
                                <input type="number" min={0} placeholder="auto" title="最大输出 (token)"
                                  value={m.max_output ?? ""}
                                  onChange={(e) => updateDraftModel(i, { max_output: e.target.value ? Number(e.target.value) : undefined })}
                                  style={cellInputStyle()} />
                              </td>
                              <td style={{ padding: "4px 8px" }}>
                                <input type="checkbox" checked={m.vision === true} title="支持图片输入"
                                  onChange={(e) => updateDraftModel(i, { vision: e.target.checked })} />
                              </td>
                              <td style={{ padding: "4px 8px" }}>
                                <input type="radio" name="defaultModel" checked={edit.model === m.id}
                                  onChange={() => setEdit({ ...edit, model: m.id })} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <input className="input-field" placeholder="名称（如 qwen-3b，将作为 local:<名称>）" value={edit.name}
                    disabled={edit.mode === "local-edit"}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                  <input className="input-field" placeholder="显示名（可选）" value={edit.localLabel}
                    onChange={(e) => setEdit({ ...edit, localLabel: e.target.value })} />
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <input className="input-field" placeholder="GGUF 模型文件绝对路径（如 D:\models\qwen.gguf）" value={edit.localPath}
                    onChange={(e) => setEdit({ ...edit, localPath: e.target.value })} />
                  <button className="btn" onClick={handlePickLocal} style={{ whiteSpace: "nowrap" }}>浏览…</button>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <input className="input-field" placeholder="扫描目录（如 D:\tool\slime\Local model）" value={scanDir}
                    onChange={(e) => setScanDir(e.target.value)} />
                  <button className="btn" onClick={handleScanDir} disabled={fetching} style={{ whiteSpace: "nowrap" }}>
                    {fetching ? "扫描中…" : "扫描 GGUF"}
                  </button>
                </div>
                {scanned !== null && scanned.length > 0 && (
                  <div style={{ maxHeight: 140, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 10 }}>
                    {scanned.map((m) => (
                      <button key={m.path}
                        onClick={() => {
                          setEdit((prev) => prev ? { ...prev, localPath: m.path, localLabel: prev.localLabel || m.label } : prev);
                          setScanned(null);
                        }}
                        style={{
                          display: "block", width: "100%", textAlign: "left", padding: "7px 10px",
                          background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
                          color: "var(--text)", fontSize: 12.5, cursor: "pointer",
                        }}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 4 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>上下文 ctx_len</div>
                    <input className="input-field" type="number" min={0} placeholder="auto（默认 8192）" value={edit.ctx_len}
                      onChange={(e) => setEdit({ ...edit, ctx_len: e.target.value })} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>GPU 层数</div>
                    <input className="input-field" type="number" min={0} placeholder="auto（默认 99）" value={edit.gpu_layers}
                      onChange={(e) => setEdit({ ...edit, gpu_layers: e.target.value })} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>最大输出</div>
                    <input className="input-field" type="number" min={0} placeholder="auto" value={edit.max_output}
                      onChange={(e) => setEdit({ ...edit, max_output: e.target.value })} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 18 }}>
                    <input type="checkbox" checked={edit.vision} onChange={(e) => setEdit({ ...edit, vision: e.target.checked })} />
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>支持图片输入</span>
                  </div>
                </div>
              </>
            )}

            {/* ④ 弹窗内：参数文件调试折叠区 */}
            <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              <button onClick={() => { setDebugOpen(!debugOpen); if (!debugOpen && !overview && api.current) { void api.current.config.overview().then(setOverview).catch(console.error); } }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8,
                  padding: "10px 12px", background: "var(--bg-secondary)", border: "none",
                  color: "var(--text)", fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "left",
                }}>
                <span style={{ color: "var(--accent)", fontSize: 12, transition: "transform 0.15s", display: "inline-block", transform: debugOpen ? "rotate(90deg)" : "none" }}>
                  ▶
                </span>
                参数文件调试（slime.toml / 全局配置 / MCP / 技能）
                {debugOpen && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>· 保存前自动备份 .bak</span>}
              </button>
              {debugOpen && (
                <div style={{ padding: 12 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {writableFiles.map((f: ConfigFileInfo) => (
                      <button key={f.name}
                        className={`btn${activeFile === f.name ? " primary" : ""}`}
                        onClick={() => { setActiveFile(f.name); void loadFile(f.name); }}
                        title={f.exists ? f.path : `${f.path}（不存在）`}>
                        {f.name} {f.exists ? "" : "（未创建）"}
                      </button>
                    ))}
                    {readonlyFiles.map((f: ConfigFileInfo) => (
                      <button key={f.name}
                        className={`btn${activeFile === f.name ? " primary" : ""}`}
                        onClick={() => { setActiveFile(f.name); void loadFile(f.name); }}
                        title={f.exists ? f.path : `${f.path}（不存在）`}>
                        {f.name} 🔒 {f.exists ? "" : "（未创建）"}
                      </button>
                    ))}
                  </div>
                  <textarea value={fileContent}
                    onChange={(e) => { setFileContent(e.target.value); setFileDirty(true); }}
                    readOnly={!writableFiles.some((f) => f.name === activeFile)}
                    spellCheck={false}
                    style={{
                      width: "100%", height: 180, padding: 10, boxSizing: "border-box",
                      borderRadius: 8, border: "1px solid var(--border-hover)",
                      background: "var(--bg-input)", color: "var(--text)",
                      fontSize: 12, fontFamily: "Consolas, 'Courier New', monospace",
                      outline: "none", resize: "vertical", lineHeight: 1.5,
                    }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                    <button className="btn success" onClick={handleSaveFile}
                      disabled={!fileDirty || !writableFiles.some((f) => f.name === activeFile)}>
                      保存（备份 .bak）
                    </button>
                    {fileDirty && <span style={{ fontSize: 12, color: "var(--warning)" }}>有未保存修改</span>}
                    <span style={{ flex: 1 }} />
                    {!writableFiles.some((f) => f.name === activeFile) && (
                      <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                        🔒 agents.json（服务权威）/ providers.enc.json（加密文件）只读
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginTop: 10, marginBottom: 4 }}>
                    技能库（{overview?.skills.length ?? 0}） · MCP 服务器（{overview?.mcpServers.length ?? 0}）
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
                    {overview?.skills.map((s: SkillInfo) => s.name).join("、") || "未发现技能"}
                    {(overview?.skills.length ?? 0) > 0 && (overview?.mcpServers.length ?? 0) > 0 ? " ｜ " : ""}
                    {overview?.mcpServers.map((m: McpServerInfo) => `${m.name}(${m.enabled ? "启用" : "禁用"})`).join("、") || ""}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
              <button className="btn success" onClick={handleSave} disabled={loading || !edit.name.trim()}
                style={{ fontSize: 13 }}>
                {loading ? "保存中…" : "保存"}
              </button>
              <button className="btn" onClick={() => setEdit(null)}>取消</button>
              <span style={{ flex: 1 }} />
              {edit.mode === "api-edit" && (
                <span style={{ fontSize: 12, color: "var(--text-dim)" }}>密钥已配置时留空 Key 将保留原值</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── API 供应商卡片（简洁摘要） ── */}
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", margin: "4px 0 8px" }}>
        API 供应商（{providers.length}）
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {providers.map((p) => (
          <div key={p.key} className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{p.key}</span>
              {p.has_key ? (
                <span style={chipStyle("var(--success-soft)", "var(--success)")}>密钥 ✓</span>
              ) : (
                <span style={chipStyle("var(--danger-soft)", "#f87171")}>密钥缺失</span>
              )}
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => openApiEdit(p)} style={{ padding: "2px 10px" }}>编辑</button>
              <button className="btn danger" onClick={() => handleRemoveApi(p.key)} disabled={loading}
                style={{ padding: "2px 8px" }}>删除</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, wordBreak: "break-all" }}>
              {p.api_base}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              模型 {p.models.length} 个
              {p.model && <span style={{ color: "var(--accent-hover)" }}> · 默认 {p.model}</span>}
              {p.key_hint && <span style={{ color: "var(--text-dim)" }}> · {p.key_hint}</span>}
            </div>
          </div>
        ))}
        {providers.length === 0 && (
          <div style={{ gridColumn: "1 / -1", color: "var(--text-dim)", textAlign: "center", padding: 24, fontSize: 13 }}>
            暂无 API 供应商 — 点击"＋ API 供应商"接入（如 DeepSeek / OpenAI / 兼容网关）
          </div>
        )}
      </div>

      {/* ── 本地模型卡片 ── */}
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", margin: "16px 0 8px" }}>
        本地模型（{localModels.length} · llama.cpp GGUF）
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {localModels.map((m) => (
          <div key={m.id} className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{m.id}</span>
              {m.vision && <span style={chipStyle("var(--success-soft)", "var(--success)")}>🖼 视觉</span>}
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => openLocalEdit(m)} style={{ padding: "2px 10px" }}>编辑</button>
              <button className="btn danger" onClick={() => handleRemoveLocal(m.id)} disabled={loading}
                style={{ padding: "2px 8px" }}>删除</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all", marginBottom: 4 }}>
              {m.label} · {m.path}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {m.ctx_len ? `ctx ${m.ctx_len} · ` : ""}{m.gpu_layers !== undefined ? `GPU ${m.gpu_layers} 层 · ` : ""}{m.max_output ? `out ${m.max_output}` : ""}
            </div>
          </div>
        ))}
        {localModels.length === 0 && (
          <div style={{ gridColumn: "1 / -1", color: "var(--text-dim)", textAlign: "center", padding: 24, fontSize: 13 }}>
            暂无本地模型 — 点击"＋ 本地模型"导入 GGUF 文件（将作为 local:&lt;名称&gt; 出现在模型切换中）
          </div>
        )}
      </div>
    </div>
  );
}

function chipStyle(bg: string, color: string): React.CSSProperties {
  return {
    display: "inline-block", padding: "1px 8px", borderRadius: 8,
    background: bg, color, fontSize: 11, marginRight: 4,
  };
}

function cellInputStyle(): React.CSSProperties {
  return {
    width: "100%", padding: "3px 6px", borderRadius: 4,
    border: "1px solid var(--border-hover)", background: "var(--bg-input)",
    color: "var(--text)", fontSize: 12, boxSizing: "border-box",
  };
}