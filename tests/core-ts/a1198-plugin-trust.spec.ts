/**
 * A-1197 · B4（T1 脚本信任）：信任开关 + 脚本声明 + 装配/撤装的守卫。
 *
 * 判据（照 a1198-contributes 同款）：反例**必须真的被拒**；「未信任 ⇒ 不装配」是
 * fail-closed 的核心 —— 连"缺 trust.json 默认放行"这种最危险的回归都必须变红（变异 M4 管）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { readPluginTrust, writePluginTrust, PLUGIN_TRUST_FILE } from "../../core-ts/src/plugin/trust.js";
import { parsePluginScripts } from "../../core-ts/src/plugin/contributes.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";
import * as draft from "../../gui/src/renderer/pages/pluginsDraft.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slime-trust-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("A-1198-T ① `trust.ts`：fail-closed 默认拒绝 + 写读闭环", () => {
  it("缺失 / 坏 JSON / 字段非法 ⇒ 一律 false（不因存储损坏而放行）", () => {
    expect(readPluginTrust(dir)).toBe(false);
    writeFileSync(join(dir, PLUGIN_TRUST_FILE), "{ not json", "utf8");
    expect(readPluginTrust(dir)).toBe(false);
    writeFileSync(join(dir, PLUGIN_TRUST_FILE), JSON.stringify({ trusted: "yes" }), "utf8");
    expect(readPluginTrust(dir)).toBe(false);
    writeFileSync(join(dir, PLUGIN_TRUST_FILE), JSON.stringify({ trusted: 1 }), "utf8");
    expect(readPluginTrust(dir)).toBe(false);
  });

  it("写 true / 写 false 的读回闭环（写 false 后不得残留 true）", () => {
    writePluginTrust(dir, true);
    expect(readPluginTrust(dir)).toBe(true);
    writePluginTrust(dir, false);
    expect(readPluginTrust(dir)).toBe(false);
  });
});

describe("A-1198-T ② `contributes.scripts` 声明校验（反例必须被拒）", () => {
  const reject = (raw: unknown): string[] => {
    const r = parsePluginScripts(raw);
    expect(r.ok, `预期拒绝但被放行：${JSON.stringify(raw)}`).toBe(false);
    return r.ok ? [] : r.errors;
  };

  it("合法声明（name + entry + description/order 无关字段）通过", () => {
    const r = parsePluginScripts([{ name: "run", entry: "tools/run.mjs", description: "跑一下" }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scripts[0].entry).toBe("tools/run.mjs");
      expect(r.scripts[0].description).toBe("跑一下");
    }
  });

  it("entry 绝对路径 / 盘符 / `..` / 以分隔符开头 / NUL ⇒ 拒（不得爬出插件目录）", () => {
    reject([{ name: "a", entry: "/abs/tool.mjs" }]);
    reject([{ name: "b", entry: "C:\\evil.mjs" }]);
    reject([{ name: "c", entry: "../../evil.mjs" }]);
    reject([{ name: "d", entry: "tools\\..\\..\\evil.mjs" }]);
    reject([{ name: "e", entry: "\\evil.mjs" }]);
  });

  it("name 大写 / 重复 / 未知字段 / 空数组 / 超上限 ⇒ 拒", () => {
    reject([{ name: "Run", entry: "tools/run.mjs" }]);
    reject([
      { name: "dup", entry: "tools/a.mjs" },
      { name: "dup", entry: "tools/b.mjs" },
    ]);
    reject([{ name: "x", entry: "tools/x.mjs", script: "evil" }]);
    reject([]);
  });

  it("整份清单视角：scripts 非法 ⇒ rejected（fail-closed）", () => {
    const r = parsePluginManifest({
      name: "demo-plugin", version: "1.0.0", description: "演示", origin: "user",
      provides: ["instructions"],
      contributes: { scripts: [{ name: "run", entry: "../evil.mjs" }] },
    });
    expect(r.ok).toBe(false);
  });
});

describe("A-1198-T ③ 主进程接线形状：未信任 ⇒ 不装配 / 执行边界", () => {
  const main = read("gui/src/main/index.ts");

  it("registerScripts 先读 `readPluginTrust`（未信任直接返回空 ⇒ 记「尚未接线」）", () => {
    const body = /registerScripts: \(manifest\) => \{([\s\S]*?)\n    \},\n  \}\);/.exec(main);
    expect(body).not.toBeNull();
    const fn = body![1];
    expect(fn).toMatch(/readPluginTrust\(dir\)/);
    // 未信任在装配之前短路（dir 检查后的第一个 return []）
    expect(fn.indexOf("readPluginTrust")).toBeLessThan(fn.indexOf("toolReg.register"));
  });

  it("执行边界：cwd = 插件目录 / 显式 timeout / 输出上限（设计 §5.1 的硬约束）", () => {
    expect(main).toContain("const PLUGIN_SCRIPT_TIMEOUT_MS = 30_000;");
    expect(main).toContain("const PLUGIN_SCRIPT_OUTPUT_CAP = 256 * 1024;");
    expect(main).toMatch(/cwd,\n\s+stdio: \["pipe", "pipe", "pipe"\]/);
    // 不注入宿主对象：只传 process.env（子进程天然拿不到宿主引用 —— 这里锁住"没有额外注入"）
    expect(main).toMatch(/env: \{ \.\.\.process\.env \}/);
  });

  it("工具注册走 dispose 撤销（关信任 ⇒ 重装 ⇒ handle 撤销 ⇒ 工具注销）", () => {
    expect(main).toMatch(/toolReg\.unregister\(n\)/);
    expect(main).toMatch(/mounted\.push\(toolName\)/);
  });

  it("⚠️ 信任写盘收敛到统一保存段、且段内不热重载（A-1198 生效口径）", () => {
    /* 旧的 plugins_trust_set（写完立刻 reloadPlugins）已删 —— 即时生效正是用户抱怨的
       「生效慢 + 要刷页面」。现在信任只经plugins_apply_changes 写盘，由 app.relaunch 统一生效。 */
    const seg = /plugins_apply_changes[\s\S]*?\n  \}\);/.exec(main);
    expect(seg).not.toBeNull();
    expect(seg![0]).toMatch(/writePluginTrust\(dir, t\?\.trusted === true\)/);
    expect(seg![0]).not.toMatch(/reloadPlugins\(\)/);
    expect(main).not.toMatch(/IPC_CHANNELS\.plugins_trust_set/);
  });

  it("扩展页有信任开关（仅 scriptCount>0 时显示）+ 点击只入草稿、统一保存", () => {
    const panel = read("gui/src/renderer/pages/PluginsPanel.tsx");
    expect(panel).toMatch(/\(row\.scriptCount \?\? 0\) > 0 &&/);
    expect(panel).toContain("信任脚本");
    /* 拨片与信任都只改草稿 —— 不再有即时应用的调用点。 */
    expect(panel).toMatch(/setTrustDraft\(d, row\.name, !shownTrusted, row\.trusted === true\)/);
    expect(panel).toMatch(/pluginsApplyChanges\(pluginDraftPayload\(draft\)\)/);
    expect(panel).not.toMatch(/pluginsTrustSet|pluginsTrustGet/);
  });

  it("草稿纯逻辑：只记与服务器不同的项 / 点回原值即消草 / 剪枝不产僵尸（A-1198）", () => {
    const d = draft;
    /* 点一下：与服务器不同 ⇒ 有一条草稿。 */
    const d1 = d.setToggleDraft(d.emptyPluginDraft(), "a", false, true);
    expect(d.pluginDraftCount(d1)).toBe(1);
    expect(d.isRowStaged(d1, "a")).toBe(true);
    /* 点回原值 ⇒ 草稿自动消失（不给假脏标记）。 */
    expect(d.pluginDraftCount(d.setToggleDraft(d1, "a", true, true))).toBe(0);
    /* 信任草稿不许写进 toggles（否则保存时会被当成「停用该插件」写进禁用名单）。 */
    const dTrust = d.setTrustDraft(d.emptyPluginDraft(), "t", true, false);
    expect(Object.keys(dTrust.trust)).toEqual(["t"]);
    expect(Object.keys(dTrust.toggles)).toEqual([]);
    /* 载荷按名字排序（写盘稳定）：两个名字插反顺序插入，载荷仍须升序。 */
    const d3 = d.setToggleDraft(d.setToggleDraft(d.emptyPluginDraft(), "zz", false, true), "aa", false, true);
    expect(d.pluginDraftPayload(d3).toggles.map((x) => x.name)).toEqual(["aa", "zz"]);
    const d2 = d.setTrustDraft(d.setToggleDraft(d.emptyPluginDraft(), "z", false, true), "b", true, false);
    expect(d.pluginDraftPayload(d2)).toEqual({
      toggles: [{ name: "z", enabled: false }],
      trust: [{ name: "b", trusted: true }],
    });
    /* 剪枝：插件已消失 ⇒ 丢弃；已与服务器一致 ⇒ 丢弃。 */
    const server = new Map([["a", { on: true, trusted: false }]]);
    expect(d.pluginDraftCount(d.prunePluginDraft(d1, server))).toBe(1);
    expect(d.pluginDraftCount(d.prunePluginDraft(d1, new Map([["a", { on: false, trusted: false }]])))).toBe(0);
    expect(d.pluginDraftCount(d.prunePluginDraft(d1, new Map()))).toBe(0);
  });
});
