/**
 * tests/gui/a1115-topic-rail.spec.ts — 「目录卷轴」的守卫（A-1115，用户点名需求 #305）。
 *
 * 这条功能有一整族**静默失效**：tsc 过、构建过、逻辑测试全过，但用户眼里就是不对 ——
 * 而且本轮每一条都是真实踩过的（括号里是当时的症状）：
 *   ① 同一图形的多条描边用了**不同的形状函数** ⇒ 像"虚化出另外两条浅色的线"；
 *   ② 清屏用了卷轴宽而不是画布总宽 ⇒ 加宽那截永远清不掉、逐帧叠加 ⇒ **糊成一坨**；
 *   ③ `contain:paint` 放在卷轴容器上（等价 `overflow:clip`）⇒ 悬浮气泡一个像素都不画；
 *   ④ 端部残留给 0 ⇒ 端点变成**精确直线**，反而成了"看得见的另一种形状"；
 *   ⑤ 常态振幅压得太低 ⇒ 两线**全程糊成一条**，用户报"明暗区分越来越小"（其实是根本没有两根线）；
 *   ⑥ 刻度位置按"内容比例"或"滚到顶所需的 scrollTop" ⇒ 前者**成对一密一疏**、后者**底部堆成一坨**；
 *   ⑦ 原生滚动条没真正隐藏、或参数有第二个产地 ⇒ "设置里调好了、实际界面没变"。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  DEFAULT_TICKS_PARAMS,
  DEFAULT_WAVE_PARAMS,
  defaultRailParams,
  normalizeRailParams,
  tickPositions,
} from "../../gui/src/renderer/pages/railParams.js";

/** 去掉注释行后的可执行源码（修复说明会引用旧写法做对照，不剥会误伤） */
function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}
/** 取 CSS 顶层选择器块的正文（用 ^ 锚定行首，避免匹配到 `.x .topic-rail {` 这种子串） */
function cssBlock(src: string, sel: string): string {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, "m").exec(src);
  expect(m, `CSS 选择器未命中：${sel}`).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

const RAIL = codeOf("gui/src/renderer/pages/TopicRail.tsx");
const PARAMS = codeOf("gui/src/renderer/pages/railParams.ts");
const PANEL = codeOf("gui/src/renderer/pages/AppearancePanel.tsx");
const CHAT = codeOf("gui/src/renderer/pages/ChatPanel.tsx");
const SIDEBAR = codeOf("gui/src/renderer/pages/RightSidebar.tsx");
const GENERAL = codeOf("gui/src/renderer/pages/GeneralPanel.tsx");
const SETTINGS = codeOf("gui/src/renderer/pages/SettingsDialog.tsx");
const THEME = codeOf("gui/src/renderer/theme.ts");
const CSS_RAW = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8");

describe("A-1115 — 参数模块（纯函数，唯一出处）", () => {
  it("刻度位置：**均匀等距**铺满 [top,bot]（条目少自然疏、多自然密，间距恒定）", () => {
    const p = tickPositions(5, 100, 400);
    expect(p[0]).toBe(100);
    expect(p[4]).toBe(400);
    const gaps = p.slice(1).map((v, i) => v - p[i]);
    for (const g of gaps) { expect(g).toBeCloseTo(75, 6); }
    // 端点情形
    expect(tickPositions(1, 100, 400)).toEqual([250]);
    expect(tickPositions(0, 100, 400)).toEqual([]);
    // ⚠️ 反例：任何"按比例/按索引平方"的分布都会让间距不等 —— 这正是用户报的「分布不均匀」
    const n = 9;
    const eq = tickPositions(n, 0, 100);
    const eqGaps = eq.slice(1).map((v, i) => v - eq[i]);
    expect(Math.max(...eqGaps) - Math.min(...eqGaps)).toBeLessThan(1e-9);
  });

  it("normalize：越界钳住、非数字丢弃、布尔透传、缺字段补默认（不许留下半个状态）", () => {
    const base = defaultRailParams("wave");
    const r = normalizeRailParams({ amp: 9999, w: -5, lam0: Number.NaN, pause: false, 乱入: 1 }, base);
    expect(r.amp).toBeLessThanOrEqual(100);
    expect(r.amp).toBeGreaterThanOrEqual(0);
    expect(r.w).toBeGreaterThanOrEqual(6);
    expect(r.lam0).toBe(base.lam0);            // NaN 被丢弃 ⇒ 保留默认
    expect(r.pause).toBe(false);               // 布尔照传
    expect((r as unknown as Record<string, unknown>).乱入).toBeUndefined();
    // 脏输入不得抛错，且必须返回完整对象
    expect(normalizeRailParams(null, base)).toEqual(base);
    expect(normalizeRailParams("nonsense", base)).toEqual(base);
  });

  it("默认值本身必须满足三条硬约束（它们各自对应一个踩过的坑）", () => {
    // ④ 端部残留不能是 0：给 0 端点就成了**一段精确直线**，反而"看得见"
    expect(DEFAULT_WAVE_PARAMS.efloor).toBeGreaterThan(0);
    // ⑤ 常态振幅不能太低：两线中心间距必须大于描边覆盖宽度（否则两线糊成一条）
    expect(DEFAULT_WAVE_PARAMS.amp).toBeGreaterThanOrEqual(40);
    // ⑥ md 不做凹陷
    expect(DEFAULT_TICKS_PARAMS.dip).toBe(0);
    // 两条线的波长必须不同，否则交点是固定的、不"交织"
    expect(DEFAULT_WAVE_PARAMS.lam0).not.toBe(DEFAULT_WAVE_PARAMS.lam1);
  });
});

describe("A-1115 — 绘制核心的不变量（源码层，写错也编译通过）", () => {
  it("② 清屏必须用画布总宽 `R.CW`（用卷轴宽 W 会让加宽那截永远清不掉 ⇒ 糊成一坨）", () => {
    expect(RAIL).toContain("clearRect(0, 0, R.CW, H)");
    expect(RAIL).not.toMatch(/clearRect\(0,\s*0,\s*W,/);
    // 画布宽度只有一个出处：CW = OX + W + RIGHT_ROOM
    expect(RAIL).toContain("R.CW = R.OX + R.W + RIGHT_ROOM");
  });

  it("① 四条描边共用同一个 shapeAt；发光层**不许**换个形状（换了 = 多画一对线）", () => {
    // 主体 / 已读段 / 未读段 / 发光都经由 strokeWave，而它内部只读 shapeAt
    expect(RAIL).toContain("const sh = shapeAt(u);");
    const calls = RAIL.match(/strokeWave\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);   // 定义 1 处 + 主体/发光 2 处调用
    // 除定义那行外，调用点不许出现第二个"形状"参数
    expect(RAIL).not.toMatch(/strokeWave\([^)]*zeroG/);
  });

  it("③ `contain:paint` 只放 canvas；卷轴容器上不许有（放容器 = overflow:clip ⇒ 气泡被裁）", () => {
    expect(cssBlock(CSS_RAW, ".topic-rail-canvas")).toContain("contain: paint");
    expect(cssBlock(CSS_RAW, ".topic-rail")).not.toContain("contain");
  });

  it("⑦ 原生滚动条必须真的隐藏（否则卷轴与系统条两条并存）", () => {
    expect(cssBlock(CSS_RAW, ".rail-host")).toContain("scrollbar-width: none");
    expect(cssBlock(CSS_RAW, ".rail-host::-webkit-scrollbar")).toContain("width: 0");
    expect(CHAT).toContain("rail-host");
    expect(SIDEBAR).toContain("rail-host");
  });

  it("衬托的过渡带不能窄（窄了凹陷尾巴与刚恢复的振荡叠在一起 = 「锐角」）", () => {
    expect(RAIL).toContain("const a = p.a, b = a + Math.max(1.4, a * 0.7);");
  });

  it("② 分隔线变粗必须靠**线自己**（border-image-width > border-width），不是叠覆盖层", () => {
    /* 用户先报「发光覆盖在边界线上、臃肿」（那是 resizer 自己画的 5px 带 ⇒ 已删），
       随后立刻报「拖拽光标太窄了」⇒ 正解是**让线本身变粗**：`border-image-width` 大于
       `border-width` 时多出的部分向内画，零布局位移、仍只有一个产地。
       ⚠️ 同时守两件事：① 粗了（>1px）；② 方向没写反（slice 必须落在有 border 的那条边上）。 */
    /* ⚠️ 不要用 `.sidebar:has\([^)]*\)` 这种正则去找规则 —— `:has(.x:is(:hover, :active))` 里**嵌套括号**，
       `[^)]*` 会在第一层 `)` 就停住、永远匹配不到。直接匹配**声明本身**，顺带把方向也锁住。 */
    const li = /border-image:\s*var\(--rz-ramp\)\s+0\s+(\d+)\s+0\s+0\s*\/\s*0\s+(\d+)px\s+0\s+0/.exec(CSS_RAW);
    expect(li, "找不到左栏分隔线的聚光声明（slice 在右侧那一份）").not.toBeNull();
    expect(Number((li as RegExpExecArray)[1]), "左栏 slice 必须落在**右**侧（分隔线在右边）—— 写反什么都不亮")
      .toBeGreaterThan(0);
    const lw = Number((li as RegExpExecArray)[2]);
    expect(lw, "分隔线太细 —— 用户明确反馈过「拖拽光标太窄了，怎么这么细」").toBeGreaterThan(1);
    const ri = /border-image:\s*var\(--rz-ramp\)\s+0\s+0\s+0\s+(\d+)\s*\/\s*0\s+0\s+0\s+(\d+)px/.exec(CSS_RAW);
    expect(ri, "找不到右栏分隔线的聚光声明（slice 在左侧那一份）").not.toBeNull();
    expect(Number((ri as RegExpExecArray)[1]), "右栏 slice 必须落在**左**侧（镜像）").toBeGreaterThan(0);
    expect(Number((ri as RegExpExecArray)[2]), "左右两栏的分隔线粗细必须一致（否则一边细一边粗）")
      .toBe(lw);
    /* 反面：resizer 自己不许画东西（唯一产地）—— 上一版就死在这 */
    expect(cssBlock(CSS_RAW, ".sidebar-resizer")).not.toMatch(/background-image\s*:/);
  });

  it("③ md 滚动：对应刻度要随**当前滚动位置**隆起（按 `s` 找，不是按 `u`）", () => {
    expect(RAIL, "md 刻度没有滚动驱动的隆起 —— 用户：「翻到对应位置，刻度线要隆起有反应」")
      .toContain("0.62 * profBump(Math.abs(tk.u - R.curU) / spacing)");
    expect(RAIL, "找当前条目必须按 `s`（目标 scrollTop）；按 `u` 会永远是中间那条亮")
      .toContain("const dd = Math.abs(R.ticks[k].s - s2);");
    expect(RAIL, "滚动驱动与鼠标驱动必须取 max —— 相加会在两者重合时翻倍跳一下")
      .toContain("Math.max(bump(Math.abs(tk.u - R.ptr.uc)) * R.ptr.strength, profCur)");
    /* ⚠️⚠️ A-1117 实测修掉的真缺陷：**衰减必须按刻度间距归一**。
       刻度是等距按条数铺的，而 `sig` 是固定像素 ⇒ 条目一多间距小于衰减宽度 = 一次亮好几条
       （实测 H=600：n=16 → 邻刻度 0.76、n=20 → 0.99、n=30 → 1.00，「看不出是哪条」）。 */
    expect(RAIL, "滚动隆起的衰减按**刻度间距**归一（按绝对像素 sig 会在长文档上亮成一片）")
      .toContain("const spacing = n > 1 ? (R.BOT - R.TOP) / (n - 1) : Math.max(1, R.BOT - R.TOP);");
    expect(RAIL, "本单位下 1.0 处必须归零 ⇒ 停稳时只有一条满亮（相邻那条只在滑动途中半亮）")
      .toMatch(/const pA = 0\.25, pB = 1\.0;/);
    /* 位置必须由 `frame`（有真实 `dt`）阻尼推进：目标在两刻度间是**整格跳**的，不阻尼会硬跳一下。 */
    expect(RAIL, "滚动位置没有阻尼（目标整格跳 ⇒ 隆起会硬跳，而不是滑过去）")
      .toContain("R.curU += (R.curUt - R.curU) * kk;");
    expect(RAIL, "阻尼未停稳时不许判定静止（否则隆起停在半路）")
      .toContain("const scrollSettled = !withTicks || R.ticks.length === 0 || R.curU === R.curUt;");
  });

  it("两线必须分得开：描边宽度与振幅是互相抢空间的（线宽被调胖 = 两线糊成一条）", () => {
    expect(RAIL).toContain("const wMain = i ? W * 0.095 : W * 0.13;");
  });
});

describe("A-1115 — 接线（参数读同一份、宿主内边距与卷轴余量成对）", () => {
  it("对话页：wave 参数 + rail-host + 右侧内边距 30（= RAIL_INSET 6 + 卷轴 w + LEFT_ROOM 12）", () => {
    expect(CHAT).toContain('loadRailParams("wave")');
    expect(CHAT).toContain("onRailParams");
    expect(CHAT).toContain('mode="wave"');
    /* ⚠️ 迁移：不再断言「精确的 30px」，而是断言**右侧内边距 ≥ 卷轴占位 + 隆起要伸出去的那 12px**。
       用户反馈「正文跟卷轴挤在一起」后把 30 调成 38 —— 旧的精确字符串断言会把「合法加宽」判成故障，
       而它的真实意图只是「留白必须够，别让隆起压到正文」。 */
    const pad = /padding: "14px (\d+)px 0 16px"/.exec(CHAT);
    expect(pad, "聊天滚动容器没有右侧留白（卷轴会压到正文）").not.toBeNull();
    expect(Number((pad as RegExpExecArray)[1])).toBeGreaterThanOrEqual(30);
    // 话题来源 = 用户气泡（换了类名就会静默变成"没有话题"）
    expect(CHAT).toContain(".msg-user-bubble");
  });

  it("右栏 md：ticks 参数 + 同一套 rail-host/内边距约定", () => {
    expect(SIDEBAR).toContain('loadRailParams("ticks")');
    expect(SIDEBAR).toContain("onRailParams");
    expect(SIDEBAR).toContain('mode="ticks"');
    expect(SIDEBAR).toContain("padding: \"12px 30px 12px 16px\"");
    expect(SIDEBAR).toContain('querySelectorAll<HTMLElement>("h1,h2,h3")');
  });

  it("参数没有第二个产地：两个宿主都不许自己写死默认值", () => {
    for (const [name, src] of [["ChatPanel", CHAT], ["RightSidebar", SIDEBAR]] as const) {
      expect(src, `${name} 不应内联卷轴默认参数`).not.toMatch(/bulge:\s*\d/);
      expect(src, `${name} 不应内联卷轴默认参数`).not.toMatch(/efloor:\s*0\./);
    }
    expect(PARAMS).toContain("export function loadRailParams");
    expect(PARAMS).toContain("export function saveRailParams");
    expect(PARAMS).toContain("export function onRailParams");
  });
});

describe("A-1115 — 外观专栏（主题迁入 + 演示框）", () => {
  it("设置里确实注册了「外观」栏目（类型 + 清单 + 渲染分支，三处缺一不可）", () => {
    expect(SETTINGS).toContain('"appearance"');
    expect(SETTINGS).toContain('id: "appearance"');
    expect(SETTINGS).toContain('activeTab === "appearance"');
    expect(SETTINGS).toContain("<AppearancePanel");
  });

  it("主题唯一出处 = theme.ts::THEMES，且「通用」页不再有主题卡片（两个入口 = 两个真相源）", () => {
    expect(THEME).toContain("export const THEMES");
    expect(GENERAL).not.toContain("THEMES");
    expect(GENERAL).not.toContain("界面主题");
    expect(PANEL).toContain("THEMES");
  });

  it("演示框左边只有卷轴：用**同一个组件**、读**同一份参数**（不许另写一份画法）", () => {
    expect(PANEL).toContain("<TopicRail mode={mode}");
    expect(PANEL).toContain("loadRailParams(mode)");
    expect(PANEL).toContain("saveRailParams(mode");
    // md / 对话页两个目标都要能调
    expect(PANEL).toContain('{ id: "chat"');
    expect(PANEL).toContain('{ id: "md"');
  });

  it("演示框的圆角/裁剪在内层滚动容器上（外层裁剪会把悬浮气泡切掉）", () => {
    expect(cssBlock(CSS_RAW, ".appearance-demo")).not.toContain("overflow");
    expect(cssBlock(CSS_RAW, ".appearance-demo-scroll")).toContain("overflow-y: auto");
    expect(cssBlock(CSS_RAW, ".appearance-demo-scroll")).toContain("border-radius");
  });
});

/**
 * A-1118 — **rAF 循环泄漏**（用户实例取证：「md 编辑页只有滚动 / 鼠标放上去才变成刻度，
 * 其余时间都是波形，你是不是把代码混淆了？」）。
 *
 * ⚠️ 这条属于本仓最难查的一族：**tsc 过、构建过、全部 18 条既有守卫也全绿**，
 * 因为两个 mode 的绘制分支**各自都是对的**，错的是「同一张 canvas 上有两代闭包同时在逐帧画」。
 * 根因三条叠加（少了任何一条都不会漏）：
 *   ① `cleanup` 里只写了 `R.running = false` —— 它拦的是**下一次** `ensureLoop()`，
 *      拦不住**已经排队那一帧**：回调照样执行、`frame()` 末尾照样续下一帧 ⇒ 循环永生；
 *   ② `frame()` **入口没有「本实例是否已废弃」的判断**，所以它执行到底；
 *   ③ wave 的静止判据 `idle` 里含 `p.spd === 0`，而 `spd` 默认 1 ⇒ **idle 恒为 false**。
 * 合起来 = **每次切 mode 就永久泄漏一个 60fps 循环**；屏幕上只剩最后一个画的赢家。
 * 实测（CDP 数 rAF 回调实例）：界面上 2 个卷轴，活着 **6** 个循环。
 *
 * ⚠️ 所以这里的断言**不能只是 `toContain("alive")`** —— 那只能守住"变量还在"。
 * 真正的判据是**挡板的位置**：它必须早于本实例体内任何一次 `requestAnimationFrame(`。
 * 把挡板挪到函数尾部（或挪到 `draw()` 之后）照样"含有 alive"，但**等于没挡**。
 * 另外**刻意不加 `key={mode}` 兜底**：那样旧闭包会在废弃 canvas 上继续烧 60fps，
 * 症状被掩盖、缺陷依然在，只是从"看得见"变成"看不见"—— 属于本仓定义的静默失效。
 */
describe("A-1118 — rAF 循环生命周期（泄漏 = 两代闭包同画一张 canvas）", () => {
  /** 取一个函数的函数体（用 4 空格缩进收尾，避开创伤内层块的 `      }`） */
  function fnBody(src: string, header: string): string {
    const i = src.indexOf(header);
    expect(i, `找不到函数：${header}`).toBeGreaterThanOrEqual(0);
    const rest = src.slice(i + header.length);
    const end = rest.indexOf("\n    }");
    expect(end, `函数体没闭合：${header}`).toBeGreaterThan(0);
    return rest.slice(0, end);
  }

  it("`frame()` 入口必须有 `!alive` 挡板，且**早于**它自己排下一次 rAF（位置才是判据）", () => {
    const body = fnBody(RAIL, "function frame(tms: number): void {");
    const guard = body.indexOf("!alive");
    const raf = body.indexOf("requestAnimationFrame(");
    expect(guard, "frame() 里没有 alive 挡板 ⇒ cleanup 后已排队的那一帧会续命成僵尸循环").toBeGreaterThanOrEqual(0);
    expect(raf, "frame() 里找不到自续帧的 rAF —— 结构变了，本守卫需要同步").toBeGreaterThanOrEqual(0);
    expect(guard, "挡板必须在排下一次 rAF **之前**：挪到后面 = 僵尸帧照样续命，等于没挡")
      .toBeLessThan(raf);
    // 僵尸帧也不能被当成"循环还活着"，否则 R.running 会阻止新实例启动新循环
    expect(body.slice(0, raf), "挡板里必须把 R.running 归零").toContain("R.running = false");
  });

  it("`ensureLoop()` 不得给废弃实例启动新循环；`layout()` 同样要挡", () => {
    expect(fnBody(RAIL, "function ensureLoop(): void {"), "废弃实例仍会启动新循环")
      .toContain("!alive");
    /* `ResizeObserver` / window resize 在 cleanup 之后仍可能投递一次已排队的回调，
       那时 `measure()` 会写 aria、`draw()` 会按**旧 mode** 画一整帧盖掉新实例。 */
    expect(fnBody(RAIL, "function layout(): void {"), "layout 在 cleanup 后仍会画一整帧")
      .toContain("!alive");
  });

  it("cleanup 必须把两件事都做掉：终止令牌 + 停掉 running（少一件都还会漏）", () => {
    const body = fnBody(RAIL, "return () => {");
    expect(body, "没有 alive = false ⇒ 已排队的帧会活下来并续命").toContain("alive = false");
    expect(body, "没有 R.running = false ⇒ 外部事件还会启动新循环").toContain("R.running = false");
    // 挡板总数：frame + ensureLoop + layout（漏一个 = 那条路径仍能复活循环）
    const guards = RAIL.match(/!alive/g) ?? [];
    expect(guards.length, `只有 ${guards.length} 处 !alive 挡板，三条入口（frame/ensureLoop/layout）都要有`)
      .toBeGreaterThanOrEqual(3);
    // ⚠️ 反例：不许用 `key={mode}` 之类"换个 DOM 节点"的办法冒充修复（旧闭包仍在烧 CPU）
    expect(RAIL, "不许靠重建 canvas 掩盖泄漏：旧闭包会在废弃节点上继续 60fps")
      .not.toMatch(/<canvas[^>]*key=/);
  });
});

/**
 * A-1119 — 设置面板的**留白地板**（用户两次实例取证：「与边界相交、拥挤」+「顶着标签页」）。
 *
 * ⚠️ 这条的**判据在 A-1118 首版被判错了**，记下来免得再犯：
 *   A-1118 首版把留白写在**外观面板自己**的根容器上（`paddingLeft: 14 / paddingRight: 10`），
 *   守卫也照着"面板根有 padding"写。那是**治标** —— 实测同族面板的根 padding 口径是
 *   16 / 12 / 4 / 0 **四种**（谁写 0 谁就贴线：「实验性」的黄色横幅 `left` 与导航分割线
 *   **像素级相等**，gap = 0）。用户第二次取证（「顶着标签页」）正是这个"每页各写一份"的
 *   必然结果：修了外观页的左右，忘了它自己的上下。
 *   ⇒ 正解 = **水平地板收归共用祖先**（`SettingsDialog` 内容区，左边界"分隔线在哪"对所有页
 *     都是同一个事实），各面板根的 paddingLeft 一律**归零**（否则两产地叠加成 32）。
 *   ⚠️ 但**垂直节奏不能收**：实测各页顶 padding 是 16 / 12 / 6px，是各页自己的节奏，
 *     收到内容区会让它们叠加 ⇒ 上下仍由面板自管，**必须写出来**（外观页首版就漏了）。
 *
 * 实测（窗口 1272×1082）改后：13 个面板内容左缘**统一 16px**（改前 16 / 12 / 4 / 0 混用，
 * 「实验性」「后台任务」「使用统计」「Agent 管理」分别是 0 / 4 / 4 / 0）。
 */
describe("A-1119 — 设置面板留白地板（水平归内容区、垂直归面板自己）", () => {
  const DIALOG = codeOf("gui/src/renderer/pages/SettingsDialog.tsx");
  /**
   * 装配面板根容器的相对路径。
   * ⚠️ 判据锚在**类名 `.settings-pane`** 上，不锚"文件里第一处 `padding: "..."`"——
   *    A-1119 首版就是这么写错的：`/padding: "([^"]+)"/` 会命中面板内部某个卡片的
   *    `padding: "12px"`，于是"根容器归零"这条**永远验不到真东西**（假判据）。
   *    与 `09-26 §3` 那条同宗：**位置/锚点错了，守卫就在空转**。
   */
  const ROOTS: Array<[string, string]> = [
    ["GeneralPanel", "gui/src/renderer/pages/GeneralPanel.tsx"],
    ["RuntimePanel", "gui/src/renderer/pages/RuntimePanel.tsx"],
    ["SkillsPanel", "gui/src/renderer/pages/SkillsPanel.tsx"],
    ["McpPanel", "gui/src/renderer/pages/McpPanel.tsx"],
    ["PermissionsPanel", "gui/src/renderer/pages/PermissionsPanel.tsx"],
    ["ProvidersPanel", "gui/src/renderer/pages/ProvidersPanel.tsx"],
    ["StatusPanel", "gui/src/renderer/pages/StatusPanel.tsx"],
    ["LlmGatewayPanel", "gui/src/renderer/pages/LlmGatewayPanel.tsx"],
    ["MindHubPanel", "gui/src/renderer/pages/MindHubPanel.tsx"],
    ["ResidentPanel", "gui/src/renderer/pages/ResidentPanel.tsx"],
    ["UsageStatsPanel", "gui/src/renderer/pages/UsageStatsPanel.tsx"],
    ["AgentsPanel", "gui/src/renderer/pages/AgentsPanel.tsx"],
    ["AppearancePanel", "gui/src/renderer/pages/AppearancePanel.tsx"],
  ];

  /** 取**根容器的开标签**（从 `className="settings-pane"` 截到该标签的 `>`）。
   *  ⚠️ 不能只取那一"行"：根容器可能写成多行（外观面板就是 `className=...` 与
   *     `paddingTop` 分两行）⇒ 只取一行会让垂直留白那条**永远找不到 paddingTop**。 */
  function paneTag(rel: string): string {
    const src = codeOf(rel);
    const i = src.indexOf('className="settings-pane"');
    expect(i, `${rel} 找不到 .settings-pane 根容器 —— 结构变了，本守卫需同步`)
      .toBeGreaterThanOrEqual(0);
    const j = src.indexOf(">", i);
    return src.slice(i, j + 1);
  }

  /** 解析 CSS `padding` 简写的**左侧**值。1 值=全周；2 值=上/左右；3 值=上/左右/下；
   *  4 值=上/右/下/左 ⇒ 左值分别是 [0] / [1] / [1] / [3]。缺省（无 padding）= 0。 */
  function leftOf(shorthand: string | undefined): number {
    if (shorthand === undefined) { return 0; }
    const p = shorthand.replace(/px/g, "").trim().split(/\s+/);
    return Number(p.length === 1 ? p[0] : p.length === 4 ? p[3] : p[1]);
  }

  it("内容区（共用祖先）必须给出左侧地板 —— 左边界是共用事实，只能有一个产地", () => {
    /* 判据：内容区那行 `flex: 1, minWidth: 0, overflowY: "auto"` 带 `paddingLeft >= 8`。 */
    const m = /flex: 1, minWidth: 0, overflowY: "auto"[^\n]*paddingLeft: (\d+)/.exec(DIALOG);
    expect(m, "内容区找不到 paddingLeft —— 结构变了，本守卫需同步").not.toBeNull();
    expect(Number((m as RegExpExecArray)[1]), "内容区没给左地板 ⇒ 面板会顶到导航分割线")
      .toBeGreaterThanOrEqual(8);
  });

  it("内容区右侧也要留白（盖过对话框边界，避免内容贴边）", () => {
    const m = /flex: 1, minWidth: 0, overflowY: "auto"[^\n]*paddingRight: (\d+)/.exec(DIALOG);
    expect(m, "内容区找不到 paddingRight").not.toBeNull();
    expect(Number((m as RegExpExecArray)[1]), "右缘会贴住对话框边界").toBeGreaterThanOrEqual(8);
  });

  it.each(ROOTS)("%s 的根容器水平 padding 必须为 0（不许再有第二份地板）", (_name, rel) => {
    const line = paneTag(rel);
    const m = /padding: "([^"]+)"/.exec(line);
    expect(leftOf(m ? (m as RegExpExecArray)[1] : undefined),
      `${_name} 根容器又给了水平留白 ⇒ 与内容区叠加（16+16=32）`).toBe(0);
    /* ⚠️ 只允许 `padding: "Apx 0"` / `"Apx 0 Bpx"` 这种（2/3 值），
       不许出现显式 `paddingLeft` / `paddingRight`（那等于绕过上面的简写判据）。 */
    expect(line, `${_name} 根容器不该出现显式 paddingLeft/Right`).not.toMatch(/padding(Left|Right):/);
  });

  it("外观面板根的**垂直**留白必须写出来（首版只让左右 ⇒ 页签顶到顶边）", () => {
    /* ⚠️ 这条是用户第二次取证的原话：「标签页顶到了」。
       判据 = 面板根出现 paddingTop / paddingBottom 且 >= 8（垂直不能收归内容区，
       因为它承载的是各页自己的节奏，见 describe 头注释）。 */
    const line = paneTag("gui/src/renderer/pages/AppearancePanel.tsx");
    const top = /paddingTop: (\d+)/.exec(line);
    expect(top, "根容器没有 paddingTop ⇒ 页签/卡片会顶在内容区上沿").not.toBeNull();
    expect(Number((top as RegExpExecArray)[1])).toBeGreaterThanOrEqual(8);
    expect(line, "上下要成对（只给一边会让底部贴边）").toMatch(/paddingBottom: \d+/);
  });

  it("右栏滚动容器的右侧内边距必须盖过滚动条本身（否则卡片边框压在滚动条上）", () => {
    const m = /flex: 1, minWidth: 0, overflowY: "auto", paddingRight: (\d+)/.exec(PANEL);
    expect(m, "找不到右栏滚动容器 —— 结构变了，本守卫需要同步").not.toBeNull();
    expect(Number((m as RegExpExecArray)[1]), "小于滚动条宽度 = 卡片边框与滚动条重叠")
      .toBeGreaterThanOrEqual(8);
  });

  it("主题卡两列按钮必须仍能**并排不换行**（加留白会把可用宽挤窄）", () => {
    /* 判据：内容宽 ≥ 两个按钮的 flex-basis 之和 + gap。
       取 minWidth 320（设置对话框在 96vw 下的下限）反推可用宽，避免"只在开发机宽度下好看"。 */
    expect(PANEL).toContain('flex: "1 1 200px"');
    expect(PANEL).toMatch(/gap: 10/);
    // 左栏是写死的 320；两栏之间 gap 16 ⇒ ~410px 是并排不换行的经验下限（见面板注释）
    expect(PANEL, "两栏结构变了，需重算并排所需的最小可用宽").toContain("width: 320");
  });
});
