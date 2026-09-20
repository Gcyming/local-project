/**
 * tests/core-ts/a1020-guards.spec.ts — A-1020（"打都打不开了"）的结构守卫。
 *
 * 症状：`pnpm dev` 起不来，主进程抛
 *   `Error: Attempted to register a second handler for 'slime:theme:set'`
 *
 * 根因（我自己上一轮引入的）：A-1019 给 `slime:theme:set` 补"启动期持久化"时，
 *   **加了新 handler 却忘删旧的**，于是同一 channel 注册两次。
 *
 * 为什么这条值得单独钉守卫 —— 它的失败模式特别恶：
 *   ① `ipcMain.handle` 对同一 channel 二次注册是**直接 throw**，没有降级；
 *   ② `registerIpcHandlers` 是一个**线性注册**的大函数（187 个 channel 顺序注册），
 *      任何一条 throw 都会让**它之后的 handler 全部失去注册**；
 *   ③ 抛出点在 `app.whenReady` 阶段 → 不是"某个功能不生效"，而是**整个应用打不开**，
 *      用户连界面都看不到，无从自查。
 *
 * 而 1823 个测试、tsc、产物断言**全都拦不住它** —— 因为没有任何一条断言在"源码里
 * 同一 channel 是否注册了两次"这个维度上。这正是"修一个坏一个"的结构成因：
 * 加 handler 是一个纯增量动作，删旧 handler 却没有任何东西逼你做。
 *
 * 守卫内容：
 *  ① 扫 `gui/src/main/` 全部 .ts，同一 IPC channel 不许注册两次（含 handleTrusted /
 *     ipcMain.handle / ipcMain.on / ipcMain.handleOnce）。
 *  ② `handleTrusted` 必须保留"去重 + 显式报错"的运行期防护（把"app 打不开"降级为
 *     "能开 + 一行醒目 error"，但**不许静默**）。
 *
 * ⚠️ 扫源码前必须**剥掉注释**：否则注释里写的示例（比如 `handleTrusted("xxx")` 的说明）
 *    会造成假阳 —— 这类"守卫锁错对象"的坑 A-1019 已经踩过两次，每条守卫都必须过变异测试。
 *
 * ⚠️⚠️ 剥离注释**不能用自己手写的状态机，也不能简单循环 `scanner.scan()`**。两种都被
 *    变异测试当场抓出来过：
 *      ① 手写状态机：`gui/src/main/index.ts` 里有正则字面量 `.replace(/^["']|["']$/g, "")`，
 *         正则里的 `"` 被当成"字符串开始"，整份文本的解析**错位 2000+ 字符**。
 *         更阴的是它**看起来是好的** —— 我们关心的那条注册恰好被"错位后又被下一对引号掰回来"
 *         而仍然命中，守卫跑绿。
 *      ② 裸 `scanner.scan()` 循环：TS 的 scanner 本身**不区分除号与正则字面量**
 *         （那要由 parser 调 `reScanSlashToken()` 决定），所以同样错位 ——
 *         实测只找到 130 处注释区间，块注释里的 `slime:theme:set` 一个都没抹掉。
 *    现在改用**解析器驱动的位置**：`ts.createSourceFile` + 递归 `node.getChildren(sf)`，
 *    对每个节点/词法单元取 `getLeadingCommentRanges` / `getTrailingCommentRanges`。
 *    实测该文件 **2152 个注释区间**全覆盖（手写版 130），`slime:theme:set` 由 3 处降到 1 处
 *    （恰好只剩那条真实注册）。行数严格不变，报错行号可直接用。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAIN_DIR = join(ROOT, "gui/src/main");
const MAIN_INDEX = join(MAIN_DIR, "index.ts");

/**
 * 把注释抹成空格。**解析器驱动** —— 位置全部来自 TypeScript 语法树，
 * 因此正则字面量 / 转义引号 / 模板串嵌套一概不会误判。
 * 行数与原文本严格一致，报错行号可直接用。
 */
function blankComments(src: string): string {
  const sf = ts.createSourceFile("scan.ts", src, ts.ScriptTarget.Latest, /* setParentNodes */ true);
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

/** 扫描一个源码文件里所有 IPC 注册调用：`handleTrusted<T>("ch", …)` / `ipcMain.on("ch", …)` 等 */
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

/** 取 `handleTrusted` 函数体（大括号配对，不用 `indexOf("\n}")` —— 那会截到嵌套块） */
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

/** 取 `if (REGISTERED_CHANNELS.has(channel))` 这个分支的块体 */
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

    // 守卫自身的健全性：必须真的扫到了东西（否则"0 个重复"毫无意义）
    expect(byChannel.size).toBeGreaterThan(100);

    const dups = [...byChannel.entries()]
      .filter(([, locs]) => locs.length > 1)
      .map(([ch, locs]) => `"${ch}" 注册了 ${locs.length} 次 → ${locs.join(", ")}`);

    expect(dups, `重复注册的 IPC channel（会让整个 app 打不开）:\n${dups.join("\n")}`).toEqual([]);
  });

  it("剥离器把注释真的抹掉了（反假阳：抹掉后不该再出现注释里的 channel 名）", () => {
    const src = readFileSync(MAIN_INDEX, "utf8");
    const clean = blankComments(src);
    expect(clean.split("\n").length).toBe(src.split("\n").length); // 行号可对齐
    // `slime:theme:set` 在原文出现 ≥2 次（含注释），剥离后只应剩"真实注册"那 1 次
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
    // 当前实测 184；设下限而非等值，避免正常新增 handler 就要改守卫
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
    // ⚠️ 必须只看**去重分支内部**，而且要**精确到"指出重复"的那一条**：
    //    第一版只看整个函数体 → "删掉去重分支的 console.error" 验不红（catch 块里那个顶包）；
    //    第二版只看去重分支 → 仍能被 catch 块里那个顶包。现在要求 200 字符内出现"重复注册"。
    const branch = dedupBranch(src);
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toMatch(/console\.error\([\s\S]{0,200}重复注册/);
  });
});

