/**
 * A-1043 守卫：**启动后左栏会话列表空白** + 初始化并发重入。
 *
 * **用户原话**：「每次重新启动后，slime 内的历史会话都要相当一段时间加载，每次进去第一时间
 * 左侧边栏的会话列表都是空白的，什么都没有，跟刚下载一样。」
 *
 * 根因（探针 `gui/scripts/probe-sessions-boot.cjs` 实证，同一次启动）：
 *   ① `ensureServices()` **没有在飞去重**，且 `chatService` 只在链尾赋值 →
 *      启动瞬间 agents/sessions/providers/localModels 四个首屏 list 一起打进来 =
 *      整条初始化链（SILAM python sidecar / engine / sandbox / ChatService / 调度器）**并发跑两遍**
 *      （日志实证：`core-ts 服务已加载` ×2、`Attempted to register a second handler` ×2、
 *      `EADDRINUSE 127.0.0.1:19011` ×2、skills-ready ×2）。
 *   ② `slime:sessions:list` 与 `slime:agents:list` 是**纯读**操作，却都 `await ensureServices()` →
 *      被整条重初始化挡住。渲染层 8s 的 `firstLoadGuard` 先放行 UI → 用户看到空列表。
 *
 * 本守卫分两层：
 *   A. 纯逻辑直测 `singleFlight`（`gui/src/main/singleFlight.ts`，判据的唯一实现）；
 *   B. 位置驱动扫源码：断言"首屏只读 handler 不许等重初始化"、"重初始化必须单飞"、"启动期必须预热"。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { singleFlight } from "../../gui/src/main/singleFlight.js";

const ROOT = join(__dirname, "../..");
const MAIN = "gui/src/main/index.ts";

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再扫 —— 否则注释里提到的写法会把断言喂饱（本仓反复踩过）。 */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * 取某个 `handleTrusted` handler 的函数体（位置驱动：从它的注册点切到**下一个** handler 注册点）。
 * 不许用 `indexOf("ensureServices")` 之类的全仓搜索 —— 那样"别处有没有"与"这里有没有"分不开。
 */
function handlerBody(src: string, channel: string): string {
  const start = src.indexOf(`"${channel}"`);
  expect(start, `源码里找不到 handler ${channel}`).toBeGreaterThan(-1);
  const next = src.indexOf("\n  handleTrusted", start);
  return src.slice(start, next === -1 ? undefined : next);
}

/** `app.whenReady()` 到 `loadURL` 之间的启动段（预热必须落在这里）。 */
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
    // ⚠️ 薄包装必须**只**做转发：一旦这里恢复成重活，等于单飞被绕过（回到"并发跑两遍"）。
    expect(body.replace(/\s/g, "")).toBe("awaitensureServicesOnce();");
  });

  it("重活整条链住在 `singleFlight<void>(` 里（并发调用共享一份初始化）", () => {
    expect(src).toMatch(/const ensureServicesOnce = singleFlight<void>\(async \(\) => \{/);
    // 链内必须还包含那几个"注定会撞车"的副作用，证明被包住的确实是我们以为的那条链
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
    // 但轻量路径里必须有它（否则注册表永远不会被加载）
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
    // 首屏两个只读 handler 迁走后仍应有 ≥ 30 处（改前 40 处）
    expect(calls.length).toBeGreaterThanOrEqual(30);
    // 会话/Agent 列表两处是**具名豁免**
    expect(handlerBody(src, "slime:sessions:list")).not.toContain("await ensureServices()");
    expect(handlerBody(src, "slime:agents:list")).not.toContain("await ensureServices()");
  });
});

describe("A-1043 ④：启动期必须后台预热重初始化", () => {
  const src = code(MAIN);

  it("app.whenReady() 里必须 `void ensureServices()`（否则重活只在首次对话时才发生）", () => {
    const boot = whenReadyBody(src);
    expect(boot).toContain("void ensureServices()");
    // 必须是 fire-and-forget：用 await 会把首屏重新拖回原病灶
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
