"""临时探针：量化 core/memory.py 降级嵌入与中文相似度的缺陷。

只读探针：只调用无副作用的纯函数（_hash_embed / _text_similarity），
不触碰任何记忆文件、不连接 LanceDB、不启动模型服务。
用完即删。
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.memory import _hash_embed, _text_similarity, _EMBED_DIM  # noqa: E402

PAD = 32 / 256.0  # _hash_embed 的补位值：ord(' ') % 256 / 256 = 0.125


def cos(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def real_dims(v: list) -> int:
    """真实承载文本信息的维度数（排除补位值 0.125）"""
    return sum(1 for x in v if abs(x - PAD) > 1e-9)


print(f"_EMBED_DIM = {_EMBED_DIM}")
print()

PAIRS = [
    ("中文-语义相近", "用户喜欢用 Python 写脚本", "用户偏好使用 Python 编程"),
    ("中文-语义无关", "用户喜欢用 Python 写脚本", "今天北京天气晴朗适合出门"),
    ("中文-完全无关", "数据库连接池配置", "红烧肉的做法步骤详解"),
    ("英文-语义相近", "user prefers python scripting", "user likes python scripting"),
    ("英文-语义无关", "user prefers python scripting", "the weather is nice today"),
]

print("=== 1. _hash_embed 余弦相似度（降级路径实际返回的东西）===")
for label, a, b in PAIRS:
    print(f"  {label:16s} cos={cos(_hash_embed(a), _hash_embed(b)):.4f}")

print()
print("=== 2. _text_similarity Jaccard（当前去重/建链/排序用的）===")
for label, a, b in PAIRS:
    print(f"  {label:16s} jac={_text_similarity(a, b):.4f}")

print()
print("=== 3. 中文阈值可达性（去重 0.75 / 建链 0.3）===")
s = "用户喜欢用 Python 写脚本"
for label, other in [("完全相同", s), ("多一个句号", s + "。"), ("同义改写", "用户偏好使用 Python 编程")]:
    j = _text_similarity(s, other)
    hit_dedup = "触发去重" if j > 0.75 else "不触发"
    hit_link = "触发建链" if j > 0.3 else "不触发"
    print(f"  {label:12s} jac={j:.4f}  {hit_dedup} / {hit_link}")

print()
print("=== 4. 补位值污染：短文本是否被 0.125 补位淹没 ===")
for t in ["你好", "红烧肉", "量子力学", "数据库连接池配置"]:
    v = _hash_embed(t)
    print(f"  {t!r:12s} 真实维度={real_dims(v):4d} / {len(v)}  补位占比={1 - real_dims(v)/len(v):.1%}")

print()
print("=== 5. 1024 字符截断：超出部分是否完全不可见 ===")
prefix = "A" * 1000
t1 = prefix + "结尾完全不同的一号内容" * 20
t2 = prefix + "结尾完全不同的二号内容" * 20
print(f"  共享前 1000 字符、后半完全不同的两段长文本：cos={cos(_hash_embed(t1), _hash_embed(t2)):.6f}")
print(f"  t1 长度={len(t1)}  t2 长度={len(t2)}  _EMBED_DIM={_EMBED_DIM}")
print(f"  → 长度超过 {_EMBED_DIM} 字符后，多出来的内容对向量零影响")

print()
print("=== 6. 无关短文本互相之间的相似度（对比：真实嵌入应在 0.3~0.6）===")
shorts = ["你好", "红烧肉", "量子力学", "股票行情", "天气预报"]
vals = []
for i in range(len(shorts)):
    for k in range(i + 1, len(shorts)):
        vals.append(cos(_hash_embed(shorts[i]), _hash_embed(shorts[k])))
print(f"  两两 cos：{', '.join(f'{v:.4f}' for v in vals)}")
print(f"  最小={min(vals):.4f}  最大={max(vals):.4f}  均值={sum(vals)/len(vals):.4f}")
