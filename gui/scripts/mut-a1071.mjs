/**
 * A-1071 变异测试（#229）：「max_tokens 必须按**实际发出的那个模型**封顶」，逐环改坏要求守卫变红。
 *
 * 覆盖 `tests/core-ts/a1071-maxtokens.spec.ts`。用户原话（Issue）：主 Agent 报「上游错误 400」，
 * 而同一个任务派子代理却正常 —— 一手证据定位为：主链路按「用户选中的模型」的 max_output 下发
 * `max_tokens`，A-158 跨供应商降级换模型后额度仍钉在首选口径 → 落到 agnes（上限 65536）就 400；
 * 而子代理路径（executor → toolLoop.run）**根本不传 max_tokens** → 上游自取默认 → 永不超限。
 *
 * A 组：纯模块判据（`core-ts/src/llm/maxTokens.ts` —— 下压 / 只下压不放大 / 不发明值 /
 *       非法值 / 未收录模型放行 / 不改入参 / 上限来源）
 * B 组：接线事实（`router.withModel` 收口 —— 封顶真的发生、且取的是**本条路由**的模型）
 * C 组：400 判据收窄（`client.isUnrecognizedParamError` —— 越界 400 不再被误判成
 *       「思考参数不被识别」，两段与的关系仍成立）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 * ⚠️ `router.ts` 是 **CRLF**，`maxTokens.ts` / `client.ts` 是 **LF**（同仓行尾是混的）——
 *   一律走共享模块 `_mut-eol.mjs` 的 `sub`，不要自己写替换。
 * ⚠️ 本组变异改的是**源码文本**（守卫按行为跑），所以每条都必须真的改掉被判据作用的那一行，
 *   不允许写「诱饵」（把被锁字串保留、只加一句 `if (false)`）—— 那是假绿（见 mut-a1069 B10 教训）。
 *
 * 用法：node gui/scripts/mut-a1071.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1071-maxtokens.spec.ts";
const MODULE = "core-ts/src/llm/maxTokens.ts";
const ROUTER = "core-ts/src/router.ts";
const CLIENT = "core-ts/src/llm/client.ts";
const TARGETS = [MODULE, ROUTER, CLIENT];

const MUTATIONS = [
  // ── A 纯模块判据（maxTokens.ts）─────────────────────────────────────────────
  {
    name: "A1 下压失效（越界额度原样发出 → 又回到上游 400）",
    file: MODULE,
    mutate: (t) => sub(t, "  return requested > ceiling ? ceiling : requested;", "  return requested;"),
  },
  {
    name: "A2 不是只下压而是对齐上限（给得起 8000 的模型被抬到 65536）",
    file: MODULE,
    mutate: (t) => sub(t, "  return requested > ceiling ? ceiling : requested;", "  return ceiling;"),
  },
  {
    name: "A3 调用方没给额度时发明一个（把「不传=上游默认」改写成替它挑个数字）",
    file: MODULE,
    mutate: (t) => sub(
      t,
      "  if (typeof requested !== \"number\" || !Number.isFinite(requested) || requested <= 0) {",
      "  if (typeof requested !== \"number\" || !Number.isFinite(requested) || requested <= 0) { return maxOutputCeilingOf(modelId);",
    ),
  },
  {
    name: "A4 非法值（0 / 负数 / NaN）不拦（会被当成有效额度发出去）",
    file: MODULE,
    mutate: (t) => sub(
      t,
      "  if (typeof requested !== \"number\" || !Number.isFinite(requested) || requested <= 0) {",
      "  if (typeof requested !== \"number\") {",
    ),
  },
  {
    name: "A5 能力表没有上限的模型也硬塞一个（未收录的模型被打上别人的上限）",
    file: MODULE,
    mutate: (t) => sub(t, "  if (ceiling === undefined) { return requested; }", "  if (ceiling === undefined) { return 65536; }"),
  },
  {
    name: "A6 请求体本来没有 max_tokens 时也塞一个（子代理那条「不传=默认」的安全形态被破坏）",
    file: MODULE,
    mutate: (t) => sub(t, "  if (!(\"max_tokens\" in p)) { return payload; }", "  if (!(\"max_tokens\" in p)) { return { ...(p as object), max_tokens: 65536 } as T; }"),
  },
  {
    name: "A7 就地改写入参（降级链里上一条路由的额度泄漏给下一条）",
    file: MODULE,
    mutate: (t) => sub(
      t,
      "  return { ...payload, max_tokens: capped };",
      "  (payload as Record<string, unknown>).max_tokens = capped;\n  return payload;",
    ),
  },
  {
    name: "A8 上限来源被掐断（maxOutputCeilingOf 恒 undefined → 整套封顶静默失效，而 tsc / 构建全绿）",
    file: MODULE,
    mutate: (t) => sub(t, "  return typeof cap === \"number\" && cap > 0 ? cap : undefined;", "  return undefined;"),
  },
  {
    name: "A9 取错字段（拿上下文长度当输出上限 → agnes 被按 512K 放行）",
    file: MODULE,
    mutate: (t) => sub(t, "  const cap = inferModelCapabilities(modelId ?? \"\").maxOut;", "  const cap = inferModelCapabilities(modelId ?? \"\").context;"),
  },

  // ── B 接线事实（router.withModel 是唯一收口）─────────────────────────────────
  {
    name: "B1 封顶没挂在路由收口（等于没修 —— 守卫 ② 就是为这条而存在）",
    file: ROUTER,
    mutate: (t) => sub(t, "    return applyMaxTokensCap(withReasoning, modelId);", "    return withReasoning;"),
  },
  {
    name: "B2 上限取自请求里那个模型而不是本条路由要发的模型（A-158 降级后正是这个错位）",
    file: ROUTER,
    mutate: (t) => sub(t, "    const modelId = route.model ?? route.name ?? \"\";", "    const modelId = (payload as { model?: string }).model ?? \"\";"),
  },

  // ── C 400 判据收窄（client.isUnrecognizedParamError）────────────────────────
  {
    name: "C1 判据退回宽松版（agnes 越界 400 又被误判成思考参数不被识别 → 白花一次剥参重试 + 埋掉真病因）",
    file: CLIENT,
    mutate: (t) => sub(
      t,
      "  return /(reasoning|thinking|effort|template|enable_thinking|思考|推理)/.test(t);",
      "  return /(param|reasoning|thinking|effort|template|enable_thinking|思考|推理)/.test(t);",
    ),
  },
  {
    name: "C2 收窄过头（真「参数不被识别」不再命中 → 该剥参时不剥，用户白撞 400）",
    file: CLIENT,
    mutate: (t) => sub(
      t,
      "  return /(reasoning|thinking|effort|template|enable_thinking|思考|推理)/.test(t);",
      "  return /(reasoning_effort)/.test(t);",
    ),
  },
  {
    name: "C3 第一段「不认识」网整个不要（凡带 thinking 字样的 400 都被当成参数问题）",
    file: CLIENT,
    mutate: (t) => sub(t, "  if (!reject.test(t)) { return false; }", "  if (false) { return false; }"),
  },
];

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return r.status === 0;
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(join(ROOT, t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(join(ROOT, t))]));
/* 中断即还原：`finally` 在 Ctrl+C 下不展开 —— 不给这道保险，变异会留在源码里，
   下一次跑脚本就会把「变异后的源码」当基线 → 整批变异静默假绿（2026-09-23 实测踩到）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

if (!runSpec()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1071")) { process.exit(1); }

/** 引号自伤自检（A-1056）：**剥注释后**仍出现「CJK + ASCII 双引号 + CJK」才算坏。
 *  ⚠️ 判据必须**两侧都 CJK**（单侧命中是合法的 `it("中文…")`），且必须**先剥注释**。
 *  ⚠️ 只扫**本次写的东西**（新守卫 + 新纯模块 + 本脚本）：整文件扫 `client.ts` 会把
 *     一堆**早就在那儿**的模板串报出来 —— 那是既有代码，不属于本次改动（范围蔓延）。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.split("\n").filter((l) => /[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(l)).map((l) => l.trim().slice(0, 100));
}
for (const rel of [SPEC, MODULE, "gui/scripts/mut-a1071.mjs"]) {
  const bad = quoteSelfHarm(readFileSync(join(ROOT, rel), "utf8"));
  if (bad.length) {
    console.error(`引号自伤自检失败（${rel}）：`);
    for (const b of bad) { console.error(`  - ${b}`); }
    process.exit(1);
  }
}
console.log("行尾检测器自检 + 引号自伤自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const green = runSpec();
    writeFileSync(path, src);
    if (green) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  restoreAll();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(join(ROOT, t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);

console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
