
























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const APP_CODE = strip(read("gui/src/renderer/App.tsx"));


function fnBody(src: string, name: string): string {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^]*?\\n  \\}`).exec(src);
  expect(m, `取不到 ${name}（守卫自己失效了）`).toBeTruthy();
  return m![0];
}


function count(src: string, needle: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const k = src.indexOf(needle, i);
    if (k < 0) { return n; }
    n++;
    i = k + needle.length;
  }
}

describe("A-1155 ① 退浮层（`dismissFloat`）必须**无条件**摘掉展开支挂上的全部过渡期状态", () => {
  




  it("起点清理：`setRightMin0(false)` + 摘 `--right-body-pin` / `--right-target-w`", () => {
    const body = fnBody(APP_CODE, "dismissFloat");
    
    expect(
      /setRightMin0\(false\)/.test(body),
      "`dismissFloat` 没复位 `rightMin0` ⇒ `right-wrapper-anim` 摘不掉 ⇒ 铺满规则被 `:not()` 永久排除（现象①）",
    ).toBe(true);
    expect(
      /removeProperty\("--right-body-pin"\)/.test(body),
      "`dismissFloat` 没摘 `--right-body-pin` ⇒ `.right-body` 被钉死、内容冲出窗口（现象④）",
    ).toBe(true);
    expect(
      /removeProperty\("--right-target-w"\)/.test(body),
      "`dismissFloat` 没摘 `--right-target-w` ⇒ 过渡期目标宽残留",
    ).toBe(true);
  });

  it("收尾清理：几何 done 里**再摘一次**（起点 + 收尾双保险）", () => {
    const body = fnBody(APP_CODE, "dismissFloat");
    

    const nMin = count(body, "setRightMin0(false)");
    expect(
      nMin >= 2,
      "dismissFloat 里 setRightMin0(false) 只出现 " + nMin + " 次（需要起点 + done 两次）",
    ).toBe(true);
    const nPin = count(body, 'removeProperty("--right-body-pin")');
    expect(nPin >= 2, "`--right-body-pin` 的摘除点少于 2 处（起点 + done）").toBe(true);
    const nTgt = count(body, 'removeProperty("--right-target-w")');
    expect(nTgt >= 2, "`--right-target-w` 的摘除点少于 2 处（起点 + done）").toBe(true);
  });
});

describe("A-1155 ② 过渡起点（`animateRightSidebar`）必须补做「上一次 done 被取消」的清理", () => {
  it("函数入口就复位 `rightMin0` 并摘两个过渡变量（不等上一次的 done）", () => {
    


    const body = fnBody(APP_CODE, "animateRightSidebar");
    const head = body.slice(0, Math.max(0, body.indexOf("if (nextOpen)")));
    expect(head, "入口没有 cancel 上一次过渡（守卫自己失效了）").toMatch(/rightFadeCancelRef\.current\?\.\(\)/);
    expect(
      /setRightMin0\(false\)/.test(head),
      "过渡起点没复位 `rightMin0` ⇒ 上一次过渡被 cancel 时它的 done 永不跑 ⇒ 类永久残留",
    ).toBe(true);
    expect(
      /removeProperty\("--right-body-pin"\)/.test(head),
      "过渡起点没摘 `--right-body-pin`（同上：上一次 done 被取消）",
    ).toBe(true);
    expect(
      /removeProperty\("--right-target-w"\)/.test(head),
      "过渡起点没摘 `--right-target-w`（同上）",
    ).toBe(true);
  });
});

describe("A-1155 ③ `--left-w`（浮层稳态宽的另一半）**写点与摘点必须成对**（铁律 11）", () => {
  



  it("`setProperty(\"--left-w\"` 的写点存在（唤出 / 窗口 resize / 左栏动画 三条路径）", () => {
    const nWrite = count(APP_CODE, 'setProperty("--left-w"');
    expect(nWrite >= 1, "根本没有写 `--left-w` ⇒ 浮层稳态宽退回 `100%`（现象④ 越窗复发）").toBe(true);
    
    expect(
      /setProperty\("--left-w"/.test(fnBody(APP_CODE, "handleToggleFloat")),
      "唤出路径（`handleToggleFloat`）没写 `--left-w` ⇒ 浮层第一帧就按 `100%` 算（越窗）",
    ).toBe(true);
    expect(
      /setProperty\("--left-w"/.test(fnBody(APP_CODE, "animateLeftSidebar")),
      "左栏折叠/展开（`animateLeftSidebar`）没同步 `--left-w` ⇒ 折叠后右栏不补宽、展开后越窗",
    ).toBe(true);
  });

  it("`removeProperty(\"--left-w\"` 的摘点覆盖两条退出路径（普通展开入口 + 退浮层），且退浮层有**双保障点**", () => {
    expect(
      /removeProperty\("--left-w"\)/.test(fnBody(APP_CODE, "animateRightSidebar")),
      "普通展开入口没摘 `--left-w` ⇒ 浮层态的脏变量跟到普通展开（写/摘不成对）",
    ).toBe(true);
    




    const df = fnBody(APP_CODE, "dismissFloat");
    expect(
      /removeProperty\("--left-w"\)/.test(df),
      "退浮层没摘 `--left-w` ⇒ 浮层退出后变量永久残留",
    ).toBe(true);
    const nLw = count(df, 'removeProperty("--left-w")');
    expect(
      nLw >= 2,
      "dismissFloat 里 `--left-w` 的摘除点只有 " + nLw + " 处（需要起点 + done 两个保障点）",
    ).toBe(true);
  });
});

describe("A-1155 ④ 浮层稳态宽**不许**直接取 `100%`（`.body` 含左栏 ⇒ 必越窗）", () => {
  it("wrapper 的稳态内联宽必须是 `calc(100% - var(--left-w, 0px))`", () => {
    




    expect(
      /"calc\(100% - var\(--left-w,\s*0px\)\)"/.test(APP_CODE),
      "浮层稳态宽不是 `calc(100% - var(--left-w, 0px))` ⇒ 右栏右缘越窗（现象④）",
    ).toBe(true);
    



    const m = /width:\s*\(mainIsFloatLayout && !rightMin0\)\s*\?\s*([^:]+?)\s*:/.exec(APP_CODE);
    expect(m, "取不到浮层稳态宽的三元表达式（守卫自己失效了）").toBeTruthy();
    const branch = m![1].trim();
    expect(
      branch === '"100%"' || branch === "'100%'",
      "浮层稳态宽又写成裸 " + branch + " ⇒ 参照 .body（含左栏）⇒ 越窗 240px",
    ).toBe(false);
  });

  it("浮层过渡的宽度对象仍在（**内容**侧 `var(--right-target-w)`，A-1179 后容器不再给宽度）", () => {
    






    expect(
      /mainIsFloatLayout \? \(rightExitAnim \? "var\(--right-target-w\)" : undefined\) : "auto"/.test(APP_CODE),
      "浮层过渡分支的形状不对 ⇒ 要么容器又硬跳（黑屏）、要么退场期丢宽度（A-1157-R2）",
    ).toBe(true);
    
    expect(
      /setProperty\("--right-target-w"/.test(APP_CODE),
      "过渡期不再写 `--right-target-w` ⇒ 内容宽度失去过渡对象（done 死锁）",
    ).toBe(true);
  });

  it("非浮层态回落 `auto`（普通展开逐字不变）", () => {
    expect(
      /mainIsFloatLayout \? \(rightExitAnim \? "var\(--right-target-w\)" : undefined\) : "auto"/.test(APP_CODE),
      "非浮层态没回落 `auto` ⇒ 普通展开会被内联宽污染",
    ).toBe(true);
  });
});

describe("A-1155 ⑤ 浮层判据必须与**真状态**同源（不许用宽度阈值猜）", () => {
  it("`animateRightSidebar` 有显式 `isFloat` 入参，且唤出路径传 `true`", () => {
    




    expect(
      /function animateRightSidebar\(nextOpen: boolean, nextWidth\?: number, isFloat\?: boolean\)/.test(APP_CODE),
      "`animateRightSidebar` 没有显式 `isFloat` 入参 ⇒ 浮层判据只能靠宽度猜（脆弱）",
    ).toBe(true);
    expect(
      /animateRightSidebar\(true,\s*floatTargetW,\s*true\)/.test(APP_CODE),
      "唤出路径没传 `isFloat=true` ⇒ 浮层被误判成普通展开（右栏不铺满 + 落 rightWidth 持久副作用）",
    ).toBe(true);
  });

  it("浮层判据优先用 `isFloat`，仅在未传时才回落旧阈值", () => {
    expect(
      /const\s+isFloatExpand\s*=\s*isFloat\s*!==\s*undefined[\s\S]{0,120}?:\s*\(nextWidth\s*!==\s*undefined\s*&&\s*nextWidth\s*>\s*window\.innerWidth\s*\*\s*0\.8\)/.test(APP_CODE),
      "`isFloatExpand` 没有「显式入参优先、阈值仅作回落」的结构 ⇒ 显式传参会失效",
    ).toBe(true);
  });
});

describe("A-1162 几何 done 必须有**时间上界**（取代 A-1155 ⑥ 的帧数兜底）", () => {
  







  const body = fnBody(APP_CODE, "runGeometrySyncFade");

  it("`GEOM_FADE_MS` 常量存在（时长的唯一真相源）", () => {
    expect(
      /const\s+GEOM_FADE_MS\s*=\s*\d+\s*;/.test(APP_CODE),
      "常量 GEOM_FADE_MS 不见了（时间驱动的时长失去唯一真相源）",
    ).toBe(true);
  });

  it("进度由**已过时长**推出，且收工判据是 `u >= 1`", () => {
    
    expect(
      /performance\.now\(\)\s*-\s*t0/.test(body),
      "进度没有由 performance.now() 推出 ⇒ 仍是测量驱动，收工时刻依旧随帧率漂",
    ).toBe(true);
    expect(
      /const\s+done\s*=\s*[^;]*u\s*>=\s*1/.test(body),
      "done 判据里没有 `u >= 1` ⇒ 没有与几何无关的时间上界，死锁风险回来了",
    ).toBe(true);
  });

  it("**不许**逐帧 `getBoundingClientRect()`（观测扰动被观测，实测 7~11ms/帧）", () => {
    


    expect(
      !/getBoundingClientRect/.test(body),
      "引擎里又出现 getBoundingClientRect ⇒ 退回测量驱动，进度重新依赖帧率",
    ).toBe(true);
  });
});

describe("A-1155 ⑦ 退浮层顺手清掉 `.right-sidebar` 的内联宽残留", () => {
  it("`dismissFloat` 里把 `.right-sidebar` 的 `style.width` 清空", () => {
    




    const body = fnBody(APP_CODE, "dismissFloat");
    expect(
      /querySelector\("\.right-sidebar"\)/.test(body),
      "`dismissFloat` 没去取 `.right-sidebar` ⇒ 它的内联宽残留无人清理（静默地雷）",
    ).toBe(true);
    expect(
      /\.style\.width\s*=\s*""/.test(body),
      "`dismissFloat` 没把 `.right-sidebar` 的 `style.width` 清空 ⇒ 内联宽残留",
    ).toBe(true);
  });
});








describe("A-1162 时长单源：`GEOM_FADE_MS` ≡ CSS `transition: width` 时长", () => {
  it("JS 常量与右栏那条 `transition: width` 时长逐字相等", () => {
    const js = /const\s+GEOM_FADE_MS\s*=\s*(\d+)\s*;/.exec(APP_CODE);
    expect(js, "找不到 GEOM_FADE_MS").toBeTruthy();
    const CSS_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8");
    const css = /body\.float-layout \.right-wrapper-anim \.right-sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(css![1]).toMatch(/transition:\s*width\s+([0-9.]+m?s)\s+/);
    const cssDur = css![1].match(/transition:\s*width\s+([0-9.]+m?s)\s+/)![1];
    expect(cssDur.endsWith("ms") ? Number(cssDur.slice(0, -2)) : Number(cssDur.replace("s", "")) * 1000,
      `GEOM_FADE_MS=${js![1]} 与 CSS 的 ${cssDur} 不等 ⇒ 几何与透明度会半拍错位`)
      .toBe(Number(js![1]));
  });

  it("引擎里**不许**再出现那五条启发式魔数（A-1162 已结构性废除）", () => {
    for (const k of ["GEOM_SYNC_MIN_SHIFT", "GEOM_SYNC_STABLE_FRAMES", "GEOM_SYNC_NO_MOVE_FRAMES",
      "GEOM_SYNC_NEVER_MOUNT_FRAMES", "GEOM_SYNC_HARD_LIMIT_FRAMES"]) {
      expect(APP_CODE, `魔数 ${k} 还在：它们是"宽度是外部量、我不知道它何时停"的补丁，收工时刻因此随帧率漂`)
        .not.toMatch(new RegExp(k));
    }
  });
});
