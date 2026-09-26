/**
 * tests/core-ts/a1106-loop-fixes.spec.ts — A-1106 第二支线：Agent-Loop 全面检查后修掉的三处。
 *
 * 与 a1106-guards.spec.ts 同一形态：**过 tsc、过构建、过所有既有逻辑测试，只在用户眼里翻车**。
 *
 * ① **压缩触发时机的单位错配**（`countTurns`）
 *    `needsCompress(used, cap, ratio, turnCount)` 的第 4 个参数语义是**轮数**，
 *    调用点却直接传 `historyAll.length`（**消息条数**）。一条用户消息通常带 1 条 assistant
 *    （有工具调用时更多）⇒ 消息数 ≈ 轮数 × 2 以上 ⇒ 最小轮次门槛（6 轮）实际在 2-3 轮就放行，
 *    **压缩触发得比设计早一倍**（用户症状：还没聊几句就开始压缩）。
 *
 * ② **委派规范只有一个产地**（`DELEGATION_GUIDANCE`）
 *    规范文本此前只写在 `ChatService.systemPromptFor` 里，另一条系统提示词产地
 *    `Engine.buildSystem`（定时任务 / 非 ChatService 的引擎路径）**完全拿不到委派引导**
 *    ⇒ 那条路径上的任务 100% 由主 Agent 单干（用户症状：「整个任务全是主Agent一个智能体做」）。
 *    现在收成唯一常量，两条产地共用；措辞也从「先想能不能拆」再平衡为**默认派发**。
 *
 * ③ **RPM 等待「等完了才出声」**（`acquire` 的 onWait）
 *    `acquire` 自己 `await sleep`，调用方在它**返回之后**才上报 ⇒ 用户在整个等待期
 *    （额度用满时可能十几秒到一分钟）看到的是一整段空白，只会以为卡死。
 *    现在 `onWait` 在**每次真正 sleep 之前**回调 ⇒ 真的做到「先上报再睡」。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countTurns } from "../../core-ts/src/services/context_loop.js";
import { needsCompress, DEFAULT_COMPRESS_RATIO } from "../../core-ts/src/services/context_compress.js";
import { DELEGATION_GUIDANCE } from "../../core-ts/src/services/subagentCatalog.js";
import { RpmLimiter } from "../../core-ts/src/llm/rpmLimiter.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** 剥注释后再断言（注释里会**故意**写出旧写法/新写法的说明，不剥就是假红或假绿） */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const CHAT = stripComments(readSrc("core-ts/src/services/chat.ts"));
const ENGINE = stripComments(readSrc("core-ts/src/services/engine.ts"));
const MAIN = stripComments(readSrc("gui/src/main/index.ts"));
const CLIENT = stripComments(readSrc("core-ts/src/llm/client.ts"));
const CHATPANEL = stripComments(readSrc("gui/src/renderer/pages/ChatPanel.tsx"));

/* ────────────────────────── K 组：轮数口径（单位错配） ────────────────────────── */

describe("A-1106 K 组 — 「轮」的唯一口径（堵单位错配）", () => {
  it("K1 一轮 = 一条 user 消息（与 planCut 的 turn 边界同源）", () => {
    expect(countTurns([
      { role: "user" }, { role: "assistant" },
      { role: "user" }, { role: "assistant" }, { role: "tool" },
    ])).toBe(2);
  });

  it("K2 非数组 / 空 / 缺 role 一律计 0（不许抛错，也不许凭空造轮）", () => {
    expect(countTurns([])).toBe(0);
    expect(countTurns(null)).toBe(0);
    expect(countTurns(undefined)).toBe(0);
    expect(countTurns([{ role: "assistant" }, {}])).toBe(0);
  });

  it("K3 消息条数 ≠ 轮数：同一段历史的两种算法必须给出不同结果（否则本守卫测不出单位）", () => {
    const history = [
      { role: "user" }, { role: "assistant" }, { role: "tool" },
      { role: "user" }, { role: "assistant" },
      { role: "user" }, { role: "assistant" },
    ];
    expect(history.length).toBe(7);      // 消息条数 → 7 ≥ 6 ⇒ 旧写法直接放行
    expect(countTurns(history)).toBe(3); // 真实轮数 → 3 < 6 ⇒ 门槛拦住
    expect(needsCompress(9000, 10000, 0.85, history.length)).toBe(true);
    expect(needsCompress(9000, 10000, 0.85, countTurns(history))).toBe(false);
  });

  it("K4 触发判据必须过 countTurns（接线；单位错配回归即红）", () => {
    expect(MAIN).toContain("ratioTriggered: needsCompress(used, cap, ratio, countTurns(historyAll)),");
    expect(MAIN, "单位错配回归：又拿消息条数当轮数了").not.toContain("needsCompress(used, cap, ratio, historyAll.length)");
    expect(MAIN, "countTurns 没接线（没 import 就编译不过）").toContain("countTurns");
  });

  it("K5 needsCompress 自身的轮次门槛不变（6 轮，K 口径改动不许顺手动这里）", () => {
    expect(needsCompress(9999, 10000, DEFAULT_COMPRESS_RATIO, 6)).toBe(true);
    expect(needsCompress(9999, 10000, DEFAULT_COMPRESS_RATIO, 5)).toBe(false);
  });
});

/* ────────────────────────── L 组：委派规范唯一出处 ────────────────────────── */

describe("A-1106 L 组 — 委派规范收成唯一出处，两条产地共用", () => {
  it("L1 规范必须写明「默认派发」与「四类必须自己做」（用户要求：主 Agent 负责规划与主干）", () => {
    expect(DELEGATION_GUIDANCE).toContain("默认派发");
    // ⚠️ 这一条是被 M42 变异漏出来后补上的（变异逃逸归因②=判据没覆盖，处置是**补样本**而不是删变异）：
    //    只断言「四类里的两条内容」不够——标题被删掉时职责边界在语义上已经消失，而内容还在。
    expect(DELEGATION_GUIDANCE).toContain("必须自己做的四类");
    expect(DELEGATION_GUIDANCE).toContain("规划与拆解本身");
    expect(DELEGATION_GUIDANCE).toContain("主干上的整合与门禁");
    expect(DELEGATION_GUIDANCE).toContain("必须验收");
    expect(DELEGATION_GUIDANCE).toContain("①目标 ②期望的输出格式 ③边界");
  });

  it("L2 ChatService 必须引用常量，且**不再**保留内联副本（两产地漂移的根源）", () => {
    expect(CHAT).toContain('sys += "\\n\\n" + DELEGATION_GUIDANCE;');
    expect(CHAT, "内联副本还在 ⇒ 又会与 engine 那份漂移").not.toContain("子任务委派（delegate_subagent");
  });

  it("L3 Engine.buildSystem 也必须带上委派规范（定时任务路径否则 100% 单干）", () => {
    expect(ENGINE).toContain("parts.push(DELEGATION_GUIDANCE);");
  });

  it("L4 两条产地引用的是**同一个模块**（不许各自再定义一份文本）", () => {
    expect(CHAT).toContain('from "./subagentCatalog.js"');
    expect(ENGINE).toContain('from "./subagentCatalog.js"');
  });

  it("L5 旧措辞回归即红（「先想「能不能拆」」= 把「自己做」当默认的那版）", () => {
    expect(CHAT + ENGINE).not.toContain("先想「能不能拆」，不要默认自己全做完");
  });
});

/* ────────────────────────── M 组：RPM 先上报再睡 ────────────────────────── */

describe("A-1106 M 组 — 限流等待必须「先上报再睡」", () => {
  /** 记录调用顺序的假时钟（不碰真实时间） */
  const mkLimiter = (rpm: number) => {
    const order: string[] = [];
    let now = 0;
    const lim = new RpmLimiter({
      clock: { now: () => now, sleep: async (ms: number) => { order.push(`sleep:${ms}`); now += ms; } },
      declaredOf: () => rpm,
    });
    return { lim, order, tick: (ms: number) => { now += ms; } };
  };

  it("M1 onWait 必须在**真正 sleep 之前**回调（否则等于等完了才说）", async () => {
    const { lim, order } = mkLimiter(2);
    const note = (ms: number) => order.push(`wait:${ms}`);
    await lim.acquire("k", "m", note);
    await lim.acquire("k", "m", note);
    await lim.acquire("k", "m", note);   // 第 3 次：窗口已满 ⇒ 必须等
    const wi = order.findIndex((s) => s.startsWith("wait:"));
    const si = order.findIndex((s) => s.startsWith("sleep:"));
    expect(wi, "整轮没人等 —— 用例没构造出额度用满的场景").toBeGreaterThanOrEqual(0);
    expect(si, "没人睡 —— 用例没构造出额度用满的场景").toBeGreaterThanOrEqual(0);
    expect(wi, `上报必须早于 sleep，实测顺序=${order.join(",")}`).toBeLessThan(si);
  });

  it("M2 onWait 抛错绝不影响取令牌与额度记账（与 observe 同一纪律）", async () => {
    const { lim } = mkLimiter(1);
    await lim.acquire("k", "m", () => { throw new Error("boom"); });
    await expect(lim.acquire("k", "m", () => { throw new Error("boom"); })).resolves.toBeTruthy();
  });

  it("M3 放行时不许回调 onWait（没等就不该出声，否则是噪声）", async () => {
    const { lim, order } = mkLimiter(5);
    await lim.acquire("k", "m", (ms) => order.push(`wait:${ms}`));
    expect(order).toEqual([]);
  });

  it("M4 client.ts 必须把 onWait 传下去（不传 ⇒ 又回到等完了才说）", () => {
    expect(CLIENT).toContain("acquire(rateLimit.key, rateLimit.model, (ms) => {");
    expect(CLIENT, "「等完了才出声」回归：上报又挂在 acquire 返回之后").not.toContain("if (waitedMs >= 1000)");
    expect(CLIENT).toContain("需要等 ${Math.round(ms / 1000)}s 再发");
  });
});

/* ────────────────────────── N 组：压缩比率的唯一出处 ────────────────────────── */

describe("A-1106 N 组 — 压缩比率只有一个出处（渲染层不许再抄一份）", () => {
  it("N1 渲染层引用 core-ts 常量，且不再出现那组字面量（第二产地 = 静默失效）", () => {
    expect(CHATPANEL).toContain('from "../../../../core-ts/src/services/context_compress.js"');
    expect(CHATPANEL).toContain("DEFAULT_COMPRESS_RATIO");
    expect(CHATPANEL, "压缩比率的第二产地回归 ⇒ 主进程一改，界面回显与刻度线悄悄对不上").not.toContain("ratio: 0.85");
    expect(CHATPANEL).not.toContain("p.ratio <= 0.97");
  });

  it("N2 上下界与默认值都来自同一模块（不是把数字重抄一遍）", () => {
    expect(CHATPANEL).toContain("p.ratio >= RATIO_MIN && p.ratio <= RATIO_MAX ? p.ratio : DEFAULT_COMPRESS_RATIO");
  });

  it("N3 主进程那侧的常量仍在（本组锁的是渲染层，别把出处本身删了）", () => {
    const COMPRESS = stripComments(readSrc("core-ts/src/services/context_compress.ts"));
    expect(COMPRESS).toContain("export const DEFAULT_COMPRESS_RATIO = 0.85;");
    expect(COMPRESS).toContain("export const RATIO_MIN = 0.5;");
    expect(COMPRESS).toContain("export const RATIO_MAX = 0.97;");
  });
});
