/**
 * core-ts/src/http-identity.ts —— 对外请求**身份**的单一产地（申请类流量）。
 *
 * 背景：slime 的模型请求早就老实挂了 `productUserAgent()`（见 `llm/client.ts`），
 * 但 GUI 侧还有三处**各写各的** UA 字面量：`slime-agent` / `slime-gui` / `slime-gui/adb`。
 * 同一件事散落三处，就必然漂移——而且漂移出来的差异本身就会让上游看到
 * 「同一个产品，自称三个名字」的指纹，那正是风控判定身份存疑的信号之一。
 *
 * 本模块只管**「申请类」**流量（调模型 API、拉 GitHub release、拉市场索引）：
 * 这类请求本来就带鉴权或属于人机交互，**诚实标识自己最安全**——
 * 藏身份毫无收益（服务端看得到 API Key 归属），反倒因「无 UA / 身份矛盾」被判为
 * 匿名自动化滥用而**风控封号**。
 *
 * ⚠️ **不要把爬虫 UA 收进这里**。抓取类流量要的是「像浏览器」，不是「像 slime」
 * （`websearch/crawler.ts`、`search/onlineSearch.ts` 自带浏览器/robots UA），
 * 两套策略别混。也不要把用户邮箱、本机路径、主机名塞进来——那是泄露，不是标识。
 *
 * ⚠️ **永远不要为了「像官方 SDK」而伪造 `x-stainless-*` / `x-goog-api-client` 之类
 * 第三方 SDK 指纹头**，也不要随机化 UA：那种「伪装」恰好是滥用工具的特征，
 * 比老实报上名更容易触发风控，且不可解释。本模块只提供**诚实且一致**的身份。
 */

import { productUserAgent } from "./product.js";

/**
 * 对外申请类流量的 `User-Agent`：`slime/<version>`。
 *
 * 与模型 API、GitHub API、市场索引**共用同一个值**——同产品同身份，
 * 不因走的是哪个出口而改口径。
 */
export function applicationUserAgent(): string {
  return productUserAgent();
}

/**
 * GitHub API 需要的 `Accept` + 身份头。
 *
 * ⚠️ GitHub 明确要求调用方带 `User-Agent`，不带会**直接 403**；
 * 身份值与模型请求同源，避免「模型侧叫 slime、GitHub 侧叫别的」。
 */
export function githubHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Accept: "application/vnd.github+json", "User-Agent": applicationUserAgent(), ...extra };
}

/**
 * 通用「只报身份」的请求头，供下载/重定向等只需要一行身份的地方使用。
 */
export function identityHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "User-Agent": applicationUserAgent(), ...extra };
}