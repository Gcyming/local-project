"""临时探针：追查记忆目录爆炸与 lesson 泛滥的根因（只读）。"""
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEM_ROOT = ROOT / "Knowledge" / "Agent Memory"

print("=== 1. BGE-M3 模型文件是否存在 ===")
mp = ROOT / "models" / "BGE-M3" / "bge-m3-q8_0.gguf"
print(f"    {mp}")
print(f"    存在={mp.exists()}" + (f"  大小={mp.stat().st_size:,} B" if mp.exists() else ""))
mb = ROOT / "models"
if mb.exists():
    for p in sorted(mb.rglob("*"))[:20]:
        if p.is_file():
            print(f"      {p.relative_to(ROOT)}  {p.stat().st_size:,} B")

print()
print("=== 2. agent 目录命名分布 ===")
dirs = [d for d in MEM_ROOT.iterdir() if d.is_dir()]
pref = Counter()
for d in dirs:
    n = d.name
    if n.startswith("agent_"):
        pref["agent_ 前缀"] += 1
    elif len(n) == 12 and all(c in "0123456789abcdef" for c in n):
        pref["12位hex"] += 1
    else:
        pref[f"其它({n[:12]})"] += 1
for k, v in pref.most_common(15):
    print(f"    {k:24s} {v}")

print()
print("=== 3. lesson 样本（看是否重复/模板化）===")
samples = []
for d in dirs:
    mj = d / "memory.json"
    if not mj.exists():
        continue
    try:
        data = json.loads(mj.read_text(encoding="utf-8"))
    except Exception:
        continue
    for f in data.get("facts", []) or []:
        if isinstance(f, dict) and f.get("category") == "lesson":
            samples.append(f.get("content", ""))
    if len(samples) >= 400:
        break

uniq = Counter(samples)
print(f"    采样 lesson 数: {len(samples)}")
print(f"    去重后不同内容: {len(uniq)}")
print(f"    最高频前 10:")
for c, n in uniq.most_common(10):
    print(f"      x{n:<4d} {c[:90]}")

print()
print("=== 4. 单条 lesson 的完整结构（第一条）===")
for d in dirs:
    mj = d / "memory.json"
    if not mj.exists():
        continue
    try:
        data = json.loads(mj.read_text(encoding="utf-8"))
    except Exception:
        continue
    facts = data.get("facts", []) or []
    if facts:
        print(f"    目录: {d.name}")
        print(f"    {json.dumps(facts[0], ensure_ascii=False, indent=6)[:700]}")
        break

print()
print("=== 5. 每个 agent 的记忆条数分布 ===")
counts = Counter()
for d in dirs:
    mj = d / "memory.json"
    if not mj.exists():
        continue
    try:
        data = json.loads(mj.read_text(encoding="utf-8"))
    except Exception:
        continue
    counts[len(data.get("facts", []) or [])] += 1
for k in sorted(counts)[:12]:
    print(f"    {k} 条记忆 -> {counts[k]} 个 agent")
