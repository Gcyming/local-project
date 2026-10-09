#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-thinking-leak.mjs — A-1197「切走会话后思考被吞 + 抢占下一个对话」的变异验证。
 *
 * ## 这一轮改的是什么（与模型无关）
 * 用户报症：思考内容被吞 + 抢占下一个对话的思考历程。取证证明这是**渲染/流式层的
 * 状态对齐缺陷**，换任何模型都会复发，所以修的是通用链路。
 *
 * ## 两条真正的不变量
 * I1「切走期间后台结束的那条流，思考必须落盘」
 *    `onDone` 的后台镜像分支（`m.sessionId !== sessionRef.current`）此前只写 `snap.partial`
 *    就return —— localStorage 通道在这条路径上完全没写，而内存快照在会话恢复末尾会被
 *    `delete perSessionStreamCache.current[sessionId]` ⇒ 思考永久丢失。
 * I2「assistant 序数对齐不因缺失一条而整体错位」
 *    写侧序数只在「前台 onDone」自增（`assistantOrdinalRef.current += 1`），后台那条早退不写
 *    ⇒ 写侧留空洞；读侧 `attachTimelineToHistory` 是 `aiOrd += 1` 从头数到尾
 *    ⇒ 空洞之后每一条回复的思考都挂到**前一轮**卡片上（= 用户报的「抢占下一个对话」）。
 *    修法：新增**回复指纹**通道（`timelineByReplyKey` / `reasoningByReplyKey`），读侧指纹优先、
 *    序数退化为兜底。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 后台分支删掉 writeTurnTimeline | I1 原样复发：切走期间结束的思考永久丢失 | I1「后台分支必须调writeTurnTimeline」 |
 * | 2 | 前景 onDone 删掉指纹落盘 | 指纹通道只覆盖后台轮次 ⇒ 会话里只要出现一次后台结束，之后全部错位 | I1「前台也要按指纹写一份」 |
 * | 3 | 落盘时不再带 snap.reasoning | 落盘的是空思考 ⇒ 切回是空折叠区（与 I1 同症状、不同机制） | I1「必须带 snap.reasoning」 |
 * | 4 | 指纹通道退化为序数通道 | I2 原样复发：抢占下一轮 | I2「指纹优先于序数」 |
 * | 5 | 指纹队列游标不自增 | 重复回复文本（「好的」×3）的思考全挂到第一条 | I2「队列一一对应」 |
 * | 6 | 指纹改成「命中一次就永远命中」 | 同上，但换了个实现（守卫要能区分这两种写法） | I2「队列一一对应」 |
 * | 7 | 指纹不剥尾部标记 | 截断/中断的回复取不到自己的思考（静默退化成没命中＝原 bug） | 行为层「指纹对尾部追加免疫」 |
 * | 8 | 渲染层不读 a.reasoning | 读侧补回来的思考在渲染层被丢弃 ⇒ 白补 | I1「必须消费 recover 的思考」 |
 * | 9 | 指纹通道不settle running | 工具卡永久显示「执行中」 | 行为层「running 必须被 settle」 |
 *
 * ⚠️ name 序号== 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；
 *    多处匹配会改错对象，所以每条都带 `split(x).length === 1` 断言（见MUTATIONS 内的 `uniq`）。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-thinking-leak.mjs`
 *    （**不传 spec**：脚本会自动读本文件的 `const SPECS`，手写清单漏一份会让变异假存活却不报错。）
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-thinking-leak.spec.ts",
];

const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_META = "gui/src/renderer/pages/sessionCtxMeta.ts";
const TARGETS = [F_PANEL, F_META];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-thinking-leak");

/**
 * 唯一锚断言：`String.replace` 只改**第一处**命中，多处匹配时脚本会"看起来成功"
 * 却改错了对象（或者只改了一处、另一处仍对 ⇒ 假存活/假红）。
 *
 * ⚠️⚠️ **必须放在 `--apply` 分支里，绝不能放进 `mutate` 体内**（实测踩到，且代价很大）：
 *   模块顶层会调`eolProblems(MUTATIONS, ROOT)` 做行尾自检，而它会**用当前磁盘原文**
 *   反复调用每条 `mutate`。一旦源码正停在**别的变异体**状态（比如 M1 已 apply），
 *   任何写在 `mutate` 里的「锚必须命中 1 次」断言都会抛错 ⇒
 *   **脚本在到达 `--restore` 之前就崩了** ⇒ M1 的变异体留在源码里，
 *   而 `--apply` 又因manifest 存在而全部拒绝 ⇒ 一轮跑批只剩 M1 一条有效结果，
 *   且工作区停在变异态（这正是跑批脚本末尾 `_tmp-mut-*` 残留告警要防的事故）。
 *   ⇒ 断言只在 apply 路径生效：那�� `--apply` 本来就会因 manifest 存在而拒绝，
 *      不存在「带着变异体来restore」这条路径。
 */
const uniq = (text, needle, who) => {
  const re = new RegExp(needle.split("\n").map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\r?\\n"));
  const n = (text.match(re) ?? []).length;
  if (n !== 1) {
    throw new Error(`锚点在 ${who} 里命中 ${n} 次（期望恰好 1）—— 多处匹配会改错对象`);
  }
};

const MUTATIONS = [
  /* ── I1：切走期间后台结束的那条，思考必须落盘 ──────────────────── */
  {
    name: "1 后台 onDone 分支删掉 writeTurnTimeline（切走即丢思考）",
    file: F_PANEL,
    uniqAnchor: "writeTurnTimeline(\n              agentId, sid, m.reply,\n              (snap.timeline ?? []) as TimelineStepLite[],\n              (snap.reasoning ?? \"\").trim() || undefined,\n            );",
    mutate: (t) => sub(
      t,
      "writeTurnTimeline(\n              agentId, sid, m.reply,\n              (snap.timeline ?? []) as TimelineStepLite[],\n              (snap.reasoning ?? \"\").trim() || undefined,\n            );",
      "// M1 变异：后台分支不再落盘思考",
    ),
  },
  {
    name: "2 前景 onDone 删掉指纹落盘（指纹通道只剩后台轮次）",
    file: F_PANEL,
    uniqAnchor: "writeTurnTimeline(\n          agentId, sessionRef.current, m.reply,\n          finalTimeline as TimelineStepLite[],\n          finalReasoning,\n        );",
    mutate: (t) => sub(
      t,
      "writeTurnTimeline(\n          agentId, sessionRef.current, m.reply,\n          finalTimeline as TimelineStepLite[],\n          finalReasoning,\n        );",
      "// M2 变异：前景不再写指纹通道",
    ),
  },
  {
    name: "3 落盘时不再带 snap.reasoning（写进去的是空思考）",
    file: F_PANEL,
    uniqAnchor: "              (snap.reasoning ?? \"\").trim() || undefined,",
    mutate: (t) => sub(
      t,
      "              (snap.reasoning ?? \"\").trim() || undefined,",
      "              undefined,",
    ),
  },
  /* ── I2：序数对齐不得因缺失一条而整体错位 ──────────────────────── */
  {
    name: "4 指纹通道退化为序数通道（抢占下一轮原样复发）",
    file: F_META,
    uniqAnchor: "    const fromMeta = fromKey ?? byOrdinal;",
    mutate: (t) => sub(
      t,
      "    const fromMeta = fromKey ?? byOrdinal;",
      "    const fromMeta = byOrdinal;",
    ),
  },
  {
    name: "5 指纹队列游标不自增（重复文本的思考全挂到第一条）",
    file: F_META,
    uniqAnchor: "        cursors.set(fp!, at + 1);",
    mutate: (t) => sub(
      t,
      "        cursors.set(fp!, at + 1);",
      "        cursors.set(fp!, at);",
    ),
  },
  {
    name: "6 指纹改成命中一次就永远命中（换了实现的同一个错）",
    file: F_META,
    uniqAnchor: "      const at = cursors.get(fp!) ?? 0;",
    mutate: (t) => sub(
      t,
      "      const at = cursors.get(fp!) ?? 0;",
      "      const at = 0;",
    ),
  },
  {
    name: "7 指纹不剥尾部标记（截断/中断的回复取不到自己的思考）",
    file: F_META,
    uniqAnchor: "  const rawHead = s.split(/已中断（停止生成）/)[0].split(/截断/)[0];",
    mutate: (t) => sub(
      t,
      "  const rawHead = s.split(/已中断（停止生成）/)[0].split(/截断/)[0];",
      "  const rawHead = s;",
    ),
  },
  {
    name: "8 渲染层不读 a.reasoning（补回来的思考在渲染层被丢弃）",
    file: F_PANEL,
    uniqAnchor: "        const recoveredReasoning = a.reasoning ?? m.reasoning;",
    mutate: (t) => sub(
      t,
      "        const recoveredReasoning = a.reasoning ?? m.reasoning;",
      "        const recoveredReasoning = m.reasoning;",
      ),
  },
  {
    name: "9 指纹通道不settle running（工具卡永久显示执行中）",
    file: F_META,
    // ⚠️ 锚点必须与 M4 **区分开**：M4 改的是「指纹优先」那一行，
    //   M9 改的是「落进settleRunning」那一步 —— 两条锚指向不同位置。
    //   （若两条锚指向同一处文本，「唯一性」就成了「同一个锚被用了两次」，
    //   核验器与 apply 期的唯一性断言都会失去意义。）
    uniqAnchor: "      timeline: settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline)),\n      reasoning,",
    mutate: (t) => sub(
      t,
      "      timeline: settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline)),\n      reasoning,",
      "      timeline: fromMeta ?? adoptRecordTimeline(m.timeline),\n      reasoning,",
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
if (reportEolProblems(eolFound, "mut-a1197-thinking-leak")) { process.exit(1); }

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
    //唯一性断言只在这里（apply 路径）生效，见 uniq 的注释：放进 mutate 会让
    // 顶层行尾自检在「源码停在别的变异态」时抛错，把 --restore 一起带崩。
    if (m.uniqAnchor) { uniq(text, m.uniqAnchor, `M${idx}`); }
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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-thinking-leak.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 2) { process.exit(1); }
process.exit(1);