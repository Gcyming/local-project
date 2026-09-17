/**
 * tests/gui/git-diff.spec.ts — A-968 git unified diff 解析单测（纯函数）。
 * 验证右栏 Git 面板的红绿标注渲染数据源：@@ 块切分、+/-/上下文归类、行数统计、\r\n 兼容。
 */
import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "../../gui/src/main/git_diff.js";

describe("parseUnifiedDiff (A-968 git 变更红绿标注)", () => {
  it("解析标准 modified diff：hunks 切分 + 行归类 + 统计", () => {
    const sample = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index abc123..def456 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,4 +1,5 @@",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 22;",
      "+const z = 3;",
      " const end = x;",
    ].join("\n");
    const r = parseUnifiedDiff(sample);
    expect(r.hunks.length).toBe(1);
    expect(r.hunks[0].header).toBe("@@ -1,4 +1,5 @@");
    expect(r.hunks[0].lines.map((l) => l.type)).toEqual(["ctx", "del", "add", "add", "ctx"]);
    expect(r.hunks[0].lines.map((l) => l.text)).toEqual(["const x = 1;", "const y = 2;", "const y = 22;", "const z = 3;", "const end = x;"]);
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(1);
  });

  it("多 hunk 拆分（@@ 头重新开始新块）", () => {
    const sample = [
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+bb",
      "@@ -10,2 +10,3 @@",
      " keep",
      "+added",
    ].join("\n");
    const r = parseUnifiedDiff(sample);
    expect(r.hunks.length).toBe(2);
    expect(r.hunks[0].lines.filter((l) => l.type === "del").length).toBe(1);
    expect(r.hunks[1].lines.filter((l) => l.type === "add").length).toBe(1);
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(1);
  });

  it("无 @@ 的杂散行（---/+++ 文件头）被忽略", () => {
    const r = parseUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n");
    expect(r.hunks.length).toBe(0);
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(0);
  });

  it("兼容 CRLF 输出", () => {
    const r = parseUnifiedDiff("@@ -1 +1 @@\r\n-old\r\n+new\r\n");
    expect(r.hunks[0].lines.map((l) => l.type)).toEqual(["del", "add"]);
    expect(r.hunks[0].lines[1].text).toBe("new");
  });

  it("空输入返回空结果（不崩溃）", () => {
    const r = parseUnifiedDiff("");
    expect(r.hunks).toEqual([]);
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(0);
  });
});