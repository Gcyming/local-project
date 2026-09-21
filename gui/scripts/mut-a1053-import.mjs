#!/usr/bin/env node
/**
 * gui/scripts/mut-a1053-import.mjs — A-1053 守卫（tests/core-ts/imported-skills.spec.ts）的变异验证。
 *
 * 这一族守卫的被测对象是**技能内容本身**（清单 + 正文），不是代码 ——
 * 所以变异也打在内容上。改坏方向都挑「下一个人顺手就会写回去、而且全都不报错」的样子：
 *   - 清单写回 `terminal: false`（今天无害，将来重启脚本执行就静默放行越权）；
 *   - 描述写成块标量头 `>`（自研解析器会把字面量 `">"` 当描述，技能库一条描述都出不来）；
 *   - `name:` 与目录名不一致（技能以别的名字加载，按名字找的人找不到）；
 *   - 正文被清空（技能在列表里，点开却是空的）；
 *   - 清掉清单（权限回落到默认 {read:true}，同上）；
 *   - 无脚本的技能声明 terminal（声明与实际能力反向不符）；
 *   - 去掉 `source:` 溯源（升级/审计时回不到上游）。
 *
/**
 * ⚠️⚠️ 快照 / 还原必须走**字节**，绝不能走文本！
 *
 * 这个脚本一度把整棵技能目录按 `readFileSync(p, "utf8")` 快照、再按文本写回 ——
 * 于是 `drawio-skill/data/shape-index.json.gz`（二进制）被 UTF-8 往返碾碎：
 * 436148 → 795475 字节，魔数 `1f8b` 变成 `1fef`，gzip 再也解不开（技能的形状索引静默报废）。
 *
 * 更坏的是它**自证通过了**：`restored` 是拿「损坏后的内存快照」比对「损坏后的磁盘文件」，
 * 两边同样坏 → 哈希相等 → 打印「已还原 ✓」。**校验方式和被校验对象共用同一份错误数据，
 * 等于没校验**（ref-engineering §15「静默不命中」的变体：不报错，只是锁错了对象）。
 *
 * 现在的规矩：
 *  ① 快照存 **Buffer**、还原写 **Buffer** —— 任何文件类型都字节精确；
 *  ② 哈希算在 **Buffer** 上（不再先 `toString` 再 hash）；
 *  ③ 变异**只允许打在文本文件**上，落笔前先验证该文件 UTF-8 往返无损；
 *  ④ 还原后逐文件做**字节级**比对，二进制文件单独计数报出（坏了要一眼看见）。
 *
 * ⚠️ 全程快照 + 还原；行尾自适应（仅作用于文本变异）。
 * 用法：node gui/scripts/mut-a1053-import.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = ["tests/core-ts/imported-skills.spec.ts"];
const SKILLS_DIR = resolve(ROOT, "gui", "template", "skills");

/** 二进制扩展名：不进变异目标，但仍在快照 / 还原 / 校验范围内。 */
const BINARY_EXT = new Set([
  ".gz", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".mp4", ".webm", ".wasm", ".bin", ".npz", ".onnx",
]);

/** 递归收集目录下所有文件的相对路径（含二进制 —— 它们同样要被校验还原）。 */
function collect(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { walk(p); } else { out.push(relative(ROOT, p)); }
    }
  };
  walk(dir);
  return out;
}

/** 该文件的字节能否安全地当文本处理（UTF-8 往返无损）。 */
function isLosslessText(buf) {
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

const M = (name, file, from, to) => ({ name, file, from, to });

const MUTATIONS = [
  // ── 权限声明与实际能力不符 ────────────────────────────────────────────────
  M("M1 web-access 声明 terminal: false → 今天无害，将来重启脚本执行就静默放行",
    "gui/template/skills/web-access/manifest.yaml",
    "  terminal: true\n  network: true",
    "  terminal: false\n  network: true"),
  M("M2 drawio-skill 声明 network: false → 图标下载能力逃过审批",
    "gui/template/skills/drawio-skill/manifest.yaml",
    "  terminal: true\n  network: true",
    "  terminal: true\n  network: false"),
  M("M3 无脚本的纯指导技能声明 terminal: true → 声明与实际能力反向不符",
    "gui/template/skills/grill-me/manifest.yaml",
    "  terminal: false",
    "  terminal: true"),
  M("M4 另一个纯指导技能声明 network: true → 同上",
    "gui/template/skills/improve-codebase-architecture/manifest.yaml",
    "  network: false",
    "  network: true"),

  // ── 自研 YAML 子集解析器的事故形态 ────────────────────────────────────────
  // 注：把 `description:` 改成块标量头 `>`（或 `|`）**不构成有效变异** ——
  // 解析器把字面量 ">" 当描述存进去后，加载器还有 `extractDescription(body)` 兜底
  // （SKILL.md 正文的 `## 功能` 段 / 首个标题后段落），最终描述仍然非空、行为一致。
  // 这是**等价变异体**（见 ref-engineering §18），故刻意不复现它：
  // 要真正击穿"描述断掉"必须同时清掉正文，而那已被 M9 的"正文为空"直接覆盖。
  M("M5 清空 web-access 清单 → 权限回落到默认 {read:true}，M1 那类越权立刻可复现",
    "gui/template/skills/web-access/manifest.yaml",
    "__WHOLE_FILE__",
    "name: web-access\npermissions:\n  read: true\n"),
  // 注：把清单里的 `description:` 置空**不构成有效变异** —— 加载器有三层兜底：
  // ①清单 description → ②SKILL.md frontmatter 的 description（这批技能与清单同文）
  // → ③`extractDescription(body)`。结果字符串逐字相同，属**等价变异体**（ref-engineering §18），
  // 故刻意不复现它；加了它只会逼出一条"锁表达式写法"的假守卫。
  M("M6 造一个 skill.py → 被禁用的 RCE 执行入口混进随包技能（引擎只警告不执行，但入口本身不该存在）",
    "gui/template/skills/tdd/skill.py",
    "__CREATE_FILE__",
    "print('rce')\n"),

  // ── 名字 / 正文 / 溯源 ───────────────────────────────────────────────────
  M("M7 `name:` 与目录名不一致 → 技能以别的名字加载，按名字找的人找不到",
    "gui/template/skills/triage/manifest.yaml",
    "name: triage",
    "name: triage-renamed"),
  M("M8 清空 SKILL.md 正文 → 技能还在列表里，点开是空的（指导模式的内容来源断掉）",
    "gui/template/skills/drawio-skill/SKILL.md",
    "__WHOLE_FILE__",
    ""),
  M("M9 去掉 source 溯源 → 升级/审计时回不到上游",
    "gui/template/skills/grill-with-docs/manifest.yaml",
    "source: https://github.com/mattpocock/skills\nlicense: MIT\n",
    ""),
];

/**
 * ⚠️ 二进制的**回归用例** —— 刻意破坏二进制，专门验证 D 组守卫抓得住。
 *
 * 这里**故意绕过**上面 ③ 的 `isLosslessText` 拦截：那条是防**失误**的（人手滑把二进制
 * 写进 MUTATIONS），而这里是**照原样复现** 2026-09-21 真实发生过的事故，
 * 用来证明守不是在空转。触发方式与当年逐字一致。
 */
const BINARY_MUTATIONS = [
  {
    name: "B1 复现事故：shape-index.json.gz 做一次 UTF-8 往返（1f8b → 1fef，gzip 报废）",
    file: "gui/template/skills/drawio-skill/data/shape-index.json.gz",
    corrupt: (buf) => Buffer.from(buf.toString("utf8"), "utf8"),
  },
  {
    name: "B2 把 gz 截去后半 → 魔数仍是 1f8b，但解不开（证明「只看魔数」不够）",
    file: "gui/template/skills/drawio-skill/data/shape-index.json.gz",
    corrupt: (buf) => buf.subarray(0, Math.floor(buf.length / 2)),
  },
];

function runGuards() {
  const r = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...GUARDS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 快照存 **Buffer**（字节精确）。 */
const snapshot = (files) => {
  const m = new Map();
  for (const rel of files) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { m.set(p, readFileSync(p)); }
  }
  return m;
};
const restore = (snap) => { for (const [p, buf] of snap) { writeFileSync(p, buf); } };
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);
/** 整棵树的内容指纹（字节级，含二进制）。 */
const treeHash = (snap) => [...snap.entries()].map(([p, b]) => `${p}:${sha(b)}`).join("|");
const eolOf = (t) => (t.includes("\r\n") ? "\r\n" : "\n");
const adapt = (s, eol) => (eol === "\r\n" ? s.replace(/\n/g, "\r\n") : s);

function main() {
  const files = collect(SKILLS_DIR);
  const snap = snapshot(files);
  const before = treeHash(snap);
  const binCount = files.filter((f) => BINARY_EXT.has(extname(f).toLowerCase())).length;
  const base = runGuards();
  if (!base.ok) {
    console.error("[mut-a1053] 基线守卫未通过\n" + base.out.slice(-2000));
    process.exit(1);
  }
  console.info(`[mut-a1053] 基线守卫通过（${files.length} 个技能文件，其中二进制 ${binCount} 个）\n`);

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const created = m.from === "__CREATE_FILE__";
    const originalBuf = snap.get(path);
    if (!created && originalBuf === undefined) {
      console.error(`[mut-a1053] ${m.name}\n  ✗ 快照里没有 ${m.file}`);
      survivors.push(m.name);
      continue;
    }
    // ③ 变异只允许打在文本文件上（二进制被当文本改写会静默报废，见文件头）
    if (!created && !isLosslessText(originalBuf)) {
      console.error(`[mut-a1053] ${m.name}\n  ✗ ${m.file} 不是无损 UTF-8 文本，拒绝把它当文本变异`);
      survivors.push(m.name);
      continue;
    }
    const original = created ? "" : originalBuf.toString("utf8");
    let next;
    if (created) {
      if (existsSync(path)) {
        console.error(`[mut-a1053] ${m.name}\n  ✗ ${m.file} 已存在，变异不成立（该守卫本就该红）`);
        survivors.push(m.name);
        continue;
      }
      next = adapt(m.to, "\n");
    } else if (m.from === "__WHOLE_FILE__") {
      next = adapt(m.to, eolOf(original));
    } else {
      const eol = eolOf(original);
      const from = adapt(m.from, eol);
      if (!original.includes(from)) {
        console.error(`[mut-a1053] ${m.name}\n  ✗ 锚点未命中（行尾 ${JSON.stringify(eol)}）`);
        survivors.push(m.name);
        continue;
      }
      next = original.replace(from, adapt(m.to, eol));
    }
    writeFileSync(path, next, "utf8");
    if (runGuards().ok) {
      console.error(`[mut-a1053] ${m.name}\n  ✗ 守卫仍绿 —— 没锁住`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1053] ✓ 变红：${m.name}`);
    }
    if (created) {
      rmSync(path, { force: true });   // 新建的文件不在快照里，必须显式清掉
    } else {
      restore(snap);                    // 字节还原（不是文本还原）
    }
  }
  restore(snap);
  // ── 二进制回归：走**字节**写入，验证 D 组守卫真的盯着二进制 ──────────────────
  for (const b of BINARY_MUTATIONS) {
    const path = resolve(ROOT, b.file);
    const orig = snap.get(path);
    if (orig === undefined) {
      console.error(`[mut-a1053] ${b.name}\n  ✗ 快照里没有 ${b.file}`);
      survivors.push(b.name);
      continue;
    }
    writeFileSync(path, b.corrupt(orig));   // 字节写入，不做任何文本处理
    if (runGuards().ok) {
      console.error(`[mut-a1053] ${b.name}\n  ✗ 守卫仍绿 —— 二进制被破坏却没被发现`);
      survivors.push(b.name);
    } else {
      red += 1;
      console.info(`[mut-a1053] ✓ 变红：${b.name}`);
    }
    restore(snap);
  }
  const total = MUTATIONS.length + BINARY_MUTATIONS.length;
  restore(snap);
  const after = snapshot(collect(SKILLS_DIR));
  const restored = treeHash(after) === before;
  // ④ 二进制单独复核：不只看总指纹，还要确认没有二进制被碾过
  const binBroken = files
    .filter((f) => BINARY_EXT.has(extname(f).toLowerCase()))
    .filter((f) => {
      const p = resolve(ROOT, f);
      const b = snap.get(p);
      try { return !b || !readFileSync(p).equals(b); } catch { return true; }
    });
  console.info("");
  if (survivors.length) {
    console.error(`[mut-a1053] ${survivors.length}/${total} 条未被捕获：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  if (!restored || binBroken.length > 0) {
    console.error(`[mut-a1053] 还原失败 ✗`
      + `${restored ? "" : "（整树指纹不一致）"}`
      + `${binBroken.length ? `（二进制被改动：${binBroken.join("、")}）` : ""}`);
    process.exit(1);
  }
  console.info(`[mut-a1053] 全部 ${total} 条变异均让守卫变红（${red} 红），`
    + `源文件**字节级**已还原 ✓（${files.length} 个文件，含 ${binCount} 个二进制）`);
  process.exit(0);
}

main();
