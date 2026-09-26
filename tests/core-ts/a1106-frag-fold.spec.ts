/**
 * a1106-frag-fold.spec.ts — A-1106：`normalizeBrokenLines`（token 碎片换行折叠）的**误判收敛**。
 *
 * ## 修的缺陷（我自己在前一轮「诚实交代」里报的未修残留）
 *
 *   `normalizeBrokenLines("正文\n\n## 标题")` 旧实现返回 `"正文 ## 标题"` —— **标题被碾平**。
 *   原因两条（都在旧判据里）：
 *     ① 折叠时用的是**整段文本的所有行**（`lines.map(...)`），不是「判定命中的那一块」
 *        ⇒ **跨空行折叠**，把两个 markdown 块并成一个段落；
 *     ② 统计碎片比例时排除了结构行（标题/列表/表格…），**折叠时却把它们一起拼进去**
 *        ⇒ `正文\n## 标题\n结束` 被碾成 `"正文 ## 标题 结束"`（结构行被当成碎片吃掉）。
 *
 * ## 新判据（取向：宁可漏折叠，也不误折叠）
 *
 *   先按**空行**切块（空行是 markdown 的块边界）→ 逐块判定：块内 ≥3 行、无任何 markdown
 *   结构标记、且内容行半数以上 ≤4 字符 → **只折叠这一块**，其余块原样保留。
 *
 * ## 判据为什么必须配「自检段」
 *
 *   本 spec 里既有「不折叠」也有「仍折叠」的断言。若新判据被改成恒不折叠（例如误把
 *   `foldTokenFragBlock` 的 `< 3` 写成 `>= 3`），「不折叠」那群断言会**全绿**——所以必须
 *   有反向样本（真碎片流仍要折叠）证明判据没有空转；末尾再补一段「喂已知旧产物」的自检。
 */
import { describe, it, expect } from "vitest";
import { normalizeBrokenLines } from "../../gui/src/renderer/pages/Markdown.js";

describe("A-1106①：跨空行不折叠（空行 = markdown 块边界）", () => {
  it("短句 + 短标题 → 标题不再被碾平（原残留缺陷的最小复现）", () => {
    expect(normalizeBrokenLines("正文\n\n## 标题")).toBe("正文\n\n## 标题");
    expect(normalizeBrokenLines("说明。\n\n## 小标题")).toBe("说明。\n\n## 小标题");
  });

  it("多个短段落不被并成一行", () => {
    expect(normalizeBrokenLines("你好\n\n世界\n\n再见")).toBe("你好\n\n世界\n\n再见");
  });

  it("正常两段文本（既有行为不变）", () => {
    const s = "第一段说明。\n\n第二段很长的一行说明文字内容长度足够避免误判。";
    expect(normalizeBrokenLines(s)).toBe(s);
  });
});

describe("A-1106②：块内含 markdown 结构 ⇒ 整块绝不折叠（硬门）", () => {
  it("标题夹在短行之间 → 原样", () => {
    expect(normalizeBrokenLines("正文\n## 标题\n结束")).toBe("正文\n## 标题\n结束");
    expect(normalizeBrokenLines("正文\n### 三级\n结束")).toBe("正文\n### 三级\n结束");
  });

  it("列表 / 表格 / 引用 / 围栏 / 缩进码块都是硬门", () => {
    const cases = [
      "优点\n- 快\n- 稳",
      "步骤\n1. 建\n2. 改",
      "表头\n| a | b |\n|---|--|",
      "说明\n> 引用\n结束",
      "说明\n```\ncode\n```",
      "说明\n    indented\n结束",
    ];
    for (const c of cases) { expect(normalizeBrokenLines(c)).toBe(c); }
  });
});

describe("A-1106③：真碎片流仍要修复（判据不许空转）", () => {
  it("逐词断行（同一块、无空行）→ 折叠", () => {
    expect(normalizeBrokenLines("用\n户\n的\n工\n作\n目\n录")).toBe("用户的工作目录");
    expect(normalizeBrokenLines("The\nuser\nis\nasking\nme")).toBe("The user is asking me");
  });

  it("数字/短词夹杂的碎片行：不丢数字", () => {
    expect(normalizeBrokenLines("389\nk\nstars\n、\n81\n.7\nk\nforks")).toBe("389 k stars 、 81 .7 k forks");
  });

  it("**只折叠命中的那一块**，其它块原样保留", () => {
    const src = "用\n户\n的\n\n这是一行足够长的正常说明文字内容不少于二十个字符。";
    expect(normalizeBrokenLines(src)).toBe("用户的\n\n这是一行足够长的正常说明文字内容不少于二十个字符。");
  });
});

describe("A-1106④：判据自检（喂已知坏样本）", () => {
  it("旧实现的产物必须是「不合格」的", () => {
    // 旧实现对这两个输入分别产出 `正文 ## 标题` / `正文 ## 标题 结束`；
    // 若哪天判据退回去，下面两条会立刻失败。
    expect(normalizeBrokenLines("正文\n\n## 标题")).not.toBe("正文 ## 标题");
    expect(normalizeBrokenLines("正文\n## 标题\n结束")).not.toBe("正文 ## 标题 结束");
    // 更强的正向判据：标题标记必须原样留在结果里
    expect(normalizeBrokenLines("正文\n\n## 标题")).toContain("## 标题");
    expect(normalizeBrokenLines("正文\n## 标题\n结束")).toContain("## 标题");
  });
});
