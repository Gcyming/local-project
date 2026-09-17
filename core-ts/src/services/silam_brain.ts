/**
 * core-ts/src/services/silam_brain.ts — SILAM-Σ 绝对大脑兑底客户端（A-121）。
 *
 * GUI（及任何 core-ts 消费方）在"无可用路由"（没有 API Provider、本地
 * llama 模型不可用）时，把对话兑底给 SILAM 离线大脑：
 *   spawn 一个 python sidecar（D:\\pilot model\\sidecar\\server.py），
 *   走 stdin/stdout JSONL 协议，发 reply 请求拿回自然语言应答。
 *
 * 语义对照（双端同步）：
 * - Python 端兑底：core/llm.py `_silam_brain_fallback` → `_silam_core_reply`
 * - 本机兑底：`SilamBrainClient.reply` → sidecar `reply`（表述规则与之对齐）
 *   命令行/服务端/CLI 走 Python；Electron GUI 主进程走 core-ts（本模块）。
 *
 * 失败策略：所有异常静默降级——sidecar 起不来 / 请求超时 / 输出异常
 * 一律返回 null 或 enabled=false，绝不阻塞、绝不影响 GUI 主流程。
 * 开关：slime.toml [silam] enabled=true 且 as_brain=true 才尝试启动。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PROJECT_ROOT } from "../paths.js";

/** slime.toml [silam] 段的消费视图 */
export interface SilamTomlConfig {
  enabled: boolean;
  asBrain: boolean;
  agentId: string;
}

/** A-963 双向桥-后向：SILAM 情感/成长态快照（sidecar status 的可读投影，供 GUI 轮询展示） */
export interface SilamAffectState {
  /** 恐惧总量 0-1 */
  fear: number;
  /** 渴望 0-1 */
  desire: number;
  /** 成长树节点数（dendrites.n） */
  n_nodes: number;
  /** 步数（step_count，跨会话成长） */
  step: number;
  /** 语言脑是否已装载（lang_loaded） */
  langLoaded: boolean;
}

/** 兑底请求入参（对齐 _silam_core_reply 的入参语义） */
export interface SilamReplyOpts {
  agentName: string;
  agentRole: string;
  userMessage: string;
  history: { role: string; content: string }[];
  /** A-963 前向桥：slime 为该 Agent 沉淀的长期记忆文本（facts/preferences/lessons/rules），
   *  注入 SILAM 推理上下文（情感脑 forward + 语言脑生成）。无记忆源时缺省。 */
  slimeMemory?: string[];
}

/** 兑底应答（A-124 正文/思考分离）：reply 正文直接说给用户，reasoning 思考供上层折叠展示 */
export interface SilamReplyResult {
  reply: string | null;
  reasoning: string | null;
}

/** 引擎对 SILAM 大脑的最小依赖面（便于测试注入 fake） */
export interface SilamBrain {
  readonly enabled: boolean;
  reply(opts: SilamReplyOpts): Promise<SilamReplyResult | null>;
  close(): void;
  /**
   * A-122 观战式观摩学习：把辅导员（API/llama）的一次成功示范异步交给
   * sidecar 沉淀（记忆环 + 树突）。fire-and-forget——实现方异常不影响主对话；
   * fake / 旧实现可缺省该方法（optional）。
   */
  observe?: (userMessage: string, reply: string) => void;
  /** A-963 双向桥-后向：查询 SILAM 情感/成长态（fear/desire/树节点/step）。
   *   可选——fake/旧实现可缺省，调用方按 undefined 容错。 */
  getState?: () => Promise<SilamAffectState | null>;
}

const STATUS_TIMEOUT_MS = 15_000; // sidecar 冷启动（import numpy/silam_core + 装载权重）
const REPLY_TIMEOUT_MS = 60_000;

/** A-963 双向桥-前向数据源：加载 slime 为该 Agent 沉淀的长期记忆。
 *  格式：Knowledge/Agent Memory/<agentId>/{memory,knowledge}.json（facts/preferences/lessons 等，
 *  content 字段为文本）。容错：目录/文件缺失或损坏 → 返回 []，绝不抛错。
 *  防呆：读入后按字符长度守卫（超限跳过，防误把快照/SQLite 当记忆全量 JSON.parse 成对象树）。
 *  注：不用 statSync 等体积检查——vitest 变换环境会树摇未"显式调用"的 node:fs 命名导入，读入后判断最稳。 */
const MEMORY_FILE_MAX_CHARS = 2 * 1024 * 1024;

/** A-963 双向桥-前向数据源：加载 slime 为该 Agent 沉淀的长期记忆（实现见上）。 */
export async function loadSlimeMemories(
  agentId: string,
  limit = 6,
  root = PROJECT_ROOT,
): Promise<string[]> {
  const dir = resolve(root, "Knowledge", "Agent Memory", agentId);
  const parts: Array<{ text: string; importance: number }> = [];
  const seen = new Set<string>();
  const push = (text: string, importance: number): void => {
    const t = text.trim();
    if (!t || seen.has(t)) {
      return;
    }
    seen.add(t);
    parts.push({ text: t, importance });
  };
  for (const name of ["memory.json", "knowledge.json", "silam.json"]) {
    const p = resolve(dir, name);
    if (!existsSync(p)) {
      continue;
    }
    try {
      const raw = readFileSync(p, "utf8");
      if (raw.length > MEMORY_FILE_MAX_CHARS) {
        continue; // 防呆：超大文件不解析成 JSON 对象树
      }
      collectMem(JSON.parse(raw), push);
    } catch {
      /* 单文件损坏忽略 */
    }
  }
  parts.sort((a, b) => b.importance - a.importance);
  return parts.slice(0, limit).map((x) => x.text);
}

/** 递归收集 {content|text, importance?} 叶子文本 */
function collectMem(v: unknown, push: (text: string, importance: number) => void): void {
  if (Array.isArray(v)) {
    for (const it of v) {
      collectMem(it, push);
    }
    return;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.content === "string" && o.content.trim()) {
      const imp = typeof o.importance === "number" ? o.importance : 1;
      push(o.content, imp);
      return; // 叶子：不深入嵌套干扰去重
    }
    if (typeof o.text === "string" && o.text.trim()) {
      push(o.text, 1);
      return;
    }
    if (typeof o.description === "string" && o.description.trim()) {
      push(o.description, 1);
      return;
    }
    for (const k of ["facts", "preferences", "lessons", "rules", "patterns", "skills_unlocked", "insights", "user_profile"]) {
      if (k in o) {
        collectMem(o[k], push);
      }
    }
    // knowledge.json 的 patterns 是 key→PatternEntry 的 map：分类 key 未命中时遍历值（JSON.parse 产物无环）
    for (const val of Object.values(o)) {
      if ((Array.isArray(val) || (val !== null && typeof val === "object"))) {
        collectMem(val, push);
      }
    }
  }
}

/** 简易 TOML [silam] 段解析（对齐 core-ts 既有 readEmbedDim 风格，不引第三方）。
 *  A-962：缺省路径时先查 PROJECT_ROOT/slime.toml，打包环境（exe 同级 slime.toml）兜底。 */
export function readSilamConfig(projectRoot?: string): SilamTomlConfig {
  const def: SilamTomlConfig = { enabled: false, asBrain: false, agentId: "silam-default" };
  const roots = [
    projectRoot ?? PROJECT_ROOT,
    ...(packagedResourceRoot() && packagedResourceRoot() !== (projectRoot ?? PROJECT_ROOT)
      ? [packagedResourceRoot()!]
      : []),
  ];
  let tomlPath: string | null = null;
  for (const r of roots) {
    const p = resolve(r, "slime.toml");
    if (existsSync(p)) {
      tomlPath = p;
      break;
    }
  }
  if (!tomlPath) {
    return def;
  }
  try {
    const text = readFileSync(tomlPath, "utf8");
    let inSilam = false;
    const kv: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line === "[silam]") { inSilam = true; continue; }
      if (line.startsWith("[") && line.endsWith("]")) { inSilam = false; continue; }
      if (!inSilam) continue;
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const rawVal = line.slice(idx + 1).trim();
      // 剥离行内注释（TOML：# 起止行尾），再去引号
      const val = rawVal.split(/\s*#/)[0].trim().replace(/["']/g, "");
      kv[line.slice(0, idx).trim()] = val;
    }
    def.enabled = kv.enabled === "true";
    def.asBrain = kv.as_brain === "true";
    def.agentId = kv.agent_id || def.agentId;
  } catch {
    /* 读不到配置 = 不启用，安全降级 */
  }
  return def;
}

/** 打包环境：与 Slime.exe 同级的 app 根（win-unpacked 根），sidecar/models 等 extraFiles 落位于此；仅当确有 sidecar 时返回 */
function packagedResourceRoot(): string | null {
  const exeDir = typeof process.execPath === "string" && process.execPath
    ? dirname(process.execPath)
    : "";
  if (!exeDir || !existsSync(resolve(exeDir, "sidecar", "silam_brain_sidecar.py"))) {
    return null;
  }
  return exeDir;
}

/** 定位 sidecar 脚本：SILAM_SIDECAR > 打包 resources/sidecar > 仓库 sidecar/ > 旧 _model_stage/tools */
function resolveSidecarScript(): string | null {
  const env = process.env.SILAM_SIDECAR;
  if (env && existsSync(env)) {
    return env;
  }
  const rp = packagedResourceRoot();
  const candidates = [
    ...(rp ? [resolve(rp, "sidecar", "silam_brain_sidecar.py")] : []),
    // A-121 fix：2026-09 换代版 sidecar 位于仓库 sidecar/ 目录（含 --agent-id/--backbone 参数与 JSON 协议）
    resolve(PROJECT_ROOT, "sidecar", "silam_brain_sidecar.py"),
    resolve(PROJECT_ROOT, "_model_stage", "tools", "sidecar_server.py"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** python 候选：SILAM_PYTHON > py/python3/python（Windows 习惯使用 py 启动器） */
function pythonCandidates(): string[] {
  const list: string[] = [];
  if (process.env.SILAM_PYTHON) {
    list.push(process.env.SILAM_PYTHON);
  }
  // A-962：打包环境优先用随包 venv（win-unpacked/runtime/venv），避免系统未装 python 时 sidecar 拉不起
  const packRoot = packagedResourceRoot();
  if (packRoot) {
    const venvPy = resolve(packRoot, "runtime", "venv", "Scripts", "python.exe");
    if (existsSync(venvPy)) {
      list.push(venvPy);
    }
  }
  if (process.platform === "win32") {
    list.push("py", "python");
  } else {
    list.push("python3", "python");
  }
  return list;
}

export class SilamBrainClient implements SilamBrain {
  private proc: ChildProcess | null = null;
  private alive = false;
  private buf = "";
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly cfg: SilamTomlConfig) {}

  get enabled(): boolean {
    return this.alive;
  }

  /** 启动 sidecar（若候选 python 全部失败或脚本缺失 → enabled=false，静默降级） */
  static async start(cfg: SilamTomlConfig): Promise<SilamBrainClient> {
    const client = new SilamBrainClient(cfg);
    if (!cfg.enabled || !cfg.asBrain) {
      return client;
    }
    const script = resolveSidecarScript();
    if (!script) {
      console.warn("[silam] sidecar server.py 不存在（SILAM_ROOT 同级 /pilot model），兑底不可用");
      return client;
    }
    const silamRoot = resolve(script, "..", "..");
    // 80M 情感脑蒸馏权重：打包 resources/models 优先，仓库 models/ 归档、_model_stage/data 工作区兜底
    const rp = packagedResourceRoot();
    const backboneCandidates = [
      ...(rp ? [resolve(rp, "models", "情感脑-silam-sigma-80m", "backbone_80m.npz")] : []),
      resolve(silamRoot, "models", "情感脑-silam-sigma-80m", "backbone_80m.npz"),
      resolve(silamRoot, "_model_stage", "data", "backbone_80m.npz"),
    ];
    const backboneAbs = backboneCandidates.find((p) => existsSync(p));
    if (backboneAbs) {
      console.log("[silam] 装载蒸馏权重:", backboneAbs);
    }

    for (const py of pythonCandidates()) {
      try {
        await client._trySpawn(py, script, silamRoot, backboneAbs);
        if (client.alive) {
          return client;
        }
      } catch {
        /* 试下一个候选 */
      }
    }
    console.warn("[silam] 未能拉起 sidecar（python 候选均失败），兑底不可用");
    return client;
  }

  private _trySpawn(py: string, script: string, cwd: string, backbone: string | undefined): Promise<void> {
    return new Promise((resolveReady, rejectReady) => {
      const args = [script, "--agent-id", this.cfg.agentId];
      if (backbone) {
        args.push("--backbone", backbone);
      }
      let proc: ChildProcess;
      try {
        proc = spawn(py, args, {
          cwd,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
        });
      } catch (e) {
        rejectReady(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      proc.stderr?.on("data", (d: Buffer) => {
        const s = d.toString().trim();
        if (s) {
          console.warn(`[silam:sidecar] ${s}`);
        }
      });
      proc.on("error", (e) => {
        this.alive = false;
        rejectReady(e);
      });
      proc.on("exit", () => {
        this.alive = false;
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("sidecar 已退出"));
        }
        this.pending.clear();
      });
      proc.stdout?.on("data", (d: Buffer) => {
        this._onStdout(d.toString("utf8"));
      });
      this.proc = proc;

      // 就绪探测：发 status，收到响应即认为 sidecar 可用
      const timer = setTimeout(() => {
        proc.kill();
        this.alive = false;
        rejectReady(new Error(`sidecar 启动超时（${py}）`));
      }, STATUS_TIMEOUT_MS);

      this.queueRequest("status", {})
        .then(() => {
          clearTimeout(timer);
          this.alive = true;
          resolveReady();
        })
        .catch((e: unknown) => {
          clearTimeout(timer);
          proc.kill();
          this.alive = false;
          rejectReady(e instanceof Error ? e : new Error(String(e)));
        });
    });
  }

  /** sidecar 单进程单线程消费 stdin → 所有请求串行（队列桥接 async） */
  private queueRequest(type: string, payload: Record<string, unknown>, timeoutMs = REPLY_TIMEOUT_MS): Promise<unknown> {
    const run = this.pendingRequest.bind(this, type, payload, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private pendingRequest(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error("sidecar stdin 不可用"));
        return;
      }
      const rid = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`sidecar ${type} 超时`));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ request_id: rid, type, payload }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private _onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: { request_id?: string; status?: string; payload?: Record<string, unknown>; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const rid = msg.request_id;
      if (!rid) continue;
      const entry = this.pending.get(rid);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(rid);
      if (msg.status === "success") {
        entry.resolve(msg.payload ?? {});
      } else {
        entry.reject(new Error(msg.error ?? "sidecar 返回 error"));
      }
    }
  }

  /** 兑底对话：发 reply 请求 → {reply(正文), reasoning(思考)}；sidecar 旧版无
   *  reasoning 字段时取 null（向下兼容）。任何异常返回 null 不虚构。 */
  async reply(opts: SilamReplyOpts): Promise<SilamReplyResult | null> {
    if (!this.alive || !this.proc) {
      return null;
    }
    try {
      const payload = (await this.queueRequest("reply", {
        agent_name: opts.agentName,
        agent_role: opts.agentRole,
        user_message: opts.userMessage,
        history: opts.history,
      })) as { reply?: unknown; reasoning?: unknown };
      const reply =
        typeof payload?.reply === "string" && payload.reply ? payload.reply : null;
      const reasoning =
        typeof payload?.reasoning === "string" && payload.reasoning
          ? payload.reasoning
          : null;
      return { reply, reasoning };
    } catch {
      return null;
    }
  }

  /** A-122 观战式观摩学习：辅导员（API/llama）成功示范 → sidecar 沉淀。
   *  fire-and-forget：不 await、异常静默——绝不阻塞或拖慢 GUI 对话。 */
  /** A-963 双向桥-后向：查询 SILAM 情感/成长态（fear/desire/树节点/step）。
   *  fast 超时 6s——状态展示用，绝不阻塞对话。sidecar 不可达返回 null。 */
  async getState(): Promise<SilamAffectState | null> {
    if (!this.alive || !this.proc) {
      return null;
    }
    try {
      const payload = (await this.queueRequest("status", {}, 6_000)) as Record<string, unknown>;
      return {
        fear: Number(payload.fear ?? 0),
        desire: Number(payload.desire ?? 0),
        n_nodes: Number(payload.n_nodes ?? 0),
        step: Number(payload.step ?? 0),
        langLoaded: payload.lang_loaded === true,
      };
    } catch {
      return null;
    }
  }

  observe(userMessage: string, reply: string): void {
    if (!this.alive || !this.proc || !userMessage || !reply) {
      return;
    }
    // 队列串行排一对即可：不抢占对话请求，也无需等待结果
    this.queueRequest("observe", { user_message: userMessage, reply }).catch(
      () => undefined
    );
  }

  close(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.alive = false;
  }
}