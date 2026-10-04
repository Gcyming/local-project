














import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EXEC_BUDGET_MS } from "../../core-ts/src/services/subagent.js";
import { __SUBAGENT_BUDGETS } from "../../core-ts/src/tools/builtin.js";

describe("子代理预算（派发不再「必然超时」）", () => {
  it("默认执行预算 ≥ 10 分钟（实测一次真实任务已跑到 276s 且仍在最后一步）", () => {
    expect(DEFAULT_EXEC_BUDGET_MS).toBeGreaterThanOrEqual(600_000);
    
    expect(DEFAULT_EXEC_BUDGET_MS).toBeGreaterThan(300_000);
  });

  it("不变式：等待上限 **严格大于** 执行预算（等待 < 预算 = 每次都超时却没用满预算）", () => {
    expect(__SUBAGENT_BUDGETS.waitDefault).toBeGreaterThan(__SUBAGENT_BUDGETS.execBudget);
    expect(__SUBAGENT_BUDGETS.waitMax).toBeGreaterThan(__SUBAGENT_BUDGETS.waitDefault);
  });

  it("等待上限由预算**推导**而来，不是第二处手写字面量（改预算必须自动跟着改）", () => {
    expect(__SUBAGENT_BUDGETS.waitDefault).toBe(__SUBAGENT_BUDGETS.execBudget + 60_000);
    const src = readFileSync(join(process.cwd(), "core-ts/src/tools/builtin.ts"), "utf8");
    expect(src).toContain("const SUBAGENT_WAIT_DEFAULT = DEFAULT_EXEC_BUDGET_MS + 60_000;");
    
    expect(src).not.toContain("SUBAGENT_WAIT_DEFAULT = 330_000");
    expect(src).not.toContain("SUBAGENT_WAIT_MAX = 600_000");
  });

  it("超时文案必须带实跑时长与已保住产出（否则用户分不清「卡死」与「差一步」）", () => {
    const src = readFileSync(join(process.cwd(), "core-ts/src/services/subagent.ts"), "utf8");
    expect(src).toContain("private timeoutMessage(");
    expect(src).toContain("预算 ${Math.round(timeoutMs / 1000)}s 用尽，实跑 ${elapsed}s");
    expect(src).toContain("已保住中断前产出");
    
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toContain("执行超时（>");
  });
});
