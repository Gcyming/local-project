/**
 * tests/core-ts/a1132-final-body.spec.ts — 「收尾正文 = 收尾那一轮」的守卫（A-1132）。
 *
 * 用户实测（2026-09-27）：「正文里面似乎混杂了思考历程里面的内容，**正文非常长**，你看看
 * 是不是之前叫你做的最后拼接思考历程中的正文到正文输出这一个功能异常」。
 *
 * ## 实测数据（`config/history.jsonl`，一手，不是推断）
 * | 事实 | 数值 |
 * |---|---|
 * | `ai`（正文） | 4546 字 / 46 段 |
 * | 同一条的 `reasoning` | 273085 字 |
 * | `timeline` | 120 步：think 40 / tool 43 / **body 25** / plan 4 / todo 8 |
 * | 正文段落能在 **body** 步里找到 | **39/46** |
 * | 正文段落能在 **think** 步里找到 | **0/46**（归一化后仍 0） |
 * | body 步与 think 步的交集 | **0/25** |
 * | 该会话是否压缩过 | **没有**（meta 无 summaryCount / contextSummary） |
 *
 * ⇒ 结论：**不是"思考被抄进正文"**（与 think 零交集），**也不是那个「整理正文」功能把 think 混进来**
 *   （交集 0/25）。真正的缺陷是 **两条工具循环路径的收尾口径不一致**：
 *   `run()`（非流式）返回**收尾那一轮**的正文，而 `runStream()`（GUI 走的流式路径）返回
 *   **全过程叙述的累加**（`allText`）⇒ 正文变成 25 轮过程日志（4546 字），
 *   而收尾那一轮只有 1471 字的正式汇报。
 *
 * 这个文件锁：① 唯一判据 `pickFinalBody`；② 两条路径都用它（口径一致）；
 * ③ 中断 / 预算那两条"保留已产出"的路径**不许**被顺手改掉。
 *
 * 变异：`gui/scripts/mut-a1132-final-body.mjs`
 *
 * ⚠️ 中文串里嵌引用一律 `「」`（ASCII 双引号会当场截断 TS 字符串）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickFinalBody, ToolLoop } from "../../core-ts/src/tool_loop.js";
import { Tool, ToolRegistry } from "../../core-ts/src/tools/registry.js";
import { ChatClient } from "../../core-ts/src/llm/client.js";
import { ModelRouter } from "../../core-ts/src/router.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOOP = readFileSync(join(ROOT, "core-ts/src/tool_loop.ts"), "utf8");
/** 剥注释：注释里引用了"曾经是什么"（包括 `text: allText` 这种字样），不剥会把计数喂饱（§8-1）。 */
const LOOP_C = LOOP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("A-1132-A 唯一判据 pickFinalBody：以**收尾那一轮**为准", () => {
  it("收尾轮有正文 → 用它（**不是**全过程累加）", () => {
    // 实测形态：收尾那一轮 = 1471 字正式汇报；allText = 4546 字过程日志
    const last = "## 本轮已完成\n① 闪窗修复（已落地）";
    const all = "两个需求都收到：…先看代码定闪窗根因。\n\n找到闪窗根因了：…\n\n" + last;
    expect(pickFinalBody(last, all), "又交付了全过程日志（用户报的「正文非常长」）").toBe(last);
    expect(pickFinalBody(last, all)).not.toBe(all);
  });

  it("收尾轮为空 → 回退全过程累加（防空回复；这正是 allText 注释里写明的用途）", () => {
    expect(pickFinalBody("", "过程叙述…"), "收尾轮没正文时交付空串 ⇒ 用户看到空回复").toBe("过程叙述…");
    expect(pickFinalBody(undefined, "过程叙述…")).toBe("过程叙述…");
  });

  it("两边都空 → 空串（不抛）", () => {
    expect(pickFinalBody("", "")).toBe("");
    expect(pickFinalBody(undefined, undefined)).toBe("");
  });

  it("纯函数：不改入参", () => {
    const a = "最后一轮";
    const b = "全过程";
    expect(pickFinalBody(a, b)).toBe(a);
    expect(a).toBe("最后一轮");
    expect(b).toBe("全过程");
  });
});

describe("A-1132-B 接线：两条工具循环路径**共用**同一判据", () => {
  it("非流式 `run()` 的收尾也走判据（不再是裸 `raw`）", () => {
    expect(LOOP_C, "run() 的收尾没走唯一判据").toContain("text: pickFinalBody(tailText, allText),");
  });

  it("流式 `runStream()` 的正常收尾走判据（此前是裸 `allText` = 全过程日志）", () => {
    const uses = LOOP_C.split("text: pickFinalBody(tailText, allText),").length - 1;
    expect(uses, `收尾走判据的有 ${uses} 处，应为 2（run 与 runStream）—— 漏一条那条路径就还是旧口径`).toBe(2);
  });

  it("两条循环各自维护「收尾阶段」的累加（以工具调用为界）", () => {
    /* 判据（`pickFinalBody`）只是"交付哪一段"的收尾一步；真正决定"哪一段"的是
       两个循环里那两行：**以工具调用收尾 ⇒ 丢弃**（过程叙述）、否则并入。少一处就等于
       该路径没有"收尾阶段"的概念（又退回只看最后一轮）。 */
    const acc = LOOP_C.split("if (nextCalls.length > 0) { tailText = \"\"; }").length - 1;
    expect(acc, `「以工具调用为界重置收尾阶段」有 ${acc} 处，应为 2（run 与 runStream）`).toBe(2);
    const join = LOOP_C.split("tailText = tailText ? `${tailText}").length - 1;
    expect(join, `收尾阶段累加有 ${join} 处，应为 2`).toBe(2);
  });

  it("判据共用同一个实现（两处文本一致，不许各写一份等价表达式）", () => {
    const uses = LOOP_C.split("pickFinalBody(").length - 1;
    // 1 处函数定义 + 4 处调用（run 的 text/raw、runStream 的 text/raw）
    expect(uses, `pickFinalBody 出现 ${uses} 次，应为 5（定义 1 + run 2 + runStream 2）`).toBe(5);
  });

  it("⚠️ **中断 / 预算**两条路径仍用 `allText`（保留已产出、不丢弃 —— 与「交付哪一段」是两件事）", () => {
    const interrupt = LOOP_C.split("text: allText,").length - 1;
    expect(interrupt, `中断路径的 \`text: allText\` 有 ${interrupt} 处，应为 1 —— 被顺手改成 pickFinalBody 的话，` +
      "用户一按停止，已产出的正文就被截成「收尾那一轮」（可能只有半句）").toBe(1);
    const budget = LOOP_C.split("const text = allText ? allText + note").length - 1;
    expect(budget, `预算熔断路径有 ${budget} 处，应为 2（run 与 runStream 各一）—— 它们同样必须保留已产出`).toBe(2);
  });

  it("跨轮累加本身不能删（回退路径要有内容可退）", () => {
    expect(LOOP_C, "allText 的跨轮累加被删了 ⇒ 收尾轮为空时没有东西可回退").toContain("allText = allText ? `${allText}\\n\\n${roundText}` : roundText;");
  });
});

/* ════════════════════════════════════════════════════════════════════════
   C 节：**行为级**（不是搜源码）。
   为什么必须补这一节（本轮实测教训，铁律 3「锚对象错」的又一例）：
     B 节全是**源码文本**断言。变异 7 把 `if (roundText) { …累加… }` 改成 `if (false)` ——
     那一行文本**一字未动**，B 节的 `toContain` 照样绿，而 `allText` 从此永远为空
     （用户按停止 / 预算熔断 ⇒ 已产出正文全丢）。文本断言对"改条件"是**瞎的**。
   ⇒ 下面每条都**真跑一遍循环**，用返回值判。
   ════════════════════════════════════════════════════════════════════════ */

/** 流式假路由：按轮次吐 SSE（形态同 `tools.spec.ts`，只取本文件需要的字段）。 */
function mkStreamRouter(rounds: Array<{
  content?: string;
  toolDeltas?: Array<{ index: number; id: string; name: string; args: string }>;
}>) {
  let idx = 0;
  const sse = (delta: unknown) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta }] })}`;
  const fetchImpl = (async () => {
    const seq = rounds[Math.min(idx, rounds.length - 1)];
    idx += 1;
    const lines: string[] = [];
    if (seq.content) { lines.push(sse({ content: seq.content })); }
    for (const t of seq.toolDeltas ?? []) {
      lines.push(sse({ tool_calls: [{ index: t.index, id: t.id, type: "function", function: { name: t.name, arguments: t.args } }] }));
    }
    lines.push("data: [DONE]");
    return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return new ModelRouter(
    [{ name: "s", baseUrl: "http://x", kind: "local", priority: 1, roles: ["chat"] }],
    () => new ChatClient({ baseUrl: "http://x", fetchImpl }),
  );
}

/** 非流式假路由（走 `run()`）。 */
function mkRouter(sequence: Array<{ content?: string | null; toolCalls?: Array<{ id: string; name: string; arguments: string }> }>) {
  let idx = 0;
  const fetchImpl = (async () => {
    const seq = sequence[Math.min(idx, sequence.length - 1)];
    idx += 1;
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion", created: 1, model: "m",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: seq.content ?? null,
          tool_calls: seq.toolCalls
            ? seq.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
            : undefined,
        },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return new ModelRouter(
    [{ name: "s", baseUrl: "http://x", kind: "local", priority: 1, roles: ["chat"] }],
    () => new ChatClient({ baseUrl: "http://x", fetchImpl }),
  );
}

const echoRegistry = () => {
  const reg = new ToolRegistry();
  reg.register(new Tool({ name: "echo", description: "", parameters: {}, executeFn: async () => "E" }));
  return reg;
};

describe("A-1132-C 行为级：正文 = 收尾阶段，且保底路径不丢内容", () => {
  it("⚠️ **用户报的症状**：25 轮过程叙述不许堆进正文（正文只交付收尾阶段）", async () => {
    /* 这一条就是用户那张截图的最小复现：第 1 轮"说完就去做"（正文 + 工具调用），
       第 2 轮才是正式汇报。旧实现交付 `allText` ⇒ 两段一起进正文（读起来像过程日志）。 */
    const router = mkStreamRouter([
      { content: "过程叙述：先看一下代码定位根因", toolDeltas: [{ index: 0, id: "t1", name: "echo", args: "{}" }] },
      { content: "正式汇报：已修好，改动见上" },
    ]);
    const loop = new ToolLoop({ router, registry: echoRegistry() });
    const r = await loop.runStream({ agentId: "a1", messages: [], initialToolCalls: [], onEvent: () => {} });
    expect(r.text, "交付了全过程叙述（用户原话：正文非常长）").toBe("正式汇报：已修好，改动见上");
    expect(r.text).not.toContain("过程叙述");
  });

  it("⚠️ 中断时 `allText` 必须留住已产出正文（跨轮累加一删 ⇒ 用户按停止就什么都不剩）", async () => {
    const controller = new AbortController();
    const reg = new ToolRegistry();
    // 工具执行中用户点停止（＝ signal 在第 2 轮开始前变 aborted）
    reg.register(new Tool({ name: "echo", description: "", parameters: {}, executeFn: async () => { controller.abort(); return "E"; } }));
    const router = mkStreamRouter([
      { content: "第一轮说了这些", toolDeltas: [{ index: 0, id: "t1", name: "echo", args: "{}" }] },
      { content: "不会到达（已中止）" },
    ]);
    const loop = new ToolLoop({ router, registry: reg });
    const r = await loop.runStream({
      agentId: "a1", messages: [], initialToolCalls: [], signal: controller.signal, onEvent: () => {},
    });
    expect(r.interrupted, "工具执行中 abort ⇒ 下一轮开始前必须截止").toBe(true);
    expect(r.text, "中断路径用的是 `allText` —— 跨轮累加被删，用户按停止就丢光已产出正文").toContain("第一轮说了这些");
  });

  it("⚠️ 预算熔断（流式）同样留住已产出正文（同上，另一条保底路径）", async () => {
    const router = mkStreamRouter([
      { content: "已收集到的信息", toolDeltas: [{ index: 0, id: "t1", name: "echo", args: "{}" }] },
      { content: "不会到达（已熔断）" },
    ]);
    const loop = new ToolLoop({ router, registry: echoRegistry() });
    const r = await loop.runStream({ agentId: "a1", messages: [], initialToolCalls: [], maxToolCalls: 1, onEvent: () => {} });
    expect(r.budgetExhausted, "第 1 轮已用掉 1 次工具调用 ⇒ 第 2 轮开始前必须熔断").toBe(true);
    expect(r.text).toContain("已收集到的信息");
  });

  it("⚠️ 预算熔断（非流式 `run()`）同样留住已产出正文（两条循环的保底都得在）", async () => {
    const router = mkRouter([
      { content: "已收集到的信息", toolCalls: [{ id: "t1", name: "echo", arguments: "{}" }] },
      { content: "不会到达（已熔断）" },
    ]);
    const loop = new ToolLoop({ router, registry: echoRegistry() });
    const r = await loop.run({ agentId: "a1", messages: [], initialToolCalls: [], maxToolCalls: 1 });
    expect(r.budgetExhausted, "第 1 轮已用掉 1 次工具调用 ⇒ 第 2 轮开始前必须熔断").toBe(true);
    expect(r.text).toContain("已收集到的信息");
  });
});
