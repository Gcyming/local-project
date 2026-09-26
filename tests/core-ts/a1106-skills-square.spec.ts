/**
 * tests/core-ts/a1106-skills-square.spec.ts — A-1106 续：技能广场的 MCP 广场**同款**缺陷。
 *
 * 用户原话：「你就看看 skill 的广场，看看有没有 mcp 广场同款的问题」。
 *
 * 逐条比对 MCP 广场那三件缺陷，技能广场**三件全中**：
 *
 * | # | MCP 广场的缺陷 | 技能广场的旧形态 |
 * |---|---|---|
 * | ① | 打开广场就联网，网络一返回把内置精选**整个替换**掉 | `useEffect(() => { if (marketOpen) { void loadMarket(); } })`；判据是 `marketOnline !== null` |
 * | ② | 列表「归谁」的判据内联在组件里 | 同上（`marketOnline !== null` 就是判据本体，没有唯一出处函数） |
 * | ③ | 官方 registry 全是英文，中文用户无从下手 | 官方仓库（`anthropics/skills`）的 name/description 是**英文原文**，且中文检索词恒搜不到 |
 *
 * ## 两个广场的**数据源形态不同**（所以判据不能照抄）
 *
 *    · MCP registry = **搜索后端**：请求信号 = 搜索词非空（`marketSource`）。
 *    · 技能官方仓库 = **一次性拉全量 + 本地过滤**：请求信号 = 用户点过「拉取官方仓库」
 *      （`onlineSourceActive(requestedOnline, count)`）。
 *
 *  而本地过滤必须带上**原输入 + 展开后英文关键词的并集**：预制列表是中文、官方仓库是英文，
 *  只带其中一边必然"修一个坏一个"。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marketNeedles, filterMarketItems, onlineSourceActive } from "../../gui/src/renderer/pages/marketView.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再断言（注释里会**故意**写出旧写法/新写法的说明，不剥就是假红或假绿） */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

const SKILLS = stripComments(readSrc("gui/src/renderer/pages/SkillsPanel.tsx"));

/* ═════════════════ S 组：判据与接线（静默失效家族 ⑬ 的同款形态）═════════════════ */

describe("A-1106 S 组 — 技能广场：拉取由用户发起、判据唯一出处、中文可搜", () => {
  it("S1 联网判据必须来自 `onlineSourceActive`，**不许**退化成「联网有没有数据」", () => {
    expect(SKILLS).toContain("const useOnline = onlineSourceActive(requestedOnline, marketOnline?.length ?? 0);");
    expect(
      SKILLS,
      "判据退回 `marketOnline !== null` 了 —— 那正是「打开广场几秒后列表自己变样」的根因",
    ).not.toContain("const useOnline = marketOnline !== null;");
  });

  it("S2 ⚠️ 打开广场**不许联网**（旧实现的 effect 一开就 loadMarket ⇒ 几秒后预制列表被无声替换）", () => {
    const at = SKILLS.indexOf("if (marketOpen) {");
    expect(at, "找不到 marketOpen 的 effect —— 守卫锚点失效，必须跟着迁（不许删）").toBeGreaterThan(-1);
    const end = SKILLS.indexOf("}, [marketOpen]", at);
    expect(end, "找不到 effect 的依赖数组（锚点失效）").toBeGreaterThan(at);
    const seg = SKILLS.slice(at, end);
    expect(seg, "打开广场又自动联网了 —— 这正是「刚打开是预制、过一会变成官方仓库」的根因").not.toContain("loadMarket");
  });

  it("S3 联网只许由**显式动作**发起（按钮），不许有第二条自发路径", () => {
    expect(SKILLS).toContain("onClick={() => void loadMarket(true)}");
    // `loadMarket(` 的调用点只有两处：按钮（显式）与 saveToken（**条件**，见 S5）。
    // 定义处写的是 `const loadMarket = React.useCallback(` ⇒ 不含 `loadMarket(`，不计入。
    expect(countOf(SKILLS, "loadMarket("), "loadMarket 的调用点：按钮 1 + saveToken 条件 1").toBe(2);
  });

  it("S4 ⚠️ 「官方仓库接管列表」只许在**联网成功**分支里置真（失败/空结果必须留在预制视图）", () => {
    const ok = SKILLS.indexOf("if (res?.ok && Array.isArray(res.skills)) {");
    const call = SKILLS.indexOf("setRequestedOnline(true);");
    const elseAt = SKILLS.indexOf("} else {", ok);
    expect(ok, "找不到成功分支（锚点失效）").toBeGreaterThan(-1);
    expect(call, "找不到置真点（锚点失效）").toBeGreaterThan(-1);
    expect(elseAt, "找不到失败分支（锚点失效）").toBeGreaterThan(ok);
    expect(call, "「接管列表」必须在成功分支**之内**（放在 if 之前 = 失败也接管）").toBeGreaterThan(ok);
    expect(call, "「接管列表」被挪到 else 里去了").toBeLessThan(elseAt);
  });

  it("S5 ⚠️ 保存 Token **不许**无条件把用户从预制视图切到官方仓库（同款「没要求就换列表」）", () => {
    expect(SKILLS).toContain("if (requestedOnline) { await loadMarket(true); }");
  });

  it("S6 过滤判据必须来自 `filterMarketItems`（**不许内联一份** = 第二个产地）", () => {
    expect(SKILLS).toContain("const filtered = filterMarketItems(sourceList, needles);");
    expect(
      SKILLS,
      "内联过滤回来了 —— 展开词/原输入的并集规则是 marketView.marketNeedles 的职责",
    ).not.toMatch(/it\.name\.toLowerCase\(\)\.includes\(q\)/);
  });

  it("S7 官方仓库条目必须产**中文类别标签**（否则又是一屏英文），且那是唯一出处", () => {
    expect(SKILLS).toContain("tags: localizeServerTags(s.name, s.description),");
    expect(countOf(SKILLS, "localizeServerTags("), "标签判据不许在组件里再写一份").toBe(1);
  });

  it("S8 未收录的中文词必须**如实提示**（不许把「词没认出来」说成「没找到」）", () => {
    expect(SKILLS).toContain("未收录「${q}」对应的英文关键词");
    expect(SKILLS, "实际匹配词也要如实显示").toContain("（实际匹配词：${expansion.query}）");
  });
});

/* ═════════════════ T 组：本地匹配关键词（纯逻辑）═════════════════ */

describe("A-1106 T 组 — 技能广场的本地匹配关键词（两个数据源语言不同）", () => {
  it("T1 `marketNeedles` = **原输入 + 展开词**的并集（只带一边必然「修一个坏一个」）", () => {
    expect(marketNeedles("浏览器")).toEqual(["浏览器", "browser"]);
    expect(marketNeedles("搜索")).toEqual(["搜索", "search"]);
  });

  it("T2 纯英文原样透传（英文用户不受影响），去重后只剩一个", () => {
    expect(marketNeedles("playwright")).toEqual(["playwright"]);
    expect(marketNeedles("search 搜索")).toEqual(["search 搜索", "search"]);
  });

  it("T3 ⚠️ 未收录的纯中文 ⇒ needle 就是原输入本身（不许静默丢弃、也不许发明关键词）", () => {
    expect(marketNeedles("量子纠缠")).toEqual(["量子纠缠"]);
  });

  it("T4 空输入 ⇒ 空数组（语义 = 不过滤）", () => {
    expect(marketNeedles("")).toEqual([]);
    expect(marketNeedles("   ")).toEqual([]);
  });

  it("T5 `filterMarketItems`：空 needles ⇒ 全量（不是空列表）", () => {
    const list = [{ name: "a", description: "甲" }, { name: "b", description: "乙" }];
    expect(filterMarketItems(list, [])).toHaveLength(2);
    expect(filterMarketItems(list, ["", "  "])).toHaveLength(2);
  });

  it("T6 ⚠️ 中文输入必须能搜到**英文**的官方仓库条目（原输入中文 + 展开词英文的并集）", () => {
    const official = [{ name: "playwright-mcp", description: "Browser automation: navigate, click, screenshot", tags: [] }];
    expect(
      filterMarketItems(official, marketNeedles("浏览器")),
      "中文输入搜不到英文仓库 —— 这就是本次要修的那一层（官方仓库的说明全是英文）",
    ).toHaveLength(1);
  });

  it("T7 ⚠️ 中文输入必须**仍然**能搜到中文的预制条目（只带展开词 = 把中文匹配弄坏）", () => {
    const preset = [{ name: "web-research", description: "联网研究：拆解问题 → 多源搜索 → 交叉验证", tags: ["搜索", "研究"] }];
    expect(filterMarketItems(preset, marketNeedles("搜索"))).toHaveLength(1);
  });

  it("T8 任一关键词命中即保留（OR，不是 AND —— 口语输入会展开出多个词）", () => {
    const list = [{ name: "x", description: "只有 browser 这一个词" }];
    expect(filterMarketItems(list, ["browser", "database"])).toHaveLength(1);
    expect(filterMarketItems(list, ["database", "calendar"])).toHaveLength(0);
  });

  it("T9 匹配大小写不敏感（官方仓库的描述大小写不统一）", () => {
    const list = [{ name: "X", description: "BROWSER Automation" }];
    expect(filterMarketItems(list, ["browser"])).toHaveLength(1);
    expect(filterMarketItems(list, ["BROWSER"])).toHaveLength(1);
  });

  it("T10 判据本体还在（`onlineSourceActive` 仍是唯一的「接管」判据）", () => {
    expect(onlineSourceActive(false, 30), "没请求过 ⇒ 不许接管（哪怕联网拿到了数据）").toBe(false);
    expect(onlineSourceActive(true, 30)).toBe(true);
    expect(onlineSourceActive(true, 0), "请求过但 0 条 ⇒ 留在预制（切过去是空列表）").toBe(false);
  });
});
