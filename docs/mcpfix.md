# MCP 客户端优化方案（mcpfix）

> 状态：方案定稿，待实施。由用户按批次实施，完成后回填 ✅。
> 日期：2026-08-14
> 范围：`core/mcp_client.py` 为核心，涉及 `slime_server.py` / `slime.toml` / `tests/test_mcp.py`。
> 原则：**零新依赖**，保留自研传输抽象（`_Transport` → `_StdioTransport` / `_HTTPTransport`），分批落地，每批独立可验证。

---

## 一、现状基线（已完成 ✅）

| 能力 | 状态 | 说明 |
|---|---|---|
| 双帧 stdio（JSONL / Content-Length） | ✅ | `_serialize` 双格式；`_read_response` 首字节嗅探自动分流（`{`=JSONL，`C`=Content-Length） |
| 握手自愈 | ✅ | `start()` 默认 JSONL，5s 短超时探测失败 → `flip_framing()` → 重启子进程重试（重启避免旧输入缓冲污染） |
| 协议版本 | ✅ | 2025-11-25（SDK LATEST，旧 server 协商下调） |
| 验证 | ✅ | 全量 298 passed（+5 帧格式用例）；playwright-mcp 实测握手成功，发现 24 个 browser_* 工具；resources/prompts 缺失时 Method not found 容错（预期） |
| Chromium | ✅ | chromium-1232 匹配 playwright-core 1.62.0-alpha，无需 install-browser |
| 配置 | ✅ | slime.toml `[[mcp_servers]] browser` 已启用；search_engine.md 13.3 风险 1 已标「已解决」 |

---

## 二、剩余问题清单（按优先级）

### P0 — "接不上/功能残缺"的深层原因

| # | 问题 | 现状机制（mcp_client.py 行号） | 后果 |
|---|---|---|---|
| P0-1 | **stdio 无后台读循环** | `request()` 每次 `asyncio.to_thread(self._read_response)` 同步读一帧（:110-130），读完即返回 | server 先发 notification（logging/进度/tools 变更，无 id）再发响应：首帧无 id → :366 丢弃 → 真响应被下一个请求错读 → **必失败/错配** |
| P0-2 | **stderr 从不读取** | `Popen(stderr=PIPE)`（:84）但无人消费 | server 打日志写满 64KB 管道缓冲 → 子进程阻塞假死 → 全部请求超时断连 |
| P0-3 | **HTTP 不支持 202 Accepted / SSE 长流** | `request()` 用 `client.post()` 等完整 body（:237-252），SSE 一次性 `resp.text` 解析 | 规范允许 POST 返回 202（异步处理中）或 SSE 长开（keep-alive）→ httpx 等到超时 → 失败 |
| P0-4 | **image/audio content 丢弃** | `_content_to_text` 只认 text/resource（:417-427） | **playwright-mcp `browser_screenshot` 返回 image → slime 拿空**，截图能力废 |
| P0-5 | **RPC 错误细节丢失** | `_request` 遇 error 直接 return None（:369-371） | 上层只显示"服务无响应"，无法诊断（参数错/未实现/鉴权失败全不可见） |

### P1 — 健壮性

| # | 问题 | 现状 | 影响 |
|---|---|---|---|
| P1-1 | 30s 硬超时 + 超时即 kill | :123-126 `asyncio.wait_for` 超时后 `close()` 断连 | 浏览器/重型工具（>30s）必被砍，且断后 `running=False` 永久失联 |
| P1-2 | `notify` 无写锁 | :195-202 不持 `self._lock` | 与 `request` 并发写 stdin → 帧交错损坏 |
| P1-3 | `tools/list_changed` 不处理 | 无通知分发机制 | server 动态加工具后列表陈旧 |
| P1-4 | 响应体 10MB 直接失败 | :162-164 / :186-188 超限 return None | browser_snapshot 大响应直接丢 |

### P2 — 工程化增强

| # | 问题 | 影响 |
|---|---|---|
| P2-1 | server 崩溃后无自动重连 | 进程崩/重启后工具永久失联，需重启 slime |
| P2-2 | `start_all` 串行（:454-460） | 一个 server 启动慢拖累全部 |
| P2-3 | MCP 工具一刀切 `permissions=["network"]`（:534） | 文件/数据库类 MCP 权限语义不对，无法按 server 配置 |
| P2-4 | 多 server 同名工具静默覆盖 | 后者覆盖前者 `_tool_map`，工具丢失无提示 |
| P2-5 | 无 OAuth（远程 HTTP server 门槛） | 受保护远程 MCP（GitHub/Figma 类）全部拒绝 |

---

## 三、分批执行方案（A 档：保留自研改造）

### 批 1：stdio 后台读循环 + 错误细节（P0-1、P0-2、P0-5、P1-2、P1-4）✅ 已落地

> ✅ 批1 完成（2026-08-14）：后台 reader 循环 + stderr drain + 写锁 + `_MCPServerError` 错误透传 + 超限帧排空（保留 10MB 安全上限，超限排空不返 None 防流错位）。全量 **301 passed**（+3 FakeServer 子进程用例）。实测 playwright-mcp 握手成功（24 工具，`resources/prompts` Method not found 容错）；浏览器侧需 `--browser msedge`（Edge 替代未安装的 Chrome，slime.toml 已配）。

#### 1.1 后台 reader 循环（核心重构）

`_StdioTransport` 改造：

```python
class _StdioTransport(_Transport):
    def __init__(...):
        ...
        self._pending: dict[int, asyncio.Future] = {}   # req_id → future
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._read_lock = asyncio.Lock()                # 写 stdin 统一锁（request+notify 共用）
```

- `start()`：启动两个后台 task——
  - `_reader_loop`：`while running: frame = await asyncio.to_thread(self._read_frame); 分发`。单线程独占读，天然无读竞争
  - `_stderr_drain`：`while running: line = await asyncio.to_thread(proc.stderr.readline)` → `logging.debug`（不打印也行，关键是消费管道）
- **帧分发**（reader 拿到 dict 后）：
  - 有 `id` 且 `id in self._pending` → `future.set_result(frame)`（匹配响应）
  - 有 `id` 但不在 pending（迟到/丢弃响应）→ `logging.warning` 丢弃
  - 无 `id`（notification）→ 事件分发：先 `logging.info`，预留回调钩子（P1-3 用）
- `request()` 改为：
  ```python
  fut = loop.create_future()
  self._pending[req_id] = fut
  async with self._read_lock:
      stdin.write(...); stdin.flush()
  try:
      return await asyncio.wait_for(fut, timeout=timeout)
  except asyncio.TimeoutError:
      self._pending.pop(req_id, None)      # 超时不 kill 进程（P1-1 缓解）
      raise FetchError(...) / return None
  ```
- `notify()`：同样走 `_read_lock` 写帧（P1-2 修复）
- `close()`：取消两个 task + 清 pending（对每个 future `set_exception`/取消，防泄漏）
- `_read_response` 方法保留改名 `_read_frame`（组合 `_read_jsonl`/`_read_content_length` 的逻辑），**`_serialize`/`_read_jsonl`/`_read_content_length` 签名不动**——兼容现有测试（TestStdioFraming 直接调用这些方法）

#### 1.2 错误细节透传（P0-5）

- 定义 `class _MCPServerError(Exception): def __init__(self, code, message)` 
- `_request` 遇 error：`raise _MCPServerError(resp["error"]["code"], resp["error"]["message"])`
- 各调用点容错：
  - `call_tool` / `read_resource` / `get_prompt`：`except _MCPServerError as e: return f"[MCP] 工具 '{x}' 调用失败: {e.message} (code={e.code})"`
  - `start()` / `_discover()`：`try/except _MCPServerError: return None/跳过`（保持容错语义不变）
- `_request` 返回 None 的既有语义保留给"传输层失败"，error 走异常——调用点区分"服务拒绝"与"连不上"

#### 1.3 响应体超限改截断（P1-4）

- `_read_jsonl`：超限时**不 return None**，截断到 `_MAX_RESPONSE_BYTES` 后尝试 `json.loads` 失败则返回 None（保持简单：记 warning + None 可接受，注明即可）
- 或：超限只记 warning，照常读完（大 snapshot 场景）。**决策点**：倾向后者（读完 + warning），见第五节

#### 1.4 验收

- 新增测试：FakeServer 子进程（Python 脚本：收到 initialize 后**先发一条 notification** 再回响应）→ 握手成功、调用不错配
- 新增测试：子进程向 stderr 写 200KB 日志后仍能正常响应（stderr drain 生效）
- 新增测试：request 超时后进程**仍 running**（不再 kill）
- 回归：298 用例全绿

### 批 2：HTTP 流式 + 截图内容 + 超时可配（P0-3、P0-4、P1-1）✅ 已落地

> ✅ 批2 完成（2026-08-14）：image/audio/video 落盘（`_content_to_text` 改实例方法 + `_save_media`，`data/mcp/{server}/` sha256 前16位+mimeType 后缀，同内容去重，>10MB 跳过）；超时可配（`_MCPServer._timeout` + `add_server(timeout)` + slime.toml `timeout`）；HTTP SSE 流式简单档（`client.stream` 逐行读命中 id 即返回，`_parse_sse` 保留）。全量 **309 passed**（+8 用例）。202 完整档延后。

#### 2.1 HTTP 202 / SSE 流式（P0-3）

`_HTTPTransport.request` 改造（两档，先做简单档）：

- **简单档**：`client.post` 换 `client.stream`——`async with client.stream("POST", ...) as resp`：若 `content-type` 含 `text/event-stream` → `resp.aiter_lines()` 逐行边读边解析，命中 `id == req_id` 即返回（**不等完整 body**，长开 SSE 也能拿到响应）；否则 `await resp.aread()` 后 `resp.json()`
- **完整档**（可选）：POST 返回 `202 Accepted`（无 body）→ 发 `GET` 同 URL（`Accept: text/event-stream`）打开 SSE 流，等待匹配 id（带超时）；规范上 202 表示处理中，响应经后续通道送达。实现量 ~40 行，建议批 2 末尾做
- `_parse_sse` 保留供一次性文本场景，流式走新路径

#### 2.2 image/audio content（P0-4）

`_content_to_text` 增加分支：

```python
elif isinstance(item, dict) and item.get("type") == "image":
    data = base64.b64decode(item.get("data", ""))
    path = _save_media(data, "png")          # data/mcp/{server}/{hash}.png
    parts.append(f"[图片: {path}]")
elif item.get("type") in ("audio", "video"):
    ...同法保存...
```

- 保存目录：`data/mcp/{server_name}/`，文件名 = 内容 hash 前 16 位 + mimeType 后缀（自动去重）
- `mimeType` 缺省映射：image→png / audio→bin / video→bin
- 大小护栏：单文件 > 10MB 不落盘，返回 `[图片过大，已跳过]`
- 超限返回：`[图片已保存: {abs_path}]` 让 Agent 提示用户查看；**决策点**：是否同时附 base64 预览（不推荐，占 context）

#### 2.3 超时可配（P1-1）

- `add_server(..., timeout: float = 30.0)`；`_MCPServer` 存 `self._timeout`，`_request` 用 `self._timeout`
- slime.toml：`[[mcp_servers]]` 增加 `timeout = 60` 可选字段；slime_server.py:302 透传
- 超时语义调整（批 1 已改为不 kill）：stdio 超时仅丢弃 pending；HTTP 超时仅关闭本次请求

### 批 2 审查发现（批 1/2 落地后复核，2026-08-14）

> 批 1/2 已实现（后台 reader 循环、stderr drain、超时不 kill、错误透传、HTTP 流式简单档、媒体落盘、超时可配，测试已补）。复核发现以下问题：

| # | 严重度 | 问题 | 位置 | 修复 |
|---|---|---|---|---|
| 1 | **真问题，建议立即修** | **HTTP SSE 可能无限挂起**：httpx 的 read 超时是"块间空闲超时"——server 定期发 SSE keep-alive ping（`:` 注释行）时，`async for line in aiter_lines()` 永不退出，请求永久挂起 | mcp_client.py:342-363 | 整个 SSE 等待循环用 `asyncio.wait_for(..., timeout)` 包裹（超时返回 None，与 stdio 超时语义一致）。测试 +1：server 只发 ping 不发响应 → 超时返回 None 且不抛异常 |
| 2 | 小 | `_save_media` 目录名未 sanitize：`data/mcp/{self.name}`，server name 含 `..`/特殊字符可路径逃逸 | :599 | 目录段仅保留 `[A-Za-z0-9_-]`，其余替换为 `_`；批 3 顺手修 |
| 3 | 实施约束 | `_dispatch` 通知回调为**同步调用**（:203-207），若回调阻塞会卡死读循环 | :203 | P1-3 实现 list_changed 刷新时，回调必须 `asyncio.create_task` 异步化 |
| 4 | 延后确认 | 202 Accepted 未处理（决策点 2 已确认延后）；目前 202 无 body → `resp.json()` 失败 → 返回 None，容错安全 | :364 | 保持延后 |
| 5 | 观察项 | `_reader_loop` 异常 break 后传输死亡但 `running` 仍 True（:163-165），后续 request 写 stdin 无人读 → 全部超时 | :158-173 | P2-1 自动重连覆盖：以 reader EOF/异常为触发信号 |

> ✅ 批3 落地后回填：问题1/问题2 已修；问题3（回调异步化）随 P1-3 落地、问题5（reader 死亡触发）随 P2-1 落地；问题4（202）保持延后。

### 批 3：工程化（P1-3、P2 全项，可选）✅ 已落地

> ✅ 批3 完成（2026-08-14）：问题1（SSE wait_for 兜底）+ 问题2（media 路径 sanitize）+ P2-3 权限映射 + P2-4 冲突后缀 + P1-3 list_changed 通知分发（回调 `create_task` 异步化）+ P2-1 自动重连（reader EOF/异常触发，指数退避 1→60s，`last_error`）+ P2-2 start_all 并发。全量 **321 passed**（+12 用例）。P2-5 OAuth 已于批 4 落地（见下方）。

| # | 改动 | 要点 |
|---|---|---|
| P1-3 | 通知事件分发 | reader 循环的 notification 分支挂回调：`tools/list_changed` → **`asyncio.create_task` 异步化**（审查发现 3）→ 重新 `_discover()` + 重注册工具（先 `_unregister_tools` 再 `_register_capabilities`） |
| P2-1 | 自动重连 | reader 读到 EOF/异常（审查发现 5 为触发信号）→ `_MCPServer` 置 `running=False` → MCPClient 侧 task 指数退避（1s/2s/4s…上限 60s）重启 + 重新握手 + 重注册；`status()` 暴露 `last_error` |
| P2-2 | start_all 并发 | `asyncio.gather(*(s.start() for s in ...))` + 每 server 独立超时（`asyncio.wait_for` 60s），单 server 卡死不拖累 |
| P2-3 | per-server 权限映射 | `add_server(..., tool_permissions: dict[str, list[str]] | None)`——`{"default": ["read"]}` 或按工具名；桥接时 `permissions=tool_permissions.get(name, tool_permissions.get("default", ["network"]))`；非法权限值（不在 read/write/terminal/network）→ warning + 回退默认；resources/prompts 仍固定 read；slime.toml 对应字段 + slime_server.py:302 透传 |
| P2-4 | 工具名冲突 | `_register_capabilities` 检测 `_tool_map` 已有 slime_name → warning + 后缀 `_2` 再冲突 `_3` |
| P2-5 | OAuth（仅远程场景） | 独立 `core/mcp_oauth.py`：MCP 2025-11-25 授权规范（OAuth 2.1 + PKCE S256 + RFC 9728/8414/7591/8707），详见下方批 4 方案 |

> 建议执行顺序：**问题 1（SSE wait_for）→ P2-3 → P2-4 → P1-3 → P2-1 → P2-2 → P2-5**
>
> **P2-5 已定稿（2026-08-14，经安全审查 + 方案审查两轮修正）**，待实施。以下为完整方案。

### 批 4：OAuth 2.1 远程授权（P2-5）✅ 已落地

> ✅ 批4 完成（2026-08-14）：`core/mcp_oauth.py`（TokenStore / OAuthDiscovery / OAuthRegistration / OAuthFlow / OAuthManager）+ `mcp_client.py` 集成（`_headers()` 静态 token 优先级、401 → `ensure_token` → 重试一次、`start()` warmup 预热、start_all/start_one 对 oauth server 外壳放宽 360s、`status()` 增加 oauth 字段、call_tool「未授权」提示）+ slime_server.py / slime.toml 透传。全量 **344 passed**（+21 用例，含回调服务器真实现）。
>
> 方案外修正（实施时发现，按全局风格改进）：
> - **重启后 refresh 需 token_endpoint**：TokenStore 持久化补充 `token_endpoint`/`resource`/`client_secret`（方案原字段清单缺失，重启后 refresh 无从发起）。
> - **后台授权任务自吞异常**：`_do_authorize` 全兜底（`CancelledError` 除外），防收尾观察项 1 的「未检索任务异常」在 `_pending_auth` 上复现。
> - **无 oauth 配置 401 保持旧语义**：body 解析透传 `_MCPServerError`（方案写「返回 None（兼容）」与现状不符——现状是错误体透出可诊断，已按现状修正，测试亦按此写）。
> - **`ensure_token` 的 await 包 `wait_for(timeout)`**：慢授权（浏览器 240s）不无限阻塞本次请求；任务靠 `shield` 独立存活，下次请求即成功（方案意图，补上界）。
> - **warmup 失败关闭 transport + `_HTTPTransport.start()` 重建 client**：server 不启动（方案语义），且可经 `/mcp/servers/{name}/start` 重触发 warmup，无死端。
> - 测试 21 个（方案 18 个 + 3 补充：回调服务器全链路实测、warmup 失败语义、warmup 成功注入 token）。
>
> 验收状态：标准 2/3/4/5/6/7/8/9/10 ✅（mock 覆盖）；**标准 0/1 ⏸ 待真机验证**（需一个真实 OAuth 保护的 MCP server，如 GitHub MCP 远程 OAuth 版）。

#### 当前基线

| 组件 | 状态 |
|---|---|
| `_HTTPTransport` | ✅ Streamable HTTP、POST + SSE、Mcp-Session-Id、`extra_headers` 透传 |
| `_HTTPTransport.request()` | ✅ 401 时 `httpx.HTTPError` → `return None`（无重试/无 token 刷新） |
| `add_server(url, headers)` | ✅ 远程 HTTP 可用，但仅支持静态 token（`headers = {Authorization = "Bearer xxx"}`） |
| `slime.toml` | ✅ 已有 `url` + `headers` 字段 |
| OAuth 2.1 客户端 | ❌ 无 |

**缺口**：受保护的远程 MCP Server（GitHub MCP OAuth 版、Figma、Notion 等）无法接入，只能手动粘贴静态 token。

#### 新增文件：`core/mcp_oauth.py`

整体架构（零新依赖，纯 httpx 自研）：

```
core/mcp_oauth.py       # OAuth 2.1 客户端
  ├── TokenStore         # token 持久化（内存 + 文件 + sanitize 路径）
  ├── OAuthDiscovery     # RFC 9728 Protected Resource Metadata + RFC 8414 AS Metadata 发现
  ├── OAuthRegistration  # RFC 7591 动态客户端注册（DCR，失败则提示手动输入）
  ├── OAuthFlow          # 授权码 + PKCE S256 + 固定端口回调
  └── OAuthManager       # 门面：完整生命周期（预热授权 + 单飞并发 + refresh + 401 重试）
```

##### 1. TokenStore

```python
class TokenStore:
    """token 持久化：内存 + 文件（data/mcp/{sanitized_name}/oauth.json）。
    Windows 隐藏 + icacls，与 auth_token.json 安全策略一致。"""

    def __init__(self, server_name: str):
        # 路径 sanitize：仅保留 [A-Za-z0-9_-]，与 _save_media 规则一致
        safe = re.sub(r'[^A-Za-z0-9_-]', '_', server_name)
        self._path = _PROJECT_ROOT / "data" / "mcp" / safe / "oauth.json"

    def load(self) -> dict | None
        # 返回 {access_token, refresh_token, expires_at, token_type, scope, client_id, redirect_uri}

    def save(self, tokens: dict) -> None

    def clear(self) -> None
```

##### 2. OAuthDiscovery（RFC 9728 + RFC 8414）

```python
class OAuthDiscovery:
    """两步发现：
    1. 401 WWW-Authenticate 头优先 → 解析 resource_metadata URL
       无则 fallback GET /.well-known/oauth-protected-resource（RFC 9728）
    2. GET /.well-known/oauth-authorization-server（RFC 8414）
       失败 fallback OIDC Discovery（/.well-known/openid-configuration）
    """

    async def discover(self, server_url: str, www_authenticate: str | None = None) -> dict:
        # 返回 {
        #   authorization_endpoint, token_endpoint,
        #   registration_endpoint?,       # DCR 端点（可选）
        #   resource,                     # canonical URI（RFC 9728 resource 字段，优先于 server_url）
        #   scopes_supported?,            # 可选
        # }
```

**关键决策**：`resource` 参数优先取 `/.well-known/oauth-protected-resource` 响应的 `resource` 字段（RFC 9728 明确定义），metadata 无该字段时才回退 server_url。

##### 3. OAuthRegistration（RFC 7591 DCR）

```python
class OAuthRegistration:
    """动态客户端注册。不支持 DCR 的 IdP 跳过，提示用户手动输入 client_id。"""

    async def register(self, registration_endpoint: str, redirect_uri: str) -> dict | None:
        # 返回 {client_id, client_secret?} 或 None（注册失败 → 用户手动输入）
        # application_type = "native"（桌面/CLI 应用，RFC 8252）
        # grant_types = ["authorization_code", "refresh_token"]
        # redirect_uris = [redirect_uri]  ← 固定端口，与后续 authorize 完全一致
```

##### 4. OAuthFlow（授权码 + PKCE S256）

```python
class OAuthFlow:
    """OAuth 2.1 授权码 + PKCE S256 流程。
    
    固定端口回调（默认 18091，可配置）：
    - 启动临时 asyncio HTTP server 监听 127.0.0.1:{port}
    - 回调路由 /mcp/oauth/callback → 提取 code → 关闭临时 server
    - 打开浏览器 → authorize URL
    - 浏览器打开失败 → 打印授权 URL 让用户手动打开（headless 兜底）
    """

    DEFAULT_PORT = 18091

    async def authorize(self, discovery: dict, client_id: str,
                        resource: str, scopes: list[str] | None,
                        redirect_port: int = DEFAULT_PORT) -> dict:
        """返回 {access_token, refresh_token, expires_in, token_type, scope}
        用户取消或超时返回 None"""
```

##### 5. OAuthManager（门面，核心集成点）

```python
class OAuthManager:
    """统一入口，管理 OAuth 完整生命周期。
    
    三层策略：
    - 预热授权（start() 时）：长超时 300s，日志提示"等待浏览器授权"
      start_all 外壳超时 360s（仅 oauth server 放宽，见 mcp_client.py 说明）
    - 快速刷新（request() 401 路径）：refresh 通常 <5s，放得进请求超时
    - 后台授权（刷新失败触发）：create_task 启动独立授权任务，存入 _pending_auth
      调用方可 await 结果（但请求超时取消不杀死授权任务，用户慢授权完成后下次请求即成功）
    - 单飞并发（per-server asyncio.Lock）：多个并发请求同时 401 → 只触发一次授权
    - warmup 失败语义：返回 False → start() 返回 False（server 不启动），
      status() 显示 pending/expired，工具调用提示"未授权"而非"服务无响应"
    
    集成到 _HTTPTransport 中：
    - _headers()：静态 headers 有显式 Authorization → 跳过 OAuth（用户静态 token 意图明确）
      否则用 OAuth token
    - request() 遇 401 → ensure_token() → 重试（最多 1 次，防无限循环）
    """

    def __init__(self, server_name: str, server_url: str,
                 scopes: list[str] | None = None,
                 client_id: str | None = None,
                 redirect_port: int = OAuthFlow.DEFAULT_PORT):
        self._store = TokenStore(server_name)
        self._lock = asyncio.Lock()       # 单飞：并发 401 只触发一次授权
        self._pending_auth: asyncio.Task | None = None  # 进行中的授权任务（create_task 独立存活）

    # ── 公开接口 ──

    async def warmup(self) -> bool:
        """预热授权（start() 阶段调用，长超时 300s）。
        1. store.load() → 未过期直接返回 True
        2. 有 refresh_token → 尝试刷新
        3. 都失败 → 走完整 OAuth 授权（浏览器弹窗）
        返回 True（已有 token 或授权成功）/ False（用户取消/失败）
        → 返回 False 时 start() 也返回 False，server 不启动；
           status() 显示 pending/expired，工具调用提示"未授权"而非"服务无响应" """

    async def ensure_token(self, www_authenticate: str | None = None) -> str | None:
        """快速确保 token（request() 401 路径调用，预期 <5s）。
        1. 有未过期 token → 直接返回
        2. 有 refresh_token → 尝试刷新（<5s）
        3. 刷新失败 → clear() → create_task 启动后台授权（存入 _pending_auth）
           → 返回 None（当前请求失败，但授权任务独立存活，用户授权完成后下次请求成功）
        返回 access_token 或 None"""

    def get_auth_header(self) -> dict:
        """返回 {"Authorization": "Bearer <token>"}，无 token 返回 {}"""

    def has_static_auth(self) -> bool:
        """检查 extra_headers 是否已有显式 Authorization 头"""

    def status(self) -> str:
        """返回 oauth 状态：pending / authorized / expired / none"""

    async def _do_authorize(self, www_authenticate: str | None) -> bool:
        """单飞授权：discover → DCR（或用户输入）→ authorize → save。_lock 保护。
        后台任务化时：create_task 启动，调用方 await 可被取消但授权任务独立存活。"""

    async def _do_refresh(self) -> bool:
        """刷新 token：POST /token grant_type=refresh_token + resource。
        失败时先 clear() 再返回 False（防残留脏状态）。"""
```

#### 改动文件

##### `core/mcp_client.py`

1. **`_HTTPTransport.__init__`**：新增 `oauth: OAuthManager | None`、`extra_headers` 改为实例属性

2. **`_HTTPTransport._headers()`**——优先级修正（审查核心反馈）：
```python
def _headers(self) -> dict:
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    # 静态 headers 有显式 Authorization → 跳过 OAuth（用户静态 token 意图明确）
    if self.extra_headers and any(k.lower() == "authorization" for k in self.extra_headers):
        pass  # 不注入 OAuth token
    elif self._oauth:
        h.update(self._oauth.get_auth_header())
    h.update(self.extra_headers)
    if self._session_id:
        h["Mcp-Session-Id"] = self._session_id
    return h
```

3. **`_HTTPTransport.request()`**：401 时走快速刷新（≤5s），重试最多 1 次

4. **`_MCPServer.__init__`**：新增 `oauth_config` 参数

5. **`_MCPServer.start()`**：如果 `_http` 且 oauth 已配置，先 `await oauth.warmup()`（长超时 300s，授权不在请求窗口内）。warmup 返回 False → start() 返回 False（server 不启动），status() 显示 pending/expired，工具调用提示"未授权"而非"服务无响应"

6. **`MCPClient.start_all()` / `start_one()`**：对配置了 oauth 的 HTTP server 放宽外壳超时（`asyncio.wait_for(start, 360.0)`），否则 warmup 300s 被 60s 外壳掐死。非 oauth server 保持 60s。`start_one` 同策略

7. **`MCPClient.add_server()`**：新增 `oauth`、`oauth_scopes`、`oauth_client_id`、`oauth_redirect_port` 参数

8. **`MCPClient.status()`**：每 server 增加 oauth 状态字段（pending/authorized/expired/none）

##### `slime.toml`

```toml
# 远程 HTTP + OAuth 示例：
[[mcp_servers]]
name = "github"
url = "https://api.github.com/mcp"
# 无 headers → 触发 OAuth 自动发现
oauth = true
# oauth_scopes = ["read:user", "repo"]   # 可选，不填则 AS 默认 scope
# oauth_client_id = "xxx"                # 可选，不填则走 DCR 自动注册
# oauth_redirect_port = 18091            # 可选，默认 18091
```

##### `slime_server.py`

```python
mcp.add_server(
    name=srv_cfg["name"],
    ...
    oauth=srv_cfg.get("oauth", False),
    oauth_scopes=srv_cfg.get("oauth_scopes"),
    oauth_client_id=srv_cfg.get("oauth_client_id"),
    oauth_redirect_port=srv_cfg.get("oauth_redirect_port"),
)
```

##### `tests/test_mcp_oauth.py`（18 用例，全 mock）

| 组 | 用例 | 数 |
|---|---|---|
| 发现 | WWW-Authenticate 头解析 → Protected Resource Metadata → AS Metadata（含 OIDC fallback） | 3 |
| DCR | 注册成功返回 client_id / 注册失败跳过（提示手动输入） | 2 |
| PKCE | code_verifier/code_challenge 生成 / S256 验证 | 2 |
| Token | 授权码换 token / refresh_token 换新 token / refresh 失败 → clear() → 重授权 | 3 |
| 持久化 | save/load 往返 / clear 后 load 返回 None / 路径 sanitize（含 `..` 特殊字符） | 3 |
| 集成 | 首次 401 → 自动授权 → 重试成功 / 无 oauth 配置 401 → 返回 None（兼容） / **并发 401 单飞**（两请求并发仅一次授权） / **静态 Authorization 跳过 OAuth** / **refresh 失败 → clear → 重授权** | 5 |

#### 实施顺序

| # | 文件 | 内容 |
|---|---|---|
| 1 | `core/mcp_oauth.py` | TokenStore + OAuthDiscovery + OAuthRegistration + OAuthFlow + OAuthManager |
| 2 | `core/mcp_client.py` | `_HTTPTransport` 集成 OAuthManager + `_headers()` 优先级修正 + `_MCPServer.start()` 预热 + `add_server` 新参数 + `status()` 暴露 oauth 状态 |
| 3 | `slime.toml` | `[[mcp_servers]]` 新增 `oauth`、`oauth_scopes`、`oauth_client_id`、`oauth_redirect_port` |
| 4 | `slime_server.py` | 透传 oauth 配置 |
| 5 | `tests/test_mcp_oauth.py` | 18 用例全 mock |
| 6 | `docs/mcpfix.md` | P2-5 标记 ✅ |

#### 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 授权时机 | start() 预热长超时 300s，request() 只做快速刷新 | 防请求超时掐死浏览器授权（审查核心反馈 1） |
| start_all 外壳超时 | oauth server 放宽至 360s，非 oauth 保持 60s | 防 60s 外壳掐死 warmup 300s（审查第二轮 1） |
| 后台授权 | 刷新失败 → create_task 启动独立授权任务，存入 _pending_auth | 请求超时取消不杀死授权任务，用户慢授权完成后下次请求即成功（审查第二轮 2） |
| warmup 失败语义 | 返回 False → start() 返回 False → status() pending/expired → 工具调用"未授权" | 区分"用户取消授权"与"服务无响应"（审查第二轮 3） |
| 并发 401 | per-server `asyncio.Lock` + 单飞（pending task 共享） | 防多个请求同时触发两次授权弹窗（审查核心反馈 2） |
| 回调端口 | 固定 18091（可配置），非随机端口 | DCR redirect_uri 必须与 authorize 完全一致（审查核心反馈 3） |
| `_headers()` 优先级 | 静态 Authorization 头 → 跳过 OAuth；否则 OAuth token | 静态 token 是用户明确意图，不应被 OAuth 覆盖（审查内矛盾） |
| `resource` 参数 | RFC 9728 metadata 的 `resource` 字段优先，无则回退 server_url | 规范定义 canonical URI 来源（审查建议 4） |
| refresh 失败 | 先 `clear()` 再重授权，不残留脏状态 | 审查建议 5 |
| 无头兜底 | 浏览器打开失败 → 打印授权 URL 让用户手动打开 | 审查建议 6 |
| token 路径 | `data/mcp/{sanitized_name}/oauth.json`，`[^A-Za-z0-9_-]` → `_` | 与 `_save_media` 一致（审查建议 7） |
| DCR 策略 | 尝试 DCR，失败则提示用户手动输入 client_id | 兼容不支持 DCR 的 IdP（GitHub 等） |
| DPoP | 暂不实现（标注 TODO） | MCP 规范标注为可选，大部分 IdP 未支持 |
| Device Flow | 暂不实现（标注 TODO） | 无头环境用，当前 slime 是 GUI/CLI 交互式 |

#### 验收标准

| # | 标准 |
|---|---|
| 0 | **真机验证**：对一个真实 OAuth 保护的 MCP server（如 GitHub MCP 远程 OAuth 版）实测完整流程（WWW-Authenticate 格式、redirect_uri 匹配、IdP PKCE 要求） |
| 1 | 配置 `oauth = true` 的远程 MCP server 首次连接自动弹出浏览器完成授权 |
| 2 | token 缓存后重启 slime 无需重新授权 |
| 3 | token 过期自动刷新，用户无感知 |
| 4 | 刷新失败自动 `clear()` → 重新走完整授权流程 |
| 5 | 静态 `headers = {Authorization = "Bearer xxx"}` → 跳过 OAuth，直接使用静态 token |
| 6 | 并发请求同时 401 → 只触发一次授权（单飞） |
| 7 | 不配置 `oauth` 的 server 行为不变（向后兼容） |
| 8 | `/mcp/servers` 状态暴露 oauth 字段（pending/authorized/expired） |
| 9 | 18 用例全 mock 全绿 |
| 10 | 全量回归测试不退化

### 批 5：多 MCP 接入实测（2026-08-14，D:\下载 存量资源批量接入）✅

> ✅ 从用户 D:\下载 批量接入纯 MCP + 417 个 skill，实测暴露并修复 2 个传输层问题。全量 **344 passed**（测试数未变，修复不新增用例）。

| 接入项 | 结果 | 说明 |
|---|---|---|
| context7（本地 dist） | ✅ 2 工具 | 零安装直跑 |
| serena-agent（uvx） | ✅ 23 工具 | LSP 语义代码工具；不带 `-p 3.13`（见下） |
| browser_use（uvx） | ✅ 16 工具 | 真实调用已验证：navigate/screenshot 走 Edge 通道，截图经 P0-4 落盘 data/mcp/browser_use/ |
| agent-browser（npx） | ⚠️ 已注释禁用 | 握手正常（29 工具），但浏览器实际操作挂起（daemon/CDP 连 Edge 失败，CLI 直测同样挂起，第三方兼容问题） |
| headroom（uvx） | ✅ 3 工具 | 上下文压缩 |
| playwright-mcp | 已在库 | 不重复接入 |
| skill 包 ×7（karpathy/superpowers/anthropics/UI×3/browser-act/ECC/book-to-skill） | ✅ 417 个 | 跨包唯一冲突 design-system 取 UI 版；包内重复副本只取 1 份；注册 417 个 skill_ 工具 0 重名 |

**实测发现并修复的问题：**

| # | 问题 | 修复 |
|---|---|---|
| 1 | **uvx/npx 包装器孤儿进程持管道**：`terminate` 只杀直接子进程，孙进程（serena-agent.exe）成孤儿继续持有 stdout/stderr → reader 线程永久阻塞 → asyncio.run 退出挂死；serena 的 dashboard 端口 24284 也被孤儿占住导致重启失败 | `_StdioTransport.close()` Windows 走 `taskkill /PID /T /F` 杀整棵树（父进程存活时树遍历有效），失败回退 terminate/kill |
| 2 | **慢启动 JSONL server 误 flip 帧格式**：serena/headroom（JSONL）冷启动 4-8s > 5s 探测窗口 → 误判帧格式不符 → 切 Content-Length → 必失败 | `_MCPServer.start()` 探测超时但进程仍存活时，先同帧格式重试一次（全超时）；帧错配 server 通常直接退出（EOF 立即触发），此时才 flip |
| 3 | **serena `-p 3.13` 卡死**：uvx 指定托管 CPython 3.13 会从 GitHub 下载（本机网络下静默卡 20+ 分钟） | slime.toml 不指定版本，uvx 复用本机已有 uv 托管 Python 3.11（serena 支持 3.11-3.14） |
| 4 | **417 技能描述注入撑爆 system prompt**（120KB） | agent.py 截断注入：前 40 条 × 120 字符，其余以 skill_ 工具形式可见 |

### 批 3 收尾观察项（全部落地后复核，2026-08-14）

> 批 3 已全部落地（P2-5 延后），全量 **321 passed**。复核发现以下收尾观察项：**项 1、项 2 已修（全量 323 passed）**，项 3 保持观察暂不处理。

| # | 严重度 | 问题 | 位置 | 状态 |
|---|---|---|---|---|
| 1 | 低 | **通知回调任务无人跟踪**：`create_task(self._on_notification(frame))` 无引用，若 `_refresh_server_tools` 内 `_discover()` 抛出非 `_MCPServerError` 异常（如传输层意外异常），任务异常无人 retrieve（asyncio 警告） | mcp_client.py:219 | ✅ handler 内包 try/except |
| 2 | 低 | **list_changed 并发刷新竞态**：server 快速连发两次通知 → 两个 `_refresh_server_tools` 并发 → `_unregister`/`_register` 交错可能重复注册。真 server 通常单发，概率极低 | :877-896 | ✅ per-server 刷新锁（`asyncio.Lock`） |
| 3 | 观察 | **HTTP 传输无断连检测/重连**：`running` 只看 `client.is_closed`，远程 server 挂掉后调用显示"服务无响应"而非重连；P2-1 只覆盖 stdio（符合文档），建议 status 里给 HTTP 也补 last_error | :319-419 | 观察，待 202/OAuth（P2-5）恢复时一并处理 |

> ✅ 项 1/2 落地状态如实回填（2026-08-14）：
> - **项 1**：handler 内 try/except 包裹（:880-886），测试 `test_notification_handler_swallows_errors`（patch 抛异常确认不外抛）。
> - **项 2**：per-server `asyncio.Lock`（`server._refresh_lock`，:900）+ 测试 `test_concurrent_refresh_no_duplicate`（`_SlowTransport` 0.02s sleep 放大 `_discover` 交错窗口）。**诚实定性：这是防御性加固，非修复已复现 bug**——`_refresh_server_tools` 在 `await _discover()` 之后、`_unregister→_register` 之间没有 await 点（二者均同步），单事件循环下尾部必然串行，交错重复注册在当前代码上不会发生。锁的实质价值：(1) 串行化 `_discover`（真实 await 点），避免并发冗余发现请求；(2) 对将来在 unregister/register 间插入 await 提供硬保障。无锁时该测试亦可通过（尾部串行兜底），锁+测试固化的是"并发刷新不产生 _2"不变量。

> 已确认无问题的关键路径（复核过）：
> - **stop 与 reader EOF 竞态**：`close()` 先置 `_proc=None` 再 terminate → reader 退出时不误触发重连
> - **重连后回调有效**：`_on_notification`/`_on_close` 是 transport 实例属性，断连只置 `_proc=None`，实例不变 → 新进程自动继承回调
> - **stop_one/stop_all 取消重连任务** 完备
> - **wait_for 取消 SSE 流**：取消传播 → 生成器 aclose → stream 上下文正常退出

---

## 四、测试计划（tests/test_mcp.py 扩展）

| 批次 | 新增用例 | 方式 |
|---|---|---|
| 批 1 | 先 notification 后响应不错配；stderr 灌满仍可用；超时不 kill；迟到响应丢弃 warning | 真子进程 FakeServer（python -c 脚本，行为可编程）✅ 已实现 |
| 批 2 | 202 处理（延后）；SSE 长开流取到匹配 id；image content → 落盘路径；timeout 配置生效 | httpx MockTransport / 直接构造 content ✅ 已实现（除 202） |
| 批 2 审查 | SSE keep-alive 只发 ping 不发响应 → wait_for 超时返回 None（问题 1） | MockTransport 长流 ✅ 已实现 |
| 批 3 | 重连退避；并发启动；权限映射（按名覆盖/default 兜底/非法值回退）；冲突后缀；list_changed 刷新 | mock + FakeServer ✅ 已实现 |

## 五、决策点（实施前确认）

1. **P1-4 超限策略**：10MB 超限直接失败（现状）还是读完+warning（推荐，保 browser_snapshot 大页可用）？
2. **批 2.1 完整档（202）**：做不做？若目前只用本地 stdio server 可延后
3. **批 2.2 图片**：落盘路径回传（推荐）确认？10MB 护栏阈值是否合适？
4. **批 3 全做**还是分批暂停？（P2-3 权限映射影响沙箱语义，建议尽早做）

---

## 六、验收标准（全部完成时）

1. playwright-mcp：`browser_screenshot` 返回图片路径；`browser_navigate`/`browser_click`/`browser_snapshot` 全链路可用
2. 接入一个**会主动发 notification** 的 server（如带进度上报的）调用不错配
3. 接入远程 HTTP server（如有）：202/SSE 流式可用
4. 工具调用失败时文案含 `code + message`（可诊断）
5. 全量测试（298 + 新增）全绿
