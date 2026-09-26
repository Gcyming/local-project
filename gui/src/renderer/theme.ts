/**
 * gui/src/renderer/theme.ts — 主题管理（localStorage 持久化 + data-theme 属性驱动 CSS 变量）。
 * alpha：既有 slate 深色 + 天蓝 accent；beta：毛玻璃质感、黑里透蓝（史莱姆品牌配色）。
 */
export type ThemeName = "alpha" | "beta";

/** 主题清单（**唯一出处**）：外观设置页据此渲染选择卡片。
 *  ⚠️ 从 `GeneralPanel.tsx` 搬到这里 —— 主题选择已经迁到「外观」栏，
 *     常量留在"通用"面板里等于把定义和唯一使用者拆开，下次谁都不知道该去哪改。 */
export interface ThemeDef {
  id: ThemeName;
  name: string;
  desc: string;
  swatch: string[];
}

export const THEMES: ThemeDef[] = [
  {
    id: "alpha",
    name: "Alpha",
    desc: "既有配色：slate 深色 + 天蓝 accent，沉稳清晰",
    swatch: ["#0f172a", "#1e293b", "#3b82f6"],
  },
  {
    id: "beta",
    name: "Beta",
    desc: "毛玻璃质感、黑里透蓝（史莱姆品牌配色：天蓝 / 紫 / 深蓝）",
    swatch: ["#0a0e1c", "#38bdf8", "#8cf6fb"],
  },
];

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
