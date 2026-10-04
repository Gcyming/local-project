/**
 * tests/core-ts/office-doc-write.spec.ts — 文档写入口 writeDocument 的行为级测试。
 *
 * 三层断言，缺一不可：
 * 1. **真的是那个格式**：魔数 / 容器部件齐不齐（用 jszip 反解，独立于被测写侧）。
 * 2. **结构自洽**：`[Content_Types].xml` 声明的每个部件都必须真实存在。
 * 3. **写读 round-trip**：写出的文件必须能被本模块的 extractDocumentText 读回来，
 *    文本逐行对得上（只允许空白差异）。写侧的转义与读侧的反转义必须同一套语义。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
/* ⚠️ A-1133 收口：ZIP 容器与 Office 抽文本**在仓库里早就各有一份**（`core-ts/src/zip.ts` 与
   `core-ts/src/doc_text.ts`，后者连 .doc/.xls/.ppt 的 OLE 都能抽，`file_read` 已在用）。
   本 spec 一律用**那两份**：为测试再养一份实现，等于把「同一事实两个产地」引进门（铁律 11）。 */
import { listZip, readZipEntry } from "../../core-ts/src/zip.js";
import { extractDocText, docKindFromExt } from "../../core-ts/src/doc_text.js";
import { writeDocument } from "../../core-ts/src/office/docWrite.js";

/**
 * round-trip 的判据是「**正文每一行都回来了**」，不是「与某个读器的排版逐字节相等」。
 * 为什么：读侧由仓库既有的 `doc_text.ts` 负责，它会按自己的口径加轻结构
 * （xlsx 加列字母表头、pptx 用 `--- 第 N 页 ---`、docx 去掉 markdown 前缀）。
 * 断言排版等于把测试绑死在**读器的实现细节**上 —— 读器一改口径，写侧明明没错也会红。
 */
/** xlsx 的 round-trip 判据：**每个单元格的值**都在读回文本里。
 *  为什么不是整行/逐字节：既有读器把表格渲染成「列字母表头 + `A | B` 网格」（带轻结构是它的设计），
 *  TSV 的分隔符与它无关 ⇒ 比排版必然假红。 */
function expectCellsKept(read: string, body: string): void {
  for (const cell of body.split(/[\t,\n]/).map((c) => c.trim()).filter(Boolean)) {
    expect(read, `单元格在读回文本里丢了：${cell}`).toContain(cell);
  }
}

function expectLinesKept(read: string, want: string): void {
  for (const raw of want.split("\n")) {
    const line = raw.trim();
    if (!line) { continue; }
    const core = line.replace(/^#+\s*/, "").replace(/^-\s*/, "");
    expect(read, `正文行在 round-trip 中丢了：${core}`).toContain(core);
  }
}

/** 用既有 zip.ts 读全部条目（测试只做校验，不重写实现）。 */
function readAll(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of listZip(buf)) { const d = readZipEntry(buf, e.name); if (d) { out.set(e.name, d); } }
  return out;
}

/** 读回写出的文件：包成 {ok,text,error} —— 让断言语义（成功/失败）与写接口对称。 */
async function readBack(p: string): Promise<{ ok: boolean; text: string; error?: string }> {
  try {
    const kind = docKindFromExt(p.slice(p.lastIndexOf(".")));
    /* 纯文本族（csv/md/txt）：没有"转换"一说，该格式的语义就是直读 utf-8。 */
    if (!kind) { return { ok: true, text: (await readFile(p)).toString("utf8") }; }
    const r = extractDocText(await readFile(p), kind);
    return { ok: true, text: r.text };
  } catch (e) { return { ok: false, text: "", error: String((e as Error)?.message ?? e) }; }
}


let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "office-write-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/* ⚠️ 原先这里有个 `norm()`（逐行 trim 后比对）—— A-1133 收口后不再需要：
   round-trip 的判据已改为「行级 / 单元格级包含」（见 `expectLinesKept` / `expectCellsKept`），
   因为读侧用的是仓库既有的 `doc_text.ts`，它按自己的口径加轻结构。留着会变成 TS6133 死代码。 */

/** [Content_Types].xml 里声明的部件必须真实存在，否则 Office 会报「文件已损坏」。 */
function assertPartsSelfConsistent(buf: Buffer): void {
  const parts = readAll(buf);
  const ct = parts.get("[Content_Types].xml")?.toString("utf8") ?? "";
  const declared = [...ct.matchAll(/PartName="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ""));
  expect(declared.length).toBeGreaterThan(0);
  for (const name of declared) {
    expect(parts.has(name), `${name} 被声明却不存在`).toBe(true);
  }
}

describe("writeDocument — docx", () => {
  it("写出真 ZIP 容器、部件齐全、结构自洽，且能被读回（标题/正文/列表/二级标题）", async () => {
    const p = join(root, "报告.docx");
    const body = "# 一级标题\n这是一段正文。\n- 第一项\n- 第二项\n## 二级标题";
    const w = await writeDocument({ path: p, format: "docx", title: "文档标题", body });
    if (!w.ok) { throw new Error(w.error); }

    const buf = await readFile(p);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(w.bytes).toBe(buf.length);

    const parts = readAll(buf);
    for (const name of [
      "[Content_Types].xml", "_rels/.rels", "word/document.xml",
      "word/_rels/document.xml.rels", "word/styles.xml", "word/numbering.xml",
    ]) {
      expect(parts.has(name), name).toBe(true);
    }
    assertPartsSelfConsistent(buf);

    const docXml = parts.get("word/document.xml")!.toString("utf8");
    expect(docXml).toContain('w:val="Heading1"');
    expect(docXml).toContain('w:val="Heading2"');
    expect(docXml).toContain("<w:numPr>");

    // 独立阅读器（jszip）能打开
    const out = await JSZip.loadAsync(buf);
    expect(out.file("word/document.xml")).not.toBeNull();

    const res = await readBack(p);
    if (!res.ok) { throw new Error(res.error); }
    expectLinesKept(res.text, `# 文档标题
${body}`);
  });

  it("正文里的 XML 元字符（& < >）被转义，读回原样", async () => {
    const p = join(root, "esc.docx");
    const body = "A & B < C > D <tag>";
    const w = await writeDocument({ path: p, format: "docx", body });
    if (!w.ok) { throw new Error(w.error); }
    const res = await readBack(p);
    if (!res.ok) { throw new Error(res.error); }
    expectCellsKept(res.text, body);
  });
});

describe("writeDocument — xlsx", () => {
  it("TSV 正文 round-trip，六个部件齐全且结构自洽", async () => {
    const p = join(root, "表.xlsx");
    const body = "城市\t人口\n北京\t2189\n上海\t2487";
    const w = await writeDocument({ path: p, format: "xlsx", body });
    if (!w.ok) { throw new Error(w.error); }

    const buf = await readFile(p);
    expect(w.bytes).toBe(buf.length);
    const parts = readAll(buf);
    for (const name of [
      "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml", "xl/sharedStrings.xml",
    ]) {
      expect(parts.has(name), name).toBe(true);
    }
    assertPartsSelfConsistent(buf);
    expect(await JSZip.loadAsync(buf).then((z) => z.file("xl/sharedStrings.xml") !== null)).toBe(true);

    const res = await readBack(p);
    if (!res.ok) { throw new Error(res.error); }
    expectCellsKept(res.text, body);
  });

  it("CSV 正文按 , 分列（读回以 \\t 分列，单元格值一一对应）", async () => {
    const p = join(root, "csv-in.xlsx");
    const csv = "a,b,c\n1,2,3";
    const w = await writeDocument({ path: p, format: "xlsx", body: csv });
    if (!w.ok) { throw new Error(w.error); }
    const res = await readBack(p);
    if (!res.ok) { throw new Error(res.error); }
    expectCellsKept(res.text, csv);
  });
});

describe("writeDocument — pptx", () => {
  it("每页独立 slide + rels，master/layout 占位齐全，round-trip 内容行", async () => {
    const p = join(root, "演示.pptx");
    const body = "# 封面\n- 要点一\n- 要点二\n正文段\n# 第二页\n- 要点三";
    const w = await writeDocument({ path: p, format: "pptx", body });
    if (!w.ok) { throw new Error(w.error); }

    const buf = await readFile(p);
    expect(w.bytes).toBe(buf.length);
    const parts = readAll(buf);
    for (const name of [
      "[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml", "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      "ppt/slideLayouts/slideLayout1.xml", "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      "ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/_rels/slide1.xml.rels",
    ]) {
      expect(parts.has(name), name).toBe(true);
    }
    assertPartsSelfConsistent(buf);

    const res = await readBack(p);
    if (!res.ok) { throw new Error(res.error); }
    expect(res.text, "既有读器的页标记口径是 `--- 第 N 页 ---`").toContain("--- 第 1 页 ---");
    expect(res.text, "既有读器的页标记口径是 `--- 第 N 页 ---`").toContain("--- 第 2 页 ---");
    /* 正文行用**行级**判据（不按页拆分：怎么分页属于读器口径，不是写侧契约）。 */
    expectLinesKept(res.text, body);
  });
});

describe("writeDocument — pdf", () => {
  it("xref 偏移真实可寻址（每条记录都指向对应对象），round-trip 含中文", async () => {
    const p = join(root, "文档.pdf");
    const body = "第一行\nsecond line\n第三行";
    const w = await writeDocument({ path: p, format: "pdf", body });
    if (!w.ok) { throw new Error(w.error); }

    const buf = await readFile(p);
    expect(w.bytes).toBe(buf.length);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const s = buf.toString("latin1");
    const head = /startxref\s+(\d+)\s+%%EOF/.exec(s);
    expect(head, "缺少 startxref/%%EOF").not.toBeNull();
    const xrefOff = Number(head![1]);
    expect(s.slice(xrefOff, xrefOff + 4)).toBe("xref");

    const blk = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(s.slice(xrefOff));
    expect(blk, "xref 表结构不对").not.toBeNull();
    const total = Number(blk![1]);
    const entries = blk![2].split("\n").filter((l) => l.length > 0);
    expect(entries.length).toBe(total);
    // 每条非空闲记录指向的位置，必须真的是「<n> 0 obj」
    for (let i = 1; i < total; i += 1) {
      const off = Number(entries[i].slice(0, 10));
      expect(s.slice(off, off + String(i).length + 6), `对象 ${i} 的 xref 偏移是假的`).toBe(`${i} 0 obj`);
    }

    const res = await readBack(p);
    if (!res.ok) { throw new Error(res.error); }
    /* A-1133：PDF 读取**已补上**（`core-ts/src/pdf_text.ts`）⇒ 这条从"钉住缺口"升级为真 round-trip。
       之前它钉的是 `docKindFromExt(".pdf") === null`（"读侧没有 PDF 分支"）—— 现在会红，
       正是当时写下的交接信号。 */
    expect(docKindFromExt(".pdf"), "PDF 现在必须有读取分支").toBe("pdf");
    expectLinesKept(res.text, body);
  });

  it("/Length 是内容流的真实字节数（假的长度会让严格阅读器报文件损坏）", async () => {
    const p = join(root, "len.pdf");
    const w = await writeDocument({ path: p, format: "pdf", body: "alpha\nbeta" });
    if (!w.ok) { throw new Error(w.error); }
    const s = (await readFile(p)).toString("latin1");
    let checked = 0;
    for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const declared = Number(m[1]);
      const start = m.index + m[0].length;
      // 声明长度之后必须紧跟 "\nendstream"
      expect(s.slice(start + declared, start + declared + 11)).toBe("\nendstream\n");
      checked += 1;
    }
    expect(checked).toBe(1);
  });

  it("正文超过一页时分页，/Count 与实际页数一致", async () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const p = join(root, "long.pdf");
    const w = await writeDocument({ path: p, format: "pdf", body });
    if (!w.ok) { throw new Error(w.error); }
    const s = (await readFile(p)).toString("latin1");
    expect(s).toContain("/Count 2");
    expect((s.match(/\/Type \/Page /g) ?? []).length).toBe(2);
    const res = await readBack(p);
    if (!res.ok) { throw new Error(res.error); }
    /* A-1133：PDF 读取已补上 ⇒ 多页正文也必须逐行读回（旧断言"钉缺口"当时写下的交接信号已兑现）。 */
    expect(docKindFromExt(".pdf")).toBe("pdf");
    expectLinesKept(res.text, body);
  });
});

describe("writeDocument — 直写格式与失败路径", () => {
  it("csv/md/txt 字节即正文（utf-8），读回一致", async () => {
    for (const format of ["csv", "md", "txt"] as const) {
      const p = join(root, `直写.${format}`);
      const body = "列一,列二\n值一,值二";
      const w = await writeDocument({ path: p, format, body });
      if (!w.ok) { throw new Error(w.error); }
      expect((await readFile(p)).toString("utf8"), format).toBe(body);
      const res = await readBack(p);
      expect(res.ok && res.text, format).toBe(body);
    }
  });

  it("父路径被同名文件占位时 ok:false 且带原因，不抛异常", async () => {
    const blocker = join(root, "blocker");
    await writeFile(blocker, "x");
    const target = join(blocker, "a.txt");
    const w = await writeDocument({ path: target, format: "txt", body: "hi" });
    expect(w.ok).toBe(false);
    if (w.ok) { return; }
    expect(w.path).toBe(target);
    expect(w.error.length).toBeGreaterThan(0);
  });

  it("自动创建不存在的父目录", async () => {
    const p = join(root, "深", "层", "目录", "a.txt");
    const w = await writeDocument({ path: p, format: "txt", body: "深目录" });
    if (!w.ok) { throw new Error(w.error); }
    expect((await readFile(p)).toString("utf8")).toBe("深目录");
  });
});
