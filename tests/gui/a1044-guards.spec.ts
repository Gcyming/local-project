/**
 * A-1044 守卫（GUI 侧）：**操作可视化浮层 + 焦点归还**的接线与判据。
 *
 * 与 `tests/core-ts/a1044-guards.spec.ts` 分工：那边守"让位裁决与空闲探针"，这边守
 *   · `operationFocus.ts` 的状态机（判据唯一实现，纯逻辑直测）；
 *   · 浮层的三条硬约束（不吞点击 / 常驻挂载切类名 / 提示可永久隐藏）；
 *   · `browserBridge` 的**焦点归还**（用户报的"点击/输入被吞"在应用内的成因）；
 *   · 跨进程契约：主进程发的字段名 == preload 收的字段名 == 渲染层翻译的字段名（漂移不报错）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OP_FOCUS_EVENT,
  OP_FOCUS_HINT_KEY,
  OP_FOCUS_IDLE,
  OP_FOCUS_MAX_HOLD_MS,
  describeOpFocusTarget,
  fromOperationFocusUI,
  isOpFocusStale,
  readOpFocusHintHidden,
  reduceOperationFocus,
  writeOpFocusHintHidden,
  type OperationFocusState,
} from "../../gui/src/renderer/pages/operationFocus.js";

const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const F_OPFOCUS = "gui/src/renderer/pages/operationFocus.ts";
const F_OVERLAY = "gui/src/renderer/components/OperationFocusOverlay.tsx";
const F_BRIDGE = "gui/src/renderer/pages/browserBridge.ts";
const F_PRELOAD = "gui/src/preload/index.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_IPC = "gui/src/shared/ipc.ts";
const F_CSS = "gui/src/renderer/index.css";
const F_APP = "gui/src/renderer/App.tsx";

const begin = (over: Partial<{ target: OperationFocusState["target"]; label: string; rect: OperationFocusState["rect"]; waitingUser: boolean }> = {}): OperationFocusState =>
  reduceOperationFocus(OP_FOCUS_IDLE, { phase: "begin", target: "browser", label: "点击网页元素", ...over }, 1000);

describe("A-1044 ①：可视化状态机（纯逻辑）", () => {
  it("begin → 立刻可见（含目标/文案/矩形）", () => {
    const s = begin({ label: "滚动网页 600px" });
    expect(s.active).toBe(true);
    expect(s.label).toBe("滚动网页 600px");
    expect(s.target).toBe("browser");
  });

  it("end → 熄灭，但**保留 label/rect**（淡出那一帧还要用，清空会闪成空框）", () => {
    const on = begin({ rect: { x: 1, y: 2, width: 3, height: 4 } });
    const off = reduceOperationFocus(on, { phase: "end", target: "browser", label: "点击网页元素" }, 2000);
    expect(off.active).toBe(false);
    expect(off.label).toBeTruthy();
    expect(off.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("**别人的 end 不许熄灭我的边框**（右栏浏览器与宿主屏幕两条路径会交错）", () => {
    const on = begin({ target: "browser" });
    const after = reduceOperationFocus(on, { phase: "end", target: "desktop", label: "点击 (10, 10)" }, 3000);
    expect(after.active, "桌面动作的收尾不能把正在进行的浏览器操作指示抹掉").toBe(true);
    expect(after.target).toBe("browser");
    expect(after.ts).toBe(on.ts);
  });

  it("看门狗：太久没有新事件 → 视为已结束（end 丢失时的兜底）；未活动状态永不算过期", () => {
    const on = begin();
    expect(isOpFocusStale(on, on.ts + OP_FOCUS_MAX_HOLD_MS - 1)).toBe(false);
    expect(isOpFocusStale(on, on.ts + OP_FOCUS_MAX_HOLD_MS + 1)).toBe(true);
    expect(isOpFocusStale(OP_FOCUS_IDLE, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("主进程事件翻译：只翻译字段、**绝不**把宿主坐标当应用内矩形（两个坐标系）", () => {
    const p = fromOperationFocusUI({
      phase: "begin", backend: "desktop", action: "click", label: "点击 (812, 431)",
      region: { x: 800, y: 400, width: 300, height: 220 }, waitingUser: true,
    });
    expect(p.target).toBe("desktop");
    expect(p.label).toBe("点击 (812, 431)");
    expect(p.rect, "宿主像素画不到应用窗口里 → rect 必须为 null，由界面退化为内容区边缘边框").toBeNull();
    expect(p.waitingUser).toBe(true);
    expect(fromOperationFocusUI({ phase: "end", backend: "android", action: "tap", label: "x" }).target).toBe("device");
  });

  it("目标类别 → 人话（唯一实现；界面不许自己拼词）", () => {
    expect(describeOpFocusTarget("browser")).toBe("右栏浏览器");
    expect(describeOpFocusTarget("device")).toBe("安卓设备");
    expect(describeOpFocusTarget("desktop")).toBe("你的主机屏幕");
    expect(describeOpFocusTarget(null)).toBeTruthy();
  });

  describe("提示的永久隐藏（localStorage）", () => {
    const store = new Map<string, string>();
    beforeEach(() => {
      // @ts-expect-error 测试内注入最小 window（本仓 vitest 是 node 环境，无 DOM）
      globalThis.window = {
        localStorage: {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => { store.set(k, v); },
        },
      };
    });
    afterEach(() => {
      store.clear();
      // @ts-expect-error 清理注入
      delete globalThis.window;
    });

    it("默认不隐藏；写入后跨会话保持", () => {
      expect(readOpFocusHintHidden()).toBe(false);
      writeOpFocusHintHidden(true);
      expect(store.get(OP_FOCUS_HINT_KEY)).toBe("1");
      expect(readOpFocusHintHidden()).toBe(true);
      writeOpFocusHintHidden(false);
      expect(readOpFocusHintHidden()).toBe(false);
    });

    it("localStorage 不可用 → 按“未隐藏”处理，绝不抛（弹提示失败不该炸界面）", () => {
      // @ts-expect-error 故意打断 localStorage
      globalThis.window = {};
      expect(readOpFocusHintHidden()).toBe(false);
      expect(() => writeOpFocusHintHidden(true)).not.toThrow();
    });
  });
});

describe("A-1044 ②：浮层的三条硬约束", () => {
  const overlay = (): string => stripComments(read(F_OVERLAY));

  it("常驻挂载 + 切类名（禁止条件渲染，否则结构上不可能有进出场）", () => {
    const src = overlay();
    expect(src).toMatch(/is-on/);
    // 反向：不许出现 `{active && (<div` / `{st.active && (` 这种条件挂载
    expect(src, "浮层必须常驻挂载").not.toMatch(/\{\s*st\.active\s*&&\s*\(/);
  });

  it("除“隐藏”按钮外一律不许吃点击（A-976 前科：吃点击 = 点不动）", () => {
    const css = stripComments(read(F_CSS));
    const frame = /\.op-focus-frame\s*\{[\s\S]*?\n\}/.exec(css);
    const hint = /\.op-focus-hint\s*\{[\s\S]*?\n\}/.exec(css);
    const hide = /\.op-focus-hide\s*\{[\s\S]*?\n\}/.exec(css);
    expect(frame, "缺少 .op-focus-frame").not.toBeNull();
    expect(hint, "缺少 .op-focus-hint").not.toBeNull();
    expect(hide, "缺少 .op-focus-hide").not.toBeNull();
    expect(frame![0]).toMatch(/pointer-events\s*:\s*none/);
    expect(hint![0]).toMatch(/pointer-events\s*:\s*none/);
    expect(hide![0], "隐藏按钮是唯一可点元素，必须显式打开命中测试").toMatch(/pointer-events\s*:\s*auto/);
  });

  it("呼吸动效只动 box-shadow / border-color，且 reduced-motion 下降级", () => {
    const css = stripComments(read(F_CSS));
    const kf = /@keyframes op-focus-breathe\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(kf, "缺少呼吸关键帧").not.toBeNull();
    expect(kf![1]).toMatch(/box-shadow/);
    expect(kf![1], "动画不许改几何（触发布局 = 卡顿源）").not.toMatch(/\b(width|height|top|left)\s*:/);
    expect(css).toMatch(/prefers-reduced-motion[^{]*\{[\s\S]{0,400}?op-focus-frame/);
  });

  it("两层来源都订阅：应用内事件 + 主进程 opFocus（缺一即有一类操作不可见）", () => {
    const src = overlay();
    expect(src).toContain("OP_FOCUS_EVENT");
    expect(src).toContain("onOperationFocus");
  });

  it("看门狗已接线（end 丢失不会让边框永远转）", () => {
    expect(overlay()).toContain("isOpFocusStale");
  });

  it("App 根上真的挂了它（否则上面全都白写）", () => {
    const app = stripComments(read(F_APP));
    expect(app).toMatch(/import\s+OperationFocusOverlay\s+from/);
    expect(app).toMatch(/<OperationFocusOverlay\s*\/>/);
  });
});

describe("A-1044 ③：焦点归还 —— 用户报的“点击/输入被吞”在应用内的成因", () => {
  const bridge = (): string => stripComments(read(F_BRIDGE));

  it("所有会注入输入的分支都走 withWebviewFocus（点/输入/按键/滚动/拖拽 = 5 处）", () => {
    const src = bridge();
    const calls = [...src.matchAll(/withWebviewFocus\(wv, /g)].length;
    expect(src, "缺少 withWebviewFocus 的定义").toMatch(/async function withWebviewFocus</);
    expect(calls, `实际 ${calls} 处调用（click/type/press/scroll/drag）`).toBe(5);
  });

  it("散落的裸 `wv.focus()` 必须清零 —— 它正是抢走用户焦点的那个调用", () => {
    const src = bridge();
    const bare = [...src.matchAll(/(?<!\.)\bwv\.focus\(\)/g)].length;
    expect(bare, "除 withWebviewFocus 内部的兜底外，不许再直接 wv.focus()").toBe(0);
  });

  it("聚焦带 preventScroll（否则用户正要点的目标会被滚走）", () => {
    expect(bridge()).toMatch(/focus\(\s*\{\s*preventScroll:\s*true\s*\}/);
  });

  it("归还策略是“人优先”：只在焦点仍停在 webview 上时归还（用户自己挪走就绝不抢回）", () => {
    const src = bridge();
    const m = /function restoreUserFocus\([\s\S]*?\n\}/.exec(src);
    expect(m, "找不到 restoreUserFocus").not.toBeNull();
    expect(m![0]).toMatch(/document\.activeElement/);
    expect(m![0], "必须比对“焦点是否还在 webview 上”").toMatch(/activeElement\s*!==/);
    expect(m![0]).toMatch(/prev\.focus\(\)/);
  });

  it("begin 在注入**之前**发（先可见，再动手）", () => {
    const src = bridge();
    const beginAt = src.indexOf('phase: "begin"');
    expect(beginAt).toBeGreaterThan(-1);
    expect(src.slice(beginAt, beginAt + 200)).toMatch(/rect:/);
  });
});

describe("A-1044 ④：跨进程契约（漂移不报错，只会让界面永远不亮）", () => {
  it("通道名在主进程与 preload 两侧逐字一致", () => {
    const CH = "slime:screen:opFocus";
    expect(stripComments(read(F_MAIN))).toContain(`"${CH}"`);
    expect(stripComments(read(F_PRELOAD))).toContain(`"${CH}"`);
  });

  it("主进程确实订阅了 controller 的 onOperationFocus（订阅点=所有图形动作的咽喉）", () => {
    const src = stripComments(read(F_MAIN));
    expect(src).toMatch(/screenCtl\.onOperationFocus\s*=/);
    expect(src, "转发必须兜异常：渲染层/窗口的问题不许影响动作").toMatch(/onOperationFocus\s*=[\s\S]{0,300}?catch/);
    // ⚠️ 上面两条对"死代码架空"免疫：`if (false) screenCtl.onOperationFocus = …` 里子串照样命中。
    // 订阅必须是**可达的语句级赋值**（行首即 screenCtl.onOperationFocus），且不被恒假分支包住。
    expect(src, "订阅不许被 if(false)/if(0) 之类的死代码架空").not.toMatch(
      /if\s*\(\s*(?:false|0)\s*\)[^;\n]{0,120}?onOperationFocus\s*=/,
    );
    expect(src, "订阅必须是可达的语句级赋值（`screenCtl.onOperationFocus = …` 独占语句起首）").toMatch(
      /(?:^|\n)[ \t]*screenCtl\.onOperationFocus\s*=/,
    );
  });

  it("preload 暴露 onOperationFocus（渲染层唯一的系统级来源）", () => {
    expect(stripComments(read(F_PRELOAD))).toMatch(/onOperationFocus:\s*\(cb/);
  });

  it("DTO 字段名与 core-ts 的事件形状同源（逐个字段比对）", () => {
    const fields = (src: string, name: string): string[] => {
      const m = new RegExp(`interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
      expect(m, `找不到 ${name}`).not.toBeNull();
      return [...m![1].matchAll(/^\s{2}([a-z][A-Za-z0-9_]*)\??:/gm)].map((x) => x[1]);
    };
    const core = fields(stripComments(read("core-ts/src/screen/controller.ts")), "OperationFocusEvent");
    const ui = fields(stripComments(read(F_IPC)), "OperationFocusUI");
    expect(core.length).toBeGreaterThan(3);
    for (const f of core) {
      expect(ui, `core-ts 的 ${f} 在 IPC DTO 里没有对应字段`).toContain(f);
    }
  });
});
