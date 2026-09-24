/**
 * A-1066 守卫：**本轮跑完 → 清空该会话待办**（用户明确要求）。
 *
 * 用户原话：「我很久之前都说过了吧，当会话结束，待办任务直接自动清除」；
 * 追问口径后选定 **「本轮跑完即清空」**（Agent 每次回复正常结束就清）。
 *
 * 为什么这是一条**容易做错**的需求（本 spec 的存在理由）：
 *   · 既有实现只做了「全部完成 → 自动清空」（A-980-R32）→ **没做完就被放弃**的清单永远留着，
 *     用户看到的就是"说了好几次还在"；
 *   · 而"顺手统一成三种结束都清"又是**错的**：出错时本项目会**自动续跑同一轮**
 *     （A-968/A-1051），且 `engine.ts` 每个工具轮都注入 `planReminderText(todos)` ——
 *     清了它，续跑的模型就"忘了自己要干什么"。用户主动中断同理（A-985 已定"降级不清"的口径）。
 *   ⇒ 所以判据必须**分原因**，且这条分家要有守护住，否则下次一定有人"统一"掉它。
 *
 * 另有一处真实竞态必须锁：旧流的 `finally` 可能晚于**新一轮**注册执行。
 *   那时盘上的清单属于新一轮，清掉 = "刚规划好，眨眼全没了"。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldClearTodosOnTurnEnd } from "../../core-ts/src/services/todoLifecycle.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const MAIN = read("gui/src/main/index.ts");

describe("A-1066-A 判据：只有「正常跑完」清；出错 / 中断 / 已被新一轮接管都不清", () => {
  it("🐛 正常跑完（done）→ 清空", () => {
    expect(shouldClearTodosOnTurnEnd({ reason: "done", stillActive: false })).toBe(true);
  });

  it("🐛 出错（error）→ **不清**（自动续跑会 resume 同一轮，清了模型就丢了计划提醒）", () => {
    expect(shouldClearTodosOnTurnEnd({ reason: "error", stillActive: false })).toBe(false);
  });

  it("🐛 用户中断（cancelled）→ **不清**（A-985 的既定口径是「降级为待办」，不是删掉）", () => {
    expect(shouldClearTodosOnTurnEnd({ reason: "cancelled", stillActive: false })).toBe(false);
  });

  it("🐛 已被新一轮接管 → 一律不清（**优先级最高**，连 done 也不例外）", () => {
    expect(shouldClearTodosOnTurnEnd({ reason: "done", stillActive: true })).toBe(false);
    expect(shouldClearTodosOnTurnEnd({ reason: "error", stillActive: true })).toBe(false);
    expect(shouldClearTodosOnTurnEnd({ reason: "cancelled", stillActive: true })).toBe(false);
  });

  it("[反例] 断言能抓住坏写法（守卫自检）", () => {
    // ① 退化成"三种结束都清" → error/cancelled 两条必须变红
    const clearAll = (): boolean => true;
    expect(clearAll()).toBe(true);
    expect(shouldClearTodosOnTurnEnd({ reason: "error", stillActive: false })).not.toBe(clearAll());
    // ② 退化成"不看 stillActive" → 上面第 4 条必须变红
    const ignoreActive = (r: "done" | "error" | "cancelled"): boolean => r === "done";
    expect(ignoreActive("done")).toBe(true);
    expect(shouldClearTodosOnTurnEnd({ reason: "done", stillActive: true })).not.toBe(ignoreActive("done"));
  });
});

describe("A-1066-B 接线：判据唯一出处，且竞态判定必须早于注销自己", () => {
  it("主进程 import 判据纯模块（不许在 finally 里另写一份 if）", () => {
    expect(MAIN).toContain('import { shouldClearTodosOnTurnEnd } from "../../../core-ts/src/services/todoLifecycle.js";');
    expect(MAIN).toContain("shouldClearTodosOnTurnEnd({");
  });

  it("🐛 `superseded` 必须在 `activeChats.delete(cancelKey)` **之前**求值", () => {
    const atSuper = MAIN.indexOf("const superseded = activeChats.get(cancelKey) !== controller;");
    const atDelete = MAIN.indexOf("activeChats.delete(cancelKey);");
    expect(atSuper, "找不到 superseded 判定").toBeGreaterThan(-1);
    expect(atDelete, "找不到 activeChats 注销").toBeGreaterThan(-1);
    expect(atSuper, "先注销再判定 → 新一轮的 controller 被自己删掉，竞态防护失效").toBeLessThan(atDelete);
  });

  it("三种结束原因如实上报（aborted → cancelled；hadError → error；否则 done）", () => {
    expect(MAIN).toMatch(/reason:\s*controller\.signal\.aborted\s*\?\s*"cancelled"\s*:\s*hadError\s*\?\s*"error"\s*:\s*"done"/);
    // hadError 必须在 catch 里被置真（否则出错永远被当成 done → 续跑丢计划）
    const atCatch = MAIN.indexOf("hadError = true;");
    expect(atCatch, "catch 里没有把 hadError 置真").toBeGreaterThan(-1);
  });

  it("🐛 清空用 `sessionId`（待办文件名按 sessionId 命名），不是 cancelKey", () => {
    expect(MAIN).toContain("clearTodosOnTurnEnd(input.sessionId);");
    expect(MAIN).not.toContain("clearTodosOnTurnEnd(cancelKey)");
    // 函数体内必须拿参数去 read/remove（而不是又去拼一个别的键）
    const at = MAIN.indexOf("function clearTodosOnTurnEnd(");
    expect(at).toBeGreaterThan(-1);
    const body = MAIN.slice(at, at + 900);
    expect(body).toContain("readTodos(sessionId)");
    expect(body).toContain("removeTodos(sessionId)");
    expect(body).toContain("broadcastTodos(sessionId)");
  });

  it("本来就没有待办 → 不广播空列表（否则每轮结束都白推一次、重置界面完成基线）", () => {
    const at = MAIN.indexOf("function clearTodosOnTurnEnd(");
    const body = MAIN.slice(at, at + 900);
    expect(body).toMatch(/if \(readTodos\(sessionId\)\.length === 0\) \{ return; \}/);
  });

  it("清空后必须广播空列表（否则界面仍留着旧项 = 用户看到的「没清掉」）", () => {
    const at = MAIN.indexOf("function clearTodosOnTurnEnd(");
    const body = MAIN.slice(at, at + 900);
    const atRemove = body.indexOf("removeTodos(sessionId);");
    const atBroadcast = body.indexOf("broadcastTodos(sessionId);");
    expect(atRemove).toBeGreaterThan(-1);
    expect(atBroadcast, "清盘后没有广播 → 界面与磁盘不一致").toBeGreaterThan(atRemove);
  });
});
