/**
 * tests/core-ts/a1133-pdf-text.spec.ts — PDF 文本抽取的守卫（A-1133）。
 *
 * 需求（用户原话）：「让 slime 彻底支持这一系列的工作文档的读取、制作」。
 * 缺口：`.pdf` 此前**读不了** —— `doc_text.ts` 只覆盖 docx/xlsx/pptx(+老 OLE)，
 * `.pdf` 会落到"当 utf-8 直读"⇒ 拿到二进制乱码（比报错更坏：模型会拿乱码当真去回答）。
 *
 * 本文件锁三件事：
 *   ① 能读的：未压缩 / FlateDecode 内容流里的字面量文本，以及**有 ToUnicode 映射**的 hex 文本；
 *   ② **读不了必须报错，绝不返回乱码**（加密 / 无内容流 / 非 Flate 滤镜 / 无映射的编码字节）；
 *   ③ 中文：本仓 `docWrite.ts` 生成的 PDF 把非 ASCII 字节写成八进制转义 ⇒ 读回要做 UTF-8 嗅探。
 *
 * 夹具是**手写的 PDF 字节**（不借助任何库）：既能精确控制形状，也避免"用被测侧造夹具"的自证。
 */
import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { extractPdfText, isPdf } from "../../core-ts/src/pdf_text.js";

/** 拼一个最小 PDF；`content` 是内容流的**原始字节**（未压缩），`extra` 插进 page 字典 */
function makePdf(content: Buffer | string, opts: { flate?: boolean; extraDict?: string; cid?: boolean } = {}): Buffer {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "latin1");
  const stream = opts.flate ? deflateSync(body) : body;
  const filter = opts.flate ? " /Filter /FlateDecode" : "";
  const font = opts.cid
    ? "<< /Type /Font /Subtype /Type0 /BaseFont /MSGothic /Encoding /Identity-H >>"
    : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const parts = [
    "%PDF-1.4\n",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    `3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R ${opts.extraDict ?? ""} >> endobj\n`,
    `4 0 obj << /Length ${stream.length}${filter} >>\nstream\n`,
    stream,
    "\nendstream\nendobj\n",
    `5 0 obj ${font} endobj\n`,
    "trailer << /Root 1 0 R >>\n%%EOF\n",
  ];
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "latin1"))));
}

const HELLO = "BT /F1 12 Tf 72 720 Td (Hello World) Tj ET";

describe("A-1133-① PDF：能读的情形", () => {
  it("未压缩内容流：字面量文本读得出来，且标记为 pdf", () => {
    const r = extractPdfText(makePdf(HELLO));
    expect(r.text).toContain("Hello World");
    expect(r.info.join(" "), "结构摘要里要说明结果来自哪类内容流").toContain("内容流");
  });

  it("FlateDecode 内容流：能解压后读出文本（这是现实里最常见的写法）", () => {
    const r = extractPdfText(makePdf(HELLO, { flate: true }));
    expect(r.text).toContain("Hello World");
  });

  it("转义与换行：`\\(` `\\)` 与 Td 换行要按 PDF 语义还原", () => {
    const r = extractPdfText(makePdf("BT 12 Tf (a\\(b\\)c) Tj 0 -14 Td (second) Tj ET"));
    expect(r.text).toContain("a(b)c");
    expect(r.text, "Td 表示下一行 ⇒ 两段之间必须有换行").toMatch(/a\(b\)c\s*\n\s*second/);
  });

  it("UTF-8 嗅探：非 ASCII 字节按 UTF-8 解（自产 PDF 就是这种形状），不返回 Latin-1 乱码", () => {
    /* 八进制转义 = 逐字节写入的 UTF-8：`你` = E4 BD A0 ⇒ \344\275\240 */
    const r = extractPdfText(makePdf("BT 12 Tf (\\344\\275\\240\\345\\245\\275) Tj ET"));
    expect(r.text, "没做 UTF-8 嗅探的话这里会是 3 个 Latin-1 字符").toContain("你好");
  });

  it("CID 文本 + ToUnicode：hex 字形码按映射还原成可读字符（且**只交付一次**）", () => {
    const content = "BT /F1 12 Tf <0041> Tj ET";
    /* 真实的 ToUnicode CMap 形状（带 `begincmap` 前言）。⚠️ 夹具必须真实：
       精简到只剩 `beginbfchar` 时，CMap 流会被当成内容流 ⇒ 同一句话交付两次（实测踩到）。 */
    const cmap = [
      "/CIDInit /ProcSet findresource begin",
      "12 dict begin",
      "begincmap",
      "1 beginbfchar",
      "<0041> <4F60>",
      "endbfchar",
      "endcmap",
      "end",
    ].join("\n");
    const pdf = makePdf(content, { cid: true });
    const withCmap = Buffer.concat([pdf, Buffer.from(`6 0 obj << /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n`, "latin1")]);
    const r = extractPdfText(withCmap);
    expect(r.text.trim(), "重复交付说明 CMap 流被当成了内容流").toBe("你");
    expect(r.info.join(" "), "用了 ToUnicode 就要在摘要里说明").toContain("ToUnicode");
  });
});

describe("A-1133-② PDF：读不了必须报错（**绝不返回乱码**）", () => {
  it("加密 PDF：明确告知加密 + 给下一步（另存为无加密副本 / 截图）", () => {
    const pdf = makePdf(HELLO, { extraDict: "" });
    const encrypted = Buffer.concat([pdf, Buffer.from("7 0 obj << /Encrypt 8 0 R >> endobj\n", "latin1")]);
    expect(() => extractPdfText(encrypted)).toThrow(/加密/);
  });

  it("没有内容流（扫描件/纯图）：报错说明需要 OCR，而不是给空正文", () => {
    const noStream = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n", "latin1");
    expect(() => extractPdfText(noStream)).toThrow(/内容流|OCR/);
  });

  it("非 Flate 滤镜（LZW 等）：跳过并说明，不把压缩字节当正文硬匹配", () => {
    const pdf = makePdf(HELLO, { extraDict: "" });
    const lzw = Buffer.concat([pdf, Buffer.from("9 0 obj << /Length 20 /Filter /LZWDecode >>\nstream\nLZWCOMPRESSEDBYTES\nendstream\nendobj\n", "latin1")]);
    // 该流被跳过，但原文那条未压缩流仍可读 ⇒ 断言"跳过"被如实报告
    const r = extractPdfText(lzw);
    expect(r.text).toContain("Hello World");
    expect(r.info.join(" "), "跳过的流必须在摘要里说清").toMatch(/跳过/);
  });

  it("⚠️ 编码字节（找不到可读文本）：报错，**不许**把乱码当正文交付", () => {
    /* 全是控制字符的"文本"：任何正常抽取器都不该把它当正文返回 */
    const junk = makePdf("BT 12 Tf <000100020003000400050006> Tj ET");
    expect(() => extractPdfText(junk)).toThrow(/编码字节|ToUnicode|截图/);
  });

  it("不是 PDF：拒绝（避免把任意二进制送进解析器）", () => {
    expect(isPdf(Buffer.from("PK\u0003\u0004fake docx", "latin1"))).toBe(false);
    expect(() => extractPdfText(Buffer.from("not a pdf at all", "latin1"))).toThrow(/%PDF-/);
  });
});
