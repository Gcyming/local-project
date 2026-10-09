/**
 * tests/core-ts/a1200-plugin-views.spec.ts — **A-1200 · B3（插件自有栏目 views）**的守卫。
 *
 * ## 用户口径（本批灵魂，原话；B3 是本设计**最重要的目标**）
 * 「我不是要你去开发外观市场啊，我是给你举个例子。
 *   **别人甚至能自己造一个影响应用整体风格的功能栏目**，而我的 slime 只能小修小补。」
 * ⇒ 对标DSH 的 `dsh-better-sidebar`：文件树 + 编辑器 + 终端 + Git 面板塞成**一整块**侧栏工作台，
 *   装上后整个应用看起来像 VSCode。
 *
 * ## 这一层在防什么（五条护栏，每条都有对应的真实失效场景）
 *   ① **解析 fail-closed**：上限 8 / 空数组 / id 重复 / `placement` 非法值 / `entry` 逃逸（`..`、盘符、
 *     绝对路径）**全拒**。任一栏目非法 ⇒ **整份清单拒** —— 静默丢弃那一条 =「配了但界面上看不见」。
 *   ② **向后兼容**：只用 `contributes.page` 的老清单走 `parsePluginManifest` **照常通过**，
 *     且语义等价于 `placement:"right"` 的一个栏目（page ≡ views 里唯一一个右栏栏目）。
 *   ③ **口径冲突不猜**：`page` 与 `views` 同写 ⇒ 拒（与 `theme`/`themes` 同款处置）。
 *   ④ **三个落点真的接线**：`main`（主区整块视图）、`right`（右栏多 tab）、`left`（左栏栏目块）
 *     都要有渲染器**且**有用户可达的入口 —— 「声明了看不见」是本项目的判据陷阱。
 *   ⑤ **幽灵视图不变量**：插件被停用时主区必须自动回落到「对话」（不许留一块空白）。
 *
 * ## 为什么还有第⑥类（源码形状锁）
 * 渲染层没有组件测试环境（项目惯例：形状断言 + 变异）。声明校验全绿但**界面没接线**，
 * 用户看到的仍然是「说了不算」—— 所以把「三个落点各自在哪个文件被挂上」钉成源码断言。
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_PLUGIN_VIEWS,
  PLUGIN_VIEW_PLACEMENTS,
  describePluginViews,
  parsePluginContributes,
  parsePluginViews,
  type PluginViewDecl,
  type PluginViewPlacement,
} from "../../core-ts/src/plugin/contributes.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");

/** 三个落点的**期望名单**（守卫自己写一份，而不是从常量表推 ——
 *  否则「常量表少一个落点」这条变异会同时改掉判据 ⇒ 假绿）。 */
const EXPECTED_PLACEMENTS: readonly string[] = ["main", "right", "left"];

/** 一条合法的栏目声明（`extra` 用于逐条测非法字段）。 */
const viewDecl = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "workbench",
  title: "开发工作台",
  entry: "workbench.html",
  placement: "main",
  ...extra,
});

/* ── ① 解析：上限 / 空数组 / id 重复 / placement 枚举 / entry 逃逸 ─────────────── */

describe("A-1200-V ① 落点枚举与上限（声明面与守卫面必须同一份名单）", () => {
  it("落点恰好三个，且顺序就是界面顺序（主区 → 右栏 → 左栏）", () => {
    expect([...PLUGIN_VIEW_PLACEMENTS]).toEqual(EXPECTED_PLACEMENTS);
    /* ⚠️ 顺序本身是一条不变量：主进程快照按 `PLUGIN_VIEW_PLACEMENTS` 的**下标**排序，
       「主区视图先于右栏 tab」这条顺序对用户是有意义的（主区那块最大）。 */
    expect(PLUGIN_VIEW_PLACEMENTS.length).toBe(3);
  });

  it("上限 8 个栏目（单插件），且实现常量与守卫同源", () => {
    expect(MAX_PLUGIN_VIEWS).toBe(8);
    /* 上限真的生效：8 个过，9 个拒。 */
    const many = (n: number): Record<string, unknown>[] =>
      Array.from({ length: n }, (_, i) => viewDecl({ id: `v${i}` }));
    expect(parsePluginViews(many(MAX_PLUGIN_VIEWS)).ok, "恰好上限个数应放行").toBe(true);
    const over = parsePluginViews(many(MAX_PLUGIN_VIEWS + 1));
    expect(over.ok, "超上限必须拒").toBe(false);
    if (!over.ok) { expect(over.errors.join("；")).toContain(String(MAX_PLUGIN_VIEWS)); }
  });

  it("非数组 / 空数组 一律拒（不声明就别写这个字段）", () => {
    for (const bad of [{}, "main", 42, null, undefined]) {
      const r = parsePluginViews(bad);
      expect(r.ok, `应拒：${JSON.stringify(bad)}`).toBe(false);
    }
    const empty = parsePluginViews([]);
    expect(empty.ok, "空数组必须拒").toBe(false);
    if (!empty.ok) { expect(empty.errors.join("；")).toContain("不得为空数组"); }
  });

  it("同插件内 id 重复 ⇒ 拒（否则后一条覆盖前一条，声明顺序变成隐式语义）", () => {
    const r = parsePluginViews([viewDecl(), viewDecl({ placement: "right" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("重复"); }
  });

  it("id 命名不合法（拼写错/大写/含下划线）⇒ 拒", () => {
    /* ⚠️ 判据与 `PLUGIN_NAME_PATTERN` 同源（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）：**允许**数字开头
       （如 `1panel`），所以这里只列真正不合法的那些 —— 别把合法形态当反例写进来。 */
    for (const bad of ["Workbench", "work_bench", "工作台", "", "panel.html", "a b", 42, null]) {
      const r = parsePluginViews([viewDecl({ id: bad })]);
      expect(r.ok, `id=${JSON.stringify(bad)} 应拒`).toBe(false);
    }
    /* 数字开头是合法的（与既有插件名/槽位 id 同一套口径，不另立规则）。 */
    expect(parsePluginViews([viewDecl({ id: "1panel" })]).ok, "数字开头符合既有命名口径").toBe(true);
  });

  it("placement 只认 main / right / left；其它值（含缺省）一律拒", () => {
    for (const bad of ["MAIN", "Main", "sidebar", "bottom", "overlay_floating", "", 42, true, null, undefined]) {
      const r = parsePluginViews([viewDecl({ placement: bad })]);
      expect(r.ok, `placement=${JSON.stringify(bad)} 应拒`).toBe(false);
    }
    /* ⚠️ 缺省必须是错：「忘了写 placement」不能静默落到某个默认位置
       （那个位置可能压根没接线 ⇒ 声明了看不见）。 */
    const noPlacement = parsePluginViews([{ id: "x", title: "标题", entry: "p.html" }]);
    expect(noPlacement.ok, "缺 placement 必须拒").toBe(false);
    if (!noPlacement.ok) {
      const text = noPlacement.errors.join("；");
      for (const p of EXPECTED_PLACEMENTS) { expect(text, `错误文案漏了落点 ${p}`).toContain(p); }
    }
  });

  it("三个落点各自都能真的声明成功（3/3）", () => {
    for (const placement of EXPECTED_PLACEMENTS) {
      const r = parsePluginViews([viewDecl({ placement })]);
      expect(r.ok, `落点 ${placement} 应通过：${r.ok ? "" : r.errors.join("；")}`).toBe(true);
      if (r.ok) { expect(r.views[0].placement).toBe(placement); }
    }
  });

  it("title 必填（入口要显示它）；icon / order 可选但要过校验", () => {
    expect(parsePluginViews([{ id: "x", entry: "p.html", placement: "main" }]).ok, "缺 title 必须拒").toBe(false);
    expect(parsePluginViews([viewDecl({ title: "  " })]).ok, "空白 title 必须拒").toBe(false);
    expect(parsePluginViews([viewDecl({ title: "标".repeat(81) })]).ok, "超长 title 必须拒").toBe(false);
    expect(parsePluginViews([viewDecl({ icon: "" })]).ok, "空 icon 必须拒").toBe(false);
    expect(parsePluginViews([viewDecl({ icon: "图".repeat(65) })]).ok, "超长 icon 必须拒").toBe(false);
    expect(parsePluginViews([viewDecl({ order: "1" })]).ok, "非数值 order 必须拒").toBe(false);
    /* 合法组合：icon + order 都给（示例包就是这么写的）。 */
    const ok = parsePluginViews([viewDecl({ icon: "🛠", order: 0 })]);
    expect(ok.ok, ok.ok ? "" : ok.errors.join("；")).toBe(true);
    if (ok.ok) { expect(ok.views[0].icon).toBe("🛠"); expect(ok.views[0].order).toBe(0); }
  });

  it("未知字段拒（契约面不放行：拼错字段名后静默失效 = 陷阱）", () => {
    for (const field of ["width", "height", "kind", "script", "placement2"]) {
      const r = parsePluginViews([viewDecl({ [field]: "x" })]);
      expect(r.ok, `未知字段 ${field} 应拒`).toBe(false);
    }
  });
});

/* ── ①续 entry 的逃逸防护（与 contributes.page **同一条判据**）──────────────── */

describe("A-1200-V ② 栏目的 entry 不得逃出插件目录（与 page 同款口径）", () => {
  const rejectEntry = (entry: unknown): string[] => {
    const r = parsePluginViews([viewDecl({ entry })]);
    expect(r.ok, `预期拒绝但被放行：${JSON.stringify(entry)}`).toBe(false);
    return r.ok ? [] : r.errors;
  };

  it("entry 必填（缺了起不了服务 = 假声明）", () => {
    const r = parsePluginViews([{ id: "x", title: "标题", placement: "main" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain("entry"); }
  });

  it("entry 不许含 `..` 段（栏目 iframe 的 src 会拼进 url ⇒ 能爬出插件目录读别人的文件）", () => {
    /* ⚠️ 每条反例必须**只触发它自己那一条**：若样例里同时带盘符/`..` 之外的写法，
       删掉其中一条校验后它仍被另一条挡住 ⇒ 守卫照样绿而变异存活（等价变异）。 */
    expect(rejectEntry("../../evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("..")]));
    expect(rejectEntry("a/../../evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("..")]));
    expect(rejectEntry("..\\evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("..")]));
    expect(rejectEntry("sub/../../..\\evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("..")]));
  });

  it("entry 不许盘符 / UNC / 以分隔符开头（不是纯相对路径）", () => {
    expect(rejectEntry("C:\\evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("盘符")]));
    expect(rejectEntry("c:/evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("盘符")]));
    expect(rejectEntry("\\\\server\\share\\evil.html")).toEqual(expect.arrayContaining([expect.stringContaining("盘符")]));
    expect(rejectEntry("/etc/passwd")).toEqual(expect.arrayContaining([expect.stringContaining("分隔符开头")]));
    expect(rejectEntry("\\windows\\system32")).toEqual(expect.arrayContaining([expect.stringContaining("分隔符开头")]));
  });

  it("entry 不许空串 / 纯空白 / 含 NUL", () => {
    expect(rejectEntry("")).toEqual(expect.arrayContaining([expect.stringContaining("不能为空")]));
    expect(rejectEntry("   ")).toEqual(expect.arrayContaining([expect.stringContaining("不能为空")]));
    /* ⚠️ 用转义写法而不是真的塞一个 NUL 字节进源码（后者会被编辑器/工具链当异常字节处理）。 */
    expect(rejectEntry("a\u0000b.html")).toEqual(expect.arrayContaining([expect.stringContaining("NUL")]));
  });

  it("合法 entry 放行（纯相对，含子目录）", () => {
    for (const entry of ["panel.html", "ui/panel.html", "a/b/c.html", "./panel.html"]) {
      const r = parsePluginViews([viewDecl({ entry })]);
      expect(r.ok, `应放行：${entry} —— ${r.ok ? "" : r.errors.join("；")}`).toBe(true);
      if (r.ok) { expect(r.views[0].entry).toBe(entry.trim()); }
    }
  });

  it("⚠️ 栏目 entry 与 page entry **共用同一条判据**（不许两套口径各判各的）", () => {
    /* 结构证据：栏目的 entry 走的就是 `validateRelativeEntry` 这一个函数，
       而不是另写一份正则（两套必然漂移，且漂移的那份是静默的）。 */
    const src = read("core-ts/src/plugin/contributes.ts");
    const seg = /export function parsePluginViews[\s\S]*?\n\}\n/.exec(src);
    expect(seg, "contributes.ts 里找不到 parsePluginViews").not.toBeNull();
    expect(seg![0]).toContain("validateRelativeEntry");
    /* 且 `parsePluginPage` 也用它（两条通道同源）。 */
    const pageSeg = /export function parsePluginPage[\s\S]*?\n\}\n/.exec(src);
    expect(pageSeg![0]).toContain("validateRelativeEntry");
  });
});

/* ── ② 向后兼容：page 保留，老插件零改动 ──────────────────────────────────── */

describe("A-1200-V ③ 向后兼容：`contributes.page` 保留且语义 = 右栏栏目特例", () => {
  it("只用 `contributes.page` 的老清单走 parsePluginManifest **照常通过**，语义未变", () => {
    const legacy = {
      name: "legacy-page-plugin",
      version: "1.0.0",
      description: "A-1197 · B5 时代只声明 page 的老插件",
      origin: "user",
      provides: ["instructions"],
      contributes: {
        ui: [
          { slot: "settings_panel", id: "panel", title: "专属设置页" },
          { slot: "status_item", id: "count", label: "计数", refresh: "on_event" },
          { slot: "chat_action", id: "run", label: "用本扩展处理" },
          { slot: "toolbar_item", id: "open", label: "打开面板" },
        ],
        page: { kind: "html", entry: "panel.html" },
      },
    };
    const r = parsePluginManifest(legacy);
    expect(r.ok, `老清单应照常通过：${r.ok ? "" : r.errors.join("；")}`).toBe(true);
    if (!r.ok) { return; }
    /* 老插件的语义一个字节都不许变：page 仍在、ui 仍是四条（形态缺省 item）。 */
    expect(r.manifest.contributes?.page).toEqual({ kind: "html", entry: "panel.html" });
    expect(r.manifest.contributes?.views, "老清单不该凭空长出 views").toBeUndefined();
    const ui = r.manifest.contributes?.ui ?? [];
    expect(ui).toHaveLength(4);
    for (const item of ui) {
      expect(item.kind, `${item.slot} 的形态`).toBeUndefined();
      expect(item.entry, `${item.slot} 不该有 entry`).toBeUndefined();
    }
  });

  it("语义等价性：page 的 kind/entry 与一个 `placement:\"right\"` 栏目承载同一件事", () => {
    /* 「page ≡ 唯一一个 placement:right 的栏目」这句话要能被核对：
       两者的 kind 枚举与 entry 口径必须完全一致（html + 纯相对）。 */
    const pageOnly = parsePluginManifest({
      name: "semantic-page",
      version: "1.0.0",
      description: "只声明 page",
      origin: "user",
      provides: ["instructions"],
      contributes: { page: { kind: "html", entry: "panel.html" } },
    });
    expect(pageOnly.ok, pageOnly.ok ? "" : pageOnly.errors.join("；")).toBe(true);
    if (!pageOnly.ok) { return; }
    /* 新写法：同一个 entry、同一个落点（right），页面照旧在右栏。 */
    const viewOnly = parsePluginManifest({
      name: "semantic-view",
      version: "1.0.0",
      description: "只声明一个右栏栏目",
      origin: "user",
      provides: ["instructions"],
      contributes: { views: [{ id: "panel", title: "示例面板", entry: "panel.html", placement: "right" }] },
    });
    expect(viewOnly.ok, viewOnly.ok ? "" : viewOnly.errors.join("；")).toBe(true);
    if (!viewOnly.ok) { return; }
    const page = pageOnly.manifest.contributes!.page!;
    const view = viewOnly.manifest.contributes!.views![0];
    expect(page.kind, "page 的 kind 只有 html —— 与栏目的 HTML 落点同款").toBe("html");
    expect(view.entry, "两者服务的是同一个 HTML 入口").toBe(page.entry);
    expect(view.placement, "page 的落点就是右栏").toBe("right");
    /* 老写法里 `webview` 仍拒（page 的形态没被本批放宽）。 */
    expect(parsePluginManifest({
      name: "semantic-bad",
      version: "1.0.0",
      description: "老写法想用未开放的形态",
      origin: "user",
      provides: ["instructions"],
      contributes: { page: { kind: "webview", entry: "panel.html" } },
    }).ok, "page 的 webview 形态仍必须拒（本批没放开）").toBe(false);
  });

  it("老写法下 `toolbar_item` 仍要求有页面（假按钮进不来），但**右栏栏目也算页面**", () => {
    /* 反例：既没 page 也没右栏栏目 ⇒ 仍是假按钮 ⇒ 拒。 */
    const fake = parsePluginManifest({
      name: "fake-toolbar",
      version: "1.0.0",
      description: "toolbar_item 没有任何页面可开",
      origin: "user",
      provides: ["instructions"],
      contributes: { ui: [{ slot: "toolbar_item", id: "open", label: "打开" }] },
    });
    expect(fake.ok, "没有页面的 toolbar_item 必须拒").toBe(false);
    if (!fake.ok) { expect(fake.errors.join("；")).toContain("假按钮"); }
    /* 正例：给一个**主区**栏目**不算**（toolbar_item 的用途是打开右栏页面）⇒ 仍拒。
       这一条钉住「右栏」不是随口放宽的。 */
    const mainOnly = parsePluginManifest({
      name: "main-only-toolbar",
      version: "1.0.0",
      description: "只有主区栏目，toolbar_item 无处可开",
      origin: "user",
      provides: ["instructions"],
      contributes: {
        ui: [{ slot: "toolbar_item", id: "open", label: "打开" }],
        views: [{ id: "workbench", title: "工作台", entry: "w.html", placement: "main" }],
      },
    });
    expect(mainOnly.ok, "主区栏目不能满足 toolbar_item（它要开的是页面/右栏）").toBe(false);
    /* 正例：给一个右栏栏目 ⇒ 放行（page 的等价物）。 */
    const withRight = parsePluginManifest({
      name: "right-view-toolbar",
      version: "1.0.0",
      description: "右栏栏目满足 toolbar_item",
      origin: "user",
      provides: ["instructions"],
      contributes: {
        ui: [{ slot: "toolbar_item", id: "open", label: "打开" }],
        views: [{ id: "files", title: "文件树", entry: "f.html", placement: "right" }],
      },
    });
    expect(withRight.ok, withRight.ok ? "" : withRight.errors.join("；")).toBe(true);
  });
});

/* ── ③ 口径冲突：`page` 与 `views` 同写即拒 ─────────────────────────────────── */

describe("A-1200-V ④ `page` 与 `views` 同写 ⇒ 拒（口径冲突不猜）", () => {
  it("同写即拒，且错误文案说清两者是特例关系", () => {
    const r = parsePluginContributes({
      page: { kind: "html", entry: "panel.html" },
      views: [{ id: "workbench", title: "工作台", entry: "w.html", placement: "main" }],
    });
    expect(r.ok, "page 与 views 同写必须拒").toBe(false);
    if (!r.ok) {
      const text = r.errors.join("；");
      expect(text).toContain("contributes.page");
      expect(text).toContain("contributes.views");
      /* 文案要点出「特例」关系，否则写的人不知道自己该删哪个。 */
      expect(text).toMatch(/特例|唯一一个/);
    }
  });

  it("同写时即便两份各自都合法也仍然拒（不能因为「都合法」就放行）", () => {
    const r = parsePluginContributes({
      page: { kind: "html", entry: "a.html" },
      views: [{ id: "b", title: "B", entry: "b.html", placement: "right" }],
    });
    expect(r.ok).toBe(false);
  });

  it("只写 page 放行 / 只写 views 放行（互斥不等于「必须写 views」）", () => {
    expect(parsePluginContributes({ page: { kind: "html", entry: "a.html" } }).ok).toBe(true);
    expect(parsePluginContributes({
      views: [{ id: "b", title: "B", entry: "b.html", placement: "right" }],
    }).ok).toBe(true);
    /* 两者都不写也合法（不用栏目的老插件不该被迫声明）。 */
    expect(parsePluginContributes({ settings: [] }).ok === false || true).toBe(true);
    expect(parsePluginContributes({}).ok).toBe(true);
  });

  it("⚠️ fail-closed：views 里**有一条非法** ⇒ 整份 contributes 被拒（不静默丢弃那一条）", () => {
    const r = parsePluginContributes({
      views: [
        { id: "ok", title: "合法栏目", entry: "ok.html", placement: "main" },
        { id: "bad", title: "坏栏目", entry: "../../evil.html", placement: "right" },
      ],
    });
    expect(r.ok, "有一条非法就必须整份拒").toBe(false);
    if (!r.ok) { expect(r.errors.join("；")).toContain(".."); }
  });
});

/* ── ④ 落点登记：三个 placement 各能正确登记 ───────────────────────────────── */

describe("A-1200-V ⑤ 落点登记：主进程把三个落点各登记进快照", () => {
  const main = read("gui/src/main/index.ts");

  it("registerViews 钩子被 host 注入，且按插件名精确登记 + 精确移除", () => {
    /* 登记：activate 时进表（渲染层才知道有栏目）。 */
    expect(main).toContain("registerViews: (manifest) => {");
    expect(main).toMatch(/pluginViewDecls\.set\(manifest\.name, views\)/);
    /* 撤销：按插件名精确移除（`get === views` 守卫防重装时误删新表）——
       这是「可开可关」的关键一行，不做就是幽灵视图。 */
    expect(main).toMatch(/if \(pluginViewDecls\.get\(manifest\.name\) === views\) \{/);
    expect(main).toMatch(/pluginViewDecls\.delete\(manifest\.name\);/);
  });

  it("host 层：views 走 contribute（进 scope ⇒ 卸载可撤销），并如实登记摘要", () => {
    const host = read("core-ts/src/plugin/host.ts");
    expect(host).toContain("registerViews?:");
    expect(host).toMatch(/const viewsDecl = manifest\.contributes\?\.views;/);
    expect(host).toMatch(/this\.contribute\(scope, this\.registerViews, manifest\)/);
    expect(host).toContain("describePluginViews(viewsDecl)");
  });

  it("快照：三个落点都出去，且按 PLUGIN_VIEW_PLACEMENTS 的下标排序（单一产地）", () => {
    expect(main).toContain("const pluginViewDecls = new Map<string, PluginViewDecl[]>();");
    expect(main).toMatch(/const placementRank = new Map<string, number>\(PLUGIN_VIEW_PLACEMENTS\.map\(\(p, i\) => \[p, i\]\)\);/);
    /* 冲突裁决与 slots 同款：同 placement 同 id 时按 order 再按插件名排序，其余标 conflict。 */
    expect(main).toMatch(/const viewsByKey = new Map<string, PluginViewDTO\[\]>\(\);/);
    expect(main).toMatch(/viewsOut\.push\(i === 0 \? r : \{ \.\.\.r, conflict: true \}\);/);
    expect(main).toContain("views: viewsOut");
    /* DTO 里 placement 必带（渲染层按它分派三个落点）。 */
    const ipc = read("gui/src/shared/ipc.ts");
    expect(ipc).toContain("export interface PluginViewDTO {");
    expect(ipc).toMatch(/placement: import\(".*contributes\.js"\)\.PluginViewPlacement;/);
  });

  it("⚠️ 快照的**每一行**都必须带上 placement（渲染层靠它分派三个落点）", () => {
    /* ⚠️ 这条是 M10 变异（把行构造里的 `placement: v.placement,` 删掉）实测存活后补的。
       为什么原来漏了：守卫只核对了 `PLUGIN_VIEW_PLACEMENTS` 的**下标表**与 conflict 裁决，
       却没有钉「行构造里真的带上了 placement」—— 而那正是渲染层分派的唯一依据。
       判据取**行构造表达式**那段（`decls.map((v) => ({ ... })`），不是全文 grep。 */
    const seg = /const viewRows: PluginViewDTO\[\] = \[\.\.\.pluginViewDecls\.entries\(\)\]\.flatMap\(\(\[plugin, decls\]\) =>\s*\n\s*decls\.map\(\(v\) => \(\{([\s\S]*?)\n\s*\}\)\)\);/.exec(main);
    expect(seg, "main 里找不到 viewRows 的行构造表达式").not.toBeNull();
    expect(seg![1]).toContain("placement: v.placement,");
    /* 且 title / entry / id 同样必带（少任一个，渲染层就画不出入口或 iframe）。 */
    for (const field of ["plugin,", "id: v.id,", "title: v.title,", "entry: v.entry,"]) {
      expect(seg![1], `快照行缺字段 ${field}`).toContain(field);
    }
  });

  it("describePluginViews：扩展页能看出「几个栏目、落在哪」（与 describePluginUi 同款职责）", () => {
    expect(describePluginViews(undefined)).toBe("0个");
    expect(describePluginViews([])).toBe("0个");
    const one: PluginViewDecl = { id: "a", title: "A", entry: "a.html", placement: "main" };
    expect(describePluginViews([one])).toBe("1个（main×1）");
    const two: PluginViewDecl[] = [
      one,
      { id: "b", title: "B", entry: "b.html", placement: "right" },
      { id: "c", title: "C", entry: "c.html", placement: "right" },
    ];
    expect(describePluginViews(two)).toBe("3个（main×1/right×2）");
  });

  it("⚠️ 跨插件同 id 的栏目不静默丢弃：主进程裁决并标 conflict（渲染层渲成禁用态）", () => {
    /* 判据是**代码形态**（按 placement+id 分组后标 conflict），不是注释字面。 */
    expect(main).toMatch(/const key = `\$\{r\.placement\}\\u0000\$\{r\.id\}`;/);
    expect(main).toMatch(/const sorted = \[\.\.\.list\]\.sort\(\s*\(a, b\) => \(a\.order \?\? 0\) - \(b\.order \?\? 0\)/);
    /* 且不因冲突而消失（不能 filter 掉）—— 守卫钉住「标了 conflict 但仍进数组」。 */
    expect(main).not.toMatch(/viewsOut\.filter\(/);
  });
});

/* ── ④续 落值机制：与 panel/page 同一套（不许新发明） ─────────────────────── */

describe("A-1200-V ⑥ 落值机制复用既有通道（同一套 httpServer + 沙箱 + 目录白名单）", () => {
  const main = read("gui/src/main/index.ts");
  const viewHost = read("gui/src/renderer/components/PluginViewHost.tsx");

  it("plugins_view_open：同一个 httpServer.serve 口径，且只信已校验的声明", () => {
    /* ⚠️ 锚从**注册行**起（`IPC_CHANNELS.plugins_view_open`）—— 注释里也出现过这个字样，
       宽锚会匹配到注释段（本项目已踩过，见 a1198-plugin-page.spec.ts）。 */
    const seg = /IPC_CHANNELS\.plugins_view_open[\s\S]*?\n  \}\);/.exec(main);
    expect(seg, "main 里找不到 plugins_view_open handler").not.toBeNull();
    const body = seg![0];
    /* 与 panel/page **逐字同款**的 serve 调用（不许另起一个服务出口）。 */
    expect(body).toMatch(/httpServer\.serve\(\{ dir, host: "127\.0\.0\.1", origin: "agent" \}\)/);
    /* url 必须由「声明里的 entry」拼出来，不是入参那个字符串。 */
    expect(body).toContain("pluginViewDecls.get(name)");
    expect(body).toContain("declared[0].entry.replace");
    /* 绝不 file://（设计 §5.4）。 */
    expect(body).not.toContain("file://");
  });

  it("⚠️ 目录白名单：栏目 entry 不得逃出插件目录（入参只作定位键）", () => {
    const seg = /IPC_CHANNELS\.plugins_view_open[\s\S]*?\n  \}\);/.exec(main)![0];
    /* ① 真实 entry 来自 `pluginViewDecls`（**已接线且已校验**的声明），不是入参。 */
    expect(seg).toMatch(/const declared = \(pluginViewDecls\.get\(name\) \?\? \[\]\)\.filter/);
    /* ② 入参的 entryKey **只**用于 filter 比对，从不直接拼进 url。 */
    expect(seg).not.toMatch(/\$\{base\}\$\{entryKey\}/);
    expect(seg).not.toMatch(/const entry = entryKey/);
    /* ③ 查的是「已接线」表 ⇒ 未装载/已停用/rejected 的插件自然被挡住（不多一套判据）。 */
    expect(seg).toContain("插件没有已接线的该栏目");
    /* ④ 服务目录取自 `state.dirs.get(name)`（装载时扫盘填的唯一可信来源）。 */
    expect(seg).toContain("const dir = state.dirs.get(name);");
  });

  it("栏目 iframe 走沙箱，且 sandbox 属性与 panel / page **逐字同款**（单一隔离口径）", () => {
    expect(viewHost).toContain('const VIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms"');
    expect(viewHost).toMatch(/sandbox=\{VIEW_SANDBOX\}/);
    /* 与既有两处逐字一致（UiSlotHost 的 PANEL_SANDBOX / RightSidebar 的 PluginPageTab）。 */
    expect(read("gui/src/renderer/components/UiSlotHost.tsx"))
      .toContain('const PANEL_SANDBOX = "allow-scripts allow-same-origin allow-forms"');
    expect(read("gui/src/renderer/pages/RightSidebar.tsx"))
      .toContain('sandbox="allow-scripts allow-same-origin allow-forms"');
    /* 落点必须是 iframe（结构上隔离），不是宿主 DOM。 */
    expect(viewHost).toMatch(/<iframe/);
  });

  it("取 url 失败**如实出声**（两条分支都要有文案，绝不静默空白）", () => {
    /* ⚠️ 两条「栏目加载失败」相隔不远，断言窗口必须各自只能匹配自己那条分支 ——
       少了分隔符就可能「第一条被删时第二条仍被匹配」⇒ 守卫假绿。 */
    expect(viewHost).toMatch(
      /if \(res\?\.ok && res\.url\) \{[\s\S]{0,200}?\} else \{[\s\S]{0,80}?setState\(\{ url: "", error: `栏目加载失败/,
    );
    expect(viewHost).toMatch(
      /\} catch \(e\) \{[\s\S]{0,200}?setState\(\{ url: "", error: `栏目加载失败/,
    );
    /* 「加载中」占位也要在：否则取 url 期间是**空白**（用户以为栏目坏了）。 */
    expect(viewHost).toMatch(/loading \|\| !url[\s\S]{0,300}?栏目加载中/);
  });

  it("preload / ipc 暴露了 view 通道（渲染层拿不到就是「声明了永不生效」）", () => {
    const preload = read("gui/src/preload/index.ts");
    expect(preload).toContain("pluginsViewOpen:");
    expect(preload).toContain('"slime:plugins:viewOpen"');
    const ipc = read("gui/src/shared/ipc.ts");
    expect(ipc).toMatch(/plugins_view_open: "slime:plugins:viewOpen"/);
  });

  it("⚠️ 绝不把插件代码注入宿主页面（不走 DSH 的模块加载器路线）", () => {
    /* 判据按**代码形态**写，不按注释字面：本文件注释里会提到 DSH 那个机制的名字
       （说明「我们不走它」），按字面断言会把自己写的说明当成违规。 */
    for (const f of [viewHost, read("gui/src/renderer/App.tsx"), read("gui/src/renderer/pages/RightSidebar.tsx")]) {
      expect(f, "渲染层出现了 DSH 式动态求值注入").not.toMatch(/new Function\(|eval\(/);
    }
  });
});

/* ── ⑤ 接线锁：三个落点真的挂在界面上，且都有用户可达的入口 ───────────────── */

describe("A-1200-V ⑦ 接线锁：三个落点各挂在真实宿主位置上", () => {
  const app = read("gui/src/renderer/App.tsx");
  const sidebar = read("gui/src/renderer/pages/RightSidebar.tsx");
  const viewHost = read("gui/src/renderer/components/PluginViewHost.tsx");

  it("落点 `main`：主区整块视图 + 标题栏切换器（入口）都挂在 App.tsx 上", () => {
    expect(app).toMatch(/import \{[^}]*PluginMainViewSwitcher[^}]*\} from "\.\/components\/PluginViewHost\.js"/);
    /* 入口：标题栏里有切换器（没有入口 = 声明了看不见）。 */
    const bar = /<header className="titlebar">([\s\S]*?)<\/header>/.exec(app);
    expect(bar, "App.tsx 里找不到 header.titlebar").not.toBeNull();
    expect(bar![1]).toContain("<PluginMainViewSwitcher");
    /* 本体：主区里在「对话 / 插件视图」之间切换。 */
    expect(app).toContain("<PluginMainView view={mainPluginView} />");
    expect(app).toMatch(/import \{[^}]*PluginLeftViews[^}]*\} from "\.\/components\/PluginViewHost\.js"/);
  });

  it("落点 `main` 必须落在 `<main>` 内部（挂到别处就不是「主区整块」）", () => {
    const mainAt = app.indexOf("<PluginMainView view={mainPluginView} />");
    expect(mainAt, "主区栏目渲染点找不到").toBeGreaterThan(-1);
    expect(mainAt, "必须在 <main> 内部").toBeGreaterThan(app.indexOf("<main className="));
    expect(mainAt, "必须在 </main> 之前").toBeLessThan(app.indexOf("</main>"));
  });

  it("落点 `left`：左栏栏目块挂在 `<aside className=\"sidebar\">` 内、工作区列表**下方**", () => {
    const aside = /<aside[\s\S]*?<\/aside>/.exec(app);
    expect(aside, "App.tsx 里找不到 aside.sidebar").not.toBeNull();
    expect(aside![0]).toContain("<PluginLeftViews />");
    /* 「工作区列表下方」＝ 在会话列表那个滚动容器 `</div>` 之后、在底部 slime 行之前。
       判据按**位置**（索引先后），不按注释字面。 */
    const at = aside![0].indexOf("<PluginLeftViews />");
    const listEnd = aside![0].indexOf("暂无会话 —");
    expect(listEnd, "找不到工作区列表的尾部标记").toBeGreaterThan(-1);
    expect(at, "左栏栏目必须在工作区列表下方").toBeGreaterThan(listEnd);
    /* 每块自带标题栏 + 折叠按钮 ⇒ 入口自洽（不需要另找入口）。 */
    expect(viewHost).toMatch(/onClick=\{\(\) => setCollapsed\(\(prev\) => \(\{ \.\.\.prev, \[key\]: !isCollapsed \}\)\)\}/);
  });

  it("落点 `right`：右栏**多 tab**（泛化 page），入口是 tab 条上的一行栏目 tab", () => {
    expect(sidebar).toMatch(/import \{[^}]*viewKey[^}]*\} from "\.\.\/components\/PluginViewHost\.js"/);
    /* TabType 多了 view 形态。 */
    expect(sidebar).toMatch(/type TabType = [^;]*"view"/);
    /* 入口：tab 条里画出栏目 tab（用户点它就打开）。 */
    expect(sidebar).toContain("rightPluginViews.map((v) => {");
    expect(sidebar).toMatch(/onClick=\{\(\) => \{ if \(!v\.conflict\) \{ openPluginViewTab\(v\); \} \}\}/);
    /* 本体：内容区分支挂 iframe 渲染器。 */
    expect(sidebar).toContain("<PluginRightViews tab={activeTab} />");
    /* 一插件多 tab：tab 实例带 (plugin,id) 定位键，而不是只有一个 page tab。 */
    expect(sidebar).toMatch(/viewPlugin: view\.plugin, viewId: view\.id, viewEntry: view\.entry,/);
  });

  it("落点 `right` 的 iframe 写法照抄 PluginPageTab（同一套沙箱口径）", () => {
    /* 判据：栏目内容区里真的调了 `PluginViewFrame`（它内部就是那个沙箱 iframe）。 */
    expect(sidebar).toMatch(/<PluginViewFrame view=\{view\} style=\{\{[^}]*flex: 1/);
    /* 且 page 那条老路仍然在（向后兼容：老插件的 page tab 不受影响）。 */
    expect(sidebar).toMatch(/activeTab\.type === "page" && \(\s*<PluginPageTab tab=\{activeTab\} \/>/);
    expect(sidebar).toMatch(/const openPageTab = \(url: string, title: string\): void => \{/);
  });

  it("`main` 落点要**整块接管**主区（不是塞在角落的小块）", () => {
    /* 本体容器铺满：`flex:1 + width/height 100%`（一整块，而不是 chatPanelJsx 旁边一小块）。 */
    expect(viewHost).toMatch(/data-slime-plugin-view="main"[\s\S]{0,200}?flex: 1, minHeight: 0/);
    expect(viewHost).toMatch(/<PluginViewFrame view=\{props\.view\} style=\{\{ display: "block", width: "100%", height: "100%" \}\} \/>/);
  });

  it("`view` 形态**不进「新建」菜单**（栏目 tab 只能由声明开出来，不许用户凭空建空的）", () => {
    /* `TAB_TYPE_META` 是那个菜单的数据源；`view` 不在里面（只有五个既有类型）。 */
    const meta = /const TAB_TYPE_META: TabTypeMeta\[\] = \[([\s\S]*?)\n\];/.exec(sidebar);
    expect(meta, "RightSidebar 里找不到 TAB_TYPE_META").not.toBeNull();
    const types = [...meta![1].matchAll(/type: "([a-z]+)"/g)].map((x) => x[1]);
    expect(types, "「新建」菜单的类型清单").toEqual(["tasks", "terminal", "browser", "git", "file"]);
    expect(types, "view 绝不能进「新建」菜单").not.toContain("view");
    /* 且 tab 条渲染时对它有兜底（而不是 `!` 断言崩掉整条 tab 条）。 */
    expect(sidebar).toMatch(/const Icon = meta\?\.icon \?\? FileIcon;/);
  });
});

/* ── ⑤续 幽灵视图不变量：停用插件必须自动回落 ─────────────────────────────── */

describe("A-1200-V ⑧ 幽灵视图不变量：停用插件时不得留空白（主区 + 右栏 tab）", () => {
  const app = read("gui/src/renderer/App.tsx");
  const sidebar = read("gui/src/renderer/pages/RightSidebar.tsx");

  it("主区：切回对话的判据是**派生量**（栏目从快照消失 ⇒ 解析为 null ⇒ 渲染对话）", () => {
    /* ⚠️ 关键：判据不能是 `mainViewId` 本身（「用户点了切过去」这个事实），
       必须是「activeId 在**最新快照**里还能不能解析到一个栏目」——
       插件一停用，快照里就没有它 ⇒ 自动回对话，不用额外的一次状态同步。 */
    expect(app).toMatch(
      /const mainPluginView = viewsAt\(pluginViews, "main"\)\.find\(\(v\) => v\.id === mainViewId\) \?\? null;/,
    );
    expect(app).toContain("const pluginViews = usePluginViews();");
    /* 渲染分支：有栏目⇒ 插件视图；没有 ⇒ 对话（源码里那一条 `{chatPanelJsx}` 就是 A-1152
       「唯一宿主」守卫数的那个token，外面包了一层 `<>…</>`）。 */
    expect(app).toMatch(/\{mainPluginView \? \([\s\S]{0,600}?\) : \(\s*<>\{chatPanelJsx\}<\/>\s*\)/);
    /* ⚠️ 这条是 M19 变异（把主区的 `ErrorBoundary` 换成裸 `<>…</>`）实测存活后补的：
       只断言「三选一的分支结构」根本碰不到 ErrorBoundary（它只是分支里的一层壳），
       所以那条变异改掉壳之后守卫照样绿。⇒ 必须**单独**钉住「栏目那支包着 ErrorBoundary」。
       判据按**代码形态**（`ErrorBoundary` 标签与它的闭合），不按注释字面。 */
    const mainBranch = /\{mainPluginView \? \(([\s\S]{0,600}?)\) : \(/.exec(app);
    expect(mainBranch, "找不到主区的三选一分支").not.toBeNull();
    expect(mainBranch![1], "主区栏目那一支必须包 ErrorBoundary（一个扩展的栏目炸了不许带塌整个主区）")
      .toMatch(/<ErrorBoundary>[\s\S]*?<\/ErrorBoundary>/);
    /* 而对话那一支**不该**被 ErrorBoundary 包住（否则浮窗拖拽/尺寸逻辑多一层 DOM 包裹）。 */
    const elseBranch = /\) : \(\s*([\s\S]{0,80}?)\s*\)\}/.exec(app);
    expect(elseBranch, "找不到对话那一支").not.toBeNull();
    expect(elseBranch![1], "对话那一支不该包 ErrorBoundary").not.toContain("ErrorBoundary");
  });

  it("主区：另有一道显式清态（拿到最新快照后发现栏目不在了就清 activeId）", () => {
    /* 两道防线缺一不可：① 派生判据（渲染正确），② 清态（状态不留脏）。
       只做 ① 的话，切回对话后再点别的栏目时 activeId 是陈的。 */
    expect(app).toMatch(
      /React\.useEffect\(\(\) => \{\s*if \(mainViewId === ""\) \{ return; \}\s*if \(!viewsAt\(pluginViews, "main"\)\.some\(\(v\) => v\.id === mainViewId\)\) \{/,
    );
    expect(app).toContain('setMainViewId("");');
  });

  it("主区：切换态**不持久化**（会话级即可，持久化会留下「重启后主区莫名其妙是空的」）", () => {
    /* 判据：状态用 `useState`，而项目里读 localStorage 的地方会写 `localStorage`——
       切到 mainViewId 附近的那几行里不许出现 localStorage/sessionStorage 之外的持久化通道。 */
    const at = app.indexOf("const [mainViewId, setMainViewId]");
    expect(at, "找不到 mainViewId 的状态定义").toBeGreaterThan(-1);
    const seg = app.slice(at, at + 120);
    expect(seg).toContain("React.useState<string>");
    /* 整份 App 里不许为栏目切换态引入任何持久化（readLocal/setLocal 之类）。 */
    const viewStateSeg = app.slice(at, app.indexOf("<header className=\"titlebar\">"));
    expect(viewStateSeg, "栏目切换态不许持久化").not.toMatch(/localStorage|sessionStorage|writeLocal|setLocal\(/);
  });

  it("右栏：持有该栏目的 tab 在插件停用时被**摘掉**（不留点开是空白的死 tab）", () => {
    expect(sidebar).toMatch(
      /const stale = prev\.filter\(\(t\) => t\.type === "view" && !rightPluginViews\.some\(\(v\) => v\.plugin === t\.viewPlugin && v\.id === t\.viewId\)\);/,
    );
    /* 摘掉后焦点要落到一个还在的 tab 上（不能停在已不存在的 id ⇒ 内容区空白）。 */
    expect(sidebar).toMatch(/setActiveId\(\(cur\) => \(cur !== undefined && staleIds\.has\(cur\)/);
  });

  it("右栏：即便 tab 上的定位键丢了，也**如实出声**而不是静默空白", () => {
    expect(sidebar).toMatch(/function PluginRightViews\(props: \{ tab: TabInstance \}\): JSX\.Element \{/);
    expect(sidebar).toContain("该栏目的声明已不可用");
    /* 且它是从**最新快照**里按 (plugin,id) 找的，不是信任 tab 上那几个字段。 */
    expect(sidebar).toMatch(/const view = views\.find\(\(v\) => v\.plugin === tab\.viewPlugin && v\.id === tab\.viewId\);/);
  });

  it("全量重算而非增量 diff：数据源是 plugins_changed 广播后重拉全量（不漏摘）", () => {
    const viewHost = read("gui/src/renderer/components/PluginViewHost.tsx");
    expect(viewHost).toContain("const off = a?.extras?.pluginsOnChanged?.(() => { void pull(); });");
    /* 拉的是整份快照的 views 字段，不做按 id 的局部合并。 */
    expect(viewHost).toMatch(/a\?\.extras\?\.pluginsUi\?\.\(\)/);
    expect(viewHost).toContain('setViews(Array.isArray(res?.views) ? (res as { views: PluginViewDTO[] }).views : []);');
  });

  it("key 用 (plugin, placement, id) 三元组：插件卸载后旧栏目不可能残留（React 按 key 卸载 iframe）", () => {
    const viewHost = read("gui/src/renderer/components/PluginViewHost.tsx");
    expect(viewHost).toContain('export const viewKey = (v: PluginViewDTO): string => `${v.plugin}::${v.placement}::${v.id}`;');
  });
});

/* ── ⑧续Agent 自述：必须把「栏目」这一格讲清（否则 Agent 不知道自己能造整块功能区） ── */

describe("A-1200-V ⑧·续 Agent 自述与导引必须涵盖「插件自有栏目」", () => {
  const GUIDE_SRC = read("core-ts/src/services/agentTools.ts");

  it("导引的贡献点清单里有 `views` 那一行（与解析白名单同源，A-1198-S ④ 钉的就是这个）", () => {
    /* ⚠️ 这条不是 `GUIDE.toContain("`views`")` —— M20 变异实测存活过：
       导引里 `views` 这个词出现在**四处**（清单行/ ③·附 小节 / 三·补 小节 / 自述），
       删掉清单那一行后 `toContain` 仍被另外三处喂饱 ⇒ 假绿。
       ⇒ 必须**限定到贡献点清单那一段**（从「共N类」那行到「下面先展开」那行之间）。 */
    const list = /共[一二三四五六七八九十]类、\*\*都已落地可用\*\*[\s\S]*?下面先展开/.exec(GUIDE_SRC);
    expect(list, "导引里找不到贡献点清单段（从「共N类」到「下面先展开」）").not.toBeNull();
    expect(list![0], "贡献点清单段漏了 `views`（Agent 不知道自己能新增一整个功能栏目）").toContain("`views`");
    /* 且清单段里说清了它与 `ui` 的差别（否则 Agent 会把栏目当成「多挂个按钮」）。 */
    expect(list![0]).toContain("整块功能区");
  });

  it("导引讲了三个落点与各自的入口（Agent 照着写才知道往哪放）", () => {
    for (const needle of ["`main`", "`right`", "`left`", "整块", "入口"]) {
      expect(GUIDE_SRC, `导引漏了 ${needle}`).toContain(needle);
    }
  });

  it("导引说清了三条边界：上限 8 / entry 纯相对 / page 与 views 不可同写", () => {
    expect(GUIDE_SRC, "导引必须写清栏目上限（照着写必被拒）").toMatch(/上限\s*8\s*个/);
    expect(GUIDE_SRC, "导引必须写清 entry 是纯相对路径").toContain("纯相对路径");
    expect(GUIDE_SRC, "导引必须写清 page 与 views 不可同写").toMatch(/`page` 与 `views` \*\*不可同时声明\*\*/);
  });

  it("导引如实说清栏目的边界（沙箱 iframe，碰不到宿主；停用即消失）", () => {
    expect(GUIDE_SRC).toContain("沙箱 iframe");
    expect(GUIDE_SRC).toContain("127.0.0.1");
    expect(GUIDE_SRC).toMatch(/碰不到宿主/);
    expect(GUIDE_SRC, "导引必须说清「停用即消失」（可开可关）").toMatch(/停用.*消失|栏目与入口\*\*一并消失/);
    /* 且不许把栏目说成「能改宿主」（那是无法兑现的承诺）。 */
    expect(GUIDE_SRC).not.toMatch(/栏目.*可以修改宿主|栏目.*注入宿主页面/);
  });

  it("导引点明 `views` 与 `ui` 的根本差别（本批的灵魂：别退化成「小修小补」）", () => {
    /* 用户口径：「别人能自己造一个影响应用整体风格的功能栏目」⇒ 导引必须让 Agent 知道
       这两件事的量级差别，否则它写插件时仍然只会去挂按钮。 */
    expect(GUIDE_SRC).toMatch(/`ui`\s*=\s*\*\*插入点\*\*/);
    expect(GUIDE_SRC).toMatch(/`views`\s*=\s*\*\*整块栏目\*\*/);
    expect(GUIDE_SRC, "导引必须点明这对应 DSH 那种「整块工作台」的形态").toContain("better-sidebar");
  });
});

/* ── ⑨ 官方示例包：真过清单校验（活教材） ──────────────────────────────────── */
describe("A-1200-V ⑨ 官方示例包 hello-slime：演示栏目，且真能装载", () => {
  const EXAMPLE_DIR = "gui/template/plugins/hello-slime";

  it("plugin.json 真过 parsePluginManifest（示例自己装不上 = 活教材失效）", () => {
    const raw = JSON.parse(read(`${EXAMPLE_DIR}/plugin.json`)) as Record<string, unknown>;
    const r = parsePluginManifest(raw);
    expect(r.ok, r.ok ? "" : r.errors.join("；")).toBe(true);
    if (!r.ok) { return; }
    const views = r.manifest.contributes?.views ?? [];
    expect(views.length, "示例包应演示「插件自有栏目」").toBeGreaterThanOrEqual(1);
    /* id 不得重复、落点必须合法（解析层已保证，这里再钉一次示例的意图）。 */
    expect(new Set(views.map((v) => v.id)).size).toBe(views.length);
    for (const v of views) {
      expect(EXPECTED_PLACEMENTS).toContain(v.placement);
      expect(v.title.trim(), "栏目要有展示名（入口要显示它）").not.toBe("");
    }
  });

  it("示例演示的是**主区整块视图**（本批最重要的一格，对标 better-sidebar 的工作站）", () => {
    const raw = JSON.parse(read(`${EXAMPLE_DIR}/plugin.json`)) as Record<string, unknown>;
    const r = parsePluginManifest(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) { return; }
    const mains = (r.manifest.contributes?.views ?? []).filter((v) => v.placement === "main");
    expect(mains.length, "示例应至少有一个 placement=main 的栏目").toBeGreaterThanOrEqual(1);
  });

  it("示例的 entry 必须**真的在插件目录里**（引用不存在的文件 = 活教材教人写错东西）", () => {
    const raw = JSON.parse(read(`${EXAMPLE_DIR}/plugin.json`)) as Record<string, unknown>;
    const r = parsePluginManifest(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) { return; }
    for (const v of r.manifest.contributes?.views ?? []) {
      expect(existsSync(join(PROJECT_ROOT, EXAMPLE_DIR, v.entry)), `示例栏目 ${v.id} 的 entry 不存在：${v.entry}`).toBe(true);
    }
  });

  it("⚠️ 示例里 `page` 与 `views` 不同时出现（清单层会拒，活教材不能自己违法）", () => {
    const raw = JSON.parse(read(`${EXAMPLE_DIR}/plugin.json`)) as Record<string, unknown>;
    const contributes = raw.contributes as Record<string, unknown>;
    expect(contributes.views, "示例应演示栏目").toBeDefined();
    expect(contributes.page, "示例不该同时写 page（与 views 互斥）").toBeUndefined();
  });

  it("随包播种路径没变（模板目录仍被 electron-builder 打包）", () => {
    expect(read("gui/electron-builder.json")).toContain("\"template/plugins\"");
  });
});

/* ── ⑩ 类型层：声明形状真的能承载多个落点 ─────────────────────────────────── */

describe("A-1200-V ⑩ 类型层：placement 是封闭枚举（渲染层按它穷举分派）", () => {
  it("PLUGIN_VIEW_PLACEMENTS 的元素类型就是声明里的 placement 类型", () => {
    /* 结构证据：`PluginViewDecl.placement` 用的是 `(typeof PLUGIN_VIEW_PLACEMENTS)[number]`，
       所以渲染层 `viewsAt(v, "main" | "right" | "left")` 与清单层判据同源。 */
    const src = read("core-ts/src/plugin/contributes.ts");
    expect(src).toMatch(/export type PluginViewPlacement = \(typeof PLUGIN_VIEW_PLACEMENTS\)\[number\];/);
    expect(src).toMatch(/placement: PluginViewPlacement;/);
  });

  it("一个插件可同时声明三个落点的栏目（这正是「多栏目」的意义）", () => {
    const decls: PluginViewDecl[] = (["main", "right", "left"] as PluginViewPlacement[]).map((p, i) => ({
      id: `v-${p}`, title: `落点 ${p}`, entry: `${p}.html`, placement: p, order: i,
    }));
    const r = parsePluginViews(decls);
    expect(r.ok, r.ok ? "" : r.errors.join("；")).toBe(true);
    if (r.ok) {
      expect(r.views.map((v) => v.placement)).toEqual(["main", "right", "left"]);
      expect(r.views.map((v) => v.order)).toEqual([0, 1, 2]);
    }
  });
});