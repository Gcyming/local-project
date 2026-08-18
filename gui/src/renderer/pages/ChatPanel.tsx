/**
 * gui/src/renderer/pages/ChatPanel.tsx — 聊天面板（P0 补齐版）。
 * - 逐片渲染流式回复（按 seq 补漏）
 * - 输入框 → slime:chat:stream → 收 chunk/done/error 事件
 * - P0: 顶部工具栏（新对话/重试 + 模型/模式/推理下拉）
 * - P0: 接收 selectedAgentId prop，切换时自动 clear
 */
import React, { type JSX } from "react";
import type { StreamChunk } from "../../shared/ipc.js";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  agentId: string;
  agentName?: string;
  modelChoice?: string;
  mode?: string;
  reasoningEffort?: string;
  onModelChange?: (val: string) => void;
  onModeChange?: (val: string) => void;
  onReasoningChange?: (val: string) => void;
}

export default function ChatPanel({
  agentId,
  agentName = "Agent",
  modelChoice = "inherit",
  mode = "build",
  reasoningEffort = "none",
  onModelChange,
  onModeChange,
  onReasoningChange,
}: ChatPanelProps): JSX.Element {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [partial, setPartial] = React.useState("");
  const [lastTimings, setLastTimings] = React.useState<Record<string, number> | undefined>();
  const bottomRef = React.useRef<HTMLDivElement>(null);

  /** 每次 agentId 变更时清空本地消息 */
  React.useEffect(() => {
    setMessages([]);
    setPartial("");
    setLastTimings(undefined);
  }, [agentId]);

  /** P0: 随 agentId 重新订阅（切 Agent 时切换事件源） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const off1 = api.chat.onChunk((c: StreamChunk) => {
      setPartial((prev) => prev + (c.data.content ?? ""));
    });
    const off2 = api.chat.onDone((m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number> }) => {
      setMessages((prev) => [...prev, { role: "assistant", content: m.reply }]);
      setPartial("");
      setLoading(false);
      if (m.timings) setLastTimings(m.timings);
    });
    const off3 = api.chat.onError((e: { message: string }) => {
      console.error("[chat] error:", e.message);
      setLoading(false);
      setPartial("");
    });
    return () => { off1(); off2(); off3(); };
  }, [agentId]);

  React.useEffect(() => {
    bottomRef.current?.scrollTo({ top: 100000, behavior: "smooth" });
  }, [messages, partial]);

  async function send(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || !input.trim()) { return; }
    const text = input.trim();
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setPartial("");
    setLoading(true);
    void api.chat.stream({ agentId, message: text });
  }

  async function handleNewConversation(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    await api.chat.newConversation(agentId);
    setMessages([]);
    setPartial("");
    setLastTimings(undefined);
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
    setPartial("");
    setLoading(true);
    const result = await api.chat.retryLast(agentId);
    if (result.error) {
      console.error("[chat] retry failed:", result.error);
      setLoading(false);
    }
  }

  const canRetry = messages.length > 0 && !loading;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 顶部工具栏 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "8px 12px", background: "#1e293b",
        borderBottom: "1px solid #334155", flexWrap: "wrap",
      }}>
        <span style={{ color: "#94a388", fontSize: 13, fontWeight: 600, minWidth: 80 }}>
          {agentName}
        </span>
        <button onClick={handleNewConversation} disabled={loading}
          style={btnStyle("#64748a", loading)} title="新对话（清空本地显示）">
          新对话
        </button>
        <button onClick={handleRetry} disabled={!canRetry}
          style={btnStyle(canRetry ? "#3b82f6" : "#475569", !canRetry || loading)}
          title="重试上一条（重发最后一条用户消息）">
          重试
        </button>
        <span style={{ color: "#475569", margin: "0 4px" }}>|</span>
        <select value={modelChoice}
          onChange={(e) => onModelChange?.(e.target.value)}
          style={selectStyle()} title="切换 Provider/模型">
          <option value="inherit">inherit</option>
          <option value="api:agnes-main">api:agnes-main</option>
          <option value="local">local</option>
        </select>
        <select value={mode}
          onChange={(e) => onModeChange?.(e.target.value)}
          style={selectStyle()} title="build / plan 模式">
          <option value="build">build</option>
          <option value="plan">plan</option>
        </select>
        <select value={reasoningEffort}
          onChange={(e) => onReasoningChange?.(e.target.value)}
          style={selectStyle()} title="推理强度（none/low/medium/high）">
          <option value="none">推理: 关</option>
          <option value="low">推理: 低</option>
          <option value="medium">推理: 中</option>
          <option value="high">推理: 高</option>
        </select>
        {lastTimings && lastTimings.elapsedMs && (
          <span style={{ color: "#64748a", fontSize: 11, marginLeft: "auto" }}>
            {lastTimings.elapsedMs}ms
            {lastTimings.promptTokens && ` · ${lastTimings.promptTokens}+${lastTimings.completionTokens ?? 0}tok`}
          </span>
        )}
      </div>

      {/* 消息区域 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 0" }}>
        {messages.length === 0 && (
          <div style={{ color: "#475569", textAlign: "center", marginTop: 40, fontSize: 13 }}>
            与 {agentName} 开始对话
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 12, lineHeight: 1.5 }}>
            <strong style={{ color: m.role === "user" ? "#93c5fd" : "#34d399" }}>
              {m.role === "user" ? "你" : agentName}：
            </strong>
            <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span>
          </div>
        ))}
        {loading && (
          <div style={{ marginBottom: 12, lineHeight: 1.5, opacity: 0.8 }}>
            <strong style={{ color: "#34d399" }}>{agentName}：</strong>
            <span style={{ whiteSpace: "pre-wrap" }}>{partial || "⌛"}</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入框 */}
      <form onSubmit={(e) => { e.preventDefault(); void send(); }}
        style={{ display: "flex", gap: 8, padding: "10px 12px", borderTop: "1px solid #334155" }}>
        <input type="text" value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="输入消息（Enter 发送，Shift+Enter 换行）"
          style={{
            flex: 1, padding: 10, borderRadius: 6,
            border: "1px solid #475569", background: "#0f172a",
            color: "#e2e8f0", outline: "none",
          }}
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()}
          style={{
            padding: "10px 18px", borderRadius: 6, border: "none",
            background: loading ? "#64748a" : "#3b82f6",
            color: "#fff", cursor: loading ? "default" : "pointer",
          }}>
          发送
        </button>
      </form>
    </div>
  );
}

function btnStyle(bg: string, disabled: boolean): React.CSSProperties {
  return {
    padding: "4px 10px", borderRadius: 4, border: "none",
    background: disabled ? "#334155" : bg, color: "#e2e8f0",
    cursor: disabled ? "not-allowed" : "pointer", fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  };
}

function selectStyle(): React.CSSProperties {
  return {
    padding: "4px 8px", borderRadius: 4, border: "1px solid #475569",
    background: "#0f172a", color: "#e2e8f0", fontSize: 12, cursor: "pointer",
  };
}
