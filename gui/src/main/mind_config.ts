/**
 * gui/src/main/mind_config.ts — 心智中枢配置（config/mind.json）。
 * - vectorTool: "bge"（高优：真实 BGE-M3 嵌入）| "basic"（基础：LanceDB + 哈希占位向量）
 * - memoryRoot: 记忆 JSON 存储根（空 = 默认 Knowledge/Agent Memory；改动需重启生效）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";

export type VectorTool = "bge" | "basic";

export interface MindConfig {
  vectorTool: VectorTool;
  memoryRoot: string;
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
      llamaBin: Boolean(llamaBin) && existsSync(llamaBin),
      bgeModel: Boolean(bgeModel) && existsSync(bgeModel),
      localModelsDir: Boolean(localModelsDir) && existsSync(localModelsDir),
    },
  };
}

export type TomlKey = "llama_bin" | "model_path" | "models_dir";

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