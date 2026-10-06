import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A-1196（需求：扩展页拨片开关）：插件**禁用名单**的持久化。
 *
 * 为什么必须有（否则就是假开关）：`PluginHost.unload` 只是"当前会话内撤贡献" ——
 * 下一次全量重扫（扩展页「重新装载」/ 重启）会把磁盘上还在的插件**装回来**。
 * 用户在扩展页用开关关掉的插件，必须在**跨重扫、跨重启**后保持关闭。
 *
 * 语义边界：
 *   · 名单只存**插件名**；只对 `unloadable`（非 builtin）插件有意义 ——
 *     builtin 的名字即使被手写进名单也不会生效（装载侧对 builtin 永不走卸载路径）。
 *   · 读失败（文件缺失/坏 JSON）⇒ **空名单**（fail-safe 方向：不因名单损坏而禁掉任何东西）。
 *   · 写为全量重写（名单极小，无需增量）；调用方保证路径固定。
 */

export function readDisabledPlugins(filePath: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as { disabled?: unknown };
    const list = Array.isArray(raw?.disabled) ? raw.disabled : [];
    return new Set(list.map((n) => String(n ?? "").trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function writeDisabledPlugins(filePath: string, names: Iterable<string>): void {
  const list = [...new Set([...names].map((n) => String(n ?? "").trim()).filter(Boolean))].sort();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ disabled: list }, null, 2)}\n`, "utf8");
}

export function markPluginDisabled(filePath: string, name: string): Set<string> {
  const set = readDisabledPlugins(filePath);
  const n = String(name ?? "").trim();
  if (n) {
    set.add(n);
    writeDisabledPlugins(filePath, set);
  }
  return set;
}

export function unmarkPluginDisabled(filePath: string, name: string): Set<string> {
  const set = readDisabledPlugins(filePath);
  const n = String(name ?? "").trim();
  if (n && set.delete(n)) {
    writeDisabledPlugins(filePath, set);
  }
  return set;
}
