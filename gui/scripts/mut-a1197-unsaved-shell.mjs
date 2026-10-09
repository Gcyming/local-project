#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-unsaved-shell.mjs — A-1197「未保存改动的离开确认覆盖面补全」的变异验证。
 *
 * ## 这一轮改的是什么
 * 上一轮只在 AgentsPanel 内拦了「切换 Agent」。剩下两条会把未保存改动弄丢的路径：
 *   (A) 关掉整个设置弹窗（遮罩 / 关闭按钮 / Esc）
 *   (B) 在设置弹窗内切到别的设置页（侧栏 / PluginsPanel 的 onNavigate / 搜索框派生页）
 * 两条的手势都发生在 SettingsDialog，而判脏的那份数据在 AgentsPanel。
 *
 * ## 方案（本轮的核心决策）
 * 判据**只有一份**，全部留在 AgentsPanel：外壳通过 `onRegisterLeaveGate` 拿到一个
 * 闸门（isDirty / isConfirming / requestLeave），自己既不判脏也不存快照。
 * 理由：两份判据必然漂移 —— 加字段只改一处 ⇒ 某一路径静默失守，而"只在一处失守"
 * 恰恰是最难被发现的形态（另一条路径的守卫仍然全绿）。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 遮罩直接 onClose | (A) 遮罩关闭无提示丢改动 | 三个手势都接到 requestClose |
 * | 2 | 关闭按钮直接 onClose | (A) 点叉关闭无提示丢改动 | 同上 |
 * | 3 | Esc 不接闸门 | (A) 键盘用户有一条无提示的丢改动入口 | 同上 |
 * | 4 | 侧栏切页直接 setTab | (B) 点设置页无提示丢改动 | 两条切页入口都走 requestTab |
 * | 5 | onNavigate 绕过闸门 | (B) 扩展页跳转丢改动 | 同上 |
 * | 6 | leaveViaGate 不问闸门 | 两条路径整体失守 | requestLeave 是唯一收口 |
 * | 7 | requestLeave 忽略 isConfirming | 弹窗挂起时按 Esc 把整个设置关掉 | isConfirming 让位 |
 * | 8 | requestClose 直接执行 | (A) requestLeave 被绕开 | requestClose 交给闸门 |
 * | 9 | requestTab 直接 setTab | (B) requestLeave 被绕开 | requestTab 交给闸门 |
 * | 10 | 搜索派生页不钉住 | 敲一个字就让面板卸载、改动消失 | pinnedByUnsaved |
 * | 11 | 面板卸载时不注销闸门 | 外壳握着死闸门放行（且内存泄漏） | 卸载必须 register(null) |
 * | 12 | 闸门重建 effect 带依赖数组 | 闭包停在首次渲染 ⇒ 永远判「不脏」 | 重建 effect 无依赖 |
 * | 13 | shell 闸门无视 hintHidden | 勾了「以后不再」关弹窗时还弹 = 假装有关闭 | 放行条件含 hintHidden |
 * | 14 | 外壳自己判脏 | 第二份判据 ⇒ 字段清单漂移 | 外壳不许出现快照比对 |
 * | 15 | 弹窗按钮不按 kind 分派 | 关弹窗类离开卡死在弹窗态（无出口） | commitPendingLeave 分派 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-unsaved-shell.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-unsaved-shell.spec.ts",
];

const F_PANEL = "gui/src/renderer/pages/AgentsPanel.tsx";
const F_SHELL = "gui/src/renderer/pages/SettingsDialog.tsx";
const TARGETS = [F_PANEL, F_SHELL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-shell");

const MUTATIONS = [
  /* ── ① (A) 关闭设置弹窗：三条手势各自绕过闸门 ─────────────────────── */
  {
    name: "1 遮罩点击直接 onClose（点遮罩关闭无提示丢改动）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      "      onClick={(e) => { if (e.target === e.currentTarget) { requestClose(); } }}>",
      "      onClick={(e) => { if (e.target === e.currentTarget) { props.onClose(); } }}>",
    ),
  },
  {
    name: "2 关闭按钮直接 onClose（点叉关闭无提示丢改动）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      '<button className="titlebar-btn" title="关闭设置" onClick={requestClose}>',
      '<button className="titlebar-btn" title="关闭设置" onClick={props.onClose}>',
    ),
  },
  {
    name: "3 Esc 不接闸门（键盘用户有一条无提示的丢改动入口）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      "      requestClose();\n    };\n    window.addEventListener(\"keydown\", onKey);",
      "      /* 变异：Esc 直接放行 */\n    };\n    window.addEventListener(\"keydown\", onKey);",
    ),
  },
  /* ── ② (B) 切页：两条入口各自绕过闸门 ───────────────────────────── */
  {
    name: "4 侧栏切页直接 setTab（点设置页无提示丢改动）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      "onClick={() => requestTab(s.id)}",
      "onClick={() => setTab(s.id)}",
    ),
  },
  {
    name: "5 PluginsPanel 的 onNavigate 绕过闸门（扩展页跳转丢改动）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      "onNavigate={(t) => { requestTab(t, true); }}",
      "onNavigate={(t) => { setTab(t); setQuery(\"\"); }}",
    ),
  },
  /* ── ③ 闸门收口 ─────────────────────────────────────────────────── */
  {
    name: "6 leaveViaGate 不问闸门（两条离开路径整体失守）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      "    const gate = shellGateRef.current;\n    if (!gate) { run(); return; }",
      "    run();\n    return;\n    /* eslint-disable-next-line no-unreachable */\n    const gate = shellGateRef.current;\n    if (!gate) { run(); return; }",
    ),
  },
  {
    name: "7 requestLeave 忽略 isConfirming（弹窗挂起时按 Esc 把整个设置关掉）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      "    if (gate.isConfirming()) { return; }\n",
      "",
    ),
  },
  {
    name: "8 requestClose 直接执行动作（不再过闸门）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      '    leaveViaGate("关闭设置", () => { props.onClose(); });',
      "    props.onClose();",
    ),
  },
  {
    name: "9 requestTab 直接 setTab（不再过闸门）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      "    leaveViaGate(`切到「${labelOf(next)}」`, () => {\n      setTab(next);\n      if (clearQuery) { setQuery(\"\"); }\n    });",
      "    setTab(next);\n    if (clearQuery) { setQuery(\"\"); }",
    ),
  },
  {
    name: "10 搜索派生页不钉住（敲一个字就让面板卸载、改动消失）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      "  const activeTab = pinnedByUnsaved\n    ? \"agents\"\n    : (filtered.some((s) => s.id === tab) ? tab : (filtered[0]?.id ?? tab));",
      "  const activeTab = filtered.some((s) => s.id === tab) ? tab : (filtered[0]?.id ?? tab);",
    ),
  },
  /* ── ④ 闸门的注册与保鲜 ─────────────────────────────────────────── */
  {
    name: "11 面板卸载时不注销闸门（外壳握着死闸门放行 + 内存泄漏）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    return () => { register(null); };",
      "    return () => { /* 变异：不注销 */ };",
    ),
  },
  {
    name: "12 闸门重建 effect 带依赖数组（闭包停在首次渲染 ⇒ 永远判「不脏」）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      requestLeave: (target: AgentShellLeave) => { requestShellLeave(target); },\n    };\n  });",
      "      requestLeave: (target: AgentShellLeave) => { requestShellLeave(target); },\n    };\n  }, []);",
    ),
  },
  /* ── ⑤ 语义一致性 ───────────────────────────────────────────────── */
  {
    name: "13 shell 闸门无视 hintHidden（勾了「以后不再」关弹窗时还弹）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    if (!isDirtyNow() || hintHidden) { commitShellLeave(target); return; }",
      "    if (!isDirtyNow()) { commitShellLeave(target); return; }",
    ),
  },
  {
    name: "14 外壳自己判脏（第二份判据 ⇒ 字段清单漂移）",
    file: F_SHELL,
    mutate: (t) => sub(
      t,
      "  const shellGateRef = React.useRef<AgentLeaveGate | null>(null);",
      "  const shellGateRef = React.useRef<AgentLeaveGate | null>(null);\n  const localSnapshotRef = React.useRef<string>(\"\");\n  const localIsDirty = (): boolean => localSnapshotRef.current !== \"dirty\";",
    ),
  },
  {
    name: "15 弹窗按钮不按 kind 分派（关弹窗类离开卡死在弹窗态）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    if (next.kind === \"select\") { commitLeave({ kind: \"select\", agentId: next.agentId }); return; }\n    commitShellLeave({ label: next.label, run: next.run });",
      "    commitLeave({ kind: \"select\", agentId: next.agentId });",
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
if (reportEolProblems(eolFound, "mut-a1197-shell")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-unsaved-shell.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 2) { process.exit(1); }
process.exit(1);
