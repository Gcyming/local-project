# slime 项目全面检验报告

> 检验日期：2026-08-15
> 方式：只读代码探查（4 路并行）+ 测试基线实测
> 测试基线：`py run_tests.py` = **344 passed 全绿** ✅

---

## 一、测试基线

| 入口 | 结果 |
|---|---|
| `py run_tests.py`（项目约定全量入口） | ✅ 344 passed, 0 failed |
| `py -m pytest -q`（全量收集） | ❌ **5 ERROR（收集阶段失败），见 P0-1** |
| `py -m pytest tests/test_tools.py tests/test_merger.py -q` | ✅ 74 passed |
| `py -m pytest config/skills/skill-comply/tests -q` | ✅ 33 passed |

---

## 二、记忆/情绪/进化/学习模块 — 链路完整 ✅

### 模块清单与职责

| 文件 | 职责 |
|---|---|
| `core/memory.py`（702 行） | 成长型记忆：JSON 主存储 + 可选 LanceDB 向量存储、艾宾浩斯遗忘、双向链接、LLM 提取 |
| `core/emotion.py`（256 行） | L3 情绪：PAD 三维模型 + 8 种 mood 状态机 + 指数半衰期衰减 + 输出风格提示 |
| `core/evolve.py`（300 行） | 演化引擎：生命周期状态机（BIRTH→DEATH）+ trait 强化/弱化/遗忘 |
| `core/persona.py`（138 行） | 人格画像：空骨架起步（traits/preferences/skill_ownership/interactions） |
| `core/behavior.py`（141 行） | L2 行为模式：场景→步骤习惯，confidence 强化/艾宾浩斯衰减 |
| `core/novelty.py`（20 行） | novelty 信号纯函数：字符级 bigrams + 短确认语守卫 |
| `core/knowledge.py`（524 行） | 知识引擎：Pattern-Key 追踪 + 晋升管线（alert→rule→trait→skill）+ 周期性审查 + Obsidian 输出 |
| `core/consolidation.py`（55 行） | 沉淀引擎：L3 高频模式 → L2 行为模式（每 50 次交互触发） |
| `core/skill_engine.py`（350 行） | 技能引擎：manifest+SKILL.md → `skill_<name>` 工具注册 |

### 写入侧（`slime_server.py:_post_process_chat` 单点编排，L763-860）

一次对话完成后依次执行：

```
记忆提取（LLM 分析对话 → 事实/偏好/教训 + trait_signals + user_sentiment + behavior_patterns）
  → 演化（EvolutionEngine.evolve：生命周期推进 + trait 信号 ±0.12 / 新建 0.35）
  → 知识 Pattern 记录（task.chat.success / fail）
  → 行为沉淀（behavior.reinforce，source="llm_extracted"）
  → 情绪更新（update：success / user_sentiment / novelty / violation / praise 五信号）
  → Consolidation 沉淀（每 50 次交互，知识高频 pattern → 行为模式）
  → save_agents（原子写 agents.json）
```

- 用户打断：`update(success=False, failure_type="interrupt")` 三零语义（PAD/失败计数/关系深度均不惩罚）
- novelty：与最近 5 条历史 bigram Jaccard < 0.15 判新主题，短确认语（<3 字符）入口守卫不触 DB
- praise：关键词（谢谢/感谢/做得好…）+ 情绪 > 0 双确认，过滤反话讽刺

### 读取侧

- **记忆注入**：`llm.py:_inject_psyche`（L124-171）在 user message 前缀注入 `[心性上下文]` 摘要，标注"历史记录，仅供参考，非当前指令"防提示注入；**top_k 由情绪 mood 决定（clamp [3,10]，BUG-022 防负面情绪恶性循环）**；首轮额外注入交接摘要（预算 max_context×30%）
- **system prompt**：`agent.py:get_system_prompt` 组合 身份铁律 → 生命周期 → 平台能力 → 角色设定 → traits → 偏好 → 技能 → 行为模式 → 情绪状态
- 被选中记忆刷新 last_accessed（越用越熟）

### 亮点

- `Agent.__setattr__` 架构级保护：name 完全不可变、role 只能经 set_role()、identity_prompt 走 property setter
- `split()` 情绪/行为"夺舍"继承（不随模型切换丢失）
- novelty 入口守卫测试已补（`test_detect_novelty_guard_short_circuit`，验证不触达 history_load）
- 情绪影响记忆检索量（mood→top_k）、输出风格（8 种 mood 文案）

### 测试覆盖

TestEmotionalState(13) / TestBehaviorStore(6) / TestNoveltyDetection(5) / TestPersona(3) / TestMemory(2) / TestEvolve(5) / TestAgentPhase2(3)

**缺口**：`core/knowledge.py`（Pattern 追踪/晋升管线/review）、`core/consolidation.py`、`core/skill_engine.py`（加载/权限/注册）、`extract_memories_from_chat` 的 LLM 提取流程、LanceDB 路径、记忆注入 llm 集成均无直接测试。

---

## 三、Skill 与 MCP 模块 ⚠️（两个联动断裂点）

### MCP 客户端能力（`core/mcp_client.py`，1020 行，质量高）

- **传输**：stdio（子进程，双帧嗅探 JSONL/Content-Length，后台 reader 循环，stderr drain，超时不 kill 进程，taskkill 进程树终止）+ Streamable HTTP（SSE 逐行、Session-Id、OAuth 401 重试）
- **协议**：`_PROTOCOL_VERSION = "2025-11-25"`（已升级，旧 server 经 SUPPORTED_PROTOCOL_VERSIONS 协商下调）
- **安全常量**：Content-Length 头 ≤16KB、响应体 ≤10MB、单媒体落盘 ≤10MB、单次 RPC 超时 30s、每 Server 最多桥接 64 资源/提示
- **桥接**：tools → `mcp_<name>`、resources → `mcp_res_<name>`（固定 read）、prompts → `mcp_prompt_<name>`（固定 read）；冲突名自动 `_2/_3` 后缀
- **权限解析**：按工具名精确键 → `default` 键 → 缺省 `["network"]`；非法值回退 network
- **管理**：start_all 并发启动、自动重连（指数退避 1s→60s）、list_changed 热刷新、媒体 base64 落盘去重
- **OAuth 2.1**：`core/mcp_oauth.py`（496 行）RFC 9728/8414 发现、DCR、PKCE S256、固定回调端口 18091

### 已配置 MCP Server（slime.toml L141-196）

| name | 传输 | 备注 |
|---|---|---|
| browser | stdio node playwright-mcp cli.js --browser msedge | 微软官方，Edge 通道 |
| context7 | stdio node dist/index.js | 本地直跑，零安装 |
| serena | stdio uvx serena-agent | LSP 语义代码检索；不带 -p 版本（防下载托管 CPython 卡死） |
| headroom | stdio uvx headroom-ai[mcp] | 上下文压缩 |
| browser_use | stdio uvx browser-use --mcp | inject_provider_keys=true 解密注入 LLM key；BROWSER_USE_DISABLE_EXTENSIONS=1 防 uBlock 下载卡死 |
| agent_browser | （已注释） | MCP 握手正常（29 工具）但 daemon/CDP 连接 Edge 挂起，第三方兼容问题，实测记录在 slime.toml L167-169 |

### 断裂点 1（重大）：MCP 工具在 Server 模式下恒被沙箱拒绝

- MCP 工具缺省权限 `network` → 映射 L4
- slime.toml 默认 `require_approval_levels=[2,3,4]`
- **server 端审批回调恒拒绝**（slime_server.py:286-291，reason "Server 端不处理确认，请在 CLI 端操作"）
- → **当前所有 `mcp_browser_*` 等工具在对话中一律被沙箱拒绝**，浏览器 MCP 接入了但 Agent 实际调不动
- 对比：web_fetch/web_search 因 agents.json 里 `sandbox_override.auto_approve_tools` 白名单可用；MCP 工具没有对应白名单
- 解法：slime.toml 配 `tool_permissions`（如 `{ default = ["read"] }` 降 L0）或 agents.json `auto_approve_tools` 加 `mcp_browser_*`

### 断裂点 2（成本爆炸）：417 技能全量注入 LLM tools

- `config/skills/` 有 **417 个技能目录**（各含 manifest.yaml + SKILL.md）
- `load_all_skills` 全部注册为 `skill_<name>` 工具（skill_engine.py:322-350）
- `llm.py:392-394` 每次请求**全量注入** `get_registry().list_tools()` → 约 **480+ 工具 schema/请求**（417 技能 + 4 内置 + ~60 MCP）
- system prompt 有截断（`_MAX_INJECTED_SKILLS=40` 条 × 120 字符，agent.py:30,322），但 **tools 数组无任何截断**
- 估算单请求 5-12 万 token 的成本/上下文开销，且模型工具选择注意力被稀释
- 技能权限 fail-closed：未知权限默认最高级；L2+ 无审批回调默认拒绝（N11-P2-18）；skill.py 自定义执行函数禁用（N11-P0-2 防 RCE）

### 工具注册表（tools/registry.py）

- Tool：name 唯一（同名非 force 拒绝覆盖）/ description / parameters（JSON Schema）/ permissions（默认 read）
- 内置工具：file_read / file_list（read，拒符号链接+项目根限制+敏感文件屏蔽）/ web_fetch / web_search（network，SSRF 防护+反爬节奏）

### 沙箱（core/sandbox.py，1174 行）

- L0-L5 分级；批准决策顺序：workspace 隔离 → 异常检测 deny → 黑名单 → require_approval_tools → auto_approve_levels/tools → require_approval_levels（调回调，无回调拒绝）→ 未知 fail-closed
- CLI 同步模式弹 input() 菜单（异步上下文自动拒绝防事件循环冻结）；审计日志（allowed/denied/revoked + granted_by，200 条轮转）；异常检测（写速率/文件大小/危险正则/循环检测/资源耗尽）
- SSRF 防护：IP 钉扎连接（URL 改写 + Host 头 + sni_hostname 防 DNS Rebinding）、A+AAAA 全解析任一内网即拒、重定向逐跳重验、2MB 流式累计中断、gb18030 编码启发式

### 测试覆盖

tests/test_mcp.py（TestMCPSSEParsing/ContentToText/PromptSchema/MediaContent/TimeoutConfig/HTTPStreaming/MCPServer/StdioFraming/StdioReaderLoop/MCPClient/MCPPermissions/NameConflict/ConcurrentStart/NotificationRefresh/Reconnect）、tests/test_mcp_oauth.py（7 类）、tests/test_tools.py（SSRF 15/重定向/协议/响应/提取/反爬/沙箱集成/DNS/能力提示/Reasoning 提取/工具可视化/JS 渲染）、tests/test_sandbox.py（15 类）

---

## 四、模块联动（自如使用）— 链路通，3 个能力缺口 ⚠️

### 对话全链路调用顺序

```
用户输入
 └─ slime_cli.py:1277 POST /agents/{id}/chat/stream（SSE，Bearer 认证）
     └─ slime_server.py:872 _stream_generator
         └─ core/llm.py:1047 call_llm_stream
             ├─ system prompt ← agent.py:254（身份铁律→生命周期→能力→角色→traits→偏好→技能→行为→情绪）
             ├─ ContextCompressor.compress_async（>window 30 → LLM 摘要，head=3/tail=10）
             ├─ max_context 字符预算截断（524288）
             ├─ _inject_psyche（记忆摘要 top_k=情绪驱动 + 首轮交接摘要 → user message 前缀）
             ├─ tools 全量注入 ← registry.list_tools()
             └─ SSE 循环（chunk / reasoning / tool / done / error）
                 └─ 工具调用 _execute_pending_tools（≤3 轮 _TOOL_MAX_ROUNDS）
                     ├─ 参数 JSON 校验 → 沙箱 check_permission → record_violation / grant_permission
                     └─ registry.call_tool → 结果回填 role=tool → 二次请求
         └─ finally（同步持久化，客户端断连也执行）
             ├─ retry → history_pop_last / persona.add_interaction（200 条上限）/ history_append（10MB 轮转）
             └─ _spawn_background(_post_process_chat)（记忆/演化/知识/行为/情绪/沉淀）
```

### 联动质量评估

| 环节 | 状态 |
|---|---|
| 对话→记忆注入→工具调用→沙箱→后处理→持久化 | ✅ 完整闭环（agents.json 原子写 uuid+os.replace、history.jsonl 轮转 5000 条、双进程独立加载） |
| 身份铁律三层防线（提示词/逐 chunk 过滤/__setattr__） | ✅ 但**跨 chunk 拆词漏过滤窗口**（"作为 "+"AI" 单块不命中；done.reply 整段过滤 → 屏幕显示与落库历史可能不一致） |
| Swarm 多 Agent | ⚠️ **Worker 是"无记忆白板"**：直接调 call_api_provider 不走 _inject_psyche，无记忆注入；临时对象不入库、不触发演化/沉淀、不写 history；任务完成主 Agent 不成长。`fork()` 方法无调用点（死代码）。只有 `split()` 持久子 Agent 继承 persona/emotion/behavior 克隆 |
| 流式 vs 非流式端点 | ⚠️ **能力不对称**：A2A 委托/广播仅非流式 `/chat` 有（slime_server.py:620-698），`/chat/stream` 没有 → CLI 主对话（流式）拿不到委托/A2A |
| 沙箱纵深 | ✅ SSRF IP 钉扎、fail-closed、审计轮转、异常检测、workspace url 字段放行 |

### Swarm 架构速览

- CLI `/task`（max_workers=2）/ `/auto` 自动检测 / swarm CLI（--max-workers 2）
- SwarmExecutor：主 Agent 拆解 → _parse_subtasks（整体 json.loads → 正则兜底 → 行号解析）→ 并发执行（Queue+gather 或多进程 ProcessWorker+IPCBus）→ Merger（collect_results → 主 Agent 总结 → finalize：analyze_errors/assess_risks/trial_run 评分 → LLM 结论或模板兜底）
- 总超时 200s 硬上限；Worker 轮询 time.sleep(0.2) 忙等

### 已知缺陷（代码内）

| 位置 | 内容 |
|---|---|
| merger.py:262 | TODO：LLM 更智能的一致性检查（当前仅关键词正负冲突启发式） |
| process_worker.py:428-429 | get_result 重复 return None（死代码） |
| gui/ | 空目录，GUI 未实现 |
| executor.py:529 | Worker 忙等 |
| slime_server.py:590-601 | /chat/analyze 正则兜底失败静默降级 chat（可能误判） |

---

## 五、流式输出与思考内容展示 ⚠️

### 协议（设计完整）

- SSE（media_type="text/event-stream"，无 event 字段，纯 `data: {json}\n\n`）
- 事件类型：`chunk`(content) / `reasoning`(content) / `tool`(name,args,result) / `done`(reply,model,tokens,elapsed_ms) / `error`(message)
- reasoning 提取：`_extract_reasoning`（llm.py:101-114）优先级 `reasoning_content → reasoning → thinking`，delta + chunk 顶层兜底（覆盖 DeepSeek/Qwen/Kimi/GLM/OpenAI/Grok/Gemini/Anthropic）
- 过滤：`_should_yield_reasoning`（llm.py:74-81）：on=全透传 / auto=仅 plan 模式 / off=丢弃（默认 off）
- 推理参数注入：`_build_reasoning_params`（openai reasoning_effort / anthropic thinking.budget_tokens；effort=none 零注入）
- Agent 默认：reasoning_effort="none"、show_thinking="off"、mode="build"

### CLI 展示（slime_cli.py:1289-1416）

- 思考动画线程（GBK 安全字符 (o_o)）→ 首块停止
- reasoning 先于正文：缓冲 → 首个 chunk 时 Rich Panel("思考") 一次性渲染；正文后到达：灰斜体 console.print 交错插入
- tool 事件：`🔧 name(args)` + result 截断 200 字符
- 截断检测：未收到 done 且无 error → "⚠ 回复可能被截断"；只有 done_received 才写本地 history（上限 40 条）

### 缺陷清单（代码证据）

1. **截断不一致**：客户端断流时 server 写 `reply + "\n[截断]"` 入 history.jsonl（slime_server.py:912-926），CLI 不写会话历史（slime_cli.py:1410-1413）→ 重启后 `/history` 与会话显示不一致
2. **异常路径丢失思考**：httpx 异常/KeyboardInterrupt 分支 continue 前未渲染 thinking_parts（渲染在 try 块内 with 之后，异常时跳过）
3. **交错渲染破坏布局**：正文开始后 reasoning 用 console.print 换行插入，在流式正文中间打出整行灰字
4. **ANSI 清理不对称**：chunk 路径有 `_ANSI_ESC_RE.sub` 终端注入防御（L1317），reasoning 路径（L1328 交错直写、Panel 内文本）和 tool 路径（L1340-1342）均未清理
5. **思考一次性渲染**：缓冲全文 → 一次 Panel，非逐 token；超长无截断
6. **工具展示**：args 不截断（web_search 长参数刷屏）；多轮工具无轮次/阶段标识
7. **full_reply 为空断流静默**：只有 thinking 无正文时断流，不提示（L1375 `and full_reply` 为 False）
8. **状态栏 token 只反映最近一次请求**（上下文占比条跳变）
9. **无测试**：server chat_stream 端点、_should_yield_reasoning 链路、CLI SSE 解析均无测试（REASONING_STATUS.md 预告的 3 用例未落地）

### GUI 状态

- `gui/` 目录 **0 个文件**；requirements.txt 无 PySide6；全项目 grep PySide/QApplication 零命中
- CLAUDE.md 阶段三标"🔄 进行中"高估了进度：MCP、本地模型管理已完成，但 **GUI 桌面客户端完全未开工**
- 文档证据：HEALTH_REPORT.md:18/82/120/210、PHASE2_COMPLETION.md:38、BUGS.md:329
- 未来 GUI 可复用 SSE 协议与 _api/_auth_headers 同款认证模式

---

## 六、P0-1：`py -m pytest -q` 全量收集失败（5 ERROR）— 根因已定位

### 现象

```
ERROR config/skills/skill-comply/tests/test_grader.py   ← No module named 'scripts'
ERROR config/skills/skill-comply/tests/test_parser.py   ← No module named 'scripts'
ERROR config/skills/skill-comply/tests/test_runner.py   ← No module named 'scripts'
ERROR tests/test_merger.py                              ← No module named 'core.merger'; 'core' is not a package
ERROR tests/test_tools.py                               ← No module named 'core.fetcher'; 'core' is not a package
```

- 稳定复现：无参全量跑必失败；`py -m pytest <具体目录>` 均通过
- `py run_tests.py`（自定义 runner）不受影响，344 全绿

### 根因分析

1. **模块名冲突（core 被污染）**：pytest 全量收集 `config/skills/` 下 417 个技能目录（含 tests/），prepend 导入模式把技能目录插入 sys.path 前部。实测收集后 sys.path 前部为：
   ```
   ['D:\tool\slime',
    'D:\tool\slime\config\skills\ui-ux-pro-max\scripts',   ← 冲突源
    ...]
   ```
   `config\skills\ui-ux-pro-max\scripts\core.py`（单文件模块，非包）抢占了 `core` 模块名 → 项目 `core/` 包无法解析 → "core is not a package"。同类冲突文件还有：`config\skills\design\scripts\cip\core.py`、`logo\core.py`、`config\skills\slack-gif-creator\core`（无扩展名）

2. **skill-comply 的 pythonpath 不生效**：`config/skills/skill-comply/pyproject.toml` 有独立 pytest 配置 `testpaths=["tests"]`、`pythonpath=["."]`（依赖 `scripts` 包）。单独跑该目录时 pytest 推导 rootdir=skill-comply 并加载其配置 → 通过；全量跑时 rootdir=D:\tool\slime（项目根无 ini）→ skill-comply 的 pythonpath 不加载 → `from scripts.xxx` 失败

### 修复方案（建议）

在项目根新建 `pytest.ini`：

```ini
[pytest]
testpaths = tests
norecursedirs = config skills config/* data docs Knowledge BGE-M3 llama.cpp Local model social
```

- `testpaths=tests`：全量只收集项目自己的测试
- `norecursedirs=config`：不递归技能目录（第三方技能库的 tests 不属于本项目测试基线）
- run_tests.py 不受影响；技能库内测式仍可 `py -m pytest config/skills/skill-comply` 单独跑

---

## 七、问题清单（按优先级）

### P0（先修）

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| 1 | 全量 pytest 收集失败（5 ERROR，core 名冲突 + pythonpath 不生效） | 根因见第六节 | 测试基线入口坏 |
| 2 | MCP 工具在 Server 模式恒被沙箱拒绝（L4 + 恒拒回调，无白名单） | slime.toml / slime_server.py:286-291 | 浏览器等 MCP 能力实际不可用 |

### P1

| # | 问题 | 位置 |
|---|---|---|
| 3 | 417 技能 + ~60 MCP 工具全量注入 LLM tools（无截断，估 5-12 万 token/请求） | llm.py:392-394、skill_engine.py:322-350 |
| 4 | CLI 流式缺陷：截断不一致 / 异常丢思考 / ANSI 清理不对称 / 交错渲染破坏布局 / args 不截断 | slime_cli.py:1317-1416 |
| 5 | 流式/非流式端点能力不对称（A2A/委托仅非流式） | slime_server.py:620-698 vs 863-941 |

### P2

| # | 问题 | 位置 |
|---|---|---|
| 6 | Swarm Worker 无记忆/情绪/演化沉淀；fork() 无调用点 | executor.py:491-520、agent.py:226 |
| 7 | 身份铁律跨 chunk 拆词漏过滤窗口 | llm.py:985 vs 1019-1024 |
| 8 | GUI 未实现（CLAUDE.md 阶段状态高估） | gui/ 空目录 |
| 9 | 文档脱节：REASONING_STATUS.md 过时（_inject_reasoning_params 改名）、mcpfix.md 对照、CLAUDE.md 阶段状态 | docs/ |
| 10 | 死代码/忙等：process_worker.py:428 重复 return、executor.py:529 time.sleep(0.2) | process_worker.py / executor.py |
| 11 | 测试缺口：knowledge/consolidation/skill_engine/extract_memories 无直接测试；server 流式端点、reasoning 链路、CLI SSE 解析无测试 | tests/ |

### 建议执行顺序

P0-1（修复测试基线）→ P0-2（打通 MCP，需定沙箱策略）→ P1-3（工具注入成本）→ P1-4（流式体验）→ P1-5 → P2 各项

---

## 八、健康指标（正面项）

- 记忆/情绪/进化/行为链路完整：单点编排（_post_process_chat）+ 双读路径（llm._inject_psyche + agent.get_system_prompt）
- 沙箱安全纵深完整：SSRF IP 钉扎、fail-closed、审计、异常检测、workspace url 放行、技能权限 fail-closed、skill.py RCE 禁用
- MCP 客户端质量高：协议 2025-11-25、双帧嗅探、自动重连、OAuth 2.1、媒体落盘去重、热刷新
- 身份铁律三层防线（提示词 / 逐 chunk 过滤 / __setattr__ 架构级保护）
- 持久化安全：agents.json 原子写（uuid+os.replace+Windows 重试）、history 10MB 轮转、auth_token 加密+隐藏+icacls/0o600
- novelty 入口守卫测试已补（不触达 history_load 验证）
- BUG-001~034 全部闭环；search_engine.md 十三/十四章方案已落地（浏览器 MCP 接入 + 协议升级）