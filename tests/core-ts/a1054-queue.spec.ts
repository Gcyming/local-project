











import { describe, it, expect } from "vitest";
import {
  clearAll,
  enqueue,
  nextQueueId,
  peek,
  promote,
  removeAt,
  setMode,
  summarize,
  takeNext,
  type QueuedInstruction,
} from "../../gui/src/renderer/pages/instructionQueue.js";


function item(over: Partial<QueuedInstruction> = {}): QueuedInstruction {
  return {
    id: nextQueueId(),
    text: "补一句",
    mode: "queue",
    images: [],
    sessionId: "s1",
    agentId: "a1",
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

describe("A-1054 队列：入队 / 查看", () => {
  it("入队追加到尾部（后来者不插队）", () => {
    const a = item({ text: "第一" });
    const b = item({ text: "第二" });
    const list = enqueue(enqueue([], a), b);
    expect(list.map((q) => q.text)).toEqual(["第一", "第二"]);
  });

  it("peek 取队首且不改动原数组；空队列 → null", () => {
    const list = [item({ text: "x" })];
    expect(peek(list)?.text).toBe("x");
    expect(list.length).toBe(1);
    expect(peek([])).toBeNull();
  });

  it("id 单调递增且不重复（复用 id 会让 React key 撞车、改错条）", () => {
    const ids = Array.from({ length: 100 }, () => nextQueueId());
    expect(new Set(ids).size).toBe(100);
    for (let i = 1; i < ids.length; i += 1) { expect(ids[i]! > ids[i - 1]!).toBe(true); }
  });
});

describe("A-1054 队列：出队（跨会话隔离 + 绝不吞指令）", () => {
  it("同会话 → 取出队首并返回剩余", () => {
    const a = item({ sessionId: "s1", text: "A" });
    const b = item({ sessionId: "s1", text: "B" });
    const got = takeNext([a, b], "s1");
    expect(got?.item.text).toBe("A");
    expect(got?.rest.map((q) => q.text)).toEqual(["B"]);
  });

  it("**队首属于别的会话 → null，且不吞**（用户切走再切回，指令必须还在）", () => {
    const other = item({ sessionId: "s2", text: "别的会话的" });
    const mine = item({ sessionId: "s1", text: "我的" });
    const list = [other, mine];
    const got = takeNext(list, "s1");
    expect(got).toBeNull();
    
    expect(list.map((q) => q.text)).toEqual(["别的会话的", "我的"]);
    expect(peek(list)?.id).toBe(other.id);
  });

  it("空 sessionId → null（空串必须当「没传」，否则会发到一个不存在的会话）", () => {
    expect(takeNext([item()], "")).toBeNull();
  });

  it("空队列 → null", () => {
    expect(takeNext([], "s1")).toBeNull();
  });

  it("反复出队 = 先进先出，一条不落（队列存在的意义）", () => {
    let list = [item({ text: "1" }), item({ text: "2" }), item({ text: "3" })];
    const sent: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const got = takeNext(list, "s1");
      if (!got) { break; }
      sent.push(got.item.text);
      list = got.rest;
    }
    expect(sent).toEqual(["1", "2", "3"]);
    expect(list).toEqual([]);
  });
});

describe("A-1054 队列：改模式 / 提升 / 删除", () => {
  it("setMode 只改命中项，其余原样（含顺序）", () => {
    const a = item({ text: "A" });
    const b = item({ text: "B" });
    const out = setMode([a, b], b.id, "interrupt");
    expect(out.map((q) => `${q.text}:${q.mode}`)).toEqual(["A:queue", "B:interrupt"]);
  });

  it("setMode 未命中 → 原样返回（不抛、不新建）", () => {
    const list = [item()];
    const out = setMode(list, 999_999, "interrupt");
    expect(out.map((q) => q.mode)).toEqual(["queue"]);
    expect(out.length).toBe(1);
  });

  it("promote 把中间项提到最前，其余相对顺序不变", () => {
    const a = item({ text: "A" });
    const b = item({ text: "B" });
    const c = item({ text: "C" });
    expect(promote([a, b, c], c.id).map((q) => q.text)).toEqual(["C", "A", "B"]);
  });

  it("promote 已是队首 / 不存在 → 原样（幂等，不重排）", () => {
    const a = item({ text: "A" });
    const b = item({ text: "B" });
    expect(promote([a, b], a.id).map((q) => q.text)).toEqual(["A", "B"]);
    expect(promote([a, b], 999_999).map((q) => q.text)).toEqual(["A", "B"]);
  });

  it("removeAt 删中间项；不存在 → 原样", () => {
    const a = item({ text: "A" });
    const b = item({ text: "B" });
    const c = item({ text: "C" });
    expect(removeAt([a, b, c], b.id).map((q) => q.text)).toEqual(["A", "C"]);
    expect(removeAt([a], 999_999).map((q) => q.text)).toEqual(["A"]);
  });

  it("clearAll 得到空队列（会话清理路径）", () => {
    expect(clearAll()).toEqual([]);
    expect(summarize(clearAll())).toBe("");
  });
});




describe("A-1054 队列：摘要", () => {
  it("摘要：空队列给空串（UI 据此整块隐藏），非空给条数", () => {
    expect(summarize([])).toBe("");
    expect(summarize([item(), item()])).toBe("2 条待发");
  });
});
