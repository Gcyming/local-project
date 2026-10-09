














import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { seedDefaultDirs, seedOrUpgradeDirs, type SeedUpgradeRecord } from "./skill_seed.js";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
/* A-1197④：数据根不再是写死的 %APPDATA%\\slime-data —— 由 dataRoot.ts 统一决定
   （用户在设置里选的路径从这里生效；切换需要重启，原因见 dataRoot.ts 顶部注释）。 */
import { RUNTIME_DATA_DIR } from "./dataRoot.js";














export const INSTALL_ROOT = app.isPackaged
  ? resolve(process.resourcesPath, "..")
  : app.getAppPath();







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
















export const BUNDLE_ROOT = app.isPackaged
  ? resolve(process.resourcesPath, "..")
  : findProjectRoot(app.getAppPath());

if (app.isPackaged) {
  const slimeRoot = RUNTIME_DATA_DIR;
  process.env.SLIME_ROOT = slimeRoot;
  console.info(`[gui:boot] 打包模式：数据根 = ${slimeRoot}，安装根 = ${INSTALL_ROOT}，随包资源根 = ${BUNDLE_ROOT}`);
  bootstrapToml(slimeRoot);
  bootstrapSkills(slimeRoot);
  bootstrapPlugins();
} else {
  












  console.info(`[gui:boot] 开发模式：随包资源根 = ${BUNDLE_ROOT}（安装根 = ${INSTALL_ROOT} 只放应用自身资源）`);
  bootstrapToml(BUNDLE_ROOT);
  /* A-1198：示例扩展在开发模式也播种（数据根 = <repo>/config/plugins）——
     「活教材」对开发者同样有用；台账机制保证不覆盖用户/开发者的改动。 */
  bootstrapPlugins();
}







function bootstrapToml(slimeRoot: string): void {
  try {
    mkdirSync(slimeRoot, { recursive: true });
    const target = join(slimeRoot, "slime.toml");

    
    const asarToml = join(app.getAppPath(), "slime.toml");
    const extraToml = join(BUNDLE_ROOT, "slime.toml");
    const src = existsSync(extraToml) ? extraToml : (existsSync(asarToml) ? asarToml : null);
    if (!src) {
      console.warn("[gui:boot] 未找到 slime.toml 源文件，跳过引导");
      return;
    }
    
    const existed = existsSync(target);
    const base = existed ? target : src;
    const original = readFileSync(base, "utf8");
    let text = original;

    
    
    const appRoot = BUNDLE_ROOT;
    const isWin = process.platform === "win32";
    const llamaBin = join(appRoot, "llama.cpp", "build", "bin", isWin ? "llama-server.exe" : "llama-server");
    const bgeModel = join(appRoot, "models", "BGE-M3", "bge-m3-q8_0.gguf");
    const chatDir = join(appRoot, "models", "chat");
    
    const modelsRoot = join(slimeRoot, "models");
    const bgeModelUser = join(modelsRoot, "BGE-M3", "bge-m3-q8_0.gguf");
    const chatDirUser = join(modelsRoot, "chat");

    const tomlEsc = (p: string): string => p.replace(/\\/g, "\\\\");
    
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

    
    if (existsSync(llamaBin)) {
      applyKey("llama_bin", () => llamaBin);
    }
    
    applyKey("model_path", (cur) => (cur && existsSync(cur) ? cur : (existsSync(bgeModel) ? bgeModel : bgeModelUser)));
    applyKey("models_dir", (cur) => (cur && existsSync(cur) ? cur : (existsSync(chatDir) ? chatDir : chatDirUser)));

    




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












function bootstrapSkills(slimeRoot: string): void {
  try {
    const seedDir = join(INSTALL_ROOT, "template", "skills");
    if (!existsSync(seedDir)) {
      
      console.warn(`[gui:boot] 未找到随包默认技能目录 ${seedDir} —— 全新安装的技能库将为空（检查 extraFiles: template/skills）`);
      return;
    }
    const target = join(slimeRoot, "config", "skills");
    const seeded = seedDefaultDirs(seedDir, target);
    if (seeded.length > 0) {
      console.info(`[gui:boot] 已播种 ${seeded.length} 个默认技能 → ${target}：${seeded.join("、")}`);
    } else {
      console.info(`[gui:boot] 默认技能无需播种（台账已齐或用户已有同名技能）：${target}`);
    }
  } catch (e) {
    console.warn(`[gui:boot] 默认技能播种失败（不影响启动）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * A-1198：播种**官方示例扩展**（「活教材」）—— 从随包 `template/plugins` 复制到
 * `<数据根>/config/plugins`，装载逻辑与普通用户扩展完全一致（origin=agent、可卸载、可开关）。
 *
 * A-1200 · B4：**随包示例改版后老用户要能拿到新版**（否则新能力永远只存在于源码里）。
 * 于是这里从「只播种」升级为「播种 + 版本感知升级」：
 *   · 逐文件覆盖（模板里没有的文件 = 用户数据，一个都不碰）；
 *   · 覆盖前备份到 `<数据根>/config/plugins-backup/`，**备份失败就不升级**（fail-closed）；
 *   · 升级结果记进 `pluginSeedUpgrades` 供扩展页如实告知（不静默升级）。
 *
 * 边界（写清）：
 *   · 不覆盖用户自建/改过的同名目录；删掉的不复活（台账语义，见 skill_seed.ts）；
 *   · 失败只告警不阻塞启动（示例缺位不是致命问题；扩展页「安装/更新示例扩展」是第二条路）；
 *   · 目标目录用 `PROJECT_ROOT`（= 主进程 `PLUGINS_ROOT` 的同一产地），保证「播种落点 = 扫描落点」。
 */
function bootstrapPlugins(): void {
  try {
    const seedDir = join(INSTALL_ROOT, "template", "plugins");
    if (!existsSync(seedDir)) {
      console.warn(`[gui:boot] 未找到随包示例扩展目录 ${seedDir} —— 跳过播种（检查 extraFiles: template/plugins）`);
      return;
    }
    const target = join(PROJECT_ROOT, "config", "plugins");
    const backupRoot = join(PROJECT_ROOT, "config", "plugins-backup");
    const res = seedOrUpgradeDirs(seedDir, target, { backupRoot });
    if (res.seeded.length > 0) {
      console.info(`[gui:boot] 已播种 ${res.seeded.length} 个示例扩展 → ${target}：${res.seeded.join("、")}`);
    }
    for (const u of res.upgraded) {
      console.info(`[gui:boot] 示例扩展已升级：${u.name} ${u.from} → ${u.to}（旧版备份在 ${u.backup}）`);
    }
    seedUpgrades = res.upgraded;
    if (res.seeded.length === 0 && res.upgraded.length === 0) {
      console.info(`[gui:boot] 示例扩展无需播种/升级（台账已齐、目录已存在或版本未变）：${target}`);
    }
  } catch (e) {
    console.warn(`[gui:boot] 示例扩展播种失败（不影响启动；可在扩展页手动安装）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* A-1200 · B4：本次启动实际发生的示例升级 —— 供扩展页**如实告知**（不静默升级）。
   为什么放在模块级而不是返回值：`bootstrapPlugins()` 在应用启动早期跑，
   而扩展页要等到用户打开设置才读 —— 中间隔着窗口创建与 IPC，返回值传不过去。 */
let seedUpgrades: SeedUpgradeRecord[] = [];
export function takeSeedUpgrades(): SeedUpgradeRecord[] {
  const out = seedUpgrades;
  seedUpgrades = [];
  return out;
}