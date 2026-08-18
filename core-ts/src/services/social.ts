/**
 * core-ts/src/services/social.ts — SocialService（WeCom 企业微信接入，语义对齐 slime_server.py social_webhook）。
 * - 企业微信：官方 HTTP API → TS 原生（WeComAdapter）
 * - 个人微信：wechaty TS 长弃维护 → 回退 sidecar（v2.7 唯一例外），本服务不实现个人微信路径
 * - 编排：verify（URL echostr / msg 验签）→ receive → chatFn（Agent LLM）→ send
 */
import { WeComAdapter, WeComMessage } from "../social/wecom.js";
import { AgentState } from "./agents.js";

export interface SocialConfig {
  wechat_webhook_url?: string;
  wechat_verify_token?: string;
  wechat_corp_id?: string;
  wechat_corp_secret?: string;
}

export interface SocialAgentRef {
  findAgent(agentId: string): Promise<AgentState | undefined>;
}

export interface SocialChatFn {
  (agent: AgentState, content: string): Promise<string>;
}

/** 社交 webhook 处理结果（单一 ok 形状，echostr 与 reply 互斥） */
export interface SocialWebhookOk {
  ok: true;
  echostr: string | null;
  reply: string | null;
  sent: boolean;
}

export type SocialWebhookResult =
  | SocialWebhookOk
  | { ok: false; status: 400 | 403 | 503; error: string };

export class SocialService {
  private adapter: WeComAdapter;

  constructor(
    config: SocialConfig,
    private agentRef: SocialAgentRef,
    private chatFn: SocialChatFn,
  ) {
    this.adapter = new WeComAdapter({
      webhookUrl: config.wechat_webhook_url,
      corpId: config.wechat_corp_id,
      corpSecret: config.wechat_corp_secret,
      verifyToken: config.wechat_verify_token,
    });
  }

  /** 企业微信 webhook 入口（对齐 Python social_webhook / personal_wechat_webhook 的 WeCom 分支） */
  async handleWebhook(req: Record<string, unknown>): Promise<SocialWebhookResult> {
    const msgSignature = String(req.msg_signature ?? req.msg_signature ?? "");
    const timestamp = String(req.timestamp ?? "");
    const nonce = String(req.nonce ?? "");
    const echostr = req.echostr !== undefined ? String(req.echostr) : undefined;
    const hasEchostr = echostr !== undefined;
    const hasSig = Boolean(msgSignature && timestamp && nonce);

    if (hasEchostr) {
      // P1-19: URL 验证也必须先验签再回显
      if (!this.adapter.verifyToken) {
        return { ok: false, status: 503, error: "未配置 wechat_verify_token，webhook 已禁用" };
      }
      if (!hasSig) {
        return { ok: false, status: 400, error: "缺少签名参数" };
      }
      if (!this.adapter.verify({ msg_signature: msgSignature, timestamp, nonce, echostr })) {
        return { ok: false, status: 403, error: "签名校验失败" };
      }
      return { ok: true, echostr, reply: null, sent: false };
    }

    if (!this.adapter.verifyToken) {
      return { ok: false, status: 503, error: "未配置 wechat_verify_token，webhook 已禁用" };
    }
    if (!hasSig) {
      return { ok: false, status: 403, error: "缺少签名参数" };
    }
    if (!this.adapter.verify({ msg_signature: msgSignature, timestamp, nonce })) {
      return { ok: false, status: 403, error: "签名校验失败" };
    }

    // 消息处理流程
    const agentId = String(req.agent_id ?? "").trim();
    const message: WeComMessage = {
      chat_id: String(req.chat_id ?? ""),
      user_id: String(req.user_id ?? ""),
      content: String(req.content ?? ""),
      msg_type: String(req.msg_type ?? "text"),
    };

    if (!message.content) {
      return { ok: true, echostr: null, reply: null, sent: false };
    }

    let agent: AgentState | undefined;
    if (agentId) {
      agent = await this.agentRef.findAgent(agentId);
    }
    if (!agent) {
      return { ok: true, echostr: null, reply: null, sent: false };
    }

    // N11-P3-3: 速率限制（per chat_id）
    if (message.chat_id && !this.adapter.checkRateLimit(message.chat_id)) {
      const reply = "[消息过于频繁，请稍候再试]";
      const sent = reply ? await this.adapter.send(message.chat_id, reply) : false;
      return { ok: true, echostr: null, reply, sent };
    }

    try {
      const reply = await this.chatFn(agent, message.content);
      if (reply && message.chat_id) {
        const sent = await this.adapter.send(message.chat_id, reply);
        return { ok: true, echostr: null, reply, sent };
      }
      return { ok: true, echostr: null, reply, sent: false };
    } catch (e) {
      console.error(`[social] Agent 回复失败: ${e instanceof Error ? e.message : String(e)}`);
      if (message.chat_id) {
        await this.adapter.send(message.chat_id, "[回复失败]");
      }
      return { ok: true, echostr: null, reply: "[回复失败]", sent: true };
    }
  }

  /** 直接暴露 WeComAdapter 供测试/外部直调 */
  getWeComAdapter(): WeComAdapter {
    return this.adapter;
  }
}
