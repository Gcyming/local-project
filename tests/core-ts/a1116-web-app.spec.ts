/**
 * tests/core-ts/a1116-web-app.spec.ts — 「产出任意本地 web 程序」的守卫（A-1116）。
 *
 * 用户原话：「给我优化 HTTP 功能，能像你一样产出 html 等各式各样的本地 web 程序。」
 *
 * 这条改动把 `http_create_app` 从「6 个固定模板」升级为「模型自己写任意多文件」，于是
 * **模型可控的路径第一次允许写到子目录** —— 顺带开出一个新的风险面，必须锁住：
 *   `files: [{path: "../../config/agents.json"}]` 这种一次手滑就能写出 apps 之外。
 * 收敛原则是**拒绝**而不是「清洗后写入」：清洗会静默改掉模型的意图，而它收到的是「成功」，
 * 于是它以为自己写了一处实际上并不存在的文件（**假成功**，比报错更难查）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { normalizeAppFiles } from "../../core-ts/src/tools/builtin.js";

function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}
const BUILTIN = codeOf("core-ts/src/tools/builtin.ts");

describe("A-1116 — 多文件 web 程序的路径收敛（纯函数）", () => {
  it("正常情形：保留子目录与文件名，内容原样带过", () => {
    const r = normalizeAppFiles([
      { path: "index.html", content: "<h1>hi</h1>" },
      { path: "assets/app.js", content: "console.log(1)" },
      { path: "data\\list.json", content: "[]" },
    ]);
    expect(r.map((f) => f.path)).toEqual(["index.html", "assets/app.js", "data/list.json"]);
    expect(r[0].content).toBe("<h1>hi</h1>");
  });

  it("⚠️ 路径逃逸必须**拒绝**（绝对路径 / 盘符 / `..`）—— 不许清洗后照写", () => {
    const r = normalizeAppFiles([
      { path: "/etc/passwd", content: "x" },
      { path: "C:/Windows/system32/x.dll", content: "x" },
      { path: "../../config/agents.json", content: "x" },
      { path: "a/../../b.txt", content: "x" },
      { path: "..", content: "x" },
    ]);
    expect(r).toEqual([]);
  });

  it("脏输入不许抛错，也不许产出半成品条目", () => {
    expect(normalizeAppFiles(null)).toEqual([]);
    expect(normalizeAppFiles("index.html")).toEqual([]);
    expect(normalizeAppFiles([null, 42, { path: 1 }, { content: "x" }, { path: "a/" , content: "x" }])).toEqual([]);
  });
});

describe("A-1116 — 接线（模型真的能写多文件）", () => {
  it("工具 schema 暴露了 `files`，且不再把 description 设成必填（自由创作模式可以只给 files）", () => {
    const at = BUILTIN.indexOf('name: "http_create_app"');
    expect(at).toBeGreaterThan(-1);
    const block = BUILTIN.slice(at, at + 2600);
    expect(block).toContain("files: {");
    expect(block).toContain('required: [],');
  });

  it("写入路径必须过 `normalizeAppFiles`（唯一产地），且支持子目录", () => {
    expect(BUILTIN).toContain("const custom = normalizeAppFiles(args.files);");
    expect(BUILTIN).toContain("await mkdir(dirname(absFile), { recursive: true });");
  });

  it("工具描述必须写清「做成什么样才算好」（模型的能力上限取决于它知道什么）", () => {
    expect(BUILTIN).toContain("**自包含**");
    expect(BUILTIN).toContain("不引外网 CDN");
    expect(BUILTIN).toContain("**能交互**");
    expect(BUILTIN).toContain("**零构建**");
  });

  it("回执必须列**真实写入的文件**（不能固定写死 index.html —— 多文件模式下那是假陈述）", () => {
    expect(BUILTIN).toContain("const filesLine = written.map((w) => `  - ${w}`).join(\"\\n\");");
    expect(BUILTIN).toContain("已写入文件：\\n${filesLine}");
    expect(BUILTIN).not.toContain("`文件：${join(dir, \"index.html\")}`");
  });
});
