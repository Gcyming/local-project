


















import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideHistoryGate, decideUiReady, settleAfterFrames, HISTORY_SETTLE_FRAMES } from "../../gui/src/renderer/pages/startupGate.js";
import { decideUpdatePolicy, describeUpdatePolicy, type UpdatePolicyReason } from "../../core-ts/src/services/updatePolicy.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");


const tomlActive = (rel: string): string =>
  read(rel).split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n");

const APP = "gui/src/renderer/App.tsx";
const SPLASH = "gui/src/renderer/pages/SplashScreen.tsx";
const CHAT = "gui/src/renderer/pages/ChatPanel.tsx";
const UPDATER = "gui/src/main/updater.ts";
const MIND = "gui/src/main/mind_config.ts";
const TOML = "gui/template/slime.toml";


describe("A-1059① 启动面板首帧必须不透明（不许先闪主界面）", () => {
  it("opaque 的初值是 visible，不是 false", () => {
    const src = code(SPLASH);
    expect(src).toContain("const [opaque, setOpaque] = React.useState(visible);");
    
    expect(src).not.toContain("const [opaque, setOpaque] = React.useState(false);");
  });

  it("退场淡出仍然保留（不能为了修首帧把过渡一起删掉）", () => {
    const src = code(SPLASH);
    expect(src).toContain("setOpaque(false);");
    expect(src).toContain("transition: \"opacity 240ms ease\"");
  });

  it("[反例] 断言能真的抓到坏写法（守卫自检）", () => {
    const good = "const [opaque, setOpaque] = React.useState(visible);";
    const bad = "const [opaque, setOpaque] = React.useState(false);";
    expect(good.includes("React.useState(visible)")).toBe(true);
    expect(bad.includes("React.useState(visible)")).toBe(false);
  });
});


describe("A-1059② 启动门：选中会话的决定落定前不许放行", () => {
  const base = {
    sessionsReady: true,
    sessionCount: 3,
    selectionSettled: true,
    hasSelectedSession: true,
    hasAgentId: true,
  };

  it("🐛 回归红线：列表已到但「还没决定选哪个会话」→ 必须等（这正是提前放行的那条路径）", () => {
    expect(decideHistoryGate({ ...base, selectionSettled: false, hasSelectedSession: false, hasAgentId: false }))
      .toBe("wait");
  });

  it("列表还没加载 → 等（此刻「有几个会话」不可知）", () => {
    expect(decideHistoryGate({ ...base, sessionsReady: false })).toBe("wait");
  });

  it("确实没有会话 → 收尾（欢迎页，本来就没有会话内容可等）", () => {
    expect(decideHistoryGate({ ...base, sessionCount: 0, hasSelectedSession: false, hasAgentId: false }))
      .toBe("self-finish");
  });

  it("已选中且拿得到 agentId → 等 ChatPanel 回执", () => {
    expect(decideHistoryGate(base)).toBe("wait");
  });

  it("已决定选中、但拿不到 agentId（占位文案分支）→ 收尾", () => {
    expect(decideHistoryGate({ ...base, hasAgentId: false })).toBe("self-finish");
  });

  it("优先级：[列表未就绪] 压过 [无会话]（否则会用一份空列表提前放行）", () => {
    expect(decideHistoryGate({ ...base, sessionsReady: false, sessionCount: 0 })).toBe("wait");
  });

  it("优先级：[无会话] 压过 [选中决定未落定]（没有会话时「落定」永远不会发生）", () => {
    expect(decideHistoryGate({
      sessionsReady: true, sessionCount: 0, selectionSettled: false,
      hasSelectedSession: false, hasAgentId: false,
    })).toBe("self-finish");
  });

  it("settleAfterFrames：等够帧数才回执，且 0 帧是同步回执", () => {
    const calls: Array<() => void> = [];
    const raf = (cb: () => void): void => { calls.push(cb); };
    
    
    const schedule = (): void => {  };
    let done = 0;
    settleAfterFrames(2, () => { done++; }, raf, schedule);
    expect(done, "还没跑帧就回执了 = 等于没等").toBe(0);
    calls.shift()!();
    expect(done, "只跑一帧不够（提交完成但布局未稳）").toBe(0);
    calls.shift()!();
    expect(done).toBe(1);
    settleAfterFrames(0, () => { done++; }, raf, schedule);
    expect(done).toBe(2);
  });

  it("🐛 rAF 被暂停时（窗口被遮挡/最小化）时间兜底必须代它收口，且 done 只调一次", () => {
    
    
    let scheduled: (() => void) | null = null;
    const raf = (): void => {  };
    const schedule = (cb: () => void): void => { scheduled = cb; };
    let done = 0;
    settleAfterFrames(2, () => { done++; }, raf, schedule);
    expect(done, "帧没来、兜底时间也没到，不该回执").toBe(0);
    expect(scheduled, "必须挂上时间兜底").not.toBeNull();
    scheduled!();
    expect(done, "兜底到点必须收口").toBe(1);
    
    scheduled!();
    expect(done).toBe(1);
  });

  it("等帧数与「DOM 提交后再发」的接线都在", () => {
    expect(HISTORY_SETTLE_FRAMES).toBeGreaterThanOrEqual(2);
    const chat = code(CHAT);
    expect(chat).toMatch(/settleAfterFrames\(HISTORY_SETTLE_FRAMES,\s*\(\)\s*=>\s*onHistoryLoaded\?\.\(\)\)/);
    const app = code(APP);
    expect(app).toContain("decideHistoryGate({");
    
    
    const call = /decideHistoryGate\(\{([\s\S]*?)\}\)/.exec(app);
    expect(call, "取不到 decideHistoryGate 的调用块").not.toBeNull();
    expect(call![1]).toContain("selectionSettled,");
    expect(call![1]).not.toMatch(/selectionSettled\s*:/);
    expect(call![1]).toContain("sessionCount: sessions.length");
  });

  it("🐛 首屏不再多走一趟 conversations.list（那一趟正是「选中晚于门」的成因）", () => {
    const app = code(APP);
    expect(app).not.toContain("const items = await api.conversations.list().catch(() => []);");
    expect(app).toContain("setSelectionSettled(true);");
    expect(app).toMatch(/const loadSessions = React\.useCallback\(async \(\): Promise<SessionItem\[\]> => \{/);
    
    expect(app).toContain("setSelectedSessionId((cur) => (cur && items.some((s) => s.sessionId === cur) ? cur : items[0].sessionId));");
  });

  it("[反例] 把「未落定」写成「收尾」必须能被抓到（守卫自检）", () => {
    const broken = (i: Parameters<typeof decideHistoryGate>[0]): string =>
      !i.sessionsReady ? "wait" : i.sessionCount === 0 ? "self-finish"
        : i.hasSelectedSession && i.hasAgentId ? "wait" : "self-finish";
    
    expect(broken({ ...base, selectionSettled: false, hasSelectedSession: false, hasAgentId: false }))
      .toBe("self-finish");
    expect(decideHistoryGate({ ...base, selectionSettled: false, hasSelectedSession: false, hasAgentId: false }))
      .toBe("wait");
  });
});


describe("A-1061④′ 启动门：内容组不许被元数据组的兜底绕过", () => {
  const KEYS = ["agents", "sessions", "providers", "localModels"] as const;
  const base = {
    metadataKeys: KEYS,
    contentKey: "chatHistory",
  };
  const all = { agents: true, sessions: true, providers: true, localModels: true, chatHistory: true };
  const noContent = { agents: true, sessions: true, providers: true, localModels: true, chatHistory: false };

  it("全部到齐 → 就绪，且 forcedBy = none（正常路径不许被记成「被超时放行」）", () => {
    const d = decideUiReady({ ...base, firstLoad: all, metadataGuard: false, contentGuard: false });
    expect(d.ready).toBe(true);
    expect(d.forcedBy).toBe("none");
    expect(d.missing).toEqual([]);
  });

  it("🐛 回归红线：元数据 8s 兜底触发时，**内容组未到齐仍然不许收门**", () => {
    
    
    const d = decideUiReady({ ...base, firstLoad: noContent, metadataGuard: true, contentGuard: false });
    expect(d.ready, "内容没到齐就收门 = 用户看到「界面出来了、中间还在加载」").toBe(false);
    expect(d.missing).toContain("chatHistory");
  });

  it("元数据缺项且未触发兜底 → 不收门（缺一项就不能收门）", () => {
    const d = decideUiReady({ ...base, firstLoad: { ...all, providers: false }, metadataGuard: false, contentGuard: false });
    expect(d.ready).toBe(false);
    expect(d.missing).toEqual(["providers"]);
  });

  it("内容组自己的兜底到点 → 允许收门，但必须如实报出是被谁放行的、还缺什么", () => {
    const d = decideUiReady({ ...base, firstLoad: noContent, metadataGuard: false, contentGuard: true });
    expect(d.ready).toBe(true);
    expect(d.forcedBy).toBe("content-timeout");
    expect(d.missing).toEqual(["chatHistory"]);
  });

  it("元数据被兜底、内容正常 → forcedBy = metadata-timeout", () => {
    const d = decideUiReady({ ...base, firstLoad: { ...all, agents: false }, metadataGuard: true, contentGuard: false });
    expect(d.ready).toBe(true);
    expect(d.forcedBy).toBe("metadata-timeout");
    expect(d.missing).toEqual(["agents"]);
  });

  it("两组都被兜底 → both-timeout（日志要能区分三种情形）", () => {
    const d = decideUiReady({ ...base, firstLoad: {}, metadataGuard: true, contentGuard: true });
    expect(d.ready).toBe(true);
    expect(d.forcedBy).toBe("both-timeout");
    expect(d.missing).toContain("chatHistory");
  });

  it("missing 只列出**真的没到齐**的键（不许把已就绪的键也算进去）", () => {
    const d = decideUiReady({ ...base, firstLoad: { agents: true, sessions: true, providers: false, localModels: false, chatHistory: false }, metadataGuard: false, contentGuard: false });
    expect(d.missing).toEqual(["providers", "localModels", "chatHistory"]);
  });

  it("接线：App 用纯模块判据，且**把被兜底放行的事实打出来**（不许静默）", () => {
    const app = code(APP);
    expect(app).toContain("const uiReadyDecision = decideUiReady({");
    expect(app).toContain("contentGuard");
    expect(app).toContain("[startup] 启动门被超时兜底放行（");
    expect(app).toContain("contentKey: CONTENT_LOAD_KEY");
    expect(app).toContain("metadataKeys: METADATA_LOAD_KEYS");
    
    expect(app).toMatch(/metadataGuard: firstLoadGuard,\n\s*contentGuard,\n/);
    expect(app).not.toMatch(/contentGuard:\s*true/);
    
    expect(app).toContain("const CONTENT_GUARD_MS = 20000;");
    expect(app).toMatch(/setContentGuard\(true\), CONTENT_GUARD_MS/);
  });

  it("[反例] 旧判据必须能被这条规则识别出来（守卫自检）", () => {
    
    const legacy = (firstLoad: Record<string, boolean>, metadataGuard: boolean): boolean =>
      metadataGuard || Object.values(firstLoad).every(Boolean);
    expect(legacy(noContent, true)).toBe(true);
    expect(decideUiReady({ ...base, firstLoad: noContent, metadataGuard: true, contentGuard: false }).ready).toBe(false);
  });
});


describe("A-1059③ 更新：检查默认开，下载/安装永远只能由点击触发", () => {
  it("🐛 回归红线：模板发的 `enabled = false` 不再等于「不检查」", () => {
    expect(decideUpdatePolicy({ enabled: false })).toEqual({
      autoCheck: true, reason: "legacy-shipped-default",
    });
  });

  it("显式 auto_check 是权威（用户说关就关）", () => {
    expect(decideUpdatePolicy({ autoCheck: false, enabled: true }).autoCheck).toBe(false);
    expect(decideUpdatePolicy({ autoCheck: false, enabled: true }).reason).toBe("explicit-auto-check-off");
    expect(decideUpdatePolicy({ autoCheck: true, enabled: false }).autoCheck).toBe(true);
  });

  it("缺省（键都没给）→ 开；enabled = true → 开", () => {
    expect(decideUpdatePolicy({}).autoCheck).toBe(true);
    expect(decideUpdatePolicy({}).reason).toBe("absent-default-on");
    expect(decideUpdatePolicy({ enabled: true }).reason).toBe("legacy-enabled-on");
  });

  it("每种判据来源都有人话解释（不许有落空分支）", () => {
    const reasons: UpdatePolicyReason[] = [
      "explicit-auto-check-on", "explicit-auto-check-off",
      "legacy-enabled-on", "legacy-shipped-default", "absent-default-on",
    ];
    for (const r of reasons) {
      const text = describeUpdatePolicy({ autoCheck: true, reason: r });
      expect(text.length, `${r} 没有对应文案`).toBeGreaterThan(0);
      
      expect(text, `${r} 的文案把"检查"说成了"关闭"`).not.toContain("功能已关闭");
    }
  });

  it("下载 / 安装的自动行为被代码层强制关掉（不变量，无配置项能打开）", () => {
    const src = code(UPDATER);
    expect(src).toContain("autoUpdater.autoDownload = false;");
    expect(src).toContain("autoUpdater.autoInstallOnAppQuit = false;");
    
    expect(src).toContain("export async function downloadUpdate");
    expect(src).toContain('ipcMain.handle("slime:update:download"');
  });

  it("启动检查的判据走纯模块，旧的内联 `if (!cfg.enabled)` 必须绝迹", () => {
    const src = code(UPDATER);
    expect(src).toContain("decideUpdatePolicy({ autoCheck: cfg.autoCheck, enabled: cfg.enabled })");
    expect(src).toContain("if (!policy.autoCheck) {");
    expect(src).not.toContain("if (!cfg.enabled) {");
    
    expect(src).toContain("describeUpdatePolicy(policy)");
  });

  it("配置层如实区分「没给键」与「给了 false」", () => {
    const src = code(MIND);
    expect(src).toContain("autoCheck?: boolean;");
    expect(src).toContain("enabled?: boolean;");
    
    
    expect(src).toContain('if (line.startsWith("auto_check")) {');
    expect(src).toContain('autoCheck = line.split("=", 2)[1]?.trim() === "true";');
  });

  it("🐛 随包模板：生效配置里必须是 auto_check = true，且不得再写 enabled = false", () => {
    const active = tomlActive(TOML);
    const sec = /\[update\]([\s\S]*?)(\n\[|$)/.exec(active);
    expect(sec, "模板里找不到 [update] 段").not.toBeNull();
    expect(sec![1]).toContain("auto_check = true");
    expect(sec![1]).not.toMatch(/^\s*enabled\s*=\s*false\s*$/m);
  });

  it("界面文案必须分清「检查」与「下载/安装」，不得读成「更新被关掉」", () => {
    const panel = code("gui/src/renderer/pages/StatusPanel.tsx");
    expect(panel).not.toContain("自动检查未开启（可点「手动检查」");
    expect(panel).toContain("下载与安装都必须由你点击，不会自动发生");
    
    expect(panel).toContain("handleCheckUpdate");
  });

  it("[反例] 真值表断言能抓到「把 legacy 当作用户意图」的坏判据（守卫自检）", () => {
    const naive = (raw: { autoCheck?: boolean; enabled?: boolean }): boolean =>
      raw.autoCheck ?? raw.enabled ?? false; 
    expect(naive({ enabled: false })).toBe(false);
    expect(decideUpdatePolicy({ enabled: false }).autoCheck).toBe(true);
  });
});
