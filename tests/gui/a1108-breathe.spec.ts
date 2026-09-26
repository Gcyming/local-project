/**
 * tests/gui/a1108-breathe.spec.ts — 「执行中」状态胶囊 = **真·呼吸灯**的静态守卫。
 *
 * ## 用户原话（三轮）
 *
 * 1. A-1108：「执行中做了动画很好，但是是频闪效果看起来怪怪的，用呼吸灯特效吧」
 * 2. A-1109：「为什么这个执行中的文本不闪，只有后面的文本框闪？这个设计不好，我觉得
 *    二者应该是绑定的，同步闪动频率进行呼吸灯的闪烁。」
 *
 * ## 为什么第一版会「频闪」（探针实测的机械原因，不是审美）
 *
 * 探针 = 真 Chromium + 真 stylesheet + 确定性相位采样（`pause()` 后手动设 `currentTime`
 * 逐相位读计算值 —— 不用 rAF，隐藏窗口下 rAF 被降到 ~1fps，采样会混叠）。三轮实测：
 *
 * | 项 | A-1108 改前 | A-1108 第一版 | **当前（A-1109）** |
 * |---|---|---|---|
 * | 动画宿主 | 胶囊**自己** | `::before` | **胶囊自己**（用户要求与文字同步） |
 * | 关键帧属性 | `background-*` 十条 longhand ＋ `opacity` | 只有 `opacity` | 只有 `opacity` |
 * | 周期 | 1100ms | 2400ms | 2400ms |
 * | opacity 幅度 | 1.000 → 0.920 | 1.000 → 0.250 | 1.000 → **0.550** |
 *
 * 关键在第二行：`background` 简写被展开成 10 条 longhand ⇒ **每帧都要主线程重绘**；
 * 而流式期间主线程每帧都在解析 markdown + 重渲染 ⇒ 重绘帧被不规律地推迟 ⇒ 动画
 * **走时忽快忽慢**。再叠上 ①1.1s 的短周期、②0.08 的浅幅度 —— 用户看到的就是**不规则地闪**。
 * ⇒ 修法只能是把动画搬到**合成器属性**（`opacity`）上；"调慢一点"治不了根。
 *
 * ## 为什么第二版「字不闪只有框闪」（A-1109）
 *
 * 第一版把动画**只**放在 `::before` 上 ⇒ 只有底色在呼吸、文字恒定 ⇒ 观感分裂。
 * 用户要求「二者绑定、同步闪动」⇒ 动画搬回**胶囊自身**、仍然只动 `opacity`：
 * 文字与底色是**同一个元素**，一起淡入淡出 ⇒ **天然同频**，结构上不可能再分裂。
 * 幅度从 0.25→1 收到 **0.55→1**：文字最暗时仍有 55% 不透明度（可读）。
 *
 * ## 本文件锁什么
 *
 * G1 动画挂在**主规则**上（文字与底色同元素 ⇒ 同步）；底色由 `::before` 静态提供；
 *    必须 `isolation: isolate`（否则光晕被画到按钮背景之下）
 * G2 `::before` 形态正确（`inset: 0` + `border-radius: inherit` ⇒ **永不溢出盒子**），
 *    **且自己不挂动画**（否则两层各自呼吸 = 又不同步了）；
 *    **底色不许是全透明**（A-1109 补洞：`toMatch(/background-color\s*:/)` 会被 `transparent` 蒙混）
 * G3 关键帧**只动 `opacity`**（含阳性对照，防"取不到规则体所以恒绿"）
 * G4 节拍与幅度（≥2s / 峰 >0.95 / 0.5 ≤ 谷 ≤ 0.6 —— 谷值下界是**文字可读性**）
 * G5 `prefers-reduced-motion` 覆盖**跟着动画一起搬回主规则**；
 *    ⚠️ 选择器与规则体**都要查**（A-1109 补洞：只查体时 `…::before { animation: none }` 会漏判）
 * G6 反面：伪元素不许加 `box-shadow`（会被祖先 `overflow: hidden` 裁掉右半边）
 * G7 文字不许用透明填充色（防 A-1094「文字全透明 = 空白框格」重演）
 *
 * ⚠️ 只读落盘原文（不含截图、不含运行期 dump）。几何/时序类判断由探针在真渲染器里量，
 *    不在这里假装能算（A-1105 铁律）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const CSS = readFileSync(resolve(ROOT, "gui/src/renderer/index.css"), "utf8");

/** 剥注释：注释里写着"曾经是什么"（本文件上方就有一大段），不该被当成当前代码断言。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CSS_CODE = stripComments(CSS);

/** 取出某个选择器的**规则体**（第一个匹配）。找不到 → null（断言会红，不会假绿）。 */
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
    /* 正面（A-1109 的核心）：动画必须在**主规则**上。少了它，文字就不会跟底色一起呼吸
       —— 用户原话「为什么这个执行中的文本不闪，只有后面的文本框闪」。 */
    expect(main!, "呼吸动画不在主规则上 —— 文字与底色分属两层，会重新出现「字不闪只有框闪」")
      .toMatch(/animation:\s*slime-status-breathe/);
    /* 正面：底色交给伪元素 ⇒ 主规则把底色设成透明。 */
    expect(main!, "运行态主规则的底色必须透明（光晕由 ::before 提供）").toMatch(/background-color:\s*transparent/);
    /* ⚠️ 主规则里**不许**出现 `background`（简写）或任何颜色类动画属性 —— 那会退回
       「每帧主线程重绘」的频闪（G3 进一步锁死关键帧，两条一起构成完整防线）。 */
    expect(main!, "运行态主规则里出现了 background 简写 —— 简写重置 longhand，且颜色一动就是主线程重绘")
      .not.toMatch(/(^|[;\s])background\s*:/);
    /* 反面：`isolation: isolate` 不能省。`z-index: -1` 的伪元素会被画到**最近的层叠上下文**底部；
       动画期间父级 `opacity < 1` 确实会创建层叠上下文，但 **reduced-motion 关掉动画后
       `opacity` 恒为 1** ⇒ 那时唯一的上下文来源就是这条。 */
    expect(main!, "缺 isolation: isolate —— 减少动效时（动画被关、opacity 恒 1）光晕会掉到按钮背景之下")
      .toMatch(/isolation:\s*isolate/);
  });

  it("G2 `::before` 是**盒子内**的光晕（inset 0 + border-radius inherit），且**自己不挂动画**", () => {
    const before = ruleBody(CSS_CODE, RUN_BEFORE);
    expect(before, `找不到 ${RUN_BEFORE} —— 呼吸灯的底色层不见了`).toBeTruthy();
    /* inset: 0 ⇒ 与胶囊盒子严丝合缝。**这一条同时是"不会被裁掉"的保证**：
       光晕永不溢出盒子，所以祖先链上的 `overflow: hidden`（`.collapse > *` 就是）裁不到它。
       换成 `inset: -Npx` 或 box-shadow 就会溢出 ⇒ 右半边被裁（G6 锁反面）。 */
    expect(before!, "光晕必须 inset: 0（溢出盒子就会被祖先 overflow:hidden 裁掉）").toMatch(/inset:\s*0\s*;/);
    expect(before!, "光晕必须继承圆角，否则呼吸时四角露出方角").toMatch(/border-radius:\s*inherit/);
    expect(before!, "缺 z-index: -1 —— 光晕会盖在文字上，字被糊掉").toMatch(/z-index:\s*-1\s*;/);
    /* 阳性对照：这一层确实在画东西。 */
    expect(before!, "光晕没有背景色 —— 那它在画什么？").toMatch(/background-color\s*:/);
    /* ⚠️ A-1109 补洞：上面那条 `toMatch(/background-color\s*:/)` **只证明有这个属性**，
       `background-color: transparent` 同样满足它 —— 那等于没画。而这一层是**静态**的
       （呼吸由主规则的 opacity 统一驱动），它的底色就是 reduced-motion（动画被关、
       opacity 恒 1）下胶囊唯一的底色来源 ⇒ 透明 = 空白框格。旧版用 `opacity: 0` 表达同一
       失效，本仓的坏样本必须能打红这条。 */
    expect(before!, "光晕底色是**全透明** —— 等于没画（reduced-motion 下胶囊会变成空白框格）")
      .not.toMatch(/background-color\s*:\s*transparent/);
    /* 反面（A-1109）：这一层**不许**再自己挂动画。两层各自动 = 频率/相位无法保证一致，
       正是用户抱怨的「字和框不同步」的成因。呼吸只能有一个驱动源（主规则的 opacity）。 */
    expect(before!, "::before 自己又挂了动画 —— 与主规则两个驱动源，字和框的呼吸会不同步")
      .not.toMatch(/animation\s*:/);
  });

  it("G3 关键帧**只动 opacity**（合成器属性）—— 这是频闪的结构性根因", () => {
    /* ⚠️ 用 `\n\}` 收尾把匹配钳在**这个** keyframes 块的结尾：`([\s\S]*?)\}` 会在
       `0%, 100% { opacity: .25; }` 那一行就停下（假绿：只看到半块还"没违规"）。 */
    const kf = /@keyframes slime-status-breathe\s*\{([\s\S]*?)\n\}/.exec(CSS_CODE);
    expect(kf, "找不到 @keyframes slime-status-breathe").toBeTruthy();
    /* 阳性对照：确认抓到的**就是**那个块（含 50% 那一档），否则下面的空集合断言恒绿。 */
    expect(kf![1], "抓到的 keyframes 里没有 50% 档 —— 断言对象搞错了").toContain("50%");
    const decls = [...kf![1].matchAll(/([a-zA-Z-]+)\s*:/g)].map((m) => m[1]);
    expect(decls.length, "关键帧里一条声明都没有 —— 断言对象搞错了").toBeGreaterThan(0);
    /* 反面（核心）：`background` 系列一律不许出现在关键帧里。
       实测 A-1108 改前这里躺着 10 条 `background-*` longhand ⇒ 每帧主线程重绘 ⇒ 流式期走时不均 ⇒ 频闪。 */
    const bad = decls.filter((d) => d !== "opacity");
    expect(bad, `关键帧里出现了非合成器属性：${bad.join("、")}（会让动画每帧重绘 ⇒ 又变回频闪）`).toEqual([]);
  });

  it("G4 节拍与幅度：周期 ≥ 2s；峰 > 0.95（必须满亮）；0.5 ≤ 谷 ≤ 0.6（下界 = 文字可读）", () => {
    const main = ruleBody(CSS_CODE, RUN)!;
    const dur = /animation:\s*slime-status-breathe\s+([\d.]+)s/.exec(main);
    expect(dur, "解析不出呼吸周期").toBeTruthy();
    /* 1.1s 已在"抖"的区间（实测 A-1108 改前的值）；2s 是呼吸灯与闪烁的分界。 */
    expect(Number(dur![1]), `周期 ${dur![1]}s 太快 —— 快而浅的脉动正是"频闪"观感`).toBeGreaterThanOrEqual(2);
    /* ⚠️ 只锁"不小于/不大于"而不锁精确值：将来微调不该打红；但退回快而浅必须红。 */
    const kf = /@keyframes slime-status-breathe\s*\{([\s\S]*?)\n\}/.exec(CSS_CODE)![1];
    const vals = [...kf.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(vals.length, "关键帧里没有 opacity 档位").toBeGreaterThanOrEqual(2);
    /* ⚠️ 峰值阈值必须 > 0.95（**不能**写成 ≥ 0.9）：0.92 恰好是 A-1108 那一版的最小透明度 ——
       变异实测证明 `≥ 0.9` 会放过它（"永远差一点点亮"的浅脉动 = 用户眼里"没在动"）。
       ⇒ 这条不是随手取的数，是**被变异逼出来的**：峰值不到满亮就不算呼吸灯。 */
    expect(Math.max(...vals), "峰值没到满亮（>0.95）—— 浅而快的脉动正是「频闪/没在动」的观感")
      .toBeGreaterThan(0.95);
    const min = Math.min(...vals);
    /* 上界：幅度不够（谷太亮）看起来就是「一直在那儿」，没有呼吸感。 */
    expect(min, "谷值太亮（>0.6）—— 幅度不够，看起来就是「一直在那儿」，没有呼吸感").toBeLessThanOrEqual(0.6);
    /* ⚠️ **下界是 A-1109 新增的**：动画现在挂在**文字所在的那一层**上 ⇒ 谷值就是文字的
       最暗不透明度。谷值太低 = 文字在谷相位读不清（A-1094「文字看不见」的同族回归）。
       ⇒ 0.5 是"仍可读"的底线，与上界一起把幅度锁在一个既有呼吸感、又不牺牲可读性的区间。 */
    expect(min, "谷值太低（<0.5）—— 动画现在动的是**文字**那一层，太暗会让文字在谷相位读不清")
      .toBeGreaterThanOrEqual(0.5);
  });

  it("G5 减少动效的覆盖**跟着动画一起搬回主规则**（否则无障碍回退静默失效）", () => {
    /* ⚠️ `[^}]*?` 而不是 `[\s\S]*?`：`[\s\S]*?` 会跨过前面几个 reduced-motion 块的收尾 `}`，
       一路延到别处的规则体，于是抓到的"覆盖"其实是别的块（本仓在 a1106 的 ⑤ 上踩过）。
       用"不许出现 `}`"的字符类把匹配钳在**同一个 @media 块内**。 */
    /* ⚠️ A-1109 补洞：必须**同时**抓到「选择器」与「规则体」。只抓规则体时，覆盖若写成
       `.think-tool-status[data-running="1"]::before { animation: none }`，其规则体仍是
       `animation: none` ⇒ 前两条断言照过，而 `::before` 藏在**选择器**里 ⇒ 漏判。
       （这个洞是被迁移后的坏样本逼出来的：旧正则只 `([^}]*)\}` 抓体，选择器里的
        `::before` 永远抓不到 ⇒ 那条 `not.toMatch(/::before/)` 是**恒绿的假断言**。） */
    const mm = /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*?(\.think-tool-status\[data-running="1"\][^{]*?)\{([^}]*)\}/.exec(CSS_CODE);
    expect(mm, "找不到 prefers-reduced-motion 下打在**主规则**上的覆盖 —— 动画搬家了，覆盖没跟着搬").toBeTruthy();
    expect(mm![2], "覆盖里没有 `animation: none`").toMatch(/animation:\s*none/);
    /* 反面：覆盖**不许**打在 `::before` 上 —— 动画已经不在那一层了，等于没覆盖。
       （A-1108 第一版正是反过来踩的：动画在 ::before 而覆盖也跟着搬，两边一致所以是对的；
        A-1109 动画搬回主规则，覆盖必须同步搬回，否则 reduced-motion 用户反而唯一保留一条
        永不停歇的呼吸动画。） */
    expect(mm![1], "覆盖的选择器里带了 ::before —— 动画不在那一层，等于没有覆盖").not.toMatch(/::before/);
  });

  it("G6 反面：伪元素不许加 `box-shadow` 光晕（会被祖先 overflow: hidden 裁掉右半边）", () => {
    const before = ruleBody(CSS_CODE, RUN_BEFORE);
    expect(before, "找不到 ::before —— 断言对象搞错了").toBeTruthy();
    /* 胶囊贴着行右缘，祖先链上确实有 `overflow: hidden`（`.collapse > *`）。
       画到盒子外的光必定被裁 —— 与其加一个"有时看得见有时看不见"的光，不如不加。 */
    expect(before!, "::before 上又出现了 box-shadow —— 画到盒子外会被祖先 overflow:hidden 裁掉")
      .not.toMatch(/box-shadow\s*:/);
  });

  it("G7 文字不许用透明填充色（防 A-1094「文字全透明 = 空白框格」重演）", () => {
    const main = ruleBody(CSS_CODE, RUN)!;
    const before = ruleBody(CSS_CODE, RUN_BEFORE)!;
    expect(main, "运行态主规则没有给文字实体颜色").toMatch(/color:\s*var\(--accent\)/);
    /* 反面：透明填充色一旦回到这两块，文字就在某个相位（甚至全程）看不见。
       A-1094 那次翻车正是「背景被简写重置 + 填充色强制透明」两条叠出来的空白框格。
       ⚠️ A-1109 后动画会**带着文字一起**变淡 —— 那是**允许**的（用户点名要同步呼吸），
       但底线是：淡到 55% 仍然看得见，绝不是"透明"。 */
    for (const [tag, body] of [["主规则", main], ["::before", before]] as const) {
      expect(/-webkit-text-fill-color\s*:\s*transparent/.test(body), `${tag} 里出现了透明文字填充色`).toBe(false);
    }
    /* ⚠️ 前置 `(^|[;\s{])` 不能省：裸 `/color\s*:\s*transparent/` 会被本条自己的
       `background-color: transparent`（G1 要求的那句）命中 —— 断言在**正确实现**上恒红的
       同族形态，本仓踩过（`toContain` 前先确认字串唯一）。 */
    expect(/(^|[;\s{])color\s*:\s*transparent/.test(main), "运行态文字色被设成 transparent —— 会变成空白框格").toBe(false);
  });
});
