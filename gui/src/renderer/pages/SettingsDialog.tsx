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
// A-1115：外观 / UI 设定专栏（主题已从「通用」迁入本页）
import AppearancePanel from "./AppearancePanel.js";
import ResidentPanel from "./ResidentPanel.js";
import RuntimePanel from "./RuntimePanel.js";
import UsageStatsPanel from "./UsageStatsPanel.js";
import LlmGatewayPanel from "./LlmGatewayPanel.js";
import type { DownloadProgressInfo } from "../../shared/ipc.js";
import { SearchIcon, SettingsIcon, CloseIcon } from "../components/Icon.js";
import type { ThemeName } from "../theme.js";

export type SettingsTab = "mind" | "agents" | "providers" | "status" | "skills" | "mcp" | "permissions" | "general" | "appearance" | "resident" | "runtime" | "usage" | "experimental";

/** A-980-R23：设置栏目描述——keywords 负责栏目名/主题词；features 收编「栏目内具体功能名」，
 *  搜索命中任一词（含小写归一）即定位到该栏目，实现「精准搜到具体功能」 */
/** A-1125：设置栏目的**语义分组**（分组顺序 = 组在左栏的显示顺序）。 */
type SectionGroup = "common" | "agent" | "ops" | "advanced";

/** A-1125：分组标题（唯一出处；左栏按此顺序渲染，组内按 `SECTIONS` 里的先后）。
 *  依据（不靠感觉，两条都是权威一手口径）：
 *   ① **Android 官方设置规范**（developer.android.com/design/patterns/settings）：
 *      「11~15 项设置 ⇒ 用 **2~4 个分组分隔符**；最重要的单独项放**顶部且不加分隔**，
 *        其余按**重要性排序**；极低频/实验性的放底部」——本页 13 项，正好落在这个区间。
 *   ② **Nielsen Norman Group**「Alphabetical Sorting Must (Mostly) Die」：
 *      选项列表**不该**按字母或随意排，应按「**重要度或频率**」+ 逻辑结构。
 *  ⚠️ 组名只说"用户会怎么找"，不搬内部术语（NN/g Heuristic 2：用用户的语言）。 */
const SECTION_GROUPS: Array<{ id: SectionGroup; label: string }> = [
  { id: "common", label: "常用" },
  { id: "agent", label: "Agent 与能力" },
  { id: "ops", label: "运行与维护" },
  { id: "advanced", label: "高级" },
];

interface SectionDef {
  id: SettingsTab;
  label: string;
  /** A-1125：所属分组（决定它显示在哪个组标题下） */
  group: SectionGroup;
  keywords: string[];
  features: string[];
}

/* ⚠️⚠️ **顺序 = 频率 × 重要性**（A-1125 重排）。这是用户实测反馈「菜单排序很混乱」的修复。
 *
 * 排序依据（**别凭感觉再动**）：一手中证据是本项目自己的**深层入口跳转**与**齿轮按钮标题**——
 *   · `ChatPanel.tsx:4785-4791`：状态 / Agent 管理 / 供应商 三处会被**程序直接跳转**
 *     （用户遇到问题被引导过去 ⇒ 必须好找）；
 *   · `App.tsx:1685` 齿轮按钮 `title="设置（心智中枢 / Agent / 供应商 / 状态）"` ——
 *     这四个是被点名的高频栏目。
 * 通用规律同上（Android 规范 + NN/g）：**高频在前、低频在后、实验性垫底**。
 *
 * ⚠️ 本数组是**唯一产地**：栏目的显示顺序、分组归属、以及搜索索引（keywords/features）
 *    全在这里。重排时**每个字段都要逐字保留** —— 丢一个 feature 不会报错，
 *    只会让搜索"搜不到那个功能"（静默失效）。守卫
 *    `tests/gui/a1125-settings-order.spec.ts` 同时锁顺序与字段完整性。
 */
const SECTIONS: SectionDef[] = [
  // ── 组 ①「常用」：日常真的会去动的高频项（含 3 处程序跳转目标之一：供应商）────────
  {
    id: "general", label: "通用", group: "common",
    keywords: ["自启", "开机", "卸载", "启动", "general", "uninstall", "通知", "提示音", "铃声", "notification"],
    features: ["开机自启", "开机自动启动", "后台托盘", "退出到托盘", "关闭到托盘", "托盘常驻", "直接退出", "主题切换", "Alpha 主题", "Beta 主题", "毛玻璃", "深色主题", "上下文自动压缩", "自动压缩", "并发上限", "重连间隔", "请求频率", "开发模式", "自动更新", "卸载", "退出行为", "系统通知", "桌面通知", "弹窗通知", "通知提示音", "通知声音", "自定义提示音", "上传音频", "上传提示音", "铃声", "提示音开关", "任务完成通知", "错误通知", "意外终止通知", "测试通知"],
  },
  {
    // A-1115：外观 / UI 相关设定的**唯一入口**（主题已从「通用」迁来；目录卷轴参数也在这）
    // A-1125：升到第 2 位 —— 主题/卷轴是**改完立刻看得见**的高频项（用户近几轮反复在调）。
    id: "appearance", label: "外观", group: "common",
    keywords: ["外观", "主题", "theme", "配色", "颜色", "皮肤", "滚动条", "卷轴", "目录", "ui", "界面", "appearance"],
    features: ["界面主题", "Alpha", "Beta", "目录卷轴", "滚动条", "双线交织水波", "衬托", "隆起", "凹陷",
      "刻度", "波长", "振幅", "渐变", "端部渐隐", "对话页外观", "md 文档外观"],
  },
  {
    // A-1125：安全档位是"开关即授权"的落点（A-1057 用户点名过），且被程序跳转间接依赖 ⇒ 靠前。
    id: "permissions", label: "权限", group: "common",
    keywords: ["权限", "授权", "审批", "沙箱", "sandbox", "全局"],
    features: ["审批模式", "全局批准", "自定义白名单", "路径白名单", "沙箱级别", "自动批准", "需确认", "强制拒绝", "安全等级", "L0 L5", "图形控制", "screen", "工具权限类别", "全局功能开关"],
  },
  {
    // A-1125：**3 处程序跳转目标之一**（`ChatPanel.tsx:4791`）—— 没配好模型就什么都跑不了 ⇒ 高频必需项。
    id: "providers", label: "供应商", group: "common",
    keywords: ["模型", "密钥", "api", "provider", "本地模型", "llama"],
    features: ["API Key", "模型列表", "启用模型", "本地模型", "导入 GGUF", "llama.cpp", "参数文件", "推理等级", "上下文窗口", "vision", "多模态", "供应商密钥"],
  },

  // ── 组 ②「Agent 与能力」：配置 Agent 本体 / 给它加能力（中频，配一次用很久）──────────
  {
    // A-1125：**2 处程序跳转目标**（`App.tsx:1330/1851` + `ChatPanel.tsx:4788`）⇒ 组内第一。
    id: "agents", label: "Agent 管理", group: "agent",
    keywords: ["代理", "分裂", "身份", "agents", "agent"],
    features: ["创建 Agent", "分裂", "Fork", "导出身份", "导入身份", "删除 Agent", "模型配置", "推理强度", "思考显示", "工具能力", "技能白名单", "MCP 白名单", "自定义工具", "角色设定"],
  },
  {
    // A-1125：齿轮按钮标题点名（`App.tsx:1685`）⇒ 产品核心差异化（记忆/学习/进化），组内第二。
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
    id: "resident", label: "后台任务", group: "agent",
    keywords: ["定时", "cron", "子代理", "subagent", "后台", "resident", "常驻", "schedule"],
    features: ["定时任务", "cron", "子代理", "派发", "触发", "暂停", "恢复", "删除任务", "执行记录", "预设模板", "后台常驻", "深度研究", "代码审查", "每日摘要", "数据处理", "子代理默认模型", "选拔派发"],
  },

  // ── 组 ③「运行与维护」：装完基本不动，出问题才来查（低频，但排障必经）────────────
  {
    id: "runtime", label: "运行环境", group: "ops",
    keywords: ["node", "python", "git", "运行时", "附件", "配套", "runtime", "venv", "环境"],
    features: ["Node.js", "Python", "Git", "venv", "虚拟环境", "附件目录", "ADB", "HTTP 服务", "端口配置", "二进制依赖"],
  },
  {
    id: "usage", label: "使用统计", group: "ops",
    keywords: ["统计", "消耗", "token", "费用", "用量", "调用", "usage", "stats"],
    features: ["请求明细", "Token 消耗", "费用统计", "导出 CSV", "分页", "调用记录", "用量统计", "计费"],
  },
  {
    // A-1125：**3 处程序跳转目标之一**（`ChatPanel.tsx:4785`）—— 浏览频率低，但**排障第一入口**，
    //   故放在低频组里仍靠后无妨（有深层入口直达，不依赖用户扫左栏）。
    id: "status", label: "状态", group: "ops",
    keywords: ["服务器", "告警", "状态", "status"],
    features: ["服务器状态", "模型服务", "端口", "告警列表", "系统健康", "运行状态", "版本信息"],
  },

  // ── 组 ④「高级」：实验性 / 面向进阶用户（Android 规范：低频与实验性垫底）────────
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
        // A-1098：面板底改为共享的 `.modal-card`（= `--float-surface` 实底）。
        // 此前是 inline `rgba(10,16,32,0.96)` + `card` 类：那是"每个弹窗自己写一个近实底色"
        // 的写法（同语义多产地，改一处另一处就漂）。归一到 `.modal-card` 后，浮层不透字
        // 这条判据只有**一个出处**。padding 与 `.card` 相同，无布局位移。
      }} className="modal-card">
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
              {(() => {
                /* A-1125：左栏的两态渲染（**唯一产地**，搜索态与浏览态只在这里分叉一次）。
                   · 浏览态（无搜索词）：按 `SECTION_GROUPS` 分组渲染 —— 组标题 + 组内按 `SECTIONS` 先后；
                     空组不画标题（避免"光秃秃一个组名"）。
                   · 搜索态：保持**扁平**。此刻用户已明确知道自己要找什么（结果就是精准命中），
                     再插组标题只是噪音；且分组会让"命中项分属不同组"时显得零碎。
                   ⚠️ 无搜索时 `filtered === SECTIONS`（同一引用），所以组内顺序天然 = 上面的排序。 */
                const renderItem = (s: SectionDef): JSX.Element => {
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

          {/* A-1119：内容区**自己**提供左侧地板（A-1115 的贴边问题在这里被根治）。
              此前内容区只有 `paddingRight: 2`、没有 paddingLeft，左侧留白全靠各面板**自管**
              ——而各面板口径不一（`16` / `12` / `0 4px` / `6px 4px 16px` / `0`），谁写 0 谁就
              把内容顶到导航栏那条 `borderRight` 分割线上。实测「实验性」页面的黄色横幅
              `left` 与分割线 x 完全相等（gap = 0），其它 0/4px 口径的面板同族（只是底色浅，不显眼）。
              ⇒ 改成**内容区统一给左地板**，各面板根容器的 paddingLeft 一律归零：
                 · 左边界（导航分割线）是**共用**的 ⇒ 由共用祖先管（单一产地）
                 · 右边界是各面板自己的内容宽度 ⇒ 仍由面板自管（含滚动条让位）
              ⚠️ 地板值取 16 与既有 7 个面板的根 padding 相同 ⇒ 那 7 个面板**像素级零变化**
                 （16 从面板搬到内容区）。改这里时**必须**同步把面板根 paddingLeft 归零，
                 否则两产地叠加（16+16=32）。 */}
          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", overflowX: "hidden", paddingLeft: 16, paddingRight: 10 }}>
            {activeTab === "general" && <GeneralPanel />}
            {activeTab === "appearance" && <AppearancePanel theme={props.theme} onThemeChange={props.onThemeChange} />}
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
