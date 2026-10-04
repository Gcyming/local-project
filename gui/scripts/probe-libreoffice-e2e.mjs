#!/usr/bin/env node
/**
 * gui/scripts/probe-libreoffice-e2e.mjs — 阶段 C（老格式 → LibreOffice → PDF）端到端探针。
 *
 * ## 为什么有两种模式（真机 + 注入）
 * · **真机模式**（本机装了 LibreOffice 就跑）：证明"装了的机器上真的能用" —— 这是用户视角的最终判据。
 * · **注入模式**（离线也能跑）：Windows 上**造不出能被 spawn 的假 soffice**（实测）：
 *     `#!` 脚本 spawn 报 **ENOENT**；`.cmd`/`.bat` 不带 `shell:true` 报 **EINVAL**（CVE-2024-27980 的修复），
 *     而生产代码**不该**开 `shell`。⇒ 用 `setConvertRunner` 注入替身，
 *     把「探测 → 参数拼装 → 结果判定 → 产物发现 → 清理」整条链跑一遍，作为**回归保护**。
 *
 * ## ⚠️ 本轮（09-30）最重要的判据：**必须选 `soffice.com` 而不是 `soffice.exe`**
 * `soffice.exe` 是 **GUI 子系统**程序：不往 stdout 写、启动器一直等 GUI ⇒
 * `--version` 挂死 20~25s 零输出（加 `--headless` 也一样），且**留下孤儿 `soffice.bin`**。
 * 探测超时 8s ⇒ 被判"没装" ⇒ 用户**明明装了却被告知去下载** ⇒ "老文件看不了"。
 * `soffice.com` 是同一目录的控制台版：`--version` 0.28s 返回。
 * ⇒ 真机模式**直接断言探测结果的路径以 `.com` 结尾** —— 这一条就是本次故障的回归守卫。
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, statSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const esbuild = (await import(
  pathToFileURL(join(ROOT, "node_modules/.pnpm/esbuild@0.25.11/node_modules/esbuild/lib/main.js")).href
)).default;

const entry = join(ROOT, "gui/scripts/_tmp-lo-entry.ts");
writeFileSync(entry,
  "export { probeLibreOffice, convertToPdf, cleanupConvertDir, setConvertRunner, buildConvertArgs } from " +
  JSON.stringify(join(ROOT, "gui/src/main/libreofficeConvert.ts").split("\\").join("/")) + ";");
const built = await esbuild.build({
  entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, external: ["node:*"],
});
rmSync(entry, { force: true });
const mod = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  \u2713 " + m); };
const no = (m) => { fail++; console.log("  \u2717 " + m); };
const skip = (m) => { console.log("  \u25cb " + m); };

const work = mkdtempSync(join(tmpdir(), "slime-lo-probe-"));
/* 真实样本（用 Downloads 里那份损坏且体积小的 .doc；转换能产出 PDF 即可，内容无关）。 */
const REAL_DOC = "C:/Users/MR/Downloads/EDA第九组实验一报告.doc";

/* ── ① 真机探测（不注入、不给环境变量覆盖）── */
console.log("[阶段C] ① 真机探测（真实 spawn）");
let loUsable = false;
{
  delete process.env.SLIME_LIBREOFFICE_PATH;
  delete process.env.LIBREOFFICE_PATH;
  mod.setConvertRunner(null);
  const t0 = Date.now();
  const probe = await mod.probeLibreOffice(true);
  const ms = Date.now() - t0;
  if (probe.found) {
    loUsable = true;
    ok("认出本机 LibreOffice：version=" + probe.version + "（探测耗时 " + ms + "ms）");
    console.log("      路径 = " + probe.path);
    /* ⚠️⚠️ 本次故障的**直接回归守卫**：必须是 `.com`（控制台版），不能是 `.exe`（会挂死）。 */
    if (/soffice\.com$/i.test(probe.path)) { ok("路径以 soffice.com 结尾（控制台版 —— 这是修好的标志）"); }
    else { no("路径不是 .com 而是 " + probe.path + " ⇒ `.exe` 会挂死 20~25s 且留孤儿进程"); }
    if (ms < 5000) { ok("探测在 5s 内返回（`.exe` 会挂满超时）"); }
    else { no("探测耗时 " + ms + "ms，疑似仍在走挂死路径"); }
  } else {
    /* 本机没装也算"通过"：必须给出**可操作**提示，而不是静默失败。 */
    ok("本机无 LibreOffice ⇒ 走 notFound 分支（这本身是合法状态）");
    if (String(probe.hint).includes("https://www.libreoffice.org/")) { ok("hint 含可操作下载地址"); }
    else { no("hint 不可操作：" + String(probe.hint).slice(0, 120)); }
  }
}

/* ── ② 真机转换（装了才跑；这是用户视角的最终判据）── */
console.log("[阶段C] ② 真机转换（真实 spawn → 真 PDF）");
if (loUsable && existsSync(REAL_DOC)) {
  const t0 = Date.now();
  const r = await mod.convertToPdf(REAL_DOC);
  const ms = Date.now() - t0;
  if (r.ok && r.pdfPath && existsSync(r.pdfPath)) {
    const size = statSync(r.pdfPath).size;
    ok("真机转换成功：" + size + " 字节 / " + Math.round(ms / 1000) + "s");
    const head = readFileSync(r.pdfPath).subarray(0, 5).toString();
    if (head === "%PDF-") { ok("产物 magic = %PDF-"); } else { no("magic 不对：" + JSON.stringify(head)); }
    if (size > 1000) { ok("产物不是空壳（>1KB）"); } else { no("产物过小：" + size); }
    const keep = r.dir;
    mod.cleanupConvertDir(keep);
    if (!existsSync(keep)) { ok("cleanupConvertDir 真删了临时目录（用户要的「不留文件」）"); }
    else { no("临时目录没删掉：" + keep); }
  } else {
    no("真机转换失败：" + JSON.stringify(r).slice(0, 220));
  }
} else {
  skip("跳过真机转换（本机无 LibreOffice 或样本不存在：" + REAL_DOC + "）");
}

/* ── ③ 注入模式：探测 + 转换 + 清理（离线回归保护）── */
console.log("[阶段C] ③ 注入模式（离线可跑）：探测 + 转换 + 产物发现 + 清理");
{
  const fakeBin = join(work, "soffice.exe");
  writeFileSync(fakeBin, "stub");
  process.env.SLIME_LIBREOFFICE_PATH = fakeBin;
  mod.setConvertRunner(async (_bin, args) => {
    if (args.includes("--version")) { return { ok: true, stdout: "LibreOffice 7.6.4.1 639b8ac4857", stderr: "", error: "" }; }
    const out = args[args.indexOf("--outdir") + 1];
    const src = args[args.length - 1];
    const base = src.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    writeFileSync(join(out, base + ".pdf"), "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
    return { ok: true, stdout: "convert as pdf", stderr: "", error: "" };
  });
  const probe = await mod.probeLibreOffice(true);
  if (probe.found && probe.version === "7.6.4.1") { ok("注入探测认出来（version=" + probe.version + "）"); }
  else { no("注入探测失败：" + JSON.stringify(probe)); }

  const srcDoc = join(work, "样例.doc");
  writeFileSync(srcDoc, Buffer.alloc(2048, 7));
  const r = await mod.convertToPdf(srcDoc);
  if (r.ok && r.pdfPath && statSync(r.pdfPath).size > 0) { ok("注入转换产出真 PDF"); }
  else { no("注入转换失败：" + JSON.stringify(r).slice(0, 200)); }
  mod.cleanupConvertDir(r.dir);
  process.env.SLIME_LIBREOFFICE_PATH = "";
}

/* ── ④ 退出码 0 却没产物 ⇒ 必须判 failed（LibreOffice 的真实陷阱）── */
console.log("[阶段C] ④ 退出码 0 却没产物 ⇒ 必须判 failed");
{
  const fakeBin = join(work, "soffice.exe");
  process.env.SLIME_LIBREOFFICE_PATH = fakeBin;
  mod.setConvertRunner(async (_bin, args) => {
    if (args.includes("--version")) { return { ok: true, stdout: "LibreOffice 7.6.4.1 641", stderr: "", error: "" }; }
    return { ok: true, stdout: "", stderr: "", error: "" };   // ok=true 但什么都不写
  });
  await mod.probeLibreOffice(true);
  const srcDoc = join(work, "样例2.doc");
  writeFileSync(srcDoc, Buffer.alloc(2048, 7));
  const r = await mod.convertToPdf(srcDoc);
  if (r.ok === false && r.reason === "failed") { ok("判 failed（**没被退出码 0 骗过**）"); }
  else { no("被退出码 0 骗了：" + JSON.stringify(r).slice(0, 200)); }
  process.env.SLIME_LIBREOFFICE_PATH = "";
}

/* ── ⑤ 参数拼装 ── */
console.log("[阶段C] ⑤ 参数拼装（每个参数挡一个真实故障）");
{
  const args = mod.buildConvertArgs("/tmp/profile", "/tmp/out", "/tmp/a.doc");
  const need = ["--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck", "--nofirststartwizard"];
  const missing = need.filter((f) => !args.includes(f));
  if (missing.length === 0) { ok("六个 headless 参数齐全"); } else { no("缺参数：" + missing.join(",")); }
  const env = args.find((a) => a.startsWith("-env:UserInstallation="));
  if (env && env.includes("file://")) { ok("带独立 profile 的 file:// URL（绕单实例锁）"); }
  else { no("缺或格式不对：" + String(env)); }
}

mod.setConvertRunner(null);
try { rmSync(work, { recursive: true, force: true }); } catch { /* noop */ }
console.log("\n[阶段C] 结果：" + pass + " 通过 / " + fail + " 失败" + (loUsable ? "（含真机验证）" : "（本机无 LO，真机部分跳过）"));
process.exit(fail === 0 ? 0 : 1);
