/**
 * A-1197 · B2（L4a UI 贡献点）：**槽位 → 渲染器**的唯一映射表。
 *
 * ## 判据（为什么集中在一个文件）
 * 扩展只能**声明**（`contributes.ui`），渲染器全部由宿主实现（红线：扩展不贡献
 * JSX/CSS/脚本）。「哪个槽位长什么样」必须只有一个产地 —— 已知槽位各有显式分支，
 * **未知槽位渲染成「本槽位尚未接线」而不是空白**（不静默）。
 *
 * ## 全量重算（卸载不彻底的历史缺陷高发区，A-1195 修过一次泄漏）
 * 数据源 = `pluginsUi()`（主进程只回**已接线**插件的声明）+ `plugins_changed`
 * 一到就**重拉全量**（不做增量 diff，避免漏摘）；React key 用 `plugin+slot+id`
 * 三元组 ⇒ 插件被卸载/禁用后其槽位**一个都不剩**。
 *
 * ## 冲突与异常
 * 跨插件「同 slot 同 id」的冲突项由主进程标 `conflict: true`，这里渲染成**禁用态**
 * （不静默丢弃、不静默覆盖）；每个槽位外层包 `ErrorBoundary` —— 一个扩展的槽位
 * 炸了不带塌整页。
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

/** 槽位 → 渲染器 的唯一映射（供评审与守卫核对「未知槽位不静默」）。 */
export const UI_SLOT_RENDERERS: Record<string, string> = {
  settings_panel: "UiSlotPanel（设置页：SettingsDialog 动态追加 SECTIONS + UiSlotPanel 渲染）",
  status_item: "PluginStatusItems（右栏 StatusPanel 底部一行组）",
  chat_action: "PluginChatActions（输入栏动作区按钮组）",
  toolbar_item: "PluginToolbarItems（输入栏动作区「打开扩展页面」按钮；B5）",
};

/** 三元组 key：插件卸载后旧槽位不可能残留（React 按 key 卸载）。 */
const slotKey = (s: PluginUiSlotDTO): string => `${s.plugin}::${s.slot}::${s.id}`;

/** `status_item` 渲染器：右栏 StatusPanel 底部一行组（冲突项禁用 + 灰显）。 */
export function PluginStatusItems(): JSX.Element | null {
  const slots = usePluginUiSlots().filter((s) => s.slot === "status_item");
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
  const slots = usePluginUiSlots().filter((s) => s.slot === "chat_action");
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
 *  `slotKey` 形如 `ui:<plugin>:<id>`（SettingsDialog 动态追加的 SECTIONS 条目 id）。 */
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
  const slots = usePluginUiSlots().filter((s) => s.slot === "toolbar_item");
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

/** 通用槽位渲染入口：已知槽位分派到对应渲染器；**未知槽位如实报「尚未接线」**（不静默空白）。 */
export function UiSlotHost(props: { slot: string; onInsert?: (text: string) => void }): JSX.Element {
  return (
    <ErrorBoundary>
      {props.slot === "status_item" ? <PluginStatusItems />
        : props.slot === "chat_action" ? <PluginChatActions onInsert={(t) => props.onInsert?.(t)} />
          : (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>本槽位尚未接线：{props.slot}</div>
          )}
    </ErrorBoundary>
  );
}
