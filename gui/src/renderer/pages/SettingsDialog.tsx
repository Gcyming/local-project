/**
 * gui/src/renderer/pages/SettingsDialog.tsx — 设置弹窗（左侧栏目 + 顶部搜索 + 右侧内容）。
 * 点击齿轮弹出（不再切换主区）；栏目：心智中枢 / Agent 管理 / 供应商 / 状态。
 */
import React, { type JSX } from "react";
import AgentsPanel from "./AgentsPanel.js";
import ProvidersPanel from "./ProvidersPanel.js";
import StatusPanel from "./StatusPanel.js";
import MindHubPanel from "./MindHubPanel.js";
import SkillsPanel from "./SkillsPanel.js";
import McpPanel from "./McpPanel.js";
import PermissionsPanel from "./PermissionsPanel.js";
import GeneralPanel from "./GeneralPanel.js";
import ResidentPanel from "./ResidentPanel.js";
import RuntimePanel from "./RuntimePanel.js";
import UsageStatsPanel from "./UsageStatsPanel.js";
import LlmGatewayPanel from "./LlmGatewayPanel.js";
import type { DownloadProgressInfo } from "../../shared/ipc.js";
import { SearchIcon, SettingsIcon, CloseIcon } from "../components/Icon.js";
import type { ThemeName } from "../theme.js";

export type SettingsTab = "mind" | "agents" | "providers" | "status" | "skills" | "mcp" | "permissions" | "general" | "resident" | "runtime" | "usage" | "experimental";

/** A-980-R23：设置栏目描述——keywords 负责栏目名/主题词；features 收编「栏目内具体功能名」，
 *  搜索命中任一词（含小写归一）即定位到该栏目，实现「精准搜到具体功能」 */
interface SectionDef {
  id: SettingsTab;
  label: string;
  keywords: string[];
  features: string[];
}

const SECTIONS: SectionDef[] = [
  {
    id: "general", label: "通用",
    keywords: ["自启", "开机", "卸载", "启动", "general", "uninstall", "通知", "提示音", "铃声", "notification"],
    features: ["开机自启", "开机自动启动", "后台托盘", "退出到托盘", "关闭到托盘", "托盘常驻", "直接退出", "主题切换", "Alpha 主题", "Beta 主题", "毛玻璃", "深色主题", "上下文自动压缩", "自动压缩", "并发上限", "重连间隔", "请求频率", "开发模式", "自动更新", "卸载", "退出行为", "系统通知", "桌面通知", "弹窗通知", "通知提示音", "通知声音", "自定义提示音", "上传音频", "上传提示音", "铃声", "提示音开关", "任务完成通知", "错误通知", "意外终止通知", "测试通知"],
  },
  {
    id: "runtime", label: "运行环境",
    keywords: ["node", "python", "git", "运行时", "附件", "配套", "runtime", "venv", "环境"],
    features: ["Node.js", "Python", "Git", "venv", "虚拟环境", "附件目录", "ADB", "HTTP 服务", "端口配置", "二进制依赖"],
  },
  {
    id: "usage", label: "使用统计",
    keywords: ["统计", "消耗", "token", "费用", "用量", "调用", "usage", "stats"],
    features: ["请求明细", "Token 消耗", "费用统计", "导出 CSV", "分页", "调用记录", "用量统计", "计费"],
  },
  {
    id: "mind", label: "心智中枢",
    keywords: ["记忆", "学习", "进化", "情绪", "向量", "embedding", "bge", "mind"],
    features: ["记忆向量", "BGE 嵌入", "embedding", "向量检索", "情绪状态", "人格进化", "在线学习", "知识库", "记忆检索", "RAG"],
  },
  {
    id: "agents", label: "Agent 管理",
    keywords: ["代理", "分裂", "身份", "agents", "agent"],
    features: ["创建 Agent", "分裂", "Fork", "导出身份", "导入身份", "删除 Agent", "模型配置", "推理强度", "思考显示", "工具能力", "技能白名单", "MCP 白名单", "自定义工具", "角色设定"],
  },
  {
    id: "resident", label: "后台任务",
    keywords: ["定时", "cron", "子代理", "subagent", "后台", "resident", "常驻", "schedule"],
    features: ["定时任务", "cron", "子代理", "派发", "触发", "暂停", "恢复", "删除任务", "执行记录", "预设模板", "后台常驻", "深度研究", "代码审查", "每日摘要", "数据处理", "子代理默认模型", "选拔派发"],
  },
  {
    id: "skills", label: "技能库",
    keywords: ["技能", "skills", "skill"],
    features: ["技能市场", "GitHub 授权", "安装技能", "删除技能", "启用", "停用", "搜索技能", "技能目录", "自定义技能", "SKILL.md"],
  },
  {
    id: "mcp", label: "MCP 接入",
    keywords: ["mcp", "工具", "服务器", "连接"],
    features: ["新增服务器", "启用", "停用", "删除服务器", "OAuth", "令牌", "工具权限", "远程 MCP", "stdio", "配置示例"],
  },
  {
    id: "permissions", label: "权限",
    keywords: ["权限", "授权", "审批", "沙箱", "sandbox", "全局"],
    features: ["审批模式", "全局批准", "自定义白名单", "路径白名单", "沙箱级别", "自动批准", "需确认", "强制拒绝", "安全等级", "L0 L5", "图形控制", "screen", "工具权限类别", "全局功能开关"],
  },
  {
    id: "providers", label: "供应商",
    keywords: ["模型", "密钥", "api", "provider", "本地模型", "llama"],
    features: ["API Key", "模型列表", "启用模型", "本地模型", "导入 GGUF", "llama.cpp", "参数文件", "推理等级", "上下文窗口", "vision", "多模态", "供应商密钥"],
  },
  {
    id: "status", label: "状态",
    keywords: ["服务器", "告警", "状态", "status"],
    features: ["服务器状态", "模型服务", "端口", "告警列表", "系统健康", "运行状态", "版本信息"],
  },
  {
    id: "experimental", label: "实验性",
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

const SettingsDialog = React.memo(function SettingsDialog(props: Props): JSX.Element {
  const [tab, setTab] = React.useState<SettingsTab>(props.initialTab);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    setTab(props.initialTab);
    setQuery("");
  }, [props.initialTab]);

  const q = query.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
  // A-980-R23：搜索索引 = 栏目 id + 栏目名 + 主题词 + **具体功能名**（features）。
  // 多关键词取 AND 语义（每个词都需命中栏目的某个索引词）→ 精准定位具体功能而非栏目海捞。
  const filtered = tokens.length > 0
    ? SECTIONS.filter((s) => {
        const terms = [s.id, s.label, ...s.keywords, ...s.features].map((k) => k.toLowerCase());
        return tokens.every((tk) => terms.some((k) => k.includes(tk)));
      })
    : SECTIONS;
  // 命中详情：列出查询词在 features 中命中的具体功能名（搜索态展示在栏目名下方）
  const matchedOf = (s: SectionDef): string[] => tokens.length > 0
    ? s.features.filter((f) => tokens.some((tk) => f.toLowerCase().includes(tk)))
    : [];
  const activeTab = filtered.some((s) => s.id === tab) ? tab : (filtered[0]?.id ?? tab);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 90,
      // A-918+ 性能修复：遮罩去 backdrop-filter（滚动面板时遮罩重新采样，叠加面板模糊双倍开销）；
      // 改为纯色遮罩 rgba(2,6,23,0.78)，视觉无损失，滚动流畅。
      background: "rgba(2, 6, 23, 0.78)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}
      onClick={(e) => { if (e.target === e.currentTarget) { props.onClose(); } }}>
      <div style={{
        width: 1180, maxWidth: "96vw", height: "84vh", maxHeight: "90vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
        // A-918+ 性能修复：面板本体去掉 backdropFilter blur——面板已是 rgba(10,16,32,0.9) 高不透明度，
        // backdrop-filter 每帧对面板区域模糊采样，滚动/切换 tab 时 GPU 持续重绘 → 设置面板卡成 PPT 的根因。
        // 改用纯实色底，视觉无损失（背景已几乎不透明），性能大幅提升。
        background: "rgba(10, 16, 32, 0.96)",
      }} className="card">
        <div style={{ display: "flex", alignItems: "center", padding: "4px 16px", borderBottom: "1px solid var(--border)", minHeight: 44 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 7 }}>
            <SettingsIcon size={18} /> 设置
          </span>
          <span style={{ flex: 1 }} />
          <button className="titlebar-btn" title="关闭设置" onClick={props.onClose}><CloseIcon size={14} /></button>
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
            <div style={{ flex: 1, overflowY: "auto" }}>
              {filtered.map((s) => {
                const matched = matchedOf(s);
                return (
                  <button key={s.id}
                    onClick={() => setTab(s.id)}
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
                      {/* A-980-R23：搜索态下直接展示命中的具体功能名，用户一眼定位到「自己想要的功能」 */}
                      {matched.length > 0 && (
                        <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--accent)", opacity: 0.85,
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {matched.slice(0, 2).join(" / ")}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--text-dim)", padding: 12, textAlign: "center" }}>
                  无匹配设置项
                </div>
              )}
            </div>
          </aside>

          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", overflowX: "hidden", paddingRight: 2 }}>
            {activeTab === "general" && <GeneralPanel theme={props.theme} onThemeChange={props.onThemeChange} />}
            {activeTab === "runtime" && <RuntimePanel />}
            {activeTab === "resident" && <ResidentPanel />}
            {activeTab === "mind" && <MindHubPanel selectedAgentId={props.selectedAgentId} dl={props.dl} />}
            {activeTab === "agents" && (
              <AgentsPanel
                selectedAgentId={props.selectedAgentId}
                onSelectAgent={props.onSelectAgent}
                onAgentsChanged={props.onAgentsChanged}
                providerKeys={props.providerKeys}
                localModels={props.localModels}
              />
            )}
            {activeTab === "skills" && <SkillsPanel />}
            {activeTab === "mcp" && <McpPanel />}
            {activeTab === "permissions" && <PermissionsPanel />}
            {activeTab === "providers" && <ProvidersPanel />}
            {activeTab === "status" && <StatusPanel />}
            {activeTab === "usage" && <UsageStatsPanel />}
            {/* A-980-R21：实验性栏目——网关功能收纳于此，附严谨性标注（能力可用但属实验性，配置风险自担） */}
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
