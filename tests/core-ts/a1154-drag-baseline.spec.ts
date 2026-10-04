























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const APP_SRC = read("gui/src/renderer/App.tsx");
const CSS_SRC = read("gui/src/renderer/index.css");
const APP_CODE = strip(APP_SRC);
const CSS_CODE = strip(CSS_SRC);


function fnBody(src: string, name: string): string {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^]*?\\n  \\}`).exec(src);
  expect(m, `取不到 ${name}（守卫自己失效了）`).toBeTruthy();
  return m![0];
}

describe("A-1154 ① 拖拽基准必须取 **DOM 实测宽度**（否则第 1 轮拖动无响应）", () => {
  it("`handleRightbarResize`：`startWidth` 来自 `getBoundingClientRect()`，**不是** `rightWidthRef`", () => {
    const body = fnBody(APP_CODE, "handleRightbarResize");
    
    expect(
      /const\s+startWidth\s*=[^;]*getBoundingClientRect/.test(body),
      "`startWidth` 没取 DOM 实测宽 ⇒ 与实宽错位时拖动基准错（真机实测：第 1 轮 712→712 完全无响应）",
    ).toBe(true);
    


    expect(
      /const\s+startWidth\s*=\s*rightWidthRef\.current\s*;/.test(body),
      "`startWidth` 又回落成 state（请求值）—— 这正是被修的旧写法",
    ).toBe(false);
  });

  it("`handleSidebarResize`：同样取实测宽（`.sidebar` 有 max/min-width，也会错位）", () => {
    const body = fnBody(APP_CODE, "handleSidebarResize");
    expect(
      /const\s+startWidth\s*=[^;]*getBoundingClientRect/.test(body),
      "左栏 `startWidth` 没取 DOM 实测宽（`.sidebar` 有 max-width:520/min-width:240 ⇒ 同样会错位）",
    ).toBe(true);
    expect(
      /const\s+startWidth\s*=\s*sidebarWidthRef\.current\s*;/.test(body),
      "左栏 `startWidth` 又回落成 state",
    ).toBe(false);
  });

  it("落 state / localStorage 前必须 `Math.round`（实测宽是浮点，别把 286.375 写进持久层）", () => {
    





    




    {
      const rBody = fnBody(APP_CODE, "handleRightbarResize");
      expect(
        /\bw\s*=\s*Math\.round\(w\)/.test(rBody),
        "右栏 onUp 落盘前没 `w = Math.round(w)` ⇒ 实测浮点宽被写进 state/localStorage",
      ).toBe(true);
      const lBody = fnBody(APP_CODE, "handleSidebarResize");
      expect(
        /const\s+w\s*=\s*Math\.round\(/.test(lBody),
        "左栏 onUp 落盘前没把宽 round 到整数",
      ).toBe(true);
    }
    for (const fn of ["handleSidebarResize", "handleRightbarResize"]) {
      const body = fnBody(APP_CODE, fn);
      

      expect(
        /set(?:Sidebar|Right)Width\(Math\.round\(/.test(body),
        `${fn} 的 onCancel 路径没把实测浮点 round 就 setState`,
      ).toBe(true);
      expect(
        /localStorage\.setItem\('slime_(?:sidebar|rightbar)_w', String\([^)]*\)\)/.test(body),
        `${fn} 没有落 localStorage（守卫自己失效了）`,
      ).toBe(true);
      

      const setItemIdx = body.indexOf("localStorage.setItem('slime_");
      const seg = body.slice(Math.max(0, setItemIdx - 700), setItemIdx + 80);
      expect(
        /Math\.round\(/.test(seg),
        `${fn} 里写进 localStorage 的那个宽度没经过 Math.round（浮点污染持久层）`,
      ).toBe(true);
    }
  });
});

describe("A-1154 ② 持久化 px 宽度在窗口变化时**必须收敛到合法区间**", () => {
  it("存在一个监听 `resize` 且把 `rightWidth` 钳进 `[minW, maxW]` 的 effect", () => {
    


    
    const start = APP_CODE.indexOf("if (!rightCustom) { return; }");
    expect(
      start,
      "找不到「rightCustom 为假就跳过」的钳制 effect 开头 ⇒ 窗口变化时持久化 px 宽度不收敛（不再自适应）",
    ).toBeGreaterThan(-1);
    
    const endMark = APP_CODE.indexOf('window.removeEventListener("resize"', start);
    expect(endMark, "钳制 effect 没有收尾（守卫自己失效了）").toBeGreaterThan(start);
    const region = APP_CODE.slice(start, endMark);
    expect(region, "钳制区里没有监听 resize").toMatch(/window\.addEventListener\("resize"/);
    expect(region, "钳制区里没有 rightSidebarMinW()").toMatch(/rightSidebarMinW\(\)/);
    expect(region, "钳制区里没有 rightSidebarMaxW()").toMatch(/rightSidebarMaxW\(\)/);
    expect(region, "钳制结果没有回写 setRightWidth（钳了但没生效）").toMatch(/setRightWidth\(/);
  });
});

describe("A-1154 ③ `slime-dragging` 必须一次性给全「拖动期语义」", () => {
  it("CSS：挂着 `slime-dragging` 时禁文本选中 + 定住 col-resize 光标", () => {
    


    const m = /(^|\n)body\.slime-dragging\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到 `body.slime-dragging { … }` 这条规则").toBeTruthy();
    const rule = m![2];
    expect(rule, "拖动期没禁文本选中 ⇒ 拖动头 140ms 会拖出选区（闪烁杂讯）").toMatch(/user-select:\s*none/);
    expect(rule, "拖动期没定住 col-resize 光标 ⇒ 光标在拖动中跳变").toMatch(/cursor:\s*col-resize/);
  });

  it("既有的「只禁侧栏宽度过渡」那条规则仍在（别为了加语义把它改坏）", () => {
    const m = /body\.slime-dragging\s+\.sidebar,\s*body\.slime-dragging\s+\.right-sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "slime-dragging 的侧栏宽度规则不见了").toBeTruthy();
    expect(m![1]).toMatch(/transition:\s*none/);
    expect(m![1], "这条规则里不许出现 .chat-scroll（会连淡出一起关掉）").not.toMatch(/chat-scroll/);
  });
});

describe("A-1162 几何 done 必定有界（`u >= 1` 取代「等对象挂载」的帧数等待）", () => {
  it("收工判据含 `u >= 1`（对象从未挂载也必然收工）", () => {
    






    const body = fnBody(APP_CODE, "runGeometrySyncFade");
    expect(
      /const\s+done\s*=\s*[^;]*u\s*>=\s*1/.test(body),
      "done 里没有 `u >= 1` ⇒ 对象从未挂载时 rAF 可能死循环、临时类永久残留",
    ).toBe(true);
    
    expect(
      !/neverMount/.test(body),
      "neverMount 帧数等待又回来了 ⇒ 收工时刻重新依赖帧率",
    ).toBe(true);
  });

  it("`runGeometrySyncFade` 的 done 分支里**同时**摘 `slime-freezing` 与 `--slime-freeze-w`", () => {
    const body = fnBody(APP_CODE, "startFloatGeometryFade");
    

    expect(body, "几何 done 没摘 slime-freezing").toMatch(/classList\.remove\("slime-freezing"\)/);
    expect(body, "几何 done 没摘 --slime-freeze-w（成对写/摘）").toMatch(/removeProperty\("--slime-freeze-w"\)/);
  });
});

describe("A-1154 ⑤ 淡出阶段定时器必须可取消且到点校验（防「松手后才挂类」）", () => {
  it("⚠️ A-1190：阶段定时器**只有一个产地**（`mark()`），两个 resizer 起点都不再起它", () => {
    




    const at = APP_CODE.indexOf("const mark =");
    expect(at, "找不到 RO 的 mark 处理").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 2600);
    expect(
      /dragPhaseTimerRef\.current\s*=\s*window\.setTimeout/.test(seg),
      "mark() 的阶段定时器没存句柄 ⇒ 松手后它才到点、把 slime-resizing 挂上且没人摘（闪烁 + 残留隐藏）",
    ).toBe(true);
    expect(
      /!document\.body\.classList\.contains\("slime-fading"\)\s*\)\s*\{\s*return/.test(seg),
      "mark() 的阶段定时器没有「本轮已结束则作废」的校验",
    ).toBe(true);
    
    for (const fn of ["handleSidebarResize", "handleRightbarResize"]) {
      const fnAt = APP_CODE.indexOf(`function ${fn}`);
      expect(fnAt, `找不到 ${fn}`).toBeGreaterThan(-1);
      const head = APP_CODE.slice(fnAt, fnAt + 1600);
      expect(
        /dragPhaseTimerRef\.current\s*=\s*window\.setTimeout/.test(head),
        `${fn} 的起点又自己起了阶段定时器（A-1190 已把它收敛到 mark()）`,
      ).toBe(false);
    }
  });

  it("`endChatFreeze` 会取消那条阶段定时器（三条结束路径共用它）", () => {
    const body = fnBody(APP_CODE, "endChatFreeze");
    expect(
      /clearTimeout\(dragPhaseTimerRef\.current\)/.test(body),
      "endChatFreeze 没清阶段定时器 ⇒ 短促拖拽松手后它才挂 slime-resizing（闪烁）",
    ).toBe(true);
  });
});
