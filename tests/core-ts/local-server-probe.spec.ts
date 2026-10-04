










import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  capabilityMatchesModel,
  clearLocalCapabilityCache,
  getLocalCapability,
  isLoopbackBaseUrl,
  managedChatPorts,
  modelsUrlFor,
  normalizeModelPath,
  probeLocalEndpoint,
  propsUrlFor,
} from "../../gui/src/main/localServerProbe.js";
import { ServerState, setModelServer, type ModelServerManager, type StatusItem } from "../../core-ts/src/model_server.js";
import type { LocalServerCapability } from "../../core-ts/src/model_introspect.js";

const FIX = fileURLToPath(new URL("../fixtures/llama", import.meta.url));
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8"));

const PROPS_READY = read("props.ready");
const MODELS_READY = read("models.ready");
const LOADING = read("props.loading");


function stubFetch(opts: { props?: unknown; models?: unknown; propsStatus?: number; modelsStatus?: number; throwOn?: RegExp } = {}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (opts.throwOn?.test(url)) { throw new Error("ECONNREFUSED"); }
    const isProps = url.endsWith("/props");
    const status = isProps ? (opts.propsStatus ?? 200) : (opts.modelsStatus ?? 200);
    const body = isProps ? (opts.props ?? PROPS_READY) : (opts.models ?? MODELS_READY);
    return { status, json: async () => body };
  });
  return calls;
}

beforeEach(() => clearLocalCapabilityCache());
afterEach(() => { vi.unstubAllGlobals(); setModelServer(null as unknown as ModelServerManager); });



describe("baseUrl → 端点 URL", () => {
  it("★ provider 的 /v1 尾巴必须剥掉：/props 在根路径下，不在 /v1 下", () => {
    
    expect(propsUrlFor("http://127.0.0.1:8800/v1")).toBe("http://127.0.0.1:8800/props");
    expect(modelsUrlFor("http://127.0.0.1:8800/v1")).toBe("http://127.0.0.1:8800/v1/models");
  });

  it("无版本段 / 带尾斜杠 / /api/v1 都能正确归一", () => {
    expect(propsUrlFor("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/props");
    expect(propsUrlFor("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/props");
    expect(propsUrlFor("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/props");
    expect(propsUrlFor("http://localhost:1234/api/v1")).toBe("http://localhost:1234/props");
    expect(propsUrlFor("http://127.0.0.1:8080/v2")).toBe("http://127.0.0.1:8080/props");
  });

  it("只剥**结尾**的版本段，不动路径中间的 /v1", () => {
    
    expect(propsUrlFor("http://127.0.0.1:8080/llama/v1")).toBe("http://127.0.0.1:8080/llama/props");
  });
});



describe("isLoopbackBaseUrl —— 只有本机端点才值得问 /props", () => {
  it("本机各种写法都认", () => {
    for (const ok of [
      "http://127.0.0.1:8800", "http://127.0.0.1:8800/v1", "https://localhost:1234/v1",
      "http://127.0.0.1", "http://[::1]:8080", "http://0.0.0.0:8080", "http://127.0.0.1:8800/",
    ]) {
      expect(isLoopbackBaseUrl(ok), ok).toBe(true);
    }
  });

  it("★ 形似但不是本机的必须判否（防前缀欺骗）", () => {
    for (const bad of [
      "https://api.openai.com/v1",
      "http://127.0.0.1.evil.com/v1",       
      "https://localhost.mydomain.com/v1",  
      "http://192.168.1.10:8080/v1",        
      "http://10.0.0.5:8800/v1",
      "http://127x0x0x1/v1",
      "",
      "not a url",
    ]) {
      expect(isLoopbackBaseUrl(bad), bad).toBe(false);
    }
  });
});



describe("capabilityMatchesModel —— 别拿 A 模型的窗口回答 B 模型", () => {
  const cap = {
    state: "ready", effectiveCtx: 8192, trainCtx: 40960,
    alias: "D:/pilot project/models/chat/qwen3-1.7b-q8_0.gguf",
    modelPath: "D:/pilot project/models/chat/qwen3-1.7b-q8_0.gguf",
  } as LocalServerCapability;

  it("路径命中（分隔符/大小写归一：Windows 两种写法都算同一个文件）", () => {
    expect(capabilityMatchesModel(cap, { path: "D:/pilot project/models/chat/qwen3-1.7b-q8_0.gguf" })).toBe(true);
    expect(capabilityMatchesModel(cap, { path: "D:\\pilot project\\models\\chat\\Qwen3-1.7B-Q8_0.gguf" })).toBe(true);
    expect(capabilityMatchesModel(cap, { path: "D://pilot project//models/chat/qwen3-1.7b-q8_0.gguf" })).toBe(true);
  });

  it("★ 路径不匹配 → 判否（服务在跑的是别的模型）", () => {
    expect(capabilityMatchesModel(cap, { path: "D:/models/other/llama-3-8b.gguf" })).toBe(false);
  });

  it("用 --alias 命名时按别名匹配", () => {
    const aliased = { ...cap, modelPath: null, alias: "deepseek-chat" } as LocalServerCapability;
    expect(capabilityMatchesModel(aliased, { ids: ["deepseek-chat"] })).toBe(true);
    expect(capabilityMatchesModel(aliased, { ids: ["other"] })).toBe(false);
  });

  it("★ 问不出身份 → 判否（宁可回落同域兜底，也不要一个可能是别的模型的数字）", () => {
    const anonymous = { ...cap, modelPath: null, alias: null } as LocalServerCapability;
    expect(capabilityMatchesModel(anonymous, { ids: ["x"] })).toBe(false);
    expect(capabilityMatchesModel(anonymous, { path: "D:/a.gguf" })).toBe(false);
  });

  it("trustedEndpoint 跳过自证（loopback provider：配置本身就点明了地址）", () => {
    const anonymous = { ...cap, modelPath: null, alias: null } as LocalServerCapability;
    expect(capabilityMatchesModel(anonymous, { trustedEndpoint: true, ids: ["x"] })).toBe(true);
  });

  it("normalizeModelPath 只做大小写/分隔符归一，不吞掉路径差异", () => {
    expect(normalizeModelPath("D:\\a\\B.gguf")).toBe("d:/a/b.gguf");
    expect(normalizeModelPath("  D:/a/b.gguf  ")).toBe("d:/a/b.gguf");
    expect(normalizeModelPath("D:/a/b.gguf")).not.toBe(normalizeModelPath("D:/a/c.gguf"));
  });
});



describe("probeLocalEndpoint / getLocalCapability", () => {
  it("★ 真实就绪夹具 → ready，且有效窗口 8192 / 训练上限 40960 都在", async () => {
    stubFetch();
    const cap = await probeLocalEndpoint("http://127.0.0.1:8800/v1");
    expect(cap.state).toBe("ready");
    expect(cap.effectiveCtx).toBe(8192);
    expect(cap.trainCtx).toBe(40960);
  });

  it("★ 真实加载态夹具（503）→ loading，数字全 null", async () => {
    stubFetch({ props: LOADING, propsStatus: 503, models: LOADING, modelsStatus: 503 });
    const cap = await probeLocalEndpoint("http://127.0.0.1:8800/v1");
    expect(cap.state).toBe("loading");
    expect(cap.effectiveCtx).toBeNull();
    expect(cap.trainCtx).toBeNull();
  });

  it("★ fetch 抛异常（ECONNREFUSED）→ down，**绝不向上抛**", async () => {
    stubFetch({ throwOn: /.*/ });
    await expect(probeLocalEndpoint("http://127.0.0.1:9999")).resolves.toMatchObject({ state: "down", effectiveCtx: null });
    await expect(getLocalCapability("http://127.0.0.1:9999")).resolves.toMatchObject({ state: "down" });
  });

  it("★ JSON 解析失败：不抛，且**不判 down**（传输层是通的，进程就在跑）", async () => {
    
    
    
    vi.stubGlobal("fetch", async () => ({ status: 200, json: async () => { throw new SyntaxError("bad json"); } }));
    const cap = await probeLocalEndpoint("http://127.0.0.1:8080");
    expect(cap.state).toBe("ready");
    expect(cap.effectiveCtx).toBeNull();
    expect(cap.signals.some((s) => s.includes("端点半结构可能变了"))).toBe(true);
  });

  it("JSON 解析失败 + 连不上 → down（两个条件都不满足才算联系不上）", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
    await expect(probeLocalEndpoint("http://127.0.0.1:8080")).resolves.toMatchObject({ state: "down" });
  });

  it("★ 缓存：TTL 内同一端点只发一次请求（done 载荷会多次调用它）", async () => {
    const calls = stubFetch();
    await getLocalCapability("http://127.0.0.1:8800/v1");
    const first = calls.length;
    expect(first).toBe(2); 
    await getLocalCapability("http://127.0.0.1:8800/v1");
    await getLocalCapability("http://127.0.0.1:8800/v1");
    expect(calls.length).toBe(first);
  });

  it("bypassCache 强制重新问；clearLocalCapabilityCache 也能清", async () => {
    const calls = stubFetch();
    await getLocalCapability("http://127.0.0.1:8800/v1");
    await getLocalCapability("http://127.0.0.1:8800/v1", { bypassCache: true });
    expect(calls.length).toBe(4);
    clearLocalCapabilityCache();
    await getLocalCapability("http://127.0.0.1:8800/v1");
    expect(calls.length).toBe(6);
  });

  it("不同别名不共用缓存键（S4 别名寻址）", async () => {
    const calls = stubFetch();
    await getLocalCapability("http://127.0.0.1:8800/v1", { alias: "a" });
    await getLocalCapability("http://127.0.0.1:8800/v1", { alias: "b" });
    expect(calls.length).toBe(4);
  });

  it("URL 归一后共用缓存（/v1 与不带 /v1 是同一个服务）", async () => {
    const calls = stubFetch();
    await getLocalCapability("http://127.0.0.1:8800/v1");
    await getLocalCapability("http://127.0.0.1:8800");
    expect(calls.length).toBe(2);
  });
});



describe("managedChatPorts —— 内存状态 + 跨进程 registry 两路", () => {
  function fakeMgr(items: Array<Partial<StatusItem>>): ModelServerManager {
    return { status: () => items as StatusItem[] } as unknown as ModelServerManager;
  }

  it("只收 role=chat 且 state=ready 的端口", () => {
    setModelServer(fakeMgr([
      { role: "chat", port: 18082, state: ServerState.READY },
      { role: "chat", port: 18083, state: ServerState.LOADING },
      { role: "embedding", port: 8999, state: ServerState.READY },
      { role: "chat", port: 0, state: ServerState.READY },
    ]));
    const ports = managedChatPorts();
    expect(ports).toContain(18082);
    expect(ports).not.toContain(18083); 
    expect(ports).not.toContain(8999);  
    expect(ports).not.toContain(0);
  });

  it("status() 抛异常时不崩，返回数组", () => {
    setModelServer({ status: () => { throw new Error("boom"); } } as unknown as ModelServerManager);
    expect(() => managedChatPorts()).not.toThrow();
    expect(Array.isArray(managedChatPorts())).toBe(true);
  });

  it("没有管理器也不崩", () => {
    setModelServer(null as unknown as ModelServerManager);
    expect(() => managedChatPorts()).not.toThrow();
  });
});
