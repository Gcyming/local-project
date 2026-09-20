/*
 * 启动冒烟守卫（A-1020）：验证主进程能真正起来。
 *
 * 由来：A-1019 给 `slime:theme:set` 补持久化时加了新 handler 却忘删旧的 →
 *   同一 IPC channel 注册两次 → `ipcMain.handle` 直接 throw → **整个应用打不开**。
 *   而 tsc / vitest / 产物断言**全都拦不住**（没有任何一条在断言运行时能否启动）。
 *   所以补这条**外部观察**的冒烟：由 Node 拉起真正的 electron 应用，
 *   外部判断"进程是否存活 + 输出里有无 fatal 特征串"，不依赖应用自述。
 *
 * 这个脚本本身**由 Node 跑**（不是 electron）—— 它用子进程拉起真正的 electron 应用，
 * 这样"应用起没起来"是外部观察到的，不是应用自己说的。
 *
 * 跑法：
 *   node scripts/assert-boot-smoke.cjs   （结果打印并写入 out/_smoke-boot.json）
 *
 * 环境变量 SMOKE_ALIVE_MS 可调存活时长（默认 12000）。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const GUI = path.resolve(__dirname, "..");
const ELECTRON = path.join(GUI, "node_modules", "electron", "dist", "electron.exe");
const OUT_JSON = path.join(GUI, "out", "_smoke-boot.json");

const FATAL = [
  "Attempted to register a second handler",
  "启动失败",
  "ELIFECYCLE",
];
const ALIVE_MS = Number(process.env.SMOKE_ALIVE_MS ?? 12000);

const child = spawn(ELECTRON, ["."], {
  cwd: GUI,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  stdio: ["ignore", "pipe", "pipe"],
});

let buf = "";
child.stdout.on("data", (d) => { buf += d.toString(); });
child.stderr.on("data", (d) => { buf += d.toString(); });
let exited = null;
child.on("exit", (code) => { exited = code; });
child.on("error", (e) => { buf += `\n[spawn error] ${e.message}\n`; });

setTimeout(() => {
  const hits = FATAL.filter((f) => buf.includes(f));
  const alive = exited === null;                 // 还活着 = 没崩
  const dupWarn = buf.match(/IPC channel 重复注册[^\n]*/g) ?? [];
  const ok = alive && hits.length === 0;

  const report = {
    alive,
    exitCode: exited,
    fatalHits: hits,
    dupWarnCount: dupWarn.length,
    ok,
    tail: buf.split("\n").filter(Boolean).slice(-14),
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  console.log(`存活 ${ALIVE_MS / 1000}s : ${alive ? "yes" : `NO (exit=${exited})`}`);
  console.log(`fatal : ${hits.length === 0 ? "none" : JSON.stringify(hits)}`);
  console.log(`重复注册告警: ${dupWarn.length}`);
  console.log("--- 输出末尾 ---");
  console.log(report.tail.join("\n"));
  console.log(`报告: ${OUT_JSON}`);
  console.log(ok ? "RESULT=PASS" : "RESULT=FAIL");

  try { child.kill("SIGKILL"); } catch { /* ignore */ }
  process.exit(ok ? 0 : 1);
}, ALIVE_MS);
