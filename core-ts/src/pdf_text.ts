/**
 * core-ts/src/pdf_text.ts — PDF 文本抽取（**尽力而为，边界写死并如实报错**）。
 *
 * ## 为什么单独成文件
 * 与 `zip.ts`（ZIP 容器）、`cfb.ts`（OLE2 复合文档）同级：**一类格式一个解析器**，
 * 由 `doc_text.ts` 统一派发。PDF 既不是 ZIP 也不是 OLE，混进任一处都会让那个文件变成
 * "什么格式都管"的杂物间。
 *
 * ## 需求来源（真实缺口，2026-09-28）
 * 用户把 `.pdf` 拖进应用后**读不了**：`doc_text.ts` 只覆盖 docx/xlsx/pptx（+ 老版 OLE），
 * 于是 `.pdf` 会落到"当 utf-8 直读"那条路 —— 拿到的是二进制乱码（比报错更坏：
 * 模型会拿乱码当真去回答）。
 *
 * ## 覆盖范围（**明确的上限，不是"大致能用"**）
 * 能读：`%PDF-` 头 + 内容流是 **未压缩** 或 **FlateDecode** + 文本用**字面量字符串 `(...)`**
 *   或 **hex 字符串 `<...>` 且存在 ToUnicode CMap** 的 PDF。
 * 读不了（一律**抛错并说明原因**，绝不返回乱码）：
 *   · `/Encrypt`（加密）；· LZW / ASCII85 / DCT 等非 Flate 滤镜；· 一条内容流都没解出；
 *   · 有 hex 字符串但**没有任何 ToUnicode 映射**（CID 字体，现实中中文 PDF 的常见形态）；
 *   · 解出的文本"看起来是乱码"（控制字符占比过高）——这条是兜底：宁可报"读不了"，
 *     也不能把乱码当正文交给模型。
 *
 * ## 为什么不做成"完整 PDF 解析器"
 * 完整实现需要：xref/对象流解析 → 页树 → 资源字典 → 字体 → Encoding/ToUnicode → 内容流解释器。
 * 那是 pdf.js 这个量级的工程。这里只做**能覆盖"自产 PDF + 简单排版 PDF"**的一档，
 * 并把"读不了"的情况变成可操作的报错（`info` 里给出下一步建议）。
 */
import { inflateRawSync, inflateSync } from "node:zlib";

export interface PdfExtractResult {
  text: string;
  /** 结构摘要（给模型/界面看的：扫到几条流、跳过几条、有哪些限制） */
  info: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 200_000;

/** 是不是 PDF（`%PDF-` 头允许前面有少量垃圾字节，规范允许 1024 字节以内） */
export function isPdf(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString("latin1");
  return head.includes("%PDF-");
}

/** 拉丁-1 反向表：字节 → 字符（PDF 的内容流是字节流，不是 UTF-8） */
function latin1(buf: Buffer): string {
  return buf.toString("latin1");
}

/** 解 PDF 字面量字符串里的转义：`\n \r \t \b \f \( \) \\ \ddd(八进制) \换行(续行)` */
function unescapeLiteral(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c !== "\\") { out += c; continue; }
    const n = s[i + 1];
    if (n === undefined) { break; }
    if (n === "n") { out += "\n"; i += 1; continue; }
    if (n === "r") { out += "\r"; i += 1; continue; }
    if (n === "t") { out += "\t"; i += 1; continue; }
    if (n === "b") { out += "\b"; i += 1; continue; }
    if (n === "f") { out += "\f"; i += 1; continue; }
    if (n === "\n") { i += 1; continue; }                 // 续行：反斜杠 + 换行 = 无输出
    if (n === "\r") { i += s[i + 2] === "\n" ? 2 : 1; continue; }
    if (n >= "0" && n <= "7") {                            // 最多三位八进制
      let oct = "";
      let k = i + 1;
      while (k < s.length && oct.length < 3 && s[k] >= "0" && s[k] <= "7") { oct += s[k]; k += 1; }
      out += String.fromCharCode(parseInt(oct, 8));
      i = k - 1;
      continue;
    }
    out += n; i += 1;                                      // \( \) \\ 以及其它未知转义 = 那个字符本身
  }
  return out;
}

/** hex 字符串 `<...>` → 字节序列（忽略空白；奇数长度右侧补 0，规范如此） */
function hexToBytes(hex: string): Buffer {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const out = Buffer.alloc(padded.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * 收集文档里所有 ToUnicode CMap（`beginbfchar` / `beginbfrange`）。
 *
 * 为什么必须做：CID 字体的内容流里是**字形码**（如 `<0041>`），不是 Unicode；
 * 没有这张映射表就只能读出乱码。CMap 本身是明文的（通常在未压缩的流里），
 * 解析成本低、收益高（它决定"中文 PDF 能不能读"）。
 *
 * ⚠️ 这里把所有 CMap **合并成一张全局表**：严格做法是按字体资源分别应用，
 *    但那需要解析资源字典与 `Tf` 的对应关系。对"单字体/字体不冲突"的常见文档，
 *    合并表等价；万一冲突，结果是局部文本不准 —— 因此下面还有"乱码兜底"会把它拦掉。
 */
function collectToUnicodeMap(doc: string): Map<number, string> {
  const map = new Map<number, string>();
  /* bfchar：一对一
       beginbfchar
       <0041> <4F60>
       endbfchar                                                          */
  for (const blk of doc.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const src = parseInt(pair[1], 16);
      const bytes = hexToBytes(pair[2]);
      if (bytes.length === 0 || bytes.length % 2 !== 0) { continue; }
      map.set(src, Buffer.from(bytes).swap16().toString("utf16le").replace(/\uFEFF/g, ""));
    }
  }
  /* bfrange：区间（`<lo> <hi> <dst>` 连续递增，或 `<lo> <hi> [<d1> <d2> …]` 逐项） */
  for (const blk of doc.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (!(hi >= lo) || hi - lo > 65_535) { continue; }
      if (m[3].startsWith("[")) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
        items.forEach((hex, i) => {
          const bytes = hexToBytes(hex);
          if (bytes.length % 2 === 0 && bytes.length > 0) { map.set(lo + i, Buffer.from(bytes).swap16().toString("utf16le")); }
        });
        continue;
      }
      const base = hexToBytes(m[3].slice(1, -1));
      if (base.length !== 2 && base.length !== 4) { continue; }
      const baseCode = base.length === 2 ? base.readUInt16BE(0) : base.readUInt32BE(0);
      for (let code = lo; code <= hi; code += 1) {
        const v = baseCode + (code - lo);
        map.set(code, v <= 0xffff ? String.fromCharCode(v) : String.fromCodePoint(v));
      }
    }
  }
  return map;
}

/** 内容流里"当前字体是不是 CID（需要 CMap 才能解）"的粗判：`/Type0` 或 `Identity-H` 出现即视为是 */
function looksLikeCidFont(doc: string): boolean {
  return /\/Subtype\s*\/Type0|Identity-H/.test(doc);
}

/**
 * 从一个**已解码**的内容流里取文本。
 * 只认文本算子：`Tj` / `TJ` / `'` / `"`；换行靠 `Td/TD/T*` 与 `TJ` 里的大负位移（排版惯例）。
 */
function textFromContentStream(content: string, cmap: Map<number, string>, needCmap: boolean): string {
  let out = "";
  let pending = "";
  let i = 0;
  const pushBreak = (): void => { if (pending && !pending.endsWith("\n")) { pending += "\n"; } };

  while (i < content.length) {
    const c = content[i];

    // 字面量字符串 (...)
    if (c === "(") {
      let depth = 1;
      let j = i + 1;
      let raw = "";
      while (j < content.length && depth > 0) {
        const d = content[j];
        if (d === "\\") { raw += d + (content[j + 1] ?? ""); j += 2; continue; }
        if (d === "(") { depth += 1; }
        if (d === ")") { depth -= 1; if (depth === 0) { break; } }
        raw += d; j += 1;
      }
      pending += unescapeLiteral(raw);
      i = j + 1;
      continue;
    }

    // hex 字符串 <...>
    if (c === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i + 1);
      if (end < 0) { break; }
      const bytes = hexToBytes(content.slice(i + 1, end));
      if (needCmap && cmap.size > 0 && bytes.length % 2 === 0) {
        // 两字节字形码 → 查 ToUnicode
        for (let k = 0; k + 1 < bytes.length; k += 2) {
          const code = bytes.readUInt16BE(k);
          pending += cmap.get(code) ?? "";
        }
      } else {
        pending += latin1(bytes);
      }
      i = end + 1;
      continue;
    }

    // 文本算子：Tj（显示一串）／TJ（数组，含字距数字）／' 与 "（换行 + 显示）
    if (content.startsWith("Tj", i) || content.startsWith("TJ", i)) { i += 2; continue; }
    if (c === "'") { pushBreak(); i += 1; continue; }
    if (c === "\"") { pushBreak(); i += 1; continue; }

    // 定位算子 → 换行（PDF 里 `Td/TD/T*` 表示下一行；`TJ` 数组里的负数位移也能表示换行）
    if (content.startsWith("Td", i) || content.startsWith("TD", i) || content.startsWith("T*", i)) {
      pushBreak(); i += 2; continue;
    }
    if (c === "]" ) { pushBreak(); i += 1; continue; }

    if (c === "\n" || c === "\r") { out += ""; i += 1; continue; }
    i += 1;
  }

  if (pending) { out += pending; }
  return out;
}

/**
 * UTF-8 嗅探：PDF 的内容流是**字节流**，字面量里的中文既可能是"字节即 Latin-1"，
 * 也可能是"UTF-8 字节被逐字节写进字符串"（本仓 `docWrite.ts` 生成的 PDF 就是后者：
 * 非 ASCII 字节写成八进制转义）。前者按 Latin-1 解出来的就是乱码。
 *
 * 判据：把 Latin-1 解出的字符串**重新编码回字节**，若那串字节是**合法 UTF-8**，
 * 就按 UTF-8 再解一次。用 `fatal: true` 保证"不是合法 UTF-8 就抛"，绝不半信半疑地替换字符
 * （那会把本来正确的 Latin-1 文本破坏成 U+FFFD）。
 */
function sniffUtf8(latin: string): string {
  if (!/[\u0080-\u00ff]/.test(latin)) { return latin; }   // 纯 ASCII：无需嗅探
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(latin, "latin1"));
  } catch {
    return latin;
  }
}

/**
 * 抽 PDF 文本。
 * @throws 加密 / 无可用内容流 / 非 Flate 滤镜 / 缺 ToUnicode 的 CID 文本 / 解出的是乱码
 */
export function extractPdfText(buf: Buffer, opts: { maxChars?: number } = {}): PdfExtractResult {
  if (!isPdf(buf)) { throw new Error("不是有效的 PDF（缺少 %PDF- 头）。"); }
  const doc = latin1(buf);
  if (/\/Encrypt\s/.test(doc)) {
    throw new Error("PDF 已加密（含 /Encrypt），无法读取文本；请先用阅读器另存为无加密副本，或直接截图/复制内容给我。");
  }

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const cmap = collectToUnicodeMap(doc);
  const needCmap = looksLikeCidFont(doc);
  const info: string[] = [];

  /* 逐条 `stream … endstream` 扫。为什么要"扫流"而不是走对象图：
     对象图需要 xref/对象流解析（现代 PDF 默认压缩对象），成本高得多；而内容流本身
     在字节层面就能定位（`stream` 关键字 + `/Length`）。代价是**无法保证页序** ——
     按对象出现顺序输出，多页文档的顺序可能与本来的页序不同（下面写进 info）。 */
  const streams: string[] = [];
  let skipped = 0;
  /* ⚠️ 必须排除 `endstream`：那个词里也含 `stream` + 换行 ⇒ 会被当成下一条流的开头，
     于是后续窗口整体错位、把**词典与邻居对象的字节**当内容流去解
     （实测症状：明明只有一个内容流，却凭空多出一块乱码文本）。 */
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    const start = m.index + m[0].length;
    const end = doc.indexOf("endstream", start);
    if (end < 0) { break; }
    const dictStart = Math.max(0, m.index - 400);
    const dict = doc.slice(dictStart, m.index);
    const raw = buf.subarray(start, end);
    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? "";
    const isFlate = /FlateDecode/.test(filter) || filter === "";
    const hasOtherFilter = /LZWDecode|ASCII85Decode|DCTDecode|RunLengthDecode|CCITTFaxDecode/.test(filter);
    if (!isFlate || hasOtherFilter) { skipped += 1; continue; }
    let decoded: Buffer | null = null;
    if (filter === "") {
      decoded = raw;                                   // 未压缩
    } else {
      try { decoded = inflateSync(raw); } catch { try { decoded = inflateRawSync(raw); } catch { decoded = null; } }
    }
    if (!decoded) { skipped += 1; continue; }
    /* ⚠️ CMap 流（ToUnicode）**不是内容流**：它自己就含 `<0041> <4F60>` 这种 hex 串，
       当内容流解会被"应用映射"后凭空产出一段文本（实测：同一句话被交付两次）。
       判据取 CMap 的三个固定语法标记（`begincmap` / `beginbfchar` / `beginbfrange`）——
       精简过的 CMap 常常省掉 `begincmap`，只认它就会漏（实测踩到）。 */
    const asLatin = latin1(decoded);
    if (/begincmap|beginbfchar|beginbfrange/.test(asLatin)) { continue; }
    streams.push(asLatin);
  }

  if (streams.length === 0) {
    throw new Error(skipped > 0
      ? `PDF 的 ${skipped} 条内容流用了不支持的压缩方式（仅支持未压缩与 FlateDecode），读不出文本。`
      : "PDF 里没有找到任何内容流（可能是扫描件/纯图片 PDF）—— 这类需要 OCR，当前不支持。");
  }

  const chunks = streams.map((s) => textFromContentStream(s, cmap, needCmap)).filter((t) => t.trim().length > 0);
  if (chunks.length === 0) {
    throw new Error("PDF 的内容流里没有直接可读的文本（可能是扫描件、或文本全在图像里）。");
  }

  const joined = sniffUtf8(chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim());

  /* 乱码兜底（**这条是"宁可报读不了，也不给乱码"的落实**）：
     控制字符占比过高 ⇒ 说明拿到的是编码字节而不是可读文本（典型：缺 ToUnicode 的 CID 文本、
     或误把二进制当内容流）。任何"看起来不像文本"的输出都必须在这里被拦下。 */
  const ctrl = (joined.match(/[\u0000-\u0008\u000b\u000e-\u001f\ufffd]/g) ?? []).length;
  if (joined.length > 0 && ctrl / joined.length > 0.05) {
    throw new Error(
      "PDF 的文本大多是编码字节（很可能使用了 CID 字体且缺少 ToUnicode 映射），无法准确解码；"
      + "请改用截图，或在阅读器里复制文本后粘贴给我。",
    );
  }

  info.push(`pdf：扫描到 ${streams.length} 条内容流${skipped > 0 ? `，跳过 ${skipped} 条（压缩方式不支持）` : ""}`);
  if (needCmap && cmap.size === 0) {
    info.push("pdf：检测到 CID 字体但没有 ToUnicode 映射 —— 非 ASCII 文本可能不准");
  } else if (cmap.size > 0) {
    info.push(`pdf：应用了 ${cmap.size} 条 ToUnicode 映射（多字体冲突时局部可能不准）`);
  }
  info.push("pdf：文本按内容流出现顺序输出，多页文档的页序可能与原文不同");

  const truncated = joined.length > maxChars;
  return { text: truncated ? joined.slice(0, maxChars) : joined, info, truncated };
}
