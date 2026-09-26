#!/usr/bin/env node
/**
 * gui/scripts/mut-a1108.mjs — A-1108（全局降级池改用户自定义、默认空）的变异验证。
 *
 * ## 修的是
 *
 * 用户原话：「我比较关注的是那个全局降级池，我都没设置，是哪来的？如果是编码的时候默认
 * 写入的话，请改一下，改成用户自定义编辑降级池，默认无降级池，放在通用设置里面。」
 *
 * 事实：那份池**不是**配置文件写进去的，是 `engine.ts` `resolveRouteInternal` 里
 * `const others = Object.entries(this.providers).filter(...)` 把其它所有已配置供应商的
 * 启用模型自动塞进降级链（旧日志 `[engine] 注入全局降级池（N 个候选）`）。
 * 现在判据唯一出处 = `core-ts/src/services/fallbackPool.ts`，默认空池（不降级，失败如实报错）。
 *
 * ## 覆盖的条目（每条都在问：动了哪一条判据会**静默退化**）
 *
 *   1      `resolveFallbackTargets` 丢掉 `!providers` 守卫（providers 为 null 时直接 TypeError）
 *   2      丢掉「条目 provider === 首选」的丢弃（首选自身多模型 = 两个产地）
 *   3      丢掉「本地模型伪供应商」的丢弃（local: 分支的事被塞进 api: 降级链）
 *   4      丢掉 `isChatCapable` 过滤（图片/视频模型混进对话降级链）
 *   5      丢掉 `selected === false` 过滤（用户在面板里关掉的模型仍被降级用到）
 *   6      `sanitizeFallbackPool` 丢掉去重（同一条目重复出现，顺序 = 优先级被稀释）
 *   7      `sanitizeFallbackPool` 丢掉上限（降级池从兜底变成第二条主链）
 *   8      `sanitizeFallbackPool` 放行空 provider/model（磁盘上出现非法条目）
 *   9      `readFallbackPool` 不再吞异常（一个手写坏的 JSON 就让整条路由链炸掉）
 *  10      `writeFallbackPool` 从**整体替换**退化成**局部合并**（用户删掉的一条自己长回来）
 *  11      `normalizeBase` 不剥末尾 `/v1`（与 engine 既有口径分叉 ⇒ baseUrl 拼错）
 *  12      `apiFormat` 丢掉模型级覆盖（本该按模型选的协议退化成供应商级）
 *  13      `base` 丢掉 http(s) 校验（空串/相对路径被当成 URL 发出去）
 *  14      engine 不读盘（`?? readFallbackPool(...)` → `?? { entries: [] }` ⇒ 配置永不生效）
 *  15      engine 恢复旧自动池（`Object.entries(this.providers)` 全量注入，默认池回来）
 *  16      engine 日志回到误导文案（「注入全局降级池」—— 下一个人会照着它把行为加回来）
 *  17      engine 重新 import `LOCAL_MODELS_KEY`（第二份「跳过本地伪供应商」规则）
 *  18      engine 读了池却不注入（`for (const t of [] as typeof poolTargets)`）
 *  19      主进程 get 不返回 providers（界面下拉永远空 ⇒「加入降级池」永远禁用）
 *  20      主进程 set 把用户输入丢了（`writeFallbackPool(...)` → 直接回读旧值 = 保存无效）
 *  21      主进程硬编码 `fallback-pool.json`（文件名第二产地，改名即静默错位）
 *  22      preload get 频道名漂移（invoke reject ⇒ 记忆 A-1100 的「按钮没反应 + 控制台红字」）
 *  23      preload set 频道名漂移（同上，写通道整条断掉）
 *  24      界面「加入」不生效（`[...fbEntries, {provider, model}]` → `[...fbEntries]`）
 *  25      界面「移除」反了（`i !== index` → `i === index`：点移除只剩下那一条）
 *  26      界面文案承诺不存在的自动行为（出现「自动降级」—— 与实现相反）
 *  27      界面脚注与常量脱钩（落盘文件名不再出现在提示里，改名无人提醒）
 *  28      界面读盘那条守卫写错（`?.get` → `?.fetch`：判空恒假 ⇒ 永远显示空池）
 *  29      界面默认空池文案被改成会自动兜底（正面断言「默认是空的」失效）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 多行锚点一律走 `sub`（行尾无关）—— 本仓行尾是**混的**
 *    （实测：fallbackPool.ts / engine.ts / main/index.ts 是 LF，preload/index.ts /
 *     GeneralPanel.tsx 是 CRLF）。
 * ⚠️ **判据 = exit≠0 且输出里真有 `Tests` 汇总行**。只有 exit≠0 时，
 *    「vitest 启动失败 / 配置加载失败」会被误当成「变异被捕获」——
 *    实测踩过：从 `gui/` 跑会加载 `gui/vite.config.ts`（electron-vite）⇒ Startup Error、
 *    零测试执行，退出码却是 1，于是整批变异报「全捕获」而实际一条都没测。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1108.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1108.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1108.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1108.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1108-fallback-pool.spec.ts",
  "tests/core-ts/engine.spec.ts",
];

const F_POOL = "core-ts/src/services/fallbackPool.ts";
const F_ENGINE = "core-ts/src/services/engine.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_PRELOAD = "gui/src/preload/index.ts";
const F_PANEL = "gui/src/renderer/pages/GeneralPanel.tsx";
const TARGETS = [F_POOL, F_ENGINE, F_MAIN, F_PRELOAD, F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1108");

const MUTATIONS = [
  /* ── core-ts/src/services/fallbackPool.ts：解析与落盘（判据唯一出处）── */
  {
    name: "1 `resolveFallbackTargets` 丢掉 `!providers` 守卫（providers 为 null 时直接 TypeError，而不是回空池）",
    file: F_POOL,
    mutate: (t) => sub(
      t,
      "if (entries.length === 0 || !providers) { return []; }",
      "if (entries.length === 0) { return []; }",
    ),
  },
  {
    name: "2 丢掉「条目 provider === 首选」的丢弃（首选自身多模型由 ① 段注入 ⇒ 两个产地）",
    file: F_POOL,
    mutate: (t) => sub(
      t,
      "if (provider === primaryKey || provider === LOCAL_MODELS_KEY) { continue; }",
      "if (provider === LOCAL_MODELS_KEY) { continue; }",
    ),
  },
  {
    name: "3 丢掉「本地模型伪供应商」的丢弃（local: 分支的事被塞进 api: 降级链）",
    file: F_POOL,
    mutate: (t) => sub(
      t,
      "if (provider === primaryKey || provider === LOCAL_MODELS_KEY) { continue; }",
      "if (provider === primaryKey) { continue; }",
    ),
  },
  {
    name: "4 丢掉 `isChatCapable` 过滤（图片/视频/embedding 模型混进对话降级链）",
    file: F_POOL,
    mutate: (t) => sub(t, "    if (!opts.isChatCapable(model)) { continue; }\n", ""),
  },
  {
    name: "5 丢掉 `selected === false` 过滤（用户在供应商面板里关掉的模型仍被降级用到）",
    file: F_POOL,
    mutate: (t) => sub(t, "    if (listed && listed.selected === false) { continue; }\n", ""),
  },
  {
    name: "6 `sanitizeFallbackPool` 丢掉去重（同一条目重复出现，顺序 = 优先级被稀释）",
    file: F_POOL,
    mutate: (t) => sub(
      t,
      "    if (seen.has(key)) { continue; }\n    seen.add(key);\n    out.push({ provider, model });",
      "    seen.add(key);\n    out.push({ provider, model });",
    ),
  },
  {
    name: "7 `sanitizeFallbackPool` 丢掉上限（降级池从「兜底」变成「第二条主链」）",
    file: F_POOL,
    mutate: (t) => sub(t, "    if (out.length >= FALLBACK_POOL_MAX) { break; }\n", ""),
  },
  {
    name: "8 `sanitizeFallbackPool` 放行空 provider/model（磁盘上出现非法条目）",
    file: F_POOL,
    // ⚠️ 锚点必须带上一行：`resolveFallbackTargets` 里有一模一样的
    //   `if (!provider || !model) { continue; }`（同族语句 ⇒ 只看那一行是 2 处命中）。
    mutate: (t) => sub(
      t,
      "    const model = typeof m === \"string\" ? m.trim() : \"\";\n    if (!provider || !model) { continue; }",
      "    const model = typeof m === \"string\" ? m.trim() : \"\";",
    ),
  },
  {
    name: "9 `readFallbackPool` 不再吞异常（一个手写坏的 JSON 就让整条路由链炸掉）",
    file: F_POOL,
    mutate: (t) => sub(
      t,
      "  } catch {\n    return { entries: [] };\n  }",
      "  } catch (e) {\n    throw e;\n  }",
    ),
  },
  {
    name: "10 `writeFallbackPool` 从**整体替换**退化成**局部合并**（用户删掉的一条自己长回来）",
    file: F_POOL,
    mutate: (t) => sub(
      t,
      "  const next = sanitizeFallbackPool(patch);\n  mkdirSync(join(root, \"config\"), { recursive: true });",
      "  const prev = readFallbackPool(root);\n  const pEntries = Array.isArray(patch.entries) ? patch.entries : [];\n  const next = sanitizeFallbackPool({ entries: [...prev.entries, ...pEntries] });\n  mkdirSync(join(root, \"config\"), { recursive: true });",
    ),
  },
  {
    name: "11 `normalizeBase` 不剥末尾 `/v1`（与 engine 既有口径分叉 ⇒ baseUrl 拼成 …/v1/v1）",
    file: F_POOL,
    mutate: (t) => sub(t, 'return s.endsWith("/v1") ? s.slice(0, -3) : s;', "return s;"),
  },
  {
    name: "12 `apiFormat` 丢掉模型级覆盖（本该按模型选的协议退化成供应商级）",
    file: F_POOL,
    mutate: (t) => sub(
      t,
      "apiFormat: asApiFormat(listed?.api_format) ?? asApiFormat(cfgP.api_format),",
      "apiFormat: asApiFormat(cfgP.api_format),",
    ),
  },
  {
    name: "13 `base` 丢掉 http(s) 校验（空串/相对路径被当成 URL 发出去）",
    file: F_POOL,
    mutate: (t) => sub(
      t,
      "if (!base || !/^https?:\\/\\//i.test(base)) { continue; }",
      "if (!base) { continue; }",
    ),
  },

  /* ── core-ts/src/services/engine.ts：接线（读盘 + 默认空池）── */
  {
    name: "14 engine 不读盘（`?? readFallbackPool(...)` → `?? { entries: [] }` ⇒ 设置里改完永不生效）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "return this.fallbackPoolOverride ?? readFallbackPool(this.fallbackPoolRoot ?? PROJECT_ROOT);",
      "return this.fallbackPoolOverride ?? { entries: [] };",
    ),
  },
  {
    name: "15 engine 恢复旧自动池（遍历其它所有供应商自动注入 ⇒ 用户没设过它又冒出来了）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "      const poolTargets = resolveFallbackTargets(this.currentFallbackPool(), this.providers, key, {\n        isChatCapable: isChatCapableModel,\n      });",
      "      const others = Object.entries(this.providers).filter(([k]) => k !== key);\n      const poolTargets = others.map(([k, c]) => ({ provider: k, model: String((c as { model?: string }).model ?? \"\"), base: String((c as { api_base?: string }).api_base ?? \"\"), apiKey: (c as { api_key?: string }).api_key as string | undefined, apiFormat: undefined as never }));",
    ),
  },
  {
    name: "16 engine 日志回到误导文案（「注入全局降级池」—— 下一个人照着它把行为加回来）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "未配置全局降级池", "注入全局降级池"),
  },
  {
    name: "17 engine 重新 import `LOCAL_MODELS_KEY`（第二份「跳过本地伪供应商」规则）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      'import { findLocalModelSpec, type LocalModelSpec } from "../local_models.js";',
      'import { findLocalModelSpec, LOCAL_MODELS_KEY, type LocalModelSpec } from "../local_models.js";',
    ),
  },
  {
    name: "18 engine 读了池却不注入（`for (const t of [] as typeof poolTargets)`：配置被静默忽略）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "      let bias = 900;\n      for (const t of poolTargets) {",
      "      let bias = 900;\n      for (const t of [] as typeof poolTargets) {",
    ),
  },

  /* ── gui/src/main/index.ts：读写 + 消毒（不许自己造池、不许硬编码文件名）── */
  {
    name: "19 主进程 get 不返回 providers（界面下拉永远空 ⇒「加入降级池」永远禁用）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    return { ok: true, entries: readFallbackPool().entries, providers: listProviders() };",
      "    return { ok: true, entries: readFallbackPool().entries };",
    ),
  },
  {
    name: "20 主进程 set 把用户输入丢了（不写盘、直接回读旧值 ⇒ 保存静默无效）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "      const next = writeFallbackPool({ entries: p?.entries });",
      "      const next = readFallbackPool();",
    ),
  },
  {
    name: "21 主进程硬编码 `fallback-pool.json`（文件名第二产地，改名即静默错位）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "// A-1108：全局降级池（设置 → 通用）。判据唯一出处是 core-ts 的 fallbackPool 模块",
      "// A-1108：全局降级池（设置 → 通用）。配置写在 config/fallback-pool.json，判据唯一出处是 core-ts 的 fallbackPool 模块",
    ),
  },

  /* ── gui/src/preload/index.ts：频道名（裸串，与 ipc.ts 常量必须同值）── */
  {
    name: "22 preload get 频道名漂移（invoke reject ⇒「按钮没反应」+ 控制台红字）",
    file: F_PRELOAD,
    mutate: (t) => sub(
      t,
      'ipcRenderer.invoke("slime:fallback:get")',
      'ipcRenderer.invoke("slime:fallback:read")',
    ),
  },
  {
    name: "23 preload set 频道名漂移（写通道整条断掉，同样是静默失效）",
    file: F_PRELOAD,
    mutate: (t) => sub(
      t,
      'ipcRenderer.invoke("slime:fallback:set", { entries })',
      'ipcRenderer.invoke("slime:fallback:write", { entries })',
    ),
  },

  /* ── gui/src/renderer/pages/GeneralPanel.tsx：设置界面（用户点名「放在通用设置里面」）── */
  {
    name: "24 界面「加入」不生效（提交的数组里没有新条目 ⇒ 点了没反应）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "void saveFallbackEntries([...fbEntries, { provider, model }]",
      "void saveFallbackEntries([...fbEntries]",
    ),
  },
  {
    name: "25 界面「移除」反了（`i !== index` → `i === index`：点移除反而只剩下那一条）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "fbEntries.filter((_, i) => i !== index)",
      "fbEntries.filter((_, i) => i === index)",
    ),
  },
  {
    name: "26 界面文案承诺不存在的自动行为（出现「自动降级」—— 与「默认空池」的实现相反）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "首选供应商<b>整体</b>不可用（整池限流、下线）时，按这里的顺序改用别的供应商与模型。",
      "首选供应商<b>整体</b>不可用（整池限流、下线）时会自动降级到别的供应商与模型。",
    ),
  },
  {
    name: "27 界面脚注与常量脱钩（落盘文件名不再出现在提示里 ⇒ 改名时没人被提醒改文案）",
    file: F_PANEL,
    mutate: (t) => sub(t, "落盘 config/fallback-pool.json；", "落盘配置文件；"),
  },
  {
    name: "28 界面读盘那条守卫写错（`?.get` → `?.fetch`：判空恒假 ⇒ 永远显示空池）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "if (api.current?.fallback?.get) {",
      "if (api.current?.fallback?.fetch) {",
    ),
  },
  {
    name: "29 界面默认空池文案被改成「会自动兜底」（与实现相反，且正面断言失效）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "<b>默认是空的 —— 不配就不跨供应商降级</b>",
      "<b>默认会自动兜底 —— 配了才不跨供应商降级</b>",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * 跑一份 spec，返回 `{ ok }` / `{ measurementFailed, out }` / `{ spawnBlocked }`。
 *
 * ⚠️ **不能只看 exit code**：vitest 启动失败（配置加载不了）也返回非 0，
 * 那样一批「变异」会被报成「全被捕获」，而实际一条测试都没跑 —— 本仓踩过（§26）。
 * ⇒ 判据 = exit≠0 **且** 输出里真有 `Tests <数字>` 汇总行。
 */
function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
    const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    if (!/\bTests\s+\d+/.test(out)) {
      return { ok: false, measurementFailed: true, spec, out: out.slice(-1500) };
    }
    if (r.status !== 0) { return { ok: false, spawnBlocked: false, spec }; }
  }
  return { ok: true, spawnBlocked: false };
}

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
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
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
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
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

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
  console.error("请改用 --apply / --restore + shell 循环（命令见本文件头部注释）。");
  process.exit(1);
}
if (base.measurementFailed) {
  console.error(`⚠️ 测量工具本身坏了（${base.spec} 的输出里没有 Tests 汇总行）—— 判据不成立，先修工具。`);
  console.error(base.out);
  process.exit(1);
}
if (!base.ok) {
  console.error(`基线未通过（${base.spec}）—— 先修好测试再跑变异。`);
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1108")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.measurementFailed) {
      console.error(`⚠️  测量工具本身坏了（${res.spec} 输出无 Tests 汇总行），本轮判据不成立，中止。`);
      console.error(res.out);
      missed.push(m.name);
      break;
    }
    if (res.ok) {
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

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) {
  console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}（${leftovers.join(", ")}）`);
  process.exit(1);
}
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
