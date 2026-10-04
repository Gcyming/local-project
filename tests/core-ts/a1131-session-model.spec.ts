























import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { effectiveModelChoice } from "../../core-ts/src/services/sessions.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const SESSIONS_C = strip(read("core-ts/src/services/sessions.ts"));
const CHAT_C = strip(read("core-ts/src/services/chat.ts"));
const MAIN_C = strip(read("gui/src/main/index.ts"));
const APP_C = strip(read("gui/src/renderer/App.tsx"));
const PRELOAD_C = strip(read("gui/src/preload/index.ts"));

describe("A-1131-A 「取哪个模型」的唯一判据（纯函数）", () => {
  it("会话选过 → 用会话的（**覆盖 Agent 默认值**）", () => {
    expect(effectiveModelChoice("api:agnes:agnes-3.0-flash", "api:deepseek:deepseek-chat"))
      .toBe("api:agnes:agnes-3.0-flash");
  });

  it("会话没选过（undefined / 空串 / 全空白）→ 回落 Agent 默认值（老数据零行为变化）", () => {
    expect(effectiveModelChoice(undefined, "api:deepseek:deepseek-chat")).toBe("api:deepseek:deepseek-chat");
    expect(effectiveModelChoice("", "api:deepseek:deepseek-chat")).toBe("api:deepseek:deepseek-chat");
    expect(effectiveModelChoice("   ", "api:deepseek:deepseek-chat")).toBe("api:deepseek:deepseek-chat");
  });

  it("两边都没有 → 空串（不抛；由引擎按「未知的模型选择」如实报错）", () => {
    expect(effectiveModelChoice(undefined, undefined)).toBe("");
    expect(effectiveModelChoice("", "")).toBe("");
  });

  it("首尾空白被修掉（界面传入的值带空格不该导致路由失败）", () => {
    expect(effectiveModelChoice("  api:x:y  ", "z")).toBe("api:x:y");
    expect(effectiveModelChoice("", "  api:deepseek:ds  ")).toBe("api:deepseek:ds");
  });

  it("⚠️ 两个会话各自独立（这就是用户报的那件事）", () => {
    

    const agentDefault = "api:deepseek:deepseek-chat";
    const a = effectiveModelChoice("api:deepseek:deepseek-chat", agentDefault);
    const b = effectiveModelChoice("api:agnes:agnes-3.0-flash", agentDefault);
    expect(a, "会话 A 的模型被会话 B 带跑了").toBe(agentDefault);
    expect(b, "会话 B 的模型没生效").toBe("api:agnes:agnes-3.0-flash");
    expect(a === b, "两个会话解出了同一个模型 ⇒ 又是「同 Agent 共用」").toBe(false);
  });
});

describe("A-1131-B 引擎侧：只在**解析点**收口（runAgentFor）", () => {
  it("`ChatRequest` 带上会话级模型，且 `runAgentFor` 就是那个收口点", () => {
    expect(CHAT_C, "ChatRequest 没有 modelChoice ⇒ 主进程读出来的会话级模型没地方放")
      .toMatch(/modelChoice\?:\s*string/);
    expect(CHAT_C, "找不到 runAgentFor（收口点）").toContain("async runAgentFor(");
    expect(CHAT_C, "覆盖逻辑丢了（覆盖值非空时必须换成会话选的模型）")
      .toMatch(/return \{ \.\.\.agent, model_choice: override \};/);
  });

  it("两个入口（chat / stream）都走 runAgentFor；**且只在这里 findAgent**", () => {
    expect(CHAT_C, "chat() 没走收口点").toContain("this.runAgentFor(agentId, req.modelChoice)");
    const uses = CHAT_C.split("this.runAgentFor(agentId, req.modelChoice)").length - 1;
    expect(uses, `runAgentFor 被用了 ${uses} 处，应为 2（chat 与 stream 两条入口）`).toBe(2);
    

    const direct = CHAT_C.split("this.registry.findAgent(agentId)").length - 1;
    expect(direct, `直接 findAgent(agentId) 有 ${direct} 处，应为 2（runAgentFor 内部 1 处 + analyze 1 处）——` +
      " 多出来的那一处会绕过会话级模型覆盖").toBe(2);
  });

  it("`analyze`（swarm 分析）**不**吃会话覆盖（它没有会话语义，不该被改写）", () => {
    const at = CHAT_C.indexOf("async analyze(");
    expect(at).toBeGreaterThan(-1);
    const body = CHAT_C.slice(at, CHAT_C.indexOf("async chat(", at));
    expect(body, "analyze 被顺手接上了会话模型 —— 它只做调度分析，没有会话上下文")
      .not.toContain("runAgentFor");
  });
});

describe("A-1131-C 三条通路都带上会话级模型（漏一条 = 那条悄悄用回 Agent 默认值）", () => {
  it("正常发送：req 里透传 + 窗口上限用**同一个**值", () => {
    expect(MAIN_C, "req 没带会话级模型").toContain("modelChoice: brainMeta?.modelChoice");
    expect(MAIN_C, "窗口上限没按「本会话实际要用的模型」算（会贴着旧阈值照发）")
      .toContain("await resolveSessionWindowCap(agentId, runModelChoice)");
    expect(MAIN_C, "「取哪个模型」在这里又写了一遍（判据必须只有一处）")
      .toContain("const runModelChoice = effectiveModelChoice(brainMeta?.modelChoice, loadingAgent?.model_choice);");
  });

  it("重试通路：也带（否则重试会退回 Agent 默认模型）", () => {
    expect(MAIN_C, "重试没带会话级模型 ⇒ 用户在本会话选的模型在重试时被悄悄换掉")
      .toContain("modelChoice: retryMeta?.modelChoice");
    expect(MAIN_C, "重试的窗口上限没按会话模型算")
      .toContain("effectiveModelChoice(retryMeta?.modelChoice,");
  });

  it("压缩判定：也按会话模型算窗口", () => {
    expect(MAIN_C, "压缩 handler 仍按 Agent 默认模型判窗口 ⇒ 选了小窗口模型时会被上游拒")
      .toContain("effectiveModelChoice(meta.modelChoice, agent?.model_choice)");
  });

  it("会话列表/详情要**带出**这个字段（否则渲染层拿不到，显示回调 Agent 值）", () => {
    const n = MAIN_C.split("modelChoice: meta.modelChoice").length - 1;
    expect(n, `sessions 的 list/load 里带出 modelChoice 的有 ${n} 处，应为 2（列表 + 详情）`).toBe(2);
  });
});

describe("A-1131-D 渲染层与 IPC 接线（含反例：不许退回「只写 Agent」）", () => {
  it("渲染层显示：会话覆盖优先；写：同时写会话", () => {
    expect(APP_C, "currentModel 没看会话覆盖 ⇒ 切会话看到的还是同一个模型")
      .toContain("selectedSession?.modelChoice");
    expect(APP_C, "切模型没写会话（那就还是「同 Agent 全会话共用」= 原来的 bug）")
      .toContain("apiSetSessionModel(selectedSession.sessionId, v)");
    
    expect(APP_C, "切模型时没把 Agent 上的值更新为「最近选择」⇒ 新建会话会继承陈旧模型")
      .toContain("updateAgentConfig({ model_choice: v })");
  });

  it("会话级落盘走 `conversations.setModelChoice`（**不是** agents.update）", () => {
    expect(APP_C, "落盘没走会话级通路").toContain("api.conversations.setModelChoice(sessionId, modelChoice)");
    expect(APP_C, "落盘失败被静默吞了（连 console 都没有）").toContain('console.error("[slime] 会话模型落盘失败:"');
  });

  it("IPC 通道名两端一致（一边打错 = 静默失效，tsc 不报）", () => {
    for (const src of [MAIN_C, PRELOAD_C]) {
      expect(src, "缺通道 slime:sessions:setModelChoice").toContain("slime:sessions:setModelChoice");
    }
    expect(PRELOAD_C, "preload 没暴露 setModelChoice").toContain("setModelChoice:");
  });

  it("会话存储侧：写了就存、传空就**删掉**（清空覆盖 = 回到跟随 Agent）", () => {
    expect(SESSIONS_C, "SessionMeta 没有 modelChoice 字段").toContain("modelChoice?: string;");
    expect(SESSIONS_C, "找不到 setSessionModelChoice").toContain("export async function setSessionModelChoice(");
    expect(SESSIONS_C, "清空覆盖时没 delete（留下空串会变成「显式选了空模型」）")
      .toContain("delete meta.modelChoice;");
  });
});
