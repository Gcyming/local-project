"""
slime 幻觉护栏核心（A-047 抽取 / A-987 重构）
- 从 slime_cli 抽取的"文件声称核验"纯函数，供 CLI（警告级）与 Merger（硬信号级）共用
- 检测回复中"已保存/已生成/已写入…"类完成态声称引用的本地路径，核验其真实存在性
- 不存在的路径 → 交给调用方处置（CLI 红字警告 / Merger 记入错误）

设计基线（对标主流厂商 Agent 的公开做法，A-987 调研结论）：

① **先验证再声称**。Anthropic《Claude Code best practices》把"给 Agent 一个能跑起来的检查"
   列为第一原则，并点明：**没有可跑的检查时，"看起来完成了"就是唯一信号，于是用户自己
   变成了验证回路**。Claude Code 更深的根因是"成功 = 字节写进了磁盘"（编辑后验证只在
   `USER_TYPE === 'ant'` 时开启），因此内部注释记录近 1/3 的完成报告是假的。
   本护栏就是补上"对地面真值核验"这一环 —— 而且是**确定性的**，不花第二次 LLM 调用。

② **假阳性率是护栏的头号死因**。Claude Code 安全审查早期 FPR 一度高达 86%，结果用户
   直接无视告警；Anthropic 的解法是"**必须由独立 Agent 在沙箱里复现，才允许出现在报告里**"。
   同理，本模块的第一原则是 **不确定就不指控**：
     - 候选路径若**可能是被正则截断的碎片**（真实路径含空格被切开）→ 跳过，绝不报"文件不存在"；
     - 存在性核验带**大小写不敏感兜底**（Windows/macOS 文件系统本身不区分大小写）；
     - 围栏代码块内的路径不核验（那是示例代码，不是对工作结果的声称）。
   护栏宁可漏报，也不能对真实文件喊狼来了 —— 一次假警报就会让用户永久忽略它。

③ **分层证据**。把"核实为假"（missing / 假数值）与"无法核实"分开表述，调用方按级别处置
   （CLI 警告 / Merger 硬信号），而不是一律升级为错误。`audit_claims()` 给出结构化结果
   （含"同目录里最接近的真实文件"建议），照 Anthropic 的"证据要能指向 file:line"原则，
   把指控变成**可自我纠正的反馈**，而不是一句空洞的"文件不存在"。
"""

from __future__ import annotations

import difflib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path



_PROJECT_ROOT = Path(__file__).resolve().parent.parent


_CLAIM_VERBS = ("已保存", "保存到", "已生成", "已创建", "已写入", "已下载", "已导出")



_EVIDENCE_PHRASES = ("文件大小", "完整路径", "时长")



_EVIDENCE_HINTS = ("字节", "kb", "mb", "文件大小", "完整路径", "时长")




_TEST_SUBJECT_RE = re.compile(
    r"测试|用例|单测|回归|门禁|验收|"
    r"\b(?:tests?|pytest|vitest|jest|run_tests|compileall|tsc|typecheck)\b",
    re.IGNORECASE,
)


_TEST_PASS_RE = re.compile(
    r"(?<![未没不勿])通过|全绿|零失败|无失败|"
    r"\b(?:passed|passes|green|success)\b",
    re.IGNORECASE,
)


_CLAIM_COUNT_RE = re.compile(
    r"(\d[\d,]*)\s*(?:项|个|条)?\s*(passed|failed|errors?|通过|失败|错误)",
    re.IGNORECASE,
)


_EVIDENCE_SUFFIXES = (".log", ".txt", ".json", ".jsonl")


_EVIDENCE_NAME_RE = re.compile(
    r"(qa|pytest|vitest|jest|test|report|result|log|summary|output)",
    re.IGNORECASE,
)


_SUMMARY_TOKEN_RE = re.compile(
    r"(\d+)\s+(passed|failed|errors?|skipped|xfailed|通过|失败|错误)",
    re.IGNORECASE,
)


_PHASE_TOKENS = ("run_tests", "pytest", "compileall", "vitest")


_CMD_RE = re.compile(r"cmd=(.+)$")


_STAMP_RE = re.compile(r"\[开始\s+([^\]]+)\]")


_MAX_EVIDENCE_BYTES = 2 * 1024 * 1024



_SIZE_CLAIM_HIT_RE = re.compile(r"\d[\d,]*\s*(?:字节|bytes?|kb|mb)\b", re.IGNORECASE)


_URL_RE = re.compile(r'https?://[^\s"\'<>，。、]+', re.IGNORECASE)




_DOMAIN_FRAGMENT_RE = re.compile(
    r'^[a-z0-9\u4e00-\u9fff-]+\.(?:cn|com|net|org|io|space|ai|top|xyz|cc|me)(?:[/\\]|$)',
    re.IGNORECASE,
)


_FENCED_BLOCK_RE = re.compile(r"```.*?```|~~~.*?~~~", re.DOTALL)







_IGNORE_FENCED_BLOCKS = True



_KNOWN_EXT = (
    "png|jpe?g|webp|gif|bmp|ico|svg|"
    "mp4|mov|mkv|avi|webm|mp3|wav|m4a|"
    "md|markdown|txt|rtf|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|"
    "csv|tsv|xlsx?|docx?|pptx?|pdf|"
    "py|pyi|ts|tsx|js|jsx|mjs|cjs|html?|css|scss|less|sh|bash|ps1|bat|cmd|"
    "log|zip|tar|gz|7z|rar|npz|npy|pkl|db|sqlite|woff2?|ttf|otf|lock"
)














_PATH_TERMINATOR = (
    r'(?=$|[\s"\'`<>|，。、；：！？（）()\[\]【】“”‘’「」『』…]|\.(?![\w]))'
)


_PATH_RE = re.compile(
    r'(?<=[\s"\'`：：（(])'
    r'('
    r'[A-Za-z]:[\\/][^\n"\'`<>|]*?\.(?:' + _KNOWN_EXT + r')' + _PATH_TERMINATOR +
    r'|[A-Za-z]:[\\/][^\s"\'`<>\uFF08\uFF09)\u3002，；、|]+' + _PATH_TERMINATOR +
    r'|[\w\u4e00-\u9fff.][\w\u4e00-\u9fff .\\/\-]*?\.(?:' + _KNOWN_EXT + r')' + _PATH_TERMINATOR +
    r')',
    re.IGNORECASE,
)


_EXT_ONLY_RE = re.compile(r'^\.(?:' + _KNOWN_EXT + r')$', re.IGNORECASE)







_TRAILING_JUNK = " \t.,;:!?、，；：。！？)]}）】"


_ABS_HEAD_RE = re.compile(r"^[A-Za-z]:[\\/]")


def _looks_like_prose_fragment(p: str) -> bool:
    """A-987（精度）：候选里"**第一个空格出现在最后一个路径分隔符之前**"时，
    它更像被正则吞进来的散文/URL 残片，而不是一条路径。

    实例：`3. See docs/x.md`（数字句读起头的说明文字）；
    `平台-ai.cn/videos/… 平台-video-v2.0/x.mp4`（URL 被空格截断的残片）。

    为什么要拦：这类候选即便报出来，给出的是**垃圾路径**（既无法定位、也无法据以纠正），
    只会消耗护栏的可信度。宁可漏报，也不要贴一条看不懂的指控。

    ⚠️ 只对相对/裸文件名分支生效 —— 绝对路径（①/②）有自己的强终止符（已知扩展名 /
    无空格约束），`D:\\a b\\c d\\x.png` 这类合法路径不能因为含空格被误杀。
    """
    sep = max(p.rfind("/"), p.rfind("\\"))
    sp = p.find(" ")
    return sp != -1 and sep != -1 and sp < sep


@dataclass(frozen=True)
class ClaimIssue:
    """一条"未通过核验"的声称。`detail` 供人/模型直接阅读，其余字段供调用方按级别处置。"""

    path: str
    kind: str  
    severity: str  
    detail: str
    
    suggestion: str | None = None


@dataclass
class ClaimAudit:
    """核验结果 + **被跳过项计数**。

    为什么要记跳过：护栏的可信度取决于"它拦下的有多少是真警报"。把
    "因可能是解析碎片/URL 残片/围栏代码而放行"的次数记下来，事后才能回答
    "护栏是不是又在喊狼来了"，而不是只能靠猜。
    """

    issues: list[ClaimIssue] = field(default_factory=list)
    skipped: dict[str, int] = field(default_factory=dict)

    @property
    def missing(self) -> list[str]:
        return [i.path for i in self.issues if i.kind == "missing"]


def audit_claims(reply: str) -> ClaimAudit:
    """核验回复中的完成态文件声称，返回**结构化**结果（含跳过计数）。

    A-987 重构要点：把"什么算一条声称"（解析 + 触发）与"怎么处置"（级别/文案）分开，
    调用方既能沿用旧的字符串列表（`find_unverified_claims`），也能拿到 kind / suggestion
    做更细的处置。函数仍是纯函数（只读文件系统，无副作用）。"""
    audit = ClaimAudit()
    if not reply:
        return audit

    audit.issues.extend(audit_test_claims(reply).issues)

    text = reply
    if _IGNORE_FENCED_BLOCKS:
        text, n_fenced = _FENCED_BLOCK_RE.subn(" ", text)
        if n_fenced:
            audit.skipped["fenced_block"] = n_fenced

    
    
    has_claim_verb = any(v in text for v in _CLAIM_VERBS)
    has_evidence = any(h in text for h in _EVIDENCE_PHRASES) or bool(_SIZE_CLAIM_HIT_RE.search(text))
    if not has_claim_verb and not has_evidence:
        return audit

    
    cleaned, n_url = _URL_RE.subn(" ", text)
    if n_url:
        audit.skipped["url"] = n_url

    seen: set[str] = set()
    for m in _PATH_RE.finditer(cleaned):
        p = m.group(1).strip(_TRAILING_JUNK)
        if not p:
            continue
        
        
        if _DOMAIN_FRAGMENT_RE.match(p):
            audit.skipped["domain_fragment"] = audit.skipped.get("domain_fragment", 0) + 1
            continue
        
        
        if not _ABS_HEAD_RE.match(p) and _looks_like_prose_fragment(p):
            audit.skipped["prose_fragment"] = audit.skipped.get("prose_fragment", 0) + 1
            continue

        raw = Path(p)
        is_abs = raw.is_absolute()
        if not is_abs:
            raw = _PROJECT_ROOT / raw
        try:
            raw = raw.resolve()
        except OSError:
            continue  
        
        
        if not is_abs and not raw.is_relative_to(_PROJECT_ROOT):
            audit.skipped["escape"] = audit.skipped.get("escape", 0) + 1
            continue

        found = _resolve_existing(raw)
        if found is None:
            
            
            if _looks_like_truncated_fragment(raw):
                audit.skipped["truncated_fragment"] = audit.skipped.get("truncated_fragment", 0) + 1
                continue
            
            
            
            if "/" not in p and "\\" not in p and _exists_in_generated(p):
                audit.skipped["generated_dir"] = audit.skipped.get("generated_dir", 0) + 1
                continue
            if p in seen:
                continue
            seen.add(p)
            audit.issues.append(ClaimIssue(
                path=p, kind="missing", severity="high", detail=p,
                suggestion=_closest_sibling(raw),
            ))
        else:
            
            
            issue = _check_size_claim(text, p, found)
            if issue is not None and issue.detail not in seen:
                seen.add(issue.detail)
                audit.issues.append(issue)
    return audit


def find_unverified_claims(reply: str) -> list[str]:
    """找出回复中"声称已保存/生成"但实际不存在的本地路径（纯函数，可测）。

    只要出现声称动词，全回复所有引用路径都做存在性核验（A-046：声称动词与
    路径可能相距很远，表格排版也能拦截）。URL 段剔除、相对路径按项目根解析。

    A-987：这里保持**旧的字符串返回**（既有调用方 slime_cli / slime_server / merger
    都按 list[str] 用），只把 high 级别的项透出；需要 kind / suggestion 请用
    `audit_claims()`。
    """
    return [i.detail for i in audit_claims(reply).issues if i.severity == "high"]


def audit_test_claims(reply: str) -> ClaimAudit:
    """②「测试通过」类声称的**证据核验**（§6.1 三类硬校验之二）。

    本环境拿不到"刚才那次运行"的可靠真值（护栏进程与测试进程无共享状态），
    因此核验对象只能是**声称者自己引用的那份落盘输出**：引用了哪份证据，那份证据
    就必须支持这个声称。证据支持 → 静默通过；证据与声称矛盾 / 引用的证据根本不存在
    → high 硬指控；没有可核验的证据 → low，并**显式标注本环境无法自动判定**，绝不指控。

    绝不执行回复里出现的任何命令（提示注入面 + 副作用面）。
    """
    audit = ClaimAudit()
    if not reply:
        return audit

    body = _PATH_RE.sub(" ", reply)
    claim_line = _test_claim_line(body)
    if claim_line is None:
        return audit

    claim = _parse_claim_outcome(body)
    snippet = _clip(claim_line, 120)
    candidates = _evidence_paths(reply)

    any_outcome = False
    for cand in candidates:
        resolved = _resolve_evidence(cand)
        if resolved is None:
            continue
        found = _resolve_existing(resolved)
        if found is None:
            audit.issues.append(ClaimIssue(
                path=cand,
                kind="test_claim_evidence_missing",
                severity="high",
                detail=f"「{snippet}」声称测试通过，但引用的证据文件不存在：{cand}",
            ))
            continue
        outcome = _outcome_for_evidence(found, reply)
        if outcome is None:
            continue
        if _attribution_conflict(claim["subjects"], outcome.get("phase", "")):
            continue
        any_outcome = True
        issue = _contradiction_issue(claim, outcome, cand, snippet)
        if issue is not None:
            audit.issues.append(issue)

    if not any_outcome and not audit.issues:
        note = _latest_gate_note()
        audit.issues.append(ClaimIssue(
            path=candidates[0] if candidates else "",
            kind="test_claim_unverifiable",
            severity="low",
            detail=(
                f"「{snippet}」声称测试通过，但未附可核验的落盘证据"
                f"（data/qa_*.log / data/qa_report.json）；"
                f"本环境无法自动判定测试是否真的通过，只能要求提供证据{note}"
            ),
        ))
    return audit


def _resolve_existing(p: Path) -> Path | None:
    """存在性核验（**大小写不敏感兜底**），命中时返回盘上真实拼写的路径。

    为什么要兜底：Windows / macOS 的文件系统本身不区分大小写，但 `Path.exists()` 在
    大小写不一致时（模型把 `D:\\Pilot Project` 写成 `d:\\pilot project`，或路径落在
    区分大小写的网络盘/容器挂载上）会返回 False —— 直接据此报"文件不存在"就是假阳性。
    代价可控：只有直接命中失败时才逐段回退匹配。"""
    try:
        if p.exists():
            return p
    except OSError:
        return None
    try:
        anchor = p.anchor
        cur = Path(anchor) if anchor else Path()
        parts = p.parts[1:] if anchor else p.parts
        for part in parts:
            if not cur.is_dir():
                return None
            actual = next((e for e in os.listdir(cur) if e.lower() == part.lower()), None)
            if actual is None:
                return None
            cur = cur / actual
        return cur if cur.exists() else None
    except OSError:
        return None


def _looks_like_truncated_fragment(raw: Path) -> bool:
    """A-987（精度优先的核心兜底）：候选路径不存在，但它可能只是**被正则截断的碎片**。

    判据：从候选向上找到第一个存在的祖先目录；若"被截掉的那一段"仍是该目录下某个真实
    条目的**前缀**，说明真正的路径在这里被切断了（典型成因是路径含空格），判定为解析噪声。

    实例：`D:\\pilot` 不存在，但 `D:\\` 下存在 `pilot project` → `"pilot"` 是它的前缀 → 放行。
    代价：一个**恰好**是真实条目前缀的伪造路径会被放过（漏报）。这是刻意的取舍 ——
    对照 Anthropic 的结论（FPR 86% 的护栏会被用户直接无视），
    **对真实文件喊狼来了的代价远大于漏掉一条**。

    ⚠️ A-988（用户实测漏报，本兜底曾被反向利用）：`_PATH_RE` 的惰性量词一旦停在**目录名
    里的点号**上（`.pytest_basetemp` → `.py`），碎片恰好是一个**裸扩展名**，于是
    `e.startswith(".py")` 在仓库根只有 3 个字符就能命中 `.pytest_basetemp` / `.pytest_cache`
    —— 碎片校验几乎无条件放行，护栏返回 []，**编造路径被静默吞掉**。
    收紧两条：① 碎片必须是**路径段边界**上的真实名字，不能本身就是裸扩展名
    （`_EXT_ONLY_RE`，如 `.py` / `.png`）；② 长度不足 2 的碎片不构成证据（既有）。
    配合 `_PATH_RE` 的终止符约束（扩展名后必须紧跟终止符），两侧一起收紧才有意义：
    只改这里会把"误报真实文件"换成"漏报编造路径"。"""
    frag = ""
    cur = raw
    for _ in range(16):  
        parent = cur.parent
        if parent == cur:
            return False
        frag = cur.name
        if len(frag) < 2 or _EXT_ONLY_RE.match(frag):
            return False
        try:
            if parent.is_dir():
                entries = os.listdir(parent)
                return any(e != frag and e.startswith(frag) for e in entries)
        except OSError:
            return False
        cur = parent
    return False


def _closest_sibling(raw: Path) -> str | None:
    """同目录下最接近的真实文件名（"是不是想写 X？"）。"""
    try:
        parent = raw.parent
        if not parent.is_dir():
            return None
        entries = [e for e in os.listdir(parent) if e != raw.name]
        if not entries:
            return None
        hits = difflib.get_close_matches(raw.name, entries, n=1, cutoff=0.7)
        return hits[0] if hits else None
    except OSError:
        return None


def _check_size_claim(reply: str, path: str, raw: Path) -> ClaimIssue | None:
    """A-087/A-088（漏洞清单 P1-3）：声称的字节数与真实文件大小比对——假数值拦截。
    收集回复中**所有**"数字 字节/KB/MB"声明，与 st_size 最近的仍偏差 >15% 或 >2KB → 数值不实
    （多文件场景：每个文件匹配最接近的声明，而非只取第一个）。"""
    mult = {"字节": 1, "bytes": 1, "kb": 1024, "mb": 1024 * 1024}
    sizes = []
    for m in re.finditer(r"([\d,]+)\s*(字节|bytes?|KB|MB)", reply, re.IGNORECASE):
        try:
            claimed = int(m.group(1).replace(",", ""))
        except ValueError:
            continue
        sizes.append((claimed * mult.get(m.group(2).lower(), 1), m.group(0)))
    if not sizes:
        return None
    try:
        real = raw.stat().st_size
    except OSError:
        return None
    if real <= 0:
        return None
    best = min(sizes, key=lambda s: abs(s[0] - real))
    if abs(best[0] - real) > max(real * 0.15, 512):  
        detail = f"{path}（声称 {best[0]} 字节，实际 {real} 字节，数值不实）"
        return ClaimIssue(path=path, kind="size_mismatch", severity="high", detail=detail)
    return None


def _exists_in_generated(name: str) -> bool:
    """裸文件名是否存在于 data/generated/ 任一子目录（媒体工具唯一产出目录）。"""
    gen = _PROJECT_ROOT / "data" / "generated"
    if not gen.is_dir():
        return False
    try:
        for sub in gen.iterdir():
            if sub.is_dir() and (sub / name).is_file():
                return True
    except OSError:
        pass
    return False


def _clip(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def _test_claim_line(reply: str) -> str | None:
    """第一条同时含"测试对象"与"通过"断言的行（没有就是没有这类声称）。

    调用方传入的正文已剔除路径 —— 否则 `…\\tests\\test_x.py` 这种**路径**会
    冒充"测试对象"，把一句普通的话升级成一条测试通过声称。"""
    for raw in reply.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _TEST_SUBJECT_RE.search(line) and _TEST_PASS_RE.search(line):
            return line
    return None


def _parse_claim_outcome(reply: str) -> dict:
    """从**声称文本**里抽出它自己报的数字：passed / failed + 是否断言"通过" + 谈的是哪套门禁。"""
    low = reply.lower()
    out = {
        "passed": None,
        "failed": None,
        "asserts_pass": bool(_TEST_PASS_RE.search(reply)),
        "subjects": {t for t in _PHASE_TOKENS if t in low},
    }
    for m in _CLAIM_COUNT_RE.finditer(reply):
        try:
            n = int(m.group(1).replace(",", ""))
        except ValueError:
            continue
        kind = m.group(2).lower()
        if kind.startswith("pass") or kind == "通过":
            out["passed"] = n
        else:
            out["failed"] = n
    return out


def _evidence_paths(reply: str) -> list[str]:
    """回复里被当作"测试证据"引用的文件（限日志/报告类后缀 + 文件名像门禁产物）。

    为什么要限后缀与文件名：`config/auth_token.json` 这类敏感文件绝不能因为
    "模型提到了它"就被读进来解析 —— 护栏的误伤成本（喊狼来了）高于漏报成本。
    """
    out: list[str] = []
    seen: set[str] = set()
    for m in _PATH_RE.finditer(reply):
        p = m.group(1).strip(_TRAILING_JUNK)
        if not p or not p.lower().endswith(_EVIDENCE_SUFFIXES):
            continue
        if not _EVIDENCE_NAME_RE.search(p.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]):
            continue
        key = p.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def _resolve_evidence(p: str) -> Path | None:
    raw = Path(p)
    if not raw.is_absolute():
        raw = _PROJECT_ROOT / raw
    try:
        return raw.resolve()
    except OSError:
        return None


def _read_capped(path: Path) -> str | None:
    try:
        if path.stat().st_size > _MAX_EVIDENCE_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _outcome_from_text(text: str) -> dict | None:
    """取**最后一行**可解析的测试结果摘要（进度行/心跳行在前，摘要行在末尾），
    并顺手取出门禁自己写的 `cmd=` 与开始时间 —— 判断"这份证据是哪套门禁的"。"""
    line = None
    for raw in text.splitlines():
        if _SUMMARY_TOKEN_RE.search(raw):
            line = raw.strip()
    if line is None:
        return None
    passed: int | None = None
    failed = 0
    for m in _SUMMARY_TOKEN_RE.finditer(line):
        n = int(m.group(1))
        kind = m.group(2).lower()
        if kind in ("passed", "通过"):
            passed = n
        elif kind in ("failed", "error", "errors", "失败", "错误"):
            failed = n
    cmd = ""
    stamp = ""
    for raw in text.splitlines():
        if not cmd:
            m = _CMD_RE.search(raw)
            if m:
                cmd = m.group(1).strip()
        if not stamp:
            m = _STAMP_RE.search(raw)
            if m:
                stamp = m.group(1).strip()
        if cmd and stamp:
            break
    cmd_low = cmd.lower()
    return {
        "line": line,
        "passed": passed,
        "failed": failed,
        "phase": next((t for t in _PHASE_TOKENS if t in cmd_low), ""),
        "stamp": stamp,
    }


def _outcome_for_evidence(path: Path, reply: str) -> dict | None:
    """证据文件 → 最后一次运行的结果摘要（qa_report.json 按阶段取值）。"""
    text = _read_capped(path)
    if text is None:
        return None
    if path.suffix.lower() == ".json":
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if isinstance(data, dict) and isinstance(data.get("phases"), list):
            return _outcome_from_report(data, reply)
    return _outcome_from_text(text)


def _outcome_from_report(data: dict, reply: str) -> dict | None:
    phases = [p for p in data.get("phases") or [] if isinstance(p, dict)]
    low = reply.lower()
    chosen = None
    for ph in phases:
        name = str(ph.get("name") or "").lower()
        if name and name in low:
            chosen = ph
            break
    if chosen is None:
        for want in ("pytest", "run_tests"):
            chosen = next((p for p in phases if str(p.get("name")) == want), None)
            if chosen is not None:
                break
    if chosen is None:
        return None
    outcome = _outcome_from_text(str(chosen.get("tail") or ""))
    if outcome is not None:
        outcome["phase"] = str(chosen.get("name") or "")
        outcome["stamp"] = str(data.get("generated_at") or "")
    return outcome


def _attribution_conflict(claim_subjects: set, evidence_phase: str) -> bool:
    """数字能不能归到这份证据上？归不上就不下指控（宁可漏报不可误伤）。

    典型：`run_tests 1 failed（既有缺陷）… pytest 1034 passed 全绿` —— 一条回复里
    混了两个门禁的数字，拿其中一个去比另一个就是误伤。"""
    if not claim_subjects or not evidence_phase:
        return False
    return len(claim_subjects) > 1 or evidence_phase not in claim_subjects


def _contradiction_issue(
    claim: dict, outcome: dict, cand: str, snippet: str
) -> ClaimIssue | None:
    """引用证据与声称是否矛盾。只有"证据本身否定了声称"才升级为硬指控。"""
    shown = _clip(outcome["line"], 160)
    when = outcome.get("stamp") or ""
    tail = f"「{snippet}」引用 {cand}"
    if when:
        tail += f"（该证据记录时间 {when}）"
    tail += f"，但它最后一次记录是「{shown}」"
    failed = outcome["failed"]
    if failed > 0 and claim["asserts_pass"]:
        return ClaimIssue(
            path=cand, kind="test_claim_contradicted", severity="high",
            detail=f"{tail}：与「测试通过」矛盾（证据记录了 {failed} 个失败）",
        )
    if claim["failed"] is not None and claim["failed"] != failed:
        return ClaimIssue(
            path=cand, kind="test_claim_contradicted", severity="high",
            detail=f"{tail}：失败数与声称不符（声称 {claim['failed']} failed）",
        )
    if claim["passed"] is not None and outcome["passed"] is not None \
            and claim["passed"] != outcome["passed"]:
        return ClaimIssue(
            path=cand, kind="test_claim_contradicted", severity="high",
            detail=f"{tail}：通过数与声称不符（声称 {claim['passed']} passed）",
        )
    return None


def _latest_gate_note() -> str:
    """最近一次落盘门禁的实测结果（给"无法核验"的声称附上可对照的真值）。"""
    text = _read_capped(_PROJECT_ROOT / "data" / "qa_report.json")
    if text is None:
        return ""
    try:
        data = json.loads(text)
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    parts: list[str] = []
    for ph in data.get("phases") or []:
        if not isinstance(ph, dict):
            continue
        outcome = _outcome_from_text(str(ph.get("tail") or ""))
        if outcome is None:
            continue
        parts.append(
            f"{ph.get('name')} {outcome['passed']} passed / {outcome['failed']} failed"
            f"（status={ph.get('status')}）"
        )
    if not parts:
        return ""
    return f"；最近一次落盘门禁（{data.get('generated_at')}）：" + "，".join(parts)
