















import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStreamFade, fadeUnitText, unitize, visibleTailText, visibleTailUnits } from "../../gui/src/renderer/pages/streamFade.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
const CSS = read("gui/src/renderer/index.css");


const keyframes = (name: string): string => {
  const at = CSS.indexOf(`@keyframes ${name}`);
  if (at < 0) { return ""; }
  return CSS.slice(at, CSS.indexOf("}", at) + 1);
};



const visibleTail = (shown: string): string => visibleTailText(splitStreamFade(shown).units);

describe("A-1065-A 方向：位移必须由**右**到左（旧写法沿用了被用户否掉的那一版）", () => {
  it("🐛 keyframes 从 +3px 归零（新字从右侧滑入）；且不许再出现 -3px", () => {
    




    const kf = keyframes("streamUnitIn");
    expect(kf, "找不到 streamUnitIn").not.toBe("");
    expect(kf, "方向不对：新字应从右侧滑入").toContain("left: 3px");
    expect(kf, "旧的从左滑入写法又回来了").not.toContain("left: -3px");
    expect(kf, "inline 盒子上用 transform 等于没动（位移静默失效）").not.toContain("transform");
    expect(CSS, "没有 position: relative ⇒ 相对位移不生效").toContain(".stream-fade-unit {\n  position: relative;");
  });

  it("注释与实现不许再打架（凡描述方向处，必须写「由右到左」）", () => {
    
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
    
    expect(visibleTail("Hello world")).toBe("Hello world");
  });

  it("🐛 反过来：不许把整段文本都抹空（过度清理 = 用户看不到正在吐的字）", () => {
    expect(visibleTail("普通一句话")).toBe("普通一句话");
    expect(visibleTail("const a = 1;")).toBe("const a = 1;");
  });

  it("A-1094：表格管道 `|` 同样不许裸露（尾巴期间表格行也不能露语法）", () => {
    
    const vis = visibleTail("| 序号 | 命令 |\n|---|------|");
    expect(vis, `露出了表格管道：${JSON.stringify(vis)}`).not.toContain("|");
    expect(fadeUnitText("|---|------|")).toBe("");
    expect(fadeUnitText("---")).toBe("");
    expect(fadeUnitText("|---|")).toBe("");
    expect(fadeUnitText("|")).toBe("");
    expect(fadeUnitText("||")).toBe("");
    
    expect(visibleTail("| 本地 | ✅ |")).toContain("本地");
  });

  it("A-1094：单单元层面也须抹 `|`（不许只靠整段收尾兜底）", () => {
    
    
    expect(fadeUnitText("| 序号 |")).not.toContain("|");
    expect(fadeUnitText("| 序号 |")).toContain("序号");
    
    expect(fadeUnitText("a|b")).toBe("ab");
    
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
    
    const identity = (s: string): string => s;
    const vis = splitStreamFade("## 标题").units.map((u) => identity(u.text)).join("");
    expect(vis).toContain("#");
  });
});

describe("A-1065-C 接线：显示文本真的经过了净化的那一层", () => {
  it("🐛 ChatPanel 走 `visibleTailUnits(...)`（净化后的单元），不是原始 `fade.units`", () => {
    
    
    
    
    
    expect(PANEL).toContain('import { splitStreamFade, visibleTailUnits } from "./streamFade.js";');
    const at = PANEL.indexOf("function StreamFadeText");
    expect(at, "找不到 StreamFadeText（切分渲染的唯一产地）").toBeGreaterThan(-1);
    
    const nextDecl = PANEL.slice(at + 10).search(/\n(?:function |const |export )/);
    const blk = PANEL.slice(at, nextDecl > 0 ? at + 10 + nextDecl : at + 3000);
    expect(blk, "StreamFadeText 没走净化后的单元").toContain("visibleTailUnits(fade.units)");
    
    const hits = (PANEL.match(/visibleTailUnits\(fade\.units\)/g) ?? []).length;
    expect(hits, "出现多个产地 —— 净化约束迟早在一处失守").toBe(1);
    
    expect(PANEL, "仍然直接渲染原始单元").not.toMatch(/fade\.units\.map\(\(u\)\s*=>/);
  });

  it("净化后为空串的单元不渲染 span（避免一堆零宽 span 留在 DOM 里）", () => {
    const at = PANEL.indexOf("visibleTailUnits(fade.units)");
    expect(at).toBeGreaterThan(-1);
    const blk = PANEL.slice(at, at + 400);
    


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
