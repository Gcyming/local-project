import { describe, expect, it } from "vitest";
import { ModelRouter, type RouteEntry } from "../../core-ts/src/router.js";

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
