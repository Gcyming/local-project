/**
 * tests/core-ts/thread_worker.spec.ts — worker_threads 并行组件测试（真实 node:http 本地 server）。
 * 验证：<DONE> 完成协议 / 轮次耗尽失败 / API 错误 / 停止信号 / 并行双 Worker / 进度流。
 */
import { describe, expect, it, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ThreadWorker, makeThreadWorkerInput, THREAD_MAX_ROUNDS } from "../../core-ts/src/thread_worker.js";

let server: Server | null = null;
let baseUrl = "";
let mode: "done" | "never" | "error" = "done";
let serverCount = 0;

function startServer(): { baseUrl: string; count: () => number } {
  let localCount = 0;
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      localCount++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (mode === "error") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "boom" }));
          return;
        }
        const content = mode === "done" ? "任务完成，结果如下。<DONE>" : "还在处理中，没有完成。";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as AddressInfo;
      serverCount = localCount;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({ baseUrl, count: () => localCount });
    });
  });
}

afterAll(() => {
  server?.close();
});

describe("ThreadWorker", () => {
  it("单 Worker：<DONE> 完成 + 结果清洗 + 进度流", async () => {
    mode = "done";
    const s = await startServer();
    const w = new ThreadWorker(
      makeThreadWorkerInput({
        taskId: "t1",
        subtaskId: "st1",
        subtaskDescription: "生成一段视频",
        apiBase: s.baseUrl,
        retryBackoffMs: [5, 10],
        timeoutMs: 5000,
      }),
    );
    w.start();
    expect(w.isAlive()).toBe(true);
    const out = await w.getResult(10_000);
    expect(out).not.toBeNull();
    expect(out!.state).toBe("done");
    expect(out!.result).toContain("任务完成");
    expect(out!.result).not.toContain("<DONE>");
    expect(out!.rounds).toBe(1);
    expect(out!.taskId).toBe("t1");
    const progress = w.drainProgress();
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].subtaskId).toBe("st1");
    w.cleanup();
  });

  it("轮次耗尽未收到 <DONE> → failed", async () => {
    mode = "never";
    const s = await startServer();
    const w = new ThreadWorker(
      makeThreadWorkerInput({
        taskId: "t2",
        subtaskId: "st2",
        subtaskDescription: "难任务",
        apiBase: s.baseUrl,
        maxRounds: 3,
        retryBackoffMs: [5, 10],
        timeoutMs: 5000,
      }),
    );
    w.start();
    const out = await w.getResult(30_000);
    expect(out!.state).toBe("failed");
    expect(out!.error).toContain("未确认完成");
    expect(out!.rounds).toBe(3);
    expect(s.count()).toBe(3);
    w.cleanup();
  });

  it("API 错误 → failed 且带 [API 调用失败]", async () => {
    mode = "error";
    const s = await startServer();
    const w = new ThreadWorker(
      makeThreadWorkerInput({
        taskId: "t3",
        subtaskId: "st3",
        subtaskDescription: "任务",
        apiBase: s.baseUrl,
        retryBackoffMs: [5, 10],
        timeoutMs: 5000,
      }),
    );
    w.start();
    const out = await w.getResult(10_000);
    expect(out!.state).toBe("failed");
    expect(out!.error).toContain("[API 调用失败]");
    w.cleanup();
  });

  it("stop()：运行中停止 → isAlive=false", async () => {
    mode = "done";
    const s = await startServer();
    const w = new ThreadWorker(
      makeThreadWorkerInput({
        taskId: "t4",
        subtaskId: "st4",
        subtaskDescription: "任务",
        apiBase: s.baseUrl,
        retryBackoffMs: [5, 10],
        timeoutMs: 5000,
      }),
    );
    w.start();
    w.stop(2000);
    expect(w.isAlive()).toBe(false);
  });

  it("并行：两个 Worker 同时运行都完成", async () => {
    mode = "done";
    const s = await startServer();
    const w1 = new ThreadWorker(
      makeThreadWorkerInput({ taskId: "t5", subtaskId: "p1", subtaskDescription: "任务一", apiBase: s.baseUrl, retryBackoffMs: [5, 10], timeoutMs: 5000 }),
    );
    const w2 = new ThreadWorker(
      makeThreadWorkerInput({ taskId: "t5", subtaskId: "p2", subtaskDescription: "任务二", apiBase: s.baseUrl, retryBackoffMs: [5, 10], timeoutMs: 5000 }),
    );
    w1.start();
    w2.start();
    const [o1, o2] = await Promise.all([w1.getResult(10_000), w2.getResult(10_000)]);
    expect(o1!.state).toBe("done");
    expect(o2!.state).toBe("done");
    expect(o1!.subtaskId).toBe("p1");
    expect(o2!.subtaskId).toBe("p2");
    expect(s.count()).toBe(2);
    w1.cleanup();
    w2.cleanup();
  });

  it("makeThreadWorkerInput 缺省字段填充", () => {
    const input = makeThreadWorkerInput({ apiBase: "http://x", subtaskDescription: "d" });
    expect(input.subtaskId).toMatch(/^st_/);
    expect(input.subtaskName).toBe("Worker");
    expect(input.maxRounds).toBe(THREAD_MAX_ROUNDS);
    expect(input.systemPrompt).toBe("");
  });
});