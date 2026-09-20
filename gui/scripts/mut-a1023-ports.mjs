/*
 * 变异测试：计划 S2「进程与端口所有权收口」守卫的**取证**。
 *
 * 每条变异都打在"改回去不报错、跑起来也不崩、只是悄悄走错端口/走错进程"的那个根因上，
 * 且都必须让 `tests/core-ts/a1023-guards.spec.ts` 变红。跑完自动还原并校验哈希。
 *
 * ⚠️ 为什么必须有这一步（项目铁律）：守卫写完只是**声明**了意图，变异测试才证明它**真的**在拦。
 *    A-1022 的实锤：把 props URL 变异成 `/xprops`、重建后产物断言竟然 **ALL PASSED** ——
 *    main 产物不压缩、注释全留，`/props` 在注释里出现 10 次，断言命中的是注释。
 *    A-1023 的同类风险：`fnBody` 若直接取 `indexOf("{")`，会拿到**返回类型**里的花括号切出空壳。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/pilot project";
const INDEX = path.join(ROOT, "gui", "src", "main", "index.ts");
const MODEL_SERVER = path.join(ROOT, "core-ts", "src", "model_server.ts");

const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");

const GUARDS = ["tests/core-ts/a1023-guards.spec.ts"];

/** 每条变异都必须让守卫变红；`from` 必须在文件里唯一命中。 */
const variants = [
  /* ── ① 端口字面量 ───────────────────────────────────── */
  {
    name: "① GUI 层把嵌入端点改回硬编码 8999（跨层绕过 basePortFor，用户改端口后嵌入永远失败）",
    file: INDEX,
    from: "const resp = await fetch(`${embeddingBaseUrl()}/v1/embeddings`, {",
    to: 'const resp = await fetch("http://127.0.0.1:8999/v1/embeddings", {',
  },
  {
    name: "② probeLive 里第二次独立推导嵌入端口（与 basePortFor 成为两份会漂移的口径）",
    file: MODEL_SERVER,
    from: '      const port = basePortFor("embedding", cfg, this.chatCfg);',
    to: "      const port = (cfg.port as number) ?? 8999;",
  },
  {
    name: "③ status() 里第三次独立推导嵌入端口（状态面板显示一个端口、服务开在另一个）",
    file: MODEL_SERVER,
    from: '        port: basePortFor("embedding", this.embedCfg, this.chatCfg),',
    to: "        port: (this.embedCfg.port as number) ?? 8999,",
  },
  {
    name: "④ probeLive 的 chat 分支回退到独立推导 18082（探测端口与启动端口可能不一致）",
    file: MODEL_SERVER,
    from: "    const portStart = basePortFor(role, cfg, this.chatCfg);",
    to: "    const portStart = (cfg.port_start as number) ?? 18082;",
  },
  {
    name: "⑤ embeddingBaseUrl 不再问管理器自述端口（丢掉「已就绪就用真实端口」这一路）",
    file: INDEX,
    from: '  const live = getModelServer()?.getPort("embedding");',
    to: "  const live = 0;",
  },
  {
    name: "⑥ 删掉 status() 对 basePortFor 的调用（调用点数量守恒被破）",
    file: MODEL_SERVER,
    from: '        port: basePortFor("embedding", this.embedCfg, this.chatCfg),',
    to: "        port: Number(this.embedCfg.port ?? this.chatCfg.port_start ?? 0),",
  },

  /* ── ② 进程所有权 ───────────────────────────────────── */
  {
    name: "⑦ GUI 主进程自己 spawn llama-server（出现第二个起点，启动/回收开始分叉）",
    file: INDEX,
    from: "// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────",
    to: 'function __rogueSpawn(): void { spawn("llama-server.exe", ["-c", "8192"]); }\n'
      + "// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────",
  },
  {
    name: "⑧ GUI 主进程自己 taskkill（进程树回收跑到运行时外面）",
    file: INDEX,
    from: "// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────",
    to: 'function __rogueKill(pid: number): void { execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)]); }\n'
      + "// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────",
  },

  /* ── ③ PID ──────────────────────────────────────────── */
  {
    name: "⑨ GUI 主进程用 pidForPort 反查 PID（旁路运行时的私有状态）",
    file: INDEX,
    from: "// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────",
    to: "function __roguePidLookup(port: number): number | null { return pidForPort(port); }\n"
      + "// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────",
  },
  {
    name: "⑩ PID 字段不再是私有（外部可以随意改写进程身份）",
    file: MODEL_SERVER,
    from: "  private pidVal: number | null = null;",
    to: "  pidVal: number | null = null;",
  },

  /* ── ④ 注册表 ───────────────────────────────────────── */
  {
    name: "⑪ GUI 主进程直接读注册表文件（绕过 readRegistry，又多一个 JSON 解析口径）",
    file: INDEX,
    from: "// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────",
    to: 'function __rogueRegistry(): string { return readFileSync(join(PROJECT_ROOT, "data", "model_servers.json"), "utf8"); }\n'
      + "// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────",
  },
  {
    name: "⑫ 注册表路径被解析两次（两份路径可以各自漂移）",
    file: MODEL_SERVER,
    from: 'const DEFAULT_REGISTRY_PATH = resolve(PROJECT_ROOT, "data", "model_servers.json");',
    to: 'const DEFAULT_REGISTRY_PATH = resolve(PROJECT_ROOT, "data", "model_servers.json");\n'
      + 'const LEGACY_REGISTRY_PATH = resolve(PROJECT_ROOT, "data", "model_servers.json");',
  },
  {
    name: "⑬ GUI 侧不再走静态 readRegistry（自己找注册表）",
    file: path.join(ROOT, "gui", "src", "main", "localServerProbe.ts"),
    from: "    const reg = ModelServerManager.readRegistry();",
    to: '    const reg = JSON.parse(readFileSync("data/model_servers.json", "utf8")) as Record<string, Record<string, unknown>>;',
  },
];

const files = [INDEX, MODEL_SERVER, path.join(ROOT, "gui", "src", "main", "localServerProbe.ts")];
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
const results = [];

function runGuards() {
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...GUARDS],
      { cwd: ROOT, timeout: 300000, encoding: "utf8" },
    );
    return { code: 0, text: out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, text: `${e.stdout || ""}\n${e.stderr || ""}` };
  }
}

for (const v of variants) {
  const orig = fs.readFileSync(v.file, "utf8");
  if (!orig.includes(v.from)) { results.push({ name: v.name, error: "变异锚点未命中（脚本失效）" }); continue; }
  fs.writeFileSync(v.file, orig.replace(v.from, v.to), "utf8");

  const r = runGuards();
  const reason = (r.text.split("\n").find((l) => l.includes("AssertionError")) || "").trim().slice(0, 170);
  results.push({ name: v.name, code: r.code, reason, red: r.code !== 0 });

  fs.writeFileSync(v.file, orig, "utf8");
}

const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const restored = files.every((f) => before[f] === after[f]);

console.log("\n================ S2（A-1023）变异测试结果 ================");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.red ? "✓ 验红" : "✗ 未红（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ 三文件哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`全部验红: ${results.every((r) => r.red) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.red) && restored ? 0 : 1);
