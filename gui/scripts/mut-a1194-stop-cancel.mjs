#!/usr/bin/env node
/**
 * gui/scripts/mut-a1194-stop-cancel.mjs — A-1194「终止按钮」守卫的变异验证。
 *
 * ## 这一轮改的是什么（用户原话）
 * 「现在有时候为什么我的终止按钮加载半天都没反应？有时候模型出问题了我都停不下来。」
 *
 * ## 病根（源码级取证，全部实测复现过的盲区）
 * 终止链路 = renderer 按钮 → `slime:chat:cancel` → AbortController.abort()
 *   → chatService.stream(signal) → engine.stream(signal) → router → client → fetch。
 * 信号全链存在，但**若干等待点不响应 abort**，于是「点了停止按钮还在转圈」：
 *   A. fetchWithRetry 的两次重试退避 sleep 不打断（429 最长 60s/次、表 [5,15,30,60]s）；
 *   B. chromiumFetch 把 abort 的 reject 当普通失败：重试 3 次 → 走系统代理（CONNECT 15s
 *      不看 signal）→ 再 global fetch；且 cf 内层×llm 外层 = 最坏 12 次请求（风控放大器）；
 *   C. RpmLimiter.acquire 的冷却等待不可打断（约 20s）；
 *   D. 传唤 engine.chat / 强制工具轮 runForcedRound 全程无 signal（只能等 5min 超时）；
 *   E. tool_loop 的 Promise.all 要等飞行中工具跑完才轮到 abort 检查。
 * 外加 UI 最后一道防线：stopping 只等流终态事件复位，无看门狗（P6）。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 用户现象（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 429 退避 sleep 摘掉 signal | 撞限流后点停止，最长 60s 无反应 | a1194 ①② |
 * | 2 | 网络错误退避 sleep 摘掉 signal | 网络抖动时点停止要等满退避 | a1194 ③ |
 * | 3 | acquire 去掉 abortableWait 包裹 | 限流冷却期点停止无反应 | a1194 P3 形状 |
 * | 4 | chromiumFetch 退避 sleep 不可中断 | 「模型出问题」时停止延迟叠加 | cf ① |
 * | 5 | 删循环头 abort 检查（防线 6→5） | 降级链在 aborted 后仍发请求 | cf 防线数量形状 |
 * | 6 | net.fetch 去掉 abort 赛跑 | 某版本 Electron 不理 signal ⇒ 停不下来 | cf 形状 |
 * | 7 | 删 connectReqRef 赋值 | CONNECT 阶段（无 signal）最长白等 15s | cf 形状 |
 * | 8 | 传唤 engine.chat 摘掉 signal | 模型卡住时传唤期间停止无效 | a1194 P4 形状 |
 * | 9 | engine.chat 工具轮摘掉 signal | 非流式工具轮停止无效 | a1194 P4 形状 |
 * | 10 | engine.chat 主调用摘掉 signal | 传唤/强制轮的底层请求停不下来 | a1194 P4 形状 |
 * | 11 | router.chat 不把 signal 传 client | 全链断点（同 10，防回归到 router 层） | a1194 P4 形状 |
 * | 12 | 工具执行去掉 abort 短路 | 长工具飞行中停止要等工具跑完 | a1194 P5 |
 * | 13 | 看门狗不再强制复位 | UI 最后防线失守（按钮永远转圈） | a1194 P6 |
 *
 * ⚠️ `name` 的**开头数字必须 == 它在数组里的位置序号**（`check-mut-anchors.mjs` 逐条核对）。
 * ⚠️ 全部锚点走 `sub`（行尾自适应）；**锚必须唯一**——本脚本每条都是"多行长锚"，
 *    核验器报「不唯一」时不得放行（用 `node gui/scripts/check-mut-anchors.mjs` 全量核验）。
 * ⚠️ 变异体必须**保持语法合法**（"停用"某参数就删参数、不删行；删行只删独立语句行）。
 * ⚠️ 变异跑批必须走 `bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1194-stop-cancel.mjs`
 *    （自动读下面的 SPECS；带 trap 兜底还原）。**绝不手写 spec 清单**。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/* 判据 spec 的**唯一产地**：三条 a1194 spec 各钉一段（核心层重试 / 降级链 / UI 看门狗）。 */
const SPECS = [
  "tests/core-ts/a1194-abort-retry.spec.ts",
  "tests/gui/a1194-chromiumfetch-abort.spec.ts",
  "tests/gui/a1194-stop-watchdog.spec.ts",
];

const F_CLIENT = "core-ts/src/llm/client.ts";
const F_PROVIDERS = "gui/src/main/providers.ts";
const F_CHAT = "core-ts/src/services/chat.ts";
const F_ENGINE = "core-ts/src/services/engine.ts";
const F_ROUTER = "core-ts/src/router.ts";
const F_TOOLLOOP = "core-ts/src/tool_loop.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_CLIENT, F_PROVIDERS, F_CHAT, F_ENGINE, F_ROUTER, F_TOOLLOOP, F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1194");

const MUTATIONS = [
  /* ── A. 重试退避必须可被 abort 打断（client.ts 两处 sleep）────────── */
  {
    name: "1 429 退避 sleep 摘掉 signal（撞限流后停止最长 60s 无反应）",
    file: F_CLIENT,
    mutate: (t) => sub(
      t,
      "await sleepAbortable(waitMs, externalSignal);",
      "await sleepAbortable(waitMs);",
    ),
  },
  {
    name: "2 网络错误退避 sleep 摘掉 signal（抖动时停止要等满退避）",
    file: F_CLIENT,
    mutate: (t) => sub(
      t,
      "await sleepAbortable(netWaitMs, externalSignal);",
      "await sleepAbortable(netWaitMs);",
    ),
  },
  {
    name: "3 acquire 去掉 abortableWait 包裹（限流冷却期点停止无反应）",
    file: F_CLIENT,
    mutate: (t) => sub(
      sub(
        t,
        "      await abortableWait(\n        getSharedRpmLimiter().acquire(rateLimit.key, rateLimit.model, (ms) => {",
        "      await getSharedRpmLimiter().acquire(rateLimit.key, rateLimit.model, (ms) => {",
      ),
      "        }),\n        externalSignal,\n      );",
      "        });",
    ),
  },

  /* ── B. chromiumFetch 的 abort 语义（重试/降级/赛跑/CONNECT）───────── */
  {
    name: "4 chromiumFetch 退避 sleep 改成不可中断",
    file: F_PROVIDERS,
    mutate: (t) => sub(
      t,
      "await abortableFetchSleep(delay, signal);",
      "await new Promise((r) => setTimeout(r, delay));",
    ),
  },
  {
    name: "5 删循环头 abort 检查（防线 6→5，aborted 后还会发请求）",
    file: F_PROVIDERS,
    mutate: (t) => sub(
      t,
      "for (let attempt = 0; attempt < FETCH_RETRY_ATTEMPTS; attempt++) {\n      if (signal?.aborted) { throw abortError(); }",
      "for (let attempt = 0; attempt < FETCH_RETRY_ATTEMPTS; attempt++) {",
    ),
  },
  {
    name: "6 net.fetch 去掉 abort 赛跑（Electron 不理 signal 就停不下来）",
    file: F_PROVIDERS,
    mutate: (t) => sub(
      t,
      "raceWithAbort(net.fetch(urlString, init), signal)",
      "net.fetch(urlString, init)",
    ),
  },
  {
    name: "7 删 connectReqRef 赋值（CONNECT 阶段无 abort，最长白等 15s）",
    file: F_PROVIDERS,
    mutate: (t) => sub(
      t,
      "        connectReqRef = connectReq;\n        if (signal) {",
      "        if (signal) {",
    ),
  },

  /* ── D. signal 穿透内部调用（传唤 / 强制轮 / 非流式 chat / 路由）───── */
  {
    name: "8 传唤 engine.chat 摘掉 signal（模型卡住时传唤期间停止无效）",
    file: F_CHAT,
    mutate: (t) => sub(
      t,
      "          signal,\n          networkEnabled: req.networkEnabled,",
      "          networkEnabled: req.networkEnabled,",
    ),
  },
  {
    name: "9 engine.chat 工具轮摘掉 signal（非流式工具轮停止无效）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "sessionId: opts.sessionId, signal: opts.signal, maxToolCalls",
      "sessionId: opts.sessionId, maxToolCalls",
    ),
  },
  {
    name: "10 engine.chat 主调用摘掉 signal（传唤/强制轮请求停不下来）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "router.chat(withModel(payload, route!), opts.signal)",
      "router.chat(withModel(payload, route!))",
    ),
  },
  {
    name: "11 router.chat 不把 signal 传 client（全链断点）",
    file: F_ROUTER,
    mutate: (t) => sub(
      t,
      ".chat(this.withModel(payload, route), signal)",
      ".chat(this.withModel(payload, route))",
    ),
  },

  /* ── E. 工具执行 abort 短路 ─────────────────────────────────────── */
  {
    name: "12 工具执行去掉 abort 短路（长工具飞行中停止要等工具跑完）",
    file: F_TOOLLOOP,
    /* ⚠️ 2026-10-09 锚点重打（A-1198）：runOneTool 调用串加了 agentRole/agentModel 两个身份注入
       参数（git 工具用）⇒ 原锚尾部漂移。变异意图不变：拿掉 abortableToValue 竞跑（abort 短路）。 */
    mutate: (t) => sub(
      t,
      "        return {\n          tc,\n          msg: await abortableToValue(\n            this.runOneTool(tc, agentId, dedup, denials, agentName, agentRole, agentModel, sessionId, signal),\n            signal,\n            \"[已中断] 用户停止生成，工具执行被跳过\",\n          ),\n        };",
      "        return { tc, msg: await this.runOneTool(tc, agentId, dedup, denials, agentName, agentRole, agentModel, sessionId, signal) };",
    ),
  },

  /* ── F. UI 看门狗（最后一道防线）────────────────────────────────── */
  {
    name: "13 看门狗不再强制复位（UI 兜底失守，按钮永远转圈）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      resetStreamUI();\n      setStreamErrorBanner(\"停止等待超时：已强制复位界面，后台收尾可能仍在进行\");",
      "      void 0;",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性；不用裸 { } 块，见 mut-a1190 说明）── */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error(`  - ${b}`); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1194")) { process.exit(1); }

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    let next;
    try { next = m.mutate(text); }
    catch (e) {
      console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式：本环境禁 node→node 孙进程 ⇒ 提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1194-stop-cancel.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 7) { process.exit(1); }
process.exit(1);
