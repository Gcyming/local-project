#!/usr/bin/env node
/**
 * gui/scripts/mut-a1057.mjs — A-1057 权限体系守卫的变异验证。
 *
 * 这一轮的守卫里有相当一部分是**源码形态断言**（"判据没被搬回装配层"、"闸门还传 args"），
 * 它们永远不会让类型检查失败 —— 而这类断言的典型失效是"锁错对象"：
 * 文件里还留着那行字符串，行为早变了。所以每条变异都必须让守卫变红。
 *
 * 覆盖（每条变异都对应一个用户真的会读到的后果）：
 *  ① 类别归属（grant.ts）：前缀管辖、风险最高类、空集合回落
 *  ② 开关放行（grant.ts）：六个开关各自映射 + network 恒放行
 *  ③ 硬规则（hard_rules.ts）：只读短路、终端黑名单、敏感文件、受保护目录、内网地址
 *  ④ 闸门决策（policy.ts）：类别否决 → 硬规则 → 放行，顺序与 kind 都不能错
 *  ⑤ 审批分类（policy.ts）：硬规则优先于开关放行、开关放行、只读不降级、终端命令分级
 *  ⑥ 接线（registry.ts / index.ts）：args 必须传下去、判据不许内联回装配层
 *  ⑦ 目标取值口径（tool_loop.ts）：终端类 command 字段不许再丢
 *  ⑧ 全局默认下发（index.ts）：无 override 的 Agent 也要吃到全局审批档位
 *
 * ⚠️ 纪律（同 mut-a1054 / mut-a1055 / mut-a1056）：
 *   - 快照 / 还原一律走**字节**（Buffer），不做文本往返；
 *   - 每条变异都要求"文本确实变了"，否则是**未命中** —— 那种情况下"守卫仍绿"毫无意义；
 *   - `sub` 来自共享模块 `./_mut-eol.mjs`（行尾无关），**不要在本脚本另写一份**；
 *   - 全程结束做字节级还原复核。
 *
 * 用法：node gui/scripts/mut-a1057.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = [
  "tests/core-ts/a1057-permissions.spec.ts",
  "tests/core-ts/network-gate.spec.ts",
  "tests/core-ts/screen.spec.ts",
];

const GRANT = "core-ts/src/tools/grant.ts";
const HARD = "core-ts/src/tools/hard_rules.ts";
const POLICY = "core-ts/src/tools/policy.ts";
const REGISTRY = "core-ts/src/tools/registry.ts";
const LOOP = "core-ts/src/tool_loop.ts";
const MAIN = "gui/src/main/index.ts";
const FILES = [GRANT, HARD, POLICY, REGISTRY, LOOP, MAIN];

const MUTATIONS = [
  /* ── ① 类别归属（grant.ts） ─────────────────────────────────────── */
  {
    name: "A-1057① screen_ 前缀不再管辖（图形动作被当成普通 write 放行）",
    file: GRANT,
    mutate: (t) => sub(t, 'if (n.startsWith("screen_")) { return "screen"; }', "if (false) { return \"screen\"; }"),
  },
  {
    name: "A-1057① mcp_ 前缀被指向 skill（MCP 开关失效、被技能开关顶替）",
    file: GRANT,
    mutate: (t) => sub(t, 'if (n.startsWith("mcp_")) { return "mcp"; }', 'if (n.startsWith("mcp_")) { return "skill"; }'),
  },
  {
    name: "A-1057① 风险顺序被改（network+write 工具被归到 write）",
    file: GRANT,
    mutate: (t) => sub(t,
      'const order = ["read", "write", "terminal", "network"] as const;',
      'const order = ["read", "network", "terminal", "write"] as const;'),
  },
  {
    name: "A-1057① 空 permissions 不再回落 read（被归入更危险的一类）",
    file: GRANT,
    mutate: (t) => sub(t, 'let best: GrantCategory = "read";', 'let best: GrantCategory = "write";'),
  },

  /* ── ② 开关放行（grant.ts） ─────────────────────────────────────── */
  {
    name: "A-1057② 终端开关指向「写」（开终端其实开的是写；用户看到的按钮名不副实）",
    file: GRANT,
    mutate: (t) => sub(t, 'case "terminal": return sw.toolTerminal;', 'case "terminal": return sw.toolWrite;'),
  },
  {
    name: "A-1057② 图形开关蹭「读」兜底（关掉图形控制也会被读放行）",
    file: GRANT,
    mutate: (t) => sub(t, 'case "screen": return sw.screenEnabled;', 'case "screen": return sw.screenEnabled || sw.toolRead;'),
  },
  {
    name: "A-1057② network 改成不放行（adb_connect / http_serve 被拉回逐次弹窗）",
    file: GRANT,
    mutate: (t) => sub(t, 'case "network": return true;', 'case "network": return false;'),
  },

  /* ── ③ 硬规则（hard_rules.ts） ─────────────────────────────────── */
  {
    name: "A-1057③ 只读短路被去掉（只读动作也被内容级硬规则拦）",
    file: HARD,
    mutate: (t) => sub(t, 'if (kind === "read") { return { ...OK, reason: "只读动作不受硬规则限制", matched: "read" }; }',
      'if (kind === "write") { return { ...OK, reason: "只读动作不受硬规则限制", matched: "read" }; }'),
  },
  {
    name: "A-1057③ 终端黑名单恒不生效（rm -rf / 放行）",
    file: HARD,
    mutate: (t) => sub(t,
      "    return r.level === \"block\"\n      ? { blocked: true, reason: r.reason, matched: r.matched }",
      "    return r.level === \"block\"\n      ? { blocked: false, reason: r.reason, matched: r.matched }"),
  },
  {
    name: "A-1057③ 受保护源码目录判定被摘掉（Agent 可改自己的护栏）",
    file: HARD,
    mutate: (t) => sub(t, "isProtectedSourcePath(target, input.projectRoot ?? PROJECT_ROOT)", "false"),
  },
  {
    name: "A-1057③ 写入判定目标被换成空串（越权路径 / 敏感文件全部漏过）",
    file: HARD,
    mutate: (t) => sub(t, 'const r = assessAction({ kind: "write", path: target });', 'const r = assessAction({ kind: "write", path: "" });'),
  },
  {
    name: "A-1057③ 网络判定目标被换成安全地址（内网/元数据地址放行）",
    file: HARD,
    mutate: (t) => sub(t, 'const r = assessAction({ kind: "network", url: target });',
      'const r = assessAction({ kind: "network", url: "https://safe.example.com/x" });'),
  },

  /* ── ④ 闸门决策（policy.ts） ───────────────────────────────────── */
  {
    name: "A-1057④ 闸门硬规则恒不触发（免审批档位顺手免掉安全边界）",
    file: POLICY,
    mutate: (t) => sub(t,
      "    name: n,\n    riskKind: input.riskKind,\n    target: input.target,\n    projectRoot: input.projectRoot,\n  });\n  if (hard.blocked) {",
      "    name: n,\n    riskKind: input.riskKind,\n    target: input.target,\n    projectRoot: input.projectRoot,\n  });\n  if (false && hard.blocked) {"),
  },
  {
    name: "A-1057④ 闸门改成「只取主导类别」（关掉「写」挡不住 network+write 工具）",
    file: POLICY,
    mutate: (t) => sub(t, 'if (!switches.toolWrite && has("write")) {', 'if (!switches.toolWrite && has("write") && !has("network")) {'),
  },
  {
    name: "A-1057④ 终端类别否决的 kind 写成 safety（把「去设置里开启」误导成「不可绕过的边界」）",
    file: POLICY,
    mutate: (t) => sub(t,
      'return { allowed: false, kind: "category", reason: "「终端」类别已关闭（ADB shell / 命令执行需开启此项）" };',
      'return { allowed: false, kind: "safety", reason: "「终端」类别已关闭（ADB shell / 命令执行需开启此项）" };'),
  },
  {
    name: "A-1057④ 图形开关关闭时不再拦（screen_* 被放行）",
    file: POLICY,
    mutate: (t) => sub(t, 'if (!switches.screenEnabled && n.startsWith("screen_")) {', 'if (false && n.startsWith("screen_")) {'),
  },
  {
    name: "A-1057④ MCP 类别否决被摘掉（MCP 开关失效：关掉也照样放行 mcp_ 工具）",
    file: POLICY,
    mutate: (t) => sub(t, 'if (!switches.mcpEnabled && n.startsWith("mcp_")) {', "if (false) {"),
  },
  {
    name: "A-1057④ 技能类别否决被摘掉（技能开关失效：关掉也照样放行 skill_ 工具）",
    file: POLICY,
    mutate: (t) => sub(t, 'if (!switches.skillsEnabled && n.startsWith("skill_")) {', "if (false) {"),
  },

  /* ── ⑤ 审批分类（policy.ts） ───────────────────────────────────── */
  {
    name: "A-1057⑤ 审批硬规则恒不触发（开关放行后 rm -rf / 也直接执行）",
    file: POLICY,
    mutate: (t) => sub(t,
      '  if (hard.blocked) {\n    return { level: "block", reason: hard.reason, matched: hard.matched };\n  }',
      '  if (false) {\n    return { level: "block", reason: hard.reason, matched: hard.matched };\n  }'),
  },
  {
    name: "A-1057⑤ 开关放行判据恒不触发（开关打开也不放行 = 用户看到的「改了设置没反应」）",
    file: POLICY,
    mutate: (t) => sub(t, "  if (isGrantedTool(input.switches, tool)) {", "  if (false) {"),
  },
  {
    name: "A-1057⑤ 只读也被拉进 policy-confirm 降级（纯检索每次都要问）",
    file: POLICY,
    mutate: (t) => sub(t,
      "if (kind !== \"read\" && r.level === \"auto\" && !input.autoApprovable) {",
      "if (r.level === \"auto\" && !input.autoApprovable) {"),
  },
  {
    name: "A-1057⑤ 终端分级拿不到命令本体（永远只是「未知命令 → 需确认」）",
    file: POLICY,
    mutate: (t) => sub(t, "const { command, commandArgs } = splitCommand(input.target);", 'const { command, commandArgs } = splitCommand("");'),
  },

  /* ── ⑥ 接线（registry.ts / index.ts） ──────────────────────────── */
  {
    name: "A-1057⑥ 闸门调用不再传 args（内容级硬规则拿不到目标）",
    file: REGISTRY,
    mutate: (t) => sub(t, "toolCategoryGate(tool, args)", "toolCategoryGate(tool, {})"),
  },
  {
    name: "A-1057⑥ 安全拦截文案分流被改成类别文案（把「不可绕过」说成「去设置里开」）",
    file: REGISTRY,
    mutate: (t) => sub(t, 'gate.kind === "safety"', 'gate.kind === "category"'),
  },
  {
    name: "A-1057⑥ 闸门不再传目标（硬规则永远收不到东西）",
    file: MAIN,
    mutate: (t) => sub(t, "    target: targetFromArgs(args),", '    target: "",'),
  },
  {
    name: "A-1057⑥ 闸门不再实时读开关（改设置必须重启才生效）",
    file: MAIN,
    mutate: (t) => sub(t, "    switches: permSwitches(getPermissions()),",
      "    switches: { toolRead: true, toolWrite: true, toolTerminal: true, screenEnabled: true, mcpEnabled: true, skillsEnabled: true },"),
  },
  {
    name: "A-1057⑥ 闸门不再委托 policy（判据被搬回装配层）",
    file: MAIN,
    mutate: (t) => sub(t, "setToolCategoryGate((tool, args) => gateToolCall({", "setToolCategoryGate((tool, args) => gateToolCallInline({"),
  },
  {
    name: "A-1057⑥ 审批分类不再委托 policy（两处判据漂移的开端）",
    file: MAIN,
    mutate: (t) => sub(t, "    const r = classifyToolCall({", "    const r = classifyToolCallInline({"),
  },
  {
    name: "A-1057⑥ 判据内联回搬运（装配层重新直接依赖分类器）",
    file: MAIN,
    mutate: (t) => sub(t, "  const sw = permSwitches(getPermissions());\n  for (const a of actions) {",
      "  const sw = permSwitches(getPermissions());\n  void assessAction;\n  for (const a of actions) {"),
  },

  /* ── ⑦ 目标取值口径（tool_loop.ts） ────────────────────────────── */
  {
    name: "A-1057⑦ 沙箱目标回退旧口径（终端类 command 字段再次丢失）",
    file: LOOP,
    mutate: (t) => sub(t, "let target = targetFromArgs(args);",
      'let target = String(args.url ?? args.path ?? args.file ?? args.target ?? "");'),
  },

  /* ── ⑧ 全局默认下发（index.ts） ───────────────────────────────── */
  {
    name: "A-1057⑧ 全局审批档位回退硬编码 auto（设置里的「无需」对无 override 的会话无效）",
    file: MAIN,
    mutate: (t) => sub(t, 'const raw = (ov.approval as string) ?? getPermissions().globalApproval;', 'const raw = (ov.approval as string) ?? "auto";'),
  },
  {
    name: "A-1057⑧ 无 override 的 Agent 被跳过下发（回到旧 bug：吃 sandbox 内置默认、逐次询问）",
    file: MAIN,
    mutate: (t) => sub(t, "  for (const a of agentRegistry.loadedAgents) {\n    try {",
      "  for (const a of agentRegistry.loadedAgents) {\n    if (!a.sandbox_override) { continue; }\n    try {"),
  },
  {
    name: "A-1057⑧ 启动不再下发全局沙箱默认",
    file: MAIN,
    // 锚点必须贴紧 `// A-121:`（启动路径那一次的**唯一**邻位）——原先写成 `();\n\n  // A-121:`
    // 依赖一个空行，重构后空行消失 → 静默"未命中"。行尾无关由 `sub` 保证。
    mutate: (t) => sub(t, "applyGlobalSandboxDefaults();\n  // A-121:", "  // A-121:"),
  },
  {
    name: "A-1057⑧ 设置变更后不再下发（改完审批档位要重启才生效）",
    file: MAIN,
    mutate: (t) => sub(t, "      applyGlobalSandboxDefaults();\n    }\n    return { ok: true, permissions };",
      "    }\n    return { ok: true, permissions };"),
  },
];

function runGuards() {
  const r = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...GUARDS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const snapshot = () => {
  const m = new Map();
  for (const rel of FILES) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { m.set(p, readFileSync(p)); }
  }
  return m;
};
const restore = (snap) => { for (const [p, buf] of snap) { writeFileSync(p, buf); } };
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);
const treeHash = (snap) => [...snap.entries()].map(([p, b]) => `${p}:${sha(b)}`).join("|");

function main() {
  const snap = snapshot();
  const before = treeHash(snap);
  const missing = FILES.filter((f) => !snap.has(resolve(ROOT, f)));
  if (missing.length) {
    console.error(`[mut-a1057] 快照缺少文件：${missing.join("、")}`);
    process.exit(1);
  }
  const base = runGuards();
  if (!base.ok) {
    console.error("[mut-a1057] 基线守卫未通过\n" + base.out.slice(-3000));
    process.exit(1);
  }
  console.info(`[mut-a1057] 基线守卫通过（${FILES.length} 个源文件）\n`);

  /* 行尾自检（跑变异之前）。先验**检测器自己**不空转 —— 见 `_mut-eol.mjs`
     `selfTestEolDetector`：恒真的自检比没有自检更危险。 */
  const probe = selfTestEolDetector(ROOT);
  if (probe.length) {
    console.error("[mut-a1057] 行尾检测器自检失败（检测能力本身坏了）：");
    for (const b of probe) { console.error(`  - ${b}`); }
    process.exit(1);
  }
  if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1057")) { process.exit(1); }
  console.info("[mut-a1057] 行尾检测器自检 + 锚点自检均通过\n");

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const original = readFileSync(path, "utf8");   // 每轮从**磁盘现值**出发（上轮已字节还原）
    const next = m.mutate(original);
    if (next === original) {
      console.error(`[mut-a1057] ${m.name}\n  ✗ 变异未命中（文本没变）—— 守卫"仍绿"不能说明任何事`);
      survivors.push(`${m.name}（未命中）`);
      continue;
    }
    writeFileSync(path, next, "utf8");
    if (runGuards().ok) {
      console.error(`[mut-a1057] ${m.name}\n  ✗ 守卫仍绿 —— 没锁住`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1057] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }
  restore(snap);

  const restored = treeHash(snapshot()) === before;
  console.info("");
  if (survivors.length) {
    console.error(`[mut-a1057] ${survivors.length}/${MUTATIONS.length} 条未被捕获：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  if (!restored) {
    console.error("[mut-a1057] 还原失败 ✗（源文件指纹与快照不一致）");
    process.exit(1);
  }
  console.info(`[mut-a1057] 全部 ${MUTATIONS.length} 条变异均让守卫变红（${red} 红），源文件字节级已还原 ✓`);
  process.exit(0);
}

main();
