/**
 * A-1044 守卫（core-ts 侧）：**用户与 Agent 的输入仲裁**（人优先）+ 操作区域几何 + 桌面空闲探针。
 *
 * **用户原话**：「当 agent 操作我这里或者操作 slime 内的一些地方的时候，我点击 slime 内的一些地方时，
 *   操作点击的地方会失效，要重新点击，你是不是设置的时候没设好，Agent 的操作与用户操作未作隔离？」
 *
 * 根因不是"没设好开关"：宿主桌面后端用 `SetCursorPos` + `mouse_event` + `SetForegroundWindow` 注入，
 * 用的是**全局唯一物理指针**与**前台窗口**；右栏浏览器则用 `wv.focus()` 抢应用内焦点。共享资源竞争
 * 没有"隔离"这个解 —— 正确的解是**人优先**：检测到用户在操作就让位等待，等不到就中止并如实汇报。
 *
 * 本守卫锁三件事：
 *   ① `decideUserYield` 的三条语义（等待 / 中止 / **探测不可用时放行但留痕**）；
 *   ② `operationRegionBox` 的四档几何（窗口矩形 → 动作点框 → 兜底 → 不猜）；
 *   ③ 位置驱动扫源码：让位门只装在"会注入输入"的动作上；`begin` 必在 `perform` **之前**、
 *      `end` 必在 `finally`；空闲探针是**内部**动作（模型调不到）、失败必须返回 null。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideUserYield,
  operationRegionBox,
  USER_ACTIVE_WINDOW_MS,
  USER_YIELD_MAX_WAIT_MS,
  USER_YIELD_PROBE_MS,
  OPERATION_BOX_W,
  OPERATION_BOX_H,
} from "../../core-ts/src/screen/arbiter.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再扫 —— 本仓注释里大量引用了"被禁止的写法"，不剥会把断言喂饱。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const CONTROLLER = "core-ts/src/screen/controller.ts";
const DESKTOP = "core-ts/src/screen/backends/desktop.ts";
const TYPES = "core-ts/src/screen/types.ts";

const base = { idleMs: 0, waitedMs: 0, activeWindowMs: USER_ACTIVE_WINDOW_MS, maxWaitMs: USER_YIELD_MAX_WAIT_MS };

describe("A-1044 ①：让位裁决 —— 人优先（纯逻辑）", () => {
  it("用户已停手够久 → 直接执行，且不留噪点文案", () => {
    const d = decideUserYield({ ...base, idleMs: USER_ACTIVE_WINDOW_MS });
    expect(d.action).toBe("proceed");
    if (d.action === "proceed") { expect(d.note).toBe(""); }
  });

  it("用户正在操作（空闲 < 窗口）→ 等待，且等待粒度不超过探测间隔（可随时再判）", () => {
    const d = decideUserYield({ ...base, idleMs: 100 });
    expect(d.action).toBe("wait");
    if (d.action === "wait") {
      expect(d.waitMs).toBeGreaterThanOrEqual(1);
      expect(d.waitMs).toBeLessThanOrEqual(USER_YIELD_PROBE_MS);
    }
  });

  it("等够了还没停手 → **中止**，并说清「本次未执行」（绝不硬点上去抢指针）", () => {
    // 还差 600ms 才到窗口，但只允许再等 100ms
    const d = decideUserYield({ ...base, idleMs: USER_ACTIVE_WINDOW_MS - 600, waitedMs: USER_YIELD_MAX_WAIT_MS - 100 });
    expect(d.action).toBe("abort");
    if (d.action === "abort") {
      expect(d.reason).toContain("未执行");
      expect(d.reason).toContain("让位");
    }
  });

  it("恰好还能等到 → 不中止（边界：need == 剩余额度）", () => {
    const d = decideUserYield({ ...base, idleMs: USER_ACTIVE_WINDOW_MS - 200, waitedMs: USER_YIELD_MAX_WAIT_MS - 200 });
    expect(d.action).toBe("wait");
  });

  it("探测不可用（null / 非有限数）→ 放行，但**必须留痕**（失败 ≠ 用户忙，也不许静默当空闲）", () => {
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = decideUserYield({ ...base, idleMs: bad as number | null });
      expect(d.action, `idleMs=${String(bad)}`).toBe("proceed");
      if (d.action === "proceed") {
        expect(d.note.length).toBeGreaterThan(0);
        expect(d.note).toContain("未");
      }
    }
  });

  it("负的空闲值被钳到 0（系统时钟回绕也不许算出负等待）", () => {
    const d = decideUserYield({ ...base, idleMs: -5000 });
    expect(d.action).toBe("wait");
    if (d.action === "wait") { expect(d.waitMs).toBeGreaterThanOrEqual(1); }
  });

  it("探测间隔有下界（probeMs 传 0 也不会变成忙等）", () => {
    const d = decideUserYield({ ...base, idleMs: 0, probeMs: 0 });
    expect(d.action).toBe("wait");
    if (d.action === "wait") { expect(d.waitMs).toBeGreaterThanOrEqual(1); }
  });

  it("常量关系自洽：窗口 < 让位上限，探测间隔 ≤ 窗口（否则「等一轮」就跨过了判定窗口）", () => {
    expect(USER_ACTIVE_WINDOW_MS).toBeGreaterThan(0);
    expect(USER_YIELD_MAX_WAIT_MS).toBeGreaterThan(USER_ACTIVE_WINDOW_MS);
    expect(USER_YIELD_PROBE_MS).toBeLessThanOrEqual(USER_ACTIVE_WINDOW_MS);
  });
});

describe("A-1044 ②：操作区域几何（呼吸灯画在哪）", () => {
  it("有窗口矩形时用窗口矩形（窗口本身就是被操作对象，最准确）", () => {
    const r = operationRegionBox({ targetRegion: { x: 10, y: 20, width: 800, height: 600 }, point: { x: 1, y: 1 } });
    expect(r).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  });

  it("裸坐标点击 → 以动作点为中心的固定框（点在哪框在哪）", () => {
    const r = operationRegionBox({ point: { x: 500, y: 400 } });
    expect(r).toEqual({ x: 500 - OPERATION_BOX_W / 2, y: 400 - OPERATION_BOX_H / 2, width: OPERATION_BOX_W, height: OPERATION_BOX_H });
  });

  it("键盘类动作没有坐标 → 用最近一次视野兜底", () => {
    const r = operationRegionBox({ fallback: { x: 0, y: 0, width: 1920, height: 1080 } });
    expect(r).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("三者都无 → **null**（不猜：界面不画框，而不是画一个假位置）", () => {
    expect(operationRegionBox({})).toBeNull();
    expect(operationRegionBox({ point: { x: Number.NaN, y: 10 } })).toBeNull();
    expect(operationRegionBox({ targetRegion: { x: 0, y: 0, width: 0, height: 0 }, fallback: null })).toBeNull();
  });

  it("退化的窗口矩形（尺寸 0 / 非有限）不算数，继续往下一档走", () => {
    const r = operationRegionBox({ targetRegion: { x: 0, y: 0, width: 0, height: 600 }, point: { x: 100, y: 100 } });
    expect(r).toEqual({ x: 100 - OPERATION_BOX_W / 2, y: 100 - OPERATION_BOX_H / 2, width: OPERATION_BOX_W, height: OPERATION_BOX_H });
  });
});

describe("A-1044 ③：源码位置约束（让位门 / 事件时序 / 探针边界）", () => {
  const ctl = (): string => stripComments(read(CONTROLLER));
  /** `performInner` 的函数体（位置驱动：范围限定在这一处，别处的同名文本不算数）。 */
  const inner = (): string => {
    const src = ctl();
    const at = src.indexOf("private async performInner(");
    expect(at, "找不到 performInner").toBeGreaterThan(-1);
    return src.slice(at);
  };

  it("让位门只装在**会注入输入**的动作上：截图/枚举/wait 不 Waiting（不该把自己整个停掉）", () => {
    const src = ctl();
    const m = /USER_CONFLICT_ACTIONS[^=]*=\s*new Set<ScreenActionKind>\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m, "找不到 USER_CONFLICT_ACTIONS 集合").not.toBeNull();
    const kinds = [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    for (const k of ["click", "double_click", "right_click", "mouse_move", "drag", "scroll", "type", "key", "tap", "swipe"]) {
      expect(kinds, `输入类动作 ${k} 必须让位`).toContain(k);
    }
    for (const k of ["capture", "ui_dump", "wait", "back"]) {
      expect(kinds, `${k} 不碰用户指针/焦点，不该让位`).not.toContain(k);
    }
  });

  it("`begin` 事件必须在 `perform` **之前**发出（用户先看见「Agent 要动了」）", () => {
    const body = inner();
    const begin = body.indexOf('phase: "begin"');
    const perform = body.indexOf("await backend.perform(");
    expect(begin, "performInner 里没有 begin 事件").toBeGreaterThan(-1);
    expect(perform).toBeGreaterThan(-1);
    expect(begin, "begin 晚于 perform = 用户永远来不及把手挪开").toBeLessThan(perform);
  });

  it("`end` 事件必须在 finally 里（异常/中止也不能把边框留在屏幕上）", () => {
    const body = inner();
    const begin = body.indexOf('phase: "begin"');
    const fin = body.indexOf("} finally {");
    expect(fin, "找不到配对的 finally").toBeGreaterThan(-1);
    expect(body.slice(fin, fin + 400)).toContain('phase: "end"');
    expect(begin).toBeGreaterThan(-1);
  });

  it("可视化回调异常绝不允许影响动作（fire-and-forget）", () => {
    const src = ctl();
    const m = /private emitFocus\([\s\S]{0,300}?\n  \}/.exec(src);
    expect(m, "找不到 emitFocus").not.toBeNull();
    expect(m![0]).toMatch(/try\s*\{/);
    expect(m![0]).toMatch(/catch\s*\{/);
  });

  it("空闲探针是**内部动作**：不进 DESKTOP_ACTIONS（模型不该能直接调 user_idle）", () => {
    const src = stripComments(read(DESKTOP));
    const m = /DESKTOP_ACTIONS[^=]*=\s*new Set<ScreenActionKind>\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m, "找不到 DESKTOP_ACTIONS").not.toBeNull();
    expect(m![1], "user_idle 是内部探针，不该写进后端能力集合").not.toContain("user_idle");
    expect(src, "必须有 user_idle 分支的实现").toContain("'user_idle'");
  });

  it("Win32 探针用 GetLastInputInfo（系统级最后输入时刻，无需 hook/管理员权限）", () => {
    const src = stripComments(read(DESKTOP));
    expect(src).toContain("GetLastInputInfo");
    expect(src).toContain("LASTINPUTINFO");
    expect(src, "从未收到过输入（无人登录/会话隔离）必须算不可用").toMatch(/IDLE_UNAVAILABLE/);
  });

  it("探针失败一律返回 null（null ≠「用户空闲」，仲裁层据此留痕放行）", () => {
    const src = stripComments(read(DESKTOP));
    const m = /async userIdleMs\(\)[\s\S]{0,700}?\n  \}/.exec(src);
    expect(m, "找不到 DesktopScreenBackend.userIdleMs").not.toBeNull();
    const body = m![0];
    expect(body).toContain("null");
    // ⚠️ 只断言"含 catch"太弱：`catch (e) { throw e; }` 同样含 catch —— 而它恰恰是**改坏后的样子**。
    // 必须锁住 catch 块的**块体**：返回 null，且不抛。
    const c = /catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/.exec(body);
    expect(c, "探针必须有 catch 兜底（宿主未就绪/超时）").not.toBeNull();
    expect(c![1], "catch 里必须 return null —— 探测不可用的语义是「放行但留痕」").toMatch(/return\s+null\s*;/);
    expect(c![1], "catch 里不许 throw —— 一次探测失败不该把整条图形操作打断").not.toMatch(/\bthrow\b/);
    expect(body, "整个探针主体都不允许出现 throw").not.toMatch(/\bthrow\b/);
  });

  it("`ScreenBackend.userIdleMs` 是可选能力（安卓后端不实现 = 真正隔离的那条路）", () => {
    expect(stripComments(read(TYPES))).toMatch(/userIdleMs\?\(\):\s*Promise<number \| null>/);
  });
});
