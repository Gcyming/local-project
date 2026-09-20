/**
 * tests/gui/ask-state.spec.ts — F：PermissionDialog（ask_user 决策分叉窗口）状态机纯逻辑。
 * 生产源 askState.ts 与 ChatPanel 弹窗同源（buildAskDecision/initialAskSelection/canSubmitAsk
 * 已接入 ChatPanel 三处），测试即生产，杜绝"测试未接生产"偏差。
 */
import { describe, it, expect } from "vitest";
import {
  buildAskDecision,
  initialAskSelection,
  canSubmitAsk,
  safeRecommendation,
  consequenceAt,
} from "../../gui/src/renderer/pages/askState.js";

describe("ask_state：buildAskDecision（选项/自定义/跳过 → AskUserDecision）", () => {
  it("普通选项：answer=选项文本，skipped=false", () => {
    const d = buildAskDecision("req-1", "方案A", undefined);
    expect(d).toEqual({ requestId: "req-1", answer: "方案A", skipped: false });
  });

  it("自定义选项：answer=去除首尾空白后的自填文本", () => {
    expect(buildAskDecision("req-1", "__custom", "  自定义需求  ").answer).toBe("自定义需求");
  });

  it("自定义但空文本：兜底「（未填写）」（保留既有跳过语义）", () => {
    const d = buildAskDecision("req-1", "__custom", "   ");
    expect(d.answer).toBe("（未填写）");
    expect(d.skipped).toBe(false);
  });

  it("跳过：answer 兜底「（未填写）」，不抛错", () => {
    const d = buildAskDecision("req-1", "", "（跳过）");
    expect(d.answer).toBe("（未填写）");
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