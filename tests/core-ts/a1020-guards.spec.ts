










































import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAIN_DIR = join(ROOT, "gui/src/main");
const MAIN_INDEX = join(MAIN_DIR, "index.ts");






function blankComments(src: string): string {
  const sf = ts.createSourceFile("scan.ts", src, ts.ScriptTarget.Latest,  true);
  const chars = src.split("");
  const blank = (r: { pos: number; end: number }): void => {
    for (let i = r.pos; i < r.end; i++) {
      if (chars[i] !== "\n") { chars[i] = " "; }
    }
  };
  const visit = (node: ts.Node): void => {
    for (const r of ts.getLeadingCommentRanges(src, node.getFullStart()) ?? []) { blank(r); }
    for (const r of ts.getTrailingCommentRanges(src, node.getEnd()) ?? []) { blank(r); }
    let kids: readonly ts.Node[] = [];
    try { kids = node.getChildren(sf); } catch { kids = []; }
    for (const k of kids) { visit(k); }
  };
  visit(sf);
  return chars.join("");
}


function collectRegistrations(src: string, file: string): Array<{ channel: string; line: number; where: string }> {
  const clean = blankComments(src);
  const re = /\b(handleTrusted|ipcMain\s*\.\s*handle|ipcMain\s*\.\s*on|ipcMain\s*\.\s*handleOnce)\s*(?:<[^>]*>)?\s*\(\s*(["'])([^"']+)\2/g;
  const out: Array<{ channel: string; line: number; where: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const line = clean.slice(0, m.index).split("\n").length;
    out.push({ channel: m[3], line, where: `${file}:${line}` });
  }
  return out;
}


function handleTrustedBody(src: string): string {
  const clean = blankComments(src);
  const head = clean.indexOf("function handleTrusted");
  if (head < 0) { return ""; }
  const open = clean.indexOf("{", head);
  if (open < 0) { return ""; }
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === "{") { depth++; }
    else if (clean[i] === "}") { depth--; if (depth === 0) { return clean.slice(open, i + 1); } }
  }
  return clean.slice(open);
}


function dedupBranch(src: string): string {
  const clean = blankComments(src);
  const at = clean.indexOf("REGISTERED_CHANNELS.has(channel)");
  if (at < 0) { return ""; }
  const open = clean.indexOf("{", at);
  if (open < 0) { return ""; }
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === "{") { depth++; }
    else if (clean[i] === "}") { depth--; if (depth === 0) { return clean.slice(open, i + 1); } }
  }
  return clean.slice(open);
}

function mainTsFiles(): string[] {
  return readdirSync(MAIN_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => e.name);
}

describe("A-1020 ① IPC channel 不许重复注册", () => {
  it("gui/src/main 下全部 channel 注册唯一", () => {
    const byChannel = new Map<string, string[]>();
    for (const f of mainTsFiles()) {
      for (const r of collectRegistrations(readFileSync(join(MAIN_DIR, f), "utf8"), f)) {
        const list = byChannel.get(r.channel) ?? [];
        list.push(r.where);
        byChannel.set(r.channel, list);
      }
    }

    
    expect(byChannel.size).toBeGreaterThan(100);

    const dups = [...byChannel.entries()]
      .filter(([, locs]) => locs.length > 1)
      .map(([ch, locs]) => `"${ch}" 注册了 ${locs.length} 次 → ${locs.join(", ")}`);

    expect(dups, `重复注册的 IPC channel（会让整个 app 打不开）:\n${dups.join("\n")}`).toEqual([]);
  });

  it("剥离器把注释真的抹掉了（反假阳：抹掉后不该再出现注释里的 channel 名）", () => {
    const src = readFileSync(MAIN_INDEX, "utf8");
    const clean = blankComments(src);
    expect(clean.split("\n").length).toBe(src.split("\n").length); 
    
    const rawHits = (src.match(/slime:theme:set/g) ?? []).length;
    const cleanHits = (clean.match(/slime:theme:set/g) ?? []).length;
    expect(rawHits).toBeGreaterThan(cleanHits);
    expect(cleanHits).toBeGreaterThanOrEqual(1);
  });

  it("注册总数守恒（防止守卫被绕过/正则失效）", () => {
    let total = 0;
    for (const f of mainTsFiles()) {
      total += collectRegistrations(readFileSync(join(MAIN_DIR, f), "utf8"), f).length;
    }
    
    expect(total).toBeGreaterThanOrEqual(150);
  });
});

describe("A-1020 ② handleTrusted 必须保留运行期去重防护", () => {
  const src = readFileSync(MAIN_INDEX, "utf8");

  it("有已注册 channel 的记录（Set）", () => {
    expect(src).toMatch(/const\s+REGISTERED_CHANNELS\s*=\s*new\s+Set<string>\s*\(\s*\)/);
  });

  it("重复注册时先 removeHandler 再注册（而不是让 ipcMain 抛错）", () => {
    const fnBody = handleTrustedBody(src);
    expect(fnBody).toContain("REGISTERED_CHANNELS.has(channel)");
    expect(fnBody).toContain("ipcMain.removeHandler(channel)");
    expect(fnBody).toContain("REGISTERED_CHANNELS.add(channel)");
  });

  it("不许静默 —— 覆盖旧 handler 时必须留下醒目错误", () => {
    
    
    
    const branch = dedupBranch(src);
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toMatch(/console\.error\([\s\S]{0,200}重复注册/);
  });
});

