/**
 * ling-real-repro.spec.ts — 用真实上游抓包 `data/_ling_raw_sse.txt` 复现 ling-3.0-flash-fin-free
 * 的「回复正文为空」问题（history.jsonl: ai:"" success:true 2.2s）。
 *
 * 真实响应形态：绝大多数 chunk `delta.content=""`，思考/甚至最终回答都在 `delta.reasoning` 里；
 * content 可能只在流末尾吐出极少字符，也可能全程为空。
 * 断言链条：chatStream 必须至少信念诚实——不能静默返回空正文。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatClient } from "../../core-ts/src/llm/client.js";

const RAW_PATH = join(process.cwd(), "data", "_ling_raw_sse.txt");

/** 从抓包文件提取 SSE data: 行（跳过 : keep-alive 注释与噪音行） */
function sseLinesFromCapture(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      out.push(line);
    } else if (["[DONE]", "{", "["].some((k) => k && line.startsWith(k))) {
      // 抓包夹杂的裸 JSON（非流式兜底路径）——原样保留
    }
  }
  return out;
}

/** 构造 SSE Response（内容可选变换） */
function sseResponse(lines: string[], transform?: (j: Record<string, unknown>) => void): Response {
  const body = lines
    .map((l) => {
      const data = l.slice(5).trim();
      if (data === "[DONE]") return l;
      const j = JSON.parse(data) as Record<string, unknown>;
      transform?.(j);
      return `data: ${JSON.stringify(j)}`;
    })
    .join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("ling-3.0-flash-fin-free 真实抓包回归", () => {
  it("真实流：content 尾字存在 → chatStream 正文非空（剥离器不需要泼脏水）", async () => {
    const lines = sseLinesFromCapture(RAW_PATH);
    expect(lines.length).toBeGreaterThan(100);
    // 抓包确认 content 尾字存在（"你好"+"啊"）
    const hasRealContent = lines.some((l) => l.includes('"content":"你好"') || l.includes('"content":"啊"'));
    expect(hasRealContent).toBe(true);

    const client = new ChatClient({
      baseUrl: "http://127.0.0.1:19100",
      fetchImpl: (async () => sseResponse(lines)) as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    const reasons: string[] = [];
    const r = await client.chatStream(
      { messages: [{ role: "user", content: "只输出三个字" }] },
      (d) => deltas.push(d),
      undefined,
      (d) => reasons.push(d),
    );
    expect(r.text.trim()).not.toBe("");
    expect(r.text).toContain("你好");
    expect(reasons.join("").length).toBeGreaterThan(20);
  });

  it("content 全空的流（用户失败场景）：chatStream 不得静默返回空正文", async () => {
    const lines = sseLinesFromCapture(RAW_PATH);
    // 把所有 content 抹成 ""，仅保留 reasoning —— 复刻「很好」2.2s 空回复的真实上游行为
    const client = new ChatClient({
      baseUrl: "http://127.0.0.1:19100",
      fetchImpl: (async () =>
        sseResponse(lines, (j) => {
          const c = (j as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0];
          if (c?.delta) c.delta.content = "";
        })) as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    const reasons: string[] = [];
    const r = await client.chatStream(
      { messages: [{ role: "user", content: "很好" }] },
      (d) => deltas.push(d),
      undefined,
      (d) => reasons.push(d),
    );
    // 现实断言：正文可能为空（上游确实没给正文）——但必须从 reasoning 恢复出最终答案，
    // 不能让 GUI 得到空回复（history.jsonl 的 ai:"" 就是核心 bug）。
    expect(reasons.join("").length).toBeGreaterThan(20);
    // 上游把答案藏进 reasoning → 恢复正文非空
    const recovered = r.text.trim();
    expect(recovered).not.toBe("");
    expect(recovered).toContain("你好");
  });
});