/**
 * tests/core-ts/stream-monitor.spec.ts — A-974-R9：底部监测栏计数器「快照 / 恢复 / 后台累计」回归。
 *
 * 锁死的用户症状：切会话再切回后，当前轮 Agent 输出的监测记录（tokens / 耗时 / 吞吐 / model）清零重算。
 * 根因：计数器只活在组件内 ref，切走即随实例销毁，快照只存了流内容没存计数器。
 * 本测试锁死三条语义：
 *  1. tokens 恒 = (正文字符 + 思考字符) / 4（正文与思考都计入）；
 *  2. 耗时由**绝对起点**折算 → 切走时段一并计入（不会少算、不会负数）；
 *  3. model 只在为空时回填（后续 chunk 不回冲已有值）。
 */
import { describe, it, expect } from "vitest";
import {
  createMonitor,
  bumpMonitor,
  monitorElapsed,
  tokensFromChars,
  CHARS_PER_TOKEN,
} from "../../gui/src/renderer/pages/streamMonitor.js";

describe("streamMonitor（监测计数器纯函数）", () => {
  it("createMonitor：初始全零、保留起点与模型", () => {
    const m = createMonitor(1000, "agnes-3.0-flash");
    expect(m).toEqual({ tokens: 0, startedAt: 1000, model: "agnes-3.0-flash", replyChars: 0, reasonChars: 0 });
  });

  it("tokensFromChars：正文 + 思考合并折算，4 字符 ≈ 1 token", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(tokensFromChars(40, 0)).toBe(10);
    expect(tokensFromChars(0, 40)).toBe(10);
    expect(tokensFromChars(40, 40)).toBe(20); // 关键：思考也计入（R6 前的缺陷是只算正文）
    expect(tokensFromChars(0, 0)).toBe(0);
    expect(tokensFromChars(-5, 0)).toBe(0); // 异常输入不产生负值
  });

  it("bumpMonitor：增量累计并同步回算 tokens（正文 / 思考分别累加）", () => {
    const m = createMonitor(0);
    bumpMonitor(m, 100, 0);
    expect(m.replyChars).toBe(100);
    expect(m.tokens).toBe(25);
    bumpMonitor(m, 0, 300);
    expect(m.reasonChars).toBe(300);
    expect(m.tokens).toBe(100); // (100 + 300) / 4
  });

  it("bumpMonitor：model 仅首次回填，后续不回冲", () => {
    const m = createMonitor(0);
    bumpMonitor(m, 4, 0, "m-first");
    expect(m.model).toBe("m-first");
    bumpMonitor(m, 4, 0, "m-later");
    expect(m.model).toBe("m-first");
  });

  it("bumpMonitor：忽略非正增量（不产生负数、不打乱 tokens）", () => {
    const m = createMonitor(0);
    bumpMonitor(m, 40, 0);
    bumpMonitor(m, -10, -10);
    expect(m.replyChars).toBe(40);
    expect(m.reasonChars).toBe(0);
    expect(m.tokens).toBe(10);
  });

  it("monitorElapsed：由绝对起点折算，切走时段一并计入", () => {
    const m = createMonitor(10_000);
    // 切走 30s 后切回：耗时应为 30s（含离开时段，而非从切回那刻重算）
    expect(monitorElapsed(m, 40_000)).toBe(30_000);
  });

  it("monitorElapsed：未开始 / 空值 → 0；时钟回拨 → 0（不出现负数）", () => {
    expect(monitorElapsed(createMonitor(0), 40_000)).toBe(0);
    expect(monitorElapsed(null, 40_000)).toBe(0);
    expect(monitorElapsed(undefined, 40_000)).toBe(0);
    expect(monitorElapsed(createMonitor(50_000), 40_000)).toBe(0);
  });
});
