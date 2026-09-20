/**
 * gui/src/renderer/pages/browserErrors.ts — 内嵌浏览器加载失败的**可读归因**（A-1018）。
 *
 * 为什么单独成文件：这是纯逻辑（无 JSX、无 hook），按项目铁律不许住在 `.tsx` 里。
 *
 * 编码取值依据：Chromium `net/base/net_error_list.h`（`NET_ERROR(NAME, value)` 宏）。
 * ⚠️ 本轮取证受限说明：本机到 chromium.googlesource.com / raw.githubusercontent.com 的直连被拦，
 * 未能拉到该头文件原文；下列取值经**两个独立来源交叉核对**：
 *   ① 华为 ArkWeb 文档逐条复刻了 Chromium 的这份错误码表（ERR_CONNECTION_RESET -101、
 *      ERR_NAME_NOT_RESOLVED -105、ERR_INTERNET_DISCONNECTED -106、ERR_CONNECTION_TIMED_OUT -118…）；
 *   ② 引用该头文件原文的工程文档（NET_ERROR(CONNECTION_REFUSED, -102)、
 *      NET_ERROR(NAME_NOT_RESOLVED, -105)、NET_ERROR(CONNECTION_RESET, -101)、
 *      NET_ERROR(INTERNET_DISCONNECTED, -106)、NET_ERROR(TIMED_OUT, -7)）。
 * **并顺手修掉了旧表里的两个错项**：`-130` 被当成"证书错误"（该值不在证书段 200-299 内）、
 * `-201` 被当成"连接被重置"（`-201` 实为 ERR_CERT_DATE_INVALID；连接被重置是 `-101`）。
 * 以"-201 显示成连接被重置"为例，用户会照着"检查网络"排查，而真因是**系统时间不对** —— 归因错了比没有归因更糟。
 */

/** Chromium 常量名（展示用，"标识"作用：用户可拿它去搜） */
const ERR_NAMES: Record<number, string> = {
  "-2": "ERR_FAILED",
  "-3": "ERR_ABORTED",
  "-7": "ERR_TIMED_OUT",
  "-21": "ERR_NETWORK_CHANGED",
  "-100": "ERR_CONNECTION_CLOSED",
  "-101": "ERR_CONNECTION_RESET",
  "-102": "ERR_CONNECTION_REFUSED",
  "-103": "ERR_CONNECTION_ABORTED",
  "-104": "ERR_CONNECTION_FAILED",
  "-105": "ERR_NAME_NOT_RESOLVED",
  "-106": "ERR_INTERNET_DISCONNECTED",
  "-107": "ERR_SSL_PROTOCOL_ERROR",
  "-108": "ERR_ADDRESS_INVALID",
  "-109": "ERR_ADDRESS_UNREACHABLE",
  "-113": "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
  "-118": "ERR_CONNECTION_TIMED_OUT",
  "-200": "ERR_CERT_COMMON_NAME_INVALID",
  "-201": "ERR_CERT_DATE_INVALID",
  "-202": "ERR_CERT_AUTHORITY_INVALID",
  "-310": "ERR_TOO_MANY_REDIRECTS",
  "-312": "ERR_UNSAFE_PORT",
  "-324": "ERR_EMPTY_RESPONSE",
};

/** 一句话说清"哪一步坏了" */
const ERR_TITLES: Record<number, string> = {
  "-3": "加载被中止（多半是站点自己取消了这次导航）",
  "-7": "连接超时",
  "-21": "网络发生了变化，加载被中断",
  "-100": "连接被关闭（服务器主动断开）",
  "-101": "连接被重置（网络不稳定、VPN/代理或安全软件拦截）",
  "-102": "连接被拒绝（服务没启动 / 端口没监听 / 被防火墙拦）",
  "-103": "连接被中止（发出的数据没有得到确认）",
  "-104": "连接失败",
  "-105": "域名无法解析（DNS 查不到这个网址对应的 IP）",
  "-106": "设备未联网",
  "-107": "SSL/TLS 协议错误",
  "-108": "地址无效（IP 或端口非法）",
  "-109": "地址不可达（到该主机没有路由）",
  "-113": "TLS 版本或加密套件不匹配（客户端与服务器没有共同支持项）",
  "-118": "连接超时",
  "-200": "证书域名不匹配",
  "-201": "证书已过期或尚未生效（通常是你本机时间不对）",
  "-202": "证书签发机构不受信任（自签证书 / 代理做了 HTTPS 拦截）",
  "-310": "重定向次数过多",
  /* A-1021 实测补录：`http://127.0.0.1:1/` 报的正是 -312（Chromium 的"受限端口"名单）。
   * 与 -109(ADDRESS_UNREACHABLE) 的区别很重要：-109 是"到不了"，-312 是"浏览器根本不发"——
   * 用户换成 8080 就能通，所以建议必须指向"换端口"而不是"查网络"。 */
  "-312": "端口被浏览器禁用（Chromium 的受限端口名单内，请求根本不会发出）",
  "-324": "服务器没有返回任何数据（站点可能已经挂了）",
};

/** 可操作建议（这才是"原因/标识"之外用户真正需要的东西） */
const ERR_HINTS: Record<number, string> = {
  "-7": "站点可能很慢或不可达。稍后重试，或检查是否需要走代理。",
  "-21": "网络切换/重连导致。点「重试」重新加载即可。",
  "-100": "服务器主动断开了连接。稍后重试；若稳定复现，可能是站点侧限制。",
  "-101": "常见于网络抖动、VPN/代理不稳、安全软件拦截。可先关掉代理再试。",
  "-102": "本地服务要确认已启动；若是公网站点，可能是端口被封或被防火墙拦截。",
  "-103": "网络层丢包/被中断。重试，或换网络。",
  "-104": "握手阶段失败。检查代理设置，或确认站点是否仅允许特定地区访问。",
  "-105": "① 核对网址拼写；② 本机执行 nslookup 域名 看是否有返回；③ 可把 DNS 换成 1.1.1.1 或 8.8.8.8（Cloudflare / Google）。注意：DNS 污染也会表现为本错误。",
  "-106": "检查网络连接（网线/Wi-Fi/热点），确认能打开其他网站。",
  "-107": "试试把地址从 https:// 改成 http://，或该站点 TLS 配置有问题。",
  "-108": "地址或端口写法不对（例如连到了 0.0.0.0、端口 0）。核对输入的 URL。",
  "-109": "目标网络不可达。多半是路由或 DNS 污染，可尝试换 DNS / 走代理。",
  "-113": "服务器要求的 TLS 版本/加密套件本机不支持（常见于很老的站点）。",
  "-118": "连接阶段就超时了。站点可能被墙或已宕机；确认是否要开代理。",
  "-200": "证书与该域名不符。若你在用代理/抓包工具，先关掉它。",
  "-201": "**先校准系统时间**（时区、自动同步）；时间对不上会直接判证书过期。",
  "-202": "证书签发机构不被信任：自签证书、或代理在做 HTTPS 拦截（如公司网关）。若确认站点可信，需自行导入其根证书。",
  "-310": "站点重定向成环。换用站点首页或直接访问目标页。",
  "-312": "换个端口再试（受限端口是浏览器硬编码的，改服务端没用）。常见受限端口：1、7、11、13、15、17、19、21、22、23、25、37、42、43、53、69、77、79、87、95、101、102、103、104、109、110、111、113、115、117、119、123、135、137、139、143、161、179、389、427、465、512、513、514、515、526、530、531、532、540、548、554、556、563、587、601、636、989、990、993、995、1719、1720、1723、2049、3659、4045、5060、5061、6000、6566、6665~6669、6697、10080。",
  "-324": "服务器接受了连接但没发数据。稍后重试；持续如此说明站点故障。",
};

/** 失败标题（未知码给兜底文案，不假装知道） */
export function failTitle(code: number): string {
  return ERR_TITLES[code] ?? `加载失败（未收录的错误码 ${code}）`;
}

/** 可操作建议 */
export function failHint(code: number): string {
  return ERR_HINTS[code] ?? "可先点「重试」；若稳定复现，把错误码连同网址反馈给开发者。";
}

/** Chromium 错误常量名（"标识"）；未收录返回空串，由调用方决定是否展示 */
export function failCodeName(code: number): string {
  return ERR_NAMES[code] ?? "";
}

/** 是否为"站点自己取消了本次导航"这类**不该报警**的情形（Chromium 在跳转/停止时会抛 -3） */
export function isBenignAbort(code: number): boolean {
  return code === -3;
}
