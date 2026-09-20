/**
 * gui-products.spec.ts — 聊天消息「产物卡片」纯函数回归（A-1007）。
 * 锁死两条核心语义：
 *  1. extractProducts：从工具留痕提炼本轮真实产物文件——优先 file_write（写/改）、
 *     file_read 作补充；去重、过滤 URL/空串；写入者排前；返回带 ext 供图标映射。
 *  2. productIconUrl：按扩展名映射品牌 SVG 图标（word/Excel/pdf/ppt/python/css/ts…），
 *     未收录回退通用文件图标（不抛错、稳定返回字符串）。
 * 环境：vitest node（纯函数，无 React/DOM 依赖）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
/*
 * A-990：被测目标已从 `ChatPanel.tsx` 拆到两个**无 JSX 的纯模块**。
 * 这不只是搬家 —— 此前本文件 import 组件，等于在测试的模块图里拉进一个 5000+ 行 React 组件
 * 及其全部静态资源；组件加一个 svg 导入就会让根工程的类型检查全线报红（实测 17 条 TS2307）。
 * 现在测试只依赖纯逻辑，组件怎么长大都与本文件无关。
 */
import { extractProducts, parseDiffStat, parseDiffFull, diffLines, stripDiffTag, type ToolEvent } from "../../gui/src/renderer/pages/chatProducts.js";
import { productIconUrl } from "../../gui/src/renderer/pages/productIcons.js";

/**
 * 造一条工具留痕。类型用 **组件里真实导出的 `ToolEvent`**，不再自造 `Ev` + `as Ev[]` 强转 ——
 * 强转是"字段对不上却长期只有 9 条类型错报红、没人管"的根源（`Ev` 缺 `id`/`label`）。
 * `id` 自增、`label` 取工具名：被测的 extractProducts 只读 name/detail/result，
 * 但对象仍必须是**完整的合法事件**，否则测的就不是真实入参形态。
 */
let evSeq = 0;
const ev = (name: string, detail?: string, result?: string): ToolEvent =>
  ({ id: (evSeq += 1), name, label: name, detail, result });

/** 把 old/new 文本包成 file_write 的 result（A-172 同款 [__slime_diff__] 标记） */
const diffResult = (oldTxt: string, newTxt: string): string =>
  `已写入\n[__slime_diff__]${Buffer.from(oldTxt).toString("base64")}|${Buffer.from(newTxt).toString("base64")}[/__slime_diff__]`;

/** 干运行：文件是否真实存在（防止「图标已拷贝但 import 指向不存在文件」的幻觉） */
function iconExists(src: string): boolean {
  return /\.svg$/.test(src) && src.length > 0;
}

/* ═══════════ A-990：结构守卫 —— 纯逻辑模块不得长回组件依赖 ═══════════
 *
 * 为什么要有这条：本次把 `ChatPanel.tsx`（5000+ 行）里的纯函数拆出来，动机不是"文件太长"，
 * 而是**测试只能从组件 import** 造成的双向耦合 —— 组件加一个 svg 导入，根类型检查就全线报红
 * （实测 17 条 TS2307）。拆完如果不设守卫，下次有人图省事又会把工具函数写回组件，
 * 或者给纯模块加一句 `import React`（"顺便渲染个东西"），耦合就悄悄回来了。
 * 所以这里直接**读源码**把边界钉死：纯模块必须保持无 React / 无 JSX / 无（除 productIcons 外的）资源导入。
 */
describe("结构守卫：纯逻辑模块不得反向依赖组件或资源", () => {
  /*
   * ⚠️ 路径必须用 `import.meta.url` 解析，**不能**用相对 CWD 的字符串：
   * 测试文件的 `import "../../gui/..."` 是相对**测试文件**解析的，而 `readFileSync("gui/...")`
   * 是相对**进程工作目录**解析的 —— 两者混用会在"从别的目录跑 vitest"时静默读错文件
   * （读不到会抛错还看得见，更糟的是读到另一个同名文件而测试全绿）。
   */
  const ROOT = new URL("../../", import.meta.url); // tests/core-ts/ → 仓库根
  const read = (rel: string): string => readFileSync(new URL(rel, ROOT), "utf8");
  const PAGES = "gui/src/renderer/pages/";

  it("chatProducts.ts / liveMonitor.ts 不得 import React、react-dom 或任何静态资源", () => {
    for (const f of ["chatProducts.ts", "liveMonitor.ts"]) {
      const src = read(PAGES + f);
      // 只看 import 语句，避免把文件头注释里"提到 React"也算违规
      const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join("\n");
      expect(imports, `${f} 不该有 import 语句（当前：${imports || "无"}）`).toBe("");
      expect(src).not.toMatch(/from\s+["']react/);
    }
  });

  it("静态资源依赖只允许出现在 productIcons.ts（唯一的资源依赖点）", () => {
    for (const f of ["chatProducts.ts", "liveMonitor.ts"]) {
      expect(read(PAGES + f), `${f} 不得导入 svg/png 等资源`).not.toMatch(/\.(svg|png|jpe?g|gif|webp|ico)["']/);
    }
    // 反向确认：productIcons.ts 确实是那个资源依赖点（否则上面两条等于空转）
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
      { type: "eq", text: "" }, // 文件以 \n 结尾 → 末尾空行未变
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

/**
 * A-979：渲染层**不许出现 `Buffer`**（环境差事故的源码守卫）。
 *
 * 事故：BrowserWindow 是 `contextIsolation:true, sandbox:true, nodeIntegration:false`，
 * 渲染进程**没有 Buffer 全局**，`Buffer.from(b64,"base64")` 抛 ReferenceError；
 * 而调用处包着 `try/catch` → 被吞成 null → 产物卡 +n/-m 与工具行红绿 diff **全部静默失效**。
 * 本文件的用例之所以全绿，是因为 vitest 跑在 **Node**（那里有 Buffer）——
 * 这正是"测试通过 ≠ 线上可用"的教科书案例，故必须用源码断言把渲染层的 Buffer 钉死。
 */
describe("渲染层禁用 Buffer（A-979 环境差事故守卫）", () => {
  /** 递归收集 renderer 下全部 .ts/.tsx（不写死文件名——新增文件也要被这条守卫覆盖） */
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
    expect(files.length).toBeGreaterThan(20); // 扫描有效（防止路径写错导致空转通过）
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

/**
 * A-979：diff 机器标记必须**彻底**剥离。
 * 只删"配对成功"的那一处是不够的 —— 任何一环截断/中断都会留下未闭合标记，
 * 而它后面跟的是几十 KB base64，原样进界面就是用户截图里那几行乱码。
 */
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
    // core-ts/tool_loop.ts 的 truncateWithDiffTag 把标记挪到正文后面单独一行，这里照抄该形态
    const tag = diffResult("旧", "新").split("\n")[1];
    const shown = `已保存 7462 字节到 D:\\proj\\x.html\n${tag}`;
    expect(stripDiffTag(shown)).toBe("已保存 7462 字节到 D:\\proj\\x.html");
    // 两件事必须同时成立：界面干净 + 红绿 diff 块拿得到数据
    expect(parseDiffFull(shown)).toEqual({ old: "旧", new: "新" });
  });
});