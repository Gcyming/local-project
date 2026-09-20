/**
 * core-ts/src/social/wecom.ts — 企业微信适配器（语义移植自 social/base.py）。
 * - SHA1 签名校验（A-021：hmac.compare_digest 恒定时间）
 * - P1-19：时间戳 5 分钟新鲜度窗口防重放
 * - N11-P3-3：per-chat_id 速率限制（60s 窗口 / 10 条）
 * - receive→LLM→send 流程交由 SocialService 编排（此处仅协议与发送）
 *
 * 研究门结论（§9.5B.4）：个人微信 wechaty TS 长弃维护（最后发布 2022-05，全 puppet 已弃用，
 * 协议漂移+封号风险不适宜 7×24），仅此例外回退 sidecar；企业微信官方 HTTP API 无 RPA 风险，
 * 直接移植为 TS 原生实现。
 */
import { createHash, timingSafeEqual } from "node:crypto";

const TS_FRESHNESS_WINDOW = 300; // P1-19: 5 分钟

export interface WeComMessage {
  chat_id: string;
  user_id: string;
  content: string;
  msg_type?: string;
}

export interface WeComVerifyParams {
  msg_signature: string;
  timestamp: string;
  nonce: string;
  echostr?: string;
}

export class WeComAdapter {
  readonly webhookUrl: string;
  readonly verifyToken: string;
  readonly corpId: string;
  readonly corpSecret: string;
  private accessToken: string | null = null;
  private tokenExpires: number = 0;
  private rateBuckets: Map<string, [number, number]> = new Map();
  private readonly rateWindow = 60_000;
  private readonly rateMax = 10;

  constructor(opts: {
    webhookUrl?: string;
    corpId?: string;
    corpSecret?: string;
    verifyToken?: string;
  }) {
    this.webhookUrl = (opts.webhookUrl ?? "").replace(/\/+$/, "");
    this.corpId = opts.corpId ?? "";
    this.corpSecret = opts.corpSecret ?? "";
    this.verifyToken = opts.verifyToken ?? "";
  }

  /** per-chat_id 速率限制（N11-P3-3）：返回 true=允许 */
  checkRateLimit(chatId: string): boolean {
    const now = Date.now();
    for (const [cid, [t]] of this.rateBuckets) {
      if (now - t > this.rateWindow) {
        this.rateBuckets.delete(cid);
      }
    }
    const entry = this.rateBuckets.get(chatId);
    if (!entry) {
      this.rateBuckets.set(chatId, [now, 1]);
      return true;
    }
    const [start, count] = entry;
    if (count >= this.rateMax) {
      console.warn(`[social/wecom] chat_id=${chatId} 速率限制触发（${count}/${this.rateWindow}ms）`);
      return false;
    }
    this.rateBuckets.set(chatId, [start, count + 1]);
    return true;
  }

  /** 企业微信签名校验（URL 验证含 echostr / 消息验签） */
  verify(params: WeComVerifyParams): boolean {
    const { msg_signature, timestamp, nonce, echostr } = params;
    const isUrlVerify = Boolean(echostr);
    const required = isUrlVerify
      ? [msg_signature, timestamp, nonce, echostr!]
      : [msg_signature, timestamp, nonce];
    if (required.some((x) => !x)) {
      return false;
    }
    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum) || Number.isNaN(tsNum)) {
      console.warn("[social/wecom] 签名时间戳非法，拒绝");
      return false;
    }
    if (Math.abs(Date.now() - tsNum * 1000) > TS_FRESHNESS_WINDOW * 1000) {
      console.warn(
        `[social/wecom] 签名时间戳超窗（>${TS_FRESHNESS_WINDOW}s），拒绝（防重放）`,
      );
      return false;
    }
    if (!this.verifyToken) {
      console.warn("[social/wecom] verify_token 未配置，拒绝验证请求");
      return false;
    }
    const parts = isUrlVerify
      ? [this.verifyToken, timestamp, nonce, echostr!]
      : [this.verifyToken, timestamp, nonce];
    const digest = createHash("sha1").update(parts.slice().sort().join("")).digest("hex");
    // A-021：恒定时间比较；缓冲长不一致（即签名不匹配）提前拒绝，防时序侧信道
    const sigBuf = Buffer.from(msg_signature, "utf8");
    const digBuf = Buffer.from(digest, "utf8");
    if (sigBuf.length !== digBuf.length) {
      return false;
    }
    return timingSafeEqual(sigBuf, digBuf);
  }

  /** 获取 access_token（自动刷新；corpSecret 仅请求作用域内使用） */
  private async getAccessToken(): Promise<string> {
    if (!this.corpSecret) {
      return "";
    }
    if (this.accessToken && Date.now() < this.tokenExpires) {
      return this.accessToken;
    }
    const secret = this.corpSecret;
    try {
      const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${secret}`;
      const resp = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
      const data = (await resp.json()) as { access_token?: string; expires_in?: number };
      this.accessToken = data.access_token ?? "";
      const expiresIn = data.expires_in ?? 7200;
      this.tokenExpires = Date.now() + (expiresIn - 300) * 1000;
      return this.accessToken;
    } catch (e) {
      console.error(`[social/wecom] 获取 access_token 失败: ${e instanceof Error ? e.message : String(e)}`);
      return "";
    }
  }

  /** 通过企业微信 webhook 发送文本消息（chatId 在 webhook 模式下不透传，与 Python 语义一致） */
  async send(_chatId: string, text: string): Promise<boolean> {
    if (!this.webhookUrl) {
      console.warn("[social/wecom] webhook_url 未配置");
      return false;
    }
    try {
      const resp = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        return false;
      }
      try {
        const data = (await resp.json()) as { errcode?: number };
        return data.errcode === 0;
      } catch {
        return resp.ok;
      }
    } catch (e) {
      console.error(`[social/wecom] 发送失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** 发送消息到群聊/用户（调用 access_token 路径，可选） */
  async sendToUser(chatId: string, text: string): Promise<boolean> {
    const token = await this.getAccessToken();
    if (!token) {
      return false;
    }
    try {
      const resp = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            touser: chatId,
            msgtype: "text",
            text: { content: text },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!resp.ok) {
        return false;
      }
      const data = (await resp.json()) as { errcode?: number };
      return data.errcode === 0;
    } catch (e) {
      console.error(`[social/wecom] sendToUser 失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
