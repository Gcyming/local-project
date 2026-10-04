



















export const DOC_ATTACH_MARK = "【附件】";

export type DocAttachment = { name: string; path: string };


export function baseNameOf(p: string): string {
  return (p ?? "").replace(/\\/g, "/").split("/").pop() ?? p;
}





export function formatDocAttachments(paths: readonly string[]): string {
  const list = paths.map((p) => (p ?? "").trim()).filter(Boolean);
  if (list.length === 0) { return ""; }
  return `\n\n${list.map((p) => `${DOC_ATTACH_MARK}${p}`).join("\n")}`;
}







export function splitDocAttachments(text: string): { body: string; docs: DocAttachment[] } {
  const src = text ?? "";
  if (!src.includes(DOC_ATTACH_MARK)) { return { body: src, docs: [] }; }
  const docs: DocAttachment[] = [];
  const kept: string[] = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t.startsWith(DOC_ATTACH_MARK)) {
      const path = t.slice(DOC_ATTACH_MARK.length).trim();
      if (path) { docs.push({ name: baseNameOf(path), path }); continue; }
    }
    kept.push(line);
  }
  
  const body = kept.join("\n").replace(/\n+$/, "");
  return { body, docs };
}
