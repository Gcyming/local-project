/**
 * tests/core-ts/a1152-float-stability.spec.ts — 悬浮窗在**窗口尺寸变化**下的稳定性守卫（A-1152）。
 *
 * ## 用户实测的一串问题（一个根因族）
 * ① 「窗口化那一下卡顿依旧严重」；
 * ② 「slime 从常规大小变最大化后，对话页被强行拉开」；
 * ③ 「窗口化按钮失效、页面极不稳定」；
 * ④ 「窗口内出现空白」。
 *
 * ## 根因（用户自己猜对了方向）
 * **不是"等比缩放"，而是三处绝对像素下限**：`.main { min-width: 380px }`（只在非浮层生效）、
 * 消息流 `padding: … 44px …`（左右 60px 绝对值）、内部若干 `minWidth: 62/80/34` 的标签。
 * 两侧栏 `flex-shrink: 0` 不让位 ⇒ 窗口一变大，中间被强行拉开/留白。
 * 另有一条**会自己变假的几何判据**（`rightWidth >= innerWidth - 340`）曾把状态机带进错位区。
 *
 * ## 这个守卫锁什么
 * 全部是**形状断言**（不渲染组件、不依赖会话数据）：这几条一旦被改回去，
 * 用户报的那几个现象就会**静默**回来，而形状断言恰好能挡住"删掉这行"的回归。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
/** ⚠️ 取某个具名函数**从声明到下一个顶层 `\n  }` 之间的函数体**（花括号配平）。
 *  a1153 那边有同名 helper，这里独立一份，避免两份实现漂移后互相掩盖。 */
const fnBody2 = (src: string, name: string): string => {
  const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at < 0) { return ""; }
  let i = src.indexOf("{", at);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") { depth++; }
    else if (src[i] === "}") { depth--; if (depth === 0) { return src.slice(at, i + 1); } }
  }
  return src.slice(at);
};
const APP = read("gui/src/renderer/App.tsx");
const CSS = read("gui/src/renderer/index.css");
const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");

/** 剥掉注释（形状断言必须先剥注释，否则注释里的字会被当成代码命中）。 */
const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const APP_CODE = strip(APP);
const CSS_CODE = strip(CSS);
const PANEL_CODE = strip(PANEL);

describe("A-1152 ① 聊天区容器必须允许被压窄（`min-width: 0`）", () => {
  it("`.chat-scroll` 的 JSX 上有 `minWidth: 0`", () => {
    const at = PANEL_CODE.indexOf('className="chat-scroll rail-host"');
    expect(at, "找不到 .chat-scroll 的 JSX").toBeGreaterThan(-1);
    /* ⚠️ 只看紧随其后的 style：锚太宽会命中别处的 minWidth:0（仓库里到处都是）。 */
    const seg = PANEL_CODE.slice(at, at + 420);
    expect(seg).toMatch(/minWidth:\s*0/);
  });

  it("浮层/浮窗内的消息流也有 `min-width: 0`（覆盖窗口变大时被拉开的那条路）", () => {
    expect(CSS_CODE).toMatch(/\.(main\.main-float|float-window)\s+\.chat-scroll\s*\{[^}]*min-width:\s*0/);
  });
});

describe("A-1152 ② 浮层存活**不许**由几何量决定", () => {
  it("`mainIsFloatLayout` 里不许再出现 `innerWidth` 参与比较", () => {
    const at = APP_CODE.indexOf("const mainIsFloatLayout");
    expect(at, "找不到 mainIsFloatLayout").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 600).split("\n").slice(0, 12).join("\n");
    /* ⚠️ 这条曾以 `&& rightWidth >= Math.max(560, window.innerWidth - 340)` 的形式存在过，
       它会随窗口变大**自动变假** ⇒ 浮层被静默卸载而 floatState 仍是 float ⇒ 按钮失效。 */
    expect(seg).not.toMatch(/innerWidth/);
  });

  it("存在「右栏收起 ⇒ floatState 复位」的自愈 effect", () => {
    expect(APP_CODE).toMatch(/floatState\s*!==\s*"none"\s*&&\s*!\s*rightOpen\s*\)\s*\{\s*setFloatState\("none"\)/);
  });

  it("唤出浮层前会确保右栏是打开的（否则状态变了但什么都没挂载）", () => {
    const at = APP_CODE.indexOf("function handleToggleFloat");
    expect(at, "找不到 handleToggleFloat").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1600);
    expect(seg).toMatch(/if\s*\(\s*!rightOpen\s*\)/);
    expect(seg).toMatch(/setRightOpen\(true\)/);
  });
});

describe("A-1152 ③ 窗口 resize 路径必须 rAF 节流（卡顿的直接来源）", () => {
  it("`onWinResize` 里用 rAF 合并同帧内的多次 resize", () => {
    const at = APP_CODE.indexOf("const onWinResize");
    expect(at, "找不到 onWinResize").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 700);
    expect(seg).toMatch(/requestAnimationFrame/);
    /* ⚠️ "位置没变就返回原对象"这条也要锁：否则每个 resize 事件都产生一次新对象
       ⇒ React 必重渲染 ⇒ 长会话反复重排（用户报的卡顿）。 */
    expect(seg).toMatch(/return\s*\(p\s*&&\s*p\.x\s*===\s*q\.x\s*&&\s*p\.y\s*===\s*q\.y\)\s*\?\s*p\s*:\s*q/);
  });

  it("缩放期间的两个类**成对**挂/摘，且**不同时**（A-1152 ⑫：同帧挂 ⇒ 过渡永不播放）", () => {
    /* ⚠️ 这条断言的**形状**在A-1152 ⑫ 改过了：此前锚的是"两连add 相邻"，
       而那正是**bug 本身**（同帧挂 ⇒ content-visibility 立刻生效 ⇒ 过渡不播）。
       现在锚的是正确时序：**先 fading（定时器里再 resizing）**，且两处都要能摘。 */
    const at = APP_CODE.indexOf("const mark =");
    expect(at, "找不到窗口缩放的 mark 处理").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 900);
    expect(seg).toMatch(/classList\.add\("slime-fading"\)/);
    /* resizing 的挂载必须在 setTimeout回调里（延后一阶段）*/
    expect(seg).toMatch(/setTimeout\([\s\S]{0,200}?classList\.add\("slime-resizing"\)/);
    /* 两个类都要能被摘掉（残留 = 长期停在降级/不可见形态） */
    const at2 = APP_CODE.indexOf("function endChatFreeze");
    expect(at2).toBeGreaterThan(-1);
    const seg2 = APP_CODE.slice(at2, at2 + 500);
    expect(seg2).toMatch(/classList\.remove\("slime-resizing"\)/);
    expect(seg2).toMatch(/classList\.remove\("slime-fading"\)/);
  });
});

describe("A-1152 ④ 过渡钉宽：class 与CSS 变量必须成对", () => {
  it("写入处同时设class 与 `--slime-freeze-w`", () => {
    expect(APP_CODE).toMatch(/classList\.add\("slime-freezing"\)/);
    expect(APP_CODE).toMatch(/setProperty\("--slime-freeze-w"/);
  });

  it("清除处**两处都**要 `removeProperty`（残留 = 长期停在降级渲染）", () => {
    const n = (APP_CODE.match(/removeProperty\("--slime-freeze-w"\)/g) || []).length;
    /* done 分支 + 取消分支 = 2 处。少一处 ⇒ 变量残留。 */
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("CSS 侧两条路径用**不同值**（拖动 hidden / 浮层钉宽），不是同一条规则", () => {
    expect(CSS_CODE).toMatch(/body\.slime-resizing\s+\.chat-scroll\s*\{[^}]*content-visibility:\s*hidden/);
    expect(CSS_CODE).toMatch(/body\.slime-freezing\s+\.chat-scroll\s*\{[^}]*width:\s*var\(--slime-freeze-w/);
  });
});

describe("A-1152 ⑤拖动左栏必须零 React 重渲染（用户第二轮实测仍卡）", () => {
  it("`handleSidebarResize` 的 onMove **不调** `setSidebarWidth`（改直写 DOM）", () => {
    const at = APP_CODE.indexOf("function handleSidebarResize");
    expect(at, "找不到 handleSidebarResize").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 2600);
    const onMoveAt = seg.indexOf("const onMove");
    const onMoveEnd = seg.indexOf("const onUp");
    expect(onMoveAt).toBeGreaterThan(-1);
    const onMove = seg.slice(onMoveAt, onMoveEnd);
    /* ⚠️ 这是本轮最关键的一条：CSS 只压得住"重排"，压不住 React 自己的工作量。
       每个 pointermove 触发整棵长会话重渲染 ⇒ 在 6ms 帧预算下必然掉帧。 */
    expect(onMove).not.toMatch(/setSidebarWidth\(/);
    expect(onMove).toMatch(/style\.width\s*=/);
  });
});

describe("A-1152 ⑥ 浮窗尺寸必须**跟窗口比例**，不许再写死绝对值（用户第五轮实测：没修好）", () => {
  it("定义了 `FLOAT_RATIO`（浮窗占窗口的比例）", () => {
    expect(APP_CODE).toMatch(/const FLOAT_RATIO\s*=\s*\{\s*w:\s*0\.\d+\s*,\s*h:\s*0\.\d+\s*\}/);
  });

  it("初始 `floatSize` 由 `FLOAT_RATIO × innerWidth/innerHeight` 得出，**不是**写死的 480×540", () => {
    const at = APP_CODE.indexOf("const [floatSize, setFloatSize]");
    expect(at, "找不到 floatSize 的 state 声明").toBeGreaterThan(-1);
    /* ⚠️ 不能用一条跨行的正则去抓整个 useState（剥注释后换行位置会变）⇒ 锚定后取固定窗口。 */
    const seg = APP_CODE.slice(at, at + 320);
    expect(seg).toMatch(/FLOAT_RATIO\.w/);
    expect(seg).toMatch(/FLOAT_RATIO\.h/);
    /* ⚠️ 480×540 是**旧实现**：窗口默认宽 = `workArea.width × 0.78`（大屏到 2560），
       浮窗写死 480 ⇒ 窗口越大浮窗占比越小 ⇒ 内容被 `overflow:hidden` 裁掉右缘。 */
    expect(seg).not.toMatch(/clampFloatSize\(\s*480\s*,\s*540\s*\)/);
  });

  it("窗口 resize 时浮窗**按比例同步**（不是只在越界时夹一次）", () => {
    const at = APP_CODE.indexOf("const onWinResize");
    expect(at, "找不到 onWinResize").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1100);
    expect(seg).toMatch(/FLOAT_RATIO\.w/);
    expect(seg).toMatch(/FLOAT_RATIO\.h/);
  });

  it("（已查证）`floatSize` **没有**跨会话持久化 —— 改成比例不会覆盖任何「记住的尺寸」", () => {
    /* 这条断言的是"事实"而不是"要求"：若哪天有人加了持久化，本条会红，
       提醒他"比例逻辑要与持久化协调，别互相覆盖"。
       现状（A-1152 查证）：`floatSize` 全仓无 localStorage / session 存取点。 */
    const at = APP_CODE.indexOf("const [floatSize, setFloatSize]");
    const seg = APP_CODE.slice(at, at + 1200);
    expect(seg).not.toMatch(/localStorage|sessionStorage|await api\./);
  });
});

describe("A-1152 ⑦ 浮层态的 `<main>`必须**彻底脱离布局**（用户第六轮：「窗口化时把中间聊天页直接卸载…不要再搞成挤压式」）", () => {
  it("`.main.main-float` 归零 flex 基准与宽高，且带 `!important`", () => {
    const m = /\.main\.main-float\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到 .main.main-float 规则").toBeTruthy();
    const body = m![1];
    /* ⚠️ 回归记录：曾把它改成"浮窗样式"（让 `<main>` 兼作浮窗），
       实测引入可见回归（左栏收起异常 / 右栏不铺满）⇒ 已回退。 */
    expect(body).toMatch(/flex:\s*0\s+0\s+0px\s*!important/);
    expect(body).toMatch(/width:\s*0\s*!important/);
    expect(body).toMatch(/height:\s*0\s*!important/);
    expect(body).toMatch(/overflow:\s*hidden\s*!important/);
    /* ⚠️ `!important` 是必需的：`.main` 的 `flex: 1 1 0%` / `min-width: 380px` 与本规则特异度相同，
       输掉就会静默退回"挤压式"（用户实测"窗口化期间我都能手动把界面拉开"）。 */
    /* ⚠️ 也绝不能是 `display: none` —— 聊天区就在 `.main` 子树里。 */
    expect(body).not.toMatch(/display:\s*none/);
  });

  it("内联聊天区与浮层是**同一个宿主**（A-1158：唯一宿主，切换只换样式不换节点）", () => {
    /* ⚠️⚠️ **A-1158 改判据**：本条原来断言「`{chatPanelJsx}` 恰好 2 处，靠 `mainIsFloatLayout`
       互斥挂载」—— 那正是"换父节点 ⇒ React 整树重建"的成因，实测把窗口化过渡的第 3 帧
       拖成 **80ms 的一帧**（`LoAF{start:35ms dur:80ms renderStart:77ms scripts:[]}`、
       `longtask=[]` ⇒ 卡在"帧开始 → 浏览器开始渲染"之间）。
       并发提交只降到 55ms ⇒ 剩下的必须从结构上根除：**只挂载一份**。
       ⇒ 现在判据反过来：`{chatPanelJsx}` 在 App.tsx 里**恰好 1 处**，
         宿主元素在两种模式下**只换 style / class**，
         且它的子元素结构两种模式**逐字相同**（标题栏 / resize 手柄 / 最小化浮层都常驻，
         只切 display/opacity）—— 一旦按下标增删，React 会因位置对不上重建整棵 ChatPanel，
         这次改造的收益就全部还回去。 */
    const occurrences = (APP_CODE.match(/\{chatPanelJsx\}/g) || []).length;
    expect(occurrences, "`{chatPanelJsx}` 应当只剩 1 处（唯一宿主）；≥2 处说明又变回互斥挂载").toBe(1);
    /* ⚠️ 宿主必须是 `<main>` 的**子元素**（不能把 `position:fixed` 直接写在 `<main>` 上）：
       `.main.main-float` 有 `width:0 !important`（"浮层态 `.main` 必须零宽"），
       两者对打就是 A-1152 那次「左栏收起异常 / 右栏不铺满」回归的真正原因。
       放在内层 ⇒ `<main>` 几何与改造前逐字相同（仍是 0×0 占位），右栏铺满那套一行不用动。 */
    const hostAt = APP_CODE.indexOf('className={mainIsFloatLayout ? "float-window" : "inline-chat-host"}');
    expect(hostAt, "找不到唯一宿主的 className").toBeGreaterThan(-1);
    expect(hostAt, "宿主必须在 <main> 内部（不能把 fixed 写在 <main> 上）")
      .toBeGreaterThan(APP_CODE.indexOf("<main className="));
    expect(hostAt, "宿主必须在 </main> 之前").toBeLessThan(APP_CODE.indexOf("</main>"));
    /* ⚠️ 三个 ref（宿主主 ref / floatRef / inlineChatRef）必须是**同一个节点** ⇒ 走回调 ref */
    expect(APP_CODE).toMatch(/ref=\{\(el\)\s*=>\s*\{[^}]*chatHostRef\.current\s*=\s*el[^}]*floatRef\.current\s*=\s*el[^}]*inlineChatRef\.current\s*=\s*el/);
  });
});

describe("A-1152 ⑧ 右栏必须**贴到窗口右缘**（用户第七轮：「右侧边栏的最右侧又出现空白区域」）", () => {
  it("`.right-wrapper` 有 `marginLeft: \"auto\"`（auto margin 吃掉余量 ⇒ 贴边但不变宽）", () => {
    const at = APP_CODE.indexOf('className={`right-wrapper');
    expect(at, "找不到 .right-wrapper 的 JSX").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 700);
    /* ⚠️ 为什么不写 `flex: 1` / `width: 100%`：那会把右栏**拉宽**，
       而内部子面板都是固定宽 ⇒ 拉宽只会在最右侧留一条空带（用户看到的正是这个）。
       `margin-left: auto` 是唯一"贴边但不变宽"的办法。 */
    expect(seg).toMatch(/marginLeft:\s*"auto"/);
  });

  it("`.main.main-float` 归零后，右栏是唯一能吃余量的盒子（两者配套）", () => {
    /* 这条是"为什么两处改动必须一起做"的守卫：`.main` 归零前，余量被它吃掉（表现为挤压），
       归零后若右栏不贴边，余量就露在右缘（表现为空白）。两种表现是同一个余量的两种去处。 */
    const m = /\.main\.main-float\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m![1]).toMatch(/flex:\s*0\s+0\s+0px\s*!important/);
    expect(APP_CODE).toMatch(/marginLeft:\s*"auto"/);
  });
});
describe("A-1152 ⑨ 用户新要求：浮层态**彻底卸载中间页 + 不许拖拽 + 右栏贴缘**", () => {
  it("浮层外框 = 唯一宿主**自己**（不是 `<main>`；`.float-window` 类名仍提供 no-drag）", () => {
    /* ⚠️⚠️ **A-1158 改判据**：曾断言「浮层是 `</main>` 之后的 `.body` 直属独立元素」
       （那是 A-1152 回退方案）。现在浮层外框就是**唯一宿主自己**——但**仍然在 `<main>` 内部**
       （理由见上一条：`.main.main-float` 的 `width:0 !important` 会和 fixed 打架）。
       `.float-window` 类名在浮层态挂上，`-webkit-app-region: no-drag` 照旧生效。 */
    expect(APP_CODE).toMatch(/className=\{mainIsFloatLayout \? "float-window" : "inline-chat-host"\}/);
    expect(APP_CODE).not.toMatch(/<main className=\{`main\$\{mainIsFloatLayout \? " main-float float-window" : ""\}\}/);
    expect(CSS_CODE).toMatch(/\.float-window\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  });

  it("浮层态**不挂右栏拖拽手柄**（用户：「取消…可以手动拖拽…改成只能点窗口化收起」）", () => {
    const rs = read("gui/src/renderer/pages/RightSidebar.tsx");
    const code = strip(rs);
    expect(code).toMatch(/props\.open\s*&&\s*!props\.floatLayout\s*&&/);
    /* ⚠️ 必须锚"条件里含 floatLayout"：只锚 props.open 的话，
       把 `!props.floatLayout` 删掉（退回可拖拽）这条断言照样绿。 */
    expect(code).toMatch(/floatLayout\?:\s*boolean/);
  });

  it("App 把 `mainIsFloatLayout` 作为 `floatLayout` 传给右栏（同一份真状态）", () => {
    expect(APP_CODE).toMatch(/floatLayout=\{mainIsFloatLayout\}/);
  });

  it("浮窗初始尺寸是**有界的比例**（不许写死像素，也不许无限放大）", () => {
    const m = /const FLOAT_RATIO\s*=\s*\{\s*w:\s*([\d.]+)\s*,\s*h:\s*([\d.]+)\s*\}/.exec(APP_CODE);
    expect(m, "找不到 FLOAT_RATIO").toBeTruthy();
    /* ⚠️ 这条断言过一轮就失效了（曾写死 ≥0.85，用户随即要求"搞小一点"→ 0.66）。
       ⇒ 改为锚**不变量**：必须是 (0,1] 之间的比例（随窗口缩放、不写死像素、也不越出窗口）。 */
    const w = Number(m![1]), h = Number(m![2]);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(1);
    expect(h).toBeLessThanOrEqual(1);
    /* ⚠️ 同时不许退回"写死 480×540"——那正是"窗口缩放不等比"的根因（用户第五轮实测）。 */
    expect(APP_CODE).not.toMatch(/clampFloatSize\(\s*480\s*,\s*540\s*\)/);
  });

  it("浮窗的三个 resize 手柄**已恢复**（用户改要求：「自主拖拽控制大小的功能可以恢复一下」）", () => {
    /* ⚠️ 这条断言**反转过一次**：先按"不许手动拖拽"锚 `not.toMatch(/startFloatResize/)`，
       后用户改要求（「你给我的大小乱七八糟，太大了，还不能自己调」）⇒ 手柄必须回来。
       ⚠️ 两个语义都要守住：
         · 浮窗内部**要**有 e/s/se 三个手柄（用户要能调浮窗大小）；
         · 右栏那条手柄在浮层态**仍不挂**（那是"拉开右栏"的入口，与浮窗大小无关）。 */
    expect(APP_CODE).toMatch(/startFloatResize\(e, "e"\)/);
    expect(APP_CODE).toMatch(/startFloatResize\(e, "s"\)/);
    expect(APP_CODE).toMatch(/startFloatResize\(e, "se"\)/);
    const rs = strip(read("gui/src/renderer/pages/RightSidebar.tsx"));
    expect(rs).toMatch(/props\.open\s*&&\s*!props\.floatLayout\s*&&/);
  });

  it("`startFloatResize` 恢复为**有调用点**（不再需要 `void` 保留声明）", () => {
    expect(APP_CODE).toMatch(/function startFloatResize\(/);
    /* ⚠️ 手柄回来了 ⇒ 有调用点 ⇒ 那条 `void startFloatResize;`（TS6133 豁免）**必须删**，
       否则它是"针对已消失问题的补丁"，留在代码里会误导。 */
    expect(APP_CODE).not.toMatch(/void startFloatResize;/);
  });

  it("`.app` 有底色（浮层态「中间页已卸载」露出的区域不能是浏览器根底色）", () => {
    /* 用户截图里浮窗右侧/下方那片"空白"= `.app`/`.body` 透明 ⇒ 露出根底色（浅灰白）。
       ⚠️ 这**不是布局错**，所以几何探针量不出来（它量的是盒子位置，不是背景色）。 */
    /* ⚠️ 不能只匹配第一条 `.app { … }` —— 主题那条 `:root[data-theme="beta"] .app`
       特异度更高、才是实际生效的底色来源。要锚的是"**至少有一条** .app 规则给了底色"。 */
    const rules = CSS_CODE.match(/[^{}]*\.app\s*\{[^}]*background[^}]*\}/g) || [];
    expect(rules.length, "没有任何 .app 规则带 background").toBeGreaterThan(0);
    expect(CSS_CODE).toMatch(/\.app\s*\{[^}]*background:\s*var\(--bg\)/);
  });

  it("右栏 wrapper 有 `alignSelf: \"stretch\"`（撑满整高，浮窗下方由它承担）", () => {
    expect(APP_CODE).toMatch(/alignSelf:\s*"stretch"/);
  });
});

describe("A-1152 ⑩ 浮层态右栏必须**铺满整窗**（用户截图实测：右缘1400px 是根底色）", () => {
  it("CSS 里有浮层态铺满规则（排除过渡期）", () => {
    /* ⚠️ A-1152 ⑬ 更新：原先锚的是**无条件**铺满，那正是"过渡期宽度被锁死"的成因。
       现在铺满**排除过渡期**（`:not(.right-wrapper-anim)`）—— 见 ⑬ 组。
       ⚠️⚠️ A-1157-R2 再加一个排除项 `:not(.right-wrapper-exit)`：
         退浮层期间也必须让铺满失效，右栏才能从满宽**过渡回**自然宽度。
         实测（真 App CDP 逐帧）：不排除时退场是 `1ms 1092@240..1332` →
         `411ms 完全不动` → `431@901..1332` → `…339@901..1240`（右缘向左退、右边空 92px）。
       本条仍守"稳定态铺满整窗"这个意图（用户截图实测：右缘 1400px 是根底色）。 */
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar\s*\{[^}]*width:\s*100%\s*!important/);
  });

  it("`float-layout` 类由 `mainIsFloatLayout` 驱动（唯一真状态，与卸载同源）", () => {
    const at = APP_CODE.indexOf("const mainIsFloatLayout");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 2000);
    expect(seg).toMatch(/classList\.add\("float-layout"\)/);
    expect(seg).toMatch(/classList\.remove\("float-layout"\)/);
    /* ⚠️ 必须能**摘掉**：类残留会让右栏在非浮层态也铺满 ⇒ 正常布局被破坏。 */
    expect(seg).toMatch(/\},\s*\[mainIsFloatLayout\]\)/);
  });

  it("`--right-sidebar-w` 的 720px 上限**不许**被当成浮层态的宽度", () => {
    /* 锚住"上限还在、但浮层态另有覆盖"这个组合 —— 若有人删掉 float-layout 那条规则，
       这条不会红（720 还在），但上一条会红。两条配合才完整。 */
    expect(CSS_CODE).toMatch(/--right-sidebar-w:\s*clamp\([^)]*720px\)/);
  });
});

describe("A-1152 ⑪ 浮层态右栏铺满：**wrapper 给宽度 + 右栏填满**，缺一即塌成 0", () => {
  it("wrapper 的宽度**按状态**给（浮层 容器宽 / 非浮层 auto）", () => {
    /* ⚠️ 这条修的是"右栏整个消失"（用户实测「怎么右侧边栏直接没了」）：
       上一轮只把 `width:100%` 写在 `.right-sidebar` 上，而 wrapper 宽度是 `auto`(=0)
       ⇒ 百分比参照 0 ⇒ 右栏塌成 0、整栏不可见。
       ⇒ 宽度必须给 **wrapper**，且只在浮层态给（非浮层保持 auto，让右栏用
       `--right-sidebar-w`，含 720px 上限）。
       ⚠️ A-1155 更新：浮层态**从 `"100%"` 改成 `"calc(100% - var(--left-w, 0px))"`**。
         实测：`.body` 自身宽 = 整窗，`.body` = `[左栏][main][wrapper]`
         ⇒ 裸 `100%` 让 wrapper 右缘 = 左栏宽 + 整窗宽 = **越窗 240px**。 */
    expect(APP_CODE).toMatch(/width:\s*\(?\s*mainIsFloatLayout\s*&&\s*!rightMin0\s*\)?\s*\?\s*"calc\(100% - var\(--left-w,\s*0px\)\)"\s*:\s*\(?\s*mainIsFloatLayout\s*\?\s*"var\(--right-target-w\)"\s*:\s*"auto"/);
  });

  it("CSS 里右栏填满 wrapper 的规则仍在（`body.float-layout .right-sidebar`）", () => {
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar\s*\{[^}]*width:\s*100%\s*!important/);
  });

  it("两条**同时**存在才算修好（任缺一条 ⇒ 右栏塌 0 或只到 720px）", () => {
    /* ⚠️ 这个组合就是本轮踩坑的形状：两条规则各自都"看起来对"，
       少一条的表现分别是"右栏消失"与"右侧留白" —— 形状断言无法区分，
       所以两条都要锚，且真正兜底的是 `assert-float-gap.cjs` 的几何（走真实 CSS 路径）。
       ⚠️ A-1155：wrapper 那条已随实测改为 `calc(100% - var(--left-w, 0px))`，见上。 */
    const hasWrapper = /width:\s*\(?\s*mainIsFloatLayout\s*&&\s*!rightMin0\s*\)?\s*\?\s*"calc\(100% - var\(--left-w,\s*0px\)\)"\s*:\s*\(?\s*mainIsFloatLayout\s*\?\s*"var\(--right-target-w\)"\s*:\s*"auto"/.test(APP_CODE);
    const hasSidebar = /body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar\s*\{[^}]*width:\s*100%\s*!important/.test(CSS_CODE);
    expect(hasWrapper && hasSidebar).toBe(true);
  });
});

describe("A-1152 ⑫ 淡出/淡入必须**分两阶段**（用户实测「渐出消失衔接动画没有」）", () => {
  it("CSS：`slime-resizing` **不再**带 opacity（否则同帧挂类 ⇒ 过渡永不播放）", () => {
    /* ⚠️ 这是本轮的真bug：`slime-resizing` 既有 `content-visibility: hidden`
       又带 `opacity: 0`，而 JS 在**同一帧**挂 `slime-fading` + `slime-resizing`
       ⇒ 元素当帧跳过渲染 ⇒ **没有任何一帧被绘制** ⇒ opacity 过渡根本不会执行。
       ⇒ 两个类必须**各管一件事**：fading 只管 opacity，resizing 只管 content-visibility。 */
    const m = /body\.slime-resizing\s+\.chat-scroll\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到 slime-resizing 的 chat-scroll 规则").toBeTruthy();
    expect(m![1]).toMatch(/content-visibility:\s*hidden/);
  });

  it("CSS：`slime-fading` 单独负责 opacity 过渡", () => {
    const m = /body\.slime-fading\s+\.chat-scroll\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到 slime-fading 的 chat-scroll 规则（淡出靠它）").toBeTruthy();
    expect(m![1]).toMatch(/opacity:\s*0/);
    expect(m![1]).toMatch(/transition:\s*opacity/);
  });

  it("JS：**没有**任何一处同帧挂fading + resizing（那会让过渡失效）", () => {
    /* ⚠️ 锚"同一对 add 相邻出现"这个形状：同帧挂两个类 = 过渡被跳过。
       只要匹配到即失败 —— 要么全走两阶段（fading → 定时 → resizing）。 */
    const sameFrame = new RegExp(
`classList\.add\("slime-fading"\);[\s\S]{0,80}?classList\.add\("slime-resizing"\)`
    );
    expect(sameFrame.test(APP_CODE)).toBe(false);
  });

  it("拖动起始是**先只挂 fading**（resizing 延后到定时器里）", () => {
    const at = APP_CODE.indexOf("function handleSidebarResize");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1600);
    expect(seg).toMatch(/classList\.add\("slime-fading"\)/);
    /* fading 的出现必须**早于** resizing（用 index 比较先后） */
    const f = seg.indexOf('classList.add("slime-fading")');
    const r = seg.indexOf('classList.add("slime-resizing")');
    expect(f).toBeGreaterThan(-1);
    expect(r === -1 || f < r).toBe(true);
  });

  it("存在 `endChatFreeze()` 且它**分帧**摘类（渐入，别硬跳）", () => {
    expect(APP_CODE).toMatch(/function endChatFreeze\(\)/);
    const at = APP_CODE.indexOf("function endChatFreeze");
    const seg = APP_CODE.slice(at, at + 600);
    expect(seg).toMatch(/requestAnimationFrame\(/);
    /* 兜底定时器也要有：rAF 不来时不能把类永久留在 body 上 */
    expect(seg).toMatch(/setTimeout\(/);
  });

  it("⚠️ A-1153：`endChatFreeze` 的兜底定时器**不许递归自调用**（否则 = 永久摘类循环 = 闪烁）", () => {
    /* ⚠️⚠️ 这是一次**真 bug，而本组断言当时纵容了它**：
       旧实现末尾是 `window.setTimeout(() => { endChatFreeze(); }, 200);` —— 无条件调自己
       ⇒ 每次拖动结束都排一条**永不停止**的 200ms 定时器链，每 200ms 摘一次 `slime-fading`，
       与随后任何一次"挂类淡出"互相踩 ⇒ 用户实测「一拖拽，对话页就会出现闪烁」。
       ⚠️ 旧断言只要求"含 `setTimeout(`"这个**形状**，没有约束定时器里干了什么
       ⇒ 删掉 `endChatFreeze()` 那行也能过（甚至改成递归也能过）。
       ⇒ 现在补锚真正的不变量：**定时器回调里不许再出现 `endChatFreeze`**。
          （教训：形状断言要锚"不变量"，不能只锚"某个 API 被用过"。） */
    const at = APP_CODE.indexOf("function endChatFreeze");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 900);
    /* ⚠️ 判据 = "**定时器起点之后**不许再出现 `endChatFreeze(`"。
       别写成 `setTimeout\([^)]*=>…endChatFreeze\(\)`：`setTimeout(() => …` 紧跟着就是 `()`，
       而 `[^)]*` 一遇到 `)` 就停 ⇒ **那种正则永远匹配不到** ⇒ 是一条**假守卫**
       （实测：M13 变异"递归回去"时它照样绿）。 */
    const tAt = seg.indexOf("setTimeout(");
    expect(tAt, "本段里找不到兜底定时器（守卫自己失效了）").toBeGreaterThan(-1);
    /* ⚠️ 必须**截到函数尾**再判：`seg` 是固定 900 字符窗口，会越过函数尾带上
       后面 `handleSidebarResize` 里的合法调用 `endChatFreeze()` ⇒ 假红。 */
    const endAt = seg.indexOf("\n  }");
    const tail = seg.slice(tAt, endAt > tAt ? endAt : undefined);
    expect(
      tail,
      "兜底定时器递归调用了自己 ⇒ 每次拖拽都留下一条永不停止的摘类循环（闪烁根因）",
    ).not.toMatch(/endChatFreeze\s*\(/);
  });

  it("拖动结束走 `endChatFreeze()`（渐入恢复），不是硬摘两个类", () => {
    const at = APP_CODE.indexOf("const onUp = (): void => {");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 400);
    expect(seg).toMatch(/endChatFreeze\(\)/);
  });
});

describe("A-1152 ⑬ 窗口化过渡：右栏必须**逐帧响应**、抽屉式向左合（用户截过渡帧报错）", () => {
  it("CSS：铺满规则**排除过渡期**（`:not(.right-wrapper-anim)`）", () => {
    /* ⚠️ 这条修的是「右栏跑到左边然后往右合」：浮层态的 `width:100% !important`
       若在过渡期也生效，右栏宽度被**锁死** ⇒ 探针实测 wrap.w 恒 431、8 帧请求零响应
       ⇒ 过渡没有过渡对象，且 `rightWidth` 的旧内联值先闪一下 ⇒ 观感正是用户看到的。 */
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar\s*\{[^}]*width:\s*100%/);
    /* ⚠️ 不能出现"无条件铺满"的那条（否则上面这条形同虚设） */
    expect(CSS_CODE).not.toMatch(/body\.float-layout\s+\.right-sidebar\s*\{[^}]*width:\s*100%/);
  });

  it("退场标志 `right-wrapper-exit` 挂在**独立**的 state 上（不复用 `rightMin0`）", () => {
    /* ⚠️⚠️ 为什么不复用 `right-wrapper-anim`：它那条声明是
       `width: var(--right-target-w) !important`，而退场**刻意不写**该变量
       ⇒ `var()` 按 **IACVT** 处理 ⇒ `width` 取**初始值 `auto`**
       （不是"回落到下一条声明"！）且 `!important` 仍压过内联样式
       ⇒ 实测：内联起点宽 `1092px` 明明写进去了（还跨了两帧），计算宽度**当场就是 431**，
         `transition: width` 根本没有旧计算值可插值 ⇒ 退场全程纹丝不动（走了两轮弯路才定位）。
       ⇒ 退场只需要"别铺满"，另立一个只做这件事的类。 */
    const m = /className=\{`right-wrapper\$\{rightMin0 \? " right-wrapper-no-min" : ""\}\$\{rightMin0 \? " right-wrapper-anim" : ""\}\$\{rightExitAnim \? " right-wrapper-exit" : ""\}`\}/.exec(APP_CODE);
    expect(m, "right-wrapper-exit 没挂在 rightExitAnim 上").toBeTruthy();
  });

  it("`rightExitAnim` 必须**成对**：退场起点置真、退场几何 done 置假、唤出入口复位", () => {
    /* ⚠️⚠️ 三处缺一不可（变异测试实测：只校验 className 的绑定、不校验"有没有被置真"，
       两条变异都能存活 —— 守卫看着齐了，实际什么也没守住）：
       ① `dismissFloat` 起点 `setRightExitAnim(true)`：不置真 ⇒ 铺满规则在退场期仍生效
          ⇒ 右栏被钉死在满宽（实测 `1ms 1092@240..1332` → **411ms 完全不动** → 整块右跳）。
       ② `dismissFloat` 的几何 done `setRightExitAnim(false)`：不摘 ⇒ 类**永久残留**
          ⇒ 下次唤出时铺满规则从第一帧就失效 ⇒ 右栏起手就是自然宽（铁律 11：谁挂谁摘）。
       ③ `handleToggleFloat` 复位：退场被打断、done 没能跑到时的兜底（对称于 ②）。 */
    const dismiss = fnBody2(APP_CODE, "dismissFloat");
    expect(dismiss, "dismissFloat 里没有 setRightExitAnim(true)").toMatch(/setRightExitAnim\(true\)/);
    expect(dismiss, "dismissFloat 里没有成对摘除 setRightExitAnim(false)").toMatch(/setRightExitAnim\(false\)/);
    expect(APP_CODE).toMatch(/function handleToggleFloat[\s\S]{0,4000}?setRightExitAnim\(false\)/);
  });

  /* ⚠️⚠️ A-1158-R：退场 done 必须**清掉内层包裹层的 opacity 残留**。
   用户实测回归：「恢复窗口化之后中间一片黑」。
   机制：A-1158 把"浮窗外框"与"内联聊天区"合并成同一个宿主，`floatInnerRef` 那层
   因此**常驻**；而几何渐隐在退场终点把它 `style.opacity` 写成 ≈0
   ⇒ 残留的 0 一直作用在**普通布局的聊天区**上。
   ⚠️ 退场后几何量（宿主 w/h、`bodyCls`、`overflowRight`）全都是"正常"的
   ⇒ **只有这条断言能抓住它**，端到端探针也是靠 opacity 才暴露（几何量看不出来）。 */
  it("退场 done 清内层 opacity；唤出入口也复位（对称，成对）", () => {
    const dismiss = fnBody2(APP_CODE, "dismissFloat");
    expect(dismiss, "dismissFloat 里没有清 floatInnerRef 的 opacity")
      .toMatch(/floatInnerRef\.current[\s\S]{0,120}?\.style\.opacity\s*=\s*""/);
    expect(APP_CODE).toMatch(/function handleToggleFloat[\s\S]{0,4000}?floatInnerRef\.current[\s\S]{0,120}?\.style\.opacity\s*=\s*""/);
  });

  it("退场起点**先清内联残值、再挂 `exit` 类**（顺序反了右栏会跳到残值）", () => {
    /* ⚠️ 顺序是行为的一部分，不是风格：
       · 先清：此刻铺满规则仍在生效，内联残值被它压住 ⇒ 清除**没有视觉变化**；
       · 再挂类：铺满失效 ⇒ 计算宽度由 1092（满宽）变成自然宽 ⇒ 过渡有旧值可插值。
       · 若把"清"挪到挂类之后：内联残值（实测上一次普通展开留的是 287px）**突然生效**
         ⇒ 右栏直接跳到 287，而不是从浮层满宽平滑收下来。 */
    const dismiss = fnBody2(APP_CODE, "dismissFloat");
    const clearAt = dismiss.search(/rsExit\.style\.width = ""/);
    const setAt = dismiss.search(/setRightExitAnim\(true\)/);
    expect(clearAt, "dismissFloat 里找不到清理内联残值的那行").toBeGreaterThan(-1);
    expect(setAt, "dismissFloat 里找不到 setRightExitAnim(true)").toBeGreaterThan(-1);
    expect(clearAt, "清理残值必须排在 setRightExitAnim(true) 之前（否则残值会突然生效）").toBeLessThan(setAt);
  });

  it("过渡期标志 `right-wrapper-anim` 与 `right-wrapper-no-min` **仍同一条件**（铁律 11 未被破坏）", () => {
    /* ⚠️ 两个类共用一个条件（`rightMin0`）——拆成两个 state 就多一份要同步的判据（铁律 11）。
       ⚠️ A-1157-R2 只给**排除路径**加了 `rightExitAnim`，`anim` 本身**仍**由 `rightMin0` 驱动
       ⇒ 这条守卫原样有效，不许为了退场把它改成三态混用。 */
    expect(APP_CODE).toMatch(/right-wrapper-no-min[^`]*right-wrapper-anim/);
    const m = /className=\{`right-wrapper\$\{rightMin0 \? " right-wrapper-no-min" : ""\}\$\{rightMin0 \? " right-wrapper-anim" : ""\}/.exec(APP_CODE);
    expect(m, "两个类没挂同一个条件").toBeTruthy();
  });

  it("wrapper 的稳态 `width` 让位；`flexShrink` **恒 1**（A-1157 推翻 A-1155 的「浮层态禁收缩」）", () => {
    /* ⚠️ 两个判据都随实测修过一轮，别照抄历史：
       · 稳态宽**不再是裸 `"100%"`，而是 `"calc(100% - var(--left-w, 0px))"`** ——
         真机几何：`.body` 自身宽 = 整窗，而 wrapper 左缘在左栏之后
         ⇒ 裸 `100%` 参照 `.body` ⇒ **右缘越窗 240px**（实测 `overflowRight=[1572]`）。
       · ⚠️⚠️ `flexShrink` 在 A-1155 里被改成「浮层态 = 0」，理由是"wrapper 请求超过可用宽度，
         收缩权会落到左栏头上"。**A-1157 实测推翻它**：`--right-target-w` 修成
         `整窗 − 左栏实宽` 之后，那个"超出"的前提已经不存在；而继续禁收缩会**自锁**：
         左栏展开时 wrapper 按滞后一帧的 `--left-w` 占着 `100% − 1px`，总需求超出容器，
         而左栏 basis≈0 权重≈0 ⇒ 收缩量**全落在左栏** ⇒ 左栏被压回 1px
         ⇒ RO 读到 1px ⇒ `--left-w` 保持 1px ⇒ 死循环。
         实测症状：`3ms 宽=1 不透明=0% → 654ms 宽=240 不透明=100%`（整整 654ms 不可见），
         非浮层态同一操作完全正常 ⇒ 差异只来自浮层态那条 `calc(100% - var(--left-w))`。
         ⇒ 判据：wrapper **恒可收缩**，让位的是它而不是左栏（差值只有一帧的量）。 */
    expect(APP_CODE).toMatch(/width:\s*\(?\s*mainIsFloatLayout\s*&&\s*!rightMin0\s*\)?\s*\?\s*"calc\(100% - var\(--left-w,\s*0px\)\)"/);
    expect(APP_CODE).toMatch(/flexShrink:\s*1\s*,/);
    expect(APP_CODE, "flexShrink 又被写成浮层态禁收缩（A-1157 已实测推翻）").not.toMatch(
      /flexShrink:\s*mainIsFloatLayout\s*\?\s*0\s*:\s*1/,
    );
  });

  it("探针存在且逐帧量右栏（`probe-float-transition.cjs`）", () => {
    /* ⚠️ "过渡方向"这类问题**静态探针量不出来**（它量终态）⇒ 必须有逐帧探针。
       它验的是：右缘是否固定在窗口右缘 + 宽度是否逐帧响应。 */
    const src = read("gui/scripts/probe-float-transition.cjs");
    expect(src).toMatch(/right-wrapper-anim/);
    expect(src).toMatch(/sideR/);
  });
});

describe("A-1152 ⑭ 过渡期**不许硬跳**（用户：「过渡帧直接没了，衔接一点过渡」）", () => {
  it("CSS：`right-wrapper-anim` 期间**保留 width 过渡**（不许 `transition: none`）", () => {
    /* ⚠️ 我曾用 `transition: none` 关掉过渡来"修"方向问题 ⇒ 方向对了但过渡也没了
       （用户反馈「解决得太粗暴，过渡帧直接没了」）。
       ⇒ 过渡期**必须**有 width 过渡，否则几何同步写多少宽度都是硬跳。 */
    const m = /body\.float-layout\s+\.right-wrapper-anim\s+\.right-sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到过渡期规则").toBeTruthy();
    expect(m![1]).toMatch(/transition:\s*width/);
    expect(m![1]).not.toMatch(/transition:\s*none/);
  });

  it("过渡**起点**同帧挂 `float-layout`（不等 useEffect，否则第一帧硬跳）", () => {
    /*⚠️ `float-layout` 若只由 useEffect 挂，它在 render 之后才生效
       ⇒ 展开的第一帧仍按"非浮层"算宽度 ⇒ 右栏从旧宽硬跳到整窗宽。 */
    const at = APP_CODE.indexOf("setRightMin0(true);");
    expect(at, "找不到 setRightMin0(true)").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 400);
    expect(seg).toMatch(/classList\.add\("float-layout"\)/);
  });

  it("探针含**真实过渡曲线**采样（判据：相邻帧差 > 1px ⇒ 有过渡）", () => {
    /* ⚠️ 逐帧写内联宽度的探针**量不到过渡**（它自己驱动宽度）⇒ 必须另有一条
       "只写目标值、采样实际曲线"的探针。这才是用户体感的判据。 */
    const src = read("gui/scripts/probe-float-transition.cjs");
    expect(src).toMatch(/maxStep/);
    expect(src).toMatch(/真实过渡/);
  });
});

describe("A-1152 ⑮ 右栏占满时**内部比例**不许失衡（用户：「内部比例甚至都不正常了」）", () => {
  it("CSS：浮层态给 `.right-body` 限宽 + 居中", () => {
    /* ⚠️ 根因：右栏内部大量 `grid-template-columns: 1fr 1fr` / `flex: 1`，
       宽度从 720px 涨到 1600px 后每格被拉到 600-800px ⇒ 指标卡/表单行稀疏失衡。
       ⚠️⚠️ 限宽必须加在**最外层内容容器 `.right-body`**（右栏结构是
       `[resizer][tabbar][.right-body]`，所有面板都在 right-body 里）——
       限"每个直接子元素"只会命中 right-body 一个，深度上的网格照样被拉宽。
       ⚠️ 必须**居中**：只限宽不居中 ⇒ 内容贴左、右侧留白 = 用户前面反复报的"空白"。 */
    const m = /body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到浮层态的 right-body 限宽规则").toBeTruthy();
    /* ⚠️⚠️ A-1156：这里曾是 `var(--right-content-max, min(620px, 62%))` ——
       `var()` 钩子全仓**没有写入方**（第二个真相源，谁也设不了），
       且 620px 封顶本身就是用户报「右侧边栏内容一直只有一段」的成因 ⇒ 一并去掉。
       现在只有一条声明：铺满 + 高上限（判据见 a1156 spec）。 */
    expect(m![1]).not.toMatch(/--right-content-max/);
    expect(m![1]).toMatch(/max-width:\s*min\(\s*\d+px\s*,\s*100%\s*\)/);
    expect(m![1]).toMatch(/width:\s*100%/);
    expect(m![1]).toMatch(/margin-inline:\s*auto/);
  });

  it("限宽**只作用于浮层态**（非浮层态右栏本就有 720px 上限，不该被影响）", () => {
    /* 选择器必须带 `body.float-layout` 前缀 —— 裸 `.right-body { max-width }` 是第二个真相源。 */
    const bareBody = new RegExp(`(^|\n)\s*\.right-body\s*\{[^}]*max-width`);
    expect(bareBody.test(CSS_CODE)).toBe(false);
  });

  it("窗口化（大幅展开）用**更早的透明度带**（否则长期半透明 = 「动画乱七八糟」）", () => {
    /* ⚠️ 默认带是 `[0.45, 0.90] × full`，而窗口化时 `full = 整窗宽`
       ⇒ 要涨到 90%×1388≈1250px 才完全不透明 ⇒ 绝大部分过渡时间右栏半透明。
       ⇒ 窗口化那一支必须显式给更早的 loRatio/hiRatio（与左栏 A-980-R34 同思路）。 */
    const at = APP_CODE.indexOf("function animateRightSidebar");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 3500);
    expect(seg).toMatch(/loRatio:\s*0\.\d+/);
    expect(seg).toMatch(/hiRatio:\s*0\.\d+/);
    /* ⚠️ 且要有"仅窗口化这一支"的条件判断，不能把普通展开也一起改（会失去渐入感）。 */
    expect(seg).toMatch(/nextWidth\s*>\s*window\.innerWidth\s*\*\s*0\.\d+/);
  });
});

describe("A-1152 ⑯ 内容随比例自适应 + 过渡期钉宽（用户：「卡顿」「没随界面比例自适应」）", () => {
  it("CSS：`.right-body` 上限是「铺满 + 高上限」（A-1156 取代 A-1152 的 `min(620px, 62%)`）", () => {
    /* ⚠️ 历史：这里先后试过两版，都没让内容列真的长大 ——
       ① 死值 620px ⇒ 大屏上内容只占窗口 40%、两侧大片留白；
       ② `min(620px, 62%)` ⇒ 常规窗口（1332px）下 62% 只有 677px，仍被 620px 封顶，
          实测 fillRatio = 620/1092 = 0.568，左右各空 236px = 用户报的「只有一段」。
       ⇒ A-1156 定为 `min(1600px, 100%)`：常规窗口内容列 = 右栏整宽，超宽屏才留边。
       ⚠️ 仍保留上限（不是纯 100%）：2560px 屏上单条内容拉到 2000px+ 会一行到底。 */
    const m = /body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到浮层态的 right-body 规则").toBeTruthy();
    expect(m![1]).toMatch(/max-width:\s*min\(\s*(\d+)px\s*,\s*100%\s*\)/);
    expect(m![1].match(/max-width:\s*min\(\s*(\d+)px/)?.[1]).toMatch(/^\d+$/);
    expect(Number(m![1].match(/max-width:\s*min\(\s*(\d+)px/)?.[1])).toBeGreaterThanOrEqual(1200);
  });

  it("CSS：过渡期钉住 `.right-body`（消灭逐帧重排 = 用户的「很卡顿」）", () => {
    /* ⚠️ 右栏宽度从 ~350px 过渡到整窗宽时，内部所有 grid/flex 面板**每帧重排**。
       ⇒ 与聊天区 `slime-freezing` 同一解法：钉内容宽、让祖先裁切。
       ⚠️ 必须用 `--right-body-pin`（JS 在过渡起点算好一次性写入），
          **不能在 CSS 里写 `62%`** —— 百分比会跟着正在动画的容器一起变 ⇒ 又重排。 */
    const m = /body\.float-layout\s+\.right-wrapper-anim\s+\.right-body\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到过渡期的 right-body 钉宽规则").toBeTruthy();
    expect(m![1]).toMatch(/width:\s*var\(--right-body-pin/);
    expect(m![1]).toMatch(/flex:\s*0\s+0\s+auto/);
    /* 祖先要能裁切，钉宽才成立 */
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper-anim\s+\.right-sidebar\s*\{[^}]*overflow:\s*hidden/);
  });

  it("JS：过渡起点写 `--right-body-pin`、`done` 时**摘掉**（否则稳定态被钉死旧值）", () => {
    const at = APP_CODE.indexOf("--right-body-pin");
    expect(at, "找不到 --right-body-pin 的写入").toBeGreaterThan(-1);
    /* ⚠️ 两处都要有：setProperty（起点）、removeProperty（done）。
       只有 set 没有 remove ⇒ 窗口 resize 后内容不跟随（钉着旧值）。 */
    expect(APP_CODE).toMatch(/setProperty\("--right-body-pin"/);
    expect(APP_CODE).toMatch(/removeProperty\("--right-body-pin"\)/);
  });

  it("浮窗初始尺寸**变小**（用户：「你给我的大小乱七八糟，太大了」）", () => {
    const m = /const FLOAT_RATIO\s*=\s*\{\s*w:\s*([\d.]+)\s*,\s*h:\s*([\d.]+)\s*\}/.exec(APP_CODE);
    expect(m, "找不到 FLOAT_RATIO").toBeTruthy();
    /* ⚠️ 只锚上界（≤0.6）：用户嫌大 ⇒ 必须显著小于铺满；但不锚死具体值（观感值会再调）。 */
    expect(Number(m![1])).toBeLessThanOrEqual(0.6);
    expect(Number(m![2])).toBeLessThanOrEqual(0.6);
  });
});

describe("A-1152 ⑰ 浏览器页（webview）不受限宽（用户截图：网页被缩成中间一列）", () => {
  it("限宽选择器带 `:not(:has(webview))`", () => {
    /* ⚠️ 用户实测：切到浏览器页后整个网页被缩成中间一小列、两侧大片留白。
       根因：限宽规则 `body.float-layout .right-body` **不看当前是哪个页**，
       于是把 `<webview>`（浏览器页）也一起限了 —— 网页本该铺满。
       ⇒ 用 `:not(:has(webview))` 豁免：右栏里有 guest 就说明是浏览器页。
       ⚠️ 用 `:has()` 而非 React 传 prop：DOM 里有没有 `<webview>` 本身就是事实，
         传 prop 会多一份要同步的状态（铁律 11）。 */
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body/);
  });
});

describe("A-1152 ⑱ `float-layout` 命令式挂类必须**条件式**（回归：右栏收不起来 / 不自适应）", () => {
  it("`animateRightSidebar` 里 add 之前 200 字符内**有「是否窗口化」的 if 判据**", () => {
    /* ⚠️⚠️ 这是一次真回归：`animateRightSidebar` 里**无条件**同帧
       `classList.add("float-layout")`，而 React 那个 useEffect 的依赖是 `mainIsFloatLayout`
       —— 它不变就不会重跑 ⇒ 类**永久残留**
       ⇒ `body.float-layout .right-sidebar { width: 100% !important }` 一直生效
       ⇒ 用户实测「**右侧**边栏的收起出故障了，自适应功能更是没有了」。
       ⚠️ 断言的**形状**：add 必须紧跟在「是否窗口化」的条件判据之内，
          并且有配套的 `else { classList.remove(…); }`（只 add 不 remove = 残留）。 */
    const at = APP_CODE.indexOf("function animateRightSidebar");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 4000);
    const addAt = seg.indexOf('classList.add("float-layout")');
    expect(addAt, "找不到命令式挂类").toBeGreaterThan(-1);
    const before = seg.slice(Math.max(0, addAt - 200), addAt);
    /* add 之前 200 字符内必须有那个条件判据（否则就是无条件挂 = 回归）
       ⚠️⚠️ A-1155 更新：判据从**裸阈值** `nextWidth > innerWidth × 0.8` 升级成
          **显式入参优先 + 阈值仅回落** 的 `isFloatExpand` 变量（见 App.tsx 的 R6 说明）。
          为什么必须升级：本轮把目标宽改成 `innerWidth − 左栏实宽` 后，
          `1332−240=1092` 只比阈值 `1065.6` 高 26px ⇒ 左栏一变宽就判假
          ⇒ 浮层被误判成普通展开 ⇒ 不挂 `float-layout` + 落 `setRightWidth` 持久副作用
          （铁律 11：判据必须与**真状态**同源，不用派生猜测量）。
          ⇒ 断言锚 `isFloatExpand` 这个**变量名**（它由上面的三参签名决定），
            比锚一条会随几何漂移的阈值更稳、也更贴近"判据是显式的"这个不变量。 */
    expect(before, "add 之前没有「是否窗口化」的 if 判据 ⇒ 无条件挂类会永久残留").toMatch(
      /if\s*\(\s*isFloatExpand\s*\)/);
    /* 配套的 remove 必须在（else 分支），否则类一旦挂上就摘不掉 */
    expect(seg.slice(addAt, addAt + 300)).toMatch(/classList\.remove\("float-layout"\)/);
  });

  it("铺满整窗的规则带 `body.float-layout` 前缀（不挂类就不生效）", () => {
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar/);
  });
});

