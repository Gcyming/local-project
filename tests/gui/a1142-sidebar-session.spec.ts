/**
 * tests/gui/a1142-sidebar-session.spec.ts — 「**右栏视图的会话隔离**」的守卫（A-1142）。
 *
 * ## 用户实测到的缺陷
 * 「在另一个会话的 Agent 那派发了任务，后来换了个会话页，结果上一个 Agent 创建的右侧边栏
 *  直接创建在我这个会话的右侧边栏了。」
 *
 * ## 根因（不是"某处少了一个 if"，而是**整条链路没有会话这个维度**）
 * 右栏视图是**全局单例**（一个 `RightSidebar`、一份 `tabs`），而 Agent 是**异步**的：
 *   ① 用户在会话 A 派任务；② 切到 B ⇒ 快照 effect 存 A 的 tabs、还原 B 的 tabs；
 *   ③ 此刻 A 的 Agent 才跑完工具 ⇒ `slime:sidebar:open` 到达 ⇒ 渲染层**不校验归属**就地打开
 *      ⇒ 新页签落在 B 的界面上；④ 切回 A ⇒ B 的 tabs（含入侵者）存进 B 的槽，A 还原的快照里
 *      没有那个页。⇒「A 看不到自己 Agent 开的页，B 白捡一个页」。
 *
 * ## 修法与判据
 *   ① 请求**自带归属**：`SidebarOpenRequest.sessionId`（工具循环注入，取法唯一产地
 *      `sessionIdFromArgs`）；
 *   ② 判据只有一处：`sidebarOpenMatchesSession`（纯函数，本 spec 逐条钉死三种情形）；
 *   ③ 渲染层不归当前会话的请求**暂存**（不是丢弃 —— 丢弃 = 工具回执说"已打开"
 *      而用户在自己会话里永远看不到），切回那个会话时补投。
 *
 * ## ⚠️ 本 spec 不渲染组件（渲染层不做判据）
 * 断言的是**纯函数行为** + **源码形状**（接线在不在、判据调没调）。组件行为不可测的部分
 * 由形状断言守住"那条线还在"，这也是本仓门禁的一贯口径。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  normalizeSidebarOpenRequest,
  sessionIdFromArgs,
  sidebarOpenMatchesSession,
  type SidebarOpenRequest,
} from "../../core-ts/src/sidebarOpen.js";

/* 铁律：形状断言**先剥注释** —— 源码注释里本来就写着那些反例字样，不剥会假绿。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");

const SIDEBAR_TSX = read("gui/src/renderer/pages/RightSidebar.tsx");
const SIDEBAR = stripComments(SIDEBAR_TSX);
const OPEN_TS = stripComments(read("core-ts/src/sidebarOpen.ts"));
const BUILTIN = stripComments(read("core-ts/src/tools/builtin.ts"));

/* ══════════════ ① 归属判据（唯一产地，逐条钉死）══════════════ */

describe("A-1142 ① `sidebarOpenMatchesSession`：右栏请求的归属判据", () => {
  it("**核心场景**：A 会话的 Agent 送来的请求，当前显示的是 B ⇒ 不归当前会话", () => {
    expect(sidebarOpenMatchesSession("sess-A", "sess-B")).toBe(false);
    expect(sidebarOpenMatchesSession("sess-B", "sess-A")).toBe(false);
    /* 反面：这条若是 true，就是用户实测到的那个 bug —— 页开到了别的会话上。 */
    expect(sidebarOpenMatchesSession("sess-A", "sess-A")).toBe(true);
  });

  it("请求**没带**会话号 ⇒ `true`（无法归属，保持旧行为：站点弹窗 / 旧调用点照旧落地）", () => {
    expect(sidebarOpenMatchesSession(undefined, "sess-B")).toBe(true);
    expect(sidebarOpenMatchesSession("", "sess-B")).toBe(true);
    expect(sidebarOpenMatchesSession("   ", "sess-B")).toBe(true);
  });

  it("⚠️ 当前**没有**会话号而请求带了 ⇒ `false`（不许无归属地串进任何界面）", () => {
    /* 反面写法 `if (reqSid && curSid && reqSid !== curSid) return false;` 在这里会放行 ——
       本仓在 `slime:tasks:todos` 上已经为这条付过一次账（A-980-R28），这里不许重演。 */
    expect(sidebarOpenMatchesSession("sess-A", "")).toBe(false);
    expect(sidebarOpenMatchesSession("sess-A", undefined)).toBe(false);
  });

  it("两边都空 ⇒ `true`（都没有归属可言，不是「串台」）", () => {
    expect(sidebarOpenMatchesSession("", "")).toBe(true);
    expect(sidebarOpenMatchesSession(undefined, undefined)).toBe(true);
  });

  it("空白按「没带」处理（trim 之后才比）", () => {
    expect(sidebarOpenMatchesSession("  sess-A  ", "sess-A")).toBe(true);
  });
});

/* ══════════════ ② 会话号的取法（唯一产地）══════════════ */

describe("A-1142 ② `sessionIdFromArgs`：与 `todo_write` 同口径", () => {
  it("取得到就原样返回（trim 过）", () => {
    expect(sessionIdFromArgs({ sessionId: "  sess-A  " })).toBe("sess-A");
  });

  it("缺失 / 空串 / 非字符串 ⇒ `undefined`（**绝不许**编一个会话号）", () => {
    expect(sessionIdFromArgs({})).toBeUndefined();
    expect(sessionIdFromArgs({ sessionId: "" })).toBeUndefined();
    expect(sessionIdFromArgs({ sessionId: "   " })).toBeUndefined();
    expect(sessionIdFromArgs({ sessionId: undefined })).toBeUndefined();
    expect(sessionIdFromArgs({ sessionId: 42 })).toBe("42"); // 与 todo_write 的 String(...) 同口径
  });
});

/* ══════════════ ③ 契约：每个 kind 都必须带上归属 ══════════════ */

describe("A-1142 ③ 归一：三类请求**都**要透传 `sessionId`", () => {
  it("url / terminal / files 三类都带（漏一个 kind = 那一类页永远无法归属）", () => {
    expect(normalizeSidebarOpenRequest({ kind: "url", url: "http://x", sessionId: "sess-A" }))
      .toMatchObject({ kind: "url", sessionId: "sess-A" });
    expect(normalizeSidebarOpenRequest({ kind: "terminal", cmd: "ls", sessionId: "sess-A" }))
      .toMatchObject({ kind: "terminal", sessionId: "sess-A" });
    expect(normalizeSidebarOpenRequest({ kind: "files", root: "D:/a", sessionId: "sess-A" }))
      .toMatchObject({ kind: "files", sessionId: "sess-A" });
  });

  it("没带 / 空白 ⇒ `undefined`（不是空串：空串会让下游「有没有归属」的判断失真）", () => {
    expect(normalizeSidebarOpenRequest({ kind: "terminal", sessionId: "   " })?.sessionId).toBeUndefined();
    expect(normalizeSidebarOpenRequest({ kind: "terminal" })?.sessionId).toBeUndefined();
  });

  it("字符串入参（旧调用点）⇒ 没有归属（旧行为不变）", () => {
    expect(normalizeSidebarOpenRequest("http://x", "n")?.sessionId).toBeUndefined();
  });

  it("⚠️ 归一**不许**因为带了会话号而改变「是否成立」的判定", () => {
    expect(normalizeSidebarOpenRequest({ kind: "url", url: "", sessionId: "sess-A" })).toBeNull();
    expect(normalizeSidebarOpenRequest({ kind: "terminal", sessionId: "sess-A" })).not.toBeNull();
  });
});

/* ══════════════ ④ 接线：工具层必须带上归属 ══════════════ */

describe("A-1142 ④ 三个会开右栏的工具都把 `sessionId` 传下去", () => {
  it("`sidebar_open_terminal` / `sidebar_open_files` / `http_create_app`", () => {
    expect(BUILTIN, "终端工具没带会话号 ⇒ 只有这一类页会串台（最难查的一种漏改）")
      .toContain('fireSidebarOpen({ kind: "terminal", cmd: prefill, name, sessionId: sessionIdFromArgs(args) })');
    expect(BUILTIN, "文件工具没带会话号")
      .toContain('fireSidebarOpen({ kind: "files", root, rel, sessionId: sessionIdFromArgs(args) })');
    expect(BUILTIN, "http_create_app 没带会话号")
      .toContain('fireSidebarOpen({ kind: "url", url: localUrl, name: title, sessionId: sessionIdFromArgs(args) })');
  });

  it("三个工具取会话号都走**同一个**函数（不许各写一份 `args.sessionId`）", () => {
    const inline = BUILTIN.match(/String\(args\.sessionId/g) ?? [];
    /* `todo_write` 那一处是它的既有产地（在它自己的作用域里），工具层这三个必须走
       `sessionIdFromArgs` ⇒ 除了 todo_write 之外不再有第二份取法。 */
    expect(BUILTIN).toContain("sessionIdFromArgs(args)");
    expect(inline.length, "工具层自己又拼了一份会话号 ⇒ 两个产地迟早漂").toBeLessThanOrEqual(1);
  });
});

/* ══════════════ ⑤ 接线：渲染层的归属校验 + 暂存补投 ══════════════ */

describe("A-1142 ⑤ 渲染层：不归当前会话的请求**不许就地打开**", () => {
  it("主进程订阅里有归属校验，判据**调的是唯一产地**那个纯函数", () => {
    expect(SIDEBAR).toContain("sidebarOpenMatchesSession(owner, sessionIdRef.current)");
    expect(SIDEBAR, "归属必须从**请求**上取（写死成空 ⇒ 判据恒真，等于没有隔离）")
      .toContain('const owner = p.sessionId ?? "";');
    expect(SIDEBAR_TSX).toContain('import { sidebarOpenMatchesSession } from "../../../../core-ts/src/sidebarOpen.js"');
  });

  it("⚠️ 读的是 **ref**，不是闭包里的 `props.sessionId`", () => {
    /* 这个 effect 的依赖是 `[]` ⇒ 闭包里的 props 永远停在首次挂载那一刻，用它判归属 = 没有隔离。
       （本仓 A-1137 的"广播是一次性的"付过同类账：闭包过期是最安静的一类失效。） */
    expect(SIDEBAR).toContain("const sessionIdRef = React.useRef<string>(props.sessionId ?? \"\")");
    expect(SIDEBAR).toContain("sessionIdRef.current = props.sessionId ?? \"\"");
    expect(SIDEBAR, "归属判断用了闭包 props")
      .not.toContain("sidebarOpenMatchesSession(owner, props.sessionId)");
  });

  it("不匹配的请求进**暂存队列**（不是丢弃：丢弃 = 工具回执说已打开、用户永远看不到）", () => {
    expect(SIDEBAR).toContain("const pendingOpenRef = React.useRef<Record<string, SidebarOpenPayload[]>>({})");
    expect(SIDEBAR).toMatch(/if \(!sidebarOpenMatchesSession\(owner, sessionIdRef\.current\)\) \{[\s\S]{0,240}?q\.push\(p\);/);
  });

  it("切回那个会话时**补投**暂存的请求", () => {
    expect(SIDEBAR).toMatch(/const pend = pendingOpenRef\.current\[sid\] \?\? \[\];/);
    /* ⚠️ 必须异步：本 effect 里 `setTabs` 刚排完队，同步派发会被上一次渲染注册的监听器接住
       （闭包里还是上一个会话的 tabs）⇒ 复用到错的页签。 */
    expect(SIDEBAR, "补投写成了同步 ⇒ 页会开到上一个会话的页签上")
      .toMatch(/const pend = pendingOpenRef\.current\[sid\] \?\? \[\][\s\S]{0,320}?setTimeout\(\(\) => \{/);
    expect(SIDEBAR).toMatch(/pendingOpenRef\.current\[sid\] = \[\];/);
  });

  it("⚠️ 渲染层不许自己再写一个「要不要收」的判断（判据只有一处）", () => {
    expect(SIDEBAR, "内联了一份 sessionId 比较 ⇒ 两处判据迟早漂")
      .not.toMatch(/p\.sessionId\s*[!=]==?\s*props\.sessionId/);
  });
});

/* ══════════════ ⑥ 契约：字段真的加进去了 ══════════════ */

describe("A-1142 ⑥ 契约里真的有 `sessionId`（不是只有工具层在用）", () => {
  it("`SidebarOpenRequest` 有这个字段；渲染层 payload 取的就是这份类型", () => {
    expect(OPEN_TS).toMatch(/sessionId\?: string;/);
    /* 渲染层的 `SidebarOpenPayload` 是 `SidebarOpenRequest | …` ⇒ 加了字段它自动带上，
       不需要第二份声明；这里钉死"没有手抄第二份形状"。 */
    expect(stripComments(read("gui/src/renderer/pages/Markdown.tsx")))
      .toContain("import type { SidebarOpenRequest } from \"../../shared/ipc.js\"");
    expect(stripComments(read("gui/src/shared/ipc.ts")))
      .toContain("export type { SidebarOpenRequest, SidebarOpenKind }");
  });

  it("主进程转发是**整包**发送（不需要它认识 sessionId）", () => {
    expect(stripComments(read("gui/src/main/index.ts")))
      .toContain("mainWindow?.webContents.send(\"slime:sidebar:open\", payload)");
  });
});
