/**
 * gui/src/main/skill_seed.ts — 随包默认技能的「首启播种」。
 *
 * 为什么需要：`config/` 被 `.gitignore` 整目录忽略 —— 历史上既不随包也不被跟踪，
 * 于是**全新安装的技能库是空的**；而 `DEFAULT_TOOL_PROFILE` 声明的 6 个默认技能
 * （google-search-serp / webcrawler-deep-crawl / prompt-optimizer / market-research /
 * banner-design / ios-icon-gen）在盘上根本不存在 → 工具白名单静默解析为空
 * （不报错，只是模型「什么技能都没有」）。
 *
 * 现在默认技能以 `gui/template/skills/`（**被 git 跟踪**）为正本，经 electron-builder
 * `extraFiles` 落到安装根的 `template/skills/`，启动时播种进数据根
 * `${SLIME_ROOT}/config/skills` —— 与 `slime.toml` 走同一套「模板 → 引导」机制。
 *
 * ⚠️ 本模块**只允许** import `node:fs` / `node:path`。一旦 import core-ts，
 * 就会促使 `paths.ts` 在 `boot.ts` 设置 SLIME_ROOT **之前**完成求值，全局
 * `PROJECT_ROOT` 落空（boot.ts 头注释记录的正是这个故障形态）。因此播种所需的
 * 两个路径必须由调用方传入，本模块不自己推导根目录。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 播种台账：记录**已经被播种过**的技能名。用户之后删掉的不会复活。 */
const SEED_MANIFEST = ".seed-manifest.json";

/** 读台账（容错：文件缺失/损坏一律当空，绝不让播种失败）。 */
function readSeedManifest(skillsDir: string): string[] {
  const p = join(skillsDir, SEED_MANIFEST);
  if (!existsSync(p)) { return []; }
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeSeedManifest(skillsDir: string, names: string[]): void {
  try {
    writeFileSync(join(skillsDir, SEED_MANIFEST), `${JSON.stringify([...names].sort(), null, 2)}\n`, "utf8");
  } catch {
    /* 台账写不进去只影响「下次是否重播」，不应打断播种本身 */
  }
}

function subdirsOf(base: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  return entries.filter((e) => {
    if (e.startsWith(".")) { return false; }
    try {
      return statSync(join(base, e)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * 把 `seedDir` 下的默认技能播种到 `skillsDir`，返回**本次实际复制**的技能名。
 *
 * 语义（三条都是刻意设计，不是顺手写成这样的）：
 * 1. **不覆盖**：用户目录里已有同名技能 → 只跳过、不复制。用户改过的 skill 必须留住。
 * 2. **不复活**：台账里记过的名字 → 直接跳过。用户删掉（或经 GUI 停用移入 `.disabled/`）
 *    的默认技能，不该每次启动又冒出来。
 * 3. **幂等**：重复调用不产生任何新复制。
 *
 * 台账**只记「确实复制成功了」的名字**，不记「因用户已有同名而跳过」的名字 ——
 * 后者若也记账，用户哪天删掉自己那份，默认技能就再也补不上了（那是"记了没做过的事"）。
 * 代价只是每次启动多一次 `existsSync`，可以忽略。
 *
 * 台账仅在**真有新复制**时才写，避免无谓刷新 mtime。
 * 任何异常都不抛出 —— 播种失败最多是技能库少几个默认项，绝不能拦住应用启动。
 */
export function seedDefaultSkills(seedDir: string, skillsDir: string): string[] {
  const names = subdirsOf(seedDir);
  if (names.length === 0) { return []; }
  const known = new Set(readSeedManifest(skillsDir));
  const seeded: string[] = [];
  try {
    mkdirSync(skillsDir, { recursive: true });
    for (const name of names) {
      if (known.has(name)) { continue; }
      const target = join(skillsDir, name);
      // 用户已有同名技能（自建或手工放入、或已停用移入 .disabled 后还原）：不覆盖。
      if (existsSync(target)) { continue; }
      cpSync(join(seedDir, name), target, { recursive: true });
      known.add(name);
      seeded.push(name);
    }
  } catch {
    return seeded;
  }
  if (seeded.length > 0) { writeSeedManifest(skillsDir, [...known]); }
  return seeded;
}
