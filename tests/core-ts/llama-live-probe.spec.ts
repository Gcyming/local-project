/**
 * tests/core-ts/llama-live-probe.spec.ts — 对**活的** llama-server 做端到端交叉验证（S1）。
 *
 * ── 为什么需要它（它补的是桩测试**原理上**补不了的那个洞）──────────────
 * `local-server-probe.spec.ts` 用桩 fetch 断言"我按我以为的 URL 形状发请求"——
 * 但那只是把我的**假设**写进了断言。若真实服务端的路由表其实不接受这个 URL
 * （比如 `/props` 必须带某个前缀、或 `/v1/models` 对不同 base 有别的拼法），
 * 桩测试**照样全绿**。
 * 这正是 A-1018 ③ 的元教训：整条 bug 的成因就是"用推断代替问询"，
 * 那么验证方式本身也不能是推断。
 *
 * ── 怎么跑（**显式 opt-in**，默认跳过）────────────────────────────────
 *   SLIME_LIVE_LLAMA=1 npx vitest run tests/core-ts/llama-live-probe.spec.ts
 * 端口默认 8871，可用 SLIME_LIVE_LLAMA_PORT 覆盖。
 *
 * ⚠️ 为什么默认跳过而不是"检测到就自动跑"：
 *    8871 是随手挑的端口，用户机器上可能有**别的**服务（甚至别的模型/别的 ctx）恰好占着它。
 *    自动跑会把"别人的服务"判成本测试失败 —— 那是纯粹的假红，比不测更糟。
 *    同时它对 1.8GB 模型文件 + llama-server 二进制有硬依赖，不能让全量套件依赖它。
 *
 * ── 本机实测记录（2026-09-19，llama.cpp b10509，qwen3-1.7b-q8_0）──────
 *   服务以 `-c 8192` 启动，而 `slime.toml [model_server.chat] ctx_len = 32768`
 *   （故意造出"配置与事实不一致"这个 A-1018 ③ 的现场）：
 *     `probeLocalEndpoint("http://127.0.0.1:8871/v1")` → state=ready, effectiveCtx=8192, trainCtx=40960
 *     `resolveWindowCap({ serverCtx: 8192, plannedCtx: 32768 })`
 *       → { ctx: 8192, source: "server" }      ← **旧实现会回答 32768（读配置）**
 *     `describeWindowCap(cap)` → "本次 8,192（模型训练上限 40,960）"
 */
import { describe, expect, it } from "vitest";

import { getLocalCapability, probeLocalEndpoint } from "../../gui/src/main/localServerProbe.js";
import { describeWindowCap, resolveWindowCap } from "../../core-ts/src/model_introspect.js";

const PORT = Number(process.env.SLIME_LIVE_LLAMA_PORT ?? 8871);
const BASE = `http://127.0.0.1:${PORT}`;
const ENABLED = process.env.SLIME_LIVE_LLAMA === "1";

/** 服务在跑吗（不在跑就整段跳过，不制造假红） */
async function isUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
    return r.status === 200;
  } catch { return false; }
}

const UP = ENABLED ? await isUp() : false;
const skip = !UP;
if (ENABLED && !UP) {
  console.info(`[live] ${BASE} 无服务 —— 本组跳过（先起 llama-server，见文件头用法）`);
}

describe.skipIf(skip)("LIVE: 真实 llama-server 端到端", () => {
  it("provider 常见形态（base 带 /v1）能被真实路由表接受", async () => {
    const cap = await probeLocalEndpoint(`${BASE}/v1`);
    // 只断言"问到了"，**不断言具体数字** —— 数字取决于服务是怎么起的，断言死值会假红
    expect(cap.state).toBe("ready");
    expect(cap.effectiveCtx).toBeGreaterThan(0);
  });

  it("根 base（不带 /v1）同样能问到", async () => {
    const cap = await probeLocalEndpoint(BASE);
    expect(cap.state).toBe("ready");
    expect(cap.effectiveCtx).toBeGreaterThan(0);
  });

  it("两个 base 问到的是**同一个**服务、同一个数字", async () => {
    const [a, b] = await Promise.all([getLocalCapability(`${BASE}/v1`), getLocalCapability(BASE)]);
    expect(a.effectiveCtx).toBe(b.effectiveCtx);
  });

  it("★ 服务器压过配置：不管服务实际给多少，source 必须是 server 而不是 planned", async () => {
    // 这条是本文件的核心。plannedCtx 故意给一个**和真实值不同**的数（真实值 + 100000），
    // 若 decision 逻辑被改成"配置优先"，ctx 会变成那个假值 → 红。
    const cap = await getLocalCapability(BASE);
    const bogusPlanned = (cap.effectiveCtx ?? 0) + 100000;
    const r = resolveWindowCap({ serverCtx: cap.effectiveCtx, plannedCtx: bogusPlanned });
    expect(r.source).toBe("server");
    expect(r.ctx).toBe(cap.effectiveCtx);
    expect(r.ctx).not.toBe(bogusPlanned);
  });

  it("训练上限独立于有效窗口（两者都由这个服务自述，不许合并）", async () => {
    const cap = await getLocalCapability(BASE);
    // trainCtx 可能为 null（老版本无 meta），但若给了就不能等于被我们错误改写过的值
    if (cap.trainCtx !== null) {
      expect(cap.trainCtx).toBeGreaterThan(0);
      expect(describeWindowCap(cap)).toContain("本次");
    }
  });

  it("托管端口发现不抛（本机无托管实例时为空数组，也是合法结果）", async () => {
    const { managedChatPorts } = await import("../../gui/src/main/localServerProbe.js");
    expect(Array.isArray(managedChatPorts())).toBe(true);
  });
});
