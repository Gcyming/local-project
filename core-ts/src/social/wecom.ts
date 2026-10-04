










import { createHash, timingSafeEqual } from "node:crypto";

const TS_FRESHNESS_WINDOW = 300; 

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
    
    const sigBuf = Buffer.from(msg_signature, "utf8");
    const digBuf = Buffer.from(digest, "utf8");
    if (sigBuf.length !== digBuf.length) {
      return false;
    }
    return timingSafeEqual(sigBuf, digBuf);
  }

  
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
