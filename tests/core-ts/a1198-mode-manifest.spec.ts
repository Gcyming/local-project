/**
 * A-1197 · B3（L4c 阶段机）：`mode` 声明校验的**合法/非法矩阵** + 两层工具校验。
 * 判据（照 a1198-contributes 同款）：每条反例**必须真的被拒**。
 */
import { describe, it, expect } from "vitest";
import { parseModeDecl, validateModeTools, MAX_STAGES } from "../../core-ts/src/plugin/mode.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";

const base = {
  name: "my-pipeline",
  version: "1.0.0",
  description: "演示流水线",
  origin: "user",
  provides: ["mode"],
} as const;

const good = {
  kind: "stages",
  stages: [
    { id: "survey", title: "调研", prompt: "只读调研…", tools: ["file_read", "file_list"], maxRounds: 8, allowSteer: false },
    { id: "plan", title: "方案", prompt: "产出方案…", tools: ["file_write"], maxRounds: 1, requirePrevious: "survey" },
    { id: "verify", title: "验收", prompt: "按方案自检…", tools: ["file_read", "code_check"], maxRounds: 6, requirePrevious: "plan" },
  ],
  maxTotalStages: 8,
};

describe("A-1198-M ① 合法声明通过（含设计里的三段示例）", () => {
  it("三阶段 happy path：字段逐项保留（id/prompt/tools/maxRounds/allowSteer/requirePrevious）", () => {
    const r = parseModeDecl(good, "mode", "user");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode.stages).toHaveLength(3);
      expect(r.mode.stages[0].allowSteer).toBe(false);
      expect(r.mode.stages[1].requirePrevious).toBe("survey");
      expect(r.mode.stages[2].tools).toEqual(["file_read", "code_check"]);
    }
  });

  it("整份清单：provides 含 mode 且 mode 合法 ⇒ 通过并保留 mode 字段", () => {
    const r = parsePluginManifest({ ...base, mode: good });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.mode?.stages).toHaveLength(3);
    }
  });
});

describe("A-1198-M ② 反例矩阵（每条必须被拒——设计点名的五条全在）", () => {
  const reject = (mode: unknown): string[] => {
    const r = parseModeDecl(mode, "mode", "user");
    expect(r.ok, `预期拒绝但被放行：${JSON.stringify(mode)?.slice(0, 120)}`).toBe(false);
    return r.ok ? [] : r.errors;
  };

  it("`requirePrevious` 前向引用 / 自引 / 指向不存在 ⇒ 拒", () => {
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", requirePrevious: "b" }, { id: "b", prompt: "y" }] });
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", requirePrevious: "a" }] });
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", requirePrevious: "ghost" }] });
  });

  it("阶段数 9（超上限）/ 0 ⇒ 拒", () => {
    const nine = { kind: "stages", stages: Array.from({ length: MAX_STAGES + 1 }, (_, i) => ({ id: `s${i}`, prompt: "x" })) };
    reject(nine);
    reject({ kind: "stages", stages: [] });
  });

  it("`prompt` 5000 字 ⇒ 拒（prompt 要进上下文，必须有上限）", () => {
    const errs = reject({ kind: "stages", stages: [{ id: "a", prompt: "x".repeat(5000) }] });
    expect(errs.some((e) => e.includes("过长"))).toBe(true);
  });

  it("`origin: builtin` 带 mode ⇒ 拒（内置运行器不走插件路径）", () => {
    const r = parseModeDecl(good, "mode", "builtin");
    expect(r.ok).toBe(false);
  });

  it("`maxRounds` 5000 / 0 / 非整数 ⇒ 拒（硬上限 ≤500）", () => {
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", maxRounds: 5000 }] });
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", maxRounds: 0 }] });
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", maxRounds: 1.5 }] });
  });

  it("阶段 `id` 重复 / 非法（大写、空）/ `tools` 重复名或非法名 / 未知字段 ⇒ 拒", () => {
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x" }, { id: "a", prompt: "y" }] });
    reject({ kind: "stages", stages: [{ id: "A", prompt: "x" }] });
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", tools: ["file_read", "file_read"] }] });
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", tools: ["File Read!"] }] });
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", evil: true }] });
    reject({ kind: "stages", stages: [{ id: "a", prompt: "x", script: "evil.mjs" }] });
  });

  it("`kind` 不认识 / 缺 `stages` ⇒ 拒", () => {
    reject({ kind: "workflow", stages: [{ id: "a", prompt: "x" }] });
    reject({ kind: "stages" });
  });
});

describe("A-1198-M ③ 整份清单自洽（provides ⇔ mode 字段）", () => {
  it("有 mode 字段但 provides 未含 \"mode\" ⇒ 拒；有 \"mode\" 但缺 mode 字段 ⇒ 拒", () => {
    const r1 = parsePluginManifest({ ...base, provides: ["instructions"], mode: good });
    expect(r1.ok).toBe(false);
    const r2 = parsePluginManifest({ ...base, mode: undefined });
    expect(r2.ok).toBe(false);
    if (!r2.ok) { expect(r2.errors.join()).toContain("mode"); }
  });
});

describe("A-1198-M ④ 第二层：工具存在性校验（装载时查一次 / 运行前重查）", () => {
  it("`validateModeTools` 全量返回**不存在**的工具名（查不到 ⇒ 装配侧拒绝/跳过）", () => {
    const parsed = parseModeDecl(good, "mode", "user");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) { return; }
    const has = new Set(["file_read", "file_list", "file_write"]);   // 缺 code_check
    expect(validateModeTools(parsed.mode, (n) => has.has(n))).toEqual(["code_check"]);
    const all = new Set(["file_read", "file_list", "file_write", "code_check"]);
    expect(validateModeTools(parsed.mode, (n) => all.has(n))).toEqual([]);
  });
});
