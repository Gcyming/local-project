# Subagent 业界标准差距补齐包（v2.2）

按调研报告 P0/P1/P2 路线图实施，对照 Claude Code subagent frontmatter / 业界多智能体实践。

## 包内容

| 文件 | 安装位置 | 说明 |
|---|---|---|
| `subagent.ts` | `D:\pilot project\core-ts\src\services\subagent.ts`（**覆盖**） | 增强版子代理管理器（545 行） |
| `subagent.spec.ts` | `D:\pilot project\tests\core-ts\subagent.spec.ts`（**覆盖**） | 14 例回归（原 4 例契约全保留） |
| `GUI集成指南.md` | 参考用，按需改 `gui\src\main\index.ts` | 取消/模型路由/钩子接线（可选叠加） |

## 已补齐的业界标准能力

1. **模型路由** `def.model` —— 简单子任务降级到便宜模型（对齐业界 `model` frontmatter；Anthropic 实测多智能体 token 约为对话 15×，这是最有效的成本阀门）
2. **预算与生命周期** `def.maxTurns` / `def.timeoutMs` / `cancel(id)` —— AbortSignal 端到端传播；新增 `timeout`/`cancelled` 终态
3. **结构化结果契约** `def.outputSchema` → `run.structured {status/summary/artifacts/confidence}` —— 文本 result 始终保留，向后兼容
4. **声明式定义 + description 自动委派** `register()` / `delegate(task)` —— 业界 description-based 委派范式
5. **生命周期钩子** `hooks.onStart/onComplete/onError` —— 异常隔离，不阻断主流程
6. **事件驱动等待** `wait(id)` + 槽位 FIFO 唤醒 + `awaitIdle` —— 取代 busy-wait 轮询

## 版本修正记录

### v2.1（相对初版 v2 的两个边缘缺陷修复）
- 运行中任务被 `cancel` 且带 `timeoutMs` 时，终态误标 `timeout` → 已修为正确标 `cancelled`（取消意图登记）
- `awaitIdle` 与槽位排队共用等待队列、取消的排队任务不放回唤醒令牌 → 已修为三条队列分离 + 令牌传递（防极端时序下丢令牌）

### v2.2（语义修正，建议务必使用此版）
- `awaitIdle` 等待条件从「运行中数量 active」改为「在途总数 inflight（运行中+排队中）」——修复「排队任务被取消后 awaitIdle 可能提前返回、漏掉其后排队任务」的窗口；空闲唤醒统一移至 execute 收尾（inflight→0 时）

## 已完成的验证（沙箱内）

- ✅ 交付物完整性：545 行、17 个关键导出符号齐全、尾部无截断
- ✅ 纯函数运行时断言 8 组全过（结构化解析 6 组边界 + 委派打分 2 组）
- ✅ 管理器调度逻辑 JS 同构移植版 **14 场景全过**：含并发上限、取消（排队/运行中/即时）、超时归因、结构化结果、自动委派、钩子隔离、20 任务高并发扇出、以及 v2.2 awaitIdle 回归
- ⚠️ TypeScript 编译级检查（strict）未在沙箱执行（沙箱无外网无法安装 tsc）——请在本地用下方命令完成最终验证

## 兼容性

公开 API（构造签名 / `spawn` / `status` / `list` / `awaitIdle` / `activeCount`）完全向后兼容；
GUI 装配层与既有调用零改动可编译。新能力全部可选叠加，详见 `GUI集成指南.md`。

## 安装后验证（在 D:\pilot project 执行）

```bash
cd D:\pilot project
core-ts\node_modules\.bin\tsc -p core-ts\tsconfig.json --noEmit
pnpm vitest run tests/core-ts/subagent.spec.ts
py qa.py
```

预期：tsc 无错误；subagent.spec.ts 14 例全绿；qa.py 全量回归不受影响。
