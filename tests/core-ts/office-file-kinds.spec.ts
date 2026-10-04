











import { describe, expect, it } from "vitest";
import { classifyFile, extOf, isNavigableLocalFile, isOfficeFile, nonNavigableReason } from "../../core-ts/src/office/fileKinds.js";


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
