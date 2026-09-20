/**
 * core-ts/src/model_server.ts — 本地模型生命周期管理（编排层）。
 * 语义移植自 core/model_server.py（A-003/A-017/H1/H2/N10-M5/M6/M7 全量对照）。
 *
 * 职责：llama-server spawn/terminate + nvidia-smi VRAM 监控 + 预算检查 +
 *       load/unload 决策 + 空闲卸载 + registry 落盘 + 崩溃残留孤儿回收。
 * 执行面（llama-server 二进制）不变，推理/嵌入仍由 sidecar（Python 优点面）消费。
 *
 * 与 Python 的关键差异：
 *  - spawn 用 { detached: true, windowsHide: true }（Windows 等效 CREATE_NEW_PROCESS_GROUP）
 *  - 全部 IO 为 async（fetch / net / child_process）
 *  - registry 路径可注入（测试用），默认 data/model_servers.json
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { PROJECT_ROOT } from "./paths.js";
import { resolve, basename, dirname } from "node:path";
import { classifyLocalServer, type LocalServerCapability, type LocalServerState } from "./model_introspect.js";
import { probeLocalProps } from "./local_server_io.js";
import {
  readGgufMeta,
  estimateGpuFootprintGb,
  SUPPORTED_KV_TYPES,
  KV_CACHE_BYTES_PER_ELEMENT,
} from "./gguf_meta.js";

export { PROJECT_ROOT };
const DEFAULT_REGISTRY_PATH = resolve(PROJECT_ROOT, "data", "model_servers.json");

export const IS_WINDOWS = process.platform === "win32";

// ── 状态模型（对照 ServerState） ──────────────────────────

export const ServerState = {
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  UNLOADING: "unloading",
} as const;

export type ServerStateValue = (typeof ServerState)[keyof typeof ServerState];

/** A-1017：chat 实例的状态迁移事件（供 GUI 决定「正在加载本地模型」面板的显隐）。
 *
 *  为什么由管理器广播、而不是让调用方自己判断"加载了没有"：
 *  "是否已加载"是本类的私有状态。调用方要从外部回答它，就得自己再读一份 providers 表把
 *  `local:<id>` 解析成一个路径，再拿路径跟 `instances.chat.model_path` 做**裸字符串比较** ——
 *  引擎用的是它构造时的 providers 快照、GUI 读的是实时盘上文件，两边一旦不一致就**永久判否**，
 *  于是模型明明已就绪、每轮对话仍弹一次全屏「正在加载本地模型」（用户报的"每次都加载"）。
 *  真值只有一个来源，判据就必须由这个来源广播。 */
export interface ChatStateEvent {
  state: ServerStateValue;
  /** 传给 ensure() 的模型名（即 `local:<id>` 里的 id） */
  modelName: string;
  modelPath: string;
  error?: string;
}

// ── VRAM 监控（对照 VRAMMonitor） ─────────────────────────

export interface VRAMSample {
  total_gb: number;
  used_gb: number;
  free_gb: number;
}

/** nvidia-smi 采样；失败/无 GPU 返回 null（调用方跳过预算检查）。N10-M5: execFileSync 全路径，防 PATH 劫持。 */
export class VRAMMonitor {
  sample(): VRAMSample | null {
    try {
      const out = execFileSync(
        "nvidia-smi",
        ["--query-gpu=memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
        { timeout: 5000, windowsHide: true, encoding: "utf8" },
      );
      const parts = (out || "").trim().split(",");
      if (parts.length < 3) return null;
      return {
        total_gb: Math.round((parseFloat(parts[0].trim()) / 1024) * 100) / 100,
        used_gb: Math.round((parseFloat(parts[1].trim()) / 1024) * 100) / 100,
        free_gb: Math.round((parseFloat(parts[2].trim()) / 1024) * 100) / 100,
      };
    } catch {
      return null;
    }
  }
}

// ── ModelBackend（对照 ModelBackend） ─────────────────────

export interface BackendArgs {
  llamaBin: string;
  modelPath: string;
  port: number;
  gpuLayers: number;
  ctxLen: number;
  embedding?: boolean;
  /** KV cache 量化类型（A-1021）。缺省不下发 `-ctk/-ctv` → llama.cpp 用它自己的默认 f16。 */
  kvTypeK?: string;
  kvTypeV?: string;
  /** S4-A：llama-server 的 `-a/--alias`（实例的**自述身份**）。空串/纯逗号 → 不下发。 */
  alias?: string;
}

/**
 * S4-A：清洗要下发给 `--alias` 的别名 —— **唯一出处**，别在调用点各自 replace。
 *
 * 为什么必须清洗（`llama-server --help` 实测，b10509）：
 *   `-a, --alias STRING   set model alias (default: model path if not specified), can be
 *                         comma-separated for multiple aliases`
 * 即 **逗号是别名列表的分隔符**。本地模型 id 一旦含逗号，llama-server 会把它拆成两个别名，
 * `/v1/models.data[].id` 只剩前半截 —— 身份识别退化成"部分匹配"，比路径比较更不可靠。
 * 故把逗号统一替换为下划线（保持可读、且不会与任何合法 id 冲突）。
 *
 * 返回空串 = **不下发 `-a`**：这个语义让"没有别名"只有一种表达（而不是 `-a ""` 与"不下发"两种）。
 */
export function sanitizeAlias(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const cleaned = s.replace(/,/g, "_").trim();
  // 全是逗号/空白 → 清洗后没有任何信息量，等同"不指定别名"
  return /^[_\s]*$/.test(cleaned) ? "" : cleaned;
}

/**
 * A-1021：构造 llama-server 的 argv —— **抽成导出的纯函数**，理由有二：
 *  ① KV 量化（`-ctk/-ctv`）是"本地模型能不能起来"的关键开关，必须能被单测直接断言，
 *     而不是只能靠"真起一个 llama-server 看结果"（那样一失败就分不清是参数错还是显存不足）；
 *  ② 本项目已有前科：A-1018 因为把非法取值 `qwen` 传给 `--reasoning-format`，
 *     导致"文件名含 qwen 的模型必然起不来"。参数正确性值得一个可断言的入口。
 */
export function buildLlamaArgv(args: BackendArgs): string[] {
  const argv = [
    "-m", args.modelPath,
    "--port", String(args.port),
    "-ngl", String(args.gpuLayers),
    "-c", String(args.ctxLen),
  ];
  /* S4-A：**具名身份**（`-a/--alias`）。
   *
   * 解决的问题：不给 `--alias` 时，llama-server 把 `-m` 收到的**原样字符串**当成 model_alias
   * （实测：`model_alias = "models/chat/qwen3-1.7b-q8_0.gguf"`，相对路径仍是相对的）。
   * 于是"这个端口上跑的是哪个模型"只能靠**路径字符串比较**回答 ——
   * 调用方用 ① 用户填的路径 ② 配置文件里的路径 ③ 相对/绝对 三种写法各比一次，
   * 只要来路不同就永久判否（A-1017 的"模型已就绪却每轮弹加载面板"正是这一类）。
   *
   * 给了别名后，**运行中的实例自述身份**：`/props.model_alias` 与 `/v1/models.data[].id`
   * 都等于这个别名（本机 llama-server b10509 实测确认），与路径写法彻底解耦。
   * 别名取 slime 侧的本地模型 id（`local:<id>` 里的 id），于是 UI 上叫什么、端口上就叫什么。
   *
   * 安全性：本地路由的请求体**不带 model 字段**（engine 的 local 分支不给 route.model，
   * `withModel()` 因此原样放行），所以改别名不会让任何在途请求被判定为"模型不存在"。 */
  const alias = sanitizeAlias(args.alias);
  if (alias) {
    argv.push("-a", alias);
  }
  /* A-1021：**KV cache 量化** —— 本轮"本地模型起不来"的真正解药。
   *
   * 实测（RTX 4070 Laptop 8G，qwen3-1.7b-q8_0，ctx=32768）：
   *   f16 KV（原行为）: 占用 6653 MiB，空闲 1535 MiB，CUDA 还要 1557 MiB → **差 22 MiB 失败**
   *   q8_0 KV         : 占用 5062 MiB，空闲 3126 MiB → 成功，且实测 96.9 tok/s（对比 f16 的 98.9，仅 -2%）
   *   把 KV 放内存(-nkvo): 3151 MiB 成功，但 66.2 tok/s（-33%）
   * 结论：KV 量化是"几乎不花速度换一半 KV 显存"的唯一划算解 —— 故默认 q8_0，而不是让用户去降 ctx。
   *
   * 取值合法性由「逐字抄自 llama-server --help」的 SUPPORTED_KV_TYPES 把关：
   * 写错一个字母 llama-server 会当场 exit 1（A-1018 已有前科）。非法值这里**静默回退到不下发**
   * （= 保持 f16 原行为），而不是把"用户配置写错"升级成"模型起不来"。
   *
   * embedding 角色不下发：它的 ctx 只有 2048，KV 占比可忽略，没必要引入新变量。 */
  if (!args.embedding) {
    const okK = args.kvTypeK && SUPPORTED_KV_TYPES.includes(args.kvTypeK);
    const okV = args.kvTypeV && SUPPORTED_KV_TYPES.includes(args.kvTypeV);
    if (okK && okV) {
      argv.push("-ctk", String(args.kvTypeK), "-ctv", String(args.kvTypeV));
    }
  }
  if (args.embedding) {
    argv.push("--embedding");
  } else {
    /* 聊天模型：把思考块提取到 `message.reasoning_content`（协议层分离思考与正文）。
     *
     * ⚠️⚠️ A-1018 事故（本机实测，build 10509）：这里原先写的是
     *     `modelName.includes("qwen") ? "qwen" : "deepseek"`
     * —— **llama-server 根本没有 "qwen" 这个取值**。它只认（取自 llama-server 自己的 usage 输出）：
     *     none | deepseek | deepseek-legacy | auto（默认 auto）
     * 传非法值 → 参数解析当场失败、进程 exit 1 → 表现成「启动超时（60s）」，而真原因是
     *     error while handling argument "--reasoning-format": Unknown reasoning format: qwen
     * 于是**只要模型文件名含 qwen，本地模型就必然起不来**（用户症状：本地模型用不了、只能 SILAM 兜底）。
     * 思考提取与模型家族无关，`deepseek` 就是「把思考放进 reasoning_content」那个模式（名字是历史包袱）。
     * 改这里之前请先用 `llama-server --help` 核对取值 —— 不允许凭印象写参数。 */
    argv.push("--reasoning-format", "deepseek");
  }
  return argv;
}

/** llama-server 进程封装。只管理自己 spawn 的进程。 */
export class ModelBackend {
  private process: ChildProcess | null = null;
  private pidVal: number | null = null;
  private portVal = 0;
  private fetchImpl: typeof fetch;
  /** A-1018：子进程输出尾巴（失败归因用）。环形上限 → 常数内存，长日志不会把它撑爆。 */
  private outputTail: string[] = [];
  private static readonly TAIL_MAX_LINES = 30;

  constructor(private llamaBin: string, opts: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get pid(): number | null {
    return this.pidVal;
  }

  get port(): number {
    return this.portVal;
  }

  start(args: BackendArgs): boolean {
    if (!existsSync(this.llamaBin)) {
      console.error(`[model_server] llama-server 不存在: ${this.llamaBin}`);
      return false;
    }
    if (!existsSync(args.modelPath)) {
      console.error(`[model_server] 模型文件不存在: ${args.modelPath}`);
      return false;
    }
    const argv = buildLlamaArgv(args);

    try {
      const child = spawn(this.llamaBin, argv, {
        /* ⚠️ A-1018：此前是 `stdio: "ignore"` —— llama-server 的报错**全被丢掉**，
         * 失败只剩一句"启动超时（60s）"，而真正的死因就写在它的 stderr 里
         * （实测：`llama_model_load: error loading model: tensor '…' data is not within
         *  the file bounds, model is corrupted or incomplete`）。
         * 静默失败 = 精度杀手：用户（和开发者）只能对着"超时"猜。
         * 现在采集 stdout/stderr 的**尾巴**（环形、上限常数条，避免长日志吃内存）并并入错误信息。 */
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: true,
      });
      this.outputTail = [];
      const collect = (buf: Buffer): void => {
        for (const line of buf.toString("utf8").split("\n")) {
          const t = line.trim();
          if (!t) { continue; }
          this.outputTail.push(t);
          if (this.outputTail.length > ModelBackend.TAIL_MAX_LINES) { this.outputTail.shift(); }
        }
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      this.process = child;
      this.pidVal = child.pid ?? null;
      this.portVal = args.port;
      console.log(`[model_server] 启动 llama-server (PID ${this.pidVal}, port ${args.port}): ${basename(args.modelPath)}`);
      return true;
    } catch (e) {
      console.error(`[model_server] 启动失败: ${e}`);
      return false;
    }
  }

  /** 轮询 /health 等待就绪（对照 wait_ready）；signal abort → 立即返回 false */
  async waitReady(timeout = 120, signal?: AbortSignal): Promise<boolean> {
    if (!this.portVal) return false;
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      // 进程已退出（如模型损坏导致 llama-server 崩溃）→ 立即失败，不等满超时
      if (this.process && this.process.exitCode !== null && this.process.exitCode !== undefined) {
        console.warn(
          `[model_server] llama-server 进程已退出（exit ${this.process.exitCode}），加载失败`
            + (this.output ? `\n--- llama-server 输出 ---\n${this.output}` : ""),
        );
        return false;
      }
      try {
        const resp = await this.fetchImpl(`http://127.0.0.1:${this.portVal}/health`, { signal: AbortSignal.timeout(2000) });
        if (resp.status === 200) {
          const data = (await resp.json()) as { status?: string };
          if (data.status === "ok") return true;
        }
      } catch {
        /* 未就绪，继续轮询 */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** 进程是否已退出（waitReady 失败后区分「崩溃」与「超时」） */
  hasExited(): boolean {
    return this.process !== null && this.process.exitCode !== null && this.process.exitCode !== undefined;
  }

  /** A-1018：llama-server 自己的输出尾巴（最后若干行）。失败时并入错误信息，让"启动超时"
   *  变成"模型文件损坏：tensor … is not within the file bounds"。无输出返回空串。 */
  get output(): string {
    return this.outputTail.join("\n");
  }

  /** 停止自己拉起的进程。N10-M7: taskkill 前校验命令行含 llama-server，防 PID 复用误杀。 */
  stop(): void {
    if (!this.process || this.pidVal === null) return;
    if (IS_WINDOWS && !verifyLlamaServerPid(this.pidVal)) {
      console.warn(`[model_server] PID ${this.pidVal} 非 llama-server，跳过 taskkill`);
      this.process = null;
      this.pidVal = null;
      return;
    }
    try {
      if (IS_WINDOWS) {
        execFileSync("taskkill", ["/PID", String(this.pidVal), "/T", "/F"], {
          windowsHide: true, stdio: "ignore", timeout: 5000,
        });
      } else {
        process.kill(-this.pidVal, "SIGTERM"); // 进程组，等效 os.killpg
      }
      // 等待退出（最多 5s，与 Python self._process.wait(timeout=5) 语义对齐）
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (!processAlive(this.pidVal)) break;
        const nap = Math.min(500, deadline - Date.now());
        // 同步等待窗口：用 Atomics.wait 实现确定性 sleep（不阻塞事件循环之外的文件 IO）
        const shared = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(shared, 0, 0, nap);
      }
      console.log(`[model_server] 已停止 PID ${this.pidVal} (port ${this.portVal})`);
    } catch (e) {
      console.warn(`[model_server] 停止 PID ${this.pidVal} 失败: ${e}`);
      try {
        this.process.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    } finally {
      this.process = null;
      this.pidVal = null;
    }
  }

  /** 探测端口是否已有**就绪**的 llama-server 实例（对照 probe_async）。
   *
   *  S4-B：判据从"`/health` 返回 200 且 `status === "ok"`"改为
   *  **`classifyLocalServer()` 判定为 `ready`** —— 三态判定的唯一实现。
   *  ⚠️ 布尔返回值**只回答"能不能用"**，不回答"有没有东西"。加载中的实例（503
   *  `unavailable_error`）在这里是 `false`，而它**确实在监听** —— 要区分这件事请用
   *  管理器层的 `probeImpl`（返回完整能力快照，含 `state`，见 `probeLive`）。
   *  调用点必须清楚自己在问哪一个问题：`isRunning()` 问的是"能不能用"。 */
  async probe(port: number): Promise<boolean> {
    return (await this.probeState(port)) === "ready";
  }

  /** S4-B：端口的**三态**判定（ready / loading / down）。判据复用 `classifyLocalServer`
   *  —— 与能力问询同源，不再各写一套 `200 && status==="ok"`。
   *  这里保留自己的 `fetchImpl`（而不是直接用 `core-ts/src/local_server_io.ts` 的 `getJson`）：
   *  因为 `fetchImpl` 是**测试注入缝**（`waitReady` 与 `probe` 共用同一个）。IO 原语与
   *  "判定语义"是两件事 —— 前者允许有第二份，后者只许有一份。 */
  async probeState(port: number): Promise<LocalServerState> {
    let status: number | null = null;
    let body: unknown;
    try {
      const resp = await this.fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      status = resp.status;
      try { body = await resp.json(); } catch { body = undefined; }
    } catch {
      status = null; // 连不上 —— 与"连上了但 503"必须区分
    }
    return classifyLocalServer(status, body);
  }

  /** PID 存活 + /health ok 双确认（对照 is_running） */
  async isRunning(): Promise<boolean> {
    if (this.pidVal === null) return false;
    if (!processAlive(this.pidVal)) return false;
    return this.probe(this.portVal);
  }
}

// ── 进程辅助（对照 _verify_llama_server_pid / _process_alive） ──

/** 检查 PID 对应进程是否为 llama-server（N10-M7，防 PID 复用误杀）。 */
export function verifyLlamaServerPid(pid: number | null): boolean {
  if (!pid) return false;
  try {
    if (IS_WINDOWS) {
      // tasklist 镜像名校验（Win11 24H2+ 无 wmic，此路径与 Python 回退一致）
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        windowsHide: true, encoding: "utf8", timeout: 5000,
      });
      return (out ?? "").toLowerCase().includes("llama-server");
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8", timeout: 5000,
    });
    return (out ?? "").includes("llama-server");
  } catch {
    return false; // 无法确认时不杀
  }
}

/** PID 是否存活。查询失败保守视为存活（不误判孤儿、不误杀）。 */
export function processAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    if (IS_WINDOWS) {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`], {
        windowsHide: true, encoding: "utf8", timeout: 5000,
      });
      return (out ?? "").includes(String(pid));
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  } catch {
    return true;
  }
}

/** 解析监听端口的进程 PID（Windows netstat / Unix lsof）。失败返回 null。 */
export function pidForPort(port: number): number | null {
  try {
    if (IS_WINDOWS) {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], {
        windowsHide: true, encoding: "utf8", timeout: 5000,
      });
      for (const line of (out ?? "").split(/\r?\n/)) {
        if (new RegExp(`:${port}\\s`).test(line) && /LISTENING/i.test(line)) {
          const parts = line.trim().split(/\s+/);
          const last = parts[parts.length - 1];
          if (last && /^\d+$/.test(last)) return parseInt(last, 10);
        }
      }
    } else {
      const out = execFileSync("lsof", ["-ti", `tcp:${port}`], {
        encoding: "utf8", timeout: 5000,
      });
      const pids = (out ?? "").trim().split(/\r?\n/).filter((x) => /^\d+$/.test(x));
      if (pids.length) return parseInt(pids[0], 10);
    }
  } catch {
    /* 解析失败 */
  }
  return null;
}

/** 查询父 PID。失败/非 Windows 返回 null（保守：不判定孤儿）。
 *  Windows 优先 wmic；wmic 缺失（Win11 24H2+）回退 PowerShell Get-CimInstance（与 Python 对照）。 */
export function parentPid(pid: number): number | null {
  if (!IS_WINDOWS) return null;
  try {
    let out = "";
    try {
      out = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "ParentProcessId"], {
        windowsHide: true, encoding: "utf8", timeout: 5000,
      });
    } catch {
      out = execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`,
      ], { windowsHide: true, encoding: "utf8", timeout: 8000 });
    }
    const nums = (out ?? "").split(/\s+/).map(Number).filter((n) => Number.isInteger(n));
    return nums.length ? nums[0] : null;
  } catch {
    return null;
  }
}

/** 父进程已死 → 判定为崩溃残留孤儿。父查询失败保守 false（不误杀）。 */
export function isOrphan(pid: number): boolean {
  const ppid = parentPid(pid);
  if (ppid === null || ppid === undefined || ppid === 0 || ppid === 1 || ppid === 4) return false;
  return !processAlive(ppid);
}

/** 回收孤儿 llama-server：校验命令行含 llama-server 后 taskkill 进程树。 */
export function killPid(pid: number): boolean {
  if (!verifyLlamaServerPid(pid)) {
    console.warn(`[model_server] PID ${pid} 非 llama-server，拒绝回收`);
    return false;
  }
  try {
    if (IS_WINDOWS) {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore", timeout: 5000,
      });
    } else {
      process.kill(pid, 15);
    }
    console.log(`[model_server] 已回收孤儿 llama-server (PID ${pid})`);
    return true;
  } catch (e) {
    console.warn(`[model_server] 回收孤儿 PID ${pid} 失败: ${e}`);
    return false;
  }
}

// ── 端口工具 ─────────────────────────────────────────────

/** 从 base_port 起顺序找空闲端口（TCP 连接探测；HTTP 确认用全局 fetch——探测对象真实网络）。 */
export async function findFreePort(basePort: number, startOffset = 0, scanRange = 100): Promise<number | null> {
  for (let port = basePort + startOffset; port < basePort + scanRange; port++) {
    const busy = await new Promise<boolean>((resolvePort) => {
      const sock = createConnection({ host: "127.0.0.1", port });
      sock.setTimeout(300);
      sock.once("connect", () => {
        sock.destroy();
        resolvePort(true);
      });
      sock.once("timeout", () => {
        sock.destroy();
        resolvePort(false);
      });
      sock.once("error", () => resolvePort(false));
    });
    if (busy) continue;
    // 再用 HTTP 确认（真实网络探测，不注入）
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      continue;
    } catch {
      return port;
    }
  }
  return null;
}

/** 端口基址（A-003）：embedding 用固定配置端口，chat 用 port_start。 */
export function basePortFor(role: string, cfg: Record<string, unknown>, chatCfg: Record<string, unknown>): number {
  if (role === "embedding") return (cfg.port as number) ?? 8999;
  return (chatCfg.port_start as number) ?? 18082;
}

// ── 实例状态（对照 _Instance dataclass） ─────────────────

interface Instance {
  role: string;
  model_path: string;
  model_name: string;
  port: number;
  state: ServerStateValue;
  persistent: boolean;
  gpu_layers: number;
  ctx_len: number;
  external: boolean;
  /** S4-A：下发过的 `--alias`（= 运行中实例的自述身份）。
   *  外部采纳的实例**可能没有**（采纳时只探了 `/health`，不知道它的别名）→ 留空即"身份未知"，
   *  身份判据会自动退回路径比较。S4-B 改为读 `/props` 后这里可填真实值。 */
  alias?: string;
  /** 最近一次启动/加载失败原因（状态面板展示 idle 的根因） */
  error?: string;
}

// ── 互斥锁（对照 asyncio.Lock，H2 防并发双启动） ─────────

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    return prev.then(() => fn()).finally(release);
  }
}

// ── ModelServerManager（对照 ModelServerManager） ─────────

export interface ModelServerConfig {
  llama_bin?: string;
  startup_timeout?: number;
  vram_budget_gb?: number;
  chat_est_gb?: number;
  embedding?: Record<string, unknown>;
  chat?: Record<string, unknown>;
}

export interface EnsureResult {
  ok: boolean;
  port?: number;
  state?: string;
  error?: string;
}

/** 单次 ensure 的按模型覆盖参数（本地模型切换时以模型自带的 gpu/ctx 覆盖会话配置） */
export interface EnsureModelOpts {
  gpuLayers?: number;
  ctxLen?: number;
  /** 取消信号：加载期间被 abort → 停止进程并返回「已取消」（GUI 加载面板取消按钮） */
  signal?: AbortSignal;
}

export interface StatusItem {
  role: string;
  model: string;
  port: number;
  pid: number | null;
  state: ServerStateValue;
  persistent: boolean;
  external: boolean;
  vram_gb: VRAMSample | null;
  /** 启动/加载失败原因（idle 时展示根因） */
  error?: string;
}

export class ModelServerManager {
  private llamaBin: string;
  private startupTimeout: number;
  private chatEstGb: number;
  private embedCfg: Record<string, unknown>;
  private chatCfg: Record<string, unknown>;
  private vram: VRAMMonitor;
  private instances: Record<string, Instance> = {};
  private backends: Record<string, ModelBackend> = {};
  private idleTasks: Record<string, ReturnType<typeof setTimeout>> = {};
  /** S4-C：已就"常驻实例不受空闲卸载影响"告警过的角色（避免每轮 touch 都刷日志） */
  private idleSkipWarned = new Set<string>();
  private ensureLock = new Mutex();
  private registryPath: string;
  private fetchImpl: typeof fetch;
  /* S4-B：端口探测的注入缝，返回**完整能力快照**（含三态 `state` 与服务器自述的 alias/modelPath）。
   * 此前是 `(port) => Promise<boolean>` —— 布尔把"加载中"和"什么都没有"压成了同一个答案，
   * 于是 `probeLive` 对正在加载的实例判否 → 在隔壁端口又拉起一个同样的模型 → 双份显存。 */
  private probeImpl: (port: number) => Promise<LocalServerCapability>;
  /** 后台预加载任务引用（对齐 Python _startup_task；Promise 不可取消，仅保留观测位） */
  private startupTask: Promise<void> | null = null;
  /** A-1017：chat 状态迁移回调（只对 role="chat" 触发；见 ChatStateEvent 注释） */
  private onChatState?: (ev: ChatStateEvent) => void;
  /** A-1021：chat 的 KV cache 量化类型（下发 `-ctk/-ctv`）。默认 q8_0 —— 见 ModelBackend.start 的实测依据。 */
  private chatKvType: { k: string; v: string } | null;
  /** A-1021：chat 在启动前的显存预检里必须**保留**的空闲量（GiB）。
   *  实测依据：f16 KV @ctx=32768 时，预检放行（空闲 6.9GB > 需求），但真跑起来
   *  在最后一块 KV 分配上失败 —— 当时空闲 1535 MiB、还要 1557 MiB，**差 22 MiB**。
   *  即"留 1GB 余量"是不够的（Electron 自身的 GPU 进程 + 桌面合成会挤占）。
   *  故提到 1.5GB：既不误伤 q8_0（6.9 − 3.95 = 2.95 仍放行），又能拦住上面那种临界配置。 */
  private static readonly CHAT_VRAM_RESERVE_GB = 1.5;

  constructor(config: ModelServerConfig, opts: { registryPath?: string; fetchImpl?: typeof fetch; probeImpl?: (port: number) => Promise<LocalServerCapability>; onChatState?: (ev: ChatStateEvent) => void } = {}) {
    this.llamaBin = config.llama_bin ?? "";
    // 默认 120s：大模型 CPU 首载可能数十秒~两分钟（对照 Campanula 90s 健康等待，留足余量）
    this.startupTimeout = config.startup_timeout ?? 120;
    this.chatEstGb = config.chat_est_gb ?? 4.0;
    this.embedCfg = config.embedding ?? {};
    this.chatCfg = config.chat ?? {};
    this.vram = new VRAMMonitor();
    this.registryPath = opts.registryPath ?? DEFAULT_REGISTRY_PATH;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    /* 默认走 core-ts 的 IO 原语（与"能力问询"共用同一次请求语义）。
     * 只问 `/props`：状态与身份都在它里面；`n_ctx_train` 只在 `/v1/models`，那是窗口上限的用途。
     * 超时给 1500ms（比能力问询的 600ms 宽松）：这里判错的代价是**多起一个进程占显存**，
     * 而能力问询判错的代价只是"这一轮不知道窗口多大"。 */
    this.probeImpl = opts.probeImpl ?? ((port) => probeLocalProps(`http://127.0.0.1:${port}`, { timeoutMs: 1500 }));
    this.onChatState = opts.onChatState;
    /* A-1021：KV 量化类型。配置项 `[model_server.chat] kv_type`（对 K/V 同时生效）。
     * 显式写 "f16" / "none" / "" 视为**不量化**（不下发参数，回到 llama.cpp 默认）——
     * 保留一条"退回原行为"的路，避免 q8_0 在个别模型/后端上出问题时用户无路可走。 */
    const rawKv = String(this.chatCfg.kv_type ?? "q8_0").trim();
    this.chatKvType = rawKv === "" || rawKv === "f16" || rawKv === "none"
      ? null
      : { k: rawKv, v: String(this.chatCfg.kv_type_v ?? rawKv).trim() };
  }

  /** chat 状态迁移广播（A-1017）。回调异常不得影响加载主流程 → 就地吞掉并告警。 */  private notifyChatState(role: string): void {
    if (!this.onChatState || role !== "chat") { return; }
    const inst = this.instances[role];
    if (!inst) { return; }
    try {
      this.onChatState({
        state: inst.state,
        modelName: inst.model_name,
        modelPath: inst.model_path,
        error: inst.error,
      });
    } catch (e) {
      console.warn(`[model_server] onChatState 回调异常: ${e}`);
    }
  }

  /**
   * A-1021：估算 chat 模型的 GPU 显存需求。
   *
   * **真值来源是模型文件本身**（GGUF 头里的 block_count / head_count_kv / key_length…），
   * 而不是与模型无关的常量 `chat_est_gb` —— 后者是本次"预检放行、真跑 OOM"的成因：
   * 常量写 4.0GB，而 ctx=32768 的真实占用 ≈ 5.4GB（权重 1.8 + KV 3.5），低估 26%。
   *
   * 回退策略（**绝不因估算失败而拒绝启动**）：读不到 GGUF 几何参数时退回 `chatEstGb`
   * 常量，行为与改动前完全一致。
   */
  private estimateChatFootprintGb(modelPath: string, ctxLen: number): { gb: number; basis: string } {
    const geom = existsSync(modelPath) ? readGgufMeta(modelPath) : null;
    if (geom) {
      const kv = this.chatKvType ?? { k: "f16", v: "f16" };
      const gb = estimateGpuFootprintGb(geom, ctxLen, kv.k, kv.v);
      if (gb !== null) {
        const kvBytes = geom.headCountKv * (geom.keyLength * (KV_CACHE_BYTES_PER_ELEMENT[kv.k] ?? 2) + geom.valueLength * (KV_CACHE_BYTES_PER_ELEMENT[kv.v] ?? 2)) * geom.blockCount * ctxLen;
        return {
          gb,
          basis:
            `权重 ${(geom.fileSizeBytes / 1024 ** 3).toFixed(2)}GB + KV(${kv.k}/${kv.v}) ` +
            `${(kvBytes / 1024 ** 3).toFixed(2)}GB（${geom.architecture}：${geom.blockCount} 层 × ` +
            `${geom.headCountKv} KV头 × (${geom.keyLength}+${geom.valueLength}) 维 × ${ctxLen} ctx）`,
        };
      }
    }
    return {
      gb: this.chatEstGb,
      basis: `未能从模型文件读出几何参数，回退到配置常量 chat_est_gb=${this.chatEstGb.toFixed(1)}GB`,
    };
  }

  // ── 生命周期 ───────────────────────────────────────────

  /** 后台启动 persistent 实例（不阻塞调用方）。失败记日志。 */
  async startup(): Promise<void> {
    // H1/A-003: 启动即清空 registry —— 上次崩溃残留的 ready 条目会让外部读者读到假就绪端口。
    this.writeRegistry();
    if (this.embedCfg.persistent) {
      const embedPath = String(this.embedCfg.model_path ?? "");
      this.startupTask = (async () => {
        try {
          const vram = this.vram.sample();
          if (vram && vram.free_gb < 2.5) {
            console.warn(`[model_server] 显存不足，跳过 embedding 预加载 (free ${vram.free_gb.toFixed(1)}GB < 2.5GB)`);
            return;
          }
          const result = await this.ensure("embedding", embedPath, "bge-m3");
          if (result.ok) console.log("[model_server] embedding 已就绪");
          else console.warn(`[model_server] embedding 启动失败: ${result.error}`);
        } catch (e) {
          console.error(`[model_server] embedding 后台启动异常: ${e}`);
        }
      })();
    }
  }

  /** 确保实例就绪。已 ready → 复用；未启动 → 预算检查 + 启动 + wait_ready。 */
  async ensure(role: string, modelPath = "", modelName = "", opts: EnsureModelOpts = {}): Promise<EnsureResult> {
    const cfg = role === "embedding" ? this.embedCfg : this.chatCfg;

    // 1. 快速路径：已 ready 且模型匹配 → 直接复用（无锁）
    const fast = await this.reuseIfReady(role, modelPath, modelName);
    if (fast) return fast;

    // 2. 关键段加锁（H2：防止并发双启动）
    return this.ensureLock.run(async () => {
      // 2a. 双检：锁内再查一次
      const locked = await this.reuseIfReady(role, modelPath, modelName);
      if (locked) return locked;
      return this.ensureLocked(role, modelPath, modelName, cfg, opts);
    });
  }

  /** S4-A：**「这个实例是不是这个模型」的唯一判据**。
   *
   *  此前这个判断散在两处（复用判同 / 模型切换检测），各自做裸路径字符串比较 ——
   *  又是"同一事实多个产地"。收口到这里，并改为**别名优先**：
   *    - 两侧都有别名 → 比别名。别名是实例在 `/props.model_alias` 上**自述**的身份，
   *      与调用方拿的是相对路径、绝对路径还是配置里的另一份写法无关。
   *    - 任一侧没有别名（外部采纳的实例不知道自己的别名 / 调用方没指定目标）→ 退回路径比较
   *      （= 改动前行为，不引入回归）。
   *  返回 true = 同一个模型 → 可复用 / 无需卸载。 */
  private sameModel(inst: Instance, target: { path: string; alias: string }): boolean {
    if (inst.alias && target.alias) { return inst.alias === target.alias; }
    if (!target.path || !inst.model_path) { return true; }
    return inst.model_path === target.path;
  }

  private async reuseIfReady(role: string, matchModel = "", matchName = ""): Promise<EnsureResult | null> {
    const inst = this.instances[role];
    if (inst && inst.state === ServerState.READY) {
      // 已加载其它模型 → 不复用，走下方重载（支持多本地模型切换）
      if (!this.sameModel(inst, { path: matchModel, alias: sanitizeAlias(matchName) })) {
        return null;
      }
      const backend = this.backends[role];
      if (backend && (await backend.isRunning())) {
        this.touch(role);
        return { ok: true, port: inst.port, state: "reused" };
      }
    }
    return null;
  }

  /** 探测已存在的活实例（A-017/L2）：embedding 查配置固定端口；chat 从 port_start 起扫描 100 个端口。
   *  probeImpl 可注入（测试对齐 Python patch ModelBackend.probe_async）。
   *
   *  S4-B：返回值从 `[port, pid]` 变成**带能力快照**，且区分三种情形 ——
   *    · `ready`   + 身份匹配（有别名且不一致就**跳过继续扫**，不再"捡到就认领"）
   *    · `loading` → 记下来当**兜底候选**，扫完仍没有 ready 的匹配实例就返回它，由调用方去等
   *    · `down`    → 继续扫（`findFreePort` 本来也会跳过 TCP 占用的端口）
   *  为什么"捡到就认领"是错的：认领时会写上**我们想要的** `model_path`，而端口上跑的可能是
   *  另一个模型 —— 这正是 A-1018 ③ 的同类病（界面按 A 模型显示、请求发给 B 模型）。 */
  async probeLive(
    role: string,
    cfg: Record<string, unknown>,
    target: { path: string; alias: string } = { path: "", alias: "" },
  ): Promise<{ port: number; pid: number; cap: LocalServerCapability } | null> {
    const probe = this.probeImpl;
    let loading: { port: number; pid: number; cap: LocalServerCapability } | null = null;
    const consider = async (port: number): Promise<{ port: number; pid: number; cap: LocalServerCapability } | null> => {
      const cap = await probe(port);
      if (cap.state === "ready") {
        /* 身份守卫：服务器自述了别名却与目标不符 → 这不是我们的实例，**继续扫**。
           （自述为空 = 老旧实例/手工起的服务，不认识别名 → 保持"认领"的旧行为，不制造回归。） */
        if (cap.alias && target.alias && sanitizeAlias(cap.alias) !== target.alias) {
          console.log(`[model_server] 端口 ${port} 上是另一个模型（自述 alias=${cap.alias}，目标 ${target.alias}），跳过`);
          return null;
        }
        return { port, pid: pidForPort(port) ?? 0, cap };
      }
      if (cap.state === "loading" && !loading) {
        loading = { port, pid: pidForPort(port) ?? 0, cap };
      }
      return null;
    };

    if (role === "embedding") {
      const port = basePortFor("embedding", cfg, this.chatCfg);
      const hit = await consider(port);
      if (hit) return hit;
      return loading;
    }
    // 端口基址也走 basePortFor（S2：端口只有一个真值来源）——此前这里独立写了 `?? 18082`，
    // 与 basePortFor 是两份可以各自漂移的口径。
    const portStart = basePortFor(role, cfg, this.chatCfg);
    for (let port = portStart; port < portStart + 100; port++) {
      const hit = await consider(port);
      if (hit) return hit;
    }
    return loading;
  }

  /** S4-B：**等待一个不是我们拉起的实例**变成就绪（它正在加载，很可能就是上一次 slime 会话
   *  留下的同一个模型）。绝不重复 spawn —— 那会占双份显存。
   *
   *  返回值刻意区分四种结局，因为**只有一种能安全地继续去 spawn**：
   *    `ready`   → 认领它
   *    `down`    → 它死了（加载失败/被外部杀掉）→ 可以安全地重新拉起
   *    `timeout` → **还在加载**（大模型 CPU 首载可能几分钟）→ 绝不能 spawn，否则双份显存
   *    `aborted` → 用户取消
   */
  private async waitExternalReady(
    port: number,
    signal?: AbortSignal,
  ): Promise<"ready" | "down" | "timeout" | "aborted"> {
    const deadline = Date.now() + this.startupTimeout * 1000;
    console.log(`[model_server] 端口 ${port} 上已有实例正在加载，等待它就绪（不重复拉起）`);
    while (Date.now() < deadline) {
      if (signal?.aborted) return "aborted";
      const cap = await this.probeImpl(port);
      if (cap.state === "ready") return "ready";
      if (cap.state === "down") return "down";
      await new Promise((r) => setTimeout(r, 500));
    }
    return "timeout";
  }

  private async ensureLocked(
    role: string, modelPath: string, modelName: string,
    cfg: Record<string, unknown>, opts: EnsureModelOpts = {},
  ): Promise<EnsureResult> {
    /* S4-A：「目标模型是谁」的判据**现取**（不缓存）—— 下面的 step 2 会把 modelPath/modelName
     * 从配置或 models_dir 里补全，缓存下来就会拿"补全前的空值"去判同。 */
    const target = () => ({ path: modelPath, alias: sanitizeAlias(modelName) });

    // 0. 模型切换：本实例已加载其它模型且非外部 → 停旧实例后重载（支持多本地模型切换）
    if (role === "chat" && modelPath) {
      const prev = this.instances[role];
      if (prev && !prev.external && !this.sameModel(prev, target())) {
        console.log(`[model_server] 检测到模型切换（${prev.model_path} → ${modelPath}），卸载旧实例`);
        try {
          this.backends[role]?.stop();
        } catch {
          /* 已有退出 */
        }
        delete this.instances[role];
        delete this.backends[role];
        this.writeRegistry();
      }
    }

    // 1. 探测已存在的活实例（A-017：孤儿回收；外部实例复用不误杀）
    const live = await this.probeLive(role, cfg, target());
    if (live) {
      const { port, pid } = live;
      let cap = live.cap;

      /* S4-B：**别人正在这个端口上加载**（最常见：上一次 slime 会话退出时它还在载）。
       * 绝不重复拉起 —— 那会占双份显存。等它就绪，然后当作外部实例认领。
       * 只有确认它**死了**（`down`）才允许往下走全新启动。 */
      if (cap.state === "loading") {
        const outcome = await this.waitExternalReady(port, opts.signal);
        if (outcome === "aborted") return { ok: false, error: "已取消加载" };
        if (outcome === "timeout") {
          /* 还在加载却等超了：**不能**去 spawn（会双份显存），把话说清楚交给用户。
           * 这不是"失败"，而是"该端口已被占用且正在初始化"。 */
          return {
            ok: false,
            error:
              `端口 ${port} 上已有 llama-server 正在加载，等待 ${this.startupTimeout}s 仍未就绪。\n` +
              `它很可能就是本次要加载的实例（大模型 CPU 首载可能需要数分钟），请稍后重试；\n` +
              `若确认它已卡死，请到 设置 → 心智中枢 → 本地模型 结束该进程后重试。\n` +
              `（不在此处另起一个进程，是为了避免同一模型被加载两份、白占双份显存。）`,
          };
        }
        /* ready / down 都必须**重新问一次**：`live.cap` 是**加载期**的快照，
         * 那时 `/props` 只返回错误信封，别名与路径一个都读不到。
         * 不复用旧快照的另一个原因：down 是"等它的时候它自己退了"的新事实。 */
        cap = await this.probeImpl(port);
        if (outcome === "ready") {
          console.log(`[model_server] 端口 ${port} 上的实例已就绪，直接认领（未重复拉起）`);
        } else {
          console.log(`[model_server] 端口 ${port} 上的实例在等待期间退出，将全新拉起`);
        }
      }

      /* ⚠️ 只有 `ready`（认领）与 `down`（确认死了 → 可以安全重拉）这两种结局能往下走。
       * 出现第三种（例如将来有人把上面的 timeout 分支改成"继续往下"，或状态在探测之间抖动）
       * 一律当场拒绝 —— 静默 spawn 一个已经在加载的模型会白占双份显存，
       * 而"改一处、别处静默变错"正是本项目反复出现的病。 */
      if (cap.state !== "ready" && cap.state !== "down") {
        return {
          ok: false,
          error: `端口 ${port} 上的实例状态为 ${cap.state}，既不能认领也不该重复拉起 —— 请稍后重试。`,
        };
      }

      if (cap.state === "ready") {
        if (pid && isOrphan(pid) && killPid(pid)) {
          // 崩溃残留的孤儿 → 回收后走下方全新启动（findFreePort 会复用该端口）
          console.log(`[model_server] 检测到崩溃残留孤儿 llama-server 已回收 (PID ${pid}, port ${port})，将重新拉起`);
          this.writeRegistry();
        } else {
          const inst: Instance = {
            role,
            model_path: modelPath || String(cfg.model_path ?? ""),
            model_name: modelName,
            port,
            state: ServerState.READY,
            persistent: Boolean(cfg.persistent),
            gpu_layers: (cfg.gpu_layers as number) ?? 99,
            ctx_len: (cfg.ctx_len as number) ?? 2048,
            external: true,
            /* S4-A/B：**填服务器自述的别名**，而不是"我们想要的那个"。
             * 自述为空（老旧实例/手工起的服务）就留空 = "身份未知"，`sameModel()` 退回路径比较。
             * 编造身份比没有身份更糟 —— 下游拿它去比对会**通过**。 */
            alias: cap.alias ? sanitizeAlias(cap.alias) : undefined,
          };
          this.instances[role] = inst;
          this.backends[role] = this.backends[role] ?? new ModelBackend(this.llamaBin, { fetchImpl: this.fetchImpl });
          this.writeRegistry();
          this.touch(role);
          return { ok: true, port, state: "external" };
        }
      }
    }

    // 2. 解析模型路径
    modelPath = modelPath || String(cfg.model_path ?? "");
    if (role === "chat" && !modelPath) {
      const modelsDir = String(cfg.models_dir ?? "");
      if (modelsDir && existsSync(modelsDir)) {
        const ggufs = readdirSync(modelsDir).filter((f) => f.endsWith(".gguf")).sort();
        if (ggufs.length) {
          modelPath = resolve(modelsDir, ggufs[0]);
          modelName = modelName || ggufs[0].replace(/\.gguf$/, "");
        }
      }
    }
    if (!modelPath) return { ok: false, error: `未指定模型路径（role=${role}）` };

    /* 规划的上下文长度 —— **单一出处**：instance.ctx_len 与下面的显存预检都读它。
       （此前预检完全不知道 ctx，而 KV cache 正比于 ctx：同一个模型 ctx=8192 与 32768
        的占用差 2.6GB。不感知 ctx 的预检注定估不准。） */
    const plannedCtx = (opts.ctxLen ?? (cfg.ctx_len as number | undefined)) ?? 2048;

    // 2.5 VRAM 预算检查（chat 角色）—— 必须放在**模型路径解析之后**：估算依赖具体模型文件
    if (role === "chat") {
      const est = this.estimateChatFootprintGb(modelPath, plannedCtx);
      const vram = this.vram.sample();
      if (vram && vram.free_gb - est.gb < ModelServerManager.CHAT_VRAM_RESERVE_GB) {
        return {
          ok: false,
          error:
            `显存不足：空闲 ${vram.free_gb.toFixed(1)}GB，本次需要 ~${est.gb.toFixed(1)}GB，` +
            `还需保留 ${ModelServerManager.CHAT_VRAM_RESERVE_GB.toFixed(1)}GB 余量。\n` +
            `估算依据：${est.basis}。\n` +
            `可选做法：① 调小 ctx_len（KV cache 正比于它，降一半 ctx 就省一半 KV）；` +
            `② 用更小的量化（权重更小）；③ 关掉占用显存的其它程序后重试。`,
        };
      }
    }

    // 4. 找空端口并启动（N10-M6: 端口冲突时重试 3 次）
    // A-003: 角色感知端口基址 —— embedding 用固定配置端口（8999），chat 用 port_start。
    const basePort = basePortFor(role, cfg, this.chatCfg);
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const port = await findFreePort(basePort, attempt);
      if (port === null) continue;
      const backend = this.backends[role] ?? new ModelBackend(this.llamaBin, { fetchImpl: this.fetchImpl });
      const inst: Instance = {
        role,
        model_path: modelPath,
        model_name: modelName,
        port,
        state: ServerState.LOADING,
        persistent: Boolean(cfg.persistent),
        gpu_layers: (opts.gpuLayers ?? (cfg.gpu_layers as number | undefined)) ?? 99,
        // plannedCtx 与上面的显存预检同源（单一出处）；它同时是「界面上限」的来源，见 slime.toml 注释
        ctx_len: plannedCtx,
        external: false,
        // S4-A：身份 = 别名。modelName 可能来自 models_dir 兜底（= 文件名去扩展名），也照样下发
        alias: target().alias || undefined,
      };
      if (!backend.start({ llamaBin: this.llamaBin, modelPath, port, gpuLayers: inst.gpu_layers, ctxLen: inst.ctx_len, embedding: role === "embedding", kvTypeK: role === "chat" ? this.chatKvType?.k : undefined, kvTypeV: role === "chat" ? this.chatKvType?.v : undefined, alias: inst.alias })) {
        inst.state = ServerState.IDLE;
        inst.error = !existsSync(this.llamaBin)
          ? `llama-server 不存在（${this.llamaBin}），请在 设置 → 心智中枢 → 依赖 中下载/定位`
          : !existsSync(modelPath)
            ? `模型文件不存在（${modelPath}），请先下载该模型`
            : "llama-server 启动失败";
        // 启动失败也登记实例（状态面板展示 idle 根因），缺失二进制/模型重试端口无意义 → 直接返回
        this.instances[role] = inst;
        this.backends[role] = backend;
        this.writeRegistry();
        this.notifyChatState(role); // A-1017：状态定为 idle（启动失败）→ 面板应收起而不是空转
        return { ok: false, error: inst.error };
      }

      this.instances[role] = inst;
      this.backends[role] = backend;
      this.writeRegistry();
      this.notifyChatState(role); // A-1017：真正开始加载 → 这是「正在加载本地模型」面板的唯一触发点

      // 5. 等待就绪（signal abort → 停止进程并返回「已取消」）
      const ready = await backend.waitReady(this.startupTimeout, opts.signal);
      if (opts.signal?.aborted) {
        backend.stop();
        inst.state = ServerState.IDLE;
        inst.error = "已取消加载";
        this.writeRegistry();
        this.notifyChatState(role); // A-1017：用户取消 → 收面板
        return { ok: false, error: "已取消加载" };
      }
      if (ready) {
        inst.state = ServerState.READY;
        inst.error = undefined;
        this.writeRegistry();
        this.notifyChatState(role); // A-1017：就绪即刻收面板（此前要等整轮回答结束才收）
        this.touch(role);
        return { ok: true, port, state: "ready" };
      }
      backend.stop();
      inst.state = ServerState.IDLE;
      /* A-1018：把 llama-server 自己的输出尾巴并进错误信息。
       * 此前只有"进程已退出（模型文件可能损坏）"这种猜测式文案，用户无从判断到底是损坏、
       * 参数不被支持还是显存不足；现在直接带上它的原话（截断到 8 行，避免刷屏）。 */
      const tail = backend.output.split("\n").slice(-8).join("\n");
      inst.error = backend.hasExited()
        ? `llama-server 进程已退出（模型文件可能损坏或不兼容）。请确认 .gguf 文件完整未损坏，或重新下载。${tail ? `\n${tail}` : ""}`
        : `启动超时（${this.startupTimeout}s 内未就绪）。若为新下载的模型，请确认 .gguf 文件完整未损坏。${tail ? `\n${tail}` : ""}`;
      this.writeRegistry();
      this.notifyChatState(role); // A-1017：超时/退出 → 收面板，具体原因仍由对话流内的错误消息透出
      if (attempt < maxRetries - 1) continue;
      return { ok: false, error: inst.error };
    }
    return { ok: false, error: "端口分配失败" };
  }

  /** 卸载实例（persistent/LOADING 拒绝） */
  release(role: string): EnsureResult {
    const inst = this.instances[role];
    if (!inst) return { ok: false, error: `实例不存在: ${role}` };
    if (inst.persistent) return { ok: false, error: `${role} 是常驻实例，不允许手动卸载` };
    if (inst.state === ServerState.LOADING) return { ok: false, error: `${role} 正在加载中，无法卸载` };
    if (this.idleTasks[role]) {
      clearTimeout(this.idleTasks[role]);
      delete this.idleTasks[role];
    }
    const backend = this.backends[role];
    if (backend) {
      inst.state = ServerState.UNLOADING;
      backend.stop();
    }
    inst.state = ServerState.IDLE;
    this.writeRegistry();
    this.notifyChatState(role); // A-1017：卸载/空闲回收 → 收面板（下次请求重新加载时会再弹）
    return { ok: true, state: "idle" };
  }

  /** 停止全部自己拉起的实例 */
  async shutdown(): Promise<void> {
    void this.startupTask; // 对齐 Python _startup_task.cancel()：观测后台预加载引用后放弃
    this.startupTask = null;
    for (const t of Object.values(this.idleTasks)) clearTimeout(t);
    this.idleTasks = {};
    for (const [role, backend] of Object.entries(this.backends)) {
      const inst = this.instances[role];
      if (!inst?.external) backend.stop();
    }
    this.instances = {};
    this.backends = {};
    this.writeRegistry();
    console.log("[model_server] 全部本地模型已停止");
  }

  /** 活跃请求：重置空闲计时器（对照 touch/_idle_timer）。
   *
   *  S4-C 修三处：
   *  ① **embedding 不再被无条件跳过** —— 此前 `role === "embedding"` 直接 return，
   *     于是 `[model_server.embedding] idle_unload_min` 是一个**没有读取者的开关**：
   *     配置里有、用户设了、代码里没人看。现在它与 chat 同规则。
   *  ② 常驻实例（`persistent = true`）本来就不许卸载，给它上空闲计时器只会换来一次注定失败的
   *     release 和一句误导人的「已自动卸载」→ 直接不上表，并**一次性**说明原因（别静默）。
   *  ③ 计时器到点先问服务器「你忙不忙」，见 `onIdle` —— 这是为了修「长生成被中途杀掉」。
   */
  touch(role: string): void {
    const cfg = role === "chat" ? this.chatCfg : this.embedCfg;
    const idleMin = (cfg.idle_unload_min as number) ?? 0;
    if (idleMin <= 0) return;
    if (this.instances[role]?.persistent) {
      if (!this.idleSkipWarned.has(role)) {
        this.idleSkipWarned.add(role);
        console.log(`[model_server] ${role} 是常驻实例（persistent = true），idle_unload_min=${idleMin} 对它不生效`);
      }
      return;
    }
    if (this.idleTasks[role]) clearTimeout(this.idleTasks[role]);
    this.idleTasks[role] = setTimeout(() => { void this.onIdle(role, idleMin); }, idleMin * 60_000);
  }

  /** S4-C：空闲到点 → **先问服务器忙不忙**再决定卸载。
   *
   *  为什么不能只靠 `touch()` 计时：`touch()` 只在**请求开始**的三处被调用
   *  （复用 / 就绪 / 外部认领），生成期间不会再调。于是一次超过 `idle_unload_min` 的
   *  长生成或工具循环，会在中途被 `release()` 杀掉 —— 用户看到的是「回答到一半突然失败」。
   *  `/slots[].is_processing` 是**服务端权威**的忙闲信号（本机实测：空闲时全 false，
   *  生成期间对应槽位持续 true），它不受调用时机影响，长生成多长都拦得住。
   *
   *  问不进去（超时/网络错误）时**偏保守：不卸载**，下个周期再问。代价是多占一会儿显存；
   *  反过来（把正在跑的请求杀掉）是用户可见的失败，不可接受。
   */
  private async onIdle(role: string, idleMin: number): Promise<void> {
    delete this.idleTasks[role];
    const inst = this.instances[role];
    if (!inst || inst.state !== ServerState.READY) return; // 已经不在服务了，没什么可卸
    const busy = await this.isBusy(inst.port);
    if (busy !== "idle") {
      console.log(
        `[model_server] ${role} 空闲 ${idleMin} 分钟，但${busy === "busy" ? "仍在生成中" : "忙闲未知（探测失败）"}，暂不卸载`,
      );
      this.touch(role);
      return;
    }
    const result = this.release(role);
    /* `release()` 有正当的拒绝理由（正在加载 / 常驻）。**此前无论成败都打印「已自动卸载」** ——
     * 日志说卸了、实际没卸，是最坏的一种静默失效。 */
    if (result.ok) { console.log(`[model_server] ${role} 空闲 ${idleMin} 分钟，已自动卸载`); }
    else { console.log(`[model_server] ${role} 空闲 ${idleMin} 分钟，未能卸载：${result.error}`); }
  }

  /** S4-C：服务器自述的忙闲。
   *  `idle` = 明确不在生成；`busy` = 明确在生成；`unknown` = **问不进去**（连不上/超时）。
   *
   *  ⚠️ `unknown` 与 `idle` 必须分开：把"问不进去"当成"不忙"就会在生成中途卸载
   *  （负载高时最容易超时 —— 也就是最忙的时候）。 */
  private async isBusy(port: number): Promise<"idle" | "busy" | "unknown"> {
    let body: unknown;
    try {
      const resp = await this.fetchImpl(`http://127.0.0.1:${port}/slots`, { signal: AbortSignal.timeout(1500) });
      /* 拿到 HTTP 响应就算"问进去了"：响应体不是槽位数组（例如该 build 没开 slots 端点）
       * 说明它没在处理任何请求 → idle。**只有连不上/超时**才算 unknown。 */
      if (!resp.ok) return "idle";
      try { body = await resp.json(); } catch { return "idle"; }
    } catch {
      return "unknown";
    }
    if (!Array.isArray(body)) return "idle";
    return body.some((s) => (s as { is_processing?: unknown } | null)?.is_processing === true)
      ? "busy"
      : "idle";
  }

  // ── 查询 ───────────────────────────────────────────────

  status(): StatusItem[] {
    const vram = this.vram.sample();
    const items = Object.entries(this.instances).map(([role, inst]) => ({
      role,
      model: inst.model_path ? inst.model_name || basename(inst.model_path) : "",
      port: inst.port,
      pid: this.backends[role]?.pid ?? null,
      state: inst.state,
      persistent: inst.persistent,
      external: inst.external,
      vram_gb: vram,
      error: inst.error,
    }));
    // 常驻 embedding 未创建实例（如未配置模型路径）→ 合成一行，状态面板展示原因而非消失
    if (!this.instances["embedding"] && this.embedCfg.persistent) {
      const embedPath = String(this.embedCfg.model_path ?? "");
      items.push({
        role: "embedding",
        model: embedPath ? basename(embedPath) : "",
        port: basePortFor("embedding", this.embedCfg, this.chatCfg),
        pid: null,
        state: ServerState.IDLE,
        persistent: true,
        external: false,
        vram_gb: vram,
        error: !embedPath
          ? "未配置嵌入模型路径（slime.toml [model_server.embedding].model_path），请在 设置 → 心智中枢 → 依赖 中下载/定位"
          : !existsSync(this.llamaBin)
            ? `llama-server 不存在（${this.llamaBin}），请在 设置 → 心智中枢 → 依赖 中下载/定位`
            : !existsSync(embedPath)
              ? `模型文件不存在（${embedPath}），请先下载该模型`
              : "未启动（可点击「重试启动」）",
      });
    }
    return items;
  }

  getPort(role: string): number {
    const inst = this.instances[role];
    return inst && inst.state === ServerState.READY ? inst.port : 0;
  }

  /* A-1017：`isChatReady(modelPath)` 已删除 —— 它存在的唯一目的是让 GUI **从外部**判断
   * "本地模型加载好了没有"，而这本质上是在猜本类的私有状态（调用方得自己把 `local:<id>` 解析成
   * 路径，再跟 `instances.chat.model_path` 做裸字符串比较）。只要两边的路径来路不同就永久判否，
   * 直接导致"模型已就绪却每轮对话都弹一次加载面板"。
   * 现在改为**状态广播**（`onChatState` + ChatStateEvent）：真值来源只有一个，判据由它自己发出。
   * 若将来确实需要同步查询，请连同读取者一起加（见项目铁律「开关必须有读取者」）。 */

  /** 启动/重试嵌入模型（下载完成后手动触发；失败返回具体原因供 UI 展示） */
  async startEmbedding(): Promise<EnsureResult> {
    const embedPath = String(this.embedCfg.model_path ?? "");
    if (!embedPath) {
      return { ok: false, error: "未配置嵌入模型路径（slime.toml [model_server.embedding].model_path）" };
    }
    const result = await this.ensure("embedding", embedPath, "bge-m3");
    return result;
  }

  // ── Registry ────────────────────────────────────────────

  /** 原子写入 registry（防多进程读半截） */
  writeRegistry(): void {
    const data: Record<string, Record<string, unknown>> = {};
    for (const [role, inst] of Object.entries(this.instances)) {
      data[role] = {
        model: inst.model_path ? inst.model_name || basename(inst.model_path) : "",
        port: inst.port,
        pid: this.backends[role]?.pid ?? null,
        state: inst.state,
      };
    }
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const raw = JSON.stringify(data, null, 2);
    const tmp = this.registryPath.replace(/\.json$/, `.${randomUUID().replace(/-/g, "").slice(0, 8)}.tmp`);
    writeFileSync(tmp, raw, "utf8");
    renameSync(tmp, this.registryPath);
  }

  /** 读取 registry（供外部进程使用） */
  static readRegistry(registryPath = DEFAULT_REGISTRY_PATH): Record<string, Record<string, unknown>> {
    if (!existsSync(registryPath)) return {};
    try {
      return JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, Record<string, unknown>>;
    } catch {
      return {};
    }
  }
}

// ── 全局单例 ─────────────────────────────────────────────

let modelServer: ModelServerManager | null = null;

export function getModelServer(): ModelServerManager | null {
  return modelServer;
}

export function setModelServer(mgr: ModelServerManager): void {
  modelServer = mgr;
}
