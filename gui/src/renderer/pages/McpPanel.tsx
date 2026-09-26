/**
 * gui/src/renderer/pages/McpPanel.tsx — 设置「MCP 接入」专栏。
 * 从供应商界面剥离，独立管理：查看 MCP 服务器（来自 slime.toml [[mcp_servers]]）、
 * 启用/停用（注释/取消注释该块）。工具的开放与关闭受全局「权限」开关约束。
 */
import React, { type JSX } from "react";
import type { McpServerInfo } from "../../shared/ipc.js";
import { confirmAsync } from "../dialog.js";
import { marketSource } from "./marketView.js";
import { localizeServerTags } from "../../../../core-ts/src/services/marketLocalize.js";

/** A-918++：内置 MCP 插件广场目录（业界常用 MCP 服务器一键安装；envHint 提示需要的环境变量） */
const MCP_MARKETPLACE: Array<{
  name: string; desc: string; kind: "stdio" | "http"; command?: string; args?: string[]; url?: string; envHint?: string; tags?: string[];
}> = [
  { name: "filesystem", desc: "读写指定目录的本地文件（官方）", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "填你的工作目录"], tags: ["官方", "文件", "本地"] },
  { name: "fetch", desc: "抓取网页内容并转文本（HTML→Markdown）", kind: "stdio", command: "uvx", args: ["mcp-server-fetch"], tags: ["网络", "抓取"] },
  { name: "playwright", desc: "浏览器自动化：打开页面/点击/截图/填表", kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], tags: ["浏览器", "自动化", "测试"] },
  { name: "puppeteer", desc: "Chrome 浏览器自动化（截图/爬取/填表）", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"], tags: ["浏览器", "爬取"] },
  { name: "github", desc: "GitHub 仓库/议题/PR/搜索操作", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envHint: "GITHUB_TOKEN=ghp_xxx", tags: ["代码", "GitHub"] },
  { name: "gitlab", desc: "GitLab 仓库/MR/CI 操作", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-gitlab"], envHint: "GITLAB_TOKEN=glpat-xxx", tags: ["代码", "GitLab"] },
  { name: "brave-search", desc: "Brave 联网搜索（替代内置 web_search）", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], envHint: "BRAVE_API_KEY=xxx", tags: ["搜索", "网络"] },
  { name: "google-maps", desc: "Google Maps 地理编码/路径/地点查询", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-google-maps"], envHint: "GOOGLE_MAPS_API_KEY=xxx", tags: ["地图", "地理位置"] },
  { name: "memory", desc: "持久化记忆/知识图谱（官方）", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], tags: ["官方", "记忆", "知识图谱"] },
  { name: "sqlite", desc: "SQLite 数据库查询与分析", kind: "stdio", command: "uvx", args: ["mcp-server-sqlite", "--db-path", "data.db"], tags: ["数据库", "SQL"] },
  { name: "postgres", desc: "PostgreSQL 数据库（只读查询/Schema）", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"], envHint: "POSTGRES_URL=postgresql://user:pwd@host/db", tags: ["数据库", "PostgreSQL"] },
  { name: "redis", desc: "Redis KV 查询/列表/集合操作", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-redis"], envHint: "REDIS_URL=redis://localhost:6379", tags: ["数据库", "Redis"] },
  { name: "slack", desc: "Slack 频道/消息/文件操作", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], envHint: "SLACK_BOT_TOKEN=xoxb-xxx", tags: ["协作", "Slack"] },
  { name: "notion", desc: "Notion 页面/数据库/块读写", kind: "stdio", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], envHint: "NOTION_TOKEN=secret_xxx", tags: ["协作", "Notion"] },
  { name: "obsidian", desc: "Obsidian Vault 笔记搜索/读写", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-obsidian"], tags: ["笔记", "Obsidian"] },
  { name: "sentry", desc: "Sentry 错误监控/Issue/事件查询", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sentry"], envHint: "SENTRY_AUTH_TOKEN=sntrys_xxx", tags: ["监控", "Sentry"] },
  { name: "linear", desc: "Linear 团队任务/项目管理", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-linear"], envHint: "LINEAR_API_KEY=lin_api_xxx", tags: ["协作", "项目管理"] },
  { name: "context7", desc: "查询最新库文档（缓解模型训练数据陈旧）", kind: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], tags: ["文档", "代码"] },
  { name: "magic", desc: "Magic UI 组件生成（21st.dev）", kind: "stdio", command: "npx", args: ["-y", "@21st-dev/magic"], envHint: "TWENTYFIRST_API_KEY=xxx", tags: ["UI", "代码"] },
  { name: "airtable", desc: "Airtable 表/记录查询与编辑", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-airtable"], envHint: "AIRTABLE_API_KEY=patxxx", tags: ["数据", "Airtable"] },
];

export default function McpPanel(): JSX.Element {
  const api = React.useRef<any>(null);
  const [servers, setServers] = React.useState<McpServerInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  // A-918++：GUI 表单新增 MCP 服务器（此前只能手动编辑 slime.toml，小白无从下手）
  const [addOpen, setAddOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [form, setForm] = React.useState<{ name: string; kind: "stdio" | "http"; command: string; args: string; url: string; env: string }>({
    name: "", kind: "stdio", command: "", args: "", url: "", env: "",
  });
  // A-918++：插件广场（官方 registry 联网优先 + 预制兜底）
  const [marketOpen, setMarketOpen] = React.useState(false);
  const [installing, setInstalling] = React.useState<string | null>(null);
  // A-918++：广场搜索/过滤
  const [marketQuery, setMarketQuery] = React.useState("");
  // A-918++：官方 registry 联网结果（Linux Foundation MCP registry）
  const [registryServers, setRegistryServers] = React.useState<Array<{
    name: string; displayName: string; description: string; source: string;
    install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string };
  }> | null>(null);
  const [registryLoading, setRegistryLoading] = React.useState(false);
  const [registryError, setRegistryError] = React.useState("");
  // A-1106：**最近一次生效的搜索词** —— 列表「归谁」只由它决定（空 = 内置精选视图）。
  // 不能直接用 `marketQuery` 判定：那样用户一打字、还没回车，列表就会在两种数据源间跳变。
  const [registryQuery, setRegistryQuery] = React.useState("");
  // A-1106：**真正发给上游的检索词**（中文输入会被展开成英文）+ 「没认出来」标记。
  // 两者都只用于**如实显示**——用户搜了中文，界面必须说清实际搜的是什么（不许静默）。
  const [registryApplied, setRegistryApplied] = React.useState("");
  const [registryUnrecognized, setRegistryUnrecognized] = React.useState(false);
  // A-918++：列表只渲染前 20 条（防 60+ 卡片全量渲染卡顿）+「显示更多」
  const [showAll, setShowAll] = React.useState(false);

  /** 联网拉取官方 MCP registry（**只在用户主动搜索时**调用；空词 = 重置回内置精选） */
  const loadRegistry = React.useCallback(async (force = false, q = ""): Promise<void> => {
    if (!api.current?.extras?.mcpRegistrySearch) { return; }
    if (!force && registryServers !== null && !q) { return; }
    const term = q.trim();
    setRegistryLoading(true);
    setRegistryError("");
    try {
      const res = await api.current.extras.mcpRegistrySearch(term || undefined);
      if (res?.ok && Array.isArray(res.servers)) {
        setRegistryServers(res.servers);
        // A-1106：只有「用户主动搜索且搜到了」才让 registry 结果接管列表；空词 = 回到内置精选
        setRegistryQuery(term);
        // 如实记录"上游实际收到的检索词"（中文会被展开成英文）与"没认出来"
        setRegistryApplied(res.appliedQuery ?? term);
        setRegistryUnrecognized(res.unrecognized === true);
      } else { setRegistryError(res?.error ?? "联网搜索失败"); }
    } catch (e) {
      setRegistryError(`联网搜索失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRegistryLoading(false);
    }
  }, [registryServers]);

  // A-1106：**打开广场不再自动联网**（原为 `if (marketOpen) { void loadRegistry(); }`）。
  // 旧行为：一打开就拉全量 registry，网络返回后 `hasRegistry` 把整个列表替换成 registry 的
  // 30 条按字母序通用目录项（`ac.inference.sh/mcp` 之类），用户正想装的内置精选
  // （filesystem / playwright / memory …，只有它们带准确安装命令）**当场消失、无声无息**
  // —— 用户报「刚打开是内置精选，过一会就变成 registry 了」。
  // 现在：内置精选常驻；registry 只在用户按回车 / 点「联网搜索」时接管（见下方 useRegistry）。
  React.useEffect(() => {
    if (marketOpen) { setShowAll(false); }
  }, [marketOpen]);

  /** 从官方 registry 一键安装 */
  async function installFromRegistry(card: {
    name: string; displayName: string; description: string; source: string;
    install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string };
  }): Promise<void> {
    if (!api.current?.extras?.mcpRegistryInstall) { return; }
    setInstalling(card.name);
    try {
      const res = await api.current.extras.mcpRegistryInstall(card);
      if (res?.ok) {
        showNotice(true, `已安装「${card.displayName || card.name}」到 slime.toml（启用后生效）`);
        await load();
      } else {
        showNotice(false, res?.error ?? "安装失败");
      }
    } catch (e) {
      showNotice(false, `安装失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(null);
    }
  }

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 3500);
  };

  const load = React.useCallback(async (): Promise<void> => {
    if (!api.current?.extras?.mcpList) { return; }
    try {
      const list = await api.current.extras.mcpList();
      setServers(list);
    } catch (e) {
      console.error("[mcp] list failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    void load();
  }, [load]);

  /** 一键安装插件广场目录项 */
  async function installFromMarket(item: typeof MCP_MARKETPLACE[number]): Promise<void> {
    if (!api.current?.extras?.mcpAdd) { return; }
    setInstalling(item.name);
    try {
      const env: Record<string, string> = {};
      if (item.envHint) {
        const eq = item.envHint.indexOf("=");
        if (eq > 0) { env[item.envHint.slice(0, eq).trim()] = item.envHint.slice(eq + 1).trim(); }
      }
      const res = await api.current.extras.mcpAdd({
        name: item.name,
        kind: item.kind,
        command: item.command,
        args: item.args,
        url: item.url,
        env: Object.keys(env).length > 0 ? env : undefined,
        force: true, // A-918++：内置精选为可信源，跳过危险特征检测
      });
      if (res?.ok) {
        showNotice(true, `MCP 服务器「${item.name}」已安装${item.envHint ? `，请补全环境变量 ${item.envHint.split("=")[0]}` : ""}`);
        await load();
      } else {
        showNotice(false, res?.error ?? "安装失败");
      }
    } catch (e) {
      showNotice(false, `安装失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(null);
    }
  }

  /** 提交新增 MCP 服务器表单 */
  async function submitAdd(force = false): Promise<void> {
    if (!api.current?.extras?.mcpAdd) { return; }
    if (!form.name.trim()) { showNotice(false, "名称必填"); return; }
    if (form.kind === "stdio" && !form.command.trim()) { showNotice(false, "stdio 类型的 command 必填"); return; }
    if (form.kind === "http" && !form.url.trim()) { showNotice(false, "http 类型的 url 必填"); return; }
    setAdding(true);
    try {
      const args = form.args.trim() ? form.args.trim().split(/\s+/).filter(Boolean) : undefined;
      const env: Record<string, string> = {};
      for (const line of form.env.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) { continue; }
        const eq = t.indexOf("=");
        if (eq > 0) { env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim(); }
      }
      const res = await api.current.extras.mcpAdd({
        name: form.name.trim(),
        kind: form.kind,
        command: form.kind === "stdio" ? form.command.trim() : undefined,
        args,
        url: form.kind === "http" ? form.url.trim() : undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        force,
      });
      // A-918++：命中危险特征 → 二次确认后 force 重发（安全护栏）
      if (!res?.ok && res?.riskWarning && Array.isArray(res.riskWarning) && !force) {
        const yes = await confirmAsync(
          `命令含可疑特征，确定继续添加「${form.name.trim()}」？`,
          `检测到：${res.riskWarning.join("、")}\n\n仅在你确认来源可信时继续。`,
        );
        if (yes) { await submitAdd(true); }
        else { showNotice(false, "已取消（命令含可疑特征）"); }
        return;
      }
      if (res?.ok) {
        showNotice(true, `MCP 服务器「${form.name.trim()}」已添加`);
        setForm({ name: "", kind: "stdio", command: "", args: "", url: "", env: "" });
        setAddOpen(false);
        await load();
      } else {
        showNotice(false, res?.error ?? "添加失败");
      }
    } catch (e) {
      showNotice(false, `添加失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAdding(false);
    }
  }

  async function toggle(m: McpServerInfo): Promise<void> {
    if (!api.current?.extras?.mcpToggle) { return; }
    setBusy(m.name);
    try {
      const res = await api.current.extras.mcpToggle(m.name, !m.enabled);
      if (res?.ok) {
        showNotice(true, `MCP 服务器「${m.name}」已${m.enabled ? "停用" : "启用"}`);
        await load();
      } else {
        showNotice(false, res?.error ?? "操作失败");
      }
    } catch (e) {
      showNotice(false, `操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  /** 打开 MCP 配置所在目录（slime.toml 项目根） */
  async function openFolder(): Promise<void> {
    if (!api.current?.extras?.mcpOpen) { return; }
    const res = await api.current.extras.mcpOpen().catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!res?.ok) {
      showNotice(false, res?.error ?? "打开失败");
    }
  }

  /** 删除 MCP 服务器（从 slime.toml 移除块） */
  async function remove(m: McpServerInfo): Promise<void> {
    if (!api.current?.extras?.mcpDelete) { return; }
    if (!(await confirmAsync(`确定删除 MCP 服务器「${m.name}」？`, "其 [[mcp_servers]] 配置块将从 slime.toml 移除（自动备份 .bak）。"))) { return; }
    setBusy(m.name);
    try {
      const res = await api.current.extras.mcpDelete(m.name);
      if (res?.ok) {
        showNotice(true, `MCP 服务器「${m.name}」已删除`);
        await load();
      } else {
        showNotice(false, res?.error ?? "删除失败");
      }
    } catch (e) {
      showNotice(false, `删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    /* A-1119：左地板归 `SettingsDialog` 内容区（16px），此处 paddingLeft 必须为 0（否则叠加成 32）。 */
    <div className="settings-pane" style={{ padding: "16px 0", overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ fontSize: 18, margin: 0, flex: 1 }}>MCP 接入</h2>
        <button className="btn" style={{ padding: "5px 12px", fontSize: 12.5, marginRight: 8 }}
          onClick={() => { setMarketOpen((v) => !v); if (!marketOpen) { setAddOpen(false); } }}>
          {marketOpen ? "收起广场" : "🛒 插件广场"}
        </button>
        <button className="btn primary" style={{ padding: "5px 14px", fontSize: 12.5, marginRight: 10 }}
          onClick={() => { setAddOpen((v) => !v); if (!addOpen) { setMarketOpen(false); } }}>
          {addOpen ? "收起" : "＋ 添加服务器"}
        </button>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          启用 {servers.filter((s) => s.enabled).length} / {servers.length}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 14 }}>
        配置位于 slime.toml 的 [[mcp_servers]] 中。停用即注释掉对应配置块（自动备份 .bak）；
        本专栏负责接入/开关，协议的详细调试仍在供应商弹窗的「参数文件调试」里。
      </div>

      {/* A-918++：GUI 表单新增 MCP 服务器（直达，不再要求手动编辑 slime.toml） */}
      {/* A-1015：常驻 + 高度插值（此前 `{addOpen && …}` 展开/收起都是瞬时跳变，与侧栏节奏不一致）。
          wrapper 两层是必需的：.collapse(grid 容器) > 纯 div(grid 行，负责 overflow 裁切) → 原卡片。
          内容缩进**刻意不动**——这一带刚出过结构事故（A-999），只加壳不重排，把 diff 压到最小。 */}
      <div className={`collapse${addOpen ? " is-open" : ""}`}>
      <div>
        <div className="card" style={{ padding: "14px 16px", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>添加 MCP 服务器</div>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "10px 12px", alignItems: "center" }}>
            <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>名称</label>
            <input className="input-field" style={{ padding: "6px 10px", fontSize: 12.5 }} placeholder="如 filesystem / fetch / github"
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />

            <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>类型</label>
            <div style={{ display: "flex", gap: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer" }}>
                <input type="radio" checked={form.kind === "stdio"} onChange={() => setForm({ ...form, kind: "stdio" })} />
                stdio（本地命令）
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer" }}>
                <input type="radio" checked={form.kind === "http"} onChange={() => setForm({ ...form, kind: "http" })} />
                HTTP（远程服务）
              </label>
            </div>

            {form.kind === "stdio" ? (
              <>
                <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>命令 command</label>
                <input className="input-field" style={{ padding: "6px 10px", fontSize: 12.5 }} placeholder="如 npx / node / uvx"
                  value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
                <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>参数 args</label>
                <input className="input-field" style={{ padding: "6px 10px", fontSize: 12.5 }}
                  placeholder='空格分隔，如 -y @modelcontextprotocol/server-filesystem /path/to/dir'
                  value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
              </>
            ) : (
              <>
                <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>URL</label>
                <input className="input-field" style={{ padding: "6px 10px", fontSize: 12.5 }} placeholder="https://…"
                  value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </>
            )}

            <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>环境变量（可选）</label>
            <textarea className="input-field" rows={2} style={{ padding: "6px 10px", fontSize: 12, fontFamily: "Consolas, monospace", resize: "vertical" }}
              placeholder={"每行一个 KEY=VALUE，如：\nGITHUB_TOKEN=ghp_xxx\nAPI_KEY=sk_xxx"}
              value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button className="btn primary" style={{ padding: "6px 16px", fontSize: 12.5 }} disabled={adding}
              onClick={() => void submitAdd()}>
              {adding ? "添加中…" : "添加"}
            </button>
            <button className="btn" style={{ padding: "6px 14px", fontSize: 12.5 }}
              onClick={() => { setAddOpen(false); setForm({ name: "", kind: "stdio", command: "", args: "", url: "", env: "" }); }}>
              取消
            </button>
            <span style={{ fontSize: 11, color: "var(--text-dim)", alignSelf: "center" }}>
              添加后自动写入 slime.toml 并出现在上方列表，启用后即可被工具调用
            </span>
          </div>
        </div>
      </div>
      </div>

      {/* A-918++：插件广场——官方 MCP registry（Linux Foundation）联网搜索 + 内置精选兜底 */}
      {/* A-1015：同样常驻 + 高度插值。常驻后的额外成本可忽略：搜索框只在 marketOpen
          时可见，所以 marketQuery 变化必然发生在展开态，不存在"收起时因输入而重渲染列表"。 */}
      <div className={`collapse${marketOpen ? " is-open" : ""}`}>
      <div>
      {(() => {
        const q = marketQuery.trim().toLowerCase();
        const regList = (registryServers ?? []).map((s) => ({ ...s, __registry: true as const }));
        const builtinList = MCP_MARKETPLACE.map((m) => ({ ...m, name: m.name, desc: m.desc, tags: m.tags }));
        // A-1106：**registry 结果只在用户主动搜索过（registryQuery 非空）时才接管列表**。
        // 旧的 `hasRegistry` 只看「联网是否拿到数据」⇒ 打开广场自动联网一返回，内置精选就被
        // registry 全量目录无声替换掉（用户报的症状）。现在内置精选是默认视图、永不被替换。
        // ⚠️ 判据**不在这里内联**：唯一出处是 `marketView.ts` 的 `marketSource()`（纯逻辑、可测）。
        //    内联一份 = 两个产地，改一处漏一处（A-1100 同型）。
        const useRegistry = marketSource(registryQuery, registryServers?.length ?? 0) === "registry";
        const viewList: Array<{ name: string; desc: string; tags?: string[]; registry: boolean; installCmd?: string; needEnv?: boolean; kind?: string }> =
          useRegistry
            ? regList.map((s) => ({
                name: s.displayName, desc: s.description, registry: true,
                // A-1106：registry 的描述是**英文原文**，给人一眼看得懂的**中文类别标签**
                // （唯一出处 `marketLocalize.localizeServerTags`，不翻译整句以免半中半英）。
                tags: localizeServerTags(s.displayName, s.description),
                installCmd: s.install?.kind === "stdio" ? `${s.install.command} ${s.install.args.join(" ")}` : s.install?.kind === "http" ? s.install.url : "",
                needEnv: (s.install?.kind === "stdio" && s.install.envHints.length > 0) || false,
                kind: s.install?.kind,
              }))
            : builtinList.map((m) => ({ name: m.name, desc: m.desc, tags: m.tags, registry: false }));
        /* A-1106：本地二次过滤**只对内置精选做**。
           registry 的结果**已经由上游按检索词筛过**（检索词还可能被 `expandMarketQuery`
           展开成英文）——此处若再拿用户输入的**中文**去比英文字段，必然全部落空 ⇒ 得到空列表。
           （这正是"修一个坏一个"的典型形态：不处理它，中文搜索会稳定显示"没找到"。） */
        const filtered = !useRegistry && q
          ? viewList.filter((it) => it.name.toLowerCase().includes(q) || it.desc.toLowerCase().includes(q) || (it.tags ?? []).some((t) => t.toLowerCase().includes(q)))
          : viewList;
        const LIMIT = 20;
        const visible = (showAll || q) ? filtered : filtered.slice(0, LIMIT);
        const installedSet = new Set(servers.map((s) => s.name));
        return (
        <div className="card" style={{ padding: "14px 16px", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>
              插件广场{useRegistry ? ` · 官方目录 ${filtered.length}` : ` · 内置精选 ${filtered.length}`}
            </div>
            <input className="input-field" style={{ width: 230, padding: "5px 10px", fontSize: 12.5 }}
              placeholder="搜索插件（中英文都行，如 浏览器 / database），回车搜官方目录"
              value={marketQuery}
              onChange={(e) => {
                setMarketQuery(e.target.value);
                // A-1106：**清空输入框 = 回到内置精选**（否则列表会停在旧搜索结果上，用户看不出怎么回去）
                if (e.target.value.trim() === "") { setRegistryQuery(""); }
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && q) { void loadRegistry(true, marketQuery.trim()); } }} />
            <button className="btn" style={{ padding: "4px 12px", fontSize: 12, flexShrink: 0 }} disabled={registryLoading}
              onClick={() => { if (q) { void loadRegistry(true, marketQuery.trim()); } else { setRegistryQuery(""); } }}>
              {registryLoading ? "搜索中…" : "联网搜索"}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.6 }}>
            {registryLoading ? "正在检索官方 MCP 目录（registry.modelcontextprotocol.io，Linux Foundation 维护）…" :
              /* A-1106：**如实显示实际检索词** —— 中文输入会被展开成英文再发给上游，
                 用户有权知道"我搜的这个词到底变成了什么"（瞒着他就变成"为什么搜不到"）。
                 另外「没认出来」的情形必须点名 + 给可操作建议，不许静默按原词搜一遍了事。 */
              useRegistry ? `来源：MCP 官方目录（全球权威索引）。按「${registryQuery}」检索`
                + (registryApplied && registryApplied.toLowerCase() !== registryQuery.toLowerCase() ? `（实际检索词：${registryApplied}）` : "")
                + (registryUnrecognized ? `。⚠️ 未收录「${registryQuery}」对应的英文关键词，已按原词搜索 —— 多半搜不到，换个说法或直接输英文（如 browser / database / filesystem）` : "")
                + `。清空搜索框回到内置精选。`
              : registryError ? `官方目录联网失败（${registryError}），显示内置精选。点「联网搜索」重试。`
              : "内置精选（有准确安装命令，全中文）；点「联网搜索」用中文关键词检索官方目录全网资源。"}
          </div>
          {filtered.length === 0 ? (
            <div style={{ padding: "20px", textAlign: "center", color: "var(--text-dim)", fontSize: 12.5 }}>
              {!useRegistry && q ? `「${marketQuery}」暂无本地匹配——按回车联网搜官方目录`
                /* A-1106：registry 模式下 0 条**不是**"没找到匹配"，而是**上游就没返回**。
                   两种情况必须分开说：前者是本地筛选结果，后者要提示换检索词。 */
                : useRegistry ? `官方目录没有与「${registryQuery}」（检索词：${registryApplied || registryQuery}）匹配的条目 —— 换个关键词试试，或清空搜索框回到内置精选`
                : `没找到匹配「${marketQuery}」的插件`}
            </div>
          ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {visible.map((item) => {
              const isInstalled = installedSet.has(item.registry ? item.name : item.name);
              return (
                <div key={item.registry ? `r-${item.name}` : `b-${item.name}`} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                  border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg)",
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>
                      {item.name}
                      {item.registry ? <span style={{ marginLeft: 6, fontSize: 10, color: "var(--accent)", fontWeight: 600 }}>官方目录</span> : null}
                      {item.needEnv ? <span style={{ marginLeft: 6, fontSize: 11 }} title="需要配置环境变量/API Key">🔑</span> : null}
                      {isInstalled ? <span style={{ marginLeft: 6, fontSize: 11, color: "var(--success)", fontWeight: 400 }}>已安装</span> : null}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{item.desc || "（无描述）"}</div>
                    {/* A-1106：**中文类别标签**（内置精选的 tags 此前是死数据 —— 定义了却从没渲染过）。
                        registry 条目的描述是英文原文，标签给人一眼看得懂的类别线索。 */}
                    {(item.tags ?? []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 4 }}>
                        {(item.tags ?? []).map((t) => (
                          <span key={t} style={{
                            fontSize: 10, lineHeight: "15px", padding: "0 6px", borderRadius: 4,
                            color: "var(--text-dim)", background: "var(--bg-soft, rgba(127,127,127,.12))",
                          }}>{t}</span>
                        ))}
                      </div>
                    )}
                    {item.installCmd && (
                      <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 3, fontFamily: "Consolas, monospace", wordBreak: "break-all" }}>
                        {item.installCmd}
                      </div>
                    )}
                  </div>
                  <button className="btn primary" style={{ padding: "5px 14px", fontSize: 12, flexShrink: 0 }}
                    disabled={installing === item.name || isInstalled}
                    onClick={() => {
                      if (item.registry) {
                        const orig = (registryServers ?? []).find((s) => s.displayName === item.name);
                        if (orig) { void installFromRegistry(orig); }
                      } else {
                        const builtin = MCP_MARKETPLACE.find((m) => m.name === item.name);
                        if (builtin) { void installFromMarket(builtin); }
                      }
                    }}>
                    {installing === item.name ? "安装中…" : (isInstalled ? "已安装" : "安装")}
                  </button>
                </div>
              );
            })}
          </div>
          )}
          {filtered.length > LIMIT && !showAll && !q && (
            <div style={{ textAlign: "center", marginTop: 4 }}>
              <button className="btn" style={{ padding: "4px 16px", fontSize: 12 }} onClick={() => setShowAll(true)}>
                显示全部 {filtered.length} 个
              </button>
            </div>
          )}
        </div>
        );
      })()}
      </div>
      </div>
      {/* A-1015：marketOpen 闭（原为 `{marketOpen && (() => …)()}` 条件渲染 → 常驻 + 高度插值） */}

      {notice && (
        <div style={{
          padding: "8px 12px", marginBottom: 12, fontSize: 12.5,
          borderRadius: 8, border: "1px solid var(--border)",
          background: notice.ok ? "var(--success-soft)" : "var(--danger-soft)",
          color: notice.ok ? "var(--success)" : "#f87171",
        }}>
          {notice.text}
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--text-dim)", fontSize: 13, padding: 12 }}>加载中…</div>
      ) : servers.length === 0 ? (
        <div className="card" style={{ padding: "18px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 12 }}>
            未发现 MCP 服务器。
            <br />
            点击上方「＋ 添加服务器」用表单直接添加（自动写入 <code style={{ color: "var(--accent-hover)" }}>slime.toml</code>）；
            <br />
            也可打开配置文件所在目录手动编辑后刷新。
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button className="btn primary" style={{ padding: "7px 16px", fontSize: 13 }} onClick={() => setAddOpen(true)}>
              ＋ 表单添加
            </button>
            <button className="btn" style={{ padding: "7px 16px", fontSize: 13 }} onClick={() => void openFolder()}>
              打开配置文件
            </button>
          </div>
        </div>
      ) : (
        servers.map((m) => (
          <div key={m.name} className="card" style={{
            display: "flex", alignItems: "center", gap: 12, marginBottom: 8,
            padding: "10px 12px",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: m.enabled ? "var(--text)" : "var(--text-dim)" }}>
                {m.name}
                {!m.enabled && <span style={{ fontSize: 11, color: "var(--warning)", marginLeft: 6 }}>已停用</span>}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, wordBreak: "break-all" }}>
                {m.kind === "http" ? `HTTP · ${m.url ?? ""}` : `stdio · ${m.command ?? ""}`}
              </div>
            </div>
            <span style={{ fontSize: 11, color: "var(--text-dim)", padding: "1px 8px", borderRadius: 8, background: "var(--bg-input)", flexShrink: 0 }}>
              {m.kind === "http" ? "HTTP" : "stdio"}
            </span>
            <button className={`btn${m.enabled ? "" : " primary"}`} style={{ padding: "4px 12px", fontSize: 12.5, flexShrink: 0 }}
              disabled={busy === m.name}
              onClick={() => void toggle(m)}>
              {busy === m.name ? "处理中…" : (m.enabled ? "停用" : "启用")}
            </button>
            <button className="btn" title="在文件管理器中打开 MCP 配置所在目录（slime.toml）" style={{ padding: "4px 10px", fontSize: 12, flexShrink: 0 }}
              onClick={() => void openFolder()}>
              打开
            </button>
            <button className="btn" title="从 slime.toml 删除该 MCP 服务器配置块（自动备份 .bak）" style={{ padding: "4px 10px", fontSize: 12, flexShrink: 0, color: "#f87171" }}
              disabled={busy === m.name}
              onClick={() => void remove(m)}>
              删除
            </button>
          </div>
        ))
      )}
    </div>
  );
}