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
}

/** llama-server 进程封装。只管理自己 spawn 的进程。 */
export class ModelBackend {
  private process: ChildProcess | null = null;
  private pidVal: number | null = null;
  private portVal = 0;
  private fetchImpl: typeof fetch;

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
    const argv = [
      "-m", args.modelPath,
      "--port", String(args.port),
      "-ngl", String(args.gpuLayers),
      "-c", String(args.ctxLen),
    ];
    if (args.embedding) argv.push("--embedding");

    try {
      const child = spawn(this.llamaBin, argv, {
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
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

  /** 轮询 /health 等待就绪（对照 wait_ready） */
  async waitReady(timeout = 60): Promise<boolean> {
    if (!this.portVal) return false;
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
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

  /** 探测端口是否已有可用的 llama-server 实例（对照 probe_async） */
  async probe(port: number): Promise<boolean> {
    try {
      const resp = await this.fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.status === 200) {
        const data = (await resp.json()) as { status?: string };
        return data.status === "ok";
      }
    } catch {
      /* 无服务 */
    }
    return false;
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

export interface StatusItem {
  role: string;
  model: string;
  port: number;
  pid: number | null;
  state: ServerStateValue;
  persistent: boolean;
  external: boolean;
  vram_gb: VRAMSample | null;
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
  private ensureLock = new Mutex();
  private registryPath: string;
  private fetchImpl: typeof fetch;
  private probeImpl: (port: number) => Promise<boolean>;
  /** 后台预加载任务引用（对齐 Python _startup_task；Promise 不可取消，仅保留观测位） */
  private startupTask: Promise<void> | null = null;

  constructor(config: ModelServerConfig, opts: { registryPath?: string; fetchImpl?: typeof fetch; probeImpl?: (port: number) => Promise<boolean> } = {}) {
    this.llamaBin = config.llama_bin ?? "";
    this.startupTimeout = config.startup_timeout ?? 60;
    this.chatEstGb = config.chat_est_gb ?? 4.0;
    this.embedCfg = config.embedding ?? {};
    this.chatCfg = config.chat ?? {};
    this.vram = new VRAMMonitor();
    this.registryPath = opts.registryPath ?? DEFAULT_REGISTRY_PATH;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.probeImpl = opts.probeImpl ?? (async (port) => new ModelBackend(this.llamaBin, { fetchImpl: this.fetchImpl }).probe(port));
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
  async ensure(role: string, modelPath = "", modelName = ""): Promise<EnsureResult> {
    const cfg = role === "embedding" ? this.embedCfg : this.chatCfg;

    // 1. 快速路径：已 ready → 直接复用（无锁）
    const fast = await this.reuseIfReady(role);
    if (fast) return fast;

    // 2. 关键段加锁（H2：防止并发双启动）
    return this.ensureLock.run(async () => {
      // 2a. 双检：锁内再查一次
      const locked = await this.reuseIfReady(role);
      if (locked) return locked;
      return this.ensureLocked(role, modelPath, modelName, cfg);
    });
  }

  private async reuseIfReady(role: string): Promise<EnsureResult | null> {
    const inst = this.instances[role];
    if (inst && inst.state === ServerState.READY) {
      const backend = this.backends[role];
      if (backend && (await backend.isRunning())) {
        this.touch(role);
        return { ok: true, port: inst.port, state: "reused" };
      }
    }
    return null;
  }

  /** 探测已存在的活实例（A-017/L2）：embedding 查配置固定端口；chat 从 port_start 起扫描 100 个端口。
   *  probeImpl 可注入（测试对齐 Python patch ModelBackend.probe_async）。 */
  async probeLive(role: string, cfg: Record<string, unknown>): Promise<[number, number] | null> {
    const probe = this.probeImpl;
    if (role === "embedding") {
      const port = (cfg.port as number) ?? 8999;
      if (await probe(port)) return [port, pidForPort(port) ?? 0];
      return null;
    }
    const portStart = (cfg.port_start as number) ?? 18082;
    for (let port = portStart; port < portStart + 100; port++) {
      if (await probe(port)) return [port, pidForPort(port) ?? 0];
    }
    return null;
  }

  private async ensureLocked(
    role: string, modelPath: string, modelName: string,
    cfg: Record<string, unknown>,
  ): Promise<EnsureResult> {
    // 1. 探测已存在的活实例（A-017：孤儿回收；外部实例复用不误杀）
    const live = await this.probeLive(role, cfg);
    if (live) {
      const [port, pid] = live;
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
        };
        this.instances[role] = inst;
        this.backends[role] = this.backends[role] ?? new ModelBackend(this.llamaBin, { fetchImpl: this.fetchImpl });
        this.writeRegistry();
        this.touch(role);
        return { ok: true, port, state: "external" };
      }
    }

    // 2. VRAM 预算检查（chat 角色）
    if (role === "chat") {
      const vram = this.vram.sample();
      if (vram && vram.free_gb - this.chatEstGb < 1.0) {
        return {
          ok: false,
          error: `显存不足（空闲 ${vram.free_gb.toFixed(1)}GB，需要 ~${this.chatEstGb.toFixed(1)}GB，保留 1GB 余量）`,
        };
      }
    }

    // 3. 解析模型路径
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
        gpu_layers: (cfg.gpu_layers as number) ?? 99,
        ctx_len: (cfg.ctx_len as number) ?? 2048,
        external: false,
      };
      if (!backend.start({ llamaBin: this.llamaBin, modelPath, port, gpuLayers: inst.gpu_layers, ctxLen: inst.ctx_len, embedding: role === "embedding" })) {
        inst.state = ServerState.IDLE;
        if (attempt < maxRetries - 1) {
          console.warn(`[model_server] 端口 ${port} 启动失败，重试 (attempt ${attempt + 1}/${maxRetries})`);
          continue;
        }
        return { ok: false, error: `llama-server 启动失败（${modelPath}）` };
      }

      this.instances[role] = inst;
      this.backends[role] = backend;
      this.writeRegistry();

      // 5. 等待就绪
      const ready = await backend.waitReady(this.startupTimeout);
      if (ready) {
        inst.state = ServerState.READY;
        this.writeRegistry();
        this.touch(role);
        return { ok: true, port, state: "ready" };
      }
      backend.stop();
      inst.state = ServerState.IDLE;
      this.writeRegistry();
      if (attempt < maxRetries - 1) continue;
      return { ok: false, error: `llama-server 启动超时（${this.startupTimeout}s）` };
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

  /** 活跃请求：重置空闲计时器（对照 touch/_idle_timer） */
  touch(role: string): void {
    const cfg = role === "chat" ? this.chatCfg : this.embedCfg;
    const idleMin = (cfg.idle_unload_min as number) ?? 0;
    if (idleMin <= 0 || role === "embedding") return;
    if (this.idleTasks[role]) clearTimeout(this.idleTasks[role]);
    this.idleTasks[role] = setTimeout(() => {
      console.log(`[model_server] ${role} 空闲 ${idleMin} 分钟，自动卸载`);
      this.release(role);
      delete this.idleTasks[role];
    }, idleMin * 60_000);
  }

  // ── 查询 ───────────────────────────────────────────────

  status(): StatusItem[] {
    const vram = this.vram.sample();
    return Object.entries(this.instances).map(([role, inst]) => ({
      role,
      model: inst.model_path ? inst.model_name || basename(inst.model_path) : "",
      port: inst.port,
      pid: this.backends[role]?.pid ?? null,
      state: inst.state,
      persistent: inst.persistent,
      external: inst.external,
      vram_gb: vram,
    }));
  }

  getPort(role: string): number {
    const inst = this.instances[role];
    return inst && inst.state === ServerState.READY ? inst.port : 0;
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
