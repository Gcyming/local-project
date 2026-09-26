/**
 * tests/gui/a1117-preview-drift.spec.ts — 「设计预览页 ↔ 真身」常量对齐守卫（A-1117）。
 *
 * 为什么需要它：`docs/A-1117-md-scroll-bulge.html` 是给用户做设计确认用的**手抄第二产地** ——
 * 它把 TopicRail / railParams 的 13 个设计常量与 3 个几何式抄了一遍。
 * 抄错的后果不是"页面报错"，而是**用错误的口径说服用户、说服自己**
 * （本仓已踩过"预演和真身不一致"，也踩过"检测器自己空转"）。
 *
 * 真实抓到的漂移（不是假想）：
 *   预览页的 `spanTaper` 自己发明了 `Math.min(TAP, (bot - top) * 0.4 * 1.5)`，
 *   而真身 `TopicRail.tsx` 是**直接用 `R.TAP`**、没有这个钳位；
 *   在滑杆范围内（H ≥ 300）两者恰好同值 ⇒ 曲线一模一样、**谁都看不出来**。
 *   预览页里那句注释「p.tap（端部过渡长度，钳 0.4H）」就是错误代码的源头。
 *
 * 判据：
 *   A. 预览页每个常量的**值** == 真身对应值（改真身不改预览 ⇒ 红）；
 *   B. 预览页不许出现真身没有的式子（如 `* 0.4` 钳位）—— 抄写走样 ⇒ 红；
 *   C. 刻度铺排式必须与 `tickPositions`（等距、除以 n-1）同形 ⇒ 抄错分母 ⇒ 红。
 *
 * ⚠️ 注释必须先剥掉再做形状断言：预览页**有意**在注释里引用旧写法做对照，
 *    不剥就会被自己的注释骗过（a1115 里 `codeOf` 就是为这个存在的）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { DEFAULT_TICKS_PARAMS, tickPositions } from "../../gui/src/renderer/pages/railParams.js";

const HTML = readFileSync(join(PROJECT_ROOT, "docs/A-1117-md-scroll-bulge.html"), "utf8");
const RAIL = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/pages/TopicRail.tsx"), "utf8");

/** 剥掉 JS 注释（块注释要整段去掉：预览页在**多行块注释内部**引用了错误写法做对照） */
function stripJsComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}
/** 只取预览页里 `<script>` 的正文（含 `(function(){...})()` 那段），已剥注释 */
const SCRIPT = stripJsComments(
  ([...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n"))
);

/** 取预览页里 `NAME = <数字>` 的字面量（用词边界，避免 `W` 命中 `CW`、`OX` 命中 `RAIL_X`） */
function previewNum(name: string): number {
  const m = new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`).exec(SCRIPT);
  expect(m, `预览页里找不到常量 ${name}（或已改名）`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}
/** 取真身里的 `const <name> = <数字>`（允许**多声明**：`const tA = 1.5, tB = 3.2;` ⇒ 结尾可能是逗号） */
function railConst(name: string): number {
  const m = new RegExp(
    `(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?:[;,)])`
  ).exec(RAIL);
  expect(m, `真身里找不到 const ${name}`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

describe("A-1117 — 预览页与真身的常量对齐（手抄第二产地）", () => {
  it("A. railParams 默认参数：预览页逐条与真身同值", () => {
    const P = DEFAULT_TICKS_PARAMS;
    const pairs: Array<[string, number]> = [
      ["W", P.w],
      ["GROW", P.grow],
      ["SIG", P.sig],
      ["TAP", P.tap],
      ["EFLOOR", P.efloor],
      ["DAMP", P.damp],
    ];
    for (const [name, real] of pairs) {
      expect(previewNum(name), `预览页 ${name} 与 railParams 默认值不一致（改真身要同步改预览）`)
        .toBe(real);
    }
  });

  it("A. TopicRail 局部常量：预览页逐条与真身同值", () => {
    expect(previewNum("T_A")).toBe(railConst("tA"));
    expect(previewNum("T_B")).toBe(railConst("tB"));
    // 预览页的 OX 是**表达式**（不是字面量）⇒ 用同形断言 + 传递对齐
    expect(railConst("LEFT_ROOM")).toBe(12);
    expect(SCRIPT, "预览页 OX 必须取自 LEFT_ROOM（不许写死 12）").toContain("var OX = LEFT_ROOM;");
    expect(previewNum("LEFT_ROOM")).toBe(railConst("LEFT_ROOM"));
    expect(previewNum("RIGHT_ROOM")).toBe(railConst("RIGHT_ROOM"));
    // 滚动态权重 0.62：真身写在 `0.62 * profBump(...)` 里，预览页抄成常量 SCROLL_W
    expect(previewNum("SCROLL_W")).toBe(0.62);
    expect(RAIL, "真身的滚动态权重不再是 0.62 ⇒ 预览页必须同步").toContain("0.62 * profBump(");
    // 刻度端部渐隐 floor 0.35：真身写在 spanTaper 调用实参里
    expect(previewNum("TICK_FLOOR")).toBe(0.35);
    expect(RAIL, "真身的刻度端部 floor 不再是 0.35 ⇒ 预览页必须同步")
      .toContain("spanTaper(tk.u, R.TOP, R.BOT, 0.35)");
  });

  it("A. 滚动态衰减窗口 pA/pB：预览页与真身同值（且真身用它除 spacing）", () => {
    const pA = railConst("pA");
    const pB = railConst("pB");
    expect(pA).toBe(0.25);
    expect(pB).toBe(1.0);
    expect(previewNum("P_A")).toBe(pA);
    expect(previewNum("P_B")).toBe(pB);
  });

  it("A. 鼠标态衰减窗口 tA/tB：真身用 sig 归一，预览页同值", () => {
    expect(railConst("tA")).toBe(1.5);
    expect(railConst("tB")).toBe(3.2);
    expect(SCRIPT, "预览页的 bumpAbs 必须按 SIG 归一（与真身同口径）")
      .toContain("dist / Math.max(1, SIG)");
  });

  it("B. spanTaper 不许抄出真身没有的钳位（真实漂移过：`* 0.4`）", () => {
    const body = /function spanTaper\([\s\S]*?\n    \}/.exec(SCRIPT);
    expect(body, "预览页里找不到 spanTaper").not.toBeNull();
    const fn = (body as RegExpExecArray)[0];
    expect(fn, "预览页 spanTaper 必须直接除以 tapNow（与真身除以 R.TAP 同形）")
      .toContain("e / tapNow");
    expect(fn, "预览页 spanTaper 里出现了 0.4H 现算 —— 真实漂移过：值恰好相等、谁都看不出来")
      .not.toMatch(/\*\s*0\.4/);
    // 真身侧的反向约束：确实没有把钳位写进 spanTaper
    expect(RAIL, "真身 spanTaper 仍然是直接用 R.TAP").toContain("e / R.TAP");
    /* ⚠️ 取函数体必须**框住窗口**：裸写 /function spanTaper[\s\S]*?0\.4/ 会一路走到
       :203 的 `R.H * 0.4` 才命中 ⇒ 恒报违规（我第一版就踩了这个 —— 技能 §8.1 的"窗口本身就是 bug"）。
       先取体、再在体内匹配，并断言体长合理，防止正则再次漂出。 */
    const railBody = /function spanTaper\([\s\S]*?\n    \}/.exec(RAIL);
    expect(railBody, "真身里找不到 spanTaper").not.toBeNull();
    const railFn = (railBody as RegExpExecArray)[0];
    expect(railFn.length, "取到的「函数体」长过头 = 正则漂出了函数（窗口失效）").toBeLessThan(600);
    expect(railFn, "真身 spanTaper 里不该出现 0.4H").not.toMatch(/\*\s*0\.4/);
  });

  it("B. 0.4H 钳位必须**在布局步钳一次**（真身 :203 / 预览 retarget）", () => {
    /* 这一条的漂移是**结构**上的：预览页曾把 `(bot-top)*0.4*1.5` 塞进 spanTaper，
       值恰好等于 `0.4H`（因为 `0.6*(2/3)H == 0.4H`）⇒ 曲线一模一样、行为判据抓不到。
       ⚠️ 因此本断言**不配变异**：滑杆范围内（H≥300、默认 tap=90）钳位不生效，
       任何"删掉钳位"的变异都是**等价变异体**（技能 `mutation-harness §8.11`）。
       它能被证伪的地方是**结构**，所以用同形断言而不是行为断言。 */
    expect(RAIL, "真身的 0.4H 钳位在布局步（钳一次、之后直接用 R.TAP）")
      .toContain("R.TAP = Math.max(0, Math.min(p.tap, R.H * 0.4));");
    expect(SCRIPT, "预览页必须在 retarget 里钳一次 0.4H（照真身布局步，不许在 spanTaper 里现算）")
      .toContain("tapNow = Math.max(0, Math.min(TAP, cfg.H * 0.4));");
  });

  it("C. 刻度铺排式与 tickPositions 同形（分母必须是 n-1）", () => {
    expect(SCRIPT, "预览页刻度铺排式必须除以 (n-1) 才能首末贴住 top/bot")
      .toContain("cfg.top + ((cfg.bot - cfg.top) * k) / (cfg.n - 1)");
    // 行为侧：真身纯函数的确等距、且首末贴边（与上面那句预览页式子同一要求）
    const n = 7, top = 0, bot = 600;
    const pos = tickPositions(n, top, bot);
    expect(pos[0]).toBe(top);
    expect(pos[n - 1]).toBe(bot);
    const gaps = pos.slice(1).map((v, i) => v - pos[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-9);
  });

  it("C. 中间 2/3：预览页的 top/bot 与真身同式", () => {
    expect(SCRIPT).toContain("top: H / 6");
    expect(SCRIPT).toContain("bot: (H * 5) / 6");
    expect(RAIL).toContain("R.TOP = R.H / 6;");
    expect(RAIL).toContain("R.BOT = (R.H * 5) / 6;");
  });

  it("C. 画布总宽 CW 的唯一式子在两侧一致（清屏用错宽度 = 糊成一坨）", () => {
    expect(SCRIPT).toContain("var CW = OX + W + RIGHT_ROOM;");
    expect(RAIL).toContain("R.CW = R.OX + R.W + RIGHT_ROOM;");
  });
});
