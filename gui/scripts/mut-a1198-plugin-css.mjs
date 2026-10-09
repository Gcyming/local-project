#!/usr/bin/env node
/**
 * mut-a1198-plugin-css.mjs — CSS 贡献点（`contributes.css`）的变异验证。
 *
 * ## 这一层在防什么（用户口径原话）
 * 「还是把CSS 修改权限全面放开吧，倒也不是说修改，我说了是插件。
 *   通过插件来进行开关可控的改动」
 *
 * 三条护栏各有真实失效场景，逐条都要有"真的被拒"的反例：
 *   ① 静态禁令：外联（@import/url）＝把用户数据发出去；!important / 全局选择器 / position:fixed
 *      ＝绕过层叠或直接遮蔽安全关键 UI；
 *   ②@layer：权限请求弹窗（git 门禁 / diff 评审 / 脚本执行确认）走 JSX + 宿主样式表 ——
 *      插件若能盖掉它，display:none 就能把「允许/拒绝」藏起来 ⇒ 误操作默认通过（功能性失效）；
 *   ③作用域 + 可开可关：选择器必须真被收进 .slime-plugin-scope；停用/卸载必须整段撤下不残留。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | @import 禁令删 | 插件能外联远程样式（数据外流 / 远程代码） | CSS①外联类 |
 * | 2 | url() 禁令删 | 背景图外联（跟踪用户 / 拉远程内容） | CSS①外联类 |
 * | 3 | @font-face 禁令删 | 自定义字体文件 = 外部资源加载 | CSS①外联类 |
 * | 4 | !important 禁令删 | 绕过 @layer 层叠的旁门（能盖宿主规则） | CSS①覆盖类 |
 * | 5 | position:fixed 禁令删 | 不依赖层叠就能遮蔽安全关键 UI | CSS①覆盖类 |
 * | 6 | 全局选择器禁令删 | `*`/`html`/`body` 接管全站 + 藏掉宿主安全提示 | CSS①覆盖类 |
 * | 7 | @media 禁令删 | 嵌套块选择器逃出作用域改写（作用域失效） | CSS①AT 规则 |
 * | 8 | 空 css 放行 | 声明了 css 却什么都不落（假声明） | CSS①基本校验 |
 * | 9 | 超长 name 放行 | 超长名进渲染层（撑爆面板） | CSS①基本校验 |
 * | 10 | 未知字段放行 | 拼错字段名静默失效 | CSS①未知字段 |
 * | 11 | 逗号选择器只加首个前缀 | 第二个选择器逃出作用域 | CSS②作用域 |
 * | 12 | 作用域类不挂 | 插件 CSS 靠父层继承生效，作用域约定形同虚设 | CSS③落值 |
 * | 13 | 不写 @layer 包裹 | 插件样式进宿主层 ⇒ 能盖掉权限弹窗 | CSS③落值 |
 * | 14 | 层顺序写反（插件在前） | 层顺序由首次声明决定 ⇒ 插件层反超宿主层 | CSS②层顺序 |
 * | 15 | 撤下时不摘作用域类 | 卸载后残留作用域类（下次别的插件 CSS 行为漂移） | CSS③不残留 |
 * | 16 | 换套不覆盖（叠加） | 同时生效两套 CSS（互相打补丁，用户无法判断） | CSS③不叠加 |
 * | 17 | host 不包 @layer slime-host | 层叠前提不存在（插件层可能反超） | CSS②宿主包裹 |
 * | 18 | App 不挂 PluginCssHost | 声明了永不生效（假接线） | CSS④接线 |
 * | 19 | host 不走 contribute | 撤销句柄不入 scope ⇒ 停用后样式残留 | CSS④接线 |
 * | 20 | 撤销不按插件名移除 | 重装时误删新登记（闪现失效） | CSS④接线 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-css.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1198-plugin-css.spec.ts",
];

const F_CONTRIB = "core-ts/src/plugin/contributes.ts";
const F_HOST = "core-ts/src/plugin/host.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_CSS = "gui/src/renderer/index.css";
const F_APPCSS = "gui/src/renderer/pluginCss.ts";
const F_APP = "gui/src/renderer/App.tsx";
const TARGETS = [F_CONTRIB, F_HOST, F_MAIN, F_CSS, F_APPCSS, F_APP];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1198-css");

const MUTATIONS = [
  {
    name: "1 @import 禁令删（插件能外联远程样式）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  { re: /@import/i, why: "@import（外联/引入远程样式）" },',
      "",
    ),
  },
  {
    name: "2 url() 禁令删（背景图外联）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  { re: /url\\s*\\(/i, why: "url()（外联资源：外观不需要外联）" },',
      "",
    ),
  },
  {
    name: "3 @font-face 禁令删（外部字体资源）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  { re: /@font-face/i, why: "@font-face（自定义字体文件 = 外部资源加载；字体族走 contributes.theme 的枚举令牌）" },',
      "",
    ),
  },
  {
    name: "4 !important 禁令删（绕过层叠的旁门）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  { re: /!\\s*important/i, why: "!important（绕过层叠的旁门）" },',
      "",
    ),
  },
  {
    name: "5 position:fixed 禁令删（可遮蔽安全关键 UI）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  { re: /position\\s*:\\s*fixed/i, why: "position:fixed（能盖住安全关键 UI，不依赖层叠就能遮蔽）" },',
      "",
    ),
  },
  {
    name: "6 全局选择器禁令删（接管全站）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  { re: /(?:^|[^.\\w-])(?:\\*|html|body|:root)\\s*(?=[,{.#:\\[])/im, why: "全局选择器（* / html / body / :root —— 能接管全站并藏掉宿主安全提示）" },',
      "",
    ),
  },
  {
    name: "7 @media 禁令删（嵌套块逃出作用域）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  { re: /@media/i, why: "@media（媒体查询块的选择器同样会被作用域改写，改写规则尚未覆盖嵌套块）" },',
      "",
    ),
  },
  {
    name: "8 空 css 放行（假声明）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  if (!css.trim()) {\n    errors.push("contributes.css.css 缺失或为空（不声明就别写 css）");\n  } else if (Buffer.byteLength(css, "utf8") > MAX_PLUGIN_CSS_BYTES) {',
      '  if (false) {\n    errors.push("contributes.css.css 缺失或为空（不声明就别写 css）");\n  } else if (Buffer.byteLength(css, "utf8") > MAX_PLUGIN_CSS_BYTES) {',
    ),
  },
  {
    name: "9 超长 name 放行（撑爆渲染层）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  } else if (name.length > MAX_PLUGIN_CSS_NAME) {\n    errors.push(`contributes.css.name 过长（${name.length} > ${MAX_PLUGIN_CSS_NAME}）`);\n  }',
      "  }",
    ),
  },
  {
    name: "10 未知字段放行（拼错静默失效）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '    if (!ALLOWED_CSS_FIELDS.includes(field)) {\n      errors.push(`contributes.css 含未知字段：${field}（允许的字段：${ALLOWED_CSS_FIELDS.join("、")}）`);\n    }',
      "    void field;",
    ),
  },
  {
    name: "11 逗号选择器只给首个加前缀（第二个逃出作用域）",
    file: F_CONTRIB,
    /* ⚠️ 变异点选择教训（首轮写成noop 存活）：把 map 回调改成 `(one, _i)` 不改变任何行为。
       真实的漏法是「只处理第一段逗号」—— 于是 `.a, .b { }` 里的 `.b` 逃出作用域，
       插件能改到作用域外的东西（作用域约定 = 防外泄的唯一机制）。 */
    mutate: (t) => sub(
      t,
      "    const scoped = selector\n      .split(\",\")\n      .map((one) => {",
      "    const scoped = selector\n      .split(\",\")\n      .slice(0, 1)\n      .map((one) => {",
    ),
  },
  {
    name: "12 作用域类不挂（作用域约定形同虚设）",
    file: F_APPCSS,
    mutate: (t) => sub(
      t,
      '  doc.documentElement.classList.add(PLUGIN_CSS_SCOPE_CLASS);\n  return true;',
      "  return true;",
    ),
  },
  {
    name: "13 不写 @layer 包裹（插件样式进宿主层）",
    file: F_APPCSS,
    mutate: (t) => sub(
      t,
      '  const text = `${PLUGIN_CSS_LAYER_ORDER}\\n@layer slime-plugin {\\n${scopePluginCss(decl.css)}\\n}\\n`;',
      "  const text = scopePluginCss(decl.css);",
    ),
  },
  {
    name: "14 层顺序写反（插件层反超宿主层）",
    file: F_APPCSS,
    mutate: (t) => sub(
      t,
      'export const PLUGIN_CSS_LAYER_ORDER = "@layer slime-host, slime-plugin;";',
      'export const PLUGIN_CSS_LAYER_ORDER = "@layer slime-plugin, slime-host;";',
    ),
  },
  {
    name: "15 撤下时不摘作用域类（残留）",
    file: F_APPCSS,
    mutate: (t) => sub(
      t,
      "    doc.documentElement.classList.remove(PLUGIN_CSS_SCOPE_CLASS);",
      "    /* mutated: 不摘 */",
    ),
  },
  {
    name: "16 换套不覆盖（两套 CSS 叠加）",
    file: F_APPCSS,
    mutate: (t) => sub(
      t,
      "  if (style) {\n    style.textContent = text;\n  } else {",
      "  if (false) {\n    style.textContent = text;\n  } else {",
    ),
  },
  {
    name: "17 host 不包 @layer slime-host（层叠前提不存在）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "@layer slime-host {",
      "/* mutated: 没有层 */",
    ),
  },
  {
    name: "18 App 不挂 PluginCssHost（假接线）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      <PluginCssHost />",
      "",
    ),
  },
  {
    name: "19 host 不走 contribute（撤销句柄不入 scope）",
    file: F_HOST,
    mutate: (t) => sub(
      t,
      "      const wiring = this.contribute(scope, this.registerCss, manifest);",
      "      const wiring = this.registerCss?.(manifest) ? \"wired\" : WIRING_PENDING;",
    ),
  },
  {
    name: "20 撤销不按插件名移除（重装时误删新登记）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "            if (pluginCssDecls.get(manifest.name) === decl) {\n              pluginCssDecls.delete(manifest.name);\n            }",
      "            pluginCssDecls.delete(manifest.name);",
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
if (reportEolProblems(eolFound, "mut-a1198-css")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-css.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length === 0) { process.exit(1); }
process.exit(1);