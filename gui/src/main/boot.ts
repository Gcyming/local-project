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
 * 安装根 = **应用自身资源**的根（`build/icon.png`、`data/`、`config/`、`Knowledge/`）。
 * 打包后这些 extraFiles 与 resources/ 平级（即 process.resourcesPath 的上一级，而非
 * getAppPath()/.. —— getAppPath 指向 resources/app.asar，其 .. 是 resources 目录，
 * 会差一级导致找不到任何自包含资源）。开发模式下就是 app 根（= gui/，图标与 data/
 * 实测都在这里）。
 *
 * ⚠️ 安装根**不是**随包依赖的根 —— 那是 BUNDLE_ROOT，见下。两者在打包模式相等，
 * 在开发模式**不相等**，混用会让随包依赖全部"检测不到"。
 *
 * 注意：此处**不可**静态 import core-ts 的 PROJECT_ROOT —— 那会迫使 paths.ts 在本文件
 * 设置 SLIME_ROOT 之前求值，使全局 PROJECT_ROOT 落空（打包后指安装根模板而非引导后数据根）。
 */
export const INSTALL_ROOT = app.isPackaged
  ? resolve(process.resourcesPath, "..")
  : app.getAppPath();

/**
 * 向上找 `slime.toml` 推导项目根。**必须与 core-ts/src/paths.ts 的
 * `resolveProjectRootFrom` 是同算法** —— 两处若漂移，"随包资源根"与 core-ts 的
 * PROJECT_ROOT 就会指向不同目录（那正是本次的故障形态）。不能 import 它：
 * paths.ts 有模块级 `PROJECT_ROOT` 常量，被 import 即在 SLIME_ROOT 设置前求值。
 */
function findProjectRoot(start: string): string {
  const origin = resolve(start);
  let dir = origin;
  for (;;) {
    if (existsSync(join(dir, "slime.toml"))) { return dir; }
    const parent = resolve(dir, "..");
    if (parent === dir) { return origin; }
    dir = parent;
  }
}

/**
 * 随包资源根 = `llama.cpp/`、`runtime/venv/`、`models/`、`slime_server.py`、
 * `requirements.txt` 这些**随包依赖**所在目录。这个才是 `resolveExtra` 想表达的东西。
 *
 * 打包：electron-builder `extraFiles` 把它们落到安装根（`from` 全是 `../…`，`to` 是根下
 * 同名子目录）→ 与安装根相等。
 * 开发：它们**留在项目根**，不会被复制到 gui/ —— 依据有两处，互为佐证：
 *   ① `scripts/prepare-runtime.mjs` 的 `ROOT = resolve(scripts/..)`（= 项目根）写入 venv/llama/models；
 *   ② `mind_config.ts` / `downloader.ts` 读同一批资源时用的就是 core-ts 的 `PROJECT_ROOT`。
 *
 * ⚠️ 曾经的写法是"开发模式直接用 app.getAppPath()"，注释断言它 = 项目根 —— 实测
 * `app.getAppPath() = D:/pilot project/gui`（electron-vite 下是 app 根，不是项目根），
 * 于是随包依赖全部落空：运行环境面板 Python/llama.cpp/本地模型 三项齐报"缺失"，
 * 且 `startPythonBackend` 直接判"后端组件缺失"进受限模式。
 */
export const BUNDLE_ROOT = app.isPackaged
  ? resolve(process.resourcesPath, "..")
  : findProjectRoot(app.getAppPath());

if (app.isPackaged) {
  const slimeRoot = join(app.getPath("userData"), "slime-data");
  process.env.SLIME_ROOT = slimeRoot;
  console.info(`[gui:boot] 打包模式：数据根 = ${slimeRoot}，安装根 = ${INSTALL_ROOT}，随包资源根 = ${BUNDLE_ROOT}`);
  bootstrapToml(slimeRoot);
} else {
  /*
   * 开发模式同样要跑一次路径矫正。原先只在打包模式跑，于是配置里**残留的上一台机器/
   * 上一个安装位置**的绝对路径永远得不到修复（实测 slime.toml 三个路径全指向
   * `D:\tool\slime\…`，都不存在）→「运行环境」与「心智中枢 → 本地部署」按陈旧路径
   * 报缺失，而本地推理真的也起不来（ModelServerManager 拿到的就是那个死路径）。
   * 模板 gui/template/slime.toml 的注释本来就写着"空路径在首启由 boot.ts 矫正"，
   * 那条契约不该因"是否打包"而失效。
   */
  console.info(`[gui:boot] 开发模式：随包资源根 = ${BUNDLE_ROOT}（安装根 = ${INSTALL_ROOT} 只放应用自身资源）`);
  bootstrapToml(BUNDLE_ROOT);
}

/** 启动引导：把 slime.toml 引导到 slimeRoot，并把随包依赖路径改写为实际位置。
 *  不再"首次启动一次写入"——每次启动都执行路径矫正（首次为完整引导，重装/换路径后为修复）：
 *  - llama_bin 永远指向随包自带的 llama-server（存在时）；选自包含安装，资源根变了也跟随。
 *  - model_path / models_dir 仅在当前值指向的 文件/目录 不存在时（陈旧/损坏/开发机残留）才修正，
 *    否则尊重用户已经下载配置好的本地模型路径。
 */
function bootstrapToml(slimeRoot: string): void {
  try {
    mkdirSync(slimeRoot, { recursive: true });
    const target = join(slimeRoot, "slime.toml");

    // 打包模式两个根相等；开发模式下 slime.toml 就在随包资源根（项目根）
    const asarToml = join(app.getAppPath(), "slime.toml");
    const extraToml = join(BUNDLE_ROOT, "slime.toml");
    const src = existsSync(extraToml) ? extraToml : (existsSync(asarToml) ? asarToml : null);
    if (!src) {
      console.warn("[gui:boot] 未找到 slime.toml 源文件，跳过引导");
      return;
    }
    // 已有用户配置则在其之上做路径矫正；否则从源模板开始
    const existed = existsSync(target);
    const base = existed ? target : src;
    const original = readFileSync(base, "utf8");
    let text = original;

    // 随包依赖：electron-builder extraFiles 放到安装根（与 resources/ 平级）；
    // 开发模式则是项目根（prepare-runtime 的落点）
    const appRoot = BUNDLE_ROOT;
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

    /*
     * 只在内容真的变了时才写。以前无条件写：开发模式下目标就是被 git 跟踪以外的
     * 项目根 slime.toml，每次启动都刷新一次 mtime，既让"文件刚被谁改了"失去信号，
     * 也让用户自己改成非随包路径的意图每次都承受一次无谓覆盖。
     */
    if (text !== original || !existed) {
      writeFileSync(target, text, "utf8");
      console.info(`[gui:boot] slime.toml 已写入 ${target}（llama_bin=${existsSync(llamaBin)} bge=${existsSync(bgeModel)} chat=${existsSync(chatDir)}）`);
    } else {
      console.info(`[gui:boot] slime.toml 路径已符合随包布局，无需改写（${target}）`);
    }
  } catch (e) {
    console.warn(`[gui:boot] slime.toml 引导失败（不影响启动）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function resolveSlimeRoot(): string | null {
  return process.env.SLIME_ROOT ? resolve(process.env.SLIME_ROOT) : null;
}