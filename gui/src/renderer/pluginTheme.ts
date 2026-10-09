/**
 * A-1198 · 扩展皮肤（主题贡献点）的渲染层**单一产地**。
 *
 * ## 设计口径（用户原话）
 * 「高自由度扩展本质是**外部插件，可开可关的**……更像『精装』或者说『武装』。」
 * ⇒ 皮肤是外部插件的一个**声明**（`contributes.theme`：白名单设计令牌），由宿主落成全局
 * CSS 变量；插件停用/卸载 ⇒ 可用列表里没有它了 ⇒ **自动回落默认**（卸下即恢复原样）。
 * ⚠️ 没有任何扩展 CSS 进入宿主样式表 —— 这里只做「按映射表 setProperty」这一件事。
 *
 * ## 为什么这个文件不 import React
 * 为了能在 node 环境直接单测：选择解析（`resolveActiveTheme`）与落值计划
 * （`themeTokenAssignments`，在 core-ts）都是纯逻辑；DOM 写入只在 `applyPluginTheme`，
 * 且 `root` 可注入（测试传一个 `{ style: { setProperty/removeProperty } }` 替身即可）。
 */

import { themeTokenAssignments, type PluginThemeDecl } from "../../../core-ts/src/plugin/contributes.js";

/** 选择持久化的键（值 = 插件名；缺省/空 = 跟随内置主题）。与内置主题的 `slime-theme` 并列。 */
export const PLUGIN_THEME_STORAGE_KEY = "slime-plugin-theme";

/* ── 可用皮肤缓存（由 PluginThemeHost 每次快照刷新时写入；外观页订阅它）──────── */
let cachedThemes: AvailablePluginTheme[] = [];
let selection = readSelection();
const listeners = new Set<() => void>();

export interface AvailablePluginTheme {
  plugin: string;
  name: string;
  tokens: PluginThemeDecl["tokens"];
}

export function getCachedPluginThemes(): AvailablePluginTheme[] {
  return cachedThemes;
}

/** 快照刷新入口（`plugins_changed` 或启动时调用）。数据变化即通知订阅者。 */
export function setCachedPluginThemes(themes: AvailablePluginTheme[]): void {
  cachedThemes = Array.isArray(themes) ? themes : [];
  emit();
}

export function getPluginThemeSelection(): string {
  return selection;
}

/** 用户选择（"" = 默认）。选择不合法（插件不在列表）时调用方会经 resolve 回落并清空。 */
export function setPluginThemeSelection(plugin: string): void {
  const next = typeof plugin === "string" ? plugin.trim() : "";
  if (next === selection) { return; }
  selection = next;
  writeSelection(next);
  emit();
}

export function subscribePluginTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* 单个订阅者异常不影响其它订阅者与渲染 */ }
  }
}

function readSelection(): string {
  try {
    return localStorage.getItem(PLUGIN_THEME_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeSelection(plugin: string): void {
  try {
    if (plugin) { localStorage.setItem(PLUGIN_THEME_STORAGE_KEY, plugin); }
    else { localStorage.removeItem(PLUGIN_THEME_STORAGE_KEY); }
  } catch {
    /* 隐私模式 / 无 localStorage：选择不持久化，本次会话仍生效（内存态已更新）。 */
  }
}

/**
 * 解析生效皮肤：选择为空、或选中的插件已不在可用列表（被停用/卸载/删目录）⇒ null（回落默认）。
 * 「可开可关、卸下即恢复原样」的核心就这一行判断。
 */
export function resolveActiveTheme<T extends { plugin: string }>(themes: T[], selected: string): T | null {
  if (!selected) { return null; }
  return themes.find((t) => t.plugin === selected) ?? null;
}

/** 上一条落值写过的变量（移除时按它清理 —— 只清自己写过的，不碰别人的内联属性）。 */
let appliedVars: string[] = [];

/**
 * 把生效皮肤落到根元素的内联样式（覆盖内置主题的 `:root` 值；null ⇒ 全量清理 = 恢复默认）。
 * 返回本次写入的变量数（供调用方如实报告「落了多少个令牌」）。
 */
export function applyPluginTheme(
  theme: PluginThemeDecl | null,
  root: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } },
): number {
  const plan = theme ? themeTokenAssignments(theme) : [];
  const next = new Set(plan.map((p) => p.variable));
  for (const variable of appliedVars) {
    if (!next.has(variable)) { root.style.removeProperty(variable); }
  }
  for (const { variable, value } of plan) {
    root.style.setProperty(variable, value);
  }
  appliedVars = [...next];
  return plan.length;
}

/** 仅测试用：复位模块内状态（appliedVars/缓存/订阅者）。 */
export function __resetPluginThemeForTest(): void {
  appliedVars = [];
  cachedThemes = [];
  selection = "";
  listeners.clear();
}
