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

  it("⚠️ 保存即统一生效点：apply_changes 段内**不许**热重载（A-1198 的核心口径）", () => {
    const src = read("gui/src/main/index.ts");
    const seg = /plugins_apply_changes[\s\S]*?\n  \}\);/.exec(src);
    expect(seg).not.toBeNull();
    /* 生效点只有一个：写盘 + app.relaunch。若这里出现 reloadPlugins()，
       就会退回「保存前就部分生效」——正是用户抱怨的慢 + 要刷页面。 */
    expect(seg![0]).not.toMatch(/reloadPlugins\(\)/);
    expect(seg![0]).not.toMatch(/state\.host\.unload\(/);
    /* 重启通道真实存在（app.relaunch + app.exit，不是只写不重启）。 */
    expect(src).toMatch(/IPC_CHANNELS\.app_relaunch[\s\S]*?app\.relaunch\(\)[\s\S]*?app\.exit\(0\)/);
  });

  it("⚠️ 保存动作三段齐全：写盘 → 提示 → 真的重启（M8 的守卫；漏了「写盘但不重启」）", () => {
    const panel = read("gui/src/renderer/pages/PluginsPanel.tsx");
    /* 只写盘不重启 = 用户还得手动重启（回到「要刷新页面才生效」的原问题）。 */
    expect(panel).toMatch(/await a\.extras\.appRelaunch\(\)/);
    /* 顺序：先 applyChanges 成功、再重启 —— 失败时必须留在草稿里不重启。 */
    const idxApply = panel.indexOf("await a.extras.pluginsApplyChanges(");
    const idxRelaunch = panel.indexOf("await a.extras.appRelaunch();");
    expect(idxApply).toBeGreaterThan(-1);
    expect(idxRelaunch).toBeGreaterThan(idxApply);
    /* 写盘失败 ⇒ 如实报错且**不**继续重启（草稿保留、可重试）。 */
    expect(panel).toMatch(/if \(!res\?\.ok\) \{[\s\S]{0,220}?return;/);
    expect(panel).toMatch(/保存失败（改动仍在草稿里）/);
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

  it("契约与桥：统一保存 + 重启通道都在", () => {
    expect(read("gui/src/shared/ipc.ts")).toMatch(/plugins_apply_changes: "slime:plugins:applyChanges"/);
    expect(read("gui/src/shared/ipc.ts")).toMatch(/app_relaunch: "slime:app:relaunch"/);
    expect(read("gui/src/preload/index.ts")).toMatch(/pluginsApplyChanges:/);
    expect(read("gui/src/preload/index.ts")).toMatch(/appRelaunch:/);
  });

  it("UI：拨片只入草稿 + 保存按钮存在（不是即时应用）", () => {
    const src = read("gui/src/renderer/pages/PluginsPanel.tsx");
    expect(src).toMatch(/function ToggleSwitch\(/);
    expect(src).toMatch(/role="switch"/);
    expect(src).toMatch(/transform: `translateX\(\$\{on \? TRAVEL : 0\}px\)`/);
    /* 拨片回调只改草稿：onToggle 收整行 + 当前显示值（要 serverOn 才能判断"点回原值"）。 */
    expect(src).toMatch(/onToggle: \(row: PluginRow, shownOn: boolean\) => void/);
    expect(src).toMatch(/setToggleDraft\(d, row\.name, !shownOn, serverOn\)/);
    /* 保存条：无草稿时不渲染，有草稿时才出现「保存并重启生效」。 */
    expect(src).toMatch(/\{draftCount > 0 && \(/);
    expect(src).toMatch(/保存并重启生效/);
    expect(src).not.toMatch(/卸载中…/);
  });
});
