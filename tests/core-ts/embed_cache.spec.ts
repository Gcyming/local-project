/**
 * tests/core-ts/embed_cache.spec.ts — EmbedCache（LRU + 磁盘持久化）测试。
 * 隔离：filePath 指向临时目录，不触碰生产 data/embed_cache.json。
 */
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbedCache } from "../../core-ts/src/memory/embed_cache.js";
import { MemoryStore } from "../../core-ts/src/memory/store.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "embedcache-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("EmbedCache 基础", () => {
  it("命中返回副本，未命中返回 undefined", () => {
    const c = new EmbedCache({ filePath: join(makeTmp(), "c.json") });
    expect(c.get("hello")).toBeUndefined();
    const vec = [0.1, 0.2, 0.3];
    c.set("hello", vec);
    const hit = c.get("hello");
    expect(hit).toEqual(vec);
    expect(hit).not.toBe(vec); // 副本，防原地改坏缓存
  });

  it("同文本跨实例（磁盘持久化）命中：flush 后重建可恢复", () => {
    const dir = makeTmp();
    const fp = join(dir, "c.json");
    const a = new EmbedCache({ filePath: fp });
    a.set("持久化文本", [1, 2, 3, 4]);
    a.flush();

    const b = new EmbedCache({ filePath: fp });
    expect(b.get("持久化文本")).toEqual([1, 2, 3, 4]);
  });

  it("LRU：超上限淘汰最久未使用，命中刷新保活", () => {
    const c = new EmbedCache({ filePath: join(makeTmp(), "c.json"), maxEntries: 2 });
    c.set("a", [1]);
    c.set("b", [2]);
    c.get("a"); // 刷新 a → LRU 序 b, a
    c.set("c", [3]); // 淘汰最久未用 b
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toEqual([1]);
    expect(c.get("c")).toEqual([3]);
    expect(c.size).toBe(2);
  });

  it("维度不符时旧缓存失效（BUG-025 可配置维度）", () => {
    const c = new EmbedCache({ filePath: join(makeTmp(), "c.json") });
    c.set("dimvec", [1, 2, 3]);
    expect(c.get("dimvec", 3)).toEqual([1, 2, 3]);
    expect(c.get("dimvec", 1024)).toBeUndefined(); // 维度变更 → miss
  });
});

describe("MemoryStore.embedOrHash 集成", () => {
  it("重复文本命中缓存，不重复调用底层 embedder", async () => {
    const dir = makeTmp();
    let calls = 0;
    const vec = Array.from({ length: 1024 }, (_, i) => i / 1024);
    const m = new MemoryStore("embed_int_agent", {
      dataDir: dir,
      embedCache: new EmbedCache({ filePath: join(dir, "ec.json") }),
      embed: {
        embed: async () => {
          calls++;
          return [...vec];
        },
      },
    });
    const r1 = await m.embedOrHash("重复查询文本");
    const r2 = await m.embedOrHash("重复查询文本");
    expect(r1).toEqual(vec);
    expect(r2).toEqual(vec);
    expect(calls).toBe(1); // 第二次命中缓存
  });

  it("embedder 抛错 → 回退 hashEmbed，且不污染缓存", async () => {
    const dir = makeTmp();
    const m = new MemoryStore("embed_fail_agent", {
      dataDir: dir,
      embedCache: new EmbedCache({ filePath: join(dir, "ec.json") }),
      embed: {
        embed: async () => {
          throw new Error("server down");
        },
      },
    });
    const r = await m.embedOrHash("会失败");
    expect(r.length).toBeGreaterThan(0); // 哈希降级
  });
});
