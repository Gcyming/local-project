"""tests/test_git_write_guard.py — tools/git.py 的写入绕过守卫（A-1197 / P0）。

## 这一轮补的是哪个洞
`tools/git.py` 的 `_write_patch_file` 原先**只判「在项目根内」**：
既不认受保护目录（`_WRITE_BLOCKED_DIRS`），也不认敏感文件名/后缀
（`_WRITE_BLOCKED_NAMES` / `_WRITE_BLOCKED_SUFFIXES`），更不认 A-1197 的豁免与归属判定。
可达性**已核实**（非理论）：`git_checkpoint_save` 的 fallback 分支把未追踪文件的**完整
内容**以 `FILE <相对路径>` 行写进 `.slime/checkpoints/<id>.patch`（采集源无过滤），
`git_checkpoint_restore(mode="files")` 解析 `FILE ` 行后原样交给 `_write_patch_file`；
而 `.slime/` 既不在 `PROTECTED_DIRS` 里又被 `.gitignore` 忽略 ⇒ 它自己是「未追踪文件」
⇒ 能进**下一轮** checkpoint 的采集包 ⇒ 自举闭环。
净效果：Agent 可借 checkpoint 还原链覆写 `config/agents.json` / `slime.toml` /
`core/agent.py` 等受保护文件。同族次生缺口：`git_restore` 的 `paths` 零校验。

## 为什么本文件的断言必须打 monkeypatch（而不是直接调）
`_is_blocked_write_path` 判的是「**相对项目根**的路径」，`tools.builtin._PROJECT_ROOT`
与 `tools.git._PROJECT_ROOT` **各一份、互不相干**。只要把两者都指到 tmp_path，
本文件就能在**完全不碰真实仓库**的前提下跑真实的判定逻辑（而不是复刻一份判定）。
`git_restore` 的 `_run_git` 也被替换成桩 ⇒ 绝不真的执行 `git restore`。

## 反静默自检（铁律）
本项目前科：定位写错 ⇒ 返回空集合 ⇒「空 == 空」的断言永远绿。
故本文件所有**计数类/日志类**断言都先跑 `_assert_capture_works` 证明
「捕获机制本身抓得到东西」（计数 ≠ 0），再对本次调用断言精确条数。

## 有意的口径取舍（不是遗漏）
`slime.toml` 与 `config/agents.json` 都在 `_WRITE_BLOCKED_NAMES` 里
⇒ checkpoint 还原**从此不再能恢复这两个文件**。这与 `file_write` 现行口径完全一致
（同样拦），是刻意对齐：还原链不是写入后门。本文件把这条取舍钉成断言，防止
后人「为了修还原功能」而单方面放宽 checkpoint 侧。
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
from pathlib import Path

import pytest

# ── 被测单元 ────────────────────────────────────────────────────────────────
from tools import builtin as builtin_mod
from tools import git as git_mod
from tools.builtin import _is_blocked_write_path
from tools.git import _write_patch_file, git_restore

# ── D 段（采集端）要用的被测单元 ──────────────────────────────────────────
from tools.git import (
    CHECKPOINT_UNTRACKED_MAX_BYTES,
    SKIP_REASON_PROTECTED,
    SKIP_REASON_SELF_REF,
    SKIP_REASON_TOO_LARGE,
    _filter_checkpoint_untracked,
)

# ── 六类场景的样例路径（相对项目根、小写 POSIX）────────────────────────────
P_SENSITIVE_JSON = "config/agents.json"      # ① 敏感文件名（_WRITE_BLOCKED_NAMES）
P_SENSITIVE_TOML = "slime.toml"              # ② 敏感文件名（同时命中 .toml 后缀集）
P_PROTECTED_DIR = "core/agent.py"            # ③ 受保护目录（_WRITE_BLOCKED_DIRS）
P_EXEMPT_NEW = "config/plugins/a1197-new-tool/plugin.json"   # ④ 豁免 + 新建 ⇒ 放行
P_RESERVED = "config/plugins/subagent/plugin.json"           # ⑤ 豁免但保留资产 ⇒ 拦


@pytest.fixture
def fake_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """把两个模块的 _PROJECT_ROOT 都指到 tmp_path —— 不碰真实仓库。"""
    root = tmp_path / "proj"
    (root / "config").mkdir(parents=True)
    (root / "core").mkdir(parents=True)
    monkeypatch.setattr(git_mod, "_PROJECT_ROOT", root)
    monkeypatch.setattr(builtin_mod, "_PROJECT_ROOT", root)
    return root


@pytest.fixture
def no_git(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """把 `_run_git` 换成桩：记录调用、不执行。保证测试绝不真的 restore。"""
    calls: list[list[str]] = []

    def fake_run_git(args, **kw):
        calls.append(list(args))
        return subprocess.CompletedProcess(args=["git", *args], returncode=0,
                                           stdout="true", stderr="")

    monkeypatch.setattr(git_mod, "_run_git", fake_run_git)
    return calls


def _restores(calls: list[list[str]]) -> list[list[str]]:
    """从 _run_git 调用里筛出**真正改工作区**的命令。

    ⚠️ 不能断言 `calls == []`：`git_restore` 入口的 `_ensure_git_repo()` 本来就会
    跑一次 `git rev-parse --is-inside-work-tree`（既有行为，不该被本次改动影响）。
    判据是「一条 restore 都没发」。
    """
    return [c for c in calls if "restore" in c]


# ── 反静默自检：证明「日志捕获机制」抓得到东西 ──────────────────────────────
def _assert_capture_works(caplog: pytest.LogCaptureFixture, root: Path) -> None:
    """先自测计数不是 0：若这里恒为 0，说明日志捕获本身坏了，后面所有
    「应当出声」的断言都会静默通过 ⇒ 守卫失效且不响。"""
    with caplog.at_level(logging.WARNING, logger="slime.git-tools"):
        _write_patch_file(P_PROTECTED_DIR, ["SELFTEST"])
    n = len([r for r in caplog.records if r.levelno >= logging.WARNING])
    assert n > 0, (
        "反静默自检失败：连已知受保护路径 core/agent.py 都没产生任何 WARNING ⇒ "
        "要么守卫没实现，要么 caplog 捕获失效。此刻本文件其余「应当出声」断言全部不可信。"
    )


def _warnings(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]


# ══════════════════════════════════════════════════════════════════════════
# A. `_write_patch_file` —— checkpoint 还原链的落盘口
# ══════════════════════════════════════════════════════════════════════════

def test_A1_selfcheck_capture_is_live(caplog, fake_root) -> None:
    """反静默自检单独成例：它绿了，后面的「应当出声」断言才有意义。"""
    _assert_capture_works(caplog, fake_root)
    # 自测完必须确认：受保护文件**真的没被写出来**（否则自检本身就污染了）。
    assert not (fake_root / P_PROTECTED_DIR).exists()


def test_A2_sensitive_json_is_blocked(fake_root, caplog) -> None:
    """① config/agents.json —— 敏感文件名，被拒且出声。"""
    with caplog.at_level(logging.WARNING, logger="slime.git-tools"):
        _write_patch_file(P_SENSITIVE_JSON, ['{"pwned": true}'])
    _assert_capture_works(caplog, fake_root)  # 证明计数机制不是恒 0
    assert not (fake_root / P_SENSITIVE_JSON).exists(), "config/agents.json 竟被还原写出了"
    warns = _warnings(caplog)
    assert any(P_SENSITIVE_JSON in m for m in warns), f"拒绝必须出声（禁静默失效），实际日志：{warns}"
    # 也不能凭空造出父目录
    assert not (fake_root / "config" / "agents.json").exists()


def test_A3_sensitive_toml_is_blocked(fake_root, caplog) -> None:
    """② slime.toml —— 敏感文件名（且命中 .toml 后缀集），被拒。"""
    with caplog.at_level(logging.WARNING, logger="slime.git-tools"):
        _write_patch_file(P_SENSITIVE_TOML, ["x = 1"])
    _assert_capture_works(caplog, fake_root)
    assert not (fake_root / P_SENSITIVE_TOML).exists(), "slime.toml 竟被还原写出了"


def test_A4_protected_dir_is_blocked(fake_root, caplog) -> None:
    """③ core/agent.py —— 受保护目录，被拒。"""
    with caplog.at_level(logging.WARNING, logger="slime.git-tools"):
        _write_patch_file(P_PROTECTED_DIR, ["raise SystemExit(1)"])
    _assert_capture_works(caplog, fake_root)
    assert not (fake_root / P_PROTECTED_DIR).exists(), "core/agent.py 竟被还原写出了"


def test_A5_exempt_new_asset_is_allowed(fake_root, caplog) -> None:
    """④ config/plugins/<新名>/... —— A-1197 豁免**未被误伤**。

    这条是本文件最重要的负向断言：修漏洞很容易连合法的「Agent 自建插件」一起拦掉。
    tmp 根下 config/plugins 不存在 ⇒ 判据走「资产目录不存在 ⇒ 放行」这条。
    """
    with caplog.at_level(logging.WARNING, logger="slime.git-tools"):
        _write_patch_file(P_EXEMPT_NEW, ['{"name": "a1197-new-tool"}'])
    assert (fake_root / P_EXEMPT_NEW).is_file(), (
        "豁免路径被误伤了：config/plugins 下的新建资产必须放行"
        "（与 file_write 的 A-1197 豁免同口径）"
    )
    assert (fake_root / P_EXEMPT_NEW).read_text(encoding="utf-8").strip() == '{"name": "a1197-new-tool"}'


def test_A6_reserved_asset_is_blocked(fake_root, caplog) -> None:
    """⑤ config/plugins/<内置保留名>/... —— 保留资产永不放行（即使目录不存在）。"""
    assert not (fake_root / "config" / "plugins" / "subagent").exists(), (
        "本用例依赖「保留资产目录不存在」—— 若它存在，判据会改走归属分支，含义就变了"
    )
    with caplog.at_level(logging.WARNING, logger="slime.git-tools"):
        _write_patch_file(P_RESERVED, ['{"name": "subagent"}'])
    _assert_capture_works(caplog, fake_root)
    assert not (fake_root / P_RESERVED).exists(), "内置保留插件目录竟被还原覆写了"


def test_A7_outside_project_still_rejected(fake_root) -> None:
    """⑥ 项目外路径仍被拒 —— 原有语义不许被放宽。

    走的是 `relative_to` 那道越界检查（早于黑名单判定），且是**静默** return：
    越界是「不是我们的路径」，与「命中黑名单」不同类，故不要求出声。
    """
    outside = fake_root.parent / "evil" / "x.json"
    _write_patch_file("../evil/x.json", ["{}"])
    assert not outside.exists(), "项目外路径竟被写出了"
    assert not (fake_root.parent / "evil").exists()


def test_A8_sibling_prefix_escape_rejected(fake_root) -> None:
    """⑦ `..` 恰好吃掉前缀的越界（`../proj-evil`）—— 原语义的边界不许漏。"""
    _write_patch_file("../proj-evil/x.json", ["{}"])
    assert not (fake_root.parent / "proj-evil").exists()


def test_A9_real_repo_untouched_by_this_file() -> None:
    """⑧ 本文件自身不许污染真实仓库（fixture 全程用 tmp_path）。

    这条不是形式主义：一旦有人把 fixture 改成真 _PROJECT_ROOT，
    前面的 A2~A6 就会真的覆写 config/agents.json / slime.toml。
    这里钉住「真实根下这些受保护文件存在」，作为 fixture 未被篡改的旁证。
    """
    real_root = Path(builtin_mod.__file__).resolve().parent.parent
    assert (real_root / "config").is_dir(), "真实项目根结构异常，fixture 假设可能已失效"
    assert (real_root / "slime.toml").is_file()
    assert (real_root / "core" / "agent.py").is_file()


# ══════════════════════════════════════════════════════════════════════════
# B. `git_restore` —— 同族次生缺口：paths 零校验
# ══════════════════════════════════════════════════════════════════════════

def _restore(args: dict) -> str:
    return asyncio.run(git_restore(args))


def test_B1_restore_rejects_sensitive_json(fake_root, no_git) -> None:
    """① config/agents.json 被 git_restore 拒绝。"""
    out = _restore({"paths": [P_SENSITIVE_JSON]})
    assert "[拒绝]" in out, f"受保护路径必须被拒，实际返回：{out}"
    assert P_SENSITIVE_JSON in out, f"拒绝文案必须点名被拒的路径（不静默过滤），实际：{out}"
    assert _restores(no_git) == [], f"拒绝后不得发出任何 restore 命令，实际调用：{no_git}"


def test_B2_restore_rejects_sensitive_toml(fake_root, no_git) -> None:
    """② slime.toml 被 git_restore 拒绝。"""
    out = _restore({"paths": [P_SENSITIVE_TOML]})
    assert "[拒绝]" in out and P_SENSITIVE_TOML in out, out
    assert _restores(no_git) == [], no_git


def test_B3_restore_rejects_protected_dir(fake_root, no_git) -> None:
    """③ core/agent.py（受保护目录）被 git_restore 拒绝。"""
    out = _restore({"paths": [P_PROTECTED_DIR]})
    assert "[拒绝]" in out and P_PROTECTED_DIR in out, out
    assert _restores(no_git) == [], no_git


def test_B4_restore_allows_exempt_new_asset(fake_root, no_git) -> None:
    """④ 豁免路径在 git_restore 侧同样放行（两侧同口径，不许一边拦一边放）。"""
    out = _restore({"paths": [P_EXEMPT_NEW]})
    assert "[拒绝]" not in out, f"豁免路径被误伤：{out}"
    assert _restores(no_git) == [["restore", "--", P_EXEMPT_NEW]], f"应正常执行 restore，实际：{no_git}"


def test_B5_restore_rejects_reserved_asset(fake_root, no_git) -> None:
    """⑤ 内置保留资产被 git_restore 拒绝。"""
    out = _restore({"paths": [P_RESERVED]})
    assert "[拒绝]" in out and P_RESERVED in out, out
    assert _restores(no_git) == [], no_git


def test_B6_restore_rejects_outside_project(fake_root, no_git) -> None:
    """⑥ 项目外路径被拒，并说明原因是「超出项目范围」。"""
    out = _restore({"paths": ["../evil/x.json"]})
    assert "[拒绝]" in out and "超出项目范围" in out, out
    assert _restores(no_git) == [], no_git


def test_B7_restore_mixed_batch_is_all_or_nothing(fake_root, no_git) -> None:
    """⑦ 混合批次：一条命中即**整单拒绝**，且被拒路径与放行路径都要说清。

    刻意选择「整单拒绝」而非静默过滤掉那条：静默过滤会让调用方误以为
    全部文件都已回滚（实际那条还停在被改动的状态）⇒ 比拒绝更危险。
    """
    out = _restore({"paths": ["README.md", P_PROTECTED_DIR, "docs/x.md"]})
    assert "[拒绝]" in out
    assert P_PROTECTED_DIR in out
    assert "README.md" not in out.split("未回滚任何文件")[-1], (
        "放行路径不该出现在被拒清单里：" + out
    )
    assert _restores(no_git) == [], f"整单拒绝 ⇒ 一条 restore 都不该发，实际：{no_git}"


def test_B8_restore_empty_paths_still_rejected(fake_root, no_git) -> None:
    """⑧ 既有语义不许回归：空 paths 仍拒（且不因新前置过滤而变成放行）。"""
    out = _restore({"paths": []})
    assert "[拒绝]" in out and "paths" in out, out
    assert _restores(no_git) == [], no_git


# ══════════════════════════════════════════════════════════════════════════
# C. 「不另写一套判定」的形状守卫
# ══════════════════════════════════════════════════════════════════════════

def test_C1_git_delegates_to_single_source_of_truth() -> None:
    """⑨ tools/git.py 必须**委派**给 builtin._is_blocked_write_path。

    形状断言（非行为断言）—— 明确说明为什么退回形状：
    「有没有委派」这件事在行为上不可观测（两种写法在当前清单下输出一致），
    真正能观测的是**将来**清单变化时会不会漂移，而那要靠 A/B 两段的行为用例。
    本条只钉住委派关系存在，防止后人把判定复制一份进 git.py。
    """
    src = (Path(git_mod.__file__).resolve()).read_text(encoding="utf-8")
    assert src.count("_is_blocked_write_path") >= 2, (
        "tools/git.py 应在 _write_patch_file 与 git_restore 两处委派给 builtin 判定"
    )
    assert "from tools.builtin import _is_blocked_write_path" in src, (
        "必须复用 builtin 的唯一真相源，不许在 git.py 里另写一套"
    )


def test_C2_no_local_duplication_of_blocklist() -> None:
    """⑩ tools/git.py 里不许出现自己的黑名单常量（防止副本漂移）。

    用 AST 扫**赋值/注解**节点，而不是全文搜字符串 —— 注释里为了说明「为什么复用
    唯一真相源」必然会出现这些名字（本文上一版就因此误报）。全文搜索把注释当代码，
    是守卫自身的假红 ⇒ 修守卫而不是删注释。
    """
    import ast

    tree = ast.parse(Path(git_mod.__file__).resolve().read_text(encoding="utf-8"))
    assigned: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    assigned.add(t.id)
                elif isinstance(t, ast.Attribute):
                    assigned.add(t.attr)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            assigned.add(node.target.id)
    for bad in ("_WRITE_BLOCKED_NAMES", "_WRITE_BLOCKED_DIRS", "_WRITE_BLOCKED_SUFFIXES"):
        assert bad not in assigned, f"tools/git.py 不许自带 {bad}（副本必然与 builtin 漂移）"


def test_C3_denial_is_loud_for_every_blocked_path(fake_root, caplog) -> None:
    """⑪ 四类受保护路径**逐一**都必须出声（反静默：任何一类闷掉即失败）。

    计数自检：先跑 _assert_capture_works 证明计数机制非 0，再断言精确条数 4。
    """
    with caplog.at_level(logging.WARNING, logger="slime.git-tools"):
        _assert_capture_works(caplog, fake_root)
        before = len(_warnings(caplog))
        assert before > 0, "反静默自检：计数为 0，后续断言不可信"
        for rel in (P_SENSITIVE_JSON, P_SENSITIVE_TOML, P_PROTECTED_DIR, P_RESERVED):
            _write_patch_file(rel, ["payload"])
        warns = _warnings(caplog)
        new = warns[before:]
        assert len(new) == 4, f"4 条受保护路径应各出声 1 次（共 4 条 WARNING），实际 {len(new)}：{new}"
        for rel in (P_SENSITIVE_JSON, P_SENSITIVE_TOML, P_PROTECTED_DIR, P_RESERVED):
            assert any(rel in m for m in new), f"{rel} 的拒绝没有出声：{new}"


def test_C4_exempt_path_stays_silent_and_written(fake_root, caplog) -> None:
    """⑫ 豁免路径：放行**且不出声**（不该对合法写入刷警告）。

    ⚠️ 顺序要点：先在**干净的**窗口里断言「无 WARNING」，再跑自检。
    反过来（先自检再断言）会把自检自己造的 core/agent.py 警告算进来 ⇒ 假红。
    这正是本文件第一版栽的坑。
    """
    with caplog.at_level(logging.WARNING, logger="slime.git-tools"):
        _write_patch_file(P_EXEMPT_NEW, ["payload"])
    assert (fake_root / P_EXEMPT_NEW).is_file(), "豁免路径必须放行"
    assert _warnings(caplog) == [], "豁免路径不该产生 WARNING（误伤噪音）"
    # 「无警告」不能是因为捕获坏了 —— 自检证明它抓得到东西。
    _assert_capture_works(caplog, fake_root)


# ══════════════════════════════════════════════════════════════════════════
# D. `git_checkpoint_save` 的**采集端**（fallback patch 包）—— A-1197 续
# ══════════════════════════════════════════════════════════════════════════
#
# ## 这一段补的是哪个洞
# 还原端（A 段）已经拒收受保护路径了，但**采集端**还在无过滤地把未追踪文件的
# **全文**以 `FILE <相对路径>` 写进 `.slime/checkpoints/<id>.patch`
# ⇒ config/agents.json / slime.toml / core/agent.py 的内容白白躺在 patch 包里，
# 而且 .slime/ 自己（被 .gitignore 忽略 ⇒ 属于未追踪）会进**下一轮**的采集包，逐轮膨胀。
# 收窄是**纯收益**：这些内容还原端本来就拒收 ⇒ 功能零损失。
#
# ## 为什么 D 段必须是**端到端**断言（而不是只测过滤器函数）
# 采集链有真实的不确定性：`git status --porcelain` 的输出、`?? ` 前缀的截取、
# fallback 分支何时被走到 —— 只测 `_filter_checkpoint_untracked` 会漏掉
# 「过滤结果有没有真的接进 patch 文件」这一环（接漏了测试照样绿）。
# ⇒ D1/D2/D3 一律走**完整 git_checkpoint_save**（_run_git 打桩：status 给出
#   未追踪清单、bundle create 强制失败以落进 fallback 分支），最后**读 patch 文件内容**判定。
#
# ## 反静默自检
# D4 是双向对照：先证「过滤器把合法的挑出来了」（keep 非 0），
# 再证「该跳过的确实没进 patch」（patch 里找不到敏感内容）。单向断言会漏掉
# 「过滤器返回空 ⇒ patch 里当然什么都没有」这种假绿 —— 这正是本项目前科里
# 「计数类断言必须先自测计数不是 0」的同族。

P_LEGIT = "notes/scratch.md"          # 合法未追踪文件：不在任何黑名单里
P_BIG = "assets/big.bin"              # 超过体积阈值的文件
P_SELF_REF = ".slime/checkpoints/cp-old.patch"   # checkpoint 自身目录
SECRET = "SECRET-AGENTS-JSON-CONTENT"


def _write(root: Path, rel: str, content: str) -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return p


def _stub_git_for_save(monkeypatch: pytest.MonkeyPatch, status_text: str) -> None:
    """把 _run_git 换成桩：走完整 git_checkpoint_save，但**绝不真的动 git**。

    · `status --porcelain` → 返回给定的未追踪清单（触发采集链）
    · `bundle create` → 强制 returncode≠0 ⇒ 落进 fallback patch 分支
    · 其余命令（rev-parse / notes / diff / stash）→ 返回无害的桩
    """
    def fake_run_git(args, **kw):
        a = list(args)
        if a[:1] == ["status"]:
            return subprocess.CompletedProcess(args=["git", *a], returncode=0,
                                              stdout=status_text, stderr="")
        if a[:2] == ["rev-parse", "--is-inside-work-tree"]:
            # 必须让 _ensure_git_repo 放行，否则 git_checkpoint_save 第一行就返回
            # 「[拒绝] 非 Git 仓库」，根本走不到采集链（本轮第一次跑就栽在这里）。
            return subprocess.CompletedProcess(args=["git", *a], returncode=0,
                                              stdout="true\n", stderr="")
        if a[:1] == ["bundle"]:
            # 强制走 fallback：真实环境里 bundle create 失败（磁盘/锁/无 HEAD）也是这条
            return subprocess.CompletedProcess(args=["git", *a], returncode=1,
                                              stdout="", stderr="bundle failed（桩）")
        return subprocess.CompletedProcess(args=["git", *a], returncode=0,
                                          stdout="deadbeef" * 5, stderr="")

    monkeypatch.setattr(git_mod, "_run_git", fake_run_git)


@pytest.fixture
def cp_env(fake_root: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """把 checkpoint 落盘位置也指到 tmp —— 否则 git_checkpoint_save 会写进**真实** .slime/。

    ⚠️ CHECKPOINTS_DIR / INDEX_FILE 是**模块级常量**（导入时按 _PROJECT_ROOT 算好），
    所以只 patch `_PROJECT_ROOT` 不够 —— 必须把这两个也一起指过去，否则：
      ① 测试会污染真实 .slime/checkpoints/（留下垃圾 checkpoint 索引）；
      ② 旋转逻辑会真的删真实 checkpoint。
    """
    cp_dir = fake_root / ".slime" / "checkpoints"
    cp_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(git_mod, "CHECKPOINTS_DIR", cp_dir)
    monkeypatch.setattr(git_mod, "INDEX_FILE", cp_dir / "index.jsonl")
    return cp_dir


def _run_save(root: Path, rels: list[str], monkeypatch: pytest.MonkeyPatch) -> str:
    _stub_git_for_save(monkeypatch, "".join(f"?? {r}\n" for r in rels))
    out = asyncio.run(git_mod.git_checkpoint_save({"label": "guard-test"}))
    assert "[失败]" not in out, f"checkpoint 保存失败：{out}"
    assert "bundle=cp-" in out and ".patch" in out, (
        f"本次必须落进 fallback patch 分支，否则下面的断言测的不是采集链：{out}"
    )
    # ⚠️ 按**本次返回的 id** 定位 patch 包，不能用 glob 扫目录 —— 用例自己会在
    # .slime/checkpoints/ 里放夹具文件（P_SELF_REF 就是上一轮的 patch），
    # glob 会把夹具一起数进来 ⇒ 「恰好 1 个」恒假红（D3 第一次跑就栽在这里）。
    cp_id = out.split("id：")[1].split("\n", 1)[0].strip()
    p = root / ".slime" / "checkpoints" / f"{cp_id}.patch"
    assert p.is_file(), f"按返回的 id 找不到 patch 包：{p}"
    return p.read_text(encoding="utf-8")


def test_D1_protected_paths_never_enter_patch(fake_root, cp_env, monkeypatch) -> None:
    """① 受保护路径**不进 patch**（采集端，端到端）。

    断言的是**内容层面**（敏感串一个都不许出现在 patch 里），而不只是「没有 FILE 行」——
    后者可以被「整个文件都没写进去」蒙过去。

    ⚠️ **同一次调用里塞一个合法文件作对照**（反静默）：若采集链整体坏了（比如 patch
    根本没写成），「敏感串不在里面」会**空过**。有了对照文件「它的内容确实在包里」，
    才证明这条用例测的是**过滤**而不是**没采集**。这与本文件铁律里
    「计数类断言必须先自测计数不是 0」是同一条，这里用的是它的内容版。
    """
    _write(fake_root, P_SENSITIVE_JSON, f'{{"note": "{SECRET}"}}')
    _write(fake_root, P_SENSITIVE_TOML, f'x = "{SECRET}"')
    _write(fake_root, P_PROTECTED_DIR, f'raise SystemExit("{SECRET}")')
    _write(fake_root, P_LEGIT, "对照组内容")
    text = _run_save(fake_root, [P_SENSITIVE_JSON, P_SENSITIVE_TOML, P_PROTECTED_DIR, P_LEGIT],
                     monkeypatch)
    # 对照组必须真的进了包 ⇒ 证明采集链是通的，下面「不在包里」才有意义
    assert "对照组内容" in text, f"对照文件都没进包，本用例会空过（采集链坏了）：\n{text[:800]}"
    assert SECRET not in text, f"受保护文件的全文竟进了 patch 包：\n{text[:800]}"
    for rel in (P_SENSITIVE_JSON, P_SENSITIVE_TOML, P_PROTECTED_DIR):
        assert f"FILE {rel}" not in text, f"{rel} 不该有 FILE 块：\n{text[:800]}"


def test_D2_oversized_file_is_skipped(fake_root, cp_env, monkeypatch) -> None:
    """② 过大文件被跳过 —— 用**真实阈值**（2 MB）而不是把常量改小。

    ⚠️ 改小常量会让这条测试在「有人把阈值从 2 MB 调成 200 KB」时依然绿，
    而那正是本条要防的回归（patch 是用来回滚代码的，不该搬大二进制/构建产物）。
    代价是本用例要在 tmp 里写 2 MB —— 可接受，且 tmp_path 会被 pytest 回收。
    ⚠️ 同样带一个合法对照组（反静默）：否则「大文件不在包里」可能在**什么都没采**时空过。
    """
    big = _write(fake_root, P_BIG, "A")
    big.write_bytes(b"A" * (CHECKPOINT_UNTRACKED_MAX_BYTES + 1024))
    assert big.stat().st_size > CHECKPOINT_UNTRACKED_MAX_BYTES
    _write(fake_root, P_LEGIT, "对照组内容")
    text = _run_save(fake_root, [P_BIG, P_LEGIT], monkeypatch)
    assert "对照组内容" in text, f"对照文件都没进包，本用例会空过：\n{text[:800]}"
    assert f"FILE {P_BIG}" not in text, "超大文件竟被写进 patch 包"
    assert P_BIG in text, "跳过的文件应当在 patch 头里留痕（出声），便于事后核对"


def test_D3_slime_dir_itself_is_skipped(fake_root, cp_env, monkeypatch) -> None:
    """③ `.slime/` 自身下的内容被跳过（否则 checkpoint 自我引用、逐轮膨胀）。"""
    _write(fake_root, P_SELF_REF, "上一轮的 patch 内容")
    text = _run_save(fake_root, [P_SELF_REF], monkeypatch)
    assert f"FILE {P_SELF_REF}" not in text, (
        "checkpoint 竟把上一轮的 patch 包又采进本轮（自举膨胀）"
    )


def test_D4_legit_untracked_still_collected(fake_root, cp_env, monkeypatch) -> None:
    """④ **合法未追踪文件仍然进 patch**（最关键：收窄不能把正常能力一起收掉）。

    前置反静默：先证「过滤器确实认得出合法文件」（keep 非 0），
    再证「它的内容真的落进 patch 包」。若 keep 恒为空，本例会因「找不到内容」而红 ——
    那正是我们要的失败方向（能力被收掉了），而不是靠「空 == 空」蒙过去。
    """
    keep, skipped = _filter_checkpoint_untracked([P_LEGIT])
    assert keep == [P_LEGIT], f"合法未追踪文件被误伤：keep={keep} skipped={skipped}"
    assert skipped == [], f"合法文件不该出现在跳过列表：{skipped}"
    _write(fake_root, P_LEGIT, "# 我的草稿\nhello")
    text = _run_save(fake_root, [P_LEGIT], monkeypatch)
    assert f"FILE {P_LEGIT}" in text, f"合法未追踪文件没进 patch 包：\n{text[:800]}"
    assert "我的草稿" in text, "合法文件的**内容**必须真的写进 patch（不只是路径行）"


def test_D5_skip_is_loud_and_summarised(fake_root, caplog, monkeypatch) -> None:
    """⑤ 过滤必须**出声**，且汇总成一条（不逐条刷屏），并说清「最大的一条」。

    计数自检（铁律）：先在只有合法文件的干净窗口里断言「0 条」，
    再跑一次含跳过项的调用断言「恰好 1 条 WARNING」——
    顺序反了会把自检自己造的警告算进来（本文件 C4 栽过这个坑）。
    ⚠️ 这里**不**断言日志里有每一条被跳过的路径：任务要求「不要逐条刷屏」，
    路径太多时（一次 checkpoint 能撞上几十个未追踪文件）逐条点名反而是把噪音
    写进日志。完整清单落在 **patch 包头部**的 `# SKIPPED <path> [<原因>]` 行里
    （可事后逐条核对，见 D2/D3 断言），日志只负责「有几条 / 各类几条 / 最大的是谁」。
    """
    with caplog.at_level(logging.WARNING, logger="slime.git-tools"):
        keep, skipped = _filter_checkpoint_untracked([P_LEGIT])
        assert keep == [P_LEGIT], "前置：合法文件应被挑出来（否则本用例的 0 条不可信）"
        assert _warnings(caplog) == [], "无跳过项时不该出声（误伤噪音）"
        _write(fake_root, P_SELF_REF, "x")
        _write(fake_root, P_SENSITIVE_JSON, f'{{"k": "{SECRET}"}}')
        keep2, skipped2 = _filter_checkpoint_untracked([P_SELF_REF, P_SENSITIVE_JSON])
        assert keep2 == [], f"这两条都该被跳过，实际 keep={keep2}"
        warns = _warnings(caplog)
    assert len(warns) == 1, f"两条跳过应汇总成**一条** WARNING，实际 {len(warns)} 条：{warns}"
    msg = warns[0]
    assert "跳过 2 条" in msg, f"日志必须说清跳过了几条：{msg}"
    assert "受保护路径 1 条" in msg and "checkpoint 自身目录 1 条" in msg, f"日志必须分类计数：{msg}"
    # 最大的一条必须**点名**：它是最占体积的那条，只给「跳过了 N 条」的话，
    # 调用方无法判断自己的包被谁撑大了。
    assert "其中最大的一条 config/agents.json" in msg, f"日志必须点名被跳过里最大的一条：{msg}"


def test_D6_collection_and_restore_share_one_verdict(fake_root, cp_env, monkeypatch) -> None:
    """⑥ **两端同口径**：被采集端跳过的路径，还原端也拒收（不许一边放行一边拦）。

    这是本轮改动最需要钉住的不变量 —— 收窄若与还原端口径不一致，会出现
    「采集时采了、还原时被拒」的功能回退（表现为 checkpoint「还原不回去」），
    或者反过来「采集时跳过、还原时本来能写」的能力损失。
    ⚠️ 形状断言（`_write_patch_file` 的行为在 A 段已钉死，这里只比对**判定函数**）：
    对同一组路径，采集端的 skip 判定与还原端的 `_is_blocked_write_path` 必须同源同结果。
    """
    rels = [P_SENSITIVE_JSON, P_PROTECTED_DIR, P_LEGIT]
    _, skipped = _filter_checkpoint_untracked(rels)
    skipped_rels = {r for r, _ in skipped}
    blocked = {r for r in rels if _is_blocked_write_path(fake_root / r)}
    # ⚠️ 反空转自检（铁律）：上面两个集合的相等断言在「双双为空」时永远绿。
    #   所以先证明它们**非空**（本用例选的这两条路径确实命中黑名单），再比相等。
    assert len(blocked) == 2, f"前置：这两条路径本就该命中写入黑名单，实际 {blocked}"
    assert skipped_rels == blocked, (
        f"采集端与还原端口径不一致：采集跳过 {sorted(skipped_rels)}，"
        f"还原拒收 {sorted(blocked)}；不一致 ⇒ 要么功能回退（采了还原不了），"
        f"要么能力损失（能还原却没采）"
    )