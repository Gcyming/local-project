/**
 * tests/gui/a1125-settings-order.spec.ts — A-1125：设置左栏的**分组与排序**守卫。
 *
 * 用户实测原话：「现在设置栏的菜单排序很混乱，你自己衡量一下各个板块的重要性以及使用频率，
 * 进行综合排序」。修复 = 把 13 个平铺栏目改成 **4 个语义组**、组内按「频率 × 重要性」重排。
 *
 * 依据（**不是我的偏好**，两条都是权威一手口径，见 `SettingsDialog.tsx` 的 `SECTIONS` 注释）：
 *   · Android 官方设置规范：11~15 项 ⇒ 用 **2~4 个分组分隔符**；重要/高频前置、实验性垫底；
 *   · Nielsen Norman Group：选项列表不该按字母/随意排，应按**重要度或频率** + 逻辑结构。
 *   本项目自身的一手证据：`ChatPanel.tsx:4785-4791` 的 3 处程序跳转（状态 / Agent / 供应商）
 *   + `App.tsx:1685` 齿轮按钮标题点名的 4 个栏目。
 *
 * 本 spec 锁四件事，**全属静默失效类**（改坏了 tsc 照样过、构建照样过、搜索照样"能搜"）：
 *   ① **顺序**：`SECTIONS` 的 id 顺序 === 期望顺序（乱序 = 用户看到的「混乱」原样复发）；
 *   ② **分组**：每项 `group` 的归属正确，且 4 个组都非空（掉组 = 有栏目从不显示，**最危险**）；
 *   ③ **字段完整性**：每项 `keywords` / `features` 的**条数**必须与期望一致 ——
 *      重排时最容易"搬漏一行"，而漏一个 feature **不报错**，只是让搜索"搜不到那个功能"
 *      （`A-980-R23` 的全部价值就被悄悄削掉一层）；
 *   ④ **渲染与样式接线**：分组渲染真的接了（`SECTION_GROUPS.map` + `.settings-group-title`），
 *      且**搜索态仍是扁平**（分组只在浏览态出，见实现注释）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const SRC = readFileSync(resolve(ROOT, "gui/src/renderer/pages/SettingsDialog.tsx"), "utf8");
const CSS = readFileSync(resolve(ROOT, "gui/src/renderer/index.css"), "utf8");

/** 剥注释：注释里写着"曾经是什么"/对照写法，不该被当成当前代码断言（本仓 §24 家族）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CODE = stripComments(SRC);

/** 左栏显示顺序（**唯一判据**）。改它 = 改产品行为，必须连同 `SettingsDialog.tsx` 的
 *  「排序依据」注释一起更新 —— 那张依据表才是防"下一个维护者凭感觉再动一遍"的东西。 */
const EXPECTED_ORDER = [
  "general", "appearance", "permissions", "providers",      // 组 ① 常用
  "agents", "mind", "skills", "mcp", "resident",            // 组 ② Agent 与能力
  "runtime", "usage", "status",                             // 组 ③ 运行与维护
  "experimental",                                           // 组 ④ 高级
];

/** 分组归属（`sectionId → groupId`） */
const EXPECTED_GROUP: Record<string, string> = {
  general: "common", appearance: "common", permissions: "common", providers: "common",
  agents: "agent", mind: "agent", skills: "agent", mcp: "agent", resident: "agent",
  runtime: "ops", usage: "ops", status: "ops",
  experimental: "advanced",
};

/** 搜索索引的**条数**（不是内容 —— 内容由实现保证；条数专防"搬漏一行"）。
 *  ⚠️ 增删 feature/keyword 是**有意的产品动作**，届时同步改这两个表；
 *     而"重排时少抄一个"会被这里当场抓住。 */
const EXPECTED_KW: Record<string, number> = {
  general: 10, appearance: 12, permissions: 6, providers: 6,
  agents: 5, mind: 8, skills: 3, mcp: 4, resident: 8,
  runtime: 9, usage: 8, status: 4,
  experimental: 10,
};
const EXPECTED_FT: Record<string, number> = {
  general: 35, appearance: 16, permissions: 14, providers: 12,
  agents: 14, mind: 10, skills: 10, mcp: 10, resident: 17,
  runtime: 10, usage: 8, status: 7,
  experimental: 12,
};

interface Parsed { id: string; label: string; group: string; kw: number; ft: number }

/** 从源码里解析 `SECTIONS` 数组（静态解析，与 `SettingsDialog.tsx` 的唯一产地一一对应）。 */
function parseSections(): Parsed[] {
  const at = CODE.indexOf("const SECTIONS");
  expect(at, "找不到 SECTIONS 定义").toBeGreaterThan(-1);
  const body = CODE.slice(at, CODE.indexOf("\n];", at));
  const out: Parsed[] = [];
  const re = /\{\s*id: "([a-z]+)",\s*label: "([^"]+)",\s*group: "([a-z]+)",\s*keywords: \[([\s\S]*?)\],\s*features: \[([\s\S]*?)\],\s*\}/g;
  const count = (s: string) => (s.match(/"[^"]*"/g) ?? []).length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push({ id: m[1], label: m[2], group: m[3], kw: count(m[4]), ft: count(m[5]) });
  }
  return out;
}

const SECTIONS = parseSections();

describe("A-1125 设置左栏：分组与排序", () => {
  it("① 13 个栏目一项不少（掉一项 = 那个板块从界面上消失）", () => {
    expect(SECTIONS.length, `解析到 ${SECTIONS.length} 项，应为 13`).toBe(13);
    expect(SECTIONS.map((s) => s.id).sort()).toEqual([...EXPECTED_ORDER].sort());
  });

  it("② 顺序 === 「频率 × 重要性」排序结果（乱序 = 用户报的「很混乱」原样复发）", () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(EXPECTED_ORDER);
  });

  it("③ 每项的 group 归属正确（改错组 = 用户去错的组里找）", () => {
    for (const s of SECTIONS) {
      expect(s.group, `${s.id} 的分组应为 ${EXPECTED_GROUP[s.id]}，实为 ${s.group}`).toBe(EXPECTED_GROUP[s.id]);
    }
  });

  it("④ 四个组都非空、顺序正确（空组 = 一个栏目从不显示；组顺序 = 用户在左栏看到的先后）", () => {
    /* `SECTIONS` 里出现的组必须 == `SECTION_GROUPS` 声明的组 —— 两边任一多出/缺少都要拦住：
       · 组声明了但没人用 ⇒ 空标题；
       · 组用了但没声明 ⇒ 该栏目**永远不渲染**（`filter(g === id)` 永不命中）。后者最危险。
       ⚠️ 比对**不能只 `.sort()` 后比集合**：那样组顺序改动（"常用"不再在最上）无人管 ——
          而组顺序正是用户看到的先后，与组内顺序同等重要。故声明顺序必须逐项相等。 */
    const declared = [...SRC.matchAll(/\{\s*id:\s*"(common|agent|ops|advanced)",\s*label:\s*"[^"]+"\s*\}/g)].map((m) => m[1]);
    expect(declared, "SECTION_GROUPS 声明的组（数目与顺序都算）").toEqual(["common", "agent", "ops", "advanced"]);
    const used = [...new Set(SECTIONS.map((s) => s.group))].sort();
    expect(used).toEqual([...declared].sort());
  });

  it("⑤ 每项的 keywords / features 条数不发生缩水（重排搬漏一行不报错，只会让搜索搜不到）", () => {
    for (const s of SECTIONS) {
      expect(s.kw, `${s.id} 的 keywords 只剩 ${s.kw} 条（应 ${EXPECTED_KW[s.id]}）—— 重排时搬漏了`)
        .toBe(EXPECTED_KW[s.id]);
      expect(s.ft, `${s.id} 的 features 只剩 ${s.ft} 条（应 ${EXPECTED_FT[s.id]}）—— 重排时搬漏了`)
        .toBe(EXPECTED_FT[s.id]);
    }
  });

  it("⑥ 分组渲染真的接上了（且搜索态仍是扁平 —— 命中结果是精准的，插组标题只是噪音）", () => {
    expect(CODE, "没有按 SECTION_GROUPS 分组渲染").toMatch(/SECTION_GROUPS\.map\(/);
    expect(CODE, "分组标题的类名变了（CSS 那边就失效了）").toContain('className="settings-group-title"');
    // 空组不许画标题
    expect(CODE, "空组会画出光秃秃的组标题").toMatch(/if \(items\.length === 0\) \{ return null; \}/);
    // 搜索态扁平：分流判据必须在
    expect(CODE, "搜索态与浏览态没有分流（结果里会插组标题）")
      .toMatch(/if \(tokens\.length > 0\) \{ return filtered\.map\(renderItem\); \}/);
  });

  it("⑦ 分组标题的样式存在且**唯一产地**，并且它是「不可点」的弱化样式", () => {
    expect(CSS, "分组标题样式缺失（渲染出裸文字，视觉上没分层）").toMatch(/\.settings-group-title \{/);
    /* ⚠️ 判据不是"看着像"，而是三条具体形态：弱色 + 不可选中 + 首个标题吃掉多余上间距。
       少 `user-select: none` ⇒ 用户会以为它是可点的（它不是按钮）。 */
    const at = CSS.indexOf(".settings-group-title {");
    const blk = CSS.slice(at, CSS.indexOf("}", at));
    expect(blk, "分组标题必须是弱色（不抢可点条目的视觉权重）").toMatch(/color: var\(--text-dim\)/);
    expect(blk, "分组标题必须 user-select: none（它不是按钮，别让人去点/选中）").toContain("user-select: none;");
    expect(CSS, "首个组标题没有吃掉多余上间距（搜索框下方会空一道）")
      .toMatch(/\.settings-group-title:first-child \{ padding-top: 2px; \}/);
    // 唯一产地：不许再有第二个类名承载"组标题"这个语义（主规则 + :first-child 规则 = 2 处）
    expect((CSS.match(/\.settings-group-title\b/g) ?? []).length, "分组标题样式有第二个产地").toBe(2);
  });
});
