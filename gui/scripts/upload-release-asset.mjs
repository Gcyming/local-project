#!/usr/bin/env node
/**
 * scripts/upload-release-asset.mjs — 把额外产物上传到 GitHub Release
 *
 * 用途：electron-builder 只会发布它自己认识的那几件产物（安装包 / blockmap / latest.yml）。
 * 像 Slime-CUDA-Runtime-<ver>.7z 这种我们额外压出来的增补包，需要单独上传。
 *
 * 用法：
 *   GH_TOKEN=xxx node scripts/upload-release-asset.mjs --tag v0.0.2 --file gui/release-final/Slime-CUDA-Runtime-0.0.2.7z
 *
 * 行为：
 *   - Release 不存在 → 先创建（同名标签）
 *   - 同名 asset 已存在 → 先删除再上传（保证可重复执行）
 *   - 走 uploads.github.com 的流式上传，不把整个文件读进内存
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { statSync, existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// 本脚本住在 gui/scripts/：上两级才是仓库根（electron-builder.json 在 gui/ 下）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const tag = arg("tag");
const file = arg("file");
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

if (!tag || !file) {
  console.error("用法: node scripts/upload-release-asset.mjs --tag <tag> --file <path>");
  process.exit(1);
}
if (!token) {
  console.error("缺少 GH_TOKEN 环境变量");
  process.exit(1);
}
const absFile = resolve(ROOT, file);
if (!existsSync(absFile)) {
  console.error(`文件不存在: ${absFile}`);
  process.exit(1);
}

// owner/repo 取自 electron-builder 的 publish 配置（唯一出处）
const cfg = JSON.parse(readFileSync(join(ROOT, "gui", "electron-builder.json"), "utf8"));
const owner = cfg.publish?.owner;
const repo = cfg.publish?.repo;
if (!owner || !repo) {
  console.error("electron-builder.json 缺少 publish.owner / publish.repo");
  process.exit(1);
}

const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "slime-release-uploader",
};

async function gh(path, init = {}) {
  const res = await fetch(`${apiBase}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} ${res.statusText} @ ${path}\n${body.slice(0, 500)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function main() {
  let release = null;
  try {
    release = await gh(`/releases/tags/${encodeURIComponent(tag)}`);
    console.info(`[upload] 复用已有 release: ${release.html_url}`);
  } catch (err) {
    if (!String(err.message).includes(" 404 ")) throw err;
    release = await gh("/releases", {
      method: "POST",
      body: JSON.stringify({ tag_name: tag, name: `Slime ${tag}`, draft: false, prerelease: false }),
    });
    console.info(`[upload] 已创建 release: ${release.html_url}`);
  }

  const name = basename(absFile);
  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing) {
    console.info(`[upload] 删除同名旧资产 id=${existing.id}`);
    await fetch(`${apiBase}/releases/assets/${existing.id}`, { method: "DELETE", headers });
  }

  const size = statSync(absFile).size;
  const contentType = name.endsWith(".7z")
    ? "application/x-7z-compressed"
    : "application/octet-stream";

  console.info(`[upload] 上传 ${name}（${(size / 1024 / 1024).toFixed(1)} MB）…`);
  const t0 = Date.now();
  const res = await fetch(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": contentType, "Content-Length": String(size) },
      body: Readable.toWeb(createReadStream(absFile)),
      duplex: "half",
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`上传失败 ${res.status} ${res.statusText}\n${body.slice(0, 800)}`);
  }
  const asset = await res.json();
  console.info(`[upload] 完成（${((Date.now() - t0) / 1000).toFixed(0)}s）：${asset.browser_download_url}`);
}

main().catch((err) => {
  console.error("[upload] FAILED:", err.message);
  process.exit(1);
});
