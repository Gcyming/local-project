






import { describe, it, expect } from "vitest";
import { fillDailyGaps } from "../../gui/src/renderer/pages/UsageStatsPanel.js";


const NOW = new Date(2026, 8, 16, 12, 0, 0).getTime();
const day = 86_400_000;

function bucket(date: string, requests: number, cost = 0, tokens = 0) {
  return { date, requests, cost_usd: cost, total_tokens: tokens };
}

describe("fillDailyGaps", () => {
  it("补齐缺失的日期为零值桶，保持时间升序、天数为 rangeDays", () => {
    const out = fillDailyGaps([bucket("2026-09-14", 3), bucket("2026-09-16", 5)], 7, NOW);
    expect(out).toHaveLength(7);
    expect(out[out.length - 1].date).toBe("2026-09-16");
    expect(out[0].date).toBe("2026-09-10");
    
    const gap = out.find((b) => b.date === "2026-09-15")!;
    expect(gap).toEqual({ date: "2026-09-15", requests: 0, cost_usd: 0, total_tokens: 0 });
    
    expect(out.find((b) => b.date === "2026-09-14")!.requests).toBe(3);
  });

  it("日期严格升序且不重复（并列柱的横轴必须等距单调）", () => {
    const out = fillDailyGaps([bucket("2026-09-16", 1), bucket("2026-09-12", 2)], 30, NOW);
    const dates = out.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("“全部”范围（>60 天）不铺空柱：原样返回", () => {
    const raw = [bucket("2026-01-02", 1)];
    expect(fillDailyGaps(raw, 9999, NOW)).toEqual(raw);
  });

  it("范围外的历史桶不丢（极端时钟/时区样本）", () => {
    const out = fillDailyGaps([bucket("2020-01-01", 9)], 7, NOW);
    expect(out.some((b) => b.date === "2020-01-01" && b.requests === 9)).toBe(true);
    expect(out).toHaveLength(8); 
  });

  it("空输入 → 仍给出完整的零值日期轴（图不塌）", () => {
    const out = fillDailyGaps([], 7, NOW);
    expect(out).toHaveLength(7);
    expect(out.every((b) => b.requests === 0 && b.total_tokens === 0)).toBe(true);
  });
});
