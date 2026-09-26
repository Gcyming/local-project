// 打包产物运行时验证：通过 CDP 调用渲染进程的 preload API，
// 验证 IPC 链路（创建 Agent）与 SLIME_ROOT 数据写入（打包模式 boot.ts 注入）。
//
// ⚠️ A-1110：CDP 端口**不再固定 9222**。主进程现在会在 9222 被占时顺延（9223…）、
//   连扫的窗口也占满时交系统分配临时端口，并把真值发布到 `<userData>/devtools-port.json`
//   （见 gui/src/main/devtoolsPort.ts）。原先这里写死 9222 ⇒ 一旦端口顺延，本脚本会
//   连到一个**根本不存在的服务**上（或更糟：连到占着 9222 的**别的**进程上）。
//   发现顺序：① 落盘文件（唯一权威，含「系统分配」的真值）→ ② 从 9222 顺延扫一段。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PREFERRED = (() => {
  const n = Number(process.env.SLIME_DEVTOOLS_PORT);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 9222;
})();
const SCAN = 20;

/** 主进程落盘端口（Electron app 名为 slime-gui ⇒ userData = %APPDATA%\slime-gui） */
function portFromFile() {
  const dirs = [process.env.SLIME_DEVTOOLS_PORT_DIR, join(process.env.APPDATA ?? "", "slime-gui")].filter(Boolean);
  for (const d of dirs) {
    try {
      const p = Number(JSON.parse(readFileSync(join(d, "devtools-port.json"), "utf8")).port);
      if (Number.isInteger(p) && p > 0) { return p; }
    } catch { /* 没有这个文件就继续 */ }
  }
  return null;
}

/** 探一个端口是否是我们这个 app 的 CDP（拿到 page target 才算） */
async function probe(port) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 700);
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) { return null; }
    const list = await res.json();
    return Array.isArray(list) && list.some((t) => t.type === "page") ? list : null;
  } catch { return null; }
}

const candidates = [...new Set([portFromFile(), PREFERRED, ...Array.from({ length: SCAN }, (_, i) => PREFERRED + i + 1)].filter((p) => Number.isInteger(p) && p > 0))];
let list = null;
let used = 0;
for (const port of candidates) {
  const got = await probe(port);
  if (got) { list = got; used = port; break; }
}
if (!list) {
  console.error(`FAIL: 在 ${candidates.join(" / ")} 上都没有找到 CDP 端点（dev 实例没跑？端口被防火墙挡了？）`);
  process.exit(1);
}
console.log(`CDP 端口: ${used}`);
const page = list.find((t) => t.type === "page");
if (!page) { console.error("FAIL: no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
ws.onerror = (e) => { console.error("WS error", e); process.exit(1); };
await new Promise((r) => { ws.onopen = r; });

async function evaluate(expr) {
  const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error("eval exception: " + JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails));
  return res.result.value;
}

// 1. preload API 存在性
const hasApi = await evaluate("typeof window.slimeAPI === 'object' && typeof window.slimeAPI.agents.list === 'function'");
console.log("preload slimeAPI:", hasApi ? "OK" : "MISSING");

// 2. 当前 Agent 列表
const before = await evaluate("window.slimeAPI.agents.list()");
console.log("agents before:", JSON.stringify(before));

// 3. 创建 Agent（正确签名：create(name, role)；触发 IPC → 主进程 → core-ts → SLIME_ROOT 写盘）
const created = await evaluate(`window.slimeAPI.agents.create("pack-verify", "打包验证")`);
console.log("create result:", JSON.stringify(created));

// 3b. 边界校验：误传对象必须被拒绝（不污染 agents.json）
const badCreate = await evaluate(`window.slimeAPI.agents.create({ name: "evil", role: "x" }).then(v => "unexpected-ok: " + JSON.stringify(v)).catch(e => "rejected: " + e.message)`);
console.log("bad-signature create:", badCreate);

// 4. 列表应包含新 Agent
const after = await evaluate("window.slimeAPI.agents.list()");
const names = after.map ? after.map((a) => a.name) : after;
console.log("agents after:", JSON.stringify(names));
console.log("pack-verify in list:", names.includes ? names.includes("pack-verify") : "unknown");

ws.close();
