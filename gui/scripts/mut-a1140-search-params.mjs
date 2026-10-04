#!/usr/bin/env node
/**
 * gui/scripts/mut-a1140-search-params.mjs — A-1140（分词 / 正文参数可调）的变异验证。
 *
 * ## 这一组要护的是什么
 * 参数这类东西最危险的失效方式**不是崩溃**，而是「改了没反应 / 悄悄变了味」：
 *   1  默认值漂（k1 / b / titleBoost / 整词长度）⇒ **所有用户的检索结果一起变**，而门禁全绿
 *   2-4 三个旧常量不再是派生别名 ⇒ 两份各自漂，"默认值看着没变、实际打分变了"
 *   5  夹取写成 `v > 0 ? v : d` ⇒ `k1=0` / `b=0` / `titleBoost=0` 被静默打回默认（界面上看不出）
 *   6  夹取的"缺省"回 0 而不是回默认 ⇒ 空输入变成"我要 0"
 *   7/8 停用词不去重 / 不小写 ⇒ 同一份参数两套语义（"设了没用"）
 *   9  停用词集合恒空 ⇒ 设了停用词等于没设（**最典型**的"参数没反应"）
 *  10/11 索引侧剔了停用词、查询侧没剔（或反过来）⇒ 命中数永远 0 且不报错
 *  12  中文整词保留不看 `wholeWordMaxLen` ⇒ 这个参数永远无效
 *  13  `minTermLen` 不生效 ⇒ 同上
 *  14  `SearchIndex.opts` 被换成默认值 / 丢掉 ⇒ 查询拿默认口径去查另一套口径建的倒排
 *  15  `searchIndex` 改用 `DEFAULT_INDEX_OPTIONS` 而不读 `index.opts` ⇒ 同上（另一条路）
 *  16-19 打分处回退到写死的常量 ⇒ `k1` / `b` / `titleBoost` 三个旋钮"看着能转，实际不转"
 *  20-23 正文参数：夹取上界失效 / 下界抬到 1（`0 = 不限` 变得不可达）/ 默认值漂 / 夹取整个被绕过
 *  24-26 `crawl()` 不截断 / 质量闸失效 / 上界判据写成 `>= 0`（默认 0 变成"截成空"）
 *  27  改完参数**不重建**索引 ⇒ 新参数只对之后收录的页生效，同一个库里两套口径
 *  28  `rebuild()` 不用全局参数建倒排 ⇒ 同上（另一条路）
 *  29  `loadParams` 不夹取手改的 `params.json` ⇒ `k1=1e9` 进索引，打分变 NaN/Infinity 且不报错
 *  30  `params.json` 写坏时不记日志 ⇒ 用户的参数被静默重置，查不出原因
 *  31  `saveParams` 不落盘 ⇒ 重启后参数丢（不报错）
 *  32  收录中**不拒绝**改参数 ⇒ 这批页用了哪套分词没人说得清
 *  33  `clampNotice` 被绕过 / 空值不跳过 ⇒ 要么"被夹取了却一声不吭"，要么提示变噪音
 *  34  `/status` 不回带 `params` ⇒ 页面/第三方看到的事实与 IPC 看到的不是同一份
 *  35  启动时不载入 `params.json` ⇒ 每次开机都回默认
 *  36  `params.json` 路径漂 ⇒ 落盘与读取不是同一个文件（写了白写）
 *  37  **正文参数没接到收录里**（`beginCrawl` 不传给 `crawl`）⇒ 两个输入框能填能存，
 *      收录时完全不生效
 *  38  写参数那条 IPC **删掉授权判据** ⇒ 任何页面都能改整个索引的行为
 *  39  授权文案漂（7 条判据变 1 条）⇒ "每条都单独把关"这句话不再成立
 *  40  `params.json` 落盘上限不再夹取（正文起止值）—— 见 20
 *  41  两条 IPC 通道名漂 ⇒ preload 与主进程对不上（调用永远挂空）
 *  42  preload 通道名漂 ⇒ 同上（另一侧）
 *  43/44 面板：保存**串到别的桥** / 保存完不把生效值拉回来
 *  45  面板把 `notice` 吞掉 ⇒ 填了 999 被夹到 8 而界面上没有任何痕迹（降级看不见）
 *  46  参数输入框改回 `type="number"` ⇒ 渲染层开始偷偷做判据（空输入变 0）
 *  47/48 面板上两组参数的区别没写清楚 ⇒ 用户以为"改完只影响下次收录"
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
const SPECS = ["tests/gui/a1140-search-params.spec.ts"];

const F_ENGINE = "core-ts/src/websearch/engine.ts";
const F_CRAWLER = "core-ts/src/websearch/crawler.ts";
const F_SERVICE = "gui/src/main/searchIndexService.ts";
const F_PANEL = "gui/src/renderer/pages/SearchIndexPanel.tsx";
const F_IPC = "gui/src/shared/ipc.ts";
const F_PRELOAD = "gui/src/preload/index.ts";

const TARGETS = [F_ENGINE, F_CRAWLER, F_SERVICE, F_PANEL, F_IPC, F_PRELOAD];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1140");

const MUTATIONS = [
  /* ───── ① 默认值就是行为基准（改它 = 改所有人的检索结果）───── */
  {
    name: "1 engine：默认 k1 漂成 1.2（所有人都换了一套 BM25，而门禁全绿）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  k1: 1.5,\n  b: 0.75,", "  k1: 1.2,\n  b: 0.75,"),
  },
  {
    name: "2 engine：默认 b 漂成 0.5（长度归一悄悄变味）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  b: 0.75,\n  titleBoost: 3.0,", "  b: 0.5,\n  titleBoost: 3.0,"),
  },
  {
    name: "3 engine：默认 titleBoost 漂成 1.0（标题命中不再优先）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  titleBoost: 3.0,\n  wholeWordMaxLen: 4,", "  titleBoost: 1.0,\n  wholeWordMaxLen: 4,"),
  },
  {
    name: "4 engine：默认整词长度 4 改 3（长词进不了索引 ⇒ 召回面悄悄变窄）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  wholeWordMaxLen: 4,\n  minTermLen: 1,", "  wholeWordMaxLen: 3,\n  minTermLen: 1,"),
  },
  /* ⚠️ 2026-10-01 重锚：三个别名 `BM25_K1`/`BM25_B`/`TITLE_BOOST` 已删除（实现里没有消费点，
     留着就是第二产地的种子）。旧锚点（派生那行）随之消失。
     ⇒ 变异点换成**把别名加回来**（且数值与默认值不一致）—— 这是现在最现实的一种回归：
     有人为了兼容旧代码补一个 `export const BM25_K1 = 1.2;`，打分口径立刻出现两个产地，
     而"默认值看着没变"，最难查。判据 = spec ① 的「源码里不许出现这三个标识符」。 */
  {
    name: "5 engine：有人把 `BM25_K1` 加回来（打分口径出现第二产地，且值与默认值漂开）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  fuzzyMaxExpansions: 50,\n};", "  fuzzyMaxExpansions: 50,\n};\nexport const BM25_K1 = 1.2;"),
  },
  {
    name: "6 engine：有人把 `BM25_B` 加回来",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  fuzzyMaxExpansions: 50,\n};", "  fuzzyMaxExpansions: 50,\n};\nexport const BM25_B = 0.5;"),
  },
  {
    name: "7 engine：有人把 `TITLE_BOOST` 加回来",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  fuzzyMaxExpansions: 50,\n};", "  fuzzyMaxExpansions: 50,\n};\nexport const TITLE_BOOST = 1.0;"),
  },

  /* ───── ② 夹取：`0` 是合法值 / 缺省回默认 ───── */
  {
    name: "8 engine：夹取写成 `v > 0 ? v : 默认`（k1=0 / b=0 / titleBoost=0 被静默打回默认）",
    file: F_ENGINE,
    mutate: (t) => sub(t,
      "    if (v === undefined || v === null || v === \"\" || !Number.isFinite(n)) { return d; }\n    return Math.min(hi, Math.max(lo, n));",
      "    if (v === undefined || v === null || v === \"\" || !Number.isFinite(n)) { return d; }\n    return n > 0 ? Math.min(hi, Math.max(lo, n)) : d;"),
  },
  {
    name: "9 engine：夹取的「缺省」回 0 而不是回默认（空输入变成「我要 0」）",
    file: F_ENGINE,
    mutate: (t) => sub(t,
      "    if (v === undefined || v === null || v === \"\" || !Number.isFinite(n)) { return d; }\n    return Math.min(hi, Math.max(lo, n));",
      "    if (false) { return d; }\n    return Math.min(hi, Math.max(lo, n));"),
  },
  {
    name: "10 engine：停用词不做小写归一（`We` 与 `we` 变成两个词）",
    file: F_ENGINE,
    mutate: (t) => sub(t, ".map((s) => String(s ?? \"\").trim().toLowerCase())", ".map((s) => String(s ?? \"\").trim())"),
  },
  {
    name: "11 engine：停用词不去重（同一份参数出现两条一样的词）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    ? [...new Set(", "    ? [...("),
  },
  {
    name: "12 engine：停用词集合恒为空（**设了停用词等于没设**）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  return list.length === 0 ? EMPTY_STOP : new Set(list.map((s) => s.toLowerCase()));",
      "  return EMPTY_STOP;"),
  },

  /* ───── ③ 分词参数真的改变切分 ───── */
  {
    name: "13 engine：索引侧不剔英文停用词（查询侧还剔 ⇒ 两边口径不同）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "      if (w.length >= opts.minTermLen && !stop.has(w)) { out.push(w); }",
      "      if (w.length >= opts.minTermLen) { out.push(w); }"),
  },
  {
    name: "14 engine：二元切分不剔停用词（中文停用词形同虚设）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "      const t = w.slice(i, i + 2);\n      if (!stop.has(t)) { out.push(t); }",
      "      const t = w.slice(i, i + 2);\n      out.push(t);"),
  },
  {
    name: "15 engine：中文整词保留写死 4（`wholeWordMaxLen` 这个旋钮永远无效）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    if (w.length <= opts.wholeWordMaxLen && !stop.has(w)) { out.push(w); }",
      "    if (w.length <= 4 && !stop.has(w)) { out.push(w); }"),
  },
  {
    name: "16 engine：`minTermLen` 不生效（短英文词照样进索引）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "      if (w.length >= opts.minTermLen && !stop.has(w)) { out.push(w); }",
      "      if (w.length >= 1 && !stop.has(w)) { out.push(w); }"),
  },

  /* ───── ④ 索引自描述（检索与建索引必须同口径）───── */
  {
    name: "17 engine：`buildIndex` 不把参数钉在索引上（换成默认值 ⇒ 查询拿错口径）",
    file: F_ENGINE,
    mutate: (t) => sub(t,
      "  return { opts, docs: pages.length, avdl: pages.length ? totalLen / pages.length : 0, df, postings, docLen };",
      "  return { opts: DEFAULT_INDEX_OPTIONS, docs: pages.length, avdl: pages.length ? totalLen / pages.length : 0, df, postings, docLen };"),
  },
  {
    name: "18 engine：`searchIndex` 改用默认参数而不读 `index.opts`（命中数永远 0，且不报错）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  const o = index.opts ?? DEFAULT_INDEX_OPTIONS;", "  const o = DEFAULT_INDEX_OPTIONS;"),
  },

  /* ───── ⑤ 打分：改了必须真的改结果 ───── */
  {
    name: "19 engine：粗排的 titleBoost 回退到写死的字面量（`titleBoost=0` 时只在标题里出现的页仍被计分）",
    file: F_ENGINE,
    /* ⚠️ 变异体原本写 `TITLE_BOOST * p.titleTf`（回退到别名常量）—— 别名已删除，
       那样只会引出一个未定义标识符（那是"编译不过"式的假绿）。回退到**字面量**才是真变异。 */
    mutate: (t) => sub(t, "      const effTf = p.tf + o.titleBoost * p.titleTf;",
      "      const effTf = p.tf + 3.0 * p.titleTf;"),
  },
  {
    name: "20 engine：精排**整个丢掉标题命中**（`eff_tf` 里没有 titleBoost 项 ⇒ 标题命中不再优先）",
    file: F_ENGINE,
    /* ⚠️ 原写的是「精排的 titleBoost 回退到常量（`TITLE_BOOST = 3.0`）」—— 实测**存活**，
       且那是**等价变异体**而不是守卫漏了：`titleBoost=0` 时**粗排**那句
       `const effTf = p.tf + o.titleBoost * p.titleTf;` 已经把「只在标题里出现」的页算成
       `effTf = 0` 并被 `effTf <= 0` 挡掉 ⇒ 它压根进不了 `scores`，精排也就永远看不到它。
       于是精排那处用 3.0 还是 0 在**所有现实输入**上都不可观测（铁律 9：字节变了、行为没变）。
       ⇒ 换成真能改变的：精排直接不看 `titleTf`（标题权重被人"简化"掉，是很现实的写法）。 */
    mutate: (t) => sub(t, "      const effTf = pr.tf + o.titleBoost * pr.titleTf;",
      "      const effTf = pr.tf;"),
  },
  {
    name: "21 engine：精排的 k1 回退到写死的字面量（`k1=0` 不再退化成纯 idf）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "      const denom = effTf + o.k1 * (1 - o.b + (o.b * docLen) / avdl);",
      "      const denom = effTf + 1.5 * (1 - o.b + (o.b * docLen) / avdl);"),
  },
  {
    name: "22 engine：精排的 b 回退到写死的字面量（`b=0` 关不掉长度归一）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "      const denom = effTf + o.k1 * (1 - o.b + (o.b * docLen) / avdl);",
      "      const denom = effTf + o.k1 * (1 - o.b + (0.75 * docLen) / avdl);"),
  },

  /* ───── ⑥ 正文参数（抓取时生效）───── */
  {
    name: "23 crawler：正文夹取上界失效（`maxBodyChars` 可以填到 999 万 ⇒ 单页把倒排撑爆）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "    return Math.floor(Math.min(hi, Math.max(lo, n)));",
      "    return Math.floor(Math.max(lo, n));"),
  },
  {
    name: "24 crawler：正文夹取下界抬到 1（`0 = 不设闸 / 不限` 变得不可达）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "    minBodyChars: num(o.minBodyChars, DEFAULT_BODY_OPTIONS.minBodyChars, 0, 100_000),",
      "    minBodyChars: num(o.minBodyChars, DEFAULT_BODY_OPTIONS.minBodyChars, 1, 100_000),"),
  },
  {
    name: "25 crawler：`DEFAULT_BODY_OPTIONS` 漂（默认不再等于旧行为）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "export const DEFAULT_BODY_OPTIONS: BodyOptions = { minBodyChars: 1, maxBodyChars: 0 };",
      "export const DEFAULT_BODY_OPTIONS: BodyOptions = { minBodyChars: 0, maxBodyChars: 0 };"),
  },
  {
    name: "26 crawler：`crawl()` 里的正文夹取整个被绕过（直接调用方传什么都当默认）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "  const body = clampBodyOptions({ minBodyChars: opts.minBodyChars, maxBodyChars: opts.maxBodyChars });",
      "  const body = { minBodyChars: 1, maxBodyChars: 0 };"),
  },
  {
    name: "27 crawler：正文上限不截断（超长页整段入库）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "    const text = body.maxBodyChars > 0 ? parsed.text.slice(0, body.maxBodyChars) : parsed.text;",
      "    const text = parsed.text;"),
  },
  {
    name: "28 crawler：最短正文闸失效（导航页 / 跳转页照收）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "    if (text.length < body.minBodyChars) {", "    if (text.length < 1) {"),
  },
  {
    name: "29 crawler：上限判据写成 `>= 0`（默认 0 从「不截断」变成「截成空」⇒ 一页都收不进）",
    file: F_CRAWLER,
    mutate: (t) => sub(t, "body.maxBodyChars > 0 ? parsed.text.slice(0, body.maxBodyChars) : parsed.text",
      "body.maxBodyChars >= 0 ? parsed.text.slice(0, body.maxBodyChars) : parsed.text"),
  },

  /* ───── ⑦ 服务层：落盘 / 立即重建 / 夹取 / 提示 ───── */
  {
    name: "30 service：`rebuild()` 不用全局参数建倒排（改完分词参数等于没改）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  state.index = buildIndex(state.pages, state.params.index);",
      "  state.index = buildIndex(state.pages);"),
  },
  {
    name: "31 service：改参数后**不重建**索引（新参数只对之后收录的页生效 ⇒ 同库两套口径）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  state.params = next;\n  saveParams();\n  rebuild();",
      "  state.params = next;\n  saveParams();"),
  },
  {
    name: "32 service：`loadParams` 不夹取（手改 `params.json` 塞 k1=1e9 ⇒ 打分 NaN/Infinity 且不报错）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "    return { index: clampIndexOptions(parsed?.index), body: clampBodyOptions(parsed?.body) };",
      "    return { index: (parsed?.index ?? DEFAULT_INDEX_OPTIONS) as IndexOptions, body: (parsed?.body ?? DEFAULT_BODY_OPTIONS) as BodyOptions };"),
  },
  {
    name: "33 service：`params.json` 写坏时**不记日志**（参数被静默重置，用户查不出原因）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "    pushLog(\"参数文件读不出来，已按默认参数启动\");",
      "    /* 变异：重置参数不记日志 */"),
  },
  {
    name: "34 service：`saveParams` 不落盘（重启后参数丢，且不报错）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  writeFileSync(state.paramsPath, JSON.stringify(state.params, null, 2), \"utf8\");",
      "  void state.paramsPath;"),
  },
  {
    name: "35 service：收录中**不拒绝**改参数（这批页用了哪套分词没人说得清）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  if (state.crawling) { return { ok: false, error: \"正在收录中，请等收录结束后再改参数\" }; }",
      "  if (false) { return { ok: false, error: \"正在收录中，请等收录结束后再改参数\" }; }"),
  },
  {
    name: "36 service：`clampNotice` 被绕过（被夹取了却一声不吭 —— 降级看不见）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  const notice = clampNotice(p.index ?? {}, p.body ?? {}, next);",
      "  const notice: string | undefined = undefined;"),
  },
  {
    name: "37 service：`clampNotice` 不跳过空值（每次都喊「已夹取」⇒ 提示变噪音，用户再也不看）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "    if (raw === undefined || raw === null || raw === \"\") { continue; }",
      "    if (false) { continue; }"),
  },
  {
    name: "38 service：`/status` 不回带 `params`（页面看到的事实与 IPC 看到的不是同一份）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "    sites: searchIndexSites(),\n    params: getSearchIndexParams(),\n  };",
      "    sites: searchIndexSites(),\n  };"),
  },
  {
    name: "39 service：启动时不载入 `params.json`（每次开机都回默认）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  state.params = loadParams(paramsPath);", "  void loadParams(paramsPath);"),
  },
  {
    name: "40 service：`params.json` 路径漂（落盘与读取不是同一个文件 ⇒ 写了白写）",
    file: F_SERVICE,
    mutate: (t) => sub(t, "  return { dir, pages: join(dir, \"pages.json\"), params: join(dir, \"params.json\") };",
      "  return { dir, pages: join(dir, \"pages.json\"), params: join(dir, \"param.json\") };"),
  },
  {
    name: "41 service：正文参数**没接到收录里**（两个框能填能存，收录时完全不生效）",
    file: F_SERVICE,
    mutate: (t) => sub(t,
      "        minBodyChars: state.params.body.minBodyChars,\n        maxBodyChars: state.params.body.maxBodyChars,",
      "        /* 变异：不收正文参数 */"),
  },
  {
    name: "42 service：写参数那条 IPC **删掉授权判据**（任何页面都能改整个索引的行为）",
    file: F_SERVICE,
    mutate: (t) => sub(t,
      "  ipcMain.handle(IPC_CHANNELS.search_index_params_set, (event, p: unknown) => {\n    if (!trusted(event)) { return { ok: false, error: \"未授权来源：只有主窗口可以控制索引服务\" }; }",
      "  ipcMain.handle(IPC_CHANNELS.search_index_params_set, (event, p: unknown) => {"),
  },
  {
    name: "43 service：授权文案漂（七条判据有了一条不一样 ⇒ 「每条单独把关」不再成立）",
    file: F_SERVICE,
    mutate: (t) => sub(t,
      "  ipcMain.handle(IPC_CHANNELS.search_index_start, async (event) => {\n    if (!trusted(event)) { return { ok: false, error: \"未授权来源：只有主窗口可以控制索引服务\" }; }",
      "  ipcMain.handle(IPC_CHANNELS.search_index_start, async (event) => {\n    if (!trusted(event)) { return { ok: false, error: \"未授权来源\" }; }"),
  },

  /* ───── ⑧ 接线：ipc 常量 / preload / 面板 ───── */
  {
    name: "44 ipc：`search_index_params_get` 通道名漂（与 preload 对不上 ⇒ 调用永远挂空）",
    file: F_IPC,
    mutate: (t) => sub(t, "  search_index_params_get: \"slime:search:indexParamsGet\",",
      "  search_index_params_get: \"slime:search:indexParamGet\","),
  },
  {
    name: "45 ipc：`search_index_params_set` 通道名漂",
    file: F_IPC,
    mutate: (t) => sub(t, "  search_index_params_set: \"slime:search:indexParamsSet\",",
      "  search_index_params_set: \"slime:search:indexParamSet\","),
  },
  {
    name: "46 preload：写参数那条通道名漂（主进程收不到）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, "      ipcRenderer.invoke(\"slime:search:indexParamsSet\", p) as Promise<{ ok: boolean; pages?: number; terms?: number; notice?: string; error?: string }>,",
      "      ipcRenderer.invoke(\"slime:search:indexParamSet\", p) as Promise<{ ok: boolean; pages?: number; terms?: number; notice?: string; error?: string }>,"),
  },
  {
    name: "47 panel：**保存串到别的桥**（点「保存参数」实际去读了一次参数）",
    file: F_PANEL,
    /* ⚠️ A-1143 起按钮文案微调（近似检索那组参数**不需要**重建索引）⇒ 旧文案锚点已漂，重锚。 */
    mutate: (t) => sub(t, "    await call((api) => api.indexParamsSet(formToPayload(form)), \"参数已保存（分词/打分类参数已重建索引）\");",
      "    await call((api) => api.indexParamsGet(), \"参数已保存（分词/打分类参数已重建索引）\");"),
  },
  {
    name: "48 panel：保存完**不把生效值拉回来**（被夹取后的值和界面显示的不是一回事）",
    file: F_PANEL,
    mutate: (t) => sub(t, "    setDirty(false);\n    await refresh();\n  }, [form, call, refresh]);",
      "    setDirty(false);\n  }, [form, call, refresh]);"),
  },
  {
    name: "49 panel：`notice` 被成功文案盖掉（填了 999 被夹到 8 而界面上没有任何痕迹）",
    file: F_PANEL,
    mutate: (t) => sub(t, "      setNotice({ ok: true, text: r.notice ? `${okText}（${r.notice}）` : okText });",
      "      setNotice({ ok: true, text: okText });"),
  },
  {
    name: "50 panel：参数输入框改回 `type=\"number\"`（渲染层开始偷偷做判据：空输入变 0/NaN）",
    file: F_PANEL,
    mutate: (t) => sub(t, "      <input className=\"input-field\" type=\"text\" inputMode=\"decimal\" value={value} disabled={disabled}",
      "      <input className=\"input-field\" type=\"number\" value={value} disabled={disabled}"),
  },
  {
    name: "51 panel：两组参数的区别没写清楚（用户以为「改完只影响下次收录」）",
    file: F_PANEL,
    mutate: (t) => sub(t, "属于<b>这个索引</b>", "属于<b>这个面板</b>"),
  },
  {
    name: "52 panel：正文参数的作用面没写清楚（「只影响之后新收录的页面」被抹掉）",
    file: F_PANEL,
    mutate: (t) => sub(t, "只影响之后新收录的页面", "只影响之后的收录"),
  },
];

/* ---------------- 以下与 mut-a1138-search-index.mjs 同构（同一套校准逻辑） ---------------- */
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1140")) { process.exit(1); }
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
