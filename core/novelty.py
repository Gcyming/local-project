"""
slime novelty 信号检测（Intelligence 11.2.4.6）
- bigrams：字符级 bigram 分词（纯函数，中英文通吃）
- is_short_confirmation：短消息守卫（业务规则）
"""


def bigrams(text: str) -> set:
    """字符级 bigram 分词（中英文通吃）。纯函数：len < 2 返回空集合。
    中文无空格，空格分词会让整句成为集合中的单一元素，导致 Jaccard 恒为 0 → 每条中文消息都被误判新主题。"""
    t = text.lower()
    if len(t) < 2:
        return set()
    return {t[i:i + 2] for i in range(len(t) - 1)}


def is_short_confirmation(message: str) -> bool:
    """短消息守卫：空/单字/双字确认语（strip 后 < 3 字符）不构成主题判断信息量。
    "好/嗯/是/好的/收到/继续/谢谢" 等高频短确认语返回 True（应判非新主题）。"""
    return len(message.strip()) < 3
