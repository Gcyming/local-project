import { describe, expect, it, afterEach } from "vitest";
import { rateLimitGateOpen } from "../../core-ts/src/llm/client.js";
import { getSharedRpmLimiter } from "../../core-ts/src/llm/rpmLimiter.js";

/**
 * A-1195（交接欠账 B8）：`provider` 态 gate 判定是**请求时实时查询**，不是构造时快照。
 *
 * 交接文档原文：「`provider` 态的 gate 是构造时快照，存在『早于 manual RPM 注入的首请求』窗口
 * （实际不影响，但严格说有窗口）」。读码 + 本守卫实测：`rateLimitGateOpen` 在**每次**
 * fetchWithRetry 调用时执行，内部 `resolve()` 实时查 manual/declared/observed 三源 ⇒
 * 「同一个 identity，注入前后判定不同」——快照说法不成立。
 *
 * 本组守卫把这条性质钉死：若未来有人改成「构造 client 时算死 gateOpen」，
 * 下面的「注入后即变」断言会失效（必须在构造/缓存边界重新审视）。
 *
 * ⚠️ `setManualRpmOf` 是进程级共享单例的注入点 —— vitest 文件级隔离保证不跨文件污染；
 * 本文件内 afterEach 恢复为「查不到」的默认态。
 */
const limiter = getSharedRpmLimiter();

afterEach(() => {
  // 恢复默认：不注入任何人工 RPM（本文件专用，不与其它用例共享文件）
  limiter.setManualRpmOf(() => null);
});

describe("A-1195 B8：gate 判定实时性（非构造快照）", () => {
  it("explicit 恒开（GUI 主链路语义不许变）", () => {
    expect(rateLimitGateOpen("explicit", { key: "a1195-explicit" })).toBe(true);
  });

  it("provider：同一 identity 在注入前后判定会变 —— 证明是实时查询而非快照", () => {
    const key = `a1195-live-${Date.now()}`;
    // 注入前：查不到 ⇒ 无闸门（fail-open 放行）
    expect(rateLimitGateOpen("provider", { key })).toBe(false);
    // 注入后（无需重新构造任何 client）⇒ 有闸门
    limiter.setManualRpmOf((k) => (k === key ? 30 : null));
    expect(rateLimitGateOpen("provider", { key })).toBe(true);
    // 换一个仍然查不到的 key ⇒ 依旧放行（判定按 identity 粒度）
    expect(rateLimitGateOpen("provider", { key: `${key}-other` })).toBe(false);
  });

  it("provider：manual 注入函数抛错时 fail-open（不许因查询故障卡死用户）", () => {
    limiter.setManualRpmOf(() => { throw new Error("boom"); });
    expect(rateLimitGateOpen("provider", { key: "a1195-throw" })).toBe(false);
  });
});
