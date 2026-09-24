#!/usr/bin/env node
/**
 * gui/scripts/mut-a1092.mjs — A-1092 守卫的变异验证。
 *
 * 本轮修/建四件事，每件都有"下一个人顺手写回去、而且全都不报错"的退化形态：
 *
 * | 组 | 缺陷 | 用户看到什么 |
 * |---|---|---|
 * | 图标 | AUMID 未提前声明 / 窗口 icon 传路径字符串 | 任务栏图标是白块，托盘却正常 |
 * | 手填 | `resolveRpm` 退回三层（手填被无视） | 「我明明填了 RPM，还是被限流」 |
 * | 手填 | 白名单重建漏字段 | 「填了，刷新/重启后没了」（静默丢弃） |
 * | 能力表 | 把「并发/QPS」当 RPM 抄进表 | 高估额度 → 变相关掉限流；或凭空限死用户 |
 *
 * ## 覆盖的十四条
 *
 *   1~2   四层取值退化成三层 / 手填被声明压过（顺序写反）
 *   3     手填坏值不再降级为"没填"（0/负数被当成真额度 ⇒ 全锁死）
 *   4     `setManualRpmOf` 注入被忽略（resolve 直接读 declaredOf）
 *   5     手填解析器抛错不再兜住（一个坏解析器炸掉所有请求）
 *   6     引擎不再接线上手填（bindManualRpm 调用被删）
 *   7~8   AUMID 提前声明被删 / 窗口 icon 退回路径字符串
 *   9     `resolveAppIconImage` 解码失败不再出声（静默空白）
 *   10    sanitizeModels 不再透传 rpm（每次读盘静默抹掉）
 *   11    saveProvider 整条重写丢掉 provider 级 rpm
 *   12    refresh 的模型重建丢掉 prev?.rpm
 *   13    DeepSeek 被塞进一个"并发数当 RPM"的假值
 *   14    Cohere 被写成生产档 500（免费用户被限流而不自知）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1092.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1092.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1092.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1092.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1092-guards.spec.ts"];

const F_LIMITER = "core-ts/src/llm/rpmLimiter.ts";
const F_ENGINE = "core-ts/src/services/engine.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_PROVIDERS = "gui/src/main/providers.ts";
const F_CAPS = "shared/gen/model-capabilities.ts";
const F_ROUTER = "core-ts/src/router.ts";
const TARGETS = [F_LIMITER, F_ENGINE, F_MAIN, F_PROVIDERS, F_CAPS, F_ROUTER];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1092");

const MUTATIONS = [
  /* ── ① 四层取值 ─────────────────────────────────────────────────── */
  {
    name: "1 手填层被删（退回三层：用户的兜底值永远不生效）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      '  if (usableRpm(manual)) { return { rpm: manual, source: "manual" }; }\n',
      "",
    ),
  },
  {
    name: "2 手填与声明顺序写反（内置表的通用猜测压过用户自己的设定）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      '  if (usableRpm(manual)) { return { rpm: manual, source: "manual" }; }\n  if (usableRpm(declared)) { return { rpm: declared, source: "declared" }; }',
      '  if (usableRpm(declared)) { return { rpm: declared, source: "declared" }; }\n  if (usableRpm(manual)) { return { rpm: manual, source: "manual" }; }',
    ),
  },
  {
    name: "3 手填坏值不再降级为「没填」（0/负数被当成真额度 ⇒ 全部锁死）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      "  return typeof v === \"number\" && Number.isFinite(v) && v >= 1;",
      "  return typeof v === \"number\" && Number.isFinite(v);",
    ),
  },

  /* ── ② 限流器接线 ───────────────────────────────────────────────── */
  {
    name: "4 setManualRpmOf 注入被忽略（resolve 永远读不到手填）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      "  setManualRpmOf(fn: (key: string, model: string | undefined) => number | null | undefined): void {\n    this.manualOf = fn;\n  }",
      "  setManualRpmOf(fn: (key: string, model: string | undefined) => number | null | undefined): void {\n    void fn; // 变异：注入被吞掉\n  }",
    ),
  },
  {
    name: "5 手填解析器抛错不再兜住（一个坏解析器炸掉所有上游请求）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      "    } catch {\n      // 手填解析器抛错绝不拖垮请求（与 observe 同一纪律）——降级为\"没有手填\"\n      manual = null;\n    }",
      "    } catch (e) {\n      throw e; // 变异：不再兜住\n    }",
    ),
  },
  {
    name: "6 引擎不再把手填解析器接到共享限流器上（兜底链路断掉）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "    this.bindManualRpm();\n",
      "",
    ),
  },

  /* ── ③ 任务栏图标 ───────────────────────────────────────────────── */
  {
    name: "7 AUMID 不再提前声明（任务栏拿不到安装版快捷方式的图标）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "  app.setAppUserModelId(APP_AUMID);\n\n  // 单实例锁",
      "  // 变异：AUMID 声明被删\n\n  // 单实例锁",
    ),
  },
  {
    name: "8 窗口 icon 退回路径字符串（系统重新采样，小尺寸糊成白块）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    icon: resolveAppIconImage(),",
      "    icon: resolveAppIcon(),",
    ),
  },
  {
    name: "9 resolveAppIconImage 解码失败不再出声（静默变成空白图标）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "  console.warn(`[gui:main] 窗口图标 nativeImage 解码失败（${p}），交由 Electron 兜底`);\n",
      "",
    ),
  },

  /* ── ④ 手填落库链路（静默丢弃）───────────────────────────────────── */
  {
    name: "10 sanitizeModels 不再透传 rpm（每次读盘静默抹掉手填）",
    file: F_PROVIDERS,
    mutate: (t) => sub(
      t,
      '        rpm: typeof (rawM as any).rpm === "number" && Number.isFinite((rawM as any).rpm) && (rawM as any).rpm >= 1\n          ? Math.floor((rawM as any).rpm) : undefined,\n',
      "",
    ),
  },
  {
    name: "11 saveProvider 整条重写丢掉 provider 级 rpm",
    file: F_PROVIDERS,
    mutate: (t) => sub(
      t,
      "    ...(nextRpm !== undefined ? { rpm: nextRpm } : {}),",
      "",
    ),
  },
  {
    name: "12 refresh 的模型重建丢掉 prev?.rpm（一键刷新抹掉手填）",
    file: F_PROVIDERS,
    mutate: (t) => sub(
      t,
      "    return { ...m, selected: prevSelected.has(m.id), rpm: prev?.rpm, ...(prev ? mergeModelPrice(prev, m) : {}) };",
      "    return { ...m, selected: prevSelected.has(m.id), ...(prev ? mergeModelPrice(prev, m) : {}) };",
    ),
  },

  /* ── ⑤ 能力表不许塞假 RPM（反向）────────────────────────────────── */
  {
    name: "13 DeepSeek 被塞进「并发数当 RPM」的假值（高估额度 ⇒ 变相关掉限流）",
    file: F_CAPS,
    mutate: (t) => sub(
      t,
      '  {\n    key: "deepseek",\n    label: "DeepSeek（V4.1 Flash / V4 Pro）",\n',
      '  {\n    key: "deepseek",\n    label: "DeepSeek（V4.1 Flash / V4 Pro）",\n    rpm: 2500,\n',
    ),
  },
  {
    name: "14 Cohere 被写成生产档 500（免费试用用户被限流而不自知）",
    file: F_CAPS,
    mutate: (t) => sub(
      t,
      '    rpm: 20,\n    models: [\n      { match: "cohere|command", thinking: true, efforts: ["low", "medium", "high"] },',
      '    rpm: 500,\n    models: [\n      { match: "cohere|command", thinking: true, efforts: ["low", "medium", "high"] },',
    ),
  },

  /* ── ⑥ Agent-Loop 单点布置（架构判据）────────────────────────────── */
  {
    name: "15 限流身份丢掉 model（降级换模型后仍按旧模型档位限流 —— A-1071 同型缺陷）",
    file: "core-ts/src/router.ts",
    mutate: (t) => sub(
      t,
      "    rateLimit: { key: providerKeyOfRoute(route), model: route.model },",
      "    rateLimit: { key: providerKeyOfRoute(route) },",
    ),
  },
  {
    name: "16 限流器不再共享单例（各层各持一份窗口 ⇒ 合起来超限）",
    file: F_LIMITER,
    mutate: (t) => sub(
      t,
      "  if (!shared) { shared = new RpmLimiter(); }\n  return shared;",
      "  return new RpmLimiter();",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1092")) { process.exit(1); }
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
