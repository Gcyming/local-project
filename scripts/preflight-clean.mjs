#!/usr/bin/env node
/**
 * scripts/preflight-clean.mjs — 打包前预检：结束所有可能与 release 产物冲突的 Slime 进程。
 *
 * 背景：Electron 多进程架构下，关闭主窗口不等于进程退出。主进程/渲染进程/后端 python
 * 可能驻留并锁住 win-unpacked/resources/app.asar 等文件句柄，导致 electron-builder
 * EBUSY 失败。本脚本在打包前自动清理，避免每次手动重启/换输出目录。
 *
 * 仅结束与 Slime 产品高度相关的进程（安装版、win-unpacked 解包版、llama 后端、后端 python），
 * 绝不碰无关进程（node/其他应用）。
 */

import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync, rmSync } from "node:fs";
import { resolve, parse } from "node:path";

const genNow = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
const log = (msg) => console.info(`[preflight-clean ${genNow()}] ${msg}`);

/** `_tmp_<pid>_<32位hex>` —— Node 进程原子写的临时名（写成功即 rename 走，被打断就残留）。 */
const TMP_SHELL_RE = /^_tmp_\d+_[0-9a-f]{32}$/i;

/** 递归求目录/文件总字节数（用于"只删空壳"的判定） */
function sizeOf(p) {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) { return st.size; }
    let total = 0;
    for (const name of readdirSync(p)) { total += sizeOf(resolve(p, name)); }
    return total;
  } catch {
    return Number.POSITIVE_INFINITY; // 读不了就当"有内容"，保守不删
  }
}

/**
 * 清理 `_tmp_<pid>_<hex>` 空壳残留。
 *
 * 背景：Agent 侧工具链的原子写（写临时文件 → rename）在进程被强杀（如命令超时 SIGTERM、
 * 构建被中断）时会留下 0 字节壳；它们会散落在「工作目录」与「工作目录所在盘根」两处。
 *
 * 安全策略（宁漏勿误）：**只删严格匹配命名 且 总占用为 0 字节** 的条目；
 * 有任何内容残留一律跳过并打印，交给人工判断。
 * 默认 dry-run 之外的真正删除需显式 --sweep-tmp 开关（避免误伤）。
 */
function sweepTempShells({ dry }) {
  const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const driveRoot = parse(projectRoot).root; // 例如 D:\
  const roots = [...new Set([projectRoot, driveRoot])];
  let removed = 0;
  let skipped = 0;

  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries) {
      if (!TMP_SHELL_RE.test(name)) { continue; }
      const full = resolve(root, name);
      const bytes = sizeOf(full);
      if (bytes !== 0) {
        skipped++;
        log(`跳过(非空 ${bytes} 字节，请人工确认): ${full}`);
        continue;
      }
      if (dry) {
        log(`[dry-run] 待删空壳: ${full}`);
        removed++;
        continue;
      }
      try {
        rmSync(full, { recursive: true, force: true });
        removed++;
      } catch (e) {
        skipped++;
        log(`删除失败(跳过): ${full} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  log(`临时空壳清理：${dry ? "待删" : "已删"} ${removed} 项，跳过 ${skipped} 项`);
  return { removed, skipped };
}

function listCandidatePids() {
  // 通过 PowerShell 枚举进程，返回 [{ pid, name, path }]
  const ps = [
    "powershell", "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | " +
    "Select-Object ProcessId, Name, ExecutablePath | ConvertTo-Json -Compress",
  ];
  const res = spawnSync(ps[0], ps.slice(1), { encoding: "utf8", timeout: 20000 });
  if (res.status !== 0) {
    log(`枚举进程失败: ${(res.stderr || "").trim().slice(0, 200)}`);
    return [];
  }
  let list = [];
  try {
    const parsed = JSON.parse(res.stdout);
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    log("解析进程列表失败，跳过预检");
    return [];
  }

  // 与 Slime 产物/后端相关的判定规则（大小写不敏感，宁缺毋滥）
  const isSlimeRelated = (p) => {
    const path = (p.ExecutablePath || "").toLowerCase();
    const name = (p.Name || "").toLowerCase();
    return (
      name === "slime.exe" ||                            // Slime 主程序（安装版/解包版同名）
      path.includes("programs\\slime") ||                // 安装版：%LOCALAPPDATA%\Programs\Slime\
      path.includes("win-unpacked") ||                   // 解包版：release*/win-unpacked
      (name === "python.exe" && path.includes("slime")) // 后端 venv：Programs\Slime\runtime\venv
    );
  };

  return list.filter(isSlimeRelated).map((p) => ({
    pid: p.ProcessId,
    name: p.Name,
    path: p.ExecutablePath,
  }));
}

function killTree(pids) {
  let killed = 0;
  for (const p of pids) {
    try {
      // /T 结束进程树（含子进程），/F 强制；stdout/stderr 静默
      execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: "ignore" });
      log(`已结束: [${p.pid}] ${p.name} (${p.path})`);
      killed++;
    } catch {
      // 进程可能已在此时自行退出，忽略
      log(`跳过(已退出或无权限): [${p.pid}] ${p.name}`);
    }
  }
  return killed;
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const sweepOnly = process.argv.includes("--sweep-tmp-only");
  // 临时空壳清理：默认只在 dry-run 时报告；真实删除需显式 --sweep-tmp（防误伤）
  if (dry || process.argv.includes("--sweep-tmp") || sweepOnly) {
    sweepTempShells({ dry: dry && !process.argv.includes("--sweep-tmp") && !sweepOnly });
  }
  // 只扫临时文件时不动进程（避免误杀正在运行的 Slime 实例）
  if (sweepOnly) {
    log("--sweep-tmp-only：跳过进程清理");
    return;
  }
  const pids = listCandidatePids();
  if (pids.length === 0) {
    log("未发现运行的 Slime 相关进程，无需清理");
    return;
  }
  log(`发现 ${pids.length} 个 Slime 相关进程:`);
  for (const p of pids) {
    log(`  - [${p.pid}] ${p.name} (${p.path.split("\\").pop()})`);
  }
  if (dry) {
    log("dry-run 模式：仅报告，不结束任何进程");
    return;
  }
  const killed = killTree(pids);
  log(`共结束 ${killed} 个进程`);

  // 等待句柄释放（Windows 延迟释放），最多 10 秒
  const { setTimeout: sleep } = await import("node:timers/promises");
  for (let i = 1; i <= 10; i++) {
    const remain = listCandidatePids();
    if (remain.length === 0) break;
    await sleep(1000);
  }
  log("预检清理完成，可以安全打包");
}

main().catch((e) => {
  console.error("[preflight-clean] 失败:", e);
  process.exit(1);
});