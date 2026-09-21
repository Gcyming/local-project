/**
 * A-1040 守卫：记忆「存储位置」= 一根管两处（memory.json + LanceDB），界面显示真实路径。
 *
 * **用户实测**（心智中枢 → 记忆（存储位置））：「这个位置自定义改地址只能改一个」——
 * 面板并列显示两条路径，却只有一个「更改存储位置…」按钮，而且改完只有第一条跟着变。
 *
 * 根因是结构性的，不是显示层的锅：
 *   ① `core-ts/store.ts` 曾写死
 *        `this.lancedbUri = opts.lancedbUri ?? resolve(DATA_DIR, agentId, "lancedb"); // LanceDB 保持原位`
 *      → 自定义根目录**只作用于 memory.json**，向量库被钉在默认 `data/` 里一动不动。
 *      而向量库恰恰是"记忆存储"里体积最大的那一半。
 *   ② `gui/src/main/index.ts` 的 configGet 返回的是**字符串模板**
 *        `lance: resolve(PROJECT_ROOT, "data", "<agentId>", "lancedb")`
 *      —— 字面 `<agentId>`，既不是真实路径、也永不随设置变化（假信息，用户拿到也没法用）。
 *
 * 本文件把"两者同根 + 路径同源"钉死。改回去**不会报错**，只在真机上表现为"只有一个地址会变"。
 */
import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryStore, resolveMemoryPaths } from "../../core-ts/src/memory/store.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "memroot-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 记录 connect 拿到的 uri，并返回一个"空库"桩（openTable 抛错 → 走 createTable 分支）。 */
function stubLance(seen: string[]): { connect: (uri: string) => Promise<never> } {
  const db = {
    openTable: async (): Promise<never> => { throw new Error("no table"); },
    createTable: async (): Promise<never> => ({
      add: async (): Promise<void> => undefined,
      query: () => ({ limit: () => ({ toArray: async (): Promise<unknown[]> => [] }) }),
      schema: async () => ({ fields: [] }),
    } as never),
  };
  return {
    connect: async (uri: string): Promise<never> => {
      seen.push(uri);
      return db as never;
    },
  };
}

describe("A-1040 ① resolveMemoryPaths：一个根目录同时决定两处存储", () => {
  it("默认（未设自定义根）：memory.json 在 Knowledge/Agent Memory，向量库在 data/", () => {
    const root = "/tmp/proj";
    const p = resolveMemoryPaths("ag1", { projectRoot: root });
    expect(p.memoryJson).toBe(resolve(root, "Knowledge", "Agent Memory", "ag1", "memory.json"));
    expect(p.lanceDir).toBe(resolve(root, "data", "ag1", "lancedb"));
  });

  it("🐛 回归红线：设了自定义根 → **两条路径都必须落在该根下**（此前向量库不跟着走）", () => {
    const root = "/tmp/proj";
    const custom = "/tmp/custom-root";
    const p = resolveMemoryPaths("ag1", { projectRoot: root, dataDir: custom });
    expect(p.memoryJson).toBe(resolve(custom, "ag1", "memory.json"));
    // 这就是用户报的"只能改一个"：这一条以前会落回 <root>/data/…（与自定义根无关）
    expect(p.lanceDir).toBe(resolve(custom, "ag1", "lancedb"));
    expect(p.lanceDir.startsWith(resolve(custom))).toBe(true);
  });

  it("相对根目录按 projectRoot 解析（不解释成进程 cwd）", () => {
    const p = resolveMemoryPaths("ag1", { projectRoot: "/tmp/proj", dataDir: "memstore" });
    expect(p.memoryJson).toBe(resolve("/tmp/proj", "memstore", "ag1", "memory.json"));
    expect(p.lanceDir).toBe(resolve("/tmp/proj", "memstore", "ag1", "lancedb"));
  });
});

describe("A-1040 ② MemoryStore 真正写入的位置与推导一致", () => {
  it("自定义根：memory.json 与向量库**同根**（向量库不再被钉在默认 data/）", async () => {
    const proj = makeTmp();
    const seen: string[] = [];
    const m = new MemoryStore("ag_same", {
      projectRoot: proj,
      dataDir: "custom-mem",
      lancedbEnabled: true,
      embed: { embed: async (): Promise<number[]> => new Array(1024).fill(0) },
      lance: stubLance(seen),
    });
    await m.storeCategorizedAsync("fact", "用户偏好批处理", ["tooling"]);

    const base = resolve(proj, "custom-mem", "ag_same");
    expect(existsSync(join(base, "memory.json")), "memory.json 应落在自定义根下").toBe(true);

    await m.initLancedb();
    expect(seen.length, "向量层应已连接").toBeGreaterThan(0);
    expect(seen[0], "向量库必须与 memory.json 同根").toBe(join(base, "lancedb"));
  });

  it("未设自定义根：向量库仍在 <projectRoot>/data/<agent> 下（默认行为不回归）", async () => {
    const proj = makeTmp();
    const seen: string[] = [];
    const m = new MemoryStore("ag_default", {
      projectRoot: proj,
      lancedbEnabled: true,
      lance: stubLance(seen),
    });
    await m.initLancedb();
    expect(seen[0]).toBe(resolve(proj, "data", "ag_default", "lancedb"));
  });

  it("显式 lancedbUri 仍然最优先（测试/特殊部署可覆盖，不被推导抢走）", async () => {
    const proj = makeTmp();
    const seen: string[] = [];
    const explicit = resolve(proj, "explicit-lance");
    const m = new MemoryStore("ag_expl", {
      projectRoot: proj,
      dataDir: "custom-mem",
      lancedbEnabled: true,
      lancedbUri: explicit,
      lance: stubLance(seen),
    });
    await m.initLancedb();
    expect(seen[0]).toBe(explicit);
  });
});

describe("A-1040 ③ 旧向量库迁移：改了根目录不能把既有向量弄丢", () => {
  it("旧默认位置有库、新位置没有 → 搬到新位置（同盘 rename，原位置不再留着）", async () => {
    const proj = makeTmp();
    const oldDir = resolve(proj, "data", "ag_move", "lancedb");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "marker.txt"), "旧向量", "utf8");

    const seen: string[] = [];
    const m = new MemoryStore("ag_move", {
      projectRoot: proj,
      dataDir: "custom-mem",
      lancedbEnabled: true,
      lance: stubLance(seen),
    });
    await m.initLancedb();

    const newDir = resolve(proj, "custom-mem", "ag_move", "lancedb");
    expect(seen[0]).toBe(newDir);
    expect(existsSync(join(newDir, "marker.txt")), "旧数据必须跟着搬过来").toBe(true);
    expect(existsSync(oldDir), "同盘 rename 后旧目录不该继续存在").toBe(false);
  });

  it("新位置已有库 → 不动旧位置（绝不用旧数据盖掉新数据）", async () => {
    const proj = makeTmp();
    const oldDir = resolve(proj, "data", "ag_keep", "lancedb");
    const newDir = resolve(proj, "custom-mem", "ag_keep", "lancedb");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, "old.txt"), "old", "utf8");
    writeFileSync(join(newDir, "new.txt"), "new", "utf8");

    const m = new MemoryStore("ag_keep", {
      projectRoot: proj,
      dataDir: "custom-mem",
      lancedbEnabled: true,
      lance: stubLance([]),
    });
    await m.initLancedb();

    expect(existsSync(join(newDir, "new.txt"))).toBe(true);
    expect(existsSync(join(newDir, "old.txt")), "新位置已有库时不该被旧数据混入").toBe(false);
    expect(readdirSync(newDir).sort()).toEqual(["new.txt"]);
  });

  it("旧位置没有库 → 迁移静默跳过，仍然正常在新位置建库（搬家失败不阻断向量层）", async () => {
    const proj = makeTmp();
    const seen: string[] = [];
    const m = new MemoryStore("ag_none", {
      projectRoot: proj,
      dataDir: "custom-mem",
      lancedbEnabled: true,
      lance: stubLance(seen),
    });
    await expect(m.initLancedb()).resolves.toBeUndefined();
    expect(seen[0]).toBe(resolve(proj, "custom-mem", "ag_none", "lancedb"));
  });
});
