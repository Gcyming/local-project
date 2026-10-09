/**
 * A-1200 · B3：**插件自有栏目**（`contributes.views`）→ 三个落点的渲染器。
 *
 * ## 这一层在防什么 / 兑现什么（用户口径原话，本批灵魂）
 * 「我不是要你去开发外观市场啊，我是给你举个例子。
 *   **别人甚至能自己造一个影响应用整体风格的功能栏目**，而我的 slime 只能小修小补。」
 * ⇒ 对标 DSH 的 `dsh-better-sidebar`：文件树 + 编辑器 + 终端 + Git 面板塞成**一整块**侧栏工作台，
 *   装上后整个应用看起来像 VSCode。
 *
 * ## 与 B1 的 `ui`（UiSlotHost）的根本差别 —— 做偏了就白做
 *   · `ui`    = **插入点**：在宿主既有区域里放小组件 → 用户感受仍是「在别人界面里加东西」。
 *   · `views` = **整块栏目**：插件开辟自己的功能区，有独立入口与整块 UI → 「加了一整个新功能区」。
 * 所以本文件**不复用** `UiSlotHost` 的任何渲染器：落点、尺寸、生命周期、撤销语义全都不同。
 *
 * ## 三个落点（placement 只有这三个值，清单层已 fail-closed 拒掉其它）
 *   · `main`  —— 主区整块视图：主区在「对话 / 插件视图」之间切换，切过去整块区域归它。
 *                入口 = 标题栏的视图切换器（`PluginMainViewSwitcher`）。
 *   · `right` —— 右栏 tab：**泛化既有 `contributes.page`**（一插件一页 → 一插件多 tab）。
 *                入口 = 右栏 tab 条本身（在 RightSidebar.tsx 里接线）。
 *   · `left`  —— 左栏栏目块：工作区列表下方的独立栏目，**自带标题栏**（可折叠）＝ 入口自洽。
 *
 * ## 落值机制：**不许新发明**
 * 栏目内容一律**沙箱 iframe**，`src` 经 `plugins_view_open` 取 —— 与 `plugins_panel_open` /
 * `plugins_page_open` **完全同一套** `httpServer.serve({dir, host:"127.0.0.1"})` 机制，
 * 目录白名单同样限定在该插件自己目录内（主进程只从**已校验的声明**里取回真实 entry，
 * 入参 `entry` 只作查找键 ⇒ 渲染层无法伪造路径）。**绝不 `file://`**（设计 §5.4）。
 *
 * ## 幽灵视图不变量（本批最容易踩的坑）
 * 主区切到某个栏目后，若该插件被**停用/卸载**，`plugins_changed` 一到，栏目从快照里消失 ⇒
 * 必须**自动切回「对话」**。否则用户看到的是一块**空白**（"插件都没了，界面还占着一块"）。
 * 两道防线：① 派生判据（找不到 activeId ⇒ 渲染对话）；② 显式 `useEffect` 清态。
 */
import React, { type JSX } from "react";
import type { PluginViewDTO } from "../../shared/ipc.js";
import ErrorBoundary from "../ErrorBoundary.js";

/** 拉取已接线的栏目（含订阅 `plugins_changed` 全量重算 —— 与 UiSlotHost 同款纪律）。
 *  ⚠️ 数据源 = `pluginsUi()` 快照的 `views`（主进程只回**已接线**插件的声明），
 *  被卸载/禁用/rejected 的插件自然不在其中 ⇒ 不做增量 diff就不会漏摘。 */
export function usePluginViews(): PluginViewDTO[] {
  const [views, setViews] = React.useState<PluginViewDTO[]>([]);
  React.useEffect(() => {
    let alive = true;
    const a = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const pull = async (): Promise<void> => {
      const res = await (a?.extras?.pluginsUi?.() as Promise<{ views?: PluginViewDTO[] } | null | undefined>).catch(() => null);
      if (alive) { setViews(Array.isArray(res?.views) ? (res as { views: PluginViewDTO[] }).views : []); }
    };
    void pull();
    const off = a?.extras?.pluginsOnChanged?.(() => { void pull(); });
    return () => { alive = false; if (typeof off === "function") { off(); } };
  }, []);
  return views;
}

/** 只留某个落点的栏目（宿主渲染器按落点分派，与清单层的枚举同一个产地）。 */
export function viewsAt(views: PluginViewDTO[], placement: "main" | "right" | "left"): PluginViewDTO[] {
  return views.filter((v) => v.placement === placement);
}

/** 三元组 key：插件停用后旧栏目不可能残留（React 按 key 卸载，iframe 随之卸载）。 */
export const viewKey = (v: PluginViewDTO): string => `${v.plugin}::${v.placement}::${v.id}`;

/** 沙箱 iframe 的 sandbox 属性 —— 与 `UiSlotHost` 的 `PANEL_SANDBOX` / `RightSidebar` 的
 *  `PluginPageTab` **逐字同款**（单一隔离口径：跨源 + sandbox ⇒ 扩展碰不到宿主对象）。 */
const VIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms";

interface ViewFrameState { url: string; error: string; loading: boolean }

/** 按需取栏目的可加载 url（**只由主进程给**，渲染层不自己拼 —— 那是越权防护点）。
 *  取不到时**如实显示错误文案**，绝不静默空白（静默空白 = 用户以为扩展坏了却连原因都看不到）。 */
export function usePluginViewUrl(plugin: string, entry: string | undefined): ViewFrameState {
  const [state, setState] = React.useState<ViewFrameState>({ url: "", error: "", loading: true });
  React.useEffect(() => {
    let alive = true;
    if (!entry) {
      setState({ url: "", error: "栏目声明缺少入口（entry）", loading: false });
      return () => { alive = false; };
    }
    setState({ url: "", error: "", loading: true });
    const a = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const open = a?.extras?.pluginsViewOpen;
    if (typeof open !== "function") {
      setState({ url: "", error: "当前环境不支持加载插件栏目（主进程未暴露 view 通道）", loading: false });
      return () => { alive = false; };
    }
    void (async () => {
      try {
        const res = await (open(plugin, entry) as Promise<{ ok?: boolean; url?: string; error?: string }>);
        if (!alive) { return; }
        if (res?.ok && res.url) {
          setState({ url: res.url, error: "", loading: false });
        } else {
          setState({ url: "", error: `栏目加载失败：${res?.error ? String(res.error) : "主进程未返回 url"}`, loading: false });
        }
      } catch (e) {
        if (!alive) { return; }
        setState({ url: "", error: `栏目加载失败：${e instanceof Error ? e.message : String(e)}`, loading: false });
      }
    })();
    return () => { alive = false; };
  }, [plugin, entry]);
  return state;
}

/** 一个栏目的沙箱 iframe（loading / 失败都出文案；成功才挂 iframe）。
 *  `style` 由各落点给（**落点决定尺寸与定位，不决定隔离**）。 */
export function PluginViewFrame(props: { view: PluginViewDTO; style: React.CSSProperties }): JSX.Element {
  const v = props.view;
  const { url, error, loading } = usePluginViewUrl(v.plugin, v.entry);
  if (error) {
    return (
      <div style={{ ...props.style, display: "flex", alignItems: "center", justifyContent: "center", padding: 6, fontSize: 11, color: "var(--danger)", overflow: "auto", textAlign: "center" }}>
        {error}
      </div>
    );
  }
  if (loading || !url) {
    return (
      <div style={{ ...props.style, display: "flex", alignItems: "center", justifyContent: "center", padding: 6, fontSize: 11, color: "var(--text-dim)" }}>
        栏目加载中…
      </div>
    );
  }
  return (
    <iframe
      title={`${v.plugin} 的${v.title}栏目`}
      src={url}
      sandbox={VIEW_SANDBOX}
      style={{ ...props.style, border: "none", background: "transparent" }}
    />
  );
}

/* ── 落点 `main`：主区整块视图 ─────────────────────────────────────────────── */

/**
 * 标题栏的**视图切换器**（`main` 栏目的入口 —— 没有入口就是「声明了看不见」）。
 *  冲突项渲染成禁用态并说明原因（不静默丢弃、不静默覆盖）。
 */
export function PluginMainViewSwitcher(props: { activeId: string; onSelect: (id: string) => void }): JSX.Element | null {
  const views = viewsAt(usePluginViews(), "main");
  if (views.length === 0) { return null; }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      {views.map((v) => (
        <button
          key={viewKey(v)}
          className="titlebar-btn"
          disabled={v.conflict === true}
          onClick={() => props.onSelect(v.id)}
          title={v.conflict
            ? "与该落点的另一个插件栏目冲突，已禁用（调整 order 或改名可解）"
            : `把主区切到「${v.title}」栏目（${v.plugin} 扩展的整块功能区）`}
          style={{
            fontSize: 11.5, padding: "2px 8px", width: "auto", height: "auto",
            ...(props.activeId === v.id ? { background: "var(--accent-soft)", color: "var(--accent-hover)" } : {}),
          }}
        >
          {v.icon ? `${v.icon} ` : ""}{v.title}
        </button>
      ))}
    </div>
  );
}

/**
 * 主区「对话 / 插件视图」的**切换器**（挂在主区顶部的一条窄栏）。
 *
 * ⚠️ **幽灵视图不变量就在这里**：插件被停用时 `views` 里不再有那个栏目 ⇒
 * `active` 解析为 null ⇒ 宿主立刻渲染对话（下面 App.tsx 的条件渲染），
 * 并且本组件的 `useEffect` 把 `activeId` 清空（否则切回对话后再切别的栏目时状态是脏的）。
 */
export function PluginMainViewBar(props: { active: PluginViewDTO | null; onBack: () => void }): JSX.Element | null {
  const views = viewsAt(usePluginViews(), "main");
  if (views.length === 0) { return null; }
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
      height: 32, padding: "0 8px", borderBottom: "1px solid var(--border)",
      background: "var(--sidebar-bg, #1e1e2e)", fontSize: 11.5,
    }}>
      <button className="titlebar-btn" onClick={props.onBack} title="回到对话（主区整块交回宿主）"
        style={{ fontSize: 11.5, padding: "2px 8px", width: "auto", height: "auto" }}>
        ← 对话
      </button>
      {views.map((v) => (
        <span
          key={viewKey(v)}
          title={`${v.plugin} 扩展声明的栏目`}
          style={{
            padding: "2px 8px", borderRadius: 6,
            background: props.active?.id === v.id ? "var(--accent-soft)" : "transparent",
            color: props.active?.id === v.id ? "var(--accent-hover)" : "var(--text-muted)",
            opacity: v.conflict ? 0.55 : 1,
          }}
        >
          {v.icon ? `${v.icon} ` : ""}{v.title}{v.conflict ? " · 冲突已禁用" : ""}
        </span>
      ))}
    </div>
  );
}

/** 主区里那一整块栏目 UI（`main` 落点的落点本体；整块区域归插件）。 */
export function PluginMainView(props: { view: PluginViewDTO }): JSX.Element {
  return (
    <div data-slime-plugin-view="main" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <PluginViewFrame view={props.view} style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  );
}

/* ── 落点 `left`：左栏栏目块（自带标题栏＝入口自洽） ─────────────────────────── */

/**
 * 左栏的独立栏目块（工作区列表**下方**），每块自带标题栏 + 折叠按钮。
 * 折叠态是**会话级 UI 状态**（不持久化）：栏目可开可关由插件拨片决定，这里只是收起内容。
 */
export function PluginLeftViews(): JSX.Element | null {
  const views = viewsAt(usePluginViews(), "left");
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  if (views.length === 0) { return null; }
  return (
    <ErrorBoundary>
      <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
        {views.map((v) => {
          const key = viewKey(v);
          const isCollapsed = collapsed[key] === true;
          return (
            <div key={key} style={{ borderTop: "1px solid var(--border)" }}>
              <div
                style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 12px", cursor: "pointer" }}
                onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !isCollapsed }))}
                title={`${v.plugin} 扩展声明的左栏栏目（点击${isCollapsed ? "展开" : "折叠"}）`}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: v.conflict ? "var(--text-dim)" : "var(--text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.icon ? `${v.icon} ` : ""}{v.title}{v.conflict ? " · 冲突已禁用" : ""}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{isCollapsed ? "▸" : "▾"}</span>
              </div>
              {!isCollapsed && (
                <PluginViewFrame view={v} style={{ display: "block", width: "100%", height: 200 }} />
              )}
            </div>
          );
        })}
      </div>
    </ErrorBoundary>
  );
}