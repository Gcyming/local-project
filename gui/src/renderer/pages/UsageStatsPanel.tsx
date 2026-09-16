/**
 * gui/src/renderer/pages/UsageStatsPanel.tsx — 设置「使用统计」面板。
 *
 * 设计要点：
 * - 零外部图表库依赖：KPI 卡片 + 折线 + 柱状 + 饼图 + 热力图 + 详情表，全部手写 SVG
 * - 主题自适应：通过 CSS 变量 var(--accent)/var(--text)/var(--border)/var(--text-dim) 跟随主题
 * - 刷新间隔用户可选：5s / 30s / 60s / 30min（默认 30s，避免无谓渲染）
 * - 数据源：通过 IPC `slime:usage:snapshot` 拉取主进程聚合结果（按 sinceIso 过滤）
 * - 持久化：主进程侧 config/usage.jsonl（core-ts/src/services/usage.ts）
 */

import React, { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { RefreshIcon } from "../components/Icon.js";

/* ──────────────── 主题颜色 ──────────────── */
const PALETTE = {
  prompt: "#38bdf8",         // 青蓝
  completion: "#a78bfa",     // 紫
  reasoning: "#fb923c",      // 橙
  cache_read: "#34d399",     // 绿
  cache_creation: "#fbbf24", // 黄
  accent: "#38bdf8",
  warn: "#fbbf24",
  danger: "#f87171",
  /* A-980-R32：日趋势的多序列配色（成本 / 请求数 / tokens 三条并列柱各一色）。
     成本特意避开 --accent 的天蓝（原来那条折线就是天蓝，用户要求"换个颜色"），改用青绿，
     与"钱"的语义也更贴；另两色拉开色相距，保证窄栏下也能分辨。 */
  trend_cost: "#2dd4bf",     // 青绿：每日成本
  trend_req: "#f472b6",      // 品红：每日请求数
  trend_tokens: "#818cf8",   // 靛蓝：每日 tokens
};

/* ──────────────── 类型（与 core-ts/usage.ts 对齐） ──────────────── */
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
  /** 上游错误信息（success=true 时为空；abort 时为 "user-aborted" 等） */
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

/* ──────────────── 数据聚合（接收 UsageRecord[]，产出 5 个聚合） ──────────────── */

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

/**
 * A-980-R32：把日桶补齐成**连续日期轴**。
 *
 * `aggregateRecords` 只为"有记录的日子"建桶，没有调用的一天就直接缺桶。
 * 折线时代这只是少一个点，但换成并列柱之后，缺桶会让日期轴被压缩——柱子的间距不再等于一天，
 * 视觉上"某天突然变密"，看节奏就会读错（"最近天天在用"其实是隔天）。
 * 这里按选定范围补齐零值桶；范围过大（"全部"）时返回原数据，避免为几个月的历史铺几百根空柱。
 */
export function fillDailyGaps(buckets: DailyBucket[], rangeDays: number, now = Date.now()): DailyBucket[] {
  if (rangeDays > 60 || rangeDays < 1) { return buckets; }
  const byKey = new Map(buckets.map((b) => [b.date, b]));
  const tz = -new Date(now).getTimezoneOffset(); // 与 dayKeyLocal 的 tzOffsetMin 同口径
  const out: DailyBucket[] = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const k = dayKeyLocal(now - i * 86_400_000, tz);
    out.push(byKey.get(k) ?? { date: k, requests: 0, cost_usd: 0, total_tokens: 0 });
  }
  // 范围外仍有历史数据（手动改过系统时间等极端情况）→ 原样附在后面，不丢数据
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
    // 日桶
    let db = dailyMap.get(k);
    if (!db) { db = { date: k, requests: 0, cost_usd: 0, total_tokens: 0 }; dailyMap.set(k, db); }
    db.requests++; db.cost_usd += r.cost_usd;
    db.total_tokens += r.prompt_tokens + r.completion_tokens + r.reasoning_tokens + r.cache_read_tokens + r.cache_creation_tokens;
    // 模型桶
    const mk = `${r.provider_key}::${r.model}`;
    let mb = modelMap.get(mk);
    if (!mb) { mb = { model: r.model, provider_key: r.provider_key, requests: 0, cost_usd: 0, total_tokens: 0 }; modelMap.set(mk, mb); }
    mb.requests++; mb.cost_usd += r.cost_usd;
    mb.total_tokens += r.prompt_tokens + r.completion_tokens + r.reasoning_tokens + r.cache_read_tokens + r.cache_creation_tokens;
    // 构成
    composition.prompt += r.prompt_tokens;
    composition.completion += r.completion_tokens;
    composition.reasoning += r.reasoning_tokens;
    composition.cache_read += r.cache_read_tokens;
    composition.cache_creation += r.cache_creation_tokens;
    // 热力图
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

/* ──────────────── 格式化工具 ──────────────── */
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
function fmtCost(usd: number): string {
  // 货币：按用户区域约定；此处展示 ¥（人民币≈7.25），与右栏 MetricsGrid 一致
  const cny = usd * 7.25;
  if (cny < 0.01) { return `¥${cny.toFixed(4)}`; }
  if (cny < 1) { return `¥${cny.toFixed(3)}`; }
  return `¥${cny.toFixed(2)}`;
}
function fmtPct(r: number, digits = 1): string {
  return `${(r * 100).toFixed(digits)}%`;
}

/* ──────────────── KPI 卡片 ──────────────── */
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

/* ──────────────── 日趋势（多序列分组柱） ────────────────
 * A-980-R32 重做「每日成本趋势」：
 *  ① 由单条折线 → **多序列并列柱**：成本 / 请求数 / Tokens 三个参数各一色
 *     （用户要求"把一些别的参数用不同颜色的柱状图显示"，比单折线信息密度高，也更能看出节奏）；
 *  ② **每个序列各自归一化**到自身最大值：三者量纲差几个数量级（¥ 个位 · 请求数十位 · tokens 十万级），
 *     共用一根 Y 轴时 tokens 会把成本压成贴地直线——那正是原来那张图"看着一条平线"的原因。
 *     归一化后比较的是"形状与节奏"，与参考稿（多条异色序列并置）语义一致；准确数值走 hover 提示与图例合计。
 *  ③ 成本全为 0 时不再只是"无数据"，而是直接点名要修的地方（单价未配置）——这条诊断在定价排查里最有用。
 */

interface TrendSeries {
  key: string;
  label: string;
  color: string;
  /** 每根柱的原始值（与 days 等长） */
  values: number[];
  /** 数值展示（含单位） */
  fmt: (v: number) => string;
}

function UsageTrend({ days, height = 170 }: { days: DailyBucket[]; height?: number }): JSX.Element {
  if (days.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "20px 0", textAlign: "center" }}>无数据</div>;
  }
  const series: TrendSeries[] = [
    { key: "cost", label: "成本", color: PALETTE.trend_cost, values: days.map((d) => d.cost_usd * 7.25), fmt: (v) => `¥${v.toFixed(2)}` },
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
  // 稀疏 X 轴标签：30 天时只标约 8 个，避免日期糊成一片
  const labelStep = Math.max(1, Math.ceil(n / 8));

  return (
    <div>
      {/* 图例：色块 + 名称 + 区间合计（合计比"最大值"更有信息量，也顺带说明三序列量纲不同） */}
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
        {/* 基线：给"全 0 序列"一个可见的落点，避免柱子凭空消失 */}
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
      {/* 成本恒 0 的诊断（旧 BarChart 的提示搬家到这里，不再需要用户点开某个图才看得到） */}
      {costAllZero && (
        <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.55 }}>
          成本为 0：已记录 {n} 天的用量，但 <code style={{ background: "var(--bg-elev, rgba(0,0,0,0.06))", padding: "0 4px", borderRadius: 3 }}>cost_usd</code> 全为 0。
          请在「供应商」面板检查各模型的 <code style={{ background: "var(--bg-elev, rgba(0,0,0,0.06))", padding: "0 4px", borderRadius: 3 }}>price_in_usd</code> / <code style={{ background: "var(--bg-elev, rgba(0,0,0,0.06))", padding: "0 4px", borderRadius: 3 }}>price_out_usd</code> 是否已填。
        </div>
      )}
    </div>
  );
}

/** 成本 Top 模型（原独立卡片，A-980-R32 整合进日趋势卡底部）：
 *  横向色条列表，一眼看出"钱花在哪些模型上"；与日趋势同处一卡，避免两张图各说一半。 */
function TopModelCosts({ models }: { models: ModelBucket[] }): JSX.Element {
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
          <div key={full} title={`${full} · ${fmtCost(m.cost_usd)} · ${m.requests} 次 · ${fmtK(m.total_tokens)} tokens`}
            style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 130, maxWidth: 200, flex: "1 1 130px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 11 }}>
              <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{full}</span>
              <span style={{ color: PALETTE.trend_cost, fontWeight: 700, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmtCost(m.cost_usd)}</span>
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

/* ──────────────── 饼图（图例水平一行；支持按模型下拉过滤） ──────────────── */
/** 业界术语说明：
 * - 输入：用户发给模型的原始 token（含 system + messages + tool defs；Anthropic 不含 cache 部分）
 * - 输出：模型生成的回答 token（含 reasoning 思考过程）
 * - 思考：qwen3/deepseek-r1 等思考模型独立的 reasoning_tokens（部分上游从 output 拆出）
 * - 缓存命中：从 prompt cache 读出的 token（Anthropic: cache_read_input_tokens；OpenAI: cached_tokens；DeepSeek: prompt_cache_hit_tokens）—— 通常 0.1x 输入价
 * - 缓存写入：首次写入 prompt cache 的 token（Anthropic: cache_creation_input_tokens；OpenAI 新版：cache_write_tokens；DeepSeek 通常无）—— 通常 1.25x 输入价 */
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

  // 图例改为顶部水平一行（flex-wrap 处理窄屏）
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

/* ──────────────── 热力图 ──────────────── */
function Heatmap({ cells, days, label }: { cells: HeatmapCell[]; days: number; label?: string }): JSX.Element {
  // 即便 cells 为空也展示"完整 N×24 网格"占位（避免稀疏数据被压成 1 列竖条）
  const max = Math.max(...cells.map((c) => c.requests), 1);
  // 按日期升序分组
  const byDate = new Map<string, HeatmapCell[]>();
  for (const c of cells) {
    let arr = byDate.get(c.date);
    if (!arr) { arr = []; byDate.set(c.date, arr); }
    arr.push(c);
  }
  // 生成完整 N 天的日期数组（按 days 倒数；days=9999 用实际数据天数）
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
          {/* 小时刻度（0/6/12/18） */}
          {[0, 6, 12, 18].map((h) => (
            <text key={h} x={labelW - 4}
              y={h * (cellH + gap) + headerH + cellH - 2}
              fontSize={8} fill="var(--text-dim)" textAnchor="end">{h}</text>
          ))}
          {/* X 轴日期（按密度采样，最多 6 个） */}
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
          {/* 单元格（完整 N×24 网格，无数据用更淡占位） */}
          {displayDates.flatMap((date, di) => {
            const dayCells = byDate.get(date) ?? [];
            const cellMap = new Map<number, HeatmapCell>();
            for (const c of dayCells) { cellMap.set(c.hour, c); }
            const x = labelW + di * (cellW + gap);
            return Array.from({ length: 24 }).map((_, h) => {
              const cell = cellMap.get(h);
              const v = cell ? cell.requests / max : 0;
              // 无数据格 = 极淡（区别于有数据的浅色）
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
      {/* 图例：少 → 多 */}
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

/* ──────────────── 主面板 ──────────────── */

const REFRESH_OPTIONS: Array<{ label: string; valueMs: number }> = [
  { label: "5 秒", valueMs: 5_000 },
  { label: "30 秒", valueMs: 30_000 },
  { label: "60 秒", valueMs: 60_000 },
  { label: "30 分钟", valueMs: 30 * 60_000 },
];

/* 详情表每页条数：分页渲染，避免一次性渲染全部记录（几十~上千条） */
const DETAIL_PAGE_SIZE = 50;

export default function UsageStatsPanel(): JSX.Element {
  // 数据状态（v1 视觉稿用 mock；v2 真实接入阶段由 IPC 替换）
  const [data, setData] = useState(() => emptyData());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 历史成本回填：usage.jsonl 的 cost_usd 是写入时固化的，价格表修正后历史记录不会自己变
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);

  // 刷新间隔
  const [refreshMs, setRefreshMs] = useState<number>(30_000);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());

  // 时间范围
  const [range, setRange] = useState<"7d" | "30d" | "all">("30d");
  const rangeDays = range === "7d" ? 7 : range === "30d" ? 30 : 9999;

  // Token 构成按模型过滤（"__all__"=全部）
  const [compositionModel, setCompositionModel] = useState<string>("__all__");

  // 详情表排序
  const [sortKey, setSortKey] = useState<"ts" | "cost_usd" | "prompt_tokens" | "elapsed_ms">("ts");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // 详情表分页页码（0 基；每页 DETAIL_PAGE_SIZE 条）
  const [page, setPage] = useState(0);

  const refreshTimer = useRef<number | null>(null);

  // 从 IPC 拉取 usage 快照并聚合
  const fetchAndAggregate = React.useCallback(async () => {
    const api = (window as unknown as { slimeAPI?: { usage?: { snapshot: (p?: unknown) => Promise<{ records: UsageRecord[]; tzOffsetMin: number }> } } }).slimeAPI;
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
      setLastUpdated(Date.now());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range, rangeDays]);

  // 用当前生效价格重算历史成本（修正"写入时还没有价"的 0 成本记录）
  const runRecompute = React.useCallback(async () => {
    const api = (window as unknown as {
      slimeAPI?: { usage?: { recompute?: () => Promise<{ ok: boolean; updated: number; scanned: number; totalCostUsd: number }> } };
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
      setRecomputeMsg(
        `重算完成：扫描 ${r.scanned} 条，回填 ${r.updated} 条，累计成本 $${r.totalCostUsd.toFixed(4)}`
        + (r.updated === 0 ? "（无可回填项——价格表已是最新，或这些记录本就在免费模型上）" : ""),
      );
    } catch (e) {
      setRecomputeMsg(`重算失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRecomputing(false);
    }
  }, [fetchAndAggregate]);

  // 启动轮询
  useEffect(() => {
    // 立即拉一次
    void fetchAndAggregate();
    if (refreshTimer.current) { window.clearInterval(refreshTimer.current); }
    refreshTimer.current = window.setInterval(() => { void fetchAndAggregate(); }, refreshMs);
    return () => {
      if (refreshTimer.current) { window.clearInterval(refreshTimer.current); }
      refreshTimer.current = null;
    };
  }, [refreshMs, fetchAndAggregate]);

  // IPC 已按 range 过滤了 records，data.* 已是该范围聚合结果；本组件不再二次过滤
  // A-980-R32：日趋势专用——补成连续日期轴（缺漏的日子补零桶，见 fillDailyGaps）
  const trendDays = useMemo(() => fillDailyGaps(data.daily, rangeDays), [data.daily, rangeDays]);
  // 按所选模型聚合的 Token 构成
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

  // 排序后的详情表（全量排序，分页渲染当前页，避免一次性渲染全部记录）
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

  // 分页切片：数据刷新后条数可能变少，把页码钳制到合法区间，避免空页
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

  /* ──────────────── 渲染 ──────────────── */
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "0 4px" }}>
      {/* 标题栏 + 刷新控制 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>使用统计</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {loadError ? <span style={{ color: "var(--danger, #f87171)" }}>加载失败：{loadError}</span> : `数据范围：${data.records.length} 条`}
        </div>
        <div style={{ flex: 1 }} />
        {/* 时间范围 */}
        <select className="input-field" style={{ fontSize: 11, padding: "3px 8px" }}
          value={range} onChange={(e) => setRange(e.target.value as typeof range)}>
          <option value="7d">近 7 天</option>
          <option value="30d">近 30 天</option>
          <option value="all">全部</option>
        </select>
        {/* 刷新间隔 */}
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

      {/* KPI 卡片行 */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <KpiCard
          label="总费用"
          value={fmtCost(data.summary.cost_usd)}
          hint={`≈ $${data.summary.cost_usd.toFixed(4)}`}
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

      {/* 模型筛选栏（A-980-R32：从「Token 构成」卡右上角**提到这里**）。
          原来它被塞在饼图卡头部：卡片窄时下拉被挤、标题换行；且"筛选"语义的控件散在图表卡里不好找。
          现在它自成一行、紧跟时间范围/自动刷新这排筛选控件，宽度稳定、位置可预期。
          作用域仍是「Token 构成」（右栏窄，强行让它过滤整个面板会让其它卡片与上方 KPI 口径打架），
          所以后缀明确标注，不做隐性全局筛选。 */}
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
            // 显示完整「provider / model」让用户分得清是哪个供应商的模型；
            // 超过 24 字符才截短（hover 还能看完整名）
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

      {/* 图表行 1（A-980-R32：**占满一行**）——
          原来这一行是「折线 + Top 模型成本」两卡并排；现在日趋势独占整行、高度加到 170，
          并把 Top 模型成本整合到同一张卡的底部（两者本来就都回答"钱花在哪"，拆两张卡各说一半）。 */}
      <div className="card" style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>每日使用趋势</div>
          <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
            三色柱 = 成本 / 请求数 / Tokens（各自独立缩放，悬停看准确值）
          </div>
        </div>
        <UsageTrend days={trendDays} height={170} />
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", marginBottom: 6 }}>成本 Top 模型</div>
          <TopModelCosts models={data.byModel} />
        </div>
      </div>

      {/* 图表行 2：饼图 + 热力图 */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div className="card" style={{ flex: 1, minWidth: 280, padding: "12px 14px" }}>
          {/* 标题栏：模型下拉已上提到面板级「模型选择」栏（见上），卡内只留标题 */}
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

      {/* 详情表 */}
      <div className="card" style={{ padding: "12px 14px" }}>
        {/* 标题行：标题 flexShrink:0 + 导出按钮 flexShrink:0/nowrap/width:auto，避免被挤压换行变形 */}
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
        {/* 明细滚动容器：固定 max-height + 容器内滚动，绝不撑长整个使用统计界面 */}
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
                  <Td align="right" mono>{fmtCost(r.cost_usd)}</Td>
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

        {/* 分页条：第 X/Y 页 · 共 N 条；上一页/下一页（边界禁用） */}
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

      {/* 空数据提示 */}
      {data.records.length === 0 && !loadError && (
        <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>暂无使用记录</div>
          <div style={{ fontSize: 11 }}>与任意 Agent 发起对话后，token 消耗、费用、调用次数会自动累计到这里。</div>
        </div>
      )}

      {/* 提示脚注 */}
      <div style={{ fontSize: 10, color: "var(--text-dim)", textAlign: "right" }}>
        数据持久化于 config/usage.jsonl（按 mtime+size 缓存，最长保留 10000 条 / 10MB 轮转）
      </div>
    </div>
  );
}

/* ──────────────── 表头 / 单元格 ──────────────── */
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
      // 表头吸顶：滚动明细时表头不消失；背景与卡片一致，boxShadow 作分隔线
      // （border-collapse 下 th 的 border 不随 sticky 滚动，boxShadow 可以）
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

/* ──────────────── CSV 导出 ──────────────── */
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