/**
 * tests/core-ts/subagent-budget.spec.ts — 子代理预算不变式（A-983）。
 *
 * 背景：用户第四次反馈"子代理板块依旧没成功过，全部超时"。
 * 审计日志（`data/audit.jsonl`）给出的实录把归因钉死了：
 *   05:32:31 派发 → 05:34:00 完成 1/4 步 → 05:35:14 完成 3/4（第 4 步 in_progress）
 *   → 05:37:31 撞 **300s 预算**被杀，界面显示"超时中断"。
 * 即：**不是功能坏了，是预算把 95% 完成的工作掐掉了**。数据统计/全量扫描这类任务（8M 行）
 * 本就以分钟计，300s 必然常态失败 —— 预算只该是"防挂死"的下限保障，不该成为常态失败源。
 *
 * 另一条不变式：**等待上限必须严格大于执行预算**。两者是不同量（预算＝子代理能跑多久，
 * 等待＝主 Agent 愿等多久），一旦等待 < 预算，每次派发都会在预算到期前被主 Agent 先撤走，
 * 症状同样是"每次都超时"却根本没用满预算。此前这两个数字是两处手写的字面量（300s/330s），
 * 改一个忘一个就会静默退化 —— 现在由 `DEFAULT_EXEC_BUDGET_MS` 单源推导，本文件锁死。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EXEC_BUDGET_MS } from "../../core-ts/src/services/subagent.js";
import { __SUBAGENT_BUDGETS } from "../../core-ts/src/tools/builtin.js";

describe("子代理预算（派发不再「必然超时」）", () => {
  it("默认执行预算 ≥ 10 分钟（实测一次真实任务已跑到 276s 且仍在最后一步）", () => {
    expect(DEFAULT_EXEC_BUDGET_MS).toBeGreaterThanOrEqual(600_000);
    // 旧值 300_000 正是把 4/4 步的工作掐掉的那个数，不许回退
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
    // 不许再出现旧的裸字面量（330_000 / 600_000 是漂移的发源地）
    expect(src).not.toContain("SUBAGENT_WAIT_DEFAULT = 330_000");
    expect(src).not.toContain("SUBAGENT_WAIT_MAX = 600_000");
  });

  it("超时文案必须带实跑时长与已保住产出（否则用户分不清「卡死」与「差一步」）", () => {
    const src = readFileSync(join(process.cwd(), "core-ts/src/services/subagent.ts"), "utf8");
    expect(src).toContain("private timeoutMessage(");
    expect(src).toContain("预算 ${Math.round(timeoutMs / 1000)}s 用尽，实跑 ${elapsed}s");
    expect(src).toContain("已保住中断前产出");
    // 裸文案（只说"执行超时（>300000ms），已中断"）除了注释外不得再出现在代码里
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toContain("执行超时（>");
  });
});
