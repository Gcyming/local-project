



















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RpmLimiter,
  resolveRpm,
  type LimiterClock,
} from "../../core-ts/src/llm/rpmLimiter.js";
import {
  resolveDeclaredRpm,
  rpmDeclared,
  RPM_VERIFIED_AT,
  MODEL_CAPABILITIES,
} from "../../shared/gen/model-capabilities.js";

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");


function fakeClock(): LimiterClock & { sleeps: number[] } {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => { sleeps.push(ms); t += ms; return Promise.resolve(); },
    sleeps,
  };
}



describe("A-1092 A 组 — 四层取值优先级", () => {
  it("A1 实测 > 手填（实测是上游亲口说的，任何人工输入都不该盖过它）", () => {
    expect(resolveRpm({ observed: 50, declared: 10, manual: 7 })).toEqual({ rpm: 50, source: "observed" });
  });

  it("A2 无实测 → 手填压过声明（用户比内置表更懂自己的档位）", () => {
    expect(resolveRpm({ observed: null, declared: 10, manual: 7 })).toEqual({ rpm: 7, source: "manual" });
    expect(resolveRpm({ observed: undefined, declared: 10, manual: 7 })).toEqual({ rpm: 7, source: "manual" });
  });

  it("A3 无实测无手填 → 声明（手填/声明都是可选 key：缺省即「没这个信息」）", () => {
    expect(resolveRpm({ observed: null, declared: 10, manual: null })).toEqual({ rpm: 10, source: "declared" });
    expect(resolveRpm({ observed: null, declared: 10 })).toEqual({ rpm: 10, source: "declared" });
  });

  it("A4 三者都没有 ⇒ 未知（放行，不发明阈值）", () => {
    expect(resolveRpm({ observed: null, declared: null, manual: null })).toEqual({ rpm: null, source: "unknown" });
    expect(resolveRpm({})).toEqual({ rpm: null, source: "unknown" });
  });

  it("A5 手填的坏值（0 / 负数 / NaN）当**没有手填**，链条继续落到声明", () => {
    expect(resolveRpm({ observed: null, declared: 10, manual: 0 })).toEqual({ rpm: 10, source: "declared" });
    expect(resolveRpm({ observed: null, declared: 10, manual: -3 })).toEqual({ rpm: 10, source: "declared" });
    expect(resolveRpm({ observed: null, declared: 10, manual: Number.NaN })).toEqual({ rpm: 10, source: "declared" });
  });

  it("A6 手填有效时，源标注必须是 manual（不许把手填说成实测）", () => {
    expect(resolveRpm({ observed: null, declared: null, manual: 5 }).source).toBe("manual");
  });

  it("A7 A-1106：入参按 key 传 ⇒ **位置不再承载语义**（填错 key 由 tsc 拒绝，而不是静默按位置错配）", () => {
    
    const a = resolveRpm({ observed: null, manual: 7, declared: 10 });
    const b = resolveRpm({ declared: 10, observed: null, manual: 7 });
    const c = resolveRpm({ manual: 7, declared: 10, observed: null });
    expect(a).toEqual({ rpm: 7, source: "manual" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});



describe("A-1092 B 组 — RpmLimiter 接入手填解析器", () => {
  it("B1 setManualRpmOf 注入后，resolve 返回 manual", () => {
    const l = new RpmLimiter({ clock: fakeClock(), declaredOf: () => 10 });
    l.setManualRpmOf(() => 7);
    expect(l.resolve("k", "m")).toEqual({ rpm: 7, source: "manual" });
  });

  it("B2 实测值一旦到来，立刻压过手填", () => {
    const l = new RpmLimiter({ clock: fakeClock(), declaredOf: () => 10 });
    l.setManualRpmOf(() => 7);
    l.observe("k", { limitRequests: 50 }, 200);
    expect(l.resolve("k", "m")).toEqual({ rpm: 50, source: "observed" });
  });

  it("B3 手填解析器抛错**绝不拖垮请求**（降级为没有手填，与 observe 同一纪律）", () => {
    const l = new RpmLimiter({ clock: fakeClock(), declaredOf: () => 10 });
    l.setManualRpmOf(() => { throw new Error("解析器炸了"); });
    expect(l.resolve("k", "m")).toEqual({ rpm: 10, source: "declared" });
  });

  it("B4 手填生效：额度用满后第 N+1 次会等（手填不是写着好看，是真在限流）", async () => {
    const clock = fakeClock();
    const l = new RpmLimiter({ clock, declaredOf: () => null }); 
    l.setManualRpmOf(() => 2);
    expect((await l.acquire("k", "m")).waitedMs).toBe(0);
    expect((await l.acquire("k", "m")).waitedMs).toBe(0);
    expect((await l.acquire("k", "m")).waitedMs).toBeGreaterThan(0);
  });

  it("B5 默认（未注入）手填解析器 = 无手填（不许悄悄发明一个值）", () => {
    const l = new RpmLimiter({ clock: fakeClock(), declaredOf: () => null });
    expect(l.resolve("k", "m").source).toBe("unknown");
  });

  it("B6 手填按 (key, model) 分桶查（不同 key 可有不同手填值）", () => {
    const l = new RpmLimiter({ clock: fakeClock(), declaredOf: () => null });
    l.setManualRpmOf((key) => (key === "a" ? 3 : 9));
    expect(l.resolve("a", "m").rpm).toBe(3);
    expect(l.resolve("b", "m").rpm).toBe(9);
  });
});



describe("A-1092 G 组 — 任务栏图标：AUMID 提前声明 + nativeImage 窗口图标", () => {
  const mainSrc = (): string => read("gui/src/main/index.ts");

  it("G1 app.setAppUserModelId(APP_AUMID) 必须在源码里（AUMID 不匹配 = 任务栏拿不到安装版图标）", () => {
    expect(mainSrc()).toContain("app.setAppUserModelId(APP_AUMID)");
  });

  it("G2 窗口 icon 必须传**解码后的 nativeImage**，不许传路径字符串", () => {
    const src = mainSrc();
    
    expect(src).not.toMatch(/icon:\s*resolveAppIcon\(\),/);
    expect(src).toMatch(/icon:\s*resolveAppIconImage\(\),/);
  });

  it("G3 resolveAppIconImage 必须在解码失败时**回落 + 出声**，不许静默空白", () => {
    const src = mainSrc();
    expect(src).toContain("const resolveAppIconImage = (): Electron.NativeImage | undefined =>");
    
    const fn = src.slice(src.indexOf("const resolveAppIconImage"));
    const body = fn.slice(0, fn.indexOf("\n};") + 3);
    expect(body).toContain("console.warn");
  });

  it("G4 AUMID 与 electron-builder appId 必须一致（否则通知/任务栏归属不上）", () => {
    const aumid = /export const APP_AUMID = "([^"]+)"/.exec(read("gui/src/main/notifyIdentity.ts"))?.[1];
    const appId = /"appId"\s*:\s*"([^"]+)"/.exec(read("gui/electron-builder.json"))?.[1];
    expect(aumid).toBeTruthy();
    expect(appId).toBe(aumid);
  });
});



describe("A-1092 H 组 — 手填 RPM 的落库链路不许有静默丢弃点", () => {
  it("H1 sanitizeModels（每次读盘都跑的白名单重建）必须透传 rpm", () => {
    const src = read("gui/src/main/providers.ts");
    const fn = src.slice(src.indexOf("function sanitizeModels"));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect(body).toMatch(/rpm:\s*typeof \(rawM as any\)\.rpm === "number"/);
  });

  it("H2 saveProvider 的整条重写必须显式带上 rpm（它是重建不是 merge）", () => {
    const src = read("gui/src/main/providers.ts");
    
    expect(src).toContain("let nextRpm: number | undefined;");
    expect(src).toMatch(/\.\.\.\(nextRpm !== undefined \? \{ rpm: nextRpm \} : \{\}\)/);
  });

  it("H3 saveProvider 的 enrich 合并分支必须回填 prev.rpm（enrich 永远不产出它）", () => {
    expect(read("gui/src/main/providers.ts")).toContain("rpm: prev.rpm,");
  });

  it("H4 refreshProviderModels 的模型重建必须回填 prev?.rpm（否则一键刷新抹掉手填）", () => {
    expect(read("gui/src/main/providers.ts")).toContain("rpm: prev?.rpm,");
  });

  it("H5 ProviderSummary / ModelSpec 两端（主进程与 ipc 契约）都必须有 rpm 字段", () => {
    expect(read("gui/src/main/providers.ts")).toMatch(/interface ProviderSummary[\s\S]*?rpm\?: number;/);
    const ipc = read("gui/src/shared/ipc.ts");
    expect(ipc).toMatch(/interface ProviderSummary[\s\S]*?rpm\?: number;/);
    expect(ipc).toMatch(/interface ModelSpec[\s\S]*?rpm\?: number;/);
  });

  it("H6 面板保存时必须把 rpm 回传（否则 UI 填了也不落库）", () => {
    const src = read("gui/src/renderer/pages/ProvidersPanel.tsx");
    expect(src).toContain("rpm: parseRpmInput(edit.rpm),");
    expect(src).toContain("rpm: m.rpm ?? undefined,");
  });

  it("H7 引擎必须把手填解析器接到共享限流器上（接了才有兜底）", () => {
    const src = read("core-ts/src/services/engine.ts");
    expect(src).toContain("this.bindManualRpm();");
    expect(src).toContain("getSharedRpmLimiter().setManualRpmOf(");
  });
});



describe("A-1092 I 组 — 能力表里的 rpm 必须是有官方一手来源的「每分钟请求数」", () => {
  it("I1 凡写了 rpm 的厂商，RPM_VERIFIED_AT 必有核实日期（不许看着永远新鲜）", () => {
    for (const v of MODEL_CAPABILITIES) {
      const hasRpm = rpmDeclared(v.key) !== undefined || v.models.some((m) => m.rpm !== undefined);
      if (hasRpm) {
        expect(RPM_VERIFIED_AT[v.key], `厂商 ${v.key} 写了 rpm 却没有核实日期`).toBeTruthy();
      }
    }
  });

  it("I2 ⚠️ DeepSeek 必须**没有** rpm —— 官方只公布并发数（2500/500），不是 RPM", () => {
    
    expect(rpmDeclared("deepseek")).toBeUndefined();
    expect(resolveDeclaredRpm("deepseek-flash")).toBeUndefined();
    expect(resolveDeclaredRpm("deepseek-v4-pro")).toBeUndefined();
  });

  it("I3 ⚠️ 按 tier 分层的厂商（openai / claude / gemini 族）不许写死一个固定 rpm", () => {
    
    expect(rpmDeclared("openai")).toBeUndefined();
    expect(rpmDeclared("claude")).toBeUndefined();
  });

  it("I4 ⚠️ QPS / 并发口径的国内厂商不许写 rpm（QPS×60 ≠ RPM）", () => {
    for (const k of ["qwen", "glm", "hunyuan", "ernie", "baichuan"]) {
      expect(rpmDeclared(k), `${k} 是 QPS/并发口径，不能当 RPM`).toBeUndefined();
    }
  });

  it("I5 Cohere 写的是**试用档 20**（写生产档 500 会让免费用户被限流而不自知）", () => {
    expect(rpmDeclared("cohere")).toBe(20);
    expect(RPM_VERIFIED_AT.cohere).toBeTruthy();
  });

  it("I6 Agnes 仍是官方下调后的免费档 10（A-1091 的既有结论，不许被本轮误改）", () => {
    expect(rpmDeclared("agnes")).toBe(10);
    expect(RPM_VERIFIED_AT.agnes).toBe("2026-09-23");
  });
});



describe("A-1092 J 组 — RPM 限流器已经是 Agent-Loop 的必经之路（单点布置，不重复布置）", () => {
  it("J1 Agent-Loop 每轮都走 router.chatStream（工具循环的唯一 LLM 出口）", () => {
    expect(read("core-ts/src/tool_loop.ts")).toContain("await this.router.chatStream(");
  });

  it("J2 router.chatStream 的每个候选路由都经 createClient 建客户端", () => {
    const src = read("core-ts/src/router.ts");
    expect(src).toContain("await this.createClient(route).chatStream(");
    expect(src).toContain("await this.createClient(route).chat(");
  });

  it("J3 createClient 给每条路由都带上 rateLimit 身份（含模型，降级换模型后仍按新模型限流）", () => {
    const src = read("core-ts/src/router.ts");
    expect(src).toContain("rateLimit: { key: providerKeyOfRoute(route), model: route.model },");
  });

  it("J4 限流的**唯一咽喉**是 fetchWithRetry：发前 acquire、收后 observe", () => {
    const src = read("core-ts/src/llm/client.ts");
    
    
    
    
    expect(src).toContain("await getSharedRpmLimiter().acquire(rateLimit.key, rateLimit.model, (ms) => {");
    expect(src).toContain("getSharedRpmLimiter().observe(");
    
    expect(src, "等待期界面会重新变成一整段空白").not.toContain("await getSharedRpmLimiter().acquire(rateLimit.key, rateLimit.model);");
  });

  it("J5 限流器是**进程级共享单例**（各层各持一份会让合起来超限）", () => {
    const src = read("core-ts/src/llm/rpmLimiter.ts");
    expect(src).toContain("export function getSharedRpmLimiter(): RpmLimiter {");
    expect(src).toContain("if (!shared) { shared = new RpmLimiter(); }");
  });

  it("J6 ⚠️ 不许在 tool_loop.ts 里另起一套 acquire（重复布置 = 两个独立窗口 = 合起来超限）", () => {
    const src = read("core-ts/src/tool_loop.ts");
    expect(src).not.toContain("rpmLimiter");
    expect(src).not.toContain(".acquire(");
  });
});
