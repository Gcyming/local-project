# pilot project

双栈迁移成品仓库（slime 长存架构，见 `docs/长存架构规划.md` v2.2）。

- Node 主控（core-ts / gateway-ts / Electron gui）+ Python sidecar（py/ 推理 + 四阶段检索）
- 数据契约冻结：`Knowledge/`、`data/`、`config/` schema 不随迁移改变
- 敏感文件零入库（§8.5 门禁 + .gitignore 双保险）