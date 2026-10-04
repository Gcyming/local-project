


























import { inflateRawSync, inflateSync } from "node:zlib";

export interface PdfExtractResult {
  text: string;
  
  info: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 200_000;


export function isPdf(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString("latin1");
  return head.includes("%PDF-");
}


function latin1(buf: Buffer): string {
  return buf.toString("latin1");
}


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
    if (n === "\n") { i += 1; continue; }                 
    if (n === "\r") { i += s[i + 2] === "\n" ? 2 : 1; continue; }
    if (n >= "0" && n <= "7") {                            
      let oct = "";
      let k = i + 1;
      while (k < s.length && oct.length < 3 && s[k] >= "0" && s[k] <= "7") { oct += s[k]; k += 1; }
      out += String.fromCharCode(parseInt(oct, 8));
      i = k - 1;
      continue;
    }
    out += n; i += 1;                                      
  }
  return out;
}


function hexToBytes(hex: string): Buffer {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const out = Buffer.alloc(padded.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}












function collectToUnicodeMap(doc: string): Map<number, string> {
  const map = new Map<number, string>();
  



  for (const blk of doc.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const src = parseInt(pair[1], 16);
      const bytes = hexToBytes(pair[2]);
      if (bytes.length === 0 || bytes.length % 2 !== 0) { continue; }
      map.set(src, Buffer.from(bytes).swap16().toString("utf16le").replace(/\uFEFF/g, ""));
    }
  }
  
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


function looksLikeCidFont(doc: string): boolean {
  return /\/Subtype\s*\/Type0|Identity-H/.test(doc);
}





function textFromContentStream(content: string, cmap: Map<number, string>, needCmap: boolean): string {
  let out = "";
  let pending = "";
  let i = 0;
  const pushBreak = (): void => { if (pending && !pending.endsWith("\n")) { pending += "\n"; } };

  while (i < content.length) {
    const c = content[i];

    
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

    
    if (c === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i + 1);
      if (end < 0) { break; }
      const bytes = hexToBytes(content.slice(i + 1, end));
      if (needCmap && cmap.size > 0 && bytes.length % 2 === 0) {
        
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

    
    if (content.startsWith("Tj", i) || content.startsWith("TJ", i)) { i += 2; continue; }
    if (c === "'") { pushBreak(); i += 1; continue; }
    if (c === "\"") { pushBreak(); i += 1; continue; }

    
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










function sniffUtf8(latin: string): string {
  if (!/[\u0080-\u00ff]/.test(latin)) { return latin; }   
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(latin, "latin1"));
  } catch {
    return latin;
  }
}





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

  



  const streams: string[] = [];
  let skipped = 0;
  


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
      decoded = raw;                                   
    } else {
      try { decoded = inflateSync(raw); } catch { try { decoded = inflateRawSync(raw); } catch { decoded = null; } }
    }
    if (!decoded) { skipped += 1; continue; }
    



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
