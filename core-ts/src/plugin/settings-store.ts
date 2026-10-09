import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { PluginSettingDecl } from "./contributes.js";
import { validatePluginSettingValue } from "./contributes.js";
import { decrypt, encrypt } from "../encryption.js";
import { isPluginName } from "./manifest.js";

/**
 * A-1197 · B1（L4b 设置贡献点）：插件设置项的**持久化**。
 *
 * ## 落点与安全边界（本文件存在的全部理由）
 * 落点固定 `<数据根>/config/plugins/<插件名>/settings.json`（密文项落 `settings.enc.json`）——
 * **插件自己的目录**，不进 `slime.toml` / `agents.json` / `global_config.json`（主配置零污染）。
 *
 * ⚠️ **路径只由 `plugin.name` 推导，绝不接受调用方传入任意路径。**
 * 这是本层的安全边界：渲染层的 IPC 参数里根本没有 `path` 这个槽位
 * （只传 `{ plugin, key, value }`），所以「渲染层传路径」在结构上就不成立，
 * 而不是「靠校验拦住」。
 * ⇒ `assertSafePluginName` 在**本文件里独立再 assert 一次** `isPluginName`
 * —— 不靠上游 `parsePluginManifest` 已校验过（信任上游 = 上游一改这里就跟着漏）。
 * 伪造 `../..`、绝对路径、盘符一律在这里被拒。
 */

export const PLUGIN_SETTINGS_FILENAME = "settings.json";
export const PLUGIN_SETTINGS_ENC_FILENAME = "settings.enc.json";

/** 设置文件体积上限（与 `config_files.ts` 的 `MAX_SIZE` 同量级，防手滑写入巨大字符串）。 */
export const MAX_PLUGIN_SETTINGS_BYTES = 256 * 1024;

export interface PluginSettingsReadResult {
  /** 明文（非密文）设置项的当前值；文件不存在 / 损坏时为 `{}` */
  values: Record<string, unknown>;
  /** 密文设置项的 key（**只给 key，不给明文** —— 主进程不提供读明文的通道） */
  secretKeys: string[];
  /** 损坏/ 读失败时的告警（会如实上抛到扩展页，不静默当空配置继续跑） */
  warnings: string[];
}

export interface SettingsStoreOptions {
  /** 插件根：`<数据根>/config/plugins`（由主进程传入，调用方固定这一个根） */
  pluginsRoot: string;
  /** 加密原语的注入点（测试与主进程共用同一套 `encryption.ts`，本仓不留第二份加密实现） */
  encrypt?: (value: Record<string, unknown>, path: string) => void;
  decrypt?: (path: string) => Record<string, unknown> | null;
}

/** 插件名必须是合法插件名 —— 独立 assert，**不靠上游校验过**（见文件头注释）。 */
export function assertSafePluginName(name: unknown): string {
  const raw = typeof name === "string" ? name.trim() : "";
  if (!isPluginName(raw)) {
    throw new Error(
      `插件名不合法，拒绝推导设置文件路径（须匹配 ^[a-z0-9]+(?:-[a-z0-9]+)*$）：${JSON.stringify(name)}`,
    );
  }
  /* 双重防线：`isPluginName` 的模式本身已排除分隔符与盘符，但「路径推导」这件事
     值得再assert 一次「结果确实落在插件根之内」—— 两条一起成立才算路径安全。 */
  const normalized = raw.replace(/\//g, "");
  if (normalized !== raw || raw.includes("\\") || raw.includes("..")) {
    throw new Error(`插件名含路径分隔符或 .. ，拒绝推导设置文件路径：${JSON.stringify(name)}`);
  }
  return raw;
}

/** 插件自己的设置文件绝对路径（明文项）。路径**只**由 `pluginsRoot` + `plugin.name` 推导。 */
export function pluginSettingsPath(pluginsRoot: string, pluginName: string): string {
  const safe = assertSafePluginName(pluginName);
  return join(pluginsRoot, safe, PLUGIN_SETTINGS_FILENAME);
}

/** 插件自己的加密设置文件绝对路径（`secret: true` 的项）。 */
export function pluginSettingsEncPath(pluginsRoot: string, pluginName: string): string {
  const safe = assertSafePluginName(pluginName);
  return join(pluginsRoot, safe, PLUGIN_SETTINGS_ENC_FILENAME);
}

function defaultEncrypt(value: Record<string, unknown>, path: string): void {
  encrypt(value, path);
}

function defaultDecrypt(path: string): Record<string, unknown> | null {
  return decrypt(path);
}

function readJsonFile(path: string, warnings: string[], label: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  let text: string;
  try {
    const stat = readFileSync(path, "utf8");
    text = stat;
  } catch (e) {
    warnings.push(`${label}读取失败（已按空设置继续，扩展页会显示此告警）：${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
  if (text.length > MAX_PLUGIN_SETTINGS_BYTES) {
    warnings.push(`${label}体积异常（${text.length} > ${MAX_PLUGIN_SETTINGS_BYTES} 字节），已忽略`);
    return {};
  }
  if (text.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    warnings.push(`${label}不是合法 JSON（已按空设置继续，扩展页会显示此告警）：${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${label}不是 JSON 对象（已按空设置继续，扩展页会显示此告警）`);
    return {};
  }
  return parsed as Record<string, unknown>;
}

/**
 * 设置项的读端。
 *
 * ⚠️ **损坏回退必须带 warning**：设计文档 §4.2 明确「文件损坏 ⇒ 回退 `{}` 并在扩展页显示
 * 『设置文件损坏已忽略』」，本仓判据是「不静默」—— 所以这里**返回 warnings**，
 * 由调用方上抛，绝不静默返回 `{}`。
 */
export class SettingsStore {
  private readonly pluginsRoot: string;
  private readonly enc: (value: Record<string, unknown>, path: string) => void;
  private readonly dec: (path: string) => Record<string, unknown> | null;

  constructor(opts: SettingsStoreOptions) {
    this.pluginsRoot = opts.pluginsRoot;
    this.enc = opts.encrypt ?? defaultEncrypt;
    this.dec = opts.decrypt ?? defaultDecrypt;
  }

  get root(): string {
    return this.pluginsRoot;
  }

  /**
   * 读一个插件的当前设置。
   *
   * @param decls 该插件的声明项（用于按声明过滤：磁盘上多出来的键**不外泄**给渲染层）
   */
  read(pluginName: string, decls: PluginSettingDecl[]): PluginSettingsReadResult {
    const warnings: string[] = [];
    /* 路径推导失败（伪造插件名）**不抛**：读端连 IPC handler 都会经过，
       抛出去会让 handler 变成未处理 rejection 而不是一条可读的错误。
       这里按「空设置 + 如实告警」处理，且告警里带上具体原因。 */
    let plainPath: string;
    let encPath: string;
    try {
      plainPath = pluginSettingsPath(this.pluginsRoot, pluginName);
      encPath = pluginSettingsEncPath(this.pluginsRoot, pluginName);
    } catch (e) {
      warnings.push(`插件名不合法，未读取其设置：${e instanceof Error ? e.message : String(e)}`);
      return { values: {}, secretKeys: [], warnings };
    }
    const raw = readJsonFile(plainPath, warnings, `插件 ${pluginName} 的设置文件`);
    const secretDecls = decls.filter((d) => d.secret === true);
    const plainDecls = decls.filter((d) => d.secret !== true);

    const values: Record<string, unknown> = {};
    for (const decl of plainDecls) {
      if (!Object.prototype.hasOwnProperty.call(raw, decl.key)) {
        continue;
      }
      const candidate = raw[decl.key];
      /* 磁盘上的值必须仍然配得上声明（清单改过type /加过 min-max 后旧值可能不再合法）。
         非法值**丢弃并告警**，不静默把不合法的值回传渲染层。 */
      const valueErrors = validatePluginSettingValue(decl, candidate);
      if (valueErrors.length > 0) {
        warnings.push(`插件 ${pluginName} 的设置项 ${decl.key} 落盘值不再合法，已忽略：${valueErrors.join("；")}`);
        continue;
      }
      values[decl.key] = candidate;
    }

    /*密文项：只取 key（不取明文）。解密失败（passphrase不匹配 / 密文损坏）
       ⇒ 该 key 视作「没有值」+ 告警，而不是回退去读明文文件。 */
    const secretKeys: string[] = [];
    if (secretDecls.length > 0 && existsSync(encPath)) {
        let secretBag: Record<string, unknown> | null = null;
        try {
          secretBag = this.dec(encPath);
        } catch (e) {
          warnings.push(
            `插件 ${pluginName} 的加密设置读取失败（已按「无值」处理）：${e instanceof Error ? e.message : String(e)}`,
          );
        }
        if (secretBag === null) {
          warnings.push(`插件 ${pluginName} 的加密设置无法解密（passphrase 不匹配或密文损坏），secret 项暂按「无值」处理`);
        } else {
          for (const s of secretDecls) {
            if (Object.prototype.hasOwnProperty.call(secretBag, s.key)) {
              secretKeys.push(s.key);
            }
          }
        }
    }

    return { values, secretKeys, warnings };
  }

  /**
   * 写一个插件的单个设置项（整文件覆写 + 原子替换 + `.bak` 备份）。
   *
   * @param decl 该项的声明（写入前**再做一次值校验** —— 渲染层那份校验只为即时反馈，
   *              这里才是不信任的那一份）
   * @returns 本次落盘的最终文件内容（供调用方回显，不必再读一次）
   */
  writeOne(
    pluginName: string,
    decl: PluginSettingDecl,
    value: unknown,
  ): { ok: true; values: Record<string, unknown>; secretKeys: string[] } | { ok: false; error: string } {
    const valueErrors = validatePluginSettingValue(decl, value);
    if (valueErrors.length > 0) {
      return { ok: false, error: valueErrors.join("；") };
    }

    if (decl.secret === true) {
      let encPath: string;
      try {
        encPath = pluginSettingsEncPath(this.pluginsRoot, pluginName);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      const current = readDecryptedForWrite(this.dec, encPath);
      current[decl.key] = value;
      try {
        mkdirSync(dirname(encPath), { recursive: true });
        this.enc(current, encPath);
      } catch (e) {
        return { ok: false, error: `加密设置写入失败：${e instanceof Error ? e.message : String(e)}` };
      }
      /* secret 项**不写进明文文件** —— 落明文就等于没加密。 */
      return { ok: true, values: {}, secretKeys: Object.keys(current) };
    }

    let path: string;
    try {
      path = pluginSettingsPath(this.pluginsRoot, pluginName);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const warnings: string[] = [];
    const current = readJsonFile(path, warnings, `插件 ${pluginName} 的设置文件`);
    current[decl.key] = value;
    try {
      atomicWriteJson(path, current);
    } catch (e) {
      return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, values: current, secretKeys: [] };
  }
}

function readDecryptedForWrite(
  dec: (path: string) => Record<string, unknown> | null,
  encPath: string,
): Record<string, unknown> {
  if (!existsSync(encPath)) {
    return {};
  }
  try {
    const bag = dec(encPath);
    if (bag && typeof bag === "object" && !Array.isArray(bag)) {
      return { ...(bag as Record<string, unknown>) };
    }
  } catch {
    // 解密失败时按空袋子写：宁可丢掉旧的密文，也不要把新值追加到一个读不出来的袋子上
  }
  return {};
}

/**
 * 备份到 `.bak`，**并保证下一次还能覆盖它**。
 *
 * ⚠️ 为什么要多这一层（实测踩到，不是假想）：Windows 上 `copyFileSync` 会把源文件的
 * **只读属性一并复制**到目标。所以一旦 `settings.json` 处于只读（例如用户手工设了只读），
 * 写盘会在 `rename` 上EPERM 失败 —— 而这次失败已经把只读属性带到了 `.bak` 上。
 * 用户随后解除只读、再次保存时，`copyFileSync(settings.json → settings.json.bak)`
 * 会因为 `.bak` 仍是只读而再次 EPERM ⇒ **一次只读事故让该插件的设置永久写不进去**
 * （数据在，但再也存不进新的）。
 * ⇒ 覆盖前先清掉 `.bak` 的只读位（Node 在 Windows 上用只读位映射文件属性）。
 */
function backupToBak(path: string): void {
  const bak = `${path}.bak`;
  try {
    copyFileSync(path, bak);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
      throw e;
    }
    chmodSync(bak, 0o666);
    copyFileSync(path, bak);
  }
}

/**
 * 原子写：先 `.bak` 备份，再写 `.tmp`，最后 `rename` 覆盖（照抄 `config_files.ts` 的既有口径）。
 *
 * ⚠️ **顺序有意义**：`.bak` 必须在 tmp 写入**之前**做，否则备份的是新内容；
 * 而 `rename` 放在最后保证「写到一半崩了」时原文件仍然完好（不会留半个 JSON）。
 */
export function atomicWriteJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    backupToBak(path);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    /* 失败时把 tmp 清掉：留着半截 tmp 会让下一次 `readJsonFile` 的体积上限判断误判 */
    try {
      if (existsSync(tmp)) {
        rmSync(tmp, { force: true });
      }
    } catch {
      // 清不掉也不影响正确性：真正的落点文件没被动过
    }
    throw e;
  }
}

/**
 * 读`.bak` 备份（损坏恢复路径）。
 *
 * 暴露出来是为了让「文件写坏了能恢复」这件事**可测**：本仓不接受「有个 .bak 函数但没人调用过」。
 */
export function readSettingsBackup(pluginsRoot: string, pluginName: string): Record<string, unknown> | null {
  const bak = `${pluginSettingsPath(pluginsRoot, pluginName)}.bak`;
  if (!existsSync(bak)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(bak, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}