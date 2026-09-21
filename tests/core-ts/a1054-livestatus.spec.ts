/**
 * tests/core-ts/a1054-livestatus.spec.ts — 底部「实时状态行」文案推导的守卫。
 *
 * 被测：`gui/src/renderer/pages/liveStatus.ts`（纯逻辑）。
 *
 * 锁三件最容易被改坏、且坏了不会被任何报错发现的事：
 *  ① **优先级顺序**（等用户 > 压缩 > 停止 > 输出 > 工具 > 思考 > 等首包）；
 *  ② **等待用户输入时不许播扫光**（播了就是在骗用户"它还在跑、你等着就好"）；
 *  ③ **上限未知时不显示百分比**（0%/∞ 比不显示更糟——右栏已是同一口径）。
 *
 * ⚠️ 文案断言只锚「有没有说清这件事」，不逐字锁死；行为断言锚 `kind`。
 * ⚠️ 验收标准是**变异测试**（见 `gui/scripts/mut-a1054.mjs`）。
 */
import { describe, it, expect } from "vitest";
import {
  buildDetail,
  deriveLiveStatus,
  estimateTokens,
  formatElapsed,
} from "../../gui/src/renderer/pages/liveStatus.js";

describe("A-1054 状态行：已用时格式化", () => {
  it("未开始计时（0 / undefined / 负数）→ 空串（不显示 0s）", () => {
    expect(formatElapsed(0)).toBe("");
    expect(formatElapsed(undefined)).toBe("");
    expect(formatElapsed(-5)).toBe("");
  });

  it("1 分钟以内按秒；跨分钟给 m+两位秒（补零，避免 3m4s / 3m40s 分不清）", () => {
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(59_900)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(184_000)).toBe("3m04s");
    expect(formatElapsed(244_000)).toBe("4m04s");
  });
});

describe("A-1054 状态行：token 估算与次要信息", () => {
  it("4 字符 ≈ 1 token（与右栏在途估算同口径）", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(10)).toBe(3);
  });

  it("什么数据都没有 → 空串（调用方据此不渲染那一段）", () => {
    expect(buildDetail({ loading: true })).toBe("");
  });

  it("已用时 / 工具次数 / 在途 token 依次拼出", () => {
    const d = buildDetail({ loading: true, elapsedMs: 12_000, toolCount: 3, replyChars: 40 });
    expect(d).toContain("12s");
    expect(d).toContain("工具 3 次");
    expect(d).toContain("≈10 tok");
  });

  it("上限未知（cap=0）→ 不显示百分比；有上限才显示，且封顶 99%", () => {
    // 反空转：这两条必须给出不同结果，否则"不显示百分比"的守卫是假的
    expect(buildDetail({ loading: true, ctxUsed: 5000, ctxCap: 0 })).not.toContain("%");
    expect(buildDetail({ loading: true, ctxUsed: 50_000, ctxCap: 100_000 })).toContain("50%");
    expect(buildDetail({ loading: true, ctxUsed: 200_000, ctxCap: 100_000 })).toContain("99%");
  });

  it("有工具次数就一定有它；0 次不写「工具 0 次」", () => {
    expect(buildDetail({ loading: true, toolCount: 0 })).not.toContain("工具");
    expect(buildDetail({ loading: true, toolCount: 1 })).toContain("工具 1 次");
  });
});

describe("A-1054 状态行：阶段推导（优先级即规格）", () => {
  it("空闲（无在途阶段）→ null（这一行整体不显示）", () => {
    expect(deriveLiveStatus({ loading: false })).toBeNull();
  });

  it("compress 的 done 是收尾态、不算在途：不 loading 时仍 → null（否则状态行会永久挂着）", () => {
    expect(deriveLiveStatus({ loading: false, compressStage: "done" })).toBeNull();
  });

  it("等审批 → awaiting-approval，且**不播扫光**", () => {
    const s = deriveLiveStatus({ loading: true, awaitingApproval: true });
    expect(s?.kind).toBe("awaiting-approval");
    expect(s?.animated).toBe(false);
  });

  it("等审批**不受 loading 影响**：等待态本身就是「这一轮停在这里等你」，必须显示", () => {
    // 反空转：如果这条不成立，就可以把 `if (!loading) return null` 提到最前而**所有测试仍绿**
    // —— 那是等价变异体（守卫锁不到）。
    expect(deriveLiveStatus({ loading: false, awaitingApproval: true })?.kind).toBe("awaiting-approval");
    expect(deriveLiveStatus({ loading: false, awaitingAnswer: true })?.kind).toBe("awaiting-answer");
  });

  it("等回答 → awaiting-answer，同样不播扫光", () => {
    const s = deriveLiveStatus({ loading: true, awaitingAnswer: true });
    expect(s?.kind).toBe("awaiting-answer");
    expect(s?.animated).toBe(false);
  });

  it("**等用户压过一切**：同时有压缩/工具/正文时，仍然报「等用户」且不播扫光", () => {
    const s = deriveLiveStatus({
      loading: true, awaitingApproval: true, compressStage: "summarize",
      lastToolLabel: "写入文件", toolCount: 2, replyChars: 100,
    });
    expect(s?.kind).toBe("awaiting-approval");
    expect(s?.animated).toBe(false);
  });

  it("压缩（prep / summarize / trunc）→ compress 且播扫光", () => {
    for (const stage of ["prep", "summarize", "trunc"] as const) {
      const s = deriveLiveStatus({ loading: true, compressStage: stage });
      expect(s?.kind).toBe("compress");
      expect(s?.animated).toBe(true);
    }
  });

  it("停止中（不 loading 也要显示：收尾过程用户同样需要看到）→ stopping", () => {
    const s = deriveLiveStatus({ loading: false, stopping: true });
    expect(s?.kind).toBe("stopping");
    expect(s?.animated).toBe(true);
  });

  it("**已开始输出正文时，「正在输出」压过「正在调用工具」**（两者可同时为真）", () => {
    const s = deriveLiveStatus({ loading: true, replyChars: 5, lastToolLabel: "读取文件", toolCount: 1 });
    expect(s?.kind).toBe("writing");
  });

  it("在跑工具 → tool，且文案带上**已解析的人类可读名**（不是裸工具名）", () => {
    const s = deriveLiveStatus({ loading: true, lastToolLabel: "写入文件", toolCount: 2, elapsedMs: 8000 });
    expect(s?.kind).toBe("tool");
    expect(s?.text).toContain("写入文件");
    expect(s?.detail).toContain("工具 2 次");
  });

  it("只有思考产出 → thinking", () => {
    expect(deriveLiveStatus({ loading: true, reasonChars: 300 })?.kind).toBe("thinking");
  });

  it("loading 但什么都还没来 → preparing 且播扫光（这正是「半天不输出内容」时那一行）", () => {
    const s = deriveLiveStatus({ loading: true, elapsedMs: 25_000 });
    expect(s?.kind).toBe("preparing");
    expect(s?.animated).toBe(true);
    expect(s?.detail).toContain("25s");
  });

  it("**没有在跑的轮次就不许报「正在输出」**：loading=false 时即使有在途字符也 → null", () => {
    expect(deriveLiveStatus({ loading: false, replyChars: 999, reasonChars: 999 })).toBeNull();
  });

  it("所有在途阶段都给出非空主文案（漏一个会让状态行显示空白）", () => {
    const inputs = [
      { loading: true, awaitingApproval: true },
      { loading: true, awaitingAnswer: true },
      { loading: true, compressStage: "prep" as const },
      { loading: true, stopping: true },
      { loading: true, replyChars: 1 },
      { loading: true, lastToolLabel: "网络搜索" },
      { loading: true, reasonChars: 1 },
      { loading: true },
    ];
    for (const input of inputs) {
      const s = deriveLiveStatus(input);
      expect(s, `输入 ${JSON.stringify(input)} 没有推出状态`).toBeTruthy();
      expect((s?.text ?? "").length).toBeGreaterThan(1);
    }
  });
});
