/**
 * tests/gui/a1061-visual.spec.ts — 本轮"看得见"的三处改动守卫（A-1061⑨/⑬/⑭）。
 *
 * 为什么需要这个文件：这三处都属于**静默失效**类 —— 改动过 tsc、过构建、过所有逻辑测试，
 * 只在用户眼里翻车（"字还是那么细" / "还是一整块蹦出来" / "思考历程跟正文混成一个样"）。
 *   ① 字号 / 字形栈：正文与用户气泡必须比思考历程**大一档**（层级差是设计规范），
 *      且 markdown 代码块（用户点名"code、powershell 这些栏目内的文本"）不许再发虚；
 *   ② 流式渐入：尾巴切分的三条边界（未闭合围栏 / 未闭合行内 code / 单字符切拉丁词）；
 *   ③ 激励语：11.5px 最暗色斜体（三个"看不清"叠一起）已改掉。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitStreamFade, unitize, STREAM_FADE_TAIL_MAX,
} from "../../gui/src/renderer/pages/streamFade.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS = readFileSync(join(ROOT, "gui/src/renderer/index.css"), "utf8");
const PANEL = readFileSync(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");

/** 剥注释：注释里写着"曾经是什么"，不该被当成当前值。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CSS_CODE = stripComments(CSS);

/** 取某个选择器块的内容（只取第一个匹配；块内不含嵌套 `}`）。 */
function rule(sel: string, src = CSS_CODE): string {
  const at = src.indexOf(sel);
  expect(at, `找不到选择器 ${sel}`).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  const close = src.indexOf("}", open);
  return src.slice(open + 1, close);
}

/** 取某个 `className="X"` 元素的**开标签**文本（TSX 里字号写在 inline style 上，
 *  不能用 CSS 选择器那套找 —— 类名在 TSX 里没有前导点）。 */
function jsxTag(cls: string, src = PANEL): string {
  const at = src.indexOf(`className="${cls}"`);
  expect(at, `找不到 className="${cls}"`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf(">", at));
}

// ── ① 字号层级 ────────────────────────────────────────────────────────────
describe("A-1061⑨ 字号 / 字形栈：正文 > 思考，且层级差必须保住", () => {
  it("正文与用户气泡 = 15px（此前实际是 14px，与注释宣称的 15px 不符）", () => {
    expect(jsxTag("msg-body-text")).toContain("fontSize: 15");
    expect(jsxTag("msg-user-bubble")).toContain("fontSize: 15");
    expect(jsxTag("stream-partial")).toContain("fontSize: 15");
  });

  it("正文 / 用户气泡共用**同一套**黑体优先字形栈 + antialiased（清晰度的主来源）", () => {
    const blk = rule(".stream-partial,");
    expect(blk).toContain("PingFang SC");
    expect(blk).toContain("Microsoft YaHei");
    expect(blk).toContain("-webkit-font-smoothing: antialiased");
  });

  it("🐛 思考历程**不许**跟着改：12.5px + 降级色（上一回就是把两者改成一个样子）", () => {
    const blk = rule(".think-step-text {");
    expect(blk).toContain("font-size: 12.5px");
    // 层级差：正文 15 > 思考 12.5
    expect(15).toBeGreaterThan(12.5);
  });

  it("markdown 代码块（code / powershell 栏目内文本）不再发虚", () => {
    const blk = rule(".markdown-body pre code");
    const size = Number(/font-size:\s*([\d.]+)px/.exec(blk)?.[1]);
    const weight = Number(/font-weight:\s*(\d+)/.exec(blk)?.[1]);
    // 此前继承 14px + 500 → 比行内 code（14px/600）细一档，用户点名为"这么细"
    expect(size, "块内代码字号没提上来").toBeGreaterThanOrEqual(14.5);
    expect(weight, "块内代码字重没提上来").toBeGreaterThanOrEqual(600);
    // Consolas 只覆盖 ASCII —— 中文注释必须有黑体 fallback，否则回退到极细的宋体
    expect(blk).toContain("Microsoft YaHei");
  });

  it("激励语不再是「11.5px + 最暗 + 斜体」三连（看不清的三个来源）", () => {
    const at = PANEL.indexOf("{cheer && (");
    expect(at).toBeGreaterThan(-1);
    const blk = PANEL.slice(at, at + 200);
    /* A-1106 问题 3 迁移：用户要求「正在思考下面那一块字体调大」⇒ 激励语 13 → **14px**。
       判据从「钉死 13」改成「钉可读性下限」—— 意图（不许退回 11.5px 又小又暗）不变，
       且仍被变异打红（`mut-a1061-visual.mjs` #6 = 14 → 11.5）。 */
    const size = Number(/fontSize:\s*([\d.]+)/.exec(blk)?.[1]);
    expect(size, "激励语块里找不到 fontSize —— 断言对象搞错了").not.toBeNaN();
    expect(size, "激励语字号没提上来（退回 11.5px 那种看不清）").toBeGreaterThanOrEqual(13);
    expect(blk).toContain("fontWeight: 500");
    expect(blk).not.toContain("fontStyle");
    expect(blk).not.toContain("--text-muted");
  });

  // A-1095：用户原话「你把激励语换个行，换到最后一行……有时候激励语过长会出现自动换行的问题」。
  // 判据 = 激励语必须**退出主句的行内流**：它所在的容器是 `flexDirection: "column"`（两行式），
  // 且**不在**那一层带 `flexWrap: "wrap"` 的主句行里 —— 否则长激励语会把主句挤到下一行。
  it("🐛 激励语独占最后一行：不许再与主句同级 flex-wrap（长文本会挤跑主句）", () => {
    const at = PANEL.indexOf("{cheer && (");
    expect(at, "找不到激励语渲染点").toBeGreaterThan(-1);
    // 回溯到它所在容器的开标签：column 容器在 cheer 之前、且是最近的 `flexDirection` 声明
    const before = PANEL.slice(0, at);
    const colAt = before.lastIndexOf('flexDirection: "column"');
    expect(colAt, "激励语不在 column（两行式）容器内 —— 会退回行内流").toBeGreaterThan(-1);
    // 主句行（带 flex-wrap）必须是 column 容器**内部**、且已闭合的兄弟节点：
    // 位置在 column 开标签之后，且在 cheer 之前已经出现过 `</div>`（该行已闭合）
    const wrapAt = before.lastIndexOf('flexWrap: "wrap"');
    expect(wrapAt, "主句行没带 flex-wrap").toBeGreaterThan(-1);
    expect(wrapAt, "主句 flex-wrap 行不在 column 容器内 —— 结构被改坏了").toBeGreaterThan(colAt);
    const seg = PANEL.slice(colAt, at);
    expect(seg, "主句 flex-wrap 行没有在激励语之前闭合 —— 说明 cheer 仍待在主句行里")
      .toContain("</div>");
  });
});

// ── ② 流式渐入切分（纯逻辑）────────────────────────────────────────────────
describe("A-1061⑬ 流式尾巴切分：逐单元渐入（方向见 A-1065），且不许把代码块切碎", () => {
  it("空串 → 两边都空（调用方会渲染「正在思考」，零行为变化）", () => {
    expect(splitStreamFade("")).toEqual({ settled: "", linePrefix: "", tail: "", units: [] });
  });

  it("普通短句 → 前缀为空、尾巴是全文、逐单元带上**绝对**索引", () => {
    const s = splitStreamFade("你好世界");
    expect(s.settled).toBe("");
    expect(s.tail).toBe("你好世界");
    expect(s.units.map((u) => u.text)).toEqual(["你", "好", "世", "界"]);
    expect(s.units.map((u) => u.at)).toEqual([0, 1, 2, 3]);
  });

  it("🐛 未闭合代码围栏 → 整段退让（否则尾行会被渲染在 </pre> **外面**）", () => {
    const shown = "说明：\n```powershell\nGet-Item tmp";
    expect(splitStreamFade(shown).tail, "代码块没退让，代码会跑出黑框").toBe("");
    expect(splitStreamFade(shown).settled).toBe(shown);
    // 围栏闭合后就恢复正常渐入
    expect(splitStreamFade(`${shown}\n\`\`\`\n后面的话`).tail).not.toBe("");
  });

  it("🐛 行内 code 未闭合 → 同样整段退让", () => {
    const shown = "看看 `npm run build 的输出";
    expect(splitStreamFade(shown).tail).toBe("");
    expect(splitStreamFade("看看 `npm run build` 的输出").tail).toBe("看看 `npm run build` 的输出");
  });

  it("🐛 拉丁单词必须连成一段（单字符切会让浏览器在任意位置断行 → configu ration）", () => {
    const units = unitize("Hello world foo");
    expect(units.map((u) => u.text)).toEqual(["Hello", " ", "world", " ", "foo"]);
  });

  it("CJK 逐字成单元，空白连成一段（保留多空格宽度）", () => {
    expect(unitize("中文  词").map((u) => u.text)).toEqual(["中", "文", "  ", "词"]);
  });

  it("尾巴**一定不含换行**（起点永远落在最后一个换行之后）", () => {
    const shown = "第一行\n第二行还在吐";
    const s = splitStreamFade(shown);
    expect(s.tail).not.toContain("\n");
    expect(s.settled).toBe("第一行\n");
    expect(s.tail).toBe("第二行还在吐");
  });

  it("长行：只把**末尾**一段当尾巴，前半段落回静态文本（行内语法快速定型）", () => {
    /* A-1070 迁移：本用例原本断言 `tail.length === maxTail`（旧实现按字符截断）。
       新实现改成「窗口在**单元边界**上从尾部回着取」，因此尾巴长度**不再恒等于** maxTail
       （超长单元会整块渐入，见下一条）。
       A-1080 迁移：`settled` 改为**止于最后一个换行**，所以"窗口之前的那半行"落在 `linePrefix`
       而不是 `settled` —— 判据从 `settled.length` 升级为 `settled.length + linePrefix.length`。 */
    const shown = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const s = splitStreamFade(shown);
    expect(s.tail.length).toBeGreaterThanOrEqual(STREAM_FADE_TAIL_MAX);
    expect(s.tail.length).toBeLessThan(STREAM_FADE_TAIL_MAX + 8); // 只在单元边界上多一点点
    // 这一行**没有换行** ⇒ 没有"已定型的块"可交回 Markdown，前半段落成静态文本
    expect(s.settled).toBe("");
    expect(s.linePrefix.length, "窗口之前的那半行必须落成静态文本").toBeGreaterThan(0);
    // 窗口起点 = 首单元的绝对索引（三者同源；任何一处单独漂移都会让 key 抖动）
    expect(s.settled.length + s.linePrefix.length).toBe(s.units[0].at);
    expect(s.tail).toBe(shown.slice(s.units[0].at));
    // A-1080 的核心：三段拼接**逐字等于原文**（接缝不插任何字符）
    expect(s.settled + s.linePrefix + s.tail).toBe(shown);
  });

  it("A-1070：超长单元**整块**渐入，不许切成半截（切碎会让 key 抖动、动画每帧重播）", () => {
    // 单个 300 字符的 ASCII 连写是**一个单元**（拉丁词必须连成一段，见下一条守卫）
    const shown = "x".repeat(300);
    const s = splitStreamFade(shown);
    expect(s.units).toHaveLength(1);
    expect(s.units[0].at).toBe(0); // 行首锚定 → 前缀推移不会让它变号
    expect(s.tail).toBe(shown); // 整块，而不是末尾 48 个字符
    expect(s.settled).toBe("");
    expect(s.linePrefix, "整行都在尾巴里 ⇒ 没有「窗口之外的半行」").toBe("");
  });

  it("A-1070：窗口边界必须落在**单元起点**上（不许把单元切成半截）", () => {
    const shown = `${"前".repeat(43)} ${"x".repeat(100)}`;
    const s = splitStreamFade(shown);
    expect(s.units).toHaveLength(1);
    expect(s.tail).toBe("x".repeat(100)); // 整块渐入，不是末尾 48 个字符
    expect(s.settled.length + s.linePrefix.length).toBe(s.units[0].at);
    expect(s.settled.length + s.linePrefix.length).toBe(44); // 43 个 CJK + 1 个空格
  });

  it("A-1080：接缝必须落在**真实换行**上（否则最后半行被 Markdown 块截断 → 尾端留空白 + 整段往上挤）", () => {
    /* 用户实测原话：「下面最后一排吐字…看到倒数第二排了吗，这个空白就是在等待下面一排的
       吐字吐满向上挤着排列」。
       根因：`settled` 交给 Markdown 渲染成**块**，尾巴是它后面的行内 span。若 settled 以
       **半行**结尾，Markdown 块的最后一行就是半行（尾端留空白），尾巴只能从下一行开始；
       窗口一滑动就把半行并回去 → 整段重排（"往上挤"）。
       ⇒ 判据：`settled` 只允许**止于换行**（以 \n 结尾，或为空），
         且三段拼接恒等于原文（接缝不插字符、不丢字符）。 */
    const multi = splitStreamFade("第一行内容\n第二行还在吐字呢");
    expect(multi.settled.endsWith("\n"), "settled 切在了行中间 → 会插入一个假换行").toBe(true);
    const one = splitStreamFade("这是一整段没有任何换行的文字，正在一个字一个字地吐出来，还会继续变长。");
    expect(one.settled, "单行文本也被切出了 settled ⇒ 最后半行会被当成一个块 ⇒ 假换行").toBe("");
    for (const raw of ["", "a", "a\nb", "a\n\nb", "x".repeat(200), "第一行\n" + "y".repeat(120)]) {
      const r = splitStreamFade(raw);
      expect(r.settled.endsWith("\n") || r.settled === "", `settled 未止于换行：${JSON.stringify(raw)}`).toBe(true);
      expect(r.settled + r.linePrefix + r.tail, `三段拼接不等于原文：${JSON.stringify(raw)}`).toBe(raw);
    }
  });

  it("正文刚好以换行结尾 → 没有尾巴可渐入（不做无用功）", () => {
    expect(splitStreamFade("写完了\n").tail).toBe("");
  });

  it("🐛 边界：同一批字符在**前缀推移**后 key 不变（老单元不重播动画）", () => {
    const a = splitStreamFade("abcdef");
    const b = splitStreamFade("abcdefgh");
    const keysA = new Set(a.units.map((u) => u.at));
    // b 里与 a 同在尾巴中的字符（'a' 已落回前缀，其余位置不变）
    for (const u of b.units) {
      if (u.at < a.tail.length) { expect(keysA.has(u.at)).toBe(true); }
    }
  });
});

// ── ③ 接线 ────────────────────────────────────────────────────────────────
describe("A-1061⑬ 接线：切分结果真的被用起来了", () => {
  it("ChatPanel 用 splitStreamFade 渲染尾巴 spans + 光标仍在末尾", () => {
    /* A-1065 迁移：尾巴 span 的**显示文本**改走 `fadeUnitText`（抹掉裸露的 markdown 控制符号，
       见 tests/gui/a1065-fade-text.spec.ts）。这里同步锁新的接线形态 —— 保留本用例原本的意图
       （"切分结果真的被用起来"），不是删掉它。
       A-1094 再迁移：逐单元 `fadeUnitText` → 整段 `visibleTailUnits`（`|` 抹掉后要跨单元收敛空格）。
       意图（span 里渲染的是**净化后**的文本、切分结果真的被用起来）逐字保留。 */
    expect(PANEL).toContain('import { splitStreamFade, visibleTailUnits } from "./streamFade.js";');
    /* A-1095 #5 迁移：切分+渲染收进**唯一**组件 `StreamFadeText`（正文与思考共用）——
       本用例的意图（"切分结果真的被用起来"）逐字保留，只是产地由内联改为该组件。
       断言锚定组件体内，避免"别处同名串"让守卫在真正的产地失效时仍绿。 */
    const fadeAt = PANEL.indexOf("function StreamFadeText");
    expect(fadeAt, "找不到 StreamFadeText（切分渲染的唯一产地）").toBeGreaterThan(-1);
    /* ⚠️ 切片右界取**下一个顶层声明**（下一个 `\nfunction ` / `\nconst ` 之类），
       而不是硬编码 `+700` —— 注释一膨胀，窗口就把真正的断言目标挤出去，守卫**静默失效**。 */
    const nextDecl = PANEL.slice(fadeAt + 10).search(/\n(?:function |const |export )/);
    const fadeBlk = PANEL.slice(fadeAt, nextDecl > 0 ? fadeAt + 10 + nextDecl : fadeAt + 3000);
    expect(fadeBlk).toContain("const fade = splitStreamFade(text);");
    /* A-1095 #6（S6）迁移：渐入类名从**恒挂**改成**按水位条件挂**
       （`className={u.at > seenAt ? "stream-fade-unit" : undefined}`）——
       意图（渐入类真的被用在 span 上）逐字保留；恒挂形态本身是闪烁的根因
       （每帧重挂 ⇒ 动画重播），其"不许回来"由 `a1095-fade-stability.spec.ts` 守着。 */
    expect(fadeBlk, "渐入类没有用在单元上").toContain('"stream-fade-unit"');
    expect(fadeBlk).toContain("visibleTailUnits(fade.units)");
    // 已定型前缀照旧走 Markdown（否则整段退回纯文本，丢语法高亮）
    expect(fadeBlk).toContain("<Markdown text={fade.settled} streaming />");
    /* A-1080：「最后一行的前半段」必须真的被渲染出来 —— 少了它那段字直接消失；
       更关键的是**三段同处一个行内流**这条接线（接缝不插块级边界）就断了。 */
    expect(fadeBlk, "linePrefix 没被渲染 → 最后半行丢掉（或尾巴又另起一行）").toContain("{fade.linePrefix}");
    // ⚠️ 唯一产地：整份文件里 `visibleTailUnits(fade.units)` 只应出现在该组件内
    const tailHits = (PANEL.match(/visibleTailUnits\(fade\.units\)/g) ?? []).length;
    expect(tailHits, "出现多个产地 —— A-1080 的同行内流约束迟早在一处失守").toBe(1);
    // 正文与思考都调它（A-1095 #5 的"推广"必须真的接上）
    expect((PANEL.match(/<StreamFadeText\b/g) ?? []).length, "正文未走 StreamFadeText").toBeGreaterThanOrEqual(2);
  });

  it("CSS 有对应的 keyframes 与类，且在 prefers-reduced-motion 下降级", () => {
    const kf = rule("@keyframes streamUnitIn");
    /* A-1065 迁移（+ A-1076）：方向仍是「从**右侧**滑入」（起点 +3px 归零），
       但机制从 `transform` 换成了 `left` —— 尾巴单元是 `.stream-partial`（普通块）里的
       `<span>`，即 **inline 盒子**；按 CSS Transforms L1 §2.1 它**不是 transformable
       element，`transform` 会被静默忽略**。所以旧写法里"从右滑入"从来没发生过（只有淡入）。
       ⚠️ 也因此不许"为了用 transform 而改成 inline-block" —— 那是原子单元，CJK 尾巴会整条
       不断行地溢出（比没有位移更糟），见 index.css 的注释。 */
    expect(kf, "渐入没有位移了 —— 用户要的是「从右到左」的滑入，不只是淡入").toContain("left: 3px");
    expect(kf, "渐入方向变成从左滑入（用户要的是从右到左）").not.toContain("left: -3px");
    expect(kf).toContain("opacity: 0");
    const unit = rule(".stream-fade-unit");
    expect(unit).toContain("animation: streamUnitIn");
    expect(kf, "关键帧用了 transform，而尾巴单元是 inline 盒子 → transform 被静默忽略，位移根本没发生")
      .not.toContain("transform");
    expect(unit, "没有 position: relative ⇒ `left` 这个位移不会生效").toContain("position: relative");
    expect(unit, "改成 inline-block 会让 CJK 尾巴整条不断行地溢出").not.toMatch(/display:\s*inline-block/);
    const rm = CSS.indexOf("@media (prefers-reduced-motion: reduce)", CSS.indexOf("@keyframes streamUnitIn"));
    expect(rm, "渐入动画没有无障碍降级").toBeGreaterThan(-1);
    /* ⚠️ A-1124 **迁移**（用户实测问题 c）。原来断言的是
       `expect(CSS.slice(rm, rm + 200)).toContain(".stream-fade-unit { animation: none; }")` ——
       那条覆盖把**整段动画**抹掉，等于**一个开关同时关掉「思考」与「正文」两处的吐字渐入**，
       且完全静默（过 tsc / 过构建 / 过全部逻辑测试）。用户实测原话：
       「现在所有吐字均看不到我让你设计的渐入的由浅入深的衔接动画了，思考、正文哪里都没有。」
       意图（减动效下必须有降级）逐字保留；判据换成"降级 = **只去位移、保留淡入**"，
       并要求走一个**专门的**淡入关键帧（而不是把整段 animation 设为 none）。 */
    /* ⚠️ 切片右界取 `\n}`（媒体块的收尾），不用硬编码 `+900` —— 注释一膨胀，
       窗口就会把真正的断言目标挤出切片，守卫**静默失效**（本仓 §24 家族）。
       ⚠️ 而且必须**先剥注释**再断言：本文件的新注释里逐字引用了旧写法
       `.stream-fade-unit { animation: none; }` 做对照 —— 不剥注释，那条负面断言就被
       **自己的注释**喂红（本仓已经踩过同款：预览页漂移守卫）。 */
    const rmEnd = CSS.indexOf("\n}", rm);
    const rmBlk = stripComments(CSS.slice(rm, rmEnd > rm ? rmEnd : rm + 900));
    expect(rmBlk, "减动效覆盖又把动画整个关掉了（渐入在思考与正文两处同时消失）")
      .toMatch(/\.stream-fade-unit \{ animation-name: streamUnitFadeIn; \}/);
    expect(rmBlk, "减动效覆盖不许退回 `animation: none`").not.toMatch(/\.stream-fade-unit \{ animation: none; \}/);
    // 那个淡入关键帧必须存在，且**只**含不透明度（含 left/transform 就等于位移没去掉）
    /* ⚠️ 不用 `rule()` 取它：`rule()` 只切到**第一个** `}`（keyframes 里即 `from` 那行的收尾），
       拿它断言"整块只有不透明度"是**假绿**（把位移加到 `to` 那行照样过）。这里整块精确匹配。 */
    expect(CSS_CODE, "减动效专用的淡入关键帧不存在，或里面混进了位移/其它属性")
      .toMatch(/@keyframes streamUnitFadeIn \{\s*from \{ opacity: 0; \}\s*to \{ opacity: 1; \}\s*\}/);
  });
});
