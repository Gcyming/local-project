/**
 * tests/core-ts/a1200-plugin-regions.spec.ts — **A-1200 · B1（区域注册表 + panel 形态）**的守卫。
 *
 * ## 用户口径（本批要解的主诉，原话）
 * 「我要插件可以任意定制的……外观市场都给用户做出来了，甚至能自定义主题；
 *   还有另一类，自己做功能，还配备专门的 UI。这些都可以出现，为什么我的 slime 不行？」
 * ⇒ 差距被拆成两件：① 只能挂 **4 个固定槽位**；② 只能**声明式**（宿主渲染 label/icon），
 *   不能**自带完整 UI**。本批把①升级成 **13 个区域**、把②扩出 **panel 形态**。
 *
 * ## 这一层在防什么（四条护栏，逐条都有对应的真实失效场景）
 *   ① **区域名不认识 ⇒ 整份拒**。不拒就是「装载了但看不见」—— 用户查不出为什么自己
 *     声明的按钮不出现，而本项目的判据是「能配但没生效= 陷阱」。
 *   ② **entry 的纯相对校验**。panel 的 entry 会拼进 `127.0.0.1` 静态服务的 url；
 *     放行 `../../` 或盘符就等于**爬出插件目录**（能读到别的插件/用户目录的文件）。
 *     ⇒ 与 `contributes.page.entry` 同款口径（`validateRelativeEntry`），**两侧不许两套判据**。
 *   ③ **形态-区域兼容**。`overlay_*` 只接panel（item挂上去永远不显示 ⇒ 假自由度）；
 *     `settings_panel` 只接 item（既有整页形态，改成 panel 会出现两套互斥渲染路径）。
 *   ④ **向后兼容**：一个只用既有 4 槽位的老清单走 `parsePluginManifest` **必须照常通过**
 *     —— `kind` 缺省 = `item` 是这条兼容的实现手段（不是"大概能跑"）。
 *
 * ## 为什么还有第⑤类（源码形状锁）
 * 渲染层没有组件测试环境（项目惯例：形状断言 + 变异）。声明校验全绿但**界面没接线**，
 * 用户看到的仍然是「说了不算」—— 所以把「13 个区域各自在哪个文件被挂上」钉成源码断言。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PLUGIN_UI_KINDS,
  PLUGIN_UI_REGIONS,
  PLUGIN_UI_REGION_KINDS,
  PLUGIN_UI_SLOTS,
  describePluginUi,
  isPluginUiRegionKind,
  parsePluginContributes,
  parsePluginUiSlots,
  type PluginUiRegion,
} from "../../core-ts/src/plugin/contributes.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");

/** 13 个区域的**期望名单**（守卫自己写一份，而不是从常量表推 ——
 *  否则「常量表少一个区域」这条变异会同时改掉判据 ⇒ 假绿）。 */
const EXPECTED_REGIONS: readonly string[] = [
  "settings_panel", "status_item", "chat_action", "toolbar_item",
  "titlebar_start", "titlebar_end",
  "chat_input_leading", "chat_input_trailing", "chat_message_actions",
  "sidebar_section", "status_bar",
  "overlay_floating", "overlay_fullscreen",
];

/** item 形态在各区域要带的必填字段（settings_panel 用 title，其余用 label）。
 *  ⚠️ `id` 必须匹配 `PLUGIN_NAME_PATTERN`（小写字母数字 + `-` 分隔，**不含下划线**）——
 *     这里用区域名里的 `_` 换成 `-`，否则用例会因「id 不合法」被拒，而那测的不是本条判据。 */
const itemDecl = (region: string, extra: Record<string, unknown> = {}): Record<string, unknown> => (
  region === "settings_panel"
    ? { slot: region, id: `i-${region.replace(/_/g, "-")}`, title: "标题", ...extra }
    : {
      slot: region,
      id: `i-${region.replace(/_/g, "-")}`,
      label: "条目",
      ...(region === "status_item" ? { refresh: "manual" } : {}),
      ...extra,
    }
);

/** panel 形态在各区域要带的字段（entry 必填）。 */
const panelDecl = (region: string, entry = "panel.html", extra: Record<string, unknown> = {}): Record<string, unknown> => (
  { slot: region, id: `p-${region.replace(/_/g, "-")}`, kind: "panel", entry, ...extra }
);

describe("A-1200-R ① 13 个区域 + 形态兼容表（声明面与守卫面必须同一张表）", () => {
  it("区域清单恰好 13 个，且既有 4 个名字**原样在前四位**（向后兼容的锚）", () => {
    expect([...PLUGIN_UI_REGIONS]).toEqual(EXPECTED_REGIONS);
    expect(PLUGIN_UI_REGIONS.length).toBe(13);
    /* 前四个必须与 A-1197 · B2/B5 的槽位名逐字相同 —— 老插件的 plugin.json 不改一个字。 */
    expect(PLUGIN_UI_REGIONS.slice(0, 4)).toEqual(["settings_panel", "status_item", "chat_action", "toolbar_item"]);
  });

  it("`PLUGIN_UI_SLOTS` 是 `PLUGIN_UI_REGIONS` 的**别名**（同一数组，不是两份会漂移的副本）", () => {
    /* 为什么要别名：一次性改爆所有调用方（渲染层/ 守卫 / 变异脚本都按这个名字打锚点）
       收益为零、风险全在。判据是「同一身份」—— 不是「值相等」（值相等但两份改就会漂移）。 */
    expect(PLUGIN_UI_SLOTS).toBe(PLUGIN_UI_REGIONS);
    expect([...PLUGIN_UI_SLOTS]).toEqual(EXPECTED_REGIONS);
  });

  it("形态枚举只有 item / panel 两个（缺省即 item）", () => {
    expect([...PLUGIN_UI_KINDS]).toEqual(["item", "panel"]);
  });

  it("兼容表覆盖全部 13 个区域（漏一个区域 = 那个区域的所有声明都会被 `?? []` 拒）", () => {
    const tableKeys = Object.keys(PLUGIN_UI_REGION_KINDS).sort();
    expect(tableKeys).toEqual([...EXPECTED_REGIONS].sort());
    for (const region of EXPECTED_REGIONS) {
      const allowed = PLUGIN_UI_REGION_KINDS[region as PluginUiRegion];
      expect(Array.isArray(allowed) && allowed.length > 0, `区域 ${region} 的形态列表为空`).toBe(true);
    }
  });

  it("形态-区域兼容：overlay_* 只收 panel；settings_panel 只收 item；sidebar_section 两种都收", () => {
    expect(PLUGIN_UI_REGION_KINDS.overlay_floating).toEqual(["panel"]);
    expect(PLUGIN_UI_REGION_KINDS.overlay_fullscreen).toEqual(["panel"]);
    expect(PLUGIN_UI_REGION_KINDS.settings_panel).toEqual(["item"]);
    expect([...PLUGIN_UI_REGION_KINDS.sidebar_section].sort()).toEqual(["item", "panel"]);
    /* 其余区域两种都收（逐个断言，不用"其余都…"糊过去）。 */
    for (const region of ["status_item", "chat_action", "toolbar_item", "titlebar_start", "titlebar_end",
      "chat_input_leading", "chat_input_trailing", "chat_message_actions", "status_bar"]) {
      expect([...PLUGIN_UI_REGION_KINDS[region as PluginUiRegion]].sort(), `区域 ${region}`).toEqual(["item", "panel"]);
    }
  });

  it("isPluginUiRegionKind：区域名不认识时返回 false（不静默放行）", () => {
    expect(isPluginUiRegionKind("sidebar_section", "panel")).toBe(true);
    expect(isPluginUiRegionKind("overlay_floating", "item")).toBe(false);
    expect(isPluginUiRegionKind("not_a_region", "panel")).toBe(false);
    expect(isPluginUiRegionKind("not_a_region", "item")).toBe(false);
  });

  it("每个区域都能真的声明成功（item 形态 13/13；overlay 的 panel 形态也合法）", () => {
    for (const region of EXPECTED_REGIONS) {
      const kinds = PLUGIN_UI_REGION_KINDS[region as PluginUiRegion];
      for (const kind of kinds) {
        const raw = kind === "panel" ? panelDecl(region) : itemDecl(region);
        const r = parsePluginUiSlots([raw]);
        expect(r.ok, `区域 ${region} 形态 ${kind} 应通过：${r.ok ? "" : r.errors.join("；")}`).toBe(true);
        if (r.ok) { expect(r.ui[0].kind ?? "item").toBe(kind); }
      }
    }
  });

  it("describePluginUi：panel 单独计数（扩展页要能看出「几条是自带 UI 的」）", () => {
    const s = describePluginUi([
      { slot: "status_item", id: "a", label: "x", refresh: "manual" },
      { slot: "sidebar_section", id: "b", kind: "panel", entry: "p.html" },
    ]);
    expect(s).toContain("status_item×1");
    expect(s).toContain("sidebar_section(panel)×1");
  });
});

describe("A-1200-R ② panel 的 entry 校验（逃逸防护，与 page 同款口径）", () => {
  const rejectPanel = (entry: unknown): string[] => {
    const r = parsePluginUiSlots([{ slot: "sidebar_section", id: "p", kind: "panel", entry }]);
    expect(r.ok, `预期拒绝但被放行：${JSON.stringify(entry)}`).toBe(false);
    return r.ok ? [] : r.errors;
  };

  it("entry 必填（缺了起不了服务 = 假声明）", () => {
    const r = parsePluginUiSlots([{ slot: "sidebar_section", id: "p", kind: "panel" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("entry"); }
  });

  it("entry 不许含 `..` 段（爬出插件目录就能读到别的插件/用户文件）", () => {
    /* ⚠️ 每条反例必须**只触发它自己那一条** —— 若样例里还带盘符/`..` 之外的写法，
       删掉其中一条校验后它仍被另一条挡住 ⇒ 守卫照样绿而变异存活（等价变异）。 */
    expect(rejectPanel("../../evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("..")]));
    expect(rejectPanel("a/../../evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("..")]));
    expect(rejectPanel("..\\evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("..")]));
  });

  it("entry 不许盘符 / UNC / 以分隔符开头（不是纯相对路径）", () => {
    expect(rejectPanel("C:\\evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("盘符")]));
    expect(rejectPanel("c:/evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("盘符")]));
    expect(rejectPanel("\\\\server\\share\\evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("盘符")]));
    expect(rejectPanel("/etc/passwd")).toEqual(expect.arrayContaining([expect.stringContaining("分隔符开头")]));
    expect(rejectPanel("\\windows\\system32")).toEqual(expect.arrayContaining([expect.stringContaining("分隔符开头")]));
  });

  it("entry 不许空串 / 纯空白 / 含NUL", () => {
    expect(rejectPanel("")).toEqual(expect.arrayContaining([expect.stringContaining("不能为空")]));
    expect(rejectPanel("   ")).toEqual(expect.arrayContaining([expect.stringContaining("不能为空")]));
    expect(rejectPanel("a\u0000b.html")).toEqual(expect.arrayContaining([expect.stringContaining("NUL")]));
  });

  it("合法 entry 放行（纯相对，含子目录）", () => {
    for (const entry of ["panel.html", "ui/panel.html", "a/b/c.html", "./panel.html"]) {
      const r = parsePluginUiSlots([panelDecl("sidebar_section", entry)]);
      expect(r.ok, `应放行：${entry} —— ${r.ok ? "" : r.errors.join("；")}`).toBe(true);
      if (r.ok) { expect(r.ui[0].entry).toBe(entry.trim()); }
    }
  });

  it("panel 的可选文案（label / title）走长度上限；refresh / when 一律拒（描述的是宿主行为）", () => {
    expect(parsePluginUiSlots([panelDecl("sidebar_section", "p.html", { label: "文件树" })]).ok).toBe(true);
    expect(parsePluginUiSlots([panelDecl("sidebar_section", "p.html", { label: "x".repeat(81) })]).ok).toBe(false);
    expect(parsePluginUiSlots([panelDecl("sidebar_section", "p.html", { title: "x".repeat(81) })]).ok).toBe(false);
    const errs = (() => {
      const r = parsePluginUiSlots([panelDecl("sidebar_section", "p.html", { refresh: "manual" })]);
      return r.ok ? [] : r.errors;
    })();
    expect(errs.join("；")).toContain("无意义");
    const errs2 = (() => {
      const r = parsePluginUiSlots([panelDecl("sidebar_section", "p.html", { when: "总是" })]);
      return r.ok ? [] : r.errors;
    })();
    expect(errs2.join("；")).toContain("无意义");
  });
});

describe("A-1200-R ③ kind 的对称校验（item 写了 entry 拒/ kind 拼错拒）", () => {
  it("kind 只认 item / panel；拼错一律拒（不静默当 item）", () => {
    for (const bad of ["iframe", "webview", "Item", "panel ", "", 42, true]) {
      const r = parsePluginUiSlots([{ slot: "status_item", id: "x", label: "x", refresh: "manual", kind: bad }]);
      expect(r.ok, `kind=${JSON.stringify(bad)} 应被拒`).toBe(false);
    }
  });

  it("`kind: \"item\"` 写了 entry ⇒ 拒（声明了但没人用 = 假自由度）", () => {
    const r = parsePluginUiSlots([{ slot: "status_item", id: "x", label: "x", refresh: "manual", entry: "p.html" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("entry"); }
  });

  it("`kind` 缺省 = item（此时写 entry 同样拒 —— 缺省形态不许开后门）", () => {
    const r = parsePluginUiSlots([{ slot: "chat_action", id: "x", label: "x", entry: "p.html" }]);
    expect(r.ok).toBe(false);
  });
});

describe("A-1200-R ④ overlay_* 只收 panel（item 挂上去永远不显示）", () => {
  it("item 形态声明 overlay_floating / overlay_fullscreen ⇒ 整份拒（不静默装载但看不见）", () => {
    for (const region of ["overlay_floating", "overlay_fullscreen"]) {
      const r = parsePluginUiSlots([{ slot: region, id: "hud", label: "HUD" }]);
      expect(r.ok, `区域 ${region} 不该接受 item`).toBe(false);
      if (!r.ok) { expect(r.errors.join("；")).toContain("不接受形态"); }
      /* 面板形态在同一区域必须能过（否则就是"这个区域没法用"）。 */
      expect(parsePluginUiSlots([panelDecl(region)]).ok, `区域 ${region} 应接受 panel`).toBe(true);
    }
  });

  it("settings_panel 只收 item（改成 panel 会让同一区域有两套互斥渲染路径）", () => {
    const r = parsePluginUiSlots([panelDecl("settings_panel")]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("不接受形态"); }
  });
});

describe("A-1200-R ⑤ 区域名不认识 ⇒ 拒（不许静默装载但看不见）", () => {
  const rejectRegion = (slot: unknown): string[] => {
    const r = parsePluginUiSlots([{ slot, id: "x", label: "x" }]);
    expect(r.ok, `区域 ${JSON.stringify(slot)} 应被拒`).toBe(false);
    return r.ok ? [] : r.errors;
  };

  it("未知区域名 / 拼错 / 大写 / 非字符串 ⇒ 拒", () => {
    for (const bad of ["sidebar", "sidebar-section", "titlebar", "TITLEBAR_START", "unknown_slot", "", 42, null, undefined]) {
      rejectRegion(bad);
    }
  });

  it("少了区域名 ⇒ 拒，且错误文案里列出全部 13 个（写错的人能照着改）", () => {
    const r = parsePluginUiSlots([{ id: "x", label: "x" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.errors.join("；");
      expect(text).toContain("slot");
      for (const region of EXPECTED_REGIONS) { expect(text, `错误文案漏了区域 ${region}`).toContain(region); }
    }
  });

  it("区域名不认识时**不会**被当成 panel 放行（形态兼容表查不到 ⇒ 一律拒）", () => {
    const r = parsePluginUiSlots([{ slot: "overlay_typod", id: "x", kind: "panel", entry: "p.html" }]);
    expect(r.ok).toBe(false);
  });
});

describe("A-1200-R ⑥ 向后兼容：老清单（4 槽位 / 不写 kind）零改动照常通过", () => {
  it("一个只用了既有 4 槽位的老清单走 parsePluginManifest 必须通过，且形态全落item", () => {
    const legacy = {
      name: "legacy-plugin",
      version: "1.0.0",
      description: "只用既有四个槽位的老插件",
      origin: "user",
      provides: ["instructions"],
      contributes: {
        ui: [
          { slot: "settings_panel", id: "panel", title: "专属设置页" },
          { slot: "status_item", id: "count", label: "计数", refresh: "on_event" },
          { slot: "chat_action", id: "run", label: "用本扩展处理", when: "总是" },
          { slot: "toolbar_item", id: "open", label: "打开面板" },
        ],
        page: { kind: "html", entry: "panel.html" },
      },
    };
    const r = parsePluginManifest(legacy);
    expect(r.ok, `老清单应照常通过：${r.ok ? "" : r.errors.join("；")}`).toBe(true);
    if (!r.ok) { return; }
    const ui = r.manifest.contributes?.ui ?? [];
    expect(ui).toHaveLength(4);
    for (const item of ui) {
      expect(item.kind, `${item.slot} 的形态`).toBeUndefined();
      expect(item.entry, `${item.slot} 不该有 entry`).toBeUndefined();
    }
  });

  it("单 theme / page / css 的老组合仍照常通过（本批没动它们）", () => {
    const r = parsePluginManifest({
      name: "legacy-look",
      version: "1.0.0",
      description: "单 theme + page + css",
      origin: "user",
      provides: ["instructions"],
      contributes: {
        page: { kind: "html", entry: "panel.html" },
        theme: { name: "暮色", tokens: { accent: "#2dd4bf" } },
        css: { name: "紧凑", css: ".card { border-radius: 18px; }" },
      },
    });
    expect(r.ok, r.ok ? "" : r.errors.join("；")).toBe(true);
  });

  it("未知字段仍拒（契约面不放行 —— 加了 kind/entry 不等于开了「随便写」的闸门）", () => {
    const r = parsePluginContributes({ ui: [{ slot: "status_item", id: "x", label: "x", refresh: "manual", script: "e.js" }] });
    expect(r.ok).toBe(false);
  });

  it("同插件内 panel 与 item 可以共存（形态是**每条声明**的属性，不是每插件的属性）", () => {
    const r = parsePluginUiSlots([
      { slot: "status_item", id: "a", label: "计数", refresh: "manual" },
      panelDecl("sidebar_section"),
      { slot: "titlebar_end", id: "b", label: "测延迟" },
    ]);
    expect(r.ok, r.ok ? "" : r.errors.join("；")).toBe(true);
    if (r.ok) {
      expect(r.ui.filter((u) => u.kind === "panel")).toHaveLength(1);
      expect(r.ui.filter((u) => (u.kind ?? "item") === "item")).toHaveLength(2);
    }
  });

  it("同插件内 id 仍全局去重（panel 与 item 共用一个 id 空间）", () => {
    const r = parsePluginUiSlots([
      { slot: "status_item", id: "dup", label: "x", refresh: "manual" },
      panelDecl("sidebar_section", "p.html", { id: "dup" }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("重复"); }
  });

  it("清单顶层报错时整份 rejected（fail-closed：不静默丢单个字段）", () => {
    const r = parsePluginContributes({
      ui: [
        { slot: "status_item", id: "ok", label: "x", refresh: "manual" },
        panelDecl("overlay_floating", "../../evil.html"),
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain(".."); }
  });
});

describe("A-1200-R ⑦ 接线锁：13 个区域真的挂在界面上（声明了不接线 = 说了不算）", () => {
  const slotHost = read("gui/src/renderer/components/UiSlotHost.tsx");
  const app = read("gui/src/renderer/App.tsx");
  const chat = read("gui/src/renderer/pages/ChatPanel.tsx");
  const sidebar = read("gui/src/renderer/pages/RightSidebar.tsx");
  const status = read("gui/src/renderer/pages/StatusPanel.tsx");

  it("区域→渲染器映射表覆盖全部 13 个区域（漏一个 = 那个区域永远走「尚未接线」）", () => {
    /* 从**映射表对象**里取键，而不是 grep 全文 —— 注释里出现区域名不算接线。 */
    const seg = /export const UI_SLOT_RENDERERS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(slotHost);
    expect(seg, "UiSlotHost 里找不到 UI_SLOT_RENDERERS 表").not.toBeNull();
    const keys = [...seg![1].matchAll(/^\s*([a-z_]+):/gm)].map((x) => x[1]);
    expect(keys.sort()).toEqual([...EXPECTED_REGIONS].sort());
  });

  it("标题栏两端挂在 App.tsx 的真实 titlebar 里", () => {
    expect(app).toMatch(/import \{[^}]*PluginTitlebarItems[^}]*\} from "\.\/components\/UiSlotHost\.js"/);
    expect(app).toMatch(/<PluginTitlebarItems region="titlebar_start" \/>/);
    expect(app).toMatch(/<PluginTitlebarItems region="titlebar_end" \/>/);
    /* 必须落在 header.titlebar 内（挂到别处就是「有声明没落点」）。 */
    const bar = /<header className="titlebar">([\s\S]*?)<\/header>/.exec(app);
    expect(bar, "App.tsx 里找不到 header.titlebar").not.toBeNull();
    expect(bar![1]).toContain('region="titlebar_start"');
    expect(bar![1]).toContain('region="titlebar_end"');
  });

  it("两个 overlay 区域挂在 App.tsx 根部（与 PluginThemeHost 同级 ⇒ 全屏生效）", () => {
    expect(app).toMatch(/<PluginOverlayFloating \/>/);
    expect(app).toMatch(/<PluginOverlayFullscreen \/>/);
    /* 全屏容器必须 fixed + inset:0 + pointer-events:none（三条缺一就不是"全屏自由定位"）。 */
    const seg = /data-slime-plugin-overlay="floating"[\s\S]*?style=\{\{([\s\S]*?)\}\}/.exec(slotHost);
    expect(seg, "UiSlotHost 里找不到 floating 浮层容器").not.toBeNull();
    expect(seg![1]).toContain('position: "fixed"');
    expect(seg![1]).toContain("inset: 0");
    expect(seg![1]).toContain('pointerEvents: "none"');
    /* 面板自身要开 pointer-events:auto，否则整个界面变死区。 */
    expect(slotHost).toMatch(/pointerEvents: "auto"/);
  });

  it("浮层 z-index 低于对话框 backdrop（盖不掉权限确认等安全关键 UI）", () => {
    /* 1100 < 1200（`.dlg-backdrop`）；判据是**两个常量同时出现**，
       单看 1100 说不清它与对话框的关系。 */
    const m = /const PLUGIN_OVERLAY_Z = (\d+);/.exec(slotHost);
    expect(m, "UiSlotHost 里找不到 PLUGIN_OVERLAY_Z").not.toBeNull();
    expect(Number(m![1])).toBeLessThan(1200);
    expect(Number(m![1])).toBeGreaterThan(1000);
    const css = read("gui/src/renderer/index.css");
    expect(css).toMatch(/\.dlg-backdrop \{[\s\S]*?z-index: 1200;/);
  });

  it("输入栏两端 + 消息动作区挂在 ChatPanel 的真实位置", () => {
    expect(chat).toMatch(/<PluginChatInputLeading onInsert=\{\(t\) => setInput\(\(v\) => \(v \? `\$\{v\} \$\{t\}` : t\)\)\} \/>/);
    expect(chat).toMatch(/<PluginChatInputTrailing onInsert=\{\(t\) => setInput\(\(v\) => \(v \? `\$\{v\} \$\{t\}` : t\)\)\} \/>/);
    /* 消息动作区挂在 hover 动作行里（`.msg-hover`），两处（用户消息 + 助手消息）。
       判据是「`.msg-hover` 开标签到它的 `</div>` 之间真的有 <PluginMessageActions />」——
       只 grep 全文会被"挂在别处也算"的写法喂饱。 */
    const withActions = [...chat.matchAll(/className="msg-hover"[\s\S]*?<\/div>/g)]
      .filter((m) => m[0].includes("<PluginMessageActions />"));
    expect(withActions.length, "挂在 .msg-hover 动作行里的消息动作区").toBeGreaterThanOrEqual(2);
  });

  it("跨组件的「插入输入框」通道两端都在（否则标题栏/消息动作按钮是假按钮）", () => {
    /* 发端：UiSlotHost 的 requestPluginInsertInput（App.tsx / memo 子组件够不到 setInput）。 */
    expect(slotHost).toContain('export const PLUGIN_INSERT_INPUT_EVENT = "slime:plugin-insert-input"');
    expect(slotHost).toMatch(/window\.dispatchEvent\(new CustomEvent<string>\(PLUGIN_INSERT_INPUT_EVENT/);
    /* 收端：ChatPanel 监听并落进setInput。 */
    expect(chat).toContain("PLUGIN_INSERT_INPUT_EVENT");
    expect(chat).toMatch(/window\.addEventListener\(PLUGIN_INSERT_INPUT_EVENT, onInsert\)/);
    expect(chat).toMatch(/window\.removeEventListener\(PLUGIN_INSERT_INPUT_EVENT, onInsert\)/);
  });

  it("sidebar_section 挂在右栏，status_bar 挂在StatusPanel 底部", () => {
    expect(sidebar).toMatch(/import \{ PluginSidebarSections \} from "\.\.\/components\/UiSlotHost\.js"/);
    expect(sidebar).toMatch(/<PluginSidebarSections \/>/);
    /* 必须落在 `<aside>` 内、`.right-body` 之外（否则会被当前页签的显隐带着消失）。 */
    const aside = /<aside[\s\S]*?<\/aside>/.exec(sidebar);
    expect(aside, "RightSidebar 里找不到 aside").not.toBeNull();
    expect(aside![0]).toContain("<PluginSidebarSections />");
    expect(status).toMatch(/import \{[^}]*PluginStatusBarItems[^}]*\} from "\.\.\/components\/UiSlotHost\.js"/);
    expect(status).toMatch(/<PluginStatusBarItems \/>/);
  });

  it("panel 走沙箱 iframe（与 PluginPageTab 同一套隔离口径），url 只由主进程给", () => {
    expect(slotHost).toContain('const PANEL_SANDBOX = "allow-scripts allow-same-origin allow-forms"');
    expect(slotHost).toMatch(/sandbox=\{PANEL_SANDBOX\}/);
    /* url **只能**由主进程给：通道名取自 extras，实际调用是 `open(plugin, entry)`
       （`open` 就是上面从 extras 取出的那个函数引用）。 */
    expect(slotHost).toMatch(/const open = a\?\.extras\?\.pluginsPanelOpen;/);
    expect(slotHost).toMatch(/await \(open\(plugin, entry\)/);
    /* ⚠️⚠️ 取 url 失败的**两条分支都要出声**（res 不 ok / 抛异常），且两条断言的窗口
       必须**各自只能匹配自己那条分支** —— 两条「面板加载失败」相隔仅约 250 字符，窗口放宽
       就会「第一条被删时第二条仍被匹配」⇒ 守卫假绿（M13 首轮存活就是这么来的）。
       ⇒ 每条都把中间的分隔符（else 分支 / catch 分支）写进模式：少了它就不可能跨到另一条。 */
    expect(slotHost).toMatch(
      /if \(res\?\.ok && res\.url\) \{[\s\S]{0,200}?\} else \{[\s\S]{0,80}?setState\(\{ url: "", error: `面板加载失败/,
    );
    expect(slotHost).toMatch(
      /\} catch \(e\) \{[\s\S]{0,200}?setState\(\{ url: "", error: `面板加载失败/,
    );
    /* 「加载中」占位也要在：否则取 url 期间是**空白**（用户以为区域坏了）。 */
    expect(slotHost).toMatch(/loading \|\| !url[\s\S]{0,300}?面板加载中/);
  });

  it("主进程：快照带 kind/entry；panel_open 复用 httpServer 且只信已校验的声明", () => {
    const main = read("gui/src/main/index.ts");
    expect(main).toMatch(/kind: d\.kind \?\? "item"/);
    expect(main).toMatch(/\.\.\.\(d\.kind === "panel" \? \{ entry: d\.entry \} : \{\}\)/);
    const seg = /IPC_CHANNELS\.plugins_panel_open[\s\S]*?\n  \}\);/.exec(main);
    expect(seg, "main 里找不到 plugins_panel_open handler").not.toBeNull();
    const body = seg![0];
    expect(body).toMatch(/httpServer\.serve\(\{ dir, host: "127\.0\.0\.1", origin: "agent" \}\)/);
    /* url 必须由「声明里的 entry」拼出来，不是入参那个字符串。 */
    expect(body).toMatch(/pluginUiDecls\.get\(name\)/);
    expect(body).toMatch(/panels\[0\]\.entry!/);
    /* 绝不 file://（§5.4）。 */
    expect(body).not.toContain("file://");
  });

  it("preload 暴露了 panel 通道（渲染层拿不到它就是「声明了永不生效」）", () => {
    const preload = read("gui/src/preload/index.ts");
    expect(preload).toContain("pluginsPanelOpen:");
    expect(preload).toContain('"slime:plugins:panelOpen"');
    const ipc = read("gui/src/shared/ipc.ts");
    expect(ipc).toMatch(/plugins_panel_open: "slime:plugins:panelOpen"/);
  });

  it("绝不把插件代码注入宿主页面（不走 DSH 的模块加载器路线）", () => {
    /* ⚠️ 判据按**代码形态**写（`new Function(` / `eval(` / `innerHTML` 注入），
       不按注释字面：本文件与UiSlotHost 的注释里**会**出现 DSH 那个机制的名字
       （说明"我们不走它"），按字面断言会把自己写的说明当成违规 ⇒ 假红。 */
    for (const f of [slotHost, app, read("gui/src/shared/ipc.ts")]) {
      expect(f, "渲染层出现了 DSH 式动态求值注入").not.toMatch(/new Function\(|eval\(/);
    }
    /* panel 的落点必须是 iframe（结构上隔离），不是宿主 DOM。 */
    expect(slotHost).toMatch(/<iframe/);
  });
});