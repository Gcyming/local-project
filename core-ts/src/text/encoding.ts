






























export const DEFAULT_FALLBACKS: readonly string[] = ["gb18030"];

export interface DecodeResult {
  
  text: string;
  
  encoding: string;
  



  loose: boolean;
}


function bomEncoding(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { return "utf-8"; }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { return "utf-16le"; }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { return "utf-16be"; }
  return null;
}


export function supportsEncoding(name: string): boolean {
  try { new TextDecoder(name); return true; } catch { return false; }
}


function strictDecode(buf: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}







export function decodeBytes(buf: Uint8Array, fallbacks: readonly string[] = DEFAULT_FALLBACKS): DecodeResult {
  if (!buf || buf.length === 0) { return { text: "", encoding: "utf-8", loose: false }; }

  
  const bom = bomEncoding(buf);
  if (bom) {
    try {
      return { text: new TextDecoder(bom).decode(buf), encoding: bom, loose: false };
    } catch {  }
  }

  
  const utf8 = strictDecode(buf, "utf-8");
  if (utf8 !== null) { return { text: utf8, encoding: "utf-8", loose: false }; }

  

  for (const name of fallbacks) {
    const enc = String(name ?? "").toLowerCase().trim();
    if (!enc || enc === "utf-8") { continue; }
    if (!supportsEncoding(enc)) { continue; }
    return { text: new TextDecoder(enc).decode(buf), encoding: enc, loose: true };
  }

  
  return { text: new TextDecoder("utf-8").decode(buf), encoding: "utf-8", loose: true };
}


export function charsetFromHtml(html: string): string | null {
  const head = String(html ?? "").slice(0, 4096); 
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-]+)/i.exec(head)?.[1];
  if (direct) { return normalizeCharset(direct); }
  const equiv = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_\-]+)/i.exec(head)?.[1];
  return equiv ? normalizeCharset(equiv) : null;
}


export function normalizeCharset(name: string): string {
  const c = String(name ?? "").toLowerCase().trim();
  if (c === "gb2312" || c === "gbk" || c === "gb18030" || c === "x-gbk") { return "gb18030"; }
  if (c === "utf8" || c === "utf-8") { return "utf-8"; }
  if (c === "big5" || c === "big-5" || c === "cp950") { return "big5"; }
  if (c === "latin1" || c === "iso-8859-1" || c === "windows-1252") { return "windows-1252"; }
  return c;
}








export function decodeHtmlBytes(buf: Uint8Array): DecodeResult {
  const head = new TextDecoder("utf-8").decode(buf.subarray(0, Math.min(buf.length, 4096)));
  const declared = charsetFromHtml(head);
  if (declared && declared !== "utf-8" && supportsEncoding(declared)) {
    
    const r = strictDecode(buf, declared);
    if (r !== null) { return { text: r, encoding: declared, loose: false }; }
    return { text: new TextDecoder(declared).decode(buf), encoding: declared, loose: false };
  }
  return decodeBytes(buf);
}
