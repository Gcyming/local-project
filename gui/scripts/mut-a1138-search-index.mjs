#!/usr/bin/env node
/**
 * gui/scripts/mut-a1138-search-index.mjs — A-1138（自建全网索引**写进 slime**）的变异验证。
 *
 * ## 这一组要护的是什么
 * 用户要求「把这些进程写进 slime，而非接线」⇒ 原先的 Python 三件套被 TypeScript 取代。
 * 这套东西最危险的失效方式**不是崩溃**，而是「搜出来的东西悄悄变了」：
 *   1  不去二元切分 ⇒ 中文搜不到（BM25 只对得上整词）
 *   2  长度阈值 4 改 3 ⇒ 长词进不了索引，召回面悄悄变窄
 *   3  CJK 判定阈值改错 ⇒ 中文被当英文按词切
 *   4  去掉 toLowerCase ⇒ 大小写不一致搜不到
 *   5  TITLE_BOOST 改 1 ⇒ 标题命中不再优先（排序悄悄变）
 *   6/7 BM25 的 k1/b 改掉 ⇒ 排序悄悄变（**没有任何报错**）
 *   8  idf 公式改错 ⇒ 同上
 *   9  AND 优先去掉 ⇒ 部分命中的结果混在全命中前面
 *  10  分页变 1 基 ⇒ 第一页永远空、且和页面那边的 0 基对不上
 *  11  source 文案漂 ⇒ 页面来源徽标变了（同一事实两个产地）
 *  12  没命中时摘要返回空 ⇒ 结果卡只剩标题
 *  13  terms 统计写成 pages ⇒ 状态显示"索引 N 词"是假的
 *  14  URL 归一化放过 ftp ⇒ 抓非 http 资源（协议白名单形同虚设）
 *  15  不去 fragment ⇒ 同一页面被当多页重复入库
 *  16  不去尾斜杠 ⇒ 同上（`/a` 与 `/a/` 两条）
 *  17  跳过扩展名失效 ⇒ 去抓 png/zip/pdf（浪费且入库垃圾）
 *  18  正文抽取不去 script/style ⇒ 索引里塞满代码（检索质量静默劣化）
 *  19  robots 的 Disallow 判据失效 ⇒ 抓不该抓的站点
 *  20  robots 取不到时**禁止** ⇒ 与 Python 基准相反（取不到应放行）
 *  21  不去重 ⇒ 同一页反复入队（靠 maxPages 兜底，所以**不报错**，只是白抓）
 *  22  深度上限放宽 ⇒ 抓得比用户设的更深
 *  23  CORS 头改掉 ⇒ 页面 fetch 被浏览器拦（表现为"补充命中"永远不出现）
 *  24  缺 q 返回 ok ⇒ 页面把失败当成功渲染
 *  25  缺 seed 返回 200 ⇒ 爬取命令静默不生效
 *  26  端口冲突静默 ⇒ **服务根本没起来但没人知道**（页面永远少一块）
 *  27  不写回实际端口 ⇒ 调用方拿到 0，连 `127.0.0.1:0` ⇒ EADDRNOTAVAIL
 *  28  不落盘 ⇒ 重启后索引全丢（且不报错）
 *  29  IPC 放行非主窗口 ⇒ 任何页面都能让 slime 起一个监听本机端口的服务
 *  30  默认端口不是 8600 ⇒ 与页面约定脱节（页面零改动的前提没了）
 *  31  `indexCrawl` 放行非主窗口 ⇒ 任何页面都能让 slime 去爬外网站点（同 29，另一条通道）
 *  32  一键收录不校验空网址 ⇒ 点空按钮静默开一个什么都不抓的任务
 *  33  面板失败吞掉 error ⇒ 端口被占用时用户永远不知道「为什么搜不到」（静默失效）
 *  34  主进程**接线被删**（IPC 没注册）⇒ 功能全没，而 tsc / 单测 / 构建**全绿**
 *  35  主进程**服务没被启动** ⇒ 搜索页永远拿不到「补充命中」，同样门禁全绿
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环逐条（或 `_run-mut-batch.sh`）。
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行（剥 ANSI 之后）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号 —— 一律「」（本仓已重复踩这个坑）。
 * ⚠️ 本文件必须是 **LF**（`check-mut-anchors.mjs` 按字节切锚点）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1138-search-index.spec.ts"];

const F_ENGINE = "core-ts/src/websearch/engine.ts";
const F_CRAWLER = "core-ts/src/websearch/crawler.ts";
const F_SERVICE = "gui/src/main/searchIndexService.ts";
const F_PANEL = "gui/src/renderer/pages/SearchIndexPanel.tsx";
const F_MAIN = "gui/src/main/index.ts";

const TARGETS = [F_ENGINE, F_CRAWLER, F_SERVICE, F_PANEL, F_MAIN];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1138");

const MUTATIONS = [
  /* ───── ① 切分 ───── */
  {
    name: "1 engine：中文不去二元切分（BM25 只对得上整词 ⇒ 中文搜不到）",
    file: F_ENGINE,
    /* ⚠️ A-1140 把 `tokenize` 改成吃 `IndexOptions`（停用词/最短词长也在这里剔）⇒
       旧锚点 `for (…) { out.push(w.slice(i, i + 2)); }` 已经不存在。重锚到现行源码，
       意图不变：**窗口里塞整词而不是二元** ⇒ 索引里没有 bigram，子串查询一律落空。 */
    mutate: (t) => sub(t,
      "      const t = w.slice(i, i + 2);\n      if (!stop.has(t)) { out.push(t); }",
      "      if (!stop.has(w)) { out.push(w); }"),
  },
  {
    name: "2 engine：整词保留阈值 4 改 3（长词进不了索引 ⇒ 召回面悄悄变窄）",
    file: F_ENGINE,
    /* ⚠️ 同上：阈值现在从 `opts.wholeWordMaxLen` 取（默认 4）⇒ 旧锚点 `<= 4` 已不存在。
       重锚时**写死 3**（而不是改 `DEFAULT_INDEX_OPTIONS`）—— 这才是"阈值本身被写死"这个缺陷。 */
    mutate: (t) => sub(t, "if (w.length <= opts.wholeWordMaxLen && !stop.has(w)) { out.push(w); }",
      "if (w.length <= 3 && !stop.has(w)) { out.push(w); }"),
  },
  {
    name: "3 engine：CJK 判定阈值改错（常用汉字被当英文整词切 ⇒ bigram 消失、中文搜不到）",
    file: F_ENGINE,
    /* ⚠️ 原锚点是 `0x0080` —— 那是**等价变异体**：`TOKEN_RE` 只能产出 ASCII（<0x80）
       或 CJK（≥0x3400），`[0x80, 0x2e80)` 区间**没有任何字符可达** ⇒ 改了字节、行为没变。
       `0x9fff` 把 U+4E00–U+9FFF（常用汉字）全压到「整词」分支 ⇒ bigram 消失，是真变异。 */
    mutate: (t) => sub(t, "if (w.charCodeAt(0) < 0x2e80) {", "if (w.charCodeAt(0) < 0x9fff) {"),
  },
  {
    name: "4 engine：去掉 toLowerCase（索引侧与查询侧口径不再一致）",
    file: F_ENGINE,
    mutate: (t) => sub(t, 'const s = String(text ?? "").toLowerCase();', 'const s = String(text ?? "");'),
  },

  /* ───── ② BM25：改数值 = 悄悄改排序 ───── */
  /* ⚠️ 2026-10-01 重锚：三个别名（`BM25_K1` / `BM25_B` / `TITLE_BOOST`）已按 A-1140 收尾**删除**
     （实现里没有任何消费点 ⇒ 纯测试面出口 = 第二产地的种子）。旧锚点也随之消失。
     ⇒ 变异点换成**改默认值本身**：那才是现在打分口径的唯一产地，改它 = 改所有人的检索结果。 */
  {
    name: "5 engine：默认 titleBoost 漂成 1.0（标题命中不再优先）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  titleBoost: 3.0,\n  wholeWordMaxLen: 4,", "  titleBoost: 1.0,\n  wholeWordMaxLen: 4,"),
  },
  {
    name: "6 engine：默认 k1 漂成 1.2（排序悄悄变，无报错）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  k1: 1.5,\n  b: 0.75,", "  k1: 1.2,\n  b: 0.75,"),
  },
  {
    name: "7 engine：默认 b 漂成 0.5（长度归一化权重悄悄变）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  b: 0.75,\n  titleBoost: 3.0,", "  b: 0.5,\n  titleBoost: 3.0,"),
  },
  {
    name: "8 engine：idf 公式改错（常见词/罕见词权重颠倒）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "return Math.log(1 + (index.docs - df + 0.5) / (df + 0.5));",
      "return Math.log(1 + index.docs / df);"),
  },
  {
    name: "9 engine：AND 优先去掉（部分命中混在全命中前面）",
    file: F_ENGINE,
    /* ⚠️ 2026-10-01 锚点更新：本轮加了查询语法/内容去重，`ordered` 拼的是 `eligible`
       （= 有硬过滤时是过滤后的表，**无过滤时就是 `ranked` 本身**）而不是 `ranked`。
       语义没变（"AND 优先"这条闸门依旧），只是拼接的源表改名了。 */
    mutate: (t) => sub(t,
      "  const ordered = full.length >= 1\n    ? (full.length < need ? [...full, ...eligible.filter((kv) => !full.includes(kv))] : full)\n    : eligible;",
      "  const ordered = eligible;"),
  },
  {
    name: "10 engine：分页变 1 基（与页面那边的 0 基对不上 ⇒ 第一页永远空）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "for (const [doc, score] of ordered.slice(page * size, page * size + size)) {",
      "for (const [doc, score] of ordered.slice((page + 1) * size, (page + 1) * size + size)) {"),
  },
  {
    name: "11 engine：item 的 source 漂了（页面来源徽标变了 = 同一事实两个产地）",
    file: F_ENGINE,
    mutate: (t) => sub(t, 'export const SEARCH_ITEM_SOURCE = "自建索引";', 'export const SEARCH_ITEM_SOURCE = "local";'),
  },
  {
    name: "12 engine：没命中时摘要返回空（结果卡只剩标题）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "if (idx < 0) { return text.slice(0, width * 2); }", 'if (idx < 0) { return ""; }'),
  },
  {
    name: "13 engine：terms 统计写成 pages（状态里的「索引 N 词」是假的）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "return { pages: index.docs, terms: Object.keys(index.df).length };",
      "return { pages: index.docs, terms: index.docs };"),
  },

  /* ───── ③ 爬虫 ───── */
  {
    name: "14 crawler：URL 归一化放过 ftp（协议白名单形同虚设）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, 'if (u.protocol !== "http:" && u.protocol !== "https:") { return null; }',
      'if (u.protocol === "ftp:") { return null; }'),
  },
  {
    name: "15 crawler：不去 fragment（同一页面被当多页重复入库）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, 'return u.protocol + "//" + u.hostname.toLowerCase() + port + path + (u.search || "");',
      'return u.protocol + "//" + u.hostname.toLowerCase() + port + path + (u.search || "") + u.hash;'),
  },
  {
    name: "16 crawler：不去尾斜杠（`/a` 与 `/a/` 两条重复）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, 'if (path !== "/" && path.endsWith("/")) { path = path.slice(0, -1); }',
      'if (false) { path = path.slice(0, -1); }'),
  },
  {
    name: "17 crawler：跳过扩展名失效（去抓 png/zip/pdf）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "if (SKIP_EXT_RE.test(item.url)) { skipped += 1; continue; }", "if (false) { skipped += 1; continue; }"),
  },
  {
    name: "18 crawler：正文抽取不去 script/style（索引里塞满代码 ⇒ 检索质量静默劣化）",
    file: F_CRAWLER,
    mutate: (t) => sub(t,
      '.replace(/<(script|style|noscript|template|iframe|svg|canvas)\\b[\\s\\S]*?<\\/\\1>/gi, " ")',
      '.replace(/<(noscript|template|iframe|svg|canvas)\\b[\\s\\S]*?<\\/\\1>/gi, " ")'),
  },
  {
    name: "19 crawler：robots 的 Disallow 判据失效（抓不该抓的站点）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "if (path.startsWith(d)) { return false; }", "if (false) { return false; }"),
  },
  {
    name: "20 crawler：robots 取不到时**禁止**（与 Python 基准相反：取不到应放行）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "allowed = r.ok && r.html ? robotsAllows(r.html, item.url) : true;",
      "allowed = r.ok && r.html ? robotsAllows(r.html, item.url) : false;"),
  },
  {
    name: "21 crawler：入队不去重（同一页反复入队，靠 maxPages 兜底 ⇒ **不报错**，只是白抓）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "if (!u || seen.has(u)) { continue; }", "if (!u) { continue; }"),
  },
  {
    name: "22 crawler：深度上限放宽（用户设 maxDepth=1，实际爬到第 2 层）",
    file: F_CRAWLER,
    /* ⚠️ 原锚点是出队那行 `if (item.depth > maxDepth)` —— 那是**死代码**：
       入队条件 `if (item.depth < maxDepth)` 已经保证入队的 depth ≤ maxDepth
       ⇒ 出队判断永不成立，改它 = 等价变异体。真正决定"能爬多深"的是这里的夹取。 */
    mutate: (t) => sub(t, "const maxDepth = Math.max(1, Math.min(6, Math.floor(opts.maxDepth ?? 3)));",
      "const maxDepth = Math.max(1, Math.min(6, Math.floor((opts.maxDepth ?? 3) + 1)));"),
  },

  /* ───── ④ 服务 ───── */
  {
    name: "23 service：CORS 头改掉（页面 fetch 被浏览器拦 ⇒ 补充命中永远不出现）",
    file: F_SERVICE,
    mutate: (t) => sub(t, '"Access-Control-Allow-Origin": "*",', '"Access-Control-Allow-Origin": "http://localhost",'),
  },
  {
    name: "24 service：缺 q 返回 ok（页面把失败当成功渲染）",
    file: F_SERVICE,
    mutate: (t) => sub(t, 'send(res, 200, { ok: false, error: "缺少 q 参数", items: [], total: 0 }); return;',
      'send(res, 200, { ok: true, error: "缺少 q 参数", items: [], total: 0 }); return;'),
  },
  {
    name: "25 service：缺 seed 返回 200（爬取命令静默不生效）",
    file: F_SERVICE,
    mutate: (t) => sub(t, 'send(res, 400, { ok: false, error: "缺少 seed" }); return;',
      'send(res, 200, { ok: false, error: "缺少 seed" }); return;'),
  },
  {
    name: "26 service：端口冲突静默（服务根本没起来但没人知道）",
    file: F_SERVICE,
    mutate: (t) => sub(t,
      'resolve({ ok: false, error: e.code === "EADDRINUSE" ? `端口 ${state.port} 已被占用` : String(e.message) });',
      "resolve({ ok: true });"),
  },
  {
    name: "27 service：不写回实际端口（调用方拿到 0 ⇒ 连 127.0.0.1:0 ⇒ EADDRNOTAVAIL）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "if (addr && typeof addr !== \"string\") { state.port = addr.port; }",
      "if (false) { state.port = addr.port; }"),
  },
  {
    name: "28 service：不落盘（重启后索引全丢，且不报错）",
    file: F_SERVICE,
    /* ⚠️ 2026-10-01 锚点更新：本轮 `savePages` 从"每个调用点各写一次"收归成**函数**，
       落盘点变成定义里那一行（`savePages(state.pagesPath, state.pages)` 现在出现 4 次 ⇒
       拿它当锚点会被判「不唯一」）。改在**唯一产地**上，语义更准：一处坏 ⇒ 四条路径全不落盘。 */
    mutate: (t) => sub(t, 'writeFileSync(pagesPath, JSON.stringify(pages), "utf8");', "void pagesPath;"),
  },
  {
    name: "29 service：IPC 放行非主窗口（任何页面都能让 slime 起一个本机监听服务）",
    file: F_SERVICE,
    mutate: (t) => sub(t,
      '    if (!trusted(event)) { return { ok: false, error: "未授权来源：只有主窗口可以控制索引服务" }; }\n    return startSearchIndexService(deps);',
      "    return startSearchIndexService(deps);"),
  },
  {
    name: "30 service：默认端口不是 8600（页面零改动的前提没了）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "export const SEARCH_INDEX_PORT = 8600;", "export const SEARCH_INDEX_PORT = 8700;"),
  },

  /* ───── ⑤ 一键 UI（A-1138 后半段：设置页那个面板 + 它的 IPC 入口）───── */
  {
    name: "31 service：`indexCrawl` IPC 放行非主窗口（任何页面都能让 slime 去爬外网站点）",
    file: F_SERVICE,
    /* ⚠️ 2026-10-01 锚点更新：本轮 crawl 载荷改成 `unknown` 并在 `normalizeSeeds` 里归一
       （兼容 `{ seeds, opts }` / 裸字符串 / 数组）⇒ 入参名与调用体都变了。 */
    mutate: (t) => sub(t,
      '  ipcMain.handle(IPC_CHANNELS.search_index_crawl, (event, payload: unknown) => {\n    if (!trusted(event)) { return { ok: false, error: "未授权来源：只有主窗口可以控制索引服务" }; }',
      '  ipcMain.handle(IPC_CHANNELS.search_index_crawl, (event, payload: unknown) => {'),
  },
  {
    name: "32 service：一键收录不校验空网址（点空按钮 ⇒ 静默开一个什么都不抓的任务）",
    file: F_SERVICE,
    mutate: (t) => sub(t,
      '  if (!s) { return { ok: false, error: "请填写要收录的网址（http/https 开头）" }; }',
      '  if (false) { return { ok: false, error: "请填写要收录的网址（http/https 开头）" }; }'),
  },
  {
    name: "33 panel：失败把 error 吞掉（端口被占用静默 ⇒ 用户永远不知道为什么搜不到）",
    file: F_PANEL,
    /* 判据是「失败出口**存在**」⇒ 把它改成永远不进 error 分支即可命中。 */
    mutate: (t) => sub(t, '      if (!r.ok) { setNotice({ ok: false, text: r.error ?? "操作失败" }); return false; }',
      "      if (!r.ok) { return false; }"),
  },
  {
    name: "34 main：接线被删 —— IPC 没注册（设置页那几个按钮全是死的，而门禁全绿）",
    file: F_MAIN,
    mutate: (t) => sub(t,
      '  registerSearchIndexIpc({\n    userData: app.getPath("userData"),\n    isMainSender: (sender: Electron.WebContents): boolean => isTrustedSender(sender),\n  });',
      "  /* 变异：IPC 注册被删 */"),
  },
  {
    name: "35 main：服务没被启动（搜索页永远拿不到「补充命中」，而门禁全绿）",
    file: F_MAIN,
    /* 保持语法合法（后面还挂着 `.then(...).catch(...)`），只把「启动」换成一个空承诺。 */
    mutate: (t) => sub(t, "void startSearchIndexService({ userData: app.getPath(\"userData\") })",
      "void Promise.resolve({ ok: true })"),
  },

  /* ───── ⑧ 查询语法（A-1139 补：短语 / site: / 排除词）───── */
  {
    name: "36 engine：短语被**分词后**再匹配（「手冲 咖啡」变成 bigram 串 ⇒ 永远搜不到）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    if (t) { phrases.push(t); }",
      '    if (t) { phrases.push(tokenize(t).join(" ")); }'),
  },
  {
    name: "37 engine：短语内部也参与指令解析（「a -b c」里的 `-b` 被当成排除词）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  for (const w of rest.split(/\\s+/)) {",
      "  for (const w of [...rest.split(/\\s+/), ...phrases.flatMap((p) => p.split(/\\s+/))]) {"),
  },
  {
    name: "38 engine：短语只判正文、不判标题（只在标题里出现的短语搜不到）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    if (!lowText.includes(ph) && !lowTitle.includes(ph)) { return false; }",
      "    if (!lowText.includes(ph)) { return false; }"),
  },
  {
    name: "39 engine：`site:` 退化成字符串后缀比较（`xample.com` 也命中 `example.com`）",
    file: F_ENGINE,
    mutate: (t) => sub(t, '  return h === site || h.endsWith("." + site);', "  return h.endsWith(site);"),
  },
  {
    name: "40 engine：`site:` 不做归一（协议 / `www.` / 路径留在里面 ⇒ 一个都匹配不上）",
    file: F_ENGINE,
    mutate: (t) => sub(t,
      '      site = low.slice("site:".length).replace(/^https?:\\/\\//, "").replace(/^www\\./, "").replace(/\\/.*$/, "");',
      '      site = low.slice("site:".length);'),
  },
  {
    name: "41 engine：排除词按**精确相等**判（`-测试` 剔不掉「测试机」⇒ 该剔的没剔）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    if (lowText.includes(ex) || lowTitle.includes(ex)) { return false; }",
      "    if (lowText === ex || lowTitle === ex) { return false; }"),
  },
  {
    name: "42 engine：只有过滤器时**也**直接返回空（`site:` / `-词` 单独用永远没结果）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    if (!hasFilters) { return empty; }", "    if (true) { return empty; }"),
  },
  {
    name: "43 engine：全量扫描按 id **正序**（新收录的排最后 ⇒ 与「新内容在前」的约定相反）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    all.sort((a, b) => b[0] - a[0]);", "    all.sort((a, b) => a[0] - b[0]);"),
  },
  {
    name: "44 engine：带正词时**完全不筛**（过滤只活在「没有正词」那条路上 ⇒ 短语/site 形同虚设）",
    file: F_ENGINE,
    mutate: (t) => sub(t,
      "  const eligible = hasFilters\n    ? ranked.filter(([doc]) => {\n      const pg = lookup(doc);\n      return !!pg && passesFilters(pg.url, pg.title, pg.text, q);\n    })\n    : ranked;",
      "  const eligible = ranked;"),
  },

  /* ───── ⑨ 增量入库 / 去重 / 站点管理（A-1139 补）───── */
  {
    name: "45 service：`normalizeSeeds` 只按换行切（逗号/空格分隔的一列网址被拼成一条）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "    ? input.split(/[\\r\\n,，;；\\s]+/)", "    ? input.split(/\\n/)"),
  },
  {
    name: "46 service：`normalizeSeeds` 不去重（同一网址被收两遍 ⇒ 批量收录白跑一半）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "    if (!u || seen.has(u)) { continue; }", "    if (!u) { continue; }"),
  },
  {
    name: "47 service：`normalizeSeeds` 不做 `normalizeUrl`（`ftp:` / `file:` / 裸数字都当种子）",
    file: F_SERVICE,
    mutate: (t) => sub(t, '    const u = normalizeUrl(String(s ?? "").trim());',
      '    const u = String(s ?? "").trim();'),
  },
  {
    name: "48 service：upsert 不认「同一 URL」（重复收录变成又插一条 ⇒ 结果页出现两条一样的）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "    const existing = state.byUrl.get(p.url);", "    const existing = undefined;"),
  },
  {
    name: "49 service：更新时只改 title、**不改 text**（半吊子更新：页数没涨但内容还是旧的）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "      existing.title = p.title;\n      existing.text = p.text;", "      existing.title = p.title;"),
  },
  {
    name: "50 service：跨 URL 内容去重失效（镜像/转载被当成新页 ⇒ 结果页全是同一条）",
    file: F_SERVICE,
    /* ⚠️ 原锚那行尾部带注释（`别处已收录同样内容（镜像/转载）`），2026-10-05 剥离后
       变成「代码 + 1 个尾随空格」⇒ 单行锚点不再逐字相符。
       ⇒ 缩到**纯代码**（去掉行尾空白与已消失的注释）。实测唯一命中，语义不变。 */
    mutate: (t) => sub(t, "    if (state.fpTaken.has(fp)) { stats.dups += 1; continue; }",
      "    if (false) { stats.dups += 1; continue; }"),
  },
  {
    name: "51 service：清空时**不重建**（`fpTaken` 残留 ⇒ 同一篇再也收不进来，索引永远是空的）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  const n = state.pages.length;\n  state.pages = [];\n  rebuild();",
      "  const n = state.pages.length;\n  state.pages = [];"),
  },
  {
    name: "52 service：按站删除后**不重编号 id**（下一批新增撞号 ⇒ byId 里一页被顶掉，静默丢页）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  state.pages = keep.map((p, i) => ({ ...p, id: i + 1 }));", "  state.pages = keep;"),
  },
  {
    name: "53 service：按站删除不筛（removed 恒 0 ⇒ 点了没删掉，却报了成功）",
    file: F_SERVICE,
    mutate: (t) => sub(t, '  const keep = state.pages.filter((p) => (hostOf(p.url) || "").toLowerCase() !== h);',
      "  const keep = state.pages.slice();"),
  },
  {
    name: "54 service：按站删除遇到空域名不报错（静默 ok:true、removed:0）",
    file: F_SERVICE,
    mutate: (t) => sub(t, '  if (!h) { return { ok: false, removed: 0, error: "缺少要删除的站点域名" }; }',
      '  if (false) { return { ok: false, removed: 0, error: "缺少要删除的站点域名" }; }'),
  },
  {
    name: "55 service：重建不落盘（`pages.json` 被删后再重建也回不来 ⇒ 下次启动索引空）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "export function rebuildSearchIndex(): { ok: boolean; pages: number; terms: number } {\n  rebuild();\n  savePages(state.pagesPath, state.pages);",
      "export function rebuildSearchIndex(): { ok: boolean; pages: number; terms: number } {\n  rebuild();"),
  },
  {
    name: "56 service：默认抓取器按 **UTF-8 硬解**（GBK 站点整页变乱码入库 —— 中文乱码回归）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "        const { text } = decodeHtmlBytes(Buffer.concat(chunks));",
      '        const text = Buffer.concat(chunks).toString("utf8");'),
  },
  {
    name: "57 service：`/crawl` 只认 `seeds`（丢掉旧的 `seed` ⇒ 页面那边的一键收录失灵）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  const seeds = normalizeSeeds(payload.seeds ?? payload.seed);",
      "  const seeds = normalizeSeeds(payload.seeds);"),
  },

  /* ───── ⑩ 面板：串桥 / 破坏性操作的确认（A-1139 补）───── */
  {
    name: "58 panel：**重建接到了清空**（点「重建索引」把整库删了 —— 破坏性操作串桥）",
    file: F_PANEL,
    /* ⚠️ 这条只判"面板里出现过 indexRebuild"是抓不住的：七个桥名一个不少。
       守卫锚的是"哪个动作函数调了哪条桥"。 */
    mutate: (t) => sub(t, '    await call((api) => api.indexRebuild(), "索引已重建（未重新抓取）");',
      '    await call((api) => api.indexClear(), "索引已重建（未重新抓取）");'),
  },
  {
    name: "59 panel：清空**没有二次确认**（一次手滑丢掉全部收录，不可撤销）",
    file: F_PANEL,
    mutate: (t) => sub(t,
      "    if (n > 0 && !window.confirm(`确定清空索引吗？将删除已收录的 ${n} 个页面，此操作不可撤销。`)) { return; }",
      "    if (false) { return; }"),
  },
  {
    name: "60 panel：删站**没有二次确认**（同 59，另一条销毁入口）",
    file: F_PANEL,
    mutate: (t) => sub(t,
      "    if (!window.confirm(`确定删除站点「${host}」的全部已收录页面吗？`)) { return; }",
      "    if (false) { return; }"),
  },
];

/* ---------------- 以下与 mut-a1137-search-bridge.mjs 同构（同一套校准逻辑） ---------------- */
const arg = process.argv;
const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const p = spawnSync(process.execPath, [
    join(ROOT, "node_modules/.pnpm/vitest@2.1.0_@types+node@24.13.3_supports-color@7.1.0/node_modules/vitest/vitest.mjs"),
    "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot",
  ], { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const out = (p.stdout || "") + (p.stderr || "");
  const spawnBlocked = /EBUSY|EINVAL.*spawn/i.test(out) && /node_modules/.test(out);
  const hasSummary = /Tests\s+\d+\s+(failed|passed)/.test(out.replace(/\u001b\[[0-9;]*m/g, ""));
  return { ok: p.status === 0, out, spawnBlocked, measurementFailed: !hasSummary };
}

const mode = arg.includes("--list") ? "list"
  : arg.includes("--restore") ? "restore"
    : arg.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(arg[arg.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) { console.error("上一轮变异还没还原 —— 先 --restore。"); process.exit(1); }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) { console.error(`❌ 还原校验失败：${man.file}`); process.exit(1); }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* ⚠️ 签名是 `installRestoreOnSignal(targets, root)`（传**路径数组**，不是回调）——
   传回调时它内部 `targets.map` 直接 TypeError，而本环境全量模式跑不到那一行 ⇒ 缺陷会一直潜伏。 */
installRestoreOnSignal(TARGETS, ROOT);

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1138")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中`); missed.push(m.name); continue; }
    writeFileSync(path, next);
    const res = runSpec();
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { for (const t of TARGETS) { writeFileSync(abs(t), originals.get(t)); } }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
