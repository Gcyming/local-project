
















import { createHash } from "node:crypto";
import { basename, join } from "node:path";


export function previewSafeName(name: string | undefined): string {
  const raw = (name ?? "").trim();
  const noExt = raw.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const safe = noExt.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 40);
  return safe || "document";
}


export function previewFileName(name: string | undefined, html: string): string {
  const hash = createHash("sha1").update(html).digest("hex").slice(0, 16);
  return `${previewSafeName(name)}-${hash}.html`;
}






export function previewHtmlPath(dir: string, name: string | undefined, html: string): { path: string; name: string } {
  const fileName = previewFileName(name, html);
  return { path: join(dir, fileName), name: fileName };
}


export function previewUrlName(writtenPathOrName: string): string {
  return basename(writtenPathOrName);
}
