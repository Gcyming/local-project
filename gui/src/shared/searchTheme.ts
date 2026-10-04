
























export type AppThemeName = "alpha" | "beta";


export type SearchThemeName = "dark" | "light" | "auto";


export const APP_THEMES: readonly AppThemeName[] = ["alpha", "beta"] as const;


export const SEARCH_THEME_FALLBACK: SearchThemeName = "dark";


const SEARCH_THEME_MAP: Record<AppThemeName, SearchThemeName> = {
  alpha: "dark",
  beta: "dark",
};


export function searchThemeOf(appTheme: unknown): SearchThemeName {
  if (typeof appTheme !== "string") { return SEARCH_THEME_FALLBACK; }
  const mapped = (SEARCH_THEME_MAP as Record<string, SearchThemeName | undefined>)[appTheme];
  return mapped ?? SEARCH_THEME_FALLBACK;
}
