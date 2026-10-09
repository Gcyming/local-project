/**
 * A-1197 · B6（D1 开发者模式）：「主干可改」的**闸**是否都在。
 *
 * 设计口径（§5.1 D1 表）：
 *   · 开关**关** ⇒ 受保护判定照旧（注入点根本不生效）；
 *   · 开关**开** + 目标在**主工作目录** ⇒ 仍拒（worktree 强制）；
 *   · 开关**开** + 目标在**非 `slime/*` 分支**的 worktree ⇒ 拒（`main` 上写入被拒的等价形态）；
 *   · 开关**开** + 目标在**受管 worktree（`slime/*`）** ⇒ 放行（这是「改主干」的正确形态）；
 *   · **会话寿命**：启动后默认关（每次启动都要用户重新确认）。
 *
 * 判据全在文件系统层（不 spawn git）：临时目录里造出「worktree 的 `.git` 是文件（`gitdir: …`）」
 * 的真实结构，行为断言直接打真靶。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { isDevModeEnabled, setDevModeEnabled, devModeWriteAllowed, getDevModeState } from "../../core-ts/src/plugin/dev-mode.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");

let base = "";
/** 主工作目录（与 worktree **兄弟**——真实形态：worktree 不在主工作目录内）。 */
let mainWs = "";
/** 造一个「受管 worktree」：`<base>/wt` 里 `.git` 是**文件**（gitdir 指向主仓的 worktrees/<n>），
 *  主仓侧 `worktrees/<n>/HEAD` 决定分支。 */
function makeWorktree(branch: string): string {
  const wt = join(base, `wt-${branch.replace(/\//g, "-")}`);
  const mainGit = join(base, "main-repo", ".git");
  const gitdir = join(mainGit, "worktrees", "w1");
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`, "utf8");
  writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`, "utf8");
  mkdirSync(join(wt, "core-ts", "src"), { recursive: true });
  writeFileSync(join(wt, "core-ts", "src", "x.ts"), "export const x = 1;\n", "utf8");
  return wt;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "slime-dev-"));
  mainWs = join(base, "main-workspace");
  mkdirSync(mainWs, { recursive: true });
  /* 每个用例先把开关复位（模块级内存状态跨用例共享 —— 显式复位，防串味）。 */
  setDevModeEnabled(false, join(base, "cfg"));
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe("A-1198-D ① 写入门：受管 worktree（slime/*）才放行", () => {
  it("目标在 `slime/*` 分支的 worktree ⇒ 放行；主工作目录 / 其他分支 / 非 worktree ⇒ 拒", () => {
    const ok = makeWorktree("slime/dev/feat-x");
    expect(devModeWriteAllowed(join(ok, "core-ts", "src", "x.ts"), mainWs)).toBe(true);

    /* 主工作目录内：永远不放行（worktree 强制）。 */
    mkdirSync(join(mainWs, "core-ts"), { recursive: true });
    writeFileSync(join(mainWs, "core-ts", "y.ts"), "", "utf8");
    expect(devModeWriteAllowed(join(mainWs, "core-ts", "y.ts"), mainWs)).toBe(false);

    /* 非 slime/* 分支的 worktree（main / release）⇒ 拒 —— 「main 上写入被拒」的等价形态。 */
    const mainWt = makeWorktree("main");
    expect(devModeWriteAllowed(join(mainWt, "core-ts", "src", "x.ts"), mainWs)).toBe(false);
    const relWt = makeWorktree("release/v1");
    expect(devModeWriteAllowed(join(relWt, "core-ts", "src", "x.ts"), mainWs)).toBe(false);

    /* 普通目录（无 .git）⇒ 拒（不认「随便一个目录」）。 */
    const plain = join(base, "plain");
    mkdirSync(plain, { recursive: true });
    expect(devModeWriteAllowed(join(plain, "x.ts"), mainWs)).toBe(false);
  });

  it("主仓（`.git` 是**目录**）即使路径形态像 worktree 也拒（只认 worktree 工作树）", () => {
    const repo = join(base, "repo2");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "core-ts"), { recursive: true });
    expect(devModeWriteAllowed(join(repo, "core-ts", "x.ts"), mainWs)).toBe(false);
  });

  it("⚠️ 主工作目录**本身就是** slime/* worktree 时仍拒（主干不放行的边界——① 检查不可缺）", () => {
    /* 边界形态：workspaceRoot 与目标同在一个 slime/* worktree 里 —— 若没有
       「主干目录先短路」的 ① 检查，这条会被放行（主干可改的越界形态）。 */
    const wtAsMain = makeWorktree("slime/dev/main-like");
    expect(devModeWriteAllowed(join(wtAsMain, "core-ts", "src", "x.ts"), wtAsMain)).toBe(false);
  });
});

describe("A-1198-D ② 会话寿命与接线形状", () => {
  it("开关默认关；开/关切换即时生效；审计文件只在「开」时写", () => {
    expect(isDevModeEnabled()).toBe(false);
    setDevModeEnabled(true, join(base, "cfg"));
    expect(isDevModeEnabled()).toBe(true);
    const audit = JSON.parse(readFileSync(join(base, "cfg", "dev-mode.json"), "utf8")) as { enabled: boolean };
    expect(audit.enabled).toBe(true);
    setDevModeEnabled(false, join(base, "cfg"));
    expect(isDevModeEnabled()).toBe(false);
    /* 关闭后审计文件保留（记录历史），但状态已回归 —— 且不会自动恢复（启动语义在模块注释里）。 */
    expect(getDevModeState().enabled).toBe(false);
  });

  it("sandbox 的接入：D1 分支在「工作目录外」判定**之前**，且以 isDevModeEnabled 为闸", () => {
    const sandbox = read("core-ts/src/sandbox.ts");
    expect(sandbox).toContain("import { isDevModeEnabled, devModeWriteAllowed } from \"./plugin/dev-mode.js\"");
    const idxD1 = sandbox.indexOf("isDevModeEnabled() && devModeWriteAllowed(target, cfg.workspace)");
    const idxNormal = sandbox.indexOf("审批档位自动放行（工作目录外）");
    expect(idxD1).toBeGreaterThan(0);
    /* D1 分支必须排在普通放行之前（否则开关形同虚设）。 */
    expect(idxD1).toBeLessThan(idxNormal);
  });

  it("扩展页有开发者模式总开关（会话级说明 + 调 devModeSet）", () => {
    const panel = read("gui/src/renderer/pages/PluginsPanel.tsx");
    expect(panel).toContain("开发者模式");
    expect(panel).toMatch(/pluginsDevModeSet\(next\)/);
    expect(panel).toContain("会话级授权：每次启动都要重新确认");
  });
});
