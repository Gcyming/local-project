/**
 * gui/src/shared/searchView.ts — 「右栏此刻在做什么」的**共用语言**（A-1137）。
 *
 * ## 为什么这个类型必须放在 `shared/`
 * 它跨**两个进程 / 两个构建目标**：主进程把页面上报的事件翻译成它（`main/searchBridge.ts`）、
 * 渲染层把它渲染成对话侧的状态条（`renderer/pages/sidebarSearch.ts` + `ChatPanel`）。
 * 类型若各写一份，`count` 改名 / `opened` 形状一变就只有一个进程跟上
 * ⇒ 「同一事实写在 N 个地方必然漂」（本仓铁律 11）。所以这里同时放**类型**与**唯一翻译函数**。
 *
 * ## 谁是权威
 * 页面发来的是**它自己的语言**（`ready` / `mode` / `results` / `open` / `page` / `index` / `error`），
 * 对话侧要的是**一种视图**（在搜什么、哪个模式、几条结果、打开了什么、有没有报错）。
 * 这层翻译**只做一次**（`viewFromPageEvent`），任何消费面都不许再解释一遍页面的私有枚举。
 *
 * ⚠️ **纯函数、显式入参**：`viewFromPageEvent(evt, seq, prev)` —— 序号由调用方（主进程）持有。
 *    写成模块级可变计数器的话，这个文件被两个进程各加载一次就会得到两条互不相干的序号，
 *    而且单测之间会互相污染。
 * ⚠️ **未知类型返回 `null`，不伪造状态**：宁可对话侧不更新，也不要显示一个"右栏并没有的状态"
 *    （铁律 27 的同宗：判据不能凭想象）。
 */

/** 页面当前的检索模式（对话侧语义：本地索引 / 联网）。 */
export type SearchPageMode = "local" | "online";

/** 页面上报事件归一化后的「搜索视图」。 */
export interface SidebarSearchView {
  /** 页面当前模式（本地索引 / 联网）。 */
  mode: SearchPageMode;
  /** 最近一次检索词。 */
  query: string;
  /** 最近一次结果条数。 */
  count: number;
  /** 结果标题（取前若干条，供对话侧状态条悬浮预览）。 */
  titles: string[];
  /** 用户最近打开的那一条（联网是 URL；本地是文档路径）。 */
  opened?: { title: string; url: string; path?: string };
  /** 页面最近一次报错（可见的失败 ⇒ 对话侧才能提示"右栏搜不动了"）。 */
  error?: string;
  /** 事件序号（单调递增；消费面据此判断"是不是新消息"，避免重复注入上下文）。 */
  seq: number;
  /** 事件时间戳（`Date.now()`）。 */
  at: number;
}

/** 事件里的字符串字段：截断 + 非字符串一律归零（页面是不可信输入）。 */
function asStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * 把页面上报的原始事件翻译成右栏视图。
 *
 * @param evt  页面经 `SlimeBrowserHost.notify()` 发来的对象（**不可信**，形状要自己防）
 * @param seq  本次事件的序号（由调用方递增，见文件头）
 * @param prev 上一份视图（只有 `page` 事件需要它保留结果条数；其余情形不读）
 * @returns    归一化后的视图；**未知事件类型返回 `null`**（不伪造状态）
 */
export function viewFromPageEvent(
  evt: unknown,
  seq: number,
  prev?: SidebarSearchView | null,
): SidebarSearchView | null {
  if (!evt || typeof evt !== "object") { return null; }
  const e = evt as Record<string, unknown>;
  const type = asStr(e.type, 40);
  /* ⚠️ 页面有**两个**「非本地」取值，都算联网（v3.2.0 实测，见 `hostNotify` 的调用点）：
       · `online` —— 走 slime 内核**实时联网**（`hostNotify('results', {mode:'online', …})`）
       · `web`    —— 「全网」模式下走**自建索引服务**（`mode:'web'`），以及切模式事件
                     `hostNotify('mode', {mode: state.mode})` —— `state.mode` 本身就是 `'web'`
     只认 `online` 会把整个「全网」模式静默显示成「本地索引」（v3.1.0→v3.2.0 的契约漂移：
     原「联网 / 全网」两模式合并成了「全网」，而它的枚举值是 `web` 不是 `online`）。 */
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
      // 翻页只是换了结果页 —— 条数沿用上一份（页面这次没带 count），别把它清成 0
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
