/**
 * gui/src/renderer/reasoning.ts — 推理等级预设共享模块。
 * 设置入口：供应商弹窗 →「参数文件调试」折叠区，选择「上游默认 / 预制供应商」推理等级模式；
 * 聊天输入框的「推理配置」面板按该选择提供可选等级（默认「上游默认」= 完全以上游模型返回为准）。
 * 持久化于 localStorage（slime_reasoning_preset），跨组件经 useSyncExternalStore 实时同步。
 */
import React from "react";
import { MODEL_CAPABILITIES, sortEfforts } from "../../../shared/gen/model-capabilities.js";

/** 推理强度等级 → 中文名（展示标签；未收录的未知等级原样显示） */
export const EFFORT_LABEL: Record<string, string> = {
  none: "关",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  maximal: "最大化",
  adaptive: "自适应",
  auto: "自动",
  aggressive: "激进",
};

export interface ReasoningPreset {
  /** 存储值：upstream=上游默认；其余为预制供应商类型 */
  value: string;
  /** 下拉框展示名 */
  label: string;
  /** 该供应商可选的推理等级（升序，真实 API 可取值；不含 none——none=「自动」由面板首项承担） */
  efforts: string[];
}

export const REASONING_PRESET_KEY = "slime_reasoning_preset";

/**
 * 预制供应商推理等级（按各厂商 2026 年公开文档与生态实测整理）：
 * - upstream：不传推理强度参数，完全以上游模型返回/默认值为准；
 * - OpenAI：GPT-5/o 系列 reasoning_effort 全量取值（xhigh 需 GPT-5.2+/o3+，max/minimal 视具体版本）；
 * - Anthropic Claude：4.6+ adaptive thinking 的 effort（minimal/low 合并为 low；xhigh 需 4.7+，max 需 5）；
 * - DeepSeek：R1/V3 reasoning_effort（low/medium 内部映射 high，xhigh→max）；
 * - Google Gemini 3：thinking level（minimal 仅 Flash，Pro 从 low 起）；
 * - xAI Grok：Grok 4.x reasoning_effort（含 xhigh）；
 * - Moonshot Kimi：kimi 推理模型等级；
 * - 通义千问 Qwen：可控 effort 模型等级；
 * - MiniMax：M2.x reasoning_effort + thinking.type。
 * 注：同厂商不同模型版本对等级支持有差异，越界取值可能被上游拒绝 → 届时改回「自动」即可。
 */
export const REASONING_PRESETS: ReasoningPreset[] = [
  { value: "upstream", label: "上游默认（以上游模型返回为准）", efforts: [] },
  // A-918+ 单源合并：efforts 从 shared/model-capabilities.ts 的 MODEL_CAPABILITIES 派生（取该供应商
  // 所有模型的等级并集 + 共识排序），与 main 端 inferThinkingSupport 共用同一数据源，杜绝双份漂移。
  ...MODEL_CAPABILITIES.map((v) => {
    const union = new Set<string>();
    for (const m of v.models) {
      for (const e of m.efforts ?? []) { union.add(e); }
    }
    return { value: v.key, label: v.label, efforts: sortEfforts([...union]) };
  }),
];

/** 读取当前推理等级模式；未设置或非法值一律回落「上游默认」 */
export function getReasoningPreset(): string {
  try {
    const v = localStorage.getItem(REASONING_PRESET_KEY);
    if (v && REASONING_PRESETS.some((p) => p.value === v)) { return v; }
  } catch { /* ignore */ }
  return "upstream";
}

/** 保存推理等级模式（非法值回落「上游默认」）并通知所有订阅组件 */
export function saveReasoningPreset(v: string): void {
  const val = REASONING_PRESETS.some((p) => p.value === v) ? v : "upstream";
  try { localStorage.setItem(REASONING_PRESET_KEY, val); } catch { /* ignore */ }
  emitPresetChange();
}

const listeners = new Set<() => void>();
function emitPresetChange(): void { listeners.forEach((l) => { try { l(); } catch { /* ignore */ } }); }
export function subscribeReasoningPreset(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 跨组件实时订阅当前推理等级模式（ProvidersPanel 设置改动 → ChatPanel 输入框即时联动） */
export function useReasoningPreset(): string {
  return React.useSyncExternalStore(subscribeReasoningPreset, getReasoningPreset);
}

/** 指定预设可用的推理等级列表；未选择（上游默认/未知值）返回 null */
export function presetEffortsOf(value: string): string[] | null {
  if (!value || value === "upstream") { return null; }
  const p = REASONING_PRESETS.find((x) => x.value === value);
  return p && p.efforts.length > 0 ? p.efforts : null;
}

/** 预制预设展示名（未知值返回原文） */
export function presetLabelOf(value: string): string {
  return REASONING_PRESETS.find((p) => p.value === value)?.label ?? value;
}

/* ── 思考能力（思考历程）默认预设 ────────────────────────────────
 * 背景（A-80x）：供应商模型表的「思考」勾选列已删除——思考能力是模型元数据
 * （上游返回 / 引擎按供应商与模型 ID 推断），不应在表里手工勾覆盖；
 * 聊天输入框的「思考」按钮是唯一主动开关。
 * 本预设只在「上游元数据缺失」时兜底决定聊天侧思考开关的默认状态：
 * - upstream：跟随上游检测 / 按供应商与模型推断（缺失时默认允许思考）；
 * - on：一律默认开启；off：一律默认关闭（需要思考的模型在聊天界面手动打开）。 */
export const THINKING_PRESET_KEY = "slime_thinking_preset";
export interface ThinkingPresetOption { value: string; label: string; }
export const THINKING_PRESETS: ThinkingPresetOption[] = [
  { value: "upstream", label: "上游检测（按供应商/模型推断，缺失时默认开启）" },
  { value: "on", label: "全部默认开启" },
  { value: "off", label: "全部默认关闭" },
];

/** 读取当前思考能力默认预设；未设置或非法值一律回落「上游检测」 */
export function getThinkingPreset(): string {
  try {
    const v = localStorage.getItem(THINKING_PRESET_KEY);
    if (v && THINKING_PRESETS.some((p) => p.value === v)) { return v; }
  } catch { /* ignore */ }
  return "upstream";
}

/** 保存思考能力默认预设（非法值回落「上游检测」）并通知所有订阅组件 */
export function saveThinkingPreset(v: string): void {
  const val = THINKING_PRESETS.some((p) => p.value === v) ? v : "upstream";
  try { localStorage.setItem(THINKING_PRESET_KEY, val); } catch { /* ignore */ }
  emitPresetChange();
}

/** 跨组件实时订阅当前思考能力默认预设（ProvidersPanel 设置改动 → ChatPanel 即时联动） */
export function useThinkingPreset(): string {
  return React.useSyncExternalStore(subscribeReasoningPreset, getThinkingPreset);
}

/** 思考能力默认预设展示名（未知值返回原文） */
export function thinkingPresetLabelOf(value: string): string {
  return THINKING_PRESETS.find((p) => p.value === value)?.label ?? value;
}

/** 聊天侧思考开关是否应被强制关闭：上游元数据缺失时才受本预设兜底（off → 禁止） */
export function thinkingForcedOff(thinkingPreset: string, metadataKnown: boolean, metadataValue: boolean | undefined): boolean {
  if (metadataKnown) { return metadataValue === false; } // 上游/推断明确不支持
  return thinkingPreset === "off";                        // 元数据缺失 → 按预设兜底
}