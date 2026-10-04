

















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { planRender, canFaithfullyRender, needsLibreOffice } from "../../core-ts/src/office/renderPlan.js";

function codeOf(rel: string): string {
  



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



function openBody(): string {
  const i = SIDEBAR.indexOf("const openDocPreviewPage");
  expect(i, "RightSidebar 里找不到 openDocPreviewPage（改名了？同步本守卫）").toBeGreaterThan(-1);
  const rest = SIDEBAR.slice(i);
  const j = rest.indexOf("\n  const ", 10); 
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
    
    const body = MAIN.slice(MAIN.indexOf("slime:docs:renderPage"));
    const seg = body.slice(0, 1200);
    expect(seg).not.toMatch(/\.pptx["']\s*\|\|/); 
  });

  it("⚠️ planRender 的结论**必须真的当闸门用**（摆着不用的那种要拦下）", () => {
    







    const body = MAIN.slice(MAIN.indexOf("slime:docs:renderPage"));
    const seg = body.slice(0, 2000);
    expect(seg).toMatch(/if\s*\(\s*!\s*plan\.faithful\s*\)/);
    expect(seg).toMatch(/plan\.needs\s*===\s*["']libreoffice["']/);
    







  });

  it("只接受**绝对路径**（相对路径在渲染页里无法定位源文件）", () => {
    const body = MAIN.slice(MAIN.indexOf("slime:docs:renderPage"));
    expect(body.slice(0, 1500)).toMatch(/isAbsolutePath\(/);
  });

  it("不支持保真的类型**返回 degrade 标记**（让渲染层知道该落回，而不是报错弹窗）", () => {
    



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
    expect(p.faithful).toBe(true); 
  });
});
