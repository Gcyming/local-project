/**
 * gui/src/renderer/pages/SplashScreen.tsx — 启动加载面板（A-1039 重做）。
 *
 * **为什么单独成一个组件**：此前它内联在 App.tsx 的 `return` 里，是一段 30 行的裸 JSX ——
 * 既没法测（要挂载整个 App 才能看它），也没法优雅退场（`{cond && <div/>}` 是**硬切**，
 * 条件一变组件立刻消失，闪一下很难看）。抽出来后：props 进、视图出，可单测；内部自持
 * `fading` 状态做淡出，退场有过渡。
 *
 * **内容上补了两件事**（用户原话「现在的安装包安装的时候啥都不显示，用户纯干等」，
 * 同一条反馈也适用于启动画面）：
 *   ① **阶段清单**：逐项列出"正在等什么、哪些已经好了"。数据到齐前用户看到的是
 *      "还在等 X"，而不是一个转圈。
 *   ② **当前步骤文案**：把主进程上报的 phase/message 如实显示出来，不写死"正在初始化…"。
 *
 * 主题跟随 IDE 主题（light/dark 都走 CSS 变量，不写死颜色）。
 */
import React, { type JSX } from "react";

/** 启动阶段清单的一项 */
export interface SplashStep {
  label: string;
  done: boolean;
}

export interface SplashScreenProps {
  /** 由门控判据决定（见 App.tsx 的 splashVisible）；false 时走淡出后卸载 */
  visible: boolean;
  /** 主状态文案（主进程 phase/message 或渲染层推导） */
  status: string;
  /** 阶段清单（可为空数组：则只显示状态文案与进度条） */
  steps?: SplashStep[];
  /** 应用名 */
  title?: string;
  /** 副标题（版本号等） */
  subtitle?: string;
}

export default function SplashScreen({
  visible, status, steps = [], title = "slime", subtitle,
}: SplashScreenProps): JSX.Element | null {
  // 淡出：visible 由 true→false 时先把透明度降到 0，再等过渡结束才真正卸载。
  // 直接跟 visible 走会让面板"啪"地消失（正是旧实现的观感问题）。
  const [mounted, setMounted] = React.useState(visible);
  /**
   * A-1059①：**首帧必须不透明**，不能做淡入。
   *
   * 用户原话：「重启进入 slime 时，会先闪一下 slime 主界面，然后再出现加载界面」。
   * 根因就是这个初值曾为 `false`：首帧 `opacity: 0` 且面板已 `position: fixed` 铺满，
   * 于是**主界面完整地透出来**（哪怕只有一两帧，人眼也看得见"闪一下"），
   * 等下一帧 rAF 把 opacity 置 1 才开始盖住 —— 这正是"先闪主界面"。
   *
   * 启动面板没有任何需要"从某处淡入"的旧状态（它盖的是同一块屏幕），
   * 所以正确行为是**第一帧就直接铺上**；只有"曾淡出过、又要重新出现"才需要淡入。
   */
  const [opaque, setOpaque] = React.useState(visible);

  React.useEffect(() => {
    if (visible) {
      setMounted(true);
      // 已是首帧不透明的场合这里是幂等的；仅"淡出后重新出现"时走 0 → 1 的过渡
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
        {/* 品牌标记：渐变方块 + 柔和光晕（纯 CSS，不引外部资源） */}
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

        {/* 不确定进度条：启动各阶段无法给出真实百分比，用滑动条表示"在动" */}
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

        {/* 阶段清单：把"在等什么"逐项摊开，替代纯转圈 */}
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
