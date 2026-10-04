/**
 * tests/core-ts/office-file-kinds.spec.ts — 「文件类型 → 怎么处理」判据的守卫。
 *
 * 背景（真实事故 2026-09-28）：拖入 .docx ⇒ Chromium 默认导航到 `file:///…docx`
 * ⇒ 不是它能渲染的类型 ⇒ `ERR_FAILED (-2)` + 重试风暴 + 文件垃圾 + 界面闪烁。
 * 修法的第一层就是本文件的判据：**能不能交给 Chromium 渲染**必须是可判定的规则，
 * 且**只有一个产地**（主进程导航守卫、渲染层拖放闸门、右栏地址栏、文档通道都调它）。
 *
 * ⚠️ 这里断言的是**能力边界**，不是"常见扩展名列表"：
 *   - `navigable` 只允许三类（图片 / PDF / HTML）；
 *   - `.txt/.csv/.json` **刻意**不可导航（走应用自己的文档通道，避免 file:// 第二产地）。
 */
import { describe, expect, it } from "vitest";
import { classifyFile, extOf, isNavigableLocalFile, isOfficeFile, nonNavigableReason } from "../../core-ts/src/office/fileKinds.js";
/* ⚠️ 「能不能读」这件事有**两个产地**：判据侧 `fileKinds`（决定收不收）与解析侧
   `doc_text::oleKindFromExt`（决定谁来读）。两边必须成套 —— 只放行不认读 = 用户看到"拖进来了但读不出"。 */
import { oleKindFromExt } from "../../core-ts/src/doc_text.js";

describe("A-1133-A classifyFile：种类 + 能力边界", () => {
  it("逐类型的种类 / 可导航 / 工作文档族", () => {
    const table: Array<[string, string, boolean, boolean]> = [
      ["a.png", "image", true, false],
      ["a.SVG", "image", true, false],
      ["报告.pdf", "pdf", true, true],
      ["index.html", "html", true, false],
      ["doc.docx", "word", false, true],
      ["doc.docm", "word", false, true],
      ["表.xlsx", "excel", false, true],
      ["稿.pptx", "powerpoint", false, true],
      ["旧.doc", "word", false, true],
      ["旧.xls", "excel", false, true],
      ["旧.ppt", "powerpoint", false, true],
      ["笔记.md", "text", false, false],
      ["数据.csv", "text", false, false],
      ["conf.json", "text", false, false],
      ["x.bin", "unknown", false, false],
    ];
    for (const [name, kind, navigable, office] of table) {
      const info = classifyFile(name);
      expect(info.kind, name).toBe(kind);
      expect(info.navigable, name).toBe(navigable);
      expect(info.office, name).toBe(office);
    }
  });

  it("⚠️ 不变量：navigable 只可能是 图片 / PDF / HTML（这三类 Chromium 真能画）", () => {
    /* 这条是本次事故的**核心判据**：只要有人把别的类型标成 navigable，
       Chromium 就会去加载一个它画不出来的东西 ⇒ ERR_FAILED + 重试风暴。 */
    const all = ["a.png", "a.pdf", "a.html", "a.docx", "a.xlsx", "a.pptx", "a.txt", "a.csv", "a.doc", "a.zip", "a.exe", "a"];
    for (const f of all) {
      const info = classifyFile(f);
      if (info.navigable) {
        expect(["image", "pdf", "html"], `${f} 被判成可导航，但它不是 Chromium 能渲染的三类之一`).toContain(info.kind);
      }
    }
  });

  it("⚠️ 不变量：工作文档族 ≠ 可导航（只有 PDF 是例外）", () => {
    for (const f of ["a.docx", "a.xlsx", "a.pptx", "a.doc", "a.xls", "a.ppt", "a.pdf"]) {
      expect(isOfficeFile(f), `${f} 应当属于工作文档族`).toBe(true);
      if (f !== "a.pdf") {
        expect(isNavigableLocalFile(f), `${f} 是工作文档，**不许**交给 Chromium 渲染`).toBe(false);
      }
    }
  });

  it("老版格式标 legacy（= 格式老），但**必须可读**（parser=ole）——两件事不许混", () => {
    /* ⚠️ 2026-09-28 的事故：我一度把 `legacy` 当成"读不了"⇒ 拖入 .ppt 直接被拒。
       而本仓 `cfb.ts` + `doc_text.ts::extractOleText` **一直能真读** OLE2 复合文档
       （`file_read` 就在用）。判据：`legacy` 只表达"格式老"，可读性由 `parser` 表达。 */
    for (const f of ["a.doc", "a.xls", "a.ppt"]) {
      const info = classifyFile(f);
      expect(info.legacy, `${f} 没被标 legacy（它是老格式）`).toBe(true);
      expect(info.parser, `${f} 必须能读（OLE 解析器）—— 判 none 会让整个格式族被误拒`).toBe("ole");
    }
    for (const f of ["a.docx", "a.xlsx", "a.pptx"]) {
      expect(classifyFile(f).legacy).toBe(false);
      expect(classifyFile(f).parser).toBe("zip-xml");
    }
  });

  it("⚠️ 老版**模板 / 放映**变体也要成套支持（.dot/.xlt/.pot/.pps）", () => {
    /* 用户要求「所有 Office 办公文件全给我做一遍适配」。
       这四个与 doc/xls/ppt 是**同一 OLE2 容器、同一批流名**（WordDocument / Workbook /
       PowerPoint Document）⇒ 解析器不用改，但**必须**登记进判据，否则拖入时被判 unknown 而拒收
       —— 那正是这次事故的形状（"拖进来没反应"）。 */
    const table: Array<[string, string]> = [
      ["模板.dot", "word"], ["模板.xlt", "excel"],
      ["模板.pot", "powerpoint"], ["放映.pps", "powerpoint"],
    ];
    for (const [name, kind] of table) {
      const info = classifyFile(name);
      expect(info.kind, name).toBe(kind);
      expect(info.office, `${name} 属于工作文档族`).toBe(true);
      expect(info.legacy, `${name} 是老版格式`).toBe(true);
      expect(info.parser, `${name} 必须能读（OLE）——判 none 会在拖入时被拒`).toBe("ole");
    }
  });

  it("⚠️ 解析侧产地必须与判据侧成套（`doc_text::oleKindFromExt` 也认这四个变体）", () => {
    /* 两个产地的漂移形状：判据侧放行了 `.dot`，解析侧 `oleKindFromExt(".dot") === null`
       ⇒ 主进程文档通道落到"未知类型"⇒ 用户看到"拖进来了但读不出内容"（比拒收更难查）。 */
    expect(oleKindFromExt(".doc")).toBe("doc");
    expect(oleKindFromExt(".dot")).toBe("doc");
    expect(oleKindFromExt(".xls")).toBe("xls");
    expect(oleKindFromExt(".xlt")).toBe("xls");
    expect(oleKindFromExt(".ppt")).toBe("ppt");
    expect(oleKindFromExt(".pot")).toBe("ppt");
    expect(oleKindFromExt(".pps")).toBe("ppt");
    expect(oleKindFromExt(".docx"), "OOXML 不走 OLE 通道").toBeNull();
  });
});

describe("A-1133-B 解析器选择：每种类型都要有明确归属（不许「不知道就硬读」）", () => {
  it("OOXML 三兄弟走 zip-xml；pdf 走 pdf；纯文本走 text；其余 none", () => {
    expect(classifyFile("a.docx").parser).toBe("zip-xml");
    expect(classifyFile("a.xlsx").parser).toBe("zip-xml");
    expect(classifyFile("a.pptx").parser).toBe("zip-xml");
    expect(classifyFile("a.pdf").parser).toBe("pdf");
    expect(classifyFile("a.csv").parser).toBe("text");
    expect(classifyFile("a.md").parser).toBe("text");
    /* ⚠️ 老版三兄弟走 **ole**（仓库有 OLE2 解析器），不能判 none —— 判 none = 整个格式族被拒。 */
    expect(classifyFile("a.doc").parser).toBe("ole");
    expect(classifyFile("a.xls").parser).toBe("ole");
    expect(classifyFile("a.ppt").parser).toBe("ole");
    expect(classifyFile("a.zip").parser, "未知/压缩包不许硬读成 utf-8 文本（那会造乱码正文）").toBe("none");
  });
});

describe("A-1133-C extOf：路径解析只认文件名部分", () => {
  it("目录名里的点不算扩展名", () => {
    expect(extOf("D:/a.b/报告")).toBe("");
    expect(extOf("D:/a.b/报告.docx")).toBe("docx");
    expect(extOf("C:\\试验场\\xlsx\\表.XLSX")).toBe("xlsx");
    expect(extOf("无扩展名")).toBe("");
    expect(extOf("结尾是点.")).toBe("");
    expect(extOf(".gitignore"), "以点开头的隐藏文件不是「扩展名 .gitignore」").toBe("");
  });
});

describe("A-1133-D nonNavigableReason：拒绝必须可操作（附「下一步做什么」）", () => {
  it("老版格式的提示是「按文本读取」而不是「不支持」（它确实能读）", () => {
    const r = nonNavigableReason("旧.doc");
    expect(r, "老版格式能读 ⇒ 说法必须是「不在浏览器页打开、已交给文档通道」").toContain("文档通道");
    expect(r).not.toContain("无法直接渲染");
  });

  it("工作文档 / 纯文本 / 未知类型都有各自的一句话（不许空串）", () => {
    for (const f of ["a.docx", "a.txt", "a.bin"]) {
      const r = nonNavigableReason(f);
      expect(r.length, `${f} 没有给出拒绝原因`).toBeGreaterThan(0);
    }
  });
});
