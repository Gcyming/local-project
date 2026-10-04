













export function cleanTargetPath(raw: string): string {
  const s = (raw ?? "").trim().replace(/^["']+|["']+$/g, "");
  
  return s.replace(/:\d+(?::\d+)?$/, "");
}


export function baseNameOf(raw: string): string {
  return splitPath(raw).base;
}






export function splitPath(raw: string): { dir: string; base: string } {
  const s = cleanTargetPath(raw);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i < 0) { return { dir: "", base: s }; }
  const upto = s.slice(0, i + 1);
  
  const dir = /^[a-zA-Z]:[\\/]$/.test(upto) || upto === "/" || upto === "\\" ? upto : upto.slice(0, -1);
  return { dir, base: s.slice(i + 1) };
}


export function extOf(raw: string): string {
  const name = baseNameOf(raw);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}










export const WEB_PREVIEW_EXTS: readonly string[] = [".html", ".htm"];


export function isWebPreviewPath(raw: string): boolean {
  return WEB_PREVIEW_EXTS.includes(extOf(raw));
}









export function shouldRenderAsWeb(rel: string, name?: string): boolean {
  return isWebPreviewPath(rel) || isWebPreviewPath(name ?? "");
}








export function pickServeBase(servedUrls: readonly string[] | undefined): string {
  const list = (servedUrls ?? []).map((u) => (u ?? "").trim()).filter((u) => u.length > 0);
  const loopback = list.find((u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i.test(u));
  const base = loopback ?? list[0] ?? "";
  return base.replace(/\/+$/, "");
}





export function encodeUrlPath(raw: string): string {
  return (raw ?? "")
    .split(/[\\/]+/)
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}


export function buildPreviewUrl(servedUrls: readonly string[] | undefined, relPath: string): string {
  const base = pickServeBase(servedUrls);
  const path = encodeUrlPath(relPath);
  if (!base || !path) { return ""; }
  return `${base}/${path}`;
}
