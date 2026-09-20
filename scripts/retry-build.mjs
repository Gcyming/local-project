#!/usr/bin/env node
/**
 * scripts/retry-build.mjs — 带重试机制的打包脚本
 *
 * 解决 Windows Defender 实时保护导致的 EBUSY 错误
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const guiDir = resolve(__dirname, "..", "gui");
const pkg = JSON.parse(readFileSync(resolve(guiDir, "package.json"), "utf8"));
const version = pkg.version || "0.0.1";
// electron-builder 实际输出目录取自 electron-builder.json（不写死 "release"）
const builderCfg = JSON.parse(readFileSync(resolve(guiDir, "electron-builder.json"), "utf8"));
const releaseDir = resolve(guiDir, (process.env.SLIME_OUT_DIR || "").trim() || builderCfg.directories?.output || "release");

const args = process.argv.slice(2);
const publishFlag = args.includes("--publish always") ? "--publish always" : "--publish never";
// SLIME_OUT_DIR：一次性覆盖输出目录。
// 用途：electron-builder 每次打包都会 emptyDir(appOutDir)，若上一次的产物被 Defender /
// 索引器之类瞬时锁住，unlink app.asar 会 EBUSY 且重试也解不开。换一个全新的输出目录
// 就没有东西需要删 —— 不必改动 electron-builder.json 里的常驻配置。
const outOverride = (process.env.SLIME_OUT_DIR || "").trim();
const outArgs = outOverride ? [`-c.directories.output=${outOverride}`] : [];
const maxRetries = 5;
const delayMs = 3000;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runBuilder(extraArgs = []) {
  return new Promise((resolve, reject) => {
    const builder = spawn("npx.cmd", ["electron-builder", "--win", publishFlag, ...outArgs, ...extraArgs], {
      stdio: "pipe",
      cwd: guiDir,
      shell: true,
    });

    let output = "";
    builder.stderr.on("data", (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    builder.stdout.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });

    builder.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`exit ${code}: ${output.trim()}`));
      }
    });
    builder.on("error", (err) => reject(err));
  });
}

async function main() {
  // 尝试多次构建
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.info(`[retry-build] attempt ${attempt}/${maxRetries}`);

    try {
      const output = await runBuilder();
      console.info("[retry-build] SUCCESS");

      // 检查是否生成了 portable exe（版本号从 package.json 动态读取）
      const portableExe = resolve(releaseDir, `Slime Setup ${version}.exe`);
      const singleExe = resolve(releaseDir, `Slime ${version}.exe`);

      if (existsSync(portableExe)) {
        console.info(`[retry-build] Generated: Slime Setup ${version}.exe`);
      } else if (existsSync(singleExe)) {
        console.info(`[retry-build] Generated: Slime ${version}.exe`);
      } else {
        console.info(`[retry-build] Output directory contents:`);
        if (existsSync(releaseDir)) {
          for (const f of readdirSync(releaseDir)) {
            console.info(`  - ${f}`);
          }
        }
      }

      return;
    } catch (err) {
      const msg = err.message || "";
      const isEBUSY = msg.includes("EBUSY") || msg.includes("busy or locked");
      console.info(`[retry-build] error: ${msg.slice(0, 300)}`);

      if (isEBUSY && attempt < maxRetries) {
        const waitTime = delayMs * attempt * 2; // 增加等待时间
        console.warn(`[retry-build] EBUSY detected, retrying in ${waitTime}ms...`);
        await sleep(waitTime);
      } else {
        console.error("[retry-build] FAILED:", msg);
        process.exit(1);
      }
    }
  }
}

main();
