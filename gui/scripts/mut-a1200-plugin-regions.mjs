#!/usr/bin/env node
/**
 * mut-a1200-plugin-regions.mjs — **A-1200 · B1（区域注册表 + panel 形态）**的变异验证。
 *
 * ## 这一层在防什么（用户口径原话）
 * 「我要插件可以任意定制的……还有另一类，自己做功能，还配备专门的 UI。
 *   这些都可以出现，为什么我的 slime 不行？」
 * ⇒ 把「4 个固定槽位」升级成「13 个区域」+「panel 形态（扩展自带完整 UI）」。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 区域表删掉 titlebar_end | 该区域声明永远被拒（白名单少一个 = 那个区域写了也白写） | R① 13 个区域 |
 * | 2 | 别名导出去的是副本而非同一数组 | 两份清单各自漂移（改一份另一份不跟） | R① 别名同一身份 |
 * | 3 | 兼容表给 overlay_floating 加 item | item 挂 overlay 永远不显示（假自由度） | R① 兼容表 / R④ |
 * | 4 | 兼容表把 settings_panel 也放 panel | 同一区域两套互斥渲染路径 | R④ settings_panel 只收 item |
 * | 5 | panel 的 entry 不校验 `..` | 拼进 url 后**爬出插件目录**（能读别的插件/用户文件） | R② `..` 反例 |
 * | 6 | panel 的 entry 不校验盘符 | `C:\...` 绝对路径进 url | R② 盘符反例 |
 * | 7 | item 形态写了 entry 也放行 | 「声明了但没人用」的字段静默生效 | R③ item 写 entry 拒 |
 * | 8 | 形态兼容判据按**原始** kindRaw 查 | 不写 kind（缺省 item）时整段跳过 ⇒ overlay 收 item | R④ 缺省形态也要查 |
 * | 9 | 未知区域名静默放行 | 「装载了但看不见」（用户查不出为什么按钮不出现） | R⑤ 未知区域拒 |
 * | 10 | 快照不带 kind | 渲染层按形态分派时走错分支（且错得静默） | R⑦ 快照带 kind |
 * | 11 | panel_open 用**入参 entry** 拼 url | 渲染层可传任意路径 ⇒ 绕过清单校验 | R⑦ panels[0].entry |
 * | 12 | 沙箱 iframe 去掉 sandbox | 隔离破：面板能碰宿主文档 | R⑦ PANEL_SANDBOX |
 * | 13 | panel 取 url 失败改成静默空白 | 用户连「为什么面板不出来」都看不到 | R⑦ 错误文案 |
 * | 14 | overlay 容器不 pointer-events:none | 插件一挂上来整个界面变死区（点不动） | R⑦ 浮层容器三要素 |
 * | 15 | 浮层 z-index 抬到对话框之上 | 插件盖掉权限确认/设置对话框（安全关键 UI） | R⑦ z<1200 |
 * | 16 | App 不挂两个 overlay | 声明了永不生效（假接线） | R⑦ overlay 接线 |
 * | 17 | App 不挂 titlebar 两端 | 同上（区域在注册表里但界面上没有落点） | R⑦ 标题栏接线 |
 * | 18 | 区域映射表少一个键 | 那个区域永远走「尚未接线」分支 | R⑦ 映射表 13 键 |
 * | 19 | ChatPanel 摘掉输入栏两端 | 同上（声明了不接线） | R⑦ 输入栏接线 |
 * | 20 | 摘掉「插入输入框」事件桥 | 标题栏/消息动作按钮变**假按钮**（点了什么也不发生） | R⑦ 事件桥两端 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1200-plugin-regions.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1200-plugin-regions.spec.ts",
  "tests/core-ts/a1198-contributes.spec.ts",
  "tests/core-ts/a1198-ui-slot.spec.ts",
];

const F_CONTRIB = "core-ts/src/plugin/contributes.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_SLOT = "gui/src/renderer/components/UiSlotHost.tsx";
const F_APP = "gui/src/renderer/App.tsx";
const F_CHAT = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_CONTRIB, F_MAIN, F_SLOT, F_APP, F_CHAT];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1200");

const MUTATIONS = [
  {
    name: "1 区域表删掉 titlebar_end（白名单少一个 ⇒ 那个区域写了也白写）",
    file: F_CONTRIB,
    mutate: (t) => sub(t, '  "titlebar_end",\n', ""),
  },
  {
    name: "2 别名导成副本而非同一数组（两份清单各自漂移）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "export const PLUGIN_UI_SLOTS = PLUGIN_UI_REGIONS;",
      "export const PLUGIN_UI_SLOTS = [...PLUGIN_UI_REGIONS] as const;",
    ),
  },
  {
    name: "3 兼容表给 overlay_floating 加 item（item 挂 overlay 永远不显示 ⇒ 假自由度）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  overlay_floating: ["panel"],',
      '  overlay_floating: ["item", "panel"],',
    ),
  },
  {
    name: "4 兼容表把 settings_panel 也放 panel（同一区域两套互斥渲染路径）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  settings_panel: ["item"],',
      '  settings_panel: ["item", "panel"],',
    ),
  },
  {
    /* ⚠️ 这条是本批**最危险**的一条：entry 会拼进 127.0.0.1 服务的 url，
     放行 `..` 等于让面板爬出插件目录（能读别的插件/用户目录的文件）。 */
    name: "5 panel 的 entry 不校验 `..` 段（拼进 url 后爬出插件目录）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  if (v.split(/[\\\\/]+/).includes("..")) { errors.push(`entry 不得含 .. 段（不得爬出插件目录）：${raw}`); }',
      "  /* mutated: 不校验 .. */",
    ),
  },
  {
    name: "6 panel 的 entry 不校验盘符/UNC（绝对路径进 url）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  if (hasDriveOrUncPrefix(v)) { errors.push(`entry 必须是纯相对路径，不接受绝对路径或盘符：${raw}`); return errors; }',
      "  /* mutated: 不校验盘符 */",
    ),
  },
  {
    name: "7 item 形态写了 entry 也放行（「声明了但没人用」的字段静默生效）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "    } else if (entryRaw !== undefined) {\n      errors.push(`${where}.entry 只对 kind=panel 有意义（当前形态 ${kind}）`);\n    }",
      "    }",
    ),
  },
  {
    /* ⚠️ 判据改成按**原始** item.kind 查 ⇒ 「不写 kind + 落在只收 panel 的区域」
       整段跳过 ⇒ overlay 的 item 声明混过清单（而界面上那个区域只渲染 panel）。 */
    name: "8 形态兼容判据按原始 kindRaw 查（缺省 item 时整段跳过 ⇒ overlay 收 item）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "    if (slotOk) {",
      '    if (slotOk && typeof kindRaw === "string" && (PLUGIN_UI_KINDS as readonly string[]).includes(kindRaw)) {',
    ),
  },
  {
    /* ⚠️ **等价变异的实测记录（2026-10-09，A-1200）**：本条最初写成「把slotOk 放宽成
       「只要是字符串」`—— 跑批**存活**了。核实后确认它**真的等价**：未知区域名在兼容表里
       查不到（`?? []` ⇒ 空数组）⇒ 形态兼容判据**照样拒**。
       ⇒ 也就是说「区域白名单」有**两道独立防御**（slotOk + 兼容表查不到就拒）。
       既然放宽白名单动不了不变量，就**换点**：直接删掉「slot 不合法」这条error.push
       （这才是承载该判据的那一行）。教训：等价变异要**换点**，判等价须**实测**+读码核实。 */
    name: "9 未知区域名不报错（删掉 slot 不合法的 error.push ⇒ 装载了但看不见）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "      errors.push(`${where}.slot 缺失或不合法（须为 ${PLUGIN_UI_SLOTS.join(\" / \")}）`);",
      "      /* mutated: 区域名不认识也不报 */",
    ),
  },
  {
    name: "10 快照不带 kind（渲染层按形态分派走错分支，且错得静默）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      '        kind: d.kind ?? "item",\n',
      "",
    ),
  },
  {
    /* ⚠️ 用入参 entry 拼 url ⇒ 渲染层能传任意路径，这条通道就绕过了清单层对
       entry 的纯相对校验（`..`/盘符全绕得过去）。 */
    name: "11 panel_open 用入参 entry 拼 url（渲染层可传任意路径 ⇒ 绕过清单校验）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    const entry = panels[0].entry!.replace(/\\\\/g, \"/\");",
      "    const entry = entryKey.replace(/\\\\/g, \"/\");",
    ),
  },
  {
    name: "12 沙箱 iframe 去掉 sandbox（隔离破：面板能碰宿主文档）",
    file: F_SLOT,
    mutate: (t) => sub(
      t,
      '      sandbox={PANEL_SANDBOX}\n',
      "",
    ),
  },
  {
    name: "13 panel 取url 失败改成静默空白（用户连原因都看不到）",
    file: F_SLOT,
    mutate: (t) => sub(
      t,
      '          setState({ url: "", error: `面板加载失败：${res?.error ? String(res.error) : "主进程未返回 url"}`, loading: false });',
      "          setState({ url: \"\", error: \"\", loading: false });",
    ),
  },
  {
    name: "14 overlay 容器不 pointer-events:none（插件一挂上来整个界面变死区）",
    file: F_SLOT,
    mutate: (t) => sub(
      t,
      "        pointerEvents: \"none\",\n",
      "",
    ),
  },
  {
    name: "15 浮层 z-index 抬到对话框之上（盖掉权限确认等安全关键 UI）",
    file: F_SLOT,
    mutate: (t) => sub(
      t,
      "const PLUGIN_OVERLAY_Z = 1100;",
      "const PLUGIN_OVERLAY_Z = 1500;",
    ),
  },
  {
    name: "16 App 不挂两个 overlay（声明了永不生效 ⇒ 假接线）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      <PluginOverlayFloating />\n      <PluginOverlayFullscreen />",
      "",
    ),
  },
  {
    name: "17 App 不挂 titlebar 两端（区域在注册表里但界面上没有落点）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '        <PluginTitlebarItems region="titlebar_start" />\n        <span style={{ flex: 1 }} />\n        {/* A-1200 · B1：`titlebar_end` 区域（扩展声明的标题栏右端入口）。 */}\n        <PluginTitlebarItems region="titlebar_end" />',
      '        <span style={{ flex: 1 }} />',
    ),
  },
  {
    name: "18 区域映射表少一个键（那个区域永远走「尚未接线」分支）",
    file: F_SLOT,
    mutate: (t) => sub(
      t,
      '  status_bar: "PluginStatusBarItems（底部状态条；A-1200 · B1）",\n',
      "",
    ),
  },
  {
    name: "19 ChatPanel 摘掉输入栏两端（声明了不接线）",
    file: F_CHAT,
    mutate: (t) => sub(
      t,
      "            <PluginChatInputLeading onInsert={(t) => setInput((v) => (v ? `${v} ${t}` : t))} />\n",
      "",
    ),
  },
  {
    name: "20 摘掉「插入输入框」事件桥（标题栏/消息动作按钮变假按钮）",
    file: F_CHAT,
    mutate: (t) => sub(
      t,
      "    window.addEventListener(PLUGIN_INSERT_INPUT_EVENT, onInsert);",
      "    void onInsert;",
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
if (reportEolProblems(eolFound, "mut-a1200-regions")) { process.exit(1); }

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

console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1200-plugin-regions.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length === 0) { process.exit(1); }
process.exit(1);