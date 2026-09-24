/**
 * tests/core-ts/a1088-first-byte.spec.ts — 首包超时与空闲超时**分离**（A-1088）
 * + `screen_windows` 空结果与故障**分态**（A-1088）。
 *
 * ## 本文件锁住的两个真实缺陷
 *
 * ### ① 冷缓存大 prompt 的「首包长静默」被与「真死」同态
 *
 * `IDLE_STREAM_MS` 与 `DEFAULT_LLM_TIMEOUT_MS` 此前**同为平的 300s**，而 prefill 阶段
 * 一个字节都不走网络 ⇒ 与"连接死了"**不可区分**。用户取证（`config/usage.jsonl` 5491 条）：
 * 29 条失败**全是 user-aborted**、无一上游错误，glm-5.3-flash 失败重发 prompt≈73.7K +
 * `cache_read=0` ⇒ **同一请求反复重发、缓存永不热 ⇒ 越重连越慢**。
 *
 * 修法：首包那一档**按 prompt 体积自适应**（`firstByteBudgetMs`），且**永不低于**
 * `IDLE_STREAM_MS`（纯增量 —— 不把当初为「上游把思考缓存在服务端一次推送」放宽到 300s
 * 的修复打回去）。同时把"在预填充 / 多大 / 最多等多久"如实上报（`formatPrefillNotice`）——
 * 因为失败是"人等不下去按停"，只放宽超时而不说明在等什么等于没修。
 *
 * ### ② `screen_windows` 空结果与故障同态
 *
 * `desktop.ts` 的 `listWindows` 两种情形**都抛**，而 `controller.ts` 又 `catch { return []; }`
 * 把异常吞掉 ⇒ 上层只能把"本机确实没有窗口"也当成故障报给模型
 * （模型于是去修一个并不存在的故障）。现在三态分明：真没窗口 = 空数组、枚举故障 = 抛。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDLE_STREAM_MS, FIRST_BYTE_MAX_MS,
  firstByteBudgetMs, roughInputTokens,
} from "../../core-ts/src/llm/client.js";
import { formatPrefillNotice } from "../../core-ts/src/llm/upstreamNotice.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const strip = (rel: string): string =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
const has = (src: string, needle: string, why: string): void =>
  expect(src.includes(needle), `${why}｜缺少：${needle}`).toBe(true);
const hasNot = (src: string, needle: string, why: string): void =>
  expect(src.includes(needle), `${why}｜不该出现：${needle}`).toBe(false);

const CLIENT = strip("core-ts/src/llm/client.ts");
const DESKTOP = strip("core-ts/src/screen/backends/desktop.ts");
const CONTROLLER = strip("core-ts/src/screen/controller.ts");
const BUILTIN = strip("core-ts/src/tools/builtin.ts");

describe("A-1088 · firstByteBudgetMs：首包按体积自适应，且**永不收紧**既有行为", () => {
  it("🐛 小 prompt 必须仍拿到 IDLE_STREAM_MS（自适应值更低也不许收紧）", () => {
    // 这条是本轮「纯增量」的核心保证：若哪天自适应值直接生效，
    // 10K 的 prompt 首包只有 160s < 300s ⇒ 把「思考被缓存、一次推送」那条修复打回去
    expect(firstByteBudgetMs(10_000)).toBe(IDLE_STREAM_MS);
    expect(firstByteBudgetMs(1)).toBe(IDLE_STREAM_MS);
  });

  it("🐛 大 prompt 必须**放宽**（用户取证的 73.7K 冷缓存 case）", () => {
    const b = firstByteBudgetMs(73_700);
    expect(b, `73.7K 的首包预算 ${b} 没有超过 IDLE_STREAM_MS(${IDLE_STREAM_MS}) ⇒ 取证里那条失败仍会发生`)
      .toBeGreaterThan(IDLE_STREAM_MS);
  });

  it("单调不减，且永远落在 [IDLE_STREAM_MS, FIRST_BYTE_MAX_MS]", () => {
    let prev = 0;
    for (const t of [0, 1, 1000, 10_000, 50_000, 74_000, 120_000, 200_000, 500_000, 5_000_000]) {
      const v = firstByteBudgetMs(t);
      expect(v, `tokens=${t} 得到 ${v}，低于空闲看门狗下限`).toBeGreaterThanOrEqual(IDLE_STREAM_MS);
      expect(v, `tokens=${t} 得到 ${v}，超过封顶 ${FIRST_BYTE_MAX_MS}`).toBeLessThanOrEqual(FIRST_BYTE_MAX_MS);
      expect(v, `tokens=${t} 处出现回退（体积越大给的时间反而越少）`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("极大 prompt 被封顶（不许无限等）", () => {
    expect(firstByteBudgetMs(10_000_000)).toBe(FIRST_BYTE_MAX_MS);
  });

  it("非法输入 → 退回下限，不抛", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(firstByteBudgetMs(bad)).toBe(IDLE_STREAM_MS);
    }
  });
});

describe("A-1088 · roughInputTokens：CJK 感知的量级估算（只服务首包预算）", () => {
  it("中文按 1 字 ≈ 1 token（与压缩口径一致，不 4 倍低估）", () => {
    const n = roughInputTokens({ messages: [{ role: "user", content: "汉".repeat(1000) }] });
    expect(n, `1000 汉字估成 ${n} ⇒ 又回到 /4 低估`).toBeGreaterThan(900);
    expect(n).toBeLessThan(1200);
  });

  it("英文按 4 字符 ≈ 1 token", () => {
    const n = roughInputTokens({ content: "a".repeat(4000) });
    expect(n).toBeGreaterThan(900);
    expect(n).toBeLessThan(1400);
  });

  it("空/不可序列化输入 → 0，不抛", () => {
    expect(roughInputTokens("")).toBe(0);
    expect(roughInputTokens(null)).toBe(0);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => roughInputTokens(circular)).not.toThrow();
  });
});

describe("A-1088 · formatPrefillNotice：把「在等什么 / 多大 / 最多等多久」说全", () => {
  it("三件事齐备（预填充 / tokens 量级 / 上限）", () => {
    const t = formatPrefillNotice(73_700, 416_000);
    expect(t).toContain("预填充");
    expect(t, "没说清大概多大 ⇒ 用户无法判断该不该继续等").toMatch(/≈\d+K tokens/);
    expect(t, "没给上限 ⇒ 用户不知道要等多久").toMatch(/最多等/);
    expect(t).toContain("6 分 56 秒");
  });

  it("不足 1 分钟时按秒说（不许出现「0 分 30 秒」）", () => {
    expect(formatPrefillNotice(1000, 30_000)).toContain("30 秒");
    expect(formatPrefillNotice(1000, 30_000)).not.toContain("0 分");
  });

  it("token 量级向上取整到至少 1K（不许出现「≈0K tokens」）", () => {
    expect(formatPrefillNotice(0, 300_000)).toContain("≈1K tokens");
  });
});

describe("A-1088 · 接线：首包预算必须真的用进流式读取（不是只写了个纯函数）", () => {
  it("三处流式读取循环都区分「首包」与「后续」", () => {
    // ChatClient / AnthropicClient / readSSEStream 各一处
    const n = (CLIENT.match(/firstRead \? firstBudgetMs : IDLE_STREAM_MS/g) ?? []).length;
    expect(n, `只有 ${n} 处接上了首包预算（应为 3：ChatClient / Anthropic / readSSEStream）`).toBe(3);
    expect(CLIENT).toContain("let firstRead = true;");
    expect(CLIENT).toContain("firstRead = false;");
  });

  it("🐛 请求级超时也要吃首包预算（部分网关 prefill 完成前连响应头都不 flush）", () => {
    has(CLIENT, "timeoutMsOverride?: number,", "请求级超时没有覆盖入口 ⇒ 首包预算只覆盖了读循环");
    has(CLIENT, "Math.max(this.timeoutMs, timeoutMsOverride as number)", "覆盖值没有与既有超时取大 ⇒ 可能反而收紧");
    has(CLIENT, "firstBudgetMs,\n    );", "chatStream 没有把首包预算传给请求级超时");
  });

  it("🐛 大 prompt 必须先如实上报（失败是「人等不下去按停」，不是超时杀的）", () => {
    has(CLIENT, 'noteUpstream("prefill"', "没有预填充上报 ⇒ 用户仍看到一句「等待上游返回…」然后自己按停");
    has(CLIENT, "formatPrefillNotice(", "文案没走唯一出处");
  });

  it("UpstreamNotice.kind 已收录 prefill（否则类型层就漂了）", () => {
    has(strip("core-ts/src/llm/upstreamNotice.ts"), '"retry" | "fallback" | "prefill"', "kind 联合类型缺 prefill");
  });
});

describe("A-1088 · screen_windows：空结果与故障必须分态", () => {
  it("🐛 controller 不许再把枚举异常吞成空数组", () => {
    hasNot(CONTROLLER, "try { return await b.listWindows(); } catch { return []; }",
      "异常被吞成 [] ⇒ 故障与「真的没有窗口」在上层完全同态");
    has(CONTROLLER, "return await b.listWindows();", "没有原样上抛");
  });

  it("desktop 三态分明：真没窗口 = 空数组 / 候选非 0 却全挂 = 抛 / diag 缺失 = 抛", () => {
    has(DESKTOP, "if (!diag) {", "diag 缺失没有单独判 ⇒ 协议不匹配会被当成「没有窗口」");
    has(DESKTOP, "const candidates = Number(diag.candidates ?? 0);", "没有读候选数 ⇒ 无法区分「真没窗口」与「枚举全挂」");
    has(DESKTOP, "if (candidates > 0) {", "候选非 0 却一条都没产出没有判为故障");
    // 空结果那条 `return []` 必须排在 `candidates > 0` 的抛错分支**之后**（即"排除了故障"才落到它）
    // ⚠️ 断言只认**代码**：本文件的 strip() 会剥掉注释，别拿注释当判据（第一版就是这么写错的）
    expect(
      /if \(candidates > 0\) \{[\s\S]{0,600}?\n      return \[\];/.test(DESKTOP),
      "空结果没有走「不是故障」这条分支（`return []` 不在候选数判定之后）",
    ).toBe(true);
  });

  it("工具层措辞必须让模型看懂「不是故障」（否则它会去修一个不存在的问题）", () => {
    has(BUILTIN, "枚举成功：当前**没有**可见的顶层窗口", "空结果仍被说成「未枚举到可见窗口」⇒ 与故障同义");
    has(BUILTIN, "这不是故障", "没有明确排除故障语义");
  });
});
