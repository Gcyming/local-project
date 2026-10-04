/**
 * tests/core-ts/a1190-chat-fade-sync.spec.ts —— 聊天页让位淡入淡出的「触发 + 同步」（A-1190）。
 *
 * ## 用户诉求（原话）
 * 「现在的消失判定是**一点击侧边栏的边缘，还没有拖拽就消失**，这不对，改成只有发生
 *  **实质性比例变化**才会消失。还有，现在中间的渐入渐出都是与侧边栏**错开**设计的，
 *  即刻意的错开侧边栏与聊天页的消失、出现时间，这不对，这种刻意造成的结果是差劲的观感，
 *  改成**同步**的吧。」
 * 第二轮追加：「**点击折叠、展开按钮时**，侧边栏与中间对话栏的动画**还是没同步**」。
 *
 * ## 旧实现错在哪（三条彼此独立的病）
 * ① **触发**：`handleSidebarResize` / `handleRightbarResize` 的 `pointerdown` **无条件**
 *    `classList.add("slime-fading")` + 起一条 140ms 阶段定时器 ⇒ 用户只是**点一下**分栏边缘
 *    （还没拖）聊天页就开始淡出（真机探针里 down 那一帧 opacity 已经是 0.85）。
 * ② **时长不同源**：聊天页的 opacity 过渡写死 `0.12s linear`，与侧边栏宽度过渡
 *    （`0.5s cubic-bezier(0,0,0.2,1)` —— 两侧栏 + 几何同步 rAF 全都是这一组）**不同源**。
 * ③ ⚠️⚠️ **结构上不可能同步**（第二轮才定位到的那条）：`slime-fading` 的淡入只能发生在
 *    "宽度停住"（≈ `SIDEBAR_WIDTH_MS`）**之后**，而淡入自己又要一整个 `CHAT_FADE_MS`
 *    ⇒ 聊天页动画总时长**恒为 2 × `SIDEBAR_WIDTH_MS`**。
 *    真机实测（`probe-a1190-chat-fade.mjs`，CDP 逐帧）：点「收起左栏」⇒ 侧边栏宽度 486ms
 *    到位，聊天页 opacity 30→518ms 淡出、533→**1020ms** 才淡入回来
 *    ⇒ **后半段 500ms 侧边栏完全静止、只有聊天页还在动** = 用户说的「错开」。
 *    ⇒ 正解不是调参：几何动画的宽度时长是**已知常量**，有条件把淡入**搬进同一段**里
 *      （"凹陷"，见 `CHAT_DIP_*` 与 `startChatDip`）。
 *
 * ## 两条路（必须分得清，否则修一个坏一个）
 * | 路径 | 谁在推宽度 | 时长已知？ | 走的机制 |
 * |---|---|---|---|
 * | 拖拽分栏边缘 | 鼠标逐帧命令式 | 否（长度由用户决定） | 淡出（`CHAT_FADE_DRAG_MS`）→ 停住 → 淡入 |
 * | 窗口 resize | 系统 | 否 | 淡出（`CHAT_FADE_MS`）→ 停住 → 淡入 |
 * | **几何动画**（点按钮 / 拖到最窄吸附） | CSS 过渡 | **是**（`SIDEBAR_WIDTH_MS`） | **凹陷**：淡出 + 淡入都落进那 500ms |
 *
 * ## 本文件锚的不变量（每条都能被独立变异打掉）
 * | # | 不变量 | 判据 |
 * |---|---|---|
 * | ① | 淡出触发源**不是**拖拽起点 | 全文 `classList.add("slime-fading")` 计数 == 2，且两个 resizer 起点都不含它 |
 * | ①b | 触发判据是"宽度真的变了" | `mark()` 里的 `if (w === lastW) { return; }` 短路 + `new ResizeObserver` |
 * | ② | 时长**同源** | `CHAT_FADE_MS` 的初值**字面就是** `SIDEBAR_WIDTH_MS`（不是手抄的 500） |
 * | ②b | 凹陷三窗**同源** | `CHAT_DIP_*` 三条初值都字面引用 `SIDEBAR_WIDTH_MS` + `LEFT_FADE_*` |
 * | ③ | 缓动**同源** | 从 `.sidebar` / `.right-sidebar` / `.chat-scroll` **各自抽出**曲线再逐字比对 |
 * | ④ | 恢复**不再刻意错开** | `mark()` 里没有 `}, 150)` / `}, 160)`；恢复窗是 `CHAT_SETTLE_MS` |
 * | ⑤ | 拖动期**不自动恢复** | `mark()` 的恢复回调里有 `slime-dragging` 短路 |
 * | ⑥ | 拖动时长**真的接上了** | `mark()` 按 `slime-dragging` 在 `CHAT_FADE_DRAG_MS` / `CHAT_FADE_MS` 间分流并写进 CSS 变量 |
 * | ⑦ | 几何动画**分流到凹陷** | `mark()` 顶部有 `chatDipActiveRef` 让位 + `chatGeomAnimRef → startChatDip()`，且**顺序不可反** |
 * | ⑧ | 凹陷**两段都落在侧边栏窗口内** | `CHAT_DIP_IN_AT_MS + CHAT_DIP_IN_MS ≤ SIDEBAR_WIDTH_MS` 且 `CHAT_DIP_OUT_MS < CHAT_DIP_IN_AT_MS` |
 * | ⑨ | 凹陷的**两端接线** | 两个 `animate*Sidebar` 都调 `beginChatGeomFade()`；两个 resizer 起点都调 `cancelChatDip()` |
 * | ⑩ | 凹陷**同一轮只起一次** | `startChatDip` 首行 `if (chatDipActiveRef.current) { return; }`（否则 RO 逐帧重置摘类定时器） |
 * | ⑪ | 凹陷的定时器**会被清** | `endChatFreeze` 的**函数体**（`fnBody`）里调 `cancelChatDip()` |
 * | ⑫ | CSS 两向各一个变量 | `.chat-scroll` 常驻规则读 `--chat-fade-in-dur`；`body.slime-fading` 规则读 `--chat-fade-out-dur` |
 *
 * ⚠️ 判据风格与同目录其它 spec 一致：**先剥注释**再做形状断言（铁律 10）——
 *    本轮的注释里就逐字引用了 `classList.add("slime-fading")` 和 `0.12s linear`，
 *    不剥会把 ① 写成**恒假红**、把 ② 写成**假绿**。
 * ⚠️ 同源类断言一律「从两份文本各自取值再比对」，不手抄期望值 ——
 *    手抄的值迟早与两边都漂，而比较会一直「通过」（a1173 的教训）。
 * ⚠️ 判据**必须落在目标规则块/函数体之内**，不能全文搜（`.msg-hover` / `.tab-close`
 *    本来就带 `opacity 0.12s`，全文搜 = 恒假红）。
 * ⚠️⚠️ **"函数里有没有 X"一律用 `fnBody(name)`**（精确到函数体），**不要**用"从 `function X`
 *    起 N 字符"的窗口 —— N 会溢出到邻居 ⇒ 否定断言**恒绿**（本轮变异 M17 就是这样存活的）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));
const CSS_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8"));

/** 取 `const mark = (): void => { … };` 的函数体（收尾是缩进 4 空格的 `};`）。 */
const markBody = (): string => {
  const m = /const mark = \(\): void => \{[\s\S]*?\n    \};/.exec(APP_CODE);
  expect(m, "取不到 RO 的 mark() 函数体（守卫自己失效了）").toBeTruthy();
  return m![0];
};

/** 取 `function <name>(…) { … }` 的**函数体**（到下一个顶格 `  }` 为止）。
 *  ⚠️⚠️ **否定断言（"函数里不许有 X"）必须用它**，不要用"从 `function X` 起 N 字符的窗口"——
 *     N 往往会溢出到**下一个**函数，把邻居的内容一起吸进来。实测（本轮）：
 *     `endChatFreeze` 的函数体只有 ~635 字符，用 1400 的窗口会吸进后面 **2 个**函数，
 *     于是 `toMatch(/cancelChatDip\(\)/)` 那条**永远是绿的** ⇒
 *     变异 M17（把 `cancelChatDip()` 从 `endChatFreeze` 里删掉）**直接存活**。
 *     这正是"守卫自己空转"：红/绿都不是它在说话（铁律 5/31）。判据必须**钉在函数体内**。
 *  ⚠️ 各函数体实测长度（供将来核对窗口够不够）：`endChatFreeze` 635 / `startChatDip` 1073 /
 *     `handleSidebarResize` 3289 / `handleRightbarResize` 2630 /
 *     `animateLeftSidebar` 1294 / `animateRightSidebar` 3835。 */
const fnBody = (name: string): string => {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^]*?\\n  \\}`).exec(APP_CODE);
  expect(m, `取不到 \`function ${name}\` 的函数体（守卫自己失效了）`).toBeTruthy();
  return m![0];
};

/** 取常量声明的字面右值（先剥注释 ⇒ 结果只含代码）。 */
const constRhs = (name: string): string => {
  const m = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(APP_CODE);
  expect(m, `找不到 \`const ${name}\` 的声明（守卫自己失效了）`).toBeTruthy();
  return m![1].trim();
};

/** 取纯数字常量（`const X = 500;`）。 */
const constNum = (name: string): number => {
  const m = new RegExp(`const ${name}\\s*=\\s*([\\d.]+)\\s*;`).exec(APP_CODE);
  expect(m, `找不到 \`const ${name} = <数字>\`（守卫自己失效了）`).toBeTruthy();
  return Number(m![1]);
};

describe("A-1190 ① 淡出的触发源必须唯一（= 宽度真的变了）", () => {
  it("`slime-fading` 只有**两个**产地：`mark()` 与 `startChatDip()`，**都不在** resizer 起点里", () => {
    /* 用户原话：「一点击侧边栏的边缘，还没有拖拽就消失」——
       旧实现里两个 resizer 的起点各挂一次（连用户「按下」都算触发）。
       ⚠️ A-1190② 之后合法产地是 **2** 个：RO 的 `mark()`（拖拽 / 窗口 resize 那条三段式）
          与 `startChatDip()`（几何动画那条凹陷）。**两个 resizer 起点依然是 0 个** ——
          那条不变量（"点一下边缘不该淡出"）一字未变，见下面的逐函数断言。 */
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
    /* 两个合法产地各自必须真的在对应函数里（否则计数是"在别处又加回了旧写法"）。 */
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
    /* ⚠️ 短路与"记录宽度"都必须在 `mark()` **之前** —— 凹陷期间 `mark()` 会让位，
       若 `lastW` 也跟着不让位就会留一个**陈旧宽度**：下一次高度变化（流式输出）
       会因 `w !== lastW` 被误判成"宽度变了" ⇒ 文本平白淡出（铁律 5：静默失效要堵死）。 */
    /* ⚠️ 判据必须钉在**聊天区那个** ResizeObserver 的回调里：
       `new ResizeObserver(` 在 App.tsx 里出现 ≥2 次（另一个是 `attachLeftWidthObserver(sync)`），
       用 `indexOf` 取第一个会取错对象 ⇒ 守卫**假红**（实测踩过）。
       `new ResizeObserver(() =>` 才是本处这个（另一个传的是具名函数）。 */
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
    /* 判据取「常量名」而不是「数值相等」：手抄一个 500 也能通过数值比较，
       而那正是「同一事实写两处必漂」的开端（铁律 11）。 */
    expect(
      constRhs("CHAT_FADE_MS"),
      "`CHAT_FADE_MS` 不再字面等于 `SIDEBAR_WIDTH_MS` ⇒ 聊天页淡出与侧边栏宽度过渡**不再同源**"
      + "（用户要的是「同步」，不是各调一个数去凑）",
    ).toBe("SIDEBAR_WIDTH_MS");
  });

  it("②b 凹陷的三个窗口都从 `SIDEBAR_WIDTH_MS` + 侧边栏**内容**窗口常量字面推导", () => {
    /* ⚠️ 这是"同步"的真正判据：凹陷的窗口 = 侧边栏**内容**自己那两个窗
       （收起 `[0, LEFT_FADE_COLLAPSE_HI]`、展开 `[LEFT_FADE_LO, LEFT_FADE_HI]`），
       乘上同一个 `SIDEBAR_WIDTH_MS` ⇒ 三个动效共用同一个时钟。
       ⇒ 若这里退化成手抄的 135 / 200 / 275，侧边栏改窗口时聊天页就**静默不同步**。 */
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

  /** 取所有「选择器里含 `.chat-scroll`」的规则块。
   *  ⚠️ 判据必须**落在这几条规则内**，不能全文搜 `0.12s` ——
   *     本文件里 `.msg-hover` / `.tab-close` 等无关规则本来就有 `opacity 0.12s`，
   *     全文搜会把它们算进来 ⇒ **恒假红**（守卫自己坏掉，而非代码坏）。
   *  `[^{}]*` 不跨 `}` ⇒ 逐块精确，不会把前一条规则的选择器吸进来。 */
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
    /* 挂类（淡出）规则读 out、常驻（淡入）规则读 in —— 各**恰好**一处。
       ⚠️ 合成一条断言（`var(--chat-fade-` 计数 == 2）挡不住"两个方向写成同一个变量"：
          那样凹陷的"淡出 135ms + 淡入 275ms"会退化成同一个数（方向半拍错位）。 */
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
    /* ⚠️ 这是「静默失效」家族：CSS 有 fallback ⇒ JS 忘了写也不会报错，
       只是凹陷静默退化成"两个 500ms"（= 又变回 2× 时长，用户报的现象回来）。 */
    expect(APP_CODE, "没人写 `--chat-fade-out-dur` ⇒ 挂类方向永远走 fallback")
      .toMatch(/setProperty\("--chat-fade-out-dur"/);
    expect(APP_CODE, "没人写 `--chat-fade-in-dur` ⇒ 摘类方向永远走 fallback")
      .toMatch(/setProperty\("--chat-fade-in-dur"/);
    /* ⚠️ 凹陷写的是 `CHAT_DIP_*`、三段式写的是 `CHAT_FADE_*` —— 两边都要有，
       否则"某一条路径的时长静默落回另一个值"。 */
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
    /* ⚠️ 这两条必须在 `mark()` **最前面**（在写时长变量/挂类之前），
       否则"让位"的那一帧仍会先挂上类、把凹陷的淡入节奏打乱。 */
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
    /* ⚠️ 两个方向的时长必须在挂类**之前**写：transition 时长取的是"变化后样式"里
       解析出来的值，晚一帧写就等于这一轮还是用旧值。 */
    expect(
      seg.indexOf('setProperty("--chat-fade-out-dur"'),
      "两个时长变量没在 `classList.add(\"slime-fading\")` 之前写好 ⇒ 这一轮过渡仍用旧值（时长静默错位）",
    ).toBeLessThan(seg.indexOf('classList.add("slime-fading")'));
  });

  it("⑪ `endChatFreeze()` 也要清掉凹陷定时器（否则它在下一轮淡出时才到点、把类摘掉）", () => {
    /* ⚠️ 必须用 `fnBody`（不是 `fnSrc(N)`）：`endChatFreeze` 只有 ~635 字符，用 1400 的窗口会
       溢出到后面的 `handleSidebarResize`（那里也有 `cancelChatDip()`）⇒ 这条断言**永远绿**，
       变异 M17 直接存活（实测踩到，正是本轮把窗口换成 `fnBody` 的原因）。 */
    expect(
      fnBody("endChatFreeze"),
      "`endChatFreeze()` 没调 `cancelChatDip()` ⇒ 滞留的「摘类」定时器会把随后新一轮淡出的 `slime-fading` "
      + "提前摘掉（淡出被腰斩）",
    ).toMatch(/cancelChatDip\(\)/);
  });
});
