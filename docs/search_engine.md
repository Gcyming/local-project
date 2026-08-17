# 内置网络工具方案（web_fetch / web_search）

> 状态：规格冻结（四轮讨论定稿 + 一次安全审查修复），待实施
> 日期：2026-08-14（v2：修复 DNS Rebinding、重定向协议白名单、英文验证码、chunked 截断、gb18030 等审查发现；v3：补入实施关注点坑位清单）

## 一、背景与目标

- Agent 平台内置"上网"能力，自研不依赖外部 MCP
- 技术路线：纯 httpx 轻量方案，不引入 playwright/puppeteer
- 前置已闭环：BUG-031（流式工具调用）、BUG-032（多轮工具循环 + 工具场景流式回复）
- 用户在国内直连，搜索引擎后端限国内可用服务

## 二、总体架构

```
core/fetcher.py    # WebFetcher：httpx client + SSRF 校验 + 反爬头 + 重定向链
core/extractor.py  # 内容提取：DOM → 结构化文本（标题 + 正文截断 + JS 渲染检测）
core/search.py     # 搜索引擎抽象：Bing（主）/ 百度（兜底）+ 反爬节奏 + 退避
tools/builtin.py   # 注册 web_fetch / web_search 工具（permissions=["network"]）
```

工具执行链路（已验证通）：

```
对话 → LLM tool_calls → 沙箱 check（L4 + auto_approve_tools 白名单 → 自动批准）
→ registry.call_tool → fetcher/search 执行 → 结果回填 → 多轮循环（≤3 轮）
```

## 三、工具规格

### 3.1 web_fetch(url, max_chars=4000)

参数：
- `url`（必填）：要抓取的网页地址

执行流程：
1. **协议白名单**：仅 http/https，file/ftp/data 等拒绝
2. **SSRF 校验**：hostname getaddrinfo 全解析（A + AAAA）→ 每个结果 ipaddress 检查，任一内网即拒
   - ipaddress 解析 try/except 兜底，不可解析（如 127.1）一律拒绝
   - userinfo 写法（https://google.com@127.0.0.1/）用 urllib.parse.urlparse 取 hostname 后再解析校验
3. **IP 钉扎连接（P0，防 DNS Rebinding）**：校验通过后取第一个合格 IP 作为**实际连接地址**，禁止让 httpx 对原 hostname 二次 DNS 解析：
   - 请求 URL 改写为 `http(s)://{ip}{path}?{query}`（IPv6 加方括号）
   - `headers["Host"] = 原 hostname`
   - HTTPS 时 `extensions={"sni_hostname": 原 hostname}`（SNI + 证书校验按原域名，规避 IP 证书失败）
4. **请求头**：移动端 UA（Android，不含 sec-ch-ua），Accept-Language zh-CN，Referer=目标 origin，timeout 10s（connect 5s），follow_redirects=False
5. **重定向**：最多 5 跳，每跳流程：urljoin(current, location) 规范化 → **协议白名单复查**（仅 http/https）→ DNS 解析 + ipaddress 校验 → IP 钉扎连接，任一步失败即止，超限报错
6. **响应**：流式读取，**累计字节达 2MB 立即中断连接**（不依赖 Content-Length，防 chunked 无限推送）；**非文本 Content-Type 拦截**（响应头不以 `text/` 开头且不含 html/xml/json → 直接返回 `[该 URL 返回非文本内容（{content_type}），无法提取]`，防二进制乱码进 LLM）；编码启发式（响应头 charset → utf-8 严格解码 → gb18030）；extractor 提取
7. **异常回填**：超时/连接失败/非 2xx/DNS 失败均转简洁中文错误，不抛裸异常给 LLM

返回：结构化文本 `标题 + 正文（≤max_chars 字符，超出加"[内容已截断]"标记）`
JS 渲染站（命中特征）返回："[该页面需浏览器渲染，无法获取内容]"

### 3.2 web_search(query, max_results=10)

参数：
- `query`（必填）：搜索关键词
- `max_results`（可选，默认 10，上限 10）

执行流程：
1. **Bing 国内版为主**：`https://cn.bing.com/search?q=<urlencode>`
2. **预热**：进程内首次搜索前先访问 Bing 主页（后续复用）
3. **随机延迟**：500-1300ms（验证码事件后 5 分钟窗口内退避至 2000-4000ms）
4. **解析**：`li.b_algo` 为主选择器，fallback `.b_algo`（div 版，desc 可能为空需容忍）
5. **百度兜底**：仅当 Bing 请求级失败（非验证码）时切换 `https://www.baidu.com/s?wd=<urlencode>`，解析多选择器 fallback：`#content_left h3` → `h3.c-title` → `div.result h3`（百度结构频繁变动，需兼容）
6. **验证码检测**：响应体特征文本匹配（中英文全量：安全验证/验证码/滑块/人机验证/verify/captcha/robot/unusual traffic/challenge）→ 不重试，返回友好提示 + 记录退避

返回：`title + url + desc（≤300 字符）` 最多 10 条

降级文案：
```
[搜索引擎要求人机验证。请稍等 1 分钟后重试，或更换网络环境后再搜索。]
```

## 四、SSRF 防护（安全铁律）

### 拦截地址段

| 段 | 说明 |
|---|---|
| 127.0.0.0/8 | IPv4 回环 |
| 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 | IPv4 私网 |
| 169.254.0.0/16 | 云 IMDS 凭证（GET 可拿临时凭证） |
| 0.0.0.0/8 | 特殊段 |
| ::1、::/128 | IPv6 回环/未指定 |
| fe80::/10 | 链路本地（Windows 每块网卡默认地址） |
| fc00::/7 | IPv6 ULA 私网 |
| ::ffff:0:0/96 | IPv4 映射地址（[::ffff:127.0.0.1] 绕过） |
| 64:ff9b::/96 | NAT64（公网可路由但映射内网 v4） |
| 2001:db8::/32 | 文档保留段 |

### 实现原则（关键）

1. **只认解析后的标准 IP**：不做 URL 文本层面 IP 检查。hostname 用 getaddrinfo 全解析（A + AAAA），对每个解析结果做 ipaddress 检查，**任一内网即拒**（防 v6 绕过 v4 检查）
2. **ipaddress 解析 try/except 兜底**：`ipaddress.ip_address('127.1')` 抛 ValueError，不可解析即拒绝（内网嫌疑更大）
3. **重定向逐跳重验**：手动 redirect（follow_redirects=False），每跳流程：urljoin 规范化相对路径 → **协议白名单复查**（仅 http/https，防 302 到 file:// 等）→ 重新 DNS + ipaddress 校验 → IP 钉扎
4. **天然覆盖的绕过写法**：十六进制（0x7f000001）、十进制长整型（2130706433）、简写（127.1）、八进制、内嵌 IPv6、userinfo（google.com@127.0.0.1）均在解析层归一化为标准 IP，无需手工转换
5. **DNS 解析失败**：返回 "[错误] 无法解析域名"，不抛裸异常
6. **IP 钉扎连接（P0，防 DNS Rebinding TOCTOU）**：校验与连接之间必须无二次解析窗口——校验通过的 IP 直接作为 httpx 连接目标（URL 改写 + Host 头 + HTTPS 用 sni_hostname），详见 3.1 第 3 步。**不钉扎则整套 SSRF 防护可被 DNS Rebinding 一击穿透**

## 五、反爬策略

1. **移动端 UA 替代桌面端**：Bing 对移动 UA 的验证码检测放宽；非浏览器场景带 sec-ch-ua 反而被标记"伪造 Chrome"
   ```
   Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ...
   Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
   Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
   Referer: https://cn.bing.com/
   ```
2. **预热**：搜索前先访问搜索站主页，降低首次请求被标记概率
3. **随机延迟**：每次搜索前 500-1300ms 随机等待
4. **验证码降级**：检测到验证码页不重试（重试只会让封禁窗口更短），返回友好提示
5. **自适应退避**：验证码事件后 5 分钟窗口内延迟提升至 2000-4000ms，窗口过期恢复
6. **并发限制**：工具级 asyncio.Semaphore(5)，超过排队（Bing 同 IP 高频请求触发验证码）
7. **连接池**：httpx.AsyncClient limits max_connections=10 / max_keepalive_connections=5

## 六、内容提取策略

1. **标题**：`<title>` 或 h1，缺失时用 URL 兜底
2. **正文**：语义标签优先（article / .post-content / .article-content / main / .content），无则 body 兜底；移除 script/style/nav/footer/header
3. **截断**：正文 ≤4000 字符（≈2000-3000 tokens），超出加 "[内容已截断]" 标记
4. **HTML 实体解码**：标题与正文统一 `html.unescape()`（&amp; &#x27; 等），不解码 LLM 看到的是原始实体串
5. **编码启发式**：响应头 charset → utf-8 严格解码失败 → **gb18030**（gbk 超集，覆盖 € 等字符；不加 chardet 依赖；Content-Type 误导率 10-15%，启发式成功率 >99%）
6. **JS 渲染站检测**（命中即返回"需浏览器渲染"提示，不浪费 token）：
   - `<div id="app">` / `<div id="root">` 且内无实际内容
   - `window.__INITIAL_STATE__` / `__NEXT_DATA__` 标记
   - script 标签数 > 20 且正文标签为空
   - **误判避免**：语义标签（article/main/.content）有实际文本内容则不触发提示

## 七、沙箱集成

1. `web_fetch` / `web_search` 权限声明 `["network"]`（L4）
2. `config/agents.json` 目标 Agent 条目加：

```json
"sandbox_override": {
    "auto_approve_tools": ["web_fetch", "web_search"]
}
```

3. 机制：`auto_approve_tools` 白名单在审批回调前短路（sandbox.py L503），免人工确认（server 端回调一律拒绝，L4 无白名单必拒）；审计已核实闭环——自动批准分支同样写审计日志（sandbox.py:505 `_write_audit`），非"无痕放行"
4. **llm.py:442 兼容改动**（1 行）：

```python
# 原
target_str = str(args.get("path") or args.get("file") or args.get("target") or args)
# 改为
target_str = str(args.get("url") or args.get("path") or args.get("file") or args.get("target") or args)
```

让 URL 类工具可被工具级 target 黑名单拦截，现有 file_read/file_list（用 path）不受影响
5. **workspace 兼容关注点**：`_validate_workspace`（sandbox.py:726-757）的字段提取不认识 `url`——workspace 隔离检查在 grant_permission 最前（:434，早于 auto_approve_tools 短路），配置了 workspace 的 Agent 调 web_fetch 时 target_str 为纯 URL 字符串，会被当路径 resolve 而误杀（Elysia 当前无 workspace 不触发，分裂出的子 Agent 需注意）。建议：`_validate_workspace` 字段提取加入 `url` 并直接放行（网络目标归 SSRF 管，不归路径隔离管）
6. **配置生效时机**：`load_agent_sandbox_configs` 仅启动时执行，且 server 与 CLI 两个进程各自加载——修改 agents.json 白名单后两边都需重启

## 八、测试计划（tests/test_tools.py，45 用例，全 mock 不真实联网）

| 组 | 用例 |
|---|---|
| SSRF（16） | 127.0.0.1 / 10.x / 192.168.x / 172.16.x / ::1 / fe80:: / fc00:: / [::ffff:127.0.0.1] / 64:ff9b:: / localhost（双栈 v6 在前）/ 0x7f000001 / 2130706433 / 127.1 简写 / 双栈域名（mock getaddrinfo 返回 v4+v6 混合，任一内网即拒）/ userinfo 绕过（https://google.com@127.0.0.1）/ **DNS Rebinding（mock getaddrinfo 首次返回公网 IP、连接时若二次解析则返回内网 → 断言实现无二次解析，直接连接钉扎 IP）** |
| 重定向（5） | 相对路径 Location（../c 形态 urljoin 边界）/ 重定向目标为内网（逐跳拦截）/ 跳数超限（>5 跳）/ 每次跳转后重新校验 / **重定向到 file://、ftp:// 协议拒绝** |
| 协议（2） | file:// 拒绝 / ftp:// 拒绝 |
| 响应（6） | 2MB 截断（Content-Length）/ **chunked 编码无 Content-Length 时累计 2MB 中断** / 慢响应超时 / GBK 页面（gb18030 解码）/ 非文本 Content-Type（application/octet-stream）→ 拦截提示 / 错误 Content-Type 头（写 utf-8 实际 GBK → 启发式兜底） |
| 提取（7） | article 语义标签 / 无语义标签 body 兜底 / script 移除 / 4000 截断标记 / JS 渲染特征命中 / 语义标签有实文本不误判 / **HTML 实体解码（&amp; &#x27;）** |
| 反爬（6） | 验证码页（中文）→ 友好提示且不重试 / **英文验证码页（Verify you are human）命中** / Bing 请求级失败切百度 / 预热只调一次 / 退避窗口生效 / Semaphore 并发排队 |
| 沙箱/集成（2） | **配置 workspace 的 Agent 调 web_fetch 正常放行（_validate_workspace 兼容 url）** / **钉扎请求断言（MockTransport 收到的 Host 头 == 原域名、URL host == 钉扎 IP）** |
| DNS 异常（1） | getaddrinfo 抛异常（域名不存在）→ "[错误] 无法解析域名" |

## 九、实施清单

| # | 任务 | 要点 |
|---|---|---|
| 1 | core/fetcher.py | httpx client（follow_redirects=False，10s/5s，连接池 10/5）+ SSRF 全校验 + **IP 钉扎连接（P0，URL 改写 + Host 头 + sni_hostname）** + 移动端 UA + 2MB 流式累计中断 + gb18030 启发式编码 |
| 2 | core/extractor.py | 标题 + 语义标签正文提取 + html.unescape + 4000 截断 + JS 渲染检测 |
| 3 | core/search.py | Bing 主 + 百度兜底（多选择器）+ 预热/随机延迟/退避 + 中英文验证码检测 + Semaphore 5 |
| 4 | tools/builtin.py | 注册 web_fetch / web_search，permissions=["network"] |
| 5 | core/llm.py:442 | target_str 加 url 字段（1 行） |
| 6 | config/agents.json | Elysia 加 sandbox_override.auto_approve_tools |
| 7 | tests/test_tools.py | 45 用例全 mock（含 DNS Rebinding 钉扎断言、沙箱 workspace 兼容、Host 头断言） |
| 8 | docs/BUGS.md | 新增 BUG-033 |

建议实施顺序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

## 十、参考资料（废案复用资产）

- `D:\tool\setting serve\app\browser.js`：Bing/百度搜索结果解析器（:48-83）、反爬节奏经验（预热/随机延迟/验证码检测 :314-350）
- `D:\tool\setting serve\app\server.js`：反爬头模板（:371-386，需按移动端 UA 修改）、手动重定向链（:388-399）
- 注意：废案无 SSRF 防护，仅复用解析逻辑与节奏，防护按本方案第四节重建

---

## 十一、实施关注点（坑位清单）

> 性质：以下为实施时的**建议与关注项**，非强制决策。`[关注]` = 必须注意的行为，`[建议]` = 倾向性意见可自行斟酌。

### A. 沙箱/配置

1. **[关注] workspace 校验误杀 web_fetch**：`_validate_workspace`（sandbox.py:726-757）字段提取不认识 `url`，且 workspace 隔离检查在 grant_permission 最前（:434，早于 auto_approve_tools 短路）。配置了 workspace 的 Agent 调 web_fetch 时 target_str 为纯 URL 字符串，被当路径 resolve 必然拒绝。修复建议见第七节第 5 条（`_validate_workspace` 加 url 字段识别并放行）
2. **[关注] 白名单配置生效时机**：改 agents.json 后需重启 server + CLI（两个进程独立执行 load_agent_sandbox_configs，仅启动时加载）

### B. IP 钉扎（实施顺序最先碰）

3. **[关注] HTTPS 证书校验**：URL 改为 IP 后 httpx 按 IP 校验证书必挂 → 必须 `extensions={"sni_hostname": 原域名}`（httpx 0.27 支持，官方 DNS 钉扎示例同款）。验收标准：实测 `https://www.baidu.com` 成功
4. **[关注] Host 头与 vhost 路由**：Host 必须是原域名（否则 CDN/共享主机返回 403/默认页）；httpx 自动生成 Host 头与显式传入的覆盖行为随版本有差异 → 必须加断言测试（第八节沙箱/集成组已含）
5. **[关注] IPv6 钉扎 URL 构造**：不要字符串拼接，用 `urlunsplit`，`netloc = f"[{ip}]" + (f":{port}" if port else "")`；原 URL 的端口不能丢
6. **[建议] 重定向 urljoin 的 base**：用当前实际请求 URL（IP 改写版），保持一致，避免调试心智混乱

### C. 流式/超时

7. **[关注] 2MB 中断后连接释放**：`async for` 中途 break 不保证关闭连接 → 显式 `await resp.aclose()`；用 `aiter_bytes` 逐块累计字节（勿用 aiter_text，编码后字节数不可控）
8. **[关注] httpx 超时语义**：`Timeout(10.0, connect=5.0)` 的 read 是"块间空闲超时"非总时长，慢速流可无限拖；要严格总时长需 `asyncio.wait_for` 包裹整个读取
9. **[关注] 检查顺序**：4xx/5xx 直接返回错误（错误页勿当正文提取）；验证码检测在状态码检查后、解析前（验证码页通常 200）

### D. 反爬

10. **[关注] 预热并发安全**：预热"只调一次"的标记在 `await` 前设置（防模型并行 tool_calls 触发双重预热）；随机延迟不跳过第一次请求
11. **[建议] 结果页边界**：Bing 无结果时无 `li.b_algo` → 返回 `[未找到相关结果]` 而非空列表；结果 URL 去跳转包装（`/url?q=` 类）

### E. 提取

12. **[关注] 解码顺序**：头部 charset → utf-8 **strict**（防 GBK 字节流恰好"合法" utf-8 出乱码）→ gb18030（`errors="replace"` 兜底）
13. **[建议] 标题清洗**：strip + 压缩空白；`html.unescape` 在 `get_text()` 之后执行（bs4 的 get_text 不解实体）
14. **[建议] DOM 解析库**：requirements.txt 无 beautifulsoup4，建议新增（html.parser 后端即可，不用 lxml）；手写标准库 html.parser 不推荐

### F. 测试

15. **[关注] mock 位置**：getaddrinfo 需 patch `core.fetcher.socket.getaddrinfo`（fetcher 模块内引用处），DNS 异常抛 `socket.gaierror`
16. **[关注] httpx mock 用 MockTransport**：钉扎断言的正主路径——MockTransport 收到的 `request.url` 中 host 应为钉扎 IP、Host 头应为原域名

---

## 十二、真机验证记录（落地后，2026-08-14）

> 性质：实施后真机验证发现的问题与修复建议，由用户验证、修缮后回填结论。

### 12.1 BUG-034 候选：Bing 正常结果页被误判为验证码（实锤）

> ✅ 已修复（2026-08-14）：`_is_captcha` 改可见文本检测（`get_text()`）+ 判定顺序改为「先解析结果 → 无结果才验验证码」。测试 +3（正常页含 powchallengesolver → 返回结果；真验证码页 → 仍返回文案）。47→48 用例全绿。

**现象**：真机对话问"你会联网搜索吗？你试下"→ Slime 返回"搜索引擎服务需要人机验证"（工具实际返回 `_CAPTCHA_MSG`，Agent 转述）。

**诊断证据**（真实抓包）：
- 直抓 `https://cn.bing.com/search?q=test`（移动 UA）→ **200 正常结果页**，解析出 5 条 `li.b_algo`
- 全文搜索 `challenge` 命中 1 处，上下文为 `<script>` 资源清单：`powchallengesolver`（Bing 正常页面自带的 JS 文件名，Power Challenge Solver 遥测组件）
- BeautifulSoup `get_text()` 提取可见文本后：`challenge` / `验证码` **均不存在**

**根因**：`_is_captcha`（search.py:103-105）对**整段 HTML 做子串匹配**，脚本文件名里的 `challenge` 触发误报，真实搜索能力被文案阻断。

**修复建议**（供验证修缮）：
1. `_is_captcha` 改为**可见文本检测**：BeautifulSoup `get_text()` 后再匹配关键词（验证码特征必显示在可见文本，脚本/注释不参与）
2. 判定顺序调整（Bing/百度同改）：**先解析结果** → 有结果直接返回；无结果时才做验证码检测（真验证码页必然无结果，双保险）→ 无验证码特征才返回 `[未找到相关结果]`
3. 关键词表保留不动（可见文本检测下 `challenge` 等无碍）
4. 测试 +2 例：正常结果页 + script 含 `powchallengesolver` → 返回结果（45→47）；真验证码页（无结果 + 可见文本含关键词）→ 仍返回验证码文案
5. 现有 2 个验证码用例不受影响（测试 html 可见文本即关键词）

### 12.2 遗留观察项（非阻塞，暂不处理）

1. **keepalive 连接 SNI 串扰**（fetcher.py）：连接池按 (scheme, IP, port) 复用，同一 IP 上多域名（SNI 虚拟主机）时，第二个请求沿用第一个的 TLS 会话，证书身份与实际域名可能不对应。多数公网站点单证书/泛证书无感，属已知局限。后续若遇"同 IP 多证书站点报错/错证书"，需按 (IP, sni_hostname) 拆分连接或禁 keepalive
2. **截断边界**（extractor.py:81-83）：截断作用于"标题+正文"拼接结果而非正文，标题极长时正文配额被挤占。实际影响可忽略

---

## 十三、浏览器交互增强（MCP 接入方案，2026-08-14 评估）

> 性质：**可选增强**。web_fetch/web_search 覆盖"只读抓取+搜索"，本方案补"交互式浏览器操作"（点击/输入/登录/截图/JS 执行），可解决 JS 渲染站（六.6 提示"需浏览器渲染"）与验证码拦截（五.4）两类能力缺口。
> 前提：slime 已有 MCP 客户端（core/mcp_client.py，stdio + Streamable HTTP），工具桥接为 `mcp_` 前缀注册进 ToolRegistry，走沙箱审批，**零 Python 代码改动**即可接入外部浏览器 MCP Server。

### 13.1 三包评估结论（已核实源码与本地环境）

| 包 | 版本 | 性质 | 结论 |
|---|---|---|---|
| `D:\下载\playwright-mcp-0.0.78` | 0.0.78 | 微软官方 **stdio MCP Server**（node cli.js，Apache-2.0） | ✅ **首选**：node_modules 完整、Node v24.18 满足 engines(>=18)，`cli.js --help` 实测可运行；slime.toml 加一条配置即可 |
| `D:\下载\agent-browser-0.34.0` | 0.34.0 | Vercel **stdio MCP Server**（Rust 原生二进制，`agent-browser mcp`，Apache-2.0） | ⚠️ **备选**：typed tools + profiles（core/network/tabs/react）+ `allowedDomains` 域名白名单（天然贴合沙箱），但 bin/ 仅 wrapper，需 postinstall 下载预编译二进制（离线不可行）/ cargo 编译（需 MSVC 工具链），Node 需 ≥24（已满足），协议默认 2025-11-25 |
| `D:\下载\browser-use-0.13.6` | 0.13.6 | Python **AI Agent 框架**（自带 agent loop + 自有 LLM 配置，非 MCP Server，包内仅有 mcp client） | ❌ **不建议**：与 slime 架构重叠（双 agent 嵌套，身份/记忆/沙箱全绕过）；依赖 30+ 固定版本重包；要求 Python >=3.11（slime 为 3.10+） |

### 13.2 playwright-mcp 接入步骤（首选方案）

1. **slime.toml** 添加 MCP Server（server 重启即自动连接，见 slime_server.py:294-312）：

```toml
[[mcp_servers]]
name = "browser"
command = "node"
args = ["D:\\下载\\playwright-mcp-0.0.78\\cli.js"]
```

2. **首次安装浏览器二进制**（~170MB，一次性）：

```
node "D:\下载\playwright-mcp-0.0.78\cli.js" install-browser
```

3. **验证链路**：启动 server → `GET /mcp/servers` 看连接状态（成功即注册 `mcp_browser_navigate` / `mcp_browser_click` / `mcp_browser_type` / `mcp_browser_snapshot` / `mcp_browser_screenshot` 等工具）→ 对话实测让 Agent 导航/点击/截图
4. **沙箱**：浏览器工具可访问任意 URL，属 L2+ 级。按需在目标 Agent 的 `sandbox_override.auto_approve_tools` 加 `mcp_browser_*`，或保持审批流（无白名单必拒，见七.3）

### 13.3 风险点

1. **[已解决] 协议协商 + stdio 帧格式**：playwright-mcp 0.0.78 用新版 stdio 换行分隔 JSON（`{json}\n`），与 slime 原 Content-Length 帧不兼容（握手 30s 超时）。已升级 mcp_client：协议 2025-11-25 + 双帧格式自动嗅探（JSONL 默认 / Content-Length 回退），实测握手成功发现 24 个浏览器工具，无需降级
2. **[关注] 浏览器二进制**：安装需联网下载 Chromium；离线环境不可用
3. **[关注] 会话隔离**：多个 Agent 共享一个 MCP Server 进程 = 共享浏览器会话，页面状态互相可见；需要隔离时用独立 `[[mcp_servers]]` 条目（不同 name）或后续给 mcp_client 增加 per-agent 会话参数
4. **[建议] 上下文占用**：`browser_snapshot` 返回 DOM 可访问性树，体积大，注意 max_context 占用；偏好用带 `ref` 的精简 snapshot 或截图
5. **[建议] 备选时机**：agent-browser 的 allowedDomains 白名单比 playwright-mcp 的 `--allowed-hosts` 更贴合 slime 沙箱语义，网络恢复后可作二期增强

---

## 十四、统一执行清单（迭代二，2026-08-14）

> 性质：可观测性修复 + JS 渲染站能力缺口。A 组 P0 必做，B 组二选一。逐项完成后回填 ✅。
> 背景：真机验证暴露三问题——① 思考内容不展示（双层原因：show_thinking=off + 思考字段只认 reasoning/thinking，漏 `reasoning_content`）；② 工具中间过程零展示（无法判断 Agent 在哪个环节出错）；③ 工具轮次撞上限（`[工具调用轮次已达上限]`，主因是 JS 渲染站抓不到内容 → 模型反复换 URL 重试 → 3 轮耗尽）。

### 14.1 A 组：可观测性修复（P0）

> ✅ 全部已实现（2026-08-14），测试 +6（54 网络工具用例），全量 293 绿。

| # | 项 | 位置 | 改动要点 | 验收标准 |
|---|---|---|---|---|
| A1 | 通用思考提取 | llm.py:550、936（流式两处）；:501（非流式 message 层顺带） | 新增 `_extract_reasoning(delta, chunk)`：按 `reasoning_content` → `reasoning` → `thinking` 三字段全取 + chunk 顶层兜底，替换现有两处 `delta.get("reasoning") or delta.get("thinking")` | 各模型思考内容均能 yield 为 `{"type":"reasoning"}` 事件 |
| A2 | show_thinking 开启 | agents.json:33 | `"off"` → `"on"`（或 CLI `/show_thinking` 切换，命令已存在 slime_cli.py:2424） | 真机对话可见思考 Panel / 灰斜体 |
| A3 | 工具中间过程可视化 | core/llm.py `_execute_pending_tools`（:428-473）；`_handle_tool_calls_stream`（:513-575）；slime_cli.py:1309；slime_server.py:841 | 见 14.1.1 详述 | 每次工具调用在正文前显示 `工具名(参数) → 结果摘要` |
| A4 | 超限文案增强 | llm.py:509-510（非流式）、574-575（流式） | `[工具调用轮次已达上限]` 附 3 轮工具链摘要 | 撞上限时直接看出每轮卡点 |
| A5 | 测试 +4 例 | tests/test_tools.py | 三字段各取到、chunk 顶层兜底、tool 事件流、超限文案含摘要 | 全绿 |

#### 14.1.1 A3 详述（工具过程可视化）

**思考字段覆盖矩阵**（A1 依据）：

| 字段 | 使用方 |
|---|---|
| `reasoning_content` | DeepSeek R1、Qwen、Kimi K2、智谱 GLM-Z1、Ollama、llama.cpp（本地 Qwen 3B）、vLLM、百度文心 |
| `reasoning` | OpenAI o1/o3、xAI Grok |
| `thinking` | Gemini（OpenAI 兼容层）、Anthropic（兼容层） |

部分聚合网关（one-api/new-api 类）把思考字段放到 `choices[0]` 之外的 **chunk 顶层**，故 `_extract_reasoning` 需同时查 `delta` 与 `chunk` 两层。

**实现步骤**：
1. `_execute_pending_tools` 改为收集并返回明细列表 `[(tool_name, args_str, result_head)]`（result 截断 ~200 字），不再只 append 到 messages（messages 逻辑保留）
2. 流式路径 `_handle_tool_calls_stream`：每轮 `_execute_pending_tools` 后，对每条明细 `yield {"type": "tool", "name": ..., "args": ..., "result": ...}`
3. 非流式路径 `_handle_tool_calls`：明细并入 A4 的超限文案；正常结束不需要
4. CLI（slime_cli.py:1309 附近）新增 `"tool"` 事件分支：正文开始前按序输出，样式建议缩进 + 工具名高亮 + `args` 单行 + `result` 前 200 字折叠（与 `"reasoning"` 缓存 Panel 同队列，保证顺序）
5. server（slime_server.py:841 附近）同步透传 `"tool"` 事件字段（WebSocket/SSE 客户端即可见）

**A4 文案格式示例**：

```
[工具调用轮次已达上限（3 轮）]
第1轮: web_fetch(url=https://deepseek.com/) → [该页面需浏览器渲染，无法获取内容]
第2轮: web_search(query=DeepSeek 定价) → 1. DeepSeek API 定价 2. ...
第3轮: web_fetch(url=https://platform.deepseek.com/pricing) → [该页面需浏览器渲染，无法获取内容]
```

### 14.2 B 组：JS 渲染站能力缺口（P1，二选一）

#### B1 轻量方案（不动 MCP）

> ✅ 已实现（2026-08-14）：`_extract_js_data` 从 `__NEXT_DATA__`/`__INITIAL_STATE__`/`__NUXT__` 递归提取文本，测试 +2。

1. **extractor.py 增强**：`_is_js_rendered` 判定为 JS 站后，先尝试从初始数据提取正文：
   - `<script id="__NEXT_DATA__">` → JSON 解析 → 递归遍历 `props.pageProps` 收集文本
   - `__INITIAL_STATE__` / `__NUXT__` 同法（JSON 值递归提取字符串，拼接去噪）
   - 提取成功 → 输出正文（走原有 4000 截断）；失败 → 保留现有 `[该页面需浏览器渲染，无法获取内容]`
2. **web_fetch 描述提示**（builtin.py:156）：description 加"SPA/JS 渲染站可能无法获取正文，请勿对同一站点重复尝试抓取"
3. 验收：真机抓 `https://deepseek.com/`（或任意 __NEXT_DATA__ 站）能出正文；无数据的 JS 站仍走原文案

#### B2 MCP 浏览器方案（推荐，覆盖 JS 渲染 + 真验证码 + 点击/登录/截图）

1. 接入步骤见**第十三节 13.2**（slime.toml 配置 → install-browser → 验证 /mcp/servers → 沙箱白名单 `mcp_browser_*` 或审批流）
2. 风险对照**第十三节 13.3** 五条执行（重点：协议版本握手失败时降级 `npx @playwright/mcp@0.0.58` 附近；多 Agent 共享会话需注意页面串扰）
3. 验收：真机让 Agent "打开 DeepSeek 官网查看定价"→ 导航/点击/截图链路通，不再撞工具上限

> 二选一建议：**选 B2**——一步补齐两类缺口（JS 渲染 + 真验证码拦截），B1 留作未来无浏览器环境降级；若 B2 协议握手失败且降级无效，退回 B1。

### 14.3 已关闭与观察项

- ✅ **BUG-034**（12.1）已修复：`_is_captcha` 可见文本检测 + 先解析后验验证码，测试 48 例全绿（2026-08-14）
- 观察（暂不处理）：12.2 SNI 串扰、截断边界

### 14.4 执行前待确认

1. **A2**：show_thinking 直接改 agents.json，还是保持 CLI 切换？（建议直接改 on）
2. **模型类型**：deepseek-chat（无思考字段，A1 展示了也是空）还是 deepseek-reasoner（有思考）？决定 A 组实际观感
3. **B 组**：B1 还是 B2？（建议 B2）