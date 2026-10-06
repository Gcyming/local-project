import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { detectApiFormat, probeProvider } from "../../gui/src/main/providers.js";
import { productUserAgent } from "../../core-ts/src/product.js";

/**
 * A-1195（交接欠账 B6）：供应商探测请求必须报同一身份。
 *
 * 病根：`tryFetchModels` / `detectApiFormat` / `probeProvider` 等 5 处探测请求只带鉴权头、
 * 不带 User-Agent —— 与模型请求（`slime/<version>`）指纹不一致。「模型侧叫 slime、
 * 探测侧匿名」正是风控视角的「身份存疑」信号（用户被封过号，交接文档列为待修）。
 * 修法：统一走 `identityHeaders()`（http-identity 单一产地）。
 *
 * 判据：探测函数打出的每个请求，echo 端收到的 user-agent === productUserAgent()。
 */
const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

let server: Server | null = null;
let base = "";
let seen: Array<{ url: string | undefined; ua: string | string[] | undefined; auth: string | string[] | undefined }> = [];

beforeEach(async () => {
  seen = [];
  server = createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers["user-agent"], auth: req.headers["authorization"] });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "m1" }] }));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  server = null;
});

describe("A-1195 B6：探测请求带统一身份 UA", () => {
  it("detectApiFormat 的探测请求带 slime 身份（与模型请求同值）", async () => {
    const fmt = await detectApiFormat(base, "sk-test");
    expect(fmt).toBe("openai");
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.ua, `探测 ${s.url} 没带身份 UA`).toBe(productUserAgent());
    }
    // 顺带确认鉴权头没被 identityHeaders 换掉
    expect(seen[0].auth).toBe("Bearer sk-test");
  });

  it("probeProvider 的两类探测（模型列表 + pricing）都带身份", async () => {
    await probeProvider(base, "sk-test");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) {
      expect(s.ua, `探测 ${s.url} 没带身份 UA`).toBe(productUserAgent());
    }
  });

  it("接线形状：5 处探测请求都过 identityHeaders（防回退）", () => {
    const src = read("gui/src/main/providers.ts");
    const hits = src.match(/headers: identityHeaders\(/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(src).toMatch(/import \{ identityHeaders \} from "\.\.\/\.\.\/\.\.\/core-ts\/src\/http-identity\.js"/);
  });
});
