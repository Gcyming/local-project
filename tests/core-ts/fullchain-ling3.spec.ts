





import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatToolCallDelta } from "../../shared/gen/schemas.js";
import { ToolLoop, type ToolLoopEvent } from "../../core-ts/src/tool_loop.js";
import { createThinkingStripper } from "../../core-ts/src/services/chat.js";

const RAW_PATH = join(process.cwd(), "data", "_probe_ling_hao.txt");
const ANSWER = "谢谢！有什么问题随时问我 😊";


function sseLinesFromCapture(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  let done = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { done = true; continue; }
    if (done) continue; 
    out.push(line);
  }
  return out;
}


function stubRouter() {
  const lines = sseLinesFromCapture(RAW_PATH);
  return {
    chatStream: async (
      _payload: unknown,
      onDelta: (d: string) => void,
      _signal?: AbortSignal,
      onReasoning?: (r: string) => void,
      onToolDelta?: (c: ChatToolCallDelta[]) => void,
    ) => {
      let text = "";
      let chunks = 0;
      let sawTool = false;
      for (const l of lines) {
        const j = JSON.parse(l.slice(5).trim()) as {
          choices?: Array<{ delta?: { content?: string; reasoning?: string; tool_calls?: ChatToolCallDelta[] } }>;
        };
        const d = j.choices?.[0]?.delta;
        if (!d) continue;
        if (d.content) { chunks++; text += d.content; onDelta(d.content); }
        if (d.reasoning && onReasoning) onReasoning(d.reasoning);
        if (d.tool_calls && d.tool_calls.length > 0 && onToolDelta) { sawTool = true; onToolDelta(d.tool_calls); }
      }
      void sawTool;
      return { text, chunks, model: "ling-3.0-flash-fin-free" };
    },
  };
}


function consumeLikeChatService(events: ToolLoopEvent[]): { sr: string; out: string; reasoning: string } {
  let reasoningBuf = "";
  const stripper = createThinkingStripper(() => reasoningBuf);
  let out = "";
  for (const ev of events) {
    if (ev.type === "reasoning") {
      reasoningBuf += ev.content;
    } else if (ev.type === "chunk") {
      const clean = stripper.push(ev.content);
      out += clean;
    } else if (ev.type === "tool") {
      reasoningBuf = reasoningBuf ? `${reasoningBuf}\n\n[工具] ${ev.name}(${ev.args})` : `[工具] ${ev.name}(${ev.args})`;
    }
  }
  const tail = stripper.flush();
  out += tail;
  return { sr: stripper.reasoning.trim(), out, reasoning: reasoningBuf };
}

describe("ling-3.0-flash-fin-free 全链路回归（A-150）", () => {
  it("ToolLoop.runStream 层：正文穿过 StreamFilter 不丢", async () => {
    const loop = new ToolLoop({
      router: stubRouter() as never,
      registry: {} as never,
      workspace: "",
    });
    const events: ToolLoopEvent[] = [];
    const r = await loop.runStream({
      agentId: "test",
      messages: [{ role: "user", content: "很好" }],
      initialToolCalls: [],
      onEvent: (ev) => events.push(ev),
      tools: [] as never,
    });
    expect(r.text.trim()).toBe(ANSWER);
    expect(r.raw.trim()).toBe(ANSWER);
    const chunkText = events.filter((e) => e.type === "chunk").map((e) => e.content).join("");
    expect(chunkText.trim()).toBe(ANSWER);
  });

  it("stripper 层：正文不被思考剥离器吞掉（含延迟 release 路径）", () => {
    const events: ToolLoopEvent[] = [];
    const lines = sseLinesFromCapture(RAW_PATH);
    let text = "";
    let reasoningBuf = "";
    
    for (const l of lines) {
      const j = JSON.parse(l.slice(5).trim()) as {
        choices?: Array<{ delta?: { content?: string; reasoning?: string } }>;
      };
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning) {
        reasoningBuf += d.reasoning;
        events.push({ type: "reasoning" as const, content: d.reasoning });
      }
      if (d.content) {
        text += d.content;
        events.push({ type: "chunk" as const, content: d.content });
      }
    }
    const { out, reasoning } = consumeLikeChatService(events);
    expect(text.trim()).toBe(ANSWER);       
    expect(reasoning.length).toBeGreaterThan(20); 
    expect(out.trim()).toBe(ANSWER);        
  });
});