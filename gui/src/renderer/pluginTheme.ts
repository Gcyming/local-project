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

/** 选择持久化的键（值 = `plugin` 或 `plugin::皮肤名`；缺省/空 = 跟随内置主题）。
 *  与内置主题的 `slime-theme` 并列。 */
export const PLUGIN_THEME_STORAGE_KEY = "slime-plugin-theme";

/**
 * A-1200 · B2：**选择值的分段分隔符**（`<plugin>::<皮肤名>`）。
 *
 * ## 为什么需要它（多皮肤后旧格式不够用）
 * 旧格式只存插件名 ⇒ 一个插件多套皮肤时**分不清选的是哪一套**（甚至两套皮肤共用一个 key，
 * 持久化后互相串台）。所以新格式带皮肤名。
 *
 * ## ⚠️ 向后兼容分支（老选择必须还能生效）
 * 读到**不含**该分隔符的值 ⇒ 它是 A-1198 时代存的老格式（只有插件名）⇒ 解析成
 * 「**该插件的第一套**」。这样老用户升级后选择不丢（而不是静默回落默认 = 体验倒退）。
 */
export const PLUGIN_THEME_KEY_SEP = "::";

/** 由插件名 + 皮肤名拼出选择值（新格式，唯一 key 产地）。 */
export function pluginThemeSelectionKey(plugin: string, skinName: string): string {
  return `${plugin}${PLUGIN_THEME_KEY_SEP}${skinName}`;
}

/**
 * 解析选择值 → `{plugin, skinName}`；`skinName` 为 `null` 表示**老格式**（该插件的第一套）。
 * 纯函数（可单测）：不含分隔符 ⇒ 老格式；含 ⇒ 取第一段与最后一段（插件名不含分隔符）。
 */
export function parsePluginThemeSelection(
  selected: string,
): { plugin: string; skinName: string | null } | null {
  const raw = typeof selected === "string" ? selected.trim() : "";
  if (!raw) { return null; }
  const at = raw.indexOf(PLUGIN_THEME_KEY_SEP);
  /* ⚠️ 分隔符出现在开头/结尾也算非法（那不是老格式，是写坏了）⇒ 当成无效选择，
     让调用方回落默认 —— 而不是拿一个半截字符串去匹配皮肤。 */
  if (at < 0) { return { plugin: raw, skinName: null }; }
  const plugin = raw.slice(0, at);
  const rest = raw.slice(at + PLUGIN_THEME_KEY_SEP.length);
  if (!plugin || !rest) { return null; }
  return { plugin, skinName: rest };
}

/* ── 可用皮肤缓存（由 PluginThemeHost 每次快照刷新时写入；外观页订阅它）──────── */
let cachedThemes: AvailablePluginTheme[] = [];
let selection = readSelection();
const listeners = new Set<() => void>();

export interface AvailablePluginTheme {
  plugin: string;
  /** A-1200 · B2：同插件内区分第几套（= 皮肤名；与快照 DTO 同源）。 */
  id: string;
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
export function setPluginThemeSelection(pluginOrKey: string): void {
  const next = typeof pluginOrKey === "string" ? pluginOrKey.trim() : "";
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

function writeSelection(value: string): void {
  try {
    if (value) { localStorage.setItem(PLUGIN_THEME_STORAGE_KEY, value); }
    else { localStorage.removeItem(PLUGIN_THEME_STORAGE_KEY); }
  } catch {
    /* 隐私模式 / 无 localStorage：选择不持久化，本次会话仍生效（内存态已更新）。 */
  }
}

/**
 * 解析生效皮肤：选择为空、或选中的那一套已不在可用列表（被停用/卸载/删目录）⇒ null（回落默认）。
 * 「可开可关、卸下即恢复原样」的核心就这一行判断。
 *
 * ⚠️ A-1200 · B2：两套匹配口径**都要走**（老格式兼容分支就在这里）：
 *   · 新格式 `<plugin>::<皮肤名>` ⇒ 精确命中同一插件的**那一套**；
 *   · 老格式 `<plugin>`（无分隔符）⇒ 命中**该插件的第一套**（向后兼容，见
 *     `parsePluginThemeSelection` 的节注）。
 */
export function resolveActiveTheme<T extends { plugin: string; id?: string; name?: string }>(
  themes: T[], selected: string,
): T | null {
  if (!selected) { return null; }
  const parsed = parsePluginThemeSelection(selected);
  if (!parsed) { return null; }
  const samePlugin = themes.filter((t) => t.plugin === parsed.plugin);
  if (samePlugin.length === 0) { return null; }
  if (parsed.skinName === null) {
    /* 老选择（只存了插件名）⇒ 取该插件的**第一套**（快照按 plugin+id 排序 ⇒ 顺序稳定）。 */
    return samePlugin[0] ?? null;
  }
  return samePlugin.find((t) => (t.id ?? t.name) === parsed.skinName) ?? null;
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
