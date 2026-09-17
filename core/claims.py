"""
slime 幻觉护栏核心（A-047）
- 从 slime_cli 抽取的"文件声称核验"纯函数，供 CLI（警告级）与 Merger（硬信号级）共用
- 检测回复中"已保存/已生成/已写入…"类完成态声称引用的本地路径，核验其真实存在性
- 不存在的路径 → 返回给调用方处理（CLI 红字警告 / Merger 记入错误）
"""

import re
from pathlib import Path

# A-047: 相对路径/裸文件名统一锚定项目根核验（与 tools/builtin.py A-036 一致），
# 避免多进程/服务模式下 Worker 写文件根目录与核验方 cwd 不一致导致真实文件误报缺失
_PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 完成态声称动词：出现任一即触发全回复路径核验
_CLAIM_VERBS = ("已保存", "保存到", "已生成", "已创建", "已写入", "已下载", "已导出")

# A-048-R6（用户实测漏检）：模型用"文件大小 1,034,594 字节 + 完整路径"表格形式声称
# 完成态（规避"已保存/已生成"动词）→ 出现这些证据性描述同样触发路径核验
_EVIDENCE_HINTS = ("字节", "kb", "mb", "文件大小", "完整路径", "时长")

# URL 段（http/https 起始）：不是本地路径，核验前剔除（防盘符分支误抓/误报）
_URL_RE = re.compile(r'https?://[^\s"\'<>，。、]+', re.IGNORECASE)

# A-050-R（用户实测护栏误报）：模型把 URL 中的域名/品牌词改写为"slime 平台"后，
# URL 含空格被 _URL_RE 截断，残余片段（如"平台-ai.cn/videos/…"）被 _PATH_RE 当相对路径
# 核验 → 误报"文件不存在"。域名样式片段（<name>.<tld>/…）判定为 URL 残片，跳过核验。
_DOMAIN_FRAGMENT_RE = re.compile(
    r'^[a-z0-9\u4e00-\u9fff-]+\.(?:cn|com|net|org|io|space|ai|top|xyz|cc|me)(?:[/\\]|$)',
    re.IGNORECASE,
)

# 路径提取正则：
# - Windows 盘符绝对路径（C:\... / C:/...）
# - 常见扩展名裸文件名/相对路径（.png/.jpg/.md/.py 等，含 / 与 \ 目录分隔）
# 前置字符含反引号（markdown 代码包裹的路径，A-048-R6：模型常用 `D:\...` 形式）
_PATH_RE = re.compile(
    r'(?<=[\s"\'`：：（(])'
    r'([A-Za-z]:[\\/][^\s"\'`<>\uFF08\uFF09)\u3002，。]+'
    r'|[\w\u4e00-\u9fff][\w\u4e00-\u9fff .\\/\-]*\.(?:png|jpe?g|webp|gif|mp4|md|txt|json|yaml|csv|py|log))',
    re.IGNORECASE,
)


def find_unverified_claims(reply: str) -> list[str]:
    """找出回复中"声称已保存/生成"但实际不存在的本地路径（纯函数，可测）。

    只要出现声称动词，全回复所有引用路径都做存在性核验（A-046：声称动词与
    路径可能相距很远，表格排版也能拦截）。URL 段剔除、相对路径按项目根解析。"""
    if not reply:
        return []
    # A-048-R6: 触发条件 = 声称动词 OR 证据性描述（文件大小/字节/完整路径/时长）
    # ——模型会规避"已保存"类动词，改用"文件大小 1,034,594 字节 + 完整路径"表格声称
    lower = reply.lower()
    has_claim_verb = any(v in reply for v in _CLAIM_VERBS)
    has_evidence = any(h in lower for h in _EVIDENCE_HINTS)
    if not has_claim_verb and not has_evidence:
        return []
    # 剔除 URL 段（https://… 不是本地路径；盘符分支会把 "s://…" 误当路径）
    cleaned = _URL_RE.sub(" ", reply)
    claims = []
    for m in _PATH_RE.finditer(cleaned):
        p = m.group(1).strip()
        # A-050-R: 域名样式片段（模型改写 URL 的残片，如"平台-ai.cn/videos/…"）
        # 不是本地路径，跳过核验（此前被当相对路径 → 误报"文件不存在"）
        if _DOMAIN_FRAGMENT_RE.match(p):
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
            continue
        if not raw.exists():
            # A-050-R2（用户实测误报）：模型只转述裸文件名（如"1786793001_4cdfec6f.mp4"），
            # 文件真实存在于 data/generated/{images,videos}/ 子目录——项目根核验误报。
            # 无路径分隔符的裸文件名先查媒体产出目录，存在则不算未核实声称。
            if "/" not in p and "\\" not in p and _exists_in_generated(p):
                continue
            claims.append(p)
        else:
            # A-087（漏洞清单 P1-3）：路径存在但声称的字节数与真实值严重不符
            # （如"文件大小 1,034,594 字节"指向真实文件但实际 2,920,440）→ 假数值拦截
            size_issue = _check_size_claim(reply, p, raw)
            if size_issue:
                claims.append(size_issue)
    return claims


def _check_size_claim(reply: str, path: str, raw: Path) -> str | None:
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
        return f"{path}（声称 {best[0]} 字节，实际 {real} 字节，数值不实）"
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
