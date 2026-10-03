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

  it("CSS：浮层态右栏**贴住窗口右缘**（`margin-left:auto`）—— 否则过渡是「向右合」而不是「向左挤开」", () => {
    /* ⚠️ A-1157：`.right-sidebar` 是 `.right-wrapper`（display:flex）的 flex item。
       默认它贴的是 wrapper 的**左缘**，而 wrapper 在过渡起点就跳到目标宽 ⇒ 右栏从
       左缘开始、**向右**长 ⇒ 用户看到的正是「向右合上」。
       ⇒ auto 外边距把它顶到 wrapper 右缘 ⇒ 宽度变化时右缘钉住、左缘向左推。
       ⚠️ 稳态看不出差别（那时右栏 100% 与 wrapper 等宽，auto 没有余量可吃），
         所以这条必须写成静态断言 —— 端到端探针在稳态量不到它。 */
    const m = /body\.float-layout\s+\.right-sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到 `body.float-layout .right-sidebar` 规则").toBeTruthy();
    expect(m![1]).toMatch(/margin-left:\s*auto/);
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

/* ⚠️⚠️ A-1159：浮窗淡入动画必须**逐字沿用**右栏那条过渡的时长与缓动。
   用户报「点击窗口化时各个栏目的衔接动画抖动、抽搐异常明显」。
   实测（真 App CDP 逐帧）证明那**不是**"某一栏在抖"：逐栏几何全部单调、零方向反转，
   真正刺眼的是**三者不同步** —— 右栏在滑 280ms，浮窗却在第 1 帧就"啪"地出现在最终位置、
   中间页同帧硬切消失（`t=11ms host=240/380` → `t=20ms host=252/666`，此后 host 一动不动）。
   ⇒ 这两条锁住"浮窗与右栏同一条时间轴"这个事实本身。 */
describe("A-1159 浮窗与右栏**同一条时间轴**（衔接动画不抽搐）", () => {
  it("浮窗淡入动画与右栏过渡**同一时长、同一缓动**", () => {
    const animRule = /body\.float-layout \.float-window\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(animRule, "找不到 body.float-layout .float-window 的动画声明").toBeTruthy();
    const animM = /animation:\s*float-enter-a1159\s+([^;]+);/.exec(animRule![1]);
    expect(animM, "`.float-window` 必须声明 float-enter-a1159 动画").toBeTruthy();
    /* 右栏那条过渡（唯一真相源，A-1153 立的）—— 从**同一份 CSS 文本**里取，
       两边同源比较，才不会因为"抄错一个数字"而假绿。 */
    const rightRule = /body\.float-layout \.right-wrapper-anim \.right-sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(rightRule![1]).toMatch(/transition:\s*width\s+([0-9.]+m?s)\s+([^;]+);/);
    const rightDur = rightRule![1].match(/transition:\s*width\s+([0-9.]+m?s)\s+([^;]+);/)!;
    /* ⚠️ 必须一致：浮窗动画是**唯一**能让三者同拍的机制，
       时长/缓动一漂，浮窗就会先于（或晚于）右栏收尾 ⇒ 又退回"一个动、另外两个不动"。 */
    /* ⚠️ 不能用 `split(/\s+/)` 取"前两个记号"：`cubic-bezier(0.22, 0.61, 0.36, 1)`
       **本身含空格**，按空白切会把它切成四段（实测踩过：拼成 `0.28s cubic-bezier(0.22,`）。
       ⇒ 改成"去掉末尾的填充模式"再整体比较。 */
    const animFull = animM![1].trim();
    expect(animFull.endsWith(" both"), "动画必须带 fill-mode（both），否则播完会掉回初始透明度").toBe(true);
    const animTiming = animFull.replace(/\s+both$/, "");
    expect(animTiming, "浮窗动画的时长/缓动必须与右栏过渡逐字相同")
      .toBe(`${rightDur[1]} ${rightDur[2]}`.trim());
  });

  it("浮窗淡入只碰 opacity/transform，且缩放**极轻微**", () => {
    const kf = /@keyframes float-enter-a1159\s*\{([\s\S]*?)\n\}/.exec(CSS_CODE);
    expect(kf, "找不到 @keyframes float-enter-a1159").toBeTruthy();
    const from = kf![1];
    expect(from).toMatch(/from\s*\{[^}]*opacity:\s*0/);
    const scale = /from\s*\{[^}]*scale\(([0-9.]+)\)/.exec(from);
    expect(scale, "from 必须带 scale（否则浮窗是硬切出现，没有『跟着长出来』的暗示）").toBeTruthy();
    expect(Number(scale![1]), "起始缩放应在 0.97~0.99（0.9 之类会变成『弹一下』，反而更像抽搐）")
      .toBeGreaterThanOrEqual(0.97);
    expect(Number(scale![1])).toBeLessThanOrEqual(0.99);
    /* ⚠️ 只允许碰 opacity/transform：碰几何（left/top/width/height）就又与右栏的滑动不同步 ——
       那正是本组要根除的病症。 */
    const props = from
      /* ⚠️ 必须先剥掉 `from {` / `to {` **选择器**，否则切出来的第一个"属性"是
         "from  opacity" 这种把选择器和声明粘在一起的东西。 */
      .replace(/(^|[\s{}])(from|to)\s*\{/g, " ")
      .replace(/[{}]/g, "")
      .split(";").map((s) => s.split(":")[0].trim()).filter(Boolean);
    expect(props.length, "keyframes 解析为空 ⇒ 守卫自己失效了").toBeGreaterThan(0);
    for (const p of props) {
      expect(["opacity", "transform"], `keyframes 里不该出现属性 ${p}`).toContain(p);
    }
  });
});
