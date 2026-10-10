













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



export const ServerState = {
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  UNLOADING: "unloading",
} as const;

export type ServerStateValue = (typeof ServerState)[keyof typeof ServerState];









export interface ChatStateEvent {
  state: ServerStateValue;
  
  modelName: string;
  modelPath: string;
  error?: string;
}



export interface VRAMSample {
  total_gb: number;
  used_gb: number;
  free_gb: number;
}


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



export interface BackendArgs {
  llamaBin: string;
  modelPath: string;
  port: number;
  gpuLayers: number;
  ctxLen: number;
  embedding?: boolean;
  
  kvTypeK?: string;
  kvTypeV?: string;
  
  alias?: string;
}













export function sanitizeAlias(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const cleaned = s.replace(/,/g, "_").trim();
  
  return /^[_\s]*$/.test(cleaned) ? "" : cleaned;
}








export function buildLlamaArgv(args: BackendArgs): string[] {
  const argv = [
    "-m", args.modelPath,
    "--port", String(args.port),
    "-ngl", String(args.gpuLayers),
    "-c", String(args.ctxLen),
  ];
  













  const alias = sanitizeAlias(args.alias);
  if (alias) {
    argv.push("-a", alias);
  }
  












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
    










    argv.push("--reasoning-format", "deepseek");
  }
  return argv;
}


export class ModelBackend {
  private process: ChildProcess | null = null;
  private pidVal: number | null = null;
  private portVal = 0;
  private fetchImpl: typeof fetch;
  
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

  
  async waitReady(timeout = 120, signal?: AbortSignal): Promise<boolean> {
    if (!this.portVal) return false;
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      
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
        
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  
  hasExited(): boolean {
    return this.process !== null && this.process.exitCode !== null && this.process.exitCode !== undefined;
  }

  

  get output(): string {
    return this.outputTail.join("\n");
  }

  
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
        process.kill(-this.pidVal, "SIGTERM"); 
      }
      
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (!processAlive(this.pidVal)) break;
        const nap = Math.min(500, deadline - Date.now());
        
        const shared = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(shared, 0, 0, nap);
      }
      console.log(`[model_server] 已停止 PID ${this.pidVal} (port ${this.portVal})`);
    } catch (e) {
      console.warn(`[model_server] 停止 PID ${this.pidVal} 失败: ${e}`);
      try {
        this.process.kill("SIGKILL");
      } catch {
        
      }
    } finally {
      this.process = null;
      this.pidVal = null;
    }
  }

  







  async probe(port: number): Promise<boolean> {
    return (await this.probeState(port)) === "ready";
  }

  




  async probeState(port: number): Promise<LocalServerState> {
    let status: number | null = null;
    let body: unknown;
    try {
      const resp = await this.fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      status = resp.status;
      try { body = await resp.json(); } catch { body = undefined; }
    } catch {
      status = null; 
    }
    return classifyLocalServer(status, body);
  }

  
  async isRunning(): Promise<boolean> {
    if (this.pidVal === null) return false;
    if (!processAlive(this.pidVal)) return false;
    return this.probe(this.portVal);
  }
}




export function verifyLlamaServerPid(pid: number | null): boolean {
  if (!pid) return false;
  try {
    if (IS_WINDOWS) {
      
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
    return false; 
  }
}


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
    
  }
  return null;
}



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


export function isOrphan(pid: number): boolean {
  const ppid = parentPid(pid);
  if (ppid === null || ppid === undefined || ppid === 0 || ppid === 1 || ppid === 4) return false;
  return !processAlive(ppid);
}


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
    
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      continue;
    } catch {
      return port;
    }
  }
  return null;
}


export function basePortFor(role: string, cfg: Record<string, unknown>, chatCfg: Record<string, unknown>): number {
  if (role === "embedding") return (cfg.port as number) ?? 8999;
  return (chatCfg.port_start as number) ?? 18082;
}



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
  


  alias?: string;
  
  error?: string;
}



class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    return prev.then(() => fn()).finally(release);
  }
}



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


export interface EnsureModelOpts {
  gpuLayers?: number;
  ctxLen?: number;
  
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
  
  private idleSkipWarned = new Set<string>();
  private ensureLock = new Mutex();
  private registryPath: string;
  private fetchImpl: typeof fetch;
  


  private probeImpl: (port: number) => Promise<LocalServerCapability>;
  
  private startupTask: Promise<void> | null = null;
  
  private onChatState?: (ev: ChatStateEvent) => void;
  
  private chatKvType: { k: string; v: string } | null;
  




  private static readonly CHAT_VRAM_RESERVE_GB = 1.5;

  constructor(config: ModelServerConfig, opts: { registryPath?: string; fetchImpl?: typeof fetch; probeImpl?: (port: number) => Promise<LocalServerCapability>; onChatState?: (ev: ChatStateEvent) => void } = {}) {
    this.llamaBin = config.llama_bin ?? "";
    
    this.startupTimeout = config.startup_timeout ?? 120;
    this.chatEstGb = config.chat_est_gb ?? 4.0;
    this.embedCfg = config.embedding ?? {};
    this.chatCfg = config.chat ?? {};
    this.vram = new VRAMMonitor();
    this.registryPath = opts.registryPath ?? DEFAULT_REGISTRY_PATH;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    



    this.probeImpl = opts.probeImpl ?? ((port) => probeLocalProps(`http://127.0.0.1:${port}`, { timeoutMs: 1500 }));
    this.onChatState = opts.onChatState;
    


    const rawKv = String(this.chatCfg.kv_type ?? "q8_0").trim();
    this.chatKvType = rawKv === "" || rawKv === "f16" || rawKv === "none"
      ? null
      : { k: rawKv, v: String(this.chatCfg.kv_type_v ?? rawKv).trim() };
  }

    private notifyChatState(role: string): void {
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

  

  
  async startup(): Promise<void> {
    
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

  
  async ensure(role: string, modelPath = "", modelName = "", opts: EnsureModelOpts = {}): Promise<EnsureResult> {
    const cfg = role === "embedding" ? this.embedCfg : this.chatCfg;

    
    const fast = await this.reuseIfReady(role, modelPath, modelName);
    if (fast) return fast;

    
    return this.ensureLock.run(async () => {
      
      const locked = await this.reuseIfReady(role, modelPath, modelName);
      if (locked) return locked;
      return this.ensureLocked(role, modelPath, modelName, cfg, opts);
    });
  }

  








  private sameModel(inst: Instance, target: { path: string; alias: string }): boolean {
    if (inst.alias && target.alias) { return inst.alias === target.alias; }
    if (!target.path || !inst.model_path) { return true; }
    return inst.model_path === target.path;
  }

  private async reuseIfReady(role: string, matchModel = "", matchName = ""): Promise<EnsureResult | null> {
    const inst = this.instances[role];
    if (inst && inst.state === ServerState.READY) {
      
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
    
    
    const portStart = basePortFor(role, cfg, this.chatCfg);
    for (let port = portStart; port < portStart + 100; port++) {
      const hit = await consider(port);
      if (hit) return hit;
    }
    return loading;
  }

  








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
    

    const target = () => ({ path: modelPath, alias: sanitizeAlias(modelName) });

    
    if (role === "chat" && modelPath) {
      const prev = this.instances[role];
      if (prev && !prev.external && !this.sameModel(prev, target())) {
        console.log(`[model_server] 检测到模型切换（${prev.model_path} → ${modelPath}），卸载旧实例`);
        try {
          this.backends[role]?.stop();
        } catch {
          
        }
        delete this.instances[role];
        delete this.backends[role];
        this.writeRegistry();
      }
    }

    
    const live = await this.probeLive(role, cfg, target());
    if (live) {
      const { port, pid } = live;
      let cap = live.cap;

      


      if (cap.state === "loading") {
        const outcome = await this.waitExternalReady(port, opts.signal);
        if (outcome === "aborted") return { ok: false, error: "已取消加载" };
        if (outcome === "timeout") {
          

          return {
            ok: false,
            error:
              `端口 ${port} 上已有 llama-server 正在加载，等待 ${this.startupTimeout}s 仍未就绪。\n` +
              `它很可能就是本次要加载的实例（大模型 CPU 首载可能需要数分钟），请稍后重试；\n` +
              `若确认它已卡死，请到 设置 → 心智中枢 → 本地模型 结束该进程后重试。\n` +
              `（不在此处另起一个进程，是为了避免同一模型被加载两份、白占双份显存。）`,
          };
        }
        


        cap = await this.probeImpl(port);
        if (outcome === "ready") {
          console.log(`[model_server] 端口 ${port} 上的实例已就绪，直接认领（未重复拉起）`);
        } else {
          console.log(`[model_server] 端口 ${port} 上的实例在等待期间退出，将全新拉起`);
        }
      }

      



      if (cap.state !== "ready" && cap.state !== "down") {
        return {
          ok: false,
          error: `端口 ${port} 上的实例状态为 ${cap.state}，既不能认领也不该重复拉起 —— 请稍后重试。`,
        };
      }

      if (cap.state === "ready") {
        if (pid && isOrphan(pid) && killPid(pid)) {
          
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

    


    const plannedCtx = (opts.ctxLen ?? (cfg.ctx_len as number | undefined)) ?? 2048;

    
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
        
        ctx_len: plannedCtx,
        external: false,
        
        alias: target().alias || undefined,
      };
      if (!backend.start({ llamaBin: this.llamaBin, modelPath, port, gpuLayers: inst.gpu_layers, ctxLen: inst.ctx_len, embedding: role === "embedding", kvTypeK: role === "chat" ? this.chatKvType?.k : undefined, kvTypeV: role === "chat" ? this.chatKvType?.v : undefined, alias: inst.alias })) {
        inst.state = ServerState.IDLE;
        inst.error = !existsSync(this.llamaBin)
          ? `llama-server 不存在（${this.llamaBin}），请在 设置 → 心智中枢 → 依赖 中下载/定位`
          : !existsSync(modelPath)
            ? `模型文件不存在（${modelPath}），请先下载该模型`
            : "llama-server 启动失败";
        
        this.instances[role] = inst;
        this.backends[role] = backend;
        this.writeRegistry();
        this.notifyChatState(role); 
        return { ok: false, error: inst.error };
      }

      this.instances[role] = inst;
      this.backends[role] = backend;
      this.writeRegistry();
      this.notifyChatState(role); 

      
      const ready = await backend.waitReady(this.startupTimeout, opts.signal);
      if (opts.signal?.aborted) {
        backend.stop();
        inst.state = ServerState.IDLE;
        inst.error = "已取消加载";
        this.writeRegistry();
        this.notifyChatState(role); 
        return { ok: false, error: "已取消加载" };
      }
      if (ready) {
        inst.state = ServerState.READY;
        inst.error = undefined;
        this.writeRegistry();
        this.notifyChatState(role); 
        this.touch(role);
        return { ok: true, port, state: "ready" };
      }
      backend.stop();
      inst.state = ServerState.IDLE;
      


      const tail = backend.output.split("\n").slice(-8).join("\n");
      inst.error = backend.hasExited()
        ? `llama-server 进程已退出（模型文件可能损坏或不兼容）。请确认 .gguf 文件完整未损坏，或重新下载。${tail ? `\n${tail}` : ""}`
        : `启动超时（${this.startupTimeout}s 内未就绪）。若为新下载的模型，请确认 .gguf 文件完整未损坏。${tail ? `\n${tail}` : ""}`;
      this.writeRegistry();
      this.notifyChatState(role); 
      if (attempt < maxRetries - 1) continue;
      return { ok: false, error: inst.error };
    }
    return { ok: false, error: "端口分配失败" };
  }

  
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
    this.notifyChatState(role); 
    return { ok: true, state: "idle" };
  }

  
  async shutdown(): Promise<void> {
    void this.startupTask; 
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

  










  private async onIdle(role: string, idleMin: number): Promise<void> {
    delete this.idleTasks[role];
    const inst = this.instances[role];
    if (!inst || inst.state !== ServerState.READY) return; 
    const busy = await this.isBusy(inst.port);
    if (busy !== "idle") {
      console.log(
        `[model_server] ${role} 空闲 ${idleMin} 分钟，但${busy === "busy" ? "仍在生成中" : "忙闲未知（探测失败）"}，暂不卸载`,
      );
      this.touch(role);
      return;
    }
    const result = this.release(role);
    

    if (result.ok) { console.log(`[model_server] ${role} 空闲 ${idleMin} 分钟，已自动卸载`); }
    else { console.log(`[model_server] ${role} 空闲 ${idleMin} 分钟，未能卸载：${result.error}`); }
  }

  




  private async isBusy(port: number): Promise<"idle" | "busy" | "unknown"> {
    let body: unknown;
    try {
      const resp = await this.fetchImpl(`http://127.0.0.1:${port}/slots`, { signal: AbortSignal.timeout(1500) });
      

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

  /** A-1201：某个角色的 llama-server 最近输出（界面「查看日志」用）。
   *  为什么要它：失败时的第一手证据就在子进程 stdout/stderr 里（加载失败 / 显存不足 /
   *  模板错误都会打在这里）。此前它只存在主进程内存里、界面上看不到 ⇒ 出问题只能猜。
   *  没有该角色的后端 ⇒ 空串（调用方如实显示"无日志"，**不编**）。 */
  outputTailOf(role: string): string {
    return this.backends[role]?.output ?? "";
  }

  






  
  async startEmbedding(): Promise<EnsureResult> {
    const embedPath = String(this.embedCfg.model_path ?? "");
    if (!embedPath) {
      return { ok: false, error: "未配置嵌入模型路径（slime.toml [model_server.embedding].model_path）" };
    }
    const result = await this.ensure("embedding", embedPath, "bge-m3");
    return result;
  }

  

  
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

  
  static readRegistry(registryPath = DEFAULT_REGISTRY_PATH): Record<string, Record<string, unknown>> {
    if (!existsSync(registryPath)) return {};
    try {
      return JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, Record<string, unknown>>;
    } catch {
      return {};
    }
  }
}



let modelServer: ModelServerManager | null = null;

export function getModelServer(): ModelServerManager | null {
  return modelServer;
}

export function setModelServer(mgr: ModelServerManager): void {
  modelServer = mgr;
}
