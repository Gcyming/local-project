#!/usr/bin/env node
/**
 * mut-a1198-plugin-theme.mjs — 主题贡献点（皮肤）与官方示例扩展包的变异验证。
 *
 * ## 这一层在防什么（用户口径：「高自由度 = 外部插件、可开可关，像精装/武装」）
 * 声明 fail-closed（白名单令牌 + 值形态受限）/ 令牌↔CSS 变量同源 / 停用即回落不残留 /
 * host-main-渲染层三层接线 / 示例包真能过清单校验且随包打包。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 色值校验删（任意字符串照收） | 皮肤声明成了任意 CSS 值的入口 | T ①颜色校验 |
 * | 2 | 未知令牌静默忽略 | 白名单形同虚设（配了不生效还不报） | T ①未知令牌 |
 * | 3 | font/radius 枚举放行任意字符串 | 字体/圆角变成任意值通道 | T ①枚举 |
 * | 4 | 空 tokens 放行 | 声明了 theme 却什么都不落（假声明） | T ①空对象 |
 * | 5 | accent 映射错指 --accent-hover | 落了错变量（颜色静默串味） | T ②映射/落值 |
 * | 6 | font 落到 --font-sans（不存在的变量） | 字体令牌静默失效 | T ②映射 |
 * | 7 | radius 少展开 bubble | 圆角皮肤漏一块 | T ②映射 |
 * | 8 | index.css 去掉 var(--font-ui) | 字体令牌无落点（静默失效） | T ②css 同源 |
 * | 9 | resolveActiveTheme 找不到也返回 | 插件没了皮肤还"生效"（幽灵皮肤） | T ③回落 |
 * | 10 | 落值时不清旧变量 | 换肤后两个皮肤的变量叠加（脏组合） | T ③落值 |
 * | 11 | host 不登记 theme | 声明在但永不生效（假接线） | T ④host |
 * | 12 | main 快照 themes 置空 | 外观页永远看不到任何皮肤 | T ④main |
 * | 13 | 安装示例通道改名（通道丢失） | 「安装示例扩展」按钮点了没反应 | T ④main |
 * | 14 | App 不挂 PluginThemeHost | 皮肤数据到了但没人落值 | T ④渲染层 |
 * | 15 | 脏选择清理删 | 停用插件后选择悬空（下次误显示） | T ④渲染层 |
 * | 16 | 外观页「默认」按钮不生效 | 选不回默认（皮肤卸不下来） | T ④外观页 |
 * | 17 | extraFiles 丢 template/plugins | 打包后示例包不存在（播种静默缺位） | T ⑤打包 |
 * | 18 | 示例 plugin.json 的 page.kind 改 webview | 示例包自己过不了清单校验 | T ⑤真解析 |
 * | 19 | boot 少一条 bootstrapPlugins 调用 | 打包/开发二选一漏播种 | T ⑤播种 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-theme.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1198-plugin-theme.spec.ts",
];

const F_CONTRIBUTES = "core-ts/src/plugin/contributes.ts";
const F_HOST = "core-ts/src/plugin/host.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_CSS = "gui/src/renderer/index.css";
const F_STORE = "gui/src/renderer/pluginTheme.ts";
const F_APP = "gui/src/renderer/App.tsx";
const F_THEMEHOST = "gui/src/renderer/components/PluginThemeHost.tsx";
const F_PANEL = "gui/src/renderer/pages/AppearancePanel.tsx";
const F_BUILDER = "gui/electron-builder.json";
const F_BOOT = "gui/src/main/boot.ts";
const F_EXAMPLE = "gui/template/plugins/hello-slime/plugin.json";
const TARGETS = [F_CONTRIBUTES, F_HOST, F_MAIN, F_CSS, F_STORE, F_APP, F_THEMEHOST, F_PANEL, F_BUILDER, F_BOOT, F_EXAMPLE];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1198-theme");

const MUTATIONS = [
  {
    name: "1 色值校验删（任意字符串照收）",
    file: F_CONTRIBUTES,
    mutate: (t) => sub(
      t,
      "      if (typeof value !== \"string\" || !PLUGIN_THEME_HEX_RE.test(value)) {",
      "      if (false) {",
    ),
  },
  {
    name: "2 未知令牌静默忽略（白名单形同虚设）",
    file: F_CONTRIBUTES,
    mutate: (t) => sub(
      t,
      "      if (!THEME_TOKEN_KEYS.includes(key)) {",
      "      if (false) {",
    ),
  },
  {
    name: "3 font/radius 枚举放行任意字符串",
    file: F_CONTRIBUTES,
    mutate: (t) => sub(
      t,
      "        if (typeof value !== \"string\" || !allowed.includes(value)) {",
      "        if (typeof value !== \"string\") {",
    ),
  },
  {
    name: "4 空 tokens 放行（假声明：声明了 theme 却什么都不落）",
    file: F_CONTRIBUTES,
    /* ⚠️ 变异点选择说明（两轮实测教训）：空 tokens 有**两处独立校验**各挡一次
       （keys.length===0 的显式拒 + tokens===undefined 的兜底拒）—— 只短路任一处都是
       **等价变异**（实测两次存活）。⇒ 嵌套 sub 一次改掉两处，才真正造出「假声明能过」。 */
    mutate: (t) => sub(
      sub(
        t,
        "    if (keys.length === 0) {\n      errors.push(\"contributes.theme.tokens 不得为空对象（不声明就别写 theme）\");\n    }\n",
        "",
      ),
      "  if (errors.length > 0 || tokens === undefined) {\n    return { ok: false, errors: errors.length > 0 ? errors : [\"contributes.theme.tokens 解析为空\"] };\n  }",
      "  if (errors.length > 0) {\n    return { ok: false, errors };\n  }\n  if (tokens === undefined) { tokens = {} as PluginThemeTokens; }",
    ),
  },
  {
    name: "5 accent 映射错指 --accent-hover（颜色串味）",
    file: F_CONTRIBUTES,
    mutate: (t) => sub(
      t,
      "  accent: \"--accent\",",
      "  accent: \"--accent-hover\",",
    ),
  },
  {
    name: "6 font 落到不存在的 --font-sans（字体令牌静默失效）",
    file: F_CONTRIBUTES,
    mutate: (t) => sub(
      t,
      "      out.push({ variable: \"--font-ui\", value: PLUGIN_THEME_FONT_STACKS[value as PluginThemeFontToken] });",
      "      out.push({ variable: \"--font-sans\", value: PLUGIN_THEME_FONT_STACKS[value as PluginThemeFontToken] });",
    ),
  },
  {
    name: "7 radius 少展开 bubble（圆角皮肤漏一块）",
    file: F_CONTRIBUTES,
    mutate: (t) => sub(
      t,
      "        { variable: \"--radius-bubble\", value: scale.bubble },\n",
      "",
    ),
  },
  {
    name: "8 index.css 去掉 var(--font-ui)（无落点）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  font-family: var(--font-ui, \"Microsoft YaHei\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif);",
      "  font-family: \"Microsoft YaHei\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;",
    ),
  },
  {
    name: "9 resolveActiveTheme 找不到也返回（幽灵皮肤）",
    file: F_STORE,
    mutate: (t) => sub(
      t,
      "  return themes.find((t) => t.plugin === selected) ?? null;",
      "  return themes.find((t) => t.plugin === selected) ?? ({ plugin: selected } as T);",
    ),
  },
  {
    name: "10 落值时不清旧变量（换肤脏叠加）",
    file: F_STORE,
    mutate: (t) => sub(
      t,
      "  for (const variable of appliedVars) {\n    if (!next.has(variable)) { root.style.removeProperty(variable); }\n  }\n",
      "  /* 变异：不清旧值 */\n",
    ),
  },
  {
    name: "11 host 不登记 theme（假接线）",
    file: F_HOST,
    mutate: (t) => sub(
      t,
      "    if (themeDecl !== undefined) {",
      "    if (false) {",
    ),
  },
  {
    name: "12 main 快照 themes 置空（外观页永远看不到皮肤）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "  const themes: PluginThemeDTO[] = [...pluginThemeDecls.entries()]\n    .map(([plugin, theme]) => ({ plugin, name: theme.name, tokens: theme.tokens }))\n    .sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));",
      "  const themes: PluginThemeDTO[] = [];\n  void pluginThemeDecls;",
    ),
  },
  {
    name: "13 安装示例通道改名（按钮点了没反应）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "  handleTrusted<void>(IPC_CHANNELS.plugins_install_example,",
      "  handleTrusted<void>(\"slime:plugins:installExampleDisabled\",",
    ),
  },
  {
    name: "14 App 不挂 PluginThemeHost（数据到了没人落值）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      <PluginThemeHost />",
      "      {null}",
    ),
  },
  {
    name: "15 脏选择清理删（停用后选择悬空）",
    file: F_THEMEHOST,
    mutate: (t) => sub(
      t,
      "    if (loaded && selected && !active) {",
      "    if (false) {",
    ),
  },
  {
    name: "16 外观页「默认」按钮不生效（皮肤卸不下来）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "              onClick={() => setPluginThemeSelection(\"\")}\n",
      "",
    ),
  },
  {
    name: "17 extraFiles 丢 template/plugins（打包后示例缺位）",
    file: F_BUILDER,
    mutate: (t) => sub(
      t,
      "    {\n      \"from\": \"template/plugins\",\n      \"to\": \"template/plugins\"\n    },\n",
      "",
    ),
  },
  {
    name: "18 示例 page.kind 改 webview（示例自己过不了校验）",
    file: F_EXAMPLE,
    /* ⚠️ 2026-10-09 锚点重打：示例清单加入 contributes.css 时用JSON.stringify 重写过，
       `"page": { "kind": "html", "entry": "panel.html" }` 这一行被展开成多行 ⇒ 旧单行锚点失效。 */
    mutate: (t) => sub(
      t,
      "    \"page\": {\n      \"kind\": \"html\",\n      \"entry\": \"panel.html\"\n    },",
      "    \"page\": {\n      \"kind\": \"webview\",\n      \"entry\": \"panel.html\"\n    },",
    ),
  },
  {
    name: "19 boot 少一条 bootstrapPlugins（二选一漏播种）",
    file: F_BOOT,
    mutate: (t) => sub(
      t,
      "  bootstrapPlugins();\n} else {",
      "} else {",
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
if (reportEolProblems(eolFound, "mut-a1198-theme")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-theme.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length === 0) { process.exit(1); }
process.exit(1);
