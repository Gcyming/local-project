/**
 * core-ts/src/llm/rpmLimiter.ts — A-1091：**上游 RPM（每分钟请求数）限流器**。
 *
 * ## 为什么需要它
 *
 * 上游厂商对「每分钟能发多少次请求」有硬上限，超了就 429 / 连接被中断。
 * 用户侧的表现是「生成到一半标红」「偶尔失败重试」——**没人会想到是自己把限额用超了**。
 * 而限额是**会变的官方参数**：2026-09-23 Agnes 把免费档 RPM 从 20 下调到 10（官方公告），
 * 我们这边毫无感知，于是继续按旧节奏打，用户持续踩限流。
 *
 * 本模块把「每分钟最多发几次」变成一个**被执行的判据**，而不是一句注释。
 *
 * ## 四层取值（判据唯一）
 *
 *   ① **实测**（上游响应头 `x-ratelimit-limit-requests` / `ratelimit-limit`…）—— 最可信，随环境变化
 *   ② **手填**（用户在「模型供应商 → 配置栏」里自己填的 RPM）—— 兜底中的兜底：探针与本地表
 *      全都失效时，用户仍能凭官方文档 / 合同 / 实测经验亲手定一个额度（`manualRpm`）
 *   ③ **声明**（能力表 `resolveDeclaredRpm`，官方公布档位）—— 没探测到时的安全兜底
 *   ④ **未知** —— `resolveRpm` 返回 `null` ⇒ **直接放行，不发明阈值**
 *
 * ⚠️ 第 ④ 条是刻意的：**未知不等于无限，但绝不能猜一个数去卡人**。
 *    凭空发明一个低阈值会让"能用"变"不能用"，比不限制更糟。
 * ⚠️ 手填（②）排在声明（③）**之前**：用户手填的一定是他当下真实的额度（可能是付费档、也可能是
 *    为避限流刻意压低的自保值），官方免费档的声明值只是"没别的信息时的猜测"，不该压过用户。
 *    但手填**不能压过实测**（①）：实测是上游**当前账号**的真实回应，比任何人工输入都准。
 *
 * ## 边界（都刻意保守）
 *
 * - `rpm <= 0` 或非有限 ⇒ 视为**未知**（放行）。坏配置的降级方向必须是"能用"，不是"全锁死"。
 * - 429 时按 `Retry-After` 冷却该供应商；**不做自适应降额**（会把额度单向棘轮降到底且不可预测）。
 *   判据必须确定性 —— 同一个上游今天和明天拿到同样的头，行为必须一样。
 * - 窗口是**滑动**的（不是固定分桶）：固定分桶会在桶边界放行 2×rpm，那正是触发限流的经典形态。
 *
 * 纯逻辑、可注入时钟与 sleep ⇒ 可单测、可变异（不依赖真实时间/网络）。
 */
import { resolveDeclaredRpm } from "shared/model-capabilities";

/** 默认滑动窗口：一分钟（与 RPM 的定义同源） */
export const RPM_WINDOW_MS = 60_000;

/** 命中 429 但上游没给 Retry-After 时的默认冷却（秒）。保守取值：宁可多等一点。 */
export const DEFAULT_429_COOLDOWN_S = 20;

/**
 * 边界容差（ms）：窗口滑动到正好 `hits[0] + window` 时，上游的计数可能还没翻页
 * （客户端时钟与服务端有偏差、上游按对齐窗口计数）⇒ 提前放行会偶发 429。
 * 多等这一点点，换"不撞线"。
 */
export const WINDOW_EPSILON_MS = 250;

/** RPM 档位的来源（UI/诊断要如实标注，不许把"声明"说成"实测"、也不许把"手填"说成"实测"） */
export type RpmSource = "observed" | "manual" | "declared" | "unknown";

export interface RpmResolution {
  /** 生效的每分钟额度；`null` = 未知（放行，不发明阈值） */
  rpm: number | null;
  source: RpmSource;
}

/** 判定一个额度值是否可用（`<=0` / 非有限 / 非整数 ≤ 0 一律视为"没这个信息"） */
function usableRpm(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1;
}

/**
 * 四层取值**唯一实现**：实测 > 手填 > 声明 > 未知。
 *
 * ⚠️ 不要在这里加"取两者较小值"之类的聪明规则：实测值是上游**当前账号**的真实档位，
 *    声明值是**免费档**的官方值。付费账号的实测值会**大于**声明值（如企业档 20 > 免费 10），
 *    取小会把付费用户按免费档限死。**实测优先就是唯一正确的口径。**
 *
 * ⚠️ 手填（`manual`）插在实测与声明之间，理由是二者的**可信度与时效性**不同：
 *    · 实测 = 上游此刻对**这个账号**的真实回应（最权威，且会随环境变化）；
 *    · 手填 = 用户根据官方文档/合同/经验**主动设定**的额度（用户比内置表更了解自己的档位）；
 *    · 声明 = 内置表里那条**免费档的通用猜测**（我们替用户猜的，最不该压过用户自己的设定）。
 *    但手填**不能压过实测** —— 实测是上游亲口说的，任何人工输入都不该盖过它。
 */
export function resolveRpm(
  observed: number | null | undefined,
  declared: number | null | undefined,
  manual?: number | null,
): RpmResolution {
  if (usableRpm(observed)) { return { rpm: observed, source: "observed" }; }
  if (usableRpm(manual)) { return { rpm: manual, source: "manual" }; }
  if (usableRpm(declared)) { return { rpm: declared, source: "declared" }; }
  return { rpm: null, source: "unknown" };
}

export interface RateLimitHeaders {
  limitRequests?: number;
  remainingRequests?: number;
  /** Retry-After 归一为**秒**（RFC 7231：秒数或 HTTP-date） */
  retryAfterS?: number;
  /**
   * 该头描述的窗口长度（秒）。**只有恰好 60 才用于 RPM** ——
   * `ratelimit-limit` 这类草稿头自带 `;w=<秒>`，w=1 的"每秒 10 次"当 RPM 用会放大 60 倍。
   */
  windowS?: number;
}

/**
 * 从上游响应头解析限流信息（多厂商字段名归一）。
 *
 * 覆盖的字段名（都是**公开文档**里的形态，不猜）：
 *   - OpenAI / Azure：`x-ratelimit-limit-requests` / `x-ratelimit-remaining-requests`
 *   - IETF 草案（部分网关）：`ratelimit-limit` / `ratelimit-remaining`，可带 `;w=<秒>`
 *   - 通用回退：`x-ratelimit-limit`
 *   - `retry-after`（秒数或 HTTP-date，RFC 7231）
 *
 * @param get 取头函数（大小写不敏感由调用方保证，如 `Headers.prototype.get`）
 * @param nowMs 解析 HTTP-date 形态 Retry-After 时的"现在"（可注入，便于单测）
 */
export function parseRateLimitHeaders(
  get: (name: string) => string | null | undefined,
  nowMs: number = Date.now(),
): RateLimitHeaders {
  const out: RateLimitHeaders = {};
  const num = (name: string): number | undefined => {
    const raw = get(name);
    if (raw === null || raw === undefined) { return undefined; }
    const n = Number(String(raw).trim());
    return Number.isFinite(n) ? n : undefined;
  };

  // ── 上限 ──
  const direct = num("x-ratelimit-limit-requests") ?? num("x-ratelimit-limit");
  const draftRaw = get("ratelimit-limit");
  if (direct !== undefined && direct >= 0) {
    out.limitRequests = direct;
  } else if (draftRaw) {
    // `ratelimit-limit: 10` 或 `ratelimit-limit: 10;w=60`（window 单位 = 秒）
    const m = /^\s*(\d+)\s*(?:;\s*w\s*=\s*(\d+))?\s*$/i.exec(String(draftRaw));
    if (m) {
      out.limitRequests = Number(m[1]);
      if (m[2] !== undefined) { out.windowS = Number(m[2]); }
    }
  } else {
    const w = /(?:^|;)\s*w\s*=\s*(\d+)/i.exec(String(get("ratelimit-limit") ?? ""));
    if (w) { out.windowS = Number(w[1]); }
  }

  // ── 剩余 ──
  const rem = num("x-ratelimit-remaining-requests") ?? num("ratelimit-remaining");
  if (rem !== undefined && rem >= 0) { out.remainingRequests = rem; }

  // ── Retry-After（秒数或 HTTP-date）──
  const ra = get("retry-after");
  if (ra !== null && ra !== undefined && String(ra).trim() !== "") {
    const s = String(ra).trim();
    const secs = Number(s);
    if (Number.isFinite(secs) && secs >= 0) {
      out.retryAfterS = Math.ceil(secs);
    } else {
      const t = Date.parse(s);
      if (Number.isFinite(t)) { out.retryAfterS = Math.max(0, Math.ceil((t - nowMs) / 1000)); }
    }
  }
  return out;
}

/** 从一组限流头里取出**可当作 RPM 用**的额度：窗口不是 60s 的一律丢弃 */
export function rpmFromHeaders(h: RateLimitHeaders): number | undefined {
  if (h.limitRequests === undefined) { return undefined; }
  if (h.windowS !== undefined && h.windowS !== 60) { return undefined; }
  return usableRpm(h.limitRequests) ? h.limitRequests : undefined;
}

export interface AcquirePlan {
  /** 本次需要等待的毫秒数（0 = 立刻可发） */
  waitMs: number;
  /** 裁剪后的窗口（去掉已过期的时间戳 + 本次若立刻放行则把 now 计入） */
  keep: number[];
}

/**
 * **取令牌的纯判据**（唯一实现）：给定窗口内已用掉的时间戳与额度，算出该等多久。
 *
 * 滑动窗口语义：窗口内命中数 `< rpm` ⇒ 立刻放行（把 `now` 记进窗口）；
 * 否则等到**最早那一次**滑出窗口为止（`hits[0] + windowMs + EPSILON - now`）。
 *
 * ⚠️ 返回的 `keep` **不含**本次（等待的情况）——放行方负责在真正发出时再记账。
 *    这样"等待"与"占用额度"不会耦合：一次 acquire 只应该消耗一个额度。
 * ⚠️ `hits` 必须已按时间升序（调用方维护）；这里仍做一次过滤以保证"过期即出窗口"。
 */
export function planAcquire(
  now: number,
  hits: readonly number[],
  rpm: number,
  windowMs: number = RPM_WINDOW_MS,
): AcquirePlan {
  const fresh = hits.filter((t) => Number.isFinite(t) && now - t < windowMs);
  if (!usableRpm(rpm)) { return { waitMs: 0, keep: fresh }; }
  if (fresh.length < rpm) { return { waitMs: 0, keep: [...fresh, now] }; }
  const earliest = fresh[0];
  const waitMs = earliest + windowMs + WINDOW_EPSILON_MS - now;
  return { waitMs: waitMs > 0 ? waitMs : 0, keep: fresh };
}

/** 时钟与睡眠（可注入 ⇒ 单测/变异不碰真实时间） */
export interface LimiterClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface KeyState {
  /** 窗口内已放行的请求时间戳（升序） */
  hits: number[];
  /** 实测到的上游额度（响应头）；`null` = 还没探测到 */
  observedRpm: number | null;
  /** 429 冷却截止时间（ms）；未命中 429 时不存在 */
  cooldownUntil?: number;
}

/** 每个 key 默认保留的窗口条目上限（防一个 key 长期高频把内存撑爆；远超任何真实 rpm） */
const MAX_HITS_PER_KEY = 512;

/**
 * 按 key（供应商）分桶的 RPM 限流器。
 *
 * 用法（**必须**在真正发请求之前 await）：
 *   `await limiter.acquire(providerKey, model)` —— 额度用完时它会等到窗口滑动。
 *   `limiter.observe(providerKey, headers, status)` —— 收到响应后回喂，用于实测与冷却。
 */
export class RpmLimiter {
  private readonly clock: LimiterClock;
  private readonly windowMs: number;
  private readonly states = new Map<string, KeyState>();
  /** 声明的 RPM 解析器（**默认走能力表** `resolveDeclaredRpm`；测试可注入，不依赖真实表） */
  private readonly declaredOf: (model: string | undefined) => number | null | undefined;
  /** 手填的 RPM 解析器（**默认无** ⇒ 只走能力表；GUI 侧按供应商/模型注入，见 `setManualRpmOf`） */
  private manualOf: (key: string, model: string | undefined) => number | null | undefined;

  constructor(opts: {
    clock?: LimiterClock;
    windowMs?: number;
    declaredOf?: (model: string | undefined) => number | null | undefined;
    /** A-1092：用户手填 RPM 的解析器（`(供应商键, 模型) => 手填值 | null`）。缺省 = 无手填。 */
    manualOf?: (key: string, model: string | undefined) => number | null | undefined;
  } = {}) {
    this.clock = opts.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    this.windowMs = opts.windowMs ?? RPM_WINDOW_MS;
    // ⚠️ 默认解析器 = 能力表（唯一真相源）。**不要**在这里再维护一张 rpm 表：
    //    官方一改档位就有两个地方要改，漏一个就是"改了一半"，而症状只是零星 429。
    this.declaredOf = opts.declaredOf ?? ((model) => (model ? resolveDeclaredRpm(model)?.rpm ?? null : null));
    // ⚠️ 默认**没有**手填来源 —— 手填值住在 providers 表（GUI 主进程），core-ts 不该反向依赖它。
    //    接线由 GUI 侧在启动/配置变更时注入（见 `setManualRpmOf`）。
    this.manualOf = opts.manualOf ?? (() => null);
  }

  /**
   * A-1092：注入/更新**手填 RPM** 的来源（GUI 侧在 providers 表加载/保存后调用）。
   *
   * 为什么做成 setter 而不是构造参数：共享实例是进程级单例（`getSharedRpmLimiter`），
   * 而 providers 表会在用户编辑后**热更新** —— 需要一个不重建实例就能换解析器的入口
   * （重建实例会丢掉已有窗口计数与实测额度）。
   */
  setManualRpmOf(fn: (key: string, model: string | undefined) => number | null | undefined): void {
    this.manualOf = fn;
  }

  private state(key: string): KeyState {
    let s = this.states.get(key);
    if (!s) { s = { hits: [], observedRpm: null }; this.states.set(key, s); }
    return s;
  }

  /** 该 key 当前生效的额度与来源（诊断/UI 用） */
  resolve(key: string, model?: string): RpmResolution {
    let manual: number | null | undefined;
    try {
      manual = this.manualOf(key, model);
    } catch {
      // 手填解析器抛错绝不拖垮请求（与 observe 同一纪律）——降级为"没有手填"
      manual = null;
    }
    return resolveRpm(this.state(key).observedRpm, this.declaredOf(model), manual);
  }

  /**
   * 取一个令牌（发请求前调用）。额度用完则**等到**窗口滑动 ——
   * 绝不抛错、绝不静默丢弃请求（丢弃 = 用户看到"什么都没发生"）。
   */
  async acquire(key: string, model?: string): Promise<{ waitedMs: number; source: RpmSource }> {
    const s = this.state(key);
    let waited = 0;
    for (;;) {
      const now = this.clock.now();
      // 429 冷却优先（上游明确要求等待，不要靠自己的额度推算）
      if (s.cooldownUntil !== undefined && now < s.cooldownUntil) {
        const ms = s.cooldownUntil - now;
        await this.clock.sleep(ms);
        waited += ms;
        continue;
      }
      if (s.cooldownUntil !== undefined && now >= s.cooldownUntil) { s.cooldownUntil = undefined; }
      const { rpm, source } = this.resolve(key, model);
      if (rpm === null) { return { waitedMs: waited, source }; }   // 未知 → 放行（不发明阈值）
      const plan = planAcquire(now, s.hits, rpm, this.windowMs);
      if (plan.waitMs <= 0) {
        s.hits = plan.keep.length > MAX_HITS_PER_KEY ? plan.keep.slice(-MAX_HITS_PER_KEY) : plan.keep;
        return { waitedMs: waited, source };
      }
      await this.clock.sleep(plan.waitMs);
      waited += plan.waitMs;
    }
  }

  /**
   * 回喂一次上游响应。
   *
   * @param status 上游 HTTP 状态码（429 时启用冷却）
   */
  observe(key: string, headers: RateLimitHeaders, status?: number, nowMs?: number): void {
    const s = this.state(key);
    const at = nowMs ?? this.clock.now();
    const rpm = rpmFromHeaders(headers);
    if (rpm !== undefined) { s.observedRpm = rpm; }
    if (status === 429) {
      const secs = headers.retryAfterS !== undefined && headers.retryAfterS >= 0
        ? headers.retryAfterS
        : DEFAULT_429_COOLDOWN_S;
      const until = at + secs * 1000;
      // 取较晚者：并发的多个 429 不该把冷却**缩短**
      s.cooldownUntil = s.cooldownUntil === undefined ? until : Math.max(s.cooldownUntil, until);
    }
  }

  /** 清理某 key 的状态（配置变更/供应商移除时调用） */
  reset(key?: string): void {
    if (key === undefined) { this.states.clear(); } else { this.states.delete(key); }
  }

  /** 诊断快照（不含凭据；可落盘/显示） */
  snapshot(): Array<{ key: string; observedRpm: number | null; windowUsed: number; cooling: boolean }> {
    const now = this.clock.now();
    return [...this.states.entries()].map(([key, s]) => ({
      key,
      observedRpm: s.observedRpm,
      windowUsed: s.hits.filter((t) => now - t < this.windowMs).length,
      cooling: s.cooldownUntil !== undefined && now < s.cooldownUntil,
    }));
  }
}

let shared: RpmLimiter | null = null;

/** 进程内共享实例（引擎/网关同进程共用一份窗口状态，避免各持一份而合起来超限） */
export function getSharedRpmLimiter(): RpmLimiter {
  if (!shared) { shared = new RpmLimiter(); }
  return shared;
}

export function setSharedRpmLimiter(l: RpmLimiter | null): void {
  shared = l;
}
