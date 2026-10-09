/**
 * A-1198 · 续：扩展 CSS 贡献点的宿主组件 —— 渲染层挂载点（App 根部，渲染 null）。
 *
 * 与 PluginThemeHost 同款三件（顺序即依赖）：
 *   ① 按需拉 `plugins_ui` 快照里的 `cssStyles` → 写进 `pluginCss` 缓存（订阅 `plugins_changed` 自动重拉）；
 *   ② 解析生效样式（`resolveActiveCss`）：选择失效（插件被停用/卸载/目录没了）⇒清脏选择 + 回落默认；
 *   ③ `applyPluginCss` 落到 `<head>` 的单个 `<style>`（`@layer slime-plugin` + `.slime-plugin-scope` 作用域）；
 *      无生效样式时**整段清空并摘掉作用域类**= 恢复内置外观，不残留。
 *
 * ⚠️ 为什么不直接碰宿主的 style 标签：`@layer` 要求插件层低于宿主层，
 * 而层顺序由**首个 `@layer` 声明**决定 —— 宿主 index.css 已整份包进 `@layer slime-host`，
 * 这里只需先写一次顺序声明 `@layer slime-host, slime-plugin;` 即可生效。
 * ⚠️ 文本已在 core-ts `parsePluginCss` fail-closed 校验（禁 @import/url()/@font-face/!important/
 *   全局选择器/position:fixed/@media/@keyframes/@supports），这里只做落值与清理，不再解析。
 */

import * as React from "react";

import type { PluginCssDTO } from "../../shared/ipc.js";
import {
  applyPluginCss,
  getCachedPluginCss,
  getPluginCssSelection,
  resolveActiveCss,
  setCachedPluginCss,
  setPluginCssSelection,
  subscribePluginCss,
  type AvailablePluginCss,
} from "../pluginCss.js";

export function PluginCssHost(): null {
  const [list, setList] = React.useState<AvailablePluginCss[]>(getCachedPluginCss());
  const [selected, setSelected] = React.useState<string>(getPluginCssSelection());
  /* 「快照已拉到过」才允许清脏选择 —— 否则启动早期（首拉未回）会把用户已保存的选择误清。 */
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    const off = subscribePluginCss(() => {
      setList(getCachedPluginCss());
      setSelected(getPluginCssSelection());
    });
    return off;
  }, []);

  React.useEffect(() => {
    let alive = true;
    const a = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const pull = async (): Promise<void> => {
      const res = await (a?.extras?.pluginsUi?.() as Promise<{ cssStyles?: PluginCssDTO[] } | null | undefined>).catch(() => null);
      if (!alive) { return; }
      if (!res || !Array.isArray(res.cssStyles)) { return; } // 拉失败/形状不对 ⇒ 不更新、不置 loaded（宁可不动）
      setCachedPluginCss(res.cssStyles as AvailablePluginCss[]);
      setLoaded(true);
    };
    void pull();
    const off = a?.extras?.pluginsOnChanged?.(() => { void pull(); });
    return () => { alive = false; if (typeof off === "function") { off(); } };
  }, []);

  React.useEffect(() => {
    const active = resolveActiveCss(list, selected);
    if (loaded && selected && !active) {
      /* 脏选择清理：插件没了，样式就没了 —— 不静默保留一个永不生效的选择。 */
      setPluginCssSelection("");
    }
    const on = applyPluginCss(active as Parameters<typeof applyPluginCss>[0], document);
    if (active) {
      console.info(`[gui:plugin-css] 已应用扩展 CSS「${active.name}」（${active.plugin}）`);
    } else if (loaded) {
      console.info(`[gui:plugin-css] 无生效扩展 CSS，已恢复内置外观`);
    }
    /* ⚠️ 不能 return 布尔（useEffect 清理函数只认函数/void）—— 与 PluginThemeHost 同款：
       这里没有任何卸载清理要做（样式由下一次 apply 覆写），所以不返回。 */
    void on;
  }, [list, selected, loaded]);

  return null;
}