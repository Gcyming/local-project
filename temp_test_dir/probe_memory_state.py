"""临时探针：盘点 slime 记忆存储的真实状态（只读）。"""
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEM_ROOT = ROOT / "Knowledge" / "Agent Memory"
DATA_ROOT = ROOT / "data"

print(f"记忆根目录: {MEM_ROOT}")
print(f"存在: {MEM_ROOT.exists()}")
print()

agent_dirs = sorted([d for d in MEM_ROOT.iterdir() if d.is_dir()]) if MEM_ROOT.exists() else []
print(f"agent 目录数: {len(agent_dirs)}")
print()

total_facts = 0
total_bytes = 0
cat_counter = Counter()
with_facts = 0
corrupt = []
sizes = []

for d in agent_dirs:
    mj = d / "memory.json"
    if not mj.exists():
        continue
    sz = mj.stat().st_size
    total_bytes += sz
    sizes.append((sz, d.name))
    try:
        data = json.loads(mj.read_text(encoding="utf-8"))
    except Exception as e:
        corrupt.append((d.name, str(e)[:60]))
        continue
    facts = data.get("facts", []) or []
    if facts:
        with_facts += 1
    total_facts += len(facts)
    for f in facts:
        if isinstance(f, dict):
            cat_counter[f.get("category", "?")] += 1

print(f"有 memory.json 的 agent 数: {len(sizes)}")
print(f"其中 facts 非空的: {with_facts}")
print(f"记忆条目总数: {total_facts}")
print(f"memory.json 总字节: {total_bytes:,}")
print(f"解析失败（损坏）: {len(corrupt)}")
for name, err in corrupt[:10]:
    print(f"    {name}: {err}")
print()
print("按 category 分布:")
for cat, n in cat_counter.most_common():
    print(f"    {cat:16s} {n}")
print()
print("最大的 10 个记忆文件:")
for sz, name in sorted(sizes, reverse=True)[:10]:
    print(f"    {name:20s} {sz:>8,} B")
print()

# LanceDB 索引
print("=== LanceDB 索引位置 ===")
lance_dirs = [d for d in DATA_ROOT.iterdir() if d.is_dir() and (d / "lancedb").exists()] if DATA_ROOT.exists() else []
print(f"data/*/lancedb 目录数: {len(lance_dirs)}")
for d in lance_dirs:
    files = list((d / "lancedb").rglob("*"))
    nf = sum(1 for f in files if f.is_file())
    sz = sum(f.stat().st_size for f in files if f.is_file())
    print(f"    {d.name:20s} 文件数={nf:4d} 大小={sz:,} B")

# 是否存在「维度不匹配会 drop_table」所依赖的 _EMBED_DIM 配置
toml = ROOT / "slime.toml"
if toml.exists():
    try:
        import tomllib
        cfg = tomllib.loads(toml.read_text(encoding="utf-8"))
        print()
        print("=== slime.toml 相关配置 ===")
        print(f"    memory.enabled          = {cfg.get('memory', {}).get('enabled')}")
        print(f"    memory.dir              = {cfg.get('memory', {}).get('dir')}")
        print(f"    memory.lancedb.enabled  = {cfg.get('memory', {}).get('lancedb', {}).get('enabled')}")
        print(f"    model_server.embedding.dim = {cfg.get('model_server', {}).get('embedding', {}).get('dim')}")
        emb = cfg.get('model_server', {}).get('embedding', {})
        print(f"    model_server.embedding.model_path = {emb.get('model_path')}")
    except Exception as e:
        print(f"toml 解析失败: {e}")
