/**
 * tests/gui/a1106b-guest-call.spec.ts — A-1106b：webview 导航 reject 必须被接住。
 *
 * 症状（用户实测）：调试面板**反复**刷
 *   `Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL': Error: ERR_ABORTED (-3) loading 'data:image/png;base64,…'`
 *
 * 根因：`wv.loadURL()` 返回 Promise，失败/被下一次导航顶掉时它 **reject**；
 * Electron 内部 `navigationListener → rejectAndCleanup` 把这个 reject 当**未捕获异常**打印。
 * 旧代码 `try { wv.loadURL(u); } catch {}` **接不住**它（同步 try/catch 管不了异步 reject）。
 *
 * ⚠️ 为什么本 spec 以**行为**测试为主：静态文本守卫只能证明"那行字还在"，
 *    证明不了"reject 真的被接住了"。本仓已有「检测器自己会空转」的教训（§15①/§17④），
 *    所以这里配了**阳性对照**（Test A：同一份输入、旧写法 ⇒ 检测器必须报"没接"）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeLoadURL } from "../../gui/src/renderer/pages/webviewNav.js";

const ROOT = resolve(__dirname, "../..");
const WEBVIEW_NAV = readFileSync(resolve(ROOT, "gui/src/renderer/pages/webviewNav.ts"), "utf8");
const RSB = readFileSync(resolve(ROOT, "gui/src/renderer/pages/RightSidebar.tsx"), "utf8");
const BRIDGE = readFileSync(resolve(ROOT, "gui/src/renderer/pages/browserBridge.ts"), "utf8");

/** 剥注释：注释里会写"曾经是什么"，不该被当成当前代码断言（§24「判据被兜住」家族）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/* 被测器用「可观察的 thenable」而不是真 Promise：能**直接看到** catch 挂没挂，
   且不会制造真的未捕获 rejection 把测试跑挂。真 Promise 的路径由 C/D 两条覆盖。 */

describe("A-1106b safeLoadURL：loadURL 的 reject 必须被接住", () => {
  it("A【阳性对照】旧写法（裸调用、只 try/catch）⇒ 检测器必须报「没挂 catch」", () => {
    /* 已知坏样本 + 与真实 bug 同形的调用方式：同步 try/catch **不接**异步 reject。
       若这条不能红，下面的 Test B 就是空转（§15① 喂已知坏样本）。 */
    const rec = { caught: false };
    const thenable = { catch(): unknown { rec.caught = true; return { catch: () => undefined }; } };
    const wv = { loadURL: () => thenable };
    // 旧代码形态：同步 try/catch —— 抓不住异步 reject，也不会调用 .catch
    try { (wv.loadURL as (u: string) => unknown)("data:image/png;base64,AAAA"); } catch { /* 接不到 */ }
    expect(rec.caught, "旧写法竟然挂了 catch —— 阳性对照失效，说明这条检测器测不到东西").toBe(false);
  });

  it("B 经 safeLoadURL ⇒ 必须真的挂上 catch，并且分类器不抛", () => {
    const rec = { caught: false, handlerRan: false };
    const thenable = {
      catch(fn: (e: unknown) => void): unknown {
        rec.caught = true;
        fn({ errno: -3, code: "ERR_ABORTED" });
        rec.handlerRan = true;
        return { catch: () => undefined };
      },
    };
    safeLoadURL({ loadURL: () => thenable }, "data:image/png;base64,AAAA");
    expect(rec.caught, "safeLoadURL 没有挂 .catch —— reject 仍会逃逸（本模块存在的全部意义）").toBe(true);
    expect(rec.handlerRan, "catch 处理器自己抛了 —— 分类逻辑有问题").toBe(true);
  });

  it("C 真实 rejected promise（-3 被顶掉）⇒ 不得变成未捕获 rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const wv = { loadURL: (): Promise<never> => Promise.reject({ errno: -3, code: "ERR_ABORTED" }) };
      safeLoadURL(wv, "data:image/png;base64,AAAA");
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled, "-3 逃逸成了未捕获 rejection ⇒ 调试面板会刷 GUEST_VIEW_MANAGER_CALL").toHaveLength(0);
  });

  it("D 真实 rejected promise（-102 真失败）⇒ 同样不得逃逸（可见通道是 did-fail-load 错误页）", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const wv = { loadURL: (): Promise<never> => Promise.reject({ errno: -102, code: "ERR_CONNECTION_REFUSED" }) };
      safeLoadURL(wv, "http://127.0.0.1:1/");
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled, "真失败逃逸成了未捕获 rejection").toHaveLength(0);
  });

  it("E loadURL 同步抛（未 attach）⇒ 不许把异常抛给调用方", () => {
    const wv = { loadURL: (): never => { throw new Error("must be attached to the DOM"); } };
    expect(() => safeLoadURL(wv, "https://example.com")).not.toThrow();
  });

  it("F 空目标 / 无 loadURL 的对象 ⇒ 安全空操作，且**一次导航都不发起**", () => {
    /* ⚠️ 只断言"不抛"是本条曾经的漏洞：去掉早退守卫后，`wv.loadURL` 为 undefined 会抛 TypeError，
       却被**同步 try/catch** 兜住 ⇒ 守卫仍然绿（等价变异体假象）。
       真实意图是"**根本不发起**这次导航"（空 URL 也会 reject）⇒ 必须数调用次数。
       —— 这是「**补样本，不是删变异**」（原 #7 逃逸后按铁律补的）。 */
    let calls = 0;
    const spy = { loadURL: (): Promise<never> => { calls += 1; return Promise.reject({ errno: -3 }); } };
    expect(() => safeLoadURL(null, "https://example.com")).not.toThrow();
    expect(() => safeLoadURL(undefined, "https://example.com")).not.toThrow();
    expect(() => safeLoadURL({} as { loadURL(u: string): unknown }, "https://example.com")).not.toThrow();
    expect(() => safeLoadURL(spy, "")).not.toThrow();
    expect(calls, "空 URL / 无 loadURL 对象都不该真的发起导航（否则又制造一次会 reject 的导航）").toBe(0);
  });
});

describe("A-1106b 静默失效守卫：导航不得再有裸 loadURL 产地", () => {
  it("① RightSidebar 里 `loadURL(` 的调用数为 0（全部走唯一安全出口）", () => {
    const code = stripComments(RSB);
    const hits = code.match(/\.loadURL\s*\(/g) ?? [];
    expect(hits, "RightSidebar 又出现裸 loadURL（异步 reject 会重新逃逸成调试面板红字）").toHaveLength(0);
  });

  it("② browserBridge 里 `loadURL(` 的调用数为 0（同上）", () => {
    const code = stripComments(BRIDGE);
    const hits = code.match(/\.loadURL\s*\(/g) ?? [];
    expect(hits, "browserBridge 又出现裸 loadURL").toHaveLength(0);
  });

  it("③ 唯一出处只用 `isBenignAbort` 判 -3（不许退化成魔法数字，口径与错误页同源）", () => {
    expect(WEBVIEW_NAV).toContain("isBenignAbort");
    expect(WEBVIEW_NAV, "不许自己写 errno === -3 的私货口径").not.toMatch(/===\s*-3\b/);
  });
});
