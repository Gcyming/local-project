# slime 本地模型管理 — 任务向导与清单

> 目标：**embedding（BGE-M3）常驻** + **chat（Qwen 3B）懒加载静默**，借鉴 Campanula 的
> LTS 显存感知管理思想，按 slime 场景简化（事件驱动，无 tick 循环）。
>
> 前置事实（已实测）：
> - GPU：RTX 4070 Laptop 8GB（8188 MiB），实施时当前空闲 ~6.1GB
> - 模型文件已就位：
>   - `D:\tool\slime\BGE-M3\bge-m3-q8_0.gguf`
>   - `D:\tool\slime\Local model\qwen2.5-3b-instruct-q8_0.gguf`
> - `D:\tool\slime\llama.cpp\llama-server.exe`（llama.cpp 二进制）
>
> 测试运行：`python run_tests.py`（无 pytest 依赖，自动发现 `tests/test_*.py` 中 `Test*` 类，
> 支持 async 测试方法与 `tmp_path` fixture，见 `tests/test_sandbox.py` 惯例）。

---

## 架构总览

```
core/model_server.py                     # 新建（本计划核心）
├── VRAMMonitor           # nvidia-smi 采样 → {total, used, free}；失败返回 None（CPU-only 兜底）
├── ModelBackend          # llama-server 封装：start / wait_ready / stop / probe
└── ModelServerManager    # startup / ensure / release / status / shutdown + 空闲计时器 + registry 落盘

挂接点：
- slime_server.py:184  lifespan → 启动拉 persistent 实例 / 退出全停
- core/memory.py:79    _embed() → BGE-M3 HTTP 向量（降级：哈希占位）
- core/llm.py:566      _local_model_reply() → 真实本地 chat 调用
- slime_cli.py:960     斜杠命令 handlers 字典 + _CMD_SPECS 帮助注册
```

**状态模型**（chat 4 态；embedding 恒 `ready`）：

```
idle ──ensure()──▶ loading ──wait_ready──▶ ready ──idle 10min──▶ unloading ──▶ idle
                    │                        │          ▲
                    └── 失败回退提示 ◀────────┴──手动 /servers stop chat
```

**端口规划**：embedding=8999；chat=18082 起（port_start 顺序取空）。

---

## T1. 配置层 — `slime.toml` 新增 `[model_server]` 段

在 `slime.toml` 末尾追加：

```toml
# ── 本地模型管理 ──────────────────────────────────────────

[model_server]
llama_bin = "D:\tool\slime\llama.cpp\llama-server.exe"
startup_timeout = 60        # wait_ready 总超时（秒）
vram_budget_gb = 7.0        # 显存总预算（8GB 卡预留 1GB 余量）
chat_est_gb = 4.0           # chat 拉起前预估占用（预算检查用）

[model_server.embedding]
model_path = "D:\tool\slime\BGE-M3\bge-m3-q8_0.gguf"
port = 8999
gpu_layers = 99
ctx_len = 2048
persistent = true           # 常驻：server 启动即拉、退出才停（forbid_core_unload 语义）
dim = 1024                  # bge-m3 输出维度（fallback 用）

[model_server.chat]
models_dir = "D:\tool\slime\Local model"
port_start = 18082
gpu_layers = 99
ctx_len = 8192
persistent = false          # 静默：平时不拉起，用户切换 local 才加载
idle_unload_min = 10        # 空闲自动卸载（0 = 不自动卸）
max_instances = 1
```

验证：`python -c "import tomllib;print(tomllib.load(open('slime.toml','rb'))['model_server'])"` 能打印。

---

## T2. 新建 `core/model_server.py`（核心）

三个组件，纯标准库（`subprocess / httpx / json / time / logging / threading / pathlib`）。

### VRAMMonitor

```python
class VRAMMonitor:
    def sample(self) -> dict | None:
        """nvidia-smi 采样；失败/无 GPU 返回 None（调用方跳过预算检查）"""
        # subprocess.run(["nvidia-smi", "--query-gpu=memory.total,memory.used,memory.free",
        #                 "--format=csv,noheader,nounits"], capture_output=True, timeout=5)
        # → {"total_gb": float, "used_gb": float, "free_gb": float}
```

### ModelBackend（llama-server 封装）

```python
class ModelBackend:
    def __init__(self, cfg: dict, role: str): ...   # cfg = toml 中 model_server 段合并实例段

    def start(self, model_path: str, port: int, model_name: str) -> bool:
        # 关键：仅启动时可执行：
        #   subprocess.Popen([llama_bin, "-m", model_path, "--port", str(port),
        #                     "-ngl", str(gpu_layers), "-c", str(ctx_len),
        #                     ("--embedding" if role=="embedding" else None), ...],
        #                    stdout=DEVNULL, stderr=DEVNULL,
        #                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        # 记录 self.pid；**只管理自己 Popen 的进程**（外部实例仅 probe 复用，不杀）

    async def wait_ready(self, timeout: float) -> bool:
        # GET http://127.0.0.1:{port}/health 轮询（0.5s 间隔），status=="ok" 即就绪
        # embedding 角色额外等 /v1/models 可用（llama-server 启动后 health 可能先 ok）

    def stop(self) -> bool:
        # 仅当 self.pid 有效：taskkill /PID {pid} /T /F（Windows）
        # 绝不 taskkill /IM llama-server.exe（会误杀外部手动实例）

    def probe(self, port: int) -> bool:
        # GET /health 探测；外部已有实例时直接复用不拉起

    def is_running(self) -> bool:
        # pid 存活 + /health ok 双确认
```

### ModelServerManager

```python
class ModelServerManager:
    def __init__(self, cfg: dict): ...

    async def startup(self) -> None:
        """只拉 persistent=true 实例（embedding）。失败记日志不阻塞 server 启动"""

    async def ensure(self, role: str, model_path: str | None = None, model_name: str = "") -> dict:
        """chat 懒加载入口：
        1. 已 ready / 已存在 probe → 直接复用（重置空闲计时器）
        2. VRAMMonitor 预算检查：free - chat_est >= 1.0 才拉；不足 → {"ok": False, "error": "显存不足..."}
        3. 找空 port（port_start 起探测）→ start → wait_ready(startup_timeout)
        4. 成功 {"ok": True, "port":...} / 失败 {"ok": False, "error": "启动失败: ..."}（不抛异常）
        """
        # 注意：embedding 角色在 ensure 里也必须支持（T3 接线会先 ensure 再请求）

    def release(self, role: str) -> bool:
        """手动/计时器卸载 chat；embedding 不允许 release（persistent）"""

    async def shutdown(self) -> None:
        """停全部自己拉起的（embedding + chat），清 registry"""

    def status(self) -> list[dict]:
        """每实例 {role, model, port, pid, state(idle/loading/ready/unloading), vram_gb, persistent}"""
        # vram_gb 用 VRAMMonitor.sample() 的 used_gb（或 None）

    def touch(self, role: str) -> None:
        """每次 chat 请求入口调用：重置空闲计时器"""
```

**空闲计时器**：`idle_unload_min > 0` 且 chat ready 后，启动一个 `threading.Timer`（或 asyncio 任务）：
- `touch()` 时 cancel + 重启计时
- 到点 → `release("chat")` 并 `logging.info` 提示（CLI 可在 status 中显示 `unloading`）

**registry 落盘** `data/model_servers.json`：
- 每次启动/停止/状态变化后写入：`{role: {model, port, pid, state}}`
- 目的：多进程 worker（process_worker 等）读取端口直接发请求，无需知道内部状态机
- 写入用临时文件 + `os.replace`（原子），避免并发读半截

### 生命周期挂接 — `slime_server.py`

- `lifespan`（slime_server.py:184）：`yield` 之前创建 manager 并 `await manager.startup()`；
  模块级暴露 `MODEL_SERVER` 单例供路由用；`yield` 之后 `await manager.shutdown()`。
- 参考现有风格：沙箱初始化在 lifespan 内（slime_server.py:186-199）。

---

## T3. embedding 接线 — `core/memory.py`

替换 `_embed()`（memory.py:79，字符哈希占位）：

```python
def _embed(text: str) -> list[float]:
    """BGE-M3 向量（经 llama-server 8999 /v1/embeddings）；失败回退哈希占位"""
    try:
        # ensure("embedding") → POST http://127.0.0.1:8999/v1/embeddings
        #   {"model": "bge-m3", "input": text}
        # 返回 data[0]["embedding"]；若 llama-server 返回 dict 格式需按实际适配
    except Exception:
        return _hash_placeholder(text)   # 现有哈希占位逻辑改名保留（memory.py:75 注释正是此意）
```

要点：
- **降级优先**：embedding 未就绪/请求失败 → 静默回退哈希占位，绝不影响记忆读写主流程
- 维度：llama-server 返回实际维度（1024）；hash 占位保持现有维度与旧数据兼容
- 调用点已有：memory.py:301（写入）、memory.py:313（查询）——只改 `_embed` 本体即可

---

## T4. chat 接线 — `core/llm.py`

替换 `_local_model_reply()`（llm.py:566-573，当前是"阶段二占位"提示）：

```python
async def _local_model_reply(agent, ...) -> str:
    """本地 Qwen chat：懒加载 → OpenAI 兼容 /v1/chat/completions"""
    # 1. manager.ensure("chat", model_path=..., model_name="qwen2.5-3b") 
    #    （models_dir 下取第一个/配置的 gguf；未就绪 → 返回 "[本地模型加载失败: ...]"
    #     并建议 /servers 查看，不抛异常）
    # 2. 组装 payload：system prompt 用 _compose_system_prompt(agent, None, user_message)
    #    历史截断逻辑可复用 call_api_provider 中同款（max_context / 1.5 字符预算）
    # 3. POST http://127.0.0.1:{port}/v1/chat/completions {"messages": ..., "stream": False}
    #    （llama-server OpenAI 兼容；tools 字段本地 3B 可不注入，或按 registry 注入）
    # 4. _apply_filter(reply, agent) 后返回；manager.touch("chat")
```

三个入口全覆盖（调用方已留 local 分支）：
- `call_llm`（llm.py:129）→ `_local_model_reply`
- `call_llm_with_meta`（llm.py:158-166）→ 替换 `_local_model_reply` 调用为带 meta 的本地版本，
  返回 `model="local"` + 实测 tokens/elapsed_ms
- `call_llm_stream`（llm.py:742-747）→ 本地分支发 `stream: True`，按现有 chunk 格式逐块
  `yield {"type": "chunk"...}` + 收尾 `{"type": "done"...}`（对齐 call_llm_stream 的 yield 契约）

要点：
- **失败语义**：任何一步失败 → 返回含说明的文本回复（与 API 路径 `[API 调用失败: ...]` 风格一致），不崩溃
- **上下文窗口**：本地 ctx_len=8192，若 `agent.max_context > 8192` 需按 8192 截断（提示性日志）
- 记忆/技能保真：system prompt 组装路径与 API 完全一致（`_compose_system_prompt` 已含成长记忆）

---

## T5. 控制面 — CLI 命令 + HTTP 端点

### CLI（slime_cli.py）

注册 3 个斜杠命令（handlers 字典在 slime_cli.py:960-992，帮助元数据 `_CMD_SPECS` 在 ~1298 行起，
格式对齐 `/model`: `{"desc": ..., "group": ..., "usage": ...}`，并加入 `_CMD_SPECS` 一致性校验集）：

```
/servers             # 列表：每实例 {role, model, port, pid, state, vram_gb, persistent}
/servers stop chat   # 手动卸载 chat（释放显存）
/servers start chat  # 手动拉起 chat（等效 ensure）
```

- 实现走 HTTP：`GET /model-servers`、`POST /model-servers/chat/stop`、`POST /model-servers/chat/start`
  （CLI 已有 HTTP 客户端基建，见 slime_cli.py:185 `/v1/models` 调用，复用 base URL）
- 若 CLI 无法连 server（standalone 模式），提示"请先启动 server"即可

### HTTP（slime_server.py，路由区 ~slime_server.py:288-1188 追加）

```python
@app.get("/model-servers")                              # → manager.status()
@app.post("/model-servers/{role}/start")                # → ensure(role) 结果
@app.post("/model-servers/{role}/stop")                 # → release(role) 结果
```

- embedding 的 stop 返回 400（persistent 不可停，语义同 forbid_core_unload）
- 鉴权走现有机制（如有）

---

## T6. 测试 — `tests/test_model_server.py`

新建 `tests/test_model_server.py`，测试类名 `Test*`，方法 `test_*`（对齐 run_tests.py 发现规则）：

| 用例 | 验证点 | 手段 |
|---|---|---|
| `test_vram_parse` | nvidia-smi CSV 解析正确（total/used/free） | 构造样例输出字符串走解析函数 |
| `test_vram_fail_returns_none` | nvidia-smi 不可用 → None | mock subprocess.run 抛异常 |
| `test_ensure_budget_deny` | free 不足 → 拒绝且不 Popen | mock VRAMMonitor + manager |
| `test_state_transitions` | idle→loading→ready→unloading 全链路 | mock backend start/wait_ready |
| `test_idle_timer_unload` | 计时到点自动 release | 设 idle_unload_min 极小值 + sleep 或直接调计时回调 |
| `test_embed_fallback` | embedding down → 哈希占位维度正确 | mock 请求抛错 |
| `test_local_chat_error` | ensure 失败 → 返回说明文本不抛异常 | mock manager.ensure 返回 ok=False |
| `test_registry_roundtrip` | status 写入 → 重新加载端口正确 | 临时目录 |

另加**真实冒烟**（可选、手工执行）：`python -c` 脚本拉起 embedding 并 `_embed("你好")` 断言维度 1024。

运行：`python run_tests.py` → 全绿。

---

## 手工验收清单

1. 启动 server → 日志出现 embedding ready；`nvidia-smi` 确认 llama-server 进程存在（~2GB），**Qwen 静默零进程**
2. API 正常对话 → 请求走远端，完全不碰本地
3. `POST /agents/{id}/memory` 写入 → `_embed` 走 BGE-M3（可加临时日志验证），记忆 recall 正常
4. 切 `/model local` → 5-8s 内 ready → 对话保真（成长记忆/技能注入生效）
5. 空闲 10 分钟 → `nvidia-smi` 确认 chat 进程退出、显存回落；再对话自动重载
6. `/servers stop chat` → 立即卸载；`/servers start chat` → 重载成功
7. server 退出 → embedding 一并停止，`tasklist | findstr llama-server` 无残留
8. `/servers` 显示真实显存占用与状态

---

## 风险与边界（实现时守则）

- **只杀自己 Popen 的 PID**：禁止 `taskkill /IM llama-server.exe`（start_qwen.py 的全局杀法只作原型参考，不得照搬）
- **外部实例复用不误杀**：`probe()` 探测到已有实例 → 复用，status 标记 `external`
- **预算检查失败给友好提示**：不硬崩、不阻塞
- **embedding 永不自动卸**：仅 server shutdown 时停（persistent 语义）
- **降级兜底**：embedding 挂了记忆照常（哈希占位）；chat 挂了返回说明文本
- **registry 原子写**：临时文件 + `os.replace`，防多进程读半截
- **本地上下文**：ctx_len 8192 与 `agent.max_context` 冲突时按小者截断

---

## 实现评审发现（Phase 3 已实现，验收前必修）

> Phase 3 全部任务（T1-T6）已实现并与 Plan 核验。以下为代码审查发现的缺陷，
> 按严重度排列。**H1-H3、M2、M3 建议在验收前修复**，Low 级可进 backlog。

### 🔴 High

**H1 陈旧 registry 无探活 → chat 假就绪、永不自动恢复**（`core/llm.py:575-588`）
- 现状：`_local_model_reply` 读 registry 后完全信任 `state=="ready"` 的端口，不验证端口存活；
  且 server 启动（lifespan）只 ensure embedding，不探活 chat。
- 场景：server 被杀/崩溃 → registry 残留 `chat: ready, port: 18082` → 重启后用户切 local 对话
  → 读 registry 直接 POST → 连接被拒 → 返回 `[本地模型调用失败: ...]`，**永不触发 ensure 重载**
  （必须手动 `/servers start chat`），与"对话自动懒加载"承诺矛盾。
- 后果：崩溃恢复后本地对话全量失败一次、体验断崖。
- 修复：读 registry 后先 `probe_async(port)` 探活，失败则清除该条目并走 `ensure("chat")`；
  embedding 同理（`_embed` 已有哈希降级，危害较小）。

**H2 ensure() 无并发锁 → 双实例与孤儿进程泄漏**（`core/model_server.py:272-351`）
- 现状：ensure 无 `asyncio.Lock`，并发路径（多 agent 同时对话 / 多 CLI 会话 / 请求与手动 start 重叠）
  会同时通过"实例不存在"与预算检查，各自 `_find_free_port`（可能拿到不同端口）→ 拉起两个 llama-server。
- 后果：后写覆盖 `_instances/_backends` 字典 → 先启动的进程变**孤儿**（状态机与 shutdown 均管理不到，
  显存泄漏翻倍，直到手工 taskkill）；registry 被最后一次写入覆盖，状态与实际进程对不上。
- 修复：`asyncio.Lock` 包住 ensure 全程（至少 chat 分支：探测→预算→启动→wait_ready）。

**H3 LanceDB 向量维度混用 → 记忆功能静默失效**（`core/memory.py:76,317` + `_embed`）
- 现状：表 schema 按哈希占位维度 `_EMBED_DIM=384` 建（`[0.0] * _EMBED_DIM`），`_embed` 却返回
  BGE-M3 的 1024 维。embedding down 时写 384 维 → schema 定型 384；embedding 恢复后写 1024 维
  → `add()` 维度冲突抛错 → `store()` 捕获后仅 `logging.warning` 静默失败。
- 后果：**降级兜底反而弄坏 LanceDB** —— 哈希与真向量两态并存时，记忆写入/召回有一半时间静默失效，
  且旧 384 表不会自动迁移，问题具持久性。
- 修复：`_EMBED_DIM` 统一为 1024（哈希占位同维填充）；`_init_lancedb` 探测已存在表 schema 维度，
  与当前维度不一致时重建表（记忆可再生，丢失可接受）。

### 🟠 Medium

**M2 startup() 内联 await → server 启动最坏阻塞 60s**（`slime_server.py:226`）
- 现状：`await model_mgr.startup()` 直接等 embedding `wait_ready(60)`；且 `ensure` 的预算检查
  `if role == "chat"` 只查 chat，**embedding 完全不查显存**。
- 后果：GGUF 加载异常 / 显存已被占满 / 端口被占时，整个 server 启动被拖住最长 60s
  （违背 Plan"失败不阻塞 server 启动"）；满卡时 embedding 必超时后再告警。
- 修复：`asyncio.create_task(model_mgr.startup())` 后台异步拉取；embedding 也走预算检查。

**M3 `/model-servers/{role}/start` 无角色白名单**（`slime_server.py:1224-1236`）
- 现状：任意 `role` 字符串（如 `/model-servers/foo/start`）→ 按 chat 配置拉起一个新实例。
- 后果：可开多个 llama-server（预算检查仍拦总量，但绕过"单实例"语义）；registry 污染、
  `_local_model_reply` 只认 `chat` 角色导致实际对话仍不可用而显存已被吃满。
- 修复：`role` 白名单 `{"chat"}`；未知角色返回 400。

**M4 测试与项目运行器不兼容**（`tests/test_model_server.py`）
- 现状：项目规范运行器是 `python run_tests.py`（无 pytest），仅支持 `tmp_path` fixture；
  而 TestVRAMMonitor 3 个用例使用 `monkeypatch` fixture 且 `import pytest`。
- 后果：`python run_tests.py` 下这 3 个用例 `TypeError` 全部 ERROR —— 声称"12 用例"实际在
  规范运行器下是 9 过 3 错；"无 pytest 依赖"承诺被破坏。
- 修复：改用 `unittest.mock.patch.object(subprocess, "run", ...)`（两种运行器通吃）；
  `test_release_embedding_denied` 补断言；`test_registry_read_empty` 改走临时路径。

### 🟡 Low（可后置）

- **L1** `_find_free_port` 内嵌 `async def _probe` 死代码从未调用；100 端口全满时返回
  `port_start`（可能已被占用 → llama-server bind 失败 → 超时报错，可接受但可更明确）。
- **L2** chat 外部实例复用分支不可达：chat 的 port 来自 `_find_free_port()`（专找**空闲**端口），
  `probe_async` 必然失败 → "外部实例复用不误杀"语义对 chat 是假的（embedding 走固定配置端口，正常）。
  建议删除该分支或改为"从 port_start 起探测活跃实例即复用"。
- **L3** `/servers stop chat` 不检查 `_api` 返回（`slime_cli.py:893`）：实例未跑/停失败也打绿勾，
  失败原因被 `except SystemExit` 吞掉。
- **L4** `status()` 每行重复展示**全卡** vram 快照（`free_gb` 是全局值），易被误读为 per-instance
  占用；建议标注"全卡"或留空。
- **L5** 配置 `vram_budget_gb` 闲置：预算检查只用 `chat_est_gb` + 1GB 余量，用户调整 budget 无效。
- **L6** embedding 就绪只验证 `/health`，未验证 `/v1/models`：llama-server 偶发 health 先 ok 而
  embedding 端点未就绪 → `_embed` 首个请求连接重置（已有哈希降级兜底 + 下个请求自愈，可接受）。

### 修复优先级

| 优先级 | 项 | 原因 |
|---|---|---|
| 必修 | H1 H2 H3 | 真实故障场景 + 数据静默失效 |
| 同批 | M2 M3 | 启动体验 + 路由安全 |
| 可后置 | M4 L1-L6 | 工具链兼容与打磨 |

---

## 里程碑

- **M1（T1-T4）**：embedding 常驻 + chat 懒加载 + 对话保真 → 跑通验收 1-5
- **M2（T5-T6）**：命令/API/测试 → 跑通验收 6-8 + `run_tests.py` 全绿
- **M3（修复轮）**：H1-H3 + M2/M3 修复 → 评审缺陷清零后重跑验收
