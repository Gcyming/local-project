
























































export interface IndexOptions {
  
  k1: number;
  
  b: number;
  
  titleBoost: number;
  
  wholeWordMaxLen: number;
  
  minTermLen: number;
  
  stopwords: string[];
  





  







  fuzzyMaxEdits: number;
  






  fuzzyMinTermLen: number;
  
  fuzzyMaxExpansions: number;
}


export const DEFAULT_INDEX_OPTIONS: IndexOptions = {
  k1: 1.5,
  b: 0.75,
  titleBoost: 3.0,
  wholeWordMaxLen: 4,
  minTermLen: 1,
  stopwords: [],
  


  fuzzyMaxEdits: 2,
  fuzzyMinTermLen: 3,
  fuzzyMaxExpansions: 50,
};












export function clampIndexOptions(raw: unknown): IndexOptions {
  const o = (raw ?? {}) as Partial<IndexOptions>;
  const num = (v: unknown, d: number, lo: number, hi: number): number => {
    const n = Number(v);
    if (v === undefined || v === null || v === "" || !Number.isFinite(n)) { return d; }
    return Math.min(hi, Math.max(lo, n));
  };
  const words = Array.isArray(o.stopwords)
    ? [...new Set(
      o.stopwords
        .map((s) => String(s ?? "").trim().toLowerCase())
        .filter((s) => s.length > 0 && s.length <= 20),
    )].slice(0, 200)
    : [];
  return {
    k1: num(o.k1, DEFAULT_INDEX_OPTIONS.k1, 0, 3),
    b: num(o.b, DEFAULT_INDEX_OPTIONS.b, 0, 1),
    titleBoost: num(o.titleBoost, DEFAULT_INDEX_OPTIONS.titleBoost, 0, 10),
    wholeWordMaxLen: Math.floor(num(o.wholeWordMaxLen, DEFAULT_INDEX_OPTIONS.wholeWordMaxLen, 0, 8)),
    minTermLen: Math.floor(num(o.minTermLen, DEFAULT_INDEX_OPTIONS.minTermLen, 1, 5)),
    stopwords: words,
    

    fuzzyMaxEdits: Math.floor(num(o.fuzzyMaxEdits, DEFAULT_INDEX_OPTIONS.fuzzyMaxEdits, 0, 2)),
    fuzzyMinTermLen: Math.floor(num(o.fuzzyMinTermLen, DEFAULT_INDEX_OPTIONS.fuzzyMinTermLen, 1, 8)),
    fuzzyMaxExpansions: Math.floor(num(o.fuzzyMaxExpansions, DEFAULT_INDEX_OPTIONS.fuzzyMaxExpansions, 1, 200)),
  };
}


export const SEARCH_ENGINE_NAME = "Slime 自建全网索引";


export const SEARCH_ITEM_SOURCE = "自建索引";


const TOKEN_RE = /[a-z0-9]+|[㐀-䶿一-鿿豈-﫿]+/g;


export interface IndexedPage {
  id: number;
  url: string;
  title: string;
  text: string;
}


export interface SearchIndex {
  



  opts: IndexOptions;
  
  docs: number;
  
  avdl: number;
  
  df: Record<string, number>;
  
  postings: Record<string, { doc: number; tf: number; titleTf: number }[]>;
  
  docLen: Record<string, number>;
}


export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  score: number;
  source: string;
}


function stopSetOf(opts: IndexOptions): Set<string> {
  const list = opts.stopwords ?? [];
  return list.length === 0 ? EMPTY_STOP : new Set(list.map((s) => s.toLowerCase()));
}

const EMPTY_STOP: Set<string> = new Set();







export function tokenize(text: string, opts: IndexOptions = DEFAULT_INDEX_OPTIONS): string[] {
  const out: string[] = [];
  const s = String(text ?? "").toLowerCase();
  const stop = stopSetOf(opts);
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(s); m !== null; m = TOKEN_RE.exec(s)) {
    const w = m[0];
    if (w.charCodeAt(0) < 0x2e80) {
      
      if (w.length >= opts.minTermLen && !stop.has(w)) { out.push(w); }
      continue;
    }
    if (w.length === 1) { if (!stop.has(w)) { out.push(w); } continue; }
    for (let i = 0; i < w.length - 1; i += 1) {
      const t = w.slice(i, i + 2);
      if (!stop.has(t)) { out.push(t); }
    }
    if (w.length <= opts.wholeWordMaxLen && !stop.has(w)) { out.push(w); }
  }
  return out;
}


export function queryTerms(query: string, opts: IndexOptions = DEFAULT_INDEX_OPTIONS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(query, opts)) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}















export interface ParsedQuery {
  
  terms: string[];
  
  phrases: string[];
  
  excludes: string[];
  
  site: string | null;
}


export function parseQuery(raw: string, opts: IndexOptions = DEFAULT_INDEX_OPTIONS): ParsedQuery {
  const phrases: string[] = [];
  const excludes: string[] = [];
  let site: string | null = null;

  
  const rest = String(raw ?? "").replace(/"([^"]*)"/g, (_m, p: string) => {
    const t = String(p).trim().toLowerCase();
    if (t) { phrases.push(t); }
    return " ";
  });

  const words: string[] = [];
  for (const w of rest.split(/\s+/)) {
    if (!w) { continue; }
    const low = w.toLowerCase();
    if (low.startsWith("site:") && low.length > "site:".length) {
      site = low.slice("site:".length).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
      continue;
    }
    if (low.startsWith("-") && low.length > 1) { excludes.push(low.slice(1)); continue; }
    words.push(w);
  }

  return { terms: queryTerms(words.join(" "), opts), phrases, excludes, site };
}


function hostOfUrl(url: string): string {
  try { return new URL(url).host.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}


function siteMatches(url: string, site: string): boolean {
  const h = hostOfUrl(url);
  return h === site || h.endsWith("." + site);
}


function passesFilters(url: string, title: string, text: string, q: ParsedQuery): boolean {
  if (q.site && !siteMatches(url, q.site)) { return false; }
  const lowText = String(text ?? "").toLowerCase();
  const lowTitle = String(title ?? "").toLowerCase();
  for (const ph of q.phrases) {
    if (!lowText.includes(ph) && !lowTitle.includes(ph)) { return false; }
  }
  for (const ex of q.excludes) {
    if (lowText.includes(ex) || lowTitle.includes(ex)) { return false; }
  }
  return true;
}










export function editDistance(a: string, b: string, max: number): number {
  if (a === b) { return 0; }
  if (Math.abs(a.length - b.length) > max) { return max + 1; }
  const n = b.length;
  let prev2: number[] | null = null;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1
        && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
        && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur.push(v);
      if (v < rowMin) { rowMin = v; }
    }
    if (rowMin > max) { return max + 1; }
    prev2 = prev;
    prev = cur;
  }
  return prev[n] > max ? max + 1 : prev[n];
}


export interface TermExpansion {
  
  from: string;
  
  to: string;
  
  edits: number;
}


export interface QueryPlan {
  effective: string[];
  
  src: Map<string, string>;
  
  weight: Map<string, number>;
  expansions: TermExpansion[];
}

















export function expandQueryTerms(
  index: SearchIndex,
  terms: string[],
  opts: IndexOptions = DEFAULT_INDEX_OPTIONS,
): QueryPlan {
  const effective: string[] = [];
  const src = new Map<string, string>();
  const weight = new Map<string, number>();
  const expansions: TermExpansion[] = [];
  const maxEdits = Math.max(0, Math.min(2, Math.floor(opts.fuzzyMaxEdits ?? 0)));
  const minLen = Math.max(1, Math.floor(opts.fuzzyMinTermLen ?? 3));
  const maxExp = Math.max(1, Math.floor(opts.fuzzyMaxExpansions ?? 50));

  const push = (term: string, from: string, w: number): void => {
    effective.push(term);
    src.set(term, from);
    weight.set(term, w);
  };

  
  let dict: string[] | null = null;

  for (const t of terms) {
    if (index.df[t] !== undefined) { push(t, t, 1); continue; }
    if (maxEdits <= 0 || t.length < minLen) { continue; }  
    if (dict === null) { dict = Object.keys(index.df); }
    const cands: TermExpansion[] = [];
    for (const c of dict) {
      const d = editDistance(t, c, maxEdits);
      if (d >= 1 && d <= maxEdits) { cands.push({ from: t, to: c, edits: d }); }
    }
    
    cands.sort((x, y) => x.edits - y.edits
      || (index.df[y.to] ?? 0) - (index.df[x.to] ?? 0)
      || (x.to < y.to ? -1 : x.to > y.to ? 1 : 0));
    for (const c of cands.slice(0, maxExp)) {
      if (src.has(c.to)) { continue; }   
      push(c.to, t, 1 - c.edits / Math.max(t.length, c.to.length));
      expansions.push(c);
    }
  }
  return { effective, src, weight, expansions };
}








export function contentFingerprint(title: string, text: string): string {
  const s = (String(title ?? "") + "\u0000" + String(text ?? "").slice(0, 4000)).replace(/\s+/g, " ");
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}







export function buildIndex(pages: IndexedPage[], opts: IndexOptions = DEFAULT_INDEX_OPTIONS): SearchIndex {
  const df: Record<string, number> = {};
  const postings: Record<string, { doc: number; tf: number; titleTf: number }[]> = {};
  const docLen: Record<string, number> = {};
  let totalLen = 0;

  for (const p of pages) {
    const bodyTf = new Map<string, number>();
    for (const t of tokenize(p.text, opts)) { bodyTf.set(t, (bodyTf.get(t) ?? 0) + 1); }
    const titleTf = new Map<string, number>();
    for (const t of tokenize(p.title, opts)) { titleTf.set(t, (titleTf.get(t) ?? 0) + 1); }

    const len = countTokens(bodyTf) + countTokens(titleTf);
    docLen[String(p.id)] = len;
    totalLen += len;

    for (const t of new Set([...bodyTf.keys(), ...titleTf.keys()])) {
      const chain = postings[t] ?? (postings[t] = []);
      chain.push({ doc: p.id, tf: bodyTf.get(t) ?? 0, titleTf: titleTf.get(t) ?? 0 });
      df[t] = chain.length;
    }
  }

  return { opts, docs: pages.length, avdl: pages.length ? totalLen / pages.length : 0, df, postings, docLen };
}

function countTokens(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) { n += v; }
  return n;
}


function idfOf(index: SearchIndex, df: number): number {
  return Math.log(1 + (index.docs - df + 0.5) / (df + 0.5));
}






export function searchIndex(
  index: SearchIndex,
  byId: Map<number, IndexedPage> | Record<string, IndexedPage>,
  query: string,
  page = 0,
  size = 10,
): { total: number; items: SearchHit[]; terms: string[]; expansions: TermExpansion[] } {
  

  const o = index.opts ?? DEFAULT_INDEX_OPTIONS;
  const q = parseQuery(query, o);
  const terms = q.terms;
  

  const plan = expandQueryTerms(index, terms, o);
  const empty = { total: 0, items: [] as SearchHit[], terms, expansions: [] as TermExpansion[] };
  if (index.docs === 0) { return empty; }

  const lookup = (doc: number): IndexedPage | undefined =>
    (byId instanceof Map ? byId.get(doc) : byId[String(doc)]);
  const hasFilters = q.phrases.length > 0 || q.excludes.length > 0 || q.site !== null;

  
  const slice = (ordered: [number, number][]): { total: number; items: SearchHit[]; terms: string[]; expansions: TermExpansion[] } => {
    const items: SearchHit[] = [];
    for (const [doc, score] of ordered.slice(page * size, page * size + size)) {
      const pg = lookup(doc);
      if (!pg) { continue; }
      items.push({
        url: pg.url,
        title: pg.title || pg.url,
        

        snippet: makeSnippet(pg.text, [...terms, ...q.phrases]),
        score: Math.round(score * 1000) / 1000,
        source: SEARCH_ITEM_SOURCE,
      });
    }
    return { total: ordered.length, items, terms, expansions: plan.expansions };
  };

  


  if (terms.length === 0) {
    if (!hasFilters) { return empty; }
    const all: [number, number][] = [];
    const each = byId instanceof Map ? [...byId.values()] : Object.values(byId);
    for (const p of each) {
      if (p && passesFilters(p.url, p.title, p.text, q)) { all.push([p.id, 0]); }
    }
    all.sort((a, b) => b[0] - a[0]);
    return slice(all);
  }

  const scores = new Map<number, number>();
  

  const hitTerms = new Map<number, Set<string>>();
  
  const srcHitCount = (doc: number): number => {
    const s = hitTerms.get(doc);
    if (!s) { return 0; }
    const uniq = new Set<string>();
    for (const t of s) { uniq.add(plan.src.get(t) ?? t); }
    return uniq.size;
  };

  



  for (const t of plan.effective) {
    const df = index.df[t];
    if (df === undefined) { continue; }
    const idf = idfOf(index, df);
    for (const p of index.postings[t] ?? []) {
      const effTf = p.tf + o.titleBoost * p.titleTf;
      if (effTf <= 0) { continue; }
      const denom = effTf + o.k1 * (1 - o.b + o.b * 1);
      scores.set(p.doc, (scores.get(p.doc) ?? 0) + (idf * (effTf * (o.k1 + 1))) / denom);
      const s = hitTerms.get(p.doc) ?? new Set<string>();
      s.add(t);
      hitTerms.set(p.doc, s);
    }
  }
  if (scores.size === 0) { return empty; }

  
  for (const [doc] of scores) {
    const pg = lookup(doc);
    if (!pg) { continue; }
    const docLen = (index.docLen[String(doc)] ?? 0) || 1;
    const avdl = index.avdl || 1;
    let s = 0;
    for (const t of hitTerms.get(doc) ?? []) {
      const df = index.df[t];
      if (df === undefined) { continue; }
      const pr = (index.postings[t] ?? []).find((x) => x.doc === doc);
      if (!pr) { continue; }
      const effTf = pr.tf + o.titleBoost * pr.titleTf;
      const denom = effTf + o.k1 * (1 - o.b + (o.b * docLen) / avdl);
      s += (idfOf(index, df) * (effTf * (o.k1 + 1))) / denom * (plan.weight.get(t) ?? 1);
    }
    scores.set(doc, s);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  


  const eligible = hasFilters
    ? ranked.filter(([doc]) => {
      const pg = lookup(doc);
      return !!pg && passesFilters(pg.url, pg.title, pg.text, q);
    })
    : ranked;
  const full = eligible.filter(([doc]) => srcHitCount(doc) === terms.length);
  const need = page * size + size;
  const ordered = full.length >= 1
    ? (full.length < need ? [...full, ...eligible.filter((kv) => !full.includes(kv))] : full)
    : eligible;

  return slice(ordered);
}





export function makeSnippet(text: string, terms: string[], width = 90): string {
  if (!text) { return ""; }
  const low = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = low.indexOf(t.toLowerCase());
    if (i >= 0 && (idx < 0 || i < idx)) { idx = i; }
  }
  if (idx < 0) { return text.slice(0, width * 2); }
  const start = Math.max(0, idx - Math.floor(width / 2));
  const end = Math.min(text.length, idx + Math.floor((width * 3) / 2));
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}


export function indexStats(index: SearchIndex): { pages: number; terms: number } {
  return { pages: index.docs, terms: Object.keys(index.df).length };
}


export function emptyIndex(opts: IndexOptions = DEFAULT_INDEX_OPTIONS): SearchIndex {
  return { opts, docs: 0, avdl: 0, df: {}, postings: {}, docLen: {} };
}
