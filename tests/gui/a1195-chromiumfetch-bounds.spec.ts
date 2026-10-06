import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromiumFetch } from "../../gui/src/main/providers.js";

/**
 * A-1195（交接欠账 B7）：chromiumFetch 的重试是**有界**的，且与外层退避不构成
 * 「无限放大等待」。交接疑点原文：「内层重试 ×3 ⇒ 最坏 12 次/逻辑调用（未改）」。
 *
 * 收尾结论（落档在 providers.ts 的常量注释）：两层退避处理的是**不同错误域**
 * （HTTP 状态 vs 连接层）、共享同一超时窗口 ⇒ 总时长有界。本守卫钉住两点：
 *   ① 网络层持续失败时，chromiumFetch 在有限时间内 settle（不无限重试）；
 *   ② 内层次数的**唯一产地**常量不许被大幅上调（调大 = 重审叠加分析 + 本守卫）。
 */
const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

let server: Server | null = null;
let base = "";

beforeEach(async () => {
  server = createServer((req) => {
    // 每个请求立即断开：逼出「连接层持续失败」的最坏路径
    req.socket.destroy();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  server = null;
});

describe("A-1195 B7：chromiumFetch 重试有界性", () => {
  it("网络层持续失败 → 有限时间内 settle（reject），不无限重试", async () => {
    const t0 = Date.now();
    const out = await chromiumFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
      .then(() => "resolved")
      .catch(() => "rejected");
    const cost = Date.now() - t0;

    expect(out).toBe("rejected");
    // 内层 3 次（250/600ms 退避）+ 可能的代理兜底快失败：给足余量仍远小于"无限"
    expect(cost, `settle 用时 ${cost}ms —— 重试失去边界`).toBeLessThan(10_000);
  });

  it("接线形状：内层次数唯一产地为 FETCH_RETRY_ATTEMPTS=3（调大=重审叠加分析）", () => {
    const src = read("gui/src/main/providers.ts");
    expect(src).toMatch(/const FETCH_RETRY_ATTEMPTS = 3;/);
  });
});
