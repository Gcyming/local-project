

























export interface ToolEvent {
  id: number;
  
  name: string;
  
  label: string;
  
  detail?: string;
  
  result?: string;
  




  toolId?: string;
}



































const NEUTRAL_PREFIX_RE = /^\[(已委派|提示|成功|完成|已发送|已创建|已更新|已删除|已保存|已记忆|已记录)\]/i;


const FAIL_PREFIX_RE = /^(\[错误\]|\[失败\]|💥|❌|✕|错误|失败|拒绝|未找到|no such|not found|error|failed|denied|exception)/i;














const FAIL_INLINE_RE = /(超时中断|已中断|执行超时|调用超时|被硬规则拒绝|安全拦截|Traceback \(most recent call last\)|执行失败|调用失败|请求失败|任务失败)/;

export function isToolFailResult(text: string | undefined): boolean {
  const r = (text ?? "").trim();
  if (r.length === 0) { return false; }
  
  if (NEUTRAL_PREFIX_RE.test(r)) { return false; }
  if (FAIL_PREFIX_RE.test(r)) { return true; }
  return FAIL_INLINE_RE.test(r.slice(0, 400));
}


export type ProductKind = "write" | "read";
export interface ProductItem {
  rel: string;
  name: string;
  kind: ProductKind;
  ext: string;
  
  diff?: { add: number; del: number };
  
  diffFull?: { old: string; new: string };
  







  diffTrimmed?: boolean;
}












function b64ToText(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) { bytes[i] = bin.charCodeAt(i); }
    return new TextDecoder("utf-8").decode(bytes);
  } catch { return ""; }
}










export function stripDiffTag(raw: string | undefined): string {
  if (!raw || !raw.includes("__slime_diff__")) { return raw ?? ""; }
  return raw
    .replace(/\[__slime_diff__\][\s\S]*?\[\/__slime_diff__\]/g, "")
    .replace(/\[__slime_diff__\][\s\S]*$/g, "")
    .replace(/\[\/__slime_diff__\]/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}



















export function parseDiffStat(result: string | undefined): { add: number; del: number } | null {
  if (!result) { return null; }
  
  
  
  const m = /\[__slime_diff__\]([A-Za-z0-9+/=]*)\|([A-Za-z0-9+/=]*)\[\/__slime_diff__\]/.exec(result);
  if (!m) { return null; }
  const oldTxt = b64ToText(m[1]);
  const newTxt = b64ToText(m[2]);
  if (!oldTxt && !newTxt) { return null; }
  const oldLines = new Set(oldTxt.split("\n"));
  const newLines = new Set(newTxt.split("\n"));
  let add = 0, del = 0;
  for (const l of newLines) { if (l && !oldLines.has(l)) { add += 1; } }
  for (const l of oldLines) { if (l && !newLines.has(l)) { del += 1; } }
  
  return add > 0 || del > 0 ? { add, del } : null;
}













export const DIFF_FULL_MAX_RENDER = 400000;










export const PRODUCT_DIFF_PERSIST_MAX = 120000;








export function slimProductsForPersist(products: ProductItem[]): ProductItem[] {
  return products.map((p) => {
    if (!p.diffFull) { return p; }
    if (p.diffFull.old.length + p.diffFull.new.length <= PRODUCT_DIFF_PERSIST_MAX) { return p; }
    const { diffFull: _drop, ...rest } = p;
    return { ...rest, diffTrimmed: true };
  });
}

















export type DiffNotice = "too-large" | "trimmed" | null;

export function diffNoticeKind(
  diff: { add: number; del: number } | null | undefined,
  hasFullText: boolean,
  trimmed: boolean,
): DiffNotice {
  if (hasFullText) { return null; }
  if (trimmed) { return "trimmed"; }
  if (diff) { return "too-large"; }
  return null;
}







export function parseDiffFull(result: string | undefined, maxChars = DIFF_FULL_MAX_RENDER): { old: string; new: string } | null {
  if (!result) { return null; }
  
  
  const m = /\[__slime_diff__\]([A-Za-z0-9+/=]*)\|([A-Za-z0-9+/=]*)\[\/__slime_diff__\]/.exec(result);
  if (!m) { return null; }
  const oldTxt = b64ToText(m[1]);
  const newTxt = b64ToText(m[2]);
  if (!oldTxt && !newTxt) { return null; }
  if (oldTxt.length + newTxt.length > maxChars) { return null; }
  return { old: oldTxt, new: newTxt };
}



export function diffLines(oldTxt: string, newTxt: string): Array<{ type: "eq" | "add" | "del"; text: string }> {
  const a = oldTxt ? oldTxt.split("\n") : [];
  const b = newTxt ? newTxt.split("\n") : [];
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ type: "eq" | "add" | "del"; text: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "eq", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++; }
    else { out.push({ type: "add", text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: "del", text: a[i] }); i++; }
  while (j < m) { out.push({ type: "add", text: b[j] }); j++; }
  return out;
}





export function extractProducts(events: ToolEvent[]): ProductItem[] {
  const out: ProductItem[] = [];
  const wrote = new Set<string>();
  const reads: Array<{ rel: string; name: string; ext: string }> = [];
  const base = (rel: string): string => (rel.split(/[\\/]/).pop() ?? rel);
  const extOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "");
  for (const t of events) {
    if (t.name !== "file_write" && t.name !== "file_read") { continue; }
    const rel = (t.detail ?? "").trim();
    if (!rel || /^https?:\/\//i.test(rel)) { continue; }
    const name = base(rel);
    const ext = extOf(name);
    if (t.name === "file_write") {
      if (wrote.has(rel)) { continue; }
      wrote.add(rel);
      const diff = parseDiffStat(t.result);
      const diffFull = parseDiffFull(t.result);
      out.push(diff
        ? diffFull
          ? { rel, name, kind: "write", ext, diff, diffFull }
          : { rel, name, kind: "write", ext, diff }
        : { rel, name, kind: "write", ext });
    } else {
      reads.push({ rel, name, ext });
    }
  }
  for (const r of reads) {
    if (wrote.has(r.rel)) { continue; } 
    wrote.add(r.rel);
    out.push({ ...r, kind: "read" });
  }
  return out;
}




export interface SessionFileDiff {
  old: string;
  new: string;
  trimmed: boolean;
  
  name: string;
}

const norm = (p: string): string => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
















export function findSessionFileDiff(
  byOrdinal: Record<string, ProductItem[]> | null | undefined,
  file: string,
): SessionFileDiff | null {
  const want = norm(file);
  if (!want || !byOrdinal) { return null; }
  const keys = Object.keys(byOrdinal).sort((a, b) => Number(b) - Number(a));  
  for (const k of keys) {
    const list = Array.isArray(byOrdinal[k]) ? byOrdinal[k] : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {          
      const p = list[i];
      if (!p) { continue; }
      if (p.kind !== "write") { continue; }
      if (norm(p.rel) !== want && norm(p.name) !== want) { continue; }
      if (p.diffFull) { return { old: p.diffFull.old, new: p.diffFull.new, trimmed: false, name: p.name }; }
      if (p.diffTrimmed) { return { old: "", new: "", trimmed: true, name: p.name }; }
    }
  }
  return null;
}
