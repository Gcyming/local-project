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
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync } from "node:fs";
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

/**
 * 两条**没有文本锚点**的变异形态（用 `mode` 声明，**不用哨兵值塞进 `from:`**）。
 *
 * ⚠️ 2026-10-07：原先用哨兵字符串 `from: "__WHOLE_FILE__"` / `"__CREATE_FILE__"`。
 *   那个写法对**运行期**没问题（`m.from === "__WHOLE_FILE__"` 照样能判），
 *   但核验器会把 `from:` 的值当**文本锚点**去目标文件里数出现次数 ⇒ 恒 0
 *   ⇒ 报「未命中（源码已漂移，该守卫已失效）」——
 *   **假红指向错误对象**：源码没漂移，这条根本没有锚点（它整文件替换 / 新建文件）。
 *   同理 `__CREATE_FILE__` 还会额外撞上「目标文件不存在」（那个文件本来就不该存在）。
 *   ⇒ 改成**独立字段** `mode:`：核验器看不到 `from:` ⇒ 老老实实落进「未核验」，
 *     并给出它给的具名理由；运行期按 `m.mode` 分派，行为逐字不变。
 */
const WHOLE_FILE = "whole-file";
const CREATE_FILE = "create-file";

/**
 * 逐条变异：`{ name, file, from, to }`（文本替换）或 `{ name, file, mode, to }`（整文件 / 新建）。
 *
 * ⚠️ 2026-10-07：这些条目原先是 `M("名称", "文件", "原文", "改后")` **函数调用**，
 *   而核验器的静态切分规则是「**行首 `{` 起头算一条**」（`/\r?\n\s*\{\r?\n/`）
 *   —— `M(` 不是 `{` ⇒ **这 9 条一条都没被切出来、一次都没被核验过**
 *   （而输出里只出现 2 条「未核验」，正是那两条 `corrupt:` 二进制条目；
 *   这 9 条**连分母都没进** —— 比「未核验」更彻底：没人知道它存在）。
 *   ⇒ 照 a1023 / a1042 的先例**就地展开成对象字面量**，条目一个不少、字段一字未改，
 *   运行期行为与原来逐字一致（`M()` 本就只是 `{ name, file, from, to }` 的缩写）。
 *
 * ⚠️ M5 / M6 / M8 三条（整文件替换 / 新建文件）**没有文本锚点**，
 *   仍然「未核验」，**且这是应该的**（核验器文件头把这一类列为「压根没有 from」）。
 *   ⚠️ **不给他们硬凑一个 `from`** ——
 *   凑出来的"命中 1 次"是**假绿**：核验器打勾，而运行期压根没用那个锚点。
 *   这 3 条的保护由本脚本**真跑**提供（判据：没人核验 = 没有保护）。
 */
const MUTATIONS = [
  // ── 权限声明与实际能力不符 ────────────────────────────────────────────────
  {
    name: "M1 web-access 声明 terminal: false → 今天无害，将来重启脚本执行就静默放行",
    file: "gui/template/skills/web-access/manifest.yaml",
    from: "  terminal: true\n  network: true",
    to: "  terminal: false\n  network: true",
  },
  {
    name: "M2 drawio-skill 声明 network: false → 图标下载能力逃过审批",
    file: "gui/template/skills/drawio-skill/manifest.yaml",
    from: "  terminal: true\n  network: true",
    to: "  terminal: true\n  network: false",
  },
  {
    name: "M3 无脚本的纯指导技能声明 terminal: true → 声明与实际能力反向不符",
    file: "gui/template/skills/grill-me/manifest.yaml",
    from: "  terminal: false",
    to: "  terminal: true",
  },
  {
    name: "M4 另一个纯指导技能声明 network: true → 同上",
    file: "gui/template/skills/improve-codebase-architecture/manifest.yaml",
    from: "  network: false",
    to: "  network: true",
  },

  // ── 自研 YAML 子集解析器的事故形态 ────────────────────────────────────────
  // 注：把 `description:` 改成块标量头 `>`（或 `|`）**不构成有效变异** ——
  // 解析器把字面量 ">" 当描述存进去后，加载器还有 `extractDescription(body)` 兜底
  // （SKILL.md 正文的 `## 功能` 段 / 首个标题后段落），最终描述仍然非空、行为一致。
  // 这是**等价变异体**（见 ref-engineering §18），故刻意不复现它：
  // 要真正击穿"描述断掉"必须同时清掉正文，而那已被 M9 的"正文为空"直接覆盖。
  {
    // ⚠️ 整文件替换 ⇒ 本条**不可静态核验**，且**刻意不写 `from:`**。
    //   判据：`__WHOLE_FILE__` 是**哨兵值**不是文本锚点；把它塞进 `from:` 会让核验器
    //   拿它去目标文件里数出现次数 ⇒ 恒 0 ⇒ 报「未命中（源码已漂移）」——
    //   **假红指向错误对象**（真因是这条根本没有锚点，源码没漂移）。
    //   同理 M6（新建文件，运行期会 rmSync）与 M8。
    //   ⇒ 这 3 条只能落进「未核验」（核验器文件头把这一类列为「压根没有 from」）。
    //   ⚠️ **绝不为它们硬凑一个 `from`** —— 凑出来的"命中 N 次"是**假绿**：
    //     核验器打勾，而运行期压根没用那个锚点，锚点漂移照样静默。
    //   这 3 条的保护由本脚本**真跑**提供（判据：没人核验 = 没有保护）。
    name: "M5 清空 web-access 清单 → 权限回落到默认 {read:true}，M1 那类越权立刻可复现",
    file: "gui/template/skills/web-access/manifest.yaml",
    unverifiable: "整文件替换（WHOLE_FILE）—— 没有文本锚点可供静态核验",
    mode: WHOLE_FILE,
    to: "name: web-access\npermissions:\n  read: true\n",
  },
  // 注：把清单里的 `description:` 置空**不构成有效变异** —— 加载器有三层兜底：
  // ①清单 description → ②SKILL.md frontmatter 的 description（这批技能与清单同文）
  // → ③`extractDescription(body)`。结果字符串逐字相同，属**等价变异体**（ref-engineering §18），
  // 故刻意不复现它；加了它只会逼出一条"锁表达式写法"的假守卫。
  {
    // ⚠️ 新建文件 ⇒ 本条不可静态核验，且刻意不写 `from:`（理由同 M5）。
    name: "M6 造一个 skill.py → 被禁用的 RCE 执行入口混进随包技能（引擎只警告不执行，但入口本身不该存在）",
    file: "gui/template/skills/tdd/skill.py",
    unverifiable: "新建文件（CREATE_FILE）—— 文件本就不存在，无锚可核",
    mode: CREATE_FILE,
    to: "print('rce')\n",
  },

  // ── 名字 / 正文 / 溯源 ───────────────────────────────────────────────────
  {
    name: "M7 `name:` 与目录名不一致 → 技能以别的名字加载，按名字找的人找不到",
    file: "gui/template/skills/triage/manifest.yaml",
    from: "name: triage",
    to: "name: triage-renamed",
  },
  {
    // ⚠️ 整文件替换 ⇒ 本条不可静态核验，且刻意不写 `from:`（理由同 M5）。
    name: "M8 清空 SKILL.md 正文 → 技能还在列表里，点开是空的（指导模式的内容来源断掉）",
    file: "gui/template/skills/drawio-skill/SKILL.md",
    unverifiable: "整文件替换（WHOLE_FILE）—— 没有文本锚点可供静态核验",
    mode: WHOLE_FILE,
    to: "",
  },
  {
    name: "M9 去掉 source 溯源 → 升级/审计时回不到上游",
    file: "gui/template/skills/grill-with-docs/manifest.yaml",
    from: "source: https://github.com/mattpocock/skills\nlicense: MIT\n",
    to: "",
  },
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
    unverifiable: "二进制字节改写（corrupt）—— 静态核验器不解读字节",
    corrupt: (buf) => Buffer.from(buf.toString("utf8"), "utf8"),
  },
  {
    name: "B2 把 gz 截去后半 → 魔数仍是 1f8b，但解不开（证明「只看魔数」不够）",
    file: "gui/template/skills/drawio-skill/data/shape-index.json.gz",
    unverifiable: "二进制字节改写（corrupt）—— 静态核验器不解读字节",
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

/* ── 骨架：--list / --apply N / --restore ──────────────────────────────────
 * 与 mut-a1091 / mut-a1037 / mut-a1042 同款约定（全仓一致）。
 * ⚠️ --restore **无参可用**，且**变异态下也能跑**。
 * ⚠️ 本脚本备份一律走**字节**（Buffer）—— 文件树里有 `.gz` 二进制，
 *   文本往返会把它碾碎（1f8b → 1fef，见文件头那次真实事故）。
 * ⚠️ `--apply` 支持三种形态（与全量模式同一套判据）：
 *   文本替换（有 `from`）/ 整文件替换（`mode: WHOLE_FILE`）/ 新建文件（`mode: CREATE_FILE`）。
 *   新建文件型还原时**显式删掉**新建的那个文件（它不在备份里）。
 */
const SAVE_DIR = resolve(ROOT, "gui", "scripts", "_tmp-mut-a1053");
const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  for (const [i, b] of BINARY_MUTATIONS.entries()) { console.log(`  B${i + 1}. [${b.file}] ${b.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = resolve(SAVE_DIR, "manifest.json");

  if (mode === "apply") {
    const raw = argv[argv.indexOf("--apply") + 1];
    /* B 前缀 = 二进制破坏条目（B1 / B2）；纯数字 = 文本条目（M1…M9） */
    const isBin = typeof raw === "string" && raw.toUpperCase().startsWith("B");
    const list = isBin ? BINARY_MUTATIONS : MUTATIONS;
    const idx = Number(isBin ? raw.slice(1) : raw);
    const m = list[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length} 或 B1..B${BINARY_MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
    const path = resolve(ROOT, m.file);
    mkdirSync(SAVE_DIR, { recursive: true });

    if (isBin) {
      const orig = readFileSync(path);
      writeFileSync(resolve(SAVE_DIR, "orig.bin"), orig);       // **字节**备份
      writeFileSync(path, m.corrupt(orig));                     // 字节写入，不做文本处理
      writeFileSync(manifestPath, JSON.stringify({
        index: raw, name: m.name, file: m.file, binary: true,
        sha256: createHash("sha256").update(orig).digest("hex"),
      }, null, 2));
      console.log(`已变异 ${raw}：${m.name}`);
      process.exit(0);
    }

    const created = m.mode === CREATE_FILE;
    if (!created && !existsSync(path)) { console.error(`快照里没有 ${m.file}`); process.exit(1); }
    if (created && existsSync(path)) { console.error(`${m.file} 已存在，变异不成立`); process.exit(1); }
    const orig = created ? Buffer.alloc(0) : readFileSync(path);
    writeFileSync(resolve(SAVE_DIR, "orig.bin"), orig);
    if (!created && !isLosslessText(orig)) {
      console.error(`${m.file} 不是无损 UTF-8 文本，拒绝把它当文本变异`);
      rmSync(SAVE_DIR, { recursive: true, force: true });
      process.exit(1);
    }
    const original = created ? "" : orig.toString("utf8");
    let next;
    if (created) {
      next = adapt(m.to, "\n");
    } else if (m.mode === WHOLE_FILE) {
      next = adapt(m.to, eolOf(original));
    } else {
      const eol = eolOf(original);
      const from = adapt(m.from, eol);
      if (!original.includes(from)) {
        console.error(`锚点未命中：${m.name}（行尾 ${JSON.stringify(eol)}）`);
        rmSync(SAVE_DIR, { recursive: true, force: true });
        process.exit(1);
      }
      next = original.replace(from, adapt(m.to, eol));
    }
    if (!created && next === original) {
      console.error(`变异无效果（改了等于没改）：${m.name}`);
      rmSync(SAVE_DIR, { recursive: true, force: true });
      process.exit(1);
    }
    writeFileSync(path, next, "utf8");
    writeFileSync(manifestPath, JSON.stringify({
      index: raw, name: m.name, file: m.file, binary: false, created,
      sha256: createHash("sha256").update(orig).digest("hex"),
    }, null, 2));
    console.log(`已变异 ${raw}：${m.name}`);
    process.exit(0);
  }

  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const path = resolve(ROOT, man.file);
  if (man.created) {
    rmSync(path, { force: true });        // 新建的文件不在备份里 ⇒ 显式删掉
  } else {
    writeFileSync(path, readFileSync(resolve(SAVE_DIR, "orig.bin")));
  }
  const now = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (man.created ? now !== null : now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

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
    const created = m.mode === CREATE_FILE;
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
    } else if (m.mode === WHOLE_FILE) {
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
