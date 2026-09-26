/**
 * webPreview.ts — A-1120（① 产物按类型分流）：**「这个产物该用什么承载」的唯一判据出处**。
 *
 * 为什么单独一个纯模块（而不是写在 `RightSidebar.tsx` 里）：
 *   ① 判据要能被守卫**直接断言**，不必去驱动整个 4000 行的组件；
 *   ② 扩展名表 / 路径拆解 / URL 拼装都只有一份，不会长出第二个产地。
 *
 * ⚠️ 与 `gui/src/main/httpServer.ts` 里的 MIME 表**不是一回事**，不要合并：
 *   那边回答「这个字节流怎么发」（Content-Type），这边回答「该不该交给浏览器跑」。
 *   合并会让"新增一种可预览类型"必须顺带改静态服务，反之亦然。
 *   ——但两者之间**有一条必须守住的关系**：判成网页的扩展名，服务端必须有对应 MIME（见下 `WEB_PREVIEW_EXTS`）。
 */

/** 去掉聊天里常见的包裹与定位后缀：`"app/index.html"`、`app/index.html:12:3`、`'./a.html'` */
export function cleanTargetPath(raw: string): string {
  const s = (raw ?? "").trim().replace(/^["']+|["']+$/g, "");
  // 只剥**行/列定位**后缀（`:12` / `:12:3`），不碰盘符 `C:` 与 URL 的 `:port`
  return s.replace(/:\d+(?::\d+)?$/, "");
}

/** 末段文件名（渲染层没有 node:path） */
export function baseNameOf(raw: string): string {
  return splitPath(raw).base;
}

/**
 * 拆出目录与文件名。Windows 分隔符与 POSIX 分隔符都要支持（会话里两种都可能出现）。
 * 根形态要保住分隔符本身：`/a.html` → dir `/`；`C:\a.html` → dir `C:\`；
 * 否则 `serve({dir})` 会拿到空串或 `C:`（后者在 `path.resolve` 下会变成"当前盘的工作目录"，静默服务错目录）。
 */
export function splitPath(raw: string): { dir: string; base: string } {
  const s = cleanTargetPath(raw);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i < 0) { return { dir: "", base: s }; }
  const upto = s.slice(0, i + 1);
  // `C:\` / `/` 这种"根"直接保留；否则去掉末尾分隔符
  const dir = /^[a-zA-Z]:[\\/]$/.test(upto) || upto === "/" || upto === "\\" ? upto : upto.slice(0, -1);
  return { dir, base: s.slice(i + 1) };
}

/** 小写扩展名（含点）；无扩展名/隐藏文件（`.gitignore`）返回空串 */
export function extOf(raw: string): string {
  const name = baseNameOf(raw);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

/**
 * 可被浏览器**运行**的网页扩展名（小写，含点）。
 *
 * ⚠️ 这里的每一项都必须在 `gui/src/main/httpServer.ts` 的 MIME 表里有对应条目 ——
 * 否则我们会把它交给浏览器，而静态服务发的是兜底 MIME（`application/octet-stream`）
 * ⇒ 浏览器**下载**而不是渲染，症状是"点了产物弹了个下载框"。
 * 这条跨文件不变量由 `tests/gui/a1120-web-preview.spec.ts` 强制。
 * （`.xhtml` 就是因此**没有**收进来：静态服务没有它的 MIME，收了就等于制造这个故障。）
 */
export const WEB_PREVIEW_EXTS: readonly string[] = [".html", ".htm"];

/** 单看一个路径名：是不是「可运行的网页」 */
export function isWebPreviewPath(raw: string): boolean {
  return WEB_PREVIEW_EXTS.includes(extOf(raw));
}

/**
 * 产物/链接是否**应当**走浏览器渲染。
 *
 * 两条都要看：产物卡的 `rel` 与 `name` 都可能是不完整形态 ——
 *   · `rel = "apps/demo"`、`name = "demo.html"`（工具回传的路径没带扩展名）；
 *   · `rel = "apps/demo.html"`、`name = "demo"`（显示名被人为缩短过）。
 * 只看其中一个都会漏掉一半，而这漏掉的正是「点了没渲染」——用户不会去区分是谁漏的。
 */
export function shouldRenderAsWeb(rel: string, name?: string): boolean {
  return isWebPreviewPath(rel) || isWebPreviewPath(name ?? "");
}

/**
 * 从静态服务返回的 `urls` 里挑一个基准地址。
 *
 * 优先 **回环地址**：本地自预览没有任何理由走局域网 IP（`urls` 在 `0.0.0.0` 模式下会附上
 * 全部网卡 IP，取第一个可能拿到 172.x 的虚拟网卡 → 某些网络策略下 webview 加载不到）。
 * 回环都没有才退回第一个可用项，最后返回空串（调用方据此走降级）。
 */
export function pickServeBase(servedUrls: readonly string[] | undefined): string {
  const list = (servedUrls ?? []).map((u) => (u ?? "").trim()).filter((u) => u.length > 0);
  const loopback = list.find((u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i.test(u));
  const base = loopback ?? list[0] ?? "";
  return base.replace(/\/+$/, "");
}

/**
 * 路径 → URL 路径段。**逐段编码**，不能整串 `encodeURIComponent`（那会把 `/` 也编码掉，
 * 目录型产物直接 404）。中文名 / 带空格 / 带 `#` `?` 的文件名都在这里被救回来。
 */
export function encodeUrlPath(raw: string): string {
  return (raw ?? "")
    .split(/[\\/]+/)
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/** 服务基址 + 相对文件名 → 可访问地址；任一块缺失返回空串（调用方据此降级，不猜） */
export function buildPreviewUrl(servedUrls: readonly string[] | undefined, relPath: string): string {
  const base = pickServeBase(servedUrls);
  const path = encodeUrlPath(relPath);
  if (!base || !path) { return ""; }
  return `${base}/${path}`;
}
