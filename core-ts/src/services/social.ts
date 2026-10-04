





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

  
  async handleWebhook(req: Record<string, unknown>): Promise<SocialWebhookResult> {
    const msgSignature = String(req.msg_signature ?? req.msg_signature ?? "");
    const timestamp = String(req.timestamp ?? "");
    const nonce = String(req.nonce ?? "");
    const echostr = req.echostr !== undefined ? String(req.echostr) : undefined;
    const hasEchostr = echostr !== undefined;
    const hasSig = Boolean(msgSignature && timestamp && nonce);

    if (hasEchostr) {
      
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

  
  getWeComAdapter(): WeComAdapter {
    return this.adapter;
  }
}
