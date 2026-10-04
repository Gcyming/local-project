/**
 * gui/src/renderer/pages/sidebarSearch.ts — 右栏搜索页在**渲染层**的两个关注点（A-1137）。
 *
 * ## 两段，各有各的职责（同一个文件因为它们只在这一个功能里成对出现）
 * §1 **交付信息**：搜索页的 URL + guest preload 的 `file://` 路径 —— 只有主进程知道
 *    （渲染层不知道构建产物布局，dev 与打包后还不一样）⇒ 这里只负责**问一次并缓存**。
 * §2 **右栏视图**：右栏此刻开着什么、搜索页在搜什么 —— 渲染层自己有一部分（页签状态），
 *    另一部分来自 guest 上报经主进程转发。**这里是它俩汇合的唯一产地**，
 *    对话侧（`ChatPanel`）只订阅这一个来源，不去各自打听。
 *
 * ## ⚠️ 三个必须守住的点
 * 1. **交付信息只问一次**（memo 化的 Promise）。⚠️ 失败时**不缓存失败**：否则用户看一眼"搜索页
 *    打不开"就永远打不开了，只能重启（"一次失败变永久失败"是本仓反复踩过的坑，铁律 17 的同宗）。
 * 2. **页面事件 → 视图的翻译不在渲染层**（在 `gui/src/shared/searchView.ts`，主进程调用）。
 *    渲染层只接收已经归一化好的 `SidebarSearchView`，不解释页面的私有枚举。
 * 3. **"空白浏览器页显示搜索页"不回写页签 URL** ⇒ 页签的 `url` 可能仍是空串。所以
 *    "此刻在不在搜索页"要按**有效 URL**（`tab.url || homeUrl`）判，不能按 `tab.url` 判
 *    —— 否则状态条会在"用户明明开着搜索页"时说"没有搜索页"。
 */
import type { SidebarSearchView } from "../../shared/searchView.js";

/** `window.slimeAPI` 的最小形状（只声明本文件用到的部分：主进程那边才是权威定义）。 */
interface SlimeSearchApi {
  host: () => Promise<{ ok: boolean; url?: string; preload?: string; fingerprint?: string; error?: string }>;
  view: () => Promise<SidebarSearchView | null>;
  onView: (cb: (v: SidebarSearchView) => void) => () => void;
}
function api(): SlimeSearchApi | undefined {
  return (window as unknown as { slimeAPI?: { search?: SlimeSearchApi } }).slimeAPI?.search;
}

/* ══════════════ §1 交付信息（搜索页 URL + guest preload 路径） ══════════════ */

export interface SearchPageDelivery {
  /** 搜索页 URL（本机回环上的 http 地址）。空串 = 没交付成功。 */
  url: string;
  /** guest preload 的 `file://` 路径。空串 = 没拿到（页面会"能看但搜不动"）。 */
  preload: string;
  /** 交付失败的原因（**必须显示**，否则用户只能看到"新建浏览器页打不开"）。 */
  error: string;
}

let deliverPromise: Promise<SearchPageDelivery> | null = null;

/**
 * 问主进程要搜索页的交付信息。**进程内只成功问一次**；失败不入缓存（下次调用会重试）。
 *
 * 为什么成功才缓存：从 `slime:http:serve` 起到本地服务是**一次性**动作，
 * 成功后端口不会变；而失败的原因常常是暂时的（服务还没起来 / 主进程刚启动）——
 * 把失败也缓存起来就等于"一次抖动 = 永久打不开"。
 */
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
    if (d.error) { deliverPromise = null; }   // 失败不留缓存 ⇒ 下次重试
    return d;
  });
  return deliverPromise;
}

/** 仅供测试复位。 */
export function __resetSearchPageDeliveryForTest(): void {
  deliverPromise = null;
}

/* ══════════════ §2 右栏视图（渲染层与 guest 上报的汇合点） ══════════════ */

/** 右栏此刻挂着的东西。
 *  ⚠️ 页签类型**逐个列出**（不从 RightSidebar 的 `TabType` 派生）：`none` 是这里新增的一态
 *  （右栏一个页签都没有），而 `TabType` 里没有它 —— 派生会让"没有页签"被迫挤进某个真实类型里。 */
export interface SidebarTabView {
  kind: "browser" | "file" | "terminal" | "tasks" | "git" | "none";
  /** **有效** URL（空白浏览器页显示搜索页时，这里就是搜索页地址 —— 不是空串）。 */
  url: string;
  title: string;
}

/** 对话侧状态条的完整输入。 */
export interface SidebarSnapshot {
  tab: SidebarTabView;
  /** 只有"此刻确实开着搜索页"时才是非空（否则旧视图会被当成现状，那是最坏的一种错报）。 */
  search: SidebarSearchView | null;
  /** 快照序号（订阅方用它判断"是不是新的一条"，避免重复注入上下文）。 */
  seq: number;
  at: number;
}

const EMPTY_TAB: SidebarTabView = { kind: "none", url: "", title: "" };

let snapshot: SidebarSnapshot = { tab: EMPTY_TAB, search: null, seq: 0, at: 0 };
const listeners = new Set<(s: SidebarSnapshot) => void>();

/** 取当前快照（晚订阅者的补课入口）。 */
export function getSidebarSnapshot(): SidebarSnapshot {
  return snapshot;
}

/** 订阅快照变化；返回取消函数（组件卸载必须调，否则监听器会攒起来）。 */
export function subscribeSidebarSnapshot(cb: (s: SidebarSnapshot) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function emit(next: Omit<SidebarSnapshot, "seq" | "at">): void {
  const s: SidebarSnapshot = { ...next, seq: snapshot.seq + 1, at: Date.now() };
  snapshot = s;
  for (const cb of Array.from(listeners)) {
    try { cb(s); } catch { /* 一个订阅方抛异常不该拖垮其余订阅方 */ }
  }
}

/**
 * 右栏**自己**发布页签状态（这是渲染层的强项：它知道用户切到了哪个页签、在浏览什么）。
 *
 * @param tab         此刻激活的页签
 * @param searchUrl   搜索页地址（用于判断"此刻在不在搜索页"；空串 = 不知道 ⇒ 不认搜索页）
 *
 * ⚠️ **不在搜索页时把 `search` 清零**：否则用户关掉搜索页、打开别的站点后，
 * 状态条还在说"正在搜 xxx"——那是**把历史当成现状**的错报，比不显示更坏。
 */
export function publishSidebarTab(tab: SidebarTabView, searchUrl: string): void {
  const onSearch = tab.kind === "browser" && !!searchUrl && tab.url === searchUrl;
  emit({ tab, search: onSearch ? snapshot.search : null });
}

/** guest 上报经主进程转发过来的搜索视图。 */
export function applySearchView(v: SidebarSearchView | null): void {
  if (!v) { return; }
  emit({ tab: snapshot.tab, search: v });
}

/**
 * 启动与主进程的同步：① 先拉一份"最近视图"补课（广播是一次性的），② 再订阅后续广播。
 * 返回取消函数。**幂等**：重复调用只会多一个订阅，所以调用方要在 effect 里成对使用。
 */
export function connectSidebarSearch(): () => void {
  let off: (() => void) | null = null;
  const a = api();
  if (a) {
    off = a.onView((v) => { applySearchView(v); });
    // 补课：错过的那条广播靠这一次 pull 拿回来（没有它，状态条会一直空白）
    void a.view().then((v) => { applySearchView(v); }).catch(() => { /* 拉不到就不显示，不编造 */ });
  }
  return () => { try { off?.(); } catch { /* 忽略 */ } };
}

/** 仅供测试复位。 */
export function __resetSidebarViewForTest(): void {
  snapshot = { tab: EMPTY_TAB, search: null, seq: 0, at: 0 };
  listeners.clear();
}

/* ══════════════ §3 文案（纯函数：状态条显示什么 + "交给 slime"注入什么） ══════════════ */

/** 右栏页签类型 → 给用户看的中文名（**唯一产地**；别在组件里再写一遍同义词表）。 */
const KIND_LABEL: Record<SidebarTabView["kind"], string> = {
  browser: "浏览器",
  file: "文件",
  terminal: "终端",
  tasks: "任务",
  git: "变更",
  none: "",
};

/** 状态条要显示的两段文案。 */
export interface SidebarStatusText {
  /** 状态条上的**一行**简述（左半段，会做省略号截断）。 */
  label: string;
  /** 「交给 slime」注入到输入框的**完整一段**（含足够上下文，让 Agent 不必反问"哪一页"）。 */
  inject: string;
}

/**
 * A-1144：**只有"用户在看的内容"才值得挂载**（白名单）。
 *
 * 右栏同时是**工具面板**：任务 / Git 是内部面板，不是"用户打开来看的东西"。
 * 上一版对所有页签都播报，用户实测吐槽：「怎么待办任务列表都会出现这个？」
 * ⇒ 只留「浏览器 / 文件 / 终端」这三类"打开了一个东西在看"的页签。
 */
const MOUNTABLE_KINDS: ReadonlySet<SidebarTabView["kind"]> = new Set(["browser", "file", "terminal"]);

/**
 * 把快照翻译成文案。**纯函数**（可被守卫直接断言，不必驱动整个组件）。
 *
 * @returns `null` = 此刻**没有值得显示的东西**（右栏空着，或只是一个内部面板）⇒ 调用方不要渲染状态条
 *          （渲染一个写着"右栏没开东西"的条子只是噪音）。
 */
export function describeSidebarSnapshot(s: SidebarSnapshot | null | undefined): SidebarStatusText | null {
  if (!s || !MOUNTABLE_KINDS.has(s.tab.kind)) { return null; }
  const kindLabel = KIND_LABEL[s.tab.kind] || s.tab.kind;
  const loc = (s.tab.title || s.tab.url || "").trim();

  /* 搜索页：把"在搜什么 / 几条 / 打开了什么"说清楚 —— 这是用户那句"实时监测到右栏打开的内容"的正题。 */
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
    /* 注入的那一段多给一点真实材料（结果标题），否则 Agent 只能反问"你搜到什么了"。 */
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

  /* 其余页签：位置 + 标题/地址。够 Agent 定位"用户在看什么"。 */
  return {
    label: `${kindLabel}${loc ? " · " + loc : ""}`,
    inject: `【右栏 · ${kindLabel}】${loc || "（未命名）"}` + (s.tab.url && s.tab.url !== loc ? `\n地址：${s.tab.url}` : ""),
  };
}
