import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A-1197 · B4（T1 脚本信任）：单插件「信任其脚本」状态的持久化。
 *
 * ## 为什么是 fail-closed（默认**拒绝**，与本文件之外的 disabled-store 方向相反）
 * 信任 = 「允许本插件的 `tools/*.mjs` 被主进程 `spawn` 执行」。这是本平台**唯一**
 * 能跑扩展代码的形态（设计 §5.1），也是**权限最高**的一档 —— 所以：
 *   · 文件缺失 / JSON 坏 / 字段非法 / 读失败 ⇒ **一律不信任**（不因存储损坏而放行）；
 *   · 写失败 ⇒ 如实抛（调用方必须上报），不静默留旧值 —— 用户以为关掉了其实开着
 *     是这类开关最危险的失效形态。
 *
 * ## 落点与边界（设计 §4.4 的 T1）
 * - 文件固定为 `<插件目录>/trust.json`，**不进主配置**（`slime.toml` 等）；
 * - 只存一个布尔字段 `trusted`；刻意**不含**「信任有效期/时间戳」等花活 ——
 *   开关的语义只有「此刻是否允许」，多一个字段就多一种"用户以为它会过期"的误读。
 */

export const PLUGIN_TRUST_FILE = "trust.json";

/** 读单插件信任状态；任何异常 ⇒ false（fail-closed）。 */
export function readPluginTrust(pluginDir: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(pluginDir, PLUGIN_TRUST_FILE), "utf8")) as { trusted?: unknown };
    return raw?.trusted === true;
  } catch {
    return false;
  }
}

/** 写单插件信任状态（全量重写，文件极小）。写失败**如实抛**（调用方必须上报）。 */
export function writePluginTrust(pluginDir: string, trusted: boolean): void {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, PLUGIN_TRUST_FILE),
    `${JSON.stringify({ trusted: trusted === true }, null, 2)}\n`,
    "utf8",
  );
}
