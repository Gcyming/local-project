


































import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";


export interface CrawlOpts {
  maxPages?: number;
  maxDepth?: number;
  delay?: number;
  sameDomain?: boolean;
  respectRobots?: boolean;
}


export interface IndexParams {
  index: {
    k1: number; b: number; titleBoost: number; wholeWordMaxLen: number; minTermLen: number; stopwords: string[];
    
    fuzzyMaxEdits: number; fuzzyMinTermLen: number; fuzzyMaxExpansions: number;
  };
  body: { minBodyChars: number; maxBodyChars: number };
}








interface ParamsForm {
  wholeWordMaxLen: string;
  minTermLen: string;
  stopwords: string;
  minBodyChars: string;
  maxBodyChars: string;
  k1: string;
  b: string;
  titleBoost: string;
  
  fuzzyMaxEdits: string;
  fuzzyMinTermLen: string;
  fuzzyMaxExpansions: string;
}


function toForm(p: IndexParams): ParamsForm {
  return {
    wholeWordMaxLen: String(p.index.wholeWordMaxLen),
    minTermLen: String(p.index.minTermLen),
    stopwords: p.index.stopwords.join(" "),
    minBodyChars: String(p.body.minBodyChars),
    maxBodyChars: String(p.body.maxBodyChars),
    k1: String(p.index.k1),
    b: String(p.index.b),
    titleBoost: String(p.index.titleBoost),
    fuzzyMaxEdits: String(p.index.fuzzyMaxEdits),
    fuzzyMinTermLen: String(p.index.fuzzyMinTermLen),
    fuzzyMaxExpansions: String(p.index.fuzzyMaxExpansions),
  };
}


function formToPayload(f: ParamsForm): { index: Record<string, unknown>; body: Record<string, unknown> } {
  const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
  return {
    index: {
      wholeWordMaxLen: num(f.wholeWordMaxLen),
      minTermLen: num(f.minTermLen),
      stopwords: f.stopwords.split(/[\s,，、;；]+/).map((s) => s.trim()).filter((s) => s.length > 0),
      k1: num(f.k1),
      b: num(f.b),
      titleBoost: num(f.titleBoost),
      fuzzyMaxEdits: num(f.fuzzyMaxEdits),
      fuzzyMinTermLen: num(f.fuzzyMinTermLen),
      fuzzyMaxExpansions: num(f.fuzzyMaxExpansions),
    },
    body: { minBodyChars: num(f.minBodyChars), maxBodyChars: num(f.maxBodyChars) },
  };
}


interface SearchIndexApi {
  indexStart: () => Promise<{ ok: boolean; port?: number; error?: string }>;
  indexStop: () => Promise<{ ok: boolean; error?: string }>;
  indexCrawl: (payload: { seeds: string | string[]; opts?: CrawlOpts }) => Promise<{ ok: boolean; error?: string }>;
  indexStatus: () => Promise<{
    running: boolean; port: number; pages: number; terms: number;
    crawling: boolean; log: string[];
    lastCrawl: { ok: boolean; fetched?: number; error?: string } | null;
    sites?: { host: string; pages: number }[];
    params?: IndexParams;
  } | null>;
  indexRebuild: () => Promise<{ ok: boolean; pages?: number; terms?: number; error?: string }>;
  indexClear: () => Promise<{ ok: boolean; removed?: number; error?: string }>;
  indexRemoveSite: (host: string) => Promise<{ ok: boolean; removed?: number; error?: string }>;
  
  indexParamsGet: () => Promise<IndexParams | null>;
  
  indexParamsSet: (p: { index: Record<string, unknown>; body: Record<string, unknown> }) =>
    Promise<{ ok: boolean; pages?: number; terms?: number; notice?: string; error?: string }>;
}

function apiOf(): SearchIndexApi | undefined {
  return (window as unknown as { slimeAPI?: { search?: SearchIndexApi } }).slimeAPI?.search;
}

type Status = Awaited<ReturnType<SearchIndexApi["indexStatus"]>>;








export const CRAWL_PRESETS = [
  { key: "fast", label: "快速", hint: "首页 + 一级链接，先看效果", opts: { maxPages: 30, maxDepth: 2, delay: 0.5 } },
  { key: "std", label: "标准", hint: "默认：100 页 / 深度 3 / 间隔 1s", opts: { maxPages: 100, maxDepth: 3, delay: 1.0 } },
  { key: "deep", label: "深度", hint: "整个站点抓透（对目标站压力较大）", opts: { maxPages: 500, maxDepth: 5, delay: 1.5 } },
] as const;

type PresetKey = typeof CRAWL_PRESETS[number]["key"];








function NumField({ label, value, disabled, onChange }: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
      {label}
      <input className="input-field" type="text" inputMode="decimal" value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export default function SearchIndexPanel(): JSX.Element {
  const [st, setSt] = useState<Status>(null);
  
  const [seeds, setSeeds] = useState("");
  const [busy, setBusy] = useState(false);
  
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [preset, setPreset] = useState<PresetKey>("std");
  const [advanced, setAdvanced] = useState(false);
  const [maxPages, setMaxPages] = useState(100);
  const [maxDepth, setMaxDepth] = useState(3);
  const [delay, setDelay] = useState(1);
  const [sameDomain, setSameDomain] = useState(true);
  const [respectRobots, setRespectRobots] = useState(true);

  
  const [form, setForm] = useState<ParamsForm | null>(null);
  
  const [dirty, setDirty] = useState(false);

  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const api = apiOf();
    if (!api) { setNotice({ ok: false, text: "搜索索引 API 未就绪（preload 未加载？）" }); return; }
    try {
      const s = await api.indexStatus();
      if (alive.current) { setSt(s); }
    } catch (e) {
      if (alive.current) { setNotice({ ok: false, text: `读取状态失败：${e instanceof Error ? e.message : String(e)}` }); }
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  



  const paramsKey = st?.params ? JSON.stringify(st.params) : "";
  useEffect(() => {
    if (dirty || !paramsKey) { return; }
    const p = JSON.parse(paramsKey) as IndexParams;
    setForm(toForm(p));
  }, [paramsKey, dirty]);

  
  useEffect(() => {
    if (!st?.crawling) { return; }
    const t = window.setInterval(() => { void refresh(); }, 1000);
    return () => window.clearInterval(t);
  }, [st?.crawling, refresh]);

  
  const applyPreset = useCallback((k: PresetKey): void => {
    setPreset(k);
    const p = CRAWL_PRESETS.find((x) => x.key === k);
    if (!p) { return; }
    setMaxPages(p.opts.maxPages);
    setMaxDepth(p.opts.maxDepth);
    setDelay(p.opts.delay);
  }, []);

  




  const call = useCallback(async (
    fn: (api: SearchIndexApi) => Promise<{ ok: boolean; error?: string; notice?: string }>,
    okText: string,
  ): Promise<boolean> => {
    const api = apiOf();
    if (!api) { setNotice({ ok: false, text: "搜索索引 API 未就绪（preload 未加载？）" }); return false; }
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn(api);
      
      if (!r.ok) { setNotice({ ok: false, text: r.error ?? "操作失败" }); return false; }
      

      setNotice({ ok: true, text: r.notice ? `${okText}（${r.notice}）` : okText });
      return true;
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
      return false;
    } finally { setBusy(false); }
  }, []);

  
  const onSaveParams = useCallback(async (): Promise<void> => {
    if (!form) { return; }
    

    await call((api) => api.indexParamsSet(formToPayload(form)), "参数已保存（分词/打分类参数已重建索引）");
    setDirty(false);
    await refresh();
  }, [form, call, refresh]);

  const onToggle = useCallback(async (): Promise<void> => {
    const stopping = st?.running ?? false;
    await call((api) => (stopping ? api.indexStop() : api.indexStart()), stopping ? "已停止索引服务" : "索引服务已启动");
    await refresh();
  }, [st?.running, call, refresh]);

  const onCrawl = useCallback(async (): Promise<void> => {
    const opts: CrawlOpts = { maxPages, maxDepth, delay, sameDomain, respectRobots };
    if (await call((api) => api.indexCrawl({ seeds, opts }), "已开始收录，进度见下方日志")) { setSeeds(""); }
    await refresh();
  }, [seeds, maxPages, maxDepth, delay, sameDomain, respectRobots, call, refresh]);

  const onRebuild = useCallback(async (): Promise<void> => {
    await call((api) => api.indexRebuild(), "索引已重建（未重新抓取）");
    await refresh();
  }, [call, refresh]);

  const onClear = useCallback(async (): Promise<void> => {
    const n = st?.pages ?? 0;
    
    if (n > 0 && !window.confirm(`确定清空索引吗？将删除已收录的 ${n} 个页面，此操作不可撤销。`)) { return; }
    await call((api) => api.indexClear(), `索引已清空（删除 ${n} 页）`);
    await refresh();
  }, [st?.pages, call, refresh]);

  const onRemoveSite = useCallback(async (host: string): Promise<void> => {
    if (!window.confirm(`确定删除站点「${host}」的全部已收录页面吗？`)) { return; }
    await call((api) => api.indexRemoveSite(host), `已删除站点 ${host}`);
    await refresh();
  }, [call, refresh]);

  const running = st?.running ?? false;
  const crawling = st?.crawling ?? false;
  
  const seedCount = useMemo(() => seeds.split(/[\r\n,，;；\s]+/).filter((s) => s.trim().length > 0).length, [seeds]);
  const sites = st?.sites ?? [];
  const presetHint = CRAWL_PRESETS.find((p) => p.key === preset)?.hint ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card">
        <h3 style={{ margin: "0 0 4px" }}>搜索索引</h3>
        <div style={{ fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
          自建全网索引：爬虫 / 索引 / 检索服务**全部在 slime 进程内**运行（不再依赖外部 Python），
          随主程序自动启动。搜索页的「补充命中」就来自这里收录的内容。
          <br />
          检索支持这些写法：<code>「精确短语」</code>、<code>site:example.com</code>、<code>-排除词</code>。
        </div>
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{
            fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 999,
            background: running ? "var(--accent-soft)" : "transparent",
            border: "1px solid var(--border)",
            color: running ? "var(--accent-hover)" : "var(--text-dim)",
          }}>
            {running ? "● 运行中" : "○ 已停止"}
          </span>
          {running && (
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
              监听 <code>http:
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={() => { void onToggle(); }}>
            {running ? "停止服务" : "启动服务"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 22, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text)" }}>{st?.pages ?? 0}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>已收录页面</div>
          </div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text)" }}>{st?.terms ?? 0}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>索引词条</div>
          </div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text)" }}>{sites.length}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>已收录站点</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 8px" }}>收录站点</h3>
        <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 10 }}>
          一行一个网址（也接受逗号 / 空格分隔）。slime 会按链接广度优先抓取正文并建索引；
          同一网址重复收录是**更新**，不会重复入库。
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          {CRAWL_PRESETS.map((p) => (
            <button
              key={p.key}
              className="btn"
              title={p.hint}
              disabled={crawling}
              onClick={() => applyPreset(p.key)}
              style={{
                fontSize: 12, padding: "3px 10px",
                borderColor: preset === p.key ? "var(--accent)" : "var(--border)",
                color: preset === p.key ? "var(--accent-hover)" : "var(--text-dim)",
              }}
            >
              {p.label}
            </button>
          ))}
          <span style={{ fontSize: 11.5, color: "var(--text-dim)", alignSelf: "center" }}>{presetHint}</span>
        </div>

        <textarea
          className="input-field"
          style={{ width: "100%", minHeight: 76, resize: "vertical", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12.5 }}
          placeholder={"https://example.com/\nhttps://docs.example.org/"}
          value={seeds}
          disabled={!running || crawling}
          onChange={(e) => setSeeds(e.target.value)}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <button
            className="btn"
            style={{ fontSize: 12, padding: "3px 10px" }}
            disabled={crawling}
            onClick={() => setAdvanced((v) => !v)}
          >
            {advanced ? "收起高级设置" : "高级设置"}
          </button>
          <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            {seedCount > 0 ? `共 ${seedCount} 个网址` : "尚未填写网址"}
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="btn primary"
            disabled={!running || crawling || busy || seedCount === 0}
            onClick={() => { void onCrawl(); }}
          >
            {crawling ? "收录中…" : seedCount > 1 ? `开始收录 ${seedCount} 个站点` : "开始收录"}
          </button>
        </div>

        {advanced && (
          <div style={{
            marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10,
          }}>
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
              每站页数上限
              <input className="input-field" type="number" min={1} max={2000} value={maxPages} disabled={crawling}
                onChange={(e) => { setPreset("std"); setMaxPages(Number(e.target.value) || 1); }} />
            </label>
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
              链接深度
              <input className="input-field" type="number" min={1} max={6} value={maxDepth} disabled={crawling}
                onChange={(e) => { setPreset("std"); setMaxDepth(Number(e.target.value) || 1); }} />
            </label>
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
              请求间隔（秒）
              <input className="input-field" type="number" min={0.3} step={0.1} value={delay} disabled={crawling}
                onChange={(e) => { setPreset("std"); setDelay(Number(e.target.value) || 1); }} />
            </label>
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, marginTop: 16 }}>
              <input type="checkbox" checked={sameDomain} disabled={crawling} onChange={(e) => setSameDomain(e.target.checked)} />
              仅抓种子所在域
            </label>
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, marginTop: 16 }}>
              <input type="checkbox" checked={respectRobots} disabled={crawling} onChange={(e) => setRespectRobots(e.target.checked)} />
              遵守 robots.txt
            </label>
            <div style={{ fontSize: 11, color: "var(--text-dim)", gridColumn: "1 / -1", lineHeight: 1.6 }}>
              修改任一数值即视为自定义（预设高亮取消）。范围由主进程统一夹取：
              页数 ≤ 2000、深度 ≤ 6、间隔 ≥ 0.3 秒。
            </div>
          </div>
        )}

        {!running && (
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8 }}>
            服务未运行 ⇒ 先点上面的「启动服务」。
          </div>
        )}
      </div>

      {sites.length > 0 && (
        <div className="card">
          <h3 style={{ margin: "0 0 8px" }}>已收录站点</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {sites.map((s) => (
              <div key={s.host} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.host}>{s.host}</code>
                <span style={{ color: "var(--text-dim)", fontSize: 11.5 }}>{s.pages} 页</span>
                <button className="btn" style={{ fontSize: 11.5, padding: "2px 8px" }} disabled={busy || crawling}
                  onClick={() => { void onRemoveSite(s.host); }}>
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {}
      {form && (
        <div className="card">
          <h3 style={{ margin: "0 0 8px" }}>分词与正文参数</h3>
          <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.7 }}>
            这两组参数属于<b>这个索引</b>（落盘保存），不是上面「收录站点」里那一组（那组只管<code>这一次抓取</code>）。
            <br />
            <b>分词参数</b>改完会<b>立即重建索引</b> ⇒ 对已收录的全部页面生效；
            <b>正文参数</b>只在<b>抓取时</b>生效 ⇒ 只影响之后新收录的页面（已入库的正文不会重抓）。
            参考对象：Lucene / Elasticsearch 的 analyzer 与 BM25 相似度。
            <br />
            {}
            <b>近似检索</b>（最下面三个）是<b>查询期</b>参数：只在「精确匹配不到这个词」时才去找相近的词
            （把 <code>clude</code> 找回 <code>cloud</code>），改完<b>立刻生效、不需要重建索引</b>。
          </div>

          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10,
          }}>
            <NumField label="整词保留长度（0–8）" value={form.wholeWordMaxLen} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, wholeWordMaxLen: v } : f)); }} />
            <NumField label="最短词长（1–5）" value={form.minTermLen} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, minTermLen: v } : f)); }} />
            <NumField label="最短正文（字数）" value={form.minBodyChars} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, minBodyChars: v } : f)); }} />
            <NumField label="正文上限（字数，0=不限）" value={form.maxBodyChars} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, maxBodyChars: v } : f)); }} />
            <NumField label="BM25 k1（0–3）" value={form.k1} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, k1: v } : f)); }} />
            <NumField label="BM25 b（0–1）" value={form.b} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, b: v } : f)); }} />
            <NumField label="标题权重（0–10）" value={form.titleBoost} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, titleBoost: v } : f)); }} />
            {}
            <NumField label="近似编辑距离（0–2，0=关闭）" value={form.fuzzyMaxEdits} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, fuzzyMaxEdits: v } : f)); }} />
            <NumField label="近似最短词长（≥1）" value={form.fuzzyMinTermLen} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, fuzzyMinTermLen: v } : f)); }} />
            <NumField label="每个词最多近似词数（1–200）" value={form.fuzzyMaxExpansions} disabled={crawling}
              onChange={(v) => { setDirty(true); setForm((f) => (f ? { ...f, fuzzyMaxExpansions: v } : f)); }} />
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>
              停用词（空格 / 逗号分隔；索引与查询两侧同时剔除）
              <input className="input-field" type="text" value={form.stopwords} disabled={crawling}
                placeholder="例如：的 了 我们 广告"
                onChange={(e) => { setDirty(true); setForm((f) => (f ? { ...f, stopwords: e.target.value } : f)); }} />
            </label>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
              留空 = 用默认值；越界的数值由主进程夹取到最接近的合法值，并如实告诉你。
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn primary" disabled={busy || crawling} onClick={() => { void onSaveParams(); }}>
              保存参数
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ margin: "0 0 8px" }}>索引维护</h3>
        <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.7 }}>
          <b>重建索引</b>只重算倒排与词条，**不重新抓取**（改了打分公式或怀疑索引与页面不同步时用）；
          <b>清空索引</b>会删除全部已收录页面，不可撤销。
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" disabled={busy || crawling} onClick={() => { void onRebuild(); }}>重建索引</button>
          <button className="btn" disabled={busy || crawling || (st?.pages ?? 0) === 0} onClick={() => { void onClear(); }}>清空索引</button>
        </div>
      </div>

      {notice && (
        <div style={{
          fontSize: 12.5, padding: "8px 12px", borderRadius: 8,
          border: `1px solid ${notice.ok ? "var(--border)" : "var(--danger)"}`,
          color: notice.ok ? "var(--text-dim)" : "var(--danger)",
        }}>
          {notice.text}
        </div>
      )}

      {st && st.log.length > 0 && (
        <div className="card">
          <h3 style={{ margin: "0 0 8px" }}>最近日志</h3>
          <div style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11.5,
            color: "var(--text-dim)", maxHeight: 200, overflowY: "auto",
            display: "flex", flexDirection: "column", gap: 3,
          }}>
            {st.log.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}
