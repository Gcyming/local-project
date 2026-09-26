/**
 * gui/src/renderer/pages/AppearancePanel.tsx — 设置「外观」专栏（A-1115）。
 *
 * 用户点名的要求：
 *   「在设置中添加一个外观栏目，开一个栏目页面…最左侧设置一个合适大小的框格，里面**只显示对应的目录卷轴条**，
 *    用户可以把鼠标放在上面直接看效果。这个界面做好后，把**主题选择也挪过来**，
 *    以后这个界面就专门放所有跟 slime 外观、UI 设定相关的功能。」
 *
 * 版式（沿用「新建会话」弹窗那套：卡片 + 小节标题 + 内联控件）：
 *   左：演示框（真实滚动 + 真实卷轴，鼠标放上去就有完整效果：衬托 / 气泡 / 点击跳转）
 *   右：该目标的全部参数 + 主题选择
 *
 * ⚠️ 演示框用的是**同一个 TopicRail 组件**、读的是**同一份参数**（`railParams.ts`）——
 *    绝不在这里另写一份画的逻辑，否则"设置里调好了、实际界面没变"这类静默失效必然复发。
 * ⚠️ 改参数走 `saveRailParams`（写 localStorage + 广播）⇒ 已经打开的对话页 / 右栏 md 阅读器**即时生效**，
 *    不需要重启，也不需要重挂卷轴（卷轴内部逐帧读 ref）。
 */
import React, { type JSX } from "react";
import { THEMES, type ThemeName } from "../theme.js";
import TopicRail, { type RailEntry } from "./TopicRail.js";
import {
  loadRailParams, saveRailParams, defaultRailParams, type RailMode, type RailParams,
} from "./railParams.js";

type TabId = "chat" | "md";

const TABS: Array<{ id: TabId; label: string; mode: RailMode; hint: string }> = [
  { id: "chat", label: "对话页", mode: "wave", hint: "双线交织水波：鼠标处隆起、两肩凹陷（衬托），点击话题跳转" },
  { id: "md", label: "md 文档", mode: "ticks", hint: "只保留目录刻度尺：鼠标处那条变长并向左突起，不做凹陷" },
];

interface SliderDef {
  key: keyof RailParams;
  label: string;
  min: number;
  max: number;
  step?: number;
  fmt?: (v: number) => string;
  note?: string;
  /** 只在哪些目标下显示（缺省 = 都显示） */
  only?: TabId[];
}

const SLIDERS: SliderDef[] = [
  { key: "w", label: "卷轴宽度", min: 6, max: 32, fmt: (v) => `${v}px`, note: "拖动条本身多宽（判定区再左右各 +3px）" },
  { key: "amp", label: "常态振幅", min: 0, max: 100, fmt: (v) => `${v}%`,
    note: "占波形带宽的百分比。⚠️ 压太低两线会糊成一条（必须大于两条描边的覆盖宽度）" },
  { key: "lam0", label: "亮线波长", min: 8, max: 400, fmt: (v) => `${v}px`, note: "两条线波长不同才会「交织」" },
  { key: "lam1", label: "暗线波长", min: 8, max: 400, fmt: (v) => `${v}px` },
  { key: "sig", label: "过渡尺度 σ", min: 4, max: 120, fmt: (v) => `${v}px`, note: "越小，鼠标上下影响的范围越窄" },
  { key: "bulge", label: "隆起", min: 0, max: 400, fmt: (v) => `${v}%`, note: "鼠标处向左伸出的幅度（占半带宽）" },
  { key: "dip", label: "凹陷", min: 0, max: 200, fmt: (v) => `${v}%`, note: "两肩向右凹的深度（衬托的来源）", only: ["chat"] },
  { key: "k", label: "合拢强度", min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2),
    note: "1 = 鼠标处两线完全重叠成一个尖", only: ["chat"] },
  { key: "a", label: "平滑区 a（×σ）", min: 1, max: 8, step: 0.1, fmt: (v) => v.toFixed(1),
    note: "⚠️ 不能太小：盖不住凹陷的尾巴时，衔接处会出现「锐角」", only: ["chat"] },
  { key: "grow", label: "刻度突起", min: 0, max: 200, fmt: (v) => `${v}%`, note: "鼠标处那条刻度多长（占卷轴宽）", only: ["md"] },
  { key: "tap", label: "端部过渡长度", min: 0, max: 400, fmt: (v) => `${v}px`, note: "上下端点多远内开始渐隐 + 收束" },
  { key: "efloor", label: "端部残留", min: 0, max: 0.9, step: 0.01, fmt: (v) => v.toFixed(2),
    note: "⚠️ 别给 0：端点会变成一段精确直线，反而成了「看得见的形状」" },
  { key: "spd", label: "荡漾速度", min: 0, max: 4, step: 0.05, fmt: (v) => v.toFixed(2), note: "0 = 完全静止", only: ["chat"] },
  { key: "damp", label: "跟随阻尼", min: 0.02, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), note: "越小越柔" },
];

const CHECKS: Array<{ key: keyof RailParams; label: string; note: string; only?: TabId[] }> = [
  { key: "pause", label: "悬停时暂停荡漾", note: "相位冻住（不是重置时间）——不会跳变", only: ["chat"] },
  { key: "read", label: "已读段更亮", note: "对话页用它代替进度刻度", only: ["chat"] },
  { key: "flip", label: "衬托方向反过来", note: "把隆起放到右侧", only: ["chat"] },
];

interface Props {
  theme?: ThemeName;
  onThemeChange?: (t: ThemeName) => void;
}

/** 演示用的假对话（够长才能滚；有用户发言 ⇒ 卷轴才有"话题"可显示） */
const DEMO_TOPICS = [
  "上下文压缩到底是不是真压缩", "子代理会不会真的被派出去", "临时子代理怎么落地",
  "调试端口冲突怎么自愈", "侧栏命中区为什么要左右对称", "滚到最新时为什么会抖",
  "对话内滚动条换成什么样", "整页滚动条换成目录体系", "双线交织水波卷轴", "渲染优化怎么做",
];
/** 演示用的假 md 标题（h1/h2/h3 混排 ⇒ 刻度长度有层级） */
const DEMO_DOC: Array<{ lv: "h1" | "h2" | "h3"; text: string }> = [
  { lv: "h1", text: "上下文压缩 Agent-Loop 规格" },
  { lv: "h2", text: "一、触发与闸门" },
  { lv: "h3", text: "1.1 发送前预算门" },
  { lv: "h3", text: "1.2 引擎侧保险门" },
  { lv: "h2", text: "二、压缩闭环" },
  { lv: "h3", text: "2.1 摘要必须带 full 标记" },
  { lv: "h3", text: "2.2 压无可压时给出可救模型" },
  { lv: "h2", text: "三、子代理" },
  { lv: "h3", text: "3.1 授权判据" },
  { lv: "h3", text: "3.2 临时子代理" },
  { lv: "h2", text: "四、验收" },
  { lv: "h3", text: "4.1 像素级验收" },
  { lv: "h2", text: "五、遗留" },
];

export default function AppearancePanel({ theme = "beta", onThemeChange }: Props): JSX.Element {
  const [tab, setTab] = React.useState<TabId>("chat");
  const mode = (TABS.find((t) => t.id === tab) ?? TABS[0]).mode;
  const [params, setParams] = React.useState<RailParams>(() => loadRailParams("wave"));
  const demoScrollRef = React.useRef<HTMLDivElement | null>(null);

  // 切目标时换成那一份参数（两个目标各自独立存）
  React.useEffect(() => { setParams(loadRailParams(mode)); }, [mode]);

  const demoScroller = React.useCallback((): HTMLElement | null => demoScrollRef.current, []);
  const demoCollect = React.useCallback((): RailEntry[] => {
    const sc = demoScrollRef.current;
    if (!sc) { return []; }
    const scTop = sc.getBoundingClientRect().top;
    const sel = mode === "ticks" ? "h1,h2,h3" : "[data-demo-topic]";
    return Array.from(sc.querySelectorAll<HTMLElement>(sel)).map((el) => {
      const lv = el.tagName.toLowerCase();
      return {
        top: el.getBoundingClientRect().top - scTop + sc.scrollTop,
        label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 34) || "（空）",
        ...(mode === "ticks" ? { level: (lv === "h1" ? "h1" : lv === "h2" ? "h2" : "h3") as "h1" | "h2" | "h3" } : {}),
      };
    });
  }, [mode]);

  const set = (key: keyof RailParams, v: number | boolean): void => {
    setParams(saveRailParams(mode, { [key]: v } as Partial<RailParams>));
  };
  const reset = (): void => {
    // 把该目标的默认值整体写回（saveRailParams 是"在当前值上打补丁"，所以传完整的默认对象）
    setParams(saveRailParams(mode, defaultRailParams(mode)));
  };

  return (
    /* A-1119：左右地板已**收归 `SettingsDialog` 内容区**（`:218` 现为 `paddingLeft: 16, paddingRight: 10`）。
     *   ⇒ 本面板根的 paddingLeft / paddingRight **必须为 0**，否则两个产地叠加（16+16=32px）。
     *
     * 历史（A-1115 首版用户实例取证报「与边界相交、拥挤」）：
     *   · 左：内容区此前**没有 paddingLeft**，导航栏 `aside` 的 `borderRight` 恰好落在内容区左缘
     *     （实测窗口 1272 下 = x 287），而本面板当时 `paddingLeft: 0` ⇒ 页签按钮左边框与那条
     *     分割线**像素级重合**，看着就是"按钮压在边界线上"。
     *   · 右：右栏右缘距内容区右缘只剩 2px，卡片右边框距滚动条只剩 4px ⇒
     *     「按钮右缘 → 卡片内边界 → 卡片边框 → 滚动条 → 对话框右边界」五条边挤在 20px 内。
     *   当时是"本面板自己让出 14 / 10"（治标）。现在改治本：**边界的留白由共用祖先给**——
     *   因为"分隔线在哪"是**所有面板共用**的事实，让每个面板各写一个数必然漂（实测过
     *   16 / 12 / 4 / 0 四种口径，谁写 0 谁贴线）。本页只保留**右栏内部**的滚动条让位。
     *
     * ⚠️ 右栏的 `paddingRight` 不是随手取的：右栏变窄后主题卡的两个 `flex: 1 1 200px` 按钮
     *    仍需**并排不换行**（见下方 `maxWidth: 280`），可用宽必须 ≥ 410px。
     *
     * ⚠️ **上下必须自己给**（A-1119 二次实例取证：用户截图「页签顶到顶部、与右上角 ✕ 那条分割线相交」）：
     *    内容区的水平地板由共用祖先给（左=导航分割线、右=对话框边），但**垂直节奏是各面板自己的**
     *    （实测：通用/技能库等 16px · 心智中枢 12px · 后台任务 6px）⇒ 不能收到内容区去，
     *    否则既有面板会叠加成 32 / 28 / 22。本面板首版只让了左右、忘了上下，页签就直接顶在顶边。 */
    <div className="settings-pane" style={{
      display: "flex", gap: 16, alignItems: "stretch", minHeight: 0, height: "100%",
      paddingTop: 14, paddingBottom: 14,
    }}>
      {/* ── 左：演示框（**只有卷轴**，鼠标放上去就是真实效果）────────────────── */}
      <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {TABS.map((t) => {
            const on = t.id === tab;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} className={on ? "btn primary" : "btn"}
                style={{ flex: 1, height: 28, fontSize: 12.5 }}>{t.label}</button>
            );
          })}
        </div>
        <div style={{
          fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 8, minHeight: 32,
        }}>{(TABS.find((t) => t.id === tab) ?? TABS[0]).hint}</div>

        <div className="appearance-demo">
          <div ref={demoScrollRef} className="appearance-demo-scroll rail-host">
            {mode === "ticks"
              ? DEMO_DOC.map((d, i) => {
                const Tag = d.lv as "h1" | "h2" | "h3";
                return (
                  <React.Fragment key={i}>
                    <Tag>{d.text}</Tag>
                    <p>这里是一段正文，用来把内容撑长，好让卷轴真的可以滚、鼠标放上去也能看到衬托与刻度变化。</p>
                  </React.Fragment>
                );
              })
              : DEMO_TOPICS.map((t, i) => (
                <React.Fragment key={i}>
                  <div data-demo-topic style={{
                    margin: "0 0 8px", padding: "8px 10px", borderRadius: 10, fontSize: 12.5,
                    background: "var(--bg-input)", border: "1px solid var(--border)",
                  }}>{`你 · ${t}`}</div>
                  <div style={{ margin: "0 0 16px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                    slime：这一段先按「先取证、再动手」推进 —— 读源码与实际日志，确认现象属于哪一层，再决定改哪里。
                  </div>
                </React.Fragment>
              ))}
          </div>
          {/* ⚠️ 与对话页/右栏用的是**同一个组件、同一份参数**（不另写一份画法） */}
          <TopicRail mode={mode} scroller={demoScroller} collect={demoCollect} params={params} />
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
          把鼠标放进框内即可看效果：悬停 → 衬托 / 气泡，点击 → 跳转，按住拖动 → 连续擦洗。
        </div>
      </div>

      {/* ── 右：参数 + 主题 ─────────────────────────────────────────────── */}
      {/* ⚠️ `paddingRight` 必须 ≥ 滚动条宽（A-1113 全局样式 6px + 抗锯齿）+ 可见缝隙，
          否则卡片右边框就贴在滚动条上（实测改前只剩 4px，用户读作"与边界相交"）。 */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 10 }}>
        {/* 主题选择（从「通用」迁到这儿：以后外观相关都归本页） */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>界面主题</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {THEMES.map((t) => {
              const active = theme === t.id;
              return (
                <button key={t.id} onClick={() => onThemeChange?.(t.id)} title={t.desc}
                  style={{
                    flex: "1 1 200px", maxWidth: 280, textAlign: "left", cursor: "pointer",
                    padding: "10px 12px", borderRadius: 12,
                    border: `1.5px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    background: active ? "var(--accent-soft)" : "var(--bg-input)",
                  }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ display: "inline-flex", gap: 4 }}>
                      {t.swatch.map((c) => (
                        <span key={c} style={{ width: 16, height: 16, borderRadius: "50%", background: c, border: "1px solid rgba(255,255,255,0.15)" }} />
                      ))}
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: active ? "var(--accent-hover)" : "var(--text)" }}>{t.name}</span>
                    {active && <span style={{ fontSize: 11, color: "var(--accent-hover)", marginLeft: "auto" }}>使用中</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{t.desc}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 卷轴参数 */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
              目录卷轴 · {tab === "chat" ? "对话页" : "md 文档"}
            </div>
            <button className="btn" style={{ height: 26, fontSize: 12 }} onClick={reset}
              title="清掉本目标的本地覆盖，回到默认值">恢复默认</button>
          </div>

          {SLIDERS.filter((s) => !s.only || s.only.includes(tab)).map((s) => {
            const v = params[s.key] as number;
            const f = s.fmt ?? ((x: number) => String(x));
            return (
              <div key={String(s.key)} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: "var(--text-secondary)" }}>{s.label}</span>
                  <span style={{ marginLeft: "auto", color: "var(--accent-hover)", fontFamily: "var(--font-mono, monospace)" }}>{f(v)}</span>
                </div>
                <input type="range" min={s.min} max={s.max} step={s.step ?? 1} value={v}
                  style={{ width: "100%", accentColor: "var(--accent)" }}
                  onChange={(e) => set(s.key, Number(e.target.value))} />
                {s.note && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.5 }}>{s.note}</div>}
              </div>
            );
          })}

          {CHECKS.filter((c) => !c.only || c.only.includes(tab)).map((c) => (
            <label key={String(c.key)} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={params[c.key] as boolean} style={{ marginTop: 3, accentColor: "var(--accent)" }}
                onChange={(e) => set(c.key, e.target.checked)} />
              <span style={{ fontSize: 12.5 }}>
                <span style={{ color: "var(--text-secondary)" }}>{c.label}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{c.note}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>这个栏目以后放什么</div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.7 }}>
            外观 / UI 相关的一切设定都归这里（主题已迁入）。参数改动**即时生效**、不需要重启：
            已经打开的对话页与右栏 md 阅读器会立刻用上新值。
          </div>
        </div>
      </div>
    </div>
  );
}
