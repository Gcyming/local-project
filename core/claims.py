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
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

# A-047: 相对路径/裸文件名统一锚定项目根核验（与 tools/builtin.py A-036 一致），
# 避免多进程/服务模式下 Worker 写文件根目录与核验方 cwd 不一致导致真实文件误报缺失
_PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 完成态声称动词：出现任一即触发全回复路径核验
_CLAIM_VERBS = ("已保存", "保存到", "已生成", "已创建", "已写入", "已下载", "已导出")

# A-048-R6（用户实测漏检）：模型用"文件大小 1,034,594 字节 + 完整路径"表格形式声称
# 完成态（规避"已保存/已生成"动词）→ 出现这些证据性描述同样触发路径核验
_EVIDENCE_PHRASES = ("文件大小", "完整路径", "时长")

# 兼容既有导入点（slime_server.py 等按此名导入）：保留原常量名与内容。
# ⚠️ 触发判定**不再**直接用这个元组 —— 见 _SIZE_CLAIM_HIT_RE。
_EVIDENCE_HINTS = ("字节", "kb", "mb", "文件大小", "完整路径", "时长")

# A-987（精度修复）：把 `字节/kb/mb` 当**裸子串**匹配会误触发 —— 英文 "number"/"remember"
# 里就含 "mb"、`kb` 也能出现在无关标识符里。一段跟文件毫无关系的英文说明会让整段文本
# 进入路径核验，把误报面凭空放大。证据性描述的正确形态是"**数字 + 单位**"，用词边界锚定。
_SIZE_CLAIM_HIT_RE = re.compile(r"\d[\d,]*\s*(?:字节|bytes?|kb|mb)\b", re.IGNORECASE)

# URL 段（http/https 起始）：不是本地路径，核验前剔除（防盘符分支误抓/误报）
_URL_RE = re.compile(r'https?://[^\s"\'<>，。、]+', re.IGNORECASE)

# A-050-R（用户实测护栏误报）：模型把 URL 中的域名/品牌词改写为"slime 平台"后，
# URL 含空格被 _URL_RE 截断，残余片段（如"平台-ai.cn/videos/…"）被 _PATH_RE 当相对路径
# 核验 → 误报"文件不存在"。域名样式片段（<name>.<tld>/…）判定为 URL 残片，跳过核验。
_DOMAIN_FRAGMENT_RE = re.compile(
    r'^[a-z0-9\u4e00-\u9fff-]+\.(?:cn|com|net|org|io|space|ai|top|xyz|cc|me)(?:[/\\]|$)',
    re.IGNORECASE,
)

# 围栏代码块（``` 或 ~~~）。见 _IGNORE_FENCED_BLOCKS 注释。
_FENCED_BLOCK_RE = re.compile(r"```.*?```|~~~.*?~~~", re.DOTALL)

# 是否跳过围栏代码块内的路径核验（默认 True）。
# 依据①：厂商共识里的"验证"针对的是**对工作结果的声称**；围栏块里绝大多数是**示例代码**
#        （`C:\Users\demo\output.png` 这类模板路径），核验它们纯属制造假阳性。
# 依据②：行内反引号（`` `D:\…` ``）**不在此列** —— A-048-R6 记录的真实事故恰恰是
#        模型在表格里用行内反引号声称产出，那种情形必须继续拦。
# 需要恢复旧行为时把这一个开关置 False 即可（唯一改动点）。
_IGNORE_FENCED_BLOCKS = True

# 已知扩展名：既是"这是个文件"的判据，也是**天然的终止符**。
# 有了它才能做到"既允许路径含空格、又不把后面整句中文吞进来"（见 _PATH_RE ①）。
_KNOWN_EXT = (
    "png|jpe?g|webp|gif|bmp|ico|svg|"
    "mp4|mov|mkv|avi|webm|mp3|wav|m4a|"
    "md|markdown|txt|rtf|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|"
    "csv|tsv|xlsx?|docx?|pptx?|pdf|"
    "py|pyi|ts|tsx|js|jsx|mjs|cjs|html?|css|scss|less|sh|bash|ps1|bat|cmd|"
    "log|zip|tar|gz|7z|rar|npz|npy|pkl|db|sqlite|woff2?|ttf|otf|lock"
)

# 路径提取正则（单一捕获组，调用方按 group(1) / m[1] 取值）
# - ① Windows 盘符绝对路径，**允许空格**，惰性收尾到第一个已知扩展名
# - ② Windows 盘符绝对路径，不含空格（兼容无扩展名的目录/自定义文件名）
# - ③ 常见扩展名的裸文件名 / 相对路径，允许空格，同样惰性收尾
# 前置字符含反引号（markdown 代码包裹的路径，A-048-R6：模型常用 `D:\...` 形式）
#
# A-987 根因（用户实测假指控）：旧版 ① 写成 `[^\s"\'`<>\uFF08\uFF09)\u3002，。]+`，
# **把空格排除在外** —— 而项目自己就在 `D:\pilot project\`，于是
# `D:\pilot project\data\real_claim_probe.png` 被截断成 `D:\pilot`（以及相对分支再吐出
# 一个碎片 `project\data\real_claim_probe.png`），**每一个真实文件都被报成"幻觉"**，
# 而 Merger 把这条当硬信号直接写进 errors。
# 现在改为"惰性收尾到第一个已知扩展名"：扩展名是天然的终止符，既容得下空格，
# 又不会跨句吞并（`a.png 和 b.png` 必须切成两条，而不是拼成一条不存在的路径）。
_PATH_RE = re.compile(
    r'(?<=[\s"\'`：：（(])'
    r'('
    r'[A-Za-z]:[\\/][^\n"\'`<>|]*?\.(?:' + _KNOWN_EXT + r')'
    r'|[A-Za-z]:[\\/][^\s"\'`<>\uFF08\uFF09)\u3002，；、|]+'
    r'|[\w\u4e00-\u9fff][\w\u4e00-\u9fff .\\/\-]*?\.(?:' + _KNOWN_EXT + r')'
    r')',
    re.IGNORECASE,
)

# 候选路径尾部要剥掉的分隔/句读：Windows 文件名本就不允许以 `.` 或空格结尾，
# 也不允许含 `:` `/` `\` `?` `*` `"` `<` `>` `|`，所以剥离它们是**无损**的。
_TRAILING_JUNK = " \t.,;:!?、，；：。！？)]}）】"

# 绝对路径开头（①/② 两条分支的产物）：用于把"散文碎片"过滤限定在相对分支上
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
    kind: str  # "missing"（声称存在的文件不存在）| "size_mismatch"（数值不实）
    severity: str  # "high"（可直接作为硬信号）| "medium"（仅建议提示）
    detail: str
    # 同目录下最接近的真实文件名（"是不是想写 X？"）—— 把指控变成可自我纠正的反馈
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

    text = reply
    if _IGNORE_FENCED_BLOCKS:
        text, n_fenced = _FENCED_BLOCK_RE.subn(" ", text)
        if n_fenced:
            audit.skipped["fenced_block"] = n_fenced

    # A-048-R6: 触发条件 = 声称动词 OR 证据性描述（数字+字节/KB/MB、文件大小/完整路径/时长）
    # ——模型会规避"已保存"类动词，改用"文件大小 1,034,594 字节 + 完整路径"表格声称
    has_claim_verb = any(v in text for v in _CLAIM_VERBS)
    has_evidence = any(h in text for h in _EVIDENCE_PHRASES) or bool(_SIZE_CLAIM_HIT_RE.search(text))
    if not has_claim_verb and not has_evidence:
        return audit

    # 剔除 URL 段（https://… 不是本地路径；盘符分支会把 "s://…" 误当路径）
    cleaned, n_url = _URL_RE.subn(" ", text)
    if n_url:
        audit.skipped["url"] = n_url

    seen: set[str] = set()
    for m in _PATH_RE.finditer(cleaned):
        p = m.group(1).strip(_TRAILING_JUNK)
        if not p:
            continue
        # A-050-R: 域名样式片段（模型改写 URL 的残片，如"平台-ai.cn/videos/…"）
        # 不是本地路径，跳过核验（此前被当相对路径 → 误报"文件不存在"）
        if _DOMAIN_FRAGMENT_RE.match(p):
            audit.skipped["domain_fragment"] = audit.skipped.get("domain_fragment", 0) + 1
            continue
        # A-987（精度）：相对分支吞进来的散文/URL 残片（如 "3. See docs/x.md"）——
        # 报出去只会是一条看不懂的垃圾路径。绝对路径不受此判定（见函数注释）。
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
            continue  # 无法解析（如非法路径）不核验
        # A-047-SEC（security-review MEDIUM-2）：相对路径含 .. 时 resolve 后可能逃出
        # 项目根——相对路径探测范围限制在项目内；绝对路径为用户明示位置，保留核验
        if not is_abs and not raw.is_relative_to(_PROJECT_ROOT):
            audit.skipped["escape"] = audit.skipped.get("escape", 0) + 1
            continue

        found = _resolve_existing(raw)
        if found is None:
            # A-987（精度优先）：候选可能只是**被截断的解析碎片**（真实路径含空格被切开）。
            # 只要它仍是某个真实条目的前缀，就判定为解析噪声 —— 放行，绝不指控。
            if _looks_like_truncated_fragment(raw):
                audit.skipped["truncated_fragment"] = audit.skipped.get("truncated_fragment", 0) + 1
                continue
            # A-050-R2（用户实测误报）：模型只转述裸文件名（如"1786793001_4cdfec6f.mp4"），
            # 文件真实存在于 data/generated/{images,videos}/ 子目录——项目根核验误报。
            # 无路径分隔符的裸文件名先查媒体产出目录，存在则不算未核实声称。
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
            # A-087（漏洞清单 P1-3）：路径存在但声称的字节数与真实值严重不符
            # （如"文件大小 1,034,594 字节"指向真实文件但实际 2,920,440）→ 假数值拦截
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
    **对真实文件喊狼来了的代价远大于漏掉一条**。"""
    frag = ""
    cur = raw
    for _ in range(16):  # 深度上限：正常路径不会被截断 16 层
        parent = cur.parent
        if parent == cur:
            return False
        frag = cur.name
        try:
            if parent.is_dir():
                if len(frag) < 2:
                    return False
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
    if abs(best[0] - real) > max(real * 0.15, 512):  # A-088: 绝对下限 2048→512（小文件假数值漏报）
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
