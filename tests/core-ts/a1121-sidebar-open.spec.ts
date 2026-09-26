/**
 * tests/core-ts/a1121-sidebar-open.spec.ts — ②「右栏 = Agent 的工具栏」的守卫（A-1121）。
 *
 * 这一条的**根因**是：opener 原先只认"一个 url 字符串"，链路三步（工具 → 主进程 → 渲染层）
 * 每一步都各自把"不是 url 的东西"丢掉 —— 而丢掉的方式全是**静默**的：
 *   · `setSidebarOpener((url, name) => send({kind:"url", url, name}))` —— 非 url 请求字段全丢；
 *   · 渲染层 `if (p.kind === "url" && p.url)` —— 白名单之外的 kind 连日志都没有；
 *   · 工具回执硬写"已在右侧栏浏览器自动打开" —— 没装配界面时这是**假陈述**。
 * ⇒ 所以本守卫的重点不是"功能能跑"，而是**每一种失败都要能说出来**：
 *   归一失败返回 `null`、`fireSidebarOpen` 返回 `false`、工具回执出现「未就绪」。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  normalizeSidebarOpenRequest, setSidebarOpener, hasSidebarOpener, fireSidebarOpen,
  type SidebarOpenRequest,
} from "../../core-ts/src/sidebarOpen.js";
import { registerBuiltinTools, setHttpServer } from "../../core-ts/src/tools/builtin.js";
import { getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";

function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}
const BUILTIN = codeOf("core-ts/src/tools/builtin.ts");
const MAIN = codeOf("gui/src/main/index.ts");
const PRELOAD = codeOf("gui/src/preload/index.ts");
const SIDEBAR = codeOf("gui/src/renderer/pages/RightSidebar.tsx");

describe("A-1121 归一：唯一的请求判据", () => {
  it("**字符串入参仍然可用**（旧调用点不失效）= 按 url 处理", () => {
    expect(normalizeSidebarOpenRequest("http://127.0.0.1:8080", "标题"))
      .toEqual({ kind: "url", url: "http://127.0.0.1:8080", name: "标题" });
  });

  it("url 为空 / 只有空白 → `null`（请求不成立，调用方必须出声）", () => {
    // 若在这里返回一个空 url 的请求，渲染层会静默忽略 —— 那正是"点了没反应"
    expect(normalizeSidebarOpenRequest("")).toBeNull();
    expect(normalizeSidebarOpenRequest("   ")).toBeNull();
    expect(normalizeSidebarOpenRequest({ kind: "url" })).toBeNull();
    expect(normalizeSidebarOpenRequest({ kind: "url", url: "  " })).toBeNull();
  });

  it("terminal：`cmd` 去空白；**不带 cmd 也成立**（打开终端页本身有意义）", () => {
    expect(normalizeSidebarOpenRequest({ kind: "terminal", cmd: "  npm run dev  " }))
      .toMatchObject({ kind: "terminal", cmd: "npm run dev" });
    expect(normalizeSidebarOpenRequest({ kind: "terminal" })).toEqual({ kind: "terminal", cmd: undefined, name: undefined });
    // 空白 cmd 归一成 undefined，不许留一个 " " 让渲染层预填一个空格
    expect(normalizeSidebarOpenRequest({ kind: "terminal", cmd: "   " })?.cmd).toBeUndefined();
  });

  it("files：`root` / `rel` 透传；不带 root 也成立（= 用会话工作目录）", () => {
    expect(normalizeSidebarOpenRequest({ kind: "files", root: " D:\\pilot project\\apps ", rel: " a/b " }))
      .toMatchObject({ kind: "files", root: "D:\\pilot project\\apps", rel: "a/b" });
    expect(normalizeSidebarOpenRequest({ kind: "files" })).toEqual({ kind: "files", root: undefined, rel: undefined, name: undefined });
  });

  it("`req.name` 优先于函数第二参（调用方显式给的更具体）", () => {
    expect(normalizeSidebarOpenRequest({ kind: "terminal", name: "构建" }, "兜底")?.name).toBe("构建");
    expect(normalizeSidebarOpenRequest({ kind: "terminal" }, "兜底")?.name).toBe("兜底");
  });

  it("未知 kind 一律按 url 处理（不静默变成别的承载）", () => {
    const weird = { kind: "nope", url: "http://x" } as unknown as SidebarOpenRequest;
    expect(normalizeSidebarOpenRequest(weird)).toMatchObject({ kind: "url", url: "http://x" });
  });

  it("来源 `from` 只在 url 类保留（站点弹窗限流只对链接有意义）", () => {
    expect(normalizeSidebarOpenRequest({ kind: "url", url: "http://x", from: "site" })?.from).toBe("site");
    expect(normalizeSidebarOpenRequest({ kind: "terminal", from: "site" } as unknown as SidebarOpenRequest)?.from).toBeUndefined();
  });
});

describe("A-1121 fireSidebarOpen：未装配 / 异常都必须返回 false", () => {
  beforeEach(() => { setSidebarOpener(null); });

  it("未装配界面 → false + hasSidebarOpener() 为 false（工具据此说「界面未就绪」）", () => {
    expect(hasSidebarOpener()).toBe(false);
    expect(fireSidebarOpen({ kind: "terminal" })).toBe(false);
  });

  it("装配后收到的是**归一后的**载荷（不是原始入参）", () => {
    const seen: Array<string | SidebarOpenRequest> = [];
    setSidebarOpener((req) => { seen.push(req); });
    expect(hasSidebarOpener()).toBe(true);
    expect(fireSidebarOpen("  http://127.0.0.1:9/ ", "x")).toBe(true);
    expect(seen[0]).toEqual({ kind: "url", url: "http://127.0.0.1:9/", name: "x" });
  });

  it("opener 自己抛异常 → false（不把异常当成功往前传）", () => {
    setSidebarOpener(() => { throw new Error("boom"); });
    expect(fireSidebarOpen({ kind: "terminal" })).toBe(false);
  });

  it("请求不成立时**不调用** opener（避免它收到空载荷）", () => {
    let called = 0;
    setSidebarOpener(() => { called += 1; });
    expect(fireSidebarOpen({ kind: "url", url: "" })).toBe(false);
    expect(called).toBe(0);
  });
});

describe("A-1121 工具面：两个新工具的参数与权限口径", () => {
  beforeEach(() => {
    resetRegistry();
    setSidebarOpener(null);
    setHttpServer(null);
    registerBuiltinTools();
  });

  it("两个工具都注册了", () => {
    const names = getRegistry().listToolNames();
    expect(names).toContain("sidebar_open_terminal");
    expect(names).toContain("sidebar_open_files");
  });

  it("都声明 `read` + autoApprovable（打开面板不该逐次弹审批）", () => {
    for (const n of ["sidebar_open_terminal", "sidebar_open_files"]) {
      const t = getRegistry().get(n)!;
      expect(t.permissions, n).toEqual(["read"]);
      expect(t.effectiveRiskKind(), n).toBe("read");
      expect(t.autoApprovable, n).toBe(true);
    }
  });

  it("⚠️ 终端工具的预填参数**不许**叫 `cmd` / `command`（那是 targetFromArgs 的终端命令字段）", () => {
    // 撞名的后果：同一份字符串会以"终端命令"的身份进硬规则/分类器 → 难以解释的误拦
    const t = getRegistry().get("sidebar_open_terminal")!;
    const props = (t.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toContain("prefill");
    expect(Object.keys(props)).not.toContain("cmd");
    expect(Object.keys(props)).not.toContain("command");
    expect(t.description).toContain("不会自动执行");
  });

  it("文件工具的参数是 `root` / `rel`（同样避开终端命令字段）", () => {
    const t = getRegistry().get("sidebar_open_files")!;
    const props = (t.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["rel", "root"]);
  });

  it("未装配界面时回执**如实报错**，不许假装已打开", async () => {
    const term = await getRegistry().get("sidebar_open_terminal")!.executeFn({ prefill: "npm run dev" });
    expect(term).toContain("[错误]");
    expect(term).toContain("未就绪");
    expect(term).not.toContain("[已打开]");
    const files = await getRegistry().get("sidebar_open_files")!.executeFn({});
    expect(files).toContain("[错误]");
    expect(files).not.toContain("[已打开]");
  });

  it("装配后：终端页回执明确「预填、未执行」，文件页回执照实报浏览根", async () => {
    const seen: SidebarOpenRequest[] = [];
    setSidebarOpener((req) => { if (typeof req !== "string") { seen.push(req); } });
    const dir = await mkdtemp(join(tmpdir(), "slime-a1121-"));
    const term = await getRegistry().get("sidebar_open_terminal")!.executeFn({ prefill: " npm run dev " });
    expect(term).toContain("[已打开]");
    expect(term).toContain("npm run dev");
    expect(term).toContain("未执行");
    const files = await getRegistry().get("sidebar_open_files")!.executeFn({ root: dir, rel: "apps" });
    expect(files).toContain("[已打开]");
    expect(files).toContain(dir);
    expect(seen.map((s) => s.kind)).toEqual(["terminal", "files"]);
    expect(seen[0].cmd).toBe("npm run dev");
    expect(seen[1].root).toBe(dir);
    expect(seen[1].rel).toBe("apps");
  });

  it("目录不存在 → 当场报错（**不许**开出一个空树让用户以为这里没文件）", async () => {
    setSidebarOpener(() => { /* 已装配 */ });
    const missing = join(tmpdir(), "slime-a1121-not-exist-9527");
    const r = await getRegistry().get("sidebar_open_files")!.executeFn({ root: missing });
    expect(r).toContain("[错误]");
    expect(r).toContain("目录不存在");
  });

  it("给了 rel 但没给 root → 如实说明「未能定位」", async () => {
    setSidebarOpener(() => { /* 已装配 */ });
    const r = await getRegistry().get("sidebar_open_files")!.executeFn({ rel: "apps" });
    expect(r).toContain("[已打开]");
    expect(r).toContain("未能定位");
  });
});

describe("A-1121 接线：三步链路都必须整包透传（不许任何一步写白名单）", () => {
  it("core-ts 侧不再自己持有 opener（定义已搬到 sidebarOpen.js，唯一出处）", () => {
    expect(BUILTIN).not.toMatch(/let sidebarOpenerRef/);
    expect(BUILTIN).toContain('from "../sidebarOpen.js"');
  });

  it("主进程装配点用**纯函数归一**后再发事件（判据只有一份）", () => {
    expect(MAIN).toContain("normalizeSidebarOpenRequest(req, name)");
    expect(MAIN).toMatch(/setSidebarOpener\(\(req, name\)/);
  });

  it("preload 的载荷类型取唯一出处（不是手抄一份形状）", () => {
    expect(PRELOAD).toContain("SidebarOpenRequest");
    // 反面：手抄形状的下场是"主进程多发一个字段、渲染层不知道"
    expect(PRELOAD).not.toMatch(/onSidebarOpen[\s\S]{0,80}kind: "url"; url: string/);
  });

  it("渲染层按 kind 建页：terminal / files 两类分支持有", () => {
    expect(SIDEBAR).toContain('d.kind === "terminal"');
    expect(SIDEBAR).toContain('d.kind === "files"');
    expect(SIDEBAR).toContain("openTerminalTab(d.cmd, d.name)");
    expect(SIDEBAR).toContain("openFilesTab(d.root, d.rel, d.name)");
  });

  it("⚠️ 终端预填**绝不自动执行**（`prefill` 只能进 setInput，不许出现 run(...)）", () => {
    const i = SIDEBAR.indexOf("const lastNonceRef = React.useRef");
    expect(i).toBeGreaterThan(0);
    const body = SIDEBAR.slice(i, i + 900);
    expect(body).toContain("setInput(cmd)");
    expect(body).not.toMatch(/\brun\(/);
    expect(body).not.toContain("void run");
  });

  it("预填按 **nonce** 触发（同一条命令连开两次也要能重新填回）", () => {
    expect(SIDEBAR).toContain("termNonce");
    expect(SIDEBAR).toContain("termOpenSeq");
    expect(SIDEBAR).toMatch(/termNonce:\s*\(termOpenSeq \+= 1\)/);
  });

  it("文件树的定位是一步到位（`browseRel` 带 dirStack 一起设，不许先列根再跳）", () => {
    const i = SIDEBAR.indexOf("const want = (props.tab.browseRel");
    expect(i).toBeGreaterThan(0);
    const body = SIDEBAR.slice(i, i + 500);
    expect(body).toContain("setDirStack(");
    expect(body).toContain("void listDir(browseRoot, want)");
    expect(body).toContain("return");
  });

  it("http_create_app 的回执**按真实结果**写（未装配界面时不得声称已自动打开）", () => {
    expect(BUILTIN).toContain("fireSidebarOpen({ kind: \"url\", url: localUrl, name: title })");
    expect(BUILTIN).toContain("界面未就绪，未自动打开");
  });
});
