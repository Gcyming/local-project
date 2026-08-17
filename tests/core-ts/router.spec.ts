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
        throw new UpstreamError(`上游 ${b?.status ?? 500}`, b?.status ?? 500, b?.kind ?? "upstream");
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
