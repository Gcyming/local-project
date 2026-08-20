/**
 * gui/src/main/boot.ts — 数据根引导（必须最先被 index.ts import）。
 *
 * 打包后（app.isPackaged）源码树在 asar 内只读，config/、Knowledge/、data/
 * 必须落到用户可写目录。此处设置 SLIME_ROOT，core-ts/src/paths.ts 在模块
 * 加载时读取该值推导 PROJECT_ROOT —— 因此本模块必须先于任何 core-ts 模块
 * 完成执行（ESM import 顺序保证：index.ts 第一行 import "./boot.js"）。
 *
 * 首次启动额外把 asar 内的 slime.toml 引导到 SLIME_ROOT，并把模型/推理
 * 路径改写为包内自带资源（resources/llama.cpp/build/bin、resources/models）
 * —— 自包含安装包开箱即用，依赖状态直接就绪（修复安装依赖后重启"检测不到"）。
 *
 * 开发模式（未打包）不设置 env，core-ts 回退源码相对推导，行为与 legacy 一致。
 */
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";

if (app.isPackaged) {
  const slimeRoot = join(app.getPath("userData"), "slime-data");
  process.env.SLIME_ROOT = slimeRoot;
  console.info(`[gui:boot] 打包模式：数据根 = ${slimeRoot}`);
  bootstrapToml(slimeRoot);
}

/** 首次启动：把 asar 内 slime.toml 引导到 SLIME_ROOT，并把依赖路径改写为包内自带资源。 */
function bootstrapToml(slimeRoot: string): void {
  try {
    const target = join(slimeRoot, "slime.toml");
    if (existsSync(target)) {
      return; // 已有引导配置（用户改动过），不覆盖
    }
    // asar 内（旧布局）或 app 根（extraFiles 新布局，与 resources/ 平级）
    const asarToml = join(app.getAppPath(), "slime.toml"); // resources/app.asar/slime.toml
    const extraToml = join(app.getAppPath(), "..", "slime.toml"); // app 根（extraFiles 布局）
    const src = existsSync(extraToml) ? extraToml : (existsSync(asarToml) ? asarToml : null);
    if (!src) {
      console.warn("[gui:boot] 未找到 slime.toml 源文件，跳过引导");
      return;
    }
    mkdirSync(slimeRoot, { recursive: true });

    // 包内自带依赖：electron-builder extraFiles 放到 app 根（与 resources/ 平级）
    const appRoot = app.isPackaged ? join(app.getAppPath(), "..") : PROJECT_ROOT;
    const isWin = process.platform === "win32";
    const llamaBin = join(appRoot, "llama.cpp", "build", "bin", isWin ? "llama-server.exe" : "llama-server");
    const bgeModel = join(appRoot, "models", "BGE-M3", "bge-m3-q8_0.gguf");
    const chatDir = join(appRoot, "models", "chat");

    let text = readFileSync(asarToml, "utf8");
    // 仅当包内资源真实存在才改写（模板里是开发机路径，改指向包内即开箱可用）
    const tomlEsc = (p: string): string => p.replace(/\\/g, "\\\\");
    const replaceKey = (key: string, value: string): void => {
      text = text.replace(new RegExp(`(${key}\\s*=\\s*)"[^"]*"`), `$1"${tomlEsc(value)}"`);
    };
    if (existsSync(llamaBin)) { replaceKey("llama_bin", llamaBin); }
    if (existsSync(bgeModel)) { replaceKey("model_path", bgeModel); }
    if (existsSync(chatDir)) { replaceKey("models_dir", chatDir); }

    writeFileSync(target, text, "utf8");
    console.info(`[gui:boot] slime.toml 已引导到 ${target}（llama_bin=${existsSync(llamaBin)} bge=${existsSync(bgeModel)} chat=${existsSync(chatDir)}）`);
  } catch (e) {
    console.warn(`[gui:boot] slime.toml 引导失败（不影响启动）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function resolveSlimeRoot(): string | null {
  return process.env.SLIME_ROOT ? resolve(process.env.SLIME_ROOT) : null;
}