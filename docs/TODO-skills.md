# Skills 系统实现记录

**日期**: 2026-08-11
**状态**: ✅ 已完成

---

## 实现内容

### 1. 新增文件

| 文件 | 说明 |
|------|------|
| `core/skill_engine.py` | 技能引擎核心模块 (344行) |
| `config/skills/code_review/SKILL.md` | 代码审查技能定义 |
| `config/skills/code_review/manifest.yaml` | 代码审查技能清单 |

### 2. 修改文件

| 文件 | 修改内容 |
|------|---------|
| `core/agent.py` | `get_system_prompt()` 注入可用技能列表 |
| `slime_cli.py` | 新增 `/skills` 命令 + `_CMD_SPECS` 注册 |
| `slime_server.py` | 新增 `GET /skills` 和 `POST /skills/load` 端点 |

---

## 架构设计

```
config/skills/
├── code_review/
│   ├── SKILL.md          # 技能说明（给LLM看的指导）
│   └── manifest.yaml     # 技能清单（权限/参数/schema）
│
└── (更多技能目录...)

core/skill_engine.py
├── SkillManifest         # 技能清单数据类
├── Skill                 # 技能实体
├── SkillRegistry         # 技能注册表（单例）
│   ├── load_skills()     # 扫描并加载
│   ├── call_skill()      # 执行技能
│   └── list_skills()     # 列出技能
└── load_all_skills()     # 加载并注册到 ToolRegistry
```

---

## 使用方式

### CLI 命令

```bash
/skills              # 查看已加载技能
/tool skill_code_review '{"path":"./xxx.py"}'  # 调用技能
```

### Server API

```http
GET /skills          # 列出所有技能
POST /skills/load    # 热更新加载技能
POST /tools/call     # 调用 skill_<name> 工具
```

### Agent System Prompt

技能自动注入到 system prompt：
```
## 可用技能
- 审查代码质量，检查潜在bug、安全漏洞和最佳实践
```

---

## 权限模型

| 权限 | 级别 | 说明 |
|------|------|------|
| `read` | L0 | 文件读取（自动批准） |
| `write` | L2 | 文件写入（需确认） |
| `terminal` | L3 | 终端执行（需确认） |
| `network` | L4 | 网络请求（需确认） |
| `system` | L5 | 系统操作（强制拒绝） |

---

## 创建新技能

1. 创建目录: `config/skills/<skill_name>/`
2. 添加 `manifest.yaml`:
```yaml
name: my_skill
description: 技能描述（≤500字符）
permissions:
  read: true
  write: false
  terminal: false
  network: false
tags: [tag1, tag2]
args_schema:
  type: object
  properties:
    path:
      type: string
      description: "目标路径"
  required: [path]
```
3. 添加 `SKILL.md`（可选，详细指导）
4. 重启 server 或调用 `POST /skills/load`

---

## 测试

```bash
python -m pytest tests/ -q
# 162 passed
```
