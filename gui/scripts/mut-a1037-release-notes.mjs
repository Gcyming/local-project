#!/usr/bin/env node
/**
 * gui/scripts/mut-a1037-release-notes.mjs — A-1037 守卫的变异验证。
 *
 * 守卫"通过"只说明它没报错，不说明它**锁住了正确的对象**。这里把 releaseNotes 解析器
 * 逐条改坏（退回本次修掉的四个真缺陷 + 两条安全退化），要求守卫**必须变红**。
 *
 * 用法：node gui/scripts/mut-a1037-release-notes.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
    from: '    .replace(/<\\s*h([1-6])\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*h\\1\\s*>/gi,\n      (_all, lvl: string, body: string) => `\\n${"#".repeat(Number(lvl))} ${body.trim()}\\n`)\n',
    to: "",
  },
  {
    name: "M2 <li> 只当块级换行（列表项退回普通段落）",
    from: '    .replace(/<\\s*li\\b[^>]*>/gi, "\\n- ")\n',
    to: "",
  },
  {
    name: "M3 <hr> 不转换（分隔线被当残余标签剥掉）",
    from: '    .replace(/<\\s*hr\\b[^>]*\\/?\\s*>/gi, "\\n---\\n")\n',
    to: "",
  },
  {
    name: "M4 行内不再递归（**粗体里的 `码`** 把反引号漏进正文）",
    from: "      parseInlineInto(m[2], { ...base, bold: true }, out, depth + 1);",
    to: "      push(m[2], { bold: true });",
  },
  {
    name: "M5 不可信 href 不再过滤（javascript: 直接进 DOM）",
    from: "  return /^https?:\\/\\//i.test(u) ? u : \"\";",
    to: "  return u;",
  },
  {
    name: "M6 script/style 不再剥离（脚本原文进界面）",
    from: '    .replace(/<script\\b[\\s\\S]*?<\\/script\\s*>/gi, "")\n',
    to: "",
  },
  {
    name: "M7 归一化退回「直接 as string」（数组形态渲染出对象）",
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
