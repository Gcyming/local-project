












































const PERF_LITE = false;


const MAX_MS = 8000;




const ANIM_WATCH = [
  ".app", ".titlebar", ".body", ".sidebar", ".main", ".chat-scroll", ".chat-panel",
  ".right-wrapper", ".right-sidebar", ".right-body", ".right-tabbar",
  ".float-window", ".inline-chat-host", ".float-inner",
];

const BOXES = [
  ["sb", ".sidebar"], ["main", ".main"], ["host", ".float-window, .inline-chat-host"],
  ["rw", ".right-wrapper"], ["rs", ".right-sidebar"], ["rb", ".right-body"],
  ["tab", ".right-tabbar"],
] as const;

const VARS = ["--right-target-w", "--right-body-pin", "--left-w", "--slime-freeze-w"];

type Row = (number | string | null)[];

let rows: Row[] = [];
let raf = 0;
let t0 = 0;
let armed = false;
let toast: HTMLDivElement | null = null;

function say(msg: string, bad = false): void {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText = [
    "position:fixed", "z-index:2147483647", "left:12px", "top:12px",
    "padding:8px 14px", "border-radius:8px", "font:13px/1.5 system-ui,monospace",
    "background:" + (bad ? "#7f1d1d" : "#14532d"), "color:#fff",
    "box-shadow:0 4px 16px rgba(0,0,0,.5)", "pointer-events:none", "white-space:pre",
  ].join(";");
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
  console.log("[float-trace] " + msg);
}



function animators(): string {
  const out: string[] = [];
  for (const sel of ANIM_WATCH) {
    const nodes = document.querySelectorAll(sel);
    for (let i = 0; i < nodes.length && i < 4; i++) {
      const n = nodes[i] as HTMLElement;
      const cs = getComputedStyle(n);
      const td = cs.transitionDuration || "";
      const hasT = td.split(",").some((v) => parseFloat(v) > 0);
      const an = cs.animationName || "none";
      const hasA = an !== "none" && an !== "";
      if (hasT || hasA) {
        out.push(sel.replace(/[^\w.]/g, "") + "#" + i + (hasT ? "{t:" + td.trim() + "}" : "") + (hasA ? "{a:" + an + "}" : ""));
      }
    }
  }
  return out.join(" ") || "-";
}

function sample(): void {
  const now = performance.now();
  const t = Math.round(now - t0);
  const row: Row = [t];

  for (const [, sel] of BOXES) {
    const e = document.querySelector(sel);
    if (!e) { row.push(null, null); continue; }
    const r = e.getBoundingClientRect();
    row.push(Math.round(r.left), Math.round(r.width));
  }

  const host = document.querySelector(".float-window, .inline-chat-host");
  row.push(host ? Math.round(Number(getComputedStyle(host).opacity) * 100) : null);
  if (!PERF_LITE && host) {
    const cs = getComputedStyle(host);
    row.push(cs.transform === "none" ? "-" : cs.transform.slice(0, 40));
    row.push(cs.transitionProperty.slice(0, 40), cs.transitionDuration);
  } else { row.push("-", "-", "-"); }

  
  const cs2 = document.querySelector<HTMLElement>(".chat-scroll");
  if (cs2) {
    row.push(Math.round(cs2.clientWidth), cs2.offsetWidth - cs2.clientWidth,
      cs2.scrollHeight > cs2.clientHeight ? 1 : 0, Math.round(cs2.scrollTop));
  } else { row.push(null, null, null, null); }

  
  let hole = "no-host";
  if (host) {
    const r = host.getBoundingClientRect();
    const top = r.width > 4 && r.height > 4
      ? document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      : null;
    hole = !top ? "zero-rect"
      : top.closest(".float-window") ? "FLOATWIN"
      : "HOLE:" + top.tagName.toLowerCase() + (typeof top.className === "string" && top.className.trim()
        ? "." + top.className.trim().split(/\s+/)[0] : "");
  }
  row.push(hole);

  row.push(document.body.className || "-");
  const bw = document.body;
  row.push(...VARS.map((v) => bw.style.getPropertyValue(v).trim() || "-"));
  row.push(animators());

  










  {
    const sbEl = document.querySelector<HTMLElement>(".sidebar");
    if (!sbEl) { row.push("-", "-", "-", "-", "-", "-", "-"); }
    else {
      const cs = getComputedStyle(sbEl);
      row.push(
        sbEl.className || "-",
        (sbEl.getAttribute("style") || "-").slice(0, 120),
        cs.flexShrink, cs.flexGrow, cs.flexBasis,
        cs.width, cs.minWidth,
      );
    }
    const bd = document.querySelector<HTMLElement>(".body");
    row.push(bd ? bd.scrollWidth : null, bd ? bd.clientWidth : null);
  }

  rows.push(row);
}

function step(): void {
  if (!armed) { return; }
  if (performance.now() - t0 > MAX_MS) { stop("录制满 8 秒，自动收工"); return; }
  sample();
  raf = requestAnimationFrame(step);
}




function reversals(key: string, col: number): string[] {
  const vals = rows.map((r) => r[col]).filter((v): v is number => typeof v === "number");
  const rev: string[] = [];
  for (let i = 2; i < vals.length; i++) {
    const d1 = vals[i - 1] - vals[i - 2], d2 = vals[i] - vals[i - 1];
    if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) {
      rev.push(rows[i][0] + "ms " + key + " " + vals[i - 2] + "→" + vals[i - 1] + "→" + vals[i]);
    }
  }
  return rev;
}

function buildSummary(): string {
  const L: string[] = [];
  L.push("=== A-1165 窗口化自检录制 ===");
  L.push("帧数 " + rows.length + " · 窗口 " + window.innerWidth + "×" + window.innerHeight
    + " · dpr " + window.devicePixelRatio + " · 跨度 " + (rows.length ? rows[rows.length - 1][0] : 0) + "ms");
  const dts: number[] = [];
  for (let i = 1; i < rows.length; i++) { dts.push((rows[i][0] as number) - (rows[i - 1][0] as number)); }
  if (dts.length) {
    const s = [...dts].sort((a, b) => a - b);
    L.push("帧间隔 p50=" + s[Math.floor(s.length * 0.5)] + " p95=" + s[Math.floor(s.length * 0.95)]
      + " max=" + s[s.length - 1] + "ms · >32ms 的慢帧 " + dts.filter((d) => d > 32).length + " 个");
  }
  const NAMES = BOXES.map(([k]) => k);
  let totalRev = 0;
  NAMES.forEach((k, i) => {
    const r = reversals(k + ".left", 1 + i * 2), r2 = reversals(k + ".width", 2 + i * 2);
    totalRev += r.length + r2.length;
    if (r.length || r2.length) { L.push("  ⚠️ " + k + " 反转 " + (r.length + r2.length) + " 次"); }
  });
  L.push(totalRev ? "⇒ 共 " + totalRev + " 次方向反转（**这就是抖动的定义性特征**）" : "⇒ 无方向反转（各栏几何单调）");

  const holes = rows.filter((r) => typeof r[23] === "string" && r[23].startsWith("HOLE:"));
  const holeCol = 1 + BOXES.length * 2 + 1 + 3 + 4;
  const holes2 = rows.filter((r) => typeof r[holeCol] === "string" && r[holeCol].startsWith("HOLE:"));
  L.push("浮窗中心点：" + (holes2.length ? "⚠️ 有 " + holes2.length + "/" + rows.length
    + " 帧**没画出来**（空洞）⇒ 取值 " + JSON.stringify([...new Set(holes2.map((r) => r[holeCol]))].slice(0, 5))
    : "✓ 全程都在屏幕上"));
  void holes;

  const animIdx = holeCol + 1 + 1 + VARS.length;
  const uniq = [...new Set(rows.map((r) => r[animIdx]))].filter((v) => v && v !== "-");
  L.push("正在跑动画的元素（" + uniq.length + " 种）：");
  for (const u of uniq.slice(0, 12)) {
    const cnt = rows.filter((r) => r[animIdx] === u).length;
    L.push("  · " + u + "  —— " + cnt + " 帧");
  }

  const op = 1 + BOXES.length * 2;
  const opVals = [...new Set(rows.map((r) => r[op]))];
  L.push("浮窗 opacity 取值：" + JSON.stringify(opVals.slice(0, 12)));
  const bodyCls = [...new Set(rows.map((r) => r[holeCol + 1]))];
  L.push("body.className 取值：" + JSON.stringify(bodyCls));

  

  const sbBase = 1 + BOXES.length * 2 + 1 + 3 + 4 + 1 + 1 + VARS.length + 1;
  const cls = new Map<string, number>();
  const inl = new Map<string, number>();
  for (const r of rows) {
    cls.set(r[sbBase] as string, (cls.get(r[sbBase] as string) ?? 0) + 1);
    inl.set(r[sbBase + 1] as string, (inl.get(r[sbBase + 1] as string) ?? 0) + 1);
  }
  L.push("左栏 className 取值：" + JSON.stringify([...cls.entries()]));
  L.push("左栏 内联style 取值：" + JSON.stringify([...inl.entries()].map(([k, n]) => [k.slice(0, 70), n])));
  L.push("左栏 flexShrink/basis/width 取值：" + JSON.stringify([
    ...new Set(rows.map((r) => [r[sbBase + 2], r[sbBase + 4], r[sbBase + 5]]).map((x) => x.join("/"))),
  ].slice(0, 10)));
  L.push(".body scrollW/clientW 取值：" + JSON.stringify([...new Set(rows.map((r) => r[sbBase + 7] + "/" + r[sbBase + 8]))].slice(0, 10)));
  L.push("（完整逐帧原始数据在同目录下载的 JSON 里）");
  return L.join("\n");
}

function stop(reason = "手动收工"): void {
  if (!armed) { say("当前没有在录制", true); return; }
  armed = false;
  cancelAnimationFrame(raf);
  const summary = buildSummary();
  console.log("[float-trace]\n" + summary);
  say("录制结束（" + reason + "），" + rows.length + " 帧");
  rows.slice(0, 1).forEach(() => {  });

  
  try {
    const payload = JSON.stringify({
      note: "A-1165 float-trace",
      window: [window.innerWidth, window.innerHeight, window.devicePixelRatio],
      boxes: BOXES.map(([k]) => k), vars: VARS,
      cols: ["t", ...BOXES.flatMap(([k]) => [k + ".left", k + ".width"]),
        "host.opacity%", "host.transform", "host.transitionProp", "host.transitionDur",
        "chat.clientW", "chat.gutter", "chat.overflow", "chat.scrollTop",
        "holeAtHostCenter", "body.className", ...VARS, "animators",
        "sb.className", "sb.inlineStyle", "sb.flexShrink", "sb.flexGrow", "sb.flexBasis",
        "sb.width", "sb.minWidth", "body.scrollW", "body.clientW"],
      rows,
    });
    const blob = new Blob([payload], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = "float-trace-" + ts + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) {
    console.error("[float-trace] 导出失败", e);
  }

  
  try {
    void navigator.clipboard?.writeText(summary);
    say("摘要已复制到剪贴板，原始 JSON 已下载");
  } catch {
    say("已导出；摘要见 DevTools 控制台", true);
  }
  rows = [];
}

function arm(): void {
  if (armed) { say("已经在录制了"); return; }
  rows = [];
  t0 = performance.now();
  armed = true;
  say("● 开始录制 —— 现在去点一次「窗口化」，8 秒后自动收工");
  raf = requestAnimationFrame(step);
}


export function installFloatTrace(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (!e.ctrlKey || !e.shiftKey) { return; }
    const k = (e.key || "").toLowerCase();
    if (k !== "d") { return; }
    e.preventDefault();
    if (armed) { stop(); } else { arm(); }
  };
  window.addEventListener("keydown", onKey, true);
  (window as unknown as Record<string, unknown>).__floatTrace = {
    arm, stop,
    state: () => (armed ? "recording" : "idle"),
    rows: () => rows,
  };
  void toast;
  return () => { window.removeEventListener("keydown", onKey, true); };
}

export default installFloatTrace;