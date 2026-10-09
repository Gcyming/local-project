#!/usr/bin/env node
/**
 * mut-a1198-stage-runner.mjs — A-1197 · B3（L4c 阶段机）的变异验证
 * （声明校验 + 运行器优先级 + 执行侧硬约束 + 第二层工具校验；执行侧执行器见 §M10~M15）。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | M1 | `requirePrevious` 前向引用校验删除 | 阶段可以引用后面的阶段（环/前向引用进得来） | a1198-mode-manifest ② |
 * | M2 | `maxRounds` 上限改成 5000 | 阶段硬上限失效（失控阶段跑到底） | a1198-mode-manifest ② |
 * | M3 | `resolveRunnerKind` 把 mode 排到 brainstorm **后** | 显式模式被 brainstorm 抢走（会话选错引擎） | a1198-runner ① |
 * | M4 | 回落判据删除（不可用也返回 mode） | 扩展禁用后不回落（跑到死模式的阶段机上） | a1198-runner ② |
 * | M5 | 收束段不经 clipCarry（阶段间不裁剪） | 4 阶段 = 4 倍 token | a1198-stage-exec ② |
 * | M6 | abort 检查全删（两处） | 用户已停止但后续阶段继续跑 | a1198-stage-exec ② |
 * | M7 | 阶段级工具白名单不传 | 每阶段 tools 失效（全量工具面泄漏） | a1198-stage-exec ② |
 *
 * ## M10~M15（2026-10-08 审计补）：第二层校验（装载时查一次 / 运行前重查）与数字同源
 * 缺陷（若回归）：`validateModeTools` 沦为无人调用的纯函数（本轮审计实锤的「假接线」）——
 * 声明了不存在的工具仍能装载、运行到阶段也静默少工具；或 mode 贡献被假报「尚未接线」；
 * 或导引与实现的数字不同源（教 Agent 写出必被拒的清单）。
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | M10 | 运行前工具表重查删除 | 工具被停用也照跑、静默缺工具 | a1198-self-awareness ④ |
 * | M11 | 收束语不再区分「跳过」 | 跳过的阶段被说成全部完成 | a1198-self-awareness ④ |
 * | M12 | 装载检查查到了也不拒绝 | 「配了但不生效」的假自由度回来了 | a1198-self-awareness ④ |
 * | M13 | 空工具表当成「全都不存在」 | 引擎未装配时合法插件被全拒（假红灾难） | a1198-self-awareness ④ |
 * | M14 | mode 贡献展示退回「尚未接线」 | 假陈述（它明明能在会话里选中） | a1198-self-awareness ④ |
 * | M15 | MAX_STAGES 改 12 | 导引说 8、实现收 12（数字不同源） | a1198-self-awareness ③ |
 * | M16 | 群聊成员发言不注入自述 | 同一个 Agent 换个发言位就失忆 | a1198-self-awareness ⑥ |
 * | M17 | 定时任务不带能力指引 | 定时任务里的 Agent 又「不知道自己能力」 | a1198-self-awareness ⑥ |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-stage-runner.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1198-mode-manifest.spec.ts",
  "tests/core-ts/a1198-runner.spec.ts",
  "tests/core-ts/a1198-stage-exec.spec.ts",
  /* A-1198-S（2026-10-08 审计补）：第二层校验「真的接线」的守卫 ——
     M10~M14 打的就是它（纯函数存在 ≠ 有人调用），必须列入判据清单。 */
  "tests/core-ts/a1198-self-awareness.spec.ts",
];

const F_MODE = "core-ts/src/plugin/mode.ts";
const F_RUNNER = "core-ts/src/services/chatRunner.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_HOST = "core-ts/src/plugin/host.ts";
const F_SESSIONS = "core-ts/src/services/sessions.ts";
const F_CHAT = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_MODE, F_RUNNER, F_MAIN, F_HOST, F_SESSIONS, F_CHAT];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1198-stage");

const MUTATIONS = [
  {
    name: "M1 requirePrevious 前向引用校验删除（环/前向引用进得来）",
    file: F_MODE,
    mutate: (t) => sub(
      t,
      "        } else if (!seen.has(item.requirePrevious) || item.requirePrevious === id) {\n          /* 只认**前面的**阶段：前向引用与环（含自引）一律拒。 */\n          errors.push(`${sw}.requirePrevious 必须指向**前面的**阶段（禁止前向引用与环）：${item.requirePrevious}`);\n        } else {\n          decl.requirePrevious = item.requirePrevious;\n        }",
      "        } else {\n          decl.requirePrevious = item.requirePrevious;\n        }",
    ),
  },
  {
    name: "M2 maxRounds 上限改成 5000（阶段硬上限失效）",
    file: F_MODE,
    mutate: (t) => sub(
      t,
      "export const MAX_STAGE_ROUNDS = 500;",
      "export const MAX_STAGE_ROUNDS = 5000;",
    ),
  },
  {
    name: "M3 优先级反转：brainstorm 排在显式 mode 之前（会话选错引擎）",
    file: F_RUNNER,
    mutate: (t) => sub(
      t,
      "  const m = (input.sessionMode ?? \"\").trim();\n  if (m) {",
      "  if (input.isBrainstorm) {\n    return { kind: \"brainstorm\", reason: \"会话为多成员协作型\", fellBack: false };\n  }\n  const m = (input.sessionMode ?? \"\").trim();\n  if (m) {",
    ),
  },
  {
    name: "M4 回落判据删除（扩展禁用后不回落，跑到死模式上）",
    file: F_RUNNER,
    mutate: (t) => sub(
      t,
      "    if (input.isModeAvailable && !input.isModeAvailable(m)) {\n      return {\n        kind: \"agent-loop\",\n        reason: `显式运行模式「${m}」当前不可用（扩展未装载/被禁用），已回落到默认模式`,\n        fellBack: true,\n      };\n    }",
      "    /* 回落判据被删：不可用也返回 mode */",
    ),
  },
  /* ── 2026-10-08 · B3 执行侧（stageRunner / 分派接线）────────────────── */
  {
    name: "M5 收束段不经 clipCarry（阶段间不裁剪 ⇒ 4 阶段 = 4 倍 token）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    carried = clipCarry(doneReply || stageText);",
      "    carried = stageText;",
    ),
  },
  {
    name: "M6 abort 检查全删（用户已停止但后续阶段继续跑）",
    file: F_MAIN,
    all: true,
    mutate: (t) => subAll(t, "    if (opts.signal?.aborted) {\n      yield { seq: ++seq, type: \"notice\", data: { text: stopNote } };\n      return;\n    }", "    /* abort 检查被删 */"),
  },
  {
    name: "M7 阶段级工具白名单不传（每阶段 tools 失效，全量工具面泄漏）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "        ...(stage.tools && stage.tools.length > 0 ? { toolsOnly: [...stage.tools] } : {}),",
      "        /* toolsOnly 被删：阶段白名单失效 */",
    ),
  },
  /* ── 2026-10-08 · B3 选定入口（setMode 三层 + UI）────────────────── */
  {
    name: "M8 选中项不清（空值也保留旧 mode —— 选了「默认」但模式还挂在扩展上）",
    file: F_SESSIONS,
    mutate: (t) => sub(
      t,
      "    if (clean) {\n      meta.mode = clean.slice(0, 64);\n    } else {\n      delete meta.mode;\n    }",
      "    meta.mode = clean.slice(0, 64);",
    ),
  },
  {
    name: "M9 UI 切换不二次确认（直接落——当前阶段上下文被静默丢弃）",
    file: F_CHAT,
    mutate: (t) => sub(
      t,
      "    const ok = await confirmAsync(`切换运行模式为「${label}」？`, \"会丢弃当前阶段的中间上下文；下一轮请求起生效。\");\n    if (!ok) { return; }",
      "    const ok = true;\n    void label;",
    ),
  },

  /* ── M10~M15（2026-10-08 审计补）：第二层校验与数字同源 ─────────────────────
     这些变异打的是 tests/core-ts/a1198-self-awareness.spec.ts（已列入 SPECS）。 */
  {
    name: "M10 运行前工具表重查删除（工具被停用也照跑 —— 静默缺工具）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    if (stage.tools && stage.tools.length > 0 && opts.availableTools) {\n"
      + "      const available = await opts.availableTools().catch((e) => {\n"
      + "        console.warn(`[gui:stage] 阶段工具表重查失败（本阶段照常执行，但存在静默缺工具风险）: ${e instanceof Error ? e.message : String(e)}`);\n"
      + "        return undefined;\n"
      + "      });\n"
      + "      if (available) {\n"
      + "        const missing = stage.tools.filter((t) => !available.includes(t));\n"
      + "        if (missing.length > 0) {\n"
      + "          skipped += 1;\n"
      + "          yield { seq: ++seq, type: \"notice\", data: { text: `⚠️ 阶段「${stage.title ?? stage.id}」因工具不可用被跳过：${missing.join(\"、\")} 不在当前工具表（去「设置 → 权限」开启对应工具、检查 MCP 连接 / 扩展页的脚本信任，或关掉本扩展）。**该阶段未执行。**` } };\n"
      + "          continue;\n"
      + "        }\n"
      + "      }\n"
      + "    }\n",
      "    /* 变异：运行前工具表重查被删（工具不可用也不再出声） */\n",
    ),
  },
  {
    name: "M11 收束语不再区分「跳过」（把跳过的阶段说成全部完成）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "  } else {\n"
      + "    /* 有阶段被跳过 ⇒ 收束语必须如实 —— 不许把「跳过 K 步」说成「全部完成」。 */\n"
      + "    yield { seq: ++seq, type: \"notice\", data: { text: `⚠️ 阶段流结束（「${opts.modeTitle}」）：${total - skipped}/${total} 步已执行，${skipped} 步因工具不可用被跳过（见上文逐条）。` } };\n"
      + "  }",
      "  }",
    ),
  },
  {
    name: "M12 装载时 checkModeTools 查到了也不拒绝（配了不生效也不报）",
    file: F_HOST,
    mutate: (t) => sub(
      t,
      "          failed.set(name, `mode 声明的工具不存在于当前工具表：${missing.join(\"、\")}（拒绝装载 —— 不留「配了但不生效」的假自由度）`);",
      "          /* 变异：查到了也不拒绝 */",
    ),
  },
  {
    name: "M13 装载检查把「判不了」当「不存在」（引擎未装配时空表全拒 —— 假红灾难）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "      const names = new Set(toolReg.listToolNames());\n      if (names.size === 0) {\n        return [];\n      }",
      "      const names = new Set(toolReg.listToolNames());",
    ),
  },
  {
    name: "M14 mode 贡献展示退回「尚未接线」（假陈述：它明明能在会话里选中）",
    file: F_HOST,
    mutate: (t) => sub(
      t,
      "        contributions.push(`mode:${describeMode(manifest.mode)}`);",
      "        contributions.push(`mode:${WIRING_PENDING}`);",
    ),
  },
  {
    name: "M15 MAX_STAGES 改 12（导引说 8、实现收 12 —— 数字不同源）",
    file: F_MODE,
    mutate: (t) => sub(
      t,
      "export const MAX_STAGES = 8;",
      "export const MAX_STAGES = 12;",
    ),
  },
  {
    name: "M16 群聊成员发言不注入自述（同一个 Agent 换个发言位就失忆）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "` + selfAwarenessGuide(resolveAgentToolProfile(agent.tool_profile)),",
      "`,",
    ),
  },
  {
    name: "M17 定时任务不带能力指引（又回到「不知道自己能力」的旧病）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "        const system = await engine.buildSystem(agent, undefined, undefined)\n"
      + "          + agentSkillGuide(resolveAgentToolProfile(agent.tool_profile));",
      "        const system = await engine.buildSystem(agent, undefined, undefined);",
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
if (reportEolProblems(eolFound, "mut-a1198-stage-runner")) { process.exit(1); }

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

console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-stage-runner.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
process.exit(1);
