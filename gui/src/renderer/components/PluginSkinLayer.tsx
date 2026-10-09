/**
 * A-1200 · B2：**全屏皮肤层**（`#slime-skin-layer`）—— 宿主在应用最底层新增的专用容器。
 *
 * ## 为什么需要它（对标 DSH 的「全屏覆盖 + 壁纸」）
 * B1 之前，皮肤只能改 CSS 变量 + 作用域内的 CSS ⇒ **够不到全屏**：
 * 作用域类挂在 `<html>` 上、`.card` 之类的选择器只能影响组件内部，
 * 而「整屏壁纸 / 全屏纹理 / 全屏渐变」这种外观在结构上做不到。
 * ⇒ 宿主给一个**专用容器**，皮肤可以给它下样式（`background-image` 等），
 * 从而做到 DSH 那种全屏覆盖。**它只是一个空容器**（`pointer-events: none`），
 * 皮肤写 `background` 即可，宿主不注入任何扩展代码（红线不变）。
 *
 * ## z-index 取值：**直接沿用 B1 的 `PLUGIN_OVERLAY_Z = 1100`**（同一份取值表）
 * 既有实测值（`index.css` / `App.tsx`）：下拉菜单 3000、对话框 backdrop 1200、
 * 本地模型加载面板 1000、`.ghost-dropdown` 3000、`.op-focus-frame` 900/901、
 * `.browser-error-page` 8。
 * ⇒ 取 **1100**：高于应用内容与本地模型加载面板(1000)，**低于对话框 backdrop(1200)**。
 * 于是「能全屏改外观」与「**盖不掉权限确认/设置对话框**」两件事同时成立
 * （设计 §5：不许让扩展覆盖宿主安全关键 UI）。⚠️ 不另发明一套取值 ——
 * 另发明就会出现「皮肤层 1300 / 对话框 1200」这种盖掉确认按钮的组合。
 *
 * ## 可开可关（不留残影）
 * 无生效皮肤 / 无生效 CSS ⇒ **整个容器不渲染**（`null`）—— 不是「渲染一个空 div」：
 * 空 div 也会挡住根元素的背景与 `pointer-events` 语义，是残留。
 */
import React, { type JSX } from "react";

import { getPluginThemeSelection, getCachedPluginThemes, subscribePluginTheme } from "../pluginTheme.js";
import { getPluginCssSelection, getCachedPluginCss, subscribePluginCss } from "../pluginCss.js";

/** 皮肤层容器 id（宿主唯一挂载点；皮肤写 `#slime-skin-layer { background: … }` 即可全屏改外观）。 */
export const SKIN_LAYER_ID = "slime-skin-layer";

/** 皮肤层 z-index：与 `UiSlotHost` 的 `PLUGIN_OVERLAY_Z` **同值**（同一份取值表，见上方节注）。 */
export const SKIN_LAYER_Z = 1100;

export function PluginSkinLayer(): JSX.Element | null {
  /* 「有没有生效外观」= 有选中的皮肤，或有选中的 CSS。
     两者互斥生效（外观页口径），所以这里用 or 判即可 —— 但**取值要实时**：
     订阅两个缓存的变化，停用/卸载/切默认后容器必须立刻消失。 */
  const [active, setActive] = React.useState<boolean>(() => hasAnySelection());
  React.useEffect(() => {
    const sync = (): void => { setActive(hasAnySelection()); };
    const offTheme = subscribePluginTheme(sync);
    const offCss = subscribePluginCss(sync);
    /* 首拉快照后缓存才变（外挂窗口启动时localStorage 已有选择但缓存还没拉到）⇒ 补拉一次。 */
    sync();
    return () => { offTheme(); offCss(); };
  }, []);

  if (!active) { return null; }
  return (
    <div
      id={SKIN_LAYER_ID}
      data-slime-skin-layer="1"
      style={{
        position: "fixed", inset: 0, zIndex: SKIN_LAYER_Z,
        /* 容器不吃点击（皮肤只是外观，不该挡住任何交互）；
           皮肤若要可交互的部件，应走 B1 的 panel 区域而不是这一层。 */
        pointerEvents: "none",
      }}
    />
  );
}

/** 有没有「用户明确选了某个外观」（空选择 = 跟随内置主题 ⇒ 不需要这一层）。 */
function hasAnySelection(): boolean {
  const themeSel = getPluginThemeSelection();
  if (themeSel && getCachedPluginThemes().some((t) => t.plugin === themeSel.split("::")[0])) { return true; }
  const cssSel = getPluginCssSelection();
  if (cssSel && getCachedPluginCss().some((c) => c.plugin === cssSel)) { return true; }
  return false;
}