/**
 * core-ts/src/text/encoding.ts — 「把一段字节按**正确**的编码解成字符串」的**唯一产地**。
 *
 * ══ 为什么需要一个共用产地 ══════════════════════════════════════════════════
 * 同一类 bug 在本项目里出现过**两次**，形态完全不同但根因是同一个：
 *   ① 内置终端：`exec()` 在中文 Windows 上拿到的是 **CP936(GBK)** 字节，而 Node 默认
 *      按 UTF-8 解 ⇒ 中文变成 `������`（用户实测截图，红色乱码）；
 *   ② 自建索引的爬虫：`Buffer.toString("utf8")` 抓 GBK 网页 ⇒ 整页正文变乱码入库。
 * 两处各写一遍"猜编码"必然会漂（改了一处忘了另一处），所以收归到这里。
 *
 * ══ 判据：先严格试 UTF-8，失败再退 ══════════════════════════════════════════
 * `TextDecoder("utf-8", { fatal: true })` 在遇到非法 UTF-8 序列时**抛异常**，
 * 而在合法 UTF-8 上从不抛 —— 这正好是一个**免费的、不需要启发式的**判别器：
 *   · 合法 UTF-8（含纯 ASCII） ⇒ 就是 UTF-8，直接返回，**绝不误判**；
 *   · 抛错 ⇒ 一定不是 UTF-8 ⇒ 按调用方给的候选顺序退（爬虫用页面自己声明的 charset，
 *     终端用 GB18030 —— 简体中文 Windows 的控制台代码页 CP936 是 GBK，而 GB18030 是它的
 *     超集，能覆盖 GBK 的全部字节，且对 GBK 字节解出的汉字与 GBK 完全一致）。
 *
 * ⚠️ **为什么不干脆全用 GB18030**：GB18030 几乎能"解开"任意字节序列（很少抛错），
 *   所以它**不能**当判别器，只能当兜底。把它排在 UTF-8 前面会把正常 UTF-8 页面解成乱码。
 *
 * ⚠️ `loose` 字段的意义：它是"**我们没能确认**这段字节是什么编码，只是退到了兜底"的标记。
 *   调用方必须把它当成"需要让用户知道"的信号（铁律 31：降级可以，但降级要看得见），
 *   而不是悄悄吞掉 —— 否则下次再出乱码，还是没人知道为什么。
 *
 * ⚠️ 本模块**零依赖**（只用内建 `TextDecoder`），因为它被 core-ts 的纯逻辑层引用；
 *   `TextDecoder` 的多编码支持依赖 **full-icu**，Node 官方发行版与 Electron 都自带，
 *   但若某个精简运行时把它裁掉了，构造函数会抛 —— 见 `supportsEncoding` 的兜底。
 */

/** 默认兜底候选（按顺序试）。GB18030 放最后（它是 GBK 的超集，且几乎不会抛错）。 */
export const DEFAULT_FALLBACKS: readonly string[] = ["gb18030"];

export interface DecodeResult {
  /** 解出来的文本。 */
  text: string;
  /** 实际使用的编码名（小写）。 */
  encoding: string;
  /**
   * `true` = 没能在候选里确认编码，用的是兜底解码（或全部失败后的"尽力而为"）。
   * 调用方应把这种情况**显式告知用户**，不要静默。
   */
  loose: boolean;
}

/** BOM → 编码名（有 BOM 时它是**权威**判据，不需要猜）。 */
function bomEncoding(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { return "utf-8"; }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { return "utf-16le"; }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { return "utf-16be"; }
  return null;
}

/** 该运行时认不认这个编码名（认不出时 `TextDecoder` 构造会抛）。 */
export function supportsEncoding(name: string): boolean {
  try { new TextDecoder(name); return true; } catch { return false; }
}

/** 严格解码（合法才返回；有任何非法序列 ⇒ `null`）。 */
function strictDecode(buf: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * 把字节按正确编码解成字符串。
 *
 * @param buf       原始字节
 * @param fallbacks 兜底候选（默认 `["gb18030"]`；爬虫会传页面声明的 charset 在前）
 */
export function decodeBytes(buf: Uint8Array, fallbacks: readonly string[] = DEFAULT_FALLBACKS): DecodeResult {
  if (!buf || buf.length === 0) { return { text: "", encoding: "utf-8", loose: false }; }

  /* ① BOM 是权威判据：有就照它解，不看别的。 */
  const bom = bomEncoding(buf);
  if (bom) {
    try {
      return { text: new TextDecoder(bom).decode(buf), encoding: bom, loose: false };
    } catch { /* 运行时缺这个编码 ⇒ 落到下面的常规路径 */ }
  }

  /* ② 严格试 UTF-8：不抛就是 UTF-8，**不误判**。 */
  const utf8 = strictDecode(buf, "utf-8");
  if (utf8 !== null) { return { text: utf8, encoding: "utf-8", loose: false }; }

  /* ③ 依次试候选：只用**非 fatal** 解码（候选是兜底，不要求它严格合法），
        但记 `loose = true` —— 我们没能确认，只是"退到了它"。 */
  for (const name of fallbacks) {
    const enc = String(name ?? "").toLowerCase().trim();
    if (!enc || enc === "utf-8") { continue; }
    if (!supportsEncoding(enc)) { continue; }
    return { text: new TextDecoder(enc).decode(buf), encoding: enc, loose: true };
  }

  /* ④ 连兜底都不可用（精简运行时）：尽力而为 + **明确标记 loose**。 */
  return { text: new TextDecoder("utf-8").decode(buf), encoding: "utf-8", loose: true };
}

/** HTML 里声明的字符集（`<meta charset>` 优先于 `http-equiv`）。取不到 ⇒ `null`。 */
export function charsetFromHtml(html: string): string | null {
  const head = String(html ?? "").slice(0, 4096); // charset 一定在 head 里
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-]+)/i.exec(head)?.[1];
  if (direct) { return normalizeCharset(direct); }
  const equiv = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_\-]+)/i.exec(head)?.[1];
  return equiv ? normalizeCharset(equiv) : null;
}

/** 别名归一（`gb2312`/`gbk` 一律当 `gb18030`：后者是前两者的超集，解同一段字节结果一致）。 */
export function normalizeCharset(name: string): string {
  const c = String(name ?? "").toLowerCase().trim();
  if (c === "gb2312" || c === "gbk" || c === "gb18030" || c === "x-gbk") { return "gb18030"; }
  if (c === "utf8" || c === "utf-8") { return "utf-8"; }
  if (c === "big5" || c === "big-5" || c === "cp950") { return "big5"; }
  if (c === "latin1" || c === "iso-8859-1" || c === "windows-1252") { return "windows-1252"; }
  return c;
}

/**
 * 解一段**网页正文**的字节：优先用页面自己声明的 charset，其次严格 UTF-8，最后 GB18030。
 *
 * ⚠️ 为什么先做一次"探测性解码"：charset 声明在 HTML 字节**里面**，
 *   所以必须先用某个编码把它解出来才能读到 → 只有纯 ASCII 的 `<meta>` 部分不会因编码而变
 *   （`<meta charset="gbk">` 本身是 ASCII），这一步是安全的，不会因为先解错而读不到声明。
 */
export function decodeHtmlBytes(buf: Uint8Array): DecodeResult {
  const head = new TextDecoder("utf-8").decode(buf.subarray(0, Math.min(buf.length, 4096)));
  const declared = charsetFromHtml(head);
  if (declared && declared !== "utf-8" && supportsEncoding(declared)) {
    // 页面自己说了用别的编码 ⇒ 它比我们的启发式权威
    const r = strictDecode(buf, declared);
    if (r !== null) { return { text: r, encoding: declared, loose: false }; }
    return { text: new TextDecoder(declared).decode(buf), encoding: declared, loose: false };
  }
  return decodeBytes(buf);
}
