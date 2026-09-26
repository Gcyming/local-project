#!/usr/bin/env node
/**
 * gui/scripts/mut-a1106.mjs — A-1106 守卫的变异验证。
 *
 * 本轮修四处「**过 tsc、过构建、过所有既有逻辑测试，只在用户眼里翻车**」的缺陷：
 *
 * | # | 缺陷（用户看到什么） | 修复的产地 |
 * |---|---|---|
 * | ① | **MCP 广场打开几秒后自己变样**：打开就联网拉 registry，网络一返回把内置精选整个替换掉 | `McpPanel.tsx` / `marketView.ts` |
 * | ② | **RPM 限流器在生产链路里一次都没被调用**（`clientFactory` 另抄一份、漏 `rateLimit`） | `router.createRouteClient` / `gui/src/main/index.ts` |
 * | ③ | **压缩只可能发生一次**（`noRoomToCut` 拿折叠视图判 ⇒ 恒真）⇒ 二次压缩之间的轮次从不进摘要 | `gui/src/main/index.ts` |
 * | ④ | **降幅不足的假压缩永不熔断** + **摘要被输出上限腰斩却当完整摘要写入**（静默丢记忆） | `index.ts` / `engine.ts` / `context_compress.ts` |
 *
 * ## 覆盖的条目
 *
 *   1~2   广场数据源判据退化（打开即接管 / 搜到 0 条也接管）
 *   3~4   判据内联回组件 / 打开广场恢复自动联网
 *   5      `createRouteClient` 丢掉 `rateLimit`（限流器重新变成死代码）
 *   6~7   生产工厂自建 client / router 缺省工厂退化
 *   8      `rateLimit` 丢掉 `model`（降级换模型后按旧模型档位限流）
 *   9~12  压缩判据退回复折叠视图（`noRoomToCut` / 摘要素材 / 指纹 / 触发判据）
 *   13~15 熔断去掉 `realShrink` / `realShrink` 被绕过 / 摘要轮不再读全量
 *   16~18 输出上限去掉下界 / 去掉上界 / 压缩比被压小
 *   19    摘要轮写死 `max_tokens: 1024`（腰斩的直接产地）
 *   20~21 不再检查 `finish_reason` / 截断后不再重试
 *   22~24 `truncated` 不传导 / `elided`+截断不出声 / IPC 契约字段被删
 *   25~30 中文化判据退化（词典被绕过 / 未收录不标记 / 单字键 / 词数上限 / 编造标签 / 标签上限）
 *   31~33 main 绕过检索词展开 / 不回带 appliedQuery / registry 恢复本地二次过滤
 *   34~36 registry 不产标签 / 标签不渲染 / IPC 契约字段被删
 *   37~38 「轮」口径退化（countTurns 退成数消息条数 / main 触发判据回填 `.length`）
 *   39~42 委派规范退化（chat 回填内联副本 / engine 不带 / 措辞退回「先想能不能拆」/ 删掉四类例外）
 *   43~45 RPM 等待退化（onWait 改到 sleep 之后 / onWait 被忽略 / client 不传回调）
 *   46    渲染层回填硬编码 0.85（压缩比率出现第二产地）
 *   47~80 第二轮：子代理派发四条成因 + 技能广场 + 委派规范单产地（见各条 name）
 *   81~113 **第三轮：六项 UI / 机制**（扫光 / 时间轴光点几何 / 状态行字号 /
 *          分隔条命中区与聚光 / 吐字渐入闸门 / 产物卡横向过渡）——
 *          守卫住在 `tests/gui/a1106-ui-guards.spec.ts`
 *          （94~101 = **A-1106 续轮：分隔条聚光形状重做** —— 椭圆光斑 →
 *            父级 `border-image` 的沿轴聚光渐变；含 slice 方向 / 峰值色 / 斜坡半长 /
 *            变量宿主四类退化）
 *   114~118 **A-1111：命中区跨过分隔线**（裁剪放宽量 / 退回 hidden / 只朝内侧 ×2 /
 *          跨了但不居中）—— 守卫是同文件的 ①②。
 *          ⚠️ 这 5 条**必须**排在 113 之后（A-1117 更正：它们曾被插在 75 与 76 之间，
 *          `--apply N` 因此指向别的条目 ⇒ 核验时会得到假绿；判据见文件末那段）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 多行锚点一律走 `sub`（行尾无关），不要自己写裸 `\n` 拼接。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1106.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1106.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1106.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1106.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1106-guards.spec.ts",
  "tests/core-ts/a1106-market-cn.spec.ts",
  "tests/core-ts/a1106-loop-fixes.spec.ts",
  /* A-1106 续（第二轮）：子代理派发两条残留 + 技能广场（MCP 广场同款缺陷） */
  "tests/core-ts/a1106-subagent-dispatch.spec.ts",
  "tests/core-ts/a1106-skills-square.spec.ts",
  /* ⚠️ A-1106 实测补上（变异 63 逃逸的真因）：第 63 条锁的是 `resolveRpm` 的四层取值，
     而它的守卫住在 a1091 / a1092 这两份 spec 里 —— 此前 **SPECS 没包含它们** ⇒
     这条变异**从未被真正测量过**（报「未捕获」其实是「没人测」）。
     **判据：SPECS 必须覆盖该脚本每一条变异的目标守卫所在的那份 spec。** */
  "tests/core-ts/a1091-rpm.spec.ts",
  "tests/core-ts/a1092-guards.spec.ts",
  /* ⚠️ 同理补上（第 75 条的守卫住在这里）：本脚本第 47~52 条改的就是「可派发清单登记」那段代码，
     而 a1096 那份 spec 里**也有一道守卫**锁它的产地下落与唯一性 ⇒ 必须一起跑，
     否则「迁移后的守卫还活着吗」这件事没人核验。 */
  "tests/core-ts/a1096-subagent-dispatch.spec.ts",
  /* ⚠️ A-1106 第二轮（六项 UI/机制）：守卫住在 gui 侧那份 spec 里 —— 同样必须挂上，
     否则第 81~113 条变异**从未被真正测量过**（报「未捕获」其实是「没人测」）。 */
  "tests/gui/a1106-ui-guards.spec.ts",
];

const F_MARKET = "gui/src/renderer/pages/marketView.ts";
const F_MCP = "gui/src/renderer/pages/McpPanel.tsx";
const F_ROUTER = "core-ts/src/router.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_COMPRESS = "core-ts/src/services/context_compress.ts";
const F_ENGINE = "core-ts/src/services/engine.ts";
const F_IPC = "gui/src/shared/ipc.ts";
/* A-1106 续（中文化）：唯一判据出处 + 上游检索词构造点 + 渲染层接线 */
const F_LOCALIZE = "core-ts/src/services/marketLocalize.ts";
const F_CFG = "gui/src/main/config_files.ts";
const F_PRELOAD = "gui/src/preload/index.ts";
/* A-1106 续（loop 检查）：轮口径 / 委派规范唯一出处 / RPM 先上报再睡 */
const F_LOOP = "core-ts/src/services/context_loop.ts";
const F_CATALOG = "core-ts/src/services/subagentCatalog.ts";
const F_CHAT = "core-ts/src/services/chat.ts";
const F_RPMLIM = "core-ts/src/llm/rpmLimiter.ts";
const F_CLIENT = "core-ts/src/llm/client.ts";
/* A-1106 续（压缩比率唯一出处） */
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
/* A-1106 续（第二轮）：子代理派发的两条残留 + 技能广场 */
const F_SUB = "core-ts/src/services/subagent.ts";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const F_SKILLS = "gui/src/renderer/pages/SkillsPanel.tsx";
/* A-1106：`_signal` 的**注入点**住在工具循环（`tool_loop.ts`），不在上下文循环
   （`context_loop.ts`）。两者名字像、职责不像：前者执行工具调用，后者管轮次/压缩。 */
const F_TOOLLOOP = "core-ts/src/tool_loop.ts";
/* A-1106 第二轮（六项 UI/机制）：样式 / 光流位置模块 / 两栏宿主 / 产物宿主也在面板里 */
const F_CSS = "gui/src/renderer/index.css";
const F_GLINT = "gui/src/renderer/resizerGlint.ts";
const F_APP = "gui/src/renderer/App.tsx";
const F_RSB = "gui/src/renderer/pages/RightSidebar.tsx";
const TARGETS = [F_MARKET, F_MCP, F_ROUTER, F_MAIN, F_COMPRESS, F_ENGINE, F_IPC, F_LOCALIZE, F_CFG, F_PRELOAD,
  F_LOOP, F_CATALOG, F_CHAT, F_RPMLIM, F_CLIENT, F_PANEL, F_SUB, F_BUILTIN, F_SKILLS, F_TOOLLOOP,
  F_CSS, F_GLINT, F_APP, F_RSB];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1106");

/**
 * A-1106：判据的**唯一出处**那一行（`marketView.onlineSourceActive`）—— 变 1/2 共用。
 *
 * ⚠️ 锚点会随实现漂移：`marketSource` 改成复用 `onlineSourceActive` 之后，
 * 旧锚点（`return registryQuery.trim() !== "" && registryCount > 0 ? …`）**已不存在**——
 * 若不迁移，两条变异会一起报「锚点未命中」，而那**不是**"守住了"，是"没人守"。
 */
const ONLINE_LINE = "  return requested && onlineCount > 0;";
/** 限流身份那一行 —— 变 5 与变 8 共用 */
const RATE_LINE = "    rateLimit: { key: providerKeyOfRoute(route), model: route.model },";

const MUTATIONS = [
  /* ── ① MCP 广场「归谁」────────────────────────────────────────────── */
  {
    name: "1 判据不再要求「用户主动请求」（打开广场就被 registry 接管 —— 用户报的症状本体）",
    file: F_MARKET,
    mutate: (t) => sub(t, ONLINE_LINE, "  return onlineCount > 0;"),
  },
  {
    name: "2 判据不再要求「条数 > 0」（搜到 0 条/拉回 0 条也接管 ⇒ 合法的空结果被渲染成空列表）",
    file: F_MARKET,
    mutate: (t) => sub(t, ONLINE_LINE, "  return requested;"),
  },
  {
    name: "3 判据内联回组件（两个产地 = 改一处漏一处）",
    file: F_MCP,
    mutate: (t) => sub(
      t,
      '        const useRegistry = marketSource(registryQuery, registryServers?.length ?? 0) === "registry";',
      '        const useRegistry = registryQuery.trim() !== "" && registryServers !== null && registryServers.length > 0;',
    ),
  },
  {
    name: "4 打开广场恢复自动联网（网络一返回就把内置精选无声替换掉）",
    file: F_MCP,
    mutate: (t) => sub(
      t,
      "    if (marketOpen) { setShowAll(false); }",
      "    if (marketOpen) { void loadRegistry(); setShowAll(false); }",
    ),
  },

  /* ── ② RPM 接线（限流器重新变成死代码）────────────────────────────── */
  {
    name: "5 createRouteClient 丢掉 rateLimit（限流器在生产链路里一次都不执行）",
    file: F_ROUTER,
    /* 锚点写成**完整字面量**（不用 `${RATE_LINE}` 拼接）：`check-mut-anchors.mjs` 只认
       `sub(t, "…", "…")` 形态，拼接式会被判「未核验」—— 而「未核验 = 没人核验 = 没有保护」。
       末尾带 `\n` ⇒ 连行尾一起删掉（`sub` 的多行分支用 `\r?\n`，CRLF 文件同样命中）。 */
    mutate: (t) => sub(t, "    rateLimit: { key: providerKeyOfRoute(route), model: route.model },\n", ""),
  },
  {
    name: "6 生产工厂自建 client（另抄一份 = 迟早再漏一次 rateLimit）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "clientFactory: (route: RouteEntry) => createRouteClient(route, chromiumFetch as typeof fetch),",
      "clientFactory: (route: RouteEntry) => new ChatClient({ baseUrl: route.baseUrl, apiKey: route.apiKey, fetchImpl: chromiumFetch as typeof fetch }),",
    ),
  },
  {
    name: "7 router 缺省工厂退化（不传 factory 的调用方失去限流）",
    file: F_ROUTER,
    mutate: (t) => sub(
      t,
      "this.createClient = createClientFn ?? createRouteClient;",
      "this.createClient = createClientFn ?? ((r: RouteEntry) => new ChatClient({ baseUrl: r.baseUrl, apiKey: r.apiKey }));",
    ),
  },
  {
    name: "8 限流身份丢掉 model（降级换模型后仍按旧模型档位限流 —— A-1071 同型缺陷）",
    file: F_ROUTER,
    mutate: (t) => sub(
      t,
      RATE_LINE,
      "    rateLimit: { key: providerKeyOfRoute(route) } as never,",
    ),
  },

  /* ── ③ 压缩判据必须看「原始全量」────────────────────────────────── */
  {
    name: "9 noRoomToCut 用折叠视图判（恒真 ⇒ canShrink 恒假 ⇒ 压缩一辈子只发生一次）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "const noRoomToCut = historyAll.length <= DEFAULT_TAIL_KEEP * 2 + 2;",
      "const noRoomToCut = historyView.length <= DEFAULT_TAIL_KEEP * 2 + 2;",
    ),
  },
  {
    name: "10 摘要素材用折叠视图（两次压缩之间累积的轮次从不进入任何摘要）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "await engine.summarizeContext(agent, historyAll, { maxInputTokens: budget, priorSummary: meta.contextSummary })",
      "await engine.summarizeContext(agent, historyView, { maxInputTokens: budget, priorSummary: meta.contextSummary })",
    ),
  },
  {
    name: "11 历史指纹用折叠视图（熔断器按「折叠后相同」误判同一段历史）",
    file: F_MAIN,
    mutate: (t) => sub(t, "const key = historyFingerprint(historyAll);", "const key = historyFingerprint(historyView);"),
  },
  {
    name: "12 触发判据用折叠视图（阈值判据被折叠后的固定条数锁死）",
    file: F_MAIN,
    // A-1106 锚点迁移：第 4 个参数由 `historyAll.length` 改为 `countTurns(historyAll)`
    //（单位错配修复）。原意图「用折叠视图判触发」逐字保留，只换新的调用形态。
    mutate: (t) => sub(
      t,
      "ratioTriggered: needsCompress(used, cap, ratio, countTurns(historyAll)),",
      "ratioTriggered: needsCompress(used, cap, ratio, countTurns(historyView)),",
    ),
  },
  {
    name: "13 摘要轮不再读全量（早期对话从不进入摘要 = 静默丢上下文记忆）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "const { raw: historyAll, meta: histMeta } = await loadRawHistoryWithMeta(sessionId, { full: true });",
      "const { raw: historyAll, meta: histMeta } = await loadRawHistoryWithMeta(sessionId);",
    ),
  },

  /* ── ④ 假压缩熔断 + 摘要截断可见 ──────────────────────────────── */
  {
    name: "14 熔断去掉 realShrink（降幅不足的假压缩每次都被记成成功 ⇒ 熔断器永不开闸）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "        ok: summaryText !== null && validation.ok && realShrink,",
      "        ok: summaryText !== null && validation.ok,",
    ),
  },
  {
    name: "15 realShrink 被绕过成恒真（降幅判据不再作用）",
    file: F_MAIN,
    mutate: (t) => sub(t, "const realShrink = isRealShrink(used, tokensAfter);", "const realShrink = true;"),
  },
  {
    name: "16 输出上限去掉下界（小会话被无谓收紧到几百 token）",
    file: F_COMPRESS,
    mutate: (t) => sub(
      t,
      "  return Math.max(1024, Math.min(SUMMARIZE_OUTPUT_CAP, Math.ceil(n * 0.25)));",
      "  return Math.min(SUMMARIZE_OUTPUT_CAP, Math.ceil(n * 0.25));",
    ),
  },
  {
    name: "17 输出上限去掉上界（无界放大 = 新的烧钱口）",
    file: F_COMPRESS,
    mutate: (t) => sub(
      t,
      "  return Math.max(1024, Math.min(SUMMARIZE_OUTPUT_CAP, Math.ceil(n * 0.25)));",
      "  return Math.max(1024, Math.ceil(n * 0.25));",
    ),
  },
  {
    name: "18 压缩比被压小（0.25 → 0.05 ⇒ 大输入也只给 1024）",
    file: F_COMPRESS,
    mutate: (t) => sub(
      t,
      "  return Math.max(1024, Math.min(SUMMARIZE_OUTPUT_CAP, Math.ceil(n * 0.25)));",
      "  return Math.max(1024, Math.min(SUMMARIZE_OUTPUT_CAP, Math.ceil(n * 0.05)));",
    ),
  },
  {
    name: "19 摘要轮写死 max_tokens: 1024（CJK 长会话摘要被腰斩的直接产地）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "          max_tokens: maxOut,", "          max_tokens: 1024,"),
  },
  {
    name: "20 不再检查 finish_reason（半截摘要静默当完整 —— 丢记忆且查不出来）",
    file: F_ENGINE,
    all: true,
    mutate: (t) => subAll(t, '?.finish_reason === "length"', '?.finish_reason === "length__MUTATED"'),
  },
  {
    name: "21 截断后不再重试（半截摘要直接当结果）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "        const r2 = await router.chat(withModel(ask(maxOut), route!));",
      "        const r2 = r1; // 变异：不重试",
    ),
  },
  {
    name: "22 摘要轮不再读全量…（等价复现：截断标记不传导到界面）",
    file: F_MAIN,
    mutate: (t) => sub(t, "summaryTruncated = s.truncated;", "summaryTruncated = false;"),
  },
  {
    name: "23 elided 与截断不再出声（两条丢记忆路径重新静默）",
    file: F_MAIN,
    mutate: (t) => sub(t, "          if (s.elided > 0 || s.truncated) {", "          if (false) {"),
  },
  {
    name: "24 IPC 契约删掉 summaryTruncated（界面拿不到 ⇒ 无法如实提示）",
    file: F_IPC,
    mutate: (t) => sub(t, "  summaryTruncated?: boolean;\n", ""),
  },

  /* ── ⑤ MCP 广场中文化（用户原话：「官方 MCP 全是英文，太不能用了」）────── */
  {
    name: "25 中文词典被绕过（中文原样 URL 编码发给上游 ⇒ 搜不到任何东西）",
    file: F_LOCALIZE,
    mutate: (t) => sub(t, "    if (raw.includes(cn)) { cnHits += 1; push(en); }", "    if (false) { cnHits += 1; push(en); }"),
  },
  {
    name: "26 未收录的中文不再标记（静默按原词搜一遍，用户只看到「搜了没结果」）",
    file: F_LOCALIZE,
    mutate: (t) => sub(
      t,
      "    return { query: raw, terms: [], raw, mapped: false, unrecognized: true };",
      "    return { query: raw, terms: [], raw, mapped: false, unrecognized: false };",
    ),
  },
  {
    name: "27 词典混进单字键（「云南」这类无关输入被误命中 ⇒ 往上游塞一个错误检索词）",
    file: F_LOCALIZE,
    mutate: (t) => sub(t, '  ["浏览器", "browser"],', '  ["云", "cloud"],\n  ["浏览器", "browser"],'),
  },
  {
    name: "28 检索词数量上限失效（词太多 ⇒ 上游按 AND 收窄到 0 条）",
    file: F_LOCALIZE,
    mutate: (t) => sub(t, "export const MARKET_QUERY_MAX_TERMS = 4;", "export const MARKET_QUERY_MAX_TERMS = 99;"),
  },
  {
    name: "29 标签无命中时编造一个「其他」（装饰不是判据）",
    file: F_LOCALIZE,
    mutate: (t) => sub(t, "  return out;", "  return out.length > 0 ? out : [\"其他\"];"),
  },
  {
    name: "30 标签数量上限失效（把卡片布局撑坏）",
    file: F_LOCALIZE,
    mutate: (t) => sub(t, "export const MARKET_TAG_MAX = 3;", "export const MARKET_TAG_MAX = 99;"),
  },
  {
    name: "31 main 把**原始输入**当检索词（绕过 expandMarketQuery ⇒ 中文搜不到）",
    file: F_CFG,
    mutate: (t) => sub(t, "    const q = expanded.query;", "    const q = (query ?? \"\").trim();"),
  },
  {
    name: "32 main 不回带 appliedQuery（界面无法如实显示真正搜的是什么）",
    file: F_CFG,
    mutate: (t) => sub(t, "      ok: true, servers: cards, appliedQuery: q,", "      ok: true, servers: cards,"),
  },
  {
    name: "33 registry 恢复本地二次过滤（拿中文比英文字段 ⇒ 中文搜索稳定显示没找到）",
    file: F_MCP,
    mutate: (t) => sub(t, "const filtered = !useRegistry && q", "const filtered = q"),
  },
  {
    name: "34 registry 卡片不产中文标签（回到全英文）",
    file: F_MCP,
    mutate: (t) => sub(t, "                tags: localizeServerTags(s.displayName, s.description),\n", ""),
  },
  {
    name: "35 标签不再渲染（内置精选的 tags 又变回死数据：定义了却从不显示）",
    file: F_MCP,
    mutate: (t) => sub(t, "                    {(item.tags ?? []).length > 0 && (", "                    {false && ("),
  },
  {
    name: "36 IPC 契约删掉 appliedQuery / unrecognized（渲染层拿不到 ⇒ 无法如实提示）",
    file: F_PRELOAD,
    all: true,
    mutate: (t) => subAll(t, "appliedQuery?: string; unrecognized?: boolean; ", ""),
  },
  /* ── ⑤ 「轮」口径（单位错配）────────────────────────────────────────── */
  {
    name: "37 countTurns 退化成「数消息条数」（= 回到把 .length 当轮数）",
    file: F_LOOP,
    mutate: (t) => sub(t, 'for (const m of messages) { if (m?.role === "user") { n += 1; } }', "for (const m of messages) { n += 1; void m; }"),
  },
  {
    name: "38 main 触发判据回填 historyAll.length（6 轮门槛实际 2-3 轮就放行）",
    file: F_MAIN,
    mutate: (t) => sub(t, "ratioTriggered: needsCompress(used, cap, ratio, countTurns(historyAll)),",
      "ratioTriggered: needsCompress(used, cap, ratio, historyAll.length),"),
  },
  /* ── ⑥ 委派规范唯一出处 ────────────────────────────────────────────── */
  {
    name: "39 chat 回填内联副本（两产地又开始可以漂移）",
    file: F_CHAT,
    mutate: (t) => sub(t, 'sys += "\\n\\n" + DELEGATION_GUIDANCE;',
      'sys += "\\n\\n子任务委派（delegate_subagent / subagent_result）——**默认派发，不要默认自己全做完**：";'),
  },
  {
    name: "40 engine 不带委派规范（定时任务路径 100% 单干 —— 用户报的症状）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    parts.push(DELEGATION_GUIDANCE);\n", ""),
  },
  {
    name: "41 规范措辞退回「先想能不能拆」（= 把「自己做」当默认的那版）",
    file: F_CATALOG,
    mutate: (t) => sub(t, "子任务委派（delegate_subagent / subagent_result）——**默认派发，不要默认自己全做完**：",
      "子任务委派（delegate_subagent / subagent_result）——**先想「能不能拆」，不要默认自己全做完**："),
  },
  {
    name: "42 规范删掉「必须自己做的四类」（主 Agent 的职责边界消失）",
    file: F_CATALOG,
    mutate: (t) => sub(t, "- **必须自己做的四类**（别硬拆，拆了更慢更贵）：", "- **必须自己做的**："),
  },
  /* ── ⑦ RPM 先上报再睡 ─────────────────────────────────────────────── */
  {
    name: "43 onWait 改到 sleep 之后回调（=「等完了才出声」）",
    file: F_RPMLIM,
    mutate: (t) => sub(t,
      "      notify(plan.waitMs);                // 先上报，再睡\n      await this.clock.sleep(plan.waitMs);",
      "      await this.clock.sleep(plan.waitMs);\n      notify(plan.waitMs);"),
  },
  {
    name: "44 onWait 被忽略（回调入口直接 return ⇒ 等待期界面永远空白）",
    file: F_RPMLIM,
    mutate: (t) => sub(t, "      if (!onWait) { return; }", "      return;"),
  },
  {
    name: "45 client 不把 onWait 传下去（回到旧写法：等完了才说）",
    file: F_CLIENT,
    mutate: (t) => sub(t,
      "      await getSharedRpmLimiter().acquire(rateLimit.key, rateLimit.model, (ms) => {\n" +
      '        // A-1061④ 同纪律：等超过 1s 就必须说出来，否则界面上是"一整段什么都没有"\n' +
      "        //（而实际是我们在自我限速）。\n" +
      "        if (ms >= 1000) {\n" +
      "          noteUpstream(\n" +
      '            "retry",\n' +
      "            `上游每分钟请求额度已用满，需要等 ${Math.round(ms / 1000)}s 再发 —— 这是避免撞限流（429）的自我保护，不是故障。`,\n" +
      "          );\n" +
      "        }\n" +
      "      });",
      "      await getSharedRpmLimiter().acquire(rateLimit.key, rateLimit.model);"),
  },
  /* ── ⑧ 压缩比率的唯一出处 ─────────────────────────────────────────── */
  {
    name: "46 渲染层回填硬编码 0.85（压缩比率第二产地 ⇒ 主进程一改界面就对不上）",
    file: F_PANEL,
    mutate: (t) => sub(t, 'ratio: DEFAULT_COMPRESS_RATIO, mode: "animated" };', 'ratio: 0.85, mode: "animated" };'),
  },

  /* ══════ ⑨ A-1106 续（第二轮）：子代理派发两条残留 + 技能广场 ══════
     47~51  可派发清单不随 Agent 生命周期刷新（新建 / 分裂 / 删除 / 改设置 / 导入）
     52     启动期不显式传管理器（此刻 subagentsRef 还是 null ⇒ 清单从未被登记）
     53~55  wait 不可中断（丢掉 signal 参数 / 不注册 abort 监听 / 不处理已中断）
     56~57  工具循环不注入 `_signal`（不注入 / 不 delete 伪造值）
     58~61  工具侧不校验注入值 / 不传递 signal / 中断优先归因被绕过
     62     等待上限退化到 ≤ 执行预算
     63     四层取值丢掉「实测优先」（付费档被内置免费档猜测压住）
     64~69  技能广场：判据退化 / 打开即联网 / saveToken 无条件切源 / 失败也接管 /
            过滤判据内联 / 官方仓库不产中文标签
     70~74  本地匹配关键词退化（丢原输入 / 丢展开词 / 空返空 / 改 AND / 未收录不提示）
     76~80  力度预算分档退化 / 派发与排队取消不出声（A-1106/5b，「没看到子代理」） */

  {
    name: "47 新建 Agent 后不刷新清单（「刚建的子代理主 Agent 调不动」的直接产地）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      '    syncDispatchableSubagents();\n    mainWindow?.webContents.send("slime:agents:selected", a.id);',
      '    mainWindow?.webContents.send("slime:agents:selected", a.id);',
    ),
  },
  {
    name: "48 分裂出子 Agent 后不刷新清单（分裂出来的同样进不去清单）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      '    syncDispatchableSubagents();\n    mainWindow?.webContents.send("slime:agents:selected", child.id);',
      '    mainWindow?.webContents.send("slime:agents:selected", child.id);',
    ),
  },
  {
    name: "49 删除 Agent 后不刷新清单（清单里留着一个不存在的名字 ⇒ 点名派发必失败）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      '    syncDispatchableSubagents();\n    return { ok: true, deleted };',
      '    return { ok: true, deleted };',
    ),
  },
  {
    name: "50 改 Agent 设置后不刷新清单（清单里留旧描述 ⇒ 模型按旧描述选人）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      '    syncDispatchableSubagents();\n    return { ok: true };',
      '    return { ok: true };',
    ),
  },
  {
    name: "51 导入 Agent 后不刷新清单（「导入成功」却在派发侧不可见）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      '      syncDispatchableSubagents();\n      mainWindow?.webContents.send("slime:agents:selected", res.agentId ?? null);',
      '      mainWindow?.webContents.send("slime:agents:selected", res.agentId ?? null);',
    ),
  },
  {
    name: "52 启动期不显式传管理器（此刻 subagentsRef 还是 null ⇒ 清单从未被登记）",
    file: F_MAIN,
    mutate: (t) => sub(t, "syncDispatchableSubagents(subagents);", "syncDispatchableSubagents();"),
  },
  {
    name: "53 wait 丢掉 signal 参数（这条 await 重新变成不可打断）",
    file: F_SUB,
    mutate: (t) => sub(
      t,
      "  async wait(id: string, timeoutMs = 300_000, signal?: AbortSignal): Promise<SubAgentRun | undefined> {",
      "  async wait(id: string, timeoutMs = 300_000): Promise<SubAgentRun | undefined> {",
    ),
  },
  {
    name: "54 wait 不注册 abort 监听（「停止生成」再也打不断等待）",
    file: F_SUB,
    mutate: (t) => sub(t, '      signal?.addEventListener("abort", done, { once: true });\n', ""),
  },
  {
    name: "55 已中断的 signal 不再快路径返回（按了停止还要进等待，等满上限）",
    file: F_SUB,
    mutate: (t) => sub(t, "    if (signal?.aborted) { return this.status(id); }", "    if (false) { return this.status(id); }"),
  },
  {
    name: "56 工具循环不注入 _signal（工具侧永远拿不到中断通路 = 等于没修）",
    file: F_TOOLLOOP,
    mutate: (t) => sub(t, "      if (signal) { args._signal = signal; }\n", ""),
  },
  {
    name: "57 工具循环不 delete 伪造的 _signal（模型传个假值就能污染中断语义）",
    file: F_TOOLLOOP,
    mutate: (t) => sub(t, "      delete args._signal;\n", ""),
  },
  {
    name: "58 工具侧不再校验注入值（受信注入被当成普通入参信任）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, "  return raw instanceof AbortSignal ? raw : undefined;", "  return raw as AbortSignal | undefined;"),
  },
  {
    name: "59 delegate_subagent 不把 signal 传给 wait（该工具仍不可中断）",
    file: F_BUILTIN,
    mutate: (t) => sub(
      t,
      "const final = await subagentManagerRef.wait(run.id, waitMs, signal);",
      "const final = await subagentManagerRef.wait(run.id, waitMs);",
    ),
  },
  {
    name: "60 subagent_result 不把 signal 传给 wait（该工具仍不可中断）",
    file: F_BUILTIN,
    mutate: (t) => sub(
      t,
      "const run = await subagentManagerRef.wait(id, waitMs, signal);",
      "const run = await subagentManagerRef.wait(id, waitMs);",
    ),
  },
  {
    name: "61 中断优先归因被绕过（把「用户停止」误报成「超时/仍在执行」）",
    file: F_BUILTIN,
    all: true,
    mutate: (t) => subAll(t, "  if (signal?.aborted) {", "  if (false) {"),
  },
  {
    name: "62 等待上限退化到 ≤ 执行预算（wait 与子代理自身 abort 在同一毫秒竞争）",
    file: F_BUILTIN,
    mutate: (t) => sub(t, "const SUBAGENT_WAIT_DEFAULT = DEFAULT_EXEC_BUDGET_MS + 60_000;", "const SUBAGENT_WAIT_DEFAULT = 300_000;"),
  },
  {
    name: "63 四层取值丢掉「实测优先」（实测分支被顶掉 ⇒ 付费档被内置免费档猜测压住）",
    file: F_RPMLIM,
    mutate: (t) => sub(
      t,
      '  if (usableRpm(observed)) { return { rpm: observed, source: "observed" }; }',
      '  if (usableRpm(manual)) { return { rpm: manual, source: "manual" }; }',
    ),
  },
  {
    name: "64 技能广场判据退回「联网有没有数据」（打开几秒后预制列表被无声替换）",
    file: F_SKILLS,
    mutate: (t) => sub(
      t,
      "        const useOnline = onlineSourceActive(requestedOnline, marketOnline?.length ?? 0);",
      "        const useOnline = marketOnline !== null;",
    ),
  },
  {
    name: "65 打开技能广场恢复自动联网（网络一返回就把预制列表换掉）",
    file: F_SKILLS,
    mutate: (t) => sub(t, '    if (marketOpen) { setMarketError(""); }', '    if (marketOpen) { void loadMarket(); setMarketError(""); }'),
  },
  {
    name: "66 保存 Token 后无条件切到官方仓库（用户在看预制却被无声换源）",
    file: F_SKILLS,
    mutate: (t) => sub(t, "if (requestedOnline) { await loadMarket(true); }", "await loadMarket(true);"),
  },
  {
    name: "67 失败/空结果也接管列表（联网失败却把预制视图换掉 ⇒ 用户看到空列表）",
    file: F_SKILLS,
    mutate: (t) => sub(t, "if (res?.ok && Array.isArray(res.skills)) {", "if (true) {"),
  },
  {
    name: "68 技能广场过滤判据内联回组件（两个产地 = 改一处漏一处）",
    file: F_SKILLS,
    mutate: (t) => sub(
      t,
      "        const filtered = filterMarketItems(sourceList, needles);",
      "        const filtered = needles.length > 0 ? sourceList.filter((it) => it.name.toLowerCase().includes(q)) : sourceList;",
    ),
  },
  {
    name: "69 官方仓库卡片不产中文标签（又是一屏英文）",
    file: F_SKILLS,
    mutate: (t) => sub(t, "              tags: localizeServerTags(s.name, s.description),\n", ""),
  },
  {
    name: "70 匹配关键词丢掉**原输入**（中文输入再也搜不到中文的预制条目）",
    file: F_MARKET,
    mutate: (t) => sub(t, "  for (const t of [e.raw, ...e.terms]) {", "  for (const t of [...e.terms]) {"),
  },
  {
    name: "71 匹配关键词丢掉**展开词**（中文输入搜不到英文的官方仓库 —— 本次要修的那一层）",
    file: F_MARKET,
    mutate: (t) => sub(t, "  for (const t of [e.raw, ...e.terms]) {", "  for (const t of [e.raw]) {"),
  },
  {
    name: "72 本地过滤空关键词时返回空列表（没搜过 = 什么都没了）",
    file: F_MARKET,
    mutate: (t) => sub(t, "  if (ns.length === 0) { return [...list]; }", "  if (ns.length === 0) { return []; }"),
  },
  {
    name: "73 本地过滤改成 AND 语义（口语输入展开出多个词 ⇒ 必然 0 条）",
    file: F_MARKET,
    mutate: (t) => sub(t, "    return ns.some((n) => hay.includes(n));", "    return ns.every((n) => hay.includes(n));"),
  },
  {
    name: "74 未收录的中文不再如实提示（把「词没认出来」说成「没找到」）",
    file: F_SKILLS,
    mutate: (t) => sub(t, "未收录「${q}」对应的英文关键词", "已按关键词过滤"),
  },
  {
    /* A-1106 迁移配套：a1096 那道守卫里新增了一条**计数型**断言（登记只能有一处）。
       计数/负面断言写错恒绿 ⇒ **必须配变异**，这条就是它的变异（第二产地出现即红）。 */
    name: "75 登记在第二个地方又抄一份（可派发清单出现第二产地 ⇒ 两处判据各说各话）",
    file: F_MAIN,
    mutate: (t) => sub(t, "  mgr.setUserSelected(defs);\n", "  mgr.setUserSelected(defs);\n  mgr.setUserSelected(defs);\n"),
  },
];

/* ── ⑩ A-1106/5b：力度预算分档 + 派发即出声（用户：「怎么还是没怎么看到子代理」）────
   76   分档整段被删（回到「默认派发」却不给量 ⇒ 简单问题可能派一堆）
   77   spawn 不触发 onSpawn（pending 阶段永远不出声 ⇒ 面板只能靠 3 秒轮询）
   78   装配层 onSpawn 不广播（钩子形同虚设）
   79   取消「排队中」不广播 + 不落盘（唯一不触发钩子的状态变化重新静默）
   80   ④ 回填「一两步就能做完的」（与新分档自相矛盾 ⇒ 负向清单压过正向） */
MUTATIONS.push(
  {
    name: "76 委派规范删掉「力度预算分档」（只剩「默认派发」却不给量）",
    file: F_CATALOG,
    mutate: (t) => sub(
      t,
      "简单事实查找 / 单个小改动 → 1 个子代理（3–10 次工具调用）；直接对比 / 多文件同类修改 → 2–4 个；复杂研究 / 大范围重构 → 10+ 个，职责明确划分。",
      "",
    ),
  },
  {
    name: "77 spawn 不触发 onSpawn（pending 阶段不出声 ⇒ 面板只能轮询）",
    file: F_SUB,
    mutate: (t) => sub(
      t,
      "    void this.fireHook(this.hooks.onSpawn, run, def);",
      "    void 0; // 变异：不触发 onSpawn",
    ),
  },
  {
    name: "78 装配层 onSpawn 不发事件（钩子接了却不广播）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "            console.log(`[subagent] 派发 ${run.name} (${run.id})`);\n            mainWindow?.webContents.send(\"slime:resident:update\", null);",
      "            void run; // 变异：派发不出声",
    ),
  },
  {
    name: "79 取消「排队中」不广播 + 不落盘（面板要等 3 秒轮询、重启后记录消失）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "        if (ok) {\n          syncSubagentRuns(subagents.list());\n          mainWindow?.webContents.send(\"slime:resident:update\", null);\n        }",
      "        if (ok) { void ok; // 变异：取消不出声、不落盘\n        }",
    ),
  },
  {
    name: "80 「必须自己做」的④回填「一两步就能做完的」（与新分档自相矛盾）",
    file: F_CATALOG,
    mutate: (t) => sub(
      t,
      "④ **一次工具调用就能拿到答案的**（单文件读取、单文件精确查找、单次查询）。",
      "④ **一两步就能做完的**（简单事实查、单次查询、只改一个已知位置）。",
    ),
  },

  /* ══ A-1106 第二轮：六项 UI / 机制（用户一口气提的 6 类问题）══════════════════
     守卫全部住在 `tests/gui/a1106-ui-guards.spec.ts`（已加进 SPECS）。
     这六项**全部属于「静默失效」家族** —— 过 tsc、过构建、过所有逻辑测试，只在用户眼里翻车：
       · 扫光被 `background` 简写重置 ⇒ 文字全透明（"空白框格"）；
       · resizer 朝外扩命中区被父级 `overflow: hidden` 裁掉 ⇒ 命中区**其实没变**；
       · 产物卡宽度靠 `content-visibility` 离散翻转 ⇒ 第 1 帧跳变，`transition` 白写；
       · 正文后置闸门把渐入水位推到底 ⇒ 开闸时**一个渐入都不播**。
     ⚠️ `to` 一律用 `sub(...)`（行尾无关）；多行锚点不要自己拼裸 `\n`。 */

  /* ── 问题 1：扫光（.text-scan-light）──────────────────────────────── */
  {
    name: "81 扫光类改回 `background` 简写（longhand 被重置 + 文字恒透明 ⇒ 空白框格）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  background-image: linear-gradient(90deg, var(--text) 0%",
      "  background: linear-gradient(90deg, var(--text) 0%",
    ),
  },
  {
    name: "82 扫光丢掉 background-clip:text（退化成普通色块，不再是「字上扫光」）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  -webkit-background-clip: text;\n  background-clip: text;",
      "  -webkit-background-clip: border-box;\n  background-clip: border-box;",
    ),
  },
  {
    name: "83 ChatPanel 少一处扫光（「正在思考」退回呼吸类 ⇒ 用户点名的四处只剩三处）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '<span className="text-scan-light">{runningTool ? "思考与工具调用进行中" : "正在思考"}</span>',
      '<span className="text-breathe">{runningTool ? "思考与工具调用进行中" : "正在思考"}</span>',
    ),
  },
  {
    name: "84 工具卡状态胶囊挂回扫光（同元素有 `background: color-mix()` 简写 ⇒ 又被重置成空白框格）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '          className="think-tool-status"\n',
      '          className="think-tool-status text-scan-light"\n',
    ),
  },
  {
    name: "85 删掉 reduced-motion 下「只关动画」的覆盖（无障碍回退没了）",
    file: F_CSS,
    mutate: (t) => sub(t, "  .text-scan-light { animation: none; }", ""),
  },

  /* ── 问题 2：时间轴光点几何 ──────────────────────────────────────── */
  {
    name: "86 思考段落圆点回退到 -20px（圆心偏左 1px，不再正中心穿轴）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  position: absolute; left: -19px; top: 8px;",
      "  position: absolute; left: -20px; top: 8px;",
    ),
  },
  {
    name: "87 工具节点圆点回退到 -20px（同一条对齐推导，两处必须同值）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  position: absolute; left: -19px; top: 9px;",
      "  position: absolute; left: -20px; top: 9px;",
    ),
  },
  {
    name: "88 时间轴左边距回退到 7px（光晕余量不足 ⇒ 左侧被 overflow:hidden 切一刀）",
    file: F_CSS,
    mutate: (t) => sub(t, "  margin: 2px 0 4px 12px;", "  margin: 2px 0 4px 7px;"),
  },

  /* ── 问题 3：状态行字号 ──────────────────────────────────────────── */
  {
    name: "89 状态行主句字号回退 14.5 → 13（用户投诉的「看着好小」复发）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '      padding: "6px 0 10px 42px", fontSize: 14.5, lineHeight: 1.55,',
      '      padding: "6px 0 10px 42px", fontSize: 13, lineHeight: 1.55,',
    ),
  },
  {
    name: "90 状态行副句字号回退 13 → 11.5",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '<span style={{ color: "var(--text-dim)", fontSize: 13 }}>· {status.detail}</span>',
      '<span style={{ color: "var(--text-dim)", fontSize: 11.5 }}>· {status.detail}</span>',
    ),
  },
  {
    name: "91 状态行激励语字号回退 14 → 13",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '<span style={{ color: "var(--text-secondary)", fontSize: 14, fontWeight: 500, minWidth: 0 }}>',
      '<span style={{ color: "var(--text-secondary)", fontSize: 13, fontWeight: 500, minWidth: 0 }}>',
    ),
  },

  /* ── 问题 4：分隔条命中区 + 流光 ─────────────────────────────────── */
  {
    /* ⚠️⚠️ **A-1111 迁移（本轮 · 具名交代，不是删除）** ⚠️⚠️
       本条原文是「92 分隔条命中区朝外扩（`right: -3px`）—— 越界部分不参与命中测试，等于没放大」，
       锚点 `  top: 0;\n  right: 0;\n`。A-1111 起这条**语义整体反转**：
         · 「朝外扩」不再是缺陷，而是用户**点名要的**正确实现（「左右同步增加相同位数的像素点
           判定范围」）⇒ 原来那个变异体的输出 `right: -3px` 现在是"跨出去了但不对称"，
           与 116/118 打的是同一件事，留着只是重复；
         · 旧锚点本身也已漂移（源码里 `right: 0` → `right: -6px`）⇒ 核验器报「未命中」，
           而**未命中的锚点 = 守卫已失效**，与"存活"同等严重，不能放着不管。
       意图（**静默失效在用户眼里翻车**）保留，机制换成 A-1111 真正新增、且此前**没有任何守卫**
       的那件事：可见热带的**热态规则**。它静止态 `opacity: 0`，点亮全靠一条独立规则；
       删掉那条规则 ⇒ 过 tsc / 过构建 / 过本 spec ①②③④⑤⑥ 全部用例，而用户看到的是
       「命中区确实宽了，但光标旁什么也没有」—— 与它本来要防的「看着变宽、实际没变」同族。
       守卫 = 本文件 SPECS 里那份 spec 的 ⑦（同轮新增）。 */
    name: "92 可见热带的热态规则被删（热带永远停在 opacity: 0 ⇒ 命中区宽了却没有视觉反馈）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      ".sidebar-resizer:is(:hover, :active),\n.right-sidebar-resizer:is(:hover, :active) {\n  opacity: 1;\n}\n",
      "",
    ),
  },
  {
    name: "93 分隔条命中区回退到 6px（用户点名要「大几个像素」的那几个像素没了）",
    file: F_CSS,
    /* ⚠️ `all: true` = 显式声明「这是**整组**替换」：左右两个 resizer 都是 `width: 12px`
       ⇒ 忠实复现「命中区整体回退」必须**两处一起**改。不声明时核验器只能报
       「不唯一（无法确定改的是哪一处）」，而长期红着的报警等于没人看。 */
    all: true,
    mutate: (t) => sub(
      t,
      "  width: 12px;\n  height: 100%;",
      "  width: 6px;\n  height: 100%;",
    ),
  },
  {
    name: "94 聚光不再跟随指针（峰值写死 50% ——「鼠标放置的位置来个最大的弧形」失效）",
    file: F_CSS,
    /* ⚠️ `all: true` = 作者显式声明「这是**整组**替换」。这条闸门是**计数型**的：
       `--rz-ramp` 里 `var(--rz-y, 50%)` 出现 3 次（峰值 + 两个 calc 边界），
       忠实复现「不再跟随指针」必须**三处一起**改。不声明时 `check-mut-anchors.mjs`
       只能报「不唯一（无法确定改的是哪一处）」—— 而那份报警长期红着就等于没人看。 */
    all: true,
    mutate: (t) => subAll(t, "var(--rz-y, 50%)", "50%"),
  },
  {
    name: "95 聚光退回**覆盖层**（`::before` 画在 padding box 内侧 ⇒ 与真 border 叠成 2px 亮线；就是 A-1106 续轮被用户判定「效果不对」的那个椭圆光斑）",
    file: F_CSS,
    mutate: (t) => sub(
      sub(
        t,
        ".sidebar:has(.sidebar-resizer:is(:hover, :active)) {",
        ".sidebar-resizer::before { content: \"\"; position: absolute; right: 0; top: var(--rz-y); width: 20px; height: 140px; background: radial-gradient(closest-side, var(--accent), transparent); pointer-events: none; }\n.sidebar:has(.sidebar-resizer:hover) {",
      ),
      "  border-image: var(--rz-ramp) 0 3 0 0 / 0 3px 0 0 stretch;\n  border-right-color: var(--accent-hover);",
      "  border-right-color: var(--accent-hover);",
    ),
  },
  {
    name: "96 左栏 slice 方向写反（渐变画在**没有 border** 的那条边上 ⇒ 什么都看不见，静默失效）",
    file: F_CSS,
    /* ⚠️ A-1117 同步：分隔线粗细 1px → 3px（用户「拖拽光标太窄了，怎么这么细」）。
       锚点跟着走，别只改源码 —— 否则这条变异**静默不命中**（`sub` 找不到原文就原样返回，
       看起来"跑过了"，其实什么都没改）。 */
    mutate: (t) => sub(
      t,
      "border-image: var(--rz-ramp) 0 3 0 0 / 0 3px 0 0 stretch;",
      "border-image: var(--rz-ramp) 0 0 0 3 / 0 0 0 3px stretch;",
    ),
  },
  {
    name: "97 聚光峰值色写成常态线色（hover 不再有任何颜色变化）",
    file: F_CSS,
    /* ⚠️ A-1111：锚点**必须带上上一行**才能唯一。原锚点 `    var(--accent) var(--rz-y, 50%),`
       在 A-1111 之前只出现 1 次（`--rz-ramp` 的峰值行）；可见热带左右各新增一份同款渐变后
       变成 **3 次**（470 之外，496/518 各一次）⇒ 核验器报「不唯一（无法确定改的是哪一处）」。
       判据：本条打的是**聚光渐变**（`--rz-ramp`，它的首行是 `var(--border) calc(...)`），
       而两份热带的首行是 `transparent calc(...)` ⇒ 把首行一起写进锚点即唯一，且
       **仍然只依赖语义**（不是靠"第几个匹配"这种位置判据）。 */
    mutate: (t) => sub(
      t,
      "    var(--border) calc(var(--rz-y, 50%) - 42%),\n    var(--accent) var(--rz-y, 50%),",
      "    var(--border) calc(var(--rz-y, 50%) - 42%),\n    var(--border) var(--rz-y, 50%),",
    ),
  },
  {
    name: "98 斜坡半长 42% 改小（光带缩成一小截 —— 与参考实现实测出来的比例不符）",
    file: F_CSS,
    all: true,   // 两个 calc 边界（- 42% / + 42%）必须一起改 = 整组替换
    mutate: (t) => subAll(t, " 42%)", " 12%)"),
  },
  {
    name: "99 聚光变量写在 resizer 自己身上（父级读不到 ⇒ 聚光永远停在兜底 50%，静默失灵）",
    file: F_GLINT,
    mutate: (t) => sub(t, "  const host = el.parentElement;   // 分隔线的主人 = 父级（border 在它身上）", "  const host = el;"),
  },
  {
    name: "100 clear 忘了清父级的变量（聚光卡在最后一次的位置上，鼠标移开也不消失）",
    file: F_GLINT,
    mutate: (t) => sub(
      t,
      "  e.currentTarget.parentElement?.style.removeProperty(GLINT_VAR);",
      "  e.currentTarget.style.removeProperty(GLINT_VAR);",
    ),
  },
  {
    name: "101 光流位置不再钳到 [0,100]（拖拽中 clientY 越界 ⇒ 弧光整段飞出、看不见）",
    file: F_GLINT,
    mutate: (t) => sub(t, "  const clamped = Math.max(0, Math.min(100, pct));", "  const clamped = pct;"),
  },
  {
    name: "102 左栏 resizer 不接流光（`--rz-y` 永远停在 CSS 默认位，左栏流光不跟随）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "onMouseMove={trackResizerGlint} onMouseLeave={clearResizerGlint} />",
      "onMouseMove={undefined} onMouseLeave={undefined} />",
    ),
  },
  {
    name: "103 右栏 resizer 不接流光（只接左栏 = 两栏行为不一致）",
    file: F_RSB,
    mutate: (t) => sub(
      t,
      "onMouseMove={trackResizerGlint} onMouseLeave={clearResizerGlint} />",
      "onMouseMove={trackResizerGlint} />",
    ),
  },
  {
    name: "104 热态退回纯 `:hover`（拖拽中指针被 pointer capture 拉出 8px 命中区 ⇒ 聚光中途熄灭）",
    file: F_CSS,
    all: true,   // 左右两栏的热态选择器必须一起改（只改一栏 = 另一栏仍是正确实现，红得不是这条缺陷）
    mutate: (t) => subAll(t, ":is(:hover, :active)", ":hover"),
  },

  /* ── 问题 5a：吐字渐入（闸门必须同时冻结显示缓冲）────────────────── */
  {
    name: "105 关闸镜像写反（bodyGateRef 恒 false）—— 闸门形同不存在，显示缓冲照旧推到底",
    file: F_PANEL,
    mutate: (t) => sub(t, "  bodyGateRef.current = !loading;", "  bodyGateRef.current = false;"),
  },
  {
    name: "106 打字机推进不再被闸门挡住（水位在关闸期推到底 ⇒ 开闸一个渐入都不播）",
    file: F_PANEL,
    mutate: (t) => sub(t, "      if (!gated && shown.length < full.length) {", "      if (shown.length < full.length) {"),
  },
  {
    name: "107 自续条件丢掉 !gated（关闸期整轮 60fps 空转）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      if (!gated && displayPartialRef.current.length < partialRef.current.length) {",
      "      if (displayPartialRef.current.length < partialRef.current.length) {",
    ),
  },
  {
    name: "108 删掉开闸点火 effect（正文永远停在空白 —— 比「没有渐入」严重得多）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "  React.useEffect(() => {\n    if (!loading && partialRef.current) { schedulePartialRender(); }\n  }, [loading, schedulePartialRender]);",
      "  /* 变异：删掉开闸点火 */",
    ),
  },
  {
    name: "109 `gated` 常量写死 false（与 102 同族：闸门判据被绕过）",
    file: F_PANEL,
    mutate: (t) => sub(t, "      const gated = !bodyGateRef.current;", "      const gated = false;"),
  },

  /* ── 问题 6：产物卡横向过渡 ─────────────────────────────────────── */
  {
    name: "110 产物宿主折叠态回退 `width: auto`（两态无可插值的指定值 ⇒ 第 1 帧跳完）",
    file: F_CSS,
    mutate: (t) => sub(t, ".prod-host {\n  width: fit-content;", ".prod-host {\n  width: auto;"),
  },
  {
    name: "111 删掉 interpolate-size（fit-content ↔ 100% 不再插值 ⇒ 横向过渡消失）",
    file: F_CSS,
    mutate: (t) => sub(t, "  interpolate-size: allow-keywords;\n", ""),
  },
  {
    name: "112 展开态宽度写回 auto（两态同一个关键字 ⇒ 根本没得过渡）",
    file: F_CSS,
    mutate: (t) => sub(t, ".prod-host.is-open { width: 100%; }", ".prod-host.is-open { width: auto; }"),
  },
  {
    name: "113 产物卡类名留在卡片上（宿主 CSS 写了却没人用 = 静默失效）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      'className={`prod-host${expanded === i ? " is-open" : ""}`}',
      'className={`prod-card${expanded === i ? " is-open" : ""}`}',
    ),
  },

  /* ── A-1111：分隔条命中区**跨过分隔线**（左右对称）+ 与命中区同中心的可见热带 ─────────
     用户原话：「你怎么只变宽了判定范围，没有同步加宽光标的展示效果？还有，你这个判定范围
     怎么只往左增加？我想要的一直是左右同步增加相同位数的像素点判定范围，同时显示效果也统一
     随判定范围左右拓宽几个像素点的显示效果。」
     守卫 = `tests/gui/a1106-ui-guards.spec.ts` ①（A-1111 **迁移**后的版本）。
     ⚠️ 这一组的核心**不是**"跨出去"：几何好看 ≠ 能点到。真判据是**跨出去 ⇔ 裁剪同量放宽**
     这一对必须同时成立 —— 所以 114/115 专打"裁剪"那一半（那半边一松，症状与 A-1106 的
     「看着变宽、实际没变」**逐字相同**，且 CSS 里还明明白白写着"跨出去"，过 tsc、过构建、过逻辑测试）。
     ⚠️⚠️ **这一组必须留在数组末尾**（A-1117 更正）：它们曾经被插在 75 与 76 之间，
       于是 `name` 前缀（114~118）与 `--list`/`--apply` 的**序号**（76~80）错位 5 位 ——
       `node mut-a1106.mjs --apply 96` 实际变异的是名叫 "91 状态行激励语字号" 那条，
       而"看起来跑过了、也红了"，于是得到一条**假绿**（我这轮就被它骗过一次）。
       不变量：**name 的序号 === `--list` 印出的序号**。 */
  {
    name: "114 裁剪放宽量小于外伸量（`overflow-clip-margin` 7px → 1px ⇒ 外侧那半边的命中区根本不存在，而 CSS 里仍写着跨出去）",
    file: F_CSS,
    all: true,   // 左右两栏的裁剪必须一起退回（只改一栏 = 另一栏仍是正确实现，红得不是这条缺陷）
    mutate: (t) => subAll(t, "  overflow-clip-margin: 7px;", "  overflow-clip-margin: 1px;"),
  },
  {
    name: "115 裁剪退回 `overflow: hidden`（margin 被静默忽略 ⇒ 与 A-1106 同一个静默失效：看着变宽、实际没变）",
    file: F_CSS,
    all: true,
    mutate: (t) => subAll(t, "  overflow: clip;\n  overflow-clip-margin: 7px;", "  overflow: hidden;"),
  },
  {
    /* ⚠️ 写 `0px` 而不是 `0`：两者是**同一件事**的 CSS 写法，但守卫的解析器只认带单位的值，
       写 `0` 会先被那道"解析不出偏移 —— 断言对象搞错了"的**响亮**护栏拦下（也是红，但红的是
       护栏而不是判据本身，报错文本容易被后来人误读成「守卫坏了」）。
       判据：本条要证明的是「没跨过分隔线」这条**语义**判据真的在守，所以锚点落在同一判据上。 */
    name: "116 左栏命中区退回**只朝内侧**（`right: -6px` → `0px` ⇒ 用户点名的那半个「左右同步」没了）",
    file: F_CSS,
    mutate: (t) => sub(t, "  right: -6px;", "  right: 0px;"),
  },
  {
    name: "117 右栏命中区退回**只朝内侧**（`left: -6px` → `0px` ⇒ 两栏行为不一致）",
    file: F_CSS,
    mutate: (t) => sub(t, "  left: -6px;", "  left: 0px;"),
  },
  {
    /* ⚠️ 本条是**唯一**能打到「对称」这条判据的变异（114/115 打的是裁剪那一半，116/117 打的是
       「跨不跨」，都被更早的断言先拦下 —— 它们的命门不是对称性）：
       外伸量 ≠ 宽度的一半 ⇒ 命中区**跨了但不居中**，一侧 2px、另一侧 10px。
       这正是用户原话「我想要的一直是**左右同步**增加**相同位数**的像素点判定范围」的反面，
       而过 tsc / 过构建 / 过其余全部用例 —— 只在手感上"偏一边"。 */
    name: "118 命中区跨了但**不居中**（`right: -6px` → `right: -2px` ⇒ 一侧 2px、另一侧 10px，用户点名的「左右同步、相同位数」没了）",
    file: F_CSS,
    mutate: (t) => sub(t, "  right: -6px;", "  right: -2px;"),
  },
);

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
    if (r.status !== 0) { return { ok: false, spawnBlocked: false, spec }; }
  }
  return { ok: true, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
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
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
  console.error("请改用 --apply / --restore + shell 循环（命令见本文件头部注释）。");
  process.exit(1);
}
if (!base.ok) {
  console.error(`基线未通过（${base.spec}）—— 先修好测试再跑变异。`);
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1106")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.ok) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  restoreAll();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) {
  console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}（${leftovers.join(", ")}）`);
  process.exit(1);
}
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
