





import type { GitDiffHunk } from "../shared/ipc.js";

export interface ParsedDiff {
  hunks: GitDiffHunk[];
  additions: number;
  deletions: number;
}


export function parseUnifiedDiff(out: string): ParsedDiff {
  const lineArr = out.replace(/\r\n/g, "\n").split("\n");
  
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
    if (!cur) { continue; } 
    const ch = line[0];
    if (ch === "+") { cur.lines.push({ type: "add", text: line.slice(1) }); additions++; }
    else if (ch === "-") { cur.lines.push({ type: "del", text: line.slice(1) }); deletions++; }
    else { cur.lines.push({ type: "ctx", text: line.slice(1) }); } 
  }
  return { hunks, additions, deletions };
}