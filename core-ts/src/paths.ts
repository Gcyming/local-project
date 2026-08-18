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
import { resolve } from "node:path";

function resolveProjectRoot(): string {
  const env = process.env.SLIME_ROOT;
  if (env && env.trim()) {
    return resolve(env);
  }
  return fileURLToPath(new URL("../../", import.meta.url));
}

/** 项目根（config/、Knowledge/、data/ 所在目录） */
export const PROJECT_ROOT = resolveProjectRoot();
