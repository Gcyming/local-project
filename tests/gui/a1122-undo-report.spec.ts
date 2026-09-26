/**
 * tests/gui/a1122-undo-report.spec.ts — ③ 渲染层守卫：回滚文案 + 调用顺序（A-1122）。
 *
 * 这一半守的是**用户看得见的那一层**：
 *  · 确认框把「将还原 N 个文件」算对（少算 = 用户在错误预期下点确定）；
 *  · 还原失败/不可还原/别的会话被波及，都要出现在红字横幅里（吞掉 = 用户以为回滚干净了）；
 *  · `rollbackTo` 的两条**顺序硬约束**：
 *      ① 先 `fileUndo.plan/apply`、后 `chat.truncateFrom`
 *         —— 切分线靠 `history.jsonl` 里那条用户消息定位，先截断 ⇒ 文件还原**静默**失效；
 *      ② 横幅在 `commit()` **之后**设
 *         —— `commit` 走 `resetPartial()`，复位系列会 `setStreamErrorBanner(null)`
 *            （A-1090 的静默失效：同一批 setState 后者胜，先设后清 = 永远看不见）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { fileUndoConfirmText, fileUndoReport, MAX_LISTED } from "../../gui/src/renderer/pages/fileUndoReport.js";
import type { FileUndoPlan, FileUndoResult } from "../../gui/src/shared/ipc.js";

function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}
const CHAT = codeOf("gui/src/renderer/pages/ChatPanel.tsx");
const REPORT_SRC = codeOf("gui/src/renderer/pages/fileUndoReport.ts");

/** 取函数体：先把窗口收窄到签名处，再按缩进找结尾（别用贪婪跨函数匹配） */
function fnBody(src: string, signature: string, endMarker: string): string {
  const at = src.indexOf(signature);
  if (at < 0) { return ""; }
  const end = src.indexOf(endMarker, at);
  return end < 0 ? src.slice(at) : src.slice(at, end + endMarker.length);
}

const plan = (over: Partial<FileUndoPlan> = {}): FileUndoPlan => ({
  ok: true, count: 0, items: [], dirs: 0, blocked: [], foreign: 0, ...over,
});
const result = (over: Partial<FileUndoResult> = {}): FileUndoResult => ({
  ok: true, restored: 0, deleted: 0, dirs: 0, failed: [], blocked: [], foreign: 0, ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 确认框：数字必须是真的（少算/多算都是误导）", () => {
  it("拿不到切分线（`ok:false`）→ **不弹**确认框（由调用方如实报错）", () => {
    expect(fileUndoConfirmText(plan({ ok: false, error: "找不到" }))).toBeNull();
  });

  it("真的无事可做（无文件、无目录、无 blocked）→ 不弹（不许弹「将还原 0 个文件」）", () => {
    expect(fileUndoConfirmText(plan())).toBeNull();
  });

  it("只有文件 → 文案含文件数、**不含**目录数", () => {
    const c = fileUndoConfirmText(plan({ count: 2, items: [
      { abs: "/a", action: "restore" }, { abs: "/b", action: "delete" },
    ] }))!;
    expect(c.message).toContain("还原 2 个文件");
    expect(c.detail).toContain("还原 2 个文件");
    expect(c.message).not.toContain("目录");
  });

  it("文件 + 目录 → 两者都报（目录数**不进** `count`，但要单独说）", () => {
    const c = fileUndoConfirmText(plan({ count: 3, dirs: 2 }))!;
    expect(c.message).toContain("还原 3 个文件");
    expect(c.message).toContain("重建 2 个目录");
  });

  it("⚠️ 只有 `blocked`（没有可还原项）→ **仍要弹**（用户必须知道有东西回不去）", () => {
    const c = fileUndoConfirmText(plan({ blocked: [{ abs: "/big", reason: "目录过大" }] }))!;
    expect(c).not.toBeNull();
    expect(c.message).toContain("回滚到这条消息");
    expect(c.detail).toContain("1 处改动");
    expect(c.detail).toContain("目录过大");
  });

  it("`blocked` 超 `MAX_LISTED` → 折叠成「…还有 N 处」（不许只列几条、让用户以为就这些）", () => {
    const blocked = Array.from({ length: MAX_LISTED + 3 }, (_, i) => ({ abs: `/f${i}`, reason: "读不到改前内容" }));
    const c = fileUndoConfirmText(plan({ count: 1, blocked }))!;
    expect(c.detail).toContain(`另有 ${MAX_LISTED + 3} 处改动`);
    expect(c.detail).toContain(`…还有 3 处`);
  });

  it("别的会话的改动要**报数**（`foreign`），不参与还原", () => {
    const c = fileUndoConfirmText(plan({ count: 1, foreign: 4 }))!;
    expect(c.detail).toContain("4 处改动属于其它会话");
    expect(c.message).not.toContain("其它会话"); // 标题保持短，细节在 detail
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 回滚后横幅：只报问题，且必须报全", () => {
  it("干净成功 → `null`（回滚本身看得见，红字横幅只在有话说时出现）", () => {
    expect(fileUndoReport(result({ restored: 3, deleted: 1, dirs: 1 }))).toBeNull();
  });

  it("`ok:false` 且有 error → 直接报那一句（不再堆别的）", () => {
    const r = fileUndoReport(result({ ok: false, error: "历史里找不到这条用户消息，无法确定回滚边界" }));
    expect(r).toContain("文件未还原");
    expect(r).toContain("无法确定回滚边界");
  });

  it("**还原失败必须出声**并列出失败清单（半途而废不出声 = 用户以为回滚干净了）", () => {
    const r = fileUndoReport(result({ failed: [{ abs: "/x/a.txt", error: "EACCES" }], restored: 2 }))!;
    expect(r).toContain("1 个文件还原失败");
    expect(r).toContain("/x/a.txt");
    expect(r).toContain("EACCES");
    expect(r).toContain("其余已尽力还原");
  });

  it("不可还原项（`blocked`）也要报（账本里只有原因、没有内容）", () => {
    const r = fileUndoReport(result({ blocked: [{ abs: "/big", reason: "目录过大（超过 300 个条目）" }] }))!;
    expect(r).toContain("1 处改动无法还原");
    expect(r).toContain("/big");
  });

  it("`foreign` 要说明「工作区并非改动前状态」（不假装干净）", () => {
    const r = fileUndoReport(result({ foreign: 2, restored: 1 }))!;
    expect(r).toContain("2 处改动属于其它会话");
    expect(r).toContain("并非");
  });

  it("失败/不可还原超过 `MAX_LISTED` → 折叠报总数", () => {
    const failed = Array.from({ length: MAX_LISTED + 2 }, (_, i) => ({ abs: `/f${i}`, error: "boom" }));
    const r = fileUndoReport(result({ failed }))!;
    expect(r).toContain(`${MAX_LISTED + 2} 个文件还原失败`);
    expect(r).toContain("…还有 2 个");
  });

  it("三类问题同时出现 → 全都在（不许只报第一类就返回）", () => {
    const r = fileUndoReport(result({
      failed: [{ abs: "/a", error: "x" }],
      blocked: [{ abs: "/b", reason: "y" }],
      foreign: 1,
    }))!;
    expect(r).toContain("还原失败");
    expect(r).toContain("无法还原");
    expect(r).toContain("属于其它会话");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 接线：`rollbackTo` 的两条顺序硬约束", () => {
  const rollback = fnBody(CHAT, "const rollbackTo = React.useCallback((id: number): void => {", "}, [messages, resetPartial, agentId, sessionId, loading, setStreamErrorBanner]);");

  it("窗口取到了 `rollbackTo` 的函数体（没取到会让下面几条**空转通过**）", () => {
    // ⚠️ 这条是"守卫自己别空转"的保险：清屏/改名会让 indexOf 落空，之后所有断言都对着 "" 跑
    expect(rollback.length).toBeGreaterThan(600);
    expect(rollback).toContain("fileUndo");
  });

  it("历史截断只存在于 `commit()` 内部（不许另有一条「先截断」的旁路）", () => {
    const commitBody = fnBody(rollback, "const commit = (): void => {", "};");
    expect(commitBody).toContain("truncateFrom");
    expect(commitBody).toContain("setMessages(retained)");
    // 真正的**调用**只有一处，且必在 commit 里（别的地方再冒一个 = 出现「先截断」的旁路）
    expect(rollback.split("api.chat.truncateFrom(").length - 1).toBe(1);
    expect(commitBody).toContain("api.chat.truncateFrom(");
  });

  it("⚠️ 终局的 `commit()` 在 `await fileUndo.apply(...)` **之后**（反了 = 文件还原静默失效）", () => {
    // 注意：这里比的是**执行顺序**，不是源码先后 —— `commit` 是闭包定义在上、调用在下，
    // 用 indexOf("truncateFrom") 比大小会被类型声明/闭包定义骗过去（第一版就踩了）。
    const iife = rollback.slice(rollback.indexOf("void (async () => {"));
    const atApply = iife.indexOf("await fileUndo.apply(");
    const atCommit = iife.indexOf("commit()");
    expect(atApply).toBeGreaterThan(-1);
    expect(atCommit).toBeGreaterThan(atApply);
  });

  it("⚠️ 横幅在 `commit()` **之后**设（先设后清 = 永远看不见，A-1090 同宗）", () => {
    const atSet = rollback.indexOf("setStreamErrorBanner(banner)");
    const atCommit = rollback.lastIndexOf("commit()");
    expect(atSet).toBeGreaterThan(-1);
    expect(atCommit).toBeGreaterThan(-1);
    expect(atCommit).toBeLessThan(atSet);
  });

  it("用户取消确认 → **整次回滚中止**（不许只跳过文件、却还是把对话撤了）", () => {
    expect(rollback).toMatch(/if \(!\(await confirmAsync\(/);
    expect(rollback).toMatch(/\)\)\) \{ return; \}/);
  });

  it("`plan` 抛异常 / `apply` 抛异常都要出声（不许静默什么都不做）", () => {
    expect(rollback).toContain("无法预演文件回滚");
    expect(rollback).toContain("文件还原失败");
  });

  it("没有 `fileUndo` 通路（旧 preload / 非 GUI）→ 退回原行为，不阻断对话回滚", () => {
    expect(rollback).toMatch(/if \(!fileUndo \|\| target\.role !== "user" \|\| !sessionId\) \{ commit\(\); return; \}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 唯一出处：文案不许在组件里手搓", () => {
  it("`ChatPanel` 只 import 这两个纯函数，没有自己拼「将还原 N 个文件」", () => {
    expect(CHAT).toContain("fileUndoConfirmText");
    expect(CHAT).toContain("fileUndoReport");
    expect(CHAT).not.toMatch(/将还原\s*\$\{/);
  });

  it("形状从 `shared/ipc.ts` 借（`FileUndoPlan`/`FileUndoResult`），不是手抄", () => {
    expect(REPORT_SRC).toContain('from "../../shared/ipc.js"');
    expect(REPORT_SRC).not.toMatch(/interface FileUndoPlan\s*\{/);
  });
});
