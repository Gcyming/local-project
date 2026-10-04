

















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}


function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const APP_CODE = stripComments(read("gui/src/renderer/App.tsx"));
const CSS_CODE = stripComments(read("gui/src/renderer/index.css"));


const RIGHT_BODY_RULE =
  /body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body\s*\{([^}]*)\}/.exec(CSS_CODE);

describe("A-1156-① CSS：内容列随右栏铺满，只留一个高上限", () => {
  it("取到那条规则", () => {
    expect(RIGHT_BODY_RULE, "找不到 body.float-layout … .right-body 规则").toBeTruthy();
  });

  it("`max-width` 是 `min(<上限>px, 100%)` —— 第二项必须是 100%（= 铺满）", () => {
    


    const decl = /max-width:\s*([^;]+)/.exec(RIGHT_BODY_RULE![1])?.[1] ?? "";
    expect(decl).toMatch(/^min\(\s*\d+px\s*,\s*100%\s*\)$/);
  });

  it("上限 ≥ 1200px（否则大窗口上又退回「只有一段」）", () => {
    

    const px = Number(/max-width:\s*min\(\s*(\d+)px/.exec(RIGHT_BODY_RULE![1])?.[1]);
    expect(Number.isFinite(px)).toBe(true);
    expect(px).toBeGreaterThanOrEqual(1200);
  });

  it("上限**不超过整窗宽的量级**（不许退化成纯 100%：超宽屏一行到底）", () => {
    const px = Number(/max-width:\s*min\(\s*(\d+)px/.exec(RIGHT_BODY_RULE![1])?.[1]);
    expect(px).toBeLessThanOrEqual(2560);
  });

  it("`var(--right-content-max)` 钩子已移除（全仓无写入方 = 第二个真相源）", () => {
    expect(CSS_CODE).not.toMatch(/--right-content-max/);
  });

  it("限宽与居中仍在（`width:100%` + `margin-inline:auto`）", () => {
    

    expect(RIGHT_BODY_RULE![1]).toMatch(/width:\s*100%/);
    expect(RIGHT_BODY_RULE![1]).toMatch(/margin-inline:\s*auto/);
  });

  it("限宽只挂在浮层态选择器上（裸 `.right-body` 不带 max-width）", () => {
    expect(/(^|\n)\s*\.right-body\s*\{[^}]*max-width/.test(CSS_CODE)).toBe(false);
  });

  it("浏览器页（webview）仍然豁免限宽", () => {
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body/);
  });
});

describe("A-1156-② JS：过渡期 `--right-body-pin` 与稳态规则同式", () => {
  it("有 `RIGHT_CONTENT_MAX_W` 常量", () => {
    const m = /const\s+RIGHT_CONTENT_MAX_W\s*=\s*(\d+)/.exec(APP_CODE);
    expect(m, "找不到 RIGHT_CONTENT_MAX_W 常量").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1200);
  });

  it("常量值 === CSS 里的上限（**同一处事实**，否则过渡结束会突跳）", () => {
    

    const js = Number(/const\s+RIGHT_CONTENT_MAX_W\s*=\s*(\d+)/.exec(APP_CODE)?.[1]);
    const css = Number(/max-width:\s*min\(\s*(\d+)px/.exec(RIGHT_BODY_RULE![1])?.[1]);
    expect(js).toBe(css);
  });

  it("pin 的算法是 `Math.min(RIGHT_CONTENT_MAX_W, targetW)`（旧式 `× 0.62` 已作废）", () => {
    expect(APP_CODE).toMatch(/setProperty\("--right-body-pin"/);
    const at = APP_CODE.indexOf('setProperty("--right-body-pin"');
    const seg = APP_CODE.slice(Math.max(0, at - 400), at + 120);
    expect(seg).toMatch(/Math\.min\(RIGHT_CONTENT_MAX_W\s*,\s*targetW\)/);
    expect(seg).not.toMatch(/targetW\s*\*\s*0\.62/);
  });

  it("浮层支的 pin 目标宽**不再**过 `rightSidebarMaxW()`", () => {
    



    const at = APP_CODE.indexOf('setProperty("--right-body-pin"');
    const seg = APP_CODE.slice(Math.max(0, at - 500), at + 120);
    expect(seg).toMatch(/const\s+targetW\s*=\s*isFloatExpand\s*\?/);
    const floatBranch = seg.slice(seg.indexOf("isFloatExpand"));
    const clamp = floatBranch.indexOf("rightSidebarMaxW()");
    
    const ternary = floatBranch.indexOf(":");
    expect(ternary).toBeGreaterThan(-1);
    expect(clamp === -1 || clamp > ternary).toBe(true);
  });

  it("pin 仍然成对摘除（起点写 / done 摘）", () => {
    expect(APP_CODE).toMatch(/setProperty\("--right-body-pin"/);
    expect(APP_CODE).toMatch(/removeProperty\("--right-body-pin"\)/);
  });
});

describe("A-1156-③ `--left-w` 必须**自愈**（用户现象④：右栏被挤压到屏幕外）", () => {
  it("必须有 `ResizeObserver` 观察左栏（动画逐帧同步被证明不够）", () => {
    




    expect(APP_CODE).toMatch(/new ResizeObserver\(/);
  });

  it("喂给 RO 的那个回调**就是**写 `--left-w` 的那个函数（不是另一个同形函数）", () => {
    

    expect(APP_CODE).toMatch(/const sync = \(\): void => \{[\s\S]{0,400}?setProperty\("--left-w"/);
    expect(APP_CODE).toMatch(/new ResizeObserver\(sync\)/);
    expect(APP_CODE).toMatch(/ro\.observe\(el\)/);
  });

  it("该回调只在浮层态写，且判据用真状态 `floatStateRef`（铁律 11）", () => {
    expect(APP_CODE).toMatch(
      /const sync = \(\): void => \{\s*if \(floatStateRef\.current === "none"\) \{ return; \}/,
    );
  });

  it("⚠️ 观察器必须挂在**回调 ref** 上，不能是 `useEffect(..., [])`（实测踩过的坑）", () => {
    



    expect(APP_CODE).toMatch(/ref=\{attachLeftWidthObserver\}/);
    expect(APP_CODE).toMatch(/const attachLeftWidthObserver = React\.useCallback\(/);
    expect(APP_CODE).not.toMatch(/React\.useEffect\(\(\) => \{\s*const el = leftSidebarRef\.current/);
    
    expect(APP_CODE).toMatch(/leftSidebarRef\.current = el;/);
  });

  it("回调 ref 的身份必须稳定（`useCallback([])`），且重挂前先 disconnect", () => {
    
    const at = APP_CODE.indexOf("const attachLeftWidthObserver = React.useCallback(");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1600);
    expect(seg).toMatch(/\}, \[\]\);/);
    expect(seg).toMatch(/leftWidthObserverRef\.current\?\.disconnect\(\)/);
  });

  it("RO 必须挂在**左栏**这个被观察对象上（挂错元素 = 看着有、实际不同步）", () => {
    const at = APP_CODE.indexOf("const attachLeftWidthObserver = React.useCallback(");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1600);
    expect(seg).toMatch(/ro\.observe\(el\)/);
  });

  it("观察器必须在重挂前 `disconnect`（节点换了不 disconnect ⇒ 旧观察者泄漏）", () => {
    const at = APP_CODE.indexOf("const attachLeftWidthObserver = React.useCallback(");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1600);
    expect(seg).toMatch(/leftWidthObserverRef\.current\?\.disconnect\(\)/);
    expect(seg).toMatch(/ro\.disconnect\(\)|ro\.observe\(el\)/);
  });
});

describe("A-1156-④ 探针：必须量得到「内容列 / 右栏」这条比例与越窗", () => {
  it("`probe-a1155-cdp.mjs` 报 `fillRatio`（用户体感的判据 = 内容占右栏多少）", () => {
    

    const src = read("gui/scripts/probe-a1155-cdp.mjs");
    expect(src).toMatch(/fillRatio/);
  });

  it("探针的截图能力是可选开关（不默认落盘，避免污染工作树）", () => {
    const src = read("gui/scripts/probe-a1155-cdp.mjs");
    expect(src).toMatch(/SLIME_A1155_SHOTS/);
  });

  it("解析器自检：stripComments 真能剥掉注释里的字面量示例", () => {
    
    expect(stripComments("/* max-width: min(999px, 100%) */ .a { width: 1px; }")).not.toMatch(/999px/);
  });
});