/**
 * A-1136：Office「保真渲染路线」判据（`core-ts/src/office/renderPlan.ts`）。
 *
 * 用户原话（2026-09-29）：「我要的是那种**类似以图片的形式**直接用 HTML 用 Web 预览的功能，
 * 而非转成 md 文件阅读」⇒ 本判据决定"这个文件该用哪个渲染器画"，必须**保真**的那几种被正确登记。
 */
import { describe, it, expect } from "vitest";
import { planRender, canFaithfullyRender, needsLibreOffice } from "../../core-ts/src/office/renderPlan.js";

describe("A-1136 ① 新格式 → 保真渲染器", () => {
  it("pptx 走 pptx-preview（保真）", () => {
    const p = planRender("jeny_第三章.pptx");
    expect(p.render).toBe("pptx-preview");
    expect(p.faithful).toBe(true);
    expect(p.needs).toBeUndefined();
  });

  it("docx 走 docx-preview（保真）", () => {
    const p = planRender("报告.docx");
    expect(p.render).toBe("docx-preview");
    expect(p.faithful).toBe(true);
  });

  it("xlsx 走 sheetjs（保真）", () => {
    const p = planRender("成绩.xlsx");
    expect(p.render).toBe("sheetjs");
    expect(p.faithful).toBe(true);
  });

  it("pdf 直接用 Chromium 内置查看器（本就是原生样貌）", () => {
    const p = planRender("论文.pdf");
    expect(p.render).toBe("pdf-viewer");
    expect(p.faithful).toBe(true);
    expect(p.needs).toBeUndefined();
  });

  it("同族变体（.pptm/.potx/.docm/.xltx…）与主扩展名同路线", () => {
    expect(planRender("a.pptm").render).toBe("pptx-preview");
    expect(planRender("a.potx").render).toBe("pptx-preview");
    expect(planRender("a.docm").render).toBe("docx-preview");
    expect(planRender("a.dotx").render).toBe("docx-preview");
    expect(planRender("a.xlsm").render).toBe("sheetjs");
    expect(planRender("a.xltx").render).toBe("sheetjs");
  });
});

describe("A-1136 ② 老格式（OLE2）→ 需要 LibreOffice，且**不许冒充已可保真**", () => {
  it(".ppt/.doc/.xls 标记 needs=libreoffice", () => {
    expect(needsLibreOffice("jeny_第三章.ppt")).toBe(true);
    expect(needsLibreOffice("报告.doc")).toBe(true);
    expect(needsLibreOffice("表.xls")).toBe(true);
    expect(planRender("a.pot").needs).toBe("libreoffice");
    expect(planRender("a.pps").needs).toBe("libreoffice");
  });

  it("⚠️ 老格式 canFaithfullyRender = false（needs 未满足前不许假装能画）", () => {
    expect(canFaithfullyRender("jeny_第三章.ppt")).toBe(false);
    expect(canFaithfullyRender("报告.doc")).toBe(false);
  });

  it("对照：新格式 canFaithfullyRender = true", () => {
    expect(canFaithfullyRender("a.pptx")).toBe(true);
    expect(canFaithfullyRender("a.docx")).toBe(true);
    expect(canFaithfullyRender("a.xlsx")).toBe(true);
    expect(canFaithfullyRender("a.pdf")).toBe(true);
  });
});

describe("A-1136 ③ 兜底与未知类型", () => {
  it("其它有扩展名的（txt/md/未知）退回结构化 HTML（不保真，但可用）", () => {
    const p = planRender("readme.md");
    expect(p.render).toBe("text-html");
    expect(p.faithful).toBe(false);
    expect(canFaithfullyRender("readme.md")).toBe(false);
  });

  it("无扩展名 → none（不硬套渲染器），且**绝不许**标成可保真", () => {
    expect(planRender("Makefile").render).toBe("none");
    expect(planRender("").render).toBe("none");
    /* ⚠️ `faithful` 必须显式 false —— 只断言 render="none" 挡不住
       "把 faithful 改成 true"（那样未知类型会被当成能画 ⇒ 白屏且不报错）。 */
    expect(planRender("Makefile").faithful).toBe(false);
    expect(planRender("").faithful).toBe(false);
    expect(canFaithfullyRender("Makefile")).toBe(false);
    expect(canFaithfullyRender("")).toBe(false);
  });

  it("二进制/无扩展名的怪东西一律不保真（faithful=false 是**唯一**准入判据）", () => {
    for (const n of ["a.bin", "noext", "x.", ".gitignore", "a.exe"]) {
      expect(planRender(n).faithful, `${n} 不该被认为可保真`).toBe(false);
    }
  });

  it("路径只看末段文件名（目录里的点不算扩展名）", () => {
    expect(planRender("D:/a.b/c/报告.docx").render).toBe("docx-preview");
    expect(planRender("C:\\Users\\MR\\Downloads\\jeny_第三章.pptx").render).toBe("pptx-preview");
  });

  it("大小写不敏感", () => {
    expect(planRender("A.PPTX").render).toBe("pptx-preview");
    expect(planRender("A.Doc").needs).toBe("libreoffice");
  });
});
