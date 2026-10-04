






















export type LiveStatusKind =
  
  | "awaiting-approval"
  
  | "awaiting-answer"
  
  | "compress"
  
  | "stopping"
  
  | "writing"
  
  | "tool"
  





  | "steer-ack"
  





  | "notice"
  
  | "thinking"
  
  | "preparing";

export interface LiveStatusInput {
  
  loading: boolean;
  
  stopping?: boolean;
  
  awaitingApproval?: boolean;
  
  awaitingAnswer?: boolean;
  
  compressStage?: "prep" | "summarize" | "done" | "trunc" | "skip" | "overflow" | null;
  
  lastToolLabel?: string;
  





  lastToolName?: string;
  
  toolCount?: number;
  
  replyChars?: number;
  
  reasonChars?: number;
  
  elapsedMs?: number;
  



  steerAck?: boolean;
  



  upstreamNotice?: string;
  
  ctxUsed?: number;
  ctxCap?: number;
}

export interface LiveStatus {
  kind: LiveStatusKind;
  
  text: string;
  
  detail: string;
  




  animated: boolean;
}
















export type ToolStage =
  
  | "generate-script"
  
  | "run-command"
  
  | "read-file"
  
  | "write-file"
  
  | "search-web"
  
  | "screen-control"
  
  | "browser"
  
  | "plan"
  
  | "memory"
  
  | "delegate"
  
  | "tool";


export const TOOL_STAGE_TITLES: Record<ToolStage, string> = {
  "generate-script": "正在生成脚本",
  "run-command": "正在执行命令",
  "read-file": "正在读取文件",
  "write-file": "正在写入文件",
  "search-web": "正在检索信息",
  "screen-control": "正在操作屏幕",
  "browser": "正在操作浏览器",
  "plan": "正在整理任务计划",
  "memory": "正在整理记忆",
  "delegate": "正在分派子代理",
  "tool": "正在调用工具",
};








export function classifyToolStage(toolName: string): ToolStage {
  const n = (toolName ?? "").trim().toLowerCase();
  if (!n) { return "tool"; }
  if (n.startsWith("delegate:") || n === "subagent_result" || n.startsWith("delegate_")) { return "delegate"; }
  if (n.startsWith("screen_") || n === "adb_screencap" || n === "adb_devices" || n === "adb_connect") { return "screen-control"; }
  if (n.startsWith("browser_")) { return "browser"; }
  if (n.startsWith("adb_")) { return "run-command"; }
  if (n === "http_serve" || n === "http_stop") { return "run-command"; }
  if (n === "http_create_app") { return "generate-script"; }
  if (n === "file_read" || n === "file_list" || n === "code_check") { return "read-file"; }
  if (n === "file_write") { return "write-file"; }
  if (n.startsWith("web_") || n === "memory_search") { return "search-web"; }
  if (n.startsWith("plan_") || n === "todo_write") { return "plan"; }
  if (n.startsWith("memory_")) { return "memory"; }
  return "tool";
}


export function toolStageTitle(toolName: string): string {
  return TOOL_STAGE_TITLES[classifyToolStage(toolName)];
}

export function formatElapsed(ms: number | undefined): string {
  if (!ms || ms <= 0) { return ""; }
  const total = Math.floor(ms / 1000);
  if (total < 60) { return `${total}s`; }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}


export function estimateTokens(chars: number | undefined): number {
  if (!chars || chars <= 0) { return 0; }
  return Math.round(chars / 4);
}


export function buildDetail(input: LiveStatusInput): string {
  const parts: string[] = [];
  const elapsed = formatElapsed(input.elapsedMs);
  if (elapsed) { parts.push(`已 ${elapsed}`); }
  if ((input.toolCount ?? 0) > 0) { parts.push(`工具 ${input.toolCount} 次`); }

  const tok = estimateTokens((input.replyChars ?? 0) + (input.reasonChars ?? 0));
  if (tok > 0) { parts.push(`≈${tok} tok`); }

  const used = input.ctxUsed ?? 0;
  const cap = input.ctxCap ?? 0;
  
  if (cap > 0 && used > 0) { parts.push(`上下文 ${Math.min(99, Math.round((used / cap) * 100))}%`); }

  return parts.join(" · ");
}












export function deriveLiveStatus(input: LiveStatusInput): LiveStatus | null {
  const detail = buildDetail(input);

  if (input.awaitingApproval) {
    return { kind: "awaiting-approval", text: "等待你审批：Agent 请求执行操作", detail, animated: false };
  }
  if (input.awaitingAnswer) {
    return { kind: "awaiting-answer", text: "等待你回答 Agent 的问题", detail, animated: false };
  }

  const stage = input.compressStage;
  if (stage === "prep") {
    return { kind: "compress", text: "正在整理会话上下文…", detail, animated: true };
  }
  if (stage === "summarize") {
    return { kind: "compress", text: "上下文接近上限，正在生成摘要…", detail, animated: true };
  }
  if (stage === "trunc") {
    return { kind: "compress", text: "摘要不可用，正在保留最近若干轮…", detail, animated: true };
  }
  

  if (input.stopping) {
    return { kind: "stopping", text: "正在停止生成…", detail, animated: true };
  }

  

  if (input.steerAck) {
    return { kind: "steer-ack", text: "已接收引导 · 模型响应中", detail, animated: true };
  }

  



  if (input.upstreamNotice) {
    return { kind: "notice", text: input.upstreamNotice, detail, animated: true };
  }

  if (!input.loading) { return null; }

  if ((input.replyChars ?? 0) > 0) {
    return { kind: "writing", text: "正在输出回复", detail, animated: true };
  }
  if (input.lastToolLabel) {
    

    const title = input.lastToolName ? toolStageTitle(input.lastToolName) : "正在调用";
    return { kind: "tool", text: `${title}「${input.lastToolLabel}」`, detail, animated: true };
  }
  if ((input.reasonChars ?? 0) > 0) {
    return { kind: "thinking", text: "思考中", detail, animated: true };
  }
  return { kind: "preparing", text: "已发出请求，等待上游返回…", detail, animated: true };
}
