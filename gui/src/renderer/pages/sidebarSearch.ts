


















import type { SidebarSearchView } from "../../shared/searchView.js";


interface SlimeSearchApi {
  host: () => Promise<{ ok: boolean; url?: string; preload?: string; fingerprint?: string; error?: string }>;
  view: () => Promise<SidebarSearchView | null>;
  onView: (cb: (v: SidebarSearchView) => void) => () => void;
}
function api(): SlimeSearchApi | undefined {
  return (window as unknown as { slimeAPI?: { search?: SlimeSearchApi } }).slimeAPI?.search;
}



export interface SearchPageDelivery {
  
  url: string;
  
  preload: string;
  
  error: string;
}

let deliverPromise: Promise<SearchPageDelivery> | null = null;








export function getSearchPageDelivery(): Promise<SearchPageDelivery> {
  if (deliverPromise) { return deliverPromise; }
  const fail = (error: string): SearchPageDelivery => ({ url: "", preload: "", error });
  const p = (async (): Promise<SearchPageDelivery> => {
    const a = api();
    if (!a) { return fail("主进程接口未就绪（升级未完成或 preload 未加载）"); }
    let r: Awaited<ReturnType<SlimeSearchApi["host"]>> | null = null;
    try { r = await a.host(); } catch (e) {
      return fail("索取搜索页失败：" + (e instanceof Error ? e.message : String(e)));
    }
    if (!r || !r.ok || !r.url) { return fail(r?.error || "主进程没有返回搜索页地址"); }
    return { url: r.url, preload: r.preload ?? "", error: "" };
  })();
  deliverPromise = p.then((d) => {
    if (d.error) { deliverPromise = null; }   
    return d;
  });
  return deliverPromise;
}


export function __resetSearchPageDeliveryForTest(): void {
  deliverPromise = null;
}






export interface SidebarTabView {
  kind: "browser" | "file" | "terminal" | "tasks" | "git" | "none";
  
  url: string;
  title: string;
}


export interface SidebarSnapshot {
  tab: SidebarTabView;
  
  search: SidebarSearchView | null;
  
  seq: number;
  at: number;
}

const EMPTY_TAB: SidebarTabView = { kind: "none", url: "", title: "" };

let snapshot: SidebarSnapshot = { tab: EMPTY_TAB, search: null, seq: 0, at: 0 };
const listeners = new Set<(s: SidebarSnapshot) => void>();


export function getSidebarSnapshot(): SidebarSnapshot {
  return snapshot;
}


export function subscribeSidebarSnapshot(cb: (s: SidebarSnapshot) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function emit(next: Omit<SidebarSnapshot, "seq" | "at">): void {
  const s: SidebarSnapshot = { ...next, seq: snapshot.seq + 1, at: Date.now() };
  snapshot = s;
  for (const cb of Array.from(listeners)) {
    try { cb(s); } catch {  }
  }
}










export function publishSidebarTab(tab: SidebarTabView, searchUrl: string): void {
  const onSearch = tab.kind === "browser" && !!searchUrl && tab.url === searchUrl;
  emit({ tab, search: onSearch ? snapshot.search : null });
}


export function applySearchView(v: SidebarSearchView | null): void {
  if (!v) { return; }
  emit({ tab: snapshot.tab, search: v });
}





export function connectSidebarSearch(): () => void {
  let off: (() => void) | null = null;
  const a = api();
  if (a) {
    off = a.onView((v) => { applySearchView(v); });
    
    void a.view().then((v) => { applySearchView(v); }).catch(() => {  });
  }
  return () => { try { off?.(); } catch {  } };
}


export function __resetSidebarViewForTest(): void {
  snapshot = { tab: EMPTY_TAB, search: null, seq: 0, at: 0 };
  listeners.clear();
}




const KIND_LABEL: Record<SidebarTabView["kind"], string> = {
  browser: "浏览器",
  file: "文件",
  terminal: "终端",
  tasks: "任务",
  git: "变更",
  none: "",
};


export interface SidebarStatusText {
  
  label: string;
  
  inject: string;
}








const MOUNTABLE_KINDS: ReadonlySet<SidebarTabView["kind"]> = new Set(["browser", "file", "terminal"]);







export function describeSidebarSnapshot(s: SidebarSnapshot | null | undefined): SidebarStatusText | null {
  if (!s || !MOUNTABLE_KINDS.has(s.tab.kind)) { return null; }
  const kindLabel = KIND_LABEL[s.tab.kind] || s.tab.kind;
  const loc = (s.tab.title || s.tab.url || "").trim();

  
  const srch = s.tab.kind === "browser" ? s.search : null;
  if (srch) {
    const modeLabel = srch.mode === "online" ? "联网" : "本地索引";
    const parts: string[] = [`模式：${modeLabel}`];
    if (srch.query) { parts.push(`检索词：「${srch.query}」`); }
    if (srch.count > 0) { parts.push(`命中 ${srch.count} 条`); }
    if (srch.opened) {
      const o = srch.opened;
      parts.push(`已打开：${(o.title || o.url || o.path || "").trim()}`);
    }
    const head = `【右栏 · 搜索页】${parts.join("｜")}`;
    
    const extra: string[] = [];
    if (srch.error) { extra.push(`注意：右栏刚报过错 —— ${srch.error}`); }
    if (srch.titles.length > 0) {
      extra.push("结果前几条：\n" + srch.titles.slice(0, 5).map((t, i) => `${i + 1}. ${t}`).join("\n"));
    }
    if (srch.opened?.url) { extra.push(`用户当前打开的是：${srch.opened.url}`); }
    return {
      label: `搜索页 · ${srch.mode === "online" ? "联网" : "本地"}` + (srch.query ? ` · ${srch.query}` : ""),
      inject: [head, ...extra].join("\n"),
    };
  }

  
  return {
    label: `${kindLabel}${loc ? " · " + loc : ""}`,
    inject: `【右栏 · ${kindLabel}】${loc || "（未命名）"}` + (s.tab.url && s.tab.url !== loc ? `\n地址：${s.tab.url}` : ""),
  };
}
