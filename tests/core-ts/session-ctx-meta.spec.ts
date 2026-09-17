/**
 * session-ctx-meta.spec.ts — 会话级「思考时间线 + 窗口占用」持久化纯函数回归（A-934/A-935）。
 * 锁死三条核心语义：
 *  1. updateSessionCtxMeta：占用快照按序数合并写入，无时间线/占位时不覆盖旧值；
 *  2. attachTimelineToHistory：加载历史时按 assistant 序数（user/assistant 交错）回填交错时间线；
 *  3. restoreUsed：无持久化占用显式归 0（切会话防残留上一会话数值的根因）。
 * 环境：vitest node（无 localStorage）——测试内注入内存存储桩。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  sessionCtxStorageKey,
  readSessionCtxMeta,
  updateSessionCtxMeta,
  attachTimelineToHistory,
  restoreUsed,
  type SessionCtxMeta,
  type TimelineStepLite,
} from "../../gui/src/renderer/pages/sessionCtxMeta.js";

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string): string | null => mem.get(k) ?? null,
    setItem: (k: string, v: string): void => { mem.set(k, v); },
    removeItem: (k: string): void => { mem.delete(k); },
    clear: (): void => { mem.clear(); },
    key: (): string | null => null,
    length: 0,
  } as Storage;
});

const AG = "a1";
const SID = "s1";
const mkMeta = (used = 0, cap = 0, tl: Record<number, unknown> = {}): SessionCtxMeta =>
  ({ used, cap, timelineByAssistantIdx: tl as SessionCtxMeta["timelineByAssistantIdx"] });

describe("updateSessionCtxMeta（占用快照合并写入）", () => {
  it("首写：used/cap/timeline 按序数完整落盘，可再读出", () => {
    const tl: TimelineStepLite[] = [{ kind: "think", text: "先想" }, { kind: "tool", name: "file_list", label: "file_list" }];
    updateSessionCtxMeta(AG, SID, 1, { used: 1200, cap: 32000, timeline: tl });
    const meta = readSessionCtxMeta(AG, SID);
    expect(meta).not.toBeNull();
    expect(meta!.used).toBe(1200);
    expect(meta!.cap).toBe(32000);
    expect(meta!.timelineByAssistantIdx[1]).toHaveLength(2);
    expect(meta!.timelineByAssistantIdx[1][0]).toEqual({ kind: "think", text: "先想" });
  });

  it("连续多条回复：序数递增写入，各自保留", () => {
    updateSessionCtxMeta(AG, SID, 1, { used: 100, timeline: [{ kind: "think", text: "t1" }] });
    updateSessionCtxMeta(AG, SID, 2, { used: 900, cap: 32000, timeline: [{ kind: "think", text: "t2" }] });
    const meta = readSessionCtxMeta(AG, SID)!;
    expect(meta.used).toBe(900);
    expect(meta.cap).toBe(32000);
    expect(Object.keys(meta.timelineByAssistantIdx).sort()).toEqual(["1", "2"]);
  });

  it("无时间线/无占用时不清除旧值（占位参数 undefined 不覆盖）", () => {
    updateSessionCtxMeta(AG, SID, 1, { used: 500, cap: 32000, timeline: [{ kind: "think", text: "t" }] });
    updateSessionCtxMeta(AG, SID, 2, {}); // 空负载（如 interrupted 无 usage）
    const meta = readSessionCtxMeta(AG, SID)!;
    expect(meta.used).toBe(500);
    expect(meta.cap).toBe(32000);
    expect(meta.timelineByAssistantIdx[1]).toBeDefined();
  });

  it("跨会话隔离：不同 sessionId 互不污染", () => {
    updateSessionCtxMeta(AG, "s1", 1, { used: 100, timeline: [{ kind: "think", text: "a" }] });
    updateSessionCtxMeta(AG, "s2", 1, { used: 200, timeline: [{ kind: "think", text: "b" }] });
    expect(readSessionCtxMeta(AG, "s1")!.used).toBe(100);
    expect(readSessionCtxMeta(AG, "s2")!.used).toBe(200);
  });
});

describe("attachTimelineToHistory（按 assistant 序数回填交错时间线）", () => {
  const history = [
    { role: "user", content: "分析项目" },
    { role: "assistant", content: "好的", reasoning: "用户让我分析…" },
    { role: "user", content: "继续" },
    { role: "assistant", content: "结论", reasoning: "我读取了…" },
  ];

  it("有 meta：第 1/2 条 assistant 分别回填其序数时间线", () => {
    const meta = mkMeta(0, 0, {
      1: [{ kind: "think", text: "一思" }, { kind: "tool", name: "file_read", label: "读取 x" }],
      2: [{ kind: "think", text: "二思" }],
    });
    const out = attachTimelineToHistory(history, meta);
    expect(out[0]).toEqual({ assistantOrdinal: undefined });
    expect(out[1].assistantOrdinal).toBe(1);
    expect(out[1].timeline![0].kind).toBe("think");
    expect((out[1].timeline![1] as { name?: string }).name).toBe("file_read");
    expect(out[3].assistantOrdinal).toBe(2);
    expect(out[3].timeline![0]).toEqual({ kind: "think", text: "二思" });
  });

  it("无 meta：assistant 序数仍递增但 timeline 为空（回退文本形态）", () => {
    const out = attachTimelineToHistory(history, null);
    expect(out[1].assistantOrdinal).toBe(1);
    expect(out[1].timeline).toBeUndefined();
    expect(out[1].reasoning).toContain("用户让我分析");
    expect(out[3].assistantOrdinal).toBe(2);
  });

  it("序数不因列表内其它角色错位（交错 user/assistant 恒定正确）", () => {
    const mixed = [
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" }, // 连续两条 assistant（异常但需容忍）
    ];
    const meta = mkMeta(0, 0, { 1: [{ kind: "think", text: "x" }], 3: [{ kind: "think", text: "y" }] });
    const out = attachTimelineToHistory(mixed, meta);
    expect(out[1].assistantOrdinal).toBe(1);
    expect(out[3].assistantOrdinal).toBe(2); // 无 meta.timelineByAssistantIdx[2] → 无时间线
    expect(out[3].timeline).toBeUndefined();
    expect(out[4].assistantOrdinal).toBe(3);
    expect(out[4].timeline![0]).toEqual({ kind: "think", text: "y" });
  });
});

describe("restoreUsed（切会话防残留）", () => {
  it("有持久化占用 → 恢复该值", () => {
    expect(restoreUsed(mkMeta(8800, 32000))).toBe(8800);
  });
  it("无 meta / used<=0 → 显式归 0（否则残留上一会话）", () => {
    expect(restoreUsed(null)).toBe(0);
    expect(restoreUsed(mkMeta(0, 32000))).toBe(0);
  });
});

describe("storage key 隔离", () => {
  it("同一 Agent 不同会话 key 不冲突", () => {
    expect(sessionCtxStorageKey("a1", "s1")).toBe("slime_ctxmeta_a1_s1");
    expect(sessionCtxStorageKey("a1", "s2")).not.toBe(sessionCtxStorageKey("a1", "s1"));
  });
});