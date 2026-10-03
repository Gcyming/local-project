/* eslint-disable */
/**
 * gui/scripts/probe-a1155-sequence.mjs —— 复现用户 A-1155 报的「切页引发布局错乱」序列。
 *
 * ## 用户原话（四张截图，2026-10-03）
 * ① 第一次点「窗口化悬浮窗」⇒ 右栏内容自适应失效（内容被压成一条窄带，右侧大片空）；
 * ② 此时点**其他新建页（切 tab）** ⇒ 界面部分恢复，但**左侧边栏只剩一点点**；
 * ③ 再切其他页 ⇒ 左栏恢复正常尺寸；
 * ④ 此时**展开左侧边栏 + 恢复窗口化** ⇒ 右栏部分位置**被挤压到屏幕外**。
 *
 * ## 为什么要序列化"切页"
 * 用户的 3 个现象**全部只在"切 tab"之后出现** ⇒ 嫌疑集中在"随 re-render 结算的宽度/类"。
 * 这个探针按原顺序走，**每一步都记录**：
 *   · `.body` 三个直属子元素（左栏 / main / 右栏 wrapper）的实测几何；
 *   · `body` 上的 `float-layout` 类（A-1152 的铺满开关）；
 *   · 右栏 wrapper 的**内联** width / flexShrink（`rightMin0` 驱动的那两条）；
 *   · 临时类（slime-fading / slime-resizing / slime-freezing）与 `--right-target-w` 残值。
 *
 * ## 判据（不看颜色，全几何/状态）
 * · P1 右栏内容自适应：`.right-body` 的宽 / `.right-sidebar` 的宽 ≈ 1（浮层态该铺满）；
 * · P2 左栏不该被压：`.sidebar` 宽 ≥ 240（除非它处于 collapsed）；
 * · P3 无残留：稳定态下临时类应全部为空、变量应已摘；
 * · P4 不越窗：所有盒子 `right ≤ vw + 1`、`left ≥ -1`。
 *
 * 用法：
 *   cd gui && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *     scripts/probe-a1155-sequence.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");
const { app, BrowserWindow } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── 隔离数据目录（必须在 app ready 前设好） ── */
const ROOT = path.join(os.tmpdir(), "slime-probe-a1155-root");
process.env.SLIME_ROOT = ROOT;
fs.mkdirSync(path.join(ROOT, "config"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
const WS = "D:\\pilot project";
const sessPath = path.join(ROOT, "config", "sessions.json");
/* ⚠️ `agentId` 必须是**真实存在**的 agents.json 里的 id —— 假 id 会让 App 选不出会话
   ⇒ ChatPanel 不挂载 ⇒ 「窗口化」按钮不存在 ⇒ 探针卡在启动门（实测踩过）。
   `createdAt` 用 ISO 字符串，与真实 `config/sessions.json` 的格式一致。 */
const AGENT_ID = "04de8e0a21a7";
const now = new Date().toISOString();
/* ⚠️ 一定要有**多条**会话：切 tab 需要至少两个可切的页，否则复现不出用户的现象。 */
fs.writeFileSync(sessPath, JSON.stringify({
  sessions: {
    s_probe_a: { id: "s_probe_a", agentId: AGENT_ID, workspace: WS, title: "探针会话A", createdAt: now, updatedAt: now },
    s_probe_b: { id: "s_probe_b", agentId: AGENT_ID, workspace: WS, title: "探针会话B", createdAt: now, updatedAt: now },
  },
}), "utf8");
fs.writeFileSync(path.join(ROOT, "config", "agents.json"), JSON.stringify([
  { id: AGENT_ID, name: "test1", model: "test", workspace: WS },
]), "utf8");

const GUI = path.join(__dirname, "..");
const PAGE = path.join(GUI, "out", "renderer", "index.html");
const OUT = path.join(GUI, "out", "_a1155-probe.txt");
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); };

/* ── 页面内状态采样器 ── */
const SNAP = `(() => {
  const r = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), l: Math.round(b.left), r: Math.round(b.right) }; };
  const bodyEl = document.querySelector(".body");
  const kids = bodyEl ? Array.from(bodyEl.children).map((el) => ({
    cls: (el.className || "").toString().slice(0, 40), ...r(el),
  })) : [];
  const wrap = document.querySelector(".right-wrapper");
  const rs = document.querySelector(".right-sidebar");
  const rb = document.querySelector(".right-body");
  const sb = document.querySelector(".sidebar");
  /* 稳定态判据用：临时类 / 过渡期变量是否还在 */
  const cls = document.body.className;
  const wrapInlineW = wrap ? (wrap.style.width || "(none)") : null;
  const wrapInlineShrink = wrap ? (wrap.style.flexShrink || "(none)") : null;
  const rsInlineW = rs ? (rs.style.width || "(none)") : null;
  const targetVar = wrap ? (wrap.style.getPropertyValue("--right-target-w") || "(none)") : null;
  const bodyVar = wrap ? (wrap.style.getPropertyValue("--right-body-pin") || "(none)") : null;
  return JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    bodyCls: cls,
    floatLayoutClass: document.body.classList.contains("float-layout"),
    kids,
    sidebar: r(sb), main: r(document.querySelector("main.main")),
    wrap: r(wrap), rightSidebar: r(rs), rightBody: r(rb),
    wrapInlineW, wrapInlineShrink, rsInlineW, targetVar, bodyVar,
    /* 越窗检测 */
    overflowRight: [rs, rb, wrap, sb].filter(Boolean)
      .map((el) => Math.round(el.getBoundingClientRect().right))
      .filter((v) => v > window.innerWidth + 1),
  });
})()`;

/* ── 真点击（走真实输入管线，与用户手动点一致） ── */
function mkClick(win) {
  return async (sel) => {
    const box = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) { return null; }
      const img = el.tagName === "IMG" ? el : null;
      const t = img ? (img.closest("button") || img.parentElement || el) : el;
      const b = t.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
    })()`);
    if (!box) { return false; }
    const { x, y } = JSON.parse(box);
    const wc = win.webContents;
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    return true;
  };
}

app.setPath("userData", path.join(ROOT, "userData"));
app.setPath("sessionData", path.join(ROOT, "userData"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1400, height: 820, x: 20, y: 20,
    webPreferences: {
      contextIsolation: true, sandbox: false, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true); win.moveTop(); win.focus();
  const ev = (js) => win.webContents.executeJavaScript(js);
  const click = mkClick(win);
  const snap = async (tag) => { say(`\n【${tag}】\n` + await ev(SNAP)); };

  await win.loadFile(PAGE);
  say("产物已加载，等启动门…");

  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const has = await ev(`!!document.querySelector('img[alt="唤起悬浮窗"]')`);
    if (has) { ready = true; say(`启动门已过（第 ${i + 1} 次轮询）`); break; }
    if (i === 6 || i === 20) {
      /* ⚠️ 卡门诊断：必须看清"缺哪一项"，不能只报"没等到"（否则只能猜）。 */
      const diag = await ev(`(() => {
        const q = (s) => !!document.querySelector(s);
        return JSON.stringify({
          splash: q('[class*="splash"]'),
          app: q('.app'), body: q('.body'), sidebar: q('.sidebar'),
          chatPanel: q('[class*="chat-panel"], .chat-panel'),
          rightSidebar: q('.right-sidebar'),
          sessionItems: document.querySelectorAll('[class*="session-item"], [class*="session-row"]').length,
          splashText: (document.querySelector('[class*="splash"]')?.textContent || "").slice(0, 260),
          bodyCls: document.body.className.slice(0, 120),
          sidebarText: (document.querySelector(".sidebar")?.textContent || "").slice(0, 200),
          sidebarHTML: (document.querySelector(".sidebar")?.innerHTML || "").slice(0, 700),
          rightHTML: (document.querySelector(".right-sidebar")?.innerHTML || "").slice(0, 400),
        });
      })()`);
      say(`  轮询 ${i + 1} 诊断：` + diag);
    }
  }
  if (!ready) { say("❌ 没等到「窗口化」按钮"); app.exit(1); return; }

  /* ⚠️⚠️ 必须置前：窗口被遮挡时 document.hidden=true ⇒ rAF 停摆 ⇒ 几何过渡永远不结算
     ⇒ 本探针的"稳定态判据"会全错（A-1154 踩过：见 ref-engineering 的 CDP 段）。 */
  try { win.show(); win.moveTop(); win.focus(); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  await snap("S0 初始（未点窗口化）");

  /* ── 现象①：点窗口化 ── */
  say("\n—— ① 点「窗口化悬浮窗」按钮 ——");
  say("点击=" + (await click('img[alt="唤起悬浮窗"]')));
  await new Promise((r) => setTimeout(r, 2200));
  await snap("S1 点窗口化后（+2.2s）");

  /* ── 现象②：切到另一个 tab ── */
  say("\n—— ② 切到另一个页（模拟用户点新建页/其他 tab） ——");
  const tabs = await ev(`(() => {
    const list = Array.from(document.querySelectorAll('.tab, .tabs > *, [class*="tab-item"]'))
      .filter((e) => e.getBoundingClientRect().width > 20);
    return JSON.stringify(list.slice(0, 6).map((e) => (e.textContent || "").trim().slice(0, 12)));
  })()`);
  say("可见 tab 列表：" + tabs);
  say("点击第 2 个 tab=" + (await click('.tab:nth-of-type(2), .tabs > *:nth-of-type(2)')));
  await new Promise((r) => setTimeout(r, 1400));
  await snap("S2 切页后（+1.4s）");

  /* ── 现象③：再切一次 ── */
  say("\n—— ③ 再切一次页 ——");
  say("点击第 1 个 tab=" + (await click('.tab:nth-of-type(1), .tabs > *:nth-of-type(1)')));
  await new Promise((r) => setTimeout(r, 1400));
  await snap("S3 再切页后（+1.4s）");

  /* ── 现象④：展开左栏 + 恢复窗口化 ── */
  say("\n—— ④a 展开左侧边栏 ——");
  const sbBtn = await ev(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /侧栏|侧边栏/.test(x.title || ""));
    return b ? b.title : "(not found)";
  })()`);
  say("左栏按钮 title=" + sbBtn);
  say("点击左栏按钮=" + (await click('button[title*="侧栏"]')));
  await new Promise((r) => setTimeout(r, 1600));
  await snap("S4 展开左栏后（+1.6s）");

  say("\n—— ④b 恢复窗口化（取消悬浮窗） ——");
  say("点击=" + (await click('img[alt="唤起悬浮窗"]')));
  await new Promise((r) => setTimeout(r, 2400));
  await snap("S5 恢复窗口化后（+2.4s）");

  /* ── 收尾：再等一会，看有没有"迟到的结算"把布局改坏 ── */
  await new Promise((r) => setTimeout(r, 1600));
  await snap("S6 再等 1.6s（稳态）");

  say("\n=== 完成 ===");
  app.exit(0);
});
