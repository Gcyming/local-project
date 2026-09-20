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
/** A-1021b：A-966 的 history.jsonl 时间线此前**只写不读**。
 *
 *  线上证据（config/history.jsonl）：第 96/98 行（在当前会话里结束）带 timeline，
 *  第 97 行——elapsed_ms=349872，与用户截图"回复耗时 349.9s"完全一致——timeline 缺失，
 *  于是那条回复的思考历程只剩 reasoning 文本、塌成一个节点。
 *  原因之一是"流式期间切走会话"时 onDone 走早退分支、不落盘；
 *  但**即使落盘了，加载侧也从不读它** —— 这里锁死第二条：记录自带的 timeline 必须能被回填。 */
describe("attachTimelineToHistory —— 记录自带 timeline 的兜底（A-1021b）", () => {
  // 磁盘形态：kind 是 string（shared/ipc.ts 的 ConversationMessage.timeline），不是字面量联合
  const recordTl = [
    { kind: "think", text: "先看结构" },
    { kind: "tool", name: "file_read", label: "读取 a.ts", detail: "a.ts" },
    { kind: "think", text: "再改" },
  ];

  it("localStorage 无该序数 → 采用记录自带的 timeline（不再塌成单节点）", () => {
    const msgs = [
      { role: "user", content: "改一下" },
      { role: "assistant", content: "好", reasoning: "先看结构\n\n再改", timeline: recordTl },
    ];
    const out = attachTimelineToHistory(msgs, mkMeta(0, 0, {}));
    expect(out[1].assistantOrdinal).toBe(1);
    expect(out[1].timeline).toHaveLength(3);
    expect(out[1].timeline![1]).toMatchObject({ kind: "tool", name: "file_read" });
  });

  it("meta 为 null（无 localStorage）同样能靠记录恢复", () => {
    const msgs = [{ role: "assistant", content: "好", reasoning: "r", timeline: recordTl }];
    expect(attachTimelineToHistory(msgs, null)[0].timeline).toHaveLength(3);
  });

  it("localStorage 有值 → 优先 localStorage（保持既有行为，不改已工作路径）", () => {
    const msgs = [{ role: "assistant", content: "好", reasoning: "r", timeline: recordTl }];
    const meta = mkMeta(0, 0, { 1: [{ kind: "think", text: "来自 localStorage" }] });
    const out = attachTimelineToHistory(msgs, meta);
    expect(out[0].timeline).toHaveLength(1);
    expect(out[0].timeline![0]).toEqual({ kind: "think", text: "来自 localStorage" });
  });

  it("两边都没有 → undefined（交给调用方退文本形态）", () => {
    const msgs = [{ role: "assistant", content: "好", reasoning: "r" }];
    expect(attachTimelineToHistory(msgs, mkMeta(0, 0, {}))[0].timeline).toBeUndefined();
  });

  it("记录里的空数组不当作有效时间线（不给折叠卡造幽灵节点）", () => {
    const msgs = [{ role: "assistant", content: "好", reasoning: "r", timeline: [] }];
    expect(attachTimelineToHistory(msgs, null)[0].timeline).toBeUndefined();
  });

  it("user 消息不带 timeline / 序数（记录里的 timeline 挂在 assistant 上）", () => {
    const msgs = [{ role: "user", content: "u", timeline: recordTl }];
    expect(attachTimelineToHistory(msgs, null)[0]).toEqual({ assistantOrdinal: undefined });
  });
});
