/**
 * gui/src/renderer/theme.ts — 主题管理（localStorage 持久化 + data-theme 属性驱动 CSS 变量）。
 * alpha：既有 slate 深色 + 天蓝 accent；beta：毛玻璃质感、黑里透蓝（史莱姆品牌配色）。
 */
export type ThemeName = "alpha" | "beta";

const THEME_KEY = "slime-theme";

export function getTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "alpha" ? "alpha" : "beta";
  } catch {
    return "beta";
  }
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 隐私模式下忽略持久化失败 */
  }
}
