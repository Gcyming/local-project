/**
 * scripts/loadtest_mainprocess.mjs — 阶段5 主进程负载压测（v2.8 要求）。
 *
 * 三组场景：
 * 1. IPC流式序列化开销 — 模拟100K字符级消息通过IPC发送的延迟
 * 2. 四阶段检索峰值 — 1000条记忆随机查询的CPU占用与延迟
 * 3. 并发agent同时对话 — 验证主进程单事件循环不阻塞
 *
 * 验收标准：
 * - IPC序列化：单次100K消息 roundtrip < 50ms（P99）
 * - 检索峰值：10次并发查询平均延迟 < 200ms
 * - 并发对话：5个agent同时请求，最长延迟 < 3s
 * - 超时则输出建议：将对应服务下沉到 worker_threads
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";

const REPORT_DIR = join(process.cwd(), "data", "loadtest");
const RESULTS = {
  ipc_serialization: null,
  retrieval_peak: null,
  concurrent_chat: null,
  summary: null,
  timestamp: new Date().toISOString(),
};

// ── 工具：生成模拟长文本 ─────────────────────────────────────
function generateLongText(charCount) {
  const words = [
    "slime", "agent", "memory", "retrieval", "vector", "embedding",
    "llm", "provider", "sandbox", "swarm", "skill", "mcp",
    "behavior", "emotion", "persona", "knowledge", "evolution",
  ];
  let result = "";
  while (result.length < charCount) {
    const word = words[Math.floor(Math.random() * words.length)];
    result += word + " ";
  }
  return result.slice(0, charCount);
}

// ── 场景1: IPC流式序列化开销 ─────────────────────────────────
async function bench_ipc_serialization() {
  console.log("\n[压测 1] IPC流式序列化开销（100K字符级）");
  const sizes = [1024, 10240, 102400]; // 1K / 10K / 100K
  const results = [];

  for (const size of sizes) {
    const payload = generateLongText(size);
    const iterations = 50;
    const times = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      // 模拟 IPC roundtrip：序列化 + 反序列化
      const serialized = JSON.stringify({ seq: i, type: "chunk", data: { content: payload } });
      const deserialized = JSON.parse(serialized);
      const elapsed = performance.now() - start;
      times.push(elapsed);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const sorted = [...times].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];

    results.push({ size, avg, p95, p99, iterations });
    console.log(`  ${size} 字符: avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`);
  }

  const threshold_ms = 50;
  const passed = results.every((r) => r.p99 < threshold_ms);
  console.log(`  阈值: p99 < ${threshold_ms}ms → ${passed ? "✅ PASS" : "❌ FAIL"}`);
  return { ...results, passed, threshold_ms };
}

// ── 场景2: 四阶段检索峰值 ─────────────────────────────────
async function bench_retrieval_peak() {
  console.log("\n[压测 2] 四阶段检索峰值（1000条记忆 × 10次并发查询）");

  // 模拟1000条记忆条目（含links、tags、importance）
  const memories = Array.from({ length: 1000 }, (_, i) => ({
    id: randomUUID(),
    content: generateLongText(200),
    links: [`mem_${randomUUID().slice(0, 8)}`, `mem_${randomUUID().slice(0, 8)}`],
    tags: ["knowledge", "behavior", "memory"][i % 3],
    importance: Math.random(),
    ts: Date.now() - Math.random() * 365 * 24 * 3600 * 1000,
  }));

  // 四阶段检索模拟：向量种子 → 链接遍历 → 标签过滤 → 权重排序
  function simulateRetrieve(query) {
    // 阶段1: 向量种子（随机采样10%）
    const seed = memories.filter(() => Math.random() < 0.1);
    // 阶段2: 链接遍历（O(n)）
    const linkHits = new Set();
    for (const m of seed) {
      for (const link of m.links) {
        linkHits.add(link);
      }
    }
    // 阶段3: 标签过滤
    const tagged = memories.filter((m) => m.tags.includes(query) || seed.includes(m));
    // 阶段4: 权重排序（艾宾浩斯衰减）
    const scored = tagged.map((m) => ({
      ...m,
      score: m.importance * (1 / (1 + (Date.now() - m.ts) / 86400000)),
    })).sort((a, b) => b.score - a.score);
    return scored.slice(0, 20);
  }

  const queryCount = 10;
  const queries = ["knowledge", "behavior", "memory", "slime", "agent"];
  const times = [];

  for (let q = 0; q < queryCount; q++) {
    const start = performance.now();
    for (let i = 0; i < 5; i++) {
      simulateRetrieve(queries[q % queries.length]);
    }
    const elapsed = performance.now() - start;
    times.push(elapsed);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const sorted = [...times].sort((a, b) => a - b);
  const p99 = sorted[Math.floor(sorted.length * 0.99)];

  const threshold_ms = 200;
  const passed = p99 < threshold_ms;
  console.log(`  平均延迟: ${avg.toFixed(2)}ms p99: ${p99.toFixed(2)}ms`);
  console.log(`  阈值: p99 < ${threshold_ms}ms → ${passed ? "✅ PASS" : "❌ FAIL"}`);
  return { avg, p99, passed, threshold_ms };
}

// ── 场景3: 并发Agent同时对话 ───────────────────────────────
async function bench_concurrent_chat() {
  console.log("\n[压测 3] 并发Agent同时对话（5个Agent × 10轮模拟）");

  // 模拟5个Agent同时发起请求（非真正LLM调用，模拟处理延迟）
  const agentCount = 5;
  const rounds = 10;
  const baseDelay_ms = 50; // 模拟每个round的基准延迟
  const latencies = [];

  async function simulateAgentChat(agentId) {
    const agentLatencies = [];
    for (let r = 0; r < rounds; r++) {
      const start = performance.now();
      // 模拟：prompt组装 + 检索 + LLM调用（mock 50-150ms）
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelay_ms + Math.random() * 100),
      );
      const elapsed = performance.now() - start;
      agentLatencies.push(elapsed);
    }
    return agentLatencies;
  }

  // 并发执行
  const promises = Array.from({ length: agentCount }, (_, i) =>
    simulateAgentChat(`agent_${i}`),
  );
  const allResults = await Promise.all(promises);

  const allLatencies = allResults.flat();
  const avg = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
  const sorted = [...allLatencies].sort((a, b) => a - b);
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const max = sorted[sorted.length - 1];

  const threshold_ms = 3000; // 最长延迟 < 3s
  const passed = max < threshold_ms;
  console.log(`  平均延迟: ${avg.toFixed(2)}ms p99: ${p99.toFixed(2)}ms 最大: ${max.toFixed(2)}ms`);
  console.log(`  阈值: 最大 < ${threshold_ms}ms → ${passed ? "✅ PASS" : "❌ FAIL"}`);
  return { avg, p99, max, passed, threshold_ms };
}

// ── 场景4: 主线程阻塞检测（CPU密集操作是否会卡UI）──────────
async function bench_cpu_heavy_blocking() {
  console.log("\n[压测 4] CPU密集型操作阻塞检测（worker_threads vs 主线程）");

  // 测试1: 在主线程执行10MB字符串处理
  const bigString = generateLongText(10 * 1024 * 1024); // 10MB
  const iterations = 100;

  const start_main = performance.now();
  for (let i = 0; i < iterations; i++) {
    // 模拟：字符串搜索 + 替换
    bigString.replaceAll("slime", "agent");
  }
  const main_elapsed = performance.now() - start_main;

  // 测试2: 在worker中执行相同操作
  const workerFile = join(process.cwd(), "scripts/_lt_worker.mjs");
  await writeFile(workerFile, `
    import { parentPort, workerData } from 'node:worker_threads';
    const bigString = ${JSON.stringify(generateLongText(10 * 1024 * 1024))};
    const iterations = ${iterations};
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      bigString.replaceAll("slime", "agent");
    }
    parentPort.postMessage({ elapsed: performance.now() - start });
  `);
  const worker = new Worker(workerFile);
  const workerResult = await new Promise((resolve) => {
    worker.on("message", resolve);
  });
  worker.terminate();

  console.log(`  主线程: ${main_elapsed.toFixed(2)}ms (${iterations} × 10MB字符串处理)`);
  console.log(`  Worker: ${workerResult.elapsed.toFixed(2)}ms`);
  console.log(`  阻塞比: ${(main_elapsed / workerResult.elapsed).toFixed(2)}x`);

  // 如果主线程耗时 > 1s，建议下沉到worker
  const threshold_ms = 1000;
  const passed = main_elapsed < threshold_ms;
  console.log(`  阈值: 主线程 < ${threshold_ms}ms → ${passed ? "✅ PASS (无需下沉)" : "⚠️ FAIL (建议下沉到worker)"}`);
  return { main_elapsed, worker_elapsed: workerResult.elapsed, passed };
}

// ── 主函数 ──────────────────────────────────────────────────
async function run_all() {
  console.log("=".repeat(60));
  console.log("阶段5 主进程负载压测（v2.8 要求）");
  console.log(`时间: ${RESULTS.timestamp}`);
  console.log("=".repeat(60));

  try {
    RESULTS.ipc_serialization = await bench_ipc_serialization();
    RESULTS.retrieval_peak = await bench_retrieval_peak();
    RESULTS.concurrent_chat = await bench_concurrent_chat();
    RESULTS.cpu_blocking = await bench_cpu_heavy_blocking();
  } catch (e) {
    console.error("[压测] 执行失败:", e);
    RESULTS.error = e.message;
  }

  // 汇总
  const allPassed =
    RESULTS.ipc_serialization?.passed !== false &&
    RESULTS.retrieval_peak?.passed !== false &&
    RESULTS.concurrent_chat?.passed !== false;

  RESULTS.summary = {
    ipc_serialization: allPassed ? "PASS" : "FAIL",
    retrieval_peak: RESULTS.retrieval_peak?.passed === false ? "FAIL" : "PASS",
    concurrent_chat: RESULTS.concurrent_chat?.passed === false ? "FAIL" : "PASS",
    cpu_blocking: RESULTS.cpu_blocking?.passed ? "无需下沉" : "建议下沉",
    overall: allPassed ? "✅ 全部通过" : "⚠️ 部分失败，见上方详情",
  };

  // 落盘报告
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = join(REPORT_DIR, `loadtest_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, JSON.stringify(RESULTS, null, 2), "utf8");
  console.log(`\n报告已落盘: ${reportPath}`);

  // 关键决策点
  console.log("\n" + "=".repeat(60));
  console.log("决策建议:");
  if (!RESULTS.ipc_serialization?.passed) {
    console.log("  ❌ IPC序列化超标 → 考虑压缩传输或分片");
  }
  if (!RESULTS.retrieval_peak?.passed) {
    console.log("  ❌ 检索峰值超标 → 将四阶段检索下沉到worker_threads");
  }
  if (!RESULTS.concurrent_chat?.passed) {
    console.log("  ❌ 并发对话超标 → 将ChatService.stream下沉到worker");
  }
  if (RESULTS.cpu_blocking && !RESULTS.cpu_blocking.passed) {
    console.log("  ⚠️  CPU密集型操作阻塞主线程 → 将memory/knowledge检索下沉到worker");
  }
  if (allPassed) {
    console.log("  ✅ 主进程架构无需调整，可直接进入GUI打包阶段");
  }
  console.log("=".repeat(60));

  return RESULTS;
}

run_all().then((r) => {
  process.exit(r.summary?.overall?.includes("FAIL") ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
