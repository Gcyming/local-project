/**
 * gui/src/renderer/pages/ProvidersPanel.tsx — 模型供应商管理。
 * - Provider/本地模型卡片：简洁摘要；全部编辑/调试参数收敛在弹窗内
 * - 添加/编辑弹窗（向导式）：
 *   ① 接入协议选择（OpenAI 兼容自动探测 / 手动指定模型）
 *   ② 填 Base URL + API Key → 自动探测模型列表（默认均未启用，按需开启）
 *   ③ 每模型调上下文/最大输出/视觉 + 启用拨片
 *   ④ 折叠区：参数文件调试（slime.toml / 全局配置 / MCP / 技能库）内嵌于弹窗
 */
import React, { useState, useEffect, type JSX } from "react";
import type { ProviderSummary, ModelSpec, ConfigOverview, ConfigFileInfo, SkillInfo, McpServerInfo, LocalModelSpec } from "../../shared/ipc.js";
import { ChevronIcon, PlusIcon, CheckIcon, CloseIcon, RefreshIcon } from "../components/Icon.js";
import { confirmAsync } from "../dialog.js";
import { readCollapseDurMs } from "../collapseTiming.js";
import { REASONING_PRESETS, useReasoningPreset, saveReasoningPreset, EFFORT_LABEL, THINKING_PRESETS, useThinkingPreset, saveThinkingPreset } from "../reasoning.js";
import {
  describeTierSpec, describeCacheRateSource,
  describeTiersForDisplay, pricingSnapshotMeta, snapshotPricingInfo,
  resolveEffectivePricing, resolveModelPriceTier,
  builtInPriceTiers, createDefaultPriceTiers,
  // 「$ 与 ¥ 分开」：币种展示与折算标记都取共享层，面板不重复实现一套
  formatPricingAmounts, formatTierAmounts, USD_CNY_RATE,
  // A-990-B：用户手选币种（"手动调整币种填入"）—— 判据、换算、格式化全部取共享层
  pricingDisplayCurrency, officialPriceCurrency, formatAmountsInCurrency, isNativePriceCurrency,
  convertFromUsd, toUsdAmount, amountInCurrency, formatAmount, type PriceCurrency, type PriceFieldKey,
  // A-990-E：探针诊断（为什么走了内置表 / 是不是本地端点）
  classifyProbeOutcome, PROBE_OUTCOME_HINT,
  // A-990-G：价格核实日期（时效性必须在界面上可见）
  PRICING_VERIFIED_AT, pricingVerifiedAtUnknown,
  type PriceOrigin, type CacheRateSource, type ModelPriceTiers, type ModelPriceTier,
} from "../../../../shared/gen/model-capabilities.js";

interface DraftModel extends ModelSpec { selected: boolean; }

/**
 * A-988：可手填的四个费率字段。**顺序即 UI 展示顺序**，也是「是否还有手填值」的判定集合。
 * 命名对齐 LiteLLM 的 model cost map（input/output/cache_read/cache_creation），
 * 便于日后和外部价格表对拍。
 */
type PriceField = "price_in_usd" | "price_out_usd" | "price_cache_read_usd" | "price_cache_write_usd";
const PRICE_FIELDS: PriceField[] = ["price_in_usd", "price_out_usd", "price_cache_read_usd", "price_cache_write_usd"];

/**
 * 每个费率字段的展示元信息（明细行表头 / 占位符 / 悬停说明共用一份，不许在别处再手写一遍）。
 *
 * A-988c：**标签按"计量口径"统一**——这是用户这次指出"描述有问题"的根因。
 * 旧标签把两个不同抽象层级的词并排放着：
 *   - `输入（未命中缓存）` 是「token 类别 + 状态限定」
 *   - `缓存命中`          只是「状态」
 * 两者不对称，于是引出真实的误读：「缓存命中」到底算不算输入？那"命中缓存的输入"又该填哪儿？
 * 现在统一成"**输入**"这一族（输入 token 的两种命中状态）+ 一个非输入项（缓存写入）：
 *   - 输入（缓存未命中） ← 上游 usage 的 `prompt_tokens - cached_tokens`
 *   - 输入（缓存命中）   ← 上游 usage 的 `cached_tokens` / `cache_read_input_tokens`
 *   - 缓存写入           ← 上游 usage 的 `cache_creation_input_tokens`（**不是输入，是附加费**）
 * 术语与各家官方中文文档对齐（DeepSeek「缓存命中/未命中」、Anthropic「缓存读取/写入」、
 * OpenAI「cached input」），并且字段名 `price_cache_read_usd` / `price_cache_write_usd`
 * 保持不变（配置兼容优先，改名会让所有历史 providers.enc.json 失效）。
 */
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
  /**
   * A-988：当前展开「价目明细」行的模型 ID（null = 全部收起）。
   *
   * 为什么要展开式明细，而不是在表格里再塞两个输入框：表格可用宽度只有约 640px，
   * 7 列已经排满（外加一条"故意不设 minWidth"的血泪注释）。缓存命中/写入两个费率如果
   * 硬塞进去，只能分到 40px 上下 —— 又会复现用户这次报的"数字被裁成半截"。
   * 展开行是**整行铺满表宽**，四个费率字段各得约 150px，一次把 LiteLLM 那套
   * rate card（input / output / cache_read / cache_creation）摆全。
   */
  const [priceDetailId, setPriceDetailId] = React.useState<string | null>(null);
  /*
   * A-1015b：**收起时内容必须还在，否则高度插值的目标本身就是 0、动画空转**。
   *
   * 病根：明细区渲染的是一个 IIFE，里面 `if (!mm) return null` —— `priceDetailId` 一置 null，
   * `findIndex` 就返回 -1、内容当帧清空。于是 `.collapse` 虽然切掉了 is-open（开始向 0fr 插值），
   * 可 grid 行的内容高度**同一帧**已经变成 0，"从有到无"的目标高度在起点就已达成 →
   * 表现就是"展开有动画、收起是瞬间消失"（用户实测指出）。
   *
   * 修法：记住**最后一次打开过的 id**，收起时仍按它渲染内容；只让 .collapse 控制高度。
   * 用 state 而不是 ref：渲染期就能取到值，且不会出现"渲染中改写 ref"的脏写法。
   * 展开时 `priceDetailId` 优先，所以编辑草稿价格后明细照常实时刷新（lastDetailId 只是兜底）。
   */
  const [lastDetailId, setLastDetailId] = React.useState<string | null>(null);

  /* A-1017：展开后把明细滚到滚动视口**中央**（用户原话"每次展开后都不会追踪到展开的最中心"）。
   * 两个 ref：明细块本身（要居中的目标）+ 弹窗的滚动容器（对齐基准，不能用 window —— 弹窗是 fixed）。 */
  const detailBoxRef = React.useRef<HTMLDivElement | null>(null);
  const modalScrollRef = React.useRef<HTMLDivElement | null>(null);

  /* 必须等高度插值走完再滚：动画进行中的高度是**中间值**，按它算中心必然落偏。
   * 时长从全局变量 `--collapse-dur` 读（节拍唯一出处），不写死 450 —— 改节拍不用改这里。 */
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
      // label 可选（历史条目可能没写）→ 与 saveLocalModel 的 `input.label ?? id` 同口径兜底
      localPath: m.path, localLabel: m.label ?? m.id,
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
   * 手填单价 —— **四个字段同一套语义**：
   * 输入 / 输出 / 缓存命中 / 缓存写入（对齐 LiteLLM 的 rate card：input_cost_per_token、
   * output_cost_per_token、cache_read_input_token_cost、cache_creation_input_token_cost）。
   *
   * 一旦写入任何一个就标记 `price_source: "manual"` —— 自动探测（一键刷新 / 上游 /api/pricing）
   * 永不覆盖；四个输入框都清空则撤销 manual，交还给自动取值链路（上游 → 内置价目表 → 倍率推导）。
   *
   * ⚠️ `0` 是**有意义的**（官方限时免费 / 缓存免费），必须原样存下去，不能当"空"处理 ——
   * 这也是「0 = 免费 ≠ undefined = 未定价」这条铁律在 UI 侧的落点。
   *
   * A-990-B：**输入框里的数字单位 = 该模型当前的计价币种**（用户手选 > 归属地）。
   * 用户填 ¥8 → 这里换成 USD 再落库（`toUsdAmount`，与显示用的 `convertFromUsd` 共用同一个
   * `USD_CNY_RATE`）。为什么坚持"存 USD"：
   *   · `usage.jsonl` 的账目、历史成本回填、引擎取价全部以 USD 为单位；
   *   · 若让存储值随用户选的币种变，同一份配置在"记账侧"与"显示侧"会有两套解释，
   *     错 7.2 倍且**不会有任何报错** —— 这正是本项目"表里只有一个数字看不出币种"的事故形态。
   */
  function updateDraftPrice(index: number, field: PriceField, raw: string): void {
    const cur = edit?.models[index];
    if (!cur) { return; }
    const trimmed = raw.trim();
    let v: number | undefined;
    if (trimmed !== "") {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) { return; } // 非法输入直接忽略，不写脏值
      v = toUsdAmount(n, pricingDisplayCurrency(cur.id, cur.price_currency));
    }
    const next = { ...cur, [field]: v } as DraftModel;
    // 四个都空 → 交还自动取值。只要还剩任意一个手填值就保持 manual，
    // 否则「只填了缓存价」会被当成没手填而在下次刷新时被清掉。
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
          {/*
            A-1000：**自适应高度 + 大尺寸**（用户实测两轮后的定稿）。

            为什么不再用固定 `height: 78vh`：
            固定高度下，模型少（如 deepseek 只有 2 行）时 ③ 之后必然剩一大段空白 ——
            那段留白是"card 比内容高"的直接产物，无论把它放在滚动区内部的哪里都会显得突兀
            （用户连续两轮截图指认"还有空白"）。改成 `maxHeight: 92vh` 后：
            · 内容少 → card 跟着内容变矮，**没有空白**；
            · 内容多 → 长到 92vh 封顶，再增长由内部滚动承接（按钮不再被推走）。
            代价说明（诚实交代）：内容从"矮于上限"长到"触及上限"的过程中，底部按钮会随 card
            一起下移；触及上限后完全静止。用户明确选择"更大的弹窗 + 不滚动"，接受这个折中。

            为什么放大到 1000px 宽：原 680px 下内容区约 640px，模型表 6 列 + 价目明细的
            四费率格子都在挤（明细内部还要横向滚动）—— 用户原话"既然做这么大了，干脆把整个
            界面扩大点，免得我还要滚动"。1000px 让表格与明细都一次排开。
          */}
          <div className="card" style={{ width: 1000, maxWidth: "96vw", maxHeight: "92vh", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
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

            {/* 可滚动内容区（A-999：**弹窗内唯一滚动容器** —— ③ 模型调试 + 价目明细 + ④ 参数调试全在其中）
                留白只出现在最底部 + scrollbarGutter: stable（滚动条出现/消失不改变内容宽度 → fixed 表格不重排、列不左右跳）。
                ⚠️ A-1000：`flex: "1 1 auto"` 而**不是** `flex: 1` —— card 已改为自适应高度，
                `flex: 1` 的 `flex-basis: 0%` 在"高度由内容决定"的容器里会让本区**塌成 0 高**
                （自动高度下没有可分配的剩余空间，basis 0 的项按 0 计）。`basis: auto` 才会
                先按内容撑开、超出 92vh 上限时再按 shrink 收缩并滚动。 */}
            <div ref={modalScrollRef} style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: 4, scrollbarGutter: "stable" }}>
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

                {/* ③ 模型调试（A-999 定稿：恢复自然块，滚动统一交给外层「可滚动内容区」——
                    此前在它内部再套 flex:1/overflow = **双滚动容器打架**，是一系列跳动/空白的根源）。
                    价目明细是列表下方的固定区块（在本块内），不是插行、也不是浮层。 */}
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
                      {/* A-1000：上限 260 → 420（弹窗放大到 92vh / 1000px 后同步放大）。
                          A-997 的 scrollbar-gutter: stable 保留 —— 它消除"滚动条出现→内容被挤窄→
                          表格整表重排→列左右跳"，与明细怎么展开无关，属于列表自身的稳定项。 */}
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
                        {/*
                          快照新鲜度**常驻可见**：用户把"参数的最新性、时效性"定为底线，
                          那它就不能只存在于源码注释里 —— 看不到同步日期 = 无从判断这条价该不该复核。
                          `whiteSpace: nowrap` + `flexShrink: 0` 双保险（本仓换行问题的标准修法）。
                        */}
                        <span
                          title={`权威价目快照同步于 ${pricingSnapshotMeta().generatedAt}，共 ${pricingSnapshotMeta().count} 条`
                            + `\n来源：${pricingSnapshotMeta().litellmUrl}\n      ${pricingSnapshotMeta().openrouterUrl}`
                            + "\n刷新方式：仓库根目录执行 node scripts/sync-model-pricing.mjs（快照是**构建期产物**，不在运行时联网抓取 —— 否则成本统计会依赖第三方可达性）"}
                          style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
                          快照 {pricingSnapshotMeta().generatedAt} · {pricingSnapshotMeta().count} 条
                        </span>
                        <span style={{ fontSize: 11.5, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>共 {edit.models.length} 个 · 聊天界面只显示已启用</span>
                      </div>
                      {/*
                        ⚠️ 这里**故意不设 minWidth**。弹窗卡片固定 width:680（内容区约 640 CSS px），
                        此前写 `minWidth: 880`（后又加到 920）→ 表格比容器宽 280px，被裁得只剩中间一段：
                        左边模型 ID 只剩 "sh"/"-pro" 尾巴、右边「单价」列整列看不见，底部还多一条横向滚动条。
                        让表格 = 容器宽度才是对的；真窄到放不下时浏览器的 min-content 会自然给出滚动，
                        不需要（也不应该）用一个拍脑袋的 minWidth 去替它决定。
                        同理，列头文字长度**直接决定列的最小宽度**（th 有 nowrap），所以列头必须短：
                        "上下文(K)"→"上下文K"、"最大输出(K)"→"输出K"、"单价 $/M（输/出）"→"单价 $/M"（单位/双框语义移进 title）。

                        A-988 改动：改用 `tableLayout: "fixed"` + **百分比**列宽。
                        此前是 auto 布局 + th 上的像素宽度 —— 但 auto 布局里 th 的 width 只是"建议"，
                        浏览器按各列 min-content 重新分配，于是窄列被两侧的 nowrap 表头挤到比声明值更小
                        （用户看到 "10:" / "{" 就是这个结果）。fixed 布局下宽度**是权威的**，
                        再用百分比表达，窗口变化时按比例缩放，永远不会把某列压成 0 或顶出容器。

                        ⚠️ 下面这组百分比不是拍脑袋的，是用真实 Chromium 量出来的
                        （_probe_layout 探针，加载的就是本页真正在用的 index.css）。量了四件事：
                          ① 数字框的 content box ≥ 最坏文本宽度（"1024" 26.7px / "0.000001" 50.1px）；
                          ② nowrap 表头文字 ≤ 列宽（fixed 布局下 th 宽度是权威值，放不下会直接溢出）；
                          ③ ToggleSwitch 固定 40px ≤ 「启用」列宽；
                          ④ 徽标组（内置表+峰谷分时+▼ ≈104px）≤ 「定价来源」列宽。
                        预算按「滚动条占 17px」的最坏情况算（本机量到 4px，但 Windows 默认滚动条更宽），
                        即表格只有 ~629px 可用。改列宽前请先跑一次探针，别只按纸面算。
                      */}
                      {/*
                        A-993：**打开弹窗即全量检查**——对每个模型跑一次生效价解析，
                        谁的存值与官方价偏离 ≥5 倍（疑似历史错值，如被除过汇率的 0.0193）直接点名。
                        为什么放弹窗级而不是只在价目明细里：用户要求"全面检查"，
                        逐个点开价目明细才能发现 = 等于没检查。
                        ⚠️ 批量清空必须**一次 setEdit**（updateDraftModel 是闭包捕获，
                        循环调用只有最后一次生效）。
                      */}
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
                          <th style={{ padding: "5px 6px", width: "9.5%", whiteSpace: "nowrap" }} title="上下文窗口，单位 K token（输入 1024 = 1048576 token）">上下文K</th>
                          <th style={{ padding: "5px 6px", width: "9.5%", whiteSpace: "nowrap" }} title="最大输出，单位 K token（输入 64 = 65536 token）">输出K</th>
                          <th style={{ padding: "5px 6px", width: "6.5%", whiteSpace: "nowrap" }} title="支持图片输入">图片</th>
                          {/*
                            A-994：**外层列表不再放单价输入框**（用户指令：删掉这两个框，只留折叠明细栏）。
                            为什么必须删：这两个框直接显示**存储的 USD 裸值**，完全不受「单价币种」
                            影响 —— 官方 ¥ 刊例的模型（GLM 存的是 ¥0.8÷7.2 的折算值）在框里显示
                            `0.1111111/0.3888888` 这种"任何官方页面都查不到的一长串小数"，
                            且币种选择/原生价/折算标记只在展开的明细栏生效 → 用户看到的就是
                            "隔离没做、¥价全是折算的"。单价录入/显示/币种全部收进价目明细栏。
                          */}
                          <th style={{ padding: "5px 6px", width: "26%", whiteSpace: "nowrap" }} title="这是「引擎实际计费」所用的价格来源（不是配置里存了什么）。优先级：手填/上游结算价 > 本地端点免费 > 峰谷分时档 > 内置价目表 > 残留存值 > 未定价。**点击可展开价目明细**（单价录入 / 币种选择 / 缓存命中与写入费率 / 峰谷档全在明细栏里）。">定价来源</th>
                        </tr>
                      </thead>
                        <tbody>
                          {edit.models.map((m, i) => (
                            <React.Fragment key={m.id}>
                            <tr style={{ borderTop: "1px solid var(--border)" }}>
                              <td style={{ padding: "5px 6px 5px 8px" }}>
                                <ToggleSwitch
                                  checked={m.selected}
                                  onChange={(v) => updateDraftModel(i, { selected: v })}
                                  title={`${m.selected ? "停用" : "启用"} ${m.id}`}
                                />
                              </td>
                              {/*
                                模型 ID 用「单行 + 省略号」而不是 `break-all` 换行：
                                换行会让长 ID（deepseek-v4-flash-vision-exp）把行高从 31px 顶到 53px ——
                                用户报过"间隔怎么这么长"，根因就是行内出现第二行文字。fixed 布局下
                                列宽已是权威值（不再需要 min/max 兜住布局），完整 ID 走 title 悬停可见。
                              */}
                              <td style={{ padding: "5px 8px" }}>
                                <span title={m.id} style={{
                                  display: "block",
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}>{m.id}</span>
                              </td>
                              <td style={{ padding: "5px 6px" }}>
                                <input type="number" min={0} placeholder="auto" title="上下文窗口 (K token，输入 32 = 32768 token)"
                                  value={m.context_window ? String(Math.round(m.context_window / 1000)) : ""}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    updateDraftModel(i, { context_window: v ? Number(v) * 1000 : undefined });
                                  }}
                                  style={cellInputStyle()} />
                              </td>
                              <td style={{ padding: "5px 6px" }}>
                                <input type="number" min={0} placeholder="auto" title="最大输出 (K token，输入 8 = 8192 token)"
                                  value={m.max_output ? String(Math.round(m.max_output / 1000)) : ""}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    updateDraftModel(i, { max_output: v ? Number(v) * 1000 : undefined });
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
                                    // A-1015b：只记"打开"那一次；收起时 lastDetailId 留着供高度插值用。
                                    // 不用 setState 的 updater 形式做副作用（updater 必须纯净，严格模式下会重跑）。
                                    const next = priceDetailId === m.id ? null : m.id;
                                    if (next) { setLastDetailId(next); }
                                    setPriceDetailId(next);
                                  }}
                                />
                              </td>
                            </tr>
                            {/*
                              A-1017：价目明细**内联在对应模型行的正下方**。
                              用户原话："这个地方的展开为什么每次都是出现在最下面？我觉得展开应该是
                              出现在对应模型的下面，而不应是像弹窗一样。"

                              A-998 当初把它挪到"底部固定区块"的理由是插行会抖动 —— 但真正的抖动源是
                              **纵向滚动条挤压宽度**（内容变高 → 容器出现滚动条 → tableLayout:fixed
                              整表重排 → 列左右跳），而这一条已在同一轮修复里用 `scrollbarGutter: stable`
                              根治（见本弹窗的滚动容器）。宽度上没有第二个抖动源：fixed 布局的列宽由
                              thead 的 width 决定，colSpan 行不参与列宽计算。

                              ⚠️ `.collapse`（display:grid）**绝不能直接挂在 `<tr>` 上** —— 那会让这行
                              脱离 table-row 的显示类型，整张表散架。所以动画壳挂在内层 `<div>`：
                              tr（常驻、收起时高度为 0）→ td[colSpan] → .collapse → 内容。
                            */}
                            <tr>
                              <td colSpan={6} style={{ padding: 0, border: "none" }}>
                                <div className={`collapse${edit && priceDetailId === m.id ? " is-open" : ""}`}>
                                <div>
                                {(() => {
                                  // A-1015b：渲染用 `priceDetailId ?? lastDetailId` —— 收起瞬间 priceDetailId 已置 null，
                                  // 用 lastDetailId 兜住才能让内容留在 DOM 里参与高度插值（否则"展开有动画、收起瞬间消失"）。
                                  // 展开时 priceDetailId 优先 → 明细始终读**最新草稿数据**，不会显示旧价。
                                  const detailId = priceDetailId ?? lastDetailId;
                                  // 每行只渲染自己的那一份：其余行收起态且不持有内容 → 零开销。
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
                                        /*
                                         * A-1002：**必须带 `key`**。`PriceDetailRow` 现在持有"用户手动切了哪套视图"的
                                         * 局部状态（`viewOverride`），展开另一行时组件位置相同 —— React 复用实例会把
                                         * 上一个模型的选择带过来（"我明明在 A 上点了手动，点开 B 却还是手动"，
                                         * 而 B 的分时正在生效）。`key` 让每个模型独占一份状态。
                                         */
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
                        </tbody>
                      </table>
                    </div>
                  )}
                {/* A-1017：原先这里的「价目明细固定区块」已删除 —— 它固定渲染在模型列表**下方**，
                    位置与被展开的那一行无关（用户："每次都是出现在最下面……应该出现在对应模型的下面"）。
                    明细现在内联在对应模型行的 `<tr>` 里（见 tbody 内 `colSpan={6}` 那一行）。 */}
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
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 4 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>上下文 ctx_len (K)</div>
                    <input className="input-field" type="number" min={0} placeholder="auto（默认 8192）"
                      value={edit.ctx_len ? String(Math.round(Number(edit.ctx_len) / 1000)) : ""}
                      onChange={(e) => setEdit({ ...edit, ctx_len: e.target.value ? String(Number(e.target.value) * 1000) : "" })} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>GPU 层数</div>
                    <input className="input-field" type="number" min={0} placeholder="auto（默认 99）" value={edit.gpu_layers}
                      onChange={(e) => setEdit({ ...edit, gpu_layers: e.target.value })} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>最大输出 (K)</div>
                    <input className="input-field" type="number" min={0} placeholder="auto"
                      value={edit.max_output ? String(Math.round(Number(edit.max_output) / 1000)) : ""}
                      onChange={(e) => setEdit({ ...edit, max_output: e.target.value ? String(Number(e.target.value) * 1000) : "" })} />
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
                <span style={{ color: "var(--accent)", fontSize: 12, display: "inline-flex", alignItems: "center" }}>
                  <ChevronIcon size={14} rotate={debugOpen ? 90 : 0} />
                </span>
                参数文件调试（slime.toml / 全局配置 / MCP / 技能）
                {debugOpen && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>· 保存前自动备份 .bak</span>}
              </button>
              {/* A-1015：常驻 + 高度插值（此前 `{debugOpen && …}` —— 展开时弹窗内容当场变高，
                  与侧栏"起步快、收尾缓"的节奏不一致）。wrapper 两层：.collapse > 纯 div(grid 行)。
                  内容缩进**刻意不动**：这一带出过 202 处语法错的结构事故（A-999），只加壳不重排。 */}
              <div className={`collapse${debugOpen ? " is-open" : ""}`}>
              <div>
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

/**
 * A-1002：价目明细里的**两种定价方式**（互斥显示，一次只给一套配置界面）。
 *
 * 用户原话：「在这个可手动定价的部分…有分时的模型就不显示这个配置界面，只显示分时界面，
 * 没分时的或者没配置的就显示这个界面。当然，我不是让你删了，而是做一个额外的条件选择显示的功能。」
 *
 * 为什么必须互斥：单看这一块，两套配置并排摆着时用户无法判断**哪一套在生效** ——
 * 分时价与手填价是「谁压谁」的关系（自定义分时 > 手填 > 内置分时 > 内置表），
 * 并排显示把这个优先级关系表达成"两个都要配"，是界面在撒谎。
 *
 * 为什么不是硬删（用户明确要求「不是让你删了」）：
 *   ① 手填价是**覆盖分时**的正当手段（议价 / 合同价 / 网关按上下文加价），删了就没了；
 *   ② 无分时规格的模型仍然需要「自己定义分时」的入口（`TierEditor` 的 `!spec` 分支）；
 *   ③ 排障时需要在两套之间来回看（"我手填的和官方档位差多少"）。
 * 所以做成**条件选择**：默认显示引擎此刻采用的那一套，另一套一键可达。
 */
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

/**
 * 定价徽标（定价来源列）—— **A-988 起它同时是「价目明细」的展开开关**。
 *
 * **为什么必须单源**：本列显示的是「引擎实际按什么价记账」，而不是「配置里存了什么」。
 * 旧实现只看存值（`price_source` + `price_in_usd`），于是出现两种用户可见的分裂：
 *   ① 存值缺价但内置表有价 → 面板显示「未定价」，引擎却按 0.3 计费（投诉"flash 怎么还是没定价"）；
 *   ② 本地端点（127.0.0.1）存值缺价 → 面板显示「未定价」，引擎却套官方刊例价（凭空产生账单）。
 * 现在改由共享的 `resolveEffectivePricing` 统一判定 —— 与引擎**逐条同序**，不可能再分裂。
 *
 * 分时徽标（峰谷分时）单独一枚，与来源徽标**并排一行**（不要拆成两行：那会把行高翻倍，
 * 看起来像"行间距异常"，实测每行从 31px 涨到 53px）。
 *
 * **为什么把展开开关放在这里**：这一列的全部含义就是"钱从哪来"，点它看完整费率是最自然的
 * 心智模型；而且它不额外占宽度（表格已经没有余粮了，见 tbody 上方的宽度预算注释）。
 */
function PriceOriginBadges({ m, baseUrl, expanded, onToggle }: {
  m: DraftModel; baseUrl: string; expanded: boolean; onToggle: () => void;
}): JSX.Element {
  const eff = resolveEffectivePricing(m.id, baseUrl, m);
  const userTiers = m.price_tiers;
  // 自定义分时优先展示自己那份规格，否则展示内置规格（两者都只是文案，价格判定一律走 resolveEffectivePricing）
  const tierSpec = userTiers ?? builtInPriceTiers(m.id);
  const meta = ORIGIN_META[eff.origin];
  // 分时徽标只在**分时价真的参与计价**时出现。模型带分时规格 ≠ 这行在用分时价：
  // 本地端点 / 手填价 / 上游结算价都会压过分时价，此时挂个「峰谷分时」会让人以为时段在生效
  // （实测 127.0.0.1 上的 deepseek-chat 就命中了 deepseek 家族的分时规格）。
  const tierActive = !!tierSpec && (eff.origin === "table" || eff.origin === "tier" || eff.origin === "customTier");

  const lines = [`【${meta.text}】${ORIGIN_HINT[eff.origin]}`];
  if (eff.origin === "none") {
    lines.push("计费单价：未知（按 $0 记账）");
  } else {
    // 「$ 与 ¥ 分开」：币种与折算的判断全在共享层（`formatPricingAmounts`），面板不自己拼格式 ——
    // 面板再写一套 `$`/`≈$` 规则，必然与共享层漂移成"同一个价两处显示不一样"。
    lines.push(`计费单价：${formatPricingAmounts(eff) ?? `${fmtPrice(eff.priceIn)} / ${fmtPrice(eff.priceOut)} USD per 1M tokens`} tokens`);
    // A-1001：分时模型上这一行是**不带时刻**的平铺价（= 高峰标准价），必须说清楚 ——
    // 否则用户拿它去比"价目明细里的当前计费价"，会在空闲时段看到两个不同的数，
    // 又一次怀疑分时没生效（明细面板已按此刻取档，这里的口径不同是有意为之：
    // 列表要的是"确定性来源"，不是"此刻多少钱"）。
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
    // A-988：缓存价是本次新增的可手填字段，必须在悬停说明里也交代清楚它从哪来 —— **逐字段**说
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
    // 「把峰、谷时间端全部显示出来」——悬停也要能逐条看到谷时段。
    // 谷时段由兜底档的补集推导（见 TierWindowsBreakdown 注释），此处同样向共享层要数据。
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
      // 尽力而为的"此刻"提示：面板没有请求时刻，这里只是让用户知道离高峰价有多远
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
      {/* A-1015：展开指示箭头从字符 ▲/▼ 换成图标库 ChevronIcon（= chevron-right.svg 原样）。
          旋转由组件自带（走全局 --collapse-dur），与下方价目明细区块的伸展同一节拍。 */}
      <ChevronIcon size={10} rotate={expanded ? 90 : 0} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
    </button>
  );
}

/**
 * 缓存价来源徽标文案 —— **不再在面板里维护一份映射表**，直接问共享层要。
 *
 * A-988c：此前面板自带一张 `Record<CacheRateSource, …>`，与 shared 的来源语义各写一遍，
 * 于是出现"shared 说 table、面板说内置表继承、悬停说明又说按倍率推导"的三份说法。
 * 现在只有 `describeCacheRateSource` 一处文案（含 `推定不收费` 这种需要按值区分的特例）。
 * 取值也**按字段分开**：命中价与写入价的来源天然可能不同，共用一个徽标必然在其中一个字段上说谎。
 */
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

/* ═══════════════ A-988c：自定义分时（峰谷）定价编辑器 ═══════════════ */

/** 星期标签（0=周日，与 `PriceTierWindow.days` 一致） */
const DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * 金额输入（**带本地草稿态**）。
 *
 * 为什么不能直接用受控 number input：`value={String(n)}` + `onChange(parse(...))` 在用户
 * 敲下 "0." 的一瞬间 parse 出 0 → 值被回写成 "0" → 小数点被吃掉，**永远输不进小数**。
 * 而这里的价目全是小数（0.006、0.1375…），这是致命的。
 * 所以输入框自己保存字符串草稿，只在"能解析成合法非负数"时向上提交。
 *
 * `value === undefined` 表示**继承**（该档位不单独指定这一项，交给内置表 / 倍率规则补）。
 * ⚠️ 这点必须由本组件负责表达：如果把 undefined 一律渲染成 "0"，用户在框里点一下就
 * 会把 0 写进配置 —— 而 0 是"显式免费"，会盖掉内置表里真实的缓存价（少计费，且难发现）。
 * 因此空的框显示为空（靠 placeholder 提示会继承到什么），失焦时**还原为空**而不是填 0。
 */
function MoneyInput({ value, onCommit, width = 84, title, placeholder, block = false, step = "0.001", format }: {
  value: number | undefined; onCommit: (v: number | undefined) => void;
  width?: number; title?: string; placeholder?: string;
  /** 占满容器宽度（四个单价框在 `1fr` 网格里，固定 84px 会显得空荡且对不齐） */
  block?: boolean;
  /** 步进（人民币单价常见 `¥0.x`，用 0.001 会拖出一串小数提示） */
  step?: string;
  /**
   * 外部值 → 框内文本的格式化。
   *
   * 为什么需要它：本组件用 `String(value)` 初始化草稿。而单价框传进来的是**记账 USD 值**
   * （如 `1.1111111111`），直接 `String` 会印出 `7.99999999992` 这种长尾。
   * 传入 `format`（如「按当前币种折算 + 去尾零」）即可让框里显示用户当初敲的那个数。
   */
  format?: (v: number) => string;
}): JSX.Element {
  const fmt = (v: number): string => (format ? format(v) : String(v));
  const [draft, setDraft] = useState(value === undefined ? "" : fmt(value));
  // 外部值变化（「恢复内置默认」「切档位」「切币种」）时要跟随；但**不能在每次提交后覆盖草稿**，
  // 否则又回到上面那个吃小数点的老路。故只在草稿与外部值真的不一致时才同步。
  useEffect(() => {
    const next = value === undefined ? "" : fmt(value);
    const n = Number(draft);
    const same = draft.trim() === "" ? value === undefined
      : Number.isFinite(n) && value !== undefined && Math.abs(n - value) <= 1e-9;
    if (!same) { setDraft(next); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

/**
 * 时刻输入（HH:MM ↔ 当天分钟数）。
 *
 * 用 `type="time"` 而不是两个数字框，两个理由：① 数字框会重新撞上 A-988 那个
 * 原生 spinner 挤压宽度的老问题；② 时间选择器本身就挡掉了 "25:00" 这类非法值。
 * 值格式固定为 `HH:MM`（Chromium 在未设 `seconds` 时不带秒）。
 */
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

/**
 * 星期多选。**"每天" = 七个都选中**，而不是单独一个模式 —— 这样用户看到的就是真实集合。
 * 内部规整：七个全选中时存 `undefined`（= 每天），与数据模型语义一致，避免"看起来一样、
 * 存下去不一样"的两种表示。
 * 至少保留一天：取消最后一天时忽略该次点击（否则会得到空集合 → 语义退化成"每天"，
 * 用户会看到自己刚取消的那天又亮起来，像 bug）。
 */
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
              if (next.length === 0) { return; } // 至少一天，见上方注释
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

/** 常用计费时区（国内厂商几乎都是 Asia/Shanghai；把猜测面收窄到"有分时定价的厂商"） */
const TZ_PRESETS = [
  "Asia/Shanghai", "UTC", "Asia/Tokyo", "Asia/Singapore", "America/Los_Angeles", "Europe/London",
];

/**
 * 分时（峰谷）定价编辑器 —— A-988c 新增，把内置的 `priceTiers` 变成**用户可定义**。
 *
 * 设计取舍（三条，都为了"不会悄悄算错"）：
 *   1. **未开启自定义时不写任何东西**：只展示内置规格 + 一个「改为自定义」按钮。
 *      自动把内置规格抄进用户配置会立刻冻结它 —— 官方调价后这份拷贝不会更新，
 *      而且用户从没同意过。
 *   2. **开启时以内置规格为模板**（没有内置规格才用通用模板），价格种子取当前生效价，
 *      让用户从"接近正确"的数字开始改，而不是从 0 开始。
 *   3. **兜底档显式标注**：没有时段的档 = 兜底档（覆盖其余所有时间）。有多个兜底档时
 *      按数组顺序取第一个，UI 会把这种情况解释清楚，而不是让用户以为两个都生效。
 */
/**
 * A-988d：把上游探针**采集到、但刻意未自动生效**的定价信息展示出来。
 *
 * 为什么必须有这块 UI：B4 把探针从"硬编码字段链"扩成"表驱动 + 时段档 + 上下文分档 + 按次单价"，
 * 但如果采集结果不显示，用户看到的仍然只是「价目明细」那四个框 —— 与改造前毫无区别，
 * 也就无从判断探针到底有没有生效。**采集而不展示 = 没采集。**
 *
 * 三类信息各有各的处置方式，都写在这里，避免"为什么这个能导入、那个只能看"变成口口相传：
 *   ① 时段档候选 → 可导入（一键变成 `price_tiers`，之后完全由用户掌控）
 *   ② 上下文分档 → 只提示（slime 的取价没有"按输入长度加价"这一维，硬套会算错）
 *   ③ 按次单价   → 只提示（图像/音乐/视频不按 token 计费，混进 token 价会造出巨大假账）
 */
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
  // 「镜像记错」与「口径不同」必须分开呈现（SnapshotVetoKind）：
  //   - mirror-wrong：镜像真的记错了 → 橙色 ⚠️，用户在别处看到这个价应该无视；
  //   - basis-differs：两边都没错，只是计价口径不同（如 z.ai 美元价 ≠ 国内站人民币价）→
  //     **不能**标警告，否则等于告诉用户"官方公布的价是错的"，反而误导。
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

      {/*
        快照行：把"这条价其实来自社区镜像、以及镜像里还剩哪些分档信息"摆出来。
        快照是**二手价**，它的新鲜度与命中方式直接决定可信度 —— 只显示价格而不显示出处，
        用户无从判断该不该复核（这正是他投诉"你给我搞错了"时缺的那块信息）。
      */}
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

/**
 * 「峰 / 谷」全时段一览 —— 用户诉求「把峰、谷时间端全部显示出来」的最终落点。
 *
 * **为什么必须单独有一块**：分时规格里的兜底档（空闲价）刻意不写 `windows`
 * （缺省 = 其余所有时段，语义最精确、不会漏时段），但它让**谷时段在界面上彻底不可见** ——
 * 用户只看到「高峰 09:00-12:00、14:00-18:00」，无法确认夜间与周末到底算不算空闲，
 * 只能自己推理"剩下的是不是都按 0.15 算"。
 *
 * 时段由 `describeTiersForDisplay` 在共享层推导（谷 = 高峰窗口在整周上的补集），
 * **面板只负责画、不自己算**：任何"面板按一套逻辑高亮、计费按另一套逻辑取值"的分裂
 * 都从这种地方长出来（本面板存在的全部理由）。
 *
 * `at` 缺省 → 不标「当前」（不猜时刻）；传了才显示此刻命中哪个档。
 */
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
            {/*
              双币种并列（用户指令："把＄跟人民币分开"）：
              美元是这块表格的单位（成本统计口径是 USD），所以美元在前；
              官方公布过人民币价时**并列**给出 ¥，而不是让用户自己乘汇率 ——
              官方两列非等比（DeepSeek 英文页 $0.30/1.20 vs 中文页 ¥2/8），
              乘出来的数与账单对不上，会被当成又一处错价。
            */}
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

  // ── 未开启：只读展示内置规格 ──
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
        {/* 峰 / 谷**全部**时段逐条列出：兜底档不写 windows，不反推的话谷时段在界面上根本看不见 */}
        {builtIn && (
          <TierWindowsBreakdown spec={builtIn} at={new Date()} title="内置分时规格 · 全部峰/谷时段" />
        )}
        {/* 上游有候选时段档时，这里就多一个「导入上游时段」——用户不必照着上游文档手抄时段 */}
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

      {/* 计费时区：分时必须按供应商的钟判定，用户国外跑步也按这个时区记账 */}
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

      {/*
        核对视图：下面的编辑区看不到**谷时段**（兜底档没有可编辑的 windows，那正是它语义最精确的原因），
        所以这里额外把推导出来的谷时段逐条列出来 —— 用户改完高峰时段就能立刻确认
        "夜间/周末是否真的都落在空闲档"，不必自己在脑子里做减法。
      */}
      <TierWindowsBreakdown spec={spec} at={new Date()} title="当前规格 · 全部峰/谷时段（核对用）" />

      {/* 已经自己定义分时的人，同样需要看到"上游/镜像说的是什么价"——否则无从判断自己填的差了多少倍 */}
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

            {/*
              四个价格框的语义**故意不对称**：
                · 输入是必填（档位没有输入价就没有意义，清空即 0）
                · 输出/命中/写入**留空 = 继承**（分别继承"输入价 / 内置表或倍率 / 内置表或倍率"）。
              旧写法把 undefined 渲染成 "0"，用户点一下就把 0 当成"免费"写死，
              从而盖掉内置表里真实的缓存价 —— 少计费，而且因为"框里有数字"而极难发现。
            */}
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

      {/* 自定义编辑过程中也要能重新导入 / 看到上游还有哪些口径（用户改坏了还有个来源可对） */}
      <UpstreamPricingHints m={m} onImport={(t) => onChange(t)} />
    </div>
  );
}

/**
 * A-988：价目明细行 —— 四个费率字段的完整 rate card（展开在对应模型行的正下方）。
 *
 * 为什么不做成悬停 popover：表格的滚动容器是 `overflow: auto`，绝对定位的 popover 会被裁掉
 * （横向也会），而这恰恰是"模块弹窗"里最常见的坑。展开成真实 `<tr>` 就没有任何裁剪问题，
 * 而且天然获得整行宽度。
 *
 * 为什么四个字段要并排：这正是调研得到的行业做法（LiteLLM 的 model cost map / OpenRouter 的
 * pricing 对象都是 input / output / cache_read / cache_creation 四项并列），
 * **不能把缓存价折进输入价**——否则命中部分只能按全价记账。
 */
function PriceDetailRow({ m, baseUrl, onChange, onTiersChange, onClose, onCurrencyChange, onClearManual }: {
  m: DraftModel; baseUrl: string;
  onChange: (f: PriceField, raw: string) => void;
  onTiersChange: (t: ModelPriceTiers | undefined) => void;
  onClose: () => void;
  /** A-990-B：用户手选该模型的计价币种（录入 + 显示单位）；传 undefined = 恢复按归属地推断 */
  onCurrencyChange: (c: PriceCurrency | undefined) => void;
  /** A-993：清空四个手填单价 + manual 标记（保留分时档），恢复内置表自动取值 */
  onClearManual: () => void;
}): JSX.Element {
  /*
   * A-1001：本区展示的是「**此刻**这个模型按什么价记账」，所以两个口径都要拿，
   * 而且分工必须写死 —— 此前正好反了，直接造出用户截图里的同屏矛盾。
   *
   *   · `eff`（**带时刻**）= 主口径。引擎记的就是它：`engine.recordUsage` 里
   *     `at = new Date()` 既当 `ts` 又当取档依据，并把命中的档位写进 `price_tier`。
   *     面板若用不带时刻的确定性口径显示，就会出现「计费价 ¥2 / ¥8」与右侧
   *     「空闲时段 ● 当前」**同屏打架** —— 用户据此以为分时价没生效
   *     （A-1001 原话："可填入的表格的加码没有随着波峰波谷规定的时间变动而改变，
   *     这会影响分时价位的生效吗？"）。答案：引擎侧一直生效，**错的是这一行显示**。
   *   · `effFlat`（**不带时刻**）= 只用于两件"必须稳定、不能随秒针跳"的事：
   *     ① 手填值是不是"官方那个数"的比对基准（A-994 的 15% 阈值是按**平铺/高峰标准价**
   *        校准的 —— DeepSeek 全系实测得出；改用时刻价会让手填的官方价在谷时段
   *        突然丢掉原生 ¥ 显示，那正是 A-994 修掉的病）；
   *     ② `superseded`（"配置里这个数引擎不采用"）—— 它讲的是配置里的**残留值**，
   *        与此刻是峰是谷无关；让它随时刻闪进闪出只会变成噪音。
   */
  /*
   * A-1001b：让"此刻"真的会走。
   *
   * 没有这个 tick 时，取档只在**重渲染**时发生一次 —— 用户在 11:59 点开明细，
   * 12:00 之后界面仍写着「空闲时段」，而引擎按请求时刻判档、已经开始按高峰计价。
   * 这种分裂**没有任何症状**（数字看着都正常，只是旧的），正是本项目最忌讳的一类
   * 静默不一致。30s 一跳足够（档位边界只精确到分钟），代价可忽略；
   * tick 只存在于本组件，把影响面锁死在"这一块展示"上。
   */
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const eff = resolveEffectivePricing(m.id, baseUrl, m, new Date());
  const effFlat = resolveEffectivePricing(m.id, baseUrl, m);

  /*
   * A-990-B：本行的**计价币种** = 用户手选 > 归属地推断（判定收在共享层 `pricingDisplayCurrency`）。
   * 它决定两件事，且**只有**这两件事：
   *   ① 四个单价输入框里数字的**单位**（用户填 ¥8 就存成 USD 折算值，见 updateDraftPrice）；
   *   ② 价格行显示成 ¥ 还是 $。
   * 它**不改变记账**：存储与 `usage.jsonl` 恒为 USD。UI 只做「用户看得懂的单位 ↔ 记账单位」的翻译。
   */
  const cur = pricingDisplayCurrency(m.id, m.price_currency);
  /** 官方价原本是哪种币种 —— 用于文案"官方以 X 刊例" */
  const officialCur = officialPriceCurrency(m.id);
  /*
   * A-1002：该模型的分时规格 —— 用户自定义优先，否则内置家族规格（判据与 `PriceOriginBadges`
   * 逐字一致）。两者都只是**规格文本**，价格判定一律走 `resolveEffectivePricing`。
   */
  const tierSpec = m.price_tiers ?? builtInPriceTiers(m.id);
  /*
   * 当前币种下的价格是"原生值"还是"折算值"：判据取共享层的 `isNativePriceCurrency`，
   * **不在这里自己算** —— `formatAmountsInCurrency` 的 `≈` 前缀用的是同一份判据，
   * 两处各写一遍必然漂移成"数字没带 ≈、文字却说这是折算值"（本项目已多次吃过这类亏）。
   *
   * A-1001：还必须传**同一个 `eff` 对象**（带时刻的那份）。`≈` 前缀由
   * `formatAmountsInCurrency(eff, …)` 生成、文案由这里生成，两者一旦取了不同的口径，
   * 就会出现"数字没带 ≈ / 文字说是折算值"——判据共享但**输入不同**，等于没共享。
   */
  const curIsNative = isNativePriceCurrency(eff, cur);

  /**
   * 四个单价字段 → `EffectivePricing` 的字段名（`amountInCurrency` 用它们取"该字段的原生列"）。
   * 写成映射而不是散落的 if：**加字段时编译器会提醒**，避免"新字段忘了接原生 ¥ 列"。
   */
  const FIELD_KEY: Record<PriceField, PriceFieldKey> = {
    price_in_usd: "priceIn",
    price_out_usd: "priceOut",
    price_cache_read_usd: "priceCacheRead",
    price_cache_write_usd: "priceCacheWrite",
  };

  /**
   * A-990-C：按**当前币种**显示某个字段的生效值，**原生列优先**。
   *
   * 修的是什么：这四个输入框原先自己写 `convertFromUsd(v, cur)`，于是 DeepSeek 官方
   * `¥2 / ¥8` 被显示成 `0.3 × 7.2 = 2.16`、`1.2 × 7.2 = 8.64`（官方页面上根本不存在的数字，
   * 还带小数尾巴 —— 用户截图一眼就看出"官方文档都没有小数点"）。
   * 现在统一走 `amountInCurrency`：该字段有官方 ¥ 列就直接用官方数字，没有才折算并标 `≈`。
   */
  const effectiveInCurrency = (f: PriceField): { text: string; approx: boolean } | undefined => {
    const amt = amountInCurrency(eff, FIELD_KEY[f], cur);
    if (!amt) { return undefined; }
    return { text: formatAmount(amt.value), approx: !amt.native };
  };

  /*
   * A-990-C：手填框的"本地草稿态"复用共享的 `MoneyInput`（它已经解决了
   * "敲 `0.8` 时中间态 `0.` 被归一成 0 → 小数点被吃掉"的老问题）。
   * ⚠️ 这里**刻意不再内联第二份草稿逻辑** —— 同一 UX 修复写两遍，就是下一个漂移点。
   */
  /** 四个单价字段对应的原生 ¥ 列名（`manualDisplay` 用） */
  const CNY_KEY: Record<PriceFieldKey, "priceInCny" | "priceOutCny" | "priceCacheReadCny" | "priceCacheWriteCny"> = {
    priceIn: "priceInCny", priceOut: "priceOutCny", priceCacheRead: "priceCacheReadCny", priceCacheWrite: "priceCacheWriteCny",
  };
  /**
   * A-994：手填存值在**当前币种**下的显示数字。
   *
   * 核心规则（用户指令："有 ¥ 的数据就不要折算了"）：官方有原生 ¥ 列、且存值就是官方美元列
   * → **直接显示官方 ¥ 原数字，不折算**。
   *
   * ⚠️ 阈值 **15%** 是实测定出来的，不是拍的：官方美元列与人民币列**非等比**，
   * DeepSeek 全系的实测偏差——flash $0.3×7.2=¥2.16 vs ¥2（**8%**）、
   * pro $1.32×7.2=¥9.504 vs ¥9（**5.6%**）、缓存 $0.006×7.2=¥0.0432 vs ¥0.04（**8%**）。
   * 第一版用 5% → DeepSeek **全军覆没**（用户截图立刻打回）。
   * 15% 仍远小于真实议价的偏离幅度（通常 ≥30%），不会把议价价冒充成官方价。
   */
  const manualDisplay = (f: PriceField, v: number): number => {
    if (cur !== "CNY") { return convertFromUsd(v, cur); }
    // ⚠️ 这里用 `effFlat`（不带时刻）而**不是** `eff`：本函数判的是"用户敲的数字是不是官方
    // 刊例上那个数"，官方刊例的基准是**平铺/高峰标准价**，与此刻是峰是谷无关。
    // 用时刻价会让同一份手填值在谷时段突然显示成折算值（A-994 的病复发）。
    const cny = effFlat[CNY_KEY[FIELD_KEY[f]]];
    if (typeof cny === "number" && cny > 0 && v > 0 && Math.abs(v * USD_CNY_RATE - cny) / cny < 0.15) {
      return cny;
    }
    return convertFromUsd(v, cur);
  };

  /**
   * 某字段的「自动取值」（存值被清空后引擎会用的值）—— 与单价格子同一个数据源。
   *
   * A-1001：`eff` 带时刻，所以这里给的是**此刻**生效值 —— 引擎在同一时刻用的就是这个数。
   * 此前给的是不带时刻的平铺价，于是"清空即恢复"描述的是一个引擎根本不会用的数。
   */
  function autoValue(f: PriceField): number | undefined {
    switch (f) {
      case "price_in_usd": return eff.origin === "none" ? undefined : eff.priceIn;
      case "price_out_usd": return eff.origin === "none" ? undefined : eff.priceOut;
      case "price_cache_read_usd": return eff.priceCacheRead;
      case "price_cache_write_usd": return eff.priceCacheWrite;
    }
  }

  /**
   * A-1001：此刻命中的档位名，拼进四个单价框的自述里。
   *
   * 为什么必须带上：数字会随时间变，界面若不说是"哪个档"在变，用户只会看到
   * "刚才还是 ¥2、现在成了 ¥1"，第一反应是配置被人改了或分时没生效。
   * 非分时模型（无档位）为空串，不占视觉噪音。
   */
  const tierName = eff.tiered ? `（${eff.label ?? eff.tierId ?? "分时档"}）` : "";

  /*
   * ═══════════ A-1002：互斥显示的两套配置（分时档 / 手动单价） ═══════════
   *
   * 判据全部从**引擎的裁决结果**（`eff.origin`）反向推导，**不自己再算一遍优先级** ——
   * 本项目已经因为"同一个优先级写三遍"出过两次事故（见 resolveEffectivePricing 的注释）。
   */
  /** 该模型是否存在分时规格（内置家族规格 **或** 用户自定义）—— 决定「分时」这一栏有没有内容可看 */
  const hasTierSpec = !!tierSpec;
  /**
   * 分时价**此刻真的在参与计价**。
   * 判据与列表徽标的 `tierActive` 逐字一致（`table | tier | customTier`）—— 两处若不同，
   * 就会出现"徽标写着峰谷分时、明细里却说分时不生效"这类同屏矛盾（本地端点最容易踩到：
   * 127.0.0.1 上的 deepseek-flash 会命中 deepseek 家族的分时规格，但本地恒 0，分时并不参与）。
   */
  const tierActive = hasTierSpec && (eff.origin === "table" || eff.origin === "tier" || eff.origin === "customTier");
  /**
   * 手填价此刻在计费。
   *
   * ⚠️ 只认 `manual`，**不含 `upstream`**：上游价是网关回传的结算价，不是"你手填的这一套"。
   * 「手动单价」页签若在上游价生效时也标「● 生效中」，等于告诉用户"你填的价在算钱"——
   * 而框里可能是空的。生效来源由顶部那枚徽标（`ORIGIN_META`）如实交代，页签不重复也不夸大。
   */
  const manualInEffect = eff.origin === "manual";

  /**
   * 默认显示哪一套：**以"引擎此刻采用的那一套"为准**，而不是"配置里有什么"。
   *
   * ⚠️ 这里与用户原话有一处**刻意的偏差**，必须记下来：
   * 用户说「有分时的模型就不显示这个配置界面」—— 但如果该模型既**有内置分时规格**、
   * 又存在**正在生效的手填价**（origin === "manual"，手填按设计压过内置分时），
   * 此时"只显示分时界面"会让用户以为时段在生效，而账单其实是按手填价在算 ——
   * 那是比"两套并排"更严重的界面撒谎。所以默认切到手动，并在顶部**点名**这件事。
   * （自定义分时档存在时不存在这个问题：它的优先级高于手填，`origin` 会是 `customTier`。）
   */
  const defaultView: PriceView = tierActive ? "tier" : "manual";

  /**
   * 用户的显式手动切换（`null` = 未干预，跟随上面的自动判据）。
   *
   * 为什么不把 `view` 直接初始化成 `defaultView` 就完事：模型的分时配置**可以在本面板里被改**
   * （`TierEditor` 里的「改为自定义 / 关闭」），改完 `defaultView` 就变了。用"覆盖标记"
   * 能让自动判据继续生效，同时尊重用户点过的那一次选择。
   */
  const [viewOverride, setViewOverride] = useState<PriceView | null>(null);
  const view: PriceView = viewOverride ?? defaultView;

  return (
    /*
     * A-1000：**从 `<tr>` 改为普通 `<div>`**。
     *
     * 此前它返回 `<tr className="price-detail-row"><td colSpan={7}>…`，而 A-998 之后它被渲染在
     * 「价目明细固定区块」的 `<div>` 里 —— `<tr>` 出现在 `<div>` 之下是**非法 DOM 嵌套**
     * （React 会在控制台报 validateDOMNesting）。浏览器只是靠「匿名表格盒」把它兜住，
     * 副作用是宽度/内边距的归属变得不可预期（`tr` 的宽度由匿名表格决定，不受外层 div 控制）。
     * 明细既然已经不在表格里了，就不该再带表格语义 —— 直接换成 div，
     * 宽度交还给外层固定区块（`width` 由容器决定，所见即所得）。
     */
    <div className="price-detail-block">
      <div style={{ padding: "10px 12px 12px" }}>
          {/*
            A-988b：这一行曾经把「收起」挤成竖排两个字，根因不是宽度不够，而是**没有把
            "谁可以收缩"表达出来**：flex 默认 `flex-shrink: 1`，标题里的 `deepseek-flash`
            在连字符处断行、按钮里的「收起」在两个 CJK 字之间断行。
            所以修法必须是双保险，缺一不可：
              1. `whiteSpace: "nowrap"` —— 禁止在单词/汉字内部断行（文字层面）；
              2. `flexShrink: 0`  + `minWidth: 0` —— 禁止被压缩到内容宽度以下（布局层面）。
            只写 (1) 会变成溢出撑破弹窗，只写 (2) 依旧会断行 —— 这类"换行错误"反复出现的
            真实原因就是只补了其中一半。唯一允许收缩的是中间那句静态说明（每行都一样），
            它用 `flex: 1 1 auto + minWidth: 0 + ellipsis` 自己让位，且全文在 title 里可悬停查看。
          */}
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

          {/* 把"这个价现在到底是按什么在算"摆在最上面：分时档是最容易让人看不懂的一环 */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "nowrap", minWidth: 0 }}>
            <span style={{
              fontSize: 10, padding: "1px 5px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
              color: ORIGIN_META[eff.origin].color, background: ORIGIN_META[eff.origin].bg,
            }}>{ORIGIN_META[eff.origin].text}</span>
            <span
              /*
               * A-1001：这一行的数字是**随时段变的**，所以必须能用悬停问清"它为什么变"。
               * 没有这段说明时，用户的合理推断是"配置被改了 / 分时没生效"，
               * 而真相是"这一格本来就跟着峰谷时钟走，引擎记的也是同一个数"。
               */
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
                /*
                 * A-990「以模型所属地决定币种 + 金额尽量靠近整数」：
                 * 这里原先恒为 `输入 $x / 输出 $y USD / 1M` —— 国内厂商的模型于是显示成
                 * 折算出来的 `$0.275 / $1.1`（官方页面上根本不存在这个数，还带小数尾巴）。
                 *
                 * A-990-B 起：主显示币种 = **用户手选 > 归属地**（`pricingDisplayCurrency`）。
                 * `formatAmountsInCurrency` 内部**优先引用原生列**（官方 ¥ 价就是 ¥2，不是 $0.3×7.2
                 * 算出的 ¥2.16），只有"要的那一列不存在"时才折算并自动带 `≈`。
                 * 用户选的币种与官方价币种不一致时，额外把官方价原样附在后面 ——
                 * 否则用户在两个币种间切换时会看到两套对不上的数字，却不知道哪个才是官方价。
                 *
                 * A-1001：前缀由「计费价」改为「**当前**计费价」—— 命中分时档时这个数字随时钟变，
                 * 不写"当前"就与下面「● 当前」的档位标记对不上口径。
                 */
                : `${eff.tiered ? "当前计费价" : "计费价"}：${formatAmountsInCurrency(eff, cur) ?? "未定价"}${
                    curIsNative ? "" : `（官方以 ${officialCur === "CNY" ? "¥ 人民币" : "$ 美元"} 刊例：${formatPricingAmounts(eff) ?? "—"}）`
                  }`}
              {eff.tiered || eff.origin === "customTier"
                ? ` · 档位：${eff.label ?? eff.tierId ?? "—"}${eff.timezone ? `（${eff.timezone}）` : ""}`
                : ""}
              {/* A-1001：残留值提示走 `effFlat` —— 它讲的是"配置里的数不参与计费"，
                  与此刻命中哪个档无关；用时刻价会让这句话随时钟闪进闪出。 */}
              {effFlat.superseded ? ` · ⚠️ 配置里的 ${fmtPrice(effFlat.superseded.priceIn)} 引擎不采用` : ""}
            </span>
          </div>

          {/*
            A-990-E：「探针为什么没给出价」——用户原话「探针是探不到吗？为什么这些还是本地推断表？」
            此前界面只说"内置表"，用户无法区分「探针坏了」与「上游根本不发布价目」，
            而这两者对应的动作完全不同（去修探针 vs 什么都不用做）。
            分类判据在共享层 `classifyProbeOutcome`（纯函数、可单测），这里只渲染它给的话。
          */}
          <div style={{
            fontSize: 10.5, lineHeight: 1.55, marginBottom: 8, padding: "5px 7px", borderRadius: 4,
            background: "rgba(127,127,127,0.07)", color: "var(--text-dim)",
          }}>
            <span style={{ fontWeight: 600, color: "var(--text-muted)" }}>探针诊断：</span>
            {PROBE_OUTCOME_HINT[classifyProbeOutcome(eff.origin, baseUrl)]}
          </div>

          {/*
            A-993：**手填价压过内置表且严重偏离** —— 用户实测踩到（0.139/0.278/0.03，
            还原后正是历史错值 0.0193/0.0386/0.00417）。取价优先级"手填 > 内置表"是刻意设计
            （保护议价/合同价），不能自动覆盖；但**不亮出来就等于让错值静默生效**。
            给出偏离倍数 + 一键恢复内置表，决定权在用户。
          */}
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

          {/*
            A-990-H：**这条价是"逐条核对过的"还是"家族兜底"** —— 用户指出的病根。
            家族正则会让同家族跨代价差的型号共用一个价（`claude.*opus` 曾把 Opus 4.5+ 的
            $5/$25 按 Opus 4.1 的 $15/$75 计，高估 3 倍）。数字本身看不出出处，必须显式标注。
          */}
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
          {/*
            A-990-G：**把价格核实日期摆在明面上**（用户红线："时效性绝对不能有一丁点的落后"）。
            为什么必须显式：代码里的浮点常量看不出日期，"落后"因此**没有任何症状** ——
            用户只有拿官方文档来对才会发现（本次 DeepSeek/OpenAI 两次漏检都是这么暴露的）。
            有日期 = 用户一眼能判断"这条价还能不能信"；`unknown` = 明说"这批价没人核对过"。
          */}
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

          {/*
            ═══ A-1002：定价方式切换条（**互斥显示**的入口） ═══

            放在两套配置**正上方**：用户看到的下一个区块由这里的选中项决定，位置本身就是说明。
            两个叶签各自带「● 生效中」标记 —— 这正是用户最初想知道的"哪套在算钱"，
            而且它是从 `eff.origin` 反推的（引擎的裁决），不是"配置里填了什么"。
          */}
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
              // 「生效中」只在**引擎此刻真的采用这一套**时出现 —— 否则就是又一次撒谎
              const active = tab.id === "tier" ? tierActive : manualInEffect;
              return (
                <button
                  key={tab.id}
                  className="btn"
                  style={{
                    fontSize: 11, padding: "2px 9px", whiteSpace: "nowrap", flexShrink: 0,
                    background: on ? "rgba(139,123,247,0.18)" : undefined,
                    /*
                     * ⚠️ 必须写 `border` **整个简写**，不能只写 `borderColor`：
                     * `index.css` 的 `.btn` 是 `border: none` —— 没有边框可着色，`borderColor`
                     * 是静默失效的。而本切换条的选中态正是用户唯一能判断"我在哪套视图"的凭据。
                     * 又因为简写会改盒子尺寸，未选中时给**透明的同宽边框**（而不是 `none`），
                     * 否则每次切换按钮宽高跳 2px。
                     */
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

          {/*
            A-1002：进入分时视图时，若**存值在骗人**必须点名 —— 这是"互斥显示"唯一可能撒谎的地方。

            两个触发条件刻意取得**很窄**，因为宽泛的判据会造出新的假话：
              · `manualInEffect`（`origin === "manual"`）：手填价按设计**压过内置分时价** →
                分时此刻真的不生效，账单按手填算。这是必须标的 ⚠️（否则用户对着一张时段表
                以为时段在生效）。
              · `eff.superseded`（**共享层自己**判定"存值被更高优先级来源取代"）：存值是残留，
                引擎不采用。判据来自 `resolveEffectivePricing`，不是这里自己猜的 ——
                用"存了数字"当判据会说反话：`price_source` 为 undefined 的历史残留值
                （级别低于内置表 / 分时档）明明不参与计费，却会被标成"手填价正在压过分时"。
            两种都必须给出「清空手填」这一条出路，否则用户切走后**再也清不掉它**。
          */}
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

          {/*
            A-1002：进入手动视图时的两句提示 —— 都在讲"你在这里填的价，和分时是什么关系"。
            ⚠️ 判据必须窄（见上一条注释）：宽泛的"存了数字"会说反话。

            ① `m.price_tiers` 存在 → 自定义分时档优先，**手填不参与计费**（用户会以为填了没用是 bug）。
            ② 否则若 `hasTierSpec && manualInEffect` → 手填价正在压过**内置**分时价。
               这一条还有个额外作用：它就是"这个模型其实有分时"的**唯一提示**（默认显示的是手动视图，
               用户看不到分时界面）—— 不写这句，用户根本不知道清空就能回到时段计价。
          */}
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

          {/*
            A-990-B：**计价币种选择器**（用户指令："模型定价中，我希望可以手动调整币种填入"）。
            位置放在四个单价框**正上方**：它定义的是这几个框里数字的单位，先选单位再填数字。
            两个按钮而非下拉：只有两种币种，下拉要多一次点击且看不出"当前是哪个"。
            ⚠️ A-1002：整块（币种 + 四个单价框 + 缓存价说明）只在「手动单价」视图下渲染。
          */}
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
                  // 同切换条：`.btn` 是 `border: none`，只写 `borderColor` 不着色（静默失效）。
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
              /*
               * 生效值在**当前币种**下的显示：原生列优先（`effectiveInCurrency`）。
               * 这是本次修正的核心 —— 原先这里自己写 `convertFromUsd`，
               * 把官方 `¥2` 显示成 `0.3 × 7.2 = 2.16`。
               */
              const effShow = effectiveInCurrency(f);
              const effText = effShow ? `${effShow.approx ? "≈" : ""}${effShow.text}` : undefined;
              // 缓存价的徽标**按字段各取各的来源**：命中价与写入价常常一个手填、一个继承，
              // 合用一个徽标必然在其中一个格子上说谎（用户这次看到的就是写入格写"未定价"、
              // 徽标却写"内置表继承"）。
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
                  {/*
                    A-990-C：用共享的 `MoneyInput`（它已有"本地草稿"修复 —— 不会吃掉 `0.` 的小数点）。
                    这里**不再内联一套草稿逻辑**：同一 UX 修复写两遍就是下一个漂移点。
                    `value` 传的是**记账 USD 原值**、`format` 负责"按当前币种折算 + 去尾零"，
                    所以框里显示的是用户当初敲的数字，而不是 `7.99999999992` 这种长尾。
                  */}
                  <MoneyInput
                    block
                    step={cur === "CNY" ? "0.01" : "0.001"}
                    /*
                     * `value` 传**当前币种下的数字**（而不是记账 USD 原值）：
                     * `MoneyInput` 内部拿草稿与 `value` 比"是否一致"，两侧必须同量纲 ——
                     * 传 USD 原值会变成"显示 8 与存储 1.111 比大小"，永远判为不一致。
                     */
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
                      // 手填时这一行讲"清空后会回到什么"，所以给**生效值**（原生列优先），不是 autoValue
                      ? `生效值 ${effText ?? "—"} · 清空即恢复`
                      // A-1001：非手填行的这一格就是"引擎此刻会用的数" → 必须带上档位名，
                      // 否则用户只看到数字在变、不知道是分时在变（正是 A-1001 的提问来源）。
                      : `当前生效 ${effText ?? "未定价"}${tierName}`}
                  </span>
                </label>
              );
            })}
          </div>

          {/*
            缓存价的解释文案 —— **逐字段**说，不再用一句话同时覆盖两个字段。
            旧版本只说 `cacheRateSource`（单一来源），于是出现两种自相矛盾：
              · 只继承到命中价、写入价是 undefined 时，文案却声称"已从内置表继承已核实的值"，
                而写入格子里写着"未定价"；
              · 基准价为 0（local/免费模型）时也落进"按 0.1× 推导"分支，读起来像我们算错了。
          */}
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

          {/*
            A-1002：分时那一套（`TierEditor` 自带「内置规格只读展示 / 自定义档编辑 / 上游时段导入」三态）。
            只在「分时（峰谷）定价」视图下渲染 —— 与上面的手动单价块互斥。

            ⚠️ 切到本视图却**分时并不在算钱**时（手填价 / 本地端点压过它），顶部那句提示必须留下：
            否则用户会看着一套精美的时段表，以为账单是按它算的。`TierEditor` 内部的
            `tierActive` 由调用方语义保证（badge 与本视图共用同一份判据），这里补一句来源说明。
          */}
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

/*
 * A-994：`pricePlaceholder` / `priceInputHint` / `priceInputStyle` 三个函数已随外层
 * "单价 $/M 输/出"两框一起删除 —— 它们只为那两个框服务，而那两个框直接显示
 * 存储 USD 裸值（GLM 显示 0.1111111 这种折算残渣）、完全不受「单价币种」影响，
 * 是"币种隔离没做好"的根源。单价录入/币种/缓存费率全部收进价目明细栏
 * （`PriceDetailRow`，其占位/提示/生效值走 `amountInCurrency` 原生列）。
 */

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