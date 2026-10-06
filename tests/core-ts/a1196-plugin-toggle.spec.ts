import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markPluginDisabled, readDisabledPlugins, unmarkPluginDisabled } from "../../core-ts/src/plugin/disabled-store.js";

/**
 * A-1196（需求：扩展页拨片开关）——插件启停的两半：
 *   ① store：禁用名单持久化（跨重扫/重启，"关"不许被下一次装载翻回来）；
 *   ② 接线：重扫按名单关闭 / unload 写名单 / enable 通道 / UI 拨片开关。
 * 防的回归：开关变「假开关」（点了关，重扫或重启又活了）。
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

describe("A-1196 ② 接线形状（防回退为假开关）", () => {
  it("main：重扫按名单关闭 + unload 写名单 + enable 从名单移除并重扫", () => {
    const src = read("gui/src/main/index.ts");
    expect(src).toMatch(/readDisabledPlugins\(PLUGINS_DISABLED_FILE\)/);
    /* ⚠️ 词边界（负向后顾）：没有它，`unmarkPluginDisabled(...)` 会**假命中**这条断言
       —— 变异实测（A-1196）：删掉 unload 的写入后，enable 的 unmark 仍让断言通过（假守卫）。 */
    expect(src).toMatch(/(?<![A-Za-z])markPluginDisabled\(PLUGINS_DISABLED_FILE, name\)/);
    expect(src).toMatch(/IPC_CHANNELS\.plugins_enable/);
    expect(src).toMatch(/(?<![A-Za-z])unmarkPluginDisabled\(PLUGINS_DISABLED_FILE, name\)/);
  });

  it("契约与桥：channel 与 preload 都存在", () => {
    expect(read("gui/src/shared/ipc.ts")).toMatch(/plugins_enable: "slime:plugins:enable"/);
    expect(read("gui/src/preload/index.ts")).toMatch(/pluginsEnable:/);
  });

  it("UI：可管理插件用拨片开关（ToggleSwitch），旧卸载按钮已退场", () => {
    const src = read("gui/src/renderer/pages/PluginsPanel.tsx");
    expect(src).toMatch(/function ToggleSwitch\(/);
    expect(src).toMatch(/role="switch"/);
    expect(src).toMatch(/transform: `translateX\(\$\{on \? TRAVEL : 0\}px\)`/);
    expect(src).toMatch(/pluginsEnable/);
    expect(src).not.toMatch(/卸载中…/);
  });
});
