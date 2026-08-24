# AGENTS.md — slime 平台的 Agent Git 行为硬契约

> **必读，强制生效**。本文件是 slime 平台上所有 Agent（包括主 Agent、分裂产生的子 Agent、技能调度 Agent、Swarm Worker）
> 操作本仓库版本控制时的**最高规则**，高于任何 LLM 训练数据中的通用 Git 知识。Agent 启动时读取本文件；
> 在执行任何 `git_*` 工具前、在产生任何"提交版本"的意图前，必须完全遵守下列条款。
> 人类维护者若希望改变平台的 Git 治理策略，**只应编辑本文件**，不要直接改代码。

---

## 0. 身份铁律在 Git 层的延伸（CLAUDE.md §核心设计原则第一条）

1. Agent **绝不冒充人类作者**。任何由 Agent 生成或 Agent 参与修改的 commit，`author` 必须是 Agent 身份，而不是人类维护者的 GitHub 账号。
   - Author 格式（Git 工具层会自动注入，禁止 Agent 传参覆盖）：
     ```
     slime-{agent_id} <agent+{agent_id}@slime.local>
     ```
   - 当 Agent 完全基于人类已提供的上下文改代码时，可**额外**添加一条 `Co-Authored-By:` trailer 把人类维护者记录为共同作者，但 `author` 仍必须是 slime-agent 身份。
2. "我是 {name}，{role}"这条身份声明**必须**出现在 commit message 正文首行之前（Agent 身份头），除非该 commit 属于 `chore(meta):` 纯元数据。

---

## 1. 分支命名与工作隔离

1. **禁止 Agent 直接在 `main`、`master`、`release/*`、`production`、`hotfix/*` 这些受保护分支上写代码**。Agent 只允许在 `slime/*` 前缀的分支内直接 commit，或本地私有分支 commit。
2. Agent 新建分支的统一命名规范（Git 工具层会强制校验）：
   ```
   slime/{agent_id}/{task_slug}
   slime/{agent_id}/subtask/{subtask_index}-{slug}
   slime/swarm/{session_id}/{worker_id}
   slime/tmp/{agent_id}/{timestamp}
   ```
   - `agent_id` / `session_id` / `worker_id` 均由 Agent 框架自动注入，禁止 Agent 擅自编造
   - `task_slug`：用 `-` 连接、小写 ASCII 字母数字，≤ 48 字符
3. **多 Agent 并发（分裂/Swarm 并行 SubWorker）时禁止同一工作目录同时写代码**。必须使用 `git worktree` 机制：
   - 每个 SubWorker 独享一个独立物理 worktree，路径：`.slime-worktrees/{session_id}/{worker_id}`
   - Worker 完成（成功 / 失败 / 取消）后必须**清理 worktree**（`git worktree remove`），禁止残留
   - Merger（归并）节点只能在主工作目录按 SubWorker 的 branch/commit 合并，不得直接读取子 worktree 内文件
4. 在 `main` / `release/*` 分支上，Agent 只能**读**或**建议 revert**，绝对不能 `reset`、`rebase`、`push --force`、`push`。

---

## 2. 提交粒度与语义化 Commit Message

### 2.1 Conventional Commits 强制格式

所有 Agent commit message（包括子 Agent 分裂的提交）必须符合 Conventional Commits，格式：

```
<type>(<scope>): <subject>

<agent identity header: 我是 {name}，{role}>

<body，空一行隔开；关键更改点用 - 枚举>

<trailers，空一行隔开>
```

合法 `type`：
| type | 含义 | 默认权限 | 典型场景 |
|---|---|---|---|
| `feat` | 新功能/新 Agent 行为 / GUI 新模块/新页面 | L2 需确认 | 新增某个工具、新的 Sidebar 折叠模式、新的 StatusPanel 卡片 |
| `fix` | bug 修复 | L1 自动（单文件≤80行）/L2（跨模块） | 侧边栏拖拽反向、模型选择下拉溢出、sidecar 假状态 |
| `perf` | 性能优化 | L1 自动 | React 重渲染减少、数据库索引、缓存策略 |
| `refactor` | 代码重构（功能不变） | L2 需确认 | 拆模块、改函数名、提取公共逻辑 |
| `docs` | 文档（AGENTS.md / REVIEW_AGENT.md） | L1 自动 | 新增本文件、更新修复日志 |
| `test` | 新增 / 修改单测、集成测试 | L1 自动 | 新增 QA 回归用例 |
| `chore` | 杂项（构建脚本 / CI / .gitignore / 依赖升级 无功能、无性能、无 doc 变化） | L1 自动 | 升级依赖、调整 vite 配置、**加 `.gitignore` 条目** |
| `style` | 代码格式（空白/缩进），**严禁语义变化** | L1 自动 | 自动格式化 |

`scope` 建议：`agent` / `swarm` / `gui` / `core` / `tools` / `mcp` / `memory` / `evolution` / `sandbox` / `ci` / `meta`。

### 2.2 提交粒度三原则（硬约束，Git 工具层 Lint Gate）

1. **"一个 SubTask 一个 commit"默认模式**（推荐）。每完成一个有意义的 SubTask 就 commit 一次，message 把该 SubTask 做了什么讲清楚。
2. **禁止巨型单提交**：单提交 diff > 800 行 changed 或 > 30 个文件 touched → Git 工具层拒绝提交，提示 Agent 必须拆成多个语义化的小提交（除非用户显式 approval 同意巨型 commit）。
3. **禁止 try-again 流水账**：严禁 `try again`、`fix1`、`fix2`、`hotfix` 这类无意义 commit subject；若上一次提交后修 bug，用 `fix(scope)!: revert X / correct Y` 并写清楚 why。

---

## 3. 质量门禁（Before-Commit Gate）

**任何 Agent 试图 commit Python / TypeScript 源码前必须先过 QA 门**（Git 工具层自动调用；除非 `chore(docs)` / `chore(meta)` 这种非代码提交）：

```
py qa.py
```

`py qa.py` 失败 → **commit 拒绝**，message 原样返回给 Agent 让它先修再提。
如果是只改 JS/TS 的纯前端改动，先过：

```
npm run type && npm run build
```

都通过后才允许 commit。

---

## 4. 身份 & 溯源 trailers（每条 commit 强制带）

> trailers 是 Git 原生支持的 commit message 末尾段，GitHub / GitLab 原生显示、`git show` / `git log --format=fuller` 可直接读取。
> Agent 写代码时**完全不用手动拼这些**——Git 工具层会从当前 Agent 的运行上下文自动注入 trailers，若缺则拒绝提交。

每条 Agent commit 的尾部必须带以下 trailers（`Key: Value`，空一行后开始，按以下顺序；Git 工具自动注入，禁止手写重复）：

```
Agent-Name: {agent.name}
Agent-ID: {agent.id}
Agent-Role: {agent.role}
Agent-Model: {provider}/{model_id}   # 实际产生本次代码改动的模型
Agent-Session: {session_id}
Agent-Subtask: {subtask_id or "-"}
Agent-Parent-ID: {parent_agent_id or "-"}   # 分裂产生的子 Agent 必须有
Agent-Decision: < 自由文本，≤ 200 字符，说明关键决策：为什么这么改？替代方案是什么？已知 tradeoff >
Agent-Origin: slime/v1
Co-Authored-By: slime-{agent_id} <agent+{agent_id}@slime.local>
Signed-off-by: slime-{agent_id} <agent+{agent_id}@slime.local>
```

同时，Git 工具层会**自动写一条 git note**（`refs/notes/slime-intent`，默认不 clone 下来，不污染普通 log），note 内容 JSON：

```json
{
  "session_id": "...",
  "task_summary": "...",
  "parent_agent_id": "...",
  "fork_depth": 2,
  "qa_result": { "compile": true, "run_tests": "OK", "pytest": {"passed": 777, "failed": 0} },
  "key_decisions": ["决策1", "决策2"],
  "claims": ["声称1（A-044 护栏校验过的）"],
  "transcript_ref": "config/history.jsonl#offset=12345"
}
```

这个 note 供 StatusPanel 的"Agent 代码溯源视图"使用（P2），也给以后审计时"反查这个 commit 是哪次会话、为什么改的"提供原语。

---

## 5. 回滚双轨策略（禁止乱 reset）

| 场景 | 允许操作 | 严禁 | 权限 |
|---|---|---|---|
| 公共分支：`main` / `release/*` / 已被他人拉取过的任何分支 | 只能 `git revert <commit>`（**新增一条反向提交**，绝不重写历史） | `reset --hard`、`rebase`、`cherry-pick` + 原提交删除、`push --force` | L3 批准 |
| Agent 私有分支：`slime/<agent_id>/*`（没有推到远端、没有被别人基于它开发过） | `git reset --soft HEAD~1`、`git restore`、`git revert` 均可 | `reset --hard` 必须先做 checkpoint；`push --force` 仅限自己的私有分支 | L2 自动 |
| 单文件精确回退（不重写历史） | `git restore -s <good-commit> -- <path>` 或 `git checkout <commit> -- <path>`，然后 commit 为一次"restore" | 直接用 Windows 资源管理器覆盖文件但不 commit | L0 允许（属于 write） |
| 失败策略回滚（SubTask 失败、需要撤销本 Worker 所有修改） | 用 checkpoints 的 `restore files` 回到 SubTask 开始前那个 checkpoint | 不做 checkpoint 就乱删整个目录 | L1 |

**判定某条分支是不是"公共分支"的算法**（Git 工具层自动算，Agent 不用自己判）：
- 如果分支名匹配 `main / master / release/* / production / hotfix/*` → 永远按公共分支处理
- 如果 `git branch --merged main` 列出了它 → 视为公共
- 如果远端 `origin/<branch>` 存在且 `git rev-list --count origin/@{u}..HEAD != 0`（本地比远端超前、但远端也有新提交）→ 视为公共

---

## 6. 受保护模块（Agent 碰了必须走最高 approval）

下列模块属于"安全敏感 / 核心架构敏感"，Agent 试图 commit 时除了过全量 QA，**必须在 sandbox 层拿到用户 explicit yes 决策**（`always-allow` 也不管用，必须本次显式批准），否则拒绝：

- `core/encryption.py`、`config/auth_token*` — 加密 / 身份令牌
- `core/sandbox.py`、`core/permissions.py` — 权限 / 沙箱（自己管自己的规则）
- `core/agent.py` — Agent 身份铁律 / `name`, `role` 保护字段（架构级 `__setattr__` 拦截）
- `tools/git.py`、`AGENTS.md`、`CLAUDE.md` — Git 治理层本身（防止 Agent 改规则绕过自己）
- `slime_server.py` 的认证中间件、`core/mcp_client.py` 的权限映射（A-044/049 幻觉护栏）

若 Agent 只是改注释或纯文档（不影响功能逻辑），可走 `docs(meta)`，approval 自动通过。

---

## 7. 分裂 / Swarm 场景下的特殊规则

1. 主 Agent 派 SubWorker 时，**先 create branch / create worktree，再派活**，工作隔离是前置条件而非后置补救。
2. Merger（归并）节点收到 SubWorker 成功结果后：
   - 第一步：先对每个 SubWorker branch 跑一遍 `py qa.py`（只跑和它改动范围相关的测试子集）
   - 第二步：合并到主 Agent 的临时 branch，再跑一次全量 QA
   - 第三步：全量 QA 过了，**生成一个独立的"归并 commit"**，message 的 `Agent-Decision:` trailer 写明合并了哪些 SubWorker、各自贡献是什么
   - 第四步：才允许合回 `slime/<main_agent>/<task>` 分支
3. 任何 SubWorker 失败，**绝对不能把失败的中间代码带进 Merger**。失败时 SubWorker 本 worktree 的修改必须丢弃（或者通过 checkpoint 给人类审阅）。
4. `MAX_FORK_DEPTH = 2`（CLAUDE.md 硬上限）同样适用于 Git 分支深度：fork > 2 禁止创建新 branch/worktree。

---

## 8. Git 工具白名单（Agent 只能通过下列 `git_*` 工具操作）

> **Agent 严禁通过 `terminal` / `cmd` / shell 直接裸调用 `git` 可执行文件**。所有版本控制操作必须通过平台注册的 `git_*` 工具走：
> 这些工具在沙箱里归 `terminal` 权限族，但有更细的规则、自带身份注入、质量门禁和 Lint Gate；
> 若 Agent 尝试在 `terminal` 里打 `git status`，sandbox 层直接拒绝（L1 未授权的 git 操作视为违规）。

| 工具名 | 语义 | 权限族 | 典型调用 |
|---|---|---|---|
| `git_status` | 读当前仓库状态（branch / changed / ahead-behind） | read | `git_status()` |
| `git_diff` | 读 diff（支持 --staged、针对 path），只读 | read | `git_diff(staged=true)` |
| `git_log` | 读 commit 历史 | read | `git_log(max=15)` |
| `git_branch_list` | 读分支列表（本地+远端）、当前分支、保护状态 | read | `git_branch_list()` |
| `git_restore` | 回滚工作区文件（不重写历史、可按 path 精确回退） | write | `git_restore(paths=["core/foo.py"])` |
| `git_revert` | 公共分支回滚（新增一条反向提交） | write | `git_revert(commit="abc123")` |
| `git_stage` | 把指定路径加到暂存区（按文件语义化拆分，禁止 `git add .` 全量添加） | write | `git_stage(paths=["gui/src/renderer/pages/ChatPanel.tsx"])` |
| `git_commit` | 语义化提交（自动注入身份铁律 author、trailers、git notes；自动跑 QA 门；自动 Lint Gate 拒绝巨型提交） | write + terminal | `git_commit(type="fix", scope="gui", subject="Fix model dropdown", decision="...")` |
| `git_branch` | 新建/切换 slime/* 分支（自动校验命名规范） | write | `git_branch(action="checkout", name="slime/alice/fix-sidebar")` |
| `git_worktree_create` | 为子 Worker 创建独占 worktree（P1，分裂场景） | write + terminal | `git_worktree_create(session_id="s123", worker_id="w4")` |
| `git_worktree_remove` | Worker 完成后清理 worktree | write + terminal | `git_worktree_remove(path=".slime-worktrees/s123/w4")` |
| `git_checkpoint_save` | 保存影子仓库快照（后悔药） | write | `git_checkpoint_save(label="before-swarm-fork")` |
| `git_checkpoint_list` | 列出 checkpoint 时间线 | read | `git_checkpoint_list(max=20)` |
| `git_checkpoint_restore` | 三模式还原：`files` / `task` / `both` | write | `git_checkpoint_restore(id="cp-20260823-001", mode="both")` |

---

## 9. 失败退出原则

下列情况出现时，Agent 的 `git_*` 工具**必须立刻拒绝执行**，把控制权还给用户，不能做"也许可以将就一下"的兜底：

1. 检测不到 `.git` 目录（当前目录不是 Git 仓库）→ 拒绝所有写操作，只读工具返回 "not a git repository"
2. 用户 slime 配置的 `git.enabled = false`（用户明确不想用任何 Git 治理）→ 全部工具返回 "Git 治理已被显式关闭"
3. 当前分支是受保护分支 + Agent 要做的是写操作（commit / reset / rebase）→ 拒绝，提示 "先切到 slime/* 分支"
4. `py qa.py` 失败 → commit 拒绝，返回失败日志
5. commit 被 Lint Gate 判定为巨型提交 + 用户未 approval → 拒绝，提示拆分成小提交
6. Agent-ID / Session-ID 上下文不存在（Git 工具无法自动注入 trailers）→ 拒绝，提示 "当前调用者不是合法 Agent"

---

## 10. 与 CLAUDE.md 的关系

本 AGENTS.md 是 **Git 治理层专用规则**，所有条款必须与 `CLAUDE.md` 保持一致：
- 如果 `CLAUDE.md` 对某项（例如 `MAX_FORK_DEPTH`、`promote 必须走 server API`）有明确硬规定，**以 CLAUDE.md 为准**
- 本文件中涉及的新治理机制（`git_*` 工具、worktree、checkpoints 影子仓库、trailers、git notes intent）如果和 `CLAUDE.md` 阶段表不一致，以阶段状态为准：
  - 阶段一/二的能力（分裂、Swarm、Merger）**立刻接入**这些 Git 治理机制
  - 阶段三-遗留（PySide6 GUI）暂不处理

> 最后更新：2026-08-23（A-126 Git 治理 P0 落地）
