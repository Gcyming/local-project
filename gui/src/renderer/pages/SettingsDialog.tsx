



import React, { type JSX } from "react";
import AgentsPanel, { type AgentLeaveGate } from "./AgentsPanel.js";
import ProvidersPanel from "./ProvidersPanel.js";
import StatusPanel from "./StatusPanel.js";
import MindHubPanel from "./MindHubPanel.js";
import SkillsPanel from "./SkillsPanel.js";
import McpPanel from "./McpPanel.js";

import PluginsPanel from "./PluginsPanel.js";
import PermissionsPanel from "./PermissionsPanel.js";
import GeneralPanel from "./GeneralPanel.js";

import AppearancePanel from "./AppearancePanel.js";
import ResidentPanel from "./ResidentPanel.js";
import RuntimePanel from "./RuntimePanel.js";
import UsageStatsPanel from "./UsageStatsPanel.js";
import LlmGatewayPanel from "./LlmGatewayPanel.js";

import SearchIndexPanel from "./SearchIndexPanel.js";
import type { DownloadProgressInfo } from "../../shared/ipc.js";
import { UiSlotPanel } from "../components/UiSlotHost.js";
import { SearchIcon, SettingsIcon, CloseIcon } from "../components/Icon.js";
import type { ThemeName } from "../theme.js";

export type SettingsTab = "mind" | "agents" | "providers" | "status" | "skills" | "mcp" | "plugins" | "permissions" | "general" | "appearance" | "resident" | "runtime" | "usage" | "experimental" | "searchengine" | `ui:${string}`;




type SectionGroup = "common" | "agent" | "ops" | "advanced";









const SECTION_GROUPS: Array<{ id: SectionGroup; label: string }> = [
  { id: "common", label: "常用" },
  { id: "agent", label: "Agent 与能力" },
  { id: "ops", label: "运行与维护" },
  { id: "advanced", label: "高级" },
];

interface SectionDef {
  id: SettingsTab;
  label: string;
  
  group: SectionGroup;
  keywords: string[];
  features: string[];
}















const SECTIONS: SectionDef[] = [
  
  {
    id: "general", label: "通用", group: "common",
    keywords: ["自启", "开机", "卸载", "启动", "general", "uninstall", "通知", "提示音", "铃声", "notification"],
    features: ["开机自启", "开机自动启动", "后台托盘", "退出到托盘", "关闭到托盘", "托盘常驻", "直接退出", "主题切换", "Alpha 主题", "Beta 主题", "毛玻璃", "深色主题", "上下文自动压缩", "自动压缩", "并发上限", "重连间隔", "请求频率", "开发模式", "自动更新", "卸载", "退出行为", "系统通知", "桌面通知", "弹窗通知", "通知提示音", "通知声音", "自定义提示音", "上传音频", "上传提示音", "铃声", "提示音开关", "任务完成通知", "错误通知", "意外终止通知", "测试通知"],
  },
  {
    
    
    id: "appearance", label: "外观", group: "common",
    keywords: ["外观", "主题", "theme", "配色", "颜色", "皮肤", "滚动条", "卷轴", "目录", "ui", "界面", "appearance"],
    features: ["界面主题", "Alpha", "Beta", "目录卷轴", "滚动条", "双线交织水波", "衬托", "隆起", "凹陷",
      "刻度", "波长", "振幅", "渐变", "端部渐隐", "对话页外观", "md 文档外观"],
  },
  {
    
    id: "permissions", label: "权限", group: "common",
    keywords: ["权限", "授权", "审批", "沙箱", "sandbox", "全局"],
    features: ["审批模式", "全局批准", "自定义白名单", "路径白名单", "沙箱级别", "自动批准", "需确认", "强制拒绝", "安全等级", "L0 L5", "图形控制", "screen", "工具权限类别", "全局功能开关"],
  },
  {
    
    id: "providers", label: "供应商", group: "common",
    keywords: ["模型", "密钥", "api", "provider", "本地模型", "llama"],
    features: ["API Key", "模型列表", "启用模型", "本地模型", "导入 GGUF", "llama.cpp", "参数文件", "推理等级", "上下文窗口", "vision", "多模态", "供应商密钥"],
  },

  
  {
    
    id: "agents", label: "Agent 管理", group: "agent",
    keywords: ["代理", "分裂", "身份", "agents", "agent"],
    features: ["创建 Agent", "分裂", "Fork", "导出身份", "导入身份", "删除 Agent", "模型配置", "推理强度", "思考显示", "工具能力", "技能白名单", "MCP 白名单", "自定义工具", "角色设定"],
  },
  {
    
    id: "mind", label: "心智中枢", group: "agent",
    keywords: ["记忆", "学习", "进化", "情绪", "向量", "embedding", "bge", "mind"],
    features: ["记忆向量", "BGE 嵌入", "embedding", "向量检索", "情绪状态", "人格进化", "在线学习", "知识库", "记忆检索", "RAG"],
  },
  {
    id: "skills", label: "技能库", group: "agent",
    keywords: ["技能", "skills", "skill"],
    features: ["技能市场", "GitHub 授权", "安装技能", "删除技能", "启用", "停用", "搜索技能", "技能目录", "自定义技能", "SKILL.md"],
  },
  {
    id: "mcp", label: "MCP 接入", group: "agent",
    keywords: ["mcp", "工具", "服务器", "连接"],
    features: ["新增服务器", "启用", "停用", "删除服务器", "OAuth", "令牌", "工具权限", "远程 MCP", "stdio", "配置示例"],
  },
  {
    
    
    
    
    id: "plugins", label: "扩展", group: "agent",
    keywords: ["插件", "plugin", "扩展", "来源", "自建", "清单", "origin"],
    features: ["扩展总览", "指令层", "能力层", "技能指导", "MCP 工具来源", "来源构成",
      "Agent 自建", "官方市场", "用户自备", "未声明", "origin 声明", "stdio", "http", "去技能库管理"],
  },
  {
    id: "resident", label: "后台任务", group: "agent",
    keywords: ["定时", "cron", "子代理", "subagent", "后台", "resident", "常驻", "schedule"],
    features: ["定时任务", "cron", "子代理", "派发", "触发", "暂停", "恢复", "删除任务", "执行记录", "预设模板", "后台常驻", "深度研究", "代码审查", "每日摘要", "数据处理", "子代理默认模型", "选拔派发"],
  },

  
  {
    id: "runtime", label: "运行环境", group: "ops",
    keywords: ["node", "python", "git", "运行时", "附件", "配套", "runtime", "venv", "环境"],
    features: ["Node.js", "Python", "Git", "venv", "虚拟环境", "附件目录", "ADB", "HTTP 服务", "端口配置", "二进制依赖"],
  },
  {
    
    
    id: "searchengine", label: "搜索索引", group: "ops",
    keywords: ["搜索", "索引", "爬虫", "收录", "全网", "search", "index", "crawl"],
    features: ["自建索引", "全网索引", "索引服务", "启动索引", "停止索引", "一键收录", "爬取站点",
      "索引页数", "索引词条", "端口 8600", "本地搜索服务", "补充命中"],
  },
  {
    id: "usage", label: "使用统计", group: "ops",
    keywords: ["统计", "消耗", "token", "费用", "用量", "调用", "usage", "stats"],
    features: ["请求明细", "Token 消耗", "费用统计", "导出 CSV", "分页", "调用记录", "用量统计", "计费"],
  },
  {
    
    
    id: "status", label: "状态", group: "ops",
    keywords: ["服务器", "告警", "状态", "status"],
    features: ["服务器状态", "模型服务", "端口", "告警列表", "系统健康", "运行状态", "版本信息"],
  },

  
  {
    id: "experimental", label: "实验性", group: "advanced",
    keywords: ["网关", "转发", "openai", "代理", "gateway", "端口", "cherry studio", "实验", "试验", "experimental"],
    features: ["LLM 网关", "启用网关", "网关端口", "网关 API Key", "令牌管理", "速率限额", "日配额", "模型白名单", "调用示例", "OpenAI 兼容", "转发服务", "Cherry Studio"],
  },
];

interface Props {
  initialTab: SettingsTab;
  onClose: () => void;
  selectedAgentId?: string;
  onSelectAgent: () => void;
  onAgentsChanged: () => void;
  providerKeys: string[];
  localModels: Array<{ id: string; label: string; path: string }>;
  dl?: Record<string, DownloadProgressInfo>;
  theme?: ThemeName;
  onThemeChange?: (t: ThemeName) => void;
}

/** 设置页的人类可读名（弹窗文案里要说清"离开去干什么"，不能只丢一个英文 id）。 */
function sectionLabel(id: SettingsTab): string {
  return SECTIONS.find((s) => s.id === id)?.label ?? id;
}

const SettingsDialog = React.memo(function SettingsDialog(props: Props): JSX.Element {
  const [tab, setTab] = React.useState<SettingsTab>(props.initialTab);
  const [query, setQuery] = React.useState("");

  /* ── A-1197：外壳这一侧的离开闸门 ────────────────────────────────────
   *
   *  未保存的 Agent 改动只有三个去处会把它弄丢：切 Agent（面板内自己拦）、
   *  **关掉这个设置弹窗**、**在设置里切到别的页**。后两个手势只发生在外壳，
   *  而判脏的那份数据（`detail` 快照）在 AgentsPanel 里 —— 所以外壳不自己判脏，
   *  而是持有面板注册上来的闸门（见 `onRegisterLeaveGate`）。
   *
   *  为什么是 **ref 而不是 state**：`isDirty()` 是**每次手势当场问一次**的活判据，
   *  不是要渲染出来的值。存进 state 就得在每次编辑时同步（面板每敲一个键都 setState，
   *  整棵设置树跟着重渲），而且同步漏一次 = 外壳拿着过期判据静默放行 ——
   *  比"没有闸门"更难查。ref 里存的是**闸门实现**（活读面板闭包），本身永不过期。
   *
   *  ⚠️ 面板不在当前页时（用户已切到别的设置页）闸门为 null：此时**没有可丢的未保存改动**
   *  （面板已卸载 ⇒ `detail` 没了），直接放行即可，不必拦。 */
  const shellGateRef = React.useRef<AgentLeaveGate | null>(null);
  const registerLeaveGate = React.useCallback((gate: AgentLeaveGate | null): void => {
    shellGateRef.current = gate;
  }, []);

  /** 无脏 / 已勾「以后不再」/ 面板不在本页 ⇒ 直接执行；有脏 ⇒ 交给面板弹窗等确认。
   *  ⚠️ 刻意**不叫** `requestLeave`：那是闸门上的方法名（`gate.requestLeave`），
   *  同名会让"外壳自己写了一个 requestLeave"与"外壳调了闸门的 requestLeave"在文本上
   *  混成一件 —— 守卫也就没法分辨第二产地了。 */
  function leaveViaGate(label: string, run: () => void): void {
    const gate = shellGateRef.current;
    if (!gate) { run(); return; }
    /* 确认弹窗已经挂着（面板内自己弹的）⇒ 让位给那个弹窗：否则用户点遮罩 / 按 Esc
     * 会在还没回答"要不要放弃"时先把整个设置弹窗关掉 —— 弹窗留在一个已卸载的面板上。 */
    if (gate.isConfirming()) { return; }
    gate.requestLeave({ label, run });
  }

  /** 请求关闭设置弹窗（遮罩 / 关闭按钮 / Esc 三条路都汇到这儿）。 */
  function requestClose(): void {
    leaveViaGate("关闭设置", () => { props.onClose(); });
  }

  /** 请求切到另一个设置页。`clearQuery` 供「从别的页跳过来」用（跳转要顺手清掉搜索词）。 */
  function requestTab(next: SettingsTab, clearQuery = false): void {
    leaveViaGate(`切到「${labelOf(next)}」`, () => {
      setTab(next);
      if (clearQuery) { setQuery(""); }
    });
  }

  /* A-1197：Esc 也是「关掉设置弹窗」的一条真实路径，必须与遮罩 / 关闭按钮同一个闸门
   * —— 只挂前两者而漏掉 Esc，等于给键盘用户留了一个无提示的丢改动入口。
   * 挂 window（而非卡片）：焦点可能在搜索框 / 侧栏按钮上，卡片级 onKeyDown 收不到。 */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") { return; }
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
    // 只在挂载期订一次：requestClose 读的是 ref + props.onClose，永远是最新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    setTab(props.initialTab);
    setQuery("");
  }, [props.initialTab]);

  const q = query.trim().toLowerCase();
  /* A-1197 · B2（L4a）：扩展声明的 `settings_panel` 动态追加为设置页（声明即出现；
     `plugins_changed` 一到就重拉全量 ⇒ 卸载/禁用后该页随之消失，不留幽灵页）。 */
  const [uiSections, setUiSections] = React.useState<SectionDef[]>([]);
  React.useEffect(() => {
    let alive = true;
    const a = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const pull = async (): Promise<void> => {
      const res = await (a?.extras?.pluginsUi?.() as Promise<{ slots?: Array<{ slot: string; plugin: string; id: string; title?: string }> } | null | undefined>).catch(() => null);
      const slots = Array.isArray(res?.slots) ? res.slots.filter((s) => s.slot === "settings_panel") : [];
      if (!alive) { return; }
      setUiSections(slots.map((s) => ({
        id: `ui:${s.plugin}:${s.id}`,
        label: s.title ?? s.id,
        group: "common" as SectionGroup,
        keywords: [s.plugin, "扩展", "插件"],
        features: [`${s.plugin} 的专属设置页`],
      })));
    };
    void pull();
    const off = a?.extras?.pluginsOnChanged?.(() => { void pull(); });
    return () => { alive = false; if (typeof off === "function") { off(); } };
  }, []);
  /** 设置页的人类可读名（含扩展动态页）。 */
  const labelOf = (id: SettingsTab): string =>
    uiSections.find((s) => s.id === id)?.label ?? sectionLabel(id);
  const allSections = React.useMemo<SectionDef[]>(() => [...SECTIONS, ...uiSections], [uiSections]);
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
  
  
  const filtered = tokens.length > 0
    ? allSections.filter((s) => {
        const terms = [s.id, s.label, ...s.keywords, ...s.features].map((k) => k.toLowerCase());
        return tokens.every((tk) => terms.some((k) => k.includes(tk)));
      })
    : allSections;
  
  const matchedOf = (s: SectionDef): string[] => tokens.length > 0
    ? s.features.filter((f) => tokens.some((tk) => f.toLowerCase().includes(tk)))
    : [];
  /* A-1197：搜索框也是「切到别的设置页」的一条路径 —— `activeTab` 是从 query **派生**的，
   *  所以在搜索框敲一个字就能把「Agent 管理」从 filtered 里滤掉 ⇒ AgentsPanel 被卸载 ⇒
   *  未保存改动当场消失，而且**连一次点击都没有**（用户压根不觉得自己"切了页"）。
   *
   *  这里不能弹窗（每敲一个键弹一次 = 骚扰到没法打字），也不该静默放行，
   *  所以改成**钉住**：Agent 页有未保存改动时，搜索不再把本页顶掉，
   *  并在搜索框下方明确说清为什么（要出声，不要静默）。
   *  读 ref 而非 state：`isDirty()` 是活判据，钉住与否每次渲染重算一次即可，不需要存。 */
  const pinnedByUnsaved = tab === "agents" && shellGateRef.current?.isDirty() === true;
  const activeTab = pinnedByUnsaved
    ? "agents"
    : (filtered.some((s) => s.id === tab) ? tab : (filtered[0]?.id ?? tab));

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 90,
      
      
      background: "rgba(2, 6, 23, 0.78)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}
      onClick={(e) => { if (e.target === e.currentTarget) { requestClose(); } }}>
      <div style={{
        width: 1180, maxWidth: "96vw", height: "84vh", maxHeight: "90vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
        
        
        
        
      }} className="modal-card">
        <div style={{ display: "flex", alignItems: "center", padding: "4px 16px", borderBottom: "1px solid var(--border)", minHeight: 44 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 7 }}>
            <SettingsIcon size={18} /> 设置
          </span>
          <span style={{ flex: 1 }} />
          <button className="titlebar-btn" title="关闭设置" onClick={requestClose}><CloseIcon size={14} /></button>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <aside style={{
            width: 224, minWidth: 224, borderRight: "1px solid var(--border)",
            display: "flex", flexDirection: "column", padding: "10px 8px",
          }}>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <SearchIcon size={16} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", opacity: 0.55, pointerEvents: "none" }} />
              <input
                className="input-field" autoFocus
                style={{ width: "100%", fontSize: 12.5, paddingLeft: 28 }}
                placeholder="搜索具体功能（如：开机 / 导出 CSV / 图形控制）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {/*
              2026-10-08（用户实测）：此处原有一块「[Agent 管理] 有未保存改动，已暂时固定在
              本书页…」的黄色**文字提示** —— 用户明确要求去掉（「左侧没必要加这个提示，
              只要有个弹窗就够了」）。**钉住行为本身保留**（见 `pinnedByUnsaved`：搜索词
              不得把未保存的 Agent 页顶掉，否则面板被卸载 = 改动静默丢失），只是不再常驻
              一段说明文字；用户真正需要被拦的那一刻（切页/关窗）有确认弹窗兜底。 */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {(() => {
                





                const renderItem = (s: SectionDef): JSX.Element => {
                  const matched = matchedOf(s);
                  return (
                    <button key={s.id}
                      onClick={() => requestTab(s.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%",
                        textAlign: "left", padding: "9px 12px", marginBottom: 3,
                        borderRadius: 8, cursor: "pointer", fontSize: 13,
                        background: activeTab === s.id ? "var(--accent-soft)" : "transparent",
                        border: "none", color: activeTab === s.id ? "var(--accent-hover)" : "var(--text)",
                        fontWeight: activeTab === s.id ? 700 : 600,
                      }}>
                      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                        <span>{s.label}</span>
                        {}
                        {matched.length > 0 && (
                          <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--accent)", opacity: 0.85,
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {matched.slice(0, 2).join(" / ")}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                };
                if (tokens.length > 0) { return filtered.map(renderItem); }
                return SECTION_GROUPS.map((g) => {
                  const items = filtered.filter((s) => s.group === g.id);
                  if (items.length === 0) { return null; }
                  return (
                    <React.Fragment key={g.id}>
                      <div className="settings-group-title">{g.label}</div>
                      {items.map(renderItem)}
                    </React.Fragment>
                  );
                });
              })()}
              {filtered.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--text-dim)", padding: 12, textAlign: "center" }}>
                  无匹配设置项
                </div>
              )}
            </div>
          </aside>

          {









}
          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", overflowX: "hidden", paddingLeft: 16, paddingRight: 10 }}>
            {activeTab === "general" && <GeneralPanel />}
            {activeTab === "appearance" && <AppearancePanel theme={props.theme} onThemeChange={props.onThemeChange} />}
            {activeTab === "runtime" && <RuntimePanel />}
            {activeTab === "searchengine" && <SearchIndexPanel />}
            {activeTab === "resident" && <ResidentPanel />}
            {activeTab === "mind" && <MindHubPanel selectedAgentId={props.selectedAgentId} dl={props.dl} />}
            {activeTab === "agents" && (
              <AgentsPanel
                selectedAgentId={props.selectedAgentId}
                onSelectAgent={props.onSelectAgent}
                onAgentsChanged={props.onAgentsChanged}
                providerKeys={props.providerKeys}
                localModels={props.localModels}
                onRegisterLeaveGate={registerLeaveGate}
              />
            )}
            {activeTab === "skills" && <SkillsPanel />}
            {activeTab === "mcp" && <McpPanel />}
            {activeTab === "plugins" && <PluginsPanel onNavigate={(t) => { requestTab(t, true); }} />}
            {/* A-1197 · B2（L4a）：扩展声明的 settings_panel —— `ui:<plugin>:<id>`。
                槽位不可用时 UiSlotPanel 自己如实说明（不留幽灵页、不空白）。 */}
            {typeof activeTab === "string" && activeTab.startsWith("ui:") && <UiSlotPanel slotKey={activeTab} />}
            {activeTab === "permissions" && <PermissionsPanel />}
            {activeTab === "providers" && <ProvidersPanel />}
            {activeTab === "status" && <StatusPanel />}
            {activeTab === "usage" && <UsageStatsPanel />}
            {}
            {activeTab === "experimental" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 10,
                  border: "1px dashed var(--warning)", background: "var(--warning)", opacity: 0.92 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", flexShrink: 0 }}>实验性功能</span>
                  <span style={{ fontSize: 12, color: "#0f172a", opacity: 0.85 }}>
                    以下能力已可用但属实验性配置，可能存在行为变化或稳定性风险；请仅在知晓后果的前提下调整。
                  </span>
                </div>
                <LlmGatewayPanel />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default SettingsDialog;
