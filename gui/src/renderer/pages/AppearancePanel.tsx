
















import React, { type JSX } from "react";
import { THEMES, type ThemeName } from "../theme.js";
import TopicRail, { type RailEntry } from "./TopicRail.js";
import {
  loadRailParams, saveRailParams, defaultRailParams, type RailMode, type RailParams,
} from "./railParams.js";
import {
  getCachedPluginThemes, getPluginThemeSelection, setPluginThemeSelection, subscribePluginTheme,
  type AvailablePluginTheme,
} from "../pluginTheme.js";

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


const DEMO_TOPICS = [
  "上下文压缩到底是不是真压缩", "子代理会不会真的被派出去", "临时子代理怎么落地",
  "调试端口冲突怎么自愈", "侧栏命中区为什么要左右对称", "滚到最新时为什么会抖",
  "对话内滚动条换成什么样", "整页滚动条换成目录体系", "双线交织水波卷轴", "渲染优化怎么做",
];

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

  /* A-1198：扩展皮肤（插件提供）—— 订阅 pluginTheme 缓存（宿主组件负责拉数据与落值）。 */
  const [pluginThemes, setPluginThemes] = React.useState<AvailablePluginTheme[]>(getCachedPluginThemes());
  const [pluginSkin, setPluginSkin] = React.useState<string>(getPluginThemeSelection());
  React.useEffect(() => {
    const off = subscribePluginTheme(() => {
      setPluginThemes(getCachedPluginThemes());
      setPluginSkin(getPluginThemeSelection());
    });
    return off;
  }, []);

  
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
    
    setParams(saveRailParams(mode, defaultRailParams(mode)));
  };

  return (
    



















    <div className="settings-pane" style={{
      display: "flex", gap: 16, alignItems: "stretch", minHeight: 0, height: "100%",
      paddingTop: 14, paddingBottom: 14,
    }}>
      {}
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
          {}
          <TopicRail mode={mode} scroller={demoScroller} collect={demoCollect} params={params} />
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
          把鼠标放进框内即可看效果：悬停 → 衬托 / 气泡，点击 → 跳转，按住拖动 → 连续擦洗。
        </div>
      </div>

      {}
      {
}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 10 }}>
        {}
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

        {/* A-1198：扩展皮肤 —— 由插件 `contributes.theme` 声明的白名单设计令牌（配色/字体族/圆角）。
            可开可关：停用或卸载该插件后，这里消失并自动回落到默认（「精装/武装」口径的落点）。 */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>扩展皮肤</div>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {pluginThemes.length > 0 ? `${pluginThemes.length} 套可用` : "无扩展提供"}
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              onClick={() => setPluginThemeSelection("")}
              title="不叠加任何扩展皮肤，跟随上方内置主题"
              style={{
                flex: "0 1 190px", textAlign: "left", cursor: "pointer",
                padding: "9px 12px", borderRadius: 12,
                border: `1.5px solid ${pluginSkin === "" ? "var(--accent)" : "var(--border)"}`,
                background: pluginSkin === "" ? "var(--accent-soft)" : "var(--bg-input)",
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: pluginSkin === "" ? "var(--accent-hover)" : "var(--text)" }}>
                  默认（跟随上方主题）
                </span>
                {pluginSkin === "" && <span style={{ fontSize: 11, color: "var(--accent-hover)", marginLeft: "auto" }}>使用中</span>}
              </div>
            </button>
            {pluginThemes.map((t) => {
              const active = pluginSkin === t.plugin;
              const swatch = [t.tokens.accent, t.tokens.bg, t.tokens.text].filter((c): c is string => typeof c === "string");
              return (
                <button
                  key={t.plugin}
                  onClick={() => setPluginThemeSelection(t.plugin)}
                  title={`由扩展「${t.plugin}」提供；停用该扩展即自动回落默认`}
                  style={{
                    flex: "0 1 190px", textAlign: "left", cursor: "pointer",
                    padding: "9px 12px", borderRadius: 12,
                    border: `1.5px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    background: active ? "var(--accent-soft)" : "var(--bg-input)",
                  }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    {swatch.length > 0 && (
                      <span style={{ display: "inline-flex", gap: 4 }}>
                        {swatch.map((c, i) => (
                          <span key={`${c}-${i}`} style={{ width: 14, height: 14, borderRadius: "50%", background: c, border: "1px solid rgba(255,255,255,0.15)" }} />
                        ))}
                      </span>
                    )}
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: active ? "var(--accent-hover)" : "var(--text)" }}>{t.name}</span>
                    {active && <span style={{ fontSize: 11, color: "var(--accent-hover)", marginLeft: "auto" }}>使用中</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>来自扩展：{t.plugin}</div>
                </button>
              );
            })}
          </div>
          {pluginThemes.length === 0 && (
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.6, marginTop: 6 }}>
              还没有扩展提供皮肤 —— 去「扩展」页点「安装示例扩展」，装好后这里会出现示例皮肤（随时可切回默认）。
            </div>
          )}
        </div>

        {}
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
