/**
 * tests/gui/a1130-diff-row-band.spec.ts — diff 行底色「铺到极限位置」的守卫（A-1130）。
 *
 * 用户原话（2026-09-26）：
 *   「我让你加色块，你就只加在字后面了？敷衍至极！直接以改动左侧的符号的 + − 为准，
 *    向右一直延伸到**极限位置**，而非文本结束位置。」
 *
 * ⚠️「极限位置」= **滚动内容的最右端**（这类 diff 有横向滚动）⇒ 一行底色的目标宽度是
 *   `max(可视宽, 最宽行)`，两条**同时**要满足：
 *     内容比可视区窄 ⇒ 行宽 = 可视宽（否则短行右侧缺块）；
 *     内容比可视区宽 ⇒ 行宽 = 最宽行（否则底色在可视宽处断掉、文字却继续往外溢）。
 *
 * 两次病根（第一次只修一半，第二次"看着像对、实测不对"）：
 *   · A-1109：`width: max-content` 加在**每一行** ⇒ 行宽 = 这一行自己的字宽 ⇒ 短行露白。
 *   · A-1130 首版：容器 grid + 列轨 `minmax(100%, max-content)` ⇒ `100%` 下界**吃掉全部
 *     free space**，列轨因此**涨不到** `max-content`。2026-09-28 用户截图打回：
 *     有长行的 diff 里，行盒停在可视宽（实测 874px），文字溢出到轨道外（滚动内容 1243px）
 *     ⇒ 向右一滚就是「底色断了、字在带子外面」。
 *   实测（headless Chromium，见 `gui/scripts/probe-diff-band.mjs`）：
 *     | 写法 | 窄内容 | 含长行 |
 *     |---|---:|---:|
 *     | `minmax(100%, max-content)` | 874 ✓ | 874 < 1243 ✗ |
 *     | `max-content` | 356 ✗ | 1250 ✓ |
 *     | `minmax(min-content, 1fr)` ← 现行 | 874 ✓ | 1250 ✓ |
 *
 * 正解 = `minmax(min-content, 1fr)`（`min-content` 由**不可断行的整行**给出 = 最宽行；
 *   `1fr` 是弹性轨，内容更窄时把 free space 全吃下 = 可视宽）。这个文件锁三件事：
 *   ① 那条 grid 判据本身（一处产地，不许退回逐行宽度，也不许退回 `100%` 下界）；
 *   ② 三个 diff 滚动容器**都**带 `diff-rows-fit`（漏一处 = 同物异形）；
 *   ③ `.prod-diff`（行会**换行**的那种 diff）**不许**加 —— 加了会取消换行、长行溢出。
 *
 * ⚠️ 本文件里对列轨的断言是**漂移守卫**（静态、快、可被变异弄红）；几何的**真判据**是
 *   `gui/scripts/probe-diff-band.mjs`（真实 Chromium 量 `行宽 >= 容器 scrollWidth`）。
 *   改这条 CSS 时**必须**跑它 —— 文本断言对"换一个同样错的表达式"是瞎的。
 *
 * 变异：`gui/scripts/mut-a1130-diff-band.mjs`
 *
 * ⚠️ 中文串里嵌引用一律 `「」`（ASCII 双引号会当场截断 TS 字符串）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释：注释里写着"曾经是什么"，不该被当成当前值（本仓 §8-1）。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CSS = stripComments(read("gui/src/renderer/index.css"));
const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
const SIDEBAR = read("gui/src/renderer/pages/RightSidebar.tsx");
/* ⚠️ 数次数必须**先剥注释**：这次改动在两侧都留了带类名的说明注释，
   不剥就会把"注释里的类名"也数进去（本条断言首版实测 4 ≠ 2，当场红）。 */
const PANEL_C = stripComments(PANEL);
const SIDEBAR_C = stripComments(SIDEBAR);

/** 取某个选择器块的内容（块内不含嵌套 `}`；必须行首精确匹配，否则会被同类名前缀骗到） */
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
    /* 这条是 2026-09-28 实测打回的那个写法（用户截图：「你怎么反倒给我修回去了」）。
       几何后果：列轨 = 可视宽，而滚动内容更宽 ⇒ 底色在可视宽处断掉，文字却在带子外面。
       ⚠️ 只有**几何探针**能证伪它；这里只拦"又把它写回来"。 */
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
    // `min-width: 0` 是允许的（防长行撑破行盒），所以上面用更窄的判据而不是一律禁 min-width
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
    /* `.prod-diff` 里的行是 `white-space: pre-wrap`（长行换行显示）。
       grid 的 `max-content` 列轨会按"不换行"的自然宽铺开 ⇒ 行不再换行、改为横向溢出，
       观感从"折行阅读"变成"必须横向滚动"。这不是本需求的适用对象。 */
    const at = PANEL_C.indexOf('className="prod-diff"');
    expect(at, "找不到 .prod-diff 容器（锚点漂移？）").toBeGreaterThan(-1);
    const line = PANEL_C.slice(at, PANEL_C.indexOf("\n", at));
    expect(line, "给换行型 diff 也戴了 diff-rows-fit ⇒ 它会变成不换行的横滚列表").not.toContain("diff-rows-fit");
  });
});
