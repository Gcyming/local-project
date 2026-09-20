#!/usr/bin/env node
/**
 * gui/scripts/mut-a1034-doczip.mjs — A-1034 守卫的变异验证。
 *
 * 为什么必须做：守卫"通过"只说明它没报错，不说明它**锁住了正确的对象**。
 * 把源码改坏一次，如果守卫仍然绿，那这条守卫就是假防线（本项目最贵的失效模式）。
 *
 * 每条变异：改坏 → 跑守卫 → 必须红 → 还原 → 校验哈希一致。
 * 用法：node gui/scripts/mut-a1034-doczip.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = "tests/core-ts/a1034-guards.spec.ts";

const FILES = {
  zip: "core-ts/src/zip.ts",
  doc: "core-ts/src/doc_text.ts",
  chat: "core-ts/src/services/chat.ts",
  think: "gui/src/renderer/pages/thinkingText.ts",
  panel: "gui/src/renderer/pages/ChatPanel.tsx",
  desktop: "core-ts/src/screen/backends/desktop.ts",
  adb: "gui/src/main/adb.ts",
  prep: "scripts/prepare-runtime.mjs",
};

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const abs = (rel) => resolve(ROOT, rel);

/** 逐条变异：{ 名称, 文件, 原文, 改后 } */
const MUTATIONS = [
  {
    name: "M1 zip-slip 去掉包含性判定（唯一载荷规则）",
    file: "zip",
    from: 'if (target !== base && !target.startsWith(base + sep)) { return null; }',
    to: 'if (false) { return null; }',
  },
  {
    name: "M2 zip-slip 把解压根错当成校验基准（等于不校验）",
    file: "zip",
    from: "const base = resolve(destDir);",
    to: 'const base = resolve(destDir, "..");',
  },
  {
    name: "M3 docx 表格行的列分隔符去掉（结构丢失）",
    file: "doc",
    from: "rows.push(cells.join(\" | \"));",
    to: "rows.push(cells.join(\"\"));",
  },
  {
    name: "M4 pptx 不按页分节（丢掉结构）",
    file: "doc",
    from: "parts.push(`--- 第 ${n} 页 ---\\n${lines.join(\"\\n\")}`);",
    to: "parts.push(lines.join(\"\\n\"));",
  },
  {
    name: "M5 旧版二进制不再明确拒绝（退回吐乱码）",
    file: "doc",
    from: 'if (!isZip(buf)) {\n    throw new Error(',
    to: 'if (false) {\n    throw new Error(',
  },
  {
    name: "M6 留痕不再带 diff 标记（回退成只写工具名）",
    file: "chat",
    from: 'return `- ⟳ ${toolDisplayName(n)}${tag ? ` ${tag}` : ""}`;',
    to: 'return `- ⟳ ${toolDisplayName(n)}`;',
  },
  {
    name: "M7 diff 超限时静默丢弃（不写 trimmed 占位）",
    file: "chat",
    from: 'if (tag.length > TRACE_DIFF_MAX * 1.4) { return DIFF_TRIMMED_TAG; }',
    to: 'if (tag.length > TRACE_DIFF_MAX * 1.4) { return undefined; }',
  },
  {
    name: "M8 解析侧不再拆出 result（历史回看没有 diff）",
    file: "think",
    from: "return { text, result: m[0] };",
    to: "return { text };",
  },
  {
    name: "M9 时间线映射丢掉 result",
    file: "panel",
    from: 'label: t.label, result: t.result, diffTrimmed: t.diffTrimmed }))',
    to: 'label: t.label }))',
  },
  {
    name: "M10 PowerShell 宿主退回裸命令名",
    file: "desktop",
    from: "const host = resolvePowerShellExe();",
    to: 'const host = { exe: "powershell.exe", tried: [] };',
  },
  {
    name: "M11 windows 返回不再强制数组（单窗口会被折叠）",
    file: "desktop",
    from: "windows = @(Get-SlimeWindows)",
    to: "windows = (Get-SlimeWindows)",
  },
  {
    name: "M12 adb 解压退回外部 tar",
    file: "adb",
    from: "const r = extractZipTo(buf, destDir);",
    to: 'const r = extractZipTo(buf, destDir); void 0; execFile("tar", ["-xf", zipPath]); void 0;',
  },
  {
    name: "M13 构建脚本退回裸 exec(\"tar\")",
    file: "prep",
    from: "const TAR = systemExe(isWindows ? \"tar.exe\" : \"tar\");",
    to: 'const TAR = "tar";',
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
  const originals = new Map();
  for (const [k, rel] of Object.entries(FILES)) {
    if (!existsSync(abs(rel))) { console.error(`缺文件: ${rel}`); process.exit(1); }
    originals.set(k, readFileSync(abs(rel), "utf8"));
  }
  const hashes = new Map([...originals].map(([k, v]) => [k, sha(v)]));

  // 基线：守卫必须先绿，否则变异无意义（红了说明本来就有问题）
  const base = runGuard();
  if (!base.ok) {
    console.error("[mut-a1034] 基线守卫未通过，先修守卫再跑变异\n" + base.out.slice(-1500));
    process.exit(1);
  }
  console.info(`[mut-a1034] 基线守卫通过（${originals.size} 份源码已哈希）\n`);

  let red = 0;
  const survivors = [];
  for (const m of MUTATIONS) {
    const rel = FILES[m.file];
    const src = originals.get(m.file);
    if (!src.includes(m.from)) {
      console.error(`[mut-a1034] ${m.name}\n  ✗ 锚点未命中：${rel}`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(abs(rel), src.replace(m.from, m.to));
    const r = runGuard();
    if (r.ok) {
      console.error(`[mut-a1034] ${m.name}\n  ✗ 守卫仍绿 —— 这条守卫没锁住它`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1034] ✓ 变红：${m.name}`);
    }
    writeFileSync(abs(rel), src);
  }

  let restored = true;
  for (const [k, rel] of Object.entries(FILES)) {
    if (sha(readFileSync(abs(rel), "utf8")) !== hashes.get(k)) {
      console.error(`[mut-a1034] ✗ 还原失败: ${rel}`);
      restored = false;
    }
  }

  console.info("");
  if (survivors.length > 0) {
    console.error(`[mut-a1034] ${survivors.length}/${MUTATIONS.length} 条变异**未被守卫捕获**：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1034] 全部 ${MUTATIONS.length} 条变异均成功让守卫变红（${red} 红），`
    + `${restored ? "源码哈希已全部还原 ✓" : "源码还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
