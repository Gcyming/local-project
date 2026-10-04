/**
 * A-1136-⑬ 自适应验收：**在多个"右栏宽度"下**真渲染，量几何并截图。
 *
 * 用户实测反馈（2026-09-29）：「有部分文件是只显示一半而非全屏……不要像图中一样只放在最上面，
 * 就算是为了显示所有内容而只能放这么大，也得给我放在右侧边栏屏幕最中间」。
 *
 * ⇒ 判据必须包含**几何**（内容是否完整落在视口内、单屏时是否垂直居中）。
 *    "元素计数"（`probe-render-fidelity.mjs` 的判据）对这两个问题是**瞎的**：
 *    元素全都在，只是被裁 / 贴在顶上。
 *
 * ⚠️ 探针自身的两个坑（都已踩过）：
 *   1. 跑浏览器必须用**异步 spawn**（铁律 26：spawnSync 阻塞同进程 http server ⇒ 截图纯白）。
 *   2. 量测脚本必须**真的注入**进响应 HTML（上一版定义了却没注入 ⇒ 8 个宽度全"没量到"）。
 */
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "D:/pilot project";
const ESBUILD = ["esbuild@0.25.11", "esbuild@0.25.0", "esbuild@0.19.3"]
  .map((v) => join(ROOT, "node_modules/.pnpm", v, "node_modules", "esbuild"))
  .find((p) => existsSync(p));
if (!ESBUILD) { console.error("找不到 esbuild"); process.exit(2); }
const { build } = await import(pathToFileURL(join(ESBUILD, "lib", "main.js")).href);

const TMP = mkdtempSync(join(tmpdir(), "a1136-adapt-"));
const OUT = join(ROOT, "docs", "a1136-probe-out");
mkdirSync(OUT, { recursive: true });

/* ---------- 1. 打包 docRenderPage（`?raw` → 真实文件内容，与 Vite 行为一致） ---------- */
const rawPlugin = {
  name: "vite-raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({
      path: join(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "raw",
    }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({
      contents: "export default " + JSON.stringify(readFileSync(a.path, "utf8")) + ";",
      loader: "js",
    }));
  },
};
await build({
  entryPoints: [join(ROOT, "gui/src/main/docRenderPage.ts")],
  outfile: join(TMP, "page.cjs"),
  bundle: true, platform: "node", format: "cjs", external: ["electron"],
  plugins: [rawPlugin], logLevel: "error",
});
const { writeRenderPage } = await import(pathToFileURL(join(TMP, "page.cjs")).href);

/* ---------- 2. 生成渲染页 ---------- */
/* ⚠️ 每个样本带上它的**版式期望**（2026-09-30 改）：
   · `sheet` = 电子表格 ⇒ 应当**左上角铺开、铺满可用宽**（源文件里表格就是从左上角开始的），
     **不该**像幻灯片/纸张那样居中。用户原话：「excel表格目前显示还是太粗糙了，更贴合一点原本格式大小」。
   · 其余 = 幻灯片 / 纸张 ⇒ 单屏时**垂直居中**（⑬ 的判据）。 */
const SAMPLES = [
  { file: "C:/Users/MR/Downloads/第2章.pptx", sheet: false },
  { file: "C:/Users/MR/Downloads/20244222026-张裴文-《互联网思维》.docx", sheet: false },
  { file: "C:/Users/MR/Downloads/_a1136-test.xlsx", sheet: true },
].filter((x) => existsSync(x.file));
const SERVE = join(TMP, "serve");
mkdirSync(SERVE, { recursive: true });

const pages = [];
for (const smp of SAMPLES) {
  const f = smp.file;
  const r = writeRenderPage(SERVE, f, f.split(/[\\/]/).pop());
  if (r.ok) pages.push({ file: f, name: r.name, sheet: smp.sheet });
  else console.log("[跳过] " + f + "：" + r.error);
}
if (!pages.length) { console.error("没有可用样本"); process.exit(2); }

/* ---------- 3. 静态服务（模拟 http.serve 从根解析）+ 注入量测脚本 ---------- */
const MEASURE = "<script>"
  + "window.addEventListener('load',function(){setTimeout(function(){"
  + "  var s=document.getElementById('stage');if(!s){return;}"
  /* ⚠️ 量 **`#stage` 的直接子元素**的并集 —— 这才是"要居中的那份内容"。
     量 `.sheet-box` 会漏掉它上方的 `<h3>` 表名 ⇒ 内容盒偏小 ⇒ 中点偏移 ⇒ 误报"未居中"
     （本探针上一版就因此对 xlsx 误报偏 49px）。 */
  + "  var boxes=s.children;"
  + "  var t=Infinity,b=-Infinity,l=Infinity,r=-Infinity,n=0;"
  + "  for(var i=0;i<boxes.length;i++){var q=boxes[i].getBoundingClientRect();"
  + "    if(q.width<2&&q.height<2){continue;} n++;"
  + "    if(q.top<t){t=q.top;} if(q.bottom>b){b=q.bottom;}"
  + "    if(q.left<l){l=q.left;} if(q.right>r){r=q.right;}}"
  + "  if(!n){var q2=s.getBoundingClientRect();t=q2.top;b=q2.bottom;l=q2.left;r=q2.right;n=0;}"
  + "  var d={vw:window.innerWidth,vh:window.innerHeight,"
  + "    left:Math.round(l),right:Math.round(r),top:Math.round(t),bottom:Math.round(b),"
  + "    w:Math.round(r-l),h:Math.round(b-t),n:boxes.length,"
  + "    barH:Math.round((document.querySelector('.bar')||{getBoundingClientRect:function(){return{height:0};}})"
  + "      .getBoundingClientRect().height),"
  + "    stageTop:Math.round(s.getBoundingClientRect().top),"
  + "    stageH:Math.round(s.getBoundingClientRect().height),"
  + "    ready:document.body.hasAttribute('data-ready'),"
  + "    err:(function(){var e=document.getElementById('err');"
  + "      return !!(e&&e.style.display==='block');})()};"
  + "  var el=document.createElement('div');el.id='measure';el.textContent=JSON.stringify(d);"
  + "  document.body.appendChild(el);"
  + "},4500);});"
  + "</script>";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const ext = extname(url).toLowerCase();
  let buf;
  try {
    const abs = join(SERVE, url.replace(/^\/+/, ""));
    if (!abs.startsWith(SERVE)) { res.writeHead(403).end("no"); return; }
    /* ⚠️ 必须**先读完再 writeHead**：`readFileSync` 抛错时若头已发出，
       404 分支再 writeHead ⇒ `ERR_HTTP_HEADERS_SENT` 把进程打挂。 */
    buf = readFileSync(abs);
  } catch { res.writeHead(404).end("nf"); return; }

  const type = MIME[ext] || "application/octet-stream";
  if (ext === ".html") {
    const s = buf.toString("utf8");
    const i = s.lastIndexOf("</body>");
    res.writeHead(200, { "content-type": type });
    res.end(i >= 0 ? s.slice(0, i) + MEASURE + s.slice(i) : s + MEASURE);
    return;
  }
  res.writeHead(200, { "content-type": type });
  res.end(buf);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port + "/";

/* ---------- 4. 浏览器 ---------- */
const BROWSER = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
if (!BROWSER) { console.error("找不到 Edge"); process.exit(2); }

/** ⚠️ 异步 spawn（铁律 26）。 */
function runBrowser(url, { shot = null, dump = false, w = 700, h = 900, waitMs = 12000 } = {}) {
  const argv = ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--user-data-dir=" + join(TMP, "prof-" + w + "-" + (dump ? "d" : "s")),
    "--timeout=" + waitMs, "--virtual-time-budget=" + waitMs,
    "--window-size=" + w + "," + h];
  if (shot) argv.push("--screenshot=" + shot);
  if (dump) argv.push("--dump-dom");
  argv.push(url);
  return new Promise((res) => {
    const p = spawn(BROWSER, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString("utf8"); });
    p.on("close", () => res(out));
    setTimeout(() => { try { p.kill(); } catch { /* ignore */ } res(out); }, waitMs + 30000);
  });
}

/* ---------- 5. 逐宽度验收 ---------- */
/** 模拟右栏可能出现的宽度：窄（分屏）→ 中 → 宽（大屏） */
const WIDTHS = [520, 700, 980, 1280];
let bad = 0;

for (const { file, name, sheet } of pages) {
  const base = file.split(/[\\/]/).pop();
  console.log("\n=== " + base + " ===");
  const url = BASE + name.replace(/\\/g, "/");
  for (const w of WIDTHS) {
    const dom = await runBrowser(url, { dump: true, w, h: 900 });
    const m = dom.match(/id="measure">([^<]*)</);
    if (!m) { console.log("  w=" + w + "  ⚠️ 没量到（量测脚本没执行？）"); bad++; continue; }
    const d = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));

    const overflow = d.left < -2 || d.right > d.vw + 2;
    /* 单屏（内容比视口矮）时才要求垂直居中；高于一屏的内容按"可滚动"对待（底线=内容都能看到） */
    const oneScreen = d.h < d.vh - 60;
    /* ⚠️ 居中判据要相对**舞台区域**（页头以下），不是相对整个视口：
       内容是在 `#stage` 里居中的，而 `#stage` 从 `barH` 开始往下。
       容差 40px = 允许滚动条高度（headless 下会出现横向滚动条，占 ~17px）+ 行高取整。 */
    const stageMid = d.barH + (d.vh - d.barH) / 2;
    const boxMid = (d.top + d.bottom) / 2;
    const centered = !oneScreen || Math.abs(boxMid - stageMid) < 40;
    /* ⚠️ **电子表格走另一条版式判据**（2026-09-30）：左上角铺开、不居中。
       `topGap` = 内容顶到页头下沿的距离（居中时它会接近舞台高的一半）；
       `leftGap` = 内容左边界到视口左边的距离（居中时也会很大）。 */
    const topGap = d.top - d.barH;
    const topAligned = topGap >= 0 && topGap < 120 && d.left < 80;
    const layoutOk = sheet ? topAligned : centered;
    const ok = d.ready && !d.err && !overflow && layoutOk;

    console.log("  w=" + String(w).padStart(4)
      + "  x[" + String(d.left).padStart(5) + "," + String(d.right).padStart(5) + "] / vw=" + d.vw
      + "  内容高=" + String(d.h).padStart(5)
      + "  页头高=" + d.barH + " 舞台高=" + d.stageH
      + (d.ready ? "  ready✓" : "  ❌未就绪")
      + (overflow ? "  ❌横向被裁" : "  ✓完整")
      + (sheet
          ? (topAligned ? "  ✓左上铺开(顶距 " + Math.round(topGap) + ")" : "  ❌未左上铺开(顶距 " + Math.round(topGap) + " 左距 " + Math.round(d.left) + ")")
          : (oneScreen ? (centered ? "  ✓垂直居中" : "  ❌偏 " + Math.round(boxMid - stageMid)) : "  （高于一屏，可滚）"))
      + (d.err ? "  ❌错误横幅" : ""));
    if (!ok) bad++;

    if (w === 520 || w === 700) {
      const shot = join(OUT, "adapt-" + w + "-" + base.replace(/[^\w.\u4e00-\u9fa5-]/g, "_") + ".png");
      await runBrowser(url, { shot, w, h: 900 });
    }
  }
}

server.close();
rmSync(TMP, { recursive: true, force: true });
console.log(bad ? "\n❌ " + bad + " 处不合格" : "\n✅ 自适应验收通过（各宽度内容完整；幻灯片/纸张单屏垂直居中；电子表格左上铺开）");
process.exit(bad ? 1 : 0);
