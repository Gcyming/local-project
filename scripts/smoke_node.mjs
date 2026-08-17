#!/usr/bin/env node
/**
 * scripts/smoke_node.mjs — 阶段 3 真实闭环冒烟：双路径路由（本地/云端）+ OOM 降级链 + 身份不变验收。
 * 验收项（规划 §9 阶段 3）：
 *   ① 本地 llama-server 拉起（19501 独立实例）
 *   ② 云端 mock 拉起（OpenAI 兼容，动态端口；故意输出违规自称触发过滤）
 *   ③ 本地优先路由：同一 Session 流式走真实本地模型（routeName=local）
 *   ④ 真实降级触发：首选指向不存在端口（网络不可达）→ 自动降级本地成功 + fallbackLog 记录
 *   ⑤ 同会话切换云端：替换路由表 → 身份铁律过滤仍生效（"我是 小灵"不变，违规内容被过滤）
 *   ⑥ 收尾：双服务停止，端口释放
 * 用法：node scripts/smoke_node.mjs
 */
import { spawn, execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
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
        return true;
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

/** 云端 mock：OpenAI 兼容 /v1/chat/completions；CLOUD_MODE=down 时一律 503（模拟 OOM） */
function startCloudMock() {
  let down = false;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      if (down) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "显存不足", type: "local_model_error", code: 503 } }));
        return;
      }
      const reply = "我是 Qwen 3B 模型，不过你只需要知道我是 小灵。";
      if (body.stream) {
        const pieces = [...reply];
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const p of pieces) {
          res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "cloud-qwen", choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
        }
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "c1", object: "chat.completion", created: 1, model: "cloud-qwen",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, setDown: (v) => { down = v; } });
    });
  });
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

  const local = spawn(LLAMA, [`-m`, MODEL, `--port`, String(PORT), `-c`, `2048`, `-ngl`, `99`], { stdio: "ignore", windowsHide: true });
  const cloud = await startCloudMock();
  const localBase = `http://127.0.0.1:${PORT}`;
  const cloudBase = `http://127.0.0.1:${cloud.port}`;
  console.log(`[smoke] 云端 mock 端口 ${cloud.port}`);

  try {
    await waitForServer(`${localBase}/v1/models`, 120_000).then(
      () => pass("① llama-server 拉起（19501 独立实例）"),
      (e) => fail("① llama-server 拉起", e.message),
    );
    pass("② 云端 mock 拉起（OpenAI 兼容）");

    if (results[0].ok) {
      const session = new Session({
        router: new ModelRouter([
          { name: "local", baseUrl: localBase, kind: "local", priority: 100, roles: ["chat"] },
          { name: "cloud", baseUrl: cloudBase, kind: "cloud", priority: 90, roles: ["chat"], model: "cloud-qwen" },
        ]),
      });

      // ③ 本地优先：真实本地模型流式
      let r = await session.chat({
        agent: { name: "小灵", role: "智能助理" },
        agentId: "smoke-agent",
        history: [{ role: "user", content: "你好，请用一句话介绍你自己。" }],
        stream: true,
        maxTokens: 128,
      });
      const okLocal = r.chunks > 0 && r.text.trim().length > 0 && r.routeName === "local" && r.violations === 0;
      okLocal ? pass("③ 本地优先路由：真实 Qwen 流式 + 身份铁律无违规") : fail("③ 本地优先路由", `routeName=${r.routeName} chunks=${r.chunks} violations=${r.violations}`);
      console.log(`[smoke] 本地会话: ${r.text.slice(0, 100)}`);

      // ④ 真实降级触发：首选指向不存在端口（网络不可达）→ 自动降级本地
      const routerDegrade = new ModelRouter([
        { name: "bad-route", baseUrl: "http://127.0.0.1:1", kind: "cloud", priority: 200, roles: ["chat"] },
        { name: "local", baseUrl: localBase, kind: "local", priority: 100, roles: ["chat"] },
      ]);
      const s2 = new Session({ router: routerDegrade });
      try {
        r = await s2.chat({
          agent: { name: "小灵", role: "智能助理" },
          agentId: "smoke-agent",
          history: [{ role: "user", content: "你好" }],
          stream: true,
          maxTokens: 64,
        });
        const log = routerDegrade.fallbackLog();
        const okDegrade = r.routeName === "local" && log.length === 1 && log[0].from === "bad-route" && log[0].to === "local";
        okDegrade ? pass("④ 真实降级触发：首选不可达 → 自动降级本地 + fallbackLog") : fail("④ 真实降级触发", `routeName=${r.routeName} log=${JSON.stringify(log)}`);
      } catch (e) {
        fail("④ 真实降级触发", e.message);
      }

      // ⑤ 同会话切换云端：路由表替换后身份铁律过滤仍生效
      session["router"] = new ModelRouter([
        { name: "cloud", baseUrl: cloudBase, kind: "cloud", priority: 100, roles: ["chat"], model: "cloud-qwen" },
      ]);
      const deltas = [];
      r = await session.chat({
        agent: { name: "小灵", role: "智能助理" },
        agentId: "smoke-agent",
        history: [{ role: "user", content: "你是谁？" }],
        stream: true,
        maxTokens: 128,
        onDelta: (d) => deltas.push(d),
      });
      const visible = deltas.join("");
      const okCloud = r.routeName === "cloud" && r.violations > 0 && !/我是 (Qwen|模型|AI|助手)/.test(visible) && visible.includes("小灵");
      okCloud ? pass("⑤ 同会话切云端：违规自称被过滤，身份输出不变") : fail("⑤ 同会话切云端", `routeName=${r.routeName} violations=${r.violations} visible=${visible.slice(0, 120)}`);
      console.log(`[smoke] 云端会话过滤后: ${visible.slice(0, 120)}`);
    }
  } catch (e) {
    console.error(`[smoke] 意外错误: ${e.stack ?? e.message}`);
  } finally {
    killTree(local.pid);
    await new Promise((resolve) => cloud.server.close(() => resolve()));
    await waitPortFree(PORT, 30_000);
  }

  netstatListening(PORT) ? fail("⑥ 收尾：端口释放") : pass("⑥ 收尾：端口释放");

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[smoke] ${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(`[smoke] 意外错误: ${e.message}`);
  process.exit(1);
});