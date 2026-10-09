#!/usr/bin/env node
/**
 * gui/scripts/mut-a1037-release-notes.mjs — A-1037 守卫的变异验证。
 *
 * 守卫"通过"只说明它没报错，不说明它**锁住了正确的对象**。这里把 releaseNotes 解析器
 * 逐条改坏（退回本次修掉的四个真缺陷 + 两条安全退化），要求守卫**必须变红**。
 *
 * 用法：node gui/scripts/mut-a1037-release-notes.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = "tests/gui/release-notes.spec.ts";
const LIB = "gui/src/shared/releaseNotes.ts";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const abs = (rel) => resolve(ROOT, rel);

/** 逐条变异：{ 名称, 期望被哪条断言抓住, 原文, 改后 } */
const MUTATIONS = [
  {
    name: "M1 标题不再转成 # 行（退回「块级标签→换行」，层级丢失）",
    file: LIB,
    from: '    .replace(/<\\s*h([1-6])\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*h\\1\\s*>/gi,\n      (_all, lvl: string, body: string) => `\\n${"#".repeat(Number(lvl))} ${body.trim()}\\n`)\n',
    to: "",
  },
  {
    name: "M2 <li> 只当块级换行（列表项退回普通段落）",
    file: LIB,
    from: '    .replace(/<\\s*li\\b[^>]*>/gi, "\\n- ")\n',
    to: "",
  },
  {
    name: "M3 <hr> 不转换（分隔线被当残余标签剥掉）",
    file: LIB,
    from: '    .replace(/<\\s*hr\\b[^>]*\\/?\\s*>/gi, "\\n---\\n")\n',
    to: "",
  },
  {
    name: "M4 行内不再递归（**粗体里的 `码`** 把反引号漏进正文）",
    file: LIB,
    from: "      parseInlineInto(m[2], { ...base, bold: true }, out, depth + 1);",
    to: "      push(m[2], { bold: true });",
  },
  {
    name: "M5 不可信 href 不再过滤（javascript: 直接进 DOM）",
    file: LIB,
    from: "  return /^https?:\\/\\//i.test(u) ? u : \"\";",
    to: "  return u;",
  },
  {
    name: "M6 script/style 不再剥离（脚本原文进界面）",
    file: LIB,
    from: '    .replace(/<script\\b[\\s\\S]*?<\\/script\\s*>/gi, "")\n',
    to: "",
  },
  {
    name: "M7 归一化退回「直接 as string」（数组形态渲染出对象）",
    file: LIB,
    from: "  if (typeof raw === \"string\") { return raw; }",
    to: "  if (typeof raw === \"string\") { return raw; }\n  if (Array.isArray(raw)) { return raw as unknown as string; }",
  },
];

function runGuard() {
  const r = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", GUARD, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/* ── 骨架：--list / --apply N / --restore ──────────────────────────────────
 * 与 mut-a1091 等同款约定（全仓一致）：全量模式要能派生子进程；跑不了子进程的环境
 * 用「--apply N 改一条并留着 → shell 逐份跑 spec → --restore 还原」证明 RED。
 * ⚠️ --restore **无参可用**，且**变异态下也能跑**（manifest 与备份都在 SAVE_DIR）。
 * ⚠️ 备份走**字节**（Buffer），还原后比 sha256 —— 文本往返会碾碎二进制。
 */
const SAVE_DIR = resolve(ROOT, "gui", "scripts", "_tmp-mut-a1037");
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
  const manifestPath = resolve(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
    const p = abs(m.file);
    const src = readFileSync(p);
    mkdirSync(SAVE_DIR, { recursive: true });
    writeFileSync(resolve(SAVE_DIR, "orig.bin"), src);           // **字节**备份
    const text = src.toString("utf8");
    if (!text.includes(m.from)) {
      console.error(`锚点未命中：${m.name}`);
      rmSync(SAVE_DIR, { recursive: true, force: true });
      process.exit(1);
    }
    const next = text.replace(m.from, m.to);
    if (next === text) {
      console.error(`变异无效果（改了等于没改）：${m.name}`);
      rmSync(SAVE_DIR, { recursive: true, force: true });
      process.exit(1);
    }
    writeFileSync(p, next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(resolve(SAVE_DIR, "orig.bin")));
  const now = createHash("sha256").update(readFileSync(abs(man.file))).digest("hex");
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

function main() {
  if (!existsSync(abs(LIB))) { console.error(`缺文件: ${LIB}`); process.exit(1); }
  const original = readFileSync(abs(LIB), "utf8");
  const before = sha(original);

  const base = runGuard();
  if (!base.ok) {
    console.error("[mut-a1037] 基线守卫未通过，先修守卫再跑变异\n" + base.out.slice(-1500));
    process.exit(1);
  }
  console.info("[mut-a1037] 基线守卫通过\n");

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    if (!original.includes(m.from)) {
      console.error(`[mut-a1037] ${m.name}\n  ✗ 锚点未命中`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(abs(LIB), original.replace(m.from, m.to));
    const r = runGuard();
    if (r.ok) {
      console.error(`[mut-a1037] ${m.name}\n  ✗ 守卫仍绿 —— 这条守卫没锁住它`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1037] ✓ 变红：${m.name}`);
    }
    writeFileSync(abs(LIB), original);
  }

  const restored = sha(readFileSync(abs(LIB), "utf8")) === before;
  console.info("");
  if (survivors.length > 0) {
    console.error(`[mut-a1037] ${survivors.length}/${MUTATIONS.length} 条变异**未被守卫捕获**：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1037] 全部 ${MUTATIONS.length} 条变异均成功让守卫变红（${red} 红），`
    + `${restored ? "源码哈希已还原 ✓" : "源码还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
