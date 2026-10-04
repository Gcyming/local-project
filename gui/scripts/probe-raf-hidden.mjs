/* eslint-disable */
/**
 * gui/scripts/probe-raf-hidden.mjs — 判别探针：页面不可见（document.hidden）时 rAF 到底跑不跑。
 *
 * 背景：A-1154 的几何 done 判据（含"对象从未挂载"的有界等待 GEOM_SYNC_NEVER_MOUNT_FRAMES）
 * 全部建立在 `requestAnimationFrame` 会持续推进之上。若页面 hidden 时 rAF 停摆，
 * 那么这一套判据在"窗口被遮挡/后台"时会**整体失效** ⇒ slime-freezing 永久残留。
 * 这条必须先量，不能推断。
 *
 * 运行（先起真 App，带 CDP 端口）：
 *   cd gui && SLIME_DEVTOOLS_PORT=9340 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .
 *   node gui/scripts/probe-raf-hidden.mjs
 */
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9340);
import fs from "node:fs";
const OUT = process.env.SLIME_RAF_OUT || "D:/pilot project/gui/out/_raf-hidden.txt";
const lines = [];
const say = (m) => { lines.push(m); process.stdout.write(m + "\n"); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); };

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page) { return page; }
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("CDP 目标未找到");
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id);
        if (msg.error) { rej(new Error(JSON.stringify(msg.error))); } else { res(msg.result); }
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { throw new Error("eval 异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); }
    return r.result.value;
  }
}

const measure = (label) => `
(async () => {
  const t0 = performance.now();
  let rafCount = 0, timerCount = 0;
  await new Promise((resolve) => {
    const tick = () => { rafCount++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const iv = setInterval(() => { timerCount++; }, 20);
    setTimeout(() => { clearInterval(iv); resolve(); }, 800);
  });
  return { label: ${JSON.stringify(label)}, hidden: document.hidden, visibilityState: document.visibilityState,
           rafCount, timerCount, elapsed: Math.round(performance.now() - t0) };
})()`;

(async () => {
  const target = await getTarget();
  // 先 bringToFront，尽量让页面可见
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  await new Promise((r) => setTimeout(r, 400));

  say(`CDP 目标：${target.title}`);
  say("");
  say("======== 第一次采样（bringToFront 之后）========");
  const r1 = await cdp.eval(measure("after-bringToFront"));
  say(JSON.stringify(r1, null, 2));
  say(`  判读：rafCount=${r1.rafCount} / timerCount=${r1.timerCount} / hidden=${r1.hidden}`);
  say(`  ⇒ rAF 是否推进：${r1.rafCount > 5 ? "✅ 推进（约 " + Math.round(r1.rafCount / (r1.elapsed / 1000)) + " fps）" : "❌ 停摆/几乎不跑"}`);

  say("");
  say("======== 第二次采样（Page.navigate 走后仍同页，再取一次）========");
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  const r2 = await cdp.eval(measure("second"));
  say(JSON.stringify(r2, null, 2));

  say("");
  say("======== 结论 ========");
  if (r1.rafCount <= 5 && r1.timerCount > 20) {
    say("⚠️ 页面 hidden 时 rAF 停摆但 setInterval 仍跑 ⇒ 依赖 rAF 的几何 done 判据在后台会整体失效。");
    say("   ⇒ 需要给 runGeometrySyncFade 增加不依赖 rAF 的兜底（setTimeout 收敛）。");
  } else if (r1.rafCount <= 5 && r1.timerCount <= 20) {
    say("⚠️ rAF 与 setInterval 都不跑 ⇒ 整个渲染进程被节流（Electron 后台节流）。");
    say("   ⇒ 兜底也无效，只能靠主进程侧或窗口可见性保障（同一时间只能等窗口可见）。");
  } else {
    say("✅ rAF 正常推进 ⇒ 几何 done 判据可靠；此前 _e2e-final 的残留另有原因。");
  }
  say("");
  say("完成。产物：" + OUT);
  cdp.ws.close();
})().catch((e) => { say("❌ 失败：" + e.message); process.exit(1); });
