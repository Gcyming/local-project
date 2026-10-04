/**
 * tests/gui/float-dock.spec.ts — 输入框上方「悬浮按钮坞」的守卫（A-1074 / #230）。
 *
 * 用户原话（#230）：
 *   「改成输入框**正上方的最右边**悬浮按钮，点击后**横向延伸再向上展开**，动画与产物卡片同族」
 *   「**子代理从右侧监测栏移出**，做成**同款**悬浮按钮」
 *   「**一个展开时另一个渐出**」
 *
 * 为什么需要这个文件：这四句里有三句是**接线/几何事实**，过 tsc、过构建、过全部逻辑测试，
 * 只在用户眼里翻车（本仓反复强调的"静默失效"类）：
 *   · 位置（是否真在输入框上方、是否贴最右）；
 *   · 展开方向（`bottom:100%` ⇒ 向上长且**不顶动输入框**；写成文档流布局就会把输入框顶下去）；
 *   · "同族"（面板必须**直接用** `.collapse` 这个类，而不是另写一套时长 —— 否则切主题/调节拍时只变一半）；
 *   · "移出监测栏"（留在监测栏里就是没做）。
 * 第 4 句（互斥）是**纯判据**，可以穷举验证 —— 放在 A 组。
 *
 * ⚠️ A-1126（用户 2026-09-26）**更正了第 4 句的作用范围**：用户原话
 *   「为什么点击后台任务后，**同行的子代理悬浮按钮会消失**？旧设定没删干净？」
 *   ⇒ 互斥作用于**面板**（同一时刻只有一个 `.collapse.is-open`），
 *     **按钮必须常显**。旧实现把 `is-faded` 挂在整格上（按钮一起淡出），已删除；
 *     本文件新增"按钮常显 / 没有 is-faded"的那几条断言，防止旧设定复活。
 *
 * 变异：`gui/scripts/mut-a1074-dock.mjs`
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCK_ORDER, toggleDock, closeDock, isDockOpen, dockSlotClassOf,
  type DockState,
} from "../../gui/src/renderer/pages/floatDock.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释：注释里写着"曾经是什么"，不该被当成当前值（本仓 §8-1）。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CSS = stripComments(read("gui/src/renderer/index.css"));
const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
const PANEL_C = strip(PANEL);
const SUB_C = strip(read("gui/src/renderer/pages/SubAgentExpandButton.tsx"));

/**
 * 取某个选择器块的内容（块内不含嵌套 `}`）。
 *
 * ⚠️ 必须**行首**精确匹配，不能用 `indexOf(sel)`：`.dock-pill` 前面还有一条
 * `.dock-slot.is-open .dock-pill { ... }` —— 后者**包含**前者这个子串，于是 `indexOf`
 * 取到的是那条强调规则，`.dock-pill` 本体的断言全部落空（实测变异 B8c 假绿：往本体里
 * 塞 `width: 100%` 也测不出来）。
 */
function rule(sel: string): string {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp("(?:^|\\n)" + esc + "\\s*\\{").exec(CSS);
  expect(m, `找不到以行首起头的选择器 ${sel}`).toBeTruthy();
  const open = CSS.indexOf("{", m!.index);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

/** 取 `from` 起点到 `next` 起点之间的源码。 */
function between(src: string, from: string, next: string): string {
  const at = src.indexOf(from);
  expect(at, `锚点漂移：找不到 ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(next, at + from.length);
  expect(end, `锚点漂移：找不到 ${from} 的右界 ${next}`).toBeGreaterThan(at);
  return src.slice(at, end);
}

// ── ① 互斥判据（纯模块，可穷举）──────────────────────────────────────────────
describe("A-1074①：「一个展开时另一个**面板**收起」——用**单值**表达，非法状态不存在", () => {
  it("toggle：点开就展开、再点收起、点另一个则切换", () => {
    expect(toggleDock(null, "procs")).toBe("procs");
    expect(toggleDock("procs", "procs")).toBeNull();
    expect(toggleDock("procs", "subs"), "点另一个应切换，而不是两个都开").toBe("subs");
    expect(toggleDock("subs", "subs")).toBeNull();
  });

  it("**穷举**全部 (状态 × 位置)：至多一个面板展开", () => {
    const states: DockState[] = [null, "procs", "subs"];
    for (const s of states) {
      let openCount = 0;
      for (const id of DOCK_ORDER) {
        if (isDockOpen(s, id)) { openCount += 1; }
      }
      expect(openCount, `状态 ${s} 下有 ${openCount} 个面板展开 —— 用户要的是「一个展开时另一个让位」`).toBeLessThanOrEqual(1);
    }
  });

  it("展开态恰好是「当前那一个」：都收起时谁都不算展开", () => {
    expect(DOCK_ORDER.map((k) => isDockOpen(null, k))).toEqual([false, false]);
    expect(isDockOpen("procs", "procs")).toBe(true);
    expect(isDockOpen("procs", "subs")).toBe(false);
  });

  it("closeDock **只关自己**：另一个正开着时不许被顺手关掉（无关操作互相踩）", () => {
    expect(closeDock("procs", "procs")).toBeNull();
    expect(closeDock("subs", "procs"), "关 procs 顺手把 subs 关了 → 用户正看着的子代理面板自己消失").toBe("subs");
    expect(closeDock(null, "procs")).toBeNull();
  });

  it("⚠️ A-1126 类名**只有** is-open 一个状态位（不再有 is-faded）", () => {
    /* 用户 2026-09-26：「为什么点击后台任务后，同行的子代理悬浮按钮会消失？旧设定没删干净？」
       ⇒ 渐出/互斥只作用于**面板**，按钮常显。这条守卫锁住"旧设定没有复活"：
          ① 类名函数本身产不出 is-faded；
          ② 模块里不再导出 isDockFaded / dockSlotState 这两个旧 API
             （留着它们就是留着"第二个产地"，迟早有人再接回一个格子上去）。 */
    expect(dockSlotClassOf(true), "展开态必须带 is-open（CSS 靠它做强调）").toBe("dock-slot is-open");
    expect(dockSlotClassOf(false)).toBe("dock-slot");
    for (const open of [true, false]) {
      expect(dockSlotClassOf(open), "又产出了 is-faded → 另一个按钮会随面板展开而消失").not.toContain("is-faded");
    }
    const moduleSrc = strip(read("gui/src/renderer/pages/floatDock.ts"));
    expect(moduleSrc, "又导出了旧的渐出判据 isDockFaded（按钮常显的旧设定会顺着它复活）").not.toContain("isDockFaded");
    expect(moduleSrc, "又导出了旧的 dockSlotState（含 faded 的第二真相源）").not.toContain("dockSlotState");
  });

  it("渲染顺序的唯一出处是 DOCK_ORDER（组件里不许再写字面量数组）", () => {
    expect([...DOCK_ORDER]).toEqual(["procs", "subs"]);
  });
});

// ── ② 接线事实 ───────────────────────────────────────────────────────────────
describe("A-1074②：坞在输入框上方最右 / 面板向上展开 / 与产物卡同族 / 子代理已移出监测栏", () => {
  const DOCK = between(PANEL_C, '<div className="float-dock">', "<textarea ref={inputRef}");

  it("坞排在**监测栏上面**（A-1077 用户更正：「我说的位置也不是这里，还要在监测栏上面」）", () => {
    const dockAt = PANEL_C.indexOf('className="float-dock"');
    const tokensAt = PANEL_C.indexOf('className="context-tokens-num"');
    expect(dockAt, "找不到坞").toBeGreaterThan(-1);
    expect(tokensAt, "找不到监测栏（tokens/耗时/context 那一条）").toBeGreaterThan(-1);
    expect(dockAt, "坞排到了监测栏**下面** —— 用户要的是监测栏上面").toBeLessThan(tokensAt);
  });

  it("坞在 `.glass-input` 那个圆角框**之外**（在里面 ⇒ 面板被 overflow:hidden 裁掉 ⇒ 点击展开什么都看不见）", () => {
    /* A-1078 实测故障：坞嵌在 `<div className="glass-input">`（输入框那个圆角边框）里，
       而它带 `overflow: hidden` —— 于是 `bottom:100%` 向上展开的面板**整个被裁掉**：
       用户点展开，"直接都看不见内容了"。同类坑：任何 `overflow` 非 visible 的祖先都会这样。
       ⇒ 判据：坞必须排在 `.glass-input` **之前**（= 与它平级、在它外面），不是嵌在它里面。 */
    const dockAt = PANEL_C.indexOf('className="float-dock"');
    const glassAt = PANEL_C.indexOf('className="glass-input"');
    expect(dockAt, "找不到坞").toBeGreaterThan(-1);
    expect(glassAt, "找不到输入框圆角框").toBeGreaterThan(-1);
    expect(dockAt, "坞被放回输入框那个框里 → absolute 面板会被 overflow:hidden 裁掉（实测「点击展开看不见内容」）")
      .toBeLessThan(glassAt);
  });

  it("坞仍是输入框的**前一个兄弟区**（用户原话「输入框正上方」）", () => {
    const dockAt = PANEL_C.indexOf('className="float-dock"');
    const taAt = PANEL_C.indexOf("<textarea ref={inputRef}");
    expect(dockAt, "找不到坞").toBeGreaterThan(-1);
    expect(taAt, "找不到输入框").toBeGreaterThan(-1);
    expect(dockAt, "坞被放到输入框下面 → 用户要的是上方").toBeLessThan(taAt);
  });

  it("胶囊贴**最右**（`justify-content: flex-end`）", () => {
    expect(rule(".float-dock"), "坞没有贴最右 → 悬浮按钮飘在左边").toContain("justify-content: flex-end");
  });

  it("「悬浮窗，**不用框起来**」：胶囊没有边框，靠投影浮起来；展开态也不靠描边", () => {
    const pill = rule(".dock-pill");
    expect(pill, "胶囊又加了边框 —— 用户明确说「不用框起来」").not.toMatch(/border:\s*1px/);
    expect(pill, "没有投影 ⇒ 边框一去就成了一条不浮起来的色块").toMatch(/box-shadow:\s*0/);
    const openPill = rule(".dock-slot.is-open .dock-pill");
    expect(openPill, "展开态又用描边做强调（用户要的是不框起来）").not.toMatch(/border(-color)?:\s*1px/);
    expect(openPill, "展开态没有强调 → 看不出哪一个是开着的").toContain("background");
  });

  it("坞与**下面那一块**留出几个像素的间距（用户：「不要跟下面的窗口碰着」）", () => {
    const dock = rule(".float-dock");
    /* ⚠️ 首个值可能是 `0`（无单位）—— 正则必须允许它省略 px，否则恒 NaN。 */
    const three = /padding:\s*[\d.]+(?:px)?\s+[\d.]+(?:px)?\s+([\d.]+)px/.exec(dock);
    const bottom = /padding-bottom:\s*([\d.]+)px/.exec(dock);
    const gap = three ? Number(three[1]) : bottom ? Number(bottom[1]) : Number.NaN;
    expect(gap, "取不到坞的下边距（padding 形态变了？）").not.toBeNaN();
    expect(gap, "下边距 < 4px → 会跟下面那块碰着（用户要的是「几个像素的距离」）").toBeGreaterThanOrEqual(4);
  });

  it("面板**向上**展开：绝对定位 + `bottom:100%`（在文档流里往下撑会把输入框整个顶下去）", () => {
    const panel = rule(".dock-panel");
    expect(panel, "面板不是绝对定位 → 展开时会撑动布局，把输入框挤下去").toContain("position: absolute");
    expect(panel, "面板没锚在按钮上沿 → 不会向上长").toContain("bottom: 100%");
    // 且锚点（坞）必须是定位祖先，否则 absolute 会跑到更外层去
    expect(rule(".float-dock"), "坞不是定位祖先 → absolute 面板的定位基准会跑偏").toContain("position: relative");
  });

  it("与产物卡**同族**：面板内部直接用 `.collapse`，节拍只走共享变量（不写死时长）", () => {
    expect(DOCK, "面板没复用 .collapse 这个类 → 「与产物卡同族」只是说法").toContain("collapse${procsOpen");
    // 展开/收起相关的过渡时长一律取共享变量
    expect(rule(".dock-pill"), "胶囊的过渡没走 --collapse-dur").toContain("var(--collapse-dur)");
    /* A-1126：`.dock-slot` 不再有过渡（它那条 `transition: opacity` 只服务于已被删掉的渐隐）
       ⇒ 它**不该**出现在"必须走共享节拍"的名单里；改成断言它干脆没有过渡。 */
    expect(rule(".dock-slot"), "坞格又长出了过渡（渐隐那套旧设定会顺着它复活）").not.toMatch(/transition/);
    for (const sel of [".float-dock", ".dock-panel", ".dock-pill"]) {
      expect(rule(sel), `${sel} 里写死了秒数 —— 应改走 --collapse-dur/--collapse-ease`)
        .not.toMatch(/transition[^;]*\b\d+(\.\d+)?s\b/);
    }
  });

  it("面板比胶囊**晚一步**抬起来（时长不变，只是错开一步 → 有「先按下再展开」的层次）", () => {
    const d = rule(".dock-panel > .collapse");
    expect(d, "面板与胶囊同时起跑 → 少了那一下层次").toContain("transition-delay");
  });

  it("A-1079：**不再有「横向延伸」** —— 胶囊任何状态下都紧凑（用户：「直接向上展开的话，那个按钮就不用扩展了」）", () => {
    /* 用户看了实物后撤销了 #230 里的"横向延伸"：既然面板是"贴着按钮上沿向上浮的一张卡片"，
       按钮再变宽就是多余动作，还会把右侧另一个按钮挤位。
       ⇒ 判据：① 源码里不再有摘要段；② CSS 里不再有宽度动画；③ 胶囊不许 `width: 100%`
       （那让它去撑满坞格，而坞格宽度又由胶囊内容决定 —— 循环依赖）。
       回归网：也不许退回 `grid-template-columns: 0fr` 那套（列轨在非定宽容器里收不拢，
       A-1077 实测会把胶囊撑成通栏）。 */
    expect(PANEL_C, "坞里又出现摘要段了 —— 用户已撤销横向延伸").not.toContain("dock-pill-summary");
    expect(SUB_C, "子代理胶囊又出现摘要段了").not.toContain("dock-pill-summary");
    expect(CSS, "胶囊又有了变宽动画（max-width/width 过渡）").not.toMatch(/\.dock-pill[^{]*\{[^}]*max-width/);
    expect(rule(".dock-pill"), "胶囊写了 width:100%（应改为按内容定宽）").not.toMatch(/width:\s*100%/);
    /* ⚠️ A-1130 **迁移**（不是删）：原来这里是**全表** `not.toContain("grid-template-columns")` ——
       它靠"整个 CSS 里没人用这个属性"才成立，属于过宽的绊线。本轮 diff 色块（`.diff-rows-fit`）
       正当使用了 `grid-template-columns`，把它撞红了。守卫的原意是"**坞**不许退回列轨方案"，
       所以改成**逐个查坞自己的规则块** —— 意图不变，且不再对无关特性误报。 */
    for (const sel of [".float-dock", ".dock-panel", ".dock-slot", ".dock-pill", ".dock-panel-card"]) {
      expect(rule(sel), `${sel} 又退回 grid-template-columns 轨道方案（列轨在非定宽容器里收不拢）`)
        .not.toContain("grid-template-columns");
    }
  });

  it("A-1079：收起态箭头的方向 = **朝上**（面板从上方浮出），展开后翻成朝下", () => {
    /* 用户原话：「未打开的时候，箭头应该是朝上的啊」。
       全仓约定 ChevronIcon 基准朝**右**（`open ? 90 : 0` = 收起朝右/展开朝下）；
       本坞是**向上**展开的，所以收起必须是 270°（朝上）。 */
    expect(DOCK, "「后台进程」胶囊的箭头方向退回默认（收起朝右，看不出是往上展开）").toContain("rotate={procsOpen ? 90 : 270}");
    expect(SUB_C, "子代理胶囊的箭头方向不对（收起时应朝上）").toContain("rotate={open ? 90 : 270}");
    for (const src of [DOCK, SUB_C]) {
      expect(src, "箭头方向退回 `open ? 90 : 0`（收起态朝右）").not.toMatch(/rotate=\{(procsOpen|open) \? 90 : 0\}/);
    }
  });

  it("A-1079：浮层用**实底**（半透明会让背后的正文透出来 —— 用户：「展开后界面透明度过高」）", () => {
    expect(rule(".dock-panel-card"), "面板卡片没用实底变量").toContain("var(--float-surface)");
    expect(rule(".dock-pill"), "胶囊没用实底变量").toContain("var(--float-surface)");
    /* 两套主题都必须给**不透明**的值：beta 的 `--card-surface` 是 0.82，
       直接拿它当浮层底会透出正文（正是用户截图里那条「背后的字能看见」的症状）。 */
    const decls = [...CSS.matchAll(/--float-surface:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls.length, "找不到 --float-surface 的声明（应两套主题各一条）").toBe(2);
    for (const v of decls) {
      expect(v, `--float-surface 不能是半透明（${v}）—— 浮层必须遮住背后内容`).not.toMatch(/rgba\(|hsla\(/);
    }
  });

  it("A-1126「两个按钮都常显，只让**面板**互斥」接了线：类名由单值派生，子代理不自持 open", () => {
    expect(DOCK, "坞格类名没从派生标志拼 → 展开态会出现两套说法")
      .toContain("dockSlotClassOf(procsOpen)");
    expect(PANEL_C, "坞的展开态不是单值 DockState → 会出现两个面板同时展开").toContain("useState<DockState>(null)");
    expect(PANEL_C, "还有独立的 procsOpen 状态 setter → 又变回两个真相源").not.toContain("setProcsOpen");
    expect(PANEL_C, "父级又给子代理传了 faded → 另一个按钮会随面板展开而消失（用户报的正是这个）").not.toContain("faded");
    expect(SUB_C, "子组件自己持有 open → 那就是第二个真相源（互斥必然漂移）").not.toContain("const [open, setOpen]");
    expect(SUB_C, "子代理没接收坞给的展开态").toContain("open: boolean");
  });

  it("⚠️ A-1126 按钮**常显**：两个按钮的渲染条件都与「另一个面板开着吗」无关", () => {
    /* 用户报的症状是"点了后台任务，旁边那个子代理按钮就没了"。两个成因都不允许回来：
       ① 坞格上挂渐隐类（由上面那条 CSS 断言挡住）；
       ② 按钮的**渲染条件**里混进坞状态（如 `!subsOpen && agentProcs?.any && (`，或
          `if (runs.length === 0 || open) return null;`）—— 那会在"另一个开着"时把按钮整个摘掉。
       ⇒ 判据：坞里不许出现 `<坞状态> &&` 形式的门；子代理的 null 出口只看 `runs.length`。 */
    expect(DOCK, "「后台进程」的渲染条件里混进了坞状态 → 另一个面板开着时它会消失")
      .not.toMatch(/!?\s*(procsOpen|subsOpen)\s*&&/);
    expect(SUB_C, "子代理按钮的 null 出口不再只看 runs.length → 加上别的条件就可能把按钮摘掉")
      .toContain("if (runs.length === 0) { return null; }");
  });

  it("「子代理从右侧监测栏移出」：监测栏里不再有它，坞里有它", () => {
    /* ⚠️ 窗口必须**限定在监测栏那一条内**：坞现在排在监测栏**上面**（A-1077），
       所以右界取监测栏之后的第一个兄弟（压缩过渡条），而不是坞。 */
    const bar = between(PANEL_C, 'className="context-tokens-num"', "{compressUi && (");
    expect(bar, "子代理按钮还在底部监测栏里 —— 用户要求移出").not.toContain("SubAgentExpandButton");
    expect(DOCK, "子代理没进坞 → 移出后就没了入口").toContain("<SubAgentExpandButton");
  });

  it("⚠️ A-1126：CSS 里**不许**再有 `.dock-slot.is-faded`（旧设定：另一个按钮整颗淡出）", () => {
    /* 曾经那条是 `.dock-slot.is-faded { opacity: 0; pointer-events: none; }` —— 用户报的
       「点击后台任务后，同行的子代理悬浮按钮会消失」就是它。用户裁决：「两个按钮都常显，
       只让面板互斥」。⇒ 规则与配套的过渡一并删除；这条守卫防止它被"顺手"加回来。
       ⚠️ 断言的是**选择器存在性**：`opacity: 0` 出现在别处（如 `:disabled`）不算违规。 */
    expect(CSS, "`.dock-slot.is-faded` 回来了 → 另一个按钮又会随面板展开而消失").not.toContain(".dock-slot.is-faded");
    expect(SUB_C, "子代理的胶囊又挂了 is-faded").not.toContain("is-faded");
    expect(PANEL_C, "「后台进程」的坞格又挂了 is-faded").not.toContain("is-faded");
  });

  it("两条路都走同一套类名（「同款悬浮按钮」不是两套长得像的样式）", () => {
    expect(rule(".dock-pill").length, "找不到 .dock-pill（悬浮按钮本体）").toBeGreaterThan(0);
    expect(SUB_C, "子代理的胶囊没用 .dock-pill").toContain('className="dock-pill"');
    expect(SUB_C, "子代理面板没用坞面板容器").toContain('className="dock-panel"');
    expect(SUB_C, "子代理还在用旧的 .pop 浮层（没换成同款坞面板）").not.toContain("pop pop-up");
  });
});
