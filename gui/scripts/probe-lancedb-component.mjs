#!/usr/bin/env node
/**
 * gui/scripts/probe-lancedb-component.mjs — A-1041「LanceDB 内嵌组件」**端到端**探针。
 *
 * 为什么需要它：`out/main` 里没有 `.node`、`prepare-lancedb-component.mjs` 能生成目录、
 * 源码里有 `requireLancedb`，这三条**每一条都绿**也证明不了第四件事——
 * 「把组件放进 `resources/components/lancedb` 后，运行时**真的能用它建表、写入、查回来**」。
 * 中间任何一环断掉（目录布局差一层 / PKG_ENTRY 路径写错 / 依赖闭包漏包 /
 * `process.resourcesPath` 在打包环境的取值与预期不同），界面上只表现为
 * 「向量记忆好像没效果」，而日志里可能连一句报错都没有（A-1041 前科：静默降级）。
 *
 * 所以这里**真的加载 293MB 的原生模块**并跑一次 mini 闭环：connect → 建表 → 写入 → 查询 → 读回。
 *
 * 用法（可指定组件根；不给就用默认探测）：
 *   node --experimental-strip-types gui/scripts/probe-lancedb-component.mjs [资源根]
 *   资源根下需有 `components/lancedb`（模拟打包后 `process.resourcesPath` 的布局）
 * 退出码 0 = 端到端闭环成立；1 = 有环节断掉（逐条打印）。
 *
 * ⚠️ 本探针**故意**不放进 `tests/**`（那会让每次 `vitest run` 都加载 293MB）。
 * 它是"打包前核验"用的手动探针，与 `probe-sessions-boot.cjs` 同类。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUB = join(ROOT, "gui", "src", "main", "__stubs", "lancedb-stub.ts");

const resRoot = process.argv[2] || resolve(ROOT, "..", "slime-fake-res");

// ── 子进程里跑（要先把 process.resourcesPath 设成"打包后的资源根"，再 import 桩） ──
const child = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `
    process.resourcesPath = ${JSON.stringify(resRoot)};
    const mod = await import(${JSON.stringify(pathToFileURL(STUB).href)});
    const out = { resRoot: process.resourcesPath };
    out.candidates = mod.lancedbCandidates();
    out.status = mod.lancedbComponentStatus();
    if (!out.status.ok) { console.log(JSON.stringify(out)); process.exit(3); }
    const real = mod.requireLancedb();
    out.exports = Object.keys(real).length > 0;
    const uri = ${JSON.stringify(resRoot)} + "/probe-lance";
    const db = await real.connect(uri);
    out.connected = !!db;
    const rows = [{ id: "a", content: "用户喜欢批处理脚本", vector: new Array(1024).fill(0.125) }];
    let table;
    try { table = await db.openTable("probe_table"); } catch { table = await db.createTable("probe_table", rows); }
    out.rowsAfter = await table.countRows();
    if (out.rowsAfter === 0) { await table.add(rows); out.rowsAfter = await table.countRows(); }
    const got = await table.query().limit(1).toArray();
    out.readBack = got.length ? String(got[0].content) : "";
    out.vectorDim = got.length ? Array.from(got[0].vector).length : 0;
    console.log(JSON.stringify(out));
    `,
  ],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
);

const fail = [];
const pass = [];
const check = (ok, label, detail) => (ok ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ""}`);

check(existsSync(STUB), "桩文件存在", STUB);

const raw = `${child.stdout ?? ""}`.trim();
const last = raw.split("\n").filter(Boolean).pop() ?? "";
let out = null;
try { out = JSON.parse(last); } catch { /* 下面按"没跑起来"处理 */ }

if (child.status !== 0 || out === null) {
  console.error(`[probe-lancedb] 探针子进程失败（exit=${child.status}）`);
  console.error((child.stderr ?? child.stdout ?? "").slice(-3000));
  process.exit(1);
}

check(!!out.status?.ok, "① 组件被识别为已就位（resources/components/lancedb）", out.status?.dir ?? out.status?.error);
if (!out.status?.ok) {
  console.error("[probe-lancedb] 候选目录：" + (out.candidates ?? []).join(" | "));
}
check(out.exports === true, "② requireLancedb 拿到真实模块（不是空壳）");
check(out.connected === true, "③ connect 成功（原生绑定真的加载了，293MB 没白付）");
check(out.rowsAfter > 0, "④ 建表 + 写入成功（行数 > 0）", `rows=${out.rowsAfter}`);
check(out.readBack.includes("批处理"), "⑤ 查询读回内容一致（写入的不是占位空表）", out.readBack);
check(out.vectorDim === 1024, "⑥ 向量维度正确（1024 —— 读错列名会得到 0）", `dim=${out.vectorDim}`);

for (const p of pass) { console.log("OK   " + p); }
for (const f of fail) { console.log("FAIL " + f); }
if (fail.length === 0) {
  console.log(`\nA-1041 内嵌组件端到端闭环成立（${pass.length} 项）。资源根：${resRoot}`);
  process.exit(0);
}
console.log(`\nA-1041 内嵌组件端到端失败 ${fail.length} 项（通过 ${pass.length} 项）`);
process.exit(1);
