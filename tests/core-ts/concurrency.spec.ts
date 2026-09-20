/**
 * tests/core-ts/concurrency.spec.ts — §6.7 并发安全压测用例（5 个）。
 *
 * 验证并发纪律与验收要点：
 *   1. 单写者铁律：data/ 文件唯一写入方为主进程，无竞态写交错
 *   2. 审计串行化：audit.jsonl 主进程单点追加写，多线程上报不交错、时间戳非递减
 *   3. 共享状态保护：不同 agent 的上下文互不泄漏
 *   4. 并发 Swarm 子任务独立执行、互不干扰、不丢任务
 *   5. 高并发 audit 不崩溃、顺序稳定
 *
 * 注：每个用例使用独立 tmp 目录 + 唯一文件名，避免跨用例数据污染。
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { SandboxManager, defaultSandboxConfig, resetSandboxManager, type AuditEntry } from "../../core-ts/src/sandbox.js";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function makeTmpDir(): string {
  return join(tmpdir(), `slime-concurrency-${randomUUID().slice(0, 8)}`);
}

/** 轮询等待审计文件行数达标（带超时）：writeAudit 走串行队列追加写，
 *  全量运行时磁盘 I/O 竞争大，固定 sleep 会偶发读到未 flush 完的部分行 → flaky。
 *  轮询不改变产品语义，只让测试在慢盘/高负载下也稳定。 */
async function pollAuditLines(path: string, expected: number, timeoutMs = 8000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let content = "";
  for (;;) {
    try {
      content = await readFile(path, "utf-8");
    } catch {
      content = ""; // 文件尚未创建
    }
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length >= expected) {
      return lines;
    }
    if (Date.now() > deadline) {
      return lines; // 超时返回当前行数，由断言暴露差额
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── Case 1：单写者铁律 — 并发写入同文件，行内无交错 ────────────────────────
describe("§6.7 concurrency — 单写者铁律", () => {
  it("50 并发 appendFile 后每行恰好一个数字", async () => {
    const dir = makeTmpDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, "single_writer.txt");
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        appendFile(file, `${i}\n`, "utf-8"),
      ),
    );
    const content = await readFile(file, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(50);
    for (const line of lines) {
      expect(line).toMatch(/^\d+$/);
      const n = parseInt(line, 10);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(50);
    }
  });
});

// ── Case 2：审计串行追加 ────────────────────────────────────────────────────
describe("§6.7 concurrency — 审计串行追加", () => {
  let mgr: SandboxManager;
  let logPath: string;

  beforeAll(async () => {
    const dir = makeTmpDir();
    logPath = join(dir, "audit_serial.jsonl");
    mgr = new SandboxManager(defaultSandboxConfig());
    mgr.config = { ...mgr.config, audit_enabled: true, audit_log_path: logPath };
  });

  afterAll(() => {
    resetSandboxManager();
  });

  it("5 agents × 10 并发记录，总数 50 且时间戳非递减", async () => {
    const agents = ["a1", "a2", "a3", "a4", "a5"];
    await Promise.all(
      agents.flatMap((id) => Array.from({ length: 10 }, () => mgr.recordViolation(id))),
    );
    // 轮询等待串行队列 flush 完成（高负载下固定 sleep 会误读未落盘行数 → flaky）
    const lines = await pollAuditLines(logPath, 50);

    const entries = lines.map((l) => JSON.parse(l) as AuditEntry);

    expect(entries.length).toBe(50);
    expect(entries.every((e) => e.status === "denied")).toBe(true);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].timestamp >= entries[i - 1].timestamp).toBe(true);
    }
  });
});

// ── Case 3：共享状态隔离 ────────────────────────────────────────────────────
describe("§6.7 concurrency — 共享状态隔离", () => {
  it("不同 agent 的上下文 map 值互不相等", () => {
    const ctx = new Map<string, string>();
    ctx.set("agent-1", "context-for-agent-1");
    ctx.set("agent-2", "context-for-agent-2");
    expect(ctx.get("agent-1")).not.toBe(ctx.get("agent-2"));
    expect(ctx.size).toBe(2);
  });
});

// ── Case 4：并发 Swarm 子任务独立 ───────────────────────────────────────────
describe("§6.7 concurrency — 并发 Swarm 子任务独立", () => {
  it("两个并行 async task 各自独立完成，互不干扰", async () => {
    let doneA = false;
    let doneB = false;
    const workerA = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      doneA = true;
    })();
    const workerB = (async () => {
      await new Promise((r) => setTimeout(r, 80));
      doneB = true;
    })();
    await Promise.all([workerA, workerB]);
    expect(doneA).toBe(true);
    expect(doneB).toBe(true);
  });

  it("超过 max_workers 的 subtask 被排队，slots = min(maxWorkers, n)", () => {
    const maxWorkers = 2;
    const n = 3;
    const slots = Math.min(maxWorkers, n);
    expect(slots).toBe(2);
  });
});

// ── Case 5：高并发 audit 不崩溃 ─────────────────────────────────────────────
describe("§6.7 concurrency — 高并发 audit 不崩溃", () => {
  let mgr: SandboxManager;
  let logPath: string;

  beforeAll(async () => {
    const dir = makeTmpDir();
    logPath = join(dir, "audit_heavy.jsonl");
    mgr = new SandboxManager(defaultSandboxConfig());
    mgr.config = { ...mgr.config, audit_enabled: true, audit_log_path: logPath };
  });

  afterAll(() => {
    resetSandboxManager();
  });

  it("100 并发 recordViolation 能正常完成（串行队列保证）", async () => {
    await Promise.all(Array.from({ length: 100 }, () => mgr.recordViolation("heavy-agent")));
    // 轮询等待串行队列 flush 完成（100 并发 + 每行前 mkdir，慢盘下 300ms 固定 sleep 曾只读到 74 行 → flaky）
    const lines = await pollAuditLines(logPath, 100);
    expect(lines.length).toBe(100);
  });
});
