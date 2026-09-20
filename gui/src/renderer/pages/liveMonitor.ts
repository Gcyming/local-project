/**
 * gui/src/renderer/pages/liveMonitor.ts — 流式在途监测快照（A-982）。
 *
 * **为什么独立成模块（A-990）**：这段逻辑原先住在 `ChatPanel.tsx`（一个 5000+ 行的 React
 * 组件）里，于是右栏要取样就得 `import { readLiveMonitor } from "./ChatPanel.js"` ——
 * 一个纯内存快照读写，被迫把整个组件（及其静态资源、React、Portal…）拖进调用方的模块图。
 * 症状有两层：① `tests/core-ts/live-monitor.spec.ts` 一 import 就把 renderer 拉进根类型检查；
 * ② 任何组件级改动都可能让**与它无关**的测试/类型检查变红。纯逻辑就该待在无 JSX 的模块里。
 *
 * 架构：ChatPanel 每帧把在途数值写进下面这个**模块级对象**，右侧栏**自己按拍子取样**。
 *
 * 为什么不再只靠 CustomEvent 推送（这是"右栏不实时"反复出现三次的根因）：
 * 事件链上任何一处守卫失效都会让数值**静默冻结、且一行报错都没有** ——
 *   ① `p.sessionId !== sessionIdRef.current` 就把事件丢掉（空串/跨会话切换/恢复态很容易不匹配）；
 *   ② 发送前后 120ms 节流窗口 + 右栏 1s 合并窗口叠加；
 *   ③ 右栏被卸载重挂（收起/展开、切换会话）时订阅重建，重建瞬间的事件全部落空。
 * 这类"事件没到"的故障无法被测试发现（事件本身没错），只能靠**改变架构**根治：
 * 右栏改成"拉"（poll）而不是"推"（push）——只要 ChatPanel 还在写快照，右栏就一定看得到。
 * 事件通道保留（history/校准等一次性通知仍走它），但实时性**不再依赖**它。
 *
 * 对齐业界做法：Cline 的 token 进度条由 `TaskHeader` 从**单一 webview 状态通道**（gRPC
 * `subscribeToState`）读取 `lastApiReqTotalTokens` 渲染，而不是靠逐值事件推送 ——
 * 单一数据源 + 组件自取，天然没有"某个事件没到就冻住"的状态。
 */

export interface LiveMonitorSnapshot {
  sessionId: string;
  used: number;
  cap: number;
  replyTokens: number;
  reasonTokens: number;
  elapsedMs: number;
  streaming: boolean;
  /** 写入时刻（ms）——取样方可据此判断快照是否已过期（陈旧快照不覆盖校准值） */
  updatedAt: number;
}

const liveMonitor = { current: null as LiveMonitorSnapshot | null };

/** ChatPanel 每帧写入（纯内存赋值，不触发任何 React 渲染） */
export function publishLiveMonitor(snap: Omit<LiveMonitorSnapshot, "updatedAt">): void {
  liveMonitor.current = { ...snap, updatedAt: Date.now() };
}

/** 右栏按拍子取样。sessionId 不匹配 → null（跨会话隔离）；快照过旧（>3s 无更新）→ null */
export function readLiveMonitor(sessionId: string, maxAgeMs = 3000): LiveMonitorSnapshot | null {
  const s = liveMonitor.current;
  if (!s) { return null; }
  if (sessionId && s.sessionId && s.sessionId !== sessionId) { return null; }
  if (Date.now() - s.updatedAt > maxAgeMs) { return null; }
  return s;
}
