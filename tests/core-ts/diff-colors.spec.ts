/**
 * tests/core-ts/diff-colors.spec.ts — diff 行 +/- 配色的一致性守卫（A-1051）。
 *
 * 盯的病：**同一个界面里，两处 diff 的 +/- 配色不一样，且产物卡那处切主题不跟着变**。
 * 屏幕上 diff 行有两个独立产地：
 *   · 思考历程 `.think-diff-row.diff-add/.diff-del`（index.css）→ 取主题变量；
 *   · 产物卡「变更详情」`ProductDiffLines`（ChatPanel 内联 style）→ **写死** Tailwind 色
 *     （`#34d399`/`#f87171` + 0.10/0.12 底），比主题变量淡（0.16/0.14）且不随主题。
 * 用户实测的"diff 卡片 +/- 配色不对"就是这两者的可见差异 —— 一处改了、另一处没改，
 * 而且**改错任何一处都不会报错**，只是屏幕上的绿红对不上。
 *
 * 守卫锁三层：
 *  A. 产物卡内联 style 必须取主题变量（不再是硬编码色）；
 *  B. 两套主题都必须**定义**这些变量 —— 变量名打错/被删时 `var()` 会静默回退到兜底色，
 *     主题切换失效却不报错（"幽灵变量"）；
 *  C. 思考历程那一侧仍取同一批变量（两处同源，避免再次分叉）。
 *
 * ⚠️ 验收标准是**变异测试**：见 gui/scripts/mut-a1051-resume.mjs 的 D 组。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHAT_PANEL = join(ROOT, "gui", "src", "renderer", "pages", "ChatPanel.tsx");
const INDEX_CSS = join(ROOT, "gui", "src", "renderer", "index.css");

/** 剥掉注释 —— 说明"曾经写死过什么"的注释不该被当成回归证据（见 A-1051 的讲解注释）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const panelSrc = stripComments(readFileSync(CHAT_PANEL, "utf8"));
const cssSrc = readFileSync(INDEX_CSS, "utf8");

/** 产物卡 diff 行的渲染函数体（唯一产地）。 */
function productDiffBody(): string {
  const m = /const ProductDiffLines = React\.memo\(function[\s\S]*?\n\}\);/.exec(panelSrc);
  expect(m, "ProductDiffLines 的结构变了（可能被重命名/拆走），守卫需同步更新").toBeTruthy();
  return m![0];
}

/** 取出某个主题变量块的内容（`:root { … }` / `:root[data-theme="beta"] { … }`）。 */
function themeBlock(selectorRe: RegExp): string {
  const m = selectorRe.exec(cssSrc);
  expect(m, "主题变量块不见了，守卫需同步更新").toBeTruthy();
  return m![1];
}

const DIFF_VARS = ["--diff-add:", "--diff-add-bg:", "--diff-del:", "--diff-del-bg:"];

describe("A-1051 C. 两处 diff 配色同源", () => {
  it("产物卡 diff 行取主题变量（不再是硬编码 Tailwind 色）", () => {
    const body = productDiffBody();
    for (const v of ["var(--diff-add-bg", "var(--diff-del-bg", "var(--diff-add,", "var(--diff-del,"]) {
      expect(body, `产物卡 diff 行没有取 ${v} → 切主题时不跟着变`).toContain(v);
    }
  });

  it("产物卡 diff 行不得再写死暗色主题下几乎看不见的硬编码色", () => {
    const body = productDiffBody();
    for (const hard of ["#34d399", "#f87171", "rgba(52,211,153", "rgba(248,113,113"]) {
      expect(body, `产物卡 diff 行又写死了 ${hard} —— 与思考历程的 diff 色不一致`).not.toContain(hard);
    }
  });

  it("思考历程的 diff 行也取同一批变量（两处同源，防止再次分叉）", () => {
    expect(cssSrc).toMatch(/\.think-diff-row\.diff-add\s*\{\s*background:\s*var\(--diff-add-bg\)/);
    expect(cssSrc).toMatch(/\.think-diff-row\.diff-del\s*\{\s*background:\s*var\(--diff-del-bg\)/);
    expect(cssSrc).toMatch(/\.think-diff-row\.diff-add \.think-diff-mark\s*\{\s*color:\s*var\(--diff-add\)/);
    expect(cssSrc).toMatch(/\.think-diff-row\.diff-del \.think-diff-mark\s*\{\s*color:\s*var\(--diff-del\)/);
  });

  it("两套主题都定义了全部 diff 变量（少一个 → var() 静默回退，主题切换失效）", () => {
    const alpha = themeBlock(/^:root \{([\s\S]*?)^\}/m);
    const beta = themeBlock(/^:root\[data-theme="beta"\] \{([\s\S]*?)^\}/m);
    for (const [label, block] of [["Alpha :root", alpha], ["Beta beta", beta]] as const) {
      for (const v of DIFF_VARS) {
        expect(block, `${label} 缺少 ${v} —— var() 会静默回退到兜底色，切主题时这处不变`).toContain(v);
      }
    }
  });

  it("主题变量**确实有区别**（若两套主题取值全同，所谓「随主题走」就是空话）", () => {
    const alpha = themeBlock(/^:root \{([\s\S]*?)^\}/m);
    const beta = themeBlock(/^:root\[data-theme="beta"\] \{([\s\S]*?)^\}/m);
    const val = (block: string, name: string): string => (new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block)?.[1] ?? "").trim();
    // 文字色在两套主题下不同（Alpha #3fb950 / Beta #56d364 等）——
    // 这正是"写死十六进制会导致切主题不变"能被观察到的前提。
    expect(val(alpha, "--diff-add")).not.toBe(val(beta, "--diff-add"));
    expect(val(alpha, "--diff-del")).not.toBe(val(beta, "--diff-del"));
  });
});
