/**
 * tests/gui/a1095-fade-stability.spec.ts — A-1095 #6（S6）：**吐字渐入的节拍稳定性**（闪烁根治）。
 *
 * 用户原话（六问题总纲之一）：
 *   「同时优化一下吐字动画，现在**挤字问题看不到了**（以后也不要让我看到），
 *     但**闪烁问题还是时有发生**」
 * ⇒ 本 spec 的两条底线：
 *   ① **挤字已解决** —— A-1080 的"三段同行内流、接缝落在真实换行"不许回归（由 a1061/a1080 系列守着，
 *      这里只做交叉检查）；
 *   ② **闪烁要根治** —— 已出现的字**绝不重播**渐入动画。
 *
 * ── 闪烁的真实根因（逐字追加复现定位，不是"动画时长没调好"）────────────────────
 *   A-1070 论证过"追加字符不会改变已有单元的 `at`"，但那条论证有**隐含前提**：
 *   被渐入的文本必须**单调累积**。正文满足（`partialRef` 只加不减），
 *   而**思考内容不满足** —— 传给渐入组件的是每帧重新净化的
 *   `cleanThink = sanitizeThinking(splitToolTrace(step.text).text)`，净化规则会**回溯改写已定型前缀**：
 *     · `sanitizeThinking` 的英文断词拼合 `(?<!['\u2018\u2019])\b([b-hj-zB-HJ-Z])\s+([a-z]{2,})\b`
 *       依赖**右侧字母数** —— 实测 `"DeepSeek s w"` 追加 `e` 后变 `"DeepSeek swe"`：
 *       `s` 与 `w` 之间那个**已显示过的空格被删**，于是它之后**所有 `at` 整体前移**；
 *     · `splitToolTrace` 在 `### 工具调用记录` 标题写全的瞬间，把已显示的整行砍掉。
 *   ⇒ `at`（React key）整体平移 ⇒ 整条尾巴被卸载重挂 ⇒ 260ms 渐入**重播** = 闪烁。
 *
 * ── 为什么不能"把净化改成单调"（这是本 spec 要钉死的**数学事实**）──────────────
 *   断词拼合的 `{2,}`（右侧 ≥2 字母）**正是正确判据**（`B ing`→`Bing` 该拼），
 *   而 `b c`（两个独立 token，不该拼）与 `s w`→`swe`（断词，该拼）**形态完全一样** ——
 *   帧 N 无从知道 `w` 会不会长成 `we`。收窄/放宽 `{2,}` 只会引入误拼（`b c`→`bc`）或漏拼，
 *   **换不来单调**。⇒ 依赖下标稳定的下游必须自己免疫。
 *
 * ── 修法：**问一个净化无法影响的问题 —— 「这个位置的字我播过动画没有？」**─────────
 *   `StreamFadeText` 用一个 `maxAt` 水位：只有 `at` **超过历史最大 `at`** 的单元才挂渐入类。
 *     · 漂移（整体前移）⇒ 被挪位的单元 `at` 不大于水位 ⇒ **不播**（不重播）；
 *     · 新字符总在末尾 ⇒ 其 `at` 会超过水位（漂移最多让它晚一格）⇒ **不漏播**。
 *   两者兼得。**不能用内容做身份** —— 重复字符（`人人`/`1234`）的第二个会被误判成"已播过"（见用例）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeThinking, splitToolTrace } from "../../gui/src/renderer/pages/thinkingText.js";
import { splitStreamFade, visibleTailUnits } from "../../gui/src/renderer/pages/streamFade.js";

const ROOT = join(__dirname, "../..");
const PANEL = readFileSync(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");

/** 复刻 `ChatPanel.StreamFadeText` 的**纯逻辑**部分（水位判定）。
 *  ⚠️ 必须与源码同构：源码变了而这里没变 ⇒ 守卫测的是幻觉。故另有一条结构断言钉住源码形态。 */
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

/** 逐帧跑一段流式文本，返回每帧的"新挂渐入的单元"（`at:text`）。 */
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
    // 断言：b **不是**以 a 开头 —— 即已定型前缀被回溯改写了
    expect(b.startsWith(a), `非单调性消失了？a=${JSON.stringify(a)} b=${JSON.stringify(b)}`).toBe(false);
    // 具体形态：那个已显示的空格被删
    expect(a).toBe("DeepSeek s w");
    expect(b).toBe("DeepSeek swe");
  });

  it("🐛 `splitToolTrace` 在工具块标题写全的瞬间砍掉已显示内容（第二条非单调来源）", () => {
    // 标题**未写全**时还在正文里（用户已经看到这半行）
    const before = splitToolTrace("我在思考\n### 工具调用记").text;
    // 最后一个「录」到达 ⇒ 标题成立 ⇒ 整段（含已显示的那半行）被砍
    const after = splitToolTrace("我在思考\n### 工具调用记录").text;
    expect(before).toBe("我在思考\n### 工具调用记");
    expect(after).toBe("我在思考");
    expect(after.startsWith(before), "砍块行为消失了？").toBe(false);
  });

  it("对**完整**（非流式）输入，净化仍是确定性的正确结果（非单调只发生在流式中间态）", () => {
    expect(sanitizeThinking("B ing")).toBe("Bing");
    expect(sanitizeThinking("S tudio")).toBe("Studio");
    // `b c`（两个独立 token）不许被误拼 —— 这正是 `{2,}` 不能放宽的原因
    expect(sanitizeThinking("b c")).toBe("b c");
  });
});

describe("A-1095 #6-B 不变量：已出现的字**绝不重播**渐入（闪烁的正面判据）", () => {
  it("🐛 英文断词触发的回溯改写：逐 token 流入全过程 0 次重播", () => {
    // 复现 R1 的真实到达序列（上游逐 token，净化每帧对整段重算）
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
    // 每个字符至少在一个帧里以 fresh 身份出现过（用其内容出现的集合近似）
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
    // 两个 `人` 的 `at` 不同 ⇒ 都播过 ⇒ fresh 记录里有两条
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
  /** 取 `StreamFadeText` 的函数体：右界 = 下一个顶层声明。
   *  ⚠️ 不硬编码宽度 —— 注释一膨胀就会把断言目标挤出窗口 ⇒ 守卫**静默失效**。 */
  const fadeBody = (): string => {
    const at = PANEL.indexOf("function StreamFadeText");
    expect(at, "找不到 StreamFadeText（渐入渲染的唯一产地）").toBeGreaterThan(-1);
    const nextDecl = PANEL.slice(at + 10).search(/\n(?:function |const |export )/);
    return PANEL.slice(at, nextDecl > 0 ? at + 10 + nextDecl : at + 3000);
  };

  it("源码里有单调水位 ref，且判定是 `at > 水位`", () => {
    const blk = fadeBody();
    expect(blk, "没有水位 ref").toMatch(/useRef\(\s*-1\s*\)/);
    // 判定：只有超过水位才挂渐入类
    expect(blk, "没有按 `at > 水位` 判定").toMatch(/u\.at\s*>\s*seenAt/);
    // 水位必须单调推进（对超过水位的单元取 max）
    expect(blk, "水位没有推进").toMatch(/maxAtRef\.current\s*=\s*u\.at/);
    // 换轮重置（否则新一轮整轮漏播）
    expect(blk, "没有换轮重置").toMatch(/startsWith\(prevTextRef\.current\)/);
  });

  it("🐛 不许退回「假设下标稳定」的写法（`key={u.at}` 仍保留，但类名不再恒挂）", () => {
    const blk = fadeBody();
    // 恒挂 className="stream-fade-unit" 就是旧写法（每帧重挂必重播）
    expect(blk, "渐入类名又变成恒挂（回退到每帧重播）").not.toMatch(/className="stream-fade-unit"/);
    // key 仍是 at（A-1070 的稳定锚点），不能改成内容
    expect(blk, "key 不再是 at").toMatch(/key=\{u\.at\}/);
  });

  it("思考内容确实走 StreamFadeText（本 spec 的场景在真实路径上存在）", () => {
    // streamingTail 分流：只有流式最后一段思考走渐入
    expect(PANEL).toContain("streamingTail ? <StreamFadeText text={cleanThink} />");
  });
});
