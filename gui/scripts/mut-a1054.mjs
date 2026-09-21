#!/usr/bin/env node
/**
 * gui/scripts/mut-a1054.mjs — A-1054 守卫（tests/core-ts/a1054-guards.spec.ts）的变异验证。
 *
 * 三处修复各自有"下一个人顺手就会写回去、而且全都不报错"的退化形态，本脚本逐条复现：
 *
 *  ① 会话加载慢（懒挂载）：闸门恒真 / 收起即卸载 / 切分挪到闸门之前 —— 三者都**不会报错**，
 *     只是白工回来（或 A-1015 的收起动画静默退化成跳变）。
 *  ② 品牌图标：`S` 字面量回填 / 图标改从别处导入（"改一处、漏一处"的老病）/
 *     CSS 里加回文字样式（误导下一个人）。
 *  ③ 上下文口径：agnes / note 写回 `524288`（界面读成 524K）；把"上游不回传价目"
 *     说成"失败"（用户于是永远去重修探针）。
 *
 * ⚠️ 纪律（与 mut-a1053 同源）：
 *   - 快照 / 还原一律走**字节**（Buffer），不做任何文本往返；
 *   - 每条变异都要求**文本确实变了**（`out !== text`）—— 否则是"变异没命中"，
 *     那种情况下守卫"仍绿"毫无意义（假阴性会被误读成"守卫没锁住"）；
 *   - 全程结束做**字节级**还原复核。
 *
 * 用法：node gui/scripts/mut-a1054.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = [
  "tests/core-ts/a1054-guards.spec.ts",
  "tests/core-ts/a1054-queue.spec.ts",
  "tests/core-ts/a1054-livestatus.spec.ts",
];

const GATE = "gui/src/renderer/pages/reasoningGate.ts";
const CHAT = "gui/src/renderer/pages/ChatPanel.tsx";
const APP = "gui/src/renderer/App.tsx";
const CSS = "gui/src/renderer/index.css";
const CAPS = "shared/gen/model-capabilities.ts";
const LIVE = "gui/src/renderer/pages/liveStatus.ts";
const QUEUE = "gui/src/renderer/pages/instructionQueue.ts";
const INSERT = "gui/src/renderer/insertModeToggle.ts";

const FILES = [GATE, CHAT, APP, CSS, CAPS, LIVE, QUEUE, INSERT];

/** 单次替换：命中即返回，未命中返回原串（调用方会用"必须变过"把它挡下来）。 */
const sub = (text, from, to) => (text.includes(from) ? text.replace(from, to) : text);

/** 替换 `key: "<name>"` 之后出现的**第一个** `context: 512000`（避开同名值互相干扰）。 */
function setFamilyContext(text, familyKey, value) {
  const anchor = `key: "${familyKey}"`;
  const a = text.indexOf(anchor);
  if (a < 0) { return text; }
  const b = text.indexOf("context: 512000", a);
  if (b < 0) { return text; }
  return text.slice(0, b) + `context: ${value}` + text.slice(b + "context: 512000".length);
}

/** 在 `ReasoningSection` 段内做替换（避免命中文件别处的同名符号）。 */
function inSection(text, from, to) {
  const a = text.indexOf("const ReasoningSection = React.memo(");
  const b = text.indexOf("const AssistantMessage = React.memo(", a + 1);
  if (a < 0 || b < 0) { return text; }
  const seg = text.slice(a, b);
  if (!seg.includes(from)) { return text; }
  return text.slice(0, a) + seg.replace(from, to) + text.slice(b);
}

const MUTATIONS = [
  /* ── ① 懒挂载闸门 ───────────────────────────────────────────────── */
  {
    name: "R1 shouldMountBody 恒 true → 收起态也挂正文，88ms / 1090 次挂载的白工全回来",
    file: GATE,
    mutate: (t) => sub(t,
      "export function shouldMountBody(open: boolean, everMounted: boolean): boolean {\n  return open || everMounted;\n}",
      "export function shouldMountBody(open: boolean, everMounted: boolean): boolean {\n  return true;\n}"),
  },
  {
    name: "R2 shouldMountBody 丢掉 everMounted → 收起即卸载，A-1015 的收起动画没有可插值元素",
    file: GATE,
    mutate: (t) => sub(t,
      "  return open || everMounted;\n}",
      "  return open;\n}"),
  },
  {
    name: "R3 hasReasoningData 的 `> 0` 全改成 `>= 0` → 每条消息都判有数据，懒挂载当场失效",
    file: GATE,
    mutate: (t) => {
      const a = t.indexOf("export function hasReasoningData");
      const b = t.indexOf("\n}", a);
      if (a < 0 || b < 0) { return t; }
      const body = t.slice(a, b);
      if (!body.includes("> 0")) { return t; }
      return t.slice(0, a) + body.replace(/> 0/g, ">= 0") + t.slice(b);
    },
  },
  {
    name: "R4 isOpenClass 丢掉 readyToOpen → 首次展开那一帧直接是终态，过渡不播（生硬跳变）",
    file: GATE,
    mutate: (t) => sub(t,
      "export function isOpenClass(open: boolean, readyToOpen: boolean): boolean {\n  return open && readyToOpen;\n}",
      "export function isOpenClass(open: boolean, readyToOpen: boolean): boolean {\n  return open;\n}"),
  },
  {
    name: "R5 isOpenClass 只认 readyToOpen → 收起时仍带 is-open，高度被 1fr 顶住、收起动画不塌",
    file: GATE,
    mutate: (t) => sub(t,
      "  return open && readyToOpen;\n}",
      "  return readyToOpen;\n}"),
  },
  {
    name: "R6 首帧两个字段一起置位 → 首次展开没有中间帧（两帧提交被「顺手简化」掉）",
    file: GATE,
    mutate: (t) => sub(t,
      "  if (!everMounted) { return { everMounted: true, readyToOpen: false }; } // 第 1 帧：挂正文，不展开",
      "  if (!everMounted) { return { everMounted: true, readyToOpen: true }; }"),
  },
  {
    name: "R7 收起时把 everMounted 也退回去 → 收起即卸载（everMounted 只增不减的契约被破坏）",
    file: GATE,
    mutate: (t) => sub(t,
      "  if (!open) { return { everMounted, readyToOpen }; }",
      "  if (!open) { return { everMounted: false, readyToOpen }; }"),
  },
  {
    name: "C1 删掉 ReasoningSection 里的 shouldMountBody 守卫 → 闸门形同虚设（组件仍 import 着它）",
    file: CHAT,
    mutate: (t) => inSection(t, "  if (!shouldMountBody(open, everMounted)) { return null; }\n\n", ""),
  },
  {
    name: "C2 删掉 hasReasoningData 守卫 → 无思考数据的消息也渲染空壳（A-1015 语义回退）",
    file: CHAT,
    mutate: (t) => inSection(t, "  if (!hasReasoningData(m)) { return null; }\n\n", ""),
  },
  {
    name: "C3 思考区不再委托 ReasoningSection → 懒挂载改了半天，压根没接上",
    file: CHAT,
    mutate: (t) => sub(t,
      "{showThinking && <ReasoningSection m={m} collapsed={collapsed} />}",
      "{showThinking && null}"),
  },
  {
    name: "C4 把闸门挪到时间线计算**之后** → 调用还在（接线测试仍绿），但白工照跑：顺序才是命门",
    file: CHAT,
    mutate: (t) => {
      const guard = "  if (!shouldMountBody(open, everMounted)) { return null; }\n";
      const lateAnchor = "  if (timeline.length === 0 && localFiles.length === 0 && localUrls.length === 0) { return null; }\n";
      const moved = inSection(t, guard, "");
      if (moved === t) { return t; }
      return moved.includes(lateAnchor) ? moved.replace(lateAnchor, guard + lateAnchor) : moved;
    },
  },

  /* ── ② 品牌图标 ─────────────────────────────────────────────────── */
  {
    name: "A1 图标改回字面量 S → 用户反复报的「怎么还是 S」当场复现",
    file: APP,
    mutate: (t) => sub(t,
      '<img className="brand-icon" src={appIconUrl} alt="slime" draggable={false} />',
      '<div className="brand-icon">S</div>'),
  },
  {
    name: "A2 图标改从别处来（不再 import build/icon.png）→ src 仍指向 appIconUrl，但产地已经漂了",
    file: APP,
    mutate: (t) => sub(t,
      'import appIconUrl from "../../build/icon.png";',
      'const appIconUrl = "/assets/icon.png";'),
  },
  {
    name: "S1 .brand-icon 加回文字样式 → 误导下一个维护者（以为这里还在渲染文字）",
    file: CSS,
    mutate: (t) => sub(t,
      ".brand-icon {\n  width: 30px;",
      ".brand-icon {\n  font-size: 16px;\n  width: 30px;"),
  },

  /* ── ③ 上下文口径 / 探针文案 ────────────────────────────────────── */
  {
    name: "M1 agnes 家族 context 写回 524288 → 界面读成 524K，与官方 512K 对不上",
    file: CAPS,
    mutate: (t) => setFamilyContext(t, "agnes", 524288),
  },
  {
    name: "M2 note（小红书 dots）家族 context 写回 524288 → 与它自己的注释「官方公布 512K」自相矛盾",
    file: CAPS,
    mutate: (t) => setFamilyContext(t, "note", 524288),
  },
  {
    name: "M3 builtin-table 文案加一个「失败」→ 把上游不发布价目的**正常形态**说成故障，用户会一直重修探针",
    file: CAPS,
    mutate: (t) => sub(t,
      '  "builtin-table": "上游未回传价格：',
      '  "builtin-table": "探针失败：上游未回传价格：'),
  },

  /* ── ⑤ 底部实时状态行（liveStatus.ts） ──────────────────────────── */
  {
    name: "L1 等审批时也播扫光 → 模型明明停着，界面却在暗示「它在跑，你等着就好」（用户会干等）",
    file: LIVE,
    mutate: (t) => sub(t,
      '    return { kind: "awaiting-approval", text: "等待你审批：Agent 请求执行操作", detail, animated: false };',
      '    return { kind: "awaiting-approval", text: "等待你审批：Agent 请求执行操作", detail, animated: true };'),
  },
  {
    name: "L2 上限未知（cap=0）时照样显示百分比 → 界面出现「上下文 99%」这种凭空捏造的进度",
    file: LIVE,
    mutate: (t) => sub(t,
      "  if (cap > 0 && used > 0) {",
      "  if (used > 0) {"),
  },
  {
    name: "L3 把「正在输出正文」提到「等用户」之前 → 等审批时若已有在途正文，界面显示「正在输出」（用户于是不去点确认）",
    file: LIVE,
    mutate: (t) => {
      const writing = '  if ((input.replyChars ?? 0) > 0) {\n'
        + '    return { kind: "writing", text: "正在输出回复", detail, animated: true };\n'
        + '  }\n';
      if (!t.includes(writing)) { return t; }
      const anchor = "  const detail = buildDetail(input);\n";
      if (!t.includes(anchor)) { return t; }
      return t.replace(writing, "").replace(anchor, anchor + writing);
    },
  },
  {
    name: "L4 把「没有在跑的轮次就返回 null」提到最前 → 空闲时残留正文会让状态行一直显示「正在输出」",
    file: LIVE,
    mutate: (t) => {
      const guard = "  if (!input.loading) { return null; }\n";
      if (!t.includes(guard)) { return t; }
      return t.replace(guard, "").replace(
        "  const detail = buildDetail(input);\n",
        "  const detail = buildDetail(input);\n" + guard,
      );
    },
  },
  {
    name: "L5 已用时不再补零 → 3m4s / 3m40s 分不清（人类读秒会读错）",
    file: LIVE,
    mutate: (t) => sub(t, "return `${m}m${String(s).padStart(2, \"0\")}s`;", "return `${m}m${s}s`;"),
  },

  /* ── ⑥ 待发指令队列（instructionQueue.ts） ─────────────────────── */
  {
    name: "Q1 takeNext 不再校验 sessionId → 会把它会话的指令发到本会话（切会话场景必然踩到）",
    file: QUEUE,
    mutate: (t) => sub(t, "  if (!sessionId || head.sessionId !== sessionId) { return null; }", "  if (!sessionId) { return null; }"),
  },
  {
    name: "Q2 入队改成插到最前 → 后来者插队，队列语义（按我说的顺序）消失",
    file: QUEUE,
    mutate: (t) => sub(t, "  return [...list, item];", "  return [item, ...list];"),
  },
  {
    name: "Q3 promote 空转（不提升）→ 改「中途插入」却排在别人后面，观感是点了没反应",
    file: QUEUE,
    mutate: (t) => sub(t, "  return [hit, ...list.slice(0, idx), ...list.slice(idx + 1)];", "  return list;"),
  },
  {
    name: "Q4 removeAt 空转（不删）→ 用户点 × 没反应，指令还会发出去",
    file: QUEUE,
    mutate: (t) => sub(t, "  return list.filter((q) => q.id !== id);", "  return list;"),
  },
  {
    name: "Q5 预览不折叠空白 → 多行指令把队列条撑成一坨",
    file: QUEUE,
    mutate: (t) => sub(t, '(text ?? "").replace(/\\s+/g, " ").trim()', '(text ?? "").trim()'),
  },
  {
    name: "Q6 两种插入方式的徽标文案写成同一个 → 用户分不清这条会打断还是会排队",
    file: QUEUE,
    mutate: (t) => sub(t,
      'return mode === "interrupt" ? "中途插入" : "即将插入";',
      'return "插入";'),
  },
  {
    name: "Q7 默认插入方式改回「中途插入」→ 无声地把默认行为从「不打断」换成「打断」，旧 bug 原样复现",
    file: INSERT,
    mutate: (t) => sub(t,
      'return localStorage.getItem(KEY) === "interrupt" ? "interrupt" : "queue";',
      'return "interrupt";'),
  },

  /* ── ⑤⑥ 的**接线**：纯逻辑对了不等于界面接上了 ────────────────── */
  {
    name: "W1 队列面板不再渲染 → 功能做了但界面看不见（等于没做）",
    file: CHAT,
    mutate: (t) => sub(t, "{queueOfMine.length > 0 && (", "{false && ("),
  },
  {
    name: "W2 生成中不再提供发送按钮 → 鼠标用户无法插入指令（只能按回车，而回车语义更隐蔽）",
    file: CHAT,
    mutate: (t) => sub(t, "{(input.trim() || pendingImages.length > 0) && (", "{false && ("),
  },
  {
    name: "W3 状态行无条件挂扫光 → 等用户审批时也在扫（界面在骗人）",
    file: CHAT,
    mutate: (t) => sub(t,
      'className={liveStatus?.animated ? "text-scan-light thinking-hint-text" : "thinking-hint-text"}',
      'className="text-scan-light thinking-hint-text"'),
  },
  {
    name: "W4 状态文案换回旧的死值三元式 → 用户又看不出它到底在干什么",
    file: CHAT,
    mutate: (t) => sub(t,
      "{liveStatus ? liveStatus.text : PLACEHOLDER_PHRASES[placeholderIndex]}",
      '{loading ? (toolEvents.length > 0 ? "🔧 调用工具中…" : "💭 思考中…") : PLACEHOLDER_PHRASES[placeholderIndex]}'),
  },
  {
    name: "W5 绕过 syncQueue 直写队列 ref → 界面显示的队列与实际要发的队列漂移",
    file: CHAT,
    mutate: (t) => sub(t, "      syncQueue([]);\n      setInput((prev) =>", "      interruptQueueRef.current = [];\n      setInput((prev) =>"),
  },
  {
    name: "W6 出队改回裸 shift() → 又回到「把别人会话的指令发到本会话」的老 bug",
    file: CHAT,
    mutate: (t) => sub(t, "      const taken = takeNext(interruptQueueRef.current, m.sessionId ?? \"\");",
      "      const taken = interruptQueueRef.current.length > 0 ? { item: interruptQueueRef.current.shift()!, rest: interruptQueueRef.current } : null;"),
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
    console.error(`[mut-a1054] 快照缺少文件：${missing.join("、")}`);
    process.exit(1);
  }
  const base = runGuards();
  if (!base.ok) {
    console.error("[mut-a1054] 基线守卫未通过\n" + base.out.slice(-2000));
    process.exit(1);
  }
  console.info(`[mut-a1054] 基线守卫通过（${FILES.length} 个源文件）\n`);

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const original = readFileSync(path, "utf8");     // 每轮都从**磁盘现值**出发（上轮已字节还原）
    const next = m.mutate(original);
    if (next === original) {
      console.error(`[mut-a1054] ${m.name}\n  ✗ 变异未命中（文本没变）—— 守卫"仍绿"不能说明任何事`);
      survivors.push(`${m.name}（未命中）`);
      continue;
    }
    writeFileSync(path, next, "utf8");
    if (runGuards().ok) {
      console.error(`[mut-a1054] ${m.name}\n  ✗ 守卫仍绿 —— 没锁住`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1054] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }
  restore(snap);

  const restored = treeHash(snapshot()) === before;
  console.info("");
  if (survivors.length) {
    console.error(`[mut-a1054] ${survivors.length}/${MUTATIONS.length} 条未被捕获：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  if (!restored) {
    console.error("[mut-a1054] 还原失败 ✗（源文件指纹与快照不一致）");
    process.exit(1);
  }
  console.info(`[mut-a1054] 全部 ${MUTATIONS.length} 条变异均让守卫变红（${red} 红），源文件字节级已还原 ✓`);
  process.exit(0);
}

main();
