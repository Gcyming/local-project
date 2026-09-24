/**
 * gui/scripts/mut-a1090-rescue.mjs — A-1090 变异测试（把「压无可压」的出路真正交到用户手上）。
 *
 * ## 本轮修的三个缺陷（各自都有"下一个人顺手写回去、而且全都不报错"的退化形态）
 *
 * | # | 缺陷 | 用户看到什么 |
 * |---|---|---|
 * | ① | 候选只带**裸 model id**，没有可写入 `model_choice` 的选择串 | 「一键切换」切不过去（`api:<key>:<id>` 拼不出来 ⇒ 切到不存在的模型） |
 * | ② | `formatRescueHint(undefined)` 与 `(null)` 同一句话（「**已查过**…没有候选」） | 引擎侧保险门**没查过**却替检查背书 ⇒ 用户放弃一条可能走得通的路 |
 * | ③ | 只有建议没有出口；且红字横幅被 `resetStreamUI()` 同一批 setState 清成 null | 按钮不存在；连错误提示都只在"切走再切回"时才冒出来 |
 *
 * ## 覆盖的二十三条
 *
 *   1~2   三态判据本体：「没查」被写成「查过没有」/ 平手判据退回裸 id
 *   3~8   主进程 `suggestWiderChatModel`：丢 choice / 去重退回裸 id / 供应商串丢失 /
 *         需求量未知返回 null / catch 返回 null / 拒发路径丢结构化候选
 *   9~15  渲染层：不 await 写盘 / 丢 keepBanner / 无条件清横幅 / 丢 rescueModel 回带 /
 *         类型声明丢字段 / 内联按钮文案 / 按钮不挂 onClick
 *   16~18 文案与动作说反话（A-1062 那一族）：说「重发」/ 悬停不提"不会重复" / 契约手抄形状
 *   19    新增入口缺 null 守卫（A-1019 ④ 那一族：preload 未就绪 ⇒ 取值点后裸访问 ⇒ 整页白屏）
 *   20~23 **A-1019 ④ 判据本身**的空转退化（M19 第一次实跑**没被捕获**才发现的）：
 *         链尾 `?.` 判据被删（`bareChain` 恒真 ⇒ 假阳性）/
 *         判据不再在**作用域边界**停下（守卫写在回调里也保护不了 ⇒ 5 处合法写法误报）/
 *         丢掉 `guarded` 闸门（守卫生效后照样报 ⇒ 狼来了）/
 *         `truthyProvesApi` 恒假（`&&` 型守卫分支被误报）。
 *         由 ④ 段的 8 条**自检** + 全仓实扫捕获。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照 / 还原一律走**字节**（Buffer），不做文本往返；还原后比哈希。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1090-rescue.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1090-rescue.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1090-rescue.mjs --apply 3   # 只改第 3 条并**留着**（给跑不了子进程的环境）
 *   node gui/scripts/mut-a1090-rescue.mjs --restore    # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 `EBUSY`）
 *
 * WorkBuddy 的沙箱禁止 **node→node 孙进程**（`spawnSync(process.execPath, …)` 直接 `EBUSY`），
 * 于是 `runSpecs()` 起不来。此时改用 `--apply` / `--restore` 两半 + **shell 循环**
 * （vitest 由 shell 直接启动，不经过 node 派生）：
 *
 *   ```bash
 *   SPECS="tests/core-ts/a1090-rescue.spec.ts tests/core-ts/a1019-guards.spec.ts \
 *          tests/core-ts/context-loop.spec.ts tests/gui/stream-errors.spec.ts \
 *          tests/core-ts/resume-outcome.spec.ts"
 *   for n in $(seq 1 23); do
 *     node gui/scripts/mut-a1090-rescue.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     red=1
 *     for s in $SPECS; do
 *       node node_modules/vitest/vitest.mjs run "$s" >/dev/null 2>&1 || red=0
 *     done
 *     node gui/scripts/mut-a1090-rescue.mjs --restore >/dev/null
 *     if [ "$red" = "1" ]; then echo "❌ M$n 未被捕获"; else echo "✅ M$n 被捕获"; fi
 *   done
 *   ```
 *
 *   ⚠️ 必须遍历 **SPECS 里全部五份**（不是只跑 a1090）：每条变异的"捕获者"不同 ——
 *   例如 M19 的判据在 `a1019-guards`。只跑一份会把"别的 spec 抓到了"误报成"未被捕获"。
 *
 *   ⚠️ 多份 spec 必须**分开跑**：本环境实测把多份 spec 传给同一次 vitest 时，
 *   第二份起有概率因沙箱写临时目录 `EPERM` 而**未被收集**（输出里仍显示通过），
 *   于是"全绿"可能只是"只跑了一份"。分开跑并逐个判 exit code 才不会假绿。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** @type {string[]} 本轮守卫分散在五份 spec（任一变红即算捕获）
 *  ⚠️ 第 5 份 `a1019-guards` 是**跨切面**守卫：A-1090 新加的 `if (!api) { return; }`
 *  属于 A-1019 ④「取值后必须有 null 守卫」那一族 —— 我第一版把它并进复合条件
 *  `if (!act || !choice || !api?.chat?.stream …)`：第二层带了 `?.`、**第一层没带**
 *  ⇒ `api` 为 undefined 时**条件自己就抛** TypeError ⇒ 既不算守卫、本身就违规
 *  ⇒ preload 未就绪时整页白屏（全量 vitest 当场抓到）。 */
const SPECS = [
  "tests/core-ts/a1090-rescue.spec.ts",
  "tests/core-ts/a1019-guards.spec.ts",
  "tests/core-ts/context-loop.spec.ts",
  "tests/gui/stream-errors.spec.ts",
  "tests/core-ts/resume-outcome.spec.ts",
];
const LOOP = "core-ts/src/services/context_loop.ts";
const MAIN = "gui/src/main/index.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const STREAMERR = "gui/src/renderer/pages/streamErrors.ts";
const IPC = "gui/src/shared/ipc.ts";
/** A-1019 ④ 的判据（M19 的**捕获者**，也是 M20~M22 的**被变异对象**）。 */
const A1019SPEC = "tests/core-ts/a1019-guards.spec.ts";
const TARGETS = [LOOP, MAIN, PANEL, STREAMERR, IPC, A1019SPEC];
/** `--apply` 模式下存放逐字节备份与 manifest 的临时目录（`--restore` 后整目录删除） */
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1090");

const MUTATIONS = [
  /* ── ①② 三态判据本体 ──────────────────────────────────────────── */
  {
    name: "1 「没查」被写成「查过没有」（引擎侧替一个没做过的检查背书）",
    file: LOOP,
    mutate: (t) => sub(
      t,
      "    return \"这次**没有检查**其它模型的窗口（本地判定只算了自己的账）—— 换模型这条路未必走不通，可在模型选择器里自己试一个窗口更大的。\";",
      "    return \"已查过当前可用模型：没有窗口更大的候选 —— 换模型这条路走不通，请开一个新会话。\";",
    ),
  },
  {
    name: "2 平手判据退回裸 id（与调用方去重键脱钩 ⇒ 建议的模型看着随机）",
    file: LOOP,
    mutate: (t) => sub(t, "      const ka = a.choice ?? a.id;", "      const ka = a.id;"),
  },

  /* ── ③~⑧ 主进程：候选必须自带可写入的选择串 ─────────────────────── */
  {
    name: "3 候选没把选择串带进列表（渲染层永远拿不到 choice ⇒ 按钮切不过去）",
    file: MAIN,
    mutate: (t) => sub(
      t,
      "      candidates.push({ id: mid, label: label && label.trim() ? label.trim() : mid, cap: c, choice: ch });",
      "      candidates.push({ id: mid, label: label && label.trim() ? label.trim() : mid, cap: c });",
    ),
  },
  {
    name: "4 去重退回裸 id（吞掉另一个供应商下的同名模型 ⇒ 少给一条出路）",
    file: MAIN,
    mutate: (t) => sub(
      t,
      "      if (!mid || !ch || c <= 0 || seen.has(ch)) { return; }",
      "      if (!mid || c <= 0 || seen.has(mid)) { return; }",
    ),
  },
  {
    name: "5 供应商候选退回裸 id 当选择串（切到一个不存在的模型 = 静默失败）",
    file: MAIN,
    mutate: (t) => sub(
      t,
      "        add(id, key ? `${key} · ${id}` : id, (m as { context_window?: number }).context_window, key ? `api:${key}:${id}` : \"\");",
      "        add(id, key ? `${key} · ${id}` : id, (m as { context_window?: number }).context_window, id);",
    ),
  },
  {
    name: "6 需求量未知却返回 null（把「不知道要多大」说成「查过没有」）",
    file: MAIN,
    mutate: (t) => sub(
      t,
      "  if (!Number.isFinite(requiredTokens) || requiredTokens <= 0) { return undefined; }",
      "  if (!Number.isFinite(requiredTokens) || requiredTokens <= 0) { return null; }",
    ),
  },
  {
    name: "7 解析失败返回 null（把「没查成」说成「查过没有」）",
    file: MAIN,
    mutate: (t) => sub(
      t,
      "    console.warn(\"[gui:main] 可救模型解析失败 —— 按「没查成」如实告知（不说成「查过没有」）:\", e);\n    return undefined;",
      "    console.warn(\"[gui:main] 可救模型解析失败:\", e);\n    return null;",
    ),
  },
  {
    name: "8 拒发路径不回带结构化候选（只剩一句文案 ⇒ 渲染层点不了）",
    file: MAIN,
    mutate: (t) => sub(t, "          ...(rescue ? { rescueModel: rescue } : {}),", ""),
  },

  /* ── ⑨~⑮ 渲染层接线 ───────────────────────────────────────────── */
  {
    name: "9 切模型不 await 写盘（重发时主进程仍按旧模型算窗口 ⇒ 必然同样超限）",
    file: PANEL,
    mutate: (t) => sub(t, "      await onModelChange?.(choice);", "      void onModelChange?.(choice);"),
  },
  {
    name: "10 failReconnect 丢掉 keepBanner（红字横幅被同一批 setState 清成 null）",
    file: PANEL,
    mutate: (t) => sub(t, "    resetStreamUI({ keepBanner: true });", "    resetStreamUI();"),
  },
  {
    name: "11 复位函数无条件清横幅（keepBanner 口子形同不存在）",
    file: PANEL,
    mutate: (t) => sub(t, "    if (!opts?.keepBanner) { setStreamErrorBanner(null); }", "    setStreamErrorBanner(null);"),
  },
  {
    name: "12 压缩结论丢掉 rescueModel（反应式路径拿不到按钮）",
    file: PANEL,
    mutate: (t) => sub(t, "        ...(res?.rescueModel ? { rescueModel: res.rescueModel } : {}),", ""),
  },
  {
    name: "13 `CompressOutcome` 类型丢字段（赋值处静默丢弃）",
    file: PANEL,
    mutate: (t) => sub(t, "  rescueHint?: string;\n  rescueModel?: RescueModel;\n};", "  rescueHint?: string;\n};"),
  },
  {
    name: "14 按钮文案内联进组件（第二个产地 ⇒ 改一处漂移一处）",
    file: PANEL,
    mutate: (t) => sub(t, "            {rescueSwitchLabel(rescueAction.model)}", "            {`切到 ${rescueAction.model.id} 并继续本轮`}"),
  },
  {
    name: "15 按钮不挂点击动作（点了没反应 = 用户以为工具坏了）",
    file: PANEL,
    mutate: (t) => sub(t, "            onClick={() => { void handleRescueSwitch(); }}", "            onClick={() => { undefined; }}"),
  },

  /* ── ⑯~⑱ 文案与动作**说反话** ──────────────────────────────────── */
  {
    name: "16 按钮说「重发」（动作续的是本轮，用户消息不会再发一遍）",
    file: STREAMERR,
    mutate: (t) => sub(t, "  return `切到 ${name}${cap} 并继续本轮`;", "  return `切到 ${name}${cap} 并重发本条`;"),
  },
  {
    name: "17 悬停说明不再点明「不会重复发送」（用户只能自己猜会不会重复）",
    file: STREAMERR,
    mutate: (t) => sub(
      t,
      "export const RESCUE_SWITCH_TITLE =\n  \"切换模型后接着本轮继续 —— 你已经发出的消息不会重复发送；输入框里正在写的内容也不会被动。\";",
      "export const RESCUE_SWITCH_TITLE = \"切换模型后继续。\";",
    ),
  },
  {
    name: "18 跨进程契约手抄形状（主进程加字段时渲染层静默少用一个字段）",
    file: IPC,
    mutate: (t) => sub(t, "  rescueModel?: RescuableModel;", "  rescueModel?: { id: string; label?: string; cap: number; choice?: string };"),
  },

  /* ── ⑲ 新入口的 null 守卫（A-1019 ④ 那一族） ────────────────────
     判据在 `a1019-guards.spec.ts`。它只看「**条件里有没有 `api.` 裸访问**」：
     有 ⇒ 这行自己就会崩（`api` 为 undefined 时 `api.chat` 抛 TypeError）⇒ 既违规、又不算守卫；
     没有且提到 api ⇒ 才算守卫。把守卫**并进复合条件**（`!act || … || !api.chat?.stream`）
     就等于没写 —— `!api?.` 那个形态它一个都不认。
     锚点必须带上下一行 `const choice = act?.model.choice;` 才唯一：
     `if (!api) { return; }` 在本文件有 8 处（同名多产地，裸锚点会被 check-mut-anchors 判"不唯一"，
     且 `String.replace` 只改第一处 = 永远删不到这一处）。 */
  {
    name: "19 新入口的 null 守卫被删（preload 未就绪 ⇒ 取值点后裸访问 ⇒ 整页白屏）",
    file: PANEL,
    mutate: (t) => sub(t, "    if (!api) { return; }\n    const choice = act?.model.choice;", "    const choice = act?.model.choice;"),
  },

  /* ── ⑳~㉓ A-1019 ④ **判据本身**（M19 的捕获者）────────────────────────
     这四条为什么住在本文件：M19 第一次实跑时**没被捕获** —— 顺藤摸到
     A-1019 ④ 的检测器有空转（逐行正则版：注释续行被当成代码；手写扫描器版：
     不认识正则字面量 / JSX，状态机在 ChatPanel.tsx 上**静默偏掉**）⇒ 改用 TypeScript
     编译器的 AST 之后，必须给"修好的检测器"配能弄红它的变异，
     否则那 7 条自检就是没人验证的断言。 */
  {
    name: "20 `bareChain` 的 `?.` 判据被删（链尾 `.catch` 被当裸访问 ⇒ 二十来处合法写法误报）",
    file: A1019SPEC,
    mutate: (t) => sub(
      t,
      "    if (ts.isPropertyAccessExpression(cur) && cur.questionDotToken !== undefined) { return false; }\n    if (ts.isElementAccessExpression(cur) && cur.questionDotToken !== undefined) { return false; }",
      "    if (false) { return false; }",
    ),
  },
  {
    name: "21 裸访问判据不再在作用域边界停下（守卫写在回调/函数体里的 5 处合法写法被误报）",
    file: A1019SPEC,
    mutate: (t) => sub(
      t,
      "    if (ts.isFunctionLike(x)) { return; }                 // 函数体一律单独扫（含入口本身）\n    if (x !== node && ts.isBlock(x)) { return; }          // 块单独扫",
      "    if (false) { return; }",
    ),
  },
  {
    name: "22 判据丢掉 guarded 闸门（守卫生效之后的合法调用也算违规 ⇒ 狼来了，下一个人会删掉守卫）",
    file: A1019SPEC,
    mutate: (t) => sub(
      t,
      "      if (guarded) { return; }        // 已确证 ⇒ 本列表及其嵌套作用域都不会再有裸访问",
      "      if (false) { return; }",
    ),
  },
  {
    name: "23 `truthyProvesApi` 恒假（`&&` 型守卫分支里的合法调用被误报）",
    file: A1019SPEC,
    /* ⚠️ 锚点必须带上一行做上下文：`return isApiChain(u, name);` 在 `falsyWhenApiMissing`
       里也有一份，孤零零地打它只会改到**同族的第一处**（后缀陷阱）。
       ⚠️ 注释写在 `mutate:` 之前 —— 夹在 `sub(t,` 与锚点之间会让核验器认不出这条锚点
       （落到「未核验」= 没人核验）。 */
    mutate: (t) => sub(
      t,
      "  if (o) { return truthyProvesApi(o[0], name) && truthyProvesApi(o[1], name); }\n  return isApiChain(u, name);",
      "  if (o) { return truthyProvesApi(o[0], name) && truthyProvesApi(o[1], name); }\n  return false;",
    ),
  },
];

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const abs = (rel) => join(ROOT, rel);

/** 任一份 spec 变红即算捕获 —— **逐份跑**（同一次跑多份会有"没被收集却仍报绿"的假绿，见文件头）。 */
function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
    if (r.status !== 0) { return { ok: false, spawnBlocked: false, spec }; }
  }
  return { ok: true, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

/* ── `--apply` / `--restore`：给"禁止 node→node 孙进程"的环境留的两半 ── */
if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);           // **字节**备份
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    console.log(`  file=${m.file}  备份=${join(SAVE_DIR, `${basename(m.file)}.orig`)}`);
    process.exit(0);
  }
  /* restore */
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
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

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* 中断即还原：`finally` 在 Ctrl+C 下不展开 —— 没这道保险，变异会留在源码里，
   下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿（2026-09-23 实测踩到）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
  console.error("请改用 --apply / --restore + shell 循环（命令见本文件头部注释）。");
  process.exit(1);
}
if (!base.ok) {
  console.error(`基线未通过（${base.spec}）—— 先修好测试再跑变异。`);
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1090")) { process.exit(1); }

/** 引号自伤自检：剥注释后仍出现「CJK + ASCII 双引号 + CJK」才算坏。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.split("\n").filter((l) => /[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(l)).map((l) => l.trim().slice(0, 100));
}
for (const rel of ["gui/scripts/mut-a1090-rescue.mjs"]) {
  const bad = quoteSelfHarm(readFileSync(abs(rel), "utf8"));
  if (bad.length) {
    console.error(`引号自伤自检失败（${rel}）：`);
    for (const b of bad) { console.error(`  - ${b}`); }
    process.exit(1);
  }
}
console.log("行尾检测器自检 + 引号自伤自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.ok) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  restoreAll();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) {
  console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}（${leftovers.join(", ")}）`);
  process.exit(1);
}
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
