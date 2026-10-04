/**
 * tests/core-ts/a1133-ppt-slides.spec.ts — 老版 `.ppt` 文本抽取的守卫（A-1133）。
 *
 * 需求（用户原话）：「PPT 甚至连内容都没有」。
 *
 * ## 事故形状（2026-09-28，用真实文件取证）
 * `jeny_第二章.ppt`（6.1MB）的 `PowerPoint Document` 流里有 **837** 个文本原子：
 *   · `Slide` 容器内 **618** 个 = 真正的课程正文
 *   · `Notes` 容器内 **167** 个 = 「单击此处编辑母版文本样式\r第二级\r第三级…」
 *   · `MainMaster` 容器内 **52** 个 = 「单击此处编辑母版标题样式」
 * 旧实现**不区分容器**，把 837 个原子按**流的物理顺序**拼起来 ⇒ 219 个母版/备注占位符
 * 排在正文之前 ⇒ 用户第一屏全是「单击此处编辑母版标题样式」，真内容被淹没；且**没有页边界**。
 *
 * ## 本文件锁什么
 *   ① 只收 `Slide` 容器内的原子（母版/备注必须被排除）；
 *   ② 按 Slide 顺序**分页**（`pages.length` == Slide 容器数，含纯图片的**空页**）；
 *   ③ 被排除的原子数**如实统计**（不许静默丢弃）；
 *   ④ 截断（recLen 越界）时**停止不猜**。
 *
 * ⚠️ 夹具是**手工拼的合成字节**（不依赖任何真实 .ppt、也不依赖 CFB 容器）——
 *    被测的是纯函数 `collectPptSlides`，它只吃"记录流"这一层。
 */
import { describe, expect, it } from "vitest";
import { collectPptSlides, pptPageMarker } from "../../core-ts/src/doc_text.js";
import { buildDocView } from "../../gui/src/renderer/pages/docView.js";

/* MS-PPT 记录：recVer/recInstance(2) + recType(2) + recLen(4) + payload（无对齐填充） */
const RT_DOCUMENT = 0x03e8;
const RT_SLIDE = 0x03ee;
const RT_NOTES = 0x03f0;
const RT_MAIN_MASTER = 0x03f8;
const RT_TEXT_CHARS = 0x0fa0;
const RT_TEXT_BYTES = 0x0fa8;

/** 容器记录（recVer=0xF），recLen 覆盖全部子记录 —— 这里由 payload 长度自动给出 */
function container(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x000f, 0);          // recVer=0xF ⇒ 容器
  head.writeUInt16LE(type, 2);
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

/** 文本原子（recVer=0 ⇒ 叶子记录） */
function textAtom(s: string, opts: { bytes?: boolean } = {}): Buffer {
  const payload = opts.bytes ? Buffer.from(s, "latin1") : Buffer.from(s, "utf16le");
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0000, 0);
  head.writeUInt16LE(opts.bytes ? RT_TEXT_BYTES : RT_TEXT_CHARS, 2);
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

/** 复刻真实事故形状：母版在前、备注在中、两个 Slide 各自带正文 —— 且母版文本"排在前头" */
function accidentStream(): Buffer {
  return Buffer.concat([
    container(RT_MAIN_MASTER, textAtom("单击此处编辑母版标题样式")),
    container(RT_DOCUMENT, Buffer.concat([
      container(RT_SLIDE, Buffer.concat([textAtom("第一页正文"), textAtom("第二行")])),
      container(RT_NOTES, textAtom("单击此处编辑母版文本样式\r第二级\r第三级")),
      container(RT_SLIDE, textAtom("第二页正文")),
    ])),
  ]);
}

describe("A-1133-PPT1 只收 Slide 容器（母版/备注不许混进正文）", () => {
  it("母版与备注的文字被排除，正文只剩 Slide 内的原子", () => {
    const scan = collectPptSlides(accidentStream());
    expect(scan.pages).toEqual([["第一页正文", "第二行"], ["第二页正文"]]);
  });

  it("⚠️ 事故本体回归：正文里**不许**出现母版/备注占位符", () => {
    /* 用户在截图里看到的就是这一串 —— 只要它进了正文，本用例必红。 */
    const scan = collectPptSlides(accidentStream());
    const all = scan.pages.flat().join("\n");
    expect(all, "母版占位符混进了正文（用户截图里那一屏）").not.toContain("单击此处编辑母版");
    expect(all).not.toContain("第二级");
  });

  it("被排除的原子**必须计数**（不许静默丢弃 —— 少了内容时这是唯一诊断线索）", () => {
    const scan = collectPptSlides(accidentStream());
    expect(scan.slideAtoms, "进正文的原子数").toBe(3);      // 第一页 2 + 第二页 1
    expect(scan.excludedAtoms, "被排除的原子数（母版 1 + 备注 1）").toBe(2);
    expect(scan.notesPages, "备注页个数").toBe(1);
  });

  it("既不在 Slide 也不在已知容器里的原子同样不计入正文，但仍被计数", () => {
    /* 裸放在 root 的文本原子：不是"幻灯片上的字"，收进来就是第二产地。 */
    const stream = Buffer.concat([textAtom("游离文本"), container(RT_SLIDE, textAtom("正文"))]);
    const scan = collectPptSlides(stream);
    expect(scan.pages).toEqual([["正文"]]);
    expect(scan.excludedAtoms).toBe(1);
  });
});

describe("A-1133-PPT2 必须按 Slide 分页（页边界是这一族唯一的结构）", () => {
  it("pages.length == Slide 容器数（顺序 = 出现顺序，不是流里文本的物理顺序）", () => {
    const scan = collectPptSlides(accidentStream());
    expect(scan.pages).toHaveLength(2);
    expect(scan.pages[0][0], "第 1 页必须是第一个 Slide 的内容").toBe("第一页正文");
    expect(scan.pages[1][0]).toBe("第二页正文");
  });

  it("⚠️ 纯图片页（没有任何文本原子）也**保留页位** —— 空页是信息，不是噪声", () => {
    const stream = container(RT_DOCUMENT, Buffer.concat([
      container(RT_SLIDE, textAtom("有字的一页")),
      container(RT_SLIDE, Buffer.alloc(0)),      // 纯图页
    ]));
    const scan = collectPptSlides(stream);
    expect(scan.pages).toHaveLength(2);
    expect(scan.pages[1]).toEqual([]);
  });

  it("多行文本按出现顺序保留在**同一页**内（不许拆页、不许跨页并）", () => {
    const stream = container(RT_SLIDE, Buffer.concat([textAtom("A"), textAtom("B"), textAtom("C")]));
    expect(collectPptSlides(stream).pages).toEqual([["A", "B", "C"]]);
  });

  it("TextBytesAtom（单字节）与 TextCharsAtom 同等对待", () => {
    const stream = container(RT_SLIDE, Buffer.concat([textAtom("ascii", { bytes: true }), textAtom("中文")]));
    expect(collectPptSlides(stream).pages).toEqual([["ascii", "中文"]]);
  });
});

describe("A-1133-PPT3 页标记：与 pptx 同形状，且下游真能认出（否则页卡片不出现）", () => {
  it("`pptPageMarker` 的格式与 docView 的 PAGE_RE 对齐", () => {
    expect(pptPageMarker(3)).toBe("--- 第 3 页 ---");
  });

  it("⚠️ 端到端形状：把分页结果喂给 buildDocView ⇒ 真能建出页卡片", () => {
    /* 这条锁的是**两族共用的接线**：ppt 产出的标记必须被渲染层认出来。
       标记一改（比如去掉 `---`），这里立刻红 —— 用户看到的就是"所有页又粘成一块"。 */
    const text = [pptPageMarker(1), "第一页", "", pptPageMarker(2), "第二页"].join("\n");
    const blocks = buildDocView("powerpoint", text);
    const pages = blocks.filter((b) => b.type === "page");
    expect(pages, "分页标记没被认出来（页卡片不会出现）").toHaveLength(2);
    expect(pages.map((p) => (p.type === "page" ? p.label : ""))).toEqual(["第 1 页", "第 2 页"]);
  });

  it("空页也要有标记（纯图页在渲染层应得到一张空卡片，而不是被并进上一页）", () => {
    const text = [pptPageMarker(1), "第一页", "", pptPageMarker(2), "", pptPageMarker(3), "第三页"].join("\n");
    const pages = buildDocView("powerpoint", text).filter((b) => b.type === "page");
    expect(pages).toHaveLength(3);
  });
});

describe("A-1133-PPT4 边界：截断不猜", () => {
  it("recLen 越过流尾 ⇒ 立刻停止（不猜、不硬读）", () => {
    const bad = Buffer.alloc(8);
    bad.writeUInt16LE(0x0000, 0);
    bad.writeUInt16LE(RT_TEXT_CHARS, 2);
    bad.writeUInt32LE(9999, 4);                 // 声称有 9999 字节，实际没有
    const scan = collectPptSlides(bad);
    expect(scan.pages).toEqual([]);
    expect(scan.slideAtoms).toBe(0);
  });

  it("空流 ⇒ 没有页、也没有原子（不抛错）", () => {
    expect(collectPptSlides(Buffer.alloc(0)).pages).toEqual([]);
  });
});
