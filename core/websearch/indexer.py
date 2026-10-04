#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Slime Mini Web Search — 索引与检索模块（indexer.py）

按 Google 式架构的第二、三环「索引 + 排序」实现：
  - 分词：英文/数字按词，中文按二元切分（bigram），短中文词同时保留整词
  - 索引：倒排索引 terms / postings（含标题命中计数）存入 SQLite
  - 排序：BM25（k1=1.5, b=0.75），标题命中加权 ×3，多词 AND 优先、不足退 OR

仅使用 Python 标准库。该模块既可命令行建库，也被 server.py 直接 import。

用法：
  python3 indexer.py --db search.db            # 重建索引
  python3 indexer.py --db search.db -q 咖啡     # 建库后立刻试搜
"""
import argparse
import math
import re
import sqlite3
import time

BM25_K1 = 1.5
BM25_B = 0.75
TITLE_BOOST = 3.0

INDEX_SCHEMA = '''
CREATE TABLE IF NOT EXISTS terms(term TEXT PRIMARY KEY, df INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS postings(
  term TEXT NOT NULL, doc_id INTEGER NOT NULL,
  tf INTEGER NOT NULL, title_tf INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(term, doc_id));
CREATE INDEX IF NOT EXISTS idx_postings_doc ON postings(doc_id);
'''

TOKEN_RE = re.compile(r'[a-z0-9]+|[㐀-䶿一-鿿豈-﫿]+')


def tokenize(text):
    """英文按词；中文按二元切分，长度<=4 的中文串额外保留整词。"""
    out = []
    for m in TOKEN_RE.finditer((text or '').lower()):
        w = m.group(0)
        if ord(w[0]) < 0x2E80:
            out.append(w)
        else:
            if len(w) == 1:
                out.append(w)
            else:
                out.extend(w[i:i + 2] for i in range(len(w) - 1))
                if len(w) <= 4:
                    out.append(w)
    return out


def query_terms(query):
    """查询侧分词：去重保持顺序。"""
    seen = set()
    out = []
    for t in tokenize(query):
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def build_index(db_path):
    conn = sqlite3.connect(db_path)
    conn.executescript(INDEX_SCHEMA)
    conn.execute('DELETE FROM terms')
    conn.execute('DELETE FROM postings')
    pages = conn.execute('SELECT id, title, text FROM pages').fetchall()
    tf_agg = {}
    title_tf_agg = {}
    lengths = {}
    for doc_id, title, text in pages:
        title_tokens = tokenize(title)
        body_tokens = tokenize(text)
        lengths[doc_id] = len(body_tokens) + len(title_tokens)
        tf = {}
        for t in body_tokens:
            tf[t] = tf.get(t, 0) + 1
        tf_agg[doc_id] = tf
        ttf = {}
        for t in title_tokens:
            ttf[t] = ttf.get(t, 0) + 1
        title_tf_agg[doc_id] = ttf

    df = {}
    for tf in tf_agg.values():
        for t in tf:
            df[t] = df.get(t, 0) + 1
    for t in list(title_tf_agg.values()):
        pass
    rows_post = []
    for doc_id, tf in tf_agg.items():
        ttf = title_tf_agg.get(doc_id, {})
        for t, c in tf.items():
            rows_post.append((t, doc_id, c, ttf.get(t, 0)))
        for t, c in ttf.items():
            if t not in tf:
                rows_post.append((t, doc_id, 0, c))
    df_all = {}
    for (t, _d, _tf, _ttf) in rows_post:
        df_all[t] = None
    for doc_id, tf in tf_agg.items():
        for t in set(tf) | set(title_tf_agg.get(doc_id, {})):
            df_all[t] = None
    df_count = {}
    for doc_id in tf_agg:
        for t in set(tf_agg[doc_id]) | set(title_tf_agg.get(doc_id, {})):
            df_count[t] = df_count.get(t, 0) + 1

    conn.executemany('INSERT OR REPLACE INTO terms(term, df) VALUES(?,?)',
                     [(t, c) for t, c in df_count.items()])
    conn.executemany('INSERT OR REPLACE INTO postings(term, doc_id, tf, title_tf) VALUES(?,?,?,?)',
                     rows_post)
    avdl = (sum(lengths.values()) / len(lengths)) if lengths else 1.0
    conn.execute('INSERT OR REPLACE INTO meta(k, v) VALUES(?,?)', ('avdl', repr(avdl)))
    conn.execute('INSERT OR REPLACE INTO meta(k, v) VALUES(?,?)', ('doc_count', repr(len(lengths))))
    conn.execute('INSERT OR REPLACE INTO meta(k, v) VALUES(?,?)', ('indexed_at', repr(time.time())))
    conn.commit()
    n_terms = conn.execute('SELECT COUNT(*) FROM terms').fetchone()[0]
    conn.close()
    return {'docs': len(lengths), 'terms': n_terms, 'avdl': round(avdl, 1)}


class Searcher:
    """检索器：BM25 排序 + 摘要生成。供 server.py 复用。"""

    def __init__(self, db_path):
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        row = self.conn.execute("SELECT v FROM meta WHERE k='avdl'").fetchone()
        self.avdl = float(row[0]) if row else 1.0
        row = self.conn.execute("SELECT v FROM meta WHERE k='doc_count'").fetchone()
        self.n_docs = int(float(row[0])) if row else 0

    def close(self):
        self.conn.close()

    def search(self, query, page=0, size=10):
        t0 = time.perf_counter()
        terms = query_terms(query)
        if not terms or self.n_docs == 0:
            return {'total': 0, 'took_ms': 0.0, 'items': [], 'terms': terms}

        scores = {}
        hit_terms = {}
        for t in terms:
            row = self.conn.execute('SELECT df FROM terms WHERE term=?', (t,)).fetchone()
            if not row:
                continue
            df = row[0]
            idf = math.log(1.0 + (self.n_docs - df + 0.5) / (df + 0.5))
            for prow in self.conn.execute(
                    'SELECT doc_id, tf, title_tf FROM postings WHERE term=?', (t,)):
                doc_id = prow[0]
                body_tf = prow[1]
                eff_tf = body_tf + TITLE_BOOST * prow[2]
                if eff_tf <= 0:
                    continue
                denom = eff_tf + BM25_K1 * (1.0 - BM25_B + BM25_B * 1.0)
                # 文档长度归一化需要 doc 长度；用 avdl 常数近似时分母如下，
                # 精确做法在下方二次修正。
                scores[doc_id] = scores.get(doc_id, 0.0) + idf * (eff_tf * (BM25_K1 + 1.0)) / denom
                hit_terms.setdefault(doc_id, set()).add(t)

        # 精确 BM25：按真实文档长度二次修正（仅对候选文档）
        if scores:
            ids = ','.join(str(i) for i in scores.keys())
            for row in self.conn.execute('SELECT id, text, title FROM pages WHERE id IN (%s)' % ids):
                doc_len = len(tokenize(row[1])) + len(tokenize(row[2])) or 1
                # 重新计算该文档得分（精确长度）
                s = 0.0
                for t in hit_terms[row[0]]:
                    dfr = self.conn.execute('SELECT df FROM terms WHERE term=?', (t,)).fetchone()
                    if not dfr:
                        continue
                    idf = math.log(1.0 + (self.n_docs - dfr[0] + 0.5) / (dfr[0] + 0.5))
                    pr = self.conn.execute(
                        'SELECT tf, title_tf FROM postings WHERE term=? AND doc_id=?',
                        (t, row[0])).fetchone()
                    if not pr:
                        continue
                    eff_tf = pr[0] + TITLE_BOOST * pr[1]
                    denom = eff_tf + BM25_K1 * (1.0 - BM25_B + BM25_B * doc_len / (self.avdl or 1.0))
                    s += idf * (eff_tf * (BM25_K1 + 1.0)) / denom
                scores[row[0]] = s

        # AND 优先：命中全部词的排前面；不足一页时用部分命中补足
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        full = [kv for kv in ranked if len(hit_terms.get(kv[0], ())) == len(terms)]
        ordered = full if len(full) >= 1 else ranked
        if full and len(full) < page * size + size:
            ordered = full + [kv for kv in ranked if kv not in full]

        total = len(ordered)
        start = page * size
        items = []
        for doc_id, score in ordered[start:start + size]:
            row = self.conn.execute('SELECT url, title, text FROM pages WHERE id=?', (doc_id,)).fetchone()
            if not row:
                continue
            items.append({
                'url': row[0],
                'title': row[1] or row[0],
                'snippet': make_snippet(row[2], terms),
                'score': round(score, 3),
                'source': '自建索引',
            })
        took = (time.perf_counter() - t0) * 1000.0
        return {'total': total, 'took_ms': round(took, 1), 'items': items, 'terms': terms}

    def stats(self):
        pages = self.conn.execute('SELECT COUNT(*) FROM pages').fetchone()[0]
        terms = self.conn.execute('SELECT COUNT(*) FROM terms').fetchone()[0]
        return {'pages': pages, 'terms': terms}


def make_snippet(text, terms, width=90):
    """以首个命中词为中心截取摘要，前端负责高亮。"""
    if not text:
        return ''
    low = text.lower()
    idx = -1
    for t in terms:
        i = low.find(t.lower())
        if i >= 0 and (idx < 0 or i < idx):
            idx = i
    if idx < 0:
        return text[:width * 2]
    start = max(0, idx - width // 2)
    end = min(len(text), idx + width * 3 // 2)
    prefix = '…' if start > 0 else ''
    suffix = '…' if end < len(text) else ''
    return prefix + text[start:end] + suffix


def main(argv=None):
    ap = argparse.ArgumentParser(description='Slime Mini Web Search 索引器')
    ap.add_argument('--db', default='search.db')
    ap.add_argument('-q', '--query', help='建库后试搜')
    args = ap.parse_args(argv)
    t0 = time.time()
    st = build_index(args.db)
    print('索引完成: %d 页, %d 词, 平均文档长度 %s, 用时 %.1fs'
          % (st['docs'], st['terms'], st['avdl'], time.time() - t0))
    if args.query:
        s = Searcher(args.db)
        r = s.search(args.query)
        print('试搜「%s」: %d 条, %.1f ms' % (args.query, r['total'], r['took_ms']))
        for it in r['items'][:5]:
            print('  - %s\n    %s\n    %s' % (it['title'], it['url'], it['snippet'][:80]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
