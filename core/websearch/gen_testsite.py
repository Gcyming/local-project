

"""生成一个 24 页的互联测试站点，用于端到端验证爬虫→索引→服务。"""
import os
import pathlib

OUT = pathlib.Path('/mnt/work/testsite')
OUT.mkdir(parents=True, exist_ok=True)

TOPICS = [
    ('index', '首页 · 迷你世界导航', '欢迎来到迷你世界，这里汇集了咖啡、编程、旅行、天文、美食等主题的精彩页面。'),
    ('coffee', '咖啡冲泡指南', '手冲咖啡的关键是粉水比一比十五，水温九十二度，先闷蒸三十秒再分段注水。咖啡的香气来自烘焙。'),
    ('espresso', '意式浓缩入门', '意式浓缩咖啡用九巴压力萃取，二十五秒出杯，表面有一层金黄油脂 crema。'),
    ('python', 'Python 编程速查', 'Python 是解释型语言，列表推导式、字典、生成器让代码简洁。Python 在数据科学领域广泛应用。'),
    ('algorithm', '数据结构与算法', '数组随机访问快，链表插入删除快，哈希表查找接近常数时间。排序算法有快排、归并、堆排序。'),
    ('travel', '旅行收纳技巧', '旅行打包要列清单，衣物卷起来省空间，证件和电子设备单独收纳。提前规划行程更轻松。'),
    ('beijing', '北京旅行攻略', '北京有故宫、长城、天坛等名胜。秋天的北京气候宜人，是旅行的好季节。'),
    ('shanghai', '上海旅行指南', '上海外滩夜景迷人，城隍庙小吃众多。上海是国际化大都市，东西方文化交融。'),
    ('astronomy', '宇宙与星空', '银河是包含太阳系的棒旋星系，直径约十万光年。夜空的星光是许多年前发出的。'),
    ('telescope', '望远镜选购', '天文望远镜分折射、反射、折反三类。入门推荐口径八十毫米的折射望远镜。'),
    ('recipe', '家常菜谱大全', '番茄炒蛋、红烧肉、清蒸鱼是经典家常菜。菜谱讲究火候与调味的平衡。'),
    ('baking', '烘焙入门', '烘焙要注意面粉筋度与发酵温度。戚风蛋糕的关键是蛋白打发到位。'),
    ('music', '音乐欣赏指南', '古典音乐有巴赫、莫扎特、贝多芬。欣赏音乐要用心感受旋律与和声。'),
    ('guitar', '吉他学习路径', '吉他入门先练爬格子与和弦转换。坚持练习是进步的关键。'),
    ('health', '健康睡眠建议', '规律作息比补觉重要，睡前一小时远离屏幕，卧室保持黑暗凉爽。健康从睡眠开始。'),
    ('exercise', '科学运动指南', '运动前要热身，运动后要拉伸。有氧运动与力量训练结合效果最佳。健康需要坚持运动。'),
    ('photography', '摄影构图技巧', '摄影构图有三分法、对称、引导线。光线是摄影的灵魂，黄金时刻出好片。'),
    ('reading', '读书笔记方法', '高效读书笔记先记核心观点，再写思考疑问，最后一句话总结。阅读改变思维。'),
    ('history', '世界历史概览', '历史长河波澜壮阔，古埃及、古希腊、古罗马文明璀璨。读史使人明智。'),
    ('science', '科学探索精神', '科学靠观察、假设、实验、验证。科学精神是怀疑与求证的统一。'),
    ('finance', '个人理财基础', '理财要量入为出，建立应急基金，分散投资降低风险。理财是长期规划。'),
    ('garden', '家庭园艺入门', '园艺让人亲近自然。种花要选好土壤与光照，浇水见干见湿。园艺是生活情趣。'),
    ('pet', '宠物饲养常识', '养宠物要有责任心，定期打疫苗，科学喂养。宠物是家庭的一员。'),
    ('movie', '电影推荐清单', '好电影引人深思。经典电影值得反复品味，科幻、剧情、纪录片各有魅力。'),
]

def link(name, label):
    return '<a href="%s.html">%s</a>' % (name, label)

pages = {}
for name, title, body in TOPICS:
    
    names = [n for n, _, _ in TOPICS]
    titles = {n: t for n, t, _ in TOPICS}
    i = names.index(name)
    nxt = [names[(i + k) % len(names)] for k in range(1, 5)]
    nav = ' | '.join([link('index', '首页')] + [link(r, titles[r]) for r in nxt])
    html = '''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>%s</title></head>
<body>
<nav>%s</nav>
<h1>%s</h1>
<p>%s</p>
<p>%s</p>
<footer>迷你世界 · %s</footer>
</body></html>''' % (title, nav, title, body, body, name)
    pages[name] = html

for name, html in pages.items():
    (OUT / (name + '.html')).write_text(html, encoding='utf-8')
print('generated %d pages in %s' % (len(pages), OUT))
