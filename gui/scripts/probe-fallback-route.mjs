#!/usr/bin/env node
/**
 * gui/scripts/probe-fallback-route.mjs — 「老格式兜底路线」端到端探针（2026-09-30 用户拍板）。
 *
 * ## 验什么
 * 用户口径：「**LibreOffice 优先 + SheetJS 兜底**」。所以两条都要成立：
 * ① `.xls` 走兜底（`useFallback`）**真能落盘**，且产出的页面**真的引了 SheetJS**、
 *    也**真的带可见提示条**（静默降级 = 用户以为"这文件就长这样"）；
 * ② 没登记 `fallback` 的类型（`.doc`）**即使传了 `useFallback` 也仍被拒** ——
 *    否则会画出一片空白（把"能力边界"当儿戏）；
 * ③ **默认路径一字不变**：`.xls` 不给 `useFallback` 时仍按"要 LibreOffice"被拒。
 *
 * ## 样本从哪来
 * 本机没有现成的老 `.xls` ⇒ **用 LibreOffice 把 `.xlsx` 转一个真的 BIFF8 `.xls`** 出来当样本。
 * （这也顺便证明了两条路能在同一台机器上共存。）
 *
 * ⚠️ `?raw` 是 Vite 专有语法，esbuild CLI 认不了 ⇒ 必须用 JS API + plugin（同 `probe-render-fidelity.mjs`）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const GUI = join(ROOT, "gui");

function findEsbuildDir() {
  const cands = [
    join(ROOT, "node_modules", ".pnpm", "esbuild@0.25.11", "node_modules", "esbuild"),
    join(ROOT, "node_modules", ".pnpm", "esbuild@0.25.0", "node_modules", "esbuild"),
    join(ROOT, "node_modules", ".pnpm", "esbuild@0.19.3", "node_modules", "esbuild"),
  ];
  for (const c of cands) { if (existsSync(join(c, "lib", "main.js"))) { return c; } }
  throw new Error("找不到 esbuild");
}
const esbuildMod = await import(pathToFileURL(join(findEsbuildDir(), "lib", "main.js")).href);
const esbuild = esbuildMod.default ?? esbuildMod;

const rawPlugin = {
  name: "vite-raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({
      path: resolve(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "raw",
    }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (a) => ({
      contents: "export default " + JSON.stringify(await (await import("node:fs/promises")).readFile(a.path, "utf8")) + ";",
      loader: "js",
    }));
  },
};

const TMP = mkdtempSync(join(tmpdir(), "slime-fb-probe-"));
const bundle = join(TMP, "docRenderPage.mjs");
await esbuild.build({
  entryPoints: [join(GUI, "src/main/docRenderPage.ts")],
  bundle: true, platform: "node", format: "esm", outfile: bundle,
  external: ["electron"], plugins: [rawPlugin], logLevel: "warning",
});
const mod = await import(pathToFileURL(bundle).href);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  \u2713 " + m); };
const no = (m) => { fail++; console.log("  \u2717 " + m); };
const skip = (m) => { console.log("  \u25cb " + m); };

/* ── 造一个真 .xls 样本（LibreOffice 转）── */
const SRC_XLSX = "C:/Users/MR/Downloads/_a1136-test.xlsx";
const SOFFICE = "C:/Program Files/LibreOffice/program/soffice.com";
const work = join(TMP, "samples");
mkdirSync(work, { recursive: true });
/* ⚠️ LibreOffice 的产物名 = **源文件基名** + 新扩展名（不是我们指定的名字）。 */
const realXls = join(work, "_a1136-test.xls");

console.log("[兜底] ① 造真 BIFF8 样本（LibreOffice 转 .xlsx → .xls）");
await new Promise((res) => {
  if (!existsSync(SOFFICE) || !existsSync(SRC_XLSX)) { skip("无 LibreOffice 或样本 ⇒ 跳过造样本"); return res(); }
  const p = spawn(SOFFICE, ["--headless", "--convert-to", "xls", "--outdir", work, SRC_XLSX], { windowsHide: true, stdio: "ignore" });
  p.on("close", () => res());
  p.on("error", () => res());
});
if (existsSync(realXls)) { ok("样本就位：" + realXls.replace(/\\/g, "/").split("/").pop()); }
else { skip("样本未生成 ⇒ 下面用占位字节（只验「路线被接通」，不验真实内容）"); }

const xlsPath = existsSync(realXls) ? realXls : join(work, "占位.xls");
if (!existsSync(xlsPath)) { writeFileSync(xlsPath, Buffer.alloc(512, 1)); }
const docPath = join(work, "占位.doc");
writeFileSync(docPath, Buffer.alloc(512, 1));

/* ── ② `.xls` 走兜底：必须落盘，且页面真引 SheetJS + 真带提示 ── */
console.log("[兜底] ② `.xls` 走兜底路线（useFallback）");
{
  const r = mod.writeRenderPage(join(TMP, "out-xls"), xlsPath, "样例.xls", {
    useFallback: true, notice: "测试提示：没装 LibreOffice（当前按表格方式显示）",
  });
  if (r.ok && r.dir) { ok("兜底渲染落盘成功"); } else { no("兜底渲染失败：" + JSON.stringify(r)); }
  if (r.ok) {
    const html = readFileSync(join(r.dir, r.name), "utf8");
    /* ⚠️ 库文件名是 `_lib/xlsx-<sha1前12位>.js`（内容哈希命名），**不是** `xlsx.full.min.js` ——
       所以锚「xlsx」+ `.js` 即可（别锚错名字，那是"守卫写错"的经典形态）。 */
    if (/_lib\/xlsx-[0-9a-f]{12}\.js/.test(html)) { ok("页面引了 SheetJS（`_lib/xlsx-<hash>.js`）"); }
    else { no("页面没引 SheetJS ⇒ 表格画不出来"); }
    if (/class="notice"/.test(html) && html.includes("测试提示")) { ok("页面**真的**渲染了提示条（不是静默降级）"); }
    else { no("提示条没渲染 ⇒ 用户会以为这是原版式"); }
  }
}

/* ── ③ 没登记 fallback 的类型：传了也必须拒 ── */
console.log("[兜底] ③ 没登记 fallback 的类型（`.doc`）即使传 useFallback 也必须拒");
{
  const r = mod.writeRenderPage(join(TMP, "out-doc"), docPath, "占位.doc", { useFallback: true });
  if (r.ok === false) { ok("正确拒绝（`useFallback` 只能触发**已登记**的兜底）"); }
  else { no("放行了 ⇒ 会画出一片空白（把能力边界当儿戏）"); }
}

/* ── ④ 默认路径不变：`.xls` 不给 useFallback ⇒ 仍按"要 LibreOffice"被拒 ── */
console.log("[兜底] ④ 默认路径一字不变（不给 useFallback ⇒ 仍要 LibreOffice）");
{
  const r = mod.writeRenderPage(join(TMP, "out-plain"), xlsPath, "样例.xls");
  if (r.ok === false) { ok("未给 useFallback ⇒ 正确拒绝（优先 LibreOffice 的口径没被改）"); }
  else { no("没给 useFallback 也放行了 ⇒ 兜底变成默认，绕过了 LibreOffice 优先"); }
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }
console.log("\n[兜底] 结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
