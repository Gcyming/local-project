



























































import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));
const CSS_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8"));


const markBody = (): string => {
  const m = /const mark = \(\): void => \{[\s\S]*?\n    \};/.exec(APP_CODE);
  expect(m, "取不到 RO 的 mark() 函数体（守卫自己失效了）").toBeTruthy();
  return m![0];
};











const fnBody = (name: string): string => {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^]*?\\n  \\}`).exec(APP_CODE);
  expect(m, `取不到 \`function ${name}\` 的函数体（守卫自己失效了）`).toBeTruthy();
  return m![0];
};


const constRhs = (name: string): string => {
  const m = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(APP_CODE);
  expect(m, `找不到 \`const ${name}\` 的声明（守卫自己失效了）`).toBeTruthy();
  return m![1].trim();
};


const constNum = (name: string): number => {
  const m = new RegExp(`const ${name}\\s*=\\s*([\\d.]+)\\s*;`).exec(APP_CODE);
  expect(m, `找不到 \`const ${name} = <数字>\`（守卫自己失效了）`).toBeTruthy();
  return Number(m![1]);
};

describe("A-1190 ① 淡出的触发源必须唯一（= 宽度真的变了）", () => {
  it("`slime-fading` 只有**两个**产地：`mark()` 与 `startChatDip()`，**都不在** resizer 起点里", () => {
    




    const n = (APP_CODE.match(/classList\.add\("slime-fading"\)/g) || []).length;
    expect(
      n,
      `\`classList.add("slime-fading")\` 出现 ${n} 次（应为 2：\`mark()\` + \`startChatDip()\`）。`
      + "多于 2 次 = 某个拖拽/缩放起点又在自己挂淡出 ⇒ 用户「点一下边缘就已经消失」会回来；"
      + "少于 2 次 = 某条路径压根不淡出",
    ).toBe(2);
    for (const fn of ["handleSidebarResize", "handleRightbarResize"]) {
      const head = fnBody(fn);
      expect(
        head,
        `${fn} 的起点又在无条件挂 fading ⇒ 用户"点一下边缘"（还没拖）聊天页就会消失`,
      ).not.toMatch(/classList\.add\("slime-fading"\)/);
      expect(
        head,
        `${fn} 的起点丢了 slime-dragging ⇒ 拖动头段不跟手 / 拖出蓝色选区`,
      ).toMatch(/classList\.add\("slime-dragging"\)/);
    }
    
    expect(markBody(), "`mark()` 里没有挂 fading ⇒ 拖拽/窗口 resize 那条路不淡出了")
      .toMatch(/classList\.add\("slime-fading"\)/);
    expect(fnBody("startChatDip"), "`startChatDip()` 里没有挂 fading ⇒ 凹陷压根不会开始")
      .toMatch(/classList\.add\("slime-fading"\)/);
  });

  it("①b 判据仍然是「宽度真的变了」（RO + `w === lastW` 短路），没退回窗口 resize", () => {
    expect(APP_CODE, "RO 的「只认宽度真变」短路没了 ⇒ 消息流入（高度变化）也会让文本淡出")
      .toMatch(/if \(w === lastW\) \{ return; \}/);
    expect(APP_CODE, "RO 不见了（退回旧的「窗口 resize 就淡出」语义）")
      .toMatch(/new ResizeObserver\(/);
    


    



    const at = APP_CODE.indexOf("new ResizeObserver(() =>");
    expect(at, "找不到聊天区那个 ResizeObserver 的回调（守卫自己失效了）").toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 700);
    expect(
      seg,
      "RO 回调里没有「先记 lastW 再 mark()」的顺序 ⇒ 让位期会留下陈旧宽度",
    ).toMatch(/lastW = w;[\s\S]{0,140}?mark\(\)/);
  });
});

describe("A-1190 ② 时长必须与侧边栏宽度过渡同源", () => {
  it("② `CHAT_FADE_MS` 的初值**字面就是** `SIDEBAR_WIDTH_MS`（不是手抄的 500）", () => {
    

    expect(
      constRhs("CHAT_FADE_MS"),
      "`CHAT_FADE_MS` 不再字面等于 `SIDEBAR_WIDTH_MS` ⇒ 聊天页淡出与侧边栏宽度过渡**不再同源**"
      + "（用户要的是「同步」，不是各调一个数去凑）",
    ).toBe("SIDEBAR_WIDTH_MS");
  });

  it("②b 凹陷的三个窗口都从 `SIDEBAR_WIDTH_MS` + 侧边栏**内容**窗口常量字面推导", () => {
    



    const cases: Array<[string, string[]]> = [
      ["CHAT_DIP_OUT_MS", ["SIDEBAR_WIDTH_MS", "LEFT_FADE_COLLAPSE_HI", "LEFT_FADE_COLLAPSE_LO"]],
      ["CHAT_DIP_IN_AT_MS", ["SIDEBAR_WIDTH_MS", "LEFT_FADE_LO"]],
      ["CHAT_DIP_IN_MS", ["SIDEBAR_WIDTH_MS", "LEFT_FADE_LO", "LEFT_FADE_HI"]],
    ];
    for (const [name, refs] of cases) {
      const rhs = constRhs(name);
      for (const r of refs) {
        expect(rhs, `\`${name}\` 的初值里没有引用 \`${r}\` ⇒ 它已经退化成手抄魔数（两侧必漂）`)
          .toContain(r);
      }
    }
  });

  it("⑧ 凹陷的**两段都落在侧边栏那 500ms 之内**（这才是「同步」；超出就是又一段尾巴）", () => {
    const full = constNum("SIDEBAR_WIDTH_MS");
    const outMs = Math.round(full * (constNum("LEFT_FADE_COLLAPSE_HI") - constNum("LEFT_FADE_COLLAPSE_LO")));
    const inAt = Math.round(full * constNum("LEFT_FADE_LO"));
    const inMs = Math.round(full * (constNum("LEFT_FADE_HI") - constNum("LEFT_FADE_LO")));
    expect(
      outMs,
      `凹陷的淡出 ${outMs}ms 不早于淡入起点 ${inAt}ms ⇒ 两段重叠（观感是先暗后亮来回抖）`,
    ).toBeLessThan(inAt);
    expect(
      inAt + inMs,
      `凹陷在 ${inAt + inMs}ms 才收工，超过侧边栏宽度过渡的 ${full}ms`
      + " ⇒ 后半段又只剩聊天页在动（用户报的「错开」回来）。三段式的总时长是 2×500=1000ms，"
      + "凹陷必须显著短于它、并落在 500ms 之内",
    ).toBeLessThanOrEqual(full);
  });

  




  const chatScrollBlocks = (): string[] => {
    const out: string[] = [];
    const re = /[^{}]*\.chat-scroll[^{}]*\{[^}]*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(CSS_CODE)) !== null) { out.push(m[0]); }
    return out;
  };

  it("⑫ CSS：两个方向**各读一个变量**，且都不许硬编码 0.12s", () => {
    const blocks = chatScrollBlocks();
    expect(
      blocks.length,
      `只取到 ${blocks.length} 个 \`.chat-scroll\` 规则块（守卫自己失效了）`,
    ).toBeGreaterThanOrEqual(3);
    const hardcoded = blocks.filter((b) => /0\.12s/.test(b));
    expect(
      hardcoded,
      `这些 \`.chat-scroll\` 规则里又出现硬编码 0.12s ⇒ 与侧边栏不同源（旧病）：\n`
      + hardcoded.join("\n---\n"),
    ).toEqual([]);
    


    const inBlocks = blocks.filter((b) => /transition:\s*opacity\s+var\(--chat-fade-in-dur/.test(b));
    const outBlocks = blocks.filter((b) => /transition:\s*opacity\s+var\(--chat-fade-out-dur/.test(b));
    expect(
      inBlocks.length,
      `读 \`--chat-fade-in-dur\` 的规则有 ${inBlocks.length} 条（应为 1：摘类方向的**常驻**规则）`,
    ).toBe(1);
    expect(
      outBlocks.length,
      `读 \`--chat-fade-out-dur\` 的规则有 ${outBlocks.length} 条（应为 1：挂类方向 = \`body.slime-fading\`）`,
    ).toBe(1);
    expect(
      inBlocks[0],
      "常驻规则（淡入方向）必须**不带 body 前缀** —— 写在类规则里则摘类时声明一起消失（硬跳，A-1153 ⑤）",
    ).toMatch(/(^|\n)\.chat-scroll\s*\{/);
    expect(
      outBlocks[0],
      "淡出方向必须挂在 `body.slime-fading` 规则里（与 opacity: 0 同一块）",
    ).toMatch(/body\.slime-fading\s+\.chat-scroll\s*\{/);
  });

  it("两个变量**真的被写**（否则 `var()` 永远走 fallback ⇒ 凹陷退化成 500ms+500ms）", () => {
    

    expect(APP_CODE, "没人写 `--chat-fade-out-dur` ⇒ 挂类方向永远走 fallback")
      .toMatch(/setProperty\("--chat-fade-out-dur"/);
    expect(APP_CODE, "没人写 `--chat-fade-in-dur` ⇒ 摘类方向永远走 fallback")
      .toMatch(/setProperty\("--chat-fade-in-dur"/);
    

    expect(fnBody("startChatDip"), "凹陷没写 `CHAT_DIP_OUT_MS` ⇒ 淡出仍用 500ms")
      .toMatch(/CHAT_DIP_OUT_MS/);
    expect(markBody(), "三段式没写 `CHAT_FADE_MS` / `CHAT_FADE_DRAG_MS` ⇒ 拖拽时长静默失效")
      .toMatch(/CHAT_FADE_DRAG_MS\s*:\s*CHAT_FADE_MS/);
  });
});

describe("A-1190 ③ 缓动必须与侧边栏宽度过渡同源（两份文本各自取值再比）", () => {
  const easeOf = (ruleHead: string, prop: "width" | "opacity"): string => {
    const re = new RegExp(
      `${ruleHead}\\s*\\{[^}]*transition:\\s*${prop}\\s+`
      + (prop === "width" ? "[\\d.]+s" : "(?:var\\([^)]*\\)|[\\d.]+m?s)")
      + "\\s+([^;]+);",
    );
    const m = re.exec(CSS_CODE);
    expect(m, `取不到 ${ruleHead} 的 transition: ${prop} 曲线（守卫自己失效了）`).toBeTruthy();
    return m![1].trim();
  };

  it("`.chat-scroll` 的曲线 == `.sidebar` 的曲线", () => {
    const bar = easeOf("(?:^|\\n)\\.sidebar", "width");
    const chat = easeOf("(?:^|\\n)\\.chat-scroll", "opacity");
    expect(
      chat,
      `聊天页淡出用 \`${chat}\`，侧边栏宽度用 \`${bar}\` ⇒ 两条曲线的快慢节奏不同`
      + "（用户要的是同步；旧实现是 0.12s linear vs 0.5s decelerate）",
    ).toBe(bar);
  });

  it("`.chat-scroll` 的曲线也 == `.right-sidebar` 的曲线（两栏口径一致）", () => {
    const right = easeOf("(?:^|\\n)\\.right-sidebar", "width");
    const chat = easeOf("(?:^|\\n)\\.chat-scroll", "opacity");
    expect(chat, "聊天页与右栏的曲线不同源 ⇒ 同一件事出现第二份曲线（铁律 11）").toBe(right);
  });
});

describe("A-1190 ④⑤⑥ 恢复时机与拖动分流（三段式那条路）", () => {
  it("④ `mark()` 里**没有** `150ms / 160ms` 那对固定延时（刻意错开的来源）", () => {
    const seg = markBody();
    expect(seg, "又出现了 `}, 150)` —— 那是变化停止后先进准备态的旧节奏，会让聊天页比侧边栏晚起步")
      .not.toMatch(/\},\s*150\s*\)/);
    expect(seg, "又出现了 `}, 160)` —— 旧实现靠它再等 160ms 才恢复，合计 310ms ⇒ 用户说的「刻意错开」")
      .not.toMatch(/\},\s*160\s*\)/);
    expect(seg, "恢复窗没用 `CHAT_SETTLE_MS`（又变成某个散落的魔数了）").toMatch(/CHAT_SETTLE_MS/);
  });

  it("⑤ 拖动期**不自动恢复**（否则拖动中途一次停顿就闪一次淡入再淡出）", () => {
    expect(
      markBody(),
      "恢复回调没短路 `slime-dragging` ⇒ 拖动中途停顿就会淡入、再动又淡出（闪）",
    ).toMatch(/contains\("slime-dragging"\)\s*\)\s*\{\s*return;\s*\}\s*\n\s*endChatFreeze\(\)/);
  });

  it("⑥ 拖动走短时长、几何走同源时长（`mark()` 里按 `slime-dragging` 分流）", () => {
    expect(APP_CODE, "`CHAT_FADE_DRAG_MS` 不见了 ⇒ 拖动路径要么用 500ms（掉帧）要么又硬编码")
      .toMatch(/const CHAT_FADE_DRAG_MS\s*=\s*(\d+)\s*;/);
    expect(
      markBody(),
      "`mark()` 没按 `slime-dragging` 在「拖动短时长 / 几何同源时长」之间分流"
      + "（拖动必须短：A-1152 的跳过布局只能在淡出走完后才挂）",
    ).toMatch(/contains\("slime-dragging"\)\s*\?\s*CHAT_FADE_DRAG_MS\s*:\s*CHAT_FADE_MS/);
  });

  it("⑥b 拖动短时长的值**必须短于**几何时长（否则那个分流没有意义）", () => {
    const drag = constNum("CHAT_FADE_DRAG_MS");
    const geom = constNum("SIDEBAR_WIDTH_MS");
    expect(
      drag,
      `拖动时长 ${drag}ms 不小于几何时长 ${geom}ms ⇒ 拖动时「跳过布局」会推迟到 ${geom}ms 之后（长会话拖动掉帧）`,
    ).toBeLessThan(geom);
  });
});

describe("A-1190② ⑦⑨⑩⑪ 几何动画走「凹陷」（点按钮时两侧栏与聊天页同起同落）", () => {
  it("⑦ `mark()` 把几何动画分流到 `startChatDip()`，且**顺序不可反**", () => {
    const seg = markBody();
    const iDip = seg.indexOf("if (chatDipActiveRef.current) { return; }");
    const iGeom = seg.indexOf("if (chatGeomAnimRef.current) { startChatDip(); return; }");
    expect(
      iDip,
      "`mark()` 少了「凹陷在飞 ⇒ 整个让位」那条短路 ⇒ RO 在过渡期逐帧重启凹陷，"
      + "「t=CHAT_DIP_IN_AT_MS 摘类」那条定时器永远到不了点（一直黑到宽度停住 + 200ms 尾巴）",
    ).toBeGreaterThan(-1);
    expect(
      iGeom,
      "`mark()` 没把几何动画分流到 `startChatDip()` ⇒ 点按钮仍走三段式"
      + "（总时长恒 2×SIDEBAR_WIDTH_MS = 用户报的「错开」）",
    ).toBeGreaterThan(-1);
    expect(
      iDip,
      "两条判据顺序反了（先判几何动画）⇒ 过渡期每一帧都会重启一次凹陷",
    ).toBeLessThan(iGeom);
    

    expect(
      iDip,
      "分流判据没放在 `mark()` 最前面（在写变量/挂类之后）⇒ 让位那一帧仍会先动一次淡出状态",
    ).toBeLessThan(seg.indexOf('classList.add("slime-fading")'));
  });

  it("⑨ 两端接线：`animate*Sidebar` 置位窗口、两个 resizer 起点作废凹陷", () => {
    for (const fn of ["animateLeftSidebar", "animateRightSidebar"]) {
      expect(
        fnBody(fn),
        `${fn} 没声明"这一轮宽度变化来自几何动画" ⇒ 点它聊天页仍走三段式（用户报的「点击折叠、`
        + "展开按钮时还是没同步」）",
      ).toMatch(/beginChatGeomFade\(\)/);
    }
    for (const fn of ["handleSidebarResize", "handleRightbarResize"]) {
      expect(
        fnBody(fn),
        `${fn} 的起点没作废凹陷 ⇒ 上一次点按钮留下的凹陷会在拖动途中把文本放出来`
        + "（= 用户「拖动时文本才消失」这条优化在拖拽路径上复发）",
      ).toMatch(/cancelChatDip\(\)/);
    }
  });

  it("⑩ 凹陷**同一轮只起一次**（否则摘类定时器被逐帧重置 ⇒ 一直黑到宽度停住）", () => {
    const seg = fnBody("startChatDip");
    expect(
      seg,
      "`startChatDip()` 没有「已在飞就返回」的短路 ⇒ RO 逐帧重启它，"
      + "摘类定时器（t=CHAT_DIP_IN_AT_MS）永远到不了点",
    ).toMatch(/if \(chatDipActiveRef\.current\) \{ return; \}/);
    expect(
      seg,
      "摘类定时器没落在 `CHAT_DIP_IN_AT_MS`（= 侧边栏内容开始出现那一拍）⇒ 与侧边栏不同拍",
    ).toMatch(/CHAT_DIP_IN_AT_MS/);
    expect(
      seg,
      "收工定时器没落在 `SIDEBAR_WIDTH_MS`（= 宽度过渡收工那一拍）⇒ 尾巴会重新出现",
    ).toMatch(/SIDEBAR_WIDTH_MS/);
    

    expect(
      seg.indexOf('setProperty("--chat-fade-out-dur"'),
      "两个时长变量没在 `classList.add(\"slime-fading\")` 之前写好 ⇒ 这一轮过渡仍用旧值（时长静默错位）",
    ).toBeLessThan(seg.indexOf('classList.add("slime-fading")'));
  });

  it("⑪ `endChatFreeze()` 也要清掉凹陷定时器（否则它在下一轮淡出时才到点、把类摘掉）", () => {
    


    expect(
      fnBody("endChatFreeze"),
      "`endChatFreeze()` 没调 `cancelChatDip()` ⇒ 滞留的「摘类」定时器会把随后新一轮淡出的 `slime-fading` "
      + "提前摘掉（淡出被腰斩）",
    ).toMatch(/cancelChatDip\(\)/);
  });
});
