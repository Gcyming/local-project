/**
 * tests/core-ts/a1189-rightbar-fade.spec.ts —— 右栏恢复「几何同步淡入淡出」（A-1189）。
 *
 * ## 用户诉求（原话）
 * 「**右侧边栏的渐入渐出动画又没了，只有衔接动画啊。**」
 * （此前同一诉求的表述：「为什么左侧边栏没删右侧边栏动画删了？」「你做成左侧边栏那样就行，照做！」）
 *
 * ## 为什么"又没了"
 * A-1164 以一条实拍证据（过渡中右栏内容区 p95 = 10.0，静止态 133.0 ⇒ 亮字整块消失）
 * 把右栏的 `opacity` **两处成对删除**（`el.style.opacity = "0"` + onFrame 的 `String(p)`）。
 * 之后 A-1181/A-1182 尝试恢复过、又被回退。⇒ 现在源码里 `animateRightSidebar` 只剩
 * 一句 `removeProperty("opacity")`：**只有"摘"，没有"写"** ⇒ 右栏全程不透明。
 *
 * ## A-1189 的取法（与左栏逐字同语言）
 * A-1164 那条证据的**成因**是当时收起支的窗口 `[0.06, 0.42]`：`1 - p` 在 `u = 0.06`（30ms）
 * 就归零 ⇒ 剩下 94% 的时间整块面板全透明。真正错的是**窗口**，不是"右栏不该淡"。
 * ⇒ 改用左栏那两组（`LEFT_FADE_LO/HI` = 0.40/0.95 淡入晚；`LEFT_FADE_COLLAPSE_*` = 0/0.27 淡出早），
 *   两组都**不在过渡中段长时间半透明**。
 *
 * ## 本文件锚的 5 条不变量（每条都能被独立变异打掉）
 * ① 写入节点是**内层 `.right-sidebar`**（铁律 53 / A-980-R24：容器 `.right-wrapper` 是
 *    `<webview>` 的祖先且无背景 ⇒ 不许承载 fade）；
 * ② **展开起点**就同步压 `"0"`（展开窗口在 `u < 0.40` 时 `p ≡ 0`，不压 0 会先全不透明地
 *    长出来再掉回 0 重淡 = 一帧闪）；
 * ③ 两条支都写 opacity（**计数 = 2**：只保住一条 = 另一半方向没有淡）；
 * ④ 方向取反 `nextOpen ? p : 1 - p`、`done` 时展开摘除 / 收起钉 `"0"`（A-1173 的不变量）；
 * ⑤ 两条"取消但不重启"的路径都要清内层 opacity（拖拽起点 + 切会话快照恢复）——
 *    否则收起收工钉下的 `"0"` 会永久残留（`opacity` 不在 React 的 style 对象里，
 *    diff 永远不会把它当变化重写）。
 *
 * ⚠️ 判据风格与同目录其它 spec 一致：**先剥注释**再做形状断言（铁律 10）——
 *    本轮的注释里就逐字引用了 `el.style.opacity = "0"`，不剥会把 ① 的否定断言写成**恒假红**。
 */
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
    /* ⚠️ 容器是 `<webview>` 的祖先：给它挂 opacity ⇒ OOPIF guest 进独立合成层 ⇒
       鼠标命中测试失效（能进网站但点不动）。`el` 就是 `rightWrapperRef.current`。 */
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
