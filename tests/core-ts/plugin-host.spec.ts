import { describe, expect, it, vi } from "vitest";
import { Tool, ToolRegistry } from "../../core-ts/src/tools/registry.js";
import { PluginHost } from "../../core-ts/src/plugin/host.js";
import type { PluginManifest } from "../../core-ts/src/plugin/manifest.js";

function m(over: Partial<PluginManifest> & { name: string }): PluginManifest {
  return {
    version: "1.0.0",
    description: "测试用插件。",
    origin: "user",
    provides: ["tools"],
    ...over,
  };
}

const SKILL_TOOLS = ["skill_search", "skill_lookup"];

/**
 * 默认测试宿主：技能入口工具的登记与撤销由宿主通过钩子注入，
 * host 自身不再硬编码任何工具名。语义与旧实现等价 ——
 * 旧实现里挂在 instructions 分支上的 registry.unregister，现在由 registerInstructions 返回的句柄承担。
 */
function host(registry = new ToolRegistry()): PluginHost {
  seedSkillTools(registry);
  return new PluginHost({
    registerInstructions: () => [
      {
        label: `${SKILL_TOOLS.join("/")}（技能经由 SkillRegistry 登记）`,
        dispose: () => {
          for (const n of SKILL_TOOLS) {
            registry.unregister(n);
          }
        },
      },
    ],
  });
}

function seedSkillTools(registry: ToolRegistry): void {
  for (const n of SKILL_TOOLS) {
    registry.register(new Tool({
      name: n,
      description: "技能工具占位",
      parameters: { type: "object", properties: {} },
      executeFn: async () => "ok",
    }));
  }
}

describe("PluginHost：按 requires 拓扑排序", () => {
  it("依赖在前，被依赖者后加载", async () => {
    const h = host();
    await h.load([m({ name: "web-access", requires: ["memory"] }), m({ name: "memory" })]);

    expect(h.list().map((r) => r.manifest.name)).toEqual(["memory", "web-access"]);
    expect(h.get("memory")!.status).toBe("loaded");
    expect(h.get("web-access")!.status).toBe("loaded");
  });

  it("多级依赖链按深度排序", async () => {
    const h = host();
    await h.load([
      m({ name: "c", requires: ["b"] }),
      m({ name: "b", requires: ["a"] }),
      m({ name: "a" }),
    ]);

    expect(h.list().map((r) => r.manifest.name)).toEqual(["a", "b", "c"]);
  });

  it("同一依赖层内按输入顺序（排序稳定）", async () => {
    const h = host();
    await h.load([
      m({ name: "root" }),
      m({ name: "zeta", requires: ["root"] }),
      m({ name: "alpha", requires: ["root"] }),
      m({ name: "mid", requires: ["root"] }),
    ]);

    expect(h.list().map((r) => r.manifest.name)).toEqual(["root", "zeta", "alpha", "mid"]);
  });

  it("无依赖的插件保持输入顺序", async () => {
    const h = host();
    await h.load([m({ name: "b" }), m({ name: "a" }), m({ name: "c" })]);
    expect(h.list().map((r) => r.manifest.name)).toEqual(["b", "a", "c"]);
  });

  it("get 按名字取到记录，未知名返回 undefined", async () => {
    const h = host();
    await h.load([m({ name: "solo" })]);
    expect(h.get("solo")!.manifest.name).toBe("solo");
    expect(h.get("missing")).toBeUndefined();
  });

  it("load 空数组返回空列表", async () => {
    expect(await host().load([])).toEqual([]);
  });
});

describe("PluginHost：依赖缺失与失败隔离", () => {
  it("缺依赖的插件 failed 并说明缺谁，不抛异常", async () => {
    const h = host();
    const records = await h.load([m({ name: "web-access", requires: ["nonexistent"] })]);

    expect(records.length).toBe(1);
    expect(records[0].status).toBe("failed");
    expect(records[0].error).toMatch(/nonexistent/);
  });

  it("缺依赖不阻断其他插件加载", async () => {
    const h = host();
    await h.load([m({ name: "web-access", requires: ["missing-dep"] }), m({ name: "memory" })]);

    expect(h.get("web-access")!.status).toBe("failed");
    expect(h.get("memory")!.status).toBe("loaded");
  });

  it("依赖方因依赖失败而失败（传递性，不静默加载）", async () => {
    const h = host();
    await h.load([m({ name: "a", requires: ["ghost"] }), m({ name: "b", requires: ["a"] })]);

    expect(h.get("a")!.status).toBe("failed");
    expect(h.get("b")!.status).toBe("failed");
    expect(h.get("b")!.error).toMatch(/'a'/);
  });

  it("重名插件标记为 failed 且不重复登记", async () => {
    const h = host();
    await h.load([m({ name: "dup" }), m({ name: "dup" })]);

    expect(h.get("dup")!.status).toBe("failed");
    expect(h.get("dup")!.error).toMatch(/重复/);
    expect(h.list().filter((r) => r.manifest.name === "dup").length).toBe(1);
  });
});

describe("PluginHost：环检测不抛异常", () => {
  it("二元环：两者 failed，环外正常加载", async () => {
    const h = host();
    let threw = false;
    try {
      await h.load([
        m({ name: "a", requires: ["b"] }),
        m({ name: "b", requires: ["a"] }),
        m({ name: "free" }),
      ]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(h.get("a")!.status).toBe("failed");
    expect(h.get("b")!.status).toBe("failed");
    expect(h.get("a")!.error).toMatch(/循环依赖/);
    expect(h.get("free")!.status).toBe("loaded");
  });

  it("三元环：只有环上的失败", async () => {
    const h = host();
    await h.load([
      m({ name: "a", requires: ["c"] }),
      m({ name: "b", requires: ["a"] }),
      m({ name: "c", requires: ["b"] }),
      m({ name: "standalone" }),
    ]);

    for (const n of ["a", "b", "c"]) {
      expect(h.get(n)!.status).toBe("failed");
    }
    expect(h.get("standalone")!.status).toBe("loaded");
  });

  it("环描述里含完整回路", async () => {
    const h = host();
    await h.load([m({ name: "x", requires: ["y"] }), m({ name: "y", requires: ["x"] })]);
    const err = h.get("x")!.error ?? "";
    expect(err).toMatch(/x/);
    expect(err).toMatch(/y/);
  });

  it("部分成环时非环部分仍按序加载", async () => {
    const h = host();
    await h.load([
      m({ name: "base" }),
      m({ name: "p", requires: ["base"] }),
      m({ name: "x", requires: ["y"] }),
      m({ name: "y", requires: ["x"] }),
      m({ name: "tail", requires: ["p"] }),
    ]);

    expect(h.list().map((r) => r.manifest.name)).toEqual(["base", "p", "tail", "x", "y"]);
    expect(h.get("tail")!.status).toBe("loaded");
    expect(h.get("x")!.status).toBe("failed");
    expect(h.get("y")!.status).toBe("failed");
  });

  it("自环被识别为环", async () => {
    const h = host();
    await h.load([m({ name: "self", requires: ["self"] })]);
    expect(h.get("self")!.status).toBe("failed");
  });
});

describe("PluginHost：贡献登记", () => {
  it("instructions 贡献被真正登记，且带撤销钩子", async () => {
    const h = host();
    const records = await h.load([m({ name: "skillbox", provides: ["instructions"] })]);

    expect(records[0].status).toBe("loaded");
    expect(records[0].contributions.join()).toMatch(/instructions/);

    const report = await h.unload("skillbox");
    expect(report.ok).toBe(1);
    expect(h.get("skillbox")!.status).toBe("disabled");
    expect(h.get("skillbox")!.contributions).toEqual([]);
  });

  it("tools 与 prompt 只记录「尚未接线」，不假装已生效", async () => {
    const h = host();
    const records = await h.load([m({ name: "x", provides: ["tools", "prompt"] })]);

    expect(records[0].status).toBe("loaded");
    expect(records[0].contributions).toEqual(["tools:尚未接线", "prompt:尚未接线"]);
  });

  it("tools 钩子缺席时 tools 不登记，如实记尚未接线且不牵连状态", async () => {
    const registry = new ToolRegistry();
    seedSkillTools(registry);
    // 只注入 registerInstructions，不给 registerTools。
    const h = host(registry);
    const records = await h.load([m({ name: "x", provides: ["tools"] })]);

    expect(records[0].status).toBe("loaded");
    expect(records[0].error).toBeUndefined();
    expect(records[0].contributions).toEqual(["tools:尚未接线"]);
    // 没登记 ⇒ 没有可撤销的东西，卸载不得凭空多出撤销成功数。
    expect(await h.unload("x")).toEqual({ ok: 0, failed: [] });
    // 未接线不代表技能工具被摘掉 —— 撤销语义未被误触发。
    expect(registry.get("skill_search")).toBeDefined();
  });

  it("登记钩子返回空数组时同样记尚未接线（不假装已生效）", async () => {
    const h = new PluginHost({ registerInstructions: () => [] });
    const records = await h.load([m({ name: "x", provides: ["instructions"] })]);

    expect(records[0].status).toBe("loaded");
    expect(records[0].contributions).toEqual(["instructions:尚未接线"]);
    expect(await h.unload("x")).toEqual({ ok: 0, failed: [] });
  });

  it("登记钩子返回的 label 直接进 contributions，且卸载后清空", async () => {
    const h = new PluginHost({
      registerTools: () => [
        { label: "工具甲", dispose: () => undefined },
        { label: "工具乙", dispose: () => undefined },
      ],
    });
    const records = await h.load([m({ name: "x", provides: ["tools"] })]);

    expect(records[0].contributions).toEqual(["tools:工具甲/工具乙"]);
    expect((await h.unload("x")).ok).toBe(2);
    expect(h.get("x")!.contributions).toEqual([]);
  });
});

describe("PluginHost：卸载与撤销", () => {
  it("未知名字 unload 返回 ok 0 且不抛", async () => {
    expect(await host().unload("ghost")).toEqual({ ok: 0, failed: [] });
  });

  it("failed 插件无 scope 可撤销，卸载返回空报告", async () => {
    const h = host();
    await h.load([m({ name: "orphan", requires: ["nope"] })]);
    expect(await h.unload("orphan")).toEqual({ ok: 0, failed: [] });
  });

  it("instructions 卸载会把 skill 工具从注册表摘掉", async () => {
    const registry = new ToolRegistry();
    seedSkillTools(registry);
    const h = host(registry);
    await h.load([m({ name: "p", provides: ["instructions"] })]);

    expect(registry.get("skill_search")).toBeDefined();
    await h.unload("p");
    expect(registry.get("skill_search")).toBeUndefined();
    expect(registry.get("skill_lookup")).toBeUndefined();
  });

  it("重复 unload 幂等（第二次不重复执行撤销）", async () => {
    const registry = new ToolRegistry();
    seedSkillTools(registry);
    const h = host(registry);
    await h.load([m({ name: "p", provides: ["instructions"] })]);

    expect((await h.unload("p")).ok).toBe(1);
    expect(await h.unload("p")).toEqual({ ok: 0, failed: [] });
    expect(h.get("p")!.status).toBe("disabled");
  });

  it("卸载后再 load 重新生效", async () => {
    const h = host();
    await h.load([m({ name: "x", provides: ["instructions"] })]);
    await h.unload("x");
    expect(h.get("x")!.status).toBe("disabled");

    await h.load([m({ name: "x", provides: ["instructions"] })]);
    expect(h.get("x")!.status).toBe("loaded");
  });

  it("builtin 插件不可卸载（返回报告而非抛异常，状态与贡献均不变）", async () => {
    const h = host();
    await h.load([m({ name: "sys", origin: "builtin", provides: ["instructions"] })]);
    const before = [...h.get("sys")!.contributions];

    const r = await h.unload("sys");

    expect(r.ok).toBe(0);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].error).toBeInstanceOf(Error);
    expect((r.failed[0].error as Error).message).toMatch(/不可卸载/);
    expect(r.failed[0].index).toBe(0);
    // 加强：抛异常那版测不到「状态没被改」，这里显式断言。
    expect(h.get("sys")!.status).toBe("loaded");
    expect(h.get("sys")!.error).toBeUndefined();
    expect(h.get("sys")!.contributions).toEqual(before);
    // 加强：不可卸载时不许偷偷执行任何撤销。
    expect((await h.unload("sys")).ok).toBe(0);
  });

  it("PluginRecord.unloadable 按判定函数填写，builtin 为 false", async () => {
    const h = host();
    await h.load([m({ name: "sys", origin: "builtin" }), m({ name: "usr" })]);

    expect(h.get("sys")!.unloadable).toBe(false);
    expect(h.get("usr")!.unloadable).toBe(true);
  });

  it("自定义 unloadable 可覆盖默认判定", async () => {
    const h = new PluginHost({
      registerInstructions: () => [{ label: "技能指令", dispose: () => undefined }],
      unloadable: () => true,
    });
    await h.load([m({ name: "sys", origin: "builtin", provides: ["instructions"] })]);

    expect(h.get("sys")!.unloadable).toBe(true);
    expect((await h.unload("sys")).ok).toBe(1);
    expect(h.get("sys")!.status).toBe("disabled");
  });

  it("自定义 unloadable 判为 false 时同样返回报告而非抛异常", async () => {
    const h = new PluginHost({ unloadable: () => false });
    await h.load([m({ name: "usr", origin: "user" })]);

    const r = await h.unload("usr");

    expect(r.ok).toBe(0);
    expect((r.failed[0].error as Error).message).toMatch(/不可卸载/);
    expect(h.get("usr")!.status).toBe("loaded");
  });
});

describe("A-1195：覆盖式重装先撤销上一轮贡献（不泄漏句柄）", () => {
  it("重装时旧 scope 的撤销函数被调用；首轮 load 不误撤", async () => {
    const disposed: string[] = [];
    const h = new PluginHost({
      registerInstructions: () => [
        { label: "h1", dispose: () => { disposed.push("h1"); } },
      ],
    });
    await h.load([m({ name: "a", provides: ["instructions"] })]);
    expect(disposed, "首轮 load 不该触发任何撤销").toEqual([]);

    await h.load([m({ name: "a", provides: ["instructions"] })]);
    expect(disposed, "重装必须先撤销上一轮句柄（此前 entries.clear 直接丢弃 ⇒ 永久泄漏）").toEqual(["h1"]);
  });

  it("从新清单里消失的插件，其旧贡献照样被撤销（逆序：依赖者先撤）", async () => {
    const disposed: string[] = [];
    const h = new PluginHost({
      registerInstructions: (mf) => [
        { label: mf.name, dispose: () => { disposed.push(mf.name); } },
      ],
    });
    await h.load([
      m({ name: "a", provides: ["instructions"] }),
      m({ name: "b", provides: ["instructions"] }),
    ]);
    await h.load([m({ name: "a", provides: ["instructions"] })]);

    expect(disposed, "b 已从清单消失但旧贡献必须被撤；逆序=b 先于 a").toEqual(["b", "a"]);
  });

  it("旧贡献撤销失败不阻断重建，失败如实上报（不静默）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = new PluginHost({
        registerInstructions: (mf) => [
          {
            label: mf.name,
            dispose: () => {
              if (mf.name === "bad") { throw new Error("boom"); }
            },
          },
        ],
      });
      await h.load([
        m({ name: "bad", provides: ["instructions"] }),
        m({ name: "good", provides: ["instructions"] }),
      ]);
      const rec = await h.load([m({ name: "good", provides: ["instructions"] })]);

      expect(rec.map((r) => r.status)).toEqual(["loaded"]);
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("bad")),
        "撤销失败必须 console.error 上报",
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});