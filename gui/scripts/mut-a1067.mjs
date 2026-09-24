/**
 * A-1067 变异测试（#228）：把「通知头部图标」这条链逐环改坏，要求守卫变红。
 *
 * 覆盖 `tests/core-ts/a1067-notify-icon.spec.ts`。断言的层次（每一环都要单独有变异）：
 *   A 判据   —— 1024px / 200 KB 两个上限（改大就是放行一张会被系统丢弃的图）
 *   B 资产   —— 通知图标**不是** icon.png；且磁盘上那张 notify-icon.png 真的合规
 *   C 接线   —— notificationIconPath() 用 notifyIconFileName() + 量体积 + 超限不传 + 缺文件出声
 *   D 随包   —— extraFiles 显式列出（打包版没有它 = 又一次静默无图标）
 *   E 生成   —— 脚本自带验收 + 面积平均降采样 + 只用内置模块
 *
 * ⚠️ 本脚本的**输入含一个二进制文件**（`gui/build/notify-icon.png`）。变异纪律（`§19`）：
 *   B 组两条变异要**字节级**动它（Buffer 快照 / 还原 / hash 校验），文本往返会把它碾碎。
 *   还原校验用**独立基准**（另存一份字节快照），不许"自比对"式假绿。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 *
 * 用法：node gui/scripts/mut-a1067.mjs
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1067-notify-icon.spec.ts";
const IDENTITY = "gui/src/main/notifyIdentity.ts";
const NOTIFY = "gui/src/main/notify.ts";
const BUILDER = "gui/electron-builder.json";
const MAKER = "gui/scripts/make-notify-icon.mjs";
const ICON = "gui/build/notify-icon.png";

/** 文本目标（走 `sub`，行尾无关）。二进制目标单列，见下面 iconBackup。 */
const TEXT_TARGETS = [IDENTITY, NOTIFY, BUILDER, MAKER];

/** 真·资产那条断言的前提值（读一次，避免变异过程中被自己的改动影响） */
const REAL_ICON_BYTES = readFileSync(join(ROOT, ICON));

const MUTATIONS = [
  // ── A 判据 ────────────────────────────────────────────────────────────────
  {
    name: "A1 体积上限被放大到 2 MB（951.7 KB 的大图又能过验收）",
    file: IDENTITY,
    mutate: (t) => sub(t, "export const NOTIFY_IMAGE_MAX_BYTES = 200 * 1024;", "export const NOTIFY_IMAGE_MAX_BYTES = 2 * 1024 * 1024;"),
  },
  {
    name: "A2 尺寸上限被放大到 4096px",
    file: IDENTITY,
    mutate: (t) => sub(t, "export const NOTIFY_IMAGE_MAX_DIM = 1024;", "export const NOTIFY_IMAGE_MAX_DIM = 4096;"),
  },
  {
    name: "A3 体积判据整段短接（checkNotifyImage 恒放行）",
    file: IDENTITY,
    mutate: (t) => sub(
      t,
      'if (meta.bytes > NOTIFY_IMAGE_MAX_BYTES) {\n    return { ok: false, reason: `体积 ${(meta.bytes / 1024).toFixed(1)} KB 超过上限 ${NOTIFY_IMAGE_MAX_BYTES / 1024} KB` };\n  }',
      "if (false) {\n    return { ok: false, reason: `体积 ${(meta.bytes / 1024).toFixed(1)} KB 超过上限 ${NOTIFY_IMAGE_MAX_BYTES / 1024} KB` };\n  }",
    ),
  },
  {
    name: "A4 严格大于改成宽松（恰好超限也能过）",
    file: IDENTITY,
    mutate: (t) => sub(t, "if (meta.bytes > NOTIFY_IMAGE_MAX_BYTES) {", "if (meta.bytes > NOTIFY_IMAGE_MAX_BYTES + 4096) {"),
  },
  {
    name: "A5 尺寸只判宽不判高（宽 800 高 2000 的图放行）",
    file: IDENTITY,
    mutate: (t) => sub(t, "if (meta.height !== undefined && meta.height > NOTIFY_IMAGE_MAX_DIM) {", "if (false) {"),
  },

  // ── B 资产 ────────────────────────────────────────────────────────────────
  {
    name: "B1 文件名退回安装器大图 icon.png（#228 原样复活：超限 → 头部静默空白）",
    file: IDENTITY,
    mutate: (t) => sub(t, 'return "notify-icon.png";', 'return "icon.png";'),
  },
  {
    name: "B2 [二进制] 把大图字节原样写成 notify-icon.png（容器对、内容物错）",
    file: ICON,
    mutate: null, // 由主流程按字节灌入大图内容，见 BINARY_STEPS
  },

  // ── C 接线 ────────────────────────────────────────────────────────────────
  {
    name: "C1 不再量体积（拿回 A-1055 那版的写法：路径存在就传下去）",
    file: NOTIFY,
    mutate: (t) => sub(
      t,
      "  const v = checkNotifyImage({ bytes: statSync(p).size });\n  if (!v.ok) {\n    console.warn(`[notify] 通知图标不合规（${v.reason}）→ 不传给系统（否则图标不显示/整条通知被丢弃）：${p}`);\n    return undefined;\n  }\n  return p;",
      "  return p;",
    ),
  },
  {
    name: "C2 量到超限却仍然把路径传下去（用户看到最难查的那种空图标）",
    file: NOTIFY,
    mutate: (t) => sub(t, "    return undefined;\n  }\n  return p;", "    return p;\n  }\n  return p;"),
  },
  {
    name: "C3 缺文件时静默返回（extraFiles 漏配就再也查不出来）",
    file: NOTIFY,
    mutate: (t) => sub(
      t,
      '    console.warn(`[notify] 通知图标缺失：${p}（打包版请核对 electron-builder.json 的 extraFiles）`);\n    return undefined;',
      "    return undefined;",
    ),
  },
  {
    name: "C4 又指回写死的 icon.png（绕开唯一出处）",
    file: NOTIFY,
    mutate: (t) => sub(t, 'join(INSTALL_ROOT, "build", notifyIconFileName())', 'join(INSTALL_ROOT, "build", "icon.png")'),
  },

  // ── D 随包 ────────────────────────────────────────────────────────────────
  {
    name: "D1 extraFiles 里删掉 notify-icon.png（打包版没有这张图 → 静默无图标）",
    file: BUILDER,
    mutate: (t) => sub(t, '    { "from": "build/notify-icon.png", "to": "build/notify-icon.png" },\n', ""),
  },
  {
    name: "D2 随包来源改错（指向安装器大图）",
    file: BUILDER,
    mutate: (t) => sub(t, '{ "from": "build/notify-icon.png", "to": "build/notify-icon.png" }', '{ "from": "build/icon.png", "to": "build/notify-icon.png" }'),
  },

  // ── E 生成脚本 ────────────────────────────────────────────────────────────
  {
    name: "E1 生成脚本不再自验收（超限也照样写盘 + exit 0）",
    file: MAKER,
    mutate: (t) => sub(t, "if (out.length > MAX_BYTES) { problems.push(", "if (false) { problems.push("),
  },
  {
    name: "E2 降采样退回最近邻（面积平均这条判据失效）",
    file: MAKER,
    mutate: (t) => sub(t, "const small = downscale(pixels, w, h, channels, size);", "const small = pixels.subarray(0, size * size * channels);"),
  },
  {
    name: "E3 生成脚本引入外部依赖（本机 pip/ImageMagick 都不可用 → 会直接跑不起来）",
    file: MAKER,
    mutate: (t) => sub(t, 'import { deflateSync, inflateSync } from "node:zlib";', 'import sharp from "sharp";'),
  },
];

/** 二进制变异：不走 `sub`，直接按字节改写**目标文件本身**。
 *  ⚠️ 首版写成了"把变异内容写进一个 .mut-tmp 再从目标读回来比对"—— 目标根本没被改过，
 *   于是 B2 报"变异未生效"（假未命中）。变异必须落到**被测文件**上，这是它的全部意义。 */
const BINARY_STEPS = {
  [ICON]: (targetPath) => {
    // 用安装器大图的**真实字节**覆盖通知小图 → "路径对、内容物超限"
    writeFileSync(targetPath, readFileSync(join(ROOT, "gui", "build", "icon.png")));
  },
};

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return r.status === 0;
}

// ── 快照（文本 + 二进制各一条基线，互不污染）──────────────────────────────
const textOriginals = new Map(TEXT_TARGETS.map((t) => [t, readFileSync(join(ROOT, t), "utf8")]));
const textHashes = new Map(TEXT_TARGETS.map((t) => [t, sha(readFileSync(join(ROOT, t)))]));
/** ⚠️ 二进制的**独立基准**：另存一份字节快照（不是"自己比自己"） */
const iconSnapshot = Buffer.from(REAL_ICON_BYTES);
const iconHash = sha(iconSnapshot);
const iconExistedBefore = existsSync(join(ROOT, ICON));

if (!runSpec()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
/* 行尾自检只吃文本变异（二进制那条没有多行锚点） */
const textMutations = MUTATIONS.filter((m) => m.mutate !== null);
if (reportEolProblems(eolProblems(textMutations, ROOT), "mut-a1067")) { process.exit(1); }

/** 引号自伤自检（A-1056）：**剥注释后**仍出现「CJK + ASCII 双引号 + CJK」才算坏。
 *  ⚠️ 判据必须是**两侧都 CJK**：单侧命中是合法的 `it("中文…")`。
 *  ⚠️ 必须**先剥注释**：注释里引用词语（`把"该系统"……`）是无害的，本文件注释里就有很多。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const bad = [];
  for (const line of code.split("\n")) {
    if (/[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(line)) { bad.push(line.trim().slice(0, 100)); }
  }
  return bad;
}
for (const rel of [SPEC, ...TEXT_TARGETS]) {
  const bad = quoteSelfHarm(readFileSync(join(ROOT, rel), "utf8"));
  if (bad.length) {
    console.error(`引号自伤自检失败（${rel}，剥注释后仍有 CJK"CJK）：`);
    for (const b of bad) { console.error(`  - ${b}`); }
    process.exit(1);
  }
}
console.log("行尾检测器自检 + 锚点自检 + 引号自伤自检均通过\n");

let caught = 0;
const missed = [];
const tmp = join(ROOT, ICON + ".mut-tmp");

function restoreAll() {
  for (const [t, src] of textOriginals) { writeFileSync(join(ROOT, t), src); }
  if (iconExistedBefore) {
    /* ⚠️ 字节级还原（`§19`）：绝不用 readFileSync(path,"utf8") 往返 —— 那会碾碎二进制 */
    writeFileSync(join(ROOT, ICON), iconSnapshot);
  } else {
    rmSync(join(ROOT, ICON), { force: true });
  }
  if (existsSync(tmp)) { rmSync(tmp, { force: true }); }
}

try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    if (m.mutate === null) {
      // ── 二进制变异 ──────────────────────────────────────────────────────
      const step = BINARY_STEPS[m.file];
      if (!step) {
        console.error(`⚠️  ${m.name}\n    二进制变异缺少 BINARY_STEPS 实现`);
        missed.push(m.name);
        continue;
      }
      writeFileSync(path, iconSnapshot); // 起点归位到合规图（上一轮已还原，这里是显式保险）
      step(path);
      if (sha(readFileSync(path)) === iconHash) {
        console.error(`⚠️  ${m.name}\n    变异未生效（字节与基线一致）—— 视为未命中`);
        missed.push(m.name);
        restoreAll();
        continue;
      }
    } else {
      const src = textOriginals.get(m.file);
      const next = m.mutate(src);
      if (next === src) {
        console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）`);
        missed.push(m.name);
        continue;
      }
      writeFileSync(path, next);
    }
    const green = runSpec();
    restoreAll();
    if (green) {
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

// ── 还原校验（文本哈希 + **独立**二进制基准）──────────────────────────────
const dirty = [...textHashes.entries()].filter(([t, h]) => sha(readFileSync(join(ROOT, t))) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文本文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
if (!existsSync(join(ROOT, ICON))) {
  console.error(`\n⚠️ 还原失败：${ICON} 不存在了`);
  process.exit(1);
}
if (sha(readFileSync(join(ROOT, ICON))) !== iconHash) {
  console.error(`\n⚠️ 还原失败：${ICON} 字节与基线不符（可能被文本往返碾碎）`);
  process.exit(1);
}
if (existsSync(tmp)) {
  console.error(`\n⚠️ 临时文件残留：${tmp}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TEXT_TARGETS.length} 个文本哈希一致 + ${ICON} 字节级一致）`);

console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
