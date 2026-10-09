/**
 * A-1197 · B5（L4a page + toolbar_item）：扩展自有页面的**接线形状**守卫。
 *
 * 渲染层没有组件测试环境（项目惯例：形状断言 + 变异），锁死四类事实：
 *   ① 主进程：page_open 按需起 127.0.0.1 静态服务（**绝不 file://**）、卸载时 stop；
 *   ② 渲染层：toolbar 点击 → 解析 url → 右栏开页；**沙箱 iframe**（跨源隔离）；
 *   ③ 交叉校验：toolbar_item 必须配 page（假按钮进不来）；
 *   ④ 页面 tab 参与右栏既有体系（SidebarTabKind / openPageTab 去重）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const MAIN = "gui/src/main/index.ts";
const SLOT_HOST = "gui/src/renderer/components/UiSlotHost.tsx";
const SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";

describe("A-1198-P ① 主进程：按需起 127.0.0.1 静态服务 + 卸载 stop", () => {
  const main = read(MAIN);

  it("page_open：校验声明/目录后 serve（host 钉死 127.0.0.1）+ 拼 entry 出 url", () => {
    /* ⚠️ 锚必须从**注册行**起（`IPC_CHANNELS.plugins_page_open`）——注释里也出现过
       `plugins_page_open` 字样，宽锚会匹配到注释段（实测踩过）。 */
    const seg = /IPC_CHANNELS\.plugins_page_open[\s\S]*?\n  \}\);/.exec(main);
    expect(seg).not.toBeNull();
    const body = seg![0];
    expect(body).toMatch(/httpServer\.serve\(\{ dir, host: "127\.0\.0\.1", origin: "agent" \}\)/);
    expect(body).toMatch(/page\.entry\.replace/);
    // 未声明 page / 未装载 ⇒ 如实拒绝（不给假 url）
    expect(body).toMatch(/未声明页面/);
  });

  it("**绝不 file://**：整段 handler 里不出现 file://（§5.4 的明文口径）", () => {
    const seg = /IPC_CHANNELS\.plugins_page_open[\s\S]*?\n  \}\);/.exec(main)![0];
    expect(seg).not.toContain("file://");
  });

  it("registerPage 的 dispose 按目录精确 stop（服务泄漏兜底；失败如实 console.error）", () => {
    const seg = /registerPage: \(manifest\) => \{[\s\S]*?\n    \},\n  \}\);/.exec(main);
    expect(seg).not.toBeNull();
    const body = seg![0];
    expect(body).toMatch(/httpServer\.list\(\)/);
    expect(body).toMatch(/resolve\(e\.dir\) === resolve\(dir\)/);
    expect(body).toMatch(/httpServer\.stop\(e\.id\)/);
    expect(body).toMatch(/console\.error/);
  });
});

describe("A-1198-P ② 渲染层：toolbar 点击 → 沙箱 iframe", () => {
  const slotHost = read(SLOT_HOST);
  const sidebar = read(SIDEBAR);

  it("toolbar_item 渲染器：点击调 pluginsPageOpen，成功经 SIDEBAR_OPEN_EVENT 传 plugin-page", () => {
    expect(slotHost).toMatch(/export function PluginToolbarItems/);
    expect(slotHost).toMatch(/pluginsPageOpen\(plugin\)/);
    expect(slotHost).toMatch(/requestSidebarOpen\(\{ kind: "plugin-page", plugin, url: res\.url, title: label \}\)/);
    // 失败如实出声（alertAsync，不静默）
    expect(slotHost).toMatch(/alertAsync\("打开扩展页面失败"/);
  });

  it("右栏 **沙箱 iframe** 承接（sandbox 属性在；跨源 ⇒ 碰不到宿主）", () => {
    expect(sidebar).toMatch(/<iframe/);
    expect(sidebar).toMatch(/sandbox="allow-scripts allow-same-origin allow-forms"/);
    expect(sidebar).toMatch(/function PluginPageTab/);
  });

  it("page tab 参与既有体系：TabType/SidebarTabKind 含 page、openPageTab 去重、渲染分支在", () => {
    expect(sidebar).toMatch(/type TabType = [^;]*"page"/);
    expect(sidebar).toMatch(/const openPageTab = \(url: string, title: string\): void => \{/);
    expect(sidebar).toMatch(/const same = pages\.find\(\(t\) => t\.url === url\)/);
    expect(sidebar).toMatch(/activeTab\.type === "page" && \(\s*<PluginPageTab tab=\{activeTab\} \/>/);
    expect(sidebar).toMatch(/d\.kind === "plugin-page" && d\.url/);
    const search = read("gui/src/renderer/pages/sidebarSearch.ts");
    expect(search).toMatch(/kind: "browser" \| "file" \| "terminal" \| "tasks" \| "git" \| "page" \| "none"/);
  });

  it("page tab 也把 url 送进侧栏搜索/状态视图（browser 同款口径）", () => {
    expect(sidebar).toMatch(/\(t\?\.type === "browser" \|\| t\?\.type === "page"\)/);
  });
});

describe("A-1198-P ③ 交叉校验：假按钮进不来", () => {
  it("contributes：`toolbar_item` 缺页面 ⇒ 整份rejected（parsePluginContributes 的交叉约束）", () => {
    const src = read("core-ts/src/plugin/contributes.ts");
    /* ⚠️ 2026-10-09（A-1200 · B3）锚点更新：原判据是 `toolbar_item … page === undefined`，
       而 B3 把「本插件自己的页面」泛化成**两种**声明方式（`page` 或 `views` 里一个
       `placement:"right"` 的栏目），判据相应变成 `!hasOwnPage`。
       窗口从 120 放宽到 400 —— 因为 `hasOwnPage` 的定义里带了 `(out.views ?? [])` 这一段。
       ⚠️ 语义没放宽：仍然是「两者都没有 ⇒ 拒」（A-1200-B3 的 spec 里另有行为级反例钉住）。 */
    expect(src).toMatch(/toolbar_item[\s\S]{0,400}?!hasOwnPage/);
    expect(src).toMatch(/const hasOwnPage = out\.page !== undefined \|\|/);
    expect(src).toMatch(/没有 page 就是假按钮/);
  });

  it("`toolbar_item` + 一个右栏栏目（placement right）⇒ 放行（B3：`page` 是 views 的特例，不是唯一入口）", () => {
    const r = parsePluginManifest({
      name: "toolbar-with-view",
      version: "1.0.0",
      description: "用 views 的右栏栏目满足 toolbar_item",
      origin: "user",
      provides: ["instructions"],
      contributes: {
        ui: [{ slot: "toolbar_item", id: "open", label: "打开我的栏目" }],
        views: [{ id: "files", title: "文件树", entry: "files.html", placement: "right" }],
      },
    });
    expect(r.ok, r.ok ? "" : r.errors.join("；")).toBe(true);
  });
});
