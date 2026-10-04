#!/usr/bin/env node
/**
 * gui/scripts/probe-diff-band.mjs —— diff 行底色「铺满**滚动内容**」的**几何真判据**。
 *
 * 为什么必须有它（A-1130 的教训，2026-09-28 被用户截图打回）：
 *   `tests/gui/a1130-diff-row-band.spec.ts` 里对列轨的断言是**文本**断言 —— 它能拦住
 *   "又写回那个错表达式"，但拦不住"换一个**同样错**的表达式"。
 *   A-1130 首版写的就是 `minmax(100%, max-content)`：文本上毫无破绽（有 grid、有 minmax、
 *   有 100% 下界、有 max-content），**实测却有洞**（`100%` 吃掉 free space ⇒ 列轨涨不到最宽行）。
 *   ⇒ 唯一真判据是**量**：行盒宽度是否 >= 容器的 scrollWidth。
 *
 * 做法：把仓库的 `gui/src/renderer/index.css` **原文**内联进一个最小复现页
 *   （结构照 `ChatPanel.tsx::DiffBlock` 复刻），用本机 Chromium 内核（Edge/Chrome）跑
 *   `--headless=new --dump-dom`，页面里的脚本把测量结果写进 `<pre id="out">` ⇒ 直接读数字。
 *   ⚠️ **不手抄任何 CSS 常量** —— 手抄的副本必漂（`docs/*.html` 预览页前科，铁律 10）。
 *
 * 判据：两种内容下都要 `行宽 >= 容器 scrollWidth`
 *   A 全部短行（内容比可视区窄）—— 验"短行右侧不缺块"；
 *   B 含一条远超可视宽的长行（有横向滚动）—— 验"底色覆盖全部滚动内容、能到极限位置"。
 *
 * 用法：node gui/scripts/probe-diff-band.mjs        （退出码 0 = 全过）
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "gui", "src", "renderer", "index.css"), "utf8");

/** 找本机 Chromium 内核（Electron 之外最接近的引擎：同为 Blink） */
function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) ?? null;
}

const SHORT = [
  '    ck = r.get("ds_auth_token", "n/a")',
  '    print(json.dumps(ck, ensure_ascii=False)[:300])',
  'print(os.path.exists(p))',
];
const LONG = '        lines = open(r"D:\\试验场\\deepseek_gateway\\gateway_run.log", encoding="utf-8", errors="replace").read().splitlines() + [x for x in os.environ.get("SLIME_EXTRA_LOGS", "").split(";") if x]';
const CASES = { A: SHORT, B: [SHORT[0], LONG, SHORT[1], SHORT[2]] };

const rowHtml = (text, op = "add") => {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div class="think-diff-row diff-${op}"><span class="think-diff-mark">${op === "add" ? "+" : " "}</span><span class="think-diff-text">${esc}</span></div>`;
};

const sections = Object.entries(CASES).map(([cname, lines]) => `<section data-case="${cname}">
  <div class="think-diff-block">
    <div class="think-diff-header"><span style="color:var(--success)">+14</span><span style="color:var(--danger);margin-left:6px">-0</span><span style="margin-left:auto;color:var(--text-dim)">vs 原内容</span></div>
    <div class="think-diff-body diff-rows-fit">${lines.map((l) => rowHtml(l)).join("")}</div>
  </div>
</section>`).join("\n");

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>diff 行底色几何探针</title>
<style>
${CSS}
#col { width: 900px; padding: 12px; box-sizing: border-box; background: var(--bg); }
section { margin-bottom: 14px; }
#out { font: 12px Consolas, monospace; white-space: pre; }
</style></head>
<body>
<div id="col">${sections}</div>
<pre id="out">pending</pre>
<script>
const f = (n) => Math.round(n * 100) / 100;
window.addEventListener("load", () => {
  const lines = [];
  for (const sec of document.querySelectorAll("section")) {
    const body = sec.querySelector(".think-diff-body");
    const rows = [...sec.querySelectorAll(".think-diff-row")];
    const rowW = f(Math.max(...rows.map((r) => r.getBoundingClientRect().width)));
    const ok = rows.every((r) => f(r.getBoundingClientRect().width) >= body.scrollWidth - 0.5);
    lines.push("case " + sec.dataset.case
      + "  clientW=" + String(body.clientWidth).padStart(5)
      + "  scrollW=" + String(body.scrollWidth).padStart(5)
      + "  track=" + String(getComputedStyle(body).gridTemplateColumns).padStart(10)
      + "  rowW=" + String(rowW).padStart(7)
      + "  " + (ok ? "PASS 底色铺满滚动内容" : "FAIL 露白（行宽 < 滚动内容宽）"));
  }
  document.getElementById("out").textContent = lines.join("\\n");
});
</script>
</body></html>`;

const browser = findBrowser();
if (!browser) {
  console.error("找不到 Chromium 内核（Edge/Chrome）。可用 CHROME_PATH 指定。");
  console.error("⚠️ 这条路走不通时**不要**退化成「看源码觉得对」 —— 文本断言正是这次漏掉的那个洞。");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "slime-diff-probe-"));
const page = join(work, "probe.html");
writeFileSync(page, html);
try {
  const r = spawnSync(browser, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
    `--user-data-dir=${join(work, "profile")}`,
    "--virtual-time-budget=4000", "--dump-dom",
    `file:///${page.replace(/\\/g, "/")}`,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(out);
  if (!m) {
    console.error("探针页没跑出结果（浏览器输出里找不到 <pre id=\"out\">）。");
    console.error(out.slice(-1500));
    process.exit(2);
  }
  const body = m[1].trim();
  console.log("[diff-band] 真实 Chromium 几何测量：");
  for (const l of body.split("\n")) { console.log("  " + l); }
  const failed = body.split("\n").filter((l) => l.includes("FAIL"));
  if (failed.length > 0) {
    console.error(`\n[diff-band] ❌ ${failed.length} 个情形露白 —— 行底色没有铺满滚动内容。`);
    process.exit(1);
  }
  console.log("\n[diff-band] ✅ 两种情形都铺满（行宽 == max(可视宽, 最宽行)）。");
} finally {
  rmSync(work, { recursive: true, force: true });
}
