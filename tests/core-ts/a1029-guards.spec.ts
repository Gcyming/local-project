/**
 * tests/core-ts/a1029-guards.spec.ts — A-1029 守卫：**改动详情不能静默消失**。
 *
 * 两个用户报告的现场（2026-09-20）：
 *   ① 思考历程/产物卡里「写入文件」**看不到前后对比**了；
 *   ② 点右侧栏「对比改动」只得到一句 `fatal: not a git repository`。
 *
 * 二者都不是"功能没做"，而是**失败被吞掉**：
 *   ① `parseDiffFull` 的默认上限写死 20000，一过阈值就 `return null`，界面什么都不说。
 *      实测 `config/history.jsonl` 里 14 处 diff 标记有 **5 处（36%）被丢**，含用户截图那两次
 *      （24481 / 27219 字符）。同一个 index.html 从 13.9k 长到 27.2k 就越过阈值 ——
 *      用户的原话"以前能看到、现在看不了"精确对应这条悬崖。
 *   ② 主进程把 `git show` 的英文 stderr 原样回给界面，而现有容错分支偏偏漏了
 *      `not a git repository` 这一类（非 Git 工作区恰恰是最常见的情形）。
 *
 * 本 spec 钉死的是**结构性事实**（阈值来源唯一、失败必须可见、非仓库必须走可读文案），
 * 不是"某个字符串存在"—— 后者容易被注释里的旧写法骗过（A-1027 的教训）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseDiffFull,
  parseDiffStat,
  slimProductsForPersist,
  diffNoticeKind,
  DIFF_FULL_MAX_RENDER,
  PRODUCT_DIFF_PERSIST_MAX,
  type ProductItem,
} from "../../gui/src/renderer/pages/chatProducts.js";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** 读源文件并**剥掉注释**：守卫要盯"活代码"，注释里躺着旧写法不该让它变绿（也不该变红）。
 *  这是 A-1027「注释里的旧写法骗过 toContain」那条教训的正解。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const DIFF_MARK = (oldT: string, newT: string): string =>
  `[__slime_diff__]${Buffer.from(oldT, "utf8").toString("base64")}|${Buffer.from(newT, "utf8").toString("base64")}[/__slime_diff__]`;

/**
 * 取出「以某个符号为判据」的条件渲染，返回 `&&` 之前那一段条件表达式。
 * 形如 `{ …diffNoticeKind(…)… && (` → `diffNoticeKind(…)…`。
 *
 * 为什么需要它：`.tsx` 里的"渲染不出来"没法用纯函数测（组件不可测，见 chatProducts.ts 文件头 A-990），
 * 但"条件是不是常量"是**结构性事实**，可以钉死。A-1029 实测过：把判据改成 `false && 原条件`，
 * 只查字符串是否还在源码里的守卫**照样全绿** —— 这类退化必须靠本函数抓。
 */
function jsxConditionsUsing(src: string, symbol: string): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`\{\s*([^{}]*?\b${symbol}\([^{}]*?)\s*&&\s*(?=[(<])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) { out.push(m[1].trim()); }
  return out;
}

/** 判据不得退化成常量（`false && 原条件` = 该提示永远不会渲染，且字符串守卫抓不到）。 */
function expectNotConstant(cond: string, label: string): void {
  expect(/^(false|true|0|1|null|undefined)\b/.test(cond), `${label}：条件渲染的判据退化成常量了 →「${cond}」`).toBe(false);
}

describe("A-1029 ① 内联 diff 的上限不再制造静默悬崖", () => {
  it("渲染上限必须远大于历史实测峰值（4.8 万字符），否则老问题原样复现", () => {
    expect(DIFF_FULL_MAX_RENDER).toBeGreaterThanOrEqual(200000);
  });

  it("产物持久化上限必须显著小于渲染上限（localStorage 只有约 5MB，不能照搬渲染预算）", () => {
    expect(PRODUCT_DIFF_PERSIST_MAX).toBeLessThan(DIFF_FULL_MAX_RENDER);
    expect(PRODUCT_DIFF_PERSIST_MAX).toBeGreaterThanOrEqual(50000);
  });

  it("用户截图那两次写入（24481 / 27219 字符）必须能解析出全文", () => {
    for (const total of [24481, 27219]) {
      const half = Math.floor(total / 2);
      const payload = DIFF_MARK("a".repeat(half), "b".repeat(total - half));
      const full = parseDiffFull(payload);
      expect(full, `${total} 字符应当仍能看到变更详情`).not.toBeNull();
      expect(full!.old.length + full!.new.length).toBe(total);
    }
  });

  it("默认参数下不得再出现「有计数却无详情」——那正是用户看到的症状", () => {
    const payload = DIFF_MARK("x".repeat(15000), "y".repeat(15000));
    // 计数与全文必须**同时**可得：只给计数不给全文 = 界面上无法解释的空白
    expect(parseDiffStat(payload)).not.toBeNull();
    expect(parseDiffFull(payload)).not.toBeNull();
  });

  it("显式传入小上限时仍按上限裁剪（向后兼容：测试/调用方可自行收紧）", () => {
    const big = DIFF_MARK("a".repeat(300), "b".repeat(300));
    expect(parseDiffFull(big, 100)).toBeNull();
    expect(parseDiffFull(DIFF_MARK("a", "b"), 100)).toEqual({ old: "a", new: "b" });
  });
});

describe("A-1029 ② 落盘限流必须留痕（摘掉 diffFull ≠ 假装没发生过）", () => {
  const item = (oldLen: number, newLen: number): ProductItem => ({
    rel: "a/b.html", name: "b.html", kind: "write", ext: "html",
    diff: { add: 3, del: 1 },
    diffFull: { old: "o".repeat(oldLen), new: "n".repeat(newLen) },
  });

  it("未超限的条目原样保留（不产生无谓的 diffTrimmed）", () => {
    const [kept] = slimProductsForPersist([item(10, 10)]);
    expect(kept.diffFull).toBeTruthy();
    expect(kept.diffTrimmed).toBeUndefined();
  });

  it("超限的条目：摘掉 diffFull、保留 diff 计数、并打上 diffTrimmed", () => {
    const [slim] = slimProductsForPersist([item(PRODUCT_DIFF_PERSIST_MAX, 1)]);
    expect(slim.diffFull).toBeUndefined();
    expect(slim.diffTrimmed).toBe(true);
    // 计数必须留：否则用户连"改了多少行"都看不到，等于信息全丢
    expect(slim.diff).toEqual({ add: 3, del: 1 });
    expect(slim.rel).toBe("a/b.html");
  });

  it("不得就地修改入参（内存里那份完整 diffFull 要继续可用）", () => {
    const original = item(PRODUCT_DIFF_PERSIST_MAX, 1);
    slimProductsForPersist([original]);
    expect(original.diffFull, "落盘瘦身不能污染内存对象").toBeTruthy();
    expect(original.diffTrimmed).toBeUndefined();
  });
});

describe("A-1029 ③ 源码级：唯一实现 / 唯一入口 / 失败必须可见", () => {
  it("阈值只有一处产地：chatProducts.ts 里不得再有裸写的 20000 当作 diff 上限", () => {
    const src = stripComments(read("gui/src/renderer/pages/chatProducts.ts"));
    // 裸 20000 若重新出现在**代码**里（注释里提历史不算），说明又有人绕开常量硬写
    expect(/maxChars\s*=\s*20000/.test(src), "parseDiffFull 默认值不得退回硬编码 20000").toBe(false);
    expect(src).toContain("export const DIFF_FULL_MAX_RENDER");
    expect(src).toContain("export const PRODUCT_DIFF_PERSIST_MAX");
  });

  it("落盘只有一个入口：writeSessionProducts 必须走 slimProductsForPersist", () => {
    const src = stripComments(read("gui/src/renderer/pages/ChatPanel.tsx"));
    const m = /export function writeSessionProducts[\s\S]*?\n\}/.exec(src);
    expect(m, "writeSessionProducts 必须存在").toBeTruthy();
    expect(m![0], "落盘前必须过瘦身，否则要么撑爆 localStorage、要么静默丢详情").toContain("slimProductsForPersist");
  });

  it("工具卡与产物卡都必须以 diffNoticeKind 为判据，且判据不得退化成常量", () => {
    const src = stripComments(read("gui/src/renderer/pages/ChatPanel.tsx"));
    const conds = jsxConditionsUsing(src, "diffNoticeKind");
    // 两处降级提示（工具卡「改动过大未内联」+ 产物卡「详情未保存」）各一次
    expect(conds.length, "两处降级提示都必须由 diffNoticeKind 决定").toBeGreaterThanOrEqual(2);
    for (const c of conds) { expectNotConstant(c, "降级提示"); }
    // 两种语义必须分别落到各自的卡上（不能串味）
    expect(/diffNoticeKind\([^()]*\)\s*===\s*"too-large"/.test(src), "工具卡未消费 too-large").toBe(true);
    expect(/diffNoticeKind\([^()]*\)\s*===\s*"trimmed"/.test(src), "产物卡未消费 trimmed").toBe(true);
    // 文案本身也必须还在（判据对了但话没了 = 没修）
    expect(src).toContain("未内联展示前后对比");
    expect(src).toContain("详情未保存");
  });

  it("主进程：非 Git 工作区必须给中文并指路，不得把 git 原始 stderr 抛给用户", () => {
    const src = stripComments(read("gui/src/main/index.ts"));
    const m = /"slime:git:showFile"[\s\S]*?\n  \}\);/.exec(src);
    expect(m, "slime:git:showFile 处理器必须存在").toBeTruthy();
    const body = m![0];
    // 必须先探测仓库（否则 fatal 文案是从 git 里"漏"出来的，不可控）
    expect(body, "缺少仓库探测").toContain('["rev-parse", "--is-inside-work-tree"]');
    expect(body, "非仓库分支必须给出 code 供界面分流").toContain('code: "not-repo"');
    expect(body, "必须告诉用户去哪看这次改动").toContain("变更详情");
    // 反面：不得无条件把 stderr 当用户文案（保留兜底是允许的，但必须有前置分支）
    expect(/not a git repository/i.test(body), "不得把英文 fatal 当作面向用户的判据").toBe(false);
  });

  it("渲染层必须消费主进程给出的 code（否则前端仍只能展示一坨文本）", () => {
    const src = stripComments(read("gui/src/renderer/pages/RightSidebar.tsx"));
    expect(src).toContain("diffErrorCode");
    expect(/res\?\.code/.test(src), "toggleDiff 未接下 code").toBe(true);
    expect(/diffErrorCode === "not-repo"/.test(src), "未按类别分流提示").toBe(true);
  });
});

describe("A-1029 ⑤ 降级判据是纯逻辑（唯一实现，不许散进 .tsx 的条件表达式）", () => {
  it("拿到全文时永远不需要降级说明（哪怕历史数据残留了 trimmed）", () => {
    expect(diffNoticeKind({ add: 1, del: 1 }, true, false)).toBeNull();
    expect(diffNoticeKind({ add: 1, del: 1 }, true, true)).toBeNull();
    expect(diffNoticeKind(undefined, true, false)).toBeNull();
  });

  it("有计数、无全文 → too-large（渲染上限把它丢了，必须说出来）", () => {
    expect(diffNoticeKind({ add: 2, del: 1 }, false, false)).toBe("too-large");
    expect(diffNoticeKind(null, false, false)).toBeNull();
  });

  it("有计数、无全文、带落盘标记 → trimmed 优先（「未随记录保存」比「改动过大」更准确）", () => {
    expect(diffNoticeKind({ add: 2, del: 1 }, false, true)).toBe("trimmed");
  });

  it("压根没有改动信息 → 不说话（空产物卡不该冒提示）", () => {
    expect(diffNoticeKind(undefined, false, false)).toBeNull();
    expect(diffNoticeKind(null, false, false)).toBeNull();
  });
});

describe("A-1029 ④ 反假阳：守卫盯的是活代码，不是注释里的字面量", () => {
  it("把目标串放进注释 → stripComments 后必须消失（证明上面的断言不会被注释骗过）", () => {
    const fake = [
      "// slimProductsForPersist",
      "/* 未内联展示前后对比 */",
      "const x = 1; // 详情未保存",
    ].join("\n");
    const stripped = stripComments(fake);
    expect(stripped).not.toContain("slimProductsForPersist");
    expect(stripped).not.toContain("未内联展示前后对比");
    expect(stripped).not.toContain("详情未保存");
    expect(stripped).toContain("const x = 1;");
  });

  it("判据扫描器自检：必须能认出 `false && 原条件` 这类退化（否则 M9 会漏网）", () => {
    const ok = `{diffNoticeKind(p.diff, !!p.diffFull, !!p.diffTrimmed) === "trimmed" && (`;
    const degenerate = `{false && diffNoticeKind(p.diff, !!p.diffFull, !!p.diffTrimmed) === "trimmed" && (`;
    expect(jsxConditionsUsing(ok, "diffNoticeKind").length, "正常写法必须被扫到 1 次").toBe(1);
    expect(jsxConditionsUsing(degenerate, "diffNoticeKind").length, "退化写法必须被扫到 1 次").toBe(1);
    // 正常写法：判据不是常量；退化写法：判据以 false 开头 → expectNotConstant 会判红
    expect(/^(false|true|0|1|null|undefined)\b/.test(jsxConditionsUsing(ok, "diffNoticeKind")[0])).toBe(false);
    expect(/^(false|true|0|1|null|undefined)\b/.test(jsxConditionsUsing(degenerate, "diffNoticeKind")[0])).toBe(true);
  });
});
