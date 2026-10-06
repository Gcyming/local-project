#!/usr/bin/env node
/**
 * gui/scripts/probe-ua-transmission.mjs — A-1195（交接欠账 B5）：
 * chromiumFetch 的 net.fetch 路径是否**原样透传**显式 User-Agent。
 *
 * ## 为什么必须实测
 * 交接疑点：GUI 主链路的模型请求走 `chromiumFetch` → Electron `net.fetch`（优先于 Node fetch）。
 * 若 Chromium 网络栈用**自己的 UA** 覆盖显式头，主链路对供应商就是「匿名/自相矛盾指纹」——
 * 这可能是封号的真因之一。静态读码无法定论（net.fetch 行为是 Electron 运行时的事）。
 *
 * ## 做法
 * 本地 echo server 记录收到的 headers；spawn 一个**独立 Electron 进程**（无窗口）跑三组 net.fetch：
 *   p1 显式 User-Agent（模拟 client.headers() 的最小形态）
 *   p2 无 User-Agent（看 Chromium 默认 UA 长什么样）
 *   p3 显式 UA + Content-Type + Authorization（最接近真实模型请求头集）
 * 判据（读 echo 端记录为准）：p1/p3 的 user-agent == 发出值 ⇒ 透传；否则 ⇒ 被覆盖（要修）。
 *
 * 运行：`node gui/scripts/probe-ua-transmission.mjs`
 * （不 spawnSync —— 铁律 26；显式 timeout —— 铁律 28；无窗口、无 UI 弹出。）
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const ELECTRON = join(ROOT, "gui", "node_modules", "electron", "dist", "electron.exe");
if (!existsSync(ELECTRON)) { console.error(`找不到 Electron：${ELECTRON}`); process.exit(1); }

const SENT_UA = "slime/0.0.8 probe";

const received = [];
const server = createServer((req, res) => {
  received.push({
    path: req.url,
    ua: req.headers["user-agent"] ?? null,
    xProbe: req.headers["x-probe"] ?? null,
    authorization: req.headers["authorization"] ?? null,
    contentType: req.headers["content-type"] ?? null,
    secChUa: req.headers["sec-ch-ua"] ?? null,
    secChUaMobile: req.headers["sec-ch-ua-mobile"] ?? null,
    acceptLanguage: req.headers["accept-language"] ?? null,
  });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path: req.url, ua: req.headers["user-agent"] ?? null }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const tmp = mkdtempSync(join(tmpdir(), "slime-ua-probe-"));
const main = join(tmp, "main.cjs");
writeFileSync(main, `
const { app, net } = require("electron");
const BASE = process.argv[process.argv.length - 1];
(async () => {
  await app.whenReady();
  const results = [];
  const grab = async (name, url, init) => {
    try {
      const res = await net.fetch(url, init);
      const body = await res.text();
      results.push({ name, status: res.status, echo: body });
    } catch (e) {
      results.push({ name, error: String((e && e.message) || e) });
    }
  };
  await grab("p1", BASE + "/p1", { headers: { "User-Agent": "${SENT_UA}", "x-probe": "p1" } });
  await grab("p2", BASE + "/p2", { headers: { "x-probe": "p2" } });
  await grab("p3", BASE + "/p3", {
    method: "POST",
    headers: { "User-Agent": "${SENT_UA}", "Content-Type": "application/json", "Authorization": "Bearer sk-probe" },
    body: "{}",
  });
  console.log("PROBE_RESULT:" + JSON.stringify(results));
  app.exit(0);
})().catch((e) => {
  console.log("PROBE_RESULT:" + JSON.stringify([{ name: "fatal", error: String((e && e.stack) || e) }]));
  app.exit(1);
});
`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(ELECTRON, [main, base], { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += String(d); });
child.stderr.on("data", (d) => { out += String(d); });

const timer = setTimeout(() => {
  console.error("❌ 探针超时（25s）—— Electron 未返回结果");
  try { child.kill(); } catch { /* 已退出 */ }
  process.exitCode = 1;
  server.close();
}, 25_000);

child.on("close", (code) => {
  clearTimeout(timer);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("PROBE_RESULT:"));
  if (!line) {
    console.error(`❌ Electron 退出（code=${code}）但没有 PROBE_RESULT：\n${out.slice(-2000)}`);
    process.exitCode = 1;
    server.close();
    return;
  }
  const results = JSON.parse(line.slice("PROBE_RESULT:".length));
  console.log("── Electron 端结果 ──");
  for (const r of results) { console.log(" ", JSON.stringify(r)); }

  console.log("\n── echo server 收到的头（判据以此为准）──");
  for (const r of received) {
    console.log(`  ${r.path}: ua=${JSON.stringify(r.ua)}`);
    console.log(`    x-probe=${JSON.stringify(r.xProbe)} authorization=${JSON.stringify(r.authorization)}`);
    console.log(`    sec-ch-ua=${JSON.stringify(r.secChUa)} accept-language=${JSON.stringify(r.acceptLanguage)}`);
  }

  const p1 = received.find((r) => r.path === "/p1");
  const p2 = received.find((r) => r.path === "/p2");
  const p3 = received.find((r) => r.path === "/p3");
  let fail = 0;
  const ok = (m) => console.log("  ✓ " + m);
  const no = (m) => { fail++; console.log("  ✗ " + m); };

  console.log("\n── 判定 ──");
  if (!p1 || !p2 || !p3) { no(`请求没到齐（p1=${!!p1} p2=${!!p2} p3=${!!p3}）`); }
  else {
    if (p1.ua === SENT_UA) { ok("p1：显式 User-Agent 被 net.fetch **原样透传**"); }
    else { no(`p1：显式 UA 被覆盖 —— 发出「${SENT_UA}」，实收「${p1.ua}」`); }
    if (p3.ua === SENT_UA) { ok("p3：真实头集（UA+CT+Auth）下同样透传"); }
    else { no(`p3：显式 UA 被覆盖 —— 实收「${p3.ua}」`); }
    console.log(`  · p2（未给 UA）的默认值 = 「${p2.ua}」${p2.secChUa ? `，且自带 sec-ch-ua=${JSON.stringify(p2.secChUa)}` : ""}`);
    if (p1.secChUa) {
      console.log(`  ⚠️ p1 也带 sec-ch-ua=${JSON.stringify(p1.secChUa)} —— 「slime 的 UA + Chromium 指纹」同现，值得留意`);
    }
  }
  console.log(fail === 0 ? "\n✅ B5 结论：net.fetch 尊重显式 User-Agent（无匿名问题）" : `\n❌ B5：${fail} 项失败 —— 需要修 chromiumFetch 路径`);
  process.exitCode = fail === 0 ? 0 : 1;
  server.close();
});
