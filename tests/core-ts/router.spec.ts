import { describe, expect, it } from "vitest";
import { ModelRouter, type RouteEntry } from "../../core-ts/src/router.js";
import { UpstreamError } from "../../core-ts/src/llm/client.js";

describe("ModelRouter（路由表 + 降级链声明）", () => {
  const local: RouteEntry = {
    name: "sidecar", baseUrl: "http://127.0.0.1:19100", kind: "local", priority: 100, roles: ["chat", "embedding"],
  };
  const cloud: RouteEntry = {
    name: "cloud-primary", baseUrl: "https://api.example.com/v1", apiKey: "sk-x", kind: "cloud", priority: 90, roles: ["chat"],
  };

  it("select 返回优先级最高的匹配路由", () => {
    const router = new ModelRouter([cloud, local]);
    expect(router.select("chat")?.name).toBe("sidecar");
    expect(router.select("embedding")?.name).toBe("sidecar");
  });

  it("fallbackChain 按优先级降序声明降级链（阶段 3 消费）", () => {
    const router = new ModelRouter([cloud, local]);
    const chain = router.fallbackChain("chat");
    expect(chain.map((r) => r.name)).toEqual(["sidecar", "cloud-primary"]);
  });

  it("无匹配角色返回 undefined / 空链", () => {
    const router = new ModelRouter([local]);
    expect(router.select("chat")).toBeDefined();
    expect(router.fallbackChain("chat").length).toBe(1);
  });

  it("add/reset 动态维护路由表", () => {
    const router = new ModelRouter();
    expect(router.select("chat")).toBeUndefined();
    router.add(local);
    expect(router.select("chat")?.name).toBe("sidecar");
    router.reset();
    expect(router.list()).toEqual([]);
  });

  it("list 返回副本（外部修改不影响内部）", () => {
    const router = new ModelRouter([local]);
    const list = router.list();
    list.push(cloud);
    expect(router.list().length).toBe(1);
  });
});

describe("ModelRouter 降级链（阶段 3：OOM/网络失败 → 自动切换）", () => {
  const okResp = {
    id: "x", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  };

  interface Behavior {
    status?: number;
    kind?: "upstream" | "rate_limited" | "timeout" | "protocol";
    /** 直接抛普通错误（模拟网络不可达，非 UpstreamError） */
    throwPlain?: boolean;
    /** 先回调 onDelta 再抛错（模拟开流后中断） */
    streamBreak?: boolean;
    /** A-157：模型级/供应商级错误作用域（model → 4xx 也可降级换模型） */
    modelScope?: "model" | "provider";
  }

  function makeRouter(behaviors: Record<string, Behavior>) {
    const routes: RouteEntry[] = [
      { name: "local", baseUrl: "http://local", kind: "local", priority: 100, roles: ["chat"], model: "qwen-local" },
      { name: "cloud", baseUrl: "http://cloud", kind: "cloud", priority: 90, roles: ["chat"], model: "gpt-cloud" },
    ];
    return new ModelRouter(routes, (route) => {
      const b = behaviors[route.name];
      const throwUp = () => {
        if (b?.throwPlain) {
          throw new TypeError("fetch failed");
        }
        throw new UpstreamError(`上游 ${b?.status ?? 500}`, b?.status ?? 500, b?.kind ?? "upstream", b?.modelScope);
      };
      return {
        chat: async (payload: { model?: string }) => {
          if (b) {
            throwUp();
          }
          return { ...okResp, model: payload.model ?? "m" };
        },
        chatStream: async (payload: { model?: string }, onDelta: (d: string) => void) => {
          if (b?.streamBreak) {
            onDelta("部分内容");
            throwUp();
          }
          if (b) {
            throwUp();
          }
          onDelta("a");
          return { text: "a", chunks: 1, model: payload.model ?? "m" };
        },
      } as never;
    });
  }

  it("首选 503（OOM）→ 自动降级次选成功，routeName 与 fallbackLog 记录", async () => {
    const router = makeRouter({ local: { status: 503, kind: "upstream" } });
    const r = await router.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.routeName).toBe("cloud");
    expect(router.fallbackCount).toBe(1);
    expect(router.fallbackLog()[0].from).toBe("local");
    expect(router.fallbackLog()[0].to).toBe("cloud");
    expect(r.response.model).toBe("gpt-cloud"); // 降级后注入次选路由的 model
  });

  it("首选网络不可达（非 UpstreamError）→ 降级", async () => {
    const router = makeRouter({ local: { throwPlain: true } });
    const r = await router.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.routeName).toBe("cloud");
    expect(router.fallbackLog()[0].reason).toContain("fetch failed");
  });

  it("4xx（非 429）不降级，如实抛出", async () => {
    const router = makeRouter({ local: { status: 400, kind: "upstream" } });
    await expect(router.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("chat 全部路由失败");
    expect(router.fallbackCount).toBe(0);
  });

  it("全部失败 → 聚合错误（含每级原因）", async () => {
    const router = makeRouter({ local: { status: 503 }, cloud: { status: 503 } });
    await expect(router.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/local.*cloud/s);
    expect(router.fallbackCount).toBe(1);
  });

  it("流式：开流后中断 → 抛错不降级（诚实协议）", async () => {
    const router = makeRouter({ local: { streamBreak: true }, cloud: { status: 503 } });
    await expect(
      router.chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {}),
    ).rejects.toThrow("流式中断（local，已收到部分内容，不降级）");
    expect(router.fallbackCount).toBe(0); // 未触发降级
  });

  it("流式：请求建立前失败（503）→ 降级到次选", async () => {
    const router = makeRouter({ local: { status: 503 } });
    const r = await router.chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {});
    expect(r.routeName).toBe("cloud");
    expect(r.text).toBe("a");
  });

  it("模型级 400（Model is unavailable）→ 降级换模型（A-157）", async () => {
    const router = makeRouter({ local: { status: 400, kind: "upstream", modelScope: "model" } });
    const r = await router.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.routeName).toBe("cloud");
    expect(router.fallbackCount).toBe(1);
  });

  it("模型级 403（RegionError 区域限制）→ 降级换模型（A-157）", async () => {
    const router = makeRouter({ local: { status: 403, kind: "upstream", modelScope: "model" } });
    const r = await router.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.routeName).toBe("cloud");
    expect(router.fallbackLog()[0].reason).toContain("403");
  });

  it("供应商级 401/403 认证 → 不降级（换模型无意义）", async () => {
    const router = makeRouter({ local: { status: 403, kind: "upstream", modelScope: "provider" } });
    await expect(router.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("chat 全部路由失败");
    expect(router.fallbackCount).toBe(0);
  });

  it("熔断冷却（A-158）：可降级失败的路由进入冷却，fallbackChain 跳过；全部冷却则回退全量", async () => {
    const router = makeRouter({ local: { status: 503 } });
    // 模拟首选失败 → 冷却标记
    router.markCooldown("local", 3600_000);
    const chain = router.fallbackChain("chat");
    // 冷却中的 local 被跳过 → 只有 cloud
    expect(chain.map((r) => r.name)).toEqual(["cloud"]);
    expect(router.cooldownList()).toContain("local");
    // 全部冷却 → 回退全量（不空链报死）
    router.markCooldown("cloud", 3600_000);
    const chain2 = router.fallbackChain("chat");
    expect(chain2.length).toBe(2);
  });

  it("熔断冷却：chat 降级失败后自动标记冷却（链尾前的失败路由被冷却，下次请求优先避开）", async () => {
    const router = makeRouter({ local: { status: 503 }, cloud: { status: 503 } });
    await expect(router.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("chat 全部路由失败");
    // local（链首，可有后续候选）失败 → 已冷却；cloud（链尾）失败无后续可跳 → 不再冷却（符合预期）
    expect(router.cooldownList()).toContain("local");
    expect(router.cooldownList()).not.toContain("cloud");
  });

  it("空路由表 → 明确错误", async () => {
    const router = new ModelRouter();
    await expect(router.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("无可用 chat 路由");
  });

  it("reset 清空降级记录", async () => {
    const router = makeRouter({ local: { status: 503 } });
    await router.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(router.fallbackCount).toBe(1);
    router.reset();
    expect(router.fallbackCount).toBe(0);
    expect(router.fallbackLog()).toEqual([]);
  });
});

describe("ModelRouter 探针层第 2 层：前置剔除已知失效模型（setDeadModelCheck）", () => {
  /** provider:model 形式的路由名（nameProviderKey 取冒号前为 provider，route.model 为具体模型） */
  function makeDeadRouter(dead: (providerKey: string, modelId: string) => boolean, inject: boolean) {
    const routes: RouteEntry[] = [
      { name: "agg:gpt-4o-dead", baseUrl: "https://agg", kind: "cloud", priority: 90, roles: ["chat"], model: "gpt-4o-dead" },
      { name: "agg:deepseek-live", baseUrl: "https://agg", kind: "cloud", priority: 80, roles: ["chat"], model: "deepseek-live" },
      { name: "agg:any-model", baseUrl: "https://agg", kind: "cloud", priority: 70, roles: ["chat"], /* 无 model 单路由 */ },
    ];
    const router = new ModelRouter(routes);
    if (inject) { router.setDeadModelCheck(dead); }
    return router;
  }

  it("被判定失效的具体模型路由被前置剔除，降级链跳过它", () => {
    const router = makeDeadRouter((p, m) => p === "agg" && m === "gpt-4o-dead", true);
    const chain = router.fallbackChain("chat");
    // gpt-4o-dead 被剔除；deepseek-live（未判失效）与 any-model（无 model 不剔除）保留
    expect(chain.map((r) => r.name)).toEqual(["agg:deepseek-live", "agg:any-model"]);
  });

  it("供应商级失效（dead=false）→ 不剔除任何路由（同供应商其它模型仍可用）", () => {
    const router = makeDeadRouter(() => false, true);
    expect(router.fallbackChain("chat").length).toBe(3);
  });

  it("全部带 model 路由都被判失效 → 回退全量（避免空链报死）", () => {
    // 剔除规则对「具体 model」路由全命中（any-model 无 model，不剔除）
    const router = makeDeadRouter((p, m) => p === "agg" && m !== "any-model", true);
    // gpt-4o-dead / deepseek-live 被剔除，any-model 保留 → 非空
    const chain = router.fallbackChain("chat");
    expect(chain.map((r) => r.name)).toEqual(["agg:any-model"]);
  });

  it("setDeadModelCheck(null) 复位 → 回到纯 priority 降级链（不剔除）", () => {
    const router = makeDeadRouter((p, m) => m === "gpt-4o-dead", true);
    expect(router.fallbackChain("chat").length).toBe(2);
    router.setDeadModelCheck(null);
    expect(router.fallbackChain("chat").length).toBe(3);
  });

  it("未注入 check（默认）→ 全量降级链不受影响", () => {
    const router = makeDeadRouter(() => false, false); // 未注入
    expect(router.fallbackChain("chat").length).toBe(3);
  });
});
