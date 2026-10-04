





















import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BODY_TYPING,
  IDLE_TAIL_TYPING,
  THINK_TYPING,
  TYPING_STEP_MS,
  advanceTailTyping,
  advanceTypingShown,
  tailTypingHasBacklog,
  tailTypingTarget,
  trimTailToShown,
  type TypingTailStep,
} from "../../gui/src/renderer/pages/streamTyping.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PANEL = readFileSync(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"), "utf8");

const PANEL_C = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");


const TYPING_CATCHUP_MIN = 4;

describe("A-1128-A 打字机（纯判据）：逐字 / 追赶 / 换轮重置", () => {
  it("节拍就是 28ms/字（唯一出处；改它等于直接改观感）", () => {
    


    expect(TYPING_STEP_MS).toBe(28);
    expect(BODY_TYPING.stepMs).toBe(28);
  });

  it("常态：到点推进 1 字，没到点一个字都不动", () => {
    const a = advanceTypingShown("你", "你好世界", 1_000, 1_028);
    expect(a.shown).toBe("你好");
    expect(a.emitted, "推进了却没报 emitted ⇒ 吐字光标会算错").toBe(true);
    const b = advanceTypingShown("你", "你好世界", 1_000, 1_027);
    expect(b.shown, "没到节拍就推进 ⇒ 一帧吐一串（又变整块）").toBe("你");
    expect(b.emitted).toBe(false);
  });

  it("积压过大 → 按比例追赶（否则显示位置无限滞后）", () => {
    const full = "字".repeat(1_000);
    const a = advanceTypingShown("", full, 0, 1);
    const jumped = a.shown.length;
    expect(jumped, "积压 1000 字时还一次只吐 1 字 ⇒ 追上要好几分钟").toBeGreaterThan(TYPING_CATCHUP_MIN);
    
    expect(jumped, "一口气把 1000 字全吐了 ⇒ 缓冲形同虚设").toBeLessThan(full.length);
    expect(full.startsWith(a.shown), "推进结果必须仍是全文前缀").toBe(true);
  });

  it("文本不再以已显示内容为前缀（换轮 / 被回溯改写）→ 从零重来", () => {
    

    const a = advanceTypingShown("旧内容", "全新的正文", 0, 10_000);
    expect(a.shown.length, "没重置 ⇒ 拿旧长度去切新文本").toBeLessThanOrEqual(1);
    expect("全新的正文".startsWith(a.shown)).toBe(true);
  });

  it("已经全显示 → 不动（同值返回，别让调用方白重渲染）", () => {
    const a = advanceTypingShown("全文", "全文", 0, 10_000);
    expect(a.shown).toBe("全文");
    expect(a.emitted).toBe(false);
  });

  it("思考的追赶**比正文温和**（它是实时区，追太猛就又变整块蹦）", () => {
    expect(THINK_TYPING.divisor, "思考的追赶分母必须大于正文的").toBeGreaterThan(BODY_TYPING.divisor);
    expect(THINK_TYPING.catchupChars).toBeGreaterThanOrEqual(BODY_TYPING.catchupChars);
    expect(THINK_TYPING.stepMs, "节拍与正文同源（单一口径）").toBe(TYPING_STEP_MS);
    expect(BODY_TYPING.stepMs).toBe(TYPING_STEP_MS);
  });
});



describe("A-1128-A2 尾巴目标与缓冲状态", () => {
  it("只有末位是文本节点（think/body）才算尾巴；工具卡 / 规划卡不是", () => {
    expect(tailTypingTarget([])).toBeNull();
    expect(tailTypingTarget([{ kind: "tool" }]), "工具卡不该被逐字吐").toBeNull();
    expect(tailTypingTarget([{ kind: "plan" }])).toBeNull();
    expect(tailTypingTarget([{ kind: "think", text: "abc" }])).toEqual({ key: "0:think", text: "abc" });
    expect(tailTypingTarget([{ kind: "tool" }, { kind: "body", text: "x" }])).toEqual({ key: "1:body", text: "x" });
  });

  it("key 用**位置 + 类型**（chunk 每帧都会重建末位对象，拿对象当 key 会每帧'换节点'）", () => {
    const a = tailTypingTarget([{ kind: "think", text: "ab" }]);
    const b = tailTypingTarget([{ kind: "think", text: "abc" }]);
    expect(b!.key, "同一段的增量被当成了新节点 ⇒ 每帧从零重吐（闪烁）").toBe(a!.key);
  });

  it("换节点 → 从零开始吐；同一节点 → 接着吐；没尾巴 → 空闲态", () => {
    let s = advanceTailTyping(IDLE_TAIL_TYPING, { key: "0:think", text: "你好世界" }, 1_000);
    expect(s.shown).toBe("你");
    s = advanceTailTyping(s, { key: "0:think", text: "你好世界" }, 1_028);
    expect(s.shown, "同一节点应接着吐").toBe("你好");
    s = advanceTailTyping(s, { key: "1:body", text: "另起一段" }, 2_000);
    expect(s.shown, "换了节点却没从零开始 ⇒ 显示错位切片").toBe("另");
    expect(advanceTailTyping(s, null, 3_000), "没有尾巴时必须回到空闲态").toBe(IDLE_TAIL_TYPING);
  });

  it("自续判据：欠着字 / 换了节点 都算有积压；吐平了就不算", () => {
    const steps: TypingTailStep[] = [{ kind: "think", text: "你好" }];
    expect(tailTypingHasBacklog(IDLE_TAIL_TYPING, steps), "换了节点（还没吐）应算有积压").toBe(true);
    const done = { key: "0:think", shown: "你好", lastAt: 0 };
    expect(tailTypingHasBacklog(done, steps), "已经吐平了还在自续 ⇒ 白烧 60fps").toBe(false);
    expect(tailTypingHasBacklog({ ...done, shown: "你" }, steps)).toBe(true);
    expect(tailTypingHasBacklog(done, [{ kind: "tool" }])).toBe(false);
  });
});

describe("A-1128-A3 渲染截断：只动末位 / 形态对不上时整段显示", () => {
  const steps: TypingTailStep[] = [
    { kind: "think", text: "第一段已经定型" },
    { kind: "tool" },
    { kind: "think", text: "第二段正在吐" },
  ];

  it("只截断**末位**文本节点，前面的节点按真源全量渲染（内容不丢）", () => {
    const out = trimTailToShown(steps, "第二段");
    expect(out).toHaveLength(3);
    expect((out[0] as TypingTailStep).text, "前面的节点被削了 ⇒ 用户读到的历史被吞").toBe("第一段已经定型");
    expect((out[2] as TypingTailStep).text).toBe("第二段");
    expect(out[2], "末位没有被截断 ⇒ 思考又整块蹦").not.toBe(steps[2]);
  });

  it("末位不是文本节点 / 已吐平 → **同一个数组引用**（React 据此 bail out）", () => {
    const toolLast: TypingTailStep[] = [{ kind: "think", text: "a" }, { kind: "tool" }];
    expect(trimTailToShown(toolLast, "a")).toBe(toolLast);
    expect(trimTailToShown(steps, "第二段正在吐"), "已经全显示还造新数组 ⇒ 每帧白重渲染").toBe(steps);
    expect(trimTailToShown([], "x")).toEqual([]);
  });

  it("⚠️ 文本不是以显示缓冲开头（恢复/重建后形态对不上）→ **整段显示**，绝不显示错位切片", () => {
    const rebuilt: TypingTailStep[] = [{ kind: "think", text: "重建后的完全不同的内容" }];
    expect(trimTailToShown(rebuilt, "上一轮的尾巴"), "按错位的长度切了 ⇒ 用户看到一段驴唇不对马嘴的话")
      .toBe(rebuilt);
  });
});

describe("A-1128-B 接线：思考那条缓冲挂在 rAF 上、有自续、且不越权改真源", () => {
  it("rAF 里确实推进了思考缓冲（目标取自真源 timelineStepsRef）", () => {
    expect(PANEL_C, "思考缓冲没接到 rAF 上 ⇒ 思考又整块吐").toContain("advanceTailTyping(");
    expect(PANEL_C, "目标不是从真源现算的").toContain("tailTypingTarget(timelineStepsRef.current)");
    expect(PANEL_C, "显示缓冲没进 state ⇒ 渲染看不到").toContain("setTailShown(");
  });

  it("渲染侧走唯一接口截断（否则缓冲算得再准也没人用）", () => {
    expect(PANEL_C, "实时时间线没有按显示缓冲截断 ⇒ 缓冲白做").toContain("trimTailToShown(liveTimeline, tailShown)");
  });

  it("⚠️ 思考缓冲**有自己的自续条件**（否则尾巴会停在一半、看起来像内容丢了）", () => {
    

    expect(PANEL_C, "思考缓冲没有自续 ⇒ 尾巴会停在一半").toContain(
      "tailTypingHasBacklog(tailTypingRef.current, timelineStepsRef.current)",
    );
  });

  it("缓冲**只动显示层**：真源 `timelineStepsRef` 不许被截断结果写回", () => {
    expect(PANEL_C, "把截断结果写回了真源 ⇒ 持久化/恢复会丢字").not.toMatch(/timelineStepsRef\.current\s*=\s*trimTailToShown/);
    
    const uses = PANEL_C.split("trimTailToShown(").length - 1;
    expect(uses, `trimTailToShown 被用了 ${uses} 次 —— 唯一接口只该在渲染那一处`).toBe(1);
    
    expect(PANEL_C, "resetPartial 没清思考缓冲").toContain("tailTypingRef.current = IDLE_TAIL_TYPING;");
  });

  it("不许**顺手**把正文那条删掉（用户裁决：正文维持收尾统一输出，本次只改思考）", () => {
    expect(PANEL_C, "正文的显示层缓冲被删了 —— 那是另一件事，本次不动").toContain("displayPartialRef");
    expect(PANEL_C, "正文后置闸门的镜像被删了").toContain("bodyGateRef");
    
    expect(PANEL_C, "正文自续丢了 !gated ⇒ 关闸期 60fps 空转").toMatch(
      /if \(!gated && displayPartialRef\.current\.length < partialRef\.current\.length\)/,
    );
  });
});
