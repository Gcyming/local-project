#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Slime Mini Web Search — 爬虫模块（crawler.py）

按 Google 式架构的第一环「抓取」实现，个人级规模：
  种子 URL 广度优先爬取 → 遵守 robots.txt → 同主机礼貌延迟 →
  提取标题与可见正文 → 存入 SQLite（pages 表），供 indexer.py 建索引。

仅使用 Python 标准库，无第三方依赖。

用法：
  python3 crawler.py --db search.db --seed https://example.org/ \
      --max-pages 200 --max-depth 3 --delay 1.0
  python3 crawler.py --db search.db --seeds-file seeds.txt --max-pages 500

注意：请只抓取你有权抓取的站点，遵守目标站 robots.txt 与使用条款。
"""
import argparse
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
import urllib.robotparser
from collections import deque
from html.parser import HTMLParser

USER_AGENT = 'SlimeMiniBot/1.0 (+https://slime.local; personal search engine)'
MAX_BODY_BYTES = 1_500_000  # 单页最多读取 1.5MB
SKIP_EXT = re.compile(
    r'\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|mjs|map|json|xml|pdf|zip|gz|tar|'
    r'mp3|mp4|avi|mov|wmv|woff2?|ttf|eot|exe|dmg|iso|7z|rar)(?:[?#].*)?$', re.I)

SCHEMA = '''
CREATE TABLE IF NOT EXISTS pages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  title TEXT DEFAULT '',
  text TEXT DEFAULT '',
  fetched_at REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
'''


class PageParser(HTMLParser):
    """提取 <title>、可见正文（跳过 script/style 等）与站内链接。"""

    SKIP_TAGS = {'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas'}

    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title_parts = []
        self.text_parts = []
        self.links = []
        self._in_title = False
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'title':
            self._in_title = True
        elif tag in self.SKIP_TAGS:
            self._skip_depth += 1
        elif tag == 'a':
            for k, v in attrs:
                if k == 'href' and v:
                    u = normalize_url(urllib.parse.urljoin(self.base_url, v))
                    if u:
                        self.links.append(u)
        if tag in ('p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'section', 'article'):
            self.text_parts.append(' ')

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False
        elif tag in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title_parts.append(data)
        elif self._skip_depth == 0:
            self.text_parts.append(data)

    @property
    def title(self):
        return clean_text(''.join(self.title_parts))[:300]

    @property
    def text(self):
        return clean_text(''.join(self.text_parts))


def clean_text(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def normalize_url(url):
    """规范化：仅保留 http/https，去 fragment，小写 scheme/host，去尾斜杠。"""
    try:
        p = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    if p.scheme not in ('http', 'https'):
        return None
    host = (p.hostname or '').lower()
    if not host:
        return None
    port = ':%d' % p.port if p.port else ''
    path = p.path or '/'
    if path != '/' and path.endswith('/'):
        path = path[:-1]
    out = 'https' if p.scheme == 'https' else 'http'
    out += '://' + host + port + path
    if p.query:
        out += '?' + p.query
    return out


def host_of(url):
    try:
        return urllib.parse.urlsplit(url).netloc.lower()
    except ValueError:
        return ''


class RobotsCache:
    """按主机缓存 robots.txt，遵守 Disallow 规则。"""

    def __init__(self, enabled=True):
        self.enabled = enabled
        self._cache = {}

    def allowed(self, url):
        if not self.enabled:
            return True
        p = urllib.parse.urlsplit(url)
        base = '%s://%s' % (p.scheme, p.netloc)
        rp = self._cache.get(base)
        if rp is None:
            rp = urllib.robotparser.RobotFileParser()
            rp.set_url(base + '/robots.txt')
            try:
                rp.read()
            except Exception:
                rp = None  # 取不到 robots → 宽松放行
            self._cache[base] = rp
        if rp is None:
            return True
        try:
            return rp.can_fetch(USER_AGENT, url)
        except Exception:
            return True


def open_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    return conn


def save_page(conn, url, title, text):
    conn.execute(
        'INSERT OR REPLACE INTO pages(url, title, text, fetched_at) VALUES(?,?,?,?)',
        (url, title, text, time.time()))


def fetch(url, timeout):
    req = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        ctype = resp.headers.get('Content-Type', '')
        if resp.status != 200:
            return None, 'http %d' % resp.status
        if ctype and ('text/html' not in ctype) and ('application/xhtml' not in ctype):
            return None, 'skip content-type: %s' % ctype
        raw = resp.read(MAX_BODY_BYTES)
    enc = 'utf-8'
    m = re.search(r'charset=([\w\-]+)', ctype or '', re.I)
    if m:
        enc = m.group(1)
    else:
        head = raw[:2000].decode('ascii', 'ignore')
        m2 = re.search(r'charset=["\']?([\w\-]+)', head, re.I)
        if m2:
            enc = m2.group(1)
    try:
        return raw.decode(enc, 'replace'), None
    except (LookupError, UnicodeDecodeError):
        return raw.decode('utf-8', 'replace'), None


def crawl(seeds, db_path, max_pages=200, max_depth=3, delay=1.0,
          timeout=10.0, stay_domains=None, respect_robots=True, progress=None):
    """BFS 爬取主循环。stay_domains 为空 → 跟随所有主机；否则只在给定域名内。"""
    conn = open_db(db_path)
    robots = RobotsCache(enabled=respect_robots)
    frontier = deque()
    seen = set()
    for s in seeds:
        u = normalize_url(s)
        if u and u not in seen:
            seen.add(u)
            frontier.append((u, 0))
    allowed_hosts = {host_of(d) for d in stay_domains} if stay_domains else None

    fetched = 0
    skipped_robots = 0
    last_hit = {}  # host -> last fetch ts（同主机限速）
    t0 = time.time()

    while frontier and fetched < max_pages:
        url, depth = frontier.popleft()
        if SKIP_EXT.search(url):
            continue
        h = host_of(url)
        if allowed_hosts and h not in allowed_hosts:
            continue
        if not robots.allowed(url):
            skipped_robots += 1
            if progress:
                progress('robots 拒绝: %s' % url)
            continue
        # 同主机礼貌延迟
        now = time.time()
        wait = delay - (now - last_hit.get(h, 0))
        if wait > 0:
            time.sleep(wait)
        try:
            html, err = fetch(url, timeout)
        except Exception as e:  # 网络/超时等
            html, err = None, str(e)
        last_hit[h] = time.time()
        if err or html is None:
            if progress:
                progress('跳过(%s): %s' % (err or 'empty', url))
            continue

        parser = PageParser(url)
        try:
            parser.feed(html)
        except Exception:
            pass
        text = parser.text
        if len(text) < 20:
            continue  # 空页/纯脚本页
        save_page(conn, url, parser.title, text)
        fetched += 1
        if fetched % 10 == 0:
            conn.commit()
        if progress:
            progress('[%d/%d] d%d %s (%d 字)' % (fetched, max_pages, depth, url, len(text)))

        if depth < max_depth:
            for link in parser.links:
                if link not in seen:
                    lh = host_of(link)
                    if allowed_hosts and lh not in allowed_hosts:
                        continue
                    seen.add(link)
                    frontier.append((link, depth + 1))

    conn.commit()
    total = conn.execute('SELECT COUNT(*) FROM pages').fetchone()[0]
    conn.close()
    return {
        'fetched': fetched, 'skipped_robots': skipped_robots,
        'queue_left': len(frontier), 'db_pages': total,
        'seconds': round(time.time() - t0, 1),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description='Slime Mini Web Search 爬虫')
    ap.add_argument('--db', default='search.db', help='SQLite 数据库路径')
    ap.add_argument('--seed', action='append', default=[], help='种子 URL（可多次）')
    ap.add_argument('--seeds-file', help='种子文件，一行一个 URL')
    ap.add_argument('--max-pages', type=int, default=200)
    ap.add_argument('--max-depth', type=int, default=3)
    ap.add_argument('--delay', type=float, default=1.0, help='同主机请求间隔秒数')
    ap.add_argument('--timeout', type=float, default=10.0)
    ap.add_argument('--stay', action='append', default=[],
                    help='限制在这些域名内爬取（可多次，默认不限）')
    ap.add_argument('--ignore-robots', action='store_true', help='不检查 robots.txt（不推荐）')
    args = ap.parse_args(argv)

    seeds = list(args.seed)
    if args.seeds_file:
        with open(args.seeds_file, encoding='utf-8') as f:
            seeds += [ln.strip() for ln in f if ln.strip() and not ln.startswith('#')]
    if not seeds:
        ap.error('至少需要一个 --seed 或 --seeds-file')

    print('种子: %d 个 | 上限: %d 页 | 深度: %d | 延迟: %.1fs | robots: %s'
          % (len(seeds), args.max_pages, args.max_depth, args.delay,
             'off' if args.ignore_robots else 'on'))
    stats = crawl(
        seeds, args.db,
        max_pages=args.max_pages, max_depth=args.max_depth,
        delay=args.delay, timeout=args.timeout,
        stay_domains=args.stay or None,
        respect_robots=not args.ignore_robots,
        progress=lambda m: print('  ' + m))
    print('完成: 抓取 %(fetched)d 页, robots 跳过 %(skipped_robots)d, 队列剩余 %(queue_left)d, '
          '库内共 %(db_pages)d 页, 用时 %(seconds)ss' % stats)
    return 0


if __name__ == '__main__':
    sys.exit(main())
