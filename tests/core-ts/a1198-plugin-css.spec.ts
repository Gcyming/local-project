/**
 * tests/core-ts/a1198-plugin-css.spec.ts — CSS 贡献点（`contributes.css`）的守卫。
 *
 * ## 用户口径（本轮放开的原因，原话）
 * 「还是把CSS 修改权限全面放开吧，倒也不是说修改，我说了是插件。
 *   通过插件来进行开关可控的改动」
 * ⇒ 插件是**用户自己装、自己开关**的，改配色/布局/字号属于"用插件武装"。
 *
 * ## 这一层在防什么（三条护栏，逐条都有对应的真实失效场景）
 *   ① **静态禁令 fail-closed**：`@import`/`url()`（外联＝把数据发出去）、`@font-face`（外部资源）、
 *      `!important`（绕过层叠的旁门）、全局选择器（`*`/`html`/`body`/`:root` 能接管全站并藏掉
 *      宿主安全提示）、`position:fixed`（不依赖层叠就能遮蔽安全关键 UI）。
 *      **判据是"整份拒"**，不是"静默忽略这一条"。
 *   ② **@layer 层叠**：宿主 index.css 整份包进 `@layer slime-host`，插件落 `@layer slime-plugin`，
 *      并先写一次顺序声明 ⇒ 插件层**永远低于**宿主层。
 *      真实场景：权限请求弹窗（git门禁 / diff 评审 / 脚本执行确认）走 JSX + 宿主样式表，
 *      插件若能盖掉它，`display:none` 就能把「允许/拒绝」藏起来 ⇒ 误操作默认通过（功能性失效）。
 *   ③ **可开可关 + 作用域**：停用/卸载 ⇒ 样式从可用列表消失、回落内置外观、**整段撤下不残留**；
 *      选择器自动收进 `.slime-plugin-scope`（没插件 CSS 时宿主 DOM 上根本没这个类）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAX_PLUGIN_CSS_BYTES,
  MAX_PLUGIN_CSS_NAME,
  describePluginCss,
  findPluginCssViolations,
  parsePluginContributes,
  parsePluginCss,
  scopePluginCss,
} from "../../core-ts/src/plugin/contributes.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";
import {
  PLUGIN_CSS_LAYER_ORDER,
  PLUGIN_CSS_SCOPE_CLASS,
  PLUGIN_CSS_STORAGE_KEY,
  PLUGIN_CSS_STYLE_ID,
  applyPluginCss,
  getPluginCssSelection,
  resolveActiveCss,
  setPluginCssSelection,
  __resetPluginCssForTest,
} from "../../gui/src/renderer/pluginCss.js";

const ROOT = resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

const GOOD_CSS = ".card { border-radius: 18px; }\n.btn { letter-spacing: 0.02em; }";

describe("A-1198-CSS ① 声明校验 fail-closed（静态禁令逐条拒）", () => {
  it("正常 CSS 通过；name/css 缺失或超限都拒", () => {
    const ok = parsePluginCss({ name: "紧凑", css: GOOD_CSS });
    expect(ok.ok).toBe(true);
    expect(parsePluginCss({ css: GOOD_CSS }).ok).toBe(false);          // 缺 name
    expect(parsePluginCss({ name: "x" }).ok).toBe(false);              // 缺 css
    expect(parsePluginCss({ name: "  ", css: GOOD_CSS }).ok).toBe(false); // 空白 name
    expect(parsePluginCss({ name: "x", css: "   " }).ok).toBe(false);  // 空白 css
    expect(parsePluginCss({ name: "a".repeat(MAX_PLUGIN_CSS_NAME + 1), css: GOOD_CSS }).ok).toBe(false);
    expect(parsePluginCss({ name: "x", css: "a".repeat(MAX_PLUGIN_CSS_BYTES + 1) }).ok).toBe(false);
    expect(parsePluginCss([]).ok).toBe(false);
  });

  it("未知字段拒（拼错字段名不许静默失效）", () => {
    const r = parsePluginCss({ name: "x", css: GOOD_CSS, selectors: "h1{}" });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("未知字段"); }
  });

  /* ⚠️ 这一组是**逐条 + 各自独立触发**的：每条禁令都要有"真的被拒"的反例。
     ⚠️ 样例必须**只触发它自己那一条** —— 若样例里还含 url()，删掉 @import 禁令后它仍被url() 挡住，
     守卫照样绿 ⇒ 变异存活（等价变异）。所以这里用 `local("Arial")` / 无 url 的等价写法。 */
  it("外联类禁令：@import / url() / @font-face / @charset / @namespace 全拒（各自独立触发）", () => {
    const cases: Array<[string, string]> = [
      ["@import \"http://evil/x.css\";", "@import"],
      [".a { background: url(http://evil/p.png); }", "url()"],
      ["@font-face { font-family: x; src: local(\"Arial\"); }", "@font-face"],
      ["@charset \"utf-8\";", "@charset"],
      ["@namespace svg url(http://www.w3.org/2000/svg);", "@namespace"],
    ];
    for (const [css, which] of cases) {
      const hits = findPluginCssViolations(css);
      expect(parsePluginCss({ name: "x", css }).ok, css).toBe(false);
      /* 关键：确实是被**它自己**挡下来的（不是被别的禁令连带）。
         `why` 是完整说明文案（带括号解释），所以按**前缀**匹配。 */
      expect(hits.some((h) => h.startsWith(which)), `${css} 应由 ${which} 命中（实际：${hits.join(" / ") || "无"}）`).toBe(true);
    }
  });

  it("覆盖类禁令：!important / position:fixed / 全局选择器 全拒", () => {
    for (const css of [
      ".card { color: red !important; }",
      ".a { position: fixed; }",
      ".a { position: FIXED; }",
      "* { box-shadow: none; }",
      "html { font-size: 8px; }",
      "body { background: #000; }",
      ":root { --accent: red; }",
    ]) {
      expect(parsePluginCss({ name: "x", css }).ok, css).toBe(false);
    }
  });

  it("旧式绑定与脚本协议拒（expression / -moz-binding / behavior / javascript:）", () => {
    for (const css of [
      ".a { width: expression(alert(1)); }",
      ".a { -moz-binding: url(x.xml#e); }",
      ".a { behavior: url(x.htc); }",
      ".a { background: javascript:alert(1); }",
    ]) {
      expect(parsePluginCss({ name: "x", css }).ok, css).toBe(false);
    }
  });

  it("作用域改写不覆盖的 AT 规则也拒（@media/@supports/@keyframes 嵌套块）", () => {
    for (const css of [
      "@media (max-width: 600px) { .card { color: red; } }",
      "@supports (display: grid) { .card { color: red; } }",
      "@keyframes spin { from { opacity: 0 } to { opacity: 1 } }",
    ]) {
      expect(parsePluginCss({ name: "x", css }).ok, css).toBe(false);
    }
  });

  it("合法用法不被误伤（选择器可以随便写）", () => {
    for (const css of [
      ".a > .b + .c ~ .d { color: red; }",
      ".a:hover::after { content: 'x'; }",
      "h1, h2, .card { margin: 0 auto; }",
      ".a .b .c { font-size: 12px; }",
      ".grid { display: grid; grid-template-columns: repeat(2, 1fr); }",
      ".a { transition: all 0.2s ease; }",
      ".a[data-x=\"1\"] { color: red; }",
    ]) {
      expect(parsePluginCss({ name: "x", css }).ok, css).toBe(true);
    }
  });

  it("findPluginCssViolations 与解析器同判据（守卫与实现不许两套口径）", () => {
    expect(findPluginCssViolations(GOOD_CSS)).toEqual([]);
    expect(findPluginCssViolations(".a{position:fixed}").length).toBeGreaterThan(0);
  });

  it("contributes.css 非法 ⇒ 整份清单 rejected（fail-closed 不静默丢单个字段）", () => {
    const r = parsePluginContributes({ css: { name: "x", css: ".a{position:fixed}" } });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("position:fixed"); }
    expect(parsePluginContributes({ css: { name: "x", css: GOOD_CSS } }).ok).toBe(true);
  });

  it("describePluginCss 摘要（含字节数，便于扩展页展示）", () => {
    expect(describePluginCss(undefined)).toBe("0");
    expect(describePluginCss({ name: "紧凑", css: GOOD_CSS })).toContain("紧凑");
    expect(describePluginCss({ name: "紧凑", css: GOOD_CSS })).toContain("字节");
  });
});

describe("A-1198-CSS ② 作用域与层叠（为什么插件盖不掉安全关键 UI）", () => {
  it("scopePluginCss 给每条选择器加作用域前缀", () => {
    expect(scopePluginCss(".card { color: red; }")).toBe(".slime-plugin-scope .card { color: red; }");
    expect(scopePluginCss("h1 { color: red; }")).toBe(".slime-plugin-scope h1 { color: red; }");
  });

  it("逗号分隔的多个选择器逐个加前缀（漏一个 = 那条逃出作用域）", () => {
    const out = scopePluginCss(".a, .b { color: red; }");
    expect(out).toBe(".slime-plugin-scope .a, .slime-plugin-scope .b { color: red; }");
    /* 逐个断言：两个选择器各自都带前缀（拆开看，别用一条正则糊过去）。 */
    const parts = out.split(",").map((x) => x.trim());
    expect(parts).toHaveLength(2);
    expect(parts[0].startsWith(`.${PLUGIN_CSS_SCOPE_CLASS} `)).toBe(true);
    expect(parts[1].startsWith(`.${PLUGIN_CSS_SCOPE_CLASS} `)).toBe(true);
  });

  it("已带作用域前缀的不重复加（幂等）", () => {
    const once = scopePluginCss(".card { color: red; }");
    expect(scopePluginCss(once)).toBe(once);
  });

  it("多层后代选择器整体加前缀（不是只加第一段）", () => {
    expect(scopePluginCss(".a .b .c { color: red; }")).toBe(".slime-plugin-scope .a .b .c { color: red; }");
  });

  it("⚠️ 宿主 index.css 整份包在 @layer slime-host 里（层叠前提）", () => {
    const css = read("gui/src/renderer/index.css");
    /* 层顺序由首个 @layer 声明决定 ⇒ 宿主文件必须声明自己的层名。 */
    expect(css).toContain("@layer slime-host {");
    /* 包裹必须闭合在文件末尾（漏一个 } = 后面全部规则解析失败）。 */
    const opens = (css.match(/@layer\s+slime-host\s*\{/g) ?? []).length;
    expect(opens).toBe(1);
    /* 作用域类只挂在插件 CSS 生效时；宿主 CSS 不该依赖它（否则没插件时界面变样）。 */
    expect(css).not.toContain(".slime-plugin-scope");
  });

  it("层顺序声明把宿主层排在插件层之前", () => {
    expect(PLUGIN_CSS_LAYER_ORDER).toBe("@layer slime-host, slime-plugin;");
  });
});

describe("A-1198-CSS ③ 落值与可开可关（不残留）", () => {
  interface FakeStyleEl { id: string; textContent: string | null; attrs: Record<string, string>; setAttribute(k: string, v: string): void }
  /**
   * 假DOM。⚠️ `createElement` **每次返回新对象**（与真 DOM 一致），并记录 append 次数 ——
   * 早先偷懒返回同一个对象，导致「换套不叠加」这条守卫测不出叠加（两种实现长得一模一样，变异存活）。
   */
  function fakeDoc(): {
    doc: Parameters<typeof applyPluginCss>[1];
    styleEl: FakeStyleEl;
    classes: Set<string>;
    appended: FakeStyleEl[];
  } {
    const classes = new Set<string>();
    const appended: FakeStyleEl[] = [];
    const styleEl: FakeStyleEl = {
      id: "", textContent: null, attrs: {},
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
    };
    const doc = {
      getElementById: (id: string) => (appended.find((e) => e.id === id) ?? null),
      createElement: (): FakeStyleEl => ({ id: "", textContent: null, attrs: {}, setAttribute(k: string, v: string) { this.attrs[k] = v; } }),
      head: {
        appendChild: (n: unknown) => {
          const el = n as FakeStyleEl;
          if (!el.id) { el.id = PLUGIN_CSS_STYLE_ID; }
          appended.push(el);
        },
      },
      documentElement: {
        classList: {
          add: (c: string) => { classes.add(c); },
          remove: (c: string) => { classes.delete(c); },
        },
      },
    };
    return { doc: doc as never, styleEl, classes, appended };
  }

  it("生效时：落<style> 且文本包在 @layer slime-plugin + 作用域类被挂上", () => {
    __resetPluginCssForTest();
    const { doc, appended, classes } = fakeDoc();
    expect(applyPluginCss({ name: "紧凑", css: GOOD_CSS }, doc)).toBe(true);
    /* 只准创建一个 <style>（复用同一个才叫"换套不叠加"）。 */
    expect(appended).toHaveLength(1);
    const styleEl = appended[0]!;
    expect(styleEl.id).toBe(PLUGIN_CSS_STYLE_ID);
    expect(styleEl.textContent).toContain(PLUGIN_CSS_LAYER_ORDER);
    expect(styleEl.textContent).toContain("@layer slime-plugin {");
    expect(styleEl.textContent).toContain(".slime-plugin-scope .card");
    expect(styleEl.attrs["data-owner"]).toBe("slime-plugin-css");
    expect(classes.has(PLUGIN_CSS_SCOPE_CLASS)).toBe(true);
  });

  it("⚠️ 撤下时：整段清空 + 摘作用域类（不残留 —— 可开可关的落点）", () => {
    __resetPluginCssForTest();
    const { doc, appended, classes } = fakeDoc();
    applyPluginCss({ name: "紧凑", css: GOOD_CSS }, doc);
    expect(applyPluginCss(null, doc)).toBe(false);
    expect(appended[0]!.textContent).toBe("");
    expect(classes.has(PLUGIN_CSS_SCOPE_CLASS)).toBe(false);
  });

  it("换一套不叠加（复用同一个 <style>）", () => {
    __resetPluginCssForTest();
    const { doc, appended } = fakeDoc();
    applyPluginCss({ name: "A", css: ".a{color:red}" }, doc);
    applyPluginCss({ name: "B", css: ".b{color:blue}" }, doc);
    /* ⚠️ 判据是「仍然只有一个 <style>」+「内容是后者」——
       只断言内容的话，多append 一个节点也能通过（两份 style 同时生效 = 叠加）。 */
    expect(appended).toHaveLength(1);
    expect(appended[0]!.textContent).toContain(".b");
    expect(appended[0]!.textContent).not.toContain(".a");
  });

  it("resolveActiveCss：选择失效（插件停用/卸载）⇒ null ⇒ 回落内置", () => {
    expect(resolveActiveCss([{ plugin: "a" }], "")).toBeNull();
    expect(resolveActiveCss([{ plugin: "a" }], "ghost")).toBeNull();   // 插件没了
    expect(resolveActiveCss([{ plugin: "a" }], "a")).not.toBeNull();
  });

  it("选择持久化用独立键（不与皮肤的选择串在一起）", () => {
    __resetPluginCssForTest();
    expect(PLUGIN_CSS_STORAGE_KEY).not.toBe("slime-plugin-theme");
    expect(getPluginCssSelection()).toBe("");
    setPluginCssSelection("p1");
    expect(getPluginCssSelection()).toBe("p1");
    setPluginCssSelection("");
    expect(getPluginCssSelection()).toBe("");
  });
});

describe("A-1198-CSS ④ 接线（host / main / 渲染层 / 外观页）", () => {
  it("host：registerCss 钩子 + contribute 登记 + contributions 计数", () => {
    const src = read("core-ts/src/plugin/host.ts");
    expect(src).toMatch(/registerCss\?: \(manifest: PluginManifest\) => PluginContributionHandle\[\]/);
    expect(src).toMatch(/this\.registerCss = opts\.registerCss \?\? null/);
    /* 走 contribute（进 scope ⇒ 卸载/停用自动撤销）而不是直接调。 */
    expect(src).toMatch(/this\.contribute\(scope, this\.registerCss, manifest\)/);
    expect(src).toMatch(/css:\$\{wiring === WIRING_PENDING \? WIRING_PENDING : describePluginCss\(cssDecl\)\}/);
  });

  it("main：纯数据表 + 快照 cssStyles + 撤销按插件名移除", () => {
    const src = read("gui/src/main/index.ts");
    expect(src).toMatch(/const pluginCssDecls = new Map<string, PluginCssDecl>\(\)/);
    expect(src).toMatch(/registerCss: \(manifest\) => \{/);
    /* 撤销句柄：只删自己的那份（get === decl 守卫防重装时误删新表）。 */
    expect(src).toMatch(/if \(pluginCssDecls\.get\(manifest\.name\) === decl\) \{\s*\n\s*pluginCssDecls\.delete\(manifest\.name\);/);
    /* 快照按插件名排序（稳定）。 */
    expect(src).toMatch(/const cssStyles: PluginCssDTO\[\] = \[\.\.\.pluginCssDecls\.entries\(\)\]/);
  });

  it("渲染层：PluginCssHost 挂上 App 根部（不挂 = 声明了永不生效）", () => {
    const app = read("gui/src/renderer/App.tsx");
    expect(app).toMatch(/import \{ PluginCssHost \} from "\.\/components\/PluginCssHost\.js"/);
    expect(app).toMatch(/<PluginCssHost \/>/);
    const host = read("gui/src/renderer/components/PluginCssHost.tsx");
    /* 订阅 plugins_changed（扩展页装/卸/停用插件后自动重拉）。 */
    expect(host).toMatch(/pluginsOnChanged/);
    expect(host).toMatch(/cssStyles/);
  });

  it("外观页有 CSS 外观选择器，且与皮肤互斥（两套同时开会互相打补丁）", () => {
    const panel = read("gui/src/renderer/pages/AppearancePanel.tsx");
    expect(panel).toContain("扩展 CSS 外观");
    expect(panel).toMatch(/setPluginCssSelection\(c\.plugin\)/);
    /* 互斥：选了 CSS 要清掉皮肤选择。 */
    expect(panel).toMatch(/setPluginCssSelection\(c\.plugin\);[\s\S]{0,200}?setPluginThemeSelection\(""\)/);
    /* 如实告知层叠边界（不是"随便改"的空头承诺）。 */
    expect(panel).toContain("slime-plugin-scope");
    expect(panel).toContain("低于宿主样式层");
  });
});

describe("A-1198-CSS ⑤ 官方示例扩展真的能用（能装载 + 真过校验）", () => {
  it("示例包声明了 contributes.css 且真过 parsePluginManifest", () => {
    const raw = JSON.parse(read("gui/template/plugins/hello-slime/plugin.json")) as Record<string, unknown>;
    const parsed = parsePluginManifest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) { throw new Error(parsed.errors.join("；")); }
    const css = (parsed.manifest as { contributes?: { css?: { name?: string; css?: string } } }).contributes?.css;
    expect(css?.name).toBeTruthy();
    expect(typeof css?.css).toBe("string");
    /* 示例的 CSS 自己必须过静态禁令（否则示例包自己装不上）。 */
    expect(parsePluginCss(css).ok).toBe(true);
  });
});