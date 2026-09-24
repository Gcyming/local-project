/**
 * tests/core-ts/a1093-diff-marker.spec.ts — A-1093：改动标记「显示判据写死」的守卫。
 *
 * ## 这一轮根除的缺陷
 *
 * 用户原话：「现在怎么写入等文件修改之类的卡片有没有不同颜色的加和减的标识了？……
 * 哦我知道了，要同时有增有删才显示？**不行，都给我显示**。而且这次你给我**根除**这个毛病，
 * 把这个会显示修改对比的设定**写死在 slime**，反正以后也不会删掉。顶多改一下前端的 UI 表现样式。」
 *
 * 旧缺陷：显示判据是 `add > 0 && del > 0`（**同时**有增有删），而 `add`/`del` 是**行集合差**：
 *   · 新建文件（old 为空）→ 只有增、`del === 0` → **不显示**；
 *   · 纯追加 / 纯删除 → 同理 → **不显示**。
 * 于是最常见的那种写入（新建文件）恰恰是唯一看不到改动数字的场景。
 *
 * ## 本 spec 的三重职责
 *
 * ① **core 侧行为**（`diff_marker.ts`）：判据 `||`、构造器、解析器、截断占位。
 * ② **跨实现一致性**：渲染层 `chatProducts.ts` 的 `parseDiffStat` 是 `atob` 版（渲染进程没有
 *    `Buffer`，A-979），与 core 侧 `parseDiffStatCore` 是**两份实现** —— 必须同规。
 *    这里用**同一批输入喂两边、断言结果逐字段相等**，任何一边漂了立刻红。
 * ③ **源码字面量守卫**：判据是"写死"的，任何把它重新变成开关的行为都该被拦。
 *
 * ⚠️ 本 spec 存在的直接理由是：`diff_marker.ts` 的头部注释**引用了它**。
 *    文件头注释指向不存在的 spec = 假声明（本仓库铁律明令禁止）——
 *    所以这份文件既是守卫，也是把那条假声明兑现。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DIFF_MARKER_RE,
  DIFF_TRIMMED_MARKER,
  diffStatOf,
  hasVisibleDiff,
  b64ToTextCore,
  buildDiffMarker,
  parseDiffStatCore,
} from "../../core-ts/src/diff_marker.js";
import { parseDiffStat } from "../../gui/src/renderer/pages/chatProducts.js";

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

/* ───────────────────── A 组：构造器（唯一产地）───────────────────── */

describe("A-1093 A 组 — buildDiffMarker 是唯一产地", () => {
  it("A1 内容未改动 → 空串（不嵌标记，回执保持可读）", () => {
    expect(buildDiffMarker("same", "same")).toBe("");
    expect(buildDiffMarker("", "")).toBe("");
  });

  it("A2 新建文件（old 为空）→ **必须**产出标记（旧判据在这里静默丢弃）", () => {
    const m = buildDiffMarker("", "hello\nworld");
    expect(m).not.toBe("");
    expect(m.startsWith("\n")).toBe(true);
    expect(DIFF_MARKER_RE.test(m)).toBe(true);
  });

  it("A3 标记形态与正则同源：构造出来的东西一定能被自己的正则吃下", () => {
    for (const [o, n] of [["a", "b"], ["", "x"], ["x", ""], ["多行\n内容", "多行\n改过"]] as const) {
      const m = buildDiffMarker(o, n);
      expect(m).not.toBe("");
      expect(DIFF_MARKER_RE.test(m), `构造/解析不同源：old=${JSON.stringify(o)}`).toBe(true);
    }
  });

  it("A4 标记里携带的是**原文**（round-trip：解析回来必须逐字节相等）", () => {
    const oldTxt = "第一行\n第二行\n带中文与 emoji 🚀";
    const newTxt = "第一行\n改过的第二行";
    const m = buildDiffMarker(oldTxt, newTxt);
    const oldB64 = m.match(DIFF_MARKER_RE)?.[1] ?? "";
    const newB64 = m.match(DIFF_MARKER_RE)?.[2] ?? "";
    expect(b64ToTextCore(oldB64)).toBe(oldTxt);
    expect(b64ToTextCore(newB64)).toBe(newTxt);
  });
});

/* ───────────────────── B 组：判据是 `||`（本轮的核心改动）───────────────────── */

describe("A-1093 B 组 — hasVisibleDiff 判据必须是「有任何改动就显示」", () => {
  it("B1 只有增（新建 / 纯追加）→ 可见（旧 `&&` 判据在这里返回 false）", () => {
    expect(hasVisibleDiff({ add: 5, del: 0 })).toBe(true);
  });

  it("B2 只有删（纯删除）→ 可见（旧 `&&` 判据在这里返回 false）", () => {
    expect(hasVisibleDiff({ add: 0, del: 3 })).toBe(true);
  });

  it("B3 有增有删 → 可见", () => {
    expect(hasVisibleDiff({ add: 2, del: 1 })).toBe(true);
  });

  it("B4 无任何改动 → 不可见", () => {
    expect(hasVisibleDiff({ add: 0, del: 0 })).toBe(false);
  });

  it("B5 null / undefined → 不可见（不许抛）", () => {
    expect(hasVisibleDiff(null)).toBe(false);
    expect(hasVisibleDiff(undefined)).toBe(false);
  });
});

/* ───────────────────── C 组：行集合差口径 ───────────────────── */

describe("A-1093 C 组 — diffStatOf 行集合差口径", () => {
  it("C1 新建文件：add = 非空行数，del = 0", () => {
    expect(diffStatOf("", "a\nb\nc")).toEqual({ add: 3, del: 0 });
  });

  it("C2 纯追加：只增不删", () => {
    expect(diffStatOf("a\nb", "a\nb\nc\nd")).toEqual({ add: 2, del: 0 });
  });

  it("C3 纯删除：只删不增", () => {
    expect(diffStatOf("a\nb\nc\nd", "a\nb")).toEqual({ add: 0, del: 2 });
  });

  it("C4 空行不计（换行处不应虚报 N 行改动）", () => {
    expect(diffStatOf("a\n\n\nb", "a\n\nb")).toEqual({ add: 0, del: 0 });
  });

  it("C5 位置重排 → add=0, del=0（已知且接受的近似：内容确实一行没多一行没少）", () => {
    expect(diffStatOf("a\nb\nc", "c\nb\na")).toEqual({ add: 0, del: 0 });
  });

  it("C6 同一行重复出现只计一次（集合差，不是行数差）", () => {
    expect(diffStatOf("a", "a\na\na")).toEqual({ add: 0, del: 0 });
  });
});

/* ───────────────────── D 组：解析器 ───────────────────── */

describe("A-1093 D 组 — parseDiffStatCore 只在「有可显示改动」时给非 null", () => {
  it("D1 无标记 / 空串 / undefined → null", () => {
    expect(parseDiffStatCore(undefined)).toBeNull();
    expect(parseDiffStatCore("")).toBeNull();
    expect(parseDiffStatCore("已保存 10 字节到 /tmp/x")).toBeNull();
  });

  it("D2 标记 base64 损坏 → 不抛、给 null（不许把整条回执炸掉）", () => {
    expect(parseDiffStatCore("[__slime_diff__]!!!not-base64!!!|$$$[/__slime_diff__]")).toBeNull();
  });

  it("D3 新建文件的回执 → 返回 { add: N, del: 0 }（非 null —— 这正是本轮修的）", () => {
    const r = `已保存 12 字节到 /tmp/new.ts${buildDiffMarker("", "line1\nline2")}`;
    expect(parseDiffStatCore(r)).toEqual({ add: 2, del: 0 });
  });

  it("D4 **无任何改动**的标记 → null（解析器自己收口，调用方不必再判一次）", () => {
    // 理论上构造器不会产出这种（同内容 → 空串），但历史数据里可能存在。
    const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64");
    const r = `[__slime_diff__]${b64("same\nline")}|${b64("same\nline")}[/__slime_diff__]`;
    expect(parseDiffStatCore(r)).toBeNull();
  });
});

/* ───────────────────── E 组：跨实现一致性（渲染层 atob 版 vs core Buffer 版）───────────────────── */

describe("A-1093 E 组 — 跨实现一致性（两份实现必须同规）", () => {
  /** 一批覆盖各形态的输入 —— 两边喂同一批，结果必须逐字段相等 */
  const CASES: Array<[string, string]> = [
    ["", "line1\nline2"],                  // 新建：只有增
    ["a\nb", "a\nb\nc"],                   // 纯追加：只有增
    ["a\nb\nc", "a"],                      // 纯删除：只有删
    ["a\nb", "a\nc"],                      // 有增有删
    ["same", "same"],                      // 无改动
    ["", ""],                              // 全空
    ["带中文\nemoji 🚀", "带中文\n改过"],   // 非 ASCII
    ["a\n\nb", "a\nb"],                    // 空行
    ["x\ny\nz", "z\ny\nx"],                // 重排
  ];

  it("E1 逐个用例：core 侧 parseDiffStatCore 与渲染侧 parseDiffStat **深度相等**", () => {
    for (const [o, n] of CASES) {
      const receipt = `已保存 N 字节到 /tmp/f.ts${buildDiffMarker(o, n)}`;
      const core = parseDiffStatCore(receipt);
      const renderer = parseDiffStat(receipt);
      expect(renderer, `不一致（old=${JSON.stringify(o)} new=${JSON.stringify(n)}）`).toEqual(core);
    }
  });

  it("E2 两份实现的正则**字面量同源**（改一边必须改另一边）", () => {
    const rendererSrc = read("gui/src/renderer/pages/chatProducts.ts");
    // ⚠️ 两侧量词必须是 `*`（允许空 base64）—— 新建文件时左半边为空，`+` 会让标记匹配不上。
    // 全仓（core 唯一出处 + 渲染层两处解析 + 留痕剥离）必须逐字符同源。
    const EXPECT_SRC = "\\[__slime_diff__\\]([A-Za-z0-9+/=]*)\\|([A-Za-z0-9+/=]*)\\[\\/__slime_diff__\\]";
    expect(DIFF_MARKER_RE.source).toBe(EXPECT_SRC);
    // chatProducts.ts 有两处解析器（parseDiffStat / parseDiffFull）都必须用这一形态
    const hits = rendererSrc.split(EXPECT_SRC).length - 1;
    expect(hits, "parseDiffStat 与 parseDiffFull 两处正则必须同为 `*` 形态").toBe(2);
    // 不许回退到 `+`（旧的静默失效形态）
    expect(rendererSrc).not.toMatch(/\[__slime_diff__\\\]\(\[A-Za-z0-9\+\/=\]\+\|/);
    // 留痕剥离正则（thinkingText.ts）同样必须允许空侧：
    // 源码里该处的字面形态是「字符集 + `*` + `\|`」，旧缺陷是「字符集 + `+` + `\|`」。
    const thinkSrc = read("gui/src/renderer/pages/thinkingText.ts");
    const STAR_FORM = "[A-Za-z0-9+/=]*" + "\\|";
    const PLUS_FORM = "[A-Za-z0-9+/=]+" + "\\|";
    expect(thinkSrc, "留痕剥离正则必须允许空的一侧（`*`）").toContain(STAR_FORM);
    expect(thinkSrc, "留痕剥离正则不得回退到 `+`（新建文件的标记会被漏剥）").not.toContain(PLUS_FORM);
  });

  it("E3 判据字面量同源：两边都必须是 `||`，不许出现 `&& hasVisibleDiff` 之类旧形态", () => {
    const rendererSrc = read("gui/src/renderer/pages/chatProducts.ts");
    // 渲染层：return add > 0 || del > 0 ? ...（旧写法是 &&）
    expect(rendererSrc).toMatch(/add\s*>\s*0\s*\|\|\s*del\s*>\s*0/);
    expect(rendererSrc).not.toMatch(/add\s*>\s*0\s*&&\s*del\s*>\s*0\s*\?/);

    const coreSrc = read("core-ts/src/diff_marker.ts");
    expect(coreSrc).toMatch(/stat\.add\s*>\s*0\s*\|\|\s*stat\.del\s*>\s*0/);
  });

  it("E4 渲染层不许**调用** `Buffer.`（A-979：渲染进程没有 Buffer，会静默吞成 null）", () => {
    const rendererSrc = read("gui/src/renderer/pages/chatProducts.ts");
    // 只在**注释里**被提到（A-979 的教训）不算违规 —— 去掉注释行后再查。
    const codeOnly = rendererSrc
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(codeOnly).not.toMatch(/\bBuffer\./);
  });
});

/* ───────────────────── F 组：源码字面量守卫（「写死」的工程含义）───────────────────── */

describe("A-1093 F 组 — 生产侧不可配置（用户要求「写死在 slime」）", () => {
  it("F1 产地 builtin.ts 用唯一构造器，不许回退到内联模板串", () => {
    const src = read("core-ts/src/tools/builtin.ts");
    expect(src).toContain("buildDiffMarker(");
    // 内联 `\n[__slime_diff__]` 模板串不得再出现（构造归 diff_marker.ts）
    expect(src).not.toMatch(/`\\n\[__slime_diff__\]\$\{/);
  });

  it("F2 builtin.ts 里没有「要不要带 diff」的开关（不许出现 if (...) { ...diffTag } 形态）", () => {
    const src = read("core-ts/src/tools/builtin.ts");
    // 旧形态：const diffTag = changed ? `...` : "";
    expect(src).not.toMatch(/const diffTag = changed \?/);
  });

  it("F3 正则唯一出处：tool_loop.ts 从 diff_marker 重新导出，不再自己写一份", () => {
    const src = read("core-ts/src/tool_loop.ts");
    expect(src).toContain('export { DIFF_MARKER_RE as DIFF_TAG_RE } from "./diff_marker.js";');
    // 不许再有第二份内联正则
    expect(src).not.toMatch(/\/\\\[__slime_diff__\\\]\(\[A-Za-z0-9\+\/=\]/);
  });

  it("F4 截断占位字面量同源：chat.ts 从 diff_marker 取，不自己写", () => {
    const src = read("core-ts/src/services/chat.ts");
    expect(src).toContain("DIFF_TRIMMED_MARKER as DIFF_TRIMMED_TAG");
    expect(DIFF_TRIMMED_MARKER).toBe("[__slime_diff_trimmed__]");
  });

  it("F5 渲染层的截断占位字面量与 core 同值（两份产地必须同源）", () => {
    const src = read("gui/src/renderer/pages/thinkingText.ts");
    expect(src).toContain(`"[__slime_diff_trimmed__]"`);
    expect(src).toContain(String(DIFF_TRIMMED_MARKER).includes("[__slime_diff_trimmed__]"));
  });
});

/* ───────────────────── G 组：本 spec 兑现 diff_marker.ts 的头部声明 ───────────────────── */

describe("A-1093 G 组 — 文件头声明不许指向不存在的东西", () => {
  it("G1 diff_marker.ts 的头部注释引用了本 spec，而本 spec **确实存在**", () => {
    const src = read("core-ts/src/diff_marker.ts");
    expect(src).toContain("tests/core-ts/a1093-diff-marker.spec.ts");
    // 本文件就在这个路径上 —— 能跑到这一行即证明它不是假声明。
    expect(read("tests/core-ts/a1093-diff-marker.spec.ts").length).toBeGreaterThan(0);
  });
});
