









import React, { type JSX } from "react";
import type { NotifyConfigDTO, FallbackPoolEntryDTO, ProviderSummary } from "../../shared/ipc.js";
import { confirmAsync } from "../dialog.js";

import { playCustomNotifySound, invalidateNotifySoundCache } from "../notifySound.js";

import { AUTOCOMPRESS_CFG_EVENT } from "./ChatPanel.js";

import { readLedgerCurrencyPref, saveLedgerCurrencyPref, type LedgerCurrencyPref } from "./ledgerCurrencyCfg.js";


function Pill(props: { on: boolean; disabled?: boolean; title?: string; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      style={{
        height: 26, padding: "0 14px", borderRadius: 13, cursor: props.disabled ? "default" : "pointer",
        border: `1px solid ${props.on ? "var(--accent)" : "var(--border)"}`,
        background: props.on ? "var(--accent-soft)" : "transparent",
        color: props.on ? "var(--accent-hover)" : "var(--text-muted)",
        fontSize: 12, fontWeight: 700, opacity: props.disabled ? 0.6 : 1,
      }}
    >
      {props.on ? "已开启" : "已关闭"}
    </button>
  );
}


function MiniBtn(props: { children: React.ReactNode; disabled?: boolean; danger?: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        height: 26, padding: "0 12px", borderRadius: 8, cursor: props.disabled ? "default" : "pointer",
        fontSize: 12, fontWeight: 600, opacity: props.disabled ? 0.6 : 1,
        border: `1px solid ${props.danger ? "var(--danger)" : "var(--border)"}`,
        background: props.danger ? "var(--danger-soft)" : "var(--bg-hover)",
        color: props.danger ? "#f87171" : "var(--accent-hover)",
      }}
    >
      {props.children}
    </button>
  );
}

/** 数据目录卡片里的静态标记（自定义/默认/异常），只做展示，不可点。 */
function Badge(props: { tone: "accent" | "muted" | "warn"; children: React.ReactNode }): JSX.Element {
  const c = props.tone === "accent"
    ? { border: "var(--accent)", bg: "var(--accent-soft)", fg: "var(--accent-hover)" }
    : props.tone === "warn"
      ? { border: "var(--warning)", bg: "var(--warning-soft)", fg: "var(--warning)" }
      : { border: "var(--border)", bg: "var(--bg-hover)", fg: "var(--text-muted)" };
  return (
    <span style={{
      flexShrink: 0, padding: "2px 9px", borderRadius: 999,
      border: `1px solid ${c.border}`, background: c.bg, color: c.fg,
      fontSize: 11, fontWeight: 700, whiteSpace: "nowrap",
    }}>
      {props.children}
    </span>
  );
}


type DataRootInfo = { root: string; custom: boolean; default: string; exists: boolean };


const GeneralPanel = React.memo(function GeneralPanel(): JSX.Element {
  const [autostart, setAutostart] = React.useState<boolean | null>(null);
  const [exitMode, setExitModeState] = React.useState<"quit" | "background">("quit");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  
  const [reqCfg, setReqCfg] = React.useState<{ concurrency: number; reconnectBaseMs: number }>({ concurrency: 2, reconnectBaseMs: 3000 });
  const [reqBusy, setReqBusy] = React.useState(false);
  
  const [acCfg, setAcCfg] = React.useState<{ enabled: boolean; ratio: number; mode: "animated" | "silent" }>(() => {
    try {
      const raw = localStorage.getItem("slime_auto_compress");
      if (raw) {
        const p = JSON.parse(raw) as Partial<{ enabled: boolean; ratio: number; mode: "animated" | "silent" }>;
        const ratio = typeof p.ratio === "number" && p.ratio >= 0.5 && p.ratio <= 0.97 ? p.ratio : 0.85;
        return { enabled: p.enabled !== false, ratio, mode: p.mode === "silent" ? "silent" : "animated" };
      }
    } catch {  }
    return { enabled: true, ratio: 0.85, mode: "animated" };
  });
  
  const [nCfg, setNCfg] = React.useState<NotifyConfigDTO>({ enabled: false, soundEnabled: true, soundFile: null, soundName: null });
  
  const [fbEntries, setFbEntries] = React.useState<FallbackPoolEntryDTO[]>([]);
  const [fbProviders, setFbProviders] = React.useState<ProviderSummary[]>([]);
  const [fbProvider, setFbProvider] = React.useState<string>("");
  const [fbModel, setFbModel] = React.useState<string>("");
  const [fbBusy, setFbBusy] = React.useState(false);
  
  const [ledgerCur, setLedgerCur] = React.useState<LedgerCurrencyPref>(() => readLedgerCurrencyPref());
  const [nBusy, setNBusy] = React.useState(false);
  const [soundBusy, setSoundBusy] = React.useState(false);
  const [dataRoot, setDataRoot] = React.useState<DataRootInfo | null>(null);
  const [drBusy, setDrBusy] = React.useState(false);
  // api.current 在挂载后的 useEffect 里才赋值，memo 组件不会因赋值而重渲染，
  // 所以「后端接口是否就绪」必须用 state 记，才能正确驱动按钮的禁用态。
  const [sysReady, setSysReady] = React.useState(false);
  const api = React.useRef<any>(null);
  const alive = React.useRef(true);

  const showNotice = (ok: boolean, text: string): void => {
    if (!alive.current) { return; }
    setNotice({ ok, text });
    window.setTimeout(() => { if (alive.current) { setNotice(null); } }, 4000);
  };

  
  const saveAutoCompress = (next: { enabled?: boolean; ratio?: number; mode?: "animated" | "silent" }): void => {
    setAcCfg((prev) => {
      const merged = { ...prev, ...next };
      try {
        localStorage.setItem("slime_auto_compress", JSON.stringify(merged));
        
        window.dispatchEvent(new CustomEvent(AUTOCOMPRESS_CFG_EVENT, { detail: merged }));
      } catch {  }
      return merged;
    });
    showNotice(true, "上下文自动压缩配置已保存（聊天发送前自动生效）");
  };

  






  const fbModelOptions = React.useMemo((): string[] => {
    const p = fbProviders.find((x) => x.key === fbProvider);
    const list = p && Array.isArray(p.models) ? p.models : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of list) {
      const id = typeof m?.id === "string" ? m.id : "";
      if (!id || seen.has(id) || m.selected === false) { continue; }
      seen.add(id);
      out.push(id);
    }
    return out;
  }, [fbProviders, fbProvider]);

  
  async function saveFallbackEntries(next: FallbackPoolEntryDTO[], okText: string): Promise<boolean> {
    if (!api.current?.fallback?.set || fbBusy) { return false; }
    setFbBusy(true);
    try {
      const r: { ok: boolean; entries?: FallbackPoolEntryDTO[]; error?: string } = await api.current.fallback.set(next);
      if (r?.ok && Array.isArray(r.entries)) { setFbEntries(r.entries); }
      showNotice(Boolean(r?.ok), r?.ok ? okText : `保存失败：${r?.error ?? "未知错误"}`);
      return Boolean(r?.ok);
    } catch (e) {
      showNotice(false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally { setFbBusy(false); }
  }

  function addFallbackEntry(): void {
    const provider = fbProvider.trim();
    const model = fbModel.trim();
    if (!provider || !model) { showNotice(false, "请先选择供应商与模型（没有模型列表时可直接输入模型 ID）"); return; }
    if (fbEntries.some((e) => e.provider === provider && e.model === model)) { showNotice(false, `这条已在降级池里：${provider} / ${model}`); return; }
    void saveFallbackEntries([...fbEntries, { provider, model }], `已加入降级池：${provider} / ${model}`).then((ok) => {
      if (ok) { setFbModel(""); }
    });
  }

  function removeFallbackEntry(index: number): void {
    const hit = fbEntries[index];
    void saveFallbackEntries(fbEntries.filter((_, i) => i !== index), `已从降级池移除：${hit?.provider ?? ""} / ${hit?.model ?? ""}`);
  }

  
  function moveFallbackEntry(index: number): void {
    if (index <= 0) { return; }
    const next = [...fbEntries];
    const [item] = next.splice(index, 1);
    next.splice(index - 1, 0, item);
    void saveFallbackEntries(next, `已上移：${item.provider} / ${item.model}`);
  }

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    alive.current = true;
    setSysReady(Boolean(w.slimeAPI?.system?.dataRootGet));
    if (api.current?.settings?.autostartGet) {
      void api.current.settings.autostartGet().then((r: { ok: boolean; enabled: boolean }) => {
        setAutostart(r.enabled);
      });
    }
    if (api.current?.window?.getExitMode) {
      void api.current.window.getExitMode().then((r: { mode: "quit" | "background" }) => setExitModeState(r.mode));
    }
    if (api.current?.requests?.get) {
      void api.current.requests.get().then((r: { concurrency?: number; reconnectBaseMs?: number }) => {
        setReqCfg({
          concurrency: typeof r?.concurrency === "number" ? r.concurrency : 2,
          reconnectBaseMs: typeof r?.reconnectBaseMs === "number" ? r.reconnectBaseMs : 3000,
        });
      }).catch(() => {});
    }
    
    if (api.current?.notify?.get) {
      void api.current.notify.get().then((r: { ok: boolean; config: NotifyConfigDTO }) => {
        if (r?.config) { setNCfg(r.config); }
      }).catch(() => {});
    }
    
    
    if (api.current?.fallback?.get) {
      void api.current.fallback.get().then((r: { ok: boolean; entries?: FallbackPoolEntryDTO[]; providers?: ProviderSummary[] }) => {
        if (Array.isArray(r?.entries)) { setFbEntries(r.entries); }
        if (Array.isArray(r?.providers)) { setFbProviders(r.providers); }
      }).catch(() => {});
    }
    void refreshDataRoot();
  }, []);

  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  
  async function patchNotify(patch: Partial<Pick<NotifyConfigDTO, "enabled" | "soundEnabled">>, okText: string): Promise<void> {
    if (!api.current?.notify?.set || nBusy) { return; }
    setNBusy(true);
    try {
      const r = await api.current.notify.set(patch);
      if (r?.config) { setNCfg(r.config); }
      showNotice(Boolean(r?.ok), r?.ok ? okText : (r?.error ?? "保存失败"));
    } catch (e) {
      showNotice(false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setNBusy(false);
    }
  }

  
  async function pickSound(): Promise<void> {
    if (!api.current?.notify?.pickSound || soundBusy) { return; }
    setSoundBusy(true);
    try {
      const r = await api.current.notify.pickSound();
      if (r?.canceled) { return; }
      if (r?.config) { setNCfg(r.config); }
      if (r?.ok) {
        
        invalidateNotifySoundCache();
        showNotice(true, `已上传提示音：${r.name ?? "自定义音频"}`);
      } else {
        showNotice(false, r?.error ?? "上传失败");
      }
    } catch (e) {
      showNotice(false, `上传失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSoundBusy(false);
    }
  }

  
  async function removeSound(): Promise<void> {
    if (!api.current?.notify?.clearSound || soundBusy) { return; }
    setSoundBusy(true);
    try {
      const r = await api.current.notify.clearSound();
      if (r?.config) { setNCfg(r.config); }
      invalidateNotifySoundCache();
      showNotice(Boolean(r?.ok), r?.ok ? "已恢复系统默认提示音" : (r?.error ?? "操作失败"));
    } catch (e) {
      showNotice(false, `操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSoundBusy(false);
    }
  }

  
  async function previewSound(): Promise<void> {
    const ok = await playCustomNotifySound();
    if (!ok) { showNotice(false, "试听失败：音频无法播放（格式不被支持或文件已丢失）"); }
  }

  
  async function sendTest(): Promise<void> {
    if (!api.current?.notify?.test || nBusy) { return; }
    setNBusy(true);
    try {
      const r = await api.current.notify.test();
      if (r?.config) { setNCfg(r.config); }
      showNotice(Boolean(r?.ok), r?.ok ? "已发送测试通知（留意系统通知中心）" : "测试通知发送失败");
    } catch (e) {
      showNotice(false, `测试失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setNBusy(false);
    }
  }

  async function saveRequests(): Promise<void> {
    if (!api.current?.requests?.set || reqBusy) { return; }
    setReqBusy(true);
    try {
      const r = await api.current.requests.set(reqCfg);
      showNotice(Boolean(r.ok), r.ok ? "请求频率已保存（新增任务/下次重连生效）" : (r.error ?? "保存失败"));
    } catch (e) {
      showNotice(false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReqBusy(false);
    }
  }

  async function toggleAutostart(next: boolean): Promise<void> {
    if (!api.current?.settings?.autostartSet || busy) { return; }
    setBusy(true);
    try {
      const r = await api.current.settings.autostartSet(next);
      setAutostart(Boolean(r.enabled));
      showNotice(r.ok, r.ok ? (r.enabled ? "已开启开机自启" : "已关闭开机自启") : (r.error ?? "设置失败"));
    } catch (e) {
      showNotice(false, `设置失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleUninstall(): Promise<void> {
    if (!api.current?.settings?.uninstall) { return; }
    const sure = await confirmAsync(
      "确定要卸载 Slime 吗？",
      "将启动卸载程序，应用会立即退出。卸载过程中可另行选择是否保留用户数据（API 密钥、Agent、会话历史）。",
    );
    if (!sure) { return; }
    setBusy(true);
    try {
      const r = await api.current.settings.uninstall();
      if (!r.ok) {
        showNotice(false, r.error ?? "启动卸载程序失败");
        setBusy(false);
      }
      
    } catch (e) {
      showNotice(false, `启动卸载程序失败：${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  /* ── 数据目录（window.slimeAPI.system.dataRoot*） ── */

  async function refreshDataRoot(): Promise<void> {
    if (!api.current?.system?.dataRootGet) { return; }
    try {
      const r = await api.current.system.dataRootGet();
      if (!alive.current) { return; }
      if (r && typeof r.root === "string" && r.root) { setDataRoot(r as DataRootInfo); }
    } catch { /* 读取失败保持骨架，不打扰用户 */ }
  }

  /** 迁移是复制而非移动：确认文案必须说清，且明确需要重启。 */
  async function applyDataRoot(dir: string, migrate: boolean): Promise<void> {
    if (!api.current?.system?.dataRootSet || drBusy) { return; }
    setDrBusy(true);
    try {
      const r = await api.current.system.dataRootSet({ dir, migrate });
      if (!alive.current) { return; }
      if (!r?.ok) {
        showNotice(false, `更改数据目录失败：${r?.error ?? "未知错误"}`);
        return;
      }
      // 落盘后读回真实生效路径，避免界面停留在旧值。
      const shown = (typeof r.root === "string" && r.root) ? r.root : dir;
      setDataRoot((prev) => ({ root: shown, custom: true, default: prev?.default ?? "", exists: true }));
      showNotice(
        true,
        `${migrate ? "已复制数据并切换到" : "已切换到"}：${shown}` +
        (r.needRestart ? " —— 请完全退出并重启 Slime 后彻底生效" : "（下次启动生效）"),
      );
      void refreshDataRoot();
    } catch (e) {
      showNotice(false, `更改数据目录失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) { setDrBusy(false); }
    }
  }

  async function changeDataRoot(migrate: boolean): Promise<void> {
    if (!api.current?.system?.dataRootPick || drBusy) { return; }
    let picked: string;
    try {
      const r = await api.current.system.dataRootPick();
      if (!r?.ok || r?.canceled) {
        showNotice(false, "已取消选择，数据目录未改动");
        return;
      }
      if (!r.dir) { showNotice(false, "未拿到目录路径，数据目录未改动"); return; }
      picked = r.dir;
    } catch (e) {
      showNotice(false, `选择目录失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const from = dataRoot?.root ?? "（当前目录未知）";
    const sure = await confirmAsync(
      `把数据目录改到「${picked}」？`,
      `当前生效目录：${from}\n\n` +
      (migrate
        ? "已选择「同时迁移现有数据」：应用会把现有数据复制到新目录后再切换过去。\n" +
          "注意：迁移是复制，不会删除原目录里的数据；若新目录已有同名文件会被覆盖。原目录的旧数据需要你自己确认无误后手动清理。\n"
        : "本次只改位置、不迁移：新目录会是空的。已有数据（API 密钥、Agent、技能、会话历史）仍留在旧目录里，不会自动带过去；\n" +
          "若想继续沿用旧数据，请改用「更改并迁移…」。\n") +
      "\n数据根在 Slime 启动时求值一次，所以改完必须完全退出并重启 Slime 才彻底生效。",
    );
    if (!sure) { showNotice(false, "已取消，数据目录未改动"); return; }
    await applyDataRoot(picked, migrate);
  }

  async function resetDataRoot(): Promise<void> {
    if (!api.current?.system?.dataRootReset || drBusy) { return; }
    const to = dataRoot?.default ?? "系统默认位置";
    const sure = await confirmAsync(
      "把数据目录恢复为默认位置？",
      `将改回：${to}\n\n` +
      (dataRoot
        ? `当前自定义目录「${dataRoot.root}」里的文件不会被删除，需要你自己确认后手动清理。\n`
        : "当前使用的就是默认位置，此操作不会改变什么。\n") +
      "\n数据根在 Slime 启动时求值一次，所以改完必须完全退出并重启 Slime 才彻底生效。",
    );
    if (!sure) { showNotice(false, "已取消，数据目录未改动"); return; }

    setDrBusy(true);
    try {
      const r = await api.current.system.dataRootReset();
      if (!alive.current) { return; }
      if (!r?.ok) { showNotice(false, `恢复默认失败：${r?.error ?? "未知错误"}`); return; }
      await refreshDataRoot();
      showNotice(true, `已恢复默认数据目录：${to}` + (r.needRestart ? " —— 请完全退出并重启 Slime 后彻底生效" : ""));
    } catch (e) {
      showNotice(false, `恢复默认失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) { setDrBusy(false); }
    }
  }

  /** 打开目录用的是现成的 shell.openPath（slimeAPI.workspace.openPath），不是臆造的能力。 */
  async function openDataRoot(): Promise<void> {
    const target = dataRoot?.root;
    if (!target) { showNotice(false, "数据目录尚未就绪，请稍后重试"); return; }
    if (!api.current?.workspace?.openPath) {
      showNotice(false, "当前版本不支持直接打开目录，请手动复制上方路径到资源管理器");
      return;
    }
    setDrBusy(true);
    try {
      const r = await api.current.workspace.openPath(target);
      showNotice(Boolean(r?.ok), r?.ok ? `已在资源管理器中打开：${target}` : `打开目录失败：${r?.error ?? "未知错误"}`);
    } catch (e) {
      showNotice(false, `打开目录失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) { setDrBusy(false); }
    }
  }

  return (
    
    <div className="settings-pane" style={{ padding: "16px 0", overflowY: "auto", height: "100%" }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>通用设置</h2>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 14 }}>
        应用级行为：请求频率、上下文自动压缩、全局降级池、系统通知与提示音、开机自启与卸载。大部分设置即时生效并持久化保存。
        （主题与界面外观设定已迁到「外观」栏。）
      </div>

      {notice && (
        <div style={{
          padding: "8px 12px", marginBottom: 12, fontSize: 12.5, lineHeight: 1.5,
          borderRadius: 8, border: "1px solid var(--border)",
          background: notice.ok ? "var(--success-soft)" : "var(--danger-soft)",
          color: notice.ok ? "var(--success)" : "#f87171",
        }}>
          {notice.text}
        </div>
      )}

      {}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>数据目录</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 12 }}>
          Slime 的全部本地数据都装在这一个目录下：<b>API 密钥、Agent 配置、技能（skill）/ 插件、会话历史、记忆与索引、下载缓存</b>。
          换盘、重装系统、备份时只要搬这一个目录即可。
          <br />
          <b>改完必须完全退出并重启 Slime 才彻底生效</b>
          <span style={{ color: "var(--text-dim)" }}>
            —— 数据根在进程启动时只求值一次，运行中改设置不会让已打开的文件句柄换位置。
          </span>
        </div>

        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 10,
          border: "1px solid var(--card-border, var(--border))",
          background: "var(--card-surface, var(--bg-input))",
        }}>
          <code style={{
            flex: 1, minWidth: 0, fontSize: 11.5, fontFamily: "Consolas, monospace",
            color: "var(--text-secondary)", wordBreak: "break-all", lineHeight: 1.5,
            userSelect: "text",
          }}>
            {dataRoot ? dataRoot.root : "正在读取当前数据目录…"}
          </code>
          {dataRoot && (
            dataRoot.custom
              ? <Badge tone="accent">自定义</Badge>
              : <Badge tone="muted">默认</Badge>
          )}
          {dataRoot && !dataRoot.exists && <Badge tone="warn">目录不存在</Badge>}
        </div>

        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <MiniBtn disabled={drBusy || !sysReady} onClick={() => void changeDataRoot(true)}>
            {drBusy ? "处理中…" : "更改并迁移…"}
          </MiniBtn>
          <MiniBtn disabled={drBusy || !sysReady} onClick={() => void changeDataRoot(false)}>
            仅更改位置
          </MiniBtn>
          <MiniBtn disabled={drBusy || !dataRoot} onClick={() => void openDataRoot()}>
            打开目录
          </MiniBtn>
          <MiniBtn danger disabled={drBusy || !dataRoot?.custom} onClick={() => void resetDataRoot()}>
            恢复默认
          </MiniBtn>
        </div>

        {!sysReady && (
          <div style={{ fontSize: 11, color: "var(--warning)", marginTop: 8, lineHeight: 1.5 }}>
            当前版本未提供修改数据目录的能力，请升级应用后再试。
          </div>
        )}

        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
          「更改并迁移…」会把现有数据<b>复制</b>到新目录后再切换（不删除原目录里的数据，确认无误后请自行清理）；
          「仅更改位置」只改路径，新目录是空的，旧数据仍留在原处。改完都需要重启 Slime。
          {dataRoot && !dataRoot.custom && dataRoot.default && dataRoot.default !== dataRoot.root && (
            <>
              <br />
              出厂默认位置：<span style={{ fontFamily: "Consolas, monospace" }}>{dataRoot.default}</span>
            </>
          )}
        </div>
      </div>

      {}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>请求频率</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 12 }}>
          用于匹配不同供应商的限流档位（RPM/并发）。若经常「生成到一半标红报错/被中断」，通常是上游节流——把并发调低、把重连间隔调大即可缓解。
          <br />
          <span style={{ color: "var(--text-dim)" }}>
            已内置**每分钟请求数（RPM）限流器**：按供应商自动限速（如 Agnes 免费档 10 次/分），
            并在额度用满时排队等待而不是硬发出去撞 429；上游响应头里带真实额度时会自动改用实测值。
            本项控制的是**同时发起**的请求数（子代理并行度），与上面的 RPM 限速叠加生效。
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
            并发上限（同时发起的请求数）
            <select className="input-field" value={reqCfg.concurrency}
              onChange={(e) => setReqCfg((p) => ({ ...p, concurrency: Number(e.target.value) }))}>
              <option value={1}>1（最保守）</option>
              <option value={2}>2（默认，推荐）</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
              <option value={8}>8（高吞吐，需高 Tier）</option>
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
            断流自动重连基间隔
            <select className="input-field" value={reqCfg.reconnectBaseMs}
              onChange={(e) => setReqCfg((p) => ({ ...p, reconnectBaseMs: Number(e.target.value) }))}>
              <option value={1000}>1 秒（激进）</option>
              <option value={2000}>2 秒</option>
              <option value={3000}>3 秒（默认，推荐）</option>
              <option value={5000}>5 秒（温柔）</option>
            </select>
          </label>
          <button
            style={{
              borderRadius: 8,
              height: 34,
              padding: "0 18px",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              color: "var(--accent-hover)",
            }}
            disabled={reqBusy} onClick={() => void saveRequests()}>
            {reqBusy ? "保存中…" : "保存"}
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8 }}>
          每次重连按「基间隔 × 已尝试次数」指数递增并加抖动（避免惊群）；并发上限同时约束 Swarm 并行。
        </div>
      </div>

      {}

      {}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>上下文自动压缩</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
              对话接近窗口上限时，发送前自动把早期对话压缩为摘要（摘要头 + 最近 N 轮），避免上下文被撑爆后模型遗忘或报错。
            </div>
          </div>
          <button
            onClick={() => saveAutoCompress({ enabled: !acCfg.enabled })}
            style={{
              height: 26, padding: "0 14px", borderRadius: 13, cursor: "pointer",
              border: `1px solid ${acCfg.enabled ? "var(--accent)" : "var(--border)"}`,
              background: acCfg.enabled ? "var(--accent-soft)" : "transparent",
              color: acCfg.enabled ? "var(--accent-hover)" : "var(--text-muted)",
              fontSize: 12, fontWeight: 700,
            }}>
            {acCfg.enabled ? "已开启" : "已关闭"}
          </button>
        </div>
        {acCfg.enabled && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
              触发占比（占用达到窗口上限的多少时压缩）
              <select className="input-field" value={acCfg.ratio}
                onChange={(e) => saveAutoCompress({ ratio: Math.min(0.97, Math.max(0.5, Number(e.target.value))) })}>
                <option value={0.6}>60%（提前压缩，最保守）</option>
                <option value={0.7}>70%</option>
                <option value={0.8}>80%（推荐）</option>
                <option value={0.85}>85%（默认）</option>
                <option value={0.9}>90%</option>
                <option value={0.95}>95%（窗口快满才压）</option>
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
              压缩过程展示
              <select className="input-field" value={acCfg.mode}
                onChange={(e) => saveAutoCompress({ mode: e.target.value === "silent" ? "silent" : "animated" })}>
                <option value="animated">过渡动画（整理→摘要→完成）</option>
                <option value="silent">静默压缩（后台完成，无界面打扰）</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>全局降级池</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.6 }}>
          首选供应商<b>整体</b>不可用（整池限流、下线）时，按这里的顺序改用别的供应商与模型。
          <br />
          <b>默认是空的 —— 不配就不跨供应商降级</b>，首选失败会如实报错。这里只影响「换一家」；
          首选供应商自己换模型不需要在这里配。
          <br />
          <span style={{ color: "var(--text-dim)" }}>
            注意：加入这里的模型在降级时<b>会收到你的对话内容</b> —— 只填你确实愿意发过去的供应商。
          </span>
        </div>

        {fbEntries.length === 0 ? (
          <div style={{
            marginTop: 10, padding: "10px 12px", borderRadius: 10,
            border: "1px dashed var(--card-border, var(--border))",
            fontSize: 12, color: "var(--text-dim)",
          }}>
            当前：无降级池（推荐保持）。首选供应商整体不可用时，聊天会直接报错并说明原因。
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            {fbEntries.map((e, i) => (
              <div key={`${e.provider}:${e.model}`} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "6px 0",
                borderBottom: "1px solid var(--card-border, var(--border))",
              }}>
                <span style={{ width: 16, fontSize: 11, color: "var(--text-dim)" }}>{i + 1}</span>
                <span style={{ flex: 1, minWidth: 120, fontSize: 12.5 }}>
                  <span style={{ color: "var(--accent-hover)", fontWeight: 600 }}>{e.provider}</span>
                  <span style={{ color: "var(--text-muted)" }}> / </span>
                  <span>{e.model}</span>
                </span>
                <MiniBtn disabled={fbBusy || i === 0} onClick={() => moveFallbackEntry(i)}>上移</MiniBtn>
                <MiniBtn danger disabled={fbBusy} onClick={() => removeFallbackEntry(i)}>移除</MiniBtn>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <select className="input-field" style={{ maxWidth: 200 }} value={fbProvider}
            onChange={(e) => { setFbProvider(e.target.value); setFbModel(""); }}>
            <option value="">选择供应商…</option>
            {fbProviders.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
          </select>
          {fbModelOptions.length > 0 ? (
            <select className="input-field" style={{ maxWidth: 240 }} value={fbModel}
              onChange={(e) => setFbModel(e.target.value)}>
              <option value="">选择模型…</option>
              {fbModelOptions.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          ) : (
            <input className="input-field" style={{ maxWidth: 240 }} value={fbModel}
              placeholder={fbProvider ? "输入模型 ID" : "先选供应商"}
              disabled={!fbProvider}
              onChange={(e) => setFbModel(e.target.value)} />
          )}
          <MiniBtn disabled={fbBusy || !fbProvider || !fbModel.trim()} onClick={() => addFallbackEntry()}>
            {fbBusy ? "保存中…" : "加入降级池"}
          </MiniBtn>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
          顺序 = 尝试顺序（先加的先试）。最多 12 条，落盘 config/fallback-pool.json；改完下一条消息即生效，不用重启。
          若某个供应商一个模型都选不出来，请先到「模型供应商」给它探测模型列表（也可以直接手填模型 ID）。
        </div>
      </div>

      {}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>消费币种（主页实时监测）</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.6 }}>
          右侧栏「会话指标 · 会话费用」用哪种币种显示。
          <br />
          <b>自动</b>：按"这笔钱主要花在哪个币种的模型上"推断 —— 国内厂商的模型（官方以 ¥ 刊例）
          按人民币显示，海外模型按美元显示；你在「模型供应商 → 定价」里给某模型手选过币种时以你的选择为准。
          <br />
          <b>固定人民币 / 固定美元</b>：不论模型归属地一律按该币种显示（折算只影响显示，不影响记账 ——
          账目恒以 USD 记录，历史账不会因此变化）。
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, marginTop: 10, maxWidth: 320 }}>
          显示币种
          <select className="input-field" value={ledgerCur}
            onChange={(e) => {
              const v: LedgerCurrencyPref = e.target.value === "CNY" ? "CNY" : e.target.value === "USD" ? "USD" : "auto";
              setLedgerCur(saveLedgerCurrencyPref(v));
              showNotice(true, `消费币种已设为「${v === "auto" ? "自动推断" : v === "CNY" ? "¥ 人民币" : "$ 美元"}」（右栏会话指标立即生效）`);
            }}>
            <option value="auto">自动（按模型币种推断，推荐）</option>
            <option value="CNY">固定 ¥ 人民币</option>
            <option value="USD">固定 $ 美元</option>
          </select>
        </label>
      </div>

      {}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>开机自动启动</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
              登录 Windows 后自动运行 Slime（写入 HKCU Run 注册表，与安装器选项一致）。
            </div>
          </div>
          <button
            onClick={() => void toggleAutostart(autostart !== true)}
            disabled={busy}
            title={autostart ? "点击关闭开机自启" : "点击开启开机自启"}
            style={{
              height: 26, padding: "0 14px", borderRadius: 13, cursor: "pointer",
              border: `1px solid ${autostart ? "var(--accent)" : "var(--border)"}`,
              background: autostart ? "var(--accent-soft)" : "transparent",
              color: autostart ? "var(--accent-hover)" : "var(--text-muted)",
              fontSize: 12, fontWeight: 700,
            }}>
            {autostart === null ? "…" : (autostart ? "已开启" : "已关闭")}
          </button>
        </div>
      </div>

      {}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>关闭应用时的行为</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, marginBottom: 10, lineHeight: 1.5 }}>
          选择直接退出，或最小化到系统托盘在后台保留（后台可继续执行定时任务 / 子代理，随时点击托盘图标恢复）。
        </div>
        {(["quit", "background"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              if (exitMode === m || busy) { return; }
              
              if (!api.current?.window?.setExitMode) {
                showNotice(false, "当前版本不支持该设置，请升级应用");
                return;
              }
              setBusy(true);
              void api.current.window.setExitMode(m).then((r: { ok: boolean; mode: "quit" | "background" }) => {
                setExitModeState(r.mode ?? m);
                showNotice(true, r.mode === "background" ? "已启用：关闭时最小化到后台托盘" : "已启用：关闭时直接退出");
              }).catch((e: unknown) => {
                showNotice(false, `设置失败：${e instanceof Error ? e.message : String(e)}`);
              }).finally(() => setBusy(false));
            }}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8, marginRight: 18, marginBottom: 4,
              background: "none", border: "none", cursor: "pointer", padding: "4px 0", fontSize: 12.5,
              color: exitMode === m ? "var(--accent-hover)" : "var(--text-muted)",
            }}
          >
            <span style={{ width: 14, height: 14, borderRadius: 999, border: `2px solid ${exitMode === m ? "var(--accent)" : "var(--border)"}`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              {exitMode === m && <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }} />}
            </span>
            {m === "quit" ? "直接退出" : "最小化到后台保留（托盘常驻）"}
          </button>
        ))}
      </div>

      {}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>系统通知</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
              Agent 任务完成、需要你做选择、出错或意外终止时，弹出操作系统通知。应用被最小化到托盘、或在后台跑长任务时最有用。
            </div>
          </div>
          <Pill
            on={nCfg.enabled}
            disabled={nBusy}
            title={nCfg.enabled ? "点击关闭系统通知" : "点击开启系统通知"}
            onClick={() => void patchNotify({ enabled: !nCfg.enabled }, nCfg.enabled ? "已关闭系统通知" : "已开启系统通知（任务完成/需选择/出错/意外终止时提示）")}
          />
        </div>

        {nCfg.enabled && (
          <>
            <div style={{ height: 1, background: "var(--card-border, var(--border))", margin: "14px 0 12px" }} />

            {}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>通知提示音</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.5 }}>
                  关闭则通知静默；开启后可用系统默认提示音，或上传你自己的音频。
                </div>
              </div>
              <Pill
                on={nCfg.soundEnabled}
                disabled={nBusy}
                title={nCfg.soundEnabled ? "点击静音" : "点击开启提示音"}
                onClick={() => void patchNotify({ soundEnabled: !nCfg.soundEnabled }, nCfg.soundEnabled ? "已关闭提示音（通知静默）" : "已开启提示音")}
              />
            </div>

            {nCfg.soundEnabled && (
              <div style={{
                marginTop: 10, padding: "10px 12px", borderRadius: 10,
                border: "1px solid var(--card-border, var(--border))",
                background: "var(--card-surface, var(--bg-input))",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 160, fontSize: 12.5, lineHeight: 1.5 }}>
                    {nCfg.soundFile
                      ? <>当前：<span style={{ color: "var(--accent-hover)", fontWeight: 600 }}>{nCfg.soundName ?? nCfg.soundFile}</span></>
                      : <span style={{ color: "var(--text-muted)" }}>当前：系统默认提示音</span>}
                  </div>
                  <MiniBtn disabled={soundBusy} onClick={() => void pickSound()}>
                    {soundBusy ? "处理中…" : (nCfg.soundFile ? "更换音频…" : "上传音频…")}
                  </MiniBtn>
                  {nCfg.soundFile && (
                    <MiniBtn disabled={soundBusy} onClick={() => void previewSound()}>试听</MiniBtn>
                  )}
                  {nCfg.soundFile && (
                    <MiniBtn danger disabled={soundBusy} onClick={() => void removeSound()}>恢复默认</MiniBtn>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
                  支持 mp3 / wav / ogg / m4a / aac / flac / webm / opus，单个文件不超过 8MB。音频会复制到应用配置目录，原文件可自由移动或删除。
                </div>
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <MiniBtn disabled={nBusy} onClick={() => void sendTest()}>
                {nBusy ? "发送中…" : "发送测试通知"}
              </MiniBtn>
              <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 10 }}>
                用来确认系统通知与提示音是否真的生效。
              </span>
            </div>
          </>
        )}
      </div>

      {}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>卸载 Slime</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
              启动系统卸载程序，移除应用本体。卸载时可选择是否保留用户数据（API 密钥、Agent、会话历史）。
            </div>
          </div>
          <button
            onClick={() => void handleUninstall()}
            disabled={busy}
            style={{
              height: 26, padding: "0 14px", borderRadius: 13, cursor: "pointer",
              border: "1px solid var(--danger)", background: "var(--danger-soft)",
              color: "#f87171", fontSize: 12, fontWeight: 700,
            }}>
            卸载
          </button>
        </div>
      </div>
    </div>
  );
});

export default GeneralPanel;
