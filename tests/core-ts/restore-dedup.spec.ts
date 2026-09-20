/**
 * restore-dedup.spec.ts — 会话切回恢复的「历史 ↔ 在途气泡」去重纯函数回归（A-974-R4）。
 *
 * 锁死的用户症状（两轮反馈）：「切换会话后像是被截断了又重新输出一遍」——
 * 后台流跑完落库后切回，历史里已有**完整**回复，而渲染层占位气泡仍持有**较短**的 cached.partial，
 * 二者同时渲染 → 一条完整 + 一条截断。旧实现只给结算气泡去重且用精确相等，占位气泡完全没去重。
 */
import { describe, it, expect } from "vitest";
import {
  normalizeForCompare,
  isCoveredByHistory,
  decideRestoreKeep,
} from "../../gui/src/renderer/pages/restoreDedup.js";

describe("normalizeForCompare", () => {
  it("抹掉换行/空格/制表（渲染上等价的差异不应导致去重失败）", () => {
    expect(normalizeForCompare("你好 世界\n第二行")).toBe("你好世界第二行");
    expect(normalizeForCompare("  a\tb\n\n c ")).toBe("abc");
  });

  it("null/undefined → 空串（不抛错）", () => {
    expect(normalizeForCompare(null)).toBe("");
    expect(normalizeForCompare(undefined)).toBe("");
  });
});

describe("isCoveredByHistory", () => {
  it("精确相等（含空白差异）→ 覆盖", () => {
    expect(isCoveredByHistory("答 案", ["答案"])).toBe(true);
  });

  it("候选是历史的子串（截断占位 vs 完整回复）→ 覆盖（R4 核心场景）", () => {
    const full = "还没完全好——本体写完了，但 app.py 是否真正接上了，我需要读磁盘确认";
    expect(isCoveredByHistory("还没完全好——本体写完了", [full])).toBe(true);
  });

  it("候选包含历史（本地比落库更全）→ 也视为同一条，避免双份", () => {
    expect(isCoveredByHistory("完整回复内容", ["完整回复"])).toBe(true);
  });

  it("内容无关 → 不覆盖", () => {
    expect(isCoveredByHistory("另一条完全不同的回复", ["这条回复"])).toBe(false);
  });

  it("空候选/空历史一律不覆盖（不能误删活泼占位或凭空值去重）", () => {
    expect(isCoveredByHistory("", ["任何内容"])).toBe(false);
    expect(isCoveredByHistory("   ", ["任何内容"])).toBe(false);
    expect(isCoveredByHistory("内容", [])).toBe(false);
    expect(isCoveredByHistory("内容", ["", "  "])).toBe(false);
  });
});

describe("decideRestoreKeep", () => {
  it("流仍活跃、历史尚无该回复 → 保留占位气泡（不误删活泼占位）", () => {
    const r = decideRestoreKeep({
      liveContent: "正在输出的半截正文",
      historyAssistantTexts: ["上一轮的完整回复"],
    });
    expect(r.keepLive).toBe(true);
    expect(r.keepSettled).toBe(false);
  });

  it("历史已有完整回复、占位气泡只有较短 partial → 丢弃占位（根治截断重输出）", () => {
    const full = "还没完全好——本体写完了，但 app.py 是否真正接上了，我需要读磁盘确认，不再空口说。";
    const r = decideRestoreKeep({
      liveContent: "还没完全好——本体写完了",
      historyAssistantTexts: [full],
    });
    expect(r.keepLive).toBe(false);
  });

  it("主进程 isActive 确认流已死 → 丢弃幽灵占位（即使内容未被历史覆盖）", () => {
    const r = decideRestoreKeep({
      liveContent: "（恢复中…）",
      historyAssistantTexts: [],
      streamConfirmedDead: true,
    });
    expect(r.keepLive).toBe(false);
  });

  it("占位仅「（恢复中…）」且流未确认结束 → 保留（等 chunk 续长）", () => {
    const r = decideRestoreKeep({ liveContent: "（恢复中…）", historyAssistantTexts: [] });
    expect(r.keepLive).toBe(true);
  });

  it("结算气泡：历史已落库同内容 → 丢弃；未落库 → 保留（防 done 后切回丢回复的竞态窗口）", () => {
    const done = "已经完成的完整回复";
    expect(decideRestoreKeep({ settledContent: done, historyAssistantTexts: [done] }).keepSettled).toBe(false);
    expect(decideRestoreKeep({ settledContent: done, historyAssistantTexts: ["更早的一条"] }).keepSettled).toBe(true);
  });

  it("空内容一律不保留（避免空气泡/幽灵气泡）", () => {
    const r = decideRestoreKeep({ liveContent: "", settledContent: undefined, historyAssistantTexts: ["x"] });
    expect(r.keepLive).toBe(false);
    expect(r.keepSettled).toBe(false);
  });

  it("历史为空（首答场景）：活跃占位与结算气泡都保留（不丢现场）", () => {
    const r = decideRestoreKeep({ liveContent: "输出中", settledContent: "已结算正文", historyAssistantTexts: [] });
    expect(r.keepLive).toBe(true);
    expect(r.keepSettled).toBe(true);
  });
});
