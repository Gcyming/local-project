






















import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMPTY_CONTENT_PLACEHOLDER,
  countEmptyContent,
  hasToolCalls,
  isEmptyWireContent,
  placeholderForRole,
  sanitizeOutgoingMessages,
  sanitizeWirePayload,
  type WireMessage,
} from "../../core-ts/src/services/outgoingMessages.js";

import { ModelRouter } from "../../core-ts/src/router.js";
import type { RouteEntry } from "../../core-ts/src/router.js";
import type { ChatRequest } from "../../shared/gen/schemas.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");





const POISONED: WireMessage[] = [
  { role: "system", content: "你是 slime" },
  { role: "user", content: "继续啊" },
  { role: "assistant", content: "（2498 字的回答，略）" },
  { role: "user", content: "" },
  { role: "assistant", content: "（2498 字的回答，略）" },
  { role: "user", content: "你只需要告诉我，能用 skill 与 mcp 吗？" },
];

describe("A-1129-A 空内容判据", () => {
  it("空串 / 全空白 / null / undefined / 空数组 都算空", () => {
    expect(isEmptyWireContent("")).toBe(true);
    expect(isEmptyWireContent("   \n\t ")).toBe(true);
    expect(isEmptyWireContent(null)).toBe(true);
    expect(isEmptyWireContent(undefined)).toBe(true);
    expect(isEmptyWireContent([])).toBe(true);
  });

  it("⚠️ 有元素的数组**不算空**（识图路径：文字空但图就是这一轮的问题）", () => {
    expect(isEmptyWireContent([{ type: "text", text: "" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }]))
      .toBe(false);
    expect(isEmptyWireContent("一个字")).toBe(false);
    expect(isEmptyWireContent(0)).toBe(false);
  });

  it("占位表：四类角色都有话说，且都不为空", () => {
    for (const role of ["user", "assistant", "tool"]) {
      expect(placeholderForRole(role), `${role} 的占位是空的 —— 补了等于没补`).toBeTruthy();
      expect(placeholderForRole(role).trim()).not.toBe("");
    }
    expect(placeholderForRole("user")).toBe(EMPTY_CONTENT_PLACEHOLDER.user);
    
    expect(placeholderForRole("weird").trim()).not.toBe("");
    expect(placeholderForRole("").trim()).not.toBe("");
  });

  it("带工具调用的消息要被认出来（它们不能丢，见 sanitizeOutgoingMessages）", () => {
    expect(hasToolCalls({ role: "assistant", tool_calls: [{ id: "c1" }] })).toBe(true);
    expect(hasToolCalls({ role: "assistant", tool_calls: [] })).toBe(false);
    expect(hasToolCalls({ role: "assistant" })).toBe(false);
  });
});

describe("A-1129-B 规范化：补占位、不丢消息、不改交替", () => {
  it("⚠️ 真实毒样本被修好：空 user → 占位，且**条数与角色序列不变**", () => {
    const out = sanitizeOutgoingMessages(POISONED);
    expect(countEmptyContent(out), "还有空 content ⇒ 上游照样 400").toBe(0);
    

    expect(out.map((m) => m.role)).toEqual(POISONED.map((m) => m.role));
    expect(out).toHaveLength(POISONED.length);
    expect(out[3].content, "空 user 没被补成占位").toBe(placeholderForRole("user"));
  });

  it("空 assistant / 空 tool / content:null 都各有占位", () => {
    const out = sanitizeOutgoingMessages([
      { role: "user", content: "在吗" },
      { role: "assistant", content: "" },
      { role: "tool", content: "   " },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
    ]);
    expect(out[1].content).toBe(placeholderForRole("assistant"));
    expect(out[2].content).toBe(placeholderForRole("tool"));
    

    expect(out[3].content).toBe(placeholderForRole("assistant"));
    expect(out[3].tool_calls, "补占位时把 tool_calls 弄丢了 ⇒ tool 消息失去配对").toEqual([{ id: "c1", function: { name: "f", arguments: "{}" } }]);
  });

  it("空 **system** 整条丢弃（空系统提示 ≠ 说了一句空话；它在首位，丢了不会造成同角色相邻）", () => {
    const out = sanitizeOutgoingMessages([
      { role: "system", content: "" },
      { role: "user", content: "你好" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    
    const kept = sanitizeOutgoingMessages([{ role: "system", content: "你是 slime" }, { role: "user", content: "你好" }]);
    expect(kept).toHaveLength(2);
    expect(kept[0].content).toBe("你是 slime");
  });

  it("没变化 → 原样返回**同一个引用**（否则每帧都要为一次复制付账）", () => {
    const clean: WireMessage[] = [{ role: "user", content: "你好" }, { role: "assistant", content: "在" }];
    expect(sanitizeOutgoingMessages(clean)).toBe(clean);
    
    const dirty = sanitizeOutgoingMessages(POISONED);
    expect(dirty).not.toBe(POISONED);
  });

  it("纯函数：不改入参（只读，绝不就地改写调用方的数组）", () => {
    const src: WireMessage[] = [{ role: "user", content: "" }];
    const out = sanitizeOutgoingMessages(src);
    expect(src[0].content, "入参被就地改写了 —— 落盘历史/渲染层会跟着被污染").toBe("");
    expect(out[0].content).not.toBe("");
  });

  it("空数组 / 非数组输入不炸（这条路径在异常会话里会真的走到）", () => {
    expect(sanitizeOutgoingMessages([])).toEqual([]);
    expect(countEmptyContent([])).toBe(0);
  });
});

describe("A-1129-B2 请求体入口：只动 `messages`，其余字段与「没变就不复制」都要守住", () => {
  it("⚠️ 不带 messages 的请求**原样返回同一个引用**（embeddings 也从同一个出口走）", () => {
    

    const emb = { model: "bge-m3", input: ["你好"] };
    const out = sanitizeWirePayload(emb);
    expect(out, "无变化时返回了副本 —— 下游拿它做引用比较会误判为「变了」").toBe(emb);
    expect("messages" in (out as Record<string, unknown>), "给不带 messages 的请求塞了 messages 字段").toBe(false);
    expect(sanitizeWirePayload(null as unknown as { messages?: unknown })).toBeNull();
  });

  it("其余字段原样透传，只换 messages（且新对象不共享旧的 messages 引用）", () => {
    const payload: { model: string; temperature: number; messages: WireMessage[] } = {
      model: "agnes-3.0-flash", temperature: 0.7,
      messages: [{ role: "user", content: "" }, { role: "assistant", content: "在" }],
    };
    const out = sanitizeWirePayload(payload);
    expect(out.model).toBe("agnes-3.0-flash");
    expect(out.temperature).toBe(0.7);
    expect(out).not.toBe(payload);
    expect(payload.messages[0].content, "入参被就地改写了").toBe("");
    expect(out.messages[0].content).toBe(placeholderForRole("user"));
  });

  it("已经是干净的 payload → 同一个引用（每轮请求都要过这里，不能每次白复制）", () => {
    const clean = { model: "m", messages: [{ role: "user", content: "你好" }] as WireMessage[] };
    expect(sanitizeWirePayload(clean)).toBe(clean);
  });
});

describe("A-1129-C 接线：唯一分派点（覆盖四个协议 + tool_loop 的中途重发）", () => {
  const ROUTER_C = strip(read("core-ts/src/router.ts"));

  it("`ModelRouter` 的两个入口都过这道门（chat / chatStream）", () => {
    const uses = ROUTER_C.split("sanitizeWirePayload(payload)").length - 1;
    expect(uses, `router 里接了 ${uses} 处，应为 2（chat 与 chatStream）—— 漏一处就等于漏一条发送路径`).toBe(2);
    


    const chatAt = ROUTER_C.indexOf("async chat(payload: ChatRequest)");
    expect(chatAt, "找不到 chat() 入口").toBeGreaterThan(-1);
    const chatPrelude = ROUTER_C.slice(chatAt, ROUTER_C.indexOf("const chain = this.fallbackChain", chatAt));
    expect(chatPrelude, "chat() 没过门 —— 非流式路径照旧 400").toContain("sanitizeWirePayload(payload)");

    const streamAt = ROUTER_C.indexOf("async chatStream(");
    expect(streamAt, "找不到 chatStream() 入口").toBeGreaterThan(-1);
    const streamPrelude = ROUTER_C.slice(streamAt, ROUTER_C.indexOf("const chain = this.fallbackChain", streamAt));
    expect(streamPrelude, "chatStream() 没过门 —— 流式路径（GUI 主路径）照旧 400").toContain("sanitizeWirePayload(payload)");
  });

  it("⚠️ 落点必须是 **router**：`tool_loop` 的中途重发要经过它（这是本修法的前提）", () => {
    


    const loop = strip(read("core-ts/src/tool_loop.ts"));
    expect(loop, "tool_loop 的中途重发不再走 router ⇒ 空 content 又有一条路能出网")
      .toMatch(/this\.router\.(chat|chatStream)\(/);
    
    expect(loop, "tool_loop 不再推 content:null 了？前提变了，请重新评估本修法的落点")
      .toContain("content: msg?.content ?? null");
  });

  it("engine 侧**不再**自己接一道（避免两个施用点：拆一处就静默漏一处）", () => {
    const engine = strip(read("core-ts/src/services/engine.ts"));
    expect(engine, "engine 又接了一道 ⇒ 两处施用，且它管不到 tool_loop 的中途重发（是假保险）")
      .not.toContain("sanitizeOutgoingMessages(out)");
  });

  it("读取路径确实会产出空消息（本修法的前提事实没变 —— 变了要重新评估）", () => {
    

    const main = strip(read("gui/src/main/index.ts"));
    expect(main, "历史读取不再是「无条件展开成 user+assistant 两条」—— 前提变了，请重新评估本修法")
      .toMatch(/flatMap\(\(r\) => \[\s*\{ role: "user" as const, content: r\.user \},\s*\{ role: "assistant" as const, content: r\.ai \},\s*\]\)/);
  });
});






describe("A-1129-D 线路级：真实 ModelRouter 交出去的 payload 里没有空 content", () => {
  
  function makeRouter(): { router: ModelRouter; seen: ChatRequest[] } {
    const seen: ChatRequest[] = [];
    const router = new ModelRouter([], ((_route: RouteEntry) => ({
      chat: async (payload: ChatRequest) => {
        seen.push(payload);
        return { id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] };
      },
      chatStream: async (payload: ChatRequest) => {
        seen.push(payload);
        return { text: "ok", chunks: 1, model: "m" };
      },
    })) as never);
    router.add({ name: "AGNES:agnes-3.0-flash", baseUrl: "https://api.agnes-ai.cn", apiKey: "k", model: "agnes-3.0-flash", kind: "cloud", priority: 1, roles: ["chat"] } as RouteEntry);
    return { router, seen };
  }

  it("chat()：毒 payload（真实形态）进 → 交出去的 messages 无空 content，且交替与条数不变", async () => {
    const { router, seen } = makeRouter();
    await router.chat({ model: "agnes-3.0-flash", messages: POISONED as never } as ChatRequest);
    expect(seen, "router 没把请求交给客户端").toHaveLength(1);
    const sent = seen[0].messages as unknown as WireMessage[];
    expect(countEmptyContent(sent), "**真的把空 content 发出去了** —— 上游就会 400").toBe(0);
    expect(sent.map((m) => m.role)).toEqual(POISONED.map((m) => m.role));
    expect(sent).toHaveLength(POISONED.length);
  });

  it("chatStream()：同一条毒 payload 也过门（GUI 走的是这条）", async () => {
    const { router, seen } = makeRouter();
    await router.chatStream({ model: "agnes-3.0-flash", messages: POISONED as never } as ChatRequest, () => {  });
    expect(seen).toHaveLength(1);
    expect(countEmptyContent(seen[0].messages as unknown as WireMessage[]), "流式路径把空 content 发出去了").toBe(0);
  });

  it("⚠️ 工具循环第 2..N 轮的那一条（`content: null` + tool_calls）也被修，且 tool_calls 没丢", async () => {
    


    const { router, seen } = makeRouter();
    const toolRound: WireMessage[] = [
      { role: "system", content: "你是 slime" },
      { role: "user", content: "帮我跑一下" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "run", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ];
    await router.chat({ model: "agnes-3.0-flash", messages: toolRound as never } as ChatRequest);
    const sent = seen[0].messages as unknown as WireMessage[];
    expect(countEmptyContent(sent), "工具轮的 content:null 照旧出网 ⇒ 多轮工具调用必 400").toBe(0);
    const asst = sent.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(asst, "带工具调用的 assistant 不见了（tool 消息会失去配对）").toBeTruthy();
    expect((asst!.tool_calls as unknown[]).length).toBe(1);
    expect(asst!.content).toBe(placeholderForRole("assistant"));
  });
});
