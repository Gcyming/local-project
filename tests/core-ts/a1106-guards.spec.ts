/**
 * tests/core-ts/a1106-guards.spec.ts — A-1106：四处「静默失效」修复的守卫。
 *
 * 本轮的四处修复有一个共同形态：**过 tsc、过构建、过所有既有逻辑测试，只在用户眼里翻车**。
 * 所以每条都必须有**能变异**（改坏 → 红）的守卫，否则等于没修。
 *
 * ① **MCP 广场「打开几秒后自己变样」**（McpPanel / marketView）
 *    旧行为：打开广场就联网拉全量 registry，网络一返回 `hasRegistry` 把内置精选**整个替换**掉。
 *    用户正想装的那 20 条（唯一带准确安装命令的）当场消失、无声无息。
 *
 * ② **RPM 限流器在生产链路里一次都没被调用**（router.createRouteClient / gui main clientFactory）
 *    根因 = **重复产地**：main 为了注入 Chromium fetch 另抄了一份 clientFactory，**漏了 `rateLimit`**，
 *    而 `chat()` 的限流分支是 `if (rateLimit)` ⇒ 恒假。测试走的是 router 里那份 ⇒ 全绿也发现不了。
 *
 * ③ **压缩只可能发生一次**（noRoomToCut 拿**折叠视图**判 ⇒ 恒真 ⇒ canShrink 恒假）
 *    设计定稿要求「再次达阈值 ⇒ 回到 ①」的多环压缩在实现里**结构性不可达**，
 *    而 `priorSummary` 递进路径成了死代码 ⇒ 二次压缩之间的轮次**从不进入任何摘要**（丢记忆）。
 *
 * ④ **降幅不足的假压缩永不熔断** + **摘要被输出上限腰斩却当完整摘要写进去**
 *    `ok` 只看「摘要非 null 且产物合法」，不看 `realShrink` ⇒ 白花调用且用户永远发不出去；
 *    `max_tokens: 1024` 触顶时半截文本 `trim()` 后非空 ⇒ 被当完整摘要 ⇒ **静默丢早期上下文**。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouteClient, providerKeyOfRoute, type RouteEntry } from "../../core-ts/src/router.js";
import { summarizeOutputCap, SUMMARIZE_OUTPUT_CAP } from "../../core-ts/src/services/context_compress.js";
import { marketSource } from "../../gui/src/renderer/pages/marketView.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再断言（注释里会**故意**写出旧写法/新写法的说明，不剥就是假红或假绿） */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");
/** 出现次数 —— 断言「唯一产地」时必须先证明它唯一，`toContain` 对同名多产地恒绿 */
function countOf(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/* ═════════════════ A 组：MCP 广场「归谁」的判据（纯逻辑）═════════════════ */

describe("A-1106 A 组 — MCP 广场数据源判据（「过一会自己变样」的根因判据化）", () => {
  it("A1 没搜过 ⇒ 内置精选（**打开广场不许被 registry 接管**）", () => {
    expect(marketSource("", 30)).toBe("builtin");
    expect(marketSource("   ", 30)).toBe("builtin");
  });

  it("A2 搜过且有结果 ⇒ registry 接管（这是唯一的接管路径）", () => {
    expect(marketSource("git", 12)).toBe("registry");
  });

  it("A3 ⚠️ 搜过但 0 条 ⇒ **仍走内置精选**（切过去是个空列表，比不切更糟）", () => {
    expect(marketSource("zzzz", 0)).toBe("builtin");
  });

  it("A4 空白串不算「搜过」（用户清空搜索框 ⇒ 必须回到内置精选）", () => {
    expect(marketSource("\t\n ", 5)).toBe("builtin");
  });

  it("A5 坏条数（负数 / NaN）按 0 处理（坏输入不许把内置列表顶掉）", () => {
    expect(marketSource("git", -1)).toBe("builtin");
    expect(marketSource("git", Number.NaN)).toBe("builtin");
  });
});

/* ═════════════════ B 组：广场的接线（判据唯一出处 + 打开不联网）═════════════════ */

const MCP = stripComments(readSrc("gui/src/renderer/pages/McpPanel.tsx"));

describe("A-1106 B 组 — 广场接线：唯一判据出处 + 打开不联网", () => {
  it("B1 列表判据必须来自 marketSource，**不许内联一份**（两个产地 = 改一处漏一处）", () => {
    expect(countOf(MCP, "marketSource(registryQuery"), "marketSource 的调用点必须恰好一处").toBe(1);
    expect(MCP).toContain("const useRegistry = marketSource(");
    expect(
      MCP,
      "内联判据回来了 —— 「搜索词非空 且 条数>0」是 marketView.marketSource 的职责，内联就是第二个产地",
    ).not.toMatch(/registryQuery\.trim\(\)\s*!==\s*""\s*&&/);
  });

  it("B2 ⚠️ 打开广场**不许联网**（旧实现的 effect 一开就 loadRegistry ⇒ 几秒后列表被无声替换）", () => {
    const at = MCP.indexOf("if (marketOpen) {");
    expect(at, "找不到 marketOpen 的 effect —— 守卫锚点失效，必须跟着迁（不许删）").toBeGreaterThan(-1);
    const seg = MCP.slice(at, MCP.indexOf("}, [marketOpen]", at));
    expect(seg, "打开广场又自动联网了 —— 这正是「过一会自己变样」的根因").not.toContain("loadRegistry");
    expect(seg, "打开广场必须回到内置精选视图").toContain("setShowAll(false)");
  });

  it("B3 清空搜索框 ⇒ 判据复位（否则清空后永远回不到内置精选）", () => {
    expect(MCP).toContain('if (e.target.value.trim() === "") { setRegistryQuery(""); }');
  });

  it("B4 registry 接管词只在「联网成功」分支里写入（失败不许把列表切过去）", () => {
    const at = MCP.indexOf("const res = await api.current.extras.mcpRegistrySearch(");
    expect(at, "找不到 registry 搜索调用点（锚点失效）").toBeGreaterThan(-1);
    const seg = MCP.slice(at, MCP.indexOf("} else { setRegistryError(", at));
    expect(seg).toContain("setRegistryQuery(term);");
  });
});

/* ═════════════════ C 组：createRouteClient 真的把 rateLimit 传进 client（行为）═════════════════ */

/** 四家 api_format 各一条路由 —— 生产链路（含降级）会在这四种之间切换，漏哪家都是漏 */
const ROUTES: Array<{ fmt: string; extra: Partial<RouteEntry> }> = [
  { fmt: "openai", extra: { baseUrl: "https://api.openai.com/v1", api_format: "openai", model: "gpt-4o-mini" } },
  { fmt: "anthropic", extra: { baseUrl: "https://api.anthropic.com/v1/messages", api_format: "anthropic", model: "claude-sonnet-4" } },
  { fmt: "google", extra: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api_format: "google", model: "gemini-2.0-flash" } },
  { fmt: "responses", extra: { baseUrl: "https://api.openai.com/v1", api_format: "responses", model: "o3-mini" } },
];
const mkRoute = (fmt: string, extra: Partial<RouteEntry>): RouteEntry =>
  ({ name: fmt, kind: "cloud", priority: 1, roles: ["chat"], ...extra }) as RouteEntry;
const readRateLimit = (client: unknown): unknown =>
  (client as { rateLimit?: unknown }).rateLimit;

describe("A-1106 C 组 — createRouteClient 必须给每条路由都带上 rateLimit 身份", () => {
  for (const { fmt, extra } of ROUTES) {
    it(`C-${fmt} client 上必须真的挂着 rateLimit（不是源码里写了就算数）`, () => {
      const route = mkRoute(fmt, extra);
      const client = createRouteClient(route);
      expect(readRateLimit(client), `${fmt} client 丢了 rateLimit ⇒ 该路的限流一次都不会执行`).toEqual({
        key: providerKeyOfRoute(route),
        model: route.model,
      });
    });
  }

  it("C-injected ⚠️ 注入 fetchImpl（生产注入 Chromium fetch 的**真实形态**）之后 rateLimit 仍在", () => {
    const route = mkRoute("openai", ROUTES[0].extra);
    const fakeFetch = (() => Promise.resolve(new Response("{}"))) as unknown as typeof fetch;
    const client = createRouteClient(route, fakeFetch);
    expect(
      readRateLimit(client),
      "注入 Chromium fetch 时把 rateLimit 挤掉了 —— 这正是生产链路此前漏限流的那条路径",
    ).toEqual({ key: providerKeyOfRoute(route), model: route.model });
  });

  it("C-model ⚠️ rateLimit.model 必须随**本条路由**的模型走（降级换模型后仍按新模型限流）", () => {
    const a = createRouteClient(mkRoute("openai", { ...ROUTES[0].extra, model: "model-a" }));
    const b = createRouteClient(mkRoute("openai", { ...ROUTES[0].extra, model: "model-b" }));
    expect(readRateLimit(a)).toEqual({ key: providerKeyOfRoute(mkRoute("openai", ROUTES[0].extra)), model: "model-a" });
    expect(readRateLimit(b)).toEqual({ key: providerKeyOfRoute(mkRoute("openai", ROUTES[0].extra)), model: "model-b" });
  });
});

/* ═════════════════ D 组：生产工厂不许另抄一份 ═════════════════ */

const MAIN_SRC = stripComments(readSrc("gui/src/main/index.ts"));

describe("A-1106 D 组 — 生产 clientFactory 必须复用唯一实现（漏 rateLimit 的那份就是这么来的）", () => {
  it("D1 生产工厂必须走 createRouteClient，只注入 Chromium fetch 这一项差异", () => {
    expect(MAIN_SRC).toContain("clientFactory: (route: RouteEntry) => createRouteClient(route, chromiumFetch as typeof fetch)");
  });

  it("D2 ⚠️ 主进程**不许**自己 new 任何 client 类（自建 = rateLimit 迟早再被漏一次）", () => {
    for (const cls of ["ChatClient", "AnthropicClient", "ResponsesClient", "GoogleClient"]) {
      expect(MAIN_SRC, `main 里自建了 ${cls} —— 请改用 createRouteClient（它带 rateLimit）`).not.toContain(`new ${cls}(`);
    }
  });

  it("D3 router 的**缺省**工厂同样是 createRouteClient（不传 factory 的调用方也要有限流）", () => {
    expect(readSrc("core-ts/src/router.ts")).toContain("this.createClient = createClientFn ?? createRouteClient;");
  });

  it("D4 createRouteClient 必须是 export（两个产地共用一个实现的前提）", () => {
    expect(readSrc("core-ts/src/router.ts")).toContain("export function createRouteClient(");
  });
});

/* ═════════════════ E 组：压缩判据必须看「原始全量」 ═════════════════ */

describe("A-1106 E 组 — 压缩判据看原始全量（看折叠视图 ⇒ 恒为「压无可压」⇒ 只压得了一次）", () => {
  it("E1 读盘与折叠拆成两步（压缩必须同时拿到「全量」与「折叠视图」）", () => {
    expect(MAIN_SRC).toContain("const { raw: historyAll, meta: histMeta } = await loadRawHistoryWithMeta(sessionId, { full: true });");
    expect(MAIN_SRC).toContain("const historyView = foldSessionHistory(historyAll, histMeta);");
  });

  it("E2 ⚠️ noRoomToCut 必须用**原始全量长度**（用折叠视图 ⇒ 恒真 ⇒ 多环压缩结构性不可达）", () => {
    expect(MAIN_SRC).toContain("const noRoomToCut = historyAll.length <= DEFAULT_TAIL_KEEP * 2 + 2;");
    // 反向：这一行里绝不许出现折叠视图
    const line = MAIN_SRC.split("\n").find((l) => l.includes("const noRoomToCut =")) ?? "";
    expect(line, "noRoomToCut 又拿折叠视图判了 —— 折叠视图恒为「摘要头+尾巴」，判据必然恒真").not.toContain("historyView");
    expect(line).not.toContain("foldSessionHistory");
  });

  it("E3 触发判据 / 历史指纹 / 摘要素材**三处**都必须用 historyAll（任一退回折叠视图 = 静默丢一段记忆）", () => {
    // A-1106：第 4 个参数**单位是轮数**，必须过 countTurns（旧写法传 historyAll.length =
    // 消息条数 ⇒ 6 轮门槛实际 2-3 轮就放行）。迁移自旧断言 `…ratio, historyAll.length),`。
    expect(MAIN_SRC).toContain("ratioTriggered: needsCompress(used, cap, ratio, countTurns(historyAll)),");
    expect(MAIN_SRC, "单位错配回归：触发判据又直接拿消息条数当轮数了").not.toContain("ratioTriggered: needsCompress(used, cap, ratio, historyAll.length),");
    expect(MAIN_SRC).toContain("const key = historyFingerprint(historyAll);");
    expect(MAIN_SRC).toContain("await engine.summarizeContext(agent, historyAll, {");
  });

  it("E4 折叠视图只许用于**体积估算**（它的职责是「真实会发出去多少」）", () => {
    expect(MAIN_SRC).toContain("const histUsed = estimateHistoryTokens(historyView);");
  });

  it("E5 压缩前后的可裁量口径一致：dropped 用 historyAll.length 减 after.length", () => {
    expect(MAIN_SRC).toContain("const dropped = Math.max(0, historyAll.length - after.length);");
  });
});

/* ═════════════════ F 组：假压缩必须能被熔断 ═════════════════ */

describe("A-1106 F 组 — 降幅不足的假压缩必须计入失败（否则熔断器永不开闸）", () => {
  it("F1 熔断判据必须含 realShrink（只看「摘要非 null 且产物合法」= 假压缩每次都算成功）", () => {
    expect(MAIN_SRC).toContain("ok: summaryText !== null && validation.ok && realShrink,");
  });

  it("F2 realShrink 必须在熔断**之前**算出（顺序反了 = 用到 undefined ⇒ 恒假 ⇒ 每次都熔断）", () => {
    const iShrink = MAIN_SRC.indexOf("const realShrink = isRealShrink(used, tokensAfter);");
    const iBreaker = MAIN_SRC.indexOf("compressBreaker = nextBreakerState(compressBreaker, {");
    expect(iShrink, "找不到 realShrink 的计算（锚点失效）").toBeGreaterThan(-1);
    expect(iBreaker, "找不到压缩熔断点（锚点失效）").toBeGreaterThan(-1);
    expect(iBreaker, "realShrink 必须在熔断之前算出来").toBeGreaterThan(iShrink);
  });

  it("F3 返回给界面的 realShrink 复用同一个变量（不许另算一次，两处口径会漂移）", () => {
    expect(MAIN_SRC).toContain("        realShrink,\n");
    expect(MAIN_SRC).not.toContain("realShrink: isRealShrink(used, tokensAfter),");
  });
});

/* ═════════════════ G 组：摘要不许被输出上限腰斩却当完整摘要 ═════════════════ */

const ENG_SRC = stripComments(readSrc("core-ts/src/services/engine.ts"));

describe("A-1106 G 组 — 摘要输出上限按输入自适应 + 截断可见", () => {
  it("G1 小输入保留下界 1024（不无谓收紧），坏输入同样落回下界", () => {
    expect(summarizeOutputCap(1000)).toBe(1024);
    expect(summarizeOutputCap(0)).toBe(1024);
    expect(summarizeOutputCap(Number.NaN)).toBe(1024);
    expect(summarizeOutputCap(-5)).toBe(1024);
  });

  it("G2 大输入按 1:4 放大", () => {
    expect(summarizeOutputCap(8000)).toBe(2000);
  });

  it("G3 绝对封顶（不许无界放大成一个新的烧钱口）", () => {
    expect(summarizeOutputCap(24000)).toBe(SUMMARIZE_OUTPUT_CAP);
    expect(summarizeOutputCap(1e9)).toBe(SUMMARIZE_OUTPUT_CAP);
  });

  it("G4 边界：4096 ⇒ 1024（恰好下界占优）；4097 ⇒ 1025（跨过下界后线性）", () => {
    expect(summarizeOutputCap(4096)).toBe(1024);
    expect(summarizeOutputCap(4097)).toBe(1025);
  });

  it("G5 ⚠️ engine 里摘要轮**不许**再写死 max_tokens: 1024（腰斩的直接产地）", () => {
    expect(ENG_SRC).toContain("max_tokens: maxOut,");
    expect(ENG_SRC, "又写死 1024 了 —— CJK 长会话摘要会被腰斩").not.toMatch(/max_tokens:\s*1024/);
  });

  it("G6 ⚠️ 必须检查上游 finish_reason === length（不看 ⇒ 半截摘要静默当完整）", () => {
    expect(ENG_SRC).toContain('finish_reason === "length"');
  });

  it("G7 截断时抬满上限**重试恰好一次**（不许成环重试）", () => {
    expect(ENG_SRC).toContain("if (truncated && maxOut < SUMMARIZE_OUTPUT_CAP) {");
    expect(countOf(ENG_SRC, "await router.chat(withModel(ask("), "摘要轮只许有 2 次发送：首次 + 抬满重试一次").toBe(2);
  });

  it("G8 仍截断 ⇒ **如实标记**并传导到界面（不许静默当完整摘要）", () => {
    expect(ENG_SRC).toContain("return { summary: trimmed, inputTokens, elided, truncated };");
    expect(ENG_SRC).toContain('truncated: boolean } | null>');
    expect(MAIN_SRC).toContain("summaryTruncated = s.truncated;");
    expect(MAIN_SRC).toContain("summaryTruncated,");
  });

  it("G9 elided（中段消息未进摘要）与 truncated 都必须**出声**（两条独立的丢记忆路径）", () => {
    expect(MAIN_SRC).toContain("if (s.elided > 0 || s.truncated) {");
    expect(MAIN_SRC).toContain("摘要不完整（丢记忆风险）");
  });

  it("G10 IPC 契约里两个标记都在（否则界面拿不到、也没法如实提示）", () => {
    const ipc = stripComments(readSrc("gui/src/shared/ipc.ts"));
    expect(ipc).toContain("elided?: number;");
    expect(ipc).toContain("summaryTruncated?: boolean;");
  });
});
