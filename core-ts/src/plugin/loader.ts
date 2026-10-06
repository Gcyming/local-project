import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { PluginManifest, PluginOrigin } from "./manifest.js";
import { parsePluginManifest } from "./manifest.js";

export const PLUGIN_MANIFEST_FILENAME = "plugin.json";

export const PLUGIN_SKILLS_SUBDIR = "skills";

export const INVISIBLE_UNICODE_CHARS = ["\u200B", "\u200C", "\u200D", "\uFEFF", "\u2060"] as const;

const INVISIBLE_UNICODE_SET: ReadonlySet<string> = new Set<string>(INVISIBLE_UNICODE_CHARS);

export const INVISIBLE_UNICODE_REJECTION =
  "含不可见 Unicode 字符（投毒风险）：name / description / entry 中不得出现零宽或不可见字符";

export interface LoadedManifest {
  manifest: PluginManifest;
  dir: string;
  warnings: string[];
  /**
   * 该插件目录下 skills 子目录里各技能目录（各含一份 SKILL.md）的目录名（已排序）。
   * 由磁盘结构直接推出，是「插件 ↔ 技能」归属关系的唯一事实来源，
   * 调用方无需自己猜技能从哪来；无 skills 目录时为 undefined（向后兼容的可选字段）。
   */
  skillNames?: string[];
}

export interface RejectedPluginDir {
  dir: string;
  errors: string[];
}

export interface LoadFromDiskResult {
  manifests: LoadedManifest[];
  rejected: RejectedPluginDir[];
  warnings: string[];
}

export interface LoadPluginsFromDiskOptions {
  origins?: PluginOrigin[];
}

export function findInvisibleUnicode(text: string): string[] {
  const hits: string[] = [];
  for (const ch of text) {
    if (INVISIBLE_UNICODE_SET.has(ch) && !hits.includes(ch)) {
      hits.push(ch);
    }
  }
  return hits;
}

function describeCodePoints(chars: string[]): string {
  return chars.map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`).join("、");
}

async function readDirEntries(root: string): Promise<{ dirs: string[]; warnings: string[] }> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs: string[] = [];
    const warnings: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(entry.name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        warnings.push(`跳过符号链接（非目录）：${join(root, entry.name)}`);
      }
    }
    dirs.sort();
    return { dirs, warnings };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return { dirs: [], warnings: [] };
    }
    return { dirs: [], warnings: [`插件根目录不可读（${code ?? "未知错误"}）：${root}`] };
  }
}

/**
 * 插件自带技能的扫描根：<dir>/skills。
 * 技能归属判定一律基于这个根与 Skill.path 的前缀关系，调用方不需要（也不应该）
 * 自己把插件名写进技能里。
 */
export function pluginSkillsRoot(dir: string): string {
  return join(dir, PLUGIN_SKILLS_SUBDIR);
}

/**
 * 列出插件 skills 子目录下每个技能目录（各含一份 SKILL.md）里的技能目录名。
 * 只认 SKILL.md 存在的目录（与 SkillRegistry 的载入口径一致），
 * 目录不存在时返回 undefined —— 表示「这个插件没有自带技能」，而不是「空列表」。
 */
export async function readPluginSkillNames(dir: string): Promise<string[] | undefined> {
  const root = pluginSkillsRoot(dir);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    return [];
  }
  const names: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory() || entry.name.startsWith("__")) {
      continue;
    }
    try {
      await stat(join(root, entry.name, "SKILL.md"));
    } catch {
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

/**
 * 磁盘装载：扫描 <root>/<name>/plugin.json，逐个 parsePluginManifest 校验。
 * fail-closed：任一校验不过的目录进 rejected，不影响其余目录装载。
 */
export async function loadPluginsFromDisk(
  root: string,
  opts?: LoadPluginsFromDiskOptions,
): Promise<LoadFromDiskResult> {
  const result: LoadFromDiskResult = { manifests: [], rejected: [], warnings: [] };
  const rootAbs = isAbsolute(root) ? root : resolve(root);
  const allowedOrigins = opts?.origins && opts.origins.length > 0 ? new Set(opts.origins) : null;

  const { dirs, warnings } = await readDirEntries(rootAbs);
  result.warnings.push(...warnings);

  for (const dirName of dirs) {
    const dir = join(rootAbs, dirName);
    const manifestPath = join(dir, PLUGIN_MANIFEST_FILENAME);

    let text: string;
    try {
      text = await readFile(manifestPath, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        result.warnings.push(`跳过无 ${PLUGIN_MANIFEST_FILENAME} 的目录（非插件）：${dir}`);
        continue;
      }
      result.rejected.push({ dir, errors: [`${PLUGIN_MANIFEST_FILENAME} 读取失败（${code ?? "未知错误"}）`] });
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      result.rejected.push({
        dir,
        errors: [`${PLUGIN_MANIFEST_FILENAME} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`],
      });
      continue;
    }

    const parsed = parsePluginManifest(raw);
    if (!parsed.ok) {
      result.rejected.push({ dir, errors: parsed.errors });
      continue;
    }
    const manifest = parsed.manifest;

    if (manifest.name !== dirName) {
      result.rejected.push({
        dir,
        errors: [`name（${manifest.name}）必须与目录名（${dirName}）一致`],
      });
      continue;
    }

    const invisibleTargets: string[] = [];
    for (const field of ["name", "description", "entry"] as const) {
      const value = manifest[field];
      if (typeof value !== "string") {
        continue;
      }
      const hits = findInvisibleUnicode(value);
      if (hits.length > 0) {
        invisibleTargets.push(`${field}（${describeCodePoints(hits)}）`);
      }
    }
    if (invisibleTargets.length > 0) {
      result.rejected.push({
        dir,
        errors: [INVISIBLE_UNICODE_REJECTION, `命中字段：${invisibleTargets.join("、")}`],
      });
      continue;
    }

    if (manifest.origin === "builtin") {
      result.rejected.push({
        dir,
        errors: ["origin 为 builtin 的磁盘清单一律拒绝：builtin 是系统保留值，只能来自代码内置"],
      });
      continue;
    }

    if (allowedOrigins && !allowedOrigins.has(manifest.origin)) {
      result.warnings.push(`按来源过滤跳过（origin=${manifest.origin}）：${dir}`);
      continue;
    }

    const entryWarnings: string[] = [];
    if (manifest.entry !== undefined) {
      try {
        const entryStat = await stat(join(dir, manifest.entry));
        if (!entryStat.isFile()) {
          entryWarnings.push(`entry 指向的不是文件：${manifest.entry}`);
        }
      } catch {
        entryWarnings.push(`entry 指向的文件不存在：${manifest.entry}`);
      }
    }

    result.manifests.push({ manifest, dir, warnings: entryWarnings, skillNames: await readPluginSkillNames(dir) });
  }

  return result;
}