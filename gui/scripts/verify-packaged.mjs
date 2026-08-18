// 打包产物运行时验证：通过 CDP 调用渲染进程的 preload API，
// 验证 IPC 链路（创建 Agent）与 SLIME_ROOT 数据写入（打包模式 boot.ts 注入）。
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
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
