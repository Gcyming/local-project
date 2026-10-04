



























import { describe, expect, it } from "vitest";

import { getLocalCapability, probeLocalEndpoint } from "../../gui/src/main/localServerProbe.js";
import { describeWindowCap, resolveWindowCap } from "../../core-ts/src/model_introspect.js";

const PORT = Number(process.env.SLIME_LIVE_LLAMA_PORT ?? 8871);
const BASE = `http://127.0.0.1:${PORT}`;
const ENABLED = process.env.SLIME_LIVE_LLAMA === "1";


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
    
    
    const cap = await getLocalCapability(BASE);
    const bogusPlanned = (cap.effectiveCtx ?? 0) + 100000;
    const r = resolveWindowCap({ serverCtx: cap.effectiveCtx, plannedCtx: bogusPlanned });
    expect(r.source).toBe("server");
    expect(r.ctx).toBe(cap.effectiveCtx);
    expect(r.ctx).not.toBe(bogusPlanned);
  });

  it("训练上限独立于有效窗口（两者都由这个服务自述，不许合并）", async () => {
    const cap = await getLocalCapability(BASE);
    
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
