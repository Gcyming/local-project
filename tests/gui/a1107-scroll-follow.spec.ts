/**
 * tests/gui/a1107-scroll-follow.spec.ts — 「锁定吐字最新」（贴底自动跟随）的守卫。
 *
 * 为什么必须有：这一项**完全属于「静默失效」家族** —— 判反了不报错、过 tsc、过构建、
 * 过所有别的测试，只在用户手里变成「想往上滚，但程序不准你往上」。
 *
 * 用户原话（A-1107）：「现在锁定在吐字最新的功能有点问题，有时候用户想往上滚动很费劲，
 * 会抖动半天，有种用户想往上，但是程序不准你往上的感觉。」
 *
 * 用户原话（A-1109，第二轮 —— 第一版**反而更糟**）：「现在锁定最新吐字位置的功能不仅
 * 时常出现不能在用户滚到最新吐字位置后锁定在最新位置的情况，还会在途中偶尔出现反复
 * 上下抖动的情况，你这比改动之前还糟糕啊。」
 *
 * ⚠️ A-1109 对本 spec 做了**迁移**（不是删除）：第一版那条「方向支」的断言已随实现一起
 *    撤掉 —— 它锁的是一个**必然误判**的判据（重排会把 `scrollTop` 钳小，方向支读到
 *    「变小」就当成用户上翻）。留下它 = 假守卫。取而代之的是下面 ①②③ 三条
 *    「滞回 + 不误判」的断言，覆盖同一份用户意图（上翻要能压过跟随、回底要能恢复）。
 *
 * ⚠️ 本 spec 的重点是**行为**（`decideFollow` / `hasInnerScroller` 是纯函数，能直接喂值）；
 *    文本断言只用来钉「接线还在」—— 函数写对了但没接到滚动容器上 = 一样静默失效。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FOLLOW_RELEASE_PX,
  FOLLOW_RESUME_PX,
  decideFollow,
  hasInnerScroller,
} from "../../gui/src/renderer/scrollFollow.js";

const ROOT = resolve(__dirname, "../..");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");

/** 剥注释：注释里写着「曾经是什么」/ 用户原话，不该被当成当前代码断言。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const PANEL_CODE = stripComments(PANEL);

describe("A-1109 判据（scrollFollow.ts）：滞回 + 不看方向 —— 修「锁不住 + 抖动」", () => {
  it("① 重排把 `scrollTop` 钳小 ⇒ **仍然跟随**（A-1107 的回归：方向支把它误判成「用户上翻」）", () => {
    /* 场景：贴底中（gap=0）。某一帧 markdown 重排，scrollHeight 从 1600 掉到 1580，
       浏览器把 top 从 1000 **钳小**到 980 —— 用户**什么都没做**。
       旧实现的方向支读到 `top(980) < prevTop(1000)` ⇒ 判「用户在上翻」⇒ 解掉跟随
       ⇒ 视口停在半空且再也锁不回来（症状①「滚到最新也锁不住」）。
       新判据只看 gap：1580 - 980 - 600 = 0 ⇒ 继续跟随。 */
    expect(
      decideFollow({ top: 980, scrollHeight: 1580, clientHeight: 600, following: true }),
      "重排（scrollHeight 变小把 scrollTop 钳小）被误判成用户上翻 —— 这正是「滚到最新也锁不住」",
    ).toBe(true);
  });

  it("② 滞回区（8 < gap ≤ 48）**保持现状** —— 这是「抖动」在结构上不可能发生的原因", () => {
    /* 滞回的核心：落在中间区时**不动**。少了这一条，解锁与重锁会在阈值两侧
       来回切换（用户看到的就是「反复上下抖动」）。两个方向都必须保持。
       ⚠️ 取 top=970 ⇒ gap = 1600-970-600 = **30**，稳稳落在 (8, 48] 里。
          （写 937 会得到 gap=63 > 48 ⇒ 落到「明确离开底部」那一支，测的就不是滞回了。） */
    expect(
      decideFollow({ top: 970, scrollHeight: 1600, clientHeight: 600, following: false }),
      "不动作区里把已解锁的跟随又锁回来 —— 用户会被拽回底部（「不准我往上」）",
    ).toBe(false);
    expect(
      decideFollow({ top: 970, scrollHeight: 1600, clientHeight: 600, following: true }),
      "不动作区里把跟随解掉 —— 用户只上翻了一点点，跟随不该断",
    ).toBe(true);
    /* 阈值必须**严格不等**：相等就没有不动作区，抖动必然复现。 */
    expect(FOLLOW_RELEASE_PX, "解锁阈值被改成 ≤ 重锁阈值 —— 滞回区消失，抖动会复发").toBeGreaterThan(FOLLOW_RESUME_PX);
    expect(FOLLOW_RESUME_PX, "重锁阈值被放大 —— 用户小幅上翻会被立刻拽回底部").toBeLessThanOrEqual(8);
  });

  it("③ 真的回到底部 ⇒ 恢复跟随；明确离开底部 ⇒ 松手", () => {
    /* 离底 0px（贴底）⇒ 跟随。 */
    expect(decideFollow({ top: 1000, scrollHeight: 1600, clientHeight: 600, following: false })).toBe(true);
    /* 离底 2px ≤ 8 ⇒ 视为「真的到底」⇒ 跟随。 */
    expect(decideFollow({ top: 998, scrollHeight: 1600, clientHeight: 600, following: false })).toBe(true);
    /* 离底 100px > 48 ⇒ 用户明确在看历史 ⇒ 不打扰。 */
    expect(decideFollow({ top: 900, scrollHeight: 1600, clientHeight: 600, following: true })).toBe(false);
    /* 内容不足一屏（scrollHeight == clientHeight）⇒ gap = -top ≤ 8 ⇒ 跟随。 */
    expect(decideFollow({ top: 0, scrollHeight: 600, clientHeight: 600, following: false })).toBe(true);
  });

  it("④ 内层可滚盒子才算「内层滚动」；overflow:visible 的更高元素不算（否则判据整体失效）", () => {
    expect(hasInnerScroller([])).toBe(false);
    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "auto" }])).toBe(true);
    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "scroll" }])).toBe(true);
    /* ⚠️ 反面：内容更高但 `overflow: visible` —— 它只是被撑高，**不产生**自己的滚动条。
       误判成「内层滚动」的后果：用户在代码块上随便滚一下，整条对话流的自动跟随就永远解不掉了。 */
    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "visible" }])).toBe(false);
    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "hidden" }])).toBe(false);
    /* 假溢出（取整造出的 1px 差）不算。 */
    expect(hasInnerScroller([{ scrollHeight: 101, clientHeight: 100, overflowY: "auto" }])).toBe(false);
    expect(hasInnerScroller([{ scrollHeight: 102, clientHeight: 100, overflowY: "auto" }])).toBe(true);
  });
});

describe("A-1109 接线：`wheel` 是用户上翻的唯一即时信号，且必须能**锁回来**", () => {
  it("⑤ 滚轮判据挂在 scrollRef 的那个 div 上，且向上/向下**分别**处理", () => {
    expect(PANEL_CODE, "onWheel 没接到滚动容器上 —— 用户上滚不会被识别，手感回到「被按住」")
      .toMatch(/ref=\{scrollRef\}[^>]*onWheel=\{handleWheel\}/);
    expect(PANEL_CODE).toMatch(/function handleWheel\(e: React\.WheelEvent<HTMLDivElement>\): void \{/);
    /* 纯水平滚动（deltaY === 0）必须忽略；判成「向上」会让横向滚动也解掉跟随。 */
    expect(PANEL_CODE, "handleWheel 没排除纯水平滚动（deltaY === 0）")
      .toMatch(/if \(e\.deltaY === 0\) \{ return; \}/);
    /* ⚠️ 向下滚必须**单独成支**并携带「重锁」：没有它存在一条**永久失锁**路径
       —— 跟随被解掉、而视口恰在底部（gap≈0）时，向下滚**不产生 scroll 事件**
       ⇒ 距离支永远不执行 ⇒ 再也锁不回来（用户原话「滚到最新也锁不住」）。 */
    expect(PANEL_CODE, "handleWheel 没有「向下滚」分支 —— 会留下永久失锁路径")
      .toMatch(/if \(e\.deltaY > 0\) \{/);
    /* 内层判据的**极性**：`if (hasInnerScroller(...)) return;`。
       写成 `!hasInnerScroller(...)` 恰好反了 —— 在代码块上滚会解锁外层，在外层上滚反而不解锁。 */
    expect(PANEL_CODE, "内层可滚守卫的极性反了（写成 !hasInnerScroller）")
      .toMatch(/if \(hasInnerScroller\(ancestors\)\) \{ return; \}/);
    expect(PANEL_CODE, "内层可滚守卫的极性反了").not.toMatch(/!\s*hasInnerScroller\(/);
    /* 度量必须**真的从 DOM 读**：写死 `"auto"` 会让任何更高的祖先都被当成「内层滚动」
       ⇒ 外层上滚永远解不了锁（用户上滚彻底失效，且静默）。 */
    expect(PANEL_CODE, "handleWheel 没从 DOM 读 overflowY（写死会让外层上滚彻底失效）")
      .toMatch(/overflowY: getComputedStyle\(n\)\.overflowY/);
  });

  it("⑥ 解锁/回锁必须**同步**写 ref（只 setState 会晚一整轮渲染，那一帧仍在拉底）", () => {
    expect(PANEL_CODE, "handleWheel 没同步写 atBottomRef —— 本帧的贴底循环看不到解锁，照旧拉底")
      .toMatch(/atBottomRef\.current = false;\s*\n\s*setAtBottom\(false\);/);
    /* ⚠️ 那句 `atBottomRef\.current = true;` 在本文件里出现 **2 次**（handleWheel 向下支 +
       jumpToLatest）⇒ 裸模式是**恒真断言**：删掉任意一处，另一处照样匹配、守卫照样绿
       （变异实测：M5 就是从这个洞逃逸的）。必须带上**各自唯一的后续行**把范围钳死：
         · handleWheel 向下支 → 后随 `return;`
         · jumpToLatest      → 后随 `setAtTop(el ? …)` */
    expect(PANEL_CODE, "handleWheel 的「向下滚回锁」没同步写 atBottomRef")
      .toMatch(/atBottomRef\.current = true;\s*\n\s*setAtBottom\(true\);\s*\n\s*return;/);
    expect(PANEL_CODE, "handleScroll 没同步写 atBottomRef —— 贴底循环要等一整轮渲染才看到")
      .toMatch(/atBottomRef\.current = next;/);
    expect(PANEL_CODE, "jumpToLatest 没同步写 atBottomRef —— 点了准星却要等一帧才开始跟随")
      .toMatch(/atBottomRef\.current = true;\s*\n\s*setAtBottom\(true\);\s*\n\s*setAtTop\(el \?/);
  });

  it("⑦ 判据唯一出处：ChatPanel 不许再自己算离底阈值，**也不许再引入方向支**", () => {
    expect(PANEL_CODE, "ChatPanel 里又出现裸的「离底 < 48」判据（第二产地）")
      .not.toMatch(/scrollHeight\s*-\s*\w+\s*-\s*\w+\s*<\s*48/);
    /* A-1109 回归守卫：方向支（拿上一帧 scrollTop 比大小）是「重排误判」的**唯一**来源，
       它把程序自己的写入当成用户意图。任何形式的重现都必须打红。 */
    expect(PANEL_CODE, "ChatPanel 里又拿「上一帧 scrollTop」做方向判据了（重排会误判成用户上翻）")
      .not.toMatch(/lastScrollTop|prevTop/);
    expect(PANEL_CODE, "ChatPanel 没接上唯一出处")
      .toMatch(/import \{ FOLLOW_RESUME_PX, decideFollow, hasInnerScroller, type ScrollBox \} from "\.\.\/scrollFollow\.js";/);
    /* 滞回必须**把现状喂进去** —— 漏了 `following` 就等于没有滞回（中间区无从判断）。 */
    expect(PANEL_CODE, "decideFollow 调用没传 following —— 滞回失效，抖动会复发")
      .toMatch(/decideFollow\(\{\s*\n\s*top,\s*\n\s*scrollHeight: el\.scrollHeight,\s*\n\s*clientHeight: el\.clientHeight,\s*\n\s*following: atBottomRef\.current,/);
  });
});

/**
 * A-1112：回底胶囊（「回到最新」）必须**脱离文档流**。
 *
 * 用户原话：「每次从非最新滚到最新，中间界面都会抖动一次。」
 *
 * 真根因（不是虚化遮罩）：胶囊原先在**流内**渲染 ⇒ `{!atBottom && …}` 的出现/消失会改变
 * 消息区的高度。滚动容器是 `flex: 1`，它一增高 ⇒ `clientHeight` 变 ~+30px（≈22px 胶囊 +
 * 8px `marginTop`）⇒ 浏览器**钳**着改 `scrollTop` ⇒ 可视内容整体位移一次。
 * 那两块 `scroll-fade-mask` 是 `opacity` 过渡的 absolute 覆盖层、不参与布局 —— 所以
 * 「去掉虚化」不可能修好它（当时差点按那个方向改）。
 *
 * ⚠️ 为什么必须静态守卫：`position: "relative"` 与 `"absolute"` 只差一个词，
 *   过 tsc、过构建、过所有逻辑测试，只在用户滚到底的那一刻抖一下。
 */
describe("A-1112 回底胶囊：脱离文档流 + 不吃消息区的点击", () => {
  const CAPSULE_AT = PANEL_CODE.indexOf("{!atBottom && (");
  const SEG = CAPSULE_AT >= 0 ? PANEL_CODE.slice(CAPSULE_AT, CAPSULE_AT + 2000) : "";

  it("① 条件 + **紧跟的** `position: absolute`（回到流内 = 「非最新→最新」再抖一次）", () => {
    /* 条件与定位写进**同一条**断言：只锁 `absolute` 会被"条件恒真、胶囊常驻"绕过；
       只锁条件则放任它回到流内。 */
    expect(PANEL_CODE, "回底胶囊不在 `!atBottom` 条件里、或不再是绝对定位（回到流内 ⇒ 抖动复发）")
      .toMatch(/\{!atBottom && \(\s*<div style=\{\{\s*\n\s*position:\s*"absolute"/);
    expect(CAPSULE_AT, "找不到回底胶囊那一块（结构被改了）").toBeGreaterThan(-1);
    expect(SEG, "找不到胶囊按钮（jumpToLatest 没接上？）").toMatch(/<button onClick=\{jumpToLatest\}/);
    /* 反面：旧实现里那个**流内占位块**的 `marginTop: 8` 是"占位"的痕迹 —— 它回来就说明
       又躺回文档流（哪怕 position 还写着 absolute，marginTop 也不该出现在浮层上）。 */
    expect(SEG.slice(0, 420), "浮层里出现了 marginTop —— 那是流内占位块的写法").not.toMatch(/marginTop/);
  });

  it("② 指针事件分层：外层 none（不吃点击/选词）+ 按钮自己 auto（还点得动）", () => {
    expect(SEG, "浮层没有关掉指针事件 —— 它会吃掉消息区下半屏的点击与选词").toMatch(/pointerEvents:\s*"none"/);
    expect(SEG, "按钮没把命中收回来（pointerEvents: auto）—— 于是这枚胶囊点不动")
      .toMatch(/pointerEvents:\s*"auto"/);
  });

  it("③ 胶囊住在**消息区 wrapper** 里、排在底部遮罩之后（不是滚动内容的一部分）", () => {
    const lastMask = PANEL_CODE.lastIndexOf("scroll-fade-mask");
    expect(lastMask, "找不到渐变遮罩 —— 断言对象搞错了").toBeGreaterThan(-1);
    /* 遮罩与胶囊是**同一个 wrapper** 的两个绝对定位子元素。胶囊若排在遮罩**之前**，
       说明它又回到了 `scrollRef` 那个 div 内部（= 滚动内容的一部分）—— 那正是抖动的产地。 */
    expect(CAPSULE_AT, "胶囊排到了遮罩之前（回到了滚动内容里）—— 它又会参与文档流")
      .toBeGreaterThan(lastMask);
    /* wrapper 必须仍是定位祖先 —— 否则 `absolute` 会去找更外层的祖先，`bottom: 10` 的基准全变。 */
    expect(PANEL_CODE, "消息区 wrapper 不再是 position: relative（绝对定位的基准没了）")
      .toMatch(/\{\s*flex:\s*1,\s*minHeight:\s*0,\s*position:\s*"relative"\s*\}\}>/);
  });
});
