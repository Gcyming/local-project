# slime 阶段二实施清单

**项目路径**: `D:\tool\slime\`
**目标**: 实现记忆、进化、上下文压缩、工具注册、社交接入等核心能力

---

## 一、核心模块开发

### 1.1 记忆系统 (`core/memory.py`)
- [ ] **成长型 JSON 记忆**
  - 结构: `facts` / `preferences` / `skills_unlocked` / `lessons`
  - 路径: `data/{agent_id}/memory.json`
  - 不存原始对话，只存"学到了什么"
  
- [ ] **LanceDB 可选接口** (开关控制)
  - 接口抽象: `store(role, content)` / `recall(query, top_k=5)`
  - 默认关闭，`slime.toml` 中开启才加载 LanceDB
  - fallback: LanceDB 失败时降级到 JSON 存储
  
- [ ] **对话历史分离**
  - 原始对话 → `history.jsonl` (已实现)
  - 成长摘要 → `memory.json` (新建)

### 1.2 上下文压缩 (`core/context.py`)
- [ ] **Per-Agent 压缩引擎**
  - 配置: `head=3` / `tail=10` / `window=30`
  - 保留前 N 条 + 后 M 条完整
  - 中间部分用 LLM 摘要
  - 注入压缩提示: "以下是之前对话的摘要..."
  
- [ ] **Agent 独立配置**
  - `agent.context_config` 字段
  - 全局默认: `{"head": 3, "tail": 10, "window": 30}`
  - 可在 `/context` 命令中修改

### 1.3 演化引擎 (`core/evolve.py`)
- [ ] **强化/弱化/遗忘机制**
  - 成功经验 → 强化 traits
  - 失败经验 → 弱化或修正
  - 长期无用 → 遗忘 (30 天阈值)
  
- [ ] **生命周期状态机**
  ```python
  class AgentLifecycle(Enum):
      BIRTH = "birth"          # 刚创建，空人格
      GROWTH = "growth"        # 对话积累中
      SPECIALIZING = "specializing"  # 开始专业化
      MATURITY = "maturity"    # 人格稳定
      WISE = "wise"            # 经验老道
      DYING = "dying"          # 不再活跃
      DEATH = "death"          # 归档不删除
  ```
  
- [ ] **身份保护区**
  - `identity_prompt` / `name` / `role` 永不被演化引擎修改
  - 演化只作用于 `traits` / `preferences` / `skill_ownership`

### 1.4 工具注册表 (`tools/registry.py`)
- [ ] **运行时工具注册**
  ```python
  class Tool:
      name: str
      description: str
      parameters: dict  # JSON Schema
      async def execute(self, args: dict) -> str: ...
  
  class ToolRegistry:
      tools: dict[str, Tool] = {}
      
      def register(self, tool: Tool): ...
      def list_tools(self) -> list[dict]: ...
      async def call_tool(self, name: str, args: dict) -> str: ...
  ```
  
- [ ] **LLM 统一 Schema**
  - 所有工具汇入注册表
  - LLM 只见统一格式，不感知具体实现

### 1.5 社交适配器 (`social/base.py`)
- [ ] **适配器接口**
  ```python
  class SocialAdapter:
      async def receive(self, message: str) -> str: ...
      async def send(self, chat_id: str, text: str) -> None: ...
  ```
  
- [ ] **微信企业号实现** (`social/wechat.py`)
  - webhook 接收
  - 消息路由
  - 回复发送

---

## 二、配置文件

### 2.1 slime.toml
- [ ] **功能开关**
  ```toml
  [memory]
  enabled = false          # 默认关闭
  backend = "json"         # json | lancedb
  
  [evolve]
  enabled = true
  forget_threshold_days = 30
  
  [context]
  head = 3
  tail = 10
  window = 30
  
  [social]
  wechat_webhook_url = ""
  ```

---

## 三、现有模块修改

### 3.1 core/agent.py
- [ ] 增加 `lifecycle` 状态字段
- [ ] `identity_prompt` 保护区已实现，需验证不被 evolve 修改
- [ ] 增加 `context_config` 字段

### 3.2 core/persona.py
- [ ] 增加 `evolve()` 方法
- [ ] 增加 `forget_stale()` 方法
- [ ] 增加 `strength_trait()` / `weaken_trait()` 方法

### 3.3 slime_server.py
- [ ] 接入 `memory.py` (GET/POST /memory)
- [ ] 接入 `context.py` (GET/PATCH /context)
- [ ] 接入 `evolve.py` (GET /evolve)
- [ ] 接入 `tools/registry.py` (GET /tools, POST /tools/call)
- [ ] 接入 `social/base.py` (POST /social/webhook)

### 3.4 slime_cli.py
- [ ] 集成 `history_append()` 到 `_chat_loop`
- [ ] 新增 `/memory` 命令
- [ ] 新增 `/evolve` 命令
- [ ] 新增 `/tools` 命令

---

## 四、验收标准

### 4.1 记忆系统
- [ ] `memory.json` 随对话自动更新
- [ ] 可检索相关记忆
- [ ] LanceDB 开关生效

### 4.2 上下文压缩
- [ ] 对话超过 window 时自动压缩
- [ ] 压缩后 LLM 仍可正常响应
- [ ] Per-Agent 配置独立

### 4.3 演化引擎
- [ ] 人格 traits 随交互演化
- [ ] 生命周期状态正确转换
- [ ] `identity_prompt` 不被修改

### 4.4 工具注册表
- [ ] 可动态注册工具
- [ ] LLM 可调用工具
- [ ] 统一 Schema 输出

### 4.5 社交接入
- [ ] 微信 webhook 可接收消息
- [ ] Agent 回复可发送回微信

---

## 五、执行顺序

```
1. memory.py      → 记忆系统基础
2. context.py     → 上下文压缩
3. evolve.py      → 演化引擎
4. tools/registry.py → 工具注册表
5. social/base.py → 社交适配器
6. slime.toml     → 配置开关
7. 修改现有模块   → 集成
```

---

## 六、关键约束

1. **记忆不存原始对话**，只存成长摘要；原始对话走 `history.jsonl`
2. **LanceDB 可选**，默认关闭，开关在 `slime.toml`
3. **identity_prompt 保护区**：演化引擎不可修改
4. **工具默认只读沙箱**：写文件/命令/网络需 manifest 声明 + 用户确认
5. **多进程分裂**：每个子 Agent 独立 Python 进程，通过 A2A 总线通信
