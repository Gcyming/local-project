#!/usr/bin/env node
/**
 * gui/scripts/mut-a1189-rightbar-fade.mjs — A-1189 守卫的变异验证。
 *
 * 被验证的守卫：`tests/core-ts/a1189-rightbar-fade.spec.ts`
 * 它锁的不变量是「右栏的几何同步淡入淡出（A-1189 恢复）必须**真的存在、且写在正确的节点上**」。
 *
 * ## 为什么这条不变量需要变异（而不是只写形状断言）
 * 右栏的 opacity 在本项目里被**删过一次（A-1164）**、恢复过一次又被回退 —— 历史证明：
 * "这段代码在不在"完全是靠一次性的人工判断维持的，而删掉之后**门禁全绿**
 * （`a1152`/`a1173`/`a1174` 全是围绕**左栏**的锚点，右栏只有 `removeProperty` 那一句）。
 * ⇒ 必须让每一条不变量都有一条"删掉它守卫就红"的变异体。
 *
 * | # | 变异 | 应被抓住 |
 * |---|---|---|
 * | M1 | 两条支都不再写 `opacity`（= A-1164 的回归） | ③ 计数=2 / ④ 方向取反 |
 * | M2 | 展开起点不把内层压 `"0"`（前 40% 先全不透明地长出来） | ② 顺序与存在性 |
 * | M3 | `done` 一律复位、不区分方向（= A-1173 的回归） | ④ 收尾断言 |
 * | M4 | fade 写到容器 `.right-wrapper`（铁律 53 / A-980-R24 的回归） | ① 内层节点 |
 * | M5 | 拖拽起点不清残留 opacity（折叠态拖宽 ⇒ 右栏隐形） | ⑤a |
 * | M6 | 切会话快照恢复不清内层 opacity（残留永久留在元素上） | ⑤b |
 *
 * ⚠️ M1 / M3 / M4 的锚点**天然命中两次/四次**（两条支、两处测量闭包）⇒ 必须显式写
 *    `all: true` + `subAll`：它们是"整个方向的机制"而非"某一处写法"，
 *    只改一处虽然也可能让守卫红，但那**不是变异名字说的那个缺陷**（弱化变异体）。
 *
 * ⚠️ 快照/还原一律走**字节** + manifest（sha256 校验）；`--restore` **必须无参可用**。
 * ⚠️ 判据 spec 清单从下面的 `SPECS` 读（`_run-mut-batch.sh` 不传参时自动取）。
 *    这里刻意**包含 a1152 / a1155**：M4 改的是两条支共用的"测量闭包"，
 *    `a1155` 里也有一条 `querySelector(".right-sidebar")` 的判据 —— 不列进来就会
 *    让那条守卫的覆盖范围在变异阶段被悄悄缩小（"手写清单漏一份"的另一种形态）。
 *
 * 用法：
 *   node gui/scripts/mut-a1189-rightbar-fade.mjs --list
 *   node gui/scripts/mut-a1189-rightbar-fade.mjs --apply 1
 *   node gui/scripts/mut-a1189-rightbar-fade.mjs --restore
 *   全量：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1189-rightbar-fade.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1189-rightbar-fade.spec.ts",
  "tests/core-ts/a1152-float-stability.spec.ts",
  "tests/core-ts/a1155-float-width-symmetry.spec.ts",
];
const F_APP = "gui/src/renderer/App.tsx";
const TARGETS = [F_APP];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1189");

const MUTATIONS = [
  {
    name: "M1 两条支都不再写 opacity（= A-1164 的回归：右栏全程不透明，衔接动画又没了）",
    file: F_APP,
    all: true,
    mutate: (t) => subAll(t, "node.style.opacity = String(nextOpen ? p : 1 - p);", "void node;"),
  },
  {
    name: "M2 展开起点不把内层压 `\"0\"`（展开窗口 `u < 0.40` 时 p≡0 ⇒ 前 40% 先全不透明地长出来再掉回 0）",
    file: F_APP,
    mutate: (t) => sub(t, '      if (rsEnter) { rsEnter.style.opacity = "0"; }', "      void rsEnter;"),
  },
  {
    name: "M3 `done` 一律复位、不区分方向（= A-1173 的回归：收起结尾几 px 的文本会露出来）",
    file: F_APP,
    all: true,
    mutate: (t) => subAll(
      t,
      'if (nextOpen) { node.style.removeProperty("opacity"); } else { node.style.opacity = "0"; }',
      'node.style.removeProperty("opacity");',
    ),
  },
  {
    name: "M4 fade 写到容器 `.right-wrapper`（铁律 53 / A-980-R24 的回归：`<webview>` 祖先带 opacity ⇒ 鼠标命中失效）",
    file: F_APP,
    all: true,
    mutate: (t) => subAll(
      t,
      'rightWrapperRef.current?.querySelector<HTMLElement>(".right-sidebar") ?? null',
      "rightWrapperRef.current",
    ),
  },
  {
    name: "M5 拖拽起点不清残留 opacity（收起收工钉的 `0` 留在元素上 ⇒ 折叠态拖宽时右栏整块隐形）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '    if (asideEl) { asideEl.style.removeProperty("opacity"); }\n    let lastW = startWidth;',
      "    let lastW = startWidth;",
    ),
  },
  {
    name: "M6 切会话快照恢复不清内层 opacity（引擎唯一的「取消但不重启」路径 ⇒ 半透明值永久残留）",
    file: F_APP,
    /* ⚠️ 锚点**只取守卫真正断言的那两行**（铁律 3：变异点必须真正碰到被断言的不变量）。
       初版把上一行 `rw.style.removeProperty("--right-body-pin")` 也写进锚点、要求三行**相邻**，
       而源码里中间夹着一段 7 行的 A-1189 注释 ⇒ `--apply` 直接报"锚点未命中"
       （实测：批跑汇总里 M6 = `!! --apply 失败`，5/6）。 */
    mutate: (t) => sub(
      t,
      '          const rsReset = rw.querySelector<HTMLElement>(".right-sidebar");\n'
      + '          if (rsReset) { rsReset.style.removeProperty("opacity"); }',
      '          void rw;',
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  if (r.status !== 0) { return { ok: false, spawnBlocked: false }; }
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
    let next;
    try { next = m.mutate(text); }
    catch (e) { console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
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

/* ── full 模式 ── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t))]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = () => { for (const [t, buf] of originals) { writeFileSync(abs(t), buf); } };
process.on("SIGINT", () => { restoreAll(); process.exit(1); });
process.on("SIGTERM", () => { restoreAll(); process.exit(1); });

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY）⇒ 请用 --apply/--restore + shell 循环。");
  process.exit(1);
}
if (!base.ok) { console.error("基线未通过 —— 先修好测试再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

let caught = 0; const missed = [];
try {
  for (const m of MUTATIONS) {
    const src = originals.get(m.file).toString("utf8");
    let next;
    try { next = m.mutate(src); }
    catch (e) { console.error(`⚠️  ${m.name}\n    锚点未命中：${e.message}`); missed.push(m.name); continue; }
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中（变异体没落地）`); missed.push(m.name); continue; }
    writeFileSync(abs(m.file), next);
    const res = runSpecs();
    writeFileSync(abs(m.file), originals.get(m.file));
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);
