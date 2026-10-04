















import React, { type JSX } from "react";


export interface SplashStep {
  label: string;
  done: boolean;
}

export interface SplashScreenProps {
  
  visible: boolean;
  
  status: string;
  
  steps?: SplashStep[];
  
  title?: string;
  
  subtitle?: string;
}

export default function SplashScreen({
  visible, status, steps = [], title = "slime", subtitle,
}: SplashScreenProps): JSX.Element | null {
  
  
  const [mounted, setMounted] = React.useState(visible);
  










  const [opaque, setOpaque] = React.useState(visible);

  React.useEffect(() => {
    if (visible) {
      setMounted(true);
      
      const raf = window.requestAnimationFrame(() => setOpaque(true));
      return () => window.cancelAnimationFrame(raf);
    }
    setOpaque(false);
    const t = window.setTimeout(() => setMounted(false), 260);
    return () => window.clearTimeout(t);
  }, [visible]);

  if (!mounted) { return null; }

  return (
    <div
      aria-hidden={!visible}
      style={{
        position: "fixed", inset: 0, zIndex: 999,
        background: "var(--bg)",
        display: "flex", alignItems: "center", justifyContent: "center",
        opacity: opaque ? 1 : 0,
        transition: "opacity 240ms ease",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <div style={{ width: 300, textAlign: "center" }}>
        {}
        <div style={{ position: "relative", width: 72, height: 72, margin: "0 auto 16px" }}>
          <div style={{
            position: "absolute", inset: -14, borderRadius: 26,
            background: "radial-gradient(circle, rgba(99,102,241,0.28), transparent 68%)",
            animation: "slime-splash-breathe 2.4s ease-in-out infinite",
          }} />
          <div style={{
            position: "relative", width: 72, height: 72, borderRadius: 19,
            background: "linear-gradient(140deg, var(--accent), #6366f1 62%, #8b5cf6)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 33, fontWeight: 900, color: "#fff",
            boxShadow: "0 10px 30px rgba(99,102,241,0.34)",
          }}>S</div>
        </div>

        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.4, color: "var(--text)" }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 11, color: "var(--text-dim, var(--text-muted))", marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
            {subtitle}
          </div>
        )}

        {}
        <div style={{
          width: 190, height: 4, borderRadius: 3, background: "var(--border)",
          margin: "16px auto 12px", overflow: "hidden",
        }}>
          <div style={{
            width: "38%", height: "100%", borderRadius: 3,
            background: "linear-gradient(90deg, transparent, var(--accent), transparent)",
            animation: "slime-boot-slide 1.15s ease-in-out infinite",
          }} />
        </div>

        <div style={{ fontSize: 12.5, color: "var(--text-secondary, var(--text-muted))", minHeight: 18 }}>
          {status}
        </div>

        {}
        {steps.length > 0 && (
          <div style={{ marginTop: 14, display: "inline-block", textAlign: "left" }}>
            {steps.map((s) => (
              <div key={s.label} style={{
                display: "flex", alignItems: "center", gap: 7,
                fontSize: 11.5, lineHeight: "18px",
                color: s.done ? "var(--text-muted)" : "var(--text-secondary, var(--text-muted))",
              }}>
                <span style={{
                  width: 12, flexShrink: 0, textAlign: "center",
                  color: s.done ? "var(--success, #4ade80)" : "var(--accent)",
                  fontSize: s.done ? 11 : 9,
                }}>{s.done ? "✓" : "●"}</span>
                <span style={{ opacity: s.done ? 0.68 : 1 }}>{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes slime-boot-slide { 0% { transform: translateX(-120%); } 100% { transform: translateX(330%); } }
        @keyframes slime-splash-breathe { 0%,100% { opacity: .55; transform: scale(1); } 50% { opacity: 1; transform: scale(1.06); } }
      `}</style>
    </div>
  );
}
