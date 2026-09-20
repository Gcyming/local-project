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
 * 退出码：0 = 通过，1 = 检出敏感文件。输出目录不存在时自动创建。
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, statSync } from "node:fs";
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

// ── 内容扫描：防止明文密钥字符串被打进安装产物（如 Context7 开发 key） ──────────
// 只匹配高信号前缀，避免对依赖/venv 内正常字符串误报；跳过含二进制(null)内容与超大文件。
const CONTENT_LEAK_PATTERNS = [
  { label: "Context7 api key", re: /ctx7sk-[0-9a-f]{8}-[0-9a-f]{4}/i },
];
const CONTENT_SCAN_MAX_BYTES = 2 * 1024 * 1024;

async function scanContent(file) {
  try {
    const st = await stat(file);
    if (st.size <= 0 || st.size > CONTENT_SCAN_MAX_BYTES) return null;
    const buf = await readFile(file);
    if (buf.includes(0)) return null; // binary
    const text = buf.toString("utf8");
    const hit = CONTENT_LEAK_PATTERNS.find((p) => p.re.test(text));
    return hit ? hit.label : null;
  } catch {
    return null;
  }
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
    } else if (entry.isFile()) {
      if (matchesPattern(entry.name, rules)) {
        found.push(`${fullPath}  [文件名命中]`);
      } else {
        const label = await scanContent(fullPath);
        if (label) found.push(`${fullPath}  [内容命中: ${label}]`);
      }
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

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
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
