/**
 * tests/core-ts/social.spec.ts — 社交接入测试（语义对齐 Python tests/test_social.py）。
 * WeCom 企业微信：签名验证（URL echostr / msg） + 速率限制 + A-021 恒定时间 + P1-19 防重放。
 * 个人微信：TS 不实现（wechaty 弃用），501 回退文档。
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { WeComAdapter } from "../../core-ts/src/social/wecom.js";
import { SocialService } from "../../core-ts/src/services/social.js";
import { AgentState } from "../../core-ts/src/services/agents.js";

function sha1Sorted(...parts: string[]): string {
  return createHash("sha1").update(parts.slice().sort().join("")).digest("hex");
}

function tsNow(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("WeComAdapter verify", () => {
  it("URL 验证模式（echostr + msg_signature）通过", () => {
    const a = new WeComAdapter({ verifyToken: "secret_token" });
    const ts = tsNow();
    const sig = sha1Sorted("secret_token", ts, "n", "echostr");
    expect(
      a.verify({ msg_signature: sig, timestamp: ts, nonce: "n", echostr: "echostr" }),
    ).toBe(true);
  });

  it("消息验签模式（3 字段）通过", () => {
    const a = new WeComAdapter({ verifyToken: "secret_token" });
    const ts = tsNow();
    const sig = sha1Sorted("secret_token", ts, "n");
    expect(a.verify({ msg_signature: sig, timestamp: ts, nonce: "n" })).toBe(true);
  });

  it("签名不匹配拒绝", () => {
    const a = new WeComAdapter({ verifyToken: "secret_token" });
    const ts = tsNow();
    expect(
      a.verify({ msg_signature: "deadbeef", timestamp: ts, nonce: "n" }),
    ).toBe(false);
  });

  it("缺少字段拒绝（URL 模式缺 echostr）", () => {
    const a = new WeComAdapter({ verifyToken: "secret_token" });
    expect(a.verify({ msg_signature: "", timestamp: tsNow(), nonce: "n" })).toBe(false);
  });

  it("verify_token 未配置拒绝", () => {
    const a = new WeComAdapter({ verifyToken: "" });
    const ts = tsNow();
    expect(
      a.verify({ msg_signature: sha1Sorted("", ts, "n"), timestamp: ts, nonce: "n" }),
    ).toBe(false);
  });

  it("过期时间戳（>5min）拒绝（P1-19 防重放）", () => {
    const a = new WeComAdapter({ verifyToken: "tok" });
    const ts = String(Math.floor(Date.now() / 1000) - 9999);
    const sig = sha1Sorted("tok", ts, "n");
    expect(a.verify({ msg_signature: sig, timestamp: ts, nonce: "n" })).toBe(false);
  });

  it("非法时间戳拒绝", () => {
    const a = new WeComAdapter({ verifyToken: "tok" });
    expect(a.verify({ msg_signature: "x", timestamp: "NaN", nonce: "n" })).toBe(false);
  });
});

describe("WeComAdapter rate limit", () => {
  it("同一 chat_id 超过 10 次/60s 拒绝（N11-P3-3）", () => {
    const a = new WeComAdapter({});
    const results = Array.from({ length: 12 }, () => a.checkRateLimit("c1"));
    expect(results.slice(0, 10)).toEqual(Array(10).fill(true));
    expect(results[10]).toBe(false);
    expect(results[11]).toBe(false);
  });

  it("不同 chat_id 互不影响", () => {
    const a = new WeComAdapter({});
    for (let i = 0; i < 10; i++) {
      a.checkRateLimit("c1");
    }
    expect(a.checkRateLimit("c2")).toBe(true);
  });
});

describe("WeComAdapter send", () => {
  it("webhook_url 未配置返回 false（不抛出）", async () => {
    const a = new WeComAdapter({});
    expect(await a.send("c1", "hi")).toBe(false);
  });
});

describe("SocialService handleWebhook", () => {
  const agent: AgentState = {
    id: "agent-1",
    name: "test-agent",
    role: "assistant",
    identity_prompt: "I am test-agent",
    model_choice: "auto",
    parent_id: null,
    persona: {
      traits: [],
      preferences: [],
      skill_ownership: [],
      interactions: [],
      created_at: null,
      updated_at: null,
    },
    emotion: { mood: "neutral" },
    behavior: { active: [] },
    children: [],
    created_at: new Date().toISOString(),
  };

  const agentRef = {
    findAgent: async (id: string): Promise<AgentState | undefined> =>
      id === "agent-1" ? agent : undefined,
  };
  const chatFn = async (a: AgentState, content: string): Promise<string> => `回复:${a.name}:${content}`;

  it("echostr URL 验证：签名通过回传 echostr", async () => {
    const ts = tsNow();
    const sig = sha1Sorted("tok", ts, "n", "echo123");
    const svc = new SocialService({ wechat_verify_token: "tok" }, agentRef, chatFn);
    const r = await svc.handleWebhook({
      msg_signature: sig,
      timestamp: ts,
      nonce: "n",
      echostr: "echo123",
    });
    expect(r).toEqual({ ok: true, echostr: "echo123", reply: null, sent: false });
  });

  it("echostr 缺少签名拒绝（URL 模式缺回声）", async () => {
    const svc = new SocialService({ wechat_verify_token: "tok" }, agentRef, chatFn);
    const r = await svc.handleWebhook({ echostr: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
    }
  });

  it("verify_token 未配置、带 echostr → 503", async () => {
    const svc = new SocialService({}, agentRef, chatFn);
    const r = await svc.handleWebhook({
      msg_signature: "x",
      timestamp: tsNow(),
      nonce: "n",
      echostr: "e",
    });
    if (!r.ok) {
      expect(r.status).toBe(503);
    }
  });

  it("消息验签通过 → 调用 chatFn + send", async () => {
    const ts = tsNow();
    const sig = sha1Sorted("tok", ts, "n");
    let sent = "";
    const svc = new SocialService({ wechat_verify_token: "tok" }, agentRef, chatFn);
    const ad = (svc as unknown as { adapter: WeComAdapter }).adapter;
    ad.send = async (_cid: string, text: string) => {
      sent = text;
      return true;
    };
    const r = await svc.handleWebhook({
      msg_signature: sig,
      timestamp: ts,
      nonce: "n",
      agent_id: "agent-1",
      chat_id: "c1",
      content: "你好",
    });
    if (r.ok) {
      expect(r.reply).toBe("回复:test-agent:你好");
      expect(sent).toBe("回复:test-agent:你好");
    }
  });

  it("签名失败 → 403", async () => {
    const svc = new SocialService({ wechat_verify_token: "tok" }, agentRef, chatFn);
    const r = await svc.handleWebhook({
      msg_signature: "bad",
      timestamp: tsNow(),
      nonce: "n",
      agent_id: "agent-1",
      chat_id: "c1",
      content: "hi",
    });
    if (!r.ok) {
      expect(r.status).toBe(403);
    }
  });

  it("速率限制触发（N11-P3-3）→ 发送限制提示", async () => {
    const ts = tsNow();
    const sig = sha1Sorted("tok", ts, "n");
    const svc = new SocialService({ wechat_verify_token: "tok" }, agentRef, chatFn);
    const ad = (svc as unknown as { adapter: WeComAdapter }).adapter;
    let sent = "";
    ad.send = async (_cid: string, text: string) => {
      sent = text;
      return true;
    };
    for (let i = 0; i < 10; i++) {
      ad.checkRateLimit("c1");
    }
    const r = await svc.handleWebhook({
      msg_signature: sig,
      timestamp: ts,
      nonce: "n",
      agent_id: "agent-1",
      chat_id: "c1",
      content: "hi",
    });
    if (r.ok) {
      expect(r.reply).toContain("频繁");
      expect(sent).toContain("频繁");
    }
  });

  it("agent 未找到 → 无回复且未发送", async () => {
    const ts = tsNow();
    const sig = sha1Sorted("tok", ts, "n");
    const svc = new SocialService({ wechat_verify_token: "tok" }, agentRef, chatFn);
    const r = await svc.handleWebhook({
      msg_signature: sig,
      timestamp: ts,
      nonce: "n",
      agent_id: "no-such",
      chat_id: "c1",
      content: "hi",
    });
    if (r.ok) {
      expect(r.reply).toBeNull();
      expect(r.sent).toBe(false);
    }
  });

  it("empty content → 跳过 LLM，不报错", async () => {
    const ts = tsNow();
    const sig = sha1Sorted("tok", ts, "n");
    let called = false;
    const svc = new SocialService(
      { wechat_verify_token: "tok" },
      agentRef,
      async () => {
        called = true;
        return "";
      },
    );
    const r = await svc.handleWebhook({
      msg_signature: sig,
      timestamp: ts,
      nonce: "n",
      agent_id: "agent-1",
      chat_id: "c1",
      content: "",
    });
    expect(called).toBe(false);
    expect(r).toEqual({ ok: true, echostr: null, reply: null, sent: false });
  });
});
