/**
 * gui/src/renderer/pages/ChatPanel.tsx — 会话面板（会话化重构 v3）。
 * - 项目（Agent）内独立会话：进入会话加载历史（sessions:load），消息按 session_id 落盘
 * - 会话内协作双入口：⑂ 自分裂（fork 新实例） / ⟳ A2A 传唤（<DELEGATE> 委派已有 Agent）
 * - "/" 指令面板（CLI 语义迁移）：/task /split /thinking /stats /agent /new ...
 * - 输入联想：≥1 字自动检索历史会话相似消息（点击填入）
 * - ＋ 展开栏：指令 / 技能 / MCP 工具 选择
 * - 会话级配置：💼 工作目录 + 审批模式；会话标题随时重命名
 */
import React, { type CSSProperties, type JSX } from "react";
import { createPortal } from "react-dom";
import type { StreamChunk, ConversationMessage, SessionConfig, ApprovalMode, SuggestionItem, ExtrasList, AgentDetail, PermissionRequestUI, PermissionDecision, AskUserRequestUI, AskUserDecision, CtxBuckets } from "../../shared/ipc.js";
import { buildAskDecision, canSubmitAsk, initialAskSelection } from "./askState.js";
import Markdown, { requestSidebarOpen, normalizeBrokenLines, tightenCjkSpacing } from "./Markdown.js";
import { SendIcon, EditIcon, ChevronIcon, ThinkingIcon, PlusIcon, InternetIcon, BoltIcon, LoadingCircleIcon, CheckIcon, CloseIcon, PaperclipIcon, CopyIcon, RotateIcon, SitemapIcon, RefFileIcon, BrainThinkingIcon, FolderIcon, TodoListIcon, PlayIcon, ClockIcon, MessageCircleIcon, SearchIcon, StarIcon, ImageIcon, ManualIcon, AutoModeIcon, CustomIcon, WarningIcon, FileTypeIcon, type IconProps } from "../components/Icon.js";
import downIcon from "../../../icon/icon_fpbc119q3rk/down.svg";
import SubAgentBar from "./SubAgentBar.js";
import { confirmAsync, alertAsync } from "../dialog.js";
import { useReasoningPreset, presetEffortsOf, presetLabelOf, useThinkingPreset, thinkingForcedOff } from "../reasoning.js";
import { inferModelCapabilities } from "../../../../shared/gen/model-capabilities.js";

/**
 * 推理强度等级 → 中文名（仅作展示标签）。等级以当前模型「上游返回」为准，
 * 覆盖行业常见取值；未收录的未知等级原样显示，不强行翻译。
 */
const EFFORT_LABEL: Record<string, string> = {
  none: "关",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  maximal: "最大化",
  adaptive: "自适应",
  auto: "自动",
  aggressive: "激进",
};

/**
 * 解析 modelChoice 字符串（api:<key>:<model> / local:<id> / inherit）。
 * 兼容模型 ID 内含冒号的情形（不再用 split(':').pop() 截断导致匹配失败）；
 * 缺失段返回 undefined。
 */
function parseModelChoice(choice: string): { type: "inherit" | "api" | "local"; key?: string; modelId?: string } {
  if (!choice) { return { type: "inherit" }; }
  const [head, ...rest] = choice.split(":");
  if (head === "api") {
    return { type: "api", key: rest[0] || undefined, modelId: rest.slice(1).join(":") || undefined };
  }
  if (head === "local") {
    return { type: "local", modelId: rest.join(":") || undefined };
  }
  return { type: "inherit" };
}

/** A-969 上下文自动压缩：GUI 发送前触发的配置（localStorage 持久化；GeneralPanel 可调） */
interface AutoCompressCfg { enabled: boolean; ratio: number; mode: "animated" | "silent"; }
function readAutoCompressCfg(): AutoCompressCfg {
  try {
    const raw = localStorage.getItem("slime_auto_compress");
    if (raw) {
      const p = JSON.parse(raw) as Partial<AutoCompressCfg>;
      const ratio = typeof p.ratio === "number" && p.ratio >= 0.5 && p.ratio <= 0.97 ? p.ratio : 0.85;
      return { enabled: p.enabled !== false, ratio, mode: p.mode === "silent" ? "silent" : "animated" };
    }
  } catch { /* 配置损坏 → 默认 */ }
  return { enabled: true, ratio: 0.85, mode: "animated" };
}

/** 工具类型标签映射：将内部 tool name 转为用户友好的中文名 + 图标库 SVG 组件（A-1xx：弃用 emoji） */
const TOOL_LABELS: Record<string, { label: string; Icon: React.ComponentType<IconProps> }> = {
  web_search: { label: "网络搜索", Icon: SearchIcon },
  web_fetch: { label: "网页抓取", Icon: InternetIcon },
  file_read: { label: "读取文件", Icon: RefFileIcon },
  file_list: { label: "列出文件", Icon: FolderIcon },
  file_write: { label: "写入文件", Icon: EditIcon },
  code_check: { label: "语法检查", Icon: CheckIcon },
  delegate: { label: "传唤子 Agent", Icon: SitemapIcon },
  ask_user: { label: "询问用户", Icon: MessageCircleIcon },
  todo_write: { label: "记录待办", Icon: TodoListIcon },
  agnes_prompt_build: { label: "构建生成提示词", Icon: BrainThinkingIcon },
  agnes_generate_image: { label: "生成图片", Icon: StarIcon },
  agnes_generate_video: { label: "生成视频", Icon: PlayIcon },
  agnes_video_status: { label: "视频任务状态", Icon: ClockIcon },
};

function resolveToolLabel(name: string): { label: string; Icon: React.ComponentType<IconProps> } {
  const mapped = TOOL_LABELS[name];
  if (mapped) { return mapped; }
  // 未知工具：去掉 delegate: 等前缀后显示
  const clean = name.startsWith("delegate:") ? name.slice(9) : name;
  return { label: clean, Icon: BoltIcon };
}

/** 消息结构（用户/助手消息） */
interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  time: string;
  /** raw ISO 时间戳（回滚截断历史用：history 记录按 timestamp 精确匹配；格式化 time 不可逆） */
  ts?: string;
  /** 附带图片 data URL（user 消息；随消息回显缩略图，不写入服务端历史） */
  images?: string[];
  /** 该条回复的推理/思考过程（assistant，Markdown） */
  reasoning?: string;
  /** 该条回复的耗时（毫秒，assistant 消息） */
  elapsedMs?: number;
  /** 模型显示标签（user=发送时选用 / assistant=实际响应） */
  model?: string;
  /** 发送时的模式（build/plan…） */
  mode?: string;
  /** 错误类消息（模型调用重连 9 次均失败后红字强调展示） */
  error?: boolean;
  /** 发言人 Agent 名称（团队会话成员发言；缺省 = 会话组长/当前 Agent） */
  agentName?: string;
  /** 发言人 Agent ID（团队会话成员发言；用于区分组长与成员） */
  agentId?: string;
  /** A-163/A-166：阶段折叠卡结构化数据（完成消息时由 tool 留痕+思考组装；渲染为「参考内容/思考过程」折叠项） */
  stages?: {
    /** 读过的本地文件（file_read） */
    reads: Array<{ path: string | undefined; label: string }>;
    /** 访问的网址（web_fetch / web_search） */
    urls: Array<{ url: string; label: string }>;
    /** 工具调用留痕（含修改工具 file_write/code_check 等） */
    tools: ToolEvent[];
    /** 思考历程（reasoning）*/
    reasoning?: string;
    /** A-171：交错时间线（思考段落 ↔ 工具调用按真实发生顺序穿插） */
    timeline?: TimelineStep[];
    /** 完成阶段（todo_write 相关）由 reasoning 中 ### 工具调用记录 解析，保留 Markdown */
  };
}

/** A-171：时间线节点（思考段落 / 工具调用，按执行顺序交错） */
interface TimelineStep {
  kind: "think" | "tool";
  /** kind=think：该阶段思考内容（Markdown） */
  text?: string;
  /** kind=tool：工具名 */
  name?: string;
  /** kind=tool：展示标签 */
  label?: string;
  /** kind=tool：具体抓手（网址/文件路径/查询词） */
  detail?: string;
  /** kind=tool：执行结果（成功=内容 / 失败=失败原因） */
  result?: string;
}

/** A-934：会话级「思考时间线 + 窗口占用」持久化纯函数（独立模块，无 React 依赖、vitest 可直测）——
 *  历史落库只存 reasoning 文本（无交错顺序/无 token 统计），重启后思考历程退化为文本平铺、上下文清零；
 *  此处把 timelineSteps（按 assistant 消息序数）与最近一次窗口占用快照随会话存下来，
 *  加载会话时按序数回填交错时间线、恢复环与右栏占用值。 */
import { readSessionCtxMeta, clearSessionCtxMeta, updateSessionCtxMeta, attachTimelineToHistory, restoreUsed, type TimelineStepLite } from "./sessionCtxMeta.js";
import { contextRatio, contextPct, ringLevel } from "./contextMath.js";

/** A-935：上下文占用**单一事件源**——发送时估算 / done 收到真实 usage 校准都经此广播，
 *  右上角 ContextRing 与右侧栏 ContextWindowBar 订阅同一事件按 sessionId 过滤 →
 *  两端数值严格同源同时变更（根治"右栏慢于圆环/不同步"）。 */
export interface CtxUpdatePayload { sessionId: string; used: number; cap: number; buckets?: CtxBuckets }
export function dispatchCtxUpdate(payload: CtxUpdatePayload): void {
  window.dispatchEvent(new CustomEvent<CtxUpdatePayload>("slime:ctx:update", { detail: payload }));
}
export function onCtxUpdate(cb: (p: CtxUpdatePayload) => void): () => void {
  const h = (e: Event): void => {
    const d = (e as CustomEvent<CtxUpdatePayload>).detail;
    if (d && typeof d === "object") { cb(d); }
  };
  window.addEventListener("slime:ctx:update", h);
  return () => window.removeEventListener("slime:ctx:update", h);
}

/** 流式入参（自动重连时按原样重发；字段与 preload ChatInput 对齐） */
type ChatStreamReq = {
  agentId: string;
  message: string;
  sessionId?: string;
  networkEnabled?: boolean;
  /** 上游 max_output 元数据 → max_tokens（限制单次输出上限，防止超出模型最大输出报错） */
  maxTokens?: number;
  /** 识图图片（data URL 列表，data:image/png;base64,...） */
  images?: string[];
};

/** 不可恢复错误：403 区域限制 / 401 认证失败 / 404 模型不存在 / 400 模型不可用 /
 *  免费模型限流（FreeUsageLimitError）等短期不可自动恢复的错误。
 *  对这些错误自动重连（连续 9 次、≤16s）多半无效，直接终止重连并给出可操作提示。 */
function isPermanentStreamError(msg: string): boolean {
  const m = msg.toLowerCase();
  // 403 区域/权限：RegionError、This model is not available in your country 等
  if (/403|regionerror|forbidden|not available in your (country|region)/i.test(m)) {
    return true;
  }
  // 401 认证失败：key 无效/过期（模型供应商侧配置问题，重连无效）
  if (/401|unauthorized|认证失败|invalid.*(api.?key|key)|api.?key.*invalid|authentication/i.test(m)) {
    return true;
  }
  // 404 模型不存在/已被下架/大小写不匹配（换路重发同一模型同样失败）
  if (/404|model.*(not found|no such)|no such model/i.test(m)) {
    return true;
  }
  // 400 上游明确报告模型不可用（如 opencode zen 的 Model is unavailable）
  if (/model (is )?unavailable/i.test(m)) {
    return true;
  }
  // 免费模型限流（FreeUsageLimitError）：免费池有独立速率/并发限制，与个人累计用量无关；
  // 短时间自动重连不会恢复，提示用户稍后手动重发
  if (/freeusagelimit|free usage|免费额度|免费模型限流/i.test(m)) {
    return true;
  }
  return false;
}

/** 重连均失败后 / 不可恢复错误：按错误内容归纳「可能诱因」，供红字强调展示
 *  attemptCount 有值时标题注明重连 N 次仍失败；留空（0）表示错误不可自动恢复 */
function explainStreamError(msg: string, attemptCount?: number): string {
  const causes: string[] = [];
  const m = msg.toLowerCase();
  if (/401|unauthorized|invalid.*key|api.?key|authentication|auth/i.test(m)) {
    causes.push("API Key 无效或已过期 → 请到「模型供应商」重新填写密钥并保存");
  }
  if (/403|forbidden|permission/i.test(m)) {
    // RegionError（区域限制）优先给出精准提示，避免笼统误报为"检查权限"
    if (/regionerror|not available in your (country|region)/i.test(m)) {
      causes.push("上游区域限制（RegionError）→ 该模型在你所在地区不可用，请切换其他地区可用的模型 / 供应商");
    } else {
      causes.push("上游拒绝访问（403）→ 检查密钥权限 / 账号额度是否耗尽");
    }
  }
  if (/404|no such|not found|model.*not|invalid.*model/i.test(m)) {
    causes.push("模型 ID 不存在 / 已被下架 / 大小写不匹配 → 请切换到其他已启用模型");
  }
  // 400 上游明确报告模型不可用（放在 404 判断后、429 判断前，命中优先展示精准诱因）
  if (/model (is )?unavailable/i.test(m)) {
    causes.push("上游报告该模型当前不可用（Model is unavailable）→ 请切换到其他已启用模型，或稍后重试");
  }
  // 免费模型限流：FreeUsageLimitError 含 "Rate limit exceeded" 字样，
  // 必须在通用 429 分支之前判断，避免误报成"普通限流稍等片刻"或"额度用完"
  if (/freeusagelimit|free usage|免费额度|免费模型限流/i.test(m)) {
    causes.push("免费模型触发上游限流（FreeUsageLimit，免费池独立的速率/并发限制，与你今天用没用过无关）→ 请稍等片刻后手动重新发送，或切换到其他模型");
  }
  if (/429|rate.?limit|quota|insufficient|too many/i.test(m)) {
    causes.push("触发上游限流（429）或额度不足 → 稍等片刻再发，或降低推理强度 / 输出长度");
  }
  if (/timeout|timed ?out|etimedout|econnreset|socket|network|fetch failed|unexpected token|eof|aborted|reset/i.test(m)) {
    causes.push("网络波动或上游连接中断 → 检查网络 / 代理 / VPN 后重试");
  }
  if (/overloaded|busy|maintenance|503|502|500|5\d\d/i.test(m)) {
    causes.push("上游服务暂时不可用（5xx）→ 服务恢复后重试");
  }
  if (/context|token.*(limit|length|max)|too (long|large)/i.test(m)) {
    causes.push("请求超出模型上下文上限 → 点击「新对话」清理上下文后重试");
  }
  if (/local|model.?server|llama|19100|load/i.test(m)) {
    causes.push("本地模型服务未就绪或已崩溃 → 到「状态面板」确认模型服务状态后重试启动");
  }
  if (causes.length === 0) {
    causes.push("未知错误 → 参考上方完整错误信息；检查模型是否已启用、网络是否正常");
  }
  return [
    `❌ 模型调用失败${attemptCount ? `（已自动重连 ${attemptCount} 次仍无法恢复）` : "（错误无法自动恢复，请按下方提示处理）"}`,
    ``,
    `错误信息：${msg || "连接意外中断"}`,
    ``,
    `可能诱因：`,
    ...causes.map((c) => `· ${c}`),
  ].join("\n");
}

interface ToolEvent {
  id: number;
  /** 原始 tool name（如 web_search、delegate:alice） */
  name: string;
  /** 用户可见标签（已语义化） */
  label: string;
  /** A-162：具体抓手（访问的网址 / 查询词 / 文件路径），供阶段卡工具行展示 */
  detail?: string;
  /** A-172：工具执行结果（上游已截断 200 字符；成功=返回内容，失败=失败原因表述） */
  result?: string;
}

/** 分组统计：按工具类型聚合 */
interface ToolGroup {
  type: string;
  label: string;
  Icon: React.ComponentType<IconProps>;
  count: number;
}

/** 计算工具分组统计 */
function computeToolGroups(events: ToolEvent[]): ToolGroup[] {
  const map = new Map<string, number>();
  for (const e of events) {
    const key = e.name.startsWith("delegate:") ? "delegate" : e.name;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries()).map(([type, count]) => {
    const { label, Icon } = resolveToolLabel(type);
    return { type, label, Icon, count };
  });
}

/** 格式化工具摘要行文本（不带图标——图标是 SVG 组件，文本流仅拼标签与计数） */
function formatToolSummary(events: ToolEvent[]): string {
  const groups = computeToolGroups(events);
  if (groups.length === 0) return "";
  if (groups.length === 1) {
    const g = groups[0];
    return g.count > 1 ? `${g.label} ×${g.count}` : g.label;
  }
  return groups.map((g) => `${g.label}×${g.count}`).join("，");
}

/** A-xxx（业界标准，对齐 LangChain/AI SDK parts 数组）：流式中按事件到达顺序增量构建交错时间线。
 * think 内容追加到当前 think 段；tool 事件追加独立 tool 段——工具与思考按真实顺序自然穿插，
 * 无需依赖「工具发生时 reasoning 长度」字符锚点回溯切分（锚点对中文/换行偏移脆弱，易错位粘连）。 */
function appendTimelineStep(
  steps: TimelineStep[],
  ev: { kind: "think"; text: string } | { kind: "tool"; name?: string; label?: string; detail?: string; result?: string },
): TimelineStep[] {
  if (ev.kind === "think") {
    if (!ev.text) { return steps; }
    const last = steps[steps.length - 1];
    // 末尾已是 think 段 → 追加；否则新开 think 段
    if (last && last.kind === "think") {
      return [...steps.slice(0, -1), { kind: "think", text: (last.text ?? "") + ev.text }];
    }
    return [...steps, { kind: "think", text: ev.text }];
  }
  return [...steps, { kind: "tool", name: ev.name, label: ev.label, detail: ev.detail, result: ev.result }];
}

interface ChatPanelProps {
  sessionId: string;
  sessionTitle: string;
  agentId: string;
  agentName?: string;
  modelChoice?: string;
  mode?: string;
  reasoningEffort?: string;
  /** 是否显示思考过程（f6：思考模式开关） */
  showThinking?: boolean;
  providerKeys?: string[];
  /** 供应商 → 已启用模型明细（聊天模型下拉列出所有启用的模型：api:<key>:<model>） */
  providerModels?: Array<{ key: string; models: Array<{ id: string; selected?: boolean; thinking?: boolean; thinking_efforts?: string[]; max_output?: number; context_window?: number; vision?: boolean }> }>;
  localModels?: Array<{ id: string; label: string }>;
  onModelChange?: (val: string) => void;
  onModeChange?: (val: string) => void;
  onReasoningChange?: (val: string) => void;
  onThinkingChange?: (val: boolean) => void;
  /** 会话列表变更通知（新对话/发送后刷新侧栏） */
  onConversationsChanged?: () => void;
  /** 会话重命名（工具栏 ✎） */
  onSessionRenamed?: (title: string) => void;
  /** 项目内新建会话请求（App 创建并切换） */
  onNewSessionRequested?: () => void;
  /** 跳转设置页子页（命令面板用） */
  onNavigateSettings?: (tab: "agents" | "providers" | "status") => void;
  /** 会话级工作目录（"以文件夹为主"：新建会话绑定的目标文件夹，Agent 读写锚定在此目录） */
  workspace?: string;
  /** 可切换 Agent 候选（会话内切换调用 Agent：同文件夹多 Agent 协作，避免同一 Agent 并发阻塞） */
  agents?: Array<{ id: string; name: string; role: string }>;
  /** 会话内切换调用 Agent（App 层持久化 setAgent 并刷新侧栏） */
  onAgentSwitch?: (agentId: string) => void;
  /** 团队会话成员 Agent id 列表（组长 = agentId；空 = 单人会话；一个会话 = 一个团队） */
  memberIds?: string[];
  /** 团队会话成员 Agent 名称（与 memberIds 同序；渲染徽章/群聊发言用） */
  memberNames?: string[];
  /** 成员名单变更（App 层持久化 setMembers 并刷新侧栏） */
  onMembersChanged?: (memberIds: string[]) => void;
  /** A-943：会话模式（brainstorm = 群聊头脑风暴；缺省 normal） */
  sessionType?: "normal" | "brainstorm";
  /** A-947：群聊成员总数（含会话归属 Agent；不含 = 0，群聊标题/徽章显示用） */
  memberCount?: number;
  /** A-943：会话模式切换（App 层持久化 setType 并刷新侧栏） */
  onTypeChanged?: (type: "normal" | "brainstorm") => void;
}

/** GUI 指令表（CLI 语义迁移） */
const COMMANDS: Array<{ cmd: string; desc: string; group: string; action: "delegate" | "fork" | "thinking" | "nav:status" | "nav:agents" | "nav:providers" | "new" | "rename" | "clear" | "help" }> = [
  { cmd: "/task", desc: "A2A 传唤已有 Agent 委派任务（结果整合回本会话）", group: "协作", action: "delegate" },
  { cmd: "/split", desc: "自分裂：创建子 Agent 实例多进程并行", group: "协作", action: "fork" },
  { cmd: "/thinking", desc: "切换推理强度：none / low / medium / high", group: "配置", action: "thinking" },
  { cmd: "/stats", desc: "打开状态面板（图表 + 表格）", group: "导航", action: "nav:status" },
  { cmd: "/agent", desc: "打开 Agent 管理", group: "导航", action: "nav:agents" },
  { cmd: "/providers", desc: "打开供应商设置", group: "导航", action: "nav:providers" },
  { cmd: "/new", desc: "项目内新建会话", group: "会话", action: "new" },
  { cmd: "/rename", desc: "重命名当前会话", group: "会话", action: "rename" },
  { cmd: "/clear", desc: "清空当前会话历史", group: "会话", action: "clear" },
  { cmd: "/help", desc: "显示全部指令", group: "会话", action: "help" },
];

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A-955 兜底：一次性剔除文本中的 <thinking>…</thinking> 思考段（main 已流式剥离，此为非流式/历史场景保险） */
function stripThinkingText(s: string): string {
  if (!s || !/<thinking/i.test(s)) { return s; }
  return s.replace(/<thinking(?:\s[^>]*)?>[\s\S]*?<\/thinking\s*>/gi, "").replace(/<thinking(?:\s[^>]*)?>[\s\S]*$/i, "");
}

/** A-966 渲染层兜底：正文展示前剥离思考标签 + 工具调用 XML 泄漏（<dots_function_call>/<invoke>/<parameter>）。
 *  流式途中标签可能跨 chunk 断裂，此处在单条 chunk 内尽力剥离；完整剥离由 done 全量清洗兜底。
 *  注意：本地正则实现（renderer 不引入 core-ts 依赖，避免浏览器构建打包主进程图谱）。 */
const TOOL_CALL_XML_RE = /<[a-z0-9_]*function_call[\s\S]*?<\/[a-z0-9_]*function_call\s*>|<invoke\b[\s\S]*?<\/invoke\s*>|<parameter\b[^>]*>[\s\S]*?<\/parameter\s*>|<(ignore|result|output|tool)\b[^>]*>\s*<\/\1\s*>/gi;
function stripPanelText(s: string): string {
  if (!s) { return s; }
  return stripThinkingText(s).replace(TOOL_CALL_XML_RE, "");
}

/** 路径 → 目录名（工具栏工作文件夹徽标；Windows 反斜杠/正斜杠均处理） */
function pathBaseLocal(p: string): string {
  const s = (p ?? "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** ISO 时间戳 → HH:MM（本地时区；历史消息显示用，解析失败回退当前时间） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) { return nowTime(); }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 耗时显示：<1s → ms；≥1s → s */
function fmtMs(ms: number): string {
  if (ms < 1000) { return `${Math.round(ms)}ms`; }
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 上下文消耗圆环（参考 A-C-C ContextRing）：绿 <60% / 黄 60-85% / 红 >85%，中心显示百分比 */
function ContextRing({ used, cap, loading }: { used: number; cap: number; loading: boolean }): JSX.Element {
  const ratio = contextRatio(used, cap);
  const pct = contextPct(ratio);
  const color = ringLevel(ratio).color;
  const R = 15;
  const C = 2 * Math.PI * R;
  const filled = C * ratio;
  return (
    <div
      title={`上下文消耗: ${used.toLocaleString()} / ${cap.toLocaleString()} tokens (${pct}%)${loading ? " · 生成中（数值随发送/收尾实时更新）" : ""}`}
      style={{ position: "relative", width: 40, height: 40, flexShrink: 0, marginLeft: "auto" }}
    >
      <svg width={40} height={40} viewBox="0 0 40 40" style={{ display: "block" }}>
        <circle cx={20} cy={20} r={R} fill="none" stroke="var(--border)" strokeWidth={3.5} />
        {ratio > 0 && (
          <circle
            cx={20} cy={20} r={R} fill="none"
            stroke={color} strokeWidth={3.5} strokeLinecap="round"
            strokeDasharray={`${filled} ${C - filled}`}
            transform="rotate(-90 20 20)"
          />
        )}
      </svg>
      <span style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "center",
        justifyContent: "center", fontSize: 9, fontWeight: 700, color: "var(--text)",
        pointerEvents: "none",
      }}>
        {/* A-935：流式输出中保留当前百分比（不再显示省略号）——监测是"实时可见"，非"未完成不可见"；
            仅完全无数据（新会话未发送）时显示占位 — */}
        {used > 0 ? `${pct}%` : "—"}
      </span>
    </div>
  );
}

/** 无框下拉选择器：统一向上/向下展开、fixed 定位不抖动、深色主题下拉（替代原生 select） */
interface GhostSelectOption {
  value: string;
  label: string;
  group?: string;
  /** 自定义 tooltip（省略时用 label） */
  title?: string;
  /** 选项前置图标（如审批档位图标） */
  icon?: React.ReactNode;
  /** 不可选（如未启用的模型：灰显+点击不切换，仅展示） */
  disabled?: boolean;
}

interface GhostSelectProps {
  value: string;
  options: GhostSelectOption[];
  onChange: (value: string) => void;
  title?: string;
  style?: CSSProperties;
  maxWidth?: number;
  /** 按钮显示文本覆盖（下拉选项仍用当前选中项 label；用于"推理"等带前缀/语义化按钮） */
  displayLabel?: string;
}

/** 格式化显示模型名：去掉 api:<key>/<key>::/ 等冗余前缀，避免下拉里显示又长又重复的字符串
 *  显示层兜底：label 最多 MAX_LABEL 字符，完整 ID 通过 tooltip 展示
 */
function prettyModelLabel(rawId: string, providerKey?: string, maxLabel = 64): string {
  const base = (rawId ?? "").trim();
  if (!base) return "";
  let s = base;
  // ① 拆 "provider::/real_model_id" 格式（保存时错误拼接的全限定残留）
  const m1 = s.match(/^([^\s:\/]{1,64})::\/(.+)$/);
  if (m1) {
    if (!providerKey || m1[1] === providerKey) s = m1[2]; // 同组前缀直接去掉
    else s = m1[2]; // 跨组也只要本体，前缀信息 tooltip 保留
  }
  // ② 去掉 "provider_key:" 前缀
  if (providerKey && s.startsWith(`${providerKey}:`) && s.length > providerKey.length + 1) {
    s = s.slice(providerKey.length + 1);
  }
  // ③ 去重复双前缀（"公益模型公益模型"这种脏数据）
  if (s.length > 4 && s.length % 2 === 0) {
    const half = s.length / 2;
    if (s.slice(0, half) === s.slice(half)) s = s.slice(0, half);
  }
  // ④ 统一最多展示 maxLabel 字符，超长 …
  return s.length > maxLabel ? `${s.slice(0, maxLabel)}…` : s;
}

function GhostSelect({ value, options, onChange, title, style, maxWidth = 260, displayLabel }: GhostSelectProps): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  const grouped = React.useMemo(() => {
    const map = new Map<string, GhostSelectOption[]>();
    for (const o of options) {
      const g = o.group ?? "";
      if (!map.has(g)) { map.set(g, []); }
      map.get(g)!.push(o);
    }
    return Array.from(map.entries());
  }, [options]);

  // 先渲染菜单（visibility:hidden 防闪），useLayoutEffect 测实际宽高后按视口边界定位
  React.useLayoutEffect(() => {
    if (!open) { return; }
    const el = btnRef.current;
    const menu = menuRef.current;
    if (!el || !menu) { return; }
    const r = el.getBoundingClientRect();
    const mh = Math.min(menu.offsetHeight, 320); // 菜单最高 320px
    const mw = Math.max(r.width + 40, Math.min(menu.scrollWidth + 16, Math.max(maxWidth, 360)));
    const up = r.top >= mh + 8 || r.bottom + mh + 8 > window.innerHeight;
    let left = r.left;
    if (left + mw > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - mw - 8);
    }
    setPos(up
      ? { top: Math.max(8, r.top - mh + 4), left, width: mw, up: true }
      : { top: r.bottom + 4, left, width: mw, up: false });
  }, [open, maxWidth]);

  React.useEffect(() => {
    if (!open) { return; }
    const onDocDown = (e: MouseEvent): void => {
      if (btnRef.current?.contains(e.target as Node)) { return; }
      if (menuRef.current?.contains(e.target as Node)) { return; }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { setOpen(false); }
    };
    // 记录按钮初始位置，只有按钮位置明显变化时才关闭（position:fixed 下拉不受父容器滚动影响）
    const btnRect = btnRef.current?.getBoundingClientRect();
    const btnTop0 = btnRect?.top ?? 0;
    const btnLeft0 = btnRect?.left ?? 0;

    const onScroll = (e: Event): void => {
      // 滚动发生在下拉菜单内部 → 不关闭
      const target = e.target as Node | null;
      if (menuRef.current?.contains(target)) { return; }
      // 按钮位置未明显变化（父容器滚动但 fixed 定位不受影响）→ 不关闭
      const cur = btnRef.current?.getBoundingClientRect();
      if (cur && Math.abs(cur.top - btnTop0) < 2 && Math.abs(cur.left - btnLeft0) < 2) { return; }
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="tool-select-ghost"
        title={title ?? current?.label ?? value}
        style={style}
        onClick={() => setOpen((o) => !o)}
      >
        {displayLabel ?? (current ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {current.icon}{current.label}
          </span>
        ) : value)}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="ghost-dropdown"
          data-up={pos?.up}
          style={pos
            ? { top: pos.top, left: pos.left, width: pos.width }
            : { visibility: "hidden", top: 0, left: 0 }}
        >
          {grouped.map(([group, items]) => (
            <React.Fragment key={group || "__ungrouped__"}>
              {group && <div className="ghost-dropdown-group-label">{group}</div>}
              {items.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  title={o.title ?? o.label}
                  className={`ghost-dropdown-item${o.value === value ? " active" : ""}${o.disabled ? " disabled" : ""}`}
                  style={{
                    display: "block", width: "100%", textAlign: "left", boxSizing: "border-box",
                    opacity: o.disabled ? 0.45 : 1,
                    cursor: o.disabled ? "not-allowed" : "pointer",
                  }}
                  disabled={o.disabled}
                  onClick={() => { if (o.disabled) { return; } onChange(o.value); setOpen(false); }}
                >
                  {o.label}
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 用户消息（memo：流式输出时历史消息不重渲染） */
const UserMessage = React.memo(function UserMessage({ m, onRollback }: { m: Message; onRollback?: (id: number) => void }): JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(m.content); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const cap = m.mode ? m.mode.charAt(0).toUpperCase() + m.mode.slice(1) : "";
  return (
    <div className="msg-row" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 14 }}>
      <div style={{
        maxWidth: "78%", padding: "10px 14px",
        borderRadius: "16px 16px 4px 16px",
        background: "var(--accent)", color: "#fff",
        lineHeight: 1.55, fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word",
        userSelect: "text",
      }}>
        {/* 随消息回显的图片缩略图（data URL；点击可新窗口查看大图） */}
        {m.images != null && m.images.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: m.content ? 8 : 0, justifyContent: "flex-end" }}>
            {m.images.map((u, i) => (
              <img
                key={`${u.slice(0, 24)}-${i}`}
                src={u}
                alt={`图片 ${i + 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(u, "_blank");
                }}
                style={{
                  width: 72, height: 72, objectFit: "cover", borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.25)", cursor: "zoom-in",
                }}
              />
            ))}
          </div>
        )}
        {m.content}
      </div>
      {/* 悬停元信息行：模式 · 模型 · 时间 + 回滚/复制（hover 时出现） */}
      <div className="msg-hover" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
        {cap && <span style={{ fontWeight: 600 }}>{cap}</span>}
        {m.model && <span>· {m.model}</span>}
        <span>· {m.time}</span>
        {onRollback && (
          <button onClick={() => onRollback(m.id)} title="回滚：撤销此消息及之后的对话（内容放回输入框）"
            style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, color: "var(--text-dim)", display: "inline-flex" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}>
            <RotateIcon size={12} />
          </button>
        )}
        <button onClick={() => void handleCopy()} title={copied ? "已复制" : "复制消息"}
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, color: "var(--text-dim)", display: "inline-flex" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}>
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        </button>
      </div>
    </div>
  );
});

/** 规范化思考文本：单换行合并为空格（模型逐 token 输出带单换行），双换行保留为段落分隔。
 *  避免 white-space: pre-wrap 把逐词换行全部保留导致"每个字独占一行"。 */
/** 摘要用：把 markdown 符号剥离成纯文本（时间线思考步的折叠标题，避免暴露 * # | 等底层符号） */
function stripMarkdown(text: string): string {
  return text
    .replace(/`{1,4}/g, "")
    .replace(/[#*_>|~]{1,3}/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeThinkingText(text: string): string {
  // 先按 \n\n 分段 → 段内单 \n 合并为空格 → 段间保留 \n\n
  return text
    .split(/\n\s*\n/)
    .map(seg => seg.replace(/[ \t]*\n[ \t]*/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter(seg => seg.length > 0)
    .join("\n\n");
}

/** A-923：思考过程整体净化——① 剥离 XML 风格工具调用残留（<parameter>/<function>/<tool_call>/<result> 等
 *  半成品标签，模型把预训练 XML 工具格式泄进 reasoning，样例：</parameter name="test_file.txt"> 直接露出）；
 *  ② 归一空白（逐词断行/多余空格合并）。输出为可读纯文本，供思考卡与最终 reasoning 折叠卡。 */
function sanitizeThinking(text: string): string {
  const stripped = (text ?? "")
    .replace(/<\/?(?:parameter|function|tool_call|result|safety|safety_check|ban_message|reasoning|system)\b[^>]*>/gi, "");
  return normalizeThinkingText(stripped)
    // A-924：收敛词间空格观感——中文标点前不得留空格、开括号后不得留空格（上游 token 级空格常见 `好 的 ， 我`）
    .replace(/\s+([，。；：！？、）》】）])/g, "$1")
    .replace(/([（《【])\s+/g, "$1")
    // A-928：思考区英文 token 分词收敛（`B ing`/`S tudio`/`n a n o b ot` → 拼合）——思考为私有展示，体验优先
    .replace(/([A-Za-z0-9])\s+([A-Za-z0-9])/g, "$1$2");
}

/** 把文本内的 http(s) url 渲染为可点击链接（点击 → 右侧栏新建浏览器页）。
 *  用于思考/结果等纯文本展示，避免换行被 Markdown 段落合并压掉（A-174）。 */
function renderTextWithLinks(text: string): React.ReactNode[] {
  const urlRe = /https?:\/\/[^\s)\]}>，。；：""''、]+/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  urlRe.lastIndex = 0;
  while ((m = urlRe.exec(text)) !== null) {
    if (m.index > last) {
      out.push(<React.Fragment key={`t${k++}`}>{text.slice(last, m.index)}</React.Fragment>);
    }
    const url = m[0];
    out.push(
      <a
        key={`u${k++}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          requestSidebarOpen({ kind: "url", url });
        }}
        style={{ color: "var(--accent-hover)", textDecoration: "underline", wordBreak: "break-all" }}
      >
        {url}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(<React.Fragment key={`t${k}`}>{text.slice(last)}</React.Fragment>);
  }
  return out;
}

/** A-918++：简化行级 diff（LCS 动态规划），输出 (- 删除 / + 新增 / = 相同) 三态
 *  用于 file_write 等工具结果展开时显示 VS Code 风格红绿行块；O(n·m) 适合 <2k 行的编辑 */
function simpleDiffLines(a: string, b: string): Array<{ op: "=" | "+" | "-"; text: string }> {
  const aLines = a.length ? a.split("\n") : [""];
  const bLines = b.length ? b.split("\n") : [""];
  const n = aLines.length, m = bLines.length;
  // 极小文件直接全 + 全 -（避免 O(n·m) 内存爆炸）
  if (n * m > 200000) {
    return [
      ...aLines.map((t) => ({ op: "-" as const, text: t })),
      ...bLines.map((t) => ({ op: "+" as const, text: t })),
    ];
  }
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) { dp.push(new Uint32Array(m + 1)); }
  for (let i = 1; i <= n; i++) {
    const ai = aLines[i - 1];
    const row = dp[i], prev = dp[i - 1];
    for (let j = 1; j <= m; j++) { row[j] = ai === bLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]); }
  }
  const out: Array<{ op: "=" | "+" | "-"; text: string }> = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) { out.push({ op: "=", text: aLines[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { out.push({ op: "+", text: bLines[j - 1] }); j--; }
    else { out.push({ op: "-", text: aLines[i - 1] }); i--; }
  }
  return out.reverse();
}

/** A-918++：diff 块渲染组件（VS Code 风格：行首 +/- 标识 + 整行红绿背景 + 等宽字体） */
const DiffBlock = React.memo(function DiffBlock({ oldText, newText }: { oldText: string; newText: string }): JSX.Element {
  const lines = React.useMemo(() => simpleDiffLines(oldText, newText), [oldText, newText]);
  let adds = 0, dels = 0;
  for (const l of lines) { if (l.op === "+") adds++; else if (l.op === "-") dels++; }
  return (
    <div className="think-diff-block" style={{ marginTop: 6 }}>
      <div className="think-diff-header">
        <span style={{ color: "var(--success)" }}>+{adds}</span>
        <span style={{ color: "var(--danger)", marginLeft: 6 }}>−{dels}</span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)" }}>vs 原内容</span>
      </div>
      <div className="think-diff-body">
        {lines.map((l, i) => (
          <div key={i} className={`think-diff-row diff-${l.op === "=" ? "eq" : l.op === "+" ? "add" : "del"}`}>
            <span className="think-diff-mark">{l.op === "=" ? " " : l.op === "+" ? "+" : "−"}</span>
            <span className="think-diff-text">{l.text || "\u00A0"}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

/** 时间线节点组件（A-171：思考段落直接正文显示，工具调用为小型可折叠行；detail 可点击在右侧栏打开） */
const TimelineNode = React.memo(function TimelineNode({ step, autoExpand }: { step: TimelineStep; autoExpand?: boolean }): JSX.Element {
  // hooks 必须在每次渲染同序调用（React 规则，否则条件返回导致渲染崩溃/黑屏）：
  const [expanded, setExpanded] = React.useState(Boolean(autoExpand));
  // 思考步：可展开条目——摘要行（去 markdown 符号）默认收起，展开后按 Markdown 渲染全文
  if (step.kind === "think" && step.text) {
    // 旧格式残留清理：「### 工具调用记录」及其后续标记段（增量时间线本身不会产生，仅防御历史数据）
    const cleanThink = sanitizeThinking(step.text.replace(/\n?### 工具调用记录\n[\s\S]*$/g, ""));
    if (!cleanThink.trim()) { return <span style={{ display: "none" }} />; }
    const preview = stripMarkdown(normalizeThinkingText(cleanThink)).slice(0, 120);
    return (
      <div className="think-step">
        <button
          className="think-step-toggle"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "收起这段思考" : "展开这段思考（Markdown 渲染）"}
          style={{
            display: "flex", alignItems: "center", gap: 6, width: "100%",
            background: "transparent", border: "none", cursor: "pointer", padding: 0, textAlign: "left",
          }}
        >
          <span className="think-step-mark" style={{ flexShrink: 0 }} />
          <ChevronIcon size={12} rotate={expanded ? 90 : 0} style={{ flexShrink: 0, color: "var(--text-dim)", transition: "transform 0.18s" }} />
          <span style={{
            fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0,
          }}>
            {preview || "思考…"}{(cleanThink.length > 120) ? "…" : ""}
          </span>
        </button>
        {expanded && (
          <div className="think-step-text" style={{ marginTop: 4 }}>
            <Markdown text={cleanThink} />
          </div>
        )}
      </div>
    );
  }
  // 工具调用：小型行 + 折叠详情（含结果：成功显示访问/编辑内容，失败显示失败原因）
  const tool = step as TimelineStep & { kind: "tool" };
  const { Icon } = resolveToolLabel(tool.name ?? "");
  const isCmd = /bash|terminal|exec|command|code_check|\.py|npm|pip|git /i.test(tool.name ?? "");
  const isDelete = /delete|remove|rm|del/i.test(tool.name ?? "");
  const isWrite = /write|edit|create|save|generate/i.test(tool.name ?? "");
  const isSearch = /search|fetch/i.test(tool.name ?? "");
  const isRead = /read|list|get/i.test(tool.name ?? "");
  const toolCat = isCmd ? "执行命令" : isDelete ? "删除" : isWrite ? "写入" : isSearch ? "网页访问" : isRead ? "读取" : "";
  const statusColor = isCmd ? "#a78bfa" : isDelete ? "#f87171" : isWrite ? "#34d399" : isSearch ? "#60a5fa" : isRead ? "#fbbf24" : "var(--text-dim)";
  // A-172：结果状态判定——失败类前缀显红（沙箱拒绝/未找到/错误），其余视作成功
  // A-918++：先剥离 file_write 嵌入的 [__slime_diff__]old|new[/__slime_diff__] 标记
  // （base64 隐藏在 result 文本里供 diff 渲染，剥离后不影响 isFail 判定与正常显示）
  const rawResult = (tool.result ?? "");
  let oldForDiff: string | null = null, newForDiff: string | null = null;
  let displayResult = rawResult;
  const diffMatch = /\[__slime_diff__\]([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)\[\/__slime_diff__\]/.exec(rawResult);
  if (diffMatch) {
    try {
      oldForDiff = Buffer.from(diffMatch[1], "base64").toString("utf-8");
      newForDiff = Buffer.from(diffMatch[2], "base64").toString("utf-8");
    } catch { /* base64 损坏则忽略 diff */ }
    displayResult = rawResult.replace(diffMatch[0], "").trim();
  }
  const r = displayResult.trim();
  const isFail = r.length > 0 && /^(\[|💥|❌|✕|错误|失败|拒绝|未找到|no such|not found|error|failed|denied|exception)/i.test(r);
  const hasBody = !!tool.detail || !!r;
  const statusLabel = !r ? (isWrite ? "已执行" : "调用中") : isFail ? "失败" : "成功";
  const statusTitle = isFail ? "执行失败" : "执行成功";
  // A-174：detail 是可点击抓手——file_* 为文件路径（点击→右侧建文件页），http(s) 为网址（点击→右侧建浏览器页）；
  // 查询词（web_search 的“查询: xxx”）不是文件也不是网址，仅作展示不可点击
  const isQueryDetail = /^查询[:：]/.test(tool.detail ?? "");
  const isUrlDetail = /^https?:\/\//i.test(tool.detail ?? "");
  const detailClickable = !!tool.detail && !isQueryDetail;
  const onClickDetail = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!tool.detail || !detailClickable) { return; }
    if (isUrlDetail) {
      requestSidebarOpen({ kind: "url", url: tool.detail });
    } else {
      requestSidebarOpen({ kind: "file", rel: tool.detail!, name: tool.detail!.split(/[\\/]/).pop() });
    }
  };
  return (
    <div className="think-tool-node">
      <div className="think-tool-mark" style={{ background: isFail ? "#f87171" : statusColor }} />
      <div className="think-tool-btn" data-status={isFail ? "fail" : "ok"} style={{ display: "flex", flexWrap: "nowrap", alignItems: "center", gap: 5 }}>
        <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
          <Icon size={12} style={{ color: isFail ? "#f87171" : "var(--accent-hover)" }} />
        </span>
        <span className="think-tool-name" style={{ flexShrink: 0 }}>{tool.label}</span>
        {toolCat && (
          <span className="think-tool-cat" style={{
            fontSize: 10, flexShrink: 0, padding: "1px 5px", borderRadius: 7, lineHeight: 1.4,
            background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text-dim)",
          }}>{toolCat}</span>
        )}
        {tool.detail && (detailClickable ? (
          <a
            className="think-tool-detail"
            href={isUrlDetail ? tool.detail : "#"}
            target="_blank"
            rel="noreferrer"
            onClick={onClickDetail}
            title={`点击在右侧栏${isUrlDetail ? "打开网页" : "打开文件"}`}
            style={{ cursor: "pointer", textDecoration: "underline dotted", color: "var(--accent-hover)" }}
          >
            {tool.detail.slice(0, 120)}{(tool.detail ?? "").length > 120 ? "…" : ""}
          </a>
        ) : (
          <span className="think-tool-detail" style={{ color: "var(--text-muted)" }}>{tool.detail}</span>
        ))}
        <span
          className="think-tool-status"
          style={{ color: isFail ? "#f87171" : statusColor, flexShrink: 0 }}
          title={statusTitle}
        >{statusLabel}</span>
        {hasBody && (
          <button
            onClick={() => setExpanded(!expanded)}
            title={expanded ? "收起详情" : "展开详情"}
            style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, display: "inline-flex", flexShrink: 0 }}
          >
            <ChevronIcon size={12} rotate={expanded ? 90 : 0} style={{ color: "var(--text-dim)", transition: "transform 0.2s" }} />
          </button>
        )}
      </div>
      {expanded && hasBody && (
        <div className="think-tool-detail-box">
          {tool.detail && (
            <div className="think-tool-detail-line">
              {isUrlDetail
                ? <InternetIcon size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
                : <FileTypeIcon filename={tool.detail} size={13} style={{ flexShrink: 0, opacity: 0.92 }} />}
              {detailClickable ? (
                <span className="think-clickable" onClick={onClickDetail} title={`点击在右侧栏${isUrlDetail ? "打开网页" : "打开文件"}`}>
                  {tool.detail.slice(0, 300)}{(tool.detail ?? "").length > 300 ? "…" : ""}
                </span>
              ) : (
                <span>{tool.detail.slice(0, 300)}{(tool.detail ?? "").length > 300 ? "…" : ""}</span>
              )}
            </div>
          )}
          {/* A-918++：VS Code 风格 diff 块（- 删除 / + 新增 / = 相同），行首 +/- 标识 + 整行红绿背景 */}
          {oldForDiff !== null && newForDiff !== null && (
            <DiffBlock oldText={oldForDiff} newText={newForDiff} />
          )}
          {r && (
            <div style={{ marginTop: tool.detail ? 6 : 0, color: isFail ? "#f87171" : "var(--text-muted)", whiteSpace: "pre-wrap", wordBreak: "break-word", display: "flex", alignItems: "flex-start", gap: 4 }}>
              {isFail
                ? <CloseIcon size={12} style={{ color: "#f87171", flexShrink: 0, marginTop: 2 }} />
                : <CheckIcon size={12} style={{ color: "#34d399", flexShrink: 0, marginTop: 2 }} />}
              <span style={{ flex: 1 }}>{renderTextWithLinks(normalizeBrokenLines(r).slice(0, 600))}{r.length > 600 ? "…" : ""}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** 参考内容折叠面板（A-171：独立于思考时间线，只含工作目录文件，可折叠收起） */
function RefPanel({ files }: { files: Array<{ path: string | undefined; label: string }> }): JSX.Element {
  // A-174：参考内容默认收起（点击标题展开浏览）；与「思考过程」完全独立，互不联动
  const [open, setOpen] = React.useState(false);
  return (
    <div className="think-card" style={{ marginBottom: 4 }}>
      <button className="think-card-title" onClick={() => setOpen(!open)}
        style={{ width: "100%", background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        <RefFileIcon size={13} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
        <span>参考内容</span>
        <span className="think-count">（{files.length} 项）</span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)", display: "inline-flex" }}>
          <ChevronIcon size={12} rotate={open ? 90 : 0} style={{ transition: "transform 0.2s" }} />
        </span>
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 6 }}>
          {files.map((r, i) => (
            <div key={`r${i}`} className="think-item" title={r.path}
              style={{ cursor: r.path ? "pointer" : "default" }}
              onClick={(e) => {
                if (!r.path) { return; }
                e.stopPropagation();
                requestSidebarOpen({ kind: "file", rel: r.path, name: r.path.split(/[\\/]/).pop() });
              }}>
              <CheckIcon size={12} style={{ color: "#34d399", flexShrink: 0 }} />
              <FileTypeIcon filename={r.path ?? r.label} size={14} style={{ flexShrink: 0, opacity: 0.92 }} />
              <span className="t-file">{r.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 网址面板（A-918+：网页访问/搜索的网址——此前收集到 stages.urls 却从未渲染，丢失来源展示） */
/** 网址面板（A-918+：网页访问/搜索的网址——此前收集到 stages.urls 却从未渲染，丢失来源展示；
 *  使用真实 https://{host}/favicon.ico 作为网址专属图标，失败回退 InternetIcon） */
function UrlPanel({ urls }: { urls: Array<{ url: string; label: string }> }): JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="think-card" style={{ marginBottom: 4 }}>
      <button className="think-card-title" onClick={() => setOpen(!open)}
        style={{ width: "100%", background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        <InternetIcon size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
        <span>访问来源</span>
        <span className="think-count">（{urls.length} 项）</span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)", display: "inline-flex" }}>
          <ChevronIcon size={12} rotate={open ? 90 : 0} style={{ transition: "transform 0.2s" }} />
        </span>
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 6 }}>
          {urls.map((u, i) => {
            const host = ((): string => {
              try { return new URL(/^https?:\/\//i.test(u.url) ? u.url : `https://${u.url}`).hostname; }
              catch { return ""; }
            })();
            const clickable = /^https?:\/\//i.test(u.url);
            return <UrlPanelRow key={`u${i}`} u={u} host={host} clickable={clickable} />;
          })}
        </div>
      )}
    </div>
  );
}

/** 单行网址：真 favicon 加载失败时回退 InternetIcon */
function UrlPanelRow({ u, host, clickable }: { u: { url: string; label: string }; host: string; clickable: boolean }): JSX.Element {
  const [faviconFailed, setFaviconFailed] = React.useState(false);
  return (
    <div className="think-item" title={u.url}
      style={{ cursor: clickable ? "pointer" : "default" }}
      onClick={(e) => {
        if (!clickable) { return; }
        e.stopPropagation();
        requestSidebarOpen({ kind: "url", url: u.url, name: host || u.label });
      }}>
      {host && !faviconFailed
        ? // eslint-disable-next-line jsx-a11y/alt-text
          <img src={`https://${host}/favicon.ico`} alt="" width={12} height={12}
            style={{ flexShrink: 0, borderRadius: 2, background: "var(--bg)" }}
            onError={() => setFaviconFailed(true)} />
        : <InternetIcon size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />}
      <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontWeight: 600 }}>{host || "查询"}</span>
      <span className="t-file">{u.label || u.url}</span>
    </div>
  );
}

/** 思考过程折叠面板（A-174：与参考内容互相独立——展开/收起互不影响，各自记忆自己的状态） */
const ThinkingPanel = React.memo(function ThinkingPanel({ timeline }: { timeline: TimelineStep[] }): JSX.Element {
  const [open, setOpen] = React.useState(true);
  return (
    <div className="think-card">
      <button className="think-card-title" onClick={() => setOpen(!open)}
        style={{ width: "100%", background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        <BrainThinkingIcon size={13} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
        <span>思考过程</span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)", display: "inline-flex" }}>
          <ChevronIcon size={12} rotate={open ? 90 : 0} style={{ transition: "transform 0.2s" }} />
        </span>
      </button>
      {open && (
        <div className="think-timeline" style={{ marginTop: 6 }}>
          {timeline.map((step, i) => (
            <TimelineNode key={`s${i}`} step={step} />
          ))}
        </div>
      )}
    </div>
  );
});

/** Agent 消息（memo：流式输出时历史消息不重渲染；折叠态变化时按需重渲染）
 *  isMember=true 表示该条为团队会话成员发言（群聊气泡，与组长整合回复并列展示） */
const AssistantMessage = React.memo(function AssistantMessage({ m, agentName, showThinking, collapsed, onToggle, isMember }: {
  m: Message; agentName: string; showThinking: boolean; collapsed: boolean; onToggle: (id: number) => void; isMember?: boolean;
}): JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(m.content); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const cap = m.mode ? m.mode.charAt(0).toUpperCase() + m.mode.slice(1) : "";
  return (
    <div className="msg-row" style={{ display: "flex", gap: 10, marginBottom: 18 }}>
      <div style={{
        width: 32, height: 32, borderRadius: "50%", flexShrink: 0, marginTop: 2,
        background: isMember ? "var(--bg-input)" : "var(--accent-soft)",
        color: isMember ? "var(--accent-hover)" : "var(--accent)",
        border: isMember ? "1px solid var(--border)" : "none",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 15, fontWeight: 700,
      }}>
        {agentName.charAt(0)}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: isMember ? "var(--accent-hover)" : "var(--text-muted)", display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
          <span>{agentName}</span>
          {isMember && (
            <span style={{
              fontSize: 10, fontWeight: 700, flexShrink: 0,
              padding: "0 6px", borderRadius: 8,
              background: "var(--bg-input)", border: "1px solid var(--border)",
              color: "var(--text-muted)",
            }}>成员</span>
          )}
        </div>
        {/* 悬停元信息行：复制 + 模式 · 模型 · 耗时/时间（hover 时出现） */}
        <div className="msg-hover" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>
          <button onClick={() => void handleCopy()} title={copied ? "已复制" : "复制回复"}
            style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, color: "var(--text-dim)", display: "inline-flex" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}>
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          </button>
          {cap && <span style={{ fontWeight: 600 }}>{cap}</span>}
          {m.model && <span>· {m.model}</span>}
          <span>· {m.elapsedMs != null ? <>回复耗时 {fmtMs(m.elapsedMs)}</> : m.time}</span>
          {showThinking && (m.reasoning || (m.stages?.timeline && m.stages.timeline.length > 0) || (m.stages?.tools && m.stages.tools.length > 0)) && (
            <button onClick={() => onToggle(m.id)}
              title={collapsed ? "展开思考过程" : "收起思考过程"}
              style={{
                background: collapsed ? "var(--bg-hover)" : "var(--accent-soft)",
                border: "none", cursor: "pointer", padding: "2px 6px",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                gap: 3, borderRadius: 10,
                color: collapsed ? "var(--text-muted)" : "var(--accent-hover)",
                fontSize: 11, fontWeight: 600,
              }}>
              <ChevronIcon size={12} rotate={collapsed ? 0 : 90} />
              <span>思考</span>
            </button>
          )}
        </div>
        {/* A-174：思考过程展开区——参考内容 与 思考过程 是两个互相独立的折叠面板 */}
        {showThinking && !collapsed && (() => {
          const localFiles = m.stages?.reads ?? [];
          const localUrls = m.stages?.urls ?? [];
          const tools = m.stages?.tools ?? [];
          // 交错时间线：优先使用流式记录的真实顺序；历史消息（无 timeline）回退为「完整思考 + 工具列表」
          const cleanReasoning = (m.reasoning ?? "").replace(/\n?### 工具调用记录\n[\s\S]*$/g, "");
          const timeline: TimelineStep[] = m.stages?.timeline?.length
            ? m.stages.timeline
            : [
                ...(cleanReasoning.trim() ? [{ kind: "think" as const, text: cleanReasoning }] : []),
                ...tools.map((t) => ({ kind: "tool" as const, name: t.name, label: t.label.replace(/^⟳\s*/, ""), detail: t.detail })),
              ];
          if (timeline.length === 0 && localFiles.length === 0 && localUrls.length === 0) return null;
          return (
            <div style={{ margin: "8px 0 2px" }}>
              {/* 面板零：访问来源（网页访问/搜索网址，A-918+ 补齐此前未渲染的 urls） */}
              {localUrls.length > 0 && (
                <UrlPanel urls={localUrls} />
              )}
              {/* 面板一：参考内容（只含工作目录文件；独立折叠，与思考过程互不影响） */}
              {localFiles.length > 0 && (
                <RefPanel files={localFiles} />
              )}
              {/* 面板二：思考过程（时间线：思考段落 ↔ 工具调用交错；独立折叠） */}
              {timeline.length > 0 && (
                <ThinkingPanel timeline={timeline} />
              )}
            </div>
          );
        })()}
        <div className="msg-body-divider" />
        {m.error ? (
          <div style={{
            borderLeft: "3px solid var(--danger)",
            background: "var(--danger-soft)",
            borderRadius: 8, padding: "10px 12px",
            fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word",
            color: "#f87171",
          }}>
            {m.content}
          </div>
        ) : (
          <div style={{ lineHeight: 1.7, fontSize: 14, color: "var(--text)", wordBreak: "break-word" }}>
            {m.content ? (() => {
              // 剥离 ### 工具调用记录 段（旧格式残留，已由独立卡片展示）
              const cleanContent = m.content.replace(/\n?### 工具调用记录\n[\s\S]*?(?=\n###|\n\n###|$)/g, "").trim();
              return <Markdown text={cleanContent} />;
            })() : null}
          </div>
        )}
      </div>
    </div>
  );
});

export default function ChatPanel({
  sessionId,
  sessionTitle,
  agentId,
  agentName = "slime 助手",
  modelChoice = "inherit",
  mode = "build",
  reasoningEffort = "none",
  showThinking = true,
  providerKeys = [],
  providerModels = [],
  localModels = [],
  onModelChange,
  onModeChange,
  onReasoningChange,
  onThinkingChange,
  onConversationsChanged,
  onSessionRenamed,
  onNewSessionRequested,
  onNavigateSettings,
  workspace,
  agents = [],
  onAgentSwitch,
  sessionType,
  memberCount,
  memberNames = [],
}: ChatPanelProps): JSX.Element {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [partial, setPartial] = React.useState("");
  // A-918++：输入框占位符动态激励语（每 6s 切换一句，激励/调侃/颜文字混搭；用户聚焦输入时暂停）
  const PLACEHOLDER_PHRASES = [
    "今天想折腾点什么？Σ(°△°|||)",
    "问个问题，唤醒你的第二个大脑～ (●'◡'●)",
    "把你想做的说出来，我帮你拆成可执行计划 ✨",
    "代码读不懂？设计拿不准？丢过来我陪你过 🔍",
    "工作累了？来调戏我两句 (ˉ▽ˉ) ﾉ",
    "输入消息… Enter 发送，/ 展开指令，Shift+Enter 换行",
    "想调研什么 / 写什么 / 改什么？说话就行 🚀",
    "提示：可粘贴 / 拖拽图片识图，文件路径直接拖进来更省心",
  ];
  const [placeholderIndex, setPlaceholderIndex] = React.useState(0);
  const [inputFocused, setInputFocused] = React.useState(false);
  React.useEffect(() => {
    // A-918++：加速 4s 切换 + 输入聚焦才暂停（loading/会话切不再锁死，让用户更快看到变化）
    if (inputFocused) { return; }
    const iv = window.setInterval(() => { setPlaceholderIndex((i) => (i + 1) % PLACEHOLDER_PHRASES.length); }, 4000);
    return () => window.clearInterval(iv);
  }, [inputFocused]);
  /** 流式正文渲染节流：数据实时累积到 ref，渲染按 rAF 逐字推进（28ms/字），避免整块蹦出 + 每 chunk 全量重解析 markdown 卡顿 */
  const partialRef = React.useRef("");
  const partialRafRef = React.useRef<number | null>(null);
  // A-918++：逐字限速缓冲——partialRef 累积模型完整文本，displayPartialRef 逐字推进（每 28ms 1 字），
  // 正文"逐字渐入"（ChatGPT/Claude 式），不再"整个块蹦出"；onDone/reset 时清空
  const displayPartialRef = React.useRef("");
  const lastTypingAtRef = React.useRef(0);
  const schedulePartialRender = React.useCallback(() => {
    if (partialRafRef.current !== null) { return; }
    partialRafRef.current = window.requestAnimationFrame(() => {
      partialRafRef.current = null;
      // 逐字推进：每 28ms 追加 1 字符（限速打字；模型快时 buffer 在 partialRef 堆积，完成后 onDone 补全）
      const full = partialRef.current;
      const shown = displayPartialRef.current;
      if (shown.length < full.length) {
        const now = Date.now();
        if (now - lastTypingAtRef.current >= 28) {
          displayPartialRef.current = full.slice(0, shown.length + 1);
          lastTypingAtRef.current = now;
        }
      }
      setPartial(displayPartialRef.current);
      // 随 rAF 一并刷新 token 计数，避免每 chunk 独立 setState 触发重渲染
      setStreamTokens(streamTokensRef.current);
      // A-918++：实时 context tokens 估算（历史消息 + 当前 partial 总字符 / 4），rAF 驱动 → 流式输出/压缩都实时反映
      let ctxChars = 0;
      for (const mm of messagesRef.current) { ctxChars += mm.content?.length ?? 0; }
      ctxChars += partialRef.current.length;
      setContextTokens(Math.max(0, Math.round(ctxChars / 4)));
      // 推理过程同样走 rAF（A-129：去掉 reasoning 分支每 chunk 一次 setReasoningTmp）
      setReasoningTmp(reasoningTmpRef.current);
      // A-xxx：交错时间线快照同步（增量 steps 数组——引用不可变，必须快照新数组触发渲染）
      setLiveTimeline(timelineStepsRef.current);
      // A-968：切回恢复的占位气泡随 partial 实时续长——冻结的"（恢复中…）"会造成
      // "中断 + 底部重新输出一遍"的观感；此处把占位气泡内容绑定实际流内容
      const liveId = snapshotMsgIdRef.current;
      if (liveId !== null) {
        setMessages((prev) => {
          if (!prev.some((m) => m.id === liveId)) { return prev; }
          return prev.map((m) => (m.id === liveId ? { ...m, content: partialRef.current || "（恢复中…）" } : m));
        });
      }
      // A-918++：自续——若 partialRef 还有未显示字符（buffer 堆积，模型快于打字），下一帧继续推进，直到追平
      if (displayPartialRef.current.length < partialRef.current.length) {
        partialRafRef.current = null;
        schedulePartialRender();
      }
    });
  }, []);
  const resetPartial = React.useCallback(() => {
    if (partialRafRef.current !== null) {
      window.cancelAnimationFrame(partialRafRef.current);
      partialRafRef.current = null;
    }
    partialRef.current = "";
    displayPartialRef.current = ""; // A-918++：清空逐字缓冲
    lastTypingAtRef.current = 0;
    setPartial("");
  }, []);
  /** f6：推理/思考过程内容（独立于正文字，输出中实时流式、完成后可主动展开查看） */
  const [reasoningTmp, setReasoningTmp] = React.useState("");
  const [reasoningOpen, setReasoningOpen] = React.useState(true);
  /** 推理过程读写走 ref，避免订阅 effect 因 chunk 高频重订阅 */
  const reasoningTmpRef = React.useRef("");
  const reasoningManuallyToggledRef = React.useRef(false);

  // A-918++：可变思考提示语（loading 时 5 种轮播）+ 字体呼吸（CSS .thinking-hint-text 的 textBreathe）
  // 让用户感受到 Agent 在"主动思考"而非"卡住"，对齐主流 Agent 平台的活跃指示体验。
  // A-918++：用户要求删掉顶部"思考中"轮播，THINKING_HINTS/hintIndex 保留以备后续重新启用
  /** 渲染用延迟值（A-129）：流式 markdown 解析较重型，useDeferredValue 让 React
      在主线程繁忙（滚动 / 长文本解析）时自动降级刷新，滚动帧率与点击响应不被解析卡死；
      历史消息行已 memo，真正会受影响的只有正在流式输出的那一行 */
  const deferredPartial = React.useDeferredValue(partial);
  const [toolEvents, setToolEvents] = React.useState<ToolEvent[]>([]);
  /**
   * A-xxx：增量有序时间线（业界标准做法，参考 LangChain/AI SDK `parts` 数组）——
   * 不再把思考文本拼成字符串后用「字符锚点」回溯切分（锚点对中文/换行/剪贴偏移极为脆弱，
   * 是工具调用记录错位、段落粘连换行错乱的根因）。
   * 改为边接收边 append：reasoning chunk 追加到当前 thinking 段，tool 事件追加 tool 段，
   * 按事件真实到达顺序自然交错，天然保留原始换行。
   */
  const timelineStepsRef = React.useRef<TimelineStep[]>([]);
  /** 渲染快照（50ms 节流内批量刷新；由 schedulePartialRender 同步） */
  const [liveTimeline, setLiveTimeline] = React.useState<TimelineStep[]>([]);
  /** 工具事件镜像 ref：onChunk 累积、onDone 收尾时读取（订阅回调闭包拿不到最新 state，必须走 ref） */
  const toolEventsRef = React.useRef<ToolEvent[]>([]);
  /**
   * 本次回复的工具调用留痕（与 toolEvents 展示集合分离）。
   * 留痕只随消息生命周期：onDone 合并进 reasoning 后清空，发送/清空对话/切会话时清空；
   * 自动重连（onError → resetPartial + setToolEvents([])）只清展示残片，不清留痕——
   * 否则流中断触发重连后，已产生的工具调用记录被抹掉，无思考模型的「思考过程」就无痕可展（A-147）。
   */
  const toolTraceRef = React.useRef<ToolEvent[]>([]);
  /** A-934：assistant 消息序数（1 起）——与历史 records 中 ai 记录严格同序，
   *  用于把持久化的交错时间线按消息序数回填（加载会话时重置为已载入的 assistant 数）。 */
  const assistantOrdinalRef = React.useRef(0);
  const [lastTimings, setLastTimings] = React.useState<Record<string, number> | undefined>();
  /* ── 流式实时监测：token 计数 + 耗时 + 吞吐速率 ── */
  const [streamElapsed, setStreamElapsed] = React.useState(0);
  const [streamTokens, setStreamTokens] = React.useState(0);
  const [contextTokens, setContextTokens] = React.useState(0); // A-918++：当前会话完整上下文（历史消息 + 当前流式 partial）/ 4 估算
  const [streamModel, setStreamModel] = React.useState("");
  const streamStartRef = React.useRef(0);
  const streamCharCountRef = React.useRef(0);
  /** A-918++：最近一次实时 chunk 时间戳（恢复"恢复中"后 6s 无动静 → 主动续接判定用） */
  const lastChunkAtRef = React.useRef(0);
  /** A-918++：恢复后超时主动续接定时器 */
  const pendingResumeTimerRef = React.useRef<number | null>(null);
  /** token 计数走 ref 累积，随 50ms partial 节流批量刷进状态（A-129：去掉每 chunk 一次 setState） */
  const streamTokensRef = React.useRef(0);
  const streamElapsedTimerRef = React.useRef<number | null>(null);
  /* ── 模型调用失败自动重连：流式断联时自动重试（上限 9 次），进度流式输出 ── */
  const streamActiveRef = React.useRef(false);      // 本面板活跃流标记（避免其它面板/旧流的错误误触发重连）
  const stoppingRef = React.useRef(false);          // 用户点「停止」后不再重连
  const retryCountRef = React.useRef(0);            // 已重连次数
  const streamReqRef = React.useRef<ChatStreamReq | null>(null); // 最近一次流式入参（重连时原样重发）
  const reconnectTimerRef = React.useRef<number | null>(null);
  /** A-916：断流自动重连基间隔（ms，配置可调 config/requests.json；默认 3000）；指数+抖动，避免频繁重发触发上游节流 */
  const reconnectBaseMsRef = React.useRef<number>(3000);
  /** 当前活跃流所属会话（事件过滤：只有当前展示会话发起的流事件才被采纳，杜绝切会话后旧流串扰） */
  const streamSessionRef = React.useRef<string | null>(null);
  /** 本流已通过 error chunk 实时展示错误（done 携空正文时跳过追加，避免出现空白气泡） */
  const streamErrorSeenRef = React.useRef(false);
  /** 未落库的错误现场（failReconnect 追加红字后、切换会话前暂存，随快照恢复可见） */
  const pendingTailErrorRef = React.useRef<{ content: string; reason: string } | null>(null);
  /** A-162：切回恢复的「进行中」消息 id（onDone 时替换为完整文本而非新增，防半截+完整重复） */
  const snapshotMsgIdRef = React.useRef<number | null>(null);
  /** A-918++：messages 同步镜像（schedulePartialRender 闭包内读最新 messages，避免空依赖 useCallback 闭包陈旧） */
  const messagesRef = React.useRef<Message[]>([]);
  React.useEffect(() => { messagesRef.current = messages; }, [messages]);
  /** A-968：切回恢复的占位气泡 id（state 版）——供渲染层抑制底部独立 partial 区，避免"恢复中…"气泡 + partial 双份输出 */
  const [resumeMsgId, setResumeMsgId] = React.useState<number | null>(null);
  /** A-969：上下文自动压缩过渡动画（发送前触发；prep=整理 / summarize=生成摘要 / done=完成 / trunc=降级裁剪） */
  const [compressUi, setCompressUi] = React.useState<null | { stage: "prep" | "summarize" | "done" | "trunc"; dropped?: number; summary?: string }>(null);
  const compressBusyRef = React.useRef(false);
  /** 每轮只压一次（发送前触发压缩后，本轮发送结束前不再重复触发；onDone 复位允许下一轮再体检） */
  const didCompressTurnRef = React.useRef(false);
  /** A-162：插入指令待发队列 —— 中断旧流后，等旧流 done/error 收尾再续发的新消息 */
  const interruptQueueRef = React.useRef<Array<{ agentId: string; message: string; sessionId?: string; networkEnabled?: boolean; images?: string[] }>>([]);
  /** 当前面板展示的会话（每渲染同步，供订阅回调闭包比较，避免闭包捕获旧 sessionId） */
  const sessionRef = React.useRef("");
  React.useEffect(() => { sessionRef.current = sessionId; });
  /** 切换前上一会话 id（判定"本面板流是否属于切走的会话"） */
  const prevSessionIdRef = React.useRef<string | null>(null);
  /** A-162：per-session 流现场快照（切走保存/切回恢复 partial+reasoning+tools+活跃标记）。
   *  切会话不取消旧流（后台跑完落库），恢复时从快照续接，杜绝「切回后内容消失」体验。
   *  A-918+：同时保存 input 草稿与 pendingAsk/pendingPerm 弹框状态（切回时一并恢复，
   *  解决「终止提示消失」「用户输入消失」）。 */
  const perSessionStreamCache = React.useRef<Record<string, {
    partial: string; reasoning: string; toolEvents: ToolEvent[]; timeline: TimelineStep[]; hasActive: boolean;
    tailError?: { content: string; reason: string }; messages?: Message[];
    input?: string; pendingAsk?: AskUserRequestUI | null; pendingPerm?: PermissionRequestUI | null;
    /** A-918++：最近一次流式入参（恢复时还原 streamReqRef → 抖动可自动重连，修复"恢复中进度不动/中断"） */
    req?: ChatStreamReq | null;
  }>>({});
  const [reconnectInfo, setReconnectInfo] = React.useState<{ attempt: number; total: number } | null>(null);
  /** A-917：流失败/重连耗尽的就地错误横幅（不追加独立消息，避免"另发一条/切会话才见/切走即消失"） */
  const [streamErrorBanner, setStreamErrorBanner] = React.useState<string | null>(null);
  /** 复位流式 UI（重连耗尽/主动停止/切换会话共用；连带清理定时器与重连状态） */
  const resetStreamUI = React.useCallback(() => {
    setLoading(false);
    setStopping(false);
    resetPartial();
    setReasoningTmp("");
    reasoningTmpRef.current = "";
    setToolEvents([]);
    toolEventsRef.current = [];
    setReconnectInfo(null);
    setStreamErrorBanner(null); // A-917：复位时一并清就地错误横幅
    setStreamModel("");
    setResumeMsgId(null); // A-968：复位（切走/停止/失败）时清占位气泡标记，保证下一次恢复重建
    setCompressUi(null); // A-969：复位时收起压缩过渡浮层（残留浮层会挡住 input）
    compressBusyRef.current = false;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pendingResumeTimerRef.current !== null) { // A-918++：清理恢复超时续接定时器
      window.clearTimeout(pendingResumeTimerRef.current);
      pendingResumeTimerRef.current = null;
    }
    if (streamElapsedTimerRef.current !== null) {
      window.clearInterval(streamElapsedTimerRef.current);
      streamElapsedTimerRef.current = null;
    }
    streamActiveRef.current = false;
    streamReqRef.current = null;
    retryCountRef.current = 0;
    stoppingRef.current = false;
  }, [resetPartial]);
  /** 上下文消耗圆环：已用（done 的 promptTokens）/ 上限（Agent max_context） */
  const [ctxUsed, setCtxUsed] = React.useState(0);
  const [ctxCap, setCtxCap] = React.useState(0);
  const [sessionConfig, setSessionConfig] = React.useState<SessionConfig>({ approval: "auto", workspace: "" });
  const [renaming, setRenaming] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState("");
  /** 自分裂（fork）GUI 已移除并并入子代理体系（A-943）——子代理派发见「设置→后台任务」 */
  // 指令面板 + 联想 + 加号栏
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdFilter, setCmdFilter] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<SuggestionItem[]>([]);
  const [plusOpen, setPlusOpen] = React.useState(false);
  /** A-951：@成员选择器（brainstorm 输入 @ 弹出团队成员列表） */
  const [atOpen, setAtOpen] = React.useState(false);
  const [atSel, setAtSel] = React.useState(0);
  const [atFilter, setAtFilter] = React.useState("");
  const atRangeRef = React.useRef<{ start: number; end: number } | null>(null);
  /** 群聊可 @ 名单：组长（会话归属 Agent）+ 团队成员（与 main 层 roster 对齐） */
  const teamRoster = React.useMemo(() => {
    if (sessionType !== "brainstorm") { return [] as string[]; }
    const names = [agentName, ...memberNames];
    return names.filter((n, i, arr) => Boolean(n) && arr.indexOf(n) === i);
  }, [sessionType, agentName, memberNames]);
  /**
   * 输入框配置：推理等级改为无框下拉（GhostSelect）直接弹出可选等级，不再需要折叠面板
   */
  const [extras, setExtras] = React.useState<ExtrasList | null>(null);
  /** 联网搜索开关：默认开（A-966 用户实测"群聊搜不了"——默认关使 web_search/web_fetch 被静默拒绝）；
   *  未显式存过 "0" 即视为开（可手动关闭后持久化），从 localStorage 恢复 */
  const [networkEnabled, setNetworkEnabled] = React.useState(() => {
    try { return localStorage.getItem("slime_network_enabled") !== "0"; } catch { return true; }
  });
  // 网络开关变化时同步写入 localStorage
  React.useEffect(() => {
    try { localStorage.setItem("slime_network_enabled", networkEnabled ? "1" : "0"); } catch { /* 忽略 */ }
  }, [networkEnabled]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = React.useState(true);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const eventIdRef = React.useRef(0);
  /** 消息自增 id（稳定键 + 折叠态索引） */
  const msgIdRef = React.useRef(0);
  /** 已完成消息的推理块折叠态：true=折叠（默认） */
  const [collapsedReasoning, setCollapsedReasoning] = React.useState<Record<number, boolean>>({});

  /* ── 识图：待发送图片（预览行显示，可删除）＋ 会话内图片记忆（多轮识图）── */
  const [pendingImages, setPendingImages] = React.useState<Array<{ id: string; name: string; dataUrl: string }>>([]);
  const imagesSeqRef = React.useRef(0);
  /** 会话内已发送图片（后续轮次自动携带最近 ≤4 张，让模型多轮都能看到图；不写入服务端历史） */
  const sessionImagesRef = React.useRef<Array<{ name: string; dataUrl: string }>>([]);

  /** ── 输入框内嵌权限请求（替代系统弹窗）：请求到达时输入框切换为选择题 UI ── */
  const [pendingPerm, setPendingPerm] = React.useState<PermissionRequestUI | null>(null);
  /** 实时同步当前请求 id（超时监听闭包只建一次，靠 ref 拿到最新值） */
  const pendingPermRef = React.useRef<PermissionRequestUI | null>(null);
  React.useEffect(() => { pendingPermRef.current = pendingPerm; }, [pendingPerm]);
  /** 用户已选中的选项 id（"custom" 时显示自填输入框） */
  const [permOption, setPermOption] = React.useState<string>("allow-once");
  /** "custom" 选项的自填内容 */
  const [permCustom, setPermCustom] = React.useState("");
  /** 决策提交中（防重复点击） */
  const [permSubmitting, setPermSubmitting] = React.useState(false);

  /** ── 输入框内嵌 ask_user 提问（方向分歧 / 关键决策；与权限请求同形态）── */
  const [pendingAsk, setPendingAsk] = React.useState<AskUserRequestUI | null>(null);
  const pendingAskRef = React.useRef<AskUserRequestUI | null>(null);
  React.useEffect(() => { pendingAskRef.current = pendingAsk; }, [pendingAsk]);
  /** 用户选中的选项文本（"__custom" 时显示自填输入框） */
  const [askOption, setAskOption] = React.useState<string>("__custom");
  /** 自填内容 */
  const [askCustom, setAskCustom] = React.useState("");
  /** 回答提交中（防重复点击） */
  const [askSubmitting, setAskSubmitting] = React.useState(false);

  /** 订阅主进程权限请求：输入框位置弹出选择题，请求结束自动恢复输入框 */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.perm?.onRequest) { return; }
    const off = api.perm.onRequest((req: PermissionRequestUI) => {
      // 会话过滤：切会话后旧流（被取消但仍可能延迟送达）的权限请求一律丢弃——
      // 否则输入框会被"上一个会话"的授权选择题替换，出现"切会话后输入框卡死"（旧请求超时 300s）。
      // 无 sessionId 标签的请求回退到「流归属」判定：当前无活跃流或流与会话不一致 → 丢弃（A-151）
      const reqSid = req.sessionId !== undefined ? req.sessionId : streamSessionRef.current;
      if (reqSid !== sessionRef.current) { return; }
      setPendingPerm(req);
      setPermOption(req.options[0]?.id ?? "allow-once");
      setPermCustom("");
      setPermSubmitting(false);
    });
    // 主进程超时兜底（未收到决策已按拒绝处理）→ 收起选择题 UI，避免一直挂着
    const offTimeout = api.perm.onTimeout?.((req: { requestId: string }) => {
      if (pendingPermRef.current && pendingPermRef.current.requestId === req.requestId) {
        setPendingPerm(null);
        setPermSubmitting(false);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    });
    return () => { off(); offTimeout?.(); };
  }, []);

  /** 提交用户对权限请求的决策（选择题选项 → PermissionDecision） */
  async function resolvePerm(opt: string, custom?: string): Promise<void> {
    if (!pendingPerm || permSubmitting) { return; }
    setPermSubmitting(true);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    let decision: PermissionDecision;
    if (opt === "deny") {
      decision = { requestId: pendingPerm.requestId, approved: false, reason: "用户拒绝授权", alwaysAllow: false };
    } else if (opt === "custom") {
      const text = (custom ?? "").trim();
      // 自填指示：非空且不以"拒绝"开头视为批准（附指示），以"拒绝"开头视为拒绝（附原因）
      decision = {
        requestId: pendingPerm.requestId,
        approved: !/^拒绝/.test(text),
        reason: text || "用户自定义指示",
        alwaysAllow: false,
      };
    } else {
      decision = {
        requestId: pendingPerm.requestId,
        approved: true,
        reason: opt === "allow-session" ? "本次会话总是允许" : "用户允许本次",
        alwaysAllow: opt === "allow-session",
      };
    }
    try {
      await api.perm.resolve(decision);
    } finally {
      setPendingPerm(null);
      setPermSubmitting(false);
      // 权限申请结束，焦点还给输入框
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  /** 订阅主进程 ask_user 提问：输入框位置弹出选择题，回答后自动恢复输入框 */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.askUser?.onRequest) { return; }
    const off = api.askUser.onRequest((req: AskUserRequestUI) => {
      // 会话过滤：切会话后旧流（被取消但仍可能延迟送达）的提问一律丢弃，避免输入框被旧"提问卡"占用。
      // 无 sessionId 标签的请求回退到「流归属」判定：当前无活跃流或流与会话不一致 → 丢弃（A-151）
      const reqSid = req.sessionId !== undefined ? req.sessionId : streamSessionRef.current;
      if (reqSid !== sessionRef.current) { return; }
      setPendingAsk(req);
      setAskOption(initialAskSelection(req.options));
      setAskCustom("");
      setAskSubmitting(false);
    });
    // 主进程超时兜底（未收到回答已按「跳过」处理）→ 收起提问 UI
    const offTimeout = api.askUser.onTimeout?.((req: { requestId: string }) => {
      if (pendingAskRef.current && pendingAskRef.current.requestId === req.requestId) {
        setPendingAsk(null);
        setAskSubmitting(false);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    });
    return () => { off(); offTimeout?.(); };
  }, []);

  /** 提交用户对 ask_user 的回答（选项/自填 → AskUserDecision） */
  async function resolveAsk(choice: string, custom?: string): Promise<void> {
    if (!pendingAsk || askSubmitting) { return; }
    setAskSubmitting(true);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const decision: AskUserDecision = buildAskDecision(pendingAsk.requestId, choice, custom);
    try {
      await api.askUser.resolve(decision);
    } finally {
      setPendingAsk(null);
      setAskSubmitting(false);
      // 提问结束，焦点还给输入框
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  const makeMessage = React.useCallback((role: "user" | "assistant", content: string, extra?: Partial<Message>): Message => ({
    id: ++msgIdRef.current,
    role,
    content,
    time: nowTime(),
    ts: new Date().toISOString(),
    ...extra,
  }), []);
  /** 故障自愈续接：重连/换模型继续时告知模型「你被中断了，从断点继续」（防幻觉已完成/重复劳动） */
  const buildResumeHint = (): string => {
    const r = (reasoningTmpRef.current ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    // A-175：附上最近 6 个工具的真实执行结果（而非仅有工具名）——模型据此判断哪些步骤
    // 已真实落地（文件已写入/网页已抓取/数据已查询），才能从断点继续而不是凭名字猜测重做。
    // result 字段为执行结果（A-172 已截断 200 字符），此处再压至 220 字符防提示膨胀。
    const toolLines: string[] = [];
    for (const x of toolTraceRef.current.slice(-6)) {
      const label = x.label || x.name || x.detail || "";
      const res = (x.result ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
      toolLines.push(res ? `- ${label}：${res}` : `- ${label}`);
    }
    const parts = ["你之前的一次生成因网络中断未完成，正在自动重连并继续同一任务。"];
    if (r) { parts.push(`已产出的思考（摘要）：${r}`); }
    if (toolLines.length > 0) {
      parts.push(`已经真实执行完毕的工具及结果（这些步骤已完成，切勿重复执行）：\n${toolLines.join("\n")}`);
    }
    parts.push("请从断点继续推进任务：不要重复已完成的工作，也不要声称用户尚未确认的工作已完成。");
    return parts.join("\n");
  };

  /** 重连全部失败 / 不可恢复错误：红字错误+可能诱因，追加为一条错误消息并复位 UI */
  const failReconnect = React.useCallback((msg: string, maxRetry: number) => {
    // 重连耗尽的错误消息也带上本流工具留痕（A-147），并在收尾后清空避免残留
    const errTrace = toolTraceRef.current;
    const errBlock = errTrace.length > 0
      ? `### 工具调用记录\n${errTrace.map((t) => `- ${t.label}`).join("\n")}`
      : "";
    const errContent = explainStreamError(msg, maxRetry);
    pendingTailErrorRef.current = { content: errContent, reason: msg };
    // A-917：改为就地红字横幅（不再追加独立 assistant 消息）——用户反馈「另发一条/切会话才出现/切走即消失」全部由追加消息引起；
    // 横幅随当前会话立即显示、切走自然消失，不污染消息流与历史。
    setStreamErrorBanner(errBlock ? `${errContent}\n\n${errBlock}` : errContent);
    // 失败/重连耗尽：interruptQueue 中未被续发的用户指令（中断插入路径）归还输入框，
    // 避免旧流不再发 done 时『需求被吞、无法回滚』（输入框发送时已清空，必须归还）
    if (interruptQueueRef.current.length > 0) {
      const pending = interruptQueueRef.current.map((q) => q.message).join("\n");
      interruptQueueRef.current = [];
      setInput((prev) => (prev && prev.trim() ? prev + "\n" + pending : pending));
    }
    toolTraceRef.current = [];
    timelineStepsRef.current = [];
    setLiveTimeline([]);
    resetStreamUI();
  }, [makeMessage, resetStreamUI]);

  /** 切换会话：加载历史 + 会话配置 + 已有 Agent 列表（A2A 传唤候选） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    // A-162：切换会话【不再取消】旧会话进行中的流——此前 api.chat.cancel 会中断旧流，
    // 切回时历史只含已落库（done）消息，思考/输出/工具进行中的内容既没落库又丢了 UI 快照 →
    // 「切换后正在输出的内容立即消失，只能等输出结束切回才重新显示」。
    // 正确语义（对齐 Claude Code/OpenClaw）：切走的流在后台自然跑完并落库；恢复时从快照续接。
    // 旧流事件已按 sessionId 标注入 renderer 过滤，不会串扰当前会话。
    // 把旧会话的流现场存进 per-session 快照（切回时恢复 partial/reasoning/tools）
    // A-918++：区分「会话切换」与「会话内切 Agent」——只有真正的 sessionId 变化才需要
    // 保存/恢复 input 草稿与弹框；agentId 变化（sessionId 不变）不应覆盖用户正在输入的草稿。
    const isSessionChange = prevSessionIdRef.current !== null && prevSessionIdRef.current !== sessionId;
    if (isSessionChange) {
      const prevKey = prevSessionIdRef.current!;
      if (streamActiveRef.current || partialRef.current || reasoningTmpRef.current || toolEventsRef.current.length > 0) {
        // A-968：快照必须【合并】既有条目而非整体替换——doSend 写入的乐观用户消息
        // （snap.messages）就在这里，整体覆盖会把它丢掉 → 切回后"用户文本直接消失"
        const existing = perSessionStreamCache.current[prevKey] ?? {};
        perSessionStreamCache.current[prevKey] = {
          ...existing,
          partial: partialRef.current,
          reasoning: reasoningTmpRef.current,
          toolEvents: toolEventsRef.current,
          timeline: timelineStepsRef.current,
          hasActive: streamActiveRef.current,
          tailError: pendingTailErrorRef.current ?? existing.tailError,
          req: streamReqRef.current ?? null, // A-918++：保存入参，恢复时还原以便自动重连
        };
      }
      // A-918+：input 草稿、pendingAsk/pendingPerm 弹框按会话隔离保存（切回恢复）
      // 解决「终止提示框切换消失」「用户输入切换消失」——它们与流是否活跃无关，
      // 即使旧会话没有进行中流也要保存（用户打了半截字再切走，回来应能续打）
      const draftSnapshot = {
        ...(perSessionStreamCache.current[prevKey] ?? {}),
        input,
        pendingAsk,
        pendingPerm,
      };
      perSessionStreamCache.current[prevKey] = draftSnapshot;
      // A-918++：额外持久化到 localStorage，防组件意外 unmount/remount 时 ref 快照丢失
      // （如 React.StrictMode 双调用、父组件 key 变化等）；key 按 sessionId 隔离
      try {
        localStorage.setItem(`slime_session_draft_${prevKey}`, JSON.stringify({
          input,
          pendingAsk: pendingAsk ?? null,
          pendingPerm: pendingPerm ?? null,
          savedAt: Date.now(),
        }));
      } catch { /* localStorage 不可用时静默忽略（隐私模式/磁盘满） */ }
    }
    // 彻底复位流式 UI（loading/stopping/定时器/重连状态/节流缓存）：
    // 关键 —— 这保证切换后输入框立即可用，旧会话残留的 loading=true 不再延续到新会话
    resetStreamUI();
    // 收起旧会话残留的内嵌权限/提问选择题（main 有 300s 超时兜底：未回答按拒绝/跳过放行，不会挂死工具调用）
    setPendingPerm(null);
    setPendingAsk(null);
    setPermSubmitting(false);
    setAskSubmitting(false);
    // 作废旧流绑定：旧会话残留流事件（main 已按流打 sessionId 标签）一律被过滤；
    // sendMessage 发起新流时会重新绑定
    streamSessionRef.current = null;
    // 识图现场隔离：切换会话清空「会话内图片记忆」与「待发图片」，
    // 防 A 会话的图被带到 B 会话（跨会话图片串扰/上下文污染）
    sessionImagesRef.current = [];
    setPendingImages([]);
    prevSessionIdRef.current = sessionId;
    // A-918：切回本会话——以「已落库历史」为底，叠加「未落库乐观用户消息」与「进行中流现场」；
    // A-918+：input 草稿与 pendingAsk/pendingPerm 弹框按会话隔离恢复
    // A-918++：优先用 ref 快照；ref 为空时回退 localStorage（防组件 remount 后快照丢失）
    // A-918+++：仅真正的 sessionId 变化才恢复草稿；agentId 变化（isSessionChange=false）
    // 不清空也不恢复——用户正在输入的草稿保持不变。且切到无缓存会话时显式置空 input，
    // 避免上一会话草稿「漏」进新会话（真正的"输入丢失/串台"根因）。
    const cached = perSessionStreamCache.current[sessionId];
    if (isSessionChange) {
      let restoreInput = "";
      let restoreAsk: AskUserRequestUI | null = null;
      let restorePerm: PermissionRequestUI | null = null;
      if (cached) {
        restoreInput = cached.input ?? "";
        restoreAsk = cached.pendingAsk ?? null;
        restorePerm = cached.pendingPerm ?? null;
      } else {
        try {
          const raw = localStorage.getItem(`slime_session_draft_${sessionId}`);
          if (raw) {
            const parsed = JSON.parse(raw) as { input?: string; pendingAsk?: AskUserRequestUI | null; pendingPerm?: PermissionRequestUI | null; savedAt?: number };
            // 仅 24h 内的草稿有效（避免加载陈旧历史会话的残留）
            if (parsed.savedAt && Date.now() - parsed.savedAt < 24 * 3600 * 1000) {
              restoreInput = parsed.input ?? "";
              restoreAsk = parsed.pendingAsk ?? null;
              restorePerm = parsed.pendingPerm ?? null;
            }
          }
        } catch { /* 解析失败忽略 */ }
      }
      setInput(restoreInput);
      setPendingAsk(restoreAsk);
      setPendingPerm(restorePerm);
    }
    pendingTailErrorRef.current = null;
    resetPartial();
    setReasoningTmp("");
    reasoningTmpRef.current = "";
    setToolEvents([]);
    toolEventsRef.current = [];
    toolTraceRef.current = [];
    const optimisticMsgs: Message[] = cached?.messages ?? [];
    let liveMsg: Message | null = null;
    if (cached) {
      partialRef.current = cached.partial ?? "";
      reasoningTmpRef.current = cached.reasoning ?? "";
      toolEventsRef.current = cached.toolEvents ?? [];
      timelineStepsRef.current = cached.timeline ?? [];
      setLiveTimeline(cached.timeline ?? []);
      setToolEvents(cached.toolEvents ?? []);
      setReasoningTmp(cached.reasoning ?? "");
      // 错误现场：就地红字横幅（A-917），不再追加为独立消息
      if (cached.tailError) {
        setStreamErrorBanner(cached.tailError.content);
      }
      if (cached.hasActive) {
        streamActiveRef.current = true;
        // A-918++：还原最近一次流入参 → 恢复期间若旧流抖动，onError 自动重连 payload 不为 null
        // （此前只还原数据 ref 不还原 streamReqRef，恢复态重连 payload=null → failReconnect → "恢复中"冻结/中断）
        if (cached.req) { streamReqRef.current = cached.req; }
        setLoading(true);
        // A-918++ 深层兜底：旧流若在切换窗口内已静默结束/断连（未触发 done/error），恢复态会一直"恢复中"冻结。
        // 启动 6s 超时检测：期间无实时 chunk 到达 → 用保存的 req 主动重发续接（真正"续上"，而非空等）。
        lastChunkAtRef.current = Date.now();
        if (pendingResumeTimerRef.current !== null) { window.clearTimeout(pendingResumeTimerRef.current); }
        pendingResumeTimerRef.current = window.setTimeout(() => {
          pendingResumeTimerRef.current = null;
          const req = streamReqRef.current;
          const noLive = Date.now() - lastChunkAtRef.current > 5500;
          if (streamActiveRef.current && req && noLive) {
            streamActiveRef.current = true;
            void api.chat.stream({ ...req, resumeHint: buildResumeHint() });
          }
        }, 6000);
        // A-968：占位气泡内容绑定 partial——后续 chunk 到达时由 schedulePartialRender 实时续长，
        // 杜绝冻结的"（恢复中…）"+底部 partial 双份输出造成的"中断后重新输出一遍"观感
        liveMsg = makeMessage("assistant", partialRef.current || "（恢复中…）", {
          reasoning: reasoningTmpRef.current || undefined,
          stages: {
            reads: [], urls: [],
            tools: toolEventsRef.current,
            reasoning: reasoningTmpRef.current || undefined,
            timeline: timelineStepsRef.current,
          },
        });
        snapshotMsgIdRef.current = liveMsg.id;
        setResumeMsgId(liveMsg.id);
      } else {
        // 流已真实终态（停止/失败/完成）→ 切回不带"生成中"，避免假活跃
        streamActiveRef.current = false;
        setLoading(false);
      }
      // A-968：多模态连续识图——从快照消息重建会话内图片记忆（此前切走即清空，
      // 回来"记不住上一张图"；此处恢复最近 ≤4 张）
      const restoredImages: Array<{ name: string; dataUrl: string }> = [];
      for (const m of cached.messages ?? []) {
        for (const u of (m as { images?: string[] }).images ?? []) {
          if (u) { restoredImages.push({ name: "", dataUrl: u }); }
        }
      }
      if (restoredImages.length > 0) {
        const seenSet = new Set<string>();
        sessionImagesRef.current = restoredImages
          .filter((i) => (seenSet.has(i.dataUrl) ? false : (seenSet.add(i.dataUrl), true)))
          .slice(-4);
      }
      delete perSessionStreamCache.current[sessionId];
      // A-918++：localStorage 草稿也一并清理（成功恢复后无需保留）
      try { localStorage.removeItem(`slime_session_draft_${sessionId}`); } catch { /* ignore */ }
    }
    setReasoningOpen(true);
    reasoningManuallyToggledRef.current = false;
    setCollapsedReasoning({});
    setLastTimings(undefined);
    setSuggestions([]);
    setAtBottom(true);
    // A-934/A-935：会话级窗口占用恢复——done 事件持久化的「最近一次输入侧占用 + 权威上限」；
    // 无持久化占用 → **显式置 0**（否则残留上一会话的环数值——切会话不同步的根因）
    const ctxMeta = readSessionCtxMeta(agentId, sessionId);
    setCtxUsed(restoreUsed(ctxMeta));
    if (ctxMeta?.cap && ctxMeta.cap > 0) { setCtxCap(ctxMeta.cap); }
    void api.conversations.load(sessionId).then((msgs: ConversationMessage[]) => {
      // A-934：按 assistant 序数回填持久化的交错时间线（历史落库只有 reasoning 文本，
      // 无工具↔思考穿插顺序——重启后思考历程重归「交错时间线」设计而非整段平铺）
      const attaches = attachTimelineToHistory(msgs, ctxMeta);
      let aiOrd = 0;
      const hist = msgs.map((m, i) => {
        const a = attaches[i] ?? {};
        const extra: Partial<Message> = { time: fmtTime(m.time), reasoning: m.reasoning, elapsedMs: m.elapsedMs, agentName: m.agentName, agentId: m.agentId };
        if (a.assistantOrdinal) {
          aiOrd = a.assistantOrdinal;
          if (a.timeline || m.reasoning) {
            const toolSteps = (a.timeline ?? []).filter((s): s is TimelineStepLite & { kind: "tool" } => s.kind === "tool");
            const tools: ToolEvent[] = toolSteps.map((t, tIdx) => ({
              id: a.assistantOrdinal! * 1000 + tIdx, name: t.name ?? "", label: t.label ?? t.name ?? "",
              detail: t.detail, result: t.result,
            }));
            extra.stages = { reads: [], urls: [], tools, reasoning: m.reasoning, timeline: a.timeline };
          }
        }
        return makeMessage(m.role, m.content, extra);
      });
      assistantOrdinalRef.current = aiOrd;
      // 底 = 历史（已落库）；叠加未落库乐观用户消息；再叠进行中现场消息（onDone 到达时替换为完整文本）
      // A-968：乐观用户消息去重——流在后台跑完已落库（切回时历史含该 user 记录）时，
      // 只保留历史里还没有的乐观消息，避免"用户文本重复出现"（曾有切走→done→切回双份的复现）
      const histSeen = new Set(hist.map((h) => `${h.role}|${h.content}`));
      const optimisticMsgs2 = optimisticMsgs.filter((m) => m.role !== "user" || !histSeen.has(`user|${m.content}`));
      setMessages([...hist, ...optimisticMsgs2, ...(liveMsg ? [liveMsg] : [])]);
    }).catch(() => {
      setMessages([...optimisticMsgs, ...(liveMsg ? [liveMsg] : [])]);
    });
    // 会话级配置（"以文件夹为主"：按 sessionId 取 workspace；无则回退 Agent 级旧配置）
    void api.conversations.configGet({ agentId, sessionId }).then(setSessionConfig).catch(() => undefined);
    // 加载会话级待办任务并广播给右侧栏
    if (api.tasks?.loadTodos) {
      void api.tasks.loadTodos(sessionId).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentId, makeMessage]);

  /** 上下文圆环上限：优先 Agent 配置的 max_context；未配置（0）时回退当前模型上游 context_window
   *  （A-1xx：上游 context_window 元数据此前只显示不生效 → 环 cap=0 永远 0%） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const upstreamCtx = curProviderModel?.context_window ?? 0;
    // A-934：持久化的会话权威上限优先（done 下发的 windowCap 落盘值），避免重启后兜底覆盖
    const persistedCap = readSessionCtxMeta(agentId, sessionId)?.cap ?? 0;
    if (persistedCap > 0) { setCtxCap(persistedCap); return; }
    if (!api?.agents?.detail) { setCtxCap(upstreamCtx); return; }
    let cancelled = false;
    void api.agents.detail(agentId).then((d: AgentDetail | null) => {
      if (cancelled) { return; }
      const agentCtx = d?.max_context ?? 0;
      setCtxCap(agentCtx > 0 ? agentCtx : upstreamCtx);
    }).catch(() => { if (!cancelled) { setCtxCap(upstreamCtx); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, modelChoice, providerModels]);

  /** P0: 随 agentId 重新订阅（切会话时切换事件源） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const off1 = api.chat.onChunk((c: StreamChunk) => {
      // 事件过滤：仅采纳当前展示会话的流（切会话/切 Agent 后旧流事件一律丢弃）。
      // main 已按流打 sessionId 标签，优先按标签与会话比对；无标签的兼容事件回退 streamSessionRef 判定
      const cSid = c.data?.sessionId;
      if (cSid != null) {
        if (cSid !== sessionRef.current) { return; }
      } else if (streamSessionRef.current !== sessionRef.current) {
        return;
      }
      // 错误事件（core-ts 流内 `yield { type:"error" }`，如响应超限/流式生成异常）：
      // 此前通道存在但 onChunk 没有处理分支，被静默丢弃，只能切会话重载历史才看得到 → 这里实时追加红字错误并复位流式 UI
      if (c.type === "error") {
        const errMsg = c.data?.message ?? "未知错误";
        // 仅处理本面板发起的活跃流（与 onError 一致），未激活流/其它面板的错误不动界面
        if (!streamActiveRef.current) { return; }
        // 模型不支持图片输入 → 友好提示（上游返回 "this model does not support image input"），不展示红字
        if (/does not support image input|Cannot read.*image/i.test(errMsg)) {
          void alertAsync("当前模型不支持图片输入，请先切换到支持视觉的模型（如 agnes-2.5-flash、gpt-4o 等）。");
          resetStreamUI();
          return;
        }
        console.error("[chat] stream chunk error:", errMsg);
        // 标记本流已展示错误：后续 done 携空正文时跳过空白气泡（避免与错误消息重复/显得卡死）
        streamErrorSeenRef.current = true;
        // 错误收尾也带上本流已发生的工具留痕：用户能从错误消息的「思考过程」看到"尝试调用过哪些工具"（A-147）
        const errTrace = toolTraceRef.current;
        const errBlock = errTrace.length > 0
          ? `### 工具调用记录\n${errTrace.map((t) => `- ${t.label}`).join("\n")}`
          : "";
        setMessages((prev) => [...prev,
          makeMessage("assistant", explainStreamError(errMsg), { error: true, reasoning: errBlock || undefined }),
        ]);
        // 本次回复已以错误消息收尾：清空留痕，避免残留污染下一次回复
        toolTraceRef.current = [];
        timelineStepsRef.current = [];
        setLiveTimeline([]);
        resetStreamUI();
        onConversationsChanged?.();
        return;
      }
      // 团队会话：成员发言（type="member"）→ 台内流式累积（同一 Agent 期间的 chunk 追加到同一条消息），
      // 切换发言者后开启新消息；与组长整合回复并列（A-950 逐字流式，避免每 chunk 一条刷屏）
      if (c.type === "member") {
        // A-955 兜底剔除思考段；A-956 正文排版归一：换行收成空格（群聊正文规范为"一段"，模型常多发 \n 造成碎行乱排版）
        const content = stripPanelText(c.data?.content ?? "")
          .replace(/\r?\n+/g, " ")
          .replace(/[ \t]{2,}/g, " ")
          .trim();
        const memberId = c.data?.agentId;
        const memberName = (memberId
          ? agents.find((a) => a.id === memberId)?.name
          : undefined) ?? c.data?.name ?? "成员";
        if (!content) { return; }
        setMessages((prev) => {
          const last = prev.length > 0 ? prev[prev.length - 1] : undefined;
          const isSameSpeaker = last?.role === "assistant" && last.agentId === memberId && !(last as { error?: boolean }).error;
          if (isSameSpeaker && last && typeof last.content === "string") {
            return prev.map((mm, i) => (i === prev.length - 1 ? { ...mm, content: mm.content + content } : mm));
          }
          return [...prev, makeMessage("assistant", content, { agentName: memberName, agentId: memberId })];
        });
        return;
      }
      if (c.type === "tool" && c.data?.name) {
        const rawName = c.data.name;
        const { label } = resolveToolLabel(rawName);
        const displayLabel = rawName.startsWith("delegate:")
          ? `⟳ ${label}「${rawName.slice(9)}」`
          : `⟳ ${label}`;
        // A-162：从工具参数提取「具体抓手」——网址（web_fetch/web_search）或文件路径
        // （file_*/code_check），工具行直接可见，符合 Claude Code 阶段卡中"访问了哪个网址/改了哪个文件"的语义。
        let detail = "";
        try {
          const args = typeof c.data.args === "string" ? JSON.parse(c.data.args) : (c.data.args ?? {});
          if (args.url && typeof args.url === "string") { detail = args.url; }
          else if (args.query && typeof args.query === "string") { detail = `查询: ${args.query}`; }
          else if (args.path && typeof args.path === "string") { detail = String(args.path); }
          else if (args.file && typeof args.file === "string") { detail = String(args.file); }
        } catch { /* 参数不可解析 → 无细节行 */ }
        // 注意：refs 必须在 setState 的 updater 之外同步累积——
        // React 的 updater 是延迟到 render 阶段执行的。
        // 事件回调内同步累积，保证留痕与 reasoning 实际输出进度一一对应。
        const next = [...toolEventsRef.current, { id: ++eventIdRef.current, name: rawName, label: displayLabel, detail, result: typeof c.data.result === "string" ? c.data.result : undefined }];
        toolEventsRef.current = next;
        const ev = next[next.length - 1];
        toolTraceRef.current = [...toolTraceRef.current, ev];
        // A-xxx：增量 append tool 段到交错时间线（按真实到达顺序，紧贴其前 thinking 段）
        timelineStepsRef.current = appendTimelineStep(timelineStepsRef.current, {
          kind: "tool", name: rawName, label: displayLabel.replace(/^⟳\s*/, ""), detail, result: ev.result,
        });
        setToolEvents(next);
        return;
      }
      if (c.type === "reasoning") {
        reasoningTmpRef.current += c.data?.content ?? "";
        // A-xxx：增量 append 到交错时间线（勿改动纯文本累积——头部摘要行仍读 reasoningTmp）
        const content = c.data?.content ?? "";
        if (content) {
          timelineStepsRef.current = appendTimelineStep(timelineStepsRef.current, { kind: "think", text: content });
        }
        schedulePartialRender();
        return;
      }
      if (c.type === "chunk") {
        partialRef.current += c.data?.content ?? "";
        // 实时监测：按字符增量估算 token（≈4 字符/token）
        const delta = (c.data?.content ?? "").length;
        lastChunkAtRef.current = Date.now(); // A-918++：记录最近实时输出，供"恢复中"超时续接判定
        if (delta > 0) {
          streamCharCountRef.current += delta;
          streamTokensRef.current = Math.round(streamCharCountRef.current / 4);
          if (streamStartRef.current === 0) {
            streamStartRef.current = Date.now();
            // A-129：耗时刷新 200ms->500ms，降低流式期间定时器唤醒频率（减少主线程打断）
            streamElapsedTimerRef.current = window.setInterval(() => {
              setStreamElapsed(Date.now() - streamStartRef.current);
            }, 500);
          }
        }
        schedulePartialRender();
        return;
      }
      partialRef.current += c.data?.content ?? "";
      schedulePartialRender();
    });
    const off2 = api.chat.onDone((m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number>; interrupted?: boolean; sessionId?: string; windowCap?: number; ctxBuckets?: CtxBuckets }) => {
      // 事件过滤：切会话/切 Agent 后旧流的 done 一律丢弃，避免串扰到当前会话
      if (m.sessionId != null) {
        // A-918+：即便不是当前会话，也要先把快照 hasActive 置 false（流已真实结束），
        // 否则切回时仍按"恢复中"建占位气泡 → 与随后 conversation.load 拉到的完整消息形成"两段"重复
        if (m.sessionId !== sessionRef.current) {
          const sid = m.sessionId;
          const snap = perSessionStreamCache.current[sid];
          if (snap) { snap.hasActive = false; }
          return;
        }
      } else if (streamSessionRef.current !== sessionRef.current) { return; }
      // 流已完成：清除重连状态（含可能遗留的重连定时器）
      streamActiveRef.current = false;
      retryCountRef.current = 0;
      stoppingRef.current = false;
      didCompressTurnRef.current = false; // A-969：本轮发送结束，允许下一轮再压缩体检
      setReconnectInfo(null);
      setStreamErrorBanner(null); // A-917：流正常收尾（含重连成功）即清就地错误横幅
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const reasoning = reasoningTmpRef.current;
      const manuallyToggled = reasoningManuallyToggledRef.current;
      // 工具调用留痕：无思考模型不输出 reasoning，工具记录此前随 toolEvents 清空而消失；
      // 读 toolTraceRef（而非 toolEventsRef）：流中断触发自动重连会清空展示集合，但留痕保留（A-147）
      const doneTools = toolTraceRef.current;
      // A-170：reasoning 不再拼接 toolBlock，工具调用由独立卡片展示（避免重复）
      let finalReasoning = reasoning ? sanitizeThinking(reasoning) : undefined;
      // A-918++ 兜底2：流式没收到 reasoning chunk（上游不返回 reasoning_content），
      // 但 reply 里混有 <thinking>...</thinking> 标签 → 提取到 reasoning（"某些模型只有调用记录没思考"的根因）
      if (!finalReasoning && m.reply) {
        const thinkMatch = m.reply.match(/<thinking>([\s\S]*?)<\/thinking>/i);
        if (thinkMatch?.[1]) {
          finalReasoning = sanitizeThinking(thinkMatch[1].trim());
        }
      }
      // A-163：组装阶段折叠卡结构化数据（参考内容=读过的文件/访问的网址；思考过程=思考+工具）
      const reads: Array<{ path: string | undefined; label: string }> = [];
      const urls: Array<{ url: string; label: string }> = [];
      for (const t of doneTools) {
        if (t.name === "file_read" && t.detail) reads.push({ path: t.detail, label: `读取 ${t.detail}` });
        else if (t.name === "web_fetch" && t.detail) urls.push({ url: t.detail, label: t.detail });
        else if (t.name === "web_search" && t.detail) urls.push({ url: "", label: t.detail });
      }
      // A-918++ 兜底：m.reasoning 有值但 timeline 没有 think 节点时手动追加一个（A-170 修复后时间线只来自
      // 流式时 "reasoning" 事件，agnes/部分中转站把 reasoning_content 混在 chunk 里传上来，导致
      // 流式阶段没追加 think 节点；onDone 时用 m.reasoning 补一个，让"思考过程"折叠里一定有节点）
      let finalTimeline = timelineStepsRef.current;
      if (finalReasoning && !finalTimeline.some((s) => s.kind === "think")) {
        finalTimeline = [...finalTimeline, { kind: "think" as const, text: finalReasoning }];
      }
      const stages = finalReasoning || doneTools.length > 0
        ? { reads, urls, tools: doneTools, reasoning: finalReasoning, timeline: finalTimeline }
        : undefined;
      // error chunk 已实时展示红字错误时，本 done 携带的是空正文（main 兜底收尾）→ 不再追加空白气泡
      const errorDisplayed = streamErrorSeenRef.current;
      streamErrorSeenRef.current = false;
      // A-918++：剥离 <thinking>...</thinking> 标签（标签内容已提取到 reasoning，正文不留残留）
      const cleanReply = m.reply.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
      const doneText = m.interrupted && !/\n\[已中断\]\s*$/.test(m.reply) ? `${cleanReply}\n\n> ⏹ 已中断（停止生成）` : cleanReply;
      // A-162：切回恢复的进行中消息 → 替换为完整文本（而非新增一条，防"半截+完整"重复）
      const snapshotId = snapshotMsgIdRef.current;
      snapshotMsgIdRef.current = null;
      setResumeMsgId(null); // A-968：占位气泡已被完整文本替换 → 恢复底部独立 partial 区的正常渲染
      if (snapshotId !== null && !(errorDisplayed && !m.reply)) {
        setMessages((prev) => prev.map((mm) =>
          mm.id === snapshotId
            ? { ...makeMessage("assistant", doneText, { reasoning: finalReasoning || undefined, elapsedMs: m.elapsedMs, model: m.model || undefined, mode, stages }), id: mm.id }
            : mm,
        ));
      } else if (!(errorDisplayed && !m.reply) && (snapshotId !== null || (m.reply && m.reply.trim()))) {
        setMessages((prev) => [
          ...prev,
          makeMessage(
            "assistant",
            doneText,
            { reasoning: finalReasoning || undefined, elapsedMs: m.elapsedMs, model: m.model || undefined, mode, stages },
          ),
        ]);
      }
      // 完成后思考自动折叠（用户手动展开过则不覆盖）
      if (finalReasoning && !manuallyToggled) {
        setCollapsedReasoning((prev) => ({ ...prev, [msgIdRef.current]: true }));
      }
      resetPartial();
      setReasoningTmp("");
      reasoningTmpRef.current = "";
      setReasoningOpen(false);
      reasoningManuallyToggledRef.current = false;
      setToolEvents([]);
      toolEventsRef.current = [];
      toolTraceRef.current = [];
      timelineStepsRef.current = [];
      setLiveTimeline([]);
      setLoading(false);
      setStopping(false);
      // A-162：插入指令续发 —— 旧流收尾（含中断）后，若有待发指令则立即作为新一轮发送
      if (interruptQueueRef.current.length > 0 && sessionRef.current === m.sessionId) {
        const next = interruptQueueRef.current.shift()!;
        setLoading(false);
        doSend(next.message, next.sessionId);
        return;
      }
      if (m.timings) setLastTimings(m.timings);
      // 停止流式监测定时器，记录最终数据
      if (streamElapsedTimerRef.current !== null) {
        window.clearInterval(streamElapsedTimerRef.current);
        streamElapsedTimerRef.current = null;
      }
      setStreamModel(m.model ?? "");
      // A-933：上下文占用口径对齐厂商（Claude Code statusline 生态共识）——
      // 窗口占用 = **输入侧** tokens（prompt + cache read），completion/reasoning 是输出、
      // 不占输入窗口；且引擎每次全量重发历史 → 取**最近一次**请求的输入值即当前窗口占用
      // （此前把四项累加，输出被计入窗口导致百分比虚高）。
      // 上限取 done 事件下发的权威 windowCap（Agent.max_context 或本次模型 context_window），
      // 与右栏 ContextWindowBar 完全同源。
      const t = m.timings ?? {};
      const pt = typeof t.promptTokens === "number" ? t.promptTokens : 0;
      const cr = typeof t.cacheReadTokens === "number" ? t.cacheReadTokens : 0;
      const inputSide = pt + cr;
      if (inputSide > 0) { setCtxUsed(inputSide); }
      if (typeof m.windowCap === "number" && m.windowCap > 0) { setCtxCap(m.windowCap); }
      // A-935：单一事件源广播——right 栏与环同一次 done 触发、同值变更
      // A-939：上下文分桶随事件透传（渲染层 ContextWindowBar / ContextRing 可消费 buckets）
      dispatchCtxUpdate({
        sessionId: sessionRef.current,
        used: inputSide > 0 ? inputSide : ctxUsed,
        cap: (typeof m.windowCap === "number" && m.windowCap > 0) ? m.windowCap : ctxCap,
        buckets: m.ctxBuckets,
      });
      // A-934：持久化会话级「时间线 + 窗口占用」——重启后思考历程（交错时间线）与上下文占用可恢复
      if (!(errorDisplayed && !m.reply)) {
        assistantOrdinalRef.current += 1;
        const wc = typeof m.windowCap === "number" && m.windowCap > 0 ? m.windowCap : 0;
        // A-935 关键：时间线必须用 **commit 前**的快照 stages.timeline —— 此时间点时
        // timelineStepsRef.current 已被收尾复位清空（[]），直接读 ref 永远写不进时间线
        updateSessionCtxMeta(agentId, sessionRef.current, assistantOrdinalRef.current, {
          used: inputSide > 0 ? inputSide : undefined,
          cap: wc > 0 ? wc : (ctxCap > 0 ? ctxCap : undefined),
          timeline: stages?.timeline ?? undefined,
        });
        // A-966：同时把时间线回填 history.jsonl（重启恢复时间线不依赖 localStorage 存活）
        if (stages?.timeline?.length) {
          const attachApi = (window as unknown as { slimeAPI?: { chat?: { attachTimeline?: (a: string, s: string | undefined, t: unknown[]) => Promise<unknown> } } }).slimeAPI;
          void attachApi?.chat?.attachTimeline?.(agentId, sessionRef.current, stages.timeline as unknown[]);
        } else {
          // 无时间线（如纯文本回复）也记录空数组，幂等覆盖旧值而非残留上次
          const attachApi = (window as unknown as { slimeAPI?: { chat?: { attachTimeline?: (a: string, s: string | undefined, t: unknown[]) => Promise<unknown> } } }).slimeAPI;
          void attachApi?.chat?.attachTimeline?.(agentId, sessionRef.current, []);
        }
      }
      onConversationsChanged?.();
      // A-918：流已落库（done）→ 移除该会话的现场快照，释放内存且防止切回后再残留"生成中"
      if (m.sessionId) {
        delete perSessionStreamCache.current[m.sessionId];
      }
    });
    const off3 = api.chat.onError((e: { message: string; sessionId?: string }) => {
      // 事件过滤：旧会话/旧 Agent 的错误不处理（其流已被取消/作废）
      if (e.sessionId != null) {
        // A-918+：非当前会话也要先校准快照 hasActive=false 并记录 tailError，
        // 否则切回时仍显示"恢复中"或丢失失败信息
        if (e.sessionId !== sessionRef.current) {
          const sid = e.sessionId;
          const snap = perSessionStreamCache.current[sid] ?? { partial: "", reasoning: "", toolEvents: [], timeline: [], hasActive: true };
          snap.hasActive = false;
          if (e.message) { snap.tailError = { content: e.message, reason: "stream_error" }; }
          perSessionStreamCache.current[sid] = snap;
          return;
        }
      } else if (streamSessionRef.current !== sessionRef.current) { return; }
      const msg = e.message ?? "";
      // 模型不支持图片输入 → 友好提示（上游返回 "this model does not support image input"），不重连
      if (/does not support image input|Cannot read.*image/i.test(msg)) {
        void alertAsync("当前模型不支持图片输入，请先切换到支持视觉的模型（如 agnes-2.5-flash、gpt-4o 等）。");
        resetStreamUI();
        return;
      }
      console.error("[chat] error:", msg);
      // 仅处理本面板发起的活跃流：其它面板/旧流/会话外的错误一律忽略，避免误伤 UI 状态
      if (!streamActiveRef.current) { return; }
      streamActiveRef.current = false;
      // 用户主动停止：不再重连，直接收尾
      if (stoppingRef.current) {
        resetStreamUI();
        return;
      }
      const MAX_RETRY = 9;
      // 不可恢复错误（403 区域限制 / 401 认证失败 / 404 模型不存在等）：
      // 重连与换路都不会成功，直接终止并提示用户按诱因处理，避免 9 次无效重连耗时长等待
      if (isPermanentStreamError(msg)) {
        failReconnect(msg, 0);
        return;
      }
      if (retryCountRef.current < MAX_RETRY) {
        retryCountRef.current += 1;
        const attempt = retryCountRef.current;
        setReconnectInfo({ attempt, total: MAX_RETRY });
        // 清掉上一次流的残片（部分正文/思考/工具事件），避免重连后画面残留旧内容。
        // 仅清展示集合：toolTraceRef 是本次回复的留痕，重连不清（A-147：否则工具记录随重连丢失）
        resetPartial();
        setReasoningTmp("");
        reasoningTmpRef.current = "";
        setToolEvents([]);
        toolEventsRef.current = [];
        setStreamModel("");
        // 稍作延迟再重发（避免上游瞬时故障时风暴式重连），重连成功即恢复流式输出
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        const payload = streamReqRef.current;
        if (!payload) {
          failReconnect(msg, MAX_RETRY);
          return;
        }
        // A-916：从配置读取断流重连基间隔（异步拉取，prefetch 覆盖用户最近一次调整）
        api.requests?.get?.().then((r: any) => {
          if (typeof r?.reconnectBaseMs === "number" && r.reconnectBaseMs >= 500) {
            reconnectBaseMsRef.current = r.reconnectBaseMs;
          }
        }).catch(() => { /* 保持默认 */ });
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          streamActiveRef.current = true;
          // 故障自愈续接：重连时告知模型中断发生与已完成进度，避免幻觉「已完成」或从头重做
          void api.chat.stream({ ...payload, resumeHint: buildResumeHint() });
          // A-916：基间隔 ×（尝试序号+1）× 0.8~1.2 抖动（指数退避 + 防惊群）——紧重试会放大上游节流（OpenAI 官方：失败的请求也计入限额）
        }, Math.round(reconnectBaseMsRef.current * (attempt + 1) * (0.8 + Math.random() * 0.4)));
        return;
      }
      failReconnect(msg, MAX_RETRY);
    });
    // A-918：流终态广播订阅——后台流真实结束后把对应会话快照 hasActive 校准为 false，
    // 根治「切走再切回仍显示生成中/仍重连」的假活跃状态；本会话的收尾仍由 onDone/onError 承担。
    // 必须在 effect 内创建订阅：原实现写在组件函数体，每次重渲染都泄漏一个监听器（流式期间
    // 每 50ms 一次 setState → 每分钟上千个订阅永不解绑，事件派发 O(n) 累积直至卡死）。
    const off4 = (() => {
      const w = window as unknown as { slimeAPI?: any };
      const fn = w.slimeAPI?.chat?.onStreamEnded;
      if (typeof fn !== "function") { return () => {}; }
      return fn((ev: { sessionId?: string }) => {
        const sid = ev?.sessionId;
        if (!sid) { return; }
        const snap = perSessionStreamCache.current[sid];
        if (snap) { snap.hasActive = false; }
      });
    })();
    return () => { off1(); off2(); off3(); off4(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, makeMessage]);

  /** 判断是否处于底部（阈值 48px 内视为底部）。
   *  A-129：rAF 合帧，避免每次 scroll 事件（≈60Hz）都触发 setState 整面板重渲染 */
  const scrollRafRef = React.useRef<number | null>(null);
  function handleScroll(): void {
    if (scrollRafRef.current !== null) { return; }
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el) { return; }
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
    });
  }

  /** 准星回底：跳回最新消息并恢复自动追踪 */
  function jumpToLatest(): void {
    const el = scrollRef.current;
    if (el) { el.scrollTop = el.scrollHeight; }
    setAtBottom(true);
  }

  /** 自动追踪：仅在用户位于底部时跟随最新输出（上滑即暂停，回底自动恢复）。
   *  A-129：rAF 合帧 scrollTop 写入，流式下最多每帧一次强制布局，避免 50ms 节流与
   *  scroll 事件叠加产生布局抖动 */
  React.useEffect(() => {
    if (!atBottom) { return; }
    const el = scrollRef.current;
    if (!el) { return; }
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages, partial, toolEvents, reasoningTmp, atBottom]);

  /** 自动增高输入框（上限 120px） */
  function autoResize(): void {
    const ta = inputRef.current;
    if (!ta) { return; }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }

  /** A-951：@成员候选（按输入前缀过滤，前缀为空 = 全部） */
  const atList = React.useMemo(() => {
    if (!atOpen) { return [] as string[]; }
    const q = atFilter.toLowerCase();
    if (!q) { return teamRoster; }
    return teamRoster.filter((n) => n.toLowerCase().includes(q));
  }, [atOpen, atFilter, teamRoster]);

  /** A-951：确认选中成员 → 替换光标处的 @前缀 为 @名字 */
  const pickMember = React.useCallback((name: string): void => {
    const r = atRangeRef.current;
    setAtOpen(false);
    if (!r) { return; }
    const next = `${input.slice(0, r.start)}@${name} ${input.slice(r.end)}`;
    setInput(next);
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (ta) {
        const caret = r.start + 1 + name.length + 1; // @名字 后补一个空格，光标停在空格后
        ta.focus();
        ta.setSelectionRange(caret, caret);
      }
    });
  }, [input]);

  /** 输入联想：≥1 字防抖检索历史会话 */
  React.useEffect(() => {
    if (!input.trim() || input.startsWith("/") || loading) {
      setSuggestions([]);
      return;
    }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const timer = window.setTimeout(() => {
      void api.suggest(input.trim()).then((items: SuggestionItem[]) => {
        setSuggestions(items);
      }).catch(() => setSuggestions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [input, loading]);

  /** 指令面板："/" 开头时过滤显示 */
  const cmdList = React.useMemo(() => {
    if (!cmdOpen) { return []; }
    const q = cmdFilter.trim();
    if (!q) { return COMMANDS; }
    return COMMANDS.filter((c) => c.cmd.startsWith(q.toLowerCase()));
  }, [cmdOpen, cmdFilter]);

  function runCommand(c: (typeof COMMANDS)[number]): void {
    setCmdOpen(false);
    setInput("");
    setCmdFilter("");
    switch (c.action) {
      case "fork":
        // A-943：自分裂（fork）已并入子代理体系——GUI 独立入口移除，改用「设置→后台任务→子代理」/ delegate_subagent 工具
        void alertAsync("自分裂已并入子代理：请在「设置 → 后台任务」派发子代理，或对话中委派（delegate_subagent 工具）。子代理拥有独立上下文、并行执行，能力等价且更可控。");
        break;
      case "thinking": {
        // 快捷键循环：以「推理配置」面板当前可选等级为准（none + 手动等级集，
        // 等级集由设置里选择的推理等级模式 / 上游返回 / 兜底预设决定）
        const order = ["none", ...manualEfforts];
        const idx = order.findIndex((o) => o === reasoningEffort);
        const next = order[(idx < 0 ? -1 : idx) + 1] ?? order[0];
        onReasoningChange?.(next);
        break;
      }
      case "nav:status":
        onNavigateSettings?.("status");
        break;
      case "nav:agents":
        onNavigateSettings?.("agents");
        break;
      case "nav:providers":
        onNavigateSettings?.("providers");
        break;
      case "new":
        onNewSessionRequested?.();
        break;
      case "rename":
        setRenameDraft(sessionTitle);
        setRenaming(true);
        break;
      case "clear":
        void handleClearConversation();
        break;
      case "help":
        setCmdOpen(true);
        setCmdFilter("");
        break;
    }
  }

  /** 清空当前会话历史 */
  async function handleClearConversation(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    if (!(await confirmAsync(`清空会话「${sessionTitle}」的历史？`, "会话本身保留。"))) { return; }
    await api.conversations.clear(sessionId).catch(console.error);
    // A-934：清空会话 = 历史 records 全部删除，持久化的时间线/窗口占用按序数已无对应消息 → 一并清除
    clearSessionCtxMeta(agentId, sessionId);
    setMessages([]);
    resetPartial();
    // 清空会话 = 重新开始：会话内图片记忆与待发图一并清空，防旧图在清空后仍被自动携带
    sessionImagesRef.current = [];
    setPendingImages([]);
    setReasoningTmp("");
    reasoningTmpRef.current = "";
    setToolEvents([]);
    toolEventsRef.current = [];
    toolTraceRef.current = [];
    timelineStepsRef.current = [];
    setLiveTimeline([]);
    onConversationsChanged?.();
  }

  /** ＋ 栏：拉取技能/MCP 列表 */
  async function openPlusPanel(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    setPlusOpen((prev) => {
      const next = !prev;
      if (next && !extras) {
        void api.extras.list().then((e: ExtrasList) => setExtras(e)).catch(console.error);
      }
      return next;
    });
  }

  async function send(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const hasPending = pendingImages.length > 0;
    // 允许「只发图片、不带文字」（user content 空文本 + 图）
    if (!api || (!input.trim() && !hasPending)) { return; }
    // A-162：插入指令（interrupt-insert）。此前 loading/stopping 时的新消息被静默丢弃
    // （用户只能先点停止再输入）—— 这是本轮要修的体验：Agent 思考/输出期间，用户输入
    // 的新指令应立即中断当前生成（保留已产出内容交由 onDone/interrupted 收尾落库），
    // 然后新消息作为新一轮立即发出。等价于 Claude Code/Cursor 的"打断插入"。
    if (loading || stopping) {
      const interruptText = input.trim();
      // 打断插入同样携带本次待发图片（中断旧流后新一轮立即带图）
      const interruptImages = pendingImages.map((i) => i.dataUrl);
      setInput("");
      setLoading(true); // 保持 loading：如旧流仍在跑，先让其中断收尾
      const wasStopping = stoppingRef.current || stopping;
      stoppingRef.current = true; // 中断旧流：不再自动重连
      // 中断旧流（abort → 后台自然结束当前工具/生成阶段 → onDone(interrupted) 收尾落库）
      await api.chat.cancel(sessionId).catch(() => undefined);
      // 新指令注册为待发消息：待旧流 done/error 收尾后触发新流（见 onDone 尾部续发）
      interruptQueueRef.current.push({ agentId, message: interruptText, sessionId, networkEnabled, images: interruptImages });
      setStopping(false);
      stoppingRef.current = wasStopping;
      // 若旧流已无活动（loading 是残留），立即发新流
      if (!streamActiveRef.current) {
        setLoading(false);
        doSend(interruptText);
      }
      return;
    }
    // 检查当前模型是否支持图片输入（防止调用不支持 vision 的模型时触发 400）
    // 用 curProviderModel（按「供应商 key + 模型 ID」双匹配）而非 flatMap+split(":").pop()：
    // 后者在模型 ID 含冒号（如 org:model/xxx:latest）时解析错误，导致 vision 元数据匹配失败
    const hasVision = curProviderModel?.vision === true
      || (modelChoice ?? "").includes("vision")
      || (modelChoice ?? "").includes("flash") && !(/reasoner|reasoning|deepseek-r|o1|o3/.test(modelChoice ?? ""));
    if (!hasVision && (pendingImages.length > 0 || /image|png|jpg|jpeg|webp|gif|\.png|\.jpg/i.test(input))) {
      void alertAsync("当前模型「" + (modelChoice?.split(":").pop() ?? modelChoice) + "」不支持图片输入，请先切换到支持视觉的模型（如 agnes-2.5-flash、gpt-4o 等）。");
      return;
    }
    const text = input.trim();
    doSend(text);
  }

  /** A-969：发送前上下文压缩体检（maybeAutoCompress 由 doSend 开头 await）。
   *  - 仅发送侧（非打断插入）触发：ctxUsed/cap 超过阈值且本轮未压过；
   *  - 动画版：prep（整理）→ summarize（生成摘要）→ done/trunc 过渡浮层，遇失败短暂展示后一律继续发送（绝不卡用户）；
   *  - 静默版：同流程无动画，await 完成直接发送；
   *  - 压缩由主进程执行（engine.summarizeContext 摘要轮），失败自动降级硬裁剪并写回会话 meta。 */
  async function maybeAutoCompress(sid: string): Promise<void> {
    if (compressBusyRef.current || didCompressTurnRef.current || loading || stopping) { return; }
    if (ctxUsed <= 0 || ctxCap <= 0) { return; }
    const cfg = readAutoCompressCfg();
    if (!cfg.enabled) { return; }
    if (ctxUsed < ctxCap * cfg.ratio) { return; } // 未达触发占比，不压缩
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.chat?.compress) { return; }
    const animated = cfg.mode !== "silent";
    compressBusyRef.current = true;
    didCompressTurnRef.current = true;
    try {
      if (animated) {
        setCompressUi({ stage: "prep" });
        await new Promise((r) => setTimeout(r, 420));
        setCompressUi({ stage: "summarize" });
      }
      const res = await api.chat.compress(sid, cfg.ratio);
      if (animated && res) {
        if (res.skipped) {
          setCompressUi(null);
        } else if (res.truncated) {
          setCompressUi({ stage: "trunc", dropped: res.dropped ?? 0 });
          await new Promise((r) => setTimeout(r, 1500));
          setCompressUi(null);
        } else if (res.ok && res.summary) {
          setCompressUi({ stage: "done", dropped: res.dropped ?? 0, summary: res.summary });
          await new Promise((r) => setTimeout(r, 1400));
          setCompressUi(null);
        } else {
          setCompressUi(null);
        }
      }
      // 压缩生效 → 本地占用镜像回落（真实值由本轮 done 的 promptTokens 校准；此处仅即时反馈）
      if (res?.ok && (res.summary || res.truncated) && res.cap && res.cap > 0) {
        const next = Math.max(1, Math.round(res.cap * 0.5));
        setCtxUsed(next);
        dispatchCtxUpdate({ sessionId: sid, used: next, cap: ctxCap > 0 ? ctxCap : res.cap });
      }
    } catch {
      setCompressUi(null); // 压缩失败不阻塞发送
    } finally {
      compressBusyRef.current = false;
    }
  }

  /** A-162/A-164：真正执行发送（含输入框清空/历史追加/流式初始化/入参记录）。send() 与插入指令续发共用。
   *  注意：本函数总是清空输入框（调用方只管把内容传进来）——此前重构遗漏 setInput("")，
   *  导致「消息发出后文本仍留在输入框」的用户实测回归（A-164）。 */
  async function doSend(text: string, targetSessionId?: string): Promise<void> {
    // A-969：发送前上下文压缩体检（对齐 Claude Code「每次 query 前 context 检查」）——
    // 输入侧占用 ≥ cap×ratio 且本轮未压过 → 先跑摘要轮并展示过渡动画，再继续正常发送
    await maybeAutoCompress(targetSessionId ?? sessionId);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    // 识图：本轮待发图片 + 会话内已发送图片（多轮识图），合并取最近 ≤4 张
    const imagesToSend = [
      ...pendingImages.map((i) => i.dataUrl),
      ...sessionImagesRef.current.map((i) => i.dataUrl),
    ].slice(-4);
    // 允许「只发图片、不带文字」
    if (!api || (!text && imagesToSend.length === 0)) { return; }
    const sid = targetSessionId ?? sessionId;
    // A-918++：自动委派启发式（保守）——消息明确要求"调研/研究/分析/审查/搜索对比/批量处理/汇总盘点"且足够长时，
    // 后台自动派一个专家子代理并行处理（用户立即可见 SubAgentBar 活动，不必等模型自觉调工具）
    const trimmedText = text.trim();
    if (trimmedText.length >= 24 && !/^(什么|为什么|怎么|如何|哪个|多少|能否|可以|是不是|有没有)/.test(trimmedText)) {
      const strong = /(?:联网|深度|全面)?(?:调研|研究|分析|审查|review)|(?:搜索|查询)[^。\n]{0,20}(?:对比|比对)|批量(?:处理|生成|检查)|(?:整理|汇总|盘点)[^。\n]{0,20}(?:数据|资料|信息)/i;
      if (strong.test(trimmedText)) {
        void api.resident?.subagentDelegate?.({ task: trimmedText.slice(0, 200) }).catch(() => { /* 派发失败不阻断主线 */ });
      }
    }
    setInput(""); // 受控清空输入框（textarea value={input}）；不直写 DOM，避免与 React 渲染竞态
    setAtOpen(false); // A-951：发送后收起 @ 选择器
    const modelLabel = !modelChoice || modelChoice === "inherit" ? "inherit" : (modelChoice.split(":").pop() || modelChoice);
    setMessages((prev) => [...prev, makeMessage("user", text, {
      model: modelLabel, mode,
      images: imagesToSend.length > 0 ? imagesToSend : undefined,
    })]);
    // A-918：乐观用户消息进入 per-session 快照——流未落库期间切走再切回，指令不丢（根治"切走吞指令"）
    {
      const snap = perSessionStreamCache.current[sid] ?? { partial: "", reasoning: "", toolEvents: [], timeline: [], hasActive: true };
      snap.hasActive = true;
      snap.messages = [...(snap.messages ?? []), makeMessage("user", text, {
        model: modelLabel, mode,
        images: imagesToSend.length > 0 ? imagesToSend : undefined,
      })];
      perSessionStreamCache.current[sid] = snap;
    }
    // 发送后：图片并入会话记忆（留作下一轮识图上下文），清空待发区
    if (imagesToSend.length > 0) {
      sessionImagesRef.current = imagesToSend.slice(-4).map((u) => ({ name: "", dataUrl: u }));
    }
    setPendingImages([]);
    resetPartial();
    setReasoningTmp("");
    reasoningTmpRef.current = "";
    setReasoningOpen(true);
    reasoningManuallyToggledRef.current = false;
    setToolEvents([]);
    toolEventsRef.current = [];
    toolTraceRef.current = [];
    timelineStepsRef.current = [];
    setLiveTimeline([]);
    setSuggestions([]);
    setLoading(true);
    setStopping(false);
    // A-935：发送即更新（单一事件源）——会话输入按字符估算（中英混合 ÷3），环与右栏立即响应；
    // 数值与既有占用取大（窗口单调不缩），真实 usage 在该轮 done 时校准覆盖。
    // 估算只作"发送后即时反馈"，不为精确（厂商 Claude Code 状态栏同为估算 + usage 校准式）。
    {
      // A-968：上下文估算排除图片 dataURL 原始字符——base64 字符串会把估算 token 数打到
      // 几个 M（环直接爆满/红）；图片按 ~2000 token 计（对齐 Claude Code 图片占用口径）
      const estChars = (messages ?? []).reduce((s, m) => {
        const textLen = ((m as { content?: string }).content?.length) ?? 0;
        const imgs = (((m as { images?: string[] }).images) ?? []).length;
        return s + textLen + imgs * 2000;
      }, 0) + (text?.length ?? 0) + 2500; // ≈系统提示/工具定义近似
      const estimate = Math.round(estChars / 3);
      const capNow = ctxCap > 0 ? ctxCap : (curProviderModel?.context_window ?? 0);
      if (capNow > 0) { setCtxCap(capNow); }
      if (estimate > 0) {
        setCtxUsed((prev) => Math.max(prev, estimate));
        dispatchCtxUpdate({ sessionId: sid, used: Math.max(ctxUsed, estimate), cap: capNow });
      }
    }
    // 上游 max_output 元数据 → max_tokens：限制单次输出上限（有值才传，未标注不限制）
    const maxTokens = typeof curProviderModel?.max_output === "number" && curProviderModel.max_output > 0
      ? curProviderModel.max_output
      : undefined;
    // 自动重连状态初始化：记录本次流式入参，重置计数（中断旧的重连定时器）
    streamActiveRef.current = true;
    streamSessionRef.current = sid; // 本流归属当前会话（chunk/done/error 过滤依据）
    streamReqRef.current = { agentId, message: text, sessionId: sid, networkEnabled, maxTokens, images: imagesToSend.length > 0 ? imagesToSend : undefined };
    retryCountRef.current = 0;
    stoppingRef.current = false;
    setReconnectInfo(null);
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // 重置流式监测
    streamStartRef.current = 0;
    streamCharCountRef.current = 0;
    streamTokensRef.current = 0;
    setStreamElapsed(0);
    setStreamTokens(0);
    setStreamModel("");
    if (streamElapsedTimerRef.current !== null) {
      window.clearInterval(streamElapsedTimerRef.current);
      streamElapsedTimerRef.current = null;
    }
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.focus();
    }
    void api.chat.stream({ agentId, message: text, sessionId: sid, networkEnabled, maxTokens, images: imagesToSend.length > 0 ? imagesToSend : undefined });
  }

  /** 主动中断当前 Agent 输出（底层 abort + 保留已生成部分） */
  async function stopGeneration(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || !loading || stopping) { return; }
    setStopping(true);
    stoppingRef.current = true; // 后续 error/done 均不再自动重连
    const res = await api.chat.cancel(sessionId).catch((e: unknown) => {
      console.error("[chat] cancel failed:", e);
      return { ok: false };
    });
    // 底层中断后仍会流入 onDone 收尾；这里兜底：若取消失败则直接复位 UI
    if (!res?.ok) {
      setLoading(false);
      setStopping(false);
    }
  }

  async function handleRetry(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || messages.length === 0) { return; }
    let lastAiIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") { lastAiIdx = i; break; }
    }
    if (lastAiIdx < 0) { return; }
    const before = messages.slice(0, lastAiIdx);
    setMessages(before);
    resetPartial();
    setReasoningTmp("");
    reasoningTmpRef.current = "";
    setReasoningOpen(true);
    reasoningManuallyToggledRef.current = false;
    setToolEvents([]);
    toolEventsRef.current = [];
    toolTraceRef.current = [];
    // 重试发起新流前清空留痕（防御：旧残留不污染新流）
    timelineStepsRef.current = [];
    setLiveTimeline([]);
    setLoading(true);
    const result = await api.chat.retryLast(agentId, sessionId);
    if (result.error) {
      console.error("[chat] retry failed:", result.error);
      setLoading(false);
    }
  }

  /** 会话级配置：工作目录 / 审批模式（项目 = Agent 级设定） */
  async function setSessionConfigField(patch: { approval?: ApprovalMode; workspace?: string | null }): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.config({ agentId, ...patch }).catch((e: unknown) => {
      console.error("[chat] session config failed:", e);
      return null;
    });
    if (res?.ok) {
      setSessionConfig({ approval: res.approval, workspace: res.workspace });
    }
  }

  async function handlePickFolder(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.pickFolder();
    if (res.ok && res.path) {
      await setSessionConfigField({ workspace: res.path });
    }
  }

  /** A2A 委派（团队协作保留：组长通过 <DELEGATE> 消息路由委派给已有 Agent；独立传唤入口已移除） */

  /** 展开/折叠某条已完成消息的思考块（默认折叠）。
   *  useCallback：引用稳定，否则 AssistantMessage(memo) 的 onToggle 每次渲染都变，
   *  导致流式 partial 触发整表历史消息全量重渲染（含逐个重解析 Markdown）——掉帧主因。 */
  const toggleReasoning = React.useCallback((id: number): void => {
    setCollapsedReasoning((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
  }, []);

  /** ＋ 气泡：选择文件 → 以附件占位注入输入框（图片/文档路径引用，待补充指令后发送） */
  async function handleImportFile(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.files) { return; }
    const res = await api.files.pick().catch((e: unknown) => {
      console.error("[chat] pick file failed:", e);
      return null;
    });
    if (!res?.ok || !res.path) { return; }
    const name = res.path.split(/[\\/]/).pop() ?? res.path;
    setInput((prev) => {
      const base = prev.trimEnd();
      return `${base ? base + " " : ""}📎[${name}]`;
    });
    setPlusOpen(false);
    setSuggestions([]);
    inputRef.current?.focus();
  }

  /* ── 识图：图片附件（选择 / 粘贴 / 拖拽），最多 4 张 ── */

  /** 把 File 对象读为 data URL（渲染层本地编码，不经 IPC 中转） */
  const fileToDataUrl = React.useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
  }, []);

  /** 追加图片文件到待发送列表（≤4 张；超限截断提示）。兼容 FileList 与 File[] */
  const appendImageFiles = React.useCallback(async (files: FileList | File[] | null | undefined): Promise<void> => {
    if (!files) { return; }
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) { return; }
    let added = 0;
    const imgs: Array<{ id: string; name: string; dataUrl: string }> = [];
    for (const f of list) {
      if (f.size > 8 * 1024 * 1024) { continue; }
      try {
        const dataUrl = await fileToDataUrl(f);
        imgs.push({ id: `img-${++imagesSeqRef.current}`, name: f.name || "图片", dataUrl });
      } catch { /* 跳过读取失败 */ }
    }
    if (imgs.length === 0) { return; }
    setPendingImages((prev) => {
      const merged = [...prev, ...imgs];
      const kept = merged.slice(-4); // 只保留最近 4 张
      const dropped = merged.length - kept.length;
      if (dropped > 0) {
        window.setTimeout(() => void alertAsync(`图片超限，仅保留最近 4 张（已丢弃 ${dropped} 张）`), 0);
      }
      return kept;
    });
    added = imgs.length;
    setPlusOpen(false);
    void added;
  }, [fileToDataUrl]);

  /** ＋ 气泡 → 发送图片：主进程对话框选图（多选）→ data URL 附加到输入区 */
  async function handlePickImages(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.images) { return; }
    const res = await api.images.pick().catch((e: unknown) => {
      console.error("[chat] pick images failed:", e);
      return null;
    });
    if (!res?.ok || !res.images || res.images.length === 0) {
      if (res?.error) { void alertAsync(res.error); }
      return;
    }
    if (res.error) {
      void alertAsync(res.error);
    }
    let dropped = 0;
    setPendingImages((prev) => {
      const imgs = res.images!.map((im: { name: string; mime: string; dataUrl: string }) => ({ id: `img-${++imagesSeqRef.current}`, name: im.name, dataUrl: im.dataUrl }));
      const merged = [...prev, ...imgs];
      const kept = merged.slice(-4);
      dropped = merged.length - kept.length;
      return kept;
    });
    if (dropped > 0) {
      window.setTimeout(() => void alertAsync(`图片超限，仅保留最近 4 张（已丢弃 ${dropped} 张）`), 0);
    }
    setPlusOpen(false);
    setSuggestions([]);
    inputRef.current?.focus();
  }

  /** 删除附件行中的某张图片 */
  function handleRemoveImage(id: string): void {
    setPendingImages((prev) => prev.filter((i) => i.id !== id));
  }

  /** textarea 粘贴：剪贴板里的图片（截图）直接转为附件 */
  const handlePasteImages = React.useCallback((e: React.ClipboardEvent): void => {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) { return; }
    if (Array.from(files).some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void appendImageFiles(files);
    }
  }, [appendImageFiles]);

  /** input 容器拖拽：图片文件直接转为附件 */
  const handleDropImages = React.useCallback((e: React.DragEvent): void => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) { return; }
    if (Array.from(files).some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void appendImageFiles(files);
    }
  }, [appendImageFiles]);

  const canRetry = messages.length > 0 && !loading;

  /** 回滚：撤销某条用户消息及其之后的全部对话，内容放回输入框。
   *  useCallback(messages)：流式期间 messages 不变 → 引用稳定 → UserMessage(memo) 不因
   *  onRollback 引用变化而重渲染；仅在真正换消息时重建。 */
  const rollbackTo = React.useCallback((id: number): void => {
    if (loading) { return; }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) { return; }
    const target = messages[idx];
    const retained = messages.slice(0, idx);
    setMessages(retained);
    setInput(target.content);
    resetPartial();
    inputRef.current?.focus();
    // A-161：回滚持久化一致性 —— 同步截断后端历史到该用户消息之前，
    // 否则仅改前端 UI，重启后 loadHistoryForSession 仍会加载回滚前的旧消息。
    // 目标 user 消息（其内容放回输入框）及其后的记录全部删除。
    if (api?.chat?.truncateFrom && target.role === "user" && sessionId) {
      void api.chat.truncateFrom(agentId, sessionId, target.content).catch(() => undefined);
    }
  }, [messages, resetPartial, agentId, sessionId, loading]);
  const filteredCmd = cmdList;

  /* ── 当前模型思考/推理能力（动态，随模型切换与上游返回实时变化）── */
  const parsedChoice = React.useMemo(() => parseModelChoice(modelChoice ?? ""), [modelChoice]);
  const isProviderModel = parsedChoice.type === "api";
  // 按「供应商 key + 模型 ID」双匹配：避免跨供应商同名模型元数据串扰（同一 id 一个声称
  // thinking:true、另一个 false 时，此前全域 find 永远拿到第一个 → 切模型也救不回来）；
  // 同时模型 ID 内含冒号也能正确解析。
  const curProviderModel = React.useMemo(() => {
    if (parsedChoice.type !== "api" || !parsedChoice.key || !parsedChoice.modelId) { return undefined; }
    return providerModels.find((p) => p.key === parsedChoice.key)?.models
      ?.find((m) => m.id === parsedChoice.modelId) ?? undefined;
  }, [providerModels, parsedChoice.type, parsedChoice.key, parsedChoice.modelId]);
  // 思考开关的「默认关闭」状态：上游明确 thinking===false，或元数据缺失且设置里选了
  // 「思考能力默认=一律关闭」。只影响样式/文案与是否自动抬升等级，【不硬禁用按钮】——
  // 模型切换/会话切换时元数据可能短暂缺失，硬禁用会让按钮"死"掉无法恢复（不稳定根因之一）。
  const thinkingPreset = useThinkingPreset();
  const thinkingMetaKnown = isProviderModel && !!curProviderModel && typeof curProviderModel?.thinking === "boolean";
  const curThinkingExplicitlyUnsupported = thinkingForcedOff(thinkingPreset, thinkingMetaKnown, curProviderModel?.thinking);
  // 当前模型已真实探测到的可用推理等级（三层 fallback：上游 > 本地预制表 > 通用默认）
  // A-918++ 修复「推理强度无法选择」：opencode-zen 等中转站模型上游不返回 thinking_efforts，
  // 且 ID 推断表（MODEL_CAPABILITIES）覆盖不了这些中转站 ID → 此前 dropdown 空、无法选择。
  // 最终兜底默认 low/medium/high，保证推理强度【总是可选】；local 模型（如 agnes）也按 ID 推断。
  const curEfforts: string[] = React.useMemo(() => {
    const upstream = (curProviderModel?.thinking_efforts ?? []).filter((e): e is string => typeof e === "string" && e.length > 0);
    if (upstream.length > 0) { return upstream; }
    const id = (parsedChoice.type === "api" || parsedChoice.type === "local") ? (parsedChoice.modelId ?? "") : "";
    const inferred = inferModelCapabilities(id).efforts;
    if (inferred && inferred.length > 0) { return inferred; }
    return ["low", "medium", "high"];
  },
  [curProviderModel, parsedChoice]);
  const curSupportsEffortLevels = curEfforts.length > 0;
  // 设置里选择的推理等级模式（供应商弹窗 → 参数文件调试）：切换后本面板可选等级实时联动
  const reasonPreset = useReasoningPreset();
  const presetEfforts: string[] | null = React.useMemo(() => presetEffortsOf(reasonPreset), [reasonPreset]);
  // 折叠配置里的手动可选等级：
  // - 设置了预制供应商模式（非上游默认）→ 用该模式对应的等级集（个别模型版本不支持的等级
  //   可能被上游拒绝，届时改回「自动」）；
  // - 上游默认且已探测到真实等级 → 用上游返回；
  // - 均无 → 通用预设供异常场景手动兜底。
  // 默认值恒为 none（请求不传 reasoning_effort = 以上游为准）。
  const manualEfforts: string[] = React.useMemo(
    () => (presetEfforts ?? (curEfforts.length > 0 ? curEfforts : ["low", "medium", "high"])),
    [presetEfforts, curEfforts],
  );

  // 模型切换/上游能力变化时，若当前推理等级已不在当前模型可表达的等级集合内，自动回落：
  // - 等级仍在真实等级或兜底预设里（含用户手动指定的）→ 保持不动；
  // - 等级已失效（如上一模型的高等级在当前模型不存在）→ 回落 medium / 首个可用 / none。
  React.useEffect(() => {
    const eff = reasoningEffort;
    if (!eff || eff === "none") { return; }
    if (manualEfforts.includes(eff)) { return; }
    const fallback = curSupportsEffortLevels
      ? (curEfforts.includes("medium") ? "medium" : curEfforts[0])
      : "none";
    onReasoningChange?.(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelChoice, manualEfforts, curSupportsEffortLevels]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative", overflow: "hidden" }}>
      {/* 顶部工具栏：会话组 | 思考开关 | 工作目录 | 计时 | 上下文圆环（模型/模式/审批/推理已移入输入框） */}
      <div className="glass-bar" style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "8px 12px", background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border)", flexWrap: "wrap",
      }}>
        {renaming ? (
          <input
            className="input-field" autoFocus
            style={{ fontSize: 12.5, padding: "3px 10px", width: 200 }}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onSessionRenamed?.(renameDraft.trim());
                setRenaming(false);
              }
              if (e.key === "Escape") { setRenaming(false); }
            }}
            onBlur={() => {
              onSessionRenamed?.(renameDraft.trim());
              setRenaming(false);
            }}
          />
        ) : (
          <span style={{
            color: "var(--text)", fontSize: 13, fontWeight: 600,
            padding: "2px 6px 2px 12px", borderRadius: "12px",
            background: "var(--accent-soft)",
            display: "flex", alignItems: "center", gap: 4, maxWidth: 300,
          }}>
            {agents.length > 0 && sessionType !== "brainstorm" ? (
              <GhostSelect
                value={agentId}
                options={agents.map((a) => ({ value: a.id, label: a.name, title: a.role || "无角色" }))}
                onChange={(id) => { if (id !== agentId) { onAgentSwitch?.(id); } }}
                title="切换会话内调用的 Agent（同一工作文件夹内可多 Agent 协作，避免单个 Agent 被并发占用阻塞；切换不丢失会话历史与工作目录）"
                maxWidth={240}
                displayLabel={agentName}
                style={{ maxWidth: 140, fontSize: 12.5, fontWeight: 700 }}
              />
            ) : (
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 12.5, fontWeight: 700 }}>
                {sessionType === "brainstorm" ? `群聊 · 成员 ${(memberCount ?? 0)}` : agentName}
              </span>
            )}
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              / {sessionTitle}
            </span>
            {!!workspace && (
              <span
                title={`工作文件夹：${workspace}`}
                style={{
                  fontSize: 11.5, color: "var(--accent-hover)",
                  background: "var(--bg-input)", border: "1px solid var(--border)",
                  borderRadius: 10, padding: "1px 8px",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180,
                }}
              >
                <span aria-hidden>⌂ </span>{pathBaseLocal(workspace)}
              </span>
            )}
            <button className="titlebar-btn" style={{ fontSize: 11, opacity: 0.7 }}
              title="重命名会话"
              onClick={() => { setRenameDraft(sessionTitle); setRenaming(true); }}>
              <EditIcon size={14} />
            </button>
          </span>
        )}
        <button onClick={() => onNewSessionRequested?.()} disabled={loading}
          className="btn" title="项目内新建会话">
          新会话
        </button>
        <button onClick={handleRetry} disabled={!canRetry}
          className="btn primary" title="重试上一条（重发最后一条用户消息）">
          重试
        </button>
        <button onClick={() => {
          const nextThinking = !showThinking;
          onThinkingChange?.(nextThinking);
          // 开启思考显示时：仅当模型【真实探测到】等级、或设置了预制供应商模式（用户显式选过 → 信任
          // 该模式）且当前未设等级 → 自动抬升到合理等级（medium > low > 首个），确保真的产出思考；
          // 两者都无（元数据缺失且未选模式）→ 只切开关不传 effort，
          // 避免把 reasoning_effort 强塞给不支持的模型导致请求被上游拒绝。
          if (nextThinking && (curSupportsEffortLevels || presetEfforts !== null) && (!reasoningEffort || reasoningEffort === "none")) {
            const raiseSrc = manualEfforts.filter((e) => e !== "none");
            onReasoningChange?.(raiseSrc.includes("medium") ? "medium" : (raiseSrc.includes("low") ? "low" : (raiseSrc[0] ?? "")));
          }
        }}
          title={curThinkingExplicitlyUnsupported
            ? thinkingMetaKnown
              ? "上游标注该模型不支持思考：开关仅控制是否展示已有思考过程（不自动设置推理强度）；若模型实际支持思考，可在下方「推理配置」手动指定强度"
              : "「思考能力默认」已设为一律关闭，且该模型未返回思考能力元数据：开关默认关闭；若模型实际支持思考，可在下方「推理配置」手动指定强度或到供应商设置改回上游检测"
            : "思考显示：开启时请求并展示 Agent 的思考过程（未开启推理时自动设为中等，输出时展开、完成后自动折叠，可手动展开/折叠）"}
          style={{
            height: 26, padding: "0 10px", borderRadius: 13,
            border: curThinkingExplicitlyUnsupported ? "1px dashed var(--border)" : `1px solid ${showThinking ? "var(--accent)" : "var(--border)"}`,
            background: curThinkingExplicitlyUnsupported ? "transparent" : (showThinking ? "var(--accent-soft)" : "transparent"),
            color: curThinkingExplicitlyUnsupported ? "var(--text-dim)" : (showThinking ? "var(--accent-hover)" : "var(--text-muted)"),
            fontSize: 12, fontWeight: 700, cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 5,
            transition: "background 0.12s, border-color 0.12s, color 0.12s, transform 0.08s",
          }}
          onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.92)"; }}
          onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
          onMouseEnter={(e) => { if (showThinking) { e.currentTarget.style.background = "var(--accent-soft)"; } }}
          onMouseLeave={(e) => { if (!showThinking) { e.currentTarget.style.background = "transparent"; } }}>
          <ThinkingIcon size={16} />
          思考: {showThinking ? "开" : "关"}
        </button>
        <span style={{ color: "var(--text-dim)", margin: "0 4px" }}>|</span>
        <button onClick={handlePickFolder}
          className="btn" title={`工作目录：${sessionConfig.workspace || "未设置（不限制读写范围）"}`}
          style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sessionConfig.workspace || "选择工作目录"}
        </button>
        {lastTimings && lastTimings.elapsedMs && (
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {lastTimings.elapsedMs}ms
            {lastTimings.promptTokens && ` · ${lastTimings.promptTokens}+${lastTimings.completionTokens ?? 0}tok`}
          </span>
        )}
        <ContextRing used={ctxUsed} cap={ctxCap} loading={loading} />
      </div>

      {/* 消息区域：卡片化 + 事件行 */}
      <div ref={scrollRef} onScroll={handleScroll}
        style={{ flex: 1, overflowY: "auto", padding: "14px 16px 0", position: "relative", overflowAnchor: "none" }}>
        {messages.length === 0 && !loading && (
          <div style={{ color: "var(--text-dim)", textAlign: "center", marginTop: 48, fontSize: 13 }}>
            与 {agentName} 的会话「{sessionTitle}」
            {sessionConfig.workspace && (
              <div style={{ fontSize: 12, marginTop: 6 }}>
                工作目录：{sessionConfig.workspace}
              </div>
            )}
          </div>
        )}
        {messages.map((m) =>
          m.role === "user"
            ? <UserMessage key={m.id} m={m} onRollback={rollbackTo} />
            : (
              <AssistantMessage
                key={m.id}
                m={m}
                agentName={m.agentName || agentName}
                isMember={!!m.agentId && m.agentId !== agentId}
                showThinking={showThinking}
                collapsed={collapsedReasoning[m.id] ?? true}
                onToggle={toggleReasoning}
              />
            )
        )}
        {loading && (
          <div style={{ display: "flex", gap: 10, marginBottom: 14, opacity: 0.95 }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
              background: "var(--accent-soft)", color: "var(--accent)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 15, fontWeight: 700,
            }}>
              {agentName.charAt(0)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              {/* 状态行：A-918++：删掉原"思考中"轮播 + 圆点（用户要"最上方的'思考中'删去"），只保留 agentName */}
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>
                {agentName}
              </div>

              {/* 思考过程：流式时实时显示（与是否有工具调用无关——纯思考也要可见） */}
              {loading && (
                <div style={{ marginBottom: 6 }}>
                  <button
                    onClick={() => setReasoningOpen((v) => !v)}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 6,
                      padding: "4px 0", background: "transparent", border: "none", cursor: "pointer",
                      color: "var(--text-muted)", fontSize: 12, textAlign: "left",
                    }}
                    title={reasoningOpen ? "收起思考过程" : "展开思考过程"}
                  >
                    <ThinkingIcon size={12} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
                    <span className="text-scan-light" style={{ fontWeight: 600, letterSpacing: 0.3 }}>思考过程</span>
                    {!reasoningOpen && (
                      <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        · {toolEvents.length > 0 ? formatToolSummary(toolEvents) : (reasoningTmp.slice(0, 60) + (reasoningTmp.length > 60 ? "…" : ""))}
                      </span>
                    )}
                    <ChevronIcon size={12} rotate={reasoningOpen ? 90 : 0} style={{ opacity: 0.7 }} />
                  </button>
                  {reasoningOpen && (
                    <div className="think-timeline" style={{ marginTop: 4 }}>
                      {liveTimeline.map((step, i) => (
                        <TimelineNode key={`l${i}`} step={step} autoExpand={i === liveTimeline.length - 1} />
                      ))}
                      {liveTimeline.length === 0 && !reasoningTmp && toolEvents.length === 0 && (
                        <span className="text-scan-light" style={{ fontSize: 11, color: "var(--text-dim)" }}>思考中…</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 工具调用摘要：流式时按类型分组显示（独立于思考过程，无论是否有思考都显示） */}
              {loading && toolEvents.length > 0 && (() => {
                const groups = computeToolGroups(toolEvents);
                return (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "4px 0", color: "var(--text-muted)", fontSize: 12,
                    }}>
                      <BoltIcon size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>工具调用</span>
                      <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 4 }}>· {formatToolSummary(toolEvents)}</span>
                    </div>
                    <div style={{ padding: "4px 0 8px 16px", display: "flex", flexDirection: "column", gap: 3 }}>
                      {groups.map((g) => (
                        <div key={g.type} style={{
                          fontSize: 12, color: "var(--text-muted)",
                          display: "flex", alignItems: "center", gap: 6,
                        }}>
                          <g.Icon size={13} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
                          <span>{g.label}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: "auto" }}>×{g.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div className="msg-body-divider" style={{ margin: "8px 0 10px" }} />
              {/* 部分输出：流式 Markdown 渲染（补全未闭合语法，避免暴露原始符号）。
                  A-968：切回恢复的流由占位气泡内实时续长，此处抑制独立 partial 区（否则"恢复中…"气泡+底部输出双份） */}
              {resumeMsgId === null && (
                <div className="stream-partial" style={{ lineHeight: 1.7, fontSize: 14, wordBreak: "break-word" }}>
                  {deferredPartial ? <Markdown text={deferredPartial} streaming /> : partial ? (<Markdown text={partial} streaming />) : (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 13 }}>
                      <span className="text-scan-light">正在思考</span>
                      <span className="stream-dot-row">
                        <span className="stream-dot" />
                        <span className="stream-dot" style={{ animationDelay: "0.2s" }} />
                        <span className="stream-dot" style={{ animationDelay: "0.4s" }} />
                      </span>
                    </span>
                  )}
                  {/* A-918++：流式打字机末字光标（partial 末尾始终闪烁 8×16 矩形，1s step-start 步进；partial 增长时光标跟着走） */}
                  <span className="stream-cursor" aria-hidden="true" style={{ display: "inline-block", width: 2, height: 16, background: "var(--accent)", marginLeft: 3, verticalAlign: "text-bottom", animation: "blink 1s step-start infinite", willChange: "opacity" }} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* A-918++：回到最新——小巧胶囊内嵌于输入框正上方，随输入区自然排布、不遮挡消息内容 */}
      {!atBottom && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
          <button onClick={jumpToLatest}
            title="回到最新消息（恢复自动追踪）"
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "3px 11px", borderRadius: 999,
              border: "1px solid var(--border-hover)", background: "var(--bg-secondary)",
              color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent-soft)"; e.currentTarget.style.color = "var(--accent-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-secondary)"; e.currentTarget.style.color = "var(--text-secondary)"; }}>
            <img src={downIcon} alt="↓" width={11} height={11} style={{ filter: "brightness(0) invert(0.75)" }} draggable={false} />
            最新
          </button>
        </div>
      )}

      {/* A-917：流失败/重连耗尽的就地错误横幅（红字，随当前会话立即显示，不追加到消息流） */}
      {streamErrorBanner && (
        <div style={{
          padding: "8px 16px", borderTop: "1px solid var(--border)",
          fontSize: 12, color: "#f87171", background: "var(--bg)",
          whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 140, overflowY: "auto",
        }}>
          {streamErrorBanner}
        </div>
      )}

      {/* 重连进度横幅：模型调度异常自动重连时流式输出进度（上限 9 次） */}
      {reconnectInfo && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 16px", borderTop: "1px solid var(--border)",
          fontSize: 12, color: "var(--warning)", background: "var(--bg)",
        }}>
          <span style={{
            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
            background: "var(--warning)", animation: "pulse 1.2s ease-in-out infinite",
          }} />
          <span style={{ fontWeight: 600 }}>
            模型调度异常，正在自动重连（{reconnectInfo.attempt}/{reconnectInfo.total}）…
          </span>
          <span style={{ color: "var(--text-muted)" }}>已保留对话上下文，重连成功即继续流式输出</span>
          <button
            onClick={async () => { stoppingRef.current = true; await stopGeneration(); }}
            title="放弃重连，停止本次请求"
            style={{
              marginLeft: "auto", background: "transparent", border: "none", cursor: "pointer",
              color: "var(--warning)", fontSize: 12, padding: "2px 6px", borderRadius: 4,
              display: "inline-flex", alignItems: "center", gap: 4,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--danger-soft)"; e.currentTarget.style.color = "#f87171"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--warning)"; }}>
            停止重连
          </button>
        </div>
      )}

      {/* 输入区：圆角容器 + 自动增高 + 联想 + 指令面板 + 加号栏 */}
      <SubAgentBar />
      <div style={{ padding: "10px 16px 12px", borderTop: "1px solid var(--border)", background: "var(--bg)", position: "relative", zIndex: 30 }}>
        {/* 输入联想（历史会话相似消息） */}
        {suggestions.length > 0 && !loading && (
          <div style={{
            position: "absolute", bottom: "100%", left: 16, right: 16, marginBottom: 4,
            background: "var(--bg-input)", border: "1px solid var(--border-hover)",
            borderRadius: 10, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            zIndex: 40,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", padding: "6px 12px 2px" }}>
              历史会话联想
            </div>
            {suggestions.map((s, i) => (
              <button key={i}
                onClick={() => { setInput(s.content); setSuggestions([]); inputRef.current?.focus(); }}
                style={{
                  display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                  padding: "6px 12px", border: "none", background: "transparent",
                  fontSize: 12.5, color: "var(--text)", lineHeight: 1.5,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <span style={{ color: "var(--accent-hover)", fontWeight: 600, marginRight: 6 }}>{s.agentName}</span>
                {s.content}
              </button>
            ))}
          </div>
        )}

        {/* A-951：@成员选择器（brainstorm 输入 @ 弹出团队成员候选） */}
        {atOpen && atList.length > 0 && (
          <div style={{
            position: "absolute", bottom: "100%", left: 16, right: 16, marginBottom: 4,
            background: "var(--bg-input)", border: "1px solid var(--border-hover)",
            borderRadius: 10, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            zIndex: 41, maxHeight: 260, overflowY: "auto",
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", padding: "6px 12px 2px" }}>
              团队成员（{atList.length}）— 点击或 ↑↓ + Enter 选择；@ 名字 后输入其他内容即发送
            </div>
            {atList.map((n, i) => (
              <button key={n}
                onClick={() => pickMember(n)}
                onMouseEnter={() => setAtSel(i)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  cursor: "pointer", padding: "6px 12px", border: "none",
                  background: i === atSel ? "var(--bg-hover)" : "transparent",
                  fontSize: 12.5, color: "var(--text)", lineHeight: 1.4, whiteSpace: "nowrap",
                }}>
                <span style={{
                  width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: "var(--accent-soft)", color: "var(--accent-hover)", fontSize: 10.5, fontWeight: 800,
                }}>{n.slice(0, 1)}</span>
                <span style={{ fontWeight: 700 }}>{n}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 11, fontWeight: 400 }}>@ 点名后仅该成员回复</span>
              </button>
            ))}
          </div>
        )}

        {/* 指令面板（"/" 开头） */}
        {cmdOpen && filteredCmd.length > 0 && (
          <div style={{
            position: "absolute", bottom: "100%", left: 16, right: 16, marginBottom: 4,
            background: "var(--bg-input)", border: "1px solid var(--border-hover)",
            borderRadius: 10, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            zIndex: 40, maxHeight: 300, overflowY: "auto",
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", padding: "6px 12px 2px" }}>
              指令（{filteredCmd.length}）— 输入 / 继续过滤，点击执行
            </div>
            {filteredCmd.map((c) => (
              <button key={c.cmd}
                onClick={() => runCommand(c)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  padding: "6px 12px", border: "none", background: "transparent", cursor: "pointer",
                  fontSize: 12.5, color: "var(--text)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <span style={{ color: "var(--accent-hover)", fontWeight: 700, minWidth: 62 }}>{c.cmd}</span>
                <span style={{ color: "var(--text-muted)", fontSize: 11, minWidth: 34 }}>{c.group}</span>
                <span style={{ flex: 1, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.desc}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ＋ 弹窗气泡：指向左侧 ＋ 按钮，选技能 / MCP / 导入文件 */}
        {plusOpen && (
          <div style={{
            position: "absolute", bottom: "100%", left: 14, marginBottom: 10, width: 312,
            background: "var(--bg-input)", border: "1px solid var(--border-hover)",
            borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,0.42)",
            zIndex: 50, overflow: "hidden",
          }}>
            {/* 指向 ＋ 的小三角 */}
            <div style={{
              position: "absolute", bottom: -6, left: 18, width: 12, height: 12,
              background: "var(--bg-input)",
              borderLeft: "1px solid var(--border-hover)", borderBottom: "1px solid var(--border-hover)",
              transform: "rotate(-45deg)",
            }} />
            <div style={{ display: "flex", alignItems: "center", padding: "8px 12px" }}>
              <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)" }}>
                添加内容
              </span>
              <button className="titlebar-btn" onClick={() => setPlusOpen(false)}><CloseIcon size={12} /></button>
            </div>
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                技能（{(extras?.skills ?? []).length}）
              </div>
              {(extras?.skills ?? []).length === 0 && (
                <div style={{ padding: "4px 12px 8px", fontSize: 12, color: "var(--text-dim)" }}>无已加载技能（设置 → 技能库可管理）</div>
              )}
              {(extras?.skills ?? []).map((s) => (
                <button key={s.name}
                  onClick={() => { setInput(`请使用技能「${s.name}」：`); setPlusOpen(false); inputRef.current?.focus(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    padding: "5px 12px", border: "none", background: "transparent", cursor: "pointer",
                    fontSize: 12.5, color: "var(--text)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                  <span style={{ color: "var(--success)", fontWeight: 700, minWidth: 62, overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                  <span style={{ flex: 1, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.description || "（无描述）"}</span>
                </button>
              ))}
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                MCP 工具（{(extras?.mcpTools ?? []).length}）
              </div>
              {(extras?.mcpTools ?? []).length === 0 && (
                <div style={{ padding: "4px 12px 8px", fontSize: 12, color: "var(--text-dim)" }}>无已连接 MCP 工具（设置 → MCP 接入可管理）</div>
              )}
              {(extras?.mcpTools ?? []).map((t) => (
                <button key={t.name}
                  onClick={() => { setInput(`请使用 MCP 工具「${t.name}」：`); setPlusOpen(false); inputRef.current?.focus(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    padding: "5px 12px", border: "none", background: "transparent", cursor: "pointer",
                    fontSize: 12.5, color: "var(--text)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                  <span style={{ color: "var(--warning)", fontWeight: 700, minWidth: 62, overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                  <span style={{ flex: 1, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.description || "（无描述）"}</span>
                </button>
              ))}
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                图片
              </div>
              <button onClick={() => void handlePickImages()}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  padding: "7px 12px", border: "none", background: "transparent", cursor: "pointer",
                  fontSize: 12.5, color: "var(--text)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <ImageIcon size={13} />
                <span style={{ flex: 1 }}>发送图片给模型识别</span>
                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>≤4 张 · 截图可 Ctrl+V / 拖拽</span>
              </button>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                文件
              </div>
              <button onClick={() => void handleImportFile()}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  padding: "7px 12px", border: "none", background: "transparent", cursor: "pointer",
                  fontSize: 12.5, color: "var(--text)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <PaperclipIcon size={13} />
                <span style={{ flex: 1 }}>导入图片 / 文档</span>
                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>本地文件</span>
              </button>
            </div>
          </div>
        )}

        <div className="glass-input" style={{
          borderRadius: 18, border: "1px solid var(--border-hover)",
          background: "var(--bg-input)", overflow: "hidden",
        }}
        onDragOver={(e) => { if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) { e.preventDefault(); } }}
        onDrop={handleDropImages}>
          {pendingAsk ? (
            /* ── ask_user 提问：方向分歧 / 关键决策 → 输入框位置选择题（含「其他」自填）── */
            <div style={{ padding: "14px 16px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "var(--accent-hover)" }}><BoltIcon size={13} /> Agent 提问</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--accent-hover)" }}>{pendingAsk.agentName || "slime 助手"}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                  需要你做出抉择{pendingAsk.header ? ` · ${pendingAsk.header}` : ""}
                </span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => void resolveAsk("", "（跳过）")}
                  disabled={askSubmitting}
                  title="跳过本次提问（让 Agent 自行判断）"
                  style={{
                    width: 26, height: 26, borderRadius: "50%", border: "1px solid var(--border)",
                    background: "transparent", color: "var(--text-muted)", fontSize: 13,
                    cursor: askSubmitting ? "not-allowed" : "pointer", lineHeight: 1,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "background 0.12s, color 0.12s, transform 0.08s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--danger)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
                  onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.9)"; }}
                  onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                  <CloseIcon size={12} />
                  </button>
              </div>
              {/* 问题正文 */}
              <div style={{
                fontSize: 12.5, color: "var(--text)", background: "var(--bg-hover)",
                borderRadius: 10, padding: "8px 12px", marginBottom: 10, whiteSpace: "pre-wrap",
              }}>
                {normalizeBrokenLines(pendingAsk.question)}
              </div>
              {/* 决策分叉选项：方向主体 + 后果注释 + 推荐标注（点击选择） */}
              {pendingAsk.options.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                  {pendingAsk.options.map((o, i) => (
                    <button
                      key={`${o}-${i}`}
                      onClick={() => setAskOption(o)}
                      disabled={askSubmitting}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2,
                        textAlign: "left", padding: "8px 12px", borderRadius: 10, width: "100%",
                        border: askOption === o ? "1px solid var(--accent)" : "1px solid var(--border)",
                        background: askOption === o ? "var(--bg-hover)" : "transparent",
                        cursor: askSubmitting ? "not-allowed" : "pointer",
                        transition: "border-color 0.12s, background 0.12s, transform 0.08s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = askOption === o ? "var(--bg-hover)" : "transparent"; }}
                      onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.99)"; }}
                      onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 12.5, color: "var(--text)" }}>
                        <span>{askOption === o ? "◉ " : "○ "}{o}</span>
                        {pendingAsk.recommendation === i && (
                          <span style={{
                            marginLeft: 2, fontSize: 10.5, lineHeight: 1, padding: "2px 6px", borderRadius: 8,
                            background: "rgba(245,158,11,0.18)", color: "var(--warning)", fontWeight: 700,
                          }}>⭐ 推荐</span>
                        )}
                      </span>
                      {(pendingAsk.consequences?.[i]) ? (
                        <span style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5 }}>
                          {pendingAsk.consequences[i]}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
              {/* 按推荐执行（AI 基于全局评估标注的最优方向） */}
              {pendingAsk.recommendation !== undefined
                && pendingAsk.options[pendingAsk.recommendation] ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <button
                    className="btn primary" style={{ fontSize: 12 }}
                    disabled={askSubmitting}
                    onClick={() => void resolveAsk(pendingAsk.options[pendingAsk.recommendation as number])}>
                    ⭐ 按推荐执行「{pendingAsk.options[pendingAsk.recommendation]}」
                  </button>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    Agent 基于全局评估给出的最优方向
                  </span>
                </div>
              ) : null}
              {/* 其他：自填需求 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button
                  onClick={() => setAskOption("__custom")}
                  disabled={askSubmitting}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 6,
                    textAlign: "left", padding: "8px 12px", borderRadius: 10, width: "100%",
                    border: askOption === "__custom" ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: askOption === "__custom" ? "var(--bg-hover)" : "transparent",
                    cursor: askSubmitting ? "not-allowed" : "pointer",
                    transition: "border-color 0.12s, background 0.12s, transform 0.08s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = askOption === "__custom" ? "var(--bg-hover)" : "transparent"; }}
                  onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.99)"; }}
                  onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--text)" }}>
                    {askOption === "__custom" ? "◉ " : "○ "}其他（自定义）
                  </span>
                </button>
                {askOption === "__custom" && (
                  <input
                    autoFocus
                    value={askCustom}
                    onChange={(e) => setAskCustom(e.target.value)}
                    placeholder="输入你的需求…"
                    onKeyDown={(e) => { if (e.key === "Enter") { void resolveAsk("__custom", askCustom); } }}
                    style={{
                      width: "100%", padding: "8px 12px", borderRadius: 10,
                      border: "1px solid var(--border)", background: "var(--bg-input)",
                      color: "var(--text)", fontSize: 12.5, outline: "none",
                    }}
                  />
                )}
              </div>
              {/* 底部：确认 + 说明 */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                <button
                  className="btn primary"
                  style={{ fontSize: 12.5 }}
                  disabled={!canSubmitAsk(askSubmitting, askOption, askCustom)}
                  onClick={() => void resolveAsk(askOption, askCustom)}>
                  {askSubmitting ? "提交中…" : "确认"}
                </button>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  Agent 提问期间暂停输入，回答后自动恢复输入框
                </span>
              </div>
            </div>
          ) : pendingPerm ? (
            /* ── 权限请求：输入框位置切换为选择题（参考 Claude Code/Cursor 授权交互）── */
            <div style={{ padding: "14px 16px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "var(--warning)" }}><BoltIcon size={13} /> 权限请求</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--accent-hover)" }}>{pendingPerm.agentName}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>请选择处理方式</span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => void resolvePerm("deny")}
                  disabled={permSubmitting}
                  title="拒绝本次权限请求"
                  style={{
                    width: 26, height: 26, borderRadius: "50%", border: "1px solid var(--border)",
                    background: "transparent", color: "var(--text-muted)", fontSize: 13,
                    cursor: permSubmitting ? "not-allowed" : "pointer", lineHeight: 1,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "background 0.12s, color 0.12s, transform 0.08s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--danger)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
                  onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.9)"; }}
                  onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                  <CloseIcon size={12} />
                  </button>
              </div>
              {/* 任务/风险说明 */}
              <div style={{
                fontSize: 12.5, color: "var(--text)", background: "var(--bg-hover)",
                borderRadius: 10, padding: "8px 12px", marginBottom: 10, whiteSpace: "pre-wrap",
              }}>
                {tightenCjkSpacing(normalizeBrokenLines(pendingPerm.taskDescription || "Agent 请求执行以下操作："))}
              </div>
              {/* 待授权动作列表 */}
              <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {pendingPerm.actions.map((a, i) => (
                  <div key={`${a.action}-${i}`} style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", gap: 6, alignItems: "baseline" }}>
                    <span style={{ color: "var(--text-muted)", minWidth: 22 }}>#{i + 1}</span>
                    <code style={{
                      background: "var(--bg-hover)", padding: "1px 6px", borderRadius: 6,
                      fontSize: 11.5, color: "var(--accent-hover)", fontFamily: "monospace",
                    }}>{a.action}</code>
                    <span style={{ color: "var(--text-muted)" }}>→</span>
                    <span style={{ wordBreak: "break-all" }}>{a.target || "—"}</span>
                  </div>
                ))}
              </div>
              {/* 四个简便选项：点击即生效（允许/本会话允许/拒绝即时提交；其他需求展开输入框） */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pendingPerm.options.map((o) => (
                  <button
                    key={o.id}
                    disabled={permSubmitting}
                    onClick={() => {
                      if (o.id === "custom") { setPermOption("custom"); return; }
                      void resolvePerm(o.id);
                    }}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                      textAlign: "left", padding: "8px 12px", borderRadius: 10, width: "100%",
                      border: permOption === o.id ? "1px solid var(--accent)" : "1px solid var(--border)",
                      background: permOption === o.id ? "var(--bg-hover)" : "transparent",
                      cursor: permSubmitting ? "not-allowed" : "pointer",
                      transition: "border-color 0.12s, background 0.12s, transform 0.08s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = permOption === o.id ? "var(--bg-hover)" : "transparent"; }}
                    onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.99)"; }}
                    onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--text)" }}>
                      {o.label}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5 }}>{o.hint}</span>
                  </button>
                ))}
              </div>
              {/* 其他需求：自填输入框（回车即提交） */}
              {permOption === "custom" && (
                <input
                  autoFocus
                  value={permCustom}
                  onChange={(e) => setPermCustom(e.target.value)}
                  placeholder={pendingPerm.options.find((o) => o.id === "custom")?.customPlaceholder ?? "输入你的指示…"}
                  onKeyDown={(e) => { if (e.key === "Enter") { void resolvePerm("custom", permCustom); } }}
                  style={{
                    width: "100%", marginTop: 8, padding: "8px 12px", borderRadius: 10,
                    border: "1px solid var(--border)", background: "var(--bg-input)",
                    color: "var(--text)", fontSize: 12.5, outline: "none",
                  }}
                />
              )}
              {/* 底部：仅其他需求态显示提交；其余点击即生效 */}
              {permOption === "custom" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                  <button
                    className="btn primary"
                    style={{ fontSize: 12.5 }}
                    disabled={permSubmitting || !permCustom.trim()}
                    onClick={() => void resolvePerm("custom", permCustom)}>
                    {permSubmitting ? "提交中…" : "提交指示"}
                  </button>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>回车提交 · Esc 后焦点自动回到输入框</span>
                </div>
              ) : null}
            </div>
          ) : (
          <>
          {/* ─ 流式实时监测栏：token 计数 / 耗时 / 吞吐速率 / 模型 ── */}
          {loading && (
            <div style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "6px 14px",
              borderTop: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            fontSize: 11, color: "var(--text-muted)",
            flexShrink: 0,
          }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: loading ? "var(--accent)" : "var(--success)", animation: loading ? "thinkGlow 1.4s ease-in-out infinite" : "none", flexShrink: 0 }} />
              <span className="thinking-hint-text" style={{ fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {loading ? (toolEvents.length > 0 ? "🔧 调用工具中…" : "💭 思考中…") : PLACEHOLDER_PHRASES[placeholderIndex]}
              </span>
            </span>
            {loading && (<>
              <span style={{ color: "var(--text-dim)" }}>|</span>
              <span>
                <span style={{ color: "var(--text)", fontWeight: 600 }}>{streamTokens.toLocaleString()}</span>
                <span style={{ color: "var(--text-dim)", marginLeft: 2 }}>tokens</span>
              </span>
              <span style={{ color: "var(--text-dim)" }}>|</span>
              <span>
                <span style={{ color: "var(--text)", fontWeight: 600 }}>{fmtMs(streamElapsed)}</span>
                <span style={{ color: "var(--text-dim)", marginLeft: 2 }}>耗时</span>
              </span>
              <span style={{ color: "var(--text-dim)" }}>|</span>
              <span>
                <span style={{ color: streamTokens > 0 && streamElapsed > 0 ? "var(--success)" : "var(--text-muted)", fontWeight: 600 }}>
                  {streamTokens > 0 && streamElapsed > 0 ? `${Math.round((streamTokens / streamElapsed) * 1000)}` : "—"}
                </span>
                <span style={{ color: "var(--text-dim)", marginLeft: 2 }}>tokens/s</span>
              </span>
              <span style={{ color: "var(--text-dim)" }}>|</span>
              <span title="当前会话完整上下文（历史消息 + 流式输出）实时估算" style={{ display: "inline-flex", alignItems: "baseline", gap: 4 }}>
                <span className="context-tokens-num" style={{ color: "var(--text)", fontWeight: 600, transition: "color 0.3s ease, transform 0.25s ease", display: "inline-block" }}>
                  {contextTokens < 1000 ? contextTokens : contextTokens < 10000 ? `${(contextTokens / 1000).toFixed(1)}K` : `${Math.round(contextTokens / 1000)}K`}
                </span>
                <span style={{ color: "var(--text-dim)" }}>context</span>
              </span>
              {streamModel && (
                <>
                  <span style={{ color: "var(--text-dim)" }}>|</span>
                  <span style={{ color: "var(--text-muted)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={streamModel}>
                    {streamModel}
                  </span>
                </>
              )}
            </>)}
          </div>
          )}
          {/* A-969：上下文自动压缩过渡动画（发送前触发；prep→summarize→done/trunc，完成后自动收起并继续发送） */}
          {compressUi && (
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 14px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg-secondary)",
              fontSize: 12, color: "var(--text-secondary)",
              flexShrink: 0,
              animation: "fadeIn 0.18s ease",
            }}>
              {compressUi.stage === "prep" && (
                <><LoadingCircleIcon size={13} className="icon-spin" /><span>正在整理会话上下文…</span></>
              )}
              {compressUi.stage === "summarize" && (
                <>
                  <LoadingCircleIcon size={13} className="icon-spin" />
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>上下文接近窗口上限，自动压缩中</span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>生成摘要（任务 / 成果 / 决策 / 下一步）</span>
                  <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--bg-hover)", overflow: "hidden", minWidth: 80 }}>
                    <div className="compress-bar" style={{ height: "100%", background: "var(--accent)", borderRadius: 2 }} />
                  </div>
                </>
              )}
              {compressUi.stage === "done" && (
                <>
                  <CheckIcon size={13} style={{ color: "var(--success)", flexShrink: 0 }} />
                  <span style={{ color: "var(--text)" }}>已压缩 {compressUi.dropped ?? 0} 轮对话，继续发送</span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }} title={compressUi.summary}>
                    摘要：{(compressUi.summary ?? "").slice(0, 60)}{(compressUi.summary ?? "").length > 60 ? "…" : ""}
                  </span>
                </>
              )}
              {compressUi.stage === "trunc" && (
                <>
                  <WarningIcon size={13} style={{ color: "var(--warning)", flexShrink: 0 }} />
                  <span style={{ color: "var(--text)" }}>摘要生成不可用，已保留最近 {compressUi.dropped ?? 0} 轮对话并继续发送</span>
                </>
              )}
            </div>
          )}
          {/* ── 识图：待发送图片附件行（缩略图 + 移除 + 数量提示）── */}
          {pendingImages.length > 0 && (
            <div style={{
              display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center",
              padding: "10px 12px 0",
            }}>
              {pendingImages.map((img) => (
                <div key={img.id} style={{ position: "relative", width: 56, height: 56 }}>
                  <img src={img.dataUrl} alt={img.name}
                    title={img.name}
                    style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 10, border: "1px solid var(--border-hover)" }} />
                  <button
                    onClick={() => handleRemoveImage(img.id)}
                    title="移除图片"
                    style={{
                      position: "absolute", top: -7, right: -7, width: 18, height: 18,
                      borderRadius: "50%", border: "none", cursor: "pointer",
                      background: "var(--danger)", color: "#fff", fontSize: 11, lineHeight: 1,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                    ×
                  </button>
                </div>
              ))}
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{pendingImages.length}/4 张 · 模型将识别图中内容</span>
            </div>
          )}
          <textarea ref={inputRef} value={input}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onPaste={handlePasteImages}
            onChange={(e) => {
              const next = e.target.value;
              setInput(next);
              autoResize();
              if (next.startsWith("/")) {
                setCmdOpen(true);
                setCmdFilter(next);
                setPlusOpen(false);
                setAtOpen(false);
                return;
              }
              setCmdOpen(false);
              setCmdFilter("");
              // A-951：@成员选择器——光标前最近的 "@" 到光标之间是一个成员名前缀时弹出候选
              if (sessionType === "brainstorm" && teamRoster.length > 0) {
                const pos = e.target.selectionStart ?? next.length;
                const tail = next.slice(0, pos);
                const lastAt = tail.lastIndexOf("@");
                if (lastAt >= 0 && !/[\s@（)]/.test(tail.slice(lastAt + 1))) {
                  const seg = tail.slice(lastAt + 1);
                  const hits = teamRoster.filter((n) => n.toLowerCase().includes(seg.toLowerCase()));
                  if (hits.length > 0) {
                    setAtOpen(true);
                    setAtFilter(seg);
                    setAtSel(0);
                    atRangeRef.current = { start: lastAt, end: pos };
                    setSuggestions([]);
                    return;
                  }
                }
                setAtOpen(false);
              }
            }}
            onKeyDown={(e) => {
              // A-951：@选择器键盘导航优先于发送/指令
              if (atOpen && atList.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setAtSel((s) => (s + 1) % atList.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setAtSel((s) => (s - 1 + atList.length) % atList.length); return; }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pickMember(atList[atSel] ?? atList[0]); return; }
                if (e.key === "Escape") { e.preventDefault(); setAtOpen(false); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (cmdOpen && filteredCmd.length === 1) {
                  runCommand(filteredCmd[0]);
                } else {
                  void send();
                }
              }
              if (e.key === "Escape") {
                setCmdOpen(false);
                setSuggestions([]);
                setPlusOpen(false);
                setAtOpen(false);
              }
            }}
            placeholder={sessionType === "brainstorm"
              ? "发消息即议题：@成员名 点名回复；@全体/不 @ 全员抢答（先想好先发言）；全程实时流式…"
              : "输入消息（Enter 发送，/ 展开指令，Shift+Enter 换行；可粘贴 / 拖拽图片识图）"}
            rows={1}
            // A-164：不再 disabled={loading} —— loading 时输入框必须可编辑，
            // 否则「停止后输入框出现已发信息且无法更改」（用户实测）；loading 时发送走插入
            // 中断（send() 分支），输入框始终可输入（对齐 Claude Code/Cursor 打断插入）。
            style={{
              display: "block", width: "100%", padding: "12px 14px 2px",
              border: "none", background: "transparent", color: "var(--text)",
              fontSize: 14, outline: "none", resize: "none",
              fontFamily: "inherit", lineHeight: 1.5, maxHeight: 120,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px 10px" }}>
            <button onClick={() => void openPlusPanel()}
              title="展开：指令 / 技能 / MCP 选择"
              style={{
                width: 30, height: 30, borderRadius: "50%",
                border: "1px solid var(--border)", background: "transparent",
                color: plusOpen ? "var(--accent-hover)" : "var(--text-muted)", fontSize: 16,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.12s, color 0.12s, transform 0.08s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.9)"; }}
              onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
              <PlusIcon size={16} />
            </button>
            {/* A-943：群聊头脑风暴 = 输入框退化为"普通聊天 APP 只发消息"；AI 配置（审批/模式/模型/推理/联网）全部收起 */}
            {sessionType === "brainstorm" ? null : (
            <>
            {/* 操作审批 */}
            <GhostSelect
              value={sessionConfig.approval}
              onChange={(v) => void setSessionConfigField({ approval: v as ApprovalMode })}
              title="Agent 操作审批模式（沙箱 L0-L5）"
              style={{ fontSize: 11.5, padding: "3px 6px" }}
              options={[
                { value: "manual", label: "手动", icon: <ManualIcon size={12} />, title: "一切访问/修改类操作均弹出确认，由你逐次审批" },
                { value: "auto", label: "自动", icon: <AutoModeIcon size={12} />, title: "智能体自行审批；仅系统级拒绝/权限不足时询问你" },
                { value: "none", label: "无需", icon: <WarningIcon size={12} />, title: "所有审批一律自动通过（不推荐）" },
                { value: "custom", label: "自定义", icon: <CustomIcon size={12} />, title: "预设目录/仓库命中免审批；其余按手动" },
              ]}
            />
            {/* 模式选择 */}
            <GhostSelect
              value={mode}
              onChange={(v) => onModeChange?.(v)}
              title="模式"
              style={{ fontSize: 11.5, padding: "3px 6px" }}
              options={[
                { value: "build", label: "build" },
                { value: "plan", label: "plan" },
                { value: "grow", label: "grow" },
              ]}
            />
            {/* 模型切换：列出所有已启用的模型（api:<key>:<model>）；供应商默认入口保留 api:<key>；按供应商分组
                 *  label 走 prettyModelLabel 美化：去掉 provider::/ 冗余前缀、去双拼、超长截断，
                 *  完整 ID 通过 tooltip(title) 暴露，避免显示层乱码/重叠
                 */}
            <GhostSelect
              value={modelChoice}
              onChange={(v) => onModelChange?.(v)}
              title={`切换 Provider/模型（当前：${modelChoice ?? "inherit"}）——供应商页可添加`}
              style={{ fontSize: 11.5, padding: "3px 6px", maxWidth: 150 }}
              maxWidth={420}
              options={[
                { value: "silam", label: "silam", group: "默认", title: "SILAM 双脑（情感脑+语言脑，grow 成长模式）" },
                ...(providerModels ?? []).flatMap((p) => {
                  const enabled = (p.models ?? []).filter((m) => m.selected !== false);
                  const disabled = (p.models ?? []).filter((m) => m.selected === false);
                  if (enabled.length === 0) {
                    return [{
                      value: `api:${p.key}`,
                      label: `${p.key} · 自动`,
                      group: p.key,
                      title: `${p.key} — 无已启用模型，仍可按默认配置调用`,
                    } as GhostSelectOption];
                  }
                  const first = prettyModelLabel(enabled[0].id, p.key) || enabled[0].id || "";
                  // A-968：保留 api:<key>「供应商自动/默认」入口——角色创建时只选了供应商（无具体模型）
                  // 也能在对话面板精确匹配显示，不再误落到「silam」，无需二次选择
                  return [
                    {
                      value: `api:${p.key}`,
                      label: `${p.key} · 自动（${first}）`,
                      group: p.key,
                      title: `${p.key} — 使用其默认模型「${first}」，点击可选择具体模型`,
                    },
                    ...enabled.map((m) => {
                      const label = prettyModelLabel(m.id, p.key);
                      return {
                        value: `api:${p.key}:${m.id}`,
                        label: label || m.id || "（未命名）",
                        group: p.key,
                        title: `${p.key} :: ${m.id}`,
                      };
                    }),
                    // A-918+：未启用模型灰显展示，提示去 Providers 面板开启，避免「探测到却用不了」误解
                    ...disabled.map((m) => {
                      const label = prettyModelLabel(m.id, p.key) || m.id || "（未命名）";
                      return {
                        value: `api:${p.key}:${m.id}`,
                        label: `${label} · 未启用`,
                        group: p.key,
                        title: `「${m.id}」未启用——请到 Providers 面板打开后再选择`,
                        disabled: true,
                      };
                    }),
                  ] as GhostSelectOption[];
                }),
                ...providerKeys
                  .filter((k) => !(providerModels ?? []).some((pm) => pm.key === k))
                  .map((k) => ({ value: `api:${k}`, label: `${k}（无可用模型）`, group: "供应商", title: `供应商（无已启用模型）：${k}` })),
                ...localModels.map((m) => ({
                  value: `local:${m.id}`,
                  label: prettyModelLabel(m.label || m.id),
                  group: "本地模型",
                  title: `本地模型：${m.label || m.id}`,
                })),
              ]}
            />
            {/* 推理等级：无框下拉，点击直接弹出可选等级（输入区在底部 → 默认向上展开）。
                等级集 = 当前模型上游实际返回的 effort 列表（如 Deepseek 返回 low/medium/high），
                不再硬编码"自动（上游默认）"固定选项——请求不传 reasoning_effort 时即隐式走上游默认。
                切模型后下拉自动刷新为新模型的可用等级。 */}
            <GhostSelect
              value={reasoningEffort}
              onChange={(v) => onReasoningChange?.(v)}
              displayLabel={reasoningEffort === "none" || !reasoningEffort ? "推理" : `推理: ${EFFORT_LABEL[reasoningEffort] ?? reasoningEffort}`}
              title={curSupportsEffortLevels
                ? `推理强度当前：${reasoningEffort === "none" || !reasoningEffort ? "以上游为准（不传 effort）" : (EFFORT_LABEL[reasoningEffort] ?? reasoningEffort)}；当前模型上游支持等级：${curEfforts.join(" / ")}；点击直接选择`
                : `推理强度当前：${reasoningEffort === "none" || !reasoningEffort ? "以上游为准（不传 effort）" : (EFFORT_LABEL[reasoningEffort] ?? reasoningEffort)}；等级集：${reasonPreset === "upstream" ? "以上游返回为准" : (presetLabelOf(reasonPreset) + "预设")}，平时默认采用上游返回的数据，异常场景可手动覆盖`}
              style={{
                padding: "3px 10px", borderRadius: 12, flexShrink: 0,
                border: `1px solid ${reasoningEffort && reasoningEffort !== "none" ? "var(--accent)" : "var(--border)"}`,
                background: reasoningEffort && reasoningEffort !== "none" ? "var(--accent-soft)" : "var(--bg-hover)",
                color: reasoningEffort && reasoningEffort !== "none" ? "var(--accent-hover)" : "var(--text-muted)",
                fontSize: 11.5, cursor: "pointer",
                maxWidth: 130,
              }}
              maxWidth={260}
              options={[
                // 仅显示上游实际返回的等级集（不再硬编码"自动"固定项）
                ...curEfforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e })),
                // 若上游未返回等级集但用户预设了预制模式，仍展示预制模式等级
                ...(curEfforts.length === 0 && presetEfforts ? presetEfforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e, group: presetLabelOf(reasonPreset) })) : []),
              ]}
            />
            {/* 联网搜索开关：灰色（关）→ 绿色（开），点击切换；关闭时 web_search/web_fetch 被静默拒绝 */}
            <button
              onClick={() => setNetworkEnabled((v) => !v)}
              title={networkEnabled ? "联网搜索：已启用" : "联网搜索：未启用（点击开启）"}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "3px 8px", borderRadius: 12,
                border: `1px solid ${networkEnabled ? "#22c55e" : "var(--border)"}`,
                background: networkEnabled ? "rgba(34,197,94,0.15)" : "var(--bg-hover)",
                color: networkEnabled ? "#22c55e" : "var(--text-dim)",
                fontSize: 11.5, cursor: "pointer",
                transition: "background 0.15s, border-color 0.15s, color 0.15s",
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                if (!networkEnabled) { e.currentTarget.style.background = "var(--bg)"; }
              }}
              onMouseLeave={(e) => {
                if (!networkEnabled) { e.currentTarget.style.background = "var(--bg-hover)"; }
              }}>
              <InternetIcon size={14} style={{ color: networkEnabled ? "#22c55e" : "var(--text-dim)" }} />
              联网搜索
            </button>
            </>
            )}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--text-dim)", marginRight: 8, display: loading ? "none" : "block" }}>
              {input ? `${input.length} 字` : ""}
            </span>
            {loading ? (
              <button onClick={() => void stopGeneration()}
                disabled={stopping}
                title="中断当前 Agent 输出（保留已生成内容）"
                style={{
                  width: 36, height: 36, borderRadius: "50%",
                  border: "none",
                  background: stopping ? "var(--bg-hover)" : "var(--danger)",
                  color: stopping ? "var(--text-dim)" : "#fff",
                  fontSize: 13, fontWeight: 700, cursor: stopping ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "background 0.12s, transform 0.08s",
                }}
                onMouseEnter={(e) => { if (!stopping) { e.currentTarget.style.background = "#f87171"; } }}
                onMouseLeave={(e) => { if (!stopping) { e.currentTarget.style.background = "var(--danger)"; } }}
                onMouseDown={(e) => { if (!stopping) { e.currentTarget.style.transform = "scale(0.9)"; } }}
                onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                {stopping ? "…" : "■"}
              </button>
            ) : (
              <button disabled={loading || !input.trim()}
                onClick={() => void send()}
                title="发送"
                style={{
                  width: 38, height: 38, borderRadius: "50%",
                  border: "none",
                  background: input.trim() ? "#fff" : "var(--bg-hover)",
                  color: input.trim() ? "#1e293b" : "var(--text-muted)",
                  cursor: input.trim() ? "pointer" : "not-allowed",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "background 0.12s, box-shadow 0.12s, transform 0.08s",
                  boxShadow: input.trim() ? "0 2px 10px rgba(140,246,251,0.35)" : "none",
                }}
                onMouseEnter={(e) => { if (input.trim()) { e.currentTarget.style.boxShadow = "0 4px 16px rgba(140,246,251,0.55)"; } }}
                onMouseLeave={(e) => { if (input.trim()) { e.currentTarget.style.boxShadow = "0 2px 10px rgba(140,246,251,0.35)"; } }}
                onMouseDown={(e) => { if (input.trim()) { e.currentTarget.style.transform = "scale(0.9)"; } }}
                onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                <SendIcon size={20} style={{ opacity: input.trim() ? 1 : 0.4 }} />
              </button>
            )}
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}