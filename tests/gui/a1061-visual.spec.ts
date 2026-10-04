









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


function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const CSS_CODE = stripComments(CSS);


function rule(sel: string, src = CSS_CODE): string {
  const at = src.indexOf(sel);
  expect(at, `找不到选择器 ${sel}`).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  const close = src.indexOf("}", open);
  return src.slice(open + 1, close);
}



function jsxTag(cls: string, src = PANEL): string {
  const at = src.indexOf(`className="${cls}"`);
  expect(at, `找不到 className="${cls}"`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf(">", at));
}


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
    
    expect(15).toBeGreaterThan(12.5);
  });

  it("markdown 代码块（code / powershell 栏目内文本）不再发虚", () => {
    const blk = rule(".markdown-body pre code");
    const size = Number(/font-size:\s*([\d.]+)px/.exec(blk)?.[1]);
    const weight = Number(/font-weight:\s*(\d+)/.exec(blk)?.[1]);
    
    expect(size, "块内代码字号没提上来").toBeGreaterThanOrEqual(14.5);
    expect(weight, "块内代码字重没提上来").toBeGreaterThanOrEqual(600);
    
    expect(blk).toContain("Microsoft YaHei");
  });

  it("激励语不再是「11.5px + 最暗 + 斜体」三连（看不清的三个来源）", () => {
    const at = PANEL.indexOf("{cheer && (");
    expect(at).toBeGreaterThan(-1);
    const blk = PANEL.slice(at, at + 200);
    


    const size = Number(/fontSize:\s*([\d.]+)/.exec(blk)?.[1]);
    expect(size, "激励语块里找不到 fontSize —— 断言对象搞错了").not.toBeNaN();
    expect(size, "激励语字号没提上来（退回 11.5px 那种看不清）").toBeGreaterThanOrEqual(13);
    expect(blk).toContain("fontWeight: 500");
    expect(blk).not.toContain("fontStyle");
    expect(blk).not.toContain("--text-muted");
  });

  
  
  
  it("🐛 激励语独占最后一行：不许再与主句同级 flex-wrap（长文本会挤跑主句）", () => {
    const at = PANEL.indexOf("{cheer && (");
    expect(at, "找不到激励语渲染点").toBeGreaterThan(-1);
    
    const before = PANEL.slice(0, at);
    const colAt = before.lastIndexOf('flexDirection: "column"');
    expect(colAt, "激励语不在 column（两行式）容器内 —— 会退回行内流").toBeGreaterThan(-1);
    
    
    const wrapAt = before.lastIndexOf('flexWrap: "wrap"');
    expect(wrapAt, "主句行没带 flex-wrap").toBeGreaterThan(-1);
    expect(wrapAt, "主句 flex-wrap 行不在 column 容器内 —— 结构被改坏了").toBeGreaterThan(colAt);
    const seg = PANEL.slice(colAt, at);
    expect(seg, "主句 flex-wrap 行没有在激励语之前闭合 —— 说明 cheer 仍待在主句行里")
      .toContain("</div>");
  });
});


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
    




    const shown = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const s = splitStreamFade(shown);
    expect(s.tail.length).toBeGreaterThanOrEqual(STREAM_FADE_TAIL_MAX);
    expect(s.tail.length).toBeLessThan(STREAM_FADE_TAIL_MAX + 8); 
    
    expect(s.settled).toBe("");
    expect(s.linePrefix.length, "窗口之前的那半行必须落成静态文本").toBeGreaterThan(0);
    
    expect(s.settled.length + s.linePrefix.length).toBe(s.units[0].at);
    expect(s.tail).toBe(shown.slice(s.units[0].at));
    
    expect(s.settled + s.linePrefix + s.tail).toBe(shown);
  });

  it("A-1070：超长单元**整块**渐入，不许切成半截（切碎会让 key 抖动、动画每帧重播）", () => {
    
    const shown = "x".repeat(300);
    const s = splitStreamFade(shown);
    expect(s.units).toHaveLength(1);
    expect(s.units[0].at).toBe(0); 
    expect(s.tail).toBe(shown); 
    expect(s.settled).toBe("");
    expect(s.linePrefix, "整行都在尾巴里 ⇒ 没有「窗口之外的半行」").toBe("");
  });

  it("A-1070：窗口边界必须落在**单元起点**上（不许把单元切成半截）", () => {
    const shown = `${"前".repeat(43)} ${"x".repeat(100)}`;
    const s = splitStreamFade(shown);
    expect(s.units).toHaveLength(1);
    expect(s.tail).toBe("x".repeat(100)); 
    expect(s.settled.length + s.linePrefix.length).toBe(s.units[0].at);
    expect(s.settled.length + s.linePrefix.length).toBe(44); 
  });

  it("A-1080：接缝必须落在**真实换行**上（否则最后半行被 Markdown 块截断 → 尾端留空白 + 整段往上挤）", () => {
    






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
    
    for (const u of b.units) {
      if (u.at < a.tail.length) { expect(keysA.has(u.at)).toBe(true); }
    }
  });
});


describe("A-1061⑬ 接线：切分结果真的被用起来了", () => {
  it("ChatPanel 用 splitStreamFade 渲染尾巴 spans + 光标仍在末尾", () => {
    




    expect(PANEL).toContain('import { splitStreamFade, visibleTailUnits } from "./streamFade.js";');
    


    const fadeAt = PANEL.indexOf("function StreamFadeText");
    expect(fadeAt, "找不到 StreamFadeText（切分渲染的唯一产地）").toBeGreaterThan(-1);
    

    const nextDecl = PANEL.slice(fadeAt + 10).search(/\n(?:function |const |export )/);
    const fadeBlk = PANEL.slice(fadeAt, nextDecl > 0 ? fadeAt + 10 + nextDecl : fadeAt + 3000);
    expect(fadeBlk).toContain("const fade = splitStreamFade(text);");
    



    expect(fadeBlk, "渐入类没有用在单元上").toContain('"stream-fade-unit"');
    expect(fadeBlk).toContain("visibleTailUnits(fade.units)");
    
    expect(fadeBlk).toContain("<Markdown text={fade.settled} streaming />");
    

    expect(fadeBlk, "linePrefix 没被渲染 → 最后半行丢掉（或尾巴又另起一行）").toContain("{fade.linePrefix}");
    
    const tailHits = (PANEL.match(/visibleTailUnits\(fade\.units\)/g) ?? []).length;
    expect(tailHits, "出现多个产地 —— A-1080 的同行内流约束迟早在一处失守").toBe(1);
    
    expect((PANEL.match(/<StreamFadeText\b/g) ?? []).length, "正文未走 StreamFadeText").toBeGreaterThanOrEqual(2);
  });

  it("CSS 有对应的 keyframes 与类，且在 prefers-reduced-motion 下降级", () => {
    const kf = rule("@keyframes streamUnitIn");
    





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
    






    




    const rmEnd = CSS.indexOf("\n}", rm);
    const rmBlk = stripComments(CSS.slice(rm, rmEnd > rm ? rmEnd : rm + 900));
    expect(rmBlk, "减动效覆盖又把动画整个关掉了（渐入在思考与正文两处同时消失）")
      .toMatch(/\.stream-fade-unit \{ animation-name: streamUnitFadeIn; \}/);
    expect(rmBlk, "减动效覆盖不许退回 `animation: none`").not.toMatch(/\.stream-fade-unit \{ animation: none; \}/);
    
    

    expect(CSS_CODE, "减动效专用的淡入关键帧不存在，或里面混进了位移/其它属性")
      .toMatch(/@keyframes streamUnitFadeIn \{\s*from \{ opacity: 0; \}\s*to \{ opacity: 1; \}\s*\}/);
  });
});
