
























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { DEFAULT_WAVE_PARAMS, tickPositions } from "../../gui/src/renderer/pages/railParams.js";

const HTML = readFileSync(join(PROJECT_ROOT, "docs/A-1115-topic-rail-preview.html"), "utf8");


function stripJsComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}


const RAIL = stripJsComments(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/pages/TopicRail.tsx"), "utf8"));

const SCRIPT = stripJsComments(
  [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n")
);


function pObj(): string {
  const m = /var P = \{([\s\S]*?)\};/.exec(SCRIPT);
  expect(m, "预览页找不到 `var P = {...}` —— 结构变了，本守卫需同步").not.toBeNull();
  return (m as RegExpExecArray)[1];
}

function pNum(key: string): number {
  const m = new RegExp(`(?:^|[^A-Za-z0-9_])${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(pObj());
  expect(m, `预览页 P 里找不到 ${key}（或已改名）`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

function pBool(key: string): boolean {
  const m = new RegExp(`(?:^|[^A-Za-z0-9_])${key}\\s*:\\s*(true|false)`).exec(pObj());
  expect(m, `预览页 P 里找不到布尔 ${key}`).not.toBeNull();
  return (m as RegExpExecArray)[1] === "true";
}

function previewNum(name: string): number {
  const m = new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`).exec(SCRIPT);
  expect(m, `预览页里找不到常量 ${name}（或已改名）`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

function railNum(name: string): number {
  const m = new RegExp(
    `(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?:[;,)])`
  ).exec(RAIL);
  expect(m, `真身里找不到 const ${name}`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}



function fnBody(src: string, header: string): string {
  const i = src.indexOf(header);
  expect(i, `找不到函数：${header}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(i + header.length);
  const end = rest.indexOf("\n    }");
  expect(end, `函数体没闭合：${header}`).toBeGreaterThan(0);
  const body = rest.slice(0, end);
  expect(body.length, `取到的「函数体」长过头 = 正则漂出了函数（窗口失效）：${header}`).toBeLessThan(600);
  return body;
}

function sliderPairs(): Array<[string, string]> {
  return [...SCRIPT.matchAll(/bind\("(s[A-Za-z0-9]+)",\s*"([A-Za-z0-9]+)"/g)]
    .map((m) => [m[2], m[1]] as [string, string]);
}

function checkPairs(): Array<[string, string]> {
  return [...SCRIPT.matchAll(/bindChk\("(c[A-Za-z0-9]+)",\s*"([A-Za-z0-9]+)"/g)]
    .map((m) => [m[2], m[1]] as [string, string]);
}

function inputTag(id: string): string {
  const m = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(HTML);
  expect(m, `预览页找不到控件 ${id} —— 结构变了，本守卫需同步`).not.toBeNull();
  return (m as RegExpExecArray)[0];
}

describe("A-1115 预览页 drift — 默认参数（手抄第二产地）", () => {
  const P = DEFAULT_WAVE_PARAMS;
  const NUM: Array<[string, number]> = [
    ["lam0", P.lam0], ["lam1", P.lam1], ["amp", P.amp], ["k", P.k], ["a", P.a],
    ["bulge", P.bulge], ["dip", P.dip], ["grow", P.grow], ["sig", P.sig],
    ["tap", P.tap], ["efloor", P.efloor], ["spd", P.spd], ["damp", P.damp], ["w", P.w],
  ];

  it.each(NUM)("预览页 P.%s 与 DEFAULT_WAVE_PARAMS 同值", (key, real) => {
    expect(pNum(key), `预览页 P.${key} 与真身默认值不一致（改真身要同步改预览）`).toBe(real);
  });

  it("预览页 P 的三个布尔与真身同值", () => {
    expect(pBool("pause")).toBe(P.pause);
    expect(pBool("read")).toBe(P.read);
    expect(pBool("flip")).toBe(P.flip);
  });

  

  it.each(sliderPairs())("滑杆 %s 的 value 与真身默认值同值（它才是生效值）", (key, id) => {
    const m = /value="([^"]+)"/.exec(inputTag(id));
    expect(m, `滑杆 ${id} 没有 value`).not.toBeNull();
    expect(Number((m as RegExpExecArray)[1]),
      `滑杆 ${id}（→ P.${key}）上的数字与真身默认值不一致 —— 用户是按这个数字调参的`).toBe(
      (DEFAULT_WAVE_PARAMS as unknown as Record<string, number>)[key]);
  });

  it.each(checkPairs())("勾选框 %s 的 checked 与真身默认值同值", (key, id) => {
    const want = (DEFAULT_WAVE_PARAMS as unknown as Record<string, boolean>)[key];
    expect(/\bchecked\b/.test(inputTag(id)), `勾选框 ${id}（→ P.${key}）的初始态与真身不一致`).toBe(want);
  });

  it("预览页的控件必须**恰好覆盖** railParams 的全部参数（多一个/少一个都出声）", () => {
    





    const keysByType = (type: "number" | "boolean"): string[] => {
      const src = DEFAULT_WAVE_PARAMS as unknown as Record<string, unknown>;
      return Object.keys(src).filter((k) => typeof src[k] === type).sort();
    };
    expect(sliderPairs().map(([k]) => k).sort(), "滑杆集合 ≠ railParams 的数值参数集合")
      .toEqual(keysByType("number"));
    expect(checkPairs().map(([k]) => k).sort(), "勾选框集合 ≠ railParams 的布尔参数集合")
      .toEqual(keysByType("boolean"));
  });
});

describe("A-1115 预览页 drift — 余量三件套（本轮真实漂移：RIGHT_ROOM 5 vs 6）", () => {
  it("LEFT_ROOM / RIGHT_ROOM 与真身逐条同值", () => {
    const left = railNum("LEFT_ROOM"), right = railNum("RIGHT_ROOM");
    expect(left).toBe(12);
    expect(previewNum("LEFT_ROOM"), "预览页左余量与真身不一致").toBe(left);
    

    expect(previewNum("RIGHT_ROOM"), "预览页右余量与真身不一致（差 1px 就会让「凹陷撞墙」的判据失真）")
      .toBe(right);
  });

  it("预览页 `.rail { right }` 必须等于真身的 RAIL_INSET（卷轴离宿主右缘的距离）", () => {
    const inset = railNum("RAIL_INSET");
    expect(inset).toBeGreaterThan(0);
    const m = /\.rail\{[^}]*?right:\s*(\d+)px/.exec(HTML);
    expect(m, "预览页找不到 `.rail { right }` —— 结构变了，本守卫需同步").not.toBeNull();
    expect(Number((m as RegExpExecArray)[1]), "预览页卷轴的右偏移与真身 RAIL_INSET 不一致").toBe(inset);
    expect(RAIL, "真身不再把 RAIL_INSET 写到宿主的 right 上 ⇒ 结构变了").toContain('host.style.right = RAIL_INSET + "px";');
  });

  it("画布总宽的唯一式子 `OX + W + RIGHT_ROOM` 两侧同形", () => {
    expect(SCRIPT).toContain("R.OX = LEFT_ROOM;");
    expect(SCRIPT).toContain("R.CW = R.OX + R.W + RIGHT_ROOM;");
    expect(RAIL).toContain("R.OX = LEFT_ROOM;");
    expect(RAIL).toContain("R.CW = R.OX + R.W + RIGHT_ROOM;");
  });
});

describe("A-1115 预览页 drift — 布局步与几何（值恰好相等也逃不掉的那几条）", () => {
  it("TAP 的 0.4H 钳位必须在**布局步钳一次**（预览页与真身同结构）", () => {
    


    const tap = /R\.TAP = Math\.max\(0, Math\.min\([Pp]\.tap, R\.H \* 0\.4\)\);/;
    expect(RAIL, "真身的 TAP 钳位不在布局步了").toMatch(tap);
    expect(SCRIPT, "预览页的 TAP 钳位不在布局步了").toMatch(tap);
  });

  it("spanTaper 里**不许**现算 0.4H（真实漂移过：注释「钳 0.4H」被写成了代码）", () => {
    for (const [who, src, header] of [
      ["真身", RAIL, "function spanTaper(y: number, top: number, bot: number, floor?: number): number {"],
      ["预览页", SCRIPT, "function spanTaper(y, top, bot, floor) {"],
    ] as const) {
      const fn = fnBody(src, header);
      expect(fn, `${who} spanTaper 必须直接除以 R.TAP（与布局步同口径）`).toContain("e / R.TAP");
      expect(fn, `${who} spanTaper 里出现了 0.4H 现算 —— 值恰好相等、谁都看不出来`).not.toMatch(/\*\s*0\.4/);
    }
  });

  it("波形带占比 0.76 / 0.88 与左右界（OX+1.2、maxAmp 下限 0.6）两侧同值", () => {
    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 波形带右界的占比变了（md 0.76 / 对话页 0.88 是"刻度位"与"波形"的分界）`)
        .toContain("0.76 : 0.88");
      expect(src, `${who} 波形带左界不再是 OX+1.2`).toContain("R.OX + 1.2");
      expect(src, `${who} maxAmp 的下限不再是 0.6`).toContain("Math.max(0.6, (r - l) / 2)");
    }
  });

  it("位移的夹紧：左 1.4px / 右 R.CW−2.0px（右边「撞墙」就是这条判据）", () => {
    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 左侧夹紧边距变了`).toContain("1.4 - B.cx");
      expect(src, `${who} 右侧夹紧上界变了（凹陷会撞墙或提前停）`).toContain("R.CW - 2.0 - B.cx");
    }
  });

  it("刻度跨度 = 中间 2/3（TOP = H/6、BOT = 5H/6）两侧同值", () => {
    expect(SCRIPT).toContain("R.TOP = R.H / 6;");
    expect(SCRIPT).toContain("R.H * 5");
    expect(RAIL).toContain("R.TOP = R.H / 6;");
    expect(RAIL).toContain("R.H * 5");
  });

  it("双极位移：T = 2.7，且中间项 `Bp·e^(−T/2)` **必须显式减掉**", () => {
    expect(SCRIPT, "预览页的 T 不再是 2.7").toMatch(/\bT = 2\.7;/);
    expect(RAIL, "真身的 T 不再是 2.7").toMatch(/\bT = 2\.7;/);
    

    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 的双极位移没减掉中间项（会把凹陷吃掉一大半）`)
        .toContain("Bp * bump - (Dp + Bp * Math.exp(-T / 2)) * dipTerm");
    }
  });

  it("衬托的过渡带不能窄（窄了凹陷尾巴与刚恢复的振荡叠在一起 = 「锐角」）两侧同值", () => {
    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 的过渡带收口变了（窄了出「锐角」，宽了影响范围过大）`)
        .toContain("Math.max(1.4, a * 0.7)");
    }
  });

  it("端部渐变（lineStyle）的已读/未读过渡带 0.07H、下限 14px 两侧同值", () => {
    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 的已读/未读过渡带变了（硬切换会留可见色块边）`).toContain("Math.max(14, Hb * 0.07)");
    }
  });
});

describe("A-1115 预览页 drift — 波形描边（两线必须分得开）", () => {
  it("线宽 0.13W / 0.095W、发光倍率 1.5 / 2.0 两侧同值", () => {
    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 的描边宽度变了（调胖 = 两线糊成一条 ⇒ "明暗区分越来越小"）`)
        .toContain("W * 0.095 : W * 0.13");
      expect(src, `${who} 的发光倍率变了`).toContain("(i ? 2.0 : 1.5)");
    }
  });

  it("两条线的颜色与四个 alpha 档位两侧同值（抬错那一条会把两档并成一档）", () => {
    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 的亮线/暗线颜色变了`).toContain("191,219,254");
      expect(src, `${who} 的亮线/暗线颜色变了`).toContain("59,130,246");
      expect(src, `${who} 的 alpha 档位变了`)
        .toContain("0.52 : 0.97, aDim = i ? 0.34 : 0.62, aGlow = i ? 0.13 : 0.10");
    }
  });
});

describe("A-1115 预览页 drift — 刻度（md 只留刻度尺）", () => {
  it("突起的影响范围 tA/tB（1.5σ / 3.2σ）两侧同值 —— 它比波形窄是**故意**的", () => {
    expect(RAIL).toContain("tA = 1.5, tB = 3.2");
    expect(SCRIPT).toContain("tA = 1.5, tB = 3.2");
  });

  it("刻度的端部 floor 抬到 0.35（沿用波形 0.12 会把首尾两条抹掉 = 读成「少了两条」）", () => {
    expect(RAIL).toContain("spanTaper(tk.u, R.TOP, R.BOT, 0.35)");
    expect(SCRIPT).toContain("spanTaper(tk.u, R.TOP, R.BOT, 0.35)");
  });

  it("刻度基础长度 h1/h2/h3 = 0.90 / 0.68 / 0.48 W，突起幅度 = grow% × W 两侧同值", () => {
    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 的层级 → 刻度长度映射变了`)
        .toContain('tk.lvl === "h1" ? 0.90 : (tk.lvl === "h2" ? 0.68 : 0.48)');
      expect(src, `${who} 的刻度最短长度下限变了`).toContain("Math.max(2.5, W * frac - 1.6)");
    }
  });

  it("刻度的线宽 / 颜色插值 / alpha 两侧同值（换条那一下不闪）", () => {
    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 的刻度线宽变了`).toContain("Math.max(1.4, W * 0.14) + Math.max(0, W * 0.10) * qw");
      expect(src, `${who} 的刻度颜色插值变了`).toContain("139 + 52 * qw");
      expect(src, `${who} 的刻度颜色插值变了`).toContain("151 + 68 * qw");
      expect(src, `${who} 的刻度颜色插值变了`).toContain("168 + 86 * qw");
      expect(src, `${who} 的刻度 alpha 插值变了`).toContain("0.62 + 0.36 * qw");
      expect(src, `${who} 的刻度右端锚点变了`).toContain("R.OX + W - 1.0");
    }
  });

  it("刻度铺排与 `tickPositions` 同形（等距、分母 n-1 ⇒ 首末贴住跨度两端）", () => {
    expect(SCRIPT, "预览页的刻度比例不再是 i/(n-1)（末条够不到底 ⇒「分布不均匀」回归）")
      .toContain("n > 1 ? i / (n - 1) : 0.5");
    expect(SCRIPT).toContain("u: R.TOP + f * (R.BOT - R.TOP)");
    
    const n = 7, top = 0, bot = 600;
    const pos = tickPositions(n, top, bot);
    expect(pos[0]).toBe(top);
    expect(pos[n - 1]).toBe(bot);
    const gaps = pos.slice(1).map((v, i) => v - pos[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-9);
  });
});

describe("A-1115 预览页 drift — 帧推进与交互（手感常量）", () => {
  it("阻尼 / 吸附 / 涟漪相位两侧同值", () => {
    for (const [who, src] of [["真身", RAIL], ["预览页", SCRIPT]] as const) {
      expect(src, `${who} 的指针跟手强度变了`).toContain("1 - Math.pow(1 - 0.18, dt / 16.7)");
      expect(src, `${who} 的 strength 吸附上界变了`).toContain("R.ptr.strength > 0.998");
      expect(src, `${who} 的 strength 吸附下界变了`).toContain("R.ptr.strength < 0.002");
      expect(src, `${who} 的位置吸附阈值变了`).toContain("R.ptr.target - R.ptr.uc) < 0.25");
      expect(src, `${who} 的阻尼时间基准变了`).toContain(", dt / 16.7)");
      expect(src, `${who} 的滚动耦合相位变了`).toContain("s * 0.0105");
      expect(src, `${who} 的荡漾周期变了`).toContain("5.2)");
      

      expect(src, `${who} 的点击位移阈值变了（阈值内算「点一下 = 跳转」）`).toMatch(/upU - (?:R\.)?dragU\) > 3/);
      expect(src, `${who} 的气泡半高变了`).toContain("half = 16;");
    }
  });
});
