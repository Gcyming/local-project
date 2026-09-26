#!/usr/bin/env node
/**
 * gui/scripts/mut-a1100.mjs — A-1100 守卫的变异验证（「保存按钮点了没反应」+「调试面板有 error」）。
 *
 * 这两句话是**同一个根因的两个症状**：`ipcRenderer.invoke` 在通道**尚未注册**时 **reject**，
 * 而调用点若用**裸 `await`**，异常抛出后 ① 同一 `async` 体后续语句不执行（按钮没反应）
 * ② 未捕获的 reject 变 `Uncaught (in promise)` 红字（调试面板 error）。
 * ⇒ 修法是**两个独立的坑各堵一处**：注册位置（主进程）+ 调用点兜底（`ipcSafe.ts` 安全口）。
 *
 * ## 覆盖的十二条
 *
 *   1  启动期注册被删（退回"只剩惰性块"的历史形态 ⇒ 冷启动点保存直接 reject）
 *   2  同一通道被**搬回惰性块**（两处注册 = 第二真相源）
 *   3  `applySubagentModels` 不再落盘（所谓"保存成功"只活在内存里，重启即失）
 *   4  【事故本体】保存按钮退回**裸 await**（弹层卡住 + 界面零提示 + 控制台红字）
 *   5  保存失败分支改回 `setNotice`（提示落到弹层**背后**，用户看不见）
 *   6  `clearRuns` 退回裸 await（同族第十处产地）
 *   7  可派发选择开关退回裸 await（同族第十一处产地）
 *   8  `act` 退回裸 await（这一处是定时任务触发/暂停/删除与子代理派发的**公共出口**）
 *   9  `ensureAgent` 退回 `api.agents?.create?.(…).catch(…)` 形态
 *      （可选链短路 ⇒ 在 `undefined` 上取 `.catch` ⇒ 同步 TypeError ⇒ 未捕获红字）
 *  10  打开弹层不清 `saveError`（重开还挂着上一次的错误）
 *  11  安全口的 `catch` 把 reject **吞成成功**（用户以为写成功了，其实一个字没写）
 *  12  安全口的 `undefined` 分支被删（"通道不存在"被伪装成"调用成功"）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 目标文件行尾是**混的**（main/index.ts = LF；ResidentPanel.tsx = CRLF；ipcSafe.ts = LF）
 *    ⇒ 一律走共享模块 `sub()`（它自己做行尾无关）。
 * ⚠️ 每条变异的**首** `sub(t, CONST, …)` 必须锚在一个顶层常量上 ——
 *    `check-mut-anchors.mjs` 只核验首条锚点（多步变异也只认第一步，故多步要紧的是第一步命中）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1100.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1100.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1100.mjs --apply 4   # 只改第 4 条并留着（跑不了子进程的环境）
 *   node gui/scripts/mut-a1100.mjs --restore   # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 node→node 报 EBUSY）
 *
 *   ```bash
 *   set -o pipefail                      # ⚠️ 没有它，$? 取到的是 sed 的退出码（恒 0）⇒ 全部误报
 *   for n in $(seq 1 12); do
 *     node gui/scripts/mut-a1100.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     out=$(node node_modules/vitest/vitest.mjs run tests/gui/a1100-subagent-model-save.spec.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g')
 *     red=$?
 *     node gui/scripts/mut-a1100.mjs --restore >/dev/null
 *     if [ "$red" = "1" ] && printf '%s' "$out" | grep -q "Tests" && printf '%s' "$out" | grep -q "AssertionError"; then
 *       echo "M$n ✅ 被捕获"; else echo "M$n ❌ 未被捕获"; fi
 *   done
 *   ```
 *   ⚠️ 判捕获必须**同时**确认输出里有 `Tests` 汇总行与 `AssertionError` ——
 *   否则"零测试执行"（收集失败）会被当成捕获。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1100-subagent-model-save.spec.ts"];

const F_MAIN = "gui/src/main/index.ts";
const F_RESIDENT = "gui/src/renderer/pages/ResidentPanel.tsx";
const F_SAFE = "gui/src/renderer/pages/ipcSafe.ts";
const TARGETS = [F_MAIN, F_RESIDENT, F_SAFE];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1100");

/* ── 锚点：一律顶层常量 + 拼接字面量（`check-mut-anchors.mjs` 的 constMap 才能解析） ── */

/* ── ① 主进程（main/index.ts，LF） ── */
/** 启动期那行注册（含前导换行 —— 删除时要连行一起删，不留空行） */
const REG_SETMODELS_LINE =
  "\n"
  + "  ipcMain.handle(\"slime:resident:subagent:setModels\", (_e, p: { models?: unknown }) => setSubagentModels(p?.models));";

/** 惰性块里那句「A-1096」注释头 —— 用它当插入点（把注册"搬回"惰性块） */
const LAZY_BLOCK_ANCHOR = "      /* A-1096：子代理「可派发」读写 —— **与 Agent 设置里的开关同一个真相源**";

/** 惰性块缩进（6 空格）的同一行注册 —— 用于制造"两处注册"。
 *  ⚠️ 它**不是**删除锚点（那是 REG_SETMODELS_LINE），只是插入体，故无需唯一。 */
const REG_SETMODELS_LAZY =
  "      ipcMain.handle(\"slime:resident:subagent:setModels\", (_e, p: { models?: unknown }) => setSubagentModels(p?.models));\n";

/** `applySubagentModels` 里的落盘那一行（唯一） */
const PERSIST_LINE = "  saveSubagentDefaultModels(models);";

/* ── ② 渲染层（ResidentPanel.tsx，CRLF）—— 五处写调用点，逐处退回裸调 ── */
/** 保存按钮那次提交（安全口形态；退回裸 await 就是事故本体） */
const SAVE_SAFE_LINE = "const r: any = asReply(await tryInvoke(() => api.resident?.subagentSetModels?.(draftModels)));";
/** 保存失败分支那一行（唯一 —— 同 handler 里另有 `setSaveError("")`，故不能用裸 `setSaveError(` 判） */
const SAVE_ELSE_LINE = "setSaveError(`保存失败：${r?.error ?? \"主进程未返回结果\"}`);";
/** `act` 的公共出口 */
const ACT_SAFE_LINE = "const r: any = asReply(await tryInvoke(fn));";
/** `clearRuns`（清空历史） */
const CLEAR_SAFE_LINE = "const r: any = asReply(await tryInvoke(() => api.resident?.subagentClear?.()));";
/** 可派发 Agent 的勾选开关 */
const SELECT_SAFE_LINE = "const r: any = asReply(await tryInvoke(() => api.resident?.subagentSetSelection?.(next)));";
/** `ensureAgent` 走安全口那两行（整体替换，否则后半段会引用已消失的 `r`） */
const ENSURE_SAFE_BLOCK =
  "    const r = await tryInvoke(() => api.agents?.create?.(\"助手\", \"通用助理\"));\n"
  + "    const a: any = r.ok ? r.value : null;";
/** 打开弹层那句（清错误必须在同一句里） */
const OPEN_HANDLER = "setModelModal(true); setSaveError(\"\");";

/* ── ③ 安全口本身（ipcSafe.ts，LF） ── */
/** `catch` 支的返回（把它改成 ok:true 就把 reject 吞成成功了） */
const CATCH_RETURN_LINE = "    return { ok: false, error: e instanceof Error ? e.message : String(e) };";
/** 「通道方法缺失」那条独立分支（删掉它，`undefined` 就会被当成成功） */
const UNDEF_GUARD_LINE =
  "    if (v === undefined) { return { ok: false, error: \"通道不可用（后台服务尚未就绪，请稍候重试）\" }; }";

const MUTATIONS = [
  /* ── ① 主进程：通道注册位置 ─────────────────────────────────────── */
  {
    name: "1 【根因①】启动期注册被删（退回只剩惰性块的历史形态 ⇒ 冷启动点保存直接 reject）",
    file: F_MAIN,
    mutate: (t) => sub(t, REG_SETMODELS_LINE, ""),
  },
  {
    name: "2 同一通道被搬回惰性块（两处注册 = 第二真相源）",
    file: F_MAIN,
    mutate: (t) => sub(t, LAZY_BLOCK_ANCHOR, REG_SETMODELS_LAZY + LAZY_BLOCK_ANCHOR),
  },

  /* ── ② 主进程：写链路必须落盘 ───────────────────────────────────── */
  {
    name: "3 【唯一真相源】`applySubagentModels` 不再落盘（保存只活在内存里，重启即失）",
    file: F_MAIN,
    mutate: (t) => sub(t, PERSIST_LINE, ""),
  },

  /* ── ③ 渲染层：每个写调用点都必须有兜底 ─────────────────────────── */
  {
    name: "4 【事故本体】保存按钮退回**裸 await**（弹层卡住 + 界面零提示 + 控制台红字）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, SAVE_SAFE_LINE, "const r: any = await api.resident?.subagentSetModels?.(draftModels);"),
  },
  {
    name: "5 保存失败分支改回 `setNotice`（提示落到弹层**背后**，用户看不见）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, SAVE_ELSE_LINE, "setNotice(`保存失败：${r?.error ?? \"未知\"}`);"),
  },
  {
    name: "6 `clearRuns` 退回裸 await（同族：清空历史按钮同样会冷启动静默失效）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, CLEAR_SAFE_LINE, "const r: any = await api.resident?.subagentClear?.();"),
  },
  {
    name: "7 可派发 Agent 选择开关退回裸 await（同族：勾选后界面不同步、控制台红字）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, SELECT_SAFE_LINE, "const r: any = await api.resident?.subagentSetSelection?.(next);"),
  },
  {
    name: "8 `act` 退回裸 await（定时任务触发/暂停/删除 + 子代理派发的**公共出口**，一处塌全场塌）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, ACT_SAFE_LINE, "const r: any = await fn();"),
  },
  {
    name: "9 【同族·另一处产地】`ensureAgent` 退回 `?.().catch(…)`（可选链短路 ⇒ 在 undefined 上取 .catch ⇒ 同步 TypeError ⇒ 未捕获红字）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, ENSURE_SAFE_BLOCK, "    const a: any = await api.agents?.create?.(\"助手\", \"通用助理\").catch(() => null);"),
  },
  {
    name: "10 打开弹层不清 `saveError`（重开还挂着上一次的错误）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, OPEN_HANDLER, "setModelModal(true);"),
  },

  /* ── ④ 安全口本身：任何一支都不许把失败吞成成功 ─────────────────── */
  {
    name: "11 安全口的 `catch` 把 reject **吞成成功**（用户以为写成功了，其实一个字没写）",
    file: F_SAFE,
    mutate: (t) => sub(t, CATCH_RETURN_LINE, "    return { ok: true, value: undefined as T };"),
  },
  {
    name: "12 安全口的 `undefined` 分支被删（「通道不存在」被伪装成「调用成功」）",
    file: F_SAFE,
    mutate: (t) => sub(t, UNDEF_GUARD_LINE, "    /* 变异：通道缺失也放行（静默失效形态） */"),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
    if (r.status !== 0) { return { ok: false, spawnBlocked: false, spec }; }
  }
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
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);           // **字节**备份
    const text = src.toString("utf8");
    const next = m.mutate(text);
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

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* 中断即还原：`finally` 在 Ctrl+C（SIGINT 直接终止、不展开栈）下**不执行** ——
   没这道保险，变异会留在源码里，下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿（本仓实测踩到过）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
  console.error("请改用 --apply / --restore + shell 循环（命令见本文件头部注释）。");
  process.exit(1);
}
if (!base.ok) {
  console.error(`基线未通过（${base.spec}）—— 先修好测试再跑变异。`);
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1100")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.ok) {
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

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) {
  console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}（${leftovers.join(", ")}）`);
  process.exit(1);
}
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
