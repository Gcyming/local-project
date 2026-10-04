#!/usr/bin/env node
/**
 * gui/scripts/mut-a1190-chat-fade.mjs — A-1190 守卫的变异验证。
 *
 * ## 这一轮改的是什么（用户原话）
 * 首轮：「现在的消失判定是**一点击侧边栏的边缘，还没有拖拽就消失**，这不对，改成只有发生
 *  **实质性比例变化**才会消失。还有，现在中间的渐入渐出都是与侧边栏**错开**设计的，即刻意的
 *  错开侧边栏与聊天页的消失、出现时间，这不对……改成**同步**的吧。」
 *   ⇒ ① 淡出触发源从"按下"改成"宽度真的变了"；② 时长/缓动与侧边栏同源。
 * 第二轮：「我上面说的问题还剩一个，**侧边栏与中间对话栏的动画还是没同步**，我点击折叠、展开
 *  按钮时，二者**仍是交错的**。」
 *   ⇒ ② 的结构根因：`slime-fading` 的淡入只能发生在"宽度停住"（≈ `SIDEBAR_WIDTH_MS`）之后，
 *     淡入自己又要一整个 `CHAT_FADE_MS` ⇒ 总时长恒为 **2 × `SIDEBAR_WIDTH_MS`**（真机实测
 *     侧边栏 486ms 到位 vs 聊天页 opacity 533→1020ms 才复位）。正解 = 把淡入搬进同一段
 *     （"凹陷"，`startChatDip`），窗口逐字取自侧边栏**内容**自己的 `LEFT_FADE_*`。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 用户现象（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 两个 resizer 起点又 `classList.add("slime-fading")` | 点一下分栏边缘（还没拖）聊天页就淡出 | a1190 ① / a1152 ⑫ |
 * | 2 | RO 的 `w === lastW` 短路改成永假 | 消息流入（高度变化）也触发淡出（在看的内容被隐藏） | a1190 ①b |
 * | 3 | `CHAT_FADE_MS` 从 `SIDEBAR_WIDTH_MS` 改成手抄 `500` | 改一边忘一边 ⇒ 半拍错位 | a1190 ② |
 * | 4 | `CHAT_DIP_IN_AT_MS` 退化成手抄 `200` | 侧边栏内容窗改了、凹陷窗口不动 ⇒ 静默不同拍 | a1190 ②b |
 * | 5 | `CHAT_FADE_DRAG_MS` 抬到 `600` | 拖动时「跳过布局」被推迟到几何时长之后（长会话掉帧） | a1190 ⑥b |
 * | 6 | `LEFT_FADE_COLLAPSE_HI` 拉到 `0.9` | 凹陷淡出窗超过淡入起点 ⇒ 先暗后亮来回抖（不同步） | a1190 ⑧ |
 * | 7 | CSS 两个方向变量**对调** | 凹陷变成"慢淡出 + 快淡入"（135/275 反过来，半拍错位） | a1190 ⑫ |
 * | 8 | 没人写 `--chat-fade-out-dur` | **静默失效**：CSS 永远走 fallback ⇒ 凹陷退化成 500+500 | a1190「变量真的被写」 |
 * | 9 | `.chat-scroll` 缓动改 `linear`（保留 var 时长） | 时长同源了、曲线仍不同 ⇒ 节奏依旧错开 | a1190 ③ |
 * | 10 | `mark()` 的恢复窗从 `CHAT_SETTLE_MS` 改回 `150` 魔数 | 恢复又比侧边栏晚起步（"刻意错开"来源） | a1190 ④ |
 * | 11 | `mark()` 去掉 `slime-dragging` 短路 | 拖动中途一次停顿就淡入、再动又淡出（闪） | a1190 ⑤ |
 * | 12 | `mark()` 去掉"拖动短时长 / 几何同源时长"分流 | 拖动路径用 500ms ⇒ A-1152 跳过布局推迟（掉帧） | a1190 ⑥ |
 * | 13 | `mark()` 删掉"几何动画 ⇒ `startChatDip()`"分流 | 点按钮退回三段式（总时长 2× = 用户报的「错开」） | a1190 ⑦ |
 * | 14 | `mark()` 把"让位"与"分流"两条判据**顺序调反** | 过渡期每帧重启凹陷 ⇒ 摘类定时器到不了点（一直黑 + 尾巴） | a1190 ⑦ |
 * | 15 | `startChatDip` 去掉"已在飞就返回"短路 | RO 逐帧重置摘类定时器 ⇒ 内容一直黑到宽度停住 | a1190 ⑩ |
 * | 16 | 两个 `animate*Sidebar` 不再置位几何动画 | 点按钮聊天页仍走三段式（用户第二轮的报障） | a1190 ⑨ |
 * | 17 | `endChatFreeze` 不再清凹陷定时器 | 滞留的摘类定时器把下一轮淡出腰斩 | a1190 ⑪ |
 * | 18 | 两个 resizer 起点都不再作废凹陷（`cancelChatDip`） | 上一次点按钮的凹陷在拖拽途中把文本放出来 | a1190 ⑨ |
 *
 * ⚠️ `name` 的**开头数字必须 == 它在数组里的位置序号**（1..17）——
 *    `check-mut-anchors.mjs` 会逐条核对「name 序号 ↔ 位置序号」，不一致就报
 *    「`--apply N` 变异的不是它（跑出来会是一条假绿）」。这里按位置顺序编号，
 *    与上表的 `#` 一一对应。
 *
 * ⚠️ 全部锚点走 `sub` / `subAll`（行尾自适应）—— 本仓行尾是混的，裸 `\n` 多行锚点会静默失效。
 * ⚠️ 变异体必须**保持语法合法**（"停用"某声明就改值/加后缀，不删行）——
 *    否则 batch 会把"编译不过"算成"抓住了"（判据要求退出码 ≠0 **且** 有 `Tests … failed` 行）。
 *    ⚠️ 例外：M13 是**删一整行**（含行尾），删完 `mark()` 依旧是合法语句序列（前后都有完整语句）。
 * ⚠️ `subAll` 的锚点（M1 / M16）必须写 `all: true`，否则 `check-mut-anchors` 会持续报
 *    「不唯一（无法确定改的是哪一处）」。
 * ⚠️ 嵌套 `sub(sub(t, A, B), C, D)`（M7 / M8 / M9）—— `check-mut-anchors` 的
 *    `sub(?:All)?\(\s*t\s*,` 会命中**最内层**那条（即 A），核验的就是主锚点，符合预期。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/* ⚠️ 判据 spec 的**唯一产地**：a1190 是本体；a1152 ⑫ 钉着"两个 resizer 起点不许挂 fading"
   （M1 的两条判据之一）。别在 batch 命令行手写清单 —— 漏一份会让变异"假存活却不报错"。 */
const SPECS = [
  "tests/core-ts/a1190-chat-fade-sync.spec.ts",
  "tests/core-ts/a1152-float-stability.spec.ts",
];

const F_APP = "gui/src/renderer/App.tsx";
const F_CSS = "gui/src/renderer/index.css";
const TARGETS = [F_APP, F_CSS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1190");

/* 两处 `.chat-scroll` 过渡声明（**两个方向各一个变量**，A-1190② 之后逐字不同）。
   ⚠️ 常驻规则（第 2011 行）= **淡入**方向（`--chat-fade-in-dur`）；
      `body.slime-fading` 规则（第 2040 行）= **淡出**方向（`--chat-fade-out-dur`）。
      判据是 `transition` 取"变化后样式"里解析出来的声明 ⇒ 对调就是"慢淡出 + 快淡入"。 */
const CSS_IN_TRANS = "  transition: opacity var(--chat-fade-in-dur, 500ms) cubic-bezier(0, 0, 0.2, 1);";
const CSS_OUT_TRANS = "  transition: opacity var(--chat-fade-out-dur, 500ms) cubic-bezier(0, 0, 0.2, 1);";

const MUTATIONS = [
  /* ── ① 淡出的触发源必须唯一（= 宽度真的变了）──────────────────────── */
  {
    name: "1 两个 resizer 起点又挂 slime-fading（点一下边缘就淡出）",
    file: F_APP,
    all: true,
    mutate: (t) => subAll(
      t,
      '    document.body.classList.add("slime-dragging");',
      '    document.body.classList.add("slime-dragging");\n    document.body.classList.add("slime-fading");',
    ),
  },
  {
    name: "2 RO 的「宽度真的变了」短路改成永假（消息流入也淡出）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      if (w === lastW) { return; }",
      "      if (false) { return; }",
    ),
  },

  /* ── ② 时长必须与侧边栏宽度过渡同源（三段式 + 凹陷）─────────────── */
  {
    name: "3 CHAT_FADE_MS 从 SIDEBAR_WIDTH_MS 改成手抄 500（同源破缺）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "const CHAT_FADE_MS = SIDEBAR_WIDTH_MS;",
      "const CHAT_FADE_MS = 500;",
    ),
  },
  {
    name: "4 CHAT_DIP_IN_AT_MS 退化成手抄 200（凹陷窗口与侧边栏内容窗脱钩）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "const CHAT_DIP_IN_AT_MS = Math.round(SIDEBAR_WIDTH_MS * LEFT_FADE_LO);",
      "const CHAT_DIP_IN_AT_MS = 200;",
    ),
  },

  /* ── ⑥b 拖动短时长必须**短于**几何时长 ─────────────────────────── */
  {
    name: "5 CHAT_FADE_DRAG_MS 抬到 600（拖动时「跳过布局」被推迟到几何时长之后）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "const CHAT_FADE_DRAG_MS = 120;",
      "const CHAT_FADE_DRAG_MS = 600;",
    ),
  },

  /* ── ⑧ 凹陷两段必须都落在侧边栏那 500ms 之内 ────────────────────── */
  {
    name: "6 收起窗 LEFT_FADE_COLLAPSE_HI 拉到 0.9（凹陷淡出与淡入起点重叠）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "const LEFT_FADE_COLLAPSE_HI = 0.27;",
      "const LEFT_FADE_COLLAPSE_HI = 0.9;",
    ),
  },

  /* ── ⑫ CSS 两向各一个变量 ──────────────────────────────────────── */
  {
    name: "7 CSS 两个方向变量对调（常驻读 out、挂类读 in ⇒ 凹陷方向半拍错位）",
    file: F_CSS,
    mutate: (t) => sub(
      sub(sub(t, CSS_IN_TRANS, "@@A1190_TMP@@"), CSS_OUT_TRANS, CSS_IN_TRANS),
      "@@A1190_TMP@@",
      CSS_OUT_TRANS,
    ),
  },

  /* ── 静默失效家族：两个变量必须**真的被写** ────────────────────── */
  {
    name: "8 没人写 --chat-fade-out-dur（CSS 永远走 fallback ⇒ 凹陷退化成 500+500）",
    file: F_APP,
    mutate: (t) => sub(
      sub(
        t,
        '        document.body.style.setProperty("--chat-fade-out-dur", `${outDur}ms`);',
        "        void outDur;",
      ),
      '    document.body.style.setProperty("--chat-fade-out-dur", `${CHAT_DIP_OUT_MS}ms`);',
      "    void CHAT_DIP_OUT_MS;",
    ),
  },

  /* ── ③ 缓动必须与侧边栏同源 ────────────────────────────────────── */
  {
    name: "9 .chat-scroll 缓动改 linear（时长同源了、曲线仍不同 ⇒ 节奏错开）",
    file: F_CSS,
    mutate: (t) => sub(
      sub(
        t,
        CSS_IN_TRANS,
        "  transition: opacity var(--chat-fade-in-dur, 500ms) linear;",
      ),
      CSS_OUT_TRANS,
      "  transition: opacity var(--chat-fade-out-dur, 500ms) linear;",
    ),
  },

  /* ── ④⑤⑥ 三段式那条路（拖拽 / 窗口 resize）────────────────────── */
  {
    name: "10 mark() 恢复窗从 CHAT_SETTLE_MS 改回 150 魔数（刻意错开的来源）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      }, CHAT_SETTLE_MS);",
      "      }, 150);",
    ),
  },
  {
    name: "11 mark() 去掉 slime-dragging 短路（拖动中途停顿即闪）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '        if (document.body.classList.contains("slime-dragging")) { return; }\n        endChatFreeze();',
      "        endChatFreeze();",
    ),
  },
  {
    name: "12 mark() 去掉拖动/几何时长分流（拖动也走同源长时长）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '      const outDur = document.body.classList.contains("slime-dragging") ? CHAT_FADE_DRAG_MS : CHAT_FADE_MS;',
      "      const outDur = CHAT_FADE_MS;",
    ),
  },

  /* ── ⑦⑨⑩⑪ 几何动画走「凹陷」（点按钮时两侧栏与聊天页同起同落）─── */
  {
    name: "13 mark() 删掉几何动画分流（点按钮退回三段式 2× 时长）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      if (chatGeomAnimRef.current) { startChatDip(); return; }\n",
      "",
    ),
  },
  {
    name: "14 mark() 把「让位」与「分流」两条判据顺序调反（过渡期逐帧重启凹陷）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      if (chatDipActiveRef.current) { return; }\n      if (chatGeomAnimRef.current) { startChatDip(); return; }",
      "      if (chatGeomAnimRef.current) { startChatDip(); return; }\n      if (chatDipActiveRef.current) { return; }",
    ),
  },
  {
    name: "15 startChatDip 去掉「已在飞就返回」短路（RO 逐帧重置摘类定时器）",
    file: F_APP,
    /* ⚠️ 锚点必须带上**下一行**：`mark()` 里有一条 6 空格缩进的同名短路，
       而"4 空格锚点"是它的**子串**（6 空格的后 4 个 + 文本）⇒ 单行锚点会命中 2 次。 */
    mutate: (t) => sub(
      t,
      "    if (chatDipActiveRef.current) { return; }\n    chatDipActiveRef.current = true;",
      "    if (false) { return; }\n    chatDipActiveRef.current = true;",
    ),
  },
  {
    name: "16 两个 animate*Sidebar 不再置位几何动画（beginChatGeomFade 断线）",
    file: F_APP,
    all: true,
    mutate: (t) => subAll(t, "    beginChatGeomFade();", "    void 0;"),
  },
  {
    name: "17 endChatFreeze 不再清凹陷定时器（cancelChatDip 断线）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    cancelChatDip();\n  }",
      "    void 0;\n  }",
    ),
  },
  {
    name: "18 两个 resizer 起点都不再作废凹陷（拖拽途中文本会露出来）",
    file: F_APP,
    /* 左栏那处无尾注释、右栏那处带尾注释 ⇒ 两条锚点各不相同，用嵌套 sub 一次改掉两处。
       ⚠️ 核验器认的是**最内层** `sub(t, …)` 的锚点（多行、唯一）。 */
    mutate: (t) => sub(
      sub(
        t,
        "    cancelChatDip();\n    const captureEl = e.currentTarget as HTMLElement;",
        "    void 0;\n    const captureEl = e.currentTarget as HTMLElement;",
      ),
      '    cancelChatDip(); // ⚠️ A-1190②：与左栏**逐字同一条** —— 拖拽接管聊天页淡出（理由见 handleSidebarResize）',
      "    void 0; // A-1190②（变异：作废凹陷的调用已删）",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器本身的反空转探针 + 逐条锚点行尾无关性）──
   ⚠️ 这里**不用**裸 `{ … }` 块：`check-mut-anchors.mjs` 用 `/\n\s*\{\n/` 静态切条目，
   行首一个裸 `{` 会被当成**多出来的一条变异** ⇒ 报「静态切出 18 条 vs 行首 name 字段 17 个」
   的序号错位（实测踩到）。写成顶层语句即可，语义完全一样。 */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error(`  - ${b}`); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1190")) { process.exit(1); }

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

/* ── 全量模式：本环境禁 node→node 孙进程 ⇒ 提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1190-chat-fade.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
/* 断言 TARGETS 与文件清单一致（防止将来加了目标文件忘更新） */
if (TARGETS.length !== 2) { process.exit(1); }
process.exit(1);
