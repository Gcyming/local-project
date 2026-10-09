

















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

  /* ⚠️ 2026-10-08（用户实测：右栏对「本次会话明明改过」的文件报「不在 git 仓内」）：
     右栏预览给的是**绝对路径**（tab.fileAbs），而产物记录的 rel 是**工具 detail 原样**
     （常见为工作区相对）——所以要按 workspace 做「绝对 ↔ 相对」等价匹配。 */
  it("⚠️ 绝对 ↔ 工作区相对：右栏给绝对、产物存相对 —— 必须仍能对上", () => {
    const byOrd = { "1": [write("opencode-zen/gemmy.proj", "gemmy.proj")] };
    const ws = "D:/pilot project";
    expect(findSessionFileDiff(byOrd, "D:/pilot project/opencode-zen/gemmy.proj", ws)).not.toBeNull();
  });

  it("⚠️ 反方向同样成立：want 是相对**子路径**、产物存绝对（name 兜不住时才见真章）", () => {
    /* ⚠️ 刻意用**子路径**（sub/a.py）而不是顶层文件：顶层时产物的 `name` 恰好等于 want，
       会把「相对 → 绝对」别名分支失效的变异**假绿**掉（实测踩过）。 */
    const byOrd = { "1": [write("D:/pilot project/sub/a.py", "a.py")] };
    expect(findSessionFileDiff(byOrd, "sub/a.py", "D:/pilot project")).not.toBeNull();
  });

  it("⚠️ 等价匹配只做**前缀级**推算，不做 basename 兜底（同名不同目录不许张冠李戴）", () => {
    const byOrd = { "1": [write("other/sub/a.py", "a.py")] };
    expect(findSessionFileDiff(byOrd, "D:/pilot project/tools/a.py", "D:/pilot project")).toBeNull();
  });

  it("不传 workspace（旧调用方）⇒ 行为与原来一致：只做字面（归一后）比较", () => {
    const byOrd = { "1": [write("a.py")] };
    expect(findSessionFileDiff(byOrd, "a.py")).not.toBeNull();
    expect(findSessionFileDiff(byOrd, "D:/pilot project/a.py")).toBeNull();
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
    
    expect((src.match(/diffLinesFn\(/g) ?? []).length).toBe(1);
  });

  it("标题如实标注来源；`trimmed` 时不静默", () => {
    expect(src).toContain("本次会话的改动（");
    expect(src).toContain("Git HEAD → 当前");
    expect(src).toMatch(/sessionDiff\?\.trimmed[\s\S]{0,200}?详情未随会话记录保存/);
  });
});
