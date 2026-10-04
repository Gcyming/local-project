




















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


function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const PANEL_CODE = stripComments(PANEL);

describe("A-1109 判据（scrollFollow.ts）：滞回 + 不看方向 —— 修「锁不住 + 抖动」", () => {
  it("① 重排把 `scrollTop` 钳小 ⇒ **仍然跟随**（A-1107 的回归：方向支把它误判成「用户上翻」）", () => {
    




    expect(
      decideFollow({ top: 980, scrollHeight: 1580, clientHeight: 600, following: true }),
      "重排（scrollHeight 变小把 scrollTop 钳小）被误判成用户上翻 —— 这正是「滚到最新也锁不住」",
    ).toBe(true);
  });

  it("② 滞回区（8 < gap ≤ 48）**保持现状** —— 这是「抖动」在结构上不可能发生的原因", () => {
    



    expect(
      decideFollow({ top: 970, scrollHeight: 1600, clientHeight: 600, following: false }),
      "不动作区里把已解锁的跟随又锁回来 —— 用户会被拽回底部（「不准我往上」）",
    ).toBe(false);
    expect(
      decideFollow({ top: 970, scrollHeight: 1600, clientHeight: 600, following: true }),
      "不动作区里把跟随解掉 —— 用户只上翻了一点点，跟随不该断",
    ).toBe(true);
    
    expect(FOLLOW_RELEASE_PX, "解锁阈值被改成 ≤ 重锁阈值 —— 滞回区消失，抖动会复发").toBeGreaterThan(FOLLOW_RESUME_PX);
    expect(FOLLOW_RESUME_PX, "重锁阈值被放大 —— 用户小幅上翻会被立刻拽回底部").toBeLessThanOrEqual(8);
  });

  it("③ 真的回到底部 ⇒ 恢复跟随；明确离开底部 ⇒ 松手", () => {
    
    expect(decideFollow({ top: 1000, scrollHeight: 1600, clientHeight: 600, following: false })).toBe(true);
    
    expect(decideFollow({ top: 998, scrollHeight: 1600, clientHeight: 600, following: false })).toBe(true);
    
    expect(decideFollow({ top: 900, scrollHeight: 1600, clientHeight: 600, following: true })).toBe(false);
    
    expect(decideFollow({ top: 0, scrollHeight: 600, clientHeight: 600, following: false })).toBe(true);
  });

  it("④ 内层可滚盒子才算「内层滚动」；overflow:visible 的更高元素不算（否则判据整体失效）", () => {
    expect(hasInnerScroller([])).toBe(false);
    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "auto" }])).toBe(true);
    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "scroll" }])).toBe(true);
    

    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "visible" }])).toBe(false);
    expect(hasInnerScroller([{ scrollHeight: 300, clientHeight: 100, overflowY: "hidden" }])).toBe(false);
    
    expect(hasInnerScroller([{ scrollHeight: 101, clientHeight: 100, overflowY: "auto" }])).toBe(false);
    expect(hasInnerScroller([{ scrollHeight: 102, clientHeight: 100, overflowY: "auto" }])).toBe(true);
  });
});

describe("A-1109 接线：`wheel` 是用户上翻的唯一即时信号，且必须能**锁回来**", () => {
  it("⑤ 滚轮判据挂在 scrollRef 的那个 div 上，且向上/向下**分别**处理", () => {
    expect(PANEL_CODE, "onWheel 没接到滚动容器上 —— 用户上滚不会被识别，手感回到「被按住」")
      .toMatch(/ref=\{scrollRef\}[^>]*onWheel=\{handleWheel\}/);
    expect(PANEL_CODE).toMatch(/function handleWheel\(e: React\.WheelEvent<HTMLDivElement>\): void \{/);
    
    expect(PANEL_CODE, "handleWheel 没排除纯水平滚动（deltaY === 0）")
      .toMatch(/if \(e\.deltaY === 0\) \{ return; \}/);
    


    expect(PANEL_CODE, "handleWheel 没有「向下滚」分支 —— 会留下永久失锁路径")
      .toMatch(/if \(e\.deltaY > 0\) \{/);
    

    expect(PANEL_CODE, "内层可滚守卫的极性反了（写成 !hasInnerScroller）")
      .toMatch(/if \(hasInnerScroller\(ancestors\)\) \{ return; \}/);
    expect(PANEL_CODE, "内层可滚守卫的极性反了").not.toMatch(/!\s*hasInnerScroller\(/);
    

    expect(PANEL_CODE, "handleWheel 没从 DOM 读 overflowY（写死会让外层上滚彻底失效）")
      .toMatch(/overflowY: getComputedStyle\(n\)\.overflowY/);
  });

  it("⑥ 解锁/回锁必须**同步**写 ref（只 setState 会晚一整轮渲染，那一帧仍在拉底）", () => {
    expect(PANEL_CODE, "handleWheel 没同步写 atBottomRef —— 本帧的贴底循环看不到解锁，照旧拉底")
      .toMatch(/atBottomRef\.current = false;\s*\n\s*setAtBottom\(false\);/);
    




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
    

    expect(PANEL_CODE, "ChatPanel 里又拿「上一帧 scrollTop」做方向判据了（重排会误判成用户上翻）")
      .not.toMatch(/lastScrollTop|prevTop/);
    expect(PANEL_CODE, "ChatPanel 没接上唯一出处")
      .toMatch(/import \{ FOLLOW_RESUME_PX, decideFollow, hasInnerScroller, type ScrollBox \} from "\.\.\/scrollFollow\.js";/);
    
    expect(PANEL_CODE, "decideFollow 调用没传 following —— 滞回失效，抖动会复发")
      .toMatch(/decideFollow\(\{\s*\n\s*top,\s*\n\s*scrollHeight: el\.scrollHeight,\s*\n\s*clientHeight: el\.clientHeight,\s*\n\s*following: atBottomRef\.current,/);
  });
});















describe("A-1112 回底胶囊：脱离文档流 + 不吃消息区的点击", () => {
  const CAPSULE_AT = PANEL_CODE.indexOf("{!atBottom && (");
  const SEG = CAPSULE_AT >= 0 ? PANEL_CODE.slice(CAPSULE_AT, CAPSULE_AT + 2000) : "";

  it("① 条件 + **紧跟的** `position: absolute`（回到流内 = 「非最新→最新」再抖一次）", () => {
    

    expect(PANEL_CODE, "回底胶囊不在 `!atBottom` 条件里、或不再是绝对定位（回到流内 ⇒ 抖动复发）")
      .toMatch(/\{!atBottom && \(\s*<div style=\{\{\s*\n\s*position:\s*"absolute"/);
    expect(CAPSULE_AT, "找不到回底胶囊那一块（结构被改了）").toBeGreaterThan(-1);
    expect(SEG, "找不到胶囊按钮（jumpToLatest 没接上？）").toMatch(/<button onClick=\{jumpToLatest\}/);
    

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
    

    expect(CAPSULE_AT, "胶囊排到了遮罩之前（回到了滚动内容里）—— 它又会参与文档流")
      .toBeGreaterThan(lastMask);
    
    expect(PANEL_CODE, "消息区 wrapper 不再是 position: relative（绝对定位的基准没了）")
      .toMatch(/\{\s*flex:\s*1,\s*minHeight:\s*0,\s*position:\s*"relative"\s*\}\}>/);
  });
});
