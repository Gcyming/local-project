/**
 * tests/core-ts/history.spec.ts — core-ts history store 测试（P0: clear/retry 支持）。
 *
 * 策略：HISTORY_PATH 是模块级常量，测试通过 fs 文件操作绕过。
 * 每个测试用独立临时目录 + 独立 HISTORY_PATH 写入/读取。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hist-"));
}

async function writeHistory(path: string, lines: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(path, lines.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

async function readHistory(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("clearHistoryForAgent（P0）", () => {
  it("清空指定 agent 的全部历史，保留其他 agent", async () => {
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    await writeHistory(path, [
      { agent_id: "a1", user: "u1", ai: "r1", success: true },
      { agent_id: "a1", user: "u2", ai: "r2", success: true },
      { agent_id: "a2", user: "u3", ai: "r3", success: false },
    ]);
    const lines = (await readHistory(path)).filter((r) => r.agent_id !== "a1");
    await writeHistory(path, lines);
    const remaining = await readHistory(path);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].agent_id).toBe("a2");
    expect(remaining[0].user).toBe("u3");
    await rm(dir, { recursive: true, force: true });
  });

  it("agent 无历史时返回 0（语义验证）", async () => {
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    await writeHistory(path, [{ agent_id: "a2", user: "u3", ai: "r3", success: true }]);
    const lines = (await readHistory(path)).filter((r) => r.agent_id !== "a1");
    expect(lines).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("popLastRecordForAgent（P0）", () => {
  it("弹出最后一条并返回 record", async () => {
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    await writeHistory(path, [
      { agent_id: "a1", user: "u1", ai: "r1", success: true },
      { agent_id: "a1", user: "u2", ai: "r2", success: true },
    ]);
    const records = await readHistory(path);
    let idx = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].agent_id === "a1") { idx = i; break; }
    }
    expect(idx).toBe(1);
    const removed = records.splice(idx, 1)[0];
    expect(removed.user).toBe("u2");
    expect(removed.ai).toBe("r2");
    await writeHistory(path, records);
    const remaining = await readHistory(path);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].user).toBe("u1");
    await rm(dir, { recursive: true, force: true });
  });

  it("非本 agent 的历史不干扰", async () => {
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    await writeHistory(path, [
      { agent_id: "a1", user: "u1", ai: "r1", success: true },
      { agent_id: "a2", user: "u2", ai: "r2", success: true },
    ]);
    const records = await readHistory(path);
    let idx = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].agent_id === "a1") { idx = i; break; }
    }
    expect(idx).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("既有函数语义回归", () => {
  it("append 顺序与 load 顺序一致", async () => {
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    await appendFile(path, JSON.stringify({ agent_id: "a1", user: "你好", ai: "你好！", success: true }) + "\n", "utf8");
    await appendFile(path, JSON.stringify({ agent_id: "a1", user: "再见", ai: "再见！", success: true }) + "\n", "utf8");
    const records = await readHistory(path);
    expect(records).toHaveLength(2);
    expect(records[0].user).toBe("你好");
    expect(records[1].ai).toBe("再见！");
    await rm(dir, { recursive: true, force: true });
  });

  it("损坏行被跳过不影响有效数据", async () => {
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    const content = Buffer.from('{"agent_id":"a1","user":"ok"}\nNOT-JSON\n{"agent_id":"a1","user":"ok2"}\n', "utf8");
    await writeFile(path, content);
    const raw = await readFile(path, "utf8");
    const records = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((r): r is Record<string, unknown> => r !== null);
    expect(records).toHaveLength(2);
    expect(records[0].user).toBe("ok");
    expect(records[1].user).toBe("ok2");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("truncateHistoryFrom（A-161 回滚持久化一致性）", () => {
  it("按目标用户消息截断：该消息及其后全部删除，之前的保留；跨会话不误删", async () => {
    const prev = process.env.SLIME_HISTORY_PATH;
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    process.env.SLIME_HISTORY_PATH = path;
    try {
      vi.resetModules(); // 清模块缓存 → 动态 import 重读 SLIME_HISTORY_PATH
      const { truncateHistoryFromExport } = await import("../../core-ts/src/services/history.js");
      await writeHistory(path, [
        { agent_id: "a1", user: "问1", ai: "答1", success: true, session_id: "s1" },
        { agent_id: "a1", user: "问2", ai: "答2", success: true, session_id: "s1" },
        { agent_id: "a1", user: "问3", ai: "答3", success: true, session_id: "s1" },
        { agent_id: "a2", user: "别删我", ai: "ok", success: true, session_id: "s9" },
      ]);
      const removed = await truncateHistoryFromExport("a1", "s1", "问2");
      expect(removed).toBe(2); // 问2+问3 删除
      const remaining = await readHistory(path);
      expect(remaining).toHaveLength(2);
      expect(remaining[0].user).toBe("问1");
      expect(remaining[1].agent_id).toBe("a2"); // 其他会话记录保留
    } finally {
      delete process.env.SLIME_HISTORY_PATH;
      if (prev !== undefined) { process.env.SLIME_HISTORY_PATH = prev; }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("找不到目标消息（未持久化/不在本会话）→ 返回 0 且文件不变", async () => {
    const prev = process.env.SLIME_HISTORY_PATH;
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    process.env.SLIME_HISTORY_PATH = path;
    try {
      vi.resetModules(); // 清模块缓存 → 动态 import 重读 SLIME_HISTORY_PATH
      const { truncateHistoryFromExport } = await import("../../core-ts/src/services/history.js");
      await writeHistory(path, [
        { agent_id: "a1", user: "问1", ai: "答1", success: true, session_id: "s1" },
      ]);
      const removed = await truncateHistoryFromExport("a1", "s1", "不存在的内容");
      expect(removed).toBe(0);
      expect(await readHistory(path)).toHaveLength(1);
    } finally {
      delete process.env.SLIME_HISTORY_PATH;
      if (prev !== undefined) { process.env.SLIME_HISTORY_PATH = prev; }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A-966 attachTimelineToRecord（时间线随历史落库，重启恢复交错思考）", () => {
  it("回填该会话最后一条记录 + 重读保留 timeline；跨会话不误写", async () => {
    const prev = process.env.SLIME_HISTORY_PATH;
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    process.env.SLIME_HISTORY_PATH = path;
    try {
      vi.resetModules();
      const { attachTimelineToRecord } = await import("../../core-ts/src/services/history.js");
      await writeHistory(path, [
        { agent_id: "a1", user: "q1", ai: "r1", success: true, session_id: "s1" },
        { agent_id: "a1", user: "q2", ai: "r2", success: true, session_id: "s1" },
        { agent_id: "a2", user: "q", ai: "r", success: true, session_id: "s9" },
      ]);
      const tl = [
        { kind: "think", text: "先想" },
        { kind: "tool", name: "web_search", label: "web_search" },
      ];
      expect(await attachTimelineToRecord("a1", "s1", tl)).toBe(true);
      const recs = await readHistory(path);
      // 附着到 a1/s1 的**最后一条**（非首条）、且跨会话 a2 不受影响
      expect(recs[1].timeline).toEqual(tl);
      expect(recs[0].timeline).toBeUndefined();
      expect(recs[2].timeline).toBeUndefined();
      // 空 timeline / 空会话 → false 且不改文件
      expect(await attachTimelineToRecord("a1", "s1", [])).toBe(false);
      expect(await attachTimelineToRecord("nobody", "s1", tl)).toBe(false);
    } finally {
      delete process.env.SLIME_HISTORY_PATH;
      if (prev !== undefined) { process.env.SLIME_HISTORY_PATH = prev; }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("session_id 未落库（旧链路）→ 回退附到该 agent 最近一条记录", async () => {
    const prev = process.env.SLIME_HISTORY_PATH;
    const dir = await makeTmp();
    const path = join(dir, "history.jsonl");
    process.env.SLIME_HISTORY_PATH = path;
    try {
      vi.resetModules();
      const { attachTimelineToRecord } = await import("../../core-ts/src/services/history.js");
      await writeHistory(path, [
        { agent_id: "a1", user: "q1", ai: "r1", success: true }, // 无 session_id
      ]);
      const tl = [{ kind: "think", text: "旧链路回退" }];
      expect(await attachTimelineToRecord("a1", "sX", tl)).toBe(true);
      expect((await readHistory(path))[0].timeline).toEqual(tl);
    } finally {
      delete process.env.SLIME_HISTORY_PATH;
      if (prev !== undefined) { process.env.SLIME_HISTORY_PATH = prev; }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
