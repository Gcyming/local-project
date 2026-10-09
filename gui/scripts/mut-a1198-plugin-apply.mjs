#!/usr/bin/env node
/**
 * mut-a1198-plugin-apply.mjs — 扩展页「草稿 → 保存 → 重启统一生效」的变异验证。
 *
 * ## 这一层在防什么（用户口径原话）
 * 「现在的扩展生效有点问题，生效有点慢，而且要通过刷新页面才行。
 *   为扩展页也做一个保存功能吧，即通过拨片打开的扩展要保存后才统一生效。
 *   保存后刷新整个 slime 程序以刷新 slime 状态加载扩展能力。」
 *
 * 即：启停/信任**不再逐个即时应用**（那是「慢 + 要刷页面」的根源），
 * 统一收敛到「记草稿 → 一次写盘 → app.relaunch 重启加载」这一个确定性生效点。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 点回原值不消草稿 | 假脏标记：明明与服务器一致还提示「待生效」 | trust ③草稿逻辑 |
 * | 2 | 草稿无脑记（不与服务器比） | 每点一下都脏，且永远消不掉 | trust ③草稿逻辑 |
 * | 3 | 剪枝不剪「已与服务器一致」 | 外部变化后草稿变僵尸（保存时反复写同值） | trust ③草稿逻辑 |
 * | 4 | 剪枝不剪「插件已消失」 | 卸载后草稿仍留着（保存时刷不存在插件的错） | trust ③草稿逻辑 |
 * | 5 | 载荷不排序 | 同一草稿两次保存写出不同顺序的文件 | trust ③草稿逻辑 |
 * | 6 | 拨片直接改服务器状态（不入草稿） | 回退为逐个即时应用（慢+半生效） | toggle ②UI |
 * | 7 | 保存条恒显示（不看草稿数） | 无事也摆个「保存并重启」死按钮 | toggle ②UI |
 * | 8 | 保存后不重启 | 写盘了但能力不加载（用户还得手动重启） | toggle ②生效点 |
 * | 9 | 保存段内加回 reloadPlugins | 退回「保存前就部分生效」（半生效） | toggle ②生效点 |
 * | 10 | 系统默认插件守卫删 | 能把 builtin 插件停用（越过不可卸载红线） | toggle ②接线 |
 * | 11 | trust 写盘换成读（不落盘） | 信任重启后丢失（开关是假的） | trust ③接线 |
 * | 12 | 旧逐个通道复活（enable） | 又有了「点了就即时应用」的假出口 | toggle ②旧通道退场 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-apply.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1196-plugin-toggle.spec.ts",
  "tests/core-ts/a1198-plugin-trust.spec.ts",
];

const F_DRAFT = "gui/src/renderer/pages/pluginsDraft.ts";
const F_PANEL = "gui/src/renderer/pages/PluginsPanel.tsx";
const F_MAIN = "gui/src/main/index.ts";
const F_IPC = "gui/src/shared/ipc.ts";
const TARGETS = [F_DRAFT, F_PANEL, F_MAIN, F_IPC];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1198-apply");

const MUTATIONS = [
  {
    name: "1 点回原值不消草稿（假脏标记）",
    file: F_DRAFT,
    mutate: (t) => sub(
      t,
      "  if (desired === serverValue) {\n    delete next[name]; // 点回原值 = 撤销该条草稿（脏标记必须诚实）\n  } else {\n    next[name] = desired;\n  }",
      "  if (false) {\n    delete next[name];\n  } else {\n    next[name] = desired;\n  }",
    ),
  },
  {
    name: "2 信任草稿写进 toggles（保存时变成停用插件）",
    file: F_DRAFT,
    /* ⚠️ 变异点选择教训：原拟「草稿无脑记」——但把 `next` 预置成[name]:desired 之后
       点回原值仍会走 delete 分支，**等价变异**（实测存活）。改打「两个 map 写混」：
       信任草稿落进 toggles ⇒ 保存时会被当成「停用该插件」写进禁用名单。 */
    mutate: (t) => sub(
      t,
      "  return { ...draft, trust: withValue(draft.trust, name, desired, serverTrusted) };",
      "  return { ...draft, toggles: withValue(draft.toggles, name, desired, serverTrusted) };",
    ),
  },
  {
    name: "3 剪枝不剪「已与服务器一致」（僵尸草稿）",
    file: F_DRAFT,
    mutate: (t) => sub(
      t,
      "    if (s && desired !== s.on) { toggles[name] = desired; }",
      "    if (s) { toggles[name] = desired; }",
    ),
  },
  {
    name: "4 剪枝不剪「插件已消失」（两处同改，嵌套 sub）",
    file: F_DRAFT,
    /* ⚠️ 只改 trust 那一行是**无效变异**（实测存活）：守卫的空map 用例里草稿只有 toggles，
       trust 循环压根不跑。⇒ 两行必须一起改，才造得出「卸载后草稿仍留着」。 */
    mutate: (t) => sub(
      sub(
        t,
        "    if (s && desired !== s.on) { toggles[name] = desired; }",
        "    if (s || !s) { toggles[name] = desired; }",
      ),
      "    if (s && desired !== s.trusted) { trust[name] = desired; }",
      "    if (s || !s) { trust[name] = desired; }",
    ),
  },
  {
    name: "5 载荷不排序（写盘不稳定）",
    file: F_DRAFT,
    mutate: (t) => sub(
      t,
      "    toggles: Object.keys(draft.toggles).sort(byName).map((name) => ({ name, enabled: draft.toggles[name] })),\n    trust: Object.keys(draft.trust).sort(byName).map((name) => ({ name, trusted: draft.trust[name] })),",
      "    toggles: Object.keys(draft.toggles).map((name) => ({ name, enabled: draft.toggles[name] })),\n    trust: Object.keys(draft.trust).map((name) => ({ name, trusted: draft.trust[name] })),",
    ),
  },
  {
    name: "6 拨片直接改服务器状态（不入草稿）",
    file: F_PANEL,
    /* 回退为逐个即时应用的形态：onToggle 收 (row, shownOn) 却只把 shownOn 传下去，
       不折算 desired 也不比 serverOn —— 点一下就"生效"（无草稿、无保存条）。 */
    mutate: (t) => sub(
      t,
      "    setDraft((d) => setToggleDraft(d, row.name, !shownOn, serverOn));",
      "    void shownOn; void serverOn;",
    ),
  },
  {
    name: "7 保存条恒显示（不看草稿数）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      {draftCount > 0 && (",
      "      {true && (",
    ),
  },
  {
    name: "8 保存后不重启（写盘但不加载）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      await a.extras.appRelaunch();",
      "      /* mutated: 不重启 */",
    ),
  },
  {
    name: "9 保存段内加回 reloadPlugins（半生效）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    const state = await ensurePluginHost();\n    const applied = { toggles: 0, trust: 0 };",
      "    const state = await ensurePluginHost();\n    await reloadPlugins();\n    const applied = { toggles: 0, trust: 0 };",
    ),
  },
  {
    name: "10 系统默认插件守卫删（能停用 builtin）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "      if (!rec.unloadable) { errors.push(`系统默认插件不可停用：${name}`); continue; }",
      "      /* mutated: builtin 也照写 */",
    ),
  },
  {
    name: "11 信任写盘换成读（不落盘 ⇒ 重启丢失）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "        writePluginTrust(dir, t?.trusted === true);",
      "        readPluginTrust(dir);",
    ),
  },
  {
    name: "12 旧逐个通道复活（enable 即时应用）",
    file: F_IPC,
    mutate: (t) => sub(
      t,
      "  plugins_reload: \"slime:plugins:reload\",",
      "  plugins_reload: \"slime:plugins:reload\",\n  plugins_enable: \"slime:plugins:enable\",",
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
if (reportEolProblems(eolFound, "mut-a1198-apply")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-apply.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length === 0) { process.exit(1); }
process.exit(1);