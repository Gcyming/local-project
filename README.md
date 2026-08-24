# pilot project

slime 长存架构对外仓库（完整架构见 `docs/长存架构规划.md` v2.2）。

本仓库按「隐藏核心引擎源码」策略仅发布 **GUI 壳 / 文档 / 配置模板 / 部署脚本**：

- **核心引擎源码（核心知识产权）不随仓库发布**：core/、core-ts/、gateway-ts/、tools/、social/、sidecar/、skills/ 等由 `.gitignore` 锁定，遵循"能由工具再生成的一律不入库"黄金法则
- **GUI 壳**（Electron + React + TypeScript）见 `gui/`；Windows/Linux 部署脚本见 `windows/`、`linux/`
- 数据契约冻结：`Knowledge/`、`data/`、`config/` schema 不随迁移改变
- 敏感文件零入库（§8.5 打包门禁 + .gitignore 双保险）
- Windows 打包成品生成于本地 `gui/release-final/`（构建产物，不入库）