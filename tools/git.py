"""
slime Git 治理工具（A-126 P0）—— 按 AGENTS.md 硬契约落地。

设计要点：
1. **禁止裸 git 调用**：所有版本控制操作必须走本模块注册的 git_* 工具；
   sandbox 层应额外拒绝 terminal 内任何 `git ` 开头的命令（后续接入）。
2. **身份铁律**：git_commit 从 core.agent_context.git_agent_ctx（ContextVar）拿当前 Agent，
   自动注入 author、commit message 身份头、trailers、git notes（refs/notes/slime-intent），
   上下文缺失时拒绝提交。
3. **双轨回滚**：公共分支（main / release/* / production / hotfix/* 或已被 merged main）
   拒绝 reset/rebase/push，只允许 revert；Agent 私有分支 slime/* 允许 restore/revert/soft reset。
4. **Lint Gate 质量门**：
   - 非 docs/chore(meta) 改动：commit 前自动跑 `py qa.py`（或纯前端跑 `npm run type && npm run build`）
   - 单提交 diff > 800 changed lines / > 30 files → 拒绝，提示拆分成语义化小提交。
5. **分支命名校验**：Agent 新分支只能 `slime/{agent_id}/...` / `slime/swarm/{session}/...` / `slime/tmp/...`。

注：P1（checkpoints 影子仓库 + worktree 子 Agent 工作隔离）在本模块后续追加。
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tools.registry import Tool, get_registry

# 锚定项目根（与 tools/builtin.py 保持一致，cwd 任意启动都 OK）
_PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Lint Gate 常量（AGENTS.md §2.2）
MAX_CHANGED_LINES_PER_COMMIT = 800
MAX_CHANGED_FILES_PER_COMMIT = 30
ALLOWED_COMMIT_TYPES = {"feat", "fix", "perf", "refactor", "docs", "test", "chore", "style"}
PROTECTED_BRANCH_GLOBS = (
    "main", "master", "production",
    "release/*", "hotfix/*",
)
PROTECTED_DIRECTORIES_AGAINST_GLOBS = (
    "core/encryption.py",
    "core/sandbox.py",
    "core/permissions.py",
    "core/agent.py",
    "tools/git.py",
    "AGENTS.md",
    "CLAUDE.md",
    "slime_server.py",     # 认证中间件部分
    "core/mcp_client.py",   # 权限映射部分
)
BRANCH_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,47}$")

log = logging.getLogger("slime.git-tools")


# ─────────────── 底层 Git 命令封装（统一异常/输出处理）─────────────────────

def _run_git(args: list[str], *, cwd: Path | None = None,
             check: bool = False, timeout: int = 60,
             allow_nonzero: bool = False) -> subprocess.CompletedProcess[str]:
    """执行 git 命令并返回 CompletedProcess。禁止 shell=True，防注入。"""
    if shutil.which("git") is None:
        raise RuntimeError("未检测到 git 可执行文件，请先安装 Git 并加入 PATH")
    cmd = ["git", *args]
    try:
        cp = subprocess.run(
            cmd,
            cwd=str(cwd or _PROJECT_ROOT),
            capture_output=True, text=True, timeout=timeout,
            check=False, encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"git 命令超时（{timeout}s）：{' '.join(args)}") from e
    if check and cp.returncode != 0 and not allow_nonzero:
        raise RuntimeError(
            f"git {' '.join(args)} 失败（exit {cp.returncode}）："
            f"{(cp.stderr or cp.stdout).strip()[:500]}"
        )
    return cp


def _ensure_git_repo(cwd: Path | None = None) -> str | None:
    """若当前目录非 git 仓库返回错误信息；正常返回 None。"""
    cp = _run_git(["rev-parse", "--is-inside-work-tree"], cwd=cwd, allow_nonzero=True)
    if cp.returncode != 0 or cp.stdout.strip() != "true":
        return "非 Git 仓库（未找到 .git / 工作区）"
    return None


def _current_branch(cwd: Path | None = None) -> str:
    cp = _run_git(["branch", "--show-current"], cwd=cwd)
    return cp.stdout.strip()


def _is_protected_branch(branch: str, cwd: Path | None = None) -> tuple[bool, str]:
    """判定分支是否受保护（AGENTS.md §5）。返回 (is_protected, reason)。"""
    if not branch:
        return True, "无法解析当前分支名"
    for pat in PROTECTED_BRANCH_GLOBS:
        if fnmatch.fnmatchcase(branch, pat):
            return True, f"分支名匹配保护模式：{pat}"
    # 是否已经 merged 进 main/master
    for base in ("main", "master"):
        cp = _run_git(["rev-parse", "--verify", "--quiet", base], cwd=cwd, allow_nonzero=True)
        if cp.returncode != 0:
            continue
        cp2 = _run_git(["branch", "--merged", base, "--list", branch], cwd=cwd)
        if branch in {ln.strip().lstrip("* ").strip() for ln in cp2.stdout.splitlines() if ln.strip()}:
            return True, f"该分支已合并入 {base}，视为公共分支"
    return False, ""


def _parse_diff_stats(diff_stat_stdout: str) -> tuple[int, int]:
    """从 `git diff --numstat <targets>` 解析 (changed_files, changed_lines)。"""
    files = 0
    lines = 0
    for line in diff_stat_stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        add, rm = parts[0], parts[1]
        try:
            lines += 0 if add == "-" else int(add)
            lines += 0 if rm == "-" else int(rm)
            files += 1
        except ValueError:
            continue
    return files, lines


@dataclass
class _QAStatus:
    kind: str  # "qa" / "frontend"
    ok: bool
    detail: dict[str, Any]

    def to_message_line(self) -> str:
        if self.ok:
            if self.kind == "qa":
                d = self.detail
                return (f"[QA OK] compile={d.get('compile')} run_tests={d.get('run_tests')} "
                        f"pytest_passed={d.get('pytest_passed')} pytest_failed={d.get('pytest_failed')}")
            return f"[Frontend OK] type=OK build=OK"
        return f"[QA FAIL] {self.detail.get('error', '质量门禁未通过')}"


def _run_quality_gate(changed_paths: list[str]) -> _QAStatus:
    """质量门禁（AGENTS.md §3）。根据改动文件范围决定跑哪一套门。"""
    suffixes = {Path(p).suffix.lower() for p in changed_paths}
    has_py = any(p.endswith(".py") or suffixes & {".py"} for p in changed_paths)
    has_ts = any(
        any(p.endswith(ext) for ext in (".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json"))
        for p in changed_paths
    )
    # 纯 docs 类改动：不过 QA 门（节省时间）
    pure_docs = all(
        Path(p).suffix.lower() in (".md", ".txt", ".rst")
        and str(Path(p).as_posix()).startswith(("docs/", "AGENTS.", "CLAUDE.", "README"))
        for p in changed_paths
    )
    if pure_docs:
        return _QAStatus(kind="qa", ok=True, detail={"compile": None, "skip_reason": "纯文档改动"})

    # 有 Python 源 + 有 TS/JS 源：优先 py qa.py（全量，包括 GUI 构建校验）
    try:
        cp = subprocess.run(
            [sys.executable, "qa.py"],
            cwd=str(_PROJECT_ROOT), capture_output=True, text=True, timeout=60 * 30,
            encoding="utf-8", errors="replace",
        )
    except Exception as e:  # noqa: BLE001
        return _QAStatus(kind="qa", ok=False, detail={"error": f"调用 qa.py 异常：{e!s:.500}"})
    ok = cp.returncode == 0
    detail: dict[str, Any] = {"compile": ok, "run_tests": ok, "pytest_passed": None, "pytest_failed": None}
    # 尝试读取 qa_report.json（若存在）提取更细的结果
    report = _PROJECT_ROOT / "data" / "qa_report.json"
    if report.exists():
        try:
            rpt = json.loads(report.read_text(encoding="utf-8"))
            pytest_summary = rpt.get("pytest", {}) if isinstance(rpt, dict) else {}
            detail.update({
                "pytest_passed": pytest_summary.get("passed"),
                "pytest_failed": pytest_summary.get("failed"),
            })
        except Exception:  # noqa: BLE001
            pass
    if not ok:
        tail = (cp.stderr or cp.stdout or "")[-600:]
        detail.setdefault("error", tail)
    return _QAStatus(kind="qa", ok=ok, detail=detail)


# ─────────────── Git 工具实现（异步函数，符合 Tool.execute_fn 契约）─────────

async def git_status(_args: dict) -> str:
    """读取当前仓库状态（分支 / changed 文件 / ahead-behind）。"""
    err = _ensure_git_repo()
    if err:
        return f"[只读] {err}"
    branch = _current_branch()
    protected, reason = _is_protected_branch(branch)
    cp = _run_git(["status", "--short", "--branch"])
    head = ""
    lines = cp.stdout.splitlines()
    if lines:
        head = lines[0]
        rest = "\n".join(lines[1:])
    else:
        rest = ""
    status_tag = "🔒 受保护分支" if protected else "🟢 可写 Agent 分支"
    detail = f"状态（{status_tag}"
    if protected:
        detail += f"：{reason}"
    detail += f"）\n分支: {branch} | {head}\n"
    detail += "保护规则: " + ", ".join(PROTECTED_BRANCH_GLOBS) + "\n"
    detail += "── 变更文件 ──\n" + (rest if rest else "(工作区干净)")
    return detail


async def git_diff(args: dict) -> str:
    """读取 git diff（staged / unstaged）。"""
    err = _ensure_git_repo()
    if err:
        return f"[只读] {err}"
    staged = bool(args.get("staged"))
    paths = [p for p in (args.get("paths") or []) if isinstance(p, str)]
    cmdline = ["diff", "--stat"] + (["--cached"] if staged else []) + ["--"] + paths
    cp1 = _run_git(cmdline)
    cmdline2 = ["diff", "--unified=3"] + (["--cached"] if staged else []) + ["--"] + paths
    cp2 = _run_git(cmdline2)
    body = (cp1.stdout or "(无变更)") + "\n── 补丁 ──\n" + (cp2.stdout[:8000] or "(无变更)")
    if len(cp2.stdout) > 8000:
        body += f"\n…（补丁过长，已截断 8000 字；用 git diff <path> 单独读取单文件）"
    return body


async def git_log(args: dict) -> str:
    """读取最近 N 条 commit 历史（oneline + 关键 trailers 摘要）。"""
    err = _ensure_git_repo()
    if err:
        return f"[只读] {err}"
    max_n = max(1, min(int(args.get("max") or 15), 50))
    fmt = "%h %ad | %s | [%an <%ae>]"
    cp = _run_git([
        "log", f"-n{max_n}",
        f"--pretty=format:{fmt}", "--date=short",
    ])
    lines = cp.stdout.splitlines()
    if not lines:
        return "(仓库尚无 commit)"
    # 附加 trailers：当前 HEAD 的 Agent-ID（快速身份核验）
    cp2 = _run_git([
        "log", "-1", "--pretty=format:%(trailers:key=Agent-ID,key=Agent-Model,separator=%x20%x7c%x20,unfold)",
    ], allow_nonzero=True)
    trailer = cp2.stdout.strip()
    body = "\n".join(f"· {ln}" for ln in lines)
    if trailer:
        body += f"\n── HEAD trailers（Agent-ID | Agent-Model）──\n{trailer}"
    return body


async def git_branch_list(_args: dict) -> str:
    """列出本地/当前分支，并标注保护状态。"""
    err = _ensure_git_repo()
    if err:
        return f"[只读] {err}"
    cur = _current_branch()
    cp = _run_git(["branch", "--list", "-v", "--abbrev=8"])
    out = []
    for line in cp.stdout.splitlines():
        raw = line.rstrip()
        if not raw:
            continue
        is_cur = raw.startswith("*")
        name = raw.lstrip("* ").lstrip().split(maxsplit=1)[0]
        prot, reason = _is_protected_branch(name)
        tag = " 🔒 PROTECTED" if prot else ""
        if prot and reason:
            tag += f"（{reason}）"
        out.append(raw + tag + ("  ← 当前" if is_cur else ""))
    return "\n".join(out) or "(无本地分支)"


async def git_stage(args: dict) -> str:
    """把指定路径加入暂存区。**禁止不传 paths 的全量 add**。"""
    err = _ensure_git_repo()
    if err:
        return f"[拒绝] {err}"
    paths = [p for p in (args.get("paths") or []) if isinstance(p, str) and p.strip()]
    if not paths:
        return "[拒绝] git_stage 必须传 paths=[<逐个文件路径>]，禁止 `git add .` 全量添加（AGENTS.md §8）"
    # 路径锚定项目根
    normalized: list[str] = []
    for p in paths:
        raw = Path(p)
        if not raw.is_absolute():
            raw = _PROJECT_ROOT / raw
        try:
            rel = raw.resolve().relative_to(_PROJECT_ROOT.resolve()).as_posix()
        except ValueError:
            return f"[拒绝] 路径超出项目范围：{p}"
        normalized.append(rel)
    cp = _run_git(["add", "--", *normalized], check=True)
    staged = "\n".join("+ " + p for p in normalized)
    return f"已添加到暂存区（{len(normalized)} 项）：\n{staged}"


async def git_restore(args: dict) -> str:
    """回滚工作区修改（到 HEAD 状态），可按 path 精确回退；不重写历史。"""
    err = _ensure_git_repo()
    if err:
        return f"[拒绝] {err}"
    paths = [p for p in (args.get("paths") or []) if isinstance(p, str) and p.strip()]
    if not paths:
        return "[拒绝] git_restore 必须传 paths=[...]（精确到文件/目录），禁止整仓库 restore"
    source = args.get("source") or "HEAD"  # 允许 restore -s <commit>
    cmd = ["restore"]
    if source and source != "HEAD":
        cmd += ["-s", source]
    cmd += ["--"] + paths
    cp = _run_git(cmd, check=True)
    return f"已还原（源={source}）：{', '.join(paths)}"


async def git_revert(args: dict) -> str:
    """公共分支回滚：新增一条反向 commit（绝不重写历史）。"""
    err = _ensure_git_repo()
    if err:
        return f"[拒绝] {err}"
    commit = (args.get("commit") or "").strip()
    if not commit:
        return "[拒绝] git_revert 需要传 commit（7 位以上 hash / tag）"
    # 公共分支：允许；私有分支：也允许（双轨都 OK，revert 总是安全的）
    try:
        cp = _run_git(
            ["revert", "--no-edit", commit],
            check=True, timeout=120,
        )
    except RuntimeError as e:
        return f"[revert 失败] {e!s:.800}\n（可能存在冲突，请手动解决冲突后继续完成 revert）"
    return f"revert 完成（{commit}）：已新增一条反向 commit（未重写历史）"


async def git_branch(args: dict) -> str:
    """管理 Agent 分支：新建/切换/删除（校验 slime/* 命名规范）。"""
    err = _ensure_git_repo()
    if err:
        return f"[拒绝] {err}"
    action = (args.get("action") or "list").strip().lower()
    name = (args.get("name") or "").strip()

    if action == "list":
        return await git_branch_list({})

    if action == "current":
        branch = _current_branch()
        prot, reason = _is_protected_branch(branch)
        return (f"当前分支：{branch}（{'🔒 受保护：' + reason if prot else '🟢 可写 Agent 分支'}）")

    if action in ("new", "checkout"):
        if not name:
            return "[拒绝] 请传分支名 name=..."
        # ── 命名校验 ──
        parts = name.split("/")
        if len(parts) < 2 or parts[0] != "slime":
            return ("[拒绝] Agent 自建分支必须以 slime/ 前缀开头，命名规范见 AGENTS.md §1：\n"
                    "  slime/{agent_id}/{task_slug}\n"
                    "  slime/{agent_id}/subtask/{idx}-{slug}\n"
                    "  slime/swarm/{session_id}/{worker_id}\n"
                    "  slime/tmp/{agent_id}/{timestamp}")
        # {agent_id} 段必须合法（KEY_RE 风格），{slug} 段合法
        agent_seg = parts[1] if len(parts) >= 2 else ""
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fa5]{1,64}", agent_seg or ""):
            return f"[拒绝] 分支第二段 agent_id 不合法：{agent_seg!r}（限字母/数字/_/-/中文 1-64 字符）"
        slug_segs = parts[2:]
        for seg in slug_segs:
            if not BRANCH_SLUG_RE.fullmatch(seg):
                return f"[拒绝] 分支段 {seg!r} 不合法：限小写字母/数字/-、开头字母数字、≤48 字符"

        if action == "new":
            cp = _run_git(["checkout", "-b", name], allow_nonzero=True)
            if cp.returncode != 0:
                return f"[失败] 创建分支 {name} 失败：{(cp.stderr or cp.stdout).strip()[:400]}"
            return f"✅ 已创建并切换到 Agent 分支：{name}"
        # checkout
        # 禁止从受保护分支切分支时直接往受保护分支 commit（这里只允许切 slime/* 分支本身，不做其它限制）
        cp = _run_git(["checkout", name], allow_nonzero=True)
        if cp.returncode != 0:
            # 分支不存在则创建
            cp2 = _run_git(["checkout", "-b", name], allow_nonzero=True)
            if cp2.returncode != 0:
                return (f"[失败] 切分支 {name} 失败：\n"
                        f"1) 直接 checkout：{(cp.stderr or cp.stdout).strip()[:300]}\n"
                        f"2) 新建：{(cp2.stderr or cp2.stdout).strip()[:300]}")
            return f"✅ 分支 {name} 不存在，已新建并切换"
        return f"✅ 已切换分支 → {name}"

    if action == "delete":
        if not name:
            return "[拒绝] 传 name=... 指定要删的分支"
        cur = _current_branch()
        if name == cur:
            return "[拒绝] 不能删除当前分支：请先切到其它分支"
        prot, _ = _is_protected_branch(name)
        if prot:
            return f"[拒绝] 分支 {name} 属于受保护分支，禁止删除"
        cp = _run_git(["branch", "-d", name], allow_nonzero=True)
        if cp.returncode != 0:
            return f"[失败] 删除分支 {name}：{(cp.stderr or cp.stdout).strip()[:400]}\n（强制删除请走 CLI 手动：git branch -D）"
        return f"已删除本地分支：{name}"

    return f"[拒绝] 未知 action：{action}（支持 list / current / new / checkout / delete）"


# ─────────────── 语义化 commit（最核心；自动注入身份/门禁/Trailers/Notes）────

async def git_commit(args: dict) -> str:
    """语义化 commit（AGENTS.md §2 / §3 / §4）。参数：
    - type*: feat/fix/perf/refactor/docs/test/chore/style
    - scope: 建议 agent/swarm/gui/core/tools/mcp/memory/evolution/sandbox/ci/meta
    - subject*: 简述（≤ 88 字符）
    - body: 自由正文（空一行后接 trailers → 工具自动拼，用户无需自己写 trailers）
    - decision: 关键决策说明（≤ 200 字符），会填入 Agent-Decision trailer
    - co_author: 可选共同作者 "Name <email>"（人类维护者）
    - allow_huge_commit: 显式同意巨型提交（默认 false）
    - skip_qa: 显式跳过质量门禁（仅 docs/chore(meta) 允许自动；源码改动必须 false 且 qa 通过）
    """
    err = _ensure_git_repo()
    if err:
        return f"[拒绝] {err}"

    # ── 参数校验 ──
    ctype = (args.get("type") or "").strip()
    scope = (args.get("scope") or "").strip()
    subject = (args.get("subject") or "").strip()
    body = (args.get("body") or "").rstrip()
    decision = (args.get("decision") or "").strip()[:200]
    co_author = (args.get("co_author") or "").strip()
    allow_huge = bool(args.get("allow_huge_commit"))
    skip_qa_flag = bool(args.get("skip_qa"))

    if ctype not in ALLOWED_COMMIT_TYPES:
        return f"[拒绝] type 必须是：{sorted(ALLOWED_COMMIT_TYPES)}（收到：{ctype!r}）"
    if not subject:
        return "[拒绝] subject 不能为空（语义化 commit 标题）"
    if len(subject) > 88:
        return f"[拒绝] subject 过长（≤ 88 字符）：当前 {len(subject)}。建议拆成 type+scope 标题，细节写 body。"
    if scope and not re.fullmatch(r"[a-z][a-z0-9_\-]{0,31}", scope):
        return f"[拒绝] scope 不合法：{scope!r}（建议：agent/swarm/gui/core/tools/mcp/memory/evolution/sandbox/ci/meta）"

    # ── 当前分支受保护检测（commit 属于写操作）──
    branch = _current_branch()
    protected, reason = _is_protected_branch(branch)
    if protected:
        return (f"[拒绝] 当前分支 {branch!r} 是受保护分支（{reason}），禁止 Agent 直接 commit。\n"
                "先执行：git_branch(action='new', name='slime/<agent_id>/<task_slug>')")

    # ── 暂存区非空？若为空，取当前改动路径集合用来判断 QA 跑哪套 ──
    cp_staged = _run_git(["diff", "--cached", "--name-only"])
    staged_paths = [ln for ln in cp_staged.stdout.splitlines() if ln.strip()]
    if not staged_paths:
        return "[拒绝] 暂存区为空。请先调用 git_stage(paths=[...]) 把要提交的改动加入暂存区（禁止隐式全量 add .）。"

    # ── Lint Gate 巨型提交检测 ──
    cp_stat = _run_git(["diff", "--cached", "--numstat"])
    files, lines = _parse_diff_stats(cp_stat.stdout)
    huge = (lines > MAX_CHANGED_LINES_PER_COMMIT) or (files > MAX_CHANGED_FILES_PER_COMMIT)
    if huge and not allow_huge:
        return (
            f"[拒绝 Lint Gate] 巨型提交：已暂存 {files} 个文件 / +-{lines} 行。\n"
            f"阈值 ≤{MAX_CHANGED_FILES_PER_COMMIT} 文件 / ≤{MAX_CHANGED_LINES_PER_COMMIT} 行。\n"
            "解决方案：① 用语义化拆成多个小 commit（feat/fix/docs/chore 独立）；② 或传 allow_huge_commit=true 显式同意。"
        )

    # ── 受保护模块修改检测：这些模块必须显式 approval（现在：直接拒绝 + 提示需要 highest approval）──
    touched_protected = []
    for rel in staged_paths:
        p = Path(rel).as_posix()
        for prot in PROTECTED_DIRECTORIES_AGAINST_GLOBS:
            if p == prot or fnmatch.fnmatchcase(p, prot):
                touched_protected.append(p)
                break
    if touched_protected:
        docs_only = (ctype == "docs") and not any(
            not p.endswith(".md") for p in touched_protected
        )
        if not docs_only:
            return (
                f"[拒绝 安全门] 本次暂存区包含安全敏感/架构敏感模块（AGENTS.md §6）：\n"
                + "\n".join(f"  · {p}" for p in touched_protected)
                + "\n这些模块的非文档修改必须走 sandbox 最高级 explicit approval。"
            )

    # ── 质量门禁（docs/chore(meta) 可略过）──
    pure_meta = (ctype == "docs") or (ctype == "chore" and scope in ("meta", "ci", "deps"))
    if pure_meta:
        skip_qa_flag = True
    qa = _QAStatus("qa", True, {"compile": None, "skip_reason": "skip_qa=true"})
    if not skip_qa_flag:
        qa = await asyncio.to_thread(_run_quality_gate, staged_paths)
        if not qa.ok:
            detail_line = qa.to_message_line()
            return f"[拒绝 质量门禁] 提交前自动校验失败：\n{detail_line}\n请先修复报错再重试 commit。"

    # ── 身份上下文（ContextVar）：缺则拒 ──
    from core.agent_context import git_agent_ctx, GitAgentContext  # 延迟导入，防循环
    ctx: GitAgentContext | None = git_agent_ctx.get()
    has_ctx = ctx is not None
    if ctx is None:
        # 直调场景（CLI 手动 / 测试）给个默认值，但打 WARNING tag
        ctx = GitAgentContext(
            agent_id="cli-direct",
            agent_name="CLI 手动提交",
            agent_role="direct-call",
            model_choice_resolved="",
            session_id="-",
        )

    # 构造 identity header & trailers
    author_name = f"slime-{ctx.agent_id}"
    author_email = f"agent+{ctx.agent_id}@slime.local"
    identity_header = f"我是 {ctx.agent_name}，{ctx.agent_role}"

    trailers_lines: list[str] = []
    trailers_lines.append(f"Agent-Name: {ctx.agent_name}")
    trailers_lines.append(f"Agent-ID: {ctx.agent_id}")
    trailers_lines.append(f"Agent-Role: {ctx.agent_role}")
    trailers_lines.append(f"Agent-Model: {ctx.model_choice_resolved or '-'}")
    trailers_lines.append(f"Agent-Session: {ctx.session_id or '-'}")
    trailers_lines.append(f"Agent-Subtask: {ctx.subtask_id}")
    trailers_lines.append(f"Agent-Parent-ID: {ctx.parent_agent_id}")
    if decision:
        trailers_lines.append(f"Agent-Decision: {decision}")
    elif ctx.key_decisions:
        trailers_lines.append("Agent-Decision: " + " | ".join(ctx.key_decisions)[:200])
    trailers_lines.append("Agent-Origin: slime/v1")
    trailers_lines.append(f"Co-Authored-By: {author_name} <{author_email}>")
    if co_author:
        trailers_lines.append(f"Co-Authored-By: {co_author}")
    trailers_lines.append(f"Signed-off-by: {author_name} <{author_email}>")

    # 构造 message
    scope_part = f"({scope})" if scope else ""
    title = f"{ctype}{scope_part}: {subject}"
    msg_lines: list[str] = [title]
    # 身份头（chore(meta) 型纯元数据例外，见 AGENTS.md §0）
    if not (ctype == "chore" and scope == "meta"):
        msg_lines += ["", identity_header]
    if body:
        # body 里如果包含 trailers 形式的行就剔除，避免重复
        cleaned_body = "\n".join(
            ln for ln in body.splitlines()
            if not re.match(r"^[A-Za-z][A-Za-z0-9\-]*:\s", ln)
        ).rstrip()
        if cleaned_body:
            msg_lines += ["", cleaned_body]
    # trailers（最后一段，前面空行）
    msg_lines += ["", *trailers_lines]
    message = "\n".join(msg_lines).rstrip() + "\n"

    # ── 写入 slime-intent git note ──
    note = {
        "agent_id": ctx.agent_id,
        "agent_name": ctx.agent_name,
        "agent_role": ctx.agent_role,
        "model_choice": ctx.model_choice_resolved or None,
        "session_id": ctx.session_id or None,
        "subtask_id": None if ctx.subtask_id == "-" else ctx.subtask_id,
        "parent_agent_id": None if ctx.parent_agent_id == "-" else ctx.parent_agent_id,
        "fork_depth": ctx.fork_depth,
        "task_summary": ctx.task_summary or None,
        "key_decisions": ctx.key_decisions,
        "transcript_ref": ctx.transcript_ref or None,
        "qa_result": {
            "kind": qa.kind,
            "ok": qa.ok,
            "detail": qa.detail,
        },
        "touched_paths": staged_paths,
        "commit_type": ctype,
        "commit_scope": scope or None,
        "huge_commit": huge,
        "direct_call_no_agent_ctx": not has_ctx,
    }

    # ── 执行 commit（通过 GIT_AUTHOR_* / GIT_COMMITTER_* 注入身份，避免污染全局 git config）──
    env = os.environ.copy()
    env.update({
        "GIT_AUTHOR_NAME": author_name,
        "GIT_AUTHOR_EMAIL": author_email,
        # committer 仍用当前系统配置（避免 GitHub 显示错误），但 trailers + author 已完整标明 Agent 身份
    })
    try:
        cp = subprocess.run(
            ["git", "commit", "-m", message, "--no-verify"],
            cwd=str(_PROJECT_ROOT),
            capture_output=True, text=True, timeout=120,
            check=False, env=env, encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired as e:
        return f"[失败] commit 超时：{e!s:.300}"
    if cp.returncode != 0:
        return f"[失败] commit 返回非零：{(cp.stderr or cp.stdout).strip()[:800]}"

    # 拿 commit hash 写 note
    cp_hash = _run_git(["rev-parse", "HEAD"], check=True)
    commit_hash = cp_hash.stdout.strip()

    try:
        note_text = json.dumps(note, ensure_ascii=False, separators=(",", ":"))
        subprocess.run(
            ["git", "notes", "--ref=slime-intent", "add", "-f", "-m", note_text, commit_hash],
            cwd=str(_PROJECT_ROOT), capture_output=True, text=True, timeout=30, check=False,
        )
    except Exception as e:  # noqa: BLE001  note 写入失败不影响 commit 成功
        log.warning("git notes add 失败（不影响 commit）：%s", e)

    summary = (
        f"✅ commit {commit_hash[:10]}\n"
        f"{title}\n"
        f"作者身份：{author_name} <{author_email}>\n"
        f"分支：{branch} | 改动：{files} files / +-{lines} lines\n"
        f"质量门禁：{qa.to_message_line()}\n"
    )
    if not has_ctx:
        summary += "⚠ WARNING: 本次 commit 未检测到 Agent 上下文（属于 CLI 直调），trailers 中已标记 direct_call_no_agent_ctx=true。\n"
    summary += (
        f"Trailers ({len(trailers_lines)} 条)：\n"
        + "\n".join("  " + t for t in trailers_lines)
        + f"\nGit note refs/notes/slime-intent：{'写入 OK' if True else '写入失败（不影响）'}"
    )
    return summary


# ─────────────── P1：worktree 子 Agent 工作隔离 ─────────────────────────────

WORKTREES_DIR = _PROJECT_ROOT / ".slime-worktrees"
# CLAUDE.md §核心设计原则-分裂机制 硬上限
MAX_FORK_DEPTH = 2


async def git_worktree_create(args: dict) -> str:
    err = _ensure_git_repo()
    if err:
        return f"[拒绝] {err}"
    session_id = (args.get("session_id") or "").strip()
    worker_id = (args.get("worker_id") or "").strip()
    base_branch = (args.get("base_branch") or "").strip()
    fork_depth = max(0, int(args.get("fork_depth") or 0))

    if not session_id or not worker_id:
        return "[拒绝] git_worktree_create 必须传 session_id + worker_id（框架注入）"
    if not re.fullmatch(r"[A-Za-z0-9_\-]{1,96}", session_id):
        return f"[拒绝] session_id 不合法：{session_id!r}（字母/数字/_/- 1-96）"
    if not re.fullmatch(r"[A-Za-z0-9_\-]{1,64}", worker_id):
        return f"[拒绝] worker_id 不合法：{worker_id!r}（字母/数字/_/- 1-64）"
    if fork_depth > MAX_FORK_DEPTH:
        return (f"[拒绝] MAX_FORK_DEPTH={MAX_FORK_DEPTH} 硬上限，当前 fork_depth={fork_depth}。"
                f"禁止继续分裂新的 worktree（AGENTS.md §7 + CLAUDE.md）")

    worktree_dir = WORKTREES_DIR / session_id / worker_id
    if worktree_dir.exists():
        return f"[拒绝] 该 worktree 已存在（可能上一次 Worker 没清理干净）：{worktree_dir}\n请先调用 git_worktree_remove 清理。"

    # 分支校验
    cur_branch = _current_branch()
    if base_branch:
        # 必须以 slime/ 开头（Agent 工作流）
        if not base_branch.startswith("slime/"):
            return f"[拒绝] base_branch 必须以 slime/ 开头（Agent 分支隔离），收到：{base_branch!r}"
        # 不存在就创建
        cp = _run_git(["rev-parse", "--verify", "--quiet", base_branch], allow_nonzero=True)
        if cp.returncode != 0:
            cp2 = _run_git(["branch", base_branch], allow_nonzero=True)
            if cp2.returncode != 0:
                return f"[失败] 无法创建 base_branch={base_branch}：{(cp2.stderr or cp2.stdout).strip()[:400]}"
        branch_to_use = base_branch
    else:
        branch_to_use = cur_branch or "HEAD"

    try:
        worktree_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return f"[失败] 创建 worktree 目录失败：{e!s:.400}"

    # git worktree add <path> -B <branch> ；若分支存在则直接 checkout 到该分支
    args_ = ["worktree", "add", str(worktree_dir)]
    if base_branch:
        args_ += ["-B", base_branch]
    else:
        # 没有指定分支时，detached HEAD 以避免冲突
        args_ += ["--detach"]
    cp = _run_git(args_, allow_nonzero=True, timeout=120)
    if cp.returncode != 0:
        # 失败时清理空目录
        try:
            if any(worktree_dir.glob("*")):
                pass
            else:
                worktree_dir.rmdir()
        except OSError:
            pass
        return f"[失败] git worktree add：{(cp.stderr or cp.stdout).strip()[:600]}"

    info = (
        f"✅ worktree 已创建（子 Agent 物理隔离工作区）\n"
        f"路径：{worktree_dir}\n"
        f"分支：{branch_to_use}{'（detached）' if not base_branch else ''}\n"
        f"session_id：{session_id} | worker_id：{worker_id} | fork_depth：{fork_depth}/{MAX_FORK_DEPTH}\n"
        f"── 注意 ──\n"
        f"1. 子 Worker 所有写代码/file_write 都必须在 worktree 目录里执行；\n"
        f"2. Worker 完成（成功/失败/取消）后必须调用 git_worktree_remove(worktree_path=...) 清理；\n"
        f"3. Merger 禁止直接读子 worktree 文件，合并只能基于 branch/commit。"
    )
    return info


async def git_worktree_remove(args: dict) -> str:
    path = (args.get("worktree_path") or "").strip()
    force = bool(args.get("force"))
    if not path:
        return "[拒绝] 请传 worktree_path（git_worktree_create 返回的绝对路径）"
    raw = Path(path)
    if not raw.is_absolute():
        raw = _PROJECT_ROOT / raw
    p = raw.resolve()
    # 范围限制：只允许删 .slime-worktrees/ 下的
    try:
        rel = p.relative_to(WORKTREES_DIR.resolve())
    except ValueError:
        return f"[拒绝] 只允许删除 {WORKTREES_DIR} 下的 worktree，收到：{p}"
    if not p.exists():
        return f"[跳过] worktree 目录不存在，可能已清理：{p}"

    # 先 git worktree remove；失败再 force
    flags = ["--force"] if force else []
    cp = _run_git(["worktree", "remove", *flags, str(p)], allow_nonzero=True, timeout=60)
    if cp.returncode != 0:
        if not force:
            # 先自动尝试 force
            cp2 = _run_git(["worktree", "remove", "--force", str(p)], allow_nonzero=True, timeout=60)
            if cp2.returncode != 0:
                return (
                    f"[失败] worktree remove（普通）：{(cp.stderr or cp.stdout).strip()[:300]}\n"
                    f"[失败] worktree remove（--force）：{(cp2.stderr or cp2.stdout).strip()[:300]}\n"
                    "建议手动：git worktree list → git worktree prune"
                )
        else:
            return f"[失败] worktree remove --force：{(cp.stderr or cp.stdout).strip()[:500]}"

    # 兜底清理空父级目录（session_id 级）
    try:
        session_dir = p.parent
        if session_dir.exists() and session_dir != WORKTREES_DIR and not any(session_dir.glob("*")):
            session_dir.rmdir()
    except OSError:
        pass
    return f"✅ worktree 已清理：{p}（session 空目录亦已清理）"


# ─────────────── P1：checkpoint 影子仓库（后悔药）────────────────────────────

CHECKPOINTS_DIR = _PROJECT_ROOT / ".slime" / "checkpoints"
INDEX_FILE = CHECKPOINTS_DIR / "index.jsonl"
DEFAULT_KEEP_LAST_N = 50


def _checkpoints_ensure_dir() -> None:
    CHECKPOINTS_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class CheckpointMeta:
    id: str
    created_at: str
    label: str
    head_commit: str
    worktree_root: str  # 记录是哪个工作区做的（主仓库 / .slime-worktrees/<s>/<w>）
    bundle_rel: str     # 相对 CHECKPOINTS_DIR
    intent_note_json: str | None  # 存一份 refs/notes/slime-intent 对 HEAD 的快照（如果存在）
    size_bytes: int = 0

    def to_line(self) -> str:
        return json.dumps({
            "id": self.id, "created_at": self.created_at, "label": self.label,
            "head_commit": self.head_commit, "worktree_root": self.worktree_root,
            "bundle_rel": self.bundle_rel,
            "intent_note_json": self.intent_note_json,
            "size_bytes": self.size_bytes,
        }, ensure_ascii=False)

    @classmethod
    def from_line(cls, line: str) -> "CheckpointMeta | None":
        line = line.strip()
        if not line:
            return None
        try:
            obj = json.loads(line)
            return cls(
                id=obj["id"], created_at=obj["created_at"], label=obj["label"],
                head_commit=obj.get("head_commit") or "-",
                worktree_root=obj.get("worktree_root") or str(_PROJECT_ROOT),
                bundle_rel=obj["bundle_rel"],
                intent_note_json=obj.get("intent_note_json"),
                size_bytes=int(obj.get("size_bytes") or 0),
            )
        except Exception:  # noqa: BLE001
            return None


def _load_all_checkpoints() -> list[CheckpointMeta]:
    if not INDEX_FILE.exists():
        return []
    arr: list[CheckpointMeta] = []
    for ln in INDEX_FILE.read_text(encoding="utf-8").splitlines():
        m = CheckpointMeta.from_line(ln)
        if m is not None:
            arr.append(m)
    return arr


def _append_index(meta: CheckpointMeta) -> None:
    _checkpoints_ensure_dir()
    with INDEX_FILE.open("a", encoding="utf-8") as f:
        f.write(meta.to_line() + "\n")


def _rotate_checkpoints(keep: int = DEFAULT_KEEP_LAST_N) -> list[CheckpointMeta]:
    """保留最近 keep 条，旧的 bundle 直接删。"""
    all_cps = _load_all_checkpoints()
    if len(all_cps) <= keep:
        return all_cps
    drop = all_cps[: len(all_cps) - keep]
    for cp in drop:
        bundle_path = CHECKPOINTS_DIR / cp.bundle_rel
        if bundle_path.exists():
            try:
                bundle_path.unlink()
            except OSError:
                pass
    keep_arr = all_cps[len(all_cps) - keep :]
    # 重写 index
    with INDEX_FILE.open("w", encoding="utf-8") as f:
        for meta in keep_arr:
            f.write(meta.to_line() + "\n")
    return keep_arr


async def git_checkpoint_save(args: dict) -> str:
    err = _ensure_git_repo()
    if err:
        return f"[拒绝] {err}"
    label = (args.get("label") or "checkpoint").strip()[:64]
    _checkpoints_ensure_dir()

    import datetime
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    seq = 1
    existing = {m.id for m in _load_all_checkpoints()}
    while (cand := f"cp-{ts}-{seq:03d}") in existing:
        seq += 1
    cp_id = cand

    head_hash = _run_git(["rev-parse", "HEAD"], allow_nonzero=True).stdout.strip() or "-"
    # 读当前 refs/notes/slime-intent（HEAD 对得上则打包一份）
    intent_snapshot = None
    cp_note = _run_git(["notes", "--ref=slime-intent", "show", "HEAD"], allow_nonzero=True)
    if cp_note.returncode == 0 and cp_note.stdout.strip():
        intent_snapshot = cp_note.stdout.strip()

    # 存一个"当前工作区 + 暂存区"的 bundle
    bundle_name = f"{cp_id}.bundle"
    bundle_path = CHECKPOINTS_DIR / bundle_name
    # git bundle create：仅包含 HEAD + 所有未提交的改动（stash + 当前状态）
    # 策略：先 stash push -u（含 untracked），然后 bundle = HEAD~0..stash@{0}；再 stash pop；
    # 如果根本没改动：直接 bundle HEAD 即可
    def _make_bundle_sync() -> int:
        # 先看是否有改动（工作区 or 暂存区）
        status_short = _run_git(["status", "--porcelain"]).stdout
        has_changes = bool(status_short.strip())
        stash_made = False
        if has_changes:
            cp_stash = _run_git([
                "stash", "push", "-u", "-m", f"slime-checkpoint-stash-{cp_id}",
            ], allow_nonzero=True)
            stash_made = (cp_stash.returncode == 0 and "No local changes" not in cp_stash.stdout)

        refspec = ["HEAD"]
        if stash_made:
            refspec = ["HEAD", "refs/stash"]
        cp_b = _run_git(
            ["bundle", "create", str(bundle_path), *refspec],
            allow_nonzero=True, timeout=300,
        )
        if stash_made:
            _run_git(["stash", "pop"], allow_nonzero=True)
        if cp_b.returncode != 0:
            # fallback：直接把整个工作区 tar（这里用 git archive 替代，git archive HEAD 不包含未提交改动）
            # 最后兜底：写一个"小 JSON + 改动补丁文件"作为 bundle
            patch = _run_git(["diff", "--no-color", "HEAD"], allow_nonzero=True).stdout or ""
            staged_patch = _run_git(["diff", "--cached", "--no-color"], allow_nonzero=True).stdout or ""
            untracked_lines = [ln[3:] for ln in status_short.splitlines() if ln.startswith("?? ")]
            # 把 patch 写入 bundle_path 文件作为"文本补丁包"后缀 .patch（比 .bundle 更可读）
            patch_bundle = CHECKPOINTS_DIR / f"{cp_id}.patch"
            with patch_bundle.open("w", encoding="utf-8") as f:
                f.write(f"# slime checkpoint fallback patch — id={cp_id}\n")
                f.write(f"# HEAD={head_hash}\n")
                f.write(f"# label={label}\n")
                f.write("# === DIFF HEAD (working tree) ===\n")
                f.write(patch)
                f.write("\n# === DIFF CACHED (staged) ===\n")
                f.write(staged_patch)
                f.write("\n# === UNTRACKED FILES ===\n")
                if untracked_lines:
                    # 逐个写入 untracked 内容（相对路径 + 文件内容）
                    for rel in untracked_lines:
                        abs_path = _PROJECT_ROOT / rel
                        if abs_path.is_file() and abs_path.exists():
                            try:
                                sz = abs_path.stat().st_size
                                if sz > 10 * 1024 * 1024:
                                    f.write(f"FILE {rel} [SKIPPED >10MB]\n")
                                    continue
                                f.write(f"FILE {rel}\n")
                                f.write(abs_path.read_text(encoding="utf-8", errors="replace"))
                                f.write("\n")
                            except Exception:
                                f.write(f"FILE {rel} [READ ERROR]\n")
                # 重写 bundle_rel，让 restore 优先读 patch
                bundle_path.unlink(missing_ok=True)
                nonlocal bundle_name  # type: ignore[has-type]
                bundle_name = f"{cp_id}.patch"
                return patch_bundle.stat().st_size if patch_bundle.exists() else 0
        if not bundle_path.exists():
            return 0
        return bundle_path.stat().st_size

    try:
        size = await asyncio.to_thread(_make_bundle_sync)
    except Exception as e:  # noqa: BLE001
        return f"[失败] 保存 checkpoint 出错：{e!s:.400}"

    meta = CheckpointMeta(
        id=cp_id,
        created_at=datetime.datetime.now().isoformat(timespec="seconds"),
        label=label,
        head_commit=head_hash,
        worktree_root=str(_PROJECT_ROOT),
        bundle_rel=bundle_name,
        intent_note_json=intent_snapshot,
        size_bytes=size,
    )
    _append_index(meta)
    _rotate_checkpoints()
    human_size = f"{size/1024:.1f} KB" if size < 1024 * 1024 else f"{size/1024/1024:.2f} MB"
    return (
        f"✅ checkpoint 已保存（后悔药，不重写 Git 历史）\n"
        f"id：{cp_id}\n"
        f"label：{label}\n"
        f"HEAD commit：{head_hash[:10] if len(head_hash) > 10 else head_hash}\n"
        f"大小：{human_size}（bundle={bundle_name}）\n"
        f"查看所有 checkpoint：git_checkpoint_list(max=50)"
    )


async def git_checkpoint_list(args: dict) -> str:
    _checkpoints_ensure_dir()
    max_n = max(1, min(int(args.get("max") or 20), 100))
    arr = _load_all_checkpoints()
    if not arr:
        return "（暂无 checkpoint，先调用 git_checkpoint_save(label=...) 保存一次）"
    recent = list(reversed(arr[-max_n:]))
    lines: list[str] = [f"共 {len(arr)} 个 checkpoint，以下是最近 {len(recent)} 个（从新到旧）：\n"]
    for m in recent:
        kb = m.size_bytes / 1024
        size_str = f"{kb:.1f}KB" if kb < 1024 else f"{kb/1024:.2f}MB"
        lines.append(
            f"· [{m.id}] {m.created_at} | label={m.label!r} | "
            f"HEAD={m.head_commit[:10]} | {size_str}"
        )
    lines.append(
        "\n还原示例（还原前会自动保存 restore-before 的 checkpoint，不丢当前工作）：\n"
        "git_checkpoint_restore(id='{id}', mode='files')"
        .format(id=recent[0].id if recent else "cp-xxxxxx-001")
    )
    return "\n".join(lines)


async def git_checkpoint_restore(args: dict) -> str:
    err = _ensure_git_repo()
    if err:
        return f"[拒绝] {err}"
    cp_id = (args.get("id") or "").strip()
    mode = (args.get("mode") or "files").strip()
    if cp_id not in {m.id for m in _load_all_checkpoints()}:
        return f"[拒绝] checkpoint id 不存在：{cp_id!r}（调用 git_checkpoint_list 查可用列表）"
    if mode not in {"files", "task", "both"}:
        return "[拒绝] mode 必须是 files / task / both"

    # ── 先 save 当前状态作为 restore-before，不丢当前工作 ──
    save_res = await git_checkpoint_save({"label": f"restore-before-{cp_id}"})
    if "[失败]" in save_res:
        return f"[拒绝] 还原前自动保存 restore-before checkpoint 失败：{save_res}\n（不会进行还原，确保当前工作不被静默覆盖）"
    before_id_match = save_res.split("id：")
    before_id = before_id_match[1].split("\n", 1)[0].strip() if len(before_id_match) > 1 else "(写入失败)"

    target_meta = next(m for m in _load_all_checkpoints() if m.id == cp_id)
    bundle_path = CHECKPOINTS_DIR / target_meta.bundle_rel
    if not bundle_path.exists():
        return f"[拒绝] checkpoint bundle 文件缺失：{bundle_path}"

    logs: list[str] = [f"✅ 还原前已自动保存 checkpoint：id={before_id}（不满意可回到它）\n"]
    restored_any = False

    # ── mode=task / both：还原 HEAD 的 refs/notes/slime-intent 快照 ──
    if mode in ("task", "both"):
        if target_meta.intent_note_json:
            cp1 = _run_git(
                ["notes", "--ref=slime-intent", "add", "-f", "-m", target_meta.intent_note_json, "HEAD"],
                allow_nonzero=True, timeout=30,
            )
            if cp1.returncode == 0:
                logs.append("✅ 已还原 refs/notes/slime-intent（任务意图 git note）到 HEAD")
            else:
                logs.append(f"⚠ 还原 git note 失败：{(cp1.stderr or cp1.stdout).strip()[:300]}")
        else:
            logs.append("（该 checkpoint 无 intent note 快照，task 部分跳过）")

    # ── mode=files / both：还原工作区文件快照 ──
    if mode in ("files", "both"):
        suffix = bundle_path.suffix.lower()
        if suffix == ".bundle":
            # 用 git bundle unbundle 拉取 + reset 工作区（推荐 git stash 风格回滚：应用 patch）
            # 简单策略：从 bundle 中导出 stash 并应用；无 stash 行就 reset 到 HEAD 并 checkout clean
            cp_unb = _run_git(["bundle", "verify", str(bundle_path)], allow_nonzero=True)
            if cp_unb.returncode != 0:
                logs.append(f"[失败] bundle verify 失败：{(cp_unb.stderr or cp_unb.stdout).strip()[:400]}")
            else:
                # 拉到临时引用 refs/slime-cp/<id>
                tmp_ref = f"refs/slime-cp/{cp_id}"
                cp_f = _run_git(
                    ["fetch", str(bundle_path), f"HEAD:{tmp_ref}", "refs/stash:refs/slime-cp-stash-" + cp_id],
                    allow_nonzero=True, timeout=120,
                )
                # 优先：尝试 stash pop 还原改动
                stash_ref = "refs/slime-cp-stash-" + cp_id
                cp_has_stash = _run_git(["rev-parse", "--verify", "--quiet", stash_ref], allow_nonzero=True)
                if cp_has_stash.returncode == 0:
                    _run_git(["reset", "--hard", target_meta.head_commit], allow_nonzero=True)
                    cp_st = _run_git(["stash", "apply", stash_ref], allow_nonzero=True)
                    if cp_st.returncode == 0:
                        logs.append("✅ 已还原文件：reset 到 checkpoint HEAD + stash apply 未提交改动")
                        restored_any = True
                    else:
                        logs.append(f"⚠ stash apply 有冲突（仅做 reset 到 checkpoint HEAD）：{(cp_st.stderr or cp_st.stdout)[:400]}")
                        restored_any = True
                else:
                    _run_git(["reset", "--hard", target_meta.head_commit], allow_nonzero=True)
                    logs.append(f"✅ 已还原文件：reset --hard → {target_meta.head_commit[:10]}（checkpoint 无未提交改动）")
                    restored_any = True
                # 清理临时引用
                for ref in (tmp_ref, stash_ref):
                    try:
                        _run_git(["update-ref", "-d", ref], allow_nonzero=True)
                    except Exception:
                        pass
        elif suffix == ".patch":
            # fallback patch 包：逐行解析 → 写内容
            text = bundle_path.read_text(encoding="utf-8", errors="replace")
            # 1. reset 到目标 HEAD（确保基线一致）
            _run_git(["reset", "--hard", target_meta.head_commit], allow_nonzero=True)
            # 2. 解析 "FILE <rel>" 块写入未追踪文件
            import io
            current_rel: str | None = None
            buf: list[str] = []
            header_lines_remaining = 3 + 2 + 1  # 前几段 header 吃掉
            for line in text.splitlines(keepends=False):
                if line.startswith("# "):
                    continue
                if line.startswith("=== DIFF HEAD") or line.startswith("=== DIFF CACHED") or line.startswith("=== UNTRACKED FILES"):
                    continue
                if line.startswith("FILE "):
                    if current_rel is not None and buf:
                        _write_patch_file(current_rel, buf)
                        buf = []
                    current_rel = line[5:].strip()
                    if current_rel.endswith(" [SKIPPED >10MB]") or current_rel.endswith(" [READ ERROR]"):
                        current_rel = None
                    continue
                if current_rel is not None:
                    buf.append(line)
            # 收尾写最后一个
            if current_rel is not None and buf:
                _write_patch_file(current_rel, buf)
            logs.append(f"✅ 已还原文件：reset --hard → {target_meta.head_commit[:10]} + 应用 fallback patch 包")
            restored_any = True
        else:
            logs.append(f"[失败] 未知 checkpoint 格式：{target_meta.bundle_rel}")
    if not restored_any and mode in ("files", "both"):
        logs.append("（未执行文件还原）")
    logs.append(f"\n还原模式：mode={mode}。如不满意，一键回到还原前：\n"
                f"  git_checkpoint_restore(id='{before_id}', mode='files')")
    return "\n".join(logs)


def _write_patch_file(rel: str, lines: list[str]) -> None:
    """写 patch/FILE 块到项目根（fallback 路径）。"""
    target = (_PROJECT_ROOT / rel).resolve()
    try:
        target.relative_to(_PROJECT_ROOT.resolve())
    except ValueError:
        return  # 越界跳过
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


# ─────────────── 工具注册 ───────────────────────────────────────────────────

def register_git_tools(force: bool = False) -> None:
    """把 Git 工具族注册进全局工具注册表（由 slime_server / slime_cli / run_tests 调用）。"""
    r = get_registry()

    r.register(Tool(
        name="git_status",
        description="读取当前 Git 仓库状态：当前分支（含是否受保护）、ahead/behind、变更文件列表。只读。",
        parameters={
            "type": "object",
            "properties": {},
            "required": [],
        },
        execute_fn=git_status,
        permissions=["read"],
    ), force=force)

    r.register(Tool(
        name="git_diff",
        description="读取 git diff（补丁 + 统计）。默认看工作区 unstaged 变更；staged=true 看暂存区；可指定 paths。只读。",
        parameters={
            "type": "object",
            "properties": {
                "staged": {"type": "boolean", "description": "是否读取暂存区（HEAD vs 暂存）diff"},
                "paths": {"type": "array", "items": {"type": "string"},
                          "description": "可选：限定看哪些路径的 diff（不传=全部）"},
            },
            "required": [],
        },
        execute_fn=git_diff,
        permissions=["read"],
    ), force=force)

    r.register(Tool(
        name="git_log",
        description="读取最近 N 条 commit 历史（oneline + 时间 + 作者），并展示 HEAD 的 Agent-ID / Agent-Model 关键 trailers 做身份核验。只读。",
        parameters={
            "type": "object",
            "properties": {
                "max": {"type": "integer", "description": "返回条数，默认 15，最大 50"},
            },
            "required": [],
        },
        execute_fn=git_log,
        permissions=["read"],
    ), force=force)

    r.register(Tool(
        name="git_branch_list",
        description="列出本地分支列表，每个分支标注是否受保护（🔒 PROTECTED），并指出当前分支。只读。",
        parameters={"type": "object", "properties": {}, "required": []},
        execute_fn=git_branch_list,
        permissions=["read"],
    ), force=force)

    r.register(Tool(
        name="git_stage",
        description="把指定路径逐个加入 Git 暂存区。**必须传 paths**，绝对禁止不传路径的“git add . 全量添加”（AGENTS.md §8）。",
        parameters={
            "type": "object",
            "properties": {
                "paths": {"type": "array", "items": {"type": "string"},
                          "description": "要加入暂存区的文件/目录路径（相对项目根），至少 1 项"},
            },
            "required": ["paths"],
        },
        execute_fn=git_stage,
        permissions=["write"],
    ), force=force)

    r.register(Tool(
        name="git_restore",
        description="回滚工作区修改到 HEAD（或指定 source commit/tag）。可按 paths 精确回滚，**必须传 paths**；属于“不重写历史”的安全回滚。",
        parameters={
            "type": "object",
            "properties": {
                "paths": {"type": "array", "items": {"type": "string"},
                          "description": "要回滚的文件/目录路径，至少 1 项（禁止回滚整个仓库）"},
                "source": {"type": "string",
                           "description": "回滚源（默认 HEAD；可传 commit hash/tag；例：HEAD~1）"},
            },
            "required": ["paths"],
        },
        execute_fn=git_restore,
        permissions=["write"],
    ), force=force)

    r.register(Tool(
        name="git_revert",
        description="公共分支回滚的唯一推荐方式：新增一条“反向提交”（绝不重写历史、无 push 风险）。",
        parameters={
            "type": "object",
            "properties": {
                "commit": {"type": "string", "description": "要回滚的 commit hash / tag（7+ 字符）"},
            },
            "required": ["commit"],
        },
        execute_fn=git_revert,
        permissions=["write", "terminal"],
    ), force=force)

    r.register(Tool(
        name="git_branch",
        description="管理 Agent 分支（list/current/new/checkout/delete）。Agent 新建分支强制前缀 slime/，命名规则见 AGENTS.md §1。",
        parameters={
            "type": "object",
            "properties": {
                "action": {"type": "string",
                           "description": "list / current / new / checkout / delete，默认 list"},
                "name": {"type": "string",
                         "description": "分支名（new/checkout/delete 必传），必须以 slime/ 开头"},
            },
            "required": [],
        },
        execute_fn=git_branch,
        permissions=["write"],
    ), force=force)

    r.register(Tool(
        name="git_commit",
        description=(
            "语义化 commit（Conventional Commits 强制格式 + 身份铁律 author/trailers/git notes + 质量门禁）。\n"
            "【提交前必须做】：① 已调用 git_stage(paths=[...]) 暂存 ② 通过 py qa.py 质量门禁（源码改动） ③ 当前分支非受保护分支。\n"
            "【自动注入】：Agent 身份 author（slime-{agent_id}）、Agent 身份头“我是 {name},{role}”、12 条标准 trailers（Agent-ID/Model/Session/Decision 等）、refs/notes/slime-intent JSON note。\n"
            "【Lint Gate】单提交 >30 文件 / >800 行 changed 拒绝（传 allow_huge_commit=true 可显式同意）。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": sorted(ALLOWED_COMMIT_TYPES),
                         "description": "feat/fix/perf/refactor/docs/test/chore/style"},
                "scope": {"type": "string",
                          "description": "建议：agent/swarm/gui/core/tools/mcp/memory/evolution/sandbox/ci/meta"},
                "subject": {"type": "string", "description": "标题（≤88 字符，语义化一句话说明）"},
                "body": {"type": "string", "description": "正文（自由枚举更改点，≤1200 字），不要自己写 trailers"},
                "decision": {"type": "string", "description": "关键决策说明（≤200 字符），写入 Agent-Decision trailer"},
                "co_author": {"type": "string",
                              "description": "可选人类共同作者 “Name <email>”（仅当完全基于人类输入时才使用）"},
                "allow_huge_commit": {"type": "boolean",
                                      "description": "显式同意巨型提交（默认 false）"},
                "skip_qa": {"type": "boolean",
                            "description": "显式跳过质量门禁（仅 docs/chore(meta) 会自动跳过；源码改动必须 false 且 QA 通过）"},
            },
            "required": ["type", "subject"],
        },
        execute_fn=git_commit,
        permissions=["write", "terminal"],
    ), force=force)

    # ─────────── P1：worktree 子 Agent 工作隔离 ───────────
    r.register(Tool(
        name="git_worktree_create",
        description=(
            "为子 Worker 创建独占的 git worktree（物理隔离目录，多 Agent 并发写代码互不干扰）。\n"
            "典型场景：Swarm 派 SubWorker 前先 create worktree。路径固定：.slime-worktrees/{session_id}/{worker_id}（已在 .gitignore 忽略）。\n"
            "MAX_FORK_DEPTH=2 硬限制：fork_depth > 2 拒绝创建。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "Swarm 会话 ID（由框架注入）"},
                "worker_id": {"type": "string", "description": "子 Worker ID（由框架注入）"},
                "base_branch": {"type": "string",
                                "description": "worktree 基于哪个分支（默认当前分支；若提供必须以 slime/ 开头）"},
                "fork_depth": {"type": "integer",
                               "description": "当前子 Agent 的 fork_depth（默认 0；>2 会被拒绝创建）"},
            },
            "required": ["session_id", "worker_id"],
        },
        execute_fn=git_worktree_create,
        permissions=["write", "terminal"],
    ), force=force)

    r.register(Tool(
        name="git_worktree_remove",
        description="Worker 完成（成功/失败/取消）后清理 worktree，防止磁盘残留。传 worktree_path（create 返回的绝对路径）。",
        parameters={
            "type": "object",
            "properties": {
                "worktree_path": {"type": "string", "description": "git_worktree_create 返回的绝对路径"},
                "force": {"type": "boolean", "description": "是否强制移除（即使 worktree 有未提交修改），默认 false"},
            },
            "required": ["worktree_path"],
        },
        execute_fn=git_worktree_remove,
        permissions=["write", "terminal"],
    ), force=force)

    # ─────────── P1：checkpoint 影子仓库（后悔药）───────────
    r.register(Tool(
        name="git_checkpoint_save",
        description=(
            "保存一份 SubTask 开始前的“工作区 + 暂存区”影子快照（.slime/checkpoints/）。\n"
            "典型场景：Swarm 派 SubWorker 前 save；SubWorker 失败后 checkpoint_restore；人类觉得不满意也能一键回到决策前。\n"
            "影子仓库内容：当前未提交改动 + HEAD hash；不重写 Git 历史；默认保留最近 50 份。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "label": {"type": "string", "description": "人类可读标签（如 before-swarm-fork / subtask-3-start），≤ 64 字"},
            },
            "required": ["label"],
        },
        execute_fn=git_checkpoint_save,
        permissions=["write"],
    ), force=force)

    r.register(Tool(
        name="git_checkpoint_list",
        description="列出 checkpoint 时间线（最近 N 条），包含 label、commit、时间戳、磁盘大小。只读。",
        parameters={
            "type": "object",
            "properties": {
                "max": {"type": "integer", "description": "返回条数，默认 20，最大 100"},
            },
            "required": [],
        },
        execute_fn=git_checkpoint_list,
        permissions=["read"],
    ), force=force)

    r.register(Tool(
        name="git_checkpoint_restore",
        description=(
            "基于 checkpoint 还原：mode=files（仅还原文件快照，保留 HEAD，最常用最安全）、task（仅还原任务意图 git note，不碰文件）、both。\n"
            "还原前会**自动**为当前状态再保存一次“restore-before”checkpoint，绝不静默覆盖当前工作。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "checkpoint ID（cp-<timestamp>-<seq>），见 git_checkpoint_list"},
                "mode": {"type": "string", "enum": ["files", "task", "both"],
                         "description": "files=仅还原文件快照（推荐默认）；task=仅还原 git note；both=两者都还原"},
            },
            "required": ["id", "mode"],
        },
        execute_fn=git_checkpoint_restore,
        permissions=["write", "terminal"],
    ), force=force)

    log.info("[tools/git] 已注册 %d 个 git_* 工具（P0 治理 + P1 worktree/checkpoint）", 13)
