

























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


const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");

const SIDEBAR_TSX = read("gui/src/renderer/pages/RightSidebar.tsx");
const SIDEBAR = stripComments(SIDEBAR_TSX);
const OPEN_TS = stripComments(read("core-ts/src/sidebarOpen.ts"));
const BUILTIN = stripComments(read("core-ts/src/tools/builtin.ts"));



describe("A-1142 ① `sidebarOpenMatchesSession`：右栏请求的归属判据", () => {
  it("**核心场景**：A 会话的 Agent 送来的请求，当前显示的是 B ⇒ 不归当前会话", () => {
    expect(sidebarOpenMatchesSession("sess-A", "sess-B")).toBe(false);
    expect(sidebarOpenMatchesSession("sess-B", "sess-A")).toBe(false);
    
    expect(sidebarOpenMatchesSession("sess-A", "sess-A")).toBe(true);
  });

  it("请求**没带**会话号 ⇒ `true`（无法归属，保持旧行为：站点弹窗 / 旧调用点照旧落地）", () => {
    expect(sidebarOpenMatchesSession(undefined, "sess-B")).toBe(true);
    expect(sidebarOpenMatchesSession("", "sess-B")).toBe(true);
    expect(sidebarOpenMatchesSession("   ", "sess-B")).toBe(true);
  });

  it("⚠️ 当前**没有**会话号而请求带了 ⇒ `false`（不许无归属地串进任何界面）", () => {
    

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



describe("A-1142 ② `sessionIdFromArgs`：与 `todo_write` 同口径", () => {
  it("取得到就原样返回（trim 过）", () => {
    expect(sessionIdFromArgs({ sessionId: "  sess-A  " })).toBe("sess-A");
  });

  it("缺失 / 空串 / 非字符串 ⇒ `undefined`（**绝不许**编一个会话号）", () => {
    expect(sessionIdFromArgs({})).toBeUndefined();
    expect(sessionIdFromArgs({ sessionId: "" })).toBeUndefined();
    expect(sessionIdFromArgs({ sessionId: "   " })).toBeUndefined();
    expect(sessionIdFromArgs({ sessionId: undefined })).toBeUndefined();
    expect(sessionIdFromArgs({ sessionId: 42 })).toBe("42"); 
  });
});



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
    

    expect(BUILTIN).toContain("sessionIdFromArgs(args)");
    expect(inline.length, "工具层自己又拼了一份会话号 ⇒ 两个产地迟早漂").toBeLessThanOrEqual(1);
  });
});



describe("A-1142 ⑤ 渲染层：不归当前会话的请求**不许就地打开**", () => {
  it("主进程订阅里有归属校验，判据**调的是唯一产地**那个纯函数", () => {
    expect(SIDEBAR).toContain("sidebarOpenMatchesSession(owner, sessionIdRef.current)");
    expect(SIDEBAR, "归属必须从**请求**上取（写死成空 ⇒ 判据恒真，等于没有隔离）")
      .toContain('const owner = p.sessionId ?? "";');
    expect(SIDEBAR_TSX).toContain('import { sidebarOpenMatchesSession } from "../../../../core-ts/src/sidebarOpen.js"');
  });

  it("⚠️ 读的是 **ref**，不是闭包里的 `props.sessionId`", () => {
    

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
    

    expect(SIDEBAR, "补投写成了同步 ⇒ 页会开到上一个会话的页签上")
      .toMatch(/const pend = pendingOpenRef\.current\[sid\] \?\? \[\][\s\S]{0,320}?setTimeout\(\(\) => \{/);
    expect(SIDEBAR).toMatch(/pendingOpenRef\.current\[sid\] = \[\];/);
  });

  it("⚠️ 渲染层不许自己再写一个「要不要收」的判断（判据只有一处）", () => {
    expect(SIDEBAR, "内联了一份 sessionId 比较 ⇒ 两处判据迟早漂")
      .not.toMatch(/p\.sessionId\s*[!=]==?\s*props\.sessionId/);
  });
});



describe("A-1142 ⑥ 契约里真的有 `sessionId`（不是只有工具层在用）", () => {
  it("`SidebarOpenRequest` 有这个字段；渲染层 payload 取的就是这份类型", () => {
    expect(OPEN_TS).toMatch(/sessionId\?: string;/);
    

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
