
































import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));

const rightBody = (): string => {
  const m = /function\s+animateRightSidebar\b[\s\S]*?\n  \}/.exec(APP_CODE);
  expect(m, "取不到 `animateRightSidebar` 函数体（守卫自己失效了）").toBeTruthy();
  return m![0];
};

describe("A-1189 右栏淡入淡出：写入节点与两条支", () => {
  it("① fade 写的是**内层 `.right-sidebar`**，不是容器 `.right-wrapper`（铁律 53 / A-980-R24）", () => {
    const seg = rightBody();
    expect(seg, "没在函数体内取内层 `.right-sidebar` 节点 ⇒ 淡入淡出又丢了（用户：「渐入渐出动画又没了」）")
      .toMatch(/rightWrapperRef\.current\?\.querySelector<HTMLElement>\("\.right-sidebar"\)/);
    

    expect(seg, "把 opacity 写到了容器 `el`（= `.right-wrapper`）上 ⇒ `<webview>` 祖先带 opacity，鼠标命中会失效")
      .not.toMatch(/\bel\.style\.opacity/);
  });

  it("② 展开**起点**就同步压 `\"0\"`，且必须在 `setRightOpen(true)` 之前", () => {
    const seg = rightBody();
    const atZero = seg.indexOf('rsEnter.style.opacity = "0"');
    expect(atZero, "展开起点没把内层压成 opacity 0 ⇒ 前 40% 会先全不透明地长出来、再掉回 0 重淡（一帧闪）")
      .toBeGreaterThan(-1);
    const atOpen = seg.indexOf("setRightOpen(true)");
    expect(atOpen, "找不到 `setRightOpen(true)`（守卫自己失效了）").toBeGreaterThan(-1);
    expect(atZero, "压 opacity 0 必须在 `setRightOpen(true)` **之前**（同帧、DOM 立即生效）")
      .toBeLessThan(atOpen);
  });

  it("③ 两条支（展开 / 收起）都写 opacity —— 计数 = 2（只保住一边 = 另一个方向没有淡）", () => {
    const seg = rightBody();
    const n = (seg.match(/node\.style\.opacity\s*=\s*String\(nextOpen \? p : 1 - p\)/g) || []).length;
    expect(n, `只有 ${n} 条支在写 opacity（应为 2：展开支 + 收起支）。`
      + "少一条 ⇒ 那个方向的折叠/展开没有衔接淡入淡出（用户就是这么发现 A-1164 的）")
      .toBe(2);
  });

  it("④ 方向取反 + `done` 复位：展开摘 `opacity`、收起钉 `\"0\"`（A-1173 的不变量）", () => {
    const seg = rightBody();
    expect(seg, "没按 `nextOpen` 取反 ⇒ 收起会被跑成渐入（先瞬间透明、再涨回来）")
      .toMatch(/node\.style\.opacity\s*=\s*String\(nextOpen\s*\?\s*p\s*:\s*1\s*-\s*p\)/);
    expect(seg, "收工没按方向复位 ⇒ 收起结尾几 px 里文本会露出来（「尾帧闪出文本」）")
      .toMatch(/if\s*\(nextOpen\)\s*\{\s*node\.style\.removeProperty\("opacity"\);\s*\}\s*else\s*\{\s*node\.style\.opacity\s*=\s*"0";\s*\}/);
  });
});

describe("A-1189 右栏淡入淡出：两条「取消但不重启」的路径都要清残留", () => {
  it("⑤a 拖拽起点清内层 opacity（折叠态手动拖宽 ⇒ 否则右栏隐形）", () => {
    const m = /function\s+handleRightbarResize\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m, "取不到 `handleRightbarResize` 函数体（守卫自己失效了）").toBeTruthy();
    expect(m![0], "`handleRightbarResize` 没清内层 opacity ⇒ 折叠态拖宽时右栏整块隐形（对称于左栏 A-1173）")
      .toMatch(/asideEl\.style\.removeProperty\("opacity"\)/);
  });

  it("⑤b 切会话快照恢复路径清内层 opacity（引擎唯一的「取消但不重启」路径）", () => {
    expect(APP_CODE, "切会话时没清内层 opacity ⇒ 半透明（或收起钉的 0）会永久残留在元素上"
      + "（`opacity` 不在 React 的 style 对象里，diff 永远不会把它当变化重写）")
      .toMatch(/const\s+rsReset\s*=\s*rw\.querySelector<HTMLElement>\("\.right-sidebar"\);\s*\n\s*if\s*\(rsReset\)\s*\{\s*rsReset\.style\.removeProperty\("opacity"\);\s*\}/);
  });
});
