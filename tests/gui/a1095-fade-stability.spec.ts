

































import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeThinking, splitToolTrace } from "../../gui/src/renderer/pages/thinkingText.js";
import { splitStreamFade, visibleTailUnits } from "../../gui/src/renderer/pages/streamFade.js";

const ROOT = join(__dirname, "../..");
const PANEL = readFileSync(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");



function makeFadeState() {
  return { maxAt: -1, prevText: "" };
}
function renderFrame(st: { maxAt: number; prevText: string }, text: string) {
  if (!text.startsWith(st.prevText)) { st.maxAt = -1; }
  st.prevText = text;
  const fade = splitStreamFade(text);
  const units = visibleTailUnits(fade.units).filter((u) => u.text);
  const seenAt = st.maxAt;
  for (const u of units) { if (u.at > st.maxAt) { st.maxAt = u.at; } }
  return units.map((u) => ({ at: u.at, text: u.text, fresh: u.at > seenAt }));
}


function stream(text: string, st = makeFadeState()) {
  const frames: Array<Array<{ at: number; text: string }>> = [];
  for (let i = 1; i <= text.length; i += 1) {
    const fresh = renderFrame(st, text.slice(0, i)).filter((u) => u.fresh);
    frames.push(fresh.map((u) => ({ at: u.at, text: u.text })));
  }
  return frames;
}

describe("A-1095 #6-A 已知事实：净化对流式输入**不单调**（这是闪烁的根因，永远成立）", () => {
  it("🐛 `sanitizeThinking` 对尾部输入非前缀单调（`s w` + `e` → `swe` 删掉了已显空格）", () => {
    const a = sanitizeThinking("DeepSeek s w");
    const b = sanitizeThinking("DeepSeek s we");
    
    expect(b.startsWith(a), `非单调性消失了？a=${JSON.stringify(a)} b=${JSON.stringify(b)}`).toBe(false);
    
    expect(a).toBe("DeepSeek s w");
    expect(b).toBe("DeepSeek swe");
  });

  it("🐛 `splitToolTrace` 在工具块标题写全的瞬间砍掉已显示内容（第二条非单调来源）", () => {
    
    const before = splitToolTrace("我在思考\n### 工具调用记").text;
    
    const after = splitToolTrace("我在思考\n### 工具调用记录").text;
    expect(before).toBe("我在思考\n### 工具调用记");
    expect(after).toBe("我在思考");
    expect(after.startsWith(before), "砍块行为消失了？").toBe(false);
  });

  it("对**完整**（非流式）输入，净化仍是确定性的正确结果（非单调只发生在流式中间态）", () => {
    expect(sanitizeThinking("B ing")).toBe("Bing");
    expect(sanitizeThinking("S tudio")).toBe("Studio");
    
    expect(sanitizeThinking("b c")).toBe("b c");
  });
});

describe("A-1095 #6-B 不变量：已出现的字**绝不重播**渐入（闪烁的正面判据）", () => {
  it("🐛 英文断词触发的回溯改写：逐 token 流入全过程 0 次重播", () => {
    
    const tokens = ["Deep", "Seek", " ", "s", " ", "w", " ", "e", " ", "x", " ", "yz", " ", "done"];
    const st = makeFadeState();
    const seen = new Set<string>();
    let replays = 0;
    let raw = "";
    for (const tk of tokens) {
      raw += tk;
      const clean = sanitizeThinking(splitToolTrace(raw).text);
      for (const u of renderFrame(st, clean).filter((x) => x.fresh)) {
        const k = `${u.at}:${u.text}`;
        if (seen.has(k)) { replays += 1; }
        seen.add(k);
      }
    }
    expect(replays, "断词回溯改写导致渐入重播（闪烁）").toBe(0);
  });

  it("🐛 逐字符流：每个位置上新挂的渐入单元**只挂一次**（无重播）", () => {
    const text = "这是一段中文思考内容通过逐字符流式验证渐入单元不会重挂重播";
    const frames = stream(text);
    const seen = new Set<string>();
    let replays = 0;
    for (const frame of frames) {
      for (const u of frame) {
        const k = `${u.at}:${u.text}`;
        if (seen.has(k)) { replays += 1; }
        seen.add(k);
      }
    }
    expect(replays, "有单元在同一位置上重播了渐入（= 用户看到的闪烁）").toBe(0);
  });

  it("🐛 新字符**不会漏播**（末尾总在生产新的 `at`，即使发生过漂移）", () => {
    const text = "先看一个问题然后再决定怎么处理它比较合适";
    const frames = stream(text);
    
    const freshTexts = new Set<string>();
    for (const f of frames) { for (const u of f) { freshTexts.add(u.text); } }
    for (const ch of new Set(text.split(""))) {
      expect(freshTexts.has(ch), `字符 ${ch} 从未以"新字符"身份播过渐入（漏播）`).toBe(true);
    }
  });

  it("🐛 重复字符：`人人好好看看` 的每个字都各播一次（内容做身份会在此翻车）", () => {
    const frames = stream("人人好好");
    const freshByAt = new Map<number, string>();
    for (const f of frames) { for (const u of f) { freshByAt.set(u.at, u.text); } }
    
    const renAt = [...freshByAt.entries()].filter(([, t]) => t === "人");
    expect(renAt.length, "第二个 `人` 被判成已播过 ⇒ 不播（内容身份法的缺陷）").toBe(2);
  });

  it("换轮（文本骤缩、不再以旧文本为前缀）→ 水位重置 ⇒ 新一轮恢复渐入", () => {
    const st = makeFadeState();
    renderFrame(st, "第一轮的正文内容很长很长很长很长很长很长");
    const first = renderFrame(st, "第二轮");
    expect(first.filter((u) => u.fresh).length, "换轮后整轮不播渐入（水位没重置）").toBeGreaterThan(0);
  });
});

describe("A-1095 #6-C 接线：`StreamFadeText` 必须真的按水位判定（而不是假设下标稳定）", () => {
  

  const fadeBody = (): string => {
    const at = PANEL.indexOf("function StreamFadeText");
    expect(at, "找不到 StreamFadeText（渐入渲染的唯一产地）").toBeGreaterThan(-1);
    const nextDecl = PANEL.slice(at + 10).search(/\n(?:function |const |export )/);
    return PANEL.slice(at, nextDecl > 0 ? at + 10 + nextDecl : at + 3000);
  };

  it("源码里有单调水位 ref，且判定是 `at > 水位`", () => {
    const blk = fadeBody();
    expect(blk, "没有水位 ref").toMatch(/useRef\(\s*-1\s*\)/);
    
    expect(blk, "没有按 `at > 水位` 判定").toMatch(/u\.at\s*>\s*seenAt/);
    
    expect(blk, "水位没有推进").toMatch(/maxAtRef\.current\s*=\s*u\.at/);
    
    expect(blk, "没有换轮重置").toMatch(/startsWith\(prevTextRef\.current\)/);
  });

  it("🐛 不许退回「假设下标稳定」的写法（`key={u.at}` 仍保留，但类名不再恒挂）", () => {
    const blk = fadeBody();
    
    expect(blk, "渐入类名又变成恒挂（回退到每帧重播）").not.toMatch(/className="stream-fade-unit"/);
    
    expect(blk, "key 不再是 at").toMatch(/key=\{u\.at\}/);
  });

  it("思考内容确实走 StreamFadeText（本 spec 的场景在真实路径上存在）", () => {
    
    expect(PANEL).toContain("streamingTail ? <StreamFadeText text={cleanThink} />");
  });
});
