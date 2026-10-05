




import { describe, it, expect } from "vitest";
import {
  ASK_CANCEL_MARKER,
  ASK_CUSTOM_CHOICE,
  buildAskDecision,
  dequeueAsk,
  enqueueAsk,
  headAsk,
  initialAskSelection,
  canSubmitAsk,
  safeRecommendation,
  consequenceAt,
} from "../../gui/src/renderer/pages/askState.js";

describe("ask_state：buildAskDecision（选项/自定义/跳过 → AskUserDecision）", () => {
  it("普通选项：answer=选项文本，choice=同一文本（模型据此区分『点选』），skipped=false", () => {
    const d = buildAskDecision("req-1", "方案A", undefined);
    expect(d).toEqual({ requestId: "req-1", answer: "方案A", skipped: false, choice: "方案A" });
  });

  it("自定义选项：answer=去除首尾空白后的自填文本，且**不带 choice**（不能冒充点选项）", () => {
    const d = buildAskDecision("req-1", "__custom", "  自定义需求  ");
    expect(d.answer).toBe("自定义需求");
    expect(d.choice).toBeUndefined();
  });

  it("自定义但空文本：兜底「（未填写）」（保留既有跳过语义）", () => {
    const d = buildAskDecision("req-1", "__custom", "   ");
    expect(d.answer).toBe("（未填写）");
    expect(d.skipped).toBe(false);
    expect(d.choice).toBeUndefined();
  });

  it("跳过：answer 兜底「（未填写）」，不抛错，且无 choice（空选项不是一次选择）", () => {
    const d = buildAskDecision("req-1", "", "（跳过）");
    expect(d.answer).toBe("（未填写）");
    expect(d.choice).toBeUndefined();
  });
});

describe("ask_state：ask 队列（并发提问不孤儿化）", () => {
  it("两次提问按到达顺序排队，队首是先到的那条", () => {
    let q = enqueueAsk([], { requestId: "r1", agentId: "a", agentName: "x", question: "第一问", options: ["A"] });
    q = enqueueAsk(q, { requestId: "r2", agentId: "a", agentName: "x", question: "第二问", options: ["B"] });
    expect(q.map((x) => x.requestId)).toEqual(["r1", "r2"]);
    expect(headAsk(q)?.requestId).toBe("r1");
  });

  it("答完队首后自动露出下一条，直到队列空", () => {
    let q = enqueueAsk([], { requestId: "r1", agentId: "a", agentName: "x", question: "q1", options: [] });
    q = enqueueAsk(q, { requestId: "r2", agentId: "a", agentName: "x", question: "q2", options: [] });
    q = dequeueAsk(q, "r1");
    expect(headAsk(q)?.requestId).toBe("r2");
    q = dequeueAsk(q, "r2");
    expect(headAsk(q)).toBeNull();
  });

  it("同 requestId 重复投递不入队两次", () => {
    const one = { requestId: "r1", agentId: "a", agentName: "x", question: "q", options: [] };
    expect(enqueueAsk(enqueueAsk([], one), one)).toHaveLength(1);
  });

  it("出队不存在的 requestId 返回原数组（不打断正在填的答案）", () => {
    const q = enqueueAsk([], { requestId: "r1", agentId: "a", agentName: "x", question: "q", options: [] });
    expect(dequeueAsk(q, "nope")).toBe(q);
  });

  it("自定义哨兵常量仍是 __custom（与界面渲染分支同源）", () => {
    expect(ASK_CUSTOM_CHOICE).toBe("__custom");
    expect(ASK_CANCEL_MARKER.length).toBeGreaterThan(0);
  });
});

describe("ask_state：initialAskSelection（初始选中）", () => {
  it("有选项默认选第一个", () => {
    expect(initialAskSelection(["A", "B"])).toBe("A");
  });
  it("空选项进入自定义输入", () => {
    expect(initialAskSelection([])).toBe("__custom");
  });
});

describe("ask_state：canSubmitAsk（提交按钮可用性，与 ChatPanel disabled 一致）", () => {
  it("提交中不可点（无论选中什么）", () => {
    expect(canSubmitAsk(true, "A", "")).toBe(false);
    expect(canSubmitAsk(true, "__custom", "内容")).toBe(false);
  });
  it("普通选项选中即可点", () => {
    expect(canSubmitAsk(false, "A", "")).toBe(true);
  });
  it("自定义模式需非空文本", () => {
    expect(canSubmitAsk(false, "__custom", "")).toBe(false);
    expect(canSubmitAsk(false, "__custom", "   ")).toBe(false);
    expect(canSubmitAsk(false, "__custom", "要自己写")).toBe(true);
  });
});

describe("ask_state：safeRecommendation / consequenceAt（推荐下标与后果读取钳制）", () => {
  const options = ["A", "B", "C"];
  it("合法下标原样返回", () => {
    expect(safeRecommendation(options, 1)).toBe(1);
  });
  it("undefined / 越界 / 非整数 → undefined（UI 不标注不崩）", () => {
    expect(safeRecommendation(options, undefined)).toBeUndefined();
    expect(safeRecommendation(options, 3)).toBeUndefined();
    expect(safeRecommendation(options, -1)).toBeUndefined();
    expect(safeRecommendation(options, 1.5)).toBeUndefined();
    expect(safeRecommendation([], 0)).toBeUndefined();
  });
  it("consequenceAt：缺省/越界 → undefined", () => {
    expect(consequenceAt(["x", "y"], 1)).toBe("y");
    expect(consequenceAt(undefined, 0)).toBeUndefined();
    expect(consequenceAt(["x"], 5)).toBeUndefined();
  });
});