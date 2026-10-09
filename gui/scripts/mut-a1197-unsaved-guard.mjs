#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-unsaved-guard.mjs — A-1197「Agent 配置未保存离开守卫」的变异验证。
 *
 * ## 这一轮改的是什么（用户原话）
 * 「Agent 修改不点保存保存不了，你设计一个 slime 的弹窗提示未保存改动（是否退出），
 *   下面加个『以后不再出现此提示』的勾选项」
 *
 * ## 定位结论（为什么守卫挂在 AgentsPanel，而不是 ProvidersPanel）
 * `AgentsPanel.patchDetail()` 只改本地 state，只有 `saveDetail()` 才 `agents.update()` 写回；
 * 切到别的 Agent 时 `useEffect` 用服务端值覆盖 `detail` ⇒ 未保存的编辑**静默消失**。
 * （ProvidersPanel 也有 fileDirty，但它管的是配置文件文本框，与「Agent 修改」语义不符。）
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 基线 ref 不再初始化为 "" | 判脏恒为真 ⇒ 刚打开就弹窗 | 已落盘基线 ref |
 * | 2 | 判脏被短路成 false | 未保存改动直接静默丢弃（原病复发） | isDirtyNow |
 * | 3 | 快照漏掉 role | 改「设定」不标脏 ⇒ 丢失 | 快照只覆盖可编辑字段 |
 * | 4 | 快照多算 name | 只读展示字段也算改动 ⇒ 平白弹窗 | 同上 |
 * | 5 | selectAgent 绕过闸门直接切 | 原始 bug 完整复发 | selectAgent 走 requestLeave |
 * | 6 | requestLeave 无视 hintHidden | 勾了「以后不再」仍然弹 = 假装有关闭 | 放行条件含 hintHidden |
 * | 7 | 无脏时也挂起弹窗 | 一切换就弹，连没改过的人都被拦 | 放行条件先判 isDirtyNow |
 * | 8 | 勾选不落盘 | 关不掉；刷新后又要弹 | 勾选即持久化 |
 * | 9 | 初始值不读持久化 | 刷新后忘记勾过 | 初始值从持久化读入 |
 * | 10 | AgentsPanel 自己写 localStorage | 第二产地 ⇒ 键位漂移 | 不许裸 localStorage |
 * | 11 | operationFocus 吞掉存储异常 | 静默失效，用户以为关掉了 | 出声不静默 |
 * | 12 | 保存失败也重置基线 | 以为存好了，离开不再被拦 | 只有 res.ok 才重置 |
 * | 13 | 服务端回填不重置基线 | 切 Agent 拿新内容比旧基线 ⇒ 满屏误报 | 回填即重置 |
 * | 14 | 判脏丢「真编辑过」半边 | 假脏复发：不改也弹（用户实测） | 双条件（editedRef） |
 * | 15 | 编辑不置 editedRef | 真改动不再拦（漏拦 = 静默丢改动） | patchDetail 置位断言 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-unsaved-guard.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-unsaved-guard.spec.ts",
];

const F_PANEL = "gui/src/renderer/pages/AgentsPanel.tsx";
const F_OPFOCUS = "gui/src/renderer/pages/operationFocus.ts";
const TARGETS = [F_PANEL, F_OPFOCUS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-unsaved");

const MUTATIONS = [
  /* ── ① 基线与判脏 ───────────────────────────────────────────────── */
  {
    name: "1 基线 ref 不再初始化（判脏恒为真，一打开就弹）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      'const savedRef = React.useRef<string>("");',
      'const savedRef = React.useRef<string>("\\u0000never");',
    ),
  },
  {
    name: "2 判脏被短路成 false（未保存改动静默丢弃，原病复发）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "return editedRef.current && unsavedSnapshot(detail) !== savedRef.current;",
      "return false;",
    ),
  },
  /* ── ② 快照覆盖度 ───────────────────────────────────────────────── */
  {
    name: "3 快照漏掉 role（改「设定」不标脏，改动丢失）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    role: d.role,\n",
      "",
    ),
  },
  {
    name: "4 快照多算 name（只读展示字段也算改动，平白弹窗）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    role: d.role,\n",
      "    name: d.name,\n    role: d.role,\n",
    ),
  },
  /* ── ③ 闸门 ─────────────────────────────────────────────────────── */
  {
    name: "5 selectAgent 绕过闸门直接切（原始 bug 完整复发）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '  const selectAgent = (id: string): void => {\n    if (id === selectedId) { return; }\n    requestLeave({ kind: "select", agentId: id });\n  };',
      '  const selectAgent = (id: string): void => {\n    if (id === selectedId) { return; }\n    setLocalId(id);\n    props.onSelectAgent(id);\n  };',
    ),
  },
  {
    name: "6 requestLeave 无视 hintHidden（勾了「以后不再」仍弹）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    if (!isDirtyNow() || hintHidden) { commitLeave(next); return; }",
      "    if (!isDirtyNow()) { commitLeave(next); return; }",
    ),
  },
  {
    name: "7 无脏时也挂起弹窗（没改过的人也被拦）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    if (!isDirtyNow() || hintHidden) { commitLeave(next); return; }\n    setPendingLeave(next);",
      "    setPendingLeave(next);",
    ),
  },
  /* ── ④ 持久化 ───────────────────────────────────────────────────── */
  {
    name: "8 勾选「以后不再」不落盘（关不掉，刷新后又弹）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    setHintHidden(v);\n    writeUnsavedHintHidden(v);",
      "    setHintHidden(v);",
    ),
  },
  {
    name: "9 初始值不读持久化（刷新后忘记勾过）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "React.useState<boolean>(() => readUnsavedHintHidden())",
      "React.useState<boolean>(false)",
    ),
  },
  {
    name: "10 AgentsPanel 自己写 localStorage（第二产地 ⇒ 键位漂移）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    setHintHidden(v);\n    writeUnsavedHintHidden(v);",
      '    setHintHidden(v);\n    try { window.localStorage.setItem("slime.unsavedChanges.hintHidden", v ? "1" : "0"); } catch { }',
    ),
  },
  {
    name: "11 operationFocus 静默吞掉存储异常（用户以为关掉了其实没关）",
    file: F_OPFOCUS,
    mutate: (t) => sub(
      t,
      "  try {\n    window.localStorage.setItem(UNSAVED_HINT_KEY, hidden ? \"1\" : \"0\");\n  } catch (e) {\n    console.error(\"[unsaved-hint] 写入失败，「以后不再」未生效（下次仍会提示）：\", e);\n  }",
      "  try {\n    window.localStorage.setItem(UNSAVED_HINT_KEY, hidden ? \"1\" : \"0\");\n  } catch { }",
    ),
  },
  /* ── ⑤ 基线重置时机 ─────────────────────────────────────────────── */
  {
    name: "12 保存失败也重置基线（以为存好了，离开不再被拦）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '      } else {\n        showNotice(false, "保存失败");\n      }',
      '      } else {\n        showNotice(false, "保存失败");\n        markSavedFromServer(detail);\n      }',
    ),
  },
  {
    name: "13 服务端回填不重置基线（切 Agent 拿新内容比旧基线，满屏误报）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      markSavedFromServer(next);",
      "      /* 基线未更新：切 Agent 会拿新内容去比上一个 Agent 的快照 */",
    ),
  },
  /* ── 2026-10-08 新增：双条件的两个方向（用户实测「不改也弹」后加的加固）────── */
  {
    name: "14 双条件丢半边：判脏不再要求「真编辑过」（假脏复发，不改也弹）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "return editedRef.current && unsavedSnapshot(detail) !== savedRef.current;",
      "return unsavedSnapshot(detail) !== savedRef.current;",
    ),
  },
  {
    name: "15 双条件丢半边：编辑不置 editedRef（真改动不再拦）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    editedRef.current = true;\n    setDetail((prev) => (prev ? { ...prev, ...patch } : prev));",
      "    setDetail((prev) => (prev ? { ...prev, ...patch } : prev));",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error(`  - ${b}`); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1197-unsaved")) { process.exit(1); }

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
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    let next;
    try { next = m.mutate(text); }
    catch (e) {
      console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
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

/* ── 全量模式：提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-unsaved-guard.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 2) { process.exit(1); }
process.exit(1);