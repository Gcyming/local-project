#!/usr/bin/env node
/**
 * gui/scripts/mut-a1137-search-bridge.mjs — A-1137（搜索页接入右栏浏览器 + 对话侧实时监测）的变异验证。
 *
 * ## 为什么要这组变异
 * A-1137 的证据来自**真机端到端**（`gui/scripts/probe-search-host.mjs` 14/14，真 Electron + 真 preload）。
 * 但"跑通一次"不是保护。下列每一条都对应一个**用户看得见、却不会报错**的失效：
 *   1  guest preload 的外网白名单放宽 ⇒ **任何站点都能拿到 SlimeBrowserHost**（把本机当代理、
 *      并能伪造"右栏打开了 X"污染对话侧）
 *   2  `file:`/`about:` 不再放行 ⇒ 用户双击搜索页、或 webview 初始 blank 态拿到的是**未接入**的页面
 *   3  去掉 `CH &&` 门 ⇒ preload 在**没注入 channel**时也 expose，三个方法一调就炸
 *   4  `LOCAL_HOSTS` 少了 `[::1]` ⇒ IPv6 回环上的搜索页静默未接入（`location.hostname` 是 `[::1]`）
 *   5  channel 被硬编码 ⇒ 源里多了一个"第二产地"（改 `shared/ipc.ts` 时必漏）
 *   6  引入第二个 `require` ⇒ sandbox preload 运行期直接炸
 *   7  未知事件类型不再返回 null ⇒ 对话侧**显示一个右栏并没有的状态**
 *   8  `page` 不再沿用条数 ⇒ 翻页后状态条的"命中 N 条"突然变 0
 *   9  mode 判据放宽 ⇒ 任何非空值都被当"联网"（包括将来页面加的模式）
 *  10  `index` 不清空检索词 ⇒ 建完索引后状态条还挂着上一次的检索词
 *  11  error 缺文案不兜底 ⇒ 状态条显示一个**空错误**
 *  12  字符串不截断 ⇒ 一条畸形事件能把状态条撑爆
 *  13  `count` 不校验类型 ⇒ 页面传字符串时状态条显示得莫名其妙
 *  14  `titles` 上限放开 ⇒ 一条事件把整页结果塞进对话侧上下文
 *  15  离开搜索页不清零 ⇒ 切到别的站点后状态条还在说"正在搜 xxx"（**把历史当现状**）
 *  16  "在不在搜索页"不看 URL ⇒ 任何浏览器页都被当成搜索页
 *  17  `applySearchView(null)` 也 emit ⇒ 一次空推送把状态条洗成"搜索页，没有内容"
 *  18  白名单漏掉 `file` ⇒ 文件页彻底失联（右栏那一类页签不再对 Agent 可见）
 *  19  搜索页分支丢掉 error ⇒ Agent 基于一个**已经不工作的**右栏作答
 *  20  搜索页分支丢掉结果标题 ⇒ Agent 只能反问"你搜到什么了"
 *  21  非搜索页签 label 丢掉位置 ⇒ Agent 不知道用户在看哪个文件
 *  22  页签类型中文名漂了 ⇒ 同一件事实两个产地
 *  23  失败也缓存交付信息 ⇒ **一次抖动 = 永久打不开**（本仓反复踩的坑）
 *  24  `search_host_info` 改用 guest 判据 ⇒ **dev 下渲染层被误拒**（用户："搜索页根本打不开"，且无报错）
 *  25  `search_view_get` 改用 guest 判据 ⇒ 补课失效 ⇒ 状态条永远空白（"错过一次就永久瞎"）
 *  26  `search_query` 改用主窗口判据 ⇒ 真正干活的那条通道被拒
 *  27  落盘不再幂等 ⇒ 每次交付都重写文件、抖 mtime
 *  28  origin 白名单恒为真 ⇒ 外网站点被当成搜索页（安全性白名单形同虚设）
 *  29  空 URL 也被判可信 ⇒ "拿不到 frame URL"变成放行
 *  30  guest 事件不判 frame ⇒ 任何站点都能伪造右栏状态
 *  31  取主题不判 frame ⇒ 外网站点能读到主程序主题
 *  32  未知事件也更新最近视图 ⇒ 广播 null 给渲染层
 *  33  channel 注入被省掉 ⇒ 落盘的 preload 没有 CH ⇒ 页面永远"未接入"
 *  34  `APP_THEMES` 少了 beta ⇒ 与 renderer 的 `ThemeName` 漂了（**不报错**，搜索页永远 dark）
 *  35  兜底主题被改成非 dark ⇒ 未知主题时给一个"页面认不出"的值
 *  36  映射查不到时返回 undefined ⇒ 搜索页拿到 undefined
 *  37  验证码检测不剥脚本/样式 ⇒ 只看脚本文件名就报"要人机验证"
 *  38  Bing 解析不截断 ⇒ 一次塞进远超 maxResults 的条目
 *  39  空结果不再给 `[无搜索结果]` ⇒ Agent 收到空串，分不清"没搜到"与"工具坏了"
 *  40  source 不去 www ⇒ 同一站点两种写法（`www.` 前缀）
 *  41  百度摘要不再抽取 ⇒ 条目只剩标题，Agent 少了判断依据
 *  42  百度空链接不再跳过 ⇒ 产出一个点不开的条目
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环逐条：
 *   for i in $(seq 1 42); do node gui/scripts/mut-a1137-search-bridge.mjs --apply $i
 *     && node <vitest.mjs> run --config vitest.config.ts tests/gui/a1137-search-bridge.spec.ts --reporter=dot;
 *     node gui/scripts/mut-a1137-search-bridge.mjs --restore; done
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行。
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
const SPECS = ["tests/gui/a1137-search-bridge.spec.ts"];

const F_PRELOAD = "gui/src/preload/searchHost.cjs";
const F_VIEW = "gui/src/shared/searchView.ts";
const F_THEME = "gui/src/shared/searchTheme.ts";
const F_SIDEBAR = "gui/src/renderer/pages/sidebarSearch.ts";
const F_BRIDGE = "gui/src/main/searchBridge.ts";
const F_SEARCH = "core-ts/src/search/onlineSearch.ts";

const TARGETS = [F_PRELOAD, F_VIEW, F_THEME, F_SIDEBAR, F_BRIDGE, F_SEARCH];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1137");

const MUTATIONS = [
  /* ───── guest preload（不受任何静态检查 ⇒ 只能靠真跑 + 源码纪律） ───── */
  {
    name: "1 searchHost：外网白名单放宽（任何站点都能拿到 SlimeBrowserHost）",
    file: F_PRELOAD,
    mutate: (t) => sub(t,
      '    if (proto === "http:" || proto === "https:") { return !!LOCAL_HOSTS[location.hostname]; }',
      '    if (proto === "http:" || proto === "https:") { return true; }'),
  },
  {
    name: "2 searchHost：本地文件协议不再放行（双击页面 / webview blank 态变成未接入）",
    file: F_PRELOAD,
    /* ⚠️ 锚点故意只取那句的**函数体**：整句里含协议字面量，会被 `check-mut-anchors.mjs`
       的 `file:` 字段扫描误当成目标路径（实测它会报「目标文件不存在：/」）。 */
    mutate: (t) => sub(t, "{ return true; }", "{ return false; }"),
  },
  {
    name: "3 searchHost：去掉 `CH &&` 门（没注入 channel 也暴露桥）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, "if (CH && isLocalDocument()) {", "if (isLocalDocument()) {"),
  },
  {
    name: "4 searchHost：`LOCAL_HOSTS` 少了 `[::1]`（IPv6 回环静默未接入）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, 'var LOCAL_HOSTS = { "127.0.0.1": 1, localhost: 1, "::1": 1, "[::1]": 1 };',
      'var LOCAL_HOSTS = { "127.0.0.1": 1, localhost: 1, "::1": 1 };'),
  },
  {
    name: "5 searchHost：channel 被硬编码（`shared/ipc.ts` 之外多一个产地）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, "return ipcRenderer.invoke(CH.search_query, { query: String(q == null ? \"\" : q) });",
      'return ipcRenderer.invoke("slime:search:query", { query: String(q == null ? "" : q) });'),
  },
  {
    name: "6 searchHost：引入第二个 require（sandbox preload 运行期炸）",
    file: F_PRELOAD,
    mutate: (t) => sub(t, 'var electron = require("electron");',
      'var electron = require("electron");\nvar os = require("node:os");'),
  },

  /* ───── 页面事件 → 视图（唯一翻译器） ───── */
  {
    name: "7 searchView：未知事件类型不再返回 null（对话侧显示一个右栏并没有的状态）",
    file: F_VIEW,
    mutate: (t) => sub(t, "    default:\n      return null;", "    default:\n      return base();"),
  },
  {
    name: "8 searchView：`page` 不再沿用条数（翻页后「命中 N 条」突然变 0）",
    file: F_VIEW,
    mutate: (t) => sub(t, "      if (typeof e.page === \"number\") { v.titles = []; v.count = prev?.count ?? 0; }",
      "      if (typeof e.page === \"number\") { v.titles = []; v.count = 0; }"),
  },
  {
    name: "9 searchView：mode 判据放宽（任何非空值都算联网）",
    file: F_VIEW,
    /* ⚠️ 锚点随 v3.2.0 契约同步过：原来只认 `online`，现在 `online` 与 `web` 都算联网。
       改源码形状必须同步锚点（否则这条静默未命中 = 守卫哑掉）。 */
    mutate: (t) => sub(t, 'const mode: SearchPageMode = e.mode === "online" || e.mode === "web" ? "online" : "local";',
      'const mode: SearchPageMode = e.mode ? "online" : "local";'),
  },
  {
    name: "10 searchView：`index` 不清空检索词（建完索引还挂着上一次的检索词）",
    file: F_VIEW,
    mutate: (t) => sub(t, '    case "index": {\n      const v = base();\n      v.query = "";',
      '    case "index": {\n      const v = base();'),
  },
  {
    name: "11 searchView：error 缺文案不兜底（状态条显示一个空错误）",
    file: F_VIEW,
    mutate: (t) => sub(t, 'v.error = asStr(e.error, 400) || "联网检索失败";', "v.error = asStr(e.error, 400);"),
  },
  {
    name: "12 searchView：字符串不截断（一条畸形事件撑爆状态条）",
    file: F_VIEW,
    mutate: (t) => sub(t, 'return typeof v === "string" ? v.slice(0, max) : "";', 'return typeof v === "string" ? v : "";'),
  },
  {
    name: "13 searchView：count 不校验类型（页面传字符串时状态条莫名其妙）",
    file: F_VIEW,
    mutate: (t) => sub(t, "count: typeof e.count === \"number\" ? e.count : titles.length,",
      "count: Number(e.count ?? titles.length),"),
  },
  {
    name: "14 searchView：titles 上限放开（一条事件把整页结果塞进对话侧上下文）",
    file: F_VIEW,
    mutate: (t) => sub(t, "for (const it of items.slice(0, 8)) {", "for (const it of items.slice(0, 80)) {"),
  },

  /* ───── 右栏视图 store（渲染层） ───── */
  {
    name: "15 sidebarSearch：离开搜索页不清零（把历史当现状）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "emit({ tab, search: onSearch ? snapshot.search : null });", "emit({ tab, search: snapshot.search });"),
  },
  {
    name: "16 sidebarSearch：「在不在搜索页」不看 URL（任何浏览器页都被当成搜索页）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "const onSearch = tab.kind === \"browser\" && !!searchUrl && tab.url === searchUrl;",
      'const onSearch = tab.kind === "browser";'),
  },
  {
    name: "17 sidebarSearch：applySearchView(null) 也 emit（一次空推送把状态条洗掉）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "export function applySearchView(v: SidebarSearchView | null): void {\n  if (!v) { return; }",
      "export function applySearchView(v: SidebarSearchView | null): void {"),
  },
  {
    name: "18 sidebarSearch：白名单漏掉 `file`（文件页不再播报 ⇒ Agent 不知道用户在看哪个文件）",
    file: F_SIDEBAR,
    /* ⚠️ A-1144 起"哪些页签值得播报"改由 `MOUNTABLE_KINDS` 白名单决定（`none` 与内部面板
       `tasks`/`git` 一律不出文案）。旧锚点（`s.tab.kind === "none"` 那种写法）已随之消失。
       ⇒ 改锚白名单本身：**漏一个内容类页签**同样会让对应那一类彻底失联（本条守 `file`）。 */
    mutate: (t) => sub(t, 'new Set(["browser", "file", "terminal"]);', 'new Set(["browser", "terminal"]);'),
  },
  {
    name: "19 sidebarSearch：搜索页分支丢掉 error（Agent 基于一个已经不工作的右栏作答）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "    if (srch.error) { extra.push(`注意：右栏刚报过错 —— ${srch.error}`); }", ""),
  },
  {
    name: "20 sidebarSearch：搜索页分支丢掉结果标题（Agent 只能反问「你搜到什么了」）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "    if (srch.titles.length > 0) {", "    if (false) {"),
  },
  {
    name: "21 sidebarSearch：非搜索页签 label 丢掉位置（Agent 不知道用户在看哪个文件）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, 'label: `${kindLabel}${loc ? " · " + loc : ""}`,', "label: kindLabel,"),
  },
  {
    name: "22 sidebarSearch：页签类型中文名漂了（同一件事实两个产地）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, '  terminal: "终端",', '  terminal: "控制台",'),
  },
  {
    name: "23 sidebarSearch：失败也缓存交付信息（一次抖动 = 永久打不开）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, "  deliverPromise = p.then((d) => {\n    if (d.error) { deliverPromise = null; }   // 失败不留缓存 ⇒ 下次重试\n    return d;\n  });",
      "  deliverPromise = p.then((d) => {\n    return d;\n  });"),
  },

  /* ───── 主进程桥：两类 sender 两套白名单 ───── */
  {
    name: "24 searchBridge：`search_host_info` 改用 guest 判据（dev 下渲染层被误拒，且无报错）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, '    if (!isTrustedMainSender(event, deps)) {\n      return { ok: false, error: "未授权来源：只有主窗口可以索取搜索页信息" };',
      '    if (!isTrustedSearchFrame(event)) {\n      return { ok: false, error: "未授权来源：只有主窗口可以索取搜索页信息" };'),
  },
  {
    name: "25 searchBridge：`search_view_get` 改用 guest 判据（补课失效 ⇒ 状态条永远空白）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, "    if (!isTrustedMainSender(event, deps)) { return null; }",
      "    if (!isTrustedSearchFrame(event)) { return null; }"),
  },
  {
    name: "26 searchBridge：`search_query` 改用主窗口判据（真正干活的那条通道被拒）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, '    if (!isTrustedSearchFrame(event)) {\n      return { ok: false, error: "未授权来源：只接受本机搜索页发起的检索" };',
      '    if (!isTrustedMainSender(event, deps)) {\n      return { ok: false, error: "未授权来源：只接受本机搜索页发起的检索" };'),
  },
  {
    name: "27 searchBridge：落盘不再幂等（每次交付都重写、抖 mtime）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, 'if (existsSync(file) && readFileSync(file, "utf8") === content) { return false; }',
      "if (false) { return false; }"),
  },
  {
    name: "28 searchBridge：origin 白名单恒为真（外网站点被当成搜索页）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, "    return ALLOWED_ORIGINS.has(new URL(u).origin);", "    return true;"),
  },
  {
    name: "29 searchBridge：空 URL 也被判可信（拿不到 frame URL 变成放行）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, "  if (!u) { return false; }", "  if (!u) { return true; }"),
  },
  {
    name: "30 searchBridge：guest 事件不判 frame（任何站点都能伪造右栏状态）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, "    if (!isTrustedSearchFrame(event)) { return; }\n    const view = viewFromPageEvent(evt, ++viewSeq, lastView);",
      "    const view = viewFromPageEvent(evt, ++viewSeq, lastView);"),
  },
  {
    name: "31 searchBridge：取主题不判 frame（外网站点能读到主程序主题）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, '    if (!isTrustedSearchFrame(event)) { return "dark"; }', ""),
  },
  {
    name: "32 searchBridge：未知事件也更新最近视图（广播 null 给渲染层）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, "    const view = viewFromPageEvent(evt, ++viewSeq, lastView);\n    if (!view) { return; }",
      "    const view = viewFromPageEvent(evt, ++viewSeq, lastView);"),
  },
  {
    name: "33 searchBridge：channel 注入被省掉（落盘的 preload 没有 CH ⇒ 永远未接入）",
    file: F_BRIDGE,
    mutate: (t) => sub(t, "  const src = searchHostPreloadSource.split(CHANNEL_PLACEHOLDER).join(JSON.stringify(IPC_CHANNELS));",
      "  const src = searchHostPreloadSource;"),
  },

  /* ───── 主题映射（两边漂了不会报错） ───── */
  {
    name: "34 searchTheme：`APP_THEMES` 少了 beta（与 renderer 的 ThemeName 漂了）",
    file: F_THEME,
    mutate: (t) => sub(t, 'export const APP_THEMES: readonly AppThemeName[] = ["alpha", "beta"] as const;',
      'export const APP_THEMES: readonly AppThemeName[] = ["alpha"] as const;'),
  },
  {
    name: "35 searchTheme：兜底主题被改成非 dark（未知主题时给页面认不出的值）",
    file: F_THEME,
    mutate: (t) => sub(t, 'export const SEARCH_THEME_FALLBACK: SearchThemeName = "dark";',
      'export const SEARCH_THEME_FALLBACK: SearchThemeName = "light";'),
  },
  {
    name: "36 searchTheme：映射查不到时返回 undefined",
    file: F_THEME,
    mutate: (t) => sub(t, "  return mapped ?? SEARCH_THEME_FALLBACK;", "  return mapped;"),
  },

  /* ───── 联网检索（解析层） ───── */
  {
    name: "37 onlineSearch：验证码检测不剥脚本/样式（只看脚本文件名就报要人机验证）",
    file: F_SEARCH,
    mutate: (t) => sub(t,
      '  const text = html\n    .replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, " ")\n    .replace(/<style\\b[^>]*>[\\s\\S]*?<\\/style>/gi, " ")\n    .replace(/<[^>]+>/g, " ")\n    .toLowerCase();',
      "  const text = html.toLowerCase();"),
  },
  {
    name: "38 onlineSearch：Bing 解析不截断（一次塞进远超 maxResults 的条目）",
    file: F_SEARCH,
    mutate: (t) => sub(t, "while ((m = liRe.exec(html)) !== null && items.length < maxResults) {",
      "while ((m = liRe.exec(html)) !== null) {"),
  },
  {
    name: "39 onlineSearch：空结果不再给 `[无搜索结果]`（Agent 分不清没搜到与工具坏了）",
    file: F_SEARCH,
    mutate: (t) => sub(t, "  if (!items.length) { return EMPTY_MSG; }", '  if (!items.length) { return ""; }'),
  },
  {
    name: "40 onlineSearch：source 不去 www（同一站点两种写法）",
    file: F_SEARCH,
    mutate: (t) => sub(t, 'try { return new URL(url).hostname.replace(/^www\\./, ""); } catch { return ""; }',
      'try { return new URL(url).hostname; } catch { return ""; }'),
  },
  {
    name: "41 onlineSearch：百度摘要不再抽取（条目只剩标题）",
    file: F_SEARCH,
    mutate: (t) => sub(t, 'const snippet = descMatch ? stripTags(descMatch[1]).slice(0, 200) : "";',
      'const snippet = "";'),
  },
  {
    name: "42 onlineSearch：百度空链接不再跳过（产出一个点不开的条目）",
    file: F_SEARCH,
    mutate: (t) => sub(t, "    if (!title || !link) { continue; }", "    if (!title) { continue; }"),
  },
  {
    /* v3.2.0 契约漂移的真回归：原「联网 / 全网」两模式合并成「全网」后，
       走自建索引服务上报的是 `mode:'web'`、切模式事件是 `state.mode === 'web'`；
       只认 `online` ⇒ 整个「全网」模式被对话侧显示成「本地索引」（不报错，静默错）。 */
    name: "43 searchView：mode 只认 `online`（v3.2.0 的「全网」= `web` ⇒ 被显示成「本地索引」）",
    file: F_VIEW,
    mutate: (t) => sub(t, 'const mode: SearchPageMode = e.mode === "online" || e.mode === "web" ? "online" : "local";',
      'const mode: SearchPageMode = e.mode === "online" ? "online" : "local";'),
  },
];

/* ---------------- 以下与 mut-a1136-render.mjs 同构（同一套校准逻辑） ---------------- */
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
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpec();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); console.error(base.out); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1137")) { process.exit(1); }
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
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
