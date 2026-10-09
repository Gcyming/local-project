import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * A-1197 · B6（D1 开发者模式）：「主干可改」的**有闸**形态（设计 §5.1 的 D1 表）。
 *
 * ## 用户原话的正确译法
 * 「主干别坏就行」= 允许改，但**改的产物**必须先经过「能跑 QA + 能被评审 + 能一键回退」
 * 才谈合进主干 —— 而不是「把 core-ts 从受保护清单里摘掉」。两者的区别就是**有闸**和**没闸**。
 *
 * ## 本模块落的是哪几道闸
 * 1. **会话寿命**：`enabled` 只存**内存** —— 每次启动都要用户重新确认（授权必须有会话寿命）。
 *    打开时写 `config/dev-mode.json` 留**审计痕迹**（上次开启时间），启动时**不**自动恢复。
 * 2. **worktree 强制**：放行的写入目标必须是「**在某一个 git worktree 工作树内**」且
 *    该 worktree 的 HEAD 指向 **`slime/*` 前缀分支** —— 主工作目录（哪怕 D1 开着）**永远不放行**。
 *    判据全是**纯文件操作**（worktree 的 `.git` 是**文件**（`gitdir: …`），主仓的是目录），
 *    不 spawn git —— 可测、无副作用。
 * 3. **产物停在分支**（合并/commit 门禁属 `git_*` 工具层，见 AGENTS.md §8；本模块不碰）。
 *
 * ## 明确不做（设计 §5.1 的「D1 明确不做」）
 * - 不做自动 revert；不做「扩展自动 commit」；不做「主干上直接改」；不降低任何门禁标准。
 */

/** 会话级状态（内存）：**每次启动默认关** —— 这就是「每次启动都要重新确认」。 */
let enabled = false;

/** 最近一次开启的时间戳（给 UI 显示「上次开启于 …（本次需重新确认）」）。 */
let lastConfirmedAt: number | null = null;

export function isDevModeEnabled(): boolean {
  return enabled;
}

export function getDevModeState(): { enabled: boolean; lastConfirmedAt: number | null } {
  return { enabled, lastConfirmedAt };
}

/**
 * 切换开发者模式。
 * ⚠️ `on = true` 时写审计文件（`config/dev-mode.json`）—— **写失败如实抛**：
 * 「用户以为开了其实没开」与「以为关了其实开着」是这类开关最危险的两种失效形态。
 */
export function setDevModeEnabled(on: boolean, configDir: string): void {
  enabled = on === true;
  if (!enabled) {
    return;
  }
  lastConfirmedAt = Date.now();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "dev-mode.json"),
    `${JSON.stringify({ enabled: true, since: lastConfirmedAt, note: "每次启动需重新确认（本文件仅为审计痕迹，不参与自动恢复）" }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * D1 的**写入门**：目标是否落在「`slime/*` 分支的受管 worktree」内。
 *
 * 判据（全文件系统层，不 spawn git）：
 *   ① 目标**不得**在主工作目录内（`workspaceRoot` 下）—— 主干永远不放行；
 *   ② 从目标向上找 `.git`：命中**文件**（`gitdir: …`）⇒ 是 worktree 工作树；
 *      命中**目录** ⇒ 主仓（不是 worktree）⇒ 拒；
 *   ③ 读 worktree 的 HEAD：必须是 `ref: refs/heads/slime/…`（分支前缀硬约束，
 *      `main` / `release/*` / 任意其他分支一律拒）。
 */
export function devModeWriteAllowed(target: string, workspaceRoot: string): boolean {
  try {
    if (!target || !workspaceRoot) { return false; }
    const abs = resolve(target);
    const root = resolve(workspaceRoot);
    const norm = root.endsWith(sep) ? root : root + sep;
    /* ① 主干目录永远不放行（哪怕 D1 开着）。 */
    if (abs === root || abs.startsWith(norm)) { return false; }

    /* ② 向上找 worktree 根（限 24 层，防病态路径）。 */
    let dir = existsSync(abs) && statSync(abs).isFile() ? dirname(abs) : abs;
    for (let i = 0; i < 24; i++) {
      const g = join(dir, ".git");
      if (existsSync(g)) {
        if (!statSync(g).isFile()) { return false; }          // 主仓（.git 是目录）⇒ 不是 worktree
        const first = (readFileSync(g, "utf8").split("\n")[0] ?? "").trim();
        const m = /^gitdir:\s*(.+)$/.exec(first);
        if (!m) { return false; }
        const gitdir = resolve(dir, m[1].trim());
        const headPath = join(gitdir, "HEAD");
        if (!existsSync(headPath)) { return false; }
        const head = readFileSync(headPath, "utf8").trim();
        /* ③ 分支前缀硬约束：只认 slime/…（main / release/* / 其他一律拒）。 */
        return /^ref:\s*refs\/heads\/slime\//.test(head);
      }
      const parent = dirname(dir);
      if (parent === dir) { break; }
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}
