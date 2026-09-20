/**
 * gui/src/main/localServerProbe.ts — 本地推理端点「能力问询」的 **IO 侧**（计划 S1）。
 *
 * 纯逻辑（解析、状态判定、上限决策）在 `core-ts/src/model_introspect.ts`；本文件只做三件事：
 *   ① 把 baseUrl 定出来；② 发两个只读 GET；③ 缓存，别把服务器问爆。
 *
 * ── 为什么必须真的去问，而不是"按配置推" ──────────────────────
 * 本机存在**两种**"本地模型"，配置里看不出区分：
 *   (a) slime 托管的 llama-server（`agent.model_choice = "local:<id>"`，端口由 ModelServerManager 分配）
 *   (b) 一个**指向本机**的普通 provider（`api_base = "http://127.0.0.1:8800/v1"`，用户自己拉起来的进程）
 * 两者都不在 slime 的启动记录里 —— (b) 尤其：`data/model_servers.json` 里根本没有它。
 * 所以"我们给它的 n_ctx 是多少"这个问题，(b) 的答案**只有服务器自己知道**：
 * 用户可能用 `-c 32768` 手动起、也可能用 `-c 8192`，配置里一个字都没有。
 * 结论：判据只能是**发请求**（`GET /props` → `default_generation_settings.n_ctx`）。
 *
 * ── 与 ModelServerManager 的关系 ──────────────────────────────
 * (a) 的端口从它拿（内存 status + 跨进程 registry 兜底）；但**不向它要 n_ctx** ——
 * `instances[].ctx_len` 是**我们打算**给的值，不是它**实际**生效的值
 * （启动参数可能被下游改写、用户可能手动重启）。打算 ≠ 事实，这正是 A-1018 ③ 的教训。
 *
 * 关键约束：**本模块任何路径都不得抛异常**。它被 done 载荷的构造调用，抛出去会让整轮对话
 * 的 done 事件发不出去（比"窗口上限算错"严重得多）。所有失败都降级成 `down` 快照。
 */

/* ⚠️ 用**相对路径**而不是 `core-ts/...` 别名：`gui/src/main/` 下既有文件一律如此
   （见 index.ts 的一长串 `../../../core-ts/src/*.js`）。别名只在 core-ts 内部生效，
   混用会让 tsc 与 electron-vite 的解析结果不一致。 */
import { ModelServerManager, getModelServer, ServerState } from "../../../core-ts/src/model_server.js";
import {
  emptyCapability,
  type LocalServerCapability,
} from "../../../core-ts/src/model_introspect.js";
/* S4-B：**IO 原语搬到 core-ts**（`core-ts/src/local_server_io.ts`）——因为生命周期管理
   （`ModelServerManager.probeLive`）也要问同一批端点，而 core-ts 不能反向 import gui。
   搬走之后本文件继续 re-export，保证既有的 import 路径与测试/守卫锚点全部不变。 */
import {
  PROBE_TIMEOUT_MS,
  stripApiSuffix,
  propsUrlFor,
  modelsUrlFor,
  probeLocalEndpoint,
} from "../../../core-ts/src/local_server_io.js";

export { PROBE_TIMEOUT_MS, stripApiSuffix, propsUrlFor, modelsUrlFor, probeLocalEndpoint };

/** 缓存有效期（ms）。done 事件在一条流里可能出现多次（主回复 + 工具循环），
 *  同一轮里问一遍就够了；但也不能永久缓存 —— 用户可能刚改了模型/重启了服务。 */
const CACHE_TTL_MS = 2000;

interface CacheEntry { at: number; cap: LocalServerCapability }
const cache = new Map<string, CacheEntry>();

/** 清缓存。
 *
 *  ⚠️ S4-D 修正：此前注释写的是"测试与模型切换/服务重启事件用"，但**没有任何生产调用点** ——
 *  也就是"模型切换时会清缓存"这件事从来没发生过（A-1014-C2 的老病：开关/函数没有读取者）。
 *  真实后果：`probeManagedChatCapability()` 调 `getLocalCapability()` 时不传 alias，
 *  缓存 key 只到端口；而模型切换就在同一个端口上发生 → 切换后最多 2s 会拿**上一个模型**的
 *  `n_ctx` 去回答（A-1018 ③ 的形状）。
 *  现在的唯一作废点：`gui/src/main/index.ts` 的 `onChatState`（状态迁移广播 = 端口上发生了什么的真值来源）。
 *  守卫见 `tests/core-ts/a1025-guards.spec.ts` 的 S4-D 段（含"必须有生产读取者"的断言）。 */
export function clearLocalCapabilityCache(): void {
  cache.clear();
}

/** baseUrl 是否指向**本机**。
 *  只有本机端点才值得问 `/props` —— 远端 OpenAI 兼容网关没有这个端点，
 *  盲发一次 404 只会拖慢 done 载荷的构造。 */
export function isLoopbackBaseUrl(base: string): boolean {
  const b = (base ?? "").trim().toLowerCase();
  if (!b) { return false; }
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/.test(b);
}

/** 带缓存的问询（对外主入口）。**永不抛**：最坏返回 `down` 快照。 */
export async function getLocalCapability(base: string, opts: { timeoutMs?: number; alias?: string; bypassCache?: boolean } = {}): Promise<LocalServerCapability> {
  const key = `${stripApiSuffix(base)}|${opts.alias ?? ""}`;
  const now = Date.now();
  if (!opts.bypassCache) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) { return hit.cap; }
  }
  let cap: LocalServerCapability;
  try {
    cap = await probeLocalEndpoint(base, opts);
  } catch {
    /* probeLocalEndpoint 自身已不抛；这里是第二道保险 —— 本模块不许把异常带上调用栈。 */
    cap = emptyCapability("down");
  }
  cache.set(key, { at: now, cap });
  return cap;
}

/**
 * 归一化模型路径用于比较。
 * Windows 上同一个文件可能写成 `D:\a\b.gguf` 或 `D:/a/B.GGUF`，直接字符串比较会永久判否。
 * ⚠️ 本仓库已有同类教训：`ModelServerManager.isChatReady` 被删掉，正是因为它拿
 * `local:<id>` 解析出的路径跟 `instances.chat.model_path` 做**裸字符串比较**，
 * 于是"模型已就绪却每轮都弹加载面板"（见 model_server.ts 的删除注释）。
 */
export function normalizeModelPath(p: string): string {
  return (p ?? "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
}

/**
 * 这份能力快照是不是**正在服务这个模型**。
 *
 * 为什么必须问这一句：托管的 chat 实例一次只服务**一个**模型（`max_instances = 1`）。
 * 若拿"正在跑的那个模型的 n_ctx"去回答"另一个本地模型的窗口是多少"，
 * 就是把 A-1018 ③ 换了个位置重演 —— 变成"界面按 A 模型的窗口显示、请求发给 B 模型"。
 *
 * 判据（从强到弱）：
 *   ① `path`：与 `/props.model_path` 归一化后比较 —— 最强证据
 *   ② `ids` ：与 `alias`（`--alias` 命名时是别名，未设时是模型路径）比较
 *   ③ `trustedEndpoint`：调用方已经确认"这个 baseUrl 就是该模型的地址"（loopback provider 场景）。
 *      此时**不再**要求快照自证身份 —— provider 配置本身就是证据。
 */
export function capabilityMatchesModel(
  cap: LocalServerCapability,
  model: { path?: string | null; ids?: string[]; trustedEndpoint?: boolean },
): boolean {
  if (model.trustedEndpoint) { return true; }
  const wantPath = model.path ? normalizeModelPath(model.path) : "";
  const gotPath = cap.modelPath ? normalizeModelPath(cap.modelPath) : "";
  if (wantPath && gotPath) { return wantPath === gotPath; }
  const ids = (model.ids ?? []).filter(Boolean);
  if (ids.length > 0 && cap.alias) {
    const alias = normalizeModelPath(cap.alias);
    return ids.some((id) => normalizeModelPath(id) === alias || normalizeModelPath(id) === gotPath);
  }
  /* 问不出身份 → **不认**。宁可回落同域兜底，也不要一个可能是别的模型的数字。 */
  return false;
}

/**
 * slime 托管的 chat 实例端口（只取**已就绪**的）。
 *
 * 两路来源，缺一不可：
 *   - 内存状态：本进程刚拉起来的实例（最快、最准）
 *   - registry：**跨进程**兜底 —— 开发模式下渲染/主进程或另一个 slime 实例先起过服务时，
 *     内存里没有记录，但 `data/model_servers.json` 里有端口。少了这一路，
 *     就会"服务明明在跑，却问不到它的窗口"。
 */
export function managedChatPorts(): number[] {
  const ports = new Set<number>();
  try {
    const mgr = getModelServer();
    if (mgr) {
      for (const it of mgr.status()) {
        if (it.role === "chat" && it.state === ServerState.READY && it.port > 0) { ports.add(it.port); }
      }
    }
  } catch { /* 状态查询失败不影响下面的 registry 兜底 */ }
  try {
    const reg = ModelServerManager.readRegistry();
    const chat = reg?.["chat"] as { port?: unknown; state?: unknown } | undefined;
    const port = Number(chat?.port ?? 0);
    if (port > 0 && (chat?.state === undefined || chat?.state === ServerState.READY)) {
      ports.add(port);
    }
  } catch { /* registry 读失败就只用内存状态 */ }
  return [...ports];
}

/**
 * 问出「本机 chat 服务的有效窗口」。找不到任何本机端点 → `null`。
 * 多端点时取**第一个报出有效窗口的**（正常只有一个 chat 实例）。
 *
 * @param expect 期望身份（见 capabilityMatchesModel）。给了就只接受**自证匹配**的快照。
 */
export async function probeManagedChatCapability(
  expect: { path?: string | null; ids?: string[] } = {},
): Promise<LocalServerCapability | null> {
  const ports = managedChatPorts();
  if (ports.length === 0) { return null; }
  let last: LocalServerCapability | null = null;
  for (const port of ports) {
    const cap = await getLocalCapability(`http://127.0.0.1:${port}`);
    if (cap.state === "ready" && cap.effectiveCtx !== null && capabilityMatchesModel(cap, expect)) { return cap; }
    last ??= cap;
  }
  return last;
}
