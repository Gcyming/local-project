/**
 * scripts/spike_vectordb.mjs — 向量存储 spike（长存架构规划 §6.4 前置阻塞项）。
 *
 * 候选：
 *   A. LanceDB（@lancedb/lancedb，原生 ANN 索引）
 *   B. JSONL 全内存（暴力余弦）
 *   C. better-sqlite3（vec BLOB + 暴力余弦）
 *
 * 实测维度：
 *   1. 1000 条模拟记忆：写入耗时 + 四阶段检索延迟（10 次平均）
 *   2. 万条级写入耗时（10000 条）
 *   3. 10 万条量级：LanceDB 真实写入+建索引+检索；JSONL/sqlite 按 O(n) 外推
 *   4. Windows 原生加载兼容性（spike_loadcheck 已过）
 *
 * 模拟数据：1024 维（BGE-M3 维度），中文内容 + links + tags + importance。
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "spike");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const DIM = 1024;
const N_1000 = 1000;
const N_10K = 10000;
const N_100K = 100000;
const QUERIES = 10;

// ── 模拟数据 ────────────────────────────────────────────

const TAGS = ["技能", "记忆", "社交", "工具", "任务", "情感"];
const LINKS_POOL = Array.from({ length: 30 }, (_, i) => `agent_0000_mem_${i}`);

function randVec(rng) {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = rng() * 2 - 1;
  return v;
}

function makeMemories(n, seed = 42) {
  let s = seed;
  const rng = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const mems = [];
  for (let i = 0; i < n; i++) {
    mems.push({
      id: `mem_${i}`,
      content: `记忆条目 ${i}：今天学习了关于${TAGS[i % TAGS.length]}的知识并记录了下来。`,
      vec: randVec(rng),
      links: [LINKS_POOL[(i * 7) % 30], LINKS_POOL[(i * 13 + 5) % 30]],
      tags: [TAGS[i % TAGS.length], TAGS[(i + 2) % TAGS.length]],
      importance: 0.5 + rng() * 0.5,
      ts: 1700000000 + i * 60,
    });
  }
  return mems;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

function seedRetrieve(mems, qvec, topK = 10) {
  const scored = mems.map((m, idx) => ({ m, s: cosine(m.vec, qvec), idx }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, topK);
}

function fourStageRetrieve(mems, qvec, queryTags) {
  // 阶段1: 向量种子
  const seeds = seedRetrieve(mems, qvec, 10).map((x) => x.m);
  // 阶段2: 链接遍历（2 跳）
  const byId = new Map(mems.map((m) => [m.id, m]));
  const walked = new Set(seeds.map((m) => m.id));
  const queue = [...seeds];
  for (let hop = 0; hop < 2 && queue.length; hop++) {
    const cur = queue.shift();
    for (const lid of cur.links) {
      const target = byId.get(lid);
      if (target && !walked.has(lid)) {
        walked.add(lid);
        queue.push(target);
      }
    }
  }
  const stage2 = [...walked].map((id) => byId.get(id)).filter(Boolean);
  // 阶段3: 标签过滤
  const stage3 = stage2.filter((m) => m.tags.some((t) => queryTags.includes(t)));
  // 阶段4: 权重排序（importance × 时间衰减）
  const now = Math.max(...mems.map((m) => m.ts));
  stage3.sort((a, b) => {
    const wa = a.importance * (1 - (now - a.ts) / (now - mems[0].ts + 1));
    const wb = b.importance * (1 - (now - b.ts) / (now - mems[0].ts + 1));
    return wb - wa;
  });
  return { seeds: seeds.length, link_walked: stage2.length, tag_filtered: stage3.length, ranked: stage3.length };
}

// ── 后端 ────────────────────────────────────────────────

async function backendJsonl(mems, qvec, queryTags) {
  const file = path.join(OUT, "mem.jsonl");
  const t0 = performance.now();
  writeFileSync(file, mems.map((m) => JSON.stringify({ ...m, vec: Array.from(m.vec) })).join("\n"));
  const writeMs = performance.now() - t0;

  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const loaded = lines.map((l) => {
    const o = JSON.parse(l);
    o.vec = Float32Array.from(o.vec);
    return o;
  });
  let min = Infinity, max = 0;
  for (let i = 0; i < QUERIES; i++) {
    const t1 = performance.now();
    fourStageRetrieve(loaded, qvec, queryTags);
    const d = performance.now() - t1;
    min = Math.min(min, d); max = Math.max(max, d);
  }
  return { writeMs, avgMs: (min + max) / 2, minMs: min, maxMs: max, loadMs: performance.now() - t0 };
}

function backendSqlite(mems, qvec, queryTags) {
  const Database = require("better-sqlite3");
  const file = path.join(OUT, "mem.sqlite");
  if (existsSync(file)) { /* 每次重建 */ }
  const db = new Database(file);
  db.exec("CREATE TABLE IF NOT EXISTS mem (id TEXT PRIMARY KEY, content TEXT, links TEXT, tags TEXT, importance REAL, ts INTEGER, vec BLOB)");
  const ins = db.prepare("INSERT OR REPLACE INTO mem VALUES (?,?,?,?,?,?,?)");
  const t0 = performance.now();
  db.transaction(() => {
    for (const m of mems) ins.run(m.id, m.content, JSON.stringify(m.links), JSON.stringify(m.tags), m.importance, m.ts, Buffer.from(m.vec.buffer));
  })();
  const writeMs = performance.now() - t0;

  const rows = db.prepare("SELECT * FROM mem").all();
  const loaded = rows.map((r) => ({
    id: r.id, content: r.content,
    links: JSON.parse(r.links), tags: JSON.parse(r.tags),
    importance: r.importance, ts: r.ts,
    vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4),
  }));
  let min = Infinity, max = 0;
  for (let i = 0; i < QUERIES; i++) {
    const t1 = performance.now();
    fourStageRetrieve(loaded, qvec, queryTags);
    const d = performance.now() - t1;
    min = Math.min(min, d); max = Math.max(max, d);
  }
  db.close();
  return { writeMs, avgMs: (min + max) / 2, minMs: min, maxMs: max, loadMs: performance.now() - t0 };
}

async function backendLance(mems, qvec, queryTags, tableName, index = false) {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(path.join(OUT, tableName));
  const t0 = performance.now();
  const batch = 512;
  let table = null;
  for (let i = 0; i < mems.length; i += batch) {
    const slice = mems.slice(i, i + batch).map((m) => ({ id: m.id, content: m.content, vec: m.vec, links: JSON.stringify(m.links), tags: JSON.stringify(m.tags), importance: m.importance, ts: m.ts }));
    if (!table) {
      table = await db.createTable(tableName, slice);
    } else {
      await table.add(slice);
    }
  }
  const writeMs = performance.now() - t0;
  if (!table) table = await db.openTable(tableName);

  let indexMs = 0;
  if (index) {
    const t1 = performance.now();
    await table.createIndex("vec", { type: "ivf_pq", metric_type: "cosine", num_partitions: 64, num_sub_vectors: 16 });
    indexMs = performance.now() - t1;
  }

  let min = Infinity, max = 0;
  for (let i = 0; i < QUERIES; i++) {
    const t2 = performance.now();
    const rows = await table.query().nearestTo(qvec).limit(10).toArray();
    const d = performance.now() - t2;
    min = Math.min(min, d); max = Math.max(max, d);
    if (rows.length !== 10) throw new Error(`检索返回 ${rows.length} 行（应 10）`);
  }
  return { writeMs, avgMs: (min + max) / 2, minMs: min, maxMs: max, indexMs };
}

// ── 主流程 ──────────────────────────────────────────────

function fmt(ms) {
  return ms < 1000 ? `${ms.toFixed(2)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const qvec = randVec(() => 0.42);
  const queryTags = ["技能", "记忆"];

  // 1. 1000 条
  const mems1k = makeMemories(N_1000);
  console.log(`== 1000 条模拟记忆（1024 维）==`);
  const j1k = await backendJsonl(mems1k, qvec, queryTags);
  console.log(`[A] JSONL   : 写入=${fmt(j1k.writeMs)} 加载=${fmt(j1k.loadMs)} 检索=${fmt(j1k.avgMs)}/次 (min ${fmt(j1k.minMs)} max ${fmt(j1k.maxMs)})`);
  const s1k = backendSqlite(mems1k, qvec, queryTags);
  console.log(`[B] SQLite  : 写入=${fmt(s1k.writeMs)} 加载=${fmt(s1k.loadMs)} 检索=${fmt(s1k.avgMs)}/次 (min ${fmt(s1k.minMs)} max ${fmt(s1k.maxMs)})`);
  const l1k = await backendLance(mems1k, qvec, queryTags, "mem1k", false);
  console.log(`[C] LanceDB : 写入=${fmt(l1k.writeMs)} 检索=${fmt(l1k.avgMs)}/次 (min ${fmt(l1k.minMs)} max ${fmt(l1k.maxMs)})`);

  // 2. 万条级写入（10000 条）
  console.log(`== 10000 条写入 ==`);
  const mems10k = makeMemories(N_10K, 777);
  const t0 = performance.now();
  const j10k = await backendJsonl(mems10k, qvec, queryTags);
  console.log(`[A] JSONL   : 写入=${fmt(j10k.writeMs)}（含序列化）`);
  const s10k = backendSqlite(mems10k, qvec, queryTags);
  console.log(`[B] SQLite  : 写入=${fmt(s10k.writeMs)} 检索=${fmt(s10k.avgMs)}/次`);
  const l10k = await backendLance(mems10k, qvec, queryTags, "mem10k", true);
  console.log(`[C] LanceDB : 写入=${fmt(l10k.writeMs)} 建索引=${fmt(l10k.indexMs)} 检索=${fmt(l10k.avgMs)}/次`);
  console.log(`    (共 ${fmt(performance.now() - t0)})`);

  // 3. 10 万条量级（LanceDB 真实写入；JSONL/sqlite O(n) 外推）
  console.log(`== 100000 条量级衰减 ==`);
  const mems100k = makeMemories(N_100K, 2026);
  let l100k = null;
  try {
    l100k = await backendLance(mems100k, qvec, queryTags, "mem100k", true);
    console.log(`[C] LanceDB : 写入=${fmt(l100k.writeMs)} 建索引=${fmt(l100k.indexMs)} 检索=${fmt(l100k.avgMs)}/次`);
  } catch (e) {
    console.log(`[C] LanceDB 10 万条: FAIL ${e.message}`);
  }
  const ratio = N_100K / N_1000;
  console.log(`[A] JSONL 外推(×${ratio}): 写入≈${fmt(j1k.writeMs * ratio)} 检索≈${fmt(j1k.avgMs * ratio)}/次`);
  console.log(`[B] SQLite 外推(×${ratio}): 写入≈${fmt(s1k.writeMs * ratio)} 检索≈${fmt(s1k.avgMs * ratio)}/次`);
  if (l100k && l1k) {
    const growth = l100k.avgMs / l1k.avgMs;
    console.log(`[C] LanceDB 1000→100k 检索增速: ×${growth.toFixed(2)}（亚线性=ANN 生效）`);
  }

  // 4. 汇总
  console.log(`\n== 汇总（检索延迟 1000 条 / 10 次平均）==`);
  console.log(`JSONL   : 写 ${fmt(j1k.writeMs)}  查 ${fmt(j1k.avgMs)}  | 10k 写 ${fmt(j10k.writeMs)}`);
  console.log(`SQLite  : 写 ${fmt(s1k.writeMs)}  查 ${fmt(s1k.avgMs)}  | 10k 写 ${fmt(s10k.writeMs)}`);
  console.log(`LanceDB : 写 ${fmt(l1k.writeMs)}  查 ${fmt(l1k.avgMs)}  | 10k 写 ${fmt(l10k.writeMs)} (索引 ${fmt(l10k.indexMs)})`);
  console.log(`spike 产物目录: ${OUT}`);
}

main().catch((e) => { console.error("spike FAIL:", e); process.exit(1); });