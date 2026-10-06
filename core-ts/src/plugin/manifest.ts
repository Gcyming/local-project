export type PluginOrigin = "builtin" | "user" | "market" | "agent";

export type PluginContribution = "instructions" | "tools" | "prompt";

export const PLUGIN_ORIGINS: readonly PluginOrigin[] = ["builtin", "user", "market", "agent"];

export const PLUGIN_CONTRIBUTIONS: readonly PluginContribution[] = ["instructions", "tools", "prompt"];

export const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  origin: PluginOrigin;
  provides: PluginContribution[];
  requires?: string[];
  entry?: string;
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
  if (typeof input.entry === "string" && input.entry.trim() !== "") {
    manifest.entry = input.entry.trim();
  }
  return { ok: true, manifest };
}