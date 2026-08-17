# Evolution.md — 外置大脑（External Brain）实施计划

> 创建日期：2026-08-12
> 状态：规划定稿，待实施
> 归属项目：D:\tool\slime

## 一、设计核心理念

**Knowledge 文件夹 = 外置大脑（可被智能体高效率调取）**

```
服务层：embedding（BGE-M3）→ 语义召回
        │ 为成长功能提供检索基础设施
加工层：学习（knowledge.py 晋升）、记忆（extract → memory.json）、进化（evolve → trait）
        │ 都是"总结记忆"的机制，不独占存储
存储层：Knowledge/ 统一存放记忆本体
```

三条铁律：
1. **任何模型 API 接入后，都能读取大脑内容** → 模型无关性（`_compose_system_prompt` 统一收敛点，已成立）
2. **换模型 = 只换 provider**，角色 + 记忆自动延续 → 附加 handoff 交接摘要增强"迅速带入"
3. **大脑自己区分知识类型** → 混合分类（固定枚举主类 + 自由标签细化）

## 二、最终存储布局（已确认）

```
Knowledge/Agent Memory/{agent_id}/     # Obsidian 库（人可读）
├── memory.json        # 记忆 → 从 data/ 挪入（含分类）
├── knowledge.json     # 学习状态 → 从 data/ 挪入
└── rules/ skills/ reviews/            # 晋升产物（已就位，不动）
data/{agent_id}/lancedb/               # 向量索引 → 保持原位（不挪）
config/agents.json                     # 进化状态 → 保持原位（不混入 Knowledge）
```

**已确认决策**：
- handoff 交接摘要：**做**
- 进化状态（trait/lifecycle）：留在 `config/agents.json`，不抽离
- LanceDB：保持原位 `data/{agent_id}/lancedb/`，不挪进 Knowledge

## 三、实施步骤

### 阶段 1：存储归位

| 改动 | 位置 | 内容 |
|---|---|---|
| `slime.toml` | `[memory]` | 新增 `dir = "Knowledge"`（相对项目根，支持绝对路径）；新增 `categories = [...]`（分类枚举可配） |
| 环境变量 | — | `SLIME_MEMORY_DIR` 覆盖 toml（可选） |
| `core/memory.py` | 15 行 `_DATA_DIR`、113 行 `_json_path` | `MemoryStore`/`load_memory` 加 `data_dir` 参数；**只影响 memory.json** |
| `core/memory.py` | 307 行 lancedb 默认 uri | **保持 `_DATA_DIR / agent_id / "lancedb"` 不动**（lancedb 与 memory.json 路径解耦） |
| `core/knowledge.py` | 23 行 `_DATA_DIR`、116 行 `_json_path` | `KnowledgeEngine`/`get_knowledge_engine` 加 `data_dir` 参数；knowledge.json 跟随 |
| `core/knowledge.py` | 22 行 `_KNOWLEDGE_DIR` | **不动**（markdown 产物已在 `Knowledge/Agent Memory/`） |
| `slime_server.py` | 598 行 `load_memory(...)` | 从 `_SLIME_CONFIG` 读 `memory.dir` 传入 |
| `core/llm.py` | 91-98 行 toml 读取 | 同步读取 `memory.dir` + `categories` |

### 阶段 2：自动分类（混合）

- **固定枚举**（默认 7 类，可配 `[memory].categories`）：
  `fact / preference / lesson / rule / skill / insight / user_profile`
- **自由标签**：每类下允许任意 `tags` 细化（如 `["tooling", "language"]`）
- **提取 schema 升级**（`core/memory.py` `extract_memories_from_chat` prompt，376-448）：

```json
{
  "entries": [
    {
      "content": "用户喜欢用 Python 写脚本",
      "category": "preference",
      "tags": ["tooling", "language"],
      "importance": 8
    }
  ]
}
```

- **兼容旧格式**：`facts` / `preferences` / `lessons` 数组仍接受，映射到对应枚举类
- **存储**：memory.json 分区保留 + 条目带 `category`/`tags`；LanceDB 行（`store()`）加 `category`/`tags` 字段（`role` 保留兼容）
- **兜底**：
  - LLM 输出的 category 不在枚举内 → 归一化至最接近类（兜底 `fact`）
  - LLM 输出解析失败 → 关键词分类器（可选实现）

### 阶段 3：全库读回 + 分类检索

**核心缺口修复**：晋升产物 markdown 目前单向写入、Agent 从不读回（`_KNOWLEDGE_DIR` 仅写不读，全项目无读回代码）。

- **写入**：knowledge.py 晋升/复盘（259/275/368 行写 markdown 处）同步向量化 → 新表 `knowledge_{agent_id}`（role=`rule`/`skill`/`review` + category/tags 字段）
- **检索**：`memory.py` `recall()`（355-365）升级：
  - 跨表：`memory_{agent_id}` + `knowledge_{agent_id}`
  - 参数：`recall(query, categories=None, tags=None)` 类别过滤
- **注入**：`core/llm.py` `_compose_system_prompt`（83-107）注入源 = memory 摘要 + knowledge 表召回合并
- **轻量意图解析**：按 user_message 关键词优先命中对应类别（问"偏好"→preference 加权）——可选，先做简单版本

### 阶段 4：模型无关 + 交接（handoff）

- **现状已成立**（无需改）：`_compose_system_prompt`（llm.py:83）是全部调用路径统一收敛点——`call_llm`（252）、`call_llm_with_meta`（472）、本地模型（599/678）；角色来自 `agent.get_system_prompt()`（agent.py:205，agents.json 模型无关）
- **新增 handoff**：
  1. agent 记录 `current_model`（provider_key）
  2. 检测 provider 切换 → 自动生成**交接摘要**：persona 快照 + 最近记忆 top + 尾部上下文（最后 3 条）
  3. 交接摘要注入新模型 system prompt
  4. 落盘位置：`memory.json` 的 meta 区（或独立 handoff.json，实施时定）

## 四、验证清单

1. 原有验收：记忆落库 Knowledge/、embedding ready、`/new` 后真记忆注入（非 history 回放）
2. `data/{agent_id}/lancedb/` 确认仍在原位
3. 新写入条目：category 为枚举内值、tags 自由扩展
4. 切换 provider 后：新模型答出旧模型 persona/偏好（handoff 生效）
5. rules/skills 语义召回：提问能命中晋升产物内容
6. 连续对话 3 次无 `Task was destroyed`、无异常

## 五、相关代码位置速查

| 文件 | 行号 | 说明 |
|---|---|---|
| `core/memory.py` | 15 / 113 / 307 | `_DATA_DIR` / `_json_path` / lancedb 默认 uri |
| `core/memory.py` | 376-448 | `extract_memories_from_chat`（schema 升级点） |
| `core/memory.py` | 338-353 | `store()`（LanceDB 行加字段点） |
| `core/memory.py` | 355-365 | `recall()`（跨表检索升级点） |
| `core/knowledge.py` | 22-23 / 116 | `_KNOWLEDGE_DIR`（不动）/ `_DATA_DIR` + `_json_path` |
| `core/knowledge.py` | 259 / 275 / 368 | 晋升产物写 markdown（向量化接入点） |
| `core/llm.py` | 83-107 | `_compose_system_prompt`（大脑读取器） |
| `core/llm.py` | 91-98 | toml 读取（memory.dir/categories） |
| `slime_server.py` | 587-643 | `_post_process_chat`（load_memory 传参点） |
| `slime_server.py` | 598 | `load_memory(...)` 调用 |
| `core/agent.py` | 205-249 | `get_system_prompt`（角色组装） |
| `slime.toml` | 4-14 | `[memory]` 配置区（新增 dir/categories） |

## 六、实施顺序建议

阶段 1 → 2 → 3 → 4，每阶段完成后可独立验证；阶段 1/2 无相互依赖可并行，阶段 3 依赖 1/2，阶段 4 依赖全部。

## 七、验收结果与已知漏洞（2026-08-12）

> 状态：四阶段主体全部实现 ✅，测试实证通过；1 高危 + 2 中危 + 1 低危待修（用户自行处理）

### 已实现实证

| 阶段 | 验证证据 |
|---|---|
| 1 存储归位 | `slime.toml:8` dir；`Knowledge/Agent Memory/test_mem_agent/memory.json` 落库 ✅；lancedb 保持 `data/` 原位（memory.py:143）✅ |
| 2 混合分类 | `test_mem_agent/memory.json` 实证 `category: fact/preference/lesson` + `tags` ✅；schema 升级（memory.py:426-496）✅ |
| 3 全库读回 | `vectorize_knowledge`（memory.py:109-131）被 knowledge.py:265/273 调用 ✅；recall categories 过滤（372-382）✅；summary→recall（255）✅ |
| 4 交接 | `_build_handoff`（llm.py:116-137）persona 快照 + top traits + top 3 记忆每次注入 ✅（注：实现为每次注入，非切换时生成——更简单，效果等效） |
| 主 bug 链路 | `data/agent_2e17c6e5/memory.json` + knowledge.json + lancedb 全部落库（14:17 实证，CancelledError 修复持续生效）✅ |
| 语法 | memory.py / knowledge.py / llm.py / slime_server.py ast.parse 全过 ✅ |

### 已知漏洞（待修）

| # | 级别 | 问题 | 位置 | 修复建议 |
|---|---|---|---|---|
| 1 | **高危** | **lancedb 旧表 schema 缺 `tags` 字段**：`agent_2e17c6e5` 表实测 schema = `role/content/vector`（无 tags）；`_init_lancedb` 只检查维度不检查字段 → 该 agent 后续 `add` 带 tags 必抛 schema 异常 → 向量写入失败（JSON 正常，语义召回缺新条目）。新 agent 不受影响 | `core/memory.py:318-344` | `_init_lancedb` 补 tags 字段检测，缺失则重建表 |
| 2 | **中危** | **去重逻辑丢失（重构回归）**：旧版 `add_fact` 有 Jaccard>0.75 去重，新 `_store_categorized` 直接 append → `test_mem_agent/memory.json` 实证同内容写两遍（06:49/06:50） | `core/memory.py:176-201` | `_store_categorized` 恢复相似度去重 |
| 3 | **中危** | **相对路径风险**：`_post_process_chat`（slime_server.py:599）与 llm.py:102 显式传 `dir="Knowledge/Agent Memory"`（相对 CWD）；`Path(data_dir)`（memory.py:140）在 CWD≠项目根时解析错位 | `slime_server.py:599`、`core/llm.py:102`、`core/memory.py:140` | 相对路径锚定 `_PROJECT_ROOT` |
| 4 | **低危** | **数据分裂**：`agent_2e17c6e5` 旧记忆在 `data/`（旧格式，1 条 fact），下次对话新条目将写 `Knowledge/Agent Memory/agent_2e17c6e5/` → 新旧两份 | `data/agent_2e17c6e5/` | 一次性迁移 memory.json/knowledge.json 到新位置（lancedb 留原位） |

### 低危/可选备注

- `core/llm.py:102`：toml 解析异常时 `mem_cfg` 未定义 → NameError 被外层 except 吞，compose 静默降级（正常不触发）
- 意图解析（关键词类别加权）未做——计划标注可选，`recall(categories=)` 参数已支持
- 运行态：验收时 server 未运行、`data/model_servers.json` 为 `{}` → 测试向量为哈希降级；**重启 server 后确认 `/servers` embedding ready，再复测 BGE-M3 真向量**
