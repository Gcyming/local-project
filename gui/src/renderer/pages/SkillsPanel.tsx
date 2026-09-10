/**
 * gui/src/renderer/pages/SkillsPanel.tsx — 设置「技能库」专栏。
 * 从供应商界面剥离，独立管理：查看已装的技能、启用/停用（停用 = 目录移至 .disabled/ 下）。
 */
import React, { type JSX } from "react";
import type { SkillInfo } from "../../shared/ipc.js";
import { confirmAsync } from "../dialog.js";

/** A-918++：内嵌 webview 标签（GitHub 授权页内嵌在面板内，非独立弹窗） */
const WebviewTag = React.forwardRef<HTMLElement, { src: string; style: React.CSSProperties; partition?: string; allowpopups?: boolean }>(
  (props, ref) => React.createElement("webview", { ...props, ref }),
);
WebviewTag.displayName = "WebviewTag";

/** A-918++：内置 Skill 广场目录（创建占位技能，用户安装后自行编辑 SKILL.md 完善正文） */
const SKILL_MARKETPLACE: Array<{ name: string; desc: string; tags?: string[] }> = [
  { name: "code-review", desc: "代码审查：通读 diff、找 bug/规范/性能/安全问题，按严重程度列点", tags: ["代码", "审查"] },
  { name: "web-research", desc: "联网研究：拆解问题 → 多源搜索 → 交叉验证 → 结构化总结", tags: ["搜索", "研究"] },
  { name: "git-commit", desc: "撰写规范 Conventional Commit 信息（按 type/scope/breaking 分段）", tags: ["Git", "提交"] },
  { name: "bug-investigation", desc: "Bug 定位：复现路径 → 假设 → 验证 → 根因 → 修复方案", tags: ["调试", "Bug"] },
  { name: "refactor", desc: "重构：识别坏味道 → 列出候选方案 → 评估风险 → 渐进式改造", tags: ["代码", "重构"] },
  { name: "test-generation", desc: "测试生成：识别核心路径 → 设计边界用例 → 编写单元测试", tags: ["测试", "代码"] },
  { name: "doc-writing", desc: "技术文档：读源码 → 提炼 API → 写 README/CHANGELOG/ADR", tags: ["文档"] },
  { name: "code-explain", desc: "代码解读：逐段解释意图、数据流、依赖关系（适合新人 onboarding）", tags: ["代码", "教学"] },
];

export default function SkillsPanel(): JSX.Element {
  const api = React.useRef<any>(null);
  const [skills, setSkills] = React.useState<SkillInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  // A-918++：GUI 表单新建技能（此前只能手动放文件夹，小白无从下手）
  const [addOpen, setAddOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [form, setForm] = React.useState<{ name: string; description: string; content: string }>({ name: "", description: "", content: "" });
  // A-918++：Skill 广场（联网 anthropics/skills 官方仓库 + 预制兜底；搜索/标签过滤，一键安装）
  const [marketOpen, setMarketOpen] = React.useState(false);
  const [marketQuery, setMarketQuery] = React.useState("");
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [marketOnline, setMarketOnline] = React.useState<Array<{ name: string; description: string }> | null>(null);
  const [marketLoading, setMarketLoading] = React.useState(false);
  const [marketError, setMarketError] = React.useState("");

  // A-918++：数据源认证（GitHub Token，加密存储；配置后 60→5000 req/h）
  const [githubToken, setGithubToken] = React.useState("");
  const [tokenSaved, setTokenSaved] = React.useState(false);
  const [tokenSaving, setTokenSaving] = React.useState(false);
  // A-918++：内嵌 GitHub 授权区（webview 内嵌在面板内，非独立弹窗）
  const [showGithubAuth, setShowGithubAuth] = React.useState(false);

  async function saveToken(): Promise<void> {
    if (!api.current?.extras?.registryAuthSet) { return; }
    setTokenSaving(true);
    try {
      const res = await api.current.extras.registryAuthSet({ githubToken: githubToken.trim() });
      if (res?.ok) {
        setTokenSaved(githubToken.trim().length > 0);
        showNotice(true, githubToken.trim() ? "GitHub Token 已加密保存（后续自动带 Token 拉取，解除限流）" : "已清除 GitHub Token（回到匿名 60 req/h）");
        // 清缓存用新 token 重新拉取官方仓库
        setMarketOnline(null);
        setMarketLoading(true);
        setMarketError("");
        try {
          const sres = await api.current.extras.skillMarketSearch("");
          if (sres?.ok && Array.isArray(sres.skills)) {
            setMarketOnline(sres.skills);
            showNotice(true, `已联网拉取官方技能仓库，共 ${sres.skills.length} 个技能（来源：anthropics/skills）`);
          } else {
            setMarketError(sres?.error ?? "联网拉取失败");
            showNotice(false, `联网拉取失败：${sres?.error ?? "未知错误"}（Token 已保存，但拉取官方仓库失败）`);
          }
        } catch (e) {
          setMarketError(`联网拉取失败：${e instanceof Error ? e.message : String(e)}`);
          showNotice(false, `联网拉取失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setMarketLoading(false);
        }
      } else {
        showNotice(false, res?.error ?? "保存失败");
      }
    } catch (e) {
      showNotice(false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTokenSaving(false);
    }
  }

  /** 联网拉取官方技能仓库列表（打开广场时触发一次） */
  const loadMarket = React.useCallback(async (): Promise<void> => {
    if (!api.current?.extras?.skillMarketSearch || marketOnline) { return; }
    setMarketLoading(true);
    setMarketError("");
    try {
      const res = await api.current.extras.skillMarketSearch("");
      if (res?.ok && Array.isArray(res.skills)) {
        setMarketOnline(res.skills);
      } else {
        setMarketError(res?.error ?? "联网拉取失败");
      }
    } catch (e) {
      setMarketError(`联网拉取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMarketLoading(false);
    }
  }, [marketOnline]);

  React.useEffect(() => {
    if (marketOpen) { void loadMarket(); }
  }, [marketOpen, loadMarket]);

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 3500);
  };

  const load = React.useCallback(async (): Promise<void> => {
    if (!api.current?.extras?.skillList) { return; }
    try {
      const list = await api.current.extras.skillList();
      setSkills(list);
    } catch (e) {
      console.error("[skills] list failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    void load();
    // A-918++ 修复：token 回显必须在 api.current 初始化【之后】拉取（此前 registryAuthGet
    // 的 useEffect 声明在前、api.current 初始化在后，首次挂载时 api.current 还是 null → token 不回显）
    if (api.current?.extras?.registryAuthGet) {
      void api.current.extras.registryAuthGet().then((a: { githubToken?: string }) => {
        if (a?.githubToken) { setGithubToken(a.githubToken); setTokenSaved(true); }
      }).catch(() => { /* 忽略 */ });
    }
  }, [load]);

  /** 提交新建技能表单 */
  async function submitAdd(): Promise<void> {
    if (!api.current?.extras?.skillAdd) { return; }
    if (!form.name.trim()) { showNotice(false, "名称必填"); return; }
    if (!form.description.trim()) { showNotice(false, "描述必填"); return; }
    setAdding(true);
    try {
      const res = await api.current.extras.skillAdd({
        name: form.name.trim(),
        description: form.description.trim(),
        content: form.content.trim() || undefined,
      });
      if (res?.ok) {
        showNotice(true, `技能「${res.name ?? form.name.trim()}」已创建（config/skills/ 下）`);
        setForm({ name: "", description: "", content: "" });
        setAddOpen(false);
        await load();
      } else {
        showNotice(false, res?.error ?? "创建失败");
      }
    } catch (e) {
      showNotice(false, `创建失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAdding(false);
    }
  }

  /** A-918++：从官方仓库安装技能（下载官方 SKILL.md 原样落地） */
  async function installFromOfficialMarket(name: string): Promise<void> {
    if (!api.current?.extras?.skillMarketInstall) { return; }
    setInstalling(name);
    try {
      const res = await api.current.extras.skillMarketInstall(name);
      if (res?.ok) {
        showNotice(true, `技能「${res.name ?? name}」已从官方仓库安装（config/skills/ 下）`);
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

  /** 一键从预制 Skill 广场安装（创建占位技能，用户后续在 SKILL.md 补全正文） */
  async function installFromSkillMarket(item: { name: string; description: string }): Promise<void> {
    if (!api.current?.extras?.skillAdd) { return; }
    setInstalling(item.name);
    try {
      const res = await api.current.extras.skillAdd({
        name: item.name,
        description: item.description,
        content: `# ${item.name}\n\n${item.description}\n\n（请在 SKILL.md 里补全指令、约束、步骤等正文）\n`,
      });
      if (res?.ok) {
        showNotice(true, `技能「${res.name ?? item.name}」已创建（config/skills/ 下），请补全 SKILL.md 正文`);
        await load();
      } else {
        showNotice(false, res?.error ?? "创建失败");
      }
    } catch (e) {
      showNotice(false, `创建失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(null);
    }
  }

  async function toggle(s: SkillInfo): Promise<void> {
    if (!api.current?.extras?.skillToggle) { return; }
    setBusy(s.name);
    try {
      const res = await api.current.extras.skillToggle(s.name, !s.enabled);
      if (res?.ok) {
        showNotice(true, `技能「${s.name}」已${s.enabled ? "停用" : "启用"}`);
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

  /** 打开技能目录（系统文件管理器） */
  async function openFolder(s: SkillInfo): Promise<void> {
    if (!api.current?.extras?.skillOpen) { return; }
    const res = await api.current.extras.skillOpen(s.name).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!res?.ok) {
      showNotice(false, res?.error ?? "打开失败");
    }
  }

  /** 打开技能根目录 config/skills（空列表时引导用户把技能放进来） */
  async function openSkillsRoot(): Promise<void> {
    if (!api.current?.extras?.skillsRootOpen) { return; }
    const res = await api.current.extras.skillsRootOpen().catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!res?.ok) {
      showNotice(false, res?.error ?? "打开失败");
    }
  }

  /** 删除技能（递归删除目录） */
  async function remove(s: SkillInfo): Promise<void> {
    if (!api.current?.extras?.skillDelete) { return; }
    if (!(await confirmAsync(`确定删除技能「${s.name}」？`, "其目录（含 manifest/SKILL.md）将被永久删除，不可恢复。"))) { return; }
    setBusy(s.name);
    try {
      const res = await api.current.extras.skillDelete(s.name);
      if (res?.ok) {
        showNotice(true, `技能「${s.name}」已删除`);
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

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ fontSize: 18, margin: 0, flex: 1 }}>技能库</h2>
        <button className="btn" style={{ padding: "5px 12px", fontSize: 12.5, marginRight: 8 }}
          onClick={() => { setMarketOpen((v) => !v); if (!marketOpen) { setAddOpen(false); } }}>
          {marketOpen ? "收起广场" : "🛒 技能广场"}
        </button>
        <button className="btn primary" style={{ padding: "5px 14px", fontSize: 12.5, marginRight: 10 }}
          onClick={() => { setAddOpen((v) => !v); if (!addOpen) { setMarketOpen(false); } }}>
          {addOpen ? "收起" : "＋ 新建技能"}
        </button>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          已启用 {enabledCount} / {skills.length}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 14 }}>
        技能位于 config/skills/ 目录（各技能含 manifest.yaml 与 SKILL.md）。停用会将技能目录移入
        .disabled/ 子目录，引擎不再加载；恢复后重新载入。
      </div>

      {/* A-918++：GUI 表单新建技能（生成 config/skills/<name>/SKILL.md，不再要求手动建目录） */}
      {addOpen && (
        <div className="card" style={{ padding: "14px 16px", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>新建技能</div>
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "10px 12px", alignItems: "start" }}>
            <label style={{ fontSize: 12.5, color: "var(--text-muted)", paddingTop: 7 }}>名称</label>
            <input className="input-field" style={{ padding: "6px 10px", fontSize: 12.5 }} placeholder="如 web-research / code-review（自动转小写连字符）"
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <label style={{ fontSize: 12.5, color: "var(--text-muted)", paddingTop: 7 }}>描述</label>
            <input className="input-field" style={{ padding: "6px 10px", fontSize: 12.5 }} placeholder="一句话说明该技能做什么（触发匹配依据）"
              value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <label style={{ fontSize: 12.5, color: "var(--text-muted)", paddingTop: 7 }}>SKILL.md 内容（可选）</label>
            <textarea className="input-field" rows={6} style={{ padding: "8px 10px", fontSize: 12, fontFamily: "Consolas, monospace", resize: "vertical" }}
              placeholder={"粘贴/编写技能正文（Markdown，含指令、约束、步骤等）。留空则自动生成占位内容。"}
              value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button className="btn primary" style={{ padding: "6px 16px", fontSize: 12.5 }} disabled={adding}
              onClick={() => void submitAdd()}>
              {adding ? "创建中…" : "创建"}
            </button>
            <button className="btn" style={{ padding: "6px 14px", fontSize: 12.5 }}
              onClick={() => { setAddOpen(false); setForm({ name: "", description: "", content: "" }); }}>
              取消
            </button>
            <span style={{ fontSize: 11, color: "var(--text-dim)", alignSelf: "center" }}>
              创建后出现在上方列表，启用即可被 Agent 按描述自动匹配调用
            </span>
          </div>
        </div>
      )}

      {/* A-918++：Skill 广场——一键创建占位技能（带搜索/标签过滤） */}
      {marketOpen && (() => {
        const q = marketQuery.trim().toLowerCase();
        // A-918++：联网官方仓库结果优先；未加载/失败时回退预制列表
        const useOnline = marketOnline !== null;
        const sourceList: Array<{ name: string; description: string; tags?: string[]; official?: boolean }> = useOnline
          ? marketOnline.map((s) => ({ name: s.name, description: s.description, official: true }))
          : SKILL_MARKETPLACE.map((s) => ({ name: s.name, description: s.desc, tags: s.tags }));
        const filtered = q
          ? sourceList.filter((it) => {
              if (it.name.toLowerCase().includes(q)) { return true; }
              if (it.description.toLowerCase().includes(q)) { return true; }
              if (it.tags?.some((t) => t.toLowerCase().includes(q))) { return true; }
              return false;
            })
          : sourceList;
        return (
        <div className="card" style={{ padding: "14px 16px", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>
              技能广场{useOnline ? ` · 官方仓库 ${filtered.length}/${marketOnline!.length}` : ` · 预制 ${filtered.length}/${SKILL_MARKETPLACE.length}`}
            </div>
            <input className="input-field" style={{ width: 220, padding: "5px 10px", fontSize: 12.5 }} placeholder="搜索技能（名称/描述）"
              value={marketQuery} onChange={(e) => setMarketQuery(e.target.value)} />
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.6 }}>
            {marketLoading ? "正在拉取 Anthropic 官方技能仓库（anthropics/skills）…" :
              useOnline ? "来源：Anthropic 官方技能仓库（anthropics/skills）。点「安装」下载官方 SKILL.md 原样落地。"
              : marketError ? `联网拉取失败（${marketError}），已回退预制列表。点「安装」创建占位技能。`
              : "点「安装」一键创建技能目录。"}
          </div>
          {/* A-918++：数据源认证（GitHub Token，加密存储，提升 60→5000 req/h） */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)" }}>
            <button className="btn" style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0, whiteSpace: "nowrap" }}
              onClick={() => setShowGithubAuth((v) => !v)}>
              {showGithubAuth ? "收起授权" : "🔐 登录 GitHub"}
            </button>
            <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              Token {tokenSaved ? <span style={{ color: "var(--success)" }}>✓</span> : <span style={{ color: "var(--text-dim)" }}>（匿名 60/h）</span>}
            </span>
            <input className="input-field" style={{ flex: 1, padding: "5px 10px", fontSize: 12 }} type="password"
              placeholder="登录后把生成的 Token 粘贴到这里（可选，配置后 5000 req/h）"
              value={githubToken} onChange={(e) => { setGithubToken(e.target.value); setTokenSaved(false); }} />
            <button className="btn primary" style={{ padding: "5px 14px", fontSize: 12, flexShrink: 0 }} disabled={tokenSaving}
              onClick={() => void saveToken()}>
              {tokenSaving ? "保存中…" : "保存"}
            </button>
          </div>
          {/* A-918++：内嵌 webview 授权区（GitHub 登录页内嵌在面板内，登录后生成 token 复制回来） */}
          {showGithubAuth && (
            <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", height: 460, background: "#0d1117" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg)" }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>GitHub 授权（登录后生成 Token，复制粘贴回上方输入框）</span>
                <span style={{ flex: 1 }} />
                <button className="btn" style={{ padding: "3px 10px", fontSize: 11.5 }}
                  onClick={() => { void api.current?.extras?.openGithubAuth?.(); }}>
                  在独立窗口打开
                </button>
              </div>
              <WebviewTag
                src="https://github.com/settings/tokens/new?scopes=repo&description=slime-agent"
                partition="persist:github-auth"
                allowpopups={true}
                style={{ width: "100%", height: 420, border: "none", background: "#0d1117" }}
              />
            </div>
          )}
          {filtered.length === 0 ? (
            <div style={{ padding: "20px", textAlign: "center", color: "var(--text-dim)", fontSize: 12.5 }}>
              没找到匹配「{marketQuery}」的技能
            </div>
          ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 420, overflowY: "auto" }}>
            {filtered.map((item) => {
              const installed = skills.some((s) => s.name === item.name);
              return (
                <div key={item.name} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                  border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg)",
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>
                      {item.name}
                      {item.official ? <span style={{ marginLeft: 6, fontSize: 10, color: "var(--accent)", fontWeight: 600 }}>官方</span> : null}
                      {installed ? <span style={{ marginLeft: 6, fontSize: 11, color: "var(--success)", fontWeight: 400 }}>已安装</span> : null}
                    </div>
                    {item.description && <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{item.description}</div>}
                    {(item.tags ?? []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                        {item.tags!.map((t) => (
                          <span key={t} style={{ fontSize: 10, color: "var(--accent)", padding: "1px 6px", borderRadius: 6, background: "var(--accent-soft)" }}>{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button className="btn primary" style={{ padding: "5px 14px", fontSize: 12, flexShrink: 0 }}
                    disabled={installing === item.name || installed}
                    onClick={() => item.official ? void installFromOfficialMarket(item.name) : void installFromSkillMarket({ name: item.name, description: item.description })}>
                    {installing === item.name ? "安装中…" : (installed ? "已安装" : "安装")}
                  </button>
                </div>
              );
            })}
          </div>
          )}
        </div>
        );
      })()}

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
      ) : skills.length === 0 ? (
        <div className="card" style={{ padding: "18px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 12 }}>
            未发现技能。
            <br />
            点击上方「＋ 新建技能」用表单直接创建（自动生成 config/skills/&lt;名称&gt;/SKILL.md）；
            <br />
            也可打开技能文件夹手动放入技能目录。
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button className="btn primary" style={{ padding: "7px 16px", fontSize: 13 }} onClick={() => setAddOpen(true)}>
              ＋ 新建技能
            </button>
            <button className="btn" style={{ padding: "7px 16px", fontSize: 13 }} onClick={() => void openSkillsRoot()}>
              打开技能文件夹
            </button>
          </div>
        </div>
      ) : (
        skills.map((s) => (
          <div key={s.name} className="card" style={{
            display: "flex", alignItems: "center", gap: 12, marginBottom: 8,
            padding: "10px 12px",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: s.enabled ? "var(--text)" : "var(--text-dim)" }}>
                {s.name}
                {!s.enabled && <span style={{ fontSize: 11, color: "var(--warning)", marginLeft: 6 }}>已停用</span>}
              </div>
              {s.description && (
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, wordBreak: "break-word" }}>
                  {s.description}
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                {s.hasManifest ? "manifest.yaml ✓" : "manifest 缺失"}
                {s.hasSkillMd ? " · SKILL.md ✓" : " · SKILL.md 缺失"}
              </div>
            </div>
            <button className={`btn${s.enabled ? "" : " primary"}`} style={{ padding: "4px 12px", fontSize: 12.5, flexShrink: 0 }}
              disabled={busy === s.name}
              onClick={() => void toggle(s)}>
              {busy === s.name ? "处理中…" : (s.enabled ? "停用" : "启用")}
            </button>
            <button className="btn" title="在文件管理器中打开该技能目录" style={{ padding: "4px 10px", fontSize: 12, flexShrink: 0 }}
              onClick={() => void openFolder(s)}>
              打开
            </button>
            <button className="btn" title="永久删除该技能（不可恢复）" style={{ padding: "4px 10px", fontSize: 12, flexShrink: 0, color: "#f87171" }}
              disabled={busy === s.name}
              onClick={() => void remove(s)}>
              删除
            </button>
          </div>
        ))
      )}
    </div>
  );
}