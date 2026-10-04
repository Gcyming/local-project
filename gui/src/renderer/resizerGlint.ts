


























import type * as React from "react";



const GLINT_VAR = "--rz-y";





export function trackResizerGlint(e: React.MouseEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const host = el.parentElement;   
  if (!host) { return; }
  const r = el.getBoundingClientRect();
  if (r.height <= 0) { return; }
  const pct = ((e.clientY - r.top) / r.height) * 100;
  const clamped = Math.max(0, Math.min(100, pct));
  host.style.setProperty(GLINT_VAR, `${clamped.toFixed(2)}%`);
}





export function clearResizerGlint(e: React.MouseEvent<HTMLElement>): void {
  e.currentTarget.parentElement?.style.removeProperty(GLINT_VAR);
}
