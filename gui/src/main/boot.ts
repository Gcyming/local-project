/**
 * gui/src/main/boot.ts — 数据根引导（必须最先被 index.ts import）。
 *
 * 打包后（app.isPackaged）源码树在 asar 内只读，config/、Knowledge/、data/
 * 必须落到用户可写目录。此处设置 SLIME_ROOT，core-ts/src/paths.ts 在模块
 * 加载时读取该值推导 PROJECT_ROOT —— 因此本模块必须先于任何 core-ts 模块
 * 完成执行（ESM import 顺序保证：index.ts 第一行 import "./boot.js"）。
 *
 * 开发模式（未打包）不设置 env，core-ts 回退源码相对推导，行为与 legacy 一致。
 */
import { app } from "electron";
import { join } from "node:path";

if (app.isPackaged) {
  process.env.SLIME_ROOT = join(app.getPath("userData"), "slime-data");
  console.info(`[gui:boot] 打包模式：数据根 = ${process.env.SLIME_ROOT}`);
}
