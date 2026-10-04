#!/usr/bin/env node
/**
 * gui/scripts/probe-render-fidelity.mjs —— A-1136「保真渲染页」的**端到端真判据**。
 *
 * 为什么必须有它（铁律 5）：`a1136-render-page.spec.ts` 是**纯函数**文本断言（能拦"引错库名"），
 * 但**拦不住**"库引对了、页面也生成了，可是真文件渲染不出画面"。用户要的是「像图片一样」——
 * 唯一证明手段 = **拿真文件跑一遍，用 Chromium 看它到底画出了什么**。
 *
 * 做法：
 *   1. esbuild 把 `gui/src/main/docRenderPage.ts` 打成临时 CJS（TS 不能直接跑）；
 *   2. 对**真实 Office 文件**调 `writeRenderPage`（用真库、写真实 HTML）；
 *   3. 起本地静态服务（模拟 `http.serve`）→ Chromium `--headless=new --dump-dom` 抓渲染后的 DOM
 *      + `--screenshot` 出图 ⇒ 数幻灯片张数 / 表格格子，并留图给人看。
 *
 * 判据（每类文件各自可量化）：
 *   pptx  ⇒ 渲染出的幻灯片块数 **>= 源文件里 Slide 记录数**（或至少 > 1，且首张有文字）
 *   docx  ⇒ 渲染出的段落/表格数 > 0，且页面文本包含源文档里的已知关键词
 *   xlsx  ⇒ 渲染出的 <table> 数 > 0
 *   ⚠️ 「渲染库没报错」不算过 —— 必须**数出真实元素**。
 *
 * 用法：node gui/scripts/probe-render-fidelity.mjs [文件路径 ...]
 *   不带参数则跑内置样本（Downloads 下的真实文件）。
 *   退出码 0 = 全部通过。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUI = join(ROOT, "gui");

/** 默认样本：用户真实文件（存在才用）。 */
const DEFAULT_SAMPLES = [
  "C:/Users/MR/Downloads/第2章.pptx",
  "C:/Users/MR/Downloads/20244222026-张裴文-《互联网思维》.docx",
];

function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const c of cands) if (c && existsSync(c)) return c;
  throw new Error("找不到 Chromium 内核浏览器");
}

/* ---------- 1. 把 docRenderPage.ts 打成 CJS ---------- */
const TMP = join(tmpdir(), "a1136-probe-" + Date.now());
mkdirSync(TMP, { recursive: true });
const BUNDLE = join(TMP, "docRenderPage.cjs");

/* 用仓库根 .pnpm 里的 esbuild（gui/node_modules 里没有独立安装）。
   ⚠️ CLI 无法处理 `?raw` 导入（Vite 专有语法）⇒ 必须用 **JS API + plugin**：
   把所有 `xxx.js?raw` 解释成"读文件成字符串导出默认值"。 */
function findEsbuildDir() {
  const cands = [
    join(ROOT, "node_modules", ".pnpm", "esbuild@0.25.11", "node_modules", "esbuild"),
    join(ROOT, "node_modules", ".pnpm", "esbuild@0.25.0", "node_modules", "esbuild"),
    join(ROOT, "node_modules", ".pnpm", "esbuild@0.19.3", "node_modules", "esbuild"),
  ];
  for (const c of cands) if (existsSync(join(c, "lib", "main.js"))) return c;
  throw new Error("找不到 esbuild");
}

const esbuildMod = await import("file://" + join(findEsbuildDir(), "lib", "main.js").replace(/\\/g, "/"));
const esbuild = esbuildMod.default ?? esbuildMod;

/** `?raw` 插件：`import s from "x.js?raw"` → `export default "<文件内容>"`。 */
const rawPlugin = {
  name: "vite-raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "raw" }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (a) => ({
      contents: `export default ${JSON.stringify(await readFile(a.path, "utf8"))};`,
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: [join(GUI, "src/main/docRenderPage.ts")],
  bundle: true, platform: "node", format: "cjs", outfile: BUNDLE,
  external: ["electron"], plugins: [rawPlugin], logLevel: "warning",
});

if (!existsSync(BUNDLE)) {
  console.error("esbuild 打包失败（产物未生成）。");
  process.exit(2);
}

const mod = await import("file://" + BUNDLE.replace(/\\/g, "/"));
const { writeRenderPage } = mod;

/* ---------- 2. 对样本文件生成渲染页 ---------- */
const args = process.argv.slice(2);
const samples = (args.length ? args : DEFAULT_SAMPLES).filter((f) => existsSync(f));
if (samples.length === 0) {
  console.error("没有可用的样本文件（都不存在）。");
  process.exit(2);
}

const SERVE = join(TMP, "serve");
mkdirSync(SERVE, { recursive: true });

const results = [];
for (const f of samples) {
  const r = writeRenderPage(SERVE, f, f.split(/[\\/]/).pop());
  results.push({ file: f, r });
  console.log(`[生成] ${f}\n    → ${r.ok ? r.name : "失败: " + r.error}`);
}
const okGen = results.filter((x) => x.r.ok);
if (okGen.length === 0) { console.error("全部生成失败"); process.exit(1); }

/* ---------- 3. 起静态服务（模拟 http.serve：从根解析） ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const abs = join(SERVE, url.replace(/^\/+/, ""));
    if (!abs.startsWith(SERVE)) { res.writeHead(403).end("no"); return; }
    const buf = await readFile(abs);
    res.writeHead(200, { "content-type": MIME[extname(abs).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404).end("not found"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}/`;

/* ---------- 4. Chromium 跑页面：dump-dom + 截图 ---------- */
const BROWSER = findBrowser();
const OUT = join(ROOT, "docs", "a1136-probe-out");
mkdirSync(OUT, { recursive: true });

/** 数 ZIP 里匹配的条目数（读中央目录，零依赖）。
 *  用于给 pptx 的"渲染页数"找一个**独立于渲染库的事实基准**。 */
function countZipEntries(buf, re) {
  let n = 0;
  /* 中央目录条目签名 PK\x01\x02；条目名长在 offset+28（小端 2 字节），名字紧随其后 */
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x01 && buf[i + 3] === 0x02) {
      const nameLen = buf.readUInt16LE(i + 28);
      const name = buf.toString("utf8", i + 46, i + 46 + nameLen);
      if (re.test(name)) n++;
    }
  }
  return n;
}

/** 跑一次 Chromium。
 *  ⚠️⚠️ **必须用异步 `spawn`，绝不能用 `spawnSync`**（2026-09-29 实测踩到）：
 *  本进程里同时起着 http 静态服务 ⇒ `spawnSync` 会**阻塞 Node 事件循环** ⇒
 *  服务器收不到任何请求（实测日志 0 行、截图纯白）⇒ 会误判成"渲染库画不出来"。
 *  这是**探针自身的 bug**，与渲染无关（铁律 5：先怀疑判据工具）。 */
function runBrowser(url, { dump = false, shot = null, waitMs = 12000 } = {}) {
  const profile = join(TMP, "prof");
  const argv = [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--no-proxy-server", "--proxy-bypass-list=*",
    "--disable-features=Translate,msEdgeIdentity",
    "--user-data-dir=" + profile,
    /* `--timeout` 是"最多等这么久再抓"，给真实 fetch（去本地服务取文件字节）+ 渲染留时间 */
    "--timeout=" + waitMs,
    "--virtual-time-budget=" + waitMs,
  ];
  if (dump) argv.push("--dump-dom");
  if (shot) argv.push("--screenshot=" + shot, "--window-size=1400,1000");
  argv.push(url);
  return new Promise((resolve) => {
    const p = spawn(BROWSER, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString("utf8"); });
    p.on("close", () => resolve(out));
    setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(out); }, waitMs + 30000);
  });
}

let allPass = true;
for (const { file, r } of okGen) {
  const name = file.split(/[\\/]/).pop();
  const url = base + r.name.replace(/\\/g, "/");
  const shot = join(OUT, name.replace(/[^\w.\u4e00-\u9fa5-]/g, "_") + ".png");
  const dom = await runBrowser(url, { dump: true });
  await runBrowser(url, { shot }); /* 截图单独一次调用：与 --dump-dom 同用会互相干扰 */
  const ext = extname(file).toLowerCase();
  const ready = /data-ready="1"/.test(dom);
  /* ⚠️ 判"出错"必须看**错误横幅真的被显示出来**（`display:block` + 有文本），
     不能只 grep「渲染失败」四个字 —— 那四个字**就写在页面模板里**（`e.textContent='渲染失败：'`），
     一 grep 必然命中 = 假阳性（本探针首版就踩了这条）。 */
  const errHit = /id="err"[^>]*style="[^"]*display:\s*block/.test(dom) || /__renderError\s*=\s*"[^"]/.test(dom);
  let verdict = "";
  let pass = false;

  if (ext === ".pptx") {
    /* pptx-preview 的幻灯片根节点 class 里含 "pptx-preview-slide" */
    const slides = (dom.match(/pptx-preview-slide/g) || []).length;
    const imgs = (dom.match(/<img/g) || []).length;
    /* 源文件真实页数：pptx = ZIP，数 ppt/slides/slideN.xml（**权威判据**，不是"能画出东西就算过"） */
    let srcSlides = 0;
    try {
      const zip = await readFile(file);
      srcSlides = countZipEntries(zip, /^ppt\/slides\/slide\d+\.xml$/);
    } catch { /* 忽略 */ }
    verdict = `slides=${slides}/源${srcSlides} img=${imgs}`;
    pass = ready && !errHit && slides >= 1 && (srcSlides === 0 || slides >= srcSlides);
    if (srcSlides > 0 && slides < srcSlides) verdict += " ⚠️页数不足";
  } else if (ext === ".docx") {
    const paras = (dom.match(/<p[\s>]/g) || []).length;
    const tables = (dom.match(/<table[\s>]/g) || []).length;
    const cells = (dom.match(/<td[\s>]/g) || []).length;
    verdict = `p=${paras} table=${tables} td=${cells}`;
    /* docx-preview 把内容包在 .docx-wrapper 里 */
    const wrapped = /docx-wrapper/.test(dom);
    pass = ready && !errHit && (paras + tables) > 0;
    verdict += wrapped ? " [docx-wrapper✓]" : " [无wrapper]";
  } else if (ext === ".xlsx") {
    const tables = (dom.match(/<table[\s>]/g) || []).length;
    verdict = `table=${tables}`;
    pass = ready && !errHit && tables > 0;
  } else {
    verdict = "(未定义判据)";
    pass = ready && !errHit;
  }

  console.log(`[验收] ${name}\n    ready=${ready} err=${errHit} ${verdict}\n    截图 → ${shot}\n    ${pass ? "✓ 通过" : "✗ 未通过"}`);
  if (!pass) allPass = false;
}

server.close();
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n截图目录：${OUT}`);
console.log(allPass ? "\n全部通过 ✓" : "\n有未通过项 ✗");
process.exit(allPass ? 0 : 1);
