# Slime `/` 命令系统 — 待修复问题清单

> 所有问题已修复，本文件留作历史记录。

---

## 已完成（2026-08-11）

| # | 问题 | 状态 |
|---|------|------|
| 1 | `/history` 默认 10 条 → 改为 40 条 | ✅ |
| 2 | `/model` 切换后 context_max 不刷新 | ✅ 前后端打通 |
| 3 | `/export` 导出不完整 | ✅ 改为从 server 拉取全量 |
| 4 | 前缀匹配用 handlers 而非 _CMD_SPECS | ✅ 已修复 |
| 5 | difflib 模糊匹配不准 | ✅ 多候选直接列出 |
| 6 | `/provider` vs `/providers` 混淆 | ✅ 统一到 `/provider [list\|del]` |
| 7 | `/?` 缩写未实现 | ✅ 已添加 |
| 8 | `/tool` 二次交互 | ✅ 支持一行式 JSON 参数 |
| 9 | _CMD_SPECS 和 handlers 不同步 | ✅ 添加一致性校验 |
| 10 | 记忆系统无写操作 | ✅ 添加 `/memory add` |
