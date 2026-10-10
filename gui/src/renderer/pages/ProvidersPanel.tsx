








import React, { useState, useEffect, type JSX } from "react";
import type { ProviderSummary, ModelSpec, ConfigOverview, ConfigFileInfo, SkillInfo, McpServerInfo, LocalModelSpec, ModelServerOverviewDTO, ModelServerTestDTO } from "../../shared/ipc.js";
import { ChevronIcon, PlusIcon, CheckIcon, CloseIcon, RefreshIcon } from "../components/Icon.js";
import { confirmAsync } from "../dialog.js";
import { readCollapseDurMs } from "../collapseTiming.js";





import { kInputBase, kInputToTokens, kInputTitle, tokensToKInput, fmtTokens } from "./contextMath.js";
/* A-1201：思考模式的取值与归一 —— 与主进程/引擎**同源**（core-ts 的 local_models）。 */
import { normalizeThinkingMode, isHybridReasoningModel } from "../../../../core-ts/src/local_models.js";
import { REASONING_PRESETS, useReasoningPreset, saveReasoningPreset, EFFORT_LABEL, THINKING_PRESETS, useThinkingPreset, saveThinkingPreset } from "../reasoning.js";
import {
  describeTierSpec, describeCacheRateSource,
  describeTiersForDisplay, pricingSnapshotMeta, snapshotPricingInfo,
  resolveEffectivePricing, resolveModelPriceTier,
  builtInPriceTiers, createDefaultPriceTiers,
  
  formatPricingAmounts, formatTierAmounts, USD_CNY_RATE,
  
  pricingDisplayCurrency, officialPriceCurrency, formatAmountsInCurrency, isNativePriceCurrency,
  convertFromUsd, toUsdAmount, amountInCurrency, formatAmount, type PriceCurrency, type PriceFieldKey,
  
  classifyProbeOutcome, PROBE_OUTCOME_HINT,
  
  PRICING_VERIFIED_AT, pricingVerifiedAtUnknown,
  type PriceOrigin, type CacheRateSource, type ModelPriceTiers, type ModelPriceTier,
} from "../../../../shared/gen/model-capabilities.js";

interface DraftModel extends ModelSpec { selected: boolean; }






type PriceField = "price_in_usd" | "price_out_usd" | "price_cache_read_usd" | "price_cache_write_usd";
const PRICE_FIELDS: PriceField[] = ["price_in_usd", "price_out_usd", "price_cache_read_usd", "price_cache_write_usd"];

















const PRICE_FIELD_META: Record<PriceField, { label: string; short: string; hint: string }> = {
  price_in_usd: {
    label: "输入（缓存未命中）",
    short: "输入",
    hint: "本次请求中**没有命中缓存**的那部分输入 token 单价。上游 usage 里对应 prompt_tokens 减去 cached_tokens。",
  },
  price_out_usd: {
    label: "输出",
    short: "输出",
    hint: "模型生成 token 的单价（多数模型比输入贵 4-8 倍）。上游 usage 里对应 completion_tokens。",
  },
  price_cache_read_usd: {
    label: "输入（缓存命中）",
    short: "命中",
    hint: "命中缓存前缀的输入 token 单价 —— 它**仍是输入**，只是走了折扣价。"
      + "行业惯例约为未命中价的 1/10（OpenAI / Anthropic 明示 0.1×；DeepSeek 更低，1/10 至 1/50）。"
      + "⚠️ 手填了未命中价却不填它，会让命中部分按全价记账（实测虚高可达 50 倍）。",
  },
  price_cache_write_usd: {
    label: "缓存写入",
    short: "写入",
    hint: "把 prompt 写进缓存的**附加**单价（不是输入 token 的一类）。"
      + "⚠️ 大多数厂商**不单独收这笔**：OpenAI 的 prompt caching 与 DeepSeek 的缓存写入都免费，"
      + "Gemini 显式缓存按存储时长（token-hour）计费、不按 write token。"
      + "目前只有 Anthropic 系明确计费：5 分钟 TTL 收 1.25× 输入价，1 小时 TTL 收 2×。"
      + "留空时 slime 按此规则推导（非 Anthropic 系推定为 0）。",
  },
};




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
  /** A-1201：本地模型的思考模式（auto/on/off）—— 与 API 供应商的 thinking 是两回事。 */
  localThinking: "auto" | "on" | "off";
  thinking?: boolean;
  thinking_efforts?: string[];
  






  rpm: string;
}

function emptyEdit(): EditState {
  return {
    mode: "api-add", key: "", name: "", api_base: "", api_key: "",
    api_format: "auto", models: [], proto: "openai", manualIds: "",
    localPath: "", localLabel: "", ctx_len: "", gpu_layers: "", max_output: "", vision: false,
    localThinking: "auto",
    rpm: "",
  };
}

export default function ProvidersPanel(): JSX.Element {
  const api = React.useRef<any>(null);
  const [providers, setProviders] = React.useState<ProviderSummary[]>([]);
  const [localModels, setLocalModels] = React.useState<LocalModelSpec[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  
  const [refreshing, setRefreshing] = React.useState<Record<string, boolean>>({});

  
  const [edit, setEdit] = React.useState<EditState | null>(null);
  /* ── A-1201：本地推理服务（llama-server）的状态与控制 ────────────────────────
     用户口径要的是「可控」：看得到状态、管得动进程、失败了能读到原话。 */
  const [serverOverview, setServerOverview] = React.useState<ModelServerOverviewDTO | null>(null);
  const [serverLogs, setServerLogs] = React.useState("");
  const [logsOpen, setLogsOpen] = React.useState(false);
  /** 正在忙的模型 id（启动 / 自检中）—— 防连点、并给按钮一个"在做事"的反馈。 */
  const [modelBusy, setModelBusy] = React.useState<string | null>(null);
  /** 每个模型最近一次自检结果（成功显示耗时+样本，失败显示原因）。 */
  const [modelResults, setModelResults] = React.useState<Record<string, ModelServerTestDTO | null>>({});

  const loadServerOverview = React.useCallback(async (): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.modelServerStatus) { return; }
    try { setServerOverview(await a.extras.modelServerStatus() as ModelServerOverviewDTO); } catch { /* 保底：读不到就不显示 */ }
  }, []);

  const handleStartModel = React.useCallback(async (id: string): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.modelServerStart) { showNotice(false, "当前环境不支持启动本地服务"); return; }
    setModelBusy(id);
    try {
      const r = await a.extras.modelServerStart(id) as { ok: boolean; port?: number; error?: string };
      showNotice(r.ok, r.ok ? `已启动（端口 ${r.port}）` : `启动失败：${r.error ?? "未知原因"}`);
      await loadServerOverview();
    } finally { setModelBusy(null); }
  }, [loadServerOverview]);

  const handleTestModel = React.useCallback(async (id: string): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.modelServerTest) { showNotice(false, "当前环境不支持自检"); return; }
    setModelBusy(id);
    try {
      const r = await a.extras.modelServerTest(id) as ModelServerTestDTO;
      setModelResults((prev) => ({ ...prev, [id]: r }));
      await loadServerOverview();
    } catch (e) {
      setModelResults((prev) => ({ ...prev, [id]: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
    } finally { setModelBusy(null); }
  }, [loadServerOverview]);

  const handleStopServer = React.useCallback(async (): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.modelServerStop) { return; }
    const r = await a.extras.modelServerStop() as { ok: boolean; error?: string };
    showNotice(r.ok, r.ok ? "已停止并释放显存（下次对话会自动重新拉起）" : `停止失败：${r.error ?? "未知原因"}`);
    await loadServerOverview();
  }, [loadServerOverview]);

  const handleShowLogs = React.useCallback(async (): Promise<void> => {
    const a = api.current;
    if (logsOpen) { setLogsOpen(false); return; }
    setLogsOpen(true);
    if (!a?.extras?.modelServerLogs) { setServerLogs("（当前环境不支持读取日志）"); return; }
    setServerLogs("（读取中…）");
    const r = await a.extras.modelServerLogs() as { ok: boolean; text: string; error?: string };
    setServerLogs(r.ok ? r.text : `读取失败：${r.error ?? "未知原因"}`);
  }, [logsOpen]);
  /** A-1197：模型列表的搜索词（只作用于**当前这个供应商**的模型清单）。
   *  聚合型供应商（OpenRouter 之类）动辄几百个模型，靠滚动找太费劲。
   *  ⚠️ 过滤只影响**渲染**，绝不能改 `edit.models` 本身 —— 写回用的是**原始索引**
   *  （`updateDraftModel(i, …)`），所以过滤时保留索引、不重排数组。 */
  const [modelQuery, setModelQuery] = React.useState("");
  const [fetching, setFetching] = React.useState(false);
  const [scanDir, setScanDir] = React.useState("");
  const [scanned, setScanned] = React.useState<Array<{ path: string; label: string }> | null>(null);
  
  const [modalError, setModalError] = React.useState<string | null>(null);
  








  const [priceDetailId, setPriceDetailId] = React.useState<string | null>(null);
  











  const [lastDetailId, setLastDetailId] = React.useState<string | null>(null);

  

  const detailBoxRef = React.useRef<HTMLDivElement | null>(null);
  const modalScrollRef = React.useRef<HTMLDivElement | null>(null);

  

  React.useEffect(() => {
    if (!priceDetailId) { return; }
    const timer = window.setTimeout(() => {
      const box = modalScrollRef.current;
      const el = detailBoxRef.current;
      if (!el) { return; }
      if (!box) { el.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
      const elRect = el.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const delta = (elRect.top - boxRect.top) + elRect.height / 2 - boxRect.height / 2;
      box.scrollTo({ top: box.scrollTop + delta, behavior: "smooth" });
    }, readCollapseDurMs() + 20);
    return () => window.clearTimeout(timer);
  }, [priceDetailId]);

  
  const [debugOpen, setDebugOpen] = React.useState(false);
  
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
    setPriceDetailId(null);
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
      /* A-1201：进页面就把推理服务的**真实状态**拉一次（不让用户先去点刷新才知道服务在不在）。 */
      void loadServerOverview();
    }
  }, [refreshAll, loadServerOverview]);

  
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
      
      models: p.models.map((m) => ({ ...m, selected: (m as DraftModel).selected !== false })),
      proto: "openai", manualIds: p.models.map((m) => m.id).join("\n"),
    localPath: "", localLabel: "", ctx_len: "", gpu_layers: "", max_output: "", vision: false, thinking: undefined, thinking_efforts: undefined,
      
      rpm: p.rpm !== undefined ? String(p.rpm) : "",
          localThinking: "auto",
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
      
      localPath: m.path, localLabel: m.label ?? m.id,
       ctx_len: m.ctx_len ? String(m.ctx_len) : "",
       gpu_layers: m.gpu_layers !== undefined ? String(m.gpu_layers) : "",
       max_output: m.max_output ? String(m.max_output) : "",
       vision: m.vision === true,
       localThinking: normalizeThinkingMode(m.thinking),
       
       rpm: "",
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
        
        
        const models = res.models.map((m: ModelSpec) => ({ ...m, selected: m.selected !== false }));
        setEdit({ ...edit, models, proto: "openai" });
        showNotice(true, `探测成功：发现 ${res.models.length} 个模型（已自动启用，元数据已填充，可在列表中调整）`);
      } else {
        
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

  
  function applyManualIds(): void {
    if (!edit) { return; }
    const ids = edit.manualIds.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const merged: DraftModel[] = ids.map((id) => {
      const prev = edit.models.find((m) => m.id === id);
      return prev ?? { id, selected: false };
    });
    setEdit({ ...edit, models: merged });
  }

  


  function manualModelsSync(): DraftModel[] {
    if (!edit || edit.proto !== "manual") { return edit?.models ?? []; }
    const ids = edit.manualIds.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return ids.map((id) => {
      const prev = edit.models.find((m) => m.id === id);
      return prev ?? { id, selected: false };
    });
  }

  
  function toggleAllModels(on: boolean): void {
    if (!edit) { return; }
    setEdit({ ...edit, models: edit.models.map((m) => ({ ...m, selected: on })) });
  }

  /** A-1197：换供应商（或换编辑目标）时清空搜索词。
   *  不清的话，上一个供应商的搜索词会在下一个身上继续生效，
   *  表现为「列表看着是空的、其实是被过滤掉了」—— 这种假象比没有搜索还糟。 */
  React.useEffect(() => {
    setModelQuery("");
  }, [edit?.key, edit?.mode]);

  /** A-1197：按搜索词筛出要渲染的模型行，**保留原始索引**。
   *
   *  为什么强调索引：`updateDraftModel(index, patch)` 是按**原始数组下标**写回的；
   *  过滤后若重排名次（用 filter 后的下标），开关一拨就会改到**另一个模型**上 ——
   *  这类错位在界面上看不出来（那一行显示的还是你以为的那个模型），是典型的静默改错。
   *  ⇒ 所以只做「筛行」，行里永远带着原始 `i`。 */
  const visibleModelRows = React.useMemo((): Array<{ m: DraftModel; i: number }> => {
    if (!edit) { return []; }
    const rows = edit.models.map((m, i) => ({ m, i }));
    const q = modelQuery.trim().toLowerCase();
    if (q === "") { return rows; }
    return rows.filter(({ m }) => {
      const id = String(m.id ?? "").toLowerCase();
      const label = String((m as { label?: string }).label ?? "").toLowerCase();
      return id.includes(q) || label.includes(q);
    });
  }, [edit, modelQuery]);

  function updateDraftModel(index: number, patch: Partial<DraftModel>): void {
    if (!edit) { return; }
    setEdit({
      ...edit,
      models: edit.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    });
  }

  

















  function updateDraftPrice(index: number, field: PriceField, raw: string): void {
    const cur = edit?.models[index];
    if (!cur) { return; }
    const trimmed = raw.trim();
    let v: number | undefined;
    if (trimmed !== "") {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) { return; } 
      v = toUsdAmount(n, pricingDisplayCurrency(cur.id, cur.price_currency));
    }
    const next = { ...cur, [field]: v } as DraftModel;
    
    
    const stillManual = PRICE_FIELDS.some((f) => typeof (next as unknown as Record<string, unknown>)[f] === "number");
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
          thinking: edit.localThinking,
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
      
      const modelsForSave = manualModelsSync();
      
      const models = modelsForSave.map((m) => ({
        id: m.id,
        context_window: m.context_window || undefined,
        max_output: m.max_output || undefined,
        vision: m.vision === true,
        selected: m.selected === true,
        
        
        price_in_usd: m.price_in_usd ?? undefined,
        price_out_usd: m.price_out_usd ?? undefined,
        price_cache_read_usd: m.price_cache_read_usd ?? undefined,
        price_cache_write_usd: m.price_cache_write_usd ?? undefined,
        
        price_source: m.price_source,
        
        rpm: m.rpm ?? undefined,
      }));
      const res = await api.current.providers.save({
        key: edit.name.trim(),
        api_base: edit.api_base.trim(),
        api_key: edit.api_key.trim() || undefined,
        
        api_format: edit.api_format,
        models,
        
        
        rpm: parseRpmInput(edit.rpm),
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
    
    <div className="settings-pane" style={{ padding: "16px 0", overflowY: "auto", height: "100%" }}>
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

      {}
      {edit && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(2, 6, 23, 0.66)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { closeModal(); } }}>
          {














}
          <div className="modal-card" style={{ width: 1000, maxWidth: "96vw", maxHeight: "92vh", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12, flexShrink: 0 }}>
              <h3 style={{ margin: 0, flex: 1 }}>
                {edit.mode === "api-add" && "添加 API 供应商"}
                {edit.mode === "api-edit" && `编辑供应商「${edit.key}」`}
                {edit.mode === "local-add" && "添加本地模型"}
                {edit.mode === "local-edit" && `编辑本地模型「${edit.key}」`}
              </h3>
              <button className="titlebar-btn" onClick={closeModal} title="关闭"><CloseIcon size={12} /></button>
            </div>

            {}
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

            {




}
            <div ref={modalScrollRef} style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: 4, scrollbarGutter: "stable" }}>
            {edit.mode === "api-add" || edit.mode === "api-edit" ? (
              <>
                {}
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

                {}
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

                {



}
                <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 80 }}>RPM 兜底</span>
                  <input className="input-field" type="number" min={1} step={1}
                    style={{ maxWidth: 140 }}
                    placeholder="留空 = 不限制"
                    value={edit.rpm}
                    onChange={(e) => setEdit({ ...edit, rpm: e.target.value })}
                    title={"上游每分钟请求数（RPM）上限 —— 限流的**最后兜底**。\n\n"
                      + "取值优先级：探针实测（上游响应头）> 手填（这里）> 内置能力表声明 > 未知（不限制）。\n"
                      + "何时该填：探针拿不到上游限额、且内置表也没有该厂商的官方档位时，\n"
                      + "可按官方控制台/合同/文档填一个值，避免被上游限流（429 / 生成中途断流）。\n"
                      + "⚠️ 留空 ≠ 无限：只是我们不主动限制，上游该限还是会限。想要绝对安全就填一个略低于官方档位的数。"} />
                  <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1, overflowWrap: "break-word" }}>
                    每分钟最多请求数（探针实测 &gt; 此处手填 &gt; 内置表；留空 = 不主动限制）
                  </span>
                </div>

                {

}
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8, flexShrink: 0 }}>
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
                    <div className="provider-model-table" style={{ maxHeight: 420, overflow: "auto", marginBottom: 10, scrollbarGutter: "stable" }}>
                      {

}
                      {}
                      <div style={{
                        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
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
                        {



}
                        <span
                          title={`权威价目快照同步于 ${pricingSnapshotMeta().generatedAt}，共 ${pricingSnapshotMeta().count} 条`
                            + `\n来源：${pricingSnapshotMeta().litellmUrl}\n      ${pricingSnapshotMeta().openrouterUrl}`
                            + "\n刷新方式：仓库根目录执行 node scripts/sync-model-pricing.mjs（快照是**构建期产物**，不在运行时联网抓取 —— 否则成本统计会依赖第三方可达性）"}
                          style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
                          快照 {pricingSnapshotMeta().generatedAt} · {pricingSnapshotMeta().count} 条
                        </span>
                        <span style={{ fontSize: 11.5, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>共 {edit.models.length} 个 · 聊天界面只显示已启用</span>
                        {/* A-1197：模型搜索栏 —— 放在 sticky 表头内（长列表滚动时也常驻），
                            独占一行（flexBasis 100%），正对下方模型列表；只筛显示，不动配置。 */}
                        <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <input
                            className="input-field"
                            value={modelQuery}
                            onChange={(e) => setModelQuery(e.target.value)}
                            placeholder={`搜索模型 ID（共 ${edit.models.length} 个）`}
                            title="只筛当前供应商的模型清单，不改动任何启用状态与配置"
                            style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12.5, padding: "4px 10px" }}
                          />
                          {modelQuery.trim() !== "" && (
                            <>
                              <span style={{ fontSize: 11.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                                {visibleModelRows.length} / {edit.models.length}
                              </span>
                              <button className="btn" style={{ fontSize: 11.5, padding: "3px 10px", whiteSpace: "nowrap" }}
                                onClick={() => setModelQuery("")}>清除</button>
                            </>
                          )}
                        </div>
                      </div>
                      {






















}
                      {






}
                      {(() => {
                        if (!edit) { return null; }
                        const suspicious = edit.models
                          .map((mm, idx) => ({ idx, id: mm.id, eff: resolveEffectivePricing(mm.id, edit.api_base, mm) }))
                          .filter((x) => x.eff.suspiciousStored !== undefined);
                        if (suspicious.length === 0) { return null; }
                        return (
                          <div style={{
                            margin: "0 0 8px", padding: "6px 9px", borderRadius: 6,
                            fontSize: 11.5, lineHeight: 1.55, color: "var(--warning)",
                            background: "rgba(210,153,34,0.10)", border: "1px solid rgba(210,153,34,0.35)",
                            display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", minWidth: 0,
                          }}>
                            <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              title={suspicious.map((x) => {
                                const s = x.eff.suspiciousStored!;
                                return `${x.id}：存值 $${formatAmount(s.storedIn)} vs 官方 $${formatAmount(s.tableIn)}（偏离 ${formatAmount(s.ratio >= 1 ? s.ratio : 1 / s.ratio)} ${s.ratio >= 1 ? "倍" : "分之一"}）`;
                              }).join("\n")}>
                              ⚠️ 全量检查：{suspicious.length} 个模型的存值与官方价偏离 ≥5 倍（疑似历史错值）：
                              {suspicious.map((x) => x.id).join("、")}
                            </span>
                            <button
                              className="btn"
                              style={{ fontSize: 10.5, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0, color: "var(--warning)" }}
                              title="对这些模型清空四个手填单价与「手填」标记（保留峰谷分时档），恢复按内置价目表自动取值"
                              onClick={() => {
                                if (!edit) { return; }
                                const flagged = new Set(suspicious.map((x) => x.idx));
                                setEdit({
                                  ...edit,
                                  models: edit.models.map((mm, j) => (flagged.has(j) ? {
                                    ...mm,
                                    price_in_usd: undefined, price_out_usd: undefined,
                                    price_cache_read_usd: undefined, price_cache_write_usd: undefined,
                                    price_source: undefined,
                                  } : mm)),
                                });
                              }}
                            >
                              一键全部恢复内置表
                            </button>
                          </div>
                        );
                      })()}
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
                          <th style={{ padding: "5px 6px 5px 8px", width: "9%", whiteSpace: "nowrap" }}>启用</th>
                          <th style={{ padding: "5px 8px" }}>模型 ID</th>
                          <th style={{ padding: "5px 6px", width: "9.5%", whiteSpace: "nowrap" }} title="上下文窗口，单位 K token。换算的进制按**该行存量值**自适应（能写成整数 K 的进制优先）—— 见每行输入框的悬停提示。">上下文K</th>
                          <th style={{ padding: "5px 6px", width: "9.5%", whiteSpace: "nowrap" }} title="最大输出，单位 K token。进制同「上下文K」，按该行存量值自适应（见输入框悬停提示）。">输出K</th>
                          <th style={{ padding: "5px 6px", width: "6.5%", whiteSpace: "nowrap" }} title="支持图片输入">图片</th>
                          {






}
                          <th style={{ padding: "5px 6px", width: "26%", whiteSpace: "nowrap" }} title="这是「引擎实际计费」所用的价格来源（不是配置里存了什么）。优先级：手填/上游结算价 > 本地端点免费 > 峰谷分时档 > 内置价目表 > 残留存值 > 未定价。**点击可展开价目明细**（单价录入 / 币种选择 / 缓存命中与写入费率 / 峰谷档全在明细栏里）。">定价来源</th>
                        </tr>
                      </thead>
                        <tbody>
                          {visibleModelRows.map(({ m, i }) => (
                            <React.Fragment key={m.id}>
                            <tr style={{ borderTop: "1px solid var(--border)" }}>
                              <td style={{ padding: "5px 6px 5px 8px" }}>
                                <ToggleSwitch
                                  checked={m.selected}
                                  onChange={(v) => updateDraftModel(i, { selected: v })}
                                  title={`${m.selected ? "停用" : "启用"} ${m.id}`}
                                />
                              </td>
                              {




}
                              <td style={{ padding: "5px 8px" }}>
                                <span title={m.id} style={{
                                  display: "block",
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}>{m.id}</span>
                              </td>
                              <td style={{ padding: "5px 6px" }}>
                                <input type="number" min={0} placeholder="auto"
                                  title={kInputTitle("上下文窗口", kInputBase(m.context_window))}
                                  value={tokensToKInput(m.context_window)}
                                  onChange={(e) => {
                                    updateDraftModel(i, { context_window: kInputToTokens(e.target.value, kInputBase(m.context_window)) });
                                  }}
                                  style={cellInputStyle()} />
                              </td>
                              <td style={{ padding: "5px 6px" }}>
                                <input type="number" min={0} placeholder="auto"
                                  title={kInputTitle("最大输出", kInputBase(m.max_output))}
                                  value={tokensToKInput(m.max_output)}
                                  onChange={(e) => {
                                    updateDraftModel(i, { max_output: kInputToTokens(e.target.value, kInputBase(m.max_output)) });
                                  }}
                                  style={cellInputStyle()} />
                              </td>
                              <td style={{ padding: "5px 6px" }}>
                                <input type="checkbox" checked={m.vision === true} title="支持图片输入"
                                  onChange={(e) => updateDraftModel(i, { vision: e.target.checked })} />
                              </td>
                              <td style={{ padding: "5px 6px", whiteSpace: "nowrap", overflow: "hidden" }}>
                                <PriceOriginBadges
                                  m={m} baseUrl={edit.api_base}
                                  expanded={priceDetailId === m.id}
                                  onToggle={() => {
                                    
                                    
                                    const next = priceDetailId === m.id ? null : m.id;
                                    if (next) { setLastDetailId(next); }
                                    setPriceDetailId(next);
                                  }}
                                />
                              </td>
                            </tr>
                            {













}
                            <tr>
                              <td colSpan={6} style={{ padding: 0, border: "none" }}>
                                <div className={`collapse${edit && priceDetailId === m.id ? " is-open" : ""}`}>
                                <div>
                                {(() => {
                                  
                                  
                                  
                                  const detailId = priceDetailId ?? lastDetailId;
                                  
                                  if (detailId !== m.id) { return null; }
                                  const idx = edit ? edit.models.findIndex((mm) => mm.id === m.id) : -1;
                                  const mm = edit && idx >= 0 ? edit.models[idx] : undefined;
                                  if (!mm) { return null; }
                                  return (
                                  <div ref={detailBoxRef} style={{
                                    marginTop: 10, marginBottom: 4, maxHeight: 560, overflowY: "auto", scrollbarGutter: "stable",
                                    border: "1px solid var(--border-hover)", borderRadius: 10,
                                    background: "var(--bg-secondary)", padding: "10px 12px 12px",
                                  }}>
                                      <PriceDetailRow
                                        





                                        key={mm.id}
                                        m={mm} baseUrl={edit.api_base}
                                        onChange={(f, raw) => updateDraftPrice(idx, f, raw)}
                                        onTiersChange={(t) => updateDraftModel(idx, { price_tiers: t })}
                                        onCurrencyChange={(c) => updateDraftModel(idx, { price_currency: c })}
                                        onClearManual={() => updateDraftModel(idx, {
                                          price_in_usd: undefined, price_out_usd: undefined,
                                          price_cache_read_usd: undefined, price_cache_write_usd: undefined,
                                          price_source: undefined,
                                        })}
                                        onClose={() => setPriceDetailId(null)}
                                      />
                                  </div>
                                  );
                                })()}
                                </div>
                                </div>
                              </td>
                            </tr>
                            </React.Fragment>
                          ))}
                          {/* A-1197：搜不到时的显式说明 —— 空白表格会被误读成「这个供应商没有模型」，
                              而真相只是被搜索词筛掉了。 */}
                          {visibleModelRows.length === 0 && (
                            <tr>
                              <td colSpan={7} style={{ padding: "12px 8px", fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
                                没有匹配「{modelQuery.trim()}」的模型（该供应商共 {edit.models.length} 个）。
                                <button className="btn" style={{ fontSize: 11.5, padding: "2px 9px", marginLeft: 8 }}
                                  onClick={() => setModelQuery("")}>清除搜索</button>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                {

}
                </div>{/* ③ 模型调试 闭（A-999：此前这个 </div> 丢失，导致 Fragment 解析崩 202 处） */}
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
                {/* ── A-1201：本地模型运行参数（重做）────────────────────────────
                    用户口径：「参数调整有点简陋……又晦涩，又不简洁明了」。
                    三处具体病灶（都改掉了）：
                      · `上下文 ctx_len (K)` —— 用 K 作单位，用户根本不知道填的是不是 token；
                      · `GPU 层数 auto（默认 99）` —— 99 是「全部层」的魔法数字，没人猜得到；
                      · 没有一句说明 —— 填错了只能靠撞。
                    现在：分组 + 每项一句人话 + 单位写全（tokens/层），并把默认值讲清楚。 */}
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", margin: "2px 0 6px" }}>
                  运行参数
                  <span style={{ fontWeight: 400, color: "var(--text-dim)", marginLeft: 8 }}>
                    留空 = 用推荐值，不需要全部填
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
                  {/* 上下文长度：单位写全是 tokens；不再用 K */}
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 4 }}>
                      上下文长度 <span style={{ color: "var(--text-dim)" }}>tokens</span>
                    </div>
                    <input className="input-field" type="number" min={0} step={1024}
                      placeholder="32768（推荐）"
                      title="模型一次能记住多少内容（提问 + 回复）。越大越吃显存；显存不够时调小，例如 8192。"
                      value={edit.ctx_len}
                      onChange={(e) => setEdit({ ...edit, ctx_len: e.target.value })} />
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3, lineHeight: 1.5 }}>
                      {edit.ctx_len && Number(edit.ctx_len) > 0
                        ? `即 ${fmtTokens(Number(edit.ctx_len), Number(edit.ctx_len))} —— 多轮对话超了会被截断`
                        : "模型一次能记住多少内容。显存不够就调小（如 8192）"}
                    </div>
                  </div>

                  {/* GPU 层数：把 99 这个魔法数字换成人话 */}
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 4 }}>
                      显存 / 显卡
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text)", cursor: "pointer" }}>
                      <input type="checkbox"
                        checked={edit.gpu_layers === "99" || edit.gpu_layers === ""}
                        onChange={(e) => setEdit({ ...edit, gpu_layers: e.target.checked ? "99" : "0" })} />
                      全部层放显卡（最快）
                    </label>
                    {!(edit.gpu_layers === "99" || edit.gpu_layers === "") && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                        <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>只放前</span>
                        <input className="input-field" type="number" min={0} placeholder="0" style={{ width: 90 }}
                          value={edit.gpu_layers}
                          onChange={(e) => setEdit({ ...edit, gpu_layers: e.target.value })} />
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>层</span>
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3, lineHeight: 1.5 }}>
                      {edit.gpu_layers === "99" || edit.gpu_layers === ""
                        ? "全部层交给显卡跑。显存不足会启动失败 —— 那时改选下面这项。"
                        : "剩余层用 CPU 跑，慢但显存占用低。"}
                    </div>
                  </div>
                </div>

                {/* 思考模式：这是「小模型不出话」的开关，必须在显眼处 */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 4 }}>
                    思考模式
                    {isHybridReasoningModel(edit.name) && (
                      <span style={{ fontSize: 10.5, marginLeft: 6, padding: "1px 6px", borderRadius: 6,
                        background: "var(--accent-soft)", color: "var(--accent-hover)" }}>
                        检测到推理型模型
                      </span>
                    )}
                  </div>
                  <select className="input-field" value={edit.localThinking}
                    onChange={(e) => setEdit({ ...edit, localThinking: normalizeThinkingMode(e.target.value) })}>
                    <option value="auto">自动（推荐）—— 保证有正文</option>
                    <option value="off">关 —— 直接回答，最快</option>
                    <option value="on">开 —— 先思考再回答</option>
                  </select>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3, lineHeight: 1.5 }}>
                    {edit.localThinking === "on"
                      ? "模型会先把思考过程写出来再回答。小参数模型容易把输出额度耗在思考上 ⇒ 可能只看到思考、看不到答案。"
                      : edit.localThinking === "off"
                        ? "不要思考过程，直接给答案。最省时间，适合日常对话。"
                        : "推理型模型（qwen3 / deepseek-r1 等）默认先思考，这里会自动帮你关掉 —— 否则小模型常常只输出思考、正文为空。"}
                  </div>
                </div>

                {/* 最大输出：留空 = 自动。不再用 K，也不与 ctx 抢注意力 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 4 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 4 }}>
                      单次最多输出 <span style={{ color: "var(--text-dim)" }}>tokens</span>
                    </div>
                    <input className="input-field" type="number" min={0} placeholder="留空 = 自动"
                      title="模型一次回复最多写多少 token。留空时按模型能力自动决定。"
                      value={edit.max_output}
                      onChange={(e) => setEdit({ ...edit, max_output: e.target.value })} />
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3, lineHeight: 1.5 }}>
                      限制一次回复的长度。留空即可。
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 4 }}>图片输入</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text)", cursor: "pointer", marginTop: 2 }}>
                      <input type="checkbox" checked={edit.vision} onChange={(e) => setEdit({ ...edit, vision: e.target.checked })} />
                      这个模型能看图（需模型本身是多模态）
                    </label>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3, lineHeight: 1.5 }}>
                      勾了才会把图片发给它；纯文本模型勾了会出错。
                    </div>
                  </div>
                </div>
              </>
            )}

            {}
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
              {

}
              <div className={`collapse${debugOpen ? " is-open" : ""}`}>
              <div>
                <div style={{ padding: 12 }}>
                  {
}
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
                  {

}
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
              </div>
              </div>{/* A-1015：debugOpen 闭 —— 原为 {debugOpen && (…)} 条件渲染，现常驻 + 高度插值 */}
            </div>
            </div>{/* 滚动内容区 闭 —— ③/明细/④ 全在其中，留白只出现在最底部 */}

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

      {}
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", margin: "4px 0 8px" }}>
        API 供应商（{providers.length}）
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, minHeight: 0 }}>
        {providers.map((p) => (
          <div key={p.key} className="card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            {}
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", lineHeight: 1.4, marginBottom: 8, wordBreak: "break-all", overflowWrap: "break-word", flexShrink: 0 }}
              title={p.key}>{p.key}</div>
            {}
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
            {}
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

      {}
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
              {m.ctx_len ? `上下文 ${m.ctx_len} · ` : ""}{m.gpu_layers !== undefined ? `GPU ${m.gpu_layers} 层 · ` : ""}
              {m.thinking === "on" ? "思考：开" : m.thinking === "off" ? "思考：关" : "思考：自动"}
            </div>
            {/* A-1201：模型的三个动作（启动 / 自检 / 日志）—— 用户口径要的「可控」。
                为什么要「自检」：本地模型最常见的失败是"服务起来了但模型不说话"，
                光看状态是绿的、实际不可用；自检**真发一次请求**并如实回报。 */}
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <button className="btn" style={{ padding: "2px 10px", fontSize: 11.5 }}
                disabled={modelBusy === m.id}
                onClick={() => void handleStartModel(m.id)}>
                {modelBusy === m.id ? "处理中…" : "启动"}
              </button>
              <button className="btn primary" style={{ padding: "2px 10px", fontSize: 11.5 }}
                disabled={modelBusy === m.id}
                title="真发一次最小请求：能通、有正文、耗时多少 —— 一次看清楚"
                onClick={() => void handleTestModel(m.id)}>
                {modelBusy === m.id ? "自检中…" : "自检"}
              </button>
            </div>
            {modelResults[m.id] && (
              <div style={{
                marginTop: 6, padding: "6px 9px", borderRadius: 7, fontSize: 11.5, lineHeight: 1.55,
                background: modelResults[m.id]!.ok ? "var(--success-soft)" : "var(--danger-soft)",
                color: modelResults[m.id]!.ok ? "#22c55e" : "#f87171",
              }}>
                {modelResults[m.id]!.ok
                  ? `✓ 可用（${modelResults[m.id]!.ms}ms）${modelResults[m.id]!.sample ? `：${modelResults[m.id]!.sample}` : ""}`
                  : `✗ ${modelResults[m.id]!.error}`}
              </div>
            )}
          </div>
        ))}
        {localModels.length === 0 && (
          <div style={{ gridColumn: "1 / -1", color: "var(--text-dim)", textAlign: "center", padding: 24, fontSize: 13 }}>
            暂无本地模型 — 点击"<PlusIcon size={11} /> 本地模型"导入 GGUF 文件（将作为 local:&lt;名称&gt; 出现在模型切换中）
          </div>
        )}
      </div>

      {/* ── A-1201：本地推理服务（llama-server）状态与控制 ───────────────────────
          用户口径：「下载好的 llama 服务 slime 无法使用……内嵌一个可控的 llama 服务网关」。
          此前这一整块是**看不见**的：服务起没起、在哪个端口、为什么失败，界面上都没有。
          现在给到「状态 + 启停 + 日志」三件套，失败时能直接读到 llama-server 的原话。 */}
      <div style={{ marginTop: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", flex: 1 }}>
            推理服务（llama-server）
          </div>
          <button className="btn" style={{ padding: "3px 10px", fontSize: 11.5 }}
            onClick={() => void loadServerOverview()}>刷新</button>
          <button className="btn" style={{ padding: "3px 10px", fontSize: 11.5 }}
            title="查看 llama-server 最近的输出（启动失败 / 显存不足的第一手证据）"
            onClick={() => void handleShowLogs()}>
            {logsOpen ? "收起日志" : "查看日志"}
          </button>
          <button className="btn danger" style={{ padding: "3px 10px", fontSize: 11.5 }}
            title="停止服务并释放显存（下次对话会自动重新拉起）"
            onClick={() => void handleStopServer()}>
            停止并释放显存
          </button>
        </div>

        {serverOverview && !serverOverview.llamaBinOk && (
          <div style={{ padding: "7px 10px", marginBottom: 8, borderRadius: 8, fontSize: 12,
            background: "var(--danger-soft)", color: "#f87171", lineHeight: 1.6 }}>
            未找到 llama-server 可执行文件{serverOverview.llamaBin ? `（${serverOverview.llamaBin}）` : ""} ——
            请到「设置 → 运行环境」下载，或确认安装包完整。
          </div>
        )}

        {serverOverview && serverOverview.items.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {serverOverview.items.map((it) => {
              const stateText = it.state === "ready" ? "就绪" : it.state === "loading" ? "加载中" : it.state === "unloading" ? "卸载中" : "未运行";
              const good = it.state === "ready";
              return (
                <div key={it.role} className="card" style={{ padding: "9px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{it.role === "chat" ? "对话模型" : "向量模型"}</span>
                    <span style={{
                      fontSize: 11, padding: "1px 8px", borderRadius: 7, fontWeight: 600,
                      background: good ? "rgba(0,200,120,.15)" : "var(--bg-hover)",
                      color: good ? "#22c55e" : "var(--text-muted)",
                    }}>{stateText}</span>
                    {it.external && <span style={chipStyle("var(--bg-hover)", "var(--text-muted)")}>外部实例</span>}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "Consolas, monospace" }}>
                      {it.port ? `端口 ${it.port}` : ""}{it.pid ? ` · PID ${it.pid}` : ""}
                      {it.vramGb !== null ? ` · 显存 ${it.vramGb.toFixed(1)}G` : ""}
                    </span>
                  </div>
                  {it.model && (
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 3, wordBreak: "break-all" }}>{it.model}</div>
                  )}
                  {it.error && (
                    <div style={{ fontSize: 11.5, color: "#f87171", marginTop: 4, lineHeight: 1.55 }}>{it.error}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {logsOpen && (
          <pre style={{
            marginTop: 8, padding: 10, borderRadius: 8, maxHeight: 220, overflow: "auto",
            background: "var(--bg-input)", border: "1px solid var(--border)",
            fontSize: 11, lineHeight: 1.5, color: "var(--text-secondary)",
            fontFamily: "Consolas, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}>{serverLogs || "（读取中…）"}</pre>
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





function fmtPrice(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) { return ""; }
  return String(Number(n.toFixed(6)));
}














function parseRpmInput(raw: string): number | undefined {
  const s = (raw ?? "").trim();
  if (!s) { return undefined; }
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) { return undefined; }
  return n;
}


const ORIGIN_META: Record<PriceOrigin, { text: string; color: string; bg: string }> = {
  customTier: { text: "自定义分时", color: "var(--accent, #8b7bf7)", bg: "rgba(139,123,247,0.14)" },
  manual: { text: "手填", color: "var(--accent, #8b7bf7)", bg: "rgba(139,123,247,0.14)" },
  upstream: { text: "上游", color: "var(--success)", bg: "var(--success-soft)" },
  local: { text: "本地免费", color: "var(--success)", bg: "var(--success-soft)" },
  tier: { text: "分时价", color: "var(--accent, #8b7bf7)", bg: "rgba(139,123,247,0.12)" },
  table: { text: "内置表", color: "var(--text-secondary)", bg: "rgba(127,127,127,0.14)" },
  snapshot: { text: "快照兜底", color: "var(--text-secondary)", bg: "rgba(127,127,127,0.10)" },
  stored: { text: "残留值", color: "var(--text-dim)", bg: "rgba(127,127,127,0.10)" },
  none: { text: "未定价", color: "var(--warning)", bg: "rgba(210,153,34,0.12)" },
};

















type PriceView = "tier" | "manual";

const PRICE_VIEW_TABS: Array<{ id: PriceView; label: string; hint: string }> = [
  {
    id: "tier",
    label: "分时（峰谷）定价",
    hint: "按时段自动切换的档位价（DeepSeek 等）。显示时段表 / 档位单价 / 兜底档；"
      + "勾选后不再显示手动单价输入框，避免两套价并存时看不清哪套在生效。",
  },
  {
    id: "manual",
    label: "手动单价",
    hint: "手填一个固定价（议价 / 合同价 / 网关按上下文加价时用）。"
      + "它**压过内置分时价**（自定义分时档除外）；清空四个框即恢复按时段计价。",
  },
];

const ORIGIN_HINT: Record<PriceOrigin, string> = {
  customTier: "本行按**你自己配置的分时档位**计价（面板里可改时段与单价）。自定义分时的级别高于手填平铺价与内置价目表，也高于自动探测价。",
  manual: "用户手填单价 —— 自动探测/一键刷新不会覆盖。清空右侧两个单价框即可恢复自动取值。",
  upstream: "来自上游 /models 或网关 /api/pricing 的真实结算价（最权威）。上游**显式给 0** 表示该模型免费（OpenRouter 官方契约：pricing 各字段 \"A value of \\\"0\\\" indicates the feature is free\"），这里会如实按 0 采纳 —— 只有在**字段缺失**时才回落到内置表。",
  local: "本地 / 内网端点：没有按 token 计费的账单，成本恒为 0。若这里其实是要计费的托管端点，请在右侧手填单价（手填即覆盖）。",
  tier: "内置价目表的分时档 —— 按每条记录**自己的时刻**取档，本行显示的是该时刻的档位价。",
  table: "来自 slime 内置家族价目表（一手：逐条核对厂商官方定价页后的刊例价）。上游探测不到价时的离线兜底，可能滞后于官方调价。",
  snapshot: "来自权威镜像快照（LiteLLM 模型成本表 / OpenRouter 实时目录）—— **二手价**，主要用于内置表没有覆盖的长尾模型。厂商调价后快照可能滞后几小时到几天，界面把它与「内置表」分开标就是为了让你能一眼分辨哪些价需要复核。快照的新鲜度见定价面板底部的同步时间；刷新它 = 在仓库根目录跑 `node scripts/sync-model-pricing.mjs`。",
  stored: "历史遗留值，没有来源标记。下次「一键刷新」会尝试用上游价 / 内置表价取代它。",
  none: "既没探测到上游价、也不在内置表中 —— 该模型的消耗会记成 $0。请在右侧手填单价（USD / 1M tokens）。",
};
















function PriceOriginBadges({ m, baseUrl, expanded, onToggle }: {
  m: DraftModel; baseUrl: string; expanded: boolean; onToggle: () => void;
}): JSX.Element {
  const eff = resolveEffectivePricing(m.id, baseUrl, m);
  const userTiers = m.price_tiers;
  
  const tierSpec = userTiers ?? builtInPriceTiers(m.id);
  const meta = ORIGIN_META[eff.origin];
  
  
  
  const tierActive = !!tierSpec && (eff.origin === "table" || eff.origin === "tier" || eff.origin === "customTier");

  const lines = [`【${meta.text}】${ORIGIN_HINT[eff.origin]}`];
  if (eff.origin === "none") {
    lines.push("计费单价：未知（按 $0 记账）");
  } else {
    
    
    lines.push(`计费单价：${formatPricingAmounts(eff) ?? `${fmtPrice(eff.priceIn)} / ${fmtPrice(eff.priceOut)} USD per 1M tokens`} tokens`);
    
    
    
    
    if (tierSpec && (eff.origin === "table" || eff.origin === "tier")) {
      lines.push("（该模型有分时（峰谷）规格：上面这个数是**平铺 / 高峰标准价**，"
        + "此刻实际按哪一档计费见下面逐档列表里标「← 此刻命中」的那一条；展开价目明细会直接显示当前档位价。）");
    }
    if (typeof eff.priceInCny === "number" && eff.usdDerivedFromCny) {
      lines.push(`（美元价是按 ¥${USD_CNY_RATE}/USD **折算**的近似值 —— 官方定价页是人民币计价，`
        + "官方美元价另有一套且**非等比换算**，不要拿两边数值互相对照。）");
    }
    if (eff.origin === "customTier") {
      lines.push(`当前命中档位：${eff.label ?? eff.tierId ?? "—"}（按 ${eff.timezone ?? "Asia/Shanghai"} 的墙上时间判定）`);
    }
    
    if (typeof eff.priceCacheRead === "number") {
      lines.push(`缓存命中 ${fmtPrice(eff.priceCacheRead)} USD / 1M（${describeCacheRateSource(eff.cacheRateReadSource ?? "none", eff.priceCacheRead).text}）`);
    }
    if (typeof eff.priceCacheWrite === "number") {
      lines.push(`缓存写入 ${fmtPrice(eff.priceCacheWrite)} USD / 1M（${describeCacheRateSource(eff.cacheRateWriteSource ?? "none", eff.priceCacheWrite).text}）`);
    }
  }
  if (eff.superseded) {
    lines.push(`⚠️ 配置里存着 ${fmtPrice(eff.superseded.priceIn)}，但引擎**不采用**它（级别低于 ${meta.text}）。清空右侧单价框可清掉这条残留。`);
  }
  if (tierSpec) {
    
    
    lines.push("该模型当前生效的分时规格（**全部**峰/谷时段）：");
    for (const t of describeTiersForDisplay(tierSpec, new Date())) {
      const amt = formatTierAmounts(t);
      const cny = amt.cny ? ` ＋ 官方 ¥ ${amt.cny.replace(/¥/g, "")}` : "";
      const money = typeof t.priceOut === "number"
        ? `输入 ${fmtPrice(t.priceIn)} / 输出 ${fmtPrice(t.priceOut)}` : `输入 ${fmtPrice(t.priceIn)}`;
      lines.push(`  · ${t.label}（${money} USD / 1M${cny}）${t.isFallback ? "（兜底档：其余所有时间）" : ""}${t.active === true ? " ← 此刻命中" : ""}`);
      for (const l of t.windowLines) { lines.push(`      ${l}`); }
    }
    lines.push(`  时区：${tierSpec.timezone}`);
    if (!tierActive) {
      lines.push(`本行当前**不走分时价**（${meta.text} 压过分时）。想让时段生效 → 清空右侧两个单价框。`);
    } else {
      
      const now = resolveModelPriceTier(m.id, new Date());
      if (!userTiers && now.tiered) {
        const amt = formatTierAmounts(now.pricing);
        const cny = amt.cny ? ` ＋ ¥ ${amt.cny.replace(/^¥/, "")}` : "";
        lines.push(`当前时刻命中：${now.label ?? now.tierId} — 输入 ${fmtPrice(now.pricing.priceIn)} / 输出 ${fmtPrice(now.pricing.priceOut)}${cny}`);
      }
      lines.push("⚠️ 一旦手填单价就会覆盖内置分时价（手填视为议价/合同价）。想继续按时段计费，请把两个框留空。");
      lines.push("自定义分时不受手填价影响：填了档位表就按档位表计费（可展开明细行修改或恢复内置默认）。");
    }
  }
  lines.push("");
  lines.push(expanded ? "收起价目明细" : "点击展开价目明细（输入 / 输出 / 缓存命中 / 缓存写入 + 分时档位）");

  return (
    <button
      type="button"
      onClick={onToggle}
      title={lines.join("\n")}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap",
        cursor: "pointer", padding: "1px 2px", margin: 0, border: "none",
        background: "transparent", font: "inherit", textAlign: "left",
      }}
    >
      <span style={{
        fontSize: 10, color: meta.color, background: meta.bg, padding: "1px 5px", borderRadius: 3,
        whiteSpace: "nowrap",
      }}>{meta.text}</span>
      {tierActive && (
        <span style={{
          fontSize: 10, color: "var(--accent, #8b7bf7)", background: "rgba(139,123,247,0.12)",
          padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap",
        }}>{userTiers ? "分时·自定义" : "峰谷分时"}</span>
      )}
      {
}
      <ChevronIcon size={10} rotate={expanded ? 90 : 0} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
    </button>
  );
}









function CacheSourceBadge({ source, value }: { source: CacheRateSource; value?: number }): JSX.Element {
  const meta = describeCacheRateSource(source, value);
  return (
    <span style={{
      fontSize: 9.5, padding: "0 4px", borderRadius: 3, whiteSpace: "nowrap",
      color: meta.estimated ? "var(--warning)" : "var(--text-dim)",
      background: meta.estimated ? "rgba(210,153,34,0.12)" : "rgba(127,127,127,0.10)",
    }} title={meta.hint}>{meta.text}</span>
  );
}




const DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];














function MoneyInput({ value, onCommit, width = 84, title, placeholder, block = false, step = "0.001", format }: {
  value: number | undefined; onCommit: (v: number | undefined) => void;
  width?: number; title?: string; placeholder?: string;
  
  block?: boolean;
  
  step?: string;
  






  format?: (v: number) => string;
}): JSX.Element {
  const fmt = (v: number): string => (format ? format(v) : String(v));
  const [draft, setDraft] = useState(value === undefined ? "" : fmt(value));
  
  
  useEffect(() => {
    const next = value === undefined ? "" : fmt(value);
    const n = Number(draft);
    const same = draft.trim() === "" ? value === undefined
      : Number.isFinite(n) && value !== undefined && Math.abs(n - value) <= 1e-9;
    if (!same) { setDraft(next); }
    
  }, [value]);
  return (
    <input
      type="number" min={0} step={step} value={draft} title={title} placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value;
        setDraft(t);
        if (t.trim() === "") { onCommit(undefined); return; }
        const n = Number(t);
        if (Number.isFinite(n) && n >= 0) { onCommit(n); }
      }}
      onBlur={() => {
        const t = draft.trim();
        const n = Number(t);
        if (t === "" || !Number.isFinite(n) || n < 0) { setDraft(value === undefined ? "" : fmt(value)); }
      }}
      style={block
        ? { ...cellInputStyle(), flex: "1 1 auto", minWidth: 0 }
        : { ...cellInputStyle(), width, flex: "0 0 auto" }}
    />
  );
}








function TimeInput({ minutes, onCommit, title }: {
  minutes: number; onCommit: (m: number) => void; title?: string;
}): JSX.Element {
  const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return (
    <input
      type="time" value={hhmm} title={title}
      onChange={(e) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(e.target.value);
        if (!m) { return; }
        const total = Number(m[1]) * 60 + Number(m[2]);
        if (Number.isFinite(total) && total >= 0 && total <= 1439) { onCommit(total); }
      }}
      style={{ ...cellInputStyle(), width: 86, flex: "0 0 auto", fontFamily: "Consolas, monospace" }}
    />
  );
}








function DayChips({ days, onSet }: { days: number[] | undefined; onSet: (d: number[] | undefined) => void }): JSX.Element {
  const all = !days || days.length === 0 || days.length >= 7;
  const current = all ? ALL_DAYS : days!;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
      {DAY_LABELS.map((lab, d) => {
        const on = current.includes(d);
        return (
          <button
            key={d} type="button"
            title={on ? `点击取消「周${lab}」` : `点击加入「周${lab}」`}
            onClick={() => {
              const next = on ? current.filter((x) => x !== d) : [...current, d].sort((a, b) => a - b);
              if (next.length === 0) { return; } 
              onSet(next.length >= 7 ? undefined : next);
            }}
            style={{
              width: 21, height: 20, borderRadius: 4, padding: 0, cursor: "pointer",
              fontSize: 10.5, whiteSpace: "nowrap",
              border: `1px solid ${on ? "var(--accent, #8b7bf7)" : "var(--border-hover)"}`,
              background: on ? "rgba(139,123,247,0.16)" : "transparent",
              color: on ? "var(--accent, #8b7bf7)" : "var(--text-dim)",
            }}
          >{lab}</button>
        );
      })}
    </div>
  );
}


const TZ_PRESETS = [
  "Asia/Shanghai", "UTC", "Asia/Tokyo", "Asia/Singapore", "America/Los_Angeles", "Europe/London",
];

























function UpstreamPricingHints({ m, onImport }: {
  m: DraftModel;
  onImport: (t: ModelPriceTiers) => void;
}): JSX.Element | null {
  const cand = m.pricing_time_tiers_candidate;
  const ctxTiers = m.pricing_context_tiers ?? [];
  const per = m.pricing_per_request;
  const perItems: Array<[string, number]> = per
    ? ([
        ["每次调用", per.request], ["每张图", per.image], ["联网搜索", per.webSearch],
        ["内部推理", per.internalReasoning], ["音频", per.audio],
      ].filter(([, v]) => typeof v === "number") as Array<[string, number]>)
    : [];
  const snap = snapshotPricingInfo(m.id);
  
  
  
  
  const snapVetoIsError = snap?.vetoKind === "mirror-wrong";
  if (!cand && ctxTiers.length === 0 && perItems.length === 0 && !snap) { return null; }

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "nowrap", minWidth: 0,
  };
  const textStyle: React.CSSProperties = {
    fontSize: 10.5, color: "var(--text-dim)",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "1 1 auto", minWidth: 0,
  };

  return (
    <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px dashed var(--border)" }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
        探针 / 镜像采集到的定价信息
      </div>

      {



}
      {snap && (
        <div style={rowStyle}>
          <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
            color: snapVetoIsError ? "var(--warning)" : "var(--text-dim)",
            background: snapVetoIsError ? "rgba(210,153,34,0.12)" : "rgba(127,127,127,0.12)" }}>价目快照</span>
          <span style={textStyle}
            title={`快照命中 id：${snap.snapshotId}（${snap.source === "litellm" ? "LiteLLM 模型成本表" : "OpenRouter 实时目录"}）`
              + `\n快照同步于 ${pricingSnapshotMeta().generatedAt}（共 ${pricingSnapshotMeta().count} 条）`
              + (snap.contextTiers?.length
                  ? `\n快照声明该模型**长上下文另行计价**：${snap.contextTiers.map((t) => `≥${Math.round(t.fromInputTokens / 1000)}K → $${fmtPrice(t.prompt)}/1M`).join("；")}`
                  : "")
              + (snap.vetoReason
                  ? (snapVetoIsError
                      ? `\n⚠️ 已抑制、本轮不采用：${snap.vetoReason}`
                      : `\n口径差异（**不是**错价）：${snap.vetoReason}`)
                  : "")}>
            {snap.snapshotId} · {snap.source === "litellm" ? "LiteLLM" : "OpenRouter"}
            {typeof snap.priceIn === "number" ? ` · $${fmtPrice(snap.priceIn)}/$${fmtPrice(snap.priceOut)}` : ""}
            {snapVetoIsError ? " · ⚠️ 已抑制（见悬停）"
              : snap.vetoReason ? " · 口径不同（见悬停）" : ""}
          </span>
        </div>
      )}
      {snap?.contextTiers && snap.contextTiers.length > 0 && (
        <div style={rowStyle}>
          <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
            color: "var(--text-dim)", background: "rgba(127,127,127,0.12)" }}>快照·上下文分档</span>
          <span style={textStyle}
            title={"快照（LiteLLM/OpenRouter）声明：输入超过某长度后单价上浮。slime 的取价入口是「token 单价 × 时刻」，"
              + "没有「按输入长度」这一维，所以只作提示、不参与计费 —— 若你的实际账单普遍是长上下文，请按长上下文价手填。"}>
            长上下文另计价：{snap.contextTiers.map((t) =>
              `≥${Math.round(t.fromInputTokens / 1000)}K → $${fmtPrice(t.prompt)}/1M`,
            ).join("；")}（不参与计费）
          </span>
        </div>
      )}

      {cand && (
        <div style={rowStyle}>
          <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
            color: "var(--accent, #8b7bf7)", background: "rgba(139,123,247,0.14)" }}>时段档候选</span>
          <span title={`上游用 UTC 口径声明了这套时段：${describeTierSpec(cand)}\n导入后按 UTC 判定（想换成别的时区，在「计费时区」框里改即可，语义等价、无需换算）`}
            style={textStyle}>
            上游声明了 {cand.tiers.length} 个时段档（UTC）：{describeTierSpec(cand)}
          </span>
          <button className="btn" style={{ fontSize: 11, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0 }}
            title="把上游声明的时段档导入为本模型的自定义分时（导入后即参与计费；随时可改或关闭）"
            onClick={() => onImport(cand)}>
            导入上游时段
          </button>
        </div>
      )}

      {ctxTiers.length > 0 && (
        <div style={rowStyle}>
          <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
            color: "var(--text-dim)", background: "rgba(127,127,127,0.12)" }}>上下文分档</span>
          <span style={textStyle}
            title={"上游声明：输入超过某个长度后单价会上浮。slime 的取价入口是「token 单价 × 时刻」，没有「按输入长度」这一维，"
              + "强行套用会把长短请求算成一个价，所以只做提示、不参与计费。"}>
            上游按输入长度加价：{ctxTiers.map((t) =>
              `≥${t.fromInputTokens !== undefined ? `${Math.round(t.fromInputTokens / 1000)}K` : "?"} → $${fmtPrice(t.prompt)}/1M`,
            ).join("；")}（仅供参考，不参与计费）
          </span>
        </div>
      )}

      {perItems.length > 0 && (
        <div style={rowStyle}>
          <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
            color: "var(--warning)", background: "rgba(210,150,60,0.14)" }}>按次计费</span>
          <span style={textStyle}
            title="上游对这类模型按次/按张收费，而不是按 token。把它折成 token 价会造出巨大假账，故只做提示。">
            上游还按次收费：{perItems.map(([k, v]) => `${k} $${fmtPrice(v)}`).join("、")}（不计入 token 账目）
          </span>
        </div>
      )}
    </div>
  );
}















function TierWindowsBreakdown({ spec, at, title }: {
  spec: ModelPriceTiers; at?: Date; title: string;
}): JSX.Element {
  const tiers = describeTiersForDisplay(spec, at);
  return (
    <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
      <div style={{ fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{title}</div>
      {tiers.map((t) => (
        <div key={t.id} style={{
          display: "grid", gap: 2, padding: "5px 7px", borderRadius: 5,
          border: "1px solid var(--border)",
          background: t.active === true ? "rgba(139,123,247,0.08)" : "rgba(127,127,127,0.04)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap", minWidth: 0 }}>
            <span style={{
              fontSize: 10, padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
              color: t.isFallback ? "var(--text-secondary)" : "var(--accent, #8b7bf7)",
              background: t.isFallback ? "rgba(127,127,127,0.14)" : "rgba(139,123,247,0.14)",
            }}>{t.label}</span>
            {t.isFallback && (
              <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}
                title="没有声明时段 = 其余所有时间都按它计价。下面的谷时段是反推出来给你核对的，写进记录的仍是这一条兜底规则。">
                兜底档
              </span>
            )}
            {t.active === true && (
              <span style={{ fontSize: 10, color: "var(--accent, #8b7bf7)", whiteSpace: "nowrap", flexShrink: 0 }}
                title="按本机当前时间判定命中该档（判定逻辑与计费完全同一份）">● 当前</span>
            )}
            <span style={{ flex: "1 1 auto", minWidth: 0 }} />
            {





}
            {(() => {
              const amt = formatTierAmounts(t);
              return (
                <>
                  {amt.usd && (
                    <span style={{
                      fontFamily: "Consolas, monospace", fontSize: 10.5, color: "var(--text-secondary)",
                      whiteSpace: "nowrap", flexShrink: 0,
                    }}>{amt.usd}</span>
                  )}
                  {amt.cny && (
                    <span style={{
                      fontFamily: "Consolas, monospace", fontSize: 10.5, color: "var(--text-dim)",
                      whiteSpace: "nowrap", flexShrink: 0,
                    }}
                      title="该档位的**官方**人民币刊例价（¥ / 1M tokens），原样照抄，未经汇率换算">
                      {amt.cny}
                    </span>
                  )}
                </>
              );
            })()}
          </div>
          {t.windowLines.map((line, i) => (
            <div key={i} style={{
              fontSize: 11, lineHeight: 1.5,
              color: t.isFallback ? "var(--text-dim)" : "var(--text-secondary)",
            }}>{line}</div>
          ))}
        </div>
      ))}
      <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
        单价单位 USD / 1M tokens（输入 / 输出）· 官方公布过人民币价的档位会并列显示 ¥（原价，非折算）·
        谷时段由高峰时段在整周上取补集推导，用于核对是否漏时段
      </div>
    </div>
  );
}

function TierEditor({ m, eff, onChange }: {
  m: DraftModel; eff: ReturnType<typeof resolveEffectivePricing>;
  onChange: (t: ModelPriceTiers | undefined) => void;
}): JSX.Element {
  const spec = m.price_tiers;
  const builtIn = builtInPriceTiers(m.id);
  const seedIn = eff.origin === "none" ? 0 : eff.priceIn;
  const seedOut = eff.origin === "none" ? 0 : eff.priceOut;
  const seedTemplate = (): ModelPriceTiers =>
    builtIn ? builtIn : createDefaultPriceTiers(seedIn, seedOut);

  const sectionStyle: React.CSSProperties = {
    marginTop: 10, paddingTop: 8, borderTop: "1px dashed var(--border)",
  };

  
  if (!spec) {
    return (
      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", minWidth: 0 }}>
          <span style={{
            fontSize: 11.5, fontWeight: 600, color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 0,
          }}>分时（峰谷）定价</span>
          <span
            title={builtIn ? `内置规格：${describeTierSpec(builtIn)}` : "该模型在 slime 内置价目表里没有分时规格"}
            style={{
              fontSize: 11, color: "var(--text-dim)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "1 1 auto", minWidth: 0,
            }}>
            {builtIn
              ? `内置 ${builtIn.tiers.length} 档 · ${builtIn.timezone}`
              : "内置价目表里没有该模型的分时规格 —— 需要时段计价就自己定义"}
          </span>
          <button className="btn" style={{ fontSize: 11, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0 }}
            onClick={() => onChange(seedTemplate())}>
            改为自定义
          </button>
        </div>
        {}
        {builtIn && (
          <TierWindowsBreakdown spec={builtIn} at={new Date()} title="内置分时规格 · 全部峰/谷时段" />
        )}
        {}
        <UpstreamPricingHints m={m} onImport={(t) => onChange(t)} />
      </div>
    );
  }

  const patchTier = (i: number, next: ModelPriceTier): void => {
    onChange({ ...spec, tiers: spec.tiers.map((t, j) => (j === i ? next : t)) });
  };
  const fallbackIndex = spec.tiers.findIndex((t) => !t.windows || t.windows.length === 0);

  return (
    <div style={sectionStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", minWidth: 0, marginBottom: 8 }}>
        <span style={{
          fontSize: 11.5, fontWeight: 600, color: "var(--accent, #8b7bf7)", whiteSpace: "nowrap", flexShrink: 0,
        }}>分时（峰谷）定价 · 自定义</span>
        <span style={{
          fontSize: 11, color: "var(--text-dim)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "1 1 auto", minWidth: 0,
        }}>
          自定义分时**优先级高于手填单价与内置价目表**；无时段的档位 = 兜底档
        </span>
        {builtIn && (
          <button className="btn" style={{ fontSize: 11, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0 }}
            title="丢弃当前编辑，恢复为 slime 内置的这套时段" onClick={() => onChange(builtIn)}>
            恢复内置
          </button>
        )}
        <button className="btn" style={{ fontSize: 11, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0 }}
          title="删除自定义规格，回到内置价目表 / 手填单价的取价逻辑" onClick={() => onChange(undefined)}>
          关闭
        </button>
      </div>

      {}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "nowrap", minWidth: 0 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 0 }}>计费时区</span>
        <input
          list="slime-tz-presets" value={spec.timezone}
          onChange={(e) => onChange({ ...spec, timezone: e.target.value })}
          style={{ ...cellInputStyle(), width: 168, flex: "0 0 auto" }}
        />
        <datalist id="slime-tz-presets">
          {TZ_PRESETS.map((tz) => <option key={tz} value={tz} />)}
        </datalist>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
          IANA 名（如 Asia/Shanghai）· 不是本机时区
        </span>
      </div>

      {



}
      <TierWindowsBreakdown spec={spec} at={new Date()} title="当前规格 · 全部峰/谷时段（核对用）" />

      {}
      <UpstreamPricingHints m={m} onImport={(t) => onChange(t)} />

      {spec.tiers.map((t, i) => {
        const isFallback = i === fallbackIndex;
        const dupFallback = isFallback === false && (!t.windows || t.windows.length === 0);
        return (
          <div key={i} style={{
            border: "1px solid var(--border-hover)", borderRadius: 6, padding: "7px 8px", marginBottom: 6,
            background: "rgba(127,127,127,0.04)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "nowrap", minWidth: 0 }}>
              <input
                value={t.label ?? ""} placeholder={t.id}
                title="档位展示名（只影响界面文案；写进 usage 记录的是右侧那个 id）"
                onChange={(e) => patchTier(i, { ...t, label: e.target.value })}
                style={{ ...cellInputStyle(), width: 108, flex: "0 0 auto" }}
              />
              <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "Consolas, monospace", whiteSpace: "nowrap", flexShrink: 0 }}>
                {t.id}
              </span>
              <span style={{
                fontSize: 10, padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
                color: isFallback ? "var(--success)" : "var(--text-dim)",
                background: isFallback ? "var(--success-soft)" : "rgba(127,127,127,0.12)",
              }} title={isFallback ? "没有时段 = 兜底档：所有未被上面档位命中的时间都按它计价" : "命中时段才生效"}>
                {isFallback ? "兜底档" : "按时段"}
              </span>
              {dupFallback && (
                <span style={{ fontSize: 10, color: "var(--warning)", whiteSpace: "nowrap", flexShrink: 0 }}
                  title="多个无时段的档位同时存在时，只有数组里第一个兜底档会被使用">
                  ⚠️ 仅第一个兜底档生效
                </span>
              )}
              <span style={{ flex: "1 1 auto", minWidth: 0 }} />
              <button className="btn" style={{ fontSize: 11, padding: "1px 7px", whiteSpace: "nowrap", flexShrink: 0 }}
                title={spec.tiers.length <= 1 ? "至少要保留一个档位" : "删除该档位"}
                disabled={spec.tiers.length <= 1}
                onClick={() => onChange({ ...spec, tiers: spec.tiers.filter((_, j) => j !== i) })}>
                删除
              </button>
            </div>

            {(t.windows ?? []).map((w, wi) => (
              <div key={wi} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "nowrap", minWidth: 0 }}>
                <DayChips days={w.days}
                  onSet={(d) => patchTier(i, {
                    ...t,
                    windows: (t.windows ?? []).map((x, j) => (j === wi ? { ...x, days: d } : x)),
                  })} />
                <TimeInput minutes={w.startMin} title="时段开始（含）"
                  onCommit={(v) => patchTier(i, {
                    ...t,
                    windows: (t.windows ?? []).map((x, j) => (j === wi ? { ...x, startMin: v } : x)),
                  })} />
                <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>→</span>
                <TimeInput minutes={w.endMin}
                  title={w.endMin < w.startMin ? "时段结束（不含）· 早于开始时间 = 跨午夜到次日" : "时段结束（不含）"}
                  onCommit={(v) => patchTier(i, {
                    ...t,
                    windows: (t.windows ?? []).map((x, j) => (j === wi ? { ...x, endMin: v } : x)),
                  })} />
                <span style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
                  {w.endMin < w.startMin ? "跨午夜" : ""}
                </span>
                <span style={{ flex: "1 1 auto", minWidth: 0 }} />
                <button className="btn" style={{ fontSize: 11, padding: "1px 7px", whiteSpace: "nowrap", flexShrink: 0 }}
                  title="删除该时段（删空后该档位变成兜底档）"
                  onClick={() => patchTier(i, { ...t, windows: (t.windows ?? []).filter((_, j) => j !== wi) })}>
                  删除时段
                </button>
              </div>
            ))}
            <button className="btn" style={{ fontSize: 11, padding: "1px 7px", whiteSpace: "nowrap", marginBottom: 6 }}
              onClick={() => patchTier(i, {
                ...t,
                windows: [...(t.windows ?? []), { days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 18 * 60 }],
              })}>
              + 添加时段
            </button>

            {





}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "nowrap", minWidth: 0 }}>
              <label style={{ display: "block", minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 2, whiteSpace: "nowrap" }}>输入 *</span>
                <MoneyInput value={t.priceIn} width={80} placeholder="0"
                  title="USD / 1M tokens · 本档位缓存未命中的输入价（必填，清空即 0）"
                  onCommit={(v) => patchTier(i, { ...t, priceIn: v ?? 0 })} />
              </label>
              <label style={{ display: "block", minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 2, whiteSpace: "nowrap" }}>输出</span>
                <MoneyInput value={t.priceOut} width={80} placeholder="= 输入"
                  title="USD / 1M tokens · 输出价；留空 = 与本档位输入价相同"
                  onCommit={(v) => patchTier(i, { ...t, priceOut: v })} />
              </label>
              <label style={{ display: "block", minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 2, whiteSpace: "nowrap" }}>缓存命中</span>
                <MoneyInput value={t.priceCacheRead} width={80} placeholder="自动"
                  title="USD / 1M tokens · 命中缓存的输入 token 价；留空 = 由内置表 / 0.1× 倍率补（推荐留空，除非你有确切报价）"
                  onCommit={(v) => patchTier(i, { ...t, priceCacheRead: v })} />
              </label>
              <label style={{ display: "block", minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 2, whiteSpace: "nowrap" }}>缓存写入</span>
                <MoneyInput value={t.priceCacheWrite} width={80} placeholder="自动"
                  title="USD / 1M tokens · 缓存写入附加费；留空 = 由内置表 / 倍率规则补（非 Anthropic 系推定为 0）"
                  onCommit={(v) => patchTier(i, { ...t, priceCacheWrite: v })} />
              </label>
              <span style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                留空 = 按内置表 / 倍率规则补
              </span>
            </div>
          </div>
        );
      })}

      <button className="btn" style={{ fontSize: 11, padding: "1px 7px", whiteSpace: "nowrap" }}
        onClick={() => onChange({
          ...spec,
          tiers: [...spec.tiers, {
            id: `tier${spec.tiers.length + 1}`,
            label: "新档位",
            windows: [{ days: [1, 2, 3, 4, 5], startMin: 0, endMin: 8 * 60 }],
            priceIn: seedIn, priceOut: seedOut,
          }],
        })}>
        + 添加档位
      </button>
      <span style={{ fontSize: 10.5, color: "var(--text-dim)", marginLeft: 8 }}>
        共 {spec.tiers.length} 档 · 命中判定按数组顺序取首个匹配；都不匹配 → 兜底档
      </span>

      {}
      <UpstreamPricingHints m={m} onImport={(t) => onChange(t)} />
    </div>
  );
}












function PriceDetailRow({ m, baseUrl, onChange, onTiersChange, onClose, onCurrencyChange, onClearManual }: {
  m: DraftModel; baseUrl: string;
  onChange: (f: PriceField, raw: string) => void;
  onTiersChange: (t: ModelPriceTiers | undefined) => void;
  onClose: () => void;
  
  onCurrencyChange: (c: PriceCurrency | undefined) => void;
  
  onClearManual: () => void;
}): JSX.Element {
  
















  








  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const eff = resolveEffectivePricing(m.id, baseUrl, m, new Date());
  const effFlat = resolveEffectivePricing(m.id, baseUrl, m);

  






  const cur = pricingDisplayCurrency(m.id, m.price_currency);
  
  const officialCur = officialPriceCurrency(m.id);
  



  const tierSpec = m.price_tiers ?? builtInPriceTiers(m.id);
  








  const curIsNative = isNativePriceCurrency(eff, cur);

  



  const FIELD_KEY: Record<PriceField, PriceFieldKey> = {
    price_in_usd: "priceIn",
    price_out_usd: "priceOut",
    price_cache_read_usd: "priceCacheRead",
    price_cache_write_usd: "priceCacheWrite",
  };

  







  const effectiveInCurrency = (f: PriceField): { text: string; approx: boolean } | undefined => {
    const amt = amountInCurrency(eff, FIELD_KEY[f], cur);
    if (!amt) { return undefined; }
    return { text: formatAmount(amt.value), approx: !amt.native };
  };

  




  
  const CNY_KEY: Record<PriceFieldKey, "priceInCny" | "priceOutCny" | "priceCacheReadCny" | "priceCacheWriteCny"> = {
    priceIn: "priceInCny", priceOut: "priceOutCny", priceCacheRead: "priceCacheReadCny", priceCacheWrite: "priceCacheWriteCny",
  };
  











  const manualDisplay = (f: PriceField, v: number): number => {
    if (cur !== "CNY") { return convertFromUsd(v, cur); }
    
    
    
    const cny = effFlat[CNY_KEY[FIELD_KEY[f]]];
    if (typeof cny === "number" && cny > 0 && v > 0 && Math.abs(v * USD_CNY_RATE - cny) / cny < 0.15) {
      return cny;
    }
    return convertFromUsd(v, cur);
  };

  





  function autoValue(f: PriceField): number | undefined {
    switch (f) {
      case "price_in_usd": return eff.origin === "none" ? undefined : eff.priceIn;
      case "price_out_usd": return eff.origin === "none" ? undefined : eff.priceOut;
      case "price_cache_read_usd": return eff.priceCacheRead;
      case "price_cache_write_usd": return eff.priceCacheWrite;
    }
  }

  






  const tierName = eff.tiered ? `（${eff.label ?? eff.tierId ?? "分时档"}）` : "";

  





  
  const hasTierSpec = !!tierSpec;
  





  const tierActive = hasTierSpec && (eff.origin === "table" || eff.origin === "tier" || eff.origin === "customTier");
  






  const manualInEffect = eff.origin === "manual";

  









  const defaultView: PriceView = tierActive ? "tier" : "manual";

  






  const [viewOverride, setViewOverride] = useState<PriceView | null>(null);
  const view: PriceView = viewOverride ?? defaultView;

  return (
    









    <div className="price-detail-block">
      <div style={{ padding: "10px 12px 12px" }}>
          {









}
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
            flexWrap: "nowrap", minWidth: 0,
          }}>
            <span style={{
              fontSize: 12, fontWeight: 600, color: "var(--text-secondary)",
              whiteSpace: "nowrap", flexShrink: 0,
            }}>
              价目明细 · <span style={{ fontFamily: "Consolas, monospace", fontWeight: 400 }}>{m.id}</span>
            </span>
            <span
              title="单价一律为 USD / 1M tokens；四个框都留空 = 恢复自动取值（上游探针 → 内置价目表 → 行业倍率推导）"
              style={{
                fontSize: 11, color: "var(--text-dim)",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                flex: "1 1 auto", minWidth: 0,
              }}>
              USD / 1M tokens · 四个框都留空 = 恢复自动取值（上游 → 内置表 → 倍率推导）
            </span>
            <button className="btn" onClick={onClose}
              style={{ fontSize: 11, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0 }}>收起</button>
          </div>

          {}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "nowrap", minWidth: 0 }}>
            <span style={{
              fontSize: 10, padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
              color: ORIGIN_META[eff.origin].color, background: ORIGIN_META[eff.origin].bg,
            }}>{ORIGIN_META[eff.origin].text}</span>
            <span
              




              title={eff.tiered
                ? `本行按 ${eff.timezone ?? "Asia/Shanghai"} 的墙上时间取档，与引擎记账用的是同一份判定`
                  + `（记账记录里的 price_tier = ${eff.tierId ?? "—"}）。\n`
                  + "这里显示的是**当前时刻**的价 —— 到高峰 / 空闲时段会自动变化，不是配置被改动了。\n"
                  + "（下方四个单价框留空时，引擎此刻用的也正是这个数。）"
                : undefined}
              style={{
                fontSize: 11, color: "var(--text-secondary)",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "1 1 auto",
              }}>
              {eff.origin === "none"
                ? `引擎当前按 ${cur === "CNY" ? "¥" : "$"}0 记账（未定价）—— 请在右侧手填单价`
                













                : `${eff.tiered ? "当前计费价" : "计费价"}：${formatAmountsInCurrency(eff, cur) ?? "未定价"}${
                    curIsNative ? "" : `（官方以 ${officialCur === "CNY" ? "¥ 人民币" : "$ 美元"} 刊例：${formatPricingAmounts(eff) ?? "—"}）`
                  }`}
              {eff.tiered || eff.origin === "customTier"
                ? ` · 档位：${eff.label ?? eff.tierId ?? "—"}${eff.timezone ? `（${eff.timezone}）` : ""}`
                : ""}
              {
}
              {effFlat.superseded ? ` · ⚠️ 配置里的 ${fmtPrice(effFlat.superseded.priceIn)} 引擎不采用` : ""}
            </span>
          </div>

          {




}
          <div style={{
            fontSize: 10.5, lineHeight: 1.55, marginBottom: 8, padding: "5px 7px", borderRadius: 4,
            background: "rgba(127,127,127,0.07)", color: "var(--text-dim)",
          }}>
            <span style={{ fontWeight: 600, color: "var(--text-muted)" }}>探针诊断：</span>
            {PROBE_OUTCOME_HINT[classifyProbeOutcome(eff.origin, baseUrl)]}
          </div>

          {




}
          {eff.suspiciousStored && (
            <div style={{
              fontSize: 10.5, lineHeight: 1.55, marginBottom: 8, padding: "5px 7px", borderRadius: 4,
              color: "var(--warning)", background: "rgba(210,153,34,0.12)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", minWidth: 0,
            }}>
              <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                ⚠️ <b>疑似历史错值</b>：手填存值 ${formatAmount(eff.suspiciousStored.storedIn)} 与官方档位价
                ${formatAmount(eff.suspiciousStored.tableIn)} 偏离 {eff.suspiciousStored.ratio >= 1
                  ? `${formatAmount(eff.suspiciousStored.ratio)} 倍`
                  : `1/${formatAmount(1 / eff.suspiciousStored.ratio)}`}。
                （典型成因：早期版本的美元价被按人民币又除了一次汇率。手填优先级最高，机器不会自动覆盖。）
              </span>
              <button
                className="btn"
                style={{ fontSize: 10.5, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0, color: "var(--warning)" }}
                title="清空四个手填单价与「手填」标记（保留峰谷分时档），恢复按内置价目表自动取值"
                onClick={onClearManual}
              >
                清空手填恢复内置表
              </button>
            </div>
          )}

          {



}
          {eff.pricingMatch === "family" && (
            <div style={{
              fontSize: 10.5, marginBottom: 8, padding: "4px 7px", borderRadius: 4,
              color: "var(--warning)", background: "rgba(210,153,34,0.10)",
            }}
              title={"本模型命中的是**家族通配条目**（按系列匹配），不是逐一登记的精确条目。\n"
                + "同一家族里跨代/跨档改价时，通配条目只能取其中一个价 —— 这条价**可能偏离**。\n"
                + "建议：到官方定价页核对后，用右侧「单价币种」下方的四个框手填覆盖。"}>
              价目匹配：家族兜底（该型号未逐条登记，价格**可能偏离**官方页，建议核对）
            </div>
          )}
          {eff.pricingMatch === "exact" && (
            <div style={{ fontSize: 10.5, marginBottom: 8, color: "var(--text-dim)" }}>
              价目匹配：精确 id（已逐条对照官方定价页）
            </div>
          )}
          {




}
          {eff.vendor && (
            <div style={{
              fontSize: 10.5, marginBottom: 8,
              color: pricingVerifiedAtUnknown(eff.vendor) ? "var(--warning)" : "var(--text-dim)",
            }}
              title={"内置价目表的核实日期：逐条核对厂商**官方定价页**的那一天（不是跑脚本的那天）。\n"
                + "显示为「未知」= 本表有价但没有可溯源的核实记录，需要用一次人工复核把它补上。"}>
              价格核实于：{(() => {
                const at = PRICING_VERIFIED_AT[eff.vendor];
                return at === undefined || at === "unknown" ? "未知（需复核）" : at;
              })()}
              {eff.origin === "snapshot" ? "（本行实际用的是快照二手价，与上面的核实日期无关）" : ""}
            </div>
          )}

          {





}
          <div style={{
            display: "flex", alignItems: "center", gap: 6, marginBottom: 8,
            flexWrap: "nowrap", minWidth: 0,
            padding: "5px 7px", borderRadius: 5, background: "rgba(127,127,127,0.07)",
          }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
              定价方式
            </span>
            {PRICE_VIEW_TABS.map((tab) => {
              const on = view === tab.id;
              
              const active = tab.id === "tier" ? tierActive : manualInEffect;
              return (
                <button
                  key={tab.id}
                  className="btn"
                  style={{
                    fontSize: 11, padding: "2px 9px", whiteSpace: "nowrap", flexShrink: 0,
                    background: on ? "rgba(139,123,247,0.18)" : undefined,
                    






                    border: `1px solid ${on ? "var(--accent, #8b7bf7)" : "transparent"}`,
                    fontWeight: on ? 700 : 400,
                  }}
                  title={`${tab.hint}\n\n点击切换：一次只显示一套配置界面（另一套不删除，随时切回）。`}
                  onClick={() => setViewOverride(tab.id)}
                >
                  {tab.label}
                  {active && (
                    <span style={{ color: "var(--success)", marginLeft: 4 }} title="引擎此刻按这一套计价">● 生效中</span>
                  )}
                </button>
              );
            })}
            <span style={{
              fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis", flex: "1 1 auto", minWidth: 0,
            }}
              title={"只显示当前选中那一套配置界面，避免两套价并存时看不清哪套在生效。\n"
                + `默认显示「${defaultView === "tier" ? "分时（峰谷）定价" : "手动单价"}」`
                + "—— 以引擎此刻实际采用的那一套为准（分时档在算钱就显示分时，手填价在算钱就显示手填）。"}>
              {view === "tier"
                ? `只显示分时档位（${hasTierSpec ? "共 " + (tierSpec?.tiers.length ?? 0) + " 档" : "该模型无内置规格，可自行定义"}）· 手动单价输入已隐藏`
                : "只显示手动单价输入 · 分时档位编辑已隐藏"}
            </span>
          </div>

          {











}
          {view === "tier" && (manualInEffect || eff.superseded) && (
            <div style={{
              fontSize: 10.5, lineHeight: 1.55, marginBottom: 8, padding: "5px 7px", borderRadius: 4,
              color: manualInEffect ? "var(--warning)" : "var(--text-dim)",
              background: manualInEffect ? "rgba(210,153,34,0.12)" : "rgba(127,127,127,0.07)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", minWidth: 0,
            }}>
              <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                {manualInEffect
                  ? "⚠️ 该模型有内置分时规格，但你**手填的单价正在压过它** —— 分时此刻**不生效**，"
                    + "账单按手填价计。要让时段计价接管，点右侧「清空手填」。"
                  : `ℹ️ 配置里还躺着 ${fmtPrice(eff.superseded!.priceIn)} 存值，但引擎**不采用**它`
                    + `（级别低于当前生效的「${ORIGIN_META[eff.origin].text}」）。清空可消除这条残留 ——`
                    + "否则等你以后取消分时档，它会突然变成生效价。"}
              </span>
              <button
                className="btn"
                style={{ fontSize: 10.5, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0, color: "var(--warning)" }}
                title="清空四个手填单价与「手填」标记（保留分时档），恢复按内置价目表 / 分时档自动取值"
                onClick={onClearManual}
              >
                清空手填
              </button>
            </div>
          )}

          {







}
          {view === "manual" && !!m.price_tiers && (
            <div style={{
              fontSize: 10.5, lineHeight: 1.55, marginBottom: 8, padding: "5px 7px", borderRadius: 4,
              color: "var(--warning)", background: "rgba(210,153,34,0.10)",
            }}>
              ⚠️ 该模型已启用**自定义分时档**，它的优先级高于这里的手填单价 ——
              下面填的价**不会参与计费**。要让手填生效，请在「分时（峰谷）定价」里点「关闭」。
            </div>
          )}
          {view === "manual" && !m.price_tiers && hasTierSpec && manualInEffect && (
            <div style={{
              fontSize: 10.5, lineHeight: 1.55, marginBottom: 8, padding: "5px 7px", borderRadius: 4,
              color: "var(--text-dim)", background: "rgba(127,127,127,0.07)",
            }}>
              ℹ️ 该模型**有分时（峰谷）规格**，但你的手填价正压过它 —— 分时此刻已暂停。
              把下面四个框全部清空，即恢复按时段自动计价（也可点上面的「分时（峰谷）定价」查看时段表）。
            </div>
          )}

          {




}
          {view === "manual" && (<>
          <div style={{
            display: "flex", alignItems: "center", gap: 6, marginBottom: 6,
            flexWrap: "nowrap", minWidth: 0,
          }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
              单价币种
            </span>
            {([["CNY", "¥ 人民币"], ["USD", "$ 美元"]] as Array<[PriceCurrency, string]>).map(([c, label]) => (
              <button
                key={c}
                className="btn"
                style={{
                  fontSize: 11, padding: "2px 9px", whiteSpace: "nowrap", flexShrink: 0,
                  background: cur === c ? "rgba(139,123,247,0.18)" : undefined,
                  
                  border: `1px solid ${cur === c ? "var(--accent, #8b7bf7)" : "transparent"}`,
                  fontWeight: cur === c ? 700 : 400,
                }}
                title={c === "CNY"
                  ? "用人民币录入单价：你填的是 ¥/1M tokens，引擎按折算率换成 USD 记账（账目单位恒为 USD，不影响历史账）"
                  : "用美元录入单价：你填的是 $/1M tokens，直接就是记账单位"}
                onClick={() => onCurrencyChange(c)}
              >
                {label}
              </button>
            ))}
            {m.price_currency !== undefined && (
              <button
                className="btn"
                style={{ fontSize: 10.5, padding: "1px 7px", whiteSpace: "nowrap", flexShrink: 0 }}
                title={`清除手选，恢复按模型归属地自动判定（当前模型归属地判定为 ${officialCur === "CNY" ? "人民币" : "美元"}${cur === officialCur ? "" : "，与手选不同"}）`}
                onClick={() => onCurrencyChange(undefined)}
              >
                恢复自动
              </button>
            )}
            <span style={{
              fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis", flex: "1 1 auto", minWidth: 0,
            }}
              title={`币种只影响**显示与录入单位**，不影响记账口径（账目恒以 USD 记录）。\n官方刊例价以 ${officialCur === "CNY" ? "¥ 人民币" : "$ 美元"} 发布${m.price_currency ? "；当前是用户手选" : "，当前为归属地自动判定"}。`}>
              {m.price_currency ? "手选" : "按归属地"}：官方以 {officialCur === "CNY" ? "¥" : "$"} 刊例
              {curIsNative ? "" : " · 当前显示为折算近似值"}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            {PRICE_FIELDS.map((f) => {
              const raw = (m as unknown as Record<string, unknown>)[f];
              const manual = typeof raw === "number";
              const stored = manual ? (raw as number) : undefined;
              const auto = autoValue(f);
              




              const effShow = effectiveInCurrency(f);
              const effText = effShow ? `${effShow.approx ? "≈" : ""}${effShow.text}` : undefined;
              
              
              
              const src = f === "price_cache_read_usd" ? eff.cacheRateReadSource
                : f === "price_cache_write_usd" ? eff.cacheRateWriteSource : undefined;
              return (
                <label key={f} style={{ display: "block", minWidth: 0 }}>
                  <span style={{
                    display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4,
                    fontSize: 11.5, color: "var(--text-muted)", whiteSpace: "nowrap", minWidth: 0,
                  }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {PRICE_FIELD_META[f].label}
                    </span>
                    {src ? <CacheSourceBadge source={src} value={auto} /> : null}
                  </span>
                  {




}
                  <MoneyInput
                    block
                    step={cur === "CNY" ? "0.01" : "0.001"}
                    




                    value={manual && stored !== undefined ? manualDisplay(f, stored) : undefined}
                    format={(v) => formatAmount(v)}
                    placeholder={manual ? PRICE_FIELD_META[f].short : (effText ?? "未定价")}
                    title={`${PRICE_FIELD_META[f].label}单价（${cur === "CNY" ? "人民币 ¥" : "美元 $"} / 1M tokens；${cur === "CNY" ? "按折算率换成 USD 记账" : "即记账单位"}）。${PRICE_FIELD_META[f].hint}${manual ? "" : `\n当前自动取值：${effText ?? "无（未定价）"}${effShow?.approx ? "（折算值）" : ""}`}`}
                    onCommit={(v) => onChange(f, v === undefined ? "" : String(v))}
                  />
                  <span style={{
                    display: "block", marginTop: 3, fontSize: 10.5, color: "var(--text-dim)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {manual
                      
                      ? `生效值 ${effText ?? "—"} · 清空即恢复`
                      
                      
                      : `当前生效 ${effText ?? "未定价"}${tierName}`}
                  </span>
                </label>
              );
            })}
          </div>

          {





}
          {eff.origin !== "none" && (eff.cacheRateReadSource !== "stored" || eff.cacheRateWriteSource !== "stored") && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.55 }}>
              缓存命中价按行业惯例约为未命中价的 1/10（OpenAI、Anthropic 明示 0.1×；DeepSeek 更低）。
              {eff.cacheRateReadSource === "ratio" && typeof eff.priceCacheRead === "number" && eff.priceCacheRead > 0
                ? "本行缓存命中价未手填、内置表也没有 → 当前是**按 0.1× 推导的估算值**，拿到确切报价建议手填覆盖。"
                : eff.cacheRateReadSource === "tier"
                  ? "本行缓存命中价来自当前分时档位自带的价 —— 比家族基价更具体，无需手填。"
                  : eff.cacheRateReadSource === "table"
                    ? "本行缓存命中价未手填，已从内置价目表继承已核实的值 —— 不必手填。"
                    : ""}
              {eff.cacheRateWriteSource === "ratio"
                ? (typeof eff.priceCacheWrite === "number" && eff.priceCacheWrite === 0
                    ? " 缓存写入按「主流厂商不单独计费」推定为 0（仅 Anthropic 系收 1.25×～2×）；若你的网关确实按 write token 收费，请手填。"
                    : ` 缓存写入价未手填、内置表也没有 → 按 1.25× 输入价推导（Anthropic 5 分钟档惯例）；你的网关若取整/另计，请手填覆盖。`)
                : eff.cacheRateWriteSource === "table" || eff.cacheRateWriteSource === "tier"
                  ? " 缓存写入价取自已核实的价目表，无需手填。"
                  : ""}
            </div>
          )}
          </>)}

          {






}
          {view === "tier" && (<>
          {!tierActive && tierSpec && (
            <div style={{
              fontSize: 10.5, lineHeight: 1.55, marginBottom: 8, padding: "5px 7px", borderRadius: 4,
              color: "var(--text-dim)", background: "rgba(127,127,127,0.07)",
            }}>
              本行此刻**不走分时价**：生效来源是「{ORIGIN_META[eff.origin].text}」。
              下面是分时规格的**查看与编辑**（改完不会立刻接管计费 —— 见上面的「清空手填」/ 端点说明）。
            </div>
          )}
          <TierEditor m={m} eff={eff} onChange={onTiersChange} />
          </>)}
        </div>
    </div>
  );
}

function cellInputStyle(): React.CSSProperties {
  return {
    width: "100%", padding: "3px 6px", borderRadius: 4,
    border: "1px solid var(--border-hover)", background: "var(--bg-input)",
    color: "var(--text)", fontSize: 12, boxSizing: "border-box",
  };
}










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