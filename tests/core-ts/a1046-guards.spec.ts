


















import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (name: string): string => readFileSync(resolve(__dirname, name), "utf8");

describe("A-1046 import.spec.ts 不得意外拉起真实 LanceDB（并发超时抖动根因）", () => {
  it("每个 importAgent 调用点都显式注入 rebuild 依赖（默认实现会拉起 297MB 原生模块）", () => {
    const src = read("import.spec.ts");
    const calls = [...src.matchAll(/await\s+importAgent\(/g)];
    
    expect(calls.length, "找不到 importAgent 调用 —— 锚点已漂，守卫在空转").toBeGreaterThanOrEqual(10);
    const stubbed = calls.filter((m) => /rebuild(?:Deps)?\s*:/.test(src.slice(m.index ?? 0, (m.index ?? 0) + 360)));
    expect(
      stubbed.length,
      "有 importAgent 调用没注入 rebuild 依赖 —— 并发下会因加载 297MB 原生模块触发 5s 超时",
    ).toBe(calls.length);
  });

  it("stub 真的会抛（空实现 = 仍然走真实加载，等于没修）", () => {
    const src = read("import.spec.ts");
    const def = /const NO_LANCE_REBUILD[\s\S]*?\n\};/.exec(src);
    expect(def, "找不到 NO_LANCE_REBUILD 定义").not.toBeNull();
    expect(def![0], "注入的 connect 必须抛错 —— 只有抛错才会让 initLancedb 降级、绕过原生加载").toMatch(
      /connect[\s\S]{0,240}?throw/,
    );
  });

  it("stub 真的被用上（定义与使用数量守恒，防「定义了但没人用」）", () => {
    const src = read("import.spec.ts");
    const injected = (src.match(/rebuildDeps:\s*NO_LANCE_REBUILD/g) ?? []).length;
    expect(injected, "NO_LANCE_REBUILD 只定义不使用 = 守卫空转").toBeGreaterThanOrEqual(8);
    
    
    const total = (src.match(/NO_LANCE_REBUILD/g) ?? []).length;
    expect(total, "NO_LANCE_REBUILD 的其它出现位置需要人工核对（定义 + 注入之外不该再有）").toBe(injected + 1);
  });

  it("对照组：memory.spec.ts 确实有一条**故意**跑真实 LanceDB 的用例（所以不能全局关闭加载器）", () => {
    const mem = read("memory.spec.ts");
    expect(
      mem,
      "如果这条用例被删了，应改为全局关闭加载器（本守卫可退化成一行）；在此之前它必须存在",
    ).toContain("真实 LanceDB");
  });
});
