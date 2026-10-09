/**
 * A-1198 · 扩展页「草稿 → 保存 → 重启统一生效」的渲染层纯逻辑（不依赖 React/DOM，node 可测）。
 *
 * ## 用户口径（原话）
 * 「为扩展页也做一个保存功能吧，即通过拨片打开的扩展要保存后才统一生效。
 *   保存后刷新整个 slime 程序以刷新 slime 状态加载扩展能力。」
 *
 * ## 为什么把「拨片 / 信任」改成草稿
 * 启停与信任都影响**主进程装载状态**（工具、技能、UI 槽位、皮肤、脚本装配）——
 * 逐个即时应用不仅慢，还会出现「一半生效、一半没生效；有的还要去刷页面」。
 * 攒成一次保存、配合一次重启，换来一个**确定性**的统一生效点：
 * 保存之前怎么点都不动系统状态；保存之后一次写盘、重启加载。
 *
 * ## 边界（写死在这里，界面只做展示）
 *   · 草稿**只记「与当前开关状态不同」的项** —— 点回原值即自动出草稿（不给假脏标记）；
 *   · `prunePluginDraft`：列表刷新后，丢弃「插件已消失」与「已与服务器一致」的草稿
 *     （重扫/自动刷新不会把脏标记变成僵尸）；
 *   · 载荷顺序稳定（按名字排序），同一个草稿两次保存写出同一份文件。
 */

export interface PluginDraftState {
  /** name → 期望启用（仅存「与当前开关状态不同」的项）。 */
  toggles: Record<string, boolean>;
  /** name → 期望信任（同上；只对声明了脚本的插件有意义）。 */
  trust: Record<string, boolean>;
}

export interface PluginServerState {
  /** 与界面上拨片一致的口径：禁用/加载失败 = false（failed 时拨片显示关）。 */
  on: boolean;
  trusted: boolean;
}

export const emptyPluginDraft = (): PluginDraftState => ({ toggles: {}, trust: {} });

function withValue(
  map: Record<string, boolean>,
  name: string,
  desired: boolean,
  serverValue: boolean,
): Record<string, boolean> {
  const next = { ...map };
  if (desired === serverValue) {
    delete next[name]; // 点回原值 = 撤销该条草稿（脏标记必须诚实）
  } else {
    next[name] = desired;
  }
  return next;
}

export function setToggleDraft(
  draft: PluginDraftState,
  name: string,
  desired: boolean,
  serverOn: boolean,
): PluginDraftState {
  return { ...draft, toggles: withValue(draft.toggles, name, desired, serverOn) };
}

export function setTrustDraft(
  draft: PluginDraftState,
  name: string,
  desired: boolean,
  serverTrusted: boolean,
): PluginDraftState {
  return { ...draft, trust: withValue(draft.trust, name, desired, serverTrusted) };
}

export function pluginDraftCount(draft: PluginDraftState): number {
  return Object.keys(draft.toggles).length + Object.keys(draft.trust).length;
}

/** 某一行是否有未保存的改动（渲染「待生效」标记用）。 */
export function isRowStaged(draft: PluginDraftState, name: string): boolean {
  return name in draft.toggles || name in draft.trust;
}

/** 保存载荷：按名字排序（稳定）；形态直接对得上主进程 `plugins_apply_changes` 的入参。 */
export function pluginDraftPayload(draft: PluginDraftState): {
  toggles: Array<{ name: string; enabled: boolean }>;
  trust: Array<{ name: string; trusted: boolean }>;
} {
  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    toggles: Object.keys(draft.toggles).sort(byName).map((name) => ({ name, enabled: draft.toggles[name] })),
    trust: Object.keys(draft.trust).sort(byName).map((name) => ({ name, trusted: draft.trust[name] })),
  };
}

/**
 * 列表刷新后的草稿剪枝：
 *   · 插件已不在列表（卸载/目录被删）⇒ 丢弃；
 *   · 草稿值已与服务器一致（外部变化追平 / 刚保存重启完）⇒ 丢弃。
 */
export function prunePluginDraft(
  draft: PluginDraftState,
  server: Map<string, PluginServerState>,
): PluginDraftState {
  const toggles: Record<string, boolean> = {};
  for (const [name, desired] of Object.entries(draft.toggles)) {
    const s = server.get(name);
    if (s && desired !== s.on) { toggles[name] = desired; }
  }
  const trust: Record<string, boolean> = {};
  for (const [name, desired] of Object.entries(draft.trust)) {
    const s = server.get(name);
    if (s && desired !== s.trusted) { trust[name] = desired; }
  }
  const same = Object.keys(toggles).length === Object.keys(draft.toggles).length
    && Object.keys(trust).length === Object.keys(draft.trust).length
    && Object.entries(toggles).every(([k, v]) => draft.toggles[k] === v)
    && Object.entries(trust).every(([k, v]) => draft.trust[k] === v);
  return same ? draft : { toggles, trust };
}
