















import type { FileUndoPlan, FileUndoResult } from "../../shared/ipc.js";


export const MAX_LISTED = 5;


export function fileUndoConfirmText(plan: FileUndoPlan): { message: string; detail: string } | null {
  
  if (!plan.ok) { return null; }
  const parts: string[] = [];
  if (plan.count > 0) { parts.push(`还原 ${plan.count} 个文件`); }
  if (plan.dirs > 0) { parts.push(`重建 ${plan.dirs} 个目录`); }
  
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
