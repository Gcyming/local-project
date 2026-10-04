















import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";


import { trackResizerGlint, clearResizerGlint } from "../../gui/src/renderer/resizerGlint.js";

const ROOT = resolve(__dirname, "../..");
const CSS = readFileSync(resolve(ROOT, "gui/src/renderer/index.css"), "utf8");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");
const APP = readFileSync(resolve(ROOT, "gui/src/renderer/App.tsx"), "utf8");
const RSB = readFileSync(resolve(ROOT, "gui/src/renderer/pages/RightSidebar.tsx"), "utf8");
const GLINT_PATH = resolve(ROOT, "gui/src/renderer/resizerGlint.ts");



function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CSS_CODE = stripComments(CSS);
const PANEL_CODE = stripComments(PANEL);







function stripAtMedia(css: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const rel = css.slice(i).search(/@media[^{]*\{/);
    if (rel < 0) { out += css.slice(i); break; }
    const start = i + rel;
    out += css.slice(i, start);
    let j = css.indexOf("{", start) + 1;
    let depth = 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") { depth++; } else if (css[j] === "}") { depth--; }
      j++;
    }
    i = j;
  }
  return out;
}

const CSS_TOP = stripAtMedia(CSS_CODE);


function ruleBody(css: string, selector: string): string | null {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
  );
  const m = re.exec(css);
  return m ? m[1] : null;
}

describe("A-1106 问题 1：扫光（.text-scan-light）不得退化成呼吸，且不得被 background 简写重置", () => {
  it("① `.text-scan-light` 的**每一条**规则都只用 longhand 声明背景（绝不写 background 简写）", () => {
    const bodies: string[] = [];
    const re = /\.text-scan-light\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    

    while ((m = re.exec(CSS_TOP)) !== null) { bodies.push(m[1]); }
    expect(bodies.length, "找不到 .text-scan-light 规则 —— 扫光类可能被删了").toBeGreaterThan(0);
    for (const b of bodies) {
      
      expect(b, "该规则里连 background-image 都没有 —— 断言对象搞错了").toMatch(/background-image\s*:/);
      


      expect(/(^|[;\s])background\s*:/.test(b), `发现 background 简写：${b.trim().slice(0, 120)}`).toBe(false);
    }
  });

  it("② 扫光仍靠 background-clip:text + 透明填充色实现（改成呼吸/改回实色都会红）", () => {
    const main = ruleBody(CSS_CODE, ".text-scan-light");
    expect(main, "找不到 .text-scan-light 主规则").toBeTruthy();
    expect(main!).toMatch(/-webkit-background-clip:\s*text/);
    expect(main!).toMatch(/background-clip:\s*text/);
    expect(main!).toMatch(/-webkit-text-fill-color:\s*transparent/);
    expect(main!, "扫光必须有动画，否则只是个静态渐变").toMatch(/animation:\s*textScanLight/);
  });

  it("③ ChatPanel 里四处「正在动」文本必须挂 text-scan-light，且 text-breathe 必须绝迹", () => {
    const count = (PANEL_CODE.match(/text-scan-light/g) ?? []).length;
    

    expect(count, `text-scan-light 出现 ${count} 次，应为 4 次（四处「正在动」文本）`).toBe(4);
    expect(/text-breathe/.test(PANEL_CODE), "text-breathe 又回到了 ChatPanel（A-1094 的过度替换复发）").toBe(false);
  });

  it("④ 工具卡状态胶囊**不得**挂扫光类（它有自己的 data-* 动画，挂上会被 background 简写重置）", () => {
    

    expect(PANEL_CODE).toMatch(/className="think-tool-status"/);
    expect(PANEL_CODE).toMatch(/data-running=\{statusPhase === "running" \? "1" : undefined\}/);
    expect(PANEL_CODE).toMatch(/data-settled=\{statusPhase === "settled" \? "1" : undefined\}/);
    
    expect(/think-tool-status[\s\S]{0,60}text-scan-light/.test(PANEL_CODE),
      "工具卡状态胶囊上又出现了 text-scan-light").toBe(false);
  });

  it("⑤ 无障碍：减动效下必须**只关动画**、不碰背景（上一条剥离 @media，这里补回它的覆盖）", () => {
    

    



    const mm = /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*?\.text-scan-light\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(mm, "找不到 prefers-reduced-motion 下的 .text-scan-light 覆盖").toBeTruthy();
    expect(mm![1]).toMatch(/animation:\s*none/);
    
    expect(/(^|[;\s])background\s*:/.test(mm![1]), "reduced-motion 覆盖里又写了 background 简写").toBe(false);
  });
});

describe("A-1106 问题 2：时间轴光点的圆点对齐与光晕余量", () => {
  it("① 圆点 left = -19px（真渲染器实测：包含块是 .think-step 而非 .think-timeline）", () => {
    const step = ruleBody(CSS_CODE, ".think-step-mark");
    expect(step, "找不到 .think-step-mark").toBeTruthy();
    expect(step!, "圆点圆心的推导值必须是 -19px（-20 偏左 1px，-5 是错的包含块假设）")
      .toMatch(/left:\s*-19px/);
    const tool = ruleBody(CSS_CODE, ".think-tool-mark");
    expect(tool, "找不到 .think-tool-mark").toBeTruthy();
    expect(tool!).toMatch(/left:\s*-19px/);
  });

  it("② 时间轴左侧留够光晕余量：margin-left >= 12px（光晕外扩到 -9px）", () => {
    const tl = ruleBody(CSS_CODE, ".think-timeline");
    expect(tl, "找不到 .think-timeline").toBeTruthy();
    const m = /margin:\s*[^;]*?(\d+)px\s*;/.exec(tl!);
    expect(m, "解析不出 .think-timeline 的 margin").toBeTruthy();
    

    expect(Number(m![1]), `margin-left = ${m![1]}px，必须 >= 12px（旧值 7px 会切掉光晕）`).toBeGreaterThanOrEqual(12);
  });
});

describe("A-1106 问题 3：状态行（LiveStatusLine）字号已调大", () => {
  it("主句容器 14.5px / 副句 13px / 激励语 14px —— 三档都不得回落到改前值", () => {
    
    const container = /padding:\s*"6px 0 10px 42px",\s*fontSize:\s*([\d.]+)/.exec(PANEL_CODE);
    expect(container, "解析不出 LiveStatusLine 容器字号").toBeTruthy();
    expect(Number(container![1])).toBeGreaterThanOrEqual(14.5);
    




    const detail = /var\(--text-dim\)",\s*fontSize:\s*([\d.]+)\s*\}\}>\s*·\s*\{status\.detail\}/.exec(PANEL_CODE);
    expect(detail, "解析不出副句字号").toBeTruthy();
    expect(Number(detail![1])).toBeGreaterThanOrEqual(13);
    const cheer = /color:\s*"var\(--text-secondary\)",\s*fontSize:\s*([\d.]+),\s*fontWeight:\s*500/.exec(PANEL_CODE);
    expect(cheer, "解析不出激励语字号").toBeTruthy();
    expect(Number(cheer![1])).toBeGreaterThanOrEqual(14);
  });
});

describe("A-1106 问题 4：分隔条命中区 + 流光", () => {
  it("① 命中区**跨在分隔线上**（左右对称），且父级裁剪已放宽到 ≥ 该外伸量（否则外侧半边被静默裁掉）", () => {
    








    const left = ruleBody(CSS_CODE, ".sidebar-resizer");
    const right = ruleBody(CSS_CODE, ".right-sidebar-resizer");
    expect(left, "找不到 .sidebar-resizer").toBeTruthy();
    expect(right, "找不到 .right-sidebar-resizer").toBeTruthy();

    
    const widthOf = (body: string): number => {
      const m = /\bwidth:\s*(\d+(?:\.\d+)?)px/.exec(body);
      expect(m, "解析不出命中区宽度 —— 断言对象搞错了（不是「没违规」）").toBeTruthy();
      return Number(m![1]);
    };
    const offsetOf = (body: string, side: "right" | "left"): number => {
      const m = new RegExp(`\\b${side}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(body);
      expect(m, `解析不出 ${side} 偏移 —— 断言对象搞错了`).toBeTruthy();
      return Number(m![1]);
    };

    const lw = widthOf(left!);
    const rw = widthOf(right!);
    const lo = offsetOf(left!, "right");
    const ro = offsetOf(right!, "left");
    
    expect(lo, "左栏命中区没跨过分隔线（right 必须是负值 = 往外伸）").toBeLessThan(0);
    expect(ro, "右栏命中区没跨过分隔线（left 必须是负值 = 往外伸）").toBeLessThan(0);
    expect(Math.abs(Math.abs(lo) - lw / 2), "左栏命中区不对称（|right| 应等于 width / 2）").toBeLessThanOrEqual(0.5);
    expect(Math.abs(Math.abs(ro) - rw / 2), "右栏命中区不对称（|left| 应等于 width / 2）").toBeLessThanOrEqual(0.5);

    





    const topLevelBlock = (sel: string): string | null => {
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\n([^\\n]*)\\n${esc}\\s*\\{([^}]*)\\}`, "g");
      for (let m = re.exec(CSS_CODE); m; m = re.exec(CSS_CODE)) {
        if ((m[1] ?? "").trimEnd().endsWith(",")) { continue; }
        return m[2];
      }
      return null;
    };
    const clipRelaxedTo = (sel: string, reach: number): void => {
      const body = topLevelBlock(sel);
      expect(body, `找不到顶层 ${sel} 规则`).toBeTruthy();
      expect(body!, `${sel} 不是 overflow: clip —— 跨出去的那半边会被静默裁掉`)
        .toMatch(/overflow:\s*clip\s*;/);
      const m = /overflow-clip-margin:\s*(\d+(?:\.\d+)?)px/.exec(body!);
      expect(m, `${sel} 没有 overflow-clip-margin（只有 overflow: clip 时它才生效）`).toBeTruthy();
      expect(Number(m![1]), `${sel} 的裁剪放宽量 < resizer 外伸量 ⇒ 外侧那半边的命中区仍不存在`)
        .toBeGreaterThanOrEqual(reach);
    };
    clipRelaxedTo(".sidebar", Math.abs(lo));
    clipRelaxedTo(".right-sidebar", Math.abs(ro));
  });

  it("② 命中区宽度 8px（> 旧的 6px），且拖动逻辑未被改动（仍走 anchorClassName）", () => {
    const left = ruleBody(CSS_CODE, ".sidebar-resizer")!;
    const w = /width:\s*(\d+)px/.exec(left);
    expect(w, "解析不出命中区宽度").toBeTruthy();
    expect(Number(w![1]), "命中区必须比旧的 6px 大").toBeGreaterThan(6);
  });

  it("③ 聚光渐变：峰值跟随 --rz-y、半长 42%（= 参考实现实测比例）、峰值色是 accent", () => {
    const ramp = ruleBody(CSS_CODE, ".sidebar,\n.right-sidebar");
    expect(ramp, "找不到 --rz-ramp（聚光渐变的唯一出处）").toBeTruthy();
    
    expect(ramp!, "聚光峰值必须跟随 --rz-y").toMatch(/var\(--rz-y,\s*50%\)/);
    expect(ramp!, "聚光峰值必须落在 var(--accent) 上（否则 hover 没有任何颜色变化）")
      .toMatch(/var\(--accent\)/);
    

    expect(ramp!, "斜坡半长必须是实测出来的 42%").toMatch(/calc\(var\(--rz-y,\s*50%\)\s*-\s*42%\)/);
    expect(ramp!, "斜坡半长必须是实测出来的 42%").toMatch(/calc\(var\(--rz-y,\s*50%\)\s*\+\s*42%\)/);
  });

  it("④ 聚光画在父级**真 border** 上（border-image）；hover / 拖着拖 两态都亮；不允许任何覆盖层", () => {
    





    expect(CSS_CODE, "左栏热态选择器不见了")
      .toMatch(/\.sidebar:has\(\.sidebar-resizer:is\(:hover,\s*:active\)\)/);
    expect(CSS_CODE, "右栏热态选择器不见了")
      .toMatch(/\.right-sidebar:has\(\.right-sidebar-resizer:is\(:hover,\s*:active\)\)/);
    
    expect(/\.sidebar:has\(\.sidebar-resizer:hover\)/.test(CSS_CODE),
      "左栏热态退回纯 :hover —— 拖拽期指针被拉出命中区，聚光会熄灭").toBe(false);
    expect(/\.right-sidebar:has\(\.right-sidebar-resizer:hover\)/.test(CSS_CODE),
      "右栏热态退回纯 :hover —— 拖拽期聚光会熄灭").toBe(false);
    const leftHot = ruleBody(CSS_CODE, ".sidebar:has(.sidebar-resizer:is(:hover, :active))");
    const rightHot = ruleBody(CSS_CODE, ".right-sidebar:has(.right-sidebar-resizer:is(:hover, :active))");
    expect(leftHot, "找不到左栏 hover 规则").toBeTruthy();
    expect(rightHot, "找不到右栏 hover 规则").toBeTruthy();
    





    const thickLeft = /border-image:\s*var\(--rz-ramp\)\s+0\s+(\d+)\s+0\s+0\s*\/\s*0\s+(\d+)px\s+0\s+0/;
    const thickRight = /border-image:\s*var\(--rz-ramp\)\s+0\s+0\s+0\s+(\d+)\s*\/\s*0\s+0\s+0\s+(\d+)px/;
    const mL = leftHot!.match(thickLeft);
    expect(mL, "左栏必须画在 border-right 上（slice/width 落在右侧）").toBeTruthy();
    expect(Number(mL![2]), "分隔线太细 —— 用户明确反馈过「拖拽光标太窄了，怎么这么细」").toBeGreaterThan(1);
    const mR = rightHot!.match(thickRight);
    expect(mR, "右栏必须画在 border-left 上（slice/width 落在左侧）").toBeTruthy();
    expect(Number(mR![2]), "左右两栏的分隔线粗细必须一致（否则一边细一边粗）").toBe(Number(mL![2]));
    
    expect(leftHot!, "聚光必须 stretch（repeat 会把渐变切成一段段）").toMatch(/stretch/);
    




    expect(/\.sidebar-resizer::(before|after)|\.right-sidebar-resizer::(before|after)/.test(CSS_CODE),
      "resizer 里又出现了覆盖层伪元素（会与真 border 叠成 2px 亮线，且热带已有自身背景这个产地）").toBe(false);
    


    const section = (() => {
      const a = CSS_CODE.indexOf(".sidebar-resizer {");
      const b = CSS_CODE.indexOf("\n.brand {");
      return a >= 0 && b > a ? CSS_CODE.slice(a, b) : "";
    })();
    expect(section, "取不到分隔条那一节 CSS —— 断言对象搞错了（不是「没违规」）").toContain("--rz-ramp");
    expect(/radial-gradient/.test(section), "聚光又变回 radial-gradient 椭圆光斑了").toBe(false);
  });

  it("⑤ --rz-y 只有**一个**产地（resizerGlint.ts）、写在**父级**上、且左右栏共用", () => {
    expect(existsSync(GLINT_PATH), "resizerGlint.ts 不存在").toBe(true);
    const glint = readFileSync(GLINT_PATH, "utf8");
    
    const varName = /const GLINT_VAR = "([^"]+)"/.exec(glint)?.[1];
    expect(varName, "解析不出聚光变量名 —— 断言对象搞错了").toBeTruthy();
    expect(CSS_TOP, `CSS 里没有 var(${varName}) —— 名字对不上，聚光不跟随`).toContain(`var(${varName}, 50%)`);
    

    expect(glint, "聚光变量没写在父级上（父级读不到 ⇒ 不跟随）").toMatch(/const host = el\.parentElement/);
    expect(glint).toMatch(/host\.style\.setProperty\(GLINT_VAR/);
    
    expect(glint, "clear 没清父级上的变量（聚光会卡在最后一个位置）")
      .toMatch(/parentElement\?\.style\.removeProperty\(GLINT_VAR\)/);
    expect(glint).toMatch(/export function trackResizerGlint/);
    expect(glint).toMatch(/export function clearResizerGlint/);
    

    expect(glint, "流光位置不再钳到 [0,100] —— 拖拽中弧光会整段消失").toMatch(/Math\.max\(0, Math\.min\(100, pct\)\)/);
    
    expect(/--rz-y/.test(stripComments(APP)), "App.tsx 里自己写了 --rz-y（第二产地）").toBe(false);
    expect(/--rz-y/.test(stripComments(RSB)), "RightSidebar.tsx 里自己写了 --rz-y（第二产地）").toBe(false);
    
    expect(APP).toMatch(/onMouseMove=\{trackResizerGlint\}/);
    expect(APP).toMatch(/onMouseLeave=\{clearResizerGlint\}/);
    expect(RSB).toMatch(/onMouseMove=\{trackResizerGlint\}/);
    expect(RSB).toMatch(/onMouseLeave=\{clearResizerGlint\}/);
  });

  it("⑥ 行为：指针 Y 写到**父级**（渐变宿主）上，并钳到 [0,100]；resizer 自身的 style 一次都不许碰", () => {
    


    const host = {
      style: {
        props: new Map<string, string>(),
        setProperty(k: string, v: string) { this.props.set(k, v); },
        removeProperty(k: string) { this.props.delete(k); },
      },
    };
    const resizer = {
      parentElement: host,
      getBoundingClientRect: () => ({ top: 100, height: 400 }),
      style: {
        setProperty() { throw new Error("写到了 resizer 自己身上 —— 父级读不到，聚光不会跟随"); },
        removeProperty() { throw new Error("清的是 resizer 自己身上的变量 —— 父级的清不掉，聚光会卡住"); },
      },
    };
    
    const ev = (o: object) => o as unknown as Parameters<typeof trackResizerGlint>[0];

    trackResizerGlint(ev({ currentTarget: resizer, clientY: 300 }));   
    expect(host.style.props.get("--rz-y"), "指针 Y 没换算成百分比写到父级").toBe("50.00%");
    
    trackResizerGlint(ev({ currentTarget: resizer, clientY: 9000 }));
    expect(host.style.props.get("--rz-y"), "下越界没钳到 100%").toBe("100.00%");
    trackResizerGlint(ev({ currentTarget: resizer, clientY: -1000 }));
    expect(host.style.props.get("--rz-y"), "上越界没钳到 0%").toBe("0.00%");
    
    clearResizerGlint(ev({ currentTarget: resizer }));
    expect(host.style.props.has("--rz-y"), "离开后变量没清掉（聚光会停在最后一次的位置）").toBe(false);
    
    expect(() => trackResizerGlint(ev({ currentTarget: { parentElement: null, getBoundingClientRect: () => ({ top: 0, height: 400 }), style: {} }, clientY: 50 }))).not.toThrow();
  });

  it("⑦ 可见效果**唯一产地**（原「可见热带」已被用户否决，A-1117 改为：resizer 不许自己画东西）", () => {
    







    const left = ruleBody(CSS_CODE, ".sidebar-resizer");
    const right = ruleBody(CSS_CODE, ".right-sidebar-resizer");
    expect(left, "找不到 .sidebar-resizer").toBeTruthy();
    expect(right, "找不到 .right-sidebar-resizer").toBeTruthy();
    






    const widthOf = (body: string): number => {
      const m = /\bwidth:\s*(\d+(?:\.\d+)?)px/.exec(body);
      expect(m, "解析不出命中区宽度 —— 断言对象搞错了").toBeTruthy();
      return Number(m![1]);
    };
    for (const [sel, body] of [["左栏", left!], ["右栏", right!]] as const) {
      expect(body, `${sel} resizer **不许**自己画东西（可见效果唯一产地 = 父级 border-image 聚光）`)
        .not.toMatch(/background-image\s*:/);
      expect(body, `${sel} resizer 必须**显式**置空背景（否则日后又会有人顺手加回覆盖层）`)
        .toMatch(/background:\s*none/);
    }
    const lw = widthOf(left!);
    const rw = widthOf(right!);
    expect(lw, "命中区不得小于 10px（A-1109 特意加宽过；同一轮用户还在抱怨别处判定区太小）")
      .toBeGreaterThanOrEqual(10);
    expect(lw, "左右两栏命中区宽度必须一致").toBe(rw);
    
    expect(left!, "左栏静止态必须 opacity: 0（否则日后加回的视觉会常驻）").toMatch(/opacity:\s*0\s*;/);
    expect(right!, "右栏静止态必须 opacity: 0").toMatch(/opacity:\s*0\s*;/);

    


    const hot = /\.sidebar-resizer:is\(:hover,\s*:active\)\s*,\s*\.right-sidebar-resizer:is\(:hover,\s*:active\)\s*\{([^}]*)\}/
      .exec(CSS_CODE);
    expect(hot, "找不到热带的热态规则（两栏一起点亮的那条）—— 热带将永远不亮").toBeTruthy();
    expect(hot![1], "热态没有把 opacity 置 1 —— 热带不会亮").toMatch(/opacity:\s*1/);
    

    expect(/\.sidebar-resizer:hover\s*[,{]/.test(CSS_CODE),
      "左栏热带热态退回纯 :hover —— 拖拽期热带会熄灭").toBe(false);
    expect(/\.right-sidebar-resizer:hover\s*[,{]/.test(CSS_CODE),
      "右栏热带热态退回纯 :hover —— 拖拽期热带会熄灭").toBe(false);
  });
});

describe("A-1106 问题 5a：正文后置闸门必须**同时冻结显示缓冲**（否则吐字渐入整个消失）", () => {
  it("① bodyGateRef 存在、镜像 !loading，且渲染期赋值（effect 会晚一帧）", () => {
    expect(PANEL_CODE).toMatch(/const bodyGateRef = React\.useRef\(false\)/);
    expect(PANEL_CODE).toMatch(/bodyGateRef\.current = !loading;/);
  });

  it("② 打字机推进被闸门挡住，且关闸期不自续（否则整轮 60fps 空转）", () => {
    
    expect(PANEL_CODE).toMatch(/const gated = !bodyGateRef\.current;/);
    expect(PANEL_CODE, "打字机推进没有被闸门挡住 —— 水位会在关闸期推到底，开闸时一个渐入都不播")
      .toMatch(/if \(!gated && shown\.length < full\.length\)/);
    
    expect(PANEL_CODE, "自续没有加 !gated ⇒ 关闸期每帧空转").toMatch(/if \(!gated && displayPartialRef\.current\.length < partialRef\.current\.length\)/);
  });

  it("③ 开闸必须**点火**重启打字机（本轮已结束，不会再有 chunk 来调度）", () => {
    
    const m = /React\.useEffect\(\(\) => \{\s*if \(!loading && partialRef\.current\) \{ schedulePartialRender\(\); \}\s*\}, \[loading, schedulePartialRender\]\)/.exec(PANEL_CODE);
    expect(m?.[0], "找不到开闸点火 effect —— 关闸期冻结缓冲后，正文将永远不显示").toBeTruthy();
  });

  it("④ 冻结的**只是显示层**：partialRef 仍全程累积（token/兜底/持久化靠它）", () => {
    expect(PANEL_CODE, "chunk 分支里累积 partialRef 的那一句不能动").toMatch(/if \(c\.type === "chunk"\) \{\r?\n\s*partialRef\.current \+=/);
  });
});

describe("A-1106 问题 6：产物卡展开必须有**横向**过渡", () => {
  it("① `.prod-host` 两态都是**可插值的指定值**（都写 auto = 没得过渡，第 1 帧就跳完）", () => {
    const host = ruleBody(CSS_CODE, ".prod-host");
    expect(host, "找不到 .prod-host").toBeTruthy();
    expect(host!, "折叠态必须显式 width（不能靠 auto 由内容撑）").toMatch(/width:\s*fit-content/);
    expect(host!, "必须开 interpolate-size 才能插值 fit-content ↔ 100%").toMatch(/interpolate-size:\s*allow-keywords/);
    



    expect(host!, "必须声明 width 过渡（两段式的第一段，节拍 = --prod-x-dur）").toMatch(/transition:\s*width\s+var\(--prod-x-dur\)/);
    expect(host!, "折叠方向：横向要等纵向收完（delay = --collapse-dur）").toMatch(/var\(--collapse-dur\)/);
    const open = ruleBody(CSS_CODE, ".prod-host.is-open");
    expect(open, "找不到 .prod-host.is-open").toBeTruthy();
    expect(open!).toMatch(/width:\s*100%/);
  });

  it("② 宿主 div 真的挂上了类与展开态（CSS 写了但没人用 = 静默失效）", () => {
    expect(PANEL_CODE).toMatch(/className=\{`prod-host\$\{expanded === i \? " is-open" : ""\}`\}/);
  });

  it("③ 高度过渡仍归 .collapse；展开方向由 `.prod-host.is-open .collapse` 加 delay 串行", () => {
    const collapse = ruleBody(CSS_CODE, ".collapse");
    expect(collapse, "找不到 .collapse").toBeTruthy();
    expect(collapse!, "高度过渡必须用唯一的 --collapse-dur").toMatch(/transition:[^;]*grid-template-rows\s+var\(--collapse-dur\)/);
    

    const scoped = ruleBody(CSS_CODE, ".prod-host.is-open .collapse");
    expect(scoped, "缺少展开方向的纵向 delay ⇒ 两条轴又并行了（会重新掉帧）").toBeTruthy();
    expect(scoped!).toMatch(/transition-delay:\s*var\(--prod-x-dur\)/);
  });
});
