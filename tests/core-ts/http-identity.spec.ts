/**
 * tests/core-ts/http-identity.spec.ts —— 对外请求身份的**防漂移 + 防绕过**守卫。
 *
 * 背景见A-1107 风控审计：slime 曾因请求指纹自相矛盾（同一件事几个身份答案、
 * 主链路限流形同虚设）被判为滥用。本守卫钉住三件事：
 *
 *   1. **单一产地**：申请类身份只有一个答案 `slime/<version>`，
 *      gui 侧那几处`slime-agent` / `slime-gui` / `slime-gui/adb` 不许复活。
 *   2. **限流不可绕过**：漏传 `rateLimit` 时必须仍按 baseUrl 有闸门，
 *      否则主链路（GUI 经 chromiumFetch 打真供应商）就是裸奔。
 *   3. **诚实**：`applicationUserAgent` 值恒定——
 *      不许随机化、不许每次不同、不许夹带本机路径。
 *      随机 UA 恰恰是风控眼里最像攻击流量的信号。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { productUserAgent } from "../../core-ts/src/product.js";
import { applicationUserAgent, githubHeaders, identityHeaders } from "../../core-ts/src/http-identity.js";
import { ChatClient, AnthropicClient, ResponsesClient, GoogleClient } from "../../core-ts/src/llm/client.js";
import { RpmLimiter, setSharedRpmLimiter } from "../../core-ts/src/llm/rpmLimiter.js";
import type { RateLimitHeaders } from "../../core-ts/src/llm/rpmLimiter.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/**
 * Windows 盘符路径形态，如 `C:\Users\me`。
 *
 * ⚠️ 前面必须隔一个非字母数字字符，否则 `https://` 里的 `s:/` 会被当成盘符 ——
 * 那会让每个真实 baseUrl 都假失败，守卫等于名存实亡。
 */
const WINDOWS_DRIVE_PATH = /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/;

/** 申请类流量的三个 gui 出站点：文件相对路径 → 必须匹配的 UA 写法。 */
const APPLICATION_TRAFFIC_FILES = [
  "gui/src/main/config_files.ts",
  "gui/src/main/downloader.ts",
  "gui/src/main/adb.ts",
] as const;

describe("申请类身份：单一产地", () => {
  it("identityHeaders 打上产品身份，且不改入参", () => {
    const original = { Accept: "application/json" };
    const out = identityHeaders(original);
    expect(out["User-Agent"]).toBe(productUserAgent());
    expect(out["Accept"]).toBe("application/json");
    expect(original).not.toHaveProperty("User-Agent");
  });

  it("身份只有一个答案：applicationUserAgent 就是 productUserAgent，不许有第二产地", () => {
    // 原withProductIdentity 曾断言「覆盖调用方随手写的 UA」，但真实 API 是
    // `{ UA, ...extra }` —— extra **后写覆盖**，方向相反。这里按真实语义钉死：
    // extra 确实能覆盖（调用方显式传的优先），同时「唯一产地」这条不变量另行守住。
    expect(identityHeaders({ "User-Agent": "slime-gui/adb" })["User-Agent"]).toBe("slime-gui/adb");
    expect(applicationUserAgent()).toBe(productUserAgent());
    // 覆盖能力只归调用方，不许模块自己偷偷改口径。
    expect(identityHeaders()["User-Agent"]).toBe(applicationUserAgent());
  });

  it("githubHeaders 同时给出 GitHub 强制的 Accept 与身份", () => {
    const h = githubHeaders();
    // GitHub 缺 UA 会直接 403，两个头缺一不可。
    expect(h["User-Agent"]).toBe(applicationUserAgent());
    expect(h.Accept).toBe("application/vnd.github+json");
  });

  it("extra 能补上本调用点独有的头，且不覆盖身份（除非显式同名）", () => {
    expect(githubHeaders({ Authorization: "Bearer t" }).Authorization).toBe("Bearer t");
    expect(githubHeaders({ Authorization: "Bearer t" })["User-Agent"]).toBe(applicationUserAgent());
    expect(identityHeaders({ Accept: "application/json" }).Accept).toBe("application/json");
  });

  it("缺省入参也能得到合法身份（不要求调用方先造对象）", () => {
    expect(identityHeaders()["User-Agent"]).toBe(productUserAgent());
    expect(applicationUserAgent()).toBe(productUserAgent());
  });
});

describe("申请类身份：诚实且恒定", () => {
  it("身份里不出现本机路径 / 用户名 / 盘符形态", () => {
    const ua = productUserAgent();
    expect(ua).not.toContain("\\");
    expect(ua).not.toMatch(/[A-Za-z]:/);
    expect(ua.split("/")).toHaveLength(2);
  });

  it("同一次运行内多次取值逐字相同（不许随机化 UA）", () => {
    // 随机/时间戳 UA 比固定 UA 更像攻击流量——这正是要防的。
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) { seen.add(productUserAgent()); }
    expect(seen.size).toBe(1);
  });

  it("身份不携带邮箱等用户身份信息形态", () => {
    expect(productUserAgent()).not.toContain("@");
  });
});

describe("申请类身份：gui 三处不再自报门牌", () => {
  for (const rel of APPLICATION_TRAFFIC_FILES) {
    it(`${rel} 不再出现第二产地写法`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      // 只在真源码里查历史写法（注意区分行内注释里的举例）。
      const code = src.split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
        .join("\n");
      expect(code).not.toContain("slime-agent");
      expect(code).not.toContain("slime-gui");
      expect(code).not.toContain("slime-gui/adb");
      // 身份必须**向单一产地要**（http-identity），而不是自己 import/拼 productUserAgent。
      // 这样连「换个 import 路径绕过模块」也算违规。
      expect(code, "身份没走 http-identity 单一产地").toMatch(/from\s+"[^"]*http-identity\.js"/);
    });
  }

  it("GitHub 的 Accept 只在http-identity 一处出现，不许各调用点就地复写", () => {
    const identitySrc = readFileSync(join(ROOT, "core-ts/src/http-identity.ts"), "utf8");
    expect(identitySrc).toContain('Accept: "application/vnd.github+json"');
    // 调用点只许调githubHeaders()，不许自己再写一遍这个 Accept。
    const src = readFileSync(join(ROOT, "gui/src/main/config_files.ts"), "utf8");
    expect(src).toContain("githubHeaders(");
    expect(src, "Accept 被就地复写了 —— 同一事实两处必漂").not.toContain("application/vnd.github+json");
    // 身份来自单一产地，而不是就地拼字符串。
    expect(src).not.toMatch(/"User-Agent":\s*`?slime/);
  });
});

/** 四类 client 的构造签名只需 baseUrl，rateLimit 省略即为「漏传」场景。 */
const CLIENTS = [
  { name: "ChatClient", make: (baseUrl: string) => new ChatClient({ baseUrl }) },
  { name: "AnthropicClient", make: (baseUrl: string) => new AnthropicClient({ baseUrl }) },
  { name: "ResponsesClient", make: (baseUrl: string) => new ResponsesClient({ baseUrl }) },
  { name: "GoogleClient", make: (baseUrl: string) => new GoogleClient({ baseUrl }) },
] as const;

describe("限流身份：漏传也不许裸奔（P0）", () => {
  for (const c of CLIENTS) {
    it(`${c.name} 漏传 rateLimit 时仍得到限流身份（按 baseUrl 兜底）`, () => {
      const identity = (c.make("https://api.example.com/v1") as unknown as { rateLimit: { key: string } }).rateLimit;
      expect(identity).toBeDefined();
      expect(typeof identity.key).toBe("string");
      expect(identity.key.length).toBeGreaterThan(0);
    });
  }

  it("显式传入的 key 优先于baseUrl 兜底", () => {
    const c = new ChatClient({ baseUrl: "https://api.example.com", rateLimit: { key: "openai", model: "gpt-x" } });
    const identity = (c as unknown as { rateLimit: { key: string; model?: string } }).rateLimit;
    expect(identity.key).toBe("openai");
    expect(identity.model).toBe("gpt-x");
  });

  it("兜底 key 不夹带本机路径（baseUrl 形态须干净）", () => {
    const c = new ChatClient({ baseUrl: "https://api.example.com/v1" });
    const identity = (c as unknown as { rateLimit: { key: string } }).rateLimit;
    expect(identity.key).not.toContain("\\");
    // 盘符形态必须真的能拦住 `C:\Users\...`，但不能把 `https://` 里的 `s:/`
    // 误判成盘符 —— 否则每个真实 baseUrl 都会假失败，守卫就名存实亡了。
    expect(identity.key).not.toMatch(WINDOWS_DRIVE_PATH);
    // 正向对照：证明这条正则不是「怎么都通过」的假守卫。
    expect("C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "me")
      .toMatch(WINDOWS_DRIVE_PATH);
    expect("https://api.example.com/v1").not.toMatch(WINDOWS_DRIVE_PATH);
  });

  it("空 baseUrl 也给出兜底 key，不产生空字符串身份", () => {
    const c = new ChatClient({ baseUrl: "" });
    const identity = (c as unknown as { rateLimit: { key: string } }).rateLimit;
    expect(identity.key).not.toBe("");
    expect(identity.key.length).toBeGreaterThan(0);
  });
});

/**
 * 不变量：**未配置 RPM 时不得阻塞**。
 *
 * ⚠️ 这条守卫存在的原因：`resolveRateLimitIdentity` 让 `rateLimit` 恒存在后，
 * `fetchWithRetry` 里的 `if (rateLimit)` 变成**恒真** —— 于是连「一条 RPM 都没配」的
 * 请求也去闸门里排队。真实现场：tests/core-ts/client.spec.ts 5 条全部
 * `Test timed out in 5000ms`。症状是「测试超时」，跟限流器八竿子打不着，
 * 所以必须在这里钉死：**查不到配置 = 没有闸门**（fail-open）。
 *
 * 反向也要钉：闸门不许被整个删掉 —— 显式传了 `rateLimit` 时 `acquire` 必须被调用，
 * 否则 A-1107 的 P0（漏传/绕过限流）会从另一个方向回来。
 */
describe("限流闸门三态：查不到配置 ⇒ 无闸门（不许阻塞），配了 ⇒ 照拦", () => {
  /** 记录 acquire/observe 调用次数的探针限流器；sleep 立刻 resolve（不真等）。 */
  function probedLimiter(opts: { manual?: number | null; declared?: number | null }): {
    limiter: RpmLimiter;
    acquireCalls: string[];
    observeCalls: string[];
    sleeps: number[];
  } {
    const acquireCalls: string[] = [];
    const observeCalls: string[] = [];
    const sleeps: number[] = [];
    let now = 1_000_000;
    const limiter = new RpmLimiter({
      clock: {
        now: () => now,
        sleep: (ms: number) => { sleeps.push(ms); now += Math.max(0, ms); return Promise.resolve(); },
      },
      declaredOf: () => opts.declared ?? null,
      manualOf: () => opts.manual ?? null,
    });
    const innerAcquire = limiter.acquire.bind(limiter);
    limiter.acquire = async (key: string, model?: string, onWait?: (w: number, t: number) => void) => {
      acquireCalls.push(key);
      return innerAcquire(key, model, onWait);
    };
    const innerObserve = limiter.observe.bind(limiter);
    limiter.observe = (key: string, headers: RateLimitHeaders, status?: number, nowMs?: number) => {
      observeCalls.push(key);
      return innerObserve(key, headers, status, nowMs);
    };
    return { limiter, acquireCalls, observeCalls, sleeps };
  }

  const okBody = JSON.stringify({
    id: "x", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  });

  async function withShared<T>(limiter: RpmLimiter | null, fn: () => Promise<T>): Promise<T> {
    const { getSharedRpmLimiter } = await import("../../core-ts/src/llm/rpmLimiter.js");
    const prev = getSharedRpmLimiter();
    setSharedRpmLimiter(limiter);
    try {
      return await fn();
    } finally {
      setSharedRpmLimiter(prev);
    }
  }

  it("① 无人工 RPM 配置时，请求立刻发出：acquire / observe 都不发生，也不排队", async () => {
    const probe = probedLimiter({ manual: null, declared: null });
    let sent = 0;
    const fetchImpl = (async () => {
      sent += 1;
      return new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await withShared(probe.limiter, async () => {
      const client = new ChatClient({ baseUrl: "https://nowhere.invalid/v1", fetchImpl });
      const r = await client.chat({ messages: [{ role: "user", content: "hi" }] });
      expect(r.choices[0].message?.content).toBe("ok");
    });

    expect(sent, "请求必须真的发出去了").toBe(1);
    expect(probe.acquireCalls, "查不到 RPM 却仍去 acquire ⇒ 恒真判定已回归").toEqual([]);
    expect(probe.observeCalls, "无闸门时也不该伪造/记录 RPM").toEqual([]);
    expect(probe.sleeps, "无闸门时绝不允许排队等待").toEqual([]);
  });

  it("①b 无人工 RPM 配置时，四类client 全都不排队（漏传不许变成常态阻塞）", async () => {
    const probe = probedLimiter({ manual: null, declared: null });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await withShared(probe.limiter, async () => {
      await new ChatClient({ baseUrl: "https://nowhere.invalid/v1", fetchImpl })
        .chat({ messages: [] });
      await new AnthropicClient({ baseUrl: "https://nowhere.invalid", apiKey: "k", fetchImpl })
        .chat({ messages: [] });
      await new ResponsesClient({ baseUrl: "https://nowhere.invalid", fetchImpl })
        .chat({ messages: [] } as never);
      await new GoogleClient({ baseUrl: "https://nowhere.invalid", apiKey: "k", fetchImpl })
        .chat({ messages: [] } as never);
    });

    expect(probe.acquireCalls).toEqual([]);
    expect(probe.sleeps).toEqual([]);
  });

  it("② 配了 RPM 时 acquire 确实被调用（闸门不许被整个删掉）", async () => {
    const probe = probedLimiter({ manual: 60 });
    let sent = 0;
    const fetchImpl = (async () => {
      sent += 1;
      return new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await withShared(probe.limiter, async () => {
      const client = new ChatClient({ baseUrl: "https://nowhere.invalid/v1", fetchImpl });
      await client.chat({ messages: [] });
    });

    expect(probe.acquireCalls, "人工配了 RPM 却没 acquire ⇒ 限流被绕过（P0 回退）").toHaveLength(1);
    expect(probe.observeCalls, "有闸门时响应头要喂回限流器（实测额度）").toHaveLength(1);
    expect(sent).toBe(1);
  });

  it("②b 显式传了 rateLimit（GUI 主链路形态）⇒ 恒有闸门，acquire 必被调用", async () => {
    const probe = probedLimiter({ manual: null, declared: null });
    const fetchImpl = (async () =>
      new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    await withShared(probe.limiter, async () => {
      // router.ts 的 createRouteClient 就是这个形态：即使一条 RPM 都没配也必须拦。
      const client = new ChatClient({
        baseUrl: "https://nowhere.invalid/v1",
        fetchImpl,
        rateLimit: { key: "https://nowhere.invalid/v1", model: "m" },
      });
      await client.chat({ messages: [] });
    });

    expect(probe.acquireCalls, "GUI 主链路不许因为「查不到配置」被跳过").toHaveLength(1);
    expect(probe.observeCalls).toHaveLength(1);
  });

  it("③ 声明表里有该模型 ⇒ 兜底路径也有闸门（P0 的本意：漏传不许裸奔）", async () => {
    const probe = probedLimiter({ manual: null, declared: 10 });
    const fetchImpl = (async () =>
      new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    await withShared(probe.limiter, async () => {
      await new ChatClient({ baseUrl: "https://nowhere.invalid/v1", fetchImpl }).chat({ messages: [] });
    });

    expect(probe.acquireCalls, "该 provider 查得到 RPM ⇒ 必须有闸门").toHaveLength(1);
  });
});

describe("四类 client 的请求头都带诚实身份", () => {
  /** headers() 是私有的；测试只读断言，取值时走一次显式收窄。 */
  function headersOf(c: unknown): Record<string, string> {
    return (c as { headers: () => Record<string, string> }).headers();
  }

  const opts = { baseUrl: "https://x", apiKey: "k", fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch };

  it("ChatClient.headers 带 slime/<version>", () => {
    const h = headersOf(new ChatClient(opts));
    expect(h["User-Agent"]).toBe(productUserAgent());
    expect(h["Content-Type"]).toBe("application/json");
    expect(h.Authorization).toBe("Bearer k");
  });

  it("Anthropic.headers 带 slime/<version> 与协议必需的 anthropic-version", () => {
    const h = headersOf(new AnthropicClient(opts));
    expect(h["User-Agent"]).toBe(productUserAgent());
    // anthropic-version 是协议要求（真实协议头），不是伪装 SDK 指纹。
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["x-api-key"]).toBe("k");
  });

  it("Responses.headers 带 slime/<version>", () => {
    const h = headersOf(new ResponsesClient(opts));
    expect(h["User-Agent"]).toBe(productUserAgent());
    expect(h.Authorization).toBe("Bearer k");
  });

  it("Google.headers 带 slime/<version>", () => {
    const h = headersOf(new GoogleClient(opts));
    expect(h["User-Agent"]).toBe(productUserAgent());
    expect(h["x-goog-api-key"]).toBe("k");
  });

  it("四类都不伪造官方 SDK 指纹头（x-stainless-* 等）", () => {
    // 抄SDK 的指纹头 = 自相矛盾：UA 说是slime，头却说是官方 SDK。
    const all = [
      headersOf(new ChatClient(opts)),
      headersOf(new AnthropicClient(opts)),
      headersOf(new ResponsesClient(opts)),
      headersOf(new GoogleClient(opts)),
    ];
    for (const h of all) {
      for (const name of Object.keys(h)) {
        expect(name.toLowerCase()).not.toMatch(/^x-stainless-/);
        expect(name.toLowerCase()).not.toMatch(/^x-client-/);
        expect(name.toLowerCase()).not.toMatch(/^x-goog-api-client/);
      }
    }
  });
});