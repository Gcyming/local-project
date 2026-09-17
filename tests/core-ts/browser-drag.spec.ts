/**
 * tests/core-ts/browser-drag.spec.ts — A-978：browser_drag 拖拽轨迹纯函数回归。
 *
 * 锁死的语义（对齐业界 Playwright dragTo steps / page.mouse 序列 + 滑块验证码自动化共识）：
 *  1. 轨迹 = 按下后多步插值移动 + 精确终点（末点必须严格等于终点，抖动不引入终点偏移）；
 *  2. ease-out 缓动：开头移动快、接近终点减速（人手轨迹），位移单调向终点推进；
 *  3. jitter 可关（测试/确定性场景），注入 rnd 可复现轨迹；
 *  4. steps 钳制 2..80，非法值回退 20。
 */
import { describe, it, expect } from "vitest";
import { buildDragPath } from "../../gui/src/renderer/pages/browserBridge.js";

describe("buildDragPath（browser_drag 拖拽轨迹）", () => {
  it("末点严格等于终点（抖动不引入终点偏移）", () => {
    const path = buildDragPath({ x: 100, y: 200 }, { x: 300, y: 200 }, 20, true);
    const last = path[path.length - 1];
    expect(last.x).toBe(300);
    expect(last.y).toBe(200);
  });

  it("steps 默认 20 + 终点 = 21 个点，首点已离开起点（按下后即移动）", () => {
    const path = buildDragPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 20, false);
    expect(path.length).toBe(21);
    expect(path[0].x).toBeGreaterThan(0); // t=1/20，ease-out 已前进 9.75px → round 10
    expect(path[0].x).toBe(10);
  });

  it("ease-out 缓动：前半段位移大于线性（开头快、结尾慢）", () => {
    const path = buildDragPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 20, false);
    // 线性第 10 步 = 50；ease-out 第 10 步 = 100*(1-(1-0.5)^2) = 75
    expect(path[9].x).toBeGreaterThan(50);
    expect(path[9].x).toBe(75);
  });

  it("位移单调向终点推进（不回头），且全程有中间步（非一步到位）", () => {
    const path = buildDragPath({ x: 0, y: 0 }, { x: 80, y: 40 }, 20, false);
    for (let i = 1; i < path.length; i++) {
      expect(path[i].x).toBeGreaterThanOrEqual(path[i - 1].x);
      expect(path[i].y).toBeGreaterThanOrEqual(path[i - 1].y);
    }
    expect(path.length).toBeGreaterThan(3);
  });

  it("jitter=true 时注入固定 rnd 序列可复现轨迹（确定性测试）", () => {
    const rnd = () => 0.5; // 抖动恒为 0.5*4-2 = 0
    const a = buildDragPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 20, true, rnd);
    const b = buildDragPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 20, true, rnd);
    expect(a).toEqual(b);
  });

  it("steps 钳制：<2 → 2，>80 → 80，非法值（NaN/非数）→ 20", () => {
    expect(buildDragPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 1, false).length).toBe(3);   // 2 步 + 终点
    expect(buildDragPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 500, false).length).toBe(81); // 80 步 + 终点
    expect(buildDragPath({ x: 0, y: 0 }, { x: 10, y: 0 }, NaN, false).length).toBe(21); // 20 步 + 终点
  });

  it("横向大距离 + 纵向小偏移的滑块场景：x 方向为主、y 只在 ±2px 抖动内", () => {
    const path = buildDragPath({ x: 120, y: 300 }, { x: 460, y: 300 }, 20, true, () => 0.5);
    expect(path[path.length - 1].x).toBe(460);
    for (const p of path) {
      expect(Math.abs(p.y - 300)).toBeLessThanOrEqual(2); // 抖动 ≤ ±2px
    }
  });
});
