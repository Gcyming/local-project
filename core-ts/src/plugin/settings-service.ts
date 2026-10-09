import type { PluginSettingDecl } from "./contributes.js";
import { describePluginSettings } from "./contributes.js";
import { SettingsStore } from "./settings-store.js";
import type { SettingsStoreOptions } from "./settings-store.js";

/**
 * A-1197 · B1（L4b 设置贡献点）：设置项的**服务层**（声明 + 读 + 写 + DTO 整形）。
 *
 * ## 这一层存在的两条理由
 * ① **写盘前置检查**：插件未装载 / 已禁用 / 装载失败 ⇒ 一律拒写。
 *    判据来自 `isLoaded` 回调（主进程把它接到 `host.get(name)?.status === "loaded"`），
 *    所以「关掉的插件不能被偷偷改设置」是**结构上**成立的，而不是靠渲染层不调用。
 * ② **DTO 整形**：明文一律不出主进程边界 —— `secret: true` 的项读回来只有 `hasValue: true`，
 *    **不提供任何读明文的IPC**（想看只能自己去读自己插件目录里那个文件 ——
 *    那是同一个用户的文件，威胁模型成立）。
 */

export interface PluginSettingsDTOItem {
  key: string;
  label: string;
  type: string;
  hint?: string;
  options?: string[];
  min?: number;
  max?: number;
  root?: string;
  secret: boolean;
  default?: unknown;
  /** 非密文项：当前值（未设置时为undefined，渲染层回退到 `default` / 类型零值） */
  value?: unknown;
  /** 密文项：当前是否已有值（**永不携带明文**） */
  hasValue?: boolean;
}

export interface PluginSettingsDTO {
  plugin: string;
  items: PluginSettingsDTOItem[];
  warnings: string[];
}

export interface PluginSettingsWriteResult {
  ok: boolean;
  error?: string;
  dto?: PluginSettingsDTO;
  warnings?: string[];
}

/** 主进程注入的「这个插件现在是不是可用」判据。 */
export type PluginLoadedProbe = (pluginName: string) => boolean;

export interface SettingsServiceOptions extends SettingsStoreOptions {
  /** 取该插件的声明项（主进程接`host.get(name)?.manifest.contributes?.settings`）。 */
  declarations: (pluginName: string) => PluginSettingDecl[] | undefined;
  /** 取该插件的贡献摘要（用于校验「声明还在」，插件被禁用后不再回传设置项）。 */
  isLoaded: PluginLoadedProbe;
}

/** 设置项数与声明摘要（渲染层用它判断「这个插件还宣称有设置项吗」）。 */
export function settingsDeclarationSummary(decls: PluginSettingDecl[] | undefined): string | undefined {
  if (decls === undefined) {
    return undefined;
  }
  return describePluginSettings(decls);
}

export class SettingsService {
  private readonly store: SettingsStore;
  private readonly declarations: (pluginName: string) => PluginSettingDecl[] | undefined;
  private readonly isLoaded: PluginLoadedProbe;

  constructor(opts: SettingsServiceOptions) {
    this.store = new SettingsStore(opts);
    this.declarations = opts.declarations;
    this.isLoaded = opts.isLoaded;
  }

  get pluginsRoot(): string {
    return this.store.root;
  }

  /**
   * 读一个插件的设置快照。
   *
   * 未装载/ 已禁用 / 装载失败 ⇒ 返回错误（**不给未装载插件读设置的机会**，
   * 界面上的设置区会随插件一起被摘掉）。
   */
  get(pluginName: string): { ok: true; dto: PluginSettingsDTO } | { ok: false; error: string } {
    if (!this.isLoaded(pluginName)) {
      return { ok: false, error: `插件未装载或已停用：${pluginName}` };
    }
    const decls = this.declarations(pluginName);
    if (decls === undefined || decls.length === 0) {
      return { ok: false, error: `插件未声明设置项：${pluginName}` };
    }
    const read = this.store.read(pluginName, decls);
    return { ok: true, dto: shape(pluginName, decls, read.values, read.secretKeys, read.warnings) };
  }

  /**
   * 写一个插件的单个设置项。
   *
   * 入参只有 `{ plugin, key, value }` —— **没有 `path`**（安全边界，见 settings-store 文件头）。
   */
  set(
    pluginName: string,
    key: string,
    value: unknown,
  ): PluginSettingsWriteResult {
    if (!this.isLoaded(pluginName)) {
      return { ok: false, error: `插件未装载或已停用：${pluginName}` };
    }
    const decls = this.declarations(pluginName) ?? [];
    const decl = decls.find((d) => d.key === key);
    if (!decl) {
      return { ok: false, error: `插件 ${pluginName} 未声明设置项 ${key}` };
    }
    const written = this.store.writeOne(pluginName, decl, value);
    if (!written.ok) {
      return { ok: false, error: written.error };
    }
    const read = this.store.read(pluginName, decls);
    return {
      ok: true,
      dto: shape(pluginName, decls, read.values, read.secretKeys, read.warnings),
      warnings: read.warnings,
    };
  }
}

/**
 * DTO 整形 —— **唯一**把「落盘内容」变成「回传渲染层内容」的地方。
 *
 * ⚠️ 这一层是「secret 不落明文 / 读回只给 hasValue」这条安全边界的**唯一实现点**：
 * 它对 `secret === true` 的项既不读明文（store.read 只给 key）、也不填 `value`。
 */
function shape(
  pluginName: string,
  decls: PluginSettingDecl[],
  values: Record<string, unknown>,
  secretKeys: string[],
  warnings: string[],
): PluginSettingsDTO {
  const secretSet = new Set(secretKeys);
  const items: PluginSettingsDTOItem[] = decls.map((decl) => {
    const item: PluginSettingsDTOItem = {
      key: decl.key,
      label: decl.label,
      type: decl.type,
      secret: decl.secret === true,
    };
    if (decl.hint !== undefined) item.hint = decl.hint;
    if (decl.options !== undefined) item.options = [...decl.options];
    if (decl.min !== undefined) item.min = decl.min;
    if (decl.max !== undefined) item.max = decl.max;
    if (decl.root !== undefined) item.root = decl.root;
    if (decl.default !== undefined) item.default = decl.default;
    if (decl.secret === true) {
      item.hasValue = secretSet.has(decl.key);
    } else {
      if (Object.prototype.hasOwnProperty.call(values, decl.key)) {
        item.value = values[decl.key];
      }
    }
    return item;
  });
  return { plugin: pluginName, items, warnings: [...warnings] };
}