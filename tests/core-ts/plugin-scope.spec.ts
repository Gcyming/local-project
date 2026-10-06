import { describe, expect, it } from "vitest";
import { ContributionScope } from "../../core-ts/src/plugin/scope.js";

describe("ContributionScope：逆序撤销", () => {
  it("后注册的先撤销", async () => {
    const scope = new ContributionScope();
    const order: string[] = [];
    scope.track(() => { order.push("a"); });
    scope.track(() => { order.push("b"); });
    scope.track(() => { order.push("c"); });

    const report = await scope.disposeAll();

    expect(order).toEqual(["c", "b", "a"]);
    expect(report).toEqual({ ok: 3, failed: [] });
  });

  it("size 反映已登记的撤销函数数量", () => {
    const scope = new ContributionScope();
    expect(scope.size).toBe(0);
    scope.track(() => { });
    scope.track(() => { });
    expect(scope.size).toBe(2);
  });

  it("await 异步撤销函数后才计数完成", async () => {
    const scope = new ContributionScope();
    const seen: string[] = [];
    scope.track(async () => {
      await new Promise((r) => setTimeout(r, 20));
      seen.push("slow");
    });
    scope.track(() => { seen.push("fast"); });

    const report = await scope.disposeAll();

    expect(seen).toEqual(["fast", "slow"]);
    expect(report.ok).toBe(2);
  });
});

describe("ContributionScope：单个失败不阻断其余", () => {
  it("失败的 disposer 被记录，其余照常执行", async () => {
    const scope = new ContributionScope();
    const order: string[] = [];
    scope.track(() => { order.push("first"); });
    scope.track(() => {
      order.push("boom");
      throw new Error("撤销失败");
    });
    scope.track(() => { order.push("last"); });

    const report = await scope.disposeAll();

    expect(order).toEqual(["last", "boom", "first"]);
    expect(report.ok).toBe(2);
    expect(report.failed.length).toBe(1);
    expect(report.failed[0].index).toBe(1);
    expect((report.failed[0].error as Error).message).toBe("撤销失败");
  });

  it("多个失败全部记录，且按 index 升序", async () => {
    const scope = new ContributionScope();
    scope.track(() => { throw new Error("e0"); });
    scope.track(async () => { throw new Error("e1"); });
    scope.track(() => { throw new Error("e3"); });

    const report = await scope.disposeAll();

    expect(report.ok).toBe(0);
    expect(report.failed.map((f) => f.index)).toEqual([0, 1, 2]);
    expect(report.failed.map((f) => (f.error as Error).message)).toEqual(["e0", "e1", "e3"]);
  });

  it("异步拒绝（Promise reject）也算失败并被记录", async () => {
    const scope = new ContributionScope();
    scope.track(async () => { throw new Error("async boom"); });

    const report = await scope.disposeAll();

    expect(report.ok).toBe(0);
    expect(report.failed.length).toBe(1);
    expect((report.failed[0].error as Error).message).toBe("async boom");
  });
});

describe("ContributionScope：幂等", () => {
  it("二次 disposeAll 不再执行任何撤销函数", async () => {
    const scope = new ContributionScope();
    let count = 0;
    scope.track(() => { count++; });
    scope.track(() => { count++; });

    const first = await scope.disposeAll();
    const second = await scope.disposeAll();
    const third = await scope.disposeAll();

    expect(count).toBe(2);
    expect(first.ok).toBe(2);
    expect(second).toEqual({ ok: 0, failed: [] });
    expect(third).toEqual({ ok: 0, failed: [] });
  });

  it("disposed 在撤销后为 true", async () => {
    const scope = new ContributionScope();
    expect(scope.disposed).toBe(false);
    await scope.disposeAll();
    expect(scope.disposed).toBe(true);
  });

  it("已撤销的 scope 拒绝再 track（不静默丢弃）", async () => {
    const scope = new ContributionScope();
    await scope.disposeAll();

    expect(() => scope.track(() => { })).toThrow(/已撤销/);
  });

  it("空 scope 撤销返回 ok 0", async () => {
    const scope = new ContributionScope();
    expect(await scope.disposeAll()).toEqual({ ok: 0, failed: [] });
  });

  it("并发调用 disposeAll 只执行一次撤销", async () => {
    const scope = new ContributionScope();
    let count = 0;
    scope.track(async () => {
      await new Promise((r) => setTimeout(r, 10));
      count++;
    });

    const [a, b] = await Promise.all([scope.disposeAll(), scope.disposeAll()]);

    expect(count).toBe(1);
    expect(a.ok + b.ok).toBe(1);
  });
});