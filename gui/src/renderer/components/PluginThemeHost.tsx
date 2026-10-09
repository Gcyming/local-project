/**
 * A-1198 · 扩展皮肤（主题贡献点）的宿主组件 —— 渲染层唯一挂载点（App 根部，渲染 null）。
 *
 * 职责三件（顺序即依赖）：
 *   ① 按需拉 `plugins_ui` 快照里的 `themes` → 写进 `pluginTheme` 缓存（订阅 `plugins_changed`
 *      自动重拉 —— 扩展页装/卸/停用插件后皮肤列表自己刷新）；
 *   ② 解析生效皮肤（`resolveActiveTheme`）：选择失效（插件被停用/卸载/目录没了）⇒
 *      **清理脏选择 + 回落默认**（下次进来是干净默认态，不假装皮肤还在）；
 *   ③ 把令牌落到 `document.documentElement` 的内联样式；无生效皮肤时清理自己写过的变量
 *      （= 恢复内置主题原样，不残留）。
 *
 * ⚠️ 不做的事：不注入任何 CSS 文本、不碰样式表、不解析插件给的字符串（令牌值已在
 * core-ts `parsePluginTheme` fail-closed 校验过，这里只按映射表 setProperty）。
 */

import * as React from "react";

import type { PluginThemeDTO } from "../../shared/ipc.js";
import {
  applyPluginTheme,
  getCachedPluginThemes,
  getPluginThemeSelection,
  resolveActiveTheme,
  setCachedPluginThemes,
  setPluginThemeSelection,
  subscribePluginTheme,
  type AvailablePluginTheme,
} from "../pluginTheme.js";

export function PluginThemeHost(): null {
  const [themes, setThemes] = React.useState<AvailablePluginTheme[]>(getCachedPluginThemes());
  const [selected, setSelected] = React.useState<string>(getPluginThemeSelection());
  /* 「快照已拉到过」才允许清脏选择 —— 否则启动早期（首拉未回）会把用户已保存的选择误清。 */
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    const off = subscribePluginTheme(() => {
      setThemes(getCachedPluginThemes());
      setSelected(getPluginThemeSelection());
    });
    return off;
  }, []);

  React.useEffect(() => {
    let alive = true;
    const a = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const pull = async (): Promise<void> => {
      const res = await (a?.extras?.pluginsUi?.() as Promise<{ themes?: PluginThemeDTO[] } | null | undefined>).catch(() => null);
      if (!alive) { return; }
      if (!res || !Array.isArray(res.themes)) { return; } // 拉失败/形状不对 ⇒ 不更新、不置 loaded（宁可不动）
      setCachedPluginThemes(res.themes as AvailablePluginTheme[]);
      setLoaded(true);
    };
    void pull();
    const off = a?.extras?.pluginsOnChanged?.(() => { void pull(); });
    return () => { alive = false; if (typeof off === "function") { off(); } };
  }, []);

  React.useEffect(() => {
    const active = resolveActiveTheme(themes, selected);
    if (loaded && selected && !active) {
      /* 脏选择清理：插件没了，皮肤就没了 —— 不静默保留一个永不生效的选择。 */
      setPluginThemeSelection("");
    }
    const applied = applyPluginTheme(active, document.documentElement);
    if (active) {
      console.info(`[gui:plugin-theme] 已应用扩展皮肤「${active.name}」（${active.plugin}），落 ${applied} 个变量`);
    }
  }, [themes, selected, loaded]);

  return null;
}
