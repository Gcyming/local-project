/**
 * tests/core-ts/live-monitor.spec.ts — 右栏实时监测的**取样通道**（A-982）。
 *
 * 背景：用户第三次反馈"右栏所有实时监测都不实时，Agent 输出完才跳变"。
 * 前两次修复都在**事件推送链**上找问题（debounce→throttle、压缩期不跳过…），
 * 但那条链上任何一处守卫失效都会让数值静默冻死且**不报错、测不出**：
 *   ① `p.sessionId !== sessionIdRef.current` 直接丢弃事件；
 *   ② 发送侧 120ms 节流 + 右栏 1s 合并，两窗口叠加；
 *   ③ 右栏卸载重挂（收起/展开、切会话）时订阅重建，重建瞬间的事件全落空。
 * 本次改成**拉取式**：ChatPanel 每帧写内存快照，右栏每 250ms 自己取。
 * 本文件锁死这条通道的语义（跨会话隔离、过期快照不采用）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { publishLiveMonitor, readLiveMonitor } from "../../gui/src/renderer/pages/ChatPanel.js";

const snap = (sessionId: string) => ({
  sessionId, used: 12345, cap: 524288, replyTokens: 300,
  reasonTokens: 120, elapsedMs: 62000, streaming: true,
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("publishLiveMonitor / readLiveMonitor（右栏实时取样的唯一通道）", () => {
  it("发布的快照能被同一会话读到（这就是「流式中右栏跟着走」的数据源）", () => {
    publishLiveMonitor(snap("s1"));
    const s = readLiveMonitor("s1");
    expect(s).not.toBeNull();
    expect(s!.used).toBe(12345);
    expect(s!.replyTokens).toBe(300);
    expect(s!.reasonTokens).toBe(120);
    expect(s!.elapsedMs).toBe(62000);
  });

  it("跨会话隔离：别的会话读到 null（不把 A 会话的在途数字画到 B 会话）", () => {
    publishLiveMonitor(snap("s1"));
    expect(readLiveMonitor("s2")).toBeNull();
  });

  it("会话 id 任一侧为空 → 不做隔离（恢复态/未就绪时仍要能看到数字）", () => {
    publishLiveMonitor(snap(""));
    expect(readLiveMonitor("s1")).not.toBeNull();
    publishLiveMonitor(snap("s1"));
    expect(readLiveMonitor("")).not.toBeNull();
  });

  it("快照过期（流已停止写快照 > 3s）→ 不采用，避免把残值一直画在右栏", () => {
    publishLiveMonitor(snap("s1"));
    expect(readLiveMonitor("s1")).not.toBeNull();
    vi.advanceTimersByTime(3001);
    expect(readLiveMonitor("s1")).toBeNull();
  });

  it("连续写入 → 读到的一定是最新一帧（不缓存旧值）", () => {
    publishLiveMonitor({ ...snap("s1"), replyTokens: 300 });
    publishLiveMonitor({ ...snap("s1"), replyTokens: 700 });
    expect(readLiveMonitor("s1")!.replyTokens).toBe(700);
  });
});
