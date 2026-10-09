/**
 * tests/core-ts/a1198-plugin-theme.spec.ts — 主题贡献点（皮肤）与官方示例扩展包的守卫。
 *
 * ## 这一层在防什么（用户口径：「高自由度扩展是外部插件、可开可关，像精装/武装」）
 *   ① `contributes.theme` 的**声明校验**必须 fail-closed：白名单令牌 + 值形态受限
 *      （颜色只收 hex、字体/圆角只收枚举）—— 拿不到任意 CSS 值，就拿不到「用样式做坏事」的面；
 *   ② **令牌 ↔ CSS 变量**是单一产地：映射表里的每个变量必须在 `index.css` 里真实存在
 *      （不同源 = 皮肤声明得合法却落了个不存在的变量：静默失效）；
 *   ③ **可开可关的落点**：选择失效（插件被停用/卸载）⇒ 回落默认并清理脏选择，不残留内联变量；
 *   ④ **接线**：host 注册钩子 / main 快照与安装通道 / 渲染层宿主组件 / 外观页选择器；
 *   ⑤ **官方示例包**：结构齐全 + 真过 `parsePluginManifest`（"能装载"的最强证明）+ 随包打包不丢。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_THEME_COLOR_VARS,
  PLUGIN_THEME_FONT_STACKS,
  PLUGIN_THEME_RADIUS_SCALES,
  describePluginTheme,
  parsePluginContributes,
  parsePluginTheme,
  themeTokenAssignments,
  type PluginThemeDecl,
} from "../../core-ts/src/plugin/contributes.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";
import {
  __resetPluginThemeForTest,
  applyPluginTheme,
  resolveActiveTheme,
} from "../../gui/src/renderer/pluginTheme.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const HOST_SRC = read("core-ts/src/plugin/host.ts");
const MAIN_SRC = read("gui/src/main/index.ts");
const IPC_SRC = read("gui/src/shared/ipc.ts");
const PRELOAD_SRC = read("gui/src/preload/index.ts");
const APP_SRC = read("gui/src/renderer/App.tsx");
const HOST_COMPONENT_SRC = read("gui/src/renderer/components/PluginThemeHost.tsx");
const PANEL_SRC = read("gui/src/renderer/pages/AppearancePanel.tsx");
const INDEX_CSS = read("gui/src/renderer/index.css");
const BUILDER_JSON = read("gui/electron-builder.json");
const BOOT_SRC = read("gui/src/main/boot.ts");

const EXAMPLE_DIR = "gui/template/plugins/hello-slime";

/* ── A · 解析 fail-closed ─────────────────────────────────────────────────── */

describe("A-1198-T ① 主题声明解析（fail-closed）", () => {
  const ok = (raw: unknown): PluginThemeDecl => {
    const r = parsePluginTheme(raw);
    expect(r.ok, r.ok ? "" : (r as { errors: string[] }).errors.join("；")).toBe(true);
    return (r as { ok: true; theme: PluginThemeDecl }).theme;
  };
  const bad = (raw: unknown): string[] => {
    const r = parsePluginTheme(raw);
    expect(r.ok, `本应被拒：${JSON.stringify(raw)}`).toBe(false);
    return (r as { ok: false; errors: string[] }).errors;
  };

  it("最小合法：一个色彩令牌即可", () => {
    const t = ok({ name: "青", tokens: { accent: "#2dd4bf" } });
    expect(t.name).toBe("青");
    expect(t.tokens.accent).toBe("#2dd4bf");
  });

  it("完整合法：色 + 字体 + 圆角（含 8 位 hex）", () => {
    const t = ok({
      name: "暮色青",
      tokens: { accent: "#2dd4bf", accentSoft: "#2dd4bf29", bg: "#071312", font: "mono", radius: "round" },
    });
    expect(t.tokens.font).toBe("mono");
    expect(t.tokens.radius).toBe("round");
  });

  it("形状非法一律拒：非对象 / 未知字段 / name 空或超长 / tokens 非对象或空", () => {
    bad("x");
    bad({ name: "a", tokens: { accent: "#ffffff" }, extra: 1 });
    bad({ name: "", tokens: { accent: "#ffffff" } });
    bad({ name: "长".repeat(25), tokens: { accent: "#ffffff" } });
    bad({ name: "a", tokens: "x" });
    bad({ name: "a", tokens: {} });
  });

  it("未知名令牌与非法色值一律拒（不收 rgb()/命名色/#fff/url/非字符串）", () => {
    expect(bad({ name: "a", tokens: { shadow: "#000000" } }).join()).toContain("未知令牌");
    for (const v of ["rgb(1,2,3)", "red", "#fff", "url(https://x)", 123, "#12345"]) {
      expect(bad({ name: "a", tokens: { accent: v } }).join(), `色值应被拒：${String(v)}`).toContain("十六进制");
    }
  });

  it("font / radius 只收枚举（越界拒）", () => {
    expect(bad({ name: "a", tokens: { font: "comic" } }).join()).toContain("枚举值");
    expect(bad({ name: "a", tokens: { radius: "huge" } }).join()).toContain("枚举值");
    expect(bad({ name: "a", tokens: { font: 1 } }).join()).toContain("枚举值");
  });

  it("整份清单视角：theme 非法 ⇒ 整份 contributing 被拒；合法 ⇒ 保留 theme", () => {
    const r1 = parsePluginManifest({
      name: "p", version: "1.0.0", description: "d", origin: "agent", provides: ["instructions"],
      contributes: { theme: { name: "a", tokens: { accent: "blue" } } },
    });
    expect(r1.ok).toBe(false);
    const r2 = parsePluginManifest({
      name: "p", version: "1.0.0", description: "d", origin: "agent", provides: ["instructions"],
      contributes: { theme: { name: "暮色青", tokens: { accent: "#2dd4bf" } } },
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) { expect(r2.manifest.contributes?.theme?.name).toBe("暮色青"); }
    // contributes 顶层未知字段依旧被拒（theme 之后也不许拼错）
    expect(parsePluginContributes({ theme: { name: "a", tokens: { accent: "#ffffff" } }, themes: [] }).ok).toBe(false);
  });

  it("摘要：describePluginTheme 给「名字（N 令牌）」", () => {
    expect(describePluginTheme(undefined)).toBe("0");
    expect(describePluginTheme({ name: "青", tokens: { accent: "#2dd4bf", font: "mono" } })).toBe("青（2 令牌）");
  });
});

/* ── B · 令牌 ↔ CSS 变量同源 ─────────────────────────────────────────────── */

describe("A-1198-T ② 令牌映射与 index.css 真变量同源（不同源 = 静默失效）", () => {
  it("每个色彩令牌的变量名在 index.css 里真实存在（作为 :root 定义）", () => {
    for (const token of Object.keys(PLUGIN_THEME_COLOR_VARS) as Array<keyof typeof PLUGIN_THEME_COLOR_VARS>) {
      const v = PLUGIN_THEME_COLOR_VARS[token];
      expect(INDEX_CSS, `index.css 缺变量定义 ${v}（映射表在自说自话）`).toContain(`${v}:`);
    }
  });

  it("字体走 --font-ui：index.css 的 html/body/#root 用 var(--font-ui, 回落)", () => {
    expect(INDEX_CSS).toContain("var(--font-ui,");
  });

  it("themeTokenAssignments：色 → 对应变量；font → --font-ui 预置栈；radius → 四个半径变量", () => {
    const a = themeTokenAssignments({ name: "t", tokens: { accent: "#2dd4bf", text: "#ffffff" } });
    expect(a).toEqual([
      { variable: "--accent", value: "#2dd4bf" },
      { variable: "--text", value: "#ffffff" },
    ]);
    const f = themeTokenAssignments({ name: "t", tokens: { font: "serif" } });
    expect(f).toEqual([{ variable: "--font-ui", value: PLUGIN_THEME_FONT_STACKS.serif }]);
    const r = themeTokenAssignments({ name: "t", tokens: { radius: "sharp" } });
    expect(r.map((x) => x.variable)).toEqual(["--radius-lg", "--radius-md", "--radius-sm", "--radius-bubble"]);
    expect(r[0].value).toBe(PLUGIN_THEME_RADIUS_SCALES.sharp.lg);
  });
});

/* ── C · 回落与落值（可开可关的落点） ─────────────────────────────────────── */

function fakeRoot(): { style: { setProperty(n: string, v: string): void; removeProperty(n: string): void }; written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    style: {
      setProperty: (n, v) => { written.set(n, v); },
      removeProperty: (n) => { written.delete(n); },
    },
  };
}

describe("A-1198-T ③ 生效解析与环境落值（停用即回落、不残留）", () => {
  beforeEach(() => { __resetPluginThemeForTest(); });

  it("resolveActiveTheme：空选择→null；命中→返回；选择失效（插件没了）→null", () => {
    const themes = [{ plugin: "a" }, { plugin: "b" }];
    expect(resolveActiveTheme(themes, "")).toBeNull();
    expect(resolveActiveTheme(themes, "b")).toEqual({ plugin: "b" });
    expect(resolveActiveTheme(themes, "gone")).toBeNull();
  });

  it("applyPluginTheme：落值 / 换成令牌更少的皮肤时旧变量被清理 / null 全清", () => {
    const root = fakeRoot();
    const n1 = applyPluginTheme(
      { name: "t", tokens: { accent: "#111111", bg: "#222222", radius: "round" } },
      root,
    );
    expect(n1).toBe(6); // 2 色 + 4 半径
    expect(root.written.get("--accent")).toBe("#111111");
    expect(root.written.get("--radius-bubble")).toBe(PLUGIN_THEME_RADIUS_SCALES.round.bubble);

    const n2 = applyPluginTheme({ name: "t2", tokens: { accent: "#333333" } }, root);
    expect(n2).toBe(1);
    expect(root.written.get("--accent")).toBe("#333333");
    expect(root.written.has("--bg"), "换皮肤后旧变量必须被清掉（不残留上一个皮肤的组合）").toBe(false);
    expect(root.written.has("--radius-lg")).toBe(false);

    applyPluginTheme(null, root);
    expect(root.written.size, "停用/卸载 ⇒ 一个内联变量都不许剩").toBe(0);
  });
});

/* ── D · 接线（源码形状） ─────────────────────────────────────────────────── */

describe("A-1198-T ④ 接线：host / main / ipc / 渲染层 / 外观页", () => {
  it("host：registerTheme 钩子 + theme 贡献如实登记（卸载可撤销）", () => {
    expect(HOST_SRC).toContain("registerTheme?: (manifest: PluginManifest) => PluginContributionHandle[];");
    expect(HOST_SRC).toContain("if (themeDecl !== undefined) {");
    expect(HOST_SRC).toContain("contributions.push(`theme:${wiring === WIRING_PENDING ? WIRING_PENDING : describePluginTheme(themeDecl)}`);");
  });

  it("main：主题表 + 注册钩子 + 快照 themes + 安装示例通道", () => {
    expect(MAIN_SRC).toContain("const pluginThemeDecls = new Map<string, PluginThemeDecl>();");
    expect(MAIN_SRC).toContain("registerTheme: (manifest) => {");
    expect(MAIN_SRC).toContain("const themes: PluginThemeDTO[] = [...pluginThemeDecls.entries()]");
    /* ⚠️ 2026-10-09 锚点更新（A-1198 · 续：CSS 贡献点）：快照多带了 cssStyles（扩展 CSS 外观），
       返回形状从 `{ slots, themes, warnings }` 变成 `{ slots, themes, cssStyles, warnings }`。 */
    expect(MAIN_SRC).toContain("return { slots: out, themes, cssStyles, warnings: [] };");
    expect(MAIN_SRC).toContain("IPC_CHANNELS.plugins_install_example");
    expect(MAIN_SRC).toContain("const EXAMPLE_PLUGIN_NAME = \"hello-slime\";");
  });

  it("ipc / preload：DTO 带 themes；安装示例通道两端都有", () => {
    expect(IPC_SRC).toContain("themes: PluginThemeDTO[];");
    expect(IPC_SRC).toContain("plugins_install_example: \"slime:plugins:installExample\"");
    expect(PRELOAD_SRC).toContain("pluginsInstallExample:");
    expect(PRELOAD_SRC).toContain("slime:plugins:installExample");
  });

  it("渲染层：App 挂宿主组件；宿主组件做「脏选择清理 + 落值」", () => {
    expect(APP_SRC).toContain("<PluginThemeHost />");
    expect(HOST_COMPONENT_SRC).toContain("resolveActiveTheme(themes, selected)");
    expect(HOST_COMPONENT_SRC).toContain("applyPluginTheme(active, document.documentElement)");
    expect(HOST_COMPONENT_SRC).toContain("setPluginThemeSelection(\"\");");
    expect(HOST_COMPONENT_SRC).toContain("if (loaded && selected && !active) {");
  });

  it("外观页：有「扩展皮肤」选择段（默认 + 各插件 + 空态指引）", () => {
    expect(PANEL_SRC).toContain("扩展皮肤");
    /* ⚠️ 2026-10-09 收窄断言（变异实测存活）：CSS 外观的「互斥」逻辑新增了第二处
       `setPluginThemeSelection("")`（选CSS 时清掉皮肤选择）⇒ anywhere 的 toContain 被它顶上了，
       「默认按钮」的onClick 删掉也照样绿。⇒ 必须**限定在按钮那一行**。 */
    expect(PANEL_SRC).toMatch(/onClick=\{\(\) => setPluginThemeSelection\(""\)\}/);
    expect(PANEL_SRC).toContain("安装示例扩展");
  });
});

/* ── E · 官方示例扩展包 ───────────────────────────────────────────────────── */

describe("A-1198-T ⑤ 官方示例扩展（hello-slime）：结构齐全 + 真能过清单校验", () => {
  it("四件套都在：plugin.json / skills/<技能>/SKILL.md / tools/<脚本>.mjs / 页面 html", () => {
    expect(existsSync(join(ROOT, EXAMPLE_DIR, "plugin.json"))).toBe(true);
    expect(existsSync(join(ROOT, EXAMPLE_DIR, "skills", "hello-slime-guide", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, EXAMPLE_DIR, "tools", "hello.mjs"))).toBe(true);
    expect(existsSync(join(ROOT, EXAMPLE_DIR, "panel.html"))).toBe(true);
  });

  it("plugin.json 真过 parsePluginManifest（能装载的最强证明；名字与目录同名）", () => {
    const raw = JSON.parse(read(`${EXAMPLE_DIR}/plugin.json`)) as Record<string, unknown>;
    const r = parsePluginManifest(raw);
    expect(r.ok, r.ok ? "" : ((r as { errors: string[] }).errors.join("；"))).toBe(true);
    if (!r.ok) { return; }
    expect(r.manifest.name).toBe("hello-slime");
    expect(r.manifest.provides).toContain("instructions");
    expect(r.manifest.provides).toContain("mode");
    const c = r.manifest.contributes;
    expect(c?.settings?.length).toBeGreaterThan(0);
    expect(c?.ui?.length).toBe(4);
    expect(c?.scripts?.length).toBe(1);
    expect(c?.page?.kind).toBe("html");
    expect(c?.theme?.name).toBeTruthy();
    expect(r.manifest.mode?.kind).toBe("stages");
  });

  it("SKILL.md frontmatter 含 name / description（照 SkillRegistry 载入口径）", () => {
    const md = read(`${EXAMPLE_DIR}/skills/hello-slime-guide/SKILL.md`);
    expect(md.startsWith("---")).toBe(true);
    expect(md).toMatch(/name:\s*hello-slime-guide/);
    expect(md).toMatch(/description:\s*\S/);
  });

  it("示例页面自包含：不依赖任何外部资源（离线可用）", () => {
    const html = read(`${EXAMPLE_DIR}/panel.html`);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("fetch(\"./plugin.json\")");
  });

  it("随包打包与播种：extraFiles 含 template/plugins；boot 里 bootstrapPlugins 被调用", () => {
    expect(BUILDER_JSON).toContain("\"template/plugins\"");
    expect(BOOT_SRC).toContain("function bootstrapPlugins(): void {");
    expect(BOOT_SRC.match(/bootstrapPlugins\(\);/g)?.length).toBeGreaterThanOrEqual(2); // packaged + dev 两条路径
  });
});
