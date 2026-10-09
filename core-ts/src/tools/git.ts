/**
 * A-1198 · git_* 工具层（桌面端）：把 AGENTS.md 的 Git 契约从文档层接到工具层 ——
 * 让「可追溯」从承诺变成机制（docs/PROJECT_OVERVIEW.md 未来演进方向 §3）。
 *
 * ## 三道闸（本层的存在理由）
 * ⚠️ 2026-10-09 设计更正（用户口径）：本层原以「D1 开发者模式（改主干）」为背景落地 ——
 *    该模式已**撤除**（扩展一律是外部插件、可开可关，不开「改程序本身」的通路）。
 *    本层**独立保留**为「Agent 提交代码」的治理层：对**任何**工作区仓库通用，不再隶属 D1。
 *   ① commit 门禁 —— commit 前必过质量门禁（TS：根/gui tsc + 全量 vitest；Python：py qa.py；
 *      纯文档跳过）；门禁不绿 ⇒ 不允许 commit。
 *   ② diff 评审 —— 每次 commit 前把 `git diff --stat` + 关键片段**展示给用户**，
 *      用户点头才落 commit（经 `setGitReviewCallback` 注入到桌面弹窗；未注入 ⇒ 拒绝，不静默放行）。
 *   ③ 合并权 —— Agent **没有**合并能力：本层不提供任何 merge 工具；`git_commit` 拒绝受保护分支；
 *      `git_branch` 拒绝创建/切到受保护分支。产物停在 `slime/*` 分支上，等用户手工合并。
 *
 * ## 身份铁律（AGENTS.md §0 / §4）——绝不冒充人类作者
 * author 由本层注入为 `slime-{agent_id} <agent+{agent_id}@slime.local>`；身份来自
 * tool_loop 的 `_agent_*` 注入（Agent 无法用它自己的参数覆盖——参数里的同名字段会被丢弃）。
 * 身份缺失 ⇒ 直接拒绝，不给「cli-direct」之类的兜底（兜底 = 假身份，比拒绝更坏）。
 *
 * ## 与 Python 侧 `tools/git.py` 的关系（双栈漂移的边界）
 * 语义（阈值 800/30、保护分支 glob、Conventional Commits、trailers 顺序）**逐条对齐**；
 * 受保护模块清单按 TS 时代重定为「治理层与权限层自己」（sandbox/policy/hard_rules/git 自身…）。
 * Python 侧对受保护模块是**硬拒**（要求「sandbox 最高级 approval」而该路径未实现）；
 * 桌面侧升级为：**评审弹窗里显式高亮 + 必须人工点头**（评审本来就是强制的，再叠硬拒只会
 * 把需要改治理层的工作逼到裸 git —— 那是更差的结局）。差异已在此写明，不作静默分叉。
 *
 * ## Windows 斜杠 ref 缺陷（docs/KNOWN-ISSUES.md §10 + 用户技能）
 * Git for Windows 2.55+ 上 `git branch slime/x/y` 与在斜杠分支上 `git commit` 会**静默写不进 ref**。
 * 本层在「新建分支」「commit 后」两处都做**真值校验**（reflog 才是真值，`rev-parse HEAD` 会被
 * 陈旧 packed-refs 骗过），命中即用 loose ref / packed-refs 修复并**如实报告修复动作**；修不好出声。
 */

import { execFile, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { Tool, ToolRegistry, getRegistry } from "./registry.js";

const execFileP = promisify(execFile);
const execP = promisify(execCb);

/* ── 常量与判据（阈值/清单**单一产地**：测试与工具都从这里取） ─────────────── */

/** Lint Gate 阈值（AGENTS.md §2.2）。 */
export const MAX_CHANGED_LINES_PER_COMMIT = 800;
export const MAX_CHANGED_FILES_PER_COMMIT = 30;

/** Conventional Commits 合法 type（AGENTS.md §2.1）。 */
export const ALLOWED_COMMIT_TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "chore", "style"] as const;
export type CommitType = (typeof ALLOWED_COMMIT_TYPES)[number];

/** 受保护分支 glob（AGENTS.md §1.1 / §5）——Agent 在这些分支上只能读。 */
export const PROTECTED_BRANCH_GLOBS = ["main", "master", "production", "release/*", "hotfix/*"] as const;

/** 受保护模块（AGENTS.md §6 的 TS 时代重定版）：治理层与权限层**自己**。
 *  改了它们 = 改了「管 Agent 的规则」，必须走评审弹窗的显式人工点头。 */
export const PROTECTED_MODULES: ReadonlyArray<{ path: string; why: string }> = [
  { path: "AGENTS.md", why: "Git 治理层本身（防止 Agent 改规则绕过自己）" },
  { path: "CLAUDE.md", why: "平台行为契约" },
  { path: "core-ts/src/sandbox.ts", why: "沙箱/权限（自己管自己的规则）" },
  { path: "core-ts/src/tools/git.ts", why: "Git 工具层本身" },
  { path: "core-ts/src/tools/policy.ts", why: "工具授权策略" },
  { path: "core-ts/src/tools/hard_rules.ts", why: "硬规则（不可绕过的安全边界）" },
  { path: "core-ts/src/tools/classifier.ts", why: "命令分类/预检" },
  { path: "core-ts/src/plugin/trust.ts", why: "脚本信任（执行边界开关）" },
  { path: "core-ts/src/services/agentTools.ts", why: "能力自述与工具白名单（Agent 自我认知）" },
];

/** `slime/*` 分支形态（AGENTS.md §1.2）：`slime/<id>/<slug>`（slug 允许再嵌一层 subtask 段）。 */
export const SLIME_BRANCH_RE = /^slime\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,3}$/;

/** 输出上限（防超长输出灌进上下文）。 */
export const STATUS_OUTPUT_MAX = 4000;
export const DIFF_PATCH_MAX = 20000;
export const REVIEW_PATCH_MAX = 6000;
export const QA_TAIL_MAX = 2000;

/** 门禁超时：QA 全量 30 分钟（与 Python 侧 60*30 同口径）；单条 TS 检查 10 分钟。 */
export const QA_TIMEOUT_MS = 30 * 60 * 1000;
export const QA_STEP_TIMEOUT_MS = 10 * 60 * 1000;

/* ── 纯函数（可单测；不 spawn 任何东西） ───────────────────────────────────── */

/** 分支名是否受保护（glob 匹配，AGENTS.md §5 的第一层；第二层 merged 检测见 `isProtectedBranch`）。 */
export function isProtectedBranchName(branch: string): boolean {
  const b = (branch ?? "").trim();
  if (!b) { return true; } // 解析不出分支名 = 判不了 ⇒ 按最坏情况处理（fail-closed）
  for (const pat of PROTECTED_BRANCH_GLOBS) {
    if (globMatch(pat, b)) { return true; }
  }
  return false;
}

/** 极简 glob（只支持 `*` 与固定段；分支名场景够用，不引入依赖）。 */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$",
  );
  return re.test(text);
}

/** 从 `git diff --numstat` 输出解析 (changedFiles, changedLines)。二进制行按 0 行计。 */
export function parseNumstat(stdout: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) { continue; }
    const parts = line.split("\t");
    if (parts.length < 3) { continue; }
    const add = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10);
    const del = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10);
    if (Number.isFinite(add) && Number.isFinite(del)) {
      lines += add + del;
      files += 1;
    }
  }
  return { files, lines };
}

/** 提交参数校验（type/scope/subject/decision）。返回错误列表（空 = 通过）。 */
export function validateCommitArgs(input: { type: string; scope: string; subject: string; decision: string }): string[] {
  const errors: string[] = [];
  if (!(ALLOWED_COMMIT_TYPES as readonly string[]).includes(input.type)) {
    errors.push(`type 必须是 ${ALLOWED_COMMIT_TYPES.join(" / ")}（收到：${JSON.stringify(input.type)}）`);
  }
  if (!input.subject.trim()) {
    errors.push("subject 不能为空（语义化 commit 标题）");
  } else if (input.subject.length > 88) {
    errors.push(`subject 过长（≤ 88 字符）：当前 ${input.subject.length}`);
  }
  if (input.scope && !/^[a-z][a-z0-9_-]{0,31}$/.test(input.scope)) {
    errors.push(`scope 不合法：${JSON.stringify(input.scope)}（建议：agent/swarm/gui/core/tools/mcp/memory/evolution/sandbox/ci/meta）`);
  }
  if (input.decision.length > 200) {
    errors.push(`decision 过长（≤ 200 字符）：当前 ${input.decision.length}`);
  }
  return errors;
}

/** 纯相对路径校验（git_stage/git_diff 的 paths 参数用）——不许盘符/绝对路径/`..`。 */
export function validateRelPaths(paths: unknown): { ok: true; paths: string[] } | { ok: false; error: string } {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: "paths 必须是至少 1 项的数组（按文件语义化暂存，禁止不传路径的隐式全量添加）" };
  }
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string" || raw.trim() === "") {
      return { ok: false, error: `paths 含非法项：${JSON.stringify(raw)}` };
    }
    const p = raw.trim().replace(/\\/g, "/");
    if (p === "." || p === "./" || p === "*") {
      return { ok: false, error: `拒绝全量路径 ${JSON.stringify(raw)}：必须逐个列出要暂存的文件（AGENTS.md §8）` };
    }
    if (/^[A-Za-z]:/.test(p) || p.startsWith("/") || p.startsWith("\\\\")) {
      return { ok: false, error: `paths 必须是仓库内相对路径：${raw}` };
    }
    if (p.split("/").some((seg) => seg === "..")) {
      return { ok: false, error: `paths 不得含 .. 段：${raw}` };
    }
    out.push(p);
  }
  return { ok: true, paths: out };
}

/** 受保护模块命中（返回命中项原文，供评审高亮与报告）。 */
export function matchProtectedModules(paths: string[]): Array<{ path: string; why: string }> {
  const norm = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  return PROTECTED_MODULES.filter((m) => norm.has(m.path));
}

/** 质量门禁分类：按改动文件后缀决定跑哪套门（对齐 Python `_run_quality_gate` 的语义）。 */
export function classifyGate(changedPaths: string[]): "skip-docs" | "ts" | "py" | "ts+py" {
  const pureDocs = changedPaths.length > 0 && changedPaths.every((p) => {
    const n = p.replace(/\\/g, "/");
    const isDoc = /\.(md|txt|rst)$/i.test(n);
    const inDocZone = n.startsWith("docs/") || n.startsWith("AGENTS.") || n.startsWith("CLAUDE.") || /^README/i.test(n) || n.startsWith(".workbuddy/");
    return isDoc && inDocZone;
  });
  if (pureDocs) { return "skip-docs"; }
  const hasPy = changedPaths.some((p) => /\.py$/i.test(p));
  const hasTs = changedPaths.some((p) => /\.(ts|tsx|js|jsx|mjs|cjs|css|html|json)$/i.test(p));
  if (hasPy && hasTs) { return "ts+py"; }
  if (hasPy) { return "py"; }
  return "ts";
}

/** Lint Gate：巨型提交判定。 */
export function isHugeCommit(files: number, lines: number): boolean {
  return lines > MAX_CHANGED_LINES_PER_COMMIT || files > MAX_CHANGED_FILES_PER_COMMIT;
}

/** `slime/<agent_id>/<slug>` 形态校验（new/checkout 用；agent_id 来自注入、不许自编）。 */
export function validateSlimeBranchName(name: string, agentId: string): string[] {
  const n = (name ?? "").trim();
  const errors: string[] = [];
  if (!n) { return ["name 不能为空"]; }
  if (!n.startsWith("slime/")) {
    return [`Agent 新建分支必须带 slime/ 前缀（AGENTS.md §1.1）：${n}`];
  }
  if (!SLIME_BRANCH_RE.test(n)) {
    errors.push(`分支名不符合 slime/<id>/<slug> 规范（小写 ASCII 字母数字与 - _ .，段长合规）：${n}`);
  }
  /* 段 2 必须是本 Agent 自己的 id（或 swarm/tmp 形态）——防 Agent 蹭别人的分支名。 */
  const parts = n.split("/");
  const seg = parts[1] ?? "";
  const allowed = seg === agentId || seg === "swarm" || seg === "tmp";
  if (agentId && !allowed) {
    errors.push(`分支段 2 必须是本 Agent 的 id（${agentId}）或 swarm/tmp 形态（AGENTS.md §1.2）：收到 ${seg}`);
  }
  if (seg === "tmp" && parts[2] !== agentId && agentId) {
    errors.push(`slime/tmp/ 形态的段 3 必须是本 Agent 的 id：收到 ${parts[2] ?? ""}`);
  }
  return errors;
}

/** 拼装 commit message（title + 身份头 + body + trailers）。trailers 里禁止手写重复。 */
export function buildCommitMessage(input: {
  type: string;
  scope: string;
  subject: string;
  body: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  agentModel: string;
  sessionId: string;
  decision: string;
  coAuthor?: string;
}): string {
  const scopePart = input.scope ? `(${input.scope})` : "";
  const title = `${input.type}${scopePart}: ${input.subject.trim()}`;
  const authorName = `slime-${input.agentId}`;
  const authorEmail = `agent+${input.agentId}@slime.local`;

  const lines: string[] = [title];
  /* 身份头（AGENTS.md §0）：chore(meta) 纯元数据例外。 */
  const isMeta = input.type === "chore" && input.scope === "meta";
  if (!isMeta) {
    lines.push("", `我是 ${input.agentName}，${input.agentRole}`);
  }
  /* body 里若混入 trailer 形态的行（含 Agent- 前缀）一律剔除，避免伪造/重复。 */
  const cleanedBody = String(input.body ?? "")
    .split("\n")
    .filter((ln) => !/^[A-Za-z][A-Za-z0-9-]*:\s/.test(ln) && !/^Agent-/.test(ln))
    .join("\n")
    .trim();
  if (cleanedBody) {
    lines.push("", cleanedBody);
  }

  const trailers: string[] = [
    `Agent-Name: ${input.agentName}`,
    `Agent-ID: ${input.agentId}`,
    `Agent-Role: ${input.agentRole}`,
    `Agent-Model: ${input.agentModel || "-"}`,
    `Agent-Session: ${input.sessionId || "-"}`,
    "Agent-Subtask: -",
    "Agent-Parent-ID: -",
    `Agent-Decision: ${input.decision || "-"}`,
    "Agent-Origin: slime/v1",
    `Co-Authored-By: ${authorName} <${authorEmail}>`,
    ...(input.coAuthor?.trim() ? [`Co-Authored-By: ${input.coAuthor.trim()}`] : []),
    `Signed-off-by: ${authorName} <${authorEmail}>`,
  ];
  lines.push("", ...trailers);
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

/* ── git 执行基建 ─────────────────────────────────────────────────────────── */

interface GitRun { code: number; stdout: string; stderr: string; }

/** 跑一条 git（execFile、参数数组、**不过 shell**——参数里带什么都不可能变成命令注入）。 */
export async function gitRun(repoRoot: string, args: string[], timeoutMs = 120_000): Promise<GitRun> {
  try {
    const r = await execFileP("git", args, { cwd: repoRoot, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }) as unknown as { stdout: string; stderr: string };
    return { code: 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? ""),
    };
  }
}

/** 找到 cwd 所在仓库的根（`--show-toplevel`）；不在仓库 ⇒ null。 */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  if (!cwd) { return null; }
  const r = await gitRun(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) { return null; }
  const top = r.stdout.trim();
  return top ? resolve(top) : null;
}

/** 当前分支名（detached 时返回 `HEAD` 字面量并由调用方按受保护处理）。 */
export async function currentBranch(repoRoot: string): Promise<string> {
  const r = await gitRun(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/** 分支保护的第二层：已合并进 main/master ⇒ 视为公共分支（AGENTS.md §5）。 */
export async function isProtectedBranch(repoRoot: string, branch: string): Promise<{ protected: boolean; reason: string }> {
  if (isProtectedBranchName(branch)) {
    return { protected: true, reason: `分支名匹配保护模式（${PROTECTED_BRANCH_GLOBS.join(" / ")}）` };
  }
  for (const base of ["main", "master"]) {
    const ex = await gitRun(repoRoot, ["rev-parse", "--verify", "--quiet", base]);
    if (ex.code !== 0) { continue; }
    /* ⚠️ 与 Python 侧的有意差异：`branch --merged <base>` 会把**刚建的空分支**
       （tip 与 base 同一个 commit）也列出来 —— 那会让「新建 slime/* 分支后的第一条 commit
       永远被拒」陷入死锁。这里先排除「tip == base tip」：这种分支没有任何**已合并的独有产物**
       可保护；「曾交付过的分支」（tip 是 base 的祖先且不同于 base tip）仍按公共分支处理。 */
    const tipR = await gitRun(repoRoot, ["rev-parse", `refs/heads/${branch}`]);
    const baseTipR = await gitRun(repoRoot, ["rev-parse", `refs/heads/${base}`]);
    if (tipR.stdout.trim() && tipR.stdout.trim() === baseTipR.stdout.trim()) { continue; }
    const merged = await gitRun(repoRoot, ["branch", "--merged", base, "--list", branch]);
    const list = merged.stdout.split("\n").map((l) => l.trim().replace(/^\* /, "")).filter(Boolean);
    if (list.includes(branch)) {
      return { protected: true, reason: `该分支已合并入 ${base}，视为公共分支` };
    }
  }
  return { protected: false, reason: "" };
}

/** 取暂存区文件清单（相对仓库根）。 */
export async function stagedPaths(repoRoot: string): Promise<string[]> {
  const r = await gitRun(repoRoot, ["diff", "--cached", "--name-only"]);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/* ── Windows 斜杠 ref 兜底（KNOWN-ISSUES §10） ─────────────────────────────── */

/** 取 git 公共目录（worktree 场景 `.git` 是文件，refs 在 common dir —— 必须用它）。 */
export async function gitCommonDir(repoRoot: string): Promise<string> {
  const r = await gitRun(repoRoot, ["rev-parse", "--git-common-dir"]);
  const raw = r.stdout.trim() || ".git";
  return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
}

/** 直接写 loose ref 文件（绕过 git 自身的 ref 写入路径 —— 那正是缺陷所在）。 */
export async function writeLooseRef(repoRoot: string, branch: string, hash: string): Promise<boolean> {
  const common = await gitCommonDir(repoRoot);
  const refFile = join(common, "refs", "heads", ...branch.split("/"));
  try {
    await mkdir(join(common, "refs", "heads", ...branch.split("/").slice(0, -1)), { recursive: true });
    await writeFile(refFile, `${hash}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 分支 ref 当前解析到的 hash（读不到 ⇒ 空串）。 */
export async function refHash(repoRoot: string, branch: string): Promise<string> {
  const r = await gitRun(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * commit/分支创建后的**真值校验 + 修复**（斜杠 ref 缺陷兜底）。
 * ⚠️ `rev-parse HEAD` 在缺陷场景会被陈旧 packed-refs 骗过（HEAD 同样解析到旧值）——
 *    真值只有两个：`git reflog -1 --format=%H` 与 commit 自己打印的 `[branch hash]` 行。
 *    这里用 reflog 真值比对 ref；不一致 ⇒ 写 loose ref 修复，再复核；修不好如实标 unresolved。
 */
export async function verifyAndRepairRef(repoRoot: string, branch: string): Promise<{ checked: boolean; mismatch: boolean; repaired: boolean; note: string }> {
  if (!branch || branch === "HEAD" || !branch.includes("/")) {
    return { checked: false, mismatch: false, repaired: false, note: "" };
  }
  const reflog = await gitRun(repoRoot, ["reflog", "-1", "--format=%H"]);
  const truth = reflog.stdout.trim();
  const cur = await refHash(repoRoot, branch);
  if (!truth || !cur) {
    return { checked: true, mismatch: false, repaired: false, note: "" };
  }
  if (truth === cur) {
    return { checked: true, mismatch: false, repaired: false, note: "" };
  }
  const wrote = await writeLooseRef(repoRoot, branch, truth);
  const after = wrote ? await refHash(repoRoot, branch) : "";
  if (after === truth) {
    return {
      checked: true, mismatch: true, repaired: true,
      note: `⚠️ 命中已知 Windows 斜杠 ref 缺陷（.git/refs 未写入）：分支 ref 停在 ${cur.slice(0, 7)}，提交对象实为 ${truth.slice(0, 7)} —— 已写 loose ref 修复并复核一致。`,
    };
  }
  return {
    checked: true, mismatch: true, repaired: false,
    note: `❌ 分支 ref（${cur.slice(0, 7)}）与 reflog 真值（${truth.slice(0, 7)}）不一致，且 loose ref 修复未生效 —— 请人工核对（勿重复提交！提交对象真实存在，可用 git reflog 找回）。`,
  };
}

/* ── 质量门禁（commit 门禁） ───────────────────────────────────────────────── */

export interface GitQaResult {
  kind: "none" | "ts" | "py" | "ts+py";
  ok: boolean;
  detail: Record<string, unknown>;
  logTail?: string;
}

export type GitQaRunner = (input: { repoRoot: string; changedPaths: string[]; timeoutMs: number }) => Promise<GitQaResult>;

async function runChecked(cmd: string, repoRoot: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await execP(cmd, {
      cwd: repoRoot,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    }) as unknown as { stdout: string; stderr: string };
    return { ok: true, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? err.message ?? ""}` };
  }
}

/** 默认门禁执行器：TS ⇒ 根/gui tsc + 全量 vitest；Python ⇒ py qa.py；纯文档 ⇒ 跳过。 */
export async function defaultGitQaRunner(input: { repoRoot: string; changedPaths: string[]; timeoutMs: number }): Promise<GitQaResult> {
  const kind = classifyGate(input.changedPaths);
  if (kind === "skip-docs") {
    return { kind: "none", ok: true, detail: { skip_reason: "纯文档改动（AGENTS.md §3 免 QA 门）" } };
  }
  const budget = input.timeoutMs || QA_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  /* ⚠️ 步骤键叫 `id` 不叫 `name`：a1091 的工具标签守卫会扫 core-ts/src/tools/*.ts 里所有
     `name: "小写名"` 形态，把非工具的 name 也当成「已注册工具」（实测 vitest 被误报）。 */
  const steps: Array<{ id: string; cmd: string }> = [];
  if (kind === "ts" || kind === "ts+py") {
    steps.push(
      { id: "tsc-root", cmd: "npx tsc -p tsconfig.base.json --noEmit" },
      { id: "tsc-gui", cmd: "npx tsc -p gui/tsconfig.json --noEmit" },
      { id: "vitest", cmd: "npx vitest run" },
    );
  }
  if (kind === "py" || kind === "ts+py") {
    steps.push({ id: "qa.py", cmd: "py qa.py" });
  }
  const done: Record<string, string> = {};
  for (const step of steps) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      return { kind, ok: false, detail: { ...done, error: "质量门禁超时（预算耗尽，后续步骤未执行）" }, logTail: "超时" };
    }
    const r = await runChecked(step.cmd, input.repoRoot, Math.min(QA_STEP_TIMEOUT_MS, remain));
    if (!r.ok) {
      done[step.id] = "FAIL";
      return { kind, ok: false, detail: done, logTail: r.out.slice(-QA_TAIL_MAX) };
    }
    done[step.id] = "OK";
  }
  return { kind, ok: true, detail: done };
}

let qaRunner: GitQaRunner = defaultGitQaRunner;

/** 门禁执行器可注入（测试注入 stub；传 null 复位默认）。 */
export function setGitQaRunner(fn: GitQaRunner | null): void {
  qaRunner = fn ?? defaultGitQaRunner;
}

/* ── 差异评审（diff 评审闸） ───────────────────────────────────────────────── */

export interface GitReviewRequest {
  agentId: string;
  agentName: string;
  repoRoot: string;
  branch: string;
  title: string;
  stats: { files: number; lines: number };
  statText: string;
  patchSample: string;
  qaSummary: string;
  protectedModules: Array<{ path: string; why: string }>;
}

export interface GitReviewDecision { approved: boolean; reason?: string; }

export type GitReviewCallback = (req: GitReviewRequest) => Promise<GitReviewDecision>;

let reviewCallback: GitReviewCallback | null = null;

/** 注入评审通道（桌面端在 main 里注入成弹窗；未注入 ⇒ commit 直接拒绝，不静默放行）。 */
export function setGitReviewCallback(cb: GitReviewCallback | null): void {
  reviewCallback = cb;
}

/** 评审弹窗展示文本（stat + 关键片段 + 门禁摘要 + 受保护模块高亮）。 */
export function buildReviewDetail(req: Omit<GitReviewRequest, "agentId" | "agentName" | "repoRoot">): string {
  const lines: string[] = [];
  lines.push(`分支：${req.branch}`);
  lines.push(`提交：${req.title}`);
  lines.push(`规模：${req.stats.files} 个文件 / +-${req.stats.lines} 行`);
  lines.push(`门禁：${req.qaSummary}`);
  if (req.protectedModules.length > 0) {
    lines.push("", "⚠️ 本次改动包含受保护模块（AGENTS.md §6，需你显式批准）：");
    for (const m of req.protectedModules) {
      lines.push(`  · ${m.path} —— ${m.why}`);
    }
  }
  lines.push("", "── diff --stat ──", req.statText.trim() || "(空)");
  if (req.patchSample.trim()) {
    lines.push("", "── 关键片段（截断） ──", req.patchSample.trim());
  }
  return lines.join("\n");
}

/* ── 工具实现 ─────────────────────────────────────────────────────────────── */

function truncate(text: string, max: number): string {
  const t = String(text ?? "");
  return t.length <= max ? t : `${t.slice(0, max)}\n…[已截断：共 ${t.length} 字符，仅显示前 ${max}]`;
}

/** 取本 Agent 身份（tool_loop 注入；缺 id/name/role ⇒ 返回错误串，调用方拒绝）。 */
function agentIdentity(args: Record<string, unknown>): { ok: true; id: string; name: string; role: string; model: string; session: string } | { ok: false; error: string } {
  const id = String(args._agent_id ?? "").trim();
  const name = String(args._agent_name ?? "").trim();
  const role = String(args._agent_role ?? "").trim();
  if (!id || !name || !role) {
    return { ok: false, error: "[拒绝 身份铁律] 缺少 Agent 身份注入（agent_id/agent_name/agent_role）——git 写操作必须在 Agent 运行上下文里发起（AGENTS.md §0：绝不冒充人类作者）。" };
  }
  return {
    ok: true,
    id,
    name,
    role,
    model: String(args._agent_model ?? "").trim(),
    session: String(args._session_id ?? "").trim(),
  };
}

function reprGitFailure(r: GitRun): string {
  const tail = (r.stderr || r.stdout || "").split("\n").slice(-6).join("\n").trim();
  return tail || `git 退出码 ${r.code}`;
}

async function requireRepo(args: Record<string, unknown>): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  const ws = String(args._workspace ?? "").trim();
  const root = await findRepoRoot(ws || process.cwd());
  if (!root) {
    return { ok: false, error: "[拒绝] 当前工作目录不是 Git 仓库（AGENTS.md §9：检测不到 .git 时写操作一律拒绝）。" };
  }
  return { ok: true, root };
}

export async function gitStatus(args: Record<string, unknown>): Promise<string> {
  const repo = await requireRepo(args);
  if (!repo.ok) { return repo.error; }
  const branch = await currentBranch(repo.root);
  const prot = await isProtectedBranch(repo.root, branch);
  const st = await gitRun(repo.root, ["status", "--short", "--branch"]);
  const lines = st.stdout.split("\n");
  const head = lines[0]?.trim() ?? "";
  const changed = lines.slice(1).filter((l) => l.trim()).join("\n");
  const tag = prot.protected ? `🔒 受保护分支（${prot.reason}）` : "🟢 可写 Agent 分支";
  return [
    `仓库：${repo.root}`,
    `分支：${branch}  ${tag}`,
    `保护规则：${PROTECTED_BRANCH_GLOBS.join(" / ")}（已合并进 main 的分支同样视为公共分支）`,
    `HEAD 状态：${head}`,
    "── 变更文件 ──",
    truncate(changed || "(工作区干净)", STATUS_OUTPUT_MAX),
  ].join("\n");
}

export async function gitDiff(args: Record<string, unknown>): Promise<string> {
  const repo = await requireRepo(args);
  if (!repo.ok) { return repo.error; }
  const staged = args.staged === true;
  let paths: string[] = [];
  if (args.paths !== undefined) {
    const v = validateRelPaths(args.paths);
    if (!v.ok) { return `[拒绝] ${v.error}`; }
    paths = v.paths;
  }
  const base = ["diff"];
  if (staged) { base.push("--cached"); }
  const stat = await gitRun(repo.root, [...base, "--stat", ...(paths.length ? ["--", ...paths] : [])]);
  const patch = await gitRun(repo.root, [...base, ...(paths.length ? ["--", ...paths] : [])]);
  const scope = staged ? "暂存区（HEAD vs 暂存）" : "工作区（暂存 vs 工作区）";
  return [
    `── ${scope} --stat ──`,
    truncate(stat.stdout.trim() || "(无变更)", STATUS_OUTPUT_MAX),
    "",
    "── patch ──",
    truncate(patch.stdout.trim() || "(无变更)", DIFF_PATCH_MAX),
  ].join("\n");
}

export async function gitStage(args: Record<string, unknown>): Promise<string> {
  const repo = await requireRepo(args);
  if (!repo.ok) { return repo.error; }
  const v = validateRelPaths(args.paths);
  if (!v.ok) { return `[拒绝] ${v.error}`; }
  const r = await gitRun(repo.root, ["add", "--", ...v.paths]);
  if (r.code !== 0) {
    return `[错误] git add 失败：${reprGitFailure(r)}`;
  }
  const now = await stagedPaths(repo.root);
  return [
    `已暂存 ${v.paths.length} 条路径（逐条加入，非隐式全量）。`,
    `当前暂存区共 ${now.length} 个文件：`,
    truncate(now.join("\n") || "(空)", STATUS_OUTPUT_MAX),
  ].join("\n");
}

export async function gitBranch(args: Record<string, unknown>): Promise<string> {
  const repo = await requireRepo(args);
  if (!repo.ok) { return repo.error; }
  const action = String(args.action ?? "list").trim() || "list";
  const name = String(args.name ?? "").trim();

  if (action === "list") {
    const r = await gitRun(repo.root, ["branch", "--list"]);
    const cur = await currentBranch(repo.root);
    const lines = r.stdout.split("\n").filter(Boolean).map((l) => {
      const n = l.replace(/^\*?\s*/, "").trim();
      const prot = isProtectedBranchName(n) ? " 🔒 PROTECTED" : "";
      const isCur = n === cur ? " ← 当前" : "";
      return `${l.startsWith("*") ? "*" : " "} ${n}${prot}${isCur}`;
    });
    return `本地分支：\n${truncate(lines.join("\n") || "(无)", STATUS_OUTPUT_MAX)}`;
  }

  if (action === "current") {
    const cur = await currentBranch(repo.root);
    const prot = await isProtectedBranch(repo.root, cur);
    return `当前分支：${cur}${prot.protected ? ` 🔒（${prot.reason}）` : ""}`;
  }

  if (action === "new" || action === "checkout") {
    const ident = agentIdentity(args);
    if (!ident.ok) { return ident.error; }
    const errs = validateSlimeBranchName(name, ident.id);
    if (errs.length > 0) { return `[拒绝] 分支名校验未通过：\n  · ${errs.join("\n  · ")}`; }
    if (isProtectedBranchName(name)) {
      return `[拒绝] ${name} 是受保护分支名，Agent 不得创建/切换（AGENTS.md §1.1）。`;
    }
    if (action === "new") {
      const exists = await refHash(repo.root, name);
      if (exists) { return `[拒绝] 分支已存在：${name}（如需切换用 action='checkout'）`; }
      const r = await gitRun(repo.root, ["branch", name]);
      if (r.code !== 0) { return `[错误] git branch 失败：${reprGitFailure(r)}`; }
      /* 斜杠 ref 缺陷：exit 0 也可能是假成功 —— for-each-ref 真核验 + 修复。 */
      let created = await refHash(repo.root, name);
      let repairNote = "";
      if (!created) {
        const headR = await gitRun(repo.root, ["rev-parse", "HEAD"]);
        const head = headR.stdout.trim();
        const wrote = head ? await writeLooseRef(repo.root, name, head) : false;
        created = wrote ? await refHash(repo.root, name) : "";
        repairNote = created
          ? `⚠️ 命中已知 Windows 斜杠 ref 缺陷（git branch 静默未写 ref）—— 已写 loose ref 修复（指向 ${head.slice(0, 7)}）。`
          : "❌ 分支创建后 ref 仍解析不到，且自动修复未生效 —— 请勿在此分支上提交，先人工排查（docs/KNOWN-ISSUES.md §10）。";
      }
      return [`已创建分支：${name}（基于当前 HEAD）`, repairNote].filter(Boolean).join("\n");
    }
    // checkout
    const cur = await currentBranch(repo.root);
    if (cur === name) { return `当前已在分支：${name}`; }
    const r = await gitRun(repo.root, ["checkout", name]);
    if (r.code !== 0) { return `[错误] git checkout 失败：${reprGitFailure(r)}`; }
    return `已切换到分支：${name}`;
  }

  if (action === "delete") {
    const ident = agentIdentity(args);
    if (!ident.ok) { return ident.error; }
    if (!name.startsWith("slime/")) {
      return `[拒绝] 只允许删除 slime/* 分支：${name}`;
    }
    const cur = await currentBranch(repo.root);
    if (name === cur) {
      return `[拒绝] 不能删除当前所在分支：${name}`;
    }
    const r = await gitRun(repo.root, ["branch", "-D", name]);
    if (r.code !== 0) { return `[错误] git branch -D 失败：${reprGitFailure(r)}`; }
    return `已删除分支：${name}`;
  }

  return `[拒绝] action 必须是 list / current / new / checkout / delete（收到：${JSON.stringify(action)}）`;
}

export async function gitCommit(args: Record<string, unknown>): Promise<string> {
  /* ① 身份铁律：缺身份 ⇒ 直接拒（不给假身份兜底）。 */
  const ident = agentIdentity(args);
  if (!ident.ok) { return ident.error; }

  /* ② 参数校验。 */
  const type = String(args.type ?? "").trim();
  const scope = String(args.scope ?? "").trim();
  const subject = String(args.subject ?? "").trim();
  const body = String(args.body ?? "");
  const decision = String(args.decision ?? "").trim().slice(0, 200);
  const coAuthor = String(args.co_author ?? "").trim();
  const allowHuge = args.allow_huge_commit === true;
  const errs = validateCommitArgs({ type, scope, subject, decision });
  if (errs.length > 0) { return `[拒绝] 提交参数校验未通过：\n  · ${errs.join("\n  · ")}`; }

  /* ③ 仓库 + 分支保护（AGENTS.md §1.1：受保护分支上写操作一律拒）。 */
  const repo = await requireRepo(args);
  if (!repo.ok) { return repo.error; }
  const branch = await currentBranch(repo.root);
  const prot = await isProtectedBranch(repo.root, branch);
  if (prot.protected) {
    return [
      `[拒绝] 当前分支 ${branch} 是受保护分支（${prot.reason}）—— Agent 不得直接 commit。`,
      "先执行：git_branch(action='new', name='slime/<你的id>/<task-slug>') 再提交；合并的事交给人。",
    ].join("\n");
  }

  /* ④ 暂存区非空（禁止隐式全量 add）。 */
  const staged = await stagedPaths(repo.root);
  if (staged.length === 0) {
    return "[拒绝] 暂存区为空。请先调用 git_stage(paths=[...]) 逐条暂存要提交的改动（禁止隐式全量添加）。";
  }

  /* ⑤ Lint Gate：巨型提交（AGENTS.md §2.2）。 */
  const numstat = await gitRun(repo.root, ["diff", "--cached", "--numstat"]);
  const { files, lines } = parseNumstat(numstat.stdout);
  if (isHugeCommit(files, lines) && !allowHuge) {
    return [
      `[拒绝 Lint Gate] 巨型提交：已暂存 ${files} 个文件 / +-${lines} 行。`,
      `阈值 ≤${MAX_CHANGED_FILES_PER_COMMIT} 文件 / ≤${MAX_CHANGED_LINES_PER_COMMIT} 行。`,
      "解决：① 拆成多个语义化小 commit；② 或确属不可拆时传 allow_huge_commit=true 显式同意。",
    ].join("\n");
  }

  /* ⑥ 受保护模块：桌面侧不硬拒——在评审弹窗里高亮、由**人**显式点头（见文件头差异说明）。 */
  const hits = matchProtectedModules(staged);

  /* ⑦ 质量门禁（docs/chore(meta) 自动跳过；**源码改动不得跳过**）。 */
  const pureMeta = type === "docs" || (type === "chore" && ["meta", "ci", "deps"].includes(scope));
  if (args.skip_qa === true && !pureMeta) {
    return "[拒绝] 源码改动不得跳过质量门禁（skip_qa 只对 docs / chore(meta|ci|deps) 有意义；本工具不提供源码豁免）。";
  }
  let qa: GitQaResult;
  if (pureMeta) {
    qa = { kind: "none", ok: true, detail: { skip_reason: `${type}${scope ? `(${scope})` : ""} 免 QA 门（AGENTS.md §3）` } };
  } else {
    qa = await qaRunner({ repoRoot: repo.root, changedPaths: staged, timeoutMs: QA_TIMEOUT_MS });
    if (!qa.ok) {
      return [
        "[拒绝 质量门禁] 提交前自动校验失败：",
        `  套件：${qa.kind}  明细：${JSON.stringify(qa.detail)}`,
        qa.logTail ? `  ── 输出尾部 ──\n${truncate(qa.logTail, QA_TAIL_MAX)}` : "",
        "请先修复报错再重试 commit。",
      ].filter(Boolean).join("\n");
    }
  }

  /* ⑧ 差异评审（每次 commit 必有；未配置通道 ⇒ 拒绝，不静默放行）。 */
  const cb = reviewCallback;
  if (!cb) {
    return "[拒绝 评审门] 未配置差异评审通道（评审不可省略）——请在桌面端运行（main 会注入评审弹窗），或注入 setGitReviewCallback。";
  }
  const statTextR = await gitRun(repo.root, ["diff", "--cached", "--stat"]);
  const patchR = await gitRun(repo.root, ["diff", "--cached"]);
  const title = `${type}${scope ? `(${scope})` : ""}: ${subject}`;
  const qaSummary = qa.kind === "none"
    ? String(qa.detail.skip_reason ?? "免门禁")
    : `${qa.kind} 套件通过（${Object.entries(qa.detail).map(([k, v]) => `${k}=${v}`).join(" ")}）`;
  const review: GitReviewRequest = {
    agentId: ident.id,
    agentName: ident.name,
    repoRoot: repo.root,
    branch,
    title,
    stats: { files, lines },
    statText: statTextR.stdout,
    patchSample: truncate(patchR.stdout, REVIEW_PATCH_MAX),
    qaSummary,
    protectedModules: hits,
  };
  const reviewDecision = await cb(review);
  if (!reviewDecision.approved) {
    return `[拒绝 评审门] 用户未批准本次提交${reviewDecision.reason ? `：${reviewDecision.reason}` : ""}。未落任何 commit。`;
  }

  /* ⑨ 落 commit：身份经 `-c` 注入（author 与 committer 都是 slime-*，绝不冒充人类）。 */
  const message = buildCommitMessage({
    type, scope, subject, body,
    agentId: ident.id, agentName: ident.name, agentRole: ident.role,
    agentModel: ident.model, sessionId: ident.session, decision, coAuthor,
  });
  const msgFile = join(tmpdir(), `slime-commit-${randomUUID().slice(0, 8)}.txt`);
  let commitOut: GitRun;
  try {
    await writeFile(msgFile, message, "utf8");
    commitOut = await gitRun(repo.root, [
      "-c", `user.name=slime-${ident.id}`,
      "-c", `user.email=agent+${ident.id}@slime.local`,
      "commit", "-F", msgFile,
    ]);
  } finally {
    await rm(msgFile, { force: true }).catch(() => {});
  }
  if (commitOut.code !== 0) {
    return `[错误] git commit 失败：${reprGitFailure(commitOut)}`;
  }
  const headR = await gitRun(repo.root, ["rev-parse", "HEAD"]);
  const hash = headR.stdout.trim();

  /* ⑩ git note（slime-intent）：失败如实出声但不回滚 commit（commit 已成立，note 是附加溯源）。 */
  let noteStatus = "已写入";
  try {
    const noteFile = join(tmpdir(), `slime-note-${randomUUID().slice(0, 8)}.json`);
    const note = {
      agent_id: ident.id, agent_name: ident.name, agent_role: ident.role,
      model: ident.model || null, session_id: ident.session || null,
      qa_result: { kind: qa.kind, ok: qa.ok, detail: qa.detail },
      touched_paths: staged, commit_type: type, commit_scope: scope || null,
      protected_modules: hits.map((h) => h.path),
      decision: decision || null,
    };
    try {
      await writeFile(noteFile, JSON.stringify(note, null, 2), "utf8");
      /* ⚠️ notes add 会在 notes ref 上**新建一个 commit** —— 同样需要 committer 身份
         （临时/无配置仓库里缺身份会 fatal）；身份与主 commit 同源，绝不落到人类配置。 */
      const nr = await gitRun(repo.root, [
        "-c", `user.name=slime-${ident.id}`,
        "-c", `user.email=agent+${ident.id}@slime.local`,
        "notes", "--ref=slime-intent", "add", "-f", "-F", noteFile, hash,
      ]);
      if (nr.code !== 0) { noteStatus = `写入失败（${reprGitFailure(nr)}）—— commit 本体已成立`; }
    } finally {
      await rm(noteFile, { force: true }).catch(() => {});
    }
  } catch (e) {
    noteStatus = `写入异常（${e instanceof Error ? e.message : String(e)}）—— commit 本体已成立`;
  }

  /* ⑪ 斜杠 ref 真值校验（Windows 缺陷兜底）。 */
  const refCheck = await verifyAndRepairRef(repo.root, branch);

  return [
    `✅ 已提交 ${hash.slice(0, 7)}（分支 ${branch}）`,
    `  标题：${title}`,
    `  规模：${files} 个文件 / +-${lines} 行`,
    `  门禁：${qaSummary}`,
    hits.length > 0 ? `  受保护模块（已获人工显式批准）：${hits.map((h) => h.path).join("、")}` : "",
    `  溯源 note（refs/notes/slime-intent）：${noteStatus}`,
    refCheck.note,
    "提醒：合并永远不是 Agent 的动作 —— 产物停在本分支，等用户评审后手工合并。",
  ].filter(Boolean).join("\n");
}

/* ── 注册 ─────────────────────────────────────────────────────────────────── */

/** 注册 git_* 工具族（照 Python register_git_tools 的语义；由 registerBuiltinTools 调用）。 */
export function registerGitTools(target?: ToolRegistry): void {
  const registry = target ?? getRegistry();

  registry.register(new Tool({
    name: "git_status",
    description:
      "读取当前 Git 仓库状态：当前分支（含是否受保护）、HEAD 与变更文件清单。只读。\n"
      + "所有版本控制操作必须走 git_* 工具族（AGENTS.md §8）；不要用 terminal_run 裸调 git 写操作。",
    parameters: { type: "object", properties: {}, required: [] },
    executeFn: gitStatus,
    permissions: ["read"],
  }), true);

  registry.register(new Tool({
    name: "git_diff",
    description:
      "读取 git diff（stat + 完整补丁）。默认看工作区（暂存 vs 工作区）变更；staged=true 看暂存区（HEAD vs 暂存）；可传 paths 限定。只读。",
    parameters: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "是否读取暂存区 diff（HEAD vs 暂存）" },
        paths: { type: "array", items: { type: "string" }, description: "可选：限定看哪些相对路径的 diff" },
      },
      required: [],
    },
    executeFn: gitDiff,
    permissions: ["read"],
  }), true);

  registry.register(new Tool({
    name: "git_stage",
    description:
      "把指定路径逐条加入 Git 暂存区。**必须传 paths**，禁止不传路径的全量添加（AGENTS.md §8）。",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "要暂存的仓库内相对路径，至少 1 项" },
      },
      required: ["paths"],
    },
    executeFn: gitStage,
    permissions: ["write"],
  }), true);

  registry.register(new Tool({
    name: "git_branch",
    description:
      "管理 Agent 分支（list/current/new/checkout/delete）。Agent 新建分支强制 `slime/<你的id>/<task-slug>` 命名（AGENTS.md §1.2），"
      + "受保护分支（main/master/release/*/hotfix/* 等）只读。new/checkout/delete 需要 Agent 身份上下文。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "list / current / new / checkout / delete（默认 list）" },
        name: { type: "string", description: "分支名（new/checkout/delete 必传，必须以 slime/ 开头）" },
      },
      required: [],
    },
    executeFn: gitBranch,
    permissions: ["write"],
  }), true);

  registry.register(new Tool({
    name: "git_commit",
    description:
      "语义化 commit（Conventional Commits + 身份铁律 + 三道闸）。\n"
      + "【提交前必须做】① 用 git_stage(paths=[...]) 逐条暂存 ② 当前分支非受保护分支 ③ 与你无关的全量 add 会被拒。\n"
      + "【自动注入】author=slime-{你的id}、身份头「我是 {name}，{role}」、标准 trailers、refs/notes/slime-intent 溯源 JSON。\n"
      + "【三道闸】① 质量门禁：TS 改动跑根/gui tsc + 全量 vitest，Python 改动跑 py qa.py，不绿不提交；\n"
      + "② 差异评审：提交前把 stat + 关键片段展示给用户，用户点头才落库；\n"
      + "③ 无合并权：Agent 没有合并动作，产物停在 slime/* 分支等用户手工合并。\n"
      + "【Lint Gate】单提交 >30 文件 / >800 行拒绝（allow_huge_commit=true 可显式同意）。",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "feat/fix/perf/refactor/docs/test/chore/style" },
        scope: { type: "string", description: "建议：agent/swarm/gui/core/tools/mcp/memory/evolution/sandbox/ci/meta" },
        subject: { type: "string", description: "简述（≤88 字符）" },
        body: { type: "string", description: "可选正文（空一行后由工具拼 trailers，勿手写 trailers）" },
        decision: { type: "string", description: "关键决策说明（≤200 字符），填入 Agent-Decision trailer" },
        co_author: { type: "string", description: "可选共同作者 \"Name <email>\"（人类维护者）" },
        allow_huge_commit: { type: "boolean", description: "显式同意巨型提交（默认 false）" },
      },
      required: ["type", "subject"],
    },
    executeFn: gitCommit,
    permissions: ["write", "terminal"],
    autoApprovable: false,
  }), true);
}
