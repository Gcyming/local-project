








import { describe, it, expect, beforeEach } from "vitest";
import { getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools, setSubagentManager } from "../../core-ts/src/tools/builtin.js";

type FakeRun = {
  id: string;
  name: string;
  status: string;
  result?: string;
  error?: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  structured?: { status: string; summary: string; artifacts: string[]; confidence: number };
};

describe("delegate_subagent（自动委派工具链路）", () => {
  beforeEach(() => {
    resetRegistry();
    setSubagentManager(null);
    registerBuiltinTools();
  });

  it("工具已注册且 schema 对模型可见（名称/描述/必填参数）", () => {
    const reg = getRegistry();
    const tool = reg.get("delegate_subagent");
    expect(tool).toBeDefined();
    const schema = tool!.toLLMSchema() as { type: string; function: { name: string; description: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } } };
    expect(schema.function.name).toBe("delegate_subagent");
    expect(schema.function.description).toContain("委派");
    
    expect(reg.listTools().some((s) => String((s as { function?: { name?: string } }).function?.name) === "delegate_subagent")).toBe(true);
    const params = schema.function.parameters;
    expect(params?.properties?.task).toBeDefined();
    expect(params?.properties?.model).toBeDefined(); 
    expect(params?.required ?? []).toContain("task");
  });

  it("管理器未注入 → 如实报错（提示当前环境未装配）", async () => {
    const tool = getRegistry().get("delegate_subagent")!;
    const out = await tool.executeFn({ task: "审查这段代码" });
    expect(out).toContain("未就绪");
  });

  it("注入管理器且按 description 命中定义 → 返回已委派回执", async () => {
    setSubagentManager({
      delegate: (task: string): FakeRun | null => {
        if (task.includes("审查")) { return { id: "r-1", name: "代码审查员", status: "pending" }; }
        if (task.includes("研究") || task.includes("调研") || task.includes("搜索")) { return { id: "r-2", name: "调研员", status: "pending" }; }
        if (task.includes("数据")) { return { id: "r-3", name: "数据分析员", status: "pending" }; }
        return null;
      },
    });
    const tool = getRegistry().get("delegate_subagent")!;
    const review = await tool.executeFn({ task: "审查提交的代码质量与潜在 bug" });
    expect(review).toContain("已委派");
    expect(review).toContain("代码审查员");
    const research = await tool.executeFn({ task: "调研最新多智能体架构" });
    expect(research).toContain("调研员");
    const data = await tool.executeFn({ task: "清洗这份数据并统计" });
    expect(data).toContain("数据分析员");
  });

  it("注入管理器但无匹配定义 → 返回提示 + 可用清单（不强行派发）", async () => {
    setSubagentManager({ delegate: (): FakeRun | null => null });
    const tool = getRegistry().get("delegate_subagent")!;
    const out = await tool.executeFn({ task: "聊聊今天的天气" });
    
    expect(out).toContain("没有与任务匹配");
    expect(out).toContain("可用子代理");
  });

  it("A-980-R30：点名一个不存在的子代理 → 如实报错 + 列出可用清单", async () => {
    setSubagentManager({
      delegate: (_t: string, o?: { agent?: string }): FakeRun | null => (o?.agent === "代码审查员" ? { id: "r-1", name: "代码审查员", status: "pending" } : null),
      catalog: () => [{ name: "代码审查员", description: "审查代码质量", source: "builtin" }],
    });
    const tool = getRegistry().get("delegate_subagent")!;
    const bad = await tool.executeFn({ task: "帮我看看", agent: "不存在的角色" });
    expect(bad).toContain("没有名为「不存在的角色」");
    expect(bad).toContain("代码审查员");
    
    const ok = await tool.executeFn({ task: "帮我看看", agent: "代码审查员" });
    expect(ok).toContain("代码审查员");
  });

  it("task 缺失 → 直接拒绝", async () => {
    const tool = getRegistry().get("delegate_subagent")!;
    const out = await tool.executeFn({ task: "" });
    expect(out).toContain("不能为空");
  });

  it("A-942：model 参数透传 → 委派回执标注所用模型", async () => {
    let passedModel: string | undefined;
    setSubagentManager({
      delegate: (_task: string, overrides?: { model?: string }): FakeRun | null => {
        passedModel = overrides?.model;
        return { id: "r-9", name: "代码审查员", status: "pending" };
      },
    });
    const tool = getRegistry().get("delegate_subagent")!;
    const withModel = await tool.executeFn({ task: "审查这段代码", model: "api:cheap:light" });
    expect(passedModel).toBe("api:cheap:light");
    expect(withModel).toContain("api:cheap:light"); 
    
    await tool.executeFn({ task: "审查这段代码" });
    expect(passedModel).toBeUndefined();
  });
});







function fakeManagerWithWait(final: FakeRun, opts: { onDelegate?: (o?: { agent?: string; model?: string }) => void } = {}) {
  return {
    delegate: (_task: string, o?: { agent?: string; model?: string }): FakeRun => {
      opts.onDelegate?.(o);
      return { id: final.id, name: final.name, status: "running" };
    },
    wait: async (id: string): Promise<FakeRun | undefined> => (id === final.id ? final : undefined),
    list: (): FakeRun[] => [final],
    
    
    catalog: () => [{ name: final.name, description: "专家", source: "builtin" as const }],
  };
}

describe("A-980-R30 — 子代理结果回收与验收闭环", () => {
  beforeEach(() => {
    resetRegistry();
    setSubagentManager(null);
    registerBuiltinTools();
  });

  it("subagent_result 已注册且 schema 对模型可见", () => {
    const tool = getRegistry().get("subagent_result");
    expect(tool).toBeDefined();
    const schema = tool!.toLLMSchema() as { function: { name: string; description: string } };
    expect(schema.function.name).toBe("subagent_result");
    expect(schema.function.description).toContain("子代理");
  });

  it("前台委派（默认）→ 等它跑完并把产出作为工具结果交回（含状态/耗时/自评/验收要求）", async () => {
    setSubagentManager(fakeManagerWithWait({
      id: "r-1", name: "代码审查员", status: "done", model: "api:cheap:light",
      startedAt: 1_000, finishedAt: 13_400,
      structured: { status: "completed", summary: "发现 2 处空指针风险，详见产物。", artifacts: ["review.md"], confidence: 0.82 },
    }));
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "审查 src/auth.ts 的空指针风险，输出问题清单" });
    expect(out).toContain("[子代理结果] 代码审查员");
    expect(out).toContain("状态：完成");
    expect(out).toContain("耗时 12.4s");
    expect(out).toContain("模型 api:cheap:light");
    expect(out).toContain("自评置信度 0.82");
    expect(out).toContain("发现 2 处空指针风险");      
    expect(out).toContain("产物清单：review.md");
    
    expect(out).toContain("验收要求");
    expect(out).toContain("不要直接当事实转述");
  });

  it("失败态 → 如实报失败 + 可操作建议，绝不假装成功", async () => {
    setSubagentManager(fakeManagerWithWait({ id: "r-2", name: "调研员", status: "fail", error: "上游 429 限流" }));
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "调研 X" });
    expect(out).toContain("状态：失败");
    expect(out).toContain("上游 429 限流");
    expect(out).toMatch(/重派|自己完成/);
    expect(out).not.toContain("验收要求"); 
  });

  it("超时/取消态 → 区分原因并给下一步", async () => {
    setSubagentManager(fakeManagerWithWait({ id: "r-3", name: "数据分析员", status: "timeout" }));
    const t = await getRegistry().get("delegate_subagent")!.executeFn({ task: "统计" });
    expect(t).toContain("超时中断");
    expect(t).toContain("timeoutMs");

    resetRegistry(); registerBuiltinTools();
    setSubagentManager(fakeManagerWithWait({ id: "r-4", name: "数据分析员", status: "cancelled" }));
    const c = await getRegistry().get("delegate_subagent")!.executeFn({ task: "统计" });
    expect(c).toContain("已取消");
    expect(c).toContain("重新派发");
  });

  it("子代理自评 partial → 显式标注「部分完成」，不让主 Agent 误当完成", async () => {
    setSubagentManager(fakeManagerWithWait({
      id: "r-5", name: "调研员", status: "done",
      structured: { status: "partial", summary: "只覆盖了 3/5 个来源。", artifacts: [], confidence: 0.4 },
    }));
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "调研 Y" });
    expect(out).toContain("部分完成");
  });

  it("background=true → 只回执 id 不阻塞（真并行场景），之后可用 subagent_result 收口", async () => {
    let waited = false;
    setSubagentManager({
      delegate: (): FakeRun => ({ id: "r-6", name: "代码审查员", status: "running" }),
      wait: async (): Promise<FakeRun> => { waited = true; return { id: "r-6", name: "代码审查员", status: "done", result: "审查完" }; },
      list: () => [],
    });
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "审查", background: true });
    expect(out).toContain("已派发·后台");
    expect(out).toContain("id=r-6");
    expect(waited).toBe(false); 

    
    const got = await getRegistry().get("subagent_result")!.executeFn({ id: "r-6" });
    expect(waited).toBe(true);
    expect(got).toContain("[子代理结果] 代码审查员");
    expect(got).toContain("审查完");
  });

  it("subagent_result 不传 id → 列出全部记录（名称/状态/摘要/id）", async () => {
    setSubagentManager(fakeManagerWithWait({
      id: "r-7", name: "数据分析员", status: "done",
      structured: { status: "completed", summary: "均值 3.2，方差 0.4", artifacts: [], confidence: 0.9 },
    }));
    const out = await getRegistry().get("subagent_result")!.executeFn({});
    expect(out).toContain("共 1 条子代理记录");
    expect(out).toContain("[完成] 数据分析员");
    expect(out).toContain("id=r-7");
    expect(out).toContain("均值 3.2");
  });

  it("长产出截断（全文落盘、只把摘要送进上下文）", async () => {
    setSubagentManager(fakeManagerWithWait({ id: "r-8", name: "调研员", status: "done", result: "x".repeat(9000) }));
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "调研" });
    expect(out).toContain("已截断展示");
    expect(out.length).toBeLessThan(9000);
  });

  it("管理器不支持 wait（老装配/CLI）→ 降级为回执，不让整条链路失败", async () => {
    setSubagentManager({ delegate: (): FakeRun => ({ id: "r-9", name: "调研员", status: "running" }) });
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "调研 Z" });
    expect(out).toContain("已委派");
    expect(out).toContain("id=r-9");
    expect(out).toContain("subagent_result");
  });

  it("agent / model 参数透传到管理器（点名 + 指定执行档）", async () => {
    let seen: { agent?: string; model?: string } | undefined;
    setSubagentManager(fakeManagerWithWait(
      { id: "r-10", name: "代码审查员", status: "done", result: "ok" },
      { onDelegate: (o) => { seen = o; } },
    ));
    await getRegistry().get("delegate_subagent")!.executeFn({ task: "审查", agent: "代码审查员", model: "api:cheap:light" });
    expect(seen).toEqual({ agent: "代码审查员", model: "api:cheap:light" });
  });
});
