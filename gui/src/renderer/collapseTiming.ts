/**
 * gui/src/renderer/collapseTiming.ts — 折叠节拍的**唯一 JS 读数口**。
 *
 * 为什么需要它：展开/收起的时长是 CSS 变量 `--collapse-dur`（节拍唯一出处，见 index.css）。
 * 但有些动作必须**等动画走完**才能做 —— 例如展开价目明细后要把它滚到视口中央：动画进行中
 * 元素高度只是插值中间值，按它算中心必然落偏。这类场景需要一个 JS 能读到的时长。
 *
 * 规则：不要在组件里写死 `450`，也不要在 `.tsx` 里现写读变量的逻辑（纯逻辑不许住 .tsx）。
 * 变量改了这里自动跟着变（改节拍只改一处）。
 */

/** 读任意 CSS 时长变量的毫秒值；变量缺失/格式不认 → 返回 fallbackMs。 */
export function readCssDurationMs(varName: string, fallbackMs: number): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallbackMs;
  }
  let raw = "";
  try {
    raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  } catch {
    return fallbackMs;
  }
  // 接受 `0.45s` / `450ms` / `450`（无单位按 ms）
  const m = /^([\d.]+)\s*(ms|s)?$/.exec(raw);
  if (!m) {
    return fallbackMs;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) {
    return fallbackMs;
  }
  return m[2] === "s" ? n * 1000 : n;
}

/** 折叠动画时长（= `--collapse-dur`）。兜底 450ms 与 index.css 的默认值一致。 */
export function readCollapseDurMs(): number {
  return readCssDurationMs("--collapse-dur", 450);
}
