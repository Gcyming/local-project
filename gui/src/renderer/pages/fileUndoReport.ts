/**
 * gui/src/renderer/pages/fileUndoReport.ts — A-1122（③）：回滚的**用户可见文案唯一出处**。
 *
 * ## 为什么单独成一个纯函数模块
 *
 * 回滚这类操作的危险不在于"功能跑不起来"，而在于**文案把失败说成成功**：
 *  · 确认框少算/多算「将还原 N 个文件」⇒ 用户在错误的预期下点了确定；
 *  · 还原失败被吞成一句「已回滚」⇒ 用户以为工作区回到了改动前，实际没有。
 * 两种情况都不会报错、都不会被 tsc 抓住，所以必须把文案抽成纯函数，
 * 让守卫能**直接断言字符串**（而不是"在组件里读一遍代码，看着对"）。
 *
 * ⚠️ 上游 `UndoPlan`/`UndoResult` 的形状**只借不改**（`gui/src/shared/ipc.ts`
 * 从 core-ts `file_undo.ts` 转发）：在这里手抄一份形状，等于给"主进程多了一类
 * （例如 `dirs` 目录重建）而渲染层静默不显示"留了后门。
 */

import type { FileUndoPlan, FileUndoResult } from "../../shared/ipc.js";

/** 清单里最多列几条（之后折叠成「…还有 N 处」）—— 横幅有高度上限，但不许因此**假装只有这几条** */
export const MAX_LISTED = 5;

/** 确认框文案（`plan` 无事可做时返 null：不弹「将还原 0 个文件」这种假确认） */
export function fileUndoConfirmText(plan: FileUndoPlan): { message: string; detail: string } | null {
  // 拿不到切分线（`ok=false`）= 无法确定边界 ⇒ 由调用方走"如实报错"，不给确认框
  if (!plan.ok) { return null; }
  const parts: string[] = [];
  if (plan.count > 0) { parts.push(`还原 ${plan.count} 个文件`); }
  if (plan.dirs > 0) { parts.push(`重建 ${plan.dirs} 个目录`); }
  // 只有不可还原项时：仍要弹 —— 用户必须知道"这次回滚有东西回不去"
  if (parts.length === 0 && plan.blocked.length === 0) { return null; }
  const lines: string[] = [];
  lines.push(parts.length > 0
    ? `把磁盘上这些改动退回这条消息发出之前的状态：${parts.join("、")}。`
    : "本次回滚没有可自动还原的文件改动。");
  lines.push("（这条消息及其之后的对话会一并撤回，消息内容放回输入框）");
  if (plan.blocked.length > 0) {
    lines.push("");
    lines.push(`⚠️ 另有 ${plan.blocked.length} 处改动**无法还原**（账本里只有原因、没有旧内容）：`);
    for (const b of plan.blocked.slice(0, MAX_LISTED)) { lines.push(`· ${b.abs} —— ${b.reason}`); }
    if (plan.blocked.length > MAX_LISTED) { lines.push(`· …还有 ${plan.blocked.length - MAX_LISTED} 处`); }
  }
  if (plan.foreign > 0) {
    lines.push("");
    lines.push(`（另有 ${plan.foreign} 处改动属于其它会话，不在本次回滚范围内）`);
  }
  const message = parts.length > 0
    ? `回滚到这条消息？将${parts.join("、")}。`
    : "回滚到这条消息？";
  return { message, detail: lines.join("\n") };
}

/**
 * 回滚**之后**要展示的横幅（null = 无需出声）。
 *
 * 只报问题，不报成功：回滚本身在界面里看得见（消息消失、内容回到输入框），
 * 而这条横幅是**红色就地错误横幅**（`streamErrorBanner`）—— 成功也挂红字只会让
 * 真正的失败变得不显眼。问题则必须报全：失败、不可还原、别的会话也被波及。
 */
export function fileUndoReport(res: FileUndoResult): string | null {
  const lines: string[] = [];
  if (!res.ok && res.error) { return `⚠️ 文件未还原：${res.error}`; }
  if (res.failed.length > 0) {
    lines.push(`⚠️ ${res.failed.length} 个文件还原失败（其余已尽力还原）：`);
    for (const f of res.failed.slice(0, MAX_LISTED)) { lines.push(`· ${f.abs} —— ${f.error}`); }
    if (res.failed.length > MAX_LISTED) { lines.push(`· …还有 ${res.failed.length - MAX_LISTED} 个`); }
  }
  if (res.blocked.length > 0) {
    lines.push(`⚠️ ${res.blocked.length} 处改动无法还原（Agent 改动时没能留下旧内容）：`);
    for (const b of res.blocked.slice(0, MAX_LISTED)) { lines.push(`· ${b.abs} —— ${b.reason}`); }
    if (res.blocked.length > MAX_LISTED) { lines.push(`· …还有 ${res.blocked.length - MAX_LISTED} 处`); }
  }
  if (res.foreign > 0) {
    lines.push(`（另有 ${res.foreign} 处改动属于其它会话，本次未触及 —— 工作区并非"改动前"的状态）`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
