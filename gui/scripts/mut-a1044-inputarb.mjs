#!/usr/bin/env node
/**
 * gui/scripts/mut-a1044-inputarb.mjs — A-1044 守卫的变异验证（core-ts 侧 + GUI 侧两个守卫一起跑）。
 *
 * 守卫"通过"只说明它没报错，不说明它**锁住了正确的对象**。这里把「人优先让位 + 可见化 + 焦点归还」
 * 的每一处关键实现**逐个改坏**，要求两份守卫至少有一份变红。改坏方向刻意选成"看起来更省事/更直觉"
 * 的形态（无条件放行、探测失败静默当空闲、去掉 prevention、去掉 preventScroll、把 end 挪出 finally、
 * 把内部探针写进后端能力表、把宿主坐标当应用内矩形），因为这些正是下一个人顺手会写回去的样子 ——
 * 而且它们**都不报错**，只在真机上表现为"点击被吞 / 鼠标被抢 / 界面永远不亮"。
 *
 * ⚠️ 全程快照 + 还原：任何时刻中断，源文件内容都必须回到原样（末尾核对哈希）。
 * 用法：node gui/scripts/mut-a1044-inputarb.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 不能用 `new URL(...).pathname` —— 项目根含空格（"…pilot project"），
// pathname 会把空格编码成 %20，拼出来的路径直接 ENOENT。fileURLToPath 才正确解码。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = ["tests/core-ts/a1044-guards.spec.ts", "tests/gui/a1044-guards.spec.ts"];

const F_ARB = "core-ts/src/screen/arbiter.ts";
const F_CTL = "core-ts/src/screen/controller.ts";
const F_DESK = "core-ts/src/screen/backends/desktop.ts";
const F_TYPES = "core-ts/src/screen/types.ts";
const F_OP = "gui/src/renderer/pages/operationFocus.ts";
const F_OVERLAY = "gui/src/renderer/components/OperationFocusOverlay.tsx";
const F_BRIDGE = "gui/src/renderer/pages/browserBridge.ts";
const F_CSS = "gui/src/renderer/index.css";
const F_PRELOAD = "gui/src/preload/index.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_APP = "gui/src/renderer/App.tsx";

const FILES = [F_ARB, F_CTL, F_DESK, F_TYPES, F_OP, F_OVERLAY, F_BRIDGE, F_CSS, F_PRELOAD, F_MAIN, F_APP];

const MUTATIONS = [
  /* ── ① 让位裁决（人优先） ── */
  {
    name: "M1 让位窗口形同虚设（恒定放行 → 用户手还在键鼠上就把指针抢走）",
    file: F_ARB,
    from: `  if (idle >= activeWindowMs) {\n    return { action: "proceed", waitedMs, note: "" };`,
    to: `  if (idle >= 0) {\n    return { action: "proceed", waitedMs, note: "" };`,
  },
  {
    name: "M2 探测不可用时静默当空闲（失败不留痕 = 精度杀手）",
    file: F_ARB,
    from: `      note: "（未能读取系统空闲时间，本次未做「用户让位」检查）",`,
    to: `      note: "",`,
  },
  {
    name: "M3 永远等下去，绝不中止（等于在用户手底下一直抢指针）",
    file: F_ARB,
    from: `  if (waitedMs + need <= maxWaitMs) {`,
    to: `  if (waitedMs + need <= maxWaitMs || true) {`,
  },
  {
    name: "M4 动作点框不居中（呼吸灯画错位置 = 指错地方，比不画更糟）",
    file: F_ARB,
    from: `      x: Math.round(px - OPERATION_BOX_W / 2),\n      y: Math.round(py - OPERATION_BOX_H / 2),`,
    to: `      x: Math.round(px),\n      y: Math.round(py),`,
  },
  {
    name: "M5 退化矩形不再过滤（会画出一个 0 宽/0 高的假框）",
    file: F_ARB,
    from: `    r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0 ? r : null;`,
    to: `    r ?? null;`,
  },

  /* ── ② 控制器：让位门 / 事件时序 / 可视化容错 ── */
  {
    name: "M6 点按不再让位（click 从冲突集合里掉出去 —— 最容易漏的一个）",
    file: F_CTL,
    from: `  "click", "double_click", "right_click", "middle_click", "long_press",`,
    to: `  "double_click", "right_click", "middle_click", "long_press",`,
  },
  {
    name: "M7 begin 事件丢失（用户永远来不及把手挪开）",
    file: F_CTL,
    from: `this.emitFocus({ phase: "begin", backend: id`,
    to: `this.emitFocus({ phase: "start", backend: id`,
  },
  {
    name: "M8 end 事件挪出 finally（动作抛异常时边框永远留在屏幕上）",
    file: F_CTL,
    from: `      } finally {\n        if (conflictsWithUser) {\n          this.emitFocus({ phase: "end", backend: id`,
    to: `      }\n      if (false) {\n        if (conflictsWithUser) {\n          this.emitFocus({ phase: "end", backend: id`,
  },
  {
    name: "M9 可视化回调不再兜异常（界面画框失败会打断动作执行）",
    file: F_CTL,
    from: `  private emitFocus(e: OperationFocusEvent): void {\n    try { this.onOperationFocus?.(e); } catch { /* 可视化失败不影响动作 */ }\n  }`,
    to: `  private emitFocus(e: OperationFocusEvent): void {\n    this.onOperationFocus?.(e);\n  }`,
  },

  /* ── ③ 桌面空闲探针 ── */
  {
    name: "M10 内部探针被写进后端能力表（模型可直接调 user_idle，语义污染）",
    file: F_DESK,
    from: `const DESKTOP_ACTIONS: ReadonlySet<ScreenActionKind> = new Set<ScreenActionKind>([\n  "click",`,
    to: `const DESKTOP_ACTIONS: ReadonlySet<ScreenActionKind> = new Set<ScreenActionKind>([\n  "user_idle" as ScreenActionKind,\n  "click",`,
  },
  {
    name: "M11 探针失败改为抛出（一次探测失败把整条图形操作打断）",
    file: F_DESK,
    from: `    } catch {\n      // 宿主未就绪/超时：探测不可用。**不抛**——让位判据的语义是"探测不到就放行但留痕"，\n      // 而不是让一次探针失败把用户的图形操作整条打断。\n      return null;\n    }`,
    to: `    } catch (e) {\n      throw e;\n    }`,
  },
  {
    name: "M12 能力接口去掉可选标记（安卓后端被迫实现一个它根本没有的探针）",
    file: F_TYPES,
    from: `  userIdleMs?(): Promise<number | null>;`,
    to: `  userIdleMs(): Promise<number | null>;`,
  },

  /* ── ④ 可视化判据（渲染层唯一实现） ── */
  {
    name: "M13 看门狗失效（end 丢失 → 边框永远转，用户以为 Agent 还在动）",
    file: F_OP,
    from: `  return s.active && now - s.ts > OP_FOCUS_MAX_HOLD_MS;`,
    to: `  return false;`,
  },
  {
    name: "M14 别人的 end 也接受（两条路径交错时正在进行的指示莫名消失）",
    file: F_OP,
    from: `    if (prev.active && prev.target && p.target && prev.target !== p.target) { return prev; }`,
    to: `    if (false) { return prev; }`,
  },
  {
    name: "M15 把宿主像素当应用内矩形用（两个坐标系混用 → 边框画到天上）",
    file: F_OP,
    from: `    rect: null,`,
    to: `    rect: { x: 0, y: 0, width: 0, height: 0 },`,
  },

  /* ── ⑤ 焦点归还（应用内"点击被吞"的直接成因） ── */
  {
    name: "M16 聚焦不再带 preventScroll（用户正要点的目标被滚走 → 点击落空）",
    file: F_BRIDGE,
    from: `    (wv as Electron.WebviewTag).focus({ preventScroll: true });`,
    to: `    (wv as Electron.WebviewTag).focus();`,
  },
  {
    name: "M17 无条件抢回焦点（用户自己挪走的焦点也被抢回来 = 人优先被推翻）",
    file: F_BRIDGE,
    from: `    if (document.activeElement !== (wv as unknown as HTMLElement)) { return; }`,
    to: `    if (false) { return; }`,
  },
  {
    name: "M18 点击分支退回裸聚焦（withWebviewFocus 只包了一半动作）",
    file: F_BRIDGE,
    from: `        return await withWebviewFocus(wv, \`点击网页元素\${pt.what ? \`：\${pt.what}\` : ""}\`, async () => {`,
    to: `        try { wv.focus(); } catch { /* 忽略 */ }\n        return await (async () => {`,
  },

  /* ── ⑥ 浮层约束与接线 ── */
  {
    name: "M19 悬浮提示吃掉点击（把用户/Agent 的点击挡在浮层外 —— A-976 前科）",
    file: F_CSS,
    from: `  pointer-events: none;         /* ① 绝不吞点击 */`,
    to: `  pointer-events: auto;         /* ① 绝不吞点击 */`,
  },
  {
    name: "M20 呼吸动效改几何属性（逐帧触发布局 = 卡顿源）",
    file: F_CSS,
    from: `  0%, 100% { box-shadow: 0 0 0 0 var(--accent-soft); border-color: var(--border-hover); }\n  50%      { box-shadow: 0 0 14px 3px var(--accent-soft); border-color: var(--accent); }`,
    to: `  0%, 100% { width: 100%; border-color: var(--border-hover); }\n  50%      { width: 102%; border-color: var(--accent); }`,
  },
  {
    name: "M21 跨进程通道名写错（字段全对但界面永远不亮 —— 最典型的静默失效）",
    file: F_PRELOAD,
    from: `      onMessage<OperationFocusUI>("slime:screen:opFocus", cb),`,
    to: `      onMessage<OperationFocusUI>("slime:screen:opfocus", cb),`,
  },
  {
    name: "M22 主进程不订阅 controller（系统级操作永远不画边框）",
    file: F_MAIN,
    from: `  screenCtl.onOperationFocus = (e): void => {`,
    to: `  const _unusedOpFocus = (e: unknown): void => { void e; };\n  if (false) screenCtl.onOperationFocus = (e): void => {`,
  },
  {
    name: "M23 浮层没挂到 App 根上（判据/组件全在，界面上一片安静）",
    file: F_APP,
    from: `      <OperationFocusOverlay />`,
    to: ``,
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

function snapshot(files) {
  const out = new Map();
  for (const rel of files) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { out.set(p, readFileSync(p, "utf8")); }
  }
  return out;
}

function restore(snap) {
  for (const [p, text] of snap) { writeFileSync(p, text); }
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

function main() {
  const snap = snapshot(FILES);
  if (snap.size !== FILES.length) {
    console.error(`[mut-a1044] 快照不全（${snap.size}/${FILES.length}），先确认路径`);
    process.exit(1);
  }
  const before = [...snap.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|");

  const base = runGuards();
  if (!base.ok) {
    console.error("[mut-a1044] 基线守卫未通过，先修守卫再跑变异\n" + base.out.slice(-2000));
    process.exit(1);
  }
  console.info(`[mut-a1044] 基线守卫通过（2 份守卫 / 快照 ${snap.size} 个文件）\n`);

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const original = snap.get(path);
    if (original === undefined) {
      console.error(`[mut-a1044] ${m.name}\n  ✗ 快照里没有 ${m.file}`);
      survivors.push(m.name);
      continue;
    }
    const next = original.includes(m.from) ? original.replace(m.from, m.to) : null;
    if (next === null) {
      console.error(`[mut-a1044] ${m.name}\n  ✗ 锚点未命中`);
      survivors.push(m.name);
      continue;
    }
    if (next === original) {
      console.error(`[mut-a1044] ${m.name}\n  ✗ 变异无效果（改了等于没改）`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(path, next);

    const r = runGuards();
    if (r.ok) {
      console.error(`[mut-a1044] ${m.name}\n  ✗ 守卫仍绿 —— 这条守卫没锁住它`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1044] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }

  restore(snap);
  const after = snapshot(FILES);
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before
    && after.size === snap.size;

  console.info("");
  if (survivors.length > 0) {
    console.error(`[mut-a1044] ${survivors.length}/${MUTATIONS.length} 条变异**未被守卫捕获**：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1044] 全部 ${MUTATIONS.length} 条变异均成功让守卫变红（${red} 红），`
    + `${restored ? "源文件哈希已还原 ✓" : "源文件还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
