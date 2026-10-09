/**
 * tests/core-ts/a1197-denial-text.spec.ts — 「执行层实际返回的那条拒绝文案」的守卫
 *
 * ## 要防的缺陷（explainDenial 漏了一条分支）
 *   explainDenial(reason) 只有两条分支覆盖写入拒绝：
 *     · /受保护源码目录禁止写入/  ← core-ts/src/tools/hard_rules.ts:65
 *     · /敏感文件禁止写入/          ← core-ts/src/tools/classifier.ts:222
 *   但**执行层真正回给模型的那一句**是 core-ts/src/tools/builtin.ts:348/508 的
 *     `[错误] 敏感文件/目录禁止写入: ${path}`
 *   口径是「敏感文件 + 目录」（不是「敏感文件」）—— 上面两条正则都匹配不上 ⇒
 *   落到函数末尾的**通用兜底**，而兜底是 `hard: false` +「尝试其它方案」。
 *   ⇒ 对一个**不可审批的硬规则**说「可以换个做法」，是**误导**：模型会改写法反复重试同一个目标，
 *      聊天里于是又刷出同一句「被拒绝」（与本轮修的 ②③ 同一个毛病换了形态）。
 *
 * ## 为什么用**行为断言**而不是形状断言
 *   explainDenial 是**纯函数**（依赖只有 classifier/grant/hard_rules 三个纯模块），
 *   vitest 能直接 import —— 于是「直接调用、断言返回值」比「正则扫源码形状」强得多：
 *     · 形状断言只能证明「有一行正则写着 /敏感文件\/目录禁止写入/」，
 *       证明不了它**排在通用兜底之前**（顺序错了照样漏判，而那正是这个缺陷本身）；
 *     · 也证明不了「返回的 advice 不是那句通用兜底」。
 *   ⇒ 本文件全部走行为断言；形状正则只在「兜底文案不许被复制进硬规则分支」这一条上做补充。
 *
 * ## 断言分三组（对应任务书 ①②③）
 *   A. 执行层文案（「敏感文件/目录禁止写入」）判为hard: true，且给出的不是通用兜底
 *   B. 既有两条分支未被改坏（回归）
 *   C. 未知/空原因仍返回非空指引（防静默失效 —— 通用兜底不许被删空）
 *
 * ⚠️ 词边界（本项目铁律，改断言前先读）：
 *   ① 「不可重试」必须用**带词边界的判据**钉在 hard 分支的 advice 上：
 *      只判 advice 里出现「重试」两个字是不够的 —— 硬规则文案里恰恰**应该**出现
 *      「不要换个写法重试同一个目标」（禁的是重试，不是重试这个词）。
 *   ② 判「不是通用兜底」不能只比长度/首句，要**直接与兜底返回值比不等**：
 *      否则把兜底那句复制到硬规则分支里（长度一样、开头一样）也能判绿。
 *   ③ 反向断言不许只判短词：「不要」是「不要重试」的子串，用它等于没判。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { explainDenial } from "../../core-ts/src/tools/policy.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 执行层（core-ts/src/tools/builtin.ts）file_write / file_edit 真正回给模型的那一句。 */
const EXEC_TEXT = "[错误] 敏感文件/目录禁止写入: config/agents.json";
/** 一条**没有任何**已知特征的未知原因 ⇒ 必须落通用兜底。 */
const UNKNOWN = "some-transport-failure: 握手超时";

/** 通用兜底的返回值（拿来做「不是兜底」的判据，见文件头②）。 */
const fallback = (reason: string) => explainDenial(reason);

describe("A-1197 拒绝文案 ① 执行层实际返回的那句必须判为硬规则", () => {
  it("A1 「敏感文件/目录禁止写入」判为 hard: true", () => {
    expect(explainDenial(EXEC_TEXT).hard).toBe(true);
  });

  it("A2 给出的指引不是那句通用兜底（兜底是 hard:false +「尝试其它方案」，对硬规则是误导）", () => {
    const a = explainDenial(EXEC_TEXT);
    expect(a.advice).not.toBe(fallback(UNKNOWN).advice);
    expect(a.advice).not.toContain("尝试其它方案");
  });

  it("A3 文案说清三件事：硬规则放行不了 / 不许换写法重试同一目标 / 给出可执行的正路", () => {
    const a = explainDenial(EXEC_TEXT);
    /* ⚠️ 词边界（文件头①）：禁的是「重试同一个目标」这件事，
     * 所以这里要判**整条禁重试句式**在，而不是判「重试」两个字在不在。 */
    expect(a.advice).toMatch(/不要.{0,12}重试同一个目标|不要换个写法重试/);
    expect(a.advice).toMatch(/硬规则/);
    expect(a.advice).toMatch(/放行不了|不可审批/);
    /* 正路必须是**动作**（写到哪、怎么写），不是"你自己看着办"。 */
    expect(a.advice).toMatch(/工作目录/);
    expect(a.advice).toMatch(/config\/(skills|plugins)/);
  });

  it("A4 分支必须排在通用兜底之前（顺序错了就是原缺陷：口径不匹配 ⇒ 落兜底）", () => {
    const a = explainDenial(EXEC_TEXT);
    expect(a.hard).toBe(true);
    expect(a.advice).not.toContain("该操作未获授权");
  });

  it("A5 执行层那一句的两种形态都要命中（file_write 与 file_edit 同文案，见 builtin.ts:348/508）", () => {
    for (const p of ["config/agents.json", "core-ts/src/app.ts"]) {
      expect(explainDenial(`[错误] 敏感文件/目录禁止写入: ${p}`).hard, p).toBe(true);
    }
  });

  it("A6 源码里这条正则必须存在且带转义斜杠（形状补充：行为过了不代表锚点没被改名）", () => {
    const policy = readFileSync(join(ROOT, "core-ts", "src", "tools", "policy.ts"), "utf8");
    expect(policy).toContain("/敏感文件\\/目录禁止写入/");
    /* ⚠️ 不许顺手把「目录」去掉凑成 /敏感文件禁止写入/ —— 那样这条分支就与既有那条同键，
     *   行为断言里 A2「不是兜底」仍会绿，但它其实没修好执行层那句（`敏感文件/目录禁止写入`
     *   里根本没有 `敏感文件禁止写入` 这个子串）。 */
    expect(policy).toMatch(/if \(\/敏感文件禁止写入\/\.test\(r\)\)/);
  });
});

describe("A-1197 拒绝文案 ② 既有两条分支未被改坏（回归）", () => {
  it("B1 受保护源码目录仍是 hard: true，且仍禁重试", () => {
    const a = explainDenial("受保护源码目录禁止写入：C:\\slime-data\\gui\\x.ts");
    expect(a.hard).toBe(true);
    expect(a.advice).toMatch(/硬规则/);
    expect(a.advice).toMatch(/不要/);
    expect(a.advice).not.toBe(fallback(UNKNOWN).advice);
  });

  it("B2 敏感文件（分类器口径，无「/目录」）仍是 hard: true，且仍禁绕写", () => {
    const a = explainDenial("敏感文件禁止写入：agents.json");
    expect(a.hard).toBe(true);
    expect(a.advice).toContain("绕");
    expect(a.advice).not.toBe(fallback(UNKNOWN).advice);
  });

  it("B3 新分支不得吃掉既有两条：两条各自的特征句仍在，判定互不串台", () => {
    /* ⚠️ 顺序敏感：若把 /敏感文件\/目录禁止写入/ 之后那两条删掉，或让新分支的
     *   正则宽到能匹配「敏感文件禁止写入」，A1 照样绿而 B2 会红 —— 这条就是拦它的。 */
    expect(explainDenial("敏感文件禁止写入：agents.json").advice).toContain("敏感清单");
    expect(explainDenial("受保护源码目录禁止写入：x").advice).toContain("硬规则");
    // 反向：既有两条**不该**被新分支的文案接走
    expect(explainDenial("敏感文件禁止写入：agents.json").advice)
      .not.toContain("config/plugins");
  });

  it("B4 其余既有分支保持原判定（分类器预检=硬、超工作目录=可审批）", () => {
    expect(explainDenial("[分类器预检拦截] file_write: 受保护源码目录禁止写入：xxx").hard).toBe(true);
    const out = explainDenial("目标 'D:/x/y.txt' 超出工作目录范围（需用户确认）");
    expect(out.hard).toBe(false);
    expect(out.advice).toContain("工作目录");
  });
});

describe("A-1197 拒绝文案 ③ 未知原因仍返回非空指引（防静默失效）", () => {
  it("C1 空/未定义原因不许返回空指引（静默失效 = 用户只看得到干巴巴一句「被拒绝」）", () => {
    expect(explainDenial("").advice.length).toBeGreaterThan(10);
    expect(explainDenial(undefined as unknown as string).advice.length).toBeGreaterThan(10);
    expect(explainDenial(null as unknown as string).advice.length).toBeGreaterThan(10);
  });

  it("C2 未知原因落兜底且仍是非空指引", () => {
    const a = fallback(UNKNOWN);
    expect(a.advice.length).toBeGreaterThan(10);
    expect(a.hard).toBe(false);
  });

  it("C3 每一条已知分支都必须给出**非空**指引（逐条扫，不许有一条空串）", () => {
    const reasons = [
      EXEC_TEXT,
      "受保护源码目录禁止写入：x",
      "敏感文件禁止写入：agents.json",
      "[分类器预检拦截] file_write: xxx",
      "目标 'D:/x/y.txt' 超出工作目录范围（需用户确认）",
      "操作 'write' (L2) 被禁止",
      "需要用户确认",
      "超时（未收到用户决策）",
      UNKNOWN,
      "",
    ];
    for (const r of reasons) {
      expect(explainDenial(r).advice.trim().length, JSON.stringify(r)).toBeGreaterThan(10);
    }
  });
});
