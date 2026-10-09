/**
 * tests/core-ts/a1200-plugin-appearance.spec.ts — **A-1200 · B2（多皮肤 + 皮肤资源 + 全屏层）**的守卫。
 *
 * ## 用户口径（本批要解的主诉，原话）
 * 「deepseek harness 的外观市场都给用户做出来了，甚至能自定义主题。这些都可以出现，为什么我的 slime 不行？」
 * 对标事实（已调研，不重复查）：`dsh-theme-gallery` **一个插件带 12 套皮肤**（含全屏覆盖 + 壁纸）、
 * `dsh-theme-customizer` 支持**若干区域背景**（含图片）。
 * ⇒ slime 的三处差距：**一插件只能一套皮肤** / **不能用图片**（`url(` 被静态禁令封死）/
 *   **够不到全屏**（皮肤只改 CSS 变量 + 作用域内 CSS）。本批三条全补。
 *
 * ## 这一层在防什么（五条不变量，逐条都有真实失效场景）
 *   ① **多皮肤的形状与上限**：`themes` 数组 ≤16、非空、**皮肤名不得重复**（重复 ⇒ 外观页两个同名
 *     选项分不清）、**任意一套非法 ⇒ 整份拒**（fail-closed，绝不静默丢弃那一套）。
 *   ② **`theme` / `themes` 互斥**：同写即拒（口径冲突不猜），且**只写 `theme` 的老清单照常通过**
 *     —— 向后兼容不是"大概能跑"，是走 `parsePluginManifest` 真校验的。
 *   ③ **`url()` 白名单精确到一种形态**：`plugin-asset:<纯相对>` 通过；`http(s)://` / `//` /
 *     `data:` / 裸相对 / `..` 逃逸 / 盘符 / UNC **全拒**。放开外联 = 开数据外泄面。
 *   ④ **协议改写是纯函数且宿主侧**：改写只对**该插件自己的目录**生效；文件不存在 ⇒ 如实删掉
 *     整个 `url()`（不留一个 404 的地址）。
 *   ⑤ **全屏层的 z-index 低于模态 backdrop**：钉死"能全屏改外观，但盖不掉权限确认弹窗"这条
 *     不变量 —— 一旦有人把z 抬到 1200 以上，误操作就可能被"默认通过"。
 *
 * ## 为什么还有第⑥类（源码形状锁 + 纯函数行为）
 * 渲染层没有组件测试环境（项目惯例：形状断言 + 变异）。声明校验全绿但**界面没接线**、
 * 用户看到的仍然是"说了不算"。z-index 取值、宿主侧改写、示例包真过校验都在这一类。
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_PLUGIN_THEMES,
  PLUGIN_ASSET_SCHEME,
  checkPluginAssetUrls,
  describePluginThemes,
  extractPluginCssUrls,
  findPluginCssViolations,
  isAllowedPluginAssetUrl,
  parsePluginContributes,
  parsePluginCss,
  parsePluginThemes,
  rewritePluginAssetUrls,
  type PluginThemeDecl,
} from "../../core-ts/src/plugin/contributes.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  PLUGIN_THEME_KEY_SEP,
  __resetPluginThemeForTest,
  parsePluginThemeSelection,
  pluginThemeSelectionKey,
  resolveActiveTheme,
} from "../../gui/src/renderer/pluginTheme.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const EXAMPLE_DIR = "gui/template/plugins/hello-slime";
const skin = (name: string, tokens: Record<string, string> = { accent: "#2dd4bf" }): unknown =>
  ({ name, tokens });

/* ── ① `themes` 数组：上限 / 非空 / 去重 / fail-closed ────────────────────── */

describe("A-1200-B2 ① 多皮肤 `themes`：上限、形状、去重、整份拒", () => {
  it("上限常量是 16，且恰好 16 套通过、17 套拒", () => {
    expect(MAX_PLUGIN_THEMES).toBe(16);
    const build = (n: number): unknown[] => Array.from({ length: n }, (_, i) => skin(`S${i}`));
    expect(parsePluginThemes(build(16)).ok, "16 套（上限）应通过").toBe(true);
    const over = parsePluginThemes(build(17));
    expect(over.ok, "17 套（超上限）应拒").toBe(false);
    if (!over.ok) { expect(over.errors.join("；")).toContain("上限"); }
  });

  it("非数组 / 空数组 / 非对象元素 ⇒拒（不声明就别写这个字段）", () => {
    for (const bad of [{ name: "a", tokens: { accent: "#ffffff" } }, 42, null, undefined]) {
      const r = parsePluginThemes(bad);
      expect(r.ok, `非数组应拒：${JSON.stringify(bad)}`).toBe(false);
      if (!r.ok) { expect(r.errors.join("；")).toContain("数组"); }
    }
    const empty = parsePluginThemes([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) { expect(empty.errors.join("；")).toContain("空数组"); }
  });

  it("⚠️ 单套非法 ⇒ **整份拒**（fail-closed：不静默丢弃那一套 —— 否则用户看到 2 套而不是 3 套且毫无提示）", () => {
    const r = parsePluginThemes([
      skin("好的一套"),
      skin("坏的一套", { accent: "red" }),          // 非法色值
      skin("也是好的"),
    ]);
    expect(r.ok, "一套非法必须整份拒").toBe(false);
    /* ⚠️ 反向断言：不能出现「ok 且只剩 2 套」这种静默丢弃的结果。 */
    if (!r.ok) {
      expect(r.errors.join("；")).toContain("十六进制");
      /* 错误前缀必须指向**数组下标**（否则报错说contributes.theme，清单里根本没那个字段）。 */
      expect(r.errors.join("；")).toContain("contributes.themes[1]");
    }
  });

  it("同插件内皮肤名重复 ⇒ 拒（外观页会出两个同名选项，用户分不清自己选的是哪一套）", () => {
    const r = parsePluginThemes([skin("暮色青"), skin("雪夜"), skin("暮色青")]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("重复"); }
    /* ⚠️ 去重判据按**trim 后的字面**（`parsePluginTheme` 已trim name）：`"暮色青 "` 与 `"暮色青"`
       归一后是同一个名字 ⇒ 必须拒。不做大小写/全半角归一（那会引入"看起来一样算一样"的模糊口径）。 */
    const spaced = parsePluginThemes([skin("暮色青"), skin("暮色青 ")]);
    expect(spaced.ok, "仅尾部空格不同视为同名（外观页显示的是同一个名字）").toBe(false);
  });

  it("每套皮肤的判据**复用单套**（不另写一套）：未知令牌 / 枚举越界 / 超长名 逐条独立触发", () => {
    /* 每条反例只带**自己那一个**毛病 —— 若样例里还含别的毛病，删掉其中一条校验后它仍被另一条挡住
       ⇒ 守卫照样绿而变异存活（等价变异）。 */
    const cases: Array<[unknown, string]> = [
      [skin("x", { shadow: "#000000" }), "未知令牌"],
      [skin("x", { font: "comic" }), "枚举值"],
      [skin("x", { radius: "huge" }), "枚举值"],
      [skin("长".repeat(25)), "过长"],
      [{ name: "x", tokens: {} }, "空对象"],
      [{ name: "x", tokens: { accent: "#ffffff" }, extra: 1 }, "未知字段"],
    ];
    for (const [raw, which] of cases) {
      const r = parsePluginThemes([raw]);
      expect(r.ok, `${JSON.stringify(raw)} 应被拒`).toBe(false);
      if (!r.ok) { expect(r.errors.join("；"), `${JSON.stringify(raw)}`).toContain(which); }
    }
  });

  it("摘要：describePluginThemes 给「名（N 令牌）/名（N 令牌)」；空给 0", () => {
    expect(describePluginThemes(undefined)).toBe("0");
    expect(describePluginThemes([])).toBe("0");
    expect(describePluginThemes([{ name: "青", tokens: { accent: "#2dd4bf", font: "mono" } }]))
      .toBe("青（2 令牌）");
    expect(describePluginThemes([
      { name: "青", tokens: { accent: "#2dd4bf" } },
      { name: "雪", tokens: { bg: "#000000", text: "#ffffff" } },
    ])).toBe("青（1 令牌）/雪（2 令牌）");
  });
});

/* ── ② `theme` 与 `themes` 互斥 + 向后兼容 ─────────────────────────────────── */

describe("A-1200-B2 ② `theme`（单套）与 `themes`（多套）互斥 + 向后兼容", () => {
  it("两者同写 ⇒ 整份拒（口径冲突不猜「以哪个为准」）", () => {
    const r = parsePluginContributes({
      theme: { name: "单", tokens: { accent: "#2dd4bf" } },
      themes: [{ name: "多1", tokens: { accent: "#2dd4bf" } }],
    });
    expect(r.ok, "theme 与 themes 同写必须拒").toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("不可同时声明"); }
  });

  it("⚠️ 向后兼容：只用 `theme` 的老清单走 `parsePluginManifest` **照常通过**（真校验，不是绕过）", () => {
    const r = parsePluginManifest({
      name: "legacy-theme",
      version: "1.0.0",
      description: "A-1198 时代只写单 theme 的老插件",
      origin: "user",
      provides: ["instructions"],
      contributes: {
        theme: { name: "暮色青", tokens: { accent: "#2dd4bf", radius: "round" } },
        page: { kind: "html", entry: "panel.html" },
      },
    });
    expect(r.ok, r.ok ? "" : r.errors.join("；")).toBe(true);
    if (!r.ok) { return; }
    expect(r.manifest.contributes?.theme?.name).toBe("暮色青");
    /* 老清单不该凭空多出 themes 字段（那是"静默塞了新东西"）。 */
    expect(r.manifest.contributes?.themes).toBeUndefined();
  });

  it("只用 `themes` 的新清单通过；`contributes.themes` 出现在解析白名单里（契约面）", () => {
    const r = parsePluginManifest({
      name: "multi-theme",
      version: "1.0.0",
      description: "一个插件多套皮肤",
      origin: "user",
      provides: ["instructions"],
      contributes: {
        themes: [
          { name: "A", tokens: { accent: "#2dd4bf" } },
          { name: "B", tokens: { accent: "#7aa2f7" } },
        ],
      },
    });
    expect(r.ok, r.ok ? "" : r.errors.join("；")).toBe(true);
    if (r.ok) { expect(r.manifest.contributes?.themes).toHaveLength(2); }
    /* 白名单必须含 themes：不含的话 parsePluginContributes 会先以「未知字段」拒掉，
       而上面的正向用例会红 —— 这条断言把「拒的原因」钉死在这件事上。 */
    expect(parsePluginContributes({ themes: [skin("A")] }).ok).toBe(true);
  });
});

/* ── ③ `url()` 白名单：只放行 `plugin-asset:<纯相对>` ───────────────────────── */

describe("A-1200-B2 ③ 皮肤资源 `url()` 白名单（精确到一种形态，其余全拒）", () => {
  it("唯一放行形态：`url(plugin-asset:<纯相对>)` 通过（皮肤终于能有图）", () => {
    const good = ".card { background-image: url(plugin-asset:assets/bg.png); }";
    expect(parsePluginCss({ name: "壁纸", css: good }).ok, good).toBe(true);
    expect(findPluginCssViolations(good)).toEqual([]);
    /* 子目录、带引号、大写协议前缀都收（同一形态，不是新形态）。 */
    for (const css of [
      ".a { background: url('plugin-asset:assets/bg.png'); }",
      ".a { background: url(\"plugin-asset:a/b/c.png\"); }",
      ".a { background: url(PLUGIN-ASSET:bg.png); }",
    ]) {
      expect(parsePluginCss({ name: "x", css }).ok, css).toBe(true);
    }
  });

  it("⚠️ 外联类形态**全拒**（外观不需要外联 = 别开数据外泄面）：每条只触发它自己那一��判据", () => {
    /* ⚠️ 样例必须**只触发它自己那一条** —— 若样例里还含别的形态，删掉其中一条判据后它仍被另一条挡住，
       守卫照样绿而变异存活（等价变异）。这里每条都是纯 `url()` 写法（不带 @import 等）。 */
    const cases: Array<[string, string]> = [
      ["http://evil/p.png", "只允许插件目录内的相对资源"],
      ["https://evil/p.png", "只允许插件目录内的相对资源"],
      ["//evil/p.png", "只允许插件目录内的相对资源"],
      ["data:image/png;base64,AAAA", "只允许插件目录内的相对资源"],
      ["bg.png", "只允许插件目录内的相对资源"],
    ];
    for (const [value, which] of cases) {
      const css = `.a { background: url(${value}); }`;
      expect(parsePluginCss({ name: "x", css }).ok, `${value} 应被拒`).toBe(false);
      const hits = checkPluginAssetUrls(css);
      expect(hits.length, `${value} 应由url 判据命中`).toBeGreaterThan(0);
      expect(hits.join("；")).toContain(which);
    }
    /* 空 url() 单独一条判据（`url()` 与 `url( )` 都拒，文案说「取值为空」而不是「形态不符」——
       两种错误的修法不同：前者是写漏了参数，后者是形态用错了）。 */
    for (const css of [".a { background: url(); }", ".a { background: url(  ); }"]) {
      expect(parsePluginCss({ name: "x", css }).ok, css).toBe(false);
      expect(checkPluginAssetUrls(css).join("；"), css).toContain("取值为空");
    }
  });

  it("⚠️ 路径逃逸全拒：`..` / 盘符 / UNC / 以分隔符开头（改写后会爬出插件目录 = 越权）", () => {
    const cases: Array<[string, string]> = [
      ["plugin-asset:../../evil.png", "不得含 .. 段"],
      ["plugin-asset:a/../../evil.png", "不得含 .. 段"],
      ["plugin-asset:..\\evil.png", "不得含 .. 段"],
      ["plugin-asset:C:\\evil.png", "盘符"],
      ["plugin-asset:c:/evil.png", "盘符"],
      ["plugin-asset:\\\\server\\share\\x.png", "盘符"],
      ["plugin-asset:/etc/passwd", "分隔符开头"],
      ["plugin-asset:\\windows\\x.png", "分隔符开头"],
      ["plugin-asset:", "缺少资源路径"],
    ];
    for (const [value, which] of cases) {
      const css = `.a { background: url(${value}); }`;
      expect(parsePluginCss({ name: "x", css }).ok, `${value} 应被拒`).toBe(false);
      expect(checkPluginAssetUrls(css).join("；"), value).toContain(which);
    }
  });

  it("判据是**纯函数**且可单独使用（守卫与实现同口径，不许两套判据）", () => {
    /* 单参判据：形态 + 路径都在这里判，渲染层/守卫/清单层共用它。 */
    expect(isAllowedPluginAssetUrl("plugin-asset:bg.png")).toEqual({ ok: true, path: "bg.png" });
    expect(isAllowedPluginAssetUrl("plugin-asset: assets/bg.png").ok).toBe(true);
    expect(isAllowedPluginAssetUrl("http://x").ok).toBe(false);
    expect(isAllowedPluginAssetUrl("plugin-asset:../x").ok).toBe(false);
    /* 提取器：一次取出所有 url 参数（含多条 url 与带引号的）。 */
    expect(extractPluginCssUrls(".a{background:url(plugin-asset:a.png),url(plugin-asset:b.png)}"))
      .toEqual(["plugin-asset:a.png", "plugin-asset:b.png"]);
    expect(extractPluginCssUrls(".a{background:url('http://x') }")).toEqual(["http://x"]);
    expect(extractPluginCssUrls(".a{color:red}")).toEqual([]);
    /* 协议前缀常量是单一产地（改它就等于改全链路口径）。 */
    expect(PLUGIN_ASSET_SCHEME).toBe("plugin-asset");
  });
});

/* ── ④ 协议改写：宿主侧、只对本插件目录生效、文件缺失如实回退 ──────────────── */

describe("A-1200-B2 ④ `plugin-asset:` → 真实地址的改写（纯函数 + 只对自己插件生效）", () => {
  const base = "http://127.0.0.1:53124/";

  it("改写成该插件目录静态服务的真实地址（多条一起改；反斜杠归一为正斜杠）", () => {
    const css = ".a{background:url(plugin-asset:assets/bg.png)}.b{background:url(plugin-asset:sub\\b.png)}";
    const out = rewritePluginAssetUrls(css, base, () => true);
    expect(out).toContain(`url("${base}assets/bg.png")`);
    expect(out).toContain(`url("${base}sub/b.png")`);
    expect(out, "改写后不许再残留 plugin-asset: 协议").not.toContain(PLUGIN_ASSET_SCHEME);
  });

  it("基址没带尾斜杠也拼对（不产生 `//assets` 这种双斜杠地址）", () => {
    const out = rewritePluginAssetUrls(".a{background:url(plugin-asset:bg.png)}", "http://127.0.0.1:1", () => true);
    expect(out).toContain(`url("http://127.0.0.1:1/bg.png")`);
  });

  it("⚠️ 文件不存在 ⇒ 整个 `url()` **被删掉**（不留一个指向 404 的地址 ——「皮肤有图但看不见」比没图更坏）", () => {
    const out = rewritePluginAssetUrls(".a{background:url(plugin-asset:missing.png)}", base, () => false);
    expect(out).not.toContain("url(");
    expect(out).not.toContain("missing.png");
    /* 部分存在时：只删不存在的那个，存在的照常改写（不做整段放弃）。 */
    const mixed = rewritePluginAssetUrls(
      ".a{background:url(plugin-asset:ok.png)}.b{background:url(plugin-asset:gone.png)}",
      base,
      (p) => p === "ok.png",
    );
    expect(mixed).toContain(`url("${base}ok.png")`);
    expect(mixed).not.toContain("gone.png");
  });

  it("非法形态在改写阶段也**原样删掉**（不写出去 —— 清单层已拒，这里是第二道）", () => {
    const out = rewritePluginAssetUrls(".a{background:url(plugin-asset:../x.png)}", base, () => true);
    expect(out).not.toContain("../x.png");
  });

  it("不含 plugin-asset 的 CSS **逐字节不变**（改写是无操作的 ⇒ 不影响绝大多数插件）", () => {
    const css = ".card { border-radius: 18px; }\n.btn { color: red; }";
    expect(rewritePluginAssetUrls(css, base, () => true)).toBe(css);
  });
});

/* ── ⑤ 全屏皮肤层：z-index 低于模态 backdrop + 可开可关 ────────────────────── */

describe("A-1200-B2 ⑤ 全屏皮肤层 `#slime-skin-layer`：能全屏，但盖不掉权限弹窗", () => {
  const layer = read("gui/src/renderer/components/PluginSkinLayer.tsx");
  const app = read("gui/src/renderer/App.tsx");
  const css = read("gui/src/renderer/index.css");

  it("容器三要素齐全：fixed + inset:0 + pointer-events:none（不吃点击，否则整个界面变死区）", () => {
    expect(layer).toContain('const SKIN_LAYER_ID = "slime-skin-layer";');
    expect(layer).toMatch(/position: "fixed"/);
    expect(layer).toMatch(/inset: 0/);
    expect(layer).toMatch(/pointerEvents: "none"/);
    /* id 必须真的落在 JSX 上（常量声明 ≠ 渲染出来的元素带这个 id）。 */
    expect(layer).toMatch(/id=\{SKIN_LAYER_ID\}/);
  });

  it("⚠️ z-index **低于**对话框 backdrop(1200)（这是「盖不掉权限确认弹窗」那条不变量本身）", () => {
    const m = /export const SKIN_LAYER_Z = (\d+);/.exec(layer);
    expect(m, "PluginSkinLayer 里找不到 SKIN_LAYER_Z").not.toBeNull();
    const z = Number(m![1]);
    expect(z, "皮肤层必须低于对话框 backdrop 1200，否则能盖掉权限确认弹窗").toBeLessThan(1200);
    expect(z, "皮肤层要高于应用内容（否则全屏壁纸会被内容挡住 = 等于没做全屏层）").toBeGreaterThan(0);
    /* 判据要钉住「与 B1 的浮层同值」—— 另发明一套就会出现「皮肤层 1300 / 对话框 1200」的致命组合。 */
    const slotHost = read("gui/src/renderer/components/UiSlotHost.tsx");
    const b1 = /const PLUGIN_OVERLAY_Z = (\d+);/.exec(slotHost);
    expect(b1, "UiSlotHost 里找不到 PLUGIN_OVERLAY_Z（B1 的取值表锚）").not.toBeNull();
    expect(z, "皮肤层必须与 B1 浮层沿用同一份z-index 取值表").toBe(Number(b1![1]));
    /* 而那个取值本身必须确实低于 backdrop（两条件同时成立才算钉住）。 */
    expect(css).toMatch(/\.dlg-backdrop \{[\s\S]*?z-index: 1200;/);
  });

  it("App 根部真的挂了这一层（不挂 = 皮肤声明了永不生效 = 说了不算）", () => {
    expect(app).toMatch(/import \{ PluginSkinLayer \} from "\.\/components\/PluginSkinLayer\.js"/);
    expect(app).toContain("<PluginSkinLayer />");
  });

  it("可开可关：无生效外观 ⇒ **整个容器不渲染**（不是留一个空 div —— 空 div 也会占层叠与命中区）", () => {
    expect(layer).toMatch(/if \(!active\) \{ return null; \}/);
    /* 「有生效外观」的判据必须同时看选择**与**可用列表：只有选择但插件被卸了也算无
       （否则容器会为一个永远不生效的选择留一个空层）。 */
    expect(layer).toContain("getPluginThemeSelection()");
    expect(layer).toContain("getCachedPluginThemes()");
    expect(layer).toContain("getPluginCssSelection()");
    expect(layer).toContain("getCachedPluginCss()");
    /* 两个外观来源都要订阅（皮肤与 CSS 互斥生效，但容器要跟着任一个的出现/消失）。 */
    expect(layer).toContain("subscribePluginTheme");
    expect(layer).toContain("subscribePluginCss");
  });

  it("⚠️ 皮肤层不是「第二个浮层出口」：它不吃点击，也不许承载交互部件", () => {
    /* 交互部件的正规出口是 B1 的 panel 区域；这一层只填外观 ⇒ **全文件不许**出现
       pointer-events:auto（出现了就意味着这一层开始吃点击，整个界面变死区/可拖动）。 */
    expect(layer, "皮肤层不该出现 pointer-events:auto（交互部件走 panel 区域）").not.toContain("pointer-events:auto");
    expect(layer, "皮肤层不该出现 iframe/动态求值（扩展代码不进宿主）").not.toMatch(/<iframe|new Function\(|eval\(/);
  });
});

/* ── ⑥ 外观页：多皮肤卡 + 选择持久化向后兼容 ──────────────────────────────── */

describe("A-1200-B2 ⑥ 外观页：一个插件的多套皮肤各占一张卡 + 老选择仍生效", () => {
  const panel = read("gui/src/renderer/pages/AppearancePanel.tsx");

  it("卡片 key 用 `plugin::皮肤名`（只用 plugin 会让同一插件的多套皮肤串成一张卡）", () => {
    expect(panel).toContain("pluginThemeSelectionKey(t.plugin, t.id)");
    expect(panel).toMatch(/key=\{cardKey\}/);
    expect(panel).toContain("onClick={() => setPluginThemeSelection(cardKey)}");
    /* 选中态也按新 key 比（不是比 plugin）。 */
    expect(panel).toContain("const active = pluginSkin === cardKey;");
  });

  it("选择值解析：新格式精确到「哪一套」，老格式（只存 plugin 名）⇒ 该插件第一套", () => {
    expect(PLUGIN_THEME_KEY_SEP).toBe("::");
    expect(pluginThemeSelectionKey("a", "青")).toBe("a::青");
    /* 新格式解析出皮肤名。 */
    expect(parsePluginThemeSelection("a::青")).toEqual({ plugin: "a", skinName: "青" });
    /* ⚠️ 老格式（不含分隔符）⇒ skinName=null，**不当作插件名的一部分**（向后兼容分支）。 */
    expect(parsePluginThemeSelection("a")).toEqual({ plugin: "a", skinName: null });
    expect(parsePluginThemeSelection("")).toBeNull();
    expect(parsePluginThemeSelection("::青")).toBeNull();
    expect(parsePluginThemeSelection("a::")).toBeNull();
  });

  it("⚠️ 兼容分支被**真实执行**：老选择命中「该插件的第一套」而不是 null（体验不倒退）", () => {
    __resetPluginThemeForTest();
    const themes = [
      { plugin: "demo", id: "第一套", name: "第一套" },
      { plugin: "demo", id: "第二套", name: "第二套" },
      { plugin: "other", id: "别的", name: "别的" },
    ];
    /* 老选择（只存了插件名）：落到该插件的第一套。 */
    expect(resolveActiveTheme(themes, "demo")).toEqual(themes[0]);
    /* 新选择：精确到第二套（老选择分支不会误吞新格式）。 */
    expect(resolveActiveTheme(themes, "demo::第二套")).toEqual(themes[1]);
    /* 空选择 / 插件没了 ⇒ null（回落默认，不留幽灵皮肤）。 */
    expect(resolveActiveTheme(themes, "")).toBeNull();
    expect(resolveActiveTheme(themes, "gone")).toBeNull();
    /* ⚠️ 插件还在、但**那一套**不在（改名/ 换掉一套后老的 `::皮肤名` 选择悬空）⇒ 也必须 null。
       这条与「插件没了」是**两处不同判据**：插件没了走「同插件筛选为空」那一步，
       皮肤名对不上走「同插件内find 落空」那一步。少钉后者 ⇒ 那一行被改坏时守卫仍绿
       （实测：这条正是 mut-a1198-plugin-theme M9 变异存活的原因 —— 它的守卫只钉了前者）。 */
    expect(resolveActiveTheme(themes, "demo::已被改名的套")).toBeNull();
    expect(resolveActiveTheme(themes, "demo::第一套")).toBe(themes[0]);
    /* 同名跨插件不串台：老选择只在自己的插件里找第一套。 */
    expect(resolveActiveTheme(themes, "other")).toEqual(themes[2]);
    /* 半截/畸形选择 ⇒ null（不拿半截字符串去匹配）。 */
    expect(resolveActiveTheme(themes, "::第一套")).toBeNull();
  });

  it("皮肤与 CSS 互斥生效的老口径没被破坏（选 CSS 仍清掉皮肤选择）", () => {
    expect(panel).toMatch(/setPluginCssSelection\(c\.plugin\);[\s\S]{0,200}?setPluginThemeSelection\(""\)/);
  });
});

/* ── ⑦ 宿主侧接线：改写只在宿主侧、只对自己插件的目录生效 ──────────────────── */

describe("A-1200-B2 ⑦ 接线锁：改写在宿主侧 + 只对本插件目录生效 + 撤销不留残留", () => {
  const main = read("gui/src/main/index.ts");
  const hostSrc = read("core-ts/src/plugin/host.ts");
  const ipc = read("gui/src/shared/ipc.ts");

  it("改写函数住在**主进程**（渲染层没有也不该有「目录 → 基址」的映射）", () => {
    expect(main).toContain("function rewriteCssAssets(plugin: string, decl: PluginCssDecl): string {");
    /* 改写基址只从宿主登记表取（表由 dirs.get(插件名) 填 ⇒ 跨插件读文件结构上不成立）。 */
    expect(main).toContain("const pluginCssAssetBases = new Map<string, string>();");
    expect(main).toContain("const pluginCssAssetDirs = new Map<string, string>();");
    expect(main).toMatch(/const base = pluginCssAssetBases\.get\(plugin\);/);
    expect(main).toMatch(/const dir = pluginCssAssetDirs\.get\(plugin\);/);
    /* 拿不到目录 ⇒ 原样返回（不静默改写成别的目录）。 */
    expect(main).toMatch(/if \(!base \|\| !dir\) \{ return decl\.css; \}/);
    /* 复用既有静态服务机制（与 page / panel 同一个 httpServer、同一个 host）。 */
    expect(main).toMatch(/httpServer\.serve\(\{ dir, host: "127\.0\.0\.1", origin: "agent" \}\)/);
    /* 绝不 file://（§5.4）。 */
    const fn = /function rewriteCssAssets[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
    expect(fn).not.toContain("file://");
  });

  it("主进程导入的是**纯函数**（改写逻辑在 core-ts，可单测；main 只提供基址与目录判据）", () => {
    expect(main).toMatch(/import \{ PLUGIN_ASSET_SCHEME, rewritePluginAssetUrls \} from "\.\.\/\.\.\/\.\.\/core-ts\/src\/plugin\/contributes\.js";/);
    expect(main).toContain("rewritePluginAssetUrls(decl.css, base,");
  });

  it("host：`themes` 走 contribute（撤销句柄入scope ⇒ 停用/卸载即从表移除）", () => {
    expect(hostSrc).toContain("registerThemes?: (manifest: PluginManifest) => PluginContributionHandle[];");
    expect(hostSrc).toMatch(/this\.registerThemes = opts\.registerThemes \?\? null/);
    expect(hostSrc).toMatch(/this\.contribute\(scope, this\.registerThemes, manifest\)/);
    expect(hostSrc).toContain("describePluginThemes(themesDecl)");
    /* 两套声明各自登记，互不覆盖。 */
    expect(hostSrc).toContain("if (themeDecl !== undefined) {");
    expect(hostSrc).toContain("if (themesDecl !== undefined) {");
  });

  it("撤销时连改写登记表一起清（不残留一个指向已卸载插件的基址）", () => {
    const seg = /registerCss: \(manifest\) => \{[\s\S]*?\n {4}\},\n/.exec(main)?.[0] ?? "";
    expect(seg, "main 里找不到 registerCss 钩子段").not.toBeNull();
    expect(seg).toContain("pluginCssAssetBases.delete(manifest.name);");
    expect(seg).toContain("pluginCssAssetDirs.delete(manifest.name);");
  });

  it("快照 DTO 带 `id`（渲染层区分第几套的依据；不带 ⇒ 同插件多套皮肤在 UI 上串台）", () => {
    const dto = /export interface PluginThemeDTO \{[\s\S]*?\n\}/.exec(ipc)?.[0] ?? "";
    expect(dto, "ipc.ts 里找不到 PluginThemeDTO").not.toBeNull();
    expect(dto).toMatch(/\n\s+id: string;/);
    /* 单套 theme 的 id 也取自己的 name ⇒ 渲染层只有一种 key 形态。 */
    expect(main).toContain("({ plugin, id: theme.name, name: theme.name, tokens: theme.tokens })");
  });

  it("自述（Agent 口径）与实现同源：多套皮肤 + 资源 + 全屏层三件事都写到了", () => {
    const guide = read("core-ts/src/services/agentTools.ts");
    expect(guide).toContain("`themes`");
    expect(guide).toContain("`theme` 与 `themes`");
    expect(guide).toContain("url(plugin-asset:");
    expect(guide).toContain("#slime-skin-layer");
    /* 旧的「图片做不到」结论已被本批推翻 —— 不许留着（那是与实现矛盾的假陈述）。 */
    expect(guide).not.toContain("要在样式里引用图片或字体，当前**做不到**");
    expect(guide).not.toContain("外联被封");
  });
});

/* ── ⑧ 官方示例包：多套皮肤 + 资源真过清单校验（活教材） ────────────────────── */

describe("A-1200-B2 ⑧ 官方示例包 hello-slime：演示多套皮肤与皮肤资源，且真能装载", () => {
  it("plugin.json 真过 parsePluginManifest（示例自己装不上 = 活教材失效）", () => {
    const raw = JSON.parse(read(`${EXAMPLE_DIR}/plugin.json`)) as Record<string, unknown>;
    const r = parsePluginManifest(raw);
    expect(r.ok, r.ok ? "" : r.errors.join("；")).toBe(true);
    if (!r.ok) { return; }
    const themes = r.manifest.contributes?.themes ?? [];
    expect(themes.length, "示例包应演示「一个插件多套皮肤」").toBeGreaterThanOrEqual(2);
    expect(new Set(themes.map((t) => t.name)).size, "示例的多套皮肤名不得重复").toBe(themes.length);
  });

  it("示例的 CSS 自己过静态禁令（它引了 plugin-asset: 图，所以必须过新白名单）", () => {
    const raw = JSON.parse(read(`${EXAMPLE_DIR}/plugin.json`)) as Record<string, unknown>;
    const parsed = parsePluginManifest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) { return; }
    const css = parsed.manifest.contributes?.css?.css ?? "";
    expect(css).toContain(`${PLUGIN_ASSET_SCHEME}:`);
    expect(css, "示例应演示全屏皮肤层").toContain("#slime-skin-layer");
    expect(parsePluginCss({ name: "示例", css }).ok, "示例 CSS 必须能过校验").toBe(true);
    /* 改写后引用的资源文件必须**真的在插件目录里**（引用一个不存在的文件 = 活教材教人写错东西）。 */
    const assetPath = `${PLUGIN_ASSET_SCHEME}:assets/skin-bg.svg`;
    expect(css).toContain(assetPath);
    expect(existsSync(join(PROJECT_ROOT, EXAMPLE_DIR, "assets", "skin-bg.svg"))).toBe(true);
    const rewritten = rewritePluginAssetUrls(css, "http://127.0.0.1:1/", () => true);
    expect(rewritten).toContain("http://127.0.0.1:1/assets/skin-bg.svg");
  });

  it("示例的资源文件自包含（无外链、无脚本 —— 随包播种到用户磁盘的东西必须干净）", () => {
    const svg = read(`${EXAMPLE_DIR}/assets/skin-bg.svg`);
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>/);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(svg).not.toMatch(/<script|onload=/i);
  });

  it("向后兼容：单theme 的老清单在**示例之外**也仍能过（本批没动 theme 的判据）", () => {
    const r = parsePluginManifest({
      name: "single-theme",
      version: "1.0.0",
      description: "老格式单皮肤",
      origin: "user",
      provides: ["instructions"],
      contributes: { theme: { name: "只有一套", tokens: { accent: "#2dd4bf" } } },
    });
    expect(r.ok, r.ok ? "" : r.errors.join("；")).toBe(true);
  });
});

/* ── ⑨ 类型层：多皮肤的声明形状真的能承载数组 ─────────────────────────────── */

describe("A-1200-B2 ⑨ 类型与别名：PluginContributes.themes 与 describe* 都在", () => {
  it("PluginThemeDecl 复用不变（themes 的元素类型就是 theme 的元素类型 —— 不另立一套形状）", () => {
    const one: PluginThemeDecl = { name: "x", tokens: { accent: "#2dd4bf" } };
    const many: PluginThemeDecl[] = [one, { name: "y", tokens: { bg: "#000000" } }];
    expect(many).toHaveLength(2);
    /* 单套与多套的判据同源：同一个 parsePluginTheme 能解析数组里的每一项。 */
    expect(parsePluginThemes(many).ok).toBe(true);
  });
});