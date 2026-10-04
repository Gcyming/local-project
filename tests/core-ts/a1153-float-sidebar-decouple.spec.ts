/**
 * tests/core-ts/a1153-float-sidebar-decouple.spec.ts — 浮层铺满与右栏宽度状态的**解耦**守卫（A-1153）。
 *
 * ## 用户实测的一串问题（同一个根因族：两个状态互相污染）
 * ①「对话页自适应窗口调整失效」；
 * ②「对话内容被挤压到屏幕外、被切割」；
 * ③「再次点窗口化，窗口抽搐抖动，但对话页不会窗口化」；
 * ④「一拖拽，对话页就闪烁」；
 * ⑤「拖拽极其不跟手，手在前面、后面的内容才跟上」。
 *
 * ## 根因（全部在源码里可证，逐条对应上面的现象）
 * ① `setRightCustom(true)` 全仓 **3 处、复位 0 处** ⇒ 点过一次「窗口化」后右栏永久按 px 渲染，
 *    失去 CSS 的比例自适应（那 3 处里只有 2 处是"用户拖过"的合法语义）；
 * ② 浮层铺满用 `setRightWidth(innerWidth)` 实现，退出时只能靠**一次异步动画回调**归还
 *    ⇒ 未归还时"展开右栏"把 `.main` 压到 `min-width: 380px` ⇒ 内容被切（用户截图）；
 *    而"左右拖几次就恢复"正是因为拖拽会 `setRightWidth(真实值)`；
 * ③ `handleToggleFloat` 里连着调两次 `animateRightSidebar`：第二次开头 cancel 第一次的几何，
 *    而 cancel **只停表、不复位样式** ⇒ 两次副作用叠加（opacity / min0 / pin 各写一遍）= 抽搐；
 * ④ `endChatFreeze()` 末尾**无条件递归调自己** ⇒ 每次拖动结束都排一条永不停止的 200ms 定时器链，
 *    每 200ms 摘一次 `slime-fading`，与随后的挂类淡出互相踩（本条已在 a1152 ⑫ 里加锚）；
 * ⑤ `transition: none` 由拖动开始 **140ms 后**才挂的 `slime-resizing` 提供
 *    ⇒ 拖动头 140ms 内宽度仍走 `.sidebar` 的 `transition: width 0.5s` ⇒ 手在前、面板在后。
 *
 * ## 这个守卫锁什么
 * 全部是**形状断言**（不渲染组件、不依赖会话数据）—— 这几条一旦被改回去，
 * 用户报的现象就会**静默**回来，形状断言恰好挡住"删掉这行 / 加回旧写法"的回归。
 * ⚠️ 解析前一律**剥注释**（本仓注释里大量引用被删掉的旧写法，不剥就会假红/假绿）。
 */
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

/** 取 `function X(...) { ... }` 的函数体（到下一个顶格 `  }` 为止，`[^]*?` 允许跨行）。 */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^]*?\\n  \\}`).exec(src);
  expect(m, `取不到 ${name}（守卫自己失效了）`).toBeTruthy();
  return m![0];
}

describe("A-1153 ① 浮层铺满**不许**污染持久状态（rightWidth / rightCustom）", () => {
  it("`setRightCustom(true)` 只应剩**一处（右栏拖拽）**，且复位仍为 0 处", () => {
    /* ⚠️ 语义：`rightCustom` = "用户**手动拖过**右栏宽度" ⇒ 决定要不要下发内联 px 宽度。
       它只该由**拖拽**置真。`handleToggleFloat` 里那次是"借铺满之名"顺手置真，
       而且没有任何复位点 ⇒ 点一次窗口化就永久失去 CSS 比例自适应（用户实测的现象①）。
       ⚠️ 数量是 1 而不是 2：左栏那处走的是 **`setSidebarCustom`**（另一个 state，名字不同）——
       别照抄"两处拖拽"的说法。 */
    const hits = APP_CODE.split("setRightCustom(true)").length - 1;
    expect(hits, `setRightCustom(true) 应恰好 1 处（只有右栏拖拽），实测 ${hits} 处`).toBe(1);
    /* ⚠️ 顺手确认"复位 0 处"这个事实没变：若将来真加了复位逻辑，这条会红，提醒协调两处语义。 */
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
    /* ⚠️ 这条是"解耦"的核心形状：铺满那一支必须先判 `!isFloatExpand` 才 setRightWidth。
       直接 `if (nextWidth !== undefined) setRightWidth(nextWidth)` 就是旧写法（污染来源）。 */
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
    /* ⚠️⚠️ A-1157：`!important` 从缺省变成**必需**。
       React 给 `<aside>` 写的是内联 `width`（`width={rightCustom ? rightWidth : undefined}`），
       而**内联样式压过一切没有 `!important` 的选择器规则** ⇒ 这条宽度声明曾经
       "看着在、实际不生效"，右栏在过渡期纹丝不动，wrapper 却已经跳到目标宽
       ⇒ 右缘凭空空出一段（实测 90ms 时 `sidebar=240..1239`，右缘离窗口边差 93px
       且**正在往右长**）= 用户本轮报的「右边突然出现空白，然后侧边栏向右合上」。
       ⇒ 缺了 `!important` 就会静默退回那个方向反了的过渡。 */
    expect(body).toMatch(/width:\s*var\(--right-target-w\)\s*!important\s*;/);
    /* ⚠️ 不许写 fallback：普通展开（非浮层）根本不写这个变量，
       一旦有 fallback 就会误用兜底值 ⇒ 普通展开的宽度被静默改掉。 */
    expect(body, "`var(--right-target-w)` 带了 fallback ⇒ 非浮层展开会误用兜底值").not.toMatch(/var\(--right-target-w\s*,/);
  });

  it("CSS：右栏**贴住窗口右缘**（`margin-left:auto`）—— 否则过渡是「向右合」而不是「向左挤开」", () => {
    /* ⚠️ A-1157：`.right-sidebar` 是 `.right-wrapper`（display:flex）的 flex item。
       默认它贴的是 wrapper 的**左缘**，而 wrapper 在过渡起点就跳到目标宽 ⇒ 右栏从
       左缘开始、**向右**长 ⇒ 用户看到的正是「向右合上」。
       ⇒ auto 外边距把它顶到 wrapper 右缘 ⇒ 宽度变化时右缘钉住、左缘向左推。
       ⚠️ 稳态看不出差别（那时右栏 100% 与 wrapper 等宽，auto 没有余量可吃），
         所以这条必须写成静态断言 —— 端到端探针在稳态量不到它。
       ⚠️⚠️⚠️ A-1173 改判据：这条 auto **不再限定 `body.float-layout`**，
         而是搬进了 `.right-sidebar` 的**主规则**（无条件）。
         原因：退浮层那一帧 `float-layout` 已被摘，而 wrapper 还没缩到位
         ⇒ 右栏右侧露出 135px 空白（`probe-a1173-float-jerk.mjs` 的 408~450ms）。
         ⇒ 判据改成「**存在某条 `.right-sidebar` 规则带 `margin-left: auto`**」——
            不绑定具体是哪一条（`.sidebar, .right-sidebar` 那条共用 `--rz-ramp` 的
            也会被同一个正则命中，绑"第一条"会假红）。 */
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
    /* ⚠️ 这一步很重：它让 React **卸载整棵 `<main>`（含 ChatPanel）、再在浮窗里
       挂载另一棵**（换父 ⇒ 整树重建，两棵都不复用）。
       真 App CDP + LoAF 归因（1332px 窗口，同一台机器同一场景）：
         同步提交：`慢帧 80~91ms`、`longtask=[]`、`LoAF{start:35ms dur:80ms renderStart:77ms scripts:[]}`
         并发提交：`慢帧 55~59ms`、`LoAF{start:25ms dur:59ms renderStart:54ms}`
       ⇒ 掉帧不在脚本里、也不在渲染里（renderStart 已到 54~77ms），
         卡在「帧开始 → 浏览器开始渲染」之间，与换父重建的规模吻合。
       ⚠️ 对照实验（探针**不读任何几何 API**）量到的仍是 80ms（读几何时 87~91ms）
         ⇒ 这不是测量误差，是界面自己的停顿。
       ⚠️ 本条只把停顿压小约 35%，**没有消除** —— 剩下的属架构性代价
         （A-1152 记过：改成「`<main>` 兼作浮窗、单宿主」实测有可见回归）。 */
    expect(APP_CODE).toMatch(/React\.startTransition\(\(\)\s*=>\s*\{\s*setFloatState\("float"\);\s*\}\)/);
  });

  it("⚠️ 其余状态**不许**包进 startTransition（在驱动动画，延迟它反而更糟）", () => {
    /* `rightMin0` 是几何动画的驱动力，必须同步提交 ⇒ 只能包 `setFloatState` 这一处。
       若哪天有人把 `animateRightSidebar(...)` 也挪进去，动画起点会被推迟一帧以上。 */
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
    /* ⚠️ 若这条规则里出现 .chat-scroll，淡出会被一起关掉 ⇒ 变硬跳。 */
    expect(m![1], "slime-dragging 规则里不许出现 .chat-scroll").not.toMatch(/chat-scroll/);
  });
});

describe("A-1153 ⑤ 恢复方向也必须有过渡（摘类时 transition 声明不能跟着消失）", () => {
  it("`.chat-scroll` 有**常驻** opacity 过渡（不带 body 前缀的那条）", () => {
    /* ⚠️ 真 bug：过渡只写在 `body.slime-fading .chat-scroll` 里 ⇒ 摘类时声明一起消失
       ⇒ opacity 从 0 瞬间跳回 1 = 用户看到的"闪烁"。 */
    const m = /(^|\n)\.chat-scroll\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到 .chat-scroll 的常驻规则 ⇒ 摘类时没有过渡可用（硬跳）").toBeTruthy();
    expect(m![2]).toMatch(/transition:\s*opacity/);
  });

  it("`endChatFreeze` 的兜底定时器**不许**递归自调用（a1152 ⑫ 同一条不变量，这里再钉一次）", () => {
    const body = fnBody(APP_CODE, "endChatFreeze");
    const tAt = body.indexOf("setTimeout(");
    expect(tAt, "找不到兜底定时器（守卫自己失效了）").toBeGreaterThan(-1);
    /* ⚠️ 判据 = "**定时器起点之后**不许再出现 `endChatFreeze(`"。
       不要写成 `setTimeout\([^)]*=>…endChatFreeze\(\)`：`setTimeout(() => …` 里
       紧跟着就是 `()`，而 `[^)]*` 一遇到 `)` 就停 ⇒ **该正则永远匹配不到** ⇒ 假守卫。
       （这条正是 M13 变异第一次"存活"的原因 —— 变异测试替我们抓出了它。） */
    expect(
      body.slice(tAt),
      "兜底定时器递归调用了自己 ⇒ 每次拖拽都留下一条永不停止的摘类循环（闪烁根因）",
    ).not.toMatch(/endChatFreeze\s*\(/);
  });
});

/* ⚠️⚠️⚠️ A-1160：**浮窗不许有任何"进场"动画**。
   这条动画连着试了两种实现，**两次都被用户实拍证伪**，而且它本身制造了用户报的病症：

   ① `opacity: 0→1`（A-1159）：浮窗 `position: fixed` **浮在右栏之上**，半透明 ⇒
      下方正在滑动的右栏内容直接透出来，聊天气泡与「会话指标 / 累计tokens」
      两张卡**叠印在同一块区域**（用户截图为证）。

   ② 只留 `transform: scale(0.985)`（A-1159-R）：用户随即指出**浮窗与右栏之间那条边界
      在窗口化那一瞬"剧烈左右抖动"**、右栏跟着摇摆闪烁。机制：`scale` 让浮窗**整条边界
      位移**（宽 666 从 98.5% 起 ⇒ 右边缘先缩进 ~10px 再弹回）；而那条边界正是浮窗与右栏的
      **唯一可见分界**。更糟：只要 `body.float-layout` / `.float-window` 的 class 在过渡中
      抖一下，一次性动画就**从头重播** ⇒ 右边缘被反复拽回再弹出 = 剧烈抖动。
      另：`transform` 还会给 `fixed` 后代**造出包含块**，与拖拽/最小化的几何渐隐互相干扰。

   ⇒ 结论（比"用什么动画"更重要的一条）：**浮窗以终态瞬现，不要给它任何进场动效。**
     真正要顺的是右栏那条过渡，它本来就顺；动浮窗只会把那条边界搅乱。

   ⚠️ 下面三条判据一律写成"**整段不存在**"，而不是"某属性不允许"：
      那两种失败模式（半透明、位移边界）分属**不同属性**，逐属性放行等于给回归留后门
      —— 上一个版本的守卫就是"不许有 opacity、但必须有 scale"，结果 scale 恰好是②的病根。 */
describe("A-1160 浮窗**不许有进场动画**（进场动效本身就是病症）", () => {
  it("`@keyframes float-enter-a1159` 必须**整条不存在**", () => {
    expect(CSS_CODE, "浮窗进场 keyframes 又回来了 ⇒ 半透明叠印 / 边界位移两症都会复发")
      .not.toMatch(/@keyframes\s+float-enter-a1159/);
  });

  it("`.float-window` 上不许出现 `animation`（含 `body.float-layout` 变体）", () => {
    /* ⚠️ 必须连 `body.float-layout .float-window` 一起查：上一版就是只挂在那个变体上的，
       只查裸 `.float-window` 会漏。 */
    const rules = CSS_CODE.match(/[^{}]*\.float-window[^{}]*\{[^}]*\}/g) || [];
    expect(rules.length, "找不到 .float-window 的规则 ⇒ 守卫自己失效了").toBeGreaterThan(0);
    for (const r of rules) {
      expect(r, "规则里出现了 animation：" + r.slice(0, 80)).not.toMatch(/(^|[;{\s])animation(-[a-z]+)?\s*:/);
    }
  });

  /* ⚠️ A-1152/A-1160：浮窗**必须显式不透明**。它下方就是右栏，
     "恰好继承到不透明"不等于"写明了不透明" —— 将来有人加 opacity 过渡就会叠印。 */
  it("浮窗显式 `opacity: 1`（它的下方就是右栏，半透明必然叠印）", () => {
    const r = /(^|\n)\.float-window\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(r, "找不到裸 `.float-window` 规则").toBeTruthy();
    expect(r![2], "浮窗必须显式写死 opacity: 1").toMatch(/opacity:\s*1\s*;/);
  });
});

/* ⚠️⚠️ A-1161：`.chat-scroll` 必须**预留滚动条槽位**（`scrollbar-gutter: stable`）。
   用户报「窗口化那一瞬边界剧烈左右抖动，右栏恢复与展开左右摇摆闪烁」。
   机制：聊天区的 `::-webkit-scrollbar-*` 在 Chromium 121+ **全部失效**（本文件里记着：
   标准属性优先 ⇒ 连全局那条 5px 都失效）⇒ 用的是**平台默认滚动条**，它**随内容高度
   出现/消失**。窗口化/恢复时会话内容重新挂载、内容高度逐帧变化 ⇒ 滚动条一出现/消失，
   **内容区宽度就变一格**（Windows 默认 ~17px）⇒ 聊天区内所有东西左右跳一格
   ⇒ 观感就是浮窗右缘那条边界在"剧烈左右抖动"。
   ⚠️ 为什么不用 `overflow-y: scroll` 强制常驻：那会让**从不溢出的会话也留一条空槽**，
      右边永久让掉 17px；`stable` 只在**需要时**预留。
   ⚠️ 为什么这条能绕开 webkit 失效：`scrollbar-gutter` 是**独立属性**，不受影响。
   ⚠️ 诚实边界：**因果链未在真机闭环验证** —— 探针在**空会话**里测到槽宽恒为 0
      （复现不出用户的条件：他的会话有长消息、会溢出）。改动本身零风险。 */
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