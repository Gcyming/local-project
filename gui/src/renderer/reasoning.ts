





import React from "react";
import { MODEL_CAPABILITIES, sortEfforts } from "../../../shared/gen/model-capabilities.js";


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
  
  value: string;
  
  label: string;
  
  efforts: string[];
}

export const REASONING_PRESET_KEY = "slime_reasoning_preset";














export const REASONING_PRESETS: ReasoningPreset[] = [
  { value: "upstream", label: "上游默认（以上游模型返回为准）", efforts: [] },
  
  
  ...MODEL_CAPABILITIES.map((v) => {
    const union = new Set<string>();
    for (const m of v.models) {
      for (const e of m.efforts ?? []) { union.add(e); }
    }
    return { value: v.key, label: v.label, efforts: sortEfforts([...union]) };
  }),
];


export function getReasoningPreset(): string {
  try {
    const v = localStorage.getItem(REASONING_PRESET_KEY);
    if (v && REASONING_PRESETS.some((p) => p.value === v)) { return v; }
  } catch {  }
  return "upstream";
}


export function saveReasoningPreset(v: string): void {
  const val = REASONING_PRESETS.some((p) => p.value === v) ? v : "upstream";
  try { localStorage.setItem(REASONING_PRESET_KEY, val); } catch {  }
  emitPresetChange();
}

const listeners = new Set<() => void>();
function emitPresetChange(): void { listeners.forEach((l) => { try { l(); } catch {  } }); }
export function subscribeReasoningPreset(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}


export function useReasoningPreset(): string {
  return React.useSyncExternalStore(subscribeReasoningPreset, getReasoningPreset);
}


export function presetEffortsOf(value: string): string[] | null {
  if (!value || value === "upstream") { return null; }
  const p = REASONING_PRESETS.find((x) => x.value === value);
  return p && p.efforts.length > 0 ? p.efforts : null;
}


export function presetLabelOf(value: string): string {
  return REASONING_PRESETS.find((p) => p.value === value)?.label ?? value;
}








export const THINKING_PRESET_KEY = "slime_thinking_preset";
export interface ThinkingPresetOption { value: string; label: string; }
export const THINKING_PRESETS: ThinkingPresetOption[] = [
  { value: "upstream", label: "上游检测（按供应商/模型推断，缺失时默认开启）" },
  { value: "on", label: "全部默认开启" },
  { value: "off", label: "全部默认关闭" },
];


export function getThinkingPreset(): string {
  try {
    const v = localStorage.getItem(THINKING_PRESET_KEY);
    if (v && THINKING_PRESETS.some((p) => p.value === v)) { return v; }
  } catch {  }
  return "upstream";
}


export function saveThinkingPreset(v: string): void {
  const val = THINKING_PRESETS.some((p) => p.value === v) ? v : "upstream";
  try { localStorage.setItem(THINKING_PRESET_KEY, val); } catch {  }
  emitPresetChange();
}


export function useThinkingPreset(): string {
  return React.useSyncExternalStore(subscribeReasoningPreset, getThinkingPreset);
}


export function thinkingPresetLabelOf(value: string): string {
  return THINKING_PRESETS.find((p) => p.value === value)?.label ?? value;
}


export function thinkingForcedOff(thinkingPreset: string, metadataKnown: boolean, metadataValue: boolean | undefined): boolean {
  if (metadataKnown) { return metadataValue === false; } 
  return thinkingPreset === "off";                        
}