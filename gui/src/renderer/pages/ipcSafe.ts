/**
 * gui/src/renderer/pages/ipcSafe.ts — IPC 调用的**唯一安全口**（A-1100）。
 *
 * ## 为什么必须收敛到一个出处
 *
 * `ipcRenderer.invoke` 在**通道尚未注册**时会 **reject**（`No handler registered for 'xxx'`）。
 * 裸 `await` 调用会同时造成两类事故：
 *   ① 一条 `Uncaught (in promise)` 红字 —— 用户看到的就是「调试面板有 error」；
 *   ② 同一 `async` 体内**后续语句永不执行**（关弹层 / 刷新列表 / 出提示）
 *      —— 用户看到的就是「按钮点了没反应」（A-1100 的事故本体）。
 *
 * 于是「通道注册位置」与「调用点是否兜底」是**两个独立的坑**，必须各堵一处：
 *   · 注册位置 → 见 `gui/src/main/index.ts` 里 A-1048 / A-1100 的那些注释；
 *   · 调用点兜底 → 就是本模块。
 *
 * ⚠️ 本模块是**纯逻辑**（不 import React、不碰 DOM），故可单测、可变异
 *    —— 本仓铁律：纯逻辑不许住在 `.tsx` 里。
 */
export type InvokeOk<T> = { ok: true; value: T };
export type InvokeErr = { ok: false; error: string };
export type InvokeResult<T> = InvokeOk<T> | InvokeErr;

/**
 * 安全调用一个可能不存在的 IPC 通道。
 *
 * - 通道方法缺失（可选链断在 `undefined`）→ `{ ok:false, error:"通道不可用…" }`
 * - 调用 reject（未注册 / IPC 异常）→ 把**异常原话**作为 `error` 交回
 * - 正常返回 → 原样透传
 *
 * ⚠️ **绝不许在这里吞掉失败**：本函数的全部价值就是"把失败如实交回调用方"。
 *   写成空 `catch {}` 或 `return { ok:true, value: undefined as T }`，
 *   等于把「通道没注册」伪装成「调用成功」—— 那是本仓最忌讳的静默失效。
 */
export async function tryInvoke<T>(fn: () => Promise<T> | undefined): Promise<InvokeResult<T>> {
  try {
    const v = await fn();
    if (v === undefined) { return { ok: false, error: "通道不可用（后台服务尚未就绪，请稍候重试）" }; }
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 把 `tryInvoke` 的结果归一成「像个 IPC 返回体」的形状，便于沿用既有的
 * `if (r?.ok) {…} else { setNotice(\`…：${r?.error ?? "未知"}\`) }` 写法。
 *
 * 存在的理由：不归一的话，4 个调用点会各写一遍三元表达式，**漏掉一处就丢掉真实原因**
 * （表现为提示退化成"操作失败：未知"）。
 *
 * ⚠️ **`T` 不许加约束**：IPC 各通道的返回体形状不一，`tryInvoke` 推出来的常常是
 *   `InvokeResult<unknown>`（例如 `act` 的 `fn: () => Promise<unknown>`）。
 *   若写成 `T extends { ok?: boolean; error?: string }`，`InvokeResult<unknown>` **传不进来**
 *   ⇒ 四处调用点全部 `TS2345`：那是"守卫编不过"，不是"守住了"。
 *   （本仓判据：**约束要么正确，要么不要** —— 半对的约束只会把真缺陷翻译成编译错误，
 *     然后被人用 `as any` 抹掉。）
 */
export function asReply<T>(res: InvokeResult<T>): Partial<T> & { ok?: boolean; error?: string } {
  /* 断言理由（两处都要，别只改一处）：`res.value` 的静态类型是 `T`（IPC 载荷，形状由**运行时**决定），
     而调用方要按"可能带 `ok` / `error` 的返回体"去读它；失败支的 `{ ok:false, error }` 同理 ——
     `Partial<T>` 对**未约束**的 `T` 是不透明类型，字面量对象推不进去。
     这一步是**形状归一**，不是类型系统能证的东西，故走 `unknown` 中转
     （比 `as any` 多一道"确实有意为之"的痕迹）。 */
  const shape = res.ok ? res.value : { ok: false, error: res.error };
  return shape as unknown as Partial<T> & { ok?: boolean; error?: string };
}
