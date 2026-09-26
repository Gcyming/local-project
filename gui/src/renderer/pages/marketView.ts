/**
 * marketView.ts — A-1106：插件广场「当前列表归谁」的**唯一判据**（纯逻辑，可测）。
 *
 * ## 用户报障
 *
 *   「为什么 mcp 栏的广场刚打开是这样（内置精选 20）正常的，过一会就变成（官方 registry 30）样子了？」
 *
 * ## 根因
 *
 *   `McpPanel` 打开广场时自动联网拉官方 registry；网络返回后列表判据只看「联网是否拿到数据」，
 *   于是整个列表被替换成 registry 的 30 条按字母序通用目录项（`ac.inference.sh/mcp` 之类），
 *   而内置精选（filesystem / playwright / memory …，**唯一带准确安装命令**的那批）无声消失。
 *   症状表现为「列表自己变了」，用户根本不知道还能回到内置。
 *
 * ## 判据
 *
 *   只有**用户主动搜索过（搜索词非空）且确实拿到了结果**，registry 结果才接管列表；
 *   其余情况（没搜过 / 清空了搜索框 / 搜到 0 条）一律显示**内置精选**。
 *
 *   ⚠️ 判据必须用「最近一次生效的搜索词」（`registryQuery`），**不能用输入框当前值** ——
 *      否则用户一打字（还没回车）列表就会在两种数据源之间跳变。
 *   ⚠️ 必须要求 `registryCount > 0` —— 否则「搜了但 0 条」会得到一个**空列表**，
 *      比回退到内置精选更糟（镜像形态：把合法空结果渲染成故障）。
 */
import { expandMarketQuery } from "../../../../core-ts/src/services/marketLocalize.js";

export type MarketSource = "registry" | "builtin";

/**
 * A-1106：**联网目录是否接管列表** —— 两个广场共用这条判据。
 *
 * 唯一的核心是第一个参数：`requested` 必须是**用户主动动作**的结果
 * （MCP 广场 = 用户输入了搜索词；技能广场 = 用户点了「拉取官方仓库」）。
 *
 * ⚠️ **绝不许退化成只看 `onlineCount > 0`** —— 那正是 A-1106 修掉的静默失效形态：
 *    面板打开就自动联网，网络一返回就把首屏（内置/预制精选）整体换掉，
 *    用户没要求过、也没有任何提示，只觉得「列表自己变了」。
 *
 * ⚠️ `onlineCount > 0` 这一条也不能省：搜到 0 条时若接管列表，用户会得到一个**空列表**，
 *    比回退到本地精选更糟（镜像形态：把合法空结果渲染成故障）。
 */
export function onlineSourceActive(requested: boolean, onlineCount: number): boolean {
  return requested && onlineCount > 0;
}

/** A-1106：广场列表数据源判定。`registryQuery` = 最近一次生效的搜索词；`registryCount` = 已拿到的条数。
 *
 *  MCP 广场专用（registry 是「按搜索词查」的，所以「请求信号」= 搜索词非空；
 *  `trim()` 必须留在本判据里 —— 空白搜索词不算「搜过」）。
 *  技能广场走 `onlineSourceActive`（它的官方仓库是一次性拉全量，请求信号是「点过拉取」）。
 */
export function marketSource(registryQuery: string, registryCount: number): MarketSource {
  return onlineSourceActive(registryQuery.trim() !== "", registryCount) ? "registry" : "builtin";
}

/* ═════════════ 技能广场：本地过滤（「一次性拉全量 + 本地过滤」模型）═════════════ */

/**
 * A-1106：技能广场的**本地匹配关键词**（纯逻辑、可测；唯一出处）。
 *
 * 技能广场（`SkillsPanel`）与 MCP 广场的数据源形态**不同**：官方技能仓库（`anthropics/skills`）
 * 是一次性拉全量 + 渲染层本地过滤，上游没有检索能力 —— 所以「中文能不能搜到」这件事
 * 完全落在**本地比什么字段**上。
 *
 * 而两个数据源**语言不同**：
 *   · 预制精选 —— `name` / `description` / `tags` 全是**中文**；
 *   · 官方仓库 —— `name` / `description` 是**英文原文**（源自各技能 SKILL.md 的 frontmatter）。
 *
 * 所以匹配关键词必须是**原输入 + 展开后英文关键词的并集**：
 *   · 只带展开词 ⇒ 中文搜「搜索」匹配不到预制里那句中文描述（"修一个坏一个"的镜像）；
 *   · 只带原输入 ⇒ 中文搜官方仓库**恒不命中**（这正是本次要修的那一层）。
 *
 * ⚠️ 未收录的纯中文（词典没这个词）⇒ 首个 needle 就是原输入本身，`unrecognized` 由
 *    `expandMarketQuery` 交回调用方，调用方**必须如实提示**（不许静默显示「没找到」）。
 */
export function marketNeedles(input: string): string[] {
  const e = expandMarketQuery(input);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [e.raw, ...e.terms]) {
    const k = (t ?? "").toLowerCase();
    if (k === "" || seen.has(k)) { continue; }
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * A-1106：技能广场的本地过滤（**唯一实现**；`marketNeedles` 的消费者）。
 *
 * `needles` 为空 ⇒ 不过滤（返回全量）；否则任一 needle 命中 `name` / `description` / `tags`
 * 即保留。**任一命中**（OR）而不是全部命中 —— 中文口语输入会展开出多个英文关键词，
 * 按 AND 收窄必然得到空列表。
 */
export function filterMarketItems<T extends { name: string; description: string; tags?: string[] }>(
  list: readonly T[],
  needles: readonly string[],
): T[] {
  const ns = (needles ?? []).map((n) => (n ?? "").trim().toLowerCase()).filter((n) => n !== "");
  if (ns.length === 0) { return [...list]; }
  return list.filter((it) => {
    const hay = `${it.name} ${it.description} ${(it.tags ?? []).join(" ")}`.toLowerCase();
    return ns.some((n) => hay.includes(n));
  });
}
