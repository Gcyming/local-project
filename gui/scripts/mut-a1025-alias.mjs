/*
 * 变异测试：计划 S4（A-1025）「本地模型子系统：身份 / 状态 / 空闲回收」守卫的**取证**。
 *
 * 覆盖三段：
 *   S4-A 身份   —— `--alias` 具名寻址（身份不依赖路径）
 *   S4-B 状态   —— 「加载中」是一等状态（绝不重复拉起同一个模型）
 *   S4-C 回收   —— 空闲 TTL 先问服务器「你忙不忙」
 *
 * 每条变异都打在"改回去不报错、跑起来也不崩、只是行为悄悄退化成旧行为"的那个根因上，
 * 且都必须让 `tests/core-ts/a1025-guards.spec.ts` 变红。跑完自动还原并校验哈希。
 *
 * ⚠️ 为什么必须有这一步（项目铁律）：守卫写完只是**声明**了意图，变异测试才证明它**真的**在拦。
 *    A-1022 实锤：断言串在注释里也出现 → 改坏代码守卫依然全绿。
 *    A-1023 实锤：计数式断言把**函数定义**算成调用点 → 删掉真实调用点仍达标。
 *    本脚本因此专门覆盖三类"守卫也可能瞎"的情形：
 *      ⑨  只删掉 `sameModel` 的**别名分支**（计数式守卫看不出来，只有行为断言能抓）；
 *      ⑪  在 argv 处**又复制一份**逗号清洗（"第二产地"复活型变异）；
 *      ⑯  放宽认领闸门（只有"状态抖动"那条行为断言能抓到，纯结构断言抓不到）；
 *      ㉒  常驻实例静默跳过（验证 `stripComments` 真的把注释里的同名串剥掉了 —— 否则假绿）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/pilot project";
const MODEL_SERVER = path.join(ROOT, "core-ts", "src", "model_server.ts");
const GUI_INDEX = path.join(ROOT, "gui", "src", "main", "index.ts");
const GUI_PROBE = path.join(ROOT, "gui", "src", "main", "localServerProbe.ts");

const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");
const GUARDS = ["tests/core-ts/a1025-guards.spec.ts", "tests/core-ts/gguf-meta.spec.ts"];

const variants = [
  {
    name: "① 别名不做逗号清洗（逗号是 --alias 的列表分隔符 → id 被拆成两个，身份变部分匹配）",
    file: MODEL_SERVER,
    from: 'const cleaned = s.replace(/,/g, "_").trim();',
    to: "const cleaned = String(raw ?? \"\").trim();",
  },
  {
    name: "② 清洗改成一个「看着也行」的替换字符（纯函数断言必须抓到）",
    file: MODEL_SERVER,
    from: 'const cleaned = s.replace(/,/g, "_").trim();',
    to: 'const cleaned = s.replace(/,/g, "-").trim();',
  },
  {
    name: "③ 空别名也下发 `-a \"\"`（「没有别名」出现两种表达，下游判同分叉）",
    file: MODEL_SERVER,
    from: "  if (alias) {\n    argv.push(\"-a\", alias);\n  }",
    to: "  if (alias !== undefined) {\n    argv.push(\"-a\", alias);\n  }",
  },
  {
    name: "④ 下发**原始**别名（清洗被绕过 → 逗号直接进 argv）",
    file: MODEL_SERVER,
    from: "  const alias = sanitizeAlias(args.alias);",
    to: "  const alias = String(args.alias ?? \"\").trim();",
  },
  {
    name: "⑤ 实例不记录别名（→ 复用判同无从做别名优先，静默退回路径比较）",
    file: MODEL_SERVER,
    from: "        alias: target().alias || undefined,\n",
    to: "",
  },
  {
    name: "⑥ 别名记录了但没传给 backend.start（llama-server 自述的仍是路径 → 身份是假的）",
    file: MODEL_SERVER,
    from: ", kvTypeV: role === \"chat\" ? this.chatKvType?.v : undefined, alias: inst.alias }",
    to: ", kvTypeV: role === \"chat\" ? this.chatKvType?.v : undefined }",
  },
  {
    name: "⑦ 复用判同退回裸路径比较（A-1017 的「每轮弹加载面板」复现路径）",
    file: MODEL_SERVER,
    from:
      "      if (!this.sameModel(inst, { path: matchModel, alias: sanitizeAlias(matchName) })) {\n" +
      "        return null;\n" +
      "      }",
    to:
      "      if (matchModel && inst.model_path && inst.model_path !== matchModel) {\n" +
      "        return null;\n" +
      "      }",
  },
  {
    name: "⑧ 切换检测退回裸路径比较（同文件换 id 不再重载 → 端口上跑的还是旧身份）",
    file: MODEL_SERVER,
    from: "      if (prev && !prev.external && !this.sameModel(prev, target())) {",
    to: "      if (prev && !prev.external && prev.model_path && prev.model_path !== modelPath) {",
  },
  {
    name: "⑨ ★ 只删掉 sameModel 的**别名分支**（计数式守卫看不出来，只有行为断言能抓）",
    file: MODEL_SERVER,
    from: "    if (inst.alias && target.alias) { return inst.alias === target.alias; }\n",
    to: "",
  },
  {
    name: "⑩ 外部采纳的实例被填上「我们想要的那个别名」（伪造自述身份 → 身份校验形同虚设）",
    file: MODEL_SERVER,
    from: "          alias: cap.alias ? sanitizeAlias(cap.alias) : undefined,",
    to: "          alias: target().alias || undefined,",
  },
  {
    name: "⑪ ★ 在 argv 处**又复制一份**逗号清洗（第二产地复活 —— 计数守卫必须抓）",
    file: MODEL_SERVER,
    from: "  const alias = sanitizeAlias(args.alias);",
    to: '  const alias = sanitizeAlias(args.alias).replace(/,/g, "_");',
  },
  {
    name: "⑫ 定义处改名（调用点仍用旧名 → 身份判据出现「定义/调用」两套名字，改一处就断）",
    file: MODEL_SERVER,
    from: "  private sameModel(inst: Instance, target: { path: string; alias: string }): boolean {",
    to: "  private isSameInst(inst: Instance, target: { path: string; alias: string }): boolean {",
  },

  // ── S4-B 状态：加载中是一等状态 ─────────────────────────
  {
    name: "⑬ ★ 探测到的 loading 不再被记为兜底候选（三态退化成两态：正在加载 ≡ 什么都没有 → 重复拉起）",
    file: MODEL_SERVER,
    from: '      if (cap.state === "loading" && !loading) {',
    to: '      if (cap.state === "loading" && !loading && false) {',
  },
  {
    name: "⑭ ★ 等待超时不再 return（把「还在加载」当成「可以重拉」→ 双份显存）",
    file: MODEL_SERVER,
    from: '        if (outcome === "timeout") {',
    to: '        if (outcome === "timeout" && false) {',
  },
  {
    name: "⑮ ★ 等待完成后复用**加载期**快照（身份读不到、状态还停在 loading → 认领到一个假就绪）",
    file: MODEL_SERVER,
    from: "        cap = await this.probeImpl(port);",
    to: "        cap = live.cap;",
  },
  {
    name: "⑯ ★ 放宽认领闸门（第三种状态也能往下走 → 静默 spawn 第二个同模型进程）",
    file: MODEL_SERVER,
    from: '      if (cap.state !== "ready" && cap.state !== "down") {',
    to: '      if (cap.state === "unloading") {',
  },
  {
    name: "⑰ ★ probeImpl 退回布尔（loading 与「什么都没有」压成同一个答案 —— A-1025 的根因）",
    file: MODEL_SERVER,
    from: "  private probeImpl: (port: number) => Promise<LocalServerCapability>;",
    to: "  private probeImpl: (port: number) => Promise<boolean>;",
  },
  {
    name: "⑱ ★ 本机端点拼接出现第二产地（在 model_server.ts 里自己拼 `/props`）",
    file: MODEL_SERVER,
    from: 'import { probeLocalProps } from "./local_server_io.js";',
    to: 'import { probeLocalProps } from "./local_server_io.js";\nconst __dupPropsUrl = (base) => `${stripApiSuffix(base)}/props`;',
  },

  // ── S4-C 回收：空闲到点先问服务器「忙不忙」 ─────────────
  {
    name: "⑲ ★ embedding 又被无条件跳过（用户设的 idle_unload_min 重新变成死开关）",
    file: MODEL_SERVER,
    from: "    if (idleMin <= 0) return;",
    to: '    if (idleMin <= 0 || role === "embedding") return;',
  },
  {
    name: "⑳ ★ 「问不进去」被当成「不忙」（负载最高时卸载正在生成的模型）",
    file: MODEL_SERVER,
    from: '    } catch {\n      return "unknown";\n    }',
    to: '    } catch {\n      return "idle";\n    }',
  },
  {
    name: "㉑ ★ 忙闲探测忽略 is_processing（永远空闲 → 长生成被中途卸载）",
    file: MODEL_SERVER,
    from: '    return body.some((s) => (s as { is_processing?: unknown } | null)?.is_processing === true)\n      ? "busy"\n      : "idle";',
    to: '    return "idle";',
  },
  {
    name: "㉒ ★ 常驻实例静默跳过（不写理由 → 又变成「开关没生效也没人说」，同时验证 stripComments 生效）",
    file: MODEL_SERVER,
    from: '        console.log(`[model_server] ${role} 是常驻实例（persistent = true），idle_unload_min=${idleMin} 对它不生效`);',
    to: "        /* 变异：不写理由 */",
  },

  // ── S4-D 跨进程契约：能力缓存的作废点 ───────────────────
  {
    name: "㉓ ★ 状态迁移不再作废能力缓存（同端口换模型后按**旧模型**显示窗口 —— A-1018 ③）",
    file: GUI_INDEX,
    from: "        clearLocalCapabilityCache();\n        const w = mainWindow;",
    to: "        const w = mainWindow;",
  },
  {
    name: "㉔ ★ 作废点被挪到窗口判空**之后**（无窗口时这条路径提前 return → 缓存永不失效）",
    file: GUI_INDEX,
    from:
      "        clearLocalCapabilityCache();\n" +
      "        const w = mainWindow;\n" +
      "        if (!w || w.isDestroyed()) { return; }",
    to:
      "        const w = mainWindow;\n" +
      "        if (!w || w.isDestroyed()) { return; }\n" +
      "        clearLocalCapabilityCache();",
  },
  {
    name: "㉕ ★ 托管问询开始传 alias（缓存 key 从此能区分模型 → 「必须靠事件作废」的论证前提变了）",
    file: GUI_PROBE,
    from: "    const cap = await getLocalCapability(`http://127.0.0.1:${port}`);",
    to: "    const cap = await getLocalCapability(`http://127.0.0.1:${port}`, { alias: expect.ids?.[0] });",
  },
];

const files = [MODEL_SERVER, GUI_INDEX, GUI_PROBE];
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
const results = [];

/** 从 vitest 输出里取一条**有信息量**的失败原因。
 *  ⚠️ 别用 `includes("→")` 之类宽松匹配：测试名里就有箭头，会把 `stdout | …` 这种噪音当成原因
 *  （A-1025 首轮实测，12 条变异的"原因"全是同一行 stdout 头）。 */
function reasonOf(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const pick =
    lines.find((l) => l.includes("AssertionError")) ||
    lines.find((l) => l.startsWith("×")) ||
    lines.find((l) => l.includes("FAIL")) ||
    "";
  return pick.replace(/\s+/g, " ").slice(0, 175);
}
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
  const reason = reasonOf(r.text);
  results.push({ name: v.name, code: r.code, reason, red: r.code !== 0 });
  fs.writeFileSync(v.file, orig, "utf8");
}

const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const restored = files.every((f) => before[f] === after[f]);

console.log("\n================ S4（A-1025）变异测试结果 ================");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.red ? "✓ 验红" : "✗ 未红（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ 全部文件哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`全部验红: ${results.every((r) => r.red) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.red) && restored ? 0 : 1);
