















import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
const MAIN = read("gui/src/main/index.ts");
const SKILLS = read("core-ts/src/skills.ts");
const lines = MAIN.split(/\r?\n/);


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
    
    expect(MAIN, "超时后必须有后台续探，否则 12 秒才就绪的后端会被永久标 degraded").toMatch(
      /void\s*\(async\s*\(\)\s*=>\s*\{[\s\S]{0,200}?\/health/,
    );
    
    
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
