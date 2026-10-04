"""临时探针：V3 方案的阈值扫描（去重阈值 / 建链阈值该定多少）。

V3 = CJK 字符 unigram + CJK 字符 bigram + 拉丁空白分词。
数据：真实语料（Knowledge/Agent Memory 的 lesson）构造的「同模板 / 不同模板」对。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEM_ROOT = ROOT / "Knowledge" / "Agent Memory"
CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+")


def v3(t):
    t = t.lower()
    s = {w for w in t.split() if w}
    for run in CJK_RUN.findall(t):
        s.update(run)
        if len(run) > 1:
            s.update(run[i:i + 2] for i in range(len(run) - 1))
    return s


def jac(a, b):
    A, B = v3(a), v3(b)
    if not A or not B:
        return 0.0
    return len(A & B) / len(A | B)


def pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    i = min(len(s) - 1, max(0, int(round(p / 100 * (len(s) - 1)))))
    return s[i]


# 收集真实 lesson
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

top = [c for c, _ in sorted(seen.items(), key=lambda kv: -kv[1])[:80]]
pos, neg = [], []
for i in range(len(top)):
    for k in range(i + 1, len(top)):
        a, b = top[i], top[k]
        na = re.sub(r"\{[^}]*\}", "{}", re.sub(r'"\w+"', '"X"', a))
        nb = re.sub(r"\{[^}]*\}", "{}", re.sub(r'"\w+"', '"X"', b))
        v = jac(a, b)
        (pos if na == nb else neg).append(v)

print(f"同模板对(应合并) = {len(pos)}   不同模板对(不应合并) = {len(neg)}")
print()
print("=== V3 相似度分布 ===")
print(f"{'':<18}{'P05':>8}{'P25':>8}{'P50':>8}{'P75':>8}{'P95':>8}{'max':>8}{'mean':>8}")
for name, arr in (("应合并(同模板)", pos), ("不应合并", neg)):
    print(f"{name:<18}{pct(arr,5):>8.3f}{pct(arr,25):>8.3f}{pct(arr,50):>8.3f}"
          f"{pct(arr,75):>8.3f}{pct(arr,95):>8.3f}{max(arr):>8.3f}{sum(arr)/len(arr):>8.3f}")

print()
print("=== 阈值扫描：把「>=阈值」判为重复 ===")
print(f"{'阈值':>6}{'命中(recall)':>14}{'误判(false pos)':>18}{'F1':>8}")
print("-" * 50)
best = None
for t100 in range(30, 96, 5):
    t = t100 / 100
    tp = sum(1 for v in pos if v >= t)
    fp = sum(1 for v in neg if v >= t)
    fn = len(pos) - tp
    rec = tp / len(pos) if pos else 0
    prec = tp / (tp + fp) if (tp + fp) else 0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0
    flag = ""
    if best is None or f1 > best[1]:
        best = (t, f1)
        flag = "  <-- 最优"
    print(f"{t:>6.2f}{rec:>14.3f}{fp:>18d}{f1:>8.3f}{flag}")

print()
print(f"去重阈值最优 = {best[0]:.2f}（F1={best[1]:.3f}）")
print()
# 建链阈值：不应合并的 P95 之上取整
p95 = pct(neg, 95)
print(f"不应合并的 P95 = {p95:.3f}  → 建链阈值取 {min(0.9, round(p95 + 0.1, 1)):.1f} 可把这 5% 的误链也排除")
print()
print("=== 参考：若去重阈值改 0.75、建链阈值改 0.50 会怎样 ===")
for t, label in ((0.75, "去重 0.75"), (0.50, "建链 0.50")):
    tp = sum(1 for v in pos if v >= t)
    fp = sum(1 for v in neg if v >= t)
    print(f"  {label}: 同模板命中 {tp}/{len(pos)}，不同模板误命中 {fp}/{len(neg)} ({fp/len(neg):.1%})")
