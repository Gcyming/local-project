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
import { splitStreamFade, fadeUnitText, unitize, visibleTailText, visibleTailUnits } from "../../gui/src/renderer/pages/streamFade.js";

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

/** 把一段流式文本切成尾巴并**把显示文本拼起来** —— 即用户实际看到的那行字。
 *  A-1094：必须走 `visibleTailText`（整段净化 + 跨单元空格收敛），不是逐单元 join。 */
const visibleTail = (shown: string): string => visibleTailText(splitStreamFade(shown).units);

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

  it("A-1094：表格管道 `|` 同样不许裸露（尾巴期间表格行也不能露语法）", () => {
    // 恢复用户截图 image#5 的字面形态
    const vis = visibleTail("| 序号 | 命令 |\n|---|------|");
    expect(vis, `露出了表格管道：${JSON.stringify(vis)}`).not.toContain("|");
    expect(fadeUnitText("|---|------|")).toBe("");
    expect(fadeUnitText("---")).toBe("");
    expect(fadeUnitText("|---|")).toBe("");
    expect(fadeUnitText("|")).toBe("");
    expect(fadeUnitText("||")).toBe("");
    // 表格单元里的文字不能被连带抹掉
    expect(visibleTail("| 本地 | ✅ |")).toContain("本地");
  });

  it("A-1094：单单元层面也须抹 `|`（不许只靠整段收尾兜底）", () => {
    // 直接锁 fadeUnitText 的行为：`|` 与 `|---|---|` 形态必须变空 / 变干净，
    // 否则整段收尾只是"擦屁股"，某个单元漏出来就露语法
    expect(fadeUnitText("| 序号 |")).not.toContain("|");
    expect(fadeUnitText("| 序号 |")).toContain("序号");
    // 单单元内 `|` 直接抹掉（不留空格）——跨单元的空格收敛交给 visibleTailText/Units
    expect(fadeUnitText("a|b")).toBe("ab");
    // 纯 `|` 集合（PURE_MARKER / TABLE_SEP_MARKER 两族）都必须整块隐藏
    for (const m of ["|", "||", "|---", "|---|", "|:--|--:|", "|---|---|---|"]) {
      expect(fadeUnitText(m), `未隐藏：${m}`).toBe("");
    }
  });

  it("A-1094：抹掉 `|` 留下的相邻空格要收敛（不许出现双空格）", () => {
    const vis = visibleTail("| 序号 | 命令 |");
    expect(vis, `留下了双空格：${JSON.stringify(vis)}`).not.toMatch(/ {2,}/);
    expect(vis).toContain("序号");
    expect(vis).toContain("命令");
  });

  it("A-1094：标题标记被吃掉后不许留前导空格（`### 标题` → `标题`）", () => {
    expect(fadeUnitText("# 标题")).toBe("标题");
    expect(fadeUnitText("### 标题")).toBe("标题");
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // 若 fadeUnitText 退化成恒等函数，上面的症状判据必须变红 —— 这里就地验证判据本身有效
    const identity = (s: string): string => s;
    const vis = splitStreamFade("## 标题").units.map((u) => identity(u.text)).join("");
    expect(vis).toContain("#");
  });
});

describe("A-1065-C 接线：显示文本真的经过了净化的那一层", () => {
  it("🐛 ChatPanel 走 `visibleTailUnits(...)`（净化后的单元），不是原始 `fade.units`", () => {
    // A-1094 迁移：净化从「逐单元 fadeUnitText」升级为「整段 visibleTailUnits」——
    // 因为 `|` 这类表格标记被抹掉后，**跨单元的空格**必须一起收敛，逐单元净化做不到。
    // 意图（尾巴不许裸露 markdown 控制符号）逐字保留。
    // A-1095 #5 再迁移：切分+渲染收进**唯一**组件 `StreamFadeText`（正文与思考共用），
    // 断言随之锚定该组件体内 —— 否则"别处也有同一串"会让守卫在真正的产地失效时仍绿。
    expect(PANEL).toContain('import { splitStreamFade, visibleTailUnits } from "./streamFade.js";');
    const at = PANEL.indexOf("function StreamFadeText");
    expect(at, "找不到 StreamFadeText（切分渲染的唯一产地）").toBeGreaterThan(-1);
    // 右界取下一个顶层声明（不硬编码宽度，避免注释膨胀把断言目标挤出窗口 ⇒ 守卫静默失效）
    const nextDecl = PANEL.slice(at + 10).search(/\n(?:function |const |export )/);
    const blk = PANEL.slice(at, nextDecl > 0 ? at + 10 + nextDecl : at + 3000);
    expect(blk, "StreamFadeText 没走净化后的单元").toContain("visibleTailUnits(fade.units)");
    // 唯一产地：整份文件里 `visibleTailUnits(fade.units)` 只应出现在该组件内
    const hits = (PANEL.match(/visibleTailUnits\(fade\.units\)/g) ?? []).length;
    expect(hits, "出现多个产地 —— 净化约束迟早在一处失守").toBe(1);
    // 渲染 span 的**不得**是原始 `fade.units.map`（那等于没净化）
    expect(PANEL, "仍然直接渲染原始单元").not.toMatch(/fade\.units\.map\(\(u\)\s*=>/);
  });

  it("净化后为空串的单元不渲染 span（避免一堆零宽 span 留在 DOM 里）", () => {
    const at = PANEL.indexOf("visibleTailUnits(fade.units)");
    expect(at).toBeGreaterThan(-1);
    const blk = PANEL.slice(at, at + 400);
    /* A-1095 #6（S6）迁移：渲染从「`.map` 里 `u.text ? <span className="stream-fade-unit">` 」
       改成「先 `.filter(u => u.text)` 再用 `u.at > seenAt` 决定是否挂渐入类」——
       意图（空显示不挂 span）逐字保留：**过滤在前**，空串根本进不了 map。 */
    expect(blk, "空显示仍然进了渲染列表").toMatch(/visibleTailUnits\(fade\.units\)\.filter\(\(u\)\s*=>\s*u\.text\)/);
  });
});

describe("A-1094 尾巴净化：跨单元空格收敛（逐单元净化做不到）", () => {
  it("`| 序号 | 命令 |` → 可见串无 `|`、无双空格、无首尾空格", () => {
    const vis = visibleTailText(splitStreamFade("| 序号 | 命令 |").units);
    expect(vis).not.toContain("|");
    expect(vis).not.toMatch(/ {2,}/);
    expect(vis).toBe(vis.trim());
    expect(vis).toContain("序号");
    expect(vis).toContain("命令");
  });

  it("不变量：`visibleTailUnits` 拼起来必须**逐字等于** `visibleTailText`", () => {
    const cases = [
      "| 序号 | 命令 |", "hello world", "## 标题 **粗体**", "const a = 1;",
      "|---|------|", "a | b 是「或」的意思", "| 本地 | ✅ |", "### 标题",
    ];
    for (const s of cases) {
      const units = splitStreamFade(s).units;
      expect(visibleTailUnits(units).map((u) => u.text).join(""), s).toBe(visibleTailText(units));
    }
  });

  it("单元 `at` 必须原样保留（key 稳定 ⇒ 动画不重播）", () => {
    const units = splitStreamFade("| 序号 | 命令 |").units;
    expect(visibleTailUnits(units).map((u) => u.at)).toEqual(units.map((u) => u.at));
  });
});
