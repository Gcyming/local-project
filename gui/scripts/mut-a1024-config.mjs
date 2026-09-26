/*
 * 变异测试：计划 S3「模型配置与清单单一化」守卫的**取证**。
 *
 * 每条变异都打在"改回去不报错、跑起来也不崩、只是悄悄用了旧值/旧键名"的那个根因上，
 * 且都必须让 `tests/core-ts/a1024-guards.spec.ts` 变红。跑完自动还原并校验哈希。
 *
 * ⚠️ 为什么必须有这一步（项目铁律）：守卫写完只是**声明**了意图，变异测试才证明它**真的**在拦。
 *    A-1022 的实锤：断言串在 main 产物的**注释**里也出现，把代码改坏后守卫**依然全绿**。
 *    A-1023 的实锤：计数式断言把**函数定义**算成调用点，删掉一个真实调用点后仍然达标。
 *    所以本脚本对"只数个数"的断言尤其要验：⑬ 专门测"把常量定义挪走"能否被抓到；
 *    ⑫ 专门测**跨进程那一层**（初版守卫只扫 core-ts + gui，漏了 gateway-ts）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/pilot project";
const TEMPLATE = path.join(ROOT, "gui", "template", "slime.toml");
const ENGINE = path.join(ROOT, "core-ts", "src", "services", "engine.ts");
const PROVIDERS = path.join(ROOT, "gui", "src", "main", "providers.ts");
const IPC = path.join(ROOT, "gui", "src", "shared", "ipc.ts");
const GATEWAY = path.join(ROOT, "gateway-ts", "src", "llmGateway.ts");
/* ⚠️ ⑪ 要验的是"磁盘上多出一份**被 git 跟踪**的 slime.toml"。
 *    原先它借 `scripts/extracted-v2/template/slime.toml`（292MB 构建残渣）当靶子；
 *    A-1026 收尾时残渣已按要求清理 → 改为**自造**一份临时残渣，跑完连目录一起删。
 *    （测试不该依赖磁盘遗留物：那等于把"残渣还在"当成了前置条件。） */
const SCRATCH_ROOT = path.join(ROOT, "scripts", "_mut-a1024-scratch");
const SCRATCH = path.join(SCRATCH_ROOT, "template", "slime.toml");
const SCRATCH_REL = "scripts/_mut-a1024-scratch/template/slime.toml";

const sha = (p) => createHash("sha1").update(fs.readFileSync(p)).digest("hex");
const GUARDS = ["tests/core-ts/a1024-guards.spec.ts"];

/** ipc.ts 里 LocalModelSpec 的整块定义 —— 单行 `label?: string;` 在文件里出现多次，必须用整块做锚点。 */
const IPC_BLOCK =
  "export interface LocalModelSpec {\n" +
  "  id: string;\n" +
  "  path: string;\n" +
  "  label?: string;\n" +
  "  ctx_len?: number;\n" +
  "  gpu_layers?: number;\n" +
  "  max_output?: number;\n" +
  "  vision?: boolean;\n" +
  "}\n";

const variants = [
  /* ── ① 模板与实况 ─────────────────────────────────────── */
  {
    name: "① 模板 ctx_len 退回 8192（新装用户重复 A-1018：13811 tokens 被上游 400 顶回）",
    file: TEMPLATE,
    from: "ctx_len = 32768",
    to: "ctx_len = 8192",
  },
  {
    name: "② 模板删掉 kv_type 键（新装用户拿不到 KV 量化配置）",
    file: TEMPLATE,
    from: 'kv_type = "q8_0"\n',
    to: "",
  },
  {
    name: "③ 模板 kv_type 改成 f16 而 ctx 仍是 32768（★ 成对关系被破 = A-1021 的 OOM 复现）",
    file: TEMPLATE,
    from: 'kv_type = "q8_0"',
    to: 'kv_type = "f16"',
  },
  {
    name: "④ 模板路径键填上开发机绝对路径（发行包泄漏开发机路径）",
    file: TEMPLATE,
    from: 'models_dir = ""',
    to: 'models_dir = "D:\\\\pilot project\\\\models\\\\chat"',
  },
  {
    name: "⑤ 模板删掉 max_instances 键（模板与实况键集合开始漂移）",
    file: TEMPLATE,
    from: "max_instances = 1\n",
    to: "",
  },

  /* ── ② 清单唯一来源 ───────────────────────────────────── */
  {
    name: "⑥ engine 重新自定义 LocalModelSpec（三份定义开始漂移，engine 那份曾缺 vision）",
    file: ENGINE,
    /* ⚠️ 锚点于 **A-1108 迁移**：engine 的导入行去掉了 `LOCAL_MODELS_KEY`
       （那条「跳过本地模型伪供应商」的规则跟降级池一起搬进了 `services/fallbackPool.ts`，
       见 engine.ts 里留下的路标注释）。锚点必须跟着改，否则这条守卫**从那一刻起失去保护**
       —— 变异名字说的缺陷（engine 自己再声明一份 LocalModelSpec）就没人能复现了。 */
    from: 'import { findLocalModelSpec, type LocalModelSpec } from "../local_models.js";',
    to: 'import { findLocalModelSpec } from "../local_models.js";\ninterface LocalModelSpec { id: string; path: string; }',
  },
  {
    name: "⑦ engine 恢复硬编码键名直接下标取清单（绕过唯一实现）",
    file: ENGINE,
    from: "    return findLocalModelSpec(this.providers as unknown as Record<string, unknown>, id);",
    to: '    const raw = (this.providers as unknown as Record<string, unknown>)["_local_models"];\n'
      + "    if (!Array.isArray(raw)) { return undefined; }\n"
      + "    return (raw as LocalModelSpec[]).find((m) => m && m.id === id);",
  },
  {
    name: "⑧ providers 重新定义 LOCAL_MODELS_KEY 常量（键名出现第二个产地）",
    file: PROVIDERS,
    from: "const KEY_RE = ",
    to: 'const LOCAL_MODELS_KEY = "_local_models";\nconst KEY_RE = ',
  },
  {
    name: "⑨ ipc 投影删掉 vision 字段（重演 engine 那份缺字段的老病）",
    file: IPC,
    from: IPC_BLOCK,
    to: IPC_BLOCK.replace("  vision?: boolean;\n", ""),
  },
  {
    name: "⑩ ipc 把 label 改成必填（类型谎言：磁盘上的历史条目可能没有 label）",
    file: IPC,
    from: IPC_BLOCK,
    to: IPC_BLOCK.replace("  label?: string;", "  label: string;"),
  },

  /* ── ② 清单唯一来源：跨进程那一层（初版守卫漏掉、断言却声称"全部"） ── */
  {
    name: "⑫ 网关重新硬编码键名字符串（跨进程第 2 产地复活 → 改键名时清单被当供应商建路由）",
    file: GATEWAY,
    from: "      .filter(([k]) => k !== LOCAL_MODELS_KEY)",
    to: '      .filter(([k]) => k !== "_local_models")',
  },
  {
    name: "⑬ 网关删掉常量 import 改用他名字面量（符号无来源，独立进程静默失效）",
    file: GATEWAY,
    from: 'import { LOCAL_MODELS_KEY } from "../../core-ts/src/local_models.js";',
    to: 'const LOCAL_MODELS_KEY = "_local_models";',
  },
];

const files = [TEMPLATE, ENGINE, PROVIDERS, IPC, GATEWAY];
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
  const reason = (r.text.split("\n").find((l) => l.includes("AssertionError")) || "").trim().slice(0, 165);
  results.push({ name: v.name, code: r.code, reason, red: r.code !== 0 });
  fs.writeFileSync(v.file, orig, "utf8");
}

/* ── ③ 副本：模拟"残渣被 git 跟踪" ────────────────────────────────────
 * 用 `git add -N`（intent-to-add）把一份**自造**残渣放进索引：它**不改动已暂存内容**，
 * `git ls-files` 立即能列出（守卫据此变红），跑完 `git reset` + 删目录即可干净撤销。
 * 这是唯一能验证"跟踪份数"断言的手段 —— 不碰真实工作区文件。 */
{
  const name = "⑪ 把一份构建残渣纳入 git 索引（排查时会被误读成『发行版配置』）";
  let staged = false;
  let scratchMade = false;
  try {
    fs.mkdirSync(path.dirname(SCRATCH), { recursive: true });
    fs.copyFileSync(TEMPLATE, SCRATCH);
    scratchMade = true;
    // -N = intent-to-add（只在索引里留空条目，不改动已暂存内容）
    // -f = 必须：残渣是构建副产物，可能被 .gitignore 覆盖，不加 -f 会被拒绝
    execFileSync("git", ["add", "-N", "-f", "--", SCRATCH_REL], { cwd: ROOT });
    staged = true;
    const r = runGuards();
    const reason = (r.text.split("\n").find((l) => l.includes("AssertionError")) || "").trim().slice(0, 165);
    results.push({ name, code: r.code, reason, red: r.code !== 0 });
  } catch (e) {
    results.push({ name, error: `git 操作失败：${e instanceof Error ? e.message : String(e)}` });
  } finally {
    if (staged) {
      try { execFileSync("git", ["reset", "-q", "--", SCRATCH_REL], { cwd: ROOT }); }
      catch { /* 下面的一致性检查会暴露问题 */ }
    }
    if (scratchMade) {
      try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); }
      catch { /* 下面的一致性检查会暴露问题 */ }
    }
  }
}

const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const restored = files.every((f) => before[f] === after[f]);
let indexClean = true;
try {
  const out = execFileSync("git", ["ls-files", "--", "*slime.toml"], { cwd: ROOT, encoding: "utf8" });
  indexClean = out.split("\n").map((s) => s.trim()).filter(Boolean).length === 1;
} catch { /* git 不可用则不判 */ }
/** 自造残渣必须被清干净 —— 否则这个脚本自己就成了新的"磁盘残渣产地"。 */
const scratchClean = !fs.existsSync(SCRATCH_ROOT);

console.log("\n================ S3（A-1024）变异测试结果 ================");
results.forEach((r) => {
  if (r.error) { console.log(`  !! ${r.name}: ${r.error}`); return; }
  console.log(`  ${r.red ? "✓ 验红" : "✗ 未红（守卫失效！）"}  ${r.name}`);
  if (r.reason) { console.log(`        ${r.reason}`); }
});
console.log(`\n还原校验: ${restored ? "✓ 五文件哈希与原文一致" : "✗ 哈希不一致，请手工检查！"}`);
console.log(`索引还原: ${indexClean ? "✓ 跟踪的 slime.toml 仍只有 1 份" : "✗ 索引里残留了残渣，请手工 git reset！"}`);
console.log(`临时残渣: ${scratchClean ? "✓ 已删除" : `✗ 残留 ${SCRATCH_ROOT}，请手工清理！`}`);
console.log(`全部验红: ${results.every((r) => r.red) ? "✓ 是" : "✗ 否"}`);
process.exit(results.every((r) => r.red) && restored && indexClean && scratchClean ? 0 : 1);
