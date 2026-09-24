/**
 * A-1065 守卫：流式吐字的两处修正（同一段用户反馈里的两件事）。
 *
 * 用户原话（同一条消息）：
 *   · "现在的吐字的渐入动画有问题啊，还是我之前说错了，吐字的时候，出现的部分，**从右到左**的动画，
 *      现在老是从左到右的渐入"                      → 位移方向翻转（A-1061⑬ 写反了）
 *   · "而且还出现了很多 markdown 渲染不全的 *、# 等符号" → 尾巴（纯文本渲染）不许裸露控制符号
 *
 * ⚠️ 为什么这两件事必须写在同一个 spec：
 *   它们是**同一处渲染**（`stream-partial` 里那一段尾巴 spans）的两个属性，而且是**互相牵制**的 ——
 *   尾巴之所以会裸露 `*`/`#`，正因为它必须是纯文本 span 才能各自渐入（`streamFade.ts` 文件头）。
 *   只改方向不改符号裸露，用户下次还是会看到一堆 `*`；只改符号不管方向，动画还是反的。
 *
 * 方向那半边由 `tests/gui/a1061-visual.spec.ts` 的 CSS 用例承担（本文件不重复断言 CSS，
 * 只补一处"翻转必须成对出现"的交叉检查），符号那半边在本文件里做**行为级**验证。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStreamFade, fadeUnitText, unitize } from "../../gui/src/renderer/pages/streamFade.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
const CSS = read("gui/src/renderer/index.css");

/** 取出 CSS 里某个 `@keyframes name { ... }` 的整块（到第一个 `}` 结束，够用：本项目块内无嵌套花括号） */
const keyframes = (name: string): string => {
  const at = CSS.indexOf(`@keyframes ${name}`);
  if (at < 0) { return ""; }
  return CSS.slice(at, CSS.indexOf("}", at) + 1);
};

/** 把一段流式文本切成尾巴并**把显示文本拼起来** —— 即用户实际看到的那行字 */
const visibleTail = (shown: string): string =>
  splitStreamFade(shown).units.map((u) => fadeUnitText(u.text)).join("");

describe("A-1065-A 方向：位移必须由**右**到左（旧写法沿用了被用户否掉的那一版）", () => {
  it("🐛 keyframes 从 +3px 归零（新字从右侧滑入）；且不许再出现 -3px", () => {
    /* A-1076 迁移：方向不变（仍是从**右**侧 +3px 归零），但**机制**从 `transform` 换成了
       `left` —— 尾巴单元是 `.stream-partial`（普通块）里的 `<span>`，即 inline 盒子；
       按 CSS Transforms L1 §2.1，非替换 inline 盒子**不是 transformable element**，
       `transform` 会被**静默忽略**（"从右滑入"此前从未真正发生，只有淡入）。
       判据跟着判据的新家走，意图（方向 + 禁反向）逐字保留。 */
    const kf = keyframes("streamUnitIn");
    expect(kf, "找不到 streamUnitIn").not.toBe("");
    expect(kf, "方向不对：新字应从右侧滑入").toContain("left: 3px");
    expect(kf, "旧的从左滑入写法又回来了").not.toContain("left: -3px");
    expect(kf, "inline 盒子上用 transform 等于没动（位移静默失效）").not.toContain("transform");
    expect(CSS, "没有 position: relative ⇒ 相对位移不生效").toContain(".stream-fade-unit {\n  position: relative;");
  });

  it("注释与实现不许再打架（凡描述方向处，必须写「由右到左」）", () => {
    // 同一语义有两个产地（CSS 注释 / ChatPanel 渲染块注释）→ 必须同源，否则下次改一半。
    expect(CSS, "CSS 注释还在说「由左到右」").not.toMatch(/由左到右\s*=\s*translate3d/);
    expect(PANEL, "ChatPanel 的渐入注释还在说「由左到右」").not.toContain("由左到右 + 由浅到深");
  });
});

describe("A-1065-B 尾巴是纯文本渲染 → 显示文本必须抹掉 markdown 控制符号", () => {
  it("🐛 复现用户症状的字面判据：拼起来的可见文本里不许有裸 `*` / `#`", () => {
    const shown = "## 标题 **粗体** * 列表项";
    const vis = visibleTail(shown);
    expect(vis, `露出了控制符号：${JSON.stringify(vis)}`).not.toContain("*");
    expect(vis, `露出了控制符号：${JSON.stringify(vis)}`).not.toContain("#");
    // 但正文文字一个都不能少
    expect(vis).toContain("标题");
    expect(vis).toContain("粗体");
    expect(vis).toContain("列表项");
  });

  it("整块只有标记字符的单元 → 整块隐藏（零宽度，不是显示成空格）", () => {
    expect(fadeUnitText("**")).toBe("");
    expect(fadeUnitText("###")).toBe("");
    expect(fadeUnitText(">")).toBe("");
    expect(fadeUnitText("`")).toBe("");
    expect(fadeUnitText("~~")).toBe("");
    expect(fadeUnitText("-")).toBe("");
  });

  it("有序列表标记（`1.` / `12.`）也隐藏（ASCII 连字符集把数字和点连成一个单元）", () => {
    expect(fadeUnitText("1.")).toBe("");
    expect(fadeUnitText("12.")).toBe("");
    // 但普通数字不能误伤
    expect(fadeUnitText("12")).toBe("12");
    expect(fadeUnitText("3.14")).toBe("3.14");
  });

  it("行内标记混在同一个单元里 → 只抹符号、保留文字（`**bold**` → `bold`）", () => {
    expect(unitize("**bold**").map((u) => u.text)).toEqual(["**bold**"]);
    expect(fadeUnitText("**bold**")).toBe("bold");
    expect(fadeUnitText("`code`")).toBe("code");
  });

  it("🐛 空白单元**原样保留** —— 抹掉它会让相邻词粘在一起", () => {
    expect(fadeUnitText(" ")).toBe(" ");
    expect(fadeUnitText("  ")).toBe("  ");
    // 端到端：空格必须还在（否则 "Hello world" 变 "Helloworld"）
    expect(visibleTail("Hello world")).toBe("Hello world");
  });

  it("🐛 反过来：不许把整段文本都抹空（过度清理 = 用户看不到正在吐的字）", () => {
    expect(visibleTail("普通一句话")).toBe("普通一句话");
    expect(visibleTail("const a = 1;")).toBe("const a = 1;");
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // 若 fadeUnitText 退化成恒等函数，上面的症状判据必须变红 —— 这里就地验证判据本身有效
    const identity = (s: string): string => s;
    const vis = splitStreamFade("## 标题").units.map((u) => identity(u.text)).join("");
    expect(vis).toContain("#");
  });
});

describe("A-1065-C 接线：显示文本真的经过了净化的那一层", () => {
  it("🐛 ChatPanel 渲染的是 `fadeUnitText(u.text)`，不是 `u.text`（否则净化为空谈）", () => {
    expect(PANEL).toContain('import { splitStreamFade, fadeUnitText } from "./streamFade.js";');
    expect(PANEL, "仍然直接渲染原始单元文本").not.toContain('className="stream-fade-unit">{u.text}<');
    expect(PANEL).toContain("fadeUnitText(u.text)");
  });

  it("净化后为空串的单元不渲染 span（避免一堆零宽 span 留在 DOM 里）", () => {
    const at = PANEL.indexOf("fadeUnitText(u.text)");
    expect(at).toBeGreaterThan(-1);
    const blk = PANEL.slice(at, at + 200);
    expect(blk, "空显示仍然挂了 span").toMatch(/\?\s*<span[^>]*>\{t\}<\/span>\s*:\s*null/);
  });
});
