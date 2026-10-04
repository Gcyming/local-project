


















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";


function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const MAIN = codeOf("gui/src/main/index.ts");
const CHAT = codeOf("gui/src/renderer/pages/ChatPanel.tsx");
const SIDEBAR = codeOf("gui/src/renderer/pages/RightSidebar.tsx");

const SUBAGENT_SRC = codeOf("core-ts/src/services/subagent.ts");

describe("子代理装配层源码约定（A-980-R31 防回归）", () => {
  

  function subagentRunnerSlice(): string {
    const anchor = MAIN.indexOf("const subagentSessionId = ");
    expect(anchor).toBeGreaterThan(-1);
    return MAIN.slice(anchor, anchor + 2200);
  }

  it("子代理 runner 必须把 ctx.signal 透传给 engine.stream（否则超时 abort 永不生效）", () => {
    const slice = subagentRunnerSlice();
    expect(slice).toContain("for await (const ev of engine.stream({");
    expect(slice).toContain("signal: ctx?.signal");
  });

  it("中断判断必须在**消费事件之后**（否则 abort 后的部分正文被丢 → 0 字节产物）", () => {
    const slice = subagentRunnerSlice();
    const chunkIdx = slice.indexOf('ev.type === "chunk"');
    const abortIdx = slice.indexOf("if (ctx?.signal.aborted) { break; }");
    expect(chunkIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(-1);
    expect(chunkIdx).toBeLessThan(abortIdx); 
  });

  it("运行记录：终态同步落盘 + resident:state 合并历史（重启后不再空白）", () => {
    expect(MAIN).toContain("syncSubagentRuns(subagents.list())");
    expect(MAIN).toContain("subagents: mergedSubagentRuns(subagents.list())");
    expect(MAIN).toContain('ipcMain.handle("slime:resident:subagent:clear"');
    
    expect(MAIN).toContain("subagents.forgetTerminal()");
  });

  it("后台子代理的授权/提问请求在主进程即时处理（渲染层会话过滤必然静默丢弃）", () => {
    
    
    
    expect(MAIN).toContain('import { SUBAGENT_SESSION_PREFIX } from "../../../core-ts/src/services/subagent.js"');
    expect(MAIN).not.toContain('const SUBAGENT_SESSION_PREFIX = "__subagent__:"');
    
    expect(SUBAGENT_SRC).toContain('export const SUBAGENT_SESSION_PREFIX = "__subagent__:"');
    
    expect(MAIN).toContain("reqSid.startsWith(SUBAGENT_SESSION_PREFIX)");
    
    expect(MAIN).toContain("askSid.startsWith(SUBAGENT_SESSION_PREFIX)");
    
    expect(MAIN).toContain("`${SUBAGENT_SESSION_PREFIX}${def.id ?? def.name}`");
  });

  it("上下文广播是「前导+尾沿节流」，不是尾沿 debounce（debounce 会让右栏全程冻结）", () => {
    expect(CHAT).toContain("const CTX_DISPATCH_MS = 120");
    expect(CHAT).toContain("ctxDispatchTimerRef");
    
    expect(CHAT).not.toContain("return () => { window.clearTimeout(timer); };");
    expect(CHAT).not.toContain("}, 120);");
  });

  it("右栏落地节拍是事件驱动的自适应节拍（固定 10s 曾让整轮输出期间一动不动）", () => {
    expect(SIDEBAR).toContain("const LIVE_APPLY_MS = 1000");
    expect(SIDEBAR).toContain("scheduleApply");
    
    expect(SIDEBAR).toContain("if (!appliedCtxOnceRef.current) { applyPendingCtx(); } else { scheduleApply(); }");
    
    expect(SIDEBAR).toContain("window.setInterval(() => { applyPendingCtx(); }, 10_000)");
  });

  it("清空在途估算时连挂起值一起清（否则 done 后旧在途值被灌回来 → 重复计数）", () => {
    expect(SIDEBAR).toContain("pendingCtxRef.current.reply = 0");
    expect(SIDEBAR).toContain("pendingCtxRef.current.reason = 0");
  });
});

describe("A-1095③ 装配可见性（「派发还在不在循环里」必须可核对，不许只能靠观感猜）", () => {
  



  it("① 接线点必须真的被调用（工具注入 + 清单注入同一处）", () => {
    expect(MAIN).toContain("setSubagentManager(subagents);");
    expect(MAIN).toContain("subagentsRef = subagents;");
  });

  it("② 装配成功必须留一条可 grep 的日志，且点明接的是哪个工具", () => {
    expect(MAIN).toContain("[subagent] 装配完成");
    expect(MAIN).toContain("已接线 delegate_subagent");
    

    const wire = MAIN.indexOf("setSubagentManager(subagents);");
    const log = MAIN.indexOf("[subagent] 装配完成");
    expect(wire).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(wire);
    expect(log - wire).toBeLessThan(1500);
  });

  it("③ catch 归因必须写明后果（禁止「不影响主流程」这类假安慰）", () => {
    


    expect(MAIN).not.toContain("[scheduler] 启动失败（不影响主流程）");
    expect(MAIN).toContain("[scheduler] 定时唤醒装配失败");
    expect(MAIN).toContain("一并被跳过");
    expect(MAIN).toContain("delegate_subagent 将不可用");
  });

  it("④ 判假分支也必须出声（历史上是**完全静默**跳过，连 catch 都不进）", () => {
    


    expect(MAIN).toContain("不是数组且无运行态快照");
  });
});
