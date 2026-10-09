#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-silam-off.mjs — A-1197「silam 自研模型下线」的变异验证。
 *
 * ## 这一轮改的是什么（用户原话）
 *   「把JuiceBuddha 自研模型下线（断开关 + 换掉兜底），保留代码资产作将来自研的占位」
 *
 * ## 为什么要下线（实测结论，不是拍脑袋）
 *   sidecar 能跑（依赖齐、权重在、6 秒拉起），但**模型层有病**，且病在管道层治不了：
 *     · 语言脑是 6922 词表 d16 线性模型、无训练支撑 ⇒ 16/16 轮压测全是乱码；
 *       而 sidecar 的退化阀 _degenerate（silam_brain_sidecar.py:66-80）**全部放行**。
 *     · 截断是硬切：lang_core.py:429 的 `for _step in range(max_len)`，
 *       sidecar:157-160 传 max_len=128 ⇒ 16 轮里 14 轮精确 138 字。
 *   用户已授权「修不了就暂时去除，留占位」⇒ 断开关 + 换掉兑底，资产全留。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | [silam] enabled 改回 true | 坏模型又被拉起来 | a1197 A1 |
 * | 2 | [silam] as_brain 改回 true | 「无模型时拿 SILAM 兜底应答」这条路径复活 | a1197 A1 |
 * | 3 | chat 兑底 model 改回 siliam-brain | 没配模型的用户收到乱码，却标成模型回答 | a1197 B1/B4 |
 * | 4 | stream 兑底 model 改回 siliam-brain | 同上（流式侧） | a1197 B1/B5 |
 * | 5 | 兑底文案谎称是模型回答 | 拿一句编的话冒充模型输出 | a1197 B6 |
 * | 6 | 占位文案吹「即将支持」 | 教用户等待一个没排期的承诺 | a1197 C1/A2 |
 * | 7 | 下拉条目去掉 siliamOk 门控 | 下线后又出现选了就只能拿到占位文案的死选项 | a1197 D1 |
 * | 8 | siliamOk 硬编码为 true | 门控形同虚设（status 不再是唯一如实产地） | a1197 D2 |
 * | 9 | _onStdout 恢复裸 continue | 协议坏了也一声不吭，只能等到超时 | a1197 E1 |
 * | 10 | _onStdout 出声改成 throw | 为「出声」付出打断整个 stdout 流的代价 | a1197 E3 |
 * | 11 | 裸 print 噪声改成逐行 warn | 已知混入的模型 print 会把日志刷爆 | a1197 E4 |
 * | 12 | slime_memory 又不转发 | 加载了却发不出去，sidecar 永远等不到长期记忆 | a1197 F1 |
 * | 13 | 删掉保留资产（silam 模块） | 「留占位」变成「连资产一起删」，无法接回| a1197 A3 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-silam-off.mjs`
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-silam-off.spec.ts",
];

const F_TOML = "slime.toml";
const F_ENGINE = "core-ts/src/services/engine.ts";
const F_SILAM = "core-ts/src/services/silam_brain.ts";
const F_CHATPANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_TOML, F_ENGINE, F_SILAM, F_CHATPANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-silam-off");

const MUTATIONS = [
  /* ── ①② 开关：断两处（单断一处就是回归）───────────────────────── */
  {
    name: "1 [silam] enabled 改回 true（坏模型又被拉起来）",
    file: F_TOML,
    mutate: (t) => sub(
      t,
      "enabled = false           # A-1197：自研模型质量未达标（乱码 + 硬截断），暂时下线；资产保留作占位",
      "enabled = true            # A-1197：自研模型质量未达标（乱码 + 硬截断），暂时下线；资产保留作占位",
    ),
  },
  {
    name: "2 [silam] as_brain 改回 true（无模型时兜底应答这条路径复活）",
    file: F_TOML,
    mutate: (t) => sub(
      t,
      "as_brain = false          # A-1197：不再做「无模型时的兑底应答」——那会把乱码当成模型回给用户",
      "as_brain = true           # A-1197：不再做「无模型时的兑底应答」——那会把乱码当成模型回给用户",
    ),
  },
  /* ── ③④ 4 处兑底：model 字段必须如实 ─────────────────────────── */
  {
    name: "3 chat 兑底 model改回 silam-brain（乱码被当成模型回答）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      `      const reply = this.noModelRouteText(opts.agent, error);
      return {
        reply,
        replyRaw: reply,
        model: "none",`,
      `      const reply = this.noModelRouteText(opts.agent, error);
      return {
        reply,
        replyRaw: reply,
        model: "silam-brain",`,
    ),
  },
  {
    name: "4 stream 兑底 model 改回 silam-brain（同上，流式侧）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      `      const reply = this.noModelRouteText(opts.agent, error);
      yield { type: "done", reply, reply_raw: reply, model: "none",`,
      `      const reply = this.noModelRouteText(opts.agent, error);
      yield { type: "done", reply, reply_raw: reply, model: "silam-brain",`,
    ),
  },
  /* ── ⑤ 兑底文案谎称是模型回答 ─────────────────────────────────── */
  {
    name: "5 兑底文案谎称是模型回答（编一句话冒充模型输出）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "`本轮没有可用模型来应答 —— 这句话不是模型回答，是 slime 的如实提示。\\n` +",
      "`本轮的回答如下：\\n` +",
    ),
  },
  /* ── ⑥ 占位文案吹「即将支持」 ─────────────────────────────────── */
  {
    name: "6 占位文案吹即将支持（教用户等待没排期的承诺）",
    file: F_ENGINE,
    mutate: (t) => sub(
      t,
      "`现状：silam 离线自研大脑已下线（slime.toml 的 [silam] 段 enabled=false），` +",
      "`现状：silam 离线自研大脑即将支持（slime.toml 的 [silam] 段 enabled=false），` +",
    ),
  },
  /* ── ⑦⑧ 下拉门控 ────────────────────────────────────────────── */
  {
    name: "7 下拉条目去掉 silamOk 门控（死选项又可见）",
    file: F_CHATPANEL,
    mutate: (t) => sub(
      t,
      `...(silamOk
                  ? [{ value: "silam", label: "silam", group: "内置", title: "SILAM 双脑（情感脑+语言脑，grow 成长模式）" }]
                  : []),`,
      `{ value: "silam", label: "silam", group: "内置", title: "SILAM 双脑（情感脑+语言脑，grow 成长模式）" },`,
    ),
  },
  {
    name: "8 silamOk 硬编码为 true（门控形同虚设，status 不再是唯一产地）",
    file: F_CHATPANEL,
    mutate: (t) => sub(
      t,
      "const [silamOk, setSilamOk] = React.useState(false);",
      "const [silamOk, setSilamOk] = React.useState(true);",
    ),
  },
  /* ── ⑨⑩⑪ _onStdout：静默失效必须出声，但别打断解析 ───────────── */
  {
    name: "9 _onStdout 恢复裸 continue（协议坏了也一声不吭）",
    file: F_SILAM,
    mutate: (t) => sub(
      t,
      `      } catch {
        if (line.startsWith("{")) {`,
      `      } catch {
        if (false) {`,
    ),
  },
  {
    name: "10 _onStdout 出声改成 throw（为出声付出打断 stdout 流的代价）",
    file: F_SILAM,
    mutate: (t) => sub(
      t,
      "          console.warn(`[silam] sidecar stdout 出现无法解析的 JSON 行（已跳过，不影响其它帧）：${line.slice(0, 200)}`);",
      "          throw new Error(`[silam] sidecar stdout 出现无法解析的 JSON 行：${line.slice(0, 200)}`);",
    ),
  },
  {
    name: "11 裸 print 噪声改成逐行 warn（已知混入的 print 会刷爆日志）",
    file: F_SILAM,
    mutate: (t) => subAll(
      t,
      `        } else {
          // 模型侧裸 print（已知会混进来），累计后只报一次，避免刷屏。
          this.noiseLines += 1;
        }`,
      `        } else {
          console.warn("[silam] sidecar stdout 混入非协议行（已跳过）");
        }`,
    ),
  },
  /* ── ⑫ slime_memory 转发 ────────────────────────────────────── */
  {
    name: "12 slime_memory 又不转发（加载了却发不出去）",
    file: F_SILAM,
    mutate: (t) => sub(
      t,
      "        ...(opts.slimeMemory && opts.slimeMemory.length > 0 ? { slime_memory: opts.slimeMemory } : {}),\n",
      "",
    ),
  },
  /* ── ⑬ 保留资产被删 ─────────────────────────────────────────── */
  {
    name: "13 删掉保留资产（留占位变成连资产一起删）",
    file: F_SILAM,
    mutate: (t) => sub(
      t,
      "export interface SilamBrain {",
      "export interface SilamBrainRemovedByMutation {",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error("  - " + b); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1197-silam-off")) { process.exit(1); }

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log("  " + (i + 1) + ". [" + m.file + "] " + m.name); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error("--apply 需要条目号（1.." + MUTATIONS.length + "）"); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, basename(m.file) + ".orig"), src);
    const text = src.toString("utf8");
    let next;
    try { next = m.mutate(text); }
    catch (e) {
      console.error("锚点未命中（变异体没落地）：" + m.name + "\n    " + e.message);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    if (next === text) { console.error("锚点未命中：" + m.name); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log("已变异 M" + idx + "：" + m.name);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, basename(man.file) + ".orig");
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error("还原校验失败：" + man.file + "\n   期望 " + man.sha256 + "\n   实际 " + now);
    process.exit(1);
  }
  console.log("已逐字节还原 " + man.file + "（sha256 一致）");
  process.exit(0);
}

/* ── 全量模式：提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-silam-off.mjs");
console.error("  （判据 spec 会自动读脚本里的 SPECS：" + SPECS.join(" ") + "）");
if (TARGETS.length !== 4) { process.exit(1); }
process.exit(1);
