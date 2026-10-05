"""
A-988 回归：路径中的**点号目录**（`.pytest_basetemp` / `.venv` / `.github` / `.config` / `.claude` …）

背景（用户实测，双向失效）：
  · 漏报：`_PATH_RE` 第一/第三分支用**惰性**量词收尾到"已知扩展名"，于是停在目录名里的
    第一个像扩展名的点号上 —— `D:\\pilot project\\.pytest_basetemp\\sub\\x.mp4`
    被截成 `D:\\pilot project\\.py`；`.config` → `.conf`、`.pyproject` → `.py` 同理。
    截断产物在盘上不存在，本该报出的**编造路径**接着又被 `_looks_like_truncated_fragment`
    当成"截断碎片"静默跳过（`.py` 是仓库根 `.pytest_basetemp` / `.pytest_cache` 的前缀），
    护栏返回 [] —— 幻觉照过。
  · 误报：同一截断让**真实文件**的路径也变成不存在的 `.py` 碎片，一旦拆掉碎片兜底，
    真实文件反被判为"文件不存在"。
  两侧必须一起修：`_PATH_RE` 加"扩展名后必须紧跟终止符"约束 + 碎片兜底拒绝裸扩展名。

覆盖方式：每个点号目录都取**两个方向** —— 编造路径必须整条报出、真实文件不得被误判。
"""
import os
import re
import shutil
from pathlib import Path

import core.claims as claims_mod
from core.claims import find_unverified_claims

_PROJECT_ROOT = claims_mod._PROJECT_ROOT
_BS = chr(92)  


_DOT_DIR_CASES = (
    ".pytest_basetemp",
    ".pytest_cache",
    ".venv",
    ".github",
    ".config",
    ".claude",
    ".mypy_cache",
    ".pyproject.toml",  
    ".gitignore",       
    ".eslintrc.json",   
    ".prettierrc.yaml", 
)


def _norm(p) -> str:
    """按被测代码的方式归一化（`audit_claims` 会对候选做 `resolve()`）。"""
    return os.path.normcase(str(Path(p).resolve()))


class TestDotDirectoryPathFamily:
    """含点号目录的路径族：编造要报出、真实不得误判（A-988）。"""

    def test_dotdir_cases_are_actually_exercised(self, tmp_path):
        """自检：本族用例本身要能真的走到"路径解析"这一步 —— 否则用例是空转的。

        （若用例在解析阶段就被跳过，两个方向都会"通过"，缺陷会再次潜伏。）"""
        import core.claims as c
        for dot in _DOT_DIR_CASES:
            root_dot = _PROJECT_ROOT / dot
            parent = tmp_path / dot
            text = f"已保存到 {parent}{_BS}probe_never_xyz.mp4"
            hits = [m.group(1) for m in c._PATH_RE.finditer(text)]
            assert hits, f"{dot}: 路径未被解析出来，用例空转"
            audit = c.audit_claims(text)
            assert not audit.skipped, f"{dot}: 候选被跳过（{audit.skipped}），用例空转"
            assert len(audit.issues) == 1, f"{dot}: 期望恰好 1 条指控，实得 {audit.issues}"

    def test_fabricated_path_in_dot_directory_reported(self, tmp_path):
        """方向一（漏报修复）：点号目录里的**不存在**路径必须被完整报出。"""
        for dot in _DOT_DIR_CASES:
            (tmp_path / dot).mkdir(parents=True, exist_ok=True)
            fake = tmp_path / dot / "sub" / "fabricated_never_xyz.mp4"
            claims = find_unverified_claims(f"视频已保存到 {fake}，文件大小 1000 字节")
            got = [_norm(c) for c in claims]
            assert got == [_norm(fake)], f"{dot}: 编造路径未被完整报出 -> {claims}"

    def test_real_file_in_dot_directory_not_false_positive(self, tmp_path):
        """方向二（误报修复）：点号目录里的**真实文件**不得被判为"文件不存在"。"""
        for dot in _DOT_DIR_CASES:
            real_dir = tmp_path / dot / "sub"
            real_dir.mkdir(parents=True, exist_ok=True)
            real = real_dir / "real_report.md"
            real.write_text("x" * 200, encoding="utf-8")
            assert real.is_file()
            claims = find_unverified_claims(f"报告已保存到 {real}")
            assert claims == [], f"{dot}: 真实文件被误判 -> {claims}"

    def test_path_re_does_not_cut_candidate_at_dot_directory(self, tmp_path):
        """根因回归（锁正则取值行为）：候选必须整条取出，不得停在目录名里的点号上。

        先断言"路径确实被解析出来"，再断言没有落在 `.py` / `.pyc` 这类**裸扩展名**上 ——
        否则解析失败会以"没有错误候选"的形式伪装成通过。"""
        from core.claims import _PATH_RE
        for dot in _DOT_DIR_CASES:
            (tmp_path / dot).mkdir(parents=True, exist_ok=True)
            target = tmp_path / dot / "sub" / "x.mp4"
            text = f"已保存到 {target}（共 3 个文件）"
            hits = [m.group(1) for m in _PATH_RE.finditer(text)]
            assert _norm(target) in [_norm(h) for h in hits], f"{dot}: 整条未被取出 -> {hits}"
            assert not any(re.search(r"\.(?:py|pyi|png|md|json|toml|cfg)$", h, re.I) for h in hits), \
                f"{dot}: 命中被截断在裸扩展名上 -> {hits}"


class TestRepoRootDotPrefixFamily:
    """仓库根上的点号前缀条目 —— 正是 14 条既有测试失败的真实场景。"""

    def test_fabricated_path_under_repo_dot_prefixed_dir_reported(self):
        """`D:\\pilot project\\.pytest_basetemp\\…`（`--basetemp=.pytest_basetemp` 的
        tmp_path 形态）：编造路径必须被报出，而不是被截成 `D:\\pilot project\\.py` 后跳过。

        必须在**仓库根**上测：截断只在"点号前缀目录位于被测路径的靠前位置"时才改变结论
        （tmp_path 自身就含 `.pytest_basetemp`，会把前缀问题掩盖掉）。"""
        d = _PROJECT_ROOT / ".pytest_claims_dotdir_probe"
        try:
            (d / "sub_never").mkdir(parents=True, exist_ok=True)
            fake = d / "sub_never" / "fabricated_never_xyz.mp4"
            assert not fake.exists()
            claims = find_unverified_claims(f"视频已保存到 {fake}，文件大小 1000 字节")
            assert claims == [str(fake)], claims
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_real_file_under_repo_dot_prefixed_dir_not_false_positive(self):
        """同一形态下**真实文件**不得被误判（误报方向）—— 先构造正则必然命中的形态，
        再验证存在性核验没有把它判成"不存在"。"""
        d = _PROJECT_ROOT / ".pytest_claims_dotdir_probe"
        try:
            real_dir = d / "real_sub"
            real_dir.mkdir(parents=True, exist_ok=True)
            real = real_dir / "real_report.md"
            real.write_text("x" * 200, encoding="utf-8")
            assert real.is_file()
            assert find_unverified_claims(f"报告已保存到 {real}") == []
        finally:
            shutil.rmtree(d, ignore_errors=True)


class TestTruncatedFragmentGuardTightened:
    """`_looks_like_truncated_fragment` 收紧：碎片不能是**裸扩展名**（A-988）。"""

    def test_bare_extension_fragment_not_suspected(self, tmp_path):
        """裸扩展名不是"被截断的路径段"，不得据此放行 —— 否则仓库根只要存在
        `.pytest_basetemp` / `.pytest_cache`，`.py` 就必然命中前缀匹配，
        护栏对"仓库根下的 .py"彻底失效。"""
        from core.claims import _looks_like_truncated_fragment
        for frag in (".py", ".pyi", ".png", ".mp4", ".md", ".json", ".toml", ".cfg", ".db", ".yml"):
            assert _looks_like_truncated_fragment(tmp_path / frag) is False, frag

    def test_real_directory_prefix_still_suspected(self, tmp_path):
        """收紧后**真正的**截断兜底仍须有效：`…\\pilot` 仍是真实目录 `pilot project` 的前缀
        → 判为解析噪声（这条是 A-987 的精度基石，不能被收紧误伤）。"""
        from core.claims import _looks_like_truncated_fragment
        (tmp_path / "pilot project").mkdir()
        assert _looks_like_truncated_fragment(tmp_path / "pilot") is True
        assert _looks_like_truncated_fragment(tmp_path / "pilot_zzz_absent") is False
        assert find_unverified_claims(f"已保存到 {tmp_path / 'pilot'}") == []

    def test_repo_root_bare_ext_fragment_now_flagged(self):
        """端到端：仓库根下的编造 `.py` 路径必须报出（修复前这里恒为 []）。"""
        pytest_cache = _PROJECT_ROOT / ".pytest_cache"
        if not pytest_cache.is_dir():
            return  
        fake = _PROJECT_ROOT / ".py"
        assert not fake.exists()
        assert find_unverified_claims(f"已保存到 {fake}") == [str(fake)]

    def test_relative_dot_prefixed_path_is_parsed(self):
        """同一族的**相对路径**形态：第三分支的起始字符类原先只有 `[\\w\\u4e00-\\u9fff]`，
        以 `.` 开头的相对路径（`.pytest_basetemp/sub/x.mp4`）根本进不了核验 ——
        两个方向同时漏（编造不报、真实也不核），是同一个"点号目录"病灶的另一半。"""
        from core.claims import _PATH_RE
        text = "已保存到 .pytest_basetemp/sub/fabricated_never_xyz.mp4"
        assert [m.group(1) for m in _PATH_RE.finditer(text)] == \
            [".pytest_basetemp/sub/fabricated_never_xyz.mp4"]
        assert find_unverified_claims(text) == ["pytest_basetemp/sub/fabricated_never_xyz.mp4"]
