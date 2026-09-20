/**
 * core-ts/src/local_server_io.ts — 本机推理端点的 **IO 原语**（计划 S4-B 抽出）。
 *
 * ── 三层分工（别把职责搅在一起） ──────────────────────────────
 *   ① 本文件               —— **怎么问**：拼 URL、超时、容错 JSON、永不抛异常。
 *   ② `model_introspect.ts` —— **答案是什么意思**：三态判定、字段解析、窗口上限决策（纯函数、无 IO）。
 *   ③ `model_server.ts` / `gui/src/main/localServerProbe.ts` —— **谁在问、问完干什么**。
 *
 * ── 为什么必须抽出来（不是"顺手重构"） ────────────────────────
 * 这段代码原先是 `gui/src/main/localServerProbe.ts` 的私有实现，于是 **core-ts 用不到它**：
 * `ModelServerManager` 只能自己再写一份 `/health` 探测 —— 那份只看 `200 + {status:"ok"}`，
 * 于是**加载中的实例（503 `unavailable_error`）被读成"端口上什么都没有"**，
 * `probeLive` 判否 → `findFreePort` 跳过该端口 → 在隔壁端口又拉起一个**同样的模型** → 双份显存。
 * 同一个事实（"这个端口上有没有 llama-server"）有两个产地，且没有一方会抱怨。
 * 收口到本文件后，生命周期管理与能力问询共用**同一次请求语义**（同 header、同超时口径、同容错）。
 *
 * ── 与 `joinApiEndpoint` 的关系 ────────────────────────────────
 * 不复用 `llm/client.ts` 的 `joinApiEndpoint`：那个函数处理的是**云厂商**的版本段通配
 * （智谱 `/api/paas/v4` 之类），而这里的 base 是本机 origin，需要的是**剥掉**版本尾巴
 * （`/props` 在根路径下，不在 `/v1` 下）。两件事，故意不统一（对齐 A-1008 的判断）。
 */
import { readLocalCapability, type LocalServerCapability } from "./model_introspect.js";

/** 单次问询的超时（ms）。刻意压得很短：
 *  本机 llama-server 的 `/props` 是内存里拼 JSON，正常 <10ms；
 *  超过 600ms 基本就是"进程在忙/在换了"，此时**宁可知不知道**也不要把对话卡住。
 *  （能力问询只拿它做展示与记账口径，不是硬闸门。） */
export const PROBE_TIMEOUT_MS = 600;

/** 去掉 `/v1`、`/v1/`、`/api/v1` 等版本尾巴，只留 origin+前缀 */
export function stripApiSuffix(base: string): string {
  return (base ?? "").trim().replace(/\/+$/, "").replace(/\/(api\/)?v\d+$/, "");
}

/** 拼出待探测的 URL（`/props` 在根路径下，不在 `/v1` 下） */
export function propsUrlFor(base: string): string {
  return `${stripApiSuffix(base)}/props`;
}

export function modelsUrlFor(base: string): string {
  return `${stripApiSuffix(base)}/v1/models`;
}

/** 一次 GET：返回 `{ status, body }`；任何异常 → `{ status: null, body: undefined }`。
 *  ⚠️ `status: null` 专门表示"**没连上**"，与"连上了但 503"必须区分（前者 down、后者 loading）。 */
export async function getJson(url: string, timeoutMs: number): Promise<{ status: number | null; body: unknown }> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    let body: unknown;
    try { body = await resp.json(); } catch { body = undefined; }
    return { status: resp.status, body };
  } catch {
    // ECONNREFUSED / 超时 / 非法 JSON —— 一律"没连上"。调用方据此判 down。
    return { status: null, body: undefined };
  }
}

/**
 * **只问 `/props`** 的能力快照。生命周期管理用这一路。
 *
 * 为什么可以用单端点代替 `probeLocalEndpoint`：判状态（ready/loading/down）与读身份
 * （`model_alias` / `model_path`）都在 `/props` 里，而**训练上限** `n_ctx_train` 只在
 * `/v1/models` —— 那是"窗口上限"的用途，生命周期管理不需要它。
 * 一次请求 vs 两次，在 `probeLive` 要扫 100 个端口时是 200 次 vs 100 次。
 *
 * 两个端点都走 `readLocalCapability`（**唯一的判定实现**），所以"只问一个端点"不会产生
 * 第二套状态判据 —— 只是少喂一个输入。
 */
export async function probeLocalProps(base: string, opts: { timeoutMs?: number } = {}): Promise<LocalServerCapability> {
  const r = await getJson(propsUrlFor(base), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  return readLocalCapability({ props: r.body, propsStatus: r.status });
}

/** 向单个本机端点问询**完整**能力（含 `/v1/models` 的训练上限）。不缓存、不抛。 */
export async function probeLocalEndpoint(base: string, opts: { timeoutMs?: number; alias?: string } = {}): Promise<LocalServerCapability> {
  const timeout = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const [props, models] = await Promise.all([
    getJson(propsUrlFor(base), timeout),
    getJson(modelsUrlFor(base), timeout),
  ]);
  return readLocalCapability({
    props: props.body,
    propsStatus: props.status,
    models: models.body,
    modelsStatus: models.status,
    alias: opts.alias,
  });
}
