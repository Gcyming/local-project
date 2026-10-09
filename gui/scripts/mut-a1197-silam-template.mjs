#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-silam-template.mjs — A-1197「silam 下线必须覆盖干净安装」+本轮 P1/P2 的变异验证。
 *
 * ## 这一轮改的是什么
 *   ① P0-2：上一轮把 `[silam]` 置为关闭只做了**本机** `slime.toml`，而那份文件被gitignore、
 *     不入库；真正随包发出去的是 `gui/template/slime.toml`（受版本控制）。
 *     ⇒ 干净安装上「已下线」全是假的，引擎仍会调真实 SILAM、输出乱码。
 *   ② P1-1：`dataRoot.ts` 的注释有编辑残留；`runtimeStateDir()` 的 catch 完全静默。
 *   ③ P1-2：`dataRootSet` 回传的root 未 resolve，与 `dataRootInfo()` 不同产。
 *   ④ P2-3：`agentTools.ts` 的归因文案说「宿主还没接线」，实际是钩子返回空。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 *   | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 *   |---|---|---|---|
 *   | 1 | 模板 `[silam] enabled` 回 true | 干净安装上引擎又调真实 SILAM（乱码） | a1197-silam-template A1 |
 *   | 2 | 模板 `[silam] as_brain` 回 true | 重新启用「无模型时的兜底应答」 | a1197-silam-template A1 |
 *   | 3 | 模板删掉占位键（只留两行开关） | 整段被抹掉，将来接不回来| a1197-silam-template A2 |
 *   | 4 | 模板去掉关闭原因注释 | 后人以为回一个 true 就能开 | a1197-silam-template A3 |
 *   | 5 | builder 把模板映射到别的文件名 | 改了模板但发出去的不是那份 | a1197-silam-template B1/B2 |
 *   | 6 | boot多applyKey 一个键 | 改写入口多一个（张nature上P0-2 复发） | a1197-silam-template C1/C2 |
 *   | 7 | runtimeStateDir 的 catch 去掉 warn | 静默失效（违项目铁律） | a1197-silam-template D1 |
 *   | 8 | dataRootSet 回传裸 dir | root 未 resolve ⇒ 渲染层显示的值被回刷成另一个 | a1197-silam-template D4 |
 *   | 9 | agentTools 归因改回「还没接线」 | 归因不准（结论对但误导定位） | a1197-silam-template E1 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-silam-template.mjs`
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-silam-template.spec.ts",
];

const F_TEMPLATE = "gui/template/slime.toml";
const F_BUILDER = "gui/electron-builder.json";
const F_BOOT = "gui/src/main/boot.ts";
const F_DATAROOT = "gui/src/main/dataRoot.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_AGENTTOOLS = "core-ts/src/services/agentTools.ts";
const TARGETS = [F_TEMPLATE, F_BUILDER, F_BOOT, F_DATAROOT, F_MAIN, F_AGENTTOOLS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-tpl");

const MUTATIONS = [
  /* ── ① P0-2 核心：模板的开关必须为 false ────────────────────────── */
  {
    name: "1 模板 [silam] enabled 回 true（干净安装上又调真实 SILAM）",
    file: F_TEMPLATE,
    mutate: (t) => sub(
      t,
      "[silam]\nenabled = false\nas_brain = false\n",
      "[silam]\nenabled = true\nas_brain = false\n",
    ),
  },
  /* ── ② as_brain 也要钉死（只判enabled 的话这条会存活） ──────────── */
  {
    name: "2 模板 [silam] as_brain 回 true（重新启用无模型兜底应答）",
    file: F_TEMPLATE,
    mutate: (t) => sub(
      t,
      "[silam]\nenabled = false\nas_brain = false\n",
      "[silam]\nenabled = false\nas_brain = true\n",
    ),
  },
  /* ── ③ 整段不许被删（占位键） ─────────────────────────────────── */
  {
    name: "3 模板 [silam] 删掉占位键（整段被抹成两行开关）",
    file: F_TEMPLATE,
    mutate: (t) => sub(
      t,
      '[silam]\nenabled = false\nas_brain = false\nagent_id = "silam-default"',
      "[silam]\nenabled = false\nas_brain = false",
    ),
  },
  /* ── ④ 关闭原因必须留在模板里 ───────────────────────────────────── */
  {
    name: "4 模板去掉关闭原因注释（后人以为回 true 就能开）",
    file: F_TEMPLATE,
    mutate: (t) => sub(
      t,
      "# A-1197：自研模型质量未达标（乱码 + 硬截断），暂时下线；资产保留作占位。\n",
      "",
    ),
  },
  /* ── ⑤ 模板必须真的随包发出去 ──────────────────────────────────── */
  {
    name: "5 builder 把模板映射到别的文件名（改了模板但发出去的不是那份）",
    file: F_BUILDER,
    mutate: (t) => sub(
      t,
      '{ "from": "template/slime.toml", "to": "slime.toml" }',
      '{ "from": "template/slime.toml", "to": "config/slime.toml" }',
    ),
  },
  /* ── ⑥ boot 的改写入口必须仍然只有三个键 ───────────────────────── */
  {
    name: "6 boot 多 applyKey 一个键（改写入口多一个口子）",
    file: F_BOOT,
    mutate: (t) => sub(
      t,
      '    applyKey("models_dir", (cur) => (cur && existsSync(cur) ? cur : (existsSync(chatDir) ? chatDir : chatDirUser)));',
      '    applyKey("models_dir", (cur) => (cur && existsSync(cur) ? cur : (existsSync(chatDir) ? chatDir : chatDirUser)));\n    applyKey("agent_id", () => "silam-default");',
    ),
  },
  /* ── ⑦ 静默失效必须出声（项目铁律） ───────────────────────────── */
  {
    name: "7 runtimeStateDir 的 catch 去掉 warn（静默失效）",
    file: F_DATAROOT,
    mutate: (t) => sub(
      t,
      "  } catch (e) {\n    // 建不出来时调用方会拿到具体错误；这里也必须出声（项目铁律：静默失效必须出声）——\n    // 否则「运行时状态目录建不出来」这件事只有后来写文件报错时才现形，根因无从追。\n    console.warn(`[gui:dataRoot] 运行时状态目录创建失败（${dir}）: ${e instanceof Error ? e.message : String(e)}`);\n  }",
      "  } catch {\n    // 建不出来时调用方会拿到具体错误\n  }",
    ),
  },
  /* ── ⑧ 同一事实只能有一个产地 ─────────────────────────────────── */
  {
    name: "8 dataRootSet 回传裸 dir（root 未 resolve ⇒ 显示值被回刷）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "return { ok: true, migrated, root: resolve(dir), needRestart: true };",
      "return { ok: true, migrated, root: dir, needRestart: true };",
    ),
  },
  /* ── ⑨ 归因必须与实现一致 ─────────────────────────────────────── */
  {
    name: "9 agentTools 归因改回「宿主还没接线」（归因不准）",
    file: F_AGENTTOOLS,
    /* ⚠️ 2026-10-08 锚点重打（A-1198 同步）：行内多了「`provides` 这条路，」限定词
       （B4 落地后「不接受外部插件贡献工具」只对 provides 路径成立）。变异意图不变：
       把精确归因（钩子返回空）换成误导归因（宿主还没接线）。 */
    mutate: (t) => sub(
      t,
      "写 `tools` 或 `prompt` **不会被拒绝，但也不会生效** —— `provides` 这条路，桌面端目前不接受外部插件贡献工具（宿主钩子返回空），",
      "写 `tools` 或 `prompt` **不会被拒绝，但也不会生效** —— 桌面端的插件宿主还没接线，",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error(`  - ${b}`); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1197-tpl")) { process.exit(1); }

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    let next;
    try { next = m.mutate(text); }
    catch (e) {
      console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式：提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-silam-template.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
process.exit(1);