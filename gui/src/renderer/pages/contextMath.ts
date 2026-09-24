/**
 * gui/src/renderer/pages/contextMath.ts — 上下文消耗 UI 的**纯计算**层（零 React 依赖、vitest 可直测）。
 * 供 ContextRing / ContextWindowBar 共用：环的色阶阈值、token 构成分段、8 源分桶占比。
 * 语义与右侧栏/环渲染一致（绿<60% / 黄 60-85% / 红 >85%）。
 */
export interface ComposeTokens {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
}

export interface ComposeSegment {
  label: string;
  color: string;
  pct: number;
  n: number;
}

export interface BucketCount {
  key: string;
  tokens: number;
}

export interface BucketSegment {
  key: string;
  pct: number;
}

/** 环占比：clamp 0..1（cap=0 → 0）。 */
export function contextRatio(used: number, cap: number): number {
  if (!(cap > 0)) { return 0; }
  return Math.max(0, Math.min(1, used / cap));
}

/** 环百分比：0..100 取整。 */
export function contextPct(ratio: number): number {
  return Math.round(ratio * 100);
}

/** 环色阶：<60% 绿 / <85% 黄 / 其余红；返回 颜色变量 + 语义标签。 */
export function ringLevel(ratio: number): { color: string; label: string } {
  if (ratio < 0.6) { return { color: "var(--success)", label: "充足" }; }
  if (ratio < 0.85) { return { color: "var(--warning)", label: "接近上限" }; }
  return { color: "var(--danger)", label: "逼近硬阈值" };
}

/** token 四项构成分段（输入/缓存/输出/思考；分母防零，任意项为 0 不产出段）。 */
export function composeSegments(t: ComposeTokens): { segments: ComposeSegment[]; any: boolean } {
  const tot = Math.max(1,
    (t.promptTokens ?? 0) + (t.completionTokens ?? 0) + (t.reasoningTokens ?? 0) + (t.cacheReadTokens ?? 0));
  const seg = (n: number): number => ((n ?? 0) / tot) * 100;
  const items: ComposeSegment[] = [
    { label: "输入", pct: seg(t.promptTokens), color: "#4b9eff", n: t.promptTokens ?? 0 },
    { label: "缓存", pct: seg(t.cacheReadTokens), color: "#2ea8dc", n: t.cacheReadTokens ?? 0 },
    { label: "输出", pct: seg(t.completionTokens), color: "#9a7bff", n: t.completionTokens ?? 0 },
    { label: "思考", pct: seg(t.reasoningTokens), color: "#d29922", n: t.reasoningTokens ?? 0 },
  ];
  const any = items.some((i) => i.n > 0);
  return { segments: items, any };
}

/** 8 源分桶占比（对齐 computeContextBuckets；总 tokens>0 归一，否则全 0）。 */
export function bucketsSegments(buckets: Array<{ key: string; tokens: number }>): { segments: BucketSegment[]; any: boolean } {
  const total = buckets.reduce((s, b) => s + (b.tokens ?? 0), 0);
  const any = total > 0;
  const segments = buckets
    .map((b) => ({ key: b.key, pct: any ? Math.round(((b.tokens ?? 0) / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.pct - a.pct);
  return { segments, any };
}

/** token 数量显示用的 K 进制（1000 = 十进制 K，1024 = 二进制 Ki）。 */
export type TokenBase = 1000 | 1024;

/**
 * 为**一个窗口上限**挑选它的 K 进制 —— 判据只有一条：
 * **哪个进制能把上限写成整数 K，就用哪个**（平局取十进制）。
 *
 * ## 为什么不能全局写死一种进制
 *
 * 本仓的模型上下文表**本来就混着两种口径**，而且都是**厂商自己**的口径：
 *
 * | 值 | 厂商写法 | `/1000` | `/1024` | 正确进制 |
 * |---|---|---|---|---|
 * | `128000` (gpt-4o) | 「128K」 | 128（整） | 125（整） | 十进制（平局） |
 * | `200000` (claude) | 「200K」 | 200（整） | 195.3125 | 十进制 |
 * | `524288` (2^19) | 「**512K**」 | 524.288 | 512（整） | **二进制** |
 * | `1048576` (2^20) | 「1M」 | 1048.576 | 1024（整） | **二进制** |
 * | `131072` (2^17) | 「128K」 | 131.072 | 128（整） | **二进制** |
 * | `262144` (Kimi 256K) | 「256K」 | 262.144 | 256（整） | **二进制** |
 *
 * 所以"统一用十进制"会把 512K 印成 524K、"统一用二进制"会把 gpt-4o 的 128K 印成 125K
 * —— 两种硬写死都会在**一半**的模型上给出厂商文档里查不到的数字。
 *
 * 而"哪个除得尽就用哪个"在**每一个**真实取值上都还原出厂商写法（上表右列），
 * 因为厂商正是按"整数 K"来选词回应的。这不是统计技巧，是**反推厂商的表述**。
 *
 * ⚠️ 用户实测反馈（原话）：「没有 524K 容量的上下文，只有 512K」——
 *    就是旧实现 `fmtK(n) = n/1000` 把 `config/global_config.json` 里的 `524288`
 *    印成「524K」造成的：同一个数，界面读 524K、厂商文档读 512K，用户以为自己看的不是同一个模型。
 */
export function pickTokenBase(cap: number): TokenBase {
  if (!Number.isFinite(cap) || cap <= 0) { return 1000; }
  const off = (b: number): number => Math.abs(cap / b - Math.round(cap / b));
  // 平局（128000：两个进制都是整数）→ 十进制，保住 gpt-4o 的「128K」写法
  return off(1024) < off(1000) ? 1024 : 1000;
}

/**
 * 上下文监测区的**唯一** token 数格式化（→ `65K` / `512K` / `1.0M`）。
 *
 * `cap` 是**同一块面板里的窗口上限** —— 传它就等于声明"我和上限同一进制"。
 * 同一屏的用量、余量、距压缩、构成、分桶**必须传同一个 cap**，否则
 * `已用/上限` 的读者得自己换算，而换错方向就是"以为还有 380K 余量、其实已经贴着窗口"。
 *
 * 调用方：右栏进度条（used/cap/距压缩/构成/分桶）+ 会话指标/明细 + 输入区监测栏的
 * `context` 芯片。**所有调用点都走这一个函数** —— 这正是修掉「同一语义两个产地、
 * 同屏两个数」的做法（旧状：右栏锚定值 66K、底部 `字符数÷4` 估算 43K，同为"上下文占用"）。
 */
export function fmtTokens(n: number, cap?: number | null): string {
  if (!Number.isFinite(n)) { return "0"; }
  const v = Math.max(0, n);
  const base: TokenBase = cap != null && Number.isFinite(cap) && cap > 0 ? pickTokenBase(cap) : 1000;
  const million = base * base;
  /** 去掉纯零小数尾巴：厂商写「4K」不写「4.0K」，写「1M」不写「1.0M」 */
  const unit = (val: number, decimals: number, suffix: string): string =>
    `${val.toFixed(decimals).replace(/\.0+$/, "")}${suffix}`;
  if (v < base) { return String(Math.round(v)); }
  if (v < million) { return unit(v / base, v < 10 * base ? 1 : 0, "K"); }
  return unit(v / million, 1, "M");
}

/** 把「存量值」归一成有限正数（数字或数字串都收；`""`/非法/非正 → undefined）。 */
function positiveNum(v: number | string | null | undefined): number | undefined {
  if (v == null || v === "") { return undefined; }
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 「N K」输入框（供应商编辑器的 上下文K / 输出K / 本地模型 ctx_len）的**唯一**换算族。
 *
 * ## 为什么必须有它：那一栏曾经「文案说 ×1024、代码做 ×1000」
 *
 * 表头与单元格的 `title` 原文写的是**二进制**（`输入 1024 = 1048576 token`、
 * `输入 32 = 32768 token`），而 `onChange` 是实现成 `v * 1000` 的 —— 同一栏的
 * **文案与判据不同源**（A-1062 同族的"说反话"）。三处实测后果：
 *
 * | 存量 | 旧显示（`/1000` 取整） | 旧写回 | 后果 |
 * |---|---|---|---|
 * | `524288`（= 512×1024） | **`524`** | `524000` | 用户在这里**第二次**看到「524K」（他原话：「没有 524K 容量的上下文，只有 512K」） |
 * | `65536`（2^16） | `66` | `66000` | 碰一下那一栏就被**静默改写**（−464 token） |
 * | `131072`（2^17） | `131` | `131000` | 同上（−72 token） |
 *
 * 现在两端都按**同一个 `pickTokenBase`** 取进制：`524288 ↔ 512`、`512000 ↔ 512`、
 * `65536 ↔ 64`、`128000 ↔ 128` —— 输入框里的数字与厂商写法、与右栏监测**同一口径**
 * （那个「512」正是用户期望看到的数），且**往返无损**。
 *
 * ⚠️ 进制必须由**存量值**判，不能由用户刚敲的数字判 —— 「200」在两个进制下是
 * 200000 / 204800，**从数字本身推不出**用户要哪个。以存量值为锚 ⇒ 编辑过程中进制恒定；
 * 唯一例外是新值恰好同时被两进制整除（`125 × 1024 = 128000`，即 `n` 是 125 的倍数），
 * 此时按平局规则改判十进制 —— 那也仍然**无损且自洽**（屏幕上的数 × 进制 恒等于存值）。
 */
export function kInputBase(cur: number | string | null | undefined): TokenBase {
  return pickTokenBase(positiveNum(cur) ?? 0);
}

/** 存量 token 数 → 输入框文本（空/非法 → `""`，交给 `placeholder`）。 */
export function tokensToKInput(cur: number | string | null | undefined): string {
  const n = positiveNum(cur);
  return n == null ? "" : String(Math.round(n / pickTokenBase(n)));
}

/** 输入框文本 → 存量 token 数（空/非法 → `undefined`，由调用方决定清空还是保留）。 */
export function kInputToTokens(text: string, base: TokenBase): number | undefined {
  const n = positiveNum(text);
  return n == null ? undefined : n * base;
}

/**
 * 「N K」栏的**唯一**提示文案 —— 进制与换算式同源，不许在 JSX 里手写 `输入 32 = 32768`。
 * 旧的写死例子（×1024）正是"文案与判据不同源"的起点：改了口径忘了改例子，例子就成了谎话。
 */
export function kInputTitle(what: string, base: TokenBase): string {
  return `${what}（单位 K token；本行 1 K = ${base} token，输入 32 = ${32 * base} token）`;
}