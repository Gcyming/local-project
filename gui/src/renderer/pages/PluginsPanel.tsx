import React, { type JSX } from "react";

interface SkillRow {
  name: string;
  description: string;
  hasSkillMd: boolean;
  hasManifest: boolean;
  enabled: boolean;
  origin?: string;
}

interface McpRow {
  name: string;
  kind: "stdio" | "http";
  command?: string;
  url?: string;
  enabled: boolean;
}

interface PluginRow {
  name: string;
  description: string;
  version: string;
  origin: string;
  contributions: string[];
  tools: string[];
  modules: string[];
  unloadable: boolean;
  status: string;
  error?: string;
  dir: string;
  /** A-1197 · B1：该插件声明了多少个设置项（0/ 缺省 = 不声明）。 */
  settingsCount?: number;
  /** A-1197 · B2/B4：UI 槽位 / 脚本声明计数 + 脚本信任状态（列表接口按需带）。 */
  uiCount?: number;
  scriptCount?: number;
  trusted?: boolean;
}

/** A-1197 · B1：设置项回传形状（`secret` 项永远只有 `hasValue`，不会有 `value`）。 */
interface PluginSettingItem {
  key: string;
  label: string;
  type: string;
  hint?: string;
  options?: string[];
  min?: number;
  max?: number;
  root?: string;
  secret: boolean;
  default?: unknown;
  value?: unknown;
  hasValue?: boolean;
}

interface PluginSettingsSnapshot {
  plugin: string;
  items: PluginSettingItem[];
  warnings: string[];
}

interface PluginRejectedRow {
  dir: string;
  errors: string[];
}

interface PluginSnapshot {
  plugins: PluginRow[];
  rejected: PluginRejectedRow[];
}

const CONTRIBUTION_LABEL: Record<string, string> = {
  instructions: "instructions（贡献指令）",
  tools: "tools（贡献工具）",
  prompt: "prompt（贡献提示词）",
};

interface Props {

  onNavigate?: (tab: "skills" | "mcp") => void;
}

const ORIGIN_META: Record<string, { label: string; hint: string }> = {
  agent: { label: "Agent 自建", hint: "由 Agent 在创造模式下自行创建（依据 frontmatter 的 origin 声明）" },
  market: { label: "官方市场", hint: "从官方技能仓库安装" },
  user: { label: "用户自备", hint: "用户自行放入" },
};

function originOf(s: SkillRow): { label: string; hint: string; key: string } {
  const key = (s.origin ?? "").trim().toLowerCase();
  const meta = ORIGIN_META[key];
  if (meta) { return { ...meta, key }; }
  return { label: "未声明", hint: "该技能的 SKILL.md frontmatter 未声明 origin", key: "" };
}

function Badge(props: { text: string; title?: string; tone?: "accent" | "dim" }): JSX.Element {
  const accent = props.tone !== "dim";
  return (
    <span title={props.title}
      style={{
        fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 999,
        whiteSpace: "nowrap", flexShrink: 0,
        border: `1px solid ${accent ? "var(--accent)" : "var(--border-hover)"}`,
        background: accent ? "var(--accent-soft)" : "transparent",
        color: accent ? "var(--accent-hover)" : "var(--text-dim)",
      }}>
      {props.text}
    </span>
  );
}

const CARD: React.CSSProperties = {
  border: "1px solid var(--card-border)", borderRadius: 10,
  background: "var(--card-surface)", padding: "13px 15px",
  display: "flex", flexDirection: "column", gap: 10,
};

/** A-1196：拨片开关（可管理插件的启停控制）。
 *  动效只用合成器属性（滑块 transform 位移 + 轨道 background 过渡）——不触发布局，动画顺。
 *  轨道圆角 999，滑块位移收敛在轨道内（曲线无过冲，避免滑块短暂露头）。 */
function ToggleSwitch(props: {
  on: boolean;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
}): JSX.Element {
  const { on, busy, disabled } = props;
  const W = 40;
  const H = 22;
  const PAD = 2;
  const KNOB = H - PAD * 2;
  const TRAVEL = W - PAD * 2 - KNOB;
  const inert = disabled || busy;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={props.title}
      disabled={inert}
      onClick={() => { if (!inert) { props.onToggle(); } }}
      style={{
        width: W, height: H, borderRadius: 999, border: "none", padding: 0,
        position: "relative", cursor: inert ? "not-allowed" : "pointer",
        background: on ? "var(--accent)" : "var(--border-hover)",
        transition: "background 0.18s ease",
        opacity: disabled ? 0.45 : busy ? 0.7 : 1,
        flexShrink: 0,
      }}>
      <span style={{
        position: "absolute", top: PAD, left: PAD, width: KNOB, height: KNOB,
        borderRadius: "50%",
        background: on ? "#fff" : "var(--text-dim)",
        transform: `translateX(${on ? TRAVEL : 0}px)`,
        transition: "transform 0.18s cubic-bezier(0.25, 0.8, 0.25, 1), background 0.18s ease",
        boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
      }} />
    </button>
  );
}



function BuiltinPluginGroupCard(props: { row: PluginRow }): JSX.Element {
  const { row } = props;
  const [openTools, setOpenTools] = React.useState(false);
  const [openModules, setOpenModules] = React.useState(false);
  const toolCount = row.tools.length;
  const moduleCount = row.modules.length;
  const failed = row.status === "failed";

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 9, padding: "9px 11px",
      display: "flex", flexDirection: "column", gap: 7,
      background: "transparent",
      opacity: failed ? 0.75 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{row.name}</span>
        <Badge
          text="不可卸载"
          tone="dim"
          title="系统默认插件随应用提供，来源为 builtin，不提供卸载入口"
        />
        <span style={{ flex: 1 }} />
        {failed && <Badge text={`加载失败：${row.status}`} tone="dim" title="清单装载阶段失败" />}
      </div>

      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {row.description || "（该族未提供描述）"}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>贡献类型</span>
        {row.contributions.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>暂无</span>
        )}
        {row.contributions.map((c) => (
          <Badge key={c} text={CONTRIBUTION_LABEL[c] ?? c} tone="dim" />
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          工具 {toolCount} 个 · 源码模块 {moduleCount} 个
        </span>
        <span style={{ flex: 1 }} />
        {toolCount > 0 && (
          <button className="btn" style={{ fontSize: 11, padding: "2px 9px" }}
            onClick={() => { setOpenTools((v) => !v); }}>
            {openTools ? "收起工具名" : "展开工具名"}
          </button>
        )}
        {moduleCount > 0 && (
          <button className="btn" style={{ fontSize: 11, padding: "2px 9px" }}
            onClick={() => { setOpenModules((v) => !v); }}>
            {openModules ? "收起模块" : "展开模块"}
          </button>
        )}
      </div>

      {openTools && toolCount > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {row.tools.map((t) => (
            <code key={t} style={{
              fontSize: 10.5, padding: "1px 6px", borderRadius: 5,
              border: "1px solid var(--border)", color: "var(--text-dim)",
            }}>{t}</code>
          ))}
        </div>
      )}

      {openModules && moduleCount > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {row.modules.map((m) => (
            <code key={m} style={{ fontSize: 10.5, color: "var(--text-dim)", wordBreak: "break-all" }}>
              {m}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

const PLUGINS_ROOT = "config/plugins";

function normalizeSnapshot(raw: unknown): PluginSnapshot | null {
  if (Array.isArray(raw)) {
    return { plugins: raw as PluginRow[], rejected: [] };
  }
  if (raw && typeof raw === "object") {
    const o = raw as { plugins?: unknown; rejected?: unknown };
    return {
      plugins: Array.isArray(o.plugins) ? (o.plugins as PluginRow[]) : [],
      rejected: Array.isArray(o.rejected) ? (o.rejected as PluginRejectedRow[]) : [],
    };
  }
  return null;
}

function SourcedPluginCard(props: {
  row: PluginRow;
  onToggle: (name: string, currentlyOn: boolean) => void;
  busy: boolean;
  onSettingSubmit: (plugin: string, key: string, value: unknown) => void;
  busySettingKey: string | null;
  settingsToken: number;
  /* A-1197 · B4（T1 脚本信任）：仅当 row.scriptCount > 0 时显示开关。 */
  trusted?: boolean;
  busyTrust?: boolean;
  onTrustToggle?: (name: string, trusted: boolean) => void;
}): JSX.Element {
  const { row, onToggle, busy } = props;
  const failed = row.status === "failed";
  const disabled = row.status === "disabled";
  const on = !disabled && !failed;
  /* A-1197 · B1：设置区按需展开。设置项是持久数据，禁用插件后**保留**（关插件不该丢配置），
     但插件未装载时主进程拒读写⇒ 设置区会显示「不可用」而不是假装还能改。 */
  const hasSettings = (row.settingsCount ?? 0) > 0;
  const [openSettings, setOpenSettings] = React.useState(false);

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 9, padding: "9px 11px",
      display: "flex", flexDirection: "column", gap: 7,
      opacity: failed ? 0.75 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{row.name}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>v{row.version}</span>
        <Badge
          text={failed ? "加载失败" : disabled ? "已关闭" : "已启用"}
          tone="dim"
          title={row.status}
        />
        {hasSettings && (
          <Badge text={`设置 ${row.settingsCount} 项`} tone="dim"
            title="插件声明的设置项（落在插件自己的目录，不影响主配置）" />
        )}
        <span style={{ flex: 1 }} />
        {hasSettings && (
          <button className="btn" style={{ fontSize: 11, padding: "2px 9px" }}
            onClick={() => { setOpenSettings((v) => !v); }}>
            {openSettings ? "收起设置" : "设置"}
          </button>
        )}
        {(row.scriptCount ?? 0) > 0 && (
          /* A-1197 · B4（T1）：脚本信任开关 —— 开 = 允许本插件的脚本被装配为可执行工具
             （一次性子进程、cwd 限定在插件目录、30s 超时）；关 = 立即撤装。 */
          <>
            <span style={{ fontSize: 11, color: props.trusted ? "var(--warning)" : "var(--text-dim)", flexShrink: 0 }}>
              信任脚本（{row.scriptCount}）
            </span>
            <ToggleSwitch
              on={props.trusted === true}
              busy={props.busyTrust}
              title={
                props.trusted
                  ? "已信任：本插件声明的脚本会被装配为工具（子进程执行）。关闭 = 立即撤装、工具注销。"
                  : `本插件声明了 ${row.scriptCount} 个可执行脚本。打开开关表示你信任它并允许在本机以一次性子进程执行（cwd 限定在插件目录、30s 超时）。`
              }
              onToggle={() => { props.onTrustToggle?.(row.name, props.trusted !== true); }}
            />
          </>
        )}
        {row.unloadable && (
          <ToggleSwitch
            on={on}
            busy={busy}
            title={
              failed
                ? "加载失败：修复插件目录内容后，打开开关重试装载"
                : on
                  ? "关闭 = 卸载该插件（记录进禁用名单，重启后保持关闭）"
                  : "打开 = 重新装载该插件"
            }
            onToggle={() => { onToggle(row.name, on && !failed); }}
          />
        )}
      </div>

      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {row.description || "（该插件未提供描述）"}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>贡献类型</span>
        {row.contributions.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>暂无</span>
        )}
        {row.contributions.map((c) => (
          <Badge key={c} text={CONTRIBUTION_LABEL[c] ?? c} tone="dim" />
        ))}
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)", wordBreak: "break-all" }}>
        来源目录 {row.dir || "（未记录）"}
      </div>

      {failed && (
        <div style={{
          fontSize: 11.5, color: "var(--warning)", lineHeight: 1.6, wordBreak: "break-all",
        }}>
          失败原因：{row.error || "未记录错误信息"}
        </div>
      )}

      {hasSettings && openSettings && (
        <PluginSettingsSection
          plugin={row.name}
          busyKey={props.busySettingKey}
          reloadToken={props.settingsToken}
          onSubmit={props.onSettingSubmit}
        />
      )}
    </div>
  );
}

/** A-1197 · B1：单个声明项的输入控件（宿主渲染器 —— 扩展**不能**自带组件，见 §5.1）。
 *  写入前做一次本地校验只为「即时反馈」，主进程那份才是不信任的那一份。 */
function SettingField(props: {
  item: PluginSettingItem;
  onSubmit: (key: string, value: unknown) => void;
  busy: boolean;
}): JSX.Element {
  const { item, busy } = props;
  const [draft, setDraft] = React.useState<string>(item.type === "boolean" ? "" : String(item.value ?? item.default ?? ""));
  const [localError, setLocalError] = React.useState<string | null>(null);

  const validate = (raw: string): string | null => {
    if (item.type === "number") {
      const n = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(n)) { return "需要数值"; }
      if (item.min !== undefined && n < item.min) { return `不得小于 ${item.min}`; }
      if (item.max !== undefined && n > item.max) { return `不得大于 ${item.max}`; }
      return null;
    }
    if (item.type === "enum") {
      if (!(item.options ?? []).includes(raw)) { return "不在候选列表内"; }
      return null;
    }
    if (item.type === "path") {
      const t = raw.trim();
      if (t === "") { return "不能为空"; }
      if (/^[A-Za-z]:/.test(t) || t.startsWith("/") || t.startsWith("\\")) { return "必须是纯相对路径"; }
      if (t.split(/[\\/]+/).includes("..")) { return "不得含 .."; }
      return null;
    }
    return null;
  };

  const commit = (raw: string): void => {
    const err = validate(raw);
    setLocalError(err);
    if (err) { return; }
    if (item.type === "boolean") { props.onSubmit(item.key, raw === "true"); return; }
    if (item.type === "number") { props.onSubmit(item.key, Number(raw.trim())); return; }
    props.onSubmit(item.key, raw);
  };

  const row: JSX.Element = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
      <span style={{ fontSize: 11.5, color: "var(--text-muted)", flexShrink: 0, minWidth: 120 }}>{item.label}</span>
      {item.type === "boolean" ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          style={{ fontSize: 11, padding: "2px 10px" }}
          onClick={() => { const next = draft !== "true"; setDraft(next ? "true" : ""); props.onSubmit(item.key, next); }}>
          {draft === "true" ? "已开启" : "已关闭"}
        </button>
      ) : item.type === "enum" ? (
        <select
          value={draft}
          disabled={busy}
          onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }}
          style={{ fontSize: 11.5, padding: "2px 6px", minWidth: 140 }}>
          {(item.options ?? []).map((o) => (<option key={o} value={o}>{o}</option>))}
        </select>
      ) : (
        <>
          <input
            value={draft}
            disabled={busy}
            placeholder={item.type === "path" ? `相对${item.root === "workspace" ? "会话工作目录" : "插件目录"}的路径` : ""}
            onChange={(e) => { setDraft(e.target.value); }}
            onBlur={() => { commit(draft); }}
            style={{ fontSize: 11.5, padding: "2px 6px", minWidth: 160, flex: 1 }}
          />
          <button type="button" className="btn" disabled={busy}
            style={{ fontSize: 11, padding: "2px 9px" }}
            onClick={() => { commit(draft); }}>保存</button>
        </>
      )}
      {item.type === "number" && item.min !== undefined && item.max !== undefined && (
        <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{item.min} ~ {item.max}</span>
      )}
      {item.secret && (
        <Badge text="已加密" tone="dim"
          title="密文落盘（插件目录下的 settings.enc.json）；读回只告知是否已有值，不回显明文" />
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {row}
      {item.hint && <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.5 }}>{item.hint}</div>}
      {item.secret && item.hasValue && (
        <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>已保存（不回显明文）</div>
      )}
      {localError && <div style={{ fontSize: 10.5, color: "var(--warning)" }}>{localError}</div>}
    </div>
  );
}

/** A-1197 · B1：某插件的设置区（声明式 —— 宿主按声明渲染，扩展不带组件）。 */
function PluginSettingsSection(props: {
  plugin: string;
  onSubmit: (plugin: string, key: string, value: unknown) => void;
  busyKey: string | null;
  reloadToken: number;
}): JSX.Element | null {
  const api = React.useRef<any>(null);
  const [snap, setSnap] = React.useState<PluginSettingsSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    api.current = (window as any).slimeAPI ?? api.current;
    const get = api.current?.extras?.pluginsSettingsGet;
    if (!get) { setError("当前环境不支持读取插件设置"); return; }
    try {
      const res = await get(props.plugin);
      if (res?.ok && res.dto) {
        setSnap(res.dto);
        setError(null);
      } else {
        /* 插件被禁用 / 未装载 / 未声明设置项 —— 这里如实显示，不静默留空 */
        setSnap(null);
        setError(res?.error ? String(res.error) : "读取插件设置失败");
      }
    } catch (e) {
      setSnap(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [props.plugin]);

  React.useEffect(() => {
    void load();
  }, [load, props.reloadToken]);

  /* 插件被禁用时：主进程返回「未装载或已停用」⇒ 这里拿到 error ⇒ 设置区不显示任何输入框。 */
  if (error && !snap) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>设置区不可用：{error}</div>
    );
  }
  if (!snap) {
    return null;
  }

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
      display: "flex", flexDirection: "column", gap: 8,
      background: "transparent",
    }}>
      <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
        该插件的设置项，落在它自己的目录里（不影响 slime 主配置）
      </div>
      {snap.warnings.length > 0 && (
        <div style={{
          fontSize: 10.5, color: "var(--warning)", lineHeight: 1.55,
          border: "1px solid var(--warning)", borderRadius: 6, padding: "4px 8px",
        }}>
          {snap.warnings.map((w, i) => (<div key={i}>{w}</div>))}
        </div>
      )}
      {snap.items.map((item) => (
        <SettingField
          key={`${props.plugin}:${item.key}`}
          item={item}
          busy={props.busyKey === `${props.plugin}:${item.key}`}
          onSubmit={(key, value) => { props.onSubmit(props.plugin, key, value); }}
        />
      ))}
    </div>
  );
}

function RejectedDirsCard(props: { rejected: PluginRejectedRow[] }): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const n = props.rejected.length;
  return (
    <div style={{
      ...CARD, border: "1px dashed var(--warning)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Badge text="未装载" tone="dim" title="fail-closed 拒绝的目录清单" />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--warning)" }}>
          有 {n} 个目录未通过校验未装载
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ fontSize: 11.5, padding: "3px 10px" }}
          onClick={() => { setOpen((v) => !v); }}>
          {open ? "收起原因" : "展开看原因"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.65 }}>
        这些目录<b>没有</b>被装载，也没有被静默丢弃 —— 原因逐条列在下面。修好清单后点上方「重新装载」即可再试。
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {props.rejected.map((r) => (
            <div key={r.dir} style={{
              border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
              display: "flex", flexDirection: "column", gap: 4,
            }}>
              <code style={{ fontSize: 10.5, color: "var(--text-dim)", wordBreak: "break-all" }}>{r.dir}</code>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
                {r.errors.map((e, i) => (
                  <li key={i} style={{ fontSize: 11.5, color: "var(--warning)", lineHeight: 1.55 }}>{e}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PluginsPanel(props: Props): JSX.Element {
  const api = React.useRef<any>(null);
  const [skills, setSkills] = React.useState<SkillRow[]>([]);
  const [mcp, setMcp] = React.useState<McpRow[]>([]);
  const [plugins, setPlugins] = React.useState<PluginRow[]>([]);
  const [rejected, setRejected] = React.useState<PluginRejectedRow[]>([]);
  const [pluginsFailed, setPluginsFailed] = React.useState(false);
  const [busyName, setBusyName] = React.useState<string | null>(null);
  /* A-1197 · B4：信任开关的忙碌态（独立于拨片的 busyName —— 两个开关可各自转）。 */
  const [busyTrustName, setBusyTrustName] = React.useState<string | null>(null);
  /** A-1197 · B1：正在写的设置项 `plugin:key`；写完递增 token 让设置区重拉。 */
  const [busySettingKey, setBusySettingKey] = React.useState<string | null>(null);
  const [settingsToken, setSettingsToken] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  const showNotice = (ok: boolean, text: string): void => {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 4000);
  };

  const refresh = React.useCallback(async (): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.skillList) { setLoading(false); return; }
    try {
      const [sk, mc, pl] = await Promise.all([
        a.extras.skillList() as Promise<SkillRow[]>,
        a.extras.mcpList ? (a.extras.mcpList() as Promise<McpRow[]>) : Promise.resolve([] as McpRow[]),
        a.extras.pluginsList
          ? (a.extras.pluginsList() as Promise<unknown>).then(
            (raw) => ({ snap: normalizeSnapshot(raw), error: undefined as unknown }),
            (e: unknown) => ({ snap: null as PluginSnapshot | null, error: e }),
          )
          : Promise.resolve({ snap: { plugins: [], rejected: [] } as PluginSnapshot | null, error: undefined as unknown }),
      ]);
      setSkills(Array.isArray(sk) ? sk : []);
      setMcp(Array.isArray(mc) ? mc : []);
      if (pl.snap) {
        setPlugins(pl.snap.plugins);
        setRejected(pl.snap.rejected);
        setPluginsFailed(false);
      } else {
        setPlugins([]);
        setRejected([]);
        setPluginsFailed(true);
        showNotice(false, `插件清单读取失败：${String(pl.error ?? "通道不可用")}`);
      }
    } catch (e) {
      showNotice(false, `读取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const doUnload = React.useCallback(async (name: string): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.pluginsUnload) {
      showNotice(false, "当前环境不支持卸载插件");
      return;
    }
    setBusyName(name);
    try {
      const res = await a.extras.pluginsUnload(name);
      if (res?.ok) {
        showNotice(true, `已关闭 ${name}（重启后保持关闭）`);
      } else {
        showNotice(false, res?.error ? `关闭 ${name} 失败：${res.error}` : `关闭 ${name} 失败`);
      }
    } catch (e) {
      showNotice(false, `关闭 ${name} 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyName(null);
      await refresh();
    }
  }, [refresh]);

  /** A-1196：拨片开关「开」——从禁用名单移除并重扫装载；快照直接带回，免一次往返。 */
  const doEnable = React.useCallback(async (name: string): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.pluginsEnable) {
      showNotice(false, "当前环境不支持启用插件");
      return;
    }
    setBusyName(name);
    try {
      const res = await a.extras.pluginsEnable(name);
      const snap = res?.snapshot ? normalizeSnapshot(res.snapshot) : null;
      if (snap) {
        setPlugins(snap.plugins);
        setRejected(snap.rejected);
        setPluginsFailed(false);
      }
      if (res?.ok) {
        showNotice(true, `已启用 ${name}`);
      } else {
        showNotice(false, res?.error ? `启用 ${name} 失败：${res.error}` : `启用 ${name} 失败`);
      }
      if (!snap) { await refresh(); }
    } catch (e) {
      showNotice(false, `启用 ${name} 失败：${e instanceof Error ? e.message : String(e)}`);
      await refresh();
    } finally {
      setBusyName(null);
    }
  }, [refresh]);

  const doToggle = React.useCallback((name: string, currentlyOn: boolean): void => {
    if (currentlyOn) { void doUnload(name); } else { void doEnable(name); }
  }, [doUnload, doEnable]);

  /* A-1197 · B4（T1 脚本信任）：切换信任开关 —— 主进程写 trust.json 后自动重装，
     快照直接带回（免一次往返）；失败如实提示（写盘失败/目录缺失都原样上抛）。 */
  const doTrust = React.useCallback(async (name: string, trusted: boolean): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.pluginsTrustSet) {
      showNotice(false, "当前环境不支持脚本信任开关");
      return;
    }
    setBusyTrustName(name);
    try {
      const res = await a.extras.pluginsTrustSet(name, trusted);
      const snap = res?.snapshot ? normalizeSnapshot(res.snapshot) : null;
      if (snap) {
        setPlugins(snap.plugins);
        setRejected(snap.rejected);
        setPluginsFailed(false);
      }
      if (res?.ok) {
        showNotice(true, trusted ? `已信任 ${name} 的脚本（脚本工具已装配）` : `已撤销 ${name} 的脚本信任（工具立即注销）`);
      } else {
        showNotice(false, res?.error ? `信任开关操作失败：${res.error}` : "信任开关操作失败");
      }
      if (!snap) { await refresh(); }
    } catch (e) {
      showNotice(false, `信任开关操作失败：${e instanceof Error ? e.message : String(e)}`);
      await refresh();
    } finally {
      setBusyTrustName(null);
    }
  }, [refresh]);

  /* A-1197 · B1：写设置项。**渲染层不做持久化判断**（那是主进程的事），
     这里只负责调通道 + 把结果如实显示（含主进程回传的 warnings）。 */
  const doSettingSubmit = React.useCallback(async (plugin: string, key: string, value: unknown): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.pluginsSettingsSet) {
      showNotice(false, "当前环境不支持修改插件设置");
      return;
    }
    setBusySettingKey(`${plugin}:${key}`);
    try {
      const res = await a.extras.pluginsSettingsSet(plugin, key, value);
      if (res?.ok) {
        showNotice(true, `已保存 ${plugin} 的设置项 ${key}`);
      } else {
        showNotice(false, `保存失败：${res?.error ? String(res.error) : "未知原因"}`);
      }
    } catch (e) {
      showNotice(false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusySettingKey(null);
      setSettingsToken((v) => v + 1);
    }
  }, []);

  const doReload = React.useCallback(async (): Promise<void> => {
    const a = api.current;
    if (!a?.extras?.pluginsReload) {
      showNotice(false, "当前环境不支持重新装载");
      return;
    }
    setLoading(true);
    try {
      const snap = normalizeSnapshot(await a.extras.pluginsReload());
      if (snap) {
        setPlugins(snap.plugins);
        setRejected(snap.rejected);
        setPluginsFailed(false);
      }
      showNotice(true, "已重新扫描装载");
    } catch (e) {
      showNotice(false, `重新装载失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    api.current = (window as any).slimeAPI ?? null;
    void refresh();
  }, [refresh]);

  /** A-1197：主进程自动重扫完成后（磁盘上新增/改了插件或技能）本页自己刷新 ——
   *  必须排在 `api.current` 赋值之后，否则订阅挂在 null 上，等于没订阅。 */
  React.useEffect(() => {
    const off = api.current?.extras?.pluginsOnChanged?.(() => { void refresh(); });
    return () => { off?.(); };
  }, [refresh]);

  
  const stats = React.useMemo(() => {
    const byOrigin: Record<string, number> = { agent: 0, market: 0, user: 0, "": 0 };
    for (const s of skills) {
      const k = originOf(s).key;
      byOrigin[k] = (byOrigin[k] ?? 0) + 1;
    }
    const byKind: Record<string, number> = { stdio: 0, http: 0 };
    for (const m of mcp) {
      const k = (m.kind ?? "").trim().toLowerCase();
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    const builtin = plugins.filter((p) => p.origin === "builtin");
    const agentMade = plugins.filter((p) => p.origin === "agent");
    const external = plugins.filter((p) => p.origin === "user" || p.origin === "market");
    return {
      skillTotal: skills.length,
      skillEnabled: skills.filter((s) => s.enabled).length,
      byOrigin,
      mcpTotal: mcp.length,
      mcpEnabled: mcp.filter((m) => m.enabled).length,
      byKind,
      builtinGroups: builtin.length,
      builtinTools: builtin.reduce((n, p) => n + p.tools.length, 0),
      agentMade,
      external,
      rejectedCount: rejected.length,
    };
  }, [skills, mcp, plugins, rejected]);

  const go = React.useCallback((tab: "skills" | "mcp"): void => {
    if (!props.onNavigate) {
      showNotice(false, "当前环境不支持切换设置页，请手动点开左栏的对应栏目");
      return;
    }
    props.onNavigate(tab);
  }, [props]);

  return (
    <div className="settings-pane" style={{ padding: "16px 0", overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ fontSize: 18, margin: 0, flex: 1 }}>扩展</h2>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          技能 {stats.skillTotal}（启用 {stats.skillEnabled}）· MCP {stats.mcpTotal}（启用 {stats.mcpEnabled}）
        </span>
        <button className="btn" style={{ fontSize: 11.5, padding: "4px 10px" }}
          disabled={loading}
          onClick={() => { setLoading(true); void refresh(); }}>刷新</button>
        <button className="btn" style={{ fontSize: 11.5, padding: "4px 10px" }}
          disabled={loading}
          onClick={() => { void doReload(); }}>重新装载</button>
      </div>

      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 12 }}>
        本页是三类插件来源的总览 —— 系统默认随应用提供不可卸载，Agent 自建与外部载入可用右侧拨片开关启停；
        技能与 MCP 两类机制仍各自独立管理，不受插件容器管辖。
        扩展一律是<b>外部</b>能力（可开可关、卸下即恢复原样）——<b>不改动应用本身</b>。
      </div>

      {notice && (
        <div style={{
          marginBottom: 12,
          padding: "8px 12px", borderRadius: 9, fontSize: 12.5,
          border: `1px solid ${notice.ok ? "var(--success)" : "var(--warning)"}`,
          color: notice.ok ? "var(--success)" : "var(--warning)",
        }}>{notice.text}</div>
      )}

      {}
      <div style={{
        marginBottom: 12, padding: "11px 14px", borderRadius: 10,
        border: "1px dashed var(--warning)",
      }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--warning)", marginBottom: 6 }}>
          现状说明
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.65 }}>
          插件清单与装卸语义已经落地，来源分三类：<b>系统默认</b>（代码内置，不可卸载）、
          <b>Agent 自建</b>（<code>origin: agent</code>）、<b>外部载入</b>（<code>origin: user</code>，
          从 <code>{PLUGINS_ROOT}</code> 扫描，逐份 fail-closed 校验）。
          远程插件包的下载与安装<b>尚未开放</b>（需先做签名校验）；下面的技能与 MCP 两类机制仍各自独立管理。
        </div>
      </div>

      {}
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Badge text="系统默认" tone="accent" title="origin = builtin，随应用提供" />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>系统默认插件</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            共 {stats.builtinGroups} 族 · {stats.builtinTools} 个内置工具
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.65 }}>
          这些是 slime <b>自带</b>的内置能力，随应用一起提供、<b>不可卸载</b>。每一族是一组同领域的内置能力
          （对应一份插件清单，<code>origin</code> 为 <code>builtin</code>），下面列出它贡献了什么、有哪些工具与源码模块。
        </div>

        {pluginsFailed && (
          <div style={{
            padding: "8px 12px", borderRadius: 9, fontSize: 12.5,
            border: "1px solid var(--warning)", color: "var(--warning)",
          }}>
            系统默认插件清单读取失败，未展示任何数据。
          </div>
        )}
        {!pluginsFailed && stats.builtinGroups === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>暂无系统默认插件。</div>
        )}
        {!pluginsFailed && stats.builtinGroups > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {stats.builtinGroups < plugins.length && (
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                另有 {plugins.length - stats.builtinGroups} 个非内置插件，见下方来源块。
              </div>
            )}
            {plugins.filter((p) => p.origin === "builtin").map((p) => (<BuiltinPluginGroupCard key={p.name} row={p} />))}
          </div>
        )}
      </div>

      {}
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Badge text="Agent 自建" tone="accent" title="origin = agent，由 Agent 在创造模式下自行创建" />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>Agent 自建</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            共 {stats.agentMade.length} 个
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.65 }}>
          Agent 在<b>创造模式</b>下为自己创建的插件：目录放在 <code>{PLUGINS_ROOT}/插件名/</code>，
          内含一份 <code>plugin.json</code>（<code>origin</code> 必须如实写 <code>agent</code>，写 <code>builtin</code> 会被拒绝）。
          用右侧拨片开关<b>随时启停</b>（关闭会写入禁用名单，重启后保持关闭）。
        </div>
        {stats.agentMade.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.65 }}>
            尚无 —— 让 Agent 在创造模式下自建，或手动把插件目录放进 {PLUGINS_ROOT}。
          </div>
        )}
        {stats.agentMade.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {stats.agentMade.map((p) => (
              <SourcedPluginCard key={p.name} row={p} busy={busyName === p.name}
                onToggle={doToggle} onSettingSubmit={doSettingSubmit}
                busySettingKey={busySettingKey} settingsToken={settingsToken}
                trusted={p.trusted} busyTrust={busyTrustName === p.name} onTrustToggle={doTrust} />
            ))}
          </div>
        )}
      </div>

      {}
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Badge text="外部载入" tone="accent" title="origin = user / market，由磁盘扫描装载" />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>外部载入</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            共 {stats.external.length} 个
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.65 }}>
          用户自己放进 <code>{PLUGINS_ROOT}/插件名/</code> 的插件目录（含 <code>plugin.json</code>）。
          装载时逐份 fail-closed 校验：清单字段非法、<code>name</code> 与目录名不符、
          含不可见 Unicode 字符、<code>origin</code> 冒充 <code>builtin</code> 的目录都会被拒绝。用右侧拨片开关启停。
        </div>
        {stats.external.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.65 }}>
            把插件目录（含 plugin.json）放进 {PLUGINS_ROOT} 即会装载；远程插件包下载尚未开放（需先做签名校验）。
          </div>
        )}
        {stats.external.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {stats.external.map((p) => (
              <SourcedPluginCard key={p.name} row={p} busy={busyName === p.name}
                onToggle={doToggle} onSettingSubmit={doSettingSubmit}
                busySettingKey={busySettingKey} settingsToken={settingsToken}
                trusted={p.trusted} busyTrust={busyTrustName === p.name} onTrustToggle={doTrust} />
            ))}
          </div>
        )}
      </div>

      {stats.rejectedCount > 0 && <RejectedDirsCard rejected={rejected} />}

      {}
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Badge text="指令层" tone="accent" title="技能进的是上下文，不是工具表" />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>技能</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            共 {stats.skillTotal} 个 · 启用 {stats.skillEnabled} 个
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.65 }}>
          技能是给模型的<b>指导</b>（怎么做）：Markdown 指导正文 —— 知识、流程、规范。注入方式是
          <b> 目录 + 按需加载正文</b>，模型先看到技能目录，需要时才读某个技能的正文。
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, color: "var(--text-dim)", flexShrink: 0 }}>来源构成</span>
          <Badge text={`Agent 自建 ${stats.byOrigin.agent ?? 0}`} tone="dim" title={ORIGIN_META.agent.hint} />
          <Badge text={`官方市场 ${stats.byOrigin.market ?? 0}`} tone="dim" title={ORIGIN_META.market.hint} />
          <Badge text={`用户自备 ${stats.byOrigin.user ?? 0}`} tone="dim" title={ORIGIN_META.user.hint} />
          <Badge text={`未声明 ${stats.byOrigin[""] ?? 0}`} tone="dim" title="该技能的 SKILL.md frontmatter 未声明 origin" />
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
          来源取自 SKILL.md frontmatter 的 <code>origin</code> 声明，仅用于分类展示。它是技能自己声明的，
          <b>不能作为安全依据</b> —— 权限判定始终走沙箱与权限配置。
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" style={{ fontSize: 11.5, padding: "4px 12px" }}
            onClick={() => { go("skills"); }}>去技能库管理</button>
          <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            列表 / 启停 / 删除 / 新增 / 市场搜索与安装 / 打开技能目录
          </span>
        </div>
      </div>

      {}
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Badge text="能力层" tone="accent" title="MCP 进的是工具表，不是上下文" />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>MCP</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            共 {stats.mcpTotal} 个 · 启用 {stats.mcpEnabled} 个
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.65 }}>
          MCP 是给模型的<b>工具来源</b>（能做什么）：由外部服务提供工具（以及 resources / prompts），
          <b>注册进工具表</b>，模型只能通过这些工具触达外部世界。
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, color: "var(--text-dim)", flexShrink: 0 }}>类型构成</span>
          <Badge text={`stdio ${stats.byKind.stdio ?? 0}`} tone="dim" title="本地命令启动的服务器" />
          <Badge text={`http ${stats.byKind.http ?? 0}`} tone="dim" title="远程 HTTP 服务" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" style={{ fontSize: 11.5, padding: "4px 12px" }}
            onClick={() => { go("mcp"); }}>去 MCP 接入管理</button>
          <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            列表 / 启停 / 增删 / 注册表搜索与安装
          </span>
        </div>
      </div>

      {loading && (
        <div style={{ fontSize: 12.5, color: "var(--text-dim)", paddingTop: 2 }}>读取中…</div>
      )}
    </div>
  );
}