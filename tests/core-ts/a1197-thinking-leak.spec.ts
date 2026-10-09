/**
 * A-1197 · 思考历程：切走会话后被吞 + 抢占下一个对话
 * ============================================================================
 * 用户报症：在actam模型上看到「思考内容被吞」+「抢占下一个对话的思考历程」。
 * 取证证明与模型无关 —— 是**渲染/流式层的状态对齐缺陷**，换任何模型都会复发。
 *
 * 本守卫锁住两条**真正的不变量**（都是代码形状断言，读源码 + 正则）：
 *
 *   I1「切走期间后台结束的那条流，思考必须落盘」
 *      `onDone` 的后台镜像分支（`m.sessionId !== sessionRef.current`）必须调
 *      `writeTurnTimeline`，把 `snap.reasoning` / `snap.timeline` 写进localStorage。
 *      此前该分支只写 `snap.partial` 就return —— 思考只剩内存，而内存快照
 *      在会话恢复末尾会被 `delete perSessionStreamCache.current[sessionId]`
 *      ⇒ 切走 → 后台结束 → 思考永久丢失。
 *
 *   I2「assistant 序数对齐不因缺失一条而整体错位」
 *      `attachTimelineToHistory` 必须按**回复指纹**取源（指纹 → 序数 → 记录自带），
 *      而不是纯 `aiOrd += 1` 顺序取。写侧序数只在「前台 onDone」自增，
 *      后台那条早退不写 ⇒ 写侧留空洞、读侧从头数到尾 ⇒ 空洞之后每一条的思考
 *      都挂到**前一轮**卡片上（= 用户报的「抢占下一个对话」）。
 *
 * 词边界铁律（本项目四次前科：`markPluginDisabled` 被 `unmarkPluginDisabled` 假命中、
 * `SilamBrain` 被 `SilamBrainRemovedByMutation` 假命中）：
 *   · 锚点若以 `(` 结尾、后跟词字符 ⇒ 右边界必然失配 ⇒ 计数恒0 ⇒ 断言永远绿；
 *   · 左边界里加 `.` 同理（`.` 会匹配到 `?.` / `).` 之外的其它形态）。
 * ⇒ 本文件所有形状断言都用 `(?<![A-Za-z0-9_$.])` 左边界 + 显式右侧字面量，
 *   并且**每个计数断言都先自测命中数> 0**（见 `expect(count).toBeGreaterThan(0)`）。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  attachTimelineToHistory,
  writeTurnTimeline,
  replyFingerprint,
  updateSessionCtxMeta,
  readSessionCtxMeta,
  type SessionCtxMeta,
  type TimelineStepLite,
} from "../../gui/src/renderer/pages/sessionCtxMeta.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/**
 * 剥注释（**保守**：宁可留下注释文本，也不误删正文）。
 *
 * ## 定位
 * 本守卫的断言全部**锚在代码结构上**（函数调用、赋值、字段名），
 * 而不是锚在注释里。所以只需要「把注释去掉，别让注释里的旧字符串假红/假绿」。
 *
 * ## 为什么用「正则两次」而不是手写状态机 / TS 解析器（两条都实测踩过）
 *  · **手写状态机**：在真实文件上连环失配 —— 正则字面量里的转义斜杠、
 *    `=` 之后是正则而非除号、中文文案「目录/仓库」被当正则起点、JSX 两种注释……
 *    其中「中文文案」那一种让 M3 变异在 18 条断言全绿下存活（**假绿比没守卫更危险**）。
 *  · **TS 解析器取区间**：`getLeading/TrailingCommentRanges` 在真实文件上返回 2064 个
 *    区间（去重后 1057），逐个替换会把文件砍掉一半（374KB → 183KB，锚点全丢）；
 *    合并嵌套后又与手工补的 JSX 注释区间**互相错位**，锚点照样丢。
 *
 * ## 本实现的关键取舍：**只删注释里的内容，但保留它的长度**
 * （用等长空白替换）⇒ 字符偏移不变 ⇒ 调试时行号/列号仍对得上原文，
 * 且第二遍可以安全地对「已替换过」的文本再跑一次。
 *
 * ⚠️ `src.replace(/\/\*[\s\S]*?\*\//g, ...)` 会把**字符串/正则字面量里**的
 *   `/* … *\/` 一起吃掉。本仓目标文件里确实有这种（options 数组里的真注释）。
 *   对本守卫无害 —— 被误删的都是注释，而断言锚点全在代码结构上；
 *   但**别把这里的输出当成「可编译的源码」**，它只用于形状断言。
 */
function stripComments(src: string): string {
  // 与本仓既有守卫（a1068 / session-ctx-meta）**同款**的两遍替换，先块后行。
  // 用等长空白替换（保留换行）而不是直接删空：字符偏移不变，便于人工核对行号。
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/[^\n]/g, " "));
}

const PANEL_RAW = read("gui/src/renderer/pages/ChatPanel.tsx");
const META_RAW = read("gui/src/renderer/pages/sessionCtxMeta.ts");
const PANEL = stripComments(PANEL_RAW);
const META = stripComments(META_RAW);

/** 计数且断言命中数 > 0 —— 防「锚点写错 ⇒ 恒 0 ⇒ 断言永远绿」 */
function countOf(haystack: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let n = 0;
  while (g.exec(haystack) !== null) {
    n += 1;
    if (g.lastIndex === 0) { break; }
  }
  return n;
}
function mustCount(src: string, re: RegExp, why: string, atLeast = 1): void {
  const n = countOf(src, re);
  expect(n, `${why}｜正则在剥注释后的源码里命中 ${n} 次（期望 ≥ ${atLeast}）。命中 0 通常是锚点写错，不是代码对。`).toBeGreaterThanOrEqual(atLeast);
}

describe("A-1197 · 守卫自检：剥注释必须真配平（否则后面所有断言都是假绿）", () => {
  it("正则字面量里的 // 不得被当成行注释（ChatPanel.tsx:336 就是这种）", () => {
    const src = [
      "const m = result.match(/https?:\\/\\/[^\\s<>()[\\]]+/);",
      "const after = 1;",
    ].join("\n");
    const out = stripComments(src);
    // 关键：`//` 前面紧跟 `:`（正则里的 http:），左边界规则必须放行
    expect(out).toContain("const after = 1;");
    expect(out, "正则字面量里的 // 被当成行注释 ⇒ 其后整行被吃掉").toContain("[^\\s<>()[\\]]+");
  });

  it("真的行注释 / 块注释仍被正确剥掉（别把正文也剥了）", () => {
    const out = stripComments([
      "const keep1 = 1; // 去掉我",
      "/* 去掉我 */",
      "/** 去掉我 */",
      "const keep2 = 2;",
    ].join("\n"));
    expect(out).toContain("const keep1 = 1;");
    expect(out).toContain("const keep2 = 2;");
    expect(out, "注释内容没被剥掉 ⇒ 注释里的旧字符串会造成假红/假绿").not.toContain("去掉我");
  });

  it("等长替换：字符偏移不变（便于人工核对行号）", () => {
    const src = ["const a = 1; // x", "const b = 2;"].join("\n");
    expect(stripComments(src)).toHaveLength(src.length);
  });

  it("自测：本守卫的锚点在剥注释后仍可命中（防「剥过头」把代码也吃掉）", () => {
    // 这是「剥注释过头」的唯一探测器：本轮曾因剥过头把文件砍掉一半，
    // 表现为下面这些锚点全部命中 0 —— 与「锚点写错」的现象一样，必须能区分。
    for (const needle of [
      "if (m.sessionId !== sessionRef.current) {",
      "writeTurnTimeline(",
      "const recoveredReasoning = a.reasoning ?? m.reasoning;",
    ]) {
      expect(PANEL.includes(needle), `剥注释后锚点消失：${needle}`).toBe(true);
    }
    for (const needle of ["export function attachTimelineToHistory(", "timelineByReplyKey"]) {
      expect(META.includes(needle), `剥注释后锚点消失：${needle}`).toBe(true);
    }
  });
});

describe("A-1197 · I1 后台 onDone 分支必须把思考落盘（切走不吞思考）", () => {
  /** 后台镜像分支：从 `m.sessionId !== sessionRef.current` 到它那支 `return;` */
  function backgroundDoneBranch(): string {
    const at = PANEL.indexOf("if (m.sessionId !== sessionRef.current) {");
    expect(at, "锚点漂移：找不到 onDone 的后台镜像分支").toBeGreaterThan(-1);
    // 右界用该分支自己的 return（缩进 10 空格），避免吃到后面的前景收尾
    const end = PANEL.indexOf("\n          return;", at);
    expect(end, "锚点漂移：找不到后台分支的 return").toBeGreaterThan(at);
    return PANEL.slice(at, end);
  }

  it("该分支真的存在（自测：锚点没写歪）", () => {
    mustCount(PANEL, /(?<![A-Za-z0-9_$.])if \(m\.sessionId !== sessionRef\.current\) \{/, "后台镜像分支锚点");
  });

  it("🐛 后台分支必须调 writeTurnTimeline（思考落盘，此前完全缺失 ⇒ 思考只留内存）", () => {
    const body = backgroundDoneBranch();
    mustCount(body, /(?<![A-Za-z0-9_$.])writeTurnTimeline\(/, "后台分支没有 writeTurnTimeline 调用 ⇒ 切走期间结束的思考永久丢失");
  });

  it("落盘时必须把快照里的思考原文带上（用 snap.reasoning，不是 m.reply）", () => {
    const body = backgroundDoneBranch();
    // 必须读 snap.reasoning（后台 onChunk 镜像一路累积的那份）
    mustCount(body, /(?<![A-Za-z0-9_$.])snap\.reasoning/, "没有从 snap.reasoning 取思考原文 ⇒ 落盘的是空思考");
    // 绝不许用 m.reply 冒充思考（会把正文写进思考区）
    expect(
      /reasoning:\s*m\.reply/.test(body),
      "用 m.reply 冒充 reasoning ⇒ 正文被写进「思考过程」折叠卡",
    ).toBe(false);
  });

  it("⚠️ 不许拿「删掉快照」当修复（那会让切回变成空白）：快照删除只许出现在前景收尾", () => {
    // delete perSessionStreamCache.current[...] 在 ChatPanel 里出现多次是正常的，
    // 但后台分支那一处**不能**出现 —— 它必须保留快照让切回读得到。
    expect(
      /delete perSessionStreamCache\.current/.test(backgroundDoneBranch()),
      "后台分支删了快照 ⇒ 切回时 cached.reasoning 为空，思考仍然丢失",
    ).toBe(false);
  });

  it("前台 onDone 也要按指纹写一份（否则指纹通道只覆盖后台轮次，其余轮次仍靠序数）", () => {
    mustCount(PANEL, /(?<![A-Za-z0-9_$.])writeTurnTimeline\(/, "前景 onDone 缺指纹落盘", 2);
  });

  it("渲染层必须消费 recover 回来的思考（a.reasoning 优先于 m.reasoning）", () => {
    mustCount(PANEL, /(?<![A-Za-z0-9_$.])a\.reasoning \?\? m\.reasoning/, "历史回填没读 a.reasoning ⇒ 补回来的思考在渲染层被丢弃");
  });
});

describe("A-1197 · I2 序数对齐不得因缺失一条而整体错位（不抢占下一轮）", () => {
  it("attachTimelineToHistory 必须有按指纹取源的分支（指纹通道优先于序数）", () => {
    mustCount(META, /(?<![A-Za-z0-9_$.])replyFingerprint\(m\.content\)/, "读侧没有按回复指纹取源 ⇒ 空洞之后整体错位（抢占）");
    mustCount(META, /(?<![A-Za-z0-9_$.])meta\?\.timelineByReplyKey\?\.\[fp\]/, "读侧没有读指纹通道");
  });

  it("取源优先级必须是 指纹 → 序数（序数退化为兜底，不是主键）", () => {
    mustCount(META, /(?<![A-Za-z0-9_$.])const fromMeta = fromKey \?\? byOrdinal;/, "指纹通道没有优先于序数通道（指纹必须排在 byOrdinal 前面）");
  });

  it("写侧：writeTurnTimeline 必须存在且无需序数（后台分支拿不到序数）", () => {
    mustCount(META, /(?<![A-Za-z0-9_$.])export function writeTurnTimeline\(/, "缺少按指纹落盘的写入口");
    mustCount(META, /(?<![A-Za-z0-9_$.])timelineByReplyKey/, "缺少 timelineByReplyKey 通道");
    mustCount(META, /(?<![A-Za-z0-9_$.])reasoningByReplyKey/, "缺少 reasoningByReplyKey 通道");
  });

  it("⚠️ 静默失效必须出声：读侧取不到指纹时的兜底仍是序数，不能变成空", () => {
    // fromMeta 由序数取；即便指纹没命中，也必须回落到序数而不是 undefined。
    mustCount(META, /(?<![A-Za-z0-9_$.])settleRunning\(fromMeta \?\? adoptRecordTimeline\(m\.timeline\)\)/, "序数兜底链路被破坏");
  });

  it("重复文本必须按队列一一对应（不许「命中一次就永远命中」）", () => {
    // ⚠️ 这里曾经写成 `\(fp!\?\)` —— 那个 `\?` 让 `!` 变成**可选**，于是正则匹配的是
    // `cursors.get(fp)` 而源码里是 `cursors.get(fp!)` ⇒ 命中 0 ⇒ 断言永远绿。
    // 正是「变异存活先怀疑守卫」的同族：自己写的锚点自己先测计数。
    mustCount(META, /(?<![A-Za-z0-9_$.])cursors\.get\(fp!\) \?\? 0/, "指纹队列没有消费游标 ⇒ 重复回复文本会把思考挂错轮");
    mustCount(META, /(?<![A-Za-z0-9_$.])cursors\.set\(fp!, at \+ 1\)/, "指纹队列游标没有自增（取出后不推进 ⇒ 重复文本全挂到第一条）");
  });
});

// ── 行为层（纯函数直测，不依赖 React） ───────────────────────────────
const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string): string | null => mem.get(k) ?? null,
    setItem: (k: string, v: string): void => { mem.set(k, v); },
    removeItem: (k: string): void => { mem.delete(k); },
    clear: (): void => { mem.clear(); },
    key: (): string | null => null,
    length: 0,
  } as Storage;
});

const AG = "a1";
const SID = "s1";
const tl = (t: string): TimelineStepLite[] => [{ kind: "think", text: t }];

describe("A-1197 · 行为：切走期间结束的那条不再丢思考、也不再抢下一轮", () => {
  it("🔌 写侧：writeTurnTimeline 无需序数即可落盘（后台分支唯一的出路）", () => {
    writeTurnTimeline(AG, SID, "第二轮答案", tl("思考2"), "思考原文2");
    const back = readSessionCtxMeta(AG, SID)!;
    expect(back.timelineByReplyKey![replyFingerprint("第二轮答案")]).toHaveLength(1);
    expect(back.reasoningByReplyKey![replyFingerprint("第二轮答案")]).toEqual(["思考原文2"]);
    // 序数通道**不许**被顺手写（后台拿不到序数，写了就是猜）
    expect(Object.keys(back.timelineByAssistantIdx)).toHaveLength(0);
  });

  it("🔌 读侧：写侧留空洞（序数 1、2 分别属于第1、3 轮）时，第 2 轮仍拿到自己的思考", () => {
    // 复刻真实形状：前台轮次按序数写（1=第一轮、2=第三轮），后台那条**没有序数**。
    updateSessionCtxMeta(AG, SID, 1, { timeline: tl("思考1") });
    updateSessionCtxMeta(AG, SID, 2, { timeline: tl("思考3") });
    writeTurnTimeline(AG, SID, "第一轮答案", tl("思考1"), "思考1");
    writeTurnTimeline(AG, SID, "第二轮答案", tl("思考2"), "思考2");
    writeTurnTimeline(AG, SID, "第三轮答案", tl("思考3"), "思考3");
    const meta = readSessionCtxMeta(AG, SID)!;

    const msgs = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "第一轮答案" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "第二轮答案" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "第三轮答案" },
    ];
    const out = attachTimelineToHistory(msgs, meta);
    expect(out[1].timeline![0].text).toBe("思考1");
    // 这一条就是「切走期间后台结束」的那轮：序数通道对它没有对应项
    expect(out[3].timeline![0].text).toBe("思考2");
    expect(out[3].reasoning).toBe("思考2");
    // 关键：空洞之后不再错位（第3 轮拿自己的，不被第 2 轮的抢走）
    expect(out[5].timeline![0].text).toBe("思考3");
  });

  it("🐛 老数据（只有序数、没有指纹通道）行为逐字节不变", () => {
    const meta: SessionCtxMeta = {
      used: 0, cap: 0,
      timelineByAssistantIdx: { 1: tl("一"), 2: tl("二") },
    };
    const out = attachTimelineToHistory(
      [{ role: "assistant", content: "a" }, { role: "assistant", content: "b" }],
      meta,
    );
    expect(out[0].timeline![0].text).toBe("一");
    expect(out[1].timeline![0].text).toBe("二");
  });

  it("重复回复文本按队列一一对应（「好的」×3 不许全挂到第一条）", () => {
    writeTurnTimeline(AG, SID, "好的", tl("A"), "A");
    writeTurnTimeline(AG, SID, "好的", tl("B"), "B");
    writeTurnTimeline(AG, SID, "好的", tl("C"), "C");
    const meta = readSessionCtxMeta(AG, SID)!;
    const out = attachTimelineToHistory(
      [{ role: "assistant", content: "好的" }, { role: "assistant", content: "好的" }, { role: "assistant", content: "好的" }],
      meta,
    );
    expect(out.map((o) => o.timeline![0].text)).toEqual(["A", "B", "C"]);
    expect(out.map((o) => o.reasoning)).toEqual(["A", "B", "C"]);
  });

  it("指纹对尾部追加免疫（截断 / 中断标记不改变指纹）", () => {
    expect(replyFingerprint("答案\n[截断]")).toBe(replyFingerprint("答案"));
    expect(replyFingerprint("答案\n\n> ⏹ 已中断（停止生成）")).toBe(replyFingerprint("答案"));
    // 思考标签也不能影响指纹（写侧用 cleanReply 剥过，读侧从 history 拿可能还带着）
    expect(replyFingerprint("<thinking>想</thinking>答案")).toBe(replyFingerprint("答案"));
  });

  it("⚠️ 指纹算错会静默退化 —— 故指纹对空/纯空白必须为空串（不写入无主的时间线）", () => {
    expect(replyFingerprint("")).toBe("");
    expect(replyFingerprint(null)).toBe("");
    expect(replyFingerprint(undefined)).toBe("");
    expect(replyFingerprint("   \n  ")).toBe("");
  });

  it("两条通道的 thinking 卡片 running 必须被 settle（不许出现永久「执行中」）", () => {
    writeTurnTimeline(AG, SID, "回复Y", [{ kind: "tool", name: "bash", label: "bash", running: true }]);
    const meta = readSessionCtxMeta(AG, SID)!;
    const out = attachTimelineToHistory([{ role: "assistant", content: "回复Y" }], meta);
    expect(out[0].timeline![0].running).toBe(false);
  });
});