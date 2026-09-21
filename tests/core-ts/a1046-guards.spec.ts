/**
 * A-1046 守卫：core-ts 测试**不许意外拉起真实 LanceDB**（297MB 原生模块）。
 *
 * 病灶（实测可复现）：`import.spec.ts` 的导入用例若不注入重建依赖，就走
 * `defaultRebuildIndexes` → `new MemoryStore({ lancedbEnabled: true })` → `initLancedb()`
 * → `import("@lancedb/lancedb")`。单跑命中 OS 文件缓存只要 663ms；全量并发（120+ 文件抢磁盘）
 * 首个用例跑到 5s 被 vitest 默认超时掐掉 —— 症状是"偶发抖动"，**只在并发时出现**，
 * 极易被误判成"加个超时就行"。
 *
 * 正确做法不是加超时，而是**显式注入 rebuild 依赖**（`rebuildDeps: NO_LANCE_REBUILD`
 * 或自带 `rebuild`）：本 spec 验证的是导入 / 冲突策略 / 资产落盘，与向量重建无关。
 * 这条守卫锁住"每个 importAgent 调用点都注入了依赖"，防止后续新增用例把重活悄悄带回来。
 *
 * ⚠️ 为什么不改成"全局 setup 关掉加载器"（更省事的写法）：
 *   `tests/core-ts/memory.spec.ts` 有一条**故意**跑真实 LanceDB 的用例
 *   （`启用时惰性初始化 + store/recall 全链路（真实 LanceDB…）`，超时 30s）。
 *   全局关掉加载器会把它当场打红。⇒ 粒度必须是**每个 spec 自己声明**；
 *   本守卫的适用范围也就**只在这份 spec 上**成立。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (name: string): string => readFileSync(resolve(__dirname, name), "utf8");

describe("A-1046 import.spec.ts 不得意外拉起真实 LanceDB（并发超时抖动根因）", () => {
  it("每个 importAgent 调用点都显式注入 rebuild 依赖（默认实现会拉起 297MB 原生模块）", () => {
    const src = read("import.spec.ts");
    const calls = [...src.matchAll(/await\s+importAgent\(/g)];
    // 数量守恒：锚点漂了（正则失效）就会一个都匹配不到 → 守卫空转假绿
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
    // 守恒：文件里出现的次数必须正好是「定义 1 处 + 注入 n 处」。多一处（比如被传给了别的参数）
    // 或少一处都说明有漂移，比"≥ 某个魔法数"更能抓住真实的改动。
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
