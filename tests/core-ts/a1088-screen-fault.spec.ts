

























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
  
  setScreenController(null);
});



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



describe("A-1088 续 C 组 — 源码契约：这两条路径都**不许**吞异常", () => {
  
  const stripComments = (s: string): string => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*#.*$/gm, "");

  const readSrc = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

  

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
