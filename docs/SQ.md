# Slime 项目待处理事项（Small Issues）

> 生成时间：2026-08-12  
> 状态：跳过/暂缓（非紧急，不影响核心功能）  
> 来源：第九轮漏洞核查 + 196 pass 测试验证

---

## 一、架构级变更（需系统性改造）

### K11. history TOCTOU 竞态
- **位置**：`core/history.py:26-62`
- **问题**：`append()` 与 `pop_last()` 无锁保护，存在竞态条件
- **影响**：并发场景下历史记录可能丢失或重复
- **修复方案**：引入文件锁（fcntl/flock 或 Windows LockFileEx）
- **跳过理由**：单线程同步操作，当前架构低概率触发；需系统性改造并发模型
- **优先级**：P3（当需要并发写入时处理）

---

## 二、性能优化（当前量级不触发）

### L9. create_task 无并发上限
- **位置**：`slime_server.py:716`
- **问题**：`asyncio.create_task(_post_process_chat(...))` 无引用保存、无并发限制
- **影响**：高并发场景可能耗尽内存/连接池
- **修复方案**：
  ```python
  # 方案A：信号量限流
  _post_process_semaphore = asyncio.Semaphore(10)
  
  # 方案B：任务池管理
  _pending_tasks: set = set()
  task = asyncio.create_task(_post_process_chat(...))
  _pending_tasks.add(task)
  task.add_done_callback(_pending_tasks.discard)
  ```
- **跳过理由**：当前个人使用场景并发量低，不会触发资源耗尽
- **优先级**：P3（监控到并发瓶颈时处理）

---

## 三、设计一致性（功能正确但结构不统一）

### L16. add_skill 双写 skills_unlocked
- **位置**：`core/memory.py:250-255`
- **问题**：`add_skill()` 仍写入旧字段 `skills_unlocked`，与统一 facts 结构不一致
- **影响**：数据冗余，但不影响功能（skills 是独立列表，不需要语义搜索）
- **修复方案**：
  - 迁移：将所有 `skills_unlocked` 条目转为 `facts` 中的 `category="skill"`
  - 删除旧字段和 `get_skills()` 方法
- **跳过理由**：功能正确，skills 不需要去重/语义检索，双写无实质危害
- **优先级**：P4（重构记忆结构时一并处理）

---

## 四、可接受边界（业务允许的损失）

### L22. 审计轮转重启清空
- **位置**：`core/sandbox.py:819-839`
- **问题**：审计轮转仅按内存 `_audit_log` 重写文件，重启后保留期内条目丢失
- **影响**：重启后审计日志不完整
- **修复方案**：
  - 轮转时从磁盘读取而非内存
  - 或使用 WAL（Write-Ahead Log）模式
- **跳过理由**：审计日志主要依赖内存缓冲，重启是正常维护操作；业务允许短期审计窗口
- **优先级**：P4（需要完整审计追溯时处理）

---

## 处理建议

| 批次 | 条目 | 触发条件 |
|---|---|---|
| 1 | K11 | 需要并发写入 history 时 |
| 2 | L9 | 监控到并发 >10 或 OOM |
| 3 | L16 | 记忆结构重构时 |
| 4 | L22 | 需要完整审计追溯时 |

---

## 相关文档

- 主漏洞清单：`docs/BUGS.md`
- 测试报告：`tests/` 目录
- 本轮核验：196 pass，S1/S2 全部清零
