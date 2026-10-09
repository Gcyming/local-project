#!/usr/bin/env node
/**
 * gui/scripts/mut-a1196-toggle-freedom.mjs — A-1196「拨片开关 + 能力自述 + Loop 自由度」的变异验证。
 *
 * ## 这一轮改的是什么（用户原话）
 * ① 「扩展里面的除默认无法自己管理外，其他可管理扩展全部用**拨片开关动画**作为控制按钮」
 * ② 「它不知道自己的能力啊，slime 自己不知道自己的能力？」（截图：默认模式 Agent 被问
 *    「能给自己写插件吗」只能瞎猜，四个方向全没提到插件体系）
 * ③ 「创造模式自由度不够高 …… 自己定义 Agent-Loop」（→ L3：loop_config 参数化；设计见
 *    docs/creator-freedom-design.md）
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | mark 不落盘（只改内存 Set） | 开关"关"重启即复活（假开关） | a1196-toggle ① |
 * | 2 | 重扫不按名单关闭 | 点「重新装载」把关掉的插件装回来 | a1196-toggle ② |
 * | 3 | unload 不写名单 | 同上（关的动作本身不持久） | a1196-toggle ② |
 * | 4 | 开关滑块丢掉位移 | 拨片动画消失（只剩颜色跳变） | a1196-toggle ② |
 * | 5 | 两处能力自述不再注入 | Agent 又变成"不知道自己能干什么"（截图病复发） | a1196-self-awareness |
 * | 6 | 默认模式文案改成"可以自建" | 瞎承诺（承诺了却做不到） | a1196-self-awareness |
 * | 7 | ToolLoop 忽略 maxRounds | loop_config 写了不生效（假自由度） | a1196-loop-config |
 * | 8 | agentLoopBudget 放行负值 | 非法配置造成 0/负数轮循环等异常 | a1196-loop-config |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1196-toggle-freedom.mjs`
 * ⚠️ M3 的教训已写进 spec 的断言注释：**子串匹配会假命中**（`unmarkPluginDisabled` 含
 *    `markPluginDisabled`）—— 形状断言必须带词边界（负向后顾），这条正是变异测试抓出来的。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1196-plugin-toggle.spec.ts",
  "tests/core-ts/a1196-self-awareness.spec.ts",
  "tests/core-ts/a1196-loop-config.spec.ts",
];

const F_STORE = "core-ts/src/plugin/disabled-store.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_PANEL = "gui/src/renderer/pages/PluginsPanel.tsx";
const F_AGENTTOOLS = "core-ts/src/services/agentTools.ts";
const F_TOOLLOOP = "core-ts/src/tool_loop.ts";
const F_CHAT = "core-ts/src/services/chat.ts";
const TARGETS = [F_STORE, F_MAIN, F_PANEL, F_AGENTTOOLS, F_TOOLLOOP, F_CHAT];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1196");

const MUTATIONS = [
  /* ── ① 禁用名单持久化 ─────────────────────────────────────────── */
  {
    name: "1 mark 不落盘（关掉的插件重启即复活）",
    file: F_STORE,
    mutate: (t) => sub(
      t,
      "    set.add(n);\n    writeDisabledPlugins(filePath, set);",
      "    set.add(n);",
    ),
  },
  /* ── ② 重扫按名单关闭 / unload 写名单 ──────────────────────────── */
  {
    name: "2 重扫不按名单关闭（重新装载把关掉的插件装回来）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "  let disabledByStore = 0;\n  for (const name of readDisabledPlugins(PLUGINS_DISABLED_FILE)) {\n    const rec = host.get(name);\n    if (rec?.unloadable && rec.status === \"loaded\") {\n      await host.unload(name);\n      disabledByStore += 1;\n    }\n  }\n",
      "",
    ),
  },
  {
    name: "3 统一保存不写禁用名单（关的动作不持久）",
    file: F_MAIN,
    /* ⚠️ 2026-10-09 锚点重打（新语义）：A-1198 把「卸载即写名单」搬进 plugins_apply_changes
       —— 旧 plugins_unload 通道已删，这条变异随之改打新的统一保存路径（缺陷描述不变）。 */
    mutate: (t) => sub(
      t,
      "        if (t?.enabled === true) { unmarkPluginDisabled(PLUGINS_DISABLED_FILE, name); }\n        else { markPluginDisabled(PLUGINS_DISABLED_FILE, name); }",
      "        if (t?.enabled === true) { unmarkPluginDisabled(PLUGINS_DISABLED_FILE, name); }",
    ),
  },
  /* ── ③ 拨片开关动画 ───────────────────────────────────────────── */
  {
    name: "4 开关滑块丢掉位移（拨片动画消失）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "        transform: `translateX(${on ? TRAVEL : 0}px)`,",
      "        transform: \"none\",",
    ),
  },
  /* ── ④ 能力自述 ──────────────────────────────────────────────── */
  {
    name: "5 两处能力自述注入都删（Agent 又不知道自己是什么）",
    file: F_AGENTTOOLS,
    /* 两处注入文本不同 ⇒ 嵌套 sub 一次改掉（核验器认最内层锚）。 */
    mutate: (t) => sub(
      sub(
        t,
        "+ installHint + awareness + creator;",
        "+ installHint + creator;",
      ),
      "].join(\"\\n\") + awareness + creator;",
      "].join(\"\\n\") + creator;",
    ),
  },
  {
    name: "6 默认模式文案改成「可以自建」（瞎承诺）",
    file: F_AGENTTOOLS,
    mutate: (t) => sub(
      t,
      "你当前处于**默认模式**：不能为自己新建插件",
      "你当前处于**默认模式**：可以为自己新建插件（变异测试：瞎承诺）",
    ),
  },
  /* ── ⑤ Loop 自由度（L3）───────────────────────────────────────── */
  {
    name: "7 ToolLoop 忽略 maxRounds（loop_config 写了不生效）",
    file: F_TOOLLOOP,
    /* 同一行文本在 run 与 runStream 各一处 ⇒ 整组替换（all: true）。 */
    all: true,
    mutate: (t) => subAll(
      t,
      "    const maxRounds = resolveMaxRounds(opts.maxRounds);",
      "    const maxRounds = TOOL_MAX_ROUNDS;",
    ),
  },
  {
    name: "8 agentLoopBudget 放行负值（非法配置照单全收）",
    file: F_CHAT,
    mutate: (t) => sub(
      t,
      "    if (!Number.isFinite(n) || n <= 0) { return undefined; }",
      "    if (!Number.isFinite(n)) { return undefined; }",
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
if (reportEolProblems(eolFound, "mut-a1196")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1196-toggle-freedom.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 6) { process.exit(1); }
process.exit(1);
