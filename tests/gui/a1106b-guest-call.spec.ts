













import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeLoadURL } from "../../gui/src/renderer/pages/webviewNav.js";

const ROOT = resolve(__dirname, "../..");
const WEBVIEW_NAV = readFileSync(resolve(ROOT, "gui/src/renderer/pages/webviewNav.ts"), "utf8");
const RSB = readFileSync(resolve(ROOT, "gui/src/renderer/pages/RightSidebar.tsx"), "utf8");
const BRIDGE = readFileSync(resolve(ROOT, "gui/src/renderer/pages/browserBridge.ts"), "utf8");


function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}




describe("A-1106b safeLoadURL：loadURL 的 reject 必须被接住", () => {
  it("A【阳性对照】旧写法（裸调用、只 try/catch）⇒ 检测器必须报「没挂 catch」", () => {
    

    const rec = { caught: false };
    const thenable = { catch(): unknown { rec.caught = true; return { catch: () => undefined }; } };
    const wv = { loadURL: () => thenable };
    
    try { (wv.loadURL as (u: string) => unknown)("data:image/png;base64,AAAA"); } catch {  }
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
