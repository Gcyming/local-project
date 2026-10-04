






































import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CSS = stripComments(read("gui/src/renderer/index.css"));
const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
const SIDEBAR = read("gui/src/renderer/pages/RightSidebar.tsx");


const PANEL_C = stripComments(PANEL);
const SIDEBAR_C = stripComments(SIDEBAR);


function rule(sel: string): string {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp("(?:^|\\n)" + esc + "\\s*\\{").exec(CSS);
  expect(m, `找不到以行首起头的选择器 ${sel}`).toBeTruthy();
  const open = CSS.indexOf("{", m!.index);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

describe("A-1130-A 唯一判据：容器 grid + 列宽 minmax(min-content, 1fr)", () => {
  it("`.diff-rows-fit` 就是那条判据（grid + 弹性列轨）", () => {
    const r = rule(".diff-rows-fit");
    expect(r, "不是 grid ⇒ 行宽各按自己的内容算（用户报的「只加在字后面」）").toMatch(/display:\s*grid/);
    expect(r, "列宽没有 min-content ⇒ 长行的底色到不了滚动内容的最右（A-1109 的成果丢了）").toContain("min-content");
    expect(r, "列宽没有 1fr（弹性）⇒ 内容比可视区窄时列轨不涨到可视宽 ⇒ 短行右侧缺一块底色").toContain("1fr");
    expect(r, "列宽写法变了（应为 minmax(min-content, 1fr)）").toMatch(/minmax\(\s*min-content\s*,\s*1fr\s*\)/);
  });

  it("⚠️ **不许**退回 `minmax(100%, max-content)`：`100%` 会吃掉 free space", () => {
    


    const r = rule(".diff-rows-fit");
    expect(r, "又用 100% 当列轨下界 ⇒ 有长行时行盒停在可视宽、底色断掉（实测 874 < 1243）")
      .not.toMatch(/minmax\(\s*100%\s*,/);
    expect(r, "列轨里出现了 max-content 上界 ⇒ 弹性被吃掉的写法又回来了")
      .not.toMatch(/max-content/);
  });

  it("⚠️ 行上**不许**写宽度：definite width 会让 grid item 不再 stretch，直接退回逐行宽度", () => {
    const row = rule(".think-diff-row");
    expect(row, "行上又写了 width ⇒ 行宽回到「这一行自己的字宽」").not.toMatch(/(^|[;\s])width\s*:/);
    expect(row, "行上又写了 min-width: 100% ⇒ 只兜到可视宽，横向滚动后短行右侧露白")
      .not.toMatch(/min-width\s*:\s*100%/);
    
    expect(row, "`.think-diff-row` 的底色仍在（这是它的本职）").toContain("padding");
  });

  it("行底色仍取主题变量（A-1051 的成果不许被这次改动带走）", () => {
    expect(CSS).toMatch(/\.think-diff-row\.diff-add\s*\{\s*background:\s*var\(--diff-add-bg\)/);
    expect(CSS).toMatch(/\.think-diff-row\.diff-del\s*\{\s*background:\s*var\(--diff-del-bg\)/);
  });
});

describe("A-1130-B 接线：三个 diff 滚动容器**都**要戴这个类", () => {
  it("工具卡 / 思考历程的 diff（`.think-diff-body`）戴上了", () => {
    expect(PANEL_C, "ChatPanel 的 diff 容器没戴 diff-rows-fit ⇒ 底色还是只到字末")
      .toContain('className="think-diff-body diff-rows-fit"');
  });

  it("右栏的两处 diff 都戴上了（一处是 git diff，一处是逐行 diff）", () => {
    const n = SIDEBAR_C.split("diff-rows-fit").length - 1;
    expect(n, `RightSidebar 里 diff-rows-fit 出现 ${n} 次，应为 2（两处 diff 容器）—— 漏一处就是「这儿到边那儿不到」`)
      .toBe(2);
    expect(SIDEBAR_C, "右栏 git diff 容器仍是手抄的内联样式（同一事实两个产地）")
      .toContain('className="think-diff-body diff-rows-fit"');
    expect(SIDEBAR_C, "右栏逐行 diff 容器没戴").toContain('className="diff-rows-fit"');
  });

  it("⚠️ 会**换行**的那种 diff（`.prod-diff`）**不许**戴 —— 戴上会取消换行、长行直接溢出", () => {
    


    const at = PANEL_C.indexOf('className="prod-diff"');
    expect(at, "找不到 .prod-diff 容器（锚点漂移？）").toBeGreaterThan(-1);
    const line = PANEL_C.slice(at, PANEL_C.indexOf("\n", at));
    expect(line, "给换行型 diff 也戴了 diff-rows-fit ⇒ 它会变成不换行的横滚列表").not.toContain("diff-rows-fit");
  });
});
