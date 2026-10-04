



























import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";


const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn); } },
  app: { getPath: () => "" },
}));

import { buildGateway } from "../../gateway-ts/src/index.js";
import {
  SEARCH_INDEX_PORT,
  startSearchIndexService,
  stopSearchIndexService,
  __resetSearchIndexForTest,
} from "../../gui/src/main/searchIndexService.js";
import type { FetchPage } from "../../core-ts/src/websearch/crawler.js";


const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TOKEN = "gw-search-token";


const direct = async (port: number, path: string): Promise<{ status: number; json: unknown }> => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, json: await r.json() };
};

describe("A-1141 网关 /v1/search*（真起索引服务 + 真注入请求）", () => {
  let dir = "";
  let port = 0;
  let app: ReturnType<typeof buildGateway>;
  let noSearch: ReturnType<typeof buildGateway>;
  let deadSearch: ReturnType<typeof buildGateway>;

  const html = (title: string, text: string): string =>
    `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`;
  
  const fakeFetch = (body: Record<string, string>): FetchPage => async (url) => {
    if (url.endsWith("/robots.txt")) { return { ok: false, url, error: "no robots" }; }
    const h = body[url];
    return h === undefined ? { ok: false, url, error: "404" } : { ok: true, url, html: h };
  };

  const waitIdle = async (): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { crawling: boolean };
      if (!st.crawling) { return; }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("爬取没有在 5 秒内结束");
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "slime-gw-search-"));
    __resetSearchIndexForTest();
    const s = await startSearchIndexService({
      userData: dir,
      port: 0,
      fetchPage: fakeFetch({ "https://a.test/1": html("压缩技术", "压缩 算法 说明") }),
    });
    expect(s.ok).toBe(true);
    port = s.port!;

    

    app = buildGateway({
      port: 0, authToken: TOKEN, sidecarBaseUrl: "http://127.0.0.1:1",
      searchBaseUrl: `http://127.0.0.1:${port}`,
    });
    
    noSearch = buildGateway({ port: 0, authToken: TOKEN, sidecarBaseUrl: "http://127.0.0.1:1" });
    
    deadSearch = buildGateway({
      port: 0, authToken: TOKEN, sidecarBaseUrl: "http://127.0.0.1:1",
      searchBaseUrl: "http://127.0.0.1:1",
    });
    await app.ready(); await noSearch.ready(); await deadSearch.ready();

    const res = await fetch(`http://127.0.0.1:${port}/crawl`, {
      method: "POST", body: JSON.stringify({ seeds: ["https://a.test/1"], delay: 0.3 }),
    });
    expect(res.status).toBe(200);
    await waitIdle();
  });

  afterAll(async () => {
    await app.close(); await noSearch.close(); await deadSearch.close();
    await stopSearchIndexService();
    __resetSearchIndexForTest();
    try { rmSync(dir, { recursive: true, force: true }); } catch {  }
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

  it("⚠️ 三条端点都**要求认证**（检索能读到用户全部收录内容，不许裸奔）", async () => {
    const a = await app.inject({ method: "GET", url: "/v1/search?q=压缩" });
    expect(a.statusCode, "无 token 也能检索").toBe(401);
    const b = await app.inject({ method: "GET", url: "/v1/search/status" });
    expect(b.statusCode, "无 token 也能读索引状态").toBe(401);
    const c = await app.inject({ method: "POST", url: "/v1/search/crawl", payload: { seeds: ["https://a.test/1"] } });
    expect(c.statusCode, "无 token 也能让 slime 去爬外网").toBe(401);

    
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("⚠️ 检索回包与**直连索引服务**逐字一致（薄代理不许翻译字段）", async () => {
    const gw = await app.inject({ method: "GET", url: "/v1/search?q=压缩", headers: auth });
    expect(gw.statusCode).toBe(200);
    const g = JSON.parse(gw.body) as Record<string, unknown>;
    const d = (await direct(port, "/search?q=压缩")).json as Record<string, unknown>;

    expect(g.total, "网关这边把结果改了").toBe(d.total);
    expect(g.terms).toEqual(d.terms);
    expect(g.items).toEqual(d.items);
    expect(g.engine, "engine 名称也是一个产地（页面顶栏会显示）").toBe(d.engine);
    
    expect(Object.keys(g).sort()).toEqual(Object.keys(d).sort());
    expect({ ...g, took_ms: 0 }).toEqual({ ...d, took_ms: 0 });
  });

  it("查询串（分页 / size）**原样透传**，网关不自己解析、更不自己夹取", async () => {
    const gw = await app.inject({ method: "GET", url: "/v1/search?q=压缩&page=0&size=1", headers: auth });
    expect(gw.statusCode).toBe(200);
    const g = JSON.parse(gw.body) as { items: unknown[] };
    const d = (await direct(port, "/search?q=压缩&page=0&size=1")).json as { items: unknown[] };
    expect(g.items).toEqual(d.items);
    expect(g.items.length).toBeLessThanOrEqual(1);
  });

  it("`/v1/search/status` 与直连同一份事实（含当前生效参数）", async () => {
    const gw = await app.inject({ method: "GET", url: "/v1/search/status", headers: auth });
    expect(gw.statusCode).toBe(200);
    const g = JSON.parse(gw.body) as Record<string, unknown>;
    const d = (await direct(port, "/status")).json as Record<string, unknown>;
    expect(g).toEqual(d);
    expect(g.params, "状态里没有 params ⇒ 参数与检索不是同一份事实").toBeTruthy();
  });

  it("`/v1/search/crawl` 透传 body，**上游的失败状态码也照原样**（不许在这里改成 200）", async () => {
    

    const gw = await app.inject({ method: "POST", url: "/v1/search/crawl", headers: auth, payload: {} });
    expect(gw.statusCode).toBe(400);
    expect(JSON.parse(gw.body)).toEqual((await direct2(port, "/crawl", {})).json);
  });

  it("⚠️ 索引服务不可达 ⇒ 502 + `search_unavailable`（出声，而不是装作 404/空结果）", async () => {
    const r = await deadSearch.inject({ method: "GET", url: "/v1/search?q=x", headers: auth });
    expect(r.statusCode).toBe(502);
    const body = JSON.parse(r.body) as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe("search_unavailable");
    expect(body.error?.message, "没说清是哪个地址不可达 ⇒ 用户查不出为什么").toContain("127.0.0.1:1");
  });

  it("**没配** `searchBaseUrl` ⇒ 这组路由不存在（显式打开的能力，不靠默认值凑巧生效）", async () => {
    expect((await noSearch.inject({ method: "GET", url: "/v1/search?q=x", headers: auth })).statusCode).toBe(404);
    expect((await noSearch.inject({ method: "GET", url: "/v1/search/status", headers: auth })).statusCode).toBe(404);
    expect((await noSearch.inject({ method: "POST", url: "/v1/search/crawl", headers: auth, payload: {} })).statusCode).toBe(404);
  });

  it("端口是**派生**的：`llmGateway.ts` 从 `SEARCH_INDEX_PORT` 拼地址，不另写一个 8600", () => {
    const src = stripComments(readFileSync(resolve(__dirname, "../../gui/src/main/llmGateway.ts"), "utf8"));
    expect(src, "网关没把索引服务地址传下去 ⇒ /v1/search 这组路由永远不会被挂上")
      .toContain("searchBaseUrl: `http://127.0.0.1:${SEARCH_INDEX_PORT}`");
    
    expect(src, "llmGateway 里硬写了 8600 ⇒ 与 SEARCH_INDEX_PORT 是两个产地，会漂").not.toMatch(/\b8600\b/);
  });

  it("挂路由**不等于**开认证豁免：`/v1/search` 不许进 `authExempt`", () => {
    const src = stripComments(readFileSync(resolve(__dirname, "../../gateway-ts/src/index.ts"), "utf8"));
    expect(src).toContain('app.get("/v1/search"');
    expect(src).toContain('app.get("/v1/search/status"');
    expect(src).toContain('app.post("/v1/search/crawl"');
    
    const adds = src.match(/exempt\.add\([^)]*\)/g) ?? [];
    expect(adds.length, "没有找到 exempt.add ⇒ 这条判据的锚点漂了").toBeGreaterThan(0);
    for (const line of adds) { expect(line, `认证豁免里混进了检索路由：${line}`).not.toContain("search"); }
  });

  it("`SEARCH_INDEX_PORT` 仍是 8600（网关地址就是照它拼的，改了这里等于改了契约）", () => {
    expect(SEARCH_INDEX_PORT).toBe(8600);
  });
});


async function direct2(port: number, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
