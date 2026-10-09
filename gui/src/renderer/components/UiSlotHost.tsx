/**
 * A-1197 · B2（L4a UI 贡献点） + **A-1200 · B1（区域注册表 + panel 形态）**：
 * **区域 → 渲染器**的唯一映射表。
 *
 * ## 判据（为什么集中在一个文件）
 * 扩展只能**声明**（`contributes.ui`），渲染器全部由宿主实现（红线：扩展不贡献
 * JSX/CSS/脚本进入宿主）。「哪个区域长什么样」必须只有一个产地 —— 已知区域各有显式分支，
 * **未知区域渲染成「本区域尚未接线」而不是空白**（不静默）。
 *
 * ## 两种形态（`PluginUiContribution.kind`）
 *  · `item`（**缺省**）：宿主渲染的按钮/行。既有 4 槽位的老插件**一个字不改**走这条路。
 *  · `panel`：扩展自带 HTML。宿主按需经 `plugins_panel_open` 取url（主进程起
 *    127.0.0.1 静态服务），再用**沙箱 iframe** 承接 —— 与 `RightSidebar` 的 `PluginPageTab`
 *    同一套隔离口径（跨源 + sandbox ⇒ 扩展碰不到宿主对象）。
 *    ⚠️ **绝不把扩展代码注入宿主页面**（不做 DSH 的 `__ModuleLoader__` 路线，理由见
 *    `docs/plugin-ui-freedom-design.md` §0/§5）。
 *
 * ## 全量重算（卸载不彻底的历史缺陷高发区，A-1195 修过一次泄漏）
 * 数据源 = `pluginsUi()`（主进程只回**已接线**插件的声明）+ `plugins_changed`
 * 一到就**重拉全量**（不做增量 diff，避免漏摘）；React key 用 `plugin+slot+id`
 * 三元组 ⇒ 插件被卸载/禁用后其槽位**一个都不剩**（panel 的 iframe 随之卸载，无需新机制）。
 *
 * ## 冲突与异常
 * 跨插件「同 slot 同 id」的冲突项由主进程标 `conflict: true`，这里渲染成**禁用态**
 * （不静默丢弃、不静默覆盖）；每个区域外层包 `ErrorBoundary` —— 一个扩展的槽位
 * 炸了不带塌整页。panel 取url 失败**如实显示错误文案**（不静默空白）。
 */
import React, { type JSX } from "react";
import type { PluginUiSlotDTO } from "../../shared/ipc.js";
import ErrorBoundary from "../ErrorBoundary.js";
import { requestSidebarOpen } from "../pages/Markdown.js";
import { alertAsync } from "../dialog.js";

/** 拉取已接线的 UI 槽位（含订阅 `plugins_changed` 全量重算）。 */
export function usePluginUiSlots(): PluginUiSlotDTO[] {
  const [slots, setSlots] = React.useState<PluginUiSlotDTO[]>([]);
  React.useEffect(() => {
    let alive = true;
    const a = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const pull = async (): Promise<void> => {
      const res = await (a?.extras?.pluginsUi?.() as Promise<{ slots?: PluginUiSlotDTO[] } | null | undefined>).catch(() => null);
      if (alive) { setSlots(Array.isArray(res?.slots) ? (res as { slots: PluginUiSlotDTO[] }).slots : []); }
    };
    void pull();
    const off = a?.extras?.pluginsOnChanged?.(() => { void pull(); });
    return () => { alive = false; if (typeof off === "function") { off(); } };
  }, []);
  return slots;
}

/** 区域 → 渲染器 的唯一映射（供评审与守卫核对「未知区域不静默」）。 */
export const UI_SLOT_RENDERERS: Record<string, string> = {
  settings_panel: "UiSlotPanel（设置页：SettingsDialog 动态追加 SECTIONS + UiSlotPanel 渲染）",
  status_item: "PluginStatusItems（右栏 StatusPanel 底部一行组）",
  chat_action: "PluginChatActions（输入栏动作区按钮组）",
  toolbar_item: "PluginToolbarItems（输入栏动作区「打开扩展页面」按钮；B5）",
  titlebar_start: "PluginTitlebarItems（标题栏左端；A-1200 · B1）",
  titlebar_end: "PluginTitlebarItems（标题栏右端；A-1200 · B1）",
  chat_input_leading: "PluginChatInputLeading（输入栏左端；A-1200 · B1）",
  chat_input_trailing: "PluginChatInputTrailing（输入栏右端；A-1200 · B1）",
  chat_message_actions: "PluginMessageActions（每条消息 hover 动作区；A-1200 · B1）",
  sidebar_section: "PluginSidebarSections（右栏分区，item + panel 都收；A-1200 · B1）",
  status_bar: "PluginStatusBarItems（底部状态条；A-1200 · B1）",
  overlay_floating: "PluginOverlayFloating（全屏 pointer-events:none 浮层，插件自己定位；A-1200 · B1）",
  overlay_fullscreen: "PluginOverlayFullscreen（全屏接管层，默认铺满；A-1200 · B1）",
};

/** 三元组 key：插件卸载后旧槽位不可能残留（React 按 key 卸载）。 */
const slotKey = (s: PluginUiSlotDTO): string => `${s.plugin}::${s.slot}::${s.id}`;

/** 该条声明是不是自带 UI 的面板（缺省 = item，与清单层同一口径）。 */
const isPanel = (s: PluginUiSlotDTO): boolean => s.kind === "panel";

/* ── 跨组件的「插入输入框」通道（A-1200 · B1）─────────────────────────────────
 * 为什么需要它：`titlebar_*`（在 App.tsx）与 `chat_message_actions`（在 ChatPanel 的
 * memo 子组件里）**都拿不到 ChatPanel 的 setInput** —— 而「点击把动作提示插入输入框」
 * 是这些 item 形态唯一的宿主行为（扩展只声明 label/icon）。
 * ⚠️ 若不给它们这条通道，它们就是**假按钮**（点了什么也不发生）——而"配了但不生效"
 * 正是本项目的判据陷阱。所以这里发一个窗口级 CustomEvent，由 ChatPanel 监听并落地。
 * 与 `SIDEBAR_OPEN_EVENT`（右侧栏开页）同一款既有模式，不是新机制。
 */
export const PLUGIN_INSERT_INPUT_EVENT = "slime:plugin-insert-input";

/** 请 ChatPanel 把一段文本追加到输入框（同一窗口内任意组件可发）。 */
export function requestPluginInsertInput(text: string): void {
  if (typeof window === "undefined") { return; }
  window.dispatchEvent(new CustomEvent<string>(PLUGIN_INSERT_INPUT_EVENT, { detail: text }));
}

/* ── panel 共用：按需取 url + 沙箱 iframe ────────────────────────────────────
 * 为什么要有这个 hook：url **只能**由主进程给（它要起服务、并从**已校验的声明**里取回真实
 * entry —— 渲染层传来的字符串不被信任）。取不到时**如实显示错误文案**，绝不静默空白
 * （静默空白 = 用户以为扩展坏了却连原因都看不到）。
 */
interface PanelFrameState { url: string; error: string; loading: boolean }

/** 沙箱 iframe 的 sandbox 属性 —— 与 `RightSidebar` 的 `PluginPageTab` **逐字同款**（单一隔离口径）。 */
const PANEL_SANDBOX = "allow-scripts allow-same-origin allow-forms";

function usePanelUrl(plugin: string, entry: string | undefined): PanelFrameState {
  const [state, setState] = React.useState<PanelFrameState>({ url: "", error: "", loading: true });
  React.useEffect(() => {
    let alive = true;
    if (!entry) {
      setState({ url: "", error: "面板声明缺少入口（entry）", loading: false });
      return () => { alive = false; };
    }
    setState({ url: "", error: "", loading: true });
    const a = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const open = a?.extras?.pluginsPanelOpen;
    if (typeof open !== "function") {
      setState({ url: "", error: "当前环境不支持加载扩展面板（主进程未暴露 panel 通道）", loading: false });
      return () => { alive = false; };
    }
    void (async () => {
      try {
        const res = await (open(plugin, entry) as Promise<{ ok?: boolean; url?: string; error?: string }>);
        if (!alive) { return; }
        if (res?.ok && res.url) {
          setState({ url: res.url, error: "", loading: false });
        } else {
          setState({ url: "", error: `面板加载失败：${res?.error ? String(res.error) : "主进程未返回 url"}`, loading: false });
        }
      } catch (e) {
        if (!alive) { return; }
        setState({ url: "", error: `面板加载失败：${e instanceof Error ? e.message : String(e)}`, loading: false });
      }
    })();
    return () => { alive = false; };
  }, [plugin, entry]);
  return state;
}

/** 一个 panel 的沙箱 iframe（loading/失败都出文案；成功才挂 iframe）。
 *  `style` 由各区域给（**区域决定尺寸与定位，不决定隔离**）。 */
function PanelFrame(props: { slot: PluginUiSlotDTO; style: React.CSSProperties; title?: string }): JSX.Element {
  const s = props.slot;
  const { url, error, loading } = usePanelUrl(s.plugin, s.entry);
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
        面板加载中…
      </div>
    );
  }
  return (
    <iframe
      title={props.title ?? `${s.plugin} 的${s.label ?? s.title ?? s.id}面板`}
      src={url}
      sandbox={PANEL_SANDBOX}
      style={{ ...props.style, border: "none", background: "transparent" }}
    />
  );
}

/** 把某个区域的声明拆成「item 条目」与「panel 条目」（渲染器按形态分派）。
 *  `region` 传 undefined = 不筛区域（`UiSlotHost` 的通用入口用）。 */
function pickRegion(slots: PluginUiSlotDTO[], region: string): { items: PluginUiSlotDTO[]; panels: PluginUiSlotDTO[] } {
  const rows = region === undefined ? slots : slots.filter((s) => s.slot === region);
  return { items: rows.filter((s) => !isPanel(s)), panels: rows.filter(isPanel) };
}

/** 一组 item 声明的**按钮**渲染（各区域按钮样式不同，但「点击把动作提示插入输入框」的宿主
 *  行为同款 —— 扩展只声明 label/icon，点击后用户接着写自己的话再发送）。
 *  `variant` 只影响外观，不影响行为。 */
function ItemButtons(props: { items: PluginUiSlotDTO[]; variant: string; onInsert?: (text: string) => void; titleOf?: (s: PluginUiSlotDTO) => string }): JSX.Element {
  return (
    <>
      {props.items.map((s) => (
        <button
          key={slotKey(s)}
          className={props.variant === "titlebar" ? "titlebar-btn" : "btn"}
          disabled={s.conflict === true}
          title={props.titleOf
            ? props.titleOf(s)
            : (s.conflict ? "与该区域的另一个插件声明冲突，已禁用（调整 order 或改名可解）" : (s.when ? `显示条件：${s.when}` : `${s.plugin} 扩展（点击把动作提示插入输入框）`))}
          style={props.variant === "titlebar"
            ? { fontSize: 11.5, padding: "2px 8px", width: "auto", height: "auto" }
            : { fontSize: 11.5, padding: "3px 10px" }}
          onClick={() => props.onInsert?.(`[${s.plugin}] ${s.label ?? s.title ?? ""}：`)}
        >
          {s.icon ? `${s.icon} ` : ""}{s.label ?? s.title ?? s.id}
        </button>
      ))}
    </>
  );
}

/* ── 各区域渲染器（A-1200 · B1）──────────────────────────────────────────── */

/** `titlebar_start` / `titlebar_end` 渲染器：标题栏两端的按钮组。
 *  ⚠️ 标题栏是 `-webkit-app-region: drag`，所以按钮必须挂 `titlebar-btn` 类
 *  （它带 `-webkit-app-region: no-drag`，否则按钮点不动 —— 既有 CSS 的口径）。
 *  ⚠️ 本组件在 App.tsx 里，**拿不到 ChatPanel 的 setInput** ⇒ 点击走
 *  `requestPluginInsertInput` 窗口事件（否则就是假按钮）。 */
export function PluginTitlebarItems(props: { region: "titlebar_start" | "titlebar_end" }): JSX.Element | null {
  const { items } = pickRegion(usePluginUiSlots(), props.region);
  if (items.length === 0) { return null; }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <ItemButtons
        items={items}
        variant="titlebar"
        onInsert={requestPluginInsertInput}
        titleOf={(s) => `${s.plugin} 扩展（标题栏入口，点击把动作提示插入输入框）`}
      />
    </div>
  );
}

/** `chat_input_leading` / `chat_input_trailing` 渲染器：输入栏两端的按钮组。 */
export function PluginChatInputLeading(props: { onInsert: (text: string) => void }): JSX.Element | null {
  const { items } = pickRegion(usePluginUiSlots(), "chat_input_leading");
  if (items.length === 0) { return null; }
  return <ItemButtons items={items} variant="btn" onInsert={props.onInsert} />;
}

export function PluginChatInputTrailing(props: { onInsert: (text: string) => void }): JSX.Element | null {
  const { items } = pickRegion(usePluginUiSlots(), "chat_input_trailing");
  if (items.length === 0) { return null; }
  return <ItemButtons items={items} variant="btn" onInsert={props.onInsert} />;
}

/** `chat_message_actions` 渲染器：每条消息 hover 动作区的一组小按钮。
 *  ⚠️ 宿主行为与 `chat_action` 同款（插入动作提示）—— 消息级动作与输入栏动作在语义上
 *  都是「让用户接着写」，差别只有**落在哪**（每条消息旁边 vs 输入栏）。
 *  ⚠️ 渲染点在 memo 子组件里、拿不到 setInput ⇒ 同样走窗口事件通道（否则是假按钮）。 */
export function PluginMessageActions(): JSX.Element | null {
  const { items } = pickRegion(usePluginUiSlots(), "chat_message_actions");
  if (items.length === 0) { return null; }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <ItemButtons
        items={items}
        variant="btn"
        onInsert={requestPluginInsertInput}
        titleOf={(s) => `${s.plugin} 扩展（消息级动作，点击把动作提示插入输入框）`}
      />
    </span>
  );
}

/** `sidebar_section` 渲染器：右栏一整块分区（**item + panel 都收**）。
 *  item 渲染成小标题 + 说明行；panel 渲染成固定高度的沙箱 iframe。 */
export function PluginSidebarSections(): JSX.Element | null {
  const { items, panels } = pickRegion(usePluginUiSlots(), "sidebar_section");
  if (items.length === 0 && panels.length === 0) { return null; }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
      {items.map((s) => (
        <div key={slotKey(s)} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: s.conflict ? "var(--text-dim)" : "var(--text-secondary)" }}>
            {s.icon ? `${s.icon} ` : ""}{s.label ?? s.title ?? s.id}
            {s.conflict ? " · 冲突已禁用" : ""}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{s.plugin} 扩展声明的右栏分区</span>
        </div>
      ))}
      {panels.map((s) => (
        <PanelFrame key={slotKey(s)} slot={s} style={{ width: "100%", height: 220 }} />
      ))}
    </div>
  );
}

/** `status_bar` 渲染器：底部状态条的一行（与右栏 `status_item` 区分：这里是真的贴底一条）。 */
export function PluginStatusBarItems(): JSX.Element | null {
  const { items } = pickRegion(usePluginUiSlots(), "status_bar");
  if (items.length === 0) { return null; }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {items.map((s) => (
        <span
          key={slotKey(s)}
          title={s.conflict ? "与该区域的另一个插件声明冲突，已禁用" : `${s.plugin} 扩展（底部状态条）`}
          style={{ fontSize: 11, color: s.conflict ? "var(--text-dim)" : "var(--text-muted)", opacity: s.conflict ? 0.55 : 1 }}
        >
          {s.icon ? `${s.icon} ` : ""}{s.label ?? s.title ?? s.id}
        </span>
      ))}
    </div>
  );
}

/** `overlay_floating` / `overlay_fullscreen` 的**全屏容器**（本批的重点）。
 *
 * ## 为什么是「全屏 + pointer-events:none」而不是给插件一个固定角落
 * 用户口径是「插件要能在**任意位置**挂按钮/自带 UI」（对标 DSH 的注入式自由度）。
 * 宿主给一个 `position:fixed; inset:0` 的空容器，**插件面板在 iframe 内自己定位**
 * （想贴左上就左上、想贴右下就右下）—— 这样「任意位置」这件事由扩展自己决定，
 * 而宿主仍然只提供「一块全屏的空地」这一件事。
 *
 * ## z-index 取值（不与既有浮层冲突）
 * 既有实测值（`gui/src/renderer/index.css` / `App.tsx`）：下拉菜单 3000、
 * 对话框 backdrop 1200、本地模型加载面板 1000、`.ghost-dropdown` 3000、
 * `.op-focus-frame` 900/901、`.browser-error-page` 8。
 * ⇒ 本容器取 **1100**：高于应用内容与「本地模型加载面板(1000)」，
 * **低于对话框 backdrop(1200)** —— 于是插件面板**盖不掉权限确认/设置对话框**
 * （§5.2「不让扩展覆盖宿主安全关键 UI」在浮层上的落点）。
 * ⚠️ 插件**不能**用 `z-index` 逃出这个约定：它的 iframe 是**独立文档**，
 * `z-index` 只在 iframe 内部生效，宿主页面的层叠上下文由宿主全权决定。
 */
const PLUGIN_OVERLAY_Z = 1100;

export function PluginOverlayFloating(): JSX.Element | null {
  const { panels } = pickRegion(usePluginUiSlots(), "overlay_floating");
  if (panels.length === 0) { return null; }
  return (
    <div
      data-slime-plugin-overlay="floating"
      style={{
        position: "fixed", inset: 0, zIndex: PLUGIN_OVERLAY_Z,
        /* 容器不吃点击（否则插件一挂上来整个界面就点不动了）——
           只有面板自身在 iframe 里开 pointer-events:auto（见下面每块 wrapper）。 */
        pointerEvents: "none",
      }}
    >
      {panels.map((s) => (
        <div key={slotKey(s)} style={{ pointerEvents: "auto" }}>
          <PanelFrame slot={s} style={{ display: "block", width: 320, height: 220 }} />
        </div>
      ))}
    </div>
  );
}

export function PluginOverlayFullscreen(): JSX.Element | null {
  const { panels } = pickRegion(usePluginUiSlots(), "overlay_fullscreen");
  if (panels.length === 0) { return null; }
  return (
    <div
      data-slime-plugin-overlay="fullscreen"
      style={{ position: "fixed", inset: 0, zIndex: PLUGIN_OVERLAY_Z, pointerEvents: "none" }}
    >
      {panels.map((s) => (
        /* 全屏接管层默认**铺满**（`100%`）—— 扩展要「贴角落」就自己在 iframe 里改。
           每块各自包一层 `pointerEvents:auto` 的 wrapper：容器整体不吃点击，
           但内容区能点（否则全屏层会把整个界面变成死区）。 */
        <div key={slotKey(s)} style={{ position: "absolute", inset: 0, pointerEvents: "auto" }}>
          <PanelFrame slot={s} style={{ display: "block", width: "100%", height: "100%" }} />
        </div>
      ))}
    </div>
  );
}

/** `status_item` 渲染器：右栏 StatusPanel 底部一行组（冲突项禁用 + 灰显）。 */
export function PluginStatusItems(): JSX.Element | null {
  const slots = usePluginUiSlots().filter((s) => s.slot === "status_item"&& !isPanel(s));
  if (slots.length === 0) { return null; }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {slots.map((s) => (
        <div
          key={slotKey(s)}
          title={s.conflict ? "与该槽位的另一个插件声明冲突，已禁用（调整 order 或改名可解）" : `${s.plugin} 扩展`}
          style={{
            display: "flex", alignItems: "center", gap: 6, fontSize: 11.5,
            color: s.conflict ? "var(--text-dim)" : "var(--text-secondary)",
            opacity: s.conflict ? 0.55 : 1,
          }}
        >
          <span style={{ flexShrink: 0, width: 6, height: 6, borderRadius: 3, background: s.conflict ? "var(--text-dim)" : "var(--accent)" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.icon ? `${s.icon} ` : ""}{s.label}</span>
          <span style={{ marginLeft: "auto", color: "var(--text-dim)", flexShrink: 0 }}>
            {s.plugin}{s.refresh === "on_event" ? " · 实时" : ""}{s.conflict ? " · 冲突" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

/** `chat_action` 渲染器：输入栏动作区按钮组。
 *  点击的宿主行为 = 把动作提示**插入输入框**（用户接着写自己的话再发送）——
 *  B2 阶段这是「用本扩展处理」的真实起点（更深的内容挂载随后续批次放开）。 */
export function PluginChatActions(props: { onInsert: (text: string) => void }): JSX.Element | null {
  const slots = usePluginUiSlots().filter((s) => s.slot === "chat_action" && !isPanel(s));
  if (slots.length === 0) { return null; }
  return (
    <>
      {slots.map((s) => (
        <button
          key={slotKey(s)}
          className="btn"
          disabled={s.conflict === true}
          title={s.conflict ? "与另一插件的同名动作冲突，已禁用" : (s.when ? `显示条件：${s.when}` : `${s.plugin} 扩展动作（点击把动作提示插入输入框）`)}
          style={{ fontSize: 11.5, padding: "3px 10px" }}
          onClick={() => props.onInsert(`[${s.plugin}] ${s.label}：`)}
        >
          {s.icon ? `${s.icon} ` : ""}{s.label}
        </button>
      ))}
    </>
  );
}

/** `settings_panel` 渲染器：扩展专属设置页（内容区）。
 *  `slotKey` 形如 `ui:<plugin>:<id>`（SettingsDialog 动态追加的 SECTIONS 条目 id）。
 *  ⚠️ `settings_panel` 只接 item（形态-区域兼容表），所以这里不过滤 panel。 */
export function UiSlotPanel(props: { slotKey: string }): JSX.Element {
  const slots = usePluginUiSlots().filter((s) => s.slot === "settings_panel");
  const slot = slots.find((s) => `ui:${s.plugin}:${s.id}` === props.slotKey);
  if (!slot) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7 }}>
        该扩展的设置页已不可用（插件被卸载 / 禁用，或声明已改）。
        本页随声明**全量重算**，不留幽灵页。
      </div>
    );
  }
  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{slot.icon ? `${slot.icon} ` : ""}{slot.title ?? slot.id}</h3>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7 }}>
        本页由扩展「<b>{slot.plugin}</b>」声明（contributes.ui.settings_panel），由宿主渲染。
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
        该扩展若同时声明了设置项（contributes.settings），可在「插件」页对应卡片里编辑；
        本页是它的专属入口 —— B2 交付「声明 → 渲染 → 卸载全量重算」的闭环，
        更深的内容挂载（page/webview）随后续批次放开。
      </div>
    </div>
  );
}

/** `toolbar_item` 渲染器（B5）：输入栏动作区的「打开扩展页面」按钮。
 *  点击 → 主进程按需起 127.0.0.1 静态服务（复用既有 httpServer）→ 解析 url →
 *  经 SIDEBAR_OPEN_EVENT 让右栏打开沙箱 iframe 页。失败如实提示（不静默）。 */
export function PluginToolbarItems(): JSX.Element | null {
  const slots = usePluginUiSlots().filter((s) => s.slot === "toolbar_item" && !isPanel(s));
  if (slots.length === 0) { return null; }
  const openPage = async (plugin: string, label: string): Promise<void> => {
    const a = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!a?.extras?.pluginsPageOpen) { void alertAsync("当前环境不支持打开扩展页面"); return; }
    try {
      const res = await a.extras.pluginsPageOpen(plugin) as { ok?: boolean; url?: string; error?: string } | null;
      if (res?.ok && res.url) {
        requestSidebarOpen({ kind: "plugin-page", plugin, url: res.url, title: label });
        return;
      }
      void alertAsync("打开扩展页面失败", res?.error ? String(res.error) : undefined);
    } catch (e) {
      void alertAsync("打开扩展页面失败", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      {slots.map((s) => (
        <button
          key={slotKey(s)}
          className="btn"
          disabled={s.conflict === true}
          title={s.conflict ? "与另一插件的同名入口冲突，已禁用" : `${s.plugin} 扩展页面（在右栏打开）`}
          style={{ fontSize: 11.5, padding: "3px 10px" }}
          onClick={() => { void openPage(s.plugin, s.label ?? s.title ?? "扩展页面"); }}
        >
          {s.icon ? `${s.icon} ` : ""}{s.label}
        </button>
      ))}
    </>
  );
}

/** 通用区域渲染入口：已知区域分派到对应渲染器；**未知区域如实报「尚未接线」**（不静默空白）。 */
export function UiSlotHost(props: { slot: string; onInsert?: (text: string) => void }): JSX.Element {
  const onInsert = (t: string): void => { props.onInsert?.(t); };
  const known = Object.prototype.hasOwnProperty.call(UI_SLOT_RENDERERS, props.slot);
  return (
    <ErrorBoundary>
      {props.slot === "status_item" ? <PluginStatusItems />
        : props.slot === "chat_action" ? <PluginChatActions onInsert={onInsert} />
          : props.slot === "titlebar_start" ? <PluginTitlebarItems region="titlebar_start" />
            : props.slot === "titlebar_end" ? <PluginTitlebarItems region="titlebar_end" />
              : props.slot === "chat_input_leading" ? <PluginChatInputLeading onInsert={onInsert} />
                : props.slot === "chat_input_trailing" ? <PluginChatInputTrailing onInsert={onInsert} />
                  : props.slot === "chat_message_actions" ? <PluginMessageActions />
                    : props.slot === "sidebar_section" ? <PluginSidebarSections />
                      : props.slot === "status_bar" ? <PluginStatusBarItems />
                        : props.slot === "overlay_floating" ? <PluginOverlayFloating />
                          : props.slot === "overlay_fullscreen" ? <PluginOverlayFullscreen />
                            : (
                              /* 未接线（含两种情形）：① 区域名不在注册表里（老插件写了别的名字）；
                                 ② 在注册表里但本批没给渲染器 —— **都要出声**，绝不空白。 */
                              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                                {known ? `本区域尚未接线：${props.slot}` : `本区域尚未接线（区域名不在注册表里）：${props.slot}`}
                              </div>
                            )}
    </ErrorBoundary>
  );
}