/**
 * A-1198 · 续：扩展 CSS 贡献点（`contributes.css`）的渲染层**单一产地**。
 *
 * ## 用户口径（本轮放开的原因，原话）
 * 「还是把CSS 修改权限全面放开吧，倒也不是说修改，我说了是插件。
 *   通过插件来进行开关可控的改动」
 * ⇒ 插件是**用户自己装、自己开关**的，改配色/布局/字号属于"用插件武装"，
 * 不是"改穿程序本身"。这条与 §红线（不改动应用本身）**不冲突** ——
 * 红线针对的是"改程序"，不是"用自己的插件换外观"。
 *
 * ## 落值为什么这样（两条技术性必需，不是安全说教）
 *
 * ### ① `@layer`：让插件层**低于**宿主层
 * slime 有安全关键的 HTML 渲染 UI：权限请求弹窗（git commit 门禁 / diff 评审 / 脚本执行确认）
 * 走 JSX + 宿主样式表。CSS 若无层叠约束，`#f00{display:none}` 就能把「允许 / 拒绝」藏掉，
 * 让误操作默认通过 —— 那是**功能性失效**。
 * 做法（CSS 原生层叠，无 hacks）：
 *   ·宿主 `index.css` 整份包在 `@layer slime-host`；
 *   ·插件样式包在 `@layer slime-plugin`，并**先写一次顺序声明**
 *     `@layer slime-host, slime-plugin;`（层顺序由首次声明决定，之后写在哪个 `<style>` 里都一样）。
 * ⇒ 插件层永远低于宿主层：写多强的选择器都盖不掉宿主规则；其他地方则完全自由。
 *
 * ### ② 作用域类 `.slime-plugin-scope`
 * 自动加前缀（`scopePluginCss` 在 core-ts，单一产地），好处：
 *   · 插件 CSS 不波及扩展自己的 iframe 页面（那是独立文档）；
 *   · 没有插件 CSS 时宿主 DOM 上根本没有这个类 ⇒ 宿主 CSS 行为**逐字节不变**。
 *
 * ## 可开可关（与皮肤同一套语义）
 * 停用/卸载插件 ⇒ 插件不在可用列表 ⇒ 选择自动回落默认 + 整段 CSS 撤下（不残留）。
 * 换一套 CSS 不叠加：只有一段生效（单一 `<style id>` 复用）。
 *
 * ⚠️ 本文件不 import React —— node 可单测（DOM 写入的 `doc` 可注入替身）。
 */

import { scopePluginCss, type PluginCssDecl } from "../../../core-ts/src/plugin/contributes.js";

/** 选择持久化的键（值 = 插件名；空 = 不用扩展 CSS）。 */
export const PLUGIN_CSS_STORAGE_KEY = "slime-plugin-css";
/** 落值用的 `<style>` 元素 id（复用同一个 ⇒ 换肤不叠加）。 */
export const PLUGIN_CSS_STYLE_ID = "slime-plugin-css-style";
/** 作用域类（宿主有生效 CSS 时挂在 documentElement 上）。 */
export const PLUGIN_CSS_SCOPE_CLASS = "slime-plugin-scope";
/** 首次落值时写入的层顺序声明（决定 slime-host 高于 slime-plugin）。 */
export const PLUGIN_CSS_LAYER_ORDER = "@layer slime-host, slime-plugin;";

/** 最小 document 形态（测试传替身即可）。 */
export interface CssDocLike {
  getElementById(id: string): { textContent: string | null } | null;
  createElement(tag: string): { id: string; textContent: string; setAttribute(k: string, v: string): void };
  head: { appendChild(node: unknown): void };
  documentElement: { classList: { add(c: string): void; remove(c: string): void } };
}

export interface AvailablePluginCss {
  plugin: string;
  name: string;
  css: string;
}

/* ── 可用 CSS 缓存（由 PluginCssHost 每次快照刷新时写入；外观页订阅它）──────── */
let cachedCss: AvailablePluginCss[] = [];
let selection = readSelection();
const listeners = new Set<() => void>();

export function getCachedPluginCss(): AvailablePluginCss[] {
  return cachedCss;
}

/** 快照刷新入口（`plugins_changed` 或启动时调用）。数据变化即通知订阅者。 */
export function setCachedPluginCss(list: AvailablePluginCss[]): void {
  cachedCss = Array.isArray(list) ? list : [];
  emit();
}

export function getPluginCssSelection(): string {
  return selection;
}

/** 用户选择（"" = 不用扩展 CSS）。 */
export function setPluginCssSelection(plugin: string): void {
  const next = typeof plugin === "string" ? plugin.trim() : "";
  if (next === selection) { return; }
  selection = next;
  writeSelection(next);
  emit();
}

export function subscribePluginCss(fn: () => void): () => void {
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
    return localStorage.getItem(PLUGIN_CSS_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeSelection(plugin: string): void {
  try {
    if (plugin) { localStorage.setItem(PLUGIN_CSS_STORAGE_KEY, plugin); }
    else { localStorage.removeItem(PLUGIN_CSS_STORAGE_KEY); }
  } catch {
    /* 隐私模式 / 无 localStorage：选择不持久化，本次会话仍生效。 */
  }
}

/**
 * 解析生效 CSS 声明：选择为空、或选中的插件已不在可用列表（停用/卸载/删目录）⇒ null。
 * 「可开可关、卸下即恢复原样」的核心就在这一行判断。
 */
export function resolveActiveCss<T extends { plugin: string }>(list: T[], selected: string): T | null {
  if (!selected) { return null; }
  return list.find((c) => c.plugin === selected) ?? null;
}

/**
 * 把生效 CSS 落到 `<head>` 的单个 `<style>`（null ⇒ 整段撤下 +摘作用域类）。
 *
 * 形态固定为三层：`层顺序声明` + `@layer slime-plugin { …作用域化后的 CSS… }`。
 * 返回是否处于「有生效 CSS」状态（供调用方如实打日志）。
 */
export function applyPluginCss(decl: PluginCssDecl | null, doc: CssDocLike): boolean {
  const style = doc.getElementById(PLUGIN_CSS_STYLE_ID);
  if (!decl) {
    if (style) { style.textContent = ""; }
    doc.documentElement.classList.remove(PLUGIN_CSS_SCOPE_CLASS);
    return false;
  }
  const text = `${PLUGIN_CSS_LAYER_ORDER}\n@layer slime-plugin {\n${scopePluginCss(decl.css)}\n}\n`;
  if (style) {
    style.textContent = text;
  } else {
    const el = doc.createElement("style");
    el.id = PLUGIN_CSS_STYLE_ID;
    el.setAttribute("data-owner", "slime-plugin-css");
    el.textContent = text;
    doc.head.appendChild(el);
  }
  /* 作用域类挂在documentElement 上：宿主 CSS 一律不感知这个类（没插件时它根本不存在）。 */
  doc.documentElement.classList.add(PLUGIN_CSS_SCOPE_CLASS);
  return true;
}

/** 仅测试用：复位模块内状态（缓存/选择/订阅者）。 */
export function __resetPluginCssForTest(): void {
  cachedCss = [];
  selection = "";
  listeners.clear();
}