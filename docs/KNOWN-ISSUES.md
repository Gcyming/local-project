# KNOWN-ISSUES.md

slime 项目运行/开发中已确认但**未修复**的问题归档。每个问题记录现象、排查过程、绕行方案、影响范围。

---

## ISSUE-001：Git for Windows 2.55.0 写带斜杠 ref 静默失败

| 字段 | 值 |
|------|------|
| **发现日期** | 2026-09-10 |
| **严重度** | 中（不影响现有工作，影响新建分支）|
| **状态** | 未修复（上游 Git for Windows bug）|
| **决策** | 维持现状（2026-09-10 用户确认）|
| **影响版本** | Git for Windows ≥ 2.55.0.windows.3 |
| **记录人** | WorkBuddy agent（slime dev）|

---

### 1. 现象

在 Windows 上，`git branch slime/{agent_id}/{slug}` 或 `git update-ref refs/heads/{dir}/{file}` 形式的带斜杠分支创建**静默失败**：

- 命令返回 exit 0（成功）
- loose ref 文件（`.git/refs/heads/{dir}/{file}`）**不被创建**
- `git for-each-ref` / `git branch` 看不到该分支
- packed-refs 也不被写入
- `git update-ref` 调用时**目标父目录被创建**但**文件不写**

### 2. 关键证据（16 组对照实验）

| # | 操作 | 预期 | 实际 | 含义 |
|---|------|------|------|------|
| 1 | `mkdir .git/refs/heads/test_manual`（手动）| 存活 | 3s 后**还在** ✓ | 文件系统层 OK |
| 2 | `echo > .git/refs/heads/test_dir/file_inner`（手动）| 存活 | 3s 后**还在** ✓ | 文件系统层 OK |
| 3 | `git update-ref refs/heads/clean_test/branch1 <hash>` | 写文件 | exit 0 但**没写** ✗ | git 写 ref 静默失败 |
| 4 | `git for-each-ref` 看 clean_test/branch1 | 看到 | **看不到** ✗ | git 内部不记录 |
| 5 | PowerShell 手动建 `.git\refs\heads\fresh\test1` | 看到 | git for-each-ref **看到了** ✓ | 手动写 loose git 能识别 |
| 6 | 手动建 `mytest/manual_inner` 后跑 `git branch mytest/git_inner` | 保留 manual_inner | **整个 mytest/ 被秒删** ✗ | git 写 ref 时清空目标目录 |
| 7 | `mkdir .workbuddy/test_dir/slash_inner`（项目其他位置）| 存活 | 3s 后**还在** ✓ | 仅 `refs/heads/` 下受影响 |
| 8 | `mkdir .git/test_subdir/slash_inner`（.git 顶层）| 存活 | 3s 后**还在** ✓ | 仅 `refs/heads/<dir>/` 下受影响 |
| 9 | 杀 openclaw (16952) + pm2 + hermes 后重测 | 修复 | **仍被清** ✗ | 不是后台进程 |
| 10 | 退坚果云 + 删 A-C-C 全套后重测 | 修复 | **仍被清** ✗ | 不是第三方工具 |
| 11 | `fsutil reparsepoint query .git` | 检查 reparse | "不是一个重分析点" | 不是 WSL/overlay 文件系统 |
| 12 | `mount` 输出 D 盘 | NTFS 普通 | NTFS | 标准 NTFS |
| 13 | `git config core.hooksPath` | 检查 hooks | 无 | 没有 custom hook |
| 14 | `.git/hooks/` | 检查活动 hook | 全是 `.sample` | 没有 active hook |
| 15 | `git for-each-ref` 看 `codex/immigration-*` | 看到 | **看到**（packed） | 已有带斜杠分支在 packed 里正常 |
| 16 | `git pack-refs --all` 收无斜杠 loose | 进 packed | **成功**（`test_noslash`） | 但带斜杠 loose 永远收不进 |

### 3. 排除的嫌疑（避免后续重复排查）

| 嫌疑 | 排除证据 |
|------|---------|
| ❌ 坚果云 minifilter 驱动 | 退托盘 + 退服务后问题仍存在 |
| ❌ openclaw gateway (PID 16952) | `Stop-Process` 后问题仍存在 |
| ❌ pm2 daemon (PID 22328) | `pm2 kill` 后问题仍存在 |
| ❌ hermes gateway (PID 27016/27060) | 杀后问题仍存在 |
| ❌ A-C-C launcher.js (PID 28596) | 杀后问题仍存在 |
| ❌ sbx.exe (DockerSandboxes daemon) | 杀后问题仍存在 |
| ❌ A-C-C 项目本体 | 全删（5.9MB）后问题仍存在 |
| ❌ A-C-C 自启项（注册表 Run + WMI × 2）| 删后问题仍存在 |
| ❌ Windows Search Indexer | `.git/` 顶层和项目其他位置手动目录都存活 |
| ❌ Windows Defender | 排除路径查询需 admin 但手动 mdkir 在 .git/ 下成功 |
| ❌ WSL/Docker overlay 文件系统 | `fsutil reparsepoint` 报告无 reparse |
| ❌ slime 自身 (core/git_tools.py, tools/git.py) | worktree rmtree 有范围校验（`.slime-worktrees/`）|
| ❌ Trae / Quark / MuMu / LM Studio 自启项 | 与 `.git/refs/heads/` 路径无逻辑关联 |
| ❌ NutstoreDriverSvc.exe | 退服务后问题仍存在 |
| ❌ `.git/info/refs` 缓存 | 该文件不含 `test_*` 标记 |
| ❌ git 配置文件 (`.git/config` 缺 gc/maintenance) | 配置干净 |
| ✅ **Git for Windows 2.55.0 自身 ref 写路径** | 16 组对照实验定位 |

### 4. 根因分析

**Git for Windows 2.55.0.windows.3** 在执行 `refs_update_ref`（或类似 C 函数）写 `refs/heads/<dir>/<file>` 形式 ref 时：

- 路径解析走到 Windows API 写文件阶段
- **静默失败**（可能是 `ERROR_INVALID_NAME` 或类似，但 git 内部吞掉错误返回 0）
- loose ref 不被创建，packed-refs 也不被写入
- 写之前如果目标父目录存在，git 内部的 prepare 步骤会**清空目标目录**（实验 6 证据）

但**手动**通过任何文件系统 API（PowerShell `New-Item` + `Set-Content`、cmd `echo >`、Bash `mkdir -p` + `echo`）创建 `.git/refs/heads/<dir>/<file>` 文件后，**git 能正常识别**——这反向证明 git 自己的 ref 写路径有 bug。

### 5. 影响范围

| 操作 | 是否受影响 |
|------|-----------|
| `git commit` 写当前分支 loose ref | ❌ **受影响（2026-09-16 实证，不只是"理论受影响"）**——commit 对象与 reflog 都写成功，但**分支 ref 不前进**，`git log` / `git rev-parse HEAD` 仍显示旧提交、`git status` 里改动仍是 staged。**每次在带斜杠分支上 commit 后都必须按 §10 修正 packed-refs** |
| `git push` | ✅ 不受影响（走 packed-refs fallback）；⚠️ 但若忘了 §10 修正，推上去的是**旧的** ref，你自己的 commit 不会上远端 |
| `git pull` / `git fetch` | ✅ 不受影响（写 remotes/，不是 heads/）|
| 已有 `slime/{x}/{y}` 分支 | ✅ 可被解析（packed-refs 兜底），⚠️ 但**不会随 commit 前进**（见第 1 行）|
| 新建 `slime/{x}/{y}` 分支 | ❌ 失败（git 静默拒绝）|
| 切换分支 (`git checkout`) | ✅ 不受影响（HEAD loose 或 packed 都行）|
| `git merge` / `git rebase` | ✅ 不受影响 |
| 任何无斜杠的分支 | ✅ 不受影响 |

### 6. 决策（2026-09-10）

**维持现状（方案 A）**——理由：
1. 已有 5 个带斜杠分支（`codex/immigration-protocol-v12`, `codex/immigration-v12`, `codex/immigration-v12-b`, `main`, `slime/final-qa-optimize`）全部**在 packed-refs 里正常工作**
2. ~~当前分支 `slime/final-qa-optimize` HEAD 解析正确（`18240d1`），commit 链路完整~~
   **⚠️ 2026-09-16 更正**：这句是**错的**。"能解析到 18240d1" 只说明 packed-refs 里恰好存着这个值，
   不代表 commit 链路完整——**每次 commit 后 ref 都不会前进**（见 §10 实证）。原结论把影响面低估成
   "唯一的限制是新建分支会失败"，实际是"**在这个分支上 commit 之后必须手工修 packed-refs，否则
   提交等于没发生**"。
3. `git push` 验证通过（`5812513..18240d1` 已上远端）
4. ~~**唯一的限制**是**新建**带斜杠分支会失败~~ → 更正为：**新建分支会失败 + 已存在分支的 commit 不前进**
5. 不去改 AGENTS.md 的 `slime/{agent_id}/{slug}` 命名规范（避免工程性大改）
6. **维持现状仍可接受的前提**：每次在该分支 commit 后执行 §10 的"修正 + 三处校验"。

### 7. 绕行方案（仅在"必须新建带斜杠分支"时使用）

#### 方案 D1：手动写 loose ref 文件（推荐）

```powershell
# PowerShell
$branchName = 'slime/my-agent/feature-x'
$refFile = ".git\refs\heads\$branchName"   # 这是 ref 文件本身
$refDir  = Split-Path $refFile -Parent     # 这是它的父目录
$hash = '18240d1494ddbb59ae2da73947d36bc24d70f4ed'

# 先清残（含之前 git branch 失败留下的空目录）
if (Test-Path $refDir)  { Remove-Item -Path $refDir  -Recurse -Force }
if (Test-Path $refFile) { Remove-Item -Path $refFile -Recurse -Force }

New-Item -ItemType Directory -Path $refDir -Force | Out-Null
Set-Content -Path $refFile -Value $hash -NoNewline -Encoding ascii

# 验证：三个命令必须一致
git rev-parse HEAD
git rev-parse $branchName
git show-ref | Select-String "my-agent"
```

**注意**：
- 如果 `slime/my-agent/` 已存在但**有其他内容**（包括手动建的文件），运行 `git branch` 时整个目录会被清空——所以**必须先单独建好目录再写**（实验 6 警告）
- 如果之前 `git branch` 已经失败过，**必须先 `rm -rf` 残留的空目录**再重新建
- ❌ **别把 hash 写进 `"$refFile\master"`**（把分支名当目录、再套一层文件名）——那会创建出
  `refs/heads/slime/my-agent/feature-x/master` 这个**另一个分支**，`git for-each-ref` 看着"有了"，
  而你要的分支根本不存在。（本文件旧版 D1 与配套 skill 都犯过这个错，2026-09-16 更正）

#### 方案 D2：直接编辑 packed-refs（**已有分支 commit 后修正 ref 的首选**）

```bash
# 1. 查 packed-refs 现有 ref
cat .git/packed-refs

# 2A. 新建：追加一行（注意尾部换行）
echo "<hash> refs/heads/slime/my-agent/feature-x" >> .git/packed-refs

# 2B. 更新已有分支（commit 后修正）：把该分支那一行的**旧 hash 替换成新 hash**
#     例：18240d1... refs/heads/slime/final-qa-optimize
#      → 66b224d... refs/heads/slime/final-qa-optimize
#     （别追加！同一分支出现两行会以最后一行为准，旧行残留会让人误判）

# 3. 验证：三者必须一致
git rev-parse HEAD
git rev-parse slime/my-agent/feature-x
git show-ref | grep "slime/my-agent"
```

**注意**：
- 改 packed-refs 后**不要立即跑 `git gc` 或 `git pack-refs`**（会重写 packed-refs）
- 改 packed-refs 后**不要立即跑 `git branch <同名>`**（git 会创建 loose 然后又失败）
- 用 `node -e` + `fs` 做替换比 `sed` 稳（Windows 上 sed 对 `.git/` 路径与编码易出问题），
  且要**先断言目标行存在**再写，避免静默改错文件

#### 方案 D3：升级/降级 Git for Windows

- 升到 2.55.1+（如官方有 patch）
- 降到 2.50.x（之前版本可能没这个 bug，但失去新功能）
- 切到原生 Linux Git（WSL2 内）或 msys2 git

#### 方案 D4：分支名去斜杠（备选，违反 AGENTS.md）

```bash
git branch slime-my-agent-feature-x <hash>
```

### 8. 监控与升级条件

满足以下任一条件时考虑切换到 D3（升/降 Git for Windows）：

1. Git for Windows 官方发布修复版本（CHANGELOG 提到 "ref write" 或 "slash ref" 相关）
2. slime 频繁需要新建带斜杠分支（> 1 次/周）
3. 业务方对分支命名有强制规范要求

### 9. 排查方法论沉淀

这次排查的**16 组对照实验**方法可复用于其他"X 文件被秒删/消失"类问题：

1. **列嫌疑**：从最近 → 最远，列所有可能（用户行为 → 后台进程 → 系统服务 → 文件系统 → 上游工具）
2. **做对照**：每个嫌疑至少 1 组"X 真是元凶则 Y / 不是则 Z"的实验
3. **决定性实验**：手动 mdkir + 第三方工具读写 vs 目标工具读写（隔离工具自身 bug）
4. **绝对不能跳过的 mtime 检查**：`stat -c '%y %n'` 显示**目录本身**的 mtime 在可疑操作时是否更新——是则工具触达了它
5. **PowerShell vs Git Bash 双视角**：msys2 路径转换在某些 .git/ 路径下行为不同，debug 时两种工具都试

详见 `.workbuddy/memory/2026-09-10.md` 21:25 段。

---

### 10. 2026-09-16 实证：在带斜杠分支上 `git commit` 后 ref 不前进（Symptom B）

**现场**：在 `slime/final-qa-optimize` 上提交 87 个文件（14426 insertions / 1803 deletions）。

**观察到的现象（全部"看起来成功"）**：
- `git commit` exit 0，并正常打印 `create mode 100644 ...` 一系列新文件
- `.git/logs/HEAD` 新增一行：`18240d1... 66b224d... WorkBuddy <...> commit: feat(gui): ...`
- `.git/logs/refs/heads/slime/final-qa-optimize` 同步新增同一行

**实际状态（关键）**：
- `.git/refs/heads/slime/final-qa-optimize` **不存在**（松散 ref 没写）
- `.git/packed-refs` 里该分支**仍是旧的 `18240d1`**
- 因此 `git rev-parse HEAD` / `git rev-parse slime/final-qa-optimize` / `git show-ref` 全部返回 `18240d1`
- `git log --oneline -1` 显示旧提交；`git status` 里那 87 个文件**仍是 staged**

> **极易误判为"提交被某个钩子/治理层回退了"**（本仓库有 `tools/git.py`「Git 工具层」，
> 且 AGENTS.md 提到会拒绝不合规提交，第一反应就是它）。
> **验证方法**：`git cat-file -t <reflog 里的新 hash>` —— 若返回 `commit`，说明**提交是真实存在的**，
> 只是分支 ref 没跟上。**此时绝不要重新 commit**，否则会叠出重复提交、diff 翻倍。

**修正步骤（3 步 + 3 项校验）**：

```bash
# 1) 从 reflog 拿到真实的新提交 hash（HEAD@{0}）
git reflog -3

# 2) 用 node+fs 把 packed-refs 里该分支的旧 hash 替换为新 hash
node -e "
const fs=require('fs');
const p='.git/packed-refs';
const s=fs.readFileSync(p,'utf8');
const old='<old-hash> refs/heads/slime/final-qa-optimize';
const neu='<new-hash> refs/heads/slime/final-qa-optimize';
if(!s.includes(old)){ console.log('target line not found'); process.exit(1); }
fs.writeFileSync(p, s.replace(old,neu), 'utf8');
"

# 3) 三处校验必须全部返回新 hash
git rev-parse HEAD
git rev-parse slime/final-qa-optimize
git show-ref | grep final-qa-optimize
git log --oneline -2
```

**结果**：修正后 `HEAD` = `66b224d`（本次提交），`git log` 顶部即新提交，工作区只剩两个未跟踪临时文件。

**固化**：`py qa.py` 那类门禁都不会发现这个问题（门禁看的是工作区/索引，不看 ref）。
**这个分支上每次 commit 后都要跑一遍上面的第 3 步校验**；不平仓就会"提交静静地丢掉"。
配套绕行细节见用户级 skill `git-create-slash-ref-windows-workaround`。

---

## ISSUE-002：WorkBuddy Bash 工具环境损坏（PATH 缺失，coreutils 全 `command not found`）

| 字段 | 值 |
|------|------|
| **发现日期** | 2026-09-13 |
| **严重度** | 中（不阻塞交付，**阻塞 shell 脚本 / 管道 / coreutils**）|
| **状态** | 未修复（用户确认后续单独排期）|
| **影响范围** | WorkBuddy 桌面端「Bash 工具」（Windows）；**不影响 slime 自身运行** |
| **详版文档** | [`docs/ISSUE-002-bash-tool-env-broken.md`](./ISSUE-002-bash-tool-env-broken.md)（现象 / 证据 / 根因假设 / 绕行 / 修复步骤 / 验证清单）|

**一句话**：bash 会话的 PATH 未包含 PortableGit 的 coreutils 目录，且 shim **第 3 行**就用 `dirname` 解析自身路径
（鸡生蛋）→ `ls / grep / tail / cp / dirname` 全部 `command not found`，退出码 127。
绝对路径调用可执行文件、shell 内建、重定向**均正常**。

**绕行**（已验证可完成交付）：文件操作 → PowerShell 工具；检索/读写 → Read/Write/Edit/Glob/Grep 专用工具；
跑命令 → 绝对路径 + 输出重定向到文件再读。

---

## 附录：环境信息（出问题时）

```
OS:        Windows 11 (10.0.26200.8875)
Git:       git version 2.55.0.windows.3
Shell:     Git Bash (msys2)
Path:      /mingw64/bin/git
Project:   D:\pilot project
Branch:    slime/final-qa-optimize @ 18240d1
Date:      2026-09-10 21:25 (Asia/Shanghai)
```

---

**文档维护说明**：
- 新增 ISSUE 时，在末尾追加 `## ISSUE-NNN：{标题}` 章节
- ISSUE 修复后，把状态改为"已修复（YYYY-MM-DD）"并保留章节作历史
- 重大变更（影响范围/决策改变）需在 memory 日志里交叉记录
