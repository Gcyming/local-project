/**
 * core-ts/src/paths.ts — 统一项目根解析（GUI 打包支持）。
 *
 * 优先级：SLIME_ROOT 环境变量 > 源码相对推导（开发/CLI，与历史行为完全一致）。
 * GUI 打包后（app.isPackaged）由 gui/src/main/boot.ts 在任何 core-ts 模块加载前
 * 设置 SLIME_ROOT=用户数据目录，使 config/、Knowledge/、data/ 全部落在可写位置。
 *
 * 注意：PROJECT_ROOT 为模块级常量，env 必须在首次 import core-ts 任意模块前设置。
 */

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

function resolveProjectRoot(): string {
  const env = process.env.SLIME_ROOT;
  if (env && env.trim()) {
    return resolve(env);
  }
  return resolveProjectRootFrom(new URL("../../", import.meta.url).toString());
}

/**
 * 从 bundle 入口 URL 推导项目根：上溯查找 slime.toml（项目根标志）。
 * electron-vite 会把 core-ts 打包进 gui/out/main，../../ 只到 gui/out；
 * 上溯保证 Electron dev 模式数据根=项目根。找不到标志（打包后用户数据
 * 目录，boot.ts 的 SLIME_ROOT 已优先）则回退推导值。
 */
export function resolveProjectRootFrom(entryUrl: string): string {
  const derived = fileURLToPath(entryUrl);
  let dir = resolve(derived);
  for (;;) {
    if (existsSync(join(dir, "slime.toml"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) { break; }
    dir = parent;
  }
  return derived;
}

/** 项目根（config/、Knowledge/、data/ 所在目录） */
export const PROJECT_ROOT = resolveProjectRoot();
