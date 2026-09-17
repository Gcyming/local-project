/**
 * tests/gui/plan-panel.spec.ts — F：PlanPanel 组件单测（无 DOM 纯渲染 + 纯计算）。
 * 用 renderToStaticMarkup 断言最终 HTML：进度条宽度百分比、阶段状态文本、
 * 完成删除线、空态提示。usePlanStore 为 window 订阅 hook，node 环境只测纯渲染路径。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanCard, PlanCardList, planProgress } from "../../gui/src/renderer/pages/PlanPanel.js";
import PlanPanel from "../../gui/src/renderer/pages/PlanPanel.js";
import type { PlanInfo } from "../../gui/src/shared/ipc.js";

function plan(overrides: Partial<PlanInfo> = {}): PlanInfo {
  return {
    id: "p1",
    sessionId: "s1",
    description: "重构鉴权模块",
    stages: [
      { id: "1", label: "审计现状", status: "done" },
      { id: "2", label: "实现改造", status: "in_progress" },
      { id: "3", label: "回归验证", status: "pending" },
    ],
    createdAt: 0,
    updatedAt: 1,
    status: "active",
    ...overrides,
  };
}

describe("planProgress（进度计算，与 core-ts planProgress 同口径）", () => {
  it("进行中：done+skipped 计入分子", () => {
    expect(planProgress(plan())).toEqual({ done: 1, total: 3, pct: 33 });
  });
  it("全部完成 pct=100；skipped 也算完成", () => {
    const p = plan({ stages: [
      { id: "1", label: "a", status: "done" },
      { id: "2", label: "b", status: "skipped" },
    ] });
    expect(planProgress(p).pct).toBe(100);
  });
  it("空阶段集 total ≥1 不除零", () => {
    expect(planProgress(plan({ stages: [] })).total).toBe(1);
  });
});

describe("PlanCard（单卡渲染）", () => {
  it("渲染描述、进度条宽度、阶段数文案", () => {
    const html = renderToStaticMarkup(createElement(PlanCard, { plan: plan() }));
    expect(html).toContain("重构鉴权模块");
    expect(html).toContain("1/3 阶段");
    expect(html).toContain('width:33%');
  });

  it("全部完成 → 显示「已完成」而非 x/y", () => {
    const p = plan({ status: "done", stages: [
      { id: "1", label: "a", status: "done" },
      { id: "2", label: "b", status: "done" },
    ] });
    const html = renderToStaticMarkup(createElement(PlanCard, { plan: p }));
    expect(html).toContain("已完成");
    expect(html.match(/2\/2 阶段/g)).toBeNull();
  });

  it("失败态 → 显示「已失败」且出现红的进度条", () => {
    const p = plan({ status: "failed", stages: [
      { id: "1", label: "a", status: "failed" },
    ] });
    const html = renderToStaticMarkup(createElement(PlanCard, { plan: p }));
    expect(html).toContain("已失败");
    expect(html).toContain("var(--danger)");
  });

  it("阶段状态：done 删除线 + 状态文本 + in_progress 显示「进行中」", () => {
    const html = renderToStaticMarkup(createElement(PlanCard, { plan: plan() }));
    expect(html).toContain("text-decoration:line-through");
    expect(html).toContain("进行中");
    expect(html).toContain("待办");
    expect(html).toContain("完成");
  });
});

describe("PlanCardList / PlanPanel（列表与空态）", () => {
  it("空列表 → 提示文案", () => {
    const html = renderToStaticMarkup(createElement(PlanCardList, { plans: [] }));
    expect(html).toContain("暂无进行中的任务计划");
  });

  it("多 Plan → 逐张渲染", () => {
    const html = renderToStaticMarkup(createElement(PlanCardList, {
      plans: [plan(), plan({ id: "p2", description: "第二个任务" })],
    }));
    expect(html).toContain("重构鉴权模块");
    expect(html).toContain("第二个任务");
  });

  it("PlanPanel 无订阅数据（node 环境）→ 渲染「任务进度」标题与空态，不崩溃", () => {
    const html = renderToStaticMarkup(createElement(PlanPanel));
    expect(html).toContain("任务进度");
    expect(html).toContain("暂无进行中的任务计划");
  });
});