/**
 * tests/core-ts/subagent-wiring.spec.ts — 子代理链路的**装配层源码约定守卫**（A-980-R31）。
 *
 * 为什么需要"读源码断言"：本轮修的三类缺陷全部位于**只能靠肉眼发现的接线处**，tsc 与
 * 行为测试都抓不住——它们编译通过、单测全绿，但功能在真实运行里是坏的：
 *
 *   ① 装配层调用 `engine.stream({...})` 时漏传 `signal` → SubAgentManager 的超时 abort
 *      变成"喊了没人听"，任务跑到自然结束才被**归因**为超时（实测 120s 预算跑了 332.3s）；
 *   ② 中断判断写在**消费事件之前** → 引擎在 abort 后 yield 的那条"携带部分正文的 done"被丢弃
 *      → run.result 恒空、落盘 0 字节、主 Agent 只拿到一句"超时中断"；
 *   ③ 渲染层对 `ctxUsed` 的变化用**尾沿 debounce** → 流式期间每帧重建定时器，它在整轮输出里
 *      永远不会触发，右栏实时监测全程冻结（用户："只有结束了才会更新"）。
 *
 * 这些都是"写反了不报错"的约定，所以锁在源码文本上（去掉注释后断言，避免被修复说明的
 * 对照引用误伤）。
 *
 * 另有两条与"记录消失"相关的接线：运行记录必须落盘并在 `resident:state` 合并，以及
 * 后台子代理的授权/提问请求必须在**主进程**就按"无人可交互"处理（渲染层会话过滤必然丢弃）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

/** 去掉注释行后的可执行源码（修复说明的注释里会引用旧写法做对照，全文断言会被自己误伤） */
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
/** A-1122：子代理会话前缀的**唯一产地**（main 从这里 import） */
const SUBAGENT_SRC = codeOf("core-ts/src/services/subagent.ts");

describe("子代理装配层源码约定（A-980-R31 防回归）", () => {
  /** 子代理 runner 的源码片段：从"子代理专属会话 id"起切一段。
   *  必要性：同文件里 `engine.stream(` 不止一处（定时任务也用），全文 indexOf 会命中**定时任务**那条。 */
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
    expect(chunkIdx).toBeLessThan(abortIdx); // 先消费、后中断
  });

  it("运行记录：终态同步落盘 + resident:state 合并历史（重启后不再空白）", () => {
    expect(MAIN).toContain("syncSubagentRuns(subagents.list())");
    expect(MAIN).toContain("subagents: mergedSubagentRuns(subagents.list())");
    expect(MAIN).toContain('ipcMain.handle("slime:resident:subagent:clear"');
    // 清空必须同时丢内存终态记录，否则下一次 sync 会把它写回来（清不掉）
    expect(MAIN).toContain("subagents.forgetTerminal()");
  });

  it("后台子代理的授权/提问请求在主进程即时处理（渲染层会话过滤必然静默丢弃）", () => {
    // A-1122：前缀字面量已**收归 core-ts 单一出处**（文件回滚要按它把子代理改动算到当时那一轮头上）。
    // ⇒ 这里断言的是「main 从 core-ts 引入」，而不是「main 里有一份自己的字面量」。
    //   ⚠️ 若哪天又出现本地定义，两份会各自漂移，症状是静默的（子代理改过的文件再也回滚不了）。
    expect(MAIN).toContain('import { SUBAGENT_SESSION_PREFIX } from "../../../core-ts/src/services/subagent.js"');
    expect(MAIN).not.toContain('const SUBAGENT_SESSION_PREFIX = "__subagent__:"');
    // 而那份字面量必须**仍在** core-ts（迁走了却没落地 = 全是空引用，tsc 之外还得有人看着）
    expect(SUBAGENT_SRC).toContain('export const SUBAGENT_SESSION_PREFIX = "__subagent__:"');
    // 权限：立即拒绝并给出可操作原因
    expect(MAIN).toContain("reqSid.startsWith(SUBAGENT_SESSION_PREFIX)");
    // 提问：按跳过返回
    expect(MAIN).toContain("askSid.startsWith(SUBAGENT_SESSION_PREFIX)");
    // 子代理会话 ID 必须用同一常量拼接（防两处前缀写歪导致守卫失效）
    expect(MAIN).toContain("`${SUBAGENT_SESSION_PREFIX}${def.id ?? def.name}`");
  });

  it("上下文广播是「前导+尾沿节流」，不是尾沿 debounce（debounce 会让右栏全程冻结）", () => {
    expect(CHAT).toContain("const CTX_DISPATCH_MS = 120");
    expect(CHAT).toContain("ctxDispatchTimerRef");
    // 挂起的定时器只能由"卸载清理"的 effect 清掉；出现在广播 effect 的 cleanup 里就是 debounce 回归
    expect(CHAT).not.toContain("return () => { window.clearTimeout(timer); };");
    expect(CHAT).not.toContain("}, 120);");
  });

  it("右栏落地节拍是事件驱动的自适应节拍（固定 10s 曾让整轮输出期间一动不动）", () => {
    expect(SIDEBAR).toContain("const LIVE_APPLY_MS = 1000");
    expect(SIDEBAR).toContain("scheduleApply");
    // onCtxUpdate 里必须排快速落地（首次立即，其余走节拍）
    expect(SIDEBAR).toContain("if (!appliedCtxOnceRef.current) { applyPendingCtx(); } else { scheduleApply(); }");
    // 10s 只作为空闲兜底保留，不再承担流式刷新
    expect(SIDEBAR).toContain("window.setInterval(() => { applyPendingCtx(); }, 10_000)");
  });

  it("清空在途估算时连挂起值一起清（否则 done 后旧在途值被灌回来 → 重复计数）", () => {
    expect(SIDEBAR).toContain("pendingCtxRef.current.reply = 0");
    expect(SIDEBAR).toContain("pendingCtxRef.current.reason = 0");
  });
});

describe("A-1095③ 装配可见性（「派发还在不在循环里」必须可核对，不许只能靠观感猜）", () => {
  /* 用户原话：「顺手看一下子代理派发还在不在 Agent-Loop 循环，好久没看见了」。
   * 这句话本身能问得出来，就说明装配层缺的是**可核对性**：成功时一声不响，日志里也没有线索。
   * 本组锁的正是"能不能核对"，全部属静默失效家族（过 tsc / 过构建 / 过逻辑测试）。 */

  it("① 接线点必须真的被调用（工具注入 + 清单注入同一处）", () => {
    expect(MAIN).toContain("setSubagentManager(subagents);");
    expect(MAIN).toContain("subagentsRef = subagents;");
  });

  it("② 装配成功必须留一条可 grep 的日志，且点明接的是哪个工具", () => {
    expect(MAIN).toContain("[subagent] 装配完成");
    expect(MAIN).toContain("已接线 delegate_subagent");
    /* 日志必须紧跟在接线点之后：挪到别处（或复制到别的分支）就等于"装配完成"与接线脱钩，
       下次再有人问"派发还在不在"，这条日志会给出**错误的安全感**。 */
    const wire = MAIN.indexOf("setSubagentManager(subagents);");
    const log = MAIN.indexOf("[subagent] 装配完成");
    expect(wire).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(wire);
    expect(log - wire).toBeLessThan(1500);
  });

  it("③ catch 归因必须写明后果（禁止「不影响主流程」这类假安慰）", () => {
    /* 历史文案是 `[scheduler] 启动失败（不影响主流程）`，而它兜住的其实是**整个后半段**
       （含子代理装配 / 事件端点 / 后台任务 IPC）—— 把"Agent-Loop 少一条腿"报成
       "定时任务没起来"，于是用户只看到"派发不见了"，日志里没有任何线索。 */
    expect(MAIN).not.toContain("[scheduler] 启动失败（不影响主流程）");
    expect(MAIN).toContain("[scheduler] 定时唤醒装配失败");
    expect(MAIN).toContain("一并被跳过");
    expect(MAIN).toContain("delegate_subagent 将不可用");
  });

  it("④ 判假分支也必须出声（历史上是**完全静默**跳过，连 catch 都不进）", () => {
    /* 可达路径：data/schedules.json 存在、能解析，但不是数组（如被手改成 `{}`）且无运行态快照。
       判据是 `Array.isArray(schedDefs) || existsSync(statePath)`（⚠️ 文件不存在时 schedDefs 是
       `[]`，`Array.isArray([]) === true` ⇒ 正常情况走的是真分支，**不是**恒假）。 */
    expect(MAIN).toContain("不是数组且无运行态快照");
  });
});
