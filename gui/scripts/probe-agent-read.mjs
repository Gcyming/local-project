/* A-1136 验收 ②：**Agent 侧能不能理解这些 Office 文件**（用户硬约束）。
   测 `core-ts/src/doc_text.ts` —— `file_read` 工具分派到的**唯一产地**。

   ⚠️ 必须用 esbuild **只转译、不 bundle**：
     - bundle:true 会把 `node:zlib` 的调用形状破坏掉，运行期报
       `The "cb" argument must be of type function`（实测，纯属打包问题）；
     - Node 原生 `--experimental-strip-types` 又不认 TS 里的 `.js` 后缀相对导入。
   ⇒ 把整个 `core-ts/src` 转译到临时目录，并让 `.js` 后缀指向转译产物，再 import。 */
import { readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const ROOT = "D:/pilot project";
const esbuildDir = ROOT + "/node_modules/.pnpm/esbuild@0.25.11/node_modules/esbuild";
const m = await import("file:///" + esbuildDir + "/lib/main.js");
const esbuild = m.default ?? m;

const TMP = join(tmpdir(), "a1136-agent-" + Date.now());
mkdirSync(TMP, { recursive: true });

/** 收集 core-ts/src 下所有 .ts */
function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}
const files = walk(join(ROOT, "core-ts", "src"));
await esbuild.build({
  entryPoints: files,
  outdir: TMP, bundle: false, platform: "node", format: "esm",
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
});

/* esbuild 输出的 import 仍写 `./zip.js` ⇒ 把 `./zip.js` 指向 `./zip.mjs`：
   临时目录里同时保留一份 `.js` 副本（内容同 .mjs，ESM 由 package.json type 决定） */
writeFileSync(join(TMP, "package.json"), JSON.stringify({ type: "module" }));
for (const f of readdirSync(TMP)) {
  if (f.endsWith(".mjs")) writeFileSync(join(TMP, f.replace(/\.mjs$/, ".js")), readFileSync(join(TMP, f)));
}
for (const d of readdirSync(TMP)) {
  const dp = join(TMP, d);
  if (!statSync(dp).isDirectory()) continue;
  for (const f of readdirSync(dp)) {
    if (f.endsWith(".mjs")) writeFileSync(join(dp, f.replace(/\.mjs$/, ".js")), readFileSync(join(dp, f)));
  }
}

const mod = await import("file://" + join(TMP, "doc_text.js").replace(/\\/g, "/"));
const { extractDocText, docKindFromExt, extractOleText, oleKindFromExt } = mod;

const SAMPLES = [
  { f: "C:/Users/MR/Downloads/第2章.pptx", want: "传感器" },
  { f: "C:/Users/MR/Downloads/20244222026-张裴文-《互联网思维》.docx", want: "互联网思维" },
  { f: "C:/Users/MR/Downloads/_a1136-test.xlsx", want: "传感器A" },
  { f: "C:/Users/MR/Downloads/jeny_第一章.ppt", want: "" },
  { f: "C:/Users/MR/Downloads/专题3总结_20244222026张裴文.doc", want: "" },
];

let allPass = true;
for (const { f, want } of SAMPLES) {
  const ext = "." + f.split(".").pop().toLowerCase();
  const oleKind = oleKindFromExt(ext);
  const kind = docKindFromExt(ext);
  let text = "";
  let err = "";
  try {
    const buf = await readFile(f);
    if (oleKind) {
      const r = extractOleText(buf, oleKind);
      text = typeof r === "string" ? r : (r?.text ?? JSON.stringify(r));
    } else if (kind) {
      const r = extractDocText(buf, kind);
      text = typeof r === "string" ? r : (r?.text ?? JSON.stringify(r));
    } else {
      err = "无对应解析器";
    }
  } catch (e) { err = String(e?.message ?? e); }

  const chars = text.length;
  const hasWant = want ? text.includes(want) : true;
  const pass = !err && chars > 50 && hasWant;
  console.log(`[Agent读] ${f.split(/[\\/]/).pop()}`);
  console.log(`    kind=${kind ?? oleKind ?? "?"} 字符=${chars} 含"${want}"=${hasWant} ${err ? "ERR:" + err : ""}`);
  console.log(`    首 120 字: ${JSON.stringify(text.slice(0, 120))}`);
  console.log(`    ${pass ? "✓ 通过" : "✗ 未通过"}`);
  if (!pass) allPass = false;
}
console.log("\n" + (allPass ? "Agent 侧全部可读 ✓" : "有文件 Agent 读不了 ✗"));
process.exit(allPass ? 0 : 1);
