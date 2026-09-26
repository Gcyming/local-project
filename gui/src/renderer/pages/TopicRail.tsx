/**
 * gui/src/renderer/pages/TopicRail.tsx — 目录卷轴：对话页 / md 文档共用的**滚动条替代品**（A-1115）。
 *
 * 用户点名的设计（原话要点）：
 *   - 两根**深浅不同**的线交织、持续微微荡漾；波长不同 ⇒ 交点沿轴游走（是「交织」不是对称透镜）；
 *   - 鼠标处 **隆起向左**，上下两肩 **向右凹**（衬托），随距离平滑回到常态；
 *   - 鼠标处**荡漾暂停**（相位冻住不跳变）；
 *   - 上下端部 **渐隐变浅 + 两线收束、波形趋近直线**（⚠️ 只趋近，不能真的成直线）；
 *   - md 文档**只保留刻度尺**，鼠标处那条**变长向左突起**（不做凹陷）。
 *
 * 三条不变量（改这个文件前先读，都是踩过的坑）：
 *   ① **同一图形的所有描边必须共用同一个形状函数** —— 给发光层换个形状 = 多画一对线
 *      （用户原话「虚化出了另外两条浅色的线」）；
 *   ② **清屏与绘制都必须用画布总宽 `CW`**，不是卷轴宽 `W` —— 画布比卷轴宽，只清 W
 *      会让加宽出来那截永远清不掉、逐帧往上叠 ⇒ **糊成一坨**；
 *   ③ **指针移动不产生任何 React 状态**：位置只写 ref，只有「最近条目序号变了」才碰 DOM。
 *      卷轴是逐帧 canvas，走 setState 等于每帧一次 diff。
 *
 * 「两根线」还要求：常态振幅必须**大于**两条描边的覆盖宽度（含抗锯齿每边约 1px），
 * 否则两线全程糊成一条 —— 那时用户看到的"明暗区分变小"其实是**根本没有两根线**。
 */
import * as React from "react";
import type { RailParams } from "./railParams";
import { tickPositions } from "./railParams";

/** 卷轴左/右侧留给"衬托伸出卷轴外"的余量（px）。
 *  ⚠️ 与宿主的 `padding-right`、本组件的 `RAIL_INSET` 是**成对**的，改一个要一起改：
 *  左侧余量 = 宿主右侧内边距 − RAIL_INSET − 卷轴宽；右侧余量 = RAIL_INSET。 */
const LEFT_ROOM = 12;
const RIGHT_ROOM = 6;
/** 卷轴本体离宿主右缘的距离（右侧余量就是它） */
const RAIL_INSET = 6;

/** 用户在系统里开了「减弱动效」时：停漂移，只保留响应式的衬托（它是对输入的响应，不是装饰）。 */
const reduceMotion = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
  : false;

export interface RailEntry {
  /** 条目在**内容坐标**里的顶部（px） */
  top: number;
  /** 气泡里显示的短标题 */
  label: string;
  /** md 用：h1/h2/h3 决定刻度基础长度 */
  level?: "h1" | "h2" | "h3";
}

export interface TopicRailProps {
  /** 被测量 / 被滚动的容器（惰性取，宿主切换时也能拿到最新的） */
  scroller: () => HTMLElement | null;
  /** 收集条目；**每次测量时调用**（不经过 props diff，避免滚动时 React 重渲染） */
  collect?: () => RailEntry[];
  /** wave = 双线交织水波（对话页）· ticks = 只留刻度尺（md 文档） */
  mode?: "wave" | "ticks";
  params: RailParams;
  /** 测试用：暴露内部状态读取口（不影响渲染） */
  onProbe?: (info: string) => void;
}

export default function TopicRail(props: TopicRailProps): React.JSX.Element {
  const { scroller, collect, mode = "wave", params, onProbe } = props;
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const cvRef = React.useRef<HTMLCanvasElement | null>(null);
  const hitRef = React.useRef<HTMLDivElement | null>(null);
  const tipRef = React.useRef<HTMLDivElement | null>(null);
  const tipTxtRef = React.useRef<HTMLSpanElement | null>(null);
  const tipOrdRef = React.useRef<HTMLSpanElement | null>(null);

  /* 参数与回调走 ref：设置页改参数后**即时**生效，而**不重挂**卷轴（重挂会丢相位/闪烁） */
  const pRef = React.useRef(params);
  pRef.current = params;
  const collectRef = React.useRef(collect);
  collectRef.current = collect;
  const scrollerRef = React.useRef(scroller);
  scrollerRef.current = scroller;
  const probeRef = React.useRef(onProbe);
  probeRef.current = onProbe;

  React.useEffect(() => {
    /* ⚠️ 显式声明成非空类型再往下用：`function` 声明会被提升，TS **不会**把外层
       `if (!x) return` 的收窄保留到它内部（TS18047）。写成 `const x: T = cur` 就没有"收窄"这回事了。 */
    const curHost = hostRef.current;
    if (!curHost) { return; }
    const host: HTMLDivElement = curHost;
    const curCv = cvRef.current;
    if (!curCv) { return; }
    const cv: HTMLCanvasElement = curCv;
    const curHit = hitRef.current;
    if (!curHit) { return; }
    const hit: HTMLDivElement = curHit;
    const curTip = tipRef.current;
    if (!curTip) { return; }
    const tip: HTMLDivElement = curTip;
    const curTxt = tipTxtRef.current;
    if (!curTxt) { return; }
    const tipTxt: HTMLSpanElement = curTxt;
    const curOrd = tipOrdRef.current;
    if (!curOrd) { return; }
    const tipOrd: HTMLSpanElement = curOrd;
    const curCtx = cv.getContext("2d");
    if (!curCtx) { return; }
    const ctx: CanvasRenderingContext2D = curCtx;

    const withTicks = mode === "ticks";
    /* ⚠️⚠️ **循环终结令牌**（A-1118，本文件最贵的一课，改这个文件前必读）：
     *
     * 症状（用户实例取证）：「md 编辑页只有**滚动时 / 鼠标放上去**才变成刻度，其余时间都是波形」。
     * 用户的直觉是「代码混淆了」—— 方向对（刻度画布上确实跑着波形的代码），但**不是写错了分支**：
     * `draw()` 里 `if (!withTicks)` / `if (withTicks)` 两个块互斥且判据正确，
     * 错的是**同一张 canvas 上有两个 effect 实例的 rAF 循环在同时跑**，而 wave 那个每帧后画、把刻度盖掉。
     *
     * 为什么 cleanup 没能终结它：
     *   ① `return () => { R.running = false; }` 只能阻止**下一次** `ensureLoop()`；
     *      而此刻已经 `requestAnimationFrame` 排队中的那一帧**照样会执行**；
     *   ② `frame()` 里**没有任何「我这个实例是否已经废弃」的检查** ⇒ 它执行到底、又排下一帧 ⇒ 循环续命；
     *   ③ wave 模式的停止判据 `idle` 里含 `p.spd === 0`，而 spd 默认 1 ⇒ **idle 恒为 false ⇒ 永不停止**。
     * 三条叠起来：每次 mode 切换（设置页切「对话页 / md 文档」）都**永久泄漏一个 60fps 绘制循环**。
     * 实测（CDP 数 rAF 回调实例，A-1118）：界面上只有 **2** 个卷轴，却活着 **6** 个循环，
     * 全部来自本文件的 `frame()`；其中 ticks 那张 canvas 每帧被画 **2** 遍。
     *
     * 为什么表现为「悬停 / 滚动时才正常」：僵尸 wave 循环是**常驻**的，ticks 循环只在悬停 / 滚动时被
     * `ensureLoop()` 唤醒。rAF 回调按**注册顺序**执行 ⇒ 后注册的 ticks 循环后画 ⇒ 悬停时刻度覆盖波形；
     * 一旦 ticks 循环按 `idle` 停帧，屏幕上就只剩僵尸波形 —— 正是用户看到的两态。
     *
     * 修法：一个闭包级 `alive` 令牌，`frame()` **入口**检查它。这样任何已排队的回调都会当场退出、
     * 且不再续命 —— 与 `R.running`（只管"要不要启动新循环"）是两件事，缺一不可。
     * ⇒ 顺带治好 `React.StrictMode` 双挂载留下的那个永久循环（本仓 `index.tsx` 开着 StrictMode）。
     */
    let alive = true;
    /* 状态全部在这里（闭包），**不进 React** */
    let dragU = 0;
    const R = {
      W: 12, H: 400, CW: 12, OX: 0, dpr: 1, PAD: 3, TAP: 0, EFLOOR: 0.12,
      TOP: 0, BOT: 0, maxScroll: 1, scrollH: 1,
      ticks: [] as Array<{ u: number; s: number; label: string; lvl: string; i: number }>,
      ptr: { uc: 0, target: 0, strength: 0, active: false, nearest: -1 },
      /** 滚动驱动的"当前条目位置"（阻尼，与鼠标态 `ptr.uc` 同族；-1 = 尚未定过） */
      curU: -1, curUt: -1,
      dragging: false,
      running: false, lastT: 0, visible: false,
      driftT: 0, driftPhase: 0, scrollPhase: 0,
    };

    /* ── 几何 ─────────────────────────────────────────────────────────── */
    function band(): { l: number; r: number; cx: number; maxAmp: number; baseAmp: number } {
      // 坐标原点 = **画布左上角**；卷轴本体占 x ∈ [OX, OX+W]
      const p = pRef.current;
      const r = R.OX + R.W * (withTicks ? 0.76 : 0.88);
      const l = R.OX + 1.2;
      const maxAmp = Math.max(0.6, (r - l) / 2);
      return { l, r, cx: (l + r) / 2, maxAmp, baseAmp: maxAmp * (p.amp / 100) };
    }
    /** 端部过渡系数（0..1）：离上/下端点 `TAP` 之内由 `floor` 平滑升到 1。
     *  **两个端部效果共用它**：alpha 乘它 = 渐隐变浅；振荡幅度乘它 = 两线收束、趋近直线。
     *  ⚠️ 下界不是 0：真给 0 端点就成了一段**精确直线**，反而成了"看得见的另一种形状"。 */
    function spanTaper(y: number, top: number, bot: number, floor?: number): number {
      const fl = floor === undefined ? R.EFLOOR : floor;
      const e = Math.min(y - top, bot - y);
      const s = R.TAP > 0 ? Math.min(1, Math.max(0, e / R.TAP)) : 1;
      return fl + (1 - fl) * (s * s * (3 - 2 * s));
    }
    function taper(y: number): number { return spanTaper(y, 0, R.H); }

    /** 一条线沿 y 的描边样式（**唯一出处**）：同时编码「已读/未读亮度差」与「两端渐隐」。
     *  ⚠️ 不要用"分段叠两次描边"去拼这两件事 —— 分段会在交界留下可见色块边。 */
    function lineStyle(cr: string, aLit: number, aDim: number, puC: number): CanvasGradient {
      const Hb = R.H, blend = Math.max(14, Hb * 0.07);
      const stops = [0, R.TAP, puC - blend, puC + blend, Hb - R.TAP, Hb].sort((x, y) => x - y);
      const g = ctx!.createLinearGradient(0, 0, 0, Hb);
      const seen: Record<string, 1> = {};
      for (const sRaw of stops) {
        const y = Math.max(0, Math.min(Hb, sRaw));
        const k = y.toFixed(2);
        if (seen[k]) { continue; }
        seen[k] = 1;
        let a: number;
        if (y <= puC - blend) { a = aLit; }
        else if (y >= puC + blend) { a = aDim; }
        else { a = aLit + (aDim - aLit) * ((y - (puC - blend)) / (2 * blend)); }
        g.addColorStop(y / Hb, `rgba(${cr},${Math.max(0, a * taper(y)).toFixed(3)})`);
      }
      return g;
    }

    /** 双极位移轮廓：`h(0)=Bp`（向左隆起）、`h(±√T)=−Dp`（两肩向右凹），两者**各自独立**。
     *  ⚠️ 中间那项 `Bp·e^(−T/2)` 必须显式减掉：隆起曲线在凹陷处还残留约 0.26·Bp，
     *  不补掉会把凹陷吃掉一大半（症状：隆起越大、凹陷越看不出来）。 */
    function shapeAt(u: number): { sep: number; push: number; cx: number; maxAmp: number } {
      const p = pRef.current, B = band(), st = R.ptr.strength;
      const maxAmp = B.maxAmp;
      const t = (u - R.ptr.uc) / Math.max(1, p.sig);
      const at = Math.abs(t);
      const a = p.a, b = a + Math.max(1.4, a * 0.7);
      const win = at <= a ? 1 : (at >= b ? 0 : 0.5 * (1 + Math.cos((Math.PI * (at - a)) / (b - a))));
      const wOsc = Math.min(1, p.k * st * win);
      const T = 2.7;
      const Bp = p.bulge / 100, Dp = p.dip / 100;
      const bump = Math.exp(-(t * t) / 2);
      const dipTerm = ((t * t) / T) * Math.exp(1 - (t * t) / T);
      const h = Bp * bump - (Dp + Bp * Math.exp(-T / 2)) * dipTerm;
      const dir = p.flip ? -1 : 1;
      let push = -dir * maxAmp * st * h;
      // 夹紧：左边不设限（画布已向左留了余量），右边必须停（撞的是卷轴右缘 / 刻度）
      const lo = 1.4 - B.cx, hi = R.CW - 2.0 - B.cx;
      if (push < lo) { push = lo; }
      if (push > hi) { push = hi; }
      return { sep: B.baseAmp * (1 - wOsc) * taper(u), push, cx: B.cx, maxAmp };
    }

    function layout(): void {
      /* 同 `frame()` 的挡板：`ResizeObserver` / window resize 在 cleanup 之后仍可能投递一次已排队的
         回调，那时 `measure()` 会写 aria 属性、`draw()` 会按**本实例的 mode** 画一整帧盖掉新实例。
         `disconnect()` 理论上会清掉 pending，但这条防线只花一个判断，不依赖实现细节。 */
      if (!alive) { return; }
      const p = pRef.current;
      const sc = scrollerRef.current();
      R.W = p.w;
      host.style.width = R.W + "px";
      host.style.right = RAIL_INSET + "px";
      R.OX = LEFT_ROOM;
      R.CW = R.OX + R.W + RIGHT_ROOM;
      const rect = host.getBoundingClientRect();
      R.H = Math.max(1, Math.round(rect.height));
      R.visible = rect.height > 4 && rect.width > 2;
      R.dpr = Math.min(3, window.devicePixelRatio || 1);
      cv.width = Math.round(R.CW * R.dpr);
      cv.height = Math.round(R.H * R.dpr);
      cv.style.width = R.CW + "px";
      cv.style.height = R.H + "px";
      cv.style.left = -R.OX + "px";
      ctx!.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
      R.TAP = Math.max(0, Math.min(p.tap, R.H * 0.4));
      R.EFLOOR = p.efloor;
      R.TOP = R.H / 6;
      R.BOT = (R.H * 5) / 6;
      if (!R.ptr.uc || R.ptr.uc > R.H) { R.ptr.uc = R.H / 2; R.ptr.target = R.H / 2; }
      // 内容尺寸也可能同时变了，一并重测（sc 可能是 null，那时只做几何）
      measure(sc);
      draw(performance.now());
    }

    /** 条目 → 刻度。位置**均匀等距**铺满中间 2/3（条目少自然疏、多自然密）；
     *  ⚠️ `u`（显示位置）与 `s`（点击目标）是两个量：等距可读，点击取 min(top, maxScroll) 才动作正确。 */
    function measure(sc: HTMLElement | null): void {
      const c = collectRef.current;
      if (sc) {
        R.maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
        R.scrollH = Math.max(1, sc.scrollHeight);
      }
      const list = c ? c() : [];
      // 位置用**唯一出处**的纯函数算（等距铺满中间 2/3）——见 railParams.ts::tickPositions
      const us = tickPositions(list.length, R.TOP, R.BOT);
      R.ticks = list.map((e, i) => ({
        u: us[i],
        s: Math.min(Math.max(0, e.top), R.maxScroll),
        label: e.label,
        lvl: e.level || "h2",
        i,
      }));
      hit!.setAttribute("aria-valuemax", String(R.ticks.length));
      /* 条目清空（md 关了 / 换了一份没标题的文档）⇒ 滚动位置归位，否则下一次会从旧位置滑过来。
         ⚠️ 条目**换了但非空**时刻意**不**重定位：`curU` 仍落在 [TOP,BOT] 内 ⇒ 让它滑过去更自然。 */
      if (R.ticks.length === 0) { R.curU = -1; R.curUt = -1; }
      if (probeRef.current && R.visible) {
        probeRef.current(`卷轴 ${R.W}×${R.H} · 画布 ${cv!.width}×${cv!.height} · 条目 ${R.ticks.length}`
          + ` · 刻度 y=${R.ticks.map((t) => Math.round(t.u)).join(",")}`);
      }
    }

    function sFromU(u: number): number {
      const f = (u - R.TOP) / Math.max(1, R.BOT - R.TOP);
      return Math.min(R.maxScroll, Math.max(0, f * R.maxScroll));
    }
    function jump(t: { s: number }): void {
      const sc = scrollerRef.current();
      if (sc) { sc.scrollTo({ top: t.s, behavior: reduceMotion ? "auto" : "smooth" }); }
    }
    function pointerU(e: PointerEvent): number {
      const r = host!.getBoundingClientRect();
      return Math.min(R.H, Math.max(0, e.clientY - r.top));
    }
    function nearest(u: number): number {
      if (!R.ticks.length) { return -1; }
      let best = 0, bd = Infinity;
      for (let i = 0; i < R.ticks.length; i++) {
        const d = Math.abs(R.ticks[i].u - u);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    function positionTip(u: number): void {
      const half = 16;
      tip!.style.transform = `translate3d(0,${(Math.min(R.H - half, Math.max(half, u)) - half).toFixed(1)}px,0)`;
    }
    /** 悬停：位置只写 ref；**只有最近条目序号变化**才碰 DOM */
    function onHover(u: number): void {
      R.ptr.target = u;
      const n = nearest(u);
      if (n !== R.ptr.nearest) {
        R.ptr.nearest = n;
        const t = R.ticks[n];
        if (t) {
          tipTxt!.textContent = t.label;
          tipOrd!.textContent = `${n + 1} / ${R.ticks.length}`;
          hit!.setAttribute("aria-valuenow", String(n + 1));
          hit!.setAttribute("aria-valuetext", t.label);
          tip!.classList.add("on");
        }
      }
      if (R.ptr.nearest >= 0) { positionTip(u); }
    }

    function ensureLoop(): void {
      /* `!alive` ⇒ 本 effect 实例已废弃（HMR / 切 mode / StrictMode 重挂）：不许再启动新循环。 */
      if (!alive || R.running || !R.visible) { return; }
      R.running = true; R.lastT = 0; requestAnimationFrame(frame);
    }

    function strokeWave(uFrom: number, uTo: number, lam: number, phi: number,
                        width: number, style: string | CanvasGradient, key: number): void {
      const N = Math.max(2, Math.ceil((uTo - uFrom) / 2));
      ctx!.beginPath();
      for (let k = 0; k <= N; k++) {
        const u = uFrom + ((uTo - uFrom) * k) / N;
        const sh = shapeAt(u);
        const x = sh.cx + sh.push + sh.sep * key * Math.sin((Math.PI * 2 * u) / lam + phi + R.driftPhase + R.scrollPhase);
        if (k === 0) { ctx!.moveTo(x, u); } else { ctx!.lineTo(x, u); }
      }
      ctx!.lineWidth = width; ctx!.strokeStyle = style; ctx!.lineCap = "round"; ctx!.stroke();
    }

    function draw(tms: number): void {
      const W = R.W, H = R.H;
      ctx!.clearRect(0, 0, R.CW, H);   // ⚠️ 必须用 CW（画布总宽）
      const sc = scrollerRef.current();
      const s = sc ? sc.scrollTop : 0;
      R.scrollPhase = s * 0.0105;
      const pu = R.PAD + (s / R.maxScroll) * Math.max(1, H - R.PAD * 2);

      if (!withTicks) {
        const p = pRef.current;
        const puC = p.read ? Math.min(H, Math.max(0, pu)) : H;
        for (let i = 0; i < 2; i++) {
          const lam = i ? p.lam1 : p.lam0, phi = i ? Math.PI : 0, key = i ? -1 : 1;
          const wMain = i ? W * 0.095 : W * 0.13;
          const cr = i ? "59,130,246" : "191,219,254";
          const aLit = i ? 0.52 : 0.97, aDim = i ? 0.34 : 0.62, aGlow = i ? 0.13 : 0.10;
          strokeWave(0, H, lam, phi, wMain, lineStyle(cr, aLit, aDim, puC), key);
          strokeWave(0, H, lam, phi, wMain * (i ? 2.0 : 1.5), lineStyle(cr, aGlow, aGlow, H), key);
        }
      }

      if (withTicks) {
        const p = pRef.current;
        // 刻度突起的影响范围**比波形窄**：波形过渡带必须够宽才能压住凹陷尾巴与振荡的衔接
        const tA = 1.5, tB = 3.2;
        const bump = (dist: number): number => {
          const ad = dist / Math.max(1, p.sig);
          return ad <= tA ? 1 : (ad >= tB ? 0 : 0.5 * (1 + Math.cos((Math.PI * (ad - tA)) / (tB - tA))));
        };
        /* A-1117③：**按当前滚动位置**找出对应条目 ⇒ 那条刻度也隆起（用户：「翻到对应位置，刻度线要隆起有反应」）。
           · 判据用 `s`（滚到该条目所需的目标 scrollTop）而**不是** `u` —— 刻度是**等距**铺的，`u` 与内容位置无关，
             拿 `u` 去比会得到"永远是中间那条亮"。
           · 权重取鼠标态的 **0.62**：滚动是"背景态"，不该比鼠标悬停更抢眼。
           · 与鼠标态取 **max 而不是相加** —— 相加会让"鼠标正好停在当前条目上"时突然翻倍，看着像跳了一下。
           · ⚠️⚠️ 位置由 `frame()` 里**阻尼**推进（`R.curU ← R.curUt`），这里只读 ——
             与鼠标态同一套手法，滚动时是平滑滑过去、停下后正好一条满亮。 */
        const n = R.ticks.length;
        /* ⚠️⚠️ 衰减必须**按刻度间距归一**，不能按绝对像素 `sig`（A-1117 实测修掉的真缺陷）：
           刻度是**等距按条数**铺的，`sig` 是固定的 13px ⇒ 条目一多，间距就小于衰减宽度，
           相邻刻度也被点亮。实测（H=600）：n=16 时邻刻度权重 0.76、n=20 时 **0.99**、n=30 时 1.00
           ⇒ 长文档"翻到对应位置"会亮 3~5 条且几乎一样亮，**看不出是哪条** ——
           正好把用户要的"有反应"变成"没反应"。
           判据：本单位下 **1.0 处必须衰减到 0** ⇒ 停下时只有一条满亮；相邻那条只在滑动**过程中**半亮。 */
        const spacing = n > 1 ? (R.BOT - R.TOP) / (n - 1) : Math.max(1, R.BOT - R.TOP);
        const pA = 0.25, pB = 1.0;
        const profBump = (ad: number): number =>
          ad <= pA ? 1 : (ad >= pB ? 0 : 0.5 * (1 + Math.cos((Math.PI * (ad - pA)) / (pB - pA))));
        for (const tk of R.ticks) {
          const profCur = R.curU < 0 ? 0 : 0.62 * profBump(Math.abs(tk.u - R.curU) / spacing);
          const qw = Math.max(bump(Math.abs(tk.u - R.ptr.uc)) * R.ptr.strength, profCur);
          // 端部渐隐下界抬到 0.35：等距下首尾刻度正好在跨度两端，沿用 0.12 会把首尾抹掉 = 读成"少了两条"
          const endT = spanTaper(tk.u, R.TOP, R.BOT, 0.35);
          const frac = tk.lvl === "h1" ? 0.90 : (tk.lvl === "h2" ? 0.68 : 0.48);
          const tw = Math.max(2.5, W * frac - 1.6) + W * (p.grow / 100) * qw;
          ctx!.beginPath();
          ctx!.lineWidth = Math.max(1.4, W * 0.14) + Math.max(0, W * 0.10) * qw;
          const cr2 = Math.round(139 + 52 * qw), cg2 = Math.round(151 + 68 * qw), cb2 = Math.round(168 + 86 * qw);
          ctx!.strokeStyle = `rgba(${cr2},${cg2},${cb2},${((0.62 + 0.36 * qw) * endT).toFixed(3)})`;
          ctx!.lineCap = "round";
          ctx!.moveTo(R.OX + W - 1.0, tk.u);
          ctx!.lineTo(R.OX + W - 1.0 - tw, tk.u);
          ctx!.stroke();
        }
      }
      void tms;
    }

    function frame(tms: number): void {
      /* ⚠️⚠️ **必须放在最前面**（A-1118）：cleanup 时已经排队的那一帧仍会被调用，
         这里不拦就"续命"成僵尸循环 —— 它会在同一张 canvas 上继续画**本实例的那个 mode**，
         把新实例画的图整帧盖掉（用户看到的"md 页显示波形"就是这么来的）。
         注意 `R.running = false` 也要在这里补：僵尸帧不能再被当成"循环还活着"。 */
      if (!alive) { R.running = false; return; }
      const p = pRef.current;
      if (!R.lastT) { R.lastT = tms; }
      const dt = R.lastT ? Math.min(48, tms - R.lastT) : 16;
      R.lastT = tms;
      if (!R.visible) { R.running = false; return; }
      // 荡漾相位：**累加器**。悬停暂停 = 速度归零（不是重置时间，重置会让相位跳变）
      const speed = (R.ptr.active && p.pause) ? 0 : p.spd;
      R.driftT += (dt / 1000) * speed;
      R.driftPhase = reduceMotion ? 0 : R.driftT * ((Math.PI * 2) / 5.2);

      const want = R.ptr.active ? 1 : 0;
      const k = 1 - Math.pow(1 - 0.18, dt / 16.7);
      R.ptr.strength += (want - R.ptr.strength) * k;
      if (want === 1 && R.ptr.strength > 0.998) { R.ptr.strength = 1; }
      if (want === 0 && R.ptr.strength < 0.002) { R.ptr.strength = 0; }
      const kk = 1 - Math.pow(1 - p.damp, dt / 16.7);
      R.ptr.uc += (R.ptr.target - R.ptr.uc) * kk;
      if (Math.abs(R.ptr.target - R.ptr.uc) < 0.25) { R.ptr.uc = R.ptr.target; }

      /* 滚动驱动的「当前条目」：目标 = 最近条目的 `u`，位置**阻尼**推进（与鼠标态同族）。
         ⚠️ 阻尼是必需的，不是修饰：目标在两个刻度之间**整格跳**（最近条目换了就是换了），
         不阻尼就会看到隆起硬跳一下；阻尼后是"滑过去"，且停稳时正好落在某一条上。
         ⚠️ 停在 `frame`（有 `dt`）而不是 `draw`（只有 `tms`）—— 阻尼需要真实帧间隔。 */
      if (withTicks && R.ticks.length > 0) {
        const sc2 = scrollerRef.current();
        const s2 = sc2 ? sc2.scrollTop : 0;
        let best = 0, bd = Infinity;
        for (let k = 0; k < R.ticks.length; k++) {
          const dd = Math.abs(R.ticks[k].s - s2);
          if (dd < bd) { bd = dd; best = k; }
        }
        R.curUt = R.ticks[best].u;
        if (R.curU < 0) { R.curU = R.curUt; }
        R.curU += (R.curUt - R.curU) * kk;
        if (Math.abs(R.curUt - R.curU) < 0.25) { R.curU = R.curUt; }
      }

      draw(tms);
      /* ticks 模式**没有波形** ⇒ 静止（无悬停）时画面不会自己变，可以停 rAF；滚动/悬停会各自
         `ensureLoop()` 把它叫醒。不这样写的话 md 卷轴会 60fps 空转（改之前就是这样）。
         ⚠️ 阻尼未停稳时**不许**算静止（否则隆起会停在半路：滑到一半就停帧）。 */
      const scrollSettled = !withTicks || R.ticks.length === 0 || R.curU === R.curUt;
      const idle = !R.ptr.active && R.ptr.strength === 0 && scrollSettled
        && (reduceMotion || p.spd === 0 || withTicks);
      if (idle) { R.running = false; draw(tms); return; }
      requestAnimationFrame(frame);
    }

    /* ── 交互 ─────────────────────────────────────────────────────────── */
    const onEnter = (e: PointerEvent): void => {
      R.ptr.active = true; R.ptr.target = pointerU(e); R.ptr.uc = R.ptr.target;
      onHover(R.ptr.target); ensureLoop();
    };
    const onMove = (e: PointerEvent): void => {
      const u = pointerU(e);
      const sc = scrollerRef.current();
      if (R.dragging && sc) { dragU = u; sc.scrollTop = sFromU(u); }
      onHover(u); ensureLoop();
    };
    const onLeave = (): void => {
      if (R.dragging) { return; }
      R.ptr.active = false; R.ptr.nearest = -1; tip!.classList.remove("on"); ensureLoop();
    };
    const onDown = (e: PointerEvent): void => {
      R.dragging = true; dragU = pointerU(e);
      try { hit!.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      ensureLoop();
    };
    const onUp = (e: PointerEvent): void => {
      if (!R.dragging) { return; }
      const upU = pointerU(e), moved = Math.abs(upU - dragU) > 3;
      R.dragging = false;
      try { hit!.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      onHover(upU);
      if (!moved) { const t = R.ticks[nearest(upU)]; if (t) { jump(t); } }   // 点一下 = 跳转
    };
    const onCancel = (): void => { R.dragging = false; };
    /** 滚轮必须转发给被控制的容器 —— 卷轴覆盖在容器右缘上，不转发的话
     *  在卷轴上滚就"滚不动"（命中目标变成了卷轴自己）。 */
    const onWheel = (e: WheelEvent): void => {
      const sc = scrollerRef.current();
      if (!sc) { return; }
      sc.scrollTop += e.deltaY;
      e.preventDefault();
    };
    const onKey = (e: KeyboardEvent): void => {
      const cur = R.ptr.nearest < 0 ? nearest(R.ptr.target) : R.ptr.nearest;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const d = e.key === "ArrowDown" ? 1 : -1;
        const t = R.ticks[Math.min(R.ticks.length - 1, Math.max(0, cur + d))];
        if (t) {
          R.ptr.nearest = t.i; R.ptr.target = t.u; R.ptr.uc = t.u; R.ptr.active = true;
          tipTxt!.textContent = t.label; tipOrd!.textContent = `${t.i + 1} / ${R.ticks.length}`;
          tip!.classList.add("on"); positionTip(t.u); jump(t);
        }
        ensureLoop(); e.preventDefault();
      } else if (e.key === "Home" || e.key === "End") {
        const sc = scrollerRef.current();
        if (sc) { sc.scrollTo({ top: e.key === "Home" ? 0 : R.maxScroll, behavior: "smooth" }); }
        e.preventDefault();
      }
    };

    hit.addEventListener("pointerenter", onEnter);
    hit.addEventListener("pointermove", onMove);
    hit.addEventListener("pointerleave", onLeave);
    hit.addEventListener("pointerdown", onDown);
    hit.addEventListener("pointerup", onUp);
    hit.addEventListener("pointercancel", onCancel);
    hit.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("keydown", onKey);

    const sc0 = scrollerRef.current();
    const onScroll = (): void => { ensureLoop(); };
    sc0?.addEventListener("scroll", onScroll, { passive: true });
    const roHost = new ResizeObserver(() => { layout(); });
    roHost.observe(host);
    const roSc = sc0 ? new ResizeObserver(() => { layout(); }) : null;
    if (roSc && sc0) { roSc.observe(sc0); }
    const onWinResize = (): void => { layout(); ensureLoop(); };
    window.addEventListener("resize", onWinResize);
    const onVis = (): void => { if (!document.hidden) { ensureLoop(); } };
    document.addEventListener("visibilitychange", onVis);

    layout(); ensureLoop();

    return () => {
      /* ⚠️ 顺序无所谓，但**两件都要做**（A-1118）：`alive = false` 让已排队的帧当场退出（含 frame 里
         那次自续命），`R.running = false` 让 `ensureLoop()` 不再启动新的。少任一件 = 循环泄漏。 */
      alive = false;
      hit.removeEventListener("pointerenter", onEnter);
      hit.removeEventListener("pointermove", onMove);
      hit.removeEventListener("pointerleave", onLeave);
      hit.removeEventListener("pointerdown", onDown);
      hit.removeEventListener("pointerup", onUp);
      hit.removeEventListener("pointercancel", onCancel);
      hit.removeEventListener("wheel", onWheel);
      host.removeEventListener("keydown", onKey);
      sc0?.removeEventListener("scroll", onScroll);
      roHost.disconnect(); roSc?.disconnect();
      window.removeEventListener("resize", onWinResize);
      document.removeEventListener("visibilitychange", onVis);
      R.running = false;
    };
    // 只在 mode 变化时重建；参数/回调走 ref，改设置**不重挂**
  }, [mode]);

  return (
    <div className="topic-rail" ref={hostRef}>
      <canvas ref={cvRef} className="topic-rail-canvas" />
      <div className="topic-rail-hit" ref={hitRef} tabIndex={0} role="slider"
        aria-label={mode === "ticks" ? "文档目录卷轴" : "对话话题卷轴"} aria-valuemin={1} aria-valuemax={0} aria-valuenow={0} />
      <div className="topic-rail-tip" ref={tipRef}>
        <i className="dot" />
        <span className="ord" ref={tipOrdRef} />
        <span className="txt" ref={tipTxtRef} />
      </div>
    </div>
  );
}

/** 宿主容器需要的类名：隐藏原生滚动条（卷轴就位后原生条必须消失，否则两条并存）。 */
export const RAIL_HOST_CLASS = "rail-host";