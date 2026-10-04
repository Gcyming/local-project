








import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";






import { extractProducts, parseDiffStat, parseDiffFull, diffLines, stripDiffTag, type ToolEvent } from "../../gui/src/renderer/pages/chatProducts.js";
import { productIconUrl } from "../../gui/src/renderer/pages/productIcons.js";







let evSeq = 0;
const ev = (name: string, detail?: string, result?: string): ToolEvent =>
  ({ id: (evSeq += 1), name, label: name, detail, result });


const diffResult = (oldTxt: string, newTxt: string): string =>
  `已写入\n[__slime_diff__]${Buffer.from(oldTxt).toString("base64")}|${Buffer.from(newTxt).toString("base64")}[/__slime_diff__]`;


function iconExists(src: string): boolean {
  return /\.svg$/.test(src) && src.length > 0;
}









describe("结构守卫：纯逻辑模块不得反向依赖组件或资源", () => {
  





  const ROOT = new URL("../../", import.meta.url); 
  const read = (rel: string): string => readFileSync(new URL(rel, ROOT), "utf8");
  const PAGES = "gui/src/renderer/pages/";

  it("chatProducts.ts / liveMonitor.ts 不得 import React、react-dom 或任何静态资源", () => {
    for (const f of ["chatProducts.ts", "liveMonitor.ts"]) {
      const src = read(PAGES + f);
      
      const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join("\n");
      expect(imports, `${f} 不该有 import 语句（当前：${imports || "无"}）`).toBe("");
      expect(src).not.toMatch(/from\s+["']react/);
    }
  });

  it("静态资源依赖只允许出现在 productIcons.ts（唯一的资源依赖点）", () => {
    for (const f of ["chatProducts.ts", "liveMonitor.ts"]) {
      expect(read(PAGES + f), `${f} 不得导入 svg/png 等资源`).not.toMatch(/\.(svg|png|jpe?g|gif|webp|ico)["']/);
    }
    
    expect(read(PAGES + "productIcons.ts")).toMatch(/\.svg["']/);
  });

  it("测试的模块图里不得再出现 ChatPanel（这就是本次拆分的验收标准）", () => {
    for (const name of ["tests/core-ts/live-monitor.spec.ts", "tests/core-ts/gui-products.spec.ts"]) {
      const src = read(name);
      const imported = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l) && /ChatPanel\.js/.test(l));
      expect(imported, `${name} 仍在 import 组件：${imported.join(" | ")}`).toEqual([]);
    }
  });
});

describe("extractProducts（产物文件提炼）", () => {
  it("优先写产物：file_write 前置、file_read 补充", () => {
    const out = extractProducts([
      ev("file_read", "core/sandbox.py"),
      ev("file_write", "core/agent.py"),
      ev("web_fetch", ""),
    ]);
    expect(out[0]).toEqual({ rel: "core/agent.py", name: "agent.py", kind: "write", ext: "py" });
    expect(out[1]).toEqual({ rel: "core/sandbox.py", name: "sandbox.py", kind: "read", ext: "py" });
    expect(out).toHaveLength(2);
  });

  it("同一文件写后读去重（读不再重复展示）", () => {
    const out = extractProducts([
      ev("file_write", "a.ts"),
      ev("file_read", "a.ts"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ rel: "a.ts", name: "a.ts", kind: "write", ext: "ts" });
  });

  it("过滤非文件：URL、空串不被当作产物", () => {
    const out = extractProducts([
      ev("file_write", "https://ex.com/a.ts"),
      ev("file_write", "   "),
      ev("file_read", ""),
    ]);
    expect(out).toHaveLength(0);
  });

  it("只保留 file_write/file_read，其它工具（bash/web_fetch）不产出", () => {
    const out = extractProducts([
      ev("bash", "python main.py"),
      ev("web_fetch", "https://ex.com"),
      ev("file_write", "gui/src/index.ts"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rel).toBe("gui/src/index.ts");
    expect(out[0].name).toBe("index.ts");
  });

  it("多种扩展开名均提取出 ext（供图标映射）", () => {
    const out = extractProducts([
      ev("file_write", "word.docx"),
      ev("file_write", "Excel.xlsx"),
      ev("file_write", "model.gguf"),
      ev("file_write", "style.css"),
    ]);
    expect(out).toEqual([
      { rel: "word.docx", name: "word.docx", kind: "write", ext: "docx" },
      { rel: "Excel.xlsx", name: "Excel.xlsx", kind: "write", ext: "xlsx" },
      { rel: "model.gguf", name: "model.gguf", kind: "write", ext: "gguf" },
      { rel: "style.css", name: "style.css", kind: "write", ext: "css" },
    ]);
  });

  it("file_write 带 [__slime_diff__] 标记 → 附变更统计（+n -m 数据源）", () => {
    const out = extractProducts([ev("file_write", "a.ts", diffResult("line1\nline2\n", "line1\nline2\nline3\nline4\n"))]);
    expect(out[0].diff).toEqual({ add: 2, del: 0 });
  });

  it("无 diff 标记 / 损坏 base64 → 不附变更统计（卡片不显示 +n -m）", () => {
    expect(extractProducts([ev("file_write", "a.ts")])[0].diff).toBeUndefined();
    expect(extractProducts([ev("file_write", "a.ts", "[__slime_diff__]!!!|###[/__slime_diff__]")])[0].diff).toBeUndefined();
  });
});

describe("parseDiffStat（file_write 内嵌 diff 标记解析）", () => {
  it("净增/净删行数按行级近似统计", () => {
    expect(parseDiffStat(diffResult("a\nb\nc\n", "a\nb\nc\nd\n"))).toEqual({ add: 1, del: 0 });
    expect(parseDiffStat(diffResult("a\nb\nc\n", "a\nb\n"))).toEqual({ add: 0, del: 1 });
    expect(parseDiffStat(diffResult("a\nb\n", "a\nc\n"))).toEqual({ add: 1, del: 1 });
  });

  it("无标记 → null；空内容 → null；损坏 base64 → null（不抛错）", () => {
    expect(parseDiffStat(undefined)).toBeNull();
    expect(parseDiffStat("已写入")).toBeNull();
    expect(parseDiffStat(diffResult("", ""))).toBeNull();
    expect(parseDiffStat("[__slime_diff__]!!!|###[/__slime_diff__]")).toBeNull();
  });
});

describe("productIconUrl（扩展名 → 品牌 SVG 图标）", () => {
  it("常见文件类型映射到品牌图标 URL", () => {
    const cases: Array<[string, string]> = [
      ["docx", "word.svg"], ["xlsx", "Excel.svg"], ["pdf", "pdf.svg"],
      ["pptx", "ppt.svg"], ["py", "python.svg"], ["css", "css.svg"],
      ["ts", "ts.svg"], ["gitignore", "git.svg"], ["gguf", "llama.svg"],
    ];
    for (const [ext, expectContain] of cases) {
      const url = productIconUrl(ext);
      expect(url.toLowerCase()).toContain(expectContain.toLowerCase());
    }
  });

  it("未收录扩展名回退通用文件图标（稳定返回字符串）", () => {
    const url = productIconUrl("weird_ext");
    expect(typeof url).toBe("string");
    expect(url.length).toBeGreaterThan(0);
  });

  it("所有返回图标均解析到已存在的 SVG 资源", () => {
    const exts = ["ts", "js", "py", "css", "md", "html", "json", "docx", "xlsx", "pdf", "pptx", "png", "zip", "gguf", "gitignore", "sh", ""];
    for (const ext of exts) {
      expect(iconExists(productIconUrl(ext))).toBe(true);
    }
  });
});

describe("parseDiffFull（diff 标记全文解析——产物卡展开详情数据源）", () => {
  it("有标记 → 返回 old/new 原文；无标记/损坏 → null", () => {
    expect(parseDiffFull(diffResult("a\nb\n", "a\nb\nc\n"))).toEqual({ old: "a\nb\n", new: "a\nb\nc\n" });
    expect(parseDiffFull("已写入")).toBeNull();
    expect(parseDiffFull("[__slime_diff__]!!!|###[/__slime_diff__]")).toBeNull();
    expect(parseDiffFull(undefined)).toBeNull();
  });

  it("old+new 合计超过 maxChars → null（大文件仅显示计数）", () => {
    const big = "x".repeat(12000);
    expect(parseDiffFull(diffResult(big, big), 20000)).toBeNull();
    expect(parseDiffFull(diffResult("a", "b"), 20000)).toEqual({ old: "a", new: "b" });
  });
});

describe("diffLines（行级 LCS diff——产物卡展开红绿行）", () => {
  it("新增/删除/未变行按序标记", () => {
    const out = diffLines("a\nb\n", "a\nc\n");
    expect(out).toEqual([
      { type: "eq", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "c" },
      { type: "eq", text: "" }, 
    ]);
  });

  it("空 new → 全部删除；空 old → 全部新增", () => {
    expect(diffLines("a\nb\n", "")).toEqual([
      { type: "del", text: "a" }, { type: "del", text: "b" }, { type: "del", text: "" },
    ]);
    expect(diffLines("", "a\nb\n")).toEqual([
      { type: "add", text: "a" }, { type: "add", text: "b" }, { type: "add", text: "" },
    ]);
  });

  it("extractProducts 对带标记的 file_write 同时附 diff 计数与 diffFull 全文", () => {
    const out = extractProducts([ev("file_write", "a.ts", diffResult("a\nb\n", "a\nb\nc\n"))]);
    expect(out[0].diff).toEqual({ add: 1, del: 0 });
    expect(out[0].diffFull).toEqual({ old: "a\nb\n", new: "a\nb\nc\n" });
  });
});










describe("渲染层禁用 Buffer（A-979 环境差事故守卫）", () => {
  
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, out); }
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) { out.push(p); }
    }
    return out;
  };

  it("renderer 源码不得引用 Buffer（应改用 atob + TextDecoder）", () => {
    const files = walk(join(process.cwd(), "gui/src/renderer"));
    expect(files.length).toBeGreaterThan(20); 
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      if (/\bBuffer\./.test(src)) { offenders.push(f.replace(process.cwd(), "")); }
    }
    expect(offenders, "渲染进程没有 Buffer，运行时会抛 ReferenceError 并被 try/catch 静默吞掉").toEqual([]);
  });

  it("b64 解码走 atob：中文（UTF-8 多字节）也能正确还原", () => {
    const full = parseDiffFull(diffResult("旧内容\n第二行", "新内容\n第二行"));
    expect(full).toEqual({ old: "旧内容\n第二行", new: "新内容\n第二行" });
  });
});






describe("stripDiffTag（机器标记绝不漏进界面）", () => {
  it("配对标记被整段删除，正文保留", () => {
    expect(stripDiffTag(diffResult("a\n", "b\n"))).toBe("已写入");
  });

  it("未闭合标记（被截断/被打断）→ 连同其后全部 base64 一起吃掉", () => {
    const truncated = "已保存 7462 字节到 x.html\n[__slime_diff__]JPCFRkZrb2N0OExIbGdNbWc";
    const out = stripDiffTag(truncated);
    expect(out).toBe("已保存 7462 字节到 x.html");
    expect(out).not.toContain("JPCFRkZ");
  });

  it("只有孤立结束标记 / 无标记文本 → 该留的留、该删的删", () => {
    expect(stripDiffTag("普通结果")).toBe("普通结果");
    expect(stripDiffTag("结果[/__slime_diff__]")).toBe("结果");
    expect(stripDiffTag(undefined)).toBe("");
  });

  it("回归：真实链路形态（正文 + 换行 + 标记）被完整剥离，且 diff 仍可解析", () => {
    
    const tag = diffResult("旧", "新").split("\n")[1];
    const shown = `已保存 7462 字节到 D:\\proj\\x.html\n${tag}`;
    expect(stripDiffTag(shown)).toBe("已保存 7462 字节到 D:\\proj\\x.html");
    
    expect(parseDiffFull(shown)).toEqual({ old: "旧", new: "新" });
  });
});