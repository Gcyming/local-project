# Memory Question — 记忆/embedding/学习进化链路故障

> 创建日期：2026-08-12
> 状态：**根因已定位；用户已做初步优化（memory.py traits 提取），主 bug 仍未修**
> 更新：2026-08-12（用户初步优化后复查）

## 问题现象

- 17 条成功对话（含明确的偏好内容，如「不用 PowerShell」）后，`data/agent_2e17c6e5/memory.json` **从未生成**
- `data/` 下无任何 agent 目录，LanceDB 表未创建
- 控制台**无任何 `[memory] 记忆提取失败` warning**
- Elysia 对话时"记得"对话内容（用户测记忆时她答得上来）——但那是 **history 回放**（CLI 每次请求携带 `req.history`），掩盖了真故障
- 单独跑提取管线（计数桩 + 真实 Elysia）**100% 正常**：2 facts + 3 prefs + 2 lessons + 7 store 调用

## 证据链

| 观测 | 结论 |
|---|---|
| `extract_memories_from_chat` 单独调用正常 | 管线本身没问题 |
| `slime_server` 模块 `_SLIME_CONFIG.memory.enabled=True` | 开关没问题 |
| `history.jsonl` 全部 `success: True` | 门控条件没问题 |
| 控制台无 warning | 异常被静默吞噬 |
| CLI 收到 `done` 块立即 `break`（`slime_cli.py:1253`）→ 关闭 HTTP 连接 | **断连嫌疑** |

## 根因

**CLI 流式消费提前断开连接 → server 端生成器被取消 → `finally` 里的记忆提取 await 被 `CancelledError` 掐死。**

链路：

1. CLI `slime_cli.py:1249-1253`：收到 `type=="done"` 块后 `break`，退出 `with httpx.stream(...)` 上下文 → **立即关闭连接**
2. Server `slime_server.py:646-722`：记忆提取（707 行）写在 `_stream_generator()` 的 **`finally` 里**
3. 客户端断开 → Starlette 取消流式任务 → 生成器收到 `GeneratorExit`/`CancelledError`
4. 正挂起的 `await extract_memories_from_chat(...)` 被取消
5. **`asyncio.CancelledError` 继承 `BaseException`（Python 3.8+），`except Exception` 抓不到** → 静默穿透，无任何日志
6. 同理，`finally` 里提取之后的演化引擎（`engine.record_interaction` 等，711-722 行）**也被跳过**
7. `history_append`（694 行）是同步调用、在提取之前瞬间完成 → history 正常，形成"对话有记录但记忆无落库"的假象

## 影响范围

| 功能 | 状态 |
|---|---|
| 记忆提取（LLM 分析） | ❌ 从未执行 |
| JSON 记忆（`add_fact` → memory.json） | ❌ 未生成 |
| embedding 真向量（`store()` → BGE-M3 → LanceDB） | ❌ store 从未被调用，BGE-M3 实际零使用 |
| 语义召回（`recall()`） | ❌ 库为空 |
| 学习/进化（trait_signals → evolve） | ❌ 同一 CancelledError 掐断 |

架构澄清：**embedding（BGE-M3）不是 LanceDB 的上位替代**。分工为：BGE-M3（向量生成器）→ LanceDB（向量存储/检索）→ 语义召回；被替代的是旧的字符哈希占位向量，LanceDB 始终是存储层。

## 复查更新（用户初步优化后，2026-08-12）

### 用户已做的优化（core/memory.py，13:56 修改）

- `extract_memories_from_chat`（376-445）新增解析 `traits_observed`，返回 `(count, trait_signals)` 元组（442/445 行）
- 补全了非流式端点 `slime_server.py:585` 的契约（`_, trait_signals = ...`），trait 信号已接进 `engine.evolve()`（593-598 行）

### 剩余问题（复查确认）

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| **A** | **主根因未修**：方案 A 未实施，提取/演化仍在流式生成器 `finally` 里 await，CLI 断连 → `CancelledError` 掐死 | `slime_server.py:696-722` + `slime_cli.py:1249-1253` | 记忆/embedding/进化**仍全断** |
| **B** | 返回类型不一致：`llm_call_fn is None` 分支返回 **dict**，其余分支返回 **tuple** | `core/memory.py:388-389` vs 442/445 | 传 `None` 的调用方在 585 行 `TypeError: cannot unpack non-iterable dict`（潜伏） |
| **C** | 流式路径 trait 信号被丢弃：707 行不接收返回值 | `slime_server.py:707` | 主 bug 修好后流式对话的 trait 仍不进演化引擎；流式（仅 record_interaction）与非流式（evolve 全功能）能力不对称 |
| **D** | 健壮性：`lesson["content"]` 缺 key → `KeyError` 整条提取失败（已入库 facts 不回滚）；docstring 仍写返回 dict | `core/memory.py:436`、384 | 轻微，低概率 |
| **E** | **BGE-M3 当前不可用**：`data/model_servers.json` 为 `{}`（13:49 写入）→ `_embed`（memory.py:84）与 `llm.py:575` 都读不到端口 → 向量走**哈希降级** | 运行态（需重启 server 并 ensure embedding） | 影响验收第 3 步：向量不是真 BGE-M3 |

### 建议修复顺序

1. **方案 A**：`slime_server.py` 把 finally 中的后处理（提取 + 演化 + save_agents，696-722）抽成独立 async 函数，`asyncio.create_task` 后台派发；顺带 **707 改为接收 `trait_signals` 并统一走 `evolve()`**（消除不对称）
2. **统一 memory.py 返回契约**：None 分支也返回 `(dict, [])`；`lesson` 缺 content 时跳过而非抛错；更新 docstring
3. 重启 server → `/servers` 确认 `embedding ready` → 按验收标准执行

## 修复方案

### 方案 A（推荐）：server 端后处理移出流式生成器，改后台任务

`slime_server.py` `chat_stream` 的 `finally` 中：

- 把含 await 的后处理（**记忆提取 + 演化引擎 + save_agents**，696-722 行）抽成独立 async 函数（如 `_post_process_chat(agent, req, reply, providers)`）
- 用 `asyncio.create_task(...)` 派发 → 流式响应正常结束、连接正常关闭，后台任务独立存活
- 同步的历史写入（693-694 行）保持原位（瞬间完成，不受影响）
- 后台任务内兜底捕获 `asyncio.CancelledError`，防止进程退出时报错

优点：客户端断连行为完全解耦，CLI/GUI 任何客户端都修复；用户无感。

### 方案 B（不推荐）：CLI 端 `done` 后不 `break` 继续读到 EOF

- 缺点：CLI 每次对话后额外阻塞 5-30s（Elysia 提取耗时）；只修 CLI，不修 GUI 等其他客户端

## 验收标准

1. 启动 server（`python D:\tool\slime\slime_server.py`），确认 `/servers` 有 `embedding ready @8999`（**若 registry 为空，先触发 ensure，否则向量是哈希降级**）
2. CLI 对话一条偏好性内容：「记住，我不喜欢用 PowerShell」
3. 对话完成后 **15-30s 内** 检查：
   - `D:\tool\slime\data\agent_2e17c6e5\memory.json` 出现，`facts` 数组含该内容
   - `data/agent_2e17c6e5/lancedb/` 表出现，向量 1024 维（走 BGE-M3，非哈希降级）
4. 新开对话问「你还记得我对你有什么要求吗」→ Elysia 应回答出 PowerShell 偏好（此时来自**真记忆注入**，而非 history 回放——注意 CLI 会把旧对话作为 history 发过去，验证时可用 `/new` 清空历史后再问）
5. 连续对话 3 次，控制台无异常、无 `Task was destroyed` warning

## 相关代码位置

| 文件 | 行号 | 说明 |
|---|---|---|
| `slime_cli.py` | 1249-1253 | CLI 收到 done 后 break（断连源头） |
| `slime_server.py` | 637-732 | `chat_stream` 端点，提取在 finally（707） |
| `slime_server.py` | 696-709 | 记忆提取块（`except Exception` 漏接 CancelledError） |
| `slime_server.py` | 711-722 | 演化引擎（也被掐断） |
| `slime_server.py` | 470-634 | 非流式 `/chat` 端点（585 行提取 + trait 接 evolve，请求体内 await，**不受断连 bug 影响**） |
| `core/memory.py` | 376-445 | `extract_memories_from_chat`（管线正常；**已改**：返回 `(count, trait_signals)` 元组；None 分支返回类型不一致） |
| `core/memory.py` | 79-105 | `_embed`（BGE-M3）/`_hash_embed`（当前 registry 为空 → 实际走哈希降级） |
| `core/evolve.py` | 171-204 | `evolve()`（trait_signals 应用；非流式已接线，流式未接） |
| `core/llm.py` | 567-638 | `_local_model_reply`（无关，仅排查时排除） |
