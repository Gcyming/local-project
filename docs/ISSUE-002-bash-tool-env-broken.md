# ISSUE-002：WorkBuddy Bash 工具环境损坏（PATH 缺失，coreutils 全部 `command not found`）

> 本文是 `docs/KNOWN-ISSUES.md` 的 ISSUE-002 的**独立详版**（用户要求单独成文，便于后续单独排期修复）。
> 索引条目见 `docs/KNOWN-ISSUES.md`。

| 字段 | 值 |
|------|------|
| **编号** | ISSUE-002 |
| **发现日期** | 2026-09-13 深夜（23:56~00:18 会话中） |
| **严重度** | 中（不阻塞交付，但**阻塞一切依赖 coreutils / 管道 / 通配符的开发与脚本操作**） |
| **状态** | 未修复（用户确认后续单独处理） |
| **影响范围** | WorkBuddy 桌面端「Bash 工具」（Windows），当前用户环境 |
| **记录人** | WorkBuddy agent（slime dev） |
| **是否影响 slime 运行** | **否**。仅影响我（Agent）在本机跑 shell 的便利性，不改变 slime 自身代码/功能 |

---

## 1. 现象

WorkBuddy 的 Bash 工具在 Windows 上返回 `127`，**所有 PATH 解析的核心命令都找不到**：

```
D:\tool\AI\workbuddy\resources\app.asar.unpacked\cli\vendor\shim\shell-runtime-bash-env.sh: line 3: dirname: command not found
D:\tool\AI\workbuddy\resources\app.asar.unpacked\cli\vendor\shim\shell-runtime-bash-env.sh: line 3: cd: null directory
C:\Users\MR\.workbuddy\binaries\PortableGit\versions\1.2.0\bin\bash.exe: line 1: grep: command not found
```

最早由 `grep` 触发（`Grep`/检索类命令），随后确认以下命令**全部**不可用：

| 命令 | 结果 | 所属 |
|------|------|------|
| `ls` / `cp` / `rm` / `mv` | `command not found` | coreutils（`usr\bin`） |
| `grep` / `sed` / `awk` | `command not found` | coreutils |
| `head` / `tail` / `wc` / `cat` | `command not found` | coreutils |
| `dirname` / `basename` | `command not found` | coreutils（**shim 自身第一步就用到**） |
| `find` | `command not found` | coreutils |

## 2. 关键证据

### 2.1 失败的是「按 PATH 查找」的命令，绝对路径调用正常

同一次会话里，**用绝对路径调用的可执行文件全部正常**：

```bash
# ✅ 成功：绝对路径直接调用（不经 PATH 查找）
"C:/Users/MR/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" node_modules/typescript/bin/tsc -p gui/tsconfig.json --noEmit
# → core-exit:0 / gui-exit:0（tsc 正常跑完）

# ✅ 成功：shell 内建 + 重定向 + $?
cd "D:/pilot project/gui" && "…/node.exe" ./node_modules/electron-vite/bin/electron-vite.js build > /tmp/b3.txt 2>&1; echo "build-exit:$?"
# → build-exit:0

# ❌ 失败：任何需要 PATH 解析的命令
ls -la out/renderer/assets/*.js     # → ls: command not found
```

**结论：PATH 环境变量在本会话中缺失/未包含 PortableGit 的 coreutils 目录**，而非 bash 或命令本身损坏。

### 2.2 shim 自身第 3 行就依赖 `dirname`（鸡生蛋问题）

```
cli/vendor/shim/shell-runtime-bash-env.sh: line 3: dirname: command not found
cli/vendor/shim/shell-runtime-bash-env.sh: line 3: cd: null directory
```

该 shim 在**第 3 行**用 `dirname` 解析自身路径并 `cd` 到其目录；由于此时 PATH 还没有 coreutils，
`dirname` 未找到 → 变量为空 → `cd` 拿到 `null` 目录失败。说明：

- 环境装配顺序有问题：**shim 先于 PATH 初始化执行**；
- shim 用 `dirname` 而不是 bash 内建（`${BASH_SOURCE[0]%/*}`）解析路径 —— 这是个可单独修的脆弱点；
- 失败后 shim 没有把 PATH 补好，导致后续所有命令继续不可用。

### 2.3 相关路径

| 用途 | 路径 |
|------|------|
| Bash 可执行 | `C:\Users\MR\.workbuddy\binaries\PortableGit\versions\1.2.0\bin\bash.exe` |
| shim 脚本 | `D:\tool\AI\workbuddy\resources\app.asar.unpacked\cli\vendor\shim\shell-runtime-bash-env.sh` |
| coreutils 正常应位于 | `<PortableGit>\usr\bin\`（msys2）、`<PortableGit>\mingw64\bin\`（git.exe 等） |

> ⚠️ `versions\1.2.0` 是 **WorkBuddy 管理的包装版本号**，不是 Git 自身版本（Git for Windows 通常形如 `2.x`）。
> 排查时不要被这个号误导（此前的经验：managed 运行时目录名会变，如 node 的 `22.22.2-2` → `22.22.2-3`）。

## 3. 根因分析（假设，待验证）

| # | 假设 | 支持证据 | 验证方法 |
|---|------|---------|---------|
| A | **PATH 未包含 `<PortableGit>\usr\bin`**，coreutils 找不到 | 绝对路径可执行、PATH 命令全挂 | `echo "$PATH"` / `type ls` 看是否为空 |
| B | **shim 与环境装配顺序错误**：shim 依赖 `dirname`，但 PATH 在 shim 之后才设 | shim **line 3** 就报 `dirname: command not found` | 读 shim 全文，看 PATH 在哪里设置 |
| C | PortableGit 安装不完整 / `usr\bin` 目录缺失 | — | `ls <PortableGit>\usr\bin` 是否存在 `ls.exe`/`grep.exe`（需先用非 bash 手段，如 PowerShell）|
| D | bash 启动参数为 `--norc/--noprofile` 且未手动注入 PATH | shim 名称暗示"runtime bash env" 手工装配环境 | 查 WorkBuddy 调 bash 的完整命令行 |

**最可能是 A + B 组合**：shim 应该负责注入 PATH，但它自己第 3 行就因 PATH 缺失而失败，于是 PATH 永远没被补上。

## 4. 影响面

**受影响**：
- 一切需要 `ls / find / grep / sed / awk / head / tail / wc / xargs / sort / diff` 的操作
- 管道（`|`）与通配符（`*`）在多数情况下失效
- 任何 shell 脚本（`scripts/*.sh`、`build.sh`、`qa.sh` 等）
- 依赖 `tail -15`、`grep -c` 之类做输出摘要的排查手段

**不受影响**：
- **绝对路径调用任意可执行文件**（node / npm / tsc / electron-vite / python / git.exe …）
- shell 内建：`cd`（作为普通语句）、`echo`、`export`、`$?`、`test`、`[[ ]]`
- 重定向（`>`、`>>`、`2>&1`）
- 本项目交付：源码编辑、tsc、vitest、electron-vite build 全部照常（见下）

## 5. 已采用的绕行方案（可复制）

在 PATH 修好之前，用下面三招完全绕开 Bash：

```bash
# 1) 文件操作 → 改用 PowerShell 工具（Remove-Item / Move-Item / Copy-Item / Get-ChildItem）
Move-Item -Path "D:\pilot project\gui\src\main\imageAnnotate.ts" `
          -Destination "D:\pilot project\gui\src\shared\imageAnnotate.ts" -Force

# 2) 检索 / 读文件 → 用专用工具（不是 shell）
#    Read / Write / Edit / Glob / Grep —— 这些不经过 bash，永远可用

# 3) 跑命令 → 绝对路径 + 输出重定向到文件 + 读文件（绕开 tail/grep 摘要）
cd "D:/pilot project/gui" && "C:/…/node.exe" ./node_modules/electron-vite/bin/electron-vite.js build > /tmp/b3.txt 2>&1; echo "build-exit:$?"
#   再用 Read 工具读 /tmp/b3.txt（注意：Read 只能读工作区内路径，建议重定向到项目内 .workbuddy/tmp/）
```

> 本次三轮改动（A-975 / A-976 / A-977）就是全程用上述绕行完成的：
> `core-ts tsc 0 / gui tsc 0 / electron-vite build 0 / vitest 59 passed` —— **交付未受影响**。

## 6. 建议的修复步骤（待用户排期）

```
第 1 步：取证（不修改任何东西）
   ① 读 `cli/vendor/shim/shell-runtime-bash-env.sh` 全文，找 PATH 注入点，确认是否在第 3 行之后
   ② 用 PowerShell 列 `<PortableGit>\usr\bin` 是否存在 ls.exe / grep.exe / dirname.exe
   ③ 在 Bash 工具里跑：`echo "PATH=[$PATH]"; type ls; type dirname`（记录原始输出）

第 2 步：定点修复（按取证结果二选一或都做）
   (a) shim 层：把 line 3 的 `dirname` 换成 bash 内建，避免自己依赖 coreutils
         before: DIR=$(dirname "$0")
         after : DIR=${BASH_SOURCE[0]%/*}
       并在 shim 开头显式注入：
         export PATH="/usr/bin:/mingw64/bin:$PATH"     # msys2 相对路径
         # 或 Windows 绝对路径：
         export PATH="C:/Users/MR/.workbuddy/binaries/PortableGit/versions/<ver>/usr/bin:...:$PATH"
   (b) 启动层：确认 WorkBuddy 调 bash 时带了正确的环境（不要 `--noprofile --norc` 后又不注入 PATH）

第 3 步：验证（见第 7 节）
```

**注意**：`shell-runtime-bash-env.sh` 在 `app.asar.unpacked` 下（未打包），可直接编辑测试；
但它属于 **WorkBuddy 客户端文件**，改动可能在客户端升级时被覆盖 —— 修复后要在此文档记录版本号。

## 7. 修好后的验证清单

```bash
# 全部应成功且输出合理
echo "PATH=[$PATH]"
type ls grep sed awk dirname          # 均应打印路径而非 command not found
ls -la . | head -3                     # 管道 + 列目录
grep -c "A-977" docs/KNOWN-ISSUES.md   # grep + 计数
cat docs/KNOWN-ISSUES.md | tail -5      # 管道
find . -maxdepth 1 -name "*.md" | wc -l # find + wc
printf 'a\nb\n' | sort -r               # 管道 + 排序
```

## 8. 环境信息（发现时）

```
OS:            Windows 11 (win32)
Shell 工具:    WorkBuddy Bash tool（Git Bash / PortableGit）
Bash:          C:\Users\MR\.workbuddy\binaries\PortableGit\versions\1.2.0\bin\bash.exe
shim:          D:\tool\AI\workbuddy\resources\app.asar.unpacked\cli\vendor\shim\shell-runtime-bash-env.sh
项目:          D:\pilot project
失败退出码:    127（command not found）
会话时间:      2026-09-13 23:56 ~ 2026-09-14 00:18 (Asia/Shanghai)
```

## 9. 相关记录

- `docs/KNOWN-ISSUES.md`（ISSUE-001 Git for Windows 带斜杠 ref 静默失败；本文为其姊妹条目 ISSUE-002 的独立详版）
- `.workbuddy/memory/2026-09-13.md`（本次会话工作日志，含「环境坑」小节）
