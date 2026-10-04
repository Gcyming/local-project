






































import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));
const CSS_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8"));

const fnBody = (name: string): string => {
  const m = new RegExp(`function ${name}\\([^)]*\\)[\\s\\S]*?\\n  \\}`).exec(APP_CODE);
  expect(m, `取不到 ${name}（守卫自己失效了）`).toBeTruthy();
  return m![0];
};

describe("A-1177 浮层态拖左栏：右栏必须跟随（不许出现空白带）", () => {
  it("`onMove` 逐帧把左栏宽同步给 `--left-w`（浮层态）", () => {
    


    const body = fnBody("handleSidebarResize");
    expect(body, "`onMove` 没有同步 `--left-w` ⇒ 拖拽期间右栏不动 ⇒ 边界脱节")
      .toMatch(/if\s*\(floatStateRef\.current\s*!==\s*"none"\)\s*\{\s*rightWrapperRef\.current\?\.style\.setProperty\("--left-w",\s*`\$\{lastW\}px`\)/);
  });

  it("`onUp` / `onCancel` 都**不许**把内联宽清空（要钉成最终值）", () => {
    const body = fnBody("handleSidebarResize");
    




    const clears = [...body.matchAll(/asideEl\.style\.width\s*=\s*""/g)];
    expect(clears.length, `清空内联宽的地方有 ${clears.length} 处（只允许吸附分支那 1 处）⇒ onUp/onCancel 会让左栏回落 CSS 宽度 ⇒ 与 --left-w 错位`).toBe(1);
    
    const after = body.slice(clears[0].index ?? 0, (clears[0].index ?? 0) + 400);
    expect(after, "唯一那处清空不在吸附分支里 ⇒ onUp/onCancel 会让左栏回落 CSS 宽度")
      .toMatch(/setSidebarWidth\(restoreW\)/);
    expect(body, "`onUp` 该把内联宽钉成最终值 `w`").toMatch(/asideEl\.style\.width\s*=\s*`\$\{w\}px`/);
    expect(body, "松手时也要把 `--left-w` 钉成最终值 `w`（否则右栏停在拖动中的值）")
      .toMatch(/setProperty\("--left-w",\s*`\$\{w\}px`\)/);



    expect(body, "`onCancel` 没把内联宽钉成最终值（会回落 CSS 宽度）")
      .toMatch(/asideEl\.style\.width\s*=\s*`\$\{wCancel\}px`/);
    expect(body, "`onCancel` 没把 `--left-w` 钉成最终值")
      .toMatch(/setProperty\("--left-w",\s*`\$\{wCancel\}px`\)/);
    expect(body, "`onCancel` 的 setSidebarWidth 必须内联 Math.round（a1154 ③ 钉的形状）")
      .toMatch(/setSidebarWidth\(Math\.round\(/);
  });

  it("`leftDraggingRef` 有写、且在 `onUp` / `onCancel` **成对**摘除（铁律 11）", () => {
    const body = fnBody("handleSidebarResize");
    expect(body, "起点没写 `leftDraggingRef.current = true` ⇒ RO 会覆盖 onMove 的真值")
      .toMatch(/leftDraggingRef\.current\s*=\s*true/);
    const nFalse = (body.match(/leftDraggingRef\.current\s*=\s*false/g) || []).length;
    expect(nFalse, `摘除点只有 ${nFalse} 处（应为 2：onUp + onCancel）⇒ 有一处漏了会让"拖动中"状态一直挂着`)
      .toBe(2);
  });

  it("RO 的 `sync` 在拖拽期让位（以 `onMove` 为唯一权威）", () => {
    
    const m = new RegExp("attachLeftWidthObserver[\\s\\S]*?\\n  \\}, \\[\\]\\)").exec(APP_CODE);
    expect(m, "取不到 `attachLeftWidthObserver`").toBeTruthy();
    const body = m![0];
    expect(body, "`sync` 没有在拖拽期让位 ⇒ 它会按 A-1172 写拖动**起点**宽度、覆盖 `onMove` 的真值（一帧错位 240px）")
      .toMatch(/if\s*\(leftDraggingRef\.current\)\s*\{\s*return;\s*\}/);
  });
});

describe("A-1177 拖拽期必须禁掉右栏**容器**的宽度过渡（且特异度要够）", () => {
  it("存在 `slime-dragging` + `right-wrapper` 的 `transition: none` 规则", () => {
    expect(CSS_CODE, "拖拽期没禁掉右栏容器的过渡 ⇒ A-1176 那条 0.5s 会让它永远追不上 `--left-w` 的每帧新值")
      .toMatch(/body\.slime-dragging\s+\.right-wrapper[^{]*\{[^}]*transition:\s*none/);
  });

  it("那条规则的**特异度不低于** A-1176 那条（否则被盖掉 —— 实测就踩了）", () => {
    




    const sels = [...CSS_CODE.matchAll(/body\.slime-dragging\s+\.right-wrapper([^{]*)\{/g)].map((m) => m[1]);
    expect(sels.length, "找不到 `body.slime-dragging .right-wrapper` 规则").toBeGreaterThan(0);
    const strong = sels.filter((s) => s.includes(":not(.right-wrapper-anim)") && s.includes(":not(.right-wrapper-exit)"));
    expect(strong.length,
      `带 :not() 的那条不存在（现有 ${sels.length} 条：${JSON.stringify(sels)}）`
      + ` ⇒ 特异度不够（2 个类 vs A-1176 的 6 个类）⇒ 会被盖掉、拖拽时右栏仍不动`)
      .toBeGreaterThan(0);
  });
});