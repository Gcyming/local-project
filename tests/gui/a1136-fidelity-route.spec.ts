/**
 * tests/gui/a1136-fidelity-route.spec.ts — A-1136 ⑧「双通道分流」的守卫。
 *
 * ## 这条守卫在防什么（用户硬约束的落点）
 * 用户原话：「**能上就把几个 Office 工作文件全上了。同时不要漏了 Agent 对于这些文件的解析理解能力，
 *           不要到时候只能用户看，Agent 什么都做不了。**」
 * ⇒ 两件事必须**同时**成立，且**各自有唯一落点**：
 *   通道 A（人看）= `api.docs.renderPage` 保真渲染 → `http.serve` → `openBrowserTab`；
 *   通道 B（Agent 读）= `api.docs.read` 抽文本（`doc_text.ts` 唯一产地）→ 落回 `docViewToHtml`。
 *
 * ⚠️ 最危险的失败模式是**通道 B 被通道 A 挤掉**（"反正保真渲染了，读文本那条可以删了"）：
 *   那会让 Agent 完全失去这些文件 —— 正是用户点名担心的。所以本守卫**必须同时**钉住两条通道的存在。
 *
 * ## 为什么是源码断言而不是调用断言
 * `openDocPreviewPage` 是 `RightSidebar.tsx` 内部的闭包（依赖 `window.slimeAPI` 与一堆状态），
 * 单测里跑不起来。本仓对这类 UI 内联函数的既有范式 = 读源码、剥注释、断言**结构唯一标识**
 * （`a1121-sidebar-open.spec.ts` 同款）。⚠️ 锚点一律锚**函数调用/字段名**，不锚"文件里第 N 处"。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { planRender, canFaithfullyRender, needsLibreOffice } from "../../core-ts/src/office/renderPlan.js";

function codeOf(rel: string): string {
  /* ⚠️ 必须**成对剥块注释**（`/* … *\/`），不能只按"行首是不是 `*`/`//`"过滤 ——
     本仓 JSDoc 里有大量以 `⚠️`、反引号开头的续行，那些**不以 `*` 开头**，会被朴素过滤当代码留下：
     既可能让 `toContain` 在注释里命中（假绿），也会把 `slice(i, i+N)` 的窗口撑爆（假红）。
     与 `a1136-stage-c.spec.ts::codeOf` 同款。 */
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const SIDEBAR = codeOf("gui/src/renderer/pages/RightSidebar.tsx");
const MAIN = codeOf("gui/src/main/index.ts");
const PRELOAD = codeOf("gui/src/preload/index.ts");
const IPC = codeOf("gui/src/shared/ipc.ts");

/** 取 `openDocPreviewPage` 函数体（从函数名到下一个顶层 `const xxx = (`）——
 *  ⚠️ 用**函数名**定位而不是行号：行号会随无关改动漂移（铁律 3 的"锚对象错"）。 */
function openBody(): string {
  const i = SIDEBAR.indexOf("const openDocPreviewPage");
  expect(i, "RightSidebar 里找不到 openDocPreviewPage（改名了？同步本守卫）").toBeGreaterThan(-1);
  const rest = SIDEBAR.slice(i);
  const j = rest.indexOf("\n  const ", 10); // 下一个同缩进的 const
  return j > 0 ? rest.slice(0, j) : rest.slice(0, 4000);
}

describe("A-1136 ⑧ 分流：保真渲染（人看）不能挤掉抽文本（Agent 读）", () => {
  it("通道 A 在：先调 `docs.renderPage`，成功则 serve + openBrowserTab", () => {
    const b = openBody();
    expect(b).toContain("renderPage");
    expect(b).toContain("http?.serve");
    expect(b).toContain("openBrowserTab");
  });

  it("⚠️ 通道 B必须**仍在**：`docs.read` 抽文本 + `docViewToHtml` 落回（不许被通道 A 删掉）", () => {
    const b = openBody();
    expect(b).toContain("docs?.read");
    expect(b).toContain("docViewToHtml");
  });

  it("两条通道的**先后**：保真在前、落回在后（顺序反了等于永远走旧通道）", () => {
    const b = openBody();
    const iRender = b.indexOf("renderPage");
    const iRead = b.indexOf("docs?.read");
    expect(iRender).toBeGreaterThan(-1);
    expect(iRead).toBeGreaterThan(-1);
    expect(iRender).toBeLessThan(iRead);
  });

  it("每一层失败都**出声**（不许静默什么都不做）", () => {
    const b = openBody();
    // 抽文本失败 / 预览页生成失败 / 服务起不来 —— 三条都要有明确出口
    expect(b.match(/openFileAbs\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("A-1136 ⑨ 主进程 IPC：能力边界在**唯一产地**判定", () => {
  it("IPC 名在 shared/ipc 里登记（三处不许各写字符串）", () => {
    expect(IPC).toMatch(/docs_render_page/);
    expect(MAIN).toContain("slime:docs:renderPage");
    expect(PRELOAD).toContain("slime:docs:renderPage");
  });

  it("主进程调 `planRender` 判能力，而不是自己写扩展名列表", () => {
    expect(MAIN).toContain("planRender(");
    // 不许在主进程里手抄一份扩展名清单（同一事实写两处必漂，铁律 11）
    const body = MAIN.slice(MAIN.indexOf("slime:docs:renderPage"));
    const seg = body.slice(0, 1200);
    expect(seg).not.toMatch(/\.pptx["']\s*\|\|/); // 手写扩展名比较的典型形状
  });

  it("⚠️ planRender 的结论**必须真的当闸门用**（摆着不用的那种要拦下）", () => {
    /* ⚠️ 只断言 `toContain("planRender(")` 是**瞎的**：把判据表达式改成 `if (false)`
       之后那行 planRender 一字未动，照样通过（铁律 3）。
       判据 = 那些**判据表达式本身**必须在。
       ⚠️ 阶段 C（2026-09-29）把原来的一句 `if (!plan.faithful || plan.needs)` **拆成了两句**：
         ① `if (!plan.faithful)`      —— 不支持保真的类型 ⇒ degrade；
         ② `if (plan.needs === …)`    —— 老格式走 LibreOffice 转换分支。
       本断言也随之失效过（锚的还是旧形状）⇒ 现在**两句都钉**（拆开是为了让老格式能走转换，
       不是把闸门拆掉；少任何一句都会分别退化成"白屏"与"老格式永远不走转换"）。 */
    const body = MAIN.slice(MAIN.indexOf("slime:docs:renderPage"));
    const seg = body.slice(0, 2000);
    expect(seg).toMatch(/if\s*\(\s*!\s*plan\.faithful\s*\)/);
    expect(seg).toMatch(/plan\.needs\s*===\s*["']libreoffice["']/);
    /* ⚠️⚠️ 这里**曾经**还有一条 `expect(seg).not.toMatch(/if\s*\(\s*false\s*\)/)`，已删除（2026-09-30）：
       在一个 2000 字的窗口里"全局禁止 if(false)"**过宽** —— 窗口后来罩到了 handler 里**别的**判断
       （阶段 C 新增的"缓存命中就跳过转换"那句），于是对**别的**变异也会变红。
       实测后果：变异 M49（改的是缓存短路）报的红是**这一条**，而不是它该命中的那条守卫
       ⇒ **归因错误**（铁律 30：红的不一定是你那条）。
       ⚠️ 而且它是**冗余**的：把 `if (!plan.faithful)` 改成 `if (false)` 之后，
          上面那两条**正向**断言（要求表达式本身在）就已经会红。
       教训：负向"禁止某形状"的判据**必须把范围钉死在它要守的那句上**，不能圈一大片。 */
  });

  it("只接受**绝对路径**（相对路径在渲染页里无法定位源文件）", () => {
    const body = MAIN.slice(MAIN.indexOf("slime:docs:renderPage"));
    expect(body.slice(0, 1500)).toMatch(/isAbsolutePath\(/);
  });

  it("不支持保真的类型**返回 degrade 标记**（让渲染层知道该落回，而不是报错弹窗）", () => {
    /* ⚠️⚠️ **不能只 `toContain("degrade")`**：阶段 C 之后 `degrade` 在 IPC 里有**两处**
       （① `!plan.faithful` 分支 ② 老格式转换失败分支）⇒ 删掉①，②那处仍然命中、断言照样绿
       （实测变异 M12 **存活**）。这正是铁律 3 的"文本断言"叠上铁律 11 的"同一事实写两处"。
       判据 = **那一条具体的 return** 必须带 `degrade: true`（锚到该分支自己的错误文案上）。 */
    const body = MAIN.slice(MAIN.indexOf("slime:docs:renderPage"));
    expect(body).toContain('该类型不支持保真渲染（.${abs.split(".").pop() ?? "?"}）`, degrade: true }');
  });
});

describe("A-1136 ⑩ 判据来自 renderPlan（行为级，不是文本形状）", () => {
  it("新格式可保真；老格式需要 LibreOffice（阶段 C），不算能保真", () => {
    expect(canFaithfullyRender("a.pptx")).toBe(true);
    expect(canFaithfullyRender("a.docx")).toBe(true);
    expect(canFaithfullyRender("a.xlsx")).toBe(true);
    expect(canFaithfullyRender("a.pdf")).toBe(true);
    expect(canFaithfullyRender("a.doc")).toBe(false);
    expect(canFaithfullyRender("a.ppt")).toBe(false);
    expect(canFaithfullyRender("a.xls")).toBe(false);
    expect(needsLibreOffice("a.doc")).toBe(true);
    expect(needsLibreOffice("a.docx")).toBe(false);
  });

  it("⚠️ 老格式**不许**被判成 pdf-viewer 之外的东西 —— 它必须留出 needs 给阶段 C", () => {
    const p = planRender("x/老讲义.ppt");
    expect(p.needs).toBe("libreoffice");
    expect(p.faithful).toBe(true); // 能保真，但要先转 PDF
  });
});
