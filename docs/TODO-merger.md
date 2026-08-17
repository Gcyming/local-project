# Merger 试运行验证完善记录

**日期**: 2026-08-11
**状态**: ✅ 已完成

---

## 实现内容

### 原有问题
- `trial_run()` 只有基础检查（错误/风险/摘要是否存在）
- 无一致性检查、完成度评估、质量评分
- 无 LLM 参与的质量评估

### 新增功能

| 功能 | 说明 |
|------|------|
| 一致性检查 | 检测子任务结果间的矛盾（正面/负面关键词冲突） |
| 完成度评分 | 基于摘要长度和子任务成功率计算 0-1 分 |
| 质量评分 | 0-10 分，可由 LLM 评估或默认 5 分 |
| 综合判断 | 加权计算：质量40% + 完成度30% + 一致性30% |
| 异步兼容 | `_run_trial_sync()` 处理各种事件循环场景 |

### 修改文件

| 文件 | 修改 |
|------|------|
| `core/merger.py` | 重写 `trial_run()`，新增 `_run_trial_sync()` |
| `core/executor.py` | `finalize()` 调用传入 `llm_fn` |
| `tests/test_merger.py` | 20 个新测试用例 |

---

## 验证维度

```
试运行验证 (trial_run)
├── 维度 1: 基础检查
│   ├── 有错误？ → 失败
│   ├── 有高风险？ → 失败
│   └── 有摘要？ → 失败
├── 维度 2: 一致性检查
│   ├── 子任务结果关键词冲突？
│   └── 正面/负面比例 > 50% → 警告
├── 维度 3: 完成度检查
│   ├── 摘要长度评分 (0-1)
│   └── 子任务成功率 (0-1)
└── 维度 4: 质量评分 (0-10)
    └── 可选：LLM 评估
```

---

## 测试结果

```
pytest tests/test_merger.py -v
======================== 20 passed in 0.09s ========================
```

---

## 使用示例

```python
from core.merger import Merger

merger = Merger("task-001", "实现用户认证系统")

# 同步调用（推荐）
result = merger.finalize(summary, subtasks, llm_fn=None)
print(f"通过: {result.trial_passed}")
print(f"评分: {result.trial_score}/10")
print(f"结论: {result.final_verdict}")

# 带 LLM 质量评估
async def llm_eval(prompt):
    return "8"  # LLM 返回评分

result = merger.finalize(summary, subtasks, llm_fn=llm_eval)
```
