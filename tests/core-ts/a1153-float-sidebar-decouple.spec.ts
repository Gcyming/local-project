



























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const APP_SRC = read("gui/src/renderer/App.tsx");
const CSS_SRC = read("gui/src/renderer/index.css");
const APP_CODE = strip(APP_SRC);
const CSS_CODE = strip(CSS_SRC);


function fnBody(src: string, name: string): string {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^]*?\\n  \\}`).exec(src);
  expect(m, `取不到 ${name}（守卫自己失效了）`).toBeTruthy();
  return m![0];
}

describe("A-1153 ① 浮层铺满**不许**污染持久状态（rightWidth / rightCustom）", () => {
  it("`setRightCustom(true)` 只应剩**一处（右栏拖拽）**，且复位仍为 0 处", () => {
    




    const hits = APP_CODE.split("setRightCustom(true)").length - 1;
    expect(hits, `setRightCustom(true) 应恰好 1 处（只有右栏拖拽），实测 ${hits} 处`).toBe(1);
    
    expect(APP_CODE.split("setRightCustom(false)").length - 1).toBe(0);
  });

  it("`handleToggleFloat` 函数体里**没有** `setRightCustom` / `setRightWidth`", () => {
    const body = fnBody(APP_CODE, "handleToggleFloat");
    expect(body, "唤出浮层仍在改 rightCustom ⇒ 右栏永久失去比例自适应").not.toMatch(/setRightCustom\(/);
    expect(body, "唤出浮层仍在改 rightWidth ⇒ 退出后右栏会停在整窗宽、挤压主区").not.toMatch(/setRightWidth\(/);
  });

  it("`dismissFloat` 函数体里**没有** `setRightWidth`（不再需要「归还」）", () => {
    const body = fnBody(APP_CODE, "dismissFloat");
    expect(body, "退出浮层仍在归还宽度：归还依赖异步动画回调 ⇒ 时好时坏").not.toMatch(/setRightWidth\(/);
  });

  it("`preFloatRightWidthRef` 已彻底删除（归还机制整体退休）", () => {
    expect(APP_CODE).not.toMatch(/preFloatRightWidthRef/);
  });
});

describe("A-1153 ② 过渡期宽度走 `--right-target-w`，且**成对**写/摘", () => {
  it("`animateRightSidebar` 在过渡起点写 `--right-target-w`，且**不**把铺满宽度落 state", () => {
    const body = fnBody(APP_CODE, "animateRightSidebar");
    expect(body, "缺少 --right-target-w 的写入（过渡期就没有宽度对象了）").toMatch(/setProperty\("--right-target-w"/);
    

    expect(body).toMatch(/if\s*\(nextWidth\s*!==\s*undefined\s*&&\s*!isFloatExpand\)\s*\{\s*setRightWidth\(nextWidth\)/);
  });

  it("`--right-target-w` 在 done 时被摘除（展开支与收起支**两处**，漏一处即长期残值）", () => {
    const n = (APP_CODE.match(/removeProperty\("--right-target-w"\)/g) || []).length;
    expect(n, `只找到 ${n} 处 removeProperty("--right-target-w")，应 ≥2（展开 done + 收起 done）`).toBeGreaterThanOrEqual(2);
  });

  it("CSS：过渡期规则用 `var(--right-target-w)` 驱动宽度，**不带 fallback**、且**带 `!important`**", () => {
    const m = /body\.float-layout\s+\.right-wrapper-anim\s+\.right-sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到过渡期规则（守卫自己失效了）").toBeTruthy();
    const body = m![1];
    






    expect(body).toMatch(/width:\s*var\(--right-target-w\)\s*!important\s*;/);
    

    expect(body, "`var(--right-target-w)` 带了 fallback ⇒ 非浮层展开会误用兜底值").not.toMatch(/var\(--right-target-w\s*,/);
  });

  it("CSS：右栏**贴住窗口右缘**（`margin-left:auto`）—— 否则过渡是「向右合」而不是「向左挤开」", () => {
    












    const bodies = [...CSS_CODE.matchAll(/\.right-sidebar\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(bodies.length, "CSS 里找不到任何 `.right-sidebar { … }` 规则（守卫自己失效了）").toBeGreaterThan(0);
    expect(
      bodies.some((b) => /margin-left:\s*auto/.test(b)),
      "没有一条 `.right-sidebar` 规则带 `margin-left: auto` ⇒ 过渡期右栏会贴 wrapper 左缘"
      + "「向右合上」，且退浮层时会露出一条空白",
    ).toBe(true);
  });
});

describe("A-1157 ③ 唤出浮层走**并发渲染**（过渡第 3 帧被冻住 = 用户报的「抽搐」）", () => {
  it("`setFloatState(\"float\")` 被包在 `React.startTransition` 里", () => {
    










    expect(APP_CODE).toMatch(/React\.startTransition\(\(\)\s*=>\s*\{\s*setFloatState\("float"\);\s*\}\)/);
  });

  it("⚠️ 其余状态**不许**包进 startTransition（在驱动动画，延迟它反而更糟）", () => {
    

    const body = fnBody(APP_CODE, "handleToggleFloat");
    const inTransition = /React\.startTransition\([\s\S]*?\}\);/.exec(body)?.[0] ?? "";
    expect(inTransition).not.toMatch(/animateRightSidebar|setRightMin0|setRightOpen/);
  });
});

describe("A-1153 ③ 窗口化只允许**一次**动画（双调用 = 抽搐抖动）", () => {
  it("`handleToggleFloat` 函数体里 `animateRightSidebar(` 恰好 1 次", () => {
    const body = fnBody(APP_CODE, "handleToggleFloat");
    const n = (body.match(/animateRightSidebar\(/g) || []).length;
    expect(n, `handleToggleFloat 里 animateRightSidebar 调了 ${n} 次；第二次会 cancel 第一次的几何（cancel 只停表不复位样式）⇒ 副作用叠加`).toBe(1);
  });
});

describe("A-1153 ④ 拖动**第一帧**就禁宽度过渡（跟手）", () => {
  it("两个 resize 处理函数开头都立即挂 `slime-dragging`", () => {
    for (const fn of ["handleSidebarResize", "handleRightbarResize"]) {
      const body = fnBody(APP_CODE, fn);
      expect(body, `${fn} 没有立即挂 slime-dragging ⇒ 拖动头 140ms 不跟手`).toMatch(/classList\.add\("slime-dragging"\)/);
    }
  });

  it("`endChatFreeze` 摘 `slime-dragging`（松手 / pointercancel / blur 三条路共用它）", () => {
    const body = fnBody(APP_CODE, "endChatFreeze");
    expect(body, "拖动标志没被摘 ⇒ transition 永久为 none，之后所有侧栏动画都硬跳").toMatch(/classList\.remove\("slime-dragging"\)/);
  });

  it("CSS：`slime-dragging` 只禁**侧栏宽度**过渡（不许碰 `.chat-scroll` 的 opacity）", () => {
    const m = /body\.slime-dragging\s+\.sidebar,\s*body\.slime-dragging\s+\.right-sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到 slime-dragging 的侧栏规则").toBeTruthy();
    expect(m![1]).toMatch(/transition:\s*none/);
    
    expect(m![1], "slime-dragging 规则里不许出现 .chat-scroll").not.toMatch(/chat-scroll/);
  });
});

describe("A-1153 ⑤ 恢复方向也必须有过渡（摘类时 transition 声明不能跟着消失）", () => {
  it("`.chat-scroll` 有**常驻** opacity 过渡（不带 body 前缀的那条）", () => {
    

    const m = /(^|\n)\.chat-scroll\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到 .chat-scroll 的常驻规则 ⇒ 摘类时没有过渡可用（硬跳）").toBeTruthy();
    expect(m![2]).toMatch(/transition:\s*opacity/);
  });

  it("`endChatFreeze` 的兜底定时器**不许**递归自调用（a1152 ⑫ 同一条不变量，这里再钉一次）", () => {
    const body = fnBody(APP_CODE, "endChatFreeze");
    const tAt = body.indexOf("setTimeout(");
    expect(tAt, "找不到兜底定时器（守卫自己失效了）").toBeGreaterThan(-1);
    



    expect(
      body.slice(tAt),
      "兜底定时器递归调用了自己 ⇒ 每次拖拽都留下一条永不停止的摘类循环（闪烁根因）",
    ).not.toMatch(/endChatFreeze\s*\(/);
  });
});





















describe("A-1160 浮窗**不许有进场动画**（进场动效本身就是病症）", () => {
  it("`@keyframes float-enter-a1159` 必须**整条不存在**", () => {
    expect(CSS_CODE, "浮窗进场 keyframes 又回来了 ⇒ 半透明叠印 / 边界位移两症都会复发")
      .not.toMatch(/@keyframes\s+float-enter-a1159/);
  });

  it("`.float-window` 上不许出现 `animation`（含 `body.float-layout` 变体）", () => {
    

    const rules = CSS_CODE.match(/[^{}]*\.float-window[^{}]*\{[^}]*\}/g) || [];
    expect(rules.length, "找不到 .float-window 的规则 ⇒ 守卫自己失效了").toBeGreaterThan(0);
    for (const r of rules) {
      expect(r, "规则里出现了 animation：" + r.slice(0, 80)).not.toMatch(/(^|[;{\s])animation(-[a-z]+)?\s*:/);
    }
  });

  

  it("浮窗显式 `opacity: 1`（它的下方就是右栏，半透明必然叠印）", () => {
    const r = /(^|\n)\.float-window\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(r, "找不到裸 `.float-window` 规则").toBeTruthy();
    expect(r![2], "浮窗必须显式写死 opacity: 1").toMatch(/opacity:\s*1\s*;/);
  });
});













describe("A-1161 聊天区预留滚动条槽位（平台默认滚动条的出现/消失会让内容左右跳）", () => {
  const rule = /(^|\n)\.chat-scroll\s*\{([^}]*)\}/.exec(CSS_CODE);
  it("`.chat-scroll` 声明 `scrollbar-gutter: stable`", () => {
    expect(rule, "找不到裸 `.chat-scroll` 规则").toBeTruthy();
    expect(rule![2], "必须预留滚动条槽位，否则内容区宽度随滚动条出现/消失而变").toMatch(
      /scrollbar-gutter:\s*stable/,
    );
  });

  it("**不许**改回 `overflow-y: scroll`（强制常驻会让不溢出的会话也空掉一条槽）", () => {
    expect(rule![2], "强制常驻滚动条 = 右边永久让掉 17px").not.toMatch(/overflow-y:\s*scroll/);
  });
});