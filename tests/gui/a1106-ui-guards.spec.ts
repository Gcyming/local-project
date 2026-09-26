/**
 * tests/gui/a1106-ui-guards.spec.ts — A-1106 六项 UI 修复的**静态守卫**。
 *
 * 为什么这六项全都要静态守卫：它们**全部属于「静默失效」家族** ——
 * 过 tsc、过构建、过所有逻辑测试，只在用户眼里翻车。实测出来的三条反例都在本仓发生过：
 *   · `.text-scan-light` 被同元素上的 `background` 简写重置 ⇒ 文字全透明（"空白框格"）；
 *   · resizer 的命中区与**它真的能被点到**必须成对：A-1111 起命中区跨出分隔线 6px，
 *     父级的裁剪（`overflow: clip` + `overflow-clip-margin`）必须同量放宽 —— 少任何一件
 *     ⇒「看着变宽、实际没变」，与 A-1106 那条是**同一个**静默失效（判据已迁移，见 ①）；
 *   · 产物卡宽度靠 `content-visibility` 的离散翻转 ⇒ 第 1 帧跳变，`transition` 白写。
 * 三条都能"改完看着像修好了"，而门禁全绿。
 *
 * ⚠️ 本 spec 只读**落盘原文**（不含截图、不含运行期 dump）—— A-1105 铁律：
 *    渲染结构只能从落盘原文 + 真渲染器 dump 取。几何类判断（圆心是否落在轴心等）
 *    由 `gui/scripts` 的探针在真渲染器里量，不在这里假装能算。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
/* A-1106 续轮：聚光的**位置驱动**是纯逻辑（只碰 `currentTarget` / `parentElement`），
   所以能直接行为驱动 —— 文本断言证明不了「值真的写到了父级」。 */
import { trackResizerGlint, clearResizerGlint } from "../../gui/src/renderer/resizerGlint.js";

const ROOT = resolve(__dirname, "../..");
const CSS = readFileSync(resolve(ROOT, "gui/src/renderer/index.css"), "utf8");
const PANEL = readFileSync(resolve(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");
const APP = readFileSync(resolve(ROOT, "gui/src/renderer/App.tsx"), "utf8");
const RSB = readFileSync(resolve(ROOT, "gui/src/renderer/pages/RightSidebar.tsx"), "utf8");
const GLINT_PATH = resolve(ROOT, "gui/src/renderer/resizerGlint.ts");

/** 剥注释：注释里写着"曾经是什么" / 用户原话，不该被当成当前代码断言。
 *  ⚠️ 若不做这一步，本 spec 的新注释自己就会把负面断言喂绿（本仓 §24「判据被兜住」家族）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CSS_CODE = stripComments(CSS);
const PANEL_CODE = stripComments(PANEL);

/** 剥掉 `@media { … }` 块（含花括号配对），返回**只在顶层**的规则文本。
 *
 *  ⚠️ 为什么必须有它：`.text-scan-light` 在 `@media (prefers-reduced-motion: reduce)` 里有一条
 *  **刻意的**覆盖 `.text-scan-light { animation: none; }` —— 它本来就**不该**声明背景。
 *  不剥 `@media` 就把它当成"扫光被改坏"的证据 ⇒ 守卫在**正确实现**上恒红（本次实测踩到：
 *  7 条红里有 1 条是守卫自己的误判，不是代码的问题）。**守卫误报同样要修，不是加白名单放行。** */
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
/** 只含顶层规则（无 `@media` 覆盖）的 CSS —— 问题 1 的 longhand 判据在这上面跑。 */
const CSS_TOP = stripAtMedia(CSS_CODE);

/** 取出某个选择器的**规则体**（第一个匹配）。找不到 → 返回 null（断言会红，不会假绿）。 */
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
    /* ⚠️ 在 **CSS_TOP**（已剥 `@media`）上扫：`prefers-reduced-motion` 那条覆盖**只关动画**、
       本来就不声明背景，拿它当"扫光被改坏"的证据是守卫自己的误判。 */
    while ((m = re.exec(CSS_TOP)) !== null) { bodies.push(m[1]); }
    expect(bodies.length, "找不到 .text-scan-light 规则 —— 扫光类可能被删了").toBeGreaterThan(0);
    for (const b of bodies) {
      /* 阳性对照：这条规则确实在声明背景（否则"没有简写"是废话，恒绿）。 */
      expect(b, "该规则里连 background-image 都没有 —— 断言对象搞错了").toMatch(/background-image\s*:/);
      /* 负面断言：`background` 简写会把 background-clip 重置成 border-box、
         background-image 重置成 none，而 -webkit-text-fill-color: transparent 无条件生效
         ⇒ 文字全透明。这正是用户截图里"空白框格"的**真根因**（A-1094 的"窄元素"归因已被实测推翻）。 */
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
    /* A-1106 恢复的是四处：状态行主句 · 思考过程 · 思考中… · 正在思考/思考与工具调用进行中。
       ⚠️ 计数型断言写成 `>= 1` 就等于没守 —— 只恢复一处也会绿。 */
    expect(count, `text-scan-light 出现 ${count} 次，应为 4 次（四处「正在动」文本）`).toBe(4);
    expect(/text-breathe/.test(PANEL_CODE), "text-breathe 又回到了 ChatPanel（A-1094 的过度替换复发）").toBe(false);
  });

  it("④ 工具卡状态胶囊**不得**挂扫光类（它有自己的 data-* 动画，挂上会被 background 简写重置）", () => {
    /* 胶囊由 `.think-tool-status` 设 `background: color-mix(...)` 简写 —— 同元素挂扫光 = 空白框格。
       它走 `data-running` / `data-settled` 专用动画。 */
    expect(PANEL_CODE).toMatch(/className="think-tool-status"/);
    expect(PANEL_CODE).toMatch(/data-running=\{statusPhase === "running" \? "1" : undefined\}/);
    expect(PANEL_CODE).toMatch(/data-settled=\{statusPhase === "settled" \? "1" : undefined\}/);
    /* 反面：class 字符串里不许把两个类拼在一起。 */
    expect(/think-tool-status[\s\S]{0,60}text-scan-light/.test(PANEL_CODE),
      "工具卡状态胶囊上又出现了 text-scan-light").toBe(false);
  });

  it("⑤ 无障碍：减动效下必须**只关动画**、不碰背景（上一条剥离 @media，这里补回它的覆盖）", () => {
    /* 剥 `@media` 是为了让 longhand 判据不误报；但那条覆盖本身**必须还在** —— 否则
       reduced-motion 用户会一直看扫光。于是"必须存在"与"必须只关动画"在这里一起锁。 */
    /* ⚠️ `[^}]*?` 而不是 `[\s\S]*?`：`[\s\S]*?` 会**跨过**前面那些
       `@media (prefers-reduced-motion: reduce)` 块的收尾 `}`，一路延到**主规则**的规则体，
       于是抓到的"覆盖"其实是主规则（本次实测：断言收到 `background-image: linear-grad…`）。
       用"不许出现 `}`"的字符类把匹配钳在**同一个 @media 块内**。 */
    const mm = /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*?\.text-scan-light\s*\{([^}]*)\}/.exec(CSS_CODE);
    expect(mm, "找不到 prefers-reduced-motion 下的 .text-scan-light 覆盖").toBeTruthy();
    expect(mm![1]).toMatch(/animation:\s*none/);
    /* 反面：覆盖里不许顺手写 `background: …` —— 简写会把 longhand 又重置一遍（真根因复发）。 */
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
    /* 至少要 > 9px：圆点左缘 -3 + box-shadow 环 -6 + 流式期 drop-shadow -9。
       小于它 = 光晕被最外层 `.collapse > * { overflow: hidden }` 切一刀（用户投诉的那一刀）。 */
    expect(Number(m![1]), `margin-left = ${m![1]}px，必须 >= 12px（旧值 7px 会切掉光晕）`).toBeGreaterThanOrEqual(12);
  });
});

describe("A-1106 问题 3：状态行（LiveStatusLine）字号已调大", () => {
  it("主句容器 14.5px / 副句 13px / 激励语 14px —— 三档都不得回落到改前值", () => {
    /* ⚠️ 只锁"不小于"而不锁精确值：将来微调不该打红；但回落到 13 / 11.5 / 13 必须红。 */
    const container = /padding:\s*"6px 0 10px 42px",\s*fontSize:\s*([\d.]+)/.exec(PANEL_CODE);
    expect(container, "解析不出 LiveStatusLine 容器字号").toBeTruthy();
    expect(Number(container![1])).toBeGreaterThanOrEqual(14.5);
    /* ⚠️ 锚点里 `"` 与 `)` 的**先后**不能凭印象写：源码是 `var(--text-dim)", fontSize:`，
       引号在括号**之后**（它闭合 style 字符串）。写成 `var\(--text-dim"\),`（引号在括号内）
       会**恒不命中** —— 本次实测踩到：守卫在正确实现上报「解析不出副句字号」，
       看起来像"字号没改"，其实是锚点自己写错了（本仓 §20「断言写反 = 假守卫」的同族：
       好在它是**假红**而不是**假绿**，红至少有人查）。 */
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
    /* ⚠️ A-1111：本用例**迁移**自旧判据「两个 resizer 整体落在父级内侧」——不是删除。
       旧判据的理由（当时成立）：父级是 `overflow: hidden`，`right: -Npx` 的越界部分
       **不参与命中测试**（旧值 -3px/6px 的真实可命中宽度只有 3px）⇒「看着变大、实际没变」。
       A-1111 起**需求反向**了（用户：「你这个判定范围怎么只往左增加？我想要的一直是左右同步
       增加相同位数的像素点判定范围」）⇒ 判据随之迁移为**两件必须同时成立的事**：
         ① 两侧对称（|offset| === width / 2，即跨出去、且跨得一样多）；
         ② 父级裁剪放宽到 ≥ 该外伸量（`overflow: clip` + `overflow-clip-margin: Npx`，N ≥ 外伸量）。
       少任何一件，这条改动就退化成**同一个静默失效**（外侧那半边的命中区根本不存在）——
       所以 ② 才是本用例的真判据，不能被 ① 的"几何看着对"兜住。 */
    const left = ruleBody(CSS_CODE, ".sidebar-resizer");
    const right = ruleBody(CSS_CODE, ".right-sidebar-resizer");
    expect(left, "找不到 .sidebar-resizer").toBeTruthy();
    expect(right, "找不到 .right-sidebar-resizer").toBeTruthy();

    /* 只按**关系**校验，不锁字面量（宽度将来还会变，判据不该跟着改）。 */
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
    /* ① 跨出去（负值）且左右对称。容差 0.5px：分隔线本身 1px 宽，中心线左右各差半像素是取整允许的。 */
    expect(lo, "左栏命中区没跨过分隔线（right 必须是负值 = 往外伸）").toBeLessThan(0);
    expect(ro, "右栏命中区没跨过分隔线（left 必须是负值 = 往外伸）").toBeLessThan(0);
    expect(Math.abs(Math.abs(lo) - lw / 2), "左栏命中区不对称（|right| 应等于 width / 2）").toBeLessThanOrEqual(0.5);
    expect(Math.abs(Math.abs(ro) - rw / 2), "右栏命中区不对称（|left| 应等于 width / 2）").toBeLessThanOrEqual(0.5);

    /* ② 裁剪必须真的放宽（**本用例的核心**）。`overflow-clip-margin` 只在 `overflow: clip` 下生效 ——
       两半都要锁：只写 margin 而 overflow 退回 hidden ⇒ margin 被忽略 ⇒ 外侧半边被静默裁掉。
       ⚠️ 这里**不能**用 `ruleBody`，也不能用「行首」锚定：`--rz-ramp` 那条规则的选择器写作
       `.sidebar,\n.right-sidebar {`，它的**第二行与顶层规则长得一模一样**（实测两次都撞上它，
       拿到的是渐变的 body ⇒ 断言对象搞错，而报错文本却像是"没违规"）。
       判据：该选择器所在的**上一行以 `,` 结尾 ⇒ 它是多行选择器列表的续行，跳过**。 */
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
    /* 正面：峰值位置 = var(--rz-y)（写成固定 50% = 不跟鼠标 = 用户点名的那条需求没了）。 */
    expect(ramp!, "聚光峰值必须跟随 --rz-y").toMatch(/var\(--rz-y,\s*50%\)/);
    expect(ramp!, "聚光峰值必须落在 var(--accent) 上（否则 hover 没有任何颜色变化）")
      .toMatch(/var\(--accent\)/);
    /* 斜坡半长 42% —— 这不是随手取的数：参考实现实测 |dy| 600px / 元素高 1428px = 42%。
       改成别的值不会报错、也不会被别的断言抓住，只在用户眼里"光带太短/太长"。 */
    expect(ramp!, "斜坡半长必须是实测出来的 42%").toMatch(/calc\(var\(--rz-y,\s*50%\)\s*-\s*42%\)/);
    expect(ramp!, "斜坡半长必须是实测出来的 42%").toMatch(/calc\(var\(--rz-y,\s*50%\)\s*\+\s*42%\)/);
  });

  it("④ 聚光画在父级**真 border** 上（border-image）；hover / 拖着拖 两态都亮；不允许任何覆盖层", () => {
    /* ⚠️ 「热」态必须 `:is(:hover, :active)`。只写 `:hover` 时：拖拽中指针被 pointer capture
       接管，一旦移出那 8px 命中区，`:has(...:hover)` 就不再命中 ⇒ 聚光**在拖拽中途熄灭**。
       真渲染器实测（`gui/scripts/_probe-glint.cjs`）：拖拽中 `hasSelHover=0` /
       `borderImageSource=none`，而同一次 `hasSelActive=1` ⇒ 补 `:active` 后
       `hasSelHot=1` / `borderImageSource=linear-gradient(...)`。
       这也是旧 CSS 里那个**从未被加上**的死选择器 `.is-hot` 的意图（拖动期保持流光）。 */
    expect(CSS_CODE, "左栏热态选择器不见了")
      .toMatch(/\.sidebar:has\(\.sidebar-resizer:is\(:hover,\s*:active\)\)/);
    expect(CSS_CODE, "右栏热态选择器不见了")
      .toMatch(/\.right-sidebar:has\(\.right-sidebar-resizer:is\(:hover,\s*:active\)\)/);
    /* 反面：退回「只 hover」⇒ 拖着拖着光没了（用户在拖动中看到流光熄灭）。 */
    expect(/\.sidebar:has\(\.sidebar-resizer:hover\)/.test(CSS_CODE),
      "左栏热态退回纯 :hover —— 拖拽期指针被拉出命中区，聚光会熄灭").toBe(false);
    expect(/\.right-sidebar:has\(\.right-sidebar-resizer:hover\)/.test(CSS_CODE),
      "右栏热态退回纯 :hover —— 拖拽期聚光会熄灭").toBe(false);
    const leftHot = ruleBody(CSS_CODE, ".sidebar:has(.sidebar-resizer:is(:hover, :active))");
    const rightHot = ruleBody(CSS_CODE, ".right-sidebar:has(.right-sidebar-resizer:is(:hover, :active))");
    expect(leftHot, "找不到左栏 hover 规则").toBeTruthy();
    expect(rightHot, "找不到右栏 hover 规则").toBeTruthy();
    /* 左栏分隔线在右侧 ⇒ slice `0 N 0 0` / width `0 Npx 0 0`；右栏镜像 ⇒ `0 0 0 N`。
       写反 = 渐变落在没有 border 的那条边上 = 什么都看不见（静默失效）。
       ⚠️ 厚度断言只写到**关系**（`> 1` 且左右相等），不锁字面量 3 —— 写死字面量会把
       「再调粗/调细一点」这种**合法**改动判成故障（本仓同类假红：a1113 ⑦⑧、a1106 ⑧）。
       但 `> 1` 这个下界是有意的：`border-width` 就是 1px，等于 1 等于「没变粗」——
       用户明确反馈过「拖拽光标太窄了，怎么这么细」（A-1117 拆掉 5px 带之后的过删）。 */
    const thickLeft = /border-image:\s*var\(--rz-ramp\)\s+0\s+(\d+)\s+0\s+0\s*\/\s*0\s+(\d+)px\s+0\s+0/;
    const thickRight = /border-image:\s*var\(--rz-ramp\)\s+0\s+0\s+0\s+(\d+)\s*\/\s*0\s+0\s+0\s+(\d+)px/;
    const mL = leftHot!.match(thickLeft);
    expect(mL, "左栏必须画在 border-right 上（slice/width 落在右侧）").toBeTruthy();
    expect(Number(mL![2]), "分隔线太细 —— 用户明确反馈过「拖拽光标太窄了，怎么这么细」").toBeGreaterThan(1);
    const mR = rightHot!.match(thickRight);
    expect(mR, "右栏必须画在 border-left 上（slice/width 落在左侧）").toBeTruthy();
    expect(Number(mR![2]), "左右两栏的分隔线粗细必须一致（否则一边细一边粗）").toBe(Number(mL![2]));
    /* stretch：1px 宽的切片沿分隔线铺满 —— 纵向渐变才不会被 `repeat` 切成一段段。 */
    expect(leftHot!, "聚光必须 stretch（repeat 会把渐变切成一段段）").toMatch(/stretch/);
    /* 反面①：resizer 里的覆盖层伪元素。
       ⚠️ A-1111 起理由**只剩一半**（如实更正，不留过时说明）：父级裁剪已放宽到 7px，
       「落在 border 上会被裁掉」不再成立；但「画在 padding box 内侧 1px 处会与真 border
       叠成 2px 亮线」照样成立。而且可见热带已在 A-1111 改用**元素自身背景**实现
       （`background-size` 限宽 + 居中）—— 再引入伪元素就是同一件事的**第二个产地**。 */
    expect(/\.sidebar-resizer::(before|after)|\.right-sidebar-resizer::(before|after)/.test(CSS_CODE),
      "resizer 里又出现了覆盖层伪元素（会与真 border 叠成 2px 亮线，且热带已有自身背景这个产地）").toBe(false);
    /* 反面②：又退回椭圆光斑（A-1106 上一版被用户判定「效果不对」的那个形状）。
       ⚠️ 必须**只在分隔条这一节**里查：body 背景那三条 `radial-gradient` 是合法的，
       全局查会把正确实现判红（"守卫在正确实现上恒红"本仓踩过一次，见本文件头部）。 */
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
    /* 变量名必须与 CSS 侧**逐字符**一致：写错 ⇒ CSS 读不到 ⇒ 聚光永远停在兜底 50%（静默失灵）。 */
    const varName = /const GLINT_VAR = "([^"]+)"/.exec(glint)?.[1];
    expect(varName, "解析不出聚光变量名 —— 断言对象搞错了").toBeTruthy();
    expect(CSS_TOP, `CSS 里没有 var(${varName}) —— 名字对不上，聚光不跟随`).toContain(`var(${varName}, 50%)`);
    /* 变量必须写在**父级**上：分隔线是父级的 border、渐变由父级的 border-image 画，
       而自定义属性只向下继承 —— 写在 resizer 自己身上父级读不到（静默失灵）。 */
    expect(glint, "聚光变量没写在父级上（父级读不到 ⇒ 不跟随）").toMatch(/const host = el\.parentElement/);
    expect(glint).toMatch(/host\.style\.setProperty\(GLINT_VAR/);
    /* 清理也要清**父级**上的同名变量，否则清不掉、聚光卡在最后一次的位置上。 */
    expect(glint, "clear 没清父级上的变量（聚光会卡在最后一个位置）")
      .toMatch(/parentElement\?\.style\.removeProperty\(GLINT_VAR\)/);
    expect(glint).toMatch(/export function trackResizerGlint/);
    expect(glint).toMatch(/export function clearResizerGlint/);
    /* 指针捕获时 `clientY` 能跑到元素之外 ⇒ 不钳位的话渐变中心会飞出元素、聚光整段消失。
       这是**真实行为**（不是"顺手加的防御"）⇒ 必须有守卫，否则删掉它谁都不知道。 */
    expect(glint, "流光位置不再钳到 [0,100] —— 拖拽中弧光会整段消失").toMatch(/Math\.max\(0, Math\.min\(100, pct\)\)/);
    /* 反面：宿主里自己写一次 = 流光位置有第二个定义（改一处不改另一处 = 两栏行为不一致）。 */
    expect(/--rz-y/.test(stripComments(APP)), "App.tsx 里自己写了 --rz-y（第二产地）").toBe(false);
    expect(/--rz-y/.test(stripComments(RSB)), "RightSidebar.tsx 里自己写了 --rz-y（第二产地）").toBe(false);
    /* 两栏都必须接上。 */
    expect(APP).toMatch(/onMouseMove=\{trackResizerGlint\}/);
    expect(APP).toMatch(/onMouseLeave=\{clearResizerGlint\}/);
    expect(RSB).toMatch(/onMouseMove=\{trackResizerGlint\}/);
    expect(RSB).toMatch(/onMouseLeave=\{clearResizerGlint\}/);
  });

  it("⑥ 行为：指针 Y 写到**父级**（渐变宿主）上，并钳到 [0,100]；resizer 自身的 style 一次都不许碰", () => {
    /* 为什么必须有行为断言：上面那些文本断言只能证明「那行字还在」。
       ⚠️ 这里的 resizer 故意做成「一碰 `style` 就抛」—— 实现若退回写自己身上，
       本用例会**响亮报错**而不是静默放过（父级读不到 ⇒ 聚光永远停在兜底 50%）。 */
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
    /** 把假对象塞进函数的类型槽（不引 React 运行时类型） */
    const ev = (o: object) => o as unknown as Parameters<typeof trackResizerGlint>[0];

    trackResizerGlint(ev({ currentTarget: resizer, clientY: 300 }));   // (300-100)/400 = 50%
    expect(host.style.props.get("--rz-y"), "指针 Y 没换算成百分比写到父级").toBe("50.00%");
    /* 钳位：[0,100]。指针捕获时 clientY 能跑到元素之外，不钳的话渐变中心飞出元素、聚光整段消失。 */
    trackResizerGlint(ev({ currentTarget: resizer, clientY: 9000 }));
    expect(host.style.props.get("--rz-y"), "下越界没钳到 100%").toBe("100.00%");
    trackResizerGlint(ev({ currentTarget: resizer, clientY: -1000 }));
    expect(host.style.props.get("--rz-y"), "上越界没钳到 0%").toBe("0.00%");
    /* 离开：清父级上的变量（回到 CSS 里的 `var(--rz-y, 50%)` 兜底位）。 */
    clearResizerGlint(ev({ currentTarget: resizer }));
    expect(host.style.props.has("--rz-y"), "离开后变量没清掉（聚光会停在最后一次的位置）").toBe(false);
    /* 无父级（脱离文档）⇒ 安全空操作，不许抛。 */
    expect(() => trackResizerGlint(ev({ currentTarget: { parentElement: null, getBoundingClientRect: () => ({ top: 0, height: 400 }), style: {} }, clientY: 50 }))).not.toThrow();
  });

  it("⑦ 可见效果**唯一产地**（原「可见热带」已被用户否决，A-1117 改为：resizer 不许自己画东西）", () => {
    /* 用户原话的后半句：「同时显示效果也统一随判定范围左右拓宽几个像素点的显示效果」。
       分隔线本身仍是 **1px**（A-1106 逐像素量出来的形状，不动）；新增的是用**元素自身背景**
       画的一条 5px 柔光竖带（不用伪元素 —— 理由见 ④ 的反面①与本 spec 对应 CSS 的头部）。
       ⚠️ 为什么这段必须有守卫（本轮实跑发现的真实缺口）：这条带子静止态是 `opacity: 0`，
       点亮**全靠一条独立的热态规则**（`.sidebar-resizer:is(:hover, :active), … { opacity: 1 }`）。
       把那条规则删掉 ⇒ 过 tsc、过构建、过 ①②③④⑤⑥ 全部用例，而用户看到的是
       「命中区确实宽了，但光标旁什么也没有」—— 与 A-1106「看着变宽、实际没变」是**同一个**
       静默失效家族（改完看着像修好了）。 */
    const left = ruleBody(CSS_CODE, ".sidebar-resizer");
    const right = ruleBody(CSS_CODE, ".right-sidebar-resizer");
    expect(left, "找不到 .sidebar-resizer").toBeTruthy();
    expect(right, "找不到 .right-sidebar-resizer").toBeTruthy();
    /* ⚠️⚠️ A-1117 **删掉**了原来这段（守「可见热带」= A-1111 用 resizer 自身背景画的 5px 柔光带），
       因为**那个设计已被用户否决**：原话「这个发光部分体感不对啊，怎么是覆盖在边界线上的？
       但凡仔细一看，我都感觉有点错位、臃肿感，**应该是边界线本身变化才对**」。
       实测确认它是**两条产地叠加**：5px 实心带 + 父级 border-image 的 1px 线。
       ⇒ 带子删除，改守**更上层的意图**：**可见效果只能有一个产地**（父级的 1px border 聚光）。
       （按铁律：锁「被否决方案」的守卫要**删掉**而不是留着 —— 留着就是假守卫。）
       命中区几何仍按**关系**校验（A-1109 的意图：不许再窄回去）。 */
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
    /* 静止不亮：既有观感一字不变（静止态该看到的是 A-1106 逐像素量过的那条 1px 线）。 */
    expect(left!, "左栏静止态必须 opacity: 0（否则日后加回的视觉会常驻）").toMatch(/opacity:\s*0\s*;/);
    expect(right!, "右栏静止态必须 opacity: 0").toMatch(/opacity:\s*0\s*;/);

    /* 热态：**两栏一起**点亮，且必须 `:is(:hover, :active)` ——
       拖拽期指针被 pointer capture 接管、`:hover` 会掉；只写 `:hover` 的话热带会在拖拽中途熄灭
       （与 ④ 给 `:has(...)` 补 `:active` 是**同一条理由**，两处必须一起改）。 */
    const hot = /\.sidebar-resizer:is\(:hover,\s*:active\)\s*,\s*\.right-sidebar-resizer:is\(:hover,\s*:active\)\s*\{([^}]*)\}/
      .exec(CSS_CODE);
    expect(hot, "找不到热带的热态规则（两栏一起点亮的那条）—— 热带将永远不亮").toBeTruthy();
    expect(hot![1], "热态没有把 opacity 置 1 —— 热带不会亮").toMatch(/opacity:\s*1/);
    /* 反面：退回纯 `:hover`。⚠️ 不会误伤正确实现 —— `.sidebar-resizer:is(:hover, …)` 里
       紧跟选择器名的是 `:is(`，不是 `:hover`。 */
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
    /* 正面：推进分支带 !gated 前提。 */
    expect(PANEL_CODE).toMatch(/const gated = !bodyGateRef\.current;/);
    expect(PANEL_CODE, "打字机推进没有被闸门挡住 —— 水位会在关闸期推到底，开闸时一个渐入都不播")
      .toMatch(/if \(!gated && shown\.length < full\.length\)/);
    /* 负面：自续条件里必须也有 !gated。写成 `if (displayPartialRef.current.length < …)` 会整轮空转。 */
    expect(PANEL_CODE, "自续没有加 !gated ⇒ 关闸期每帧空转").toMatch(/if \(!gated && displayPartialRef\.current\.length < partialRef\.current\.length\)/);
  });

  it("③ 开闸必须**点火**重启打字机（本轮已结束，不会再有 chunk 来调度）", () => {
    /* 这是本组最危险的静默失效：漏了它，正文会**永远停在空白**（比"没有渐入"严重得多）。 */
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
    expect(host!, "必须声明 width 过渡").toMatch(/transition:\s*width\s+var\(--collapse-dur\)/);
    const open = ruleBody(CSS_CODE, ".prod-host.is-open");
    expect(open, "找不到 .prod-host.is-open").toBeTruthy();
    expect(open!).toMatch(/width:\s*100%/);
  });

  it("② 宿主 div 真的挂上了类与展开态（CSS 写了但没人用 = 静默失效）", () => {
    expect(PANEL_CODE).toMatch(/className=\{`prod-host\$\{expanded === i \? " is-open" : ""\}`\}/);
  });

  it("③ 高度过渡仍归 .collapse（两层各管一轴，不许各调各的时长）", () => {
    const collapse = ruleBody(CSS_CODE, ".collapse");
    expect(collapse, "找不到 .collapse").toBeTruthy();
    expect(collapse!, "高度过渡必须用房颤唯一的 --collapse-dur").toMatch(/transition:[^;]*grid-template-rows\s+var\(--collapse-dur\)/);
  });
});
