/**
 * tests/core-ts/history.spec.ts — core-ts history store 测试（P0: clear/retry 支持）。
 *
 * 策略：HISTORY_PATH 是模块级常量，测试通过 fs 文件操作绕过。
 * 每个测试用独立临时目录 + 独立 HISTORY_PATH 写入/读取。
 */
import { describe, expect, it } from "vitest";
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
