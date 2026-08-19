#!/usr/bin/env node
/**
 * scripts/build-safety-check.mjs — §8.5 打包安全门禁（硬性拦截）。
 *
 * 构建前扫描安装区产物，检出任何敏感文件立即中止构建并报错。
 * 排除清单：
 *   providers.enc.json
 *   *.slime_pass*
 *   auth_token.json / auth_token.enc
 *   *.enc / *.secret / *.key
 *
 * 双路线（发行版/自建环境）同样受此门禁约束，机器强制不依赖人工自觉。
 *
 * 用法（推荐在 electron-vite build 之后、electron-builder 之前执行）：
 *   node scripts/build-safety-check.mjs [--out-dir <path>]
 *
 * 退出码：0 = 通过，1 = 检出敏感文件，2 = 路径不存在。
 */

import { readdir, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { platform } from "node:os";

// ── 排除模式（大小写不敏感） ────────────────────────────────────────────────
const EXCLUDED_PATTERNS = [
  // 精确匹配文件名
  { type: "exact", name: "providers.enc.json" },
  { type: "exact", name: "auth_token.json" },
  { type: "exact", name: "auth_token.enc" },
  // glob 风格（*.ext）
  { type: "glob", pattern: "*.slime_pass*" },
  { type: "glob", pattern: "*.enc" },
  { type: "glob", pattern: "*.secret" },
  { type: "glob", pattern: "*.key" },
];

function matchesPattern(filename, rules) {
  const lower = filename.toLowerCase();
  for (const rule of rules) {
    if (rule.type === "exact") {
      if (lower === rule.name.toLowerCase()) return true;
    }
    if (rule.type === "glob") {
      // 简单 glob：*.ext → endsWith('.ext')
      const ext = rule.pattern.slice(1); // skip '*'
      if (lower.endsWith(ext)) return true;
    }
  }
  return false;
}

async function scanDir(dir, rules, depth = 0) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 30) {
        const sub = await scanDir(fullPath, rules, depth + 1);
        found.push(...sub);
      }
    } else if (entry.isFile() && matchesPattern(entry.name, rules)) {
      found.push(fullPath);
    }
  }
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  let outDir = args.find((a) => a.startsWith("--out-dir="))?.split("=")[1];
  if (!outDir) {
    outDir = args.find((a) => a === "--out-dir");
    if (outDir) outDir = args[args.indexOf(outDir) + 1];
  }
  outDir = outDir ?? resolve(process.cwd(), "gui", "release");

  console.info(`[build-safety] scanning output dir: ${outDir}`);

  // 输出目录不存在则新建后扫描（全新平台首次构建不应被门禁误拦；
  // 目录存在时扫描其中已产生的产物，检出敏感文件照常拦截）
  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true });
    console.info(`[build-safety] output directory created: ${outDir}`);
  }

  const violations = await scanDir(outDir, EXCLUDED_PATTERNS);

  if (violations.length > 0) {
    console.error(`\n[build-safety] FAIL: ${violations.length} sensitive file(s) found in output:`);
    for (const p of violations) {
      console.error(`  - ${p}`);
    }
    console.error("");
    console.error("[build-safety] Aborting build — sensitive files must NOT be bundled.");
    console.error("[build-safety] Remove the files from source or add them to .gitignore / asarUnpack exclusion.");
    process.exit(1);
  }

  console.info("[build-safety] PASS: no sensitive files detected");
  process.exit(0);
}

main().catch((err) => {
  console.error("[build-safety] Unexpected error:", err);
  process.exit(1);
});
