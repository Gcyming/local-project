


















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { singleFlight } from "../../gui/src/main/singleFlight.js";

const ROOT = join(__dirname, "../..");
const MAIN = "gui/src/main/index.ts";

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");





function handlerBody(src: string, channel: string): string {
  const start = src.indexOf(`"${channel}"`);
  expect(start, `源码里找不到 handler ${channel}`).toBeGreaterThan(-1);
  const next = src.indexOf("\n  handleTrusted", start);
  return src.slice(start, next === -1 ? undefined : next);
}


function whenReadyBody(src: string): string {
  const start = src.indexOf("app.whenReady()");
  expect(start, "源码里找不到 app.whenReady()").toBeGreaterThan(-1);
  const end = src.indexOf(".catch((e) => { console.error(\"[gui:main] 启动失败", start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("A-1043 ①：singleFlight 语义（纯逻辑）", () => {
  it("并发调用只真正执行一次，且拿到同一个结果", async () => {
    let runs = 0;
    const fly = singleFlight(async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 5));
      return "ok";
    });
    const [a, b, c] = await Promise.all([fly(), fly(), fly()]);
    expect(runs).toBe(1);
    expect([a, b, c]).toEqual(["ok", "ok", "ok"]);
  });

  it("成功后调用方共享**同一个** in-flight Promise（不是各造一个）", () => {
    const fly = singleFlight(() => new Promise<number>((r) => setTimeout(() => r(7), 5)));
    const p1 = fly();
    const p2 = fly();
    expect(p1).toBe(p2);
  });

  it("成功**之后**的调用直接复用结果，不再重跑", async () => {
    let runs = 0;
    const fly = singleFlight(async () => { runs += 1; return runs; });
    expect(await fly()).toBe(1);
    expect(await fly()).toBe(1);
    expect(await fly()).toBe(1);
    expect(runs).toBe(1);
  });

  it("失败**不缓存** —— 下一次调用必须能重试（否则一次瞬时失败会永久废掉功能）", async () => {
    let runs = 0;
    const fly = singleFlight(async () => {
      runs += 1;
      if (runs === 1) { throw new Error("第一次失败"); }
      return "第二次成功";
    });
    await expect(fly()).rejects.toThrow("第一次失败");
    expect(await fly()).toBe("第二次成功");
    expect(runs).toBe(2);
  });

  it("失败后并发重试：新一轮仍然单飞（第二次只跑一遍）", async () => {
    let runs = 0;
    const fly = singleFlight(async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 5));
      if (runs === 1) { throw new Error("boom"); }
      return runs;
    });
    await expect(Promise.all([fly(), fly()])).rejects.toThrow("boom");
    const [a, b] = await Promise.all([fly(), fly()]);
    expect([a, b]).toEqual([2, 2]);
    expect(runs).toBe(2);
  });

  it("两个实例互不影响（不同初始化不许共用一份状态）", async () => {
    let a = 0, b = 0;
    const fa = singleFlight(async () => { a += 1; return "a"; });
    const fb = singleFlight(async () => { b += 1; return "b"; });
    expect(await Promise.all([fa(), fb()])).toEqual(["a", "b"]);
    expect([a, b]).toEqual([1, 1]);
  });
});

describe("A-1043 ②：重初始化单飞（源码层）", () => {
  const src = code(MAIN);

  it("`ensureServices()` 只是 `ensureServicesOnce` 的薄包装（原 40 处调用点语义不变）", () => {
    const m = src.match(/async function ensureServices\(\): Promise<void> \{([\s\S]*?)\n\}/);
    expect(m, "找不到 ensureServices 定义").toBeTruthy();
    const body = m![1];
    
    expect(body.replace(/\s/g, "")).toBe("awaitensureServicesOnce();");
  });

  it("重活整条链住在 `singleFlight<void>(` 里（并发调用共享一份初始化）", () => {
    expect(src).toMatch(/const ensureServicesOnce = singleFlight<void>\(async \(\) => \{/);
    
    const seg = src.slice(
      src.indexOf("const ensureServicesOnce = singleFlight<void>"),
      src.indexOf("async function ensureServices(): Promise<void>"),
    );
    for (const marker of ["await SilamBrainClient.start", "new ChatService(", "scheduler.start()", "new StatsService("]) {
      expect(seg, `单飞区间内缺少 ${marker} —— 包错了范围`).toContain(marker);
    }
  });

  it("AgentRegistry 单独单飞，且重初始化**先**等它（首屏与重活共用同一份注册表）", () => {
    expect(src).toMatch(/const ensureRegistryOnce = singleFlight<AgentRegistry>\(async \(\) => \{/);
    const seg = src.slice(
      src.indexOf("const ensureServicesOnce = singleFlight<void>"),
      src.indexOf("a2aBus = new ServerA2ABus()"),
    );
    expect(seg).toContain("await ensureRegistry();");
  });

  it("⚠️ 不许再在链内 `new AgentRegistry()` 自建一份（那就绕过单飞、两份注册表打架）", () => {
    const seg = src.slice(
      src.indexOf("const ensureServicesOnce = singleFlight<void>"),
      src.indexOf("async function ensureServices(): Promise<void>"),
    );
    expect(seg).not.toContain("new AgentRegistry()");
    
    expect(src).toContain("const reg = new AgentRegistry();");
  });
});

describe("A-1043 ③：首屏只读 handler 不许等重初始化", () => {
  const src = code(MAIN);

  for (const channel of ["slime:sessions:list", "slime:agents:list"]) {
    it(`${channel}：只 await ensureRegistry()，不得 await ensureServices()`, () => {
      const body = handlerBody(src, channel);
      expect(body).toContain("await ensureRegistry();");
      expect(body).not.toContain("ensureServices()");
    });
  }

  it("首屏 handler 不再对 agentRegistry 用非空断言（`!` 会变成同步 TypeError → 空列表）", () => {
    for (const channel of ["slime:sessions:list", "slime:agents:list"]) {
      const body = handlerBody(src, channel);
      expect(body, `${channel} 仍在用 agentRegistry! 非空断言`).not.toContain("agentRegistry!");
      expect(body, `${channel} 缺少 ?? [] 兜底`).toContain("?? []");
    }
  });

  it("数量守恒：重活入口仍有大量调用点（禁「顺手全删」把功能一起删掉）", () => {
    const calls = src.match(/await ensureServices\(\);/g) ?? [];
    
    expect(calls.length).toBeGreaterThanOrEqual(30);
    
    expect(handlerBody(src, "slime:sessions:list")).not.toContain("await ensureServices()");
    expect(handlerBody(src, "slime:agents:list")).not.toContain("await ensureServices()");
  });
});

describe("A-1043 ④：启动期必须后台预热重初始化", () => {
  const src = code(MAIN);

  it("app.whenReady() 里必须 `void ensureServices()`（否则重活只在首次对话时才发生）", () => {
    const boot = whenReadyBody(src);
    expect(boot).toContain("void ensureServices()");
    
    expect(boot).not.toMatch(/await ensureServices\(\)/);
  });

  it("预热必须吞掉错误（初始化失败不能把启动 promise 打挂 → process.exit(1)）", () => {
    const boot = whenReadyBody(src);
    expect(boot).toMatch(/void ensureServices\(\)\.catch\(/);
  });

  it("预热发生在 loadURL **之前**（否则首屏先到、预热白做）", () => {
    const boot = whenReadyBody(src);
    const warm = boot.indexOf("void ensureServices()");
    const load = boot.indexOf("loadURL(");
    expect(warm).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(warm);
  });
});
