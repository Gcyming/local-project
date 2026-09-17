/**
 * gui/src/renderer/pages/ProvidersPanel.tsx — 模型供应商管理。
 * - Provider/本地模型卡片：简洁摘要；全部编辑/调试参数收敛在弹窗内
 * - 添加/编辑弹窗（向导式）：
 *   ① 接入协议选择（OpenAI 兼容自动探测 / 手动指定模型）
 *   ② 填 Base URL + API Key → 自动探测模型列表（默认均未启用，按需开启）
 *   ③ 每模型调上下文/最大输出/视觉 + 启用拨片
 *   ④ 折叠区：参数文件调试（slime.toml / 全局配置 / MCP / 技能库）内嵌于弹窗
 */
import React, { type JSX } from "react";
import type { ProviderSummary, ModelSpec, ConfigOverview, ConfigFileInfo, SkillInfo, McpServerInfo, LocalModelSpec } from "../../shared/ipc.js";
import { ChevronIcon, PlusIcon, CheckIcon, CloseIcon, RefreshIcon } from "../components/Icon.js";
import { confirmAsync } from "../dialog.js";
import { REASONING_PRESETS, useReasoningPreset, saveReasoningPreset, EFFORT_LABEL, THINKING_PRESETS, useThinkingPreset, saveThinkingPreset } from "../reasoning.js";
import { describePriceTiers, resolveEffectivePricing, resolveModelPriceTier, type PriceOrigin } from "../../../../shared/gen/model-capabilities.js";

interface DraftModel extends ModelSpec { selected: boolean; }

/** A-158：常用供应商预设库（对齐 LobeChat/Cherry Studio——选中即自动填充 base URL 与
 *  端点格式，根治「加不上」= Base URL 手填错误/格式选错的高频诱因）。
 *  模型列表仍按需「获取模型列表」/手动补充（各平台模型随版本变动，不宜硬编码）。 */
const PRESET_PROVIDERS: Array<{ name: string; label: string; api_base: string; api_format: "openai" | "anthropic" | "responses" | "google" | "auto"; hint?: string; models?: string[] }> = [
  { name: "deepseek", label: "DeepSeek（深度求索）", api_base: "https://api.deepseek.com", api_format: "auto", hint: "deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp", models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"] },
  { name: "openai", label: "OpenAI", api_base: "https://api.openai.com/v1", api_format: "auto", hint: "gpt-4o / gpt-4o-mini", models: ["gpt-4o", "gpt-4o-mini"] },
  { name: "openrouter", label: "OpenRouter（聚合 300+）", api_base: "https://openrouter.ai/api/v1", api_format: "auto", hint: "免费模型池含大厂开源模型", models: ["deepseek/deepseek-chat", "meta-llama/llama-3.3-70b-instruct"] },
  { name: "siliconflow", label: "硅基流动 SiliconFlow", api_base: "https://api.siliconflow.cn/v1", api_format: "auto", hint: "Qwen / DeepSeek / GLM 等国内可达", models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"] },
  { name: "moonshot", label: "Moonshot（Kimi）", api_base: "https://api.moonshot.cn/v1", api_format: "auto", hint: "kimi-k2 / moonshot-v1-*", models: ["kimi-k2-0711-preview", "moonshot-v1-8k"] },
  { name: "zhipu", label: "智谱 GLM", api_base: "https://open.bigmodel.cn/api/paas/v4", api_format: "auto", hint: "glm-5.3 / glm-5.2 / glm-5.3-flash", models: ["glm-5.3", "glm-5.2", "glm-5.3-flash"] },
  { name: "dashscope", label: "阿里百炼（通义）", api_base: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_format: "auto", hint: "qwen3.7-max / qwen-plus / qwen3-8b", models: ["qwen3.7-max", "qwen-plus", "qwen3-8b"] },
  { name: "doubao", label: "火山引擎豆包", api_base: "https://ark.cn-beijing.volces.com/api/v3", api_format: "auto", hint: "doubao-*（需创建接入点）" },
  { name: "groq", label: "Groq（极速推理）", api_base: "https://api.groq.com/openai/v1", api_format: "auto", hint: "llama-3.3 / meta-*", models: ["llama-3.3-70b-versatile"] },
  { name: "together", label: "Together AI", api_base: "https://api.together.xyz/v1", api_format: "auto", hint: "meta-llama / deepseek 等", models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"] },
  { name: "anthropic", label: "Anthropic（Claude）", api_base: "https://api.anthropic.com", api_format: "anthropic", hint: "claude-*（Messages API）", models: ["claude-sonnet-4-20250514"] },
  { name: "opencode-zen", label: "OpenCode Zen（聚合网关）", api_base: "https://opencode.ai/zen/v1", api_format: "auto", hint: "deepseek-v4-flash / glm / kimi / claude / gpt 等（opencode.ai/auth 拿 key）", models: ["deepseek-v4-flash", "glm-5.3", "kimi-k3", "claude-sonnet-5", "gpt-5.5"] },
  { name: "agnes", label: "Agnes AI（国内）", api_base: "https://api.agnes-ai.cn/v1", api_format: "auto", hint: "agnes-2.5-flash（512K 上下文·支持思考+工具调用）", models: ["agnes-2.5-flash"] },
  { name: "agi-anyi", label: "AGI-Anyi（免费池）", api_base: "https://api.agi-anyi.com", api_format: "auto", hint: "免费模型池（需代理）" },
];

type EditMode = "api-add" | "api-edit" | "local-add" | "local-edit";
type Proto = "openai" | "manual";

interface EditState {
  mode: EditMode;
  key: string;
  name: string;
  api_base: string;
  api_key: string;
  api_format: "openai" | "anthropic" | "responses" | "google" | "auto";
  models: DraftModel[];
  proto: Proto;
  manualIds: string;
  localPath: string;
  localLabel: string;
  ctx_len: string;
  gpu_layers: string;
  max_output: string;
  vision: boolean;
  thinking?: boolean;
  thinking_efforts?: string[];
}

function emptyEdit(): EditState {
  return {
    mode: "api-add", key: "", name: "", api_base: "", api_key: "",
    api_format: "auto", models: [], proto: "openai", manualIds: "",
    localPath: "", localLabel: "", ctx_len: "", gpu_layers: "", max_output: "", vision: false,
  };
}

export default function ProvidersPanel(): JSX.Element {
  const api = React.useRef<any>(null);
  const [providers, setProviders] = React.useState<ProviderSummary[]>([]);
  const [localModels, setLocalModels] = React.useState<LocalModelSpec[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  /** 各供应商的刷新中状态（key → boolean），防止重复点击 */
  const [refreshing, setRefreshing] = React.useState<Record<string, boolean>>({});

  /* 编辑弹窗 */
  const [edit, setEdit] = React.useState<EditState | null>(null);
  const [fetching, setFetching] = React.useState(false);
  const [scanDir, setScanDir] = React.useState("");
  const [scanned, setScanned] = React.useState<Array<{ path: string; label: string }> | null>(null);
  /** 弹窗内错误横幅（保存/探测失败显示在弹窗内，用户直观可见，不误判为应用故障） */
  const [modalError, setModalError] = React.useState<string | null>(null);

  /* 弹窗内：参数文件调试折叠区 */
  const [debugOpen, setDebugOpen] = React.useState(false);
  /** 推理等级模式（上游默认 / 预制供应商）：决定聊天输入框「推理配置」面板的可选等级集合 */
  const reasonPreset = useReasoningPreset();
  const thinkPreset = useThinkingPreset();
  const [overview, setOverview] = React.useState<ConfigOverview | null>(null);
  const [activeFile, setActiveFile] = React.useState<string>("slime.toml");
  const [fileContent, setFileContent] = React.useState("");
  const [fileDirty, setFileDirty] = React.useState(false);

  function showNotice(ok: boolean, text: string): void {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 5000);
  }

  /** 弹窗内错误：显示在弹窗界面顶部（问题修复：避免错误只出现在主页面） */
  function showModalError(text: string): void {
    setModalError(text);
  }
  function clearModalError(): void {
    setModalError(null);
  }
  function closeModal(): void {
    setEdit(null);
    clearModalError();
    setScanned(null);
    setDebugOpen(false);
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
    setModalError(null);
    setEdit({ ...emptyEdit(), mode: "api-add" });
  }

  function openApiEdit(p: ProviderSummary): void {
    setModalError(null);
    setEdit({
      mode: "api-edit", key: p.key, name: p.key,
      api_base: p.api_base, api_key: "",
      api_format: p.api_format ?? "auto",
      // 保留各模型的启用状态（旧记录无 selected → 视为启用）
      models: p.models.map((m) => ({ ...m, selected: (m as DraftModel).selected !== false })),
      proto: "openai", manualIds: p.models.map((m) => m.id).join("\n"),
    localPath: "", localLabel: "", ctx_len: "", gpu_layers: "", max_output: "", vision: false, thinking: undefined, thinking_efforts: undefined,
    });
  }

  function openLocalAdd(): void {
    setModalError(null);
    setEdit({ ...emptyEdit(), mode: "local-add" });
  }

  function openLocalEdit(m: LocalModelSpec): void {
    setModalError(null);
    setEdit({
      mode: "local-edit", key: m.id, name: m.id,
      api_base: "", api_key: "",
      api_format: "auto",
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
      showModalError("请先填写 Base URL 与 API Key");
      return;
    }
    setModalError(null);
    setFetching(true);
    try {
      const res = await api.current.providers.fetchModels(edit.api_base.trim(), edit.api_key.trim(), edit.api_format);
      if (res.ok && res.models) {
        // A-918+：探测即 enrich（IPC 层已用 enrichModels）+ 默认 selected:true（自动选用），
        // 满足「添加即用」的 UX 期望；用户仍可在拨片列关掉不想用的模型
        const models = res.models.map((m: ModelSpec) => ({ ...m, selected: m.selected !== false }));
        setEdit({ ...edit, models, proto: "openai" });
        showNotice(true, `探测成功：发现 ${res.models.length} 个模型（已自动启用，元数据已填充，可在列表中调整）`);
      } else {
        // A-918++：上游拉取失败 → 用官方文档核对过的预设模型兜底（严禁再出现 agnes/opencode/deepseek 这类 baseUrl 或模型名错误）
        const preset = PRESET_PROVIDERS.find((p) => p.name === edit.name);
        const fallbackIds = preset?.models ?? [];
        const fallbackModels: DraftModel[] = fallbackIds.map((id) => ({ id, selected: true }));
        setEdit({ ...edit, models: fallbackModels, proto: "openai" });
        showModalError(
          `${res.error ?? "获取失败"}——已用预设模型兜底：${fallbackIds.join("、") || "（该供应商无内置预设，请手动添加模型 ID）"}`,
        );
      }
    } catch (e) {
      showModalError(`获取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetching(false);
    }
  }

  /** 手动模式：文本行 → 模型草稿（每行一个模型 ID；新模型默认未启用） */
  function applyManualIds(): void {
    if (!edit) { return; }
    const ids = edit.manualIds.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const merged: DraftModel[] = ids.map((id) => {
      const prev = edit.models.find((m) => m.id === id);
      return prev ?? { id, selected: false };
    });
    setEdit({ ...edit, models: merged });
  }

  /** A-158 修复：手动模式模型同步合并（保存时直接调用，不再依赖异步 setState）——
   *  此前 handleSave 里 applyManualIds() 是异步状态更新，立即读 edit.models 仍是旧值，
   *  用户手填的模型 ID 从未真正保存（「加了但用不了」的直接根因之一）。 */
  function manualModelsSync(): DraftModel[] {
    if (!edit || edit.proto !== "manual") { return edit?.models ?? []; }
    const ids = edit.manualIds.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return ids.map((id) => {
      const prev = edit.models.find((m) => m.id === id);
      return prev ?? { id, selected: false };
    });
  }

  /** 全选/全不选（拨片列顶部开关） */
  function toggleAllModels(on: boolean): void {
    if (!edit) { return; }
    setEdit({ ...edit, models: edit.models.map((m) => ({ ...m, selected: on })) });
  }

  function updateDraftModel(index: number, patch: Partial<DraftModel>): void {
    if (!edit) { return; }
    setEdit({
      ...edit,
      models: edit.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    });
  }

  /**
   * 手填单价（USD / 1M tokens）。
   * 一旦写入就标记 `price_source: "manual"` —— 自动探测（一键刷新 / 上游 /api/pricing）永不覆盖；
   * 两个输入框都清空则撤销 manual，交还给自动取值链路（上游 → 内置价目表）。
   * ⚠️ `0` 是**有意义的**（官方限时免费），必须原样存下去，不能当"空"处理。
   */
  function updateDraftPrice(index: number, field: "price_in_usd" | "price_out_usd", raw: string): void {
    const cur = edit?.models[index];
    if (!cur) { return; }
    const trimmed = raw.trim();
    let v: number | undefined;
    if (trimmed !== "") {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) { return; } // 非法输入直接忽略，不写脏值
      v = n;
    }
    const nextIn = field === "price_in_usd" ? v : cur.price_in_usd;
    const nextOut = field === "price_out_usd" ? v : cur.price_out_usd;
    const stillManual = typeof nextIn === "number" || typeof nextOut === "number";
    updateDraftModel(index, {
      [field]: v,
      price_source: stillManual ? "manual" : undefined,
    } as Partial<DraftModel>);
  }

  async function handlePickLocal(): Promise<void> {
    if (!api.current) { return; }
    const res = await api.current.providers.localPick();
    if (res.ok && res.path) {
      setModalError(null);
      setEdit((prev) => prev ? { ...prev, localPath: res.path, localLabel: prev.localLabel || (res.path.split(/[\\/]/).pop() ?? res.path) } : prev);
      setScanned(null);
    } else if (res.error && res.error !== "已取消选择") {
      showModalError(res.error);
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
        showModalError(res.error ?? "扫描失败");
      }
    } finally {
      setFetching(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!api.current || !edit) { return; }
    setModalError(null);
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
          closeModal();
          await refreshAll();
        } else {
          showModalError(res.error ?? "保存失败");
        }
        return;
      }
      // A-158：保存前同步合并手动填写的模型 ID（此前异步 setState 导致手动模型从未入库）
      const modelsForSave = manualModelsSync();
      // 保存全部模型（含 selected 启用标记），供应商编辑界面展示全量、聊天界面只列启用项
      const models = modelsForSave.map((m) => ({
        id: m.id,
        context_window: m.context_window || undefined,
        max_output: m.max_output || undefined,
        vision: m.vision === true,
        selected: m.selected === true,
        // ⚠️ 用 `?? undefined` 而不是 `|| undefined`：`0` 表示"官方限时免费"，是有效价，
        //    用 `||` 会把 0 吞成 undefined → 免费模型被记成"未定价"（0/undefined 语义不可合并）。
        price_in_usd: m.price_in_usd ?? undefined,
        price_out_usd: m.price_out_usd ?? undefined,
        price_cache_read_usd: m.price_cache_read_usd ?? undefined,
        price_cache_write_usd: m.price_cache_write_usd ?? undefined,
        // 手填标记必须一起回传，否则一键刷新会用自动探测价覆盖掉用户填的议价
        price_source: m.price_source,
      }));
      const res = await api.current.providers.save({
        key: edit.name.trim(),
        api_base: edit.api_base.trim(),
        api_key: edit.api_key.trim() || undefined,
        // 默认模型字段保留旧值（底层 engine 的 api:<key> 无显式模型时使用；UI 不再提供修改入口）
        api_format: edit.api_format,
        models,
      });
      if (res.ok) {
        showNotice(true, `已保存供应商「${edit.name}」并热更新 → ${res.path ?? ""}`);
        closeModal();
        await refreshAll();
      } else {
        showModalError(res.error ?? "保存失败");
      }
    } finally {
      setLoading(false);
    }
  }

  /** 一键刷新供应商模型列表：用已保存的 API Key 重新探测上游，无需重新填写配置 */
  async function handleRefreshProvider(p: ProviderSummary): Promise<void> {
    if (!api.current || !p.has_key) {
      showNotice(false, `「${p.key}」未配置 API Key，请先编辑填写后再刷新`);
      return;
    }
    setRefreshing((prev) => ({ ...prev, [p.key]: true }));
    try {
      const res = await api.current.providers.refresh(p.key);
      if (res.ok) {
        const extra = (res.added ? `，新增 ${res.added} 个` : "") + (res.removed ? `，下架 ${res.removed} 个` : "");
        showNotice(true, `已刷新「${p.key}」模型列表（共 ${res.total ?? 0} 个${extra}；原启用状态已保留，新增模型需手动启用）`);
        await refreshAll();
      } else {
        showNotice(false, `刷新失败：${res.error ?? "未知错误"}`);
      }
    } catch (e) {
      showNotice(false, `刷新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRefreshing((prev) => ({ ...prev, [p.key]: false }));
    }
  }

  async function handleRemoveApi(key: string): Promise<void> {
    if (!api.current) { return; }
    // A-151: window.confirm 同步阻塞渲染进程 JS，对话框显示异常时输入框全部失灵 → 走异步原生对话框
    if (!(await confirmAsync(`删除供应商「${key}」？`, "Agent 的 model_choice 若引用该 key 将失效"))) { return; }
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
    if (!(await confirmAsync(`删除本地模型「${id}」？`))) { return; }
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
        <button className="btn sky" onClick={openLocalAdd} style={{ fontSize: 13 }}><PlusIcon size={12} /> 本地模型</button>
        <button className="btn primary" onClick={openApiAdd} style={{ fontSize: 13 }}><PlusIcon size={12} /> API 供应商</button>
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
          onClick={(e) => { if (e.target === e.currentTarget) { closeModal(); } }}>
          <div className="card" style={{ width: 680, maxWidth: "94vw", maxHeight: "78vh", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12, flexShrink: 0 }}>
              <h3 style={{ margin: 0, flex: 1 }}>
                {edit.mode === "api-add" && "添加 API 供应商"}
                {edit.mode === "api-edit" && `编辑供应商「${edit.key}」`}
                {edit.mode === "local-add" && "添加本地模型"}
                {edit.mode === "local-edit" && `编辑本地模型「${edit.key}」`}
              </h3>
              <button className="titlebar-btn" onClick={closeModal} title="关闭"><CloseIcon size={12} /></button>
            </div>

            {/* 弹窗内错误横幅：保存/探测失败在此处直观展示，不落到主页面 */}
            {modalError && (
              <div style={{
                marginBottom: 12, padding: "8px 12px", borderRadius: 8,
                border: "1px solid var(--danger, #e5484d)",
                background: "rgba(229, 72, 77, 0.12)", color: "var(--danger, #ff6b70)",
                fontSize: 12.5, whiteSpace: "pre-wrap",
              }}>
                {modalError}
              </div>
            )}

            {/* 可滚动内容区 */}
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
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
                {edit.mode === "api-add" && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 80, whiteSpace: "nowrap" }}>常用供应商</span>
                    <select className="tool-select" style={{ flex: 1 }}
                      defaultValue=""
                      onChange={(e) => {
                        const p = PRESET_PROVIDERS.find((x) => x.name === e.target.value);
                        if (!p) { return; }
                        setEdit({
                          ...edit,
                          name: edit.name.trim() || p.name,
                          api_base: p.api_base,
                          api_format: p.api_format,
                        });
                        showNotice(true, `已填入「${p.label}」Base URL/格式（仍需填写 API Key，再获取/手动添加模型）`);
                      }}>
                      <option value="">选择预设自动填充…</option>
                      {PRESET_PROVIDERS.map((p) => (
                        <option key={p.name} value={p.name} title={p.hint}>{p.label} — {p.api_base}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, marginBottom: 10 }}>
                  <input className="input-field" placeholder="名称（如 deepseek，将作为 api:<名称>）" value={edit.name}
                    disabled={edit.mode === "api-edit"}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                  <input className="input-field" placeholder="Base URL（https://api.example.com）" value={edit.api_base}
                    onChange={(e) => setEdit({ ...edit, api_base: e.target.value })} />
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 80 }}>端点格式</span>
                  <select className="tool-select" value={edit.api_format}
                    onChange={(e) => setEdit({ ...edit, api_format: e.target.value as "openai" | "anthropic" | "responses" | "google" | "auto" })}
                    style={{ flex: 1, maxWidth: 320 }}>
                    <option value="auto">自动检测（推荐）</option>
                    <option value="openai">OpenAI — /v1/chat/completions + /v1/models</option>
                    <option value="anthropic">Anthropic — /v1/messages + /v1/models</option>
                  </select>
                  <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1, overflowWrap: "break-word" }}>
                    自动：按 base_url 智能选择；显式选则强制用对应格式
                  </span>
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
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
                    模型调试（勾选可用 · 调上下文/输出/视觉 · 保存后聊天界面按需选模型）
                  </div>
                  {edit.proto === "manual" ? (
                    <>
                      <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 4, overflowWrap: "break-word" }}>
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
                    <div style={{ color: "var(--text-dim)", fontSize: 12.5, padding: "6px 0 10px", overflowWrap: "break-word" }}>
                      未获取模型列表 — 填写 Base URL 与 API Key 后点击"获取模型列表"，自动探测并预选默认选项
                    </div>
                  ) : (
                    <div style={{ flex: 1, minHeight: 0, maxHeight: 260, overflow: "auto", marginBottom: 10 }}>
                      {/* 顶部全选：一键启用/取消全部模型（探测后默认一个都不选，按需用拨片开启） */}
                      <div style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "5px 8px 7px", borderBottom: "1px solid var(--border)",
                        position: "sticky", top: 0, background: "var(--bg-secondary, var(--bg-card))", zIndex: 1,
                      }}>
                        <ToggleSwitch
                          checked={edit.models.length > 0 && edit.models.every((m) => m.selected)}
                          onChange={(v) => toggleAllModels(v)}
                          title="全选 / 全不选"
                        />
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
                          {edit.models.length === 0 ? "无模型"
                            : edit.models.every((m) => m.selected) ? "全部启用"
                            : edit.models.some((m) => m.selected) ? "部分启用" : "全部未启用"}
                        </span>
                        <span style={{ flex: 1 }} />
                        <span style={{ fontSize: 11.5, color: "var(--text-dim)", overflowWrap: "break-word" }}>共 {edit.models.length} 个 · 聊天界面只显示已启用</span>
                      </div>
                      {/*
                        ⚠️ 这里**故意不设 minWidth**。弹窗卡片固定 width:680（内容区约 640 CSS px），
                        此前写 `minWidth: 880`（后又加到 920）→ 表格比容器宽 280px，被裁得只剩中间一段：
                        左边模型 ID 只剩 "sh"/"-pro" 尾巴、右边「单价」列整列看不见，底部还多一条横向滚动条。
                        让表格 = 容器宽度才是对的；真窄到放不下时浏览器的 min-content 会自然给出滚动，
                        不需要（也不应该）用一个拍脑袋的 minWidth 去替它决定。
                        同理，列头文字长度**直接决定列的最小宽度**（th 有 nowrap），所以列头必须短：
                        "上下文(K)"→"上下文K"、"最大输出(K)"→"输出K"、"单价 $/M（输/出）"→"单价 $/M"（单位/双框语义移进 title）。
                      */}
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
                          <th style={{ padding: "4px 8px", width: 56, whiteSpace: "nowrap" }}>启用</th>
                          <th style={{ padding: "4px 8px" }}>模型 ID</th>
                          <th style={{ padding: "4px 8px", width: 60, whiteSpace: "nowrap" }} title="上下文窗口，单位 K token（输入 1024 = 1048576 token）">上下文K</th>
                          <th style={{ padding: "4px 8px", width: 48, whiteSpace: "nowrap" }} title="最大输出，单位 K token（输入 64 = 65536 token）">输出K</th>
                          <th style={{ padding: "4px 8px", width: 40, whiteSpace: "nowrap" }} title="支持图片输入">图片</th>
                          <th style={{ padding: "4px 8px", width: 122, whiteSpace: "nowrap" }} title="这是「引擎实际计费」所用的价格来源（不是配置里存了什么）。优先级：手填/上游结算价 > 本地端点免费 > 峰谷分时档 > 内置价目表 > 残留存值 > 未定价。">定价来源</th>
                          <th style={{ padding: "4px 8px", width: 124, whiteSpace: "nowrap" }} title="两个框依次是 **输入 / 输出** 单价（USD / 1M tokens）。手填即视为「手填价」，一键刷新不会覆盖；两个都留空则恢复自动取值（含峰谷分时）。">单价 $/M</th>
                        </tr>
                      </thead>
                        <tbody>
                          {edit.models.map((m, i) => (
                            <tr key={m.id} style={{ borderTop: "1px solid var(--border)" }}>
                              <td style={{ padding: "4px 8px" }}>
                                <ToggleSwitch
                                  checked={m.selected}
                                  onChange={(v) => updateDraftModel(i, { selected: v })}
                                  title={`${m.selected ? "停用" : "启用"} ${m.id}`}
                                />
                              </td>
                              {/*
                                模型 ID 用「单行 + 省略号」而不是 `break-all` 换行：
                                换行会让长 ID（deepseek-v4-flash-vision-exp）把行高从 31px 顶到 53px ——
                                用户报过"间隔怎么这么长"，根因就是行内出现第二行文字。这里的 min/max
                                宽度让列可以随窗口收放、但永远只占一行，完整 ID 走 title 悬停可见。
                              */}
                              <td style={{ padding: "4px 8px" }}>
                                <span title={m.id} style={{
                                  display: "block", minWidth: 120, maxWidth: 320,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}>{m.id}</span>
                              </td>
                              <td style={{ padding: "4px 8px" }}>
                                <input type="number" min={0} placeholder="auto" title="上下文窗口 (K token，输入 32 = 32768 token)"
                                  value={m.context_window ? String(Math.round(m.context_window / 1024)) : ""}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    updateDraftModel(i, { context_window: v ? Number(v) * 1024 : undefined });
                                  }}
                                  style={cellInputStyle()} />
                              </td>
                              <td style={{ padding: "4px 8px" }}>
                                <input type="number" min={0} placeholder="auto" title="最大输出 (K token，输入 8 = 8192 token)"
                                  value={m.max_output ? String(Math.round(m.max_output / 1024)) : ""}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    updateDraftModel(i, { max_output: v ? Number(v) * 1024 : undefined });
                                  }}
                                  style={cellInputStyle()} />
                              </td>
                              <td style={{ padding: "4px 8px" }}>
                                <input type="checkbox" checked={m.vision === true} title="支持图片输入"
                                  onChange={(e) => updateDraftModel(i, { vision: e.target.checked })} />
                              </td>
                              <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                                <PriceOriginBadges m={m} baseUrl={edit.api_base} />
                              </td>
                              <td style={{ padding: "4px 8px" }}>
                                <div style={{ display: "flex", gap: 4 }}>
                                  <input type="number" min={0} step="0.01"
                                    placeholder={pricePlaceholder(m, edit.api_base, "in")}
                                    title={priceInputHint(m, edit.api_base, "in")}
                                    value={typeof m.price_in_usd === "number" ? String(m.price_in_usd) : ""}
                                    onChange={(e) => updateDraftPrice(i, "price_in_usd", e.target.value)}
                                    style={priceInputStyle(m, edit.api_base, "in")} />
                                  <input type="number" min={0} step="0.01"
                                    placeholder={pricePlaceholder(m, edit.api_base, "out")}
                                    title={priceInputHint(m, edit.api_base, "out")}
                                    value={typeof m.price_out_usd === "number" ? String(m.price_out_usd) : ""}
                                    onChange={(e) => updateDraftPrice(i, "price_out_usd", e.target.value)}
                                    style={priceInputStyle(m, edit.api_base, "out")} />
                                </div>
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
                  <input className="input-field" placeholder="扫描目录（如 D:\models\Local model）" value={scanDir}
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
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>上下文 ctx_len (K)</div>
                    <input className="input-field" type="number" min={0} placeholder="auto（默认 8192）"
                      value={edit.ctx_len ? String(Math.round(Number(edit.ctx_len) / 1024)) : ""}
                      onChange={(e) => setEdit({ ...edit, ctx_len: e.target.value ? String(Number(e.target.value) * 1024) : "" })} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>GPU 层数</div>
                    <input className="input-field" type="number" min={0} placeholder="auto（默认 99）" value={edit.gpu_layers}
                      onChange={(e) => setEdit({ ...edit, gpu_layers: e.target.value })} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>最大输出 (K)</div>
                    <input className="input-field" type="number" min={0} placeholder="auto"
                      value={edit.max_output ? String(Math.round(Number(edit.max_output) / 1024)) : ""}
                      onChange={(e) => setEdit({ ...edit, max_output: e.target.value ? String(Number(e.target.value) * 1024) : "" })} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 18 }}>
                    <input type="checkbox" checked={edit.vision} onChange={(e) => setEdit({ ...edit, vision: e.target.checked })} />
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>支持图片输入</span>
                  </div>
                </div>
              </>
            )}

            </div>
            {/* ④ 弹窗内：参数文件调试折叠区 */}
            <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              <button onClick={() => { setDebugOpen(!debugOpen); if (!debugOpen && !overview && api.current) { void api.current.config.overview().then(setOverview).catch(console.error); } }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8,
                  padding: "10px 12px", background: "var(--bg-secondary)", border: "none",
                  color: "var(--text)", fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "left",
                }}>
                <span style={{ color: "var(--accent)", fontSize: 12, display: "inline-flex", alignItems: "center" }}>
                  <ChevronIcon size={14} rotate={debugOpen ? 90 : 0} />
                </span>
                参数文件调试（slime.toml / 全局配置 / MCP / 技能）
                {debugOpen && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>· 保存前自动备份 .bak</span>}
              </button>
              {debugOpen && (
                <div style={{ padding: 12 }}>
                  {/* 推理等级模式：上游默认 / 预制供应商。决定聊天输入框「推理配置」可选的等级集合；
                      用户不选（默认「上游默认」）→ 聊天侧完全以上游模型返回为准 */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                    padding: "8px 10px", marginBottom: 10, borderRadius: 8,
                    border: "1px solid var(--border)", background: "var(--bg-secondary)",
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <span style={{ fontSize: 13 }}>🧠</span> 推理等级模式
                    </span>
                    <select className="input-field"
                      value={reasonPreset}
                      onChange={(e) => saveReasoningPreset(e.target.value)}
                      title="选择聊天输入框「推理配置」面板提供的推理等级集合；不选则默认以上游模型返回为准"
                      style={{ flex: "1 1 240px", minWidth: 0, maxWidth: 460, fontSize: 12, padding: "4px 8px" }}>
                      {REASONING_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                    {reasonPreset !== "upstream" && (
                      <button className="btn" style={{ fontSize: 11.5, padding: "3px 8px", whiteSpace: "nowrap" }}
                        title="恢复默认：以上游模型返回为准"
                        onClick={() => saveReasoningPreset("upstream")}>
                        重置为上游默认
                      </button>
                    )}
                    <span style={{ flex: 1 }} />
                    {reasonPreset !== "upstream" ? (
                      <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        可选：{REASONING_PRESETS.find((p) => p.value === reasonPreset)?.efforts
                          .map((e) => EFFORT_LABEL[e] ?? e).join(" / ")}
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                        目前以模型返回为准，无需手动指定
                      </span>
                    )}
                  </div>
                  {/* 思考能力默认：聊天输入框「思考」开关在模型元数据缺失时的兜底默认（元数据明确则以上游为准）。
                      原模型表「思考」勾选列已删除——思考能力按上游/供应商+模型 ID 推断，此处仅作缺失兜底，
                      聊天界面的「思考」按钮是唯一主动开关。 */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                    padding: "8px 10px", marginBottom: 10, borderRadius: 8,
                    border: "1px solid var(--border)", background: "var(--bg-secondary)",
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <span style={{ fontSize: 13 }}>💭</span> 思考能力默认
                    </span>
                    <select className="input-field"
                      value={thinkPreset}
                      onChange={(e) => saveThinkingPreset(e.target.value)}
                      title="模型未返回思考能力元数据时的兜底默认：上游检测=按供应商/模型推断（缺失时默认开启）；一律开启/一律关闭则强制聊天「思考」开关的默认可用性；元数据明确时始终以上游为准"
                      style={{ flex: "1 1 240px", minWidth: 0, maxWidth: 460, fontSize: 12, padding: "4px 8px" }}>
                      {THINKING_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                    {thinkPreset !== "upstream" && (
                      <button className="btn" style={{ fontSize: 11.5, padding: "3px 8px", whiteSpace: "nowrap" }}
                        title="恢复默认：以上游检测为准"
                        onClick={() => saveThinkingPreset("upstream")}>
                        重置为上游检测
                      </button>
                    )}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      聊天「思考」按钮主动开关 · 元数据明确时此设置不生效
                    </span>
                  </div>
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
                        {f.name} <span style={{ opacity: 0.5, marginRight: 3 }}>🔒</span>{f.exists ? "" : "（未创建）"}
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
                        <span style={{ fontSize: 11.5, color: "var(--text-dim)", overflowWrap: "break-word" }}>
                          🔒 agents.json（服务权威）/ providers.enc.json（加密文件）只读
                        </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginTop: 10, marginBottom: 4 }}>
                    技能库（{overview?.skills.length ?? 0}） · MCP 服务器（{overview?.mcpServers.length ?? 0}）
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.6, overflowWrap: "break-word" }}>
                    {overview?.skills.map((s: SkillInfo) => s.name).join("、") || "未发现技能"}
                    {(overview?.skills.length ?? 0) > 0 && (overview?.mcpServers.length ?? 0) > 0 ? " ｜ " : ""}
                    {overview?.mcpServers.map((m: McpServerInfo) => `${m.name}(${m.enabled ? "启用" : "禁用"})`).join("、") || ""}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexShrink: 0 }}>
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, minHeight: 0 }}>
        {providers.map((p) => (
          <div key={p.key} className="card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* 供应商名称作为卡片标题：独占首行、完整显示，不与配置/按钮挤在一行 */}
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", lineHeight: 1.4, marginBottom: 8, wordBreak: "break-all", overflowWrap: "break-word", flexShrink: 0 }}
              title={p.key}>{p.key}</div>
            {/* 配置情况：密钥状态 + Base URL */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4, flexShrink: 0 }}>
              {p.has_key ? (
                <span style={{ ...chipStyle("var(--success-soft)", "var(--success)"), flexShrink: 0, whiteSpace: "nowrap" }}><CheckIcon size={11} /> 密钥已配置</span>
              ) : (
                <span style={{ ...chipStyle("var(--danger-soft)", "#f87171"), flexShrink: 0, whiteSpace: "nowrap" }}>密钥缺失</span>
              )}
              <span style={{ fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all", overflowWrap: "break-word", flex: 1, minWidth: 160 }}>{p.api_base}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", flexShrink: 0 }}>
              模型 {p.models.length} 个
              {p.key_hint && <span style={{ color: "var(--text-dim)" }}> · {p.key_hint}</span>}
            </div>
            {/* 操作按钮区 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexShrink: 0 }}>
              <span style={{ flex: 1 }} />
              <button className="btn" style={{ padding: "2px 10px", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}
                title="刷新模型列表（上游更新时一键同步，无需重新填写配置）"
                disabled={refreshing[p.key] || loading}
                onClick={() => handleRefreshProvider(p)}>
                {refreshing[p.key] ? (
                  <span className="icon-spin" style={{ display: "inline-flex" }}><RefreshIcon size={13} /></span>
                ) : (
                  <RefreshIcon size={13} />
                )}
                刷新
              </button>
              <button className="btn" onClick={() => openApiEdit(p)} style={{ padding: "2px 10px", flexShrink: 0 }}>编辑</button>
              <button className="btn danger" onClick={() => handleRemoveApi(p.key)} disabled={loading}
                style={{ padding: "2px 8px", flexShrink: 0 }}>删除</button>
            </div>
          </div>
        ))}
        {providers.length === 0 && (
          <div style={{ gridColumn: "1 / -1", color: "var(--text-dim)", textAlign: "center", padding: 24, fontSize: 13 }}>
            暂无 API 供应商 — 点击"<PlusIcon size={11} /> API 供应商"接入（如 DeepSeek / OpenAI / 兼容网关）
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
              {m.vision && <span style={chipStyle("var(--success-soft)", "var(--success)")}>视觉</span>}
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
            暂无本地模型 — 点击"<PlusIcon size={11} /> 本地模型"导入 GGUF 文件（将作为 local:&lt;名称&gt; 出现在模型切换中）
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

/**
 * 生效价（USD / 1M tokens）→ 简短文本。去掉浮点尾巴（0.30000000000000004 → 0.3），
 * 保留足够精度（DeepSeek 缓存命中价 0.006 这类三位小数不能被截成 0）。
 */
function fmtPrice(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) { return ""; }
  return String(Number(n.toFixed(6)));
}

/** 生效价来源徽标的文案与配色（`origin` 由共享的 resolveEffectivePricing 给出，不在这里重新判断） */
const ORIGIN_META: Record<PriceOrigin, { text: string; color: string; bg: string }> = {
  manual: { text: "手填", color: "var(--accent, #8b7bf7)", bg: "rgba(139,123,247,0.14)" },
  upstream: { text: "上游", color: "var(--success)", bg: "var(--success-soft)" },
  local: { text: "本地免费", color: "var(--success)", bg: "var(--success-soft)" },
  tier: { text: "分时价", color: "var(--accent, #8b7bf7)", bg: "rgba(139,123,247,0.12)" },
  table: { text: "内置表", color: "var(--text-secondary)", bg: "rgba(127,127,127,0.14)" },
  stored: { text: "残留值", color: "var(--text-dim)", bg: "rgba(127,127,127,0.10)" },
  none: { text: "未定价", color: "var(--warning)", bg: "rgba(210,153,34,0.12)" },
};

const ORIGIN_HINT: Record<PriceOrigin, string> = {
  manual: "用户手填单价 —— 自动探测/一键刷新不会覆盖。清空右侧两个单价框即可恢复自动取值。",
  upstream: "来自上游 /models 或网关 /api/pricing 的真实结算价（最权威）。",
  local: "本地 / 内网端点：没有按 token 计费的账单，成本恒为 0。若这里其实是要计费的托管端点，请在右侧手填单价（手填即覆盖）。",
  tier: "内置价目表的分时档 —— 按每条记录**自己的时刻**取档，本行显示的是该时刻的档位价。",
  table: "来自 slime 内置家族价目表（已核实刊例价）。上游探测不到价时的离线兜底，可能滞后于官方调价。",
  stored: "历史遗留值，没有来源标记。下次「一键刷新」会尝试用上游价 / 内置表价取代它。",
  none: "既没探测到上游价、也不在内置表中 —— 该模型的消耗会记成 $0。请在右侧手填单价（USD / 1M tokens）。",
};

/**
 * 定价徽标（定价来源列）。
 *
 * **为什么必须单源**：本列显示的是「引擎实际按什么价记账」，而不是「配置里存了什么」。
 * 旧实现只看存值（`price_source` + `price_in_usd`），于是出现两种用户可见的分裂：
 *   ① 存值缺价但内置表有价 → 面板显示「未定价」，引擎却按 0.3 计费（投诉"flash 怎么还是没定价"）；
 *   ② 本地端点（127.0.0.1）存值缺价 → 面板显示「未定价」，引擎却套官方刊例价（凭空产生账单）。
 * 现在改由共享的 `resolveEffectivePricing` 统一判定 —— 与引擎**逐条同序**，不可能再分裂。
 *
 * 分时徽标（峰谷分时）单独一枚，与来源徽标**并排一行**（不要拆成两行：那会把行高翻倍，
 * 看起来像"行间距异常"，实测每行从 31px 涨到 53px）。
 */
function PriceOriginBadges({ m, baseUrl }: { m: DraftModel; baseUrl: string }): JSX.Element {
  const eff = resolveEffectivePricing(m.id, baseUrl, m);
  const tierDesc = describePriceTiers(m.id);
  const meta = ORIGIN_META[eff.origin];
  // 分时徽标只在**分时价真的参与计价**时出现。模型带分时规格 ≠ 这行在用分时价：
  // 本地端点 / 手填价 / 上游结算价都会压过分时价，此时挂个「峰谷分时」会让人以为时段在生效
  // （实测 127.0.0.1 上的 deepseek-chat 就命中了 deepseek 家族的分时规格）。
  const tierActive = !!tierDesc && (eff.origin === "table" || eff.origin === "tier");

  const lines = [`【${meta.text}】${ORIGIN_HINT[eff.origin]}`];
  if (eff.origin === "none") {
    lines.push("计费单价：未知（按 $0 记账）");
  } else {
    lines.push(`计费单价：输入 ${fmtPrice(eff.priceIn)} / 输出 ${fmtPrice(eff.priceOut)} USD per 1M tokens`);
  }
  if (eff.superseded) {
    lines.push(`⚠️ 配置里存着 ${fmtPrice(eff.superseded.priceIn)}，但引擎**不采用**它（级别低于 ${meta.text}）。清空右侧单价框可清掉这条残留。`);
  }
  if (tierDesc) {
    lines.push(`该模型的官方规格是峰谷分时：${tierDesc}`);
    if (!tierActive) {
      lines.push(`本行当前**不走分时价**（${meta.text} 压过分时）。想让时段生效 → 清空右侧两个单价框。`);
    } else {
      // 尽力而为的"此刻"提示：面板没有请求时刻，这里只是让用户知道离高峰价有多远
      const now = resolveModelPriceTier(m.id, new Date());
      if (now.tiered) {
        lines.push(`当前时刻命中：${now.label ?? now.tierId} — 输入 ${fmtPrice(now.pricing.priceIn)} / 输出 ${fmtPrice(now.pricing.priceOut)}`);
      }
      lines.push("⚠️ 一旦手填单价就会覆盖分时价（手填视为议价/合同价）。想继续按时段计费，请把两个框留空。");
    }
  }

  return (
    <span title={lines.join("\n")} style={{
      display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", cursor: "help",
    }}>
      <span style={{
        fontSize: 10, color: meta.color, background: meta.bg, padding: "1px 5px", borderRadius: 3,
      }}>{meta.text}</span>
      {tierActive && (
        <span style={{
          fontSize: 10, color: "var(--accent, #8b7bf7)", background: "rgba(139,123,247,0.12)",
          padding: "1px 5px", borderRadius: 3,
        }}>峰谷分时</span>
      )}
    </span>
  );
}

function cellInputStyle(): React.CSSProperties {
  return {
    width: "100%", padding: "3px 6px", borderRadius: 4,
    border: "1px solid var(--border-hover)", background: "var(--bg-input)",
    color: "var(--text)", fontSize: 12, boxSizing: "border-box",
  };
}

/**
 * 单价输入框的占位文本。
 *
 * **关键：没存价时占位显示的是「引擎实际会用的价」，而不是中性的"输入"**。
 * 旧写法一律显示"输入"，于是 deepseek-flash 这种"存值缺价、内置表有价"的行看起来像没定价 ——
 * 用户实际投诉的就是这个（表里明明有 0.3，界面却只写"未定价"）。数字摆在框里，一眼可见。
 */
function pricePlaceholder(m: DraftModel, baseUrl: string, which: "in" | "out"): string {
  const stored = which === "in" ? m.price_in_usd : m.price_out_usd;
  if (typeof stored === "number") { return which === "in" ? "输入" : "输出"; }
  const eff = resolveEffectivePricing(m.id, baseUrl, m);
  if (eff.origin === "none") { return which === "in" ? "输入" : "输出"; }
  const v = which === "in" ? eff.priceIn : eff.priceOut;
  return fmtPrice(v) || (which === "in" ? "输入" : "输出");
}

/** 单价输入框的悬停说明（把"存值 vs 生效价"的分歧讲清楚，避免用户以为存值在计费） */
function priceInputHint(m: DraftModel, baseUrl: string, which: "in" | "out"): string {
  const label = which === "in" ? "输入" : "输出";
  const base = `${label}单价 USD / 1M tokens。填写即标记为手填（一键刷新不覆盖）；清空两个框恢复自动取值。`;
  const eff = resolveEffectivePricing(m.id, baseUrl, m);
  if (eff.origin === "none") { return `${base}\n当前**未定价**：表里没有已核实的价，该模型消耗会记成 $0。`; }
  const now = `${label}：${fmtPrice(which === "in" ? eff.priceIn : eff.priceOut)}（来源：${ORIGIN_META[eff.origin].text}）`;
  if (eff.superseded) {
    return `${base}\n⚠️ 这里存的 ${fmtPrice(eff.superseded.priceIn)} 引擎**不采用**；实际计费按 ${now}。`;
  }
  return `${base}\n当前实际计费 → ${now}`;
}

/** 单价输入框样式：存值被更高优先级来源取代时加删除线 + 变暗（一眼看出"这行数字不算数"） */
function priceInputStyle(m: DraftModel, baseUrl: string, which: "in" | "out"): React.CSSProperties {
  const stored = which === "in" ? m.price_in_usd : m.price_out_usd;
  const stale = typeof stored === "number" && resolveEffectivePricing(m.id, baseUrl, m).superseded !== undefined;
  return {
    ...cellInputStyle(), width: 52,
    ...(stale ? { textDecoration: "line-through", opacity: 0.45 } : {}),
  };
}
/** 拨片开关（启用/停用）：悬停发光 + 点击缩放反馈，主题跟随 */
function ToggleSwitch({ checked, onChange, title }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}): JSX.Element {
  const w = 40;
  const h = 22;
  const knob = 18;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      style={{
        position: "relative", display: "inline-flex", alignItems: "center", flexShrink: 0,
        width: w, height: h, borderRadius: h, padding: 0, border: "none",
        background: checked ? "var(--accent)" : "var(--border-hover)",
        cursor: "pointer",
        transition: "background 0.18s, box-shadow 0.12s, transform 0.08s",
        boxShadow: checked ? "0 0 6px var(--accent-soft, rgba(56,189,248,0.35))" : "none",
      }}
      onMouseEnter={(e) => {
        if (!checked) { e.currentTarget.style.background = "var(--border)"; }
        e.currentTarget.style.boxShadow = "0 0 0 2px var(--accent-soft, rgba(56,189,248,0.28))";
      }}
      onMouseLeave={(e) => {
        if (!checked) { e.currentTarget.style.background = "var(--border-hover)"; }
        e.currentTarget.style.boxShadow = checked ? "0 0 6px var(--accent-soft, rgba(56,189,248,0.35))" : "none";
      }}
      onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.92)"; }}
      onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
    >
      <span style={{
        position: "absolute", top: (h - knob) / 2, left: checked ? w - knob - 2 : 2,
        width: knob, height: knob, borderRadius: "50%",
        background: "#fff",
        transition: "left 0.18s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
      }} />
    </button>
  );
}