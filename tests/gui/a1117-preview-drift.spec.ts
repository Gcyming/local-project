





















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { DEFAULT_TICKS_PARAMS, tickPositions } from "../../gui/src/renderer/pages/railParams.js";

const HTML = readFileSync(join(PROJECT_ROOT, "docs/A-1117-md-scroll-bulge.html"), "utf8");
const RAIL = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/pages/TopicRail.tsx"), "utf8");


function stripJsComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const SCRIPT = stripJsComments(
  ([...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n"))
);


function previewNum(name: string): number {
  const m = new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`).exec(SCRIPT);
  expect(m, `预览页里找不到常量 ${name}（或已改名）`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

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
    
    expect(railConst("LEFT_ROOM")).toBe(12);
    expect(SCRIPT, "预览页 OX 必须取自 LEFT_ROOM（不许写死 12）").toContain("var OX = LEFT_ROOM;");
    expect(previewNum("LEFT_ROOM")).toBe(railConst("LEFT_ROOM"));
    expect(previewNum("RIGHT_ROOM")).toBe(railConst("RIGHT_ROOM"));
    
    expect(previewNum("SCROLL_W")).toBe(0.62);
    expect(RAIL, "真身的滚动态权重不再是 0.62 ⇒ 预览页必须同步").toContain("0.62 * profBump(");
    
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
    
    expect(RAIL, "真身 spanTaper 仍然是直接用 R.TAP").toContain("e / R.TAP");
    


    const railBody = /function spanTaper\([\s\S]*?\n    \}/.exec(RAIL);
    expect(railBody, "真身里找不到 spanTaper").not.toBeNull();
    const railFn = (railBody as RegExpExecArray)[0];
    expect(railFn.length, "取到的「函数体」长过头 = 正则漂出了函数（窗口失效）").toBeLessThan(600);
    expect(railFn, "真身 spanTaper 里不该出现 0.4H").not.toMatch(/\*\s*0\.4/);
  });

  it("B. 0.4H 钳位必须**在布局步钳一次**（真身 :203 / 预览 retarget）", () => {
    




    expect(RAIL, "真身的 0.4H 钳位在布局步（钳一次、之后直接用 R.TAP）")
      .toContain("R.TAP = Math.max(0, Math.min(p.tap, R.H * 0.4));");
    expect(SCRIPT, "预览页必须在 retarget 里钳一次 0.4H（照真身布局步，不许在 spanTaper 里现算）")
      .toContain("tapNow = Math.max(0, Math.min(TAP, cfg.H * 0.4));");
  });

  it("C. 刻度铺排式与 tickPositions 同形（分母必须是 n-1）", () => {
    expect(SCRIPT, "预览页刻度铺排式必须除以 (n-1) 才能首末贴住 top/bot")
      .toContain("cfg.top + ((cfg.bot - cfg.top) * k) / (cfg.n - 1)");
    
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
