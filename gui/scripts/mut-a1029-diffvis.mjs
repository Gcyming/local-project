#!/usr/bin/env node
/**
 * gui/scripts/mut-a1029-diffvis.mjs — A-1029 变异测试（**改坏必须红**）。
 *
 * 为什么必须跑：A-1029 的两处修复都是"把被吞掉的失败说出来"，而"说出来"这件事
 * **很容易写出一个永远为真的守卫**（比如断言的字符串恰好也在注释里、或断言的是
 * 一个无论如何都存在的外层函数名）。变异测试是唯一能证明这些守卫真的在盯着
 * 目标代码的手段 —— 每条变异都必须让 a1029-guards.spec.ts 变红，否则那条守卫
 * 就是"通过但锁错对象"（本项目反复踩过：A-1019 / A-1023 / A-1025 / A-1027）。
 *
 * 用法：node gui/scripts/mut-a1029-diffvis.mjs
 * 退出码 0 = 全部变异都成功把守卫变红；非 0 = 有变异没能触发失败（守卫无效）。
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const FILES = {
  PROD: "gui/src/renderer/pages/chatProducts.ts",
  PANEL: "gui/src/renderer/pages/ChatPanel.tsx",
  MAIN: "gui/src/main/index.ts",
  SIDE: "gui/src/renderer/pages/RightSidebar.tsx",
  TSCONF: "gui/tsconfig.json",
  TSBASE: "tsconfig.base.json",
  CORECONF: "core-ts/tsconfig.json",
};

/** 逐文件探测 EOL（本仓库 CRLF/LF 混用，含 \n 的锚点在 CRLF 文件里永远匹配不到 —— A-1026） */
function eolOf(src) {
  return src.includes("\r\n") ? "\r\n" : "\n";
}

function read(rel) {
  const p = join(ROOT, rel);
  const text = readFileSync(p, "utf8");
  return { p, text, hash: createHash("sha256").update(text).digest("hex"), eol: eolOf(text) };
}

const originals = {};
for (const [k, rel] of Object.entries(FILES)) { originals[k] = read(rel); }

/** 让锚点按目标文件的 EOL 适配 */
function fit(anchor, eol) {
  return eol === "\n" ? anchor : anchor.replace(/\n/g, eol);
}

const MUTATIONS = [
  // ── ① 阈值回退 = 静默悬崖复现 ────────────────────────────────
  {
    name: "M1 parseDiffFull 默认值退回硬编码 20000",
    file: "PROD",
    from: "export function parseDiffFull(result: string | undefined, maxChars = DIFF_FULL_MAX_RENDER)",
    to: "export function parseDiffFull(result: string | undefined, maxChars = 20000)",
  },
  {
    name: "M2 渲染上限直接压到 20000（常量形式回退）",
    file: "PROD",
    from: "export const DIFF_FULL_MAX_RENDER = 400000;",
    to: "export const DIFF_FULL_MAX_RENDER = 20000;",
  },
  {
    name: "M3 持久化上限大于渲染上限（localStorage 预算失控）",
    file: "PROD",
    from: "export const PRODUCT_DIFF_PERSIST_MAX = 120000;",
    to: "export const PRODUCT_DIFF_PERSIST_MAX = 900000;",
  },

  // ── ② 落盘限流不留痕 ─────────────────────────────────────────
  {
    name: "M4 slimProductsForPersist 变成空操作（超限条目不再摘 diffFull）",
    file: "PROD",
    from: "    if (p.diffFull.old.length + p.diffFull.new.length <= PRODUCT_DIFF_PERSIST_MAX) { return p; }",
    to: "    return p;",
  },
  {
    name: "M5 摘掉 diffFull 但不打 diffTrimmed（回填后一片空白且无解释）",
    file: "PROD",
    from: "    return { ...rest, diffTrimmed: true };",
    to: "    return { ...rest };",
  },
  {
    name: "M6 落盘瘦身就地改对象（内存里那份完整 diffFull 被破坏）",
    file: "PROD",
    from: "    const { diffFull: _drop, ...rest } = p;\n    return { ...rest, diffTrimmed: true };",
    to: "    delete p.diffFull;\n    p.diffTrimmed = true;\n    return p;",
  },

  // ── ③ 落盘入口绕开瘦身 ───────────────────────────────────────
  {
    name: "M7 writeSessionProducts 不再走 slimProductsForPersist",
    file: "PANEL",
    from: "    prev[String(ordinal)] = slimProductsForPersist(products);",
    to: "    prev[String(ordinal)] = products;",
  },

  // ── ④ 失败重新变成静默 ───────────────────────────────────────
  {
    name: "M8 工具卡判据退化成常量（回到静默空白）",
    file: "PANEL",
    /* ⚠️ 第三参从 `false` 变成了 `!!tool.diffTrimmed`（A-1034 后工具卡自带 diffTrimmed，
       判据要按真实来源分流）。锚点必须跟着现场走。 */
    from: '          {diffNoticeKind(diffStat, oldForDiff !== null, !!tool.diffTrimmed) === "too-large" && (',
    to: '          {false && diffNoticeKind(diffStat, oldForDiff !== null, !!tool.diffTrimmed) === "too-large" && (',
  },
  {
    name: "M9 产物卡判据退化成常量（限流又变静默）",
    file: "PANEL",
    from: '              {diffNoticeKind(p.diff, !!p.diffFull, !!p.diffTrimmed) === "trimmed" && (',
    to: '              {false && diffNoticeKind(p.diff, !!p.diffFull, !!p.diffTrimmed) === "trimmed" && (',
  },

  // ── ④b 降级判据本身算错 ──────────────────────────────────────
  {
    name: "M15 diffNoticeKind 优先级颠倒（trimmed 被判成 too-large，话说错重点）",
    file: "PROD",
    from: '  if (trimmed) { return "trimmed"; }\n  if (diff) { return "too-large"; }',
    to: '  if (diff) { return "too-large"; }\n  if (trimmed) { return "trimmed"; }',
  },
  {
    name: "M16 diffNoticeKind 丢掉「有全文就不说话」的短路（有详情还冒出提示）",
    file: "PROD",
    from: "  if (hasFullText) { return null; }\n",
    to: "",
  },

  // ── ⑤ 非 Git 工作区退回原始英文 stderr ───────────────────────
  {
    name: "M10 主进程删掉仓库探测（英文 fatal 又漏给用户）",
    file: "MAIN",
    from: '      const inside = await runGit(["rev-parse", "--is-inside-work-tree"], ws);\n      if (inside.code !== 0 || inside.stdout.trim() !== "true") {',
    to: '      const inside = { code: 0, stdout: "true" };\n      if (inside.code !== 0 || inside.stdout.trim() !== "true") {',
  },  {
    name: "M11 非仓库分支去掉 code（界面无法分流，只能展示一坨文本）",
    file: "MAIN",
    from: '          code: "not-repo",',
    to: '          code: undefined as unknown as "not-repo",',
  },
  {
    name: "M12 非仓库分支不再指路（用户不知道还能去哪看改动）",
    file: "MAIN",
    from: "请用聊天区「写入文件」工具卡里的「变更详情」",
    to: "请稍后重试",
  },
  {
    name: "M13 渲染层不再消费主进程给的 code",
    file: "SIDE",
    from: "          setDiffErrorCode((res?.code as typeof diffErrorCode) ?? \"\");",
    to: "          setDiffErrorCode(\"\");",
  },
  {
    name: "M14 渲染层不再按类别分流（非仓库又变成一屏红字）",
    file: "SIDE",
    from: '        const infoOnly = diffErrorCode === "not-repo" || diffErrorCode === "no-head";',
    to: "        const infoOnly = false;",
  },

  // ── ⑥ A-1030：编译影子可以重新长回来 ─────────────────────────
  {
    name: "M17 gui/tsconfig.json 拿掉 noEmit（裸 tsc 又能把 .js 吐回源码目录）",
    file: "TSCONF",
    from: '    "noEmit": true,\n',
    to: "",
  },
  {
    name: "M19 根 tsconfig.base.json 拿掉 noEmit（污染源重新打开：经测试传递引入的 gui 会被就地 emit）",
    file: "TSBASE",
    from: '    "noEmit": true,\n',
    to: "",
  },
  {
    name: "M20 core-ts/tsconfig.json 拿掉 noEmit:false（构建被根配置连坐成空转）",
    file: "CORECONF",
    from: '    "noEmit": false,\n',
    to: "",
  },
];

/**
 * A-1030 的第二类变异：**新增文件**而不是改文本 —— 往 gui/src 里放回一对
 * `foo.ts` / `foo.js`（= 影子），a1030 守卫必须变红。
 * 这一条是本 spec 存在的理由本身：光"当前没有影子"不等于"影子不会再出现"，
 * 只有把"造一个影子必须被抓住"跑一遍，扫描器才不是死守卫。
 */
const PLANTS = [
  {
    name: "M18 gui/src 里放回一个 .js 影子（测试又会去加载旧代码）",
    ts: "gui/src/renderer/pages/_a1030_probe.ts",
    js: "gui/src/renderer/pages/_a1030_probe.js",
  },
  {
    name: "M21 core-ts/src 里放回一个 .js 影子（gui 主进程打包会命中旧代码）",
    ts: "core-ts/src/_a1030_probe.ts",
    js: "core-ts/src/_a1030_probe.js",
  },
];

function runGuard() {
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run",
      "tests/core-ts/a1029-guards.spec.ts",
      "tests/core-ts/a1030-guards.spec.ts",
      "--reporter=basic",
    ],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env } },
  );
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function restoreAll() {
  for (const [k, o] of Object.entries(originals)) { writeFileSync(o.p, o.text, "utf8"); }
}

function verifyHashes(tag) {
  for (const [k, o] of Object.entries(originals)) {
    const now = createHash("sha256").update(readFileSync(o.p, "utf8")).digest("hex");
    if (now !== o.hash) {
      console.error(`❌ ${tag}：${FILES[k]} 哈希未还原（期望 ${o.hash.slice(0, 12)}，实际 ${now.slice(0, 12)}）`);
      return false;
    }
  }
  return true;
}

let pass = 0;
const failures = [];

// 基线：未变异时必须全绿（否则"变红"没有意义）
{
  const base = runGuard();
  if (base.code !== 0) {
    console.error("❌ 基线失败：未变异时守卫就已报错，先修守卫再跑变异\n" + base.out.slice(-3000));
    process.exit(1);
  }
  console.log(`基线：守卫全绿（未变异）✓\n`);
}

for (const mut of MUTATIONS) {
  const target = originals[mut.file];
  const from = fit(mut.from, target.eol);
  const to = fit(mut.to, target.eol);
  const hit = target.text.split(from).length - 1;
  if (hit !== 1) {
    console.error(`❌ ${mut.name}\n   锚点命中 ${hit} 次（必须恰好 1 次）—— 脚本失效，先修锚点`);
    failures.push(mut.name);
    continue;
  }
  writeFileSync(target.p, target.text.replace(from, to), "utf8");
  const res = runGuard();
  if (res.code === 0) {
    console.error(`❌ ${mut.name}\n   变异后守卫**仍然全绿** → 这条守卫无效（通过但锁错对象）`);
    failures.push(mut.name);
  } else {
    pass += 1;
    console.log(`✓ ${mut.name}`);
  }
  restoreAll();
  if (!verifyHashes(mut.name)) { failures.push(mut.name); }
}

// ── A-1030：造一个影子必须被抓（"当前没有影子"不等于"不会再出现"） ──────
for (const p of PLANTS) {
  const tsP = join(ROOT, p.ts);
  const jsP = join(ROOT, p.js);
  writeFileSync(tsP, "export const probe = 1;\n", "utf8");
  writeFileSync(jsP, "export const probe = 1;\n", "utf8");
  const res = runGuard();
  if (res.code === 0) {
    console.error(`❌ ${p.name}\n   造了影子守卫**仍然全绿** → a1030 的扫描器是死守卫（永远返回空数组）`);
    failures.push(p.name);
  } else {
    pass += 1;
    console.log(`✓ ${p.name}`);
  }
  unlinkSync(tsP);
  unlinkSync(jsP);
}

const TOTAL = MUTATIONS.length + PLANTS.length;
if (failures.length > 0) {
  console.error(`\n${pass}/${TOTAL} 条变异成功变红；以下 ${failures.length} 条有问题：`);
  for (const f of failures) { console.error(`  · ${f}`); }
  process.exit(1);
}
console.log(`\n全部 ${TOTAL} 条变异均成功让守卫变红（且 ${Object.keys(FILES).length} 份源码哈希已还原）✓`);
