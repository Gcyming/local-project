# SILAM-Σ 集成到 Slime · 4C 阶段完成

**时间**: 2026-08-27
**状态**: ✅ 验收通过

---

## 交付物清单

### 新增文件

| 文件 | 大小 | 说明 |
|---|---|---|
| `sidecar/silam_bridge.py` | 4.3 KB | SILAM 桥接器：持有引擎单例，处理 HTTP 请求 |
| `sidecar/silam_core/` | ~50 KB | SILAM 内核完整复制（11 个模块）|
| `tests/test_silam_integration.py` | 2.4 KB | 端到端集成测试（4 项）|
| `docs/SILAM_INTEGRATION.md` | 本文档 | 集成文档 |

### 修改文件

| 文件 | 改动 | 说明 |
|---|---|---|
| `sidecar/infer_server.py` | +80 行（403 行总计）| 新增 4 个端点：/silam/health, /silam/inference, /silam/save, /silam/status |
| `slime.toml` | +6 行 | 新增 `[silam]` 配置段 |
| `data/backbone_v1.npz` | 670 KB | 蒸馏权重（从 D:\pilot model\ 复制）|

### 未修改（遵守承诺）

- ❌ `core-ts/` 全部未动
- ❌ `gui/` 全部未动
- ❌ `gateway-ts/` 全部未动
- ❌ `core/` 全部未动
- ❌ 现有 sidecar 路由全部保留

---

## 测试验收

### 单元测试
```bash
cd "D:/pilot project"
py -m pytest tests/test_silam_integration.py -v
# 4 passed in 14.53s
```

### 回归测试（SILAM-Σ 内核）
```bash
cd "D:/pilot model"
pytest tests/ -q
# 37 passed in 1.69s
```

### 端到端测试
```bash
# 启动 sidecar
py sidecar/infer_server.py

# 测试端点
curl http://localhost:19100/silam/health
curl -X POST http://localhost:19100/silam/inference -H "Content-Type: application/json" -d '{"request_id":"t1","type":"inference","payload":{"state_text":"测试"}}'
curl http://localhost:19100/health  # 原有端点，确认未被破坏
```

**结果**: ✅ 全部通过

---

## 新增 API 端点

### GET /silam/health
```json
{"status": "ok", "service": "silam", "agent_id": "default", "step": 9, "n_nodes": 4, "fear": 0.0, "desire": 0.4}
```

### POST /silam/inference
请求体（§8.1 协议）：
```json
{"request_id": "uuid", "type": "inference", "payload": {"state_text": "...", "fear_level": 0.5}}
```

响应体（§8.2 协议）：
```json
{"request_id": "uuid", "status": "success", "payload": {"tool_call": {...}, "new_fear": 0.5, "n_nodes": 4, ...}}
```

### GET /silam/status
查询当前 SILAM 状态。

### POST /silam/save
强制持久化大脑参数。

---

## 配置说明

### slime.toml [silam] 段
```toml
[silam]
enabled = true                    # 开关（默认 false）
agent_id = "silam-default"        # Agent ID
backbone_path = "data/backbone_v1.npz"  # 蒸馏权重路径
max_nodes = 200000                # 树突节点上限
```

### 环境变量
- `SILAM_AGENT_ID`: 覆盖 agent_id
- `SILAM_BACKBONE_PATH`: 覆盖 backbone_path

---

## 非破坏性保证

1. **默认关闭**: `[silam] enabled = false`，现有功能完全不受影响
2. **延迟初始化**: `_init_silam_bridge()` 在首次请求时调用，不阻塞启动
3. **导入容错**: ImportError 时降级为 warning 日志，不 crash
4. **端口隔离**: SILAM 端点在 `/silam/*` 路径下，与现有端点完全隔离
5. **配置隔离**: 所有 SILAM 配置在 `[silam]` 段，与现有配置互不干扰

---

## 4D 阶段：持久化（WAL + 检查点 + 崩溃恢复）✅ 已完成

4D 在 4C 基础上补齐大脑状态持久化（原 `save` 端点为最小版直接写 .npy）：

- **新增**：`silam_core/persistence.py`（WAL + 检查点 + 崩溃恢复）+ `tests/test_persistence.py`（5 项）。
- **WAL**：节点变化 → `WAL.append(op, step, idx, payload)` 写 `wal.log`（JSON 行），超 10MB 触发强制检查点。
- **检查点**：`should_save(step)` 命中时 `Checkpointer.save` 写 `keys/values/fears/dormant_*/forgotten_buffer.npy` + `meta.json`，随后 `WAL.clear()`。
- **崩溃恢复**：启动时 `Checkpointer.load()`（有则加载 .npy，无则从头）→ `WAL.replay()` 重放未持久化操作 → 恢复 `step_count` 与 `fear_history`。
- **验证**：`pytest tests/test_persistence.py` 5 passed；回归 42 passed（37 原有 + 5 新增）。

**下一步（4E 灰度上线）**：Arbiter 仲裁器（合并 SILAM 与 Qwen 输出）、状态显示行集成 CLI、GUI 监控面板。

---

## 文件统计

```
sidecar/silam_bridge.py          117 行
sidecar/infer_server.py          +80 行（总计 403 行）
tests/test_silam_integration.py   94 行
docs/SILAM_INTEGRATION.md         本文档
silam_core/                      ~50 KB（11 模块）
data/backbone_v1.npz             670 KB
```

**总新增代码量**: ~290 行 Python + 670 KB 权重数据

---

## 验收签字

- [x] 4C 集成代码已落地
- [x] 单元测试全部通过（4 passed）
- [x] 回归测试全部通过（37 passed）
- [x] 端到端测试通过（health/inference/status/save）
- [x] 原有功能未受破坏（/health 正常）
- [x] 文档已更新

**阶段状态**: ✅ 完成
