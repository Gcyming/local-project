/*
 * 变异测试：计划 S1（能力问询替换推断）守卫的**取证**。
 *
 * 每条变异都打在"改回去不报错、跑起来也不崩、只是界面悄悄显示错数字"的那个根因上，
 * 且都必须让 `tests/core-ts/a1022-guards.spec.ts` 变红。跑完自动还原并校验哈希。
 *
 * ⚠️ 为什么必须有这一步（项目铁律）：守卫写完只是**声明**了意图，变异测试才证明它**真的**在拦。
 *    A-1019 的实锤：`.app \{` 正则命中了文件开头的 `body, #root, .app {` 块；
 *    `src.indexOf(ln)` 定位到同名行的**第一处** —— 两条守卫都是"绿着但锁错对象"。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/pilot project";
const INDEX = path.join(ROOT, "gui", "src", "main", "index.ts");
const PROBE = path.join(ROOT, "gui", "src", "main", "localServerProbe.ts");
const INTROSPECT = path.join(ROOT, "core-ts", "src", "model_introspect.ts");
const PROVIDERS = path.join(ROOT, "gui", "src", "main", "providers.ts");
const SPEC = path.join(ROOT, "tests", "core-ts", "model-introspect.spec.ts");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "llama");

const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");

/* 三个 S1 守卫一起跑：一条变异只要让**任一**守卫变红即算验红。
   行为断言（provider 匹配、loopback 判定、缓存、绝不抛）在 local-server-probe.spec.ts，
   结构断言在 a1022-guards.spec.ts，解析断言在 model-introspect.spec.ts —— 三者互补，
   少了任何一份都会留下"改坏了没人管"的角落。 */
const GUARDS = [
  "tests/core-ts/a1022-guards.spec.ts",
  "tests/core-ts/model-introspect.spec.ts",
  "tests/core-ts/local-server-probe.spec.ts",
];

const variants = [
  /* ── ① 决策唯一 / 顺序 ───────────────────────────────── */
  {
    name: "① 家族能力表回填进上限决策（A-1018 ③ 的原病灶：训练窗口 524K 当可用余量）",
    file: INDEX,
    from: "    return resolveWindowCap({ serverCtx, plannedCtx, providerSpecCtx: providerCtx }).ctx;",
    to: "    if (serverCtx === undefined) { return inferModelCapabilities(modelId)?.context_window; }\n"
      + "    return resolveWindowCap({ serverCtx, plannedCtx, providerSpecCtx: providerCtx }).ctx;",
  },
  {
    name: "② 丢掉唯一决策函数，就地手写优先级（两条口径开始各自漂移）",
    file: INDEX,
    from: "    return resolveWindowCap({ serverCtx, plannedCtx, providerSpecCtx: providerCtx }).ctx;",
    to: "    return (serverCtx ?? plannedCtx ?? providerCtx) as number | undefined;",
  },
  {
    name: "③ 在问服务器之前提前 return 模型条目的 ctx_len（原级联病灶：配置压过事实）",
    file: INDEX,
    from: "    /* ②a slime 托管的本地模型 —— 问服务器，并确认它服务的就是这个模型 */",
    to: "    if (localSpec?.ctx_len && localSpec.ctx_len > 0) { return localSpec.ctx_len; }\n"
      + "    /* ②a slime 托管的本地模型 —— 问服务器，并确认它服务的就是这个模型 */",
  },
  {
    name: "④ 同域兜底的取值顺序反过来（chat.ctx_len 压过模型条目 ctx_len）",
    file: INDEX,
    from: "      plannedCtx = localSpec?.ctx_len && localSpec.ctx_len > 0\n"
      + "        ? localSpec.ctx_len\n"
      + "        : (chatCfgCtx > 0 ? chatCfgCtx : undefined);",
    to: "      plannedCtx = chatCfgCtx > 0 ? chatCfgCtx : (localSpec?.ctx_len && localSpec.ctx_len > 0 ? localSpec.ctx_len : undefined);",
  },
  {
    name: "⑤ 第二个 `[model_server.chat].ctx_len` 读取点（数量守恒被破：两条可以各自漂移的口径）",
    file: PROVIDERS,
    from: "export function listLocalModels(): LocalModelSpec[] {",
    to: "function rogueCtxRead(): number { return Number((readModelServerConfig()?.chat as { ctx_len?: number } | undefined)?.ctx_len ?? 0); }\n"
      + "export function listLocalModels(): LocalModelSpec[] {",
  },

  /* ── ② 先问服务器 ─────────────────────────────────────── */
  {
    name: "⑥ 去掉本机判定（对远端网关盲发 /props，拖慢每一轮 done 载荷）",
    file: INDEX,
    from: "        if (!isLoopbackBaseUrl(base)) { continue; }",
    to: "        if (!base) { continue; }",
  },
  {
    name: "⑦ 两个探测的 catch 去掉（探测失败会把 done 事件构造打断 → 整轮对话没有 done）",
    file: INDEX,
    from: "      const cap = await probeManagedChatCapability({ path: localSpec?.path, ids: candidates }).catch(() => null);",
    to: "      const cap = await probeManagedChatCapability({ path: localSpec?.path, ids: candidates });",
  },

  /* ── ③ 身份校验 ───────────────────────────────────────── */
  {
    name: "⑧ 托管分支去掉身份校验（拿 A 模型的窗口回答 B 模型 = 同一个 bug 换位置）",
    file: INDEX,
    from: "      if (cap?.effectiveCtx != null && capabilityMatchesModel(cap, { path: localSpec?.path, ids: candidates })) {",
    to: "      if (cap?.effectiveCtx != null) {",
  },
  {
    name: "⑨ 路径归一失效（Windows 两种写法被判成两个文件 → 永远认不出正在服务的模型）",
    file: PROBE,
    from: 'return (p ?? "").trim().replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/").toLowerCase();',
    to: 'return (p ?? "").trim();',
  },
  {
    name: "⑩ 问不出身份时默认放行（宁可要一个可能是别的模型的数字）",
    file: PROBE,
    from: "  /* 问不出身份 → **不认**。宁可回落同域兜底，也不要一个可能是别的模型的数字。 */\n  return false;",
    to: "  return true;",
  },
  {
    name: "⑪ 去掉跨进程 registry 兜底（开发模式下内存没有实例记录 → 服务在跑却问不到窗口）",
    file: PROBE,
    from: "    const reg = ModelServerManager.readRegistry();",
    to: "    const reg = {} as Record<string, { port?: unknown; state?: unknown }>;",
  },

  /* ── ④ 分层 ───────────────────────────────────────────── */
  {
    name: "⑫ 纯逻辑层引入 IO（core-ts 的纯函数模块开始依赖文件系统）",
    file: INTROSPECT,
    from: "export type LocalServerState =",
    to: 'import { readFileSync } from "node:fs";\nexport type LocalServerState =',
  },

  /* ── ⑤ 夹具 ───────────────────────────────────────────── */
  {
    name: "⑬ spec 不再引用真实夹具，改成内联假对象（夹具腐烂后没人发现）",
    file: SPEC,
    from: 'const PROPS_READY = fixture("props.ready");',
    to: 'const PROPS_READY = { body: { default_generation_settings: { n_ctx: 8192 } }, status: 200 };',
  },
];

const before = { index: sha(INDEX), probe: sha(PROBE), introspect: sha(INTROSPECT), providers: sha(PROVIDERS), spec: sha(SPEC) };
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

const after = { index: sha(INDEX), probe: sha(PROBE), introspect: sha(INTROSPECT), providers: sha(PROVIDERS), spec: sha(SPEC) };
const restored = Object.keys(before).every((k) => before[k] === after[k]);

console.log("\n================ S1（A-1022）变异测试结果 ================");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.red ? "✓ 验红" : "✗ 未红（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ 五文件哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`全部验红: ${results.every((r) => r.red) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.red) && restored ? 0 : 1);
