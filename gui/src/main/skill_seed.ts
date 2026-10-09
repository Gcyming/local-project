import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A-1198：**随包播种**（默认技能 / 官方示例扩展）—— 从安装根 `template/` 复制到数据根。
 *
 * ## 台账（`.seed-manifest.json`）的三条语义
 *   ① **不覆盖**：台账里没有 + 目录已存在（用户自建 / 改过）⇒ 跳过，不认领；
 *   ② **不复活**：台账里有 + 目录被用户删了 ⇒ 不再放回来（删 = 明确意图）；
 *   ③ **可升级**（A-1200 · B4 新增）：随包内容改版后，老用户能拿到新版。
 *
 * ## A-1200 · B4：为什么必须有「升级」
 * 缺陷现场（用户实测）：官方示例扩展加了贡献点（多皮肤 / CSS 外观 / 栏目），
 * 但**界面上一律看不见** —— 数据根里的示例还是旧版，而本实现**从不比对内容**
 * （只看「台账有名字」或「目录已存在」就跳过）。
 * ⇒ 随包示例一旦改版，老用户永远停在旧版：这就是「改了但用户看不见」的静默失效。
 *
 * 升级的三条硬边界（以下三条都由本文件的实现与守卫共同承担）：
 *   1. **只升不降**：模板版本**严格高于**已装版本才覆盖（`comparePluginVersions`）；
 *   2. **保用户数据**：覆盖是**逐文件**的，模板里没有的文件（`settings.json` / `trust.json` 等）
 *      **一个都不碰**（绝不做"删目录再复制"）；
 *   3. **先备份再覆盖；备份失败就不升级**（fail-closed：宁可停在旧版，也不做不可逆覆盖）。
 */

const SEED_MANIFEST = ".seed-manifest.json";

/**
 * 语义化版本比较（A-1200 · B4）。返回 >0 表示 a 比 b 新。
 * ⚠️ **不能用字符串比较**：字符串比会把 `1.10.0` 判成小于 `1.9.0`（`"10" < "9"`），
 * 于是"新版本永远升不上去"，而且表面看一切正常 —— 典型的静默失效。
 */
export function comparePluginVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) { return d > 0 ? 1 : -1; }
  }
  return 0;
}

/** 版本号解析：`1.2.3` → `[1,2,3]`。非数字段按 0 处理（`1.2.beta` → `[1,2,0]`）。 */
function parseVersion(v: string): number[] {
  return String(v ?? "")
    .split(/[.\-+]/)
    .slice(0, 4)
    .map((x) => {
      const n = parseInt(x, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
}

/** 从目录的 `plugin.json` 读版本；读不到（无文件 / 坏 JSON / 无字段）⇒ null。 */
function readPluginVersion(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object") { return null; }
    const v = (parsed as { version?: unknown }).version;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/* ── 台账读写（A-1200 · B4：从「字符串数组」升级为「能记版本」的形态）────────
 * ⚠️ **必须向后兼容**：老的 `["hello-slime"]` 形态要能读（版本记为 null = 未知）。
 * 版本未知 ⇒ **不升级**（没有版本依据就别动用户目录），但仍受「不覆盖 / 不复活」管。 */
interface SeedEntry { name: string; version: string | null }

function readSeedManifest(targetDir: string): SeedEntry[] {
  const p = join(targetDir, SEED_MANIFEST);
  if (!existsSync(p)) { return []; }
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(parsed)) { return []; }
    const out: SeedEntry[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        out.push({ name: item, version: null });                    // 老格式：版本未知
      } else if (item !== null && typeof item === "object") {
        const name = (item as { name?: unknown }).name;
        const version = (item as { version?: unknown }).version;
        if (typeof name === "string" && name) {
          out.push({ name, version: typeof version === "string" && version ? version : null });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeSeedManifest(targetDir: string, entries: SeedEntry[]): void {
  try {
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    writeFileSync(join(targetDir, SEED_MANIFEST), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  } catch {
    // 台账写失败不致命：下次启动会重算（最坏是重复覆盖一次同名目录 —— 而那有备份）
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

/** 目录级备份：`<备份根>/<名>-<时间戳>/`。失败返回 null（**调用方必须据此放弃升级**）。 */
function backupDir(before: string, backupRoot: string, name: string, now: Date): string | null {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dest = join(backupRoot, `${name}-${stamp}`);
  try {
    mkdirSync(backupRoot, { recursive: true });
    cpSync(before, dest, { recursive: true });
    return dest;
  } catch {
    return null;
  }
}

/**
 * 把模板内容**逐文件覆盖**到目标目录。
 * ⚠️ 绝不做「删目录再整份复制」：那会把模板里没有的文件（`settings.json` / `trust.json`
 * 等**用户数据**）一起抹掉。「模板有的才覆盖、模板没有的不动」就是本函数的契约，
 * 也是"保用户数据"这条硬边界的实现方式。
 */
function copyTemplateOver(seedChild: string, targetChild: string): void {
  const entries = readdirSync(seedChild, { withFileTypes: true });
  mkdirSync(targetChild, { recursive: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) { continue; }
    const src = join(seedChild, e.name);
    const dst = join(targetChild, e.name);
    if (e.isDirectory()) {
      copyTemplateOver(src, dst);
    } else {
      cpSync(src, dst, { force: true });
    }
  }
}

export interface SeedUpgradeRecord {
  name: string;
  from: string;
  to: string;
  /** 备份目录（升级前必定存在 —— 备份失败就不升级）。 */
  backup: string;
}

export interface SeedResult {
  /** 首次播种的名字。 */
  seeded: string[];
  /** 本次发生的升级（A-1200 · B4）。 */
  upgraded: SeedUpgradeRecord[];
}

export interface SeedOptions {
  /** 备份根目录；不给 ⇒ **不升级**（没有回滚点的覆盖是禁止项）。 */
  backupRoot?: string;
  /** 时间源（测试注入用）。 */
  now?: () => Date;
  /** 只处理这些名字（缺省 = 模板里全部）。扩展页「安装示例扩展」按钮走这条窄路径。 */
  only?: string[];
}

/** 只关心"播了哪些"的调用方用它（技能播种）。 */
export function seedDefaultDirs(seedDir: string, targetDir: string, opts: SeedOptions = {}): string[] {
  return seedOrUpgradeDirs(seedDir, targetDir, opts).seeded;
}

/**
 * 播种 + 升级（**技能与插件共用的唯一实现**）。
 *
 * 决策表（A-1200 · B4 之后）：
 * | 台账 | 目录 | 模板版本 vs 已装版本 | 动作 |
 * |---|---|---|---|
 * | 无 | 无 | — | **播种**（复制整目录） |
 * | 无 | 有 | — | **跳过**（用户自建 / 改过，不认领） |
 * | 有 | 无 | — | **跳过**（用户删了 ⇒ 不复活） |
 * | 有 | 有 | 模板更高 + 有备份根 + 备份成功 | **升级**（保用户数据） |
 * | 有 | 有 | 相同 / 更低 / 任一版本未知 / 无备份根 / 备份失败 | **跳过**（只升不降；fail-closed） |
 */
export function seedOrUpgradeDirs(seedDir: string, targetDir: string, opts: SeedOptions = {}): SeedResult {
  const all = subdirsOf(seedDir);
  const names = opts.only ? all.filter((n) => opts.only!.includes(n)) : all;
  if (names.length === 0) { return { seeded: [], upgraded: [] }; }

  const entries = readSeedManifest(targetDir);
  const known = new Map<string, SeedEntry>(entries.map((e) => [e.name, e]));
  const seeded: string[] = [];
  const upgraded: SeedUpgradeRecord[] = [];
  const now = opts.now ?? (() => new Date());

  try {
    mkdirSync(targetDir, { recursive: true });
    for (const name of names) {
      const seedChild = join(seedDir, name);
      const targetChild = join(targetDir, name);
      const entry = known.get(name);

      /* ① 首次播种：台账没有 + 目录不存在 */
      if (!entry && !existsSync(targetChild)) {
        cpSync(seedChild, targetChild, { recursive: true });
        known.set(name, { name, version: readPluginVersion(seedChild) });
        seeded.push(name);
        continue;
      }

      /* ② 跳过：用户自建/改过（台账没有但目录在），或用户删过（台账有但目录不在） */
      if (!entry || !existsSync(targetChild)) { continue; }

      /* ③ 升级判定：只升不降 + 版本都得读得到 + 必须有备份根 */
      const to = readPluginVersion(seedChild);
      const from = readPluginVersion(targetChild);
      if (to === null || from === null) { continue; }
      if (comparePluginVersions(to, from) <= 0) { continue; }
      if (!opts.backupRoot) { continue; }

      const backup = backupDir(targetChild, opts.backupRoot, name, now());
      if (backup === null) { continue; }        // fail-closed：没有回滚点就不动用户目录

      copyTemplateOver(seedChild, targetChild);
      known.set(name, { name, version: to });
      upgraded.push({ name, from, to, backup });
    }
  } catch {
    // 播种/升级失败绝不能拦住启动：已完成的记进台账，剩余的留待下次
  }
  if (seeded.length > 0 || upgraded.length > 0) { writeSeedManifest(targetDir, [...known.values()]); }
  return { seeded, upgraded };
}
