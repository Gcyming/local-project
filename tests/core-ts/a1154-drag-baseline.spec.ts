/**
 * tests/core-ts/a1154-drag-baseline.spec.ts — 拖拽**基准**与临时类完整性守卫（A-1154）。
 *
 * ## 为什么还要单独一个 spec（A-1153 已经锁了 13 条）
 * A-1153 锁的是「浮层铺满 ↔ 右栏宽度状态」的解耦。本轮用**真 App CDP 端到端取证**
 * （`gui/scripts/probe-drag-robust.mjs` / `probe-sidebar-e2e-cdp.mjs`）又抓到 4 条
 * **A-1153 完全没覆盖**的根因 —— 它们都在"拖动"这条路径上，且都会**静默**回归：
 *
 * | # | 缺陷 | 用户看到什么 | 真机证据 |
 * |---|---|---|---|
 * | 1 | `startWidth` 取的是 `rightWidthRef`（**请求值**），不是 DOM 实宽 | 第 1 轮拖动"完全无响应"，要左右多拖几次才恢复 | `probe-drag-robust` 第 1 轮 `宽 712 → 712`（同页第 2 轮起正常） |
 * | 2 | 持久化 px 宽度在窗口尺寸变化后**越界不收敛** | 「对话页自适应窗口调整失效」／拖拽基准错位 | 上限 `min(innerWidth-48, innerWidth-左栏-380)` 随窗口变，而 state 停在旧值 |
 * | 3 | `slime-dragging` **只禁宽度过渡**，没禁文本选中 / 没定光标 | 拖动头 140ms 内把对话区拖出蓝色选区 + 光标跳变（"一拖就闪一下"的杂讯源） | CSS `body.slime-dragging` 只有 `transition: none` |
 * | 4 | `GEOM_SYNC_NEVER_MOUNT_FRAMES`（"对象从未挂载"的有界等待）若被删/改成无限等 | `slime-freezing` + `--slime-freeze-w` 永久残留 ⇒ 聊天区被钉死 | `hidden=true` 取证环境会掩盖它（rAF 停摆），所以必须有**形状守卫**兜住 |
 *
 * ## 判据风格
 * 与 a1153 一致：**剥注释**后做形状断言（不渲染组件、不依赖会话数据）。
 * ⚠️ 本仓注释里大量引用"被删掉的旧写法"，不剥注释就会假红/假绿。
 *
 * ⚠️ 关于"数值"类判据（如 `startWidth` 该读什么）：
 * 光断言"出现了 `getBoundingClientRect`"是**弱判据**（别处也可能有）。
 * 这里的判据锚的是**同一个语句内的配对**：`startWidth` 的右值必须来自 `getBoundingClientRect`，
 * 且**不许**回落成 `rightWidthRef` / `sidebarWidthRef`（那正是被修掉的旧写法）。
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

/** 取 `function X(...) { ... }` 的函数体（到下一个顶格 `  }` 为止）。 */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^]*?\\n  \\}`).exec(src);
  expect(m, `取不到 ${name}（守卫自己失效了）`).toBeTruthy();
  return m![0];
}

describe("A-1154 ① 拖拽基准必须取 **DOM 实测宽度**（否则第 1 轮拖动无响应）", () => {
  it("`handleRightbarResize`：`startWidth` 来自 `getBoundingClientRect()`，**不是** `rightWidthRef`", () => {
    const body = fnBody(APP_CODE, "handleRightbarResize");
    /* 判据 1：`startWidth` 的右值必须含 `getBoundingClientRect`。 */
    expect(
      /const\s+startWidth\s*=[^;]*getBoundingClientRect/.test(body),
      "`startWidth` 没取 DOM 实测宽 ⇒ 与实宽错位时拖动基准错（真机实测：第 1 轮 712→712 完全无响应）",
    ).toBe(true);
    /* 判据 2：**不许**出现 `const startWidth = rightWidthRef.current` 这条被修掉的旧写法。
       ⚠️ 用"整句"匹配而不是全文 `includes`：`rightWidthRef.current` 在函数里还有别的合法用处
       （`dismissFloat` 里读它算主区目标宽），只锚 `startWidth` 的赋值才精确。 */
    expect(
      /const\s+startWidth\s*=\s*rightWidthRef\.current\s*;/.test(body),
      "`startWidth` 又回落成 state（请求值）—— 这正是被修的旧写法",
    ).toBe(false);
  });

  it("`handleSidebarResize`：同样取实测宽（`.sidebar` 有 max/min-width，也会错位）", () => {
    const body = fnBody(APP_CODE, "handleSidebarResize");
    expect(
      /const\s+startWidth\s*=[^;]*getBoundingClientRect/.test(body),
      "左栏 `startWidth` 没取 DOM 实测宽（`.sidebar` 有 max-width:520/min-width:240 ⇒ 同样会错位）",
    ).toBe(true);
    expect(
      /const\s+startWidth\s*=\s*sidebarWidthRef\.current\s*;/.test(body),
      "左栏 `startWidth` 又回落成 state",
    ).toBe(false);
  });

  it("落 state / localStorage 前必须 `Math.round`（实测宽是浮点，别把 286.375 写进持久层）", () => {
    /* ⚠️ 判据必须是**配对**（"写出去的那个值被 round 过"），不能只数 `Math.round(` 出现次数：
       函数体里还有别的 round（如 `Math.round(window.innerWidth * ratio)`）⇒ 删掉落盘那处
       计数仍 ≥1、断言照样绿 = **弱判据**（变异实测 M3 因此"存活"）。
       ⇒ 逐条锚"落盘语句的右值带 Math.round"：
         · `setSidebarWidth(Math.round(...))` / `setRightWidth(Math.round(...))`（onCancel 路径）
         · `localStorage.setItem('slime_*_w', String(<round 过的值>))`（onUp 路径） */
    /* 右栏 onUp：`let w = …; …; w = Math.round(w); localStorage.setItem(…, String(w)); setRightWidth(w);`
       ⇒ 判据锚 `w = Math.round(w)` 这一句（它是"写出去的那个值"的净化点）。
       左栏 onUp：`const w = Math.round(Math.max(…)); setSidebarWidth(w); localStorage.setItem(…, String(w));`
       ⇒ 判据锚 `const w = Math.round(`。
       两栏结构不同，**不能用同一条正则**（照抄一条会漏掉另一栏 = 假守卫）。 */
    {
      const rBody = fnBody(APP_CODE, "handleRightbarResize");
      expect(
        /\bw\s*=\s*Math\.round\(w\)/.test(rBody),
        "右栏 onUp 落盘前没 `w = Math.round(w)` ⇒ 实测浮点宽被写进 state/localStorage",
      ).toBe(true);
      const lBody = fnBody(APP_CODE, "handleSidebarResize");
      expect(
        /const\s+w\s*=\s*Math\.round\(/.test(lBody),
        "左栏 onUp 落盘前没把宽 round 到整数",
      ).toBe(true);
    }
    for (const fn of ["handleSidebarResize", "handleRightbarResize"]) {
      const body = fnBody(APP_CODE, fn);
      /* ⚠️ setter 名字不对称，别想当然：左栏是 `setSidebarWidth`，右栏是 `setRightWidth`
         （**没有** `bar`）—— 写成 `setRightbarWidth` 会永远匹配不到 = 假守卫。 */
      expect(
        /set(?:Sidebar|Right)Width\(Math\.round\(/.test(body),
        `${fn} 的 onCancel 路径没把实测浮点 round 就 setState`,
      ).toBe(true);
      expect(
        /localStorage\.setItem\('slime_(?:sidebar|rightbar)_w', String\([^)]*\)\)/.test(body),
        `${fn} 没有落 localStorage（守卫自己失效了）`,
      ).toBe(true);
      /* 落盘那句的取值表达式必须来自 round 过的值（`String(w)` / `String(restoreW)` 里的标识符
         必须在同一函数内被 round 过）—— 这条兜住"onUp 之外的落盘点"漏改。 */
      const setItemIdx = body.indexOf("localStorage.setItem('slime_");
      const seg = body.slice(Math.max(0, setItemIdx - 700), setItemIdx + 80);
      expect(
        /Math\.round\(/.test(seg),
        `${fn} 里写进 localStorage 的那个宽度没经过 Math.round（浮点污染持久层）`,
      ).toBe(true);
    }
  });
});

describe("A-1154 ② 持久化 px 宽度在窗口变化时**必须收敛到合法区间**", () => {
  it("存在一个监听 `resize` 且把 `rightWidth` 钳进 `[minW, maxW]` 的 effect", () => {
    /* ⚠️ 判据分三步（不分一条长正则：`APP_CODE` 已剥注释，但语句间隔不定长，
       用 `[\s\S]{0,N}` 这种**有界窗口**匹配会随无关代码增删而静默失配 —— 那种守卫是假的）。
       步骤：先定位那段 effect 的**特征开头**，再从它往后截一段区域，在区域里验三条。 */
    /* 特征：`if (!rightCustom) { return; }` 紧跟 `let rafId = 0;`（本 effect 的固定形状）。 */
    const start = APP_CODE.indexOf("if (!rightCustom) { return; }");
    expect(
      start,
      "找不到「rightCustom 为假就跳过」的钳制 effect 开头 ⇒ 窗口变化时持久化 px 宽度不收敛（不再自适应）",
    ).toBeGreaterThan(-1);
    /* 截到本 effect 的 return 清理行（`window.removeEventListener("resize"`）为止。 */
    const endMark = APP_CODE.indexOf('window.removeEventListener("resize"', start);
    expect(endMark, "钳制 effect 没有收尾（守卫自己失效了）").toBeGreaterThan(start);
    const region = APP_CODE.slice(start, endMark);
    expect(region, "钳制区里没有监听 resize").toMatch(/window\.addEventListener\("resize"/);
    expect(region, "钳制区里没有 rightSidebarMinW()").toMatch(/rightSidebarMinW\(\)/);
    expect(region, "钳制区里没有 rightSidebarMaxW()").toMatch(/rightSidebarMaxW\(\)/);
    expect(region, "钳制结果没有回写 setRightWidth（钳了但没生效）").toMatch(/setRightWidth\(/);
  });
});

describe("A-1154 ③ `slime-dragging` 必须一次性给全「拖动期语义」", () => {
  it("CSS：挂着 `slime-dragging` 时禁文本选中 + 定住 col-resize 光标", () => {
    /* ⚠️ 真问题：拖动头 140ms 内（`slime-resizing` 还没挂）鼠标划过对话区会把大段文本
       拖成蓝色选区，松手消失 —— 观感就是"一拖就闪一下"的杂讯。
       ⇒ 这两条与"禁宽度过渡"同属拖动期语义，必须一起挂在**同一个** `slime-dragging` 上。 */
    const m = /(^|\n)body\.slime-dragging\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到 `body.slime-dragging { … }` 这条规则").toBeTruthy();
    const rule = m![2];
    expect(rule, "拖动期没禁文本选中 ⇒ 拖动头 140ms 会拖出选区（闪烁杂讯）").toMatch(/user-select:\s*none/);
    expect(rule, "拖动期没定住 col-resize 光标 ⇒ 光标在拖动中跳变").toMatch(/cursor:\s*col-resize/);
  });

  it("既有的「只禁侧栏宽度过渡」那条规则仍在（别为了加语义把它改坏）", () => {
    const m = /body\.slime-dragging\s+\.sidebar,\s*body\.slime-dragging\s+\.right-sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "slime-dragging 的侧栏宽度规则不见了").toBeTruthy();
    expect(m![1]).toMatch(/transition:\s*none/);
    expect(m![1], "这条规则里不许出现 .chat-scroll（会连淡出一起关掉）").not.toMatch(/chat-scroll/);
  });
});

describe("A-1162 几何 done 必定有界（`u >= 1` 取代「等对象挂载」的帧数等待）", () => {
  it("收工判据含 `u >= 1`（对象从未挂载也必然收工）", () => {
    /* ⚠️⚠️ 这条**替换** A-1154 ④ 的 `GEOM_SYNC_NEVER_MOUNT_FRAMES` 守卫，不是绕过它。
       当时的问题是：对象从未挂载时 `seen` 恒 false ⇒ done 永不触发 ⇒ rAF 死循环 +
       `slime-freezing` / `--slime-freeze-w` **永久残留**（真 App 实测 >3.7s，聊天区被钉死）。
       当时的解法是"等 6 帧还不出现就收工"——一个**帧数**启发式。
       A-1162 把进度改成纯时间后，这个场景**根本不需要等待**：
       `done = u >= 1` 与对象在不在**完全无关**，到点必收工。
       ⇒ 守的是同一个风险（永不收工 ⇒ 临时类残留）在新结构下的等价保证。 */
    const body = fnBody(APP_CODE, "runGeometrySyncFade");
    expect(
      /const\s+done\s*=\s*[^;]*u\s*>=\s*1/.test(body),
      "done 里没有 `u >= 1` ⇒ 对象从未挂载时 rAF 可能死循环、临时类永久残留",
    ).toBe(true);
    /* ⚠️ 反向断言：旧的"靠帧数等对象挂载"机制不该复活（它是旧不确定性的来源之一）。 */
    expect(
      !/neverMount/.test(body),
      "neverMount 帧数等待又回来了 ⇒ 收工时刻重新依赖帧率",
    ).toBe(true);
  });

  it("`runGeometrySyncFade` 的 done 分支里**同时**摘 `slime-freezing` 与 `--slime-freeze-w`", () => {
    const body = fnBody(APP_CODE, "startFloatGeometryFade");
    /* ⚠️ 成对写/摘（铁律 11）：只摘 class 会让下一轮过渡第一帧就退回"没钉"；
       只摘变量则类永久残留。两条都必须有。 */
    expect(body, "几何 done 没摘 slime-freezing").toMatch(/classList\.remove\("slime-freezing"\)/);
    expect(body, "几何 done 没摘 --slime-freeze-w（成对写/摘）").toMatch(/removeProperty\("--slime-freeze-w"\)/);
  });
});

describe("A-1154 ⑤ 拖动阶段定时器必须可取消且到点校验（防「松手后才挂类」）", () => {
  it("两个 resize 处理函数都把 140ms 阶段定时器句柄存进 `dragPhaseTimerRef`", () => {
    for (const fn of ["handleSidebarResize", "handleRightbarResize"]) {
      const body = fnBody(APP_CODE, fn);
      expect(
        /dragPhaseTimerRef\.current\s*=\s*window\.setTimeout/.test(body),
        `${fn} 的阶段定时器没存句柄 ⇒ 松手后它才到点、把 slime-resizing 挂上且没人摘（闪烁 + 残留隐藏）`,
      ).toBe(true);
      /* 到点必须校验"本轮拖动是否还在进行"——没有它，clearTimeout 一旦被绕过（renderer 卡顿）
         延迟回调仍会污染。 */
      expect(
        /!document\.body\.classList\.contains\("slime-dragging"\)\s*\)\s*\{\s*return/.test(body),
        `${fn} 的阶段定时器没有「拖动已结束则作废」的校验`,
      ).toBe(true);
    }
  });

  it("`endChatFreeze` 会取消那条阶段定时器（三条结束路径共用它）", () => {
    const body = fnBody(APP_CODE, "endChatFreeze");
    expect(
      /clearTimeout\(dragPhaseTimerRef\.current\)/.test(body),
      "endChatFreeze 没清阶段定时器 ⇒ 短促拖拽松手后它才挂 slime-resizing（闪烁）",
    ).toBe(true);
  });
});
