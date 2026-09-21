/**
 * A-1045 守卫：**内嵌浏览器面板的主题化**（消除"每次进去都是纯白，有点晃眼睛"）。
 *
 * **用户原话**：「给右侧边栏的浏览器页的界面改成目前slime主题色，每次进去都是纯白，有点晃眼睛。」
 *
 * 根因（三处硬编码白 + 一处判据漏窗）：
 *   ① `<webview>` 的 host 内联 `background: "#fff"` —— guest 未绘制的那一帧由宿主露白；
 *   ② index.css `.browser-wrap { background: #fff }` —— 同源残留（另一个宿主层）；
 *   ③ 真正的白来自 **guest 自己**：`about:blank` 占位文档由 Chromium 以白色基底绘制，
 *      宿主 CSS 管不到 guest 内部 —— 只改①②仍然"进去就白"（这是本次必须用**覆盖层**的原因）；
 *   ④ 原空态提示的判据是 `!active && !navUrl` —— 只要地址栏里有值（哪怕还在加载、页面还没落地）
 *      覆盖层就撤掉 → 整个加载窗口期又露出 ③ 的白。判据必须只锚「有没有真实文档」= `!active`。
 *
 * 本守卫锁四件事：无硬编码白 / 占位页存在且判据正确 / 覆盖层不吞点击不越权盖错误页 / 地址栏随主题。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const CSS = "gui/src/renderer/index.css";

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再扫 —— 否则注释里提到的写法会把断言喂饱（本仓反复踩过；本轮注释里就写了 "#fff 残留"）。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** 取 `BrowserTabInstance` 组件体（位置驱动：从函数签名切到下一段分区注释）。 */
function browserBody(raw: string): string {
  const src = stripComments(raw);
  const start = src.indexOf("function BrowserTabInstance(");
  expect(start, "RightSidebar.tsx 里找不到 BrowserTabInstance").toBeGreaterThan(-1);
  const end = src.indexOf("菜单项 / 空态插画", start);
  return src.slice(start, end === -1 ? undefined : end);
}

/** 取一个 CSS 规则块（选择器必须在行首，块到第一个 `}` 为止）。 */
function cssBlock(raw: string, selector: string): string {
  const src = stripComments(raw);
  const start = src.indexOf(`\n${selector} {`);
  expect(start, `index.css 里找不到规则 ${selector}`).toBeGreaterThan(-1);
  const end = src.indexOf("}", start);
  return src.slice(start, end === -1 ? undefined : end + 1);
}

/** 把某条 CSS 声明的数值取出来（`z-index: 6;` → 6）。 */
function cssNum(block: string, prop: string): number {
  const m = new RegExp(`${prop}\\s*:\\s*(-?\\d+)`).exec(block);
  expect(m, `规则里找不到 ${prop}`).not.toBeNull();
  return Number(m![1]);
}

describe("A-1045 ①：浏览器面板不存在硬编码白底", () => {
  it("webview 的 host 底色走主题变量，不再内联 #fff", () => {
    const body = browserBody(read(SIDEBAR));
    // 只扫 background 声明 —— 按钮文字色 `color:"#fff"`（叠在 accent 上）是另一回事，不在本条射程内
    expect(body).not.toMatch(/background\s*:\s*["']\s*(#fff|#ffffff|white)\b/i);
    expect(body).toMatch(/background:\s*"var\(--bg\)"/);
  });

  it("宿主容器 `.browser-stage` 与残留的 `.browser-wrap` 都是主题底色", () => {
    for (const sel of [".browser-stage", ".browser-wrap"]) {
      expect(cssBlock(read(CSS), sel)).toMatch(/background\s*:\s*var\(--bg\)/);
    }
  });

  it("浏览器面板的容器用的是 `.browser-stage` 类，而不是又写一串内联布局", () => {
    const body = browserBody(read(SIDEBAR));
    expect(body).toMatch(/<div className="browser-stage">/);
  });
});

describe("A-1045 ②：占位页 —— 盖住 guest 的白色基底", () => {
  it("存在占位页节点，且判据只锚「有没有真实文档」（!active），不被 navUrl 提前撤掉", () => {
    const body = browserBody(read(SIDEBAR));
    expect(body, "占位页必须走 .browser-blank 类").toMatch(/className="browser-blank"/);
    const m = /\{([^{}]*<div className="browser-blank">)/.exec(body);
    expect(m, "找不到占位页的条件表达式").not.toBeNull();
    const cond = m![1];
    expect(cond, "必须含 `!active`（active 仅由真实 did-navigate 置真）").toMatch(/!active/);
    expect(cond, "必须含 `!failInfo`（失败页自己会盖，别和它抢）").toMatch(/!failInfo/);
    // 反向断言：这正是"进去就白"的成因 —— 只要地址栏有值就撤层，加载窗口期必露白
    expect(cond, "判据不许依赖 navUrl —— 那是加载期露白的直接成因").not.toMatch(/navUrl/);
  });

  it("占位页必须主题底色 + 不吃点击（A-976 前科）", () => {
    const blk = cssBlock(read(CSS), ".browser-blank");
    expect(blk).toMatch(/background\s*:\s*var\(--bg\)/);
    expect(blk, "A-976：任何吃点击的覆盖层都会让 Agent 点不动页面").toMatch(/pointer-events\s*:\s*none/);
  });

  it("占位页层级必须低于错误页，失败时不能把错误页盖住", () => {
    const blank = cssBlock(read(CSS), ".browser-blank");
    const err = cssBlock(read(CSS), ".browser-error-page");
    expect(cssNum(blank, "z-index")).toBeLessThan(cssNum(err, "z-index"));
  });

  it("占位页的定位/配色全在 CSS，JSX 里不写 inline absolute（静态守卫 ⑬ 的射程）", () => {
    const body = browserBody(read(SIDEBAR));
    const m = /<div className="browser-blank"([^>]*)>/.exec(body);
    expect(m, "找不到占位页节点").not.toBeNull();
    expect(m![1], "占位页不该带内联 style（覆盖层定位必须走 CSS 类）").not.toMatch(/style=/);
    expect(m![1]).not.toMatch(/position/);
  });
});

describe("A-1045 ③：地址栏随主题（不再是从 `.term-input` 继承的近黑底）", () => {
  it("`.browser-url` 显式声明主题底色，且声明位置在 `.term-input` 之后（同特异性靠源序覆盖）", () => {
    const src = stripComments(read(CSS));
    const urlAt = src.indexOf("\n.browser-url {");
    const termAt = src.indexOf("\n.term-input {");
    expect(urlAt).toBeGreaterThan(-1);
    expect(termAt).toBeGreaterThan(-1);
    expect(urlAt, "`.browser-url` 必须在 `.term-input` 之后，否则 0,1,0 同特异性下覆盖失效").toBeGreaterThan(termAt);
    expect(cssBlock(read(CSS), ".browser-url")).toMatch(/background\s*:\s*var\(--bg-input\)/);
  });

  it("聚焦态描边走 accent，不残留 `#3b82f6` 之类的字面色", () => {
    const src = stripComments(read(CSS));
    const m = /\n\.browser-url:focus\s*\{([\s\S]*?)\}/.exec(src);
    expect(m, "缺少 .browser-url:focus").not.toBeNull();
    expect(m![1]).toMatch(/border-color\s*:\s*var\(--accent\)/);
  });
});
