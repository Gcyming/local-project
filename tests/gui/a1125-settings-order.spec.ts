




















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const SRC = readFileSync(resolve(ROOT, "gui/src/renderer/pages/SettingsDialog.tsx"), "utf8");
const CSS = readFileSync(resolve(ROOT, "gui/src/renderer/index.css"), "utf8");


function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CODE = stripComments(SRC);



const EXPECTED_ORDER = [
  "general", "appearance", "permissions", "providers",      
  "agents", "mind", "skills", "mcp", "plugins", "resident", 
  "runtime", "searchengine", "usage", "status",             
  "experimental",                                           
];


const EXPECTED_GROUP: Record<string, string> = {
  general: "common", appearance: "common", permissions: "common", providers: "common",
  agents: "agent", mind: "agent", skills: "agent", mcp: "agent", plugins: "agent", resident: "agent",
  runtime: "ops", searchengine: "ops", usage: "ops", status: "ops",
  experimental: "advanced",
};




const EXPECTED_KW: Record<string, number> = {
  general: 10, appearance: 12, permissions: 6, providers: 6,
  agents: 5, mind: 8, skills: 3, mcp: 4, plugins: 7, resident: 8,
  runtime: 9, searchengine: 8, usage: 8, status: 4,
  experimental: 10,
};
const EXPECTED_FT: Record<string, number> = {
  general: 35, appearance: 16, permissions: 14, providers: 12,
  agents: 14, mind: 10, skills: 10, mcp: 10, plugins: 14, resident: 17,
  runtime: 10, searchengine: 12, usage: 8, status: 7,
  experimental: 12,
};

interface Parsed { id: string; label: string; group: string; kw: number; ft: number }


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
  it("① 15 个栏目一项不少（掉一项 = 那个板块从界面上消失）", () => {
    expect(SECTIONS.length, `解析到 ${SECTIONS.length} 项，应为 15`).toBe(15);
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
    
    expect(CODE, "空组会画出光秃秃的组标题").toMatch(/if \(items\.length === 0\) \{ return null; \}/);
    
    expect(CODE, "搜索态与浏览态没有分流（结果里会插组标题）")
      .toMatch(/if \(tokens\.length > 0\) \{ return filtered\.map\(renderItem\); \}/);
  });

  it("⑦ 分组标题的样式存在且**唯一产地**，并且它是「不可点」的弱化样式", () => {
    expect(CSS, "分组标题样式缺失（渲染出裸文字，视觉上没分层）").toMatch(/\.settings-group-title \{/);
    

    const at = CSS.indexOf(".settings-group-title {");
    const blk = CSS.slice(at, CSS.indexOf("}", at));
    expect(blk, "分组标题必须是弱色（不抢可点条目的视觉权重）").toMatch(/color: var\(--text-dim\)/);
    expect(blk, "分组标题必须 user-select: none（它不是按钮，别让人去点/选中）").toContain("user-select: none;");
    expect(CSS, "首个组标题没有吃掉多余上间距（搜索框下方会空一道）")
      .toMatch(/\.settings-group-title:first-child \{ padding-top: 2px; \}/);
    
    expect((CSS.match(/\.settings-group-title\b/g) ?? []).length, "分组标题样式有第二个产地").toBe(2);
  });
});
