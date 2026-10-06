import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromiumFetch } from "../../gui/src/main/providers.js";

/**
 * A-1194 终止按钮响应性（P2）：chromiumFetch 的 abort 语义。
 *
 * 病根：abort 触发的 reject 被降级链当作「普通网络失败」——
 *   ① 重试循环里 sleep(250/600/1200) 后**再发一次**（每层最多 3 次）；
 *   ② 之后还可能改走系统代理路径（CONNECT 阶段 15s 超时完全不看 signal）；
 *   ③ 最后还有一次 global fetch。
 * 配合内层 3 次 × llm 层 4 次重试 = 最坏 12 次请求 ⇔「点了停止停不下来」+ 重复请求风控风险。
 * 修法：abort 一律短路（abortError / AbortError 命名），退避睡眠可中断。
 *
 * 判据：abort 后 <150ms settle 为 AbortError；预中断零请求零连接。
 * 未修复时：要等满退避（≈850ms~数秒）或还要发无效请求 → 判红。
 */

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

let server: Server | null = null;
let base = "";

beforeEach(async () => {
  server = createServer((req) => {
    // 立即断开：制造网络层 reject → 逼出 chromiumFetch 的重试退避路径
    req.socket.destroy();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  server = null;
});

const SETTLE_BUDGET_MS = 150;

describe("A-1194 P2：chromiumFetch abort 语义", () => {
  it("退避睡眠期间 abort → 立即 reject 为 AbortError（不等 250ms 退避）", async () => {
    const ac = new AbortController();
    // 首个请求到达后 80ms 触发 abort —— 此时已进入 250ms 退避睡眠
    server!.once("request", () => {
      setTimeout(() => ac.abort(), 80);
    });
    const p = chromiumFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
      signal: ac.signal,
    }).catch((e: unknown) => e);

    const t0 = Date.now();
    const err = await p;
    // 等 abort 时刻已记录：从 await 返回时刻反推
    expect((err as Error).name).toBe("AbortError");
    expect((err as Error).message).toContain("abort");
    // 修后：abort(80ms) → 立即 settle ≈ 81-100ms；
    // 变异（sleep 不可中断）：等满 250ms 退避 + 循环头检查 ≈ 255ms+ → 超预算判红。
    expect(Date.now() - t0).toBeLessThan(180);
  });

  it("signal 预先已 abort → 立即抛 AbortError，零连接", async () => {
    const ac = new AbortController();
    ac.abort();
    let conns = 0;
    server!.on("connection", () => { conns += 1; });
    const t0 = Date.now();
    const err = await chromiumFetch(`${base}/v1/models`, { signal: ac.signal }).catch((e: unknown) => e);
    const cost = Date.now() - t0;
    expect((err as Error).name).toBe("AbortError");
    // 快速失败由「循环头检查 + httpRequest 内 signal 立即 destroy + catch 检查」共同保证，
    // 任何一层单独被删仍被其它层兜住（等价变异）⇒ 下面用「防线数量」形状断言把冗余层钉住。
    expect(cost).toBeLessThan(SETTLE_BUDGET_MS);
    expect(conns).toBe(0);
  });

  it("接线形状：net.fetch 走 abort 赛跑；CONNECT 阶段挂了 abort 监听", () => {
    const src = read("gui/src/main/providers.ts");
    expect(src).toMatch(/raceWithAbort\(net\.fetch\(urlString, init\), signal\)/);
    expect(src).toMatch(/connectReqRef = connectReq/);
  });

  it("接线形状：abort 短路检查覆盖全链 ≥6 处（net 降级/循环头/catch/代理前后/最终 fetch）", () => {
    const src = read("gui/src/main/providers.ts");
    const hits = src.match(/if \(signal\?\.aborted\) \{ throw abortError\(\); \}/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(6);
  });
});
