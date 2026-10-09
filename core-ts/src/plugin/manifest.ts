import type { PluginContributes } from "./contributes.js";
import { parsePluginContributes, PLUGIN_NAME_PATTERN } from "./contributes.js";
import type { PluginModeDecl } from "./mode.js";
import { parseModeDecl } from "./mode.js";

export type PluginOrigin = "builtin" | "user" | "market" | "agent";

export type PluginContribution = "instructions" | "tools" | "prompt" | "mode";

export const PLUGIN_ORIGINS: readonly PluginOrigin[] = ["builtin", "user", "market", "agent"];

export const PLUGIN_CONTRIBUTIONS: readonly PluginContribution[] = ["instructions", "tools", "prompt", "mode"];

/* A-1197 · B2：`PLUGIN_NAME_PATTERN` 的定义已迁到 `contributes.ts`（名字校验单一产地），
   这里原地 re-export 保持对外 API 不变。 */
export { PLUGIN_NAME_PATTERN };

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  origin: PluginOrigin;
  provides: PluginContribution[];
  requires?: string[];
  entry?: string;
  /**
   * A-1197 · B1（L4b 设置贡献点）：**进界面的东西**，与 `provides`（进上下文的东西）不混用。
   * 任一声明项非法 ⇒ 整份清单 rejected（见 `parsePluginContributes`，fail-closed）。
   * 刻意**不做**未知顶层字段检查之外的向前兼容：`contributes` 是本批新立的契约面，
   * 字段名拼错必须响（`parsePluginContributes` 里拒），而清单顶层的历史字段仍按老口径放行。
   */
  contributes?: PluginContributes;
  /** A-1197 · B3（L4c）：`provides: ["mode"]` 时的**纯用户定义运行模式**声明（阶段机）。 */
  mode?: PluginModeDecl;
}

export type ParsePluginManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

export function isPluginOrigin(value: unknown): value is PluginOrigin {
  return typeof value === "string" && (PLUGIN_ORIGINS as readonly string[]).includes(value);
}

export function isPluginContribution(value: unknown): value is PluginContribution {
  return typeof value === "string" && (PLUGIN_CONTRIBUTIONS as readonly string[]).includes(value);
}

export function isPluginName(value: unknown): boolean {
  return typeof value === "string" && PLUGIN_NAME_PATTERN.test(value);
}

export function parsePluginManifest(raw: unknown): ParsePluginManifestResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["清单必须是对象"] };
  }
  const input = raw as Record<string, unknown>;

  if (!isPluginName(input.name)) {
    errors.push(`name 缺失或不合法（须匹配 ${PLUGIN_NAME_PATTERN.source}）`);
  }

  const version = input.version;
  if (typeof version !== "string" || version.trim() === "") {
    errors.push("version 缺失或为空");
  }

  const description = input.description;
  if (typeof description !== "string" || description.trim() === "") {
    errors.push("description 缺失或为空（须说明何时用）");
  }

  if (!isPluginOrigin(input.origin)) {
    errors.push(`origin 缺失或不合法（须为 ${PLUGIN_ORIGINS.join(" / ")}）`);
  }

  const providesRaw = input.provides;
  const provides: PluginContribution[] = [];
  if (!Array.isArray(providesRaw) || providesRaw.length === 0) {
    errors.push("provides 缺失或为空");
  } else {
    for (const item of providesRaw) {
      if (!isPluginContribution(item)) {
        errors.push(`provides 含未知贡献类型：${JSON.stringify(item)}`);
        continue;
      }
      if (!provides.includes(item)) {
        provides.push(item);
      }
    }
  }

  const name = isPluginName(input.name) ? input.name : null;
  let requires: string[] | undefined;
  const requiresRaw = input.requires;
  if (requiresRaw !== undefined) {
    if (!Array.isArray(requiresRaw)) {
      errors.push("requires 必须是数组");
    } else {
      const collected: string[] = [];
      for (const item of requiresRaw) {
        if (!isPluginName(item)) {
          errors.push(`requires 含非法插件名：${JSON.stringify(item)}`);
          continue;
        }
        if (item === name) {
          errors.push(`requires 含自身：${item}`);
          continue;
        }
        if (!collected.includes(item)) {
          collected.push(item);
        }
      }
      if (collected.length > 0) {
        requires = collected;
      }
    }
  }

  const contributesRaw = input.contributes;
  let contributes: PluginContributes | undefined;
  if (contributesRaw !== undefined) {
    const parsedContributes = parsePluginContributes(contributesRaw);
    if (!parsedContributes.ok) {
      errors.push(...parsedContributes.errors);
    } else if (parsedContributes.contributes.settings !== undefined || parsedContributes.contributes.ui !== undefined || parsedContributes.contributes.scripts !== undefined || parsedContributes.contributes.page !== undefined || parsedContributes.contributes.theme !== undefined) {
      contributes = parsedContributes.contributes;
    }
  }

  /* A-1197 · B3（L4c 阶段机）：`provides: ["mode"]` ⇔ `mode` 字段，两者必须**自洽**
     （声明了能力就必须给定义；给了定义就必须声明能力）。fail-closed：不自洽即整份拒。
     ⚠️ 工具**存在性**校验不在此层（纯层没有工具表）——装配侧装载时查一次 + 运行前每阶段重查，
     见 mode.ts 文件头「两层」说明。 */
  let mode: PluginModeDecl | undefined;
  const providesHasMode = provides.includes("mode");
  const modeRaw = (input as { mode?: unknown }).mode;
  if (providesHasMode || modeRaw !== undefined) {
    if (!providesHasMode) {
      errors.push("声明了 mode 字段但 provides 未含 \"mode\"（契约面必须自洽）");
    } else if (modeRaw === undefined) {
      errors.push("provides 含 \"mode\" 但缺少 mode 字段（声明了能力就必须给定义）");
    } else {
      const parsedMode = parseModeDecl(modeRaw, "mode", typeof input.origin === "string" ? input.origin : undefined);
      if (!parsedMode.ok) { errors.push(...parsedMode.errors); } else { mode = parsedMode.mode; }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const manifest: PluginManifest = {
    name: name as string,
    version: (version as string).trim(),
    description: (description as string).trim(),
    origin: input.origin as PluginOrigin,
    provides,
  };
  if (requires) {
    manifest.requires = requires;
  }
  if (contributes) {
    manifest.contributes = contributes;
  }
  if (mode) {
    manifest.mode = mode;
  }
  if (typeof input.entry === "string" && input.entry.trim() !== "") {
    manifest.entry = input.entry.trim();
  }
  return { ok: true, manifest };
}