/**
 * tests/gui/a1115-preview-drift.spec.ts — 「A-1115 设计预览页 ↔ 真身」常量对齐守卫。
 *
 * 为什么需要它：`docs/A-1115-topic-rail-preview.html` 是给用户做设计确认用的**手抄第二产地** ——
 * 它把 `railParams` 的默认参数 + `TopicRail.tsx` 的三十来条设计常量/几何式子抄了一遍。
 * 抄错的后果**不是页面报错**，而是**用错误的口径说服用户、说服自己**
 * （与 A-1117 那份同宗；本仓已踩过"预演和真身不一致"）。
 * A-1117 那份早有守卫（`tests/gui/a1117-preview-drift.spec.ts`），**这一份一直欠着**（本轮补上）。
 *
 * 真实抓到的漂移（不是假想，本轮实测）：
 *   · 预览页 `RIGHT_ROOM = 5`，真身 `TopicRail.RIGHT_ROOM = 6`
 *     —— 画布右侧余量差 1px ⇒ 凹陷的夹紧上界 `R.CW - 2.0 - B.cx` 就差了 1px，
 *        两边"看起来都对"、曲线也像，**谁都发现不了**（用户不会去量这个）。
 *   · 同页说明文字写着「凹陷 78% ⇒ 停在卷轴右缘内约 2.5px」，而真身 `dip` 早已是 `110`
 *     （实际约 1.0px）—— 同一类：**注释/说明里的旧数字被当成了事实**。
 *
 * ⚠️ 三条必须遵守的写法（都是踩出来的）：
 *   ① **先剥注释再做形状断言** —— 预览页**有意**在注释里引用旧写法做对照，
 *      不剥就会被自己的注释骗过（A-1117 的 `spanTaper` 就是栽在这上面）；
 *   ② **窗口必须框住**（`fnBody` 取函数体后再匹配）—— 裸写
 *      `/function spanTaper[\s\S]*?0\.4/` 会一路走到布局步的 `R.H * 0.4` 才命中 ⇒ 恒报违规；
 *   ③ **别只锁 `var P = {...}`** —— 那只是**初值**，加载后会被滑杆的 `value` 覆盖
 *      （`bind()` → `sync()` 里 `P[key] = parseFloat(el.value)`）⇒
 *      **滑杆上的数字才是用户真正看到的"默认值"**，所以两条都锁。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { DEFAULT_WAVE_PARAMS, tickPositions } from "../../gui/src/renderer/pages/railParams.js";

const HTML = readFileSync(join(PROJECT_ROOT, "docs/A-1115-topic-rail-preview.html"), "utf8");

/** 剥掉 JS 注释（块注释整段去掉：预览页在**多行块注释内部**引用了旧写法做对照） */
function stripJsComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 真身（剥注释后再断言形状 —— 它的注释里也在引用历史写法） */
const RAIL = stripJsComments(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/pages/TopicRail.tsx"), "utf8"));
/** 预览页 `<script>` 的正文（含 `(function(){...})()` 那段），已剥注释 */
const SCRIPT = stripJsComments(
  [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n")
);

/** 预览页的 `var P = {...}` 字面量正文（默认参数的**手抄**产地；运行时会被滑杆覆盖，见文件头 ③） */
function pObj(): string {
  const m = /var P = \{([\s\S]*?)\};/.exec(SCRIPT);
  expect(m, "预览页找不到 `var P = {...}` —— 结构变了，本守卫需同步").not.toBeNull();
  return (m as RegExpExecArray)[1];
}
/** 取预览页 P 里的 `key: <数字>`（词边界，避免 `a` 命中 `lam0`） */
function pNum(key: string): number {
  const m = new RegExp(`(?:^|[^A-Za-z0-9_])${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(pObj());
  expect(m, `预览页 P 里找不到 ${key}（或已改名）`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}
/** 取预览页 P 里的 `key: true|false` */
function pBool(key: string): boolean {
  const m = new RegExp(`(?:^|[^A-Za-z0-9_])${key}\\s*:\\s*(true|false)`).exec(pObj());
  expect(m, `预览页 P 里找不到布尔 ${key}`).not.toBeNull();
  return (m as RegExpExecArray)[1] === "true";
}
/** 取预览页里 `NAME = <数字>` 的字面量（词边界，避免 `W` 命中 `CW`、`OX` 命中 `RAIL_X`） */
function previewNum(name: string): number {
  const m = new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`).exec(SCRIPT);
  expect(m, `预览页里找不到常量 ${name}（或已改名）`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}
/** 取真身里的 `const <name> = <数字>`（允许**多声明**：`const tA = 1.5, tB = 3.2;` ⇒ 结尾可能是逗号） */
function railNum(name: string): number {
  const m = new RegExp(
    `(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?:[;,)])`
  ).exec(RAIL);
  expect(m, `真身里找不到 const ${name}`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}
/** 取一个函数的函数体（用 4 空格缩进收尾）——
 *  ⚠️ 必须**先框住窗口再匹配**：裸正则 `/function spanTaper[\s\S]*?0\.4/` 会一路漂到
 *  布局步的 `R.H * 0.4` 才命中 ⇒ 恒报违规（A-1117 首版就踩过，技能 §8.1「窗口本身就是 bug」）。 */
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
/** 预览页的滑杆 ↔ 参数键映射（来自 `bind("sSig", "sig", ...)`；`[key, sliderId]`） */
function sliderPairs(): Array<[string, string]> {
  return [...SCRIPT.matchAll(/bind\("(s[A-Za-z0-9]+)",\s*"([A-Za-z0-9]+)"/g)]
    .map((m) => [m[2], m[1]] as [string, string]);
}
/** 预览页的勾选框 ↔ 参数键映射（来自 `bindChk("cPause", "pause")`；`[key, boxId]`） */
function checkPairs(): Array<[string, string]> {
  return [...SCRIPT.matchAll(/bindChk\("(c[A-Za-z0-9]+)",\s*"([A-Za-z0-9]+)"/g)]
    .map((m) => [m[2], m[1]] as [string, string]);
}
/** 取某个 `<input>` 标签的正文（用原始 HTML —— 滑杆属性不在 `<script>` 里） */
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

  /* ⚠️ 这一条才是**用户真正看到的默认值**：`var P` 只是初值，加载末尾的 `bind()→sync()`
     会 `P[key] = parseFloat(el.value)` 把它整个覆盖掉 ⇒ 滑杆属性漂了、曲线就漂了。 */
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
    /* ⚠️ 检测器自己会空转：`it.each([])` 一条用例都不生成、**照样报绿**。
       实测踩到：把这条写成 `length >= 13`（滑杆其实有 14 个）后，删掉一个 `bind(...)`
       只是让守卫**少跑一条用例**（52 → 51）、照样全绿 —— 变异 M63 就是这么活下来的。
       ⇒ 判据只能是"**集合相等**"：
         · 删掉某个 `bind(...)`/`bindChk(...)`（守卫静默退化，或用户永远调不到那个参数）；
         · 新增参数却没在预览页给控件（同一件事的另一面）。 */
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
    /* ⚠️ 真实漂移：预览页写 5、真身是 6。差 1px 的后果是凹陷的夹紧上界
       `R.CW - 2.0 - B.cx` 差 1px —— 曲线看上去一样，**真正的错只能靠对齐判据发现**。 */
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
    /* ⚠️ 把 `0.4H` 写进 spanTaper 是**值恰好相等**（`0.6*(2/3)H == 0.4H`）的静默结构漂移：
       滑杆范围内（H≥300、默认 tap=90）钳位根本不生效 ⇒ 曲线一模一样、行为判据抓不到。
       所以这里用**同形断言**（钳位在哪一步），而不是行为断言。 */
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
    /* ⚠️ 不补掉中间项 ⇒ 隆起曲线在凹陷处还残留约 0.26·Bp，把凹陷吃掉一大半 ——
       症状正是用户当年报的「隆起拉得越大、凹陷反而越看不出来」。 */
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
    // 行为侧：真身纯函数的确等距、且首末贴边
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
      /* ⚠️ 真身的 dragU 是闭包变量（`upU - dragU`），预览页挂在 R 上（`upU - R.dragU`）——
         所以这里用正则容忍前后缀，只锁**阈值 3px** 本身。 */
      expect(src, `${who} 的点击位移阈值变了（阈值内算「点一下 = 跳转」）`).toMatch(/upU - (?:R\.)?dragU\) > 3/);
      expect(src, `${who} 的气泡半高变了`).toContain("half = 16;");
    }
  });
});
