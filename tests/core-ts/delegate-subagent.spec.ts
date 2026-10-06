








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

describe("delegate_subagent 批量派发（编排能力合并进子代理，判断权在主 Agent）", () => {
  beforeEach(() => {
    resetRegistry();
    setSubagentManager(null);
    registerBuiltinTools();
  });

  type SpawnedDef = { name: string; task: string; sharedSpec?: string };
  type Captured = { defs: SpawnedDef[]; opts?: { sharedSpec?: string } };

  function installBatchManager(
    results: Array<{ name: string; status: string; result?: string; error?: string }>,
    captured?: Captured,
  ): void {
    setSubagentManager({
      delegate: (): FakeRun | null => ({ id: "single-1", name: "单发", status: "pending" }),
      wait: async (id: string): Promise<FakeRun | undefined> => ({
        id, name: "单发", status: "done", result: "单发产出",
      }),
      spawnBatch: (defs: SpawnedDef[], opts?: { sharedSpec?: string }) => {
        if (captured) {
          captured.defs = defs;
          if (opts) { captured.opts = opts; }
        }
        return {
          batchId: "b-1",
          runs: defs.map((d, i) => ({ id: `r-${i}`, name: d.name, status: "pending" })),
        };
      },
      awaitBatch: async (): Promise<FakeRun[]> =>
        results.map((r, i) => ({ id: `r-${i}`, name: r.name, status: r.status, result: r.result ?? "", error: r.error ?? "" })),
    });
  }

  it("不填 subtasks → 仍走原有单发路径（回归保护）", async () => {
    installBatchManager([]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "审查这段代码" });
    expect(out).not.toContain("已并行派发");
    expect(out).toContain("单发产出");
  });

  it("不填 subtasks → 绝不触碰 spawnBatch（不误触发批量）", async () => {
    let spawned = 0;
    setSubagentManager({
      delegate: (): FakeRun | null => ({ id: "single-1", name: "单发", status: "pending" }),
      wait: async (id: string): Promise<FakeRun | undefined> => ({ id, name: "单发", status: "done", result: "ok" }),
      spawnBatch: () => { spawned++; return { batchId: "b", runs: [] }; },
      awaitBatch: async (): Promise<FakeRun[]> => [],
    });
    await getRegistry().get("delegate_subagent")!.executeFn({ task: "写一段文字" });
    expect(spawned).toBe(0);
  });

  it("✅ 填 subtasks → 并行派发 N 个子代理，返回含批次与整合指引", async () => {
    const cap: Captured = { defs: [] };
    installBatchManager(
      [{ name: "甲-1", status: "done", result: "第一段完成" }, { name: "甲-2", status: "done", result: "第二段完成" }],
      cap,
    );
    const out = await getRegistry().get("delegate_subagent")!.executeFn({
      task: "写一个长篇报告",
      subtasks: ["第一部分：背景", "第二部分：结论"],
    });
    expect(cap.defs.length).toBe(2);
    expect(cap.defs[0].task).toBe("第一部分：背景");
    expect(cap.defs[1].task).toBe("第二部分：结论");
    expect(out).toContain("已并行派发 2 个子代理");
    expect(out).toContain("b-1");
    expect(out).toContain("第一段完成");
    expect(out).toContain("整合要求");
  });

  it("✅ sharedSpec 透传到批次 opts 且出现在返回的整合指引里", async () => {
    const cap: Captured = { defs: [] };
    installBatchManager([{ name: "甲-1", status: "done", result: "产物" }], cap);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({
      task: "多模块代码",
      subtasks: ["模块 A"],
      sharedSpec: '{"tech_stack":"TypeScript"}',
    });
    expect(cap.opts?.sharedSpec).toBe('{"tech_stack":"TypeScript"}');
    expect(out).toContain("【全局规格");
    expect(out).toContain("tech_stack");
  });

  it("⚠️ subtasks 与 agent 同时给 → 明确拒绝，不静默忽略", async () => {
    installBatchManager([]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({
      task: "任务",
      subtasks: ["甲", "乙"],
      agent: "调研员",
    });
    expect(out).toContain("不能同时使用");
    expect(out).not.toContain("已并行派发");
  });

  it("装配不支持 spawnBatch → 如实说不支持，不静默降级成单发", async () => {
    setSubagentManager({
      delegate: (): FakeRun | null => ({ id: "s", name: "单发", status: "pending" }),
    });
    const out = await getRegistry().get("delegate_subagent")!.executeFn({
      task: "任务",
      subtasks: ["甲", "乙"],
    });
    expect(out).toContain("不支持批量派发");
    expect(out).toContain("未派发");
  });

  it("批量全成功 → 结论为 ✓ 且风险为 low", async () => {
    installBatchManager([
      { name: "甲-1", status: "done", result: "成功完成" },
      { name: "甲-2", status: "done", result: "成功完成" },
    ]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "任务", subtasks: ["甲", "乙"] });
    expect(out).toContain("✓");
    expect(out).toContain("[low]");
  });

  it("批量有失败 → 结论为 ⚠ 且如实标注失败比例", async () => {
    installBatchManager([
      { name: "甲-1", status: "done", result: "成功完成" },
      { name: "甲-2", status: "failed", result: "", error: "执行超时" },
    ]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "任务", subtasks: ["甲", "乙"] });
    expect(out).toContain("⚠");
    expect(out).toContain("1/2 个子任务失败");
    expect(out).toContain("执行超时");
  });

  it("批量结果疑似矛盾 → 报给主 Agent 并注明由它裁定", async () => {
    installBatchManager([
      { name: "甲-1", status: "done", result: "构建成功" },
      { name: "甲-2", status: "done", result: "测试失败" },
      { name: "甲-3", status: "done", result: "部署错误" },
    ]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "任务", subtasks: ["甲", "乙", "丙"] });
    expect(out).toContain("疑似矛盾");
    expect(out).toContain("请你自己核对");
  });

  it("批量无矛盾 → 不出现疑似矛盾段（不制造噪音）", async () => {
    installBatchManager([
      { name: "甲-1", status: "done", result: "成功完成" },
      { name: "甲-2", status: "done", result: "已完成并通过" },
    ]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "任务", subtasks: ["甲", "乙"] });
    expect(out).not.toContain("疑似矛盾");
  });

  it("🛡 拆解护栏：超 5 秒的视频段被拦下并给出修正指引", async () => {
    installBatchManager([]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({
      task: "做一个视频",
      subtasks: ["第 1 段 0-12 秒：打斗"],
    });
    expect(out).toContain("未通过拆解校验");
    expect(out).toContain("超过 5 秒上限");
  });

  it("🛡 拆解护栏：时长覆盖不足被拦下", async () => {
    installBatchManager([]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({
      task: "做一个 20 秒视频",
      subtasks: ["第 1 段 0-5 秒：开场"],
    });
    expect(out).toContain("未通过拆解校验");
    expect(out).toContain("仅覆盖");
  });

  it("🛡 拆解护栏：合法的 5 秒分段放行（护栏不误伤）", async () => {
    installBatchManager([{ name: "甲-1", status: "done", result: "段1完成" }]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({
      task: "做一个 10 秒视频",
      subtasks: ["第 1 段 0-5 秒：开场", "第 2 段 5-10 秒：收尾"],
    });
    expect(out).not.toContain("未通过拆解校验");
    expect(out).toContain("已并行派发 2 个子代理");
  });

  it("🛡 非视频任务的普通拆解不受护栏影响（无时间区间即跳过）", async () => {
    installBatchManager([{ name: "甲-1", status: "done", result: "ok" }]);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({
      task: "写一份报告",
      subtasks: ["第一部分：背景调研", "第二部分：数据分析"],
    });
    expect(out).not.toContain("未通过拆解校验");
    expect(out).toContain("已并行派发 2 个子代理");
  });

  it("🛡 数量护栏：超过上限时明确拒绝并给出出路", async () => {
    installBatchManager([]);
    const many = Array.from({ length: 25 }, (_, i) => `子任务${i + 1}`);
    const out = await getRegistry().get("delegate_subagent")!.executeFn({ task: "大任务", subtasks: many });
    expect(out).toContain("一次最多");
    expect(out).toContain("分多次调用");
  });

  it("空字符串项被过滤（不产生空子任务）", async () => {
    const cap: Captured = { defs: [] };
    installBatchManager([{ name: "甲-1", status: "done", result: "ok" }], cap);
    await getRegistry().get("delegate_subagent")!.executeFn({
      task: "任务",
      subtasks: ["有效任务", "   ", ""],
    });
    expect(cap.defs.length).toBe(1);
    expect(cap.defs[0].task).toBe("有效任务");
  });
});
