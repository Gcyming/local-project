import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markPluginDisabled, readDisabledPlugins, unmarkPluginDisabled } from "../../core-ts/src/plugin/disabled-store.js";

/**
 * A-1196（需求：扩展页拨片开关）——插件启停的两半：
 *   ① store：禁用名单持久化（跨重扫/重启，"关"不许被下一次装载翻回来）；
 *   ② 接线：重扫按名单关闭 / **统一保存写名单** / UI 拨片开关。
 * 防的回归：开关变「假开关」（点了关，重扫或重启又活了）。
 *
 * ⚠️ A-1198 语义变更：拨片不再**逐个即时应用**，改为「记草稿 → 保存 → 重启统一生效」
 *   （用户口径：生效慢 + 要刷页面）。因此旧的 `plugins_enable` / `plugins_unload`
 *   通道已删除（无调用方的死出口 = 假出口），启停写盘收敛到 `plugins_apply_changes`。
 *   本守卫同步改钉新路径 —— 钉旧通道会让"回退为逐个即时应用"这类回退**测不出来**。
 */
const ROOT = resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "a1196-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("A-1196 ① 禁用名单 store（落盘往返）", () => {
  it("mark → 读回；unmark → 移除", () => {
    const f = join(dir, "plugins-disabled.json");
    expect([...readDisabledPlugins(f)]).toEqual([]);
    markPluginDisabled(f, "my-plugin");
    expect([...readDisabledPlugins(f)]).toEqual(["my-plugin"]);
    unmarkPluginDisabled(f, "my-plugin");
    expect([...readDisabledPlugins(f)]).toEqual([]);
  });

  it("去重 + 排序（写盘稳定）", () => {
    const f = join(dir, "s.json");
    markPluginDisabled(f, "b");
    markPluginDisabled(f, "a");
    markPluginDisabled(f, "b");
    const raw = JSON.parse(readFileSync(f, "utf8")) as { disabled: string[] };
    expect(raw.disabled).toEqual(["a", "b"]);
  });

  it("坏文件 / 缺失 ⇒ 空名单（fail-safe：不因名单损坏禁掉任何东西）；且能被 mark 修复", () => {
    const f = join(dir, "broken.json");
    writeFileSync(f, "{ not json", "utf8");
    expect([...readDisabledPlugins(f)]).toEqual([]);
    expect([...readDisabledPlugins(join(dir, "nope.json"))]).toEqual([]);
    markPluginDisabled(f, "x");
    expect([...readDisabledPlugins(f)]).toEqual(["x"]);
  });

  it("空白名不入名单；unmark 不存在的名字不写盘", () => {
    const f = join(dir, "s.json");
    markPluginDisabled(f, "   ");
    expect([...readDisabledPlugins(f)]).toEqual([]);
    markPluginDisabled(f, "keep");
    const before = readFileSync(f, "utf8");
    unmarkPluginDisabled(f, "ghost");
    expect(readFileSync(f, "utf8")).toBe(before);
  });
});

describe("A-1196 ② 接线形状（防回退为假开关 / 防回退为逐个即时应用）", () => {
  it("main：重扫按名单关闭 + 统一保存写/移除名单（A--1198）", () => {
    const src = read("gui/src/main/index.ts");
    expect(src).toMatch(/readDisabledPlugins\(PLUGINS_DISABLED_FILE\)/);
    /* A-1198：写盘收敛到 plugins_apply_changes 段内 —— 必须**限定在该段**，
       否则上面那两条 anywhere 断言会被别处的同名调用假命中（守卫失效的老坑）。 */
    const seg = /plugins_apply_changes[\s\S]*?\n  \}\);/.exec(src);
    expect(seg).not.toBeNull();
    /* ⚠️ 词边界（负向后顾）：没有它，`unmarkPluginDisabled(...)` 会**假命中** mark 那条断言
       —— 变异实测（A-1196）：删掉 disable 写入后，enable 的 unmark 仍让断言通过（假守卫）。 */
    expect(seg![0]).toMatch(/(?<![A-Za-z])markPluginDisabled\(PLUGINS_DISABLED_FILE, name\)/);
    expect(seg![0]).toMatch(/(?<![A-Za-z])unmarkPluginDisabled\(PLUGINS_DISABLED_FILE, name\)/);
  });

  it("⚠️ 保存即统一生效点：写盘后**必须重扫 + 广播**，且**绝不退出进程**（A-1198 核心口径）", () => {
    const src = read("gui/src/main/index.ts");
    const seg = /plugins_apply_changes[\s\S]*?\n  \}\);/.exec(src);
    expect(seg).not.toBeNull();
    /* 生效点 = 写盘 + 重扫装载+ 重装技能 + 广播。缺了广播 ⇒ 渲染层显示旧状态，
       用户看到的还是「要刷页面才生效」（这正是当初的根因）。 */
    expect(seg![0]).toMatch(/await runContribRescan\("applyChanges"\)/);
    /* ⚠️ 顺序：重扫必须在「写盘全成功」之后 —— 提前跑 = 用旧盘状态扫一遍，等于没生效。
       ⚠️ 用**计数 + 位置**双断言而不是「errors…return…runContribRescan」一条正则：
       那样只要段内出现两次 runContribRescan（一次提前、一次照旧），正则照样命中（变异实测存活）。
       这里要求：全段**恰好一次**调用，且它在 errors 早退之后。 */
    const rescanCalls = seg![0].match(/runContribRescan\(/g) ?? [];
    expect(rescanCalls).toHaveLength(1);
    const iErr = seg![0].indexOf("if (errors.length > 0) {");
    const iRescan = seg![0].indexOf("runContribRescan(");
    expect(iErr).toBeGreaterThan(-1);
    expect(iRescan).toBeGreaterThan(iErr);
    /* 回带新快照（省一次往返，且立刻显示生效后的真实状态）。 */
    expect(seg![0]).toMatch(/snapshot: snapshotPlugins\(next\)/);
  });

  it("⚠️ 不许退出进程：app.relaunch/app.exit 已退场（用户口径「重启不退出」）", () => {
    const src = read("gui/src/main/index.ts");
    /* 用户明确否决了「保存后重启 slime」—— 退出程序不是"刷新状态"。
       这里锁死：apply_changes 生效点不许出现任何退出调用。 */
    const seg = /plugins_apply_changes[\s\S]*?\n  \}\);/.exec(src);
    expect(seg![0]).not.toMatch(/app\.relaunch|app\.exit|process\.exit/);
    /* 重启通道本身也要退场（留着就是假出口 + 守卫自相矛盾）。 */
    expect(read("gui/src/shared/ipc.ts")).not.toMatch(/app_relaunch:/);
    expect(read("gui/src/preload/index.ts")).not.toMatch(/appRelaunch:/);
    expect(read("gui/src/renderer/pages/PluginsPanel.tsx")).not.toMatch(/appRelaunch/);
    /* 全局也不该再有「重启 slime 承载生效」的通道。 */
    expect(src).not.toMatch(/IPC_CHANNELS\.app_relaunch/);
  });

  it("⚠️ 保存动作齐全：写盘 → 用回带快照 → 清草稿 → 如实报错保留草稿", () => {
    const panel = read("gui/src/renderer/pages/PluginsPanel.tsx");
    expect(panel).toMatch(/await a\.extras\.pluginsApplyChanges\(/);
    /* 写盘失败 ⇒ 如实报错、**保留草稿**（可重试），不清空。 */
    expect(panel).toMatch(/if \(!res\?\.ok\) \{[\s\S]{0,220}?return;/);
    expect(panel).toMatch(/保存失败（改动仍在草稿里）/);
    /* 成功 ⇒ 清草稿（否则下次进来还是"待生效"的假脏标记）。 */
    expect(panel).toMatch(/setDraft\(emptyPluginDraft\(\)\);\s*\n\s*showNotice\(true,/);
    /* 提示文案不许再宣称"重启"。 */
    expect(panel).not.toMatch(/正在重启 slime|重启后统一生效|窗口会关闭/);
  });

  it("⚠️ 保存栏固定在右下角悬浮（用户口径：不在页面最上面）", () => {
    const panel = read("gui/src/renderer/pages/PluginsPanel.tsx");
    /* 必须 fixed + right + bottom 三件套；放在列表末尾（无 position）等于没有 ——
       插件列表很长，用户改完拨片要滚回顶才找得到保存按钮。 */
    expect(panel).toMatch(/position: "fixed", right: 20, bottom: 20/);
    /* 高于设置页浮层（否则被对话框盖住）。 */
    expect(panel).toMatch(/zIndex: 1200/);
    /* 文案不许指引到"右上"。 */
    expect(panel).not.toMatch(/点右上「保存/);
    expect(panel).toMatch(/右下角/);
  });

  it("⚠️ 系统默认插件不可停用：保存段里的 unloadable 守卫在（M10 的守卫）", () => {
    const src = read("gui/src/main/index.ts");
    const seg = /plugins_apply_changes[\s\S]*?\n  \}\);/.exec(src);
    expect(seg).not.toBeNull();
    /* 删掉它 ⇒ 能把 builtin 插件写进禁用名单，越过「系统默认不可卸载」红线。 */
    expect(seg![0]).toMatch(/if \(!rec\.unloadable\) \{ errors\.push\(`系统默认插件不可停用：\$\{name\}`\); continue; \}/);
    /* 名单里查不到 / builtin 无磁盘目录 ⇒ 也要拒（不静默跳过）。 */
    expect(seg![0]).toMatch(/插件不在清单里，跳过：\$\{name\}/);
    expect(seg![0]).toMatch(/插件没有磁盘目录（builtin 或未装载），跳过信任写入：\$\{name\}/);
  });

  it("旧的逐个即时通道已退场（enable/unload 不许复活）", () => {
    /* 留着没人调的通道 = 假出口：以后有人误接回去就又是「点了不生效 / 半生效」。 */
    expect(read("gui/src/shared/ipc.ts")).not.toMatch(/plugins_enable:|plugins_unload:/);
    expect(read("gui/src/preload/index.ts")).not.toMatch(/pluginsEnable:|pluginsUnload:/);
    expect(read("gui/src/main/index.ts")).not.toMatch(/IPC_CHANNELS\.plugins_enable|IPC_CHANNELS\.plugins_unload/);
    expect(read("gui/src/renderer/pages/PluginsPanel.tsx")).not.toMatch(/pluginsEnable|pluginsUnload/);
  });

  it("契约与桥：统一保存通道在（重启通道已退场）", () => {
    expect(read("gui/src/shared/ipc.ts")).toMatch(/plugins_apply_changes: "slime:plugins:applyChanges"/);
    expect(read("gui/src/preload/index.ts")).toMatch(/pluginsApplyChanges:/);
    /* 回带快照类型必须声明（否则面板拿不到 res.snapshot）。 */
    expect(read("gui/src/preload/index.ts")).toMatch(/pluginsApplyChanges:[\s\S]{0,400}?snapshot\?: PluginSnapshotDTO/);
  });

  it("UI：拨片只入草稿 + 保存按钮存在（不是即时应用）", () => {
    const src = read("gui/src/renderer/pages/PluginsPanel.tsx");
    expect(src).toMatch(/function ToggleSwitch\(/);
    expect(src).toMatch(/role="switch"/);
    expect(src).toMatch(/transform: `translateX\(\$\{on \? TRAVEL : 0\}px\)`/);
    /* 拨片回调只改草稿：onToggle 收整行 + 当前显示值（要 serverOn 才能判断"点回原值"）。 */
    expect(src).toMatch(/onToggle: \(row: PluginRow, shownOn: boolean\) => void/);
    expect(src).toMatch(/setToggleDraft\(d, row\.name, !shownOn, serverOn\)/);
    /* 悬浮保存栏：无草稿时不渲染，有草稿时才出现「保存并生效」。 */
    expect(src).toMatch(/\{draftCount > 0 && \(/);
    expect(src).toMatch(/保存并生效/);
    expect(src).not.toMatch(/保存并重启生效|卸载中…/);
  });
});
