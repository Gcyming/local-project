# SILAM-Σ 4D 阶段完成文档

**时间**: 2026-08-27
**状态**: ✅ 完成

---

## 交付物

### 新增文件

| 文件 | 大小 | 说明 |
|---|---|---|
| `silam_core/persistence.py` | 9.2 KB | WAL + 检查点 + 崩溃恢复 |
| `tests/test_persistence.py` | 3.0 KB | 持久化测试（5 项）|

### 测试通过

```bash
pytest tests/test_persistence.py -v
# 5 passed (4 WAL/CP + 1 status line)

pytest tests/ -q
# 42 passed（37 原有 + 5 新增）
```

---

## WAL 设计

### 写入流程
```
节点变化 → WAL.append(op, step, idx, payload)
         → 写入 wal.log（JSON 行）
         → 检查大小 > 10MB？
           ├─ 是 → 触发强制检查点
           └─ 否 → 继续
```

### 检查点流程
```
should_save(step) → True
  → Checkpointer.save(dendrites, step, fear_history, lambdas)
    → 写入 keys/values/fears/dormant_*/forgotten_buffer.npy
    → 写入 meta.json
  → WAL.clear()
  → 更新 last_save_step
```

### 崩溃恢复流程
```
启动时：
  → Checkpointer.load()
    ├─ 有检查点 → 加载 .npy 文件
    └─ 无检查点 → 返回 None（从头开始）
  → WAL.replay()
    → 重放未持久化的操作
  → 恢复 step_count 和 fear_history
```

---

## 文件布局

```
~/.slimeagent/{agent_id}/brain/
├── keys.npy              # [N, 64] 树突 key 矩阵
├── values.npy            # [N, 256] 树突 value 矩阵
├── fears.npy             # [N] 节点恐惧值
├── dormant_keys.npy      # [M, 64] 休眠节点 key
├── dormant_values.npy    # [M, 256] 休眠节点 value
├── forgotten_buffer.npy  # [10000, 64] 遗忘缓冲
├── meta.json             # 元数据（步骤、权重、历史）
└── wal.log               # Write-Ahead Log（检查点后清空）
```

---

## API

### PersistenceManager
```python
pm = PersistenceManager(agent_id="default", cfg=SilamConfig())

# 生命周期回调
pm.on_grow(step, idx)
pm.on_delete(step, indices)
pm.on_hebbian(step, idx, delta)
pm.on_split(step, idx, kind)

# 保存和恢复
pm.save(dendrites, step_count)
pm.recover(dendrites) → bool
pm.should_save(step) → bool

# 状态查询
pm.status() → dict
```

### WAL
```python
wal = WAL(brain_dir, max_log_size=10*1024*1024)
wal.append("grow", step=10, idx=5, payload={"key": "test"})
entries = wal.replay()  # 返回 list[WALEntry]
wal.clear()  # 检查点后清空
```

### Checkpointer
```python
cp = Checkpointer(brain_dir, cfg)
cp.save(dendrites, step_count, fear_history, lambda_weights) → Path
data = cp.load() → dict | None
```

---

## 4D 验收标准

- [x] WAL 写入和重放
- [x] 检查点保存和加载
- [x] 崩溃恢复（检查点 + WAL 重放）
- [x] 强制检查点（WAL 达到上限）
- [x] 状态行格式验证
- [x] 单元测试通过（5/5）
- [x] 回归测试通过（42/42）

---

## 下一步：4E 灰度上线

4E 阶段需要：
1. Arbiter 仲裁器（合并 SILAM 和 Qwen 输出）
2. 状态显示行集成到 CLI
3. GUI 监控面板

详见 `docs/SILAM_INTEGRATION.md`。
