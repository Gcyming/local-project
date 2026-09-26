/**
 * tests/gui/a1120-web-preview.spec.ts — ①「产物按类型分流」的守卫（A-1120）。
 *
 * 这一条要防的是**一整族"看起来做了、其实没做"**：
 *   ① 判据漏一半：只看 `rel` 或只看 `name` 的扩展名 —— 产物卡两种形态都会出现，
 *      漏掉的那一半正好表现为"点了没渲染"，而用户分不清是谁漏的；
 *   ② 路径拼错：整串 `encodeURIComponent` 把 `/` 也编码掉 ⇒ 多文件产物**必然 404**；
 *   ③ 起服务失败后**静默退回源码页** ⇒ 用户以为功能没做（所以要 `fileNotice` 说出原因）；
 *   ④ 基址取错：`0.0.0.0` 模式下 `urls` 里混着网卡 IP，取第一个可能拿到 172.x 虚拟网卡；
 *   ⑤ 复用判据长出第二份：链接那一支与产物那一支各写一套"同址 > 空白 > 新建"；
 *   ⑥ 承载类型与静态服务的 MIME 表**分家**：我们把 `.xhtml` 判成网页，而服务端没这个 MIME。
 *
 * 纯函数全部直接调用真身（`gui/src/renderer/pages/webPreview.ts`）；接线部分断言源码形状。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  cleanTargetPath, baseNameOf, splitPath, extOf, isWebPreviewPath, shouldRenderAsWeb,
  pickServeBase, encodeUrlPath, buildPreviewUrl, WEB_PREVIEW_EXTS,
} from "../../gui/src/renderer/pages/webPreview.js";

/** 去掉注释行后的可执行源码（说明文本里会引用旧写法做对照，不剥会被自己的注释骗过） */
function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}
const SIDEBAR = codeOf("gui/src/renderer/pages/RightSidebar.tsx");
const MARKDOWN = codeOf("gui/src/renderer/pages/Markdown.tsx");
const HTTP_SERVER = codeOf("gui/src/main/httpServer.ts");

/**
 * 取函数体：必须先把窗口收窄到函数内，否则裸正则会漂到下一个函数才命中
 * （「窗口失效」是本仓 A-1115 那轮踩过的：正则漂出函数 → 断言恒真/恒假）。
 * `endMarker` 必须按该函数**真实收尾缩进**给：`onOpen` 是嵌套在 effect 里的箭头函数（4 空格 `};`），
 * 组件级方法才是 2 空格 —— 给错就会一直漂到下一个 `};`，把整个组件吞进"函数体"。
 */
function fnBody(src: string, header: string, endMarker = "\n  };"): string {
  const i = src.indexOf(header);
  expect(i, `源码里找不到：${header}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(i + header.length);
  const end = rest.indexOf(endMarker);
  expect(end, `函数没有正常收尾（取不到函数体）：${header}`).toBeGreaterThan(0);
  const body = rest.slice(0, end);
  expect(body.length, `取到的「函数体」长过头 = 正则漂出了函数：${header}`).toBeLessThan(2600);
  return body;
}
const ON_OPEN = (): string => fnBody(SIDEBAR, "const onOpen = (e: Event): void => {", "\n    };");

describe("A-1120 ① 判据：哪些产物该交给浏览器跑", () => {
  it.each([".html", ".htm"])("网页扩展名 %s → 走浏览器", (ext) => {
    expect(isWebPreviewPath(`apps/demo${ext}`)).toBe(true);
  });

  it.each([".md", ".tsx", ".ts", ".svg", ".json", ".css", ".txt", ".xhtml"])("非网页扩展名 %s → 仍走文件页", (ext) => {
    expect(isWebPreviewPath(`apps/demo${ext}`)).toBe(false);
  });

  it(".xhtml 刻意不收：静态服务的 MIME 表里没有它，收了就是「弹下载框」而不是渲染", () => {
    expect(WEB_PREVIEW_EXTS).not.toContain(".xhtml");
    expect(HTTP_SERVER).not.toContain('".xhtml"');
  });

  it("大小写不敏感（用户在 Windows 上写的 .HTML 也要渲染）", () => {
    expect(isWebPreviewPath("apps/demo.HTML")).toBe(true);
    expect(extOf("apps/demo.HtM")).toBe(".htm");
  });

  it("**只看一个字段就会漏**：rel 与 name 谁带扩展名都算（两条都要看）", () => {
    // 工具回传的路径没带扩展名，但显示名带
    expect(shouldRenderAsWeb("apps/demo", "demo.html")).toBe(true);
    // 显示名被缩短过，但路径带
    expect(shouldRenderAsWeb("apps/demo.html", "demo")).toBe(true);
    // 两边都不是网页 → 不能误判（否则 .md 会被塞进浏览器变成下载）
    expect(shouldRenderAsWeb("docs/note.md", "note")).toBe(false);
  });

  it("无扩展名 / 隐藏文件名都不算网页", () => {
    expect(isWebPreviewPath("apps/demo")).toBe(false);
    expect(isWebPreviewPath("apps/.gitignore")).toBe(false);
    expect(extOf("apps/.gitignore")).toBe("");
  });
});

describe("A-1120 路径处理：渲染层没有 node:path，自己拆必须拆对", () => {
  it("Win / POSIX 分隔符都能拆", () => {
    expect(splitPath("D:\\pilot project\\apps\\demo.html")).toEqual({ dir: "D:\\pilot project\\apps", base: "demo.html" });
    expect(splitPath("/home/u/apps/demo.html")).toEqual({ dir: "/home/u/apps", base: "demo.html" });
  });

  it("根形态必须保住分隔符：`/a.html` → dir `/`、`C:\\a.html` → dir `C:\\`", () => {
    // 根被吃掉（空串 / `C:`）会让 serve 静默服务到**别的目录**（`C:` 在 resolve 下 = 当前盘工作目录）
    expect(splitPath("/a.html")).toEqual({ dir: "/", base: "a.html" });
    expect(splitPath("C:\\a.html")).toEqual({ dir: "C:\\", base: "a.html" });
    expect(splitPath("a.html")).toEqual({ dir: "", base: "a.html" });
  });

  it("baseNameOf 与 splitPath 同源（不是第二套实现）", () => {
    expect(baseNameOf("D:\\x\\y\\z.html")).toBe("z.html");
    expect(baseNameOf("D:\\x\\y\\z.html")).toBe(splitPath("D:\\x\\y\\z.html").base);
  });

  it("cleanTargetPath 剥引号与「:行:列」定位后缀", () => {
    expect(cleanTargetPath('"apps/demo.html"')).toBe("apps/demo.html");
    expect(cleanTargetPath("apps/demo.html:12:3")).toBe("apps/demo.html");
    expect(cleanTargetPath("apps/demo.html:12")).toBe("apps/demo.html");
    expect(cleanTargetPath("  apps/demo.html  ")).toBe("apps/demo.html");
  });

  it("**盘符不能被当成定位后缀剥掉**（`C:\\a\\b.html` 的 `C:` 必须留着）", () => {
    expect(cleanTargetPath("C:\\a\\b.html")).toBe("C:\\a\\b.html");
    expect(splitPath("C:\\a\\b.html").dir).toBe("C:\\a");
  });

  it("URL 路径逐段编码：`/` 不编码、特殊字符要编码、反斜杠归一为 `/`", () => {
    expect(encodeUrlPath("apps/demo.html")).toBe("apps/demo.html");
    expect(encodeUrlPath("apps\\demo.html")).toBe("apps/demo.html");
    const enc = encodeUrlPath("我的 应用/a#b?c.html");
    expect(enc.endsWith(".html")).toBe(true);
    expect(enc).not.toContain("#");
    expect(enc).not.toContain("?");
    expect(enc).not.toContain(" ");          // 空格必须编码，否则地址栏/服务端解析歧义
    expect(enc.split("/").length).toBe(2);   // **`/` 必须是真分隔符**（整串编码会变成一个段 ⇒ 404）
  });
});

describe("A-1120 基址与地址拼装", () => {
  it("优先回环地址（0.0.0.0 模式下的 urls 里混着网卡 IP）", () => {
    expect(pickServeBase(["http://172.20.5.31:8080", "http://127.0.0.1:8080"])).toBe("http://127.0.0.1:8080");
    expect(pickServeBase(["http://192.168.1.7:8080", "http://localhost:8080"])).toBe("http://localhost:8080");
  });

  it("没有回环就退回第一个可用项；全空 → 空串（调用方据此降级，不猜）", () => {
    expect(pickServeBase(["http://10.0.0.2:9000"])).toBe("http://10.0.0.2:9000");
    expect(pickServeBase([])).toBe("");
    expect(pickServeBase(undefined)).toBe("");
    expect(pickServeBase(["", "   "])).toBe("");
  });

  it("末尾斜杠不重复（`http://x:1/` + `/a.html` 不能拼成 `//a.html`）", () => {
    expect(buildPreviewUrl(["http://127.0.0.1:8080/"], "index.html")).toBe("http://127.0.0.1:8080/index.html");
  });

  it("拼装：基址 + 编码后的相对路径；任一块缺失返回空串", () => {
    expect(buildPreviewUrl(["http://127.0.0.1:8080"], "apps/demo.html")).toBe("http://127.0.0.1:8080/apps/demo.html");
    expect(buildPreviewUrl([], "apps/demo.html")).toBe("");
    expect(buildPreviewUrl(["http://127.0.0.1:8080"], "")).toBe("");
  });

  it("承载判据与静态服务的 MIME 表**不许分家**：判成网页的扩展名，服务端必须有对应 MIME", () => {
    for (const ext of WEB_PREVIEW_EXTS) {
      expect(HTTP_SERVER, `httpServer 的 MIME 表缺 ${ext} —— 我们会把它交给浏览器，服务端却发不出 text/html`)
        .toContain(`"${ext}"`);
    }
  });
});

describe("A-1120 接线：分流在右侧栏（唯一消费者），且降级必须出声", () => {
  it("文件分支必须经 `shouldRenderAsWeb` 分流，不许直接开文件页", () => {
    const onOpen = ON_OPEN();
    expect(onOpen).toContain("shouldRenderAsWeb(d.rel, d.name)");
    expect(onOpen).toContain("openWebPreview(d.rel, d.name)");
    // 反面：`else { openFileAbs(...) }` 之外不许有第二条无判据的文件分支
    expect(onOpen).toMatch(/else\s*\{\s*openFileAbs\(d\.rel, d\.name\);\s*\}/);
  });

  it("必须用**唯一权威解析器** openTarget 拿绝对路径（自己拼必然踩空）", () => {
    const body = fnBody(SIDEBAR, "const openWebPreview = (rel: string, name?: string): void => {");
    expect(body).toContain("api?.workspace?.openTarget?.(");
    expect(body).toContain("resolved.isDir");
  });

  it("必须走 `http.serve` 起服务，且**不自己维护「目录 → 服务」表**（复用由主进程保证）", () => {
    const body = fnBody(SIDEBAR, "const openWebPreview = (rel: string, name?: string): void => {");
    expect(body).toContain("api?.http?.serve?.({ dir })");
    // 反面：渲染层不该缓存服务/端口（那必然与主进程真源分家）
    expect(body).not.toMatch(/serveCache|serverRef|portRef/);
  });

  it("**每一条降级路径都要带 fileNotice**（静默退回源码页 = 用户以为功能没做）", () => {
    const body = fnBody(SIDEBAR, "const openWebPreview = (rel: string, name?: string): void => {");
    const calls = [...body.matchAll(/openFileAbs\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length, "降级路径少于 4 条？判据变了就同步本守卫").toBeGreaterThanOrEqual(4);
    for (const args of calls) {
      // 第 3 个参数必须是说明（中文），不是缺省
      expect(args.split(",").length, `这条降级没有说明原因：openFileAbs(${args})`).toBeGreaterThanOrEqual(3);
      expect(args).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it("fileNotice 必须真的被渲染出来（挂在内容上方，与错误态分开）", () => {
    expect(SIDEBAR).toContain("props.tab.fileNotice");
    expect(SIDEBAR).toMatch(/className="file-notice"/);
    /* ⚠️ **必须断言「渲染条件」本身**，不能只断言字符串出现过 ——
       实测（mut-a1120 M14）：`props.tab.fileNotice` 在渲染块里出现**两次**（外层的 `&&` 条件
       与里层的文本插值），把外层条件换成 `fileError` 之后字符串照样在 ⇒
       一条"看不出来"的缺陷：降级说明只在**错误态**才显示，而它恰恰用于"内容在、只是形态不对"。
       下面这条正则锁的正是"它由 fileNotice 自己决定显不显示"。 */
    expect(SIDEBAR).toMatch(/\{props\.tab\.fileNotice &&/);
    // 反面：不许把降级说明塞进 fileError（那会让"内容在、只是形态不对"变成"这一页没内容"）
    expect(SIDEBAR).not.toMatch(/fileError:\s*notice/);
  });

  it("「复用谁（同址 > 空白 > 新建）」只能有一份实现，两处都调它", () => {
    const defs = [...SIDEBAR.matchAll(/const openBrowserTab = /g)].length;
    expect(defs, "openBrowserTab 的定义必须唯一").toBe(1);
    // 定义 1 处 + 调用 ≥2 处（链接支 + 产物支）；调用形态是 `openBrowserTab(`（定义那边是 `openBrowserTab = (`）
    expect([...SIDEBAR.matchAll(/openBrowserTab\(/g)].length).toBeGreaterThanOrEqual(2);
    // 反面：链接支里不许再内联一份"复用谁"（`const browsers = ... / browsers.find(...)`）
    // ⚠️ 不能用 `type === "browser"` 做反面判据：弹窗风暴保护那一支**合法地**要数浏览器页个数。
    const onOpen = ON_OPEN();
    expect(onOpen).not.toContain("const browsers");
    expect(onOpen).not.toContain("browsers.find(");
  });

  it("主进程 `slime:sidebar:open` 必须**整包转发**（不许写成 url 白名单）", () => {
    // 白名单写法会让新增的 kind（terminal/files）在这一跳被静默丢掉
    expect(SIDEBAR).not.toMatch(/p\.kind === "url"\s*\)\s*&&\s*p\.url/);
    expect(SIDEBAR).toMatch(/requestSidebarOpen\(\{\s*\.\.\.p,/);
  });
});
