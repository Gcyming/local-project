/**
 * core-ts/src/tools/builtin.ts — 内置工具（Node 语义）。
 * 语义移植自 tools/builtin.py：
 * - file_read / file_list（只读，相对路径锚定项目根，拒绝符号链接，敏感文件屏蔽，256KB 上限）
 * - file_write（受控写入：项目根内、敏感黑名单、5MB 上限、原子写入）
 * - code_check（Python → py_compile 语义，Node 直接 node --check；JS/TS 同）
 * - web_fetch / web_search（network；Node 侧用内置 fetch 直连）
 */

import { readdir, readFile, stat, writeFile, rename, mkdir, realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Tool, getRegistry } from "./registry.js";

const execFileP = promisify(execFile);

/** 相对路径锚定项目根（core-ts/src/tools/ 与 dist/tools/ 上溯三层均指向项目根） */
export const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const MAX_READ_BYTES = 262_144;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const SENSITIVE_NAMES = new Set([".slime_pass", "providers.enc.json", "auth_token.enc", "auth_token.json"]);
const WRITE_BLOCKED_NAMES = new Set([
  ".slime_pass", "providers.enc.json", "auth_token.enc", "auth_token.json",
  "slime.toml", "slime_server.py", "slime_cli.py", "slime_launcher.py",
  "agents.json", "global_config.json", "history.jsonl", "audit.jsonl",
  "requirements.txt", "qa.py", "run_tests.py", "pytest.ini",
]);
const WRITE_BLOCKED_DIRS = new Set(["config", "core", "tools", "social", "tests"]);
const WRITE_BLOCKED_SUFFIXES = new Set([".enc", ".toml"]);

function projectRootPath(p: string): string {
  return isAbsolute(p) ? p : join(PROJECT_ROOT, p);
}

function isInsideProject(p: string): boolean {
  const root = resolve(PROJECT_ROOT);
  const abs = resolve(p);
  return abs === root || abs.startsWith(root + sep);
}

/** 解析路径：字符串规范化 + 项目根校验（不要求存在）；已存在时 realpath 防 symlink 逃逸 */
async function resolveInProject(p: string): Promise<string> {
  const abs = resolve(projectRootPath(p));
  if (!isInsideProject(abs)) {
    throw new RangeError("路径超出项目范围");
  }
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      throw new Error("禁止跟随符号链接");
    }
    const real = await realpath(abs);
    if (!isInsideProject(real)) {
      throw new RangeError("路径超出项目范围");
    }
    return real;
  } catch (e) {
    if (e instanceof RangeError || e instanceof Error && e.message === "禁止跟随符号链接") {
      throw e;
    }
    return abs; // 不存在：由调用方做存在性检查
  }
}

function isBlockedWritePath(p: string): boolean {
  const name = basename(p).toLowerCase();
  const ext = extname(p).toLowerCase();
  if (WRITE_BLOCKED_NAMES.has(name) || WRITE_BLOCKED_SUFFIXES.has(ext)) {
    return true;
  }
  const rel = p.startsWith(PROJECT_ROOT) ? p.slice(PROJECT_ROOT.length) : p;
  const first = rel.split(/[\\/]/).find((s) => s.length > 0);
  return first !== undefined && WRITE_BLOCKED_DIRS.has(first.toLowerCase());
}

async function fileRead(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "");
  if (!path) {
    return "[错误] 缺少 path 参数";
  }
  try {
    const p = await resolveInProject(path);
    const name = basename(p);
    if (SENSITIVE_NAMES.has(name) || extname(p).toLowerCase() === ".enc") {
      return `[错误] 敏感文件禁止读取: ${path}`;
    }
    let fsize = 0;
    try {
      fsize = (await stat(p)).size;
    } catch {
      return `[错误] 文件不存在: ${path}`;
    }
    if (fsize > MAX_READ_BYTES * 10) {
      return `[错误] 文件过大（${(fsize / 1024 / 1024).toFixed(1)}MB），拒绝读取`;
    }
    let content = await readFile(p, "utf-8");
    if (content.length > MAX_READ_BYTES) {
      content = content.slice(0, MAX_READ_BYTES) + "\n... [文件过长，已截断]";
    }
    return content;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "路径超出项目范围" || msg === "禁止跟随符号链接") {
      return `[错误] ${msg}: ${path}`;
    }
    return `[错误] 读取失败: ${path}: ${msg}`;
  }
}

async function fileList(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? ".");
  try {
    const p = await resolveInProject(path);
    const entries = (await readdir(p, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) {
      return "[空目录]";
    }
    return entries.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`).join("\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "路径超出项目范围" || msg === "禁止跟随符号链接") {
      return `[错误] ${msg}: ${path}`;
    }
    return `[错误] 列出失败: ${path}: ${msg}`;
  }
}

async function fileWrite(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "");
  if (!path) {
    return "[错误] 缺少 path 参数";
  }
  if (!("content" in args)) {
    return "[错误] 缺少 content 参数";
  }
  const content = String(args.content ?? "");
  try {
    const p = projectRootPath(path);
    const data = Buffer.from(content, "utf-8");
    if (data.length > MAX_WRITE_BYTES) {
      return `[错误] 内容超过 ${MAX_WRITE_BYTES / (1024 * 1024)}MB 上限，拒绝写入`;
    }
    const abs = await resolveInProject(p); // 项目根内 + 符号链接拒绝（realpath 校验）
    if (isBlockedWritePath(abs)) {
      return `[错误] 敏感文件/目录禁止写入: ${path}`;
    }
    await mkdir(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `${basename(abs)}.${randomUUID().slice(0, 8)}.tmp`);
    await writeFile(tmp, data);
    await rename(tmp, abs);
    return `已保存 ${data.length} 字节到 ${abs}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "路径超出项目范围" || msg === "禁止跟随符号链接") {
      return `[错误] ${msg}: ${path}`;
    }
    return `[错误] 写入失败: ${path}: ${msg}`;
  }
}

async function codeCheck(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "").trim();
  if (!path) {
    return "[错误] 缺少 path 参数";
  }
  let abs: string;
  try {
    abs = await resolveInProject(path);
    void (await stat(abs));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "路径超出项目范围") {
      return `[错误] 路径超出项目范围: ${path}`;
    }
    return `[错误] ${msg.includes("不存在") ? `文件不存在或不可读: ${path}` : `校验失败: ${msg}`}`;
  }
  const suffix = extname(abs).toLowerCase();
  try {
    if (suffix === ".py") {
      try {
        await execFileP("py", ["-m", "py_compile", abs], { timeout: 30_000 });
        return `语法校验通过: ${path}（Python）`;
      } catch (e) {
        const stderr = (e as { stderr?: string }).stderr ?? "";
        return `[错误] Python 语法错误: ${stderr.trim().slice(0, 300)}`;
      }
    }
    if (suffix === ".js" || suffix === ".mjs" || suffix === ".cjs" || suffix === ".ts") {
      try {
        await execFileP("node", ["--check", abs], { timeout: 30_000 });
        return `语法校验通过: ${path}（${suffix.slice(1)}）`;
      } catch (e) {
        const stderr = (e as { stderr?: string }).stderr ?? "";
        return `[错误] ${suffix.slice(1)} 语法错误: ${stderr.trim().slice(0, 300)}`;
      }
    }
    return `[提示] 不支持的代码类型（${suffix || "无扩展名"}），跳过语法校验`;
  } catch (e) {
    return `[错误] 校验失败: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }
}

async function webFetch(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? "");
  if (!url) {
    return "[错误] 缺少 url 参数";
  }
  if (!/^https?:\/\//i.test(url)) {
    return "[错误] 仅支持 http/https 地址";
  }
  let maxChars = 4000;
  try {
    maxChars = Number(args.max_chars ?? 4000);
  } catch {
    maxChars = 4000;
  }
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      return `[错误] 抓取失败: HTTP ${resp.status}`;
    }
    const html = await resp.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
    const body = text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
    return body || "[空页面]";
  } catch (e) {
    return `[错误] 抓取失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function webSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "");
  if (!query) {
    return "[错误] 缺少 query 参数";
  }
  let maxResults = 10;
  try {
    maxResults = Math.min(10, Math.max(1, Number(args.max_results ?? 10)));
  } catch {
    maxResults = 10;
  }
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) slime-agent" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return `[错误] 搜索失败: HTTP ${resp.status}`;
    }
    const html = await resp.text();
    const items: string[] = [];
    const liRe = /<li class="b_algo"[\s\S]*?<\/li>/gi;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = liRe.exec(html)) !== null && count < maxResults) {
      const block = m[0];
      const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) {
        continue;
      }
      const link = titleMatch[1];
      const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
      items.push(`- ${title}\n  ${link}\n  ${snippet}`);
      count++;
    }
    if (items.length === 0) {
      return "[无搜索结果]";
    }
    return items.join("\n");
  } catch (e) {
    return `[错误] 搜索失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function registerBuiltinTools(): void {
  const registry = getRegistry();
  registry.register(new Tool({
    name: "file_read",
    description: "读取指定文件的内容。仅支持文本文件，最大 256KB。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "要读取的文件路径" } },
      required: ["path"],
    },
    executeFn: fileRead,
    permissions: ["read"],
  }));
  registry.register(new Tool({
    name: "file_list",
    description: "列出指定目录下的文件和子目录。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "要列出的目录路径，默认为当前目录", default: "." } },
      required: [],
    },
    executeFn: fileList,
    permissions: ["read"],
  }));
  registry.register(new Tool({
    name: "file_write",
    description: "把文本内容写入项目内的文件（如保存生成的内容、导出报告等）。path 为项目内相对/绝对路径，父目录自动创建；内容上限 5MB。敏感文件（密钥/加密配置）禁止写入。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径（项目内）" },
        content: { type: "string", description: "要写入的文本内容" },
      },
      required: ["path", "content"],
    },
    executeFn: fileWrite,
    permissions: ["write"],
  }));
  registry.register(new Tool({
    name: "code_check",
    description: "校验生成的代码文件语法是否有效（Python 用 py_compile，JS/TS 用 node --check）。写代码文件后必须调用本工具验证语法通过，再声称代码完成——防止生成不可运行的代码。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "要校验的代码文件路径（项目内）" } },
      required: ["path"],
    },
    executeFn: codeCheck,
    permissions: ["read"],
  }));
  registry.register(new Tool({
    name: "web_fetch",
    description: "抓取指定网页并提取正文文本（自动去除脚本/导航等噪声）。仅支持 http/https 公网地址。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的网页 URL" },
        max_chars: { type: "integer", description: "正文最大字符数，默认 4000", default: 4000 },
      },
      required: ["url"],
    },
    executeFn: webFetch,
    permissions: ["network"],
  }));
  registry.register(new Tool({
    name: "web_search",
    description: "搜索网页（Bing）。返回标题+链接+摘要，最多 10 条。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        max_results: { type: "integer", description: "最大结果数，默认 10，上限 10", default: 10 },
      },
      required: ["query"],
    },
    executeFn: webSearch,
    permissions: ["network"],
  }));
}