#!/usr/bin/env node
/**
 * gui/scripts/mut-a1154-drag-baseline.mjs — A-1154 守卫的变异验证。
 *
 * 本轮用**真 App CDP 端到端取证**抓到 4 条 A-1153 没覆盖的根因（都在"拖动"路径上）。
 * 每条都要证明"改坏 ⇒ 守卫变红"，否则守卫是假的（铁律 3）。
 *
 * | # | 变异点 | 用户现象 | 真机证据 |
 * |---|---|---|---|
 * | M1 | `handleRightbarResize` 的 `startWidth` 改回 `rightWidthRef.current` | 第 1 轮拖动完全无响应 | `probe-drag-robust` 第 1 轮 `712 → 712` |
 * | M2 | `handleSidebarResize` 的 `startWidth` 改回 `sidebarWidthRef.current` | 左栏同样不跟手 | 同源 |
 * | M3 | 去掉 resize 钳制 effect（`if (!rightCustom) return;` 改条件） | 窗口变化后不再自适应 / 基准错位 | 上限随窗口变，state 停旧值 |
 * | M4 | CSS 去掉 `body.slime-dragging { user-select: none }` | 拖动头 140ms 拖出蓝色选区（闪烁杂讯） | `_vis-drag` 截图 + CSS 规则 |
 * | M5 | CSS 去掉 `body.slime-dragging { cursor: col-resize }` | 拖动中光标跳变 | 同上 |
 * | M6 | `GEOM_SYNC_NEVER_MOUNT_FRAMES` 的有界判据删掉（改成永真等待） | `slime-freezing` 永久残留 | `probe-raf-hidden`（hidden 时 rAF 停摆会掩盖它） |
 * | M7 | `startFloatGeometryFade` 的 done 不摘 `--slime-freeze-w` | 聊天区被钉死在旧宽（成对写/摘破缺） | A-1152 实测 |
 * | M8 | `mark()` 的阶段定时器不存 `dragPhaseTimerRef`（改回裸 setTimeout） | 短促拖拽松手后才挂 `slime-resizing`（闪烁） | `probe-realinput-drag` |
 * | M9 | `endChatFreeze` 不取消阶段定时器 | 同上（残留路径） | 同上 |
 * | M10 | `mark()` 的阶段定时器去掉"本轮已结束则作废"校验 | renderer 卡顿时延迟回调仍污染 | 同源 |
 *
 * ⚠️⚠️ A-1190：M8/M10 的**锚点**已随"起表点从两个 resizer 起点搬进 `mark()`"一起迁移
 *    （不变量本身一字未变：句柄要存 ref、到点要校验本轮是否已结束）。
 *    "拖动起点不许淡出"这条新不变量由 `mut-a1190-chat-fade.mjs` 单独覆盖（它需要 a1152 的守卫）。
 *
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256；带 SIGINT 保险（`_mut-eol` 提供）。
 * ⚠️ 锚点用 `sub()`（行尾无关）—— 本仓行尾是混的，裸 `\n` 多行锚点会静默失效。
 * ⚠️ 变异体必须**保持语法合法**（要"停用"某声明就改值/加后缀，别删行）——
 *    否则 batch 会把"编译不过"算成"抓住了"。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1154-drag-baseline.mjs --list
 *   node gui/scripts/mut-a1154-drag-baseline.mjs --apply 3
 *   node gui/scripts/mut-a1154-drag-baseline.mjs --restore
 *   全量（本环境禁 node→node 孙进程）：
 *     bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1154-drag-baseline.mjs \
 *       tests/core-ts/a1154-drag-baseline.spec.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1154-drag-baseline.spec.ts"];

const F_APP = "gui/src/renderer/App.tsx";
const F_CSS = "gui/src/renderer/index.css";
const TARGETS = [F_APP, F_CSS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1154");

const MUTATIONS = [
  /* ── ① 拖动基准必须取实测宽 ─────────────────────────────────────── */
  {
    name: "1 右栏 startWidth 改回 rightWidthRef（第 1 轮拖动无响应）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    const startWidth = asideEl ? asideEl.getBoundingClientRect().width : rightWidthRef.current;",
      "    const startWidth = rightWidthRef.current;",
    ),
  },
  {
    name: "2 左栏 startWidth 改回 sidebarWidthRef",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    const startWidth = asideEl ? asideEl.getBoundingClientRect().width : sidebarWidthRef.current;",
      "    const startWidth = sidebarWidthRef.current;",
    ),
  },
  {
    name: "3 落 state 前不再 Math.round（浮点污染持久层）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      w = Math.round(w);",
      "      w = w;",
    ),
  },

  /* ── ② 持久化 px 宽度必须收敛 ───────────────────────────────────── */
  {
    name: "4 去掉 resize 钳制（条件改成永假，effect 空转）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    if (!rightCustom) { return; }",
      "    if (!rightCustom || true) { return; }",
    ),
  },

  /* ── ③ slime-dragging 必须给全拖动期语义 ───────────────────────── */
  {
    name: "5 CSS 去掉拖动期的 user-select: none（拖出选区 = 闪烁杂讯）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "body.slime-dragging {\n  cursor: col-resize !important;\n  user-select: none;\n  -webkit-user-select: none;\n}",
      "body.slime-dragging {\n  cursor: col-resize !important;\n}",
    ),
  },
  {
    name: "6 CSS 去掉拖动期的 col-resize 光标",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "body.slime-dragging {\n  cursor: col-resize !important;\n  user-select: none;\n  -webkit-user-select: none;\n}",
      "body.slime-dragging {\n  user-select: none;\n  -webkit-user-select: none;\n}",
    ),
  },

  /* ── ④ 几何 done 的"从未挂载"必须有界：**已退休**（A-1170）─────────────
     本条锚的是 A-1154 时期**测量驱动**引擎的 `neverMount` 判据。
     A-1162 已把引擎整体重写成**时间驱动**（收工判据只有 `u >= 1`）——
     "对象从未挂载"不再参与收工，rAF 也必然在 `GEOM_FADE_MS` 内停
     ⇒ 该缺陷形态（rAF 死循环 / 临时类永久残留）不可能再发生。
     ⚠️ 守卫侧同样已迁移：`a1154-drag-baseline.spec.ts` ④ 段那条断言
     **已被替换成**新形态（spec 里写明"这条**替换** A-1154 ④ 的 NEVER_MOUNT 守卫"），
     所以旧变异必须一起退场，否则只会永久报"未命中"（假警报）。 */
  {
    /* ⚠️ 必须 `subAll`（改**全部** 3 处 removeProperty）而不是 `sub`（只改第一处）：
       `startFloatGeometryFade` 的函数体里同时有"新周期起头的自己摘"（2966 行附近）
       与"几何 done 里摘"（3016 行附近）**两处** —— 只改一处时另一处仍满足守卫断言
       ⇒ 变异"存活"但其实是**变异点不完整**（铁律 9/30：改一个点没碰到被判据锚定的那个不变量）。
       替换体保持语法合法（改属性名而不是删行）。 */
    name: "7 几何 done 不摘 --slime-freeze-w（成对写/摘破缺 ⇒ 聊天区被钉死）",
    file: F_APP,
    /* ⚠️ 命中多处（新周期起头的自己摘 + 几何 done 里摘）⇒ 声明 `all: true`，
       否则 `check-mut-anchors` 每次跑都报「不唯一」。 */
    all: true,
    mutate: (t) => subAll(
      t,
      'removeProperty("--slime-freeze-w")',
      'removeProperty("--slime-freeze-w-DISABLED")',
    ),
  },

  /* ── ⑤ 淡出阶段定时器可取消 + 到点校验 ─────────────────────────────
     ⚠️⚠️ A-1190 重锚：这组（M8/M10）原来锚在**两个 resizer 起点**那段代码上；
     本轮把"起阶段定时器"整个搬进了 RO 的 `mark()`（淡出的唯一触发源，
     见 `a1190-chat-fade.spec.ts` 与 App.tsx 里那段注释）⇒ 锚点随之迁移。
     **不变量本身一字未变**：句柄要存 ref、到点要校验"本轮是否已结束"。 */
  {
    name: "8 mark() 的阶段定时器不存句柄（改回裸 setTimeout ⇒ 松手后才挂类）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "        dragPhaseTimerRef.current = window.setTimeout(() => {\n          dragPhaseTimerRef.current = 0;",
      "        window.setTimeout(() => {\n          void dragPhaseTimerRef.current;",
    ),
  },
  {
    name: "9 endChatFreeze 不取消阶段定时器（残留路径）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    window.clearTimeout(dragPhaseTimerRef.current);\n    dragPhaseTimerRef.current = 0;\n    // ⚠️ A-1190：本轮已恢复 ⇒ 取消\"宽度停住 ⇒ 恢复\"定时器（见 chatSettleTimerRef）。\n    window.clearTimeout(chatSettleTimerRef.current);\n    chatSettleTimerRef.current = 0;\n    requestAnimationFrame(() => {\n      document.body.classList.remove(\"slime-fading\");\n    });",
      "    // ⚠️ A-1190：本轮已恢复 ⇒ 取消\"宽度停住 ⇒ 恢复\"定时器（见 chatSettleTimerRef）。\n    window.clearTimeout(chatSettleTimerRef.current);\n    chatSettleTimerRef.current = 0;\n    requestAnimationFrame(() => {\n      document.body.classList.remove(\"slime-fading\");\n    });",
    ),
  },
  {
    name: "10 mark() 的阶段定时器去掉「本轮已结束则作废」校验（延迟回调仍会污染）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "          if (!document.body.classList.contains(\"slime-fading\")) { return; }\n          document.body.classList.add(\"slime-resizing\");",
      "          document.body.classList.add(\"slime-resizing\");",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

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
    catch (e) { console.error(`锚点未命中（变异体没落地）：${m.name}
    ${e.message}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
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

/* ── 全量模式：本环境禁 node→node 孙进程 ⇒ 提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error(`  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1154-drag-baseline.mjs \\`);
console.error(`    ${SPECS.join(" ")}`);
process.exit(1);
