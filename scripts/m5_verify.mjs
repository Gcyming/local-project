/**
 * scripts/m5_verify.mjs — M5 前置阻塞项复验（评审 P0-1 / v2.4 判定标准）。
 *
 * 链路：Node 客户端 → sidecar（INFER_PORT 动态下发）→ llama-server（Qwen 3B / BGE-M3）。
 * 判定标准（长存架构规划 §9 阶段 5A 前置阻塞项）：
 *   1. VRAM 预算计算值（slime.toml chat_est_gb + 1GB 余量）与 nvidia-smi 实测偏差 < 10%
 *   2. ≥3 轮短对话无 OOM、无 SSE 断流
 *   3. BGE-M3 嵌入（1024 维）+ 四阶段检索（/v1/retrieve）真实数据可用
 *
 * 纯 Node（fetch 原生），spawn sidecar 用 Python 启动器（py），零 PowerShell。
 */

import { spawn } from "node:child_process";
import net from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 工具 ────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHttp(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status === 200) return true;
    } catch {
      /* 未就绪 */
    }
    await sleep(500);
  }
  return false;
}

function nvidiaSmi() {
  return new Promise((resolve) => {
    const proc = spawn("nvidia-smi", ["--query-gpu=memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const parts = out.trim().split(",").map((s) => parseFloat(s.trim()));
      if (parts.length < 3) return resolve(null);
      resolve({ totalGb: parts[0] / 1024, usedGb: parts[1] / 1024, freeGb: parts[2] / 1024 });
    });
    proc.on("error", () => resolve(null));
  });
}

// ── 报告 ────────────────────────────────────────────────

const RESULTS = [];
function report(name, ok, detail) {
  RESULTS.push({ name, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

// ── 主流程 ──────────────────────────────────────────────

async function main() {
  const toml = readFileSync(path.join(ROOT, "slime.toml"), "utf-8");
  const estMatch = toml.match(/chat_est_gb\s*=\s*([\d.]+)/);
  const budgetMatch = toml.match(/vram_budget_gb\s*=\s*([\d.]+)/);
  const chatEstGb = estMatch ? parseFloat(estMatch[1]) : 4.0;
  const vramBudgetGb = budgetMatch ? parseFloat(budgetMatch[1]) : 7.0;
  console.log(`== M5 复验（slime.toml: chat_est_gb=${chatEstGb} vram_budget_gb=${vramBudgetGb}）==`);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`== 动态端口: ${port}，启动 sidecar ==`);

  const sidecar = spawn("py", ["sidecar/infer_server.py"], {
    cwd: ROOT,
    env: { ...process.env, INFER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  sidecar.stdout.on("data", (d) => console.log(`[sidecar] ${d.toString().trim()}`));
  sidecar.stderr.on("data", (d) => console.log(`[sidecar-err] ${d.toString().trim()}`));

  const vramBefore = await nvidiaSmi();
  console.log(`== VRAM 基线: ${JSON.stringify(vramBefore)}`);

  try {
    // 1. /health
    const healthOk = await waitHttp(`${baseUrl}/health`, 60000);
    report("sidecar /health", healthOk, healthOk ? `port=${port}` : "60s 超时");
    if (!healthOk) return 1;

    // 2. 四阶段检索（真实 Knowledge 数据）
    let agentId = "";
    try {
      const agents = JSON.parse(readFileSync(path.join(ROOT, "config", "agents.json"), "utf-8"));
      agentId = agents?.[0]?.id ?? "";
    } catch {
      /* 无 agents.json */
    }
    if (!agentId) {
      try {
        agentId = readdirSync(path.join(ROOT, "Knowledge", "Agent Memory")).find((n) => n.startsWith("agent_")) ?? "";
      } catch {
        agentId = "";
      }
    }
    if (!agentId) {
      report("四阶段检索", false, "无 agent 数据（config/agents.json / Knowledge/Agent Memory 均空）");
    } else {
      try {
        const r = await fetch(`${baseUrl}/v1/retrieve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, query: "最近学习和使用过的技能", top_k: 10, max_hops: 2 }),
        });
        const data = await r.json();
        const ok = r.status === 200 && Array.isArray(data.items);
        report("四阶段检索 /v1/retrieve", ok,
          ok ? `count=${data.count} stages=${JSON.stringify(data.stages)}` : `HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
      } catch (e) {
        report("四阶段检索 /v1/retrieve", false, String(e));
      }
    }

    // 3. models/load（Node 主编排路径：sidecar → ModelServerManager → llama-server）
    const loadChat = await fetch(`${baseUrl}/models/load`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "chat" }),
    });
    const chatLoad = await loadChat.json();
    report("ensure chat 全链路", Boolean(chatLoad.ok), `port=${chatLoad.port} ${chatLoad.detail ?? ""}`);
    const loadEmb = await fetch(`${baseUrl}/models/load`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "embedding" }),
    });
    const embLoad = await loadEmb.json();
    report("ensure embedding 全链路", Boolean(embLoad.ok), `port=${embLoad.port} ${embLoad.detail ?? ""}`);
    if (!chatLoad.ok || !embLoad.ok) return 1;

    // 4. Qwen 3B 流式 ≥3 轮短对话（无 SSE 断流）
    let rounds = 0;
    for (const question of ["你好，请简单介绍一下你自己", "今天天气不错，你觉得呢", "请用一句话回答：1+1等于几？"]) {
      try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: question }],
            stream: true, max_tokens: 200,
          }),
        });
        if (resp.status !== 200) {
          const txt = await resp.text();
          report(`对话轮 ${rounds + 1}`, false, `HTTP ${resp.status}: ${txt.slice(0, 200)}`);
          return 1;
        }
        let chunks = 0;
        let text = "";
        let done = false;
        for await (const line of resp.body) {
          const s = new TextDecoder().decode(line);
          for (const l of s.split("\n")) {
            if (!l.startsWith("data:")) continue;
            const data = l.slice(5).trim();
            if (data === "[DONE]") { done = true; break; }
            try {
              const delta = JSON.parse(data)?.choices?.[0]?.delta?.content ?? "";
              if (delta) { chunks++; text += delta; }
            } catch { /* 半行 JSON 丢弃 */ }
          }
          if (done) break;
        }
        const ok = chunks > 0 && done;
        rounds++;
        report(`对话轮 ${rounds}（Qwen 3B 流式）`, ok,
          ok ? `chunks=${chunks} 字符数=${text.length} 首段: ${text.slice(0, 30)}` : `chunks=${chunks} done=${done}`);
        if (!ok) return 1;
      } catch (e) {
        report(`对话轮 ${rounds + 1}`, false, String(e));
        return 1;
      }
    }
    report("SSE 断流检查（≥3 轮）", rounds >= 3, `${rounds} 轮无断流`);

    // 5. BGE-M3 嵌入（1024 维）
    try {
      const r = await fetch(`${baseUrl}/embeddings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "bge-m3", input: ["你好，世界", "slime agent"] }),
      });
      const data = await r.json();
      const vecs = data.data ?? [];
      const dims = new Set(vecs.map((v) => v.embedding?.length ?? 0));
      const ok = r.status === 200 && vecs.length === 2 && dims.size === 1 && [...dims][0] === 1024;
      report("BGE-M3 嵌入", ok, `条数=${vecs.length} 维度=${[...dims]}`);
    } catch (e) {
      report("BGE-M3 嵌入", false, String(e));
    }

    // 6. VRAM 预算偏差（判定：< 10%）
    const vramAfter = await nvidiaSmi();
    if (vramBefore && vramAfter) {
      const usedDelta = vramAfter.usedGb - vramBefore.usedGb;
      const budget = chatEstGb;
      const dev = Math.abs(usedDelta - budget) / budget * 100;
      const ok = dev < 10;
      report("VRAM 预算偏差（<10%）", ok,
        `预算=${budget}GB 实测增量=${usedDelta.toFixed(2)}GB 偏差=${dev.toFixed(2)}%（基线 ${vramBefore.usedGb}GB → ${vramAfter.usedGb}GB）`);
    } else {
      report("VRAM 预算偏差（<10%）", false, "nvidia-smi 不可用");
    }
  } finally {
    sidecar.kill();
  }

  const passed = RESULTS.filter((r) => r.ok).length;
  console.log(`== M5 复验结果: ${passed}/${RESULTS.length} 通过 ==`);
  return passed === RESULTS.length ? 0 : 1;
}

process.exit(await main());