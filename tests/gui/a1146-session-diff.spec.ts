/**
 * tests/gui/a1146-session-diff.spec.ts — 「右栏对比：本次会话的改动」的守卫（A-1146）。
 *
 * ## 用户原话
 * 「右侧边栏的对比功能还是限定死了在 git 仓库，我觉得应该可以像对话里面的一样，展现此次变动。」
 *
 * ## 为什么这不是"加个数据源"那么简单
 * 大量文件**根本不在 Git 仓库里**（新项目 / 临时脚本 / Agent 现生成的文件）⇒ 以前点「对比改动」
 * 只会得到一句"不在 Git 仓库内…请用聊天区工具卡查看" ⇒ 用户视角等于功能不存在。
 * 现在两个数据源在**同一处**合流：**会话产物（此次变动）优先，Git HEAD 兜底**。
 *
 * ## 三条必须钉死的不变量
 *  ① **取最新那一次**：同一文件被写多次、跨多个 assistant 序数时，要的是"此次变动"；
 *  ② **`diffTrimmed` 不许返回 null**（落盘限流摘掉了全文）—— 静默返回 null 会让界面
 *     以为"这次没改过"，而它其实改过（A-1029 的整条教训就是"限流可以，沉默不行"）；
 *  ③ **只认写入**：`file_read` 之类没有"变更"可比。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { findSessionFileDiff, type ProductItem } from "../../gui/src/renderer/pages/chatProducts.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const write = (rel: string, name = rel, diffFull: { old: string; new: string } | null = { old: "x\n", new: "x\ny\n" }): ProductItem => ({
  rel, name, kind: "write", ext: ".py", ...(diffFull ? { diffFull } : {}),
});

describe("A-1146 ① `findSessionFileDiff`：取的是「此次变动」", () => {
  it("找不到 ⇒ `null`（不编造）", () => {
    expect(findSessionFileDiff({ "3": [write("b.py")] }, "a.py")).toBeNull();
    expect(findSessionFileDiff(null, "a.py")).toBeNull();
    expect(findSessionFileDiff({ "3": [write("a.py")] }, "  ")).toBeNull();
  });

  it("跨序数取**最新**那一次（用户要的是「此次」，不是历史全量）", () => {
    const byOrd = {
      "3": [write("a.py", "a.py", { old: "old-3\n", new: "new-3\n" })],
      "9": [write("a.py", "a.py", { old: "old-9\n", new: "new-9\n" })],
      "5": [write("a.py", "a.py", { old: "old-5\n", new: "new-5\n" })],
    };
    expect(findSessionFileDiff(byOrd, "a.py")!.new).toBe("new-9\n");
  });

  it("同一序数内多条同名 ⇒ 取**最后**一条（一次回复里改了同一个文件两次）", () => {
    const byOrd = { "2": [write("a.py", "a.py", { old: "1\n", new: "2\n" }), write("a.py", "a.py", { old: "2\n", new: "3\n" })] };
    expect(findSessionFileDiff(byOrd, "a.py")!.old).toBe("2\n");
  });

  it("路径写法不同也算同一个文件（`./a/b` 与 `a\\b`、大小写）", () => {
    const byOrd = { "1": [write("./dir/A.py", "A.py")] };
    expect(findSessionFileDiff(byOrd, "dir\\a.py")).not.toBeNull();
  });

  it("只认**写入**（file_read 没有「变更」可比）", () => {
    const byOrd = { "1": [{ ...write("a.py"), kind: "read" as const }] };
    expect(findSessionFileDiff(byOrd, "a.py")).toBeNull();
  });

  it("⚠️ `diffTrimmed` ⇒ 返回 `trimmed: true` 而**不是 null**（界面要如实说「改过但详情没存」）", () => {
    const byOrd = { "1": [{ ...write("a.py", "a.py", null), diffTrimmed: true, diff: { add: 3, del: 1 } }] };
    const r = findSessionFileDiff(byOrd, "a.py");
    expect(r).not.toBeNull();
    expect(r!.trimmed).toBe(true);
  });
});

describe("A-1146 ② 接线：右栏真的会去查会话产物", () => {
  const src = read("gui/src/renderer/pages/RightSidebar.tsx");

  it("`FileTab` 拿得到会话标识（主组件透传，否则子组件里没有数据源）", () => {
    expect(src).toContain("agentId?: string | null;");
    expect(src).toContain("sessionId?: string }): JSX.Element");
    /* ⚠️ 锚 props 的**声明与调用两处**：只锚声明的话，主组件忘了往下传 ⇒ 一样拿不到数据。 */
    expect(src).toContain("agentId={props.agentId}");
    expect(src).toContain("sessionId={props.sessionId}");
  });

  it("`toggleDiff` **先**查会话产物、命中就直接看它（不碰 Git）", () => {
    expect(src).toMatch(/findSessionFileDiff\(readSessionProducts\(aid, sid\)/);
    expect(src).toMatch(/if \(hit && !hit\.trimmed\) \{[\s\S]{0,200}?setDiffSource\("session"\)/);
  });

  it("渲染分支按来源取基准文本（会话用 old/new，Git 用 HEAD/当前）", () => {
    expect(src).toContain("useSession && sd ? sd.old : (diffHead ?? \"\")");
    expect(src).toContain("useSession && sd ? sd.new : preview.content");
    /* 两份 diff 视图不许各写一份（样式与统计口径会漂） */
    expect((src.match(/diffLinesFn\(/g) ?? []).length).toBe(1);
  });

  it("标题如实标注来源；`trimmed` 时不静默", () => {
    expect(src).toContain("本次会话的改动（");
    expect(src).toContain("Git HEAD → 当前");
    expect(src).toMatch(/sessionDiff\?\.trimmed[\s\S]{0,200}?详情未随会话记录保存/);
  });
});
