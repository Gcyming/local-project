/**
 * A-1197 · B2（L4a UI 贡献点）：`contributes.ui` 声明校验的**合法/非法矩阵**。
 *
 * 判据（照 B1 的 a1197 spec 同款）：每条反例**必须真的被拒**（反例必须失败，
 * 否则判据没测到点上）；整份清单视角再验一遍 fail-closed（任一 ui 项非法 ⇒
 * `parsePluginManifest` 整份 rejected，不静默丢单个字段）。
 */
import { describe, it, expect } from "vitest";
import {
  parsePluginContributes,
  parsePluginUiSlots,
  PLUGIN_UI_SLOTS,
  PLUGIN_NAME_PATTERN,
  MAX_PLUGIN_UI_SLOTS,
} from "../../core-ts/src/plugin/contributes.js";
import { parsePluginManifest } from "../../core-ts/src/plugin/manifest.js";

const base = {
  name: "demo-plugin",
  version: "1.0.0",
  description: "演示",
  origin: "user",
  provides: ["instructions"],
} as const;

describe("A-1198 ① `parsePluginUiSlots`：合法声明", () => {
  it("三个白名单槽位各一条（settings_panel 带 title；status_item 带 label+refresh；chat_action 带 label+when）", () => {
    const r = parsePluginUiSlots([
      { slot: "settings_panel", id: "panel", title: "演示设置" },
      { slot: "status_item", id: "count", label: "计数", refresh: "manual", order: 2 },
      { slot: "chat_action", id: "run", label: "用本扩展处理", icon: "Zap", when: "有选中文本时" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ui).toHaveLength(3);
      expect(r.ui[0].title).toBe("演示设置");
      expect(r.ui[1].refresh).toBe("manual");
      expect(r.ui[2].when).toBe("有选中文本时");
    }
  });

  it("顶层 parsePluginContributes 同时收 settings 与 ui，各自独立解析", () => {
    const r = parsePluginContributes({
      settings: [{ key: "api-url", label: "API 地址", type: "string" }],
      ui: [{ slot: "status_item", id: "ok", label: "状态", refresh: "on_event" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contributes.settings).toHaveLength(1);
      expect(r.contributes.ui).toHaveLength(1);
    }
  });

  it("白名单常量本身：B5 后四槽位齐备（toolbar_item 与 page 一起落）", () => {
    expect([...PLUGIN_UI_SLOTS]).toEqual(["settings_panel", "status_item", "chat_action", "toolbar_item"]);
  });
});

describe("A-1198 ② `parsePluginUiSlots`：反例矩阵（每条必须被拒）", () => {
  const reject = (raw: unknown): string[] => {
    const r = parsePluginUiSlots(raw);
    expect(r.ok, `预期拒绝但被放行：${JSON.stringify(raw)}`).toBe(false);
    return r.ok ? [] : r.errors;
  };

  it("`toolbar_item` 已在白名单（B5 落地；它的「必须配 page」约束在交叉校验里）", () => {
    const r = parsePluginUiSlots([{ slot: "toolbar_item", id: "open", label: "打开" }]);
    expect(r.ok).toBe(true);
  });

  it("未知槽位名被拒", () => {
    reject([{ slot: "unknown_slot", id: "x", label: "x" }]);
  });

  it("`id` 大写 / 非法字符被拒（命名须匹配 PLUGIN_NAME_PATTERN）", () => {
    reject([{ slot: "status_item", id: "BadName", label: "x", refresh: "manual" }]);
    reject([{ slot: "status_item", id: "has space", label: "x", refresh: "manual" }]);
  });

  it("同插件内 `id` 重复被拒（声明顺序不得变成隐式语义）", () => {
    const errs = reject([
      { slot: "status_item", id: "dup", label: "a", refresh: "manual" },
      { slot: "chat_action", id: "dup", label: "b" },
    ]);
    expect(errs.some((e) => e.includes("重复"))).toBe(true);
  });

  it("`settings_panel` 缺 title 被拒；挂 label（错位字段）也拒", () => {
    reject([{ slot: "settings_panel", id: "p1" }]);
    reject([{ slot: "settings_panel", id: "p2", label: "用错了字段" }]);
  });

  it("`status_item` 缺 refresh / refresh 值不在枚举 被拒；挂 title 也拒", () => {
    reject([{ slot: "status_item", id: "s1", label: "x" }]);
    reject([{ slot: "status_item", id: "s2", label: "x", refresh: "wrong" }]);
    reject([{ slot: "status_item", id: "s3", label: "x", refresh: "manual", title: "错位" }]);
  });

  it("`chat_action` 挂 refresh（只属于 status_item）被拒", () => {
    reject([{ slot: "chat_action", id: "c1", label: "x", refresh: "manual" }]);
  });

  it("未知字段被拒（契约面写错字段名必须响，不当向前兼容）", () => {
    reject([{ slot: "chat_action", id: "c2", label: "x", script: "evil.js" }]);
  });

  it("空数组 / 超上限被拒", () => {
    reject([]);
    reject(Array.from({ length: MAX_PLUGIN_UI_SLOTS + 1 }, (_, i) => ({
      slot: "status_item", id: `n${i}`, label: "x", refresh: "manual",
    })));
  });

  it("`order` 非有限数值被拒", () => {
    reject([{ slot: "chat_action", id: "c3", label: "x", order: "1" }]);
    reject([{ slot: "chat_action", id: "c4", label: "x", order: Number.POSITIVE_INFINITY }]);
  });

  it("`contributes` 顶层未知字段仍被拒（含 ui 之后的拼写错误）", () => {
    const r = parsePluginContributes({ ui: [{ slot: "chat_action", id: "c5", label: "x" }], uis: [] });
    expect(r.ok).toBe(false);
  });
});

describe("A-1198 ③ fail-closed：整份清单视角（任一 ui 项非法 ⇒ 整份 rejected）", () => {
  it("合法的 ui 声明能过整份清单校验，并保留 ui 字段", () => {
    const r = parsePluginManifest({
      ...base,
      contributes: { ui: [{ slot: "status_item", id: "ok", label: "状态", refresh: "manual" }] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.contributes?.ui).toHaveLength(1);
    }
  });

  it("非法 ui 项 ⇒ 整份清单 rejected（不静默丢单个字段）", () => {
    const r = parsePluginManifest({
      ...base,
      contributes: { ui: [{ slot: "unknown_slot", id: "open", label: "打开" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain("slot");
    }
  });

  it("B5 交叉校验：`toolbar_item` 缺 `page` ⇒ 整份 rejected（没有 page 就是假按钮）", () => {
    const r = parsePluginManifest({
      ...base,
      contributes: { ui: [{ slot: "toolbar_item", id: "open", label: "打开" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain("toolbar_item");
    }
    /* 配了合法 page 则整份通过（正向闭环）。 */
    const ok = parsePluginManifest({
      ...base,
      contributes: {
        ui: [{ slot: "toolbar_item", id: "open", label: "打开" }],
        page: { kind: "html", entry: "panel.html" },
      },
    });
    expect(ok.ok).toBe(true);
  });

  it("B5：`kind: \"webview\"` 暂被拒（需显式 guest 配置，见 §5.4——不装假插座）", () => {
    const r = parsePluginManifest({
      ...base,
      contributes: { page: { kind: "webview", entry: "panel.html" } },
    });
    expect(r.ok).toBe(false);
  });

  it("B5：`page.entry` 走与脚本相同的纯相对路径校验（`..` 攀爬被拒）", () => {
    const r = parsePluginManifest({
      ...base,
      contributes: { page: { kind: "html", entry: "../../evil.html" } },
    });
    expect(r.ok).toBe(false);
  });

  it("`PLUGIN_NAME_PATTERN` 从 contributes.ts 单一产地 re-export（manifest 对外 API 不变）", () => {
    expect(PLUGIN_NAME_PATTERN.source).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
  });
});
