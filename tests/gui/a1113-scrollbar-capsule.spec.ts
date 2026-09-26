/**
 * tests/gui/a1113-scrollbar-capsule.spec.ts — A-1113 滚动条修复（用户点名需求 #304，
 * 答复原文：「按悬浮细胶囊做」—— 轨道透明、6px 全圆角天蓝滑块、静止半透明、hover 加深）的静态守卫。
 *
 * ## 为什么这条需求属于「静默失效」家族（过 tsc、过构建、过所有逻辑测试，只在用户眼里翻车）
 *
 * 本轮实测发现了一个**从未被发现**的真缺陷：
 * `.chat-scroll` 同时写了 `scrollbar-color`（标准属性）与 `::-webkit-scrollbar-thumb`（自定义属性）。
 * Chromium 121+ 起**标准属性优先** ⇒ 该元素的 `::-webkit-scrollbar-*` 被整块忽略
 * （连全局那条宽度一起）⇒ 聊天区滚动条实际是**平台默认样式**（Windows ≈15–17px 宽），
 * 而本文件里那两条 webkit 规则是**从未生效的死代码**。
 * `scrollbar-color` 的那条注释写的是「给 Firefox」——意图没错，但在 Electron（恒 Chromium）
 * 里它的副作用是**把自定义滚动条整块关掉**。这种"写法看着完全合理、效果静默归零"的形态，
 * 正是本仓反复归档的那一类；所以这条需求必须有守卫，而不是"改完截图看一眼"。
 *
 * ⚠️ 本 spec 只读**落盘原文**。几何/观感类判断（真的画出来多宽、hover 有没有变化）
 *    只能由 `gui/scripts` 的探针在**真渲染器**里量，不在这里假装能算 —— 见 A-1105 铁律。
 *    本文件锁的是**关系**（轨道透明 · 全圆角 · 静止 α 严格介于 0 与 1 · hover α 严格大于静止 α ·
 *    只有一个产地），不锁那些会随微调变化的具体数值。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const CSS = readFileSync(resolve(ROOT, "gui/src/renderer/index.css"), "utf8");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");

/** 剥注释：注释里写着"曾经是什么"与用户原话，不该被当成当前代码断言。
 *  ⚠️ 不做这一步，本文件头部那些写着 `scrollbar-color` 的说明自己就会把负面断言喂绿
 *     （本仓 §24「判据被兜住」家族）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CSS_CODE = stripComments(CSS);

/** 取**顶层**规则的规则体：选择器必须落在行首（`^` + `m`）。
 *
 *  ⚠️ 为什么不能复用 a1106 那种不锚行首的 `ruleBody`：`::-webkit-scrollbar-thumb {` 是
 *  `.ghost-dropdown::-webkit-scrollbar-thumb {` 的**子串**，不锚行首会抓到后者 ——
 *  断言对象搞错，而报错文本却像是"没违规"（本仓 §「断言对象搞错」家族，a1106 里踩过同款）。 */
function topRuleBody(sel: string): string | null {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, "m").exec(CSS_CODE);
  return m ? m[1] : null;
}

/** 从声明里解析 rgba() 的透明度：三通道无 alpha 时按 1。解析不出来 → 直接红（不静默跳过）。 */
function alphaOf(decl: string, ctx: string): number {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:[,/]\s*([\d.]+)\s*)?\)/.exec(decl);
  expect(m, `${ctx}：解析不出颜色（拿到的是「${decl.trim().slice(0, 80)}」）—— 断言对象搞错了（不是「没违规」）`).toBeTruthy();
  return m![4] === undefined ? 1 : Number(m![4]);
}

/** 从声明里解析 RGB 三通道。 */
function rgbOf(decl: string, ctx: string): [number, number, number] {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(decl);
  expect(m, `${ctx}：解析不出颜色 —— 断言对象搞错了`).toBeTruthy();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

const THUMB = "::-webkit-scrollbar-thumb";
const THUMB_HOVER = "::-webkit-scrollbar-thumb:hover";
const TRACK = "::-webkit-scrollbar-track";
const BAR = "::-webkit-scrollbar";

describe("A-1113 滚动条：悬浮细胶囊（用户答复「按悬浮细胶囊做」）", () => {
  it("① 全应用只有**一份** `::-webkit-scrollbar` 定义（第二份产地 = 几何一改就漂移）", () => {
    /* 计数型断言：写成 `>= 1` 就等于没守 —— 多写一份照样绿。
       ⚠️ 本仓纪律：计数型断言必须配变异（`mut-a1113` 的 M1 就是"再插一份全局定义"）。 */
    const n = (CSS_CODE.match(/^::-webkit-scrollbar\s*\{/gm) ?? []).length;
    expect(n, `顶层有 ${n} 份 ::-webkit-scrollbar 定义，应恰好 1 份`).toBe(1);
  });

  it("② 全局条是「细」的：width === height 且 ≤ 8px（Windows 平台默认 ≈15–17px = 用户说的「样式不对」）", () => {
    const body = topRuleBody(BAR);
    expect(body, "找不到顶层 ::-webkit-scrollbar 规则").toBeTruthy();
    const w = /width:\s*(\d+(?:\.\d+)?)px/.exec(body!);
    const h = /height:\s*(\d+(?:\.\d+)?)px/.exec(body!);
    expect(w, "解析不出 ::-webkit-scrollbar 的 width —— 断言对象搞错了").toBeTruthy();
    expect(h, "解析不出 ::-webkit-scrollbar 的 height（横条也要细，否则同一条需求只做了一半）").toBeTruthy();
    expect(Number(w![1]), "纵横两个方向必须等粗（否则横条比竖条胖，观感不一致）").toBe(Number(h![1]));
    /* 8px 是"细"的上界（≈平台默认 15px 的一半）。超了就不是细条，退回用户抱怨的那种胖条。 */
    expect(Number(w![1]), `滚动条 ${w![1]}px —— 超过 8px 就不叫细条了`).toBeLessThanOrEqual(8);
    expect(Number(w![1]), "滚动条宽度必须 > 0").toBeGreaterThan(0);
  });

  it("③ 轨道透明：不许有可见凹槽（有底色 = 不是「悬浮」在内容之上）", () => {
    const body = topRuleBody(TRACK);
    expect(body, "找不到顶层 ::-webkit-scrollbar-track 规则 —— 轨道样式可能被删了").toBeTruthy();
    /* 只认 transparent / none。`rgba(0,0,0,0)` 之类也算透明，但本仓统一写 transparent。 */
    expect(body!, `轨道底色不是透明的（拿到「${body!.trim().slice(0, 60)}」）—— 会出现一条可见凹槽`)
      .toMatch(/background\s*:\s*(transparent|none)\b/);
  });

  it("④ 滑块是**全圆角胶囊**：border-radius ≥ 可见宽度 / 2（直角条 = 形状没做对）", () => {
    const bar = topRuleBody(BAR)!;
    const w = Number(/width:\s*(\d+(?:\.\d+)?)px/.exec(bar)![1]);
    const thumb = topRuleBody(THUMB);
    expect(thumb, "找不到顶层 ::-webkit-scrollbar-thumb 规则 —— 滑块样式可能被删了").toBeTruthy();
    const r = /border-radius:\s*(\d+(?:\.\d+)?)px/.exec(thumb!);
    expect(r, "解析不出滑块的 border-radius —— 断言对象搞错了").toBeTruthy();
    /* 关系式判据：圆角 ≥ 半宽 ⇒ 两端必是半圆 ⇒ 胶囊。锁字面量 999px 会在微调时误报。 */
    expect(Number(r![1]), `border-radius = ${r![1]}px < 宽度一半 ${w / 2}px —— 滑块两端不是圆的，不是胶囊`)
      .toBeGreaterThanOrEqual(w / 2);
  });

  it("⑤ 静止半透明 + hover 加深（两件事都要：`α静止 ∈ (0,1)` 且 `αhover > α静止`）", () => {
    const rest = topRuleBody(THUMB);
    const hover = topRuleBody(THUMB_HOVER);
    expect(rest, "找不到滑块静止态规则").toBeTruthy();
    expect(hover, "找不到滑块 hover 态规则 —— hover 加深没了").toBeTruthy();
    const aRest = alphaOf(rest!, "滑块静止态");
    const aHover = alphaOf(hover!, "滑块 hover 态");
    /* 严格半透明：改成 1（不透明）会红；改成 0（看不见）也会红。 */
    expect(aRest, `滑块静止态 α = ${aRest} —— 不是半透明`).toBeGreaterThan(0);
    expect(aRest, `滑块静止态 α = ${aRest} —— 不透明就不叫「静止半透明」了`).toBeLessThan(1);
    /* 严格加深：相等（写成同一档色）会红 —— 那是"hover 没有反馈"这个静默失效。 */
    expect(aHover, `hover α = ${aHover} 未大于静止 α = ${aRest} —— hover 不加深（用户感知不到可拖动）`)
      .toBeGreaterThan(aRest);
  });

  it("⑥ 颜色仍是天蓝（蓝通道最大）：退回深灰/变红都会红 —— 那正是用户原始投诉的「样式不对」", () => {
    for (const [sel, ctx] of [[THUMB, "滑块静止态"], [THUMB_HOVER, "滑块 hover 态"]] as const) {
      const body = topRuleBody(sel);
      expect(body, `找不到顶层 ${sel} 规则`).toBeTruthy();
      const [r, g, b] = rgbOf(body!, ctx);
      expect(b, `${ctx} 的蓝通道 ${b} 不是最大通道 (${r},${g},${b}) —— 已不是天蓝`).toBeGreaterThan(r);
      expect(b, `${ctx} 的蓝通道 ${b} 不是最大通道 (${r},${g},${b})`).toBeGreaterThan(g);
    }
  });

  it("⑦ 唯一产地：`.chat-scroll` 不得再自带**任何**滚动条样式（它现在与全局逐像素同款）", () => {
    /* 反面①：伪元素覆盖（历史形态）。 */
    expect(/\.chat-scroll\s*::-webkit-scrollbar/.test(CSS_CODE),
      "`.chat-scroll::-webkit-scrollbar*` 又出现了 —— 第二个产地，全局几何一改聊天区就漂移").toBe(false);
    /* 反面②：规则体里任何 scrollbar 声明（历史形态是 `scrollbar-color`，见下一条）。 */
    const m = /^\.chat-scroll\s*\{([^}]*)\}/m.exec(CSS_CODE);
    if (m) {
      expect(/scrollbar/i.test(m[1]),
        `\`.chat-scroll { … }\` 里又有滚动条声明了：${m[1].trim().slice(0, 80)}`).toBe(false);
    }
    /* 宿主仍在：类名从 ChatPanel 上掉下去 ⇒ 上面那些判据守的是没人用的选择器（静默失效）。
       ⚠️ A-1115 迁移：断言从"完整属性串"放宽为"类名列表里含 chat-scroll"——
       容器现在同时挂 `chat-scroll` 与 `rail-host`（目录卷轴的隐藏原生滚动条），
       原先那种 `className="chat-scroll"` 全等写法会把**合法新增**判成故障。意图不变：类名必须在。 */
    expect(PANEL, "聊天滚动容器没挂 chat-scroll（滚动条样式将无处生效）")
      .toMatch(/className="[^"]*\bchat-scroll\b[^"]*"/);
  });

  it("⑧ 全局禁用 `scrollbar-color` / `scrollbar-width`：Chromium 121+ 下它们会让自定义滚动条整块失效", () => {
    /* 这条是本轮真缺陷的**根因守卫**，而不是"顺手加的一条规范"：
       标准属性优先 ⇒ 写了它们的那个元素，`::-webkit-scrollbar-*` 全部被忽略，
       自定义细胶囊**静默**回落到平台默认样式（Windows ≈15–17px 宽）。没有任何门禁会红。 */
    expect(/(^|[;{\s])scrollbar-color\s*:/.test(CSS_CODE),
      "本文件出现了 `scrollbar-color` —— 声明它的那个元素的自定义滚动条会被整块忽略（静默回落平台默认样式）").toBe(false);
    /* ⚠️ 这里必须写成 `(?!\s*none\b)` 而**不是** `\s*(?!none\b)`：
       后者跟在可回溯的 `\s*` 后面，正则引擎总能"少吞一个空格"让前瞻看到 ` none` 而通过，
       于是把**合法值** `scrollbar-width: none` 判成违规 —— A-1115 加 `.rail-host{scrollbar-width:none}`
       时这条守卫就是这么**假红**的。把空白吃进前瞻里，回溯就没有意义了。 */
    const RE_WIDTH = /scrollbar-width\s*:(?!\s*none\b)/;
    /* 检测器自检：喂已知正/负样本，确认它的判断力本身没问题（否则又是一条"看起来在守"的假守卫） */
    expect(RE_WIDTH.test("a{scrollbar-width: none;}"), "none 是**唯一允许**的取值，不许报红").toBe(false);
    expect(RE_WIDTH.test("a{scrollbar-width:none;}"), "紧凑写法同样允许").toBe(false);
    expect(RE_WIDTH.test("a{scrollbar-width: none ;}"), "none 后可有空白/分号").toBe(false);
    expect(RE_WIDTH.test("a{scrollbar-width:thin;}"), "非 none 必须报红").toBe(true);
    expect(RE_WIDTH.test("a{scrollbar-width:  thin;}"), "多个空格的非 none 同样要报红").toBe(true);
    expect(RE_WIDTH.test(CSS_CODE),
      "本文件出现了 `scrollbar-width: <非 none>` —— 会让自定义滚动条整块失效（`none` 是唯一允许的取值）").toBe(false);
  });
});
