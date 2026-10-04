#!/usr/bin/env node
/**
 * gui/scripts/mut-a1151-steer-dismiss.mjs — A-1151「取消引导必须真的取消」的变异脚本。
 *
 * ## 为什么这一组必须有变异
 * 用户实测 bug：「点了**取消叉**，结果后面都传上去了」。
 * 而这个 bug 的危险之处在于：**功能看起来是好的** —— 卡片消失了（渲染层那份确实删了），
 * 主进程那份「多留一会儿」在界面上**完全不可见** ⇒ 只靠形状断言/单测很容易放过"接线少一处"。
 * 所以变异必须覆盖**两层**：
 *   · 纯函数层（`dropSteer` 逻辑错）；
 *   · **接线层**（`dropSteer` 存在但取消路径没调到它 —— 这才是这次真正漏的那类）。
 *
 * 用法（与本仓其他 mut-* 一致）：
 *   node gui/scripts/mut-a1151-steer-dismiss.mjs --list
 *   bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1151-steer-dismiss.mjs \
 *        tests/core-ts/a1151-steer-dismiss.spec.ts
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1151-steer-dismiss.spec.ts"];
const F_BUS = "core-ts/src/services/steerBus.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_PRE = "gui/src/preload/index.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_BUS, F_MAIN, F_PRE, F_PANEL];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1151");

/** 逐字节替换：找不到就抛（"变异体没落地"必须当场失败，否则会报假存活）。 */
const sub = (t, from, to) => {
  if (!t.includes(from)) { throw new Error(`锚点未命中：${JSON.stringify(from.slice(0, 60))}`); }
  if (t.indexOf(from) !== t.lastIndexOf(from)) { throw new Error(`锚点不唯一：${JSON.stringify(from.slice(0, 60))}`); }
  return t.replace(from, to);
};

const MUTATIONS = [
  {
    name: "1 bus：`dropSteer` 只找到位置但**不删**（取消彻底失效 —— 界面上卡片照样消失，静默）",
    file: F_BUS,
    mutate: (t) => sub(t, "  list.splice(idx, 1);", "  void idx; // 变异：不删"),
  },
  {
    name: "2 bus：`findIndex` 恒返回 -1（永远\"找不到\"⇒ 撤销永远无效）",
    file: F_BUS,
    mutate: (t) => sub(t, "  const idx = list.findIndex((it) => it.id === key);", "  const idx = -1; // 变异：找不到"),
  },
  {
    name: "3 bus：id 比对写成**全等字符串**以外的口径（数字 id 传进来就找不到 ⇒ 撤销无效）",
    file: F_BUS,
    mutate: (t) => sub(t, '  const key = String(id ?? "");', '  const key = ""; // 变异：key 恒空'),
  },
  {
    name: "4 main：撤销 IPC 变成**空实现**（回 ok 但什么都不删 —— 最坏的一种：界面以为成功了）",
    file: F_MAIN,
    mutate: (t) => sub(t, "    const dropped = dropSteer(sid, String(payload?.id ?? \"\"));", "    const dropped = false; void sid; // 变异：不删"),
  },
  {
    name: "5 preload：`dismissSteer` 的 invoke 指向**别的通道**（撤销永远打到没人听的通道上）",
    file: F_PRE,
    mutate: (t) => sub(t, 'ipcRenderer.invoke("slime:chat:steer:dismiss"', 'ipcRenderer.invoke("slime:chat:steer"'),
  },
  {
    name: "6 panel：`removeQueueItem` **不再通知主进程**（只删渲染层 ⇒ 这正是本次修复前的原始 bug）",
    file: F_PANEL,
    mutate: (t) => sub(t, "    void api?.chat?.dismissSteer?.(sessionId ?? \"\", id);", "    void api; // 变异：只删渲染层"),
  },
];

/* ---------------- 以下与 mut-a1145-search-autofill.mjs 同构 ---------------- */
const arg = process.argv;
const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  return spawnSync(process.execPath, [
    join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot",
  ], { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
}

const mode = arg.includes("--list") ? "list"
  : arg.includes("--restore") ? "restore"
    : arg.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  /* ⚠️⚠️ 本块曾与 mut-a1145 同构，但抄漏了 manifest —— 老的写法是
     `Number(arg[arg.indexOf("--apply") + 1] || arg[arg.indexOf("--restore") + 1] || 0)`，
     在 `--restore`（不带条目号）时 `indexOf("--apply")` = -1 ⇒ 取到 `arg[0]`（node 路径）
     ⇒ `Number(路径)` = NaN ⇒ `MUTATIONS[NaN-1]` = undefined ⇒ 报「没有第 NaN 条变异」退出。
     后果（实测事故）：`_run-mut-batch.sh` 每轮调的都是**无参 `--restore`** ⇒ **还原从未生效**，
     4 个源文件（含 458KB 的 `gui/src/main/index.ts`、499KB 的 `ChatPanel.tsx`）
     停在变异态被当成下一轮基线 ⇒ 变异判读全污染（铁律 30）。
     ⇒ 改为 manifest 式：`--apply N` 写 manifest（含 sha256），`--restore`（无参）按它逐字节还原。 */
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(arg[arg.indexOf("--apply") + 1]);
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
    catch (e) { console.error(`锚点未命中（变异体没落地）：${m.name}
    ${e.message}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
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

// full：基线必须先绿，否则"变异后红"说明不了任何事
const base = runSpec();
const baseOut = ((base.stdout || "") + (base.stderr || "")).replace(/\u001b\[[0-9;]*m/g, "");
if (!/Tests\s+\d+\s+passed/.test(baseOut) || base.status !== 0) {
  console.error("基线不绿，先修基线（本次：" + baseOut.split("\n").filter((l) => /Tests|FAIL/.test(l)).join(" | ") + "）");
  process.exit(1);
}
console.log("基线全绿，开始逐条变异");

let caught = 0, missed = 0;
for (const [i, m] of MUTATIONS.entries()) {
  const n = i + 1;
  const p = abs(m.file);
  const backup = join(SAVE_DIR, `${basename(m.file)}.orig`);
  mkdirSync(SAVE_DIR, { recursive: true });
  const before = hash(p);
  writeFileSync(backup, readFileSync(p));
  let body;
  try {
    body = m.mutate(readFileSync(p, "utf8"));
  } catch (e) {
    console.log(`✗ M${n} 变异体没落地：${e.message}`);
    writeFileSync(p, readFileSync(backup));
    continue;
  }
  writeFileSync(p, body);
  const r = runSpec();
  const out = ((r.stdout || "") + (r.stderr || "")).replace(/\u001b\[[0-9;]*m/g, "");
  // 判"被抓住"要**两个条件**：退出码 ≠ 0 **且**真有 `Tests … failed` 行
  //（只看退出码，会把"改成编译不过"算成抓住）
  const red = r.status !== 0 && /Tests\s+\d+\s+failed/.test(out);
  writeFileSync(p, readFileSync(backup));
  const after = hash(p);
  if (after !== before) { console.log(`⚠ M${n} 还原后哈希不一致！`); }
  if (red) { caught++; console.log(`✓ M${n} 抓住了`); } else { missed++; console.log(`✗ M${n} 存活 ← 守卫有漏`); }
}
try { rmSync(SAVE_DIR, { recursive: true, force: true }); } catch { /* noop */ }
console.log(`\n汇总：抓住 ${caught} / ${MUTATIONS.length}`);
process.exit(missed ? 1 : 0);
