/**
 * tests/core-ts/providers-pricing.spec.ts — 定价链路回归测试（A-9xx 定价事故复盘）。
 *
 * 事故现象：`config/usage.jsonl` 1606 条记录 **100% 成本为 0**（总消耗 $0.0000），其中包含
 * 27.1M tokens 的 `deepseek-flash`、19.5M 的 `agnes-3.0-flash`、527K 的 `小红书::dots3-note-prev`。
 * 根因是三处同时失守，本文件逐条锁死：
 *   ① 内置价目表缺失/单位错（美元价又除了一次 7.25）、正则漏匹配（deepseek-flash 不命中）；
 *   ② 上游探针"命中第一个 200 就 return"，导致 `/api/pricing` 永远执行不到（两阶段修复）；
 *   ③ 历史脏值（`price_source === undefined`）压住新表，形成「错值自杀锁」。
 *
 * 这些函数此前**完全无单测覆盖**，是本次事故能潜伏一整个版本的原因之一。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  inferPricingFromUrl,
  makePriceResolver,
  mergeModelPrice,
  overridesToPriceTiers,
  parseContextTiers,
  parsePricingOverrides,
  parseUpstreamModelItems,
  probeUpstreamTwoPhase,
  newApiConfigMap,
  resolvePrice,
  type ProvidersTable,
} from "../../gui/src/main/providers.js";
import {
  inferModelPricing, resolveEffectivePricing, snapshotVetoReason,
  pricingSnapshotMeta, snapshotPricingInfo, builtInFlatPricing, builtInPriceTiers,
  resolveModelPriceTier,
  USD_CNY_RATE, cnyToUsd, formatPricingAmounts,
  // A-990「以模型所属地决定币种 + 金额尽量靠近整数」
  vendorRegion, currencyOfRegion, displayCurrencyForModel, convertFromUsd, formatMoney,
  // A-990-B「用户手选币种」
  pricingDisplayCurrency, officialPriceCurrency, formatAmountsInCurrency, toUsdAmount, formatAmount,
  // A-990-C/E/F：单价框原生列优先 · 探针诊断 · 国内厂商官方人民币价
  amountInCurrency, classifyProbeOutcome, PROBE_OUTCOME_HINT, inferModelCapabilities,
  // A-990-G：全表时效性守卫
  MODEL_CAPABILITIES, PRICING_VERIFIED_AT, pricingVerifiedAtUnknown,
  // A-990-H：家族正则 vs 精确 id
  pricingMatchKind,
} from "../../shared/gen/model-capabilities.js";
import { PRICING_SNAPSHOT } from "../../shared/gen/pricing-snapshot.js";
// A-990-B：账目币种判定已抽成纯模块（不在 .tsx 里）—— 测试无需 import 任何 React 组件
import { ledgerCurrencyOf } from "../../gui/src/renderer/pages/usageCurrency.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { listProviders, saveProvider, setRootOverrideForTest as setProvRoot } from "../../gui/src/main/providers.js";

describe("inferModelPricing（内置家族价目表，单一真相源）", () => {
  it("命中已核实刊例价：DeepSeek pro/flash 都在表内", () => {
    // 平铺字段 = **高峰标准价**（真实存在的档位；分时档位见 priceTiers / pricing-tiers.spec.ts）。
    // 这里**曾经**是峰谷均值（0.99/2.97、0.225/0.9）—— 均值在任何真实时段都不存在，已废弃。
    const pro = inferModelPricing("deepseek-v4-pro");
    expect(pro.priceIn).toBeCloseTo(1.32, 6);
    expect(pro.priceOut).toBeCloseTo(3.96, 6);
    // 回归：旧正则只匹配 chat|reasoner|v4，`deepseek-flash` 完全不命中 → 直接无价
    const flash = inferModelPricing("deepseek-flash");
    expect(flash.priceIn).toBeCloseTo(0.3, 6);
    expect(flash.priceOut).toBeCloseTo(1.2, 6);
  });

  it("回归：DeepSeek 价格不得再被汇率除一次（0.14/7.25 = 0.0193 是历史脏值）", () => {
    const p = inferModelPricing("deepseek-v4-pro");
    expect(p.priceIn!).toBeGreaterThan(0.5); // 曾被写成 0.0193
  });

  it("Claude 按档位分档（opus / haiku / sonnet 不同价）", () => {
    // 旧代：Opus 4 / 4.1 = $15/$75（保留，仍在售）
    expect(inferModelPricing("claude-opus-4-1").priceIn).toBeCloseTo(15, 6);
    // 旧代 Haiku 3 / 3.5 = $0.80/$4
    expect(inferModelPricing("claude-3-5-haiku").priceIn).toBeCloseTo(0.8, 6);
    // 当前代：Haiku 4.5 = $1/$5、Sonnet（3.5~4.6）= $3/$15
    expect(inferModelPricing("claude-haiku-4-5").priceIn).toBeCloseTo(1, 6);
    expect(inferModelPricing("claude-haiku-4-5").priceOut).toBeCloseTo(5, 6);
    expect(inferModelPricing("claude-sonnet-4-20250514").priceIn).toBeCloseTo(3, 6);
    // A-989 修正的核心：Opus 4.5+ 是 $5/$25，此前被并进 `claude.*opus` 按 $15/$75 计 —— 高估 3 倍
    expect(inferModelPricing("claude-opus-4-6").priceIn).toBeCloseTo(5, 6);
    expect(inferModelPricing("claude-opus-4-6").priceOut).toBeCloseTo(25, 6);
    // Sonnet 5 = $2/$10（比 4.x 便宜，必须按代拆开）
    expect(inferModelPricing("claude-sonnet-5").priceIn).toBeCloseTo(2, 6);
  });

  it("回归：agnes 免费档只覆盖 flash，付费档不能被写成 0", () => {
    // 旧实现把**所有** Agnes 硬编码成 {0,0}，agnes-2.5-pro 的真实消耗被吞掉
    const pro = inferModelPricing("agnes-2.5-pro");
    expect(pro.priceIn).toBeCloseTo(0.45, 6);
    expect(pro.priceOut).toBeCloseTo(0.9, 6);
    const beta = inferModelPricing("agnes-2.5-pro-beta");
    expect(beta.priceIn).toBeCloseTo(0.1, 6);
    // 免费 flash 档必须命中 `agnes` 兜底 → 显式 0（免费是**正确结果**，不是"没价"）
    const flash = inferModelPricing("agnes-3.0-flash");
    expect(flash.priceIn).toBe(0);
    expect(flash.priceOut).toBe(0);
  });

  it("回归：GLM **免费档三兄弟**必须各自成条，且排在宽泛的付费条目之前", () => {
    // 官方文档 free 目录（/cn/guide/models/free/）明示三档永久免费：
    //   GLM-4.5-Flash（2026-01-30 起下线、请求路由到 4.7-Flash）、GLM-4.7-Flash、GLM-4.6V-Flash。
    // 本用例曾把免费档错记成 `glm-5.3-flash` —— 而官方实录是：5.3-Flash 是**付费**档
    // （¥0.8/¥2.8，海外站 $0.15/$0.50），免费的是 4.7-Flash。此处按官方事实锁定。
    for (const id of ["glm-4-flash", "glm-4.5-flash", "glm-4.7-flash", "glm-4.6v-flash"]) {
      const p = inferModelPricing(id);
      // 0 = 官方免费（正确结果），undefined = 未定价 —— 二者必须区分
      expect(p.priceIn, id).toBe(0);
      expect(p.priceOut, id).toBe(0);
    }
    // 付费 Flash 档绝不能被"通配归零"：这是 14 条错价里危害最大的那类（静默 100% 少计）
    const flashx = inferModelPricing("glm-4.7-flashx");
    expect(flashx.priceInCny).toBe(0.5);
    expect(flashx.priceOutCny).toBe(3);
    const paid53 = inferModelPricing("glm-5.3-flash");
    expect(paid53.priceInCny).toBe(0.8);
    expect(paid53.priceOutCny).toBe(2.8);
    expect(paid53.priceIn).toBeGreaterThan(0);
  });

  it("GLM 价格以**官方人民币原价**存放，USD 是折算值（$ 与 ¥ 分开）", () => {
    const p = inferModelPricing("glm-5.3");
    // 官方国内站刊例：¥8 输入 / ¥28 输出 / 缓存命中 ¥2（open.bigmodel.cn/pricing）
    expect(p.priceInCny).toBe(8);
    expect(p.priceOutCny).toBe(28);
    expect(p.priceCacheReadCny).toBe(2);
    // USD 是**折算**来的，不是官方美元价 → 必须落在 USD 字段并带 derived 标记
    expect(p.priceIn).toBeCloseTo(cnyToUsd(8), 9);
    expect(p.priceOut).toBeCloseTo(cnyToUsd(28), 9);
    expect(p.usdDerivedFromCny).toBe(true);
    // 海外站 z.ai 官方美元价是 $1.4/$4.4 —— 与折算值**不相等**（官方明示非等比换算）。
    // 本用例把"折算值 ≠ 官方美元价"钉死，防止将来有人"按汇率把两边校正成一致"。
    expect(p.priceIn).not.toBeCloseTo(1.4, 2);
  });

  it("$ 与 ¥ 的展示必须分开：官方人民币原价为主，折算值必须带 ≈", () => {
    // 有官方人民币价 → 以 ¥ 为主，USD 是折算值 → 显示 ≈$
    const glm = formatPricingAmounts(inferModelPricing("glm-5.3"));
    expect(glm).toContain("¥8 / ¥28");
    expect(glm).toContain("≈$");
    // 只有官方美元价（OpenAI / DeepSeek）→ 直接显示 $，**不得**凭空补一个 ¥（那是反方向的口径混用）
    const gpt = formatPricingAmounts(inferModelPricing("gpt-4o"));
    expect(gpt?.startsWith("$")).toBe(true);
    expect(gpt).not.toContain("¥");
    expect(inferModelPricing("gpt-4o").priceInCny).toBeUndefined();
    expect(inferModelPricing("gpt-4o").usdDerivedFromCny).toBeUndefined();
    // 免费档：人民币原价 0 也要能显示（0 ≠ 未定价）
    expect(formatPricingAmounts(inferModelPricing("glm-4.7-flash"))).toContain("¥0");
  });

  it("折算率只有一个出处：USD_CNY_RATE，且任何带 ¥ 原价的条目都必须精确等于它的折算", () => {
    // 这条不变量锁死"换算散落在各条目里"的历史事故（deepseek 美元价被当人民币又除一次 7.25）。
    // 凡是登记了人民币原价的条目，其 USD 值必须**恰好**是 cnyToUsd(原价)，不允许出现手写近似值。
    expect(USD_CNY_RATE).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5", "glm-5.1", "glm-4.7", "glm-4.7-flashx", "glm-4.5-air", "glm-4.6v"]) {
      const p = inferModelPricing(id);
      if (p.priceInCny === undefined) { bad.push(`${id}: 缺 priceInCny`); continue; }
      if (p.priceIn !== cnyToUsd(p.priceInCny)) { bad.push(`${id}: priceIn ${p.priceIn} ≠ ${cnyToUsd(p.priceInCny)}`); }
      if (p.usdDerivedFromCny !== true) { bad.push(`${id}: 未标记 usdDerivedFromCny`); }
    }
    expect(bad).toEqual([]);
  });

  it("DeepSeek：官方同时公布 $ 与 ¥ 两列 → 两列都存，**不得**互相折算（美元列是官方价）", () => {
    // api-docs.deepseek.com 中英两页货币不同，但**两列都是官方价**（非汇率换算）。
    // 所以这里美元与人民币必须各就各位，且 `usdDerivedFromCny` **不能**置位 ——
    // 一置位界面就会给官方美元价加 `≈`，等于把官方价降级成"我们换算的近似值"。
    const pro = inferModelPricing("deepseek-v4-pro");
    expect(pro.priceIn).toBeCloseTo(1.32, 9);
    expect(pro.priceInCny).toBe(9);
    expect(pro.priceOutCny).toBe(27);
    expect(pro.priceCacheReadCny).toBe(0.3);
    expect(pro.usdDerivedFromCny).toBeUndefined();
    // 人民币列 ÷7.2 ≈ $1.25 ≠ 官方美元价 $1.32 → 恰好证明"两列不是汇率关系"
    expect(pro.priceIn).not.toBeCloseTo(cnyToUsd(9), 2);
    // 无时刻信息 → 兜底取高峰档，$/¥ 两列都要在
    const peak = resolveModelPriceTier("deepseek-flash");
    expect(peak.pricing.priceIn).toBeCloseTo(0.3, 9);
    expect(peak.pricing.priceInCny).toBe(2);
    expect(peak.pricing.priceOutCny).toBe(8);
  });

  it("DeepSeek V4 Pro 必须保持**自己的档位价**：官方已撤回\"Pro 路由到 Flash 计费\"的公告", () => {
    // 2026-09-10 发布公告曾说 9-14 起 deepseek-v4-pro 路由到 V4.1-Flash 并按 Flash 价计费；
    // **该公告随后被官方撤回**，现行定价页明示 Pro 继续在售、计费方式不变（高峰 $1.32/$3.96）。
    // 这条用例存在的唯一目的：防止有人看了那条过时公告，把 Pro 压成 Flash 价（会低估 4.4 倍）。
    const peak = resolveModelPriceTier("deepseek-v4-pro", new Date("2026-09-16T02:30:00Z")); // 北京 10:30 = 高峰
    expect(peak.tierId).toBe("peak");
    expect(peak.pricing.priceIn).toBeCloseTo(1.32, 9);
    expect(peak.pricing.priceOut).toBeCloseTo(3.96, 9);
    const flashAtSameMoment = resolveModelPriceTier("deepseek-flash", new Date("2026-09-16T02:30:00Z"));
    expect(peak.pricing.priceIn).toBeGreaterThan(flashAtSameMoment.pricing.priceIn!);
  });

  /* ═══════ DeepSeek V4.1-Flash：钉死"退休模型的价不许写进来"（2026-09-18 险情） ═══════
   *
   * 险情复盘：本次复核时搜到一份"V4-Flash 新价 PEAK $0.44 / cache-hit $0.014"，
   * 差点据此把 Flash 从 `$0.3/$1.2` 改成 `$0.44/$1.32`（**+47%**）。
   * 那份价属于 **`deepseek-v4-flash`（0731 版，已退休）** 在 2026-08-16 的调价；
   * 而现行 `deepseek-flash` 是 **DeepSeek-V4.1-Flash**，于 **2026-09-10 12:00** 上线并**降价**。
   *
   * 官方 `api-docs.deepseek.com/quick_start/pricing` 现行表（脚注 3）：
   *   MODEL/VERSION: deepseek-flash = DeepSeek-V4.1-Flash；deepseek-v4-pro = DeepSeek-V4-Pro-0813
   *   CACHE HIT 闲 $0.003 / 峰 $0.006 ；MISS 闲 $0.15 / 峰 $0.3 ；OUTPUT 闲 $0.6 / 峰 $1.2
   *   Peak hours = 01:00-04:00 与 06:00-10:00 **UTC，周一至周五**（其余为空闲）
   *   官方中文公告（2026-09-10 12:00 生效）人民币表：闲 ¥0.02/¥1/¥4、峰 ¥0.04/¥2/¥8
   * 旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍被接受，但请求由 V4.1-Flash 服务并按 Flash 价计费。
   *
   * 这是本项目那条铁律的又一例：**被覆盖过的公告不是来源**。
   * 同一厂商两个月内出现过三个"Flash"（V4-Flash 0731 → 08-16 涨价 → V4.1-Flash 09-10 降价），
   * 只按"Flash"两个字去搜必然张冠李戴 —— 所以这里把**模型版本名**和**价格**一起钉住。
   */
  it("DeepSeek V4.1-Flash（现行 deepseek-flash）必须是 09-10 之后的降价档，不得写成退休版 V4-Flash 的价", () => {
    const peak = resolveModelPriceTier("deepseek-flash", new Date("2026-09-18T02:00:00Z")); // 北京周五 10:00 = 高峰
    const off = resolveModelPriceTier("deepseek-flash", new Date("2026-09-18T20:00:00Z"));  // 北京周六 04:00 = 空闲
    expect(peak.tierId).toBe("peak");
    expect(off.tierId).toBe("offpeak");
    // 美元列（官方英文页现行值）
    expect(peak.pricing.priceIn).toBeCloseTo(0.3, 9);
    expect(peak.pricing.priceOut).toBeCloseTo(1.2, 9);
    expect(peak.pricing.priceCacheRead).toBeCloseTo(0.006, 9);
    expect(off.pricing.priceIn).toBeCloseTo(0.15, 9);
    expect(off.pricing.priceOut).toBeCloseTo(0.6, 9);
    expect(off.pricing.priceCacheRead).toBeCloseTo(0.003, 9);
    // 人民币列（官方中文公告，**原生**列 —— 所以不得被当成折算值）
    expect(peak.pricing.priceInCny).toBe(2);
    expect(peak.pricing.priceOutCny).toBe(8);
    expect(peak.pricing.priceCacheReadCny).toBeCloseTo(0.04, 9);
    expect(off.pricing.priceInCny).toBe(1);
    expect(off.pricing.priceOutCny).toBe(4);
    // ⚠️ 退休 V4-Flash(0731) 的价（$0.44 / $1.32）**绝不能**出现在 V4.1-Flash 上
    expect(peak.pricing.priceIn).not.toBeCloseTo(0.44, 6);
    expect(peak.pricing.priceOut).not.toBeCloseTo(1.32, 6);
    // 空闲 = 高峰的一半（官方脚注 "Off-peak rates are half of the peak rates"）
    // `?? NaN` 只为消除可选字段的严格判空：真缺值时会以 NaN 失败，不会静默通过
    expect(off.pricing.priceIn).toBeCloseTo((peak.pricing.priceIn ?? NaN) / 2, 12);
    expect(off.pricing.priceOut).toBeCloseTo((peak.pricing.priceOut ?? NaN) / 2, 12);
  });

  it("DeepSeek 高峰窗口 = UTC 01:00-04:00 / 06:00-10:00 的工作日（= 北京 9-12、14-18）", () => {
    // 官方脚注给的是 **UTC** 口径，我们存 `Asia/Shanghai` 的墙上时间 —— 两者必须等价，
    // 且**工作日限定**必须体现（官方 "(all other hours are off-peak)"）。
    const at = (iso: string): string | undefined => resolveModelPriceTier("deepseek-flash", new Date(iso)).tierId;
    expect(at("2026-09-18T01:30:00Z"), "UTC 01:30 = 北京周五 09:30").toBe("peak");
    expect(at("2026-09-18T06:30:00Z"), "UTC 06:30 = 北京周五 14:30").toBe("peak");
    expect(at("2026-09-18T04:30:00Z"), "UTC 04:30 = 北京周五 12:30（午休）").toBe("offpeak");
    expect(at("2026-09-18T10:30:00Z"), "UTC 10:30 = 北京周五 18:30（已过高峰）").toBe("offpeak");
    expect(at("2026-09-19T01:30:00Z"), "同一 UTC 时刻的周六必须空闲").toBe("offpeak");
  });

  it("小红书 dots 为官方限时免费 → 0，不是 undefined", () => {
    const p = inferModelPricing("dots3-note-prev");
    expect(p.priceIn).toBe(0);
    expect(p.priceOut).toBe(0);
  });

  it("未核实刊例价的厂商 → 返回 {}（宁缺勿造，UI 会显示「未定价」让用户手填）", () => {
    // A-989：快照层上线后，kimi / qwen 这类长尾家族已由权威快照补价（见下一个用例），
    // 这里改用**真正没有任何数据**的 id 来验证「未定价」分支仍然存在且不被编造。
    expect(inferModelPricing("zz-unlisted-model-xyz")).toEqual({});
    expect(inferModelPricing("")).toEqual({});
  });

  it("A-989 权威快照：内置表未定价的长尾家族由快照补价（消灭\"用户必须逐个手填\"）", () => {
    // 快照 = LiteLLM 首方刊例价（优先）+ OpenRouter 路由价（补位），离线入库、运行时零网络依赖。
    for (const id of ["kimi-k2", "qwen3.7-max", "glm-5", "minimax-m2.5", "grok-4.5", "mistral-large-latest"]) {
      const p = inferModelPricing(id);
      expect(p.priceIn, id).toBeGreaterThan(0);
      expect(p.priceOut, id).toBeGreaterThan(0);
    }
  });

  it("A-989 快照抑制表：退休别名不得被快照的旧价覆盖（deepseek-chat → 按 V4.1-Flash 价）", () => {
    // 官方 2026 已退休 deepseek-chat / deepseek-reasoner，其请求由 DeepSeek-V4.1-Flash 承接并按 Flash 价计费。
    // 快照里仍留着退休前 $0.28/$0.42（输出低 3 倍）—— 必须被 SNAPSHOT_VETO 挡住。
    for (const id of ["deepseek-chat", "deepseek-reasoner"]) {
      const p = inferModelPricing(id);
      expect(p.priceIn, id).toBeCloseTo(0.3, 9);
      expect(p.priceOut, id).toBeCloseTo(1.2, 9);
    }
    expect(snapshotVetoReason("deepseek-chat")).toBeTruthy();
    expect(snapshotVetoReason("deepseek-v4-flash")).toBeUndefined();
  });

  it("非对话模型（embedding/rerank/图像）不参与 token 定价", () => {
    const p = inferModelPricing("text-embedding-3-large");
    expect(p.priceIn).toBeUndefined();
  });

  it("A-989 手写表与权威快照**不得冲突**（冲突必须先在表里修掉或显式加抑制）", () => {
    // 这条不变量是整个快照层的护栏：手写表是"我们的判断"，快照是"别人的镜像"。
    // 两者对同一个 id 给出**不同的数**时，必然有一边错 —— 而错的那边会被静默用于计费。
    // 实测首轮有 3 条冲突，全部已处理：
    //   · gpt-4o-2024-05-13（表按 $2.5/$10，应为首发 $5/$15）→ 修表
    //   · claude-3-haiku-20240307（表按 3.5 的 $0.80/$4，应为 3 的 $0.25/$1.25）→ 修表
    //   · chatgpt-4o-latest（表对、镜像停在首发价）→ 加 SNAPSHOT_VETO
    // 将来再出现冲突，本用例会红，逼维护者做同样的判断，而不是两边各留一个数字。
    const conflicts: string[] = [];
    for (const e of PRICING_SNAPSHOT) {
      const built = builtInFlatPricing(e.id);
      if (typeof built.priceIn !== "number") { continue; }   // 表里没价 → 快照补位，本就允许
      if (snapshotVetoReason(e.id)) { continue; }            // 显式抑制 → 有意分歧
      // 手写表带**分时档**的模型不参与本对拍：快照是单一数，与"高峰/低谷两档"不是同一种东西，
      // 拿它跟高峰价比等于要求"快照必须正好等于高峰价"，是结构性假冲突（引擎侧见 ③-2 的同一判据）。
      if (builtInPriceTiers(e.id)) { continue; }
      const same = built.priceIn === e.priceIn
        && (built.priceOut ?? built.priceIn) === (e.priceOut ?? e.priceIn);
      if (!same) {
        conflicts.push(`${e.id}: 手写表 ${built.priceIn}/${built.priceOut} vs 快照 ${e.priceIn}/${e.priceOut}`);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("A-989 生效价的 origin 必须自报家门：快照兜底 ≠ 内置表（界面不许撒谎）", () => {
    // 长尾模型（内置表完全没价）走 ③-3 快照补位 → origin 必须是 "snapshot"。
    // 标成 "table" 会让面板显示「内置表」，暗示"slime 维护者核实过"，
    // 而快照是机器同步来的二手镜像价、会滞后 —— 用户据此就不去复核了。
    const eff = resolveEffectivePricing("kimi-k2", "https://api.moonshot.cn/v1");
    expect(eff.origin).toBe("snapshot");
    expect(eff.tiered).toBe(false);
    expect(eff.priceIn).toBeGreaterThan(0);
    // 内置手写表命中且与快照**数值一致** → 仍标 "table"（一手核实价，不该被降级成二手镜像）
    expect(resolveEffectivePricing("claude-opus-4-20250514", "https://api.anthropic.com/v1").origin).toBe("table");
    expect(resolveEffectivePricing("gpt-4o-2024-05-13", "https://api.openai.com/v1").origin).toBe("table");
    // 显式抑制的模型 → 走手写表
    expect(resolveEffectivePricing("chatgpt-4o-latest", "https://api.openai.com/v1").priceIn).toBe(2.5);
    // 有分时规格的模型 → "tier"，快照不得抢走档位判定
    expect(resolveEffectivePricing("deepseek-v4-flash", "https://api.deepseek.com/v1").origin).toBe("table");
    expect(resolveEffectivePricing("deepseek-v4-flash", "https://api.deepseek.com/v1", undefined, new Date("2026-09-16T02:30:00Z")).origin).toBe("tier");
  });

  it("A-989 两处「一个正则表达两代价」的实测错价已修正（权威双源交叉印证）", () => {
    // gpt-4o 有两个价期：2024-05-13 首发 $5/$15；2024-08-06 起（含当前 gpt-4o）$2.5/$10。
    expect(inferModelPricing("gpt-4o-2024-05-13").priceIn).toBeCloseTo(5, 9);
    expect(inferModelPricing("gpt-4o-2024-05-13").priceOut).toBeCloseTo(15, 9);
    expect(inferModelPricing("gpt-4o").priceIn).toBeCloseTo(2.5, 9);
    expect(inferModelPricing("gpt-4o-2024-08-06").priceIn).toBeCloseTo(2.5, 9);
    // Claude 3 Haiku 是 $0.25/$1.25；3.5 Haiku 才是 $0.80/$4（此前共用一个通配，差 3 倍）
    expect(inferModelPricing("claude-3-haiku-20240307").priceIn).toBeCloseTo(0.25, 9);
    expect(inferModelPricing("claude-3-haiku-20240307").priceOut).toBeCloseTo(1.25, 9);
    expect(inferModelPricing("claude-3-5-haiku-20241022").priceIn).toBeCloseTo(0.8, 9);
  });

  it("A-989 快照元信息可读（时效性是底线 → 生成日期必须能被界面取到）", () => {
    const meta = pricingSnapshotMeta();
    expect(meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.count).toBeGreaterThan(100);
    expect(meta.litellmUrl).toContain("litellm");
    expect(meta.openrouterUrl).toContain("openrouter");
  });

  it("A-989 单模型快照详情：出处 / 长上下文分档 / 抑制原因都能拿到", () => {
    const hit = snapshotPricingInfo("claude-sonnet-4-5-20250929")!;
    expect(hit.source).toBe("litellm");
    // 上下文分档：≥200K 后另计价（Sonnet 4.5 起官方涨价 2 倍）
    expect(hit.contextTiers?.length).toBeGreaterThan(0);
    expect(hit.contextTiers![0].fromInputTokens).toBeGreaterThanOrEqual(200000);
    expect(hit.vetoReason).toBeUndefined();
    // 只存在于"未来日期戳"时靠 token 边界前缀命中最长的那条（不是首个前缀）
    expect(snapshotPricingInfo("claude-sonnet-4-5-20991231")!.snapshotId).toBe("claude-sonnet-4-5");
    // 被抑制的模型：价还在，但必须带上"为什么不采用"的理由，否则面板只能干瞪眼
    const vetoed = snapshotPricingInfo("deepseek-chat")!;
    expect(vetoed.vetoReason).toBeTruthy();
    // 快照里完全没有的 id → undefined（面板据此不显示这一行）
    expect(snapshotPricingInfo("zz-unlisted-model-xyz")).toBeUndefined();
  });
});

describe("resolvePrice（优先级：手填 > 上游 > 内置表 > 历史残留）", () => {
  it("手填价永不被覆盖", () => {
    expect(resolvePrice(7, true, 1, 2)).toEqual({ value: 7, source: "manual" });
  });

  it("上游价次之", () => {
    expect(resolvePrice(undefined, false, 1.5, 2)).toEqual({ value: 1.5, source: "upstream" });
  });

  it("上游显式给 0 = 官方声明免费，必须采纳（不得回落到内置表非零价）", () => {
    // ⚠️ 本条此前断言 `{ value: 2, source: "table" }`（上游 0 被丢弃 → 按表价收费），
    //    **那是错的**：0 是上游权威的"免费"声明，不是缺失。依据三条：
    //      · OpenRouter 官方模型列表：pricing 各字段 "A value of `"0"` indicates the
    //        feature is free"；字段不存在才用省略表达（缺失 ≠ 0）
    //      · Google AIP-149：需要区分"有意义的 0"与"未设置"时**必须**做 presence tracking
    //      · 本仓库另外三处同源实现（parseUsdPerMillion / mergeModelPrice / inferPricingFromUrl）
    //    旧期望的方向是**给免费模型凭空计费**（高估），与"免费档被付费档吃掉"同族。
    //    想表达"上游没给价"必须是 undefined，不能填 0。
    expect(resolvePrice(undefined, false, 0, 2)).toEqual({ value: 0, source: "upstream" });
    // 与 mergeModelPrice 的 ② 条保持一致：0 与非 0 走**同一个**"上游说了算"分支
    expect(resolvePrice(undefined, false, 0, undefined)).toEqual({ value: 0, source: "upstream" });
    // 而"上游没给"（undefined）才回落到内置表 —— 两种情况必须给出不同结果
    expect(resolvePrice(undefined, false, undefined, 2)).toEqual({ value: 2, source: "table" });
  });

  it("上游 0 也不能被内置表压成非零（本地端点场景：http://127.0.0.1 别名到官方模型名）", () => {
    // 实测形态：deepseek-chat 指向本地 llama.cpp，上游声明 0；若不采纳，
    // 会落到内置表的 DeepSeek 官方价 → 本地零成本推理被记成真金白银的账。
    expect(resolvePrice(undefined, false, 0, 1.32).value).toBe(0);
    expect(resolvePrice(0.0193, false, 0, 1.32)).toEqual({ value: 0, source: "upstream" });
  });

  it("上游给 0 也**不能**压过手填价（手填仍是最高优先级）", () => {
    expect(resolvePrice(5, true, 0, 2)).toEqual({ value: 5, source: "manual" });
  });

  it("两种 0 必须分开对待 —— 这是「改 resolvePrice 到底安不安全」的判据", () => {
    /*
     * 历史上有人担心 `resolvePrice` 接受 0 会让坏配置把账单算成 $0。那个担心针对的是
     * **倍率型 0**（new-api `model_ratio`），而它根本走不到这里：倍率解析层已经把它滤掉了
     * （`r <= 0 → continue`，理由见 providers.ts 那段"基数倍率 new-api 自己就拒绝存 0"）。
     * 所以到达 resolvePrice 的 0 只可能是**绝对价型 0**（OpenRouter `pricing.prompt: "0"`），
     * 那是官方显式声明的免费。两条路径的 0 语义完全不同，不能一刀切。
     */
    // ① 倍率型 0 → 解析阶段就跳过该模型（表里根本没有它）
    const m = newApiConfigMap({ model_ratio: { broken: 0, ok: 1.25 } });
    expect(m.get("broken"), "model_ratio=0 的条目必须被跳过，不得变成价格 0").toBeUndefined();
    // 1 倍率 = $2/1M（源码常量 USD=500 → $0.002/1K）
    expect(m.get("ok")?.pricing?.prompt).toBe(2.5);
    // 于是"坏的 0"到不了上层 → 上游字段是 undefined → 正当回落到内置表（**不是**免费）
    expect(resolvePrice(undefined, false, m.get("broken")?.pricing?.prompt, 2))
      .toEqual({ value: 2, source: "table" });

    // ② 绝对价型 0 → 官方显式免费，原样采纳（这正是本次修改带来的行为）
    expect(resolvePrice(undefined, false, 0, 2)).toEqual({ value: 0, source: "upstream" });
  });

  it("内置表再次（含 0 = 免费）", () => {
    expect(resolvePrice(undefined, false, undefined, 0)).toEqual({ value: 0, source: "table" });
  });

  it("历史残留垫底：打破「错值自杀锁」——新表有价时必须压过已存的脏值", () => {
    // 旧配置里躺着 0.0193，若让"已有值"优先，刷新多少次都改不动
    expect(resolvePrice(0.0193, false, undefined, 1.32)).toEqual({ value: 1.32, source: "table" });
    // 但表里也没有价时，至少不丢用户数据
    expect(resolvePrice(0.0193, false, undefined, undefined)).toEqual({ value: 0.0193, source: undefined });
  });

  it("全空 → {}", () => {
    expect(resolvePrice(undefined, false, undefined, undefined)).toEqual({});
  });
});

describe("mergeModelPrice（一键刷新时保护手填价）", () => {
  it("prev 是手填 → 整组保留 prev，探测结果被丢弃", () => {
    const prev = { price_in_usd: 7, price_out_usd: 8, price_source: "manual" as const };
    const out = mergeModelPrice(prev, { price_in_usd: 1, price_out_usd: 2, price_source: "table" as const });
    expect(out.price_in_usd).toBe(7);
    expect(out.price_out_usd).toBe(8);
    expect(out.price_source).toBe("manual");
  });

  it("回归：探测到 0（官方限时免费）必须覆盖旧的非零价，不能把 0 当「没有值」", () => {
    // 旧逻辑 `next.x || prev.x` 会把 0 吞掉 → 给免费模型凭空计费
    const prev = { price_in_usd: 3, price_out_usd: 15, price_source: "table" as const };
    const out = mergeModelPrice(prev, { price_in_usd: 0, price_out_usd: 0, price_source: "upstream" as const });
    expect(out.price_in_usd).toBe(0);
    expect(out.price_out_usd).toBe(0);
    expect(out.price_source).toBe("upstream");
  });

  it("探测没给值 → 保留旧值，不丢用户数据", () => {
    const prev = { price_in_usd: 3, price_out_usd: undefined, price_source: "table" as const };
    const out = mergeModelPrice(prev, { price_in_usd: undefined, price_out_usd: 15 });
    expect(out.price_in_usd).toBe(3);
    expect(out.price_out_usd).toBe(15);
    expect(out.price_source).toBe("table");
  });

  it("无 prev（首次保存）→ 原样采用 next", () => {
    const out = mergeModelPrice(undefined, { price_in_usd: 1, price_out_usd: 2, price_source: "table" });
    expect(out).toEqual({ price_in_usd: 1, price_out_usd: 2, price_source: "table" });
  });
});

describe("inferPricingFromUrl（本地端点免费 + 委托内置表）", () => {
  it("本地 / 内网推理端点 → 显式 0（免费而非未定价）", () => {
    expect(inferPricingFromUrl("http://localhost:11434/v1", "any-model").price_in_usd).toBe(0);
    expect(inferPricingFromUrl("http://127.0.0.1:8080", "any-model").price_in_usd).toBe(0);
    expect(inferPricingFromUrl("http://192.168.1.20:8000/v1", "any-model").price_in_usd).toBe(0);
  });

  it("回归：任意自建网关/中转站不再一律无价（旧表只认十几个域名）", () => {
    const t = inferPricingFromUrl("https://my-private-gateway.example.com/v1", "deepseek-flash");
    expect(t.price_in_usd).toBeCloseTo(0.3, 6); // 高峰标准价（不传时刻 → 不猜档位）
  });

  it("表里查不到的模型 → undefined（未定价，交给用户手填）", () => {
    const t = inferPricingFromUrl("https://api.moonshot.cn/v1", "zz-unlisted-model-xyz");
    expect(t.price_in_usd).toBeUndefined();
  });

  it("A-989：内置表未定价但快照有价 → 由快照补上（kimi 不再要求用户手填）", () => {
    const t = inferPricingFromUrl("https://api.moonshot.cn/v1", "kimi-k2");
    expect(t.price_in_usd).toBeGreaterThan(0);
    expect(t.price_out_usd).toBeGreaterThan(0);
  });
});

describe("makePriceResolver（历史成本回填的取价器）", () => {
  const table: ProvidersTable = {
    deepseek: {
      api_base: "https://api.deepseek.com",
      api_key: "sk-x",
      models: [
        // 历史脏值：无 price_source，价格是"美元又除了一次 7.25"的产物
        { id: "deepseek-v4-pro", price_in_usd: 0.0193, price_out_usd: 0.0386 },
        // 手填价：必须被采信
        { id: "deepseek-chat", price_in_usd: 9, price_out_usd: 9, price_source: "manual" },
        // 上游结算价：必须被采信
        { id: "deepseek-reasoner", price_in_usd: 4, price_out_usd: 4, price_source: "upstream" },
      ],
    },
    agnes: {
      api_base: "https://api.agnes-ai.cn/v1",
      api_key: "sk-y",
      models: [{ id: "agnes-3.0-flash" }],
    },
    _local_models: { api_base: "", api_key: "", models: [{ id: "local-3b", price_in_usd: 999, price_out_usd: 999 }] },
  };

  it("无 price_source 的历史脏值 → 用修好的内置表纠正，而不是沿用错值", () => {
    const p = makePriceResolver(table)("deepseek", "deepseek-v4-pro");
    expect(p?.priceIn).toBeCloseTo(1.32, 6);
    expect(p?.priceOut).toBeCloseTo(3.96, 6);
  });

  it("手填 / 上游价直接采信（用户议价、网关真实结算价）", () => {
    const resolve = makePriceResolver(table);
    expect(resolve("deepseek", "deepseek-chat")?.priceIn).toBe(9);
    expect(resolve("deepseek", "deepseek-reasoner")?.priceIn).toBe(4);
  });

  it("免费模型 → 返回 0（回填后成本仍为 0，是正确的，不是失败）", () => {
    const p = makePriceResolver(table)("agnes", "agnes-3.0-flash");
    expect(p?.priceIn).toBe(0);
    expect(p?.priceOut).toBe(0);
  });

  it("_local_models 这类元数据键不当供应商处理", () => {
    expect(makePriceResolver(table)("_local_models", "local-3b")).toBeUndefined();
  });

  it("供应商已从表里删除 → 仍按模型 ID 走价目表，历史账目保持可读", () => {
    const p = makePriceResolver(table)("已删除的供应商", "deepseek-flash");
    expect(p?.priceIn).toBeCloseTo(0.3, 6);
  });

  it("彻底查不到（模型不在表也不在价目表）→ undefined，回填跳过", () => {
    expect(makePriceResolver(table)("mystery", "unknown-model-xyz")).toBeUndefined();
  });
});

describe("parseUpstreamModelItems（上游字段名各家不一）", () => {
  it("回归：上下文窗口要读多种字段名（只读 context_length 会让探针整体白跑）", () => {
    const cases: Array<Record<string, unknown>> = [
      { id: "m1", context_length: 512000 },
      { id: "m2", context_window: 512000 },
      { id: "m3", max_context_length: 512000 },
      { id: "m4", context_size: 512000 },
      { id: "m5", max_input_tokens: 512000 },
      { id: "m6", top_provider: { context_length: 512000 } },
      { id: "m7", model_info: { context_length: 512000 } },
    ];
    const map = parseUpstreamModelItems(cases);
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]) {
      expect(map.get(id)?.context_length, `${id} 应解析出 512000`).toBe(512000);
    }
  });

  it("new-api 系用 model_name 而非 id", () => {
    const map = parseUpstreamModelItems([{ model_name: "deepseek-v4-flash", model_ratio: 0.1125 }]);
    expect(map.has("deepseek-v4-flash")).toBe(true);
    // 1 倍率 = $2/1M；completion_ratio 缺省 1 → 同价
    expect(map.get("deepseek-v4-flash")?.pricing?.prompt).toBeCloseTo(0.225, 6);
    expect(map.get("deepseek-v4-flash")?.pricing?.completion).toBeCloseTo(0.225, 6);
  });

  it("quota_type=1（按次计费：图像/音乐/视频）的 model_price 不当 token 价使用", () => {
    const map = parseUpstreamModelItems([{ model_name: "dall-e-3", model_ratio: 0.02, quota_type: 1 }]);
    expect(map.get("dall-e-3")?.pricing).toBeUndefined();
  });

  it("cache_ratio / create_cache_ratio 从 prompt 价派生缓存单价", () => {
    const map = parseUpstreamModelItems([{
      model_name: "m", model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.25, create_cache_ratio: 1.25,
    }]);
    const p = map.get("m")?.pricing;
    expect(p?.prompt).toBeCloseTo(1, 6); // 0.5 × 2
    expect(p?.completion).toBeCloseTo(2, 6);
    expect(p?.promptCacheRead).toBeCloseTo(0.25, 6); // 1 × 0.25
    expect(p?.promptCacheCreate).toBeCloseTo(1.25, 6);
  });
});

describe("A-988d：上游定价字段探针表（覆盖各家厂商的命名）", () => {
  const one = (item: Record<string, unknown>) => parseUpstreamModelItems([item]).get(String(item.id ?? item.model_name))?.pricing;

  it("单位三分法：per-token（×1e6）/ per-1M（直接用）/ auto（值域判定）", () => {
    // 判错单位会整体错 100 万倍 —— 这是 A-970 事故的根因之一。
    expect(one({ id: "a", input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "b", input_cost_per_1m_tokens: 3, output_cost_per_1m_tokens: 15 })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "c", input_cost_per_million_tokens: 3 })?.prompt).toBeCloseTo(3, 9);
    // OpenRouter 形态是 per-token **字符串** → auto 走值域判定（3e-6 < 1e-3）
    expect(one({ id: "d", pricing: { prompt: "0.000003", completion: "0.000015" } })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "d", pricing: { prompt: "0.000003", completion: "0.000015" } })?.completion).toBeCloseTo(15, 9);
    // 已经是 /1M 的裸数字（≥1e-3）不能被再乘一次
    expect(one({ id: "e", input_price: 3 })?.prompt).toBeCloseTo(3, 9);
  });

  it("金额字符串的可读写法也要能读（`$0.000003` / `0.000003 USD`）", () => {
    expect(one({ id: "a", pricing: { prompt: "$0.000003" } })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "b", pricing: { prompt: "0.000003 USD" } })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "c", prompt_price: "$3 /1M" })?.prompt).toBeCloseTo(3, 9);
    // 非数字垃圾 → 当作没给（不得变成 NaN 污染账目）
    expect(one({ id: "d", pricing: { prompt: "免费" } })).toBeUndefined();
  });

  it("0 是「官方限时免费」，必须如实返回 0 而不是被当成没给", () => {
    const p = one({ id: "free", pricing: { prompt: "0", completion: "0" } });
    expect(p?.prompt).toBe(0);
    expect(p?.completion).toBe(0);
  });

  it("缓存命中价：OpenRouter / LiteLLM / 自建三种命名都要读到", () => {
    // 漏一个字段名 = 该家模型缓存部分静默按全价输入计（deepseek 系实测虚高 50 倍）
    expect(one({ id: "a", pricing: { prompt: "0.000003", input_cache_read: "0.0000003" } })?.promptCacheRead).toBeCloseTo(0.3, 9);
    expect(one({ id: "b", pricing: { prompt: "0.000003" }, cache_read_input_token_cost: 0.0000003 })?.promptCacheRead).toBeCloseTo(0.3, 9);
    expect(one({ id: "c", pricing: { prompt: "0.000003" }, cached_input_price: 0.3 })?.promptCacheRead).toBeCloseTo(0.3, 9);
  });

  it("缓存写入价：5 分钟档与 1 小时档必须**分开**（差 1.6 倍，合并会让长 TTL 少记 37%）", () => {
    const p = one({
      id: "a",
      pricing: { prompt: "0.000003", input_cache_write: "0.00000375", input_cache_write_1h: "0.000006" },
    });
    expect(p?.promptCacheCreate).toBeCloseTo(3.75, 9);
    expect(p?.promptCacheWrite1h).toBeCloseTo(6, 9);
    // 上游只给了 1h 档时，5m 档不得被顶替成同一个数
    const only1h = one({ id: "b", pricing: { prompt: "0.000003" }, cache_write_1h_cost: 6 });
    expect(only1h?.promptCacheWrite1h).toBeCloseTo(6, 9);
    expect(only1h?.promptCacheCreate).toBeUndefined();
  });

  it("乘数型缓存字段（new-api/one-api）保留 0（显式「不收费」不得被 `> 0` 过滤掉）", () => {
    const p = one({ model_name: "m", model_ratio: 0.5, cache_ratio: 0.1, create_cache_ratio: 0 });
    expect(p?.prompt).toBeCloseTo(1, 9);
    expect(p?.promptCacheRead).toBeCloseTo(0.1, 9);
    expect(p?.promptCacheCreate).toBe(0);
  });

  it("OpenRouter `pricing.overrides[]` → 采集时段档（含跨午夜与字符串星期）", () => {
    const ov = parsePricingOverrides([
      { utc_start: 1600, utc_end: 600, utc_days: ["Monday", "tue", "WED"], prompt: "0.000001" },
      { min_prompt_tokens: 200000, prompt: "0.000009" },   // 只有 token 门槛 → 是上下文分档，不是时段档
      { prompt: "0.000002" },                              // 既无时段也无门槛 → 整份覆盖，无意义，丢弃
      { utc_start: 900, utc_end: 900, prompt: "0.000003" }, // 空窗口（start==end）→ 永不命中，丢弃
    ])!;
    expect(ov).toHaveLength(2);
    expect(ov[0].utcStart).toBe(16 * 60);
    expect(ov[0].utcEnd).toBe(6 * 60);
    expect(ov[0].utcDays).toEqual([1, 2, 3]);
    expect(ov[0].prompt).toBeCloseTo(1, 9);
    expect(ov[1].minPromptTokens).toBe(200000);
  });

  it("时段字段是 **HHMM**（不是分钟数）：`800` = 08:00，`480` 是「4:80」→ 必须判为非法而丢弃", () => {
    // 这条守的是一个很容易犯的笔误：把「分钟数」当 HHMM 填。`480` 若被当成 4:80 就会
    // 静默产出一个不存在的时刻（或落回"兜到边界"），把整段账单错档。
    const ov = parsePricingOverrides([{ utc_start: 0, utc_end: 800, prompt: "0.000001" }])!;
    expect(ov[0].utcStart).toBe(0);
    expect(ov[0].utcEnd).toBe(8 * 60);
    // 非法 HHMM → 该侧视为"没给"，而不是算出一个荒谬的时刻
    const bad = parsePricingOverrides([{ utc_start: 0, utc_end: 480, prompt: "0.000001" }])!;
    expect(bad[0].utcStart).toBe(0);
    expect(bad[0].utcEnd).toBeUndefined();
    // 字符串写法（"16:00" / "1600"）等价
    expect(parsePricingOverrides([{ utc_start: "16:00", utc_end: "06:00", prompt: "0.000001" }])![0].utcStart).toBe(960);
    expect(parsePricingOverrides([{ utc_start: "1600", utc_end: "0600", prompt: "0.000001" }])![0].utcEnd).toBe(360);
  });

  it("上游时段档转成分时规格：时区标 UTC + 必补兜底档（否则非命中时段会凭空多收）", () => {
    const ov = parsePricingOverrides([{ utc_start: 1600, utc_end: 600, prompt: "0.000001" }])!;
    const spec = overridesToPriceTiers(ov, 3, 15)!;
    expect(spec.timezone).toBe("UTC");
    // 兜底档必须在，且价 = 基准价
    const base = spec.tiers.find((t) => t.id === "base")!;
    expect(base.priceIn).toBe(3);
    expect(base.priceOut).toBe(15);
    expect(base.windows).toEqual([]);
    // 时区语义等价：窗口按 UTC 原样落地，不做 +8 换算
    expect(spec.tiers[0].windows![0].startMin).toBe(16 * 60);
    expect(spec.tiers[0].windows![0].endMin).toBe(6 * 60);
  });

  it("上游时段档可以被用户导入后直接生效（导入 = price_tiers，且立刻参与取价）", () => {
    // utc_start/utc_end 是 HHMM：0 = 00:00，800 = 08:00
    const ov = parsePricingOverrides([{ utc_start: 0, utc_end: 800, prompt: "0.000001" }])!;
    const spec = overridesToPriceTiers(ov, 3, 15)!;
    // UTC 03:00 → 命中低价档
    const hit = resolveEffectivePricing("zz-unknown-model", "https://gw.example.com/v1", { price_tiers: spec }, "2026-09-16T03:00:00Z");
    expect(hit.origin).toBe("customTier");
    expect(hit.priceIn).toBeCloseTo(1, 9);
    // UTC 12:00 → 兜底档（**不是** tiers[0] 那个真实但错误的高价档）
    const miss = resolveEffectivePricing("zz-unknown-model", "https://gw.example.com/v1", { price_tiers: spec }, "2026-09-16T12:00:00Z");
    expect(miss.priceIn).toBe(3);
    // 左闭右开：08:00 整已出窗；00:00 整进窗
    expect(resolveEffectivePricing("zz-unknown-model", "https://gw.example.com/v1", { price_tiers: spec }, "2026-09-16T08:00:00Z").priceIn).toBe(3);
    expect(resolveEffectivePricing("zz-unknown-model", "https://gw.example.com/v1", { price_tiers: spec }, "2026-09-16T00:00:00Z").priceIn).toBe(1);
  });

  it("上下文长度分档：LiteLLM 后缀形态与 one-api 数组形态都要采集到", () => {
    // LiteLLM：字段名自带门槛
    const litellm = parseContextTiers({
      input_cost_per_token_above_200k_tokens: 0.000006,
      output_cost_per_token_above_200k_tokens: 0.000018,
      input_cost_per_1m_tokens_above_128k_tokens: 4,
    })!;
    expect(litellm).toHaveLength(2);
    const t200 = litellm.find((t) => t.fromInputTokens === 200000)!;
    expect(t200.prompt).toBeCloseTo(6, 9);
    expect(t200.completion).toBeCloseTo(18, 9);
    expect(litellm.find((t) => t.fromInputTokens === 128000)!.prompt).toBeCloseTo(4, 9);
    // one-api：数组形态
    const oneApi = parseContextTiers({
      tiers: [{ input_token_threshold: 200000, input_cost_per_million_tokens: 6, output_cost_per_million_tokens: 18 }],
    })!;
    expect(oneApi[0].fromInputTokens).toBe(200000);
    expect(oneApi[0].prompt).toBeCloseTo(6, 9);
    expect(oneApi[0].completion).toBeCloseTo(18, 9);
    // 没有分档信息 → undefined（不编造）
    expect(parseContextTiers({ id: "x" })).toBeUndefined();
  });

  it("按次/按张计费的单价被单独采集（不混进 token 价，但 UI 要能提示）", () => {
    const p = one({ id: "gpt-image", pricing: { prompt: "0.000005", request: "0.04", image: "0.02", web_search: "0.01" } })!;
    expect(p.perRequest?.request).toBeCloseTo(0.04, 9);
    expect(p.perRequest?.image).toBeCloseTo(0.02, 9);
    expect(p.perRequest?.webSearch).toBeCloseTo(0.01, 9);
    // token 价不受影响
    expect(p.prompt).toBeCloseTo(5, 9);
  });

  it("上游折扣字段原样带上（`discount` 是比例，不是单价，绝不能乘进 prompt）", () => {
    const p = one({ id: "a", pricing: { prompt: "0.000003", discount: "0.5" } })!;
    expect(p.discount).toBeCloseTo(0.5, 9);
    expect(p.prompt).toBeCloseTo(3, 9);
  });
});

describe("A-988d 源码守卫：探针采集到的信息必须真的能被看见与使用", () => {
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const readSrc = (rel: string): string => strip(readFileSync(join(process.cwd(), rel), "utf8"));

  it("探针必须走字段表（新增一家厂商 = 追加一行，而不是再拼一条 ?? 链）", () => {
    // 手写 `a ?? b ?? c` 链的失败形态是"某一路忘了乘 1e6"这种不对称，
    // 而且看不出哪些槽位是空的 —— 表能一眼审出覆盖率。
    const src = readSrc("gui/src/main/providers.ts");
    expect(src).toContain("const UPSTREAM_PRICE_FIELDS");
    expect(src).toContain("const CACHE_RATIO_FIELDS");
    expect(src).toContain("function parseUsdPerMillion");
    // 槽位必须齐全：缺 cacheWrite1h 会让 1 小时 TTL 缓存按 5 分钟档少记 37%
    for (const slot of ["prompt", "completion", "cacheRead", "cacheWrite", "cacheWrite1h"]) {
      expect(src, `字段表缺槽位 ${slot}`).toContain(`slot: "${slot}"`);
    }
    // 表驱动主循环必须真的用上这两张表
    expect(src).toContain("for (const f of UPSTREAM_PRICE_FIELDS)");
    expect(src).toContain("for (const f of CACHE_RATIO_FIELDS)");
  });

  it("采集结果必须落库（timeOverrides / contextTiers / perRequest 一个都不能只活在内存里）", () => {
    const src = readSrc("gui/src/main/providers.ts");
    expect(src).toContain("pricing_time_tiers_candidate:");
    expect(src).toContain("pricing_context_tiers:");
    expect(src).toContain("pricing_per_request:");
    // 时段档候选必须经 overridesToPriceTiers 转换（不能把 UTC 的 HHMM 直接当分钟数塞进档位表）
    expect(src).toContain("overridesToPriceTiers(timeOv,");
  });

  it("采集结果必须在面板上可见 —— 采集而不展示 = 没采集", () => {
    // 用户对 B4 的原话是"彻底完善探针对于所有模型厂家的上游模型定价的追踪"。
    // 如果面板只显示四个价格框，用户根本无从判断探针是否生效 —— 这个改造就等于没做。
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    expect(panel).toContain("function UpstreamPricingHints");
    // 三类信息都要被渲染出来
    expect(panel).toContain("m.pricing_time_tiers_candidate");
    expect(panel).toContain("m.pricing_context_tiers");
    expect(panel).toContain("m.pricing_per_request");
    // 时段档必须**可导入**（否则用户只能照上游文档手抄时段）
    expect(panel).toContain("导入上游时段");
    // 上下文分档 / 按次单价必须明确声明"不参与计费"（硬套会算错，必须让用户知道我们没算）
    expect(panel).toContain("不参与计费");
    expect(panel).toContain("不计入 token 账目");
    // 未开启分时时也要能看到（导入入口在这一屏，藏到展开态里等于没有）
    const editorStart = panel.indexOf("function TierEditor");
    const hintsInEditor = panel.slice(editorStart, editorStart + 3000);
    expect(hintsInEditor).toContain("UpstreamPricingHints");
  });

  it("HHMM 时段字段必须做合法性校验（`480` 是「4:80」而不是 08:00）", () => {
    const src = readSrc("gui/src/main/providers.ts");
    expect(src).toContain("function hhmmToMinute");
    // 校验必须包含 分钟 > 59 的拒绝 —— 少了它，`480` 会被静默解释成一个不存在的时刻
    expect(src).toMatch(/m\s*>\s*59/);
  });
});

describe("probeUpstreamTwoPhase（两阶段探测：阶段 2 不能被阶段 1 短路）", () => {
  /** 造一个按 url 路由的假上游；记录实际请求过的 url 以断言调用序列 */
  function fakeUpstream(routes: Record<string, unknown>, seen: string[]) {
    return async (url: string): Promise<{ data?: unknown } | null> => {
      seen.push(url);
      const hit = Object.keys(routes).find((k) => url.endsWith(k));
      if (!hit) { return null; }
      return routes[hit] as { data?: unknown };
    };
  }

  it("回归（事故根因）：/v1/models 返回 200 但没有 pricing 时，仍必须去 /api/pricing 取价", async () => {
    const seen: string[] = [];
    const getJson = fakeUpstream({
      // 大多数网关的 /v1/models 只给 id，**不带 pricing** —— 旧实现在这里 return 就结束了
      "/v1/models": { data: [{ id: "deepseek-v4-pro", context_length: 512000 }] },
      "/api/pricing": { data: [{ model_name: "deepseek-v4-pro", model_ratio: 0.495 }] },
    }, seen);

    const details = await probeUpstreamTwoPhase("https://gw.example.com", getJson);

    // ① 阶段 2 必须真的被调用到
    expect(seen).toContain("https://gw.example.com/api/pricing");
    // ② 元数据与定价都要拿到（旧实现只有前者）
    expect(details.get("deepseek-v4-pro")?.context_length).toBe(512000);
    expect(details.get("deepseek-v4-pro")?.pricing?.prompt).toBeCloseTo(0.99, 6);
  });

  it("阶段 1 命中即止：拿到清单后不再试后续元数据端点", async () => {
    const seen: string[] = [];
    const getJson = fakeUpstream({
      "/v1/models": { data: [{ id: "m1" }] },
      "/openapi.json": { data: [{ id: "should-not-be-used" }] },
      "/api/pricing": { data: [{ model_name: "m1", model_ratio: 0.5 }] },
    }, seen);
    await probeUpstreamTwoPhase("https://gw.example.com", getJson);
    expect(seen.filter((u) => u.endsWith("/v1/models"))).toHaveLength(1);
    expect(seen).not.toContain("https://gw.example.com/openapi.json");
  });

  it("上游自带 pricing（OpenRouter 市场价）优先于定价端点的补位价", async () => {
    const getJson = fakeUpstream({
      "/v1/models": { data: [{ id: "m1", pricing: { prompt: "0.000003", completion: "0.000015" } }] },
      "/api/pricing": { data: [{ model_name: "m1", model_ratio: 99 }] },
    }, []);
    const details = await probeUpstreamTwoPhase("https://gw.example.com", getJson);
    expect(details.get("m1")?.pricing?.prompt).toBeCloseTo(3, 6); // 3e-6 × 1e6
    expect(details.get("m1")?.pricing?.completion).toBeCloseTo(15, 6);
  });

  it("定价端点是对象映射形态（/api/ratio_config）同样能合并", async () => {
    const getJson = fakeUpstream({
      "/v1/models": { data: [{ id: "m1" }] },
      "/api/ratio_config": { data: { model_ratio: { m1: 0.135 }, completion_ratio: { m1: 2 }, cache_ratio: { m1: 0.25 } } },
    }, []);
    const details = await probeUpstreamTwoPhase("https://gw.example.com", getJson);
    const p = details.get("m1")?.pricing;
    expect(p?.prompt).toBeCloseTo(0.27, 6);
    expect(p?.completion).toBeCloseTo(0.54, 6);
    expect(p?.promptCacheRead).toBeCloseTo(0.0675, 6);
  });

  it("上游全线不可达 → 返回空 Map，不抛异常（探针失败不能中断保存流程）", async () => {
    const details = await probeUpstreamTwoPhase("https://gw.example.com", async () => null);
    expect(details.size).toBe(0);
  });
});

/* ═══════════ A-990：以模型所属地决定币种 + 金额尽量靠近整数 ═══════════
 *
 * 用户指令原文：「这个以模型所属地决定，金额尽量靠近整数，转汇率的时候经常出现小数点，看着不舒服。」
 * 此前有两处**硬编码 7.25**（RightSidebar 会话费用、UsageStatsPanel 全部成本显示），
 * 既与共享层 `USD_CNY_RATE`(7.2) 不一致（同一笔账两处不同数），又用 `toFixed(4)` 印出
 * `¥12.3000` 这种长尾。本组用例把新的判据与格式全部钉死。
 */
describe("币种归属（vendorRegion / currencyOfRegion / displayCurrencyForModel）", () => {
  it("国内厂商 → cn；海外与未知 → other（未知**不猜**成 cn）", () => {
    expect(vendorRegion("deepseek")).toBe("cn");
    expect(vendorRegion("glm")).toBe("cn");
    expect(vendorRegion("qwen")).toBe("cn");
    expect(vendorRegion("openai")).toBe("other");
    expect(vendorRegion("claude")).toBe("other");
    // 大小写不敏感（上游回传的 key 大小写不保证）
    expect(vendorRegion("DeepSeek")).toBe("cn");
    // 未知/空 → other。**绝不能**默认成 cn：猜错会把美元价按 ¥ 显示，金额直接差 7 倍。
    expect(vendorRegion(undefined)).toBe("other");
    expect(vendorRegion("zz-unknown-vendor")).toBe("other");
  });

  it("只有 cn 用人民币，us/other 一律美元（宁可显示美元，也不要把美元当人民币）", () => {
    expect(currencyOfRegion("cn")).toBe("CNY");
    expect(currencyOfRegion("us")).toBe("USD");
    expect(currencyOfRegion("other")).toBe("USD");
  });

  it("displayCurrencyForModel：官方有 ¥ 价的模型 → CNY；海外 → USD；未知模型 → USD", () => {
    // DeepSeek / GLM 的表内已登记官方人民币列（逐条核对官方定价页得来）
    expect(displayCurrencyForModel("deepseek-v4.1-flash")).toBe("CNY");
    expect(displayCurrencyForModel("glm-5.3")).toBe("CNY");
    // 海外厂商无 ¥ 列
    expect(displayCurrencyForModel("gpt-4o")).toBe("USD");
    expect(displayCurrencyForModel("claude-sonnet-4-20250514")).toBe("USD");
    // 表里没有的模型 → USD（不猜）
    expect(displayCurrencyForModel("zz-unlisted-model-xyz")).toBe("USD");
  });

  it("displayCurrencyForModel 与 formatPricingAmounts 的主币种**必须一致**（同一价不能两处显示不同币种）", () => {
    for (const id of ["deepseek-v4.1-flash", "deepseek-v4-pro", "glm-5.3", "gpt-4o"]) {
      const cur = displayCurrencyForModel(id);
      // 用内置平铺价（不含手填/上游/时刻因素）——本用例只关心"币种分支是否一致"
      const txt = formatPricingAmounts(builtInFlatPricing(id));
      if (!txt) { continue; }
      // CNY 归属 → 串里必须出现 ¥（人民币在前）；USD 归属 → 不得出现 ¥
      if (cur === "CNY") { expect(txt, id).toContain("¥"); }
      else { expect(txt, id).not.toContain("¥"); }
    }
  });
});

describe("金额格式化（convertFromUsd / formatMoney：尽量靠近整数、绝不留长尾）", () => {
  it("折算率只有一个出处：convertFromUsd 用 USD_CNY_RATE，不再是各处硬编码的 7.25", () => {
    expect(convertFromUsd(1, "USD")).toBe(1);
    expect(convertFromUsd(1, "CNY")).toBe(USD_CNY_RATE);
    expect(convertFromUsd(0, "CNY")).toBe(0);
    // 旧实现的 7.25 与共享层 7.2 不一致 —— 这条断言的意义就是"改了 7.2 全局跟着变"
    expect(convertFromUsd(10, "CNY")).toBe(72);
  });

  it("整数与短小数**不留尾零**（旧 toFixed(4) 会把 ¥12.30 印成 ¥12.3000）", () => {
    expect(formatMoney(2, "CNY")).toBe("¥2");           // 官方整数价如 GLM ¥2/¥8
    expect(formatMoney(12.3, "CNY")).toBe("¥12.3");
    expect(formatMoney(12.34, "CNY")).toBe("¥12.34");
    expect(formatMoney(0.5, "USD")).toBe("$0.5");
  });

  it("按量级给精度：≥100 取整、≥1 两位、≥0.01 四位、更小六位", () => {
    expect(formatMoney(1234.567, "CNY")).toBe("¥1235");
    expect(formatMoney(1234, "CNY")).toBe("¥1234");
    expect(formatMoney(0.0123, "USD")).toBe("$0.0123");
    expect(formatMoney(0.000123, "USD")).toBe("$0.000123");
  });

  it("极小**非零**金额不得被抹成 0（0 = 免费，与极小额是两件事）", () => {
    // 旧实现 6 位小数下 $0.0000001 → "$0"，把"花了钱"显示成"没花钱"，与免费语义冲突
    expect(formatMoney(0.0000001, "USD")).toBe("$<0.000001");
    // 真正的 0 仍然是 0（免费必须显示为 0，不能显示成"<0.000001"）
    expect(formatMoney(0, "USD")).toBe("$0");
    expect(formatMoney(0, "CNY")).toBe("¥0");
  });

  it("负值与非法值不崩（账目不可能为负，但格式化不能抛）", () => {
    expect(formatMoney(-12.3, "CNY")).toBe("¥-12.3");
    expect(formatMoney(Number.NaN, "USD")).toBe("$0");
    expect(formatMoney(Number.POSITIVE_INFINITY, "USD")).toBe("$0");
  });
});

describe("源码守卫：折算率不许再出现第二处（A-990）", () => {
  /**
   * 为什么用**源码扫描**而不是产物断言：这次的问题是"另一个文件里写了个近似汇率"，
   * 它既能通过类型检查、也能通过单元测试（因为没人拿两个汇率对拍），
   * 只有"全仓搜一遍"才能拦住。存量注释里提到 7.25 是**历史事故记录**，必须保留，
   * 所以只禁止**代码行**里出现它（注释行放行）。
   */
  it("gui/core-ts/gateway-ts 的代码行里不得出现硬编码汇率", () => {
    const roots = ["gui/src", "core-ts/src", "gateway-ts/src"];
    const offenders: string[] = [];
    /*
     * 只扫两种**真正构成 bug** 的形态，而不是裸扫 "7.2"：
     *   · `7.25` —— 本次事故里的错误汇率（与共享层 7.2 不一致）；
     *   · `* 7.2` / `/ 7.2` —— 拿金额去乘除汇率（乘法的另一侧就是金额）。
     * 为什么不裸扫 `7.2`：SVG path 数据里天然含有 `267.264`、`862.72` 这类数字，
     * 裸扫会把整个图标库判成违规（实测 8 处误报）——**假红灯和没红灯一样有害**，
     * 因为下一次真红灯就没人看了。
     */
    const RATE_USED = /7\.25|[*\/]\s*7\.2(?!\d)/;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) { continue; }
        const lines = readFileSync(p, "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
          if (!RATE_USED.test(line)) { return; }
          const t = line.trim();
          // 注释行（含 JSDoc 续行的 `*`）放行：那里是在记录历史事故，不是在算钱
          if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) { return; }
          // 显式引用共享常量的行放行（这是**唯一**合法出处）
          if (line.includes("USD_CNY_RATE")) { return; }
          offenders.push(`${p}:${i + 1}  ${t.slice(0, 90)}`);
        });
      }
    };
    for (const r of roots) { walk(r); }
    expect(offenders, `折算率只能来自 shared 的 USD_CNY_RATE，以下位置疑似硬编码：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("守卫自检：故意构造的违规行必须被规则抓到（否则这条守卫是空转的）", () => {
    const RATE_USED = /7\.25|[*\/]\s*7\.2(?!\d)/;
    // 必须命中
    expect(RATE_USED.test("const cny = usd * 7.25;")).toBe(true);
    expect(RATE_USED.test("const cny = usd * 7.2;")).toBe(true);
    expect(RATE_USED.test("const cny = usd / 7.2;")).toBe(true);
    // 必须放过（SVG path 数据里的数字）
    expect(RATE_USED.test('<path d="M882.048 134.848L762.56 862.72a38.4"/>')).toBe(false);
    expect(RATE_USED.test('<path d="M267.264 581.824 110.848"/>')).toBe(false);
    // 必须放过（版本号/普通小数）
    expect(RATE_USED.test("target: es2020, version 7.20")).toBe(false);
  });
});

/* ═══════════ A-990-B：用户手选币种（"手动调整币种填入"）═══════════
 *
 * 用户诉求：「模型定价中，我希望可以手动调整币种填入，然后消耗时再按照用户选择显示消耗为＄还是￥。」
 *
 * 设计要点（下面每条用例对应一个）：
 *   ① 币种判定 = **用户手选 > 归属地推断**（`pricingDisplayCurrency`）；
 *   ② 记账单位**恒为 USD**，币种只决定"输入/显示的单位"（`toUsdAmount` ⇄ `convertFromUsd`）；
 *   ③ 显示时**优先引用原生列** —— 绝不能拿美元价乘汇率冒充官方人民币价；
 *   ④ 用户的显式选择必须**存得住**（落盘白名单 + 一键刷新两条路都会丢字段）。
 */
describe("A-990-B：币种判定与换算（用户手选 > 归属地）", () => {
  it("pricingDisplayCurrency：用户选择压过归属地；非法/空值按「未选」处理", () => {
    // 国内模型：归属地推断是 CNY
    expect(displayCurrencyForModel("deepseek-v4.1-flash")).toBe("CNY");
    // 用户偏要按美元看 → 尊重用户
    expect(pricingDisplayCurrency("deepseek-v4.1-flash", "USD")).toBe("USD");
    // 海外模型：归属地是 USD；用户改成人民币也照样尊重
    expect(pricingDisplayCurrency("gpt-4o", "CNY")).toBe("CNY");
    // 没选过 → 归属地推断
    expect(pricingDisplayCurrency("gpt-4o", undefined)).toBe("USD");
    expect(pricingDisplayCurrency("deepseek-v4.1-flash", undefined)).toBe("CNY");
    // 脏值（磁盘 JSON 可能被手改）不得被当成选择
    expect(pricingDisplayCurrency("gpt-4o", "usd" as never)).toBe("USD");
    expect(pricingDisplayCurrency("gpt-4o", "" as never)).toBe("USD");
  });

  it("toUsdAmount ⇄ convertFromUsd 可逆且共用同一个汇率（往返后与用户敲的数字一致）", () => {
    expect(toUsdAmount(8, "USD")).toBe(8);           // 没动币种时数值逐位不变
    expect(toUsdAmount(8, "CNY")).toBe(cnyToUsd(8)); // 人民币录入 → USD 落库
    for (const typed of [0, 0.5, 2, 8, 28, 123.45]) {
      const usd = toUsdAmount(typed, "CNY");
      // 往返误差必须在显示精度内（formatAmount 去掉尾零后应还原用户输入）
      expect(formatAmount(convertFromUsd(usd, "CNY")), String(typed)).toBe(formatAmount(typed));
    }
  });

  it("formatAmountsInCurrency 按「该侧有没有原生值」判定，绝不拿美元价乘汇率冒充官方人民币价", () => {
    // DeepSeek 官方**两列都公布**（非等比：¥2 ≠ 0.3×7.2 = 2.16）→ 两个币种都是原生值、都不带 ≈
    const ds = { priceIn: 0.3, priceOut: 1.2, priceInCny: 2, priceOutCny: 8, usdDerivedFromCny: false };
    expect(formatAmountsInCurrency(ds, "CNY")).toBe("¥2 / ¥8 /1M");
    expect(formatAmountsInCurrency(ds, "CNY")).not.toContain("2.16");
    expect(formatAmountsInCurrency(ds, "USD")).toBe("$0.3 / $1.2 /1M");

    // 官方只有 ¥ 列（国内站独有的模型，美元值由 flatPricing 折算而来 → usdDerivedFromCny=true）
    const cnyOnly = { priceIn: 0.111, priceOut: 0.389, priceInCny: 0.8, priceOutCny: 2.8, usdDerivedFromCny: true };
    expect(formatAmountsInCurrency(cnyOnly, "CNY")).toBe("¥0.8 / ¥2.8 /1M");
    expect(formatAmountsInCurrency(cnyOnly, "USD")).toMatch(/^≈\$/);

    // 官方只有美元列（海外模型）→ 要人民币时必须带 ≈
    const usdOnly = { priceIn: 2.5, priceOut: 10 };
    expect(formatAmountsInCurrency(usdOnly, "USD")).toBe("$2.5 / $10 /1M");
    expect(formatAmountsInCurrency(usdOnly, "CNY")).toMatch(/^≈¥/);

    // 两侧都判不出来（无价）→ undefined（由调用方决定显示"未定价"）
    expect(formatAmountsInCurrency({}, "CNY")).toBeUndefined();
  });

  it("无价的模型：三个币种函数都不得凭空造出数字", () => {
    expect(formatAmountsInCurrency({}, "USD")).toBeUndefined();
    expect(formatAmountsInCurrency({}, "CNY")).toBeUndefined();
    expect(formatPricingAmounts({})).toBeUndefined();
  });

  /* ═══════ A-990-C：单价框必须显示**官方原数字**，不能拿美元价乘汇率 ═══════
   *
   * 用户截图报的就是这个：DeepSeek 官方 `¥2 / ¥8`，面板四个输入框里写着
   * `2.16 / 8.64 / 0.0432`（= 0.3×7.2、1.2×7.2、0.006×7.2）。
   * 用户的原话是「官方文档都没有小数点」—— 一句话就指出了根因：
   * 我们显示的是**折算产物**，而不是官方刊例价。
   *
   * 四个输入框与「当前生效」那行原先各自写 `convertFromUsd(v, cur)`；
   * 现在统一走 `amountInCurrency`（按**字段**判原生性）。
   */
  it("amountInCurrency：有官方 ¥ 列就返回官方数字（不得返回折算值）", () => {
    // DeepSeek V4.1-Flash 高峰：官方两列 $0.3/$1.2 与 ¥2/¥8（非等比）
    const eff = { priceIn: 0.3, priceOut: 1.2, priceCacheRead: 0.006, priceInCny: 2, priceOutCny: 8, priceCacheReadCny: 0.04 };
    expect(amountInCurrency(eff, "priceIn", "CNY")).toEqual({ value: 2, native: true });
    expect(amountInCurrency(eff, "priceOut", "CNY")).toEqual({ value: 8, native: true });
    expect(amountInCurrency(eff, "priceCacheRead", "CNY")).toEqual({ value: 0.04, native: true });
    // ⚠️ 旧实现会给出 0.3×7.2 = 2.16 —— 这个数字在官方文档里根本不存在
    expect(amountInCurrency(eff, "priceIn", "CNY")!.value).not.toBeCloseTo(0.3 * USD_CNY_RATE, 6);
    // 美元侧也是原生列（官方英文页同时公布）→ 无 ≈
    expect(amountInCurrency(eff, "priceIn", "USD")).toEqual({ value: 0.3, native: true });
    // 官方**没有** ¥ 缓存写入列 → 该字段在 ¥ 下是折算值（必须标 ≈）
    expect(amountInCurrency({ priceIn: 0.3, priceCacheWrite: 0.375, priceInCny: 2 }, "priceCacheWrite", "CNY"))
      .toEqual({ value: 2.7, native: false });
    // 完全没有的字段 → undefined（不得编造成 0）
    expect(amountInCurrency({ priceInCny: 2 }, "priceCacheWrite", "CNY")).toBeUndefined();
  });

  it("amountInCurrency 与 formatAmountsInCurrency 的原生性判据必须一致（同一字段不得一处原生一处折算）", () => {
    const eff = { priceIn: 0.3, priceOut: 1.2, priceInCny: 2, priceOutCny: 8 };
    const pair = formatAmountsInCurrency(eff, "CNY")!;
    expect(pair).toBe("¥2 / ¥8 /1M");                       // 成对版本：原生、无 ≈
    expect(amountInCurrency(eff, "priceIn", "CNY")!.native).toBe(true);
    expect(amountInCurrency(eff, "priceOut", "CNY")!.native).toBe(true);
    // 官方只有美元列的模型：成对版本带 ≈，字段版本 native=false —— 必须同步
    const usdOnly = { priceIn: 2.5, priceOut: 10 };
    expect(formatAmountsInCurrency(usdOnly, "CNY")!).toMatch(/^≈¥/);
    expect(amountInCurrency(usdOnly, "priceIn", "CNY")!.native).toBe(false);
  });


  it("officialPriceCurrency：只有真登记了 ¥ 列才算「官方人民币价」（归属地不算）", () => {
    expect(officialPriceCurrency("deepseek-v4.1-flash")).toBe("CNY");
    expect(officialPriceCurrency("glm-5.3")).toBe("CNY");
    expect(officialPriceCurrency("gpt-4o")).toBe("USD");
    expect(officialPriceCurrency("zz-unlisted-model-xyz")).toBe("USD");
  });

  it("手填 ¥8 的端到端：落库是 USD（记账单位唯一），显示回到 ¥8", () => {
    // 模拟面板的录入 → 落库 → 回显三步
    const typed = 8;
    const storedUsd = toUsdAmount(typed, pricingDisplayCurrency("deepseek-v4.1-flash", "CNY"));
    expect(storedUsd).toBeCloseTo(8 / USD_CNY_RATE, 10);
    // 落库值是 USD：不能等于 8（那会让引擎把 8 当成 $8 记账，成本高 7.2 倍）
    expect(storedUsd).not.toBe(typed);
    // 回显：按用户选的币种折算回去，去尾零后就是用户敲的那个数
    expect(formatAmount(convertFromUsd(storedUsd, "CNY"))).toBe("8");
  });
});

describe("A-990-E：探针诊断分类（回答「探针探不到吗」）", () => {
  it("本地端点 / 上游命中 / 上游没给价 / 完全无价 四种分类互不混淆", () => {
    // 本地端点优先判定：即便价来自内置表，也要告诉用户"这里根本不需要价目"
    expect(classifyProbeOutcome("table", "http://127.0.0.1:8800")).toBe("local");
    expect(classifyProbeOutcome("manual", "http://127.0.0.1:8800")).toBe("local");
    // 上游确实给了价
    expect(classifyProbeOutcome("upstream", "https://gw.example.com")).toBe("upstream-hit");
    // 上游没给 → 内置表（**这是绝大多数官方 API 的正常形态，不是故障**）
    expect(classifyProbeOutcome("table", "https://api.deepseek.com")).toBe("builtin-table");
    expect(classifyProbeOutcome("tier", "https://api.deepseek.com")).toBe("builtin-table");
    expect(classifyProbeOutcome("snapshot", "https://api.deepseek.com")).toBe("builtin-table");
    // 表里也没有 → 未定价
    expect(classifyProbeOutcome("none", "https://gw.example.com")).toBe("unpriced");
  });

  it("文案必须说清「不是故障」，否则用户会一直去重修探针", () => {
    // 这条断言保护的是**措辞**：把"上游不发布价目"说成"探针失败"会直接导致无效返工
    expect(PROBE_OUTCOME_HINT["builtin-table"]).toContain("不发布价目");
    expect(PROBE_OUTCOME_HINT["builtin-table"]).not.toContain("失败");
    expect(PROBE_OUTCOME_HINT.local).toContain("探针");
  });
});

describe("A-990-F：补齐国内厂商官方人民币价（消除「官方文档没有小数点」的根因）", () => {
  it("Kimi / MiniMax 必须用官方 ¥ 价，且命中精确条目", () => {
    /*
     * 一手来源：
     *   Kimi   —— platform.moonshot.cn 刊例 + kimi.com/resources/kimi-k3-pricing
     *             + platform.kimi.com/docs/pricing/batch（批量 = 标准 60%，反算校验一致）
     *   MiniMax—— platform.minimaxi.com/docs/guides/pricing-paygo + /subscribe/token-plan（两页一致）
     * 补价收益：此前这两家**完全没价** → 走快照二手美元价（kimi-k3 比官方低约 30%），
     *          且按 ¥ 显示时只能折算 → 必然出现小数。
     */
    const cases: Array<[string, number, number, number | "none"]> = [
      // id, priceInCny, priceOutCny, priceCacheReadCny（"none" = 官方未列）
      ["kimi-k3", 20, 100, 2],
      ["kimi-k2.7-code", 6.5, 27, 1.3],
      ["kimi-k2.6", 6.5, 27, 1.1],
      ["kimi-k2.5", 4, 21, 0.7],
      ["moonshot-v1", 10, 30, "none"],
      ["minimax-m3", 2.1, 8.4, 0.42],
      ["minimax-m2.7", 2.1, 8.4, 0.42],
      ["minimax-m2.5", 2.1, 8.4, 0.21],
      ["minimax-m2", 2.1, 8.4, 0.21],
    ];
    for (const [id, inCny, outCny, crCny] of cases) {
      const p = builtInFlatPricing(id);
      expect(p.priceInCny, `${id} ¥输入价`).toBe(inCny);
      expect(p.priceOutCny, `${id} ¥输出价`).toBe(outCny);
      if (crCny === "none") { expect(p.priceCacheReadCny, `${id} 无缓存价`).toBeUndefined(); }
      else { expect(p.priceCacheReadCny, `${id} ¥缓存命中价`).toBeCloseTo(crCny, 9); }
      // 官方只有 ¥ 列 → 美元是折算值（不得冒充官方美元价）
      expect(p.usdDerivedFromCny, `${id} 美元应为折算值`).toBe(true);
      // 且必须是**精确条目**（锚定 `^`），不是家族兜底
      expect(pricingMatchKind(id), `${id} 应为精确条目`).toBe("exact");
    }
    // MiniMax 是少数明确收**缓存写入费**的国内厂商（¥2.625 = 输入价 1.25×）
    expect(builtInFlatPricing("minimax-m2.7").priceCacheWriteCny).toBeCloseTo(2.625, 9);
    // -highspeed 是基础型号的 2 倍，必须各取各的（顺序排错会被基础型号的前缀吃掉）
    expect(builtInFlatPricing("minimax-m2.7-highspeed").priceInCny).toBe(4.2);
    expect(builtInFlatPricing("minimax-m2.7").priceInCny).toBe(2.1);
  });
  it("Qwen 必须走内置表的官方 ¥ 价，而不是 OpenRouter 快照的二手美元价", () => {
    // 一手来源：阿里云百炼官方价格页（人民币计价），核实 2026-09-18
    const p = builtInFlatPricing("qwen3.8-max");
    expect(p.priceInCny).toBe(14.988);
    expect(p.priceOutCny).toBe(44.965);
    // 官方只有 ¥ 列 → 美元是折算值，必须带标记（不得冒充官方美元价）
    expect(p.usdDerivedFromCny).toBe(true);
    // 取价来源必须是内置表，不再是快照
    expect(resolveModelPriceTier("qwen3.8-max").pricing.priceIn).toBeCloseTo(14.988 / USD_CNY_RATE, 10);
    const resolved = resolveEffectivePricing("qwen3.8-max", "");
    expect(resolved.origin === "table" || resolved.origin === "tier").toBe(true);
    // 按人民币显示时必须是**官方原数字**（无 ≈）
    expect(formatAmountsInCurrency(builtInFlatPricing("qwen3.8-max"), "CNY")).toBe("¥14.988 / ¥44.965 /1M");
  });

  it("补价不得盖掉同一家族的思考能力（单表首个命中：能力与价格必须同条目）", () => {
    // ⚠️ 这条守的是 A-990-F 引入的实际风险：`MODEL_CAPABILITIES` 被能力推断与取价**共用**，
    //    只写价格的条目排在通用条目之前就会把 enable_thinking 一起盖掉。
    for (const id of ["qwen3.8-max", "qwen3.8-flash", "qwen3.8-27b", "qwen3.7-plus"]) {
      const caps = inferModelCapabilities(id);
      expect(caps.supported, id).toBe(true);
      expect(caps.thinkingParam, id).toBe("enable_thinking");
      expect(caps.efforts, id).toEqual(["low", "medium", "xhigh"]);
    }
  });
});


describe("A-990-G：全表时效性守卫（价格必须可溯源到某一天）", () => {
  /**
   * 为什么要有这一组：本次复核（2026-09-18）暴露的真实风险不是"某条价错了"，
   * 而是**没人知道哪条价是哪天的**。代码里的浮点常量看不出日期，
   * 于是"落后"不会有任何症状 —— 直到用户拿官方文档来对。
   *
   * 这三条守卫分别锁：① 有价必有核实日期；② 日期不得是编的（`unknown` 是合法值）；
   * ③ 补价时必须连带保住能力（单表首个命中的陷阱）。
   */
  it("凡是在内置表里写了价的厂商，都必须在 PRICING_VERIFIED_AT 里有日期（`unknown` 也算有）", () => {
    const vendorsWithPrice = new Set<string>();
    for (const v of MODEL_CAPABILITIES) {
      const vendorLevel = v.priceIn !== undefined || v.priceOut !== undefined
        || v.priceInCny !== undefined || v.priceOutCny !== undefined;
      const modelLevel = v.models.some((m) => m.priceIn !== undefined || m.priceInCny !== undefined
        || m.priceTiers !== undefined);
      if (vendorLevel || modelLevel) { vendorsWithPrice.add(v.key); }
    }
    const missing = [...vendorsWithPrice].filter((k) => PRICING_VERIFIED_AT[k] === undefined).sort();
    expect(missing, `这些厂商有内置价却没有核实日期（界面会显示成"永远新鲜"）：${missing.join(", ")}`).toEqual([]);
  });

  it("日期必须是 `unknown` 或 ISO 日期，不得是空串/其它形态（脏值会让界面显示出假的新鲜度）", () => {
    for (const [k, v] of Object.entries(PRICING_VERIFIED_AT)) {
      expect(v === "unknown" || /^\d{4}-\d{2}-\d{2}$/.test(v), `${k}=${JSON.stringify(v)}`).toBe(true);
    }
    // `unknown` 必须被识别为"未知"（面板据此渲染醒目提示，而不是当成一个真日期）
    expect(pricingVerifiedAtUnknown("mistral")).toBe(true);
    expect(pricingVerifiedAtUnknown("deepseek")).toBe(false);
    expect(pricingVerifiedAtUnknown("zz-no-such-vendor")).toBe(true);
  });

  it("OpenAI 现行全表必须与官方定价页一致（一手来源：developers.openai.com/api/docs/pricing，2026-09-18）", () => {
    /*
     * 数据来源说明（这点必须写清）：本节数值来自**用户提供的官方定价页原文**（Standard / 短上下文）。
     * 本机对该页 `platform.openai.com` 被 Cloudflare 拦截，此前只能靠检索摘要 —— 而
     * **凭摘要写价 = 编造**，所以当时全部回退。拿到原文后才落地。
     */
    const cases: Array<[string, number, number, number | undefined, number | undefined]> = [
      // id, priceIn, priceOut, priceCacheRead, priceCacheWrite
      ["gpt-6-astra", 10, 50, 1, 12.5],
      ["gpt-5.6-sol", 4, 20, 0.4, 5],
      ["gpt-5.6-terra", 2, 12, 0.2, 2.5],
      ["gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
      ["gpt-5.6-cyber", 12.5, 75, 1.25, 15.625],
      ["gpt-5.5-cyber", 12.5, 75, 1.25, undefined],
      ["gpt-5.5", 5, 30, 0.5, undefined],
      ["gpt-5.5-pro", 30, 180, undefined, undefined],
      ["gpt-5.4", 2.5, 15, 0.25, undefined],
      ["gpt-5.4-mini", 0.75, 4.5, 0.075, undefined],
      ["gpt-5.4-nano", 0.2, 1.25, 0.02, undefined],
      ["gpt-5.4-pro", 30, 180, undefined, undefined],
      ["gpt-5.3-codex", 1.75, 14, 0.175, undefined],
      ["gpt-5.2", 1.75, 14, 0.175, undefined],
      ["gpt-5.2-pro", 21, 168, undefined, undefined],
      ["gpt-5.1", 1.25, 10, 0.125, undefined],
      ["gpt-5", 1.25, 10, 0.125, undefined],
      ["gpt-5-mini", 0.25, 2, 0.025, undefined],
      ["gpt-5-nano", 0.05, 0.4, 0.005, undefined],
      ["gpt-5-pro", 15, 120, undefined, undefined],
      ["gpt-4.1", 2, 8, 0.5, undefined],
      ["gpt-4.1-mini", 0.4, 1.6, 0.1, undefined],
      ["gpt-4.1-nano", 0.1, 0.4, 0.025, undefined],
      ["gpt-4o", 2.5, 10, 1.25, undefined],
      ["gpt-4o-2024-05-13", 5, 15, undefined, undefined],
      ["gpt-4o-mini", 0.15, 0.6, 0.075, undefined],
      ["o1", 15, 60, 7.5, undefined],
      ["o1-pro", 150, 600, undefined, undefined],
      ["o3", 2, 8, 0.5, undefined],
      ["o3-pro", 20, 80, undefined, undefined],
      ["o3-mini", 1.1, 4.4, 0.55, undefined],
      ["o4-mini", 1.1, 4.4, 0.275, undefined],
      ["gpt-4-turbo-2024-04-09", 10, 30, undefined, undefined],
    ];
    for (const [id, inP, outP, cr, cw] of cases) {
      const p = inferModelPricing(id);
      expect(p.priceIn, `${id} 输入价`).toBeCloseTo(inP, 9);
      expect(p.priceOut, `${id} 输出价`).toBeCloseTo(outP, 9);
      // ⚠️ 必须分开处理 undefined：`toBeCloseTo(undefined)` 会算成 NaN 而**永远失败**
      //    （第一版就栽在这）。而"官方标 `-` = 不单独收费"必须断言成 undefined（不是 0）——
      //    0 会让界面显示"免费"，undefined 才表达"没有这一项"。
      if (cr === undefined) { expect(p.priceCacheRead, `${id} 无缓存命中列`).toBeUndefined(); }
      else { expect(p.priceCacheRead, `${id} 缓存命中价`).toBeCloseTo(cr, 9); }
      if (cw === undefined) { expect(p.priceCacheWrite, `${id} 无缓存写入列`).toBeUndefined(); }
      else { expect(p.priceCacheWrite, `${id} 缓存写入价`).toBeCloseTo(cw, 9); }
    }
    // ⚠️ `-pro` 家族输入价高 6 倍（5.5-pro $30 vs 5.5 $5）—— 必须各取各的
    expect(inferModelPricing("gpt-5.5-pro").priceIn).not.toBe(inferModelPricing("gpt-5.5").priceIn);
    // 精确条目的锚定必须真的生效：`gpt-5.5-foo` 这种未登记后缀**不得**继承 5.5 的价
    // （否则"锚定"就是摆设，又会回到"同名不同代共用一个价"的老病）
    expect(builtInFlatPricing("gpt-5.5-unknown-suffix").priceIn).toBeUndefined();
  });

  it("gpt-5/6 家族的能力（思考 + responses 端点）必须齐备：回退价格时也不能连带砍掉能力", () => {
    for (const id of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.1", "gpt-5", "gpt-5.7-whatever"]) {
      const caps = inferModelCapabilities(id);
      expect(caps.supported, id).toBe(true);
      expect(caps.endpoint, id).toBe("responses");
      expect(caps.efforts, id).toContain("xhigh");
    }
  });
});

/* ═══════ A-990-H：家族正则 vs 精确 id（用户指出的病根）═══════
 *
 * 病根：价格键是家族正则 → 同家族跨代价差的型号共用一个价。
 * `claude.*opus` 曾把 Opus 4.5+ 的 $5/$25 按 Opus 4.1 的 $15/$75 计 → **高估 3 倍**。
 * 约定：**当前在售的旗舰型号必须写锚定 `^…$` 的精确条目**；家族正则只作兜底且不带价。
 * 界面据 `pricingMatch` 标注「精确 id」/「家族兜底（可能偏离）」。
 */
describe("A-990-H：价目命中方式必须可判定、且现行旗舰必须是精确条目", () => {
  it("现行旗舰（OpenAI / DeepSeek / Qwen）必须命中精确条目", () => {
    for (const id of [
      "gpt-6-astra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini", "gpt-5.1", "o3", "o4-mini",
      "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo-2024-04-09",
      "deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner",
      "qwen3.8-max", "qwen3.8-flash",
    ]) {
      expect(pricingMatchKind(id), `${id} 应为精确条目`).toBe("exact");
    }
  });

  /**
   * ⚠️ **尚未精确化的家族条目**（如实登记，不许它静默消失）。
   *
   * 这些厂商目前只有家族正则（`glm[-_.]5[-_.]3`、`claude.*opus`、`gemini…`），
   * 所以同家族跨代改价时仍可能偏离 —— `claude.*opus` 曾把 Opus 4.5+ 的 $5/$25
   * 按 Opus 4.1 的 $15/$75 计（**高估 3 倍**）。精确化它们需要先**逐条拿到官方价原文**
   * （本机对 openai/anthropic 的定价页有 Cloudflare 拦截），故留作待办。
   * 界面已经会对这些行标注「价目匹配：家族兜底（可能偏离）」—— 这是本轮的实际交付。
   */
  it("已知未精确化的厂商（待办，**不是**通过）", () => {
    const stillFamily = ["glm-5.3", "claude-sonnet-5", "gemini-3-pro", "mistral-large", "cohere-command-r-plus"];
    const exact = stillFamily.filter((id) => pricingMatchKind(id) === "exact");
    expect(exact, `这些已精确化，请从待办清单移除：${exact.join(", ")}`).toEqual([]);
    // 反过来说明"家族兜底"确实被标出来了（不是所有条目都成了 exact）
    expect(pricingMatchKind("glm-5.3")).toBe("family");
  });

  it("未登记型号必须落到 family（而不是被某条精确条目误吃）", () => {
    // 家族兜底承接新型号：命中 family，价格留给快照/用户手填
    expect(pricingMatchKind("claude-9-opus-imaginary")).toBe("family");
    expect(pricingMatchKind("zz-unlisted-model-xyz")).toBe("none");
  });

  it("resolveEffectivePricing 必须把命中方式带出来（界面才能标注「可能偏离」）", () => {
    expect(resolveEffectivePricing("gpt-6-astra", "").pricingMatch).toBe("exact");
    // 家族兜底的情形：命中的是宽泛正则
    const fam = resolveEffectivePricing("claude-9-opus-imaginary", "");
    expect(fam.pricingMatch).toBe("family");
  });
});

describe("A-993：手填错值压过内置表必须被检出（用户实测踩到）", () => {
  /**
   * 事故复盘：配置里躺着历史错值 `$0.0193/$0.0386/$0.00417`（美元刊例被按人民币又除了一次
   * 汇率），带 manual 来源。手填按设计压过内置峰谷表 → 面板显示 `0.0193×7.2 = ¥0.139`，
   * 用户看到"官方明明 ¥9/¥27"却无任何解释。
   * 修复原则：**不改取价结果**（机器覆盖手填违反纪律），只把偏离亮出来 + 给一键恢复。
   */
  it("手填 0.0193 vs 官方档位 1.32（偏离 68 倍）必须被标记为疑似错值", () => {
    const eff = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 0.0193, price_out_usd: 0.0386, price_cache_read_usd: 0.00417,
      price_source: "manual",
    }, new Date("2026-09-18T02:00:00Z")); // 高峰：官方档位 $1.32/$3.96
    expect(eff.origin).toBe("manual");            // 取价结果不变（手填仍生效）
    expect(eff.priceIn).toBeCloseTo(0.0193, 9);
    expect(eff.suspiciousStored, "必须亮出偏离详情").toBeTruthy();
    expect(eff.suspiciousStored!.tableIn).toBeCloseTo(1.32, 9);
    expect(eff.suspiciousStored!.ratio).toBeLessThan(0.02);
  });

  it("正常手填（如议价 ±30%）不得误报", () => {
    const eff = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 1.0, price_out_usd: 3.0, price_source: "manual",
    }, new Date("2026-09-18T02:00:00Z"));
    expect(eff.origin).toBe("manual");
    expect(eff.suspiciousStored, "偏离仅 1.32 倍，是合理议价区间").toBeUndefined();
  });

  it("偏离恰在阈值边界的行为必须确定（避开浮点边界：5.2× 报、4.8× 不报）", () => {
    const at = new Date("2026-09-18T02:00:00Z");
    // ⚠️ 不能用正好 5×（6.6/1.32 在浮点里是 4.999…）—— 边界值必须留余量
    const at5x = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 6.9, price_source: "manual", // 5.23×
    }, at);
    expect(at5x.suspiciousStored, "5.2× 必须报").toBeTruthy();
    const at49x = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 6.3, price_source: "manual", // 4.77×
    }, at);
    expect(at49x.suspiciousStored, "4.8× 不报（阈值内）").toBeUndefined();
  });

  it("非手填来源（upstream/table）不参与疑似错值检测", () => {
    const eff = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 0.0193, price_source: "upstream",
    }, new Date("2026-09-18T02:00:00Z"));
    // upstream 与表价冲突由 A-989 守卫与上游逻辑处理，不属于"手填错值"范畴
    expect(eff.suspiciousStored).toBeUndefined();
  });
});

describe("A-990-B：用户选择必须存得住（落盘 + 一键刷新两条路）", () => {
  it("mergeModelPrice：手填分支与自动分支都必须保住 price_currency", () => {
    const withCur = (extra: Record<string, unknown>) => ({
      price_in_usd: 8 / USD_CNY_RATE, price_out_usd: 28 / USD_CNY_RATE,
      price_source: "manual" as const, price_currency: "CNY" as const, ...extra,
    });
    // 手填分支：自动探测结果里没有 price_currency（探测永远不产出它）→ 必须保留旧值
    const manual = mergeModelPrice(withCur({}), { price_in_usd: 1, price_source: "table" });
    expect(manual.price_currency).toBe("CNY");
    expect(manual.price_source).toBe("manual");
    // 自动分支：同样必须保留
    const prevAuto = { price_in_usd: 1, price_out_usd: 2, price_source: "table" as const, price_currency: "USD" as const };
    const auto = mergeModelPrice(prevAuto, { price_in_usd: 3, price_source: "upstream" });
    expect(auto.price_currency).toBe("USD");
    // prev 为空（新模型）→ 不凭空造一个币种出来（保持 undefined，交给归属地推断）
    expect(mergeModelPrice(undefined, { price_in_usd: 1 }).price_currency).toBeUndefined();
  });

  it("落盘往返：price_currency 存得住，脏值被丢弃（sanitize 是白名单重建，漏字段会静默丢）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slime-cur-"));
    setProvRoot(dir);
    try {
      await saveProvider({
        key: "curtest", api_base: "https://api.example.com/v1", api_key: "sk-1234567890",
        models: [
          { id: "m-cny", price_in_usd: 8 / USD_CNY_RATE, price_source: "manual", price_currency: "CNY" },
          { id: "m-junk", price_in_usd: 1, price_currency: "RUB" as never },
        ],
      });
      const saved = listProviders().find((p) => p.key === "curtest");
      const byId = new Map((saved?.models ?? []).map((m) => [m.id, m]));
      // 合法值必须活下来（sanitizeModels 是逐字段白名单，漏掉一行就会被静默抹掉）
      expect(byId.get("m-cny")?.price_currency).toBe("CNY");
      // 非法值必须被丢弃，而不是原样带进内存（否则下游币种判定会拿到不认识的值）
      expect(byId.get("m-junk")?.price_currency).toBeUndefined();
    } finally {
      setProvRoot(null);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A-990-B：消耗显示按用户选择", () => {
  it("ledgerCurrencyOf：注入 currencyOf 后按用户选择判币種，未注入时退回归属地", () => {
    const recs = [
      { model: "gpt-4o", provider_key: "p1", cost_usd: 1 },
      { model: "gpt-4o", provider_key: "p2", cost_usd: 1 },
    ];
    // 归属地：两个都是 USD
    expect(ledgerCurrencyOf(recs)).toBe("USD");
    // 用户在 p2 上把 gpt-4o 改成人民币看 → p2 的成本算 CNY
    // 1 vs 1 平票 → 不满足"严格多数"，仍取 USD（平票必须有确定答案，不能随遍历顺序变）
    const curOf = (r: { model: string; provider_key?: string }): "USD" | "CNY" =>
      (r.provider_key === "p2" ? "CNY" : "USD");
    expect(ledgerCurrencyOf(recs, curOf)).toBe("USD");
    // 让 CNY 那笔占多数 → 总账切到人民币
    const recs2 = [
      { model: "gpt-4o", provider_key: "p2", cost_usd: 5 },
      { model: "gpt-4o", provider_key: "p1", cost_usd: 1 },
    ];
    expect(ledgerCurrencyOf(recs2, curOf)).toBe("CNY");
    // 成本全 0 → 不猜币种，回落 USD（此时界面显示「—」，不涉及金额）
    expect(ledgerCurrencyOf([{ model: "gpt-4o", cost_usd: 0 }], () => "CNY")).toBe("USD");
  });
});
