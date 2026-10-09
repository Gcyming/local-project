/**
 * tests/core-ts/a1198-git-tools.spec.ts — git_* 工具层（D1 三闸）的守卫
 *
 * ## 这一层在防什么（docs/creator-freedom-design.md §5.1 的 D1 表 / AGENTS.md §0–§9）
 *   ① commit 门禁：质量门禁不绿 ⇒ 不许提交（TS 改动 = 根/gui tsc + 全量 vitest；纯文档跳过）。
 *   ② diff 评审：每次提交前把 stat + 关键片段**给人看**，人点头才落库；通道缺失 ⇒ 拒绝（不静默放行）。
 *   ③ 合并权：Agent 没有合并能力 —— 受保护分支一律拒写；本层不提供任何 merge 工具。
 *   另有身份铁律（author=slime-{id}，缺身份直接拒，**不给假身份兜底**）与 Lint Gate（800/30）。
 *
 * ## 断言分三组
 *   A. 纯函数判据（阈值/glob/消息拼装/路径校验/门禁分类）——不 spawn 任何东西；
 *   B. 行为（**真临时 git 仓库**实跑）：每条门禁都有「放行 vs 拒绝」的正负例；
 *   C. 接线（源码形状）：tool_loop 身份注入 / engine 传参 / main 评审通道 / 弹窗 detail / 注册。
 *
 * ⚠️ 行为组跑真 git：fixture 用 `git init -b main`；作者身份由工具 `-c` 注入（测试仓库无需配 user）。
 * ⚠️ 全局注入器（setGitQaRunner / setGitReviewCallback）是模块级状态 —— afterEach 必须复位，
 *    否则用例互相污染（顺序依赖 = 假绿温床）。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* 行为组每条会 spawn 多条 git 子进程（含真实 commit/notes）；全量并行时 5s 默认超时会被挤爆
   （实测：单跑全绿、全量同一批用例集体超时）。本文件统一放宽到 60s。 */
vi.setConfig({ testTimeout: 60_000 });

import {
  ALLOWED_COMMIT_TYPES,
  MAX_CHANGED_FILES_PER_COMMIT,
  MAX_CHANGED_LINES_PER_COMMIT,
  buildCommitMessage,
  buildReviewDetail,
  classifyGate,
  currentBranch,
  gitBranch,
  gitCommit,
  gitRun,
  gitStage,
  gitStatus,
  isHugeCommit,
  isProtectedBranchName,
  matchProtectedModules,
  parseNumstat,
  refHash,
  setGitQaRunner,
  setGitReviewCallback,
  validateCommitArgs,
  validateRelPaths,
  validateSlimeBranchName,
  type GitReviewRequest,
} from "../../core-ts/src/tools/git.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const TOOL_LOOP_SRC = read("core-ts/src/tool_loop.ts");
const ENGINE_SRC = read("core-ts/src/services/engine.ts");
const BUILTIN_SRC = read("core-ts/src/tools/builtin.ts");
const GIT_SRC = read("core-ts/src/tools/git.ts");
const MAIN_SRC = read("gui/src/main/index.ts");
const CHAT_PANEL_SRC = read("gui/src/renderer/pages/ChatPanel.tsx");
const IPC_SRC = read("gui/src/shared/ipc.ts");

/* ── 真 git 仓库 fixture ─────────────────────────────────────────────────── */

async function mkRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slime-git-"));
  await gitRun(dir, ["init", "-b", "main"]);
  await writeFile(join(dir, "seed.txt"), "seed\n", "utf8");
  await gitRun(dir, ["add", "--", "seed.txt"]);
  await gitRun(dir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@test.local", "commit", "-m", "seed"]);
  return dir;
}

const repos: string[] = [];
afterEach(async () => {
  setGitQaRunner(null);
  setGitReviewCallback(null);
  while (repos.length > 0) {
    const dir = repos.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function repo(): Promise<string> {
  const dir = await mkRepo();
  repos.push(dir);
  return dir;
}

/** 待提交的测试改动：写文件 + 暂存（走工具，走的是被测代码）。 */
async function stageFile(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), content, "utf8");
  const r = await gitStage({ _workspace: root, paths: [rel] });
  expect(r, `fixture 暂存应成功：${rel}`).toContain("已暂存");
}

function ident(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _agent_id: "test-agent",
    _agent_name: "测试员",
    _agent_role: "守卫测试",
    _agent_model: "stub/model-1",
    _session_id: "sess-1",
    ...extra,
  };
}

/** stub 门禁：绿。 */
function qaGreen(): void {
  setGitQaRunner(async () => ({ kind: "ts", ok: true, detail: { stub: "green" } }));
}
/** stub 评审：捕获请求 + 指定决策。 */
function reviewStub(approved: boolean, sink?: (req: GitReviewRequest) => void) {
  setGitReviewCallback(async (req) => {
    sink?.(req);
    return approved ? { approved: true } : { approved: false, reason: "stub 拒绝" };
  });
}

describe("A-1198-G ① 纯函数判据（与 AGENTS.md 逐条对齐）", () => {
  it("保护分支：main/master/production/release/*/hotfix/* 保护；slime/* 不保护；空串 fail-closed", () => {
    for (const b of ["main", "master", "production", "release/v1", "hotfix/x"]) {
      expect(isProtectedBranchName(b), `${b} 必须受保护`).toBe(true);
    }
    for (const b of ["slime/agent-1/task", "feature/x", "dev"]) {
      expect(isProtectedBranchName(b), `${b} 不应受保护`).toBe(false);
    }
    expect(isProtectedBranchName(""), "解析不出分支名 ⇒ 按最坏情况（fail-closed）").toBe(true);
  });

  it("受保护模块命中：治理层与权限层自己（git.ts / sandbox.ts / AGENTS.md…）", () => {
    const hits = matchProtectedModules([
      "core-ts/src/tools/git.ts",
      "core-ts/src/sandbox.ts",
      "AGENTS.md",
      "core-ts/src/services/chat.ts",
    ]);
    const paths = hits.map((h) => h.path).sort();
    expect(paths).toEqual(["AGENTS.md", "core-ts/src/sandbox.ts", "core-ts/src/tools/git.ts"]);
    // 每一条都必须带「为什么」（评审弹窗要给人看理由）
    for (const h of hits) { expect(h.why.length).toBeGreaterThan(4); }
  });

  it("numstat 解析：普通行累加 add+del；二进制行按 0 计；空输出为 0", () => {
    expect(parseNumstat("10\t2\ta.ts\n3\t0\tb.ts\n")).toEqual({ files: 2, lines: 15 });
    expect(parseNumstat("-\t-\timage.png\n1\t1\tc.ts\n")).toEqual({ files: 2, lines: 2 });
    expect(parseNumstat("")).toEqual({ files: 0, lines: 0 });
  });

  it("Lint Gate 阈值：>30 文件 或 >800 行 ⇒ 巨型（边界值不算）", () => {
    expect(MAX_CHANGED_FILES_PER_COMMIT).toBe(30);
    expect(MAX_CHANGED_LINES_PER_COMMIT).toBe(800);
    expect(isHugeCommit(30, 800)).toBe(false);
    expect(isHugeCommit(31, 800)).toBe(true);
    expect(isHugeCommit(30, 801)).toBe(true);
  });

  it("提交参数校验：type 白名单 / subject 非空且 ≤88 / scope 形态 / decision ≤200", () => {
    expect(validateCommitArgs({ type: "feat", scope: "gui", subject: "加个按钮", decision: "" })).toEqual([]);
    for (const t of ALLOWED_COMMIT_TYPES) {
      expect(validateCommitArgs({ type: t, scope: "", subject: "x", decision: "" }), `合法 type 被误拒：${t}`).toEqual([]);
    }
    expect(validateCommitArgs({ type: "wip", scope: "", subject: "x", decision: "" }).join()).toContain("type");
    expect(validateCommitArgs({ type: "fix", scope: "", subject: "  ", decision: "" }).join()).toContain("subject");
    expect(validateCommitArgs({ type: "fix", scope: "", subject: "长".repeat(89), decision: "" }).join()).toContain("过长");
    expect(validateCommitArgs({ type: "fix", scope: "BAD", subject: "x", decision: "" }).join()).toContain("scope");
    expect(validateCommitArgs({ type: "fix", scope: "", subject: "x", decision: "d".repeat(201) }).join()).toContain("decision");
  });

  it("相对路径校验：数组必需；`.`/`*`/盘符/绝对路径/`..` 一律拒", () => {
    expect(validateRelPaths(["a/b.ts", "c.ts"]).ok).toBe(true);
    for (const bad of [[], "a.ts", ["."], ["./"], ["*"], ["C:/x.ts"], ["/etc/passwd"], ["a/../../x.ts"], [""], [42]]) {
      expect(validateRelPaths(bad as unknown).ok, `应拒：${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("commit message：标题形态 + 身份头 + trailers 顺序 + body 里的 trailer 行被剔除", () => {
    const msg = buildCommitMessage({
      type: "feat", scope: "gui", subject: "加个按钮",
      body: "正文第一行\nAgent-ID: 伪造的\ntrailer: 伪装\n正文第二行",
      agentId: "a1", agentName: "甲", agentRole: "工程师",
      agentModel: "m/1", sessionId: "s1", decision: "选 A 不选 B",
    });
    expect(msg.startsWith("feat(gui): 加个按钮\n")).toBe(true);
    expect(msg).toContain("我是 甲，工程师");
    expect(msg).toContain("正文第一行");
    expect(msg).toContain("正文第二行");
    // body 里伪造的 trailer 行必须被剔除（防身份伪造），Agent-ID 只出现一次且是注入值
    expect(msg).not.toContain("Agent-ID: 伪造的");
    expect(msg.match(/^Agent-ID: /gm)?.length).toBe(1);
    expect(msg).toContain("Agent-ID: a1");
    // trailers 关键项与顺序（Origin 在 Co-Authored-By 之前；Signed-off-by 收尾）
    const originIdx = msg.indexOf("Agent-Origin: slime/v1");
    const coIdx = msg.indexOf("Co-Authored-By: slime-a1 <agent+a1@slime.local>");
    const signIdx = msg.indexOf("Signed-off-by: slime-a1 <agent+a1@slime.local>");
    expect(originIdx).toBeGreaterThan(-1);
    expect(coIdx).toBeGreaterThan(originIdx);
    expect(signIdx).toBeGreaterThan(coIdx);
    expect(msg).toContain("Agent-Decision: 选 A 不选 B");
  });

  it("commit message：chore(meta) 纯元数据不带身份头（AGENTS.md §0 例外）", () => {
    const msg = buildCommitMessage({
      type: "chore", scope: "meta", subject: "整理", body: "",
      agentId: "a1", agentName: "甲", agentRole: "工程师",
      agentModel: "", sessionId: "", decision: "",
    });
    expect(msg).not.toContain("我是 甲");
    expect(msg).toContain("Agent-Origin: slime/v1");
  });

  it("分支名校验：必须 slime/ 前缀；段 2 必须是本 Agent 的 id 或 swarm/tmp 形态", () => {
    expect(validateSlimeBranchName("slime/a1/task-x", "a1")).toEqual([]);
    expect(validateSlimeBranchName("slime/a1/subtask/1-x", "a1")).toEqual([]);
    expect(validateSlimeBranchName("slime/swarm/s1/w1", "a1")).toEqual([]);
    expect(validateSlimeBranchName("slime/tmp/a1/123", "a1")).toEqual([]);
    expect(validateSlimeBranchName("feature/x", "a1").join()).toContain("slime/");
    expect(validateSlimeBranchName("slime/OTHER/task", "a1").join()).toContain("本 Agent 的 id");
    expect(validateSlimeBranchName("slime/a1/Task", "a1").join()).toContain("规范");
    expect(validateSlimeBranchName("slime/tmp/other/1", "a1").join()).toContain("本 Agent 的 id");
  });

  it("门禁分类：纯文档跳过；ts / py / 混合各归各的套件", () => {
    expect(classifyGate(["docs/x.md", "README.md"])).toBe("skip-docs");
    expect(classifyGate(["core-ts/src/a.ts", "gui/src/b.tsx"])).toBe("ts");
    expect(classifyGate(["tools/git.py"])).toBe("py");
    expect(classifyGate(["tools/git.py", "core-ts/src/a.ts"])).toBe("ts+py");
    // 文档区外的 md（如源码目录里的说明文件）不算纯文档 —— 与 Python 侧同口径
    expect(classifyGate(["core-ts/src/notes.md"])).toBe("ts");
  });

  it("评审详情：stat + 片段 + 门禁 + 受保护模块高亮必须有", () => {
    const detail = buildReviewDetail({
      branch: "slime/a1/t",
      title: "feat(gui): x",
      stats: { files: 2, lines: 40 },
      statText: " a.ts | 40 +++",
      patchSample: "+new line",
      qaSummary: "ts 套件通过",
      protectedModules: [{ path: "core-ts/src/sandbox.ts", why: "沙箱/权限" }],
    });
    expect(detail).toContain("slime/a1/t");
    expect(detail).toContain("2 个文件 / +-40 行");
    expect(detail).toContain("ts 套件通过");
    expect(detail).toContain("受保护模块");
    expect(detail).toContain("core-ts/src/sandbox.ts");
    expect(detail).toContain("── diff --stat ──");
  });
});

describe("A-1198-G ② 行为：真仓库里跑三道闸", () => {
  it("git_status：非仓库拒绝；仓库返回分支 + 保护标记", async () => {
    const dir = await repo();
    const s = await gitStatus({ _workspace: dir });
    expect(s).toContain("🔒 受保护分支");
    expect(s).toContain("分支：main");
    const outside = await gitStatus({ _workspace: tmpdir() });
    // tmpdir 本身可能恰好在某个仓库里（CI 罕见但存在）⇒ 只断言「不是当前仓库」时必拒
    if (!outside.includes(dir)) {
      expect(outside).toContain("[拒绝]");
    }
  });

  it("git_stage：缺 paths 拒；`..` 拒；正常逐条暂存并回报清单", async () => {
    const dir = await repo();
    expect(await gitStage({ _workspace: dir })).toContain("[拒绝]");
    expect(await gitStage({ _workspace: dir, paths: ["../x.txt"] })).toContain("[拒绝]");
    await writeFile(join(dir, "a.txt"), "A\n", "utf8");
    const r = await gitStage({ _workspace: dir, paths: ["a.txt"] });
    expect(r).toContain("已暂存 1 条路径");
    expect(r).toContain("a.txt");
  });

  it("git_branch：命名不合规拒；new 后真核验 ref 存在；checkout 生效；受保护名一律拒", async () => {
    const dir = await repo();
    expect(await gitBranch({ ...ident(), _workspace: dir, action: "new", name: "feature/x" })).toContain("[拒绝]");
    expect(await gitBranch({ ...ident(), _workspace: dir, action: "new", name: "slime/other/t" })).toContain("[拒绝]");
    const created = await gitBranch({ ...ident(), _workspace: dir, action: "new", name: "slime/test-agent/t1" });
    expect(created).toContain("已创建分支");
    expect(await refHash(dir, "slime/test-agent/t1"), "new 后 ref 必须真实存在（斜杠缺陷兜底）").not.toBe("");
    await gitBranch({ ...ident(), _workspace: dir, action: "checkout", name: "slime/test-agent/t1" });
    expect(await currentBranch(dir)).toBe("slime/test-agent/t1");
    // 受保护名（main）连 slime/ 前缀都没有 ⇒ 必拒
    expect(await gitBranch({ ...ident(), _workspace: dir, action: "checkout", name: "main" })).toContain("[拒绝]");
  });

  it("git_commit 门禁①身份：缺注入 ⇒ 拒绝（不给假身份兜底）", async () => {
    const dir = await repo();
    await stageFile(dir, "a.txt", "A\n");
    const r = await gitCommit({ _workspace: dir, type: "feat", subject: "x" });
    expect(r).toContain("身份铁律");
    expect(r).toContain("[拒绝");
  });

  it("git_commit 门禁②参数与③受保护分支：非法 type 拒；main 上提交拒", async () => {
    const dir = await repo();
    await stageFile(dir, "a.txt", "A\n");
    const bad = await gitCommit({ ...ident(), _workspace: dir, type: "wip", subject: "x" });
    expect(bad).toContain("type");
    const prot = await gitCommit({ ...ident(), _workspace: dir, type: "feat", subject: "x" });
    expect(prot).toContain("受保护分支");
    expect(prot).toContain("git_branch");
  });

  it("git_commit 门禁④空暂存拒；⑤Lint Gate 拒巨型、allow_huge 放行", async () => {
    const dir = await repo();
    await gitBranch({ ...ident(), _workspace: dir, action: "new", name: "slime/test-agent/t2" });
    await gitBranch({ ...ident(), _workspace: dir, action: "checkout", name: "slime/test-agent/t2" });
    const empty = await gitCommit({ ...ident(), _workspace: dir, type: "feat", subject: "x" });
    expect(empty).toContain("暂存区为空");

    qaGreen();
    reviewStub(true);
    await stageFile(dir, "big.txt", `${"x".repeat(20)}\n`.repeat(900)); // 900 行 > 800
    const huge = await gitCommit({ ...ident(), _workspace: dir, type: "feat", subject: "big" });
    expect(huge).toContain("Lint Gate");
    const ok = await gitCommit({ ...ident(), _workspace: dir, type: "feat", subject: "big", allow_huge_commit: true });
    expect(ok).toContain("✅ 已提交");
  });

  it("git_commit 门禁⑥受保护模块：允许提交但评审请求必须高亮（人显式点头）", async () => {
    const dir = await repo();
    await gitBranch({ ...ident(), _workspace: dir, action: "new", name: "slime/test-agent/t3" });
    await gitBranch({ ...ident(), _workspace: dir, action: "checkout", name: "slime/test-agent/t3" });
    qaGreen();
    let seen: GitReviewRequest | null = null;
    reviewStub(true, (req) => { seen = req; });
    // AGENTS.md 是受保护模块（在 tmp 仓库里造一个同名文件）
    await stageFile(dir, "AGENTS.md", "# 治理层\n");
    const r = await gitCommit({ ...ident(), _workspace: dir, type: "docs", subject: "改治理文档" });
    expect(r).toContain("✅ 已提交");
    expect(seen, "评审回调必须被调用").not.toBeNull();
    expect(seen!.protectedModules.map((m) => m.path)).toContain("AGENTS.md");
  });

  it("git_commit 门禁⑦质量门禁：红 ⇒ 拒；源码改动 skip_qa ⇒ 拒；纯文档豁免", async () => {
    const dir = await repo();
    await gitBranch({ ...ident(), _workspace: dir, action: "new", name: "slime/test-agent/t4" });
    await gitBranch({ ...ident(), _workspace: dir, action: "checkout", name: "slime/test-agent/t4" });
    await stageFile(dir, "a.ts", "export const a = 1;\n");
    reviewStub(true);
    setGitQaRunner(async () => ({ kind: "ts", ok: false, detail: { vitest: "FAIL" }, logTail: "1 failed" }));
    const red = await gitCommit({ ...ident(), _workspace: dir, type: "feat", subject: "x" });
    expect(red).toContain("质量门禁");
    expect(red).toContain("1 failed");
    const skip = await gitCommit({ ...ident(), _workspace: dir, type: "feat", subject: "x", skip_qa: true });
    expect(skip).toContain("不得跳过质量门禁");
    // 纯文档：不跑门禁（runner 会红也不该被调用）
    setGitQaRunner(async () => { throw new Error("纯文档不应调 runner"); });
    await stageFile(dir, "docs/only.md", "# 文档\n");
    const docs = await gitCommit({ ...ident(), _workspace: dir, type: "docs", subject: "只改文档" });
    expect(docs).toContain("✅ 已提交");
  });

  it("git_commit 门禁⑧评审：拒绝 ⇒ 不落库（HEAD 不变）；通道缺失 ⇒ 拒绝", async () => {
    const dir = await repo();
    await gitBranch({ ...ident(), _workspace: dir, action: "new", name: "slime/test-agent/t5" });
    await gitBranch({ ...ident(), _workspace: dir, action: "checkout", name: "slime/test-agent/t5" });
    qaGreen();
    await stageFile(dir, "a.ts", "export const a = 1;\n");
    const before = (await gitRun(dir, ["rev-parse", "HEAD"])).stdout.trim();

    reviewStub(false);
    const denied = await gitCommit({ ...ident(), _workspace: dir, type: "feat", subject: "x" });
    expect(denied).toContain("评审门");
    expect(denied).toContain("stub 拒绝");
    const after = (await gitRun(dir, ["rev-parse", "HEAD"])).stdout.trim();
    expect(after, "评审拒绝后 HEAD 必须不动（没落任何 commit）").toBe(before);

    setGitReviewCallback(null);
    const noChannel = await gitCommit({ ...ident(), _workspace: dir, type: "feat", subject: "x" });
    expect(noChannel).toContain("未配置差异评审通道");
  });

  it("git_commit happy path：真提交 + 身份 author + trailers + git note + ref 前进", async () => {
    const dir = await repo();
    await gitBranch({ ...ident(), _workspace: dir, action: "new", name: "slime/test-agent/t6" });
    await gitBranch({ ...ident(), _workspace: dir, action: "checkout", name: "slime/test-agent/t6" });
    qaGreen();
    reviewStub(true);
    await stageFile(dir, "a.ts", "export const a = 1;\n");
    const r = await gitCommit({
      ...ident(), _workspace: dir, type: "feat", scope: "core-ts",
      subject: "加个能力", body: "正文说明", decision: "走工具层",
    });
    expect(r).toContain("✅ 已提交");
    expect(r).toContain("溯源 note");

    const hash = (await gitRun(dir, ["rev-parse", "HEAD"])).stdout.trim();
    expect(hash).not.toBe("");
    // author = Agent 身份（绝不冒充人类）
    const an = (await gitRun(dir, ["log", "-1", "--format=%an <%ae>"])).stdout.trim();
    expect(an).toBe("slime-test-agent <agent+test-agent@slime.local>");
    // 身份头 + trailers
    const bodyFull = (await gitRun(dir, ["log", "-1", "--format=%B"])).stdout;
    expect(bodyFull).toContain("我是 测试员，守卫测试");
    expect(bodyFull).toContain("Agent-ID: test-agent");
    expect(bodyFull).toContain("Agent-Origin: slime/v1");
    expect(bodyFull).toContain("Agent-Decision: 走工具层");
    // ref 真的前进了（分支指向 HEAD；reflog 真值校验）
    const refNow = await refHash(dir, "slime/test-agent/t6");
    expect(refNow).toBe(hash);
    // git note（slime-intent）真实写入
    const note = (await gitRun(dir, ["notes", "--ref=slime-intent", "show", hash])).stdout;
    expect(note).toContain("\"agent_id\": \"test-agent\"");
    expect(note).toContain("\"commit_type\": \"feat\"");
  });
});

describe("A-1198-G ③ 接线：身份注入 / 评审通道 / 弹窗 / 注册（源码形状）", () => {
  it("tool_loop：git 工具名集合 + _agent_* 注入（Agent 无法自报身份）", () => {
    expect(TOOL_LOOP_SRC).toContain("const GIT_TOOL_NAMES = new Set([\"git_status\", \"git_diff\", \"git_stage\", \"git_branch\", \"git_commit\"]);");
    expect(TOOL_LOOP_SRC).toContain("if (GIT_TOOL_NAMES.has(tc.name)) {");
    for (const f of ["args._agent_id = agentId;", "args._agent_name = agentName;", "args._agent_role = agentRole;", "args._agent_model = agentModel;", "args._session_id = sessionId ?? \"\";"]) {
      expect(TOOL_LOOP_SRC, `注入缺 ${f}`).toContain(f);
    }
    // 参数里的同名字段必须先删后注（防 Agent 传自己的假身份）
    expect(TOOL_LOOP_SRC).toContain("delete args._agent_id;");
    expect(TOOL_LOOP_SRC).toContain("delete args._agent_role;");
  });

  it("engine：两处 ToolLoop 调用都传 agentRole（身份头的 role 来源）", () => {
    expect(ENGINE_SRC).toContain("loop.run({ agentId: opts.agent.id, agentName: opts.agent.name, agentRole: opts.agent.role,");
    expect(ENGINE_SRC).toMatch(/\.runStream\(\{\n\s*agentId: opts\.agent\.id,\n\s*agentName: opts\.agent\.name,\n\s*agentRole: opts\.agent\.role,/);
  });

  it("builtin：registerGitTools 被调用（工具进默认工具面）", () => {
    expect(BUILTIN_SRC).toContain("import { registerGitTools } from \"./git.js\";");
    expect(BUILTIN_SRC).toContain("registerGitTools(registry);");
  });

  it("main：评审通道注入 + 后台子代理/无窗口一律拒 + detail 走 buildReviewDetail", () => {
    expect(MAIN_SRC).toContain("setGitReviewCallback(requestGitReview);");
    expect(MAIN_SRC).toContain("function requestGitReview(req: GitReviewRequest)");
    expect(MAIN_SRC).toContain("detail: buildReviewDetail(req),");
    expect(MAIN_SRC).toContain("SUBAGENT_SESSION_PREFIX");
    expect(MAIN_SRC).toMatch(/commit 差异评审不适用/);
    // 超时与权限弹窗同口径
    expect(MAIN_SRC).toMatch(/PERM_TIMEOUT_MS\);\n\s*\/\/ 超时|差异评审超时/);
  });

  it("渲染层：权限弹窗渲染 detail 长文本；ipc 类型带 detail 字段", () => {
    /* ⚠️ 断言必须锚到**这一处**：ChatPanel 里 pendingPerm.detail 出现两次（条件 + pre 体）、
       ipc.ts 里 detail?: string; 有五处 —— 只断言裸字符串会被别处喂饱（M21/M22 实测假存活）。 */
    expect(CHAT_PANEL_SRC).toContain("{pendingPerm.detail && (");
    expect(CHAT_PANEL_SRC).toContain(">{pendingPerm.detail}</pre>");
    expect(IPC_SRC).toContain("/** A-1198：可选长文本详情");
    expect(IPC_SRC).toMatch(/\/\*\* A-1198：可选长文本详情[\s\S]{0,120}detail\?: string;/);
  });

  it("git.ts 自身的关键承诺：身份 -c 注入 / note ref / 斜杠 ref 修复 / 无 merge 工具", () => {
    expect(GIT_SRC).toContain("user.name=slime-");
    expect(GIT_SRC).toContain("agent+");
    expect(GIT_SRC).toContain("notes\", \"--ref=slime-intent\"");
    expect(GIT_SRC).toContain("verifyAndRepairRef(repo.root, branch)");
    // 无合并权：本层不得注册任何 merge/rebase/cherry-pick/push 工具
    const names = [...GIT_SRC.matchAll(/name: "(git_[a-z_]+)",/g)].map((m) => m[1]).sort();
    expect(names).toEqual(["git_branch", "git_commit", "git_diff", "git_stage", "git_status"]);
    expect(GIT_SRC).not.toMatch(/name: "git_(merge|rebase|cherry|push|reset)/);
  });
});
