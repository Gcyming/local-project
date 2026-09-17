/**
 * subagent.spec.ts — 后台子代理管理器（SubAgentManager）回归锚点。
 * 覆盖：fire-and-forget 状态机、并发槽位上限、失败记录、awaitIdle 收尾（v1 契约），
 * 以及 v2 业界标准能力：wait 事件驱动、cancel（排队/运行中/即时）、timeoutMs 超时、
 * 结构化结果解析、声明式定义注册与 delegate 自动委派、生命周期钩子，
 * 以及 v2.2 语义修正回归：awaitIdle 覆盖「排队中被取消」的任务。
 */
import { describe, it, expect } from "vitest";
import {
  SubAgentManager,
  overlapScore,
  parseStructuredResult,
} from "../../core-ts/src/services/subagent.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("SubAgentManager（后台子代理）", () => {
  it("spawn 立即返回 pending，随后 running → done，结果摘要可查", async () => {
    let calls = 0;
    const mgr = new SubAgentManager(async () => {
      await sleep(10);
      calls++;
      return "子代理结论：已分析三个模块";
    });
    const run = mgr.spawn({ name: "研究", task: "分析 authentication" });
    // fire-and-forget：返回时可能已进入 running（无排队），但必未完成
    expect(["pending", "running"]).toContain(run.status);
    await sleep(30);
    const after = mgr.status(run.id)!;
    expect(calls).toBe(1);
    expect(after.status).toBe("done");
    expect(after.result).toContain("子代理结论");
    expect(after.finishedAt).toBeGreaterThanOrEqual(after.startedAt!);
  });

  it("并发上限生效：concurrency=2 时 active 不超过 2", async () => {
    let active = 0;
    let maxSeen = 0;
    const mgr = new SubAgentManager(async () => {
      active++;
      maxSeen = Math.max(maxSeen, active);
      await sleep(30);
      active--;
      return "ok";
    }, { concurrency: 2 });
    for (let i = 0; i < 4; i++) {
      mgr.spawn({ name: `t${i}`, task: `任务 ${i}` });
    }
    expect(mgr.activeCount).toBeLessThanOrEqual(2);
    await mgr.awaitIdle(5000);
    expect(maxSeen).toBe(2); // 并行峰值被槽位压住
    expect(mgr.list().length).toBe(4);
  });

  it("执行器抛错 → 记 fail + error，不中断其他任务", async () => {
    const mgr = new SubAgentManager(async (def) => {
      if (def.name === "坏") { throw new Error("boom-sub"); }
      await sleep(5);
      return "good";
    });
    const bad = mgr.spawn({ name: "坏", task: "x" });
    const good = mgr.spawn({ name: "好", task: "y" });
    await mgr.awaitIdle(5000);
    expect(mgr.status(bad.id)!.status).toBe("fail");
    expect(mgr.status(bad.id)!.error).toBe("boom-sub");
    expect(mgr.status(good.id)!.status).toBe("done");
  });

  it("awaitIdle 等待全部完成（含排队中）", async () => {
    let done = 0;
    const mgr = new SubAgentManager(async () => {
      await sleep(20);
      done++;
      return "ok";
    }, { concurrency: 1 });
    mgr.spawn({ name: "a", task: "1" });
    mgr.spawn({ name: "b", task: "2" });
    mgr.spawn({ name: "c", task: "3" });
    await mgr.awaitIdle(5000);
    expect(done).toBe(3);
    expect(mgr.activeCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // v2：wait / cancel / timeout / 结构化 / 自动委派 / 钩子
  // -------------------------------------------------------------------------

  it("wait(id) 事件驱动等待终态，无需轮询", async () => {
    const mgr = new SubAgentManager(async () => {
      await sleep(30);
      return "结论";
    });
    const run = mgr.spawn({ name: "w", task: "等待我" });
    const final = await mgr.wait(run.id, 3000);
    expect(final).toBeDefined();
    expect(final!.status).toBe("done");
    expect(final!.result).toBe("结论");
    // 已终态后再 wait 立即返回；未知 id 返回 undefined
    const again = await mgr.wait(run.id, 50);
    expect(again!.status).toBe("done");
    expect(await mgr.wait("不存在的id", 50)).toBeUndefined();
  });

  it("cancel 排队任务：不占用槽位，后续任务照常执行", async () => {
    const done: string[] = [];
    const mgr = new SubAgentManager(async (def) => {
      await sleep(30);
      done.push(def.name);
      return "ok";
    }, { concurrency: 1 });
    mgr.spawn({ name: "A", task: "1" });
    const b = mgr.spawn({ name: "B", task: "2" });
    expect(mgr.cancel(b.id)).toBe(true);
    expect(mgr.status(b.id)!.status).toBe("cancelled");
    const c = mgr.spawn({ name: "C", task: "3" });
    await mgr.awaitIdle(5000);
    await mgr.wait(c.id, 3000);
    expect(done).toEqual(["A", "C"]); // B 被取消且未阻塞 C 的槽位
    expect(mgr.status(b.id)!.status).toBe("cancelled");
  });

  it("cancel 运行中任务：status=cancelled（不误判为 timeout）", async () => {
    const mgr = new SubAgentManager(async (_def, ctx) => {
      while (!ctx?.signal.aborted) { await sleep(5); }
      throw new Error("aborted");
    });
    // 故意带上超时预算：若缺少取消登记，会被误标为 timeout
    const run = mgr.spawn({ name: "R", task: "长跑", timeoutMs: 5000 });
    await sleep(20);
    expect(mgr.cancel(run.id)).toBe(true);
    const final = await mgr.wait(run.id, 3000);
    expect(final!.status).toBe("cancelled");
  });

  it("spawn 后立即 cancel：runner 收到已中止信号，终态 cancelled", async () => {
    let didRealWork = false;
    const mgr = new SubAgentManager(async (_def, ctx) => {
      if (ctx?.signal.aborted) { throw new Error("aborted"); }
      didRealWork = true;
      return "ok";
    });
    const run = mgr.spawn({ name: "I", task: "x" });
    mgr.cancel(run.id);
    const final = await mgr.wait(run.id, 3000);
    expect(final!.status).toBe("cancelled");
    expect(didRealWork).toBe(false);
  });

  it("timeoutMs 超时中断 → status=timeout", async () => {
    const mgr = new SubAgentManager(async () => {
      await sleep(300); // runner 不响应 signal，模拟长任务
      return "late";
    });
    const run = mgr.spawn({ name: "T", task: "超时任务", timeoutMs: 50 });
    const final = await mgr.wait(run.id, 3000);
    expect(final!.status).toBe("timeout");
    expect(final!.error).toContain("超时");
  });

  it("结构化结果：outputSchema=true 时解析 JSON 块到 run.structured", async () => {
    const mgr = new SubAgentManager(async () =>
      "分析完成。\n```json\n{\"status\":\"completed\",\"summary\":\"发现 3 个问题\",\"artifacts\":[\"a.md\"],\"confidence\":0.9}\n```",
    );
    const run = mgr.spawn({ name: "S", task: "结构化任务", outputSchema: true });
    const final = await mgr.wait(run.id, 3000);
    expect(final!.status).toBe("done");
    expect(final!.structured).toBeDefined();
    expect(final!.structured!.status).toBe("completed");
    expect(final!.structured!.summary).toContain("3 个问题");
    expect(final!.structured!.artifacts).toEqual(["a.md"]);
    expect(final!.structured!.confidence).toBeCloseTo(0.9);
    // 文本结果仍然保留（向后兼容）
    expect(final!.result).toContain("分析完成");
  });

  it("parseStructuredResult：自由文本回退解析 + 非法输入返回 null", () => {
    const r = parseStructuredResult('前言 {"status":"partial","summary":"一半","confidence":1.7} 后记');
    expect(r).not.toBeNull();
    expect(r!.status).toBe("partial");
    expect(r!.confidence).toBeLessThanOrEqual(1); // 越界收敛
    expect(parseStructuredResult("没有任何 JSON")).toBeNull();
    expect(parseStructuredResult("")).toBeNull();
  });

  it("声明式定义注册 + delegate 按 description 自动委派", async () => {
    const seen: Array<{ name: string; system?: string }> = [];
    const mgr = new SubAgentManager(async (def) => {
      seen.push({ name: def.name, system: def.systemPrompt });
      return "ok";
    });
    mgr.register({
      name: "代码审查员",
      description: "审查代码质量、发现 bug、静态分析",
      systemPrompt: "你是资深代码审查专家",
    });
    mgr.register({ name: "调研员", description: "联网搜索资料、汇总信息" });

    const run = mgr.delegate("请审查这段代码的潜在 bug");
    expect(run).not.toBeNull();
    expect(run!.definitionName).toBe("代码审查员");
    await mgr.awaitIdle(5000);
    expect(seen[0].name).toBe("代码审查员");
    expect(seen[0].system).toContain("代码审查");

    // A-918+：无匹配定义 → 不再返回 null，而是自动创建通用子代理兜底
    const fallback = mgr.delegate("zzzz 完全无关的话题 qqqq");
    expect(fallback).not.toBeNull();
    expect(fallback!.name).toContain("通用助手");
  });

  it("A-918+：用户选定子代理优先于内置专家（两段式委派）", async () => {
    const seen: string[] = [];
    const mgr = new SubAgentManager(async (def) => {
      seen.push(def.name);
      return "ok";
    });
    // 内置专家（非 userSelected）
    mgr.register({ name: "代码审查员", description: "审查代码质量、发现 bug、静态分析" });
    mgr.register({ name: "调研员", description: "联网搜索资料、汇总信息、引用整理" });
    // 用户选定（userSelected）
    mgr.setUserSelected([
      { name: "我的安全专家", description: "审查代码安全性、漏洞、注入风险", agentId: "agent-1" },
    ]);

    // 任务同时命中内置「代码审查员」与用户选定「安全专家」→ 应优先用户选定
    const run = mgr.delegate("请审查这段代码的安全漏洞与注入风险");
    expect(run).not.toBeNull();
    expect(run!.definitionName).toBe("我的安全专家");

    // 任务只命中内置「调研员」（用户选定无匹配）→ 回退内置专家
    const run2 = mgr.delegate("请联网搜索资料并汇总信息");
    expect(run2).not.toBeNull();
    expect(run2!.definitionName).toBe("调研员");
    await mgr.awaitIdle(5000);
  });

  it("生命周期钩子：onStart/onComplete/onError 按终态触发且异常不阻断", async () => {
    const events: string[] = [];
    const mgr = new SubAgentManager(
      async (def) => {
        if (def.name === "炸") { throw new Error("boom"); }
        return "ok";
      },
      {
        hooks: {
          onStart: (run) => { events.push(`start:${run.name}`); },
          onComplete: (run) => { events.push(`done:${run.name}`); },
          onError: (run) => {
            events.push(`err:${run.name}`);
            throw new Error("钩子自身异常不应阻断");
          },
        },
      },
    );
    mgr.spawn({ name: "好", task: "1" });
    mgr.spawn({ name: "炸", task: "2" });
    await mgr.awaitIdle(5000);
    expect(events).toContain("start:好");
    expect(events).toContain("done:好");
    expect(events).toContain("err:炸");
    expect(mgr.list().every((r) => r.status === "done" || r.status === "fail")).toBe(true);
  });

  it("awaitIdle 覆盖「排队中被取消」的任务：不提前返回（v2.2 回归）", async () => {
    const done: string[] = [];
    const mgr = new SubAgentManager(async (def) => {
      await sleep(30);
      done.push(def.name);
      return "ok";
    }, { concurrency: 1 });
    mgr.spawn({ name: "A", task: "1" });
    const b = mgr.spawn({ name: "B", task: "2" });
    mgr.spawn({ name: "C", task: "3" });
    expect(mgr.cancel(b.id)).toBe(true);
    await mgr.awaitIdle(5000);
    // awaitIdle 返回时，排在已取消 B 之后的 C 也必须已真正完成
    expect(done).toEqual(["A", "C"]);
    expect(mgr.status(b.id)!.status).toBe("cancelled");
    expect(mgr.activeCount).toBe(0);
  });

  it("overlapScore：相关任务-描述得分>0，无关为 0", () => {
    expect(overlapScore("请审查这段代码", "代码审查与静态分析")).toBeGreaterThan(0);
    expect(overlapScore("今天天气怎么样", "代码审查与静态分析")).toBe(0);
  });
});

describe("SubAgentManager（A-942：全局子代理默认模型档）", () => {
  it("无显式 model 时应用全局默认模型（廉价执行档）", async () => {
    let routed = "";
    const mgr = new SubAgentManager(async (def) => {
      routed = def.model ?? "";
      return "done";
    }, { defaultModel: "api:cheap:light" });
    const run = mgr.spawn({ name: "执行", task: "跑个机械子任务" });
    await mgr.awaitIdle(5000);
    expect(routed).toBe("api:cheap:light");
    expect(mgr.status(run.id)!.model).toBe("api:cheap:light"); // 记录实际路由
  });

  it("声明式 def.model 优先于全局默认；空串全局默认不覆盖", async () => {
    const routed: string[] = [];
    const mgr = new SubAgentManager(async (def) => {
      routed.push(def.model ?? "");
      return "done";
    }, { defaultModel: "api:cheap" });
    mgr.spawn({ name: "A", task: "a", model: "api:mid" });   // 显式定义优先
    mgr.spawn({ name: "B", task: "b" });                     // 走全局默认
    await mgr.awaitIdle(5000);
    expect(routed).toEqual(["api:mid", "api:cheap"]);

    const noDefault = new SubAgentManager(async (def) => {
      routed.push(def.model ?? "<inherit>");
      return "done";
    });
    noDefault.spawn({ name: "C", task: "c" });               // 无全局默认 → 不写 model（继承）
    await noDefault.awaitIdle(5000);
    expect(routed).toContain("<inherit>");
  });

  it("setDefaultModel 即时生效：后续 spawn 应用新档，运行中不受影响", async () => {
    const routed: string[] = [];
    const mgr = new SubAgentManager(async (def) => {
      await sleep(10);
      routed.push(def.model ?? "");
      return "done";
    }, { concurrency: 1 });
    mgr.spawn({ name: "A", task: "a" });      // 无默认 → 不写
    mgr.setDefaultModel("local:qwen3b");      // 设置廉价本地档
    mgr.spawn({ name: "B", task: "b" });      // 应用新档
    await mgr.awaitIdle(5000);
    expect(routed[0]).toBe("");
    expect(routed[1]).toBe("local:qwen3b");
    expect(mgr.getDefaultModel()).toBe("local:qwen3b");
  });

  it("delegate(overrides.model) 最高优先：显式指定 > 声明式 > 全局默认", async () => {
    const routed: Array<{ name: string; model: string }> = [];
    const mgr = new SubAgentManager(async (def) => {
      await sleep(5);
      routed.push({ name: def.name, model: def.model ?? "" });
      return "done";
    }, { defaultModel: "api:cheap" });
    mgr.register({ name: "审查员", description: "代码审查质量检查", systemPrompt: "x", model: "api:mid" });
    const r1 = mgr.delegate("审查这段代码", { model: "api:fast" }); // 对话显式指定最高
    const r2 = mgr.delegate("审查这段代码");                         // 无显式 → def.model
    await mgr.awaitIdle(5000);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(routed.find((x) => x.name === "审查员")?.model).toBe("api:fast");
    expect(routed.some((x) => x.model === "api:fast")).toBe(true);
    expect(routed.some((x) => x.model === "api:mid")).toBe(true);
    expect(routed.some((x) => x.model === "api:cheap")).toBe(false); // def.model 已顶掉全局默认
  });

  it("A-975：def.model='inherit'（继承占位）不遮挡全局默认模型——廉价执行档应生效", async () => {
    // 用户场景：内置专家定义都写 model:"inherit"（跟随主对话），但用户配置了全局子代理默认模型
    // （廉价执行档）。此前 `|| this.defaultModel` 因 "inherit" 非空导致默认模型永不生效
    // （"能设置子代理模型却执行时不生效"根因）。现在显式 api:/local: 依旧最高，defaultModel 其次。
    const routed: Array<{ name: string; model: string }> = [];
    const mgr = new SubAgentManager(async (def) => {
      await sleep(5);
      routed.push({ name: def.name, model: def.model ?? "" });
      return "done";
    }, { defaultModel: "api:cheap:exec" });
    mgr.register({ name: "调研员", description: "联网搜索调研信息", systemPrompt: "x", model: "inherit" });
    // 无显式模型 → def.model="inherit" → 应落到全局默认（廉价执行档）
    const r = mgr.delegate("请联网搜索这份资料的调研信息");
    await mgr.awaitIdle(5000);
    expect(r).not.toBeNull();
    expect(routed.find((x) => x.name === "调研员")?.model).toBe("api:cheap:exec");
  });

  it("A-975：def.model 显式本地/api 依旧最高，不受全局默认影响（inherit 是唯一被覆盖的占位）", async () => {
    const routed: Array<{ name: string; model: string }> = [];
    const mgr = new SubAgentManager(async (def) => {
      await sleep(5);
      routed.push({ name: def.name, model: def.model ?? "" });
      return "done";
    }, { defaultModel: "api:cheap" });
    mgr.register({ name: "专项", description: "专项分析任务", systemPrompt: "x", model: "local:qwen3b" });
    mgr.delegate("做专项分析");
    await mgr.awaitIdle(5000);
    expect(routed.find((x) => x.name === "专项")?.model).toBe("local:qwen3b");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   A-980-R30：子代理目录 + 点名委派。
   为什么必须有这两样：此前可用子代理只活在管理器内部，模型**完全不知道能问谁**
   （工具描述里硬编码三个方向，用户勾选的自建 Agent 名字从不进提示词）→ 用户配好了也派不到。
   ───────────────────────────────────────────────────────────────────────── */

describe("SubAgentManager — 目录与点名委派（A-980-R30）", () => {
  const defs = [
    { name: "代码审查员", description: "审查代码质量、发现潜在 bug", systemPrompt: "你是代码审查专家" },
    { name: "调研员", description: "联网搜索资料、多源调研与引用整理", systemPrompt: "你是调研专家" },
  ];

  it("catalog 列出已注册定义（名称 + 描述 + 来源），供注入系统提示", () => {
    const mgr = new SubAgentManager(async () => "ok");
    mgr.register(defs[0]!);
    mgr.register(defs[1]!);
    const cat = mgr.catalog();
    expect(cat).toHaveLength(2);
    expect(cat[0]).toEqual({ name: "代码审查员", description: "审查代码质量、发现潜在 bug", source: "builtin" });
  });

  it("catalog 区分「用户选定」与「内置」，用户选定优先标记", () => {
    const mgr = new SubAgentManager(async () => "ok");
    mgr.register(defs[0]!);
    mgr.setUserSelected([{ ...defs[1]!, userSelected: true }]);
    const cat = mgr.catalog();
    expect(cat.find((c) => c.name === "调研员")!.source).toBe("user");
    expect(cat.find((c) => c.name === "代码审查员")!.source).toBe("builtin");
  });

  it("catalog 无定义时返回空数组（不占上下文）", () => {
    expect(new SubAgentManager(async () => "ok").catalog()).toEqual([]);
  });

  it("findByName：精确 > 包含（双向），空串/未命中返回 null", () => {
    const mgr = new SubAgentManager(async () => "ok");
    mgr.register(defs[0]!);
    expect(mgr.findByName("代码审查员")!.name).toBe("代码审查员");
    expect(mgr.findByName("代码审查")!.name).toBe("代码审查员");   // 包含（名字含查询）
    expect(mgr.findByName("审查员")!.name).toBe("代码审查员");     // 包含（查询含于名字）
    expect(mgr.findByName("不存在的")).toBeNull();
    expect(mgr.findByName("")).toBeNull();
  });

  it("delegate 点名优先于语义打分（点名绕开自动匹配）", async () => {
    const seen: string[] = [];
    const mgr = new SubAgentManager(async (def) => { seen.push(def.name); return "ok"; });
    mgr.register(defs[0]!);
    mgr.register(defs[1]!);
    // 任务文本明明更像"调研"，但点名了「代码审查员」→ 必须听点名
    const run = mgr.delegate("调研一下竞品的代码质量", { agent: "代码审查员" });
    expect(run!.name).toBe("代码审查员");
    expect(run!.definitionName).toBe("代码审查员");
    await mgr.awaitIdle(2000);
    expect(seen).toEqual(["代码审查员"]);
  });

  it("delegate 点名未命中 → 返回 null（不静默回落到打分结果，交给工具层如实上报）", () => {
    const mgr = new SubAgentManager(async () => "ok");
    mgr.register(defs[0]!);
    // 任务文本能命中「代码审查员」，但用户/模型点名了一个不存在的角色 → 必须 null
    expect(mgr.delegate("审查这段代码", { agent: "不存在的角色" })).toBeNull();
    // 不点名时才走自动匹配
    expect(mgr.delegate("审查这段代码")!.name).toBe("代码审查员");
  });

  it("点名派发仍应用定义的 systemPrompt / model / 超时（合成路径不回退默认值）", async () => {
    let got: { systemPrompt?: string; timeoutMs?: number } = {};
    const mgr = new SubAgentManager(async (def) => { got = { systemPrompt: def.systemPrompt, timeoutMs: def.timeoutMs }; return "ok"; });
    mgr.register({ name: "专家", description: "d", systemPrompt: "专用指令", timeoutMs: 12_345 });
    mgr.delegate("随便", { agent: "专家" });
    await mgr.awaitIdle(3000);
    expect(got.systemPrompt).toBe("专用指令");
    expect(got.timeoutMs).toBe(12_345);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   A-980-R31：中断链路的"部分产出保留"与记录可溯源（用户实测三连问的回归锚点）
   ───────────────────────────────────────────────────────────────────────── */

describe("SubAgentManager — 中断不丢产出（A-980-R31）", () => {
  it("超时中断时保留 runner 返回的部分正文（此前 run.result 恒空 → 落盘 0 字节）", async () => {
    const mgr = new SubAgentManager(async (_def, ctx) => {
      // 模拟"引擎正确响应 abort"：信号中止即收尾，并把已产出的部分正文返回
      await new Promise<void>((r) => {
        const t = setTimeout(r, 5000);
        ctx?.signal.addEventListener("abort", () => { clearTimeout(t); r(); });
      });
      return "已完成前两步：① 读取数据 ② 清洗字段（第③步被中断）";
    });
    const run = mgr.spawn({ name: "数据分析员", task: "分析这份表", timeoutMs: 40 });
    const final = await mgr.wait(run.id, 3000);
    expect(final!.status).toBe("timeout");
    expect(final!.error).toContain("超时");
    // 关键：状态如实是"超时中断"，但产出不丢
    expect(final!.result).toContain("已完成前两步");
  });

  it("取消时同样保留部分产出（cancelled ≠ 白干）", async () => {
    const mgr = new SubAgentManager(async (_def, ctx) => {
      await new Promise<void>((r) => {
        const t = setTimeout(r, 5000);
        ctx?.signal.addEventListener("abort", () => { clearTimeout(t); r(); });
      });
      return "已产出部分内容";
    });
    const run = mgr.spawn({ name: "调研员", task: "调研", timeoutMs: 5000 });
    await sleep(20);
    mgr.cancel(run.id);
    const final = await mgr.wait(run.id, 3000);
    expect(final!.status).toBe("cancelled");
    expect(final!.result).toContain("已产出部分内容");
  });

  it("runner 确实拿到了 signal（装配层漏传就是 100% 超时的根因）", async () => {
    let seen: AbortSignal | undefined;
    const mgr = new SubAgentManager(async (_def, ctx) => { seen = ctx?.signal; return "ok"; });
    const run = mgr.spawn({ name: "X", task: "t" });
    await mgr.awaitIdle(2000);
    expect(seen).toBeDefined();
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(run.status).toBe("done");
  });

  it("运行记录带 task 与 timeoutMs（面板/落盘可回答「这次让它干什么、限时多少」）", async () => {
    const mgr = new SubAgentManager(async () => "ok");
    const run = mgr.spawn({ name: "研究", task: "把 A 与 B 对比成表格", timeoutMs: 123_456 });
    const snap = mgr.status(run.id)!;
    expect(snap.task).toBe("把 A 与 B 对比成表格");
    expect(snap.timeoutMs).toBe(123_456);
    // 未设预算则不写 timeoutMs（面板显示"不限时"，而不是伪造一个 0 秒预算）
    const unlimited = mgr.spawn({ name: "Y", task: "t" });
    expect(mgr.status(unlimited.id)!.timeoutMs).toBeUndefined();
    await mgr.awaitIdle(2000);
  });

  it("forgetTerminal 只清已终态记录，在途任务必须保留（清空历史 ≠ 掐死在途工作）", async () => {
    const mgr = new SubAgentManager(async () => { await sleep(60); return "ok"; }, { concurrency: 1 });
    const finished = mgr.spawn({ name: "done-1", task: "t" });
    await mgr.awaitIdle(3000);
    const inFlight = mgr.spawn({ name: "running-1", task: "t" });
    await sleep(10);
    const dropped = mgr.forgetTerminal();
    expect(dropped).toBe(1);
    const ids = mgr.list().map((r) => r.id);
    expect(ids).not.toContain(finished.id);
    expect(ids).toContain(inFlight.id); // 在途的还在
    await mgr.awaitIdle(3000);
  });
});
