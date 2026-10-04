#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端自测：临时站点 + 爬取 + 索引 + server.py 路由查询，全在前台子进程完成。"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import crawler  # noqa: E402
import indexer  # noqa: E402
import server  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  [PASS] ' if cond else '  [FAIL] ') + name + ((' | ' + extra) if extra else ''))


def wait_port(port, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def get(url):
    with urllib.request.urlopen(url, timeout=8) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    tmp = tempfile.mkdtemp(prefix='slime_e2e_')
    site = os.path.join(tmp, 'site')
    db = os.path.join(tmp, 'search.db')
    os.makedirs(site)

    # ── 1. 生成测试站点（环形互联 24 页）──
    sys.path.insert(0, HERE)
    import gen_testsite
    pages = gen_testsite.TOPICS
    names = [n for n, _, _ in pages]
    titles = {n: t for n, t, _ in pages}
    for i, (name, title, body) in enumerate(pages):
        nxt = [names[(i + k) % len(names)] for k in range(1, 5)]
        nav = ' | '.join(['<a href="index.html">首页</a>'] +
                         ['<a href="%s.html">%s</a>' % (r, titles[r]) for r in nxt])
        html = ('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
                '<title>%s</title></head><body><nav>%s</nav><h1>%s</h1>'
                '<p>%s</p><p>%s</p><footer>迷你世界 · %s</footer></body></html>'
                % (title, nav, title, body, body, name))
        with open(os.path.join(site, name + '.html'), 'w', encoding='utf-8') as f:
            f.write(html)
    print('1. 测试站点: %d 页' % len(pages))

    # ── 2. 起临时静态站点 ──
    import http.server
    import functools
    static_srv = http.server.ThreadingHTTPServer(
        ('127.0.0.1', 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=site))
    static_port = static_srv.server_address[1]
    threading.Thread(target=static_srv.serve_forever, daemon=True).start()
    print('2. 静态站点: http://127.0.0.1:%d' % static_port)

    # ── 3. 爬取 ──
    stats = crawler.crawl(['http://127.0.0.1:%d/index.html' % static_port], db,
                          max_pages=60, max_depth=6, delay=0.05, respect_robots=False)
    print('3. 爬取: %(fetched)d 页入库' % stats)
    check('爬取覆盖全部 24 页', stats['fetched'] == 24, 'fetched=%d' % stats['fetched'])

    # ── 4. 建索引 ──
    istats = indexer.build_index(db)
    print('4. 索引: %(docs)d 页 / %(terms)d 词' % istats)
    check('索引文档数=24', istats['docs'] == 24)
    check('索引词条>500', istats['terms'] > 500, 'terms=%d' % istats['terms'])

    # ── 5. 起搜索服务（线程内）──
    server.DB_PATH = db
    srv = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
    sport = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print('5. 搜索服务: http://127.0.0.1:%d' % sport)

    base = 'http://127.0.0.1:%d' % sport

    # /health
    d = get(base + '/health')
    check('/health ok', d.get('ok') is True)

    # /status
    d = get(base + '/status')
    check('/status pages=24', d.get('pages') == 24, str(d))
    check('/status terms>500', d.get('terms', 0) > 500)

    # /search 中文
    d = get(base + '/search?q=' + urllib.parse.quote('咖啡'))
    check('搜索「咖啡」有结果', d.get('total', 0) >= 1, 'total=%s' % d.get('total'))
    top = d['items'][0] if d.get('items') else {}
    check('「咖啡」Top1 命中咖啡页', 'coffee' in top.get('url', '') or 'espresso' in top.get('url', ''),
          top.get('url', ''))
    check('结果带 snippet', bool(top.get('snippet')))
    check('结果带 source=自建索引', top.get('source') == '自建索引')

    # /search 英文
    d = get(base + '/search?q=python')
    check('搜索「python」Top1=python页', d.get('items') and 'python' in d['items'][0]['url'],
          d['items'][0]['url'] if d.get('items') else 'none')

    # /search 跨页词
    d = get(base + '/search?q=' + urllib.parse.quote('旅行'))
    check('搜索「旅行」≥3 页', d.get('total', 0) >= 3, 'total=%s' % d.get('total'))

    # /search 分页
    d = get(base + '/search?q=' + urllib.parse.quote('世界') + '&size=5&page=1')
    check('分页 size=5&page=1 返回≤5 条', 0 <= len(d.get('items', [])) <= 5,
          'got %d' % len(d.get('items', [])))

    # /search 无结果
    d = get(base + '/search?q=' + urllib.parse.quote('量子引力波'))
    check('无结果查询 total=0', d.get('total', -1) == 0)

    # 缺参数
    d = get(base + '/search')
    check('缺 q 参数返回 ok=False', d.get('ok') is False)

    # ── 汇总 ──
    static_srv.shutdown()
    srv.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    print('\n══ 结果: %d 通过 / %d 失败 ══' % (len(PASS), len(FAIL)))
    if FAIL:
        print('失败项:', FAIL)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
