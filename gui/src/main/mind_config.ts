/**
 * gui/src/main/mind_config.ts — 心智中枢配置（config/mind.json）。
 * - vectorTool: "bge"（高优：真实 BGE-M3 嵌入）| "basic"（基础：LanceDB + 哈希占位向量）
 * - memoryRoot: 记忆 JSON 存储根（空 = 默认 Knowledge/Agent Memory；改动需重启生效）
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";

export type VectorTool = "bge" | "basic";

export interface MindConfig {
  vectorTool: VectorTool;
  memoryRoot: string;
}

/** statSync 安全包装（文件不存在/无权限返回 null） */
function statSyncSafe(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * 是不是一个**真的可执行文件**（而不是残缺下载、HTML 错误页、git-lfs 指针）。
 *
 * 判据是文件头魔数，**不是体积**。体积门槛踩过坑：llama.cpp 官方预编译包是
 * shared-libs 布局 —— 真正的代码在 `ggml-*.dll` / `llama.dll` 里，`llama-server.exe`
 * 只是个薄壳（本机实测 **9216 字节**，`--version` 正常输出 `build 10509`）。
 * 原先要求 ≥ 1MB，于是随手放进来的一个**完全可用**的二进制被判成"缺失"，
 * 界面只剩下载按钮 —— 而重新下载一百遍也是同一个 9KB 的壳。
 * 魔数判据与构建布局无关，且照样拦得住 3KB 残片（`PK`/`<html`）与空文件。
 */
function looksLikeExecutable(p: string): boolean {
  const st = statSyncSafe(p);
  if (!st || !st.isFile() || st.size < 1024) { return false; }
  try {
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(4);
      if (readSync(fd, buf, 0, 4, 0) < 4) { return false; }
      if (buf[0] === 0x4d && buf[1] === 0x5a) { return true; }                              // Windows PE "MZ"
      if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) { return true; } // ELF
      return buf[0] === 0x23 && buf[1] === 0x21;                                            // "#!" 脚本
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 目录内 .gguf 文件计数（本地模型目录就绪判定） */
function countGguf(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".gguf")).length;
  } catch {
    return 0;
  }
}

const MIND_PATH = resolve(PROJECT_ROOT, "config", "mind.json");

const DEFAULT_CONFIG: MindConfig = { vectorTool: "bge", memoryRoot: "" };

export function loadMindConfig(): MindConfig {
  try {
    if (existsSync(MIND_PATH)) {
      const raw = JSON.parse(readFileSync(MIND_PATH, "utf8")) as Partial<MindConfig>;
      return {
        vectorTool: raw.vectorTool === "basic" ? "basic" : "bge",
        memoryRoot: typeof raw.memoryRoot === "string" ? raw.memoryRoot : "",
      };
    }
  } catch (e) {
    console.warn(`[gui:mind] 配置读取失败，使用默认值: ${e}`);
  }
  return { ...DEFAULT_CONFIG };
}

export function saveMindConfig(patch: Partial<MindConfig>): MindConfig {
  const next = { ...loadMindConfig(), ...patch };
  try {
    mkdirSync(dirname(MIND_PATH), { recursive: true });
    writeFileSync(MIND_PATH, JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.warn(`[gui:mind] 配置保存失败: ${e}`);
  }
  return next;
}

/** 依赖状态（换设备部署检查：模型/llama.cpp 不在 git 仓库，需手动就位） */
export interface DepStatus {
  llamaBin: string;
  bgeModel: string;
  localModelsDir: string;
  ok: { llamaBin: boolean; bgeModel: boolean; localModelsDir: boolean };
}

export function readDepStatus(): DepStatus {
  let llamaBin = "";
  let bgeModel = "";
  let localModelsDir = "";
  try {
    const tomlPath = resolve(PROJECT_ROOT, "slime.toml");
    if (existsSync(tomlPath)) {
      const lines = readFileSync(tomlPath, "utf8").split(/\r?\n/);
      let inModelServer = false;
      let inEmbedding = false;
      let inChat = false;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        // 子段优先判定：model_server.embedding / model_server.chat 属 model_server 根段
        if (line === "[model_server.embedding]") { inModelServer = true; inEmbedding = true; inChat = false; continue; }
        if (line === "[model_server.chat]") { inModelServer = true; inEmbedding = false; inChat = true; continue; }
        if (line === "[model_server]") { inModelServer = true; inEmbedding = false; inChat = false; continue; }
        if (line.startsWith("[") && line.endsWith("]")) { inModelServer = false; inEmbedding = false; inChat = false; continue; }
        if (!inModelServer) continue;
        if (line.startsWith("llama_bin")) {
          llamaBin = (line.split("=", 2)[1] ?? "").trim().replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
        } else if (inEmbedding && line.startsWith("model_path")) {
          bgeModel = (line.split("=", 2)[1] ?? "").trim().replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
        } else if (inChat && line.startsWith("models_dir")) {
          localModelsDir = (line.split("=", 2)[1] ?? "").trim().replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
        }
      }
    }
  } catch (e) {
    console.warn(`[gui:mind] slime.toml 读取失败: ${e}`);
  }
  return {
    llamaBin,
    bgeModel,
    localModelsDir,
    ok: {
      // 存在 + **可执行性**校验：残缺/中断的下载文件（如 3KB 的 bge 残片、HTML 错误页）
      // 不得误判为就绪，否则依赖状态显示"✅"、下载按钮消失，模型永远 idle 且无法重新下载。
      // ⚠️ llamaBin 的判据是文件头魔数而不是体积门槛（见 looksLikeExecutable 的注释：
      // shared-libs 布局下合法 exe 只有 9KB，"≥1MB"会把它判成缺失）。
      llamaBin: Boolean(llamaBin) && looksLikeExecutable(llamaBin),
      bgeModel: Boolean(bgeModel) && existsSync(bgeModel) && (statSyncSafe(bgeModel)?.size ?? 0) >= 500 * 1024 * 1024,
      localModelsDir: Boolean(localModelsDir) && existsSync(localModelsDir) && countGguf(localModelsDir) > 0,
    },
  };
}

/** ModelServerManager 配置键（对齐 slime.toml [model_server] 各子段的字段名） */
export interface ModelServerToml {
  llama_bin?: string;
  startup_timeout?: number;
  vram_budget_gb?: number;
  chat_est_gb?: number;
  embedding?: Record<string, unknown>;
  chat?: Record<string, unknown>;
}

/**
 * 解析 slime.toml 的 [model_server]（含 embedding/chat 子段）为 ModelServerManager 配置。
 * 失败返回默认空配置（管理器可按子段缺省兜底）。
 */
export function readModelServerConfig(): ModelServerToml {
  const cfg: ModelServerToml = {};
  const sections: Record<string, Record<string, string>> = {};
  try {
    const tomlPath = resolve(PROJECT_ROOT, "slime.toml");
    if (!existsSync(tomlPath)) { return cfg; }
    let current = "root";
    sections[current] = {};
    for (const raw of readFileSync(tomlPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[") && line.endsWith("]")) {
        current = line.slice(1, -1).trim();
        sections[current] ??= {};
        continue;
      }
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
      if (key) sections[current][key] = val;
    }
  } catch (e) {
    console.warn(`[gui:mind] slime.toml 模型段解析失败: ${e}`);
    return cfg;
  }
  const root = sections["model_server"] ?? {};
  const pick = (v: string | undefined): unknown => {
    if (v === undefined || v === "") return undefined;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === "true") return true;
    if (v === "false") return false;
    return v;
  };
  if (root.llama_bin) cfg.llama_bin = root.llama_bin;
  if (root.startup_timeout) cfg.startup_timeout = Number(root.startup_timeout);
  if (root.vram_budget_gb) cfg.vram_budget_gb = Number(root.vram_budget_gb);
  if (root.chat_est_gb) cfg.chat_est_gb = Number(root.chat_est_gb);
  for (const sub of ["embedding", "chat"] as const) {
    const s = sections[`model_server.${sub}`];
    if (s) {
      const map: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) map[k] = pick(v);
      cfg[sub] = map;
    }
  }
  return cfg;
}

export type TomlKey = "llama_bin" | "model_path" | "models_dir";

/** 自动更新配置（slime.toml [update] 段）。
 *
 *  A-1059③：这里**只负责如实读出键值**，"该不该自动检查"的判据搬到了纯模块
 *  `core-ts/src/services/updatePolicy.ts`（可单测、过变异）。
 *  之所以要把 `enabled` 改成可选：**"没给这个键"和"给了 false"是两件事** ——
 *  后者可能是我们自己的模板发出去的默认值，不是用户意图（详见 updatePolicy.ts 文件头）。 */
export interface UpdateConfig {
  /** 新键：启动时自动检查更新（权威）。未给 = undefined */
  autoCheck?: boolean;
  /** 旧键（历史语义混用）。未给 = undefined */
  enabled?: boolean;
  feedUrl: string;
}

export function readUpdateConfig(): UpdateConfig {
  let enabled: boolean | undefined;
  let autoCheck: boolean | undefined;
  let feedUrl = "";
  try {
    const tomlPath = resolve(PROJECT_ROOT, "slime.toml");
    if (existsSync(tomlPath)) {
      const lines = readFileSync(tomlPath, "utf8").split(/\r?\n/);
      let inUpdate = false;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (line === "[update]") { inUpdate = true; continue; }
        if (line.startsWith("[") && line.endsWith("]")) { inUpdate = false; continue; }
        if (!inUpdate) continue;
        if (line.startsWith("auto_check")) {
          autoCheck = line.split("=", 2)[1]?.trim() === "true";
        } else if (line.startsWith("enabled")) {
          enabled = line.split("=", 2)[1]?.trim() === "true";
        } else if (line.startsWith("feed_url")) {
          feedUrl = (line.split("=", 2)[1] ?? "").trim().replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
        }
      }
    }
  } catch (e) {
    console.warn(`[gui:mind] slime.toml 更新段读取失败: ${e}`);
  }
  return {
    ...(autoCheck !== undefined ? { autoCheck } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    feedUrl,
  };
}

/** 改写 slime.toml 单个键值（仅当键已存在；路径转义 TOML 反斜杠） */
export function updateTomlKey(key: TomlKey, value: string): boolean {
  const tomlPath = resolve(PROJECT_ROOT, "slime.toml");
  try {
    if (!existsSync(tomlPath)) return false;
    const text = readFileSync(tomlPath, "utf8");
    if (!new RegExp(`${key}\\s*=`).test(text)) return false;
    const esc = value.replace(/\\/g, "\\\\");
    const next = text.replace(new RegExp(`(${key}\\s*=\\s*)"[^"]*"`), `$1"${esc}"`);
    if (next !== text) {
      writeFileSync(tomlPath, next, "utf8");
      return true;
    }
  } catch (e) {
    console.warn(`[gui:mind] slime.toml 写入 ${key} 失败: ${e}`);
  }
  return false;
}

/** 项目文件夹内自动检索依赖（排除重目录，限深度）；找不到返回 null */
export function detectLocalDeps(): { llamaBin: string | null; bgeModel: string | null; chatDir: string | null } {
  const res = { llamaBin: null as string | null, bgeModel: null as string | null, chatDir: null as string | null };
  const skip = new Set(["node_modules", ".git", "out", "release", "dist", "__pycache__", ".pytest_cache"]);
  const ggufDirs = new Map<string, number>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = resolve(dir, name);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) {
        walk(p, depth + 1);
        continue;
      }
      const lower = name.toLowerCase();
      if ((lower === "llama-server.exe" || lower === "llama-server") && !res.llamaBin) {
        res.llamaBin = p;
      } else if (lower.startsWith("bge-m3") && lower.endsWith(".gguf") && !res.bgeModel) {
        res.bgeModel = p;
      } else if (lower.endsWith(".gguf")) {
        ggufDirs.set(dir, (ggufDirs.get(dir) ?? 0) + 1);
      }
    }
  };
  try {
    walk(PROJECT_ROOT, 0);
  } catch (e) {
    console.warn(`[gui:mind] 依赖自动检索失败: ${e}`);
  }
  // 聊天模型目录：含 .gguf 最多的目录（排除嵌入模型所在目录）
  const bgeDir = res.bgeModel ? dirname(res.bgeModel) : null;
  let bestDir = "";
  let bestCount = 0;
  for (const [dir, count] of ggufDirs) {
    if (bgeDir && resolve(dir) === resolve(bgeDir)) continue;
    if (count > bestCount) {
      bestCount = count;
      bestDir = dir;
    }
  }
  if (bestDir) res.chatDir = bestDir;
  return res;
}