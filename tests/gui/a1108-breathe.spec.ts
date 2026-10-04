


















































import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const CSS = readFileSync(resolve(ROOT, "gui/src/renderer/index.css"), "utf8");


function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CSS_CODE = stripComments(CSS);


function ruleBody(css: string, selector: string): string | null {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const m = re.exec(css);
  return m ? m[1] : null;
}

const RUN = '.think-tool-status[data-running="1"]';
const RUN_BEFORE = `${RUN}::before`;

describe("A-1108/1109：「执行中」呼吸灯", () => {
  it("G1 动画挂在**主规则**上（文字与底色同元素 ⇒ 天然同步）；底色由 ::before 提供；必须 isolation", () => {
    const main = ruleBody(CSS_CODE, RUN);
    expect(main, `找不到 ${RUN} 主规则 —— 断言对象搞错了`).toBeTruthy();
    

    expect(main!, "呼吸动画不在主规则上 —— 文字与底色分属两层，会重新出现「字不闪只有框闪」")
      .toMatch(/animation:\s*slime-status-breathe/);
    
    expect(main!, "运行态主规则的底色必须透明（光晕由 ::before 提供）").toMatch(/background-color:\s*transparent/);
    

    expect(main!, "运行态主规则里出现了 background 简写 —— 简写重置 longhand，且颜色一动就是主线程重绘")
      .not.toMatch(/(^|[;\s])background\s*:/);
    


    expect(main!, "缺 isolation: isolate —— 减少动效时（动画被关、opacity 恒 1）光晕会掉到按钮背景之下")
      .toMatch(/isolation:\s*isolate/);
  });

  it("G2 `::before` 是**盒子内**的光晕（inset 0 + border-radius inherit），且**自己不挂动画**", () => {
    const before = ruleBody(CSS_CODE, RUN_BEFORE);
    expect(before, `找不到 ${RUN_BEFORE} —— 呼吸灯的底色层不见了`).toBeTruthy();
    


    expect(before!, "光晕必须 inset: 0（溢出盒子就会被祖先 overflow:hidden 裁掉）").toMatch(/inset:\s*0\s*;/);
    expect(before!, "光晕必须继承圆角，否则呼吸时四角露出方角").toMatch(/border-radius:\s*inherit/);
    expect(before!, "缺 z-index: -1 —— 光晕会盖在文字上，字被糊掉").toMatch(/z-index:\s*-1\s*;/);
    
    expect(before!, "光晕没有背景色 —— 那它在画什么？").toMatch(/background-color\s*:/);
    




    expect(before!, "光晕底色是**全透明** —— 等于没画（reduced-motion 下胶囊会变成空白框格）")
      .not.toMatch(/background-color\s*:\s*transparent/);
    

    expect(before!, "::before 自己又挂了动画 —— 与主规则两个驱动源，字和框的呼吸会不同步")
      .not.toMatch(/animation\s*:/);
  });

  it("G3 关键帧**只动 opacity**（合成器属性）—— 这是频闪的结构性根因", () => {
    

    const kf = /@keyframes slime-status-breathe\s*\{([\s\S]*?)\n\}/.exec(CSS_CODE);
    expect(kf, "找不到 @keyframes slime-status-breathe").toBeTruthy();
    
    expect(kf![1], "抓到的 keyframes 里没有 50% 档 —— 断言对象搞错了").toContain("50%");
    const decls = [...kf![1].matchAll(/([a-zA-Z-]+)\s*:/g)].map((m) => m[1]);
    expect(decls.length, "关键帧里一条声明都没有 —— 断言对象搞错了").toBeGreaterThan(0);
    

    const bad = decls.filter((d) => d !== "opacity");
    expect(bad, `关键帧里出现了非合成器属性：${bad.join("、")}（会让动画每帧重绘 ⇒ 又变回频闪）`).toEqual([]);
  });

  it("G4 节拍与幅度：周期 ≥ 2s；峰 > 0.95（必须满亮）；0.5 ≤ 谷 ≤ 0.6（下界 = 文字可读）", () => {
    const main = ruleBody(CSS_CODE, RUN)!;
    const dur = /animation:\s*slime-status-breathe\s+([\d.]+)s/.exec(main);
    expect(dur, "解析不出呼吸周期").toBeTruthy();
    
    expect(Number(dur![1]), `周期 ${dur![1]}s 太快 —— 快而浅的脉动正是"频闪"观感`).toBeGreaterThanOrEqual(2);
    
    const kf = /@keyframes slime-status-breathe\s*\{([\s\S]*?)\n\}/.exec(CSS_CODE)![1];
    const vals = [...kf.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(vals.length, "关键帧里没有 opacity 档位").toBeGreaterThanOrEqual(2);
    


    expect(Math.max(...vals), "峰值没到满亮（>0.95）—— 浅而快的脉动正是「频闪/没在动」的观感")
      .toBeGreaterThan(0.95);
    const min = Math.min(...vals);
    
    expect(min, "谷值太亮（>0.6）—— 幅度不够，看起来就是「一直在那儿」，没有呼吸感").toBeLessThanOrEqual(0.6);
    


    expect(min, "谷值太低（<0.5）—— 动画现在动的是**文字**那一层，太暗会让文字在谷相位读不清")
      .toBeGreaterThanOrEqual(0.5);
  });

  it("G5 减少动效的覆盖**跟着动画一起搬回主规则**（否则无障碍回退静默失效）", () => {
    


    




    const mm = /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*?(\.think-tool-status\[data-running="1"\][^{]*?)\{([^}]*)\}/.exec(CSS_CODE);
    expect(mm, "找不到 prefers-reduced-motion 下打在**主规则**上的覆盖 —— 动画搬家了，覆盖没跟着搬").toBeTruthy();
    expect(mm![2], "覆盖里没有 `animation: none`").toMatch(/animation:\s*none/);
    



    expect(mm![1], "覆盖的选择器里带了 ::before —— 动画不在那一层，等于没有覆盖").not.toMatch(/::before/);
  });

  it("G6 反面：伪元素不许加 `box-shadow` 光晕（会被祖先 overflow: hidden 裁掉右半边）", () => {
    const before = ruleBody(CSS_CODE, RUN_BEFORE);
    expect(before, "找不到 ::before —— 断言对象搞错了").toBeTruthy();
    

    expect(before!, "::before 上又出现了 box-shadow —— 画到盒子外会被祖先 overflow:hidden 裁掉")
      .not.toMatch(/box-shadow\s*:/);
  });

  it("G7 文字不许用透明填充色（防 A-1094「文字全透明 = 空白框格」重演）", () => {
    const main = ruleBody(CSS_CODE, RUN)!;
    const before = ruleBody(CSS_CODE, RUN_BEFORE)!;
    expect(main, "运行态主规则没有给文字实体颜色").toMatch(/color:\s*var\(--accent\)/);
    



    for (const [tag, body] of [["主规则", main], ["::before", before]] as const) {
      expect(/-webkit-text-fill-color\s*:\s*transparent/.test(body), `${tag} 里出现了透明文字填充色`).toBe(false);
    }
    


    expect(/(^|[;\s{])color\s*:\s*transparent/.test(main), "运行态文字色被设成 transparent —— 会变成空白框格").toBe(false);
  });
});
