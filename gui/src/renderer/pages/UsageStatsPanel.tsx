










import React, { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { RefreshIcon } from "../components/Icon.js";


import { formatMoney, formatUsdAs, pricingDisplayCurrency, type PriceCurrency } from "../../../../shared/gen/model-capabilities.js";


const PALETTE = {
  prompt: "#38bdf8",         
  completion: "#a78bfa",     
  reasoning: "#fb923c",      
  cache_read: "#34d399",     
  cache_creation: "#fbbf24", 
  accent: "#38bdf8",
  warn: "#fbbf24",
  danger: "#f87171",
  


  trend_cost: "#2dd4bf",     
  trend_req: "#f472b6",      
  trend_tokens: "#818cf8",   
};


interface UsageRecord {
  ts: string;
  agent_id: string;
  session_id: string;
  model: string;
  provider_key: string;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  elapsed_ms: number;
  cost_usd: number;
  success: boolean;
  
  error?: string;
}

interface UsageSummary {
  total_requests: number;
  successful_requests: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  cache_hit_rate: number;
  avg_elapsed_ms: number;
  unique_models_used: number;
  unique_agents: number;
}

interface DailyBucket {
  date: string;
  requests: number;
  cost_usd: number;
  total_tokens: number;
}

interface ModelBucket {
  model: string;
  provider_key: string;
  requests: number;
  cost_usd: number;
  total_tokens: number;
}

interface TokenComposition {
  prompt: number;
  completion: number;
  reasoning: number;
  cache_read: number;
  cache_creation: number;
}

interface HeatmapCell {
  date: string;
  hour: number;
  requests: number;
}



function emptyData(): { records: UsageRecord[]; daily: DailyBucket[]; byModel: ModelBucket[]; composition: TokenComposition; heatmap: HeatmapCell[]; summary: UsageSummary } {
  const composition: TokenComposition = { prompt: 0, completion: 0, reasoning: 0, cache_read: 0, cache_creation: 0 };
  return {
    records: [],
    daily: [],
    byModel: [],
    composition,
    heatmap: [],
    summary: {
      total_requests: 0, successful_requests: 0, total_tokens: 0,
      prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      cost_usd: 0, cache_hit_rate: 0, avg_elapsed_ms: 0,
      unique_models_used: 0, unique_agents: 0,
    },
  };
}

function dayKeyLocal(ts: number, tzOffsetMin: number): string {
  const local = new Date(ts + tzOffsetMin * 60_000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function hourOfDayLocal(ts: number, tzOffsetMin: number): number {
  const local = new Date(ts + tzOffsetMin * 60_000);
  return local.getUTCHours();
}









export function fillDailyGaps(buckets: DailyBucket[], rangeDays: number, now = Date.now()): DailyBucket[] {
  if (rangeDays > 60 || rangeDays < 1) { return buckets; }
  const byKey = new Map(buckets.map((b) => [b.date, b]));
  const tz = -new Date(now).getTimezoneOffset(); 
  const out: DailyBucket[] = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const k = dayKeyLocal(now - i * 86_400_000, tz);
    out.push(byKey.get(k) ?? { date: k, requests: 0, cost_usd: 0, total_tokens: 0 });
  }
  
  for (const b of buckets) {
    if (!out.some((o) => o.date === b.date)) { out.push(b); }
  }
  return out;
}

function aggregateRecords(records: UsageRecord[], tzOffsetMin: number): { records: UsageRecord[]; daily: DailyBucket[]; byModel: ModelBucket[]; composition: TokenComposition; heatmap: HeatmapCell[]; summary: UsageSummary } {
  const dailyMap = new Map<string, DailyBucket>();
  const modelMap = new Map<string, ModelBucket>();
  const composition: TokenComposition = { prompt: 0, completion: 0, reasoning: 0, cache_read: 0, cache_creation: 0 };
  const heatmapMap = new Map<string, HeatmapCell>();
  let totalReq = 0, okReq = 0, totalElapsed = 0;
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) { continue; }
    const k = dayKeyLocal(t, tzOffsetMin);
    totalReq++; if (r.success) { okReq++; } totalElapsed += r.elapsed_ms;
    
    let db = dailyMap.get(k);
    if (!db) { db = { date: k, requests: 0, cost_usd: 0, total_tokens: 0 }; dailyMap.set(k, db); }
    db.requests++; db.cost_usd += r.cost_usd;
    db.total_tokens += r.prompt_tokens + r.completion_tokens + r.reasoning_tokens + r.cache_read_tokens + r.cache_creation_tokens;
    
    const mk = `${r.provider_key}::${r.model}`;
    let mb = modelMap.get(mk);
    if (!mb) { mb = { model: r.model, provider_key: r.provider_key, requests: 0, cost_usd: 0, total_tokens: 0 }; modelMap.set(mk, mb); }
    mb.requests++; mb.cost_usd += r.cost_usd;
    mb.total_tokens += r.prompt_tokens + r.completion_tokens + r.reasoning_tokens + r.cache_read_tokens + r.cache_creation_tokens;
    
    composition.prompt += r.prompt_tokens;
    composition.completion += r.completion_tokens;
    composition.reasoning += r.reasoning_tokens;
    composition.cache_read += r.cache_read_tokens;
    composition.cache_creation += r.cache_creation_tokens;
    
    const hk = `${k}::${hourOfDayLocal(t, tzOffsetMin)}`;
    let hc = heatmapMap.get(hk);
    if (!hc) { hc = { date: k, hour: hourOfDayLocal(t, tzOffsetMin), requests: 0 }; heatmapMap.set(hk, hc); }
    hc.requests++;
  }
  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const byModel = Array.from(modelMap.values()).sort((a, b) => b.cost_usd - a.cost_usd);
  const heatmap = Array.from(heatmapMap.values());
  const summary: UsageSummary = {
    total_requests: totalReq,
    successful_requests: okReq,
    total_tokens: composition.prompt + composition.completion + composition.reasoning + composition.cache_read + composition.cache_creation,
    prompt_tokens: composition.prompt,
    completion_tokens: composition.completion,
    reasoning_tokens: composition.reasoning,
    cache_read_tokens: composition.cache_read,
    cache_creation_tokens: composition.cache_creation,
    cost_usd: byModel.reduce((s, m) => s + m.cost_usd, 0),
    cache_hit_rate: composition.prompt > 0 ? composition.cache_read / composition.prompt : 0,
    avg_elapsed_ms: totalReq > 0 ? totalElapsed / totalReq : 0,
    unique_models_used: byModel.length,
    unique_agents: new Set(records.map((r) => r.agent_id)).size,
  };
  return { records, daily, byModel, composition, heatmap, summary };
}


function fmtK(n: number): string {
  if (n >= 1_000_000) { return (n / 1_000_000).toFixed(2) + "M"; }
  if (n >= 1_000) { return (n / 1_000).toFixed(1) + "k"; }
  return String(Math.round(n));
}
function fmtMs(ms: number): string {
  if (ms < 1000) { return `${Math.round(ms)}ms`; }
  if (ms < 60_000) { return `${(ms / 1000).toFixed(1)}s`; }
  return `${(ms / 60_000).toFixed(1)}m`;
}
function fmtCost(usd: number, currency: PriceCurrency = "USD"): string {
  








  return formatUsdAs(usd, currency);
}





import { ledgerCurrencyOf } from "./usageCurrency.js";

import { readLedgerCurrencyPref, resolveLedgerCurrency, LEDGER_CURRENCY_EVENT, type LedgerCurrencyPref } from "./ledgerCurrencyCfg.js";
function fmtPct(r: number, digits = 1): string {
  return `${(r * 100).toFixed(digits)}%`;
}


interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  color?: string;
}
function KpiCard(props: KpiCardProps): JSX.Element {
  return (
    <div style={{
      flex: 1, minWidth: 130,
      padding: "12px 14px",
      borderRadius: 10,
      background: "var(--bg-elev, rgba(255,255,255,0.03))",
      border: "1px solid var(--border)",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600, letterSpacing: 0.4 }}>{props.label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: props.color ?? "var(--text)", lineHeight: 1.1 }}>{props.value}</div>
      {props.hint && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{props.hint}</div>}
    </div>
  );
}











interface TrendSeries {
  key: string;
  label: string;
  color: string;
  
  values: number[];
  
  fmt: (v: number) => string;
}

function UsageTrend({ days, height = 170, currency = "USD" }: {
  days: DailyBucket[]; height?: number;
  
  currency?: PriceCurrency;
}): JSX.Element {
  if (days.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "20px 0", textAlign: "center" }}>无数据</div>;
  }
  const series: TrendSeries[] = [
    
    
    
    { key: "cost", label: "成本", color: PALETTE.trend_cost, values: days.map((d) => d.cost_usd), fmt: (v) => formatUsdAs(v, currency) },
    { key: "req", label: "请求数", color: PALETTE.trend_req, values: days.map((d) => d.requests), fmt: (v) => `${v} 次` },
    { key: "tokens", label: "Tokens", color: PALETTE.trend_tokens, values: days.map((d) => d.total_tokens), fmt: (v) => fmtK(v) },
  ];
  const costAllZero = series[0].values.every((v) => v <= 0);
  const n = days.length;
  const w = 720;
  const h = height;
  const padX = 10, padTop = 16, padBottom = 20;
  const innerW = w - padX * 2;
  const innerH = h - padTop - padBottom;
  const groupW = innerW / n;
  const barGap = Math.min(3, groupW * 0.06);
  const barsW = groupW * 0.86;
  const barW = Math.max(1.2, (barsW - barGap * (series.length - 1)) / series.length);
  
  const labelStep = Math.max(1, Math.ceil(n / 8));

  return (
    <div>
      {}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 4 }}>
        {series.map((s) => {
          const total = s.values.reduce((a, b) => a + b, 0);
          return (
            <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)" }} title={`区间合计：${s.fmt(total)}`}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0 }} />
              <span style={{ color: "var(--text)", fontWeight: 600 }}>{s.label}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{s.fmt(total)}</span>
            </span>
          );
        })}
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: h, display: "block" }}>
        {}
        <line x1={padX} y1={h - padBottom} x2={w - padX} y2={h - padBottom} stroke="var(--border)" strokeWidth={1} />
        {days.map((d, i) => {
          const gx = padX + i * groupW;
          return (
            <g key={d.date}>
              {series.map((s, si) => {
                const max = Math.max(...s.values, 0);
                const v = s.values[i] ?? 0;
                const bh = max > 0 ? (v / max) * innerH : 0;
                const x = gx + (groupW - barsW) / 2 + si * (barW + barGap);
                const y = h - padBottom - bh;
                return (
                  <rect key={s.key} x={x} y={y} width={barW} height={Math.max(bh, v > 0 ? 1 : 0)}
                    fill={s.color} fillOpacity={0.82} rx={1.5}>
                    <title>{d.date} · {s.label}: {s.fmt(v)}</title>
                  </rect>
                );
              })}
              {(i % labelStep === 0 || i === n - 1) && (
                <text x={gx + groupW / 2} y={h - 6} fontSize={9} fill="var(--text-dim)" textAnchor="middle">
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {}
      {costAllZero && (
        <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.55 }}>
          成本为 0：已记录 {n} 天的用量，但 <code style={{ background: "var(--bg-elev, rgba(0,0,0,0.06))", padding: "0 4px", borderRadius: 3 }}>cost_usd</code> 全为 0。
          请在「供应商」面板检查各模型的 <code style={{ background: "var(--bg-elev, rgba(0,0,0,0.06))", padding: "0 4px", borderRadius: 3 }}>price_in_usd</code> / <code style={{ background: "var(--bg-elev, rgba(0,0,0,0.06))", padding: "0 4px", borderRadius: 3 }}>price_out_usd</code> 是否已填。
        </div>
      )}
    </div>
  );
}



function TopModelCosts({ models, currencyOf }: {
  models: ModelBucket[];
  
  currencyOf: (r: { model: string; provider_key?: string }) => PriceCurrency;
}): JSX.Element {
  const top = [...models].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 6);
  const max = Math.max(...top.map((m) => m.cost_usd), 0);
  if (top.length === 0) {
    return <div style={{ fontSize: 11, color: "var(--text-dim)" }}>暂无模型用量</div>;
  }
  if (max <= 0) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        已用 {models.length} 个模型，但单价未配置 → 成本均为 0（无法排行）
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {top.map((m) => {
        const full = `${m.provider_key}/${m.model}`;
        return (
          <div key={full} title={`${full} · ${fmtCost(m.cost_usd, currencyOf(m))} · ${m.requests} 次 · ${fmtK(m.total_tokens)} tokens`}
            style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 130, maxWidth: 200, flex: "1 1 130px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 11 }}>
              <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{full}</span>
              <span style={{ color: PALETTE.trend_cost, fontWeight: 700, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmtCost(m.cost_usd, currencyOf(m))}</span>
            </div>
            <div style={{ height: 4, borderRadius: 2, background: "var(--bg-hover, rgba(148,163,184,0.18))", overflow: "hidden" }}>
              <div style={{ width: `${Math.max(2, (m.cost_usd / max) * 100)}%`, height: "100%", background: PALETTE.trend_cost, opacity: 0.85 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}








function PieChart({ composition, modelLabel }: { composition: TokenComposition; modelLabel?: string }): JSX.Element {
  const items = [
    { key: "prompt", value: composition.prompt, color: PALETTE.prompt, name: "输入", desc: "原始 prompt" },
    { key: "completion", value: composition.completion, color: PALETTE.completion, name: "输出", desc: "模型回答" },
    { key: "reasoning", value: composition.reasoning, color: PALETTE.reasoning, name: "思考", desc: "推理/思考（reasoning 模型）" },
    { key: "cache_read", value: composition.cache_read, color: PALETTE.cache_read, name: "缓存命中", desc: "从 prompt cache 读取（命中）" },
    { key: "cache_creation", value: composition.cache_creation, color: PALETTE.cache_creation, name: "缓存写入", desc: "首次写入 prompt cache" },
  ];
  const total = items.reduce((s, x) => s + x.value, 0);
  if (total === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "20px 0", textAlign: "center" }}>无 token 数据</div>;
  }

  const cx = 80, cy = 70, r = 56, rIn = 32;
  let cumAngle = -Math.PI / 2;
  const slices = items.map((it) => {
    if (it.value === 0) { return null; }
    const angle = (it.value / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(cumAngle);
    const y1 = cy + r * Math.sin(cumAngle);
    const x2 = cx + r * Math.cos(cumAngle + angle);
    const y2 = cy + r * Math.sin(cumAngle + angle);
    const xi1 = cx + rIn * Math.cos(cumAngle + angle);
    const yi1 = cy + rIn * Math.sin(cumAngle + angle);
    const xi2 = cx + rIn * Math.cos(cumAngle);
    const yi2 = cy + rIn * Math.sin(cumAngle);
    const large = angle > Math.PI ? 1 : 0;
    const d = [
      `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `L ${xi1.toFixed(2)} ${yi1.toFixed(2)}`,
      `A ${rIn} ${rIn} 0 ${large} 0 ${xi2.toFixed(2)} ${yi2.toFixed(2)}`,
      "Z",
    ].join(" ");
    const midAngle = cumAngle + angle / 2;
    const labelR = (r + rIn) / 2;
    const lx = cx + labelR * Math.cos(midAngle);
    const ly = cy + labelR * Math.sin(midAngle);
    const pct = (it.value / total) * 100;
    cumAngle += angle;
    return (
      <g key={it.key}>
        <path d={d} fill={it.color} fillOpacity={0.85} stroke="var(--bg-elev, rgba(0,0,0,0.4))" strokeWidth={1}>
          <title>{it.name} · {it.desc}：{fmtK(it.value)} ({pct.toFixed(1)}%)</title>
        </path>
        {pct > 4 && (
          <text x={lx} y={ly} fontSize={9} fill="var(--text)" textAnchor="middle" dominantBaseline="middle" fontWeight={700}>
            {pct.toFixed(0)}%
          </text>
        )}
      </g>
    );
  });

  
  return (
    <div>
      <svg viewBox="0 0 160 140" style={{ width: 160, height: 140, display: "block", margin: "0 auto" }}>
        {slices}
        <text x={cx} y={cy - 2} fontSize={9} fill="var(--text-dim)" textAnchor="middle">总 tokens</text>
        <text x={cx} y={cy + 10} fontSize={11} fill="var(--text)" textAnchor="middle" fontWeight={800}>{fmtK(total)}</text>
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px", marginTop: 8, fontSize: 11 }}>
        {items.filter((it) => it.value > 0).map((it) => {
          const pct = (it.value / total) * 100;
          return (
            <div key={it.key} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 4, background: "var(--bg-elev, rgba(255,255,255,0.03))" }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: it.color, display: "inline-block", flexShrink: 0 }} />
              <span style={{ color: "var(--text)" }}>{it.name}</span>
              <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{fmtK(it.value)}</span>
              <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right" }}>{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
      {modelLabel && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", textAlign: "center", marginTop: 4 }}>
          范围：{modelLabel}
        </div>
      )}
    </div>
  );
}


function Heatmap({ cells, days, label }: { cells: HeatmapCell[]; days: number; label?: string }): JSX.Element {
  
  const max = Math.max(...cells.map((c) => c.requests), 1);
  
  const byDate = new Map<string, HeatmapCell[]>();
  for (const c of cells) {
    let arr = byDate.get(c.date);
    if (!arr) { arr = []; byDate.set(c.date, arr); }
    arr.push(c);
  }
  
  const sortedActualDates = Array.from(byDate.keys()).sort();
  const displayDates: string[] = days >= 9999
    ? sortedActualDates
    : (() => {
        const out: string[] = [];
        for (let i = days - 1; i >= 0; i--) {
          out.push(new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10));
        }
        return out;
      })();
  const cellW = 14, cellH = 14, gap = 2, labelW = 22, headerH = 12;
  const totalW = labelW + displayDates.length * (cellW + gap);
  const totalH = headerH + 24 * (cellH + gap);

  return (
    <div>
      {label && <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{label}</div>}
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${totalW} ${totalH}`} style={{ width: totalW, height: totalH, display: "block" }}>
          {}
          {[0, 6, 12, 18].map((h) => (
            <text key={h} x={labelW - 4}
              y={h * (cellH + gap) + headerH + cellH - 2}
              fontSize={8} fill="var(--text-dim)" textAnchor="end">{h}</text>
          ))}
          {}
          {displayDates.map((date, di) => {
            const x = labelW + di * (cellW + gap);
            const step = Math.max(1, Math.floor(displayDates.length / 6));
            if (di % step !== 0 && di !== displayDates.length - 1) { return null; }
            return (
              <g key={date}>
                <text x={x + cellW / 2} y={headerH - 2} fontSize={8} fill="var(--text-dim)" textAnchor="middle">
                  {date.slice(5)}
                </text>
              </g>
            );
          })}
          {}
          {displayDates.flatMap((date, di) => {
            const dayCells = byDate.get(date) ?? [];
            const cellMap = new Map<number, HeatmapCell>();
            for (const c of dayCells) { cellMap.set(c.hour, c); }
            const x = labelW + di * (cellW + gap);
            return Array.from({ length: 24 }).map((_, h) => {
              const cell = cellMap.get(h);
              const v = cell ? cell.requests / max : 0;
              
              const alpha = cell ? 0.15 + v * 0.7 : 0.05;
              const y = headerH + h * (cellH + gap);
              return (
                <rect key={`${date}-${h}`} x={x} y={y} width={cellW} height={cellH}
                  fill={PALETTE.accent} fillOpacity={alpha} rx={1.5}>
                  {cell && <title>{date} {h}:00 — {cell.requests} 次请求</title>}
                </rect>
              );
            });
          })}
        </svg>
      </div>
      {}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 10, color: "var(--text-dim)" }}>
        <span>少</span>
        {[0.1, 0.3, 0.5, 0.7, 0.9].map((a) => (
          <span key={a} style={{ display: "inline-block", width: 10, height: 10, background: PALETTE.accent, opacity: a, borderRadius: 1 }} />
        ))}
        <span>多</span>
        <span style={{ marginLeft: 12 }}>共 {displayDates.length} 天 · {cells.length} 个小时格有数据</span>
      </div>
    </div>
  );
}



const REFRESH_OPTIONS: Array<{ label: string; valueMs: number }> = [
  { label: "5 秒", valueMs: 5_000 },
  { label: "30 秒", valueMs: 30_000 },
  { label: "60 秒", valueMs: 60_000 },
  { label: "30 分钟", valueMs: 30 * 60_000 },
];


const DETAIL_PAGE_SIZE = 50;

export default function UsageStatsPanel(): JSX.Element {
  
  const [data, setData] = useState(() => emptyData());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);

  
  const [refreshMs, setRefreshMs] = useState<number>(30_000);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());

  
  const [range, setRange] = useState<"7d" | "30d" | "all">("30d");
  const rangeDays = range === "7d" ? 7 : range === "30d" ? 30 : 9999;

  
  const [compositionModel, setCompositionModel] = useState<string>("__all__");

  
  const [sortKey, setSortKey] = useState<"ts" | "cost_usd" | "prompt_tokens" | "elapsed_ms">("ts");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  
  const [page, setPage] = useState(0);

  



  const [modelCurrencies, setModelCurrencies] = useState<Record<string, PriceCurrency>>({});

  
  const [ledgerPref, setLedgerPref] = useState<LedgerCurrencyPref>(() => readLedgerCurrencyPref());
  useEffect(() => {
    const onEvent = (e: Event): void => {
      const d = (e as CustomEvent<LedgerCurrencyPref>).detail;
      setLedgerPref(d === "USD" || d === "CNY" || d === "auto" ? d : readLedgerCurrencyPref());
    };
    const sync = (): void => setLedgerPref(readLedgerCurrencyPref());
    window.addEventListener(LEDGER_CURRENCY_EVENT, onEvent);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(LEDGER_CURRENCY_EVENT, onEvent);
      window.removeEventListener("storage", sync);
    };
  }, []);

  




  const currencyOf = React.useCallback((r: { model: string; provider_key?: string }): PriceCurrency =>
    pricingDisplayCurrency(r.model, modelCurrencies[`${r.provider_key ?? ""}::${r.model}`]),
  [modelCurrencies]);

  const refreshTimer = useRef<number | null>(null);

  
  const fetchAndAggregate = React.useCallback(async () => {
    const api = (window as unknown as { slimeAPI?: { usage?: { snapshot: (p?: unknown) => Promise<{ records: UsageRecord[]; tzOffsetMin: number; modelCurrencies?: Record<string, PriceCurrency> }> } } }).slimeAPI;
    if (!api?.usage) {
      setLoadError("slimeAPI.usage 不可用（请确认 preload 已暴露）");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const opts: { sinceIso?: string; untilIso?: string; limit?: number } = { limit: 5000 };
      if (range !== "all") {
        opts.sinceIso = new Date(Date.now() - rangeDays * 86400 * 1000).toISOString();
      }
      const snap = await api.usage.snapshot(opts);
      setData(aggregateRecords(snap.records, snap.tzOffsetMin));
      
      setModelCurrencies(snap.modelCurrencies ?? {});
      setLastUpdated(Date.now());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range, rangeDays]);

  
  const runRecompute = React.useCallback(async () => {
    const api = (window as unknown as {
      slimeAPI?: { usage?: { recompute?: () => Promise<{ ok: boolean; updated: number; scanned: number; totalCostUsd: number; unpriced?: number; unpricedModels?: string[]; tiered?: number }> } };
    }).slimeAPI;
    if (typeof api?.usage?.recompute !== "function") {
      setRecomputeMsg("slimeAPI.usage.recompute 不可用（请确认 preload 已暴露）");
      return;
    }
    setRecomputing(true);
    setRecomputeMsg(null);
    try {
      const r = await api.usage.recompute();
      await fetchAndAggregate();
      const unpriced = r.unpriced ?? 0;
      const models = r.unpricedModels ?? [];
      const tiered = r.tiered ?? 0;
      
      
      const hint = r.updated > 0
        ? ""
        : unpriced > 0
          ? "（这些模型未定价——可在供应商面板手填「单价 $/M」）"
          : "（无可回填项——价格表已是最新，或这些记录本就在免费模型上）";
      setRecomputeMsg(
        `重算完成：扫描 ${r.scanned} 条，回填 ${r.updated} 条，累计成本 $${r.totalCostUsd.toFixed(4)}`
        
        
        + (tiered > 0 ? `，其中 ${tiered} 条按峰谷分时取档` : "")
        + (unpriced > 0
          ? `，未定价 ${unpriced} 条${models.length > 0 ? `（${models.join("、")}${unpriced > 0 && models.length >= 5 ? " 等" : ""}）` : ""}`
          : "")
        + hint,
      );
    } catch (e) {
      setRecomputeMsg(`重算失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRecomputing(false);
    }
  }, [fetchAndAggregate]);

  
  useEffect(() => {
    
    void fetchAndAggregate();
    if (refreshTimer.current) { window.clearInterval(refreshTimer.current); }
    refreshTimer.current = window.setInterval(() => { void fetchAndAggregate(); }, refreshMs);
    return () => {
      if (refreshTimer.current) { window.clearInterval(refreshTimer.current); }
      refreshTimer.current = null;
    };
  }, [refreshMs, fetchAndAggregate]);

  
  
  
  const ledger = useMemo(
    () => resolveLedgerCurrency(ledgerPref, ledgerCurrencyOf(data.records, currencyOf)),
    [ledgerPref, data.records, currencyOf],
  );
  
  const trendDays = useMemo(() => fillDailyGaps(data.daily, rangeDays), [data.daily, rangeDays]);
  
  const compositionData = useMemo<{ c: TokenComposition; label: string }>(() => {
    if (compositionModel === "__all__") {
      return { c: data.composition, label: "全部模型" };
    }
    const [pKey, mId] = compositionModel.split("::");
    const recs = data.records.filter((r) => r.provider_key === pKey && r.model === mId);
    const c: TokenComposition = { prompt: 0, completion: 0, reasoning: 0, cache_read: 0, cache_creation: 0 };
    for (const r of recs) {
      c.prompt += r.prompt_tokens;
      c.completion += r.completion_tokens;
      c.reasoning += r.reasoning_tokens;
      c.cache_read += r.cache_read_tokens;
      c.cache_creation += r.cache_creation_tokens;
    }
    return { c, label: mId };
  }, [compositionModel, data.records, data.composition]);

  
  const sortedRecords = useMemo(() => {
    const arr = [...data.records];
    arr.sort((a, b) => {
      const ka = a[sortKey], kb = b[sortKey];
      if (typeof ka === "number" && typeof kb === "number") {
        return sortDir === "asc" ? ka - kb : kb - ka;
      }
      return sortDir === "asc" ? String(ka).localeCompare(String(kb)) : String(kb).localeCompare(String(ka));
    });
    return arr;
  }, [data.records, sortKey, sortDir]);

  
  const totalPages = Math.max(1, Math.ceil(sortedRecords.length / DETAIL_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRecords = useMemo(
    () => sortedRecords.slice(safePage * DETAIL_PAGE_SIZE, (safePage + 1) * DETAIL_PAGE_SIZE),
    [sortedRecords, safePage],
  );

  const goPrevPage = (): void => setPage((p) => Math.max(0, p - 1));
  const goNextPage = (): void => setPage((p) => Math.min(totalPages - 1, p + 1));

  const toggleSort = (key: typeof sortKey): void => {
    if (sortKey === key) { setSortDir(sortDir === "asc" ? "desc" : "asc"); }
    else { setSortKey(key); setSortDir("desc"); }
  };

  
  return (
    
    <div className="settings-pane" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>使用统计</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {loadError ? <span style={{ color: "var(--danger, #f87171)" }}>加载失败：{loadError}</span> : `数据范围：${data.records.length} 条`}
        </div>
        <div style={{ flex: 1 }} />
        {}
        <select className="input-field" style={{ fontSize: 11, padding: "3px 8px" }}
          value={range} onChange={(e) => setRange(e.target.value as typeof range)}>
          <option value="7d">近 7 天</option>
          <option value="30d">近 30 天</option>
          <option value="all">全部</option>
        </select>
        {}
        <select className="input-field" style={{ fontSize: 11, padding: "3px 8px" }}
          value={refreshMs} onChange={(e) => setRefreshMs(Number(e.target.value))}>
          {REFRESH_OPTIONS.map((o) => (
            <option key={o.valueMs} value={o.valueMs}>自动刷新 · {o.label}</option>
          ))}
        </select>
        <button className="titlebar-btn" onClick={() => { void runRecompute(); }} disabled={recomputing}
          title="按当前生效价格重算历史记录的 cost_usd（修正因「未定价」而记成 0 的历史账目）"
          style={{
            opacity: recomputing ? 0.5 : 1, transition: "opacity 0.2s",
            fontSize: 11, padding: "3px 8px", whiteSpace: "nowrap",
          }}>
          {recomputing ? "重算中…" : "重算历史成本"}
        </button>
        <button className="titlebar-btn" onClick={() => { void fetchAndAggregate(); }} title="立即刷新"
          style={{ opacity: loading ? 0.5 : 1, transition: "opacity 0.2s" }}>
          <RefreshIcon size={14} />
        </button>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          更新于 {new Date(lastUpdated).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      </div>

      {recomputeMsg && (
        <div style={{
          fontSize: 11, padding: "6px 10px", borderRadius: 4,
          background: "var(--card-surface, rgba(255,255,255,0.04))",
          border: "1px solid var(--card-border, rgba(255,255,255,0.08))",
          color: "var(--text-secondary)",
        }}>
          {recomputeMsg}
        </div>
      )}

      {}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <KpiCard
          label="总费用"
          value={fmtCost(data.summary.cost_usd, ledger)}
          





          hint={ledger === "CNY"
            ? `模型归属地显示；账目原值 ${formatMoney(data.summary.cost_usd, "USD")}`
            : "海外厂商以美元计价（按模型归属地显示）"}
          color={PALETTE.accent}
        />
        <KpiCard
          label="请求数"
          value={String(data.records.length)}
          hint={`成功 ${data.summary.successful_requests} · 失败 ${data.records.length - data.summary.successful_requests}`}
        />
        <KpiCard
          label="总 Tokens"
          value={fmtK(data.summary.total_tokens)}
          hint={`入 ${fmtK(data.summary.prompt_tokens)} / 出 ${fmtK(data.summary.completion_tokens)}`}
        />
        <KpiCard
          label="缓存命中率"
          value={fmtPct(data.summary.cache_hit_rate)}
          hint={`命中 ${fmtK(data.summary.cache_read_tokens)} · 写入 ${fmtK(data.summary.cache_creation_tokens)}`}
          color={PALETTE.cache_read}
        />
      </div>

      {



}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>模型选择</span>
        <select
          className="input-field"
          style={{ fontSize: 11, padding: "3px 8px", maxWidth: 220, flexShrink: 0 }}
          value={compositionModel}
          onChange={(e) => setCompositionModel(e.target.value)}
          title="按模型查看 Token 构成"
        >
          <option value="__all__">全部模型</option>
          {data.byModel.map((m) => {
            const id = `${m.provider_key}::${m.model}`;
            
            
            const full = `${m.provider_key}/${m.model}`;
            const short = full.length > 24 ? full.slice(0, 23) + "…" : full;
            return (
              <option key={id} value={id} title={full}>{short}</option>
            );
          })}
        </select>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", flexShrink: 0 }}>
          {compositionModel === "__all__" ? "按模型查看 Token 构成" : "仅影响「Token 构成」饼图"}
        </span>
      </div>

      {

}
      <div className="card" style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>每日使用趋势</div>
          <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
            三色柱 = 成本 / 请求数 / Tokens（各自独立缩放，悬停看准确值）
          </div>
        </div>
        <UsageTrend days={trendDays} height={170} currency={ledger} />
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", marginBottom: 6 }}>成本 Top 模型</div>
          <TopModelCosts models={data.byModel} currencyOf={currencyOf} />
        </div>
      </div>

      {}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div className="card" style={{ flex: 1, minWidth: 280, padding: "12px 14px" }}>
          {}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", flexShrink: 0 }}>Token 构成</div>
            <div style={{ flex: 1 }} />
          </div>
          <PieChart composition={compositionData.c} modelLabel={compositionData.label} />
        </div>
        <div className="card" style={{ flex: 2, minWidth: 360, padding: "12px 14px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>活跃热力图（每日 × 小时）</div>
          <Heatmap cells={data.heatmap} days={rangeDays} />
        </div>
      </div>

      {}
      <div className="card" style={{ padding: "12px 14px" }}>
        {}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "nowrap" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", flexShrink: 0 }}>请求明细</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>共 {data.records.length} 条 · 每页 {DETAIL_PAGE_SIZE} 条</div>
          <div style={{ flex: 1 }} />
          <button className="titlebar-btn" title="导出当前范围为 CSV"
            onClick={() => { void exportCsv(data.records, range); }}
            style={{ fontSize: 11, padding: "2px 8px", width: "auto", flexShrink: 0, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}>
            ⬇ 导出 CSV
          </button>
        </div>
        {}
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: 360 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <Th label="时间" onClick={() => toggleSort("ts")} active={sortKey === "ts"} dir={sortDir} />
                <Th label="Agent" />
                <Th label="模型" />
                <Th label="prompt" onClick={() => toggleSort("prompt_tokens")} active={sortKey === "prompt_tokens"} dir={sortDir} align="right" />
                <Th label="completion" align="right" />
                <Th label="cache" align="right" />
                <Th label="cost" onClick={() => toggleSort("cost_usd")} active={sortKey === "cost_usd"} dir={sortDir} align="right" />
                <Th label="耗时" onClick={() => toggleSort("elapsed_ms")} active={sortKey === "elapsed_ms"} dir={sortDir} align="right" />
                <Th label="状态" align="center" />
              </tr>
            </thead>
            <tbody>
              {pageRecords.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)", opacity: r.success ? 1 : 0.55 }}>
                  <Td>{new Date(r.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</Td>
                  <Td>{r.agent_id}</Td>
                  <Td title={`${r.provider_key} / ${r.model}`}>{`${r.provider_key}/${r.model}`.length > 22 ? `${r.provider_key}/${r.model}`.slice(0, 21) + "…" : `${r.provider_key}/${r.model}`}</Td>
                  <Td align="right" mono>{fmtK(r.prompt_tokens)}</Td>
                  <Td align="right" mono>{fmtK(r.completion_tokens + r.reasoning_tokens)}</Td>
                  <Td align="right" mono>{fmtK(r.cache_read_tokens)}</Td>
                  {}
                  <Td align="right" mono>{fmtCost(r.cost_usd, currencyOf(r))}</Td>
                  <Td align="right" mono>{fmtMs(r.elapsed_ms)}</Td>
                  <Td align="center">
                    <span style={{
                      display: "inline-block", padding: "1px 6px", borderRadius: 4, fontSize: 10,
                      background: r.success ? "rgba(52,211,153,0.18)" : "rgba(248,113,113,0.22)",
                      color: r.success ? PALETTE.cache_read : PALETTE.danger,
                    }}>{r.success ? "OK" : "ERR"}</span>
                  </Td>
                </tr>
              ))}
              {pageRecords.length === 0 && (
                <tr><td colSpan={9} style={{ padding: 16, textAlign: "center", color: "var(--text-dim)" }}>暂无数据</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {}
        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, fontSize: 11, color: "var(--text-dim)" }}>
            <span style={{ whiteSpace: "nowrap" }}>第 {safePage + 1}/{totalPages} 页 · 共 {sortedRecords.length} 条</span>
            <div style={{ flex: 1 }} />
            <button className="titlebar-btn" title="上一页" disabled={safePage === 0}
              onClick={goPrevPage}
              style={{ width: "auto", padding: "2px 10px", fontSize: 11, flexShrink: 0, whiteSpace: "nowrap",
                opacity: safePage === 0 ? 0.4 : 1, cursor: safePage === 0 ? "default" : "pointer" }}>
              上一页
            </button>
            <button className="titlebar-btn" title="下一页" disabled={safePage >= totalPages - 1}
              onClick={goNextPage}
              style={{ width: "auto", padding: "2px 10px", fontSize: 11, flexShrink: 0, whiteSpace: "nowrap",
                opacity: safePage >= totalPages - 1 ? 0.4 : 1, cursor: safePage >= totalPages - 1 ? "default" : "pointer" }}>
              下一页
            </button>
          </div>
        )}
      </div>

      {}
      {data.records.length === 0 && !loadError && (
        <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>暂无使用记录</div>
          <div style={{ fontSize: 11 }}>与任意 Agent 发起对话后，token 消耗、费用、调用次数会自动累计到这里。</div>
        </div>
      )}

      {}
      <div style={{ fontSize: 10, color: "var(--text-dim)", textAlign: "right" }}>
        数据持久化于 config/usage.jsonl（按 mtime+size 缓存，最长保留 10000 条 / 10MB 轮转）
      </div>
    </div>
  );
}


function Th({ label, onClick, active, dir, align }: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  dir?: "asc" | "desc";
  align?: "left" | "right" | "center";
}): JSX.Element {
  const cursor = onClick ? "pointer" : "default";
  const arrow = active ? (dir === "asc" ? " ↑" : " ↓") : "";
  const title = onClick ? `点击按${label}${active ? (dir === "asc" ? "降序" : "升序") : "排序"}` : undefined;
  return (
    <th onClick={onClick} title={title} style={{
      padding: "6px 8px", textAlign: align ?? "left", cursor, userSelect: "none",
      color: active ? "var(--accent)" : "var(--text-dim)", fontWeight: 700, fontSize: 10.5,
      letterSpacing: 0.3,
      
      
      position: "sticky", top: 0, zIndex: 1,
      background: "var(--bg-card)",
      boxShadow: "0 1px 0 var(--border)",
    }}>
      {label}{arrow}
    </th>
  );
}

function Td({ children, align, mono, title }: { children: React.ReactNode; align?: "left" | "right" | "center"; mono?: boolean; title?: string }): JSX.Element {
  return (
    <td title={title} style={{
      padding: "5px 8px", textAlign: align ?? "left",
      fontVariantNumeric: mono ? "tabular-nums" : undefined,
      color: "var(--text)",
    }}>
      {children}
    </td>
  );
}


function csvEscape(s: string): string {
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

async function exportCsv(records: UsageRecord[], range: string): Promise<void> {
  const header = ["ts", "agent_id", "session_id", "provider_key", "model", "prompt_tokens", "completion_tokens", "reasoning_tokens", "cache_read_tokens", "cache_creation_tokens", "elapsed_ms", "cost_usd", "success", "error"];
  const lines = [header.join(",")];
  for (const r of records) {
    lines.push([
      r.ts, r.agent_id, r.session_id, r.provider_key, r.model,
      r.prompt_tokens, r.completion_tokens, r.reasoning_tokens,
      r.cache_read_tokens, r.cache_creation_tokens, r.elapsed_ms,
      r.cost_usd.toFixed(6),
      r.success ? "1" : "0",
      csvEscape(r.error ?? ""),
    ].join(","));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `slime-usage-${range}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}