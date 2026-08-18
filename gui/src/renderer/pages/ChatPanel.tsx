/**
 * gui/src/renderer/pages/ChatPanel.tsx — 聊天面板骨架。
 * - 逐片渲染流式回复（按 seq 补漏）
 * - 输入框 → slime:chat:stream → 收 chunk/done/error 事件
 */
import React, { type JSX } from "react";
import type { StreamChunk } from "../../shared/ipc.js";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const DEFAULT_AGENT = "primary";

export default function ChatPanel(): JSX.Element {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [partial, setPartial] = React.useState("");
  const bottomRef = React.useRef<HTMLDivElement>(null);

  const onChunk = React.useRef<(cb: (c: StreamChunk) => void) => () => void>(
    () => () => () => undefined,
  ).current;
  const onDone = React.useRef<(cb: (m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number> }) => void) => () => void>(
    () => () => () => undefined,
  ).current;
  const onError = React.useRef<(cb: (e: { message: string }) => void) => () => void>(
    () => () => () => undefined,
  ).current;

  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: { chat: { onChunk: typeof onChunk; onDone: typeof onDone; onError: typeof onError } } }).slimeAPI;
    if (!api) {
      return;
    }
    const off1 = api.chat.onChunk((c) => {
      setPartial((prev) => prev + (c.data.content ?? ""));
    });
    const off2 = api.chat.onDone((m) => {
      setMessages((prev) => [...prev, { role: "assistant", content: m.reply }]);
      setPartial("");
      setLoading(false);
    });
    const off3 = api.chat.onError((e) => {
      console.error("[chat] error:", e.message);
      setLoading(false);
      setPartial("");
    });
    return () => {
      off1();
      off2();
      off3();
    };
  }, []);

  React.useEffect(() => {
    bottomRef.current?.scrollTo({ top: 100000, behavior: "smooth" });
  }, [messages, partial]);

  async function send(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: { chat: { stream: (i: unknown) => Promise<unknown> } } }).slimeAPI;
    if (!api || !input.trim()) {
      return;
    }
    const text = input.trim();
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setPartial("");
    setLoading(true);
    void api.chat.stream({ agentId: DEFAULT_AGENT, message: text });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12 }}>
      <div style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 12, lineHeight: 1.5 }}>
            <strong style={{ color: m.role === "user" ? "#93c5fd" : "#34d399" }}>{m.role === "user" ? "你" : "AI"}：</strong>
            <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span>
          </div>
        ))}
        {loading && (
          <div style={{ marginBottom: 12, lineHeight: 1.5, opacity: 0.8 }}>
            <strong style={{ color: "#34d399" }}>AI：</strong>
            <span style={{ whiteSpace: "pre-wrap" }}>{partial || " "}</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="输入消息（Enter 发送，Shift+Enter 换行）"
          style={{
            flex: 1,
            padding: 10,
            borderRadius: 6,
            border: "1px solid #475569",
            background: "#0f172a",
            color: "#e2e8f0",
            outline: "none",
          }}
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          style={{
            padding: "10px 18px",
            borderRadius: 6,
            border: "none",
            background: loading ? "#64748a" : "#3b82f6",
            color: "#fff",
            cursor: loading ? "default" : "pointer",
          }}
        >
          发送
        </button>
      </form>
    </div>
  );
}
