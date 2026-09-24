/**
 * tests/core-ts/a1091-rpm.spec.ts — A-1091：上游 RPM 限流器 + 网络硬规则不再拦本地地址。
 *
 * ## 这一轮修的两件事（都有"下一个人会踩回去、而且全都不报错"的退化形态）
 *
 * ① **上游 RPM 限额没有任何客户端执行者**。Agnes 官方 2026-09-23 把免费档 RPM 从 20 下调到 10，
 *    而应用侧毫无感知 —— 用户只会看到零星的 429 / 中间断流，**不会想到是自己把限额用超了**。
 *    更糟的是设置里那个「并发上限」**全仓没有读取者**（死开关）：用户把它调低以为能避限流，
 *    实际毫无作用。现在：RPM 判据成为**被执行的**逻辑（滑动窗口 + 排队等待），
 *    声明档位落在能力表（单一出处），实测档位从响应头自动学习。
 *
 * ② **内置浏览器被自家硬规则拦死**：`assessAction` 的 network 分支把「非 HTTPS / 127.0.0.1 /
 *    内网」一律 `block`，于是 `browser_navigate` 打不开用户自己的本地服务 ——
 *    而本应用**自己的** `http_create_app` 生成单页应用后就是靠内置浏览器打开
 *    `http://127.0.0.1:<port>` 预览的。实测事故：Agent 如实回报
 *    「内置浏览器的硬规则不允许访问本地回环地址，不是我操作失误」，用户侧看起来就是"浏览器坏了"。
 */
import { describe, it, expect } from "vitest";
import {
  RpmLimiter,
  resolveRpm,
  parseRateLimitHeaders,
  rpmFromHeaders,
  planAcquire,
  RPM_WINDOW_MS,
  DEFAULT_429_COOLDOWN_S,
  type LimiterClock,
} from "../../core-ts/src/llm/rpmLimiter.js";
import { assessAction } from "../../core-ts/src/tools/classifier.js";
import { hardRuleCheck } from "../../core-ts/src/tools/hard_rules.js";

/** 可控时钟：now 手动推进，sleep 只记录不真等（限流判据必须能在毫秒内断言） */
function fakeClock(): LimiterClock & { advance: (ms: number) => void; sleeps: number[] } {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => { sleeps.push(ms); t += ms; return Promise.resolve(); },
    advance: (ms: number) => { t += ms; },
    sleeps,
  };
}

/* ───────────────────────── A 组：三层取值 ───────────────────────── */

describe("A-1091 A 组 — 额度取值：实测 > 声明 > 未知（不发明阈值）", () => {
  it("A1 实测优先于声明（付费档实测 20 > 免费档声明 10 —— 绝不能取小）", () => {
    expect(resolveRpm(20, 10)).toEqual({ rpm: 20, source: "observed" });
  });

  it("A2 无实测 → 用声明档位", () => {
    expect(resolveRpm(null, 10)).toEqual({ rpm: 10, source: "declared" });
    expect(resolveRpm(undefined, 10)).toEqual({ rpm: 10, source: "declared" });
  });

  it("A3 两者都没有 ⇒ **未知**（rpm=null ⇒ 放行，不猜一个数去卡人）", () => {
    expect(resolveRpm(null, null)).toEqual({ rpm: null, source: "unknown" });
  });

  it("A4 坏配置（0 / 负数 / NaN）视为**未知**而不是「不能发」（坏配置的降级方向必须是「能用」）", () => {
    expect(resolveRpm(0, 0).source).toBe("unknown");
    expect(resolveRpm(-5, -5).source).toBe("unknown");
    expect(resolveRpm(Number.NaN, Number.NaN).source).toBe("unknown");
  });

  it("A5 能力表的 Agnes 声明档位 = 10（官方 2026-09-23 下调后的免费档）", () => {
    const l = new RpmLimiter();
    expect(l.resolve("agnes", "agnes-3.0-flash")).toEqual({ rpm: 10, source: "declared" });
  });

  it("A6 能力表未登记的模型 ⇒ 未知（放行）", () => {
    const l = new RpmLimiter();
    expect(l.resolve("someone", "totally-unknown-model-xyz").source).toBe("unknown");
  });
});

/* ───────────────────────── B 组：响应头解析 ───────────────────────── */

describe("A-1091 B 组 — 上游限流响应头解析（多厂商字段名归一）", () => {
  const h = (map: Record<string, string>) => (n: string) => map[n.toLowerCase()];

  it("B1 OpenAI 风格 x-ratelimit-limit-requests 直接可用", () => {
    expect(rpmFromHeaders(parseRateLimitHeaders(h({ "x-ratelimit-limit-requests": "10" })))).toBe(10);
  });

  it("B2 IETF 草稿头 ratelimit-limit 带 ;w=60 可用", () => {
    const parsed = parseRateLimitHeaders(h({ "ratelimit-limit": "10;w=60" }));
    expect(parsed.limitRequests).toBe(10);
    expect(parsed.windowS).toBe(60);
    expect(rpmFromHeaders(parsed)).toBe(10);
  });

  it("B3 ⚠️ 窗口不是 60s 的额度**必须丢弃**（w=1 的「每秒 10 次」当 RPM 用会放大 60 倍）", () => {
    const parsed = parseRateLimitHeaders(h({ "ratelimit-limit": "10;w=1" }));
    expect(parsed.windowS).toBe(1);
    expect(rpmFromHeaders(parsed)).toBeUndefined();
  });

  it("B4 retry-after 支持秒数与 HTTP-date 两种形态", () => {
    expect(parseRateLimitHeaders(h({ "retry-after": "12" })).retryAfterS).toBe(12);
    const now = Date.parse("2026-09-24T10:00:00Z");
    const httpDate = new Date(now + 7_000).toUTCString();
    const parsed = parseRateLimitHeaders(h({ "retry-after": httpDate }), now);
    expect(parsed.retryAfterS).toBeGreaterThanOrEqual(6);
    expect(parsed.retryAfterS).toBeLessThanOrEqual(7);
  });

  it("B5 没有任何限流头 ⇒ 空对象（不编造）", () => {
    const parsed = parseRateLimitHeaders(h({}));
    expect(parsed.limitRequests).toBeUndefined();
    expect(parsed.retryAfterS).toBeUndefined();
  });
});

/* ───────────────────────── C 组：滑动窗口判据 ───────────────────────── */

describe("A-1091 C 组 — 滑动窗口取令牌（纯判据）", () => {
  it("C1 额度没用完 ⇒ 不等待，并把本次计入窗口", () => {
    const p = planAcquire(1_000, [1_000, 1_001], 10);
    expect(p.waitMs).toBe(0);
    expect(p.keep).toEqual([1_000, 1_001, 1_000]);
  });

  it("C2 额度用完 ⇒ 等到**最早那次**滑出窗口（不是固定分桶，杜绝桶边界 2×rpm）", () => {
    const hits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // 10 次 = 额度 10
    const p = planAcquire(10_000, hits, 10);
    // 最早那次在 0，窗口到 60_000 + EPSILON 才滑出
    expect(p.waitMs).toBe(60_000 + 250 - 10_000);
  });

  it("C3 窗口外的旧记录不占用额度", () => {
    const hits = [0, 1, 2];
    const now = RPM_WINDOW_MS + 3; // 最晚的 2 也已滑出（now-2 = 60001 ≥ 60000）
    const p = planAcquire(now, hits, 3);
    expect(p.waitMs).toBe(0);
    expect(p.keep).toEqual([now]);
  });

  it("C3b 边界：**差 1ms 就还在窗口内**的记录仍占额度（判据是 `< window` 而不是 `<=`）", () => {
    const now = RPM_WINDOW_MS + 1; // now-2 = 59999 < 60000 ⇒ 仍在窗口
    const p = planAcquire(now, [0, 1, 2], 3);
    expect(p.keep).toEqual([2, now]);
  });

  it("C4 未知额度（非有限 / 0）⇒ 直接放行", () => {
    expect(planAcquire(100, [1, 2, 3], Number.NaN).waitMs).toBe(0);
    expect(planAcquire(100, [1, 2, 3], 0).waitMs).toBe(0);
  });
});

/* ───────────────────────── D 组：限流器（排队而非丢弃） ───────────────────────── */

describe("A-1091 D 组 — RpmLimiter：额度用满要**排队等待**，绝不静默丢请求", () => {
  it("D1 声明的 10 RPM 下，第 11 次请求会等到窗口滑动（不是抛错、不是丢弃）", async () => {
    const clock = fakeClock();
    const l = new RpmLimiter({ clock, declaredOf: () => 10 });
    for (let i = 0; i < 10; i++) {
      const r = await l.acquire("k", "m");
      expect(r.waitedMs).toBe(0);
    }
    const eleventh = await l.acquire("k", "m");
    expect(eleventh.waitedMs).toBeGreaterThan(0);
    expect(eleventh.source).toBe("declared");
  });

  it("D2 未知额度 ⇒ 永不等待（放行）", async () => {
    const clock = fakeClock();
    const l = new RpmLimiter({ clock, declaredOf: () => null });
    for (let i = 0; i < 100; i++) {
      const r = await l.acquire("k", "m");
      expect(r.waitedMs).toBe(0);
    }
    expect(clock.sleeps).toEqual([]);
  });

  it("D3 按 key 分桶：一个供应商用满不影响另一个", async () => {
    const clock = fakeClock();
    const l = new RpmLimiter({ clock, declaredOf: () => 1 });
    await l.acquire("a", "m");
    const other = await l.acquire("b", "m");
    expect(other.waitedMs).toBe(0);
  });

  it("D4 实测额度覆盖声明额度（响应头说 50 ⇒ 立刻按 50 放行）", async () => {
    const clock = fakeClock();
    const l = new RpmLimiter({ clock, declaredOf: () => 1 });
    l.observe("k", { limitRequests: 50 }, 200);
    expect(l.resolve("k", "m")).toEqual({ rpm: 50, source: "observed" });
    const r = await l.acquire("k", "m");
    expect(r.waitedMs).toBe(0);
    expect(r.source).toBe("observed");
  });

  it("D5 429 触发冷却：即使额度看起来还有，也要等上游要求的 Retry-After", async () => {
    const clock = fakeClock();
    const l = new RpmLimiter({ clock, declaredOf: () => 100 });
    l.observe("k", { retryAfterS: 7 }, 429);
    const r = await l.acquire("k", "m");
    expect(r.waitedMs).toBeGreaterThanOrEqual(7_000);
  });

  it("D6 429 没给 Retry-After ⇒ 用默认冷却（保守取值，不是 0）", async () => {
    const clock = fakeClock();
    const l = new RpmLimiter({ clock, declaredOf: () => 100 });
    l.observe("k", {}, 429);
    const r = await l.acquire("k", "m");
    expect(r.waitedMs).toBe(DEFAULT_429_COOLDOWN_S * 1000);
  });

  it("D7 并发的多个 429 **不许互相缩短**冷却（取较晚者）", () => {
    const clock = fakeClock();
    const l = new RpmLimiter({ clock, declaredOf: () => 100 });
    l.observe("k", { retryAfterS: 30 }, 429);
    l.observe("k", { retryAfterS: 1 }, 429);
    expect(l.snapshot()[0].cooling).toBe(true);
    clock.advance(2_000);
    expect(l.snapshot()[0].cooling).toBe(true); // 若被缩短到 1s，这里已经不再 cooling
  });
});

/* ───────────────────────── E 组：网络硬规则不再拦本地地址 ───────────────────────── */

describe("A-1091 E 组 — 内置浏览器可以打开本地服务（这条曾经把自己的功能拦死）", () => {
  it("E1 【事故本体】browser_navigate 打开 http://127.0.0.1:8800 **不再被硬规则拒绝**", () => {
    const v = hardRuleCheck({ name: "browser_navigate", riskKind: "network", target: "http://127.0.0.1:8800" });
    expect(v.blocked).toBe(false);
  });

  it("E2 localhost / 局域网 / 纯 http 同样不再硬拦（降级为需确认）", () => {
    for (const u of ["http://localhost:3000", "http://192.168.1.10/admin", "http://example.com"]) {
      expect(assessAction({ kind: "network", url: u }).level).toBe("confirm");
      expect(hardRuleCheck({ name: "web_fetch", riskKind: "network", target: u }).blocked).toBe(false);
    }
  });

  it("E3 ⚠️ 云元数据仍然 **block**（真正的凭证窃取面，且正常用户永远不会访问它）", () => {
    for (const u of ["http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/computeMetadata/v1/"]) {
      expect(assessAction({ kind: "network", url: u }).level).toBe("block");
      expect(hardRuleCheck({ name: "browser_navigate", riskKind: "network", target: u }).blocked).toBe(true);
    }
  });

  it("E4 https 仍然 auto（未被本次改动波及）", () => {
    expect(assessAction({ kind: "network", url: "https://example.com" })).toMatchObject({ level: "auto", matched: "https" });
  });

  it("E5 ⚠️ 终端那条路**不受影响**：curl 私网地址仍然 block（SSRF 边界留在它该在的地方）", () => {
    const r = assessAction({ kind: "terminal", command: "curl", commandArgs: "http://127.0.0.1:8800/admin" });
    expect(r.level).toBe("block");
  });
});
