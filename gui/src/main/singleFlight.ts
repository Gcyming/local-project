/**
 * A-1043 单飞（single-flight）执行器 —— 「同一份初始化只跑一次」的唯一实现。
 *
 * **为什么要有这个模块**（用户原话：「每次重新启动后……第一时间左侧边栏的会话列表都是空白的，
 * 什么都没有，跟刚下载一样」）：
 *
 * 主进程的重初始化 `ensureServices()`（SILAM python sidecar / engine / sandbox / ChatService /
 * 调度器装配）**原先只由渲染层的 IPC 惰性触发**，而且**没有 in-flight 去重**。
 * 启动那一刻四个首屏 list 几乎同时打进来 → 整条初始化链**并发跑两遍**。实测证据（同一次启动）：
 *
 *   [gui:main] core-ts 服务已加载（ChatService/StatsService + SandboxManager）      ← ×2
 *   [scheduler] 启动失败: Attempted to register a second handler for 'slime:resident:state'  ← ×2
 *   [agent-http] 事件端点监听失败: listen EADDRINUSE: address already in use 127.0.0.1:19011 ← ×2
 *
 * 启动成本直接翻倍，而 `sessions:list` 的 handler 恰好 `await ensureServices()` —— 于是
 * 左栏要等整条链跑完才可能有数据；渲染层 8s 的 `firstLoadGuard` 先放行 UI，用户看到的就是空列表。
 *
 * **语义（三条都要，缺一条就成了另一个 bug）**：
 *   ① 并发调用共享同一个 in-flight Promise —— 这就是"单飞"；
 *   ② **成功后**后续调用直接复用结果，不再重跑（初始化是幂等的"一次就够"）；
 *   ③ **失败不缓存**：清空 in-flight，让下一次调用能重试 ——
 *      否则一次瞬时失败（如端口占用）会被永久记忆，功能再也不可用。
 *
 * 纯逻辑模块，vitest 直测（`tests/gui/a1043-guards.spec.ts`）。
 */

/** 把一个异步初始化包成"单飞"函数：并发调用只真正执行一次 `run()`。 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return (): Promise<T> => {
    if (inflight) {
      return inflight;
    }
    const p = run();
    inflight = p;
    // ③ 失败不缓存：清空以便下一次调用重试。
    //    成功后**保留** `inflight` —— 后续调用直接复用这个已 resolve 的 Promise（② 语义）。
    //    ⚠️ 不要再额外加一个"已完成"布尔标志：那会成为第二个真值来源（本项目踩过同形的坑），
    //    删掉标志行为完全不变 —— 变异测试实测为"无效果变异"，故不留。
    p.catch(() => { inflight = null; });
    return p;
  };
}
