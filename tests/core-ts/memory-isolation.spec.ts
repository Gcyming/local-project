import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStore, getGlobalIndex, type GlobalMemoryIndex,
} from "../../core-ts/src/memory/store.js";
import { resetGlobalIndex, setIsolation, resetIsolation } from "../../core-ts/src/memory/global.js";

const ISOLATION_MARKER = ".memory-isolated";
const TOML = "[memory]\ncross_agent_dedup = true\nmax_entries = 50\n";
const tmpDirs: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memiso-"));
  tmpDirs.push(root);
  writeFileSync(join(root, "slime.toml"), TOML, "utf8");
  return root;
}

function markIsolated(root: string): void {
  writeFileSync(join(root, ISOLATION_MARKER), "", "utf8");
}

function spyOnCheck(idx: GlobalMemoryIndex): { calls: number } {
  const proto = Object.getPrototypeOf(idx) as GlobalMemoryIndex;
  const spy = { calls: 0 };
  (idx as unknown as { check: unknown }).check = function patched(
    this: GlobalMemoryIndex,
    content: string,
    opts?: { excludeAgent?: string; threshold?: number },
  ) {
    spy.calls += 1;
    return proto.check.call(this, content, opts);
  };
  return spy;
}

beforeEach(() => resetGlobalIndex());

afterEach(() => resetIsolation());

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("跨 agent 全局索引的隔离护栏", () => {
  it("隔离场景下写入不被本机全局索引去重掉，且索引一次都不被问", () => {
    const root = makeRoot();
    markIsolated(root);
    const idx = getGlobalIndex(root);
    expect(idx.isolated, "标记文件必须被隔离判定认出来").toBe(true);
    const spy = spyOnCheck(idx);

    const a = new MemoryStore("iso_ts_a", { dataDir: root });
    a.addFact("隔离记忆根里的同一条内容不应被本机共享索引去重");
    const b = new MemoryStore("iso_ts_b", { dataDir: root });
    b.addFact("隔离记忆根里的同一条内容不应被本机共享索引去重");

    expect(a.getFacts().length).toBe(1);
    expect(b.getFacts().length, "隔离场景下第二个 agent 的写入被本机索引去重掉了").toBe(1);
    expect(b.getFacts()[0].content).toBe("隔离记忆根里的同一条内容不应被本机共享索引去重");
    expect(b.getSharedRefs().length, "隔离场景下不该留下跨 agent 共享指针").toBe(0);
    expect(spy.calls, "隔离场景下仍然去问了本机全局索引（守卫失效）").toBe(0);
  });

  it("非隔离场景下去重仍生效（不能一刀切关掉跨 agent 去重）", () => {
    const root = makeRoot();
    const idx = getGlobalIndex(root);
    expect(idx.isolated, "没有闩锁/环境变量/标记文件时必须是生产默认的不隔离").toBe(false);
    const spy = spyOnCheck(idx);

    const a = new MemoryStore("live_ts_a", { dataDir: root });
    a.addFact("非隔离记忆根里同一条内容应当被跨 agent 去重");
    const b = new MemoryStore("live_ts_b", { dataDir: root });
    b.addFact("非隔离记忆根里同一条内容应当被跨 agent 去重");

    expect(a.getFacts().length).toBe(1);
    expect(b.getFacts().length, "非隔离场景下去重没生效").toBe(0);
    expect(b.getSharedRefs().length).toBe(1);
    expect(b.getSharedRefs()[0].from_agent).toBe("live_ts_a");
    expect(Number(b.getSharedRefs()[0].score)).toBeGreaterThan(0.75);
    expect(spy.calls, "非隔离场景下本机全局索引一次都没被问（去重路径被误伤）").toBeGreaterThan(0);
  });

  it("关闭全局索引功能开关时，隔离根目录也不走逐目录回退扫描", () => {
    const root = makeRoot();
    markIsolated(root);
    const a = new MemoryStore("offiso_ts_a", { dataDir: root });
    a.addFact("功能开关关掉时隔离根目录也不该跨 agent 去重");
    const b = new MemoryStore("offiso_ts_b", { dataDir: root, globalIndex: false });
    b.addFact("功能开关关掉时隔离根目录也不该跨 agent 去重");
    expect(b.getFacts().length, "隔离态仍顺着回退路径做了跨 agent 去重").toBe(1);
    expect(b.getSharedRefs().length).toBe(0);
  });

  it("功能开关关掉时**非隔离**根目录也不跨 agent 去重（开关由自己关，不靠隔离兜底）", () => {
    const root = makeRoot();
    const a = new MemoryStore("offlive_ts_a", { dataDir: root });
    a.addFact("功能开关关掉时非隔离根目录也不该跨 agent 去重");
    const b = new MemoryStore("offlive_ts_b", { dataDir: root, globalIndex: false });
    b.addFact("功能开关关掉时非隔离根目录也不该跨 agent 去重");
    expect(b.getFacts().length, "索引缺席不等于功能开启：回退路径把关掉的跨 agent 去重放行了").toBe(1);
    expect(b.getSharedRefs().length, "功能开关关掉却留下了跨 agent 共享指针").toBe(0);
  });

  it("进程级隔离开闩合上时，隔离根目录写入同样不走本机全局索引", () => {
    const root = makeRoot();
    setIsolation(true, "latch-test");
    const idx = getGlobalIndex(root);
    const spy = spyOnCheck(idx);

    const a = new MemoryStore("latch_ts_a", { dataDir: root });
    a.addFact("闩锁合上时同一条内容不应被本机共享索引去重");
    const b = new MemoryStore("latch_ts_b", { dataDir: root });
    b.addFact("闩锁合上时同一条内容不应被本机共享索引去重");

    expect(b.getFacts().length, "闩锁隔离场景下第二个 agent 的写入被本机索引去重掉了").toBe(1);
    expect(b.getSharedRefs().length).toBe(0);
    expect(spy.calls, "闩锁隔离场景下仍然去问了本机全局索引（入口守卫失效）").toBe(0);
  });

  it("环境变量 SLIME_MEMORY_ISOLATED 也认（隔离判据的唯一产地不被绕过）", () => {
    const root = makeRoot();
    const prev = process.env.SLIME_MEMORY_ISOLATED;
    process.env.SLIME_MEMORY_ISOLATED = "1";
    try {
      const a = new MemoryStore("env_ts_a", { dataDir: root });
      a.addFact("环境变量隔离时同一条内容不应被本机共享索引去重");
      const b = new MemoryStore("env_ts_b", { dataDir: root });
      b.addFact("环境变量隔离时同一条内容不应被本机共享索引去重");
      expect(b.getFacts().length, "环境变量隔离场景下第二个 agent 的写入被本机索引去重掉了").toBe(1);
      expect(b.getSharedRefs().length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.SLIME_MEMORY_ISOLATED;
      else process.env.SLIME_MEMORY_ISOLATED = prev;
    }
  });

  it("隔离场景下派生索引文件一个字节都不许落盘", () => {
    const root = makeRoot();
    markIsolated(root);
    const a = new MemoryStore("nodisk_ts_a", { dataDir: root });
    a.addFact("隔离场景下不该把隔离内容写进本机共享索引");
    expect(existsSync(join(root, ".global", "index.json")), "隔离场景下仍落了全局索引文件").toBe(false);
  });
});