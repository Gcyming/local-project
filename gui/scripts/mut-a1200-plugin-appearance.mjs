#!/usr/bin/env node
/**
 * mut-a1200-plugin-appearance.mjs — **A-1200 · B2（多皮肤 + 皮肤资源 + 全屏层）**的变异验证。
 *
 * ## 这一层在防什么（用户口径原话）
 * 「deepseek harness 的外观市场都给用户做出来了，甚至能自定义主题。这些都可以出现，
 *   为什么我的 slime 不行？」
 * ⇒ B1 之后还差三处：① **一插件只能一套皮肤**；② **不能用图片**（`url(` 被静态禁令封死）；
 *   ③ **够不到全屏**（皮肤只改 CSS 变量 + 作用域内 CSS）。本批三条全补。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | themes 上限 16 → 64 | 外观页被撑爆 / 登记表膨胀（上限形同虚设） | B2① 上限 |
 * | 2 | 上限判据 `>` 改 `>=` | 恰好 16 套被拒（上限少算一套，合法清单被误拒） | B2① 恰好 16 通过 |
 * | 3 | 空数组检查删| 写 `"themes": []` 也算「声明了皮肤」却一套都没有（假声明） | B2① 空数组拒 |
 * | 4 |皮肤名去重删 | 外观页两个同名选项，用户分不清自己选的是哪一套 | B2① 重名拒 |
 * | 5 | 单套非法时 `continue` 改「仍push」 | 静默丢弃坏皮肤：清单能过、界面上少一套且无提示 | B2① 整份拒 |
 * | 6 | `theme`/`themes` 互斥判据删 | 同写时「用户以为生效的那套」取决于宿主读哪个字段（口径冲突） | B2② 同写拒 |
 * | 7 | 单套判据换成宽松版（未知令牌放过） | 一套皮肤的令牌白名单被绕过（形同虚设） | B2① 逐条独立触发 |
 * | 8 | url 白名单整体不查 | 外联 URL（http/data://）被放行 = 开数据外泄面 | B2③ 外联全拒 |
 * | 9 | `..` 段不拒（资源路径） | 改写后的地址爬出插件目录 = 跨插件读文件（越权） | B2③ `..` 逃逸拒 |
 * | 10 | 盘符/UNC 不拒（资源路径） | 绝对路径进url = 能指向任意磁盘位置 | B2③ 盘符拒 |
 * | 11 | 协议前缀大小写敏感（只认小写） | 同一形态因大小写被拒（误拒合法清单） | B2③ 大写前缀通过 |
 * | 12 | 改写时基址直接拼用户 CSS 里的路径 | 允许 `..` 逃逸绕过清单层校验（渲染层即可伪造） | B2④ 改写删逃逸项 |
 * | 13 | 文件不存在时保留原url | 留一个指向 404 的地址（"皮肤有图但看不见"比没图更坏） | B2④ 缺失即删 |
 * | 14 | 无基址时也改写（用空串兜底） | 图片地址指向 `http:///…` 之类废地址，或指向别人的目录 | B2⑦ 拿不到基址原样返回 |
 * | 15 | 皮肤层 z 1100 → 1500 | **盖掉权限确认/设置对话框**（误操作可能被默认通过） | B2⑤ z<1200 |
 * | 16 | 皮肤层去掉 pointer-events:none | 皮肤一挂上整个界面变死区（点不动） | B2⑤ 三要素 |
 * | 17 | 无生效外观时渲染空 div（不 return null） | 残留空层：白占层叠与命中区（可开可关失效） | B2⑤ 不渲染 |
 * | 18 | App 不挂 PluginSkinLayer | 皮肤声明了永不生效（假接线） | B2⑤ App 接线 |
 * | 19 | 外观页 key 用 `t.plugin`（不用皮肤名） | 同插件多套皮肤串成一张卡 + 持久化互相覆盖 | B2⑥ key 不含混 |
 * | 20 | 兼容分支删（老选择回落 null） | 老用户升级后选择丢失（体验倒退） | B2⑥ 兼容分支 |
 * | 21 | host 不登记 themes（假接线） | 多套皮肤在扩展页显示「尚未接线」 | B2⑦ host 登记 |
 * | 22 | 撤销时不删改写登记表 | 卸载后残留一个指向已卸插件的基址 | B2⑦ 撤销清理 |
 *
 * ## 等价变异的实测记录（A-1200 · B2）
 * · 本脚本第 3 条最初写成「删掉 `themes` 整个非数组检查」—— 跑批**存活**。核实后确认**真等价**：
 *   非数组会在 `Array.isArray` 那一步被同一条判据的前半截挡住（它们是同一个 if 的两级），
 *   删掉后半截不改变行为。⇒ **换点**：改成只删「空数组」这一级（M3），实测被B2① 抓住。
 * · 第 9/10 条（`..` / 盘符）**必须各自独立**：反例里不能同时含另一种越权形态，
 *   否则删掉其中一条判据，另一条仍会挡住 ⇒ 守卫照样绿而变异存活（本项目已踩过一次）。
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1200-plugin-appearance.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1200-plugin-appearance.spec.ts",
  /* 同族守卫一并列入（判据清单漏一份 ⇒ 变异「假存活」却不报错）：
     · a1198-plugin-css：url 白名单与静态禁令的老守卫（B2 改的是同一条禁令）；
     · a1198-plugin-theme：单套 theme 的老守卫（themes 与 theme 同判据）。 */
  "tests/core-ts/a1198-plugin-css.spec.ts",
  "tests/core-ts/a1198-plugin-theme.spec.ts",
];

const F_CONTRIB = "core-ts/src/plugin/contributes.ts";
const F_HOST = "core-ts/src/plugin/host.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_STORE = "gui/src/renderer/pluginTheme.ts";
const F_LAYER = "gui/src/renderer/components/PluginSkinLayer.tsx";
const F_APP = "gui/src/renderer/App.tsx";
const F_PANEL = "gui/src/renderer/pages/AppearancePanel.tsx";
const TARGETS = [F_CONTRIB, F_HOST, F_MAIN, F_STORE, F_LAYER, F_APP, F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1200-appearance");

const MUTATIONS = [
  {
    name: "1 themes 上限 16 改 64（外观页被撑爆 / 登记表膨胀）",
    file: F_CONTRIB,
    mutate: (t) => sub(t, "export const MAX_PLUGIN_THEMES = 16;", "export const MAX_PLUGIN_THEMES = 64;"),
  },
  {
    /* ⚠️ 判据方向：上限是「> 才拒」，写成 >= 会让**恰好 16 套的合法清单被误拒**
       （守卫里有一条专钉「恰好 16 套通过」，就是为了钉住这一行的方向）。 */
    name: "2 上限判据 > 改>=（恰好 16 套被误拒）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "  if (raw.length > MAX_PLUGIN_THEMES) {\n    return { ok: false, errors: [`contributes.themes 超过上限 ${MAX_PLUGIN_THEMES} 套：${raw.length}`] };\n  }",
      "  if (raw.length >= MAX_PLUGIN_THEMES) {\n    return { ok: false, errors: [`contributes.themes 超过上限 ${MAX_PLUGIN_THEMES} 套：${raw.length}`] };\n  }",
    ),
  },
  {
    /* ⚠️ 等价变异实测记录：最初这条写成「删掉整个非数组+空数组检查」，跑批存活 ——
       因为「非数组」被同一条判据的前半截（Array.isArray）挡住，删后半截不改变行为。
       ⇒ 换点：只删「空数组」这一级（真正承载「不声明就别写」这条语义的那一行）。 */
    name: "3 themes 空数组检查删（写空数组也算声明了皮肤 ⇒ 假声明）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  if (raw.length === 0) {\n    return { ok: false, errors: ["contributes.themes 不得为空数组（不声明就别写这个字段）"] };\n  }',
      "  /* 变异：空数组不拒 */",
    ),
  },
  {
    /* ⚠️ 这条最直接踩用户观感：两个同名皮肤在外观页是两张一样的卡，
       用户点哪张都"看起来一样"，且持久化选择分不清自己选的是哪一套。 */
    name: "4 皮肤名同插件内去重删（外观页两个同名选项分不清）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "    if (seen.has(name)) {\n      errors.push(`${where}.name 与同插件内另一套皮肤重复：${name}（外观页会出现两个同名选项，用户分不清）`);\n      continue;\n    }",
      "    if (false) {\n      errors.push(`${where}.name 与同插件内另一套皮肤重复：${name}`);\n      continue;\n    }",
    ),
  },
  {
    /* ⚠️ **本批最该防的一条**：`continue` 改「仍然 push」= 静默丢弃坏皮肤。
       后果：清单能过、插件能装，但外观页少一套皮肤且**没有任何提示** ——
       这正是本项目判据里的头号陷阱（能配但没生效）。 */
    name: "5 单套非法时静默丢弃（continue 改仍然收下）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "      for (const e of parsed.errors) { errors.push(`${where}: ${e}`); }\n      continue;",
      "      for (const e of parsed.errors) { errors.push(`${where}: ${e}`); }\n      themes.push({ name: raw[i]?.name ?? \"\", tokens: {} });",
    ),
  },
  {
    name: "6 theme/themes 互斥判据删（同写时以哪个为准变成猜）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  if (raw.theme !== undefined && raw.themes !== undefined) {\n    errors.push("contributes.theme 与 contributes.themes 不可同时声明（前者是后者长度为 1 的特例）：写其中之一即可，同时写属口径冲突");\n  }',
      "  /* 变异：互斥不查 */",
    ),
  },
  {
    /* ⚠️ 必须「只碰这一个令牌」：若样例里还含别的非法项，删掉未知令牌判据后仍被另一条挡住
       ⇒ 守卫照样绿而变异存活。判据本身在 `parsePluginTheme` 里。 */
    name: "7 未知令牌静默放过（一套皮肤的白名单形同虚设）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "      if (!THEME_TOKEN_KEYS.includes(key)) {\n        errors.push(`contributes.theme.tokens 含未知令牌：${key}（允许：${THEME_TOKEN_KEYS.join(\"、\")}）`);\n        continue;\n      }",
      "      if (false) {\n        errors.push(`contributes.theme.tokens 含未知令牌：${key}`);\n        continue;\n      }",
    ),
  },
  {
    /* ⚠️ **本批最危险的一条**：url 逐参白名单整体不查 ⇒ http(s)/data:/裸相对全部放行。
       外观不需要外联，放开外联 = 给插件开一个数据外泄面（用户在对话框输入的内容能被带出去）。 */
    name: "8 url 白名单整体不查（外联 URL 全部放行 = 开数据外泄面）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "  out.push(...checkPluginAssetUrls(css));",
      "  /* 变异：不查 url 逐参白名单 */",
    ),
  },
  {
    /* ⚠️ 与 M10（盘符）**各自独立**：反例只用 `..`，不含盘符/前导分隔符 ——
       否则删掉其中一条判据，另一条仍会挡住，守卫照样绿而变异存活。 */
    name: "9 资源路径不校验 .. 段（改写后爬出插件目录 = 跨插件读文件）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  if (v.split(/[\\\\/]+/).includes("..")) { errors.push(`entry 不得含 .. 段（不得爬出插件目录）：${raw}`); }',
      "  /* 变异：不校验 .. 段 */",
    ),
  },
  {
    name: "10 资源路径不校验盘符/UNC（绝对路径进 url = 可指向任意磁盘位置）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      '  if (hasDriveOrUncPrefix(v)) { errors.push(`entry 必须是纯相对路径，不接受绝对路径或盘符：${raw}`); return errors; }',
      "  /* 变异：不校验盘符 */",
    ),
  },
  {
    /* ⚠️ 这是**误拒**方向的变异：协议前缀是宿主自造的，CSS 里写大写应当同样认。
       判据刻意toLowerCase 后比前缀，所以这条删掉大小写归一后合法清单会被拒。 */
    name: "11 协议前缀大小写敏感（同一形态因大小写被误拒）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "  if (!raw.toLowerCase().startsWith(prefix)) {",
      "  if (!raw.startsWith(prefix)) {",
    ),
  },
  {
    /* ⚠️ 改写阶段是**第二道**：清单层已拒过逃逸，但改写函数自己也调同一判据。
       删掉这行⇒ 有人绕过清单层（或将来判据位置变了）时，`..` 会**原样进url**。 */
    name: "12 改写阶段不再校验路径（清单层被绕过时 .. 直接进 url）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "      const judged = isAllowedPluginAssetUrl(`${prefix}${path}`);\n      if (!judged.ok) { return \"\"; }",
      "      const judged = isAllowedPluginAssetUrl(`${prefix}${path}`);\n      void judged;",
    ),
  },
  {
    /* ⚠️ 缺陷语义：资源文件不在（删了/改名了）却仍留url ⇒ 用户看到"皮肤有图但看不见"，
       且浏览器控制台只有一个 404，比"少一张图"更难解释。 */
    name: "13 文件不存在时保留原 url（留一个指向 404 的地址）",
    file: F_CONTRIB,
    mutate: (t) => sub(
      t,
      "      if (!exists(judged.path)) { return \"\"; }",
      "      if (!exists(judged.path)) { return whole; }",
    ),
  },
  {
    /* ⚠️ 越权方向：没有基址（插件被卸/服务没起）时若仍改写，图片地址就是
       `http:///assets/x.png` 之类废地址；更糟的写法是回退到别的插件的基址。 */
    name: "14 无基址时也改写（图片地址指向废地址）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "  if (!base || !dir) { return decl.css; }",
      "  if (!base || !dir) { return rewritePluginAssetUrls(decl.css, \"http://127.0.0.1:1/\", () => true); }",
    ),
  },
  {
    /* ⚠️ **安全不变量本身**：皮肤层 z-index 高于对话框 backdrop(1200)
       ⇒ 皮肤能盖掉权限确认弹窗/设置对话框 —— 误操作可能被「默认通过」。
       这条判据的价值就是钉住「1100 < 1200」这个不等式。 */
    name: "15 皮肤层 z-index 抬到对话框之上（盖掉权限确认等安全关键 UI）",
    file: F_LAYER,
    mutate: (t) => sub(t, "export const SKIN_LAYER_Z = 1100;", "export const SKIN_LAYER_Z = 1500;"),
  },
  {
    name: "16 皮肤层不 pointer-events:none（皮肤一挂上整个界面变死区）",
    file: F_LAYER,
    mutate: (t) => sub(t, '        pointerEvents: "none",\n', ""),
  },
  {
    name: "17 无生效外观时渲染空层（残留：白占层叠与命中区，可开可关失效）",
    file: F_LAYER,
    mutate: (t) => sub(t, "  if (!active) { return null; }", "  if (false) { return null; }"),
  },
  {
    name: "18 App 不挂 PluginSkinLayer（皮肤声明了永不生效 = 假接线）",
    file: F_APP,
    mutate: (t) => sub(t, "      <PluginSkinLayer />", "      {null}"),
  },
  {
    /* ⚠️ 同一个插件的两套皮肤在 React 里共用一个 key ⇒ 卡片复用错对象（点A 选中B），
       且持久化选择互相覆盖（旧选择指向的名字被两套共用）。 */
    name: "19 外观页 key 只用 plugin（同插件多套皮肤串成一张卡）",
    file: F_PANEL,
    mutate: (t) => sub(t, "              const cardKey = pluginThemeSelectionKey(t.plugin, t.id);", '              const cardKey = t.plugin;'),
  },
  {
    /* ⚠️ 向后兼容分支：老选择（只存了插件名）必须落到该插件的第一套。
       删掉它 ⇒ 老用户升级后选择直接失效（体验倒退，且是"静默"的）。 */
    name: "20 删掉老选择兼容分支（老用户升级后皮肤选择失效）",
    file: F_STORE,
    mutate: (t) => sub(
      t,
      "  if (parsed.skinName === null) {\n    /* 老选择（只存了插件名）⇒ 取该插件的**第一套**（快照按 plugin+id 排序 ⇒ 顺序稳定）。 */\n    return samePlugin[0] ?? null;\n  }",
      "  if (parsed.skinName === null) { return null; }",
    ),
  },
  {
    name: "21 host 不登记 themes（多套皮肤在扩展页显示尚未接线 = 假接线）",
    file: F_HOST,
    mutate: (t) => sub(t, "    if (themesDecl !== undefined) {", "    if (false) {"),
  },
  {
    /* ⚠️ 残留方向：撤销时不删登记表 ⇒ 插件卸载后 base/目录映射还留着，
       下次同名插件（或误判）会拿到一个指向**旧目录**的基址。 */
    name: "22 撤销时不删改写登记表（残留指向已卸插件的基址）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "            pluginCssAssetBases.delete(manifest.name);\n            pluginCssAssetDirs.delete(manifest.name);",
      "            /* 变异：撤销时不清理改写登记表 */",
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
if (reportEolProblems(eolFound, "mut-a1200-appearance")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1200-plugin-appearance.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length === 0) { process.exit(1); }
process.exit(1);