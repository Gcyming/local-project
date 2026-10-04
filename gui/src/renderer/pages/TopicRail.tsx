




















import * as React from "react";
import type { RailParams } from "./railParams";
import { tickPositions } from "./railParams";




const LEFT_ROOM = 12;
const RIGHT_ROOM = 6;

const RAIL_INSET = 6;


const reduceMotion = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
  : false;

export interface RailEntry {
  
  top: number;
  
  label: string;
  
  level?: "h1" | "h2" | "h3";
}

export interface TopicRailProps {
  
  scroller: () => HTMLElement | null;
  
  collect?: () => RailEntry[];
  
  mode?: "wave" | "ticks";
  params: RailParams;
  
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

  
  const pRef = React.useRef(params);
  pRef.current = params;
  const collectRef = React.useRef(collect);
  collectRef.current = collect;
  const scrollerRef = React.useRef(scroller);
  scrollerRef.current = scroller;
  const probeRef = React.useRef(onProbe);
  probeRef.current = onProbe;

  React.useEffect(() => {
    

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
    























    let alive = true;
    
    let dragU = 0;
    const R = {
      W: 12, H: 400, CW: 12, OX: 0, dpr: 1, PAD: 3, TAP: 0, EFLOOR: 0.12,
      TOP: 0, BOT: 0, maxScroll: 1, scrollH: 1,
      ticks: [] as Array<{ u: number; s: number; label: string; lvl: string; i: number }>,
      ptr: { uc: 0, target: 0, strength: 0, active: false, nearest: -1 },
      
      curU: -1, curUt: -1,
      dragging: false,
      running: false, lastT: 0, visible: false,
      driftT: 0, driftPhase: 0, scrollPhase: 0,
    };

    
    function band(): { l: number; r: number; cx: number; maxAmp: number; baseAmp: number } {
      
      const p = pRef.current;
      const r = R.OX + R.W * (withTicks ? 0.76 : 0.88);
      const l = R.OX + 1.2;
      const maxAmp = Math.max(0.6, (r - l) / 2);
      return { l, r, cx: (l + r) / 2, maxAmp, baseAmp: maxAmp * (p.amp / 100) };
    }
    


    function spanTaper(y: number, top: number, bot: number, floor?: number): number {
      const fl = floor === undefined ? R.EFLOOR : floor;
      const e = Math.min(y - top, bot - y);
      const s = R.TAP > 0 ? Math.min(1, Math.max(0, e / R.TAP)) : 1;
      return fl + (1 - fl) * (s * s * (3 - 2 * s));
    }
    function taper(y: number): number { return spanTaper(y, 0, R.H); }

    

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
      
      const lo = 1.4 - B.cx, hi = R.CW - 2.0 - B.cx;
      if (push < lo) { push = lo; }
      if (push > hi) { push = hi; }
      return { sep: B.baseAmp * (1 - wOsc) * taper(u), push, cx: B.cx, maxAmp };
    }

    function layout(): void {
      


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
      
      measure(sc);
      draw(performance.now());
    }

    

    function measure(sc: HTMLElement | null): void {
      const c = collectRef.current;
      if (sc) {
        R.maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
        R.scrollH = Math.max(1, sc.scrollHeight);
      }
      const list = c ? c() : [];
      
      const us = tickPositions(list.length, R.TOP, R.BOT);
      R.ticks = list.map((e, i) => ({
        u: us[i],
        s: Math.min(Math.max(0, e.top), R.maxScroll),
        label: e.label,
        lvl: e.level || "h2",
        i,
      }));
      hit!.setAttribute("aria-valuemax", String(R.ticks.length));
      

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
      ctx!.clearRect(0, 0, R.CW, H);   
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
        
        const tA = 1.5, tB = 3.2;
        const bump = (dist: number): number => {
          const ad = dist / Math.max(1, p.sig);
          return ad <= tA ? 1 : (ad >= tB ? 0 : 0.5 * (1 + Math.cos((Math.PI * (ad - tA)) / (tB - tA))));
        };
        






        const n = R.ticks.length;
        





        const spacing = n > 1 ? (R.BOT - R.TOP) / (n - 1) : Math.max(1, R.BOT - R.TOP);
        const pA = 0.25, pB = 1.0;
        const profBump = (ad: number): number =>
          ad <= pA ? 1 : (ad >= pB ? 0 : 0.5 * (1 + Math.cos((Math.PI * (ad - pA)) / (pB - pA))));
        for (const tk of R.ticks) {
          const profCur = R.curU < 0 ? 0 : 0.62 * profBump(Math.abs(tk.u - R.curU) / spacing);
          const qw = Math.max(bump(Math.abs(tk.u - R.ptr.uc)) * R.ptr.strength, profCur);
          
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
      



      if (!alive) { R.running = false; return; }
      const p = pRef.current;
      if (!R.lastT) { R.lastT = tms; }
      const dt = R.lastT ? Math.min(48, tms - R.lastT) : 16;
      R.lastT = tms;
      if (!R.visible) { R.running = false; return; }
      
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
      


      const scrollSettled = !withTicks || R.ticks.length === 0 || R.curU === R.curUt;
      const idle = !R.ptr.active && R.ptr.strength === 0 && scrollSettled
        && (reduceMotion || p.spd === 0 || withTicks);
      if (idle) { R.running = false; draw(tms); return; }
      requestAnimationFrame(frame);
    }

    
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
      try { hit!.setPointerCapture(e.pointerId); } catch {  }
      ensureLoop();
    };
    const onUp = (e: PointerEvent): void => {
      if (!R.dragging) { return; }
      const upU = pointerU(e), moved = Math.abs(upU - dragU) > 3;
      R.dragging = false;
      try { hit!.releasePointerCapture(e.pointerId); } catch {  }
      onHover(upU);
      if (!moved) { const t = R.ticks[nearest(upU)]; if (t) { jump(t); } }   
    };
    const onCancel = (): void => { R.dragging = false; };
    

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


export const RAIL_HOST_CLASS = "rail-host";