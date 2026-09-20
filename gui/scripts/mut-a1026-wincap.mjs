/*
 * 变异测试：计划 S5「上下文窗口上限：家族能力表退出 + 跨进程契约」守卫的**取证**。
 *
 * 两条主线各有"改回去不报错、跑起来也不崩、只是行为悄悄退化"的写法，逐一验红：
 *   ① 家族表又给本地端点兜底窗口（A-1018 ③ 的喂入口）
 *   ② done 载荷漏掉 windowCap / 渲染层不消费（A-933 的回归路径）
 *
 * ⚠️ 为什么必须有这一步（项目铁律）：守卫写完只是**声明**了意图，变异测试才证明它**真的**在拦。
 *    本脚本专门覆盖三类"守卫也可能瞎"的情形：
 *      ③ 就地写一份 loopback 正则（功能看着一样，但共享判据被绕过 → 计费/窗口分裂）
 *      ⑥⑦ 只删**一条** done 路径的 windowCap（当时 A-933 正是漏了 stream 那条；
 *          只断言"存在 windowCap"的守卫会全绿）
 *      ⑨ 渲染层"读了但不用"（写了 setCtxCap 之外的分支 → 字段成了摆设）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/pilot project";
const PROVIDERS = path.join(ROOT, "gui", "src", "main", "providers.ts");
const GUI_INDEX = path.join(ROOT, "gui", "src", "main", "index.ts");
const CHAT_PANEL = path.join(ROOT, "gui", "src", "renderer", "pages", "ChatPanel.tsx");

/** done 载荷里那条 windowCap。两处缩进不同（stream 14 空格 / retry 12 空格）—— 用它区分路径。 */
const CAP_STREAM = "              windowCap: await resolveSessionWindowCap(agentId, session.model).catch(() => undefined),\n";
const CAP_RETRY = "            windowCap: await resolveSessionWindowCap(agentId, session.model).catch(() => undefined),\n";
const LOCAL_GUARD = "  if (isLocalEndpoint(input.baseUrl)) { return undefined; }\n";

const variants = [
  // ── ① 家族表退出（本地端点不得吃兜底）────────────────────
  {
    name: "① ★ 本地端点的闸门被删（家族表的 512K 训练窗口又流进 provider 配置 → A-1018 ③）",
    file: PROVIDERS,
    from: LOCAL_GUARD,
    to: "",
  },
  {
    name: "② ★ 本地判据退化成自己写的 loopback 正则（localhost/内网端点漏网 + 与计费口径分裂）",
    file: PROVIDERS,
    from: LOCAL_GUARD,
    to: '  if (/^https?:\\/\\/127\\.0\\.0\\.1/.test(input.baseUrl)) { return undefined; }\n',
  },
  {
    name: "③ ★ 上游自报被本地闸门压住（本地端点再也拿不到服务自报的窗口）",
    file: PROVIDERS,
    from: "  const up = input.upstreamCtx;\n  if (typeof up === \"number\" && up > 0) { return Math.floor(up); }\n" + LOCAL_GUARD,
    to: LOCAL_GUARD,
  },
  {
    name: "④ ★ 闸门挪到「保存值」之后（旧代码写坏的 512K 被永久继承 —— 错值自杀锁复活）",
    file: PROVIDERS,
    from:
      LOCAL_GUARD +
      "  const family = inferModelCapabilities(input.modelId).context;\n" +
      "  if (typeof family === \"number\" && family > 0) { return family; }\n" +
      "  const saved = input.savedCtx;\n" +
      "  if (typeof saved === \"number\" && saved > 0) { return saved; }\n",
    to:
      "  const family = inferModelCapabilities(input.modelId).context;\n" +
      "  if (typeof family === \"number\" && family > 0) { return family; }\n" +
      "  const saved = input.savedCtx;\n" +
      "  if (typeof saved === \"number\" && saved > 0) { return saved; }\n" +
      LOCAL_GUARD,
  },
  {
    name: "⑤ ★ 调用点就地复活并行链路（ctxFromFamily —— 窗口出现第二产地）",
    file: PROVIDERS,
    from: "    const ctxWindow = providerCtxWindow({",
    to: "    const ctxFromFamily = inferModelCapabilities(m.id).context;\n    const ctxWindow = providerCtxWindow({",
  },

  // ── ② 跨进程契约（done 载荷的 windowCap）──────────────────
  {
    name: "⑥ ★ stream 路径的 done 漏掉 windowCap（A-933 实锤：当时正是漏了正常发送这条）",
    file: GUI_INDEX,
    from: CAP_STREAM,
    to: "",
  },
  {
    name: "⑦ ★ retry 路径的 done 漏掉 windowCap（另一条路径也不能漏）",
    file: GUI_INDEX,
    from: CAP_RETRY,
    to: "",
  },
  {
    name: "⑧ ★ windowCap 不再来自唯一决策函数（就地编一个数字 → 环/压缩阈值/徽标再次各说各话）",
    file: GUI_INDEX,
    from: CAP_RETRY,
    to: "            windowCap: session.model ? 128000 : undefined,\n",
  },
  {
    name: "⑨ ★ 渲染层读了 windowCap 却不用（字段成了摆设，环仍按本地预设显示）",
    file: CHAT_PANEL,
    from: "      if (typeof m.windowCap === \"number\" && m.windowCap > 0) { setCtxCap(m.windowCap); }",
    to: "      if (typeof m.windowCap === \"number\" && m.windowCap > 0) { /* 变异：读而不写 */ }",
  },
  {
    name: "⑩ ★ 渲染层又去读家族能力表兜底窗口（主进程的职责被复制一份 → 双份真相源）",
    file: CHAT_PANEL,
    from: "      if (typeof m.windowCap === \"number\" && m.windowCap > 0) { setCtxCap(m.windowCap); }",
    to:
      "      if (typeof m.windowCap === \"number\" && m.windowCap > 0) { setCtxCap(m.windowCap); }\n" +
      "      else { setCtxCap(inferModelCapabilities(m.model ?? \"\").context ?? 0); }",
  },
];

const files = [PROVIDERS, GUI_INDEX, CHAT_PANEL];
const GUARDS = ["tests/core-ts/a1026-guards.spec.ts", "tests/core-ts/a1022-guards.spec.ts"];

const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));

/** 从 vitest 输出里取一条**有信息量**的失败原因。
 *  ⚠️ 别用 `includes("→")` 之类宽松匹配：测试名里就有箭头，会把 `stdout | …` 噪音当成原因。 */
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

const results = [];
for (const v of variants) {
  const orig = fs.readFileSync(v.file, "utf8");
  /* ⚠️ 换行符**逐文件**判定：本仓库检出并不统一（实测 `gui/src/main/providers.ts` 是 CRLF，
     而 `index.ts` / `ChatPanel.tsx` 是 LF）。锚点里写死 `\n` 会在 CRLF 文件上全部"未命中"，
     而脚本只会报"锚点未命中（脚本失效）"—— 看起来像脚本坏了，其实是锚点没适配换行。 */
  const eol = orig.includes("\r\n") ? "\r\n" : "\n";
  const from = v.from.replace(/\n/g, eol);
  const to = v.to.replace(/\n/g, eol);
  if (!orig.includes(from)) { results.push({ name: v.name, error: "变异锚点未命中（脚本失效）" }); continue; }
  fs.writeFileSync(v.file, orig.replace(from, to), "utf8");
  const r = runGuards();
  results.push({ name: v.name, code: r.code, reason: reasonOf(r.text), red: r.code !== 0 });
  fs.writeFileSync(v.file, orig, "utf8");
}

const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const restored = files.every((f) => before[f] === after[f]);

console.log("\n================ S5（A-1026 窗口上限契约）变异测试结果 ================");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.red ? "✓ 验红" : "✗ 未红（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ 全部文件哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`全部验红: ${results.every((r) => r.red) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.red) && restored ? 0 : 1);
