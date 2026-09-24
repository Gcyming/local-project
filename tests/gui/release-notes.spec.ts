/**
 * A-1037 守卫：Release 正文解析（自动更新「显示源码」缺陷）。
 *
 * 病灶：`electron-updater` 给的是 GitHub Release **正文原文**（本项目写的是 HTML），
 * 渲染层此前直接 `{releaseNotes}` 输出 → 用户看到 `<h3>`/`<td>` 标签字面量。
 *
 * 这里锚住三条**不可退让**的判据：
 *  ① 解析结果里**不许再出现任何 HTML 标签字面量**（回归红线）；
 *  ② 结构要真被认出来（标题/段落/表格/列表），不能整篇退化成一个纯文本段；
 *  ③ 危险内容必须被丢掉（script/style/js 协议 href）——因为渲染层虽然不是 innerHTML，
 *    但 href、文本仍会进 DOM。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseReleaseNotes, parseInline, normalizeReleaseNotes, decodeEntities, safeHref,
} from "../../gui/src/shared/releaseNotes.js";

/** 真实 v0.0.4 正文的节选（就是用户截图里显示成标签源码的那段） */
const REAL_BODY = `<h2>本版重点修复</h2>
<p><strong>旧版 <code>.xls</code>/<code>.docx</code> 解析补全 —— 真实样本验证 + 数值不再丢</strong></p>
<p>.xls 走 BIFF 网格重建，<code>.docx</code> 走 ZIP 解包，共同点是「表格里的数字不再是空白」。</p>
<h3>修复 1/3</h3>
<p>纯数字单元格此前<b>完全读不到</b>：原实现只抓共享字符串表（SST），NUMBER / RK / MULRK / FORMULA 记录里的数值全被跳过。</p>
<table><thead><tr><th>文件</th><th>修复前</th><th>修复后</th></tr></thead><tbody><tr><td><code>12561-1.xls</code></td><td>129 串 / 1298 字</td><td>「作業リスト」 49 行 × 13 列 / 4043 字</td></tr><tr><td><code>Formatting.xls</code></td><td>只有格式名</td><td><code>39045</code>（日期序列号）与 <code>10.52</code>（RK 数值）</td></tr></tbody></table>
<h3>已知限制</h3>
<ul><li>超大文件（&gt; 200MB）不保证流畅</li><li><code>&amp;lt;</code> 与 <code>&amp;amp;</code> 之外的实体不解析</li></ul>
<hr>
<p>构建链路：<code>tsc --noEmit</code> 0 错 / <code>vitest</code> <strong>202 通过</strong>。</p>`;

/** 「整篇不许出现标签字面量」——所有 run 文本拼起来扫一遍 */
function allText(blocks: ReturnType<typeof parseReleaseNotes>): string {
  const out: string[] = [];
  for (const b of blocks) {
    for (const r of b.runs ?? []) { out.push(r.text); }
    for (const it of b.items ?? []) { for (const r of it) { out.push(r.text); } }
    for (const c of b.header ?? []) { for (const r of c) { out.push(r.text); } }
    for (const row of b.rows ?? []) { for (const c of row) { for (const r of c) { out.push(r.text); } } }
    if (b.text) { out.push(b.text); }
  }
  return out.join("\n");
}

describe("A-1037 release notes 解析", () => {
  it("回归红线：HTML 正文解析后不再残留任何标签字面量", () => {
    const blocks = parseReleaseNotes(REAL_BODY);
    const text = allText(blocks);
    // 允许出现 "<" 作为普通字符（如 "> 200MB" 的反向），但不允许形如 </h3> / <td> 的标签
    expect(text).not.toMatch(/<\/?[a-zA-Z][\w-]*(\s[^<>]*)?\/?>/);
    expect(text).not.toContain("<h2>");
    expect(text).not.toContain("<td>");
    expect(text).not.toContain("<strong>");
  });

  it("结构真被认出来：标题 / 段落 / 表格 / 列表 / 分隔线", () => {
    const blocks = parseReleaseNotes(REAL_BODY);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("paragraph");
    expect(kinds).toContain("table");
    expect(kinds).toContain("list");
    expect(kinds).toContain("hr");

    const h2 = blocks.find((b) => b.kind === "heading" && b.level === 2);
    expect(h2?.runs?.[0].text).toBe("本版重点修复");

    const table = blocks.find((b) => b.kind === "table");
    expect(table?.header?.map((c) => c[0].text)).toEqual(["文件", "修复前", "修复后"]);
    expect(table?.rows).toHaveLength(2);
    // 表格单元里的 <code> 变成 code 片段，而不是带标签的字符串
    const firstCell = table?.rows?.[0][0] ?? [];
    expect(firstCell[0].text).toBe("12561-1.xls");
    expect(firstCell[0].code).toBe(true);
  });

  it("行内样式：<strong>/<b> 变 bold，<code> 变 code，且相邻同样式合并", () => {
    const [p] = parseReleaseNotes("<p><strong>旧版 <code>.xls</code>/<code>.docx</code> 解析补全</strong></p>");
    expect(p.kind).toBe("paragraph");
    const runs = p.runs ?? [];
    expect(runs[0]).toMatchObject({ text: "旧版 ", bold: true });
    expect(runs[1]).toMatchObject({ text: ".xls", bold: true, code: true });
    expect(runs[2]).toMatchObject({ text: "/", bold: true });
    expect(runs[3]).toMatchObject({ text: ".docx", bold: true, code: true });
    expect(runs[runs.length - 1].text).toContain("解析补全");
  });

  it("实体解码：&amp; &lt; &gt; &quot; 与数字实体", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;")).toBe(`a & b <c> "d" 'e'`);
    expect(decodeEntities("x&#65;y")).toBe("xAy");
    expect(decodeEntities("&#x4e2d;")).toBe("中");
    // 未知实体原样保留，不猜
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });

  it("危险内容被丢弃：script / style / onerror / javascript: 协议", () => {
    const evil = `<p>hello</p><script>alert(1)</script><style>body{}</style>
<p><img src=x onerror="alert(2)">tail</p><p><a href="javascript:alert(3)">点我</a></p>`;
    const blocks = parseReleaseNotes(evil);
    const text = allText(blocks);
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("alert(2)");
    expect(text).not.toContain("body{}");
    expect(text).not.toContain("onerror");
    const link = blocks.flatMap((b) => b.runs ?? []).find((r) => r.text === "点我");
    expect(link).toBeDefined();
    expect(link?.href).toBeUndefined(); // javascript: 被丢弃 → 退化成纯文本
    expect(safeHref("https://github.com/x")).toBe("https://github.com/x");
    expect(safeHref("JavaScript:alert(1)")).toBe("");
    expect(safeHref("data:text/html,x")).toBe("");
  });

  it("Markdown 正文同样认（标题 / 列表 / 管道表 / 粗体 / 行内码）", () => {
    const md = `# 标题\n\n- 第一项\n- 第二项 **加粗**\n\n| 列A | 列B |\n| --- | --- |\n| 1 | \`code\` |\n\n普通段落。`;
    const blocks = parseReleaseNotes(md);
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "table", "paragraph"]);
    expect(blocks[1].ordered).toBe(false);
    expect(blocks[1].items?.[1][1]).toMatchObject({ text: "加粗", bold: true });
    expect(blocks[2].header?.map((c) => c[0].text)).toEqual(["列A", "列B"]);
    expect(blocks[2].rows?.[0][1][0]).toMatchObject({ text: "code", code: true });
  });

  it("有序列表被识别成 ordered", () => {
    const blocks = parseReleaseNotes("1. 一\n2. 二\n3. 三");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("list");
    expect(blocks[0].ordered).toBe(true);
    expect(blocks[0].items).toHaveLength(3);
  });

  it("releaseNotes 归一化：string / ReleaseNoteInfo[] / null 都收敛成 string", () => {
    expect(normalizeReleaseNotes("abc")).toBe("abc");
    expect(normalizeReleaseNotes(null)).toBe("");
    expect(normalizeReleaseNotes(undefined)).toBe("");
    expect(normalizeReleaseNotes([{ version: "0.0.4", note: "A" }, { version: "0.0.5", note: "B" }])).toBe("A\n\nB");
    // 无效项被剔除后不留空段（"x" 与 "y" 之间恰好一个分隔）
    expect(normalizeReleaseNotes(["x", null, 42, { note: "y" }])).toBe("x\n\ny");
    // 数组形态也能直接喂给主入口（不会渲染出 [object Object]）
    const blocks = parseReleaseNotes([{ note: "<p>hi</p>" }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].runs?.[0].text).toBe("hi");
  });

  it("空输入返回空数组（不是一段 'undefined'）", () => {
    expect(parseReleaseNotes("")).toEqual([]);
    expect(parseReleaseNotes(null)).toEqual([]);
    expect(parseReleaseNotes("   \n  ")).toEqual([]);
  });

  it("parseInline 不会把未闭合记号吞掉", () => {
    expect(parseInline("**没闭合").map((r) => r.text).join("")).toBe("**没闭合");
    expect(parseInline("a `b").map((r) => r.text).join("")).toBe("a `b");
  });
});

/**
 * A-1042 红线：**发布说明的来源必须是 Markdown，不许手写成 HTML。**
 *
 * 病灶（v0.0.4 实测）：0.0.2 / 0.0.3 的说明都是 Markdown，唯独 0.0.4 被手写成 HTML 再贴进
 * GitHub Release 正文。于是**任何早于 A-1037 的客户端**——它们把 `releaseNotes` 当纯文本塞进
 * 一个 `whiteSpace: pre-wrap` 的 `<span>`——会把 `<h2>` / `<tr>` / `<td>` 原样显示成一屏标签源码。
 *
 * 为什么红线必须画在「源文件」这一层：Markdown 是三方都能吃下的**最小公分母** ——
 * GitHub 原生渲染它、本项目解析器认它、**旧客户端也能当可读文本显示**（`## 标题` 而非 `<h2>标题`）。
 * HTML 只有「新客户端 + GitHub」两个读者，旧客户端必然看见标签源码；而「旧客户端」永远存在
 * （用户装的就是上一个版本），所以 HTML 正文是结构性错误，不是一次性事故。
 *
 * ⚠️ **正本住在 `docs/releases/`（受版本控制），不是 `gui/release-v<版本>/`**：
 * `gui` 下的 release 目录整批在 `.gitignore` 里（打包产物目录）。守卫若去那里读，
 * 在干净克隆上会一个文件都扫不到 —— 那不是"通过"，是**空转**。
 * 发布说明是要被评审、被追溯的文本，必须在库里。
 */
describe("A-1042 发布说明源文件格式", () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const RELEASES = resolve(REPO, "docs", "releases");

  /** 正本目录下的全部发布说明（目录缺失时返回空表，由断言给出"缺目录"的明确信息） */
  function notesFiles(): Array<{ ver: string; text: string }> {
    if (!existsSync(RELEASES)) { return []; }
    return readdirSync(RELEASES)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ ver: f.replace(/\.md$/, ""), text: readFileSync(resolve(RELEASES, f), "utf8") }));
  }

  /** 换行归一化后再比 —— 只关心内容，不为 CRLF/LF 差异误报 */
  const norm = (s: string): string => s.replace(/\r\n?/g, "\n");

  /**
   * 打包目录里**实际存在**的副本。它们只在"本机打过包"时存在，所以防漂移那条要按存在性跳过
   * —— 否则干净克隆上会因为"没有副本"而假红。
   */
  const localCopies = notesFiles()
    .map((f) => ({ ver: f.ver, canon: f.text, path: resolve(REPO, "gui", `release-${f.ver}`, "RELEASE_NOTES.md") }))
    .filter((x) => existsSync(x.path));

  it("正本目录存在，且每个发布说明都是纯 Markdown（不含块级 HTML 标签）", () => {
    expect(existsSync(RELEASES), `缺正本目录 ${RELEASES}`).toBe(true);
    const files = notesFiles();
    // ⚠️ 数量守恒：一个文件都没扫到 = 这条守卫在空转（假绿），必须先钉住下限
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const hit = f.text.match(
        /<\/?(?:h[1-6]|p|table|thead|tbody|tr|td|th|ul|ol|li|div|span|strong|b|em|code|pre|br|hr)\b[^>]*>/i);
      expect(hit, `${f.ver}.md 里出现 HTML 标签 ${hit?.[0] ?? ""}`).toBeNull();
    }
  });

  it("真实发布说明喂进解析器：结构被认出来，且一个标签字面量都不残留", () => {
    const files = notesFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const blocks = parseReleaseNotes(f.text);
      const kinds = blocks.map((b) => b.kind);
      expect(kinds, `${f.ver} 没解析出标题（整篇退化成一个段落？）`).toContain("heading");
      expect(kinds, `${f.ver} 没解析出段落`).toContain("paragraph");
      // 红线的**真实数据版本**：解析后拼起来的文本里不许再出现形如 </h2> / <td> 的标签
      expect(allText(blocks), `${f.ver} 解析后仍残留标签字面量`)
        .not.toMatch(/<\/?[a-zA-Z][\w-]*(\s[^<>]*)?\/?>/);
    }
  });

  /**
   * ⚠️ 数量守恒只写 `length >= 3` 是**不够**的：把 `docs/releases/v0.0.2.md` 改名成任意非 `.md`
   * 文件，剩下的 5 个仍然 ≥ 3 → 守卫静默漏扫那一个版本，却照旧全绿（这正是 M7 抓出的空转形态）。
   * 所以必须补**完整性**判据：谁"应该"有正本，就必须真的有。
   *
   * 两个方向：
   *   ① 当前版本（`gui/package.json`）必须有正本 —— 干净克隆上就能验，且正是发版前最危险的时刻；
   *   ② 本机打过包的每个版本（`gui/release-v<semver>/`）必须有正本 —— 反向不成立（副本只在本机存在）。
   */
  const currentVersion = (): string =>
    JSON.parse(readFileSync(resolve(REPO, "gui", "package.json"), "utf8")).version as string;

  /** 本机打包目录对应的版本号（只认 `release-v<semver>`；`release-final` / `-pub` 等一律不参与） */
  function packagedVersions(): string[] {
    const guiDir = resolve(REPO, "gui");
    if (!existsSync(guiDir)) { return []; }
    return readdirSync(guiDir)
      .map((d) => /^release-v(\d+\.\d+\.\d+)$/.exec(d)?.[1])
      .filter((v): v is string => typeof v === "string")
      .sort();
  }

  it("当前版本（gui/package.json）必须有发布说明正本", () => {
    const ver = currentVersion();
    expect(
      existsSync(resolve(RELEASES, `v${ver}.md`)),
      `当前版本 ${ver} 缺 docs/releases/v${ver}.md —— 发版时不会带上任何说明`,
    ).toBe(true);
  });

  it.skipIf(packagedVersions().length === 0)(
    "本机打过包的每个版本，其正本都必须还在库里（防改名/删除后守卫静默漏扫）",
    () => {
      const vers = packagedVersions();
      expect(vers.length).toBeGreaterThanOrEqual(1);
      const have = new Set(notesFiles().map((f) => f.ver.replace(/^v/, "")));
      for (const v of vers) {
        expect(
          have.has(v),
          `gui/release-v${v}/ 里有打包副本，但缺 docs/releases/v${v}.md（被改名或删掉了？守卫会静默漏扫）`,
        ).toBe(true);
      }
    },
  );

  it("v0.0.4 正文的「修复前 → 修复后」管道表被解析成真表格", () => {
    const f = notesFiles().find((x) => x.ver.includes("0.0.4"));
    expect(f, "缺 docs/releases/v0.0.4.md").toBeDefined();
    const blocks = parseReleaseNotes(f!.text);
    const table = blocks.find((b) => b.kind === "table");
    expect(table?.header?.map((c) => c[0].text)).toEqual(["文件", "修复前", "修复后"]);
    expect(table?.rows?.length).toBeGreaterThanOrEqual(5);
    expect(table?.rows?.[0][0][0]).toMatchObject({ text: "12561-1.xls", code: true });
  });

  /**
   * ⚠️ 用 `skipIf` 而不是"没有副本就静默通过"：空转必须**看得见**（报告里显示 skipped），
   * 否则这条守卫在干净克隆上会伪装成"已通过"。本机打过包 → 真跑；没打过 → 显式跳过。
   */
  it.skipIf(localCopies.length === 0)("打包目录里的副本必须与正本逐字一致（防两份说明各自漂移）", () => {
    expect(localCopies.length).toBeGreaterThanOrEqual(1);
    for (const c of localCopies) {
      expect(norm(readFileSync(c.path, "utf8")), `${c.ver} 的打包副本与正本不一致`)
        .toBe(norm(c.canon));
    }
  });
});
