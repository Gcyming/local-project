




import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";

export type VectorTool = "bge" | "basic";

export interface MindConfig {
  vectorTool: VectorTool;
  memoryRoot: string;
}


function statSyncSafe(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}











function looksLikeExecutable(p: string): boolean {
  const st = statSyncSafe(p);
  if (!st || !st.isFile() || st.size < 1024) { return false; }
  try {
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(4);
      if (readSync(fd, buf, 0, 4, 0) < 4) { return false; }
      if (buf[0] === 0x4d && buf[1] === 0x5a) { return true; }                              
      if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) { return true; } 
      return buf[0] === 0x23 && buf[1] === 0x21;                                            
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}


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
      
      
      
      
      llamaBin: Boolean(llamaBin) && looksLikeExecutable(llamaBin),
      bgeModel: Boolean(bgeModel) && existsSync(bgeModel) && (statSyncSafe(bgeModel)?.size ?? 0) >= 500 * 1024 * 1024,
      localModelsDir: Boolean(localModelsDir) && existsSync(localModelsDir) && countGguf(localModelsDir) > 0,
    },
  };
}


export interface ModelServerToml {
  llama_bin?: string;
  startup_timeout?: number;
  vram_budget_gb?: number;
  chat_est_gb?: number;
  embedding?: Record<string, unknown>;
  chat?: Record<string, unknown>;
}





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







export interface UpdateConfig {
  
  autoCheck?: boolean;
  
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