/**
 * scheduler.spec.ts — 后台常驻定时唤醒（SchedulerService）回归锚点。
 * 覆盖：cron 单字段解析 / 完整表达式 / 下次触发时刻 / 触发语义（防重入、到点即跑、非法 job 拒绝、无 handler 兜底）。
 */
import { describe, it, expect } from "vitest";
import { parseCron, parseCronPart, nextRunAfter, SchedulerService } from "../../core-ts/src/services/scheduler.js";

describe("parseCronPart（单字段解析）", () => {
  it("`*` → 全量区间", () => {
    expect(parseCronPart("*", 0, 59).size).toBe(60);
  });
  it("`*/15` → 步长取整", () => {
    expect([...parseCronPart("*/15", 0, 59)]).toEqual([0, 15, 30, 45]);
  });
  it("`1,15` → 列表", () => {
    expect([...parseCronPart("1,15", 0, 59)]).toEqual([1, 15]);
  });
  it("越界/非法 → 抛错（fail-closed）", () => {
    expect(() => parseCronPart("60", 0, 59)).toThrow();
    expect(() => parseCronPart("abc", 0, 59)).toThrow();
    expect(() => parseCronPart("*/0", 0, 59)).toThrow();
  });
});

describe("parseCron（5 字段表达式）", () => {
  it("合法表达式解析出 5 组", () => {
    const s = parseCron("0 9 * * *");
    expect(s.minute.has(0)).toBe(true);
    expect(s.hour.has(9)).toBe(true);
    expect(s.dom.size).toBe(31);
    expect(s.month.size).toBe(12);
    expect(s.dow.size).toBe(8);
  });
  it("字段数非 5 / 不支持的语法 → 抛错", () => {
    expect(() => parseCron("0 9 * *")).toThrow();
    expect(() => parseCron("0 9 * * ?")).toThrow();
  });
});

describe("nextRunAfter（下一次触发时刻）", () => {
  it("每分钟任务 → 下一分钟整（秒归零）", () => {
    const s = parseCron("* * * * *");
    const next = nextRunAfter(s, new Date(2026, 8, 5, 10, 30, 45))!;
    expect(next.getMinutes()).toBe(31);
    expect(next.getSeconds()).toBe(0);
  });
  it("每天 09:00 → 当日已过则次日 09:00", () => {
    const s = parseCron("0 9 * * *");
    const next = nextRunAfter(s, new Date(2026, 8, 5, 15, 0, 0))!;
    expect(next.getDate()).toBe(6);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });
  it("每 15 分钟 → 最近刻度", () => {
    const s = parseCron("*/15 * * * *");
    const next = nextRunAfter(s, new Date(2026, 8, 5, 10, 7, 0))!;
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(15);
  });
});

describe("SchedulerService（调度触发语义）", () => {
  it("到点触发 handler 一次，记录 lastRun/nextRun（推进到下一次）", async () => {
    const svc = new SchedulerService();
    const runs: string[] = [];
    svc.setHandler(async (job) => { runs.push(job.id); });
    svc.add({ id: "j1", name: "每分钟", cron: "* * * * *", prompt: "做简报" });
    const j = svc.get("j1")!;
    j.state.nextRun = Date.now() - 1000; // 已到点
    (svc as unknown as { tick(): void }).tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toEqual(["j1"]);
    expect(j.state.lastRun).toBeDefined();
    expect(j.state.lastResult).toBe("ok");
    // nextRun 推进到未来（下一分钟整）
    expect(j.state.nextRun!).toBeGreaterThan(Date.now());
  });

  it("running 中 → 该轮跳过，不重入", () => {
    const svc = new SchedulerService();
    let entered = 0;
    svc.setHandler(async () => { entered++; });
    svc.add({ id: "j1", name: "慢任务", cron: "* * * * *", prompt: "长跑" });
    const j = svc.get("j1")!;
    j.state.nextRun = Date.now() - 1;
    j.state.running = true; // 模拟上一轮未完成
    (svc as unknown as { tick(): void }).tick();
    expect(entered).toBe(0);
    expect(j.state.lastResult).toBeUndefined();
  });

  it("非法 cron 的 job 注册 → 抛错且不落表", () => {
    const svc = new SchedulerService();
    expect(() => svc.add({ name: "坏", cron: "0 9 * * ?", prompt: "x" })).toThrow();
    expect(svc.list().length).toBe(0);
  });

  it("未注册 handler → 记录 skipped 不抛，running 复位", async () => {
    const svc = new SchedulerService();
    svc.add({ id: "j2", name: "无handler", cron: "* * * * *", prompt: "x" });
    const j = svc.get("j2")!;
    j.state.nextRun = Date.now() - 1000;
    (svc as unknown as { tick(): void }).tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(j.state.lastResult).toBe("skipped（未注册 handler）");
    expect(j.state.running).toBe(false);
  });

  it("handler 抛错 → 记 fail 且不中断后续 job", async () => {
    const svc = new SchedulerService();
    svc.setHandler(async (job) => { throw new Error(`boom:${job.id}`); });
    svc.add({ id: "a", name: "甲", cron: "* * * * *", prompt: "x" });
    svc.add({ id: "b", name: "乙", cron: "* * * * *", prompt: "y" });
    const a = svc.get("a")!;
    const b = svc.get("b")!;
    a.state.nextRun = Date.now() - 1;
    b.state.nextRun = Date.now() - 1;
    (svc as unknown as { tick(): void }).tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(a.state.lastResult).toBe("fail: boom:a");
    expect(b.state.lastResult).toBe("fail: boom:b");
    expect(a.state.running).toBe(false);
  });

  it("pause 后不触发；resume 重算 nextRun", async () => {
    const svc = new SchedulerService();
    let entered = 0;
    svc.setHandler(async () => { entered++; });
    svc.add({ id: "p1", name: "可暂停", cron: "* * * * *", prompt: "x" });
    const j = svc.get("p1")!;
    j.state.nextRun = Date.now() - 1000;
    svc.pause("p1");
    expect(j.state.nextRun).toBeUndefined();
    (svc as unknown as { tick(): void }).tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(entered).toBe(0);
    // resume 后 nextRun 恢复为未来
    svc.resume("p1");
    expect(j.state.nextRun).toBeGreaterThan(Date.now());
    expect(j.state.paused).toBe(false);
  });

  it("trigger 立即执行一次且不推进 nextRun", async () => {
    const svc = new SchedulerService();
    const runs: string[] = [];
    svc.setHandler(async (job) => { runs.push(job.id); });
    svc.add({ id: "t1", name: "事件触发", cron: "0 0 1 1 *", prompt: "x" }); // 非常远期
    const j = svc.get("t1")!;
    const nextBefore = j.state.nextRun;
    expect(svc.trigger("t1")).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toEqual(["t1"]);
    expect(j.state.nextRun).toBe(nextBefore); // 不因手动触发重排
  });

  it("exportState/importState 往返：定义+lastResult/paused 保留，nextRun 重算", async () => {
    const svc = new SchedulerService();
    svc.add({ id: "e1", name: "持久", cron: "0 9 * * *", prompt: "报告" });
    const j = svc.get("e1")!;
    j.state.lastRun = 123;
    j.state.lastResult = "ok";
    svc.pause("e1");
    const json = svc.exportState();

    const svc2 = new SchedulerService();
    expect(svc2.importState(json)).toBe(1);
    const j2 = svc2.get("e1")!;
    expect(j2.state.lastResult).toBe("ok");
    expect(j2.state.lastRun).toBe(123);
    expect(j2.state.paused).toBe(true); // 暂停态保留
    expect(j2.state.nextRun).toBeUndefined();

    const svc3 = new SchedulerService();
    svc3.add({ id: "e2", name: "运行态", cron: "0 9 * * *", prompt: "报告" });
    svc3.get("e2")!.state.lastResult = "ok";
    const json2 = svc3.exportState();
    const svc4 = new SchedulerService();
    svc4.importState(json2);
    const e2 = svc4.get("e2")!;
    expect(e2.state.paused).toBeUndefined();
    expect(e2.state.nextRun).toBeGreaterThan(Date.now()); // 未暂停 → 重算未来时刻
  });
});