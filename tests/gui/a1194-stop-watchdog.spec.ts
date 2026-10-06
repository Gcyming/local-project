import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A-1194 终止按钮响应性（P6）：UI 看门狗兜底（接线形状）。
 *
 * 背景：按钮的 stopping 状态要等「流终态事件」（done/error）才复位。
 * P1–P5 修掉了底层所有已知的 abort 盲区，但若未来出现新的卡死环节
 * （或外因：上游假死、OS 挂起），按钮仍会永远转圈。
 * 看门狗 = 最后一道防线：15s 未终态 → 强制 resetStreamUI + 横幅提示。
 */
const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("A-1194 P6：终止按钮看门狗（UI 兜底）", () => {
  const src = read("gui/src/renderer/pages/ChatPanel.tsx");

  it("看门狗常量存在且为 15s（唯一出处）", () => {
    expect(src).toMatch(/const STOP_WATCHDOG_MS = 15000;/);
  });

  it("stopping=true 挂定时器；到期仍 stopping → 强制 resetStreamUI + 横幅；正常终态由 cleanup 清定时器", () => {
    expect(src).toMatch(/if \(!stopping\) \{ return; \}/);
    // 以 effect 内的守卫语句为唯一锚点（文件前部的常量注释同名，不能用于 indexOf）
    const at = src.indexOf("if (!stopping) { return; }");
    const body = src.slice(Math.max(0, at - 200), at + 1000);
    expect(body).toContain("window.setTimeout(");
    expect(body).toContain("STOP_WATCHDOG_MS");
    expect(body).toContain("if (!stoppingRef.current) { return; }");
    expect(body).toContain("resetStreamUI();");
    expect(body).toContain("setStreamErrorBanner(");
    expect(body).toContain("return () => window.clearTimeout(timer);");
    expect(body).toContain("[stopping, resetStreamUI]");
  });
});
