












import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  DEFAULT_TICKS_PARAMS,
  DEFAULT_WAVE_PARAMS,
  defaultRailParams,
  normalizeRailParams,
  tickPositions,
} from "../../gui/src/renderer/pages/railParams.js";


function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

function cssBlock(src: string, sel: string): string {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, "m").exec(src);
  expect(m, `CSS 选择器未命中：${sel}`).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

const RAIL = codeOf("gui/src/renderer/pages/TopicRail.tsx");
const PARAMS = codeOf("gui/src/renderer/pages/railParams.ts");
const PANEL = codeOf("gui/src/renderer/pages/AppearancePanel.tsx");
const CHAT = codeOf("gui/src/renderer/pages/ChatPanel.tsx");
const SIDEBAR = codeOf("gui/src/renderer/pages/RightSidebar.tsx");
const GENERAL = codeOf("gui/src/renderer/pages/GeneralPanel.tsx");
const SETTINGS = codeOf("gui/src/renderer/pages/SettingsDialog.tsx");
const THEME = codeOf("gui/src/renderer/theme.ts");
const CSS_RAW = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8");

describe("A-1115 — 参数模块（纯函数，唯一出处）", () => {
  it("刻度位置：**均匀等距**铺满 [top,bot]（条目少自然疏、多自然密，间距恒定）", () => {
    const p = tickPositions(5, 100, 400);
    expect(p[0]).toBe(100);
    expect(p[4]).toBe(400);
    const gaps = p.slice(1).map((v, i) => v - p[i]);
    for (const g of gaps) { expect(g).toBeCloseTo(75, 6); }
    
    expect(tickPositions(1, 100, 400)).toEqual([250]);
    expect(tickPositions(0, 100, 400)).toEqual([]);
    
    const n = 9;
    const eq = tickPositions(n, 0, 100);
    const eqGaps = eq.slice(1).map((v, i) => v - eq[i]);
    expect(Math.max(...eqGaps) - Math.min(...eqGaps)).toBeLessThan(1e-9);
  });

  it("normalize：越界钳住、非数字丢弃、布尔透传、缺字段补默认（不许留下半个状态）", () => {
    const base = defaultRailParams("wave");
    const r = normalizeRailParams({ amp: 9999, w: -5, lam0: Number.NaN, pause: false, 乱入: 1 }, base);
    expect(r.amp).toBeLessThanOrEqual(100);
    expect(r.amp).toBeGreaterThanOrEqual(0);
    expect(r.w).toBeGreaterThanOrEqual(6);
    expect(r.lam0).toBe(base.lam0);            
    expect(r.pause).toBe(false);               
    expect((r as unknown as Record<string, unknown>).乱入).toBeUndefined();
    
    expect(normalizeRailParams(null, base)).toEqual(base);
    expect(normalizeRailParams("nonsense", base)).toEqual(base);
  });

  it("默认值本身必须满足三条硬约束（它们各自对应一个踩过的坑）", () => {
    
    expect(DEFAULT_WAVE_PARAMS.efloor).toBeGreaterThan(0);
    
    expect(DEFAULT_WAVE_PARAMS.amp).toBeGreaterThanOrEqual(40);
    
    expect(DEFAULT_TICKS_PARAMS.dip).toBe(0);
    
    expect(DEFAULT_WAVE_PARAMS.lam0).not.toBe(DEFAULT_WAVE_PARAMS.lam1);
  });
});

describe("A-1115 — 绘制核心的不变量（源码层，写错也编译通过）", () => {
  it("② 清屏必须用画布总宽 `R.CW`（用卷轴宽 W 会让加宽那截永远清不掉 ⇒ 糊成一坨）", () => {
    expect(RAIL).toContain("clearRect(0, 0, R.CW, H)");
    expect(RAIL).not.toMatch(/clearRect\(0,\s*0,\s*W,/);
    
    expect(RAIL).toContain("R.CW = R.OX + R.W + RIGHT_ROOM");
  });

  it("① 四条描边共用同一个 shapeAt；发光层**不许**换个形状（换了 = 多画一对线）", () => {
    
    expect(RAIL).toContain("const sh = shapeAt(u);");
    const calls = RAIL.match(/strokeWave\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);   
    
    expect(RAIL).not.toMatch(/strokeWave\([^)]*zeroG/);
  });

  it("③ `contain:paint` 只放 canvas；卷轴容器上不许有（放容器 = overflow:clip ⇒ 气泡被裁）", () => {
    expect(cssBlock(CSS_RAW, ".topic-rail-canvas")).toContain("contain: paint");
    expect(cssBlock(CSS_RAW, ".topic-rail")).not.toContain("contain");
  });

  it("⑦ 原生滚动条必须真的隐藏（否则卷轴与系统条两条并存）", () => {
    expect(cssBlock(CSS_RAW, ".rail-host")).toContain("scrollbar-width: none");
    expect(cssBlock(CSS_RAW, ".rail-host::-webkit-scrollbar")).toContain("width: 0");
    expect(CHAT).toContain("rail-host");
    expect(SIDEBAR).toContain("rail-host");
  });

  it("衬托的过渡带不能窄（窄了凹陷尾巴与刚恢复的振荡叠在一起 = 「锐角」）", () => {
    expect(RAIL).toContain("const a = p.a, b = a + Math.max(1.4, a * 0.7);");
  });

  it("② 分隔线变粗必须靠**线自己**（border-image-width > border-width），不是叠覆盖层", () => {
    



    

    const li = /border-image:\s*var\(--rz-ramp\)\s+0\s+(\d+)\s+0\s+0\s*\/\s*0\s+(\d+)px\s+0\s+0/.exec(CSS_RAW);
    expect(li, "找不到左栏分隔线的聚光声明（slice 在右侧那一份）").not.toBeNull();
    expect(Number((li as RegExpExecArray)[1]), "左栏 slice 必须落在**右**侧（分隔线在右边）—— 写反什么都不亮")
      .toBeGreaterThan(0);
    const lw = Number((li as RegExpExecArray)[2]);
    expect(lw, "分隔线太细 —— 用户明确反馈过「拖拽光标太窄了，怎么这么细」").toBeGreaterThan(1);
    const ri = /border-image:\s*var\(--rz-ramp\)\s+0\s+0\s+0\s+(\d+)\s*\/\s*0\s+0\s+0\s+(\d+)px/.exec(CSS_RAW);
    expect(ri, "找不到右栏分隔线的聚光声明（slice 在左侧那一份）").not.toBeNull();
    expect(Number((ri as RegExpExecArray)[1]), "右栏 slice 必须落在**左**侧（镜像）").toBeGreaterThan(0);
    expect(Number((ri as RegExpExecArray)[2]), "左右两栏的分隔线粗细必须一致（否则一边细一边粗）")
      .toBe(lw);
    
    expect(cssBlock(CSS_RAW, ".sidebar-resizer")).not.toMatch(/background-image\s*:/);
  });

  it("③ md 滚动：对应刻度要随**当前滚动位置**隆起（按 `s` 找，不是按 `u`）", () => {
    expect(RAIL, "md 刻度没有滚动驱动的隆起 —— 用户：「翻到对应位置，刻度线要隆起有反应」")
      .toContain("0.62 * profBump(Math.abs(tk.u - R.curU) / spacing)");
    expect(RAIL, "找当前条目必须按 `s`（目标 scrollTop）；按 `u` 会永远是中间那条亮")
      .toContain("const dd = Math.abs(R.ticks[k].s - s2);");
    expect(RAIL, "滚动驱动与鼠标驱动必须取 max —— 相加会在两者重合时翻倍跳一下")
      .toContain("Math.max(bump(Math.abs(tk.u - R.ptr.uc)) * R.ptr.strength, profCur)");
    


    expect(RAIL, "滚动隆起的衰减按**刻度间距**归一（按绝对像素 sig 会在长文档上亮成一片）")
      .toContain("const spacing = n > 1 ? (R.BOT - R.TOP) / (n - 1) : Math.max(1, R.BOT - R.TOP);");
    expect(RAIL, "本单位下 1.0 处必须归零 ⇒ 停稳时只有一条满亮（相邻那条只在滑动途中半亮）")
      .toMatch(/const pA = 0\.25, pB = 1\.0;/);
    
    expect(RAIL, "滚动位置没有阻尼（目标整格跳 ⇒ 隆起会硬跳，而不是滑过去）")
      .toContain("R.curU += (R.curUt - R.curU) * kk;");
    expect(RAIL, "阻尼未停稳时不许判定静止（否则隆起停在半路）")
      .toContain("const scrollSettled = !withTicks || R.ticks.length === 0 || R.curU === R.curUt;");
  });

  it("两线必须分得开：描边宽度与振幅是互相抢空间的（线宽被调胖 = 两线糊成一条）", () => {
    expect(RAIL).toContain("const wMain = i ? W * 0.095 : W * 0.13;");
  });
});

describe("A-1115 — 接线（参数读同一份、宿主内边距与卷轴余量成对）", () => {
  it("对话页：wave 参数 + rail-host + 右侧内边距 30（= RAIL_INSET 6 + 卷轴 w + LEFT_ROOM 12）", () => {
    expect(CHAT).toContain('loadRailParams("wave")');
    expect(CHAT).toContain("onRailParams");
    expect(CHAT).toContain('mode="wave"');
    


    const pad = /padding: "14px (\d+)px 0 16px"/.exec(CHAT);
    expect(pad, "聊天滚动容器没有右侧留白（卷轴会压到正文）").not.toBeNull();
    expect(Number((pad as RegExpExecArray)[1])).toBeGreaterThanOrEqual(30);
    
    expect(CHAT).toContain(".msg-user-bubble");
  });

  it("右栏 md：ticks 参数 + 同一套 rail-host/内边距约定", () => {
    expect(SIDEBAR).toContain('loadRailParams("ticks")');
    expect(SIDEBAR).toContain("onRailParams");
    expect(SIDEBAR).toContain('mode="ticks"');
    expect(SIDEBAR).toContain("padding: \"12px 30px 12px 16px\"");
    expect(SIDEBAR).toContain('querySelectorAll<HTMLElement>("h1,h2,h3")');
  });

  it("参数没有第二个产地：两个宿主都不许自己写死默认值", () => {
    for (const [name, src] of [["ChatPanel", CHAT], ["RightSidebar", SIDEBAR]] as const) {
      expect(src, `${name} 不应内联卷轴默认参数`).not.toMatch(/bulge:\s*\d/);
      expect(src, `${name} 不应内联卷轴默认参数`).not.toMatch(/efloor:\s*0\./);
    }
    expect(PARAMS).toContain("export function loadRailParams");
    expect(PARAMS).toContain("export function saveRailParams");
    expect(PARAMS).toContain("export function onRailParams");
  });
});

describe("A-1115 — 外观专栏（主题迁入 + 演示框）", () => {
  it("设置里确实注册了「外观」栏目（类型 + 清单 + 渲染分支，三处缺一不可）", () => {
    expect(SETTINGS).toContain('"appearance"');
    expect(SETTINGS).toContain('id: "appearance"');
    expect(SETTINGS).toContain('activeTab === "appearance"');
    expect(SETTINGS).toContain("<AppearancePanel");
  });

  it("主题唯一出处 = theme.ts::THEMES，且「通用」页不再有主题卡片（两个入口 = 两个真相源）", () => {
    expect(THEME).toContain("export const THEMES");
    expect(GENERAL).not.toContain("THEMES");
    expect(GENERAL).not.toContain("界面主题");
    expect(PANEL).toContain("THEMES");
  });

  it("演示框左边只有卷轴：用**同一个组件**、读**同一份参数**（不许另写一份画法）", () => {
    expect(PANEL).toContain("<TopicRail mode={mode}");
    expect(PANEL).toContain("loadRailParams(mode)");
    expect(PANEL).toContain("saveRailParams(mode");
    
    expect(PANEL).toContain('{ id: "chat"');
    expect(PANEL).toContain('{ id: "md"');
  });

  it("演示框的圆角/裁剪在内层滚动容器上（外层裁剪会把悬浮气泡切掉）", () => {
    expect(cssBlock(CSS_RAW, ".appearance-demo")).not.toContain("overflow");
    expect(cssBlock(CSS_RAW, ".appearance-demo-scroll")).toContain("overflow-y: auto");
    expect(cssBlock(CSS_RAW, ".appearance-demo-scroll")).toContain("border-radius");
  });
});





















describe("A-1118 — rAF 循环生命周期（泄漏 = 两代闭包同画一张 canvas）", () => {
  
  function fnBody(src: string, header: string): string {
    const i = src.indexOf(header);
    expect(i, `找不到函数：${header}`).toBeGreaterThanOrEqual(0);
    const rest = src.slice(i + header.length);
    const end = rest.indexOf("\n    }");
    expect(end, `函数体没闭合：${header}`).toBeGreaterThan(0);
    return rest.slice(0, end);
  }

  it("`frame()` 入口必须有 `!alive` 挡板，且**早于**它自己排下一次 rAF（位置才是判据）", () => {
    const body = fnBody(RAIL, "function frame(tms: number): void {");
    const guard = body.indexOf("!alive");
    const raf = body.indexOf("requestAnimationFrame(");
    expect(guard, "frame() 里没有 alive 挡板 ⇒ cleanup 后已排队的那一帧会续命成僵尸循环").toBeGreaterThanOrEqual(0);
    expect(raf, "frame() 里找不到自续帧的 rAF —— 结构变了，本守卫需要同步").toBeGreaterThanOrEqual(0);
    expect(guard, "挡板必须在排下一次 rAF **之前**：挪到后面 = 僵尸帧照样续命，等于没挡")
      .toBeLessThan(raf);
    
    expect(body.slice(0, raf), "挡板里必须把 R.running 归零").toContain("R.running = false");
  });

  it("`ensureLoop()` 不得给废弃实例启动新循环；`layout()` 同样要挡", () => {
    expect(fnBody(RAIL, "function ensureLoop(): void {"), "废弃实例仍会启动新循环")
      .toContain("!alive");
    

    expect(fnBody(RAIL, "function layout(): void {"), "layout 在 cleanup 后仍会画一整帧")
      .toContain("!alive");
  });

  it("cleanup 必须把两件事都做掉：终止令牌 + 停掉 running（少一件都还会漏）", () => {
    const body = fnBody(RAIL, "return () => {");
    expect(body, "没有 alive = false ⇒ 已排队的帧会活下来并续命").toContain("alive = false");
    expect(body, "没有 R.running = false ⇒ 外部事件还会启动新循环").toContain("R.running = false");
    
    const guards = RAIL.match(/!alive/g) ?? [];
    expect(guards.length, `只有 ${guards.length} 处 !alive 挡板，三条入口（frame/ensureLoop/layout）都要有`)
      .toBeGreaterThanOrEqual(3);
    
    expect(RAIL, "不许靠重建 canvas 掩盖泄漏：旧闭包会在废弃节点上继续 60fps")
      .not.toMatch(/<canvas[^>]*key=/);
  });
});


















describe("A-1119 — 设置面板留白地板（水平归内容区、垂直归面板自己）", () => {
  const DIALOG = codeOf("gui/src/renderer/pages/SettingsDialog.tsx");
  






  const ROOTS: Array<[string, string]> = [
    ["GeneralPanel", "gui/src/renderer/pages/GeneralPanel.tsx"],
    ["RuntimePanel", "gui/src/renderer/pages/RuntimePanel.tsx"],
    ["SkillsPanel", "gui/src/renderer/pages/SkillsPanel.tsx"],
    ["McpPanel", "gui/src/renderer/pages/McpPanel.tsx"],
    ["PermissionsPanel", "gui/src/renderer/pages/PermissionsPanel.tsx"],
    ["ProvidersPanel", "gui/src/renderer/pages/ProvidersPanel.tsx"],
    ["StatusPanel", "gui/src/renderer/pages/StatusPanel.tsx"],
    ["LlmGatewayPanel", "gui/src/renderer/pages/LlmGatewayPanel.tsx"],
    ["MindHubPanel", "gui/src/renderer/pages/MindHubPanel.tsx"],
    ["ResidentPanel", "gui/src/renderer/pages/ResidentPanel.tsx"],
    ["UsageStatsPanel", "gui/src/renderer/pages/UsageStatsPanel.tsx"],
    ["AgentsPanel", "gui/src/renderer/pages/AgentsPanel.tsx"],
    ["AppearancePanel", "gui/src/renderer/pages/AppearancePanel.tsx"],
  ];

  


  function paneTag(rel: string): string {
    const src = codeOf(rel);
    const i = src.indexOf('className="settings-pane"');
    expect(i, `${rel} 找不到 .settings-pane 根容器 —— 结构变了，本守卫需同步`)
      .toBeGreaterThanOrEqual(0);
    const j = src.indexOf(">", i);
    return src.slice(i, j + 1);
  }

  

  function leftOf(shorthand: string | undefined): number {
    if (shorthand === undefined) { return 0; }
    const p = shorthand.replace(/px/g, "").trim().split(/\s+/);
    return Number(p.length === 1 ? p[0] : p.length === 4 ? p[3] : p[1]);
  }

  it("内容区（共用祖先）必须给出左侧地板 —— 左边界是共用事实，只能有一个产地", () => {
    
    const m = /flex: 1, minWidth: 0, overflowY: "auto"[^\n]*paddingLeft: (\d+)/.exec(DIALOG);
    expect(m, "内容区找不到 paddingLeft —— 结构变了，本守卫需同步").not.toBeNull();
    expect(Number((m as RegExpExecArray)[1]), "内容区没给左地板 ⇒ 面板会顶到导航分割线")
      .toBeGreaterThanOrEqual(8);
  });

  it("内容区右侧也要留白（盖过对话框边界，避免内容贴边）", () => {
    const m = /flex: 1, minWidth: 0, overflowY: "auto"[^\n]*paddingRight: (\d+)/.exec(DIALOG);
    expect(m, "内容区找不到 paddingRight").not.toBeNull();
    expect(Number((m as RegExpExecArray)[1]), "右缘会贴住对话框边界").toBeGreaterThanOrEqual(8);
  });

  it.each(ROOTS)("%s 的根容器水平 padding 必须为 0（不许再有第二份地板）", (_name, rel) => {
    const line = paneTag(rel);
    const m = /padding: "([^"]+)"/.exec(line);
    expect(leftOf(m ? (m as RegExpExecArray)[1] : undefined),
      `${_name} 根容器又给了水平留白 ⇒ 与内容区叠加（16+16=32）`).toBe(0);
    

    expect(line, `${_name} 根容器不该出现显式 paddingLeft/Right`).not.toMatch(/padding(Left|Right):/);
  });

  it("外观面板根的**垂直**留白必须写出来（首版只让左右 ⇒ 页签顶到顶边）", () => {
    


    const line = paneTag("gui/src/renderer/pages/AppearancePanel.tsx");
    const top = /paddingTop: (\d+)/.exec(line);
    expect(top, "根容器没有 paddingTop ⇒ 页签/卡片会顶在内容区上沿").not.toBeNull();
    expect(Number((top as RegExpExecArray)[1])).toBeGreaterThanOrEqual(8);
    expect(line, "上下要成对（只给一边会让底部贴边）").toMatch(/paddingBottom: \d+/);
  });

  it("右栏滚动容器的右侧内边距必须盖过滚动条本身（否则卡片边框压在滚动条上）", () => {
    const m = /flex: 1, minWidth: 0, overflowY: "auto", paddingRight: (\d+)/.exec(PANEL);
    expect(m, "找不到右栏滚动容器 —— 结构变了，本守卫需要同步").not.toBeNull();
    expect(Number((m as RegExpExecArray)[1]), "小于滚动条宽度 = 卡片边框与滚动条重叠")
      .toBeGreaterThanOrEqual(8);
  });

  it("主题卡两列按钮必须仍能**并排不换行**（加留白会把可用宽挤窄）", () => {
    

    expect(PANEL).toContain('flex: "1 1 200px"');
    expect(PANEL).toMatch(/gap: 10/);
    
    expect(PANEL, "两栏结构变了，需重算并排所需的最小可用宽").toContain("width: 320");
  });
});
