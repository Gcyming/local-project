/**
 * tests/core-ts/a1155-float-width-symmetry.spec.ts — 浮层「宽度对称性」与「越窗」守卫（A-1155）。
 *
 * ## 为什么还要单独一个 spec
 * A-1152 锁了「浮层铺满的临时类」、A-1153 锁了「铺满 ↔ rightWidth 解耦」、
 * A-1154 锁了「拖拽基准」。但本轮用**真 App CDP 端到端取证**
 * （`gui/scripts/probe-a1155-cdp.mjs`，连真主进程 + 真 IPC + 真会话）又抓到 4 条
 * **前三轮全都没覆盖**的根因 —— 它们全部**只在"退出浮层 / 窗口变化 / 左栏折叠"这几条
 * 非主路径上**出现，因此靠"读一遍 handleToggleFloat 觉得没问题"永远发现不了：
 *
 * | # | 缺陷 | 用户看到什么 | 真机证据（修复前） |
 * |---|---|---|---|
 * | R1 | `dismissFloat` 退出浮层时**一样都不摘**（`rightMin0` / `--right-body-pin` / `--right-target-w`） | ① 右栏内容自适应失效 | 全程 `rwAnim=true rwNoMin=true bodyPin=441px` |
 * | R3 | `rightMin0` 死锁 ⇒ `right-wrapper-anim` 摘不掉 ⇒ 铺满规则被 `:not()` 永久排除 | ① 右栏只剩一段 | `rs.w=287` ≠ 1332 |
 * | R7 | 浮层稳态宽度取 `100%`，而 `.body` 含左栏 ⇒ 右栏右缘越窗 240px | ④ 右栏被挤压到屏幕外 | `rw.r=1572 > vw=1332` |
 * | R8 | `.right-sidebar` 的**内联宽**（上一轮 `setRightWidth` 写的 287px）无人摘 | 排查期误判源头（静默地雷） | `rsInlineW="287px"` 挂在浮层态 |
 *
 * ## 判据风格
 * 与 a1153 / a1154 一致：**剥注释**后做形状断言（不渲染组件、不依赖会话数据）。
 * ⚠️ 本仓注释里大量引用"被删掉的旧写法"，不剥注释就会假红/假绿。
 *
 * ⚠️ 关于"出现某字符串"这类**弱判据**：本轮刻意避免。
 * 例如 `--left-w` 的正确性不在"它出现过"，而在**写点与摘点成对**（铁律 11）
 * ⇒ 下面 ③ 直接数写/摘的**数量关系**，而不是 `includes`。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const APP_CODE = strip(read("gui/src/renderer/App.tsx"));

/** 取 `function X(...) { ... }` 的函数体（到下一个顶格 `  }` 为止）。 */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^]*?\\n  \\}`).exec(src);
  expect(m, `取不到 ${name}（守卫自己失效了）`).toBeTruthy();
  return m![0];
}

/** 数一个字符串在 src 里出现的次数（用于"写/摘成对"的数量判据）。 */
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
  /* ⚠️ 这条是本轮最重要的守卫。用户四条现象里的 ① 与 ④ 都根植于此：
     「窗口化」按钮的**退出**路由 `dismissFloat` 独占（`handleToggleFloat` 里
     `floatState === "float"` 分支直接 `return dismissFloat()`），
     **根本不经过 `animateRightSidebar` 的 else 支** —— 那条只服务标题栏的右栏开关。
     ⇒ 我第一轮把清理加在 else 支，探针实测**完全无效**（S5/S6 残留照旧）。 */
  it("起点清理：`setRightMin0(false)` + 摘 `--right-body-pin` / `--right-target-w`", () => {
    const body = fnBody(APP_CODE, "dismissFloat");
    /* 三条独立断言（不合并成一条长正则 —— 那样一旦语句顺序变就整体失配 = 假守卫）。 */
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
    /* ⚠️ 起点那次负责"复位到干净起点"；done 那次兜住"本轮期间有别的路径又写回了"。
       两次都要有 —— 删掉任意一次，另一路径就能把脏值带进稳态。 */
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
    /* ⚠️ 真问题：`rightFadeCancelRef.current?.()` 取消上一次过渡时，
       它的 `onFrame(_, true)` **永远不会跑** ⇒ 那次该做的清理被丢掉。
       `rightMin0` 一旦残留 ⇒ `right-wrapper-anim` 在 ⇒ 铺满规则被 `:not()` 排除。 */
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
  /* ⚠️ 这条刻意用**数量关系**而不是 `includes`：
     `--left-w` 的正确性不在"它出现过"，而在"凡写了的地方，退出路径都摘了"。
     只断言 `includes("--left-w")` 是弱判据 —— 加一行 `setProperty` 就绿，
     但**摘不掉**会让下一种布局吃到脏值（静默失效）。 */
  it("`setProperty(\"--left-w\"` 的写点存在（唤出 / 窗口 resize / 左栏动画 三条路径）", () => {
    const nWrite = count(APP_CODE, 'setProperty("--left-w"');
    expect(nWrite >= 1, "根本没有写 `--left-w` ⇒ 浮层稳态宽退回 `100%`（现象④ 越窗复发）").toBe(true);
    /* 三条路径各自必须有写点：少一条就会在那条路径上退化。 */
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
    /* ⚠️⚠️ 这条必须数**次数**，不能只判存在：
       `dismissFloat` 里有**两个**独立保障点 —— 起点（复位到干净起点）与几何 done（兜住
       "本轮期间有别的路径又写回了"）。删掉起点那次后，done 那次仍在
       ⇒ 只判存在的守卫**照样绿** ⇒ 假绿（变异实测 M13 因此"存活"）。
       ⇒ 与上面 `--right-body-pin` 同一套判据：**次数 ≥ 2**。 */
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
    /* ⚠️ 真机几何（本轮最关键的一条证据）：
         `.body` = `[.sidebar 240][main 0][wrapper]`，而 `.body` 自身宽 = 1332 = 整窗；
         wrapper 给 `100%` ⇒ 参照 `.body` = 1332，而它左缘在 x=240
         ⇒ 右缘 = 240 + 1332 = **1572，越窗 240px**（实测 `overflowRight=[1572]`）。
       ⇒ 稳态必须是"`.body` 减左栏"，即 `calc(100% - var(--left-w, 0px))`。 */
    expect(
      /"calc\(100% - var\(--left-w,\s*0px\)\)"/.test(APP_CODE),
      "浮层稳态宽不是 `calc(100% - var(--left-w, 0px))` ⇒ 右栏右缘越窗（现象④）",
    ).toBe(true);
    /* ⚠️ 反向判据：**不许**退回裸 `"100%"` 作为稳态宽。
       注意 `body.float-layout … width: 100% !important` 那条 CSS 仍在（那是给
       `.right-sidebar` 的、参照它自己的父 wrapper，语义不同）——
       这里只禁 JSX 里那条内联稳态分支。 */
    const m = /width:\s*\(mainIsFloatLayout && !rightMin0\)\s*\?\s*([^:]+?)\s*:/.exec(APP_CODE);
    expect(m, "取不到浮层稳态宽的三元表达式（守卫自己失效了）").toBeTruthy();
    const branch = m![1].trim();
    expect(
      branch === '"100%"' || branch === "'100%'",
      "浮层稳态宽又写成裸 " + branch + " ⇒ 参照 .body（含左栏）⇒ 越窗 240px",
    ).toBe(false);
  });

  it("过渡期宽仍走 `var(--right-target-w)`（浮层铺满的过渡对象）", () => {
    expect(
      /mainIsFloatLayout \? "var\(--right-target-w\)"/.test(APP_CODE),
      "过渡期宽不是 `var(--right-target-w)` ⇒ 浮层过渡没有过渡对象（宽不动 = done 死锁）",
    ).toBe(true);
  });

  it("非浮层态回落 `auto`（普通展开逐字不变）", () => {
    expect(
      /mainIsFloatLayout \? "var\(--right-target-w\)" : "auto"/.test(APP_CODE),
      "非浮层态没回落 `auto` ⇒ 普通展开会被内联宽污染",
    ).toBe(true);
  });
});

describe("A-1155 ⑤ 浮层判据必须与**真状态**同源（不许用宽度阈值猜）", () => {
  it("`animateRightSidebar` 有显式 `isFloat` 入参，且唤出路径传 `true`", () => {
    /* ⚠️ 真问题：原判据 `nextWidth > innerWidth × 0.8` 是**派生猜测量**。
       本轮把目标宽改成 `innerWidth − 左栏实宽` 后，`1332−240=1092` 只比
       `1332×0.8=1065.6` 高 26px ⇒ **左栏一变宽（或窗口一变窄）阈值立刻判假**
       ⇒ 浮层被误判成普通展开 ⇒ 走 `setRightWidth`（持久副作用回来）+ 不挂 `float-layout`
       ⇒ 又一轮"右栏不铺满 + 挤压 .main"的回归（铁律 11：同一事实一个产地）。 */
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
  /* ⚠️⚠️ 这三条**替换** A-1155 ⑥ 的两条帧数守卫，不是绕过它们。
     A-1155 ⑥ 当时发现了一个真实的结构性死锁（宽度"从头到尾不变" ⇒ 两条几何判据同时
     失效 ⇒ done 永不触发 ⇒ `rightMin0` 摘不掉 = 自锁），于是加了 `GEOM_SYNC_HARD_LIMIT_FRAMES`
     这条**正交**的帧数兜底。**那个死锁今天从结构上不存在了**：
     A-1162 把进度改成 `u = 已过时长 / GEOM_FADE_MS`，done 判据只剩 `u >= 1`
     —— 它与宽度**完全无关**，因此"宽度不变"再也杀不死它。
     ⇒ 这里守的是**同一个风险**（rAF 永不收工 ⇒ 临时类永久残留）在新结构下的等价保证，
        而不是保住那两条魔数。魔数已随实现删除。 */
  const body = fnBody(APP_CODE, "runGeometrySyncFade");

  it("`GEOM_FADE_MS` 常量存在（时长的唯一真相源）", () => {
    expect(
      /const\s+GEOM_FADE_MS\s*=\s*\d+\s*;/.test(APP_CODE),
      "常量 GEOM_FADE_MS 不见了（时间驱动的时长失去唯一真相源）",
    ).toBe(true);
  });

  it("进度由**已过时长**推出，且收工判据是 `u >= 1`", () => {
    /* ⚠️ 关键不变量：done 必须能脱离任何几何条件成立，否则就是 A-1155 ⑥ 那个死锁。 */
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
    /* ⚠️ A-1162 的核心动机之一：旧版每帧读一次真实宽度来反推进度，
       而强制同步布局会把浏览器本该在帧末做的那次布局提前、自己制造停顿。
       ⚠️ 只禁**逐帧**读；`measure()` 的**存在性**调用必须保留（对象卸载时要立刻收工）。 */
    expect(
      !/getBoundingClientRect/.test(body),
      "引擎里又出现 getBoundingClientRect ⇒ 退回测量驱动，进度重新依赖帧率",
    ).toBe(true);
  });
});

describe("A-1155 ⑦ 退浮层顺手清掉 `.right-sidebar` 的内联宽残留", () => {
  it("`dismissFloat` 里把 `.right-sidebar` 的 `style.width` 清空", () => {
    /* ⚠️ 真机实测：浮层稳态下 `rsInlineW="287px"` —— 那是**上一轮普通展开**
       （`animateRightSidebar(_, nextWidth)` 的 `setRightWidth`）写下的内联宽，
       浮层支不写它、但**也没有任何地方摘它**。
       浮层态靠 CSS `!important` 盖住所以暂时不显形 —— 一旦哪条路径摘掉那个 `!important`，
       287px 立刻显形 = **静默地雷**（本轮越窗排查就一度被它误导）。 */
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

/* ⚠️⚠️ A-1162：`GEOM_FADE_MS` 必须与 CSS 里 `transition: width` 的时长**逐字相等**。
   这条过渡有**两半**：CSS transition 负责几何、`runGeometrySyncFade` 负责透明度。
   A-1162 起两半都由同一个 `u = 已过时长 / GEOM_FADE_MS` 驱动 ——
   常量一漂，就出现「宽度还在滑、透明度已经到位」（或反之）的那种**半拍错位**，
   而半拍错位观感上正是"衔接抽搐"。
   ⚠️ 从**两份文本**分别取值再比较，不允许在测试里手抄一个期望值：
   手抄的那份迟早和两边都漂，而比较会一直"通过"。 */
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