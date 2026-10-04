






























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asReply, tryInvoke } from "../../gui/src/renderer/pages/ipcSafe.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const MAIN = stripComments(readSrc("gui/src/main/index.ts"));
const RESIDENT_RAW = readSrc("gui/src/renderer/pages/ResidentPanel.tsx");
const RESIDENT = stripComments(RESIDENT_RAW);



describe("A-1100 ① — 执行模型池两条通道：启动期注册 + 全仓唯一", () => {
  const REG_FN = "function registerIpcHandlers(): void {";

  
  const regSites = (channel: string): number[] => {
    const needle = `ipcMain.handle("${channel}"`;
    const out: number[] = [];
    let i = -1;
    while ((i = MAIN.indexOf(needle, i + 1)) >= 0) { out.push(i); }
    return out;
  };

  it("T1 【根因①】`slime:resident:subagent:setModels` 恰好在启动期注册一次", () => {
    const sites = regSites("slime:resident:subagent:setModels");
    expect(sites.length,
      `该通道出现 ${sites.length} 次 —— 必须**恰好 1 次**。`
      + "0 次 = 冷启动窗口内点保存直接 reject（用户实测「保存按钮无法实现功能」）；"
      + ">1 次 = 同一通道两处注册 = 第二真相源（且惰性块可能被跑两次）",
    ).toBe(1);
    const fnAt = MAIN.indexOf(REG_FN);
    expect(fnAt, "找不到 registerIpcHandlers 的定义（锚点失效）").toBeGreaterThan(0);
    expect(sites[0],
      "该通道必须注册在 `registerIpcHandlers()` 内（= 启动期），"
      + "不许再埋回惰性的 `ensureServicesOnce()` 块（那正是 A-1048 修过的同一个坑）",
    ).toBeGreaterThan(fnAt);
  });

  it("T2 兼容通道 `slime:resident:subagent:setDefaultModel` 同样启动期注册一次", () => {
    const sites = regSites("slime:resident:subagent:setDefaultModel");
    expect(sites.length, "该通道必须恰好注册一次（理由同 T1）").toBe(1);
    expect(sites[0], "该通道也必须注册在启动期，不许留在惰性块里").toBeGreaterThan(MAIN.indexOf(REG_FN));
  });

  it("T3 `registerIpcHandlers()` 真的在启动流程里被调用（不是死函数）", () => {
    
    const calls = [...MAIN.matchAll(/registerIpcHandlers\(\);/g)].length;
    expect(calls,
      "`registerIpcHandlers();` 的调用点不见了 —— 通道根本不会被注册（T1 的「位置对」就成了空话）",
    ).toBeGreaterThanOrEqual(1);
  });

  it("T4 【唯一真相源】`applySubagentModels` 必须☑落盘、☑同步管理器，且顺序是先落盘", () => {
    const body = /const applySubagentModels = \(models: unknown\): void => \{([\s\S]*?)\n\};/.exec(MAIN)?.[1];
    expect(body, "applySubagentModels 必须存在（锚点失效）").toBeTruthy();
    expect(body!,
      "写链路必须落盘 —— 否则所谓「保存成功」只活在内存里，重启即失（这就是静默失效）",
    ).toContain("saveSubagentDefaultModels(");
    expect(body!,
      "管理器就绪时必须把新池推给它 —— 否则运行中的派发还在用旧档位",
    ).toContain("subagentsRef?.setDefaultModels(");
    expect(body!.indexOf("saveSubagentDefaultModels("),
      "顺序错了：必须**先落真值再推管理器**。反过来会造出「磁盘旧 / 管理器新」的分叉窗口",
    ).toBeLessThan(body!.indexOf("subagentsRef?.setDefaultModels("));
  });
});



describe("A-1100 ② — 渲染层：`await` 必须经安全口，不许再裸调（reject ⇒ 弹层不关 + 控制台红字）", () => {
  
  const saveHandler =
    /onClick=\{\(\) => void \(async \(\) => \{([\s\S]*?)\}\)\(\)\}>保存<\/button>/.exec(RESIDENT)?.[1] ?? "";

  it("T5 【根因②】全仓不再有裸 `await api.resident…`，且 4 个写调用点都过安全口", () => {
    const bare = [...RESIDENT.matchAll(/await\s+api\.resident/g)];
    expect(bare.length,
      `ResidentPanel.tsx 还有 ${bare.length} 处裸 await api.resident… —— `
      + "通道未注册时它会 reject：① 变 Uncaught 红字（= 用户看到的「调试面板有 error」）"
      + "② 同一 async 体后续语句不执行（= 「按钮点了没反应」）。必须经 `tryInvoke` 安全口",
    ).toBe(0);
    const viaSafe = [...RESIDENT.matchAll(/asReply\(await tryInvoke\(/g)].length;
    expect(viaSafe,
      `走「asReply(await tryInvoke(…))」的调用只有 ${viaSafe} 处 —— 应为 4 处`
      + "（保存按钮 / act / clearRuns / 可派发选择开关）",
    ).toBeGreaterThanOrEqual(4);
  });

  it("T6 保存按钮：提交经 `tryInvoke`，失败在**弹层内**就地出声（不许退化成沉默或弹层背后的提示）", () => {
    expect(saveHandler, "找不到保存按钮的 onClick 处理器（锚点失效）").not.toBe("");
    expect(saveHandler,
      "提交那次 IPC 必须经 `tryInvoke` —— 裸 `await` 一旦 reject，下面的 `setModelModal(false)` 永不执行"
      + "（症状：弹层卡住不关、按钮「点了没反应」，且界面零提示）",
    ).toContain("tryInvoke(");
    expect(saveHandler,
      "失败分支必须写 saveError —— 改成 setNotice 的话提示落在弹层**背后**，用户根本看不见",
    ).toMatch(/\}\s*else\s*\{\s*setSaveError\(/);
    expect(RESIDENT,
      "弹层里必须渲染 saveError —— 只 set 不渲染 = 又一个静默失效",
    ).toContain("{saveError && (");
  });

  it("T7 打开弹层必须清掉上一次的失败提示（否则重开还挂着旧错误）", () => {
    const resets = (RESIDENT.match(/setSaveError\(""\)/g) ?? []).length;
    expect(resets,
      `setSaveError("") 只出现 ${resets} 次 —— 打开弹层与每次提交前都该清零`
      + "（否则上一次的错误会一直挂在弹层里，误导下一次操作）",
    ).toBeGreaterThanOrEqual(2);
  });

  it("T8 `act` / `clearRuns` / 可派发选择开关 三处也都收敛到安全口（同一路通道，同样会冷启动未注册）", () => {
    expect(RESIDENT,
      "`act`（定时任务触发/暂停/删除、子代理派发的公共出口）没走安全口 —— "
      + "冷启动窗口内点这些按钮同样会「点了没反应」+ 控制台红字",
    ).toContain("asReply(await tryInvoke(fn))");
    expect(RESIDENT,
      "`clearRuns`（清空子代理历史）没走安全口",
    ).toContain("tryInvoke(() => api.resident?.subagentClear?.())");
    expect(RESIDENT,
      "可派发 Agent 的勾选开关没走安全口",
    ).toContain("tryInvoke(() => api.resident?.subagentSetSelection?.(next))");
  });

  it("T9 【同族·另一处产地】不许把 `.catch` 接在**可选链调用**后面（短路成 undefined ⇒ 同步 TypeError）", () => {
    



    


    const bad = [...RESIDENT.matchAll(/\?\.\([^)]*\)\.catch\(/g)];
    expect(bad.length,
      `ResidentPanel.tsx 有 ${bad.length} 处把 .catch 接在可选链调用之后 —— `
      + "可选链短路时 `.catch` 是在 undefined 上取属性（同步 TypeError 变未捕获 reject）。"
      + "这类调用同样该走 `tryInvoke` 安全口",
    ).toBe(0);
  });
});



describe("A-1100 ③ — ipcSafe 纯逻辑：安全口的每个分支都必须**如实交回**，不许吞成成功", () => {
  it("T10 正常返回 → 原样透传（不改变调用方看到的形状）", async () => {
    expect(await tryInvoke(async () => 42)).toEqual({ ok: true, value: 42 });
  });

  it("T11 通道方法缺失（可选链断在 `undefined`）→ ok:false，且说明「通道不可用」", async () => {
    const r = await tryInvoke(() => undefined);
    expect(r.ok,
      "把「通道不存在」当成成功 = 静默失效：调用方会以为操作做完了",
    ).toBe(false);
    expect(r.ok ? "" : r.error, "错误文案里必须说清是「通道不可用」，否则用户无从判断该重试还是该报 bug")
      .toContain("通道不可用");
  });

  it("T12 reject → ok:false，且 error 是**异常原话**（不许吞成成功、也不许换成「未知」）", async () => {
    const r = await tryInvoke(async () => { throw new Error("No handler registered for 'x'"); });
    expect(r.ok,
      "把 reject 归成成功 = 本仓最忌讳的静默失效（用户以为保存了，其实一个字没写）",
    ).toBe(false);
    expect(r.ok ? "" : r.error,
      "必须交回**异常原话** —— 换成「未知」会让真实原因（No handler registered…）彻底消失",
    ).toBe("No handler registered for 'x'");
  });

  it("T13 `asReply` 两分支：成功透传 value / 失败合成 { ok:false, error }", () => {
    expect(asReply({ ok: true, value: { a: 1 } }),
      "成功分支必须透传主进程的返回体（调用方要读 r.defaultModels / r.cleared 这些字段）",
    ).toEqual({ a: 1 });
    expect(asReply({ ok: false, error: "失败原因" }),
      "失败分支必须保留 error —— 丢了它就退化成「操作失败：未知」",
    ).toEqual({ ok: false, error: "失败原因" });
  });
});
