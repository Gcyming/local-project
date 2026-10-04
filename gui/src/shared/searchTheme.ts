/**
 * gui/src/shared/searchTheme.ts — 「主程序主题 → 搜索页主题」的**唯一产地**。
 *
 * ## 为什么需要一层映射（而不是直接传主程序主题）
 * 主程序的主题名是 **`alpha` / `beta`**（见 `gui/src/renderer/theme.ts`：
 * alpha = 既有 slate 深色 + 天蓝 accent；beta = 毛玻璃质感、黑里透蓝）。
 * 而搜索页（`apps/local-search-engine/index.html`）懂的是 **`dark` / `light` / `auto`**
 * （它要同时支持"被 slime 承载"和"用户双击独立打开"两种场景，后者不能依赖 slime 的枚举）。
 * ⇒ 两边**各有一套真名**，中间必须有翻译，否则要么页面认不出去（落到它自己的默认），
 *   要么有人图省事在传输处 `=== 'beta' ? 'dark' : 'light'` 拍一个 —— 那就是
 *   **同一事实两个产地**，改动主程序主题时必然漏改其中一处（静默失效）。
 *
 * ## ⚠️ 当前两个主题**都是深色**，所以映射里没有 light
 * 这不是"漏了"，是事实：`alpha` 与 `beta` 都基于深色底（beta 是"黑里透蓝"）。
 * ⇒ 用户永远不会在 slime 里看到浅色的搜索页。搜索页的 `light` 分支仍然保留，
 *   因为**独立双击打开**时它会跟随系统 `prefers-color-scheme`（页面自身的 `auto` 逻辑）。
 *   将来若 slime 真的加了浅色主题：**只改下面这张表**，别去别处加分支。
 *
 * ## 漂移守卫
 * `APP_THEMES` 必须与 `gui/src/renderer/theme.ts` 的 `ThemeName` 取值集合一致 ——
 * 这条由源码扫描守卫锁住（`tests/gui/a1137-search-bridge.spec.ts`），
 * 因为两边漂了**不会报错**：只是搜索页永远按 `dark` 显示，看起来"很正常"。
 */

/** 主程序主题名（与 `gui/src/renderer/theme.ts::ThemeName` **必须一致**，守卫锁住）。 */
export type AppThemeName = "alpha" | "beta";

/** 搜索页懂的主题名（与 `apps/local-search-engine/index.html` 的 `THEMES` 一致）。 */
export type SearchThemeName = "dark" | "light" | "auto";

/** 主程序现有全部主题名（守卫拿它和 renderer 的 `ThemeName` 对表）。 */
export const APP_THEMES: readonly AppThemeName[] = ["alpha", "beta"] as const;

/** 未知主程序主题时的兜底（宁可给深色，也不给一个页面认不出的值）。 */
export const SEARCH_THEME_FALLBACK: SearchThemeName = "dark";

/** 映射表：主程序主题 → 搜索页主题。**加主题只改这里。** */
const SEARCH_THEME_MAP: Record<AppThemeName, SearchThemeName> = {
  alpha: "dark",
  beta: "dark",
};

/** 翻译：任何主程序主题串 → 搜索页主题。未知值落兜底（不抛、不返回空）。 */
export function searchThemeOf(appTheme: unknown): SearchThemeName {
  if (typeof appTheme !== "string") { return SEARCH_THEME_FALLBACK; }
  const mapped = (SEARCH_THEME_MAP as Record<string, SearchThemeName | undefined>)[appTheme];
  return mapped ?? SEARCH_THEME_FALLBACK;
}
