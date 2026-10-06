



















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const CSS = readFileSync(resolve(ROOT, "gui/src/renderer/index.css"), "utf8");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");




function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CSS_CODE = stripComments(CSS);






function topRuleBody(sel: string): string | null {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, "m").exec(CSS_CODE);
  return m ? m[1] : null;
}


function alphaOf(decl: string, ctx: string): number {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:[,/]\s*([\d.]+)\s*)?\)/.exec(decl);
  expect(m, `${ctx}：解析不出颜色（拿到的是「${decl.trim().slice(0, 80)}」）—— 断言对象搞错了（不是「没违规」）`).toBeTruthy();
  return m![4] === undefined ? 1 : Number(m![4]);
}


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
    
    expect(Number(w![1]), `滚动条 ${w![1]}px —— 超过 8px 就不叫细条了`).toBeLessThanOrEqual(8);
    expect(Number(w![1]), "滚动条宽度必须 > 0").toBeGreaterThan(0);
  });

  it("③ 轨道透明：不许有可见凹槽（有底色 = 不是「悬浮」在内容之上）", () => {
    const body = topRuleBody(TRACK);
    expect(body, "找不到顶层 ::-webkit-scrollbar-track 规则 —— 轨道样式可能被删了").toBeTruthy();
    
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
    
    expect(aRest, `滑块静止态 α = ${aRest} —— 不是半透明`).toBeGreaterThan(0);
    expect(aRest, `滑块静止态 α = ${aRest} —— 不透明就不叫「静止半透明」了`).toBeLessThan(1);
    
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
    
    expect(/\.chat-scroll\s*::-webkit-scrollbar/.test(CSS_CODE),
      "`.chat-scroll::-webkit-scrollbar*` 又出现了 —— 第二个产地，全局几何一改聊天区就漂移").toBe(false);
    
    const m = /^\.chat-scroll\s*\{([^}]*)\}/m.exec(CSS_CODE);
    if (m) {
      /* ⚠️ A-1197：判据只认「滚动条**外观**」声明（CSS_CODE 已剥注释；stripComments 幂等防御）：
         · 命中 = `::-webkit-scrollbar*` 伪元素 / `scrollbar-width:` / `scrollbar-color:`；
         · 放行 = `scrollbar-gutter:`（A-1161 的**布局**属性——预留槽位防窗口化抖动；误删会让边界抖）。
         历史假红：A-1161 加入 `scrollbar-gutter: stable` 后，老判据 `/scrollbar/i` 整块命中
         这条**正当布局声明** ⇒ 自 09-30 起守卫一直红（实测归因：不是注释，是声明本身）。 */
      const body = stripComments(m[1]);
      const bad = /::\s*-webkit-scrollbar|scrollbar-(width|color)\s*:/i.exec(body);
      expect(bad, `\`.chat-scroll { … }\` 里又有滚动条外观声明了：${bad?.[0] ?? ""}`).toBeNull();
    }
    



    expect(PANEL, "聊天滚动容器没挂 chat-scroll（滚动条样式将无处生效）")
      .toMatch(/className="[^"]*\bchat-scroll\b[^"]*"/);
  });

  it("⑧ 全局禁用 `scrollbar-color` / `scrollbar-width`：Chromium 121+ 下它们会让自定义滚动条整块失效", () => {
    


    expect(/(^|[;{\s])scrollbar-color\s*:/.test(CSS_CODE),
      "本文件出现了 `scrollbar-color` —— 声明它的那个元素的自定义滚动条会被整块忽略（静默回落平台默认样式）").toBe(false);
    



    const RE_WIDTH = /scrollbar-width\s*:(?!\s*none\b)/;
    
    expect(RE_WIDTH.test("a{scrollbar-width: none;}"), "none 是**唯一允许**的取值，不许报红").toBe(false);
    expect(RE_WIDTH.test("a{scrollbar-width:none;}"), "紧凑写法同样允许").toBe(false);
    expect(RE_WIDTH.test("a{scrollbar-width: none ;}"), "none 后可有空白/分号").toBe(false);
    expect(RE_WIDTH.test("a{scrollbar-width:thin;}"), "非 none 必须报红").toBe(true);
    expect(RE_WIDTH.test("a{scrollbar-width:  thin;}"), "多个空格的非 none 同样要报红").toBe(true);
    expect(RE_WIDTH.test(CSS_CODE),
      "本文件出现了 `scrollbar-width: <非 none>` —— 会让自定义滚动条整块失效（`none` 是唯一允许的取值）").toBe(false);
  });
});
