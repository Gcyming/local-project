








import { readdir, readFile, stat, writeFile, rename, mkdir, realpath, lstat, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, basename, extname, resolve, sep } from "node:path";
import { PROJECT_ROOT } from "../paths.js";


import {
  readTodos, writeTodos, renderTodos, randomId,
  TODO_STATUSES, TODO_CONTENT_MAX,
  type StoredTodo, type TodoStatus,
} from "../services/todoStore.js";
import { randomUUID } from "node:crypto";
import { execFile, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { Tool, ToolRegistry, getRegistry } from "./registry.js";

import { fireSidebarOpen, hasSidebarOpener, sessionIdFromArgs } from "../sidebarOpen.js";

import { sidebarMountSection } from "../sidebarMount.js";


import {
  recordFileChange, recordDirEntry, recordUnundoable, undoScopeOf, UNDO_DELETE_MAX_FILES,
  type UndoScope,
} from "../services/file_undo.js";
import { createPlan, updateStage, advanceByLabel, planProgress, planToJSON, parsePlan, type PlanStageStatus } from "../planning/plan.js";
import { PROTECTED_DIRS_SET, SENSITIVE_FILENAMES_SET, WRITE_BLOCK_SUFFIXES_SET } from "shared/security-policy";
import { extractDocText, docKindFromExt, legacyBinaryName, extractOleText, oleKindFromExt } from "../doc_text.js";
import { writeDocument, type DocFormat } from "../office/docWrite.js";
import type { MemoryStore } from "../memory/store.js";
import type {
  ActionVerify,
  DisplayInfo,
  ScreenAction,
  ScreenActionKind,
  ScreenActionResult,
  ScreenCaptureResult,
  UiDumpOutcome,
} from "../screen/types.js";
import { toOptimizedDataUrl } from "../screen/optimize.js";
import { registerBrowserTools } from "./browser.js";

import { DEFAULT_EXEC_BUDGET_MS } from "../services/subagent.js";
import { groupSubagentCatalog, renderSubagentCatalogLines } from "../services/subagentCatalog.js";


import { buildDiffMarker } from "../diff_marker.js";


import { searchOnlineText } from "../search/onlineSearch.js";

const execFileP = promisify(execFile);
const execP = promisify(execCb);


export { PROJECT_ROOT };

const MAX_READ_BYTES = 262_144;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

const MAX_CMD_OUTPUT = 32 * 1024;

const CMD_TIMEOUT_DEFAULT = 120_000;
const CMD_TIMEOUT_MAX = 600_000;


const SENSITIVE_NAMES = new Set([".slime_pass", "providers.enc.json", "auth_token.enc", "auth_token.json"]);
const WRITE_BLOCKED_NAMES = SENSITIVE_FILENAMES_SET;
const WRITE_BLOCKED_DIRS = PROTECTED_DIRS_SET;
const WRITE_BLOCKED_SUFFIXES = WRITE_BLOCK_SUFFIXES_SET;

function projectRootPath(p: string, ws = ""): string {
  if (isAbsolute(p)) return p;
  if (ws) return join(ws, p);
  return join(PROJECT_ROOT, p);
}














function isInsideRoot(abs: string, root: string): boolean {
  if (process.platform === "win32") {
    const a = abs.toLowerCase();
    const r = root.toLowerCase();
    return a === r || a.startsWith(r + sep);
  }
  return abs === root || abs.startsWith(root + sep);
}

function isInsideProject(p: string, ws = ""): boolean {
  const allowedRoots = ws ? [resolve(PROJECT_ROOT), resolve(ws)] : [resolve(PROJECT_ROOT)];
  const abs = resolve(p);
  return allowedRoots.some((root) => isInsideRoot(abs, root));
}




async function resolveInProject(p: string, ws = "", sandboxAllowed = false): Promise<string> {
  const abs = resolve(projectRootPath(p, ws));
  if (!sandboxAllowed && !isInsideProject(abs, ws)) {
    throw new RangeError("路径超出项目范围");
  }
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      throw new Error("禁止跟随符号链接");
    }
    const real = await realpath(abs);
    if (!sandboxAllowed && !isInsideProject(real, ws)) {
      throw new RangeError("路径超出项目范围");
    }
    return real;
  } catch (e) {
    if (e instanceof RangeError || e instanceof Error && e.message === "禁止跟随符号链接") {
      throw e;
    }
    return abs; 
  }
}

function isBlockedWritePath(p: string, ws = ""): boolean {
  const name = basename(p).toLowerCase();
  const ext = extname(p).toLowerCase();
  if (WRITE_BLOCKED_NAMES.has(name) || WRITE_BLOCKED_SUFFIXES.has(ext)) {
    return true;
  }
  const base = ws || PROJECT_ROOT;
  const rel = p.startsWith(base) ? p.slice(base.length) : p;
  const first = rel.split(/[\\/]/).find((s) => s.length > 0);
  return first !== undefined && WRITE_BLOCKED_DIRS.has(first.toLowerCase());
}












const DEFAULT_READ_LINES = 2000;
const MAX_READ_LINES = 20_000;

const MAX_SCAN_BYTES = 16 * 1024 * 1024;

const MAX_LINE_CHARS = 2000;











async function readLineWindow(
  abs: string, offset: number, limit: number,
): Promise<{ lines: string[]; totalLines?: number; hasMore: boolean; sawEof: boolean }> {
  const fh = await open(abs, "r");
  try {
    const decoder = new TextDecoder("utf-8");
    const buf = Buffer.allocUnsafe(64 * 1024);
    let pending = "";          
    let lineNo = 0;            
    let scanned = 0;
    let sawEof = false;
    let skippingLong = false;  
    const lines: string[] = [];

    const pushLine = (text: string, forceTruncated = false): void => {
      lineNo += 1;
      if (lineNo < offset || lines.length >= limit) { return; }
      const tooLong = forceTruncated || text.length > MAX_LINE_CHARS;
      lines.push(tooLong ? `${text.slice(0, MAX_LINE_CHARS)}… [本行超长已截断]` : text);
    };

    










    const feed = (text: string): void => {
      pending += text;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const raw = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (!skippingLong) { pushLine(raw.replace(/\r$/, "")); }
        skippingLong = false;
        nl = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE_CHARS) {
        if (!skippingLong) { pushLine(pending, true); skippingLong = true; }
        pending = "";
      }
    };

    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) { sawEof = true; break; }
      scanned += bytesRead;
      feed(decoder.decode(buf.subarray(0, bytesRead), { stream: true }));
      
      
      if (scanned >= MAX_SCAN_BYTES) { break; }
    }
    if (sawEof) {
      feed(decoder.decode());
      if (pending.length > 0 && !skippingLong) { pushLine(pending.replace(/\r$/, "")); }
    }
    
    const totalLines = sawEof ? lineNo : undefined;
    const hasMore = totalLines === undefined ? true : totalLines > offset + lines.length - 1;
    return { lines, totalLines, hasMore, sawEof };
  } finally {
    await fh.close();
  }
}


const OLE_KIND_LABEL: Record<string, string> = { doc: "DOC 97-2003", xls: "XLS 97-2003", ppt: "PPT 97-2003" };
function docKindLabel(kind: string): string { return OLE_KIND_LABEL[kind] ?? kind.toUpperCase(); }






function finishDocResult(
  extracted: { text: string; info: string[]; truncated: boolean },
  offset: number,
  limit: number,
  label: string,
): string {
  const all = extracted.text.split(/\r?\n/);
  const start = Math.min(offset - 1, all.length);
  let lines = all.slice(start, start + limit);
  let truncatedByBytes = false;
  if (Buffer.byteLength(lines.join("\n"), "utf-8") > MAX_READ_BYTES) {
    let keep = lines.length;
    while (keep > 1 && Buffer.byteLength(lines.slice(0, keep).join("\n"), "utf-8") > MAX_READ_BYTES) {
      keep = Math.max(1, Math.floor(keep * 0.7));
    }
    lines = lines.slice(0, keep);
    truncatedByBytes = true;
  }
  const head = `[${label} 已转为文本] ${extracted.info.join(" | ")}`
    + `${extracted.truncated ? "（原文过长，抽取阶段已截断）" : ""}\n`;
  const lastLine = start + lines.length;
  if (lastLine < all.length || truncatedByBytes) {
    return `${head}${lines.join("\n")}\n[已截断: 本次返回第 ${start + 1}-${lastLine} 行，全文共 ${all.length} 行。`
      + `继续读取请传 offset=${lastLine + 1} limit=${limit}]`;
  }
  return `${head}${lines.join("\n")}`;
}




const DOC_CREATE_FORMATS: Record<string, DocFormat> = {
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
  ".pdf": "pdf",
  ".csv": "csv",
  ".md": "md",
  ".txt": "txt",
};



















async function docsCreate(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "").trim();
  if (!path) { return "[错误] 缺少 path 参数"; }
  if (!("body" in args)) { return "[错误] 缺少 body 参数"; }
  const body = String(args.body ?? "");
  const title = typeof args.title === "string" ? args.title : undefined;

  const ext = extname(path).toLowerCase();
  const format = DOC_CREATE_FORMATS[ext];
  if (!format) {
    return `[错误] 不支持的目标格式「${ext || "(无扩展名)"}」。可用：${Object.keys(DOC_CREATE_FORMATS).join(" / ")}`;
  }

  const ws = String(args._workspace ?? "");
  const sandboxAllowed = args._sandbox_allowed === true;
  try {
    const p = projectRootPath(path, ws);
    const abs = await resolveInProject(p, ws, sandboxAllowed);
    if (isBlockedWritePath(abs, ws)) {
      return `[错误] 敏感文件/目录禁止写入: ${path}`;
    }
    
    try {
      await stat(abs);
      return `[错误] 目标已存在：${path}。本工具只**新建**文件（二进制文档不支持回滚，覆盖会造成`
        + `「能回滚但文件已坏」的假承诺）。请换一个路径，或先删掉它。`;
    } catch {  }

    const r = await writeDocument({ path: abs, format, title, body });
    if (!r.ok) { return `[错误] 生成失败：${r.error}`; }
    return `已生成 ${r.path}（${format}，${r.bytes} 字节）。`;
  } catch (e) {
    return `[错误] ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function fileRead(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "");
  if (!path) {
    return "[错误] 缺少 path 参数";
  }
  const ws = String(args._workspace ?? "");
  
  const sandboxAllowed = args._sandbox_allowed === true;
  const offset = clampInt(args.offset, 1, 1, 100_000_000);
  const limit = clampInt(args.limit, DEFAULT_READ_LINES, 1, MAX_READ_LINES);
  try {
    const p = await resolveInProject(path, ws, sandboxAllowed);
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
    
    
    
    
    
    
    
    
    
    const ext = extname(p).toLowerCase();
    const oleKind = oleKindFromExt(ext);
    const legacy = legacyBinaryName(ext);
    if (oleKind) {
      
      
      
      let extracted: ReturnType<typeof extractOleText>;
      try {
        extracted = extractOleText(await readFile(p), oleKind);
      } catch (e) {
        return `[错误] ${legacy} 文档解析失败: ${path}: ${e instanceof Error ? e.message : String(e)}`
          + "（可尝试用 Office/WPS 另存为 .docx/.xlsx/.pptx 后重读）";
      }
      return finishDocResult(extracted, offset, limit, docKindLabel(oleKind));
    }
    const docKind = docKindFromExt(ext);
    if (docKind) {
      let extracted: ReturnType<typeof extractDocText>;
      try {
        extracted = extractDocText(await readFile(p), docKind);
      } catch (e) {
        return `[错误] 文档解析失败: ${path}: ${e instanceof Error ? e.message : String(e)}`;
      }
      return finishDocResult(extracted, offset, limit, docKind);
    }
    const win = await readLineWindow(p, offset, limit);
    let content = win.lines.join("\n");
    
    if (Buffer.byteLength(content, "utf-8") > MAX_READ_BYTES) {
      
      let keep = win.lines.length;
      while (keep > 1 && Buffer.byteLength(win.lines.slice(0, keep).join("\n"), "utf-8") > MAX_READ_BYTES) {
        keep = Math.max(1, Math.floor(keep * 0.7));
      }
      content = win.lines.slice(0, keep).join("\n");
      win.lines = win.lines.slice(0, keep);
      win.hasMore = true;
    }
    const lastLine = offset + win.lines.length - 1;
    const sizeMb = (fsize / 1024 / 1024).toFixed(1);
    
    
    if (win.lines.length === 0) {
      const known = win.totalLines !== undefined ? `该文件共 ${win.totalLines} 行。` : "";
      if (win.totalLines !== undefined && offset > win.totalLines) {
        return `[注意: offset=${offset} 已超出文件末尾（${known}请用 offset=1 重新读取）。]`;
      }
      return `[已截断: 本次未取到完整行 —— 可能 (a) 从第 ${offset} 行起没有换行符`
        + `（整份文件是单行压缩内容；单行超过 ${MAX_LINE_CHARS} 字符会被截断标记），`
        + `或 (b) offset 超出已扫描范围（单次最多扫描 ${Math.round(MAX_SCAN_BYTES / 1024 / 1024)}MB 用于定位行号）。`
        + `${known}共 ${sizeMb}MB。这类文件不适合逐行读取：请先用 file_list 确认目标，或从更靠前的 offset 读取。]`;
    }
    
    
    if (!win.hasMore) { return content; }
    
    const total = win.totalLines !== undefined
      ? `共 ${win.totalLines} 行`
      : `共 ${sizeMb}MB（行数未知）`;
    return `${content}\n[已截断: 本次返回第 ${offset}-${lastLine} 行，${total}。`
      + `继续读取请传 offset=${lastLine + 1} limit=${limit}；`
      + "只看局部可用本工具的 offset/limit 分页，或先用 file_list 定位目标文件。]";
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
  const ws = String(args._workspace ?? "");
  const sandboxAllowed = args._sandbox_allowed === true;
  try {
    const p = await resolveInProject(path, ws, sandboxAllowed);
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
  const ws = String(args._workspace ?? "");
  
  const sandboxAllowed = args._sandbox_allowed === true;
  try {
    const p = projectRootPath(path, ws);
    const data = Buffer.from(content, "utf-8");
    if (data.length > MAX_WRITE_BYTES) {
      return `[错误] 内容超过 ${MAX_WRITE_BYTES / (1024 * 1024)}MB 上限，拒绝写入`;
    }
    const abs = await resolveInProject(p, ws, sandboxAllowed); 
    if (isBlockedWritePath(abs, ws)) {
      return `[错误] 敏感文件/目录禁止写入: ${path}`;
    }
    await mkdir(dirname(abs), { recursive: true });
    
    let oldContent = "";
    let existed = false;
    try { oldContent = await readFile(abs, "utf-8"); existed = true; } catch {  }
    



    const undoOk = await recordFileChange(
      undoScopeOf(args),
      abs,
      existed,
      existed ? oldContent : null,
    );
    const tmp = join(dirname(abs), `${basename(abs)}.${randomUUID().slice(0, 8)}.tmp`);
    await writeFile(tmp, data);
    await rename(tmp, abs);
    
    
    
    
    
    
    
    
    
    
    const diffTag = buildDiffMarker(oldContent, content);
    
    const undoNote = (!undoOk && undoScopeOf(args))
      ? "\n（⚠️ 本次改动未纳入回滚账本：账本写入失败，回滚这条消息时此文件不会被还原）"
      : "";
    return `已保存 ${data.length} 字节到 ${abs}${diffTag}${undoNote}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "路径超出项目范围" || msg === "禁止跟随符号链接") {
      return `[错误] ${msg}: ${path}`;
    }
    return `[错误] 写入失败: ${path}: ${msg}`;
  }
}


async function countEntries(dir: string): Promise<number> {
  let n = 0;
  try {
    const list = await readdir(dir, { withFileTypes: true });
    for (const e of list) {
      n += 1;
      if (e.isDirectory()) { n += await countEntries(join(dir, e.name)); }
    }
  } catch {  }
  return n;
}










async function collectTree(dir: string, limit: number): Promise<{ dirs: string[]; files: string[]; truncated: boolean }> {
  const dirs: string[] = [];
  const files: string[] = [];
  const walk = async (d: string): Promise<boolean> => {
    let list;
    try { list = await readdir(d, { withFileTypes: true }); } catch { return false; }
    for (const e of list) {
      if (e.isSymbolicLink()) { continue; }
      const p = join(d, e.name);
      if (dirs.length + files.length >= limit) { return false; }
      if (e.isDirectory()) {
        dirs.push(p);
        if (!(await walk(p))) { return false; }
      } else {
        files.push(p);
      }
    }
    return true;
  };
  const ok = await walk(dir);
  return { dirs, files, truncated: !ok };
}


interface DeleteCapture {
  scope: UndoScope;
  
  abs: string;
  
  dirs: string[];
  
  files: Array<{ abs: string; data: Buffer | null }>;
  
  unundoable?: string;
}




async function captureDeleteUndo(
  args: Record<string, unknown>,
  abs: string,
  isDir: boolean,
): Promise<DeleteCapture | null> {
  const scope = undoScopeOf(args);
  if (!scope) { return null; }
  if (isDir) {
    const tree = await collectTree(abs, UNDO_DELETE_MAX_FILES);
    if (tree.truncated) {
      return { scope, abs, dirs: [], files: [], unundoable: `目录过大（超过 ${UNDO_DELETE_MAX_FILES} 个条目）或读取失败` };
    }
    const files: Array<{ abs: string; data: Buffer | null }> = [];
    for (const f of tree.files) { files.push({ abs: f, data: await readFile(f).catch(() => null) }); }
    return { scope, abs, dirs: tree.dirs, files };
  }
  const data = await readFile(abs).catch(() => null);
  return { scope, abs, dirs: [], files: [{ abs, data }] };
}











async function commitDeleteUndo(cap: DeleteCapture | null): Promise<string> {
  if (!cap) { return ""; }
  if (cap.unundoable) {
    await recordUnundoable(cap.scope, cap.abs, cap.unundoable);
    return `\n（⚠️ 本次删除未纳入回滚账本：${cap.unundoable}，回滚这条消息时此目录不会被还原）`;
  }
  let ok = true;
  for (const d of cap.dirs) { if (!(await recordDirEntry(cap.scope, d))) { ok = false; } }
  for (const f of cap.files) {
    if (f.data === null) { await recordUnundoable(cap.scope, f.abs, "读不到改前内容"); ok = false; continue; }
    if (!(await recordFileChange(cap.scope, f.abs, true, f.data))) { ok = false; }
  }
  return ok ? "" : "\n（⚠️ 本次删除未完整纳入回滚账本：部分条目留痕失败，回滚时可能还原不了）";
}


















async function fileDelete(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "").trim();
  if (!path) { return "[错误] 缺少 path 参数"; }
  const recursive = args.recursive === true;
  const ws = String(args._workspace ?? "");
  const sandboxAllowed = args._sandbox_allowed === true;
  try {
    const abs = await resolveInProject(path, ws, sandboxAllowed);
    if (isBlockedWritePath(abs, ws)) {
      return `[错误] 敏感文件/目录禁止删除: ${path}`;
    }
    
    const root = resolve(ws || PROJECT_ROOT);
    if (resolve(abs).toLowerCase() === root.toLowerCase()) {
      return `[错误] 拒绝删除工作区根目录本身: ${path}（请指定根目录下的具体文件或子目录）`;
    }
    let st;
    try {
      st = await lstat(abs);
    } catch {
      return `[错误] 文件不存在: ${path}`;
    }
    let entryCount = 0;
    if (st.isDirectory()) {
      entryCount = await countEntries(abs);
      if (!recursive && entryCount > 0) {
        return `[错误] 目录非空（${entryCount} 个条目）：${path}。确认要连同内容一起删除时，请显式传 recursive=true。`;
      }
    }
    
    
    
    const captured = await captureDeleteUndo(args, abs, st.isDirectory());
    
    const trash = trashServiceRef;
    let viaTrash = false;
    if (trash) {
      try {
        const r = await trash.trash(abs);
        viaTrash = r?.ok === true;
        if (!viaTrash && r?.error) {
          
          return `[错误] 移入回收站失败（未执行永久删除）: ${path}: ${r.error}`;
        }
      } catch (e) {
        return `[错误] 移入回收站失败（未执行永久删除）: ${path}: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      await rm(abs, { recursive, force: false });
    }
    const what = st.isDirectory() ? `目录（含 ${entryCount} 个条目）` : "文件";
    const undoNote = await commitDeleteUndo(captured);
    return (viaTrash
      ? `已把${what}移入回收站：${abs}（可从系统回收站还原）`
      : `已永久删除${what}：${abs}（未进回收站：当前环境未装配回收站能力，此操作不可还原）`) + undoNote;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "路径超出项目范围" || msg === "禁止跟随符号链接") {
      return `[错误] ${msg}: ${path}`;
    }
    return `[错误] 删除失败: ${path}: ${msg}`;
  }
}


function resolveCmdCwd(raw: string, ws: string, sandboxAllowed: boolean): string {
  const base = ws || PROJECT_ROOT;
  if (!raw) { return resolve(base); }
  const abs = resolve(projectRootPath(raw, ws));
  const allowed = [resolve(PROJECT_ROOT), resolve(base)];
  if (!sandboxAllowed) {
    const ok = allowed.some((r) => abs === r || abs.startsWith(r + sep));
    if (!ok) { throw new RangeError("工作目录超出项目范围"); }
  }
  return abs;
}




















async function terminalRun(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? "").trim();
  if (!command) { return "[错误] 缺少 command 参数"; }
  const ws = String(args._workspace ?? "");
  const sandboxAllowed = args._sandbox_allowed === true;
  let cwd: string;
  try {
    cwd = resolveCmdCwd(String(args.cwd ?? ""), ws, sandboxAllowed);
  } catch (e) {
    return `[错误] ${e instanceof Error ? e.message : String(e)}`;
  }
  const rawTimeout = Number(args.timeoutMs);
  const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(Math.max(1000, Math.floor(rawTimeout)), CMD_TIMEOUT_MAX)
    : CMD_TIMEOUT_DEFAULT;
  try {
    const r = await execP(command, {
      cwd,
      timeout,
      maxBuffer: MAX_CMD_OUTPUT * 4,
      windowsHide: true,
      killSignal: "SIGKILL",
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return formatCmdOutput(out, 0, timeout, false);
  } catch (e) {
    
    const err = e as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
    const killed = err.killed === true || err.signal === "SIGKILL";
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (out || typeof err.code === "number") {
      return formatCmdOutput(out, typeof err.code === "number" ? err.code : 1, timeout, killed);
    }
    return `[错误] 命令启动失败: ${err.message ?? String(e)}`;
  }
}


function formatCmdOutput(raw: string, code: number, timeout: number, killed: boolean): string {
  const text = raw.replace(/\r\n/g, "\n");
  const truncated = text.length > MAX_CMD_OUTPUT;
  const body = truncated ? text.slice(0, MAX_CMD_OUTPUT) : text;
  const head = killed
    ? `[超时] 命令超过 ${Math.round(timeout / 1000)}s 未结束，已强制终止（进程树）`
    : code === 0 ? "命令执行成功（退出码 0）" : `命令退出码 ${code}`;
  const tail = truncated ? `\n…[输出被截断：共 ${text.length} 字符，仅显示前 ${MAX_CMD_OUTPUT}]` : "";
  return `${head}\n${body}${tail}`;
}

async function codeCheck(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "").trim();
  if (!path) {
    return "[错误] 缺少 path 参数";
  }
  const ws = String(args._workspace ?? "");
  const sandboxAllowed = args._sandbox_allowed === true;
  let abs: string;
  try {
    abs = await resolveInProject(path, ws, sandboxAllowed);
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
  return searchOnlineText(query, { maxResults: args.max_results });
}









async function todoWrite(args: Record<string, unknown>): Promise<string> {
  const sessionId = String(args.sessionId ?? "").trim();
  
  
  if (!sessionId) {
    return "[错误] 缺少 sessionId（会话上下文未就绪），本次待办未写入，也不会显示在待办面板。请继续任务，不要重复调用本工具。";
  }
  const actionRaw = String(args.action ?? "add").toLowerCase();
  
  const action = actionRaw === "update" ? "add" : actionRaw;
  if (action !== "add" && action !== "replace" && action !== "clear") {
    return `[错误] 未知 action「${actionRaw}」，只支持 add / replace / clear`;
  }

  const existing = readTodos(sessionId);

  let next: StoredTodo[];
  if (action === "clear") {
    next = [];
  } else {
    const itemsRaw = args.items;
    if (!Array.isArray(itemsRaw)) { return "[错误] todo_write 需要数组参数 items"; }
    
    
    
    interface IncomingTodo { id: string; content: string; status?: TodoStatus; blockedBy?: string[]; blocks?: string[] }
    const incoming: IncomingTodo[] = itemsRaw
      .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      .map((x) => ({
        id: typeof x.id === "string" && x.id ? x.id : "",
        content: String(x.content ?? "").trim().slice(0, TODO_CONTENT_MAX),
        status: TODO_STATUSES.includes(String(x.status) as TodoStatus) ? String(x.status) as TodoStatus : undefined,
        blockedBy: Array.isArray(x.blockedBy) ? (x.blockedBy as string[]).slice(0, 10) : undefined,
        blocks: Array.isArray(x.blocks) ? (x.blocks as string[]).slice(0, 10) : undefined,
      }));

    if (action === "replace") {
      
      
      const full = incoming.filter((it) => it.content.length > 0);
      if (full.length === 0) { return "[提示] replace 需要带 content 的完整任务列表，待办未变更"; }
      next = full.map((it) => ({
        id: it.id || randomId(),
        content: it.content,
        status: it.status ?? "pending",
        blockedBy: it.blockedBy,
        blocks: it.blocks,
      }));
    } else {
      
      
      
      const byId = new Map(existing.map((t) => [t.id, t]));
      
      const usable = incoming.filter((it) => it.content.length > 0 || (it.id !== "" && byId.has(it.id)));
      if (usable.length === 0) { return "[提示] 未收到有效任务项（新增项必须有 content），待办未变更"; }
      for (const it of usable) {
        const prev = it.id ? byId.get(it.id) : undefined;
        if (prev) {
          byId.set(prev.id, {
            ...prev,
            content: it.content || prev.content,   
            status: it.status ?? prev.status,      
            blockedBy: it.blockedBy ?? prev.blockedBy,
            blocks: it.blocks ?? prev.blocks,
            completedAt: prev.completedAt,         
          });
        } else {
          const nid = it.id || randomId();
          byId.set(nid, { id: nid, content: it.content, status: it.status ?? "pending", blockedBy: it.blockedBy, blocks: it.blocks });
        }
      }
      next = [...byId.values()];
    }
  }

  let normalized: StoredTodo[];
  try {
    
    normalized = writeTodos(sessionId, next) ?? [];
  } catch (e) {
    return `[错误] 写入任务失败：${e instanceof Error ? e.message : String(e)}`;
  }
  const verb = action === "clear" ? "已清空待办列表" : action === "replace" ? "已重写待办列表" : "已更新待办列表";
  return normalized.length === 0
    ? `[成功] ${verb}`
    : `[成功] ${verb}（共 ${normalized.length} 项）\n${renderTodos(normalized)}`;
}




















interface SubAgentRunLike {
  id: string;
  name: string;
  status: string;
  result?: string;
  error?: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  
  structured?: { status: string; summary: string; artifacts: string[]; confidence: number };
}


interface SubAgentManagerLike {
  
  
  delegate: (task: string, overrides?: { model?: string; agent?: string; agentId?: string; networkEnabled?: boolean; name?: string; systemPrompt?: string; toolsOnly?: string[]; adhoc?: boolean }) => SubAgentRunLike | null;
  
  wait?: (id: string, timeoutMs?: number, signal?: AbortSignal) => Promise<SubAgentRunLike | undefined>;
  list?: () => SubAgentRunLike[];
  
  
  catalog?: () => Array<{ name: string; description: string; source: "user" | "builtin" }>;
}

let subagentManagerRef: SubAgentManagerLike | null = null;
export function setSubagentManager(m: SubAgentManagerLike | null): void { subagentManagerRef = m; }










const SUBAGENT_WAIT_DEFAULT = DEFAULT_EXEC_BUDGET_MS + 60_000;
const SUBAGENT_WAIT_MAX = SUBAGENT_WAIT_DEFAULT + 300_000;


export const __SUBAGENT_BUDGETS = { waitDefault: SUBAGENT_WAIT_DEFAULT, waitMax: SUBAGENT_WAIT_MAX, execBudget: DEFAULT_EXEC_BUDGET_MS };


function resolveWaitMs(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, SUBAGENT_WAIT_MAX) : SUBAGENT_WAIT_DEFAULT;
}








function injectedSignal(args: Record<string, unknown>): AbortSignal | undefined {
  const raw = args._signal;
  return raw instanceof AbortSignal ? raw : undefined;
}


const SUBAGENT_RESULT_MAX = 4000;

const SUBAGENT_STATUS_TEXT: Record<string, string> = {
  pending: "排队中",
  running: "执行中",
  done: "完成",
  fail: "失败",
  timeout: "超时中断",
  cancelled: "已取消",
};


function subagentCatalogHint(): string {
  const cat = subagentManagerRef?.catalog?.() ?? [];
  if (cat.length === 0) { return "（当前没有任何已登记的子代理定义，直接自己完成即可）"; }
  
  
  
  return renderSubagentCatalogLines(groupSubagentCatalog(cat)).join("\n");
}








function renderSubAgentOutcome(run: SubAgentRunLike): string {
  const st = SUBAGENT_STATUS_TEXT[run.status] ?? run.status;
  const secs = run.startedAt && run.finishedAt ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s` : "—";
  const bits = [`状态：${st}`, `耗时 ${secs}`];
  if (run.model) { bits.push(`模型 ${run.model}`); }
  if (run.structured) { bits.push(`自评置信度 ${run.structured.confidence.toFixed(2)}`); }
  const head = `[子代理结果] ${run.name} · ${bits.join(" · ")}`;

  
  if (run.status !== "done") {
    const why = run.error ? `\n原因：${run.error}` : "";
    const advice = run.status === "timeout"
      ? "可缩小任务范围或调大 timeoutMs 后重派；也可以改为自己完成。"
      : run.status === "cancelled"
        ? "该任务已被取消；如仍需该产出请重新派发。"
        : "可换模型/缩小范围后重派，或改为自己完成——不要假装它成功了。";
    
    
    const partialRaw = (run.result ?? "").trim();
    const partial = partialRaw
      ? `\n\n—— 中断前已产出（部分，可供参考/续做）——\n${
          partialRaw.length > SUBAGENT_RESULT_MAX
            ? `${partialRaw.slice(0, SUBAGENT_RESULT_MAX)}\n…（已截断）`
            : partialRaw
        }`
      : "";
    return `${head}${why}${partial}\n${advice}`;
  }

  const artifacts = run.structured?.artifacts?.filter(Boolean) ?? [];
  const body = (run.structured?.summary || run.result || "").trim();
  const partial = run.structured?.status === "partial" ? "（子代理自评：**部分完成**）\n" : "";
  const artLine = artifacts.length > 0 ? `\n产物清单：${artifacts.join("、")}` : "";
  const truncated = body.length > SUBAGENT_RESULT_MAX;
  const shown = truncated ? `${body.slice(0, SUBAGENT_RESULT_MAX)}\n…（完整产出来自子代理，已截断展示）` : body;
  return [
    head,
    "",
    `${partial}${shown || "（子代理未返回正文）"}`,
    artLine,
    "",
    "—— 验收要求 ——",
    "1) 对照你下发的子任务目标，核对该产出是否真的完成（别只看它说\"完成\"）；",
    "2) 与用户需求冲突/信息不足/结论存疑时，**不要直接当事实转述**：可点名同一个子代理追加补充，或自己补齐；",
    "3) 需要更多细节时用 subagent_result 取该 id 的完整快照（本工具只给了摘要）。",
  ].join("\n");
}

async function delegateSubagent(args: Record<string, unknown>): Promise<string> {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) { return "[错误] task 不能为空（请写清目标 + 期望输出格式 + 边界）"; }
  if (!subagentManagerRef) { return "[错误] 子代理管理器未就绪（当前运行环境未装配 SubAgentManager）"; }
  const model = typeof args.model === "string" ? args.model.trim() : "";
  const wantAgent = typeof args.agent === "string" ? args.agent.trim() : "";
  
  
  
  const adhocName = typeof args.name === "string" ? args.name.trim() : "";
  const adhocSystem = typeof args.systemPrompt === "string" ? args.systemPrompt.trim() : "";
  const adhocTools = Array.isArray(args.tools)
    ? args.tools
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
    : [];
  const background = args.background === true || args.background === "true";
  const waitMs = resolveWaitMs(args.timeoutMs);
  
  
  const signal = injectedSignal(args);

  const overrides: {
    model?: string;
    agent?: string;
    networkEnabled?: boolean;
    name?: string;
    systemPrompt?: string;
    toolsOnly?: string[];
    adhoc?: boolean;
  } = {};
  if (model) { overrides.model = model; }
  if (wantAgent) { overrides.agent = wantAgent; }
  if (adhocSystem || adhocTools.length > 0) {
    
    overrides.adhoc = true;
    overrides.systemPrompt = adhocSystem || undefined;
    overrides.toolsOnly = adhocTools.length > 0 ? adhocTools : undefined;
    if (adhocName) { overrides.name = adhocName; }
  }
  
  
  overrides.networkEnabled = typeof args._network_enabled === "boolean" ? args._network_enabled : undefined;
  const run = subagentManagerRef.delegate(task, overrides);
  if (!run) {
    
    return [
      wantAgent
        ? `[提示] 没有名为「${wantAgent}」的子代理，本次未派发。`
        : "[提示] 没有与任务匹配的子代理定义，本次未派发。",
      "可用子代理如下（请从中点名，或判断该任务是否本就该你自己做）：",
      subagentCatalogHint(),
    ].join("\n");
  }

  const modelSuffix = model ? `（模型：${model}）` : "";
  
  if (background) {
    return `[已派发·后台] 子代理「${run.name}」开始执行（id=${run.id}${modelSuffix}）。` +
      `\n它不会阻塞你——你可以继续做别的子任务，之后用 subagent_result（id=${run.id}）取回结果并验收。`;
  }
  
  if (typeof subagentManagerRef.wait !== "function") {
    
    return `[已委派] 子代理「${run.name}」已开始执行（id=${run.id}${modelSuffix}）。当前装配不支持等待结果，请稍后用 subagent_result（id=${run.id}）取回。`;
  }
  const final = await subagentManagerRef.wait(run.id, waitMs, signal);
  
  
  if (signal?.aborted) {
    return `[已停止等待] 用户停止了本次生成，我不再等「${run.name}」（id=${run.id}）的结果。` +
      `\n⚠️ 该子代理**仍在后台继续执行**（没有被取消）；需要它的产出时用 subagent_result（id=${run.id}）取回。`;
  }
  if (!final) {
    return `[错误] 子代理「${run.name}」（id=${run.id}）等待结果超时/记录丢失，请用 subagent_result 复查或重派。`;
  }
  if (final.status === "running" || final.status === "pending") {
    return `[子代理仍在执行] ${final.name}（id=${final.id}）等待 ${(waitMs / 1000).toFixed(0)}s 后仍未结束。` +
      `\n可选：用 subagent_result（id=${final.id}）继续等；或先推进主线，稍后再来取。`;
  }
  return renderSubAgentOutcome(final);
}






async function subagentResult(args: Record<string, unknown>): Promise<string> {
  if (!subagentManagerRef) { return "[错误] 子代理管理器未就绪（当前运行环境未装配 SubAgentManager）"; }
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (id) {
    if (typeof subagentManagerRef.wait !== "function") { return "[错误] 当前装配不支持等待子代理结果"; }
    const waitMs = resolveWaitMs(args.timeoutMs);
    const signal = injectedSignal(args);
    const run = await subagentManagerRef.wait(id, waitMs, signal);
    
    if (signal?.aborted) {
      return `[已停止等待] 用户停止了本次生成，不再等 id=${id} 的结果。` +
        `\n⚠️ 该子代理**仍在后台继续执行**（没有被取消）；稍后再用 subagent_result（id=${id}）取回。`;
    }
    if (!run) { return `[错误] 未找到子代理运行记录 id=${id}`; }
    if (run.status === "running" || run.status === "pending") {
      return `[子代理仍在执行] ${run.name}（id=${run.id}）等待 ${(waitMs / 1000).toFixed(0)}s 后仍未结束，可稍后再取。`;
    }
    return renderSubAgentOutcome(run);
  }
  const all = subagentManagerRef.list?.() ?? [];
  if (all.length === 0) {
    return "[提示] 还没有派发过子代理。需要并行处理独立子任务时，用 delegate_subagent 派发。";
  }
  const lines = all.slice(-20).map((r) => {
    const st = SUBAGENT_STATUS_TEXT[r.status] ?? r.status;
    const first = (r.structured?.summary || r.result || r.error || "").trim().split("\n")[0]?.slice(0, 80) ?? "";
    return `- [${st}] ${r.name}（id=${r.id}）${first ? `：${first}` : ""}`;
  });
  return [`本会话共 ${all.length} 条子代理记录（最多列最近 20 条）：`, ...lines,
    "", "用 subagent_result（id=…）取某条的完整产出与验收提示。"].join("\n");
}




let memoryStoreProviderRef: ((agentId: string) => MemoryStore | null) | null = null;
export function setMemoryStoreProvider(p: typeof memoryStoreProviderRef): void { memoryStoreProviderRef = p; }




interface AdbServiceLike {
  devices(): Promise<{ ok: boolean; devices?: Array<{ serial: string; state: string; model?: string; product?: string }>; error?: string }>;
  
  detect(): Promise<{ ok: boolean; path?: string; version?: string; source?: string; error?: string }>;
  
  downloadPlatformTools(onProgress?: (p: unknown) => void): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  
  startServer(): Promise<{ ok: boolean; version?: string; stdout?: string; stderr?: string; error?: string }>;
  
  connect(host: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  disconnect?(host: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  shell(serial: string, command: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  install(serial: string, apkPath: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  uninstall?(serial: string, pkg: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  
  reboot?(serial: string, mode?: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  screencap(serial: string): Promise<{ ok: boolean; pngBase64?: string; error?: string }>;
  
  pull(serial: string, remote: string, local: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  
  push(serial: string, local: string, remote: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
}
let adbServiceRef: AdbServiceLike | null = null;
export function setAdbService(s: AdbServiceLike | null): void { adbServiceRef = s; }




interface ScreenControllerLike {
  listBackends(): string[];
  
  listTargetsReport(id?: "desktop" | "android"): Promise<{
    targets: DisplayInfo[];
    failures: Array<{ backend: "desktop" | "android"; error: string }>;
  }>;
  displayInfo(id: "desktop" | "android", target?: string): Promise<DisplayInfo>;
  capture(id: "desktop" | "android", target?: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult>;
  perform(id: "desktop" | "android", action: ScreenAction, target?: string): Promise<ScreenActionResult>;
  isHalted(): boolean;
  
  uiDump(id: "desktop" | "android", target?: string): Promise<UiDumpOutcome>;
  
  noteCaptureBasis(id: "desktop" | "android", target: string | undefined, imageW: number, imageH: number, devW: number, devH: number): void;
  
  listWindows(id: "desktop" | "android"): Promise<Array<{ title: string; pid: number; x: number; y: number; width: number; height: number }>>;
  
  focusWindow(id: "desktop" | "android", title: string): Promise<{ focused: boolean; detail: string; rect?: { x: number; y: number; width: number; height: number } }>;
  
  captureWindow(id: "desktop" | "android", title: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult>;
}
let screenControllerRef: ScreenControllerLike | null = null;
export function setScreenController(c: ScreenControllerLike | null): void { screenControllerRef = c; }












export function describeVerify(v: ActionVerify): string {
  if (v.ratio === null) {
    return `命中校验：未判定（${v.note}）`;
  }
  const pct = (v.ratio * 100).toFixed(2);
  if (v.hit) {
    return `命中校验：✓ 命中（画面变化 ${pct}%${v.attempts > 1 ? `，第 ${v.attempts} 次尝试才生效` : ""}）`;
  }
  return `命中校验：✗ 未命中（画面变化仅 ${pct}%，${v.note}）—— 常见原因是目标被遮挡 / 窗口未聚焦 / 元素还没渲染出来；`
    + `请重新 screen_capture 看清当前画面再决定下一步，不要盲目重复同一坐标。`;
}




interface HttpServerEntryLike {
  id: string;
  dir: string;
  port: number;
  host: string;
  urls: string[];
  startedAt: number;
  requests: number;
}
interface HttpServerLike {
  serve(p: { dir: string; port?: number; host?: string; spa?: boolean }): Promise<{ ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string }>;
  stop(id: string): Promise<{ ok: boolean; error?: string }>;
  list(): Promise<HttpServerEntryLike[]>;
}
let httpServerRef: HttpServerLike | null = null;
export function setHttpServer(s: HttpServerLike | null): void { httpServerRef = s; }












export interface TrashServiceLike {
  trash(absPath: string): Promise<{ ok: boolean; error?: string }>;
}
let trashServiceRef: TrashServiceLike | null = null;
export function setTrashService(s: TrashServiceLike | null): void { trashServiceRef = s; }


function toolAgentId(args: Record<string, unknown>): string {
  return typeof args._agent_id === "string" ? args._agent_id : "";
}


function activeMemoryStore(agentId: string): MemoryStore | null {
  if (!memoryStoreProviderRef) { return null; }
  try { return memoryStoreProviderRef(agentId); } catch { return null; }
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) { return fallback; }
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function memoryInsert(args: Record<string, unknown>): Promise<string> {
  const agentId = toolAgentId(args);
  if (!agentId) { return "[错误] 未取得当前 Agent 标识"; }
  const store = activeMemoryStore(agentId);
  if (!store) { return "[错误] 记忆存储未就绪（当前运行环境未装配 MemoryStore）"; }
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) { return "[错误] content 不能为空"; }
  const category = typeof args.category === "string" && args.category.trim() ? args.category.trim() : "fact";
  const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()).slice(0, 16) : [];
  const importance = clampInt(args.importance, 5, 1, 10);
  const source = typeof args.source === "string" && ["conversation", "event", "fact", "preference", "plan"].includes(args.source) ? args.source as "conversation" | "event" | "fact" | "preference" | "plan" : undefined;
  const confidence = typeof args.confidence === "number" && Number.isFinite(args.confidence) ? Math.max(0, Math.min(1, args.confidence)) : undefined;
  const entityKeys = Array.isArray(args.entity_keys) ? args.entity_keys.filter((k): k is string => typeof k === "string" && k.length > 0).slice(0, 16) : undefined;
  store.storeCategorized(category, content, tags, importance, { source, confidence, entity_keys: entityKeys });
  return `[已记忆] category=${category}：${content.slice(0, 200)}`;
}

async function memorySearch(args: Record<string, unknown>): Promise<string> {
  const agentId = toolAgentId(args);
  if (!agentId) { return "[错误] 未取得当前 Agent 标识"; }
  const store = activeMemoryStore(agentId);
  if (!store) { return "[错误] 记忆存储未就绪（当前运行环境未装配 MemoryStore）"; }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const category = typeof args.category === "string" && args.category.trim() ? args.category.trim() : undefined;
  const limit = clampInt(args.limit, 10, 1, 50);
  return store.search(query, { category, limit });
}

async function memoryForget(args: Record<string, unknown>): Promise<string> {
  const agentId = toolAgentId(args);
  if (!agentId) { return "[错误] 未取得当前 Agent 标识"; }
  const store = activeMemoryStore(agentId);
  if (!store) { return "[错误] 记忆存储未就绪（当前运行环境未装配 MemoryStore）"; }
  const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string" && x.length > 0) : undefined;
  const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim() : undefined;
  const before = typeof args.before === "string" && args.before.trim() ? args.before.trim() : undefined;
  if (!ids?.length && !topic && !before) { return "[错误] 需至少提供 ids / topic / before 之一"; }
  const removed = store.forget({ ids, topic, before });
  return removed > 0 ? `[已遗忘] 删除 ${removed} 条记忆` : "[提示] 无匹配的记忆可遗忘";
}













export function normalizeAppFiles(input: unknown): Array<{ path: string; content: string }> {
  if (!Array.isArray(input)) { return []; }
  const out: Array<{ path: string; content: string }> = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") { continue; }
    const o = raw as Record<string, unknown>;
    const p = typeof o.path === "string" ? o.path.trim() : "";
    const c = typeof o.content === "string" ? o.content : "";
    if (!p || p.endsWith("/")) { continue; }
    const norm = p.split("\\").join("/");
    if (isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) { continue; }
    if (norm.split("/").some((seg) => seg === "..")) { continue; }
    out.push({ path: norm, content: c });
  }
  return out;
}

export function registerBuiltinTools(target?: ToolRegistry): void {
  const registry = target ?? getRegistry();
  registry.register(new Tool({
    name: "delegate_subagent",
    
    
    
    
    
    
    
    
    
    description:
      "**委派**一个**独立、自包含**的子任务给专家子代理执行（独立上下文 + 独立工具面），它的产出会作为本次工具结果交回给你验收。\n" +
      "何时用：子任务能独立完成、不需要跟你来回确认，且产出较冗长（调研/审查/数据分析/批量处理），你不想让它污染主线上下文。\n" +
      "何时不用：主线对话本身（要频繁追问/修改/确认的）、一次工具调用就能拿到答案的（单文件读取 / 单文件精确查找）、以及必须共享同一上下文才能做的。\n" +
      "怎么派：task 里必须写清 **①要达到的目标 ②期望的输出格式 ③边界**（不要只说\"研究一下 X\"，否则子代理会跑偏或和别的子代理重复劳动）。\n" +
      "并行：多个互不依赖的子任务，**在同一轮里一次性全部派出**——同一轮的工具调用本来就并发执行，不必串着来（每个调用各自阻塞等自己的结果）。只有当你需要\"派出去后自己接着做别的、稍后再收\"时才用 background=true，之后用 subagent_result 收口。\n" +
      "点名：想指定某个子代理就在 agent 里写它的名字（见系统提示里的「可用子代理」清单）；不确定就留空，会按任务语义自动选。\n" +
      "临时子代理：清单里没有合适的人时**现场定义一个**——填 systemPrompt（角色 + 约束），并按需填 tools（工具白名单）/ name（展示名）/ model（档位）；系统会据此造一个只跑这一次的执行者（**不写盘、不进清单、跑完即弃**）。此时不要再填 agent。\n" +
      "模型：见系统提示「子代理执行模型」段列出的档位——**可按子任务难度为不同子代理点名不同 model**（机械/批量活给便宜档、需要推理的给强档），用户明确要求用某模型时也填这里。不填 = 用默认执行档；想跟随主对话模型就填 inherit。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "子任务说明（必填）：目标 + 期望输出格式 + 边界。要自包含——子代理看不到你和用户的对话。" },
        agent: { type: "string", description: "点名子代理（可选）：填系统提示「可用子代理」清单里的名字；留空则按任务自动选" },
        model: { type: "string", description: "子代理专属模型（可选）：取系统提示「子代理执行模型」段列出的档位（api:<key>[:<model>] / local:<id>），或 inherit 跟随主对话模型；不填 = 用默认执行档" },
        name: { type: "string", description: "临时子代理的展示名（可选）：**仅在你现场定义**（给了 systemPrompt 或 tools）时生效，用于界面展示与产物文件名。不填则自动按任务取一个名字" },
        systemPrompt: { type: "string", description: "**现场定义一个临时子代理**（可选）：它的角色设定与约束（工作流 / 输出要求 / 边界）。给了它（或 tools）就等于现场造一个**只在本任务里存在**的执行者——不写盘、不进「可用子代理」清单、跑完即弃。清单里没有合适的人时用它，别退回自己全做。⚠️ 此时**不要再填 agent**（以现场定义为准）" },
        tools: { type: "array", items: { type: "string" }, description: "临时子代理的工具白名单（可选，工具名列表）：限定它只能用这些工具（例 [\"file_read\",\"file_list\"]）。派发/收取类工具会被系统强制剔除（子代理不允许再派子代理）" },
        background: { type: "boolean", description: "true=只派发、不阻塞（之后用 subagent_result 取结果）；默认 false=等它跑完并把产出交回给你验收（等待期间用户点「停止生成」可中断等待，中断**不会**取消子代理）" },
        timeoutMs: { type: "number", description: "等待上限（毫秒）。默认 960000（= 子代理默认执行预算 900000 + 60s 收尾余量）；上限 1260000。注意这是**等待**上限，不是子代理的执行预算（预算到点由子代理自身 abort，等待到点只是主 Agent 先撤）。**等待必须 ≥ 预算**；用户「停止生成」会让等待提前结束（子代理不受影响）" },
      },
      required: ["task"],
    },
    executeFn: delegateSubagent,
    permissions: ["read"],
  }));
  
  
  registry.register(new Tool({
    name: "subagent_result",
    description:
      "取子代理的运行结果与状态。传 id → 等它跑完并返回完整产出与验收提示；不传 id → 列出本会话全部子代理记录（名称/状态/摘要/id），便于挑一个来收。\n" +
      "用 background=true 派发过子代理、想收口时用它；或用户问\"那个子代理跑得怎么样了\"时用它。\n" +
      "（等待可被用户「停止生成」中断：中断只结束等待、不取消子代理，稍后仍可用本工具取回。）",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "子代理运行 id（delegate_subagent 回执里有）；省略则列出全部记录" },
        timeoutMs: { type: "number", description: "等待上限（毫秒，默认 960000；上限 1260000）" },
      },
      required: [],
    },
    executeFn: subagentResult,
    permissions: ["read"],
  }));
  


  registry.register(new Tool({
    name: "docs_create",
    description:
      "按内容**从零生成一个真正的文档文件**并落盘（不是只写文本）：docx / xlsx / pptx / pdf / csv / md / txt。"
      + "目标格式由 `path` 的**扩展名**决定。\n"
      + "`body` 用**纯文本**表达结构，按格式解析：\n"
      + "  · **docx**：`# 一级标题` / `## 二级标题` / `- 列表项` / 空行分段；\n"
      + "  · **xlsx**：制表符或逗号分列、换行分行（**第一行当表头**）；\n"
      + "  · **pptx**：**每页之间用一行 `---` 分隔**，页内第一行是标题；\n"
      + "  · **pdf**：正文原样排版，超一页自动分页；\n"
      + "  · **csv / md / txt**：正文原样落盘。\n"
      + "父目录会自动创建。用户说「做个 Excel / 写个 Word / 生成一份 PPT / 导出 PDF」时用它。\n"
      + "⚠️ 只**新建**文件；目标已存在会被拒绝（换个路径，或文本格式改用 `file_write`）。\n"
      + "⚠️ 要**改**已有文档：先 `file_read` 读出内容，改好后用本工具写到**新路径**（本工具不做就地编辑）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标路径，扩展名决定格式（如 报告.docx / 数据.xlsx / 演示.pptx / 说明.pdf）" },
        body: { type: "string", description: "正文（结构写法见工具描述）" },
        title: { type: "string", description: "文档标题（可选；用于文档属性/标题栏）" },
      },
      required: ["path", "body"],
    },
    executeFn: docsCreate,
    permissions: ["write"],
    riskKind: "write",
    
    autoApprovable: true,
  }));
  registry.register(new Tool({
    name: "file_read",
    description: "读取文件内容（按行分页）。默认返回前 2000 行、单次最多 256KB；"
      + "文件更大时不会报错，而是返回一段并在末尾给出 offset/limit 续读指引 —— "
      + "**读大文件请直接传 offset/limit 分段读**，不要试图一次读完（会用光上下文）。"
      + "支持 Office 文档：docx（段落+表格）、pptx（按页）、xlsx（按表输出网格），会自动转为文本；"
      + "旧版二进制 .doc/.xls/.ppt 不支持，需要先另存为新格式。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要读取的文件路径" },
        offset: { type: "integer", description: "起始行号（1-based，默认 1）。大文件分段读时用上一段提示的 offset" },
        limit: { type: "integer", description: "本次读取的最大行数（默认 2000，上限 20000）" },
      },
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
    riskKind: "write",
    
    autoApprovable: true,
  }));
  
  
  registry.register(new Tool({
    name: "file_delete",
    description:
      "删除工作区内的文件或目录。默认**移入系统回收站**（可还原）；若当前环境未装配回收站能力，"
      + "则永久删除并在回执里明说，**此操作不可还原**。\n"
      + "目录非空时必须显式传 recursive=true（不提供「顺手递归」的默认值）。\n"
      + "敏感文件（密钥/加密配置）、受保护源码目录、工作区根目录本身、越权路径一律拒绝。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的文件或目录路径（工作区内相对路径或绝对路径）" },
        recursive: { type: "boolean", description: "目录非空时是否连同内容一起删除（默认 false，非空目录会被拒绝）" },
      },
      required: ["path"],
    },
    executeFn: fileDelete,
    permissions: ["write"],
    riskKind: "write",
    
    autoApprovable: false,
  }));
  
  
  
  registry.register(new Tool({
    name: "terminal_run",
    description:
      "在本机执行一条终端命令（POSIX 用 /bin/sh，Windows 用 cmd.exe；支持 &&、管道、重定向）。\n"
      + "用于运行脚本、构建、安装依赖、查看环境等。cwd 默认当前工作目录。\n"
      + "⚠ 属「终端」权限类别：若被拒绝并提示类别已关闭，请告知用户到「设置 → 权限 → 工具权限类别」"
      + "开启「终端（terminal）」，**不要改用手动让用户跑命令的方式绕开**。\n"
      + "⚠ 高危命令（rm -rf /、curl|sh、dd/mkfs、内网地址等）会被硬规则直接拦截，任何开关都不可绕过。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令行（含参数）" },
        cwd: { type: "string", description: "工作目录（工作区内；省略则用当前工作目录）" },
        timeoutMs: { type: "number", description: `超时毫秒（默认 ${CMD_TIMEOUT_DEFAULT}，上限 ${CMD_TIMEOUT_MAX}）；超时强制终止进程树` },
      },
      required: ["command"],
    },
    executeFn: terminalRun,
    permissions: ["terminal"],
    riskKind: "terminal",
    
    autoApprovable: false,
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
    riskKind: "network",
    
    autoApprovable: true,
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
    riskKind: "network",
    
    autoApprovable: true,
  }));
  registry.register(new Tool({
    name: "ask_user",
    description: "向用户提问并等待其抉择，用于任务方向出现分叉、关键决策或低把握但影响重大、需要用户拍板的时刻。调用后问题会以「决策分叉窗口」形式出现在用户输入框位置：每个选项显示方案主体与选择后果，你的推荐项会带「推荐」标注，用户可一键按推荐执行、自选或自填其他需求；工具随后返回用户的选择。要点：① question 要具体，说清正在权衡什么；② options 必须是 2~6 个具体可执行的方向，而不是「是/否/随便」这类态度；③ consequences 与 options 一一对应，各用一句话说明选择该方向的后果/影响，帮助用户评估；④ 若你基于全局评估有明显更优的方向，把该选项下标填入 recommendation（从 0 起），没有把握则不要填；⑤ 不要代替用户做重要决定、也不要在可以自行推进时滥用提问。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要问的问题（具体、清晰，说明当前权衡的关键）" },
        header: { type: "string", description: "决策分类徽章（简短词，如 部署方案 / 架构取舍 / 提交策略）" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "2~6 个候选方向，每个是具体可执行动作（方案主体），用户也可选择「其他」自填",
        },
        consequences: {
          type: "array",
          items: { type: "string" },
          description: "与 options 一一对应：选择该方向将产生的后果/影响（各一句，帮助用户评估）",
        },
        recommendation: {
          type: "integer",
          description: "基于全局评估的自评最优项下标（0 起，指向 options 中的推荐方向）；无明显更优时不要填",
        },
      },
      required: ["question", "options"],
    },
    executeFn: async (args: Record<string, unknown>): Promise<string> => {
      const q = String(args.question ?? "");
      
      return q ? `[提示] 需要用户交互才能回答该问题，当前环境无可询问的用户界面。问题：${q}` : "[提示] ask_user 缺少 question 参数";
    },
    permissions: ["read"],
  }));
  registry.register(new Tool({
    name: "todo_write",
    description:
      "维护当前会话的任务待办列表（右侧栏「待办任务」面板实时同步，同一次调用也会把最新计划回写成清单给你自己看）。" +
      "用法：多步骤/多文件/多工具协作的任务，**动手前先规划一次**（一条 items 列出全部阶段），" +
      "此后每完成一个阶段立刻再调一次把该项改成 completed、并把下一项改成 in_progress。" +
      "硬约束：任何时刻**最多一项** in_progress；完成项不要从列表里删掉（保留才能体现进度）；" +
      "一次 3-6 项为宜，太碎反而难跟踪。单步任务（一句话问答、单次查询）不要调用本工具。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "replace", "clear"],
          description:
            "add（默认）=按 id 合并：已有 id 就地更新、新 id 追加、未提及的项保留；" +
            "replace=整表重写（只保留本次 items，用于计划整体改版）；clear=清空列表",
          default: "add",
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "任务唯一标识；同一任务后续更新必须复用同一个 id（首次可省略，会自动分配）" },
              content: { type: "string", description: "任务描述（祈使句、简短明确，例：修复登录接口的空指针）" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "状态，默认 pending" },
              blockedBy: { type: "array", items: { type: "string" }, description: "前置依赖的任务 id 列表" },
            },
            required: ["content"],
          },
          description: "任务项列表（action=clear 时可省略）",
        },
      },
      required: [],
    },
    executeFn: todoWrite,
    
    
    
    
    
    permissions: ["read"],
  }));

  
  registry.register(new Tool({
    name: "plan_create",
    description: "把任务拆解为结构化 Plan（阶段列表顺序执行）。返回含 id 的 Plan JSON，此后用 plan_update 推进各阶段；适合多阶段任务，避免重复规划。",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "任务目标描述" },
        sessionId: { type: "string", description: "会话 id（可选）" },
        stages: { type: "array", items: { type: "string" }, description: "有序阶段列表（每项一个阶段标签）" },
      },
      required: ["description", "stages"],
    },
    executeFn: async (args: Record<string, unknown>): Promise<string> => {
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const rawStages = Array.isArray(args.stages) ? args.stages : [];
      if (!description || rawStages.length === 0) { return "[错误] description 与 stages 必填"; }
      const stages = rawStages.map((s) => (typeof s === "string" ? s : String(s)));
      const plan = createPlan({
        sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
        description,
        stages,
      });
      const p = planProgress(plan);
      return `[Plan 已创建] ${plan.id}（共 ${p.total} 阶段，当前 ${p.pct}%）\n${planToJSON(plan)}`;
    },
    permissions: ["read"],
  }));
  registry.register(new Tool({
    name: "plan_update",
    description: "推进 Plan 某阶段状态（in_progress/done/failed/skipped/pending）。可用阶段 id 或阶段标签引用。返回最新 Plan JSON。",
    parameters: {
      type: "object",
      properties: {
        plan: { type: "string", description: "plan_create 返回的 Plan JSON 字符串（原样传入）" },
        stage: { type: "string", description: "阶段 id（如 1）或阶段标签" },
        status: { type: "string", enum: ["pending", "in_progress", "done", "failed", "skipped"], description: "目标状态" },
        detail: { type: "string", description: "阶段备注（失败原因/产出说明，可选）" },
      },
      required: ["plan", "stage", "status"],
    },
    executeFn: async (args: Record<string, unknown>): Promise<string> => {
      const plan = typeof args.plan === "string" ? parsePlan(args.plan) : null;
      const stage = typeof args.stage === "string" ? args.stage.trim() : "";
      const status = typeof args.status === "string" ? args.status : "";
      if (!plan) { return "[错误] plan JSON 无效（请传 plan_create 返回的原样 JSON）"; }
      if (!stage || !["pending", "in_progress", "done", "failed", "skipped"].includes(status)) {
        return "[错误] stage 与 status 必填且合法（pending/in_progress/done/failed/skipped）";
      }
      const next = plan.stages.some((s) => s.id === stage)
        ? updateStage(plan, stage, status as PlanStageStatus, typeof args.detail === "string" ? args.detail : undefined)
        : advanceByLabel(plan, stage, status as PlanStageStatus).plan;
      const p = planProgress(next);
      return `[Plan 已更新] ${next.status}（${p.done}/${p.total} 阶段，${p.pct}%）\n${planToJSON(next)}`;
    },
    permissions: ["read"],
  }));

  
  registry.register(new Tool({
    name: "memory_insert",
    description: "把一条值得长期记住的事实/偏好/经验写入你自己的成长记忆（跨会话保留）。仅用于确需长期记住的内容（用户偏好、项目约定、重要教训），不要记录转瞬即逝的对话细节。category 可选 fact/preference/lesson/event；source 标注来源（fact/preference 会沉淀到语义层）；confidence 0..1 表示把握。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要记住的内容（一句话，简洁明确）" },
        category: { type: "string", enum: ["fact", "preference", "lesson", "event"], description: "记忆类别，默认 fact" },
        importance: { type: "integer", description: "重要度 1-10，默认 5" },
        tags: { type: "array", items: { type: "string" }, description: "标签（用于检索/关联）" },
        source: { type: "string", enum: ["conversation", "event", "fact", "preference", "plan"], description: "来源（可选，影响归档层）" },
        confidence: { type: "number", description: "置信度 0..1，默认 1" },
        entity_keys: { type: "array", items: { type: "string" }, description: "关联实体 key（如 task:123）" },
      },
      required: ["content"],
    },
    executeFn: memoryInsert,
    permissions: ["write"],
    riskKind: "write",
    
    autoApprovable: true,
  }));
  registry.register(new Tool({
    name: "memory_search",
    description: "检索你自己的长期记忆（按关键词/主题相关性排序）。用于在回答前召回用户偏好、项目约定、历史经验等。query 留空则返回最近常用的记忆。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词/主题" },
        category: { type: "string", description: "限定类别（fact/preference/lesson/event，可选）" },
        limit: { type: "integer", description: "最多返回条数，默认 10" },
      },
      required: [],
    },
    executeFn: memorySearch,
    permissions: ["read"],
  }));
  registry.register(new Tool({
    name: "memory_forget",
    description: "从长期记忆中删除条目。ids 按记忆 id 精确删除；topic 按内容/标签包含关系删除；before 删除某 ISO 时间之前创建的全部记忆（三者至少填一个，可组合）。用于纠正错误记忆或清理过时信息。",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "要删除的记忆 id 列表" },
        topic: { type: "string", description: "按主题删除（内容或标签包含该词）" },
        before: { type: "string", description: "删除该 ISO 时间（含）之前创建的记忆" },
      },
      required: [],
    },
    executeFn: memoryForget,
    permissions: ["write"],
    riskKind: "write",
    
    autoApprovable: true,
  }));

  

  


  const ADB_SCAN_PORTS = [
    7555, 16384, 16416, 16448, 6555,
    5555, 5554, 5556,
    62001, 62025, 62026,
    21503, 21513, 20060,
  ];

  
  async function autoScanAndConnect(): Promise<{ lines: string[]; connected: string[] }> {
    const lines: string[] = [];
    const connected: string[] = [];
    if (!adbServiceRef) { return { lines, connected }; }
    for (const p of ADB_SCAN_PORTS) {
      const addr = `127.0.0.1:${p}`;
      try {
        const r = await adbServiceRef.connect(addr);
        
        const out = `${r?.stdout ?? ""}${r?.stderr ?? ""}`.toLowerCase();
        const ok = r?.ok && !out.includes("failed") && !out.includes("cannot") && !out.includes("refused");
        if (ok) { connected.push(addr); lines.push(`  ${addr} → 已连接`); }
      } catch {  }
    }
    return { lines, connected };
  }

  async function adbDevices(_args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    try {
      
      if (typeof adbServiceRef.detect === "function") {
        const det = await adbServiceRef.detect();
        if (!det?.ok) {
          return [
            "[错误] 本机未检测到 adb（Android 调试桥），无法读取设备列表。",
            "**不要要求用户自己去命令行执行 adb 命令**——它们同样会失败（本机没有 adb）。",
            "请直接调用 `adb_setup` 工具：它会自动下载官方 platform-tools 并启动 adb 服务，一次到位。",
          ].join("\n");
        }
      }
      const r = await adbServiceRef.devices();
      if (!r?.ok) { return `[错误] 读取设备列表失败：${r?.error ?? "未知错误"}`; }
      let list = r.devices ?? [];

      
      let scanInfo = "";
      if (list.length === 0) {
        const scan = await autoScanAndConnect();
        if (scan.connected.length > 0) {
          const again = await adbServiceRef.devices();
          list = again.devices ?? list;
          scanInfo = `\n（已自动扫描常见模拟器端口并连接成功：${scan.connected.join("、")}）`;
        } else {
          scanInfo = `\n（已自动扫描 ${ADB_SCAN_PORTS.length} 个常见模拟器端口，均未连上）`;
        }
      }

      if (list.length === 0) {
        return [
          "[提示] 当前没有可用的 Android 设备（state 非 device 或无设备）。",
          `已自动尝试的常见端口：${ADB_SCAN_PORTS.map((p) => `127.0.0.1:${p}`).join("、")}`,
          "",
          "下一步建议（由你调用工具完成，不要甩给用户）：",
          "1) 确认模拟器已开启「USB 调试 / 无线调试」（MuMu：设置→其他→开启 root/ADB；雷电：设置→其他设置→开启 ADB 调试）；",
          "2) 调用 `adb_connect`（不带 host）再扫一轮，或传入模拟器实际端口如 host=\"127.0.0.1:16384\"；",
          "3) 若仍不行，用 `adb_setup` 确认 adb 服务状态。",
        ].join("\n");
      }
      return list.map((d) => `serial=${d.serial} state=${d.state}${d.model ? ` model=${d.model}` : ""}${d.product ? ` product=${d.product}` : ""}`).join("\n") + scanInfo;
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  

  async function adbSetup(args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    const allowDownload = args.download !== false;
    const doConnect = args.connect !== false;
    const log: string[] = [];
    try {
      
      let det = typeof adbServiceRef.detect === "function" ? await adbServiceRef.detect() : null;
      if (!det?.ok) {
        if (!allowDownload) {
          return "[提示] 本机未检测到 adb，且本次调用传入了 download=false。如需自动安装请去掉该参数重试。";
        }
        if (typeof adbServiceRef.downloadPlatformTools !== "function") {
          return "[错误] 当前运行环境不支持自动下载 platform-tools。请到「设置 → 运行环境」点击「下载 platform-tools」。";
        }
        log.push("① 未检测到 adb → 开始下载官方 platform-tools（约 6MB，可能需要 10-60 秒）…");
        const dl = await adbServiceRef.downloadPlatformTools();
        if (!dl?.ok) {
          return `[错误] platform-tools 下载失败：${dl?.error ?? "未知错误"}\n（可改用「设置 → 运行环境 → 下载 platform-tools」手动重试）`;
        }
        log.push(`   ${(dl.stdout ?? "platform-tools 已安装").trim()}`);
        det = typeof adbServiceRef.detect === "function" ? await adbServiceRef.detect() : null;
        if (!det?.ok) {
          return `[错误] platform-tools 安装后仍未检测到 adb：${det?.error ?? "未知"}\n${log.join("\n")}`;
        }
      }
      log.push(`② adb 已就绪：${det?.version ?? "未知版本"}（来源 ${det?.source ?? "?"}）`);
      log.push(`   路径：${det?.path ?? "未知"}`);

      
      if (typeof adbServiceRef.startServer === "function") {
        const s = await adbServiceRef.startServer();
        log.push(s?.ok ? `③ adb 服务已启动${s.version ? `（${s.version}）` : ""}` : `③ adb 服务启动失败：${s?.error ?? "未知"}`);
      }

      
      if (doConnect) {
        const scan = await autoScanAndConnect();
        if (scan.connected.length > 0) {
          log.push(`④ 已自动连接：${scan.connected.join("、")}`);
        } else {
          log.push(`④ 已扫描 ${ADB_SCAN_PORTS.length} 个常见端口，未发现可连接的模拟器`);
          log.push("   请确认模拟器已开启 ADB 调试（MuMu：设置→其他；雷电：设置→其他设置），然后重试。");
        }
      }

      
      const dev = await adbServiceRef.devices();
      const list = dev.devices ?? [];
      log.push(list.length > 0
        ? `⑤ 当前设备：\n${list.map((d) => `   serial=${d.serial} state=${d.state}${d.model ? ` model=${d.model}` : ""}`).join("\n")}`
        : "⑤ 当前仍无可用设备（state=device 的条目）");

      return log.join("\n");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}\n${log.join("\n")}`;
    }
  }

  async function adbShell(args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    const serial = typeof args.serial === "string" ? args.serial.trim() : "";
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!serial) { return "[错误] serial 不能为空（先用 adb_devices 列出设备取 serial）"; }
    if (!command) { return "[错误] command 不能为空"; }
    try {
      const r = await adbServiceRef.shell(serial, command);
      if (!r?.ok) { return `[错误] shell 执行失败：${r?.error ?? "未知错误"}`; }
      return (r.stdout ?? "") + (r.stderr ?? "");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function adbInstall(args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    const serial = typeof args.serial === "string" ? args.serial.trim() : "";
    const apkPath = typeof args.apkPath === "string" ? args.apkPath.trim() : "";
    if (!serial) { return "[错误] serial 不能为空"; }
    if (!apkPath) { return "[错误] apkPath 不能为空（本机 APK 文件路径）"; }
    try {
      const r = await adbServiceRef.install(serial, apkPath);
      if (!r?.ok) { return `[错误] 安装失败：${r?.error ?? "未知错误"}`; }
      return `[已安装] ${apkPath} → ${serial}\n${(r.stdout ?? "") + (r.stderr ?? "")}`.trim();
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function adbScreencap(args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    const serial = typeof args.serial === "string" ? args.serial.trim() : "";
    if (!serial) { return "[错误] serial 不能为空"; }
    try {
      const r = await adbServiceRef.screencap(serial);
      if (!r?.ok || !r.pngBase64) { return `[错误] 截图失败：${r?.error ?? "未知错误"}`; }
      
      
      const opt = toOptimizedDataUrl(r.pngBase64, { grid: true });
      const kb = Math.round((opt.bytes || 0) / 1024);
      const imgSize = opt.width && opt.height ? `${opt.width}×${opt.height}` : "尺寸未知";
      
      if (opt.width && opt.height) {
        try {
          const info = await adbServiceRef.shell(serial, "wm size");
          const out = info.stdout ?? "";
          const m = out.match(/Override size:\s*(\d+)\s*x\s*(\d+)/i) ?? out.match(/Physical size:\s*(\d+)\s*x\s*(\d+)/i);
          if (m && screenControllerRef) { screenControllerRef.noteCaptureBasis("android", serial, opt.width, opt.height, Number(m[1]), Number(m[2])); }
        } catch {  }
      }
      return [
        `[已截图] ${serial}｜图像尺寸 ${imgSize}（${kb}KB，已叠加刻度网格）`,
        `后续 screen_action 的坐标以这张图为准（默认 coordSpace=image）；建议直接改用 screen_ui_dump + selector 点击更准。`,
        `@@IMG@@${opt.dataUrl}`,
      ].join("\n");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  
  async function adbConnect(args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    const host = typeof args.host === "string" ? args.host.trim() : "";
    
    if (typeof adbServiceRef.detect === "function") {
      const det = await adbServiceRef.detect();
      if (!det?.ok) {
        return "[错误] 本机未检测到 adb，无法执行连接。请先调用 `adb_setup` 自动安装 platform-tools 并启动 adb 服务，然后再连接。";
      }
    }
    try {
      if (host) {
        const r = await adbServiceRef.connect(host);
        const out = `${r?.stdout ?? ""}${r?.stderr ?? ""}`.trim();
        const bad = /failed|cannot|refused|unable/i.test(out);
        if (!r?.ok || bad) {
          return [
            `[错误] 连接 ${host} 失败：${out || r?.error || "无响应"}`,
            "排查建议（由你调用工具完成，不要要求用户开命令行）：",
            "  · 确认模拟器已开启 ADB 调试；",
            "  · 调用 `adb_connect`（不传 host）自动扫描全部常见端口；",
            "  · 或调用 `adb_setup` 确认 adb 服务是否在跑。",
          ].join("\n");
        }
        const devs = await adbServiceRef.devices();
        const list = devs.devices ?? [];
        return `[已连接] ${host}\n${list.length ? "当前设备：\n" + list.map((d) => `serial=${d.serial} state=${d.state}${d.model ? ` model=${d.model}` : ""}`).join("\n") : "（暂未列出任何设备）"}`;
      }
      
      const scan = await autoScanAndConnect();
      const devs = await adbServiceRef.devices();
      const list = devs.devices ?? [];
      const usable = list.filter((d) => d.state === "device");
      return [
        `已自动扫描 ${ADB_SCAN_PORTS.length} 个常见模拟器端口（${ADB_SCAN_PORTS.map((p) => `127.0.0.1:${p}`).join("、")}）：`,
        scan.lines.length > 0 ? scan.lines.join("\n") : "  （无一端口连上）",
        "",
        usable.length > 0
          ? `可用设备（${usable.length} 个）：\n${usable.map((d) => `serial=${d.serial} state=${d.state}${d.model ? ` model=${d.model}` : ""}`).join("\n")}\n下一步可用 serial 调 adb_shell / adb_screencap / adb_push / adb_pull。`
          : "未检测到任何可用设备。请确认模拟器已开启「ADB 调试 / 无线调试」；若模拟器使用非标准端口，可显式传入 host（如 127.0.0.1:16384）。",
      ].join("\n");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  registry.register(new Tool({
    name: "adb_setup",
    description: [
      "一键准备 ADB 环境（本机没装 adb / adb 服务没起来 / 不知道模拟器端口时**先用这个**）。",
      "执行顺序：检测 adb → 缺失则自动下载官方 platform-tools → 启动 adb 服务 → 自动扫描并连接常见模拟器端口 → 复读设备列表。",
      "参数：download（默认 true，是否允许自动下载 platform-tools）；connect（默认 true，是否自动扫描连接）。",
      "⚠ 使用规范：**任何涉及 ADB 的排查，都必须由你调用本工具完成，严禁要求用户自己去 cmd/PowerShell 执行 adb 命令**。",
      "用户没有义务也不应该手动跑命令行；如果探测不到设备，先调 adb_setup，再调 adb_devices 复核。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        download: { type: "boolean", description: "是否允许自动下载 platform-tools（默认 true）", default: true },
        connect: { type: "boolean", description: "是否自动扫描并连接常见模拟器端口（默认 true）", default: true },
      },
      required: [],
    },
    executeFn: adbSetup,
    permissions: ["network", "write"],
    riskKind: "network",
  }));
  registry.register(new Tool({
    name: "adb_devices",
    description: [
      "列出当前通过 ADB 连接的 Android 设备（USB 或无线）。返回每个设备的 serial、状态 state、型号 model。操作设备前先调用它拿到 serial。",
      "本机未装 adb 时会明确提示改用 `adb_setup`；列表为空时会**自动扫描常见模拟器端口**（MuMu 7555/16384、雷电 5555、夜神 62001、AVD 5554、逍遥 21503 等）并重试。",
      "⚠ **严禁要求用户自己去命令行执行 adb devices / netstat**——所有探测由本工具完成。",
    ].join("\n"),
    parameters: { type: "object", properties: {}, required: [] },
    executeFn: adbDevices,
    permissions: ["read"],
  }));
  registry.register(new Tool({
    name: "adb_shell",
    description: [
      "在指定 Android 设备上执行 ADB shell 命令（直接操作设备，如查看包列表 pm list packages、读取属性、写入文件、运行命令等）。",
      "需要 serial（来自 adb_devices）与 command。",
      "⚠ 本工具属「终端」权限类别：若被拒绝并提示类别已关闭，请告知用户到「设置 → 权限 → 工具权限类别」开启「终端（terminal）」，**不要改用手动让用户跑命令的方式绕开**。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        serial: { type: "string", description: "目标设备 serial（adb_devices 返回的 serial 字段）" },
        command: { type: "string", description: "要在设备上执行的 shell 命令" },
      },
      required: ["serial", "command"],
    },
    executeFn: adbShell,
    permissions: ["terminal"],
  }));
  registry.register(new Tool({
    name: "adb_install",
    description: "通过 ADB 把本机一个 APK 文件安装到指定 Android 设备。需要 serial 和本机 apkPath（绝对路径）。用于给设备部署/更新应用。",
    parameters: {
      type: "object",
      properties: {
        serial: { type: "string", description: "目标设备 serial" },
        apkPath: { type: "string", description: "本机 APK 文件绝对路径" },
      },
      required: ["serial", "apkPath"],
    },
    executeFn: adbInstall,
    permissions: ["write"],
  }));
  registry.register(new Tool({
    name: "adb_screencap",
    description: "对指定 Android 设备截图（返回 PNG 的 base64）。用于在设备上查看当前界面状态。需要 serial。模型无法直接查看图片，仅返回长度提示，GUI 面板可预览。",
    parameters: {
      type: "object",
      properties: { serial: { type: "string", description: "目标设备 serial" } },
      required: ["serial"],
    },
    executeFn: adbScreencap,
    permissions: ["read"],
  }));
  registry.register(new Tool({
    name: "adb_connect",
    description: [
      "连接本地第三方 Android 模拟器/设备（无线调试）。不传 host 时会自动扫描常见模拟器默认端口（MuMu 7555/16384、雷电 5555、夜神 62001、AVD 5554、逍遥 21503 等）并逐个尝试连接，最后用设备列表回报结果。",
      "传 host（形如 127.0.0.1:7555）则直接连接该地址。操作 Android 设备前通常先调用它（或 adb_devices）拿到 serial，再执行 shell/install/screencap/push/pull。",
      "⚠ **不要让用户自己输参数或自己跑 adb connect——由你主动探测连接**；本机未装 adb 时会提示改用 `adb_setup`。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "可选。目标地址，形如 127.0.0.1:5555；留空则自动扫描常见模拟器端口" },
      },
      required: [],
    },
    executeFn: adbConnect,
    permissions: ["network"],
  }));

  
  async function httpServe(args: Record<string, unknown>): Promise<string> {
    if (!httpServerRef) { return "[错误] HTTP 服务未就绪（当前运行环境未装配 HttpServer）"; }
    const dir = typeof args.dir === "string" ? args.dir.trim() : "";
    if (!dir) { return "[错误] dir 不能为空（要对外提供服务的本地目录路径）"; }
    let port: number | undefined;
    if (args.port !== undefined && args.port !== null && args.port !== "") {
      const n = Number(args.port);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) { return "[错误] port 需为 1-65535 之间的数字"; }
      port = Math.round(n);
    }
    const spa = Boolean(args.spa);
    
    const rawHost = typeof args.host === "string" ? args.host.trim() : "";
    const host = rawHost || "127.0.0.1";
    const lan = host === "0.0.0.0" || host === "::" || (!/^(127\.|localhost$|::1$)/.test(host) && host !== "");
    try {
      const r = await httpServerRef.serve({ dir, port, host, spa });
      if (!r?.ok) { return `[错误] 启动 HTTP 服务失败：${r?.error ?? "未知错误"}`; }
      const urls = (r.urls ?? []).map((u) => `  - ${u}`).join("\n");
      const spaHint = spa ? "（已开启 SPA 回退）" : "";
      const lanHint = lan ? `\n⚠ 注意：当前监听 ${host}，同网段设备均可访问该目录。如非本意，请用 host=127.0.0.1 重启服务。` : "";
      return `[已启动 HTTP 静态服务] id=${r.id} 目录=${dir} 端口=${r.port} 监听=${host}${spaHint}\n可访问地址：\n${urls}${lanHint}\n提示：用 http_list 查看 / http_stop 停止。`;
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function httpStop(args: Record<string, unknown>): Promise<string> {
    if (!httpServerRef) { return "[错误] HTTP 服务未就绪（当前运行环境未装配 HttpServer）"; }
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) { return "[错误] id 不能为空（先用 http_list 拿到服务 id）"; }
    try {
      const r = await httpServerRef.stop(id);
      if (!r?.ok) { return `[错误] 停止失败：${r?.error ?? "未知错误"}`; }
      return `[已停止] HTTP 服务 ${id}`;
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function httpList(_args: Record<string, unknown>): Promise<string> {
    if (!httpServerRef) { return "[错误] HTTP 服务未就绪（当前运行环境未装配 HttpServer）"; }
    try {
      const list = await httpServerRef.list();
      if (list.length === 0) { return "[提示] 当前没有运行中的 HTTP 静态服务（用 http_serve 启动一个）"; }
      return list.map((s) =>
        `id=${s.id} 端口=${s.port} 目录=${s.dir} 请求=${s.requests}\n${(s.urls ?? []).map((u) => `  - ${u}`).join("\n")}`,
      ).join("\n\n");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  registry.register(new Tool({
    name: "http_serve",
    description: "把本地目录变成可被访问的 HTTP 静态服务，用于快速预览网页、局域网分享文件、或托管前端构建产物。需要 dir（本地目录绝对路径）；port 可选（留空则自动从 8080 起选空闲端口）；host 可选（默认 127.0.0.1 仅本机可访问；需要局域网分享时显式传 0.0.0.0）；spa 可选（true 时未命中路径回退到 index.html，适合 React/Vue 等前端路由）。返回可直接访问的 URL 列表。",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "要对外提供服务的本地目录绝对路径" },
        port: { type: "integer", description: "监听端口（1-65535），留空=自动选空闲端口", default: 0 },
        host: { type: "string", description: "监听地址：默认 127.0.0.1（仅本机）；传 0.0.0.0 表示局域网可访问（慎用）", default: "127.0.0.1" },
        spa: { type: "boolean", description: "是否开启 SPA fallback（前端路由用），默认 false", default: false },
      },
      required: ["dir"],
    },
    executeFn: httpServe,
    permissions: ["network"],
  }));
  registry.register(new Tool({
    name: "http_stop",
    description: "停止一个正在运行的 HTTP 静态服务。需要 id（来自 http_list 返回的服务 id）。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "要停止的服务 id（http_list 返回的 id 字段）" } },
      required: ["id"],
    },
    executeFn: httpStop,
    permissions: ["network"],
  }));
  registry.register(new Tool({
    name: "http_list",
    description: "列出当前所有运行中的 HTTP 静态服务（含 id、端口、目录、访问 URL、累计请求数）。操作 HTTP 服务前先调用它拿到目标 id。",
    parameters: { type: "object", properties: {}, required: [] },
    executeFn: httpList,
    permissions: ["read"],
  }));

  

  
  function slugify(s: string): string {
    const base = (s || "").toLowerCase().trim();
    let out = base.replace(/[^a-z0-9一-龥]+/g, "-").replace(/^-+|-+$/g, "");
    if (!out) { out = "app-" + Date.now().toString(36); }
    return out.slice(0, 40);
  }

  
  function pickAppKind(description: string, title?: string): "todo" | "calculator" | "timer" | "landing" | "form" | "fallback" {
    const t = `${title ?? ""} ${description}`.toLowerCase();
    if (/(待办|任务|清单|todo|to-do|todos?|checklist|打卡)/.test(t)) { return "todo"; }
    if (/(计算器|计算|calc|calculator)/.test(t)) { return "calculator"; }
    if (/(计时|倒计时|秒表|时钟|定时器|闹钟|countdown|stopwatch|timer|clock)/.test(t)) { return "timer"; }
    if (/(落地页|展示|主页|官网|首页|介绍|产品|landing|page|homepage|about|promo)/.test(t)) { return "landing"; }
    if (/(表单|报名|登录|注册|调查|问卷|反馈|留言|signup|sign-in|login|form|survey)/.test(t)) { return "form"; }
    return "fallback";
  }

  
  function appBody(kind: string, title: string): string {
    const t = title.replace(/[<>&]/g, "");
    switch (kind) {
      case "todo":
        return `
<div class="wrap">
  <h1>${t}</h1>
  <div class="row">
    <input id="tf" placeholder="添加一项…" />
    <button id="add">添加</button>
  </div>
  <ul id="list"></ul>
  <div class="meta"><span id="cnt">0</span> 项 · <button id="clear" class="ghost">清空已完成</button></div>
</div>
<script>
var KEY='slime_todo';var list=[];try{list=JSON.parse(localStorage.getItem(KEY)||'[]')}catch(e){}
function save(){localStorage.setItem(KEY,JSON.stringify(list));render()}
function render(){var ul=document.getElementById('list');ul.innerHTML='';list.forEach(function(it,i){var li=document.createElement('li');li.className=it.done?'done':'';var cb=document.createElement('input');cb.type='checkbox';cb.checked=it.done;cb.onchange=function(){list[i].done=cb.checked;save()};var span=document.createElement('span');span.textContent=it.text;var del=document.createElement('button');del.className='ghost';del.textContent='✕';del.onclick=function(){list.splice(i,1);save()};li.appendChild(cb);li.appendChild(span);li.appendChild(del);ul.appendChild(li)});document.getElementById('cnt').textContent=list.length}
function add(){var tf=document.getElementById('tf');var v=tf.value.trim();if(!v)return;list.push({text:v,done:false});tf.value='';save()}
document.getElementById('add').onclick=add;document.getElementById('tf').onkeydown=function(e){if(e.key==='Enter')add()};document.getElementById('clear').onclick=function(){list=list.filter(function(x){return !x.done});save()};render();
</script>`;
      case "calculator":
        return `
<div class="wrap calc">
  <h1>${t}</h1>
  <input id="disp" readonly value="0" />
  <div class="grid">
    <button class="op" data-k="C">C</button><button class="op" data-k="←">←</button><button class="op" data-k="%">%</button><button class="op" data-k="/">÷</button>
    <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button><button class="op" data-k="*">×</button>
    <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button><button class="op" data-k="-">−</button>
    <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button><button class="op" data-k="+">+</button>
    <button data-k="0">0</button><button data-k=".">.</button><button class="op" data-k="=">=</button><button class="op" data-k="(">(</button>
  </div>
</div>
<script>
var d=document.getElementById('disp');var cur='0';var prev=null;var op=null;
function upd(){d.value=cur}
function compute(){try{var r=Function('return ('+prev+op+cur+')')();cur=String(Math.round(r*1e10)/1e10);prev=null;op=null}catch(e){cur='错误'}}
document.querySelectorAll('.grid button').forEach(function(b){b.onclick=function(){var k=b.dataset.k;if(k>='0'&&k<='9'||k==='.'){cur=cur==='0'?(k==='.'?'.':k):cur+k}else if(['+','-','*','/','%'].indexOf(k)>=0){if(prev!==null&&op){compute()}else{prev=cur}op=k;cur='0'}else if(k==='C'){cur='0';prev=null;op=null}else if(k==='←'){cur=cur.length>1?cur.slice(0,-1):'0'}else if(k==='='){if(prev!==null&&op)compute()}upd()}});upd();
</script>`;
      case "timer":
        return `
<div class="wrap center">
  <h1>${t}</h1>
  <div class="tabs"><button class="tab on" data-m="cd">倒计时</button><button class="tab" data-m="sw">秒表</button></div>
  <div id="cd" class="pane">
    <div class="big" id="cdt">05:00</div>
    <div class="row"><input id="mins" type="number" min="0" value="5" style="width:80px"/> 分钟</div>
    <div class="row"><button id="cdStart">开始</button><button id="cdReset" class="ghost">重置</button></div>
  </div>
  <div id="sw" class="pane" style="display:none">
    <div class="big" id="swt">00:00.0</div>
    <div class="row"><button id="swStart">开始</button><button id="swReset" class="ghost">重置</button></div>
  </div>
</div>
<script>
var tEl=document.getElementById('cdt'),mEl=document.getElementById('mins'),cdId=null,left=300;
function fmt(s){var m=Math.floor(s/60),ss=s%60;return (m<10?'0':'')+m+':'+(ss<10?'0':'')+ss}
document.getElementById('cdStart').onclick=function(){if(cdId){clearInterval(cdId);cdId=null;this.textContent='开始';return}left=Math.max(0,parseInt(mEl.value||'0',10))*60;tEl.textContent=fmt(left);cdId=setInterval(function(){if(left<=0){clearInterval(cdId);cdId=null;tEl.textContent='时间到!';return}left--;tEl.textContent=fmt(left)},1000);this.textContent='暂停'};
document.getElementById('cdReset').onclick=function(){if(cdId){clearInterval(cdId);cdId=null}left=Math.max(0,parseInt(mEl.value||'0',10))*60;tEl.textContent=fmt(left)};
var swEl=document.getElementById('swt'),swId=null,ms=0;
function sf(){var t=ms,cs=Math.floor(t/100)%10,s=Math.floor(t/1000)%60,m=Math.floor(t/60000);return (m<10?'0':'')+m+':'+(s<10?'0':'')+s+'.'+cs}
document.getElementById('swStart').onclick=function(){if(swId){clearInterval(swId);swId=null;this.textContent='开始';return}var last=Date.now();swId=setInterval(function(){ms+=Date.now()-last;last=Date.now();swEl.textContent=sf()},100);this.textContent='暂停'};
document.getElementById('swReset').onclick=function(){if(swId){clearInterval(swId);swId=null}ms=0;swEl.textContent=sf()};
document.querySelectorAll('.tab').forEach(function(b){b.onclick=function(){document.querySelectorAll('.tab').forEach(function(x){x.className='tab'});b.className='tab on';var m=b.dataset.m;document.getElementById('cd').style.display=m==='cd'?'block':'none';document.getElementById('sw').style.display=m==='sw'?'block':'none'}});
</script>`;
      case "landing":
        return `
<div class="wrap hero">
  <div class="badge">${t}</div>
  <h1>${t}</h1>
  <p class="sub">由 slime 指令驱动即时生成 · 自包含单页应用，可直接在浏览器使用。</p>
  <div class="row"><button id="cta">立即体验</button><button class="ghost" id="more">了解更多</button></div>
  <div class="feats">
    <div class="feat"><h3>极速生成</h3><p>一句话需求，自动产出可用页面。</p></div>
    <div class="feat"><h3>零依赖</h3><p>纯 HTML 内联，离线也能跑。</p></div>
    <div class="feat"><h3>自适应</h3><p>深色/浅色与移动端自动适配。</p></div>
  </div>
</div>
<script>
document.getElementById('cta').onclick=function(){alert('欢迎使用 '+document.title)};
document.getElementById('more').onclick=function(){document.querySelector('.feats').scrollIntoView({behavior:'smooth'})};
</script>`;
      case "form":
        return `
<div class="wrap">
  <h1>${t}</h1>
  <form id="f">
    <label>姓名<input name="name" required /></label>
    <label>邮箱<input name="email" type="email" required /></label>
    <label>留言<textarea name="msg" rows="3"></textarea></label>
    <button type="submit">提交</button>
  </form>
  <div id="ok" class="ok" style="display:none">✓ 已提交，感谢您的反馈！</div>
</div>
<script>
document.getElementById('f').onsubmit=function(e){e.preventDefault();var d=Object.fromEntries(new FormData(this).entries());if(!d.name||!d.email){alert('请填写姓名与邮箱');return}document.getElementById('ok').style.display='block';this.style.display='none'};
</script>`;
      default:
        return `
<div class="wrap center">
  <h1>${t}</h1>
  <p class="sub">这是一个由 slime 自动生成的通用页面。你可以在下方实时编辑内容：</p>
  <textarea id="note" rows="6" placeholder="在这里写点什么…"></textarea>
  <div class="meta">已自动保存到本地</div>
</div>
<script>
var n=document.getElementById('note');try{n.value=localStorage.getItem('slime_note')||''}catch(e){}
n.oninput=function(){try{localStorage.setItem('slime_note',n.value)}catch(e){}};
</script>`;
    }
  }

  
  function wrapApp(title: string, body: string): string {
    const t = title.replace(/[<>&"]/g, "");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t}</title>
<style>
  :root { --bg:#f5f6fa; --fg:#1f2330; --card:#ffffff; --accent:#5b6cff; --muted:#7a8194; --border:#e6e8f0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1117; --fg:#e8eaf0; --card:#181b24; --accent:#7c8bff; --muted:#9aa3b8; --border:#262a36; } }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--fg); display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
  .wrap { width:100%; max-width:560px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; box-shadow:0 10px 40px rgba(0,0,0,.08); }
  .center { text-align:center; } .hero { text-align:center; }
  h1 { margin:0 0 16px; font-size:24px; }
  .sub { color:var(--muted); margin:0 0 18px; }
  .row { display:flex; gap:10px; align-items:center; margin:10px 0; flex-wrap:wrap; }
  input, textarea, select { width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--bg); color:var(--fg); font-size:15px; }
  button { padding:10px 16px; border:none; border-radius:10px; background:var(--accent); color:#fff; font-size:15px; cursor:pointer; transition:transform .06s ease, opacity .2s; }
  button:active { transform:scale(.97); }
  button.ghost { background:transparent; color:var(--accent); border:1px solid var(--border); }
  ul { list-style:none; padding:0; margin:14px 0; }
  li { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:10px; margin-bottom:8px; }
  li span { flex:1; } li.done span { text-decoration:line-through; color:var(--muted); }
  .meta { color:var(--muted); font-size:13px; margin-top:8px; }
  .badge { display:inline-block; padding:4px 12px; border-radius:999px; background:var(--accent); color:#fff; font-size:12px; margin-bottom:12px; }
  .feats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-top:22px; }
  .feat { background:var(--bg); border:1px solid var(--border); border-radius:12px; padding:14px; text-align:left; }
  .feat h3 { margin:0 0 6px; font-size:15px; } .feat p { margin:0; color:var(--muted); font-size:13px; }
  .calc { max-width:320px; } .calc .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:14px; }
  .calc button { padding:14px 0; font-size:18px; } .calc .op { background:var(--border); color:var(--fg); }
  #disp { text-align:right; font-size:26px; margin-bottom:8px; }
  .tabs { display:flex; gap:8px; justify-content:center; margin-bottom:14px; }
  .tab { background:var(--bg); color:var(--fg); border:1px solid var(--border); }
  .tab.on { background:var(--accent); color:#fff; border-color:var(--accent); }
  .big { font-size:46px; font-weight:600; margin:10px 0 18px; font-variant-numeric:tabular-nums; }
  .ok { margin-top:14px; color:#27ae60; font-weight:600; }
  label { display:block; margin-bottom:12px; color:var(--muted); font-size:13px; } label input, label textarea { margin-top:6px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
  }

  async function httpCreateApp(args: Record<string, unknown>): Promise<string> {
    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (!description) { return "[错误] description 不能为空（用户要做的网页/应用/小工具的自然语言需求）"; }
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : description.slice(0, 20);
    const kind = pickAppKind(description, title);
    const slug = slugify(title || description);
    const root = (PROJECT_ROOT && PROJECT_ROOT.trim()) ? PROJECT_ROOT : process.cwd();
    let dir = typeof args.dir === "string" && args.dir.trim() ? args.dir.trim() : join(root, "apps", slug);
    if (!isAbsolute(dir)) { dir = join(root, dir); }
    let port: number | undefined;
    if (args.port !== undefined && args.port !== null && args.port !== "") {
      const n = Number(args.port);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) { return "[错误] port 需为 1-65535 之间的数字"; }
      port = Math.round(n);
    }
    try {
      await mkdir(dir, { recursive: true });
      


      const custom = normalizeAppFiles(args.files);
      const written: string[] = [];
      if (custom.length > 0) {
        for (const f of custom) {
          const absFile = join(dir, f.path);
          await mkdir(dirname(absFile), { recursive: true });
          await writeFile(absFile, f.content, "utf8");
          written.push(absFile);
        }
      } else {
        const html = wrapApp(title, appBody(kind, title));
        await writeFile(join(dir, "index.html"), html, "utf8");
        written.push(join(dir, "index.html"));
      }
      const filesLine = written.map((w) => `  - ${w}`).join("\n");
      
      if (!httpServerRef) {
        return `[已生成] ${title}（类型=${kind}）\n已写入文件：\n${filesLine}\n（HTTP 服务未就绪，未能自动起服务；可在本地用浏览器直接打开 index.html）`;
      }
      const r = await httpServerRef.serve({ dir, port, spa: false });
      if (!r?.ok) { return `[已生成文件] ${title}（类型=${kind}）\n已写入文件：\n${filesLine}\n（启动服务失败：${r?.error ?? "未知错误"}；可直接用浏览器打开 index.html）`; }
      const urls = (r.urls ?? []).map((u) => `  - ${u}`).join("\n");
      const localUrl = `http://127.0.0.1:${r.port}`;
      
      
      
      const opened = fireSidebarOpen({ kind: "url", url: localUrl, name: title, sessionId: sessionIdFromArgs(args) });
      return [
        `[已生成网页应用] ${title}（类型=${kind}）`,
        `已写入文件：\n${filesLine}`,
        `可访问地址（点击即可打开）：`,
        urls,
        ``,
        opened ? `已在右侧栏浏览器自动打开：${localUrl}` : `（界面未就绪，未自动打开；可点上方地址手动打开）`,
      ].join("\n");
    } catch (e) {
      return `[错误] 生成应用失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  registry.register(new Tool({
    name: "http_create_app",
    
    
    
    description:
      "做一个**本地 web 程序**并直接跑起来（写完自动在右侧栏浏览器打开，用户立刻能看到）。\n"
      + "两种用法：\n"
      + "① **自由创作（推荐）**：传 `files: [{path, content}]` 写任意多文件（HTML / CSS / JS / JSON / 子目录都行），"
      + "`path` 里必须有 `index.html` 作为入口。适合做完整的小应用（多页、带数据、带交互）。\n"
      + "② **模板快捷方式**：只传 `description`，按关键词套用内置模板（待办 / 计算器 / 计时器 / 落地页 / 表单 / 通用）。\n"
      + "**做到什么程度才算好**（别交一个裸 HTML）：\n"
      + "  - **自包含**：CSS/JS 内联或放同目录文件，**不引外网 CDN**（离线、断网也能跑）；\n"
      + "  - **能交互**：真的有状态与事件（点击 / 输入 / 计算 / 增删 / 持久化），不是一张静态图；\n"
      + "  - **像样的视觉**：主题统一、间距层级与圆角、hover/active 有反馈、内容居中且能适应窄屏；\n"
      + "  - **零构建**：不要 webpack/vite，浏览器直接跑；数据写死在 JS 里或放同目录 JSON。\n"
      + "用户说「做个网页 / 应用 / 小工具 / 页面 / 网站」时直接用本工具，不要让用户自己配置。"
      + "返回可点击地址 + **实际写入的文件清单**。",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "用户的自然语言需求（做什么、给谁用、要哪些功能）。模板模式必填" },
        title: { type: "string", description: "应用名（缺省取需求前 20 字）" },
        files: {
          type: "array",
          description: "自由创作模式：要写入的文件清单（至少含一个 index.html）。path 相对 dir，"
            + "绝对路径与 `..` 会被拒绝；content 是文件全文（可以是任意长度的真实代码）",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "相对路径，如 index.html / style.css / app.js / data/list.json" },
              content: { type: "string", description: "文件全文（HTML/CSS/JS/JSON 原样写出，不要转义）" },
            },
            required: ["path", "content"],
          },
        },
        dir: { type: "string", description: "输出目录绝对路径；缺省为 项目根/apps/<slug>/" },
        port: { type: "integer", description: "HTTP 服务端口（1-65535），留空自动选空闲端口", default: 0 },
      },
      required: [],
    },
    executeFn: httpCreateApp,
    permissions: ["network", "write"],
  }));

  











  async function sidebarOpenTerminal(args: Record<string, unknown>): Promise<string> {
    
    const prefill = typeof args.prefill === "string" ? args.prefill.trim() : "";
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!fireSidebarOpen({ kind: "terminal", cmd: prefill, name, sessionId: sessionIdFromArgs(args) })) {
      return hasSidebarOpener()
        ? "[错误] 打开终端页失败（界面拒绝了这次请求）"
        : "[错误] 右侧栏未就绪（当前运行环境未装配界面），无法打开终端页";
    }
    return prefill
      ? `[已打开] 右侧栏终端页，命令已**预填**到输入框（未执行，需用户自行回车）：${prefill}`
      : "[已打开] 右侧栏终端页";
  }

  async function sidebarOpenFiles(args: Record<string, unknown>): Promise<string> {
    const ws = String(args._workspace ?? "");
    const rawRoot = typeof args.root === "string" ? args.root.trim() : "";
    const rel = typeof args.rel === "string" ? args.rel.trim() : "";
    let root = "";
    if (rawRoot) {
      
      root = projectRootPath(rawRoot, ws);
      try {
        const st = await stat(root);
        if (!st.isDirectory()) { return `[错误] 不是目录：${root}`; }
      } catch {
        
        return `[错误] 目录不存在：${root}`;
      }
    }
    if (!fireSidebarOpen({ kind: "files", root, rel, sessionId: sessionIdFromArgs(args) })) {
      return hasSidebarOpener()
        ? "[错误] 打开文件页失败（界面拒绝了这次请求）"
        : "[错误] 右侧栏未就绪（当前运行环境未装配界面），无法打开文件树";
    }
    if (!root) {
      return rel
        ? `[已打开] 右侧栏文件页（未给 root，界面按当前会话工作目录打开；未能定位到 ${rel}）`
        : "[已打开] 右侧栏文件页（浏览根 = 当前会话工作目录）";
    }
    return rel
      ? `[已打开] 右侧栏文件页：浏览根 ${root}，并定位到 ${rel}`
      : `[已打开] 右侧栏文件页：浏览根 ${root}`;
  }

  









  async function sidebarMountRead(args: Record<string, unknown>): Promise<string> {
    const text = sidebarMountSection(sessionIdFromArgs(args));
    if (!text) {
      return "[无挂载] 右侧边栏此刻没有可读的内容（或它属于**别的会话** —— 右栏是按会话隔离的）。"
        + "不要凭空描述右栏里有什么；需要让用户看到某个东西时，用 sidebar_open_* 系列工具把它打开。";
    }
    return text;
  }

  registry.register(new Tool({
    name: "sidebar_open_terminal",
    description:
      "在**右侧栏打开终端页**，让用户看得见终端（右栏就是 Agent 的工具栏）。\n"
      + "· 可传 `prefill` 把一条命令预填在输入框里（**不会自动执行** —— 执行与否是用户的决定，"
      + "这也是本工具不需要终端权限、不会弹审批的原因）；\n"
      + "· 适合：你要用户手动看/手动跑某条命令时（如 `npm run dev`、查看日志），"
      + "或需要用户在真实终端里交互（本工具不接管终端，别指望用它拿回 stdout —— 要回显请用命令执行类工具）。\n"
      + "返回是否真的打开了；未装配界面时如实报错，不要假设它一定成功。",
    parameters: {
      type: "object",
      properties: {
        prefill: { type: "string", description: "预填到终端输入框的命令（不会自动执行），可省" },
        name: { type: "string", description: "页签标题，可省" },
      },
      required: [],
    },
    executeFn: sidebarOpenTerminal,
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));

  registry.register(new Tool({
    name: "sidebar_open_files",
    description:
      "在**右侧栏打开文件页**（文件树），把目录展示给用户看（右栏就是 Agent 的工具栏）。\n"
      + "· `root` 传目录（绝对路径，或相对当前工作目录的路径；缺省 = 当前会话工作目录）；\n"
      + "· `rel` 可选，用来在该目录下**定位/高亮**某个条目；\n"
      + "· 适合：汇报「我改了哪些文件」、让用户自己接着看/接着改，而不是把文件内容整段贴进对话。\n"
      + "目录不存在会当场报错（不会开出一个空树让用户以为这里没东西）。",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string", description: "要浏览的目录（绝对路径，或相对当前工作目录）；缺省为当前会话工作目录" },
        rel: { type: "string", description: "要在该目录下定位到的条目（相对 root），可省" },
      },
      required: [],
    },
    executeFn: sidebarOpenFiles,
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));

  registry.register(new Tool({
    name: "sidebar_mount",
    description:
      "读**右侧边栏此刻挂载的内容**（用户正在右栏看的网页 / 文件 / 终端里跑的东西）。\n"
      + "· 系统每轮已经自动附上它的**摘要**（【右侧边栏 · 实时挂载】那一段）—— "
      + "只有当你需要重新确认（长对话里摘要被挤掉了）、或者要向用户复述细节时才调本工具；\n"
      + "· 用户说「这个 / 这一页 / 它 / 帮我看看」而上下文里没有别的指代对象时，**先调它**再回答，"
      + "不要反问用户「你指的是什么」；\n"
      + "· 要读某个页面的**正文**，用它给出的地址调 web_fetch（右栏的页面地址就是普通 http(s) 地址）。\n"
      + "右栏没有挂载内容时会如实返回「无挂载」，不要凭标题猜内容。",
    parameters: { type: "object", properties: {}, required: [] },
    executeFn: sidebarMountRead,
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));

  
  async function adbPush(args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    const serial = typeof args.serial === "string" ? args.serial.trim() : "";
    const local = typeof args.local === "string" ? args.local.trim() : "";
    const remote = typeof args.remote === "string" ? args.remote.trim() : "";
    if (!local || !remote) { return "[错误] local 与 remote 都不能为空"; }
    try {
      const r = await adbServiceRef.push(serial, local, remote);
      if (!r?.ok) { return `[错误] 推送失败：${r?.error ?? r?.stderr ?? "未知错误"}`; }
      return `[已推送] ${local} → ${serial || "默认设备"}:${remote}\n${(r.stdout ?? "").trim().slice(0, 300)}`;
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function adbPull(args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    const serial = typeof args.serial === "string" ? args.serial.trim() : "";
    const local = typeof args.local === "string" ? args.local.trim() : "";
    const remote = typeof args.remote === "string" ? args.remote.trim() : "";
    if (!local || !remote) { return "[错误] local 与 remote 都不能为空"; }
    try {
      const r = await adbServiceRef.pull(serial, remote, local);
      if (!r?.ok) { return `[错误] 拉取失败：${r?.error ?? r?.stderr ?? "未知错误"}`; }
      return `[已拉取] ${serial || "默认设备"}:${remote} → ${local}\n${(r.stdout ?? "").trim().slice(0, 300)}`;
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  registry.register(new Tool({
    name: "adb_push",
    description: "把本机文件推送到 Android 设备（本机 → 设备）。需要 local（本机绝对路径）与 remote（设备上目标路径，如 /sdcard/Download/a.png）；serial 可选（多设备时指定，来自 adb_devices）。用于给设备传图片/脚本/配置。",
    parameters: {
      type: "object",
      properties: {
        serial: { type: "string", description: "可选。目标设备 serial" },
        local: { type: "string", description: "本机源文件绝对路径" },
        remote: { type: "string", description: "设备上的目标路径，如 /sdcard/Download/" },
      },
      required: ["local", "remote"],
    },
    executeFn: adbPush,
    permissions: ["write"],
    riskKind: "write",
  }));
  registry.register(new Tool({
    name: "adb_pull",
    description: "从 Android 设备拉取文件到本机（设备 → 本机）。需要 remote（设备上源路径，如 /sdcard/Download/a.png）与 local（本机目标路径）；serial 可选。用于取出截图、日志、导出的文件。",
    parameters: {
      type: "object",
      properties: {
        serial: { type: "string", description: "可选。目标设备 serial" },
        remote: { type: "string", description: "设备上的源文件路径" },
        local: { type: "string", description: "本机目标路径（目录或文件）" },
      },
      required: ["remote", "local"],
    },
    executeFn: adbPull,
    permissions: ["write"],
    riskKind: "write",
  }));

  

  async function adbUninstall(args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    const serial = typeof args.serial === "string" ? args.serial.trim() : "";
    const pkg = typeof args.pkg === "string" ? args.pkg.trim() : "";
    if (!pkg) { return "[错误] 需要 pkg（包名，如 com.example.app）。不确定包名时先用 adb_shell 跑 pm list packages 查看"; }
    if (!adbServiceRef.uninstall) { return "[错误] 当前 ADB 服务不支持卸载"; }
    try {
      const r = await adbServiceRef.uninstall(serial, pkg);
      if (!r.ok) { return `[错误] 卸载失败：${(r.error ?? r.stderr ?? "未知错误").slice(0, 300)}`; }
      return `[已卸载] ${pkg}${serial ? `（${serial}）` : ""}\n${(r.stdout ?? "").trim()}`.trim();
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function adbReboot(args: Record<string, unknown>): Promise<string> {
    if (!adbServiceRef) { return "[错误] ADB 服务未就绪（当前运行环境未装配 AdbService）"; }
    const serial = typeof args.serial === "string" ? args.serial.trim() : "";
    const mode = typeof args.mode === "string" ? args.mode.trim() : "";
    if (!adbServiceRef.reboot) { return "[错误] 当前 ADB 服务不支持重启"; }
    try {
      const r = await adbServiceRef.reboot(serial, mode || undefined);
      if (!r.ok) { return `[错误] 重启失败：${(r.error ?? r.stderr ?? "未知错误").slice(0, 300)}`; }
      return `[已发送重启指令]${serial ? ` ${serial}` : ""}${mode ? `（模式=${mode}）` : ""}——设备会断开重连，稍后用 adb_devices 复查是否回来`;
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  registry.register(new Tool({
    name: "adb_uninstall",
    description: "卸载 Android 设备上的应用（adb uninstall）。需要 pkg（包名，如 com.example.app）；serial 可选（多设备时指定，来自 adb_devices）。不确定包名时先用 adb_shell 执行 pm list packages 查询。这是**不可逆操作**，执行前请确认包名正确。",
    parameters: {
      type: "object",
      properties: {
        serial: { type: "string", description: "可选。目标设备 serial" },
        pkg: { type: "string", description: "要卸载的应用包名，如 com.example.app" },
      },
      required: ["pkg"],
    },
    executeFn: adbUninstall,
    permissions: ["write"],
    riskKind: "write",
  }));
  registry.register(new Tool({
    name: "adb_reboot",
    description: "重启 Android 设备（adb reboot）。mode 可选：留空=正常重启；也可传 recovery（恢复模式）/ bootloader（fastboot）/ sideload。serial 可选。重启后设备会短暂离线，稍后用 adb_devices 复查。",
    parameters: {
      type: "object",
      properties: {
        serial: { type: "string", description: "可选。目标设备 serial" },
        mode: { type: "string", description: "可选。重启模式：recovery / bootloader / sideload；留空为正常重启" },
      },
      required: [],
    },
    executeFn: adbReboot,
    permissions: ["write"],
    riskKind: "write",
  }));

  

  
  function pickBackend(raw: unknown): "desktop" | "android" | null {
    const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (v === "desktop" || v === "android") { return v; }
    if (v) { return null; }
    if (!screenControllerRef) { return null; }
    const list = screenControllerRef.listBackends();
    if (list.includes("desktop")) { return "desktop"; }
    if (list.includes("android")) { return "android"; }
    return null;
  }

  async function screenInfo(_args: Record<string, unknown>): Promise<string> {
    if (!screenControllerRef) { return "[错误] 图形控制未就绪（当前运行环境未装配 ScreenController）"; }
    try {
      const backends = screenControllerRef.listBackends();
      if (backends.length === 0) { return "[提示] 当前没有任何图形控制后端可用"; }
      const lines: string[] = [`可用图形控制后端：${backends.join("、")}`];
      for (const b of backends) {
        
        const rep = await screenControllerRef.listTargetsReport(b as "desktop" | "android");
        for (const f of rep.failures) {
          lines.push(`- ${f.backend}：枚举失败（${f.error}）——这是后端/宿主的问题，不是「没有目标」`);
        }
        if (rep.targets.length === 0) {
          if (rep.failures.length === 0) { lines.push(`- ${b}：无可用目标`); }
          continue;
        }
        for (const t of rep.targets) {
          lines.push(`- ${b}｜目标=${t.target}｜${t.label}`);
        }
      }
      lines.push("");
      lines.push("**坐标约定（重要）**：screen_action 的 x/y 默认是你**所见截图图像**的像素坐标（左上为 0,0），");
      lines.push("直接对着截图量像素填即可，无需做任何换算——系统会自动折算到设备真实分辨率。");
      lines.push("截图默认已叠加 10×10 刻度网格（含百分比标签），对着刻度读数可显著提升准确度。");
      lines.push("**最稳的点击方式**：安卓设备先调 screen_ui_dump 拿到元素列表 → 用 screen_action 的 selector.index（或 text/id）直接点元素，避免目测坐标。");
      return lines.join("\n");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function screenCapture(args: Record<string, unknown>): Promise<string> {
    if (!screenControllerRef) { return "[错误] 图形控制未就绪（当前运行环境未装配 ScreenController）"; }
    const backend = pickBackend(args.backend);
    if (!backend) { return "[错误] backend 需为 desktop 或 android（见 screen_info 列出的可用后端）"; }
    const target = typeof args.target === "string" ? args.target.trim() : "";
    const marks = args.marks !== false; 
    
    const winTitle = typeof args.window === "string" ? args.window.trim() : "";
    try {
      const r = winTitle
        ? await screenControllerRef.captureWindow(backend, winTitle, { marks })
        : await screenControllerRef.capture(backend, target || undefined, { marks });
      if (!r.ok) { return `[错误] 截屏失败（${backend}${winTitle ? `｜窗口「${winTitle}」` : ""}）：${r.error ?? "未知错误"}`; }
      const imgSize = r.imageWidth && r.imageHeight ? `${r.imageWidth}×${r.imageHeight}` : "未知";
      const devSize = r.width && r.height ? `${r.width}×${r.height}` : "未知";
      const kb = r.bytes ? `${Math.round(r.bytes / 1024)}KB` : "大小未知";
      const parts = [
        `[已截屏] ${backend}${target ? `｜${target}` : ""}${winTitle ? `｜窗口「${winTitle}」` : ""}`,
        `你看到的图像尺寸：${imgSize}（**screen_action 坐标以这个为准，直接量像素**）`,
        winTitle
          ? `窗口屏幕位置：(${r.originX ?? 0},${r.originY ?? 0})，窗口尺寸 ${devSize}（系统自动加偏移，你不用管）`
          : `设备真实分辨率：${devSize}（系统自动折算，你不用管）`,
        `图像大小：${kb}`,
      ];
      if (r.annotate) {
        const bits: string[] = [];
        if (r.annotate.grid) { bits.push("10×10 刻度网格（含百分比标签）"); }
        if (r.annotate.marks > 0) { bits.push(`${r.annotate.marks} 个可点元素编号框（① ② ③…）`); }
        if (bits.length > 0) { parts.push(`已叠加标注：${bits.join(" + ")}`); }
      }
      
      
      if (r.warning) { parts.push(`⚠️ ${r.warning}`); }
      parts.push(r.annotate?.marks ? "提示：优先用「编号框」或 screen_ui_dump + selector 点击，比目测坐标更准。" : "提示：对着网格刻度读数确定坐标。");
      if (r.dataUrl) { parts.push(`@@IMG@@${r.dataUrl}`); }
      return parts.join("\n");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  


  async function screenUiDump(args: Record<string, unknown>): Promise<string> {
    if (!screenControllerRef) { return "[错误] 图形控制未就绪（当前运行环境未装配 ScreenController）"; }
    const backend = pickBackend(args.backend);
    if (!backend) { return "[错误] backend 需为 desktop 或 android"; }
    const target = typeof args.target === "string" ? args.target.trim() : "";
    const max = typeof args.limit === "number" && args.limit > 0 ? Math.min(200, args.limit) : 60;
    try {
      const dump = await screenControllerRef.uiDump(backend, target || undefined);
      
      
      if (!dump.ok) {
        return `[错误] 元素层级导出失败（${dump.error ?? "未知原因"}）——这是后端/宿主的故障，不是「界面没有元素」。请检查设备连接/宿主是否存活后重试；其间可用 screen_capture 网格刻度目测定位。`;
      }
      const els = dump.elements;
      if (els.length === 0) {
        return backend === "desktop"
          ? "[提示] 元素层级已导出成功，但当前桌面没有可见的顶层窗口（都可能已最小化或无标题）。若你确信某程序已打开，请先手动把它的窗口还原出来。"
          : "[提示] 元素层级已导出成功，但当前界面没有可操作元素（全屏画布/游戏/页面仍在加载都会这样）。请改用 screen_capture 的网格刻度目测定位。";
      }
      
      const actionable = els.filter((e) => e.clickable || e.scrollable || e.text).slice(0, max);
      const lines: string[] = [
        backend === "desktop"
          ? `[界面元素] 桌面的元素层级粒度是「窗口」（共 ${els.length} 个可见顶层窗口，下列 ${actionable.length} 个）。用法：screen_action({kind:"click", selector:{index:N}}) 点窗口中心（通常等于把它带到前台）；窗口内的按钮仍需截图目测或用 screen_focus 聚焦后按窗口坐标点。`
          : `[界面元素] 共解析 ${els.length} 个节点，下列为可操作项（${actionable.length} 个）：`,
        "用法：screen_action({kind:\"click\", selector:{index:N}})，或用 text/id 精确定位（比手填坐标稳）。",
      ];
      for (const e of actionable) {
        const tags: string[] = [];
        if (e.clickable) { tags.push("可点"); }
        if (e.scrollable) { tags.push("可滚"); }
        if (e.enabled === false) { tags.push("禁用"); }
        const label = e.text ? `「${e.text}」` : e.desc ? `desc=${e.desc}` : e.id ? `id=${e.id}` : "(无文本)";
        lines.push(`#${e.index} ${label}${tags.length ? ` [${tags.join("/")}]` : ""} 中心=(${e.center.x},${e.center.y}) 框=[${e.bounds.x1},${e.bounds.y1}][${e.bounds.x2},${e.bounds.y2}]`);
      }
      return lines.join("\n");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function screenAction(args: Record<string, unknown>): Promise<string> {
    if (!screenControllerRef) { return "[错误] 图形控制未就绪（当前运行环境未装配 ScreenController）"; }
    const backend = pickBackend(args.backend);
    if (!backend) { return "[错误] backend 需为 desktop 或 android（见 screen_info 列出的可用后端）"; }
    const kind = typeof args.kind === "string" ? args.kind.trim() : "";
    if (!kind) { return "[错误] 缺少 kind（动作类型）"; }
    const target = typeof args.target === "string" ? args.target.trim() : "";
    const num = (v: unknown): number | undefined => {
      if (v === undefined || v === null || v === "") { return undefined; }
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    
    const csRaw = typeof args.coordSpace === "string" ? args.coordSpace.trim().toLowerCase() : "";
    const coordSpace = (csRaw === "normalized" || csRaw === "device" || csRaw === "image") ? csRaw : undefined;
    
    const selRaw = args.selector && typeof args.selector === "object" ? args.selector as Record<string, unknown> : null;
    const selector = selRaw ? {
      index: num(selRaw.index),
      id: typeof selRaw.id === "string" ? selRaw.id : undefined,
      text: typeof selRaw.text === "string" ? selRaw.text : undefined,
      desc: typeof selRaw.desc === "string" ? selRaw.desc : undefined,
    } : undefined;
    const action: ScreenAction = {
      kind: kind as ScreenActionKind,
      x: num(args.x),
      y: num(args.y),
      x2: num(args.x2),
      y2: num(args.y2),
      text: typeof args.text === "string" ? args.text : undefined,
      key: typeof args.key === "string" ? args.key : undefined,
      delta: num(args.delta),
      durationMs: num(args.durationMs),
      absolute: args.absolute === true,
      coordSpace,
      selector,
    };
    try {
      const r = await screenControllerRef.perform(backend, action, target || undefined);
      if (!r.ok) { return `[错误] 图形动作失败（${backend}/${kind}）：${r.error ?? "未知错误"}`; }
      const parts = [`[已执行] ${backend}｜${kind}｜${r.detail ?? "完成"}`];
      
      
      if (r.verify) { parts.push(describeVerify(r.verify)); }
      if (r.capture?.ok && r.capture.dataUrl) {
        const sz = r.capture.imageWidth && r.capture.imageHeight ? `${r.capture.imageWidth}×${r.capture.imageHeight}` : "尺寸未知";
        parts.push(`操作后画面已回传（${sz}）`);
        parts.push(`@@IMG@@${r.capture.dataUrl}`);
      } else if (r.capture && !r.capture.ok) {
        parts.push(`（操作后截图失败：${r.capture.error ?? "未知"}）`);
      }
      return parts.join("\n");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  registry.register(new Tool({
    name: "screen_info",
    description: "查询当前可用的图形控制目标与屏幕参数（桌面主显示器 / 已连接的安卓设备），返回后端名、目标标识、分辨率。**执行任何图形操作前先调用它**，确认可用后端与坐标基准。也用于判断是控制本机桌面还是控制安卓设备。",
    parameters: { type: "object", properties: {}, required: [] },
    executeFn: screenInfo,
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));
  registry.register(new Tool({
    name: "screen_capture",
    description: "截取屏幕画面并把图像回传给你（你可以直接看到画面内容）。backend 可选 desktop（本机桌面）/ android（安卓设备）；target 可选（安卓传设备 serial）。**桌面想只截某个窗口时传 window（窗口标题片段）**——会先把该窗口带到前台再截，画面更聚焦、元素更大更准。截图默认已叠加 10×10 刻度网格与可点元素编号框。**图形操作前必须先截图确认当前画面**。",
    parameters: {
      type: "object",
      properties: {
        backend: { type: "string", description: "desktop 或 android；留空则桌面优先" },
        target: { type: "string", description: "可选。安卓设备 serial（来自 screen_info / adb_devices）" },
        window: { type: "string", description: "可选（仅桌面）。只截标题包含该文字的窗口；配合 screen_windows 查看可用标题" },
        marks: { type: "boolean", description: "是否叠加刻度网格与元素编号标注（默认 true；想看清原始画面可传 false）" },
      },
      required: [],
    },
    executeFn: screenCapture,
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));
  registry.register(new Tool({
    name: "screen_ui_dump",
    description: [
      "导出当前界面的**元素层级**——返回可点/可滚/有文本的元素列表，每个带编号、文本、id、中心坐标、包围盒。",
      "**android（粒度：控件）**：走 uiautomator dump，能拿到按钮级元素 —— **这是安卓上最可靠的定位方式**：拿 #编号 用 screen_action 的 selector:{index:N} 点击，或按 text/id 定位，比目测坐标准得多。",
      "**desktop（粒度：窗口）**：返回系统枚举的可见顶层窗口矩形 —— 用 selector:{index:N} 点窗口中心通常等于把它带到前台。窗口**内部**的按钮没有元素树，需先 screen_focus 聚焦，再按窗口坐标目测点。",
      "适用（android）：原生界面、设置页、列表、按钮。不适用：全屏游戏/画布/视频（无元素树）——那时请用 screen_capture 的网格刻度目测。",
      "元素太多时可传 limit 限制条数（默认 60）。若目标元素不在列表里，先 screen_action 下滑/swipe 再重新 dump。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        backend: { type: "string", description: "desktop 或 android；留空则桌面优先（desktop）" },
        target: { type: "string", description: "可选。安卓设备 serial" },
        limit: { type: "integer", description: "最多返回多少个元素（默认 60，最大 200）" },
      },
      required: [],
    },
    executeFn: screenUiDump,
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));
  registry.register(new Tool({
    name: "screen_action",
    description: [
      "在本机桌面或安卓设备上执行图形操作（鼠标/键盘/触摸），执行后自动把操作后的画面回传给你。",
      "**【最推荐】元素定位**：安卓先 screen_ui_dump 拿到元素编号 → 传 selector:{index:5}（或 selector:{text:\"登录\"} / {id:\"com.x:id/btn\"}）→ 直接点元素中心，最准。",
      "**坐标定位**：x/y 默认是你**所见截图图像的像素坐标**（左上 0,0，直接对着图量，勿做换算）。也可传 coordSpace:\"normalized\"（0-1000）或 \"device\"（物理像素）。",
      "**A-1014：image 坐标必须建立在「最近一次截图」之上**——本后端还没有截图记录时会**直接报错「坐标基准缺失」**（不再猜比例）。所以按坐标操作前先 screen_capture；若你给的本来就是物理像素，请显式传 coordSpace:\"device\"。",
      "支持的动作 kind：",
      "  click / tap（点按，需 selector 或 x,y）",
      "  double_click（双击）／long_press（长按，可选 durationMs）",
      "  right_click / middle_click（仅桌面）／mouse_move（仅移动指针，仅桌面）",
      "  drag / swipe（需起点 x,y 与终点 x2,y2）／scroll（需 x,y 与 delta：正=向上，负=向下）",
      "  type（键入文本，需 text；**安卓仅支持英文数字**，中文需设备装 ADBKeyboard）",
      "  key（按键，需 key，如 \"Enter\" / \"ctrl+c\" / \"BACK\" / \"KEYCODE_HOME\"）",
      "  wait（等待，需 durationMs，最多 30000）",
      "**A-1123 命中校验**：点击 / 按键 / 输入 / 滚动这类动作执行后，系统会自动比对**动作前后两张截图**，在回执里给出「命中校验：✓ 命中 / ✗ 未命中 / 未判定」；**判定未命中时会自动重试一次**。看到「✗ 未命中」不要立刻重复同一坐标 —— 常见原因是目标被遮挡 / 窗口没聚焦 / 元素还没渲染出来，先重新 screen_capture 看清当前画面。",
      "**标准流程**：screen_capture 看画面 → screen_ui_dump 拿元素（安卓控件级 / 桌面窗口级）→ screen_action（selector 或坐标）→ 看回执里的**命中校验**与画面核对是否生效；若没点中，重新截图再试，不要盲目重试同一坐标。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        backend: { type: "string", description: "desktop 或 android；留空则桌面优先" },
        target: { type: "string", description: "可选。安卓设备 serial" },
        kind: { type: "string", description: "动作类型：click/tap/double_click/right_click/middle_click/long_press/mouse_move/drag/swipe/scroll/type/key/wait" },
        selector: {
          type: "object",
          description: "元素定位（推荐）：{index?:编号, id?:resource-id, text?:文本, desc?:描述}；提供时忽略 x/y",
          properties: {
            index: { type: "integer", description: "screen_ui_dump 列表里的编号" },
            id: { type: "string", description: "resource-id" },
            text: { type: "string", description: "可见文本" },
            desc: { type: "string", description: "content-desc 无障碍描述" },
          },
        },
        x: { type: "number", description: "X 坐标（默认=所见图像像素）" },
        y: { type: "number", description: "Y 坐标（默认=所见图像像素）" },
        x2: { type: "number", description: "终点 X（drag / swipe 用）" },
        y2: { type: "number", description: "终点 Y（drag / swipe 用）" },
        text: { type: "string", description: "要键入的文本（type 用）" },
        key: { type: "string", description: "按键名（key 用），如 Enter / ctrl+c / BACK" },
        delta: { type: "number", description: "滚动量（scroll 用）：正=向上，负=向下" },
        durationMs: { type: "number", description: "时长毫秒（long_press / swipe / drag / wait）" },
        coordSpace: { type: "string", description: "坐标语义：image（默认，所见图像像素，需先截图）／ normalized（0-1000，需先截图）／ device（物理像素，无需截图基准）" },
        absolute: { type: "boolean", description: "历史字段：true 等价 coordSpace=device" },
      },
      required: ["kind"],
    },
    executeFn: screenAction,
    permissions: ["write"],
    riskKind: "write",
  }));

  

  async function screenWindows(args: Record<string, unknown>): Promise<string> {
    if (!screenControllerRef) { return "[错误] 图形控制未就绪"; }
    const backend = pickBackend(args.backend);
    if (!backend) { return "[错误] backend 需为 desktop 或 android"; }
    try {
      const list = await screenControllerRef.listWindows(backend);
      




      if (list.length === 0) {
        return backend === "android"
          ? "[提示] 窗口枚举仅支持桌面（desktop）后端。"
          : "[提示] 枚举成功：当前**没有**可见的顶层窗口（可能都已最小化或无标题）。这不是故障。"
            + "若你确信某程序已打开，请先手动把它的窗口还原出来，再调用本工具或 screen_capture。";
      }
      const lines = [`[桌面窗口] 共 ${list.length} 个（标题｜矩形 x,y,w,h｜pid）`];
      for (const w of list.slice(0, 40)) {
        lines.push(`- ${w.title}｜(${w.x},${w.y},${w.width},${w.height})｜pid=${w.pid}`);
      }
      lines.push("用法：screen_focus({title:\"记事本\"}) 先把目标窗口带到前台，再截图定位点击。");
      return lines.join("\n");
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function screenFocus(args: Record<string, unknown>): Promise<string> {
    if (!screenControllerRef) { return "[错误] 图形控制未就绪"; }
    const backend = pickBackend(args.backend);
    if (!backend) { return "[错误] backend 需为 desktop 或 android"; }
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) { return "[错误] 需要 title（窗口标题的片段即可）"; }
    try {
      const r = await screenControllerRef.focusWindow(backend, title);
      const rect = r.rect ? `矩形(${r.rect.x},${r.rect.y},${r.rect.width},${r.rect.height})` : "";
      
      
      
      if (!r.focused) {
        return [
          `[未获得前台] ${r.detail}`,
          rect ? `窗口位置：${rect}（可用它按窗口截图或直接换算坐标）` : "",
          "可先 screen_windows 确认标题；若窗口可见只是没被激活，可直接 screen_capture 传 window 试试区域截图。",
        ].filter(Boolean).join("\n");
      }
      return `[已聚焦] ${r.detail} ${rect}\n提示：接着 screen_capture 看图（网格刻度）→ screen_action 点击。`;
    } catch (e) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  registry.register(new Tool({
    name: "screen_windows",
    description: "列出本机桌面上当前可见的窗口（标题 / 矩形 / 进程 id）。用于：确认目标程序是否已打开、获取窗口位置，然后 screen_focus 把它带到前台再操作。仅 Windows 桌面有效。",
    parameters: { type: "object", properties: {}, required: [] },
    executeFn: screenWindows,
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));
  registry.register(new Tool({
    name: "screen_focus",
    description: "把标题包含指定文字的本机窗口带到前台（最小化会自动还原），返回它的矩形。**在任何桌面点击前，建议先把目标窗口聚焦**，避免点到被遮挡/后台的窗口上。",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "窗口标题片段（包含匹配，不区分大小写）" } },
      required: ["title"],
    },
    executeFn: screenFocus,
    permissions: ["write"],
    riskKind: "write",
  }));

  
  registerBrowserTools(registry);
}