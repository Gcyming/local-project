/**
 * tests/core-ts/pricing-display.spec.ts — A-989 分时「峰 / 谷」全时段展示回归。
 *
 * 用户诉求原文：「把峰、谷时间端全部显示出来」。
 * 此前「空闲档」不写 windows（缺省 = 其余所有时段，计费语义最准确），
 * 副作用是**界面上完全看不到谷时段**——用户只看到高峰两行，无法确认夜间/周末到底算不算空闲。
 * 本文件锁定：补集推导正确、跨周末不被切碎、展示数据包含全部时段。
 */
import { describe, expect, it } from "vitest";
import {
  complementSpans,
  describeComplementSpans,
  describeTiersForDisplay,
  describePriceTiersForDisplay,
  describeTierSpec,
  formatTierAmounts,
  isTimezoneResolvable,
  resolveTierId,
  type ModelPriceTiers,
} from "../../shared/gen/model-capabilities.js";

/** DeepSeek 官方形态：工作日双高峰（北京时间），并带**官方两列币种** */
const DEEPSEEK_SPEC: ModelPriceTiers = {
  timezone: "Asia/Shanghai",
  tiers: [
    { id: "peak", label: "高峰时段", windows: [
      { days: [1, 2, 3, 4, 5], startMin: 540, endMin: 720 },
      { days: [1, 2, 3, 4, 5], startMin: 840, endMin: 1080 },
    ], priceIn: 0.3, priceOut: 1.2, priceInCny: 2, priceOutCny: 8 },
    { id: "offpeak", label: "空闲时段", priceIn: 0.15, priceOut: 0.6, priceInCny: 1, priceOutCny: 4 },
  ],
};

/** 一段跨度覆盖的分钟数（`daysCrossed === 0` 时即当天内长度） */
function spanMinutes(s: { daysCrossed: number; startMin: number; endMinExclusive: number }): number {
  return s.daysCrossed * 1440 + (s.endMinExclusive - s.startMin);
}

describe("complementSpans：谷时段（补集）推导", () => {
  it("工作日双高峰 → 补集恰好覆盖全部非高峰时刻，且不重不漏", () => {
    const spans = complementSpans(DEEPSEEK_SPEC.tiers[0].windows!);
    // 工作日高峰 = 5×(3h + 4h) = 35h；一周 = 168h → 谷 = 133h
    const totalMin = spans.reduce((acc, s) => acc + spanMinutes(s), 0);
    expect(totalMin).toBe(7 * 1440 - 35 * 60);
  });

  it("跨周末的长谷时段**不被切碎**（周五 18:00 到周一 09:00 是一段）", () => {
    const spans = complementSpans(DEEPSEEK_SPEC.tiers[0].windows!);
    const long = spans.filter((s) => s.daysCrossed >= 2);
    expect(long).toHaveLength(1);
    expect(long[0]).toMatchObject({ startDay: 5, startMin: 18 * 60, endDay: 1, endMinExclusive: 9 * 60, daysCrossed: 3 });
    const lines = describeComplementSpans(DEEPSEEK_SPEC.tiers[0].windows!);
    expect(lines.some((l) => l.includes("周五") && l.includes("周一"))).toBe(true);
  });

  it("谷时段文案逐条列出，合并依据是**连续区间**而非按天切形状（不得重复计时长）", () => {
    const lines = describeComplementSpans(DEEPSEEK_SPEC.tiers[0].windows!);
    // 事实形状：工作日午休 12:00-14:00 五天一形状；周一至周四 18:00→次日 09:00 四天一形状；
    // 周五 18:00 一口气跨到周一 09:00（跨 3 天）单独一段 —— 三者合计 133h，不重不漏。
    expect(lines).toEqual([
      "周一至周五 12:00-14:00",
      "周一至周四 18:00-09:00（次日）",
      "周五 18:00 至 周一 09:00（跨 3 天）",
    ]);
  });

  it("全周都被覆盖 → 补集为空（不得编造出时段）", () => {
    const full = [{ startMin: 0, endMin: 1440 }];
    expect(complementSpans(full)).toEqual([]);
    expect(describeComplementSpans(full)).toEqual(["无（该组窗口已占满整周）"]);
  });

  it("窗口未覆盖到当日最后一分钟 → 只补出该分钟，且七天形状合并成一天一行", () => {
    // 0..1439 覆盖 00:00-23:59，第 1439 分钟（23:59）仍空闲
    const lines = describeComplementSpans([{ startMin: 0, endMin: 1439 }]);
    expect(lines).toEqual(["每天 23:59-24:00"]);
  });

  it("没有任何高峰窗 → 整周全为谷（返回单段而不是空）", () => {
    expect(complementSpans([])).toHaveLength(1);
    expect(describeComplementSpans([])).toEqual(["全周（7×24 小时）"]);
  });
});

describe("describeTiersForDisplay：峰 + 谷**全部**时段", () => {
  it("两个档位都拿到逐条时段，谷档由补集推导（不再只显示高峰）", () => {
    const tiers = describeTiersForDisplay(DEEPSEEK_SPEC);
    expect(tiers).toHaveLength(2);
    const peak = tiers.find((t) => t.id === "peak")!;
    const off = tiers.find((t) => t.id === "offpeak")!;
    expect(peak.isFallback).toBe(false);
    // 同星期的多个窗口合并成一行（`09:00-12:00、14:00-18:00`），不把星期重复两遍
    expect(peak.windowLines).toEqual(["周一至周五 09:00-12:00、14:00-18:00"]);
    expect(off.isFallback).toBe(true);
    // 谷时段必须**逐条可见**，而不是一句"其余时段"
    expect(off.windowLines).toHaveLength(3);
    expect(off.windowLines.join(" ")).toContain("12:00-14:00");
    expect(off.windowLines.join(" ")).toContain("18:00-09:00");
    expect(off.windowLines.join(" ")).toContain("周五 18:00 至 周一 09:00");
  });

  it("不传时刻 → active 一律 undefined（不猜时刻，UI 不撒谎）", () => {
    for (const t of describeTiersForDisplay(DEEPSEEK_SPEC)) {
      expect(t.active).toBeUndefined();
    }
  });

  it("传时刻 → 命中档 active=true，且与 resolveTierId 完全一致（单一判定源）", () => {
    // 北京时间 2026-09-16（周三）10:30 = UTC 02:30 → 高峰
    const peakAt = new Date("2026-09-16T02:30:00Z");
    const tiers = describeTiersForDisplay(DEEPSEEK_SPEC, peakAt);
    expect(tiers.find((t) => t.id === "peak")!.active).toBe(true);
    expect(tiers.find((t) => t.id === "offpeak")!.active).toBe(false);
    expect(resolveTierId(DEEPSEEK_SPEC.tiers, peakAt, DEEPSEEK_SPEC.timezone)!.id).toBe("peak");

    // 北京时间 13:00（午休）= UTC 05:00 → 谷
    const offAt = new Date("2026-09-16T05:00:00Z");
    expect(describeTiersForDisplay(DEEPSEEK_SPEC, offAt).find((t) => t.id === "offpeak")!.active).toBe(true);
  });

  it("周末任意时刻都落在谷档", () => {
    const sat = new Date("2026-09-19T02:30:00Z"); // 北京时间周六 10:30
    expect(describeTiersForDisplay(DEEPSEEK_SPEC, sat).find((t) => t.id === "offpeak")!.active).toBe(true);
  });

  it("时区名不可解析 → active 一律 undefined（不把「解析失败」伪装成「此刻命中兜底档」）", () => {
    expect(isTimezoneResolvable("Asia/Shanghai")).toBe(true);
    const bad: ModelPriceTiers = { timezone: "Not/AZone", tiers: DEEPSEEK_SPEC.tiers };
    expect(isTimezoneResolvable("Not/AZone")).toBe(false);
    const at = new Date("2026-09-16T02:30:00Z");
    for (const t of describeTiersForDisplay(bad, at)) {
      expect(t.active, t.id).toBeUndefined();
    }
    // 计费侧行为**不变**：仍落到兜底档（宁可退回高峰标准价，也不要凭空把成本清零）
    expect(resolveTierId(bad.tiers, at, bad.timezone)!.id).toBe("offpeak");
  });
});

describe("describePriceTiersForDisplay：内置规格接入（含 DeepSeek 当前型号）", () => {
  it("deepseek-flash / v4-pro / 退休别名都取到同一套峰谷规格", () => {
    for (const id of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4-pro"]) {
      const d = describePriceTiersForDisplay(id);
      expect(d, id).toBeTruthy();
      expect(d!.timezone).toBe("Asia/Shanghai");
      expect(d!.tiers.map((t) => t.id)).toEqual(["peak", "offpeak"]);
      expect(d!.tiers[1].windowLines.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("无分时规格的模型 → undefined", () => {
    expect(describePriceTiersForDisplay("claude-sonnet-4-20250514")).toBeUndefined();
    expect(describePriceTiersForDisplay("zz-unlisted-model-xyz")).toBeUndefined();
  });

  it("原有单行文案 describeTierSpec 保持可用（向后兼容，未被替换）", () => {
    expect(describeTierSpec(DEEPSEEK_SPEC)).toContain("高峰时段");
    expect(describeTierSpec(DEEPSEEK_SPEC)).toContain("Asia/Shanghai");
  });
});

describe("档位双币种展示（用户指令：把＄跟人民币分开）", () => {
  it("TierDisplay 必须把官方人民币价**原样透传**（而不是丢掉，让用户自己乘汇率）", () => {
    const tiers = describeTiersForDisplay(DEEPSEEK_SPEC);
    const peak = tiers.find((t) => t.id === "peak")!;
    const off = tiers.find((t) => t.id === "offpeak")!;
    expect([peak.priceInCny, peak.priceOutCny]).toEqual([2, 8]);
    expect([off.priceInCny, off.priceOutCny]).toEqual([1, 4]);
    // 美元列也在，且**不等于**人民币 ÷ 7.2 —— 官方两列非等比，两个数字都要留
    expect(peak.priceIn).toBe(0.3);
    expect(peak.priceInCny! / 7.2).not.toBeCloseTo(peak.priceIn, 3);
  });

  it("formatTierAmounts：两币种都带币种符号，各自独立，不互相折算", () => {
    const amt = formatTierAmounts({ priceIn: 0.3, priceOut: 1.2, priceInCny: 2, priceOutCny: 8 });
    expect(amt.usd).toBe("$0.3 / $1.2");
    expect(amt.cny).toBe("¥2 / ¥8");
    // 两个串里不得出现"混血"（美元串带 ¥ 或反之）
    expect(amt.usd).not.toContain("¥");
    expect(amt.cny).not.toContain("$");
  });

  it("只有美元价 → cny 为 undefined（**不**用汇率补一个假人民币价）", () => {
    const amt = formatTierAmounts({ priceIn: 3, priceOut: 15 });
    expect(amt.usd).toBe("$3 / $15");
    expect(amt.cny).toBeUndefined();
  });

  it("只有人民币价（国内站独有）→ usd 为 undefined，不编造美元价", () => {
    const amt = formatTierAmounts({ priceInCny: 0.8, priceOutCny: 2.8 });
    expect(amt.cny).toBe("¥0.8 / ¥2.8");
    expect(amt.usd).toBeUndefined();
  });

  it("缺输出价 → 只显示输入价（不复制输入价冒充输出价）", () => {
    expect(formatTierAmounts({ priceIn: 1, priceInCny: 7 }).usd).toBe("$1");
    expect(formatTierAmounts({ priceIn: 1, priceInCny: 7 }).cny).toBe("¥7 / ¥7");
  });
});
