/**
 * tests/gui/trace-viewer.spec.ts — F：TraceViewer 链路视图纯渲染测试。
 * TraceBody 为纯展示组件（无 hook），可注入固定 span fixture 断言
 * 分类徽章/耗时/事件计数/失败红标；默认组件在 node 环境下渲染空态。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TraceViewer, { TraceBody } from "../../gui/src/renderer/pages/TraceViewer.js";
import type { TraceSnapshot } from "../../gui/src/shared/ipc.js";

function traceFixture(overrides: Partial<TraceSnapshot> = {}): TraceSnapshot {
  return {
    id: "tr-1",
    sessionId: "s1",
    startedAt: 1000,
    endedAt: 2000,
    spans: [
      { id: "s1", name: "turn:start", kind: "route_select", startedAt: 1000, endedAt: 1100 },
      { id: "s2", name: "tool:file_read", kind: "tool_call", startedAt: 1100, endedAt: 1300, data: { args: "a.py" } },
      { id: "s3", name: "tool:file_read", kind: "tool_result", startedAt: 1300, endedAt: 1301, data: { result: "ok" } },
      { id: "s4", name: "chunk", kind: "reply_chunk", startedAt: 1400, endedAt: 1400, data: { content: "你好" } },
      { id: "s5", name: "turn:done", kind: "done", startedAt: 2000, endedAt: 2000 },
    ],
    ...overrides,
  };
}

describe("TraceBody（单条链路渲染）", () => {
  it("渲染事件计数、闭合数、总时长", () => {
    const html = renderToStaticMarkup(createElement(TraceBody, { trace: traceFixture() }));
    expect(html).toContain("5 事件");
    expect(html).toContain("5 闭合"); // fixture 全 span 均已闭合
    expect(html).toContain("共 1.00s"); // endedAt 2000 - startedAt 1000 → fmtDur 秒单位
  });

  it("成功链路显示 ✓、失败链路显示 ⛔（eval passed=false 触发）", () => {
    const ok = renderToStaticMarkup(createElement(TraceBody, { trace: traceFixture() }));
    expect(ok).toContain("✓ 请求链路");
    const failed = traceFixture({ spans: [
      { id: "e1", name: "eval:completion", kind: "eval", startedAt: 1000, endedAt: 1000, data: { passed: false, notes: "超时" } },
    ] });
    const failHtml = renderToStaticMarkup(createElement(TraceBody, { trace: failed }));
    expect(failHtml).toContain("⛔ 失败请求链路");
    expect(failHtml).toContain("评估未通过");
  });

  it("分类徽章与 span 名称渲染（读/工具/完成）", () => {
    const html = renderToStaticMarkup(createElement(TraceBody, { trace: traceFixture() }));
    expect(html).toContain("路由");
    expect(html).toContain("tool:file_read");
    expect(html).toContain("工具");
    expect(html).toContain("完成");
    expect(html).toContain("入参：a.py");
    expect(html).toContain("结果：ok");
  });
});

describe("TraceViewer（默认组件：node 环境无订阅数据 → 空态不崩溃）", () => {
  it("渲染「链路视图」标题与空态提示", () => {
    const html = renderToStaticMarkup(createElement(TraceViewer));
    expect(html).toContain("链路视图");
    expect(html).toContain("暂无链路记录");
  });
});