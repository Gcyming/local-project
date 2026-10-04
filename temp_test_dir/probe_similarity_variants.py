"""临时探针：为中文相似度选实现方案 + 定阈值（用真实语料评测）。

对比多种 token 化方案的 Jaccard 判别力：
  V0 现状（空白分词）
  V1 CJK 字符 unigram + 拉丁词
  V2 CJK 字符 bigram + 拉丁词
  V3 CJK unigram + bigram + 拉丁词
  V4 CJK unigram + bigram + 拉丁词 + 拉丁字符 bigram

用两组数据评测：
  A. 人工标注对（同义改写 / 无关 / 相同）
  B. 真实语料对（从 Knowledge/Agent Memory 采样的 lesson，按「应否合并」人工判据构造）
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEM_ROOT = ROOT / "Knowledge" / "Agent Memory"

CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+")


def v0(t):
    return {w for w in t.lower().split() if w}


def v1(t):
    t = t.lower()
    s = {w for w in t.split() if w}
    for run in CJK_RUN.findall(t):
        s.update(run)
    return s


def v2(t):
    t = t.lower()
    s = {w for w in t.split() if w}
    for run in CJK_RUN.findall(t):
        if len(run) == 1:
            s.add(run)
        else:
            s.update(run[i:i + 2] for i in range(len(run) - 1))
    return s


def v3(t):
    return v1(t) | v2(t)


def v4(t):
    s = v3(t)
    for w in t.lower().split():
        if len(w) > 1 and not CJK_RUN.search(w):
            s.update(w[i:i + 2] for i in range(len(w) - 1))
    return s


VARIANTS = [("V0 现状", v0), ("V1 CJK单字", v1), ("V2 CJK双字", v2), ("V3 单+双", v3), ("V4 +拉丁双字", v4)]


def jac(fn, a, b):
    A, B = fn(a), fn(b)
    if not A or not B:
        return 0.0
    return len(A & B) / len(A | B)


# ── A. 人工标注对：(期望, 说明, a, b) ──
PAIRS = [
    ("同义改写", "中文同义改写", "用户喜欢用 Python 写脚本", "用户偏好使用 Python 编程"),
    ("同义改写", "中文同义改写2", "Agent 的记忆系统坏掉了", "智能体的记忆模块出现故障"),
    ("无关", "中文语义无关", "用户喜欢用 Python 写脚本", "今天北京天气晴朗适合出门"),
    ("无关", "中文完全无关", "数据库连接池配置", "红烧肉的做法步骤详解"),
    ("相同", "完全相同", "用户喜欢用 Python 写脚本", "用户喜欢用 Python 写脚本"),
    ("边界", "仅多标点", "用户喜欢用 Python 写脚本", "用户喜欢用 Python 写脚本。"),
    ("同义改写", "英文同义", "user prefers python scripting", "user likes python scripting"),
    ("无关", "英文无关", "user prefers python scripting", "the weather is nice today"),
]

print("=" * 92)
print("A. 人工标注对")
print("=" * 92)
hdr = f"{'类型':<8}{'说明':<18}" + "".join(f"{n:>13}" for n, _ in VARIANTS)
print(hdr)
print("-" * 92)
for kind, desc, a, b in PAIRS:
    row = f"{kind:<8}{desc:<18}" + "".join(f"{jac(f, a, b):>13.4f}" for _, f in VARIANTS)
    print(row)

# ── B. 真实语料 ──
print()
print("=" * 92)
print("B. 真实语料（从 Knowledge/Agent Memory 采样 lesson）")
print("=" * 92)

seen = {}
for d in MEM_ROOT.iterdir():
    if not d.is_dir():
        continue
    mj = d / "memory.json"
    if not mj.exists():
        continue
    try:
        data = json.loads(mj.read_text(encoding="utf-8"))
    except Exception:
        continue
    for f in data.get("facts", []) or []:
        if isinstance(f, dict) and f.get("category") == "lesson":
            c = f.get("content", "")
            if c:
                seen[c] = seen.get(c, 0) + 1

print(f"真实 lesson 去重后不同内容数: {len(seen)}")
print(f"真实 lesson 总条数: {sum(seen.values())}")
print()
print("出现次数最高的 12 条：")
for c, n in sorted(seen.items(), key=lambda kv: -kv[1])[:12]:
    print(f"  x{n:<4d} {c[:80]}")

# 真实语料里的「应合并 / 不应合并」对
real_pairs = []
top = [c for c, _ in sorted(seen.items(), key=lambda kv: -kv[1])[:60]]
for i in range(len(top)):
    for k in range(i + 1, len(top)):
        a, b = top[i], top[k]
        ja = re.sub(r'"\w+"', '"X"', a)
        jb = re.sub(r'"\w+"', '"X"', b)
        ja = re.sub(r"\{[^}]*\}", "{}", ja)
        jb = re.sub(r"\{[^}]*\}", "{}", jb)
        same_template = ja == jb
        real_pairs.append((same_template, a, b))

real_pairs = real_pairs[:400]
should = [p for p in real_pairs if p[0]]
shouldnt = [p for p in real_pairs if not p[0]]
print()
print(f"真实对：应合并(同模板)={len(should)}  不应合并={len(shouldnt)}")
print()
print(f"{'方案':<14}{'应合并-均值':>14}{'不应合并-均值':>16}{'判别间隔':>12}")
print("-" * 92)
for name, fn in VARIANTS:
    m1 = sum(jac(fn, a, b) for _, a, b in should) / max(1, len(should))
    m0 = sum(jac(fn, a, b) for _, a, b in shouldnt) / max(1, len(shouldnt))
    print(f"{name:<14}{m1:>14.4f}{m0:>16.4f}{m1 - m0:>12.4f}")
