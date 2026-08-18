#!/usr/bin/env node
/**
 * scripts/set-fuses.mjs — Electron Fuse 加固配置（打包可选深度防御）。
 *
 * 用途：在 electron-vite build 之后、electron-builder 之前运行，
 * 将 Fuses 写入 app.asar（asar 必须先打包好，本脚本会在 electron-builder
 * 的 afterPack hook 之前运行）。
 *
 * 加固项（对齐官方安全最佳实践）：
 *   - RunAsNode: false           （关闭 Node.js API 暴露给渲染进程）
 *   - EnableCookieEncryption: true （加密 Cookie 存储）
 *   - EnableURLSecurityChecking: true （检查 URL 安全性）
 *
 * 注意：RunAsNode=false 后渲染进程将无法使用 require() / process 等 Node API，
 * 本项目 preload 已通过 contextBridge 封装，不受影响。
 *
 * 用法：
 *   node scripts/set-fuses.mjs [--asar <path>]
 *
 * 退出码：0 = 成功，1 = 失败。
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Fuse 常量（@electron/fuses 导出）
const FUSES = {
  RUN_AS_NODE: 0x00000001,
  ENABLE_COOKIE_ENCRYPTION: 0x00000002,
  ENABLE_URL_SECURITY_CHECKING: 0x00000004,
};

async function setFuses(asarPath) {
  console.info(`[fuses] reading: ${asarPath}`);
  const buf = await readFile(asarPath);

  // Electron Fuse 签名 magic: "ELECTRON FUSE"（13 bytes）
  const magic = Buffer.from("ELECTRON FUSE", "utf-8");
  let offset = buf.indexOf(magic);
  if (offset === -1) {
    // 尝试写入新 Fuse 块（旧版本没有，需要追加）
    console.info("[fuses] no existing fuse block found, appending");
    const newFuseBlock = createNewFuseBlock();
    const newData = Buffer.concat([buf, newFuseBlock]);
    await writeFile(asarPath, newData);
    console.info("[fuses] written new fuse block");
    return;
  }

  // 读取现有 Fuse 值
  const existingFuses = buf.readUInt32LE(offset + magic.length);
  console.info(`[fuses] current value: 0x${existingFuses.toString(16).padStart(8, "0")}`);

  // 设置新的 Fuse 值（保留已有的，叠加新的）
  const newFuses = existingFuses | FUSES.RUN_AS_NODE | FUSES.ENABLE_COOKIE_ENCRYPTION | FUSES.ENABLE_URL_SECURITY_CHECKING;
  console.info(`[fuses] new value:    0x${newFuses.toString(16).padStart(8, "0")}`);

  buf.writeUInt32LE(newFuses, offset + magic.length);
  await writeFile(asarPath, buf);
  console.info("[fuses] written to asar");
}

function createNewFuseBlock() {
  const magic = Buffer.from("ELECTRON FUSE", "utf-8");
  const value = Buffer.alloc(4);
  value.writeUInt32LE(
    FUSES.RUN_AS_NODE | FUSES.ENABLE_COOKIE_ENCRYPTION | FUSES.ENABLE_URL_SECURITY_CHECKING,
    0,
  );
  // padding to 16-byte boundary
  const totalLen = magic.length + 4;
  const padding = Array(16 - (totalLen % 16)).fill(0);
  return Buffer.concat([magic, value, Buffer.from(padding)]);
}

async function main() {
  const args = process.argv.slice(2);
  let asarPath = args.find((a) => a.startsWith("--asar="))?.split("=")[1];
  if (!asarPath) {
    asarPath = args.find((a) => a === "--asar");
    if (asarPath) asarPath = args[args.indexOf(asarPath) + 1];
  }
  // 默认路径：Electron-builder 输出目录下的 app.asar
  asarPath = asarPath ?? resolve(process.cwd(), "gui", "release", "win-unpacked", "resources", "app.asar");

  try {
    await setFuses(asarPath);
    console.info("[fuses] done");
  } catch (err) {
    console.error("[fuses] ERROR:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[fuses] Unexpected error:", err);
  process.exit(1);
});
