

"""Slime Mini Web Search — 搜索服务（server.py）

把 crawler.py 抓取的页面 + indexer.py 建立的倒排索引，包装成一个 HTTP 搜索服务：
  GET /search?q=关键词&page=0&size=10  → {ok,total,took_ms,engine,items[]}
  GET /status                          → {ok,pages,terms,db}
  POST /crawl {"seed":"https://...","max_pages":100,"max_depth":3}  → 后台爬取并自动重建索引

CORS 全开放（Access-Control-Allow-Origin: *），Slime Search 前端（file:// 或
localhost）可以直接 fetch 调用。仅使用标准库，ThreadingHTTPServer 支持并发。

用法：
  python3 server.py --db search.db --port 8600
"""
import argparse
import json
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import crawler
import indexer

DB_PATH = 'search.db'
SEARCHER = None
CRAWL_STATE = {'running': False, 'last': None, 'log': []}
LOCK = threading.Lock()


def get_searcher():
    global SEARCHER
    if SEARCHER is None:
        SEARCHER = indexer.Searcher(DB_PATH)
    return SEARCHER


def rebuild():
    """重建索引并重载检索器。"""
    global SEARCHER
    indexer.build_index(DB_PATH)
    if SEARCHER is not None:
        try:
            SEARCHER.close()
        except Exception:
            pass
        SEARCHER = indexer.Searcher(DB_PATH)


def run_crawl_job(seed, max_pages, max_depth, delay):
    CRAWL_STATE['running'] = True
    CRAWL_STATE['log'] = []

    def log(m):
        CRAWL_STATE['log'].append(m)
        if len(CRAWL_STATE['log']) > 60:
            CRAWL_STATE['log'] = CRAWL_STATE['log'][-60:]

    try:
        stats = crawler.crawl([seed], DB_PATH, max_pages=max_pages, max_depth=max_depth,
                              delay=delay, respect_robots=True, progress=log)
        log('索引重建中…')
        istats = indexer.build_index(DB_PATH)
        with LOCK:
            rebuild()
        CRAWL_STATE['last'] = {'ok': True, 'crawl': stats, 'index': istats}
        log('完成: 抓取 %d 页, 索引 %d 词' % (stats['fetched'], istats['terms']))
    except Exception as e:  
        CRAWL_STATE['last'] = {'ok': False, 'error': str(e)}
        log('失败: %s' % e)
    finally:
        CRAWL_STATE['running'] = False


class Handler(BaseHTTPRequestHandler):
    server_version = 'SlimeMiniSearch/1.0'

    def log_message(self, *a):
        pass  

    
    def _send(self, code, obj, ctype='application/json; charset=utf-8'):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8') if isinstance(obj, (dict, list)) else obj
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            n = int(self.headers.get('Content-Length', 0))
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        raw = self.rfile.read(n).decode('utf-8', 'replace')
        try:
            return json.loads(raw)
        except ValueError:
            return {}

    
    def do_OPTIONS(self):  
        self._send(204, '')

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        qs = urllib.parse.parse_qs(u.query)
        if u.path == '/search':
            q = (qs.get('q', [''])[0] or '').strip()
            try:
                page = max(0, int(qs.get('page', ['0'])[0]))
                size = min(50, max(1, int(qs.get('size', ['10'])[0])))
            except ValueError:
                page, size = 0, 10
            if not q:
                self._send(200, {'ok': False, 'error': '缺少 q 参数', 'items': [], 'total': 0})
                return
            with LOCK:
                r = get_searcher().search(q, page=page, size=size)
            r['ok'] = True
            r['engine'] = 'Slime 自建全网索引'
            self._send(200, r)
        elif u.path == '/status':
            with LOCK:
                st = get_searcher().stats()
            st.update({'ok': True, 'db': DB_PATH, 'crawling': CRAWL_STATE['running'],
                       'last_crawl': CRAWL_STATE['last']})
            self._send(200, st)
        elif u.path == '/health':
            self._send(200, {'ok': True})
        else:
            self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path == '/crawl':
            body = self._read_json()
            seed = (body.get('seed') or '').strip()
            if not seed:
                self._send(400, {'ok': False, 'error': '缺少 seed'})
                return
            if CRAWL_STATE['running']:
                self._send(409, {'ok': False, 'error': '已有爬取任务进行中',
                                 'log': CRAWL_STATE['log'][-5:]})
                return
            try:
                max_pages = min(2000, max(1, int(body.get('max_pages', 100))))
                max_depth = min(6, max(1, int(body.get('max_depth', 3))))
                delay = max(0.3, float(body.get('delay', 1.0)))
            except (ValueError, TypeError):
                max_pages, max_depth, delay = 100, 3, 1.0
            th = threading.Thread(target=run_crawl_job,
                                  args=(seed, max_pages, max_depth, delay), daemon=True)
            th.start()
            self._send(200, {'ok': True, 'started': True, 'seed': seed,
                             'max_pages': max_pages, 'max_depth': max_depth})
        else:
            self._send(404, {'ok': False, 'error': 'not found'})


def main(argv=None):
    ap = argparse.ArgumentParser(description='Slime Mini Web Search 服务')
    ap.add_argument('--db', default='search.db')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8600)
    args = ap.parse_args(argv)

    global DB_PATH
    DB_PATH = args.db
    get_searcher()  
    st = get_searcher().stats()
    print('Slime Mini Web Search 服务已启动')
    print('  DB: %s | 已收录 %d 页 / %d 词' % (args.db, st['pages'], st['terms']))
    print('  接口: http://%s:%d/search?q=咖啡' % (args.host, args.port))
    print('  状态: http://%s:%d/status' % (args.host, args.port))
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
