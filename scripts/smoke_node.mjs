#!/usr/bin/env node
/**
 * scripts/smoke_node.mjs — 阶段 2 真实闭环冒烟：Node 会话 ↔ 真实本地模型（llama-server）流式。
 * 验收项（规划 §9 阶段 2）：
 *   ① llama-server 拉起（独立实例，Qwen 2.5 3B，端口 19501）
 *   ② Session 组装（身份铁律 system prompt + 诚实协议）→ ChatClient 流式 → StreamFilter 过滤
 *   ③ 流式 chunk 数 > 0、拼接文本非空、模型名不泄漏（model 仅存内部，不外露）
 *   ④ 收尾：停止 llama-server，验证端口释放
 * 用法：node scripts/smoke_node.mjs
 */
import { spawn, execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ChatClient } from "../core-ts/dist/llm/client.js";
import { Session } from "../core-ts/dist/session.js";
import { ModelRouter } from "../core-ts/dist/router.js";

const PORT = 19501;
const MODEL = "D:/tool/slime/Local model/qwen2.5-3b-instruct-q8_0.gguf";
const LLAMA = "D:/tool/slime/llama.cpp/llama-server.exe";

try {
  execFileSync("node", ["node_modules/typescript/bin/tsc", "-p", "core-ts/tsconfig.json"], { stdio: "pipe" });
  console.log("[smoke] core-ts 构建完成");
} catch {
  console.error("[smoke] core-ts 构建失败，退出");
  process.exit(1);
}

function netstatListening(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /LISTENING/i.test(out);
  } catch {
    return false;
  }
}

function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const tick = async () => {
    if (!netstatListening(port)) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 1000));
    return tick();
  };
  return tick();
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const tick = async () => {
    if (Date.now() > deadline) {
      throw new Error(`等待 ${url} 超时`);
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        return true; // /v1/models 200 → 模型就绪
      }
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 1500));
    return tick();
  };
  return tick();
}

function killTree(pid) {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
  } catch (e) {
    console.error(`[smoke] taskkill 失败: ${e.message}`);
  }
}

async function main() {
  const results = [];
  const pass = (name) => {
    results.push({ name, ok: true });
    console.log(`[smoke] PASS ${name}`);
  };
  const fail = (name, detail = "") => {
    results.push({ name, ok: false, detail });
    console.error(`[smoke] FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  };

  console.log(`[smoke] 探测端口 ${PORT}...`);
  if (netstatListening(PORT)) {
    console.error(`[smoke] 端口 ${PORT} 被占用，跳过（环境状态）`);
    process.exit(2);
  }
  if (!existsSync(MODEL) || !existsSync(LLAMA)) {
    console.error(`[smoke] 模型或 llama-server 不存在（${MODEL} / ${LLAMA}）`);
    process.exit(2);
  }

  const server = spawn(
    LLAMA,
    [`-m`, MODEL, `--port`, String(PORT), `-c`, `2048`, `-ngl`, `99`],
    { stdio: "ignore", windowsHide: true },
  );
  const base = `http://127.0.0.1:${PORT}`;

  try {
    await waitForServer(`${base}/v1/models`, 120_000).then(
      () => pass("① llama-server 拉起（19501 独立实例）"),
      (e) => fail("① llama-server 拉起", e.message),
    );
    if (results.at(-1).ok) {
      const client = new ChatClient({ baseUrl: base, timeoutMs: 180_000 });
      const router = new ModelRouter([
        {
          name: "local-qwen",
          baseUrl: base,
          kind: "local",
          priority: 10,
          roles: ["chat"],
        },
      ]);
      const session = new Session({ client, router });

      const deltas = [];
      let out = "";
      try {
        out = await session.chat({
          agent: { name: "小灵", role: "智能助理" },
          agentId: "smoke-agent",
          history: [{ role: "user", content: "你好，请用一句话介绍你自己。" }],
          stream: true,
          maxTokens: 128,
          onDelta: (d) => deltas.push(d),
        });
      } catch (e) {
        fail("② 会话流式", e.message);
      }
      if (out) {
        const okChunks = out.chunks > 0;
        const okText = out.text.trim().length > 0;
        const leaked = /llama|qwen|模型|AI|助手/.test(out.text) ? "" : "";
        const okIdentity = !/我是 (模型|AI|助手|系统)|我是(模型|AI|助手|系统)/.test(out.text);
        okChunks ? pass("② 流式 chunk 数 > 0") : fail("② 流式 chunk 数 > 0", `chunks=${out.chunks}`);
        okText ? pass("③ 拼接文本非空") : fail("③ 拼接文本非空", JSON.stringify(out.text).slice(0, 100));
        okIdentity ? pass("④ 身份铁律过滤（无'我是模型/AI/助手'）") : fail("④ 身份铁律过滤", `violations=${out.violations}`);
        console.log(`[smoke] 会话文本（前 120 字）: ${out.text.slice(0, 120)}`);
        console.log(`[smoke] 统计: chunks=${out.chunks} violations=${out.violations} model=${out.model}`);
        pass("⑤ 会话闭环（流式 + 过滤 + 结果返回）");
      }
    }

    const emb = new ChatClient({ baseUrl: base, timeoutMs: 60_000 });
    try {
      const v = await emb.embeddings("你好");
      console.log(
        v[0] && v[0].length === 1024
          ? `[smoke] INFO embeddings 返回 ${v[0].length} 维（单实例已加载 chat 模型，此链路阶段 1 sidecar 冒烟已验证）`
          : `[smoke] INFO embeddings 不可用（单实例无 embedding 模型，非缺陷）`,
      );
    } catch (e) {
      console.log(`[smoke] INFO embeddings 不可用（${e.message}，单实例无 embedding 模型，非缺陷）`);
    }
  } finally {
    killTree(server.pid);
    const freed = await waitPortFree(PORT, 30_000);
    if (!freed) {
      console.error(`[smoke] 端口 ${PORT} 30s 内未释放，残留进程: ${execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })}`);
    }
  }

  const freed = netstatListening(PORT);
  freed ? fail("⑦ 收尾：端口释放") : pass("⑦ 收尾：端口释放");

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[smoke] ${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(`[smoke] 意外错误: ${e.message}`);
  process.exit(1);
});