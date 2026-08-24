/**
 * gui/src/main/boot.ts — 数据根引导（必须最先被 index.ts import）。
 *
 * 打包后（app.isPackaged）源码树在 asar 内只读，config/、Knowledge/、data/
 * 必须落到用户可写目录。此处设置 SLIME_ROOT，core-ts/src/paths.ts 在模块
 * 加载时读取该值推导 PROJECT_ROOT —— 因此本模块必须先于任何 core-ts 模块
 * 完成执行（ESM import 顺序保证：index.ts 第一行 import "./boot.js"）。
 *
 * 首次启动额外把 asar 内的 slime.toml 引导到 SLIME_ROOT，并把推理路径
 * 改写为包内自带资源（安装根/llama.cpp/build/bin，与 resources/ 平级）
 * —— 自包含安装包开箱即用，依赖状态直接就绪（修复安装依赖后重启"检测不到"）。
 * 注意：模型不在包内（用户按需下载），models 落点指向 SLIME_ROOT 下可写目录。
 *
 * 开发模式（未打包）不设置 env，core-ts 回退源码相对推导，行为与 legacy 一致。
 */
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 安装根。打包后 slime.toml/llama.cpp/runtime/venv 等 extraFiles 与 resources/ 平级
 * （即 process.resourcesPath 的上一级，而非 getAppPath()/.. —— getAppPath 指向
 * resources/app.asar，其 .. 是 resources 目录，会差一级导致找不到任何自包含资源）。
 *
 * 注意：此处**不可**静态 import core-ts 的 PROJECT_ROOT —— 那会迫使 paths.ts 在本文件
 * 设置 SLIME_ROOT 之前求值，使全局 PROJECT_ROOT 落空（打包后指安装根模板而非
 * 引导后数据根）。开发模式直接用 app.getAppPath()（electron-vite dev 下为项目根）。
 */
export const INSTALL_ROOT = app.isPackaged
  ? resolve(process.resourcesPath, "..")
  : app.getAppPath();

if (app.isPackaged) {
  const slimeRoot = join(app.getPath("userData"), "slime-data");
  process.env.SLIME_ROOT = slimeRoot;
  console.info(`[gui:boot] 打包模式：数据根 = ${slimeRoot}，安装根 = ${INSTALL_ROOT}`);
  bootstrapToml(slimeRoot);
}

/** 启动引导：把 slime.toml 引导到 SLIME_ROOT，并把自包含依赖路径改写为包内资源。
 *  不再"首次启动一次写入"——每次启动都执行路径矫正（首次为完整引导，重装/换路径后为修复）：
 *  - llama_bin 永远指向包内自带的 llama-server（存在时）；选自包含安装，安装根变了也跟随。
 *  - model_path / models_dir 仅在当前值指向的 文件/目录 不存在时（陈旧/损坏/开发机残留）才修正，
 *    否则尊重用户已经下载配置好的本地模型路径。
 */
function bootstrapToml(slimeRoot: string): void {
  try {
    mkdirSync(slimeRoot, { recursive: true });
    const target = join(slimeRoot, "slime.toml");

    // asar 内（旧布局）或 app 根（extraFiles 新布局，与 resources/ 平级）
    const asarToml = join(app.getAppPath(), "slime.toml");
    const extraToml = join(INSTALL_ROOT, "slime.toml");
    const src = existsSync(extraToml) ? extraToml : (existsSync(asarToml) ? asarToml : null);
    if (!src) {
      console.warn("[gui:boot] 未找到 slime.toml 源文件，跳过引导");
      return;
    }
    // 已有用户配置则在其之上做路径矫正；否则从源模板开始
    const base = existsSync(target) ? target : src;
    let text = readFileSync(base, "utf8");

    // 包内自带依赖：electron-builder extraFiles 放到安装根（与 resources/ 平级）
    const appRoot = INSTALL_ROOT;
    const isWin = process.platform === "win32";
    const llamaBin = join(appRoot, "llama.cpp", "build", "bin", isWin ? "llama-server.exe" : "llama-server");
    const bgeModel = join(appRoot, "models", "BGE-M3", "bge-m3-q8_0.gguf");
    const chatDir = join(appRoot, "models", "chat");
    // 模型不在安装包内（用户按需下载）：指向可写的 SLIME_ROOT 下 models/，下载器落地到此处
    const modelsRoot = join(slimeRoot, "models");
    const bgeModelUser = join(modelsRoot, "BGE-M3", "bge-m3-q8_0.gguf");
    const chatDirUser = join(modelsRoot, "chat");

    const tomlEsc = (p: string): string => p.replace(/\\/g, "\\\\");
    // 匹配 key = "..."；返回当前 value（解码 \\ 转义）并执行 value 替换（返回是否发生）
    const applyKey = (key: string, pick: (cur: string) => string): boolean => {
      const re = new RegExp(`(${key}\\s*=\\s*)"((?:\\\\.|[^"\\\\])*)"`);
      const m = re.exec(text);
      if (!m) { return false; }
      const cur = m[2].replace(/\\\\/g, "\\");
      const next = pick(cur);
      if (next === cur) { return false; }
      text = text.replace(re, `$1"${tomlEsc(next)}"`);
      return true;
    };

    // llama_bin：包内自带二进制存在则始终跟随安装根（自包含，避免重装后残留旧路径）
    if (existsSync(llamaBin)) {
      applyKey("llama_bin", () => llamaBin);
    }
    // 模型路径：仅当当前目标不存在时修正（不覆盖用户已下载的合法配置）
    applyKey("model_path", (cur) => (cur && existsSync(cur) ? cur : (existsSync(bgeModel) ? bgeModel : bgeModelUser)));
    applyKey("models_dir", (cur) => (cur && existsSync(cur) ? cur : (existsSync(chatDir) ? chatDir : chatDirUser)));

    writeFileSync(target, text, "utf8");
    console.info(`[gui:boot] slime.toml 已写入 ${target}（llama_bin=${existsSync(llamaBin)} bge=${existsSync(bgeModel)} chat=${existsSync(chatDir)}）`);
  } catch (e) {
    console.warn(`[gui:boot] slime.toml 引导失败（不影响启动）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function resolveSlimeRoot(): string | null {
  return process.env.SLIME_ROOT ? resolve(process.env.SLIME_ROOT) : null;
}