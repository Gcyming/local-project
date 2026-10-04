





















export type SearchPageMode = "local" | "online";


export interface SidebarSearchView {
  
  mode: SearchPageMode;
  
  query: string;
  
  count: number;
  
  titles: string[];
  
  opened?: { title: string; url: string; path?: string };
  
  error?: string;
  
  seq: number;
  
  at: number;
}


function asStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}









export function viewFromPageEvent(
  evt: unknown,
  seq: number,
  prev?: SidebarSearchView | null,
): SidebarSearchView | null {
  if (!evt || typeof evt !== "object") { return null; }
  const e = evt as Record<string, unknown>;
  const type = asStr(e.type, 40);
  





  const mode: SearchPageMode = e.mode === "online" || e.mode === "web" ? "online" : "local";
  const query = asStr(e.query, 200);
  const items = Array.isArray(e.items) ? e.items : [];
  const titles: string[] = [];
  for (const it of items.slice(0, 8)) {
    const t = it && typeof it === "object" ? asStr((it as Record<string, unknown>).title, 120) : "";
    if (t) { titles.push(t); }
  }
  const base = (): SidebarSearchView => ({
    mode,
    query,
    count: typeof e.count === "number" ? e.count : titles.length,
    titles,
    seq,
    at: Date.now(),
  });

  switch (type) {
    case "results":
      return base();
    case "open": {
      const v = base();
      const url = asStr(e.url, 2000);
      const path = asStr(e.path, 2000);
      v.opened = { title: asStr(e.title, 200) || titles[0] || "", url, path: path || undefined };
      return v;
    }
    case "mode":
      return { mode, query, count: 0, titles: [], seq, at: Date.now() };
    case "page": {
      const v = base();
      
      if (typeof e.page === "number") { v.titles = []; v.count = prev?.count ?? 0; }
      return v;
    }
    case "index": {
      const v = base();
      v.query = "";
      v.count = typeof e.docs === "number" ? e.docs : 0;
      return v;
    }
    case "error": {
      const v = base();
      v.error = asStr(e.error, 400) || "联网检索失败";
      return v;
    }
    case "ready":
      return { mode, query: "", count: 0, titles: [], seq, at: Date.now() };
    default:
      return null;
  }
}
