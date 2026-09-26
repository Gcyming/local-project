/**
 * context-math.spec.ts — 上下文 UI 纯计算回归（F：ContextRing/ContextWindowBar 计算层单测）。
 * 覆盖：环占比 clamp / 百分比 / 三档色阶阈值 / 构成四段占比 / 8 源分桶归一与排序。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { contextRatio, contextPct, ringLevel, composeSegments, bucketsSegments, pickTokenBase, fmtTokens,
  usageComposition, kInputBase, kInputToTokens, kInputTitle, tokensToKInput } from "../../gui/src/renderer/pages/contextMath.js";

describe("contextRatio / contextPct（环基础）", () => {
  it("cap=0 → 0；常规占比 clamp 0..1", () => {
    expect(contextRatio(100, 0)).toBe(0);
    expect(contextRatio(500, 1000)).toBe(0.5);
    expect(contextRatio(-5, 1000)).toBe(0);
    expect(contextRatio(9999, 1000)).toBe(1);
  });
  it("百分比整数化", () => {
    expect(contextPct(0.5)).toBe(50);
    expect(contextPct(0.856)).toBe(86);
  });
});

describe("ringLevel 色阶阈值（绿<60% / 黄 60-85% / 红 >85%）", () => {
  it("三档边界", () => {
    expect(ringLevel(0.59).color).toBe("var(--success)");
    expect(ringLevel(0.6).color).toBe("var(--warning)");
    expect(ringLevel(0.8499).color).toBe("var(--warning)");
    expect(ringLevel(0.85).color).toBe("var(--danger)");
    expect(ringLevel(1).color).toBe("var(--danger)");
  });
  it("语义标签同步", () => {
    expect(ringLevel(0.1).label).toBe("充足");
    expect(ringLevel(0.7).label).toBe("接近上限");
    expect(ringLevel(0.9).label).toBe("逼近硬阈值");
  });
});

describe("composeSegments 四项构成（互斥；占比之和恒为 100%）", () => {
  it("★ 回归：缓存读 ⊂ 输入、思考 ⊂ 回复 —— 子集字段不许并计（旧实现合计虚高 86%）", () => {
    // prompt=40 已含 cache=20（OpenAI 系语义）；completion=30 已含 reasoning=10
    const { segments, any } = composeSegments({ promptTokens: 40, cacheReadTokens: 20, completionTokens: 30, reasoningTokens: 10 });
    expect(any).toBe(true);
    const at = (l: string): number => segments.find((s) => s.label === l)!.pct;
    // 真实总量 = 输入侧 40 + 输出侧 max(30,10)=30 = 70（**不是** 40+30+10+20=100）
    expect(at("输入")).toBeCloseTo((20 / 70) * 100, 5); // 40 − 20 命中
    expect(at("缓存")).toBeCloseTo((20 / 70) * 100, 5);
    expect(at("输出")).toBeCloseTo((20 / 70) * 100, 5); // 30 − 10 思考
    expect(at("思考")).toBeCloseTo((10 / 70) * 100, 5);
    // 四段互斥 ⇒ 和恰好 100%，且 token 数之和 = 去重后的真实总量
    expect(segments.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100, 6);
    expect(segments.reduce((s, x) => s + x.n, 0)).toBe(70);
  });
  it("Anthropic 语义（cacheReadInPrompt=false）→ 缓存读与输入**并列**，合计把缓存算进来", () => {
    const { segments } = composeSegments({ promptTokens: 40, cacheReadTokens: 20, completionTokens: 30, reasoningTokens: 0, cacheReadInPrompt: false });
    // 输入侧 = prompt(40) + cache(20)；输出侧 = 30 ⇒ 合计 90
    expect(segments.reduce((s, x) => s + x.n, 0)).toBe(90);
    expect(segments.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100, 6);
  });
  it("全零 → any=false、段 pct 为 0（不渲染微条）", () => {
    const { any, segments } = composeSegments({ promptTokens: 0, cacheReadTokens: 0, completionTokens: 0, reasoningTokens: 0 });
    expect(any).toBe(false);
    expect(segments.every((s) => s.pct === 0)).toBe(true);
  });
});

describe("usageComposition：与记账层 computeRecordCost 同一条判据", () => {
  it("★ 合计 = 输入侧 + 输出侧（去重），与 core 的 max(completion, reasoning) 一致", () => {
    const c = usageComposition({ promptTokens: 1000, cacheReadTokens: 800, completionTokens: 50, reasoningTokens: 30 });
    expect(c.inputSide).toBe(1000);       // OpenAI 系：prompt 已含命中
    expect(c.outputSide).toBe(50);        // max(50, 30) —— 思考不额外加
    expect(c.total).toBe(1050);
    expect(c.cacheInPrompt).toBe(true);
  });
  it("reasoning > completion（防御）→ 取大值，绝不漏计也不重复", () => {
    const c = usageComposition({ promptTokens: 0, cacheReadTokens: 0, completionTokens: 10, reasoningTokens: 25 });
    expect(c.outputSide).toBe(25);
    expect(c.total).toBe(25);
  });
});

describe("bucketsSegments 8 源分桶", () => {
  it("归一占比并按 pct 降序", () => {
    const { segments, any } = bucketsSegments([
      { key: "history", tokens: 6000 },
      { key: "tools", tokens: 2000 },
      { key: "system", tokens: 2000 },
    ]);
    expect(any).toBe(true);
    expect(segments[0].key).toBe("history");
    expect(segments[0].pct).toBe(60);
    expect(segments[1].pct).toBe(20);
    expect(segments[2].pct).toBe(20);
  });
  it("空/全零 → any=false", () => {
    expect(bucketsSegments([]).any).toBe(false);
    expect(bucketsSegments([{ key: "x", tokens: 0 }]).any).toBe(false);
  });
});
/* ────────────────────────────────────────────────────────────────────────
   A-1087：K 进制 —— 显示必须还原**厂商的写法**
   ──────────────────────────────────────────────────────────────────────── */

describe("pickTokenBase：按上限整除性反推厂商的 K 进制", () => {
  it("二进制上限（2^n）→ 1024 进制，还原 512K / 1M / 256K", () => {
    expect(pickTokenBase(524288)).toBe(1024);   // config/global_config.json 的 max_context
    expect(pickTokenBase(1048576)).toBe(1024);
    expect(pickTokenBase(262144)).toBe(1024);
    expect(pickTokenBase(131072)).toBe(1024);
    expect(pickTokenBase(65536)).toBe(1024);
    expect(pickTokenBase(4096)).toBe(1024);
  });
  it("十进制上限 → 1000 进制（平局也取十进制，保住 gpt-4o 的 128K）", () => {
    expect(pickTokenBase(200000)).toBe(1000);
    expect(pickTokenBase(1000000)).toBe(1000);
    // 128000：/1000=128（整）、/1024=125（整）—— 平局必须给十进制，否则 gpt-4o 变成 125K
    expect(pickTokenBase(128000)).toBe(1000);
  });
  it("0 / 负数 / NaN → 1000（不抛，走十进制兜底）", () => {
    expect(pickTokenBase(0)).toBe(1000);
    expect(pickTokenBase(-1)).toBe(1000);
    expect(pickTokenBase(Number.NaN)).toBe(1000);
  });
});

describe("fmtTokens：与上限同进制渲染用量", () => {
  it("★ 回归：524288 必须读作 512K（旧实现 n/1000 → 524K，用户报「没有 524K 只有 512K」）", () => {
    expect(fmtTokens(524288, 524288)).toBe("512K");
  });
  it("厂商写法逐条还原", () => {
    expect(fmtTokens(128000, 128000)).toBe("128K");        // gpt-4o
    expect(fmtTokens(200000, 200000)).toBe("200K");        // claude
    expect(fmtTokens(1048576, 1048576)).toBe("1M");        // glm-5.3 / deepseek-flash
    expect(fmtTokens(262144, 262144)).toBe("256K");        // kimi
    expect(fmtTokens(131072, 131072)).toBe("128K");        // qwen / glm-4.5
    expect(fmtTokens(65536, 65536)).toBe("64K");
    expect(fmtTokens(4096, 4096)).toBe("4K");
    expect(fmtTokens(32000, 32000)).toBe("32K");
  });
  it("用量与上限同进制（否则读者自己换算会算错方向）", () => {
    // 66726 / 524288：二进制口径 → 65K（不是十进制的 67K）
    expect(fmtTokens(66726, 524288)).toBe("65K");
    // 43210 / 524288（旧底部芯片的 ÷4 估算）→ 42K
    expect(fmtTokens(43210, 524288)).toBe("42K");
    // 同一批数字在十进制上限下用十进制
    expect(fmtTokens(64000, 128000)).toBe("64K");
  });
  it("小数位规则：<10K 一位小数（纯零尾巴去掉）；K 段整数；M 段一位", () => {
    expect(fmtTokens(5234, 524288)).toBe("5.1K");
    expect(fmtTokens(52341, 524288)).toBe("51K");
    expect(fmtTokens(5242880, 1048576)).toBe("5M");
    expect(fmtTokens(1310720, 1048576)).toBe("1.3M");
  });
  it("边界与非法输入不产出 NaN/undefined 文案", () => {
    expect(fmtTokens(0, 524288)).toBe("0");
    expect(fmtTokens(-5, 524288)).toBe("0");
    expect(fmtTokens(Number.NaN, 524288)).toBe("0");
    expect(fmtTokens(999, 524288)).toBe("999");
    expect(fmtTokens(1023, 4096)).toBe("1023");
    // 不传 cap（调用方没拿到上限）→ 十进制兜底，且绝不抛
    expect(fmtTokens(524288)).toBe("524K");
    expect(fmtTokens(524288, 0)).toBe("524K");
  });
});

/* ────────────────────────────────────────────────────────────────────────
   A-1087：K 输入框（供应商编辑器）—— 换算与文案必须同源
   ──────────────────────────────────────────────────────────────────────── */

describe("K 输入框换算：往返必须无损（框里的数字与存值互为唯一表示）", () => {
  it("★ 524288 两个方向都还原成 512（旧实现显示 524、写回 524000）", () => {
    expect(tokensToKInput(524288)).toBe("512");
    expect(kInputBase(524288)).toBe(1024);
    expect(kInputToTokens("512", kInputBase(524288))).toBe(524288);
  });

  it("往返无损：显示 → 不改 → 保存，存值一个 token 都不能变", () => {
    // 覆盖两族（2^n 与十进制）+ 两处真实事故值（524288 / 65536）
    for (const v of [524288, 512000, 1048576, 262144, 131072, 65536, 8192, 4096, 128000, 200000, 32000]) {
      expect(kInputToTokens(tokensToKInput(v), kInputBase(v)), `往返后 ${v} 变了`).toBe(v);
    }
  });

  it("空 / 非法 / 非正 → 空串与 undefined（不许产出 NaN 存值）", () => {
    expect(tokensToKInput("")).toBe("");
    expect(tokensToKInput(undefined)).toBe("");
    expect(tokensToKInput(0)).toBe("");
    expect(tokensToKInput("abc")).toBe("");
    expect(kInputToTokens("", 1000)).toBeUndefined();
    expect(kInputToTokens("abc", 1000)).toBeUndefined();
    expect(kInputToTokens("0", 1000)).toBeUndefined();
    // 数字串也收（本地模型那两栏存的就是字符串）
    expect(tokensToKInput("65536")).toBe("64");
    expect(kInputToTokens("64", 1024)).toBe(65536);
  });

  it("提示文案与换算同源（不许在 JSX 里写死 ×1024 的例子 —— 那正是「文案说 A 代码做 B」的起点）", () => {
    expect(kInputTitle("上下文窗口", 1024)).toContain("输入 32 = 32768");
    expect(kInputTitle("上下文窗口", 1000)).toContain("输入 32 = 32000");
  });
});

/* ────────────────────────────────────────────────────────────────────────
   接线守卫：两个产地 → 一个产地、一个函数
   ──────────────────────────────────────────────────────────────────────── */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
/**
 * 把注释抹成空格（**解析器驱动**）—— 扫描源码的守卫必须用它。
 *
 * 不用它的后果在本次就踩到了：被删掉的那段旧代码（`÷4` 估算）在注释里被**点名引用**
 * 作为"为什么删掉"的证据，而朴素的 `not.toMatch` 会把注释一起当代码匹配 →
 * 守卫变成"谁解释谁违规"，最后没人敢写这行注释。
 * 位置全部来自 TypeScript 语法树，正则字面量 / 转义引号 / 模板串一概不误判；
 * 行数与原文严格一致（与 `tests/core-ts/a1020-guards.spec.ts` 的 `blankComments` 同法）。
 */
function blankComments(src: string): string {
  const sf = ts.createSourceFile("scan.tsx", src, ts.ScriptTarget.Latest, true);
  const chars = src.split("");
  const blank = (r: { pos: number; end: number }): void => {
    for (let i = r.pos; i < r.end; i++) { if (chars[i] !== "\n") { chars[i] = " "; } }
  };
  const visit = (node: ts.Node): void => {
    for (const r of ts.getLeadingCommentRanges(src, node.getFullStart()) ?? []) { blank(r); }
    for (const r of ts.getTrailingCommentRanges(src, node.getEnd()) ?? []) { blank(r); }
    let kids: readonly ts.Node[] = [];
    try { kids = node.getChildren(sf); } catch { kids = []; }
    for (const k of kids) { visit(k); }
  };
  visit(sf);
  return chars.join("");
}
const SIDEBAR = read("gui/src/renderer/pages/RightSidebar.tsx");
const CHATPANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
const PROVIDERS = read("gui/src/renderer/pages/ProvidersPanel.tsx");
const NEWPROJECT = read("gui/src/renderer/pages/NewProjectDialog.tsx");
/** 只含真实代码的版本（注释已被抹掉）—— 用于"旧写法绝迹"类断言 */
const SIDEBAR_CODE = blankComments(SIDEBAR);
const CHATPANEL_CODE = blankComments(CHATPANEL);
const PROVIDERS_CODE = blankComments(PROVIDERS);
const NEWPROJECT_CODE = blankComments(NEWPROJECT);

describe("★ 上下文监测：同一语义只许一个产地 / 一个格式化函数", () => {
  it("RightSidebar 不得再有本地 fmtK（十进制 /1000 会把 524288 印成 524K）", () => {
    expect(SIDEBAR_CODE).not.toMatch(/function fmtK\s*\(/);
    expect(SIDEBAR_CODE).not.toMatch(/\bfmtK\s*\(/);
    expect(SIDEBAR_CODE).toContain("fmtTokens");
  });

  it("RightSidebar 的每个 token 格式化调用都带 cap（否则同屏两进制）", () => {
    const calls = SIDEBAR_CODE.match(/fmtTokens\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const c of calls) {
      expect(c, `未声明进制的 token 格式化：${c}`).toMatch(/,\s*cap\s*\)$/);
    }
  });

  it("进度条 used/cap 与兄弟面板共用同一个 capNow（唯一取值 + 唯一进制）", () => {
    expect(SIDEBAR_CODE).toMatch(/const capNow = liveCap > 0 \? liveCap : maxCtx;/);
    expect(SIDEBAR_CODE).toMatch(/<ContextWindowBar\s*\n\s*used=\{liveUsed\}\s*\n\s*cap=\{capNow\}/);
    // 会话指标（MetricsGrid）与 Token 构成明细（UsageBreakdown）都要带同一个 capNow
    expect(SIDEBAR_CODE).toMatch(/<MetricsGrid[^>]*cap=\{capNow\}/);
    expect(SIDEBAR_CODE).toMatch(/<UsageBreakdown[^>]*cap=\{capNow\}/);
  });

  it("★ 侧栏「Token 构成 / 明细」的算术只有 usageComposition 一个产地（不许在 JSX 里再列公式）", () => {
    // 旧实现：`total = prompt + reply + reasoning + cache` —— 子集并计、合计虚高约 86%，必须绝迹
    expect(SIDEBAR_CODE).not.toMatch(/prompt\s*\+\s*reply\s*\+\s*reasoning\s*\+\s*cache/);
    // 新实现：渲染层只消费纯函数的结论
    expect(SIDEBAR_CODE).toMatch(/usageComposition\(/);
  });

  it("★ 图例第 4 项必须是「缓存读」，不许再错标成「其他」（值是缓存读）", () => {
    // 旧状：`label={`其他 ${pct(pOther)}`} value={dashOr(cache)}` —— 标签与值不同源
    expect(SIDEBAR_CODE).not.toMatch(/\bpOther\b/);
    expect(SIDEBAR_CODE).not.toMatch(/\bC_OTHER\b/);
    expect(SIDEBAR_CODE).not.toMatch(/其他 \$\{pct\(/);
    expect(SIDEBAR_CODE).toMatch(/缓存读/);
  });

  it("★ 明细「合计」必须直接渲染 usageComposition 的 total（不许在 JSX 里现算一个和）", () => {
    /* 旧状：`{total.toLocaleString()}` 而 `total = prompt + reply + reasoning + cache` ——
       子集并计、虚高约 86%。仅断言"那个错公式绝迹"不够：换个写法现算一个和（例如
       `c.inputSide + c.cacheRead + …`）仍然会重复计，而且**看起来更正确**。
       所以判据锁在"合计这一格渲染的就是 `c.total`"上 —— 它由纯函数保证去重。 */
    expect(SIDEBAR_CODE, "明细合计那一格必须渲染 c.total")
      .toMatch(/合计（输入 \+ 输出）<\/span>[\s\S]{0,160}?\{c\.total\.toLocaleString\(\)\}/);
  });

  it("★ ChatPanel 底部芯片读 ctxUsed（锚定值），不得复活 ÷4 的第二个产地", () => {
    expect(CHATPANEL_CODE).not.toMatch(/setContextTokens\s*\(/);
    expect(CHATPANEL_CODE).not.toMatch(/\[contextTokens,\s*setContextTokens\]/);
    expect(CHATPANEL_CODE).not.toMatch(/ctxChars\s*\/\s*4/);
    expect(CHATPANEL_CODE).toMatch(/\{fmtTokens\(ctxUsed, ctxCap\)\}/);
  });

  it("状态行的上下文百分比也读 ctxUsed（不许再喂 ÷4 估算）", () => {
    // deriveLiveStatus 的入参：必须是裸 `ctxUsed,` 而不是 `ctxUsed: contextTokens,`
    expect(CHATPANEL_CODE).toMatch(/deriveLiveStatus\(\{[\s\S]{0,1200}?\n\s*ctxUsed,\n\s*ctxCap,/);
    expect(CHATPANEL_CODE).not.toMatch(/ctxUsed:[ \t]*contextTokens/);
  });

  it("★ useAgentMaxContext 的 provider 查找必须用第二段作 key（parts[0] 恒为字面量 \"api\"）", () => {
    expect(SIDEBAR_CODE).toMatch(/const isApiForm = parts\[0\] === "api";/);
    expect(SIDEBAR_CODE).toMatch(/parts\.length >= 3 \? parts\[1\] : null/);
    // 旧写法（把 "api" 当供应商 key）绝迹
    expect(SIDEBAR_CODE).not.toMatch(/const key = parts\.length >= 2 \? parts\[0\] : null/);
  });

  it("反假阳：注释剥离器真的在干活（注释里的旧写法不该被当成代码命中）", () => {
    // 两文件都**确实**在注释里引用了旧代码；剥离后这些字串必须消失
    expect(SIDEBAR).toContain("//");           // 原文有注释
    expect(CHATPANEL).toMatch(/ctxChars/);     // 原文（注释中）出现
    expect(CHATPANEL_CODE).not.toMatch(/ctxChars/);
    // 行数不变（报错行号可直接用）
    expect(CHATPANEL_CODE.split("\n").length).toBe(CHATPANEL.split("\n").length);
  });
});

describe("★ 供应商编辑器：K 栏只许一个换算产地（旧状：文案说 ×1024、代码做 ×1000）", () => {
  it("★ 4 个 K 栏的 value / onChange / title 全部走 kInput* 族", () => {
    expect(PROVIDERS_CODE).toMatch(/value=\{tokensToKInput\(m\.context_window\)\}/);
    expect(PROVIDERS_CODE).toMatch(/value=\{tokensToKInput\(m\.max_output\)\}/);
    expect(PROVIDERS_CODE).toMatch(/value=\{tokensToKInput\(edit\.ctx_len\)\}/);
    expect(PROVIDERS_CODE).toMatch(/value=\{tokensToKInput\(edit\.max_output\)\}/);
    const titles = PROVIDERS_CODE.match(/title=\{kInputTitle\(/g) ?? [];
    expect(titles.length, "K 栏的悬停文案没有全部走 kInputTitle（写死例子会与实际换算式脱钩）")
      .toBeGreaterThanOrEqual(4);
  });

  it("★ 旧的 ×1000 手算绝迹（它把 524288 显示成 524、把 65536 静默改成 66000）", () => {
    expect(PROVIDERS_CODE).not.toMatch(/String\(Math\.round\(m\.context_window \/ 1000\)\)/);
    expect(PROVIDERS_CODE).not.toMatch(/String\(Math\.round\(m\.max_output \/ 1000\)\)/);
    expect(PROVIDERS_CODE).not.toMatch(/Number\(v\) \* 1000/);
    expect(PROVIDERS_CODE).not.toMatch(/Math\.round\(Number\(edit\.ctx_len\) \/ 1000\)/);
    expect(PROVIDERS_CODE).not.toMatch(/Number\(e\.target\.value\) \* 1000/);
  });

  it("表头不再承诺一个固定进制（换算按行自适应，例子必须由 kInputTitle 现场生成）", () => {
    expect(PROVIDERS_CODE).not.toMatch(/输入 1024 = 1048576 token/);
    expect(PROVIDERS_CODE).not.toMatch(/输入 64 = 65536 token/);
  });
});

describe("★ 新建会话选模型：上下文用量必须走同一个 fmtTokens", () => {
  it("★ 不许再打印裸 token 数（`524288 ctx` 读起来就是 524K）", () => {
    expect(NEWPROJECT_CODE).not.toMatch(/\{m\.ctx\} ctx/);
    expect(NEWPROJECT_CODE).toMatch(/\{fmtTokens\(m\.ctx, m\.ctx\)\} ctx/);
  });
});
