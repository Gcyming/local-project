



export type ThemeName = "alpha" | "beta";




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
    
  }
}
