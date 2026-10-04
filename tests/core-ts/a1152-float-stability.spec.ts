



















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");


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
    

    expect(seg).toMatch(/return\s*\(p\s*&&\s*p\.x\s*===\s*q\.x\s*&&\s*p\.y\s*===\s*q\.y\)\s*\?\s*p\s*:\s*q/);
  });

  it("缩放期间的两个类**成对**挂/摘，且**不同时**（A-1152 ⑫：同帧挂 ⇒ 过渡永不播放）", () => {
    


    const at = APP_CODE.indexOf("const mark =");
    expect(at, "找不到窗口缩放的 mark 处理").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1400);
    expect(seg).toMatch(/classList\.add\("slime-fading"\)/);
    



    expect(seg).toMatch(/setTimeout\([\s\S]{0,600}?classList\.add\("slime-resizing"\)/);
    
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
    
    const seg = APP_CODE.slice(at, at + 320);
    expect(seg).toMatch(/FLOAT_RATIO\.w/);
    expect(seg).toMatch(/FLOAT_RATIO\.h/);
    

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
    

    expect(body).toMatch(/flex:\s*0\s+0\s+0px\s*!important/);
    expect(body).toMatch(/width:\s*0\s*!important/);
    expect(body).toMatch(/height:\s*0\s*!important/);
    expect(body).toMatch(/overflow:\s*hidden\s*!important/);
    

    
    expect(body).not.toMatch(/display:\s*none/);
  });

  it("内联聊天区与浮层是**同一个宿主**（A-1158：唯一宿主，切换只换样式不换节点）", () => {
    









    const occurrences = (APP_CODE.match(/\{chatPanelJsx\}/g) || []).length;
    expect(occurrences, "`{chatPanelJsx}` 应当只剩 1 处（唯一宿主）；≥2 处说明又变回互斥挂载").toBe(1);
    



    




    const hostAt = APP_CODE.indexOf('className={hostIsFloat ? "float-window" : "inline-chat-host"}');
    expect(hostAt, "找不到唯一宿主的 className（或它又用回了业务状态 `mainIsFloatLayout`）").toBeGreaterThan(-1);
    expect(hostAt, "宿主必须在 <main> 内部（不能把 fixed 写在 <main> 上）")
      .toBeGreaterThan(APP_CODE.indexOf("<main className="));
    expect(hostAt, "宿主必须在 </main> 之前").toBeLessThan(APP_CODE.indexOf("</main>"));
    
    expect(APP_CODE).toMatch(/ref=\{\(el\)\s*=>\s*\{[^}]*chatHostRef\.current\s*=\s*el[^}]*floatRef\.current\s*=\s*el[^}]*inlineChatRef\.current\s*=\s*el/);
  });
});

describe("A-1152 ⑧ 右栏必须**贴到窗口右缘**（用户第七轮：「右侧边栏的最右侧又出现空白区域」）", () => {
  it("`.right-wrapper` 有 `marginLeft: \"auto\"`（auto margin 吃掉余量 ⇒ 贴边但不变宽）", () => {
    const at = APP_CODE.indexOf('className={`right-wrapper');
    expect(at, "找不到 .right-wrapper 的 JSX").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 700);
    


    expect(seg).toMatch(/marginLeft:\s*"auto"/);
  });

  it("`.main.main-float` 归零后，右栏是唯一能吃余量的盒子（两者配套）", () => {
    

    const m = /\.main\.main-float\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m![1]).toMatch(/flex:\s*0\s+0\s+0px\s*!important/);
    expect(APP_CODE).toMatch(/marginLeft:\s*"auto"/);
  });
});
describe("A-1152 ⑨ 用户新要求：浮层态**彻底卸载中间页 + 不许拖拽 + 右栏贴缘**", () => {
  it("浮层外框 = 唯一宿主**自己**（不是 `<main>`；`.float-window` 类名仍提供 no-drag）", () => {
    



    

    expect(APP_CODE).toMatch(/className=\{hostIsFloat \? "float-window" : "inline-chat-host"\}/);
    expect(APP_CODE).not.toMatch(/<main className=\{`main\$\{mainIsFloatLayout \? " main-float float-window" : ""\}\}/);
    expect(CSS_CODE).toMatch(/\.float-window\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  });

  it("浮层态**不挂右栏拖拽手柄**（用户：「取消…可以手动拖拽…改成只能点窗口化收起」）", () => {
    const rs = read("gui/src/renderer/pages/RightSidebar.tsx");
    const code = strip(rs);
    expect(code).toMatch(/props\.open\s*&&\s*!props\.floatLayout\s*&&/);
    

    expect(code).toMatch(/floatLayout\?:\s*boolean/);
  });

  it("App 把 `mainIsFloatLayout` 作为 `floatLayout` 传给右栏（同一份真状态）", () => {
    expect(APP_CODE).toMatch(/floatLayout=\{mainIsFloatLayout\}/);
  });

  it("浮窗初始尺寸是**有界的比例**（不许写死像素，也不许无限放大）", () => {
    const m = /const FLOAT_RATIO\s*=\s*\{\s*w:\s*([\d.]+)\s*,\s*h:\s*([\d.]+)\s*\}/.exec(APP_CODE);
    expect(m, "找不到 FLOAT_RATIO").toBeTruthy();
    

    const w = Number(m![1]), h = Number(m![2]);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(1);
    expect(h).toBeLessThanOrEqual(1);
    
    expect(APP_CODE).not.toMatch(/clampFloatSize\(\s*480\s*,\s*540\s*\)/);
  });

  it("浮窗的三个 resize 手柄**已恢复**（用户改要求：「自主拖拽控制大小的功能可以恢复一下」）", () => {
    




    expect(APP_CODE).toMatch(/startFloatResize\(e, "e"\)/);
    expect(APP_CODE).toMatch(/startFloatResize\(e, "s"\)/);
    expect(APP_CODE).toMatch(/startFloatResize\(e, "se"\)/);
    const rs = strip(read("gui/src/renderer/pages/RightSidebar.tsx"));
    expect(rs).toMatch(/props\.open\s*&&\s*!props\.floatLayout\s*&&/);
  });

  it("`startFloatResize` 恢复为**有调用点**（不再需要 `void` 保留声明）", () => {
    expect(APP_CODE).toMatch(/function startFloatResize\(/);
    

    expect(APP_CODE).not.toMatch(/void startFloatResize;/);
  });

  it("`.app` 有底色（浮层态「中间页已卸载」露出的区域不能是浏览器根底色）", () => {
    

    

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
    






    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar\s*\{[^}]*width:\s*100%\s*!important/);
  });

  it("`float-layout` 类由 `mainIsFloatLayout` 驱动（唯一真状态，与卸载同源）", () => {
    const at = APP_CODE.indexOf("const mainIsFloatLayout");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 2000);
    expect(seg).toMatch(/classList\.add\("float-layout"\)/);
    expect(seg).toMatch(/classList\.remove\("float-layout"\)/);
    
    expect(seg).toMatch(/\},\s*\[mainIsFloatLayout\]\)/);
  });

  it("`--right-sidebar-w` 的 720px 上限**不许**被当成浮层态的宽度", () => {
    

    expect(CSS_CODE).toMatch(/--right-sidebar-w:\s*clamp\([^)]*720px\)/);
  });
});

describe("A-1152 ⑪ 浮层态右栏铺满：**wrapper 给宽度 + 右栏填满**，缺一即塌成 0", () => {
  it("wrapper 的宽度**按状态**给（浮层 容器宽 / 非浮层 auto）", () => {
    







    expect(APP_CODE).toMatch(/width:\s*\(?\s*mainIsFloatLayout\s*&&\s*!rightMin0\s*\)?\s*\?\s*"calc\(100% - var\(--left-w,\s*0px\)\)"\s*:\s*\(?\s*mainIsFloatLayout\s*\?\s*\(rightExitAnim\s*\?\s*"var\(--right-target-w\)"\s*:\s*undefined\)\s*:\s*"auto"/);
  });

  it("CSS 里右栏填满 wrapper 的规则仍在（`body.float-layout .right-sidebar`）", () => {
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar\s*\{[^}]*width:\s*100%\s*!important/);
  });

  it("两条**同时**存在才算修好（任缺一条 ⇒ 右栏塌 0 或只到 720px）", () => {
    









    const hasWrapper = /width:\s*\(?\s*mainIsFloatLayout\s*&&\s*!rightMin0\s*\)?\s*\?\s*"calc\(100% - var\(--left-w,\s*0px\)\)"\s*:\s*\(?\s*mainIsFloatLayout\s*\?\s*\(rightExitAnim\s*\?\s*"var\(--right-target-w\)"\s*:\s*undefined\)\s*:\s*"auto"/.test(APP_CODE);
    const hasSidebar = /body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar\s*\{[^}]*width:\s*100%\s*!important/.test(CSS_CODE);
    expect(hasWrapper && hasSidebar).toBe(true);
  });
});

describe("A-1152 ⑫ 淡出/淡入必须**分两阶段**（用户实测「渐出消失衔接动画没有」）", () => {
  it("CSS：`slime-resizing` **不再**带 opacity（否则同帧挂类 ⇒ 过渡永不播放）", () => {
    



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
    

    const sameFrame = new RegExp(
`classList\.add\("slime-fading"\);[\s\S]{0,80}?classList\.add\("slime-resizing"\)`
    );
    expect(sameFrame.test(APP_CODE)).toBe(false);
  });

  it("⚠️ A-1190：淡出**不在**拖拽起点挂（点一下分栏边缘不该淡出）", () => {
    





    for (const fn of ["function handleSidebarResize", "function handleRightbarResize"]) {
      const at = APP_CODE.indexOf(fn);
      expect(at, `找不到 ${fn}`).toBeGreaterThan(-1);
      const seg = APP_CODE.slice(at, at + 1600);
      expect(
        seg,
        `${fn} 的起点又在无条件挂 fading ⇒ 用户"点一下边缘"（还没拖）聊天页就会消失`,
      ).not.toMatch(/classList\.add\("slime-fading"\)/);
      expect(
        seg,
        `${fn} 的起点丢了 slime-dragging ⇒ 拖动头段不跟手 / 拖出蓝色选区`,
      ).toMatch(/classList\.add\("slime-dragging"\)/);
    }
  });

  it("⚠️ A-1190：两阶段（fading → resizing）仍在，且**只**在 `mark()` 里", () => {
    

    const at = APP_CODE.indexOf("const mark =");
    expect(at, "找不到 RO 的 mark 处理").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1400);
    expect(seg).toMatch(/classList\.add\("slime-fading"\)/);
    
    expect(seg).toMatch(/setTimeout\([\s\S]{0,600}?classList\.add\("slime-resizing"\)/);
  });

  it("存在 `endChatFreeze()` 且它**分帧**摘类（渐入，别硬跳）", () => {
    expect(APP_CODE).toMatch(/function endChatFreeze\(\)/);
    const at = APP_CODE.indexOf("function endChatFreeze");
    const seg = APP_CODE.slice(at, at + 600);
    expect(seg).toMatch(/requestAnimationFrame\(/);
    
    expect(seg).toMatch(/setTimeout\(/);
  });

  it("⚠️ A-1153：`endChatFreeze` 的兜底定时器**不许递归自调用**（否则 = 永久摘类循环 = 闪烁）", () => {
    







    const at = APP_CODE.indexOf("function endChatFreeze");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 900);
    



    const tAt = seg.indexOf("setTimeout(");
    expect(tAt, "本段里找不到兜底定时器（守卫自己失效了）").toBeGreaterThan(-1);
    

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
    


    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar\s*\{[^}]*width:\s*100%/);
    
    expect(CSS_CODE).not.toMatch(/body\.float-layout\s+\.right-sidebar\s*\{[^}]*width:\s*100%/);
  });

  it("退场标志 `right-wrapper-exit` 挂在**独立**的 state 上（不复用 `rightMin0`）", () => {
    






    const m = /className=\{`right-wrapper\$\{rightMin0 \? " right-wrapper-no-min" : ""\}\$\{rightMin0 \? " right-wrapper-anim" : ""\}\$\{rightExitAnim \? " right-wrapper-exit" : ""\}`\}/.exec(APP_CODE);
    expect(m, "right-wrapper-exit 没挂在 rightExitAnim 上").toBeTruthy();
  });

  it("`rightExitAnim` 必须**成对**：退场起点置真、退场几何 done 置假、唤出入口复位", () => {
    






    const dismiss = fnBody2(APP_CODE, "dismissFloat");
    expect(dismiss, "dismissFloat 里没有 setRightExitAnim(true)").toMatch(/setRightExitAnim\(true\)/);
    expect(dismiss, "dismissFloat 里没有成对摘除 setRightExitAnim(false)").toMatch(/setRightExitAnim\(false\)/);
    expect(APP_CODE).toMatch(/function handleToggleFloat[\s\S]{0,4000}?setRightExitAnim\(false\)/);
  });

  






  it("退场 done 清内层 opacity；唤出入口也复位（对称，成对）", () => {
    const dismiss = fnBody2(APP_CODE, "dismissFloat");
    expect(dismiss, "dismissFloat 里没有清 floatInnerRef 的 opacity")
      .toMatch(/floatInnerRef\.current[\s\S]{0,120}?\.style\.opacity\s*=\s*""/);
    expect(APP_CODE).toMatch(/function handleToggleFloat[\s\S]{0,4000}?floatInnerRef\.current[\s\S]{0,120}?\.style\.opacity\s*=\s*""/);
  });

  it("退场起点**先清内联残值、再挂 `exit` 类**（顺序反了右栏会跳到残值）", () => {
    




    const dismiss = fnBody2(APP_CODE, "dismissFloat");
    const clearAt = dismiss.search(/rsExit\.style\.width = ""/);
    const setAt = dismiss.search(/setRightExitAnim\(true\)/);
    expect(clearAt, "dismissFloat 里找不到清理内联残值的那行").toBeGreaterThan(-1);
    expect(setAt, "dismissFloat 里找不到 setRightExitAnim(true)").toBeGreaterThan(-1);
    expect(clearAt, "清理残值必须排在 setRightExitAnim(true) 之前（否则残值会突然生效）").toBeLessThan(setAt);
  });

  it("过渡期标志 `right-wrapper-anim` 与 `right-wrapper-no-min` **仍同一条件**（铁律 11 未被破坏）", () => {
    


    expect(APP_CODE).toMatch(/right-wrapper-no-min[^`]*right-wrapper-anim/);
    const m = /className=\{`right-wrapper\$\{rightMin0 \? " right-wrapper-no-min" : ""\}\$\{rightMin0 \? " right-wrapper-anim" : ""\}/.exec(APP_CODE);
    expect(m, "两个类没挂同一个条件").toBeTruthy();
  });

  it("wrapper 的稳态 `width` 让位；`flexShrink` **恒 1**（A-1157 推翻 A-1155 的「浮层态禁收缩」）", () => {
    












    expect(APP_CODE).toMatch(/width:\s*\(?\s*mainIsFloatLayout\s*&&\s*!rightMin0\s*\)?\s*\?\s*"calc\(100% - var\(--left-w,\s*0px\)\)"/);
    expect(APP_CODE).toMatch(/flexShrink:\s*1\s*,/);
    expect(APP_CODE, "flexShrink 又被写成浮层态禁收缩（A-1157 已实测推翻）").not.toMatch(
      /flexShrink:\s*mainIsFloatLayout\s*\?\s*0\s*:\s*1/,
    );
  });

  it("探针存在且逐帧量右栏（`probe-float-transition.cjs`）", () => {
    

    const src = read("gui/scripts/probe-float-transition.cjs");
    expect(src).toMatch(/right-wrapper-anim/);
    expect(src).toMatch(/sideR/);
  });
});

describe("A-1152 ⑭ 过渡期**不许硬跳**（用户：「过渡帧直接没了，衔接一点过渡」）", () => {
  it("CSS：`right-wrapper-anim` 期间**保留 width 过渡**（不许 `transition: none`）", () => {
    


    const m = /body\.float-layout\s+\.right-wrapper-anim\s+\.right-sidebar\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到过渡期规则").toBeTruthy();
    expect(m![1]).toMatch(/transition:\s*width/);
    expect(m![1]).not.toMatch(/transition:\s*none/);
  });

  it("过渡**起点**同帧挂 `float-layout`（不等 useEffect，否则第一帧硬跳）", () => {
    

    const at = APP_CODE.indexOf("setRightMin0(true);");
    expect(at, "找不到 setRightMin0(true)").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 400);
    expect(seg).toMatch(/classList\.add\("float-layout"\)/);
  });

  it("探针含**真实过渡曲线**采样（判据：相邻帧差 > 1px ⇒ 有过渡）", () => {
    

    const src = read("gui/scripts/probe-float-transition.cjs");
    expect(src).toMatch(/maxStep/);
    expect(src).toMatch(/真实过渡/);
  });
});

describe("A-1152 ⑮ 右栏占满时**内部比例**不许失衡（用户：「内部比例甚至都不正常了」）", () => {
  it("CSS：浮层态给 `.right-body` 限宽 + 居中", () => {
    





    const m = /body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到浮层态的 right-body 限宽规则").toBeTruthy();
    



    expect(m![1]).not.toMatch(/--right-content-max/);
    expect(m![1]).toMatch(/max-width:\s*min\(\s*\d+px\s*,\s*100%\s*\)/);
    expect(m![1]).toMatch(/width:\s*100%/);
    expect(m![1]).toMatch(/margin-inline:\s*auto/);
  });

  it("限宽**只作用于浮层态**（非浮层态右栏本就有 720px 上限，不该被影响）", () => {
    
    const bareBody = new RegExp(`(^|\n)\s*\.right-body\s*\{[^}]*max-width`);
    expect(bareBody.test(CSS_CODE)).toBe(false);
  });

  it("右栏两条支都**显式**传可见性窗口，且与左栏**同源常量**（A-1189 取代 A-1152 的「更早的带」特例）", () => {
    







    const m = /function\s+animateRightSidebar\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m, "取不到 `animateRightSidebar` 函数体（守卫自己失效了）").toBeTruthy();
    const seg = m![0];
    expect(seg, "展开支没引用左栏的窗口常量 ⇒ 时机出现第二产地（手抄数值迟早与左栏漂开）")
      .toMatch(/loRatio:\s*LEFT_FADE_LO,\s*hiRatio:\s*LEFT_FADE_HI/);
    expect(seg, "收起支没换用收起专用的窗口常量 ⇒ 渐出会被推迟到实际宽度只剩几十 px ⇒ 肉眼看不见渐出")
      .toMatch(/loRatio:\s*LEFT_FADE_COLLAPSE_LO,\s*hiRatio:\s*LEFT_FADE_COLLAPSE_HI/);
    expect(seg, "两方向必须按 `nextOpen` 分流（不是写死一组）").toMatch(/nextOpen\s*\n?\s*\?/);
    

    expect(seg, "`isFloatExpand` 的阈值判据被删了（它管铺满/钉宽/float-layout，不只是透明度带）")
      .toMatch(/nextWidth\s*>\s*window\.innerWidth\s*\*\s*0\.\d+/);
  });
});

describe("A-1152 ⑯ 内容随比例自适应 + 过渡期钉宽（用户：「卡顿」「没随界面比例自适应」）", () => {
  it("CSS：`.right-body` 上限是「铺满 + 高上限」（A-1156 取代 A-1152 的 `min(620px, 62%)`）", () => {
    





    const m = /body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到浮层态的 right-body 规则").toBeTruthy();
    expect(m![1]).toMatch(/max-width:\s*min\(\s*(\d+)px\s*,\s*100%\s*\)/);
    expect(m![1].match(/max-width:\s*min\(\s*(\d+)px/)?.[1]).toMatch(/^\d+$/);
    expect(Number(m![1].match(/max-width:\s*min\(\s*(\d+)px/)?.[1])).toBeGreaterThanOrEqual(1200);
  });

  it("CSS：过渡期钉住 `.right-body`（消灭逐帧重排 = 用户的「很卡顿」）", () => {
    



    const m = /body\.float-layout\s+\.right-wrapper-anim\s+\.right-body\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(m, "找不到过渡期的 right-body 钉宽规则").toBeTruthy();
    expect(m![1]).toMatch(/width:\s*var\(--right-body-pin/);
    expect(m![1]).toMatch(/flex:\s*0\s+0\s+auto/);
    
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper-anim\s+\.right-sidebar\s*\{[^}]*overflow:\s*hidden/);
  });

  it("JS：过渡起点写 `--right-body-pin`、`done` 时**摘掉**（否则稳定态被钉死旧值）", () => {
    const at = APP_CODE.indexOf("--right-body-pin");
    expect(at, "找不到 --right-body-pin 的写入").toBeGreaterThan(-1);
    

    expect(APP_CODE).toMatch(/setProperty\("--right-body-pin"/);
    expect(APP_CODE).toMatch(/removeProperty\("--right-body-pin"\)/);
  });

  it("浮窗初始尺寸**变小**（用户：「你给我的大小乱七八糟，太大了」）", () => {
    const m = /const FLOAT_RATIO\s*=\s*\{\s*w:\s*([\d.]+)\s*,\s*h:\s*([\d.]+)\s*\}/.exec(APP_CODE);
    expect(m, "找不到 FLOAT_RATIO").toBeTruthy();
    
    expect(Number(m![1])).toBeLessThanOrEqual(0.6);
    expect(Number(m![2])).toBeLessThanOrEqual(0.6);
  });
});

describe("A-1152 ⑰ 浏览器页（webview）不受限宽（用户截图：网页被缩成中间一列）", () => {
  it("限宽选择器带 `:not(:has(webview))`", () => {
    





    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body/);
  });
});

describe("A-1152 ⑱ `float-layout` 命令式挂类必须**条件式**（回归：右栏收不起来 / 不自适应）", () => {
  it("`animateRightSidebar` 里 add 之前 200 字符内**有「是否窗口化」的 if 判据**", () => {
    






    const at = APP_CODE.indexOf("function animateRightSidebar");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 4000);
    const addAt = seg.indexOf('classList.add("float-layout")');
    expect(addAt, "找不到命令式挂类").toBeGreaterThan(-1);
    const before = seg.slice(Math.max(0, addAt - 200), addAt);
    








    expect(before, "add 之前没有「是否窗口化」的 if 判据 ⇒ 无条件挂类会永久残留").toMatch(
      /if\s*\(\s*isFloatExpand\s*\)/);
    
    expect(seg.slice(addAt, addAt + 300)).toMatch(/classList\.remove\("float-layout"\)/);
  });

  it("铺满整窗的规则带 `body.float-layout` 前缀（不挂类就不生效）", () => {
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s+\.right-sidebar/);
  });
});

