#!/usr/bin/env node
/**
 * gui/scripts/mut-a1133-docs.mjs — A-1133（拖入工作文档：分流判据 + 导航失败锁存）的变异验证。
 *
 * 事故（用户定性「重大事故」）：拖入 .docx/.pdf/.xlsx ⇒ 无休止
 * `GUEST_VIEW_MANAGER_CALL: ERR_FAILED (-2) loading 'file:///…docx'` + 文件夹疯狂生成无效文件 + 界面闪烁。
 *
 *   1  `fileKinds`：把 .docx 标成**可交给 Chromium 渲染**（事故本体：Chromium 画不出来 ⇒ 死循环）
 *   2  `fileKinds`：把纯文本标成可导航（本地文件重回 webview = 第二产地）
 *   3  `fileKinds`：老版二进制不再标 `legacy`（于是".doc 也能读"⇒ 解析二进制出乱码）
 *   4  `dropGuard`：工作文档被丢进 rejected（用户看到的还是「拖进来没反应」）
 *   5  `dropGuard`：拖放闸门判据恒假（Chromium 的默认导航重新接管）
 *   6  `webviewNav`：失败锁存恒不生效（**"无休止刷屏"原样复发**）
 *   7  `webviewNav`：把 `-3`（正常噪声）也当终态失败（正常导航被误判判死）
 *   8  `webviewNav`：attach 后安全网仍重发（力竭式重试 = 每 300ms 一次）
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环逐条 `--apply N` → vitest → `--restore`：
 *      for i in $(seq 1 28); do node gui/scripts/mut-a1133-docs.mjs --apply $i \
 *        && node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
 *             tests/gui/a1133-drop-and-nav.spec.ts tests/core-ts/office-file-kinds.spec.ts \
 *             tests/gui/a1133-doc-attachments.spec.ts tests/gui/a1133-doc-view.spec.ts \
 *             tests/core-ts/a1133-preview-page.spec.ts --reporter=dot; \
 *        node gui/scripts/mut-a1133-docs.mjs --restore; done
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行。
 * ⚠️ 中文句子里不许夹 ASCII 双引号 —— 一律「」（本仓已重复踩这个坑）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/* 两个 spec 都要跑：判据横跨 core-ts（类型能力边界）与 gui（分流 + 锁存）两侧。 */
const SPECS = [
  "tests/gui/a1133-drop-and-nav.spec.ts",
  "tests/core-ts/office-file-kinds.spec.ts",
  "tests/gui/a1133-doc-attachments.spec.ts",
  "tests/gui/a1133-doc-view.spec.ts",
  "tests/core-ts/a1133-preview-page.spec.ts",
  "tests/core-ts/a1133-ppt-slides.spec.ts",
  "tests/gui/a1133-doc-table-geometry.spec.ts",
  /* ⚠️ A-1133 ④（.doc 换行）的守卫**长在 A-1036 的 spec 里**（同族：旧版 Office 真解析）
     ⇒ 必须把它加进来。漏跑一个 spec = 那条变异**假存活**（本仓最贵的失效模式）。 */
  "tests/core-ts/a1036-guards.spec.ts",
  /* ⚠️ A-1135（HTML 预览的原生样貌）的守卫——M24~M28 靠它。 */
  "tests/gui/a1135-native-preview.spec.ts",
];
const F_KINDS = "core-ts/src/office/fileKinds.ts";
const F_DROP = "gui/src/renderer/pages/dropGuard.ts";
const F_NAV = "gui/src/renderer/pages/webviewNav.ts";
const F_ATTACH = "gui/src/renderer/pages/docAttachments.ts";
const F_VIEW = "gui/src/renderer/pages/docView.ts";
const F_PREVIEW = "core-ts/src/previewPage.ts";
const F_DOCTEXT = "core-ts/src/doc_text.ts";
const TARGETS = [F_KINDS, F_DROP, F_NAV, F_ATTACH, F_VIEW, F_PREVIEW, F_DOCTEXT];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1133");

const MUTATIONS = [
  {
    name: "1 fileKinds：.docx 被标成可导航（Chromium 渲染不了的类型 ⇒ ERR_FAILED 死循环复发）",
    file: F_KINDS,
    mutate: (t) => sub(t, 'if (WORD_OOXML.includes(ext)) { return at("word", false, true, "zip-xml"); }',
      'if (WORD_OOXML.includes(ext)) { return at("word", true, true, "zip-xml"); }'),
  },
  {
    name: "2 fileKinds：纯文本被标成可导航（本地文件重回浏览器页 = 第二产地）",
    file: F_KINDS,
    mutate: (t) => sub(t, 'if (TEXT_EXTS.includes(ext)) { return at("text", false, false, "text"); }',
      'if (TEXT_EXTS.includes(ext)) { return at("text", true, false, "text"); }'),
  },
  {
    name: "3 fileKinds：老版格式的 parser 退化成 none（丢掉 OLE 读取能力 ⇒ 拖入 .doc/.ppt 被拒）",
    file: F_KINDS,
    mutate: (t) => sub(t, 'return at(kind, false, true, "ole", true);', 'return at(kind, false, true, "none", true);'),
  },
  {
    name: "4 dropGuard：工作文档被丢进 rejected（用户看到的还是「拖进来没反应」）",
    file: F_DROP,
    mutate: (t) => sub(t, 'plan.documents.push({ index, kind: info.kind, rejected: false, reason: "" });',
      'plan.rejected.push({ index, kind: info.kind, rejected: true, reason: "" });'),
  },
  {
    name: "5 dropGuard：拖放闸门判据恒假（Chromium 的默认导航重新接管）",
    file: F_DROP,
    mutate: (t) => sub(t, 'return types.includes("Files");', 'return types.includes("Files") && false;'),
  },
  {
    name: "6 webviewNav：失败锁存恒不生效（**无休止刷屏**原样复发）",
    file: F_NAV,
    mutate: (t) => sub(t, 'return Boolean(url) && (book.get(url) ?? 0) > 0;', 'return false;'),
  },
  {
    name: "7 webviewNav：把 -3（正常噪声）也当终态失败（正常导航被误判判死）",
    file: F_NAV,
    mutate: (t) => sub(t, "  return !isBenignAbort(errno);", "  void isBenignAbort; return true;"),
  },
  {
    name: "8 webviewNav：attach 后安全网仍重发（力竭式重试 = 每 300ms 一次）",
    file: F_NAV,
    mutate: (t) => sub(t, 'if (trigger === "net" && attached) { return false; }', 'if (false) { return false; }'),
  },
  {
    /* ⚠️ 把「整行判定」退化成 `includes`：正文里写到「见【附件】说明」的那一行会被当成附件吞掉半句
       —— 用户看到的正文缺一块，而附件列表里多出一个假路径。 */
    name: "9 docAttachments：附件判定退化成 includes（正文里提到标记的半句被吞）",
    file: F_ATTACH,
    mutate: (t) => sub(t, "if (t.startsWith(DOC_ATTACH_MARK)) {", "if (t.includes(DOC_ATTACH_MARK)) {"),
  },
  {
    name: "10 docAttachments：不清尾部空行（气泡底部多出一截空白）",
    file: F_ATTACH,
    mutate: (t) => sub(t, 'const body = kept.join("\\n").replace(/\\n+$/, "");', 'const body = kept.join("\\n");'),
  },
  {
    name: "11 docAttachments：空附件列表也产出块（每条消息凭空多两个空行）",
    file: F_ATTACH,
    mutate: (t) => sub(t, 'if (list.length === 0) { return ""; }', 'if (list.length === 0) { return "\\n\\n"; }'),
  },
  {
    name: "12 docView：excel 的列字母行当数据（表头丢失，用户看到第一行是 A|B）",
    file: F_VIEW,
    mutate: (t) => sub(t, "if (cur.header.length === 0 && cur.rows.length === 0 && line.split(CELL_SEP).every((c) => COL_LETTERS_RE.test(c.trim()))) {\n      cur.header = cells;                    // 列字母行 = 表头（不进数据）\n      continue;\n    }", ""),
  },
  {
    name: "13 docView：分页标记认不出来（pptx 所有页粘成一块，页边界这个唯一结构丢了）",
    file: F_VIEW,
    mutate: (t) => sub(t, "const PAGE_RE = /^-{2,}\\s*(第\\s*\\d+\\s*页)\\s*-{2,}$/;", "const PAGE_RE = /^$^/;"),
  },
  {
    /* ⚠️ A-1133 重锚（原锚 `flushPara()` 随「一行一块」重写而消失）：
       现在段落是「一行一块」，**换行是结构**，不靠 CSS 兜。把相邻非空行再并回一个段落
       ⇒ 用户实测的「就连能渲染的 word 都连正常换行都不会」原样复发。 */
    name: "14 docView：相邻非空行被并回同一段落（换行退回 CSS 兜 ⇒ 用户实测的「word 不会换行」）",
    file: F_VIEW,
    mutate: (t) => sub(t, 'out.push({ type: "para", text: line });',
      'const _p = out[out.length - 1]; if (_p && _p.type === "para" && (lines[i - 1] ?? "").trim()) { _p.text += "\\n" + line; } else { out.push({ type: "para", text: line }); }'),
  },
  {
    /* ⚠️ `startsTable` 恒假 ⇒ docx 里含 ` | ` 的表格块退回成行文本（用户截图当场拍到的那一处）。 */
    name: "15 docView：表格识别恒假（docx 的表格退化成 `a | b` 行文本）",
    file: F_VIEW,
    mutate: (t) => sub(t, "  return i + 1 < lines.length && isTableRow(lines[i + 1]) && lines[i + 1].split(CELL_SEP).length === cols;", "  return false;"),
  },
  {
    /* ⚠️ 不转义 ⇒ 正文里的 `<` `&` 被浏览器当标签吃掉（内容静默丢失，比报错更难发现）。 */
    name: "16 docView：HTML 不转义（正文里的 `<` `&` 被当标签吃掉，内容静默丢失）",
    file: F_VIEW,
    mutate: (t) => sub(t, '    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")', '    .replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">")'),
  },
  {
    /* ⚠️ A-1133：用户实测「网页上什么都出现不了」的**根因本体** ——
       写盘用 `<safe>-<hash>.html`，返回的 `name` 却另算成 `<safe>.html`
       ⇒ 右栏按 `name` 拼 URL ⇒ 指向不存在的文件 ⇒ 404 ⇒ 整页空白。
       把两处重新分成两个产地，就是这次事故的复现。 */
    name: "17 previewPage：返回的 name 与落盘文件名不同源（右栏 404 ⇒ 整页空白）",
    file: F_PREVIEW,
    mutate: (t) => sub(t, "return { path: join(dir, fileName), name: fileName };",
      "return { path: join(dir, fileName), name: `${previewSafeName(name)}.html` };"),
  },
  {
    /* ⚠️ 用户要求「**所有** Office 办公文件全给我做一遍适配」。把老版族收窄回 doc/xls/ppt
       ⇒ .dot/.xlt/.pot/.pps 被判 unknown ⇒ **拖入时被拒**（「拖进来没反应」，正是本次事故的形状）。 */
    name: "18 fileKinds：老版族被收窄回 doc/xls/ppt（.dot/.xlt/.pot/.pps 又变未知类型被拒）",
    file: F_KINDS,
    mutate: (t) => sub(t, 'if (WORD_LEGACY.includes(ext) || EXCEL_LEGACY.includes(ext) || PPT_LEGACY.includes(ext)) {',
      'if (ext === "doc" || ext === "xls" || ext === "ppt") {'),
  },
  {
    /* ⚠️ 判据侧放行、解析侧不认 ⇒ 用户看到「拖进来了但读不出内容」（比拒收更难查的漂移形状）。 */
    name: "19 doc_text：解析侧 OLE 映射被收窄（.dot/.xlt/.pot/.pps 放行后读不出）",
    file: F_DOCTEXT,
    mutate: (t) => sub(t, '  ".doc": "doc", ".dot": "doc",\n  ".xls": "xls", ".xlt": "xls",\n  ".ppt": "ppt", ".pot": "ppt", ".pps": "ppt",',
      '  ".doc": "doc",\n  ".xls": "xls",\n  ".ppt": "ppt",'),
  },
  {
    /* ⚠️ 用户实测「内容渲染不出来原本的样子」：中文 min-content = 1 个汉字 ⇒ 短列被同伴的长内容
       压成**竖排单字**。去掉列宽下限就复现（几何判据会量出来）。 */
    name: "20 docView：去掉单元格列宽下限（短列被压成竖排单字，用户截图的形状）",
    file: F_VIEW,
    mutate: (t) => sub(t, "           min-width: ${DOC_CELL_MIN_EM}em; max-width: 28em;\n", ""),
  },
  {
    /* ⚠️ 用户实测「PPT 甚至连内容都没有」：容器判据恒真 ⇒ 母版/备注的 219 个占位符原子混回正文，
       把真正的课程内容淹没（截图里那一屏「单击此处编辑母版标题样式」）。 */
    name: "21 doc_text：PPT 容器判据恒真（母版/备注占位符混回正文，淹没真内容）",
    file: F_DOCTEXT,
    mutate: (t) => sub(t, "      const onSlide = stack.some((s) => s.type === PPT_RT_SLIDE);",
      "      const onSlide = true; void PPT_RT_SLIDE;"),
  },
  {
    /* ⚠️ 不分页 ⇒ 所有页粘成一块，且下游 `buildDocView` 建不出页卡片（页边界这个唯一结构丢了）。 */
    name: "22 doc_text：页标记被破坏（PPT 所有页粘成一块、页卡片消失）",
    file: F_DOCTEXT,
    mutate: (t) => sub(t, "  return `--- 第 ${n} 页 ---`;", "  return `第 ${n} 页`;"),
  },
  {
    /* ⚠️ 用户实测「连正常换行都不会」的 **.doc 那一半**：`cleanWordText` 第 4 行的字符类
       `\x08-\x0A` 含 `\x09`(Tab) 与 `\x0A`(LF)，而那正是上一行刚生成的（`\x07`→`\t`、`\x0D`→`\n`）
       ⇒ 换行被自己的下一句抹掉。症状：真实文件 3623 字全篇 `\n = 0`，挤成一块。
       ⇒ 本变异就是把字符类改回那个错误范围 —— 守卫 `a1036-guards` 的 A-1133 ④ 组必须变红。
       ⚠️ 这条变异**不报错、不丢字**，只让结构静默消失 ⇒ 只有"断言换行真的在"的用例抓得住。 */
    name: "23 doc_text：.doc 控制字符清洗把刚生成的 Tab/LF 一起清掉（换行静默消失）",
    file: F_DOCTEXT,
    mutate: (t) => sub(t, "    .replace(/[\\x00-\\x06\\x08\\x0E-\\x1F]/g, \"\")",
      "    .replace(/[\\x00-\\x06\\x08-\\x0A\\x0E-\\x1F]/g, \"\")"),
  },
  /* ────────────── A-1135：HTML 网页预览的「原生样貌」 ──────────────
     用户原话：「我要的是那种类似以图片的形式直接用 HTML 用 Web 预览的功能，
               **而非转成 md 文件阅读**」（2026-09-28 截图：PPT 页 = 一段长文本套个框）。
     守卫 = tests/gui/a1135-native-preview.spec.ts（已加入 SPECS）。 */
  {
    /* ⚠️ 去掉纸张壳 ⇒ 退回"白底平铺的一坨文字"，正是用户拍的形态。 */
    name: "24 docView：去掉纸张壳 .page-shell（退回白底平铺，用户拍的「不是原生内容」）",
    file: F_VIEW,
    mutate: (t) => sub(t, '<div class="page-shell">', "<div>"),
  },
  {
    /* ⚠️ 首行不再升级成标题 ⇒ 页首和正文同字号，"幻灯片"变成"带标题的文本块"（旧形态）。 */
    name: "25 docView：PPT 首行不再升级为 <h3> 标题（页与段落无视觉层级）",
    file: F_VIEW,
    mutate: (t) => sub(t, 'bodyParts.push(`<h3>${esc(heading)}</h3>`)', "bodyParts.push(`<p>${esc(heading)}</p>`)"),
  },
  {
    /* ⚠️ 整页退回单个 <pre> —— 这是**旧实现的形态**，用户明确说"和 md 阅读没区别"。 */
    name: "26 docView：整页退回单个 <pre>（旧形态：幻灯片 = 一段长文本套个框）",
    file: F_VIEW,
    mutate: (t) => sub(t,
      '<div class="slide-body">${bodyParts.join("")}</div>',
      '<div class="slide-body"><pre>${esc(b.lines.join("\\n"))}</pre></div>'),
  },
  {
    /* ⚠️ 重新引入"关键词过滤"把真实正文降级成脚注 —— 本轮**实测推翻**的一版设计。
       实测两个理由（都写在 docView.ts 的长注释里）：① 抽取层已排除占位符 ⇒ 判据从未生效；
       ② 会把 `实验步骤：点击此处开始采集数据` 这类**真实正文**藏进小字脚注（比不降级更坏）。 */
    name: "27 docView：重新引入「占位符关键词过滤」（真实正文被降级藏进脚注）",
    file: F_VIEW,
    mutate: (t) => sub(t,
      "  for (const line of bodyLines) { bodyParts.push(`<p>${esc(line)}</p>`); }",
      "  for (const line of bodyLines) {\n" +
      "    const t2 = line.trim();\n" +
      "    const isPh = /单击此处|在此输入|在此键入|点击此处/.test(t2);\n" +
      "    if (isPh) { continue; }\n" +
      "    bodyParts.push(`<p>${esc(line)}</p>`);\n  }"),
  },
  {
    /* ⚠️ 表格丢掉滚动容器 ⇒ 列一多（或右栏拖窄）就把页面撑破（body 横向滚动、右边被切）。
       这条与 M20（列宽下限）是**两个不同**的洞：M20 管"列被压扁"，这条管"表格撑破页面"。 */
    name: "28 docView：表格丢掉滚动容器 .tbl-wrap（窄容器时撑破页面）",
    file: F_VIEW,
    mutate: (t) => sub(t, 'return `<div class="tbl-wrap"><table>${cap}${head}<tbody>${rows}</tbody></table></div>`;',
      "return `<table>${cap}${head}<tbody>${rows}</tbody></table>`;"),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** ⚠️ 一条变异要跑**全部** SPECS：判据横跨 core-ts 与 gui 两侧，漏跑一侧 = 假存活。 */
function runSpec() {
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1200) }; }
  return { ok: r.status === 0, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) { console.error("上一轮变异还没还原（manifest 还在）—— 先 --restore。"); process.exit(1); }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpec();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1133")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中`); missed.push(m.name); continue; }
    writeFileSync(path, next);
    const res = runSpec();
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); console.error(res.out); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
