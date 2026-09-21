/**
 * A-1048 守卫（源码结构性）：**启动时就必须可应答**的两个 IPC 通道不得再被埋进惰性初始化。
 *
 * 用户可见的病灶（每次冷启动刷一屏）：
 *   `Error occurred in handler for 'slime:resident:state': Error: No handler registered`
 *   `Error occurred in handler for 'slime:requests:get': Error: No handler registered`
 *
 * 成因：这两个 `ipcMain.handle` 写在了 `ensureServicesOnce()` 里 —— 渲染层从 `createWindow()`
 * 就开始轮询，而服务初始化要等技能扫描 / scheduler / SILAM 等一串重活（实测好几秒）。
 * 改回"注册在惰性初始化里"**不报错**，只在控制台刷屏 + 启动阶段功能不可用，
 * 所以这条必须钉死：**注册点必须落在 `registerIpcHandlers()`（启动期）里**。
 *
 * 另外两条同源修复一并锁住：
 *   · 后端 10 秒未就绪**不许直接判死**（Windows 上 Python 首次导入常 >10s → 假降级）
 *   · 技能目录缺失只报一次（刷新时刷屏会把真问题淹没）
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
const MAIN = read("gui/src/main/index.ts");
const SKILLS = read("core-ts/src/skills.ts");
const lines = MAIN.split(/\r?\n/);

/** 某行所在的函数：向上找最近的**顶层** `function <name>(` */
function enclosingFunction(lineNo: number): string | null {
  for (let i = lineNo - 1; i >= 0; i--) {
    const m = /^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/.exec(lines[i] ?? "");
    if (m) { return m[1]; }
  }
  return null;
}

function lineOf(needle: string): number {
  const i = lines.findIndex((l) => l.includes(needle));
  expect(i, `源码里找不到：${needle}`).toBeGreaterThan(-1);
  return i;
}

describe("A-1048 ① 两个通道必须注册在启动期（不得回到惰性初始化）", () => {
  for (const ch of ["slime:resident:state", "slime:requests:get", "slime:requests:set"]) {
    it(`\`${ch}\` 只注册一次，且在 \`registerIpcHandlers\` 里（启动期）`, () => {
      const hits = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.includes(`ipcMain.handle("${ch}"`));
      expect(hits.length, `${ch} 注册了 ${hits.length} 次 —— 重复注册会抛 "second handler"`).toBe(1);
      expect(
        enclosingFunction(hits[0]!.i),
        `${ch} 的注册点不在启动期的 registerIpcHandlers 里（回到惰性初始化 = 冷启动刷屏回归）`,
      ).toBe("registerIpcHandlers");
    });
  }

  it("惰性初始化里**只换提供者**，不再注册通道（提供者是那条唯一的可变接线）", () => {
    expect(MAIN).toMatch(/let residentStateProvider:\s*\(\)\s*=>\s*ResidentState/);
    expect(MAIN, "初始化完成后必须把提供者换成真实现").toMatch(/residentStateProvider\s*=\s*\(\)\s*=>\s*\(\{/);
    // 初始态必须是**空态**而不是抛错：渲染层轮询得到空面板，而不是 Error
    expect(MAIN).toMatch(/residentStateProvider[\s\S]{0,120}scheduler:\s*\[\],\s*subagents:\s*\[\]/);
  });

  it("`slime:requests:*` 的实现不再依赖 scheduler / subagent（它只读一个本地 json）", () => {
    const fn = /function readRequests\(\)[\s\S]*?\n\}/.exec(MAIN);
    expect(fn, "找不到模块级 readRequests").not.toBeNull();
    expect(fn![0]).not.toMatch(/scheduler|subagents/);
  });
});

describe("A-1048 ② 后端启动慢不等于起不来（不许一次性判死）", () => {
  it("10 秒未就绪时先报「仍在启动」，且**后台继续探测**", () => {
    expect(MAIN).toContain("后端服务仍在启动（首次导入较慢）");
    // 后台续探：一个自执行的 async 轮询，超时后把状态升回 ready
    expect(MAIN, "超时后必须有后台续探，否则 12 秒才就绪的后端会被永久标 degraded").toMatch(
      /void\s*\(async\s*\(\)\s*=>\s*\{[\s\S]{0,200}?\/health/,
    );
    // ⚠️ 只断言"有续探"太弱：`for (let i = 0; i < 0; i++)` 照样含 /health。
    //    必须把「后台块」和它的**重试次数**绑在一句里锁 —— 0 次 = 等于改回一次性判定。
    const bg = /void\s*\(async\s*\(\)\s*=>\s*\{[\s\S]{0,120}?for\s*\(let i = 0;\s*i < (\d+);\s*i\+\+\)/.exec(MAIN);
    expect(bg, "后台续探块（及其循环次数）没解析出来").not.toBeNull();
    expect(Number(bg![1]), "续探次数太少（0 次 = 没续探；至少要撑过 Python 首次导入）").toBeGreaterThanOrEqual(40);
  });

  it("只有续探也失败**之后**才允许 emit degraded（degraded 必须是终态，不能提前）", () => {
    const slowIdx = lineOf("后端服务仍在启动（首次导入较慢）");
    const degradedIdx = lineOf('phase: "degraded", backendReady: false, message: "后端服务启动超时');
    expect(degradedIdx, "degraded 必须出现在「仍在启动」之后").toBeGreaterThan(slowIdx);
  });
});

describe("A-1048 ③ 技能目录缺失只报一次", () => {
  it("有去重集合，且日志文案标明「只报一次」", () => {
    expect(SKILLS).toMatch(/MISSING_SKILL_DIR_REPORTED/);
    expect(SKILLS).toContain("技能目录不存在（跳过，只报一次）");
    const use = /if\s*\(!MISSING_SKILL_DIR_REPORTED\.has\(root\)\)\s*\{[\s\S]{0,200}?\}/.exec(SKILLS);
    expect(use, "去重必须真的包住 console 调用").not.toBeNull();
    expect(use![0]).toContain("console");
  });
});
