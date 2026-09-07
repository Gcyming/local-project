/**
 * gui/src/main/git_diff.ts — git unified diff 解析（A-968 红绿标注渲染）。
 * 纯函数、无 Node/Electron 依赖，vitest 可直测。
 * 从 `git diff HEAD -- <file>`（或 --cached）的 stdout 提取 @@ 块与 +/-/空格 行，
 * 供右侧栏 Git 面板按 新增=绿 / 删除=红 / 上下文=原色 渲染。
 */
import type { GitDiffHunk } from "../shared/ipc.js";

export interface ParsedDiff {
  hunks: GitDiffHunk[];
  additions: number;
  deletions: number;
}

/** 解析 unified diff 文本 → hunks + 行数统计（diff --no-color 输出；兼容 \r\n） */
export function parseUnifiedDiff(out: string): ParsedDiff {
  const lineArr = out.replace(/\r\n/g, "\n").split("\n");
  // 剥离 split 尾随空串（diff 输出以换行结尾的正常产物，避免渲染出多余空行）
  if (lineArr.length > 0 && lineArr[lineArr.length - 1] === "") { lineArr.pop(); }
  const hunks: GitDiffHunk[] = [];
  let cur: GitDiffHunk | null = null;
  let additions = 0;
  let deletions = 0;
  for (const line of lineArr) {
    if (line.startsWith("@@")) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) { continue; } // @@ 之前的 ---/+++ 文件头，跳过
    const ch = line[0];
    if (ch === "+") { cur.lines.push({ type: "add", text: line.slice(1) }); additions++; }
    else if (ch === "-") { cur.lines.push({ type: "del", text: line.slice(1) }); deletions++; }
    else { cur.lines.push({ type: "ctx", text: line.slice(1) }); } // 上下文 + "\ No newline …" 提示
  }
  return { hunks, additions, deletions };
}