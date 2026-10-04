# Slime Mini Web Search（core/websearch）

个人级「全网搜索引擎」：与 Google 同一架构（爬虫 → 倒排索引 → 排序检索 → 查询服务），
差异只在规模与基础设施，不在架构。纯 Python 3 标准库 + SQLite，零第三方依赖。

## 模块

| 文件 | 角色 | 对应 Google 组件 |
|---|---|---|
| `crawler.py` | BFS 爬虫：URL 去重、深度/页数上限、礼貌延迟、robots、标题/正文/链接抽取 | Googlebot |
| `indexer.py` | 分词（中文二元切分 + 英文/数字整词）→ 倒排索引 → BM25 排序（标题加权） | 索引系统 / 排序 |
| `server.py` | HTTP 查询服务（ThreadingHTTPServer，CORS 全开） | 前端查询服务 |
| `test_service.py` | 端到端自测：临时站点 → 爬取 → 索引 → 服务断言（15 项） | — |
| `gen_testsite.py` | 生成 24 页环形互联测试站点 | — |
| `seeds.txt` | 默认种子地址 | — |

## 快速开始

```bash
cd core/websearch

# 1) 爬取（从种子出发）
python3 crawler.py --db search.db --seeds-file seeds.txt \
    --max-pages 200 --max-depth 3 --delay 1.0

# 2) 建索引（含 --query 可当场试搜）
python3 indexer.py --db search.db
python3 indexer.py --db search.db --query 咖啡

# 3) 起服务（默认 127.0.0.1:8600）
python3 server.py --db search.db --port 8600
```

接口：

- `GET /search?q=关键词&page=0&size=10` → `{ok,total,took_ms,engine,items[]}`，
  `items[] = {url,title,snippet,score,source}`，`page` 为 **0 基**。
- `GET /status` → `{ok,pages,terms,db,crawling,last_crawl}`。
- `GET /health` → `{ok:true}`。
- `POST /crawl {"seed":"https://…","max_pages":100,"max_depth":3}` → 后台爬取并自动重建索引。

## 与 Slime Search 前端联动

`apps/local-search-engine/index.html`（v3.1.0+）新增「全网」模式：
页面通过 `fetch http://127.0.0.1:8600/search`（CORS 已放开）查询本服务；
首页「全网」面板会显示已收录页数/词数，也可改服务地址后点「重新连接」。

## 运行自测

```bash
python3 test_service.py   # 自建临时站点全链路断言，15 项应全过
```

## 诚实边界

这是单机个人级实现：没有分布式抓取调度、PB 级存储、链接分析（PageRank 规模）、
查询联想集群等 Google 级基础设施；但核心链路（爬取、倒排、BM25 排序、查询服务、
摘要高亮）完整可运行，可作为理解搜索引擎架构的可执行样本。
