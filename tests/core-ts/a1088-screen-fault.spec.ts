/**
 * tests/core-ts/a1088-screen-fault.spec.ts — A-1088 续：「窗口枚举 / 聚焦」的空结果与真故障必须分两态。
 *
 * ## 这一族缺陷的形状（用户报 → 根因）
 *
 * 用户报「用的时候总是糊涂」的一个来源：把**真故障**当**业务限制**报出去，模型于是
 * 去绕一个绕不过去的东西。`screen_windows` 那条链在 A-1088 已修（`desktop.ts` 三态 /
 * `controller.listWindows` 不再吞异常 / 工具层措辞分开）；但**紧挨着的 `screen_focus` 漏了**：
 *
 *   `controller.focusWindow` 旧实现 `catch (e) { return { focused:false, detail: … } }`
 *   把两种完全不同的情形压成**同一个形状**（都只有 `focused:false`，没有可区分的标记）：
 *     · 「未找到标题匹配的窗口」「没抢到前台」—— 后端**正常返回**，业务态，有替代路径；
 *     · 「宿主崩溃 / 启动超时 / 从未启动」—— 后端**抛错**，真故障，怎么绕都不会成功。
 *   `screen_focus` 工具只能看 `focused` ⇒ 对**真故障**也回一句「[未获得前台] …」并附
 *   「可直接 screen_capture 传 window 试试区域截图」⇒ 模型把它当成**焦点限制**去绕
 *   （换标题、反复重试、试区域截图），**永远不会去报告那个已经死掉的宿主**。
 *
 * ## 三层判据（每层测的都是**它自己那一层的输出**）
 *
 *   A 组 行为级（controller）：抛错必须 reject；业务态必须原样透传；不支持必须回业务态。
 *   B 组 端到端（工具层措辞）：真故障 → `[错误] …`；业务态 → `[未获得前台] …`。
 *        —— 这一组才是「用户看到什么」，也是唯一能发现"controller 修了但工具层又吞回去"的地方。
 *   C 组 源码契约：防下一个人顺手把 `catch` 写回去（行为级测得到，但源码级更快定位）。
 *
 * ⚠️ 中文句子一律用「」，不许夹 ASCII 双引号 —— 否则会把整份 spec 打成 0 用例。
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { ScreenController } from "../../core-ts/src/screen/controller.js";
import type {
  DisplayInfo,
  ScreenAction,
  ScreenActionResult,
  ScreenBackend,
  ScreenCaptureResult,
} from "../../core-ts/src/screen/types.js";
import { ToolRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools, setScreenController } from "../../core-ts/src/tools/builtin.js";

/* ───────────────────────── 三个假后端（分别代表三种真实情形） ───────────────────────── */

/** 宿主已死：枚举与聚焦都抛错 —— 真故障 */
class FaultBackend implements ScreenBackend {
  readonly id = "desktop" as const;
  readonly actions = new Set<ScreenAction["kind"]>(["click"]);
  async listTargets(): Promise<DisplayInfo[]> { return [await this.displayInfo()]; }
  async displayInfo(): Promise<DisplayInfo> {
    return { backend: "desktop", target: "primary", width: 1920, height: 1080, label: "fake" };
  }
  async capture(): Promise<ScreenCaptureResult> { return { ok: false, error: "宿主已退出" }; }
  async perform(): Promise<ScreenActionResult> { return { ok: false, error: "宿主已退出" }; }
  async listWindows(): Promise<never> {
    throw new Error("PowerShell 宿主已退出（code=1）：Add-Type 编译失败");
  }
  async focusWindow(): Promise<never> {
    throw new Error("PowerShell 宿主已退出（code=1）：Add-Type 编译失败");
  }
}

/** 枚举成功但没有窗口 / 窗口都在后台 —— 业务态（后端**正常返回**，不抛） */
class NoWindowBackend implements ScreenBackend {
  readonly id = "desktop" as const;
  readonly actions = new Set<ScreenAction["kind"]>(["click"]);
  async listTargets(): Promise<DisplayInfo[]> { return [await this.displayInfo()]; }
  async displayInfo(): Promise<DisplayInfo> {
    return { backend: "desktop", target: "primary", width: 1920, height: 1080, label: "fake" };
  }
  async capture(): Promise<ScreenCaptureResult> { return { ok: true }; }
  async perform(): Promise<ScreenActionResult> { return { ok: true }; }
  async listWindows() { return []; }
  async focusWindow() {
    return { focused: false, detail: "未找到标题包含「记事本」的窗口" };
  }
}

/** 不具备窗口概念的后端（如 android）：两个可选方法都没实现 */
class NoWindowAbilityBackend implements ScreenBackend {
  readonly id = "desktop" as const;
  readonly actions = new Set<ScreenAction["kind"]>(["click"]);
  async listTargets(): Promise<DisplayInfo[]> { return [await this.displayInfo()]; }
  async displayInfo(): Promise<DisplayInfo> {
    return { backend: "desktop", target: "primary", width: 1080, height: 1920, label: "fake" };
  }
  async capture(): Promise<ScreenCaptureResult> { return { ok: true }; }
  async perform(): Promise<ScreenActionResult> { return { ok: true }; }
}

afterEach(() => {
  // 全局单例必须复位，否则后续用例（含同文件的 B 组）会拿到上一条留下的控制器
  setScreenController(null);
});

/* ───────────────────────── A 组：controller 行为（真故障必须上抛） ───────────────────────── */

describe("A-1088 续 A 组 — controller.focusWindow 的两态：真故障上抛，业务态透传", () => {
  it("A1 后端抛错（宿主崩溃/超时/未启动）⇒ **必须 reject**，不许 resolve 成 focused:false", async () => {
    const ctl = new ScreenController();
    ctl.register(new FaultBackend());
    await expect(ctl.focusWindow("desktop", "记事本")).rejects.toThrow(/宿主已退出/);
  });

  it("A2 后端正常返回 focused:false（未找到 / 没抢到前台）⇒ 原样透传，**不许**被当成故障上抛", async () => {
    const ctl = new ScreenController();
    ctl.register(new NoWindowBackend());
    const r = await ctl.focusWindow("desktop", "记事本");
    expect(r.focused).toBe(false);
    expect(r.detail).toMatch(/未找到标题包含/);
  });

  it("A3 后端不支持窗口聚焦 ⇒ 回**业务态**（该后端没有窗口概念），不是故障", async () => {
    const ctl = new ScreenController();
    ctl.register(new NoWindowAbilityBackend());
    const r = await ctl.focusWindow("desktop", "记事本");
    expect(r.focused).toBe(false);
    expect(r.detail).toMatch(/不支持窗口聚焦/);
  });

  it("A4（A-1088 正身）listWindows 抛错必须上抛 —— 不许吞成空数组", async () => {
    const ctl = new ScreenController();
    ctl.register(new FaultBackend());
    await expect(ctl.listWindows("desktop")).rejects.toThrow(/宿主已退出/);
  });

  it("A5 listWindows 正常返回空 ⇒ 空数组（确实没有窗口，不是故障）", async () => {
    const ctl = new ScreenController();
    ctl.register(new NoWindowBackend());
    expect(await ctl.listWindows("desktop")).toEqual([]);
  });
});

/* ───────────────────────── B 组：工具层措辞（用户真正看到的那一层） ───────────────────────── */

describe("A-1088 续 B 组 — 工具层措辞：真故障 [错误]，业务态才说「未获得前台」", () => {
  const runFocus = async (backend: ScreenBackend, title = "记事本"): Promise<string> => {
    const ctl = new ScreenController();
    ctl.register(backend);
    setScreenController(ctl);
    const reg = new ToolRegistry();
    registerBuiltinTools(reg);
    return await reg.callTool("screen_focus", { backend: "desktop", title });
  };

  const runWindows = async (backend: ScreenBackend): Promise<string> => {
    const ctl = new ScreenController();
    ctl.register(backend);
    setScreenController(ctl);
    const reg = new ToolRegistry();
    registerBuiltinTools(reg);
    return await reg.callTool("screen_windows", { backend: "desktop" });
  };

  it("B1 宿主已死 ⇒ 回 [错误]，且**不许**出现「未获得前台」与「试试区域截图」（那是焦点限制的说法）", async () => {
    const out = await runFocus(new FaultBackend());
    expect(out).toMatch(/\[错误\]/);
    expect(out).toMatch(/宿主已退出/);
    expect(out).not.toMatch(/未获得前台/);
    expect(out).not.toMatch(/试试区域截图/);
  });

  it("B2 未找到窗口 ⇒ 回 [未获得前台] 并给替代路径（业务态才配这个措辞）", async () => {
    const out = await runFocus(new NoWindowBackend());
    expect(out).toMatch(/\[未获得前台\]/);
    expect(out).toMatch(/未找到标题包含/);
    expect(out).not.toMatch(/\[错误\]/);
  });

  it("B3（A-1088 正身）screen_windows：真故障 ⇒ [错误]；确实没窗口 ⇒ [提示] 并明说这不是故障", async () => {
    const fail = await runWindows(new FaultBackend());
    expect(fail).toMatch(/\[错误\]/);
    expect(fail).not.toMatch(/这不是故障/);

    const empty = await runWindows(new NoWindowBackend());
    expect(empty).toMatch(/\[提示\]/);
    expect(empty).toMatch(/这不是故障/);
    expect(empty).not.toMatch(/\[错误\]/);
  });
});

/* ───────────────────────── C 组：源码契约（防下一个人顺手把 catch 写回去） ───────────────────────── */

describe("A-1088 续 C 组 — 源码契约：这两条路径都**不许**吞异常", () => {
  /** 剥注释后再断言（注释里会故意写"旧实现 catch …"，不剥就是假红灯） */
  const stripComments = (s: string): string => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*#.*$/gm, "");

  const readSrc = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

  /* ⚠️ 取方法体必须用「下一个同类兄弟」当右界（否则会吃进邻居，形成假绿）。
     controller.ts 里三个方法的顺序是 listWindows → focusWindow → captureWindow。 */
  const ctlSrc = stripComments(readSrc("../../core-ts/src/screen/controller.ts"));
  const sliceBetween = (src: string, from: string, to: string): string => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a + from.length);
    expect(a, `锚点未命中：${from}`).toBeGreaterThan(-1);
    expect(b, `右界未命中：${to}`).toBeGreaterThan(a);
    return src.slice(a, b);
  };

  it("C1 controller.focusWindow 方法体内**不得出现 catch**（真故障必须原样上抛）", () => {
    const body = sliceBetween(ctlSrc, "async focusWindow(", "async captureWindow(");
    expect(body).not.toMatch(/\bcatch\b/);
    expect(body).toMatch(/return await b\.focusWindow\(title\)/);
  });

  it("C2 controller.listWindows 方法体内**不得出现 catch**（A-1088 正身，一并锁住）", () => {
    const body = sliceBetween(ctlSrc, "async listWindows(", "async focusWindow(");
    expect(body).not.toMatch(/\bcatch\b/);
    expect(body).toMatch(/return await b\.listWindows\(\)/);
  });

  it("C3 screenFocus 工具对抛错回 [错误]（不许把它也说成「未获得前台」）", () => {
    const src = stripComments(readSrc("../../core-ts/src/tools/builtin.ts"));
    const body = sliceBetween(src, "async function screenFocus(", 'name: "screen_focus"');
    expect(body).toMatch(/catch \(e\)/);
    expect(body).toMatch(/\[错误\]/);
    expect(body).toMatch(/\[未获得前台\]/);
  });

  it("C4 desktop.listWindows 的三态判据在位（diag 缺失 / candidates>0 / candidates===0）", () => {
    const src = stripComments(readSrc("../../core-ts/src/screen/backends/desktop.ts"));
    const body = sliceBetween(src, "async listWindows(", "async focusWindow(");
    expect(body).toMatch(/协议不匹配/);
    expect(body).toMatch(/candidates > 0/);
    expect(body).toMatch(/return \[\];/);
  });
});
