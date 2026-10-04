#!/usr/bin/env node
/**
 * gui/scripts/mut-a1141-search-gateway.mjs — A-1141（把自建索引接进 slime 网关）的变异验证。
 *
 * ## 这一组要护的是什么
 * 用户原话：「你把它**彻底内嵌进 slime，接入 slime 网关，做成 slime 的一部分**」。
 * 本组守的是最后那一跳：网关（`gateway-ts`）新增 `/v1/search*` 三条端点，**薄代理**到
 * 进程内的索引服务。这类"转发层"的失效方式全是**不报错**的那一挂：
 *   1  路由**永远挂着**（`if (searchBase)` 被写死成真）⇒ 没配地址也把三条端点暴露出去，
 *      而它们全指向一个空地址 ⇒ 每个请求 502，构建期一个字都不报
 *   2/3 检索路由被混进**认证豁免** ⇒ 「能读到用户全部收录内容」的端点裸奔
 *   4  上游不可达**吞成 200**（降级看不见：调用方以为拿到了结果）
 *   5  不可达的 `error.type` 漂 ⇒ 调用方无法凭类型区分"索引没起来"与"别的一般错误"
 *   6  不可达的 message **丢掉上游地址** ⇒ 用户查不出到底连的是谁
 *   7  回包被**加工**（多一个键）⇒ 页面（直连 8600）与网关（19110）成了两份事实，迟早漂
 *   8  查询串不再透传（丢掉 `q` / `page` / `size`）⇒ 「分页永远第一页」这种静默错
 *   9  `/v1/search/status` 挂到别的上游路径 ⇒ 网关报的索引状态不是那份事实
 *  10  上游的**失败状态码**一律改写成 200 ⇒ 空 seeds 的 400 变成"收录已开始"
 *  11  crawl 端点的 HTTP 方法漂（POST→GET）⇒ 405/404，而路由本身"看着还在"
 *  12  status 路由**整个删掉** ⇒ 网关少一条能力，构建期不报
 *  13  检索路由路径漂（`/v1/search` → `/v1/searches`）⇒ 调用方 404
 *  14  `llmGateway.ts` **硬写 8600** ⇒ 与 `SEARCH_INDEX_PORT` 成两个产地，改一处漏一处
 *  15  `llmGateway.ts` 干脆不把索引服务接进网关 ⇒ `/v1/search*` 永远不挂（功能全没，门禁全绿）
 *  16  另起一处 `8600` 字面量（哪怕当前那句派生还在）⇒ 第二产地已经开始漂
 *  17  `SEARCH_INDEX_PORT` 漂 ⇒ 网关照着它拼出来的地址指向没人监听的端口
 *
 * ⚠️ 「被视作后台进程」与「内嵌进 slime」两条由 A-1137 / A-1138 各自守；本组只管**网关这一跳**。
 * ⚠️ 本组只跑 `tests/gui/a1141-search-gateway.spec.ts`（**真起索引服务 + 真注入请求**），
 *    不跑全量 —— 判据必须锚在"这一跳"的行为上。
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 `_run-mut-batch.sh` 逐条跑。
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行（剥 ANSI 之后）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号 —— 一律「」（本仓已重复踩这个坑）。
 * ⚠️ 本文件必须是 **LF**（`check-mut-anchors.mjs` 按字节切锚点）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1141-search-gateway.spec.ts"];

const F_GW = "gateway-ts/src/index.ts";
const F_MGR = "gui/src/main/llmGateway.ts";
const F_SVC = "gui/src/main/searchIndexService.ts";

const TARGETS = [F_GW, F_MGR, F_SVC];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1141");

const MUTATIONS = [
  /* ───── ① 路由挂载的边界：没配地址就必须没这组路由 ───── */
  {
    name: "1 gateway：路由**永远挂着**（searchBase 判据写死成真）⇒ 没配地址也把检索端点暴露出去",
    file: F_GW,
    mutate: (t) => sub(t, "  if (searchBase) {", "  if (true) {"),
  },

  /* ───── ② 认证边界：检索能读到全部收录内容，绝不能裸奔 ───── */
  {
    name: "2 gateway：检索路由被塞进**认证豁免**（挂路由 ≠ 开豁免，这两件事被合成一件）",
    file: F_GW,
    mutate: (t) => sub(t, "    const proxySearch = async (",
      "    exempt.add(\"/v1/search\");\n\n    const proxySearch = async ("),
  },
  {
    name: "3 gateway：豁免集合**初始化时**就带上检索（走 Set 初值而不是 exempt.add ⇒ 绕过形状判据）",
    file: F_GW,
    mutate: (t) => sub(t, "  const exempt = new Set(cfg.authExempt ?? DEFAULT_AUTH_EXEMPT);",
      "  const exempt = new Set([...(cfg.authExempt ?? DEFAULT_AUTH_EXEMPT), \"/v1/search\"]);"),
  },

  /* ───── ③ 上游不可达必须出声 ───── */
  {
    name: "4 gateway：上游不可达**吞成 200**（调用方以为拿到了结果，实际什么都没有）",
    file: F_GW,
    mutate: (t) => sub(t,
      '        return reply.code(502).send({\n          error: { message: `自建索引服务不可达（${searchBase}）：${msg}`, type: "search_unavailable" },\n        });',
      '        return reply.code(200).send({\n          error: { message: `自建索引服务不可达（${searchBase}）：${msg}`, type: "search_unavailable" },\n        });'),
  },
  {
    name: "5 gateway：不可达的 `error.type` 漂成一般错误 ⇒ 调用方分不出「索引没起来」",
    file: F_GW,
    mutate: (t) => sub(t,
      '          error: { message: `自建索引服务不可达（${searchBase}）：${msg}`, type: "search_unavailable" },',
      '          error: { message: `自建索引服务不可达（${searchBase}）：${msg}`, type: "upstream_error" },'),
  },
  {
    name: "6 gateway：不可达的 message **丢掉上游地址** ⇒ 用户查不出到底连的是谁",
    file: F_GW,
    mutate: (t) => sub(t,
      '          error: { message: `自建索引服务不可达（${searchBase}）：${msg}`, type: "search_unavailable" },',
      '          error: { message: `自建索引服务不可达：${msg}`, type: "search_unavailable" },'),
  },

  /* ───── ④ 薄代理的判据 = 逐字透出（不许翻译 / 不许截断查询串 / 不许改状态码）───── */
  {
    name: "7 gateway：回包被**加工**（多一个 via 键）⇒ 页面与网关成了两份事实",
    file: F_GW,
    mutate: (t) => sub(t,
      '        reply.code(upstream.status).header("Content-Type", "application/json; charset=utf-8");\n        return reply.send(raw);',
      '        reply.code(upstream.status).header("Content-Type", "application/json; charset=utf-8");\n        return reply.send({ ...(JSON.parse(raw) as Record<string, unknown>), via: "gateway" });'),
  },
  {
    name: "8 gateway：查询串不再透传（丢掉 q / page / size）⇒ 检索变成「永远空查询」",
    file: F_GW,
    mutate: (t) => sub(t,
      '      const rawUrl = req.raw.url ?? "/v1/search";\n      const qi = rawUrl.indexOf("?");\n      return proxySearch(`/search${qi >= 0 ? rawUrl.slice(qi) : ""}`, "GET", undefined, reply);',
      '      void req;\n      return proxySearch("/search", "GET", undefined, reply);'),
  },
  {
    name: "9 gateway：`/v1/search/status` 挂到别的上游路径 ⇒ 网关报的不是那份索引状态",
    file: F_GW,
    mutate: (t) => sub(t, 'proxySearch("/status", "GET", undefined, reply)',
      'proxySearch("/health", "GET", undefined, reply)'),
  },
  {
    name: "10 gateway：上游的**失败状态码**一律改写成 200（空 seeds 的 400 变成「收录已开始」）",
    file: F_GW,
    mutate: (t) => sub(t,
      '        reply.code(upstream.status).header("Content-Type", "application/json; charset=utf-8");',
      '        reply.code(200).header("Content-Type", "application/json; charset=utf-8");'),
  },
  {
    name: "11 gateway：crawl 端点的 HTTP 方法漂（POST→GET）⇒ 路由「看着还在」，调用方却打不进来",
    file: F_GW,
    mutate: (t) => sub(t, '    app.post("/v1/search/crawl", async (req: FastifyRequest, reply) =>',
      '    app.get("/v1/search/crawl", async (req: FastifyRequest, reply) =>'),
  },
  {
    name: "12 gateway：status 路由**整个删掉** ⇒ 网关少一条能力，构建期一个字不报",
    file: F_GW,
    mutate: (t) => sub(t, '    app.get("/v1/search/status", async (_req, reply) => proxySearch("/status", "GET", undefined, reply));',
      "    /* 变异：状态路由被删 */"),
  },
  {
    name: "13 gateway：检索路由路径漂（`/v1/search` → `/v1/searches`）⇒ 调用方一律 404",
    file: F_GW,
    mutate: (t) => sub(t, '    app.get("/v1/search", async (req: FastifyRequest, reply: FastifyReply) => {',
      '    app.get("/v1/searches", async (req: FastifyRequest, reply: FastifyReply) => {'),
  },

  /* ───── ⑤ 端口只有一个产地（llmGateway 从 SEARCH_INDEX_PORT 派生）───── */
  {
    name: "14 manager：地址**硬写 8600**（不再从 SEARCH_INDEX_PORT 派生）⇒ 两个产地，改一处漏一处",
    file: F_MGR,
    mutate: (t) => sub(t, '        searchBaseUrl: `http://127.0.0.1:${SEARCH_INDEX_PORT}`,',
      '        searchBaseUrl: "http://127.0.0.1:8600",'),
  },
  {
    name: "15 manager：**不把索引服务接进网关** ⇒ `/v1/search*` 永远不挂（功能全没，门禁全绿）",
    file: F_MGR,
    mutate: (t) => sub(t, '        searchBaseUrl: `http://127.0.0.1:${SEARCH_INDEX_PORT}`,',
      "        /* 变异：不把索引服务接进网关 */"),
  },
  {
    name: "16 manager：另起一处 8600 字面量（派生那句还在，第二产地已经开始漂）",
    file: F_MGR,
    mutate: (t) => sub(t, "      const app = buildGateway({",
      "      const searchPortLiteral = 8600;\n      const app = buildGateway({"),
  },

  /* ───── ⑥ 契约常量 ───── */
  {
    name: "17 service：`SEARCH_INDEX_PORT` 漂 ⇒ 网关照它拼出的地址指向没人监听的端口",
    file: F_SVC,
    mutate: (t) => sub(t, "export const SEARCH_INDEX_PORT = 8600;",
      "export const SEARCH_INDEX_PORT = 8900;"),
  },
];

/* ---------------- 以下与 mut-a1140-search-params.mjs 同构（同一套校准逻辑） ---------------- */
const arg = process.argv;
const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const p = spawnSync(process.execPath, [
    join(ROOT, "node_modules/.pnpm/vitest@2.1.0_@types+node@24.13.3_supports-color@7.1.0/node_modules/vitest/vitest.mjs"),
    "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot",
  ], { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const out = (p.stdout || "") + (p.stderr || "");
  const spawnBlocked = /EBUSY|EINVAL.*spawn/i.test(out) && /node_modules/.test(out);
  const hasSummary = /Tests\s+\d+\s+(failed|passed)/.test(out.replace(/\u001b\[[0-9;]*m/g, ""));
  return { ok: p.status === 0, out, spawnBlocked, measurementFailed: !hasSummary };
}

const mode = arg.includes("--list") ? "list"
  : arg.includes("--restore") ? "restore"
    : arg.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(arg[arg.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) { console.error("上一轮变异还没还原 —— 先 --restore。"); process.exit(1); }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) { console.error(`❌ 还原校验失败：${man.file}`); process.exit(1); }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* ⚠️ 签名是 `installRestoreOnSignal(targets, root)`（传**路径数组**，不是回调）——
   传回调时它内部 `targets.map` 直接抛，而本环境全量模式本来就跑不到那一行 ⇒ 缺陷会一直潜伏。 */
installRestoreOnSignal(TARGETS, ROOT);

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1141")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中`); missed.push(m.name); continue; }
    writeFileSync(path, next);
    const res = runSpec();
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { for (const t of TARGETS) { writeFileSync(abs(t), originals.get(t)); } }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
